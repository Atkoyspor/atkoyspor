// Atköy Spor Okulu Yönetim Sistemi
class SportsManagementApp {
    constructor() {
        this.students = [];
        this.trainings = [];
        this.currentUser = null;
        this.currentStudentId = null;
        this.sportsChart = null;
        this.paymentsChart = null;
        this.weeklyTrainingsChart = null;
        this.currentDate = new Date();
        this.currentChartType = 'pie'; // Track current chart type
        this.trackingYear = new Date().getFullYear(); // Ödeme takip yılı
        this.initializeApp();
        this.sportColorMap = {}; // YENİ: Spor renk haritasını burada saklayacağız
        this._equipSearchDebounce = null; // debounce timer for equipment student search
        this._studentSearchDebounce = null; // debounce timer for students search
        this._studentSearchQuery = '';
        this._equipmentGlobalSearchDebounce = null;
        this._equipmentGlobalSearchQuery = '';
        this._singleClickTimer = null; // timer to distinguish single vs double click on trainings
        this._lastClickedTrainingId = null;
        
        // PERFORMANS: Cache sistemi
        this._cache = new Map();
        this._cacheTimeout = 5 * 60 * 1000; // 5 dakika cache
        this._sportTextCache = new Map(); // getSportText için cache
    }

    // Update existing monthly fees by payment_period (do not use payment_date)
    // Only updates UNPAID records for the current period for ACTIVE students
    async updateMonthlyFeesForCurrentPeriod() {
        try {
            if (!this.currentUser) {
                alert('Lütfen önce giriş yapınız.');
                return;
            }

            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth() + 1;
            const period = `${year}-${String(month).padStart(2, '0')}`;

            // Load branches and build name map
            const branchesRes = await supabaseService.getSportBranches();
            const branchList = branchesRes.success ? (branchesRes.data || []) : [];
            const branchByName = {};
            branchList.forEach(b => { if (b && b.name) branchByName[(b.name || '').toString().toLowerCase()] = b; });

            // Active students
            const { data: students, error: stuErr } = await supabase
                .from('students')
                .select('id, status, sport, discount_rate, name, surname, full_name, is_deleted, deleted_at')
                .in('status', ['active', 'Active', 'ACTIVE'])
                .or('is_deleted.is.false,deleted_at.is.null');
            if (stuErr) throw stuErr;

            let updated = 0;
            let skippedPaid = 0;
            let missing = 0;

            for (const s of (students || [])) {
                // Find existing record by student_id + payment_period
                const { data: pay, error: findErr } = await supabase
                    .from('payments')
                    .select('id, is_paid')
                    .eq('student_id', s.id)
                    .eq('payment_period', period)
                    .maybeSingle();
                if (findErr) continue;
                if (!pay) { missing++; continue; }
                if (pay.is_paid) { skippedPaid++; continue; }

                const sportNameRaw = this.getSportText ? this.getSportText(s.sport) : (s.sport || '');
                const sportName = (sportNameRaw || '').toString().trim();
                const br = branchByName[(sportName || '').toLowerCase()] || {};
                const baseFee = (typeof br.monthly_fee === 'number') ? br.monthly_fee
                               : (typeof br.fee === 'number') ? br.fee : 1000;
                const discount = (typeof s.discount_rate === 'number') ? s.discount_rate : 0;
                const amount = Number((baseFee * (1 - discount / 100)).toFixed(2));

                const { error: updErr } = await supabase
                    .from('payments')
                    .update({ amount, notes: `${sportName || 'Spor'} branşı için aylık aidat - ${period}` })
                    .eq('id', pay.id);
                if (!updErr) updated++;
            }

            alert(`Güncelleme tamamlandı. Güncellenen: ${updated}, Ödenmiş (dokunulmadı): ${skippedPaid}, Kayıt bulunamadı: ${missing}`);
        } catch (e) {
            console.error('updateMonthlyFeesForCurrentPeriod error:', e);
            alert('Aidat güncellenemedi: ' + this.formatErrorMessage(e));
        }
    }

    // Ayın ilk günü otomatik aidat tetikleyici (istemci tarafı, login sonrası)
    async maybeAutoGenerateMonthlyFees() {
        try {
            const now = new Date();
            if (now.getDate() !== 1) return; // Sadece ayın ilk günü

            const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            const lsKey = `fees_generated_${period}`;
            if (localStorage.getItem(lsKey) === '1') return; // Bu ay zaten tetiklenmiş

            // Basit yetki kontrolü ve kullanıcı onayı
            const userInfo = JSON.parse(localStorage.getItem('currentUser') || '{}');
            const isAdminLike = (userInfo.role && String(userInfo.role).toLowerCase() === 'admin') ||
                                (userInfo.email && /admin|atkoy|yonetici/i.test(userInfo.email));
            const proceed = confirm(`Bugün ayın ilk günü. ${period} için aktif üyelere aidat yansıtılsın mı?` + (isAdminLike ? '' : '\n(Not: Yönetici doğrulanamadı.)'));
            if (!proceed) return;

            await this.generateMonthlyFeesOnce();
            // Başarılı kabul edip aynı ay içinde tekrar sormamak için işaretle
            localStorage.setItem(lsKey, '1');
        } catch (e) {
            console.error('maybeAutoGenerateMonthlyFees error:', e);
        }
    }

    // ============ MANUAL MONTHLY FEE GENERATION ============
    // Creates current month's unpaid payment records for all ACTIVE students.
    // Prevents duplicates by checking payments.payment_period (YYYY-MM) per student.
    async generateMonthlyFeesOnce() {
        try {
            // Auth check (simple): require logged-in user
            if (!this.currentUser) {
                alert('Lütfen önce giriş yapınız.');
                return;
            }

            // Optional: basic admin check (email or role)
            const userInfo = JSON.parse(localStorage.getItem('currentUser') || '{}');
            const isAdminLike = (userInfo.role && String(userInfo.role).toLowerCase() === 'admin') ||
                                (userInfo.email && /admin|atkoy|yonetici/i.test(userInfo.email));
            if (!isAdminLike) {
                const proceed = confirm('Yönetici yetkisi doğrulanamadı. Yine de devam edilsin mi?');
                if (!proceed) return;
            }

            // Compute current period
            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth() + 1; // 1-12
            const period = `${year}-${String(month).padStart(2, '0')}`;

            // Load active students (minimal columns) - aligned with schema
            // Be tolerant: include common case variants of 'active' and exclude deleted
            const { data: students, error: stuErr } = await supabase
                .from('students')
                .select('id, status, sport, discount_rate, name, surname, full_name, is_deleted, deleted_at')
                .in('status', ['active', 'Active', 'ACTIVE'])
                .or('is_deleted.is.false,deleted_at.is.null');
            if (stuErr) throw stuErr;

            if (!students || students.length === 0) {
                alert('Aktif öğrenci bulunamadı.');
                return;
            }

            // Load sport branches to determine fees
            const branchesRes = await supabaseService.getSportBranches();
            const branchList = branchesRes.success ? (branchesRes.data || []) : [];
            // Map by lowercase name for robust matching
            const branchByName = {};
            branchList.forEach(b => { if (b && b.name) branchByName[(b.name || '').toString().toLowerCase()] = b; });

            let toCreate = [];
            let skipped = 0;

            // For each student, upsert by payment_period: update if unpaid exists, else insert
            let updated = 0;
            for (const s of students) {
                try {
                    const { data: existing, error: exErr } = await supabase
                        .from('payments')
                        .select('id, is_paid')
                        .eq('student_id', s.id)
                        .eq('payment_period', period)
                        .limit(1);
                    if (exErr) throw exErr;
                    if (existing && existing.length > 0) {
                        // If already paid, skip; if unpaid, update amount/notes
                        const row = existing[0];
                        if (row.is_paid) { skipped++; continue; }

                        const sportNameRaw = this.getSportText ? this.getSportText(s.sport) : (s.sport || '');
                        const sportName = (sportNameRaw || '').toString().trim();
                        const br = branchByName[(sportName || '').toLowerCase()] || {};
                        const baseFee = (typeof br.monthly_fee === 'number') ? br.monthly_fee
                                       : (typeof br.fee === 'number') ? br.fee : 1000;
                        const discount = (typeof s.discount_rate === 'number') ? s.discount_rate : 0;
                        const amount = Number((baseFee * (1 - discount / 100)).toFixed(2));

                        const { error: updErr } = await supabase
                            .from('payments')
                            .update({ amount, notes: `${sportName || 'Spor'} branşı için aylık aidat - ${period}` })
                            .eq('id', row.id);
                        if (!updErr) updated++;
                        continue;
                    }

                    const sportNameRaw = this.getSportText ? this.getSportText(s.sport) : (s.sport || '');
                    const sportName = (sportNameRaw || '').toString().trim();
                    const br = branchByName[(sportName || '').toLowerCase()] || {};
                    const baseFee = (typeof br.monthly_fee === 'number') ? br.monthly_fee
                                   : (typeof br.fee === 'number') ? br.fee : 1000;
                    const discount = (typeof s.discount_rate === 'number') ? s.discount_rate : 0;
                    const amount = Number((baseFee * (1 - discount / 100)).toFixed(2));

                    toCreate.push({
                        student_id: s.id,
                        amount: amount,
                        payment_date: null,
                        payment_method: null,
                        period_month: month,
                        period_year: year,
                        payment_period: period,
                        notes: `${(br && br.name) ? br.name : 'Spor'} branşı için aylık aidat - ${period}`,
                        is_paid: false
                    });
                } catch (innerErr) {
                    console.error('Öğrenci için aidat oluşturulamadı:', s?.id, innerErr);
                }
            }

            if (toCreate.length === 0) {
                alert(`Bu dönem için yeni aidat kaydı yok. (Atlanan: ${skipped})`);
                return;
            }

            // Insert in batches to avoid payload issues
            const batchSize = 500;
            let inserted = 0;
            for (let i = 0; i < toCreate.length; i += batchSize) {
                const batch = toCreate.slice(i, i + batchSize);
                const { error: insErr } = await supabase.from('payments').insert(batch);
                if (insErr) throw insErr;
                inserted += batch.length;
            }

            try {
                await supabaseService.addActivityLog(
                    'generate_monthly_fees', 'system', null,
                    `Manuel: ${period} için ${inserted} aidat kaydı oluşturuldu (skip: ${skipped})`,
                    userInfo
                );
            } catch (_) {}

            alert(`Başarılı: ${period} için ${inserted} yeni, ${updated} güncellendi. (Ödenmiş/atlanan: ${skipped})`);
        } catch (error) {
            console.error('Aylık aidat oluşturma hatası:', error);
            alert('Aylık aidat oluşturulurken hata oluştu: ' + this.formatErrorMessage(error));
        }
    }

    // Diagnostic helper to check why a specific student may be skipped
    async checkStudentFeesByName(fullNameOrTc) {
        try {
            const now = new Date();
            const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            const q = (fullNameOrTc || '').toString().trim();
            if (!q) return { ok: false, error: 'Boş arama ifadesi' };

            // Heuristic: if 11-digit numeric, search by TCNO; otherwise search by full_name ILIKE
            let student = null;
            const looksLikeTcno = /^\d{11}$/.test(q);
            if (looksLikeTcno) {
                const r = await supabase.from('students').select('*').eq('tcno', q).maybeSingle();
                if (!r.error && r.data) student = r.data;
            } else {
                const r = await supabase.from('students').select('*').ilike('full_name', `%${q}%`).limit(1);
                if (!r.error && Array.isArray(r.data) && r.data.length > 0) student = r.data[0];
            }
            if (!student) return { ok: false, error: 'Öğrenci bulunamadı' };

            // Check payment existence for current period
            const pay = await supabase.from('payments')
                .select('id, amount, is_paid, payment_period')
                .eq('student_id', student.id)
                .eq('payment_period', period)
                .limit(1)
                .single();

            // Branch matching details
            const bres = await supabaseService.getSportBranches();
            const branches = bres.success ? (bres.data || []) : [];
            const m = {};
            branches.forEach(b => { if (b && b.name) m[b.name.toLowerCase()] = b; });
            const sportName = (this.getSportText ? this.getSportText(student.sport) : (student.sport || '')).toString().trim();
            const br = m[sportName.toLowerCase()];

            return {
                ok: true,
                student: {
                    id: student.id,
                    name: student.name,
                    surname: student.surname,
                    full_name: student.full_name,
                    tcno: student.tcno,
                    status: student.status,
                    is_deleted: student.is_deleted,
                    deleted_at: student.deleted_at,
                    sport: student.sport,
                    discount_rate: student.discount_rate
                },
                current_period: period,
                existing_payment: pay && pay.data ? pay.data : null,
                branch_match: br ? { name: br.name, monthly_fee: br.monthly_fee ?? br.fee ?? 1000 } : null
            };
        } catch (e) {
            return { ok: false, error: e?.message || String(e) };
        }
    }

    // ===== GÜVENLİK FONKSİYONLARI =====
    
    // XSS koruması için HTML sanitization
    sanitizeHtml(input) {
        if (typeof input !== 'string') return input;
        
        const div = document.createElement('div');
        div.textContent = input;
        return div.innerHTML;
    }
    
    // Utility function to safely convert sport value to string
    getSportText(sportValue) {
        if (!sportValue) return 'Belirtilmemiş';
        
        // PERFORMANS: Cache kontrolü - aynı değerler için tekrar işlem yapma
        const cacheKey = typeof sportValue === 'object' ? JSON.stringify(sportValue) : String(sportValue);
        if (this._sportTextCache.has(cacheKey)) {
            return this._sportTextCache.get(cacheKey);
        }
        
        let result;
        
        if (typeof sportValue === 'object' && sportValue !== null) {
            // GÜVENLİK: Obje ise, içindeki değerleri güvenli şekilde kontrol et
            const possibleValues = [
                sportValue.name, 
                sportValue.title, 
                sportValue.value,
                sportValue.label,
                sportValue.text
            ].filter(v => v && typeof v === 'string' && v.length <= 100); // Max length kontrolü
            
            if (possibleValues.length > 0) {
                result = this.sanitizeHtml(possibleValues[0]); // XSS koruması
            } else {
                // Hiçbir string property bulunamazsa, ilk değeri al
                const values = Object.values(sportValue)
                    .filter(v => v && typeof v === 'string' && v.length <= 100);
                result = values.length > 0 ? this.sanitizeHtml(values[0]) : 'Belirtilmemiş';
            }
        } else {
            // GÜVENLİK: String değerleri de sanitize et
            const stringValue = String(sportValue);
            result = stringValue.length <= 100 ? this.sanitizeHtml(stringValue) : 'Belirtilmemiş';
        }
        
        // PERFORMANS: Sonucu cache'le (max 1000 entry)
        if (this._sportTextCache.size >= 1000) {
            this._sportTextCache.clear(); // Memory leak önlemi
        }
        this._sportTextCache.set(cacheKey, result);
        
        return result;
    }

    // Utility function to create safe DOM elements
    createSafeElement(tagName, attributes = {}, children = []) {
        const element = document.createElement(tagName);
        
        // Attributes'ları güvenli şekilde set et
        for (const [key, value] of Object.entries(attributes)) {
            if (typeof value === 'string') {
                element.setAttribute(key, this.sanitizeHtml(value));
            }
        }
        
        // Children'ları ekle
        children.forEach(child => {
            if (child) element.appendChild(child);
        });
        
        return element;
    }
    
    // Input validation
    validateInput(input, type = 'text') {
        if (!input || typeof input !== 'string') return false;
        
        switch (type) {
            case 'email':
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
            case 'tcno':
                return /^\d{11}$/.test(input) && this.validateTCKimlikNo(input);
            case 'phone':
                return /^[\d\s\-\+\(\)]{10,}$/.test(input);
            case 'text':
                return input.length > 0 && input.length < 1000;
            default:
                return true;
        }
    }

    // ===== PERFORMANS FONKSİYONLARI =====
    
    // Cache yönetimi
    getCachedData(key) {
        const cached = this._cache.get(key);
        if (!cached) return null;
        
        const now = Date.now();
        if (now - cached.timestamp > this._cacheTimeout) {
            this._cache.delete(key);
            return null;
        }
        
        return cached.data;
    }
    
    setCachedData(key, data) {
        this._cache.set(key, {
            data: data,
            timestamp: Date.now()
        });
    }
    
    clearCache(pattern = null) {
        if (pattern) {
            // Pattern'e göre cache temizle
            for (const key of this._cache.keys()) {
                if (key.includes(pattern)) {
                    this._cache.delete(key);
                }
            }
            // Sport text cache'ini de temizle (öğrenci verileri değiştiğinde)
            if (pattern.includes('student')) {
                this._sportTextCache.clear();
            }
        } else {
            // Tüm cache'i temizle
            this._cache.clear();
            this._sportTextCache.clear();
        }
    }

    // Debounced function helper
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    // dd.MM.yyyy HH:mm:ss
    formatDateTimeTR(date) {
        try {
            const d = new Date(date);
            const dd = String(d.getDate()).padStart(2, '0');
            const MM = String(d.getMonth() + 1).padStart(2, '0');
            const yyyy = d.getFullYear();
            const HH = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            const ss = String(d.getSeconds()).padStart(2, '0');
            return `${dd}.${MM}.${yyyy} ${HH}:${mm}:${ss}`;
        } catch { return ''; }
    }

    // TRY currency formatter
    formatCurrencyTRY(amount) {
        const n = Number(amount || 0);
        if (!isFinite(n) || n === 0) return '0 TL';
        try {
            return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 0 }).format(n);
        } catch {
            return `${n} TL`;
        }
    }

    // Human-friendly title for activity
    getActivityTitle(activity) {
        if (!activity) return 'Sistem Aktivitesi';
        
        // Fix legacy titles from description field
        if (activity.description && activity.description.includes('Ödeme Ödeme Kaydı')) {
            return 'Ödeme Alındı';
        }
        const a = (activity.action || '').toLowerCase();
        const e = (activity.entity_type || '').toLowerCase();
        if (e.includes('student')) {
            if (a.includes('create')) return 'Öğrenci Eklendi';
            if (a.includes('update')) return 'Öğrenci Güncellendi';
            if (a.includes('delete')) return 'Öğrenci Silindi';
        }
        if (e.includes('payment')) {
            if (a.includes('payment') || a.includes('pay') || a.includes('receive')) return 'Ödeme Alındı';
            if (a.includes('create') || a.includes('add')) return 'Ödeme Eklendi';
            if (a.includes('update')) return 'Ödeme Güncellendi';
            if (a.includes('delete') || a.includes('remove')) return 'Ödeme Silindi';
            if (a.includes('unpay') || a.includes('revert')) return 'Ödeme Geri Alındı';
        }
        if (e.includes('equipment')) {
            if (a.includes('assign')) return 'Ekipman Atandı';
            if (a.includes('create')) return 'Ekipman Eklendi';
            if (a.includes('update')) return 'Ekipman Güncellendi';
            if (a.includes('delete')) return 'Ekipman Silindi';
        }
        if (e.includes('training')) {
            if (a.includes('create')) return 'Antrenman Eklendi';
            if (a.includes('update')) return 'Antrenman Güncellendi';
            if (a.includes('delete')) return 'Antrenman Silindi';
        }
        // Fallback: Capitalize action + entity
        const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
        return `${cap(activity.entity_type || 'Kayıt')} ${cap(activity.action || 'İşlem')}`.trim();
    }

    // Takvimdeki bir antrenman kartına tıklanınca detayları göster
    async showTrainingDetails(trainingId) {
        if (!trainingId) return;
        try {
            const result = await supabaseService.getTraining(trainingId);
            if (!result.success || !result.data) {
                alert('Antrenman bilgileri yüklenemedi');
                return;
            }
            this.currentEditingTrainingId = result.data.id;
            await this.showTrainingEditModal(result.data);
        } catch (error) {
            console.error('Error showing training details:', error);
            alert('Antrenman detayları açılamadı. Lütfen tekrar deneyin.');
        }
    }

    // Tek tık: kısa gecikme ile düzenleme ekranını aç
    handleTrainingClick(trainingId, event) {
        if (event) event.stopPropagation();
        clearTimeout(this._singleClickTimer);
        this._lastClickedTrainingId = trainingId;
        this._singleClickTimer = setTimeout(() => {
            if (this._lastClickedTrainingId) {
                this.showTrainingDetails(this._lastClickedTrainingId);
            }
            this._lastClickedTrainingId = null;
        }, 250);
    }

    // Çift tık: tek tıkı iptal et ve katılım ekranını aç
    handleTrainingDblClick(trainingId, event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        clearTimeout(this._singleClickTimer);
        this._lastClickedTrainingId = null;
        this.showAttendanceModal(trainingId);
    }

    async showAllActivities() {
        try {
            const activities = await this.getMeaningfulActivities(0); // 0 = no limit

            const modal = document.createElement('div');
            modal.id = 'activitiesModal';
            modal.className = 'modal';
            modal.style.display = 'flex';
            modal.style.position = 'fixed';
            modal.style.inset = '0';
            modal.style.background = 'rgba(0,0,0,0.5)';
            modal.style.zIndex = '1000';
            modal.style.alignItems = 'center';
            modal.style.justifyContent = 'center';

            const listHtml = activities.length > 0 ? activities.map(({ activity: a, label }) => {
                const date = new Date(a.created_at);
                const timeAgo = this.getTimeAgo(date);
                const actorRaw = a.actor_name || a.user_name || (a.user_email ? a.user_email.split('@')[0] : '') || 'Sistem';
                const actor = this.escapeHtml(actorRaw);
                const desc = this.escapeHtml(label);
                const iconName = this.getActionIcon(`${a.entity_type || ''} ${a.action || ''}`);
                return `
                    <div style="display:flex; align-items:flex-start; gap:12px; padding:12px; border-bottom:1px solid #e5e7eb;">
                        <div style="width:34px; height:34px; border-radius:50%; background:#3b82f6; color:#fff; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                            <i class="fas ${iconName}" style="font-size:14px;"></i>
                        </div>
                        <div style="flex:1;">
                            <div style="font-weight:600; color:#111827;">${desc}</div>
                            <div style="font-size:12px; color:#6b7280; margin-top:4px;">
                                <i class="fas fa-user" style="margin-right:6px;"></i>${actor}
                                <span style="margin: 0 6px; color: #9ca3af;">•</span>
                                <i class="fas fa-clock" style="margin-right:6px;"></i>${timeAgo}
                            </div>
                        </div>
                    </div>
                `;
            }).join('') : `
                <div style="text-align:center; padding:30px; color:#6b7280;">
                    <i class="fas fa-history" style="font-size:36px; margin-bottom:12px; opacity:.6;"></i>
                    <div>Aktivite kaydı bulunamadı</div>
                </div>
            `;

            modal.innerHTML = `
                <div class="modal-content" style="width: min(800px, 92vw); max-height: 80vh; overflow: auto; background: #fff; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,.15);">
                    <div class="modal-header" style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid #e5e7eb; background:#DC2626; color:#fff; border-radius:12px 12px 0 0;">
                        <h3 style="margin:0; font-size:18px; font-weight:700;">Tüm Aktiviteler</h3>
                        <button id="closeActivitiesModal" title="Aktiviteler penceresini kapat" aria-label="Kapat" style="background:none; border:none; color:#fff; font-size:22px; cursor:pointer;">&times;</button>
                    </div>
                    <div style="padding: 8px 0;">
                        ${listHtml}
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            const close = () => {
                modal.remove();
            };
            modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
            modal.querySelector('#closeActivitiesModal').addEventListener('click', close);

        } catch (error) {
            console.error('Error showing all activities:', error);
            alert('Aktiviteler görüntülenemedi.');
        }
    }

    // Fetch logs and return simplified, meaningful activities. limit=0 means no limit
    async getMeaningfulActivities(limit = 5) {
        const result = await supabaseService.getActivityLogs();
        const raw = (result.success && Array.isArray(result.data))
            ? [...result.data].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            : [];

        const items = raw
            .filter(a => {
                const act = (a.action || '').toLowerCase();
                const desc = (a.description || '').toLowerCase();
                return !act.includes('login') && !act.includes('logout') && !desc.includes('giriş') && !desc.includes('çıkış');
            })
            .map(a => ({ activity: a, label: this.simplifyActivityLabel(a) }))
            .filter(x => !!x.label);

        if (limit && limit > 0) return items.slice(0, limit);
        return items;
    }

    // Basit XSS koruması: metinleri HTML'e enjekte etmeden önce kaçışla
    escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async markPaymentAsUnpaid(paymentId) {
        try {
            // Ödemeyi geri al
            const updatePaymentResult = await supabaseService.updatePayment(paymentId, {
                is_paid: false,
                payment_date: null
            });

            if (updatePaymentResult.success) {
                // Öğrencinin payment_status'unu da Bekliyor yapmaya çalış
                const paymentResult = await supabaseService.getPayment(paymentId);
                if (paymentResult.success && paymentResult.data && paymentResult.data.student_id) {
                    await supabaseService.updateStudent(paymentResult.data.student_id, {
                        payment_status: 'pending'
                    });
                }

                // Activity log: payment reverted
                try {
                    await supabaseService.addActivityLog(
                        'unpay',
                        'payment',
                        paymentId,
                        `Ödeme geri alındı`
                    );
                } catch (logErr) { console.warn('Activity log (unpay) failed:', logErr); }

                // Ekranı yenile
                await this.loadPaymentsScreen();
                if (this.currentScreen === 'studentsScreen') {
                    await this.loadStudentsScreen();
                }

                alert('Ödeme geri alındı.');
            } else {
                alert('Ödeme geri alınırken hata oluştu: ' + updatePaymentResult.error);
            }
        } catch (error) {
            console.error('Error marking payment as unpaid:', error);
            alert('Ödeme geri alınamadı: ' + this.formatErrorMessage(error));
        }
    }

    // ==== IMAGE HELPERS: client-side resize/compress and thumbnail generation ====
    async _readFileAsImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = reader.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    _drawContain(img, maxSize = 1280) {
        const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        return canvas;
    }

    _drawCover(img, size = 256) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const srcRatio = img.width / img.height;
        const dstRatio = 1; // square
        let sx, sy, sw, sh;
        if (srcRatio > dstRatio) {
            sh = img.height;
            sw = sh * dstRatio;
            sx = (img.width - sw) / 2;
            sy = 0;
        } else {
            sw = img.width;
            sh = sw / dstRatio;
            sx = 0;
            sy = (img.height - sh) / 2;
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
        return canvas;
    }

    async _compressToDataUrl(file, maxDim = 1280, quality = 0.75, type = 'image/webp') {
        const img = await this._readFileAsImage(file);
        const canvas = this._drawContain(img, maxDim);
        return canvas.toDataURL(type, quality);
    }

    async _createThumbDataUrl(fileOrImage, size = 256, quality = 0.7, type = 'image/webp') {
        const img = fileOrImage instanceof Image ? fileOrImage : await this._readFileAsImage(fileOrImage);
        const canvas = this._drawCover(img, size);
        return canvas.toDataURL(type, quality);
    }

    async loadReturnedEquipmentTab() {
        const container = document.getElementById('mainEquipmentTabContent');
        if (!container) return;

        try {
            // Get all equipment assignments
            const result = await supabaseService.getAllEquipmentAssignments();
            const returned = (result.success && Array.isArray(result.data))
                ? result.data.filter(a => (a.status || '') === 'returned')
                : [];

            if (returned.length === 0) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 40px; color: #6b7280;">
                        <i class="fas fa-undo" style="font-size: 48px; margin-bottom: 16px;"></i>
                        <p>Henüz iade edilmiş ekipman bulunmuyor.</p>
                    </div>
                `;
                return;
            }

            container.innerHTML = `
                <div style="background: white; border-radius: 12px; padding: 20px;">
                    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
                        <i class="fas fa-undo" style="color: #DC2626; font-size: 18px;"></i>
                        <h3 style="color: #DC2626; margin: 0; font-size: 18px; font-weight: 600;">İADE EDİLMİŞ EKİPMANLAR</h3>
                    </div>
                    ${returned.map(assignment => {
                        const firstLetter = (assignment.equipment_name?.charAt(0) || 'E').toUpperCase();
                        const photo = assignment.equipment_photo_url || assignment.photo_url || '';
                        const hasImage = !!photo;
                        return `
                            <div style="background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; margin-bottom: 15px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                                <div style="display: grid; grid-template-columns: 80px 1fr auto; gap: 20px; align-items: center;">
                                    <div>
                                        ${hasImage 
                                            ? `<img src="${photo}" alt="${assignment.equipment_name || 'Ekipman'}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 8px; border: 2px solid #e2e8f0; background: #f8fafc;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                                               <div style="display: none; width: 60px; height: 60px; background: linear-gradient(135deg, #6b7280, #4b5563); border-radius: 8px; align-items: center; justify-content: center; color: white; font-weight: 700; font-size: 20px; border: 2px solid #e2e8f0;">${firstLetter}</div>`
                                            : `<div style="width: 60px; height: 60px; background: linear-gradient(135deg, #6b7280, #4b5563); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: white; font-weight: 700; font-size: 20px; border: 2px solid #e2e8f0;">${firstLetter}</div>`
                                        }
                                    </div>
                                    <div style="flex: 1;">
                                        <h4 style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #1F2937;">${assignment.equipment_name || 'Bilinmeyen Ekipman'}</h4>
                                        <div style="display: flex; align-items: center; gap: 16px; font-size: 12px; color: #6B7280; margin-bottom: 8px;">
                                            <span style="display: flex; align-items: center; gap: 4px;"><i class="fas fa-user"></i> ${assignment.student_name || 'Bilinmeyen Öğrenci'}</span>
                                            <span style="display: flex; align-items: center; gap: 4px;"><i class="fas fa-tshirt"></i> ${assignment.size || 'Belirtilmemiş'}</span>
                                            <span style="display: flex; align-items: center; gap: 4px;"><i class="fas fa-sort-numeric-up"></i> ${assignment.quantity} adet</span>
                                            <span style="display: flex; align-items: center; gap: 4px;"><i class="fas fa-calendar"></i> ${new Date(assignment.returned_date || assignment.updated_at || assignment.created_at).toLocaleDateString('tr-TR')}</span>
                                        </div>
                                        ${assignment.notes ? `<div style="font-size: 11px; color: #6B7280; font-style: italic;">Not: ${assignment.notes}</div>` : ''}
                                    </div>
                                    <div>
                                        <span class="status-badge" style="padding: 6px 12px; border-radius: 6px; font-size: 11px; font-weight: 600; background: #6B7280; color: white;">İade Edilmiş</span>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        } catch (error) {
            console.error('Error loading returned equipment:', error);
            container.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #ef4444;">
                    <i class="fas fa-exclamation-triangle" style="font-size: 48px; margin-bottom: 16px;"></i>
                    <p>İade edilmiş ekipmanlar yüklenirken hata oluştu.</p>
                </div>
            `;
        }
    }

    // Kullanıcı yalnızca ekipman adını seçtiğinde beden listesini doldur
    onEquipmentChange(selectedName) {
        try {
            const sizeSelect = document.querySelector('select[name="sizeSelect"]');
            const quantitySelect = document.querySelector('select[name="quantity"]');
            const hiddenType = document.querySelector('input[name="equipmentType"]');
            const hiddenSize = document.querySelector('input[name="size"]');

            if (!sizeSelect) return;
            // Reset dependents
            if (hiddenType) hiddenType.value = '';
            if (hiddenSize) hiddenSize.value = '';
            if (quantitySelect) quantitySelect.innerHTML = '<option value="">Önce ekipman ve beden seçiniz...</option>';

            sizeSelect.innerHTML = '<option value="">Beden seçiniz...</option>';
            if (!selectedName) {
                sizeSelect.innerHTML = '<option value="">Önce ekipman seçiniz...</option>';
                return;
            }

            const rows = (this._equipmentTypesCache || []).filter(r => (r.name || 'Ekipman') === selectedName);
            // Unique sizes only
            const sizes = Array.from(new Set(rows.map(r => (r.size || '-'))));
            sizes.forEach(sz => {
                const opt = document.createElement('option');
                opt.value = sz;
                opt.textContent = sz;
                sizeSelect.appendChild(opt);
            });
        } catch (error) {
            console.error('onEquipmentChange error:', error);
        }
    }

    // Beden seçildiğinde uygun variant id'yi belirle ve adetleri getir
    async onSizeChange(size) {
        try {
            const equipmentNameSelect = document.querySelector('select[name="equipmentName"]');
            const quantitySelect = document.querySelector('select[name="quantity"]');
            const hiddenType = document.querySelector('input[name="equipmentType"]');
            const hiddenSize = document.querySelector('input[name="size"]');

            if (!equipmentNameSelect || !quantitySelect) return;

            const name = equipmentNameSelect.value;
            // Reset
            if (hiddenType) hiddenType.value = '';
            if (hiddenSize) hiddenSize.value = '';
            quantitySelect.innerHTML = '<option value="">Önce ekipman ve beden seçiniz...</option>';

            if (!name || !size) return;

            // Find the exact variant row
            const variant = (this._equipmentTypesCache || []).find(r => (r.name || 'Ekipman') === name && (r.size || '-') === size);
            if (!variant) {
                quantitySelect.innerHTML = '<option value="">Geçersiz seçim</option>';
                return;
            }

            if (hiddenType) hiddenType.value = variant.id;
            if (hiddenSize) hiddenSize.value = size;

            // Load available quantity for this variant
            quantitySelect.innerHTML = '<option value="">Yükleniyor...</option>';
            const stockRes = await supabaseService.getAvailableEquipmentQuantity(variant.id, size);
            const available = stockRes.success ? (stockRes.available || 0) : 0;
            quantitySelect.innerHTML = '';
            if (available > 0) {
                const maxOptions = Math.min(available, 10);
                for (let i = 1; i <= maxOptions; i++) {
                    const opt = document.createElement('option');
                    opt.value = i;
                    opt.textContent = `${i} adet`;
                    quantitySelect.appendChild(opt);
                }
            } else {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'Stok yok';
                quantitySelect.appendChild(opt);
            }
        } catch (error) {
            console.error('onSizeChange error:', error);
            const quantitySelect = document.querySelector('select[name="quantity"]');
            if (quantitySelect) quantitySelect.innerHTML = '<option value="">Stok bilgisi alınamadı</option>';
        }
    }

    // ==== STOK EKLE MODAL ====
    showAddStockModal(equipmentId, equipmentName = '') {
        // Create modal container if not exists
        let modal = document.getElementById('addStockModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'addStockModal';
            modal.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;';
            document.body.appendChild(modal);
        }

        modal.innerHTML = `
            <div style="background: white; border-radius: 12px; width: 100%; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.15); overflow: hidden;">
                <div style="background: linear-gradient(135deg, #DC2626, #B91C1C); padding: 14px 18px; color: white; display: flex; align-items: center; justify-content: space-between;">
                    <h3 style="margin: 0; font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px;"><i class="fas fa-boxes"></i> Stok Ekle ${equipmentName ? '• ' + equipmentName : ''}</h3>
                    <button onclick="app.hideAddStockModal()" title="Stok ekleme penceresini kapat" aria-label="Kapat" style="background: transparent; border: none; color: white; font-size: 22px; cursor: pointer;">×</button>
                </div>
                <form id="addStockForm" style="padding: 18px;">
                    <div style="margin-bottom: 12px;">
                        <label for="stockSize" style="display:block; font-weight:600; color:#374151; margin-bottom:6px;"><i class="fas fa-sort-numeric-up"></i> Beden / Numara</label>
                        <input type="text" id="stockSize" name="size" placeholder="Örn: S, M, 42" required style="width: 100%; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px;">
                    </div>
                    <div style="margin-bottom: 4px;">
                        <label for="stockQuantity" style="display:block; font-weight:600; color:#374151; margin-bottom:6px;"><i class="fas fa-hashtag"></i> Miktar</label>
                        <input type="number" id="stockQuantity" name="quantity" min="1" step="1" placeholder="Adet" required style="width: 100%; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px;">
                    </div>
                    <div style="display:flex; gap:10px; justify-content:flex-end; margin-top: 16px;">
                        <button type="button" onclick="app.hideAddStockModal()" style="background: #6B7280; color: white; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-weight: 600;">İptal</button>
                        <button type="submit" style="background: #10B981; color: white; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-weight: 600;"><i class="fas fa-check"></i> Kaydet</button>
                    </div>
                </form>
            </div>
        `;

        // Attach submit handler
        const form = modal.querySelector('#addStockForm');
        form.onsubmit = async (e) => {
            e.preventDefault();
            const fd = new FormData(form);
            const size = (fd.get('size') || '').toString().trim();
            const quantity = parseInt(fd.get('quantity'), 10) || 0;
            if (!size || quantity <= 0) {
                alert('Lütfen geçerli beden ve miktar giriniz.');
                return;
            }
            try {
                const res = await supabaseService.addStockToEquipmentType(equipmentId, size, quantity);
                if (!res.success) throw new Error(res.error || 'Stok eklenemedi');
                alert('Stok başarıyla eklendi.');
                this.hideAddStockModal();
                // Refresh local cache and reload inventory tab to reflect new stock
                try {
                    const refreshed = await supabaseService.getEquipmentTypes();
                    if (refreshed.success) {
                        this._equipmentTypesCache = refreshed.data;
                    }
                } catch (_) {}
                this.loadEquipmentInventoryTab();
                // If settings page's equipment types list exists, refresh it too
                try {
                    if (typeof loadEquipment === 'function') {
                        loadEquipment();
                    }
                } catch (_) {}
            } catch (err) {
                console.error('Add stock failed:', err);
                alert('Stok eklenemedi: ' + this.formatErrorMessage(err));
            }
        };

        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    hideAddStockModal() {
        const modal = document.getElementById('addStockModal');
        if (modal) {
            modal.style.display = 'none';
        }
        document.body.style.overflow = 'auto';
    }

    async initializeApp() {
        this.setupEventListeners();
        this.checkRememberedUser();
        this.showScreen('loginScreen');
        // Expose a safe global trigger for one-time monthly fee generation
        // Usage from console: window.triggerMonthlyFees()
        try {
            window.triggerMonthlyFees = () => this.generateMonthlyFeesOnce();
            // Helper to diagnose a specific student's monthly fee for current period
            window.checkStudentFees = (fullNameOrTc) => this.checkStudentFeesByName(fullNameOrTc);
            // Helper to update all active students' current period fees
            window.updateMonthlyFees = () => this.updateMonthlyFeesForCurrentPeriod();
        } catch (_) {}
    }

    async updateMonthlyFeesForCurrentPeriod() {
        try {
            const activeStudents = await supabaseService.getActiveStudents();
            if (!activeStudents.success) throw new Error('Aktif öğrenciler alınamadı');

            const students = activeStudents.data;
            const currentPeriod = await supabaseService.getCurrentPaymentPeriod();
            if (!currentPeriod.success) throw new Error('Geçerli ödeme dönemi alınamadı');

            const periodId = currentPeriod.data.id;
            const periodStart = currentPeriod.data.start_date;
            const periodEnd = currentPeriod.data.end_date;

            for (const student of students) {
                const studentId = student.id;
                const studentName = student.full_name;

                const existingFees = await supabaseService.getStudentMonthlyFees(studentId, periodId);
                if (!existingFees.success) throw new Error(`Öğrenci ${studentName} için aylık ücretler alınamadı`);

                const fees = existingFees.data;
                const unpaidFees = fees.filter(fee => !fee.paid);

                if (unpaidFees.length > 0) {
                    for (const fee of unpaidFees) {
                        const feeId = fee.id;
                        const feeAmount = fee.amount;

                        const updatedFee = await supabaseService.updateMonthlyFee(feeId, feeAmount, periodStart, periodEnd);
                        if (!updatedFee.success) throw new Error(`Öğrenci ${studentName} için aylık ücret güncellenemedi`);
                    }
                } else {
                    console.log(`Öğrenci ${studentName} için geçerli döneme ait ödenmemiş aylık ücret bulunamadı`);
                }
            }

            console.log('Tüm aktif öğrencilerin geçerli döneme ait aylık ücretleri başarıyla güncellendi');
        } catch (error) {
            console.error('Aylık ücretler güncellenirken hata oluştu:', error);
        }
    }

    async initializeSportColors() {
        // 1. Geniş ve modern bir renk paleti tanımla
        const colorPalette = [
            '#3B82F6', '#10B981', '#EF4444', '#F59E0B', '#8B5CF6', '#EC4899',
            '#14B8A6', '#F97316', '#D946EF', '#6366F1', '#F43F5E', '#84CC16'
        ];

        try {
            // 2. Veritabanından spor branşlarını çek
            const result = await supabaseService.getSportBranches();
            if (result.success && result.data) {
                const sportBranches = result.data;
                
                // 3. Her branşa sırayla bir renk ata
                sportBranches.forEach((branch, index) => {
                    // Paletin sonuna gelince başa dön (modulo operatörü %)
                    const color = colorPalette[index % colorPalette.length];
                    this.sportColorMap[branch.name] = color;
                });
                console.log('Spor renkleri başarıyla atandı:', this.sportColorMap);
            }
        } catch (error) {
            console.error('Spor renkleri atanırken hata oluştu:', error);
        }
    }
    setupEventListeners() {
        // Login form
        const loginForm = document.getElementById('loginForm');
        if (loginForm) {
            loginForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleLogin(e);
            });
        }
    
        // Navigation buttons
        document.addEventListener('click', (e) => {
            if (e.target.matches('.nav-btn')) {
                const screen = e.target.getAttribute('data-screen');
                if (screen) {
                    this.showScreen(screen);
                    
                    // Load screen-specific data
                    switch(screen) {
                        case 'dashboardScreen':
                            this.loadDashboard();
                            break;
                        case 'studentsScreen':
                            this.loadStudentsScreen();
                            break;
                        case 'paymentsScreen':
                            this.loadPaymentsScreen();
                            break;
                        case 'settingsScreen':
                            this.loadSettingsScreen();
                            break;
                        case 'equipmentScreen':
                            this.loadEquipmentScreen();
                            break;
                        case 'calendarScreen':
                            this.loadCalendarScreen();
                            break;
                    }
                }
            }

            // Chart toggle buttons
            if (e.target.matches('.chart-btn')) {
                const chartType = e.target.getAttribute('data-chart');
                if (chartType) {
                    this.toggleSportsChart(chartType);
                }
            }
        });

        document.querySelectorAll('[id^="logoutBtn"]').forEach(btn => {
            btn.addEventListener('click', () => this.handleLogout());
        });

        // Optional admin button to trigger monthly fees if present in DOM
        const triggerBtn = document.getElementById('triggerMonthlyFeesBtn');
        if (triggerBtn) {
            triggerBtn.addEventListener('click', async () => {
                await this.generateMonthlyFeesOnce();
            });
        }

        // Optional admin button to update this month's fees if present in DOM
        const updateBtn = document.getElementById('updateMonthlyFeesBtn');
        if (updateBtn) {
            updateBtn.addEventListener('click', async () => {
                await this.updateMonthlyFeesForCurrentPeriod();
            });
        }

        // Add Student button
        const addStudentBtn = document.getElementById('addStudentBtn');
        if (addStudentBtn) {
            addStudentBtn.addEventListener('click', () => this.showStudentModal());
        }
        document.querySelectorAll('.chart-btn').forEach(button => {
            console.log('🔘 Buton bulundu:', button.textContent, button.dataset.chart); // DEBUG
            button.addEventListener('click', () => {
                console.log('🖱️ Butona tıklandı:', button.textContent); // DEBUG
                const chartType = button.dataset.chart;
                
                // Diğer butonlardan 'active' class'ını kaldır
                document.querySelectorAll('.chart-btn').forEach(btn => btn.classList.remove('active'));
                // Tıklanan butona 'active' class'ını ekle
                button.classList.add('active');
        
                const titleEl = document.getElementById('studentDistributionTitle');
                if (chartType === 'gender') {
                    console.log('🚺 Cinsiyet grafiği yükleniyor...'); // DEBUG
                    titleEl.textContent = 'Cinsiyete Göre Öğrenci Dağılımı';
                    this.loadGenderDistribution();
                } else { // 'pie' seçilirse
                    console.log('🏃 Branş grafiği yükleniyor...'); // DEBUG
                    titleEl.textContent = 'Spor Branşlarına Göre Öğrenci Dağılımı';
                    this.currentChartType = chartType;
                    this.loadStudentDistribution();
                }
            });
        });
     }
      // Remove the global click handler since we're adding individual handlers to each card
    
    formatErrorMessage(error) {
        if (!error) return 'Bilinmeyen bir hata oluştu.';
        
        const errorMessage = typeof error === 'string' ? error : error.message || error.toString();
    
        // Yaygın hata mesajlarını Türkçe'ye çevir
        const errorTranslations = {
            'Network Error': 'İnternet bağlantısı sorunu. Lütfen bağlantınızı kontrol edin.',
            'Failed to fetch': 'Sunucuya bağlanılamadı. İnternet bağlantınızı kontrol edin.',
            'Invalid email': 'Geçersiz e-posta adresi.',
            'Invalid password': 'Geçersiz şifre.',
            'User not found': 'Kullanıcı bulunamadı.',
            'Wrong password': 'Hatalı şifre.',
            'Email already exists': 'Bu e-posta adresi zaten kullanımda.',
            'Username already exists': 'Bu kullanıcı adı zaten kullanımda.',
            'Cannot read properties': 'Veri okuma hatası. Lütfen tekrar deneyin.',
            'Permission denied': 'Bu işlem için yetkiniz bulunmuyor.',
            'Unauthorized': 'Yetkisiz erişim. Lütfen tekrar giriş yapın.',
            'Forbidden': 'Bu işlemi gerçekleştirme yetkiniz yok.',
            'Not found': 'İstenen kayıt bulunamadı.',
            'Duplicate key': 'Bu kayıt zaten mevcut.',
            'Foreign key': 'İlişkili kayıtlar nedeniyle işlem gerçekleştirilemedi.',
            'Connection timeout': 'Bağlantı zaman aşımına uğradı. Lütfen tekrar deneyin.',
            'Server error': 'Sunucu hatası. Lütfen daha sonra tekrar deneyin.'
        };
        
        // Hata mesajında bilinen bir pattern var mı kontrol et
        for (const [englishError, turkishError] of Object.entries(errorTranslations)) {
            if (errorMessage.toLowerCase().includes(englishError.toLowerCase())) {
                return turkishError;
            }
        }
        // Eğer çeviri bulunamazsa, orijinal mesajı temizle
        return errorMessage
        .replace(/Error:/gi, 'Hata:')
        .replace(/Failed/gi, 'Başarısız')
        .replace(/Invalid/gi, 'Geçersiz')
        .replace(/Cannot/gi, 'Yapılamıyor')
        .replace(/undefined/gi, 'tanımsız')
        .replace(/null/gi, 'boş')
        + ' Lütfen tekrar deneyin.';   
    }

    checkRememberedUser() {
        const remembered = localStorage.getItem('rememberedUser');
        if (remembered) {
            const userData = JSON.parse(remembered);
            const loginTime = userData.loginTime;
            const now = new Date().getTime();
            const daysPassed = (now - loginTime) / (1000 * 60 * 60 * 24);
            
            if (daysPassed < 7) {
                document.getElementById('username').value = userData.email;
                document.getElementById('rememberMe').checked = true;
            } else {
                localStorage.removeItem('rememberedUser');
            }
        }
    }

    async handleLogin(e) {
        e.preventDefault();
        
        const email = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const rememberMe = document.getElementById('rememberMe').checked;
        
        if (!email || !password) {
            alert('Lütfen email ve şifre giriniz.');
            return;
        }
        
        try {
            const result = await supabaseService.signIn(email, password);
            
            if (result.success) {
                this.currentUser = result.user;

                // localStorage'a kullanıcı bilgisini kaydet
                localStorage.setItem('currentUser', JSON.stringify({
                    name: result.user.full_name || result.user.username,
                    email: result.user.email,
                    role: result.user.role
                }));
                
                   // Giriş log kaydı - result.user bilgisini kullan
                if (result.user) {
                    try {
                        await supabaseService.addActivityLog(
                            'login',
                            'user',
                            result.user.id,
                            `${result.user.email || result.user.username} kullanıcısı giriş yaptı`,
                            result.user // Kullanıcı bilgilerini parametre olarak geç
                        );
                    } catch (logError) {
                        console.error('Giriş log kaydı eklenirken hata:', logError);
                    }
                }       
    
                
                if (rememberMe) {
                    localStorage.setItem('rememberedUser', JSON.stringify({
                        email: email,
                        loginTime: new Date().getTime()
                    }));
                }
                
                this.updateWelcomeMessage(this.currentUser.email);
                await this.initializeSportColors(); // YENİ: Renkleri burada hazırla
                this.showScreen('dashboardScreen');
                await this.loadDashboard();
                // Ayın ilk günü otomatik aidat kontrolü (tek sefer/ay)
                await this.maybeAutoGenerateMonthlyFees();
            } else {
                alert('Giriş başarısız: ' + this.formatErrorMessage(result.error));
            }
        } catch (error) {
            console.error('Login error:', error);
            alert('Giriş yapılamadı. Lütfen tekrar deneyin.');
        }
    }

    handleNavigation(e) {
        e.preventDefault();
        const screenId = e.target.getAttribute('data-screen');
        if (screenId) {
            this.showScreen(screenId);
            
            // Load screen-specific data
            switch(screenId) {
                case 'dashboardScreen':
                    this.loadDashboard();
                    break;
                case 'studentsScreen':
                    this.loadStudentsScreen();
                    break;
                case 'paymentsScreen':
                    this.loadPaymentsScreen();
                    break;
                case 'settingsScreen':
                    this.loadSettingsScreen();
                    break;
                case 'equipmentScreen':
                    this.loadEquipmentScreen();
                    break;
                case 'calendarScreen':
                    this.loadCalendarScreen();
                    break;
            }
        }
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
        document.getElementById(screenId).classList.add('active');
        this.currentScreen = screenId;
        
        // Update navigation active state
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        
        // Set active nav button based on screen
        const navMapping = {
            'calendarScreen': 'calendar',
            'studentsScreen': 'students', 
            'paymentsScreen': 'payments',
            'equipmentScreen': 'equipment',
            'settingsScreen': 'settings'
        };
        
        const navScreen = navMapping[screenId];
        if (navScreen) {
            const activeBtn = document.querySelector(`[onclick="app.showScreen('${navScreen}')"]`);
            if (activeBtn) {
                activeBtn.classList.add('active');
            }
        }
    }

    async showStudentModal(studentId = null) {
        // Close any existing detail modal first
        const detailModal = document.getElementById('studentDetailModal');
        if (detailModal) {
            detailModal.style.display = 'none';
        }
        
        const modal = document.getElementById('studentModal');
        const modalTitle = document.getElementById('modalTitle');
        const formContent = document.getElementById('studentFormContent');

        if (!modal || !formContent) {
            console.error('Student modal elements not found');
            return;
        }

        modalTitle.textContent = studentId ? 'Öğrenci Düzenle' : 'Yeni Öğrenci Ekle';
        
        // If editing, fetch fresh data from Supabase
        let student = null;
        if (studentId) {
            try {
                const result = await supabaseService.getStudent(studentId);
                if (result.success) {
                    student = result.data;
                   
                } else {
                   
                    student = this.students?.find(s => s.id === studentId);
                }
            } catch (error) {
                console.error('Error loading student from Supabase:', error);
                student = this.students?.find(s => s.id === studentId);
            }
        }
        
        formContent.innerHTML = await this.generateStudentForm(student);
        modal.style.display = 'flex';
        
        // Scroll modal content to top
        const modalContent = modal.querySelector('.modal-content');
        if (modalContent) {
            modalContent.scrollTop = 0;
        }
        
        // Prevent background scrolling
        document.body.style.overflow = 'hidden';
        
        // Setup form submission
        const form = document.getElementById('studentForm');
        if (form) {
            form.addEventListener('submit', (e) => this.handleStudentFormSubmit(e, studentId));
        }
        
        // Setup close modal button
        const closeBtn = document.getElementById('closeModal');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hideStudentModal());
        }
    }

    hideStudentModal() {
        const modal = document.getElementById('studentModal');
        if (modal) {
            modal.style.display = 'none';
        }
        // Restore background scrolling
        document.body.style.overflow = 'auto';
    }

    async generateStudentForm(student = null) {
        if (!student) {
            student = {};
        }
     // Spor branşlarını Supabase'den çek
     let sportBranches = [];
     try {
         const result = await supabaseService.getSportBranches();
         if (result.success && result.data) {
             sportBranches = result.data;
         }
     } catch (error) {
         console.error('Error loading sport branches:', error);
         // Fallback: varsayılan branşlar
         sportBranches = [
             { name: 'Futbol' },
             { name: 'Kadın Futbol' },
             { name: 'Basketbol' },
             { name: 'Voleybol' },
             { name: 'Tenis' }
         ];
     }
     
        
        return `
            <form id="studentForm" style="max-height: 80vh; overflow-y: auto;">
                <!-- Öğrenci Bilgileri -->
                <div class="form-section" style="margin-bottom: 20px;">
                    <h3 style="margin-bottom: 15px; padding-bottom: 8px; border-bottom: 2px solid #DC2626;">
                        <i class="fas fa-user"></i> ÖĞRENCİ BİLGİLERİ
                    </h3>
                    <div class="form-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div class="input-group" style="margin-bottom: 12px;">
                            <label style="margin-bottom: 5px; font-weight: 600;">
                                <i class="fas fa-camera"></i> Fotoğraf
                            </label>
                            <input type="file" name="photo" accept="image/*" style="padding: 8px;">
                            ${student.photo_thumb_url || student.photo_url || student.photo ? 
                                `<div class="current-photo" style="margin-top: 8px;">
                                    <img src="${student.photo_thumb_url || student.photo_url || student.photo}" alt="Mevcut fotoğraf" 
                                         style="width: 60px; height: 60px; object-fit: cover; border-radius: 50%; border: 2px solid #DC2626;">
                                </div>` : ''}
                        </div>
                        <div class="input-group" style="margin-bottom: 12px;">
                            <label style="margin-bottom: 5px; font-weight: 600;">
                                <i class="fas fa-id-card"></i> TC Kimlik No *
                            </label>
                            <input type="text" name="tcno" value="${student.tc_no || student.tcno || ''}" 
                                   placeholder="11 haneli TC kimlik numarası" maxlength="11" required style="padding: 8px;">
                        </div>
                        <div class="input-group" style="margin-bottom: 12px;">
                            <label style="margin-bottom: 5px; font-weight: 600;">
                                <i class="fas fa-user"></i> Ad *
                            </label>
                            <input type="text" name="name" value="${student.name || ''}" 
                                   placeholder="Öğrencinin adı" required style="padding: 8px;">
                        </div>
                        <div class="input-group" style="margin-bottom: 12px;">
                            <label style="margin-bottom: 5px; font-weight: 600;">
                                <i class="fas fa-user"></i> Soyad *
                            </label>
                            <input type="text" name="surname" value="${student.surname || ''}" 
                                   placeholder="Öğrencinin soyadı" required style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-calendar"></i> Doğum Tarihi</label>
                            <input type="date" name="birthDate" value="${student.birth_date || student.birthDate || ''}" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-map-marker-alt"></i> Doğum Yeri</label>
                            <input type="text" name="birthPlace" value="${student.birth_place || student.birthPlace || ''}" 
                                   placeholder="Doğum yeri" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-school"></i> Okul</label>
                            <input type="text" name="school" value="${student.school || ''}" placeholder="Okul adı" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-running"></i> Spor Branşı *</label>
                           <select name="sport" required style="padding: 8px;">
    <option value="">Seçiniz...</option>
    ${sportBranches.map(branch => {
        // GÜVENLİK: Obje olabilecek sport değerini kontrol et
        const studentSportText = this.getSportText(student.sport);
        return `<option value="${branch.name}" ${studentSportText === branch.name ? 'selected' : ''}>${branch.name}</option>`;
    }).join('')}
</select>
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-ruler-vertical"></i> Boy (cm)</label>
                            <input type="number" name="height" value="${student.height || ''}" 
                                   placeholder="Boy (cm)" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-weight"></i> Kilo (kg)</label>
                            <input type="number" name="weight" value="${student.weight || ''}" 
                                   placeholder="Kilo (kg)" style="padding: 8px;">
                        </div>
                        <div class="input-group">
    <label><i class="fas fa-venus-mars"></i> Cinsiyet *</label>
    <select name="gender" required style="padding: 8px;">
        <option value="">Seçiniz...</option>
        <option value="Erkek" ${student.gender === 'Erkek' ? 'selected' : ''}>Erkek</option>
        <option value="Kadın" ${student.gender === 'Kadın' ? 'selected' : ''}>Kadın</option>
    </select>
</div>
                        <div class="input-group">
                            <label><i class="fas fa-tint"></i> Kan Grubu</label>
                            <select name="bloodType" style="padding: 8px;">
                                <option value="">Seçiniz...</option>
                                <option value="A+" ${student.blood_type === 'A+' ? 'selected' : ''}>A+</option>
                                <option value="A-" ${student.blood_type === 'A-' ? 'selected' : ''}>A-</option>
                                <option value="B+" ${student.blood_type === 'B+' ? 'selected' : ''}>B+</option>
                                <option value="B-" ${student.blood_type === 'B-' ? 'selected' : ''}>B-</option>
                                <option value="AB+" ${student.blood_type === 'AB+' ? 'selected' : ''}>AB+</option>
                                <option value="AB-" ${student.blood_type === 'AB-' ? 'selected' : ''}>AB-</option>
                                <option value="0+" ${student.blood_type === '0+' ? 'selected' : ''}>0+</option>
                                <option value="0-" ${student.blood_type === '0-' ? 'selected' : ''}>0-</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-phone"></i> Telefon</label>
                            <input type="tel" name="phone" value="${student.phone || ''}" 
                                   placeholder="Telefon numarası" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-percentage"></i> Öğrenci İndirimi</label>
                            <select name="discount_rate" style="padding: 8px;">
                                <option value="0" ${(student.discount_rate || 0) === 0 ? 'selected' : ''}>%0 (İndirim yok)</option>
                                <option value="10" ${student.discount_rate === 10 ? 'selected' : ''}>%10</option>
                                <option value="20" ${student.discount_rate === 20 ? 'selected' : ''}>%20</option>
                                <option value="25" ${student.discount_rate === 25 ? 'selected' : ''}>%25</option>
                                <option value="30" ${student.discount_rate === 30 ? 'selected' : ''}>%30</option>
                                <option value="40" ${student.discount_rate === 40 ? 'selected' : ''}>%40</option>
                                <option value="50" ${student.discount_rate === 50 ? 'selected' : ''}>%50</option>
                                <option value="100" ${student.discount_rate === 100 ? 'selected' : ''}>%100</option>
                            </select>
                        </div>
                    </div>
                </div>

                <!-- Veli Bilgileri -->
                <div class="form-section" style="margin-bottom: 20px;">
                    <h3 style="margin-bottom: 15px; padding-bottom: 8px; border-bottom: 2px solid #DC2626;">
                        <i class="fas fa-users"></i> VELİ BİLGİLERİ
                    </h3>
                    <div class="form-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div class="input-group">
                            <label><i class="fas fa-id-card"></i> Baba TC No</label>
                            <input type="text" name="fatherTcno" value="${student.father_tcno || ''}" 
                                   placeholder="Baba TC kimlik no" maxlength="11" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-user"></i> Baba Adı</label>
                            <input type="text" name="fatherName" value="${student.father_name || ''}" 
                                   placeholder="Baba adı soyadı" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-briefcase"></i> Baba Mesleği</label>
                            <input type="text" name="fatherJob" value="${student.father_job || ''}" 
                                   placeholder="Baba mesleği" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-phone"></i> Baba Telefon</label>
                            <input type="tel" name="fatherPhone" value="${student.father_phone || ''}" 
                                   placeholder="Baba telefon" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-id-card"></i> Anne TC No</label>
                            <input type="text" name="motherTcno" value="${student.mother_tcno || ''}" 
                                   placeholder="Anne TC kimlik no" maxlength="11" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-user"></i> Anne Adı</label>
                            <input type="text" name="motherName" value="${student.mother_name || ''}" 
                                   placeholder="Anne adı soyadı" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-briefcase"></i> Anne Mesleği</label>
                            <input type="text" name="motherJob" value="${student.mother_job || ''}" 
                                   placeholder="Anne mesleği" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-phone"></i> Anne Telefon</label>
                            <input type="tel" name="motherPhone" value="${student.mother_phone || ''}" 
                                   placeholder="Anne telefon" style="padding: 8px;">
                        </div>
                    </div>
                </div>

                <!-- Acil Durum İletişim -->
                <div class="form-section" style="margin-bottom: 20px;">
                    <h3 style="margin-bottom: 15px; padding-bottom: 8px; border-bottom: 2px solid #DC2626;">
                        <i class="fas fa-exclamation-triangle"></i> ACİL DURUM İLETİŞİM
                    </h3>
                    <div class="form-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div class="input-group">
                            <label><i class="fas fa-user"></i> Ad Soyad</label>
                            <input type="text" name="emergencyName" value="${student.emergency_name || ''}" 
                                   placeholder="Acil durum kişisi" style="padding: 8px;">
                        </div>
                        <div class="input-group">
                            <label><i class="fas fa-heart"></i> Yakınlık</label>
                            <input type="text" name="emergencyRelation" value="${student.emergency_relation || ''}" 
                                   placeholder="Yakınlık derecesi" style="padding: 8px;">
                        </div>
                        <div class="input-group" style="grid-column: 1 / -1;">
                            <label><i class="fas fa-phone"></i> Telefon</label>
                            <input type="tel" name="emergencyPhone" value="${student.emergency_phone || ''}" 
                                   placeholder="Acil durum telefon" style="padding: 8px;">
                        </div>
                    </div>
                </div>

                <!-- Adres -->
                <div class="form-section" style="margin-bottom: 20px;">
                    <h3 style="margin-bottom: 15px; padding-bottom: 8px; border-bottom: 2px solid #DC2626;">
                        <i class="fas fa-home"></i> ADRES BİLGİLERİ
                    </h3>
                    <div class="input-group">
                        <label><i class="fas fa-map-marker-alt"></i> Adres</label>
                        <textarea name="address" rows="3" placeholder="Tam adres" style="padding: 8px; resize: vertical;">${student.address || ''}</textarea>
                    </div>
                </div>

                <!-- Notlar -->
                <div class="form-section" style="margin-bottom: 20px;">
                    <h3 style="margin-bottom: 15px; padding-bottom: 8px; border-bottom: 2px solid #DC2626;">
                        <i class="fas fa-sticky-note"></i> NOTLAR
                    </h3>
                    <div class="input-group">
                        <label><i class="fas fa-comment"></i> Notlar</label>
                        <textarea name="notes" rows="3" placeholder="Öğrenci hakkında notlar" style="padding: 8px; resize: vertical;">${student.notes || ''}</textarea>
                    </div>
                </div>
                
                <div class="form-buttons" style="display: flex; gap: 10px; justify-content: center; margin-top: 20px; padding: 20px; border-top: 1px solid #e5e7eb; background: #f9fafb; flex-wrap: wrap;">
                    <button type="submit" class="btn-primary" style="background: #DC2626; color: white; padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; font-weight: 500;">
                        <i class="fas fa-${student.id ? 'edit' : 'save'}"></i> ${student.id ? 'Güncelle' : 'Kaydet'}
                    </button>
                    <button type="button" onclick="app.printStudentForm('${student.id || 'new'}')" 
                            style="background: #10B981; color: white; padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; font-weight: 500;">
                        <i class="fas fa-print"></i> Form Yazdır
                    </button>
                    <button type="button" class="btn-secondary" onclick="app.hideStudentModal()" 
                            style="background: #6b7280; color: white; padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; font-weight: 500;">
                        <i class="fas fa-times"></i> İptal
                    </button>
                  </div>
                </div>
            </form>
        `;
    }

    async handleStudentFormSubmit(e, studentId = null) {
        e.preventDefault();
        
        const formData = new FormData(e.target);
        
        // GÜVENLİK: Input sanitization ve validation
        const rawData = {
            name: formData.get('name'),
            surname: formData.get('surname'),
            tcno: formData.get('tcno'),
            birth_date: formData.get('birthDate') || null,
            birth_place: formData.get('birthPlace') || null,
            school: formData.get('school') || null,
            sport: formData.get('sport'),
            height: formData.get('height') ? parseInt(formData.get('height')) : null,
            weight: formData.get('weight') ? parseInt(formData.get('weight')) : null,
            gender: formData.get('gender') || null,
            blood_type: formData.get('bloodType') || null,
            phone: formData.get('phone') || null,
            // İndirim oranı
            discount_rate: (() => { const dr = formData.get('discount_rate'); return dr ? parseInt(dr) : 0; })(),
            
            // Veli bilgileri
            father_tcno: formData.get('fatherTcno') || null,
            father_name: formData.get('fatherName') || null,
            father_job: formData.get('fatherJob') || null,
            father_phone: formData.get('fatherPhone') || null,
            mother_tcno: formData.get('motherTcno') || null,
            mother_name: formData.get('motherName') || null,
            mother_job: formData.get('motherJob') || null,
            mother_phone: formData.get('motherPhone') || null,
            
            // Acil durum iletişim
            emergency_name: formData.get('emergencyName') || null,
            emergency_relation: formData.get('emergencyRelation') || null,
            emergency_phone: formData.get('emergencyPhone') || null,
            
            // Adres ve notlar
            address: formData.get('address') || null,
            notes: formData.get('notes') || null,
        };

        // GÜVENLİK: Tüm string alanları sanitize et
        const studentData = {};
        for (const [key, value] of Object.entries(rawData)) {
            if (typeof value === 'string') {
                studentData[key] = this.sanitizeHtml(value.trim());
            } else {
                studentData[key] = value;
            }
        }

        // GÜVENLİK: Gelişmiş validation
        if (!this.validateInput(studentData.name, 'text') || 
            !this.validateInput(studentData.surname, 'text') || 
            !this.validateInput(studentData.tcno, 'tcno') || 
            !this.validateInput(studentData.sport, 'text')) {
            alert('Lütfen tüm zorunlu alanları doğru formatta doldurun.');
            return;
        }

        // Telefon numarası validation (varsa)
        if (studentData.phone && !this.validateInput(studentData.phone, 'phone')) {
            alert('Geçersiz telefon numarası formatı!');
            return;
        }

        // TC Kimlik No validation
        if (!this.validateTCKimlikNo(studentData.tcno)) {
            alert('Geçersiz TC Kimlik Numarası! Lütfen 11 haneli geçerli bir TC Kimlik No giriniz.');
            return;
        }

        // Calculate age from birth date if provided
        if (studentData.birth_date) {
            const today = new Date();
            const birth = new Date(studentData.birth_date);
            let age = today.getFullYear() - birth.getFullYear();
            const monthDiff = today.getMonth() - birth.getMonth();
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
                age--;
            }
            studentData.age = age;
        }
    

    // Fotoğraf işleme: sıkıştır ve küçük önizleme üret
    const photoFile = document.querySelector('input[name="photo"]')?.files[0];
    if (photoFile) {
        try {
            if (photoFile.size > 10 * 1024 * 1024) {
                throw new Error('Lütfen daha küçük bir fotoğraf seçin (maks. 10MB)');
            }
            const mainDataUrl = await this._compressToDataUrl(photoFile, 1280, 0.75, 'image/webp');
            const thumbDataUrl = await this._createThumbDataUrl(photoFile, 256, 0.7, 'image/webp');
            studentData.photo_url = mainDataUrl;
            studentData.photo_thumb_url = thumbDataUrl;
        } catch (error) {
            console.error('Photo optimize error:', error);
            // Hata durumunda avatar kullan
            const studentInitials = `${studentData.name?.charAt(0) || 'S'}${studentData.surname?.charAt(0) || 'T'}`;
            const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(studentInitials)}&background=dc2626&color=fff&size=150`;
            studentData.photo_url = avatar;
            studentData.photo_thumb_url = avatar;
        }
    } else {
        // Resim yoksa default avatar
        const studentInitials = `${studentData.name?.charAt(0) || 'S'}${studentData.surname?.charAt(0) || 'T'}`;
        const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(studentInitials)}&background=dc2626&color=fff&size=150`;
        studentData.photo_url = avatar;
        studentData.photo_thumb_url = avatar;
    }

// created_by alanını set et (sadece yeni öğrenci için)
if (!studentId) {
    // Mevcut kullanıcı bilgisini al
   
    
    let userId = null;
    
    // Önce this.currentUser'dan dene
    if (this.currentUser && this.currentUser.id) {
        userId = this.currentUser.id;
       
    } 
    // Sonra localStorage'dan dene
    else {
        try {
            const storedUser = localStorage.getItem('currentUser');
            if (storedUser) {
                const user = JSON.parse(storedUser);
                if (user && user.id) {
                    userId = user.id;
                    
                }
            }
        } catch (e) {
            
        }
    }
    
    // Son çare: yakup kullanıcısının ID'sini kullan
    if (!userId) {
        // Yakup kullanıcısını veritabanından al
        try {
            const userResult = await supabaseService.getUserByUsername('yakup');
            if (userResult.success && userResult.data && userResult.data.length > 0) {
                userId = userResult.data[0].id;
                
            }
        } catch (e) {
           
        }
    }
    
    studentData.created_by = userId;
    

} else {
    // GÜNCELLEME: Mevcut foto alanlarını koru
    
    const currentResult = await supabaseService.getStudent(studentId);
    if (currentResult.success && currentResult.data) {
      // Her zaman mevcut foto alanlarını koru (güncelleme modunda)
studentData.photo_url = currentResult.data.photo_url;
studentData.photo_thumb_url = currentResult.data.photo_thumb_url || currentResult.data.photo_url;


// Eğer resim seçilmişse yeni resmi sıkıştır ve kaydet
const photoFile = document.querySelector('input[name="photo"]')?.files[0];
if (photoFile) {
    try {
        if (photoFile.size > 10 * 1024 * 1024) {
            throw new Error('Lütfen daha küçük bir fotoğraf seçin (maks. 10MB)');
        }
        const mainDataUrl = await this._compressToDataUrl(photoFile, 1280, 0.75, 'image/webp');
        const thumbDataUrl = await this._createThumbDataUrl(photoFile, 256, 0.7, 'image/webp');
        studentData.photo_url = mainDataUrl;
        studentData.photo_thumb_url = thumbDataUrl;
    } catch (error) {
        console.error('Photo optimize error:', error);
        alert('Resim yüklenemedi: ' + this.formatErrorMessage(error));
    }
}
    }
}

        try {
            let result;
            if (studentId) {
                result = await supabaseService.updateStudent(studentId, studentData);
            } else {
                studentData.created_at = new Date().toISOString();
                result = await supabaseService.createStudent(studentData);
            }
            
            if (result.success) {
                alert(studentId ? 'Öğrenci başarıyla güncellendi!' : 'Öğrenci başarıyla eklendi!');
                this.hideStudentModal();
                const action = studentId ? 'update' : 'create';
            await supabaseService.addActivityLog(
                action,
                'student',
                studentId || result.data[0].id,
                `${studentData.name} ${studentData.surname} isimli öğrenci ${action === 'create' ? 'oluşturuldu' : 'güncellendi'}`
                );
                
                // PERFORMANS: Cache'i temizle
                this.clearCache('students');
                
                // Öğrenci listesini yenile
                this.loadStudentsScreen();
                
                // Eğer öğrenci güncellendiyse, ilgili ekranları da yenile
if (studentId) {
    // Gelecek dönem ödenmemiş aidatları yeni indirim oranına göre güncelle
    try { await supabaseService.recalculateFuturePaymentsForStudent(studentId); } catch (_) {}
    
    // Spor branşı değişmişse mevcut aya ait borç kaydını güncelle
    await this.updateCurrentMonthPaymentForStudent(studentId, studentData.sport);
    
    // Her zaman ödeme ekranını yenile (spor branşı değişmiş olabilir)
    
    this.loadPaymentsScreen();
    
    // Aktif ekranı kontrol et ve yenile
    const activeScreen = document.querySelector('.screen:not([style*="display: none"])');
    if (activeScreen) {
        const screenId = activeScreen.id;
        
        
        switch (screenId) {
            case 'dashboardScreen':
                
                this.loadDashboard();
                break;
            case 'equipmentScreen':
                
                this.loadEquipmentScreen();
                break;
            case 'calendarScreen':
                
                this.loadCalendarScreen();
                break;
        }
    }
}
                
            } else {
                alert('İşlem başarısız: ' + this.formatErrorMessage(result.error));
            }
        } catch (error) {
            console.error('Error saving student:', error);
            alert('Öğrenci kaydedilemedi. Lütfen tekrar deneyin.');
        }
    }

    clearStudentForm() {
        const form = document.getElementById('studentForm');
        if (form) {
            form.reset();
        }
    }

    handleLogout() {
        this.currentUser = null;
        localStorage.removeItem('rememberedUser');
        this.showScreen('loginScreen');
    }

    updateWelcomeMessage(email) {
        // Kullanıcı adını email'den çıkar veya full_name kullan
        let displayName = email;
        if (this.currentUser && this.currentUser.full_name) {
            displayName = this.currentUser.full_name;
        } else if (this.currentUser && this.currentUser.username) {
            displayName = this.currentUser.username;
        } else if (email) {
            // Email'den @ öncesini al
            displayName = email.split('@')[0];
        }
    
        // Tüm welcome elementlerini güncelle
        const welcomeElements = [
            'userWelcome', 'userWelcome2', 'userWelcome3', 
            'userWelcome4', 'userWelcome5', 'userWelcome6', 'userWelcome7', 'welcomeMessage'
        ];
        
        welcomeElements.forEach(elementId => {
            const element = document.getElementById(elementId);
            if (element) {
                element.textContent = `Hoş geldiniz, ${displayName}`;
            }
        });
        
        // Update navigation based on user role
        this.updateNavigationByRole();
    }

    updateNavigationByRole() {
        if (!this.currentUser) return;
        
        const userRole = this.currentUser.role;
        
        
        // Hide settings tab for non-admin users
        const settingsNavBtns = document.querySelectorAll('#settingsNavBtn, [data-screen="settingsScreen"]');
        settingsNavBtns.forEach(btn => {
            if (userRole !== 'admin') {
                btn.style.display = 'none';
            } else {
                btn.style.display = 'block';
            }
        });
        
        // Show/hide other features based on role
        if (userRole === 'coach') {
            // Coaches can see students, trainings, equipment
           
        } else if (userRole === 'user') {
            // Regular users have limited access
            
        }
    }

    // Placeholder methods for other functionality
    async loadDashboard() {
        await this.updateDashboardStats();
        await this.loadStudentDistribution(); // loadSportsChart yerine bunu çağır
        await this.loadPaymentsChart();
        await this.loadWeeklyTrainings();
        await this.loadRecentActivities();
        
        // Otomatik aylık borç sistemini başlat
        await this.setupAutomaticMonthlyDebts();
        
        // Global fonksiyonları tanımla (console'dan çağırılabilir)
        window.createMonthlyDebts = () => this.createMonthlyDebtsForActiveStudents();
        window.createNextMonthDebt = () => this.createNextMonthDebt();
        window.setupAutomaticDebts = () => this.setupAutomaticMonthlyDebts();
        
        console.log('💡 Borç oluşturma fonksiyonları hazır:');
        console.log('   - createMonthlyDebts() → Mevcut ay için borç oluştur');
        console.log('   - createNextMonthDebt() → Gelecek ay için borç oluştur');
        console.log('   - setupAutomaticDebts() → Otomatik aylık borç sistemini başlat');
    }

    async updateDashboardStats() {
        try {
            // Total students
            const studentsResult = await supabaseService.getStudents();
            const totalStudents = studentsResult.success ? (studentsResult.data || []).filter(s => !s.is_deleted).length : 0;
            const totalStudentsEl = document.getElementById('totalStudents');
            if (totalStudentsEl) totalStudentsEl.textContent = totalStudents;

            // Total sport branches
            const branchesResult = await supabaseService.getSportBranches();
            const totalBranches = branchesResult.success ? (branchesResult.data || []).length : 0;
            const totalBranchesEl = document.getElementById('totalSportBranches');
            if (totalBranchesEl) totalBranchesEl.textContent = totalBranches;

            // Payment rate
            const paymentsResult = await supabaseService.getPayments();
            const paymentRateEl = document.getElementById('paymentRate');
            if (paymentRateEl) {
                if (paymentsResult.success && paymentsResult.data && paymentsResult.data.length > 0) {
                    const payments = paymentsResult.data;
                    const paidCount = payments.filter(p => p.is_paid).length;
                    const paymentRate = Math.round((paidCount / payments.length) * 100);
                    paymentRateEl.textContent = paymentRate + '%';
                } else {
                    paymentRateEl.textContent = '0%';
                }
            }

            // Monthly trainings
            const trainingsResult = await supabaseService.getTrainings();
            const monthlyTrainingsEl = document.getElementById('monthlyTrainings');
            if (monthlyTrainingsEl) {
                if (trainingsResult.success) {
                    const trainings = trainingsResult.data || [];
                    const today = new Date();
                    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
                    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                    
                    const monthlyTrainings = trainings.filter(t => {
                        const trainingDate = new Date(t.date);
                        return trainingDate >= startOfMonth && trainingDate <= endOfMonth;
                    }).length;
                    
                    monthlyTrainingsEl.textContent = monthlyTrainings;
                } else {
                    monthlyTrainingsEl.textContent = '0';
                }
            }
        } catch (error) {
            console.error('Error updating dashboard stats:', error);
        }
    }

    async loadSportsChart(chartType = this.currentChartType) {
        const ctx = document.getElementById('sportsChart');
        if (!ctx) return;
        
        let sportsData = {};
        
        try {
            const result = await supabaseService.getStudents();
            if (result.success && result.data && result.data.length > 0) {
                const activeStudents = result.data.filter(student => !student.is_deleted);
                
                if (activeStudents.length === 0) {
                    sportsData['Henüz öğrenci yok'] = 1;
                } else {
                    activeStudents.forEach(student => {
                        const sport = student.branch || student.sport || 'Belirtilmemiş';
                        sportsData[sport] = (sportsData[sport] || 0) + 1;
                    });
                }
            } else {
                sportsData['Henüz öğrenci yok'] = 1;
            }
        } catch (error) {
            console.error('Error loading students for chart:', error);
            sportsData['Veri yüklenemedi'] = 1;
        }
        
        if (this.sportsChart) {
            this.sportsChart.destroy();
        }

        const isPieChart = chartType === 'pie';
        
        this.sportsChart = new Chart(ctx, {
            type: isPieChart ? 'pie' : 'bar',
            data: {
                labels: Object.keys(sportsData),
                datasets: [{
                    label: isPieChart ? undefined : 'Öğrenci Sayısı',
                    data: Object.values(sportsData),
                    backgroundColor: isPieChart ? [
                        '#3B82F6', '#EC4899', '#F59E0B', '#10B981', '#8B5CF6', '#EF4444'
                    ] : [
                        '#3B82F6', '#EC4899', '#F59E0B', '#10B981', '#8B5CF6', '#EF4444'
                    ],
                    borderWidth: isPieChart ? 2 : 1,
                    borderColor: isPieChart ? '#ffffff' : [
                        '#2563EB', '#BE185D', '#D97706', '#059669', '#7C3AED', '#DC2626'
                    ],
                    borderRadius: isPieChart ? 0 : 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: isPieChart,
                        position: 'bottom',
                        labels: {
                            padding: 20,
                            usePointStyle: true,
                            font: {
                                size: 12
                            }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const label = context.label || '';
                                const value = context.parsed;
                                if (isPieChart) {
                                    const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                    const percentage = ((value / total) * 100).toFixed(1);
                                    return `${label}: ${value} öğrenci (${percentage}%)`;
                                } else {
                                    return `${label}: ${value} öğrenci`;
                                }
                            }
                        }
                    }
                },
                scales: isPieChart ? {} : {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1
                        }
                    }
                }
            }
        });
    }

    toggleSportsChart(chartType) {
        // Update active button
        document.querySelectorAll('.chart-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`[data-chart="${chartType}"]`).classList.add('active');
        
        // Update current chart type and reload chart
        this.currentChartType = chartType;
        this.loadSportsChart(chartType);
    }

    async loadPaymentsChart() {
        const ctx = document.getElementById('paymentsChart');
        if (!ctx) return;
        
        try {
            const result = await supabaseService.getPayments();
            let paidCount = 0;
            let unpaidCount = 0;
            
            if (result.success && result.data && result.data.length > 0) {
                result.data.forEach(payment => {
                    if (payment.is_paid) {
                        paidCount++;
                    } else {
                        unpaidCount++;
                    }
                });
            }
            
            if (paidCount === 0 && unpaidCount === 0) {
                unpaidCount = 1; // Show empty state
            }
            
            if (this.paymentsChart) {
                this.paymentsChart.destroy();
            }
            
            this.paymentsChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: paidCount === 0 && unpaidCount === 1 ? ['Henüz ödeme yok'] : ['Ödendi', 'Ödenmedi'],
                    datasets: [{
                        data: paidCount === 0 && unpaidCount === 1 ? [1] : [paidCount, unpaidCount],
                        backgroundColor: paidCount === 0 && unpaidCount === 1 ? ['#9CA3AF'] : ['#10B981', '#EF4444']
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom'
                        }
                    }
                }
            });
        } catch (error) {
            console.error('Error loading payments chart:', error);
        }
    }

    async loadRecentActivities() {
        const container = document.getElementById('recentActivitiesList');
        if (!container) return;
        
        try {
            const visible = await this.getMeaningfulActivities(5);

                if (visible.length === 0) {
                    container.innerHTML = `
                        <div style="text-align: center; color: #6b7280; padding: 40px 20px;">
                            <i class="fas fa-history" style="font-size: 32px; margin-bottom: 12px; opacity: 0.5;"></i>
                            <div style="font-size: 14px;">Görüntülenecek aktivite yok</div>
                            <div style="font-size: 12px; margin-top: 4px;">Son değişiklikler burada listelenecek</div>
                        </div>
                    `;
                    return;
                }

                container.innerHTML = visible.map(({ activity, label }) => {
                    const date = new Date(activity.created_at);
                    const timeAgo = this.getTimeAgo(date);
                    const actorRaw = activity.actor_name || activity.user_name || (activity.user_email ? activity.user_email.split('@')[0] : '') || 'Sistem';
                    const actor = this.escapeHtml(actorRaw);
                    const title = this.escapeHtml(this.getActivityTitle(activity));
                    const iconName = this.getActionIcon(`${activity.entity_type || ''} ${activity.action || ''}`);

                    return `
                        <div class="activity-item" style="display: flex; align-items: center; padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                            <div class="activity-icon" style="width: 40px; height: 40px; border-radius: 50%; background: #3b82f6; display: flex; align-items: center; justify-content: center; margin-left: 12px; margin-right: 12px; color: white; flex-shrink: 0;">
                                <i class="fas ${iconName}" style="font-size: 16px;"></i>
                            </div>
                            <div class="activity-content" style="flex: 1;">
                                <div class="activity-title" style="font-size: 14px; color: #1f2937; font-weight: 600; margin-bottom: 4px;">${title}</div>
                                <div class="activity-meta" style="font-size: 12px; color: #6b7280; display: flex; align-items: center; gap: 12px;">
                                    <span><i class="fas fa-user" style="margin-right: 4px;"></i>${actor}</span>
                                    <span><i class="fas fa-clock" style="margin-right: 4px;"></i>${timeAgo}</span>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
        } catch (error) {
            console.error('Error loading recent activities:', error);
            container.innerHTML = `
                <div style="text-align: center; color: #ef4444; padding: 40px 20px;">
                    <i class="fas fa-exclamation-triangle" style="font-size: 32px; margin-bottom: 12px;"></i>
                    <div style="font-size: 14px;">Aktiviteler yüklenemedi</div>
                    <div style="font-size: 12px; margin-top: 4px;">Lütfen sayfayı yenileyin veya daha sonra tekrar deneyin</div>
                </div>
            `;
        }
    }

    getTimeAgo(date) {
        const now = new Date();
        const diffInSeconds = Math.floor((now - date) / 1000);
        
        if (diffInSeconds < 60) {
            return 'Az önce';
        } else if (diffInSeconds < 3600) {
            const minutes = Math.floor(diffInSeconds / 60);
            return `${minutes} dakika önce`;
        } else if (diffInSeconds < 86400) {
            const hours = Math.floor(diffInSeconds / 3600);
            return `${hours} saat önce`;
        } else {
            const days = Math.floor(diffInSeconds / 86400);
            if (days === 1) return 'Dün';
            if (days < 7) return `${days} gün önce`;
            return date.toLocaleDateString('tr-TR');
        }
    }

    getActionIcon(action) {
        if (!action) return 'fa-circle';
        
        const actionLower = action.toLowerCase();
        if (actionLower.includes('öğrenci') || actionLower.includes('student')) return 'fa-user-plus';
        if (actionLower.includes('ödeme') || actionLower.includes('payment')) return 'fa-credit-card';
        if (actionLower.includes('antrenman') || actionLower.includes('training')) return 'fa-dumbbell';
        if (actionLower.includes('ekipman') || actionLower.includes('equipment')) return 'fa-tshirt';
        if (actionLower.includes('giriş') || actionLower.includes('login')) return 'fa-sign-in-alt';
        if (actionLower.includes('çıkış') || actionLower.includes('logout')) return 'fa-sign-out-alt';
        if (actionLower.includes('create')) return 'fa-plus';
        if (actionLower.includes('update')) return 'fa-edit';
        if (actionLower.includes('delete')) return 'fa-trash';
        if (actionLower.includes('view')) return 'fa-eye';
        return 'fa-circle';
    }

    formatActivityAction(action) {
        if (!action) return 'Sistem aktivitesi';
        
        // Convert English actions to Turkish
        const translations = {
            'create': 'oluşturuldu',
            'update': 'güncellendi', 
            'delete': 'silindi',
            'view': 'görüntülendi',
            'login': 'giriş yapıldı',
            'logout': 'çıkış yapıldı',
            'student': 'öğrenci',
            'payment': 'ödeme',
            'training': 'antrenman',
            'equipment': 'ekipman'
        };
        
        let formatted = action;
        Object.keys(translations).forEach(key => {
            formatted = formatted.replace(new RegExp(key, 'gi'), translations[key]);
        });
        
        return formatted.charAt(0).toUpperCase() + formatted.slice(1);
    }

    formatDetailedActivityAction(activity) {
        if (!activity) return 'Sistem aktivitesi';
        
        // Use description field if available (this is the main field in activity_logs table)
        if (activity.description) {
            // Fix legacy "Ödeme Ödeme Kaydı" entries
            let desc = activity.description;
            if (desc.includes('Ödeme Ödeme Kaydı')) {
                desc = desc.replace('Ödeme Ödeme Kaydı', 'Ödeme Alındı');
            }
            return desc;
        }
        
        // Fallback to action field processing
        const action = (activity.action || '').toLowerCase();
        const entityType = (activity.entity_type || '').toLowerCase();
        
        // Helpers for payment messages
        const studentName = (
            activity.student_name || activity.student || activity.student_full_name ||
            activity.studentName || activity.studentFullName || activity.student_fullname ||
            (activity.meta && (activity.meta.student_name || activity.meta.student)) ||
            ''
        );
        const amountRaw = (
            activity.amount || activity.payment_amount || (activity.meta && activity.meta.amount) || ''
        );
        const amountStr = amountRaw ? this.formatCurrencyTRY(amountRaw).replace('TRY', 'TL') : '';

        if (entityType.includes('payment')) {
            if (action.includes('payment') || action.includes('pay') || action.includes('receive')) {
                // Ödeme Kaydı Alındı
                if (studentName && amountStr) return `${studentName} için ${amountStr} tutarında ödeme alındı`;
                if (studentName) return `${studentName} için ödeme alındı`;
                if (amountStr) return `Öğrenci için ${amountStr} tutarında ödeme alındı`;
                return 'Öğrenci için ödeme alındı';
            }
            if (action.includes('create') || action.includes('add')) {
                // Ödeme Eklendi
                if (studentName && amountStr) return `${studentName} için ${amountStr} tutarında ödeme eklendi`;
                if (studentName) return `${studentName} için ödeme eklendi`;
                if (amountStr) return `Öğrenci için ${amountStr} tutarında ödeme eklendi`;
                return 'Öğrenci için ödeme eklendi';
            }
            if (action.includes('unpay') || action.includes('revert')) {
                if (studentName && amountStr) return `${studentName} için ${amountStr} tutarındaki ödeme geri alındı`;
                if (studentName) return `${studentName} için ödeme geri alındı`;
                return 'Ödeme geri alındı';
            }
        }

        // Create meaningful descriptions based on action and entity type
        if (action.includes('create')) {
            if (entityType.includes('student')) return 'Öğrenci kaydı oluşturuldu';
            if (entityType.includes('training')) return 'Antrenman oluşturuldu';
            if (entityType.includes('equipment')) return 'Ekipman kaydı oluşturuldu';
            if (entityType.includes('equipment')) return 'Ekipman ataması yapıldı';
            return 'Yeni kayıt oluşturuldu';
        }
        
        if (action.includes('update')) {
            if (entityType.includes('student')) return 'Öğrenci bilgileri güncellendi';
            if (entityType.includes('payment')) return 'Ödeme durumu güncellendi';
            if (entityType.includes('training')) return 'Antrenman bilgileri güncellendi';
            return 'Kayıt güncellendi';
        }
        
        if (action.includes('delete')) {
            if (entityType.includes('student')) return 'Öğrenci kaydı silindi';
            if (entityType.includes('payment')) return 'Ödeme kaydı silindi';
            if (entityType.includes('training')) return 'Antrenman seansı silindi';
            return 'Kayıt silindi';
        }
        
        if (action.includes('view')) {
            if (entityType.includes('student')) return 'Öğrenci detayları görüntülendi';
            return 'Kayıt görüntülendi';
        }
        
        if (action.includes('login')) {
            return 'Sisteme giriş yapıldı';
            
        }
        
        if (action.includes('logout')) {
            return 'Sistemden çıkış yapıldı';
        }
        
        // Default fallback
        return activity.action || 'Sistem aktivitesi';
    }

    // Basit, kullanıcı dostu etiket üretir
    simplifyActivityLabel(activity) {
        if (!activity) return 'Sistem aktivitesi';
        const action = (activity.action || '').toLowerCase();
        const entity = (activity.entity_type || '').toLowerCase();
        const desc = (activity.description || '').toLowerCase();

        // Login/Logout hariç
        if (action.includes('login') || action.includes('logout') || desc.includes('giriş') || desc.includes('çıkış')) {
            return null;
        }

        // Öğrenci
        if ((action.includes('create') && entity.includes('student')) || desc.includes('öğrenci eklendi')) {
            return 'Yeni öğrenci eklendi';
        }
        if (action.includes('delete') && entity.includes('student')) {
            return 'Öğrenci silindi';
        }

        // Antrenman
        if ((action.includes('create') && entity.includes('training')) || desc.includes('antrenman oluşturuldu')) {
            return 'Antrenman oluşturuldu';
        }

        // Ödeme
        if (
            desc.includes('ödeme alındı') ||
            (entity.includes('payment') && (action.includes('create') || action.includes('update')))
        ) {
            return 'Ödeme alındı';
        }

        // Ekipman atanması
        if (
            entity.includes('equipment') || entity.includes('equipment_assignment') ||
            desc.includes('ekipman atan') || action.includes('assign')
        ) {
            return 'Ekipman atandı';
        }

        // Genel fallback: entity + action çevirileri
        const entityTr = this.translateEntity(entity);
        const verbTr = this.translateVerb(action);
        if (entityTr && verbTr) {
            return `${entityTr} ${verbTr}`;
        }

        // Diğerleri için daha açıklayıcı mevcut fonksiyona düş
        return this.formatDetailedActivityAction(activity);
    }

    translateEntity(entity) {
        if (!entity) return null;
        const e = entity.toLowerCase();
        if (e.includes('student')) return 'Öğrenci';
        if (e.includes('payment')) return 'Ödeme';
        if (e.includes('training')) return 'Antrenman';
        if (e.includes('equipment')) return 'Ekipman';
        if (e.includes('equipment_assignment')) return 'Ekipman';
        return null;
    }

    translateVerb(action) {
        if (!action) return null;
        const a = action.toLowerCase();
        if (a.includes('create') || a.includes('add') || a.includes('assign')) return 'oluşturuldu';
        if (a.includes('update')) return 'güncellendi';
        if (a.includes('delete') || a.includes('remove')) return 'silindi';
        if (a.includes('assign')) return 'atandı';
        return null;
    }
    
    extractNameFromDetails(details) {
        if (!details) return null;
        
        // Try to extract name patterns
        const nameMatch = details.match(/(?:name|ad|isim):\s*([^,\n]+)/i);
        if (nameMatch) return nameMatch[1].trim();
        
        // Try to extract from student ID or other patterns
        const studentMatch = details.match(/student[_\s]*(?:name|ad):\s*([^,\n]+)/i);
        if (studentMatch) return studentMatch[1].trim();
        
        return null;
    }
    
    extractEquipmentFromDetails(details) {
        if (!details) return null;
        
        const equipmentMatch = details.match(/(?:equipment|ekipman):\s*([^,\n]+)/i);
        if (equipmentMatch) return equipmentMatch[1].trim();
        
        return null;
    }
    
    extractAmountFromDetails(details) {
        if (!details) return null;
        
        const amountMatch = details.match(/(?:amount|tutar|miktar):\s*(\d+)/i);
        if (amountMatch) return amountMatch[1];
        
        return null;
    }
    
    extractTrainingFromDetails(details) {
        if (!details) return null;
        
        const trainingMatch = details.match(/(?:training|antrenman):\s*([^,\n]+)/i);
        if (trainingMatch) return trainingMatch[1].trim();
        
        return null;
    }

    async loadWeeklyTrainings() {
        const ctx = document.getElementById('weeklyTrainingsChart');
        if (!ctx) return;
    
        try {
            const result = await supabaseService.getTrainings();
            
            // Veri dizilerini ve sayaçları sıfırla
            const days = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
            const trainingsPerDay = new Array(7).fill(0);
            const sportsPerDay = Array(7).fill(null).map(() => ({}));
            let totalWeeklyTrainings = 0;
            let totalWeeklyTrainingCount = 0;
    
            if (result.success && result.data && result.data.length > 0) {
                const today = new Date();
                const startOfWeek = new Date(today);
                // Haftanın başlangıcını Pazartesi olarak ayarla
                startOfWeek.setDate(today.getDate() - (today.getDay() === 0 ? 6 : today.getDay() - 1));
                startOfWeek.setHours(0, 0, 0, 0);
    
                const endOfWeek = new Date(startOfWeek);
                endOfWeek.setDate(startOfWeek.getDate() + 6);
                endOfWeek.setHours(23, 59, 59, 999);
    
                // Sadece bu haftaya ait antrenmanları filtrele
                const weeklyTrainings = result.data.filter(t => {
                    const trainingDate = new Date(t.date);
                    return trainingDate >= startOfWeek && trainingDate <= endOfWeek;
                });
    
                totalWeeklyTrainingCount = weeklyTrainings.length;
    
                // Filtrelenmiş antrenmanlar üzerinden döngü kur
                weeklyTrainings.forEach(training => {
                    const trainingDate = new Date(training.date);
                    const dayIndex = (trainingDate.getDay() + 6) % 7; // Pazartesi = 0, Pazar = 6
    
                    let durationHours = 1; // Saat bilgisi yoksa varsayılan 1 saat
                    if (training.start_time && training.end_time) {
                        const startParts = training.start_time.split(':');
                        const endParts = training.end_time.split(':');
                        if (startParts.length >= 2 && endParts.length >= 2) {
                            const startTime = new Date(0, 0, 0, parseInt(startParts[0]), parseInt(startParts[1]));
                            const endTime = new Date(0, 0, 0, parseInt(endParts[0]), parseInt(endParts[1]));
                            const durationMs = endTime.getTime() - startTime.getTime();
                            if (durationMs > 0) {
                                durationHours = durationMs / (1000 * 60 * 60);
                            }
                        }
                    }
                    
                    // Hesaplanan süreyi doğru dizilere ekle
                    trainingsPerDay[dayIndex] += durationHours;
                    totalWeeklyTrainings += durationHours;
    
                    const sport = training.sport || 'Diğer';
                    sportsPerDay[dayIndex][sport] = (sportsPerDay[dayIndex][sport] || 0) + durationHours;
                });
            }
    
            // Grafik başlığındaki antrenman sayısını güncelle
            const weeklyTrainingsCountEl = document.getElementById('weeklyTrainingsCount');
            if (weeklyTrainingsCountEl) {
                weeklyTrainingsCountEl.textContent = totalWeeklyTrainingCount;
            }
    
            // Her gün için dominant sporu bul
            const dominantSportPerDay = sportsPerDay.map(dayData => {
                let dominantSport = null;
                let maxDuration = 0;
                for (const sport in dayData) {
                    if (dayData[sport] > maxDuration) {
                        maxDuration = dayData[sport];
                        dominantSport = sport;
                    }
                }
                return dominantSport;
            });
    
            // Mevcut bir grafik varsa önce onu yok et
            if (this.weeklyTrainingsChart) {
                this.weeklyTrainingsChart.destroy();
            }

            // Y ekseni maksimumunu belirle: varsayılan ~4 saat (küçük rastgelelik ile), eğer günlerden biri 4 saati aşıyorsa ona göre arttır
            const maxDayDuration = trainingsPerDay.length ? Math.max(...trainingsPerDay) : 0;
            const baseFourRandom = 4 + Math.random() * 0.5; // 4 - 4.5 saat arasında hafif rastgelelik
            const yAxisMax = maxDayDuration > 4 ? Math.ceil(maxDayDuration + 0.5) : baseFourRandom;

            // Grafiği oluştur
            this.weeklyTrainingsChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: days,
                    datasets: [{
                        label: 'Toplam Antrenman Saati',
                        data: trainingsPerDay.map(count => count === 0 ? 0.4 : count), // Boş günler için küçük bir değer ata
                        backgroundColor: trainingsPerDay.map((count, index) => {
                            if (count === 0) return '#6b7280';
                            const sport = dominantSportPerDay[index];
                            return this.sportColorMap[sport] || '#6B7280';
                        }),
                        borderColor: trainingsPerDay.map((count, index) => {
                            if (count === 0) return '#D1D5DB';
                            const sport = dominantSportPerDay[index];
                            return this.sportColorMap[sport] || '#6B7280';
                        }),
                        borderWidth: 1,
                        borderRadius: 6,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            suggestedMax: yAxisMax,
                            ticks: {
                                callback: value => `${value} saat`,
                                stepSize: 1
                            },
                            grid: {
                                color: '#F3F4F6'
                            }
                        }
                    },
                        x: {
                            ticks: {
                                font: {
                                    weight: 'bold', // Yazı tipini kalın yap
                                    family: "'Inter', sans-serif" // Daha modern bir font (isteğe bağlı)
                                }
                            },
                            grid: {
                                display: false // X eksenindeki çizgileri kaldır
                            }
                    },
                    plugins: {
                        legend: {
                            display: false
                        },
                        tooltip: {
                            callbacks: {
                                x: {
                                    ticks: {
                                        font: {
                                            weight: 'bold', // Yazı tipini kalın yap
                                            family: "'Inter', sans-serif" // Daha modern bir font (isteğe bağlı)
                                        }
                                    },
                                    grid: {
                                        display: false // X eksenindeki çizgileri kaldır
                                    }
                                }
                            }
                        }
                    }
                }
            });
        } catch (error) {
            console.error('Haftalık antrenman grafiği yüklenirken hata:', error);
            const ctx = document.getElementById('weeklyTrainingsChart');
            if (ctx) {
                ctx.parentElement.innerHTML = '<div class="error-message">Grafik yüklenemedi.</div>';
            }
        }
    }

    async loadStudentDistribution() {
        try {
            const result = await supabaseService.getStudents();
            if (!result.success || !result.data) {
                throw new Error('Öğrenci verileri alınamadı.');
            }
    
            const students = result.data;
            const distribution = {};
    
            // Öğrencileri spor branşına göre say
            students.forEach(student => {
                // GÜVENLİK: Obje olabilecek sport değerini kontrol et
                const branchName = this.getSportText(student.sport) || 'Branş Atanmamış';
                distribution[branchName] = (distribution[branchName] || 0) + 1;
            });
    
            const labels = Object.keys(distribution);
            const data = Object.values(distribution);
            
            // Renkleri global haritamızdan al
            const backgroundColors = labels.map(label => this.sportColorMap[label] || '#6B7280');
    
            const ctx = document.getElementById('studentDistributionChart').getContext('2d');
            if (this.studentDistributionChart) {
                this.studentDistributionChart.destroy();
            }
    
            this.studentDistributionChart = new Chart(ctx, {
                type: this.currentChartType === 'bar' ? 'bar' : 'pie', // Kullanıcı isterse diye bar seçeneğini koruyalım
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Öğrenci Sayısı',
                        data: data,
                        backgroundColor: backgroundColors,
                        borderColor: '#fff',
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                        },
                        title: {
                            display: false
                        }
                    }
                }
            });
        } catch (error) {
            console.error('Öğrenci dağılım grafiği yüklenirken hata:', error);
        }
    }
    async loadGenderDistribution() {
        console.log('🚺 loadGenderDistribution başladı'); // DEBUG EKLEYİN
        try {
            const result = await supabaseService.getStudents();
            console.log('👥 Cinsiyet için öğrenci verisi:', result); // DEBUG EKLEYİN
            if (!result.success || !result.data) {
                throw new Error('Öğrenci verileri alınamadı.');
            }
    
            const students = result.data;
            const genderCounts = { 'Erkek': 0, 'Kadın': 0 };
    
            students.forEach(student => {
                console.log('👤 Öğrenci cinsiyeti:', student.name, student.gender); // DEBUG EKLEYİN
                if (student.gender && (student.gender === 'Erkek' || student.gender === 'Kadın')) {
                    genderCounts[student.gender]++;
                }
            });
            console.log('📊 Cinsiyet sayıları:', genderCounts); // DEBUG EKLEYİN
            const labels = Object.keys(genderCounts);
            const data = Object.values(genderCounts);
            const backgroundColors = ['#3B82F6', '#EC4899']; // Erkek için Mavi, Kadın için Pembe
    
            const ctx = document.getElementById('studentDistributionChart').getContext('2d');
            if (this.studentDistributionChart) {
                this.studentDistributionChart.destroy();
            }
    
            this.studentDistributionChart = new Chart(ctx, {
                type: 'pie', // Cinsiyet için pasta grafik en iyisi
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Öğrenci Sayısı',
                        data: data,
                        backgroundColor: backgroundColors,
                        borderColor: '#fff',
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                        }
                    }
                }
            });
        } catch (error) {
            console.error('Cinsiyet dağılım grafiği yüklenirken hata:', error);
        }
    }

    async loadStudentsScreen() {
        try {
            // PERFORMANS: Cache'den önce kontrol et (sadece gerektiğinde temizle)
            const cacheKey = 'students_list';
            let cachedStudents = this.getCachedData(cacheKey);
            
            if (cachedStudents) {
                console.log('🚀 Students loaded from cache');
                this.students = cachedStudents;
                await this.loadStudentTabs();
                this.setupStudentSearchBar();
                this._currentStudentSport = 'all';
                this._studentSearchQuery = '';
                this.applyStudentFilters();
                return;
            }

            // Cache'de yoksa API'den çek
            const result = await supabaseService.getStudents();
            if (result.success) {
                this.students = result.data || [];
                // PERFORMANS: Cache'e kaydet
                this.setCachedData(cacheKey, this.students);
                
                await this.loadStudentTabs();
                this.setupStudentSearchBar();
                this._currentStudentSport = 'all';
                this._studentSearchQuery = '';
                this.applyStudentFilters();
            } else {
                console.error('Error loading students:', result.error);
                this.displayStudents([]);
            }
        } catch (error) {
            console.error('Error loading students screen:', error);
            this.displayStudents([]);
        }
    }
    async loadStudentTabs() {
               
        try {
            // Get sport branches from Supabase
            const result = await supabaseService.getSportBranches();
            const tabsContainer = document.getElementById('studentTabs');
            
            if (!tabsContainer) {
                console.error('Student tabs container not found');
                return;
            }
            
            if (result.success && result.data && result.data.length > 0) {
                const sportBranches = result.data;
                
                // Create tabs HTML
                let tabsHTML = `
                <div style="display: flex; gap: 8px; margin-bottom: 25px; background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); padding: 8px; border-radius: 16px; box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.06); border: 1px solid #e2e8f0; flex-wrap: wrap;">
                    <button class="tab-btn active" data-sport="all" style="
                        padding: 12px 24px;
                        background: linear-gradient(135deg, #DC2626 0%, #B91C1C 100%);
                        color: white;
                        border: 1px solid #B91C1C;
                        border-radius: 12px;
                        cursor: pointer;
                        font-weight: 600;
                        font-size: 14px;
                        transition: all 0.3s;
                        box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);
                        white-space: nowrap;
                    ">
                        Tümü
                    </button>
            `;
                
                sportBranches.forEach(branch => {
                    const studentCount = this.students ? 
                    this.students.filter(s => {
                        if (s.is_deleted) return false;
                        // GÜVENLİK: Obje olabilecek sport değerini kontrol et
                        const sportText = this.getSportText(s.sport);
                        return sportText === branch.name;
                    }).length : 0;
                    
                        tabsHTML += `
                        <button class="tab-btn" data-sport="${branch.name}" style="
                            padding: 12px 24px;
                            background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%);
                            color: #475569;
                            border: 1px solid #e2e8f0;
                            border-radius: 12px;
                            cursor: pointer;
                            font-weight: 600;
                            font-size: 14px;
                            transition: all 0.3s;
                            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
                        ">
                            ${branch.name}
                        </button>
                    `;
                });
                
                // Add deleted students tab
                const deletedCount = this.students ? this.students.filter(s => s.is_deleted).length : 0;
                tabsHTML += `
                <button class="tab-btn" data-sport="deleted" style="
                    padding: 12px 24px;
                    background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%);
                    color: #475569;
                    border: 1px solid #e2e8f0;
                    border-radius: 12px;
                    cursor: pointer;
                    font-weight: 600;
                    font-size: 14px;
                    transition: all 0.3s;
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
                    white-space: nowrap;
                ">
                     <i class="fas fa-user-times" style="margin-right: 6px;"></i>
                    Silinen Öğrenciler (${deletedCount})
                </button>
                `;
                
                tabsHTML += `</div>`;
                
                tabsContainer.innerHTML = tabsHTML;
                
                // Add click event listeners to tabs
                tabsContainer.querySelectorAll('.tab-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        // Update active tab
                        tabsContainer.querySelectorAll('.tab-btn').forEach(b => {
                            b.style.background = '#f8f9fa';
                            b.style.color = '#6c757d';
                            b.classList.remove('active');
                        });
                        
                        // Style the clicked tab
                        e.target.style.background = '#dc2626';
                        e.target.style.color = 'white';
                        e.target.classList.add('active');
                        
                        // Filter students
                        const sport = e.target.getAttribute('data-sport');
                        this.filterStudentsBySport(sport);
                    });
                });
                
            } else {
                tabsContainer.innerHTML = `
                    <div style="display: flex; gap: 0; margin-bottom: 24px; flex-wrap: wrap; border-bottom: 1px solid #e5e7eb;">
                        <button class="tab-btn active" data-sport="all" style="
                            padding: 12px 20px;
                            border: none;
                            background: #dc2626;
                            color: white;
                            cursor: pointer;
                            border-radius: 6px 6px 0 0;
                            font-weight: 500;
                            font-size: 14px;
                            margin-bottom: -1px;
                        ">
                            Tümü
                        </button>
                        <button class="tab-btn" data-sport="deleted" style="
                            padding: 12px 20px;
                            border: none;
                            background: #f8f9fa;
                            color: #6c757d;
                            cursor: pointer;
                            border-radius: 6px 6px 0 0;
                            font-weight: 500;
                            font-size: 14px;
                            margin-bottom: -1px;
                            margin-left: 2px;
                        ">
                            Silinen Öğrenciler
                        </button>
                    </div>
                `;
            }
        } catch (error) {
            console.error('Error loading student tabs:', error);
        }
    }
    
    filterStudentsBySport(sport) {
        this._currentStudentSport = sport || 'all';
        this.applyStudentFilters();
    }

    // Right-aligned search next to student tabs
    setupStudentSearchBar() {
        try {
            const tabsContainer = document.getElementById('studentTabs');
            if (!tabsContainer) return;
            // Do not force extra container styles to avoid double rounded backgrounds
            let wrapper = tabsContainer.firstElementChild;
            if (!wrapper) {
                // Tabs may not be in DOM yet; retry shortly
                setTimeout(() => this.setupStudentSearchBar(), 120);
                return;
            }
            wrapper.style.display = 'flex';
            wrapper.style.flexWrap = 'wrap';
            wrapper.style.alignItems = 'center';
            wrapper.style.gap = '8px';

            // Ensure a dedicated scroll container exists for tab buttons
            let tabsScroll = wrapper.querySelector('.student-tabs-scroll');
            if (!tabsScroll) {
                tabsScroll = document.createElement('div');
                tabsScroll.className = 'student-tabs-scroll';
                // On desktop: flex:1, width:auto so search can sit on the right. On mobile we switch to 100% via media.
                tabsScroll.style.cssText = 'display:flex; gap:8px; flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch; flex:1 1 auto; min-width:0; width:auto;';

                // Move existing tab buttons into the scroll container (keep order)
                const buttons = Array.from(wrapper.querySelectorAll('button.tab-btn'));
                if (buttons.length) {
                    // Insert tabsScroll before the first tab button
                    wrapper.insertBefore(tabsScroll, buttons[0]);
                    buttons.forEach(btn => tabsScroll.appendChild(btn));
                } else {
                    // If buttons not yet present, retry shortly
                    setTimeout(() => this.setupStudentSearchBar(), 120);
                }
            }
            // right area
            let rightBar = document.getElementById('studentTabsRightBar');
            if (!rightBar) {
                rightBar = document.createElement('div');
                rightBar.id = 'studentTabsRightBar';
                rightBar.style.cssText = 'margin-left:auto; display:flex; align-items:center; gap:8px; position:relative;';
                wrapper.appendChild(rightBar);
            }
            let input = document.getElementById('studentSearchInput');
            if (!input) {
                // GÜVENLİK: Accessibility için label ekle
                const label = document.createElement('label');
                label.htmlFor = 'studentSearchInput';
                label.textContent = 'Öğrenci Arama';
                label.style.cssText = 'position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden;'; // Screen reader için gizli label
                
                input = document.createElement('input');
                input.id = 'studentSearchInput';
                input.type = 'search';
                input.placeholder = 'Ara: ad, soyad, branş...';
                input.setAttribute('aria-label', 'Öğrenci arama'); // Accessibility için
                // Match payments: icon on the left, 36px left padding, 10px vertical padding, radius 10
                input.style.cssText = 'max-width:360px; width:100%; padding:10px 12px 10px 36px; border:1px solid #e5e7eb; border-radius:10px; background: white; font-size: 14px; color: #111827;';
                // Add search icon like payments
                const icon = document.createElement('i');
                icon.className = 'fas fa-search';
                icon.style.cssText = 'position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #9CA3AF;';
                
                rightBar.appendChild(label);
                rightBar.appendChild(icon);
                rightBar.appendChild(input);
                const mq = window.matchMedia('(max-width: 640px)');
                const applyMobile = () => {
                    input.style.maxWidth = mq.matches ? '100%' : '360px';
                    rightBar.style.width = mq.matches ? '100%' : 'auto';
                    rightBar.style.marginLeft = mq.matches ? '0' : 'auto';
                    // On mobile, keep the tabs scroll container visible width
                    if (tabsScroll) {
                        tabsScroll.style.width = mq.matches ? '100%' : 'auto';
                        tabsScroll.style.flex = mq.matches ? '0 0 auto' : '1 1 auto';
                    }
                };
                applyMobile();
                mq.addEventListener('change', applyMobile);
                // PERFORMANS: Optimize edilmiş debounced search
                const debouncedSearch = this.debounce((query) => {
                    this._studentSearchQuery = query.toLowerCase();
                    this.applyStudentFilters();
                }, 200); // 200ms debounce
                
                input.addEventListener('input', (e) => {
                    const query = e.target.value || '';
                    // Boş query için hemen filtrele
                    if (query.length === 0) {
                        this._studentSearchQuery = '';
                        this.applyStudentFilters();
                        return;
                    }
                    // Diğer durumlarda debounce kullan
                    debouncedSearch(query);
                });
            }
        } catch (e) { console.warn('setupStudentSearchBar error:', e); }
    }

    applyStudentFilters() {
        if (!Array.isArray(this.students)) { this.displayStudents([]); return; }
        const sport = this._currentStudentSport || 'all';
        const q = (this._studentSearchQuery || '').toLowerCase().trim();
        let base = [];
        if (sport === 'all') base = this.students.filter(s => !s.is_deleted);
        else if (sport === 'deleted') base = this.students.filter(s => s.is_deleted);
        else base = this.students.filter(s => {
            if (s.is_deleted) return false;
            // GÜVENLİK: Obje olabilecek sport değerini kontrol et
            const sportText = this.getSportText(s.sport);
            return sportText === sport;
        });
        let filtered = base;
        if (q) {
            filtered = base.filter(s => {
                const name = ((s.name || '') + ' ' + (s.surname || '')).toLowerCase();
                // GÜVENLİK: Obje olabilecek sport değerini kontrol et
                const sportName = this.getSportText(s.sport).toLowerCase();
                const phone = (s.phone || '').toLowerCase();
                const tc = (s.tcno || s.tc_no || '').toString().toLowerCase();
                return name.includes(q) || sportName.includes(q) || phone.includes(q) || tc.includes(q);
            });
        }
        this.displayStudents(filtered);
    }

    // Equipment tabs global search
    setupEquipmentTabsSearchBar() {
        try {
            const input = document.getElementById('equipmentGlobalSearchInput');
            if (!input) return;
            input.addEventListener('input', () => {
                clearTimeout(this._equipmentGlobalSearchDebounce);
                this._equipmentGlobalSearchDebounce = setTimeout(() => {
                    this._equipmentGlobalSearchQuery = (input.value || '').toLowerCase();
                    this.applyEquipmentTabSearch();
                }, 150);
            });
        } catch (e) { console.warn('setupEquipmentTabsSearchBar error:', e); }
    }

    applyEquipmentTabSearch() {
        const q = (this._equipmentGlobalSearchQuery || '').trim().toLowerCase();
        switch (this.currentEquipmentTab) {
            case 'assignment':
                this.filterStudentsForEquipment(q);
                break;
            default:
                // Generic DOM filter on current tab content
                const container = document.getElementById('mainEquipmentTabContent');
                if (!container) return;
                if (!q) {
                    // reload tab content to reset
                    this.switchEquipmentTab(this.currentEquipmentTab);
                    return;
                }
                Array.from(container.children).forEach(node => {
                    const text = (node.textContent || '').toLowerCase();
                    node.style.display = text.includes(q) ? '' : 'none';
                });
        }
    }

    displayStudents(students) {
        const container = document.getElementById('studentsList');
        if (!container) {
            console.error('Students container not found');
            return;
        }



        if (!students || students.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #6b7280;">
                    <i class="fas fa-users" style="font-size: 48px; margin-bottom: 16px;"></i>
                    <p>Henüz öğrenci kaydı bulunmuyor.</p>
                </div>
            `;
            return;
        }

        // PERFORMANS: Lazy loading - büyük listeler için batch rendering
        const BATCH_SIZE = 20;
        const totalStudents = students.length;
        
        if (totalStudents > BATCH_SIZE) {
            this.renderStudentsBatch(students, container, 0, BATCH_SIZE);
        } else {
            this.renderAllStudents(students, container);
        }
    }

    renderAllStudents(students, container) {
        // PERFORMANS: DocumentFragment kullanarak DOM manipulasyonunu optimize et
        const fragment = document.createDocumentFragment();
        
        // Create cards using DOM manipulation instead of innerHTML
        students.forEach(student => {
            const age = this.calculateAge(student.birth_date || student.birthDate);
            const photoUrl = student.photo_thumb_url || student.photo_url || student.photo;
            const paymentStatus = student.payment_status || student.paymentStatus || 'pending';
            const statusText = paymentStatus === 'paid' ? 'Ödendi' : 'Bekliyor';
            const statusColor = paymentStatus === 'paid' ? '#10b981' : '#f59e0b';
            
            // Create card element
            const cardDiv = document.createElement('div');
            cardDiv.className = 'student-card';
            cardDiv.setAttribute('data-student-id', student.id);
            cardDiv.style.cssText = `
                background: white;
                border-radius: 12px;
                padding: 16px;
                margin-bottom: 12px;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
                border: 1px solid #e5e7eb;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 16px;
                position: relative;
                transform: none;
                transition: none;
            `;
            
            // Create photo div
            const photoDiv = document.createElement('div');
            photoDiv.style.cssText = `
                width: 50px;
                height: 50px;
                border-radius: 50%;
                background: ${(student.photo_thumb_url || student.photo_url) ? '#f3f4f6' : 'linear-gradient(135deg, #5b73e8, #4f46e5)'};
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                font-size: 20px;
                overflow: hidden;
                flex-shrink: 0;
            `;
            
            if (photoUrl) {
                const img = document.createElement('img');
                img.src = photoUrl;
                img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
                photoDiv.appendChild(img);
            } else {
                const icon = document.createElement('i');
                icon.className = 'fas fa-user';
                photoDiv.appendChild(icon);
            }
            
            // Create info div
            const infoDiv = document.createElement('div');
            infoDiv.style.cssText = 'flex: 1; min-width: 0;';
            
            const nameH3 = document.createElement('h3');
            nameH3.style.cssText = 'margin: 0 0 4px 0; color: #111827; font-size: 16px; font-weight: 600;';
            nameH3.textContent = `${student.name || ''} ${student.surname || ''}`.trim();
            
            const phoneDiv = document.createElement('div');
            phoneDiv.style.cssText = 'color: #6b7280; font-size: 14px; margin-bottom: 2px;';
            phoneDiv.textContent = student.phone || '-';
            
            infoDiv.appendChild(nameH3);
            infoDiv.appendChild(phoneDiv);
            
            // Create right info div
            const rightDiv = document.createElement('div');
            rightDiv.style.cssText = 'text-align: right; flex-shrink: 0;';
            
            const ageDiv = document.createElement('div');
            ageDiv.style.cssText = 'color: #111827; font-size: 14px; font-weight: 500; margin-bottom: 2px;';
            ageDiv.textContent = (age !== null && age !== undefined) ? (age + ' yaş') : '-';
            
            const sportDiv = document.createElement('div');
            sportDiv.style.cssText = 'color: #6b7280; font-size: 14px; margin-bottom: 4px;';
            // GÜVENLİK: Obje olabilecek değerleri string'e çevir
            sportDiv.textContent = this.getSportText(student.sport);
            
            const statusSpan = document.createElement('span');
            statusSpan.style.cssText = `
                background: ${statusColor};
                color: white;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 12px;
                font-weight: 500;
            `;
            statusSpan.textContent = statusText;
            
            rightDiv.appendChild(ageDiv);
            rightDiv.appendChild(sportDiv);
            rightDiv.appendChild(statusSpan);
            
            // Assemble card
            cardDiv.appendChild(photoDiv);
            cardDiv.appendChild(infoDiv);
            cardDiv.appendChild(rightDiv);
            
            // Add click handler directly to the card
            cardDiv.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.showStudentDetailModal(student.id);
            });
            
            // PERFORMANS: Fragment'e ekle, container'a değil
            fragment.appendChild(cardDiv);
        });
        
        // PERFORMANS: Tek seferde tüm fragment'i container'a ekle
        container.innerHTML = ''; // Clear first
        container.appendChild(fragment);
    }

    renderStudentsBatch(students, container, startIndex, batchSize) {
        // PERFORMANS: Batch rendering for large lists
        const endIndex = Math.min(startIndex + batchSize, students.length);
        const batch = students.slice(startIndex, endIndex);
        
        if (startIndex === 0) {
            container.innerHTML = ''; // Clear only on first batch
        }
        
        const fragment = document.createDocumentFragment();
        
        batch.forEach(student => {
            const cardDiv = this.createStudentCard(student);
            fragment.appendChild(cardDiv);
        });
        
        container.appendChild(fragment);
        
        // Eğer daha fazla öğrenci varsa, "Daha Fazla Yükle" butonu ekle
        if (endIndex < students.length) {
            const loadMoreBtn = document.createElement('div');
            loadMoreBtn.style.cssText = `
                text-align: center;
                padding: 20px;
                margin: 20px 0;
            `;
            loadMoreBtn.innerHTML = `
                <button id="loadMoreStudents" style="
                    background: linear-gradient(135deg, #dc2626, #b91c1c);
                    color: white;
                    border: none;
                    padding: 12px 24px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin: 0 auto;
                ">
                    <i class="fas fa-plus"></i>
                    Daha Fazla Yükle (${students.length - endIndex} kalan)
                </button>
            `;
            
            container.appendChild(loadMoreBtn);
            
            // Load more button event listener
            const btn = loadMoreBtn.querySelector('#loadMoreStudents');
            btn.addEventListener('click', () => {
                loadMoreBtn.remove(); // Remove the button
                this.renderStudentsBatch(students, container, endIndex, batchSize);
            });
        }
    }

    createStudentCard(student) {
        const age = this.calculateAge(student.birth_date || student.birthDate);
        const photoUrl = student.photo_thumb_url || student.photo_url || student.photo;
        const paymentStatus = student.payment_status || student.paymentStatus || 'pending';
        const statusText = paymentStatus === 'paid' ? 'Ödendi' : 'Bekliyor';
        const statusColor = paymentStatus === 'paid' ? '#10b981' : '#f59e0b';
        
        // Create card element
        const cardDiv = document.createElement('div');
        cardDiv.className = 'student-card';
        cardDiv.setAttribute('data-student-id', student.id);
        cardDiv.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 12px;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
            border: 1px solid #e5e7eb;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 16px;
            position: relative;
            transform: none;
            transition: none;
        `;
        
        // Create photo div
        const photoDiv = document.createElement('div');
        photoDiv.style.cssText = `
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: ${photoUrl ? `url('${photoUrl}') center/cover` : 'linear-gradient(135deg, #dc2626, #b91c1c)'};
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 18px;
            flex-shrink: 0;
        `;
        
        if (!photoUrl) {
            const initials = `${(student.name || student.first_name || 'S').charAt(0)}${(student.surname || student.last_name || 'T').charAt(0)}`;
            photoDiv.textContent = initials;
        }
        
        // Create info div
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'flex: 1; min-width: 0;';
        
        const nameDiv = document.createElement('div');
        nameDiv.style.cssText = 'font-weight: 600; color: #1f2937; font-size: 16px; margin-bottom: 4px;';
        nameDiv.textContent = `${student.name || student.first_name || ''} ${student.surname || student.last_name || ''}`.trim();
        
        const detailsDiv = document.createElement('div');
        detailsDiv.style.cssText = 'color: #6b7280; font-size: 14px; display: flex; flex-wrap: wrap; gap: 12px;';
        
        // GÜVENLİK: innerHTML yerine güvenli DOM oluşturma + Obje kontrolü
        const sportText = this.getSportText(student.sport);
            
        const sportSpan = this.createSafeElement('span', {}, [
            this.createSafeElement('i', { class: 'fas fa-running', style: 'margin-right: 4px;' }),
            document.createTextNode(sportText) // textContent zaten güvenli, sanitize gereksiz
        ]);
        
        const ageSpan = this.createSafeElement('span', {}, [
            this.createSafeElement('i', { class: 'fas fa-birthday-cake', style: 'margin-right: 4px;' }),
            document.createTextNode(age ? age + ' yaş' : 'Yaş belirtilmemiş')
        ]);
        
        detailsDiv.appendChild(sportSpan);
        detailsDiv.appendChild(ageSpan);
        
        infoDiv.appendChild(nameDiv);
        infoDiv.appendChild(detailsDiv);
        
        // Create right div (status)
        const rightDiv = document.createElement('div');
        rightDiv.style.cssText = 'text-align: right; flex-shrink: 0;';
        
        const statusDiv = document.createElement('div');
        statusDiv.style.cssText = `
            background: ${statusColor}20;
            color: ${statusColor};
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            display: inline-block;
        `;
        statusDiv.textContent = statusText;
        
        rightDiv.appendChild(statusDiv);
        
        // Assemble card
        cardDiv.appendChild(photoDiv);
        cardDiv.appendChild(infoDiv);
        cardDiv.appendChild(rightDiv);
        
        // Add click handler
        cardDiv.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.showStudentDetailModal(student.id);
        });
        
        return cardDiv;
    }

    calculateAge(birthDate) {
        if (!birthDate) return null;
        
        const birth = new Date(birthDate);
        const today = new Date();
        let age = today.getFullYear() - birth.getFullYear();
        const monthDiff = today.getMonth() - birth.getMonth();
        
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
            age--;
        }
        
        return age;
    }

    async showStudentDetailModal(studentId) {
        // Load fresh data from Supabase
        let student = null;
        try {
            const result = await supabaseService.getStudent(studentId);
            if (result.success) {
                student = result.data;
            } else {
                console.error('Failed to load student from Supabase:', result.error);
                student = this.students?.find(s => s.id === studentId);
            }
        } catch (error) {
            console.error('Error loading student from Supabase:', error);
            student = this.students?.find(s => s.id === studentId);
        }
        
        if (!student) {
            console.error('Student not found:', studentId);
            return;
        }

        const modal = document.getElementById('studentDetailModal');
        if (!modal) {
            console.error('Student detail modal not found');
            return;
        }

        const age = this.calculateAge(student.birth_date || student.birthDate);
        const formatDate = (val) => {
            if (!val) return 'Belirtilmemiş';
            const dt = new Date(val);
            if (isNaN(dt)) return 'Belirtilmemiş';
            return dt.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        };
        const nameSafe = this.escapeHtml(student.name || '');
        const surnameSafe = this.escapeHtml(student.surname || '');
        const tcSafe = this.escapeHtml(student.tc_no || student.tcno || 'Belirtilmemiş');
        const phoneSafe = this.escapeHtml(student.phone || 'Belirtilmemiş');
        const schoolSafe = this.escapeHtml(student.school || 'Belirtilmemiş');
            // GÜVENLİK: Obje olabilecek sport değerini kontrol et
            const sportText = this.getSportText(student.sport);
        const branchSafe = this.escapeHtml(sportText);
        
        // Populate modal with student data
        const modalContent = modal.querySelector('.modal-content');
        if (modalContent) {
            modalContent.innerHTML = `
                <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; padding: 20px; border-bottom: 1px solid #e5e7eb; background: #DC2626; color: white;">
                    <h2 style="margin: 0; color: white;">Öğrenci Detayları</h2>
                    <button onclick="app.hideStudentDetailModal()" title="Öğrenci detayları penceresini kapat" aria-label="Kapat" style="background: none; border: none; font-size: 24px; cursor: pointer; color: white;">×</button>
                </div>
                <div class="modal-body" style="padding: 20px; max-height: 70vh; overflow-y: auto;">
                    <div style="display: flex; gap: 20px; margin-bottom: 20px;">
                        <div style="text-align: center; min-width: 120px;">
                            <div style="
                                width: 80px;
                                height: 80px;
                                border-radius: 50%;
                                background: ${(student.photo_thumb_url || student.photo_url) ? '#f3f4f6' : 'linear-gradient(135deg, #5b73e8, #4f46e5)'};
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                color: white;
                                font-size: 32px;
                                margin: 0 auto 12px;
                                overflow: hidden;
                            ">
                                ${(student.photo_thumb_url || student.photo_url) ? 
                                    `<img src="${student.photo_thumb_url || student.photo_url}" loading="lazy" decoding="async" style="width: 100%; height: 100%; object-fit: cover;">` : 
                                    `<i class="fas fa-user"></i>`
                                }
                            </div>
                            <h3 style="margin: 0; color: #111827; font-size: 18px;">${nameSafe} ${surnameSafe}</h3>
                            <div style="background: #3B82F6; color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px; margin-top: 8px; display: inline-block;">
                                ${branchSafe || 'SPOR BRANŞI'}
                            </div>
                        </div>
                        <div style="flex: 1;">
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                                <div>
                                    <label style="display: block; font-weight: 600; color: #374151; margin-bottom: 4px;">TC Kimlik No:</label>
                                    <p style="margin: 0; color: #6b7280;">${tcSafe}</p>
                                </div>
                                <div>
                                    <label style="display: block; font-weight: 600; color: #374151; margin-bottom: 4px;">Doğum Tarihi:</label>
                                    <p style="margin: 0; color: #6b7280;">${formatDate(student.birth_date || student.birthDate)}</p>
                                </div>
                                <div>
                                    <label style="display: block; font-weight: 600; color: #374151; margin-bottom: 4px;">Yaş:</label>
                                    <p style="margin: 0; color: #6b7280;">${age || 'Belirtilmemiş'}</p>
                                </div>
                                <div>
                                    <label style="display: block; font-weight: 600; color: #374151; margin-bottom: 4px;">Telefon:</label>
                                    <p style="margin: 0; color: #6b7280;">${phoneSafe}</p>
                                </div>
                                <div>
                                    <label style="display: block; font-weight: 600; color: #374151; margin-bottom: 4px;">Okul:</label>
                                    <p style="margin: 0; color: #6b7280;">${schoolSafe}</p>
                                </div>
                                <div>
                                    <label style="display: block; font-weight: 600; color: #374151; margin-bottom: 4px;">Spor Branşı:</label>
                                    <p style="margin: 0; color: #6b7280;">${branchSafe}</p>
                                </div>
                                <div>
                                    <label style="display: block; font-weight: 600; color: #374151; margin-bottom: 4px;">Kayıt Tarihi:</label>
                                    <p style="margin: 0; color: #6b7280;">${formatDate(student.registration_date || student.created_at)}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer" style="padding: 20px; border-top: 1px solid #e5e7eb; text-align: right; background: #f9fafb;">
                    <button onclick="app.showStudentModal('${student.id}')" style="background: #3B82F6; color: white; padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; margin-right: 8px; font-weight: 500;">
                        <i class="fas fa-edit"></i> Düzenle
                    </button>
                    ${((student.is_deleted || student.deleted) || ((student.status || '').toString().toLowerCase() === 'pasif') || ((student.status || '').toString().toLowerCase() === 'inactive')) ? `
                        <button onclick="app.activateStudentMembership('${student.id}')" style="background: #10B981; color: white; padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; margin-right: 8px; font-weight: 500;">
                            <i class=\"fas fa-user-check\"></i> Üyeliği Aktif Et
                        </button>
                    ` : `
                        <button onclick="app.cancelStudentMembership('${student.id}')" style="background: #F59E0B; color: white; padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; margin-right: 8px; font-weight: 500;">
                            <i class=\"fas fa-user-times\"></i> Üyeliği İptal Et
                        </button>
                    `}
                    <button onclick="app.hideStudentDetailModal()" style="background: #6b7280; color: white; padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500;">
                        <i class="fas fa-times"></i> Kapat
                    </button>
                </div>
            `;
        }

        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    hideStudentDetailModal() {
        const modal = document.getElementById('studentDetailModal');
        if (modal) {
            modal.style.display = 'none';
            document.body.style.overflow = 'auto';
        }
    }

    async cancelStudentMembership(studentId) {
        if (!confirm('Bu öğrencinin üyeliğini iptal etmek istediğinizden emin misiniz? Öğrenci "Silinen Öğrenciler" sekmesinde görünecektir.')) {
            return;
        }
        
        try {
            // 1) Öğrencinin ödenmemiş borçlarını topla
            const unpaidRes = await supabaseService.getUnpaidPaymentsForStudent(studentId);
            let notesAppendix = '';
            if (unpaidRes.success && Array.isArray(unpaidRes.data) && unpaidRes.data.length > 0) {
                const lines = unpaidRes.data.map(p => {
                    const dt = p.due_date ? new Date(p.due_date).toLocaleDateString('tr-TR') : '-';
                    const amt = (typeof p.amount === 'number') ? `${p.amount} TL` : `${p.amount || ''}`;
                    return `• ${dt} vadeli ${amt}${p.description ? ` (${p.description})` : ''}`;
                });
                notesAppendix = `\n\n[Üyelik iptali - ödenmemiş borçlar]:\n${lines.join('\n')}`;
            }

            // 2) Mevcut notları al ve ekle
            const studentRes = await supabaseService.getStudent(studentId);
            const currentNotes = (studentRes.success && studentRes.data && studentRes.data.notes) ? (studentRes.data.notes || '') : '';
            const newNotes = (currentNotes || '') + notesAppendix;

            // 3) Öğrenciyi 'pasif' işaretle ve notları güncelle
            const result = await supabaseService.updateStudent(studentId, { 
                status: 'pasif',
                deleted: true,
                deleted_at: new Date().toISOString(),
                notes: newNotes
            });

            // 4) Aidatlar ekranından kaldırmak için: ödenmemiş kayıtları sil
            if (unpaidRes.success && unpaidRes.data && unpaidRes.data.length > 0) {
                try { await supabaseService.deleteUnpaidPaymentsForStudent(studentId); } catch (_) {}
            }
            
            if (result.success) {
                alert('Öğrenci üyeliği başarıyla iptal edildi.');
                this.hideStudentDetailModal();
                
                // PERFORMANS: Cache'i temizle
                this.clearCache('students');
                
                // Öğrenci listesini yenile
                await this.loadStudentsScreen();
            } else {
                alert('İşlem başarısız: ' + this.formatErrorMessage(result.error));
            }
        } catch (error) {
            console.error('Error canceling student membership:', error);
            alert('Üyelik iptal edilemedi. Lütfen tekrar deneyin.');
        }
    }

    async activateStudentMembership(studentId) {
        if (!confirm('Bu öğrencinin üyeliğini tekrar AKTİF etmek istiyor musunuz?')) {
            return;
        }
        try {
            const result = await supabaseService.updateStudent(studentId, {
                status: 'active',
                is_deleted: false,
                deleted: false,
                deleted_at: null
            });
            if (result.success) {
                alert('Öğrenci üyeliği aktif edildi.');
                this.hideStudentDetailModal();
                
                // PERFORMANS: Cache'i temizle
                this.clearCache('students');
                
                await this.loadStudentsScreen();
            } else {
                alert('Üyelik aktifleştirilemedi: ' + this.formatErrorMessage(result.error));
            }
        } catch (error) {
            console.error('Error activating student membership:', error);
            alert('Üyelik aktifleştirilemedi. Lütfen tekrar deneyin.');
        }
    }

    async loadPaymentsScreen() {
        try {
            const [paymentsResult, studentsResult, branchesResult] = await Promise.all([
                supabaseService.getPayments(),
                supabaseService.getStudents(),
                supabaseService.getSportBranches()
            ]);
            
            // Sport branches'ı class'a kaydet
            this.sportBranches = branchesResult.success ? branchesResult.data : [];
            
            const container = document.getElementById('paymentsContainer');
            
            if (!container) {
                console.error('Payments container not found');
                return;
            }

            const payments = paymentsResult.success ? paymentsResult.data : [];
            const students = studentsResult.success ? studentsResult.data : [];

            // Calculate statistics
            const totalPayments = payments.length;
            const paidPayments = payments.filter(p => p.is_paid).length;
            const pendingPayments = payments.filter(p => !p.is_paid).length;
            const overduePayments = 0; // For now, we'll set this to 0
            
            // Calculate this month's income
            const currentMonth = new Date().getMonth();
            const currentYear = new Date().getFullYear();
            const thisMonthIncome = payments
                .filter(p => {
                    if (!p.payment_date || !p.is_paid) return false;
                    const paymentDate = new Date(p.payment_date);
                    return paymentDate.getMonth() === currentMonth && paymentDate.getFullYear() === currentYear;
                })
                .reduce((sum, p) => sum + (p.amount || 0), 0);

            container.innerHTML = `
                <!-- Header -->
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 25px; padding-bottom: 15px; border-bottom: 3px solid #DC2626;">
                    <i class="fas fa-credit-card" style="color: #DC2626; font-size: 24px;"></i>
                    <h2 style="color: #DC2626; font-size: 28px; font-weight: 700; margin: 0;">Aidat Takip Sistemi</h2>
                </div>

                <!-- Statistics Cards -->
                <div class="stats-cards" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 30px;">
                    <!-- Pending Payments -->
                    <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border-left: 4px solid #f59e0b;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="background: #f59e0b; color: white; width: 48px; height: 48px; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                                <i class="fas fa-clock" style="font-size: 20px;"></i>
                            </div>
                            <div>
                                <div style="font-size: 24px; font-weight: 700; color: #1f2937;">${pendingPayments}</div>
                                <div style="color: #6b7280; font-size: 14px;">Bekleyen Ödeme</div>
                            </div>
                        </div>
                    </div>

                    <!-- Overdue Payments -->
                    <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border-left: 4px solid #ef4444;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="background: #ef4444; color: white; width: 48px; height: 48px; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                                <i class="fas fa-exclamation-triangle" style="font-size: 20px;"></i>
                            </div>
                            <div>
                                <div style="font-size: 24px; font-weight: 700; color: #1f2937;">${overduePayments}</div>
                                <div style="color: #6b7280; font-size: 14px;">Geciken Ödeme</div>
                            </div>
                        </div>
                    </div>

                    <!-- Paid This Month -->
                    <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border-left: 4px solid #10b981;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="background: #10b981; color: white; width: 48px; height: 48px; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                                <i class="fas fa-check-circle" style="font-size: 20px;"></i>
                            </div>
                            <div>
                                <div style="font-size: 24px; font-weight: 700; color: #1f2937;">${paidPayments}</div>
                                <div style="color: #6b7280; font-size: 14px;">Ödenen Bu Ay</div>
                            </div>
                        </div>
                    </div>

                    <!-- Monthly Income -->
                    <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border-left: 4px solid #3b82f6;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="background: #3b82f6; color: white; width: 48px; height: 48px; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                                <i class="fas fa-lira-sign" style="font-size: 20px;"></i>
                            </div>
                            <div>
                                <div style="font-size: 24px; font-weight: 700; color: #1f2937;">${thisMonthIncome}</div>
                                <div style="color: #6b7280; font-size: 14px;">Aylık Gelir</div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Payment Tabs + Search (single container) -->
                <div class="payments-actions" style="display: flex; gap: 8px; margin-bottom: 25px; background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); padding: 8px; border-radius: 16px; box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.06); border: 1px solid #e2e8f0; align-items: center; flex-wrap: wrap; justify-content: space-between;">
                    <div class="payments-tabs" style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <button class="payment-tab-btn active" data-tab="all">Tüm Aidatlar</button>
                        <button class="payment-tab-btn" data-tab="overdue">Geciken Ödemeler</button>
                        <button class="payment-tab-btn" data-tab="upcoming">Yaklaşan Ödemeler</button>
                        <button class="payment-tab-btn" data-tab="payers">Ödeyen Öğrenciler</button>
                        <button class="payment-tab-btn" data-tab="equipment">Ekipman Ödemeleri</button>
                        <button class="payment-tab-btn" data-tab="tracking">📊 Ödeme Takip</button>
                    </div>
                    <div class="payments-search" style="position: relative; max-width: 360px; width: 100%; min-width: 220px;">
                        <label for="paymentsSearchInput" style="position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden;">Ödeme Arama</label>
                        <i class="fas fa-search" style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #9CA3AF;"></i>
                        <input id="paymentsSearchInput" type="text" placeholder="Ara: öğrenci, branş, dönem..." aria-label="Ödeme arama" style="width: 100%; padding: 10px 12px 10px 36px; border: 1px solid #e5e7eb; border-radius: 10px; background: white; font-size: 14px; color: #111827;">
                    </div>
                </div>

                <!-- Payment List -->
                <div id="paymentsList">
                    ${this.generatePaymentsList(students, payments, 'all', '')}
                </div>
            `;

            // Add tab click handlers and search
            const tabButtons = container.querySelectorAll('.payment-tab-btn');
            const self = this;
            const searchInput = container.querySelector('#paymentsSearchInput');
            const getActiveTab = () => (container.querySelector('.payment-tab-btn.active')?.dataset.tab) || 'all';
            const applyRender = () => {
                const tab = getActiveTab();
                const q = (searchInput?.value || '').trim().toLowerCase();
                const paymentsList = document.getElementById('paymentsList');
                if (paymentsList) {
                    paymentsList.innerHTML = self.generatePaymentsList(students, payments, tab, q);
                }
            };
            tabButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    // Update active tab
                    tabButtons.forEach(b => {
                        b.style.background = '#f8f9fa';
                        b.style.color = '#6c757d';
                        b.classList.remove('active');
                    });
                    e.target.style.background = '#dc2626';
                    e.target.style.color = 'white';
                    e.target.classList.add('active');
                    applyRender();
                });
            });
            if (searchInput) {
                searchInput.addEventListener('input', () => applyRender());
            }

        } catch (error) {
            console.error('Error loading payments screen:', error);
            const container = document.getElementById('paymentsContainer');
            if (container) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 40px; color: #ef4444;">
                        <i class="fas fa-exclamation-triangle" style="font-size: 48px; margin-bottom: 16px;"></i>
                        <p>Ödeme bilgileri yüklenirken hata oluştu.</p>
                    </div>
                `;
            }
        }
    }

    generatePaymentsList(students, payments, tab, query = '') {
        // Create a map of students for quick lookup
        const studentMap = {};
        students.forEach(student => {
            studentMap[student.id] = student;
        });

        // Filter payments based on tab
        let filteredPayments = payments;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        switch (tab) {
            case 'overdue':
                filteredPayments = payments.filter(p => {
                    if (p.is_paid) return false; // Ödenmiş olanları hariç tut
                    
                    // Geçmiş aylara ait borçları kontrol et
                    if (p.period_year && p.period_month) {
                        const currentDate = new Date();
                        const currentYear = currentDate.getFullYear();
                        const currentMonth = currentDate.getMonth() + 1; // 1-12 arası
                        
                        // Geçmiş yıl veya geçmiş ay ise gecikmiş
                        if (p.period_year < currentYear) {
                            return true; // Geçmiş yıl
                        } else if (p.period_year === currentYear && p.period_month < currentMonth) {
                            return true; // Bu yıl ama geçmiş ay
                        }
                        return false; // Mevcut ay veya gelecek
                    }
                    
                    // Eski sistem: due_date kontrolü (period_month olmayan kayıtlar için)
                    if (p.due_date) {
                        const dueDate = new Date(p.due_date);
                        dueDate.setHours(0, 0, 0, 0);
                        return dueDate < today;
                    }
                    
                    return false;
                });
                break;
            case 'upcoming':
                filteredPayments = payments.filter(p => {
                    if (p.is_paid) return false;
                    if (!p.due_date) return true; // No due date means upcoming
                    const dueDate = new Date(p.due_date);
                    dueDate.setHours(0, 0, 0, 0);
                    return dueDate >= today;
                });
                break;
            case 'payers':
                filteredPayments = payments.filter(p => p.is_paid);
                break;
            case 'equipment':
                filteredPayments = payments.filter(p => !!p.equipment_assignment_id);
                break;
            case 'tracking':
                // Ödeme takip tablosu için özel render
                return this.generatePaymentTrackingTable(students, payments);
            default:
                filteredPayments = payments;
        }

        // Text search filter
        const q = (query || '').toString().trim().toLowerCase();
        if (q) {
            filteredPayments = filteredPayments.filter(p => {
                const student = studentMap[p.student_id] || {};
                const name = `${student.name || ''} ${student.surname || ''}`.toLowerCase();
                // GÜVENLİK: Obje olabilecek sport değerini kontrol et
                const sport = this.getSportText(student.sport).toLowerCase();
                const period = (p.payment_period || p.period || '').toString().toLowerCase();
                const amount = (p.amount != null ? String(p.amount) : '').toLowerCase();
                return name.includes(q) || sport.includes(q) || period.includes(q) || amount.includes(q);
            });
        }

        if (filteredPayments.length === 0) {
            return `
                <div style="text-align: center; padding: 40px; color: #6b7280; background: #f9fafb; border-radius: 8px; border: 1px dashed #d1d5db;">
                    <i class="fas fa-credit-card" style="font-size: 32px; margin-bottom: 12px; opacity: 0.5;"></i>
                    <p style="margin: 0; font-size: 14px;">Bu kategoride ödeme kaydı bulunmuyor.</p>
                </div>
            `;
        }

        return filteredPayments.map(payment => {
            const student = studentMap[payment.student_id];
            let studentName = 'Öğrenci bulunamadı';
            
            if (student) {
                // Try different name field combinations
                if (student.first_name && student.last_name) {
                    studentName = `${student.first_name} ${student.last_name}`;
                } else if (student.name && student.surname) {
                    studentName = `${student.name} ${student.surname}`;
                } else if (student.first_name && student.surname) {
                    studentName = `${student.first_name} ${student.surname}`;
                } else if (student.name) {
                    studentName = student.name;
                } else if (student.full_name) {
                    studentName = student.full_name;
                } else if (student.firstName && student.lastName) {
                    studentName = `${student.firstName} ${student.lastName}`;
                }
            }
            
           
            // GÜVENLİK: Obje olabilecek sport değerini kontrol et
            let studentSport = 'Futbol';
            if (student) {
                studentSport = this.getSportText(student.sport) || 'Futbol';
            }
            const studentPhoto = student?.photo_thumb_url || student?.photo_url || 'https://via.placeholder.com/50x50?text=?';

// Tutarı gösterme mantığı:
// 1) Varsayılan olarak ödeme kaydındaki amount'u kullan (indirim uygulanmış tutar buradadır)
// 2) Sadece amount yoksa (null/undefined/NaN) branş ücretine düş
// 3) Son çare olarak 500 TL göster
let monthlyFee = (typeof payment.amount === 'number' && !isNaN(payment.amount))
    ? payment.amount
    : null;

// Eğer payment.amount yoksa (eski kayıtlar vb.), branş ücretine düş
if ((monthlyFee == null) && student && student.sport) {
    const branchFee = this.getSportBranchFee(student.sport);
    if (typeof branchFee === 'number' && !isNaN(branchFee)) {
        monthlyFee = branchFee;
    }
}

// Son çare
if (monthlyFee == null) monthlyFee = 500;
            // Format date
            const paymentDate = payment.due_date ? new Date(payment.due_date).toLocaleDateString('tr-TR', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            }) : '06.10.2025';

            // Pastel background for equipment payments
            const isEquipment = !!payment.equipment_assignment_id;
            const rowBg = isEquipment ? '#FFFBEB' : 'white';

            return `
                <div class="payment-row ${payment.is_paid ? 'paid' : 'unpaid'}" style="
                    background: ${rowBg}; 
                    border-radius: 8px; 
                    padding: 20px; 
                    margin-bottom: 12px; 
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                    border-left: 4px solid #10b981;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                ">
                    <div style="display: flex; align-items: center; gap: 16px;">
                        <img src="${studentPhoto}" alt="${studentName}" style="
                            width: 50px; 
                            height: 50px; 
                            border-radius: 50%; 
                            object-fit: cover;
                            border: 2px solid #e5e7eb;
                        " onerror="this.src='https://via.placeholder.com/50x50?text=${studentName.charAt(0)}'">
                        <div>
                            <h4 style="margin: 0 0 4px 0; color: #1f2937; font-size: 16px; font-weight: 600;">
                                ${studentName}
                            </h4>
                            <p style="margin: 0; color: #6b7280; font-size: 14px;">
                                ${studentSport} - ${studentSport === 'Futbol' ? 'Minikler' : 'Yetişkinler'}
                            </p>
                        </div>
                    </div>

                    <div class="payment-actions" style="display: flex; align-items: center; gap: 20px;">
                        <div style="text-align: right;">
                            <div style="font-size: 18px; font-weight: 700; color: #1f2937;">
                                ${monthlyFee} ₺
                            </div>
                            <div style="color: #6b7280; font-size: 12px;">
                                ${paymentDate}
                            </div>
                        </div>

                        <div style="display: flex; align-items: center; gap: 12px;">
                            ${payment.is_paid ? `
                                <span style="
                                    background: #10b981; 
                                    color: white; 
                                    padding: 6px 16px; 
                                    border-radius: 20px; 
                                    font-size: 12px; 
                                    font-weight: 500;
                                ">
                                    ÖDENDİ
                                </span>
                                ${tab === 'payers' ? `
                                <button class="btn-unpay" onclick="app.markPaymentAsUnpaid('${payment.id}')" style="
                                    background: #ef4444; 
                                    color: white; 
                                    border: none; 
                                    padding: 8px 14px; 
                                    border-radius: 6px; 
                                    cursor: pointer; 
                                    font-size: 12px; 
                                    font-weight: 500;
                                ">
                                    Ödemeyi Geri Al
                                </button>` : ''}
                            ` : `
                                <span class="status-badge" style="
                                    background: #f59e0b; 
                                    color: white; 
                                    padding: 6px 16px; 
                                    border-radius: 20px; 
                                    font-size: 12px; 
                                    font-weight: 500;
                                ">
                                    BEKLİYOR
                                </span>
                                <button class="btn-pay" onclick="app.markPaymentAsPaid('${payment.id}')" style="
                                    background: #3b82f6; 
                                    color: white; 
                                    border: none; 
                                    padding: 8px 16px; 
                                    border-radius: 6px; 
                                    cursor: pointer; 
                                    font-size: 12px; 
                                    font-weight: 500;
                                ">
                                    Ödeme Kaydı
                                </button>
                            `}
                            
                            <button class="btn-history" onclick="app.showPaymentHistory('${payment.student_id}')" style="
                                background: transparent; 
                                color: #6b7280; 
                                border: none; 
                                padding: 8px; 
                                cursor: pointer; 
                                font-size: 14px;
                            ">
                                <i class="fas fa-history"></i> Geçmiş
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    async markPaymentAsPaid(paymentId) {
        try {
            console.log(' Ödeme güncelleniyor:', paymentId);
            
            // Önce ödeme bilgisini al
            const paymentResult = await supabaseService.getPayment(paymentId);
            if (!paymentResult.success) {
                throw new Error('Ödeme bilgisi alınamadı');
            }
            
            const payment = paymentResult.data;
            console.log(' Ödeme bilgisi:', payment);
            
            // Ödemeyi güncelle
            const updatePaymentResult = await supabaseService.updatePayment(paymentId, {
                is_paid: true,
                payment_date: new Date().toISOString()
            });
    
            if (updatePaymentResult.success) {
                // Öğrenci tablosundaki payment_status'u da güncelle
                if (payment.student_id) {
                    const updateStudentResult = await supabaseService.updateStudent(payment.student_id, {
                        payment_status: 'paid'
                    });
                    await supabaseService.addActivityLog(
                        'payment',
                        'payment',
                        paymentId,
                        `${payment.student_name || 'Öğrenci'} için ${payment.amount} TL tutarında ödeme alındı`
                    );
                }
                
                // Ekranı yenile
                await this.loadPaymentsScreen();
                
                // PERFORMANS: Cache'i temizle
                this.clearCache('students');
                
                // Eğer öğrenciler ekranındaysak onu da yenile
                if (this.currentScreen === 'studentsScreen') {
                    await this.loadStudentsScreen();
                }
                
                alert('Ödeme başarıyla kaydedildi!');
            } else {
                console.error(' Ödeme güncelleme hatası:', updatePaymentResult.error);
                alert('Ödeme kaydedilirken hata oluştu: ' + updatePaymentResult.error);
            }
        } catch (error) {
            console.error('Error marking payment as paid:', error);
            alert('Ödeme kaydedilemedi: ' + this.formatErrorMessage(error));
        }
    }

    async showPaymentHistory(studentId) {
        try {
            // Öğrenci bilgilerini ve ödeme geçmişini al
            const [studentResult, paymentsResult] = await Promise.all([
                supabaseService.getStudent(studentId),
                supabaseService.getStudentPayments(studentId)
            ]);
    
            const student = studentResult.success ? studentResult.data : null;
            const payments = paymentsResult.success ? paymentsResult.data || [] : [];
    
            let studentName = 'Öğrenci';
            if (student) {
                if (student.first_name && student.last_name) {
                    studentName = `${student.first_name} ${student.last_name}`;
                } else if (student.name && student.surname) {
                    studentName = `${student.name} ${student.surname}`;
                } else if (student.first_name && student.surname) {
                    studentName = `${student.first_name} ${student.surname}`;
                } else if (student.name) {
                    studentName = student.name;
                } else if (student.full_name) {
                    studentName = student.full_name;
                }
            }
    
            // Spor branşı ücretini al
            let monthlyFee = 500; // Varsayılan
            if (student && student.sport) {
                monthlyFee = this.getSportBranchFee(student.sport) || 500;
            }
    
            let historyHTML = `
                <div style="max-width: 600px; background: white; border-radius: 12px; padding: 20px; margin: 20px auto; box-shadow: 0 4px 20px rgba(0,0,0,0.15);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 2px solid #e5e7eb;">
                        <h3 style="margin: 0; color: #1f2937; font-size: 20px; font-weight: 600;">
                            <i class="fas fa-history" style="color: #dc2626; margin-right: 8px;"></i>
                            ${studentName} - Ödeme Geçmişi
                        </h3>
                        <button onclick="this.parentElement.parentElement.parentElement.remove()" style="
                            background: #dc2626; 
                            color: white; 
                            border: none; 
                            width: 30px; 
                            height: 30px; 
                            border-radius: 50%; 
                            cursor: pointer; 
                            font-size: 16px;
                        ">&times;</button>
                    </div>
            `;
    
            if (payments.length === 0) {
                historyHTML += `
                    <div style="text-align: center; padding: 40px; color: #6b7280;">
                        <i class="fas fa-receipt" style="font-size: 48px; margin-bottom: 16px; opacity: 0.5;"></i>
                        <p>Bu öğrenci için ödeme kaydı bulunmuyor.</p>
                        <p style="font-size: 12px; color: #9ca3af; margin-top: 10px;">Student ID: ${studentId}</p>
                    </div>
                `;
            } else {
                historyHTML += `<div style="max-height: 400px; overflow-y: auto;">`;
                payments.forEach(payment => {
                    const paymentDate = payment.payment_date ? 
                        new Date(payment.payment_date).toLocaleDateString('tr-TR') : 
                        (payment.due_date ? new Date(payment.due_date).toLocaleDateString('tr-TR') : 'Tarih belirtilmemiş');
                    
                    // Tutar belirleme: payment.amount sayısal ise onu kullan; aksi halde branş ücretine düş
                    const amount = (typeof payment.amount === 'number' && !isNaN(payment.amount))
                        ? payment.amount
                        : monthlyFee;
                    
                    historyHTML += `
                        <div style="
                            display: flex; 
                            justify-content: space-between; 
                            align-items: center; 
                            padding: 15px; 
                            margin-bottom: 10px; 
                            background: #f8f9fa; 
                            border-radius: 8px; 
                            border-left: 4px solid ${payment.is_paid ? '#10b981' : '#f59e0b'};
                        ">
                            <div>
                                <div style="font-weight: 600; color: #1f2937; margin-bottom: 4px;">${amount} ₺</div>
                                <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">${paymentDate} - ${(() => {
                                    if (payment.payment_period) {
                                        const [year, month] = payment.payment_period.split('-');
                                        const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
                                        return `${monthNames[parseInt(month) - 1]} ${year}`;
                                    } else if (payment.period) {
                                        return payment.period;
                                    } else if (payment.period_year && payment.period_month) {
                                        const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
                                        return `${monthNames[payment.period_month - 1]} ${payment.period_year}`;
                                    } else {
                                        return 'Dönem belirtilmemiş';
                                    }
                                })()}</div>
                            </div>
                            <span style="
                                background: ${payment.is_paid ? '#10b981' : '#f59e0b'}; 
                                color: white; 
                                padding: 4px 12px; 
                                border-radius: 12px; 
                                font-size: 12px; 
                                font-weight: 500;
                            ">
                                ${payment.is_paid ? 'Ödendi' : 'Bekliyor'}
                            </span>
                        </div>
                    `;
                });
                historyHTML += `</div>`;
            }
    
            historyHTML += `</div>`;
    
            // Modal oluştur ve göster
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1000;
            `;
            modal.innerHTML = historyHTML;
            document.body.appendChild(modal);
    
            // Modal dışına tıklandığında kapat
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.remove();
                }
            });
    
        } catch (error) {
            console.error('Error showing payment history:', error);
            alert('Ödeme geçmişi yüklenemedi: ' + this.formatErrorMessage(error));
        }
    }

    async loadSettingsScreen() {
        try {
            const container = document.getElementById('settingsScreen');
            if (!container) {
                console.error('Settings screen not found');
                return;
            }

            // Settings screen is already built in HTML with modern design
            // Just ensure Supabase service is initialized for the embedded JavaScript
            if (typeof supabaseService !== 'undefined') {
                supabaseService.initialize();
                // Ensure welcome message reflects current user on settings screen
                try {
                    const email = (this.currentUser && this.currentUser.email) || '';
                    let displayName = email;
                    if (this.currentUser && this.currentUser.full_name) {
                        displayName = this.currentUser.full_name;
                    } else if (this.currentUser && this.currentUser.username) {
                        displayName = this.currentUser.username;
                    } else if (email) {
                        displayName = email.split('@')[0];
                    }
                    const welcomeIds = ['userWelcome', 'userWelcome2', 'userWelcome3', 'userWelcome4', 'userWelcome5', 'userWelcome6', 'welcomeMessage'];
                    welcomeIds.forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.textContent = `Hoş geldiniz, ${displayName}`;
                    });
                } catch (_) {}
            }

            // The settings screen HTML already has its own JavaScript functions
            // loadBranches() and loadEquipment() which will be called by tab switching
            
        } catch (error) {
            console.error('Error loading settings screen:', error);
        }
    }

    showSettingsTab(tabName) {
        // Hide all tabs
        document.querySelectorAll('.settings-tab').forEach(tab => {
            tab.style.display = 'none';
        });
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });

        // Show selected tab
        const selectedTab = document.getElementById(tabName + 'Tab');
        if (selectedTab) {
            selectedTab.style.display = 'block';
        }

        // Activate button
        event.target.classList.add('active');
    }

    async loadEquipmentScreen() {
        
        
        

        this.currentEquipmentTab = 'assignment';
        this.selectedStudentForEquipment = null;
        
        const container = document.getElementById('equipmentContainer');
        if (!container) {
            console.error('Equipment container not found');
            return;
        }
        
        container.innerHTML = `
            <div class="equipment-header" style="margin-bottom: 25px;">
                <h2 class="page-title" style="color: #DC2626; font-size: 28px; font-weight: 700; margin-bottom: 25px; border-bottom: 3px solid #DC2626; padding-bottom: 15px;">
                    <i class="fas fa-tshirt"></i> Ekipman Takip
                </h2>

                <!-- Equipment Tabs + Search (single container like payments) -->
                <div class="equipment-actions" style="display: flex; gap: 8px; margin-bottom: 25px; background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); padding: 8px; border-radius: 16px; box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.06); border: 1px solid #e2e8f0; align-items: center; flex-wrap: wrap; justify-content: space-between;">
                    <div class="equipment-tabs" style="display: flex; gap: 8px; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch;">
                        <div class="equipment-tab active" data-tab="assignment" onclick="app.switchEquipmentTab('assignment')"
                             style="padding: 12px 24px; background: linear-gradient(135deg, #DC2626 0%, #B91C1C 100%); color: white; border: 1px solid #B91C1C; border-radius: 12px; cursor: pointer; font-weight: 600; font-size: 14px; transition: all 0.3s; box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);">
                            Ekipman Atama
                        </div>
                        <div class="equipment-tab" data-tab="assigned" onclick="app.switchEquipmentTab('assigned')"
                             style="padding: 12px 24px; background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%); color: #475569; border: 1px solid #e2e8f0; border-radius: 12px; cursor: pointer; font-weight: 600; font-size: 14px; transition: all 0.3s; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);">
                            Atanmış Ekipmanlar
                        </div>
                        <div class="equipment-tab" data-tab="returned" onclick="app.switchEquipmentTab('returned')"
                             style="padding: 12px 24px; background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%); color: #475569; border: 1px solid #e2e8f0; border-radius: 12px; cursor: pointer; font-weight: 600; font-size: 14px; transition: all 0.3s; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);">
                            İade Edilmiş Ekipmanlar
                        </div>
                        <div class="equipment-tab" data-tab="inventory" onclick="app.switchEquipmentTab('inventory')"
                             style="padding: 12px 24px; background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%); color: #475569; border: 1px solid #e2e8f0; border-radius: 12px; cursor: pointer; font-weight: 600; font-size: 14px; transition: all 0.3s; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);">
                            Mevcut Ekipmanlar
                        </div>
                    </div>
                    <div class="equipment-search" style="position: relative; max-width: 360px; width: 100%; min-width: 220px;">
                        <label for="equipmentGlobalSearchInput" style="position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden;">Ekipman Arama</label>
                        <i class="fas fa-search" style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #9CA3AF;"></i>
                        <input id="equipmentGlobalSearchInput" type="text" placeholder="Ara: öğrenci, ekipman, beden..." aria-label="Ekipman arama" style="width: 100%; padding: 10px 12px 10px 36px; border: 1px solid #e5e7eb; border-radius: 10px; background: white; font-size: 14px; color: #111827;">
                    </div>
                </div>
            </div>
            
           <div id="mainEquipmentTabContent">
                <!-- Tab content will be loaded here -->
            </div>
        `;
        
 
                // Load default tab content
                this.loadEquipmentAssignmentTab();

            // After render, ensure equipment tabs are placed into a scroll container (like payments)
            try {
                const actions = document.querySelector('.equipment-actions');
                const tabsWrap = actions ? actions.querySelector('.equipment-tabs') : null;
                if (tabsWrap && !tabsWrap.querySelector('.equipment-tabs-scroll')) {
                    const scroll = document.createElement('div');
                    scroll.className = 'equipment-tabs-scroll';
                    scroll.style.cssText = 'display:flex; gap:8px; flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch; width:100%;';
                    const btns = Array.from(tabsWrap.querySelectorAll('.equipment-tab'));
                    if (btns.length) {
                        tabsWrap.insertBefore(scroll, btns[0]);
                        btns.forEach(b => scroll.appendChild(b));
                    }
                }
            } catch (_) {}

            // Wire global equipment search
            this.setupEquipmentTabsSearchBar();
            // Fallback 1: ensure search exists right after tabs inside actions
            setTimeout(() => {
                if (!document.getElementById('equipmentGlobalSearchInput')) {
                    try {
                        const actions = document.querySelector('.equipment-actions');
                        const tabs = actions ? actions.querySelector('.equipment-tabs') : null;
                        if (actions && tabs) {
                            const bar = document.createElement('div');
                            bar.className = 'equipment-search';
                            bar.style.cssText = 'position: relative; max-width: 360px; width: 100%; min-width: 220px;';
                            
                            // GÜVENLİK: innerHTML yerine güvenli DOM oluşturma + Accessibility
                            const searchLabel = this.createSafeElement('label', {
                                for: 'equipmentGlobalSearchInput',
                                style: 'position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden;'
                            }, [document.createTextNode('Ekipman Arama')]);
                            
                            const searchIcon = this.createSafeElement('i', {
                                class: 'fas fa-search',
                                style: 'position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #9CA3AF;'
                            });
                            const searchInput = this.createSafeElement('input', {
                                id: 'equipmentGlobalSearchInput',
                                type: 'text',
                                placeholder: 'Ara: öğrenci, ekipman, beden...',
                                'aria-label': 'Ekipman arama',
                                style: 'width: 100%; padding: 10px 12px 10px 36px; border: 1px solid #e5e7eb; border-radius: 10px; background: white; font-size: 14px; color: #111827;'
                            });
                            bar.appendChild(searchLabel);
                            bar.appendChild(searchIcon);
                            bar.appendChild(searchInput);
                            
                            tabs.insertAdjacentElement('afterend', bar);
                            this.setupEquipmentTabsSearchBar();
                        }
                    } catch (err) { console.warn('equipment search fallback-1 failed', err); }
                }
            }, 150);
            // Fallback 2: inject before main content if still missing
            setTimeout(() => {
                if (!document.getElementById('equipmentGlobalSearchInput')) {
                    try {
                        const mainContent = document.getElementById('mainEquipmentTabContent');
                        if (mainContent && mainContent.parentElement) {
                            const bar = document.createElement('div');
                            bar.className = 'equipment-search';
                            bar.style.cssText = 'position: relative; max-width: 360px; width: 100%; min-width: 220px; margin: 8px 0;';
                            
                            // GÜVENLİK: innerHTML yerine güvenli DOM oluşturma + Accessibility
                            const searchLabel = this.createSafeElement('label', {
                                for: 'equipmentGlobalSearchInput',
                                style: 'position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden;'
                            }, [document.createTextNode('Ekipman Arama')]);
                            
                            const searchIcon = this.createSafeElement('i', {
                                class: 'fas fa-search',
                                style: 'position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #9CA3AF;'
                            });
                            const searchInput = this.createSafeElement('input', {
                                id: 'equipmentGlobalSearchInput',
                                type: 'text',
                                placeholder: 'Ara: öğrenci, ekipman, beden...',
                                'aria-label': 'Ekipman arama',
                                style: 'width: 100%; padding: 10px 12px 10px 36px; border: 1px solid #e5e7eb; border-radius: 10px; background: white; font-size: 14px; color: #111827;'
                            });
                            bar.appendChild(searchLabel);
                            bar.appendChild(searchIcon);
                            bar.appendChild(searchInput);
                            
                            mainContent.parentElement.insertBefore(bar, mainContent);
                            this.setupEquipmentTabsSearchBar();
                        }
                    } catch (err) { console.warn('equipment search fallback-2 failed', err); }
                }
            }, 300);

                     // Ayarlar sayfasındaki ekipman türlerini koru
        setTimeout(() => {
            const settingsTab = document.getElementById('equipmentTabContent');
            if (settingsTab && settingsTab.style.display === 'block') {
                if (typeof loadEquipment === 'function') {
                    loadEquipment();
                }
            }
        }, 100);
    
}

switchEquipmentTab(tabName) {
// Update tab styles
  document.querySelectorAll('.equipment-tab').forEach(tab => {
  if (tab.dataset.tab === tabName) {
  tab.style.cssText = 'padding: 12px 24px; background: linear-gradient(135deg, #DC2626 0%, #B91C1C 100%); color: white; border: 1px solid #B91C1C; border-radius: 12px; cursor: pointer; font-weight: 600; font-size: 14px; transition: all 0.3s; box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4); transform: translateY(-1px);';
  tab.classList.add('active');
  } else {
  tab.style.cssText = 'padding: 12px 24px; background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%); color: #475569; border: 1px solid #e2e8f0; border-radius: 12px; cursor: pointer; font-weight: 600; font-size: 14px; transition: all 0.3s; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);';
  tab.classList.remove('active');
  }
  });
  this.currentEquipmentTab = tabName;

  // Load tab content
  switch (tabName) {
    case 'assignment':
      this.loadEquipmentAssignmentTab();
      break;
    case 'assigned':
      this.loadAssignedEquipmentTab();
      break;
    case 'returned':
      this.loadReturnedEquipmentTab();
      break;
    case 'inventory':
      this.loadEquipmentInventoryTab();
      break;
    case 'calendar':
      this.loadCalendarScreen();
      break;
  }
}

async loadCalendarScreen() {
  try {
    const container = document.getElementById('calendarContainer');
    if (!container) {
      console.error('Calendar container not found');
      return;
    }
    // Build calendar shell with centered selector between title and buttons
    container.innerHTML = `
      <div class="calendar-header" style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
        <h2 style="margin: 0; color: #DC2626; font-weight: 700;">Takvim</h2>
        <div id="calendarSelector" style="flex: 1; display: flex; justify-content: center;"></div>
        <div class="calendar-actions" style="display:flex; align-items:center; gap:8px;">
          <button class="calendar-view-btn" data-view="weekly" onclick="app.setCalendarView('weekly')" style="padding: 8px 16px; background: #F3F4F6; color: #6B7280; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;">Haftalık</button>
          <button class="calendar-view-btn" data-view="monthly" onclick="app.setCalendarView('monthly')" style="padding: 8px 16px; background: #F3F4F6; color: #6B7280; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;">Aylık</button>
          <button class="calendar-view-btn" data-view="branch" onclick="app.setCalendarView('branch')" style="padding: 8px 16px; background: #F3F4F6; color: #6B7280; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;">Branş</button>
          <button onclick="app.showTrainingModal()" style="padding: 8px 16px; background: #10B981; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600;"><i class="fas fa-plus"></i> Yeni</button>
        </div>
      </div>
      <div id="calendarContent"></div>
    `;

    // Defaults
    if (!this.currentCalendarView) this.currentCalendarView = 'weekly';
    if (!this.currentWeek) this.currentWeek = 1;

    // Render selected view
    this.setCalendarView(this.currentCalendarView);
  } catch (error) {
    console.error('Error loading calendar screen:', error);
    const container = document.getElementById('calendarContainer');
    if (container) {
      container.innerHTML = '<div style="text-align: center; color: #EF4444; padding: 40px;">Takvim yüklenemedi</div>';
    }
  }
}

async loadEquipmentAssignmentTab() {
  const container = document.getElementById('mainEquipmentTabContent');
  if (!container) return;

  try {
    // Load students for selection
    // ...
            const studentsResult = await supabaseService.getStudents();
            const students = studentsResult.success ? studentsResult.data.filter(s => !s.is_deleted) : [];

            container.innerHTML = `
                <!-- Student Selection Section -->
                <div class="student-selection-section">
                    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
                        <i class="fas fa-user" style="color: #DC2626; font-size: 18px;"></i>
                        <h3 style="color: #DC2626; margin: 0; font-size: 18px; font-weight: 600;">ÖĞRENCİ SEÇ</h3>
                    </div>
                    
                    <!-- Öğrenci arama barı kaldırıldı -->
                    
                    <div class="active-students-section">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 15px;">
                            <i class="fas fa-users" style="color: #6B7280; font-size: 16px;"></i>
                            <h4 style="color: #374151; margin: 0; font-size: 16px; font-weight: 600;">Aktif Öğrenciler</h4>
                        </div>
                        
                        <div id="studentsList" class="students-list" style="height: 192px; overflow-x: auto; overflow-y: hidden; background: #f8fafc; border-radius: 12px; padding: 8px; display: flex; flex-wrap: nowrap; gap: 8px;">
                            ${students.map(student => `
                                <div class="student-item" data-student-id="${student.id}" onclick="app.selectStudentForEquipment('${student.id}')" 
                                     style="display: flex; align-items: center; padding: 16px; background: white; border-radius: 12px; cursor: pointer; border: 1px solid #e5e7eb; transition: all 0.3s; box-shadow: 0 2px 4px rgba(0,0,0,0.05); flex: 0 0 25%; max-width: 25%; box-sizing: border-box;"
                                     onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(0,0,0,0.1)'; this.style.borderColor='#DC2626';"
                                     onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 4px rgba(0,0,0,0.05)'; this.style.borderColor='#e5e7eb';">
                                    <div class="student-photo" style="width: 50px; height: 50px; border-radius: 50%; background: linear-gradient(135deg, #DC2626, #B91C1C); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; margin-right: 16px; flex-shrink: 0; box-shadow: 0 2px 8px rgba(220, 38, 38, 0.3); overflow: hidden;">
                                        ${(student.photo_thumb_url || student.photo_url) ? `<img src="${student.photo_thumb_url || student.photo_url}" loading="lazy" decoding="async" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;">` : 
                                          `<i class="fas fa-user" style="font-size: 18px;"></i>`}
                                    </div>
                                    <div class="student-info" style="flex: 1;">
                                        <div class="student-name" style="font-weight: 600; color: #1F2937; margin-bottom: 6px; font-size: 16px;">
                                            ${student.name} ${student.surname}
                                        </div>
                                        <div class="student-details" style="display: flex; align-items: center; gap: 16px; font-size: 13px; color: #6B7280;">
                                            <span style="display: inline-flex; align-items: center; background: #f3f4f6; padding: 4px 8px; border-radius: 6px; white-space: nowrap;">
                                                <i class="fas fa-running" style="margin-right: 6px; color: #DC2626;"></i>
                                                ${this.getSportText(student.sport) || 'Spor branşı yok'}
                                            </span>
                                            <span style="display: inline-flex; align-items: center; background: #f3f4f6; padding: 4px 8px; border-radius: 6px; white-space: nowrap;">
                                                <i class="fas fa-phone" style="margin-right: 6px; color: #10B981;"></i>
                                                ${student.phone || 'Telefon yok'}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
                
                <!-- Selected Student and Equipment Form (Initially Hidden) -->
                <div id="equipmentAssignmentForm" style="display: none; margin-top: 30px;">
                    <!-- This will be populated when a student is selected -->
                </div>
            `;
        } catch (error) {
            console.error('Error loading equipment assignment tab:', error);
            container.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #ef4444;">
                    <i class="fas fa-exclamation-triangle" style="font-size: 32px; margin-bottom: 12px;"></i>
                    <div>Ekipman atama ekranı yüklenemedi</div>
                </div>
            `;
        }
    }

    filterStudentsForEquipment(searchTerm) {
    // Debounce to reduce DOM work during fast typing
    clearTimeout(this._equipSearchDebounce);
    this._equipSearchDebounce = setTimeout(() => {
        const studentItems = document.querySelectorAll('.student-item');
        const searchLower = (searchTerm || '').toLowerCase();
        studentItems.forEach(item => {
            const nameEl = item.querySelector('.student-name');
            const detailsEl = item.querySelector('.student-details');
            const studentName = (nameEl?.textContent || '').toLowerCase();
            const studentDetails = (detailsEl?.textContent || '').toLowerCase();
            item.style.display = (studentName.includes(searchLower) || studentDetails.includes(searchLower)) ? 'flex' : 'none';
        });
    }, 200);
}

async selectStudentForEquipment(studentId) {
    try {
        // Load student data
        const result = await supabaseService.getStudent(studentId);
        if (!result.success) {
            alert('Öğrenci bilgileri yüklenemedi');
            return;
        }

        const student = result.data;
        this.selectedStudentForEquipment = student;

        // Load equipment types
        const equipmentResult = await supabaseService.getEquipmentTypes();
        const equipmentTypes = equipmentResult.success ? equipmentResult.data : [];
        // Cache for later handlers (onEquipmentChange/onSizeChange)
        this._equipmentTypesCache = equipmentTypes;

        // Show equipment assignment form
        const formContainer = document.getElementById('equipmentAssignmentForm');
        if (!formContainer) return;

        formContainer.style.display = 'block';
        formContainer.innerHTML = `
            <!-- Selected Student Info -->
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 25px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 15px;">
                    <i class="fas fa-user-check" style="color: #10B981; font-size: 18px;"></i>
                    <h3 style="color: #10B981; margin: 0; font-size: 18px; font-weight: 600;">Seçili Öğrenci: ${student.name} ${student.surname}</h3>
                </div>
                
                <div style="display: flex; align-items: center; gap: 20px;">
                    <div class="student-photo" style="width: 60px; height: 60px; border-radius: 50%; background: #DC2626; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; flex-shrink: 0;">
                        ${(student.photo_thumb_url || student.photo_url) ? `<img src="${student.photo_thumb_url || student.photo_url}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;">` : 
                          `<i class="fas fa-user" style="font-size: 24px;"></i>`}
                    </div>
                    <div>
                        <div style="font-size: 14px; color: #6B7280; margin-bottom: 4px;">
                            <i class="fas fa-phone" style="margin-right: 6px;"></i>
                            ${student.phone || 'Telefon bilgisi yok'}
                        </div>
                        <div style="font-size: 14px; color: #6B7280;">
                            <i class="fas fa-running" style="margin-right: 6px;"></i>
                            Branş: ${this.getSportText(student.sport) || 'Belirtilmemiş'}
                        </div>
                    </div>
                    <button onclick="app.clearSelectedStudent()" 
                            style="margin-left: auto; background: #6B7280; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px;">
                        <i class="fas fa-times"></i> Seçimi Temizle
                    </button>
                </div>
            </div>

            <!-- Equipment Assignment Form -->
            <div style="background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 25px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
                    <i class="fas fa-plus-circle" style="color: #DC2626; font-size: 18px;"></i>
                    <h3 style="color: #DC2626; margin: 0; font-size: 18px; font-weight: 600;">Ekipman Atama</h3>
                </div>
                
                <form id="equipmentAssignmentFormData" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: end;">
                    <div>
                        <label for="equipmentName" style="display: block; margin-bottom: 6px; font-weight: 600; color: #374151;">
                            <i class="fas fa-tshirt" style="margin-right: 6px;"></i>Ekipman
                        </label>
                        <select id="equipmentName" name="equipmentName" required onchange="app.onEquipmentChange(this.value)" style="width: 100%; padding: 10px; border: 2px solid #e5e7eb; border-radius: 8px; font-size: 14px;">
                            <option value="">Ekipman seçiniz...</option>
                            ${Array.from(new Set((equipmentTypes || []).map(et => et.name || 'Ekipman')))
                                .map(name => `<option value="${name}">${name}</option>`).join('')}
                        </select>
                        <!-- Hidden fields kept for backend compatibility -->
                        <input type="hidden" name="equipmentType" value="" aria-hidden="true">
                        <input type="hidden" name="size" value="" aria-hidden="true">
                    </div>
                    <div>
                        <label for="sizeSelect" style="display: block; margin-bottom: 6px; font-weight: 600; color: #374151;">
                            <i class="fas fa-ruler" style="margin-right: 6px;"></i>Beden
                        </label>
                        <select id="sizeSelect" name="sizeSelect" required onchange="app.onSizeChange(this.value)" style="width: 100%; padding: 10px; border: 2px solid #e5e7eb; border-radius: 8px; font-size: 14px;">
                            <option value="">Önce ekipman seçiniz...</option>
                        </select>
                    </div>
                    
                    <div>
                        <label for="quantitySelect" style="display: block; margin-bottom: 6px; font-weight: 600; color: #374151;">
                            <i class="fas fa-sort-numeric-up" style="margin-right: 6px;"></i>Adet
                        </label>
                        <select id="quantitySelect" name="quantity" required style="width: 100%; padding: 10px; border: 2px solid #e5e7eb; border-radius: 8px; font-size: 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                            <option value="">Önce ekipman ve beden seçiniz...</option>
                        </select>
                    </div>
                    
                    <div>
                        <label for="assignmentDate" style="display: block; margin-bottom: 6px; font-weight: 600; color: #374151;">
                            <i class="fas fa-calendar-alt" style="margin-right: 6px;"></i>Atama Tarihi
                        </label>
                        <input type="date" id="assignmentDate" name="assignmentDate" required value="${new Date().toISOString().split('T')[0]}" style="width: 100%; padding: 10px; border: 2px solid #e5e7eb; border-radius: 8px; font-size: 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                    </div>
                    
                    <div style="grid-column: 1 / -1;">
                        <label for="equipmentNotes" style="display: block; margin-bottom: 6px; font-weight: 600; color: #374151;">
                            <i class="fas fa-sticky-note" style="margin-right: 6px;"></i>Notlar (İsteğe Bağlı)
                        </label>
                        <textarea id="equipmentNotes" name="notes" rows="3" placeholder="Ekipman hakkında notlar..." style="width: 100%; padding: 10px; border: 2px solid #e5e7eb; border-radius: 8px; font-size: 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; resize: vertical;"></textarea>
                    </div>
                    
                    <div style="grid-column: 1 / -1; text-align: center; margin-top: 15px;">
                        <button type="submit" style="background: #DC2626; color: white; border: none; padding: 12px 30px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 16px;">
                            <i class="fas fa-plus"></i> Ekipman Ata
                        </button>
                    </div>
                </form>
            </div>

            <!-- Assigned Equipment List -->
            <div id="assignedEquipmentList" style="margin-top: 25px;">
                <!-- Will be loaded dynamically -->
            </div>
        `;

        // Setup form submission
        const form = document.getElementById('equipmentAssignmentFormData');
        if (form) {
            form.addEventListener('submit', (e) => this.handleEquipmentAssignment(e));
        }

        // Load assigned equipment for this student
        this.loadStudentAssignedEquipment(studentId);

    } catch (error) {
        console.error('Error selecting student for equipment:', error);
        alert('Öğrenci seçilemedi. Lütfen tekrar deneyin.');
    }
}

clearSelectedStudent() {
    this.selectedStudentForEquipment = null;
    const formContainer = document.getElementById('equipmentAssignmentForm');
    if (formContainer) {
        formContainer.style.display = 'none';
    }
}

async loadStudentAssignedEquipment(studentId) {
    try {
        const result = await supabaseService.getStudentEquipmentAssignments(studentId);
        const container = document.getElementById('assignedEquipmentList');
        if (!container) return;

        if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
            container.innerHTML = `
                <div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 15px; text-align: center;">
                    <i class="fas fa-info-circle" style="color: #f59e0b; margin-right: 8px;"></i>
                    Bu öğrenciye henüz ekipman atanmamış.
                </div>
            `;
            return;
        }

        const assignments = result.data.filter(a => (a.status || '').toString().trim().toLowerCase() === 'assigned');

        container.innerHTML = `
            <div style="background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 15px;">
                    <i class="fas fa-list" style="color: #DC2626; font-size: 16px;"></i>
                    <h4 style="color: #DC2626; margin: 0; font-size: 16px; font-weight: 600;">ATANAN EKİPMANLAR</h4>
                </div>
                ${assignments.map(assignment => {
                    const statusColors = { assigned: '#10B981', returned: '#6B7280', lost: '#EF4444', damaged: '#F59E0B' };
                    const statusTexts = { assigned: 'Atanmış', returned: 'İade Edilmiş', lost: 'Kayıp', damaged: 'Hasarlı' };
                    const normStatus = (assignment.status || '').toString().trim().toLowerCase();
                    const statusColor = statusColors[normStatus] || '#6B7280';
                    const statusText = statusTexts[normStatus] || assignment.status;
                    const statusBadgeStyle = `background: ${statusColor}; color: white;`;
                    return `
                        <div class="assigned-equipment-item" style="background: white; border-radius: 8px; padding: 15px; margin-bottom: 10px; border-left: 4px solid ${statusColor}; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div style="flex: 1;">
                                    <div style="font-weight: 600; color: #1F2937; margin-bottom: 4px;">${assignment.equipment_name || 'Ekipman bulunamadı'}</div>
                                    <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">Beden: ${assignment.size || 'Belirtilmemiş'} • Adet: ${assignment.quantity} • Tarih: ${new Date(assignment.assigned_date).toLocaleDateString('tr-TR')}</div>
                                    ${assignment.notes ? `<div style="font-size: 11px; color: #6B7280; font-style: italic; margin-top: 4px;">Not: ${assignment.notes}</div>` : ''}
                                </div>
                                <div style="display: flex; align-items: center; gap: 10px;">
                                    <div style="display: flex; align-items: center; gap: 10px;">
                                        <span class="status-badge" style="padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; white-space: nowrap; max-width: 100%; ${statusBadgeStyle}">${statusText}</span>
                                        ${normStatus === 'assigned' ? `<button onclick="app.returnEquipment('${assignment.id}')" style="background: #10B981; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;"><i class="fas fa-undo"></i> İade</button>` : ''}
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    } catch (error) {
        console.error('Error loading student assigned equipment:', error);
    }
}

async loadAssignedEquipmentTab() {
    const container = document.getElementById('mainEquipmentTabContent');
    if (!container) return;

    try {
        // Get all equipment assignments with student and equipment details
        const result = await supabaseService.getAllEquipmentAssignments();
        
        if (!result.success || !result.data || result.data.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #6b7280;">
                    <i class="fas fa-list" style="font-size: 48px; margin-bottom: 16px;"></i>
                    <p>Henüz atanmış ekipman bulunmuyor.</p>
                </div>
            `;
            return;
        }

        const assignments = (result.data || []).filter(a => (a.status || '').toString().trim().toLowerCase() === 'assigned');
        
        container.innerHTML = `
            <div style="background: white; border-radius: 12px; padding: 20px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
                    <i class="fas fa-list" style="color: #DC2626; font-size: 18px;"></i>
                    <h3 style="color: #DC2626; margin: 0; font-size: 18px; font-weight: 600;">ATANMIŞ EKİPMANLAR</h3>
                </div>
                
                ${assignments.map(assignment => {
                    const normStatus = (assignment.status || '').toString().trim().toLowerCase();
                    const statusColors = {
                        'assigned': '#10B981',
                        'returned': '#6B7280',
                        'lost': '#EF4444',
                        'damaged': '#F59E0B'
                    };
                    
                    const statusTexts = {
                        'assigned': 'Atanmış',
                        'returned': 'İade Edilmiş',
                        'lost': 'Kayıp',
                        'damaged': 'Hasarlı'
                    };
                    
                    const statusColor = statusColors[normStatus] || '#6B7280';
                    const statusText = statusTexts[normStatus] || assignment.status;
                    
// Ekipman fotoğrafını kontrol et
let hasImage = false;
let photoUrl = '';

if (assignment.equipment_photo_url && assignment.equipment_photo_url.trim() !== '') {
    photoUrl = assignment.equipment_photo_url;
    hasImage = true;
} else if (assignment.photo_url && assignment.photo_url.trim() !== '') {
    photoUrl = assignment.photo_url;
    hasImage = true;
}

                    const firstLetter = (assignment.equipment_name?.charAt(0) || 'E').toUpperCase();

                    return `
                        <div style="background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; margin-bottom: 15px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); transition: all 0.2s ease;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 16px rgba(0,0,0,0.15)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 8px rgba(0,0,0,0.1)'">
                            <div style="display: grid; grid-template-columns: 80px 1fr auto; gap: 20px; align-items: center;">
                                <!-- Ekipman Fotoğrafı -->
                                <div>
                                    ${hasImage ? 
                                        `<img src="${photoUrl}" loading="lazy" decoding="async" alt="${assignment.equipment_name || 'Ekipman'}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 8px; border: 2px solid #e2e8f0; background: #f8fafc;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                                        <div style="display: none; width: 60px; height: 60px; background: linear-gradient(135deg, #dc2626, #b91c1c); border-radius: 8px; align-items: center; justify-content: center; color: white; font-weight: 700; font-size: 20px; border: 2px solid #e2e8f0;">${firstLetter}</div>` :
                                        `<div style="width: 60px; height: 60px; background: linear-gradient(135deg, #dc2626, #b91c1c); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: white; font-weight: 700; font-size: 20px; border: 2px solid #e2e8f0;">${firstLetter}</div>`
                                    }
                                </div>
                                
                                <!-- Ekipman Bilgileri -->
                                <div style="flex: 1;">
                                    <h4 style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #1F2937;">
                                        ${assignment.equipment_name || 'Bilinmeyen Ekipman'}
                                    </h4>
                                        
                                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                                            <i class="fas fa-user" style="color: #6B7280; font-size: 12px;"></i>
                                            <span style="color: #374151; font-weight: 500; font-size: 14px;">
                                                ${assignment.student_name || 'Bilinmeyen Öğrenci'}
                                            </span>
                                        </div>
                                        
                                        <div style="display: flex; align-items: center; gap: 16px; font-size: 12px; color: #6B7280; margin-bottom: 8px;">
                                            <span style="display: flex; align-items: center; gap: 4px;">
                                                <i class="fas fa-tshirt"></i>
                                                ${assignment.size || 'Belirtilmemiş'}
                                            </span>
                                            <span style="display: flex; align-items: center; gap: 4px;">
                                                <i class="fas fa-sort-numeric-up"></i>
                                                ${assignment.quantity} adet
                                            </span>
                                            <span style="display: flex; align-items: center; gap: 4px;">
                                                <i class="fas fa-calendar"></i>
                                                ${new Date(assignment.assigned_date).toLocaleDateString('tr-TR')}
                                            </span>
                                        </div>
                                        
                                        ${assignment.notes ? `
                                            <div style="font-size: 11px; color: #6B7280; font-style: italic; margin-top: 8px;">
                                                Not: ${assignment.notes}
                                            </div>
                                        ` : ''}
                                    </div>
                                    
                                    <div style="display: flex; align-items: center; gap: 8px; margin-left: 16px;">
                                        ${assignment.status === 'assigned' ? `
                                            <button onclick=\"app.returnEquipment('${assignment.id}')\" style=\"background: #10B981; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600;\">\n                                                <i class=\"fas fa-undo\"></i> İade\n                                            </button>
                                        ` : `
                                            <span style=\"padding: 6px 12px; border-radius: 6px; font-size: 11px; font-weight: 600; background: ${statusColor}; color: white;\">\n                                                ${statusText}\n                                            </span>
                                        `}
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
            
        } catch (error) {
            console.error('Error loading assigned equipment:', error);
            container.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #ef4444;">
                    <i class="fas fa-exclamation-triangle" style="font-size: 48px; margin-bottom: 16px;"></i>
                    <p>Atanmış ekipmanlar yüklenirken hata oluştu.</p>
                </div>
            `;
        }
    }

    // Removed legacy loadEquipmentSizes and loadSizeQuantities in favor of onEquipmentChange/onSizeChange

    // Removed deprecated onVariantChange (replaced by onEquipmentChange/onSizeChange)

    async handleEquipmentAssignment(e) {
        e.preventDefault();
        
        if (!this.selectedStudentForEquipment) {
            alert('Lütfen önce bir öğrenci seçin');
            return;
        }

        const formData = new FormData(e.target);
        const assignmentData = {
            student_id: this.selectedStudentForEquipment.id,
            equipment_type_id: formData.get('equipmentType'),
            size: formData.get('size'),
            quantity: parseInt(formData.get('quantity')) || 1,
            assigned_date: formData.get('assignmentDate'),
            notes: formData.get('notes') || null
        };

        try {
            // Validate stock before assigning
            const stockCheck = await supabaseService.getAvailableEquipmentQuantity(assignmentData.equipment_type_id, assignmentData.size);
            const available = stockCheck.success ? (stockCheck.available || 0) : 0;
            if (available <= 0) {
                alert('Seçilen ürün/beden stokta yok. Lütfen farklı beden veya ürün seçiniz.');
                return;
            }
            if (assignmentData.quantity > available) {
                alert(`İstenen adet stoktan fazla. Mevcut stok: ${available}`);
                return;
            }
            const result = await supabaseService.createEquipmentAssignment(assignmentData);
            
            if (result.success) {
                alert('Ekipman başarıyla atandı!');
                // Create a payment record for the equipment fee (if defined)
                try {
                    const equipRes = await supabaseService.getEquipmentType(assignmentData.equipment_type_id);
                    const equipmentType = equipRes?.success ? equipRes.data : null;
                    const fee = equipmentType && typeof equipmentType.fee === 'number' ? equipmentType.fee : (equipmentType && equipmentType.fee != null ? parseFloat(equipmentType.fee) : 0);
                    const qty = Number.isFinite(assignmentData.quantity) ? assignmentData.quantity : 1;

                    if (fee > 0) {
                        const now = new Date();
                        const year = now.getFullYear();
                        const month = now.getMonth() + 1;
                        const amount = parseFloat((fee * qty).toFixed(2));
                        const notes = `Ekipman ücreti - ${equipmentType?.name || 'Ekipman'} • Beden: ${assignmentData.size || '-'} • Adet: ${qty}`;

                        await supabaseService.createPayment({
                            student_id: this.selectedStudentForEquipment.id,
                            equipment_assignment_id: result.data?.id || null,
                            amount,
                            payment_date: null,
                            payment_method: 'other',
                            period_month: month,
                            period_year: year,
                            payment_period: `${year}-${String(month).padStart(2, '0')}`,
                            notes,
                            is_paid: false
                        });

                        // If payments screen is currently active, refresh it
                        if (this.currentScreen === 'paymentsScreen') {
                            try { await this.loadPaymentsScreen(); } catch (_) {}
                        }
                    }
                } catch (equipPayErr) {
                    console.warn('Ekipman ödeme kaydı oluşturulamadı:', equipPayErr);
                }
                const s = this.selectedStudentForEquipment || {};
                const studentFullName = (s.first_name && s.last_name)
                    ? `${s.first_name} ${s.last_name}`
                    : (s.name && s.surname)
                        ? `${s.name} ${s.surname}`
                        : (s.full_name || s.name || s.first_name || 'Öğrenci');
                await supabaseService.addActivityLog(
                    'assign',
                    'equipment',
                    assignmentData.equipment_id,
                    `${studentFullName} öğrencisine ekipman atandı`
                );
                // Reset form
                e.target.reset();
                // Reload assigned equipment list
                this.loadStudentAssignedEquipment(this.selectedStudentForEquipment.id);
            } else {
                alert('Ekipman ataması sırasında hata oluştu: ' + result.error);
            }
        } catch (error) {
            console.error('Error assigning equipment:', error);
            alert('Ekipman atanamadı. Lütfen tekrar deneyin.');
        }
    }

    async returnEquipment(assignmentId) {
        if (!confirm('Bu ekipmanı iade etmek istediğinizden emin misiniz?')) {
            return;
        }

        try {
            const result = await supabaseService.returnEquipment(assignmentId);
            
            if (result.success) {
                alert('Ekipman başarıyla iade edildi!');
                // Reload assigned equipment list
                if (this.selectedStudentForEquipment) {
                    this.loadStudentAssignedEquipment(this.selectedStudentForEquipment.id);
                }
                // Also refresh main equipment tabs if visible
                if (this.currentScreen === 'equipmentScreen') {
                    if (this.currentEquipmentTab === 'assigned') {
                        this.loadAssignedEquipmentTab();
                    } else if (this.currentEquipmentTab === 'returned') {
                        this.loadReturnedEquipmentTab();
                    }
                }
            } else {
                alert('Ekipman iadesi sırasında hata oluştu: ' + result.error);
            }
        } catch (error) {
            console.error('Error returning equipment:', error);
            alert('Ekipman iade edilemedi. Lütfen tekrar deneyin.');
        }
    }

    async loadEquipmentInventoryTab() {
        const container = document.getElementById('mainEquipmentTabContent');
        if (!container) return;

        try {
            const result = await supabaseService.getEquipmentTypes();
            if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 40px; color: #6b7280;">
                        <i class="fas fa-warehouse" style="font-size: 48px; margin-bottom: 16px;"></i>
                        <p>Henüz ekipman türü bulunmuyor.</p>
                    </div>
                `;
                return;
            }

            const equipmentTypes = result.data;
            const groups = {};
            (equipmentTypes || []).forEach(et => {
                const key = (et.name || 'Diğer').toString();
                if (!groups[key]) groups[key] = [];
                groups[key].push(et);
            });

            const html = Object.entries(groups).map(([name, rows]) => {
                const totalQty = rows.reduce((s, r) => s + (parseInt(r.quantity, 10) || 0), 0);
                const totalAvail = rows.reduce((s, r) => s + (typeof r.available_quantity === 'number' ? r.available_quantity : Math.max(0, (parseInt(r.quantity, 10) || 0))), 0);
                const photo = rows.find(r => r.photo_url)?.photo_url || '';
                const created = rows[0]?.created_at ? new Date(rows[0].created_at).toLocaleDateString('tr-TR') : '-';
                const sizeRows = rows.map(r => {
                    const q = parseInt(r.quantity, 10) || 0;
                    const avail = (typeof r.available_quantity === 'number') ? r.available_quantity : q;
                    return { size: r.size || '-', quantity: q, available: avail };
                }).sort((a,b) => (a.size||'').toString().localeCompare((b.size||'').toString(), 'tr'));

                return `
                    <div style="background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin-bottom: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                        <div style="display: flex; align-items: center; gap: 16px;">
                            <div style="width: 60px; height: 60px; border-radius: 8px; background: #f3f4f6; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                                ${photo ? `<img src="${photo}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px;">` : `<i class=\"fas fa-tshirt\" style=\"color: #9CA3AF; font-size: 24px;\"></i>`}
                            </div>
                            <div style="flex: 1;">
                                <h4 style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #1F2937;">${name}</h4>
                                <div style="font-size: 12px; color: #6B7280;">Toplam Stok: ${totalQty} • Müsait: ${totalAvail}</div>
                                <div style="font-size: 11px; color: #9CA3AF; margin-top: 6px;"><i class=\"fas fa-calendar\"></i> İlk Kayıt: ${created}</div>
                                <div style="margin-top: 10px; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px;">
                                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; padding: 8px 12px; font-weight: 600; color: #374151; border-bottom: 1px solid #e5e7eb;">
                                        <div>Beden</div>
                                        <div>Stok</div>
                                        <div>Müsait</div>
                                    </div>
                                    ${sizeRows.map(sr => `
                                        <div style=\"display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; padding: 8px 12px; border-bottom: 1px dashed #e5e7eb; color: #374151;\">
                                            <div>${sr.size}</div>
                                            <div>${sr.quantity}</div>
                                            <div>${sr.available}</div>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            container.innerHTML = `
                <div style="background: white; border-radius: 12px; padding: 20px;">
                    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
                        <i class="fas fa-warehouse" style="color: #DC2626; font-size: 18px;"></i>
                        <h3 style="color: #DC2626; margin: 0; font-size: 18px; font-weight: 600;">MEVCUT EKİPMANLAR</h3>
                    </div>
                    ${html}
                </div>
            `;

        } catch (error) {
            console.error('Error loading equipment inventory:', error);
            container.innerHTML = `
                <div style=\"text-align: center; padding: 40px; color: #ef4444;\">\n                    <i class=\"fas fa-exclamation-triangle\" style=\"font-size: 48px; margin-bottom: 16px;\"></i>\n                    <p>Ekipman envanteri yüklenirken hata oluştu.</p>\n                </div>
            `;
        }
    }

    async loadSportBranchesView() {
        // Dashboard ile aynı spor branşı renk paleti
        const sportColors = {
            'Futbol': '#3B82F6',
            'Tenis': '#EC4899', 
            'Yüzme': '#F59E0B',
            'Kadın Futbol': '#10B981',
            'Basketbol': '#8B5CF6',
            'Voleybol': '#EF4444'
        };
        
        const container = document.getElementById('calendarContent');
        if (!container) return;

        try {
            // Get sport branches and trainings
            const [branchesResult, trainingsResult] = await Promise.all([
                supabaseService.getSportBranches(),
                supabaseService.getTrainings()
            ]);

            const sportBranches = branchesResult.success ? branchesResult.data : [];
            const trainings = trainingsResult.success ? trainingsResult.data : [];

            if (sportBranches.length === 0) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 40px; color: #6b7280;">
                        <i class="fas fa-calendar-times" style="font-size: 48px; margin-bottom: 16px;"></i>
                        <p>Henüz spor branşı tanımlanmamış.</p>
                    </div>
                `;
                return;
            }

            // Group trainings by sport
            const trainingsBySport = {};
            trainings.forEach(training => {
                const sport = training.sport || 'Diğer';
                if (!trainingsBySport[sport]) {
                    trainingsBySport[sport] = [];
                }
                trainingsBySport[sport].push(training);
            });

            // Generate HTML for each sport branch
            let branchesHTML = '';
            sportBranches.forEach(branch => {
                const branchTrainings = trainingsBySport[branch.name] || [];
                
                branchesHTML += `
                    <div style="margin-bottom: 30px; background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden;">
                        <!-- Branch Header -->
                        <div style="background: linear-gradient(135deg, ${sportColors[branch.name] || '#DC2626'}, ${sportColors[branch.name] ? sportColors[branch.name] + 'CC' : '#B91C1C'}); color: white; padding: 20px;">
                            <h3 style="margin: 0; font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 10px;">
                                <i class="fas fa-futbol" style="color: rgba(255,255,255,0.9);"></i>
                                ${branch.name}
                                <span style="background: rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 500; margin-left: auto;">
                                    ${branchTrainings.length} Antrenman
                                </span>
                            </h3>
                            ${branch.description ? `<p style="margin: 8px 0 0 0; opacity: 0.9; font-size: 14px;">${branch.description}</p>` : ''}
                        </div>

                        <!-- Trainings List -->
                        <div style="padding: 20px;">
                            ${branchTrainings.length > 0 ? `
                                <div style="display: grid; gap: 12px;">
                                    ${branchTrainings.map(training => `
                                      <div class="training-card" style="
    background: #f8f9fa;
    border-left: 4px solid ${sportColors[training.sport] || '#DC2626'};
    border: 1px solid #e9ecef;
    border-radius: 8px;
    padding: 16px;
    transition: all 0.2s ease;
    cursor: pointer;
                                        " onclick="app.showTrainingDetail('${training.id}')" onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.1)'; this.style.transform='translateY(-2px)'" onmouseout="this.style.boxShadow='none'; this.style.transform='translateY(0)'">
                                            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                                                <div>
                                                    <h4 style="margin: 0 0 4px 0; color: #1f2937; font-size: 16px; font-weight: 600;">
                                                        ${new Date(training.date).toLocaleDateString('tr-TR', { 
                                                            weekday: 'long', 
                                                            year: 'numeric', 
                                                            month: 'long', 
                                                            day: 'numeric' 
                                                        })}
                                                    </h4>
                                                    <div style="display: flex; align-items: center; gap: 16px; color: #6b7280; font-size: 14px;">
                                                        <span><i class="fas fa-clock"></i> ${(training.start_time || '09:00').substring(0, 5)} - ${(training.end_time || '11:00').substring(0, 5)}</span>
                                                        ${training.location ? `<span><i class="fas fa-map-marker-alt"></i> ${training.location}</span>` : ''}
                                                        ${training.instructor ? `<span><i class="fas fa-user"></i> ${training.instructor}</span>` : ''}
                                                    </div>
                                                </div>
                                                <div style="display: flex; gap: 8px;">
                                                    <button onclick="event.stopPropagation(); app.editTraining('${training.id}')" style="
                                                        background: #3b82f6; 
                                                        color: white; 
                                                        border: none; 
                                                        padding: 6px 10px; 
                                                        border-radius: 6px; 
                                                        cursor: pointer; 
                                                        font-size: 12px;
                                                    ">
                                                        <i class="fas fa-edit"></i>
                                                    </button>
                                                    <button onclick="event.stopPropagation(); app.deleteTraining('${training.id}')" style="
                                                        background: #ef4444; 
                                                        color: white; 
                                                        border: none; 
                                                        padding: 6px 10px; 
                                                        border-radius: 6px; 
                                                        cursor: pointer; 
                                                        font-size: 12px;
                                                    ">
                                                        <i class="fas fa-trash"></i>
                                                    </button>
                                                </div>
                                            </div>
                                            ${training.notes ? `
                                                <div style="background: white; padding: 12px; border-radius: 6px; border-left: 4px solid #DC2626;">
                                                    <p style="margin: 0; color: #4b5563; font-size: 14px; line-height: 1.5;">${training.notes}</p>
                                                </div>
                                            ` : ''}
                                        </div>
                                    `).join('')}
                                </div>
                            ` : `
                                <div style="text-align: center; padding: 30px; color: #9ca3af;">
                                    <i class="fas fa-calendar-plus" style="font-size: 32px; margin-bottom: 12px; opacity: 0.5;"></i>
                                    <p style="margin: 0; font-size: 14px;">Bu branş için henüz antrenman planlanmamış.</p>
                                    <button onclick="app.showTrainingModal('${branch.name}')" style="
                                        background: #DC2626; 
                                        color: white; 
                                        border: none; 
                                        padding: 8px 16px; 
                                        border-radius: 6px; 
                                        cursor: pointer; 
                                        font-size: 12px; 
                                        margin-top: 12px;
                                    ">
                                        <i class="fas fa-plus"></i> Antrenman Ekle
                                    </button>
                                </div>
                            `}
                        </div>
                    </div>
                `;
            });

            container.innerHTML = branchesHTML;

        } catch (error) {
            console.error('Error loading sport branches view:', error);
            container.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #ef4444;">
                    <i class="fas fa-exclamation-triangle" style="font-size: 48px; margin-bottom: 16px;"></i>
                    <p>Spor branşları yüklenirken hata oluştu.</p>
                </div>
            `;
        }
    }

    getCurrentWeekNumber() {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const dayOfMonth = now.getDate();
        return Math.ceil(dayOfMonth / 7);
    }

    changeCalendarWeek(direction) {
        this.currentWeek += direction;
        if (this.currentWeek < 1) this.currentWeek = 1;
        if (this.currentWeek > 5) this.currentWeek = 5;
        
        // Calculate the new date based on week number
        const today = new Date();
        const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const weekStartDate = new Date(startOfMonth);
        weekStartDate.setDate(startOfMonth.getDate() + ((this.currentWeek - 1) * 7));
        
        this.currentCalendarDate = weekStartDate;
        
        // Update the week display
        const weekDisplay = document.querySelector('.calendar-header h3');
        if (weekDisplay) {
            weekDisplay.textContent = `${this.currentWeek}. Hafta`;
        }
        
        this.loadWeeklyCalendarView();
    }

    setCalendarView(view) {
        this.currentCalendarView = view;
        
        // Update selector based on view type
        this.updateCalendarSelector(view);
        
        // Update button styles
        document.querySelectorAll('.calendar-view-btn').forEach(btn => {
            if (btn.dataset.view === view) {
                btn.style.cssText = 'padding: 8px 16px; background: #DC2626; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;';
                btn.classList.add('active');
            } else {
                btn.style.cssText = 'padding: 8px 16px; background: #F3F4F6; color: #6B7280; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;';
                btn.classList.remove('active');
            }
        });
        
        // Load appropriate view
        switch(view) {
            case 'weekly':
                this.loadWeeklyCalendarView();
                break;
            case 'monthly':
                this.loadMonthlyCalendarView();
                break;
            case 'branch':
                this.loadBranchCalendarView();
                break;
        }
    }
    
    updateCalendarSelector(view) {
        const selector = document.getElementById('calendarSelector');
        if (!selector) return;
        
        switch(view) {
            case 'weekly':
                selector.style.display = 'flex'; // Div'i görünür yap
                selector.innerHTML = `
                    <div style="text-align: center;">
                        <div style="margin: 0 0 8px 0; color: #111827; font-size: 20px; font-weight: 700;">
                            ${this.currentWeek}. Hafta
                        </div>
                        <div style="display: inline-flex; gap: 8px; align-items: center; justify-content: center;">
                            <button onclick="app.changeCalendarWeek(-1)" title="Önceki hafta" style="
                                width: 38px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
                                background: #ffffff; color: #dc2626; border: 1px solid #dc2626; border-radius: 8px; cursor: pointer;">
                                <i class="fas fa-chevron-left"></i>
                            </button>
                            <button onclick="app.changeCalendarWeek(1)" title="Sonraki hafta" style="
                                width: 38px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
                                background: #ffffff; color: #dc2626; border: 1px solid #dc2626; border-radius: 8px; cursor: pointer;">
                                <i class="fas fa-chevron-right"></i>
                            </button>
                        </div>
                    </div>
                `;
                break;
                case 'monthly':
                    selector.style.display = 'flex'; // Div'i görünür yap
                    const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
                    const currentMonth = this.currentMonth !== undefined ? this.currentMonth : new Date().getMonth();
                    const currentYear = this.currentYear !== undefined ? this.currentYear : new Date().getFullYear();
                    selector.innerHTML = `
                        <div style="text-align: center;">
                            <div style="margin: 0 0 8px 0; color: #111827; font-size: 20px; font-weight: 700;">
                                ${monthNames[currentMonth]} ${currentYear}
                            </div>
                            <div style="display: inline-flex; gap: 8px; align-items: center; justify-content: center;">
                                <button onclick="app.previousMonth()" title="Önceki ay" style="
                                    width: 38px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
                                    background: #ffffff; color: #dc2626; border: 1px solid #dc2626; border-radius: 8px; cursor: pointer;">
                                    <i class="fas fa-chevron-left"></i>
                                </button>
                                <button onclick="app.nextMonth()" title="Sonraki ay" style="
                                    width: 38px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
                                    background: #ffffff; color: #dc2626; border: 1px solid #dc2626; border-radius: 8px; cursor: pointer;">
                                    <i class="fas fa-chevron-right"></i>
                                </button>
                            </div>
                        </div>
                    `;
                    break;
                    case 'branch':
                        selector.style.display = 'none'; // Div'i gizle
                        selector.innerHTML = ''; // İçini boşalt
                        break;
        }
    }

    async loadWeeklyCalendarView() {
            
        const container = document.getElementById('calendarContent');
        if (!container) return;

        try {
            const result = await supabaseService.getTrainings();
            const trainings = result.success ? result.data : [];
            
            // Get week dates based on current week number
            const today = new Date();
            const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
            
            // Calculate the start of the selected week
            const weekStartDate = new Date(startOfMonth);
            weekStartDate.setDate(startOfMonth.getDate() + ((this.currentWeek - 1) * 7));
            
            // Find Monday of that week
            const startOfWeek = new Date(weekStartDate);
            const dayOfWeek = startOfWeek.getDay();
            const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
            startOfWeek.setDate(startOfWeek.getDate() + daysToMonday);
            
            const weekDays = [];
            for (let i = 0; i < 7; i++) {
                const day = new Date(startOfWeek);
                day.setDate(startOfWeek.getDate() + i);
                weekDays.push(day);
            }
            
            const dayNames = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
            
            container.innerHTML = `
            <div class="calendar-grid">
                ${weekDays.map((day, index) => {
                    const dayTrainings = trainings.filter(training => {
                        const trainingDate = new Date(training.date);
                        return trainingDate.toDateString() === day.toDateString();
                    });
                    
                    const isToday = day.toDateString() === new Date().toDateString();
                    
                    return `
                        <div class="calendar-day ${isToday ? 'today' : ''}">
                            <div class="calendar-day-info">
                                <div class="calendar-day-name">${dayNames[index]}</div>
                                <div class="calendar-day-number">${day.getDate()}</div>
                            </div>
                            
                            <div class="calendar-day-trainings">
                                ${dayTrainings.length > 0 ? 
                                    dayTrainings.map(training => `
                                        <div class="training-item" 
                                             ondblclick="app.showAttendanceModal('${training.id}')"
                                            style="background: ${this.sportColorMap[training.sport] || '#FF0000'};">
                                            ${(training.start_time || '09:00').substring(0, 5)} ${training.sport} 
                                        </div>
                                    `).join('') :
                                    `<div class="no-training">Antrenman yok</div>`
                                }
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
     
            
        } catch (error) {
            console.error('Error loading weekly calendar:', error);
            container.innerHTML = '<div style="text-align: center; color: #EF4444; padding: 40px;">Haftalık takvim yüklenemedi</div>';
        }
    }

    async loadMonthlyCalendarView() {
        // Dashboard ile aynı spor branşı renk paleti
        const sportColors = {
            'Futbol': '#3B82F6',
            'Tenis': '#EC4899', 
            'Yüzme': '#F59E0B',
            'Kadın Futbol': '#10B981',
            'Basketbol': '#8B5CF6',
            'Voleybol': '#EF4444'
        };
        
        const container = document.getElementById('calendarContent');
        if (!container) return;

        try {
            const result = await supabaseService.getTrainings();
            const trainings = result.success ? result.data : [];
            
            const today = new Date();
            const currentMonth = today.getMonth();
            const currentYear = today.getFullYear();
            
            // Get first day of month and calculate calendar grid
            const firstDay = new Date(currentYear, currentMonth, 1);
            const lastDay = new Date(currentYear, currentMonth + 1, 0);
            const startDate = new Date(firstDay);
            
            // Start from Monday of the week containing the first day
            const dayOfWeek = firstDay.getDay();
            const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
            startDate.setDate(firstDay.getDate() + daysToMonday);
            
            // Generate 6 weeks (42 days) for complete calendar grid
            const calendarDays = [];
            for (let i = 0; i < 42; i++) {
                const day = new Date(startDate);
                day.setDate(startDate.getDate() + i);
                calendarDays.push(day);
            }
            
            const monthNames = ['OCAK', 'ŞUBAT', 'MART', 'NİSAN', 'MAYIS', 'HAZİRAN', 
                              'TEMMUZ', 'AĞUSTOS', 'EYLÜL', 'EKİM', 'KASIM', 'ARALIK'];
            
            container.innerHTML = `
                <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                    <div style="margin-bottom: 20px; font-size: 18px; font-weight: 600; color: #374151;">
                        ${monthNames[currentMonth]} ${currentYear}
                    </div>
                    
                    <!-- Calendar Header -->
                    <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px; margin-bottom: 1px;">
                        ${['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'].map(day => `
                            <div style="background: #475569; color: white; padding: 12px; text-align: center; font-weight: 600; font-size: 14px;">
                                ${day}
                            </div>
                        `).join('')}
                    </div>
                    
                    <!-- Calendar Grid -->
                   <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; background: #D1D5DB; padding: 1px; border-radius: 8px; overflow: hidden;">
                        ${calendarDays.map(day => {
                            const dayTrainings = trainings.filter(training => {
                                const trainingDate = new Date(training.date);
                                return trainingDate.toDateString() === day.toDateString();
                            });
                            
                            const isCurrentMonth = day.getMonth() === currentMonth;
                            const isToday = day.toDateString() === today.toDateString();
                            
                            return `
                              <div class="calendar-day ${!isCurrentMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}" 
     style="background: white; 
            padding: 12px; 
            min-height: 150px; 
            border: 1px solid #E5E7EB;
            ${!isCurrentMonth ? 'background: #F8FAFC; color: #9CA3AF;' : ''}
            ${isToday ? 'background: #FEF2F2; border: 2px solid #FECACA;' : ''}
            transition: all 0.2s ease;">
                                    <div style="font-weight: 600; margin-bottom: 4px; ${isToday ? 'color: #D97706;' : ''}">${day.getDate()}</div>
                                    ${dayTrainings.map(training => `
                                 <div ondblclick="app.showAttendanceModal('${training.id}')" style="
    background: ${sportColors[training.sport] || '#DC2626'}; 
    color: white; 
    padding: 4px 6px; 
    border-radius: 4px; 
    margin-bottom: 2px;
    font-size: 10px;
    font-weight: 500;
    cursor: pointer;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
                                        ">
                                            ${(training.start_time || '09:00').substring(0, 5)} ${training.sport}
                                        </div>
                                    `).join('')}
                                </div>
                            `;
                        }).join('')}
                </div>
            `;
            
        } catch (error) {
            console.error('Error loading monthly calendar:', error);
            container.innerHTML = '<div style="text-align: center; color: #EF4444; padding: 40px;">Aylık takvim yüklenemedi</div>';
        }
    }

    async loadBranchCalendarView() {
        const container = document.getElementById('calendarContent');
        if (!container) return;

        try {
            // Get sport branches and trainings
            const [branchesResult, trainingsResult] = await Promise.all([
                supabaseService.getSportBranches(),
                supabaseService.getTrainings()
            ]);

            const sportBranches = branchesResult.success ? branchesResult.data : [];
            const trainings = trainingsResult.success ? trainingsResult.data : [];

            if (sportBranches.length === 0) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 40px; color: #6b7280;">
                        <i class="fas fa-calendar-times" style="font-size: 48px; margin-bottom: 16px;"></i>
                        <p>Henüz spor branşı tanımlanmamış.</p>
                    </div>
                `;
                return;
            }

            // Group trainings by sport
            const trainingsBySport = {};
            trainings.forEach(training => {
                const sport = training.sport || 'Diğer';
                if (!trainingsBySport[sport]) {
                    trainingsBySport[sport] = [];
                }
                trainingsBySport[sport].push(training);
            });

            // Generate HTML for each sport branch
            let branchesHTML = '';
            sportBranches.forEach(branch => {
                const branchTrainings = trainingsBySport[branch.name] || [];
                
                // Get age group info from branch description or first training
                const ageGroupMatch = branch.description ? branch.description.match(/\(([^)]+)\)/) : null;
                const ageGroup = ageGroupMatch ? ageGroupMatch[1] : '8-17';
                
                branchesHTML += `
                    <div style="margin-bottom: 30px;">
                        <!-- Branch Header -->
                        <div style="background: #10B981; color: white; padding: 15px 20px; border-radius: 8px; margin-bottom: 15px; display: flex; align-items: center; gap: 10px;">
                            <i class="fas fa-futbol" style="font-size: 18px;"></i>
                            <span style="font-size: 16px; font-weight: 600;">
                                ${branch.name.toUpperCase()} (${ageGroup} - Eylül 2025 ayında ${branchTrainings.length} antrenman)
                            </span>
                        </div>

                        <!-- Trainings Cards -->
                        ${branchTrainings.length > 0 ? `
                            <div style="display: flex; gap: 20px; overflow-x: auto; padding-bottom: 10px;">
                                ${branchTrainings.map(training => {
                                    const trainingDate = new Date(training.date);
                                    const dayNames = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
                                    const dayName = dayNames[trainingDate.getDay()];
                                    
                                    return `
                                        <div ondblclick="app.showAttendanceModal('${training.id}')" style="
                                            min-width: 300px;
                                            background: #F8FAFC; 
                                            border: 1px solid #E5E7EB; 
                                            border-radius: 8px; 
                                            padding: 16px;
                                            cursor: pointer;
                                            transition: all 0.2s;
                                            border-left: 4px solid #DC2626;
                                            flex-shrink: 0;
                                        " onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.1)'" onmouseout="this.style.boxShadow='none'">
                                            <!-- Date header -->
                                            <div style="font-weight: 600; color: #374151; margin-bottom: 8px; font-size: 14px;">
                                                ${dayName} ${String(trainingDate.getDate()).padStart(2, '0')}.${String(trainingDate.getMonth() + 1).padStart(2, '0')}.${trainingDate.getFullYear()}
                                            </div>
                                            
                                            <!-- Time -->
                                            <div style="color: #6B7280; font-size: 14px; margin-bottom: 12px; font-weight: 500; text-align: right;">
                                                ${(training.start_time || '14:00').substring(0, 5)} - ${(training.end_time || '16:00').substring(0, 5)}
                                            </div>
                                            
                                            <!-- Info section with icons -->
                                            <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px;">
                                                <div style="display: flex; align-items: center; gap: 8px; color: #6B7280; font-size: 12px;">
                                                    <i class="fas fa-users" style="width: 12px;"></i>
                                                    <span>${ageGroup}</span>
                                                </div>
                                                <div style="display: flex; align-items: center; gap: 8px; color: #6B7280; font-size: 12px;">
                                                    <i class="fas fa-map-marker-alt" style="width: 12px;"></i>
                                                    <span>${training.location || 'Korner Halı Saha'}</span>
                                                </div>
                                              <div style="display: flex; align-items: center; gap: 8px; color: #6B7280; font-size: 12px;">
    <i class="fas fa-user-tie" style="width: 12px;"></i>
    <span>${training.instructor || 'Serhat Karabulut'}</span>
</div>
</div>

<!-- Training content -->
<div style="
    background: white; 
    padding: 16px; 
    border-radius: 6px;
    border: 1px solid #E5E7EB;
    text-align: center;
    margin-top: 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
">
    <div style="
        font-size: 16px;
        font-weight: 500;
        color: #374151;
    ">
        ${training.notes || 'Kondisyon'}
    </div>
</div>
       
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        ` : `
                            <div style="text-align: center; padding: 30px; color: #9ca3af; background: #f9fafb; border-radius: 8px; border: 1px dashed #d1d5db;">
                                <i class="fas fa-calendar-plus" style="font-size: 32px; margin-bottom: 12px; opacity: 0.5;"></i>
                                <p style="margin: 0; font-size: 14px;">Bu branş için henüz antrenman planlanmamış.</p>
                                <button onclick="app.showTrainingModal('${branch.name}')" style="
                                    background: #DC2626; 
                                    color: white; 
                                    border: none; 
                                    padding: 8px 16px; 
                                    border-radius: 6px; 
                                    cursor: pointer; 
                                    font-size: 12px; 
                                    margin-top: 12px;
                                ">
                                    <i class="fas fa-plus"></i> Antrenman Ekle
                                </button>
                            </div>
                        `}
                    </div>
                `;
            });

            container.innerHTML = branchesHTML;
            
        } catch (error) {
            console.error('Error loading branch calendar:', error);
            container.innerHTML = '<div style="text-align: center; color: #EF4444; padding: 40px;">Branş bazında görünüm yüklenemedi</div>';
        }
    }

    async loadMonthlyCalendarView() {
         
        const container = document.getElementById('calendarContent');
        if (!container) return;

        try {
            const result = await supabaseService.getTrainings();
            const trainings = result.success ? result.data : [];
            
            const today = new Date();
            const currentMonth = this.currentMonth !== undefined ? this.currentMonth : today.getMonth();
            const currentYear = this.currentYear !== undefined ? this.currentYear : today.getFullYear();
            
            // Store current values
            this.currentMonth = currentMonth;
            this.currentYear = currentYear;
            
            // Get first day of month and calculate grid start
            const firstDayOfMonth = new Date(currentYear, currentMonth, 1);
            const lastDayOfMonth = new Date(currentYear, currentMonth + 1, 0);
            
            // Calculate start of calendar grid (Monday of first week)
            const startOfGrid = new Date(firstDayOfMonth);
            const dayOfWeek = firstDayOfMonth.getDay();
            const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
            startOfGrid.setDate(firstDayOfMonth.getDate() + daysToMonday);
            
            // Generate 42 days (6 weeks)
            const calendarDays = [];
            for (let i = 0; i < 42; i++) {
                const day = new Date(startOfGrid);
                day.setDate(startOfGrid.getDate() + i);
                calendarDays.push(day);
            }
            
            const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 
                              'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
            const dayNames = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

            container.innerHTML = `
            <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                <!-- Ay başlığı ve yılı daha büyük ve ortada -->
                <h2 style="text-align: center; margin: 0 0 20px 0; color: #1F2937; font-size: 24px; font-weight: 700;">
                    ${monthNames[currentMonth]} ${currentYear}
                </h2>
                
                <!-- Hafta günleri başlıkları -->
                <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; margin-bottom: 8px; background: #E5E7EB; padding: 1px; border-radius: 6px;">
                    ${['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'].map(day => `
                        <div style="
                            text-align: center; 
                            padding: 12px 8px; 
                            background: #F3F4F6; 
                            font-weight: 600; 
                            color: #4B5563; 
                            font-size: 14px;
                            border-radius: 4px;
                        ">${day}</div>
                    `).join('')}
                </div>
                
                <!-- Takvim ızgarası -->
                <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; background: #E5E7EB; padding: 1px; border-radius: 8px; overflow: hidden;">
                    ${calendarDays.map(day => {
                        const isCurrentMonth = day.getMonth() === currentMonth;
                        const isToday = day.toDateString() === today.toDateString();
                        const dayTrainings = trainings.filter(training => {
                            const trainingDate = new Date(training.date);
                            return trainingDate.toDateString() === day.toDateString();
                        });
                        
                        return `
                            <div class="calendar-day ${!isCurrentMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}" 
                                 style="
                                     background: white; 
                                     padding: 12px 8px; 
                                     min-height: 120px; 
                                     border: 1px solid #E5E7EB;
                                     ${!isCurrentMonth ? 'background: #F9FAFB; color: #9CA3AF;' : ''}
                                     ${isToday ? 'background: #FEF2F2; border: 2px solid #FECACA;' : ''}
                                     transition: all 0.2s ease;
                                     box-shadow: 0 1px 2px rgba(0,0,0,0.05);
                                 ">
                                <div style="
                                    font-weight: ${isToday ? '700' : '600'}; 
                                    color: ${isCurrentMonth ? (isToday ? '#DC2626' : '#1F2937') : '#9CA3AF'};
                                    margin-bottom: 8px;
                                    font-size: 15px;
                                    text-align: right;
                                ">
                                    ${day.getDate()}
                                </div>
                                
                                ${dayTrainings.slice(0, 2).map(training => `
                                    <div data-allow-dblclick="true" style="
                                        background-color: ${this.sportColorMap[training.sport] || '#6B7280'};
                                        color: white;
                                        padding: 4px 8px;
                                        margin-bottom: 4px;
                                        border-radius: 4px;
                                        font-size: 12px;
                                        white-space: nowrap;
                                        overflow: hidden;
                                        text-overflow: ellipsis;
                                        cursor: pointer;
                                        box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                                    " onclick="app.handleTrainingClick('${training.id}', event)" ondblclick="app.handleTrainingDblClick('${training.id}', event)">
                                        ${training.sport || 'Antrenman'} 
                                        ${training.start_time ? training.start_time.substring(0, 5) : ''}
                                    </div>
                                `).join('')}
                                
                                ${dayTrainings.length > 2 ? `
                                    <div style="
                                        background: #F3F4F6;
                                        color: #6B7280;
                                        padding: 4px 8px;
                                        border-radius: 4px;
                                        font-size: 11px;
                                        text-align: center;
                                        margin-top: 4px;
                                    ">
                                        +${dayTrainings.length - 2} daha
                                    </div>
                                ` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
            
        } catch (error) {
            console.error('Error loading monthly calendar:', error);
            container.innerHTML = '<div style="text-align: center; color: #EF4444; padding: 40px;">Aylık takvim yüklenemedi</div>';
        }
    }

    previousMonth() {
        if (!this.currentMonth) this.currentMonth = new Date().getMonth();
        if (!this.currentYear) this.currentYear = new Date().getFullYear();
        
        this.currentMonth--;
        if (this.currentMonth < 0) {
            this.currentMonth = 11;
            this.currentYear--;
        }
        this.loadMonthlyCalendarView();
    }

    nextMonth() {
        if (!this.currentMonth) this.currentMonth = new Date().getMonth();
        if (!this.currentYear) this.currentYear = new Date().getFullYear();
        
        this.currentMonth++;
        if (this.currentMonth > 11) {
            this.currentMonth = 0;
            this.currentYear++;
        }
        this.loadMonthlyCalendarView();
    }

    addTrainingForDate(dateString) {
        this.selectedTrainingDate = dateString;
        this.showTrainingModal();
    }

    async showTrainingModal() {
        const modal = document.getElementById('trainingModal');
        if (modal) {
            modal.style.display = 'flex';
            modal.style.alignItems = 'center';
            modal.style.justifyContent = 'center';
            modal.style.position = 'fixed';
            modal.style.top = '0';
            modal.style.left = '0';
            modal.style.width = '100%';
            modal.style.height = '100%';
            modal.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
            modal.style.zIndex = '1000';
            
            // Load sport branches from Supabase
            await this.loadTrainingSportOptions();
            
            // Set today's date if no date is selected
            const dateInput = document.getElementById('trainingDate');
            if (dateInput && this.selectedTrainingDate) {
                dateInput.value = this.selectedTrainingDate;
            } else if (dateInput) {
                dateInput.value = new Date().toISOString().split('T')[0];
            }
        }
    }

    async loadTrainingSportOptions() {
        const sportSelect = document.getElementById('trainingSport');
        if (!sportSelect) return;

        try {
            const result = await supabaseService.getSportBranches();
            
            // Clear existing options except the first one
            sportSelect.innerHTML = '<option value="">Branş Seçin</option>';
            
            if (result.success && result.data) {
                result.data.forEach(branch => {
                    const option = document.createElement('option');
                    option.value = branch.name || branch.sport_name;
                    option.textContent = branch.name || branch.sport_name;
                    sportSelect.appendChild(option);
                });
            } else {
                console.error('Error loading sport branches:', result.error);
            }
        } catch (error) {
            console.error('Error loading sport options:', error);
        }
    }

    hideTrainingModal() {
        const modal = document.getElementById('trainingModal');
        if (modal) {
            modal.style.display = 'none';
        }
        this.selectedTrainingDate = null;
    }

    async showAttendanceModal(trainingId) {
        const modal = document.getElementById('attendanceModal');
        if (!modal) return;

        try {
            // Get training details
            const trainingResult = await supabaseService.getTraining(trainingId);
            if (!trainingResult.success) {
                alert('Antrenman bilgileri yüklenemedi');
                return;
            }

            const training = trainingResult.data;
            
            // Get students for this training's sport and age group
            const studentsResult = await supabaseService.getStudents();
            const allStudents = studentsResult.success ? studentsResult.data : [];
            
            // Filter students by sport and age group
            const relevantStudents = allStudents.filter(student => 
                !student.is_deleted && 
                this.getSportText(student.sport) === training.sport
            );

            // Show modal
            modal.style.display = 'flex';
            modal.style.alignItems = 'center';
            modal.style.justifyContent = 'center';
            modal.style.position = 'fixed';
            modal.style.top = '0';
            modal.style.left = '0';
            modal.style.width = '100%';
            modal.style.height = '100%';
            modal.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
            modal.style.zIndex = '1000';

            // Update training info
            const trainingInfo = document.getElementById('attendanceTrainingInfo');
            const trainingDetails = document.getElementById('attendanceTrainingDetails');
            
            if (trainingInfo) {
                trainingInfo.textContent = `${training.sport} - ${training.age_group || 'Yaş grubu belirtilmemiş'}`;
            }
            
            if (trainingDetails) {
                const trainingDate = new Date(training.date);
                trainingDetails.textContent = `${trainingDate.toLocaleDateString('tr-TR')} | ${(training.start_time || '').substring(0, 5)} - ${(training.end_time || '').substring(0, 5)} | ${training.location || 'Konum belirtilmemiş'}`;
            }

            // Load attendance list and try to get existing attendance
            this.loadAttendanceList(trainingId, relevantStudents);
            
        } catch (error) {
            console.error('Error showing attendance modal:', error);
            alert('Katılım takibi yüklenemedi. Lütfen tekrar deneyin.');
        }
    }

    async loadAttendanceList(trainingId, students, existingAttendance = null) {
        const attendanceList = document.getElementById('attendanceList');
        if (!attendanceList) return;

        try {
            // Always try to get existing attendance records from database
            let attendanceData = [];
            try {
                const attendanceResult = await supabaseService.getTrainingAttendance(trainingId);
                attendanceData = attendanceResult.success ? attendanceResult.data : [];
                console.log('Loaded attendance data:', attendanceData);
            } catch (error) {
                console.warn('Could not load existing attendance, starting fresh:', error);
                attendanceData = [];
            }

            // Store current training ID for save function
            this.currentTrainingId = trainingId;
            this.attendanceData = {};

            attendanceList.innerHTML = students.map(student => {
                const attendance = attendanceData.find(a => a.student_id === student.id);
                const attendanceStatus = attendance ? (attendance.status === 'present' ? 'present' : 'absent') : 'none';
  
                // Store initial attendance data
                this.attendanceData[student.id] = attendanceStatus;

                return `
                    <div style="display: flex; align-items: center; justify-content: space-between; padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px; margin-bottom: 12px; background: white;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="width: 48px; height: 48px; border-radius: 50%; background: #F3F4F6; display: flex; align-items: center; justify-content: center; overflow: hidden;">
                                ${(student.photo_thumb_url || student.photo_url) ? 
                                    `<img src="${student.photo_thumb_url || student.photo_url}" style="width: 100%; height: 100%; object-fit: cover;">` :
                                    `<i class="fas fa-user" style="color: #9CA3AF; font-size: 20px;"></i>`
                                }
                            </div>
                            <div>
                                <div style="font-weight: 600; color: #374151; margin-bottom: 4px;">
                                    ${student.name} ${student.surname}
                                </div>
                                <div style="font-size: 12px; color: #6B7280;">
                                    ${this.getSportText(student.sport) || 'Belirtilmemiş'} - Yaş grubu belirtilmemiş
                                </div>
                            </div>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <button onclick="app.selectAttendance('${student.id}', true)" 
                                    id="present-${student.id}"
                                    style="background: ${attendanceStatus === 'present' ? '#10B981' : '#F3F4F6'}; color: ${attendanceStatus === 'present' ? 'white' : '#6B7280'}; border: none; padding: 10px 20px; border-radius: 20px; cursor: pointer; font-weight: 500; font-size: 12px; transition: all 0.2s;">
                                Katıldı
                            </button>
                            <button onclick="app.selectAttendance('${student.id}', false)" 
                                    id="absent-${student.id}"
                                    style="background: ${attendanceStatus === 'absent' ? '#EF4444' : '#F3F4F6'}; color: ${attendanceStatus === 'absent' ? 'white' : '#6B7280'}; border: none; padding: 10px 20px; border-radius: 20px; cursor: pointer; font-weight: 500; font-size: 12px; transition: all 0.2s;">
                                Katılmadı
                            </button>
                        </div>
                    </div>
                `;
            }).join('');

        } catch (error) {
            console.error('Error loading attendance list:', error);
            attendanceList.innerHTML = '<div style="text-align: center; color: #EF4444; padding: 20px;">Katılım listesi yüklenemedi</div>';
        }
    }

    selectAttendance(studentId, isPresent) {
        // Update attendance data
        this.attendanceData[studentId] = isPresent ? 'present' : 'absent';
        
        // Update button styles
        const presentBtn = document.getElementById(`present-${studentId}`);
        const absentBtn = document.getElementById(`absent-${studentId}`);
        
        if (presentBtn && absentBtn) {
            if (isPresent) {
                // Present selected
                presentBtn.style.background = '#10B981';
                presentBtn.style.color = 'white';
                absentBtn.style.background = '#F3F4F6';
                absentBtn.style.color = '#6B7280';
            } else {
                // Absent selected
                absentBtn.style.background = '#EF4444';
                absentBtn.style.color = 'white';
                presentBtn.style.background = '#F3F4F6';
                presentBtn.style.color = '#6B7280';
            }
        }
    }

    hideAttendanceModal() {
        const modal = document.getElementById('attendanceModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    async saveAttendance() {
        if (!this.currentTrainingId || !this.attendanceData) {
            alert('Katılım verileri bulunamadı');
            return;
        }

        try {
            const savePromises = [];
            
            // Process each student's attendance
            for (const [studentId, status] of Object.entries(this.attendanceData)) {
                if (status === 'present' || status === 'absent') {
                    const isPresent = status === 'present';
                    savePromises.push(
                        supabaseService.markTrainingAttendance(studentId, this.currentTrainingId, isPresent)
                    );
                }
            }

            // Save all attendance records
            const results = await Promise.all(savePromises);
            
            // Check if all saves were successful
            const failedSaves = results.filter(result => !result.success);
            
            if (failedSaves.length === 0) {
                alert('Tüm katılım durumları başarıyla kaydedildi!');
                this.hideAttendanceModal();
            } else {
                alert(`${failedSaves.length} katılım kaydı başarısız oldu. Lütfen tekrar deneyin.`);
            }
            
        } catch (error) {
            console.error('Error saving attendance:', error);
            alert('Katılım durumları kaydedilemedi. Lütfen tekrar deneyin.');
        }
    }

    async editTrainingFromAttendance() {
        if (!this.currentTrainingId) {
            alert('Antrenman ID bulunamadı');
            return;
        }

        try {
            // Get training details from database
            const trainingResult = await supabaseService.getTraining(this.currentTrainingId);
            if (!trainingResult.success) {
                alert('Antrenman bilgileri yüklenemedi: ' + this.formatErrorMessage(trainingResult.error));
                return;
            }

            const training = trainingResult.data;
            
            // Close attendance modal and open edit modal
            this.hideAttendanceModal();
            this.showTrainingEditModal(training);
            
        } catch (error) {
            console.error('Error loading training for edit:', error);
            alert('Antrenman düzenleme yüklenirken hata oluştu');
        }
    }

    async showTrainingEditModal(training = null) {
        const modal = document.getElementById('trainingEditModal');
        if (!modal) return;

        // Show modal
        modal.style.display = 'flex';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100%';
        modal.style.height = '100%';
        modal.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
        modal.style.zIndex = '1000';

        // Load sport branches for dropdown
        await this.loadEditTrainingSportOptions();

        // If training data provided, populate form
        if (training) {
            this.currentEditingTrainingId = training.id;
            
            // Populate form fields
            const sportSelect = document.getElementById('editTrainingSport');
            const ageGroupSelect = document.getElementById('editTrainingAgeGroup');
            const dateInput = document.getElementById('editTrainingDate');
            const startTimeInput = document.getElementById('editTrainingStartTime');
            const endTimeInput = document.getElementById('editTrainingEndTime');
            const locationInput = document.getElementById('editTrainingLocation');
            const instructorInput = document.getElementById('editTrainingInstructor');
            const notesInput = document.getElementById('editTrainingNotes');

            if (sportSelect) sportSelect.value = training.sport || '';
            if (dateInput) dateInput.value = training.date || '';
            if (startTimeInput) startTimeInput.value = training.start_time || '';
            if (endTimeInput) endTimeInput.value = training.end_time || '';
            if (locationInput) locationInput.value = training.location || '';
            if (instructorInput) instructorInput.value = training.instructor || '';
            if (notesInput) notesInput.value = training.notes || '';

            // Load age groups for selected sport
            if (training.sport) {
                await this.loadEditTrainingAgeGroups();
                if (ageGroupSelect) ageGroupSelect.value = training.age_group || '';
            }
        }
    }

    async loadEditTrainingSportOptions() {
        const sportSelect = document.getElementById('editTrainingSport');
        if (!sportSelect) return;

        try {
            const result = await supabaseService.getSportBranches();
            
            // Clear existing options except the first one
            sportSelect.innerHTML = '<option value="">Branş Seçin</option>';
            
            if (result.success && result.data) {
                result.data.forEach(branch => {
                    const option = document.createElement('option');
                    option.value = branch.name || branch.sport_name;
                    option.textContent = branch.name || branch.sport_name;
                    sportSelect.appendChild(option);
                });
            }

            // Add event listener for age group loading
            sportSelect.addEventListener('change', () => this.loadEditTrainingAgeGroups());
        } catch (error) {
            console.error('Error loading sport options for edit:', error);
        }
    }

    async loadEditTrainingAgeGroups() {
        const sportSelect = document.getElementById('editTrainingSport');
        const ageGroupSelect = document.getElementById('editTrainingAgeGroup');
        
        if (!sportSelect || !ageGroupSelect) return;
        
        const selectedSport = sportSelect.value;
        
        // Clear existing options
        ageGroupSelect.innerHTML = '<option value="">Yaş grubu seçin</option>';
        
        if (!selectedSport) return;
        
        try {
            const result = await supabaseService.getSportBranches();
            
            if (result.success && result.data) {
                const selectedBranch = result.data.find(branch => 
                    (branch.name || branch.sport_name) === selectedSport
                );
                
                if (selectedBranch && selectedBranch.age_group) {
                    // Parse comma-separated age groups
                    const ageGroups = selectedBranch.age_group.split(',').map(group => group.trim());
                    
                    ageGroups.forEach(ageGroup => {
                        if (ageGroup) {
                            const option = document.createElement('option');
                            option.value = ageGroup;
                            option.textContent = ageGroup;
                            ageGroupSelect.appendChild(option);
                        }
                    });
                }
            }
        } catch (error) {
            console.error('Error loading age groups for edit:', error);
        }
    }

    hideTrainingEditModal() {
        const modal = document.getElementById('trainingEditModal');
        if (modal) {
            modal.style.display = 'none';
        }
        this.currentEditingTrainingId = null;
    }
    

    async updateTraining() {
        if (!this.currentEditingTrainingId) {
            alert('Güncellenecek antrenman bulunamadı');
            return;
        }

        // Get form data
        const sport = document.getElementById('editTrainingSport').value;
        const ageGroup = document.getElementById('editTrainingAgeGroup').value;
        const date = document.getElementById('editTrainingDate').value;
        const startTime = document.getElementById('editTrainingStartTime').value;
        const endTime = document.getElementById('editTrainingEndTime').value;
        const location = document.getElementById('editTrainingLocation').value;
        const instructor = document.getElementById('editTrainingInstructor').value;
        const notes = document.getElementById('editTrainingNotes').value;

        // Validate required fields
        if (!sport || !date || !startTime || !endTime) {
            alert('Lütfen zorunlu alanları doldurun (Branş, Tarih, Başlangıç ve Bitiş Saati)');
            return;
        }

        try {
            const trainingData = {
                sport,
                age_group: ageGroup,
                date,
                start_time: startTime,
                end_time: endTime,
                location,
                instructor,
                notes
            };

            const result = await supabaseService.updateTraining(this.currentEditingTrainingId, trainingData);
            
            if (result.success) {
                await supabaseService.addActivityLog(
                    'update',
                    'training',
                    this.currentEditingTrainingId,
                    `${trainingData.name || 'Antrenman'} güncellendi`
                );
                this.hideTrainingEditModal();
           
                alert('Antrenman başarıyla güncellendi!');
                // Refresh calendar if we're on calendar screen
                if (this.currentScreen === 'calendarScreen') {
                    await this.loadCalendarScreen();
                }
            } else {
                alert('Antrenman güncellenemedi: ' + this.formatErrorMessage(result.error));
            }
        } catch (error) {
            console.error('Error updating training:', error);
            alert('Antrenman güncellenemedi. Lütfen tekrar deneyin.');
        }
    }

    async deleteTraining() {
        if (!this.currentEditingTrainingId) {
            alert('Silinecek antrenman bulunamadı');
            return;
        }

        // Confirmation dialog
        const confirmDelete = confirm('Bu antrenmanı silmek istediğinizden emin misiniz?\n\nBu işlem geri alınamaz ve antrenmanla ilgili tüm katılım kayıtları da silinecektir.');
        
        if (!confirmDelete) {
            return;
        }

        try {
            const result = await supabaseService.deleteTraining(this.currentEditingTrainingId);
            
            if (result.success) {
                await supabaseService.addActivityLog(
                    'delete',
                    'training',
                    this.currentEditingTrainingId,
                    'Antrenman silindi'
                );
                alert('Antrenman başarıyla silindi!');
                this.hideTrainingEditModal();
                
                // Refresh calendar if we're on calendar screen
                if (this.currentScreen === 'calendarScreen') {
                    await this.loadCalendarScreen();
                }
            } else {
                alert('Antrenman silinemedi: ' + this.formatErrorMessage(result.error));
            }
        } catch (error) {
            console.error('Error deleting training:', error);
            alert('Antrenman silinemedi. Lütfen tekrar deneyin.');
        }
    }

    async loadTrainingAgeGroups() {
        const sportSelect = document.getElementById('trainingSport');
        const ageGroupSelect = document.getElementById('trainingAgeGroup');
        
        if (!sportSelect || !ageGroupSelect) return;
        
        const selectedSport = sportSelect.value;
        
        // Clear existing options
        ageGroupSelect.innerHTML = '<option value="">Yaş grubu seçin</option>';
        
        if (!selectedSport) {
            ageGroupSelect.innerHTML = '<option value="">Önce branş seçin</option>';
            return;
        }
        
        try {
            // Get sport branches from Supabase
            const result = await supabaseService.getSportBranches();
            
            if (result.success && result.data) {
                // Find the selected sport branch
                const selectedBranch = result.data.find(branch => 
                    branch.name === selectedSport || branch.sport_name === selectedSport
                );
                
                if (selectedBranch && selectedBranch.age_group) {
                    // Parse age groups (assuming they're comma-separated)
                    const ageGroups = selectedBranch.age_group.split(',').map(group => group.trim());
                    
                    ageGroups.forEach(ageGroup => {
                        const option = document.createElement('option');
                        option.value = ageGroup;
                        option.textContent = ageGroup;
                        ageGroupSelect.appendChild(option);
                    });
                } else {
                    // Fallback if no age groups found
                    ageGroupSelect.innerHTML = '<option value="">Bu branş için yaş grubu bulunamadı</option>';
                }
            } else {
                console.error('Error loading sport branches:', result.error);
                ageGroupSelect.innerHTML = '<option value="">Yaş grupları yüklenemedi</option>';
            }
        } catch (error) {
            console.error('Error loading age groups:', error);
            ageGroupSelect.innerHTML = '<option value="">Yaş grupları yüklenemedi</option>';
        }
    }
    async printStudentForm(studentId) {
        const sportBranchesResult = await supabaseService.getSportBranches();
const sportBranches = sportBranchesResult.success ? sportBranchesResult.data : [];
        let student = {};
        
        if (!studentId || studentId === 'new') {
            // Yeni öğrenci için form verilerini al
            const form = document.getElementById('studentForm');
            if (form) {
                const formData = new FormData(form);
                student = {
                    name: formData.get('name') || '',
                    surname: formData.get('surname') || '',
                    tcno: formData.get('tcno') || '',
                    birth_date: formData.get('birthDate') || '',
                    birth_place: formData.get('birthPlace') || '',
                    school: formData.get('school') || '',
                    sport: formData.get('sport') || '',
                    height: formData.get('height') || '',
                    weight: formData.get('weight') || '',
                    blood_type: formData.get('bloodType') || '',
                    phone: formData.get('phone') || '',
                    father_tcno: formData.get('fatherTcno') || '',
                    father_name: formData.get('fatherName') || '',
                    father_job: formData.get('fatherJob') || '',
                    father_phone: formData.get('fatherPhone') || '',
                    mother_tcno: formData.get('motherTcno') || '',
                    mother_name: formData.get('motherName') || '',
                    mother_job: formData.get('motherJob') || '',
                    mother_phone: formData.get('motherPhone') || '',
                    emergency_relation: formData.get('emergencyRelation') || '',
                    emergency_name: formData.get('emergencyName') || '',
                    emergency_phone: formData.get('emergencyPhone') || '',
                    age_group: (() => {
                        const sport = formData.get('sport') || '';
                        const branch = sportBranches.find(b => b.name === sport);
                        return branch?.age_group || formData.get('ageGroup') || '';
                    })(),
                    address: formData.get('address') || '',
                    notes: formData.get('notes') || '',
                        photo_url: (() => {
                            const photoInput = document.querySelector('input[name="photo"]');
                            if (photoInput && photoInput.files && photoInput.files[0]) {
                                // Seçilen dosyayı base64'e çevir
                                return URL.createObjectURL(photoInput.files[0]);
                            }
                            return '';
                        })()
                };
            }
        } else {
            try {
                // Mevcut öğrenci için database'den bilgileri çek
                const result = await supabaseService.getStudentById(studentId);
                if (!result.success) {
                    alert('Öğrenci bilgileri alınamadı: ' + this.formatErrorMessage(result.error));
                    return;
                }
                student = result.data;
                // Age group'u spor branşından al
if (student.sport && sportBranches.length > 0) {
    const branch = sportBranches.find(b => b.name === student.sport);
    if (branch && branch.age_group) {
        student.age_group = branch.age_group;
    }
}
            } catch (error) {
                console.error('Error loading student:', error);
                alert('Öğrenci bilgileri yüklenemedi. Lütfen tekrar deneyin.');
                return;
            }
        }
    
    try {
        // iOS Safari detection
        const isIOSSafari = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        
        if (isIOSSafari) {
            // iOS Safari için alternatif print yöntemi
            this.printFormIOS(student);
            return;
        }
        
        // Yazdırma penceresi oluştur
        const printWindow = window.open('', '_blank', 'width=800,height=600');
        
        if (!printWindow) {
            alert('Popup engelleyici aktif. Lütfen popupları etkinleştirin.');
            return;
        }
        
        const printContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>ATKÖYSPOR KULÜBÜ SPORCU KAYIT FORMU</title>
                    <style>
                        @page { 
                            size: A4; 
                            margin: 10mm; 
                        }
                        body { 
                            font-family: Arial, sans-serif; 
                            margin: 0; 
                            padding: 0;
                            font-size: 12px; 
                            line-height: 1.3;
                        }
                        .header { 
                            display: flex; 
                            align-items: center; 
                            border: 2px solid #000; 
                            margin-bottom: 8px; 
                            height: 80px;
                        }
       .logo { 
    width: 80px; 
    height: 80px; 
    border-right: 2px solid #000; 
    display: flex; 
    align-items: center; 
    justify-content: center; 
    background: white;
    font-size: 9px;
    font-weight: bold;
    color: #dc2626;
    text-align: center;
    line-height: 1.1;
}
.logo img {
    width: 70px;
    height: 70px;
    object-fit: contain;
}
                        .title { 
                            flex: 1; 
                            text-align: center; 
                            font-weight: bold; 
                            font-size: 16px; 
                            padding: 10px;
                            line-height: 1.3;
                        }
                        .photo-box { 
                            width: 80px; 
                            height: 80px; 
                            border-left: 2px solid #000; 
                            display: flex; 
                            align-items: center; 
                            justify-content: center; 
                            background: #f0f0f0; 
                            font-size: 8px;
                            text-align: center;
                        }
                        .section { 
                            margin-bottom: 12px; 
                        }
                        .section-title { 
                            background: #dc2626; 
                            color: white; 
                            padding: 7px; 
                            text-align: center; 
                            font-weight: bold; 
                            margin-bottom: 6px; 
                            font-size: 12px;
                            -webkit-print-color-adjust: exact;
                            color-adjust: exact;
                        }
                        .form-row { 
                            display: flex; 
                            margin-bottom: 5px; 
                        }
                        .form-field { 
                            flex: 1; 
                            padding: 6px; 
                            border: 1px solid #ccc; 
                            margin-right: 4px; 
                            background: #f9f9f9; 
                            min-height: 18px;
                            display: flex;
                            align-items: center;
                            font-size: 10px;
                        }
                            .form-field.address-field {
    min-height: 50px;
    padding: 8px;
}.form-field.signature-field {
    min-height: 40px;
    padding: 10px;
}
                        .form-field:last-child { 
                            margin-right: 0; 
                        }
                        .form-field strong { 
                            margin-right: 6px; 
                            font-weight: bold;
                        }
                        .full-width { 
                            width: 100%; 
                        }
                        .consent-text { 
                            font-size: 11px; 
                            line-height: 1.3; 
                            text-align: justify; 
                            margin: 8px 0; 
                        }
                        .signature-section { 
                            display: flex; 
                            justify-content: space-between; 
                            margin-top: 15px; 
                        }
               .signature-box { 
    width: 160px; 
    text-align: center; 
    border: 1px solid #000; 
    padding: 10px; 
    margin: 2px;
    min-height: 40px;
    font-size: 9px;
}
                        .footer { 
                            background: #dc2626; 
                            color: white; 
                            text-align: center; 
                            padding: 6px; 
                            margin-top: 10px; 
                            font-weight: bold; 
                            font-size: 10px;
                            -webkit-print-color-adjust: exact;
                            color-adjust: exact;
                        }
                    </style>
                </head>
                <body>
                    <!-- Header -->
                    <div class="header">
         <div class="logo">
    <img src="atkoy.jpeg" alt="ATKÖYSPOR KULÜBÜ" onerror="this.style.display='none'; this.parentElement.innerHTML='ATKÖYSPOR<br>KULÜBÜ<br>LOGOSU';">
</div>
                        <div class="title">
                            ATKÖYSPOR KULÜBÜ<br>
                            SPORCU KAYIT FORMU
                        </div>
                        <div class="photo-box">
                            ${(student.photo_thumb_url || student.photo_url) ? `<img src="${student.photo_thumb_url || student.photo_url}" style="width: 70px; height: 70px; object-fit: cover;">` : '[photo_url]'}
                        </div>
                    </div>
    
                    <!-- Öğrenci Bilgileri -->
                    <div class="section">
                        <div class="section-title">Öğrenci Bilgileri</div>
                        <div class="form-row">
                            <div class="form-field"><strong>TC Kimlik No:</strong> ${student.tcno || '[tc_no]'}</div>
                            <div class="form-field"><strong>Boy:</strong> ${student.height || '[height]'}</div>
                        </div>
                        <div class="form-row">
                            <div class="form-field"><strong>Adı Soyadı:</strong> ${student.name || '[first_name]'} ${student.surname || '[last_name]'}</div>
                            <div class="form-field"><strong>Kilo:</strong> ${student.weight || '[weight]'}</div>
                        </div>
                      <div class="form-row">
    <div class="form-field"><strong>Doğum Yeri ve Tarihi:</strong> ${student.birth_place || '[birth_place]'} / ${student.birth_date ? new Date(student.birth_date).toLocaleDateString('tr-TR') : '[birth_date]'}</div>
    <div class="form-field"><strong>Kan Grubu:</strong> ${student.blood_type || '[blood_type]'}</div>
</div>
                        <div class="form-row">
                            <div class="form-field"><strong>Okulu:</strong> ${student.school || '[school]'}</div>
                            <div class="form-field"><strong>Öğrenci Tel:</strong> ${student.phone || '[student_phone]'}</div>
                        </div>
                    </div>
    
                    <!-- Öğrenci Veli Bilgileri -->
                    <div class="section">
                        <div class="section-title">Öğrenci Veli Bilgileri</div>
                        <div class="form-row">
                            <div class="form-field"><strong>Baba Adı:</strong> ${student.father_name || '[father_name]'}</div>
                            <div class="form-field"><strong>Telefonu:</strong> ${student.father_phone || '[father_phone]'}</div>
                        </div>
                        <div class="form-row">
                            <div class="form-field"><strong>Anne Adı:</strong> ${student.mother_name || '[mother_name]'}</div>
                            <div class="form-field"><strong>Telefonu:</strong> ${student.mother_phone || '[mother_phone]'}</div>
                        </div>
                       <div class="form-row">
    <div class="form-field full-width address-field"><strong>Ev Adresi:</strong> ${student.address || '[address]'}</div>
</div>
                    </div>
    
                    <!-- Acil Durumlarda Veli Dışında Ulaşılabilecek Kişiler -->
                    <div class="section">
                        <div class="section-title">Acil Durumlarda Veli Dışında Ulaşılabilecek Kişiler</div>
                        <div class="form-row">
                            <div class="form-field"><strong>Yakınlık Derecesi:</strong> ${student.emergency_relation || '[emergency_contact_relation]'}</div>
                            <div class="form-field"><strong>Telefonu:</strong> ${student.emergency_phone || '[emergency_contact_phone]'}</div>
                        </div>
                        <div class="form-row">
                            <div class="form-field full-width"><strong>Adı Soyadı:</strong> ${student.emergency_name || '[emergency_contact_name]'}</div>
                        </div>
                    </div>
    
                    <!-- Velinin Muvafakatı -->
                    <div class="section">
                        <div class="section-title">Velinin Muvafakatı</div>
                        <div class="consent-text">
                            Velisi bulunduğumuz <strong>${student.birth_date ? new Date(student.birth_date).toLocaleDateString('tr-TR') : '[birth_date]'}</strong> Doğum tarihli <strong>${student.name || '[first_name]'} ${student.surname || '[last_name]'}</strong> 'nın Atköyspor Kulübü Altyapısında yapılacağı olarak, antrenmanlarla, müsabakalarla katılımında rıza ederim.
                            <br><br>
                           Yukarıda açık kimliği yazılı bulunan <strong>${student.name || '[first_name]'} ${student.surname || '[last_name]'}</strong> 'nın Atköyspor Kulübü Altyapısında yapılacağı olan antrenmanlarla, müsabakalarla katılımında rıza ederim. Bunlar sırasında ortaya çıkabilecek her türlü olumsuz durumda Atköyspor Kulübünü sorumlu tutmayacağım peşinen ve gayrikabili rücu esasla beyan ederim.
                        </div>
                      <!-- İmza Bölümü -->
<div class="signature-section">
    <div class="signature-box">
        <strong>Veli Adı Soyadı</strong><br>
        ${student.father_name || '[father_name]'}
    </div>
    <div class="signature-box">
        <strong>Veli T.C. Kimlik</strong><br>
        ${student.father_tcno || '[father_tc_no]'}
    </div>
   <div class="signature-box">
    <strong>Tarih</strong><br>
    ${new Date().toLocaleDateString('tr-TR')}
</div>
   <div class="signature-box">
        <strong>İmzası</strong>
    </div>
</div>
                    </div>
    
                   <!-- Sağlık Beyannamesi -->
<div class="section">
    <div class="section-title">Sağlık Beyannamesi</div>
    <div class="consent-text">
        Beyanlar kurulundaki çocuğumun spor yapmaya elverişli olduğunu ve tarafımızca da bu husus teşhis veya teşvik edilmiş bulunduğundan altyapı çalışmaları sırasında meydana gelebilecek sakatlık, hastalık, yaralanma ve bunlar sırasında ortaya çıkabilecek her türlü olumsuz durumda Atköyspor Kulübünü sorumlu tutmayacağım peşinen ve gayrikabili rücu esasla beyan ederim.
    </div>
    <div class="form-row">
        <div class="form-field signature-field"><strong>Veli Adı Soyadı:</strong> ${student.father_name || '[father_name]'}</div>
        <div class="form-field signature-field"><strong>İmza:</strong></div>
    </div>
</div>
    
                 

<!-- Footer -->
<div class="footer">
    Aşağıdaki Bölüm Atköyspor Kulübü Tarafından Doldurulacaktır.
</div>    
                  <div class="form-row" style="margin-top: 6px;">
    <div class="form-field"><strong>Kayıt Yapanın Adı Soyadı:</strong> ${(() => {
        const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
        return currentUser.name || 'Admin';
    })()}</div>
    <div class="form-field"><strong>Yaş Grubu:</strong> ${student.age_group || '[age_group]'}</div>
</div>
                </body>
                </html>
            `;
    
            printWindow.document.write(printContent);
            printWindow.document.close();
            
            // Yazdırma diyaloğunu aç
            setTimeout(() => {
                printWindow.print();
            }, 500);
    
        } catch (error) {
            console.error('Error printing form:', error);
            alert('Form yazdırılırken hata oluştu: ' + error.message);
        }
    }

    // iOS Safari için özel print fonksiyonu - BLOB URL kullan
    printFormIOS(student) {
        try {
            // iOS Safari için blob URL yöntemi kullan
            
            // Windows'da çalışan AYNI kodu kullan
            const printContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>ATKÖYSPOR KULÜBÜ SPORCU KAYIT FORMU</title>
                    <style>
                        @page { size: A4; margin: 10mm; }
                        body { font-family: Arial, sans-serif; font-size: 10px; line-height: 1.2; margin: 0; padding: 0; }
                        .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; border-bottom: 2px solid #dc2626; padding-bottom: 6px; }
                        .logo { width: 70px; height: 70px; border: 1px solid #ccc; display: flex; align-items: center; justify-content: center; font-size: 8px; text-align: center; font-weight: bold; overflow: hidden; }
                        .logo img { width: 60px; height: 60px; object-fit: contain; }
                        .title { flex: 1; text-align: center; font-weight: bold; font-size: 14px; color: #dc2626; margin: 0 10px; }
                        .photo-box { width: 70px; height: 70px; border: 1px solid #ccc; display: flex; align-items: center; justify-content: center; font-size: 8px; }
                        .section { margin-bottom: 8px; }
                        .section-title { background: #dc2626; color: white; padding: 7px; text-align: center; font-weight: bold; margin-bottom: 6px; font-size: 12px; -webkit-print-color-adjust: exact; color-adjust: exact; }
                        .form-row { display: flex; margin-bottom: 5px; }
                        .form-field { flex: 1; padding: 6px; border: 1px solid #ccc; margin-right: 4px; background: #f9f9f9; min-height: 18px; display: flex; align-items: center; font-size: 10px; }
                        .form-field.address-field { min-height: 50px; padding: 8px; }
                        .form-field.signature-field { min-height: 40px; padding: 10px; }
                        .form-field:last-child { margin-right: 0; }
                        .form-field strong { margin-right: 6px; font-weight: bold; }
                        .full-width { width: 100%; }
                        .consent-text { font-size: 11px; line-height: 1.3; text-align: justify; margin: 8px 0; }
                        .signature-section { display: flex; justify-content: space-between; margin-top: 10px; }
                        .signature-box { flex: 1; border: 1px solid #ccc; padding: 15px; margin-right: 5px; text-align: center; min-height: 40px; }
                        .signature-box:last-child { margin-right: 0; }
                        .footer { background: #dc2626; color: white; text-align: center; padding: 6px; margin-top: 10px; font-weight: bold; font-size: 10px; -webkit-print-color-adjust: exact; color-adjust: exact; }
                    </style>
                </head>
                <body>
                    <!-- Header -->
                    <div class="header">
                        <div class="logo">
                            <img src="atkoy.jpeg" alt="ATKÖYSPOR KULÜBÜ" style="width: 60px; height: 60px; object-fit: contain;" onerror="this.style.display='none'; this.parentElement.innerHTML='ATKÖY<br>SPOR';">
                        </div>
                        <div class="title">
                            ATKÖYSPOR KULÜBÜ<br>
                            SPORCU KAYIT FORMU
                        </div>
                        <div class="photo-box">
                            ${(student.photo_thumb_url || student.photo_url) ? `<img src="${student.photo_thumb_url || student.photo_url}" style="width: 70px; height: 70px; object-fit: cover;">` : '[photo_url]'}
                        </div>
                    </div>
    
                    <!-- Öğrenci Bilgileri -->
                    <div class="section">
                        <div class="section-title">Öğrenci Bilgileri</div>
                        <div class="form-row">
                            <div class="form-field"><strong>TC Kimlik No:</strong> ${student.tcno || '[tc_no]'}</div>
                            <div class="form-field"><strong>Boy:</strong> ${student.height || '[height]'}</div>
                        </div>
                        <div class="form-row">
                            <div class="form-field"><strong>Adı Soyadı:</strong> ${student.name || '[first_name]'} ${student.surname || '[last_name]'}</div>
                            <div class="form-field"><strong>Kilo:</strong> ${student.weight || '[weight]'}</div>
                        </div>
                        <div class="form-row">
                            <div class="form-field"><strong>Doğum Yeri ve Tarihi:</strong> ${student.birth_place || '[birth_place]'} / ${student.birth_date ? new Date(student.birth_date).toLocaleDateString('tr-TR') : '[birth_date]'}</div>
                            <div class="form-field"><strong>Kan Grubu:</strong> ${student.blood_type || '[blood_type]'}</div>
                        </div>
                        <div class="form-row">
                            <div class="form-field"><strong>Okulu:</strong> ${student.school || '[school]'}</div>
                            <div class="form-field"><strong>Öğrenci Tel:</strong> ${student.phone || '[student_phone]'}</div>
                        </div>
                    </div>
    
                    <!-- Öğrenci Veli Bilgileri -->
                    <div class="section">
                        <div class="section-title">Öğrenci Veli Bilgileri</div>
                        <div class="form-row">
                            <div class="form-field"><strong>Baba Adı:</strong> ${student.father_name || '[father_name]'}</div>
                            <div class="form-field"><strong>Telefonu:</strong> ${student.father_phone || '[father_phone]'}</div>
                        </div>
                        <div class="form-row">
                            <div class="form-field"><strong>Anne Adı:</strong> ${student.mother_name || '[mother_name]'}</div>
                            <div class="form-field"><strong>Telefonu:</strong> ${student.mother_phone || '[mother_phone]'}</div>
                        </div>
                        <div class="form-row">
                            <div class="form-field full-width address-field"><strong>Ev Adresi:</strong> ${student.address || '[address]'}</div>
                        </div>
                    </div>
    
                    <!-- Acil Durumlarda Veli Dışında Ulaşılabilecek Kişiler -->
                    <div class="section">
                        <div class="section-title">Acil Durumlarda Veli Dışında Ulaşılabilecek Kişiler</div>
                        <div class="form-row">
                            <div class="form-field"><strong>Yakınlık Derecesi:</strong> ${student.emergency_relation || '[emergency_contact_relation]'}</div>
                            <div class="form-field"><strong>Telefonu:</strong> ${student.emergency_phone || '[emergency_contact_phone]'}</div>
                        </div>
                        <div class="form-row">
                            <div class="form-field full-width"><strong>Adı Soyadı:</strong> ${student.emergency_name || '[emergency_contact_name]'}</div>
                        </div>
                    </div>
    
                    <!-- Velinin Muvafakatı -->
                    <div class="section">
                        <div class="section-title">Velinin Muvafakatı</div>
                        <div class="consent-text">
                            Velisi bulunduğumuz <strong>${student.birth_date ? new Date(student.birth_date).toLocaleDateString('tr-TR') : '[birth_date]'}</strong> Doğum tarihli <strong>${student.name || '[first_name]'} ${student.surname || '[last_name]'}</strong> 'nın Atköyspor Kulübü Altyapısında yapılacağı olarak, antrenmanlarla, müsabakalarla katılımında rıza ederim.
                            <br><br>
                            Yukarıda açık kimliği yazılı bulunan <strong>${student.name || '[first_name]'} ${student.surname || '[last_name]'}</strong> 'nın Atköyspor Kulübü Altyapısında yapılacağı olan antrenmanlarla, müsabakalarla katılımında rıza ederim. Bunlar sırasında ortaya çıkabilecek her türlü olumsuz durumda Atköyspor Kulübünü sorumlu tutmayacağım peşinen ve gayrikabili rücu esasla beyan ederim.
                        </div>
                        <div class="signature-section">
                            <div class="signature-box">
                                <strong>Veli Adı Soyadı</strong><br>
                                ${student.father_name || '[father_name]'}
                            </div>
                            <div class="signature-box">
                                <strong>Veli T.C. Kimlik</strong><br>
                                ${student.father_tcno || '[father_tc_no]'}
                            </div>
                            <div class="signature-box">
                                <strong>Tarih</strong><br>
                                ${new Date().toLocaleDateString('tr-TR')}
                            </div>
                            <div class="signature-box">
                                <strong>İmzası</strong>
                            </div>
                        </div>
                    </div>
    
                    <!-- Sağlık Beyannamesi -->
                    <div class="section">
                        <div class="section-title">Sağlık Beyannamesi</div>
                        <div class="consent-text">
                            Beyanlar kurulundaki çocuğumun spor yapmaya elverişli olduğunu ve tarafımızca da bu husus teşhis veya teşvik edilmiş bulunduğundan altyapı çalışmaları sırasında meydana gelebilecek sakatlık, hastalık, yaralanma ve bunlar sırasında ortaya çıkabilecek her türlü olumsuz durumda Atköyspor Kulübünü sorumlu tutmayacağım peşinen ve gayrikabili rücu esasla beyan ederim.
                        </div>
                        <div class="form-row">
                            <div class="form-field signature-field"><strong>Veli Adı Soyadı:</strong> ${student.father_name || '[father_name]'}</div>
                            <div class="form-field signature-field"><strong>İmza:</strong></div>
                        </div>
                    </div>
    
                    <!-- Footer -->
                    <div class="footer">
                        Aşağıdaki Bölüm Atköyspor Kulübü Tarafından Doldurulacaktır.
                    </div>    
                    <div class="form-row" style="margin-top: 6px;">
                        <div class="form-field"><strong>Kayıt Yapanın Adı Soyadı:</strong> ${(() => {
                            const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
                            return currentUser.name || 'Admin';
                        })()}</div>
                        <div class="form-field"><strong>Yaş Grubu:</strong> ${student.age_group || '[age_group]'}</div>
                    </div>
                </body>
                </html>
            `;
    
            // iOS Safari için iframe ön izleme yöntemi
            const iframe = document.createElement('iframe');
            iframe.style.position = 'fixed';
            iframe.style.top = '0';
            iframe.style.left = '0';
            iframe.style.width = '100%';
            iframe.style.height = '100%';
            iframe.style.zIndex = '9999';
            iframe.style.backgroundColor = 'white';
            iframe.style.border = 'none';
            
            // Kapatma butonu ekle
            const closeBtn = document.createElement('button');
            closeBtn.innerHTML = '✕ Kapat';
            closeBtn.title = 'Yazdırma önizlemesini kapat'; // Accessibility
            closeBtn.setAttribute('aria-label', 'Yazdırma önizlemesini kapat');
            closeBtn.style.position = 'fixed';
            closeBtn.style.top = '10px';
            closeBtn.style.right = '10px';
            closeBtn.style.zIndex = '10000';
            closeBtn.style.padding = '10px 15px';
            closeBtn.style.backgroundColor = '#dc2626';
            closeBtn.style.color = 'white';
            closeBtn.style.border = 'none';
            closeBtn.style.borderRadius = '5px';
            closeBtn.style.fontSize = '14px';
            closeBtn.style.cursor = 'pointer';
            
            // Print butonu ekle
            const printBtn = document.createElement('button');
            printBtn.innerHTML = '🖨️ Yazdır';
            printBtn.title = 'Sayfayı yazdır'; // Accessibility
            printBtn.setAttribute('aria-label', 'Sayfayı yazdır');
            printBtn.style.position = 'fixed';
            printBtn.style.top = '10px';
            printBtn.style.right = '80px';
            printBtn.style.zIndex = '10000';
            printBtn.style.padding = '10px 15px';
            printBtn.style.backgroundColor = '#059669';
            printBtn.style.color = 'white';
            printBtn.style.border = 'none';
            printBtn.style.borderRadius = '5px';
            printBtn.style.fontSize = '14px';
            printBtn.style.cursor = 'pointer';
            
            // Event listeners
            closeBtn.onclick = () => {
                document.body.removeChild(iframe);
                document.body.removeChild(closeBtn);
                document.body.removeChild(printBtn);
                document.body.style.overflow = 'auto';
            };
            
            printBtn.onclick = () => {
                iframe.contentWindow.print();
            };
            
            // Iframe'e içeriği yükle
            document.body.appendChild(iframe);
            document.body.appendChild(closeBtn);
            document.body.appendChild(printBtn);
            document.body.style.overflow = 'hidden';
            
            iframe.onload = () => {
                iframe.contentDocument.open();
                iframe.contentDocument.write(printContent);
                iframe.contentDocument.close();
            };
            
            // Fallback: direkt write
            setTimeout(() => {
                if (iframe.contentDocument) {
                    iframe.contentDocument.open();
                    iframe.contentDocument.write(printContent);
                    iframe.contentDocument.close();
                }
            }, 100);
            
        } catch (error) {
            console.error('iOS print error:', error);
            alert('Form yazdırılırken hata oluştu. Lütfen tekrar deneyin.');
        }
    }

    getSportBranchFee(sportName) {
        if (!this.sportBranches) return null;
        const branch = this.sportBranches.find(b => b.name === sportName);
        return branch ? branch.fee : null;
    }

    async updateCurrentMonthPaymentForStudent(studentId, newSport) {
        try {
            console.log(`🔄 ${studentId} öğrencisinin mevcut ay borcu güncelleniyor...`);
            
            const currentDate = new Date();
            const currentYear = currentDate.getFullYear();
            const currentMonth = currentDate.getMonth() + 1; // 1-12 arası
            
            // Öğrencinin bilgilerini al (indirim oranı için)
            const { data: studentData, error: studentError } = await supabaseService.supabase
                .from('students')
                .select('discount_rate')
                .eq('id', studentId)
                .single();
            
            if (studentError) {
                console.error('❌ Öğrenci bilgileri alınamadı:', studentError);
                return;
            }
            
            // Spor branşının base ücretini al
            const baseFee = this.getSportBranchFee(newSport) || 1000; // Varsayılan 1000 TL
            
            // İndirim oranını uygula
            const discountRate = studentData.discount_rate || 0;
            const discountAmount = (baseFee * discountRate) / 100;
            const finalFee = baseFee - discountAmount;
            
            console.log(`💰 Ücret hesaplama: ${baseFee} TL - %${discountRate} indirim = ${finalFee} TL`);
            
            // Mevcut aya ait ödenmemiş borç kaydını bul
            const { data: existingPayments, error: fetchError } = await supabaseService.supabase
                .from('payments')
                .select('*')
                .eq('student_id', studentId)
                .eq('period_year', currentYear)
                .eq('period_month', currentMonth)
                .eq('is_paid', false)
                .is('equipment_assignment_id', null);
            
            if (fetchError) {
                console.error('❌ Mevcut borç kaydı sorgulanırken hata:', fetchError);
                return;
            }
            
            if (existingPayments && existingPayments.length > 0) {
                // Mevcut borç kaydını güncelle
                const payment = existingPayments[0];
                const { error: updateError } = await supabaseService.supabase
                    .from('payments')
                    .update({
                        amount: finalFee
                    })
                    .eq('id', payment.id);
                
                if (updateError) {
                    console.error('❌ Borç kaydı güncellenirken hata:', updateError);
                } else {
                    console.log(`✅ Mevcut ay borcu güncellendi: ${payment.amount} TL → ${finalFee} TL`);
                }
            } else {
                // Mevcut aya ait borç kaydı yoksa yeni oluştur
                const dueDate = new Date(currentYear, currentMonth - 1, 1); // Ayın 1. günü
                const dueDateStr = dueDate.toISOString().split('T')[0];
                
                const { error: insertError } = await supabaseService.supabase
                    .from('payments')
                    .insert({
                        student_id: studentId,
                        amount: finalFee,
                        payment_date: dueDateStr,
                        is_paid: false,
                        equipment_assignment_id: null,
                        period_month: currentMonth,
                        period_year: currentYear,
                        created_at: new Date().toISOString()
                    });
                
                if (insertError) {
                    console.error('❌ Yeni borç kaydı oluşturulurken hata:', insertError);
                } else {
                    console.log(`✅ Yeni borç kaydı oluşturuldu: ${finalFee} TL`);
                }
            }
            
        } catch (error) {
            console.error('❌ Mevcut ay borcu güncelleme hatası:', error);
        }
    }

    async createMonthlyDebtsForActiveStudents() {
        try {
            console.log('🔄 Aktif öğrenciler için aylık borç oluşturuluyor...');
            
            const currentDate = new Date();
            const currentYear = currentDate.getFullYear();
            const currentMonth = currentDate.getMonth() + 1; // 1-12 arası
            
            // Aktif öğrencileri al
            const { data: activeStudents, error: studentsError } = await supabaseService.supabase
                .from('students')
                .select('*')
                .eq('status', 'active')
                .neq('deleted', true);
            
            if (studentsError) {
                console.error('❌ Aktif öğrenciler alınamadı:', studentsError);
                return;
            }
            
            console.log(`📊 ${activeStudents.length} aktif öğrenci bulundu`);
            
            // Her aktif öğrenci için borç kontrolü
            for (const student of activeStudents) {
                try {
                    // Bu öğrencinin mevcut aya ait borcu var mı kontrol et
                    const { data: existingPayments, error: paymentError } = await supabaseService.supabase
                        .from('payments')
                        .select('id')
                        .eq('student_id', student.id)
                        .eq('period_year', currentYear)
                        .eq('period_month', currentMonth)
                        .is('equipment_assignment_id', null);
                    
                    if (paymentError) {
                        console.error(`❌ ${student.name} ${student.surname} için borç kontrolü hatası:`, paymentError);
                        continue;
                    }
                    
                    // Eğer bu ay için borç kaydı yoksa oluştur
                    if (!existingPayments || existingPayments.length === 0) {
                        // Spor branşı ücretini al
                        const baseFee = this.getSportBranchFee(student.sport) || 1000;
                        
                        // İndirim oranını uygula
                        const discountRate = student.discount_rate || 0;
                        const discountAmount = (baseFee * discountRate) / 100;
                        const finalFee = baseFee - discountAmount;
                        
                        // Borç kaydı oluştur
                        const dueDate = new Date(currentYear, currentMonth - 1, 1); // Ayın 1. günü
                        const dueDateStr = dueDate.toISOString().split('T')[0];
                        
                        const { error: insertError } = await supabaseService.supabase
                            .from('payments')
                            .insert({
                                student_id: student.id,
                                amount: finalFee,
                                payment_date: dueDateStr,
                                is_paid: false,
                                equipment_assignment_id: null,
                                period_month: currentMonth,
                                period_year: currentYear,
                                created_at: new Date().toISOString()
                            });
                        
                        if (insertError) {
                            console.error(`❌ ${student.name} ${student.surname} için borç oluşturma hatası:`, insertError);
                        } else {
                            console.log(`✅ ${student.name} ${student.surname} - ${currentMonth}. ay: ${finalFee} TL borç oluşturuldu`);
                        }
                    } else {
                        console.log(`ℹ️ ${student.name} ${student.surname} - ${currentMonth}. ay borcu zaten mevcut`);
                    }
                    
                } catch (studentError) {
                    console.error(`❌ ${student.name} ${student.surname} için işlem hatası:`, studentError);
                }
            }
            
            console.log('✅ Aylık borç oluşturma işlemi tamamlandı');
            
        } catch (error) {
            console.error('❌ Aylık borç oluşturma genel hatası:', error);
        }
    }

    async setupAutomaticMonthlyDebts() {
        try {
            console.log('🔄 Otomatik aylık borç sistemi kuruluyor...');
            
            // Her ayın 1. günü çalışacak otomatik sistem
            const checkAndCreateDebts = async () => {
                const currentDate = new Date();
                const currentDay = currentDate.getDate();
                
                // Sadece ayın 1. günü çalış
                if (currentDay === 1) {
                    console.log('📅 Ayın 1. günü - Otomatik borç oluşturma başlıyor...');
                    await this.createMonthlyDebtsForActiveStudents();
                } else {
                    console.log(`ℹ️ Bugün ${currentDay}. gün - Otomatik borç oluşturma sadece ayın 1. günü çalışır`);
                }
            };
            
            // İlk çalıştırma
            await checkAndCreateDebts();
            
            // Her gün kontrol et (24 saat = 86400000 ms)
            setInterval(checkAndCreateDebts, 24 * 60 * 60 * 1000);
            
            console.log('✅ Otomatik aylık borç sistemi kuruldu - Her ayın 1. günü çalışacak');
            
        } catch (error) {
            console.error('❌ Otomatik borç sistemi kurulum hatası:', error);
        }
    }

    async createNextMonthDebt() {
        try {
            console.log('🔄 Gelecek ay için borç oluşturuluyor...');
            
            const currentDate = new Date();
            const nextMonth = currentDate.getMonth() + 2; // Gelecek ay (0-11 + 2)
            const nextYear = nextMonth > 12 ? currentDate.getFullYear() + 1 : currentDate.getFullYear();
            const finalMonth = nextMonth > 12 ? 1 : nextMonth;
            
            console.log(`📅 ${finalMonth}. ay ${nextYear} için borç oluşturuluyor...`);
            
            // Aktif öğrencileri al
            const { data: activeStudents, error: studentsError } = await supabaseService.supabase
                .from('students')
                .select('*')
                .eq('status', 'active')
                .neq('deleted', true);
            
            if (studentsError) {
                console.error('❌ Aktif öğrenciler alınamadı:', studentsError);
                return;
            }
            
            console.log(`📊 ${activeStudents.length} aktif öğrenci için gelecek ay borcu oluşturuluyor`);
            
            // Her aktif öğrenci için gelecek ay borcu oluştur
            for (const student of activeStudents) {
                try {
                    // Gelecek ay için borç kaydı var mı kontrol et
                    const { data: existingPayments, error: paymentError } = await supabaseService.supabase
                        .from('payments')
                        .select('id')
                        .eq('student_id', student.id)
                        .eq('period_year', nextYear)
                        .eq('period_month', finalMonth)
                        .is('equipment_assignment_id', null);
                    
                    if (paymentError) {
                        console.error(`❌ ${student.name} ${student.surname} gelecek ay borç kontrolü hatası:`, paymentError);
                        continue;
                    }
                    
                    // Eğer gelecek ay için borç kaydı yoksa oluştur
                    if (!existingPayments || existingPayments.length === 0) {
                        // Spor branşı ücretini al
                        const baseFee = this.getSportBranchFee(student.sport) || 1000;
                        
                        // İndirim oranını uygula
                        const discountRate = student.discount_rate || 0;
                        const discountAmount = (baseFee * discountRate) / 100;
                        const finalFee = baseFee - discountAmount;
                        
                        // Borç kaydı oluştur (gelecek ayın 1. günü)
                        const dueDate = new Date(nextYear, finalMonth - 1, 1);
                        const dueDateStr = dueDate.toISOString().split('T')[0];
                        
                        const { error: insertError } = await supabaseService.supabase
                            .from('payments')
                            .insert({
                                student_id: student.id,
                                amount: finalFee,
                                payment_date: dueDateStr,
                                is_paid: false,
                                equipment_assignment_id: null,
                                period_month: finalMonth,
                                period_year: nextYear,
                                created_at: new Date().toISOString()
                            });
                        
                        if (insertError) {
                            console.error(`❌ ${student.name} ${student.surname} gelecek ay borç oluşturma hatası:`, insertError);
                        } else {
                            console.log(`✅ ${student.name} ${student.surname} - ${finalMonth}/${nextYear}: ${finalFee} TL borç oluşturuldu`);
                        }
                    } else {
                        console.log(`ℹ️ ${student.name} ${student.surname} - ${finalMonth}/${nextYear} borcu zaten mevcut`);
                    }
                    
                } catch (studentError) {
                    console.error(`❌ ${student.name} ${student.surname} gelecek ay işlem hatası:`, studentError);
                }
            }
            
            console.log('✅ Gelecek ay borç oluşturma tamamlandı');
            
        } catch (error) {
            console.error('❌ Gelecek ay borç oluşturma genel hatası:', error);
        }
    }

    generatePaymentTrackingTable(students, payments) {
        // Takip edilen yıl (varsayılan olarak mevcut yıl)
        const currentYear = this.trackingYear || new Date().getFullYear();
        
        // Ay isimleri
        const months = [
            'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
            'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
        ];
        
        // Öğrenci bazında ödeme verilerini organize et
        const studentPayments = {};
        students.forEach(student => {
            studentPayments[student.id] = {
                student: student,
                monthlyPayments: new Array(12).fill(null), // 12 ay için
                equipmentPayments: [],
                totalPaid: 0
            };
        });
        
        // Ödemeleri aylara göre dağıt
        payments.forEach(payment => {
            if (payment.student_id && studentPayments[payment.student_id]) {
                if (payment.equipment_assignment_id) {
                    // Ekipman ödemesi
                    studentPayments[payment.student_id].equipmentPayments.push(payment);
                    if (payment.is_paid) {
                        studentPayments[payment.student_id].totalPaid += payment.amount || 0;
                    }
                } else if (payment.period_year === currentYear && payment.period_month) {
                    // Aylık ödeme
                    const monthIndex = payment.period_month - 1; // 0-11 arası
                    if (monthIndex >= 0 && monthIndex < 12) {
                        if (!studentPayments[payment.student_id].monthlyPayments[monthIndex]) {
                            studentPayments[payment.student_id].monthlyPayments[monthIndex] = [];
                        }
                        studentPayments[payment.student_id].monthlyPayments[monthIndex].push(payment);
                        
                        if (payment.is_paid) {
                            studentPayments[payment.student_id].totalPaid += payment.amount || 0;
                        }
                    }
                }
            }
        });
        
        // Aylık toplamları hesapla
        const monthlyTotals = new Array(12).fill(0);
        let equipmentTotal = 0;
        let grandTotal = 0;
        
        Object.values(studentPayments).forEach(studentData => {
            // Aylık ödemeler
            studentData.monthlyPayments.forEach((monthPayments, monthIndex) => {
                if (monthPayments) {
                    monthPayments.forEach(payment => {
                        if (payment.is_paid) {
                            monthlyTotals[monthIndex] += payment.amount || 0;
                        }
                    });
                }
            });
            
            // Ekipman ödemeleri
            studentData.equipmentPayments.forEach(payment => {
                if (payment.is_paid) {
                    equipmentTotal += payment.amount || 0;
                }
            });
            
            grandTotal += studentData.totalPaid;
        });
        
        return `
            <div class="payment-tracking-container" style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                <!-- Yıl Navigasyonu -->
                <div class="year-navigation" style="display: flex; align-items: center; justify-content: center; margin-bottom: 25px; gap: 20px;">
                    <button onclick="app.changeTrackingYear(-1)" style="
                        background: #3b82f6; 
                        color: white; 
                        border: none; 
                        padding: 12px 16px; 
                        border-radius: 10px; 
                        cursor: pointer; 
                        font-size: 18px;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        transition: all 0.2s;
                        box-shadow: 0 2px 4px rgba(59, 130, 246, 0.3);
                    " onmouseover="this.style.background='#2563eb'" onmouseout="this.style.background='#3b82f6'">
                        <i class="fas fa-chevron-left"></i>
                    </button>
                    <h2 style="margin: 0; font-size: 32px; font-weight: 700; color: #1f2937; min-width: 120px; text-align: center; text-shadow: 0 1px 2px rgba(0,0,0,0.1);">
                        📅 ${currentYear}
                    </h2>
                    <button onclick="app.changeTrackingYear(1)" style="
                        background: #3b82f6; 
                        color: white; 
                        border: none; 
                        padding: 12px 16px; 
                        border-radius: 10px; 
                        cursor: pointer; 
                        font-size: 18px;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        transition: all 0.2s;
                        box-shadow: 0 2px 4px rgba(59, 130, 246, 0.3);
                    " onmouseover="this.style.background='#2563eb'" onmouseout="this.style.background='#3b82f6'">
                        <i class="fas fa-chevron-right"></i>
                    </button>
                </div>
                
                <!-- Ödeme Takip Tablosu -->
                <div class="tracking-table-wrapper" style="overflow-x: auto; border-radius: 12px; border: 1px solid #e5e7eb; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                    <table style="width: 100%; border-collapse: collapse; min-width: 1200px; font-size: 12px; background: white;">
                        <!-- Başlık Satırı -->
                        <thead>
                            <tr style="background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);">
                                <th style="padding: 12px; text-align: left; font-weight: 700; color: #374151; border-bottom: 2px solid #e5e7eb; min-width: 140px; font-size: 14px; position: sticky; left: 0; background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); z-index: 10;">
                                    👥 Öğrenciler
                                </th>
                                ${months.map((month, index) => `
                                    <th style="padding: 8px; text-align: center; font-weight: 600; color: #374151; border-bottom: 2px solid #e5e7eb; min-width: 70px; font-size: 11px;">
                                        ${month.substring(0, 3)}
                                    </th>
                                `).join('')}
                                <th style="padding: 8px; text-align: center; font-weight: 600; color: #374151; border-bottom: 2px solid #e5e7eb; min-width: 70px; font-size: 11px;">
                                    🛠️ Ekip
                                </th>
                                <th style="padding: 12px; text-align: center; font-weight: 700; color: #374151; border-bottom: 2px solid #e5e7eb; min-width: 90px; font-size: 14px;">
                                    💰 Toplam
                                </th>
                            </tr>
                        </thead>
                        
                        <!-- Öğrenci Satırları -->
                        <tbody>
                            ${Object.values(studentPayments).map(studentData => {
                                const student = studentData.student;
                                const studentName = `${student.name || ''} ${student.surname || ''}`.trim();
                                
                                const monthCells = studentData.monthlyPayments.map((monthPayments, monthIndex) => {
                                    let cellContent = '';
                                    let cellStyle = 'padding: 6px; text-align: center; border-bottom: 1px solid #f3f4f6; font-size: 11px; font-weight: 600; transition: all 0.2s;';
                                    
                                    if (monthPayments && monthPayments.length > 0) {
                                        let totalAmount = 0;
                                        let paidAmount = 0;
                                        
                                        monthPayments.forEach(payment => {
                                            const amount = payment.amount || 0;
                                            totalAmount += amount;
                                            if (payment.is_paid) {
                                                paidAmount += amount;
                                            }
                                        });
                                        
                                        if (paidAmount === totalAmount) {
                                            // Tamamen ödendi
                                            cellContent = `${paidAmount}`;
                                            cellStyle += ' background: #dcfce7; color: #166534; border: 1px solid #bbf7d0;';
                                        } else if (paidAmount > 0) {
                                            // Kısmi ödeme
                                            cellContent = `${paidAmount}/${totalAmount}`;
                                            cellStyle += ' background: #fef3c7; color: #92400e; border: 1px solid #fde68a;';
                                        } else {
                                            // Ödenmedi
                                            cellContent = `${totalAmount}`;
                                            cellStyle += ' background: #fecaca; color: #dc2626; border: 1px solid #fca5a5;';
                                        }
                                    } else {
                                        // Borç yok
                                        cellContent = '-';
                                        cellStyle += ' background: #f9fafb; color: #9ca3af; border: 1px solid #f3f4f6;';
                                    }
                                    
                                    return `<td style="${cellStyle}">${cellContent}</td>`;
                                }).join('');
                                
                                // Ekipman sütunu
                                let equipmentCell = '';
                                let equipmentCellStyle = 'padding: 6px; text-align: center; border-bottom: 1px solid #f3f4f6; font-size: 11px; font-weight: 600; transition: all 0.2s;';
                                
                                if (studentData.equipmentPayments.length > 0) {
                                    let equipmentTotal = 0;
                                    let equipmentPaid = 0;
                                    
                                    studentData.equipmentPayments.forEach(payment => {
                                        const amount = payment.amount || 0;
                                        equipmentTotal += amount;
                                        if (payment.is_paid) {
                                            equipmentPaid += amount;
                                        }
                                    });
                                    
                                    if (equipmentPaid === equipmentTotal) {
                                        equipmentCell = `${equipmentPaid}`;
                                        equipmentCellStyle += ' background: #dcfce7; color: #166534; border: 1px solid #bbf7d0;';
                                    } else if (equipmentPaid > 0) {
                                        equipmentCell = `${equipmentPaid}/${equipmentTotal}`;
                                        equipmentCellStyle += ' background: #fef3c7; color: #92400e; border: 1px solid #fde68a;';
                                    } else {
                                        equipmentCell = `${equipmentTotal}`;
                                        equipmentCellStyle += ' background: #fecaca; color: #dc2626; border: 1px solid #fca5a5;';
                                    }
                                } else {
                                    equipmentCell = '-';
                                    equipmentCellStyle += ' background: #f9fafb; color: #9ca3af; border: 1px solid #f3f4f6;';
                                }
                                
                                return `
                                    <tr style="border-bottom: 1px solid #f3f4f6; transition: all 0.2s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='white'">
                                        <td style="padding: 10px; font-weight: 600; color: #374151; border-bottom: 1px solid #f3f4f6; font-size: 12px; position: sticky; left: 0; background: white; z-index: 5; border-right: 1px solid #e5e7eb;">
                                            ${studentName}
                                        </td>
                                        ${monthCells}
                                        <td style="${equipmentCellStyle}">${equipmentCell}</td>
                                        <td style="padding: 10px; text-align: center; font-weight: 700; color: #1f2937; border-bottom: 1px solid #f3f4f6; background: #f8fafc; font-size: 13px; border: 1px solid #e5e7eb;">
                                            ${studentData.totalPaid}
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                        
                        <!-- Toplam Satırı -->
                        <tfoot>
                            <tr style="background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%); font-weight: 700;">
                                <td style="padding: 12px; color: #374151; border-top: 2px solid #e5e7eb; font-size: 13px; font-weight: 700; position: sticky; left: 0; background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%); z-index: 10; border-right: 1px solid #cbd5e1;">
                                    📊 TOPLAM
                                </td>
                                ${monthlyTotals.map(total => `
                                    <td style="padding: 8px; text-align: center; color: #1f2937; border-top: 2px solid #e5e7eb; font-size: 11px; font-weight: 600;">
                                        ${total}
                                    </td>
                                `).join('')}
                                <td style="padding: 8px; text-align: center; color: #1f2937; border-top: 2px solid #e5e7eb; font-size: 11px; font-weight: 600;">
                                    ${equipmentTotal}
                                </td>
                                <td style="padding: 12px; text-align: center; color: #dc2626; font-size: 15px; border-top: 2px solid #e5e7eb; font-weight: 700; background: #fef2f2; border: 1px solid #fecaca;">
                                    ${grandTotal}
                                </td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
                
                <!-- Renk Açıklaması -->
                <div style="margin-top: 20px; display: flex; gap: 25px; justify-content: center; flex-wrap: wrap; padding: 15px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div style="width: 20px; height: 20px; background: #dcfce7; border-radius: 6px; border: 1px solid #bbf7d0;"></div>
                        <span style="font-size: 14px; color: #374151; font-weight: 500;">✅ Ödendi</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div style="width: 20px; height: 20px; background: #fecaca; border-radius: 6px; border: 1px solid #fca5a5;"></div>
                        <span style="font-size: 14px; color: #374151; font-weight: 500;">❌ Ödenmedi</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div style="width: 20px; height: 20px; background: #fef3c7; border-radius: 6px; border: 1px solid #fde68a;"></div>
                        <span style="font-size: 14px; color: #374151; font-weight: 500;">⚠️ Kısmi Ödeme</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div style="width: 20px; height: 20px; background: #f9fafb; border-radius: 6px; border: 1px solid #f3f4f6;"></div>
                        <span style="font-size: 14px; color: #374151; font-weight: 500;">➖ Borç Yok</span>
                    </div>
                </div>
            </div>
        `;
    }

    changeTrackingYear(direction) {
        // Yıl değiştirme fonksiyonu
        this.trackingYear = (this.trackingYear || new Date().getFullYear()) + direction;
        
        // Yıl sınırları (2020-2030)
        if (this.trackingYear < 2020) this.trackingYear = 2020;
        if (this.trackingYear > 2030) this.trackingYear = 2030;
        
        // Tabloyu yeniden render et
        const paymentsList = document.getElementById('paymentsList');
        if (paymentsList) {
            // Mevcut verileri yeniden yükle
            this.loadPaymentsScreen();
        }
    }
    
     validateTCKimlikNo(tcno) {
            if (!tcno || tcno.length !== 11) return false;
            if (tcno[0] === '0') return false;
            if (/^(\d)\1{10}$/.test(tcno)) return false;
            if (!/^\d{11}$/.test(tcno)) return false;
            
            const digits = tcno.split('').map(Number);
            const sum1 = digits[0] + digits[2] + digits[4] + digits[6] + digits[8];
            const sum2 = digits[1] + digits[3] + digits[5] + digits[7];
            const check10 = ((sum1 * 7) - sum2) % 10;
            
            if (check10 !== digits[9]) return false;
            
            const sum11 = digits.slice(0, 10).reduce((a, b) => a + b, 0);
            const check11 = sum11 % 10;
            
            return check11 === digits[10];
        }
        async handleTrainingFormSubmit(e) {
            e.preventDefault();
            
            try {
               // Form elementlerini güvenli şekilde al
const sportElement = document.getElementById('trainingSport');
const ageGroupElement = document.getElementById('trainingAgeGroup');
const dateElement = document.getElementById('trainingDate');
const startTimeElement = document.getElementById('trainingStartTime');
const endTimeElement = document.getElementById('trainingEndTime');
const locationElement = document.getElementById('trainingLocation');
const coachElement = document.getElementById('trainingCoach');
const contentElement = document.getElementById('trainingContent');

// Null check
if (!sportElement || !dateElement || !startTimeElement) {
    console.error('Required form elements not found');
    alert('Form elementleri bulunamadı. Lütfen sayfayı yenileyin.');
    return;
}

const trainingData = {
    sport: sportElement.value,
    age_group: ageGroupElement ? ageGroupElement.value : '',
    date: dateElement.value,
    start_time: startTimeElement.value,
    end_time: endTimeElement ? endTimeElement.value : '',
    location: locationElement ? locationElement.value : '',
    instructor: coachElement ? coachElement.value : '',
    notes: contentElement ? contentElement.value : '',
    max_participants: 20, // Varsayılan değer
    created_by: this.getCurrentAuthUserId(), // await kaldır
    created_at: new Date().toISOString()
};
// Validation
if (!trainingData.sport || !trainingData.date || !trainingData.start_time) {
    alert('Lütfen tüm zorunlu alanları doldurun.');
    return;
}    
                const result = await supabaseService.createTraining(trainingData);
                if (result.success) {
                    alert('Antrenman başarıyla eklendi!');
                    this.hideTrainingModal();
                    await supabaseService.addActivityLog(
                        'create',
                        'training',
                        result.data?.id || 'unknown', // Yeni oluşturulan antrenmanın ID'si
                        `${trainingData.name || 'Antrenman'} oluşturuldu`
                    );
                    // Refresh calendar if needed
                    if (typeof this.loadCalendarScreen === 'function') {
                        this.loadCalendarScreen();
                    }
                } else {
                    alert('Antrenman eklenirken hata oluştu: ' + this.formatErrorMessage(result.error));
                }
            } catch (error) {
                console.error('Training form submit error:', error);
                alert('Antrenman kaydedilemedi: ' + this.formatErrorMessage(error));
            }
        }
        
        hideTrainingModal() {
            const modal = document.getElementById('trainingModal');
            if (modal) {
                modal.style.display = 'none';
            }
            document.body.style.overflow = 'auto';
        }
        
        getCurrentAuthUserId() {
            try {
                // Session'dan direkt al, async gereksiz
                const session = supabaseService.supabase?.auth?.session;
                if (session?.user?.id) {
                    return session.user.id;
                }
                // Fallback: currentUser'dan al
                return this.currentUser?.user_id || null;
            } catch (error) {
                console.error('Error getting auth user ID:', error);
                return this.currentUser?.user_id || null;
            }
        }
    }

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new SportsManagementApp();

    // Global interaction restrictions: disable selection and right-click everywhere
    try {
        const style = document.createElement('style');
        style.setAttribute('data-id', 'global-no-select');
        style.innerHTML = `
            * { 
                -webkit-user-select: none !important; 
                -moz-user-select: none !important; 
                -ms-user-select: none !important; 
                user-select: none !important; 
            }
            img, a { -webkit-touch-callout: none; }
        `;
        document.head.appendChild(style);

        // Block context menu (right-click)
        document.addEventListener('contextmenu', (e) => e.preventDefault());
        // Block text selection and drag actions
        document.addEventListener('selectstart', (e) => e.preventDefault());
        document.addEventListener('dragstart', (e) => e.preventDefault());
        // Prevent double-click selection
        document.addEventListener('mousedown', (e) => {
            if (e.detail > 1) e.preventDefault();
        }, { capture: true });
    } catch (err) {
        console.warn('Failed to apply global interaction restrictions:', err);
    }
});

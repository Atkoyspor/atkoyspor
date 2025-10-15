// Secure Sports Management Application
// Güvenlik ve performans iyileştirmeleri ile yeniden yazılmış

class SecureSportsManagementApp {
    constructor() {
        this.currentUser = null;
        this.selectedStudentForEquipment = null;
        this.sportColorMap = {};
        this._equipmentTypesCache = [];
        this.initializeApp();
    }

    async initializeApp() {
        this.setupSecureEventListeners();
        this.checkRememberedUser();
        this.showScreen('loginScreen');
        await this.initializeSportColors();
    }

    setupSecureEventListeners() {
        // Login form with security
        const loginForm = document.getElementById('loginForm');
        if (loginForm) {
            SecurityUtils.addSafeEventListener(loginForm, 'submit', (e) => {
                e.preventDefault();
                
                // Get form data securely
                const formData = new FormData(loginForm);
                const username = formData.get('username')?.toString().trim();
                const password = formData.get('password')?.toString().trim();
                
                console.log('🔐 Login attempt:', { username: username ? '***' : 'empty', password: password ? '***' : 'empty' });
                
                if (!username || !password) {
                    alert('Kullanıcı adı ve şifre gereklidir.');
                    return;
                }
                
                this.handleSecureLogin({ username, password });
            });
        }

        // Navigation with security
        SecurityUtils.addSafeEventListener(document, 'click', (e) => {
            if (e.target.matches('.nav-btn')) {
                const screen = SecurityUtils.escapeHtml(e.target.getAttribute('data-screen'));
                if (screen) {
                    this.showScreen(screen);
                    this.loadScreenData(screen);
                }
            }
        });
    }

    async handleSecureLogin(data) {
        const { username, password } = data;
        
        console.log('🔐 handleSecureLogin called with:', { 
            username: username ? `${username.substring(0, 3)}***` : 'empty', 
            password: password ? '***' : 'empty' 
        });
        
        // Input validation
        if (!username || !password) {
            alert('Kullanıcı adı ve şifre gereklidir.');
            return;
        }
        
        // Rate limiting check
        if (typeof SecurityUtils !== 'undefined' && SecurityUtils.rateLimiter) {
            const rateLimitCheck = SecurityUtils.rateLimiter.check(`login_${username}`);
            if (!rateLimitCheck.allowed) {
                alert('Çok fazla deneme yaptınız. Lütfen daha sonra tekrar deneyin.');
                return;
            }
        }

        try {
            console.log('🔐 Calling supabaseService.signIn...');
            const result = await supabaseService.signIn(username, password);
            console.log('🔐 Login result:', { success: result.success, error: result.error ? 'present' : 'none' });
            
            if (result.success) {
                if (typeof SecurityUtils !== 'undefined' && SecurityUtils.rateLimiter) {
                    SecurityUtils.rateLimiter.reset(`login_${username}`);
                }
                this.currentUser = result.user;
                console.log('✅ Login successful, redirecting to dashboard');
                this.showScreen('dashboardScreen');
                this.loadDashboard();
                
                // Remember user securely
                const rememberCheckbox = document.getElementById('rememberMe');
                if (rememberCheckbox?.checked) {
                    this.rememberUserSecurely(result.user);
                }
            } else {
                console.log('❌ Login failed:', result.error);
                alert('Giriş başarısız: ' + (result.error || 'Bilinmeyen hata'));
            }
        } catch (error) {
            console.error('❌ Login error:', error);
            alert('Giriş sırasında hata oluştu: ' + error.message);
        }
    }

    rememberUserSecurely(user) {
        try {
            const secureData = {
                email: SecurityUtils.escapeHtml(user.email),
                loginTime: Date.now(),
                // Don't store sensitive data
            };
            localStorage.setItem('rememberedUser', JSON.stringify(secureData));
        } catch (error) {
            console.error('Error remembering user:', error);
        }
    }

    showScreen(screenId) {
        // Hide all screens
        document.querySelectorAll('.screen').forEach(screen => {
            screen.style.display = 'none';
        });

        // Show target screen
        const targetScreen = document.getElementById(screenId);
        if (targetScreen) {
            targetScreen.style.display = 'block';
        }

        // Update navigation
        this.updateNavigation(screenId);
    }

    updateNavigation(screenId) {
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.remove('active');
        });

        const activeBtn = document.querySelector(`[data-screen="${screenId}"]`);
        if (activeBtn) {
            activeBtn.classList.add('active');
        }
    }

    async loadScreenData(screen) {
        try {
            switch(screen) {
                case 'dashboardScreen':
                    await this.loadDashboard();
                    break;
                case 'studentsScreen':
                    await this.loadStudentsScreen();
                    break;
                case 'equipmentScreen':
                    await this.loadEquipmentScreen();
                    break;
                case 'paymentsScreen':
                    await this.loadPaymentsScreen();
                    break;
                case 'calendarScreen':
                    await this.loadCalendarScreen();
                    break;
            }
        } catch (error) {
            console.error('Error loading screen data:', error);
        }
    }

    async loadDashboard() {
        try {
            // Use performance monitoring
            const { result: dashboardData } = await performanceUtils.measurePerformance(
                'dashboard_load',
                () => this.fetchDashboardData()
            );

            this.renderDashboardSecurely(dashboardData);
        } catch (error) {
            console.error('Dashboard load error:', error);
        }
    }

    async fetchDashboardData() {
        // Use request deduplication
        const studentsPromise = performanceUtils.deduplicateRequest(
            'students_list',
            () => supabaseService.getStudents()
        );

        const equipmentPromise = performanceUtils.deduplicateRequest(
            'equipment_types',
            () => supabaseService.getEquipmentTypes()
        );

        const [studentsResult, equipmentResult] = await Promise.all([
            studentsPromise,
            equipmentPromise
        ]);

        return {
            students: studentsResult.success ? studentsResult.data : [],
            equipment: equipmentResult.success ? equipmentResult.data : []
        };
    }

    renderDashboardSecurely(data) {
        const container = document.getElementById('dashboardContent');
        if (!container) return;

        // Clear container safely
        container.textContent = '';

        // Create dashboard cards safely
        const statsCard = this.createStatsCard(data);
        const recentCard = this.createRecentActivitiesCard();
        
        container.appendChild(statsCard);
        container.appendChild(recentCard);
    }

    createStatsCard(data) {
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        card.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        `;

        const title = SecurityUtils.createSafeElement('h3', 'İstatistikler');
        title.style.cssText = 'margin: 0 0 16px 0; color: #1F2937;';

        const statsGrid = document.createElement('div');
        statsGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;';

        // Student count
        const studentStat = this.createStatItem('Toplam Öğrenci', data.students.length, '#3B82F6');
        const equipmentStat = this.createStatItem('Ekipman Türü', data.equipment.length, '#10B981');

        statsGrid.appendChild(studentStat);
        statsGrid.appendChild(equipmentStat);

        card.appendChild(title);
        card.appendChild(statsGrid);

        return card;
    }

    createStatItem(label, value, color) {
        const item = document.createElement('div');
        item.style.cssText = `
            background: ${color}10;
            border: 1px solid ${color}30;
            border-radius: 8px;
            padding: 16px;
            text-align: center;
        `;

        const valueEl = SecurityUtils.createSafeElement('div', value.toString());
        valueEl.style.cssText = `font-size: 24px; font-weight: 700; color: ${color}; margin-bottom: 4px;`;

        const labelEl = SecurityUtils.createSafeElement('div', label);
        labelEl.style.cssText = 'font-size: 14px; color: #6B7280;';

        item.appendChild(valueEl);
        item.appendChild(labelEl);

        return item;
    }

    async loadStudentsScreen() {
        try {
            console.log('📚 Loading students screen...');
            const result = await supabaseService.getStudents();
            console.log('📚 Students result:', result);

            if (result.success && result.data) {
                this.renderStudentsSecurely(result.data);
            } else {
                console.error('Failed to load students:', result.error);
                const container = document.getElementById('studentsList');
                if (container) {
                    container.innerHTML = '<div style="text-align: center; padding: 40px; color: #EF4444;">Öğrenciler yüklenemedi: ' + (result.error || 'Bilinmeyen hata') + '</div>';
                }
            }
        } catch (error) {
            console.error('Students screen load error:', error);
            const container = document.getElementById('studentsList');
            if (container) {
                container.innerHTML = '<div style="text-align: center; padding: 40px; color: #EF4444;">Öğrenciler yüklenirken hata oluştu</div>';
            }
        }
    }

    renderStudentsSecurely(students) {
        const container = document.getElementById('studentsList');
        if (!container) {
            console.error('studentsList container not found');
            return;
        }

        console.log('📚 Rendering', students.length, 'students');
        
        // Clear container
        container.innerHTML = '';
        
        if (!students || students.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 40px; color: #6B7280;">Henüz öğrenci kaydı bulunmuyor.</div>';
            return;
        }

        // Create simple student cards
        students.forEach(student => {
            const card = document.createElement('div');
            card.style.cssText = `
                background: white;
                border: 1px solid #e5e7eb;
                border-radius: 8px;
                padding: 16px;
                margin-bottom: 12px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            `;
            
            const name = SecurityUtils.createSafeElement('h3', `${student.name || ''} ${student.surname || ''}`);
            name.style.cssText = 'margin: 0 0 8px 0; color: #1F2937;';
            
            const details = SecurityUtils.createSafeElement('p', 
                `TC: ${student.tcno || 'Belirtilmemiş'} | Yaş: ${this.calculateAge(student.birth_date)} | Spor: ${student.sport || 'Belirtilmemiş'}`
            );
            details.style.cssText = 'margin: 0; color: #6B7280; font-size: 14px;';
            
            card.appendChild(name);
            card.appendChild(details);
            container.appendChild(card);
        });
    }

    calculateAge(birthDate) {
        if (!birthDate) return 'Bilinmiyor';
        
        const birth = new Date(birthDate);
        const today = new Date();
        let age = today.getFullYear() - birth.getFullYear();
        const monthDiff = today.getMonth() - birth.getMonth();
        
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
            age--;
        }
        
        return age;
    }

    async loadEquipmentScreen() {
        try {
            const result = await performanceUtils.deduplicateRequest(
                'equipment_screen',
                () => supabaseService.getEquipmentTypes()
            );

            if (result.success) {
                this._equipmentTypesCache = result.data;
                this.renderEquipmentSecurely(result.data);
            }
        } catch (error) {
            console.error('Equipment screen load error:', error);
        }
    }

    renderEquipmentSecurely(equipment) {
        const container = document.getElementById('equipmentContainer');
        if (!container) return;

        container.textContent = '';

        // Group equipment by name
        const groups = {};
        equipment.forEach(item => {
            const name = item.name || 'Diğer';
            if (!groups[name]) groups[name] = [];
            groups[name].push(item);
        });

        // Render groups
        Object.entries(groups).forEach(([name, items]) => {
            const groupCard = this.createEquipmentGroupCard(name, items);
            container.appendChild(groupCard);
        });
    }

    createEquipmentGroupCard(name, items) {
        const card = document.createElement('div');
        card.style.cssText = `
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 12px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        `;

        const header = SecurityUtils.createSafeElement('h4', name);
        header.style.cssText = 'margin: 0 0 12px 0; color: #1F2937;';

        const itemsGrid = document.createElement('div');
        itemsGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px;';

        items.forEach(item => {
            const itemCard = this.createEquipmentItemCard(item);
            itemsGrid.appendChild(itemCard);
        });

        card.appendChild(header);
        card.appendChild(itemsGrid);

        return card;
    }

    createEquipmentItemCard(item) {
        const card = document.createElement('div');
        card.style.cssText = `
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 12px;
        `;

        const size = SecurityUtils.createSafeElement('div', `Beden: ${item.size || '-'}`);
        size.style.cssText = 'font-weight: 600; margin-bottom: 4px;';

        const quantity = SecurityUtils.createSafeElement('div', `Stok: ${item.quantity || 0}`);
        const available = SecurityUtils.createSafeElement('div', `Müsait: ${item.available_quantity || 0}`);

        card.appendChild(size);
        card.appendChild(quantity);
        card.appendChild(available);

        return card;
    }

    // Equipment assignment with security
    async selectStudentForEquipment(studentId) {
        try {
            const validation = SecurityUtils.validateInput(studentId, 'text');
            if (!validation.valid) {
                alert('Geçersiz öğrenci ID');
                return;
            }

            this.selectedStudentForEquipment = studentId;
            await this.showEquipmentAssignmentForm();
        } catch (error) {
            console.error('Error selecting student:', error);
        }
    }

    async showEquipmentAssignmentForm() {
        const container = document.getElementById('equipmentAssignmentForm');
        if (!container) return;

        container.textContent = '';

        const form = this.createSecureEquipmentForm();
        container.appendChild(form);
        container.style.display = 'block';
    }

    createSecureEquipmentForm() {
        const form = document.createElement('form');
        form.style.cssText = 'display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; align-items: end;';

        // Equipment select
        const equipmentDiv = document.createElement('div');
        const equipmentLabel = SecurityUtils.createSafeElement('label', 'Ekipman');
        equipmentLabel.style.cssText = 'display: block; margin-bottom: 6px; font-weight: 600;';

        const equipmentSelect = document.createElement('select');
        equipmentSelect.name = 'equipmentName';
        equipmentSelect.required = true;
        equipmentSelect.style.cssText = 'width: 100%; padding: 10px; border: 2px solid #e5e7eb; border-radius: 8px;';

        // Populate equipment options securely
        const defaultOption = SecurityUtils.createSafeElement('option', 'Ekipman seçiniz...');
        defaultOption.value = '';
        equipmentSelect.appendChild(defaultOption);

        const uniqueNames = [...new Set(this._equipmentTypesCache.map(item => item.name))];
        uniqueNames.forEach(name => {
            const option = SecurityUtils.createSafeElement('option', name);
            option.value = name;
            equipmentSelect.appendChild(option);
        });

        SecurityUtils.addSafeEventListener(equipmentSelect, 'change', (e) => {
            this.onEquipmentChangeSecure(e.target.value);
        });

        equipmentDiv.appendChild(equipmentLabel);
        equipmentDiv.appendChild(equipmentSelect);

        // Size select
        const sizeDiv = document.createElement('div');
        const sizeLabel = SecurityUtils.createSafeElement('label', 'Beden');
        sizeLabel.style.cssText = 'display: block; margin-bottom: 6px; font-weight: 600;';

        const sizeSelect = document.createElement('select');
        sizeSelect.name = 'sizeSelect';
        sizeSelect.required = true;
        sizeSelect.style.cssText = 'width: 100%; padding: 10px; border: 2px solid #e5e7eb; border-radius: 8px;';

        const sizeDefaultOption = SecurityUtils.createSafeElement('option', 'Önce ekipman seçiniz...');
        sizeDefaultOption.value = '';
        sizeSelect.appendChild(sizeDefaultOption);

        SecurityUtils.addSafeEventListener(sizeSelect, 'change', (e) => {
            this.onSizeChangeSecure(e.target.value);
        });

        sizeDiv.appendChild(sizeLabel);
        sizeDiv.appendChild(sizeSelect);

        // Quantity select
        const quantityDiv = document.createElement('div');
        const quantityLabel = SecurityUtils.createSafeElement('label', 'Adet');
        quantityLabel.style.cssText = 'display: block; margin-bottom: 6px; font-weight: 600;';

        const quantitySelect = document.createElement('select');
        quantitySelect.name = 'quantity';
        quantitySelect.required = true;
        quantitySelect.style.cssText = 'width: 100%; padding: 10px; border: 2px solid #e5e7eb; border-radius: 8px;';

        const quantityDefaultOption = SecurityUtils.createSafeElement('option', 'Önce ekipman ve beden seçiniz...');
        quantityDefaultOption.value = '';
        quantitySelect.appendChild(quantityDefaultOption);

        quantityDiv.appendChild(quantityLabel);
        quantityDiv.appendChild(quantitySelect);

        // Hidden fields for compatibility
        const hiddenType = document.createElement('input');
        hiddenType.type = 'hidden';
        hiddenType.name = 'equipmentType';

        const hiddenSize = document.createElement('input');
        hiddenSize.type = 'hidden';
        hiddenSize.name = 'size';

        // Submit button
        const submitBtn = DOMUtils.createSafeButton('Ata', 'fas fa-check', () => {
            this.handleEquipmentAssignmentSecure(form);
        });
        submitBtn.type = 'submit';
        submitBtn.style.cssText = `
            background: #DC2626;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
        `;

        form.appendChild(equipmentDiv);
        form.appendChild(sizeDiv);
        form.appendChild(quantityDiv);
        form.appendChild(hiddenType);
        form.appendChild(hiddenSize);
        form.appendChild(submitBtn);

        // Secure form submission
        DOMUtils.handleFormSubmit(form, {
            equipmentName: { type: 'text' },
            sizeSelect: { type: 'text' },
            quantity: { type: 'number' }
        }, (data) => this.handleEquipmentAssignmentSecure(data));

        return form;
    }

    onEquipmentChangeSecure(selectedName) {
        try {
            const sizeSelect = document.querySelector('select[name="sizeSelect"]');
            const quantitySelect = document.querySelector('select[name="quantity"]');
            
            if (!sizeSelect) return;

            // Clear and reset
            sizeSelect.textContent = '';
            if (quantitySelect) quantitySelect.textContent = '';

            if (!selectedName) {
                const defaultOption = SecurityUtils.createSafeElement('option', 'Önce ekipman seçiniz...');
                defaultOption.value = '';
                sizeSelect.appendChild(defaultOption);
                return;
            }

            // Add default option
            const defaultOption = SecurityUtils.createSafeElement('option', 'Beden seçiniz...');
            defaultOption.value = '';
            sizeSelect.appendChild(defaultOption);

            // Get sizes for selected equipment
            const items = this._equipmentTypesCache.filter(item => item.name === selectedName);
            const uniqueSizes = [...new Set(items.map(item => item.size || '-'))];

            uniqueSizes.forEach(size => {
                const option = SecurityUtils.createSafeElement('option', size);
                option.value = size;
                sizeSelect.appendChild(option);
            });

        } catch (error) {
            console.error('Equipment change error:', error);
        }
    }

    async onSizeChangeSecure(size) {
        try {
            const equipmentSelect = document.querySelector('select[name="equipmentName"]');
            const quantitySelect = document.querySelector('select[name="quantity"]');
            const hiddenType = document.querySelector('input[name="equipmentType"]');
            const hiddenSize = document.querySelector('input[name="size"]');

            if (!equipmentSelect || !quantitySelect) return;

            const equipmentName = equipmentSelect.value;
            
            // Clear quantity
            quantitySelect.textContent = '';

            if (!equipmentName || !size) {
                const defaultOption = SecurityUtils.createSafeElement('option', 'Önce ekipman ve beden seçiniz...');
                defaultOption.value = '';
                quantitySelect.appendChild(defaultOption);
                return;
            }

            // Find exact variant
            const variant = this._equipmentTypesCache.find(item => 
                item.name === equipmentName && (item.size || '-') === size
            );

            if (!variant) {
                const errorOption = SecurityUtils.createSafeElement('option', 'Geçersiz seçim');
                errorOption.value = '';
                quantitySelect.appendChild(errorOption);
                return;
            }

            // Set hidden fields
            if (hiddenType) hiddenType.value = variant.id;
            if (hiddenSize) hiddenSize.value = size;

            // Load available quantity with caching
            const loadingOption = SecurityUtils.createSafeElement('option', 'Yükleniyor...');
            loadingOption.value = '';
            quantitySelect.appendChild(loadingOption);

            const cacheKey = `stock_${variant.id}_${size}`;
            const stockResult = await performanceUtils.deduplicateRequest(cacheKey, 
                () => supabaseService.getAvailableEquipmentQuantity(variant.id, size)
            );

            quantitySelect.textContent = '';

            const available = stockResult.success ? (stockResult.available || 0) : 0;

            if (available > 0) {
                const maxOptions = Math.min(available, 10);
                for (let i = 1; i <= maxOptions; i++) {
                    const option = SecurityUtils.createSafeElement('option', `${i} adet`);
                    option.value = i;
                    quantitySelect.appendChild(option);
                }
            } else {
                const noStockOption = SecurityUtils.createSafeElement('option', 'Stok yok');
                noStockOption.value = '';
                quantitySelect.appendChild(noStockOption);
            }

        } catch (error) {
            console.error('Size change error:', error);
        }
    }

    async handleEquipmentAssignmentSecure(data) {
        try {
            if (!this.selectedStudentForEquipment) {
                alert('Önce bir öğrenci seçiniz.');
                return;
            }

            const assignmentData = {
                student_id: this.selectedStudentForEquipment,
                equipment_type_id: data.equipmentType,
                size: data.size,
                quantity: parseInt(data.quantity, 10),
                assigned_by: this.currentUser?.id,
                status: 'assigned'
            };

            const result = await supabaseService.assignEquipment(assignmentData);

            if (result.success) {
                alert('Ekipman başarıyla atandı!');
                this.clearSelectedStudent();
                // Refresh cache
                performanceUtils.clearCache('equipment');
                performanceUtils.clearCache('stock');
            } else {
                alert('Atama başarısız: ' + SecurityUtils.escapeHtml(result.error));
            }

        } catch (error) {
            console.error('Assignment error:', error);
            alert('Atama sırasında hata oluştu.');
        }
    }

    clearSelectedStudent() {
        this.selectedStudentForEquipment = null;
        const formContainer = document.getElementById('equipmentAssignmentForm');
        if (formContainer) {
            formContainer.style.display = 'none';
        }
    }

    // Secure logout
    logout() {
        this.currentUser = null;
        localStorage.removeItem('rememberedUser');
        performanceUtils.clearCache(); // Clear all cache
        this.showScreen('loginScreen');
    }

    // Initialize sport colors
    async initializeSportColors() {
        const colorPalette = [
            '#3B82F6', '#10B981', '#EF4444', '#F59E0B', '#8B5CF6', '#EC4899',
            '#14B8A6', '#F97316', '#D946EF', '#6366F1', '#F43F5E', '#84CC16'
        ];

        try {
            const result = await supabaseService.getSportBranches();
            if (result.success && result.data) {
                result.data.forEach((branch, index) => {
                    const color = colorPalette[index % colorPalette.length];
                    this.sportColorMap[branch.name] = color;
                });
            }
        } catch (error) {
            console.error('Error initializing sport colors:', error);
        }
    }

    checkRememberedUser() {
        try {
            const remembered = localStorage.getItem('rememberedUser');
            if (remembered) {
                const userData = JSON.parse(remembered);
                const loginTime = userData.loginTime;
                const now = Date.now();
                const daysPassed = (now - loginTime) / (1000 * 60 * 60 * 24);
                
                if (daysPassed < 7) {
                    const usernameField = document.getElementById('username');
                    if (usernameField) {
                        usernameField.value = userData.email;
                    }
                } else {
                    localStorage.removeItem('rememberedUser');
                }
            }
        } catch (error) {
            console.error('Error checking remembered user:', error);
            localStorage.removeItem('rememberedUser');
        }
    }

    // Test function for debugging
    async testUsers() {
        console.log('🔍 Testing user data...');
        try {
            const result = await supabaseService.testGetUsers();
            console.log('📊 Test results:', result);
            
            // Show in alert for easy viewing
            if (result.profiles && result.profiles.length > 0) {
                const user = result.profiles[0];
                alert(`✅ Test kullanıcısı bulundu:\n\nEmail: ${user.email}\nKullanıcı Adı: ${user.username}\nRol: ${user.role}\n\nBu bilgilerle giriş yapmayı deneyin.`);
            } else {
                alert('❌ Kullanıcı bulunamadı. Veritabanı bağlantısını kontrol edin.');
            }
        } catch (error) {
            console.error('❌ Test error:', error);
            alert('❌ Test hatası: ' + error.message);
        }
    }

    // Load payments screen
    async loadPaymentsScreen() {
        try {
            console.log('💰 Loading payments screen...');
            const container = document.getElementById('paymentsContainer');
            if (container) {
                container.innerHTML = '<div style="text-align: center; padding: 40px; color: #6B7280;">Ödeme sistemi yakında aktif olacak...</div>';
            }
        } catch (error) {
            console.error('Payments screen load error:', error);
        }
    }

    // Load calendar screen
    async loadCalendarScreen() {
        try {
            console.log('📅 Loading calendar screen...');
            const container = document.getElementById('calendarContainer');
            if (container) {
                container.innerHTML = '<div style="text-align: center; padding: 40px; color: #6B7280;">Takvim sistemi yakında aktif olacak...</div>';
            }
        } catch (error) {
            console.error('Calendar screen load error:', error);
        }
    }

    createRecentActivitiesCard() {
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        card.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        `;

        const title = SecurityUtils.createSafeElement('h3', 'Son Aktiviteler');
        title.style.cssText = 'margin: 0 0 16px 0; color: #1F2937;';

        const placeholder = SecurityUtils.createSafeElement('p', 'Aktivite geçmişi yükleniyor...');
        placeholder.style.cssText = 'color: #6B7280; text-align: center; padding: 20px;';

        card.appendChild(title);
        card.appendChild(placeholder);

        return card;
    }
}

// Initialize secure app
document.addEventListener('DOMContentLoaded', () => {
    // Wait for all dependencies to be ready
    const initializeApp = () => {
        try {
            // Check if all required dependencies are loaded
            const hasSupabase = typeof window.supabase !== 'undefined';
            const hasConfig = typeof window.supabaseUrl !== 'undefined' && typeof window.supabaseKey !== 'undefined';
            const hasClient = typeof window.supabaseClient !== 'undefined';
            const hasSecurityUtils = typeof SecurityUtils !== 'undefined';
            const hasDOMUtils = typeof DOMUtils !== 'undefined';
            const hasPerformanceUtils = typeof performanceUtils !== 'undefined';
            const hasSupabaseService = typeof supabaseService !== 'undefined';
            
            console.log('🔍 Dependency check:', {
                supabase: hasSupabase,
                config: hasConfig,
                client: hasClient,
                security: hasSecurityUtils,
                dom: hasDOMUtils,
                performance: hasPerformanceUtils,
                service: hasSupabaseService
            });
            
            if (!hasSecurityUtils || !hasDOMUtils || !hasPerformanceUtils || !hasSupabaseService) {
                console.log('⏳ Waiting for dependencies...');
                setTimeout(initializeApp, 200);
                return;
            }
            
            if (!hasSupabase || (!hasConfig && !hasClient)) {
                console.log('⏳ Waiting for Supabase...');
                setTimeout(initializeApp, 200);
                return;
            }
            
            // Initialize performance monitoring
            performanceUtils.setupLazyLoading();
            
            // Initialize Supabase service first
            supabaseService.initialize();
            
            // Small delay to ensure Supabase is ready
            setTimeout(() => {
                // Initialize secure app
                window.app = new SecureSportsManagementApp();
                console.log('🛡️ Secure Sports Management App initialized');
            }, 100);
            
        } catch (error) {
            console.error('❌ App initialization error:', error);
            // Retry after a longer delay
            setTimeout(initializeApp, 1000);
        }
    };
    
    // Start initialization with a small delay
    setTimeout(initializeApp, 100);
});

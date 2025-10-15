// Supabase Service Layer
// Tüm veritabanı işlemleri bu dosyada yapılacak

class SupabaseService {
    constructor() {
        this.supabase = null;
    }

    // Compute available stock for an equipment type and size
    async getAvailableEquipmentQuantity(equipmentTypeId, size = null) {
        try {
            if (!this.supabase) this.initialize();

            // 1) Get total stock from equipment_types
            const { data: eq, error: eqErr } = await this.supabase
                .from('equipment_types')
                .select('id, quantity')
                .eq('id', equipmentTypeId)
                .single();
            if (eqErr) throw eqErr;
            const total = parseInt(eq?.quantity || 0, 10) || 0;

            if (total <= 0) return { success: true, available: 0 };

            // 2) Sum of currently assigned quantities for this equipment type (and size if provided)
            let query = this.supabase
                .from('equipment_assignments')
                .select('quantity')
                .eq('equipment_type_id', equipmentTypeId)
                .eq('status', 'assigned');
            if (size) {
                query = query.eq('size', size);
            }
            const { data: assignedRows, error: assErr } = await query;
            if (assErr) throw assErr;

            const assignedTotal = (assignedRows || []).reduce((sum, r) => sum + (parseInt(r.quantity, 10) || 0), 0);
            const available = Math.max(0, total - assignedTotal);
            return { success: true, available };
        } catch (error) {
            console.error('Error computing available equipment quantity:', error);
            return { success: false, error: error.message };
        }
    }

    // Add stock to an equipment type for a specific size.
    // Since per-size stock table doesn't exist, we treat each size as a separate equipment_types row (same name, different size).
    async addStockToEquipmentType(equipmentTypeId, size, quantity) {
        try {
            if (!this.supabase) this.initialize();
            const addQty = parseInt(quantity, 10) || 0;
            if (!equipmentTypeId || !size || isNaN(addQty) || addQty <= 0) {
                return { success: false, error: 'Geçersiz stok bilgisi' };
            }

            // Load the clicked/base row to determine the parent equipment (size group)
            const { data: baseType, error: baseErr } = await this.supabase
                .from('equipment_types')
                .select('*')
                .eq('id', equipmentTypeId)
                .single();
            if (baseErr) throw baseErr;

            // Determine the group parent id: if this row has size_id, use it; otherwise this row is the parent
            const parentId = baseType.size_id || baseType.id;

            // If this base row is already for the requested size, increase its own quantity
            if ((baseType.size || '').toString() === size.toString() && (baseType.id === parentId)) {
                const { data: upd, error: updErr } = await this.supabase
                    .from('equipment_types')
                    .update({ quantity: (parseInt(baseType.quantity, 10) || 0) + addQty, updated_at: new Date().toISOString() })
                    .eq('id', baseType.id)
                    .select();
                if (updErr) throw updErr;
                return { success: true, data: upd };
            }

            // Find an existing variant in the group with the desired size
            const { data: sibling, error: sibErr } = await this.supabase
                .from('equipment_types')
                .select('*')
                .eq('size_id', parentId)
                .eq('size', size)
                .limit(1)
                .maybeSingle();
            if (sibErr) throw sibErr;

            if (sibling) {
                const { data: upd2, error: updErr2 } = await this.supabase
                    .from('equipment_types')
                    .update({ quantity: (parseInt(sibling.quantity, 10) || 0) + addQty, updated_at: new Date().toISOString() })
                    .eq('id', sibling.id)
                    .select();
                if (updErr2) throw updErr2;
                return { success: true, data: upd2 };
            }

            // No variant exists: create a new variant row for this size under the parent
            const newRow = {
                name: baseType.name,
                size_id: parentId,
                size: size,
                quantity: addQty,
                photo_url: baseType.photo_url || null,
                fee: baseType.fee || null,
                created_by: baseType.created_by || null
            };
            const { data: ins, error: insErr } = await this.supabase
                .from('equipment_types')
                .insert([newRow])
                .select();
            if (insErr) throw insErr;
            return { success: true, data: ins };
        } catch (error) {
            console.error('Add stock error:', error);
            return { success: false, error: error.message };
        }
    }

    initialize() {
        // Use the global supabase instance if it exists, otherwise create one
        if (window.supabase && typeof window.supabase.createClient === 'function') {
            // Check if global supabase client already exists
            if (window.supabaseClient) {
                this.supabase = window.supabaseClient;
                console.log('Using existing Supabase client instance');
            } else {
                this.supabase = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
                window.supabaseClient = this.supabase; // Store globally to prevent multiple instances
                console.log('Created new Supabase client instance');
            }
            return this.supabase;
        } else {
            console.error('Supabase library not available');
            return null;
        }
    }

    // Recalculate unpaid future payments for a student according to current discount
    async recalculateFuturePaymentsForStudent(studentId) {
        try {
            if (!this.supabase) this.initialize();

            // Load student
            const stuRes = await this.getStudent(studentId);
            if (!stuRes.success || !stuRes.data) return { success: false, error: 'Student not found' };
            const student = stuRes.data;

            // Determine base monthly fee from sport branch
            const branches = await this.getSportBranches();
            let monthlyFee = 500;
            if (branches.success) {
                const wanted = (student.sport || student.branch || '').toString().toLowerCase();
                const branch = branches.data.find(b => (b.name || '').toString().toLowerCase() === wanted || b.id === student.sport_branch_id);
                if (branch) monthlyFee = branch.monthly_fee || branch.fee || monthlyFee;
            }
            const discountRate = student.discount_rate || 0;
            const newAmount = parseFloat((monthlyFee * (1 - (discountRate/100))).toFixed(2));

            // Compute current year-month
            const now = new Date();
            const y = now.getFullYear();
            const m = now.getMonth() + 1;

            // Fetch unpaid payments for this student
            const { data: payments, error } = await this.supabase
                .from('payments')
                .select('id, period_year, period_month, payment_period, is_paid')
                .eq('student_id', studentId)
                .eq('is_paid', false)
                .is('equipment_assignment_id', null);
            if (error) throw error;

            // Determine if payment is current or future using period_year/month OR payment_period
            const toUpdate = (payments || []).filter(p => {
                // If period_year/month exist
                if (p.period_year && p.period_month) {
                    return (p.period_year > y) || (p.period_year === y && p.period_month >= m);
                }
                // Else if payment_period exists as 'YYYY-MM'
                if (p.payment_period && typeof p.payment_period === 'string') {
                    const parts = p.payment_period.split('-');
                    if (parts.length >= 2) {
                        const py = parseInt(parts[0], 10);
                        const pm = parseInt(parts[1], 10);
                        if (!isNaN(py) && !isNaN(pm)) {
                            return (py > y) || (py === y && pm >= m);
                        }
                    }
                }
                // If none present, conservatively update (treat as current)
                return true;
            });
            if (toUpdate.length === 0) return { success: true, updated: 0 };

            const ids = toUpdate.map(p => p.id);
            const { data: upd, error: updErr } = await this.supabase
                .from('payments')
                .update({ amount: newAmount, updated_at: new Date().toISOString() })
                .in('id', ids)
                .select('id');
            if (updErr) throw updErr;

            // Optional: log activity
            try {
                await this.logActivity('update', 'payment', null, `Öğrenci indirim oranı güncellendi. ${ids.length} adet gelecek dönem ödemesi yeni tutara göre güncellendi.`);
            } catch (_) {}

            return { success: true, updated: ids.length };
        } catch (e) {
            console.error('Recalculate payments error:', e);
            return { success: false, error: e.message };
        }
    }

    // Authentication methods
    async signUp(email, password, userData = {}) {
        try {
            const { data, error } = await this.supabase.auth.signUp({
                email,
                password,
                options: {
                    data: userData
                }
            });
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('SignUp error:', error);
            return { success: false, error: error.message };
        }
    }

    async signIn(emailOrUsername, password) {
        console.log('=== LOGIN ATTEMPT START ===');
        console.log('Email/Username:', emailOrUsername);
        // GÜVENLİK: Şifre uzunluğu bile loglanmamalı
        
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            // First try: Check user_profiles table (new users)
            try {
                console.log('Trying user_profiles table...');
                const hashedPassword = await this.hashPassword(password);
                // GÜVENLİK: Hash'lenmiş şifre loglanmamalı
                
                let query = this.supabase
                    .from('user_profiles')
                    .select('*');
                    
                // Check if input looks like email or username
                if (emailOrUsername.includes('@')) {
                    query = query.eq('email', emailOrUsername);
                    console.log('Searching by email:', emailOrUsername);
                } else {
                    query = query.eq('username', emailOrUsername);
                    console.log('Searching by username:', emailOrUsername);
                }
                
                const { data: users, error } = await query;
                console.log('Query result:', { 
                    userCount: users?.length || 0, 
                    hasError: !!error,
                    errorCode: error?.code 
                    // GÜVENLİK: Kullanıcı verileri loglanmamalı
                });
                
                if (!error && users && users.length > 0) {
                    const user = users[0];
                    console.log('Found user:', { 
                        username: user.username, 
                        email: user.email, 
                        is_active: user.is_active,
                        has_password: !!user.password
                        // GÜVENLİK: Şifre hash'i hiçbir şekilde loglanmamalı
                    });
                    
                    // Check if user is active
                    if (!user.is_active) {
                        throw new Error('Hesabınız devre dışı bırakılmış');
                    }
                    
                    // Verify password
                    if (user.password === hashedPassword) {
                        // GÜVENLİK: Şifre doğrulama başarılı - detay loglanmıyor
                        return { 
                            success: true, 
                            user: {
                                id: user.id,
                                username: user.username,
                                email: user.email,
                                role: user.role,
                                full_name: user.full_name
                            },
                            data: user
                        };
                    } else {
                        // GÜVENLİK: Şifre doğrulama başarısız - detay loglanmıyor
                        return { success: false, error: 'Geçersiz kullanıcı adı veya şifre' };
                    }
                } else {
                    console.log('No user found in user_profiles table');
                }
            } catch (profileError) {
                console.log('User profiles search error:', profileError);
                console.log('Trying auth.users...');
            }
            
            // Second try: Use Supabase Auth (existing users like admin@atkoy.com)
            try {
                const { data, error } = await this.supabase.auth.signInWithPassword({
                    email: emailOrUsername,
                    password
                });
                
                if (!error && data.user) {
                    return { 
                        success: true, 
                        user: {
                            id: data.user.id,
                            email: data.user.email,
                            username: data.user.email,
                            full_name: data.user.email,
                            role: 'admin' // Default role for auth users
                        },
                        data: data.user
                    };
                }
            } catch (authError) {
                console.log('Auth login also failed:', authError.message);
            }
            
            // If both methods fail
            throw new Error('E-posta/kullanıcı adı veya şifre hatalı');
            
        } catch (error) {
            console.error('SignIn error:', error);
            return { success: false, error: error.message };
        }
    }

    // Password hashing function (same as in frontend)
    async hashPassword(password) {
        try {
            // Convert password to ArrayBuffer
            const encoder = new TextEncoder();
            const data = encoder.encode(password);
            
            // Hash the password using SHA-256
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            
            // Convert ArrayBuffer to hex string
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            
            return hashHex;
        } catch (error) {
            console.error('Password hashing error:', error);
            // Fallback to simple encoding (not recommended for production)
            return btoa(password);
        }
    }

    async signOut() {
        try {
            // Önce mevcut kullanıcıyı kontrol et
            const { data: { user }, error: userError } = await this.supabase.auth.getUser();
            
            // Kullanıcı varsa ve hata yoksa log kaydı yap
            if (user && !userError) {
                try {
                    await this.addActivityLog(
                        'logout',
                        'user',
                        user.id,
                        `${user.email} kullanıcısı çıkış yaptı`,
                        user // Kullanıcı bilgilerini parametre olarak geç
                    );
                } catch (logError) {
                    console.error('Çıkış log kaydı eklenirken hata:', logError);
                }
            }
    
            // Çıkış işlemini yap
            const { error } = await this.supabase.auth.signOut();
            if (error) throw error;
    
            return { success: true };
        } catch (error) {
            console.error('Çıkış yapılırken hata oluştu:', error);
            return { success: false, error: error.message };
        }
    }

    getCurrentUser() {
        return this.supabase.auth.getUser();
    }

    onAuthStateChange(callback) {
        return this.supabase.auth.onAuthStateChange(callback);
    }

    // User management methods
    async createUser(userData) {
        try {
            // First create auth user
            const { data: authData, error: authError } = await this.supabase.auth.signUp({
                email: userData.email,
                password: userData.password,
                options: {
                    data: {
                        full_name: userData.full_name,
                        username: userData.username
                    }
                }
            });
            
            if (authError) throw authError;
            
            // Then create user profile
            const profileData = {
                user_id: authData.user.id,
                tcno: userData.tcno,
                full_name: userData.full_name,
                birth_date: userData.birth_date,
                phone: userData.phone,
                email: userData.email,
                username: userData.username,
                role: userData.role,
                photo: userData.photo,
                certificate: userData.certificate
            };
            
            const { data: profileResult, error: profileError } = await this.supabase
                .from('user_profiles')
                .insert([profileData]);
            
            if (profileError) throw profileError;
            return { success: true, data: { user: authData.user, profile: profileResult } };
        } catch (error) {
            console.error('Create user error:', error);
            return { success: false, error: error.message };
        }
    }

    async getUsers() {
        try {
            const { data, error } = await this.supabase
                .from('user_profiles')
                .select('*')
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get users error:', error);
            return { success: false, error: error.message };
        }
    }

    async getUserProfile(userId) {
        try {
            const { data, error } = await this.supabase
                .from('user_profiles')
                .select('*')
                .eq('id', userId)  // Changed from user_id to id
                .single();
            
            if (error) {
                // If no profile found, create a default one
                if (error.code === 'PGRST116') {
                    console.log('No user profile found, creating default profile for user:', userId);
                    
                    // Get user email from auth
                    const { data: { user } } = await this.supabase.auth.getUser();
                    
                    const defaultProfile = {
                        id: userId,
                        user_id: userId,
                        username: user?.email?.split('@')[0] || 'user',
                        full_name: user?.email?.split('@')[0] || 'User',
                        role: this.isAdminEmail(user?.email) ? 'admin' : 'user',
                        phone: null
                    };
                    
                    const createResult = await this.createUserProfile(defaultProfile);
                    if (createResult.success) {
                        return { success: true, data: createResult.data };
                    }
                }
                throw error;
            }
            return { success: true, data };
        } catch (error) {
            console.error('Get user profile error:', error);
            return { success: false, error: error.message };
        }
    }

    async updateUser(userId, userData) {
        try {
            const { data, error } = await this.supabase
                .from('user_profiles')
                .update(userData)
                .eq('id', userId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Update user error:', error);
            return { success: false, error: error.message };
        }
    }

    async deleteUser(userId) {
        try {
            const { data, error } = await this.supabase
                .from('user_profiles')
                .delete()
                .eq('id', userId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Delete user error:', error);
            return { success: false, error: error.message };
        }
    }
    async uploadStudentPhoto(file, filePath) {
        try {
            console.log('Uploading file to Supabase Storage:', filePath);
            
            const { data, error } = await this.supabase.storage
                .from('student-photos')
                .upload(filePath, file, {
                    cacheControl: '3600',
                    upsert: true
                });
            
            if (error) {
                console.error('Storage upload error:', error);
                return { success: false, error: error.message };
            }
            
            // Public URL al
            const { data: urlData } = this.supabase.storage
                .from('student-photos')
                .getPublicUrl(filePath);
            
            return { 
                success: true, 
                data: data,
                publicUrl: urlData.publicUrl 
            };
        } catch (error) {
            console.error('Upload student photo error:', error);
            return { success: false, error: error.message };
        }
    }
    // GÜVENLİK: Admin email kontrolü
    isAdminEmail(email) {
        const adminEmails = ['admin@atkoy.com']; // Buraya yeni admin emailler eklenebilir
        return adminEmails.includes(email);
    }

    // Helper method to create admin user
    async createAdminUser() {
        try {
            // GÜVENLİK: Admin credentials environment'dan alınmalı
            // Production'da bu fonksiyon devre dışı bırakılmalı
            if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
                console.warn('Admin user creation disabled in production');
                return { success: false, error: 'Admin user creation disabled in production' };
            }

            const adminData = {
                email: 'admin@atkoy.com',
                password: 'AtkoySporAdmin2024!', // GÜVENLİK: Güçlü şifre kullanıldı
                tcno: '12345678901',
                full_name: 'Admin User',
                birth_date: '1990-01-01',
                phone: '05551234567',
                username: 'admin',
                role: 'admin',
                photo: null,
                certificate: null
            };
            
            return await this.createUser(adminData);
        } catch (error) {
            console.error('Create admin user error:', error);
            return { success: false, error: error.message };
        }
    }

    // Activity logging helper
    async logActivity(action, entity_type, entity_id, description) {
        try {
            const logData = {
                action,
                entity_type,
                entity_id,
                description
            };
            
            return await this.createActivityLog(logData);
        } catch (error) {
            console.error('Log activity error:', error);
            return { success: false, error: error.message };
        }
    }

    // File upload helper with proper path handling
    async uploadFile(file, folder = 'uploads') {
        try {
            const fileExt = file.name.split('.').pop();
            const fileName = `${Date.now()}.${fileExt}`;
            const filePath = `${folder}/${fileName}`;
            
            const { data, error } = await this.supabase.storage
                .from('files')
                .upload(filePath, file);
            
            if (error) throw error;
            
            const publicUrl = this.getFileUrl('files', filePath);
            return { success: true, data, url: publicUrl };
        } catch (error) {
            console.error('Upload file error:', error);
            return { success: false, error: error.message };
        }
    }

    // Student payments helper
    async getStudentPayments(studentId) {
        try {
            // Validate UUID format
            if (!studentId || typeof studentId !== 'string') {
                console.warn('Invalid studentId provided:', studentId);
                return { success: true, data: [] };
            }
            
            // Check if studentId is a valid UUID format
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(studentId)) {
                console.warn('StudentId is not a valid UUID:', studentId);
                return { success: true, data: [] };
            }

            const { data, error } = await this.supabase
                .from('payments')
                .select('*')
                .eq('student_id', studentId)
                .order('payment_date', { ascending: false });
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get student payments error:', error);
            return { success: false, error: error.message };
        }
    }

    // Unpaid payments for a student (aidatlar ekranından kaldırmak için)
    async getUnpaidPaymentsForStudent(studentId) {
        try {
            if (!this.supabase) this.initialize();
            const { data, error } = await this.supabase
                .from('payments')
                .select('id, amount, due_date, description, is_paid')
                .eq('student_id', studentId)
                .eq('is_paid', false)
                .order('due_date', { ascending: true });
            if (error) throw error;
            return { success: true, data: data || [] };
        } catch (error) {
            console.error('Get unpaid payments error:', error);
            return { success: false, error: error.message };
        }
    }

    async deleteUnpaidPaymentsForStudent(studentId) {
        try {
            if (!this.supabase) this.initialize();
            const { data, error } = await this.supabase
                .from('payments')
                .delete()
                .eq('student_id', studentId)
                .eq('is_paid', false);
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Delete unpaid payments error:', error);
            return { success: false, error: error.message };
        }
    }

    // Student methods
    async createStudent(studentData) {
        try {
            console.log('Creating student with data:', JSON.stringify(studentData, null, 2));
            const { data, error } = await this.supabase
                .from('students')
                .insert([studentData])
                .select();
            
            if (error) {
                console.error('Supabase student creation error:', error);
                throw error;
            }
            
            // If student has a sport branch, create payment record
            if (data && data[0] && (studentData.sport_branch || studentData.branch || studentData.sport)) {
                const sportBranch = studentData.sport_branch || studentData.branch || studentData.sport;
                console.log('Creating payment record for sport branch:', sportBranch);
                await this.createInitialPaymentRecord(data[0], sportBranch);
            } else {
                console.log('No sport branch found in student data:', studentData);
            }
            
            return { success: true, data };
        } catch (error) {
            console.error('Create student error:', error);
            return { success: false, error: error.message };
        }
    }

    async createInitialPaymentRecord(student, sportBranch) {
        try {
            console.log('Creating payment record for student:', student.id, 'sport branch:', sportBranch);
            
            // Get sport branch details to determine payment amount
            const branchResult = await this.getSportBranches();
            let monthlyFee = 500; // Default fee
            let sportBranchId = null;
            
            if (branchResult.success) {
                const wanted = (sportBranch || '').toString().toLowerCase();
                const branch = branchResult.data.find(b => (b.name || '').toString().toLowerCase() === wanted || b.id === sportBranch);
                if (branch) {
                    monthlyFee = branch.monthly_fee || branch.fee || 500;
                    sportBranchId = branch.id;
                    console.log('Found sport branch:', branch.name, 'fee:', monthlyFee);
                }
            }
            
            // Apply student discount if any
            const discountRate = (student.discount_rate || 0);
            const discountedAmount = Math.round((monthlyFee * (100 - discountRate)))/100; // keep 2 decimals later
            const finalAmount = parseFloat((monthlyFee * (1 - (discountRate/100))).toFixed(2));

            // Create payment record for current month
            const currentDate = new Date();
            const year = currentDate.getFullYear();
            const month = currentDate.getMonth() + 1;
            
            const paymentData = {
                student_id: student.id,
                sport_branch_id: sportBranchId,
                amount: finalAmount,
                payment_date: null, // Not paid yet
                payment_method: 'cash',
                period_month: month,
                period_year: year,
                payment_period: `${year}-${String(month).padStart(2, '0')}`,
                notes: `${sportBranch} branşı için aylık aidat - ${year}-${String(month).padStart(2, '0')}`,
                is_paid: false,
                created_by: this.currentUser?.id || null
            };
            
            console.log('Creating payment with data:', paymentData);
            const result = await this.createPayment(paymentData);
            
            if (result.success) {
                console.log('✅ Payment record created successfully:', result.data);
                
                // Log the activity
                await this.logActivity('create', 'payment', result.data?.[0]?.id, 
                    `Öğrenci için aylık aidat kaydı oluşturuldu: ${student.first_name || student.name} ${student.last_name || student.surname} - ${sportBranch}`);
            } else {
                console.error('❌ Failed to create payment record:', result.error);
            }
            
            return result;
            
        } catch (error) {
            console.error('Error creating initial payment record:', error);
            return { success: false, error: error.message };
        }
    }

    async getStudentsWithBranch() {
        try {
            const { data, error } = await this.supabase
                .from('students')
                .select(`
                    *,
                    sport_branches (name)
                `);
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Error getting students with branch:', error.message);
            return { success: false, error };
        }
    }

    async getStudents() {
        try {
            if (!this.supabase) {
                this.initialize();
            }

            // Fetch a minimal column set to avoid heavy payloads (base64 photos etc.)
            // Prefer thumbnails for UI; full photo fetched on demand via getStudent()
            const minimalColumns = 'id,name,surname,birth_date,sport,gender,phone,payment_status,is_deleted,photo_thumb_url,created_at';

            const { data, error } = await this.supabase
                .from('students')
                .select(minimalColumns)
                .order('created_at', { ascending: false })
                .limit(500);

            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get students error:', error);
            return { success: false, error: error.message };
        }
    }
    async getStudent(studentId) {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            const { data, error } = await this.supabase
                .from('students')
                .select('*')
                .eq('id', studentId)
                .single();
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get student error:', error);
            return { success: false, error: error.message };
        }
    }
    async updateStudent(studentId, studentData) {
        try {
            const { data, error } = await this.supabase
                .from('students')
                .update(studentData)
                .eq('id', studentId);
        
            if (error) throw error;

            // After any student update, recalc future unpaid payments according to latest discount & branch
            try {
                await this.recalculateFuturePaymentsForStudent(studentId);
            } catch (_) {}

            return { success: true, data };
        } catch (error) {
            console.error('Update student error:', error);
            return { success: false, error: error.message };
        }
    }
    async getUserByUsername(username) {
        try {
            const { data, error } = await this.supabase
                .from('user_profiles')
                .select('*')
                .eq('username', username)
                .limit(1);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get user by username error:', error);
            return { success: false, error: error.message };
        }
    }
    
    async getEquipmentTypes() {
        try {
            if (!this.supabase) this.initialize();
            
            // PERFORMANS: Paralel query'ler ile N+1 problemini çöz
            const [eqTypesResult, assignmentsResult] = await Promise.all([
                this.supabase
                    .from('equipment_types')
                    .select('*')
                    .order('created_at', { ascending: false }),
                this.supabase
                    .from('equipment_assignments')
                    .select('equipment_type_id, size, quantity')
                    .eq('status', 'assigned')
            ]);

            if (eqTypesResult.error) throw eqTypesResult.error;
            if (assignmentsResult.error) throw assignmentsResult.error;

            const eqTypes = eqTypesResult.data || [];
            const allAssignments = assignmentsResult.data || [];

            // PERFORMANS: Assignments'ları equipment_type_id'ye göre grupla
            const assignmentsByEquipmentId = {};
            allAssignments.forEach(assignment => {
                const id = assignment.equipment_type_id;
                if (!assignmentsByEquipmentId[id]) {
                    assignmentsByEquipmentId[id] = [];
                }
                assignmentsByEquipmentId[id].push(assignment);
            });

            const enriched = [];
            for (const eq of eqTypes) {
                // total stock
                const totalQty = parseInt(eq.quantity || 0, 10) || 0;

                // PERFORMANS: Önceden gruplandırılmış assignments'ları kullan
                const assignedRows = assignmentsByEquipmentId[eq.id] || [];
                const assignedTotal = assignedRows.reduce((s, r) => s + (parseInt(r.quantity, 10) || 0), 0);
                const availableTotal = Math.max(0, totalQty - assignedTotal);

                // per-size availability if size stock table exists
                let sizeAvailability = null;
                let sizesList = [];
                if (eq.size && typeof eq.size === 'string') {
                    sizesList = eq.size.split(',').map(s => s.trim()).filter(Boolean);
                }
                if (sizesList.length > 0) {
                    try {
                        // Try to get per-size defined stocks
                        const { data: sizeStocks, error: ssErr } = await this.supabase
                            .from('equipment_size_stock')
                            .select('size, quantity')
                            .eq('equipment_type_id', eq.id);
                        if (ssErr && ssErr.code !== '42P01') throw ssErr; // 42P01 table not found

                        // Build assigned per size map
                        const assignedBySize = {};
                        (assignedRows || []).forEach(r => {
                            const key = (r.size || '').toString();
                            const q = parseInt(r.quantity, 10) || 0;
                            assignedBySize[key] = (assignedBySize[key] || 0) + q;
                        });

                        if (Array.isArray(sizeStocks)) {
                            sizeAvailability = {};
                            sizesList.forEach(sz => {
                                const stockRow = sizeStocks.find(x => (x.size || '').toString() === sz);
                                const total = parseInt(stockRow?.quantity || 0, 10) || 0;
                                const assigned = parseInt(assignedBySize[sz] || 0, 10) || 0;
                                sizeAvailability[sz] = {
                                    total,
                                    assigned,
                                    available: Math.max(0, total - assigned)
                                };
                            });
                        }
                    } catch (e) {
                        // If table doesn't exist or error, leave sizeAvailability as null
                        console.warn('Per-size stock not available:', e.message);
                    }
                }

                enriched.push({
                    ...eq,
                    total_quantity: totalQty,
                    assigned_quantity: assignedTotal,
                    available_quantity: availableTotal,
                    size_availability: sizeAvailability
                });
            }

            return { success: true, data: enriched };
        } catch (error) {
            console.error('Get equipment types error:', error);
            return { success: false, error: error.message };
        }
    }
    // Sport branches methods
    async createSportBranch(branchData) {
        try {
            const { data, error } = await this.supabase
                .from('sport_branches')
                .insert([branchData]);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Create sport branch error:', error);
            return { success: false, error: error.message };
        }
    }

    async getSportBranches() {
        try {
            const { data, error } = await this.supabase
                .from('sport_branches')
                .select('*')
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get sport branches error:', error);
            return { success: false, error: error.message };
        }
    }

    async updateSportBranch(branchId, branchData) {
        try {
            const { data, error } = await this.supabase
                .from('sport_branches')
                .update(branchData)
                .eq('id', branchId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Update sport branch error:', error);
            return { success: false, error: error.message };
        }
    }

    async deleteSportBranch(branchId) {
        try {
            const { data, error } = await this.supabase
                .from('sport_branches')
                .delete()
                .eq('id', branchId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Delete sport branch error:', error);
            return { success: false, error: error.message };
        }
    }

    // Equipment types methods
    async createEquipmentType(equipmentData) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_types')
                .insert([equipmentData]);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Create equipment type error:', error);
            return { success: false, error: error.message };
        }
    }

    async getEquipmentTypes() {
        try {
            const { data, error } = await this.supabase
                .from('equipment_types')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get equipment types error:', error);
            return { success: false, error: error.message };
        }
    }

    async getEquipmentType(equipmentId) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_types')
                .select('*')
                .eq('id', equipmentId)
                .single();
        
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get equipment type error:', error);
            return { success: false, error: error.message };
        }
    }

    // Update one equipment type row, and if certain fields are provided, propagate them
    // to all equipment_types rows that have the same size_id (variants of this equipment)
    async updateEquipmentType(equipmentId, equipmentData) {
        try {
            if (!this.supabase) this.initialize();

            // Update the targeted row first
            const { data: updatedRows, error: updErr } = await this.supabase
                .from('equipment_types')
                .update({ ...equipmentData, updated_at: new Date().toISOString() })
                .eq('id', equipmentId)
                .select('*');
            if (updErr) throw updErr;

            const updated = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;
            if (!updated) {
                return { success: true, data: updatedRows };
            }

            // Build propagation fields by intersecting with known columns to avoid errors
            const updatedSample = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;
            const allowedKeys = Object.keys(updatedSample || {});
            const candidateKeys = Object.keys(equipmentData || {});
            const propagateFields = { updated_at: new Date().toISOString() };
            let hasAny = false;
            for (const k of candidateKeys) {
                if (k === 'id' || k === 'size' || k === 'size_id' || k === 'quantity' || k === 'created_at') continue; // do not propagate these
                if (allowedKeys.includes(k)) {
                    propagateFields[k] = equipmentData[k];
                    hasAny = true;
                }
            }

            if (!hasAny) {
                return { success: true, data: updatedRows };
            }

            // Determine the parent group id
            const parentId = updated.size_id || updated.id;

            // Propagate to all rows that belong to this group (including parent itself)
            const { data: propagated, error: propErr } = await this.supabase
                .from('equipment_types')
                .update(propagateFields)
                .or(`id.eq.${parentId},size_id.eq.${parentId}`);
            if (propErr) throw propErr;

            return { success: true, data: { updated: updatedRows, propagated } };
        } catch (error) {
            console.error('Update equipment type error:', error);
            return { success: false, error: error.message };
        }
    }

    async deleteEquipmentType(equipmentId) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_types')
                .delete()
                .eq('id', equipmentId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Delete equipment type error:', error);
            return { success: false, error: error.message };
        }
    }

    // Equipment assignments methods
    async createEquipmentAssignment(assignmentData) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_assignments')
                .insert([assignmentData]);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Create equipment assignment error:', error);
            return { success: false, error: error.message };
        }
    }

    async getEquipmentAssignments() {
        try {
            const { data, error } = await this.supabase
                .from('equipment_assignments')
                .select(`
                    *,
                    students(name, surname, tc_no),
                    equipment_types(name, size)
                `)
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get equipment assignments error:', error);
            return { success: false, error: error.message };
        }
    }

    async updateEquipmentAssignment(assignmentId, assignmentData) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_assignments')
                .update(assignmentData)
                .eq('id', assignmentId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Update equipment assignment error:', error);
            return { success: false, error: error.message };
        }
    }

    async getStudentEquipmentAssignments(studentId) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_assignments')
                .select(`
                    *,
                    equipment_types(name, size)
                `)
                .eq('student_id', studentId)
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get student equipment assignments error:', error);
            return { success: false, error: error.message };
        }
    }

    async deleteEquipmentAssignment(assignmentId) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_assignments')
                .delete()
                .eq('id', assignmentId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Delete equipment assignment error:', error);
            return { success: false, error: error.message };
        }
    }

    // Training methods
    async createTraining(trainingData) {
        try {
            const { data, error } = await this.supabase
                .from('trainings')
                .insert([trainingData])
                .select();
            
            if (error) throw error;
            return { success: true, data: data?.[0] || null };
        } catch (error) {
            console.error('Create training error:', error);
            return { success: false, error: error.message };
        }
    }

    async getTrainings() {
        try {
            const { data, error } = await this.supabase
                .from('trainings')
                .select('*')
                .order('date', { ascending: true });
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get trainings error:', error);
            return { success: false, error: error.message };
        }
    }

    async updateTraining(trainingId, trainingData) {
        try {
            const { data, error } = await this.supabase
                .from('trainings')
                .update(trainingData)
                .eq('id', trainingId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Update training error:', error);
            return { success: false, error: error.message };
        }
    }

    async deleteTraining(trainingId) {
        try {
            const { data, error } = await this.supabase
                .from('trainings')
                .delete()
                .eq('id', trainingId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Delete training error:', error);
            return { success: false, error: error.message };
        }
    }

    // Training attendance methods
    async createTrainingAttendance(attendanceData) {
        try {
            const { data, error } = await this.supabase
                .from('training_attendance')
                .insert([attendanceData]);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Create training attendance error:', error);
            return { success: false, error: error.message };
        }
    }

    async getTrainingAttendance(trainingId) {
        try {
            const { data, error } = await this.supabase
                .from('training_attendance')
                .select(`
                    *,
                    students(name, surname, tc_no)
                `)
                .eq('training_id', trainingId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get training attendance error:', error);
            return { success: false, error: error.message };
        }
    }

    async updateTrainingAttendance(attendanceId, attendanceData) {
        try {
            const { data, error } = await this.supabase
                .from('training_attendance')
                .update(attendanceData)
                .eq('id', attendanceId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Update training attendance error:', error);
            return { success: false, error: error.message };
        }
    }

    // Student enrollments methods
    async createStudentEnrollment(enrollmentData) {
        try {
            const { data, error } = await this.supabase
                .from('student_enrollments')
                .insert([enrollmentData]);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Create student enrollment error:', error);
            return { success: false, error: error.message };
        }
    }

    async getStudentEnrollments() {
        try {
            const { data, error } = await this.supabase
                .from('student_enrollments')
                .select(`
                    *,
                    students(name, surname, tc_no),
                    sport_branches(name, fee)
                `)
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get student enrollments error:', error);
            return { success: false, error: error.message };
        }
    }

    async updateStudentEnrollment(enrollmentId, enrollmentData) {
        try {
            const { data, error } = await this.supabase
                .from('student_enrollments')
                .update(enrollmentData)
                .eq('id', enrollmentId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Update student enrollment error:', error);
            return { success: false, error: error.message };
        }
    }

    // Payment methods
    async createPayment(paymentData) {
        try {
            const { data, error } = await this.supabase
                .from('payments')
                .insert([paymentData]);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Create payment error:', error);
            return { success: false, error: error.message };
        }
    }

    async getPayments() {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            const { data, error } = await this.supabase
                .from('payments')
                .select(`
                    *,
                    students(first_name, last_name, name, surname, tc_no),
                    sport_branches(name, fee)
                `)
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            
            // Enrich payment data with student and branch names
            const enrichedData = data?.map(payment => ({
                ...payment,
                student_name: payment.students ? 
                    `${payment.students.first_name || payment.students.name || ''} ${payment.students.last_name || payment.students.surname || ''}`.trim() :
                    'Bilinmeyen Öğrenci',
                sport_branch_name: payment.sport_branches?.name || 'Bilinmeyen Branş'
            })) || [];
            
            return { success: true, data: enrichedData };
        } catch (error) {
            console.error('Get payments error:', error);
            return { success: false, error: error.message };
        }
    }

    async updatePayment(paymentId, paymentData) {
        try {
            const { data, error } = await this.supabase
                .from('payments')
                .update(paymentData)
                .eq('id', paymentId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Update payment error:', error);
            return { success: false, error: error.message };
        }
    }
    async getPayment(paymentId) {
        try {
            const { data, error } = await this.supabase
                .from('payments')
                .select('*')
                .eq('id', paymentId)
                .single();
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get payment error:', error);
            return { success: false, error: error.message };
        }
    }
    async deletePayment(paymentId) {
        try {
            const { data, error } = await this.supabase
                .from('payments')
                .delete()
                .eq('id', paymentId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Delete payment error:', error);
            return { success: false, error: error.message };
        }
    }

    async getPaymentsByStudent(studentId) {
        try {
            const { data, error } = await this.supabase
                .from('payments')
                .select(`
                    *,
                    sport_branches(name, fee)
                `)
                .eq('student_id', studentId)
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get payments by student error:', error);
            return { success: false, error: error.message };
        }
    }

    // Activity logs methods
    async createActivityLog(logData) {
        try {
            const { data, error } = await this.supabase
                .from('activity_logs')
                .insert([logData]);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Create activity log error:', error);
            return { success: false, error: error.message };
        }
    }

    async getActivityLogs(limit = 50) {
        try {
            const { data, error } = await this.supabase
                .from('activity_logs')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(limit);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get activity logs error:', error);
            return { success: false, error: error.message };
        }
    }

    // File storage methods
    async uploadFile(bucket, filePath, file) {
        try {
            const { data, error } = await this.supabase.storage
                .from(bucket)
                .upload(filePath, file);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Upload file error:', error);
            return { success: false, error: error.message };
        }
    }

    getFileUrl(bucket, filePath) {
        const { data } = this.supabase.storage
            .from(bucket)
            .getPublicUrl(filePath);
        
        return data.publicUrl;
    }

    async deleteFile(bucket, filePath) {
        try {
            const { data, error } = await this.supabase.storage
                .from(bucket)
                .remove([filePath]);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Delete file error:', error);
            return { success: false, error: error.message };
        }
    }

    // User Profiles methods
    async getUserProfiles() {
        try {
            const { data, error } = await this.supabase
                .from('user_profiles')
                .select('*');
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get user profiles error:', error);
            return { success: false, error: error.message };
        }
    }

    async createAuthUser(email, password) {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            const { data, error } = await this.supabase.auth.signUp({
                email,
                password
            });
            
            if (error) throw error;
            
            return { 
                success: true, 
                user: data.user,
                data: data
            };
        } catch (error) {
            console.error('Create auth user error:', error);
            return { success: false, error: error.message };
        }
    }

    async createUserProfile(profileData) {
        try {
            const { data, error } = await this.supabase
                .from('user_profiles')
                .insert([profileData]);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Create user profile error:', error);
            return { success: false, error: error.message };
        }
    }

    // Payments methods
    async getPayments() {
        try {
            const { data, error } = await this.supabase
                .from('payments')
                .select('*');
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get payments error:', error);
            return { success: false, error: error.message };
        }
    }

    async createPayment(paymentData) {
        try {
            const { data, error } = await this.supabase
                .from('payments')
                .insert([paymentData])
                .select();
            
            if (error) throw error;
            return { success: true, data: data[0] };
        } catch (error) {
            console.error('Create payment error:', error);
            return { success: false, error: error.message };
        }
    }

    // Equipment methods
    async getEquipmentTypes() {
        try {
            // Get equipment types (each row is a size variant: same name, different size)
            const { data: equipmentTypes, error: equipmentError } = await this.supabase
                .from('equipment_types')
                .select('*')
                .order('name');

            if (equipmentError) throw equipmentError;

            // Get assigned counts by equipment_type_id and size
            const { data: assignedRows, error: assignedError } = await this.supabase
                .from('equipment_assignments')
                .select('equipment_type_id, size, quantity, status')
                .eq('status', 'assigned');

            if (assignedError) throw assignedError;

            // Build a map: key `${equipment_type_id}|${size}` -> assigned sum
            const assignedMap = {};
            (assignedRows || []).forEach(row => {
                const key = `${row.equipment_type_id}|${row.size || ''}`;
                const qty = parseInt(row.quantity, 10) || 0;
                assignedMap[key] = (assignedMap[key] || 0) + qty;
            });

            const processedData = (equipmentTypes || []).map(et => {
                const key = `${et.id}|${et.size || ''}`;
                const total = parseInt(et.quantity, 10) || 0;
                const assigned = parseInt(assignedMap[key] || 0, 10) || 0;
                const available = Math.max(0, total - assigned);
                return {
                    ...et,
                    total_quantity: total,
                    assigned_quantity: assigned,
                    available_quantity: available,
                };
            });

            return { success: true, data: processedData };
        } catch (error) {
            console.error('Error fetching equipment types:', error);
            return { success: false, error: error.message };
        }
    }

    async getEquipmentType(id) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_types')
                .select('*')
                .eq('id', id)
                .single();
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Error fetching equipment type:', error);
            return { success: false, error: error.message };
        }
    }

    async createEquipmentAssignment(assignmentData) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_assignments')
                .insert([assignmentData])
                .select();
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Error creating equipment assignment:', error);
            return { success: false, error: error.message };
        }
    }

    async returnEquipment(assignmentId) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_assignments')
                .update({ 
                    status: 'returned',
                    returned_date: new Date().toISOString()
                })
                .eq('id', assignmentId)
                .select();
        
            if (error) throw error;
            // After marking as returned, cancel related unpaid equipment payment if any
            try {
                await this.cancelEquipmentPaymentForAssignment(assignmentId);
            } catch (_) {}
            return { success: true, data };
        } catch (error) {
            console.error('Error returning equipment:', error);
            return { success: false, error: error.message };
        }
    }

    async getEquipmentAssignment(assignmentId) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_assignments')
                .select(`*, equipment_types(name, fee)`) 
                .eq('id', assignmentId)
                .single();
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get equipment assignment error:', error);
            return { success: false, error: error.message };
        }
    }

    async cancelEquipmentPaymentForAssignment(assignmentId) {
        try {
            if (!this.supabase) this.initialize();
            const assRes = await this.getEquipmentAssignment(assignmentId);
            if (!assRes.success || !assRes.data) return { success: false, error: 'Assignment not found' };
            const a = assRes.data;

            // Compute expected amount for matching
            const unitFee = (a.equipment_types && (typeof a.equipment_types.fee === 'number' || a.equipment_types.fee)) 
                ? parseFloat(a.equipment_types.fee) : 0;
            const qty = a.quantity || 1;
            const expectedAmount = parseFloat((unitFee * qty).toFixed(2));

            // First try: direct match by equipment_assignment_id
            let { data: direct, error: directErr } = await this.supabase
                .from('payments')
                .select('id')
                .eq('equipment_assignment_id', assignmentId)
                .eq('is_paid', false)
                .limit(1);
            if (directErr) throw directErr;
            if (direct && direct.length > 0) {
                const { data: del, error: delErr } = await this.supabase
                    .from('payments')
                    .delete()
                    .eq('id', direct[0].id);
                if (delErr) throw delErr;
                return { success: true, data: del };
            }

            // Else: Try to find the most recent unpaid equipment payment for this student matching amount or notes
            let query = this.supabase
                .from('payments')
                .select('id, amount, notes, is_paid, payment_method, created_at')
                .eq('student_id', a.student_id)
                .eq('is_paid', false)
                .eq('payment_method', 'equipment')
                .order('created_at', { ascending: false })
                .limit(5);
            const { data: payments, error } = await query;
            if (error) throw error;

            const match = (payments || []).find(p => {
                // match by amount or by notes containing equipment name
                const byAmount = (typeof p.amount === 'number') && Math.abs(p.amount - expectedAmount) < 0.005;
                const byNotes = (p.notes || '').toLowerCase().includes((a.equipment_types?.name || '').toLowerCase());
                return byAmount || byNotes;
            });

            if (!match) return { success: true, data: null };

            const { data: del, error: delErr } = await this.supabase
                .from('payments')
                .delete()
                .eq('id', match.id);
            if (delErr) throw delErr;
            return { success: true, data: del };
        } catch (error) {
            console.error('Cancel equipment payment error:', error);
            return { success: false, error: error.message };
        }
    }

    // Equipment Assignments methods
    async getEquipmentAssignments() {
        try {
            const { data, error } = await this.supabase
                .from('equipment_assignments')
                .select(`
                    *,
                    equipment_types(name)
                `);
            
            if (error) throw error;
            return { success: true, data: data || [] };
        } catch (error) {
            console.error('Error fetching equipment assignments:', error);
            return { success: false, error: error.message };
        }
    }

    async getStudentEquipmentAssignments(studentId) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_assignments')
                .select(`
                    *,
                    equipment_types(name)
                `)
                .eq('student_id', studentId)
                .order('assigned_date', { ascending: false });
            
            if (error) throw error;
            
            // Add equipment_name field for easier access
            const processedData = data?.map(assignment => ({
                ...assignment,
                equipment_name: assignment.equipment_types?.name || 'Bilinmeyen Ekipman'
            })) || [];
            
            return { success: true, data: processedData };
        } catch (error) {
            console.error('Error fetching student equipment assignments:', error);
            return { success: false, error: error.message };
        }
    }

    async getAllEquipmentAssignments() {
        try {
            const { data, error } = await this.supabase
                .from('equipment_assignments')
                .select(`
                    *,
                    equipment_types(name, photo_url),
                    students(name, surname)
                `)
                .order('assigned_date', { ascending: false });
            
            if (error) throw error;
            
            // Add equipment_name and student_name fields for easier access
            const processedData = data?.map(assignment => ({
                ...assignment,
                equipment_name: assignment.equipment_types?.name || 'Bilinmeyen Ekipman',
                equipment_photo_url: assignment.equipment_types?.photo_url,
                student_name: assignment.students ? `${assignment.students.name} ${assignment.students.surname}` : 'Bilinmeyen Öğrenci'
            })) || [];
            
            return { success: true, data: processedData };
        } catch (error) {
            console.error('Error fetching all equipment assignments:', error);
            return { success: false, error: error.message };
        }
    }

    async createEquipmentAssignment(assignmentData) {
        try {
            const { data, error } = await this.supabase
                .from('equipment_assignments')
                .insert([assignmentData])
                .select();
            
            if (error) throw error;
            return { success: true, data: data[0] };
        } catch (error) {
            console.error('Create equipment assignment error:', error);
            return { success: false, error: error.message };
        }
    }

    // Training and Attendance methods
    async getTraining(trainingId) {
        try {
            const { data, error } = await this.supabase
                .from('trainings')
                .select('*')
                .eq('id', trainingId)
                .single();
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Error fetching training:', error);
            return { success: false, error: error.message };
        }
    }

    async getTrainingAttendance(trainingId) {
        try {
            const { data, error } = await this.supabase
                .from('training_attendance')
                .select('id, student_id, training_id, status, notes')
                .eq('training_id', trainingId);
            
            if (error) throw error;
            return { success: true, data: data || [] };
        } catch (error) {
            console.error('Error fetching training attendance:', error);
            return { success: false, error: error.message };
        }
    }

    async markTrainingAttendance(studentId, trainingId, isPresent) {
        try {
            // First check if attendance record already exists
            const { data: existing, error: checkError } = await this.supabase
                .from('training_attendance')
                .select('id')
                .eq('student_id', studentId)
                .eq('training_id', trainingId)
                .single();

            let result;
            if (existing) {
                // Update existing record - use status field instead of is_present
                const { data, error } = await this.supabase
                    .from('training_attendance')
                    .update({ 
                        status: isPresent ? 'present' : 'absent'
                    })
                    .eq('student_id', studentId)
                    .eq('training_id', trainingId)
                    .select();
                
                if (error) throw error;
                result = data;
            } else {
                // Create new record - use status field instead of is_present
                const { data, error } = await this.supabase
                    .from('training_attendance')
                    .insert([{
                        student_id: studentId,
                        training_id: trainingId,
                        status: isPresent ? 'present' : 'absent'
                    }])
                    .select();
                
                if (error) throw error;
                result = data;
            }
            
            return { success: true, data: result };
        } catch (error) {
            console.error('Error marking training attendance:', error);
            return { success: false, error: error.message };
        }
    }

    async updateTraining(trainingId, trainingData) {
        try {
            const { data, error } = await this.supabase
                .from('trainings')
                .update(trainingData)
                .eq('id', trainingId)
                .select();
            
            if (error) throw error;
            return { success: true, data: data[0] };
        } catch (error) {
            console.error('Error updating training:', error);
            return { success: false, error: error.message };
        }
    }

    async deleteTraining(trainingId) {
        try {
            const { data, error } = await this.supabase
                .from('trainings')
                .delete()
                .eq('id', trainingId)
                .select();
            
            if (error) throw error;
            return { success: true, data: data };
        } catch (error) {
            console.error('Error deleting training:', error);
            return { success: false, error: error.message };
        }
    }

    // Student Enrollments methods
    async getStudentEnrollments() {
        try {
            const { data, error } = await this.supabase
                .from('student_enrollments')
                .select('*');
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get student enrollments error:', error);
            return { success: false, error: error.message };
        }
    }

    async createStudentEnrollment(enrollmentData) {
        try {
            const { data, error } = await this.supabase
                .from('student_enrollments')
                .insert([enrollmentData])
                .select();
            
            if (error) throw error;
            return { success: true, data: data[0] };
        } catch (error) {
            console.error('Create student enrollment error:', error);
            return { success: false, error: error.message };
        }
    }

    // Training Attendance methods
    async getTrainingAttendance() {
        try {
            const { data, error } = await this.supabase
                .from('training_attendance')
                .select('*');
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get training attendance error:', error);
            return { success: false, error: error.message };
        }
    }

    async createTrainingAttendance(attendanceData) {
        try {
            const { data, error } = await this.supabase
                .from('training_attendance')
                .insert([attendanceData])
                .select();
            
            if (error) throw error;
            return { success: true, data: data[0] };
        } catch (error) {
            console.error('Create training attendance error:', error);
            return { success: false, error: error.message };
        }
    }

    // Activity Logs methods
    async getActivityLogs() {
        try {
            const { data, error } = await this.supabase
                .from('activity_logs')
                .select('*');
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get activity logs error:', error);
            return { success: false, error: error.message };
        }
    }

    async createActivityLog(logData) {
        try {
            const { data, error } = await this.supabase
                .from('activity_logs')
                .insert([logData])
                .select();
            
            if (error) throw error;
            return { success: true, data: data[0] };
        } catch (error) {
            console.error('Create activity log error:', error);
            return { success: false, error: error.message };
        }
    }

    // User management methods
    async getUsers() {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            const { data, error } = await this.supabase
                .from('user_profiles')
                .select('*')
                .order('created_at', { ascending: false });
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get users error:', error);
            return { success: false, error: error.message };
        }
    }

    // Get table schema to understand available columns
    async getUserProfilesSchema() {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            // Get first record to see available fields
            const { data, error } = await this.supabase
                .from('user_profiles')
                .select('*')
                .limit(1);
            
            if (error) throw error;
            
            if (data && data.length > 0) {
                const fields = Object.keys(data[0]);
                console.log('Available user_profiles fields:', fields);
                return { success: true, fields };
            }
            
            return { success: true, fields: [] };
        } catch (error) {
            console.error('Get schema error:', error);
            return { success: false, error: error.message };
        }
    }

    async createUser(userData) {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            // Get table schema first to see what fields exist
            const schemaResult = await this.getUserProfilesSchema();
            if (!schemaResult.success || schemaResult.fields.length === 0) {
                throw new Error('Could not get table schema');
            }
            
            // Filter userData to only include fields that exist in the table
            const filteredData = {};
            const existingFields = schemaResult.fields;
            
            // Skip auto-generated fields - let Supabase handle them (including user_id now)
            const skipFields = ['id', 'user_id', 'created_at', 'updated_at'];
            
            for (const [key, value] of Object.entries(userData)) {
                // Skip auto-generated fields - let Supabase handle them
                if (skipFields.includes(key)) {
                    console.log(`Skipping ${key} field - will be auto-generated`);
                    continue;
                }
                
                if (existingFields.includes(key)) {
                    filteredData[key] = value;
                } else {
                    console.warn(`Field '${key}' does not exist in user_profiles table, skipping...`);
                }
            }
            
            console.log('Existing fields:', existingFields);
            console.log('Filtered create data:', filteredData);
            
            const { data, error } = await this.supabase
                .from('user_profiles')
                .insert([filteredData])
                .select();
            
            if (error) throw error;
            return { success: true, data: data[0] };
        } catch (error) {
            console.error('Create user error:', error);
            return { success: false, error: error.message };
        }
    }

    async updateUser(userId, userData) {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            // First get the current user to see what fields exist
            const { data: currentUser, error: getUserError } = await this.supabase
                .from('user_profiles')
                .select('*')
                .eq('id', userId)
                .single();
            
            if (getUserError) throw getUserError;
            
            // Filter userData to only include fields that exist in the table
            const filteredData = {};
            const existingFields = Object.keys(currentUser);
            
            for (const [key, value] of Object.entries(userData)) {
                if (existingFields.includes(key)) {
                    filteredData[key] = value;
                } else {
                    console.warn(`Field '${key}' does not exist in user_profiles table, skipping...`);
                }
            }
            
            console.log('Filtered update data:', filteredData);
            
            const { data, error } = await this.supabase
                .from('user_profiles')
                .update(filteredData)
                .eq('id', userId)
                .select();
            
            if (error) throw error;
            return { success: true, data: data[0] };
        } catch (error) {
            console.error('Update user error:', error);
            return { success: false, error: error.message };
        }
    }

    async deleteUser(userId) {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            const { data, error } = await this.supabase
                .from('user_profiles')
                .delete()
                .eq('id', userId);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Delete user error:', error);
            return { success: false, error: error.message };
        }
    }

    // Activity Logs Methods
    async getActivityLogs() {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            const { data, error } = await this.supabase
                .from('activity_logs')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(100);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Get activity logs error:', error);
            return { success: false, error: error.message };
        }
    }

    async clearActivityLogs() {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            const { data, error } = await this.supabase
                .from('activity_logs')
                .delete()
                .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all records
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Clear activity logs error:', error);
            return { success: false, error: error.message };
        }
    }

    async addActivityLog(action, entityType, entityId, details = null, userInfo = null) {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            // Kullanıcı bilgilerini parametre olarak al, yoksa varsayılan değerler kullan
            let currentUser = 'Sistem';
            let userRole = 'Sistem';

            if (!userInfo) {
                try {
                    // Tercihen app.currentUser üzerinden
                    if (window.app && window.app.currentUser) {
                        userInfo = window.app.currentUser;
                    } else {
                        // Alternatif: localStorage
                        const stored = localStorage.getItem('currentUser');
                        if (stored) {
                            userInfo = JSON.parse(stored);
                        }
                    }
                } catch (_) { /* ignore */ }
            }

            if (userInfo) {
                currentUser = userInfo.full_name || userInfo.username || userInfo.email || 'Bilinmeyen Kullanıcı';
                userRole = userInfo.role || 'Kullanıcı';
            }
            
            // Log detaylarını zenginleştir
            let logDetails = details;
            if (!logDetails) {
                const actionMap = {
                    'create': 'oluşturuldu',
                    'update': 'güncellendi',
                    'delete': 'silindi',
                    'login': 'giriş yaptı',
                    'logout': 'çıkış yaptı',
                    'payment': 'ödemesi yapıldı',
                    'enrollment': 'kaydı yapıldı',
                    'attendance': 'yoklaması alındı'
                };
                
                const entityMap = {
                    'student': 'öğrenci',
                    'user': 'kullanıcı',
                    'training': 'antrenman',
                    'equipment': 'ekipman',
                    'payment': 'ödeme',
                    'enrollment': 'kayıt',
                    'attendance': 'yoklama'
                };
                
                const actionText = actionMap[action] || action;
                const entityText = entityMap[entityType] || entityType || 'kayıt';
                logDetails = `${entityText.charAt(0).toUpperCase() + entityText.slice(1)} ${actionText}`;
            }
            
            const logData = {
                action: action,
                entity_type: entityType,
                entity_id: entityId,
                details: logDetails,
                user_type: currentUser,
                user_role: userRole,
                created_at: new Date().toISOString()
            };
            
            const { data, error } = await this.supabase
                .from('activity_logs')
                .insert([logData]);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Aktivite kaydı eklenirken hata oluştu:', error);
            return { success: false, error: error.message };
        }
    }
    

    // Data Management Methods
    async updateUserPassword(username, hashedPassword) {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            const { data, error } = await this.supabase
                .from('user_profiles')
                .update({ password: hashedPassword })
                .eq('username', username);
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Update user password error:', error);
            return { success: false, error: error.message };
        }
    }

    async getAllFromTable(tableName) {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            const { data, error } = await this.supabase
                .from(tableName)
                .select('*');
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error(`Get all from ${tableName} error:`, error);
            return { success: false, error: error.message };
        }
    }

    async clearTable(tableName) {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            const { data, error } = await this.supabase
                .from(tableName)
                .delete()
                .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all records
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error(`Clear table ${tableName} error:`, error);
            return { success: false, error: error.message };
        }
    }

    async restoreTableData(tableName, data) {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            // First clear the table
            await this.clearTable(tableName);
            
            // Then insert the backup data
            if (data && data.length > 0) {
                const { data: insertData, error } = await this.supabase
                    .from(tableName)
                    .insert(data);
                
                if (error) throw error;
                return { success: true, data: insertData };
            }
            
            return { success: true, data: [] };
        } catch (error) {
            console.error(`Restore table ${tableName} error:`, error);
            return { success: false, error: error.message };
        }
    }
    async getStudentById(studentId) {
        try {
            if (!this.supabase) {
                this.initialize();
            }
            
            const { data, error } = await this.supabase
                .from('students')
                .select('*')
                .eq('id', studentId)
                .single();
            
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Error fetching student by ID:', error);
            return { success: false, error: error.message };
        }
    }
}

    

// Global service instance
const supabaseService = new SupabaseService();

-- Supabase Database Schema
-- Bu SQL komutlarını Supabase SQL Editor'da çalıştırın

-- Note: JWT secret is automatically managed by Supabase, no need to set it manually

-- Create user_profiles table
CREATE TABLE IF NOT EXISTS user_profiles (
    id UUID REFERENCES auth.users(id) PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) NOT NULL,
    username VARCHAR(50) UNIQUE NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    phone VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create students table
CREATE TABLE IF NOT EXISTS students (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tcno VARCHAR(11) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    surname VARCHAR(100) NOT NULL,
    full_name VARCHAR(200) GENERATED ALWAYS AS (name || ' ' || surname) STORED,
    birth_date DATE,
    birth_place VARCHAR(100),
    school VARCHAR(200),
    sport VARCHAR(50),
    age INTEGER,
    height INTEGER,
    weight INTEGER,
    blood_type VARCHAR(5),
    phone VARCHAR(20),
    
    -- Veli bilgileri
    father_tcno VARCHAR(11),
    father_name VARCHAR(100),
    father_job VARCHAR(100),
    father_phone VARCHAR(20),
    mother_tcno VARCHAR(11),
    mother_name VARCHAR(100),
    mother_job VARCHAR(100),
    mother_phone VARCHAR(20),
    address TEXT,
    
    -- Acil durum iletişim
    emergency_relation VARCHAR(50),
    emergency_name VARCHAR(100),
    emergency_phone VARCHAR(20),
    
    -- Ek alanlar
    age_group VARCHAR(50),
    payment_status VARCHAR(20) DEFAULT 'pending',
    
    -- Sistem alanları
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'graduated')),
    registration_date DATE DEFAULT CURRENT_DATE,
    certificate_url TEXT,
    photo_url TEXT,
    notes TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create sport branches table
CREATE TABLE IF NOT EXISTS sport_branches (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    capacity INTEGER NOT NULL,
    age_group VARCHAR(50) NOT NULL,
    fee DECIMAL(10,2) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create equipment types table
CREATE TABLE IF NOT EXISTS equipment_types (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    size VARCHAR(20) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    photo_url TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create equipment assignments table
CREATE TABLE IF NOT EXISTS equipment_assignments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    equipment_type_id UUID REFERENCES equipment_types(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 1,
    assigned_date DATE NOT NULL DEFAULT CURRENT_DATE,
    returned_date DATE,
    status VARCHAR(20) DEFAULT 'assigned' CHECK (status IN ('assigned', 'returned', 'lost', 'damaged')),
    notes TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create trainings table
CREATE TABLE IF NOT EXISTS trainings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    sport VARCHAR(100) NOT NULL,
    age_group VARCHAR(50),
    date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    location VARCHAR(200),
    instructor VARCHAR(100),
    max_participants INTEGER,
    notes TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create training attendance table
CREATE TABLE IF NOT EXISTS training_attendance (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    training_id UUID REFERENCES trainings(id) ON DELETE CASCADE,
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'present' CHECK (status IN ('present', 'absent', 'late', 'excused')),
    notes TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(training_id, student_id)
);

-- Create student enrollments table
CREATE TABLE IF NOT EXISTS student_enrollments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    sport_branch_id UUID REFERENCES sport_branches(id) ON DELETE CASCADE,
    enrollment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'completed', 'dropped')),
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(student_id, sport_branch_id)
);

-- Create payments table
CREATE TABLE IF NOT EXISTS payments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    sport_branch_id UUID REFERENCES sport_branches(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,
    payment_date DATE, -- NULL means not paid yet
    payment_method VARCHAR(50) DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card', 'transfer', 'other')),
    payment_period VARCHAR(20) NOT NULL, -- '2024-01' format for monthly payments
    is_paid BOOLEAN DEFAULT FALSE,
    notes TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create activity logs table
CREATE TABLE IF NOT EXISTS activity_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    action VARCHAR(50) NOT NULL, -- 'create', 'update', 'delete', 'login', 'logout'
    entity_type VARCHAR(50) NOT NULL, -- 'student', 'training', 'equipment', 'payment', etc.
    entity_id VARCHAR(100), -- ID of the affected entity
    description TEXT NOT NULL,
    user_id UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security on all tables
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE sport_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE trainings ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

-- Drop all existing policies first to avoid conflicts
DO $$ 
BEGIN
    -- Drop students policies
    DROP POLICY IF EXISTS "Users can view all students" ON students;
    DROP POLICY IF EXISTS "Users can insert students" ON students;
    DROP POLICY IF EXISTS "Users can update students" ON students;
    DROP POLICY IF EXISTS "Users can delete students" ON students;
    
    -- Drop sport_branches policies
    DROP POLICY IF EXISTS "Users can view all sport branches" ON sport_branches;
    DROP POLICY IF EXISTS "Users can insert sport branches" ON sport_branches;
    DROP POLICY IF EXISTS "Users can update sport branches" ON sport_branches;
    DROP POLICY IF EXISTS "Users can delete sport branches" ON sport_branches;
    
    -- Drop equipment_types policies
    DROP POLICY IF EXISTS "Users can view all equipment types" ON equipment_types;
    DROP POLICY IF EXISTS "Users can insert equipment types" ON equipment_types;
    DROP POLICY IF EXISTS "Users can update equipment types" ON equipment_types;
    DROP POLICY IF EXISTS "Users can delete equipment types" ON equipment_types;
    
    -- Drop equipment_assignments policies
    DROP POLICY IF EXISTS "Users can view all equipment assignments" ON equipment_assignments;
    DROP POLICY IF EXISTS "Users can insert equipment assignments" ON equipment_assignments;
    DROP POLICY IF EXISTS "Users can update equipment assignments" ON equipment_assignments;
    DROP POLICY IF EXISTS "Users can delete equipment assignments" ON equipment_assignments;
    
    -- Drop trainings policies
    DROP POLICY IF EXISTS "Users can view all trainings" ON trainings;
    DROP POLICY IF EXISTS "Users can insert trainings" ON trainings;
    DROP POLICY IF EXISTS "Users can update trainings" ON trainings;
    DROP POLICY IF EXISTS "Users can delete trainings" ON trainings;
    
    -- Drop training_attendance policies
    DROP POLICY IF EXISTS "Users can view all training attendance" ON training_attendance;
    DROP POLICY IF EXISTS "Users can insert training attendance" ON training_attendance;
    DROP POLICY IF EXISTS "Users can update training attendance" ON training_attendance;
    DROP POLICY IF EXISTS "Users can delete training attendance" ON training_attendance;
    
    -- Drop student_enrollments policies
    DROP POLICY IF EXISTS "Users can view all student enrollments" ON student_enrollments;
    DROP POLICY IF EXISTS "Users can insert student enrollments" ON student_enrollments;
    DROP POLICY IF EXISTS "Users can update student enrollments" ON student_enrollments;
    DROP POLICY IF EXISTS "Users can delete student enrollments" ON student_enrollments;
    
    -- Drop payments policies
    DROP POLICY IF EXISTS "Users can view all payments" ON payments;
    DROP POLICY IF EXISTS "Users can insert payments" ON payments;
    DROP POLICY IF EXISTS "Users can update payments" ON payments;
    DROP POLICY IF EXISTS "Users can delete payments" ON payments;
    
    -- Drop activity_logs policies
    DROP POLICY IF EXISTS "Users can view all activity logs" ON activity_logs;
    DROP POLICY IF EXISTS "Users can insert activity logs" ON activity_logs;
EXCEPTION
    WHEN OTHERS THEN NULL; -- Ignore errors if policies don't exist
END $$;

-- Create RLS policies for students table
CREATE POLICY "Users can view all students" ON students FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert students" ON students FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update students" ON students FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete students" ON students FOR DELETE USING (auth.role() = 'authenticated');

-- Create RLS policies for sport_branches table
CREATE POLICY "Users can view all sport branches" ON sport_branches FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert sport branches" ON sport_branches FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update sport branches" ON sport_branches FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete sport branches" ON sport_branches FOR DELETE USING (auth.role() = 'authenticated');

-- Create RLS policies for equipment_types table
CREATE POLICY "Users can view all equipment types" ON equipment_types FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert equipment types" ON equipment_types FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update equipment types" ON equipment_types FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete equipment types" ON equipment_types FOR DELETE USING (auth.role() = 'authenticated');

-- Create RLS policies for equipment_assignments table
CREATE POLICY "Users can view all equipment assignments" ON equipment_assignments FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert equipment assignments" ON equipment_assignments FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update equipment assignments" ON equipment_assignments FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete equipment assignments" ON equipment_assignments FOR DELETE USING (auth.role() = 'authenticated');

-- Create RLS policies for trainings table
CREATE POLICY "Users can view all trainings" ON trainings FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert trainings" ON trainings FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update trainings" ON trainings FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete trainings" ON trainings FOR DELETE USING (auth.role() = 'authenticated');

-- Create RLS policies for training_attendance table
CREATE POLICY "Users can view all training attendance" ON training_attendance FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert training attendance" ON training_attendance FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update training attendance" ON training_attendance FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete training attendance" ON training_attendance FOR DELETE USING (auth.role() = 'authenticated');

-- Create RLS policies for student_enrollments table
CREATE POLICY "Users can view all student enrollments" ON student_enrollments FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert student enrollments" ON student_enrollments FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update student enrollments" ON student_enrollments FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete student enrollments" ON student_enrollments FOR DELETE USING (auth.role() = 'authenticated');

-- Create RLS policies for payments table
CREATE POLICY "Users can view all payments" ON payments FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert payments" ON payments FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update payments" ON payments FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete payments" ON payments FOR DELETE USING (auth.role() = 'authenticated');

-- Create RLS policies for activity_logs table
CREATE POLICY "Users can view all activity logs" ON activity_logs FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert activity logs" ON activity_logs FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Create storage bucket for files (only if it doesn't exist)
INSERT INTO storage.buckets (id, name, public) 
SELECT 'certificates', 'certificates', true
WHERE NOT EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'certificates'
);

-- Create storage policies (drop existing ones first to avoid conflicts)
DROP POLICY IF EXISTS "Users can upload certificates" ON storage.objects;
DROP POLICY IF EXISTS "Users can view certificates" ON storage.objects;
DROP POLICY IF EXISTS "Users can update certificates" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete certificates" ON storage.objects;

CREATE POLICY "Users can upload certificates" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'certificates' AND auth.role() = 'authenticated');
CREATE POLICY "Users can view certificates" ON storage.objects FOR SELECT USING (bucket_id = 'certificates');
CREATE POLICY "Users can update certificates" ON storage.objects FOR UPDATE USING (bucket_id = 'certificates' AND auth.role() = 'authenticated');
CREATE POLICY "Users can delete certificates" ON storage.objects FOR DELETE USING (bucket_id = 'certificates' AND auth.role() = 'authenticated');

-- Create remaining triggers for all tables with updated_at
CREATE TRIGGER update_sport_branches_updated_at BEFORE UPDATE ON sport_branches
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_equipment_types_updated_at BEFORE UPDATE ON equipment_types
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_equipment_assignments_updated_at BEFORE UPDATE ON equipment_assignments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trainings_updated_at BEFORE UPDATE ON trainings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_student_enrollments_updated_at BEFORE UPDATE ON student_enrollments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add more performance indexes
CREATE INDEX IF NOT EXISTS idx_trainings_date ON trainings(date);
CREATE INDEX IF NOT EXISTS idx_trainings_sport ON trainings(sport);
CREATE INDEX IF NOT EXISTS idx_equipment_assignments_student_id ON equipment_assignments(student_id);
CREATE INDEX IF NOT EXISTS idx_equipment_assignments_status ON equipment_assignments(status);
CREATE INDEX IF NOT EXISTS idx_training_attendance_training_id ON training_attendance(training_id);
CREATE INDEX IF NOT EXISTS idx_student_enrollments_student_id ON student_enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_student_enrollments_sport_branch_id ON student_enrollments(sport_branch_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity_type ON activity_logs(entity_type);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at);

-- Drop existing policies first to avoid conflicts
DROP POLICY IF EXISTS "Users can view own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON user_profiles;

-- Create user_profiles policies
CREATE POLICY "Users can view own profile" ON user_profiles
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile" ON user_profiles
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile" ON user_profiles
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Drop existing RLS policies to avoid conflicts
DROP POLICY IF EXISTS "Users can view all students" ON students;
DROP POLICY IF EXISTS "Users can insert students" ON students;
DROP POLICY IF EXISTS "Users can update students" ON students;
DROP POLICY IF EXISTS "Users can delete students" ON students;
DROP POLICY IF EXISTS "Authenticated users can view students" ON students;

DROP POLICY IF EXISTS "Users can view all sport branches" ON sport_branches;
DROP POLICY IF EXISTS "Users can insert sport branches" ON sport_branches;
DROP POLICY IF EXISTS "Users can update sport branches" ON sport_branches;
DROP POLICY IF EXISTS "Users can delete sport branches" ON sport_branches;

DROP POLICY IF EXISTS "Users can view all equipment types" ON equipment_types;
DROP POLICY IF EXISTS "Users can insert equipment types" ON equipment_types;
DROP POLICY IF EXISTS "Users can update equipment types" ON equipment_types;
DROP POLICY IF EXISTS "Users can delete equipment types" ON equipment_types;

DROP POLICY IF EXISTS "Users can view all equipment assignments" ON equipment_assignments;
DROP POLICY IF EXISTS "Users can insert equipment assignments" ON equipment_assignments;
DROP POLICY IF EXISTS "Users can update equipment assignments" ON equipment_assignments;
DROP POLICY IF EXISTS "Users can delete equipment assignments" ON equipment_assignments;

DROP POLICY IF EXISTS "Users can view all trainings" ON trainings;
DROP POLICY IF EXISTS "Users can insert trainings" ON trainings;
DROP POLICY IF EXISTS "Users can update trainings" ON trainings;
DROP POLICY IF EXISTS "Users can delete trainings" ON trainings;

DROP POLICY IF EXISTS "Users can view all training attendance" ON training_attendance;
DROP POLICY IF EXISTS "Users can insert training attendance" ON training_attendance;
DROP POLICY IF EXISTS "Users can update training attendance" ON training_attendance;
DROP POLICY IF EXISTS "Users can delete training attendance" ON training_attendance;

DROP POLICY IF EXISTS "Users can view all student enrollments" ON student_enrollments;
DROP POLICY IF EXISTS "Users can insert student enrollments" ON student_enrollments;
DROP POLICY IF EXISTS "Users can update student enrollments" ON student_enrollments;
DROP POLICY IF EXISTS "Users can delete student enrollments" ON student_enrollments;

DROP POLICY IF EXISTS "Users can view all payments" ON payments;
DROP POLICY IF EXISTS "Users can insert payments" ON payments;
DROP POLICY IF EXISTS "Users can update payments" ON payments;
DROP POLICY IF EXISTS "Users can delete payments" ON payments;

DROP POLICY IF EXISTS "Users can view all activity logs" ON activity_logs;
DROP POLICY IF EXISTS "Users can insert activity logs" ON activity_logs;

-- Recreate all RLS policies
-- Students policies
CREATE POLICY "Users can view all students" ON students FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert students" ON students FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update students" ON students FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete students" ON students FOR DELETE USING (auth.role() = 'authenticated');

-- Sport branches policies
CREATE POLICY "Users can view all sport branches" ON sport_branches FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert sport branches" ON sport_branches FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update sport branches" ON sport_branches FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete sport branches" ON sport_branches FOR DELETE USING (auth.role() = 'authenticated');

-- Equipment types policies
CREATE POLICY "Users can view all equipment types" ON equipment_types FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert equipment types" ON equipment_types FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update equipment types" ON equipment_types FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete equipment types" ON equipment_types FOR DELETE USING (auth.role() = 'authenticated');

-- Equipment assignments policies
CREATE POLICY "Users can view all equipment assignments" ON equipment_assignments FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert equipment assignments" ON equipment_assignments FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update equipment assignments" ON equipment_assignments FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete equipment assignments" ON equipment_assignments FOR DELETE USING (auth.role() = 'authenticated');

-- Trainings policies
CREATE POLICY "Users can view all trainings" ON trainings FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert trainings" ON trainings FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update trainings" ON trainings FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete trainings" ON trainings FOR DELETE USING (auth.role() = 'authenticated');

-- Training attendance policies
CREATE POLICY "Users can view all training attendance" ON training_attendance FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert training attendance" ON training_attendance FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update training attendance" ON training_attendance FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete training attendance" ON training_attendance FOR DELETE USING (auth.role() = 'authenticated');

-- Student enrollments policies
CREATE POLICY "Users can view all student enrollments" ON student_enrollments FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert student enrollments" ON student_enrollments FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update student enrollments" ON student_enrollments FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete student enrollments" ON student_enrollments FOR DELETE USING (auth.role() = 'authenticated');

-- Payments policies
CREATE POLICY "Users can view all payments" ON payments FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert payments" ON payments FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Users can update payments" ON payments FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Users can delete payments" ON payments FOR DELETE USING (auth.role() = 'authenticated');

-- Activity logs policies
CREATE POLICY "Users can view all activity logs" ON activity_logs FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can insert activity logs" ON activity_logs FOR INSERT WITH CHECK (auth.role() = 'authenticated');





-- Create functions for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Drop existing triggers first to avoid conflicts
DROP TRIGGER IF EXISTS update_user_profiles_updated_at ON user_profiles;
DROP TRIGGER IF EXISTS update_students_updated_at ON students;
DROP TRIGGER IF EXISTS update_sport_branches_updated_at ON sport_branches;
DROP TRIGGER IF EXISTS update_equipment_types_updated_at ON equipment_types;
DROP TRIGGER IF EXISTS update_equipment_assignments_updated_at ON equipment_assignments;
DROP TRIGGER IF EXISTS update_trainings_updated_at ON trainings;
DROP TRIGGER IF EXISTS update_student_enrollments_updated_at ON student_enrollments;

-- Create triggers for updated_at
CREATE TRIGGER update_user_profiles_updated_at BEFORE UPDATE ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_students_updated_at BEFORE UPDATE ON students
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_students_tc_no ON students(tc_no);
CREATE INDEX IF NOT EXISTS idx_students_branch ON students(branch);
CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);
CREATE INDEX IF NOT EXISTS idx_payments_student_id ON payments(student_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date);

-- Admin kullanıcısı oluşturma
-- NOT: Bu SQL'i Supabase SQL Editor'da çalıştırın

-- Önce mevcut admin kullanıcısını kontrol et ve sil
DELETE FROM user_profiles WHERE username = 'admin';
DELETE FROM auth.users WHERE email = 'admin@atkoy.com';

-- Admin kullanıcısını oluştur
INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    created_at,
    updated_at,
    confirmation_token,
    email_change,
    email_change_token_new,
    recovery_token
) VALUES (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    'admin@atkoy.com',
    crypt('admin123', gen_salt('bf')),
    NOW(),
    NOW(),
    NOW(),
    '',
    '',
    '',
    ''
);

-- user_profiles tablosuna admin profili ekle
INSERT INTO user_profiles (
    id,
    user_id,
    username,
    full_name,
    role,
    phone
) VALUES (
    (SELECT id FROM auth.users WHERE email = 'admin@atkoy.com'),
    (SELECT id FROM auth.users WHERE email = 'admin@atkoy.com'),
    'admin',
    'Admin User',
    'admin',
    '0000000000'
);

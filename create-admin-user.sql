-- Admin kullanıcısı temizleme ve düzeltme scripti
-- Bu SQL'i Supabase SQL Editor'da çalıştırın

-- Önce user_profiles tablosundan admin kaydını sil
DELETE FROM user_profiles WHERE username = 'admin' OR role = 'admin';

-- Auth.users tablosundan admin kullanıcısını temizle (güvenli yöntem)
DO $$
DECLARE
    admin_user_id uuid;
BEGIN
    -- Admin kullanıcısının ID'sini al
    SELECT id INTO admin_user_id FROM auth.users WHERE email = 'admin@atkoy.com';
    
    IF admin_user_id IS NOT NULL THEN
        -- İlişkili kayıtları temizle
        DELETE FROM user_profiles WHERE user_id = admin_user_id;
        
        -- Auth.users kaydını sil
        DELETE FROM auth.users WHERE id = admin_user_id;
        
        RAISE NOTICE 'Admin kullanıcısı başarıyla silindi: %', admin_user_id;
    ELSE
        RAISE NOTICE 'Admin kullanıcısı bulunamadı';
    END IF;
END $$;

-- Temizlik sonrası kontrol
SELECT 
    'auth.users' as tablo,
    count(*) as kayit_sayisi
FROM auth.users 
WHERE email = 'admin@atkoy.com'
UNION ALL
SELECT 
    'user_profiles' as tablo,
    count(*) as kayit_sayisi
FROM user_profiles 
WHERE username = 'admin';

-- Başarılı oluşturulduğunu kontrol et
SELECT 
    u.email,
    u.created_at,
    p.username,
    p.full_name,
    p.role
FROM auth.users u
LEFT JOIN user_profiles p ON u.id = p.user_id
WHERE u.email = 'admin@atkoy.com';

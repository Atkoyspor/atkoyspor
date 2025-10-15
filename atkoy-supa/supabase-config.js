// === GÜVENLİK: Console Management ===
(function () {
    try {
      // iOS Safari compatibility check
      var isIOSSafari = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
      
      // GÜVENLİK: Production ortamında debug modunu kapat
      var isProduction = window.location.hostname !== 'localhost' && 
                        window.location.hostname !== '127.0.0.1' && 
                        !window.location.hostname.includes('dev');
      
      if (!isIOSSafari) {
        var search = (window.location && window.location.search) ? window.location.search : '';
        var debugParam = /(?:^|[?&])debug=(?:1|true|yes)(?:&|$)/i.test(search);
        var debugLS = false;
        try {
          debugLS = (window.localStorage) ? (localStorage.getItem('DEBUG') === '1' || localStorage.getItem('DEBUG') === 'true') : false;
        } catch (e) { /* localStorage may not be available */ }
        
        // GÜVENLİK: Production'da debug'ı zorla kapat
        var DEBUG = !isProduction && !!(debugParam || debugLS);
        window.DEBUG = DEBUG;
        
        if (!DEBUG && window.console) {
          var noop = function () {};
          console.log = noop;
          console.info = noop;
          console.debug = noop;
          // GÜVENLİK: Production'da warn'leri de kapat
          if (isProduction) {
            console.warn = noop;
          }
          // keep console.error visible so real errors are still seen
        }
      } else {
        // iOS Safari: production'da debug'ı kapat
        window.DEBUG = !isProduction;
      }
    } catch (e) { 
      // Fallback: production'da debug kapalı
      window.DEBUG = !isProduction;
    }
  })();

// Supabase Configuration
// Bu dosyada Supabase bağlantı bilgilerinizi güncelleyin

const SUPABASE_CONFIG = {
    url: 'https://mengumoffebiskmyydxi.supabase.co', // Supabase projenizin URL'si
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lbmd1bW9mZmViaXNrbXl5ZHhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc2MTYzMDcsImV4cCI6MjA3MzE5MjMwN30.hnV0xRDupip7qdzitqvqbJnUn2RW_w_lqM3lPk_6FSY' // Supabase projenizin anonymous key'i
};

// Supabase client'ı başlat
let supabase;

// iOS Safari Compatible Supabase Initialization
function initSupabase() {
    try {
        // Check if Supabase library is loaded
        if (typeof window.supabase === 'undefined') {
            console.error('Supabase library not loaded');
            return false;
        }
        
        if (typeof window.supabase.createClient !== 'function') {
            console.error('Supabase createClient not available');
            return false;
        }
        
        // Use existing client if available to prevent multiple instances
        if (!window.supabaseClient) {
            try {
                supabase = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: false
                    }
                });
                window.supabaseClient = supabase; // Store globally
                console.log('Supabase initialized successfully');
            } catch (initError) {
                console.error('Supabase initialization error:', initError);
                return false;
            }
        } else {
            supabase = window.supabaseClient;
            console.log('Using existing Supabase client');
        }
        return true;
    } catch (error) {
        console.error('Critical Supabase initialization error:', error);
        return false;
    }
}

// Supabase bağlantısını test etme
async function testSupabaseConnection() {
    try {
        const { data, error } = await supabase.from('users').select('count', { count: 'exact' });
        if (error) throw error;
        console.log('Supabase connection test successful');
        return true;
    } catch (error) {
        console.error('Supabase connection test failed:', error);
        return false;
    }
}

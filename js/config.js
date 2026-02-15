console.log('🚀 LiberBit World - Iniciando...');

// Supabase Configuration
const SUPABASE_URL = 'https://wyrwoxizjlamxdiuxaxd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_yOijPJfoSWOoXAagMb9pvQ_XjdfP4EY';

// Initialize Supabase client
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('✅ Supabase client initialized');

// Function to count and display active nodes
async function updateActiveNodesCounter() {
    try {
        let userCount = 0;
        
        const { data, error } = await supabaseClient
            .from('users')
            .select('id');
        
        if (error) {
            // Silent fallback - no noisy console warnings
            const savedKeys = localStorage.getItem('liberbit_keys');
            if (savedKeys) userCount = 1;
        } else if (data) {
            userCount = data.length;
        } else {
            userCount = 1;
        }
        
        const counter = document.getElementById('activeNodesCount');
        if (counter) {
            const currentValue = parseInt(counter.textContent) || 0;
            animateCounter(counter, currentValue, userCount, 1500);
        }
    } catch (err) {
        // Silent fallback for DataCloneError and similar
        const counter = document.getElementById('activeNodesCount');
        if (counter && counter.textContent === '0') {
            counter.textContent = '1';
        }
    }
}

// Function to animate counter
function animateCounter(element, start, end, duration) {
    const range = end - start;
    const increment = range / (duration / 16); // 60 FPS
    let current = start;
    
    const timer = setInterval(() => {
        current += increment;
        if ((increment > 0 && current >= end) || (increment < 0 && current <= end)) {
            current = end;
            clearInterval(timer);
        }
        element.textContent = Math.round(current);
    }, 16);
}

const IDENTITIES_BASE_OFFSET = 35;

async function updateIdentitiesCounter() {
    try {
        const { data, error } = await supabaseClient
            .from('users')
            .select('id');
        
        let realCount = 0;
        if (!error && data) {
            realCount = data.length;
        } else {
            const savedKeys = localStorage.getItem('liberbit_keys');
            if (savedKeys) realCount = 1;
        }
        
        const displayCount = realCount + IDENTITIES_BASE_OFFSET;
        
        const counter = document.getElementById('identitiesCount');
        if (counter) {
            const currentValue = parseInt(counter.textContent) || 0;
            animateCounter(counter, currentValue, displayCount, 1500);
        }
    } catch (err) {
        const counter = document.getElementById('identitiesCount');
        if (counter && counter.textContent === '0') {
            counter.textContent = IDENTITIES_BASE_OFFSET;
        }
    }
}

// Load hero background image
const heroImageData = 'HERO_IMAGE_PLACEHOLDER';

// Set background when page loads
window.addEventListener('DOMContentLoaded', () => {
    const heroBackground = document.getElementById('heroBackground');
    if (heroBackground) {
        // For now, use a gradient background
        // The uploaded image will need to be hosted or embedded
        heroBackground.style.background = `
            linear-gradient(135deg, rgba(44, 95, 111, 0.8) 0%, rgba(13, 23, 30, 0.9) 100%),
            url('data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"%3E%3Crect fill="%232C5F6F" width="1200" height="800"/%3E%3C/svg%3E')
        `;
        heroBackground.style.backgroundSize = 'cover';
        heroBackground.style.backgroundPosition = 'center';
    }
});


let currentUser = null;
let allPosts = [];
let allOffers = [];
let currentFilter = 'todos';
let currentOfferImage = null;
let editingOfferId = null;
let allDirectMessages = [];
let currentChatWith = null;
let allProposals = [];
let allVotes = [];
let currentProposalFilter = 'all';
let activeNodesInterval = null;
let userProfile = null;

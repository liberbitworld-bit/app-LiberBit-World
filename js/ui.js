function showMainMenu() {
    showSection('mainMenuSection');
    document.getElementById('userBadge').classList.remove('hidden');
    document.getElementById('userName').textContent = currentUser.name;
    
    // Update home welcome card
    document.getElementById('homeUserName').textContent = currentUser.name;
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    if (pubKey && isNpubFormat(pubKey)) {
        document.getElementById('homeNpub').textContent = pubKey.substring(0, 20) + '...' + pubKey.substring(pubKey.length - 6);
    } else if (pubKey) {
        document.getElementById('homeNpub').textContent = pubKey.substring(0, 16) + '...';
    }
    
    // Load home avatar from cache or Supabase
    updateHomeAvatar();
    
    // Show and update active nodes counter
    document.getElementById('activeNodesCounterHeader').classList.remove('hidden');
    document.getElementById('identitiesCounterHeader').classList.remove('hidden');
    document.getElementById('relaysCounterHeader').classList.remove('hidden');
    document.getElementById('citiesCounterHeader').classList.remove('hidden');
    document.getElementById('activeCitiesCounterHeader').classList.remove('hidden');
    updateActiveNodesCounter();
    updateIdentitiesCounter();
    // Start interval to update counter every 30 seconds
    if (activeNodesInterval) clearInterval(activeNodesInterval);
    activeNodesInterval = setInterval(() => {
        updateActiveNodesCounter();
        updateIdentitiesCounter();
    }, 30000);
    initializeUserProfile();
    updateAllBadges(); // Update notification badges
    loadAllNotifications(); // Load notification center
}

const DEFAULT_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Crect fill='%232C5F6F' width='60' height='60' rx='30'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='28' fill='%23E5B95C'%3E👤%3C/text%3E%3C/svg%3E";

async function updateHomeAvatar() {
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    const homeAvatarEl = document.getElementById('homeAvatar');
    if (!homeAvatarEl) return;
    
    // Reset to default first
    homeAvatarEl.src = DEFAULT_AVATAR;
    
    // Try localStorage cache
    const cached = localStorage.getItem('userProfile_' + pubKey);
    if (cached) {
        try {
            const profile = JSON.parse(cached);
            if (profile.avatarUrl) {
                homeAvatarEl.src = profile.avatarUrl;
                return;
            }
        } catch (e) {}
    }
    
    // Try Supabase
    try {
        const { data } = await supabaseClient
            .from('users')
            .select('avatar_url')
            .eq('public_key', pubKey)
            .maybeSingle();
        
        if (data && data.avatar_url) {
            homeAvatarEl.src = data.avatar_url;
        }
    } catch (err) {}
}

async function updateAllBadges() {
    try {
        await updateChatBadge();
        await updateNetworkingBadge();
        await updateGobernanzaBadge();
    } catch (err) {
        console.error('Error updating badges:', err);
    }
}

async function updateChatBadge() {
    try {
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        
        // Get last visit timestamp
        const lastVisit = parseInt(localStorage.getItem('lastVisit_chat') || '0');
        
        // Count posts created after last visit
        const { data, error } = await supabaseClient
            .from('posts')
            .select('id, created_at')
            .gte('created_at', new Date(lastVisit).toISOString())
            .neq('author_public_key', pubKey); // Exclude own posts
        
        if (!error && data) {
            const unreadCount = data.length;
            updateBadge('chat', unreadCount);
        }
    } catch (err) {
        console.error('Error updating chat badge:', err);
    }
}

async function updateNetworkingBadge() {
    try {
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        
        // Get last visit timestamp
        const lastVisit = parseInt(localStorage.getItem('lastVisit_networking') || '0');
        
        // Count offers created after last visit
        const { data, error } = await supabaseClient
            .from('offers')
            .select('id, created_at')
            .gte('created_at', new Date(lastVisit).toISOString())
            .neq('author_public_key', pubKey); // Exclude own offers
        
        if (!error && data) {
            const unreadCount = data.length;
            updateBadge('networking', unreadCount);
        }
    } catch (err) {
        console.error('Error updating networking badge:', err);
    }
}

async function updateGobernanzaBadge() {
    try {
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        
        // Get last visit timestamp
        const lastVisit = parseInt(localStorage.getItem('lastVisit_gobernanza') || '0');
        
        // Count new proposals and contributions
        const proposals = JSON.parse(localStorage.getItem('liberbit_proposals') || '[]');
        const contributions = JSON.parse(localStorage.getItem('liberbit_contributions') || '[]');
        
        const newProposals = proposals.filter(p => 
            new Date(p.createdAt).getTime() > lastVisit && 
            p.createdBy !== pubKey
        ).length;
        
        const newContributions = contributions.filter(c => 
            new Date(c.submitted_at).getTime() > lastVisit &&
            c.applicant_public_key !== pubKey &&
            c.status === 'approved'
        ).length;
        
        const unreadCount = newProposals + newContributions;
        updateBadge('gobernanza', unreadCount);
    } catch (err) {
        console.error('Error updating gobernanza badge:', err);
    }
}

function updateBadge(appName, count) {
    const badge = document.getElementById('badge-' + appName);
    if (!badge) return;
    
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function markAsRead(appName) {
    // Save current timestamp as last visit
    localStorage.setItem('lastVisit_' + appName, Date.now().toString());
    // Clear badge
    updateBadge(appName, 0);
}

async function openApp(appName) {
    if (appName === 'chat') {
        showSection('chatSection');
        switchChatTab('community');
        markAsRead('chat');
        // Refresh badges every 15 seconds while in chat
        if (window.chatBadgeInterval) clearInterval(window.chatBadgeInterval);
        window.chatBadgeInterval = setInterval(updateChatBadges, 15000);
    } else if (appName === 'networking') {
        showSection('networkingSection');
        // Use Nostr marketplace (not legacy Supabase loadOffers)
        if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.refreshMarketplace) {
            LBW_NostrBridge.refreshMarketplace();
        }
        markAsRead('networking');
    } else if (appName === 'directMessages') {
        showSection('chatSection');
        switchChatTab('private');
        markAsRead('chat');
    } else if (appName === 'gobernanza') {
        showSection('gobernanzaSection'); // Shows the menu with 2 options
        markAsRead('gobernanza');
    } else if (appName === 'perfil') {
        showSection('profileSection');
        // Load fresh data first, then update profile with accurate stats
        await loadPosts();
        loadProposals();
        await loadUserProfile();
    } else if (appName === 'citiesInDev') {
        showSection('citiesInDevSection');
    } else if (appName === 'infraestructura') {
        showSection('infraestructuraSection');
        const nodesCount = document.getElementById('activeNodesCount');
        const infraNodes = document.getElementById('infraNodesCount');
        if (nodesCount && infraNodes) infraNodes.textContent = nodesCount.textContent;
    } else if (appName === 'aportacionEconomica') {
        showSection('aportacionEconomicaSection');
        setTimeout(generateLnQR, 100);
    } else {
        showSection(appName + 'Section');
    }
}

function openSubApp(subAppName) {
    if (subAppName === 'gobernanza-proposals') {
        showSection('gobernanzaProposalsSection');
        loadProposals();
    } else if (subAppName === 'merits') {
        showSection('meritsSection');
        loadMeritsData();
        loadMyContributions();
    }
}

function backToGobernanzaMenu() {
    showSection('gobernanzaSection');
}

function backToMenu() {
    showSection('mainMenuSection');
    if (window.chatBadgeInterval) clearInterval(window.chatBadgeInterval);
    updateAllBadges(); // Refresh badges when returning to menu
}

function showSection(sectionId) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById(sectionId).classList.add('active');
    window.scrollTo(0, 0);
}

function showRegisterForm() {
    document.getElementById('authModal').classList.remove('hidden');
    document.getElementById('registerForm').classList.remove('hidden');
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('keysDisplay').classList.add('hidden');
}

function showLoginForm() {
    document.getElementById('authModal').classList.remove('hidden');
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('registerForm').classList.add('hidden');
    document.getElementById('keysDisplay').classList.add('hidden');
}

function closeAuthModal() {
    document.getElementById('authModal').classList.add('hidden');
}

// Reply state

// Backup: Register all back buttons via event listeners
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.back-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            backToMenu();
        });
    });
});

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
    // Pioneer dashboard moved to Merits → Ranking Pioneros tab
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

// ═══════════════════════════════════════════════════════════════
// Pioneer Dashboard — Primeros Pobladores IberAtlas
// Muestra stats del usuario, peso en gobernanza, ranking top 20.
// Llamado desde showMainMenu() cada vez que se vuelve al dashboard.
// ═══════════════════════════════════════════════════════════════
function updatePioneerDashboard() {
    const panel = document.getElementById('pioneerDashboard');
    if (!panel) return;

    // Merits section already requires login — no need to check here
    panel.style.display = 'block';

    // ── 1. User merits ───────────────────────────────────────
    let myTotal = 0, myLevel = '—', myRank = 0;
    if (typeof getUnifiedMerits === 'function') {
        const m = getUnifiedMerits();
        myTotal = m.total || 0;
        if (typeof LBW_Merits !== 'undefined') {
            const lvl = LBW_Merits.getCitizenshipLevel(myTotal);
            myLevel = (lvl.emoji || '') + ' ' + (lvl.name || '—');
        }
    }

    const elMyMerits = document.getElementById('pdMyMerits');
    const elMyLevel  = document.getElementById('pdMyLevel');
    if (elMyMerits) elMyMerits.textContent = myTotal.toLocaleString();
    if (elMyLevel)  elMyLevel.textContent  = myLevel;

    // ── 2. Leaderboard & rank ────────────────────────────────
    let leaderboard = [];
    let totalMeritsEco = 0;
    if (typeof LBW_Merits !== 'undefined') {
        leaderboard = LBW_Merits.getLeaderboard(200) || [];
        totalMeritsEco = leaderboard.reduce((s, e) => s + e.total, 0);
    }

    // Merge activity merits into leaderboard for fair ranking
    // (leaderboard only has kind-31002 merits; we add activity cap for current user)
    const myPubkey = LBW_Nostr.getPubkey();
    const lbWithActivity = leaderboard.map(e => {
        if (e.pubkey === myPubkey && typeof getUnifiedMerits === 'function') {
            return { ...e, displayTotal: getUnifiedMerits().total };
        }
        return { ...e, displayTotal: e.total };
    }).sort((a, b) => b.displayTotal - a.displayTotal);

    // My rank in full list
    const myRankIdx = lbWithActivity.findIndex(e => e.pubkey === myPubkey);
    myRank = myRankIdx >= 0 ? myRankIdx + 1 : lbWithActivity.length + 1;

    const elMyRank = document.getElementById('pdMyRank');
    const elRankStatus = document.getElementById('pdRankStatus');
    if (elMyRank) elMyRank.textContent = myRank > 0 ? '#' + myRank : '—';

    const inTop20 = myRank > 0 && myRank <= 20;
    const pioneerStatus = document.getElementById('pdPioneerStatus');

    if (elRankStatus) {
        if (inTop20) {
            elRankStatus.textContent = '🏠 En top 20';
            elRankStatus.style.color = '#52c41a';
        } else if (myRank > 0 && myRank <= 50) {
            elRankStatus.textContent = `A ${myRank - 20} posiciones`;
            elRankStatus.style.color = '#FFB74D';
        } else {
            elRankStatus.textContent = 'Sigue aportando';
            elRankStatus.style.color = 'var(--color-text-secondary)';
        }
    }

    // Pioneer banner status
    if (pioneerStatus) {
        if (inTop20) {
            pioneerStatus.textContent = '🏠 Eres Pionero #' + myRank;
            pioneerStatus.style.background = 'rgba(82,196,26,0.15)';
            pioneerStatus.style.color = '#52c41a';
            pioneerStatus.style.borderColor = 'rgba(82,196,26,0.4)';
        } else {
            pioneerStatus.textContent = 'Posición #' + myRank;
            pioneerStatus.style.background = 'rgba(229,185,92,0.1)';
            pioneerStatus.style.color = 'var(--color-gold)';
            pioneerStatus.style.borderColor = 'rgba(229,185,92,0.3)';
        }
    }

    // Progress bar toward top 20 cutoff
    const progressWrap = document.getElementById('pdProgressWrap');
    if (progressWrap && lbWithActivity.length >= 20) {
        const cutoffEntry = lbWithActivity[19]; // #20 position
        const cutoffMerits = cutoffEntry ? cutoffEntry.displayTotal : 0;
        if (!inTop20 && cutoffMerits > 0) {
            progressWrap.style.display = 'block';
            const pct = Math.min(100, Math.round((myTotal / cutoffMerits) * 100));
            const fill = document.getElementById('pdProgressFill');
            const pctEl = document.getElementById('pdProgressPct');
            const labelEl = document.getElementById('pdProgressLabel');
            if (fill) fill.style.width = pct + '%';
            if (pctEl) pctEl.textContent = pct + '%';
            if (labelEl) labelEl.textContent = `Faltan ${(cutoffMerits - myTotal).toLocaleString()} mérits para top 20`;
        } else {
            progressWrap.style.display = 'none';
        }
    } else if (progressWrap) {
        progressWrap.style.display = 'none';
    }

    // ── 3. Voting power ──────────────────────────────────────
    let votingPct = '0%', votingBloc = '—';
    if (typeof LBW_Merits !== 'undefined') {
        const vp = LBW_Merits.getUserVotingPower(myPubkey);
        if (vp) {
            votingPct = vp.power > 0 ? (vp.power * 100).toFixed(2) + '%' : '< 0.01%';
            votingBloc = 'Bloque ' + (vp.bloc || 'Comunidad');
        }
    }
    const elVP = document.getElementById('pdVotingPower');
    const elBloc = document.getElementById('pdVotingBloc');
    if (elVP) elVP.textContent = votingPct;
    if (elBloc) elBloc.textContent = votingBloc;

    // ── 4. Ecosystem totals ──────────────────────────────────
    const elTotal = document.getElementById('pdTotalMerits');
    const elPartic = document.getElementById('pdTotalParticipants');
    if (elTotal) elTotal.textContent = totalMeritsEco.toLocaleString();
    if (elPartic) elPartic.textContent = lbWithActivity.length + ' participantes';

    // ── 5. Top 20 leaderboard rows ───────────────────────────
    const lbContainer = document.getElementById('pdLeaderboard');
    if (!lbContainer) return;

    const top = lbWithActivity.slice(0, 20);

    if (top.length === 0) {
        lbContainer.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--color-text-secondary);font-size:0.8rem;">Aún no hay datos en el relay</div>';
        return;
    }

    const rows = top.map((entry, i) => {
        const pos = i + 1;
        const isMe = entry.pubkey === myPubkey;
        const lvl = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getCitizenshipLevel(entry.displayTotal) : { emoji: '👋', name: '' };
        const npubShort = entry.npub ? entry.npub.substring(0, 10) + '…' : entry.pubkey.substring(0, 10) + '…';
        const medalEmoji = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : `<span style="font-family:var(--font-mono);font-size:0.75rem;color:var(--color-text-secondary);">#${pos}</span>`;
        const rowBg = isMe ? 'rgba(229,185,92,0.1)' : 'transparent';
        const border = isMe ? 'border-left: 3px solid var(--color-gold);' : 'border-left: 3px solid transparent;';

        return `<div style="display:flex;align-items:center;gap:0.6rem;padding:0.55rem 1rem;background:${rowBg};${border}transition:background 0.2s;">
            <div style="width:28px;text-align:center;flex-shrink:0;">${medalEmoji}</div>
            <div style="font-size:1rem;flex-shrink:0;">${lvl.emoji || '👋'}</div>
            <div style="flex:1;min-width:0;">
                <div style="font-size:0.75rem;color:${isMe ? 'var(--color-gold)' : 'var(--color-text-primary)'};font-weight:${isMe ? '700' : '400'};font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                    ${isMe ? 'Tú · ' : ''}${npubShort}
                </div>
                <div style="font-size:0.65rem;color:var(--color-text-secondary);">${lvl.name || ''}</div>
            </div>
            <div style="font-family:var(--font-mono);font-size:0.85rem;font-weight:700;color:var(--color-gold);flex-shrink:0;">${entry.displayTotal.toLocaleString()}</div>
            <div style="font-size:0.65rem;color:var(--color-text-secondary);flex-shrink:0;">LBWM</div>
        </div>`;
    }).join('');

    // If user is not in top 20, add separator + their row
    let myRowExtra = '';
    if (!inTop20 && myRank > 0) {
        const myEntry = lbWithActivity[myRankIdx];
        const myLvl = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getCitizenshipLevel(myTotal) : { emoji: '👋', name: '' };
        const myNpub = myEntry?.npub ? myEntry.npub.substring(0, 10) + '…' : myPubkey.substring(0, 10) + '…';
        myRowExtra = `
            <div style="padding:0.3rem 1rem;background:rgba(229,185,92,0.05);border-top:1px dashed rgba(229,185,92,0.2);text-align:center;font-size:0.65rem;color:var(--color-text-secondary);">· · · tu posición · · ·</div>
            <div style="display:flex;align-items:center;gap:0.6rem;padding:0.55rem 1rem;background:rgba(229,185,92,0.08);border-left:3px solid var(--color-gold);">
                <div style="width:28px;text-align:center;flex-shrink:0;font-family:var(--font-mono);font-size:0.75rem;color:var(--color-text-secondary);">#${myRank}</div>
                <div style="font-size:1rem;flex-shrink:0;">${myLvl.emoji || '👋'}</div>
                <div style="flex:1;min-width:0;">
                    <div style="font-size:0.75rem;color:var(--color-gold);font-weight:700;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Tú · ${myNpub}</div>
                    <div style="font-size:0.65rem;color:var(--color-text-secondary);">${myLvl.name || ''}</div>
                </div>
                <div style="font-family:var(--font-mono);font-size:0.85rem;font-weight:700;color:var(--color-gold);flex-shrink:0;">${myTotal.toLocaleString()}</div>
                <div style="font-size:0.65rem;color:var(--color-text-secondary);flex-shrink:0;">LBWM</div>
            </div>`;
    }

    lbContainer.innerHTML = rows + myRowExtra;
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
        if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.refreshMarketplace) {
            LBW_NostrBridge.refreshMarketplace();
        }
        // Inject mission cards into networking grid
        if (typeof LBW_Missions !== 'undefined') {
            LBW_Missions.onNetworkingOpen();
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
        await Promise.all([
            loadPosts(),
            loadOffers()
        ]);
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

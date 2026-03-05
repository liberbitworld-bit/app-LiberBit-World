// ========== NOTIFICATION CENTER FUNCTIONS ==========

let allNotifications = [];
let currentNotificationFilter = 'all';

function openNotificationCenter() {
    document.getElementById('notificationModal').classList.add('active');
    loadAllNotifications();
}

function closeNotificationCenter() {
    document.getElementById('notificationModal').classList.remove('active');
}

async function loadAllNotifications() {
    allNotifications = [];
    const dismissed = getDismissedNotifications();
    const lastVisitDM = parseInt(localStorage.getItem('lastVisit_dm') || '0');
    const lastVisitGov = parseInt(localStorage.getItem('lastVisit_governance') || '0');

    try {
        // ── 1. Mensajes directos no leidos (via LBW_NostrBridge) ─────────────
        if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.getConversations) {
            const conversations = LBW_NostrBridge.getConversations();
            for (const conv of conversations) {
                if (!conv.lastMessage || !conv.lastMessage.created_at) continue;
                const msgTime = conv.lastMessage.created_at * 1000;
                if (msgTime > lastVisitDM) {
                    const senderId = conv.pubkey;
                    let senderName = senderId.substring(0, 12) + '...';
                    if (LBW_NostrBridge._resolveProfileData) {
                        try {
                            const profile = await LBW_NostrBridge._resolveProfileData(senderId);
                            if (profile && profile.name) senderName = profile.name;
                        } catch(e) {}
                    }
                    const notifId = 'msg_' + senderId + '_' + msgTime;
                    if (!dismissed.has(notifId)) {
                        allNotifications.push({
                            id: notifId,
                            type: 'messages',
                            title: 'Mensaje de ' + senderName,
                            content: (conv.lastMessage.content || '(mensaje cifrado)').substring(0, 100),
                            timestamp: msgTime,
                            unread: true,
                            action: () => {
                                closeNotificationCenter();
                                if (LBW_NostrBridge.openDMConversation) LBW_NostrBridge.openDMConversation(senderId);
                            }
                        });
                    }
                }
            }
        }

        // ── 2. Propuestas de gobernanza nuevas (via LBW_Governance) ──────────
        if (typeof LBW_Governance !== 'undefined' && LBW_Governance.getAllProposals) {
            const proposals = LBW_Governance.getAllProposals();
            const myPubkey = (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.isLoggedIn())
                ? LBW_Nostr.getPubkey() : null;

            proposals
                .filter(p => p.status === 'active' || p.status === 'open')
                .forEach(prop => {
                    const propTime = (prop.created_at || 0) * 1000;
                    if (propTime > lastVisitGov && prop.pubkey !== myPubkey) {
                        const notifId = 'gov_' + (prop.id || prop.dTag);
                        if (!dismissed.has(notifId)) {
                            allNotifications.push({
                                id: notifId,
                                type: 'governance',
                                title: 'Nueva propuesta: ' + (prop.title || 'Sin titulo'),
                                content: (prop.description || '').substring(0, 100) + '...',
                                timestamp: propTime,
                                unread: true,
                                action: () => {
                                    closeNotificationCenter();
                                    openApp('gobernanza');
                                }
                            });
                        }
                    }
                });
        }

        // ── 3. Meritos recibidos (via LBW_Merits) ───────────────────────────
        if (typeof LBW_Merits !== 'undefined' && LBW_Merits.getMyMerits) {
            const myData = LBW_Merits.getMyMerits();
            const lastMeritCheck = parseInt(localStorage.getItem('lastMeritCheck') || '0');
            if (myData && myData.recentAwards) {
                myData.recentAwards
                    .filter(a => (a.timestamp * 1000) > lastMeritCheck)
                    .forEach(award => {
                        const notifId = 'merit_' + award.id;
                        if (!dismissed.has(notifId)) {
                            allNotifications.push({
                                id: notifId,
                                type: 'merits',
                                title: '+' + award.amount + ' meritos recibidos',
                                content: award.reason || ('Categoria: ' + award.category),
                                timestamp: award.timestamp * 1000,
                                unread: true,
                                action: () => {
                                    closeNotificationCenter();
                                    openSubApp('merits');
                                }
                            });
                        }
                    });
            }
        }

        // ── 4. Notificaciones de meritos desde localStorage (legado) ─────────
        const meritNotifs = JSON.parse(localStorage.getItem('merit_notifications') || '[]');
        meritNotifs.forEach(notif => {
            if (!notif.read && !dismissed.has('merit_' + notif.id)) {
                allNotifications.push({
                    id: 'merit_' + notif.id,
                    type: 'merits',
                    title: notif.title,
                    content: notif.content,
                    timestamp: notif.timestamp,
                    unread: true,
                    action: () => {
                        closeNotificationCenter();
                        openSubApp('merits');
                    }
                });
            }
        });

        // Sort newest first
        allNotifications.sort((a, b) => b.timestamp - a.timestamp);

        updateNotificationBadges();
        displayNotifications();

    } catch (err) {
        console.error('Error loading notifications:', err);
        updateNotificationBadges();
        displayNotifications();
    }
}

function updateNotificationBadges() {
    const messageCount = allNotifications.filter(n => n.type === 'messages').length;
    const governanceCount = allNotifications.filter(n => n.type === 'governance').length;
    const meritsCount = allNotifications.filter(n => n.type === 'merits').length;
    const totalCount = allNotifications.length;

    // Update inbox summary
    document.getElementById('notifCountMessages').textContent = messageCount;
    document.getElementById('notifCountGovernance').textContent = governanceCount;
    document.getElementById('notifCountMerits').textContent = meritsCount;

    // Update bell badge
    const bellBadge = document.getElementById('totalNotificationsBadge');
    if (totalCount > 0) {
        bellBadge.textContent = totalCount;
        bellBadge.classList.remove('hidden');
    } else {
        bellBadge.classList.add('hidden');
    }

    // Update modal tabs
    document.getElementById('tabBadgeAll').textContent = totalCount;
    document.getElementById('tabBadgeMessages').textContent = messageCount;
    document.getElementById('tabBadgeGovernance').textContent = governanceCount;
    document.getElementById('tabBadgeMerits').textContent = meritsCount;
}

function filterNotifications(filter) {
    currentNotificationFilter = filter;
    
    // Update active tab
    document.querySelectorAll('.notification-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelector(`[data-filter="${filter}"]`).classList.add('active');
    
    displayNotifications();
}

function displayNotifications() {
    const container = document.getElementById('notificationList');
    
    let filteredNotifications = allNotifications;
    if (currentNotificationFilter !== 'all') {
        filteredNotifications = allNotifications.filter(n => n.type === currentNotificationFilter);
    }

    if (filteredNotifications.length === 0) {
        container.innerHTML = `
            <div class="notification-empty">
                <div class="notification-empty-icon">📭</div>
                <h3>No hay notificaciones</h3>
                <p>Cuando recibas mensajes o propuestas aparecerán aquí</p>
            </div>
        `;
        return;
    }

    container.innerHTML = filteredNotifications.map((notif, index) => {
        const icon = notif.type === 'messages' ? '💬' : 
                    notif.type === 'governance' ? '🏛️' : '🏅';
        
        return `
            <div class="notification-item ${notif.unread ? 'unread' : ''}" onclick="handleNotificationClick(${index})">
                <div class="notification-item-header">
                    <div class="notification-item-title">${icon} ${escapeHtml(notif.title)}</div>
                    <div class="notification-item-time">${timeAgo(notif.timestamp)}</div>
                </div>
                <div class="notification-item-content">${escapeHtml(notif.content)}</div>
                <div class="notification-item-footer">
                    <button class="notification-item-action primary" onclick="event.stopPropagation(); handleNotificationAction(${index})">
                        Ver
                    </button>
                    <button class="notification-item-action secondary" onclick="event.stopPropagation(); dismissNotification(${index})">
                        Descartar
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function handleNotificationClick(index) {
    const notif = getFilteredNotifications()[index];
    if (notif) {
        const dismissed = JSON.parse(localStorage.getItem('dismissed_notifications') || '[]');
        dismissed.push(String(notif.id));
        if (dismissed.length > 500) dismissed.splice(0, dismissed.length - 500);
        localStorage.setItem('dismissed_notifications', JSON.stringify(dismissed));
        allNotifications = allNotifications.filter(n => n !== notif);
        updateNotificationBadges();
        
        if (notif.action) notif.action();
    }
}

function handleNotificationAction(index) {
    const notif = getFilteredNotifications()[index];
    if (notif) {
        // Dismiss it so it doesn't reappear
        const dismissed = JSON.parse(localStorage.getItem('dismissed_notifications') || '[]');
        dismissed.push(String(notif.id));
        if (dismissed.length > 500) dismissed.splice(0, dismissed.length - 500);
        localStorage.setItem('dismissed_notifications', JSON.stringify(dismissed));
        allNotifications = allNotifications.filter(n => n !== notif);
        updateNotificationBadges();
        
        if (notif.action) notif.action();
    }
}

function dismissNotification(index) {
    const notif = getFilteredNotifications()[index];
    if (notif) {
        // Save to dismissed list in localStorage
        const dismissed = JSON.parse(localStorage.getItem('dismissed_notifications') || '[]');
        dismissed.push(String(notif.id));
        // Keep only last 500 to avoid bloat
        if (dismissed.length > 500) dismissed.splice(0, dismissed.length - 500);
        localStorage.setItem('dismissed_notifications', JSON.stringify(dismissed));
        
        allNotifications = allNotifications.filter(n => n !== notif);
        updateNotificationBadges();
        displayNotifications();
    }
}

function getDismissedNotifications() {
    return new Set(JSON.parse(localStorage.getItem('dismissed_notifications') || '[]'));
}

function getFilteredNotifications() {
    if (currentNotificationFilter !== 'all') {
        return allNotifications.filter(n => n.type === currentNotificationFilter);
    }
    return allNotifications;
}

// Update notification center when returning to main menu
const originalBackToMenu = backToMenu;
backToMenu = function() {
    originalBackToMenu();
    loadAllNotifications();
};

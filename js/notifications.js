// ========== NOTIFICATION CENTER FUNCTIONS ==========

let allNotifications = [];
let currentNotificationFilter = 'all';

function openNotificationCenter() {
    document.getElementById('notificationModal').classList.add('active');
    localStorage.setItem('lastZapCheck', Date.now().toString());
    localStorage.setItem('lastReplyCheck', Date.now().toString());
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
                                    // Navigate directly to proposals list, not the intermediate submenu
                                    setTimeout(() => openSubApp('gobernanza-proposals'), 50);
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

        // ── 4. Reseñas recibidas en el marketplace (kind:1985, NIP-85) ──────
        if (typeof LBW_Reviews !== 'undefined' && LBW_Reviews.getReviewsForUser) {
            const myPubkeyForReviews = (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.isLoggedIn())
                ? LBW_Nostr.getPubkey() : null;
            const lastVisitMarket = parseInt(localStorage.getItem('lastVisit_marketplace') || '0');

            if (myPubkeyForReviews) {
                try {
                    const reviews = await LBW_Reviews.getReviewsForUser(myPubkeyForReviews);
                    reviews
                        .filter(r => (r.created_at * 1000) > lastVisitMarket)
                        .forEach(review => {
                            const notifId = 'review_' + review.id;
                            if (!dismissed.has(notifId)) {
                                const rating = parseInt(review.rating) || 0;
                                const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
                                const comment = (review.comment || review.content || '').substring(0, 100);
                                allNotifications.push({
                                    id: notifId,
                                    type: 'marketplace',
                                    title: `Nueva reseña recibida ${stars}`,
                                    content: comment || 'Sin comentario',
                                    timestamp: review.created_at * 1000,
                                    unread: true,
                                    action: () => {
                                        closeNotificationCenter();
                                        setTimeout(() => openSubApp('marketplace'), 50);
                                    }
                                });
                            }
                        });
                } catch (e) {
                    console.warn('[Notifications] Error cargando reseñas:', e);
                }
            }
        }

        // ── 5. Zaps recibidos (kind:7 con ⚡ dirigidos al usuario) ────────────
        if (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.isLoggedIn() && LBW_Nostr.subscribeToReactions) {
            const lastZapCheck = parseInt(localStorage.getItem('lastZapCheck') || '0');
            await new Promise(resolve => {
                const collected = [];
                const sub = LBW_Nostr.subscribeToReactions(reaction => {
                    if (reaction.content === '⚡' && (reaction.created_at * 1000) > lastZapCheck) {
                        collected.push(reaction);
                    }
                });
                // Esperar EOSE o timeout de 2s
                setTimeout(async () => {
                    if (sub && LBW_Nostr.unsubscribe) LBW_Nostr.unsubscribe(sub);
                    for (const zap of collected) {
                        const notifId = 'zap_' + zap.id;
                        if (dismissed.has(notifId)) continue;
                        let senderName = zap.pubkey.substring(0, 8) + '...';
                        if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge._resolveProfileData) {
                            try {
                                const p = await LBW_NostrBridge._resolveProfileData(zap.pubkey);
                                if (p && p.name) senderName = p.name;
                            } catch(e) {}
                        }
                        allNotifications.push({
                            id: notifId,
                            type: 'zaps',
                            title: '⚡ ' + senderName + ' te hizo un zap',
                            content: 'Reaccionó a uno de tus mensajes en el chat comunitario',
                            timestamp: zap.created_at * 1000,
                            unread: true,
                            action: () => {
                                closeNotificationCenter();
                                showSection('chatSection');
                            }
                        });
                    }
                    resolve();
                }, 2000);
            });
        }

        // ── 6. Respuestas a mis mensajes del chat comunitario ────────────────
        if (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.isLoggedIn()) {
            const myPubkeyForReplies = LBW_Nostr.getPubkey();
            const lastReplyCheck = parseInt(localStorage.getItem('lastReplyCheck') || '0');
            await new Promise(resolve => {
                const collected = [];
                const sub = LBW_Nostr.subscribe(
                    { kinds: [1], '#p': [myPubkeyForReplies], '#t': ['liberbit'], limit: 50 },
                    event => {
                        // Solo replies (tienen tag 'e'), no menciones sueltas
                        const hasReplyTag = event.tags.some(t => t[0] === 'e');
                        if (!hasReplyTag) return;
                        // No notificar mis propias respuestas
                        if (event.pubkey === myPubkeyForReplies) return;
                        if ((event.created_at * 1000) > lastReplyCheck) {
                            collected.push(event);
                        }
                    }
                );
                setTimeout(async () => {
                    if (sub && LBW_Nostr.unsubscribe) LBW_Nostr.unsubscribe(sub);
                    for (const event of collected) {
                        const notifId = 'reply_' + event.id;
                        if (dismissed.has(notifId)) continue;
                        let senderName = event.pubkey.substring(0, 8) + '...';
                        if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge._resolveProfileData) {
                            try {
                                const p = await LBW_NostrBridge._resolveProfileData(event.pubkey);
                                if (p && p.name) senderName = p.name;
                            } catch(e) {}
                        }
                        const preview = (event.content || '').substring(0, 80);
                        allNotifications.push({
                            id: notifId,
                            type: 'replies',
                            title: '↩️ ' + senderName + ' respondió a tu mensaje',
                            content: preview + (event.content.length > 80 ? '…' : ''),
                            timestamp: event.created_at * 1000,
                            unread: true,
                            action: () => {
                                closeNotificationCenter();
                                showSection('chatSection');
                                if (typeof switchChatTab === 'function') switchChatTab('community');
                            }
                        });
                    }
                    resolve();
                }, 2000);
            });
        }

        // ── 7. Notificaciones de meritos desde localStorage (legado) ─────────
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
    const messageCount    = allNotifications.filter(n => n.type === 'messages').length;
    const governanceCount = allNotifications.filter(n => n.type === 'governance').length;
    const meritsCount     = allNotifications.filter(n => n.type === 'merits').length;
    const marketplaceCount = allNotifications.filter(n => n.type === 'marketplace').length;
    const zapsCount       = allNotifications.filter(n => n.type === 'zaps').length;
    const totalCount      = allNotifications.length;

    // Update inbox summary
    document.getElementById('notifCountMessages').textContent = messageCount;
    document.getElementById('notifCountGovernance').textContent = governanceCount;
    document.getElementById('notifCountMerits').textContent = meritsCount;
    const notifCountMarket = document.getElementById('notifCountMarketplace');
    if (notifCountMarket) notifCountMarket.textContent = marketplaceCount;

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
    const tabBadgeMarket = document.getElementById('tabBadgeMarketplace');
    if (tabBadgeMarket) tabBadgeMarket.textContent = marketplaceCount;
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

    // Use notif.id (not positional index) so buttons work regardless of filter state
    container.innerHTML = filteredNotifications.map(notif => {
        const icon = notif.type === 'messages' ? '💬' :
                     notif.type === 'governance' ? '🏛️' :
                     notif.type === 'marketplace' ? '🏪' :
                     notif.type === 'zaps' ? '⚡' :
                     notif.type === 'replies' ? '↩️' : '🏅';
        const safeId = CSS.escape(String(notif.id));
        return `
            <div class="notification-item ${notif.unread ? 'unread' : ''}" data-notif-id="${escapeHtml(String(notif.id))}" onclick="handleNotificationById('${safeId}')">
                <div class="notification-item-header">
                    <div class="notification-item-title">${icon} ${escapeHtml(notif.title)}</div>
                    <div class="notification-item-time">${timeAgo(notif.timestamp)}</div>
                </div>
                <div class="notification-item-content">${escapeHtml(notif.content)}</div>
                <div class="notification-item-footer">
                    <button class="notification-item-action primary" onclick="event.stopPropagation(); handleNotificationById('${safeId}', true)">
                        Ver
                    </button>
                    <button class="notification-item-action secondary" onclick="event.stopPropagation(); dismissNotificationById('${safeId}')">
                        Descartar
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// ── Helpers: look up notification by id (robust, filter-independent) ──

function _findNotifById(escapedId) {
    // CSS.escape may add backslashes; we need the raw id
    // We store raw ids in data-notif-id and pass CSS.escape for the onclick attr,
    // so we unescape by querying the DOM or just search allNotifications by stringified id
    return allNotifications.find(n => CSS.escape(String(n.id)) === escapedId);
}

function _dismissById(escapedId) {
    const notif = _findNotifById(escapedId);
    if (!notif) return null;
    const dismissed = JSON.parse(localStorage.getItem('dismissed_notifications') || '[]');
    dismissed.push(String(notif.id));
    if (dismissed.length > 500) dismissed.splice(0, dismissed.length - 500);
    localStorage.setItem('dismissed_notifications', JSON.stringify(dismissed));
    allNotifications = allNotifications.filter(n => n !== notif);
    return notif;
}

function handleNotificationById(escapedId, triggerAction = false) {
    const notif = _dismissById(escapedId);
    if (!notif) return;
    updateNotificationBadges();
    if (notif.action) notif.action();
}

function dismissNotificationById(escapedId) {
    _dismissById(escapedId);
    updateNotificationBadges();
    displayNotifications();
}

// ── Legacy index-based handlers (kept for backward compat) ──
function handleNotificationClick(index) {
    const notif = getFilteredNotifications()[index];
    if (notif) handleNotificationById(CSS.escape(String(notif.id)));
}
function handleNotificationAction(index) {
    const notif = getFilteredNotifications()[index];
    if (notif) handleNotificationById(CSS.escape(String(notif.id)), true);
}
function dismissNotification(index) {
    const notif = getFilteredNotifications()[index];
    if (notif) dismissNotificationById(CSS.escape(String(notif.id)));
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

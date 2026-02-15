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
    const pubKey = currentUser.pubkey || currentUser.publicKey;

    try {
        // 1. Load unread messages (usando recipient_id y sender_id)
        const { data: messages, error: msgError } = await supabaseClient
            .from('direct_messages')
            .select('*')
            .eq('recipient_id', pubKey)
            .order('created_at', { ascending: false })
            .limit(50);

        if (messages) {
            const lastVisitDM = parseInt(localStorage.getItem('lastVisit_dm') || '0');
            messages.forEach(msg => {
                const msgTime = new Date(msg.created_at).getTime();
                if (msgTime > lastVisitDM) {
                    allNotifications.push({
                        id: 'msg_' + msg.id,
                        type: 'messages',
                        title: `Mensaje de ${msg.sender_name || 'Usuario'}`,
                        content: msg.content,
                        timestamp: msgTime,
                        unread: true,
                        action: () => {
                            closeNotificationCenter();
                            startDirectMessage(msg.sender_id, msg.sender_name);
                        }
                    });
                }
            });
        }

        // 2. Load new governance proposals
        const { data: proposals, error: propError } = await supabaseClient
            .from('proposals')
            .select('*')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(20);

        if (proposals) {
            const lastVisitGov = parseInt(localStorage.getItem('lastVisit_governance') || '0');
            proposals.forEach(prop => {
                const propTime = new Date(prop.created_at).getTime();
                if (propTime > lastVisitGov) {
                    allNotifications.push({
                        id: 'gov_' + prop.id,
                        type: 'governance',
                        title: `Nueva propuesta: ${prop.title}`,
                        content: prop.description.substring(0, 100) + '...',
                        timestamp: propTime,
                        unread: true,
                        action: () => {
                            closeNotificationCenter();
                            openApp('gobernanza');
                        }
                    });
                }
            });
        }

        // 3. Load merit notifications (placeholder - adapt to your merit system)
        // This is a placeholder - you'll need to implement based on your merit tracking
        const meritNotifs = JSON.parse(localStorage.getItem('merit_notifications') || '[]');
        meritNotifs.forEach(notif => {
            if (!notif.read) {
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

        // Sort by timestamp
        allNotifications.sort((a, b) => b.timestamp - a.timestamp);
        
        // Filter out previously dismissed notifications
        const dismissed = getDismissedNotifications();
        allNotifications = allNotifications.filter(n => !dismissed.has(String(n.id)));

        updateNotificationBadges();
        displayNotifications();

    } catch (err) {
        console.error('Error loading notifications:', err);
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


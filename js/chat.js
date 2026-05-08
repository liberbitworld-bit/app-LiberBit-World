// ========== DIRECT MESSAGES FUNCTIONS ==========

function startDirectMessage(recipientId, recipientName) {
    if (!currentUser) {
        showNotification('Debes iniciar sesión primero', 'error');
        return;
    }
    if (recipientId === currentUser.publicKey) {
        showNotification('No puedes enviarte mensajes a ti mismo', 'error');
        return;
    }

    currentChatWith = {
        id: recipientId,
        name: recipientName
    };

    showSection('chatSection');
    openPrivateChat(recipientId, recipientName);
}

function openChatWith(userId, userName) {
    currentChatWith = { id: userId, name: userName };

    const convList = document.getElementById('conversationsList');
    const activeChat = document.getElementById('activeChat');
    const chatWithName = document.getElementById('chatWithName');
    const chatWithId = document.getElementById('chatWithId');

    if (convList) convList.style.display = 'none';
    if (activeChat) activeChat.style.display = 'block';
    if (chatWithName) chatWithName.textContent = userName;
    if (chatWithId) chatWithId.textContent = userId.substring(0, 16) + '...';

    // [SEC-C1] Antes llamábamos a loadDirectMessages() (Supabase plaintext).
    // El flujo Nostr E2E lo gestiona LBW_NostrBridge.openDMConversation.
    if (window.LBW_NostrBridge && typeof LBW_NostrBridge.openDMConversation === 'function') {
        try { LBW_NostrBridge.openDMConversation(userId); } catch (e) { console.warn('[chat] openDMConversation:', e); }
    }
}

function closeActiveChat() {
    currentChatWith = null;
    const convList = document.getElementById('conversationsList');
    const activeChat = document.getElementById('activeChat');
    const dmContent = document.getElementById('dmContent');

    if (convList) convList.style.display = 'block';
    if (activeChat) activeChat.style.display = 'none';
    if (dmContent) dmContent.value = '';
    // [SEC-C1] Antes llamábamos a loadConversationsList() (Supabase plaintext).
    // La lista de conversaciones Nostr la mantiene LBW_NostrBridge vía
    // _updateDMSidebar / loadChatSidebar — no necesita refresh manual aquí.
}

// Chat tab state
let currentChatTab = 'community';
let lastSeenCommunity = parseInt(localStorage.getItem('lastSeen_community') || '0');
let lastSeenPrivate = parseInt(localStorage.getItem('lastSeen_private') || '0');

function switchChatTab(tab) {
    currentChatTab = tab;
    
    // Mark as seen - clear badge for this tab
    if (tab === 'community') {
        lastSeenCommunity = Date.now();
        localStorage.setItem('lastSeen_community', lastSeenCommunity.toString());
        updateChatTabBadge('community', 0);
    } else if (tab === 'private') {
        lastSeenPrivate = Date.now();
        localStorage.setItem('lastSeen_private', lastSeenPrivate.toString());
        updateChatTabBadge('private', 0);
    } else if (tab === 'debates') {
        updateChatTabBadge('debates', 0);
    }
    
    // Update tab buttons (sidebar)
    document.getElementById('tabCommunity').classList.toggle('active', tab === 'community');
    document.getElementById('tabDebates').classList.toggle('active', tab === 'debates');
    document.getElementById('tabPrivate').classList.toggle('active', tab === 'private');

    // Update tab strip (chat-main)
    const mtc = document.getElementById('mainTabCommunity');
    const mtd = document.getElementById('mainTabDebates');
    const mtp = document.getElementById('mainTabPrivate');
    if (mtc) mtc.classList.toggle('active', tab === 'community');
    if (mtd) mtd.classList.toggle('active', tab === 'debates');
    if (mtp) mtp.classList.toggle('active', tab === 'private');

    // Update main view
    document.getElementById('communityView').style.display = tab === 'community' ? 'flex' : 'none';
    document.getElementById('debatesView').style.display  = tab === 'debates'   ? 'flex' : 'none';
    document.getElementById('privateView').style.display  = tab === 'private'   ? 'flex' : 'none';
    
    // Load sidebar content (maneja internamente los 3 casos: community/debates/private)
    loadChatSidebar();

    // Update the OTHER tabs' badges
    updateChatBadges();

    // En móvil: Comunidad → ocultar sidebar | Debates/Privados → mostrar sidebar para elegir
    if (window.innerWidth <= 768) {
        const sidebar = document.getElementById('chatSidebar');
        const chatMain = document.getElementById('chatMain');
        if (tab === 'community') {
            sidebar.classList.add('sidebar-hidden');
            chatMain.classList.remove('main-hidden');
        } else {
            sidebar.classList.remove('sidebar-hidden');
            chatMain.classList.remove('main-hidden');
        }
    }
}

// ── Volver al sidebar en móvil ──────────────────────────────
function showChatSidebar() {
    document.getElementById('chatSidebar').classList.remove('sidebar-hidden');
    document.getElementById('chatMain').classList.add('main-hidden');
}

function updateChatTabBadge(tab, count) {
    const badgeId = tab === 'community' ? 'badgeCommunity'
                  : tab === 'debates'   ? 'badgeDebates'
                  :                      'badgePrivate';
    const badge = document.getElementById(badgeId);
    if (!badge) return;
    if (count > 0) {
        badge.style.display = 'flex';
        badge.textContent = count > 99 ? '99+' : count;
    } else {
        badge.style.display = 'none';
    }
}

async function updateChatBadges() {
    if (!currentUser) return;
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    
    try {
        // Community badge: new posts since last seen (sigue usando Supabase para posts públicos)
        if (currentChatTab !== 'community') {
            const { data: newPosts } = await supabaseClient
                .from('posts')
                .select('id')
                .gt('created_at', new Date(lastSeenCommunity).toISOString())
                .neq('author_public_key', pubKey);
            
            if (newPosts) updateChatTabBadge('community', newPosts.length);
        }
        
        // Private badge: usar conteo de Nostr (DMs cifrados)
        if (currentChatTab !== 'private') {
            // El badge de privados lo maneja LBW_NostrBridge._updateDMBadge()
            // Solo actualizar si tenemos acceso al conteo
            if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.getUnreadDMCount) {
                const unreadCount = LBW_NostrBridge.getUnreadDMCount();
                updateChatTabBadge('private', unreadCount);
            }
        }
    } catch (err) {
        console.error('Error updating chat badges:', err);
    }
}

// Lock contra race condition: si llegan varios DMs/sidebars seguidos,
// las llamadas async simultáneas a appendPrivateConversationsToSidebar
// (que await _resolveProfileData entre += al innerHTML) provocan que las
// conversaciones aparezcan dos veces. Serializamos las ejecuciones; si
// llega otra llamada mientras una está en curso, la marcamos pendiente
// y se re-ejecuta una sola vez al terminar.
//
// [hotfix dm-sidebar] Antes el lock era binario y si _doLoadChatSidebar
// quedaba colgado (p.ej. porque _resolveProfileData hacía await sobre
// fetchUserProfile sin timeout), _loadChatSidebarRunning quedaba en true
// para siempre y la sidebar nunca volvía a refrescarse — síntoma:
// conversaciones existen en _dmConversations pero la sidebar muestra 0.
// Añadido timestamp para liberar el lock automáticamente tras 10s.
let _loadChatSidebarRunning = false;
let _loadChatSidebarStartedAt = 0;
let _loadChatSidebarPending = false;
const LOAD_SIDEBAR_LOCK_TIMEOUT_MS = 10000;

async function loadChatSidebar() {
    if (_loadChatSidebarRunning) {
        // Liberación de seguridad: si la ejecución previa lleva más del timeout,
        // asumimos que se quedó colgada (await sin EOSE) y forzamos reset.
        if (Date.now() - _loadChatSidebarStartedAt > LOAD_SIDEBAR_LOCK_TIMEOUT_MS) {
            console.warn('[Chat] loadChatSidebar lock expirado tras ' + LOAD_SIDEBAR_LOCK_TIMEOUT_MS + 'ms — liberando');
            _loadChatSidebarRunning = false;
        } else {
            _loadChatSidebarPending = true;
            return;
        }
    }
    _loadChatSidebarRunning = true;
    _loadChatSidebarStartedAt = Date.now();
    try {
        await _doLoadChatSidebar();
    } finally {
        _loadChatSidebarRunning = false;
        if (_loadChatSidebarPending) {
            _loadChatSidebarPending = false;
            loadChatSidebar();
        }
    }
}

async function _doLoadChatSidebar() {
    const container = document.getElementById('chatSidebarList');
    if (!container) return;

    if (currentChatTab === 'community') {
        // Show online users / community info
        container.innerHTML = `
            <div class="sidebar-community-btn active" onclick="switchChatTab('community')">
                <div class="sidebar-conv-avatar" style="background: rgba(229, 185, 92, 0.2);">🌐</div>
                <div class="sidebar-conv-info">
                    <div class="sidebar-conv-name">Chat General</div>
                    <div class="sidebar-conv-preview">Todos los miembros</div>
                </div>
            </div>
        `;
        // Load private conversations below
        await appendPrivateConversationsToSidebar(container);
    } else if (currentChatTab === 'debates') {
        await loadDebatesSidebar();
    } else {
        await loadPrivateConversationsSidebar();
    }
}

async function appendPrivateConversationsToSidebar(container) {
    // === UNIFICADO: Usar conversaciones de Nostr (cifrado E2E) ===
    
    // Verificar si LBW_NostrBridge tiene conversaciones
    if (typeof LBW_NostrBridge === 'undefined' || !LBW_NostrBridge.getConversations) {
        console.log('[Chat] Sidebar manejado por LBW_NostrBridge');
        return;
    }
    
    try {
        const conversations = LBW_NostrBridge.getConversations();
        
        if (!conversations || conversations.length === 0) {
            return;
        }
        
        container.innerHTML += `<div style="padding: 0.5rem 0.75rem; font-size: 0.7rem; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 0.5rem;">🔐 Conversaciones Cifradas</div>`;
        
        for (const conv of conversations) {
            // Resolve profile with photo asynchronously
            let name = conv.name, picture = null;
            if (LBW_NostrBridge._resolveProfileData) {
                try {
                    const p = await LBW_NostrBridge._resolveProfileData(conv.pubkey);
                    name = p.name; picture = p.picture;
                } catch(e) {}
            } else if (!name && LBW_NostrBridge._resolveName) {
                try { name = await LBW_NostrBridge._resolveName(conv.pubkey); } catch(e) {}
            }
            name = name || 'Usuario';
            const avatarHtml = (LBW_NostrBridge._avatarHtml)
                ? LBW_NostrBridge._avatarHtml('sidebar-conv-avatar', name, picture)
                : `<div class="sidebar-conv-avatar">${(name.replace(/[^\p{L}\p{N}]/gu,'')[0]||'👤').toUpperCase()}</div>`;
            const isActive = currentChatWith && currentChatWith.id === conv.pubkey;
            const preview = conv.lastMessage ? conv.lastMessage.substring(0, 30) : 'Mensaje cifrado';
            const timeStr = conv.timestamp ? timeAgo(conv.timestamp * 1000) : '';
            
            container.innerHTML += `
                <div class="sidebar-conversation ${isActive ? 'active' : ''}" data-lbw-action="openPrivateChat" data-pubkey="${escapeHtml(conv.pubkey)}" data-name="${escapeHtml(name)}">
                    ${avatarHtml}
                    <div class="sidebar-conv-info">
                        <div class="sidebar-conv-name">${escapeHtml(name)}</div>
                        <div class="sidebar-conv-preview">🔒 ${escapeHtml(preview)}${preview.length >= 30 ? '...' : ''}</div>
                    </div>
                    <div class="sidebar-conv-time">${timeStr}</div>
                </div>
            `;
        }
    } catch (err) {
        console.error('[Chat] Error loading Nostr conversations:', err);
    }
}

async function loadPrivateConversationsSidebar() {
    const container = document.getElementById('chatSidebarList');
    if (!container) return;
    container.innerHTML = '';
    await appendPrivateConversationsToSidebar(container);
    
    if (container.innerHTML.trim() === '') {
        container.innerHTML = `
            <div style="padding: 2rem 1rem; text-align: center; color: var(--color-text-secondary);">
                <div style="font-size: 2rem; margin-bottom: 0.5rem;">🔐</div>
                <div style="font-size: 0.85rem;">Mensajes Cifrados E2E</div>
                <div style="font-size: 0.75rem; margin-top: 0.5rem; line-height: 1.4;">
                    Busca usuarios con 🔍 arriba<br>
                    o contacta desde Networking
                </div>
                <div style="font-size: 0.65rem; margin-top: 0.75rem; padding: 0.4rem; background: rgba(76,175,80,0.1); border-radius: 6px; color: var(--color-teal-light);">
                    ✓ NIP-44 cifrado extremo a extremo
                </div>
            </div>
        `;
    }
}

function openPrivateChat(userId, userName) {
    // === UNIFICADO: Usar sistema Nostr cifrado (E2E) ===
    
    // Normalizar: si es npub, convertir a hex para Nostr
    let hexPubkey = userId;
    if (userId.startsWith('npub1')) {
        try {
            if (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.npubToHex) {
                hexPubkey = LBW_Nostr.npubToHex(userId);
            }
        } catch (e) {
            console.error('Error convirtiendo npub:', e);
            showNotification('ID de usuario inválido', 'error');
            return;
        }
    }
    
    // Guardar referencia para compatibilidad
    currentChatWith = { id: hexPubkey, name: userName };
    
    // Switch to private tab
    if (currentChatTab !== 'private') {
        switchChatTab('private');
    }
    
    // Usar sistema Nostr unificado (mensajes cifrados E2E)
    if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.openDMConversation) {
        // Sistema Nostr disponible - usar cifrado E2E
        LBW_NostrBridge.openDMConversation(hexPubkey);
        
        // Actualizar nombre en la UI si se proporcionó
        if (userName) {
            const nameEl = document.getElementById('privateChatName');
            if (nameEl) {
                nameEl.textContent = userName;
                nameEl.dataset.pubkey = hexPubkey;
            }
        }
        
        console.log('[Chat] 🔐 Abriendo DM cifrado con:', hexPubkey.substring(0, 12) + '...');
    } else {
        // Fallback: mostrar mensaje de que Nostr no está disponible
        console.warn('[Chat] LBW_NostrBridge no disponible, usando fallback');
        
        document.getElementById('privatePlaceholder').style.display = 'none';
        document.getElementById('privateActiveChat').style.display = 'flex';
        document.getElementById('privateChatName').textContent = userName;
        document.getElementById('privateChatId').textContent = hexPubkey.substring(0, 16) + '...';
        
        const container = document.getElementById('privateChatMessages');
        if (container) {
            container.innerHTML = `
                <div class="chat-empty-state">
                    <div class="emoji">🔒</div>
                    <p>Sistema de mensajes cifrados</p>
                    <p style="font-size: 0.8rem; color: var(--color-text-secondary);">
                        Conecta con Nostr para enviar mensajes cifrados E2E
                    </p>
                </div>
            `;
        }
    }
}

async function loadPrivateChatMessages(userId) {
    // === DEPRECADO: Los mensajes ahora se cargan via Nostr (cifrado E2E) ===
    console.warn('[Chat] ⚠️ loadPrivateChatMessages está deprecado. Usando sistema Nostr cifrado.');
    
    // Redirigir al sistema Nostr si está disponible
    if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.openDMConversation) {
        // Normalizar userId a hex si es npub
        let hexPubkey = userId;
        if (userId.startsWith('npub1') && typeof LBW_Nostr !== 'undefined') {
            try {
                hexPubkey = LBW_Nostr.npubToHex(userId);
            } catch (e) {
                console.error('Error convirtiendo npub:', e);
            }
        }
        LBW_NostrBridge.openDMConversation(hexPubkey);
        return;
    }
    
    // Fallback: mostrar mensaje informativo
    const container = document.getElementById('privateChatMessages');
    if (container) {
        container.innerHTML = `
            <div class="chat-empty-state">
                <div class="emoji">🔐</div>
                <p>Mensajes Cifrados E2E</p>
                <p style="font-size: 0.8rem; color: var(--color-text-secondary); margin-top: 0.5rem;">
                    Los mensajes privados ahora usan cifrado end-to-end via Nostr (NIP-44).<br>
                    Asegúrate de estar conectado a los relays.
                </p>
            </div>
        `;
    }
}

// ========== CHAT USER SEARCH ==========
let chatSearchTimeout = null;

function handleChatUserSearch(query) {
    clearTimeout(chatSearchTimeout);
    const resultsContainer = document.getElementById('chatSearchResults');
    
    if (!query || query.trim().length < 2) {
        resultsContainer.style.display = 'none';
        resultsContainer.innerHTML = '';
        return;
    }
    
    chatSearchTimeout = setTimeout(() => searchChatUsers(query.trim()), 300);
}

async function searchChatUsers(query) {
    const resultsContainer = document.getElementById('chatSearchResults');
    if (!currentUser) {
        if (resultsContainer) {
            resultsContainer.style.display = 'block';
            resultsContainer.innerHTML = '<div style="padding: 0.75rem; text-align: center; color: var(--color-text-secondary); font-size: 0.8rem;">Inicia sesión para buscar</div>';
        }
        return;
    }
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    
    resultsContainer.style.display = 'block';
    resultsContainer.innerHTML = '<div style="padding: 0.75rem; text-align: center; color: var(--color-text-secondary); font-size: 0.8rem;">Buscando...</div>';
    
    try {
        let users = [];
        
        // Search by name (ilike for case-insensitive)
        const { data: nameResults } = await supabaseClient
            .from('users')
            .select('public_key, name, avatar_url')
            .ilike('name', `%${query}%`)
            .neq('public_key', pubKey)
            .limit(10);
        
        if (nameResults) users = [...nameResults];
        
        // Also search by public_key if query looks like a key
        if (query.length >= 6) {
            const { data: keyResults } = await supabaseClient
                .from('users')
                .select('public_key, name, avatar_url')
                .ilike('public_key', `%${query}%`)
                .neq('public_key', pubKey)
                .limit(5);
            
            if (keyResults) {
                // Deduplicate
                const existingKeys = new Set(users.map(u => u.public_key));
                keyResults.forEach(u => {
                    if (!existingKeys.has(u.public_key)) users.push(u);
                });
            }
        }
        
        if (users.length === 0) {
            resultsContainer.innerHTML = '<div style="padding: 0.75rem; text-align: center; color: var(--color-text-secondary); font-size: 0.8rem;">No se encontraron usuarios</div>';
            return;
        }
        
        resultsContainer.innerHTML = users.map(user => {
            const initial = (user.name || '?').charAt(0).toUpperCase();
            const truncatedKey = user.public_key.substring(0, 12) + '...';
            const safeAvatarUrl = (user.avatar_url && /^https?:\/\//i.test(user.avatar_url)) ? user.avatar_url : '';
            const avatarHtml = safeAvatarUrl 
                ? `<img src="${escapeHtml(safeAvatarUrl)}" style="width:32px; height:32px; border-radius:50%; object-fit:cover; flex-shrink:0;">`
                : `<div style="width:32px; height:32px; border-radius:50%; background:var(--color-teal-dark); display:flex; align-items:center; justify-content:center; color:var(--color-gold); font-weight:700; font-size:0.9rem; flex-shrink:0;">${initial}</div>`;
            
            return `
                <div data-lbw-action="startChatFromSearch" data-pubkey="${escapeHtml(user.public_key)}" data-name="${escapeHtml(user.name || 'Usuario')}" style="display:flex; align-items:center; gap:0.6rem; padding:0.6rem; border-radius:8px; cursor:pointer; transition: background 0.2s;" onmouseover="this.style.background='rgba(229,185,92,0.1)'" onmouseout="this.style.background='none'">
                    ${avatarHtml}
                    <div style="flex:1; min-width:0;">
                        <div style="font-size:0.85rem; font-weight:600; color:var(--color-text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(user.name || 'Usuario')}</div>
                        <div style="font-size:0.65rem; color:var(--color-text-secondary); font-family:var(--font-mono);">${truncatedKey}</div>
                    </div>
                    <div style="font-size:0.7rem; color:var(--color-gold);">💬</div>
                </div>
            `;
        }).join('');
        
    } catch (err) {
        console.error('Error searching users:', err);
        resultsContainer.innerHTML = '<div style="padding: 0.75rem; text-align: center; color: var(--color-text-secondary); font-size: 0.8rem;">Error al buscar</div>';
    }
}

function startChatFromSearch(userId, userName) {
    // Clear search
    clearChatSearch();
    // Open private chat
    openPrivateChat(userId, userName);
}

function clearChatSearch() {
    const input = document.getElementById('chatUserSearch');
    if (input) input.value = '';
    const results = document.getElementById('chatSearchResults');
    if (results) {
        results.style.display = 'none';
        results.innerHTML = '';
    }
}

// ========== LIGHTNING APORTACIÓN ECONÓMICA ==========
const LN_ADDRESS = 'aportaciones@liberbitworld.org';
// Lightning functions (copyLnAddress, selectSatsAmount, openLightningPayment, generateLnQR)
// are defined in lightning.js to avoid duplication.


// ========== DEBATES DE GOBERNANZA ==========

let _currentDebateDTag    = null;   // dTag de la propuesta en debate activo
let _currentDebateTitle   = null;   // Título de la propuesta
let _debateReplyToId      = null;   // eventId al que se responde (threading)
let _debateReplyToAuthor  = null;   // nombre del autor del mensaje al que se responde

// ── Cargar sidebar de debates ─────────────────────────────────────
async function loadDebatesSidebar() {
    const container = document.getElementById('chatSidebarList');
    if (!container) return;
    container.innerHTML = '';

    if (typeof LBW_Governance === 'undefined') {
        container.innerHTML = `
            <div style="padding:1.5rem 1rem; text-align:center; color:var(--color-text-secondary); font-size:0.82rem;">
                <div style="font-size:2rem; margin-bottom:0.5rem;">🗳️</div>
                Módulo de gobernanza no disponible
            </div>`;
        return;
    }

    const proposals = LBW_Governance.getAllProposals();

    if (!proposals || proposals.length === 0) {
        container.innerHTML = `
            <div style="padding:1.5rem 1rem; text-align:center; color:var(--color-text-secondary); font-size:0.82rem;">
                <div style="font-size:2rem; margin-bottom:0.5rem;">📭</div>
                No hay propuestas activas.<br>
                <span style="font-size:0.75rem;">Crea una propuesta en Gobernanza.</span>
            </div>`;
        return;
    }

    // Header de sección
    container.innerHTML = `<div style="padding:0.5rem 0.75rem; font-size:0.7rem; color:var(--color-text-secondary); text-transform:uppercase; letter-spacing:0.5px; border-bottom:1px solid var(--color-border); margin-bottom:0.25rem;">🗳️ Canales de Debate</div>`;

    // Ordenar: activas primero, luego por fecha desc
    const sorted = [...proposals].sort((a, b) => {
        const aActive = a.status === 'active' ? 1 : 0;
        const bActive = b.status === 'active' ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return b.createdAt - a.createdAt;
    });

    sorted.forEach(p => {
        const dTag    = p.dTag || p.id;
        const title   = p.title || 'Propuesta sin título';
        const status  = p.status || 'closed';
        const isActive = status === 'active';
        const isCurrent = _currentDebateDTag === dTag;

        const typeEmoji = { referendum: '📋', budget: '💰', election: '👥' }[p.category] || '🗳️';
        const statusDot = isActive
            ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--color-accent-green);margin-right:4px;"></span>'
            : '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--color-text-secondary);opacity:0.4;margin-right:4px;"></span>';

        const msgCount = window.LBW_Debate ? window.LBW_Debate.getMessageCount(dTag) : 0;
        const countBadge = msgCount > 0
            ? `<span style="font-size:0.65rem; background:rgba(229,185,92,0.15); color:var(--color-gold); border:1px solid rgba(229,185,92,0.25); border-radius:10px; padding:1px 6px;">${msgCount}</span>`
            : '';

        container.innerHTML += `
            <div class="sidebar-conversation ${isCurrent ? 'active' : ''}"
                 data-lbw-action="openDebateChannel" data-dtag="${escapeHtml(dTag)}" data-title="${escapeHtml(title)}"
                 style="cursor:pointer;">
                <div class="sidebar-conv-avatar" style="background:linear-gradient(135deg,rgba(229,185,92,0.25),rgba(229,185,92,0.05)); font-size:1.1rem; flex-shrink:0;">
                    ${typeEmoji}
                </div>
                <div class="sidebar-conv-info" style="flex:1; min-width:0;">
                    <div class="sidebar-conv-name" style="display:flex; align-items:center; gap:2px;">
                        ${statusDot}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(title)}</span>
                    </div>
                    <div class="sidebar-conv-preview">${isActive ? '🟢 Activa' : '🔒 Cerrada'}</div>
                </div>
                <div style="flex-shrink:0;">${countBadge}</div>
            </div>`;
    });
}

// ── Abrir canal de debate de una propuesta ────────────────────────
function openDebateChannel(proposalDTag, proposalTitle) {
    if (currentChatTab !== 'debates') switchChatTab('debates');

    _currentDebateDTag  = proposalDTag;
    _currentDebateTitle = proposalTitle;
    cancelDebateReply();

    // Actualizar header
    const titleEl = document.getElementById('debateChannelTitle');
    const metaEl  = document.getElementById('debateChannelMeta');
    if (titleEl) titleEl.textContent = proposalTitle;
    if (metaEl)  metaEl.textContent  = `Propuesta · Debate público Nostr`;

    // Mostrar canal activo, ocultar placeholder
    document.getElementById('debatePlaceholder').style.display  = 'none';
    document.getElementById('debateActiveChannel').style.display = 'flex';

    // Limpiar mensajes y mostrar loading
    const msgContainer = document.getElementById('debateMessages');
    msgContainer.innerHTML = `
        <div id="debateLoadingState" style="padding:2rem; text-align:center; color:var(--color-text-secondary); font-size:0.85rem;">
            <div style="font-size:1.5rem; margin-bottom:0.5rem;">⏳</div>
            Conectando al debate...
        </div>`;

    // Actualizar sidebar para marcar activo
    loadDebatesSidebar();

    // Suscribirse al debate vía Nostr
    if (window.LBW_Debate) {
        window.LBW_Debate.subscribeDebate(proposalDTag, function(msg, type) {
            if (type === 'eose') {
                _renderDebateMessages(proposalDTag);
                return;
            }
            if (msg && _currentDebateDTag === proposalDTag) {
                _renderDebateMessages(proposalDTag);
                loadDebatesSidebar();
            }
        });
    }

    // Render tras 1.5s pase lo que pase (elimina el spinner)
    setTimeout(function() { _renderDebateMessages(proposalDTag); }, 1500);
}

// ── Cerrar canal activo ───────────────────────────────────────────
function closeDebateChannel() {
    _currentDebateDTag  = null;
    _currentDebateTitle = null;
    cancelDebateReply();

    document.getElementById('debatePlaceholder').style.display   = 'flex';
    document.getElementById('debateActiveChannel').style.display  = 'none';
    loadDebatesSidebar();
}

// ── Ir a la propuesta desde el header del debate ──────────────────
function openDebateProposalLink() {
    if (!_currentDebateDTag) return;
    // Navegar a la sección de gobernanza y mostrar detalle
    showSection('governanceSection');
    setTimeout(() => {
        if (typeof showProposalDetail === 'function') {
            showProposalDetail(_currentDebateDTag);
        }
    }, 300);
}

// ── Renderizar todos los mensajes del debate ──────────────────────
async function _renderDebateMessages(proposalDTag) {
    if (_currentDebateDTag !== proposalDTag) return;

    const container = document.getElementById('debateMessages');
    if (!container) return;

    const messages = window.LBW_Debate
        ? window.LBW_Debate.getMessages(proposalDTag)
        : [];

    if (messages.length === 0) {
        container.innerHTML = `
            <div style="padding:2rem 1rem; text-align:center; color:var(--color-text-secondary);">
                <div style="font-size:2rem; margin-bottom:0.75rem;">💬</div>
                <div style="font-weight:600; color:var(--color-gold); margin-bottom:0.4rem;">Sé el primero en debatir</div>
                <div style="font-size:0.8rem; line-height:1.5;">
                    Este es el canal de debate para esta propuesta.<br>
                    Comparte tus argumentos, preguntas o reflexiones.
                </div>
            </div>`;
        return;
    }

    // Construir mapa id → mensaje para threading
    const msgMap = {};
    messages.forEach(m => { msgMap[m.id] = m; });

    let html = '';
    for (const msg of messages) {
        html += await _renderDebateMessage(msg, msgMap);
    }

    container.innerHTML = html;

    // Scroll al fondo
    container.scrollTop = container.scrollHeight;
}

// ── Renderizar un mensaje individual ─────────────────────────────
async function _renderDebateMessage(msg, msgMap) {
    const isMe = LBW_Nostr && LBW_Nostr.isLoggedIn &&
                 msg.pubkey === (window.currentUser?.publicKey || window.currentUser?.pubkey);

    // Nombre del autor
    let authorName = msg.pubkey.substring(0, 8) + '...';
    try {
        if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge._resolveName) {
            const resolved = await LBW_NostrBridge._resolveName(msg.pubkey);
            if (resolved) authorName = resolved;
        }
    } catch (e) {}

    // Si es reply, obtener texto del padre
    let replyBlock = '';
    if (msg.replyTo && msgMap[msg.replyTo]) {
        const parent = msgMap[msg.replyTo];
        let parentAuthor = parent.pubkey.substring(0, 8) + '...';
        const rawContent = parent.content || '';
        const preview = rawContent.substring(0, 60) + (rawContent.length > 60 ? '…' : '');
        replyBlock = `
            <div style="background:rgba(229,185,92,0.06); border-left:3px solid var(--color-gold); border-radius:4px; padding:0.35rem 0.6rem; margin-bottom:0.4rem; font-size:0.75rem; color:var(--color-text-secondary); cursor:pointer;" data-lbw-action="scrollToDebateMessage" data-event-id="${escapeHtml(msg.replyTo)}">
                <span style="color:var(--color-gold); font-weight:600;">↩ ${escapeHtml(parentAuthor)}</span>
                <span style="margin-left:0.4rem;">${escapeHtml(preview)}</span>
            </div>`;
    }

    const timeStr = msg.createdAt ? timeAgo(msg.createdAt * 1000) : '';
    const initial = (authorName.replace(/[^\p{L}\p{N}]/gu, '')[0] || '?').toUpperCase();
    const avatarColor = isMe ? 'var(--color-teal-dark)' : 'rgba(229,185,92,0.25)';

    return `
        <div id="debate-msg-${msg.id}" class="debate-message ${isMe ? 'debate-message-mine' : ''}"
             style="display:flex; gap:0.6rem; padding:0.5rem 0.75rem; ${isMe ? 'flex-direction:row-reverse;' : ''}">
            <div style="flex-shrink:0; width:30px; height:30px; border-radius:50%; background:${avatarColor}; display:flex; align-items:center; justify-content:center; font-size:0.8rem; font-weight:700; color:var(--color-gold);">
                ${initial}
            </div>
            <div style="flex:1; min-width:0; max-width:75%; ${isMe ? 'align-items:flex-end;' : ''} display:flex; flex-direction:column;">
                <div style="display:flex; align-items:baseline; gap:0.5rem; margin-bottom:0.25rem; ${isMe ? 'flex-direction:row-reverse;' : ''}">
                    <span style="font-size:0.8rem; font-weight:700; color:${isMe ? 'var(--color-teal-light)' : 'var(--color-gold)'};">${escapeHtml(authorName)}</span>
                    <span style="font-size:0.65rem; color:var(--color-text-secondary);">${timeStr}</span>
                </div>
                ${replyBlock}
                <div style="background:${isMe ? 'rgba(38,166,154,0.15)' : 'var(--color-bg-card)'}; border:1px solid ${isMe ? 'rgba(38,166,154,0.3)' : 'var(--color-border)'}; border-radius:${isMe ? '12px 2px 12px 12px' : '2px 12px 12px 12px'}; padding:0.5rem 0.75rem; font-size:0.85rem; line-height:1.5; color:var(--color-text-primary); word-wrap:break-word;">
                    ${typeof LBW_ChatAttach !== 'undefined' ? LBW_ChatAttach.renderContent(msg.content) : escapeHtml(msg.content).replace(/\n/g, '<br>')}
                </div>
                <div style="display:flex; gap:0.5rem; margin-top:0.25rem; ${isMe ? 'flex-direction:row-reverse;' : ''}">
                    <button data-lbw-action="replyToDebateMessage" data-event-id="${escapeHtml(msg.id)}" data-name="${escapeHtml(authorName)}"
                            style="font-size:0.65rem; color:var(--color-text-secondary); background:none; border:none; cursor:pointer; padding:2px 4px; border-radius:4px; transition:all 0.2s;"
                            onmouseover="this.style.color='var(--color-gold)'" onmouseout="this.style.color='var(--color-text-secondary)'">
                        ↩ Responder
                    </button>
                </div>
            </div>
        </div>`;
}

// ── Scroll a un mensaje específico ────────────────────────────────
function _scrollToDebateMessage(eventId) {
    const el = document.getElementById(`debate-msg-${eventId}`);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.background = 'rgba(229,185,92,0.08)';
        setTimeout(() => { el.style.background = ''; }, 1500);
    }
}

// ── Activar reply a un mensaje ────────────────────────────────────
function replyToDebateMessage(eventId, authorName) {
    _debateReplyToId     = eventId;
    _debateReplyToAuthor = authorName;

    // Obtener preview del mensaje
    const messages = window.LBW_Debate && _currentDebateDTag
        ? window.LBW_Debate.getMessages(_currentDebateDTag)
        : [];
    const parent = messages.find(m => m.id === eventId);
    const preview = parent ? (parent.content || '').substring(0, 50) : '';

    document.getElementById('debateReplyPreview').style.display = 'flex';
    document.getElementById('debateReplyAuthor').textContent = authorName;
    document.getElementById('debateReplyText').textContent = ' · ' + preview + (preview.length >= 50 ? '…' : '');
    document.getElementById('debateInput').focus();
}

// ── Cancelar reply ────────────────────────────────────────────────
function cancelDebateReply() {
    _debateReplyToId     = null;
    _debateReplyToAuthor = null;
    const preview = document.getElementById('debateReplyPreview');
    if (preview) preview.style.display = 'none';
}

// ── Enviar mensaje al debate ──────────────────────────────────────
async function sendDebateMessage() {
    if (!_currentDebateDTag) return;

    const input = document.getElementById('debateInput');
    const content = input ? input.value.trim() : '';
    if (!content) return;

    if (!LBW_Nostr || !LBW_Nostr.isLoggedIn()) {
        showNotification('Necesitas conectarte con Nostr para participar en el debate', 'error');
        return;
    }

    const btn = document.querySelector('#debateActiveChannel .chat-send-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

    try {
        await window.LBW_Debate.publishDebateMessage(
            _currentDebateDTag,
            content,
            _debateReplyToId || null
        );
        if (input) input.value = '';
        cancelDebateReply();
        showNotification('💬 Mensaje publicado en el debate', 'success');
    } catch (err) {
        console.error('[Debate] Error enviando mensaje:', err);
        showNotification('Error: ' + (err.message || 'No se pudo publicar'), 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '➤'; }
    }
}

// ── Abrir debates desde gobernanza (llamado desde tarjeta de propuesta) ──
function openProposalDebate(proposalDTag, proposalTitle) {
    showSection('chatSection');
    switchChatTab('debates');
    setTimeout(() => openDebateChannel(proposalDTag, proposalTitle), 200);
}

// ═══════════════════════════════════════════════════════════════════
// SEC-11/12: Event delegation for chat actions.
// Replaces inline onclick="foo('${value}')" handlers that were vulnerable
// to XSS via HTML entity decoding in attribute contexts.
// All rendered elements now use data-lbw-action + data-* attributes,
// which are safely HTML-escaped and read via element.dataset at dispatch time.
// ═══════════════════════════════════════════════════════════════════
(function installChatEventDelegation() {
    if (window.__lbwChatListenerInstalled) return;
    window.__lbwChatListenerInstalled = true;

    document.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-lbw-action]') : null;
        if (!el) return;
        var action = el.dataset.lbwAction;
        try {
            switch (action) {
                case 'openPrivateChat':
                    openPrivateChat(el.dataset.pubkey, el.dataset.name);
                    break;
                case 'startChatFromSearch':
                    startChatFromSearch(el.dataset.pubkey, el.dataset.name);
                    break;
                case 'openDebateChannel':
                    openDebateChannel(el.dataset.dtag, el.dataset.title);
                    break;
                case 'scrollToDebateMessage':
                    _scrollToDebateMessage(el.dataset.eventId);
                    break;
                case 'replyToDebateMessage':
                    replyToDebateMessage(el.dataset.eventId, el.dataset.name);
                    break;
                // Non-matching actions fall through silently — other modules
                // may register additional actions on the same event space.
            }
        } catch (err) {
            console.error('[Chat delegation] Error dispatching', action, err);
        }
    });
})();

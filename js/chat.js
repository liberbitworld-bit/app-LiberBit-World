    // ========== DIRECT MESSAGES FUNCTIONS ==========

function startDirectMessage(recipientId, recipientName) {
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
    
    document.getElementById('conversationsList').style.display = 'none';
    document.getElementById('activeChat').style.display = 'block';
    document.getElementById('chatWithName').textContent = userName;
    document.getElementById('chatWithId').textContent = userId.substring(0, 16) + '...';
    
    loadDirectMessages(userId);
}

function closeActiveChat() {
    currentChatWith = null;
    document.getElementById('conversationsList').style.display = 'block';
    document.getElementById('activeChat').style.display = 'none';
    document.getElementById('dmContent').value = '';
    loadConversationsList();
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
    } else {
        lastSeenPrivate = Date.now();
        localStorage.setItem('lastSeen_private', lastSeenPrivate.toString());
        updateChatTabBadge('private', 0);
    }
    
    // Update tab buttons
    document.getElementById('tabCommunity').classList.toggle('active', tab === 'community');
    document.getElementById('tabPrivate').classList.toggle('active', tab === 'private');
    
    // Update main view
    document.getElementById('communityView').style.display = tab === 'community' ? 'flex' : 'none';
    document.getElementById('privateView').style.display = tab === 'private' ? 'flex' : 'none';
    
    // Load sidebar content
    loadChatSidebar();
    
    if (tab === 'community') {
        loadPosts();
    } else {
        loadPrivateConversationsSidebar();
    }
    
    // Update the OTHER tab's badge
    updateChatBadges();
}

function updateChatTabBadge(tab, count) {
    const badgeId = tab === 'community' ? 'badgeCommunity' : 'badgePrivate';
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

async function loadChatSidebar() {
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
    } else {
        await loadPrivateConversationsSidebar();
    }
}

async function appendPrivateConversationsToSidebar(container) {
    // === UNIFICADO: Usar conversaciones de Nostr (cifrado E2E) ===
    
    // Verificar si LBW_NostrBridge tiene conversaciones
    if (typeof LBW_NostrBridge === 'undefined' || !LBW_NostrBridge.getConversations) {
        // El bridge maneja su propio sidebar en _updateDMSidebar()
        // Solo mostrar indicador de que se usa Nostr
        console.log('[Chat] Sidebar manejado por LBW_NostrBridge');
        return;
    }
    
    try {
        const conversations = LBW_NostrBridge.getConversations();
        
        if (!conversations || conversations.length === 0) {
            return; // El sidebar vacío se maneja en loadPrivateConversationsSidebar
        }
        
        container.innerHTML += `<div style="padding: 0.5rem 0.75rem; font-size: 0.7rem; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 0.5rem;">🔐 Conversaciones Cifradas</div>`;
        
        conversations.forEach(conv => {
            const initial = (conv.name || '?').charAt(0).toUpperCase();
            const isActive = currentChatWith && currentChatWith.id === conv.pubkey;
            const preview = conv.lastMessage ? conv.lastMessage.substring(0, 30) : 'Mensaje cifrado';
            const timeStr = conv.timestamp ? timeAgo(conv.timestamp * 1000) : '';
            
            container.innerHTML += `
                <div class="sidebar-conversation ${isActive ? 'active' : ''}" onclick="openPrivateChat('${conv.pubkey}', '${escapeHtml(conv.name || 'Usuario')}')">
                    <div class="sidebar-conv-avatar">${initial}</div>
                    <div class="sidebar-conv-info">
                        <div class="sidebar-conv-name">${escapeHtml(conv.name || 'Usuario')}</div>
                        <div class="sidebar-conv-preview">🔒 ${escapeHtml(preview)}${preview.length >= 30 ? '...' : ''}</div>
                    </div>
                    <div class="sidebar-conv-time">${timeStr}</div>
                </div>
            `;
        });
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
            const avatarHtml = user.avatar_url 
                ? `<img src="${user.avatar_url}" style="width:32px; height:32px; border-radius:50%; object-fit:cover; flex-shrink:0;">`
                : `<div style="width:32px; height:32px; border-radius:50%; background:var(--color-teal-dark); display:flex; align-items:center; justify-content:center; color:var(--color-gold); font-weight:700; font-size:0.9rem; flex-shrink:0;">${initial}</div>`;
            
            return `
                <div onclick="startChatFromSearch('${user.public_key}', '${escapeHtml(user.name || 'Usuario')}')" style="display:flex; align-items:center; gap:0.6rem; padding:0.6rem; border-radius:8px; cursor:pointer; transition: background 0.2s;" onmouseover="this.style.background='rgba(229,185,92,0.1)'" onmouseout="this.style.background='none'">
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
const LN_ADDRESS = 'liberbitworld@blink.sv';

function copyLnAddress() {
    navigator.clipboard.writeText(LN_ADDRESS).then(() => {
        showNotification('⚡ Dirección Lightning copiada');
    }).catch(() => {
        // Fallback
        const el = document.createElement('textarea');
        el.value = LN_ADDRESS;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        showNotification('⚡ Dirección Lightning copiada');
    });
}

function selectSatsAmount(amount) {
    document.getElementById('customSatsAmount').value = amount;
}

function openLightningPayment() {
    const amount = document.getElementById('customSatsAmount').value || '';
    const lnurl = `lightning:${LN_ADDRESS}${amount ? '?amount=' + amount : ''}`;
    
    // Try to open lightning: URI (will open wallet app if installed)
    window.open(lnurl, '_blank');
    
    showNotification('⚡ Abriendo wallet Lightning...', 'info');
}

// Simple QR code generator for Lightning address
function generateLnQR() {
    const canvas = document.getElementById('lnQrCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = 180;
    
    // Simple visual QR-like pattern (not a real QR - for display purposes)
    // Generate a deterministic pattern from the address
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, size, size);
    
    const text = LN_ADDRESS;
    const cellSize = 6;
    const cols = Math.floor(size / cellSize);
    
    ctx.fillStyle = '#1a1a2e';
    
    // Generate pattern from address hash
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash = hash & hash;
    }
    
    // Draw position markers (corners)
    function drawMarker(x, y, s) {
        ctx.fillRect(x, y, s * 7, s);
        ctx.fillRect(x, y, s, s * 7);
        ctx.fillRect(x + s * 6, y, s, s * 7);
        ctx.fillRect(x, y + s * 6, s * 7, s);
        ctx.fillRect(x + s * 2, y + s * 2, s * 3, s * 3);
    }
    
    drawMarker(2, 2, cellSize);
    drawMarker(size - 2 - cellSize * 7, 2, cellSize);
    drawMarker(2, size - 2 - cellSize * 7, cellSize);
    
    // Fill data area with deterministic pattern
    let seed = Math.abs(hash);
    for (let y = 0; y < cols; y++) {
        for (let x = 0; x < cols; x++) {
            // Skip marker areas
            if ((x < 9 && y < 9) || (x > cols - 10 && y < 9) || (x < 9 && y > cols - 10)) continue;
            
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            if (seed % 3 !== 0) {
                ctx.fillRect(x * cellSize, y * cellSize, cellSize - 1, cellSize - 1);
            }
        }
    }
    
    // Draw lightning bolt in center
    ctx.fillStyle = '#FF9800';
    const cx = size / 2;
    const cy = size / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy - 12);
    ctx.lineTo(cx + 6, cy - 12);
    ctx.lineTo(cx + 1, cy - 2);
    ctx.lineTo(cx + 8, cy - 2);
    ctx.lineTo(cx - 6, cy + 14);
    ctx.lineTo(cx - 1, cy + 2);
    ctx.lineTo(cx - 8, cy + 2);
    ctx.closePath();
    ctx.fill();
}

// Generate QR when section is shown

    

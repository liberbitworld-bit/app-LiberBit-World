// ========== LIGHTNING APORTACIÓN ECONÓMICA ==========
// LN_ADDRESS already declared in chat.js

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

// Generate real QR code for Lightning address
let lnQrCodeInstance = null;

function generateLnQR() {
    const container = document.getElementById('lnQrCode');
    if (!container) return;
    
    // Clear previous QR
    container.innerHTML = '';
    
    // Create LNURL-pay URI (standard format for Lightning addresses)
    const lnurlPay = `lightning:${LN_ADDRESS}`;
    
    // Generate QR code using QRCode.js library
    try {
        lnQrCodeInstance = new QRCode(container, {
            text: lnurlPay,
            width: 180,
            height: 180,
            colorDark: '#1a1a2e',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
        console.log('⚡ QR Lightning generado:', lnurlPay);
    } catch (err) {
        console.error('Error generando QR:', err);
        // Fallback: mostrar la dirección
        container.innerHTML = `<div style="padding: 2rem; text-align: center; color: #1a1a2e; font-size: 0.8rem;">${LN_ADDRESS}</div>`;
    }
}

// Generate QR when section is shown
const origOpenApp = openApp;
// We'll call generateLnQR when the section opens - handled in openApp

async function loadConversationsList() {
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    
    try {
        // Load all messages involving the current user (usando sender_id y recipient_id)
        const { data, error } = await supabaseClient
            .from('direct_messages')
            .select('*')
            .or(`sender_id.eq.${pubKey},recipient_id.eq.${pubKey}`)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error loading conversations:', error);
            return;
        }

        // Get unique conversations
        const conversations = new Map();
        
        (data || []).forEach(msg => {
            const otherUserId = msg.sender_id === pubKey ? msg.recipient_id : msg.sender_id;
            const otherUserName = msg.sender_id === pubKey ? msg.recipient_name : msg.sender_name;
            const timestamp = new Date(msg.created_at).getTime();
            
            if (!conversations.has(otherUserId)) {
                conversations.set(otherUserId, {
                    userId: otherUserId,
                    userName: otherUserName,
                    lastMessage: msg.content,
                    timestamp: timestamp
                });
            } else {
                const existing = conversations.get(otherUserId);
                if (timestamp > existing.timestamp) {
                    conversations.set(otherUserId, {
                        userId: otherUserId,
                        userName: otherUserName,
                        lastMessage: msg.content,
                        timestamp: timestamp
                    });
                }
            }
        });

        const container = document.getElementById('conversationsList');
        if (!container) return; // Elemento legacy — no presente en la vista actual
        
        if (conversations.size === 0) {
            container.innerHTML = `
                <div class="placeholder">
                    <h3>📭 No tienes conversaciones</h3>
                    <p>Contacta con alguien desde el Networking para empezar</p>
                </div>
            `;
            return;
        }

        const sortedConversations = Array.from(conversations.values())
            .sort((a, b) => b.timestamp - a.timestamp);

        container.innerHTML = sortedConversations.map(conv => `
            <div class="conversation-item" onclick="openChatWith('${conv.userId}', '${escapeHtml(conv.userName)}')">
                <div class="conversation-info">
                    <div class="conversation-name">${escapeHtml(conv.userName)}</div>
                    <div class="conversation-preview">${escapeHtml(conv.lastMessage.substring(0, 60))}${conv.lastMessage.length > 60 ? '...' : ''}</div>
                </div>
                <div class="conversation-time">${timeAgo(conv.timestamp)}</div>
            </div>
        `).join('');
    } catch (err) {
        console.error('Error loading conversations:', err);
    }
}

async function loadDirectMessages(userId) {
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    
    try {
        // Load from Supabase (usando sender_id y recipient_id)
        const { data, error } = await supabaseClient
            .from('direct_messages')
            .select('*')
            .or(`and(sender_id.eq.${pubKey},recipient_id.eq.${userId}),and(sender_id.eq.${userId},recipient_id.eq.${pubKey})`)
            .order('created_at', { ascending: true });

        if (error) {
            console.error('Error loading messages:', error);
            showNotification('Error al cargar mensajes', 'error');
            return;
        }

        const conversation = data || [];
        const container = document.getElementById('chatMessages');
        if (!container) return; // Elemento legacy — no presente en la vista actual
        
        if (conversation.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 3rem; color: var(--color-text-secondary);">
                    <p style="font-size: 1.2rem; margin-bottom: 0.5rem;">💬 Inicia la conversación</p>
                    <p style="font-size: 0.9rem;">Envía el primer mensaje</p>
                </div>
            `;
            return;
        }

        container.innerHTML = conversation.map(msg => {
            const isMine = msg.sender_id === pubKey;
            const timestamp = new Date(msg.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
            return `
                <div class="dm-message ${isMine ? 'mine' : 'theirs'}">
                    <div class="dm-bubble">
                        ${escapeHtml(msg.content)}
                    </div>
                    <div class="dm-time">${timestamp}</div>
                </div>
            `;
        }).join('');

        // Scroll to bottom
        container.scrollTop = container.scrollHeight;
    } catch (err) {
        console.error('Error loading messages:', err);
        showNotification('Error al cargar mensajes', 'error');
    }
}

async function sendDirectMessage() {
    if (!currentChatWith) return;

    const content = document.getElementById('dmContent').value.trim();
    if (!content) {
        showNotification('Escribe un mensaje', 'error');
        return;
    }

    const pubKey = currentUser.pubkey || currentUser.publicKey;

    try {
        // Save to Supabase (usando sender_id y recipient_id)
        const { data, error } = await supabaseClient
            .from('direct_messages')
            .insert([{
                sender_id: pubKey,
                sender_name: currentUser.name,
                recipient_id: currentChatWith.id,
                recipient_name: currentChatWith.name,
                content: content
            }])
            .select();

        if (error) {
            console.error('Error sending message:', error);
            showNotification('Error al enviar mensaje: ' + error.message, 'error');
            return;
        }

        document.getElementById('dmContent').value = '';
        // Reload messages in the new layout
        if (document.getElementById('privateChatMessages')) {
            await loadPrivateChatMessages(currentChatWith.id);
        }
        await loadDirectMessages(currentChatWith.id);
        showNotification('Mensaje enviado ✅');
    } catch (err) {
        console.error('Error sending message:', err);
        showNotification('Error al enviar mensaje', 'error');
    }
}

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


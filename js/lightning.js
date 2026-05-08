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

// ═══════════════════════════════════════════════════════════════════
// [SEC-C1] Eliminadas las funciones legacy de DM por Supabase plaintext:
//   - loadConversationsList(), loadDirectMessages(), sendDirectMessage()
// Persistían los mensajes directos como TEXTO PLANO en supabaseClient
// .from('direct_messages'), contradiciendo la promesa E2E de la app.
// El flujo activo de DMs es 100% Nostr E2E (NIP-44 / NIP-04) vía
// LBW_DM, LBW_Nostr.sendDirectMessage y LBW_NostrBridge.openDMConversation.
// Si la tabla direct_messages aún tiene datos en producción, planificar
// purga server-side — los nuevos clientes ya no leen ni escriben ahí.
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// SEC-11/12: Event delegation for lightning chat actions.
// ═══════════════════════════════════════════════════════════════════
(function installLightningEventDelegation() {
    if (window.__lbwLightningListenerInstalled) return;
    window.__lbwLightningListenerInstalled = true;

    document.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-lbw-action]') : null;
        if (!el) return;
        var action = el.dataset.lbwAction;
        try {
            if (action === 'openChatWith' && typeof openChatWith === 'function') {
                openChatWith(el.dataset.userId, el.dataset.userName);
            }
        } catch (err) {
            console.error('[Lightning delegation] Error dispatching', action, err);
        }
    });
})();

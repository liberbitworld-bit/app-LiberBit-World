// ========== LIGHTNING APORTACIÓN ECONÓMICA ==========
// LN_ADDRESS already declared in chat.js
//
// Dos flujos:
//   A) Genérico — abre `lightning:<LN_ADDRESS>` en la wallet del usuario.
//      Funciona para todo el mundo, sin atribución de donante salvo lo
//      que escriba en el memo de su wallet.
//   B) Zap NIP-57 (si el usuario está logueado en LBW) — firma una
//      kind:9734 con su nsec, llama al callback LNURLP con &nostr=...,
//      coinos publica el zap receipt (kind:9735) que vincula
//      criptográficamente el pago con el donante. Aparece con badge
//      "⚡ zap" en la cadena de transparencia.

// Pubkey x-only de Liberbitworld@coinos.io (npub1qtftsn...zt2q2wrn8d).
// Necesaria como tag "p" del zap request. Coinos verifica que coincida
// con el destinatario antes de generar el invoice.
const LBW_TREASURY_PUBKEY = '02d2b84cb983f26787005182b8e2d16081f872da7da1325912922514903012d4';
const LNURLP_LBW_ENDPOINT = 'https://www.liberbitworld.org/.well-known/lnurlp/aportaciones';

function copyLnAddress() {
    navigator.clipboard.writeText(LN_ADDRESS).then(() => {
        showNotification('⚡ Dirección Lightning copiada');
    }).catch(() => {
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
    _updateZapButtonVisibility();
}

// Abre el `lightning:` URI con la LN address y la cantidad. Sin atribución.
function openLightningPayment() {
    const amount = document.getElementById('customSatsAmount').value || '';
    const lnurl = `lightning:${LN_ADDRESS}${amount ? '?amount=' + amount : ''}`;
    window.open(lnurl, '_blank');
    showNotification('⚡ Abriendo wallet Lightning...', 'info');
}

// Generate QR for the LN address (used in the section header)
let lnQrCodeInstance = null;
function generateLnQR() {
    const container = document.getElementById('lnQrCode');
    if (!container) return;
    container.innerHTML = '';
    const lnurlPay = `lightning:${LN_ADDRESS}`;
    try {
        lnQrCodeInstance = new QRCode(container, {
            text: lnurlPay,
            width: 180,
            height: 180,
            colorDark: '#1a1a2e',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
    } catch (err) {
        console.error('Error generando QR:', err);
        container.innerHTML = `<div style="padding: 2rem; text-align: center; color: #1a1a2e; font-size: 0.8rem;">${LN_ADDRESS}</div>`;
    }
}

// ── Zap NIP-57 flow ──────────────────────────────────────────
//
// 1. GET /.well-known/lnurlp/aportaciones (público, ya redirige a coinos)
//    Devuelve { callback, allowsNostr, minSendable, maxSendable }.
// 2. Si user logueado y allowsNostr: construir kind:9734 zap request,
//    firmar con LBW_Nostr.signEvent (ext / nsec / bunker).
// 3. GET callback?amount=<msats>&nostr=<event-json>&comment=<msg>
//    Devuelve { pr: "lnbc..." } — invoice BOLT11.
// 4. Mostrar invoice + QR. Usuario paga desde su wallet → coinos
//    publica kind:9735 → cadena de transparencia muestra atribución.
async function payAportacionWithZap() {
    const amountSats = parseInt(document.getElementById('customSatsAmount').value, 10);
    const message = (document.getElementById('aportacionMessage') || {}).value || '';

    if (!amountSats || amountSats < 1) {
        showNotification('Introduce una cantidad de sats válida', 'error');
        return;
    }
    if (typeof LBW_Nostr === 'undefined' || !LBW_Nostr.isLoggedIn()) {
        showNotification('Necesitas estar logueado en LBW para firmar el zap', 'error');
        return;
    }

    const amountMsats = amountSats * 1000;
    const btn = document.getElementById('payAportacionZapBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Firmando…'; }

    try {
        // 1. Metadata LNURLP
        const metaRes = await fetch(LNURLP_LBW_ENDPOINT);
        if (!metaRes.ok) throw new Error('LNURLP no disponible (' + metaRes.status + ')');
        const meta = await metaRes.json();

        if (amountMsats < (meta.minSendable || 1000)) {
            throw new Error('Importe mínimo: ' + Math.floor((meta.minSendable || 1000) / 1000) + ' sats');
        }
        if (meta.maxSendable && amountMsats > meta.maxSendable) {
            throw new Error('Importe máximo: ' + Math.floor(meta.maxSendable / 1000) + ' sats');
        }
        if (!meta.allowsNostr) {
            throw new Error('Coinos no expone allowsNostr — no se puede firmar zap');
        }

        // 2. Construir y firmar kind:9734 (NIP-57 zap request)
        let relays = [];
        try { relays = (LBW_Nostr.getReadRelays && LBW_Nostr.getReadRelays()) || []; } catch (_) {}
        if (relays.length === 0) relays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.liberbitworld.org'];
        relays = relays.slice(0, 8);

        const zapReqTemplate = {
            kind: 9734,
            created_at: Math.floor(Date.now() / 1000),
            content: (message || '').substring(0, 280),
            tags: [
                ['relays', ...relays],
                ['amount', String(amountMsats)],
                ['p', LBW_TREASURY_PUBKEY]
            ]
        };
        const signed = await LBW_Nostr.signEvent(zapReqTemplate);

        // 3. Pedir invoice al callback con el zap request adjunto
        const callbackUrl = meta.callback
            + '?amount=' + amountMsats
            + '&nostr=' + encodeURIComponent(JSON.stringify(signed))
            + (message ? '&comment=' + encodeURIComponent(message.substring(0, 144)) : '');

        const cbRes = await fetch(callbackUrl);
        if (!cbRes.ok) throw new Error('Callback LNURLP error ' + cbRes.status);
        const cbData = await cbRes.json();
        if (cbData.status === 'ERROR') throw new Error(cbData.reason || 'Error LNURLP');
        if (!cbData.pr) throw new Error('Callback no devolvió invoice (pr)');

        // 4. Render invoice
        _showAportacionInvoice({
            invoice: cbData.pr,
            amountSats,
            message,
            senderPubkey: signed.pubkey
        });

    } catch (err) {
        console.warn('[Lightning] zap aportación falló:', err);
        showNotification('Error: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '⚡ Firmar y pagar como zap (auto-atribución)'; }
    }
}

// Muestra el invoice resultante + QR + acciones (copiar, abrir wallet).
function _showAportacionInvoice({ invoice, amountSats, message, senderPubkey }) {
    const box = document.getElementById('aportacionInvoiceBox');
    if (!box) return;
    box.style.display = 'block';
    const npubShort = senderPubkey
        ? (senderPubkey.substring(0, 8) + '…' + senderPubkey.substring(senderPubkey.length - 4))
        : '—';
    box.innerHTML = `
        <div style="background:linear-gradient(135deg,rgba(206,147,216,0.1),rgba(255,152,0,0.06));border:1px solid rgba(206,147,216,0.35);border-radius:14px;padding:1.25rem;margin-top:1rem;">
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem;flex-wrap:wrap;">
                <span style="font-size:0.7rem;background:rgba(206,147,216,0.2);color:#CE93D8;padding:0.25rem 0.6rem;border-radius:10px;border:1px solid rgba(206,147,216,0.4);font-weight:700;">⚡ ZAP NIP-57 FIRMADO</span>
                <span style="font-size:0.78rem;color:var(--color-text-secondary);">como <strong style="color:#CE93D8;font-family:var(--font-mono);">${npubShort}</strong></span>
            </div>
            <div style="font-size:1.6rem;font-weight:800;color:#FFB74D;margin-bottom:0.5rem;">${amountSats.toLocaleString('es-ES')} sats</div>
            ${message ? `<div style="font-size:0.85rem;color:var(--color-text-secondary);font-style:italic;margin-bottom:0.75rem;">"${message.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]))}"</div>` : ''}

            <div id="aportacionInvoiceQr" style="background:white;padding:0.75rem;border-radius:10px;display:inline-block;margin:0.5rem 0;"></div>

            <div style="margin-top:0.75rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
                <button onclick="window.open('lightning:${invoice}','_blank'); showNotification('Abriendo wallet…','info');" style="padding:0.7rem 1rem;background:linear-gradient(135deg,#FF9800,#F57C00);border:none;border-radius:10px;color:white;font-weight:700;cursor:pointer;font-size:0.9rem;">⚡ Abrir wallet</button>
                <button onclick="navigator.clipboard.writeText('${invoice}').then(()=>showNotification('Invoice copiado','success'))" style="padding:0.7rem 1rem;background:transparent;border:1px solid var(--color-border);border-radius:10px;color:var(--color-text-primary);font-weight:600;cursor:pointer;font-size:0.85rem;">📋 Copiar invoice</button>
                <button onclick="document.getElementById('aportacionInvoiceBox').style.display='none'" style="padding:0.7rem 1rem;background:transparent;border:1px solid var(--color-border);border-radius:10px;color:var(--color-text-secondary);font-weight:600;cursor:pointer;font-size:0.85rem;">✕ Cerrar</button>
            </div>

            <div style="margin-top:0.85rem;font-size:0.72rem;color:var(--color-text-secondary);line-height:1.5;">
                Cuando pagues este invoice, coinos publicará un evento Nostr (kind:9735) firmado vinculando tu npub al pago.
                Aparecerá automáticamente en <strong>Transparencia → Wallet</strong> con el badge <span style="color:#CE93D8;">⚡ zap</span>.
            </div>
        </div>
    `;
    // Render QR
    try {
        if (typeof QRCode !== 'undefined') {
            new QRCode(document.getElementById('aportacionInvoiceQr'), {
                text: 'lightning:' + invoice,
                width: 180,
                height: 180,
                colorDark: '#1a1a2e',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
        }
    } catch (_) {}
    // Scroll into view
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Oculta el botón de zap si no hay sesión, o si LBW_Nostr aún no cargó
function _updateZapButtonVisibility() {
    const btn = document.getElementById('payAportacionZapBtn');
    if (!btn) return;
    const loggedIn = typeof LBW_Nostr !== 'undefined' && LBW_Nostr.isLoggedIn && LBW_Nostr.isLoggedIn();
    btn.style.display = loggedIn ? 'flex' : 'none';
    const tipEl = document.getElementById('payAportacionZapTip');
    if (tipEl) tipEl.style.display = loggedIn ? 'none' : 'block';
}

// Hook: refresh visibility cuando se abre la sección o cuando cambia el login
window.addEventListener('DOMContentLoaded', () => {
    _updateZapButtonVisibility();
    // Re-check tras 2s para esperar inicialización tardía de LBW_Nostr/login
    setTimeout(_updateZapButtonVisibility, 2000);
});

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

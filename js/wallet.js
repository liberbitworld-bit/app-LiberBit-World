// ============================================
// LIBERBIT WALLET — Blink + WebLN + NWC (NIP-47)
// ============================================

const BLINK_API = 'https://api.blink.sv/graphql';
let walletData = {
    connected: false,
    type: null, // 'blink' | 'webln' | 'nwc'
    authToken: null,
    wallets: [],
    currentCurrency: 'BTC',
    balance: {
        BTC: 0,
        USD: 0
    },
    // Solo para NWC: resumen público (sin secret) — para mostrar en UI
    nwcSummary: null
};

// --------------------------------------------
// CONNECTORS
// --------------------------------------------

// Connect to Blink Wallet (DEMO — sin cambios)
async function connectBlinkWallet() {
    try {
        showNotification('🏖️ Conectando con Blink Wallet...');

        const demoMode = confirm('¿Usar modo DEMO? (En producción usarías tu cuenta de Blink real)\n\nSí = Demo\nNo = Cancelar');
        if (!demoMode) {
            showNotification('ℹ️ Para usar Blink real, necesitas autenticarte con tu número de teléfono', 'info');
            return;
        }

        walletData.connected = true;
        walletData.type = 'blink';
        walletData.authToken = 'DEMO_TOKEN';
        walletData.balance.BTC = 0.00050000;
        walletData.balance.USD = 45.50;
        walletData.nwcSummary = null;

        persistWallet();
        showWalletConnected();
        showNotification('✅ Wallet conectada correctamente', 'success');
    } catch (err) {
        console.error('Error connecting Blink:', err);
        showNotification('Error al conectar wallet', 'error');
    }
}

// Connect to WebLN (Alby) — sin cambios funcionales
async function connectWebLN() {
    try {
        if (typeof window.webln === 'undefined') {
            if (confirm('Alby no está instalado. ¿Abrir página de descarga?')) {
                window.open('https://getalby.com/', '_blank');
            }
            return;
        }

        showNotification('⚡ Conectando con Alby...');
        await window.webln.enable();
        await window.webln.getInfo();

        walletData.connected = true;
        walletData.type = 'webln';
        walletData.balance.BTC = 0;
        walletData.balance.USD = 0;
        walletData.nwcSummary = null;

        persistWallet();
        showWalletConnected();
        showNotification('✅ Alby conectado correctamente', 'success');
    } catch (err) {
        console.error('Error connecting WebLN:', err);
        showNotification('Error al conectar Alby: ' + err.message, 'error');
    }
}

// --------------------------------------------
// NWC (NIP-47)
// --------------------------------------------

function showNwcModal() {
    const modal = document.getElementById('nwcModal');
    if (!modal) return;
    const ta = document.getElementById('nwcUriInput');
    if (ta) ta.value = '';
    modal.style.display = 'flex';
    modal.classList.add('active');
    setTimeout(() => { if (ta) ta.focus(); }, 100);
}

function closeNwcModal() {
    const modal = document.getElementById('nwcModal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.classList.remove('active');
}

async function submitNwcUri() {
    const input = document.getElementById('nwcUriInput');
    if (!input) return;
    const uri = (input.value || '').trim();
    if (!uri) {
        showNotification('Pega tu URI de Nostr Wallet Connect', 'error');
        return;
    }
    if (!window.LBW_NWC) {
        showNotification('Módulo NWC no cargado. Recarga la página.', 'error');
        return;
    }

    const btn = document.getElementById('nwcSubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Conectando…'; }

    try {
        showNotification('🔌 Conectando con tu billetera vía NWC...');
        const res = await window.LBW_NWC.connect(uri);

        // Obtén balance real si el wallet lo soporta
        let btcBalance = 0;
        try {
            const bal = await window.LBW_NWC.getBalance();
            btcBalance = bal.btc || 0;
        } catch (e) {
            console.warn('[Wallet] No se pudo leer balance inicial:', e.message);
        }

        walletData.connected = true;
        walletData.type = 'nwc';
        walletData.authToken = null;
        walletData.balance.BTC = btcBalance;
        walletData.balance.USD = 0; // tasa de cambio pendiente
        walletData.nwcSummary = window.LBW_NWC.publicSummary();

        persistWallet();
        closeNwcModal();
        showWalletConnected();
        showNotification('✅ NWC conectado' + (res.lud16 ? ' (' + res.lud16 + ')' : ''), 'success');
    } catch (err) {
        console.error('[Wallet] Error NWC:', err);
        showNotification('Error NWC: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Conectar'; }
    }
}

async function refreshNwcBalance() {
    if (walletData.type !== 'nwc' || !window.LBW_NWC || !window.LBW_NWC.isConnected()) return;
    try {
        const bal = await window.LBW_NWC.getBalance();
        walletData.balance.BTC = bal.btc || 0;
        persistWallet();
        updateBalanceDisplay();
    } catch (e) {
        console.warn('[Wallet] No se pudo refrescar balance NWC:', e.message);
    }
}

// --------------------------------------------
// DISCONNECT / PERSISTENCE
// --------------------------------------------

function disconnectWallet() {
    if (!confirm('¿Desconectar billetera?')) return;

    try {
        if (walletData.type === 'nwc' && window.LBW_NWC) {
            window.LBW_NWC.disconnect();
        }
    } catch (e) {
        console.warn('[Wallet] Error desconectando NWC:', e);
    }

    walletData = {
        connected: false,
        type: null,
        authToken: null,
        wallets: [],
        currentCurrency: 'BTC',
        balance: { BTC: 0, USD: 0 },
        nwcSummary: null
    };

    localStorage.removeItem('liberbit_wallet');
    showWalletDisconnected();
    showNotification('Wallet desconectada');
}

function persistWallet() {
    // No guardamos el secret NWC aquí — LBW_NWC gestiona su propio storage
    const toSave = {
        connected: walletData.connected,
        type: walletData.type,
        currentCurrency: walletData.currentCurrency,
        balance: walletData.balance,
        nwcSummary: walletData.nwcSummary
    };
    try { localStorage.setItem('liberbit_wallet', JSON.stringify(toSave)); } catch (_) {}
}

// --------------------------------------------
// UI HELPERS
// --------------------------------------------

function switchCurrency(currency) {
    walletData.currentCurrency = currency;
    document.getElementById('currencyBTC').classList.toggle('active', currency === 'BTC');
    document.getElementById('currencyUSD').classList.toggle('active', currency === 'USD');
    updateBalanceDisplay();
}

function updateBalanceDisplay() {
    const balanceDisplay = document.getElementById('balanceDisplay');
    const balanceUSDEquiv = document.getElementById('balanceUSDEquiv');
    if (!balanceDisplay || !balanceUSDEquiv) return;

    if (walletData.currentCurrency === 'BTC') {
        balanceDisplay.textContent = walletData.balance.BTC.toFixed(8) + ' BTC';
        balanceUSDEquiv.textContent = walletData.balance.USD
            ? '≈ $' + walletData.balance.USD.toFixed(2) + ' USD'
            : '≈ ' + Math.round(walletData.balance.BTC * 1e8).toLocaleString() + ' sats';
    } else {
        balanceDisplay.textContent = '$' + walletData.balance.USD.toFixed(2) + ' USD';
        balanceUSDEquiv.textContent = '≈ ' + walletData.balance.BTC.toFixed(8) + ' BTC';
    }
}

function showWalletConnected() {
    document.getElementById('walletDisconnected').style.display = 'none';
    document.getElementById('walletConnected').style.display = 'block';
    updateBalanceDisplay();
    loadTransactions();

    // Si es NWC, refresca balance en background
    if (walletData.type === 'nwc') {
        refreshNwcBalance();
    }
}

function showWalletDisconnected() {
    document.getElementById('walletDisconnected').style.display = 'block';
    document.getElementById('walletConnected').style.display = 'none';
}

function showReceiveModal() {
    document.getElementById('receiveModal').style.display = 'flex';
    document.getElementById('receiveModal').classList.add('active');
}

function closeReceiveModal() {
    document.getElementById('receiveModal').style.display = 'none';
    document.getElementById('receiveModal').classList.remove('active');
    document.getElementById('invoiceDisplay').style.display = 'none';
}

// --------------------------------------------
// RECEIVE (GENERATE INVOICE)
// --------------------------------------------

async function generateInvoice() {
    try {
        const amount = parseFloat(document.getElementById('receiveAmount').value);
        const currency = document.getElementById('receiveCurrency').value;
        const memo = document.getElementById('receiveMemo').value || 'Pago LiberBit World';

        if (!amount || amount <= 0) {
            showNotification('Por favor ingresa una cantidad válida', 'error');
            return;
        }

        showNotification('Generando invoice...');

        // Conversión a sats (heurística: 1 EUR/USD ≈ 10k sats; TODO: tasa real)
        const amountSats = currency === 'BTC'
            ? Math.round(amount * 1e8)
            : Math.round(amount * 10000);

        let invoiceStr = null;

        // ── Vía 1: NWC (prioridad si conectado) ────────────────────────────
        if (walletData.type === 'nwc' && window.LBW_NWC && window.LBW_NWC.isConnected()) {
            try {
                const res = await window.LBW_NWC.makeInvoice(amountSats, memo);
                invoiceStr = res.invoice;
            } catch (err) {
                console.warn('[Wallet] NWC make_invoice falló, probando fallback:', err.message);
                showNotification('NWC: ' + err.message, 'error');
                // continúa con fallbacks
            }
        }

        // ── Vía 2: WebLN (Alby, Zeus, etc. en el navegador) ────────────────
        if (!invoiceStr && window.webln) {
            try {
                await window.webln.enable();
                const inv = await window.webln.makeInvoice({ amount: amountSats, defaultMemo: memo });
                invoiceStr = inv.paymentRequest;
            } catch (weblnErr) {
                console.warn('[Wallet] WebLN fallback:', weblnErr.message);
            }
        }

        // ── Vía 3: LNURLP del propio servidor (aportaciones@liberbitworld.org) ─
        if (!invoiceStr) {
            const amountMsats = amountSats * 1000;
            const metaRes = await fetch('/.well-known/lnurlp/aportaciones');
            if (!metaRes.ok) throw new Error('LNURLP no disponible (' + metaRes.status + ')');
            const meta = await metaRes.json();

            if (amountMsats < (meta.minSendable || 1000)) {
                showNotification('Importe mínimo: ' + ((meta.minSendable || 1000) / 1000) + ' sats', 'error');
                return;
            }
            if (meta.maxSendable && amountMsats > meta.maxSendable) {
                showNotification('Importe máximo superado.', 'error');
                return;
            }

            const callbackUrl = meta.callback + '?amount=' + amountMsats +
                '&comment=' + encodeURIComponent(memo.substring(0, 144));
            const cbRes = await fetch(callbackUrl);
            if (!cbRes.ok) throw new Error('Error del callback LNURLP (' + cbRes.status + ')');
            const cbData = await cbRes.json();
            if (cbData.status === 'ERROR') throw new Error(cbData.reason || 'Error LNURLP');
            invoiceStr = cbData.pr;
        }

        if (!invoiceStr) throw new Error('No se pudo generar invoice.');

        // ── Mostrar invoice + QR ───────────────────────────────────────────
        document.getElementById('invoiceText').textContent = invoiceStr;
        document.getElementById('invoiceDisplay').style.display = 'block';

        const qrContainer = document.getElementById('qrCode');
        qrContainer.innerHTML = '';
        if (typeof QRCode !== 'undefined') {
            new QRCode(qrContainer, {
                text: 'lightning:' + invoiceStr.toLowerCase(),
                width: 200,
                height: 200,
                colorDark: '#0d171e',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
        } else {
            qrContainer.innerHTML = '<p style="color:#aaa;font-size:0.85rem;text-align:center">Copia el invoice y pégalo en tu wallet Lightning</p>';
        }

        showNotification('✅ Invoice generado', 'success');

        // Refresca balance NWC tras recibir (con delay para que confirme)
        if (walletData.type === 'nwc') {
            setTimeout(refreshNwcBalance, 30000);
        }
    } catch (err) {
        console.error('Error generating invoice:', err);
        showNotification('Error al generar invoice: ' + err.message, 'error');
    }
}

function copyInvoice() {
    const invoiceText = document.getElementById('invoiceText').textContent;
    navigator.clipboard.writeText(invoiceText).then(() => {
        showNotification('✅ Invoice copiado al portapapeles', 'success');
    });
}

// --------------------------------------------
// SEND (PAY INVOICE)
// --------------------------------------------

function showSendModal() {
    document.getElementById('sendModal').style.display = 'flex';
    document.getElementById('sendModal').classList.add('active');
}

function closeSendModal() {
    document.getElementById('sendModal').style.display = 'none';
    document.getElementById('sendModal').classList.remove('active');
}

async function sendPayment() {
    try {
        const invoice = document.getElementById('sendInvoice').value.trim();
        if (!invoice) {
            showNotification('Por favor pega un invoice Lightning', 'error');
            return;
        }
        if (!invoice.toLowerCase().startsWith('lnbc')) {
            showNotification('Invoice Lightning inválido', 'error');
            return;
        }
        if (!confirm('¿Confirmar envío de pago?')) return;

        showNotification('Enviando pago...');

        if (walletData.type === 'nwc' && window.LBW_NWC && window.LBW_NWC.isConnected()) {
            const res = await window.LBW_NWC.payInvoice(invoice);
            const preimage = res && res.preimage ? ' · preimage ' + res.preimage.slice(0, 8) + '…' : '';
            showNotification('✅ Pago enviado vía NWC' + preimage, 'success');
            closeSendModal();
            // Refresca balance + historial
            setTimeout(() => { refreshNwcBalance(); loadTransactions(); }, 1500);
            return;
        }

        if (walletData.type === 'webln' && window.webln) {
            await window.webln.sendPayment(invoice);
            showNotification('✅ Pago enviado correctamente', 'success');
            closeSendModal();
            loadTransactions();
            return;
        }

        // Demo (Blink)
        await new Promise(resolve => setTimeout(resolve, 1500));
        showNotification('✅ Pago enviado (DEMO)', 'success');
        closeSendModal();
        loadTransactions();
    } catch (err) {
        console.error('Error sending payment:', err);
        showNotification('Error al enviar pago: ' + err.message, 'error');
    }
}

// --------------------------------------------
// CASHBACK MODAL (sin cambios)
// --------------------------------------------

function showCashbackModal() {
    document.getElementById('cashbackModal').style.display = 'flex';
    document.getElementById('cashbackModal').classList.add('active');
}

function closeCashbackModal() {
    document.getElementById('cashbackModal').style.display = 'none';
    document.getElementById('cashbackModal').classList.remove('active');
}

// --------------------------------------------
// TRANSACTIONS
// --------------------------------------------

async function loadTransactions() {
    const container = document.getElementById('transactionsList');
    if (!container) return;

    // Si NWC conectado, intenta cargar historial real
    if (walletData.type === 'nwc' && window.LBW_NWC && window.LBW_NWC.isConnected()) {
        container.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--color-text-secondary);">Cargando transacciones…</div>';
        try {
            const txs = await window.LBW_NWC.listTransactions(20);
            renderTransactions(container, txs.map(t => ({
                type: t.type === 'incoming' ? 'receive' : 'send',
                amount: (t.amount || 0) / 1000 / 1e8, // msats → BTC
                currency: 'BTC',
                memo: t.description || t.description_hash || '(sin descripción)',
                date: new Date((t.created_at || t.settled_at || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
                status: t.settled_at ? 'completed' : 'pending'
            })));
            return;
        } catch (e) {
            console.warn('[Wallet] list_transactions NWC falló:', e.message);
            container.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--color-text-secondary);">Tu wallet NWC no expone historial de transacciones.</div>';
            return;
        }
    }

    // Demo (Blink / WebLN)
    const demoTransactions = [
        {
            type: 'receive', amount: 0.00010000, currency: 'BTC',
            memo: 'Pago por servicio',
            date: new Date(Date.now() - 3600000).toISOString(), status: 'completed'
        },
        {
            type: 'send', amount: 0.00005000, currency: 'BTC',
            memo: 'Compra en LiberBit',
            date: new Date(Date.now() - 7200000).toISOString(), status: 'completed'
        }
    ];
    renderTransactions(container, demoTransactions);
}

function renderTransactions(container, txs) {
    if (!txs || !txs.length) {
        container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--color-text-secondary);"><p>No hay transacciones aún</p></div>';
        return;
    }
    container.innerHTML = txs.map(tx => `
        <div style="background: var(--color-bg-dark); padding: 1.25rem; border-radius: 12px; margin-bottom: 1rem; border-left: 4px solid ${tx.type === 'receive' ? 'var(--color-success)' : 'var(--color-gold)'};">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.5rem;">
                <div>
                    <div style="font-weight: 600; color: var(--color-text-primary); margin-bottom: 0.25rem;">
                        ${tx.type === 'receive' ? '📥 Recibido' : '📤 Enviado'}
                    </div>
                    <div style="font-size: 0.85rem; color: var(--color-text-secondary); word-break: break-word;">
                        ${_walletEscapeHtml(tx.memo || '')}
                    </div>
                </div>
                <div style="text-align: right; white-space: nowrap;">
                    <div style="font-weight: 700; color: ${tx.type === 'receive' ? 'var(--color-success)' : 'var(--color-text-primary)'};">
                        ${tx.type === 'receive' ? '+' : '-'}${Number(tx.amount).toFixed(8)} ${tx.currency}
                    </div>
                    <div style="font-size: 0.75rem; color: var(--color-text-secondary);">
                        ${timeAgo(new Date(tx.date).getTime())}
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}

// Helper defensivo (por si escape-utils.js no cargó aún)
function _walletEscapeHtml(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'
    })[c]);
}

// --------------------------------------------
// INITIALIZATION
// --------------------------------------------

async function initializeWallet() {
    const saved = localStorage.getItem('liberbit_wallet');
    if (!saved) return;

    try {
        const parsed = JSON.parse(saved);
        walletData = Object.assign(walletData, parsed);

        // Si quedó marcado como NWC, intenta restaurar la conexión NWC real.
        // [SEC-A1] tryRestore es async (puede pedir contraseña al usuario para
        // descifrar el secret NIP-49); por eso ahora hacemos await.
        if (walletData.type === 'nwc') {
            if (!window.LBW_NWC) {
                console.warn('[Wallet] NWC module no disponible al restaurar');
            } else {
                const restored = await window.LBW_NWC.tryRestore();
                if (!restored) {
                    console.warn('[Wallet] No se pudo restaurar NWC — desconectando');
                    walletData.connected = false;
                    walletData.type = null;
                    walletData.nwcSummary = null;
                    persistWallet();
                }
            }
        }

        if (walletData.connected) {
            showWalletConnected();
        }
    } catch (err) {
        console.warn('[Wallet] Error al restaurar estado:', err);
    }
}

// Hook al abrir la app de billetera
const originalOpenAppBilletera = openApp;
openApp = async function (appName) {
    await originalOpenAppBilletera(appName);
    if (appName === 'billetera') {
        initializeWallet();
    }
};

// Exposición selectiva en window (funciones no-top-level que el HTML llama por onclick)
window.showNwcModal = showNwcModal;
window.closeNwcModal = closeNwcModal;
window.submitNwcUri = submitNwcUri;
window.refreshNwcBalance = refreshNwcBalance;

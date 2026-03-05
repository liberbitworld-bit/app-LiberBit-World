// ============================================
// BLINK WALLET INTEGRATION
// ============================================

const BLINK_API = 'https://api.blink.sv/graphql';
let walletData = {
    connected: false,
    type: null, // 'blink' or 'webln'
    authToken: null,
    wallets: [],
    currentCurrency: 'BTC',
    balance: {
        BTC: 0,
        USD: 0
    }
};

// Connect to Blink Wallet
async function connectBlinkWallet() {
    try {
        showNotification('🏖️ Conectando con Blink Wallet...');
        
        // For demo purposes, we'll show a simplified flow
        // In production, you would implement OAuth or phone authentication
        const demoMode = confirm('¿Usar modo DEMO? (En producción usarías tu cuenta de Blink real)\n\nSí = Demo\nNo = Cancelar');
        
        if (!demoMode) {
            showNotification('ℹ️ Para usar Blink real, necesitas autenticarte con tu número de teléfono', 'info');
            return;
        }
        
        // Demo wallet data
        walletData.connected = true;
        walletData.type = 'blink';
        walletData.authToken = 'DEMO_TOKEN';
        walletData.balance.BTC = 0.00050000;
        walletData.balance.USD = 45.50;
        
        // Save to localStorage
        localStorage.setItem('liberbit_wallet', JSON.stringify(walletData));
        
        // Update UI
        showWalletConnected();
        showNotification('✅ Wallet conectada correctamente', 'success');
        
    } catch (err) {
        console.error('Error connecting Blink:', err);
        showNotification('Error al conectar wallet', 'error');
    }
}

// Connect to WebLN (Alby)
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
        const info = await window.webln.getInfo();
        
        walletData.connected = true;
        walletData.type = 'webln';
        walletData.balance.BTC = 0; // WebLN doesn't provide balance by default
        walletData.balance.USD = 0;
        
        localStorage.setItem('liberbit_wallet', JSON.stringify(walletData));
        
        showWalletConnected();
        showNotification('✅ Alby conectado correctamente', 'success');
        
    } catch (err) {
        console.error('Error connecting WebLN:', err);
        showNotification('Error al conectar Alby: ' + err.message, 'error');
    }
}

// Disconnect wallet
function disconnectWallet() {
    if (confirm('¿Desconectar billetera?')) {
        walletData = {
            connected: false,
            type: null,
            authToken: null,
            wallets: [],
            currentCurrency: 'BTC',
            balance: { BTC: 0, USD: 0 }
        };
        
        localStorage.removeItem('liberbit_wallet');
        showWalletDisconnected();
        showNotification('Wallet desconectada');
    }
}

// Switch currency display
function switchCurrency(currency) {
    walletData.currentCurrency = currency;
    
    // Update button states
    document.getElementById('currencyBTC').classList.toggle('active', currency === 'BTC');
    document.getElementById('currencyUSD').classList.toggle('active', currency === 'USD');
    
    // Update balance display
    updateBalanceDisplay();
}

// Update balance display
function updateBalanceDisplay() {
    const balanceDisplay = document.getElementById('balanceDisplay');
    const balanceUSDEquiv = document.getElementById('balanceUSDEquiv');
    
    if (walletData.currentCurrency === 'BTC') {
        balanceDisplay.textContent = walletData.balance.BTC.toFixed(8) + ' BTC';
        balanceUSDEquiv.textContent = '≈ $' + walletData.balance.USD.toFixed(2) + ' USD';
    } else {
        balanceDisplay.textContent = '$' + walletData.balance.USD.toFixed(2) + ' USD';
        balanceUSDEquiv.textContent = '≈ ' + walletData.balance.BTC.toFixed(8) + ' BTC';
    }
}

// Show wallet connected view
function showWalletConnected() {
    document.getElementById('walletDisconnected').style.display = 'none';
    document.getElementById('walletConnected').style.display = 'block';
    updateBalanceDisplay();
    loadTransactions();
}

// Show wallet disconnected view
function showWalletDisconnected() {
    document.getElementById('walletDisconnected').style.display = 'block';
    document.getElementById('walletConnected').style.display = 'none';
}

// Show receive modal
function showReceiveModal() {
    document.getElementById('receiveModal').style.display = 'flex';
    document.getElementById('receiveModal').classList.add('active');
}

// Close receive modal
function closeReceiveModal() {
    document.getElementById('receiveModal').style.display = 'none';
    document.getElementById('receiveModal').classList.remove('active');
    document.getElementById('invoiceDisplay').style.display = 'none';
}

// Generate Lightning invoice via LNURLP (Alby) + WebLN fallback
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

        let invoiceStr = null;

        // ── Vía 1: WebLN (Alby, Zeus, etc. instalado en navegador) ─────────
        if (window.webln) {
            try {
                await window.webln.enable();
                const amountSats = currency === 'BTC'
                    ? Math.round(amount * 100000000)
                    : Math.round(amount * 10000); // EUR ≈ sats rough estimate
                const inv = await window.webln.makeInvoice({ amount: amountSats, defaultMemo: memo });
                invoiceStr = inv.paymentRequest;
            } catch (weblnErr) {
                console.warn('[Wallet] WebLN fallback:', weblnErr.message);
            }
        }

        // ── Vía 2: LNURLP endpoint propio (Alby address) ───────────────────
        if (!invoiceStr) {
            // Convertir importe a millisats
            const amountMsats = currency === 'BTC'
                ? Math.round(amount * 100000000 * 1000)  // BTC -> msats
                : Math.round(amount * 10000 * 1000);     // EUR -> msats (1 EUR ≈ 10k sats aprox)

            // 1) Obtener metadata LNURLP
            const metaRes = await fetch('/.well-known/lnurlp/aportaciones');
            if (!metaRes.ok) throw new Error('LNURLP metadata no disponible (' + metaRes.status + ')');
            const meta = await metaRes.json();

            if (amountMsats < (meta.minSendable || 1000)) {
                showNotification('Importe mínimo: ' + ((meta.minSendable || 1000) / 1000) + ' sats', 'error');
                return;
            }
            if (meta.maxSendable && amountMsats > meta.maxSendable) {
                showNotification('Importe máximo superado.', 'error');
                return;
            }

            // 2) Pedir invoice al callback
            const callbackUrl = meta.callback + '?amount=' + amountMsats +
                '&comment=' + encodeURIComponent(memo.substring(0, 144));
            const cbRes = await fetch(callbackUrl);
            if (!cbRes.ok) throw new Error('Error del callback LNURLP (' + cbRes.status + ')');
            const cbData = await cbRes.json();

            if (cbData.status === 'ERROR') throw new Error(cbData.reason || 'Error LNURLP');
            invoiceStr = cbData.pr;
        }

        if (!invoiceStr) throw new Error('No se pudo generar invoice.');

        // ── Mostrar invoice y QR ────────────────────────────────────────────
        document.getElementById('invoiceText').textContent = invoiceStr;
        document.getElementById('invoiceDisplay').style.display = 'block';

        // QR real usando qrcodejs (ya cargado en index.html)
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

    } catch (err) {
        console.error('Error generating invoice:', err);
        showNotification('Error al generar invoice: ' + err.message, 'error');
    }
}

// Copy invoice to clipboard
function copyInvoice() {
    const invoiceText = document.getElementById('invoiceText').textContent;
    navigator.clipboard.writeText(invoiceText).then(() => {
        showNotification('✅ Invoice copiado al portapapeles', 'success');
    });
}

// Show send modal
function showSendModal() {
    document.getElementById('sendModal').style.display = 'flex';
    document.getElementById('sendModal').classList.add('active');
}

// Close send modal
function closeSendModal() {
    document.getElementById('sendModal').style.display = 'none';
    document.getElementById('sendModal').classList.remove('active');
}

// Send payment
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
        
        if (!confirm('¿Confirmar envío de pago?')) {
            return;
        }
        
        showNotification('Enviando pago...');
        
        // In production, call Blink API or WebLN here
        if (walletData.type === 'webln' && window.webln) {
            const response = await window.webln.sendPayment(invoice);
            showNotification('✅ Pago enviado correctamente', 'success');
        } else {
            // Demo mode
            await new Promise(resolve => setTimeout(resolve, 1500));
            showNotification('✅ Pago enviado (DEMO)', 'success');
        }
        
        closeSendModal();
        loadTransactions();
        
    } catch (err) {
        console.error('Error sending payment:', err);
        showNotification('Error al enviar pago: ' + err.message, 'error');
    }
}

// Show cashback modal
function showCashbackModal() {
    document.getElementById('cashbackModal').style.display = 'flex';
    document.getElementById('cashbackModal').classList.add('active');
}

// Close cashback modal
function closeCashbackModal() {
    document.getElementById('cashbackModal').style.display = 'none';
    document.getElementById('cashbackModal').classList.remove('active');
}

// Load transactions
function loadTransactions() {
    const container = document.getElementById('transactionsList');
    
    // Demo transactions
    const demoTransactions = [
        {
            type: 'receive',
            amount: 0.00010000,
            currency: 'BTC',
            memo: 'Pago por servicio',
            date: new Date(Date.now() - 3600000).toISOString(),
            status: 'completed'
        },
        {
            type: 'send',
            amount: 0.00005000,
            currency: 'BTC',
            memo: 'Compra en LiberBit',
            date: new Date(Date.now() - 7200000).toISOString(),
            status: 'completed'
        }
    ];
    
    if (demoTransactions.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--color-text-secondary);"><p>No hay transacciones aún</p></div>';
        return;
    }
    
    container.innerHTML = demoTransactions.map(tx => `
        <div style="background: var(--color-bg-dark); padding: 1.25rem; border-radius: 12px; margin-bottom: 1rem; border-left: 4px solid ${tx.type === 'receive' ? 'var(--color-success)' : 'var(--color-gold)'};">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.5rem;">
                <div>
                    <div style="font-weight: 600; color: var(--color-text-primary); margin-bottom: 0.25rem;">
                        ${tx.type === 'receive' ? '📥 Recibido' : '📤 Enviado'}
                    </div>
                    <div style="font-size: 0.85rem; color: var(--color-text-secondary);">
                        ${tx.memo}
                    </div>
                </div>
                <div style="text-align: right;">
                    <div style="font-weight: 700; color: ${tx.type === 'receive' ? 'var(--color-success)' : 'var(--color-text-primary)'};">
                        ${tx.type === 'receive' ? '+' : '-'}${tx.amount.toFixed(8)} ${tx.currency}
                    </div>
                    <div style="font-size: 0.75rem; color: var(--color-text-secondary);">
                        ${timeAgo(new Date(tx.date).getTime())}
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}

// Initialize wallet on page load
function initializeWallet() {
    const saved = localStorage.getItem('liberbit_wallet');
    if (saved) {
        walletData = JSON.parse(saved);
        if (walletData.connected) {
            showWalletConnected();
        }
    }
}

// Call initialize when opening billetera
const originalOpenAppBilletera = openApp;
openApp = async function(appName) {
    await originalOpenAppBilletera(appName);
    if (appName === 'billetera') {
        initializeWallet();
    }
};

// ========== MARKETPLACE PAY — Phase 2 ==========
// LBW_MarketPay: gestiona pagos Lightning en el marketplace
// Flujo: lud16 (kind-0) → LNURLP → invoice → WebLN/QR → confirmación → LBWM
// Dependencias: LBW_Nostr, LBW_Merits (nostr-merits.js), supabaseClient

(function () {
    'use strict';

    const PROXY_BASE = '/api/lnurlp';

    // ── Resolución de Lightning address ──────────────────────
    // Obtiene lud16 del perfil Nostr kind-0 del vendedor
    async function getLud16(pubkey) {
        // 1. Intentar desde el perfil local si es el propio usuario
        if (pubkey === LBW_Nostr.getPubkey()) {
            const p = LBW_Nostr.getProfile();
            if (p && p.lud16) return p.lud16;
        }
        // 2. Intentar desde caché IndexedDB (LBW_Store)
        try {
            const cached = await LBW_Store.getProfile(pubkey);
            if (cached && cached.lud16) return cached.lud16;
        } catch (e) {}
        // 3. Fetch desde relay Nostr
        try {
            const profile = await LBW_Nostr.fetchUserProfile(pubkey);
            if (profile && profile.lud16) return profile.lud16;
        } catch (e) {}
        return null;
    }

    // ── Resolver LNURLP metadata (via proxy CORS) ─────────────
    async function resolveLnurlp(lud16) {
        const url = `${PROXY_BASE}/resolve?address=${encodeURIComponent(lud16)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`No se pudo resolver la Lightning address (${res.status})`);
        const data = await res.json();
        if (data.status === 'ERROR') throw new Error(data.reason || 'Error LNURLP');
        if (!data.callback)         throw new Error('Lightning address no válida (sin callback)');
        return data; // { callback, minSendable, maxSendable, metadata, ... }
    }

    // ── Pedir invoice al callback ──────────────────────────────
    async function requestInvoice(lnurlData, amountSats, comment) {
        const amountMsats = amountSats * 1000;
        if (amountMsats < (lnurlData.minSendable || 1000)) {
            throw new Error(`Importe mínimo: ${Math.ceil((lnurlData.minSendable || 1000) / 1000)} sats`);
        }
        if (lnurlData.maxSendable && amountMsats > lnurlData.maxSendable) {
            throw new Error(`Importe máximo: ${Math.floor(lnurlData.maxSendable / 1000)} sats`);
        }

        // Usar proxy para evitar CORS
        const callback  = encodeURIComponent(lnurlData.callback);
        const url = `${PROXY_BASE}/resolve?callback=${callback}&amount=${amountMsats}` +
            (comment ? `&comment=${encodeURIComponent(comment.substring(0, 144))}` : '');

        const res = await fetch(url);
        if (!res.ok) throw new Error(`Error al pedir invoice (${res.status})`);
        const data = await res.json();
        if (data.status === 'ERROR') throw new Error(data.reason || 'Error en callback LNURLP');
        if (!data.pr) throw new Error('El servidor no devolvió invoice');
        return data.pr; // bolt11 string
    }

    // ── Generar QR en un contenedor ───────────────────────────
    function renderQR(containerId, bolt11) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        if (typeof QRCode !== 'undefined') {
            new QRCode(container, {
                text: 'lightning:' + bolt11.toLowerCase(),
                width: 200, height: 200,
                colorDark: '#0d171e', colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
        } else {
            container.innerHTML = '<p style="color:var(--color-text-secondary);font-size:0.8rem;text-align:center;">QR no disponible</p>';
        }
    }

    // ── Confirmar pago y ejecutar acciones post-pago ──────────
    async function confirmPayment(listing, bolt11, paymentHash) {
        const buyerPubkey  = LBW_Nostr.getPubkey();
        const sellerPubkey = listing.pubkey;
        const isSelf = buyerPubkey === sellerPubkey;

        // 1. Actualizar estado del listing a "sold" en Nostr
        try {
            await LBW_Nostr.publishMarketplaceListing({
                dTag:        listing.dTag,
                title:       listing.title,
                description: listing.description,
                category:    listing.category,
                price:       listing.price,
                currency:    listing.currency || 'sats',
                emoji:       listing.emoji,
                status:      'sold',
                mediaTags:   []
            });
            console.log('[MarketPay] ✅ Listing marcado como vendido en Nostr');
        } catch (e) {
            console.warn('[MarketPay] ⚠️ No se pudo actualizar estado Nostr:', e.message);
        }

        // 2. Guardar en Supabase (tabla lightning_payments)
        try {
            const payRecord = {
                id:            crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
                buyer_pubkey:  LBW_Nostr.pubkeyToNpub(buyerPubkey),
                seller_pubkey: LBW_Nostr.pubkeyToNpub(sellerPubkey),
                listing_id:    listing.id || listing.dTag || '',
                listing_title: listing.title || '',
                amount_sats:   parseInt(listing.price) || 0,
                currency:      listing.currency || 'sats',
                payment_hash:  paymentHash || '',
                bolt11:        bolt11 || '',
                status:        'completed',
                created_at:    new Date().toISOString()
            };
            await supabaseClient.from('lightning_payments').insert([payRecord]);
            console.log('[MarketPay] ✅ Pago registrado en Supabase');
        } catch (e) {
            console.warn('[MarketPay] ⚠️ No se pudo guardar en Supabase:', e.message);
        }

        // 3. LBWM: primera venta → +5 al vendedor (solo si no es autopago)
        if (!isSelf && typeof LBW_Merits !== 'undefined') {
            try {
                await LBW_Merits.awardMarketplaceMerit(sellerPubkey, listing, paymentHash);
            } catch (e) {
                console.warn('[MarketPay] ⚠️ Merit award:', e.message);
            }
        }

        // 4. Refrescar el grid del marketplace
        if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.refreshMarketplace) {
            LBW_NostrBridge.refreshMarketplace();
        }
    }

    // ── Modal de pago ─────────────────────────────────────────
    function _removeModal() {
        document.getElementById('lbwPayModal')?.remove();
    }

    function _buildModal(listing, bolt11, lud16, sellerName) {
        _removeModal();
        const amountDisplay = listing.price && listing.price !== 'A negociar'
            ? `${listing.price} ${listing.currency === 'sats' ? '⚡ sats' : listing.currency}`
            : 'Precio libre';

        const modal = document.createElement('div');
        modal.id = 'lbwPayModal';
        modal.className = 'modal active';
        modal.innerHTML = `
            <div class="modal-content" style="position:relative;max-width:480px;">
                <button class="modal-close" onclick="document.getElementById('lbwPayModal').remove()">×</button>
                <div class="modal-header">
                    <h3 style="color:var(--color-gold);margin-bottom:0.25rem;">⚡ Pagar con Lightning</h3>
                    <p style="color:var(--color-text-secondary);font-size:0.85rem;margin:0;">${_esc(listing.title)}</p>
                </div>
                <div class="modal-body">
                    <!-- Info vendedor + importe -->
                    <div style="display:flex;justify-content:space-between;align-items:center;background:var(--color-bg-dark);padding:1rem;border-radius:12px;margin-bottom:1.25rem;">
                        <div>
                            <div style="font-size:0.75rem;color:var(--color-text-secondary);">Vendedor</div>
                            <div style="font-weight:600;color:var(--color-text-primary);">${_esc(sellerName)}</div>
                            <div style="font-size:0.7rem;color:var(--color-text-secondary);font-family:var(--font-mono);">${_esc(lud16)}</div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:0.75rem;color:var(--color-text-secondary);">Importe</div>
                            <div style="font-size:1.4rem;font-weight:800;color:var(--color-gold);">${_esc(amountDisplay)}</div>
                        </div>
                    </div>

                    <!-- QR -->
                    <div style="display:flex;justify-content:center;margin-bottom:1rem;">
                        <div id="lbwPayQR" style="background:#fff;padding:0.75rem;border-radius:12px;display:inline-block;"></div>
                    </div>

                    <!-- Invoice text -->
                    <div style="background:var(--color-bg-dark);border-radius:8px;padding:0.75rem;margin-bottom:1rem;position:relative;">
                        <div id="lbwPayBolt11" style="font-family:var(--font-mono);font-size:0.65rem;color:var(--color-text-secondary);word-break:break-all;max-height:60px;overflow:hidden;">${_esc(bolt11)}</div>
                    </div>

                    <!-- Botones de acción -->
                    <div style="display:flex;flex-direction:column;gap:0.6rem;">
                        <!-- WebLN (Alby) si disponible -->
                        <div id="lbwWeblnBtn" style="display:none;">
                            <button class="btn btn-primary" style="width:100%;" onclick="LBW_MarketPay._payWithWebln()">
                                ⚡ Pagar con Alby
                            </button>
                        </div>
                        <!-- Deep link wallet móvil -->
                        <a href="lightning:${bolt11}" class="btn btn-secondary" style="width:100%;text-align:center;text-decoration:none;display:block;">
                            📱 Abrir en wallet
                        </a>
                        <!-- Copiar invoice -->
                        <button class="btn btn-secondary" style="width:100%;" onclick="
                            navigator.clipboard.writeText('${bolt11}');
                            this.textContent='✅ Copiado';
                            setTimeout(()=>this.textContent='📋 Copiar invoice',2000);
                        ">📋 Copiar invoice</button>
                        <!-- Confirmar pago manual -->
                        <div style="border-top:1px solid var(--color-border);padding-top:0.75rem;margin-top:0.25rem;">
                            <p style="font-size:0.75rem;color:var(--color-text-secondary);text-align:center;margin-bottom:0.5rem;">¿Ya has pagado desde tu wallet?</p>
                            <button class="btn btn-primary" style="width:100%;background:rgba(76,175,80,0.2);border-color:#4CAF50;color:#4CAF50;" 
                                onclick="LBW_MarketPay._manualConfirm()">
                                ✅ Confirmar pago realizado
                            </button>
                        </div>
                    </div>

                    <p style="font-size:0.7rem;color:var(--color-text-secondary);text-align:center;margin-top:1rem;">
                        El pago va directo al vendedor · LiberBit no toca los fondos
                    </p>
                </div>
            </div>`;

        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) _removeModal(); });

        // Render QR
        renderQR('lbwPayQR', bolt11);

        // Mostrar botón WebLN si Alby disponible
        if (window.webln) {
            document.getElementById('lbwWeblnBtn').style.display = 'block';
        }
    }

    // Helper escape
    function _esc(str) {
        return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    // Estado temporal del pago activo
    let _activeListing = null, _activeBolt11 = null;

    // ── Pagar con WebLN ───────────────────────────────────────
    async function _payWithWebln() {
        if (!window.webln || !_activeBolt11) return;
        const btn = document.querySelector('#lbwWeblnBtn button');
        try {
            if (btn) { btn.disabled = true; btn.textContent = '⏳ Pagando...'; }
            await window.webln.enable();
            const result = await window.webln.sendPayment(_activeBolt11);
            const hash = result?.paymentHash || '';
            _removeModal();
            showNotification('✅ Pago enviado con Alby', 'success');
            if (_activeListing) await confirmPayment(_activeListing, _activeBolt11, hash);
        } catch (e) {
            showNotification('❌ ' + e.message, 'error');
            if (btn) { btn.disabled = false; btn.textContent = '⚡ Pagar con Alby'; }
        }
    }

    // ── Confirmación manual ───────────────────────────────────
    async function _manualConfirm() {
        if (!_activeListing) return;
        if (!confirm('¿Confirmas que has enviado el pago?\n\nSolo confirma si realmente has pagado. Las acciones post-pago (estado del listing y méritos) se registrarán ahora.')) return;
        _removeModal();
        showNotification('✅ Pago confirmado', 'success');
        await confirmPayment(_activeListing, _activeBolt11, '');
    }

    // ── Punto de entrada principal ────────────────────────────
    // Llamado desde el botón ⚡ Comprar en la card del marketplace
    async function resolveAndPay(listing, sellerName) {
        if (!LBW_Nostr.isLoggedIn()) {
            showNotification('Inicia sesión para comprar', 'error'); return;
        }
        if (listing.pubkey === LBW_Nostr.getPubkey()) {
            showNotification('No puedes comprarte a ti mismo', 'error'); return;
        }
        if (!listing.price || listing.price === 'A negociar' || isNaN(parseInt(listing.price))) {
            showNotification('Este listing no tiene precio fijo. Contacta al vendedor.', 'info');
            if (typeof LBW_NostrBridge !== 'undefined') LBW_NostrBridge.startDMWith(listing.pubkey);
            return;
        }

        showNotification('⚡ Resolviendo Lightning address...', 'info');

        try {
            // 1. Obtener lud16 del vendedor
            const lud16 = await getLud16(listing.pubkey);
            if (!lud16) {
                showNotification('El vendedor no tiene Lightning address configurada.', 'error');
                return;
            }

            // 2. Resolver LNURLP
            const lnurlData = await resolveLnurlp(lud16);

            // 3. Pedir invoice
            const amountSats = parseInt(listing.price);
            const comment    = `Pago por: ${listing.title} (LiberBit World)`;
            const bolt11     = await requestInvoice(lnurlData, amountSats, comment);

            // 4. Guardar estado activo
            _activeListing = listing;
            _activeBolt11  = bolt11;

            // 5. Mostrar modal con QR + opciones
            _buildModal(listing, bolt11, lud16, sellerName);

        } catch (err) {
            console.error('[MarketPay] Error:', err);
            showNotification('❌ ' + err.message, 'error');
        }
    }

    // ── API pública ───────────────────────────────────────────
    window.LBW_MarketPay = {
        resolveAndPay,
        confirmPayment,
        getLud16,
        _payWithWebln,
        _manualConfirm
    };

    console.log('✅ LBW_MarketPay (Phase 2) listo');
})();

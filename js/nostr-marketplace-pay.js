// ========== MARKETPLACE PAY — Phase 2 ==========
// LBW_MarketPay: gestiona pagos Lightning en el marketplace
// Flujo: lud16 (kind-0) → LNURLP → invoice → WebLN/QR → confirmación → LBWM
// Dependencias: LBW_Nostr, LBW_Merits (nostr-merits.js), supabaseClient

(function () {
    'use strict';

    const PROXY_BASE = '/api/lnurlp';

    // [SEC-10] Whitelist de monedas que el marketplace acepta. Cualquier
    // listing con `currency` fuera de esta lista será rechazado antes de
    // generar invoice — preferimos abortar el pago a cobrar mal.
    const SUPPORTED_CURRENCIES = ['sats', 'BTC', 'EUR', 'USD'];

    const SATS_PER_BTC = 100000000;

    // [SEC-10] Cache del tipo de cambio BTC. Mismo patrón que el que ya usa
    // p2p-exchange.js (Coingecko, TTL 5 min). No reutilizamos directamente
    // su función porque vive dentro de un IIFE privado y queremos mantener
    // este parche aislado en un solo archivo.
    let _btcRate = null;          // { eur: number, usd: number, fetchedAt: number }
    const RATE_TTL_MS = 5 * 60 * 1000;
    const RATE_FETCH_TIMEOUT_MS = 5000;

    async function _fetchBtcRate() {
        if (_btcRate && (Date.now() - _btcRate.fetchedAt) < RATE_TTL_MS) {
            return _btcRate;
        }
        try {
            const res = await fetch(
                'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur,usd',
                { signal: AbortSignal.timeout(RATE_FETCH_TIMEOUT_MS) }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data || !data.bitcoin || typeof data.bitcoin.eur !== 'number' || typeof data.bitcoin.usd !== 'number') {
                throw new Error('respuesta inválida del proveedor de precios');
            }
            _btcRate = {
                eur: data.bitcoin.eur,
                usd: data.bitcoin.usd,
                fetchedAt: Date.now()
            };
            console.log('[MarketPay] 💰 BTC rate:', _btcRate);
            return _btcRate;
        } catch (e) {
            console.warn('[MarketPay] ⚠️ No se pudo obtener tipo de cambio BTC:', e.message);
            // Si tenemos cache aunque sea viejo, lo devolvemos como fallback
            // para no bloquear pagos por una caída momentánea de Coingecko.
            // Si NO hay cache en absoluto, el caller decidirá abortar.
            if (_btcRate) return _btcRate;
            return null;
        }
    }

    // [SEC-10] Convierte el precio del listing a sats teniendo en cuenta la
    // moneda. Devuelve un objeto con la cantidad final en sats, una etiqueta
    // legible del precio original y, si hubo conversión vía tipo de cambio,
    // una nota con el rate aplicado para que el usuario pueda auditarla.
    //
    // Lanza Error si:
    //   - El listing no tiene precio fijo o el precio no es numérico.
    //   - La moneda no está en la whitelist.
    //   - Hace falta un tipo de cambio y Coingecko falla sin cache previa.
    //
    // Esto es CRÍTICO: el bug original (SEC-10) era hacer
    //     parseInt(listing.price)
    // sin mirar `currency`, lo que convertía "100 EUR" en 100 sats (€0.07).
    async function _convertToSats(listing) {
        if (!listing || listing.price == null || listing.price === 'A negociar') {
            throw new Error('Listing sin precio fijo');
        }

        const rawPrice = String(listing.price).replace(',', '.').trim();
        const numericPrice = Number(rawPrice);
        if (!isFinite(numericPrice) || numericPrice <= 0) {
            throw new Error('Precio inválido en el listing');
        }

        const currency = listing.currency || 'sats';
        if (!SUPPORTED_CURRENCIES.includes(currency)) {
            throw new Error(`Moneda no soportada: ${currency}`);
        }

        // Caso 1: ya está en sats. Conversión directa, sin red.
        if (currency === 'sats') {
            const sats = Math.round(numericPrice);
            if (sats < 1) throw new Error('Importe en sats demasiado bajo');
            return {
                sats,
                originalDisplay: `${sats.toLocaleString('es-ES')} sats`,
                fxNote: null,
                rateUsed: null,
                originalCurrency: 'sats',
                originalAmount: numericPrice
            };
        }

        // Caso 2: BTC. Conversión directa por la constante, sin red.
        if (currency === 'BTC') {
            const sats = Math.round(numericPrice * SATS_PER_BTC);
            if (sats < 1) throw new Error('Importe en BTC demasiado bajo');
            return {
                sats,
                originalDisplay: `${numericPrice} BTC`,
                fxNote: null,
                rateUsed: null,
                originalCurrency: 'BTC',
                originalAmount: numericPrice
            };
        }

        // Caso 3: fiat (EUR o USD). Necesitamos tipo de cambio.
        const rate = await _fetchBtcRate();
        if (!rate) {
            throw new Error(
                'No se pudo obtener el tipo de cambio BTC. ' +
                'Inténtalo de nuevo en unos segundos.'
            );
        }
        const fxKey = currency.toLowerCase(); // 'eur' | 'usd'
        const btcPrice = rate[fxKey];
        if (!btcPrice || !isFinite(btcPrice) || btcPrice <= 0) {
            throw new Error(`Tipo de cambio BTC/${currency} inválido`);
        }

        // numericPrice está en fiat (ej. 100 EUR).
        // btcPrice es el precio de 1 BTC en esa fiat (ej. 40800 EUR/BTC).
        // sats = (fiat / btcPrice) * SATS_PER_BTC.
        const sats = Math.round((numericPrice / btcPrice) * SATS_PER_BTC);
        if (sats < 1) throw new Error('Importe convertido demasiado bajo');

        const symbol = currency === 'EUR' ? '€' : '$';
        return {
            sats,
            originalDisplay: `${symbol}${numericPrice.toLocaleString('es-ES')} ${currency}`,
            fxNote: `1 BTC ≈ ${symbol}${btcPrice.toLocaleString('es-ES')} ${currency} · Coingecko`,
            rateUsed: btcPrice,
            originalCurrency: currency,
            originalAmount: numericPrice
        };
    }

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
    async function confirmPayment(listing, bolt11, paymentHash, conversion) {
        const buyerPubkey  = LBW_Nostr.getPubkey();
        const sellerPubkey = listing.pubkey;
        const isSelf = buyerPubkey === sellerPubkey;

        // [SEC-10] Si nos llaman sin la info de conversión (caso raro: caller
        // externo a través de window.LBW_MarketPay.confirmPayment), intentamos
        // reconstruirla. Si falla (p.ej. EUR sin Coingecko), NO usamos
        // parseInt(listing.price) — eso era exactamente el bug. Guardamos 0
        // sats con un warning, mejor un registro incompleto que un registro
        // mentiroso.
        let conv = conversion;
        if (!conv) {
            try {
                conv = await _convertToSats(listing);
            } catch (e) {
                console.warn(
                    '[MarketPay] [SEC-10] No hay info de conversión y no se pudo recalcular: ' +
                    e.message + '. amount_sats se registrará como 0.'
                );
                conv = {
                    sats: 0,
                    originalCurrency: listing.currency || 'sats',
                    originalAmount: Number(listing.price) || 0,
                    rateUsed: null
                };
            }
        }

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
                // [SEC-10] amount_sats ahora son los sats REALES pagados,
                // no parseInt(listing.price). Para una oferta de 100 EUR,
                // antes guardaba 100 (mintiendo "100 sats"); ahora guarda
                // los ~245.000 sats que efectivamente cobró el LNURLP.
                amount_sats:   conv.sats || 0,
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

        // 5. Ofrecer reseña post-pago (solo si no es autopago y el módulo está cargado)
        if (!isSelf && typeof LBW_Reviews !== 'undefined') {
            setTimeout(async () => {
                try {
                    // Comprador reseña al vendedor
                    if (!LBW_Reviews.hasReviewed(listing, buyerPubkey)) {
                        const sellerName = await LBW_NostrBridge.resolveName(sellerPubkey);
                        LBW_Reviews.showReviewModal({
                            listing,
                            reviewedPubkey: sellerPubkey,
                            reviewedName:   sellerName,
                            role:           'buyer'
                        });
                    }
                } catch (e) {
                    console.warn('[MarketPay] Review prompt error:', e.message);
                }
            }, 1500); // pequeño delay para que el usuario vea la confirmación primero
        }
    }

    // ── Modal de pago ─────────────────────────────────────────
    function _removeModal() {
        document.getElementById('lbwPayModal')?.remove();
    }

    // Valida que un bolt11 contiene solo caracteres bech32 (lnbc + dígitos + letras a-z).
    // El callback LNURLP del seller es controlado por un servidor externo y podría devolver
    // un 'pr' con caracteres que rompan los inline handlers de pago (href="lightning:...",
    // onclick="...writeText('...')..."). Validamos antes de inyectar nada al DOM.
    function _isValidBolt11(s) {
        return typeof s === 'string'
            && s.length >= 10 && s.length <= 4096
            && /^lnbc[0-9a-z]+$/i.test(s);
    }

    function _buildModal(listing, bolt11, lud16, sellerName, conversion) {
        _removeModal();

        // [SEC-A5] Defensa contra bolt11 malicioso del LNURLP callback.
        if (!_isValidBolt11(bolt11)) {
            console.error('[MarketPay] bolt11 rechazado, formato inválido');
            if (typeof showNotification === 'function') {
                showNotification('Invoice del vendedor con formato inválido. Pago abortado.', 'error');
            } else {
                alert('Invoice del vendedor con formato inválido. Pago abortado.');
            }
            return;
        }
        // Normalizamos a lowercase (BOLT11 es bech32, lowercase canónico).
        bolt11 = bolt11.toLowerCase();

        // [SEC-10] Desglose de conversión:
        //   - Línea principal grande: lo que el comprador ve en la card
        //     (precio en su moneda original).
        //   - Línea secundaria: los sats reales que va a pagar.
        //   - Si hubo conversión vía Coingecko, una tercera línea con el
        //     rate aplicado, para que el comprador pueda auditarlo antes
        //     de aprobar el pago.
        const conv = conversion || {
            sats: 0,
            originalDisplay: 'Precio libre',
            fxNote: null
        };
        const satsDisplay = `${conv.sats.toLocaleString('es-ES')} sats`;
        const showFxLine = !!conv.fxNote && conv.originalCurrency !== 'sats';
        const showOriginalSeparately = conv.originalCurrency && conv.originalCurrency !== 'sats';

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
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;background:var(--color-bg-dark);padding:1rem;border-radius:12px;margin-bottom:1.25rem;">
                        <div>
                            <div style="font-size:0.75rem;color:var(--color-text-secondary);">Vendedor</div>
                            <div style="font-weight:600;color:var(--color-text-primary);">${_esc(sellerName)}</div>
                            <div style="font-size:0.7rem;color:var(--color-text-secondary);font-family:var(--font-mono);">${_esc(lud16)}</div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:0.75rem;color:var(--color-text-secondary);">${showOriginalSeparately ? 'Precio del listing' : 'Importe'}</div>
                            <div style="font-size:1.4rem;font-weight:800;color:var(--color-gold);">${_esc(conv.originalDisplay)}</div>
                            ${showOriginalSeparately ? `
                                <div style="font-size:0.7rem;color:var(--color-text-secondary);margin-top:0.4rem;">Pagas en Lightning</div>
                                <div style="font-size:1rem;font-weight:700;color:var(--color-text-primary);font-family:var(--font-mono);">${_esc(satsDisplay)}</div>
                            ` : ''}
                            ${showFxLine ? `
                                <div style="font-size:0.65rem;color:var(--color-text-secondary);margin-top:0.4rem;font-style:italic;">${_esc(conv.fxNote)}</div>
                            ` : ''}
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
    // SEC-27: Unified with LBW.escapeHtml (canonical in escape-utils.js)
    const _esc = (typeof LBW !== 'undefined' && LBW.escapeHtml) ? LBW.escapeHtml : function (str) {
        return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    };

    // Estado temporal del pago activo
    let _activeListing = null, _activeBolt11 = null, _activeConversion = null;

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
            if (_activeListing) await confirmPayment(_activeListing, _activeBolt11, hash, _activeConversion);
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
        await confirmPayment(_activeListing, _activeBolt11, '', _activeConversion);
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
        if (!listing.price || listing.price === 'A negociar') {
            showNotification('Este listing no tiene precio fijo. Contacta al vendedor.', 'info');
            if (typeof LBW_NostrBridge !== 'undefined') LBW_NostrBridge.startDMWith(listing.pubkey);
            return;
        }

        showNotification('⚡ Resolviendo Lightning address...', 'info');

        try {
            // [SEC-10] Convertir el precio a sats teniendo en cuenta currency.
            // Esto va PRIMERO, antes incluso de tocar la red para resolver el
            // lud16. Si el precio es inválido o no podemos calcular el cambio,
            // abortamos limpiamente sin haber molestado al proveedor LNURLP.
            //
            // ANTES (bug SEC-10):
            //   const amountSats = parseInt(listing.price);
            // Esto cobraba "100" sats por una oferta de "100 EUR" → €0.07.
            let conversion;
            try {
                conversion = await _convertToSats(listing);
            } catch (convErr) {
                showNotification('❌ ' + convErr.message, 'error');
                return;
            }
            const amountSats = conversion.sats;

            // 1. Obtener lud16 del vendedor
            const lud16 = await getLud16(listing.pubkey);
            if (!lud16) {
                showNotification('El vendedor no tiene Lightning address configurada.', 'error');
                return;
            }

            // 2. Resolver LNURLP
            const lnurlData = await resolveLnurlp(lud16);

            // 3. Pedir invoice (en sats reales convertidos)
            const comment = `Pago por: ${listing.title} (LiberBit World)`;
            const bolt11  = await requestInvoice(lnurlData, amountSats, comment);

            // 4. Guardar estado activo (incluida la info de conversión para
            //    confirmPayment y para el modal).
            _activeListing    = listing;
            _activeBolt11     = bolt11;
            _activeConversion = conversion;

            // 5. Mostrar modal con QR + opciones + desglose de conversión
            _buildModal(listing, bolt11, lud16, sellerName, conversion);

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

// ========== NIP-15 STALLS — kind:30017 (Tienda) + kind:30018 (Producto) ==========
// Arquitectura: tiendas permanentes de vendedores dentro del marketplace LBW.
// Cada usuario puede tener UNA tienda (d-tag único por pubkey).
// Los productos se enlazan a la tienda via a-tag: "30017:<pubkey>:<stallDTag>"
//
// Dependencias: LBW_Nostr, LBW_Store, LBW_Media (opcional)
// =================================================================================

(function () {
    'use strict';

    const KIND_STALL   = 30017;
    const KIND_PRODUCT = 30018;
    const LBW_TAG      = 'liberbit-market';

    // ── Estado en memoria ─────────────────────────────────────
    let _stalls   = [];   // [{id, pubkey, dTag, name, description, currency, shipping, created_at}]
    let _products = {};   // { stallKey: [{...product}] }   stallKey = "30017:pubkey:dTag"
    let _subStall   = null;
    let _subProduct = null;

    // ── Helpers ───────────────────────────────────────────────
    // SEC-27: Unified with LBW.escapeHtml (canonical in escape-utils.js)
    // Previous version was missing `'` escape — now fully covered.
    // [M-10] LBW.escapeHtml siempre disponible (escape-utils.js carga primero en index.html).
    const _esc = LBW.escapeHtml;

    function _stallKey(pubkey, dTag) {
        return `30017:${pubkey}:${dTag}`;
    }

    function _parseStall(event) {
        try {
            const data = JSON.parse(event.content || '{}');
            const dTag = (event.tags.find(t => t[0] === 'd') || [])[1] || '';
            return {
                id:          event.id,
                pubkey:      event.pubkey,
                dTag,
                stallKey:    _stallKey(event.pubkey, dTag),
                name:        data.name        || 'Mi Tienda',
                description: data.description || '',
                currency:    data.currency    || 'sat',
                shipping:    Array.isArray(data.shipping) ? data.shipping : [],
                created_at:  event.created_at,
                _raw:        event
            };
        } catch (e) {
            console.warn('[Stalls] Error parseando stall:', e);
            return null;
        }
    }

    function _parseProduct(event) {
        try {
            const data = JSON.parse(event.content || '{}');
            const dTag = (event.tags.find(t => t[0] === 'd') || [])[1] || event.id;
            const aTag = (event.tags.find(t => t[0] === 'a') || [])[1] || '';
            // images: NIP-15 usa array "images" en content; fallback a tags image/thumb
            let images = Array.isArray(data.images) ? data.images : [];
            if (images.length === 0) {
                (event.tags || []).forEach(t => {
                    if ((t[0] === 'image' || t[0] === 'thumb') && t[1] && !images.includes(t[1])) {
                        images.push(t[1]);
                    }
                });
            }
            return {
                id:          event.id,
                pubkey:      event.pubkey,
                dTag,
                stallKey:    aTag,        // "30017:pubkey:stallDTag"
                name:        data.name        || 'Producto',
                description: data.description || '',
                images,
                price:       data.price  != null ? data.price  : 'A negociar',
                currency:    data.currency    || 'sat',
                quantity:    data.quantity    != null ? data.quantity : null,
                specs:       Array.isArray(data.specs) ? data.specs : [],
                created_at:  event.created_at,
                _raw:        event
            };
        } catch (e) {
            console.warn('[Stalls] Error parseando producto:', e);
            return null;
        }
    }

    // ── Publicar Tienda ───────────────────────────────────────
    async function publishStall(data) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Debes iniciar sesión');
        const pubkey = LBW_Nostr.getPubkey();
        const dTag   = `lbw-stall-${pubkey.substring(0, 8)}`;  // una sola tienda por usuario

        const content = JSON.stringify({
            name:        data.name        || 'Mi Tienda',
            description: data.description || '',
            currency:    data.currency    || 'sat',
            shipping: data.shipping || [{ id: 'worldwide', name: 'Internacional', cost: 0, regions: ['Worldwide'] }]
        });

        const event = await LBW_Nostr.publishEvent({
            kind:    KIND_STALL,
            content,
            tags: [
                ['d', dTag],
                ['t', LBW_TAG],
                ['t', 'lbw']
            ]
        });

        // Actualizar estado local
        const stall = _parseStall({ ...event, tags: [['d', dTag], ['t', LBW_TAG], ['t', 'lbw']] });
        if (stall) _upsertStall(stall);

        console.log('[Stalls] ✅ Tienda publicada:', dTag);
        return event;
    }

    // ── Publicar Producto ─────────────────────────────────────
    async function publishProduct(data, stallDTag) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Debes iniciar sesión');
        const pubkey  = LBW_Nostr.getPubkey();
        const prodDTag = `lbw-prod-${pubkey.substring(0, 6)}-${Date.now()}`;
        const aTagVal  = _stallKey(pubkey, stallDTag);

        // Construir array de imágenes — soporte LBW_Media si disponible
        let mediaTags = [];
        if (data.imageFiles && data.imageFiles.length > 0 && typeof LBW_Media !== 'undefined') {
            try {
                for (const file of data.imageFiles.slice(0, 5)) {
                    const tags = await LBW_Media.buildImageTags(file);
                    tags.forEach(t => mediaTags.push(t));
                }
            } catch (e) {
                console.warn('[Stalls] Media upload failed, using URL fallback:', e);
            }
        } else if (data.imageUrl) {
            mediaTags.push(['image', data.imageUrl]);
        }

        const content = JSON.stringify({
            id:          prodDTag,
            stall_id:    stallDTag,
            name:        data.name        || 'Producto',
            description: data.description || '',
            images:      data.imageUrl ? [data.imageUrl] : [],
            price:       data.price != null ? Number(data.price) : 0,
            currency:    data.currency || 'sat',
            quantity:    data.quantity != null ? Number(data.quantity) : null,
            specs:       data.specs   || []
        });

        const tags = [
            ['d', prodDTag],
            ['a', aTagVal],
            ['t', LBW_TAG],
            ['t', 'lbw'],
            ...mediaTags
        ];

        const event = await LBW_Nostr.publishEvent({ kind: KIND_PRODUCT, content, tags });
        const product = _parseProduct({ ...event, content, tags });
        if (product) {
            if (!_products[aTagVal]) _products[aTagVal] = [];
            _products[aTagVal].unshift(product);
        }
        console.log('[Stalls] ✅ Producto publicado:', prodDTag);
        return event;
    }

    // ── Eliminar (kind:5, NIP-09 addressable) ─────────────────
    // SEC-14: Stalls (30017) y productos (30018) son eventos addressable (NIP-33).
    // Se borran con tag `a` (kind:pubkey:dTag) + tag `k` (NIP-09 ≥2024).
    // NO incluimos `e` tag: event.id cambia con cada edición, y mezclar e+a
    // en relays estrictos (strfry, nostr-rs-relay) causa ambigüedad — algunos
    // aplican solo `e` y dejan la coordenada addressable sin borrar.
    async function deleteStall(stallId) {
        const stall = _stalls.find(s => s.id === stallId);
        if (!stall) throw new Error('Tienda no encontrada en estado local');
        if (!LBW_Nostr.isLoggedIn()) throw new Error('No has iniciado sesión');
        if (stall.pubkey !== LBW_Nostr.getPubkey()) {
            throw new Error('No puedes borrar una tienda que no es tuya');
        }
        if (!stall.dTag) throw new Error('Tienda sin dTag — no es addressable');

        await LBW_Nostr.publishEvent({
            kind: 5,
            content: 'Tienda eliminada',
            tags: [
                ['a', `${KIND_STALL}:${stall.pubkey}:${stall.dTag}`],
                ['k', String(KIND_STALL)]
            ]
        });
        _stalls = _stalls.filter(s => s.id !== stallId);
        // Limpiar también los productos asociados a esa tienda en estado local
        const stallKey = _stallKey(stall.pubkey, stall.dTag);
        delete _products[stallKey];
        console.log('[Stalls] 🗑️ Tienda eliminada (NIP-09 addressable):', stall.dTag);
    }

    async function deleteProduct(productId) {
        let product = null;
        let stallKey = null;
        for (const key of Object.keys(_products)) {
            const found = _products[key].find(p => p.id === productId);
            if (found) { product = found; stallKey = key; break; }
        }
        if (!product) throw new Error('Producto no encontrado en estado local');
        if (!LBW_Nostr.isLoggedIn()) throw new Error('No has iniciado sesión');
        if (product.pubkey !== LBW_Nostr.getPubkey()) {
            throw new Error('No puedes borrar un producto que no es tuyo');
        }
        if (!product.dTag) throw new Error('Producto sin dTag — no es addressable');

        await LBW_Nostr.publishEvent({
            kind: 5,
            content: 'Producto eliminado',
            tags: [
                ['a', `${KIND_PRODUCT}:${product.pubkey}:${product.dTag}`],
                ['k', String(KIND_PRODUCT)]
            ]
        });
        if (stallKey && _products[stallKey]) {
            _products[stallKey] = _products[stallKey].filter(p => p.id !== productId);
        }
        console.log('[Stalls] 🗑️ Producto eliminado (NIP-09 addressable):', product.dTag);
    }

    // ── Acceso a datos ────────────────────────────────────────
    function getAllStalls() { return [..._stalls]; }

    function getMyStall() {
        if (!LBW_Nostr.isLoggedIn()) return null;
        const myPubkey = LBW_Nostr.getPubkey();
        return _stalls.find(s => s.pubkey === myPubkey) || null;
    }

    function getProductsForStall(stallKey) {
        return [...(_products[stallKey] || [])].sort((a, b) => b.created_at - a.created_at);
    }

    function _upsertStall(stall) {
        // Dedup 1: mismo event.id (mismo evento llegando de dos relays)
        if (_stalls.find(s => s.id === stall.id)) return;
        // Dedup 2: mismo (dTag + pubkey) = versión más nueva del mismo stall
        const idx = _stalls.findIndex(s => s.dTag === stall.dTag && s.pubkey === stall.pubkey);
        if (idx >= 0) {
            if (stall.created_at >= _stalls[idx].created_at) _stalls[idx] = stall;
        } else {
            _stalls.push(stall);
        }
        _stalls.sort((a, b) => b.created_at - a.created_at);
    }

    function _upsertProduct(product) {
        const key = product.stallKey;
        if (!_products[key]) _products[key] = [];
        // Dedup 1: mismo event.id (mismo evento llegando de dos relays)
        if (_products[key].find(p => p.id === product.id)) return;
        // Dedup 2: mismo (dTag + pubkey) = versión más nueva del mismo producto
        const idx = _products[key].findIndex(p => p.dTag === product.dTag && p.pubkey === product.pubkey);
        if (idx >= 0) {
            if (product.created_at >= _products[key][idx].created_at) _products[key][idx] = product;
        } else {
            _products[key].push(product);
        }
    }

    // ── Subscripción Nostr ────────────────────────────────────
    function start() {
        stop();

        if (!LBW_Nostr || !LBW_Nostr.getPool) {
            console.warn('[Stalls] LBW_Nostr no disponible');
            return;
        }

        const pool   = LBW_Nostr.getPool();
        const relays = LBW_Nostr.getReadRelays ? LBW_Nostr.getReadRelays() : [];
        if (!relays.length) return;

        // Suscribir stalls (kind:30017)
        _subStall = pool.subscribeMany(relays, [
            { kinds: [KIND_STALL], '#t': [LBW_TAG], limit: 50 }
        ], {
            onevent: (event) => {
                // SEC-19: Fail-safe signature/structure validation.
                // If validator is missing (shouldn't happen, but defensively),
                // reject the event instead of processing unvalidated data.
                if (typeof LBW_Nostr === 'undefined' || typeof LBW_Nostr.validateIncomingEvent !== 'function') {
                    console.error('[Stalls] validateIncomingEvent unavailable — rejecting event');
                    return;
                }
                if (!LBW_Nostr.validateIncomingEvent(event, 'stalls')) return;
                const stall = _parseStall(event);
                if (stall) {
                    _upsertStall(stall);
                    _renderStallsGrid();
                }
            },
            oneose: () => {
                console.log(`[Stalls] EOSE — ${_stalls.length} tiendas cargadas`);
                _renderStallsGrid();
            }
        });

        // Suscribir productos (kind:30018)
        _subProduct = pool.subscribeMany(relays, [
            { kinds: [KIND_PRODUCT], '#t': [LBW_TAG], limit: 200 }
        ], {
            onevent: (event) => {
                // SEC-19: Fail-safe signature/structure validation.
                if (typeof LBW_Nostr === 'undefined' || typeof LBW_Nostr.validateIncomingEvent !== 'function') {
                    console.error('[Stalls] validateIncomingEvent unavailable — rejecting event');
                    return;
                }
                if (!LBW_Nostr.validateIncomingEvent(event, 'stalls')) return;
                const product = _parseProduct(event);
                if (product) _upsertProduct(product);
            }
        });

        console.log('[Stalls] 🏪 Subscripción iniciada');
    }

    function stop() {
        if (_subStall)   { try { _subStall.close();   } catch(e) {} _subStall   = null; }
        if (_subProduct) { try { _subProduct.close(); } catch(e) {} _subProduct = null; }
    }

    // ── Render Grid de Tiendas ────────────────────────────────
    function _renderStallsGrid() {
        const grid = document.getElementById('stallsGrid');
        if (!grid || grid.style.display === 'none') return;

        if (_stalls.length === 0) {
            grid.innerHTML = '<div class="placeholder"><h3>🏪 Sin Tiendas</h3><p>Sé el primero en crear tu tienda permanente</p></div>';
            return;
        }

        grid.innerHTML = '';
        _stalls.forEach(stall => {
            const isMine = LBW_Nostr.isLoggedIn() && stall.pubkey === LBW_Nostr.getPubkey();
            const prodCount = (_products[stall.stallKey] || []).length;

            // Resolver nombre del vendedor asincrónicamente
            const card = document.createElement('div');
            card.className = 'offer-card stall-card';
            card.dataset.stallKey = stall.stallKey;
            card.style.cssText = 'background:var(--color-bg-card);border:2px solid var(--color-border);border-radius:16px;overflow:hidden;transition:all 0.3s;cursor:pointer;';

            card.innerHTML = `
                <div style="padding:1rem;">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75rem;">
                        <div style="font-size:2rem;">🏪</div>
                        <div style="display:flex;gap:0.3rem;align-items:center;">
                            ${isMine ? '<span style="font-size:0.65rem;background:rgba(229,185,92,0.15);color:var(--color-gold);padding:0.15rem 0.5rem;border-radius:20px;border:1px solid rgba(229,185,92,0.3);">✏️ Mi tienda</span>' : ''}
                            <span style="font-size:0.65rem;background:rgba(44,95,111,0.2);color:var(--color-teal-light);padding:0.15rem 0.5rem;border-radius:20px;border:1px solid rgba(44,95,111,0.4);">${prodCount} producto${prodCount !== 1 ? 's' : ''}</span>
                        </div>
                    </div>
                    <h4 style="color:var(--color-text-primary);font-size:1rem;margin-bottom:0.4rem;">${_esc(stall.name)}</h4>
                    <p style="color:var(--color-text-secondary);font-size:0.8rem;margin-bottom:0.75rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${_esc(stall.description)}</p>
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
                        <span style="font-size:0.7rem;color:var(--color-text-secondary);" id="stall-seller-${stall.id.substring(0,8)}">…</span>
                        <span style="font-size:0.7rem;color:var(--color-gold);">⚡ ${_esc(stall.currency)}</span>
                    </div>
                    <div style="display:flex;gap:0.5rem;">
                        <button data-lbw-action="stallShowDetail" data-key="${_esc(stall.stallKey)}" style="flex:1;padding:0.4rem;background:rgba(229,185,92,0.15);border:1px solid var(--color-gold);border-radius:8px;color:var(--color-gold);cursor:pointer;font-size:0.75rem;font-weight:600;">
                            🛍️ Ver tienda
                        </button>
                        ${isMine ? `
                        <button data-lbw-action="stallAddProduct" data-dtag="${_esc(stall.dTag)}" style="flex:1;padding:0.4rem;background:rgba(44,95,111,0.2);border:1px solid var(--color-teal-light);border-radius:8px;color:var(--color-teal-light);cursor:pointer;font-size:0.75rem;">
                            ➕ Producto
                        </button>
                        <button data-lbw-action="stallConfirmDelete" data-id="${_esc(stall.id)}" style="padding:0.4rem 0.6rem;background:rgba(255,68,68,0.15);border:1px solid #ff4444;border-radius:8px;color:#ff4444;cursor:pointer;font-size:0.75rem;">🗑️</button>
                        ` : ''}
                    </div>
                </div>`;

            card.addEventListener('click', function(e) {
                if (e.target.tagName === 'BUTTON') return;
                LBW_Stalls.showStallDetail(stall.stallKey);
            });

            grid.appendChild(card);

            // Resolver nombre vendedor async
            _resolveName(stall.pubkey).then(name => {
                const el = document.getElementById(`stall-seller-${stall.id.substring(0,8)}`);
                if (el) el.textContent = name;
            });
        });
    }

    async function _resolveName(pubkey) {
        try {
            const cached = await LBW_Store.getProfile(pubkey);
            if (cached && (cached.name || cached.display_name)) return cached.display_name || cached.name;
            const profile = await LBW_Nostr.fetchUserProfile(pubkey);
            if (profile && (profile.name || profile.display_name)) return profile.display_name || profile.name;
        } catch(e) {}
        return pubkey.substring(0, 10) + '…';
    }

    // ── Modal: Detalle de Tienda ──────────────────────────────
    function showStallDetail(stallKey) {
        const stall = _stalls.find(s => s.stallKey === stallKey);
        if (!stall) return;

        const products = getProductsForStall(stallKey);
        const isMine   = LBW_Nostr.isLoggedIn() && stall.pubkey === LBW_Nostr.getPubkey();

        const productsHtml = products.length === 0
            ? `<div style="text-align:center;padding:2rem;color:var(--color-text-secondary);opacity:0.6;">
                <div style="font-size:2rem;margin-bottom:0.5rem;">📦</div>
                <p>Esta tienda aún no tiene productos</p>
                ${isMine ? `<button data-lbw-action="stallAddProduct" data-dtag="${_esc(stall.dTag)}" data-close-modal="stallDetailModal" style="margin-top:0.75rem;padding:0.5rem 1.2rem;background:rgba(229,185,92,0.15);border:1px solid var(--color-gold);border-radius:8px;color:var(--color-gold);cursor:pointer;font-size:0.85rem;">➕ Añadir primer producto</button>` : ''}
               </div>`
            : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1rem;margin-top:1rem;">
                ${products.map(p => _renderProductCard(p, isMine)).join('')}
               </div>`;

        const shippingHtml = stall.shipping.length > 0
            ? stall.shipping.map(s => `<span style="font-size:0.75rem;background:rgba(44,95,111,0.2);color:var(--color-teal-light);padding:0.2rem 0.6rem;border-radius:20px;border:1px solid rgba(44,95,111,0.3);">🚚 ${_esc(s.name)}${s.cost === 0 ? ' (gratis)' : ' (' + s.cost + ' ' + _esc(stall.currency) + ')'}</span>`).join(' ')
            : '';

        const existing = document.getElementById('stallDetailModal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'stallDetailModal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9000;display:flex;align-items:flex-start;justify-content:center;padding:1rem;overflow-y:auto;';
        modal.innerHTML = `
            <div style="background:var(--color-bg-card);border:2px solid var(--color-border);border-radius:20px;padding:1.5rem;width:100%;max-width:700px;margin:auto;position:relative;">
                <button data-lbw-action="stallCloseDetailModal" style="position:absolute;top:1rem;right:1rem;background:none;border:none;color:var(--color-text-secondary);font-size:1.4rem;cursor:pointer;line-height:1;">✕</button>

                <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem;">
                    <span style="font-size:2rem;">🏪</span>
                    <div>
                        <h2 style="color:var(--color-gold);margin:0;">${_esc(stall.name)}</h2>
                        <div id="stall-detail-seller" style="font-size:0.75rem;color:var(--color-text-secondary);">…</div>
                    </div>
                </div>

                ${stall.description ? `<p style="color:var(--color-text-secondary);font-size:0.85rem;margin-bottom:1rem;">${_esc(stall.description)}</p>` : ''}
                ${shippingHtml ? `<div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:1rem;">${shippingHtml}</div>` : ''}

                ${isMine ? `
                <div style="display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap;">
                    <button data-lbw-action="stallAddProduct" data-dtag="${_esc(stall.dTag)}" data-close-modal="stallDetailModal" style="padding:0.4rem 1rem;background:rgba(229,185,92,0.15);border:1px solid var(--color-gold);border-radius:8px;color:var(--color-gold);cursor:pointer;font-size:0.8rem;font-weight:600;">➕ Añadir producto</button>
                    <button data-lbw-action="stallEditMine" data-close-modal="stallDetailModal" style="padding:0.4rem 1rem;background:rgba(44,95,111,0.2);border:1px solid var(--color-teal-light);border-radius:8px;color:var(--color-teal-light);cursor:pointer;font-size:0.8rem;">✏️ Editar tienda</button>
                </div>` : ''}

                <hr style="border-color:var(--color-border);margin:1rem 0;">
                <h3 style="color:var(--color-text-primary);margin-bottom:0.5rem;font-size:0.9rem;">📦 Productos (${products.length})</h3>
                ${productsHtml}
            </div>`;

        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

        _resolveName(stall.pubkey).then(name => {
            const el = document.getElementById('stall-detail-seller');
            if (el) el.textContent = name;
        });
    }

    function _renderProductCard(product, isMine) {
        const imgHtml = product.images.length > 0
            ? `<img src="${_esc(product.images[0])}" style="width:100%;height:120px;object-fit:cover;border-radius:8px;margin-bottom:0.5rem;" onerror="this.style.display='none'" loading="lazy">`
            : '';
        const priceStr = product.price === 'A negociar' || product.price === 0
            ? 'A negociar'
            : `${Number(product.price).toLocaleString()} ${_esc(product.currency)}`;
        const qtyBadge = product.quantity != null
            ? `<span style="font-size:0.6rem;background:rgba(76,175,80,0.15);color:#81C784;padding:0.1rem 0.4rem;border-radius:10px;border:1px solid rgba(76,175,80,0.3);">${product.quantity > 0 ? product.quantity + ' disponibles' : 'Agotado'}</span>`
            : '';

        return `
            <div style="background:rgba(13,23,30,0.6);border:1px solid var(--color-border);border-radius:12px;padding:0.75rem;">
                ${imgHtml}
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.3rem;">
                    <h4 style="color:var(--color-text-primary);font-size:0.85rem;margin:0;flex:1;">${_esc(product.name)}</h4>
                    ${qtyBadge}
                </div>
                ${product.description ? `<p style="color:var(--color-text-secondary);font-size:0.75rem;margin-bottom:0.5rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${_esc(product.description)}</p>` : ''}
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="color:var(--color-gold);font-weight:700;font-size:0.85rem;">⚡ ${priceStr}</span>
                    ${isMine ? `<button data-lbw-action="stallConfirmDeleteProduct" data-id="${_esc(product.id)}" style="background:rgba(255,68,68,0.15);border:1px solid #ff4444;border-radius:6px;color:#ff4444;cursor:pointer;font-size:0.7rem;padding:0.2rem 0.5rem;">🗑️</button>` : ''}
                </div>
            </div>`;
    }

    // ── Editar mi tienda (helper sin argumentos para onclick inline) ──
    function showEditMyStall() {
        const stall = getMyStall();
        if (!stall) { showCreateStallForm(); return; }
        showEditStallForm(stall);
    }
    function showCreateStallForm() {
        const myStall = getMyStall();
        showEditStallForm(myStall);
    }

    function showEditStallForm(existingStall) {
        const existing = document.getElementById('stallFormModal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'stallFormModal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9000;display:flex;align-items:center;justify-content:center;padding:1rem;overflow-y:auto;';
        modal.innerHTML = `
            <div style="background:var(--color-bg-card);border:2px solid var(--color-border);border-radius:20px;padding:1.5rem;width:100%;max-width:520px;position:relative;">
                <button onclick="document.getElementById('stallFormModal').remove()" style="position:absolute;top:1rem;right:1rem;background:none;border:none;color:var(--color-text-secondary);font-size:1.4rem;cursor:pointer;">✕</button>
                <h3 style="color:var(--color-gold);margin-bottom:1.5rem;">${existingStall ? '✏️ Editar Tienda' : '🏪 Crear Mi Tienda'}</h3>

                <div style="margin-bottom:1rem;">
                    <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Nombre de la tienda *</label>
                    <input id="stallName" type="text" maxlength="80" placeholder="Ej: Artesanías de Nan" value="${_esc(existingStall?.name || '')}"
                        style="width:100%;padding:0.65rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);font-size:0.9rem;box-sizing:border-box;">
                </div>

                <div style="margin-bottom:1rem;">
                    <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Descripción</label>
                    <textarea id="stallDescription" rows="3" maxlength="500" placeholder="Describe qué vendes en tu tienda…"
                        style="width:100%;padding:0.65rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);font-size:0.9rem;resize:vertical;box-sizing:border-box;">${_esc(existingStall?.description || '')}</textarea>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1rem;">
                    <div>
                        <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Moneda</label>
                        <select id="stallCurrency" style="width:100%;padding:0.65rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);font-size:0.9rem;">
                            <option value="sat" ${(existingStall?.currency || 'sat') === 'sat' ? 'selected' : ''}>⚡ Satoshis (sat)</option>
                            <option value="EUR" ${existingStall?.currency === 'EUR' ? 'selected' : ''}>€ Euro (EUR)</option>
                            <option value="USD" ${existingStall?.currency === 'USD' ? 'selected' : ''}>$ Dólar (USD)</option>
                            <option value="BTC" ${existingStall?.currency === 'BTC' ? 'selected' : ''}>₿ Bitcoin (BTC)</option>
                        </select>
                    </div>
                    <div>
                        <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Envío</label>
                        <select id="stallShipping" style="width:100%;padding:0.65rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);font-size:0.9rem;">
                            <option value="free">Gratis / Digital</option>
                            <option value="fixed">Coste fijo</option>
                            <option value="none">Sin envío</option>
                        </select>
                    </div>
                </div>

                <button onclick="LBW_Stalls._submitStallForm()" style="width:100%;padding:0.75rem;background:var(--color-gold);color:#000;border:none;border-radius:10px;font-weight:700;font-size:0.95rem;cursor:pointer;">
                    📡 ${existingStall ? 'Actualizar Tienda' : 'Crear Tienda en Nostr'}
                </button>

                <p style="font-size:0.7rem;color:var(--color-text-secondary);text-align:center;margin-top:0.75rem;opacity:0.7;">
                    Tu tienda se publica como un evento kind:30017 en Nostr
                </p>
            </div>`;

        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    }

    async function _submitStallForm() {
        const name        = document.getElementById('stallName')?.value.trim();
        const description = document.getElementById('stallDescription')?.value.trim();
        const currency    = document.getElementById('stallCurrency')?.value;
        const shippingOpt = document.getElementById('stallShipping')?.value;

        if (!name) { alert('El nombre de la tienda es obligatorio.'); return; }

        const shippingMap = {
            free:  [{ id: 'free',      name: 'Gratis / Digital', cost: 0,   regions: ['Worldwide'] }],
            fixed: [{ id: 'fixed',     name: 'Envío estándar',   cost: 500, regions: ['Worldwide'] }],
            none:  []
        };

        const btn = document.querySelector('#stallFormModal button:last-of-type');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Publicando…'; }

        try {
            await publishStall({ name, description, currency, shipping: shippingMap[shippingOpt] || [] });
            document.getElementById('stallFormModal')?.remove();
            showNotification('✅ Tienda publicada en Nostr', 'success');
            setTimeout(() => _renderStallsGrid(), 300);
        } catch(e) {
            alert('❌ ' + e.message);
            if (btn) { btn.disabled = false; btn.textContent = '📡 Publicar'; }
        }
    }

    // ── Formulario: Añadir Producto ───────────────────────────
    function showAddProductForm(stallDTag) {
        const existing = document.getElementById('productFormModal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'productFormModal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9100;display:flex;align-items:center;justify-content:center;padding:1rem;overflow-y:auto;';
        modal.innerHTML = `
            <div style="background:var(--color-bg-card);border:2px solid var(--color-border);border-radius:20px;padding:1.5rem;width:100%;max-width:520px;position:relative;">
                <button onclick="document.getElementById('productFormModal').remove()" style="position:absolute;top:1rem;right:1rem;background:none;border:none;color:var(--color-text-secondary);font-size:1.4rem;cursor:pointer;">✕</button>
                <h3 style="color:var(--color-gold);margin-bottom:1.5rem;">📦 Añadir Producto</h3>

                <div style="margin-bottom:1rem;">
                    <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Nombre del producto *</label>
                    <input id="prodName" type="text" maxlength="100" placeholder="Ej: Libro de Hayek"
                        style="width:100%;padding:0.65rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);font-size:0.9rem;box-sizing:border-box;">
                </div>

                <div style="margin-bottom:1rem;">
                    <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Descripción</label>
                    <textarea id="prodDescription" rows="2" maxlength="500" placeholder="Describe el producto…"
                        style="width:100%;padding:0.65rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);font-size:0.9rem;resize:vertical;box-sizing:border-box;"></textarea>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1rem;">
                    <div>
                        <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Precio</label>
                        <input id="prodPrice" type="number" min="0" placeholder="1000" value=""
                            style="width:100%;padding:0.65rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);font-size:0.9rem;box-sizing:border-box;">
                    </div>
                    <div>
                        <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">Cantidad disponible</label>
                        <input id="prodQuantity" type="number" min="0" placeholder="Dejar vacío = ilimitado"
                            style="width:100%;padding:0.65rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);font-size:0.9rem;box-sizing:border-box;">
                    </div>
                </div>

                <div style="margin-bottom:1rem;">
                    <label style="display:block;margin-bottom:0.4rem;color:var(--color-gold);font-size:0.85rem;">URL de imagen (opcional)</label>
                    <input id="prodImageUrl" type="url" placeholder="https://ejemplo.com/imagen.jpg"
                        style="width:100%;padding:0.65rem;background:var(--color-bg-dark);border:2px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);font-size:0.9rem;box-sizing:border-box;">
                </div>

                <button data-lbw-action="stallSubmitProductForm" data-dtag="${_esc(stallDTag)}" style="width:100%;padding:0.75rem;background:var(--color-gold);color:#000;border:none;border-radius:10px;font-weight:700;font-size:0.95rem;cursor:pointer;">
                    📡 Publicar Producto en Nostr
                </button>
                <p style="font-size:0.7rem;color:var(--color-text-secondary);text-align:center;margin-top:0.75rem;opacity:0.7;">
                    Evento kind:30018 — enlazado a tu tienda via a-tag
                </p>
            </div>`;

        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    }

    async function _submitProductForm(stallDTag) {
        const name        = document.getElementById('prodName')?.value.trim();
        const description = document.getElementById('prodDescription')?.value.trim();
        const priceVal    = document.getElementById('prodPrice')?.value;
        const qtyVal      = document.getElementById('prodQuantity')?.value;
        const imageUrl    = document.getElementById('prodImageUrl')?.value.trim();

        if (!name) { alert('El nombre del producto es obligatorio.'); return; }

        const btn = document.querySelector('#productFormModal button:last-of-type');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Publicando…'; }

        try {
            await publishProduct({
                name,
                description,
                price:    priceVal !== '' ? Number(priceVal) : 'A negociar',
                quantity: qtyVal   !== '' ? Number(qtyVal)   : null,
                imageUrl: imageUrl || null
            }, stallDTag);

            document.getElementById('productFormModal')?.remove();
            showNotification('✅ Producto publicado en Nostr', 'success');
        } catch(e) {
            alert('❌ ' + e.message);
            if (btn) { btn.disabled = false; btn.textContent = '📡 Publicar Producto'; }
        }
    }

    // ── Confirmaciones de borrado ─────────────────────────────
    function confirmDeleteStall(stallId) {
        if (!confirm('¿Eliminar tu tienda y todos sus productos? Esta acción no se puede deshacer.')) return;
        deleteStall(stallId)
            .then(() => { showNotification('Tienda eliminada', 'success'); _renderStallsGrid(); })
            .catch(e => alert('❌ ' + e.message));
    }

    function confirmDeleteProduct(productId) {
        if (!confirm('¿Eliminar este producto?')) return;
        deleteProduct(productId)
            .then(() => {
                showNotification('Producto eliminado', 'success');
                // Refrescar modal de detalle si está abierto
                document.getElementById('stallDetailModal')?.remove();
            })
            .catch(e => alert('❌ ' + e.message));
    }

    // ── Mostrar / ocultar grid de tiendas ─────────────────────
    function showStallsView() {
        const offersGrid = document.getElementById('offersGrid');
        const stallsGrid = document.getElementById('stallsGrid');
        const newOfferBtn = document.getElementById('newOfferBtn');
        const newStallBtn = document.getElementById('newStallBtn');
        if (offersGrid) offersGrid.style.display = 'none';
        if (stallsGrid) { stallsGrid.style.display = 'grid'; _renderStallsGrid(); }
        if (newOfferBtn) newOfferBtn.style.display = 'none';
        if (newStallBtn) newStallBtn.style.display = 'block';
    }

    function showOffersView() {
        const offersGrid = document.getElementById('offersGrid');
        const stallsGrid = document.getElementById('stallsGrid');
        const newOfferBtn = document.getElementById('newOfferBtn');
        const newStallBtn = document.getElementById('newStallBtn');
        if (offersGrid) offersGrid.style.display = 'grid';
        if (stallsGrid) stallsGrid.style.display = 'none';
        if (newOfferBtn) newOfferBtn.style.display = 'block';
        if (newStallBtn) newStallBtn.style.display = 'none';
    }

    // ── API Pública ───────────────────────────────────────────
    window.LBW_Stalls = {
        start,
        stop,
        getAllStalls,
        getMyStall,
        getProductsForStall,
        publishStall,
        publishProduct,
        deleteStall,
        deleteProduct,
        showStallDetail,
        showCreateStallForm,
        showEditStallForm,
        showEditMyStall,
        showAddProductForm,
        showStallsView,
        showOffersView,
        confirmDeleteStall,
        confirmDeleteProduct,
        // Internos expuestos para onclick inline
        _submitStallForm,
        _submitProductForm,
        _renderStallsGrid
    };

    console.log('✅ LBW_Stalls (NIP-15) listo');
})();

// ═══════════════════════════════════════════════════════════════════
// SEC-11/12: Event delegation for stall/product actions.
// ═══════════════════════════════════════════════════════════════════
(function installStallsEventDelegation() {
    if (window.__lbwStallsListenerInstalled) return;
    window.__lbwStallsListenerInstalled = true;

    document.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-lbw-action]') : null;
        if (!el) return;
        var action = el.dataset.lbwAction;
        if (!action || action.indexOf('stall') !== 0) return;
        var closeModal = el.dataset.closeModal;
        try {
            switch (action) {
                case 'stallShowDetail':
                    LBW_Stalls.showStallDetail(el.dataset.key);
                    break;
                case 'stallAddProduct':
                    if (closeModal) {
                        var m = document.getElementById(closeModal);
                        if (m) m.remove();
                    }
                    LBW_Stalls.showAddProductForm(el.dataset.dtag);
                    break;
                case 'stallConfirmDelete':
                    LBW_Stalls.confirmDeleteStall(el.dataset.id);
                    break;
                case 'stallConfirmDeleteProduct':
                    LBW_Stalls.confirmDeleteProduct(el.dataset.id);
                    break;
                case 'stallCloseDetailModal':
                    var modal = document.getElementById('stallDetailModal');
                    if (modal) modal.remove();
                    break;
                case 'stallEditMine':
                    if (closeModal) {
                        var m2 = document.getElementById(closeModal);
                        if (m2) m2.remove();
                    }
                    LBW_Stalls.showEditMyStall();
                    break;
                case 'stallSubmitProductForm':
                    LBW_Stalls._submitProductForm(el.dataset.dtag);
                    break;
            }
        } catch (err) {
            console.error('[Stalls delegation] Error dispatching', action, err);
        }
    });
})();

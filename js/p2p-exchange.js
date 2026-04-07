// ========== P2P EXCHANGE — NIP-69 Aggregator (kind 38383) ==========
// Reads Mostro/lnp2pbot/RoboSats P2P orders from public relays (read-only)
// No authentication required — all orders are public events

const LBW_P2P = (() => {
    'use strict';

    // ── Config ───────────────────────────────────────────────
    const P2P_RELAYS = [
        'wss://relay.mostro.network',
        'wss://relay.damus.io'
    ];

    const KIND_P2P_ORDER = 38383;

    // NostroMostro npub (Spanish instance)
    const NOSTROMOSTRO_NPUB = 'npub1qqqvcqssrmpfa65uuc3jtp6jh8ta5ekz0pz76f5ydhgtplrnddqqrqe7xr';

    // ── State ────────────────────────────────────────────────
    let _orders = [];
    let _sub = null;
    let _btcEurPrice = null;
    let _priceLastFetch = 0;
    let _activeCurrency = 'all';  // 'all' | 'EUR' | 'USD' | ...
    let _activeType = 'all';      // 'all' | 'buy' | 'sell'
    let _isLoading = false;

    // ── Helpers ──────────────────────────────────────────────
    function _esc(s) {
        if (!s) return '';
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function _getTagValue(tags, key) {
        const tag = (tags || []).find(t => t[0] === key);
        return tag ? tag[1] : null;
    }

    function _getTagValues(tags, key) {
        const tag = (tags || []).find(t => t[0] === key);
        return tag ? tag.slice(1) : [];
    }

    function _timeAgo(ts) {
        const diff = Math.floor(Date.now() / 1000) - ts;
        if (diff < 60) return 'Ahora';
        if (diff < 3600) return `${Math.floor(diff / 60)}m`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
        return `${Math.floor(diff / 86400)}d`;
    }

    // ── Parse NIP-69 event into order object ────────────────
    function _parseOrder(event) {
        const tags = event.tags || [];
        const ratingRaw = _getTagValue(tags, 'rating');
        let rating = null;
        try { if (ratingRaw) rating = JSON.parse(ratingRaw); } catch (e) {}

        const faValues = _getTagValues(tags, 'fa');
        let fiatAmount = faValues[0] || null;
        let fiatAmountMax = faValues[1] || null;

        return {
            id: event.id,
            pubkey: event.pubkey,
            created_at: event.created_at,
            orderId:    _getTagValue(tags, 'd'),
            type:       _getTagValue(tags, 'k'),       // 'buy' | 'sell'
            currency:   _getTagValue(tags, 'f'),        // ISO 4217: EUR, USD, etc.
            status:     _getTagValue(tags, 's'),        // pending, in-progress, success, etc.
            amount:     _getTagValue(tags, 'amt'),      // sats (0 = market price)
            fiatAmount: fiatAmount,
            fiatAmountMax: fiatAmountMax,
            paymentMethods: _getTagValues(tags, 'pm'),
            premium:    _getTagValue(tags, 'premium'),
            network:    _getTagValue(tags, 'network'),  // mainnet, testnet
            layer:      _getTagValue(tags, 'layer'),    // lightning, onchain, liquid
            platform:   _getTagValue(tags, 'y'),        // mostro, lnp2pbot, robosats
            name:       _getTagValue(tags, 'name'),
            rating:     rating,
            bond:       _getTagValue(tags, 'bond'),
            expiresAt:  _getTagValue(tags, 'expires_at'),
            source:     _getTagValue(tags, 'source'),
        };
    }

    // ── Fetch BTC price ─────────────────────────────────────
    async function _fetchBtcPrice() {
        // Cache for 5 minutes
        if (_btcEurPrice && (Date.now() - _priceLastFetch) < 300000) return;

        try {
            const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur,usd', {
                signal: AbortSignal.timeout(5000)
            });
            const data = await res.json();
            _btcEurPrice = data.bitcoin;
            _priceLastFetch = Date.now();
            console.log('[P2P] 💰 BTC price:', _btcEurPrice);
        } catch (e) {
            console.warn('[P2P] ⚠️ No se pudo obtener precio BTC:', e.message);
        }
    }

    // ── Calculate effective price from premium ──────────────
    function _calcEffectivePrice(order) {
        if (!_btcEurPrice) return null;
        const premium = parseFloat(order.premium) || 0;
        const curr = (order.currency || '').toUpperCase();

        let basePrice = null;
        if (curr === 'EUR') basePrice = _btcEurPrice.eur;
        else if (curr === 'USD') basePrice = _btcEurPrice.usd;
        if (!basePrice) return null;

        return basePrice * (1 + premium / 100);
    }

    // ── Format fiat amount display ──────────────────────────
    function _formatFiat(order) {
        const curr = order.currency || '???';
        const symbols = { EUR: '€', USD: '$', GBP: '£', VES: 'Bs.', ARS: '$', COP: '$', MXN: '$', BRL: 'R$' };
        const sym = symbols[curr] || curr;

        if (order.fiatAmount && order.fiatAmountMax) {
            return `${sym} ${_formatNum(order.fiatAmount)} — ${_formatNum(order.fiatAmountMax)}`;
        }
        if (order.fiatAmount) {
            return `${sym} ${_formatNum(order.fiatAmount)}`;
        }
        return 'Monto flexible';
    }

    function _formatNum(n) {
        const num = parseFloat(n);
        if (isNaN(num)) return n;
        return num.toLocaleString('es-ES', { maximumFractionDigits: 0 });
    }

    // ── Format sats amount ──────────────────────────────────
    function _formatSats(amt) {
        const n = parseInt(amt);
        if (!n || n === 0) return 'Precio mercado';
        if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M sats`;
        if (n >= 1000) return `${(n / 1000).toFixed(0)}K sats`;
        return `${_formatNum(n)} sats`;
    }

    // ── Rating display ──────────────────────────────────────
    function _renderRating(rating) {
        if (!rating || !rating.total_reviews) return '<span style="color:var(--color-text-secondary);font-size:0.7rem;">Sin reseñas</span>';
        const avg = (rating.total_rating / rating.total_reviews).toFixed(1);
        const stars = '⭐'.repeat(Math.round(avg));
        return `<span style="font-size:0.7rem;color:var(--color-gold);" title="${rating.total_reviews} reseñas">${stars} ${avg} (${rating.total_reviews})</span>`;
    }

    // ── Platform badge ──────────────────────────────────────
    function _platformBadge(platform) {
        const platforms = {
            'mostro': { label: 'Mostro', color: '#f7931a' },
            'lnp2pbot': { label: 'LNp2pBot', color: '#5b9bd5' },
            'robosats': { label: 'RoboSats', color: '#7b68ee' },
        };
        const p = platforms[(platform || '').toLowerCase()] || { label: platform || 'P2P', color: 'var(--color-teal-light)' };
        return `<span style="font-size:0.6rem;background:${p.color}22;color:${p.color};padding:0.1rem 0.4rem;border-radius:10px;border:1px solid ${p.color}44;font-weight:600;">${_esc(p.label)}</span>`;
    }

    // ── Type badge (buy/sell) ────────────────────────────────
    function _typeBadge(type) {
        if (type === 'sell') {
            return `<span style="font-size:0.7rem;background:rgba(76,175,80,0.15);color:#4CAF50;padding:0.15rem 0.5rem;border-radius:20px;border:1px solid #4CAF5044;font-weight:600;">VENTA</span>`;
        }
        return `<span style="font-size:0.7rem;background:rgba(33,150,243,0.15);color:#2196F3;padding:0.15rem 0.5rem;border-radius:20px;border:1px solid #2196F344;font-weight:600;">COMPRA</span>`;
    }

    // ── Payment methods pills ────────────────────────────────
    function _renderPaymentMethods(methods) {
        if (!methods || methods.length === 0) return '';
        const icons = {
            'bizum': '📱', 'bank transfer': '🏦', 'transferencia': '🏦', 'transferencia bancaria': '🏦',
            'revolut': '💳', 'paypal': '💰', 'wise': '🌍', 'n26': '🏦',
            'face to face': '🤝', 'efectivo': '💵', 'cash': '💵',
        };
        return methods.map(m => {
            const icon = icons[m.toLowerCase()] || '💳';
            return `<span style="font-size:0.65rem;background:rgba(255,255,255,0.05);padding:0.1rem 0.4rem;border-radius:8px;border:1px solid var(--color-border);color:var(--color-text-secondary);">${icon} ${_esc(m)}</span>`;
        }).join(' ');
    }

    // ── Render single order card ────────────────────────────
    function _renderOrderCard(order) {
        const card = document.createElement('div');
        card.className = 'offer-card p2p-order-card';
        card.dataset.currency = order.currency || '';
        card.dataset.type = order.type || '';
        card.style.cssText = 'background:var(--color-bg-card);border:2px solid var(--color-border);border-radius:16px;overflow:hidden;transition:all 0.3s;';

        const satsDisplay = _formatSats(order.amount);
        const fiatDisplay = _formatFiat(order);
        const premiumStr = order.premium ? `${order.premium > 0 ? '+' : ''}${order.premium}%` : '';
        const premiumColor = parseFloat(order.premium) > 0 ? '#ff9800' : parseFloat(order.premium) < 0 ? '#4CAF50' : 'var(--color-text-secondary)';

        // Effective price calculation
        let effectivePrice = '';
        const eff = _calcEffectivePrice(order);
        if (eff) {
            const sym = order.currency === 'EUR' ? '€' : order.currency === 'USD' ? '$' : order.currency;
            effectivePrice = `<span style="font-size:0.65rem;color:var(--color-text-secondary);" title="Precio efectivo con premium">≈ ${sym} ${_formatNum(Math.round(eff))}/BTC</span>`;
        }

        card.innerHTML = `
            <div style="padding:1rem;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.6rem;">
                    <div style="display:flex;gap:0.3rem;align-items:center;flex-wrap:wrap;">
                        ${_typeBadge(order.type)}
                        ${_platformBadge(order.platform)}
                    </div>
                    <span style="font-size:0.65rem;color:var(--color-text-secondary);">${_timeAgo(order.created_at)}</span>
                </div>

                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.4rem;">
                    <span style="font-weight:700;color:var(--color-gold);font-size:1.05rem;">
                        ${_esc(fiatDisplay)}
                    </span>
                    <span style="font-size:0.75rem;color:var(--color-text-secondary);">
                        ⚡ ${_esc(satsDisplay)}
                    </span>
                </div>

                ${premiumStr ? `
                <div style="margin-bottom:0.4rem;display:flex;gap:0.5rem;align-items:center;">
                    <span style="font-size:0.7rem;color:${premiumColor};font-weight:600;">Premium: ${_esc(premiumStr)}</span>
                    ${effectivePrice}
                </div>` : ''}

                <div style="margin-bottom:0.5rem;display:flex;gap:0.3rem;flex-wrap:wrap;">
                    ${_renderPaymentMethods(order.paymentMethods)}
                </div>

                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
                    <span style="font-size:0.75rem;color:var(--color-text-secondary);">
                        ${order.name ? `👤 ${_esc(order.name)}` : '👤 Anónimo'}
                    </span>
                    ${_renderRating(order.rating)}
                </div>

                <div style="display:flex;justify-content:space-between;align-items:center;padding-top:0.5rem;border-top:1px solid var(--color-border);">
                    <span style="font-size:0.6rem;color:var(--color-text-secondary);">
                        ⚡ ${_esc((order.layer || 'lightning').charAt(0).toUpperCase() + (order.layer || 'lightning').slice(1))}
                        · ${_esc((order.network || 'mainnet'))}
                    </span>
                    <button onclick="LBW_P2P.openMostroInfo()" style="padding:0.3rem 0.7rem;background:rgba(247,147,26,0.15);border:1px solid #f7931a;border-radius:8px;color:#f7931a;cursor:pointer;font-size:0.7rem;font-weight:600;">
                        ⚡ Operar
                    </button>
                </div>
            </div>
        `;

        return card;
    }

    // ── Render grid ─────────────────────────────────────────
    function _renderGrid() {
        const grid = document.getElementById('p2pOrdersGrid');
        if (!grid) return;
        grid.innerHTML = '';

        let filtered = _orders.filter(o => o.status === 'pending');

        // Apply currency filter
        if (_activeCurrency !== 'all') {
            filtered = filtered.filter(o => (o.currency || '').toUpperCase() === _activeCurrency.toUpperCase());
        }

        // Apply type filter
        if (_activeType !== 'all') {
            filtered = filtered.filter(o => o.type === _activeType);
        }

        // Sort: newest first
        filtered.sort((a, b) => b.created_at - a.created_at);

        if (filtered.length === 0 && !_isLoading) {
            grid.innerHTML = `
                <div class="placeholder" style="grid-column: 1 / -1;">
                    <h3>📡 Sin órdenes P2P activas</h3>
                    <p style="margin-bottom:0.5rem;">No hay órdenes ${_activeCurrency !== 'all' ? 'en ' + _activeCurrency : ''} disponibles ahora</p>
                    <p style="font-size:0.8rem;color:var(--color-text-secondary);">Las órdenes aparecen cuando los traders las publican en la red Mostro</p>
                </div>`;
            return;
        }

        if (_isLoading && filtered.length === 0) {
            grid.innerHTML = `
                <div class="placeholder" style="grid-column: 1 / -1;">
                    <h3>⏳ Buscando órdenes P2P...</h3>
                    <p>Conectando con relay.mostro.network</p>
                </div>`;
            return;
        }

        // Stats bar
        const buys = filtered.filter(o => o.type === 'buy').length;
        const sells = filtered.filter(o => o.type === 'sell').length;
        const statsBar = document.createElement('div');
        statsBar.style.cssText = 'grid-column:1/-1;display:flex;gap:1rem;padding:0.5rem 0;font-size:0.8rem;color:var(--color-text-secondary);margin-bottom:0.5rem;';
        statsBar.innerHTML = `
            <span>📊 ${filtered.length} ${filtered.length === 1 ? 'orden' : 'órdenes'} activas</span>
            <span style="color:#4CAF50;">🟢 ${sells} ventas</span>
            <span style="color:#2196F3;">🔵 ${buys} compras</span>
        `;
        grid.appendChild(statsBar);

        filtered.forEach(order => {
            grid.appendChild(_renderOrderCard(order));
        });
    }

    // ── Render filter bar ───────────────────────────────────
    function _renderFilterBar() {
        const container = document.getElementById('p2pFilters');
        if (!container) return;

        // Collect unique currencies from active orders
        const currencies = [...new Set(_orders.filter(o => o.status === 'pending').map(o => o.currency).filter(Boolean))];

        container.innerHTML = `
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem;">
                <button class="filter-btn ${_activeType === 'all' ? 'active' : ''}" onclick="LBW_P2P.filterType('all')" style="padding:0.35rem 0.8rem;background:${_activeType === 'all' ? 'rgba(229,185,92,0.15)' : 'transparent'};border:1px solid ${_activeType === 'all' ? 'var(--color-gold)' : 'var(--color-border)'};border-radius:8px;color:${_activeType === 'all' ? 'var(--color-gold)' : 'var(--color-text-secondary)'};cursor:pointer;font-size:0.8rem;">
                    🌐 Todas
                </button>
                <button class="filter-btn ${_activeType === 'sell' ? 'active' : ''}" onclick="LBW_P2P.filterType('sell')" style="padding:0.35rem 0.8rem;background:${_activeType === 'sell' ? 'rgba(76,175,80,0.15)' : 'transparent'};border:1px solid ${_activeType === 'sell' ? '#4CAF50' : 'var(--color-border)'};border-radius:8px;color:${_activeType === 'sell' ? '#4CAF50' : 'var(--color-text-secondary)'};cursor:pointer;font-size:0.8rem;">
                    🟢 Ventas
                </button>
                <button class="filter-btn ${_activeType === 'buy' ? 'active' : ''}" onclick="LBW_P2P.filterType('buy')" style="padding:0.35rem 0.8rem;background:${_activeType === 'buy' ? 'rgba(33,150,243,0.15)' : 'transparent'};border:1px solid ${_activeType === 'buy' ? '#2196F3' : 'var(--color-border)'};border-radius:8px;color:${_activeType === 'buy' ? '#2196F3' : 'var(--color-text-secondary)'};cursor:pointer;font-size:0.8rem;">
                    🔵 Compras
                </button>
                <span style="border-left:1px solid var(--color-border);margin:0 0.25rem;"></span>
                <button class="filter-btn ${_activeCurrency === 'all' ? 'active' : ''}" onclick="LBW_P2P.filterCurrency('all')" style="padding:0.35rem 0.8rem;background:${_activeCurrency === 'all' ? 'rgba(229,185,92,0.15)' : 'transparent'};border:1px solid ${_activeCurrency === 'all' ? 'var(--color-gold)' : 'var(--color-border)'};border-radius:8px;color:${_activeCurrency === 'all' ? 'var(--color-gold)' : 'var(--color-text-secondary)'};cursor:pointer;font-size:0.8rem;">
                    🌍 Todas
                </button>
                ${currencies.map(c => `
                    <button class="filter-btn ${_activeCurrency === c ? 'active' : ''}" onclick="LBW_P2P.filterCurrency('${c}')" style="padding:0.35rem 0.8rem;background:${_activeCurrency === c ? 'rgba(229,185,92,0.15)' : 'transparent'};border:1px solid ${_activeCurrency === c ? 'var(--color-gold)' : 'var(--color-border)'};border-radius:8px;color:${_activeCurrency === c ? 'var(--color-gold)' : 'var(--color-text-secondary)'};cursor:pointer;font-size:0.8rem;">
                        ${_esc(c)}
                    </button>
                `).join('')}
            </div>
        `;
    }

    // ── Info modal (how to use Mostro) ──────────────────────
    function openMostroInfo() {
        // Check for existing modal
        let modal = document.getElementById('mostroInfoModal');
        if (modal) { modal.style.display = 'flex'; return; }

        modal = document.createElement('div');
        modal.id = 'mostroInfoModal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:1rem;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };

        modal.innerHTML = `
            <div style="background:var(--color-bg-card);border:2px solid var(--color-gold);border-radius:16px;max-width:480px;width:100%;max-height:80vh;overflow-y:auto;padding:1.5rem;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
                    <h3 style="color:var(--color-gold);margin:0;">⚡ Cómo operar en Mostro P2P</h3>
                    <button onclick="document.getElementById('mostroInfoModal').style.display='none'" style="background:none;border:none;color:var(--color-text-secondary);font-size:1.2rem;cursor:pointer;">✕</button>
                </div>

                <p style="color:var(--color-text-secondary);font-size:0.85rem;margin-bottom:1rem;">
                    Las órdenes que ves aquí son del exchange P2P <strong style="color:#f7931a;">Mostro</strong>, 
                    un protocolo descentralizado sobre Nostr y Lightning Network. Sin KYC, sin custodio.
                </p>

                <div style="background:rgba(247,147,26,0.08);border:1px solid rgba(247,147,26,0.2);border-radius:12px;padding:1rem;margin-bottom:1rem;">
                    <h4 style="color:#f7931a;margin-bottom:0.5rem;font-size:0.9rem;">📋 Pasos para operar</h4>
                    <ol style="color:var(--color-text-primary);font-size:0.8rem;padding-left:1.2rem;margin:0;line-height:1.8;">
                        <li>Descarga una wallet Lightning (Phoenix, Zeus, Breez)</li>
                        <li>Instala el <a href="https://github.com/MostroP2P/mobile/releases" target="_blank" rel="noopener" style="color:var(--color-gold);">cliente Mostro para Android</a></li>
                        <li>Configura la npub de NostroMostro (instancia española)</li>
                        <li>Toma una orden o crea la tuya</li>
                        <li>Al confirmar el pago fiat, los sats se liberan</li>
                    </ol>
                </div>

                <div style="background:var(--color-bg-dark);border:1px solid var(--color-border);border-radius:8px;padding:0.75rem;margin-bottom:1rem;">
                    <label style="font-size:0.7rem;color:var(--color-gold);display:block;margin-bottom:0.3rem;">npub de NostroMostro (España)</label>
                    <div style="display:flex;gap:0.5rem;align-items:center;">
                        <code id="mostroNpubText" style="font-size:0.6rem;color:var(--color-text-primary);word-break:break-all;flex:1;">${NOSTROMOSTRO_NPUB}</code>
                        <button onclick="navigator.clipboard.writeText('${NOSTROMOSTRO_NPUB}');this.textContent='✅';setTimeout(()=>this.textContent='📋',1500);" style="background:rgba(229,185,92,0.15);border:1px solid var(--color-gold);border-radius:6px;color:var(--color-gold);cursor:pointer;padding:0.3rem 0.5rem;font-size:0.75rem;white-space:nowrap;">📋</button>
                    </div>
                </div>

                <div style="display:flex;gap:0.5rem;">
                    <a href="https://github.com/MostroP2P/mobile/releases" target="_blank" rel="noopener" style="flex:1;text-align:center;padding:0.5rem;background:rgba(247,147,26,0.15);border:1px solid #f7931a;border-radius:8px;color:#f7931a;text-decoration:none;font-size:0.8rem;font-weight:600;">
                        📱 App Android
                    </a>
                    <a href="https://t.me/nostromostro" target="_blank" rel="noopener" style="flex:1;text-align:center;padding:0.5rem;background:rgba(44,95,111,0.2);border:1px solid var(--color-teal-light);border-radius:8px;color:var(--color-teal-light);text-decoration:none;font-size:0.8rem;font-weight:600;">
                        💬 Telegram
                    </a>
                    <a href="https://mostro.network/es/" target="_blank" rel="noopener" style="flex:1;text-align:center;padding:0.5rem;background:rgba(255,255,255,0.05);border:1px solid var(--color-border);border-radius:8px;color:var(--color-text-secondary);text-decoration:none;font-size:0.8rem;font-weight:600;">
                        📖 Docs
                    </a>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
    }

    // ── Start subscription ──────────────────────────────────
    async function start() {
        if (_sub) stop();
        _isLoading = true;
        _orders = [];

        console.log('[P2P] 🚀 Conectando a relays Mostro:', P2P_RELAYS);
        _renderGrid();

        // Fetch BTC price in parallel
        _fetchBtcPrice();

        try {
            // Use LBW_Nostr pool if available, otherwise create standalone
            const pool = (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.getPool)
                ? LBW_Nostr.getPool()
                : new (window.NostrTools || window.nostrTools).SimplePool();

            _sub = pool.subscribeMany(
                P2P_RELAYS,
                [{
                    kinds: [KIND_P2P_ORDER],
                    '#s': ['pending'],
                    '#z': ['order'],
                    limit: 100
                }],
                {
                    onevent: (event) => {
                        const order = _parseOrder(event);

                        // Skip expired orders
                        if (order.expiresAt && parseInt(order.expiresAt) < Math.floor(Date.now() / 1000)) return;

                        // Dedup by d-tag (order ID)
                        const idx = _orders.findIndex(o => o.orderId && o.orderId === order.orderId);
                        if (idx >= 0) {
                            // Replace if newer
                            if (order.created_at > _orders[idx].created_at) {
                                _orders[idx] = order;
                            }
                        } else {
                            _orders.push(order);
                        }

                        _renderFilterBar();
                        _renderGrid();
                    },
                    oneose: () => {
                        _isLoading = false;
                        console.log(`[P2P] ✅ EOSE — ${_orders.length} órdenes cargadas`);
                        _renderFilterBar();
                        _renderGrid();
                    }
                }
            );

            console.log('[P2P] 📡 Suscripción activa a kind 38383');
        } catch (err) {
            _isLoading = false;
            console.error('[P2P] ❌ Error al conectar:', err);
            _renderGrid();
        }
    }

    // ── Stop subscription ───────────────────────────────────
    function stop() {
        if (_sub) {
            try { _sub.close(); } catch (e) {}
            _sub = null;
        }
        _orders = [];
        console.log('[P2P] 🛑 Suscripción P2P detenida');
    }

    // ── Filter functions (called from UI) ───────────────────
    function filterCurrency(curr) {
        _activeCurrency = curr;
        _renderFilterBar();
        _renderGrid();
    }

    function filterType(type) {
        _activeType = type;
        _renderFilterBar();
        _renderGrid();
    }

    // ── Refresh ─────────────────────────────────────────────
    function refresh() {
        stop();
        start();
    }

    // ── Public API ──────────────────────────────────────────
    return {
        start,
        stop,
        refresh,
        filterCurrency,
        filterType,
        openMostroInfo,
        getOrders: () => [..._orders],
    };
})();

window.LBW_P2P = LBW_P2P;
console.log('⚡ P2P Exchange (NIP-69 Aggregator) listo');

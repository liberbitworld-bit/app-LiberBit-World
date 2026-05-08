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

    // ── Platform-specific guides ─────────────────────────────
    // Each entry describes how to operate on that P2P platform.
    // Keys MUST be lowercase to match the normalized `platform` tag from events.
    const PLATFORM_GUIDES = {
        mostro: {
            label: 'Mostro',
            color: '#f7931a',
            emoji: '⚡',
            description: 'Las órdenes que ves aquí son del exchange P2P <strong style="color:#f7931a;">Mostro</strong>, un protocolo descentralizado sobre Nostr y Lightning Network. Sin KYC, sin custodio.',
            steps: [
                'Descarga una wallet Lightning (Phoenix, Zeus, Breez)',
                'Instala el <a href="https://github.com/MostroP2P/mobile/releases" target="_blank" rel="noopener" style="color:var(--color-gold);">cliente Mostro para Android</a>',
                'Configura la npub de NostroMostro (instancia española)',
                'Toma una orden o crea la tuya',
                'Al confirmar el pago fiat, los sats se liberan'
            ],
            showMostroNpub: true,
            links: [
                { label: '📱 App Android', href: 'https://github.com/MostroP2P/mobile/releases', variant: 'primary' },
                { label: '💬 Telegram',    href: 'https://t.me/nostromostro',                      variant: 'secondary' },
                { label: '📖 Docs',        href: 'https://mostro.network/es/',                     variant: 'muted' }
            ]
        },
        lnp2pbot: {
            label: 'LNp2pBot',
            color: '#5b9bd5',
            emoji: '🤖',
            description: 'Las órdenes que ves aquí son de <strong style="color:#5b9bd5;">LNp2pBot</strong>, un bot P2P de Telegram sobre Lightning Network. Sin KYC, sin custodio del bot durante el pago fiat.',
            steps: [
                'Abre Telegram y accede al <a href="https://t.me/lnp2pBot" target="_blank" rel="noopener" style="color:var(--color-gold);">bot @lnp2pBot</a>',
                'Envía <code>/start</code> al bot para iniciar',
                'Usa <code>/buy</code> o <code>/sell</code> para ver órdenes activas',
                'Toma la orden deseada o crea la tuya con <code>/takebuy</code> / <code>/takesell</code>',
                'Paga con tu wallet Lightning y confirma en el bot; los sats se liberan tras el pago fiat'
            ],
            showMostroNpub: false,
            links: [
                { label: '🤖 Abrir bot',  href: 'https://t.me/lnp2pBot',    variant: 'primary' },
                { label: '📖 Web oficial', href: 'https://lnp2pbot.com',    variant: 'secondary' },
                { label: '💬 Comunidad',   href: 'https://t.me/lnp2pbotES', variant: 'muted' }
            ]
        },
        robosats: {
            label: 'RoboSats',
            color: '#7b68ee',
            emoji: '🤖',
            description: 'Las órdenes que ves aquí son de <strong style="color:#7b68ee;">RoboSats</strong>, un exchange P2P web sobre Lightning con identidades "Robot" anónimas. Sin KYC, sin registro.',
            steps: [
                'Abre la <a href="https://unsafe.robosats.org" target="_blank" rel="noopener" style="color:var(--color-gold);">web de RoboSats</a> (o la versión Tor para máxima privacidad)',
                'Genera tu identidad anónima (Robot token) — guárdala bien',
                'Explora el "Order Book" y toma una orden, o crea la tuya',
                'Bloquea el bond Lightning (pequeño hold invoice como garantía)',
                'Completa el pago fiat por chat cifrado; los sats se liberan al confirmar'
            ],
            showMostroNpub: false,
            links: [
                { label: '🌐 Abrir RoboSats', href: 'https://unsafe.robosats.org',  variant: 'primary' },
                { label: '📖 Docs',           href: 'https://learn.robosats.org',   variant: 'secondary' },
                { label: '💬 Telegram',       href: 'https://t.me/robosats_es',     variant: 'muted' }
            ]
        }
    };

    // Fallback para plataformas desconocidas
    const PLATFORM_GUIDE_FALLBACK = {
        label: 'P2P',
        color: 'var(--color-teal-light)',
        emoji: '⚡',
        description: 'Esta orden ha sido publicada en la red Nostr mediante el estándar NIP-69 (kind 38383). LiberBit World solo agrega y muestra las órdenes: para operar debes usar el cliente de la plataforma que la publicó.',
        steps: [
            'Identifica la plataforma origen en la insignia de la orden',
            'Instala o abre el cliente oficial de esa plataforma',
            'Busca la orden por su ID o toma una equivalente en su interfaz',
            'Completa el trade siguiendo el flujo del protocolo correspondiente'
        ],
        showMostroNpub: false,
        links: []
    };

    // ── State ────────────────────────────────────────────────
    let _orders = [];
    let _sub = null;
    let _btcEurPrice = null;
    let _priceLastFetch = 0;
    let _activeCurrency = 'all';   // 'all' | 'EUR' | 'USD' | ...
    let _activeType = 'all';       // 'all' | 'buy' | 'sell'
    let _activePlatform = 'all';   // 'all' | 'mostro' | 'lnp2pbot' | 'robosats'
    let _activeSort = 'newest';    // 'newest' | 'oldest' | 'premium_asc' | 'premium_desc' | 'amount_asc' | 'amount_desc'
    let _isLoading = false;

    // ── Helpers ──────────────────────────────────────────────
    // SEC-27: Unified with LBW.escapeHtml (canonical in escape-utils.js)
    // [M-10] LBW.escapeHtml siempre disponible (escape-utils.js carga primero).
    const _esc = LBW.escapeHtml;

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

    // ── Type badge (taker perspective: what the user can DO) ─
    function _typeBadge(type) {
        if (type === 'sell') {
            // Maker sells → taker can BUY
            return `<span style="font-size:0.7rem;background:rgba(76,175,80,0.15);color:#4CAF50;padding:0.15rem 0.5rem;border-radius:20px;border:1px solid #4CAF5044;font-weight:600;">COMPRAR</span>`;
        }
        // Maker buys → taker can SELL
        return `<span style="font-size:0.7rem;background:rgba(33,150,243,0.15);color:#2196F3;padding:0.15rem 0.5rem;border-radius:20px;border:1px solid #2196F344;font-weight:600;">VENDER</span>`;
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
        card.style.cssText = 'background:var(--color-bg-card);border:2px solid var(--color-border);border-radius:16px;overflow:hidden;transition:all 0.3s;cursor:pointer;';
        card.onclick = () => LBW_P2P.openOrderInfo(order.platform);

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

        // Compute platform-aware styling for the "Operar" button
        const _pKey = (order.platform || '').toLowerCase();
        const _pGuide = PLATFORM_GUIDES[_pKey] || PLATFORM_GUIDE_FALLBACK;
        const _pBtnColor = _pGuide.color;
        // Only mostro's orange has a translucent bg baked in; other platforms use a neutral tint
        const _pBtnBg = _pKey === 'mostro' ? 'rgba(247,147,26,0.15)' : 'rgba(255,255,255,0.04)';
        const _pKeyEsc = _esc(_pKey);

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
                    <button data-lbw-action="p2pOpenOrderInfo" data-platform="${_pKeyEsc}" style="padding:0.3rem 0.7rem;background:${_pBtnBg};border:1px solid ${_pBtnColor};border-radius:8px;color:${_pBtnColor};cursor:pointer;font-size:0.7rem;font-weight:600;">
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

        // Apply platform filter
        if (_activePlatform !== 'all') {
            filtered = filtered.filter(o => (o.platform || '').toLowerCase() === _activePlatform.toLowerCase());
        }

        // Apply sort
        filtered.sort((a, b) => {
            switch (_activeSort) {
                case 'oldest':
                    return a.created_at - b.created_at;
                case 'premium_asc':
                    return (parseFloat(a.premium) || 0) - (parseFloat(b.premium) || 0);
                case 'premium_desc':
                    return (parseFloat(b.premium) || 0) - (parseFloat(a.premium) || 0);
                case 'amount_asc':
                    return (parseFloat(a.fiatAmount) || 0) - (parseFloat(b.fiatAmount) || 0);
                case 'amount_desc':
                    return (parseFloat(b.fiatAmount) || 0) - (parseFloat(a.fiatAmount) || 0);
                default: // newest
                    return b.created_at - a.created_at;
            }
        });

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
            <span style="color:#4CAF50;">🟢 ${sells} para comprar</span>
            <span style="color:#2196F3;">🔵 ${buys} para vender</span>
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

        const pending = _orders.filter(o => o.status === 'pending');

        // Collect unique currencies and platforms from active orders
        const currencies = [...new Set(pending.map(o => o.currency).filter(Boolean))];
        const platforms = [...new Set(pending.map(o => (o.platform || '').toLowerCase()).filter(Boolean))];

        const platformMeta = {
            mostro:    { label: 'Mostro',    color: '#f7931a' },
            lnp2pbot:  { label: 'LNp2pBot',  color: '#5b9bd5' },
            robosats:  { label: 'RoboSats',  color: '#7b68ee' },
        };

        const sortOptions = [
            { value: 'newest',       label: '🕐 Más recientes' },
            { value: 'oldest',       label: '🕐 Más antiguas'  },
            { value: 'premium_asc',  label: '📉 Premium ↑'     },
            { value: 'premium_desc', label: '📈 Premium ↓'     },
            { value: 'amount_asc',   label: '💶 Monto ↑'       },
            { value: 'amount_desc',  label: '💶 Monto ↓'       },
        ];

        function _btnStyle(active, color) {
            const c = color || 'var(--color-gold)';
            const bg = color ? `${color}22` : 'rgba(229,185,92,0.15)';
            return active
                ? `padding:0.35rem 0.8rem;background:${bg};border:1px solid ${c};border-radius:8px;color:${c};cursor:pointer;font-size:0.8rem;font-weight:600;`
                : `padding:0.35rem 0.8rem;background:transparent;border:1px solid var(--color-border);border-radius:8px;color:var(--color-text-secondary);cursor:pointer;font-size:0.8rem;`;
        }

        container.innerHTML = `
            <!-- Fila 1: Tipo -->
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.5rem;align-items:center;">
                <span style="font-size:0.7rem;color:var(--color-text-secondary);white-space:nowrap;">Quiero:</span>
                <button onclick="LBW_P2P.filterType('all')"  style="${_btnStyle(_activeType==='all')}">🌐 Todas</button>
                <button onclick="LBW_P2P.filterType('sell')" style="${_btnStyle(_activeType==='sell','#4CAF50')}">🟢 Comprar BTC</button>
                <button onclick="LBW_P2P.filterType('buy')"  style="${_btnStyle(_activeType==='buy','#2196F3')}">🔵 Vender BTC</button>
            </div>

            <!-- Fila 2: Plataforma -->
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.5rem;align-items:center;">
                <span style="font-size:0.7rem;color:var(--color-text-secondary);white-space:nowrap;">Plataforma:</span>
                <button onclick="LBW_P2P.filterPlatform('all')" style="${_btnStyle(_activePlatform==='all')}">🌐 Todas</button>
                ${platforms.map(p => {
                    const meta = platformMeta[p] || { label: p, color: 'var(--color-teal-light)' };
                    return `<button data-lbw-action="p2pFilterPlatform" data-value="${_esc(p)}" style="${_btnStyle(_activePlatform===p, meta.color)}">${_esc(meta.label)}</button>`;
                }).join('')}
            </div>

            <!-- Fila 3: Moneda + Ordenar -->
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem;align-items:center;">
                <span style="font-size:0.7rem;color:var(--color-text-secondary);white-space:nowrap;">Moneda:</span>
                <button onclick="LBW_P2P.filterCurrency('all')" style="${_btnStyle(_activeCurrency==='all')}">🌍 Todas</button>
                ${currencies.map(c => `
                    <button data-lbw-action="p2pFilterCurrency" data-value="${_esc(c)}" style="${_btnStyle(_activeCurrency===c)}">${_esc(c)}</button>
                `).join('')}
                <span style="flex:1;"></span>
                <span style="font-size:0.7rem;color:var(--color-text-secondary);white-space:nowrap;">Ordenar:</span>
                <select onchange="LBW_P2P.sortBy(this.value)"
                    style="padding:0.35rem 0.6rem;background:var(--color-bg-card);border:1px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);cursor:pointer;font-size:0.8rem;">
                    ${sortOptions.map(o =>
                        `<option value="${o.value}" ${_activeSort===o.value?'selected':''}>${o.label}</option>`
                    ).join('')}
                </select>
            </div>
        `;
    }

    // ── Info modal — dynamic per platform ───────────────────
    // Shows how to operate on the platform that published the order
    // (Mostro / LNp2pBot / RoboSats / fallback).
    function openOrderInfo(platform) {
        const key = (platform || '').toString().toLowerCase();
        const guide = PLATFORM_GUIDES[key] || PLATFORM_GUIDE_FALLBACK;

        // Always remove and recreate the modal so it reflects the current platform
        const existing = document.getElementById('p2pInfoModal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'p2pInfoModal';
        modal.dataset.platform = key;
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:1rem;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };

        // Build steps list (steps may contain trusted inline HTML from PLATFORM_GUIDES constant)
        const stepsHtml = guide.steps.map(s => `<li>${s}</li>`).join('');

        // Build NostroMostro npub block (only for Mostro)
        const npubBlock = guide.showMostroNpub ? `
            <div style="background:var(--color-bg-dark);border:1px solid var(--color-border);border-radius:8px;padding:0.75rem;margin-bottom:1rem;">
                <label style="font-size:0.7rem;color:var(--color-gold);display:block;margin-bottom:0.3rem;">npub de NostroMostro (España)</label>
                <div style="display:flex;gap:0.5rem;align-items:center;">
                    <code id="mostroNpubText" style="font-size:0.6rem;color:var(--color-text-primary);word-break:break-all;flex:1;">${NOSTROMOSTRO_NPUB}</code>
                    <button data-lbw-action="p2pCopyMostroNpub" style="background:rgba(229,185,92,0.15);border:1px solid var(--color-gold);border-radius:6px;color:var(--color-gold);cursor:pointer;padding:0.3rem 0.5rem;font-size:0.75rem;white-space:nowrap;">📋</button>
                </div>
            </div>` : '';

        // Build links row
        const linkStyles = {
            primary:   `background:${guide.color}26;border:1px solid ${guide.color};color:${guide.color};`,
            secondary: `background:rgba(44,95,111,0.2);border:1px solid var(--color-teal-light);color:var(--color-teal-light);`,
            muted:     `background:rgba(255,255,255,0.05);border:1px solid var(--color-border);color:var(--color-text-secondary);`
        };
        const linksHtml = (guide.links || []).map(l => {
            const s = linkStyles[l.variant] || linkStyles.muted;
            return `<a href="${_esc(l.href)}" target="_blank" rel="noopener" style="flex:1;text-align:center;padding:0.5rem;border-radius:8px;text-decoration:none;font-size:0.8rem;font-weight:600;${s}">${l.label}</a>`;
        }).join('');
        const linksBlock = linksHtml ? `<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">${linksHtml}</div>` : '';

        modal.innerHTML = `
            <div style="background:var(--color-bg-card);border:2px solid ${guide.color};border-radius:16px;max-width:480px;width:100%;max-height:80vh;overflow-y:auto;padding:1.5rem;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
                    <h3 style="color:${guide.color};margin:0;">${guide.emoji} Cómo operar en ${_esc(guide.label)} P2P</h3>
                    <button onclick="document.getElementById('p2pInfoModal').remove()" style="background:none;border:none;color:var(--color-text-secondary);font-size:1.2rem;cursor:pointer;">✕</button>
                </div>

                <p style="color:var(--color-text-secondary);font-size:0.85rem;margin-bottom:1rem;">
                    ${guide.description}
                </p>

                <div style="background:${guide.color}14;border:1px solid ${guide.color}33;border-radius:12px;padding:1rem;margin-bottom:1rem;">
                    <h4 style="color:${guide.color};margin-bottom:0.5rem;font-size:0.9rem;">📋 Pasos para operar</h4>
                    <ol style="color:var(--color-text-primary);font-size:0.8rem;padding-left:1.2rem;margin:0;line-height:1.8;">
                        ${stepsHtml}
                    </ol>
                </div>

                ${npubBlock}

                ${linksBlock}
            </div>
        `;

        document.body.appendChild(modal);
    }

    // Back-compat alias — anything still calling openMostroInfo() gets the Mostro guide
    function openMostroInfo() { return openOrderInfo('mostro'); }

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
                        // SEC-19: Fail-safe signature/structure validation.
                        // If validator is missing, reject instead of processing.
                        if (typeof LBW_Nostr === 'undefined' || typeof LBW_Nostr.validateIncomingEvent !== 'function') {
                            console.error('[P2P] validateIncomingEvent unavailable — rejecting event');
                            return;
                        }
                        if (!LBW_Nostr.validateIncomingEvent(event, 'p2p')) return;
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

                        // Solo actualizar el grid durante la carga — la barra de filtros
                        // se reconstruye en oneose para que las selecciones del usuario
                        // no se interrumpan mientras llegan órdenes del relay.
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

    function filterPlatform(platform) {
        _activePlatform = platform;
        _renderFilterBar();
        _renderGrid();
    }

    function sortBy(criterion) {
        _activeSort = criterion;
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
        filterPlatform,
        sortBy,
        openOrderInfo,
        openMostroInfo,
        getOrders: () => [..._orders],
    };
})();

window.LBW_P2P = LBW_P2P;
console.log('⚡ P2P Exchange (NIP-69 Aggregator) listo');

// ═══════════════════════════════════════════════════════════════════
// SEC-11/12: Event delegation for P2P exchange actions.
// ═══════════════════════════════════════════════════════════════════
(function installP2PEventDelegation() {
    if (window.__lbwP2PListenerInstalled) return;
    window.__lbwP2PListenerInstalled = true;

    var MOSTRO_NPUB = 'npub1qqqvcqssrmpfa65uuc3jtp6jh8ta5ekz0pz76f5ydhgtplrnddqqrqe7xr';

    document.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-lbw-action]') : null;
        if (!el) return;
        var action = el.dataset.lbwAction;
        if (!action || action.indexOf('p2p') !== 0) return;
        try {
            switch (action) {
                case 'p2pFilterPlatform':
                    LBW_P2P.filterPlatform(el.dataset.value);
                    break;
                case 'p2pFilterCurrency':
                    LBW_P2P.filterCurrency(el.dataset.value);
                    break;
                case 'p2pCopyMostroNpub':
                    navigator.clipboard.writeText(MOSTRO_NPUB);
                    var orig = el.textContent;
                    el.textContent = '✅';
                    setTimeout(function () { el.textContent = orig || '📋'; }, 1500);
                    break;
                // [SEC-A2] Reemplaza el onclick inline anterior que interpolaba el
                // pubkey de la plataforma (controlado por relay público) en un
                // literal JS dentro de un atributo HTML — vector XSS si el navegador
                // des-entitizaba el escape antes de pasarlo al motor JS.
                case 'p2pOpenOrderInfo':
                    e.stopPropagation();
                    LBW_P2P.openOrderInfo(el.dataset.platform);
                    break;
            }
        } catch (err) {
            console.error('[P2P delegation] Error dispatching', action, err);
        }
    });
})();

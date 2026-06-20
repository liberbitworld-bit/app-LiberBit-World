// ============================================================
// LiberBit World — Transparency Section (transparency.js)
//
// Vista pública de:
//   - Méritos: toda emisión de kind:31002 (issuer, recipient, amount,
//     category, reason, when). Datos vienen de LBW_Merits.getAllMerits()
//     que mantiene la lista plana sincronizada con los relays.
//   - Wallet: balance + movimientos de la treasury LBW vía endpoint
//     serverless propio (/api/transparency/wallet) que hace proxy a la
//     API de coinos.io con un token almacenado como env var.
//
// El módulo es 100% cliente-side; el serverless del wallet vendrá en una
// fase aparte cuando el username de coinos + el token estén disponibles.
// Mientras tanto la sub-sección Wallet muestra un placeholder informativo.
// ============================================================

const LBW_Transparency = (() => {
    'use strict';

    let _currentTab = 'merits';
    let _meritFilter = { category: '', search: '' };

    function _esc(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function _shortNpub(pubkey) {
        if (!pubkey) return '—';
        if (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.pubkeyToNpub) {
            try {
                const npub = LBW_Nostr.pubkeyToNpub(pubkey);
                if (npub) return npub.substring(0, 12) + '…' + npub.substring(npub.length - 4);
            } catch (e) {}
        }
        return pubkey.substring(0, 10) + '…' + pubkey.substring(pubkey.length - 4);
    }

    // Sanitiza el "reason" del mérito: trunca a 80 chars y escapa HTML.
    // No necesitamos anonimizar identidad porque el reason es lo que el
    // Génesis escribió como motivo de la emisión, no es un memo de pago
    // anónimo. Quien escribe la razón sabe que es público.
    function _sanitizeReason(s, max = 80) {
        if (!s) return '';
        const str = String(s).trim();
        if (str.length <= max) return _esc(str);
        return _esc(str.substring(0, max - 1)) + '…';
    }

    function _formatDate(unix) {
        if (!unix) return '—';
        const d = new Date(unix * 1000);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        const hour = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        return `${day}/${month}/${year} ${hour}:${min}`;
    }

    function switchTab(tab) {
        _currentTab = tab;
        // Toggle styles
        document.querySelectorAll('[data-tx-tab]').forEach(btn => {
            const isActive = btn.dataset.txTab === tab;
            btn.style.background = isActive ? 'rgba(229,185,92,0.15)' : 'transparent';
            btn.style.borderColor = isActive ? 'var(--color-gold)' : 'var(--color-border)';
            btn.style.color = isActive ? 'var(--color-gold)' : 'var(--color-text-secondary)';
            btn.style.fontWeight = isActive ? '700' : '400';
        });
        // Toggle panels
        const pMerits = document.getElementById('transparencyMeritsPanel');
        const pWallet = document.getElementById('transparencyWalletPanel');
        if (pMerits) pMerits.style.display = (tab === 'merits') ? '' : 'none';
        if (pWallet) pWallet.style.display = (tab === 'wallet') ? '' : 'none';
        if (tab === 'merits') renderMeritsPanel();
        else renderWalletPanel();
    }

    function _resolveNameInto(pubkey, slotSelector) {
        if (!pubkey || typeof LBW_Sync === 'undefined' || !LBW_Sync.resolveProfile) return;
        LBW_Sync.resolveProfile(pubkey).then(p => {
            if (!p) return;
            const name = p.name || p.display_name || '';
            if (!name) return;
            document.querySelectorAll(slotSelector).forEach(el => {
                el.textContent = name;
                el.title = pubkey;
            });
        }).catch(() => {});
    }

    // Cache de datos del ledger Supabase para evitar refetch en cada
    // re-render por cambio de filtro. Se invalida al cabo de 60s o cuando
    // el usuario pulsa "Actualizar".
    let _supabaseDataCache = null;
    let _supabaseDataCacheAt = 0;
    const SUPABASE_CACHE_TTL_MS = 60 * 1000;

    async function _fetchSupabaseLedger(force) {
        if (!force && _supabaseDataCache && (Date.now() - _supabaseDataCacheAt < SUPABASE_CACHE_TTL_MS)) {
            return _supabaseDataCache;
        }
        if (typeof supabaseClient === 'undefined') return null;
        try {
            // Stats agregadas (mismo getter que usa el Ledger Maestro)
            let stats = null;
            if (typeof LBW_MeritsSync !== 'undefined' && LBW_MeritsSync.loadSupabaseLedger) {
                const ledger = await LBW_MeritsSync.loadSupabaseLedger({ limit: 999 });
                if (ledger && ledger.stats) stats = ledger.stats;
            }
            // Lista de emisiones individuales (kind:31002) más recientes
            const { data, error } = await supabaseClient
                .from('lbwm_merit_events')
                .select('id, pubkey, npub, amount, category, reason, awarded_by, nostr_d_tag, nostr_created_at, source')
                .order('nostr_created_at', { ascending: false })
                .limit(500);
            if (error) {
                console.warn('[Transparency] Supabase lbwm_merit_events error:', error.message);
                return stats ? { stats, entries: [] } : null;
            }
            const entries = (data || []).map(r => ({
                id: r.id,
                dTag: r.nostr_d_tag || '',
                recipient: r.pubkey,
                issuer: r.awarded_by || '',
                amount: r.amount || 0,
                category: r.category || '',
                reason: r.reason || '',
                created_at: r.nostr_created_at || 0,
                source: r.source || ''
            }));
            _supabaseDataCache = { stats, entries };
            _supabaseDataCacheAt = Date.now();
            return _supabaseDataCache;
        } catch (e) {
            console.warn('[Transparency] _fetchSupabaseLedger error:', e.message);
            return null;
        }
    }

    async function renderMeritsPanel() {
        const panel = document.getElementById('transparencyMeritsPanel');
        if (!panel) return;
        if (typeof LBW_Merits === 'undefined' || !LBW_Merits.getAllMerits) {
            panel.innerHTML = '<div class="placeholder"><p>Sistema de méritos no disponible.</p></div>';
            return;
        }

        // Prefer Supabase (canonical, igual fuente que Ledger Maestro).
        // Fallback a memoria local si Supabase falla.
        const supa = await _fetchSupabaseLedger(false);
        let stats, merits, dataSource;
        if (supa && supa.stats) {
            const cats = supa.stats.byCategory || {};
            // Adaptar formato: byCategory ya viene aggregado por Supabase
            // (econ, prod, resp, fin, fund). Construimos el shape esperado
            // por el render (mismo objeto que LBW_Merits.getAllMeritsStats).
            const totalAmount = supa.stats.totalMerits || 0;
            const totalEvents = (supa.entries || []).length;
            const uniqueIssuers = new Set();
            const uniqueRecipients = new Set();
            (supa.entries || []).forEach(e => {
                if (e.issuer) uniqueIssuers.add(e.issuer);
                if (e.recipient) uniqueRecipients.add(e.recipient);
            });
            stats = {
                count: totalEvents,
                total: totalAmount,
                byCategory: cats,
                uniqueIssuers: uniqueIssuers.size || supa.stats.totalUsers || 0,
                uniqueRecipients: supa.stats.totalUsers || uniqueRecipients.size
            };
            // Aplicar filtros sobre la lista de Supabase
            let list = supa.entries.slice();
            if (_meritFilter.category) list = list.filter(m => m.category === _meritFilter.category);
            merits = list;
            dataSource = 'supabase';
        } else {
            stats = LBW_Merits.getAllMeritsStats();
            merits = LBW_Merits.getAllMerits({
                category: _meritFilter.category || undefined,
                limit: 500
            });
            dataSource = 'memory';
        }

        const searchQ = (_meritFilter.search || '').toLowerCase();
        const filtered = searchQ
            ? merits.filter(m =>
                (m.reason || '').toLowerCase().includes(searchQ) ||
                (m.category || '').toLowerCase().includes(searchQ)
              )
            : merits;

        // Render
        const catEntries = Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1]);

        // Bloque "Tu actividad personal" — solo current user, los activity
        // merits son client-side (no se publican como kind:31002).
        let myActivityHtml = '';
        try {
            if (typeof getUnifiedMerits === 'function' && typeof LBW_Nostr !== 'undefined' && LBW_Nostr.isLoggedIn()) {
                const u = getUnifiedMerits();
                if (u && u.activityMerits >= 0) {
                    const a = u.activity || {};
                    myActivityHtml = `
                        <div style="background:rgba(81,207,102,0.06);border:1px solid rgba(81,207,102,0.25);border-radius:10px;padding:0.85rem 1rem;margin-bottom:1.25rem;">
                            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;flex-wrap:wrap;gap:0.5rem;">
                                <div style="font-weight:700;color:#51cf66;font-size:0.92rem;">🏃 Tu actividad personal</div>
                                <div style="font-size:0.78rem;color:var(--color-text-secondary);">Nostr <strong style="color:var(--color-gold);">${(u.nostrMerits||0).toLocaleString('es-ES')}</strong> + Actividad <strong style="color:#51cf66;">${(u.activityMerits||0).toLocaleString('es-ES')}</strong> = <strong>${(u.total||0).toLocaleString('es-ES')}</strong></div>
                            </div>
                            <div style="display:flex;flex-wrap:wrap;gap:0.4rem;font-size:0.78rem;color:var(--color-text-primary);">
                                <span style="background:rgba(13,23,30,0.6);padding:0.25rem 0.6rem;border-radius:14px;">💬 ${a.posts||0} mensajes</span>
                                <span style="background:rgba(13,23,30,0.6);padding:0.25rem 0.6rem;border-radius:14px;">🛍️ ${a.offers||0} ofertas</span>
                                <span style="background:rgba(13,23,30,0.6);padding:0.25rem 0.6rem;border-radius:14px;">🗳️ ${a.votes||0} votos</span>
                                <span style="background:rgba(13,23,30,0.6);padding:0.25rem 0.6rem;border-radius:14px;">📋 ${a.proposals||0} propuestas</span>
                            </div>
                            <div style="font-size:0.7rem;color:var(--color-text-secondary);opacity:0.75;margin-top:0.5rem;line-height:1.4;">
                                Cada acción cuenta 10 pts (cap ${u.activityCap||300} pts). Esta cifra se calcula en tu cliente — no se publica como evento Nostr y por eso solo se ve la tuya, no la de otros usuarios. Las emisiones formales kind:31002 de los Génesis sí son públicas y aparecen abajo.
                            </div>
                        </div>
                    `;
                }
            }
        } catch (e) {}

        const sourceBadge = dataSource === 'supabase'
            ? `<span style="font-size:0.65rem;background:rgba(81,207,102,0.15);color:#51cf66;padding:0.2rem 0.5rem;border-radius:10px;border:1px solid rgba(81,207,102,0.3);">📚 Ledger Maestro (Supabase)</span>`
            : `<span style="font-size:0.65rem;background:rgba(255,167,38,0.15);color:#FFA726;padding:0.2rem 0.5rem;border-radius:10px;border:1px solid rgba(255,167,38,0.3);">💾 Cache local (Supabase no disponible)</span>`;

        panel.innerHTML = `
            ${myActivityHtml}
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;flex-wrap:wrap;gap:0.5rem;">
                <div style="font-size:0.78rem;color:var(--color-text-secondary);font-weight:600;">📜 Emisiones formales (kind:31002 por Génesis)</div>
                <div style="display:flex;gap:0.4rem;align-items:center;">
                    ${sourceBadge}
                    <button onclick="LBW_Transparency.refreshMerits()"
                        style="font-size:0.7rem;padding:0.25rem 0.6rem;border-radius:10px;background:transparent;border:1px solid var(--color-border);color:var(--color-text-secondary);cursor:pointer;">
                        🔄 Actualizar
                    </button>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.75rem;margin-bottom:1.25rem;">
                <div class="stat-card" style="background:rgba(229,185,92,0.08);border:1px solid rgba(229,185,92,0.25);border-radius:10px;padding:0.85rem;text-align:center;">
                    <div style="font-size:1.6rem;font-weight:700;color:var(--color-gold);">${stats.total.toLocaleString('es-ES')}</div>
                    <div style="font-size:0.72rem;color:var(--color-text-secondary);margin-top:0.15rem;">LBWM emitidos</div>
                </div>
                <div class="stat-card" style="background:rgba(64,196,255,0.08);border:1px solid rgba(64,196,255,0.25);border-radius:10px;padding:0.85rem;text-align:center;">
                    <div style="font-size:1.6rem;font-weight:700;color:#40C4FF;">${stats.count.toLocaleString('es-ES')}</div>
                    <div style="font-size:0.72rem;color:var(--color-text-secondary);margin-top:0.15rem;">Emisiones (eventos)</div>
                </div>
                <div class="stat-card" style="background:rgba(81,207,102,0.08);border:1px solid rgba(81,207,102,0.25);border-radius:10px;padding:0.85rem;text-align:center;">
                    <div style="font-size:1.6rem;font-weight:700;color:#51cf66;">${stats.uniqueIssuers}</div>
                    <div style="font-size:0.72rem;color:var(--color-text-secondary);margin-top:0.15rem;">Génesis emisores</div>
                </div>
                <div class="stat-card" style="background:rgba(206,147,216,0.08);border:1px solid rgba(206,147,216,0.25);border-radius:10px;padding:0.85rem;text-align:center;">
                    <div style="font-size:1.6rem;font-weight:700;color:#CE93D8;">${stats.uniqueRecipients}</div>
                    <div style="font-size:0.72rem;color:var(--color-text-secondary);margin-top:0.15rem;">Receptores únicos</div>
                </div>
            </div>

            ${catEntries.length > 0 ? `
                <div style="margin-bottom:1.25rem;">
                    <div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:0.4rem;">Emitidos por categoría</div>
                    <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">
                        ${catEntries.map(([cat, amt]) => `
                            <button onclick="LBW_Transparency.setMeritCategoryFilter('${_esc(cat)}')"
                                style="font-size:0.78rem;padding:0.3rem 0.7rem;border-radius:14px;background:${_meritFilter.category === cat ? 'rgba(229,185,92,0.2)' : 'rgba(44,95,111,0.1)'};border:1px solid ${_meritFilter.category === cat ? 'var(--color-gold)' : 'var(--color-border)'};color:${_meritFilter.category === cat ? 'var(--color-gold)' : 'var(--color-text-primary)'};cursor:pointer;">
                                ${_esc(cat)}: <strong>${amt.toLocaleString('es-ES')}</strong>
                            </button>
                        `).join('')}
                        ${_meritFilter.category ? `
                            <button onclick="LBW_Transparency.setMeritCategoryFilter('')"
                                style="font-size:0.78rem;padding:0.3rem 0.7rem;border-radius:14px;background:transparent;border:1px dashed var(--color-text-secondary);color:var(--color-text-secondary);cursor:pointer;">
                                ✕ Limpiar filtro
                            </button>` : ''}
                    </div>
                </div>` : ''}

            <div style="margin-bottom:0.75rem;">
                <input type="text" id="meritSearchInput" placeholder="🔍 Buscar por razón o categoría..."
                    value="${_esc(_meritFilter.search)}"
                    oninput="LBW_Transparency.setMeritSearch(this.value)"
                    style="width:100%;padding:0.6rem 0.75rem;background:var(--color-bg-dark);border:1px solid var(--color-border);border-radius:8px;color:var(--color-text-primary);font-family:var(--font-display);">
            </div>

            ${filtered.length === 0 ? `
                <div class="placeholder" style="text-align:center;padding:2rem;color:var(--color-text-secondary);">
                    <div style="font-size:2rem;margin-bottom:0.5rem;">🏅</div>
                    <p>No hay méritos que coincidan con el filtro actual.</p>
                </div>
            ` : `
                <div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:0.5rem;">
                    Mostrando ${filtered.length} de ${stats.count} emisiones (más recientes primero):
                </div>
                <div style="display:flex;flex-direction:column;gap:0.5rem;">
                    ${filtered.map(m => `
                        <div style="background:var(--color-bg-card);border:1px solid var(--color-border);border-radius:8px;padding:0.7rem 0.9rem;">
                            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.3rem;">
                                <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
                                    <span style="font-weight:700;color:var(--color-gold);font-size:1rem;">+${m.amount.toLocaleString('es-ES')}</span>
                                    <span style="font-size:0.72rem;background:rgba(64,196,255,0.12);color:#40C4FF;padding:0.15rem 0.55rem;border-radius:14px;border:1px solid rgba(64,196,255,0.25);">${_esc(m.category)}</span>
                                </div>
                                <span style="font-size:0.72rem;color:var(--color-text-secondary);font-family:var(--font-mono);">${_formatDate(m.created_at)}</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:0.4rem;font-size:0.82rem;color:var(--color-text-primary);flex-wrap:wrap;">
                                <span data-pubkey-slot="${m.issuer}" style="font-family:var(--font-mono);font-weight:600;" title="${_esc(m.issuer)}">${_shortNpub(m.issuer)}</span>
                                <span style="color:var(--color-text-secondary);">→</span>
                                <span data-pubkey-slot="${m.recipient}" style="font-family:var(--font-mono);" title="${_esc(m.recipient)}">${_shortNpub(m.recipient)}</span>
                            </div>
                            ${m.reason ? `
                                <div style="margin-top:0.35rem;font-size:0.78rem;color:var(--color-text-secondary);font-style:italic;">
                                    "${_sanitizeReason(m.reason, 120)}"
                                </div>` : ''}
                        </div>
                    `).join('')}
                </div>
            `}
        `;

        // Resolver nombres async
        const uniquePubkeys = new Set();
        filtered.forEach(m => { if (m.issuer) uniquePubkeys.add(m.issuer); if (m.recipient) uniquePubkeys.add(m.recipient); });
        for (const pk of uniquePubkeys) {
            _resolveNameInto(pk, `[data-pubkey-slot="${pk}"]`);
        }
    }

    function renderWalletPanel() {
        const panel = document.getElementById('transparencyWalletPanel');
        if (!panel) return;
        // Placeholder hasta que el endpoint /api/transparency/wallet esté
        // disponible (requiere token coinos en Vercel env vars).
        panel.innerHTML = `
            <div style="background:var(--color-bg-card);border:1px solid var(--color-border);border-radius:12px;padding:1.5rem;text-align:center;">
                <div style="font-size:2.5rem;margin-bottom:0.75rem;">💰</div>
                <h3 style="color:var(--color-gold);margin-bottom:0.5rem;">Wallet de la treasury LBW</h3>
                <p style="color:var(--color-text-secondary);font-size:0.85rem;line-height:1.5;margin-bottom:1rem;">
                    Saldo, donaciones recibidas y pagos emitidos. Datos en tiempo real vía API de coinos.io.
                </p>
                <div style="background:rgba(255,167,38,0.08);border:1px solid rgba(255,167,38,0.3);border-radius:8px;padding:0.85rem;margin-top:1rem;">
                    <div style="color:#FFA726;font-weight:600;font-size:0.85rem;margin-bottom:0.3rem;">⚙️ Pendiente de configuración</div>
                    <div style="color:var(--color-text-secondary);font-size:0.78rem;line-height:1.5;">
                        Falta crear la dirección dedicada en coinos.io y añadir el access token como variable de entorno en Vercel. En cuanto esté listo, este panel mostrará balance + historial completo.
                    </div>
                </div>
            </div>
        `;
    }

    function setMeritCategoryFilter(cat) {
        _meritFilter.category = cat || '';
        renderMeritsPanel();
    }

    function setMeritSearch(val) {
        _meritFilter.search = (val || '').trim();
        // Re-render del panel — preservar el cursor del input es overkill
        // aquí, dejamos que el usuario re-focusee si quiere seguir tipeando.
        renderMeritsPanel();
        // Devolver el focus al input para mejor UX
        const input = document.getElementById('meritSearchInput');
        if (input) {
            input.focus();
            const len = input.value.length;
            input.setSelectionRange(len, len);
        }
    }

    // Arranca la suscripción a méritos si todavía no está activa.
    // Importante: el feed de méritos en LBW_Merits.subscribeMerits solo
    // se abre cuando alguien lo pide (típicamente la sección Gobernanza
    // o Méritos). Si el usuario entra directo a Transparencia sin pasar
    // por ahí, _allMerits queda vacío. Aquí lo forzamos.
    let _meritsSubStarted = false;
    let _meritsRefreshTimer = null;
    function _ensureMeritsSubscription() {
        if (_meritsSubStarted) return;
        try {
            if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.startMerits) {
                LBW_NostrBridge.startMerits();
                _meritsSubStarted = true;
                // Re-render del panel cada 2s durante el primer minuto para
                // recoger eventos que el relay vaya enviando. Después
                // paramos para no consumir recursos.
                let ticks = 0;
                _meritsRefreshTimer = setInterval(() => {
                    if (_currentTab === 'merits') {
                        try { renderMeritsPanel(); } catch (e) {}
                    }
                    ticks++;
                    if (ticks >= 30) {
                        clearInterval(_meritsRefreshTimer);
                        _meritsRefreshTimer = null;
                    }
                }, 2000);
            } else if (typeof LBW_Merits !== 'undefined' && LBW_Merits.subscribeMerits) {
                // Fallback: bridge no disponible, llamamos directo
                LBW_Merits.subscribeMerits();
                _meritsSubStarted = true;
            }
        } catch (e) {
            console.warn('[Transparency] No se pudo iniciar subscribeMerits:', e.message);
        }
    }

    // Punto de entrada cuando se abre la sección
    function init() {
        _ensureMeritsSubscription();
        switchTab(_currentTab);
    }

    // Fuerza refetch de Supabase y re-render
    async function refreshMerits() {
        _supabaseDataCache = null;
        _supabaseDataCacheAt = 0;
        await renderMeritsPanel();
    }

    return { init, switchTab, setMeritCategoryFilter, setMeritSearch, renderMeritsPanel, renderWalletPanel, refreshMerits };
})();

window.LBW_Transparency = LBW_Transparency;

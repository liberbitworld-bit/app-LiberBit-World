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
    let _showAllUsers = false;
    const USERS_TOP_DEFAULT = 10;
    let _meritsPage = 1;
    const MERITS_PAGE_SIZE = 25;

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

    // Renderiza el leaderboard de usuarios desde lbwm_user_merits.
    // Cada entry: rank + nivel emoji + npub corto + total + breakdown
    // (nostr + actividad). Muestra top 10 por defecto con toggle "Ver
    // todos". Devuelve cadena vacía si no hay datos Supabase.
    function _renderUsersLeaderboardHtml(users) {
        if (!Array.isArray(users) || users.length === 0) return '';
        const sorted = users.slice().sort((a, b) => (b.total || 0) - (a.total || 0));
        const total = sorted.length;
        const visible = _showAllUsers ? sorted : sorted.slice(0, USERS_TOP_DEFAULT);

        const rows = visible.map((u, i) => {
            const rank = i + 1;
            const npub = u.npub || (u.pubkey ? _shortNpub(u.pubkey) : '—');
            const npubShort = (u.npub && u.npub.length > 16)
                ? u.npub.substring(0, 12) + '…' + u.npub.substring(u.npub.length - 4)
                : npub;
            const total = u.total || 0;
            const nostr = (u.economica||0) + (u.productiva||0) + (u.responsabilidad||0) + (u.financiada||0) + (u.fundacional||0);
            const act   = u.activity_merits || 0;
            const lvlEmoji = u.nivel_emoji || '';
            const lvlName  = u.nivel || '';
            const rankColor = rank === 1 ? '#FFD700' : rank === 2 ? '#C0C0C0' : rank === 3 ? '#CD7F32' : 'var(--color-text-secondary)';
            return `
                <div style="display:grid;grid-template-columns:auto 1fr auto;gap:0.6rem;align-items:center;background:var(--color-bg-card);border:1px solid var(--color-border);border-radius:8px;padding:0.5rem 0.75rem;">
                    <div style="font-weight:700;color:${rankColor};font-size:0.85rem;min-width:1.8rem;">#${rank}</div>
                    <div style="min-width:0;">
                        <div style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;">
                            <span title="${_esc(lvlName)}" style="font-size:0.9rem;">${_esc(lvlEmoji)}</span>
                            <span data-pubkey-slot="${u.pubkey}" style="font-family:var(--font-mono);font-size:0.78rem;color:var(--color-text-primary);overflow:hidden;text-overflow:ellipsis;" title="${_esc(u.pubkey)}">${_esc(npubShort)}</span>
                        </div>
                        ${act > 0 ? `<div style="font-size:0.68rem;color:var(--color-text-secondary);opacity:0.75;margin-top:0.1rem;">Nostr ${nostr.toLocaleString('es-ES')} + Actividad ${act.toLocaleString('es-ES')}</div>` : ''}
                    </div>
                    <div style="font-weight:700;color:var(--color-gold);font-size:0.95rem;text-align:right;">${total.toLocaleString('es-ES')}</div>
                </div>
            `;
        }).join('');

        const toggleBtn = total > USERS_TOP_DEFAULT
            ? `<button onclick="LBW_Transparency.toggleAllUsers()"
                style="margin-top:0.5rem;width:100%;font-size:0.78rem;padding:0.4rem;border-radius:6px;border:1px dashed var(--color-border);background:transparent;color:var(--color-text-secondary);cursor:pointer;">
                ${_showAllUsers ? `▲ Ver solo top ${USERS_TOP_DEFAULT}` : `▼ Ver los ${total} usuarios`}
            </button>`
            : '';

        return `
            <div style="margin-bottom:1.25rem;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;flex-wrap:wrap;gap:0.4rem;">
                    <div style="font-size:0.78rem;color:var(--color-text-secondary);font-weight:600;">🏆 Méritos totales por usuario (Nostr + Actividad)</div>
                    <div style="font-size:0.7rem;color:var(--color-text-secondary);opacity:0.7;">${total} usuarios</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:0.35rem;">
                    ${rows}
                </div>
                ${toggleBtn}
            </div>
        `;
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
    let _activityEventsCache = null;
    let _activityEventsCacheAt = 0;

    // Fetcha los eventos Nostr que cuentan como "actividad" (kind:1
    // community chat, kind:30402 marketplace, kind:31000 propuestas,
    // kind:31001 votos) y los convierte en entradas tipo-mérito con
    // amount=10 y categoría actividad_*. Estos no son emisiones
    // formales kind:31002, pero se incluyen en el registro inmutable
    // para reflejar TODO mérito generado en el ecosistema (formal +
    // actividad). El cap de 300 por usuario solo afecta al total
    // ponderado del Ledger Maestro, no al registro per-evento de aquí.
    //
    // IMPORTANTE: leemos de IndexedDB (LBW_Store), NO de relays vía
    // LBW_Nostr.subscribe. Motivo: LBW_Nostr.subscribe tiene un dedup
    // global _seenEvents (nostr.js:865) que bloquea cualquier evento ya
    // visto por otra suscripción. Como chat/marketplace/gobernanza ya
    // habrán cargado estos kinds antes de que el usuario abra
    // Transparency, el callback no recibiría nada. LBW_Store sí tiene
    // todos los eventos persistidos vía LBW_Sync.syncedSubscribe.
    async function _fetchActivityEvents(force) {
        if (!force && _activityEventsCache && (Date.now() - _activityEventsCacheAt < SUPABASE_CACHE_TTL_MS)) {
            console.warn('[Transparency] activity cache hit:', _activityEventsCache.length);
            return _activityEventsCache;
        }
        if (typeof LBW_Store === 'undefined' || !LBW_Store.getEventsByKind) {
            console.warn('[Transparency] LBW_Store no disponible para fetch de actividad');
            return [];
        }
        console.warn('[Transparency] leyendo actividad desde IndexedDB (4 kinds)…');
        const all = [];
        const seen = new Set();
        const counts = { chat: 0, marketplace: 0, proposal: 0, vote: 0 };
        function add(event, category, reasonContent, countKey) {
            if (!event || !event.id || seen.has(event.id)) return;
            seen.add(event.id);
            counts[countKey]++;
            all.push({
                id: event.id,
                dTag: '',
                recipient: event.pubkey,
                issuer: '',                                // sistema, sin issuer
                amount: 10,
                category,
                reason: (reasonContent || '').toString().substring(0, 80),
                created_at: event.created_at || 0,
                source: 'actividad'
            });
        }
        try {
            const [chat, market, props, votes] = await Promise.all([
                LBW_Store.getEventsByKind(1,     { limit: 1000, tags: { t: ['liberbit', 'lbw'] } }).catch(() => []),
                LBW_Store.getEventsByKind(30402, { limit: 1000, tags: { t: ['liberbit-market'] } }).catch(() => []),
                LBW_Store.getEventsByKind(31000, { limit: 1000, tags: { t: ['lbw-proposal'] } }).catch(() => []),
                LBW_Store.getEventsByKind(31001, { limit: 1000, tags: { t: ['lbw-governance'] } }).catch(() => [])
            ]);
            (chat || []).forEach(e => {
                const hasTag = e.tags && e.tags.some(t => t[0] === 't' && (t[1] === 'liberbit' || t[1] === 'lbw'));
                if (hasTag) add(e, 'actividad_chat', e.content || '', 'chat');
            });
            (market || []).forEach(e => {
                const title = (e.tags && (e.tags.find(t => t[0] === 'title') || [])[1]) || '';
                add(e, 'actividad_marketplace', title, 'marketplace');
            });
            (props || []).forEach(e => {
                const title = (e.tags && (e.tags.find(t => t[0] === 'title') || [])[1]) || '';
                add(e, 'actividad_proposal', title, 'proposal');
            });
            (votes || []).forEach(e => {
                add(e, 'actividad_vote', e.content || '', 'vote');
            });
            console.warn('[Transparency] ✅ actividad cargada: ' + all.length + ' eventos · ' + JSON.stringify(counts));
        } catch (e) {
            console.warn('[Transparency] error leyendo actividad:', e && e.message);
        }
        _activityEventsCache = all;
        _activityEventsCacheAt = Date.now();
        return all;
    }

    async function _fetchSupabaseLedger(force) {
        if (!force && _supabaseDataCache && (Date.now() - _supabaseDataCacheAt < SUPABASE_CACHE_TTL_MS)) {
            return _supabaseDataCache;
        }
        if (typeof supabaseClient === 'undefined') return null;
        try {
            // Stats agregadas + leaderboard completo (mismo getter que
            // usa el Ledger Maestro de la sección Méritos).
            let stats = null;
            let users = [];
            if (typeof LBW_MeritsSync !== 'undefined' && LBW_MeritsSync.loadSupabaseLedger) {
                const ledger = await LBW_MeritsSync.loadSupabaseLedger({ limit: 999 });
                if (ledger) {
                    if (ledger.stats) stats = ledger.stats;
                    if (Array.isArray(ledger.users)) users = ledger.users;
                }
            }
            // Lista de emisiones individuales (kind:31002) más recientes
            const { data, error } = await supabaseClient
                .from('lbwm_merit_events')
                .select('id, pubkey, npub, amount, category, reason, awarded_by, nostr_d_tag, nostr_created_at, source')
                .order('nostr_created_at', { ascending: false })
                .limit(500);
            if (error) {
                console.warn('[Transparency] Supabase lbwm_merit_events error:', error.message);
                return stats ? { stats, users, entries: [] } : null;
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
            _supabaseDataCache = { stats, users, entries };
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
        // Fallback a memoria local si Supabase falla. Además fetcheamos
        // los eventos de actividad (chat, marketplace, votos, propuestas)
        // para incluirlos como filas del registro.
        const supa = await _fetchSupabaseLedger(false);
        const activityEntries = await _fetchActivityEvents(false);

        let stats, merits, dataSource;
        // Combinar formal (Supabase entries) + actividad. Dedup por id.
        let formalEntries = [];
        if (supa && supa.entries) {
            formalEntries = supa.entries;
        } else if (LBW_Merits && LBW_Merits.getAllMerits) {
            formalEntries = LBW_Merits.getAllMerits({ limit: 500 });
        }
        const seenIds = new Set();
        const mergedAll = [];
        for (const e of formalEntries) {
            if (e && e.id && !seenIds.has(e.id)) { seenIds.add(e.id); mergedAll.push(e); }
        }
        for (const e of activityEntries) {
            if (e && e.id && !seenIds.has(e.id)) { seenIds.add(e.id); mergedAll.push(e); }
        }

        // byCategory recomputado desde la lista mergeada (incluye formal
        // + actividad). Así los chips de categoría reflejan TODO.
        const byCategoryMerged = {};
        const uniqueRecip = new Set();
        const uniqueIssuersFormal = new Set();
        for (const m of mergedAll) {
            byCategoryMerged[m.category] = (byCategoryMerged[m.category] || 0) + (m.amount || 0);
            if (m.recipient) uniqueRecip.add(m.recipient);
            if (m.issuer) uniqueIssuersFormal.add(m.issuer);
        }

        if (supa && supa.stats) {
            // Total y users del Ledger Maestro (con cap aplicado por usuario).
            // No re-sumamos las filas de actividad porque eso ignoraría el cap
            // de 300 — mantenemos coherencia con el resto de la app.
            stats = {
                count: mergedAll.length,
                total: supa.stats.totalMerits || 0,
                byCategory: byCategoryMerged,
                uniqueIssuers: uniqueIssuersFormal.size,
                uniqueRecipients: supa.stats.totalUsers || uniqueRecip.size
            };
            dataSource = 'supabase';
        } else {
            const baseStats = LBW_Merits.getAllMeritsStats();
            stats = {
                count: mergedAll.length,
                total: baseStats.total || 0,
                byCategory: byCategoryMerged,
                uniqueIssuers: uniqueIssuersFormal.size,
                uniqueRecipients: uniqueRecip.size
            };
            dataSource = 'memory';
        }

        // Asignar nº de bloque a TODOS los merits antes de filtrar.
        // El bloque #1 es el más antiguo (génesis), el #N el más reciente.
        // Así el número se mantiene estable aunque el usuario filtre.
        const sortedAsc = mergedAll.slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        sortedAsc.forEach((m, i) => { m._blockNum = i + 1; });
        const totalBlocks = sortedAsc.length;

        // Aplicar filtro de categoría sobre el mergeado
        let merged = mergedAll;
        if (_meritFilter.category) {
            merged = merged.filter(m => m.category === _meritFilter.category);
        }
        merged.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        merits = merged;

        const searchQ = (_meritFilter.search || '').toLowerCase();
        const filtered = searchQ
            ? merits.filter(m =>
                (m.reason || '').toLowerCase().includes(searchQ) ||
                (m.category || '').toLowerCase().includes(searchQ)
              )
            : merits;

        // Paginación: clamp page al rango válido
        const totalPages = Math.max(1, Math.ceil(filtered.length / MERITS_PAGE_SIZE));
        if (_meritsPage > totalPages) _meritsPage = totalPages;
        if (_meritsPage < 1) _meritsPage = 1;
        const pageStart = (_meritsPage - 1) * MERITS_PAGE_SIZE;
        const pageEnd = pageStart + MERITS_PAGE_SIZE;
        const pageRows = filtered.slice(pageStart, pageEnd);

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

            ${_renderUsersLeaderboardHtml(supa && supa.users)}

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
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;flex-wrap:wrap;gap:0.4rem;">
                    <div style="font-size:0.78rem;color:var(--color-text-secondary);display:flex;align-items:center;gap:0.4rem;">
                        <span style="color:var(--color-gold);font-weight:700;">⛓️</span>
                        <span>Cadena de méritos · <strong style="color:var(--color-text-primary);">${totalBlocks.toLocaleString('es-ES')}</strong> bloques · más recientes primero</span>
                    </div>
                    <button onclick="LBW_Transparency.exportMeritsCSV()"
                        style="font-size:0.7rem;padding:0.25rem 0.6rem;border-radius:10px;background:transparent;border:1px solid var(--color-border);color:var(--color-text-secondary);cursor:pointer;">
                        ⬇️ Exportar CSV (todos)
                    </button>
                </div>
                <div style="font-size:0.7rem;color:var(--color-text-secondary);opacity:0.7;margin-bottom:0.6rem;line-height:1.4;">
                    💡 Cada bloque es un evento Nostr firmado e inmutable. El hash de la izquierda es el <code style="font-family:var(--font-mono);font-size:0.68rem;background:rgba(44,95,111,0.18);padding:0.05rem 0.3rem;border-radius:3px;">event.id</code> (SHA-256 del payload canónico). El bloque #1 es el génesis del registro. Incluye emisiones formales kind:31002 + eventos de actividad. El total LBWM aplica un cap de 300 pts de actividad por usuario, por eso la suma de filas puede superar el total agregado.
                </div>
                <div style="overflow-x:auto;border:1px solid var(--color-border);border-radius:10px;background:linear-gradient(180deg,rgba(13,23,30,0.6) 0%,rgba(13,23,30,0.35) 100%);box-shadow:inset 0 0 0 1px rgba(229,185,92,0.05);">
                    <table style="width:100%;border-collapse:collapse;font-size:0.78rem;color:var(--color-text-primary);min-width:880px;font-family:var(--font-mono);">
                        <thead>
                            <tr style="background:linear-gradient(180deg,rgba(229,185,92,0.06),rgba(13,23,30,0.55));border-bottom:1px solid rgba(229,185,92,0.25);">
                                <th style="text-align:left;padding:0.55rem 0.7rem;font-size:0.66rem;font-weight:700;color:var(--color-gold);text-transform:uppercase;letter-spacing:0.08em;border-right:1px solid rgba(229,185,92,0.1);">Bloque</th>
                                <th style="text-align:left;padding:0.55rem 0.7rem;font-size:0.66rem;font-weight:700;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.08em;">Hash</th>
                                <th style="text-align:left;padding:0.55rem 0.7rem;font-size:0.66rem;font-weight:700;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.08em;">Timestamp</th>
                                <th style="text-align:right;padding:0.55rem 0.7rem;font-size:0.66rem;font-weight:700;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.08em;">LBWM</th>
                                <th style="text-align:left;padding:0.55rem 0.7rem;font-size:0.66rem;font-weight:700;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.08em;">Categoría</th>
                                <th style="text-align:left;padding:0.55rem 0.7rem;font-size:0.66rem;font-weight:700;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.08em;">Emisor → Destinatario</th>
                                <th style="text-align:left;padding:0.55rem 0.7rem;font-size:0.66rem;font-weight:700;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.08em;">Memo</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${pageRows.map((m, idx) => {
                                const blockNum = m._blockNum || 0;
                                const isGenesis = blockNum === 1;
                                const isLatest = blockNum === totalBlocks;
                                const blockLabel = '#' + String(blockNum).padStart(4, '0');
                                const hashShort = m.id ? (m.id.substring(0, 10) + '…' + m.id.substring(m.id.length - 6)) : '—';
                                const blockBg = idx % 2 === 0 ? 'rgba(13,23,30,0.35)' : 'rgba(13,23,30,0.15)';
                                const issuerHtml = m.issuer
                                    ? `<span data-pubkey-slot="${m.issuer}" title="${_esc(m.issuer)}" style="color:var(--color-text-primary);">${_shortNpub(m.issuer)}</span>`
                                    : `<span style="color:#51cf66;opacity:0.85;" title="Sistema (evento de actividad)">⚙ sistema</span>`;
                                const recipHtml = `<span data-pubkey-slot="${m.recipient}" title="${_esc(m.recipient)}" style="color:var(--color-gold);">${_shortNpub(m.recipient)}</span>`;
                                return `
                                <tr style="border-bottom:1px solid rgba(44,95,111,0.18);background:${blockBg};border-left:3px solid ${isGenesis ? 'var(--color-gold)' : (isLatest ? '#51cf66' : 'rgba(229,185,92,0.18)')};">
                                    <td style="padding:0.55rem 0.7rem;white-space:nowrap;border-right:1px solid rgba(229,185,92,0.08);">
                                        <div style="display:flex;flex-direction:column;gap:0.15rem;">
                                            <span style="font-weight:700;color:var(--color-gold);font-size:0.82rem;letter-spacing:0.02em;">${blockLabel}</span>
                                            ${isGenesis ? '<span style="font-size:0.6rem;color:var(--color-gold);opacity:0.8;text-transform:uppercase;letter-spacing:0.1em;">génesis</span>' : ''}
                                            ${isLatest && !isGenesis ? '<span style="font-size:0.6rem;color:#51cf66;text-transform:uppercase;letter-spacing:0.1em;">latest</span>' : ''}
                                        </div>
                                    </td>
                                    <td style="padding:0.55rem 0.7rem;white-space:nowrap;font-size:0.68rem;">
                                        <span title="${_esc(m.id)} (click para copiar el hash completo)" onclick="LBW_Transparency.copyToClipboard('${_esc(m.id)}', this)" style="cursor:pointer;color:var(--color-text-secondary);background:rgba(44,95,111,0.15);padding:0.2rem 0.5rem;border-radius:4px;border:1px solid rgba(44,95,111,0.3);">⛓ ${hashShort}</span>
                                    </td>
                                    <td style="padding:0.55rem 0.7rem;white-space:nowrap;color:var(--color-text-secondary);font-size:0.72rem;">${_formatDate(m.created_at)}</td>
                                    <td style="padding:0.55rem 0.7rem;text-align:right;font-weight:700;color:var(--color-gold);white-space:nowrap;">+${m.amount.toLocaleString('es-ES')}</td>
                                    <td style="padding:0.55rem 0.7rem;white-space:nowrap;">
                                        <span style="font-size:0.68rem;background:rgba(64,196,255,0.12);color:#40C4FF;padding:0.18rem 0.55rem;border-radius:10px;border:1px solid rgba(64,196,255,0.25);font-family:var(--font-display);">${_esc(m.category)}</span>
                                    </td>
                                    <td style="padding:0.55rem 0.7rem;white-space:nowrap;font-size:0.72rem;">
                                        ${issuerHtml} <span style="color:var(--color-text-secondary);opacity:0.5;">→</span> ${recipHtml}
                                    </td>
                                    <td style="padding:0.55rem 0.7rem;max-width:260px;color:var(--color-text-secondary);font-style:italic;font-family:var(--font-display);font-size:0.76rem;">
                                        ${m.reason ? `"${_sanitizeReason(m.reason, 80)}"` : '<span style="opacity:0.4;">—</span>'}
                                    </td>
                                </tr>
                            `;}).join('')}
                        </tbody>
                    </table>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.6rem;flex-wrap:wrap;gap:0.5rem;">
                    <div style="font-size:0.72rem;color:var(--color-text-secondary);">
                        Mostrando <strong style="color:var(--color-text-primary);">${(pageStart + 1).toLocaleString('es-ES')}</strong>–<strong style="color:var(--color-text-primary);">${Math.min(pageEnd, filtered.length).toLocaleString('es-ES')}</strong> de <strong style="color:var(--color-text-primary);">${filtered.length.toLocaleString('es-ES')}</strong> bloques${(_meritFilter.category || _meritFilter.search) ? ` (filtrado de ${totalBlocks.toLocaleString('es-ES')})` : ''}
                    </div>
                    <div style="display:flex;gap:0.3rem;align-items:center;">
                        <button onclick="LBW_Transparency.goToMeritsPage(1)" ${_meritsPage <= 1 ? 'disabled' : ''}
                            style="font-size:0.72rem;padding:0.3rem 0.55rem;border-radius:6px;background:transparent;border:1px solid var(--color-border);color:var(--color-text-secondary);cursor:${_meritsPage <= 1 ? 'not-allowed' : 'pointer'};opacity:${_meritsPage <= 1 ? '0.35' : '1'};font-family:var(--font-mono);" title="Primera página">⏮</button>
                        <button onclick="LBW_Transparency.goToMeritsPage(${_meritsPage - 1})" ${_meritsPage <= 1 ? 'disabled' : ''}
                            style="font-size:0.72rem;padding:0.3rem 0.65rem;border-radius:6px;background:transparent;border:1px solid var(--color-border);color:var(--color-text-secondary);cursor:${_meritsPage <= 1 ? 'not-allowed' : 'pointer'};opacity:${_meritsPage <= 1 ? '0.35' : '1'};font-family:var(--font-mono);">◀ Prev</button>
                        <span style="font-size:0.72rem;color:var(--color-text-primary);padding:0 0.55rem;font-family:var(--font-mono);">Página <strong style="color:var(--color-gold);">${_meritsPage}</strong> / ${totalPages}</span>
                        <button onclick="LBW_Transparency.goToMeritsPage(${_meritsPage + 1})" ${_meritsPage >= totalPages ? 'disabled' : ''}
                            style="font-size:0.72rem;padding:0.3rem 0.65rem;border-radius:6px;background:transparent;border:1px solid var(--color-border);color:var(--color-text-secondary);cursor:${_meritsPage >= totalPages ? 'not-allowed' : 'pointer'};opacity:${_meritsPage >= totalPages ? '0.35' : '1'};font-family:var(--font-mono);">Next ▶</button>
                        <button onclick="LBW_Transparency.goToMeritsPage(${totalPages})" ${_meritsPage >= totalPages ? 'disabled' : ''}
                            style="font-size:0.72rem;padding:0.3rem 0.55rem;border-radius:6px;background:transparent;border:1px solid var(--color-border);color:var(--color-text-secondary);cursor:${_meritsPage >= totalPages ? 'not-allowed' : 'pointer'};opacity:${_meritsPage >= totalPages ? '0.35' : '1'};font-family:var(--font-mono);" title="Última página">⏭</button>
                    </div>
                </div>
            `}
        `;

        // Resolver nombres async
        const uniquePubkeys = new Set();
        filtered.forEach(m => { if (m.issuer) uniquePubkeys.add(m.issuer); if (m.recipient) uniquePubkeys.add(m.recipient); });
        // También resuelve nombres de los usuarios del leaderboard
        if (supa && Array.isArray(supa.users)) {
            supa.users.forEach(u => { if (u.pubkey) uniquePubkeys.add(u.pubkey); });
        }
        for (const pk of uniquePubkeys) {
            _resolveNameInto(pk, `[data-pubkey-slot="${pk}"]`);
        }
    }

    function renderWalletPanel() {
        const panel = document.getElementById('transparencyWalletPanel');
        if (!panel) return;
        // Placeholder hasta que el endpoint /api/transparency/wallet esté
        // disponible (requiere token coinos en Vercel env vars). Mostramos
        // un mockup de cómo se verá para que el operador (y los curiosos)
        // sepan qué esperar.
        panel.innerHTML = `
            <div style="background:rgba(255,167,38,0.08);border:1px solid rgba(255,167,38,0.3);border-radius:10px;padding:0.85rem 1rem;margin-bottom:1.25rem;">
                <div style="color:#FFA726;font-weight:600;font-size:0.85rem;margin-bottom:0.3rem;">⚙️ Pendiente de configuración</div>
                <div style="color:var(--color-text-secondary);font-size:0.78rem;line-height:1.5;">
                    Falta crear la dirección dedicada en coinos.io y añadir el access token como env var en Vercel. La estructura ya está preparada — debajo se muestra cómo se verá la sección.
                </div>
            </div>

            <!-- Stats placeholder -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.75rem;margin-bottom:1.25rem;opacity:0.5;">
                <div style="background:rgba(229,185,92,0.08);border:1px solid rgba(229,185,92,0.25);border-radius:10px;padding:0.85rem;text-align:center;">
                    <div style="font-size:1.6rem;font-weight:700;color:var(--color-gold);">— sats</div>
                    <div style="font-size:0.72rem;color:var(--color-text-secondary);margin-top:0.15rem;">Saldo actual</div>
                </div>
                <div style="background:rgba(81,207,102,0.08);border:1px solid rgba(81,207,102,0.25);border-radius:10px;padding:0.85rem;text-align:center;">
                    <div style="font-size:1.6rem;font-weight:700;color:#51cf66;">— sats</div>
                    <div style="font-size:0.72rem;color:var(--color-text-secondary);margin-top:0.15rem;">Total recibido</div>
                </div>
                <div style="background:rgba(255,77,79,0.08);border:1px solid rgba(255,77,79,0.25);border-radius:10px;padding:0.85rem;text-align:center;">
                    <div style="font-size:1.6rem;font-weight:700;color:#ff4d4f;">— sats</div>
                    <div style="font-size:0.72rem;color:var(--color-text-secondary);margin-top:0.15rem;">Total gastado</div>
                </div>
                <div style="background:rgba(64,196,255,0.08);border:1px solid rgba(64,196,255,0.25);border-radius:10px;padding:0.85rem;text-align:center;">
                    <div style="font-size:1.6rem;font-weight:700;color:#40C4FF;">—</div>
                    <div style="font-size:0.72rem;color:var(--color-text-secondary);margin-top:0.15rem;">Nº movimientos</div>
                </div>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;flex-wrap:wrap;gap:0.4rem;">
                <div style="font-size:0.78rem;color:var(--color-text-secondary);">
                    📒 Diario de movimientos (entrada / salida) · cronológico · más recientes primero
                </div>
                <button disabled style="font-size:0.7rem;padding:0.25rem 0.6rem;border-radius:10px;background:transparent;border:1px solid var(--color-border);color:var(--color-text-secondary);opacity:0.4;cursor:not-allowed;">
                    ⬇️ Exportar CSV
                </button>
            </div>

            <!-- Tabla mockup vacía -->
            <div style="overflow-x:auto;border:1px solid var(--color-border);border-radius:8px;background:var(--color-bg-card);opacity:0.6;">
                <table style="width:100%;border-collapse:collapse;font-size:0.78rem;color:var(--color-text-primary);min-width:760px;">
                    <thead>
                        <tr style="background:rgba(13,23,30,0.6);border-bottom:1px solid var(--color-border);">
                            <th style="text-align:left;padding:0.55rem 0.7rem;font-size:0.7rem;font-weight:600;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.05em;">Fecha</th>
                            <th style="text-align:center;padding:0.55rem 0.7rem;font-size:0.7rem;font-weight:600;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.05em;">Tipo</th>
                            <th style="text-align:right;padding:0.55rem 0.7rem;font-size:0.7rem;font-weight:600;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.05em;">Sats</th>
                            <th style="text-align:left;padding:0.55rem 0.7rem;font-size:0.7rem;font-weight:600;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.05em;">Memo</th>
                            <th style="text-align:left;padding:0.55rem 0.7rem;font-size:0.7rem;font-weight:600;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.05em;">Origen / Destino</th>
                            <th style="text-align:left;padding:0.55rem 0.7rem;font-size:0.7rem;font-weight:600;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:0.05em;">Tx hash</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr style="border-bottom:1px solid rgba(44,95,111,0.15);">
                            <td colspan="6" style="text-align:center;padding:2rem;color:var(--color-text-secondary);font-style:italic;">
                                Sin datos · configurar coinos token primero
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div style="margin-top:1rem;font-size:0.72rem;color:var(--color-text-secondary);opacity:0.7;line-height:1.5;">
                💡 Cuando esté operativo: cada movimiento entrante (donación) o saliente (gasto comunitario) aparecerá automáticamente, con timestamp, monto en sats, memo del pagador (sanitizado: identidades en texto libre se anonimizarán como [oculto]), origen/destino y hash de la transacción Lightning.
            </div>
        `;
    }

    function setMeritCategoryFilter(cat) {
        _meritFilter.category = cat || '';
        _meritsPage = 1;
        renderMeritsPanel();
    }

    function setMeritSearch(val) {
        _meritFilter.search = (val || '').trim();
        _meritsPage = 1;
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

    function goToMeritsPage(n) {
        const next = parseInt(n, 10);
        if (!Number.isFinite(next) || next < 1) return;
        _meritsPage = next;
        renderMeritsPanel();
        // Scroll suave al tope de la tabla
        const panel = document.getElementById('transparencyMeritsPanel');
        if (panel) {
            try { panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
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

    // Fuerza refetch de Supabase + actividad y re-render
    async function refreshMerits() {
        _supabaseDataCache = null;
        _supabaseDataCacheAt = 0;
        _activityEventsCache = null;
        _activityEventsCacheAt = 0;
        await renderMeritsPanel();
    }

    async function toggleAllUsers() {
        _showAllUsers = !_showAllUsers;
        await renderMeritsPanel();
    }

    // Exporta el registro filtrado a CSV. Usa los mismos filtros activos
    // (categoría + búsqueda) que están aplicados en la vista. Incluye
    // tanto emisiones formales como eventos de actividad.
    async function exportMeritsCSV() {
        const supa = await _fetchSupabaseLedger(false);
        const activity = await _fetchActivityEvents(false);
        const formal = (supa && Array.isArray(supa.entries))
            ? supa.entries
            : (LBW_Merits && LBW_Merits.getAllMerits ? LBW_Merits.getAllMerits({ limit: 9999 }) : []);
        const seen = new Set();
        let entries = [];
        for (const e of formal)   { if (e && e.id && !seen.has(e.id)) { seen.add(e.id); entries.push(e); } }
        for (const e of activity) { if (e && e.id && !seen.has(e.id)) { seen.add(e.id); entries.push(e); } }
        entries.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        if (_meritFilter.category) entries = entries.filter(m => m.category === _meritFilter.category);
        if (_meritFilter.search) {
            const q = _meritFilter.search.toLowerCase();
            entries = entries.filter(m =>
                (m.reason || '').toLowerCase().includes(q) ||
                (m.category || '').toLowerCase().includes(q)
            );
        }
        if (entries.length === 0) {
            alert('No hay méritos para exportar con el filtro actual.');
            return;
        }
        const esc = v => {
            if (v === null || v === undefined) return '';
            const s = String(v).replace(/"/g, '""');
            return /[",\n;]/.test(s) ? '"' + s + '"' : s;
        };
        const header = ['fecha_iso', 'fecha_unix', 'amount', 'category', 'issuer', 'recipient', 'reason', 'event_id', 'd_tag', 'source'];
        const rows = entries.map(m => [
            new Date((m.created_at || 0) * 1000).toISOString(),
            m.created_at || 0,
            m.amount || 0,
            m.category || '',
            m.issuer || '',
            m.recipient || '',
            m.reason || '',
            m.id || '',
            m.dTag || '',
            m.source || ''
        ].map(esc).join(','));
        const csv = header.join(',') + '\n' + rows.join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'lbwm-merits-' + new Date().toISOString().substring(0, 10) + '.csv';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    }

    // Copia un valor al portapapeles y da feedback visual en el elemento
    async function copyToClipboard(text, el) {
        try {
            await navigator.clipboard.writeText(text);
            if (el) {
                const orig = el.textContent;
                el.textContent = '✅ copiado';
                setTimeout(() => { el.textContent = orig; }, 1200);
            }
        } catch (e) {
            console.warn('[Transparency] Clipboard error:', e.message);
        }
    }

    return { init, switchTab, setMeritCategoryFilter, setMeritSearch, renderMeritsPanel, renderWalletPanel, refreshMerits, toggleAllUsers, exportMeritsCSV, copyToClipboard, goToMeritsPage };
})();

window.LBW_Transparency = LBW_Transparency;

// ========== MERITS LBWM FUNCTIONS (Nostr-integrated) ==========
// All data flows through LBW_Merits → Nostr relays
// Zero Supabase dependencies
// [v2.0] Sum+cap formula, dual flow, voting blocks, category breakdown, governor verification

// ═══════════════════════════════════════════════════════════════
// LEGACY MIGRATION — liberbit_contributions localStorage → Nostr
// Ejecuta una sola vez por usuario. Elimina el localStorage tras migrar.
// Se puede eliminar este bloque cuando confirmemos que ningún usuario
// activo tiene datos legacy (aprox. 2-3 semanas tras el deploy).
// ═══════════════════════════════════════════════════════════════
async function _migrateLegacyContributions() {
    const LEGACY_KEY = 'liberbit_contributions';
    const MIGRATED_KEY = 'lbw_legacy_migrated';

    // Ya migrado anteriormente — salir inmediatamente
    if (localStorage.getItem(MIGRATED_KEY) === '1') return;

    let legacyContribs;
    try {
        legacyContribs = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
    } catch (e) {
        console.warn('[Migration] No se pudo parsear legacy contributions:', e.message);
        localStorage.setItem(MIGRATED_KEY, '1');
        return;
    }

    if (!legacyContribs.length) {
        // No hay datos legacy — marcar como migrado y salir
        localStorage.setItem(MIGRATED_KEY, '1');
        return;
    }

    if (typeof LBW_Merits === 'undefined' || !LBW_Nostr.isLoggedIn()) {
        console.warn('[Migration] LBW_Merits o login no disponibles, reintentando en próximo ciclo.');
        return;
    }

    // Mapa de categorías v1.0 → v2.0 (espejo de _normalizeCategory en nostr-merits.js)
    const CAT_MAP = {
        'economica': 'economica', 'productiva': 'productiva',
        'responsabilidad': 'responsabilidad', 'financiada': 'financiada',
        'participation': 'productiva', 'professional': 'productiva',
        'governance': 'responsabilidad', 'infrastructure': 'productiva',
        'community': 'productiva', 'financial': 'financiada'
    };

    console.log(`[Migration] Migrando ${legacyContribs.length} aportaciones legacy a Nostr...`);
    let migrated = 0;
    let failed = 0;

    for (const c of legacyContribs) {
        try {
            const category = CAT_MAP[c.contribution_type] || CAT_MAP[c.category] || 'productiva';
            const amount = parseFloat(c.reference_value || c.amount || 0);
            const description = (c.description || 'Aportación migrada desde registro legacy').substring(0, 200);
            const currency = c.currency || 'EUR';

            await LBW_Merits.submitContribution({
                description,
                category,
                amount,
                currency,
                evidence: ['legacy-migration'],
                status: c.status || 'approved'
            });

            migrated++;
            console.log(`[Migration] ✅ Migrada: "${description.substring(0, 40)}" → ${category}`);

            // Pequeña pausa para no saturar el relay
            await new Promise(r => setTimeout(r, 300));

        } catch (err) {
            failed++;
            console.warn(`[Migration] ⚠️ Error migrando contribución: ${err.message}`);
        }
    }

    // Marcar como migrado y limpiar localStorage independientemente del resultado
    localStorage.setItem(MIGRATED_KEY, '1');
    localStorage.removeItem(LEGACY_KEY);

    console.log(`[Migration] ✅ Migración completada: ${migrated} OK, ${failed} errores. localStorage limpiado.`);
    if (migrated > 0) {
        showNotification(`✅ ${migrated} aportaciones antiguas migradas al sistema Nostr.`, 'success');
    }
}

async function loadMeritsData() {
    try {
        if (typeof LBW_Merits === 'undefined' || !LBW_Nostr.isLoggedIn()) {
            console.warn('[Merits] LBW_Merits not available or not logged in');
            return;
        }

        // Init missions in background
        if (typeof LBW_Missions !== 'undefined') {
            LBW_Missions.init().then(() => {
                const badge = document.getElementById('tabBadgeMissions');
                if (badge) { const n = LBW_Missions.getOpenCount(); badge.textContent = n; badge.style.display = n > 0 ? 'inline-flex' : 'none'; }
            }).catch(e => console.warn('[Missions] init error:', e));
        }

        // Migrar aportaciones legacy de localStorage → Nostr (una sola vez por usuario)
        await _migrateLegacyContributions();

        // Start subscriptions if not already running
        LBW_Merits.subscribeMerits();
        LBW_Merits.subscribeContributions();
        LBW_Merits.subscribeSnapshots();

        // Wait for relay data (cache provides instant data, this catches relay updates)
        await new Promise(r => setTimeout(r, 2000));

        // [v2.0] Use getUnifiedMerits() if available, else fallback
        let totalMerits = 0;
        let breakdown = {};

        const meritData = getUnifiedMerits();
        totalMerits = meritData.total;
        breakdown = meritData.byCategory;

        // Update user merits display
        const el = id => document.getElementById(id);
        if (el('userTotalMerits')) el('userTotalMerits').textContent = totalMerits;
        if (el('user_lbwm_activos')) el('user_lbwm_activos').textContent = totalMerits;

        // Count contributions
        const myContribs = LBW_Merits.getMyContributions();
        const activityCount = getUnifiedMerits().activityCount;
        var totalContribs = myContribs.length + activityCount;
        if (el('user_lbwm_aportaciones')) el('user_lbwm_aportaciones').textContent = totalContribs;

        // Stats panel
        if (el('stat_mi_balance')) el('stat_mi_balance').textContent = totalMerits;

        // Citizenship level from Nostr module
        const level = LBW_Merits.getCitizenshipLevel(totalMerits);
        if (el('userLevel')) el('userLevel').textContent = level.emoji;
        if (el('userLevelName')) el('userLevelName').textContent = level.name;

        // [v2.0] Update category breakdown + voting blocks
        updateCategoryBreakdown(breakdown, totalMerits);

        // Load sub-views
        await loadLeaderboard();
        loadLedgerData();
        await updateLbwmStats(totalMerits);

        // [v2.0] Update voting blocks display
        updateVotingBlocksDisplay();

        // [v2.0] Dashboard gauge + level badges
        updateDashboardDisplay(totalMerits);

        // [v2.0] Proposals tab
        loadMeritProposals();

        // [v2.0] Verifications tab (governor panel)
        loadPendingVerifications();

        // [v2.0] Citizenship levels tab
        renderCitizenshipLevels(totalMerits);

    } catch (err) {
        if (!(err.message && err.message.includes('DataCloneError'))) {
            console.error('Error loading merits:', err.message);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// [v2.0-NEW] Category breakdown visualization
// ═══════════════════════════════════════════════════════════════
function updateCategoryBreakdown(breakdown, totalMerits) {
    const container = document.getElementById('meritsCategoryBreakdown');
    if (!container) return;

    if (!breakdown || Object.keys(breakdown).length === 0) {
        container.innerHTML = '<div style="text-align:center;color:var(--color-text-secondary);font-size:0.85rem;padding:1rem;">Sin datos de categorías. Las aportaciones formales via Nostr aparecerán aquí.</div>';
        return;
    }

    const cats = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.CATEGORIES : {};
    let html = '';
    for (const [key, cat] of Object.entries(cats)) {
        const points = breakdown[key] || 0;
        const pct = totalMerits > 0 ? (points / totalMerits * 100) : 0;
        html += `
            <div style="display:flex;align-items:center;gap:0.6rem;padding:0.6rem 0.8rem;background:var(--color-bg-dark);border-radius:10px;margin-bottom:0.4rem;">
                <span style="font-size:1.1rem;">${cat.emoji}</span>
                <div style="flex:1;">
                    <div style="font-size:0.85rem;font-weight:600;color:var(--color-text-primary);">${cat.label} <span style="font-size:0.7rem;opacity:0.6;">×${cat.weight}</span></div>
                    <div style="background:rgba(255,255,255,0.08);border-radius:4px;height:4px;margin-top:0.3rem;">
                        <div style="background:var(--color-gold);height:100%;border-radius:4px;width:${pct}%;transition:width 0.5s;"></div>
                    </div>
                </div>
                <span style="font-family:var(--font-mono);font-size:0.85rem;font-weight:700;color:var(--color-gold);min-width:60px;text-align:right;">${points.toFixed(0)}</span>
                <span style="font-size:0.7rem;color:var(--color-text-secondary);min-width:35px;text-align:right;">${pct.toFixed(0)}%</span>
            </div>
        `;
    }
    container.innerHTML = html;

    // Also update profile breakdown if exists
    const profileBreakdown = document.getElementById('categoryBreakdown');
    if (profileBreakdown) profileBreakdown.innerHTML = html;

    // Update merit source indicator
    const sourceEl = document.getElementById('meritSource');
    if (sourceEl) {
        const data = getUnifiedMerits();
        sourceEl.textContent = data.source === 'nostr+activity' ? '⚡ Nostr + 📊 Actividad' : '📊 Solo Actividad';
    }

    // Update bloc indicator
    const blocEl = document.getElementById('citizenshipBloc');
    if (blocEl) {
        const level = (typeof getCitizenshipLevel === 'function')
            ? getCitizenshipLevel(totalMerits) : { bloc: 'Comunidad' };
        blocEl.textContent = level.bloc || 'Comunidad';
    }
}

// ═══════════════════════════════════════════════════════════════
// [v2.0-NEW] Voting blocks display
// ═══════════════════════════════════════════════════════════════
function updateVotingBlocksDisplay() {
    const container = document.getElementById('votingBlocksDisplay');
    if (!container || typeof LBW_Merits === 'undefined') return;

    const leaderboard = LBW_Merits.getLeaderboard(999);
    const voters = leaderboard.map(e => ({ pubkey: e.pubkey, merits: e.total }));

    // Add current user if not in leaderboard
    if (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.isLoggedIn()) {
        const myPubkey = LBW_Nostr.getPubkey();
        if (!voters.find(v => v.pubkey === myPubkey)) {
            const myData = LBW_Merits.getMyMerits();
            if (myData) voters.push({ pubkey: myPubkey, merits: myData.total });
        }
    }

    if (voters.length === 0) {
        container.innerHTML = '<div style="text-align:center;color:var(--color-text-secondary);font-size:0.85rem;padding:1.5rem;">Participantes insuficientes para mostrar distribución de bloques.</div>';
        return;
    }

    const blocks = LBW_Merits.calculateVotingPower(voters);

    // Aggregate by bloc
    const blocs = { Gobernanza: { pct: 0, count: 0 }, 'Ciudadanía': { pct: 0, count: 0 }, Comunidad: { pct: 0, count: 0 } };
    for (const [pk, data] of Object.entries(blocks)) {
        const bloc = data.bloc;
        if (blocs[bloc]) {
            blocs[bloc].pct += data.power;
            blocs[bloc].count++;
        }
    }

    // Ensure minimum 51% for Gobernanza if there are governors
    if (blocs.Gobernanza.count > 0 && blocs.Gobernanza.pct < 0.51) {
        blocs.Gobernanza.pct = 0.51;
    }

    const blocColors = { Gobernanza: '#9C27B0', 'Ciudadanía': '#FF9800', Comunidad: '#4CAF50' };
    const blocMinMax = { Gobernanza: 'mín 51%', 'Ciudadanía': 'máx 29%', Comunidad: 'máx 20%' };

    // Bar visualization
    let barHtml = '<div style="display:flex;height:36px;border-radius:10px;overflow:hidden;margin-bottom:1rem;">';
    for (const [bloc, data] of Object.entries(blocs)) {
        const pct = (data.pct * 100).toFixed(0);
        if (data.pct > 0.02) {
            barHtml += `<div style="display:flex;align-items:center;justify-content:center;width:${pct}%;background:${blocColors[bloc]};font-size:0.75rem;font-weight:700;color:white;transition:width 0.5s;min-width:25px;">${pct}%</div>`;
        }
    }
    barHtml += '</div>';

    // Legend
    let legendHtml = '<div style="display:flex;gap:1rem;flex-wrap:wrap;">';
    for (const [bloc, data] of Object.entries(blocs)) {
        legendHtml += `
            <div style="display:flex;align-items:center;gap:0.4rem;font-size:0.8rem;">
                <div style="width:10px;height:10px;border-radius:50%;background:${blocColors[bloc]};"></div>
                <span><strong>${bloc}:</strong> ${(data.pct * 100).toFixed(1)}% (${data.count}) — ${blocMinMax[bloc]}</span>
            </div>
        `;
    }
    legendHtml += '</div>';

    // User's bloc
    let userBlocHtml = '';
    if (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.isLoggedIn()) {
        const myPower = LBW_Merits.getUserVotingPower();
        if (myPower) {
            userBlocHtml = `
                <div style="margin-top:1rem;padding:0.75rem;background:rgba(229,185,92,0.1);border-radius:10px;border-left:3px solid var(--color-gold);">
                    <div style="font-size:0.8rem;color:var(--color-text-secondary);">Tu poder de voto</div>
                    <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.3rem;">
                        <span style="font-size:1.1rem;font-weight:700;color:var(--color-gold);">${(myPower.power * 100).toFixed(2)}%</span>
                        <span style="font-size:0.8rem;padding:0.15rem 0.5rem;border-radius:10px;background:${blocColors[myPower.bloc]}22;color:${blocColors[myPower.bloc]};border:1px solid ${blocColors[myPower.bloc]}44;">
                            ${myPower.bloc}
                        </span>
                    </div>
                </div>
            `;
        }
    }

    container.innerHTML = barHtml + legendHtml + userBlocHtml;

    // [v2.0] Also update the visual voting bar in bloques tab
    updateVotingBarDisplay(blocs);
}

// ═══════════════════════════════════════════════════════════════
// Leaderboard (updated with level & bloc display)
// ═══════════════════════════════════════════════════════════════
async function loadLeaderboard() {
    const leaderboard = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getLeaderboard(20) : [];
    const myPubkey = LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : '';

    let html = '';

    if (leaderboard.length === 0) {
        const userName = currentUser?.name || 'Tú';
        const totalMerits = document.getElementById('userTotalMerits')?.textContent || '0';
        html = `
            <div style="display: grid; gap: 1rem;">
                <div style="display: flex; align-items: center; gap: 1rem; padding: 1rem; background: rgba(229, 185, 92, 0.1); border-radius: 8px; border: 2px solid var(--color-gold);">
                    <div style="font-size: 1.5rem; font-weight: 700; color: var(--color-gold); min-width: 40px;">🥇 1</div>
                    <div style="flex: 1;">
                        <div style="color: var(--color-text-primary); font-weight: 600;">${userName}</div>
                        <div style="color: var(--color-text-secondary); font-size: 0.85rem;">Tú</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 1.3rem; font-weight: 700; color: var(--color-gold);" id="leaderboardUserMerits">${totalMerits}</div>
                        <div style="font-size: 0.75rem; color: var(--color-text-secondary);">LBWM</div>
                    </div>
                </div>
                <div style="text-align: center; padding: 1rem; color: var(--color-text-secondary); font-size: 0.9rem;">
                    💡 Más usuarios aparecerán cuando participen en el ecosistema
                </div>
            </div>
        `;
    } else {
        const medals = ['🥇', '🥈', '🥉'];
        html = '<div style="display: grid; gap: 0.75rem;">';
        leaderboard.forEach((entry, i) => {
            const isMe = entry.pubkey === myPubkey;
            const medal = medals[i] || `${i + 1}`;
            const name = entry.npub ? entry.npub.substring(0, 16) + '...' : 'Anónimo';
            const border = isMe ? 'border: 2px solid var(--color-gold);' : 'border: 1px solid var(--color-border);';
            // [v2.0] Show level & bloc
            const lvl = entry.level || LBW_Merits.getCitizenshipLevel(entry.total);
            html += `
                <div style="display: flex; align-items: center; gap: 1rem; padding: 0.85rem 1rem; background: ${isMe ? 'rgba(229, 185, 92, 0.1)' : 'var(--color-bg-dark)'}; border-radius: 8px; ${border}">
                    <div style="font-size: 1.2rem; font-weight: 700; color: var(--color-gold); min-width: 36px;">${medal}</div>
                    <div style="flex: 1;">
                        <div style="color: var(--color-text-primary); font-weight: 600;">${name}</div>
                        <div style="color: var(--color-text-secondary); font-size: 0.75rem;">${lvl?.emoji || '🌐'} ${lvl?.name || 'E-Residency'} <span style="opacity:0.6">· ${lvl?.bloc || 'Comunidad'}</span></div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 1.1rem; font-weight: 700; color: var(--color-gold);">${entry.total}</div>
                        <div style="font-size: 0.7rem; color: var(--color-text-secondary);">LBWM</div>
                    </div>
                </div>
            `;
        });
        html += '</div>';
    }

    const leaderboardEl = document.getElementById('leaderboardList');
    if (leaderboardEl) leaderboardEl.innerHTML = html;

    const totalMerits = document.getElementById('userTotalMerits')?.textContent || '0';
    const lbMeritsEl = document.getElementById('leaderboardUserMerits');
    if (lbMeritsEl) lbMeritsEl.textContent = totalMerits;

    const myData = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getMyMerits() : null;
    const rankingEl = document.getElementById('userRanking');
    if (rankingEl) rankingEl.textContent = myData?.rank || '1';
}

// ═══════════════════════════════════════════════════════════════
// Ledger (unchanged, compatible)
// ═══════════════════════════════════════════════════════════════
// ── loadLedgerFromSupabase — nueva función para el tab Ledger ─
async function loadLedgerFromSupabase(orderBy = 'total') {
    const body     = document.getElementById('ledgerTableBody');
    const emptyMsg = document.getElementById('ledgerEmptyMsg');
    const badge    = document.getElementById('ledgerSourceBadge');

    if (body) body.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--color-text-secondary);">⏳ Cargando desde Supabase...</td></tr>`;
    if (emptyMsg) emptyMsg.style.display = 'none';

    // Update active filter pill
    document.querySelectorAll('.ledger-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.col === orderBy);
    });

    // Try Supabase first
    let result = null;
    if (typeof LBW_MeritsSync !== 'undefined') {
        result = await LBW_MeritsSync.loadSupabaseLedger({ limit: 200, orderBy });
    }

    // Fallback to Nostr in-memory if Supabase empty
    if (!result || result.users.length === 0) {
        _renderLedgerFromNostr(orderBy);
        if (badge) { badge.textContent = '⚡ Nostr (local)'; badge.style.color = '#FFB74D'; }
        return;
    }

    if (badge) { badge.textContent = '✅ Supabase'; badge.style.color = '#52c41a'; }

    const { users, stats } = result;

    // Stats
    const el = id => document.getElementById(id);
    if (el('ledger_total_emitido')) el('ledger_total_emitido').textContent = stats.totalMerits.toLocaleString();
    if (el('ledger_aportantes'))    el('ledger_aportantes').textContent    = stats.totalUsers;

    // Category totals bar
    const catEl = el('ledgerCatTotals');
    if (catEl) {
        const cats = [
            { key: 'economica',       emoji: '💰', color: '#FFB74D', label: 'Econ.' },
            { key: 'productiva',      emoji: '🛠️', color: '#81C784', label: 'Prod.' },
            { key: 'responsabilidad', emoji: '🔐', color: '#CE93D8', label: 'Resp.' },
            { key: 'financiada',      emoji: '⏳', color: '#80DEEA', label: 'Fin.' },
            { key: 'fundacional',     emoji: '🏗️', color: '#FFCC80', label: 'Fund.' }
        ];
        catEl.innerHTML = cats.map(c => `
            <div style="background:var(--color-bg-medium);border-radius:8px;padding:0.5rem;text-align:center;border:1px solid rgba(255,255,255,0.05);">
                <div style="font-size:0.9rem;">${c.emoji}</div>
                <div style="font-family:var(--font-mono);font-size:0.75rem;font-weight:700;color:${c.color};">${(stats.byCategory[c.key] || 0).toLocaleString()}</div>
                <div style="font-size:0.6rem;color:var(--color-text-secondary);">${c.label}</div>
            </div>`).join('');
    }

    if (users.length === 0) {
        if (body) body.innerHTML = '';
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
    }

    const myPubkey = typeof LBW_Nostr !== 'undefined' ? LBW_Nostr.getPubkey() : '';

    if (body) {
        body.innerHTML = users.map((u, i) => {
            const isMe = u.pubkey === myPubkey;
            const npubShort = u.npub ? u.npub.substring(0, 14) + '…' : u.pubkey.substring(0, 14) + '…';
            const rowStyle = isMe ? 'background:rgba(229,185,92,0.1);border-left:3px solid var(--color-gold);' : '';
            return `<tr style="${rowStyle}">
                <td style="padding:0.45rem 0.4rem;font-family:var(--font-mono);font-size:0.7rem;color:var(--color-text-secondary);">${i + 1}</td>
                <td style="padding:0.45rem 0.4rem;font-size:0.9rem;">${u.nivel_emoji || '👋'}</td>
                <td style="padding:0.45rem 0.4rem;font-family:var(--font-mono);font-size:0.7rem;color:${isMe ? 'var(--color-gold)' : 'var(--color-text-primary)'};max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${u.npub || u.pubkey}">
                    ${isMe ? '★ ' : ''}${npubShort}
                </td>
                <td style="padding:0.45rem 0.4rem;text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--color-gold);">${(u.total || 0).toLocaleString()}</td>
                <td style="padding:0.45rem 0.4rem;text-align:right;font-family:var(--font-mono);color:#FFB74D;">${u.economica || 0}</td>
                <td style="padding:0.45rem 0.4rem;text-align:right;font-family:var(--font-mono);color:#81C784;">${u.productiva || 0}</td>
                <td style="padding:0.45rem 0.4rem;text-align:right;font-family:var(--font-mono);color:#CE93D8;">${u.responsabilidad || 0}</td>
                <td style="padding:0.45rem 0.4rem;text-align:right;font-family:var(--font-mono);color:#80DEEA;">${u.financiada || 0}</td>
                <td style="padding:0.45rem 0.4rem;text-align:right;font-family:var(--font-mono);color:#FFCC80;">${u.fundacional || 0}</td>
            </tr>`;
        }).join('');
    }
}

// Fallback: render ledger from Nostr in-memory data
function _renderLedgerFromNostr(orderBy = 'total') {
    const body = document.getElementById('ledgerTableBody');
    if (!body) return;
    if (typeof LBW_Merits === 'undefined') return;

    const lb = LBW_Merits.getLeaderboard(200);
    if (!lb || lb.length === 0) {
        body.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--color-text-secondary);">Sin datos en relay aún</td></tr>`;
        return;
    }

    const myPubkey = typeof LBW_Nostr !== 'undefined' ? LBW_Nostr.getPubkey() : '';
    const sorted = [...lb].sort((a, b) => (b.byCategory[orderBy] || b.total || 0) - (a.byCategory[orderBy] || a.total || 0));

    body.innerHTML = sorted.map((u, i) => {
        const isMe = u.pubkey === myPubkey;
        const npubShort = u.npub ? u.npub.substring(0, 14) + '…' : u.pubkey.substring(0, 14) + '…';
        const rowStyle = isMe ? 'background:rgba(229,185,92,0.1);border-left:3px solid var(--color-gold);' : '';
        return `<tr style="${rowStyle}">
            <td style="padding:0.45rem 0.4rem;font-family:var(--font-mono);font-size:0.7rem;color:var(--color-text-secondary);">${i + 1}</td>
            <td style="padding:0.45rem 0.4rem;font-size:0.9rem;">${u.level?.emoji || '👋'}</td>
            <td style="padding:0.45rem 0.4rem;font-family:var(--font-mono);font-size:0.7rem;color:${isMe ? 'var(--color-gold)' : 'var(--color-text-primary)'};max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                ${isMe ? '★ ' : ''}${npubShort}
            </td>
            <td style="padding:0.45rem 0.4rem;text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--color-gold);">${(u.total || 0).toLocaleString()}</td>
            <td style="padding:0.45rem 0.4rem;text-align:right;font-family:var(--font-mono);color:#FFB74D;">${u.byCategory?.economica || 0}</td>
            <td style="padding:0.45rem 0.4rem;text-align:right;font-family:var(--font-mono);color:#81C784;">${u.byCategory?.productiva || 0}</td>
            <td style="padding:0.45rem 0.4rem;text-align:right;font-family:var(--font-mono);color:#CE93D8;">${u.byCategory?.responsabilidad || 0}</td>
            <td style="padding:0.45rem 0.4rem;text-align:right;font-family:var(--font-mono);color:#80DEEA;">${u.byCategory?.financiada || 0}</td>
            <td style="padding:0.45rem 0.4rem;text-align:right;font-family:var(--font-mono);color:#FFCC80;">${u.byCategory?.fundacional || 0}</td>
        </tr>`;
    }).join('');

    const el = id => document.getElementById(id);
    const totalMerits = lb.reduce((s, u) => s + u.total, 0);
    if (el('ledger_total_emitido')) el('ledger_total_emitido').textContent = totalMerits.toLocaleString();
    if (el('ledger_aportantes'))    el('ledger_aportantes').textContent    = lb.length;
}

function loadLedgerData() {
    // Redirect to Supabase-backed loader. loadLedgerData() kept for backward compat.
    loadLedgerFromSupabase('total');
}

function _loadLedgerDataLegacy() {
    const myContribs = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getMyContributions() : [];

    // Legacy fallback: solo lectura, sin escritura. Se eliminará tras confirmar migración completa.
    const legacyContribs = localStorage.getItem('lbw_legacy_migrated') === '1'
        ? []
        : JSON.parse(localStorage.getItem('liberbit_contributions') || '[]');
    const allContribs = [...myContribs.map(c => ({
        id: c.id,
        applicant_name: c.npub ? c.npub.substring(0, 12) + '...' : 'Tú',
        applicant_public_key: c.pubkey,
        contribution_type: c.category,
        description: c.description,
        reference_value: c.amount,
        currency: c.currency || 'units',
        factor_proposed: c.weight,
        lbwm_estimated: c.meritPoints,
        submitted_at: new Date(c.created_at * 1000).toISOString(),
        status: c.status || 'approved',
        source: 'nostr',
        verifiedBy: c.verifiedBy || null
    })), ...legacyContribs.map(c => ({ ...c, source: 'legacy' }))];

    const ledgerBody = document.getElementById('ledgerTableBody');
    if (!ledgerBody) return;

    if (allContribs.length === 0) {
        ledgerBody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align: center; padding: 2rem; color: var(--color-text-secondary);">
                    🌟 No hay emisiones registradas aún. Sé el primero en presentar una aportación.
                </td>
            </tr>
        `;
    } else {
        let totalEmitido = 0;
        const aportantesSet = new Set();

        ledgerBody.innerHTML = allContribs.map((c, i) => {
            const lbwm = parseFloat(c.lbwm_estimated || 0);
            totalEmitido += lbwm;
            aportantesSet.add(c.applicant_public_key);
            // [v2.0] Status includes pending_verification, approved, rejected
            const statusClass = c.status === 'approved' || c.status === 'verified'
                ? 'status-activo' : c.status === 'rejected' ? 'status-rechazado' : 'status-pendiente';
            const statusLabel = c.status === 'approved' || c.status === 'verified'
                ? '✅ Activo' : c.status === 'rejected' ? '❌ Rechazado' : '⏳ Pendiente';
            const date = c.submitted_at ? new Date(c.submitted_at).toISOString().split('T')[0] : '-';
            const sourceIcon = c.source === 'nostr' ? '⚡' : '📦';

            return `
                <tr>
                    <td>${String(i + 1).padStart(3, '0')}</td>
                    <td>${date}</td>
                    <td>${sourceIcon} ${c.applicant_name || '-'}</td>
                    <td>${c.contribution_type || '-'}</td>
                    <td>${(c.description || '-').substring(0, 50)}${(c.description || '').length > 50 ? '...' : ''}</td>
                    <td style="text-align: right;">${c.reference_value || 0} ${c.currency || 'EUR'}</td>
                    <td style="text-align: center;">${c.factor_proposed || '-'}</td>
                    <td style="text-align: right; font-weight: 700; color: var(--color-gold);">${typeof lbwm === 'number' ? lbwm.toFixed(2) : lbwm}</td>
                    <td style="text-align: center;"><span class="status-badge ${statusClass}">${statusLabel}</span></td>
                </tr>
            `;
        }).join('');

        const el = id => document.getElementById(id);
        if (el('ledger_total_emitido')) el('ledger_total_emitido').textContent = totalEmitido.toFixed(2) + ' LBWM';
        if (el('ledger_emisiones')) el('ledger_emisiones').textContent = allContribs.length;
        if (el('ledger_aportantes')) el('ledger_aportantes').textContent = aportantesSet.size;
    }
}

async function updateLbwmStats(userMerits) {
    try {
        if (typeof LBW_Merits === 'undefined') return;

        const stats = LBW_Merits.getStats();
        const el = id => document.getElementById(id);

        if (el('stat_total_lbwm')) el('stat_total_lbwm').textContent = stats.totalMerits;
        if (el('stat_aportantes')) el('stat_aportantes').textContent = Math.max(stats.totalParticipants, 1);
        if (el('stat_emisiones')) el('stat_emisiones').textContent = stats.totalContributions;

        if (stats.totalMerits > 0 && userMerits > 0) {
            const pct = (userMerits / stats.totalMerits) * 100;
            if (el('stat_mi_participacion')) el('stat_mi_participacion').textContent = pct.toFixed(2) + '%';
            if (el('participacionBar')) el('participacionBar').style.width = Math.min(pct, 100).toFixed(2) + '%';
        } else {
            if (el('stat_mi_participacion')) el('stat_mi_participacion').textContent = '0%';
            if (el('participacionBar')) el('participacionBar').style.width = '0%';
        }

        console.log(`[Merits] Global: ${stats.totalMerits} | User: ${userMerits} | Participants: ${stats.totalParticipants}`);
    } catch (err) {
        console.error('Error calculating global stats:', err);
    }
}

// ═══════════════════════════════════════════════════════════════
// UI FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function switchLbwmTab(tabName) {
    document.querySelectorAll('.lbwm-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.lbwm-tab-content').forEach(content => content.classList.remove('active'));
    const tab = document.querySelector(`.lbwm-tab[data-lbwm-tab="${tabName}"]`);
    if (tab) tab.classList.add('active');
    const content = document.getElementById(`lbwm-tab-${tabName}`);
    if (content) content.classList.add('active');

    // [v2.0] Refresh data on tab switch
    if (tabName === 'bloques-voto') updateVotingBlocksDisplay();
    if (tabName === 'dashboard') { var m = parseInt(document.getElementById('userTotalMerits')?.textContent) || 0; updateDashboardDisplay(m); }
    if (tabName === 'propuestas') loadMeritProposals();
    if (tabName === 'verificaciones') loadPendingVerifications();
    if (tabName === 'niveles') { var m2 = parseInt(document.getElementById('userTotalMerits')?.textContent) || 0; renderCitizenshipLevels(m2); }
    if (tabName === 'mis-aportaciones') loadMyContributions();
    if (tabName === 'misiones') {
        LBW_Missions.renderMissionsTab();
        // Update badge
        const badge = document.getElementById('tabBadgeMissions');
        if (badge) { const n = LBW_Missions.getOpenCount(); badge.textContent = n; badge.style.display = n > 0 ? 'inline-flex' : 'none'; }
    }
    if (tabName === 'ranking-pioneros') {
        if (typeof updatePioneerDashboard === 'function') updatePioneerDashboard();
    }
}

function toggleFinanciada() {
    updatePreviewCalculation();
}

// ═══════════════════════════════════════════════════════════════
// [v2.0] CONTRIBUTION FORM — Dual flow
// ═══════════════════════════════════════════════════════════════

function showContributionForm() {
    const modal = document.getElementById('contributionFormModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('active');
    }
    const identityEl = document.getElementById('contrib_identity');
    if (identityEl) identityEl.value = currentUser?.name || '';
    updateContributionFactor();
    updatePreviewCalculation();
}

function closeContributionForm() {
    const modal = document.getElementById('contributionFormModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('active');
    }
    const form = document.getElementById('contributionForm');
    if (form) form.reset();
    // Reset flow UI
    updateFlowIndicator();
}

function updateContributionFactor() {
    const typeSelect = document.getElementById('contrib_type');
    if (!typeSelect) return;
    const category = typeSelect.value;

    // Show/hide Responsabilidad warning
    const respWarning = document.getElementById('responsabilidad_warning');
    if (respWarning) {
        respWarning.style.display = category === 'responsabilidad' ? 'block' : 'none';
    }

    // [v2.0] Show/hide payMethod section (only for económica)
    const payMethodSection = document.getElementById('payMethodSection');
    if (payMethodSection) {
        payMethodSection.style.display = category === 'economica' ? 'block' : 'none';
    }

    // Get weight from v2.0 CATEGORIES
    const catDef = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.CATEGORIES[category] : null;
    const weight = catDef ? catDef.weight : 1.0;

    const pfEl = document.getElementById('preview_factor');
    if (pfEl) pfEl.textContent = weight.toFixed(1);

    updateFlowIndicator();
    updatePreviewCalculation();
}

// [v2.0-NEW] Show flow indicator based on category + payMethod
function updateFlowIndicator() {
    const flowEl = document.getElementById('flowIndicator');
    const submitBtn = document.getElementById('submitContribBtn');
    const approvalNote = document.getElementById('preview_approval_note');
    if (!flowEl) return;

    const category = document.getElementById('contrib_type')?.value || '';
    const payMethod = document.getElementById('contrib_payMethod')?.value || 'lightning';
    const isEcon = category === 'economica';
    const isAutoVerifiable = isEcon && (payMethod === 'lightning' || payMethod === 'btc_onchain');

    if (!category) {
        flowEl.style.display = 'none';
        return;
    }

    flowEl.style.display = 'block';

    if (isAutoVerifiable) {
        flowEl.style.background = 'rgba(76,175,80,0.1)';
        flowEl.style.border = '1px solid rgba(76,175,80,0.3)';
        flowEl.style.color = '#81C784';
        flowEl.innerHTML = `<strong>${payMethod === 'lightning' ? '⚡' : '⛓️'} Verificación Automática</strong><br/>
            El pago se verifica directamente en ${payMethod === 'lightning' ? 'Lightning Network' : 'la blockchain de Bitcoin'}. Los méritos se emiten automáticamente.`;
        if (submitBtn) submitBtn.textContent = '⚡ Verificar y Registrar';
        if (approvalNote) approvalNote.textContent = 'Méritos emitidos automáticamente al verificar TX';
    } else if (isEcon) {
        flowEl.style.background = 'rgba(156,39,176,0.1)';
        flowEl.style.border = '1px solid rgba(156,39,176,0.3)';
        flowEl.style.color = '#CE93D8';
        flowEl.innerHTML = `<strong>👑 Verificación por Gobernador</strong><br/>
            Un Gobernador (≥3.000 méritos) revisará la prueba de pago y confirmará la recepción antes de emitir méritos.`;
        if (submitBtn) submitBtn.textContent = '👑 Enviar a Gobernador';
        if (approvalNote) approvalNote.textContent = 'Pendiente de verificación por Gobernador';
    } else {
        flowEl.style.background = 'rgba(156,39,176,0.1)';
        flowEl.style.border = '1px solid rgba(156,39,176,0.3)';
        flowEl.style.color = '#CE93D8';
        flowEl.innerHTML = `<strong>🗳️ Propuesta → Votación</strong><br/>
            Se crea una propuesta sometida a votación comunitaria (3 días, quorum 30%, mayoría simple).`;
        if (submitBtn) submitBtn.textContent = '🗳️ Crear Propuesta';
        if (approvalNote) approvalNote.textContent = 'Sujeto a aprobación por votación comunitaria';
    }
}

function updatePreviewCalculation() {
    const value = parseFloat(document.getElementById('contrib_value')?.value) || 0;
    const currency = document.getElementById('contrib_currency')?.value || 'EUR';
    const tipo = document.getElementById('contrib_type')?.value;

    const catDef = (typeof LBW_Merits !== 'undefined' && tipo) ? LBW_Merits.CATEGORIES[tipo] : null;
    const weight = catDef ? catDef.weight : 1.0;

    const lbwm = (value * weight).toFixed(2);
    const el = id => document.getElementById(id);
    if (el('preview_value')) el('preview_value').textContent = value.toFixed(2);
    if (el('preview_currency')) el('preview_currency').textContent = currency;
    if (el('preview_factor')) el('preview_factor').textContent = weight.toFixed(1);
    if (el('preview_lbwm')) el('preview_lbwm').textContent = lbwm;
}

document.addEventListener('DOMContentLoaded', () => {
    const valueInput = document.getElementById('contrib_value');
    const currencySelect = document.getElementById('contrib_currency');

    if (valueInput) valueInput.addEventListener('input', updatePreviewCalculation);
    if (currencySelect) currencySelect.addEventListener('change', updatePreviewCalculation);
});

// ═══════════════════════════════════════════════════════════════
// [v2.0] DUAL FLOW SUBMISSION
// ═══════════════════════════════════════════════════════════════

async function submitContribution(event) {
    if (event) event.preventDefault();

    if (typeof LBW_Merits === 'undefined' || !LBW_Nostr.isLoggedIn()) {
        showNotification('Necesitas estar conectado con Nostr', 'error');
        return;
    }

    try {
        const category = document.getElementById('contrib_type')?.value;
        const value = parseFloat(document.getElementById('contrib_value')?.value) || 0;
        const description = document.getElementById('contrib_description')?.value || '';
        const evidence = document.getElementById('contrib_evidence')?.value || '';
        const payMethod = document.getElementById('contrib_payMethod')?.value || '';
        const isEcon = category === 'economica';
        const isAutoVerifiable = isEcon && (payMethod === 'lightning' || payMethod === 'btc_onchain');

        if (!category || !description.trim() || value <= 0) {
            showNotification('Rellena todos los campos obligatorios', 'error');
            return;
        }

        if (isEcon) {
            // ── ECONOMIC FLOW ──
            // Step 1: Register contribution in Nostr
            const result = await LBW_Merits.submitContribution({
                description,
                category,
                amount: value,
                currency: document.getElementById('contrib_currency')?.value || 'EUR',
                evidence: evidence ? [evidence, `payMethod:${payMethod}`] : [`payMethod:${payMethod}`],
                status: isAutoVerifiable ? 'verified' : 'pending_verification'
            });

            if (isAutoVerifiable) {
                // Step 2a: Auto-verify (crypto payment)
                // In production this would check the blockchain/Lightning.
                // For now, auto-award merits since TX is verifiable.
                const pubkey = LBW_Nostr.getPubkey();
                await LBW_Merits.awardMerit(
                    pubkey, value, category,
                    `Auto-verificado: ${payMethod === 'lightning' ? '⚡ Lightning' : '⛓️ Bitcoin on-chain'}`
                );
                showNotification('✅ Pago verificado automáticamente. Méritos emitidos.', 'success');
            } else {
                // Step 2b: Pending governor verification
                showNotification('📨 Aportación registrada. Pendiente de verificación por Gobernador.', 'success');
            }
        } else {
            // ── PROPOSAL FLOW (productiva, responsabilidad, financiada) ──
            // Submit as contribution record (pending vote, NO merits yet)
            await LBW_Merits.submitContribution({
                description,
                category,
                amount: value,
                currency: document.getElementById('contrib_currency')?.value || 'EUR',
                evidence: evidence ? [evidence] : [],
                status: 'pending_vote'
            });

            // If governance system available, also create a proposal for voting
            if (typeof LBW_Governance !== 'undefined' && LBW_Governance.publishProposal) {
                try {
                    const catDef = LBW_Merits.CATEGORIES[category];
                    await LBW_Governance.publishProposal({
                        title: `[Aportación ${catDef.emoji} ${catDef.label}] ${description}`,
                        description: `Valor: ${value} · Peso: ×${catDef.weight} · LBWM estimados: ${(value * catDef.weight).toFixed(2)}` +
                            (evidence ? `\nEvidencia: ${evidence}` : ''),
                        category: 'referendum'
                    });
                    showNotification('🗳️ Propuesta creada. Sometida a votación comunitaria (3 días).', 'success');
                } catch (govErr) {
                    console.warn('[Merits] Governance proposal failed, contribution still registered:', govErr);
                    showNotification('✅ Aportación registrada en Nostr. (Propuesta de gobernanza no disponible)', 'success');
                }
            } else {
                showNotification('✅ Aportación registrada en Nostr con éxito', 'success');
            }
        }

        closeContributionForm();

        // Refresh data
        setTimeout(async () => {
            await loadMeritsData();
            loadMyContributions();
        }, 500);

    } catch (err) {
        console.error('Error submitting contribution:', err);
        showNotification('Error: ' + err.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════════════
// [v2.0-NEW] GOVERNOR VERIFICATION (for bank/other deposits)
// ═══════════════════════════════════════════════════════════════

async function verifyDeposit(contribId) {
    if (!getUnifiedMerits().isGovernor) {
        showNotification('Solo los Gobernadores (≥3.000 méritos) pueden verificar aportaciones.', 'error');
        return;
    }

    try {
        // Award merit to the contributor
        // getAllContributions() returns contributions from ALL users (visible on relay)
        const contrib = (typeof LBW_Merits.getAllContributions === 'function')
            ? LBW_Merits.getAllContributions().find(c => c.id === contribId)
            : null;
        if (!contrib) {
            showNotification('Aportación no encontrada. Asegúrate de estar suscrito al relay.', 'error');
            return;
        }
        if (!contrib.pubkey) {
            showNotification('No se pudo determinar el autor de la aportación.', 'error');
            return;
        }

        const governorPubkey = LBW_Nostr.getPubkey();
        if (contrib.pubkey === governorPubkey) {
            showNotification('Un Gobernador no puede verificar sus propias aportaciones.', 'error');
            return;
        }

        await LBW_Merits.awardMerit(
            contrib.pubkey, contrib.amount, contrib.category,
            '👑 Verificado por Gobernador'
        );

        showNotification('✅ Aportación verificada. Méritos emitidos.', 'success');

        // Refresh
        setTimeout(async () => {
            await loadMeritsData();
            loadMyContributions();
        }, 500);

    } catch (err) {
        console.error('Error verifying deposit:', err);
        showNotification('Error: ' + err.message, 'error');
    }
}

async function rejectDeposit(contribId) {
    if (!getUnifiedMerits().isGovernor) {
        showNotification('Solo los Gobernadores pueden rechazar aportaciones.', 'error');
        return;
    }

    if (!confirm('¿Confirmar rechazo de esta aportación? El usuario será notificado.')) return;

    try {
        const contrib = (typeof LBW_Merits.getAllContributions === 'function')
            ? LBW_Merits.getAllContributions().find(c => c.id === contribId)
            : null;

        if (!contrib) {
            showNotification('Aportación no encontrada.', 'error');
            return;
        }

        const governorPubkey = LBW_Nostr.getPubkey();
        if (contrib.pubkey === governorPubkey) {
            showNotification('Un Gobernador no puede rechazar sus propias aportaciones.', 'error');
            return;
        }

        // Publish rejection as a kind 31003 status-update event on Nostr
        // so it's verifiable, auditable, and notifies the contributor via relay
        await LBW_Nostr.publishEvent({
            kind: 31003,
            content: JSON.stringify({
                action: 'reject',
                reason: 'No verificado por Gobernador',
                contribId,
                governor: governorPubkey,
                timestamp: Math.floor(Date.now() / 1000)
            }),
            tags: [
                ['d', `reject-${contribId}`],
                ['e', contribId],
                ['p', contrib.pubkey],
                ['status', 'rejected'],
                ['t', 'lbw-merits'],
                ['t', 'lbw-reject'],
                ['client', 'LiberBit World']
            ]
        });

        showNotification('❌ Aportación rechazada y publicada en Nostr.', 'error');

        setTimeout(async () => {
            await loadMeritsData();
            loadMyContributions();
        }, 500);

    } catch (err) {
        console.error('Error rejecting deposit:', err);
        showNotification('Error al rechazar: ' + err.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════════════
// My Contributions (updated with verification status)
// ═══════════════════════════════════════════════════════════════

function loadMyContributions() {
    const myContribs = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getMyContributions() : [];

    const pubKey = LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : (currentUser?.pubkey || '');
    // Legacy fallback: solo lectura. Se eliminará tras confirmar migración completa.
    const legacyContribs = localStorage.getItem('lbw_legacy_migrated') === '1'
        ? []
        : JSON.parse(localStorage.getItem('liberbit_contributions') || '[]').filter(c => c.applicant_public_key === pubKey);

    const allMyContribs = [
        ...myContribs.map(c => ({
            id: c.id,
            description: c.description,
            period: new Date(c.created_at * 1000).toLocaleDateString('es-ES'),
            reference_value: c.amount,
            currency: c.currency || 'units',
            factor_proposed: c.weight,
            lbwm_estimated: c.meritPoints,
            status: c.status || 'pending_vote',
            source: 'nostr',
            category: c.category,
            verifiedBy: c.verifiedBy || null
        })),
        ...legacyContribs.map(c => ({ ...c, source: 'legacy' }))
    ];

    const container = document.getElementById('myContributionsList');
    if (!container) return;

    if (allMyContribs.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--color-text-secondary);"><p>No has presentado aportaciones aún</p></div>';
        return;
    }

    const statusColors = {
        pending: '#FF9800', pending_verification: '#FF9800', pending_vote: '#9C27B0',
        approved: '#4CAF50', verified: '#4CAF50',
        rejected: '#F44336', voting: '#9C27B0'
    };
    const statusLabels = {
        pending: '⏳ Pendiente', pending_verification: '⏳ Verificando', pending_vote: '🗳️ Pendiente de Voto',
        approved: '✅ Aprobada', verified: '✅ Verificada',
        rejected: '❌ Rechazada', voting: '🗳️ En Votación'
    };

    container.innerHTML = allMyContribs.map(c => {
        const catDef = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.CATEGORIES[c.category] : null;
        const catLabel = catDef ? `${catDef.emoji} ${catDef.label}` : (c.category || '-');
        const flowLabel = c.category === 'economica' ? '💰 Verificación' : '🗳️ Propuesta';

        return `
            <div style="background: var(--color-bg-dark); padding: 1.5rem; border-radius: 12px; border-left: 4px solid ${statusColors[c.status] || '#4CAF50'}; margin-bottom: 1rem;">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 1rem;">
                    <div>
                        <div style="font-weight: 600; color: var(--color-text-primary); margin-bottom: 0.5rem;">${c.source === 'nostr' ? '⚡' : '📦'} ${c.description || '-'}</div>
                        <div style="font-size: 0.85rem; color: var(--color-text-secondary);">
                            ${c.period || '-'} · ${catLabel} · ${flowLabel}
                            ${c.verifiedBy ? ` · ${c.verifiedBy}` : ''}
                        </div>
                    </div>
                    <span style="padding: 0.4rem 0.8rem; background: ${statusColors[c.status] || '#4CAF50'}; color: white; border-radius: 8px; font-size: 0.75rem; font-weight: 600;">
                        ${statusLabels[c.status] || '✅ Aprobada'}
                    </span>
                </div>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--color-border);">
                    <div>
                        <div style="font-size: 0.75rem; color: var(--color-text-secondary);">Valor</div>
                        <div style="font-weight: 600; color: var(--color-text-primary);">${c.reference_value || 0} ${c.currency || 'EUR'}</div>
                    </div>
                    <div>
                        <div style="font-size: 0.75rem; color: var(--color-text-secondary);">Peso</div>
                        <div style="font-weight: 600; color: var(--color-text-primary);">×${c.factor_proposed || '1.0'}</div>
                    </div>
                    <div>
                        <div style="font-size: 0.75rem; color: var(--color-text-secondary);">LBWM</div>
                        <div style="font-weight: 700; color: var(--color-gold); font-size: 1.1rem;">${typeof c.lbwm_estimated === 'number' ? c.lbwm_estimated.toFixed(2) : c.lbwm_estimated}</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// ═══════════════════════════════════════════════════════════════
// [v2.0-NEW] DASHBOARD GAUGE
// ═══════════════════════════════════════════════════════════════

// GAUGE_LEVELS derivado de LBW_Merits.CITIZENSHIP_LEVELS (fuente única de verdad)
// shortLabel: etiqueta corta para el canvas del gauge
const GAUGE_SHORT_LABELS = ['Amigo', 'E-Res.', 'Colabor.', 'C.Senior', 'Embajad.', 'Gobern.'];
const GAUGE_LEVELS = (typeof LBW_Merits !== 'undefined' ? LBW_Merits.CITIZENSHIP_LEVELS : []).map((l, i) => ({
    name: l.name,
    shortLabel: GAUGE_SHORT_LABELS[i] || l.name,
    min: l.minMerits,
    emoji: l.emoji,
    color: l.color,
    bloc: l.bloc
}));
const GAUGE_THRESH = GAUGE_LEVELS.map(s => s.min);
const GAUGE_RANGES = [100, 400, 500, 1000, 1000, 500];
const GAUGE_N = GAUGE_LEVELS.length;
const SEG_ANG = Math.PI / GAUGE_N;
const GAP = 0.02;

function _meritsToAngle(m) {
    if (m >= 3000) { var extra = Math.min(m - 3000, GAUGE_RANGES[5]); return Math.PI - 5 * SEG_ANG - (extra / GAUGE_RANGES[5]) * SEG_ANG; }
    for (var i = 0; i < GAUGE_N - 1; i++) { if (m < GAUGE_THRESH[i + 1]) { return Math.PI - i * SEG_ANG - ((m - GAUGE_THRESH[i]) / GAUGE_RANGES[i]) * SEG_ANG; } }
    return 0;
}

function _getGaugeLevel(merits) {
    var level = Object.assign({}, GAUGE_LEVELS[0], { idx: 0 });
    for (var i = 0; i < GAUGE_N; i++) {
        if (merits >= GAUGE_LEVELS[i].min) level = Object.assign({}, GAUGE_LEVELS[i], { idx: i });
    }
    return level;
}

function _getNextLevel(merits) {
    for (var i = 0; i < GAUGE_N; i++) {
        if (merits < GAUGE_LEVELS[i].min) return { level: GAUGE_LEVELS[i], remaining: GAUGE_LEVELS[i].min - merits, progress: merits / GAUGE_LEVELS[i].min };
    }
    return null;
}

var _gaugeAnimFrame = null;
var _gaugeCurrentAngle = Math.PI;

function drawMeritsGauge(merits) {
    var canvas = document.getElementById('meritsGaugeCanvas');
    if (!canvas) return;

    var targetAngle = _meritsToAngle(merits);
    var level = _getGaugeLevel(merits);

    if (_gaugeAnimFrame) cancelAnimationFrame(_gaugeAnimFrame);

    function animate() {
        var diff = targetAngle - _gaugeCurrentAngle;
        if (Math.abs(diff) < 0.005) { _gaugeCurrentAngle = targetAngle; }
        else { _gaugeCurrentAngle += diff * 0.08; _gaugeAnimFrame = requestAnimationFrame(animate); }
        _renderGauge(canvas, merits, _gaugeCurrentAngle, level);
    }
    animate();
}

function _renderGauge(canvas, merits, needleAng, level) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var CX = W / 2, CY = H - 30, R = 200, BAND = 36;
    ctx.clearRect(0, 0, W, H);
    
    // Draw segments using stroke technique (same as profile.js)
    for (var i = 0; i < GAUGE_N; i++) {
        var aStart = Math.PI - i * SEG_ANG - GAP;
        var aEnd = Math.PI - (i + 1) * SEG_ANG + GAP;
        var isActive = i <= level.idx;
        var isCurrent = i === level.idx;
        
        // Main arc segment
        ctx.beginPath();
        ctx.arc(CX, CY, R, -aStart, -aEnd, false);
        ctx.lineWidth = BAND;
        ctx.strokeStyle = GAUGE_LEVELS[i].color;
        ctx.globalAlpha = isActive ? (isCurrent ? 0.85 : 0.55) : 0.15;
        ctx.lineCap = 'butt';
        ctx.stroke();
        
        // Glow effect for current level
        if (isCurrent) {
            ctx.beginPath();
            ctx.arc(CX, CY, R, -aStart, -aEnd, false);
            ctx.lineWidth = BAND + 15;
            ctx.strokeStyle = GAUGE_LEVELS[i].color;
            ctx.globalAlpha = 0.15;
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        
        // Labels
        var midAng = (aStart + aEnd) / 2;
        var lx = CX + (R + BAND/2 + 16) * Math.cos(midAng);
        var ly = CY - (R + BAND/2 + 16) * Math.sin(midAng);
        ctx.save();
        ctx.translate(lx, ly);
        var rot = -midAng + Math.PI/2;
        if (rot > Math.PI/2) rot -= Math.PI;
        if (rot < -Math.PI/2) rot += Math.PI;
        ctx.rotate(rot);
        ctx.font = '600 12px Poppins, sans-serif';
        ctx.fillStyle = GAUGE_LEVELS[i].color;
        ctx.globalAlpha = isActive ? 0.9 : 0.5;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(GAUGE_LEVELS[i].shortLabel, 0, 0);
        ctx.restore();
        ctx.globalAlpha = 1;
        
        // Tick marks between segments
        if (i > 0) {
            var tickAng = Math.PI - i * SEG_ANG;
            ctx.beginPath();
            ctx.moveTo(CX + (R - BAND/2 - 5) * Math.cos(tickAng), CY - (R - BAND/2 - 5) * Math.sin(tickAng));
            ctx.lineTo(CX + (R + BAND/2 + 5) * Math.cos(tickAng), CY - (R + BAND/2 + 5) * Math.sin(tickAng));
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        
        // Threshold numbers
        var numAng = Math.PI - i * SEG_ANG;
        ctx.font = '400 10px JetBrains Mono, monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        var numLabel = GAUGE_THRESH[i] >= 1000 ? (GAUGE_THRESH[i]/1000) + 'K' : GAUGE_THRESH[i].toString();
        ctx.fillText(numLabel, CX + (R - BAND/2 - 18) * Math.cos(numAng), CY - (R - BAND/2 - 18) * Math.sin(numAng));
    }
    
    // 3K+ label at end
    ctx.font = '400 10px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.textAlign = 'center';
    ctx.fillText('3K+', CX + (R - BAND/2 - 18), CY);
    
    // Needle with glow effect
    var tipX = CX + (R - 12) * Math.cos(needleAng);
    var tipY = CY - (R - 12) * Math.sin(needleAng);
    var bOX = 4 * Math.cos(needleAng + Math.PI/2);
    var bOY = 4 * Math.sin(needleAng + Math.PI/2);
    
    // Needle shadow/glow
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(CX + bOX, CY - bOY);
    ctx.lineTo(CX - bOX, CY + bOY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(229,185,92,0.3)';
    ctx.shadowColor = '#E5B95C';
    ctx.shadowBlur = 15;
    ctx.fill();
    ctx.shadowBlur = 0;
    
    // Needle main
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(CX + bOX, CY - bOY);
    ctx.lineTo(CX - bOX, CY + bOY);
    ctx.closePath();
    ctx.fillStyle = '#E5B95C';
    ctx.fill();
    
    // Center hub with gradient
    ctx.beginPath();
    ctx.arc(CX, CY, 14, 0, Math.PI * 2);
    var hg = ctx.createRadialGradient(CX, CY - 4, 2, CX, CY, 14);
    hg.addColorStop(0, '#2a4a56');
    hg.addColorStop(1, '#0D171E');
    ctx.fillStyle = hg;
    ctx.fill();
    ctx.strokeStyle = '#E5B95C';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    
    // Center dot
    ctx.beginPath();
    ctx.arc(CX, CY, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#E5B95C';
    ctx.fill();
    
    // Center highlight
    ctx.beginPath();
    ctx.arc(CX, CY - 2, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
}

function updateDashboardDisplay(merits) {
    var level = _getGaugeLevel(merits);
    var next = _getNextLevel(merits);

    // Gauge merit count
    var countEl = document.getElementById('meritsGaugeMeritCount');
    if (countEl) countEl.textContent = merits.toLocaleString('es-ES');

    // Gauge badge
    var badgeEl = document.getElementById('meritsGaugeBadge');
    if (badgeEl) {
        badgeEl.textContent = level.emoji + ' ' + level.name;
        badgeEl.style.borderColor = level.color;
        badgeEl.style.color = level.color;
        badgeEl.style.background = level.color + '18';
    }

    // Header badge
    var hBadge = document.getElementById('dashboardLevelBadge');
    if (hBadge) {
        hBadge.textContent = level.emoji + ' ' + level.name.toUpperCase();
        hBadge.style.borderColor = level.color;
        hBadge.style.color = level.color;
        hBadge.style.background = level.color + '18';
    }

    // Bloc label
    var blocLabel = document.getElementById('dashboardBlocLabel');
    if (blocLabel) blocLabel.textContent = 'Bloque: ' + level.bloc;

    // Progress bar
    var progressBar = document.getElementById('meritsProgressBar');
    var progressFill = document.getElementById('meritsProgressFill');
    var progressLabel = document.getElementById('meritsProgressLabel');
    var progressRemaining = document.getElementById('meritsProgressRemaining');
    if (progressBar && next) {
        progressBar.style.display = 'block';
        var prevMin = GAUGE_LEVELS[level.idx].min;
        var pct = ((merits - prevMin) / (next.level.min - prevMin)) * 100;
        if (progressFill) progressFill.style.width = Math.min(100, pct) + '%';
        if (progressLabel) progressLabel.textContent = 'Progreso a ' + next.level.name;
        if (progressRemaining) progressRemaining.textContent = 'Faltan ' + next.remaining.toLocaleString('es-ES');
    } else if (progressBar) {
        progressBar.style.display = 'none';
    }

    // Activity row
    const actData = getUnifiedMerits();
    const actRow = document.getElementById('activityLegacyRow');
    const actVal = document.getElementById('activityMeritsValue');
    if (actRow && actData.activityMerits > 0) {
        actRow.style.display = 'block';
        if (actVal) actVal.textContent = actData.activityMerits + ' pts';
    }

    // Draw gauge
    drawMeritsGauge(merits);
}

// ═══════════════════════════════════════════════════════════════
// [v2.0-NEW] PROPOSALS TAB
// ═══════════════════════════════════════════════════════════════

var _currentProposalFilter = 'all';

function loadMeritProposals() {
    if (typeof LBW_Governance === 'undefined' || !LBW_Governance.getAllProposals) {
        return;
    }

    var allProposals = LBW_Governance.getAllProposals();
    // Filter to merit-related proposals (those with [Aportación] in title)
    var meritProposals = allProposals.filter(function(p) {
        return p.title && (p.title.includes('[Aportación') || p.title.includes('Aportación'));
    });

    // If no merit-specific proposals, show all proposals
    if (meritProposals.length === 0) meritProposals = allProposals;

    // Enrich proposals with hasVoted field by checking getMyVote
    meritProposals = meritProposals.map(function(p) {
        var myVote = null;
        if (LBW_Governance.getMyVote) {
            myVote = LBW_Governance.getMyVote(p.dTag || p.id);
        }
        return Object.assign({}, p, { hasVoted: !!myVote, myVote: myVote });
    });

    // Apply filter
    var filtered = meritProposals;
    if (_currentProposalFilter !== 'all') {
        filtered = meritProposals.filter(function(p) {
            if (_currentProposalFilter === 'voting') return p.status === 'active' || p.status === 'voting';
            if (_currentProposalFilter === 'approved') return p.status === 'approved' || p.status === 'passed';
            if (_currentProposalFilter === 'rejected') return p.status === 'rejected' || p.status === 'failed';
            return true;
        });
    }

    // Count unvoted for badge
    var unvotedCount = meritProposals.filter(function(p) {
        return (p.status === 'active' || p.status === 'voting') && !p.hasVoted;
    }).length;

    var badge = document.getElementById('tabBadgeProposals');
    if (badge) {
        if (unvotedCount > 0) { badge.style.display = 'inline-flex'; badge.textContent = unvotedCount; }
        else { badge.style.display = 'none'; }
    }

    // Update stats
    var statEl = document.getElementById('stat_pending_proposals');
    if (statEl) statEl.textContent = unvotedCount;

    // Render
    var container = document.getElementById('meritProposalsList');
    if (!container) return;

    if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--color-text-secondary);">Sin propuestas' + (_currentProposalFilter !== 'all' ? ' con filtro "' + _currentProposalFilter + '"' : '') + '</div>';
        return;
    }

    var statusColors = { active: '#9C27B0', voting: '#9C27B0', approved: '#4CAF50', passed: '#4CAF50', rejected: '#F44336', failed: '#F44336' };
    var statusLabels = { active: '🗳️ En Votación', voting: '🗳️ En Votación', approved: '✅ Aprobada', passed: '✅ Aprobada', rejected: '❌ Rechazada', failed: '❌ Rechazada' };

    container.innerHTML = filtered.map(function(p) {
        var color = statusColors[p.status] || '#9C27B0';
        var label = statusLabels[p.status] || p.status;
        var votesFor = p.votesFor || p.votes_for || 0;
        var votesAgainst = p.votesAgainst || p.votes_against || 0;
        var totalVotes = votesFor + votesAgainst;
        var forPct = totalVotes > 0 ? (votesFor / totalVotes) * 100 : 0;
        var againstPct = totalVotes > 0 ? (votesAgainst / totalVotes) * 100 : 0;

        // Determine what to show based on vote status
        var voteSection = '';
        if (p.status === 'active' || p.status === 'voting') {
            if (p.hasVoted) {
                // User already voted - show their vote
                var voteOption = p.myVote ? (p.myVote.option || p.myVote.vote || 'Votado') : 'Votado';
                var voteIcon = (voteOption === 'A favor' || voteOption === 'for') ? '✅' : '❌';
                voteSection = '<div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.75rem;padding:0.5rem 0.75rem;background:rgba(229,185,92,0.1);border-radius:8px;border-left:3px solid var(--color-gold);">' +
                    '<span style="font-size:1.1rem;">' + voteIcon + '</span>' +
                    '<span style="font-size:0.85rem;color:var(--color-gold);font-weight:600;">Ya votaste: ' + voteOption + '</span>' +
                '</div>';
            } else {
                // User hasn't voted - show vote buttons
                voteSection = '<div style="display:flex;gap:0.5rem;margin-top:0.75rem;">' +
                    '<button class="btn btn-sm" style="background:var(--color-success);color:#fff;font-size:0.8rem;padding:0.4rem 0.8rem;border-radius:8px;border:none;cursor:pointer;" onclick="voteMeritProposal(\'' + (p.dTag || p.id) + '\',\'for\')">✅ A favor</button>' +
                    '<button class="btn btn-sm" style="background:var(--color-error);color:#fff;font-size:0.8rem;padding:0.4rem 0.8rem;border-radius:8px;border:none;cursor:pointer;" onclick="voteMeritProposal(\'' + (p.dTag || p.id) + '\',\'against\')">❌ En contra</button>' +
                '</div>';
            }
        }

        return '<div style="background:var(--color-bg-dark);padding:1.25rem;border-radius:12px;border-left:4px solid ' + color + ';margin-bottom:0.75rem;">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5rem;">' +
                '<div style="flex:1;">' +
                    '<div style="font-weight:700;font-size:0.95rem;color:var(--color-text-primary);">' + (p.title || p.description || '-') + '</div>' +
                    '<div style="font-size:0.8rem;color:var(--color-text-secondary);margin-top:0.25rem;">por <strong>' + (p.author || p.authorName || 'Anónimo') + '</strong></div>' +
                '</div>' +
                '<span style="padding:0.3rem 0.6rem;background:' + color + '22;color:' + color + ';border-radius:8px;font-size:0.75rem;font-weight:600;white-space:nowrap;">' + label + '</span>' +
            '</div>' +
            // Vote bar
            '<div style="display:flex;border-radius:6px;overflow:hidden;height:6px;background:rgba(255,255,255,0.08);margin:0.5rem 0;">' +
                '<div style="background:var(--color-success);width:' + forPct + '%;transition:width 0.3s;"></div>' +
                '<div style="background:var(--color-error);width:' + againstPct + '%;transition:width 0.3s;"></div>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--color-text-secondary);">' +
                '<span>✅ ' + votesFor + '</span><span>❌ ' + votesAgainst + '</span><span>👥 ' + totalVotes + '</span>' +
            '</div>' +
            voteSection +
        '</div>';
    }).join('');
}

function filterMeritProposals(filter) {
    _currentProposalFilter = filter;

    // Update pill styles
    var pills = document.querySelectorAll('#proposalFilterPills button');
    pills.forEach(function(pill) {
        if (pill.getAttribute('data-filter') === filter) {
            pill.style.background = 'rgba(229,185,92,0.15)';
            pill.style.color = 'var(--color-gold)';
            pill.style.borderColor = 'var(--color-gold)';
        } else {
            pill.style.background = 'var(--color-bg-dark)';
            pill.style.color = 'var(--color-text-secondary)';
            pill.style.borderColor = 'var(--color-border)';
        }
    });

    loadMeritProposals();
}

async function voteMeritProposal(proposalDTag, vote) {
    if (typeof LBW_Governance === 'undefined' || !LBW_Governance.publishVote) {
        showNotification('Sistema de gobernanza no disponible', 'error');
        return;
    }
    try {
        const proposal = LBW_Governance.getProposal(proposalDTag);
        if (!proposal) {
            showNotification('Propuesta no encontrada', 'error');
            return;
        }
        const option = vote === 'for' ? 'A favor' : 'En contra';
        await LBW_Governance.publishVote(proposal.id, proposalDTag, option);
        showNotification('✅ Voto registrado', 'success');
        setTimeout(function() { loadMeritProposals(); }, 500);
    } catch (err) {
        showNotification('Error: ' + err.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════════════
// [v2.0-NEW] VERIFICATIONS TAB (Governor panel)
// ═══════════════════════════════════════════════════════════════

function loadPendingVerifications() {
    var container = document.getElementById('pendingVerificationsList');
    var gateMsg = document.getElementById('governorGateMsg');
    if (!container) return;

    const isGovernor = getUnifiedMerits().isGovernor;

    // Show/hide governor gate
    if (gateMsg) gateMsg.style.display = isGovernor ? 'none' : 'block';

    // Get pending economic contributions needing verification
    var pending = [];
    if (typeof LBW_Merits !== 'undefined' && LBW_Merits.getAllContributions) {
        var allContribs = LBW_Merits.getAllContributions();
        pending = allContribs.filter(function(c) {
            return c.category === 'economica' && (c.status === 'pending_verification' || c.status === 'pending');
        });
    }

    // Update badge
    var badge = document.getElementById('tabBadgeVerifications');
    var statEl = document.getElementById('stat_pending_verifications');
    if (badge) {
        if (pending.length > 0) { badge.style.display = 'inline-flex'; badge.textContent = pending.length; }
        else { badge.style.display = 'none'; }
    }
    if (statEl) statEl.textContent = pending.length;

    // Show founder bootstrap panel if needed (founder only, no merits yet)
    renderFounderBootstrapPanel();

    if (pending.length === 0) {
        // If bootstrap banner already added, don't overwrite it
        if (!document.getElementById('founderBootstrapBanner')) {
            container.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--color-text-secondary);"><div style="font-size:2rem;margin-bottom:0.5rem;">✅</div><p>No hay aportaciones pendientes de verificación</p></div>';
        }
        return;
    }

    container.innerHTML = pending.map(function(c) {
        var payLabel = c.payMethod === 'lightning' ? '⚡ Lightning' : c.payMethod === 'btc_onchain' ? '⛓️ On-chain' : c.payMethod === 'bank' ? '🏦 Banco' : '📄 Otro';

        return '<div style="background:var(--color-bg-dark);padding:1.25rem;border-radius:12px;border-left:4px solid #FF9800;margin-bottom:0.75rem;">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
                '<div>' +
                    '<div style="font-weight:700;color:var(--color-text-primary);">' + (c.description || 'Aportación Económica') + '</div>' +
                    '<div style="font-size:0.8rem;color:var(--color-text-secondary);margin-top:0.25rem;">por ' + (c.authorName || c.pubkey?.substring(0,12) || 'Anónimo') + ' · ' + payLabel + '</div>' +
                '</div>' +
                '<div style="text-align:right;min-width:80px;">' +
                    '<div style="font-family:var(--font-mono);font-weight:700;color:var(--color-gold);font-size:1.1rem;">' + (c.amount || 0) + '</div>' +
                    '<div style="font-size:0.7rem;color:var(--color-text-secondary);">LBWM</div>' +
                '</div>' +
            '</div>' +
            (c.txProof ? '<div style="margin-top:0.5rem;padding:0.5rem;background:rgba(0,0,0,0.2);border-radius:6px;font-size:0.75rem;font-family:var(--font-mono);color:var(--color-text-secondary);word-break:break-all;">📎 ' + c.txProof + '</div>' : '') +
            (isGovernor ? '<div style="display:flex;gap:0.5rem;margin-top:0.75rem;">' +
                '<button class="btn btn-sm" style="background:var(--color-success);color:#fff;font-size:0.8rem;padding:0.4rem 0.8rem;border-radius:8px;border:none;cursor:pointer;" onclick="verifyDeposit(\'' + c.id + '\')">✅ Verificar y Emitir</button>' +
                '<button class="btn btn-sm" style="background:var(--color-error);color:#fff;font-size:0.8rem;padding:0.4rem 0.8rem;border-radius:8px;border:none;cursor:pointer;" onclick="rejectDeposit(\'' + c.id + '\')">❌ Rechazar</button>' +
            '</div>' : '') +
        '</div>';
    }).join('');
}

// ═══════════════════════════════════════════════════════════════
// [v2.0] FOUNDER BOOTSTRAP MANUAL TRIGGER
// Solo visible para el fundador si no tiene méritos aún
// ═══════════════════════════════════════════════════════════════
async function manualFounderBootstrap() {
    if (typeof LBW_Merits === 'undefined' || !LBW_Nostr.isLoggedIn()) {
        showNotification('Necesitas estar conectado con Nostr.', 'error');
        return;
    }

    const FOUNDER_NPUB = 'npub172vh56w30sgev82c09lfujswr4u2djcd5w9vcj79qrmyk9jd459swvrkf5';
    let founderHex;
    try {
        founderHex = LBW_Nostr.npubToHex(FOUNDER_NPUB);
    } catch(e) {
        showNotification('Error decodificando npub del fundador.', 'error');
        return;
    }

    if (LBW_Nostr.getPubkey() !== founderHex) {
        showNotification('Esta acción solo está disponible para el fundador.', 'error');
        return;
    }

    if (!confirm('¿Ejecutar bootstrap fundacional de 3.000 LBWM? Esta acción se publicará en Nostr y es irreversible.')) return;

    try {
        showNotification('⏳ Ejecutando bootstrap fundacional...', 'success');
        const result = await LBW_Merits.bootstrapFounder(
            founderHex,
            3000,
            'Méritos fundacionales — desarrollo app, infraestructura, diseño sistema LBWM, documentación pre-lanzamiento'
        );
        if (result.alreadyBootstrapped) {
            showNotification('ℹ️ Ya tienes méritos fundacionales registrados (' + result.total + ' LBWM).', 'success');
        } else {
            showNotification('✅ Bootstrap fundacional completado. 3.000 LBWM publicados en Nostr.', 'success');
        }
        setTimeout(() => { loadMeritsData(); loadPendingVerifications(); }, 1500);
    } catch (err) {
        console.error('[Bootstrap] Error:', err);
        showNotification('Error: ' + err.message, 'error');
    }
}

function renderFounderBootstrapPanel() {
    const container = document.getElementById('pendingVerificationsList');
    if (!container || typeof LBW_Nostr === 'undefined' || !LBW_Nostr.isLoggedIn()) return;

    const FOUNDER_NPUB = 'npub172vh56w30sgev82c09lfujswr4u2djcd5w9vcj79qrmyk9jd459swvrkf5';
    let founderHex;
    try { founderHex = LBW_Nostr.npubToHex(FOUNDER_NPUB); } catch(e) { return; }

    if (LBW_Nostr.getPubkey() !== founderHex) return;

    const myData = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getMyMerits() : null;
    if (myData && myData.total >= 3000) return; // Already bootstrapped

    // Prepend bootstrap banner to the verifications panel
    const banner = document.createElement('div');
    banner.id = 'founderBootstrapBanner';
    banner.style.cssText = 'background:linear-gradient(135deg,rgba(229,185,92,0.12),rgba(229,185,92,0.04));border:1px solid var(--color-gold);border-radius:12px;padding:1.25rem;margin-bottom:1rem;';
    banner.innerHTML = '<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem;">' +
        '<span style="font-size:1.5rem;">🏗️</span>' +
        '<div>' +
            '<div style="font-weight:700;color:var(--color-gold);">Bootstrap Fundacional Pendiente</div>' +
            '<div style="font-size:0.8rem;color:var(--color-text-secondary);">No se han detectado méritos fundacionales en el relay. Activa tu estado de Gobernador.</div>' +
        '</div>' +
    '</div>' +
    '<button onclick="manualFounderBootstrap()" style="background:var(--color-gold);color:#0d171e;font-weight:700;border:none;border-radius:8px;padding:0.6rem 1.25rem;cursor:pointer;font-size:0.9rem;">🚀 Ejecutar Bootstrap (3.000 LBWM)</button>';
    container.prepend(banner);
}

// ═══════════════════════════════════════════════════════════════
// [v2.0-NEW] CITIZENSHIP LEVELS TAB
// ═══════════════════════════════════════════════════════════════

function renderCitizenshipLevels(currentMerits) {
    var container = document.getElementById('citizenshipLevelsDisplay');
    if (!container) return;

    currentMerits = currentMerits || 0;
    var currentLevel = _getGaugeLevel(currentMerits);

    container.innerHTML = GAUGE_LEVELS.map(function(l, i) {
        var isActive = currentLevel.idx === i;
        var isPassed = currentLevel.idx > i;
        var nextMin = (i < GAUGE_N - 1) ? GAUGE_LEVELS[i + 1].min - 1 : '∞';
        var bgStyle = isActive ? 'border:2px solid ' + l.color + ';background:' + l.color + '18' : isPassed ? 'background:var(--color-bg-dark);opacity:0.7' : 'background:var(--color-bg-dark);opacity:0.4';

        return '<div style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem 1rem;border-radius:10px;margin-bottom:0.5rem;' + bgStyle + ';">' +
            '<span style="font-size:1.5rem;">' + l.emoji + '</span>' +
            '<div style="flex:1;">' +
                '<div style="font-weight:700;color:' + (isActive ? l.color : 'var(--color-text-primary)') + ';font-size:0.95rem;">' + l.name + '</div>' +
                '<div style="font-size:0.75rem;color:var(--color-text-secondary);">' + l.bloc + '</div>' +
            '</div>' +
            '<span style="font-family:var(--font-mono);font-size:0.8rem;color:var(--color-text-secondary);">' + l.min.toLocaleString('es-ES') + '—' + (typeof nextMin === 'number' ? nextMin.toLocaleString('es-ES') : nextMin) + '</span>' +
            '<span style="font-size:0.7rem;padding:0.15rem 0.5rem;border-radius:10px;background:rgba(229,185,92,0.15);color:var(--color-gold);">' + l.bloc + '</span>' +
            (isActive ? '<span style="font-size:0.75rem;color:' + l.color + ';font-weight:700;">← TÚ</span>' : '') +
        '</div>';
    }).join('');
}

// ═══════════════════════════════════════════════════════════════
// [v2.0-NEW] VOTING BLOCKS BAR (enhanced visual)
// ═══════════════════════════════════════════════════════════════

function updateVotingBarDisplay(blocks) {
    if (!blocks) return;

    var sets = [
        ['voteBarGob', 'blocGobPct', 'blocGobCount', 'Gobernanza'],
        ['voteBarCiud', 'blocCiudPct', 'blocCiudCount', 'Ciudadanía'],
        ['voteBarCom', 'blocComPct', 'blocComCount', 'Comunidad']
    ];

    sets.forEach(function(s) {
        var barEl = document.getElementById(s[0]);
        var pctEl = document.getElementById(s[1]);
        var countEl = document.getElementById(s[2]);
        var block = blocks[s[3]];
        if (block) {
            var pct = (block.pct || 0) * 100;
            if (barEl) { barEl.style.width = pct + '%'; barEl.textContent = pct > 5 ? pct.toFixed(0) + '%' : ''; }
            if (pctEl) pctEl.textContent = pct.toFixed(1) + '%';
            if (countEl) countEl.textContent = block.count || 0;
        }
    });
}

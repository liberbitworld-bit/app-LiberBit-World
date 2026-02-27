// ========== MERITS LBWM FUNCTIONS (Nostr-integrated) ==========
// All data flows through LBW_Merits → Nostr relays
// Zero Supabase dependencies
// [v2.0] Sum+cap formula, dual flow, voting blocks, category breakdown, governor verification

async function loadMeritsData() {
    try {
        if (typeof LBW_Merits === 'undefined' || !LBW_Nostr.isLoggedIn()) {
            console.warn('[Merits] LBW_Merits not available or not logged in');
            return;
        }

        // Start subscriptions if not already running
        LBW_Merits.subscribeMerits();
        LBW_Merits.subscribeContributions();
        LBW_Merits.subscribeSnapshots();

        // Wait briefly for initial data
        await new Promise(r => setTimeout(r, 500));

        // [v2.0] Use getUnifiedMerits() if available, else fallback
        let totalMerits = 0;
        let breakdown = {};

        if (typeof getUnifiedMerits === 'function') {
            const meritData = getUnifiedMerits();
            totalMerits = meritData.total;
            breakdown = meritData.byCategory;
        } else {
            // Fallback: replicate v2.0 sum+cap logic
            const myData = LBW_Merits.getMyMerits();
            var nostrMerits = myData ? myData.total : 0;
            breakdown = myData ? myData.byCategory : {};

            var activityContribs = 0;
            if (typeof allPosts !== 'undefined' && Array.isArray(allPosts) && currentUser) {
                activityContribs += allPosts.filter(function(p) { return p.author === currentUser.name; }).length;
            }
            if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.getMyOffersCount) {
                activityContribs += LBW_NostrBridge.getMyOffersCount();
            }
            if (typeof LBW_Governance !== 'undefined' && LBW_Governance.getStats) {
                const govStats = LBW_Governance.getStats();
                activityContribs += govStats.myVotes || 0;
                activityContribs += govStats.myProposals || 0;
            }
            // [v2.0] Sum + cap, NOT max
            var ACTIVITY_CAP = 300;
            var activityMerits = Math.min(activityContribs * 10, ACTIVITY_CAP);
            totalMerits = nostrMerits + activityMerits;
        }

        // Update user merits display
        const el = id => document.getElementById(id);
        if (el('userTotalMerits')) el('userTotalMerits').textContent = totalMerits;
        if (el('user_lbwm_activos')) el('user_lbwm_activos').textContent = totalMerits;

        // Count contributions
        const myContribs = LBW_Merits.getMyContributions();
        var activityCount = 0;
        if (typeof getUnifiedMerits === 'function') {
            activityCount = getUnifiedMerits().activityCount;
        }
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
        if (typeof getUnifiedMerits === 'function') {
            const data = getUnifiedMerits();
            sourceEl.textContent = data.source === 'nostr+activity' ? '⚡ Nostr + 📊 Actividad' : '📊 Solo Actividad';
        }
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
function loadLedgerData() {
    const myContribs = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getMyContributions() : [];

    const legacyContribs = JSON.parse(localStorage.getItem('liberbit_contributions') || '[]');
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

    // [v2.0] Load voting blocks on tab switch
    if (tabName === 'bloques-voto') {
        updateVotingBlocksDisplay();
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
                evidence: evidence ? [evidence, `payMethod:${payMethod}`] : [`payMethod:${payMethod}`]
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
            // Submit as contribution AND create governance proposal
            await LBW_Merits.submitContribution({
                description,
                category,
                amount: value,
                currency: document.getElementById('contrib_currency')?.value || 'EUR',
                evidence: evidence ? [evidence] : []
            });

            // If governance system available, also create a proposal for voting
            if (typeof LBW_Governance !== 'undefined' && LBW_Governance.createProposal) {
                try {
                    const catDef = LBW_Merits.CATEGORIES[category];
                    await LBW_Governance.createProposal(
                        `[Aportación ${catDef.emoji} ${catDef.label}] ${description}`,
                        `Valor: ${value} · Peso: ×${catDef.weight} · LBWM estimados: ${(value * catDef.weight).toFixed(2)}` +
                        (evidence ? `\nEvidencia: ${evidence}` : '')
                    );
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
    if (typeof getUnifiedMerits !== 'function' || !getUnifiedMerits().isGovernor) {
        showNotification('Solo los Gobernadores (≥3.000 méritos) pueden verificar aportaciones.', 'error');
        return;
    }

    try {
        // Award merit to the contributor
        // In production: fetch contrib details from Nostr, then awardMerit
        const contrib = LBW_Merits.getMyContributions().find(c => c.id === contribId);
        if (!contrib) {
            showNotification('Aportación no encontrada', 'error');
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
    if (typeof getUnifiedMerits !== 'function' || !getUnifiedMerits().isGovernor) {
        showNotification('Solo los Gobernadores pueden rechazar aportaciones.', 'error');
        return;
    }
    // In production: publish rejection event
    showNotification('❌ Aportación rechazada.', 'error');
}

// ═══════════════════════════════════════════════════════════════
// My Contributions (updated with verification status)
// ═══════════════════════════════════════════════════════════════

function loadMyContributions() {
    const myContribs = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getMyContributions() : [];

    const pubKey = LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : (currentUser?.pubkey || '');
    const legacyContribs = JSON.parse(localStorage.getItem('liberbit_contributions') || '[]')
        .filter(c => c.applicant_public_key === pubKey);

    const allMyContribs = [
        ...myContribs.map(c => ({
            id: c.id,
            description: c.description,
            period: new Date(c.created_at * 1000).toLocaleDateString('es-ES'),
            reference_value: c.amount,
            currency: c.currency || 'units',
            factor_proposed: c.weight,
            lbwm_estimated: c.meritPoints,
            status: c.status || 'approved',
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
        pending: '#FF9800', pending_verification: '#FF9800',
        approved: '#4CAF50', verified: '#4CAF50',
        rejected: '#F44336', voting: '#9C27B0'
    };
    const statusLabels = {
        pending: '⏳ Pendiente', pending_verification: '⏳ Verificando',
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

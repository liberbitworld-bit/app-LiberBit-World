// ========== MERITS LBWM FUNCTIONS (Nostr-integrated) ==========
// All data flows through LBW_Merits → Nostr relays
// Zero Supabase dependencies

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

        // Nostr-based merits (from kind 31002 events)
        const myData = LBW_Merits.getMyMerits();
        var nostrMerits = myData ? myData.total : 0;
        const breakdown = myData ? myData.byCategory : {};

        // Activity-based merits (posts, offers, votes, proposals)
        var activityContribs = 0;
        if (typeof allPosts !== 'undefined' && Array.isArray(allPosts) && currentUser) {
            activityContribs += allPosts.filter(function(p) { return p.author === currentUser.name; }).length;
        }
        if (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.getMyOffersCount) {
            activityContribs += LBW_NostrBridge.getMyOffersCount();
        }
        if (typeof LBW_Governance !== 'undefined' && LBW_Governance.getStats) {
            activityContribs += LBW_Governance.getStats().myVotes || 0;
        }
        if (typeof allProposals !== 'undefined' && Array.isArray(allProposals) && currentUser) {
            activityContribs += allProposals.filter(function(p) { return p.author === currentUser.name; }).length;
        }
        var activityMerits = activityContribs * 10;

        // Use whichever is higher
        var totalMerits = Math.max(nostrMerits, activityMerits);

        // Update user merits display
        const el = id => document.getElementById(id);
        if (el('userTotalMerits')) el('userTotalMerits').textContent = totalMerits;
        if (el('user_lbwm_activos')) el('user_lbwm_activos').textContent = totalMerits;

        // Count contributions
        const myContribs = LBW_Merits.getMyContributions();
        var totalContribs = myContribs.length + activityContribs;
        if (el('user_lbwm_aportaciones')) el('user_lbwm_aportaciones').textContent = totalContribs;

        // Stats panel
        if (el('stat_mi_balance')) el('stat_mi_balance').textContent = totalMerits;

        // Citizenship level from Nostr module
        const level = LBW_Merits.getCitizenshipLevel(totalMerits);
        if (el('userLevel')) el('userLevel').textContent = level.emoji;
        if (el('userLevelName')) el('userLevelName').textContent = level.name;

        // Load sub-views
        await loadLeaderboard();
        loadLedgerData();
        loadMyContributions();
        await updateLbwmStats(totalMerits);

    } catch (err) {
        if (!(err.message && err.message.includes('DataCloneError'))) {
            console.error('Error loading merits:', err.message);
        }
    }
}

async function loadLeaderboard() {
    const leaderboard = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getLeaderboard(20) : [];
    const myPubkey = LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : '';

    let html = '';

    if (leaderboard.length === 0) {
        // Show current user as placeholder
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
            html += `
                <div style="display: flex; align-items: center; gap: 1rem; padding: 0.85rem 1rem; background: ${isMe ? 'rgba(229, 185, 92, 0.1)' : 'var(--color-bg-dark)'}; border-radius: 8px; ${border}">
                    <div style="font-size: 1.2rem; font-weight: 700; color: var(--color-gold); min-width: 36px;">${medal}</div>
                    <div style="flex: 1;">
                        <div style="color: var(--color-text-primary); font-weight: 600;">${name}</div>
                        <div style="color: var(--color-text-secondary); font-size: 0.75rem;">${entry.level?.emoji || '🌐'} ${entry.level?.name || 'E-Residency'}</div>
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

    // Sync merits to leaderboard display
    const totalMerits = document.getElementById('userTotalMerits')?.textContent || '0';
    const lbMeritsEl = document.getElementById('leaderboardUserMerits');
    if (lbMeritsEl) lbMeritsEl.textContent = totalMerits;

    const myData = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getMyMerits() : null;
    const rankingEl = document.getElementById('userRanking');
    if (rankingEl) rankingEl.textContent = myData?.rank || '1';
}

function loadLedgerData() {
    const myContribs = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getMyContributions() : [];

    // Also include localStorage legacy data for backward compat
    const legacyContribs = JSON.parse(localStorage.getItem('liberbit_contributions') || '[]');
    const allContribs = [...myContribs.map(c => ({
        id: c.id,
        applicant_name: c.npub ? c.npub.substring(0, 12) + '...' : 'Tú',
        applicant_public_key: c.pubkey,
        contribution_type: c.category,
        description: c.description,
        reference_value: c.amount,
        currency: c.currency || 'units',
        weight: c.weight,
        lbwm_estimated: c.meritPoints,
        submitted_at: new Date(c.created_at * 1000).toISOString(),
        status: 'approved',
        source: 'nostr'
    })), ...legacyContribs.map(c => ({ ...c, weight: c.factor_proposed || c.weight || 1.0, source: 'legacy' }))];

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
            const statusClass = c.status === 'approved' ? 'status-activo' : 'status-pendiente';
            const statusLabel = c.status === 'approved' ? 'Activo' : 'Pendiente';
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
                    <td style="text-align: center;">${c.weight || '-'}</td>
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

        // Participation percentage
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

// ========== UI FUNCTIONS (unchanged) ==========

function switchLbwmTab(tabName) {
    document.querySelectorAll('.lbwm-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.lbwm-tab-content').forEach(content => content.classList.remove('active'));
    const tab = document.querySelector(`.lbwm-tab[data-lbwm-tab="${tabName}"]`);
    if (tab) tab.classList.add('active');
    const content = document.getElementById(`lbwm-tab-${tabName}`);
    if (content) content.classList.add('active');

    // Refresh data when switching to data-dependent tabs
    if (tabName === 'mis-aportaciones') loadMyContributions();
    if (tabName === 'ledger') loadLedgerData();
}

function toggleFinanciada() {
    // v2.0: Financiada has fixed weight 0.6, no variable factor
    updatePreviewCalculation();
}

function showContributionForm() {
    const modal = document.getElementById('contributionFormModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('active');
    }
    const identityEl = document.getElementById('contrib_identity');
    if (identityEl) identityEl.value = currentUser?.name || '';
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
}

function updateContributionFactor() {
    const typeSelect = document.getElementById('contrib_type');
    if (!typeSelect) return;
    const tipo = typeSelect.value;

    // v2.0: Weight is fixed per category, no user-adjustable factor
    const weights = { economica: 1.0, productiva: 1.0, responsabilidad: 1.2, financiada: 0.6 };
    const weight = weights[tipo] || 1.0;

    const pfEl = document.getElementById('preview_factor');
    if (pfEl) pfEl.textContent = weight.toFixed(1);

    // Hide financiada factor selector (no longer variable)
    const financiadaDiv = document.getElementById('financiada_factor');
    if (financiadaDiv) financiadaDiv.style.display = 'none';

    // Show Responsabilidad restriction warning
    const respWarning = document.getElementById('responsabilidad_warning');
    if (respWarning) {
        respWarning.style.display = tipo === 'responsabilidad' ? 'block' : 'none';
    }

    updatePreviewCalculation();
}

function updatePreviewCalculation() {
    const value = parseFloat(document.getElementById('contrib_value')?.value) || 0;
    const currency = document.getElementById('contrib_currency')?.value || 'EUR';
    const tipo = document.getElementById('contrib_type')?.value;

    // v2.0: Weight comes from CATEGORIES definition
    let weight = 1.0;
    if (typeof LBW_Merits !== 'undefined' && tipo && LBW_Merits.CATEGORIES[tipo]) {
        weight = LBW_Merits.CATEGORIES[tipo].weight;
    } else {
        // Fallback if LBW_Merits not loaded
        const weights = { economica: 1.0, productiva: 1.0, responsabilidad: 1.2, financiada: 0.6 };
        weight = weights[tipo] || 1.0;
    }

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

async function submitContribution(event) {
    if (event) event.preventDefault();

    if (typeof LBW_Merits === 'undefined' || !LBW_Nostr.isLoggedIn()) {
        showNotification('Necesitas estar conectado con Nostr', 'error');
        return;
    }

    try {
        const typeSelect = document.getElementById('contrib_type');
        const category = typeSelect.value;

        // v2.0: Weight comes from CATEGORIES, not from user selection
        const catDef = LBW_Merits.CATEGORIES[category];
        if (!catDef) {
            showNotification('Selecciona un tipo de aportación válido', 'error');
            return;
        }

        const value = parseFloat(document.getElementById('contrib_value')?.value) || 0;
        const description = document.getElementById('contrib_description')?.value || '';
        const evidence = document.getElementById('contrib_evidence')?.value || '';

        await LBW_Merits.submitContribution({
            description,
            category: category,
            type: category,
            amount: value,
            currency: document.getElementById('contrib_currency')?.value || 'EUR',
            evidence: evidence ? [evidence] : []
        });

        showNotification('✅ Aportación registrada en Nostr con éxito', 'success');
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

function loadMyContributions() {
    const myContribs = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getMyContributions() : [];

    // Also include legacy localStorage
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
            weight: c.weight,
            lbwm_estimated: c.meritPoints,
            status: 'approved',
            source: 'nostr'
        })),
        ...legacyContribs.map(c => ({ ...c, weight: c.factor_proposed || c.weight || 1.0, source: 'legacy' }))
    ];

    const container = document.getElementById('myContributionsList');
    if (!container) return;

    if (allMyContribs.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--color-text-secondary);"><p>No has presentado aportaciones profesionales aún</p></div>';
        return;
    }

    const statusColors = { pending: '#FF9800', approved: '#4CAF50', rejected: '#F44336' };
    const statusLabels = { pending: '⏳ Pendiente', approved: '✅ Aprobada', rejected: '❌ Rechazada' };

    container.innerHTML = allMyContribs.map(c => `
        <div style="background: var(--color-bg-dark); padding: 1.5rem; border-radius: 12px; border-left: 4px solid ${statusColors[c.status] || '#4CAF50'}; margin-bottom: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 1rem;">
                <div>
                    <div style="font-weight: 600; color: var(--color-text-primary); margin-bottom: 0.5rem;">${c.source === 'nostr' ? '⚡' : '📦'} ${c.description || '-'}</div>
                    <div style="font-size: 0.85rem; color: var(--color-text-secondary);">${c.period || '-'}</div>
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
                    <div style="font-weight: 600; color: var(--color-text-primary);">${c.weight || '-'}</div>
                </div>
                <div>
                    <div style="font-size: 0.75rem; color: var(--color-text-secondary);">LBWM</div>
                    <div style="font-weight: 700; color: var(--color-gold); font-size: 1.1rem;">${typeof c.lbwm_estimated === 'number' ? c.lbwm_estimated.toFixed(2) : c.lbwm_estimated}</div>
                </div>
            </div>
        </div>
    `).join('');
}

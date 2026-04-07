// ========== GOVERNANCE FUNCTIONS (Nostr-integrated) v2.0 ==========
// Full lifecycle: create → vote → result → execution → verified
// All data flows through LBW_Governance → Nostr relays

const PROPOSAL_TYPE_LABELS = {
    'referendum': '📋 Referéndum',
    'budget':     '💰 Presupuesto',
    'election':   '👥 Elección'
};

// Status display config
const STATUS_CONFIG = {
    active:       { label: '✅ Activa',          class: 'active',       badge: '🟢' },
    expired:      { label: '⏰ Calculando...',    class: 'expired',      badge: '⏳' },
    approved:     { label: '✅ Aprobada',         class: 'approved',     badge: '✅' },
    rejected:     { label: '❌ Rechazada',        class: 'rejected',     badge: '❌' },
    quorum_failed:{ label: '⚠️ Sin quórum',       class: 'quorum-failed',badge: '⚠️' },
    in_execution: { label: '🔧 En ejecución',     class: 'in-execution', badge: '🔧' },
    executed:     { label: '🏆 Ejecutada',        class: 'executed',     badge: '🏆' },
    closed:       { label: '🔒 Cerrada',          class: 'closed',       badge: '🔒' },
};

function showNewProposalForm() {
    document.getElementById('newProposalForm').style.display = 'block';
    document.getElementById('newProposalForm').scrollIntoView({ behavior: 'smooth' });
    updateProposalFormFields();
}

function cancelProposalForm() {
    document.getElementById('newProposalForm').style.display = 'none';
    document.getElementById('proposalTitle').value = '';
    document.getElementById('proposalDescription').value = '';
    const ba = document.getElementById('budgetAmount');
    if (ba) ba.value = '';
    const ec = document.getElementById('electionCandidates');
    if (ec) ec.value = '';
}

function updateProposalFormFields() {
    const type = document.getElementById('proposalType').value;
    document.getElementById('budgetFields').style.display = type === 'budget' ? 'block' : 'none';
    document.getElementById('electionFields').style.display = type === 'election' ? 'block' : 'none';
}

async function submitProposal() {
    if (typeof LBW_Governance === 'undefined' || !LBW_Nostr.isLoggedIn()) {
        showNotification('Necesitas estar conectado con Nostr', 'error');
        return;
    }

    const category = document.getElementById('proposalType').value;
    const title = document.getElementById('proposalTitle').value.trim();
    const description = document.getElementById('proposalDescription').value.trim();
    const durationDays = parseInt(document.getElementById('proposalDuration').value);

    if (!title || !description) {
        showNotification('Complete título y descripción', 'error');
        return;
    }

    const data = { title, description, category, durationSecs: durationDays * 86400 };

    if (category === 'budget') {
        const ba = document.getElementById('budgetAmount');
        if (ba) data.budget = { amount: parseInt(ba.value) || 0, currency: 'sats' };
    } else if (category === 'election') {
        const ec = document.getElementById('electionCandidates');
        if (ec) {
            const candidates = ec.value.split('\n').map(c => c.trim()).filter(c => c.length > 0);
            if (candidates.length < 2) { showNotification('Necesitas al menos 2 candidatos', 'error'); return; }
            data.candidates = candidates;
        }
    }

    try {
        await LBW_Governance.publishProposal(data);
        cancelProposalForm();
        showNotification('¡Propuesta creada y publicada en Nostr! 🗳️', 'success');
        setTimeout(displayProposals, 500);
    } catch (err) {
        console.error('Error creating proposal:', err);
        showNotification('Error: ' + err.message, 'error');
    }
}

async function loadProposals() {
    try {
        if (typeof LBW_Governance !== 'undefined') {
            if (typeof LBW_Governance.reloadMyVotes === 'function') {
                LBW_Governance.reloadMyVotes();
            }
            LBW_Governance.subscribeProposals((proposal, action) => {
                updateGovStats();
                displayProposals();
            });
        }

        allProposals = (typeof LBW_Governance !== 'undefined')
            ? LBW_Governance.getAllProposals().map(_nostrProposalToLegacy)
            : [];

        allVotes = [];
        updateGovStats();
        displayProposals();

        setTimeout(() => { updateGovStats(); displayProposals(); }, 3000);
    } catch (err) {
        console.error('Error loading proposals:', err);
        allProposals = [];
        updateGovStats();
        displayProposals();
    }
}

// Convert Nostr proposal to legacy UI format
function _nostrProposalToLegacy(p) {
    return {
        id: p.id,
        dTag: p.dTag,
        author_id: p.pubkey,
        author_name: p.npub ? p.npub.substring(0, 12) + '...' : 'Anónimo',
        proposal_type: p.category,
        title: p.title,
        description: p.description,
        status: p.status,
        ends_at: p.expiresAt ? new Date(p.expiresAt * 1000).toISOString() : null,
        created_at: new Date(p.createdAt * 1000).toISOString(),
        budget_amount: p.budget?.amount || null,
        candidates: p.candidates || [],
        options: p.options || [],
        proposalNumber: p.proposalNumber || 0,
        _nostrOriginal: p
    };
}

function updateGovStats() {
    if (typeof LBW_Governance === 'undefined') return;
    const stats = LBW_Governance.getStats();
    const el = id => document.getElementById(id);
    if (el('activeProposalsCount'))   el('activeProposalsCount').textContent   = stats.active;
    if (el('totalProposalsCount'))    el('totalProposalsCount').textContent    = stats.total;
    if (el('myVotesCount'))           el('myVotesCount').textContent           = stats.myVotes;
    if (el('approvedProposalsCount')) el('approvedProposalsCount').textContent = stats.approved || 0;
    if (el('executedProposalsCount')) el('executedProposalsCount').textContent = stats.executed || 0;
}

function displayProposals() {
    const container = document.getElementById('proposalsList');
    if (!container) return;

    if (typeof LBW_Governance !== 'undefined') {
        allProposals = LBW_Governance.getAllProposals().map(_nostrProposalToLegacy);
    }

    let proposalsToShow = allProposals;
    if (currentProposalFilter !== 'all') {
        if (currentProposalFilter === 'pending') {
            proposalsToShow = [];
        } else {
            proposalsToShow = allProposals.filter(p => {
                if (currentProposalFilter === 'active')   return p.status === 'active';
                if (currentProposalFilter === 'approved') return ['approved', 'in_execution', 'executed'].includes(p.status);
                if (currentProposalFilter === 'closed')   return !['active'].includes(p.status);
                return true;
            });
        }
    }

    if (proposalsToShow.length === 0) {
        container.innerHTML = `
            <div class="placeholder">
                <h3>🗳️ No hay propuestas ${currentProposalFilter === 'all' ? '' : 'en este estado'}</h3>
                <p>${currentProposalFilter === 'all' ? 'Crea la primera propuesta' : 'Prueba con otro filtro'}</p>
            </div>
        `;
        return;
    }

    container.innerHTML = proposalsToShow.map(proposal => {
        const nostrP = proposal._nostrOriginal;
        const myVote = nostrP ? LBW_Governance.getMyVote(nostrP.dTag) : null;
        const votes  = nostrP ? LBW_Governance.getVotesForProposal(nostrP.dTag) : [];
        const result = nostrP ? LBW_Governance.getResult(nostrP.dTag) : null;
        const timeLeft = proposal.ends_at ? getTimeLeft(new Date(proposal.ends_at).getTime()) : '';
        const statusConf = STATUS_CONFIG[proposal.status] || STATUS_CONFIG.closed;

        const prpLabel = proposal.proposalNumber > 0
            ? LBW_Governance.formatProposalNumber(proposal.proposalNumber)
            : '';

        return `
            <div class="proposal-card ${statusConf.class}" onclick="showProposalDetail('${proposal.dTag || proposal.id}')">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem;flex-wrap:wrap;">
                    <div class="proposal-type-badge">${PROPOSAL_TYPE_LABELS[proposal.proposal_type] || proposal.proposal_type}</div>
                    ${prpLabel ? `<div style="font-size:0.75rem;font-weight:700;color:var(--color-gold);opacity:0.85;letter-spacing:0.05em;font-family:monospace;">${prpLabel}</div>` : ''}
                </div>
                <div class="proposal-status ${statusConf.class}">${statusConf.label}</div>
                <div class="proposal-title">${escapeHtml(proposal.title)}</div>
                <div class="proposal-description">${escapeHtml(proposal.description)}</div>

                ${result ? _renderResultBadge(result, proposal) : ''}

                ${proposal.status === 'active' ? `
                    <div class="vote-progress">
                        <div class="vote-stats">
                            <span>${votes.length} votos</span>
                            <span>${timeLeft}</span>
                        </div>
                        ${myVote ? '<div style="margin-top:0.5rem;color:var(--color-accent-green);font-size:0.85rem;">✓ Ya has votado</div>' : ''}
                    </div>
                ` : ''}

                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.5rem; flex-wrap:wrap; gap:0.4rem;">
                    <div class="proposal-meta" style="margin-top:0;">
                        <span>Por ${escapeHtml(proposal.author_name)}</span>
                        <span>${new Date(proposal.created_at).toLocaleDateString('es-ES')}</span>
                    </div>
                    <button
                        class="debate-open-btn"
                        data-dtag="${escapeHtml(proposal.dTag || proposal.id)}"
                        data-title="${escapeHtml(proposal.title)}"
                        onclick="event.stopPropagation(); openProposalDebate(this.dataset.dtag, this.dataset.title)"
                        style="display:flex; align-items:center; gap:0.3rem; font-size:0.75rem; font-weight:600; padding:0.25rem 0.65rem; border-radius:20px; background:rgba(229,185,92,0.1); color:var(--color-gold); border:1px solid rgba(229,185,92,0.3); cursor:pointer; transition:all 0.2s; position:relative; z-index:2;"
                        onmouseover="this.style.background='rgba(229,185,92,0.25)'"
                        onmouseout="this.style.background='rgba(229,185,92,0.1)'"
                        title="Abrir debate de esta propuesta">
                        💬 Debate
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function _renderResultBadge(result, proposal) {
    if (!result) return '';
    const winner = result.winner ? `Ganador: <strong>"${escapeHtml(result.winner)}"</strong>` : '';
    const bgColor = result.approved ? 'rgba(82,196,26,0.12)' :
                    result.quorum_met === false ? 'rgba(250,173,20,0.12)' : 'rgba(255,77,79,0.12)';
    const borderColor = result.approved ? '#52c41a' :
                        result.quorum_met === false ? '#faad14' : '#ff4d4f';
    const icon = result.approved ? '✅' : result.quorum_met === false ? '⚠️' : '❌';

    if (result.quorum_met === false) {
        const dTagId = proposal.dTag || proposal.id;
        const recalcBtn = (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.isLoggedIn())
            ? `<br><button onclick="event.stopPropagation();recalculateGovResult('${dTagId}')"
                  style="margin-top:0.4rem;background:#faad14;color:#000;border:none;border-radius:6px;padding:0.25rem 0.7rem;font-size:0.78rem;cursor:pointer;font-weight:700;">
                  🔄 Recalcular — voté como Génesis
              </button>`
            : '';
        return `<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:8px;padding:0.5rem 0.75rem;margin-top:0.5rem;font-size:0.82rem;">
            ${icon} Sin quórum — ningún Génesis participó
            ${recalcBtn}
        </div>`;
    }
    return `<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:8px;padding:0.5rem 0.75rem;margin-top:0.5rem;font-size:0.82rem;">
        ${icon} ${winner} · ${result.total_votes} votos
    </div>`;
}

async function recalculateGovResult(dTag) {
    if (typeof LBW_Governance === 'undefined') return;
    showNotification('🔄 Recalculando resultado... espera ~15 segundos', 'info');
    try {
        await LBW_Governance.recalculateResult(dTag);
        showNotification('✅ Resultado recalculado correctamente', 'success');
    } catch (err) {
        showNotification('Error al recalcular: ' + err.message, 'error');
        console.error('[Governance] recalculate error:', err);
    }
    setTimeout(() => { updateGovStats(); displayProposals(); }, 1000);
}

function filterProposals(filter) {
    currentProposalFilter = filter;
    document.querySelectorAll('[data-filter-prop]').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.querySelector(`[data-filter-prop="${filter}"]`);
    if (activeBtn) activeBtn.classList.add('active');
    displayProposals();
}

async function showProposalDetail(proposalIdentifier) {
    const proposal = allProposals.find(p => p.dTag === proposalIdentifier || p.id === proposalIdentifier);
    if (!proposal) { console.warn('[Governance] Propuesta no encontrada:', proposalIdentifier); return; }

    const nostrP = proposal._nostrOriginal;
    const pubKey = LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : '';
    const isAuthor = pubKey === proposal.author_id;
    const isGovernor = typeof LBW_Merits !== 'undefined' && LBW_Merits.isGovernor();

    if (nostrP) {
        LBW_Governance.subscribeVotes(nostrP.id, nostrP.dTag, () => {
            updateVoteResultsInModal(nostrP.dTag);
        });
    }

    await new Promise(r => setTimeout(r, 300));

    const proposalVotes = nostrP ? LBW_Governance.getVotesForProposal(nostrP.dTag) : [];
    const myVote = nostrP ? LBW_Governance.getMyVote(nostrP.dTag) : null;
    const hasVoted = !!myVote;
    const canVote = proposal.status === 'active' && !hasVoted;
    const result = nostrP ? LBW_Governance.getResult(nostrP.dTag) : null;
    const execution = nostrP ? LBW_Governance.getExecution(nostrP.dTag) : null;
    const statusConf = STATUS_CONFIG[proposal.status] || STATUS_CONFIG.closed;

    const voteResults = {};
    proposalVotes.forEach(v => { voteResults[v.option] = (voteResults[v.option] || 0) + 1; });

    // Fetch author profile in background
    let authorName = proposal.author_name;
    if (nostrP && typeof LBW_Nostr.fetchUserProfile === 'function') {
        LBW_Nostr.fetchUserProfile(nostrP.pubkey).then(p => {
            if (p?.name) {
                const el = document.getElementById('proposal-author-name');
                if (el) el.textContent = p.name;
            }
        }).catch(() => {});
    }

    document.querySelectorAll('.modal.active').forEach(m => { if (!m.id) m.remove(); });

    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.innerHTML = `
        <div class="modal-content" style="position:relative;max-width:700px;">
            <button class="modal-close" onclick="this.closest('.modal').remove()">×</button>

            <div class="modal-header" style="background:linear-gradient(135deg,var(--color-teal),var(--color-teal-dark));padding:2rem;">
                <div class="proposal-status ${statusConf.class}" style="margin-bottom:1rem;">${statusConf.label}</div>
                <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem;flex-wrap:wrap;">
                    <div style="font-size:0.9rem;color:var(--color-gold);">${PROPOSAL_TYPE_LABELS[proposal.proposal_type] || proposal.proposal_type}</div>
                    ${proposal.proposalNumber > 0 ? `<div style="font-size:0.8rem;font-weight:700;color:var(--color-gold);opacity:0.9;font-family:monospace;background:rgba(229,185,92,0.15);padding:0.15rem 0.5rem;border-radius:4px;border:1px solid rgba(229,185,92,0.3);">${LBW_Governance.formatProposalNumber(proposal.proposalNumber)}</div>` : ''}
                </div>
                <h2 style="color:white;margin:0;">${escapeHtml(proposal.title)}</h2>
            </div>

            <div class="modal-body">
                <p style="color:var(--color-text-secondary);line-height:1.7;margin-bottom:1.5rem;">${escapeHtml(proposal.description)}</p>

                ${proposal.budget_amount ? `
                    <div style="background:var(--color-bg-dark);padding:1.25rem;border-radius:12px;margin-bottom:1.5rem;border:2px solid var(--color-gold);">
                        <div style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem;">Monto Solicitado</div>
                        <div style="font-size:1.8rem;font-weight:700;color:var(--color-gold);">${proposal.budget_amount.toLocaleString()} sats</div>
                    </div>
                ` : ''}

                <div style="background:var(--color-bg-dark);padding:1.25rem;border-radius:12px;margin-bottom:1.5rem;">
                    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;font-size:0.9rem;">
                        <div><div style="color:var(--color-text-secondary);margin-bottom:0.25rem;">Propuesta por</div><div id="proposal-author-name" style="font-weight:600;">${escapeHtml(authorName)}</div></div>
                        <div><div style="color:var(--color-text-secondary);margin-bottom:0.25rem;">Creación</div><div style="font-weight:600;">${new Date(proposal.created_at).toLocaleDateString('es-ES')}</div></div>
                        <div><div style="color:var(--color-text-secondary);margin-bottom:0.25rem;">Votos</div><div id="modalVoteCount" style="font-weight:600;color:var(--color-gold);">${proposalVotes.length}</div></div>
                        <div><div style="color:var(--color-text-secondary);margin-bottom:0.25rem;">${proposal.status === 'active' ? 'Tiempo restante' : 'Estado final'}</div>
                        <div style="font-weight:600;">${proposal.status === 'active' && proposal.ends_at ? getTimeLeft(new Date(proposal.ends_at).getTime()) : statusConf.label}</div></div>
                        ${proposal.proposalNumber > 0 ? `<div><div style="color:var(--color-text-secondary);margin-bottom:0.25rem;">Identificador</div><div style="font-weight:700;color:var(--color-gold);font-family:monospace;">${LBW_Governance.formatProposalNumber(proposal.proposalNumber)}</div></div>` : ''}
                    </div>
                </div>

                ${/* RESULT SECTION */ result ? _renderResultSection(result, proposal) : proposal.status === 'expired' ? `
                    <div style="background:rgba(250,173,20,0.1);border:1px solid #faad14;border-radius:12px;padding:1.25rem;margin-bottom:1.5rem;text-align:center;">
                        <div style="font-size:1.2rem;margin-bottom:0.5rem;">⏳</div>
                        <div style="color:#faad14;font-weight:600;">Calculando resultado...</div>
                        <div style="color:var(--color-text-secondary);font-size:0.85rem;margin-top:0.25rem;">El sistema está procesando los votos ponderados</div>
                    </div>
                ` : ''}

                <div id="voteSectionContainer">
                ${canVote ? `
                    <div style="background:var(--color-bg-dark);padding:1.5rem;border-radius:12px;border:2px solid var(--color-gold);">
                        <h3 style="color:var(--color-gold);margin-bottom:1rem;">Tu Voto</h3>
                        <div id="voteOptions">${getVoteOptions(proposal)}</div>
                        <button class="btn btn-primary" onclick="submitVote('${proposal.dTag}')" style="width:100%;margin-top:1rem;">🗳️ Emitir Voto</button>
                    </div>
                ` : hasVoted ? `
                    <div style="background:rgba(82,196,26,0.1);padding:1.25rem;border-radius:12px;border:1px solid #52c41a;text-align:center;">
                        <p style="color:#52c41a;font-weight:600;">✓ Ya has votado: "${myVote.option}"</p>
                    </div>
                ` : ''}
                </div>

                <div id="voteResultsContainer" style="margin-top:1.5rem;">
                ${proposalVotes.length > 0 ? (() => {
                    const isClosed = proposal.status !== 'active';
                    const hasWeighted = result && result.weighted_votes && Object.keys(result.weighted_votes).length > 0;
                    if (isClosed && hasWeighted) {
                        // Propuesta cerrada: mostrar resultados ponderados por méritos (el verdadero resultado)
                        return `
                            <h3 style="color:var(--color-gold);margin-bottom:0.5rem;">Resultados Finales</h3>
                            <div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:1rem;">Ponderados por méritos LBWM · ${proposalVotes.length} voto${proposalVotes.length !== 1 ? 's' : ''} emitido${proposalVotes.length !== 1 ? 's' : ''}</div>
                            ${displayWeightedVoteResults(result.weighted_votes)}
                        `;
                    } else {
                        // Propuesta activa: mostrar conteo bruto como resultados parciales
                        return `
                            <h3 style="color:var(--color-gold);margin-bottom:0.5rem;">Resultados Parciales</h3>
                            <div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:1rem;">Conteo provisional (sin ponderar) · ${proposalVotes.length} voto${proposalVotes.length !== 1 ? 's' : ''} emitido${proposalVotes.length !== 1 ? 's' : ''}</div>
                            ${displayVoteResults(proposalVotes, voteResults)}
                        `;
                    }
                })() : '<p style="color:var(--color-text-secondary);text-align:center;">Aún no hay votos</p>'}
                </div>

                ${/* EXECUTION SECTION */ _renderExecutionSection(proposal, execution, isAuthor, isGovernor)}

                ${/* MERIT INFO */ _renderMeritInfo(proposal, result, myVote, isAuthor)}
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// ── Render Result Section ──────────────────────────────────
function _renderResultSection(result, proposal) {
    const approved = result.approved;
    const quorumFailed = result.quorum_met === false;

    const bg = approved ? 'rgba(82,196,26,0.1)' : quorumFailed ? 'rgba(250,173,20,0.1)' : 'rgba(255,77,79,0.1)';
    const border = approved ? '#52c41a' : quorumFailed ? '#faad14' : '#ff4d4f';
    const icon = approved ? '✅' : quorumFailed ? '⚠️' : '❌';
    const label = approved ? 'APROBADA' : quorumFailed ? 'SIN QUÓRUM' : 'RECHAZADA';
    const detail = quorumFailed
        ? 'No hubo participación de Gobernadores. La propuesta no puede aprobarse sin quórum de Gobernanza.'
        : approved
            ? `La opción <strong>"${escapeHtml(result.winner)}"</strong> ganó con ${result.total_votes} votos ponderados.`
            : `La opción <strong>"${escapeHtml(result.winner)}"</strong> fue la más votada (propuesta rechazada).`;

    // Recalculate button: only shown when quorum failed AND current user has voted as governor
    let recalcSection = '';
    if (quorumFailed) {
        const dTagId = proposal.dTag || proposal.id;
        const myVote = typeof LBW_Governance !== 'undefined' ? LBW_Governance.getMyVote(dTagId) : null;
        const isGov = typeof LBW_Merits !== 'undefined' && LBW_Merits.isGovernor();
        if (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.isLoggedIn()) {
            recalcSection = `
                <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid rgba(250,173,20,0.3);">
                    <div style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.5rem;">
                        ⚠️ Detectado: votaste como Génesis pero el resultado no lo registró.<br>
                        Esto ocurre por un desfase de sincronización de méritos. Puedes recalcular:
                    </div>
                    <button onclick="recalculateGovResult('${dTagId}')"
                        style="background:#faad14;color:#000;border:none;border-radius:8px;padding:0.6rem 1.2rem;font-weight:700;cursor:pointer;font-size:0.9rem;">
                        🔄 Recalcular Resultado
                    </button>
                </div>`;
        }
    }

    const weightedBreakdown = result.weighted_votes && Object.keys(result.weighted_votes).length > 0
        ? `<div style="margin-top:1rem;">
            <div style="font-size:0.8rem;color:var(--color-text-secondary);margin-bottom:0.5rem;">Votación ponderada por méritos:</div>
            ${Object.entries(result.weighted_votes)
                .sort((a, b) => b[1] - a[1])
                .map(([opt, weight]) => {
                    const total = Object.values(result.weighted_votes).reduce((s, v) => s + v, 0);
                    const pct = total > 0 ? ((weight / total) * 100).toFixed(1) : '0.0';
                    return `<div style="margin-bottom:0.5rem;">
                        <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:0.25rem;">
                            <span>${escapeHtml(opt)}</span>
                            <span style="color:var(--color-gold);">${pct}%</span>
                        </div>
                        <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;">
                            <div style="height:100%;width:${pct}%;background:var(--color-gold);border-radius:2px;"></div>
                        </div>
                    </div>`;
                }).join('')}
          </div>`
        : '';

    return `
        <div style="background:${bg};border:2px solid ${border};border-radius:12px;padding:1.5rem;margin-bottom:1.5rem;">
            <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem;">
                <span style="font-size:1.5rem;">${icon}</span>
                <span style="font-size:1.1rem;font-weight:700;color:${border};">${label}</span>
            </div>
            <div style="color:var(--color-text-secondary);font-size:0.9rem;">${detail}</div>
            ${weightedBreakdown}
            ${recalcSection}
        </div>
    `;
}

// ── Render Execution Section ───────────────────────────────
function _renderExecutionSection(proposal, execution, isAuthor, isGovernor) {
    let html = '';

    // Author can report execution if proposal is approved
    if (proposal.status === 'approved' && isAuthor && !execution) {
        html += `
            <div style="background:var(--color-bg-dark);padding:1.5rem;border-radius:12px;border:2px solid var(--color-gold);margin-top:1.5rem;" id="executionReportSection">
                <h3 style="color:var(--color-gold);margin-bottom:1rem;">📋 Reportar Ejecución</h3>
                <p style="color:var(--color-text-secondary);font-size:0.9rem;margin-bottom:1rem;">
                    Tu propuesta fue aprobada. Una vez implementada, reporta la ejecución para que los Génesis puedan verificarla.
                </p>
                <textarea id="executionDescription" placeholder="Describe cómo se implementó la propuesta, qué se logró..." 
                    style="width:100%;min-height:100px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:0.75rem;color:white;font-size:0.9rem;resize:vertical;"></textarea>
                <input type="text" id="executionLinks" placeholder="Links de evidencia (opcional, separados por coma)" 
                    style="width:100%;margin-top:0.75rem;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:0.75rem;color:white;font-size:0.9rem;">
                <button class="btn btn-primary" onclick="submitExecutionReport('${proposal.dTag}')" style="width:100%;margin-top:1rem;">
                    📤 Publicar Reporte de Ejecución
                </button>
            </div>
        `;
    }

    // Show existing execution report
    if (execution) {
        html += `
            <div style="background:rgba(82,196,26,0.08);border:1px solid rgba(82,196,26,0.3);border-radius:12px;padding:1.25rem;margin-top:1.5rem;">
                <div style="font-weight:600;color:#52c41a;margin-bottom:0.5rem;">🔧 Reporte de Ejecución</div>
                <p style="color:var(--color-text-secondary);font-size:0.9rem;line-height:1.6;">${escapeHtml(execution.description)}</p>
                ${execution.links?.length > 0 ? `
                    <div style="margin-top:0.75rem;">
                        ${execution.links.map(l => `<a href="${escapeHtml(l)}" target="_blank" style="color:var(--color-gold);font-size:0.85rem;display:block;">${escapeHtml(l)}</a>`).join('')}
                    </div>
                ` : ''}
                <div style="font-size:0.8rem;color:var(--color-text-secondary);margin-top:0.5rem;">
                    Reportado el ${new Date(execution.created_at * 1000).toLocaleDateString('es-ES')}
                </div>
            </div>
        `;

        // Governor can verify if not yet executed and not the author
        if (proposal.status === 'in_execution' && isGovernor && proposal.author_id !== LBW_Nostr.getPubkey()) {
            html += `
                <div style="margin-top:1rem;">
                    <button class="btn btn-primary" onclick="submitExecVerification('${proposal.dTag}')" style="width:100%;background:linear-gradient(135deg,#9C27B0,#7B1FA2);">
                        👑 Verificar Ejecución (+50 méritos al autor)
                    </button>
                </div>
            `;
        }
    }

    // Executed state
    if (proposal.status === 'executed') {
        html += `
            <div style="background:rgba(156,39,176,0.1);border:1px solid rgba(156,39,176,0.4);border-radius:12px;padding:1.25rem;margin-top:1.5rem;text-align:center;">
                <div style="font-size:1.5rem;margin-bottom:0.5rem;">🏆</div>
                <div style="font-weight:700;color:#CE93D8;">Ejecución Verificada</div>
                <div style="color:var(--color-text-secondary);font-size:0.85rem;margin-top:0.25rem;">Un Génesis ha confirmado la correcta implementación de esta propuesta</div>
            </div>
        `;
    }

    return html;
}

// ── Render Merit Info ──────────────────────────────────────
function _renderMeritInfo(proposal, result, myVote, isAuthor) {
    if (!result) return '';

    const lines = [];
    const mc = LBW_Governance.MERIT_CONFIG;

    if (myVote) {
        // Determine what merits they'd get/got
        let meritLabel = `+${mc.VOTE_COMMUNITY.amount} Productiva`;
        if (typeof LBW_Merits !== 'undefined') {
            const pubkey = LBW_Nostr.getPubkey();
            const userData = LBW_Merits.getUserMerits(pubkey);
            const bloc = userData?.level?.bloc || 'Comunidad';
            if (bloc === 'Ciudadanía' || bloc === 'Gobernanza') {
                meritLabel = `+${mc.VOTE_SENIOR.amount} Responsabilidad (1.2×)`;
            }
        }
        lines.push(`🗳️ Méritos por votar: ${meritLabel}`);
    }

    if (isAuthor && result.quorum_met !== false) {
        const authorMerit = result.approved ? mc.AUTHOR_APPROVED : mc.AUTHOR_REJECTED;
        lines.push(`✍️ Méritos como autor: +${authorMerit.amount} Productiva (${result.approved ? 'aprobada' : 'rechazada'})`);
    }

    if (isAuthor && ['approved', 'in_execution'].includes(proposal.status)) {
        lines.push(`🏆 Méritos por ejecución verificada: +${mc.EXEC_VERIFIED.amount} Productiva (pendiente verificación de Génesis)`);
    }

    if (lines.length === 0) return '';

    return `
        <div style="background:rgba(255,193,7,0.08);border:1px solid rgba(255,193,7,0.25);border-radius:12px;padding:1.25rem;margin-top:1.5rem;">
            <div style="font-size:0.8rem;color:var(--color-gold);font-weight:600;margin-bottom:0.75rem;letter-spacing:0.05em;">MÉRITOS LBWM</div>
            ${lines.map(l => `<div style="color:var(--color-text-secondary);font-size:0.88rem;margin-bottom:0.4rem;">${l}</div>`).join('')}
            <div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.5rem;opacity:0.7;">Los méritos requieren verificación de un Génesis para acreditarse.</div>
        </div>
    `;
}

// ── Vote Options ───────────────────────────────────────────
function getVoteOptions(proposal) {
    const options = proposal.options || proposal._nostrOriginal?.options || [];
    if (options.length > 0) {
        return options.map(opt => `<button class="vote-option-btn" onclick="selectVoteOption(this, '${escapeHtml(opt)}')">${escapeHtml(opt)}</button>`).join('');
    }
    if (proposal.proposal_type === 'election') {
        return (proposal.candidates || []).map(c => `<button class="vote-option-btn" onclick="selectVoteOption(this, '${escapeHtml(c)}')" style="display:block;width:100%;">${escapeHtml(c)}</button>`).join('');
    }
    return `
        <button class="vote-option-btn" onclick="selectVoteOption(this, 'A favor')">✅ A favor</button>
        <button class="vote-option-btn" onclick="selectVoteOption(this, 'En contra')">❌ En contra</button>
        <button class="vote-option-btn" onclick="selectVoteOption(this, 'Abstención')">⚪ Abstención</button>
    `;
}

function selectVoteOption(btn, option) {
    document.querySelectorAll('.vote-option-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    btn.setAttribute('data-selected', option);
}

async function submitVote(proposalDTag) {
    const selectedBtn = document.querySelector('.vote-option-btn.selected');
    if (!selectedBtn) { showNotification('Selecciona una opción', 'error'); return; }

    const option = selectedBtn.getAttribute('data-selected');
    const proposal = allProposals.find(p => p.dTag === proposalDTag);
    if (!proposal || !proposal._nostrOriginal) { showNotification('Propuesta no encontrada', 'error'); return; }

    const voteBtn = document.querySelector('.modal .btn-primary');
    if (voteBtn) { voteBtn.disabled = true; voteBtn.innerHTML = '⏳ Enviando voto...'; }

    try {
        const nostrP = proposal._nostrOriginal;
        await LBW_Governance.publishVote(nostrP.id, nostrP.dTag, option);
        showNotification(`¡Voto "${option}" emitido correctamente! 🗳️`, 'success');
        const modal = document.querySelector('.modal.active');
        if (modal) modal.remove();
        setTimeout(() => { updateGovStats(); displayProposals(); }, 500);
    } catch (err) {
        console.error('[Vote] Error:', err);
        showNotification('Error: ' + err.message, 'error');
        if (voteBtn) { voteBtn.disabled = false; voteBtn.innerHTML = '🗳️ Emitir Voto'; }
    }
}

// ── Submit Execution Report ────────────────────────────────
async function submitExecutionReport(proposalDTag) {
    const descEl = document.getElementById('executionDescription');
    const linksEl = document.getElementById('executionLinks');
    const description = descEl?.value?.trim();

    if (!description) { showNotification('Describe la ejecución de la propuesta', 'error'); return; }

    const links = linksEl?.value
        ? linksEl.value.split(',').map(l => l.trim()).filter(l => l.length > 0)
        : [];

    const btn = document.querySelector('#executionReportSection .btn-primary');
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Publicando...'; }

    try {
        await LBW_Governance.publishExecution(proposalDTag, { description, links });
        showNotification('✅ Reporte de ejecución publicado. Los Génesis pueden verificarlo.', 'success');
        const modal = document.querySelector('.modal.active');
        if (modal) modal.remove();
        setTimeout(displayProposals, 500);
    } catch (err) {
        showNotification('Error: ' + err.message, 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '📤 Publicar Reporte de Ejecución'; }
    }
}

// ── Submit Exec Verification (Governor) ───────────────────
async function submitExecVerification(proposalDTag) {
    const btn = document.querySelector('[onclick*="submitExecVerification"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Verificando...'; }

    try {
        await LBW_Governance.verifyExecution(proposalDTag);
        showNotification('🏆 ¡Ejecución verificada! Se han otorgado 50 méritos al autor.', 'success');
        const modal = document.querySelector('.modal.active');
        if (modal) modal.remove();
        setTimeout(displayProposals, 500);
    } catch (err) {
        showNotification('Error: ' + err.message, 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '👑 Verificar Ejecución (+50 méritos al autor)'; }
    }
}

async function activateProposal(proposalId) {
    showNotification('Las propuestas Nostr se activan automáticamente al publicarse ✅', 'success');
    displayProposals();
}

function calculateVoteResults(proposalVotes) {
    const results = {};
    (proposalVotes || []).forEach(v => { const opt = v.vote_option || v.option || ''; results[opt] = (results[opt] || 0) + 1; });
    return results;
}

function displayVoteResults(proposalVotes, results) {
    const total = (proposalVotes || []).length;
    if (total === 0) return '<p style="color:var(--color-text-secondary);text-align:center;">Aún no hay votos</p>';
    return Object.entries(results).map(([option, count]) => {
        const pct = ((count / total) * 100).toFixed(1);
        return `<div style="margin-bottom:1rem;">
            <div style="display:flex;justify-content:space-between;margin-bottom:0.5rem;">
                <span style="font-weight:600;">${escapeHtml(option)}</span>
                <span style="color:var(--color-gold);font-weight:700;">${count} (${pct}%)</span>
            </div>
            <div style="background:rgba(255,255,255,0.1);height:8px;border-radius:4px;overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#E5B95C,#52c41a);border-radius:4px;transition:width 0.3s ease;"></div>
            </div>
        </div>`;
    }).join('');
}

// Muestra resultados ponderados por méritos LBWM (para propuestas cerradas con resultado oficial)
function displayWeightedVoteResults(weightedVotes) {
    if (!weightedVotes || Object.keys(weightedVotes).length === 0) return '';
    const totalWeight = Object.values(weightedVotes).reduce((s, v) => s + v, 0);
    if (totalWeight === 0) return '';
    return Object.entries(weightedVotes)
        .sort((a, b) => b[1] - a[1])
        .map(([option, weight]) => {
            const pct = ((weight / totalWeight) * 100).toFixed(1);
            return `<div style="margin-bottom:1rem;">
                <div style="display:flex;justify-content:space-between;margin-bottom:0.5rem;">
                    <span style="font-weight:600;">${escapeHtml(option)}</span>
                    <span style="color:var(--color-gold);font-weight:700;">${pct}%</span>
                </div>
                <div style="background:rgba(255,255,255,0.1);height:8px;border-radius:4px;overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#E5B95C,#52c41a);border-radius:4px;transition:width 0.3s ease;"></div>
                </div>
            </div>`;
        }).join('');
}

function getTimeLeft(endTime) {
    const diff = endTime - Date.now();
    if (diff <= 0) return 'Finalizada';
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    if (days > 0) return `${days} día${days > 1 ? 's' : ''}`;
    if (hours > 0) return `${hours} hora${hours > 1 ? 's' : ''}`;
    return 'Menos de 1 hora';
}

function updateVoteResultsInModal(proposalDTag) {
    const resultsContainer = document.getElementById('voteResultsContainer');
    if (!resultsContainer) return;

    const proposalVotes = LBW_Governance.getVotesForProposal(proposalDTag);
    const myVote = LBW_Governance.getMyVote(proposalDTag);
    const voteResults = {};
    proposalVotes.forEach(v => { voteResults[v.option] = (voteResults[v.option] || 0) + 1; });

    const voteCountEl = document.getElementById('modalVoteCount');
    if (voteCountEl) voteCountEl.textContent = proposalVotes.length;

    if (proposalVotes.length > 0) {
        const proposal = allProposals.find(p => p.dTag === proposalDTag);
        const isClosed = proposal && proposal.status !== 'active';
        const result = LBW_Governance.getResult(proposalDTag);
        const hasWeighted = result && result.weighted_votes && Object.keys(result.weighted_votes).length > 0;

        let innerHtml = '';
        if (isClosed && hasWeighted) {
            innerHtml = `
                <h3 style="color:var(--color-gold);margin-bottom:0.5rem;">Resultados Finales</h3>
                <div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:1rem;">Ponderados por méritos LBWM · ${proposalVotes.length} voto${proposalVotes.length !== 1 ? 's' : ''} emitido${proposalVotes.length !== 1 ? 's' : ''}</div>
                ${displayWeightedVoteResults(result.weighted_votes)}
            `;
        } else {
            const label = isClosed ? 'Resultados Finales' : 'Resultados Parciales';
            const sublabel = isClosed
                ? ''
                : `<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:1rem;">Conteo provisional (sin ponderar) · ${proposalVotes.length} voto${proposalVotes.length !== 1 ? 's' : ''} emitido${proposalVotes.length !== 1 ? 's' : ''}</div>`;
            innerHtml = `
                <h3 style="color:var(--color-gold);margin-bottom:0.5rem;">${label}</h3>
                ${sublabel}
                ${displayVoteResults(proposalVotes, voteResults)}
            `;
        }
        resultsContainer.innerHTML = innerHtml;
    }

    const voteSection = document.getElementById('voteSectionContainer');
    if (voteSection && myVote && voteSection.querySelector('.vote-option-btn')) {
        voteSection.innerHTML = `
            <div style="background:rgba(82,196,26,0.1);padding:1.25rem;border-radius:12px;border:1px solid #52c41a;text-align:center;">
                <p style="color:#52c41a;font-weight:600;">✓ Ya has votado: "${myVote.option}"</p>
            </div>
        `;
    }
}

// ========== GOVERNANCE FUNCTIONS (Nostr-integrated) ==========
// All data flows through LBW_Governance → Nostr relays
// Zero Supabase dependencies

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

    const data = {
        title,
        description,
        category,
        durationSecs: durationDays * 86400
    };

    // Type-specific fields
    if (category === 'budget') {
        const ba = document.getElementById('budgetAmount');
        if (ba) data.budget = { amount: parseInt(ba.value) || 0, currency: 'sats' };
    } else if (category === 'election') {
        const ec = document.getElementById('electionCandidates');
        if (ec) {
            const candidates = ec.value.split('\n').map(c => c.trim()).filter(c => c.length > 0);
            if (candidates.length < 2) {
                showNotification('Necesitas al menos 2 candidatos', 'error');
                return;
            }
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
            // Asegurar que los votos estén cargados
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

        // NO suscribirse a votos aquí - solo cuando se abre una propuesta
        // Esto evita rate limiting

        allVotes = [];
        updateGovStats();
        displayProposals();

        // Re-render diferido para captar datos tardíos de relays
        setTimeout(() => {
            updateGovStats();
            displayProposals();
        }, 3000);
    } catch (err) {
        console.error('Error loading proposals:', err);
        allProposals = [];
        updateGovStats();
        displayProposals();
    }
}

// Convert Nostr proposal to format expected by UI
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
        _nostrOriginal: p
    };
}

function updateGovStats() {
    if (typeof LBW_Governance === 'undefined') return;
    const stats = LBW_Governance.getStats();
    const el = id => document.getElementById(id);
    if (el('activeProposalsCount')) el('activeProposalsCount').textContent = stats.active;
    if (el('totalProposalsCount')) el('totalProposalsCount').textContent = stats.total;
    if (el('myVotesCount')) el('myVotesCount').textContent = stats.myVotes;
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
                if (currentProposalFilter === 'active') return p.status === 'active';
                if (currentProposalFilter === 'closed') return p.status !== 'active';
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

    const pubKey = LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : '';

    container.innerHTML = proposalsToShow.map(proposal => {
        const typeLabels = {
            'referendum': '🗳️ Referéndum', 'budget': '💰 Presupuesto',
            'election': '👥 Elección', 'amendment': '📜 Enmienda',
            'general': '📋 General', 'emergency': '🚨 Emergencia'
        };

        const nostrP = proposal._nostrOriginal;
        const myVote = nostrP ? LBW_Governance.getMyVote(nostrP.dTag) : null;
        const votes = nostrP ? LBW_Governance.getVotesForProposal(nostrP.dTag) : [];
        const timeLeft = proposal.ends_at ? getTimeLeft(new Date(proposal.ends_at).getTime()) : '';

        return `
            <div class="proposal-card ${proposal.status}" onclick="showProposalDetail('${proposal.dTag || proposal.id}')">
                <div class="proposal-type-badge">${typeLabels[proposal.proposal_type] || proposal.proposal_type}</div>
                <div class="proposal-status ${proposal.status}">
                    ${proposal.status === 'active' ? '✅ Activa' : proposal.status === 'expired' ? '⏰ Expirada' : '🔒 Cerrada'}
                </div>
                <div class="proposal-title">${escapeHtml(proposal.title)}</div>
                <div class="proposal-description">${escapeHtml(proposal.description)}</div>
                ${proposal.status === 'active' ? `
                    <div class="vote-progress">
                        <div class="vote-stats">
                            <span>${votes.length} votos</span>
                            <span>${timeLeft}</span>
                        </div>
                        ${myVote ? '<div style="margin-top:0.5rem;color:var(--color-accent-green);font-size:0.85rem;">✓ Ya has votado</div>' : ''}
                    </div>
                ` : ''}
                <div class="proposal-meta">
                    <span>Por ${escapeHtml(proposal.author_name)}</span>
                    <span>${new Date(proposal.created_at).toLocaleDateString('es-ES')}</span>
                </div>
            </div>
        `;
    }).join('');
}

function filterProposals(filter) {
    currentProposalFilter = filter;
    document.querySelectorAll('[data-filter-prop]').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.querySelector(`[data-filter-prop="${filter}"]`);
    if (activeBtn) activeBtn.classList.add('active');
    displayProposals();
}

async function showProposalDetail(proposalIdentifier) {
    // Buscar por dTag primero, luego por id
    const proposal = allProposals.find(p => p.dTag === proposalIdentifier || p.id === proposalIdentifier);
    if (!proposal) {
        console.warn('[Governance] Propuesta no encontrada:', proposalIdentifier);
        return;
    }

    const nostrP = proposal._nostrOriginal;
    const pubKey = LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : '';

    // Suscribirse a votos (la actualización es asíncrona)
    if (nostrP) {
        LBW_Governance.subscribeVotes(nostrP.id, nostrP.dTag, (vote) => {
            // Actualizar UI cuando lleguen votos nuevos
            updateVoteResultsInModal(nostrP.dTag);
        });
    }
    
    // Esperar solo un poco para dar tiempo a cargar desde caché
    await new Promise(r => setTimeout(r, 300));

    const proposalVotes = nostrP ? LBW_Governance.getVotesForProposal(nostrP.dTag) : [];
    const myVote = nostrP ? LBW_Governance.getMyVote(nostrP.dTag) : null;
    const hasVoted = !!myVote;
    const canVote = proposal.status === 'active' && !hasVoted;

    const voteResults = {};
    proposalVotes.forEach(v => { voteResults[v.option] = (voteResults[v.option] || 0) + 1; });

    const typeLabels = {
        'referendum': '🗳️ Referéndum', 'budget': '💰 Presupuesto',
        'election': '👥 Elección', 'amendment': '📜 Enmienda',
        'general': '📋 General', 'emergency': '🚨 Emergencia'
    };

    let authorName = proposal.author_name;
    // Fetch profile in background — don't block the modal
    if (nostrP && typeof LBW_Nostr.fetchUserProfile === 'function') {
        LBW_Nostr.fetchUserProfile(nostrP.pubkey).then(p => {
            if (p?.name) {
                const el = document.getElementById('proposal-author-name');
                if (el) el.textContent = p.name;
            }
        }).catch(() => {});
    }

    // Cerrar modales anteriores de propuesta (los que no tienen ID)
    document.querySelectorAll('.modal.active').forEach(m => {
        if (!m.id) m.remove();
    });

    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.innerHTML = `
        <div class="modal-content" style="position:relative;max-width:700px;">
            <button class="modal-close" onclick="this.closest('.modal').remove()">×</button>
            <div class="modal-header" style="background:linear-gradient(135deg,var(--color-teal),var(--color-teal-dark));padding:2rem;">
                <div class="proposal-status ${proposal.status}" style="margin-bottom:1rem;">
                    ${proposal.status === 'active' ? '✅ ACTIVA' : proposal.status === 'expired' ? '⏰ EXPIRADA' : '🔒 CERRADA'}
                </div>
                <div style="font-size:0.9rem;color:var(--color-gold);margin-bottom:0.5rem;">${typeLabels[proposal.proposal_type] || proposal.proposal_type}</div>
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
                        <div><div style="color:var(--color-text-secondary);margin-bottom:0.25rem;">${proposal.status === 'active' ? 'Tiempo restante' : 'Estado'}</div><div style="font-weight:600;">${proposal.status === 'active' && proposal.ends_at ? getTimeLeft(new Date(proposal.ends_at).getTime()) : 'Cerrada'}</div></div>
                    </div>
                </div>

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
                ${proposalVotes.length > 0 ? `
                    <h3 style="color:var(--color-gold);margin-bottom:1rem;">Resultados ${proposal.status === 'active' ? 'Parciales' : 'Finales'}</h3>
                    ${displayVoteResults(proposalVotes, voteResults)}
                ` : '<p style="color:var(--color-text-secondary);text-align:center;">Aún no hay votos</p>'}
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

function getVoteOptions(proposal) {
    const options = proposal.options || proposal._nostrOriginal?.options || [];
    if (options.length > 0) {
        return options.map(opt => `<button class="vote-option-btn" onclick="selectVoteOption(this, '${escapeHtml(opt)}')">${escapeHtml(opt)}</button>`).join('');
    }
    // Fallback
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

    const nostrP = proposal._nostrOriginal;
    
    // Deshabilitar botón mientras se procesa
    const voteBtn = document.querySelector('.modal .btn-primary');
    if (voteBtn) {
        voteBtn.disabled = true;
        voteBtn.innerHTML = '⏳ Enviando voto...';
    }

    try {
        console.log('[Vote] Enviando voto:', { proposalId: nostrP.id, dTag: nostrP.dTag, option });
        const result = await LBW_Governance.publishVote(nostrP.id, nostrP.dTag, option);
        console.log('[Vote] Resultado:', result);
        
        // Mostrar notificación de éxito
        showNotification(`¡Voto "${option}" emitido correctamente! 🗳️`, 'success');
        
        // Cerrar modal
        const modal = document.querySelector('.modal.active');
        if (modal) modal.remove();
        
        // Actualizar UI después de un breve delay
        setTimeout(() => { 
            updateGovStats(); 
            displayProposals(); 
        }, 500);
    } catch (err) {
        console.error('[Vote] Error submitting vote:', err);
        showNotification('Error: ' + err.message, 'error');
        
        // Rehabilitar botón en caso de error
        if (voteBtn) {
            voteBtn.disabled = false;
            voteBtn.innerHTML = '🗳️ Emitir Voto';
        }
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
        return `<div style="margin-bottom:1rem;"><div style="display:flex;justify-content:space-between;margin-bottom:0.5rem;"><span style="font-weight:600;">${escapeHtml(option)}</span><span style="color:var(--color-gold);font-weight:700;">${count} (${pct}%)</span></div><div class="vote-progress-bar"><div class="vote-progress-fill" style="width:${pct}%"></div></div></div>`;
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

// Actualiza los resultados de votación en el modal abierto
function updateVoteResultsInModal(proposalDTag) {
    const resultsContainer = document.getElementById('voteResultsContainer');
    if (!resultsContainer) return;
    
    const proposalVotes = LBW_Governance.getVotesForProposal(proposalDTag);
    const myVote = LBW_Governance.getMyVote(proposalDTag);
    
    const voteResults = {};
    proposalVotes.forEach(v => { voteResults[v.option] = (voteResults[v.option] || 0) + 1; });
    
    // Actualizar contador de votos
    const voteCountEl = document.getElementById('modalVoteCount');
    if (voteCountEl) voteCountEl.textContent = proposalVotes.length;
    
    // Actualizar resultados
    if (proposalVotes.length > 0) {
        resultsContainer.innerHTML = `
            <h3 style="color:var(--color-gold);margin-bottom:1rem;">Resultados Parciales</h3>
            ${displayVoteResults(proposalVotes, voteResults)}
        `;
    }
    
    // Actualizar estado de "ya has votado" si es necesario
    const voteSection = document.getElementById('voteSectionContainer');
    if (voteSection && myVote && voteSection.querySelector('.vote-option-btn')) {
        voteSection.innerHTML = `
            <div style="background:rgba(82,196,26,0.1);padding:1.25rem;border-radius:12px;border:1px solid #52c41a;text-align:center;">
                <p style="color:#52c41a;font-weight:600;">✓ Ya has votado: "${myVote.option}"</p>
            </div>
        `;
    }
}

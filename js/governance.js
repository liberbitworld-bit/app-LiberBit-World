// ========== GOVERNANCE FUNCTIONS ==========

function showNewProposalForm() {
    document.getElementById('newProposalForm').style.display = 'block';
    document.getElementById('newProposalForm').scrollIntoView({ behavior: 'smooth' });
    updateProposalFormFields();
}

function cancelProposalForm() {
    document.getElementById('newProposalForm').style.display = 'none';
    document.getElementById('proposalTitle').value = '';
    document.getElementById('proposalDescription').value = '';
    document.getElementById('budgetAmount').value = '';
    document.getElementById('electionCandidates').value = '';
}

function updateProposalFormFields() {
    const type = document.getElementById('proposalType').value;
    document.getElementById('budgetFields').style.display = type === 'budget' ? 'block' : 'none';
    document.getElementById('electionFields').style.display = type === 'election' ? 'block' : 'none';
}

async function submitProposal() {
    const type = document.getElementById('proposalType').value;
    const title = document.getElementById('proposalTitle').value.trim();
    const description = document.getElementById('proposalDescription').value.trim();
    const duration = parseInt(document.getElementById('proposalDuration').value);

    if (!title || !description) {
        showNotification('Complete título y descripción', 'error');
        return;
    }

    const pubKey = currentUser.pubkey || currentUser.publicKey;
    const endsAt = new Date(Date.now() + (duration * 24 * 60 * 60 * 1000)).toISOString();

    const proposalData = {
        id: generateUUID(),
        author_id: pubKey,
        author_name: currentUser.name,
        proposal_type: type,
        title: title,
        description: description,
        status: 'pending',
        ends_at: endsAt
    };

    // Type-specific fields
    if (type === 'budget') {
        proposalData.budget_amount = parseInt(document.getElementById('budgetAmount').value) || 0;
    } else if (type === 'election') {
        const candidates = document.getElementById('electionCandidates').value
            .split('\n')
            .map(c => c.trim())
            .filter(c => c.length > 0);
        if (candidates.length < 2) {
            showNotification('Necesitas al menos 2 candidatos', 'error');
            return;
        }
        proposalData.candidates = candidates;
    }

    try {
        const { data, error } = await supabaseClient
            .from('proposals')
            .insert([proposalData])
            .select()
            .single();

        if (error) {
            console.error('Error creating proposal:', error);
            showNotification('Error al crear propuesta: ' + error.message, 'error');
            return;
        }

        cancelProposalForm();
        showNotification('¡Propuesta creada! Está en estado pendiente', 'success');
        await loadProposals();

    } catch (err) {
        console.error('Error:', err);
        showNotification('Error al crear propuesta', 'error');
    }
}

async function loadProposals() {
    try {
        // Load proposals from Supabase
        const { data: proposalsData, error: propError } = await supabaseClient
            .from('proposals')
            .select('*')
            .order('created_at', { ascending: false });

        if (propError) {
            console.error('Error loading proposals:', propError);
            allProposals = [];
        } else {
            // Check and close expired proposals
            const now = new Date().toISOString();
            const toClose = (proposalsData || []).filter(p => p.status === 'active' && p.ends_at && p.ends_at < now);

            if (toClose.length > 0) {
                await supabaseClient
                    .from('proposals')
                    .update({ status: 'closed' })
                    .in('id', toClose.map(p => p.id));
                toClose.forEach(p => { p.status = 'closed'; });
            }

            allProposals = proposalsData || [];
        }

        // Load votes from Supabase
        const { data: votesData, error: votesError } = await supabaseClient
            .from('votes')
            .select('*');

        if (!votesError) {
            allVotes = votesData || [];
        }

        updateGovStats();
        displayProposals();

    } catch (err) {
        console.error('Error loading proposals:', err);
        allProposals = [];
        updateGovStats();
        displayProposals();
    }
}

function updateGovStats() {
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    const active = allProposals.filter(p => p.status === 'active').length;
    const myVotes = allVotes.filter(v => v.voter_id === pubKey).length;

    document.getElementById('activeProposalsCount').textContent = active;
    document.getElementById('myVotesCount').textContent = myVotes;
    document.getElementById('totalProposalsCount').textContent = allProposals.length;
}

function displayProposals() {
    const container = document.getElementById('proposalsList');

    let proposalsToShow = allProposals;
    if (currentProposalFilter !== 'all') {
        proposalsToShow = allProposals.filter(p => p.status === currentProposalFilter);
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

    const pubKey = currentUser.pubkey || currentUser.publicKey;

    container.innerHTML = proposalsToShow.map(proposal => {
        const typeLabels = {
            'referendum': '📋 Referéndum',
            'budget': '💰 Presupuesto',
            'election': '👥 Elección'
        };

        const hasVoted = allVotes.some(v => v.proposal_id === proposal.id && v.voter_id === pubKey);
        const voteCount = allVotes.filter(v => v.proposal_id === proposal.id).length;
        const timeLeft = proposal.ends_at ? getTimeLeft(new Date(proposal.ends_at).getTime()) : '';

        return `
            <div class="proposal-card ${proposal.status}" onclick="showProposalDetail('${proposal.id}')">
                <div class="proposal-type-badge">${typeLabels[proposal.proposal_type] || proposal.proposal_type}</div>
                <div class="proposal-status ${proposal.status}">
                    ${proposal.status === 'active' ? '✅ Activa' : proposal.status === 'pending' ? '⏳ Pendiente' : '🔒 Cerrada'}
                </div>
                <div class="proposal-title">${escapeHtml(proposal.title)}</div>
                <div class="proposal-description">${escapeHtml(proposal.description)}</div>
                ${proposal.status === 'active' ? `
                    <div class="vote-progress">
                        <div class="vote-stats">
                            <span>${voteCount} votos emitidos</span>
                            <span>${timeLeft}</span>
                        </div>
                        ${hasVoted ? '<div style="margin-top: 0.5rem; color: var(--color-accent-green); font-size: 0.85rem;">✓ Ya has votado</div>' : ''}
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

    document.querySelectorAll('[data-filter-prop]').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-filter-prop="${filter}"]`).classList.add('active');

    displayProposals();
}

async function showProposalDetail(proposalId) {
    const proposal = allProposals.find(p => p.id === proposalId);
    if (!proposal) return;

    const pubKey = currentUser.pubkey || currentUser.publicKey;

    const typeLabels = {
        'referendum': '📋 Referéndum',
        'budget': '💰 Asignación de Presupuesto',
        'election': '👥 Elección de Representante'
    };

    const proposalVotes = allVotes.filter(v => v.proposal_id === proposalId);
    const hasVoted = proposalVotes.some(v => v.voter_id === pubKey);
    const canVote = proposal.status === 'active' && !hasVoted;
    const isAuthor = proposal.author_id === pubKey;

    const voteResults = calculateVoteResults(proposalVotes);

    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.innerHTML = `
        <div class="modal-content" style="position: relative; max-width: 700px;">
            <button class="modal-close" onclick="this.closest('.modal').remove()">×</button>
            <div class="modal-header" style="background: linear-gradient(135deg, var(--color-teal), var(--color-teal-dark)); padding: 2rem;">
                <div class="proposal-status ${proposal.status}" style="margin-bottom: 1rem;">
                    ${proposal.status === 'active' ? '✅ ACTIVA' : proposal.status === 'pending' ? '⏳ PENDIENTE' : '🔒 CERRADA'}
                </div>
                <div style="font-size: 0.9rem; color: var(--color-gold); margin-bottom: 0.5rem;">${typeLabels[proposal.proposal_type] || proposal.proposal_type}</div>
                <h2 style="color: white; margin: 0;">${escapeHtml(proposal.title)}</h2>
            </div>
            <div class="modal-body">
                <p style="color: var(--color-text-secondary); line-height: 1.7; margin-bottom: 1.5rem;">
                    ${escapeHtml(proposal.description)}
                </p>

                ${proposal.proposal_type === 'budget' && proposal.budget_amount ? `
                    <div style="background: var(--color-bg-dark); padding: 1.25rem; border-radius: 12px; margin-bottom: 1.5rem; border: 2px solid var(--color-gold);">
                        <div style="font-size: 0.85rem; color: var(--color-text-secondary); margin-bottom: 0.5rem;">Monto Solicitado</div>
                        <div style="font-size: 1.8rem; font-weight: 700; color: var(--color-gold);">${proposal.budget_amount.toLocaleString()} sats</div>
                    </div>
                ` : ''}

                <div style="background: var(--color-bg-dark); padding: 1.25rem; border-radius: 12px; margin-bottom: 1.5rem;">
                    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; font-size: 0.9rem;">
                        <div>
                            <div style="color: var(--color-text-secondary); margin-bottom: 0.25rem;">Propuesta por</div>
                            <div style="font-weight: 600;">${escapeHtml(proposal.author_name)}</div>
                        </div>
                        <div>
                            <div style="color: var(--color-text-secondary); margin-bottom: 0.25rem;">Fecha de creación</div>
                            <div style="font-weight: 600;">${new Date(proposal.created_at).toLocaleDateString('es-ES')}</div>
                        </div>
                        <div>
                            <div style="color: var(--color-text-secondary); margin-bottom: 0.25rem;">Total de votos</div>
                            <div style="font-weight: 600; color: var(--color-gold);">${proposalVotes.length}</div>
                        </div>
                        <div>
                            <div style="color: var(--color-text-secondary); margin-bottom: 0.25rem;">${proposal.status === 'active' ? 'Tiempo restante' : 'Estado'}</div>
                            <div style="font-weight: 600;">${proposal.status === 'active' && proposal.ends_at ? getTimeLeft(new Date(proposal.ends_at).getTime()) : 'Cerrada'}</div>
                        </div>
                    </div>
                </div>

                ${proposal.status === 'pending' && isAuthor ? `
                    <div style="background: rgba(249, 115, 22, 0.1); padding: 1.25rem; border-radius: 12px; margin-bottom: 1.5rem; border: 1px solid #f97316;">
                        <p style="color: var(--color-text-secondary); margin-bottom: 1rem;">
                            Esta propuesta está pendiente de validación. Como autor, puedes activarla manualmente:
                        </p>
                        <button class="btn btn-primary" onclick="activateProposal('${proposal.id}'); this.closest('.modal').remove();" style="width: 100%;">
                            ✅ Activar Propuesta
                        </button>
                    </div>
                ` : ''}

                ${canVote ? `
                    <div style="background: var(--color-bg-dark); padding: 1.5rem; border-radius: 12px; border: 2px solid var(--color-gold);">
                        <h3 style="color: var(--color-gold); margin-bottom: 1rem;">Tu Voto</h3>
                        <div id="voteOptions">
                            ${getVoteOptions(proposal)}
                        </div>
                        <button class="btn btn-primary" onclick="submitVote('${proposal.id}')" style="width: 100%; margin-top: 1rem;">
                            🗳️ Emitir Voto
                        </button>
                    </div>
                ` : hasVoted ? `
                    <div style="background: rgba(82, 196, 26, 0.1); padding: 1.25rem; border-radius: 12px; border: 1px solid #52c41a; text-align: center;">
                        <p style="color: #52c41a; font-weight: 600;">✓ Ya has votado en esta propuesta</p>
                    </div>
                ` : ''}

                ${proposal.status !== 'pending' ? `
                    <div style="margin-top: 1.5rem;">
                        <h3 style="color: var(--color-gold); margin-bottom: 1rem;">Resultados ${proposal.status === 'active' ? 'Parciales' : 'Finales'}</h3>
                        ${displayVoteResults(proposalVotes, voteResults)}
                    </div>
                ` : ''}
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
}

function getVoteOptions(proposal) {
    if (proposal.proposal_type === 'referendum') {
        return `
            <button class="vote-option-btn" onclick="selectVoteOption(this, 'si')">✅ Sí</button>
            <button class="vote-option-btn" onclick="selectVoteOption(this, 'no')">❌ No</button>
            <button class="vote-option-btn" onclick="selectVoteOption(this, 'abstencion')">⚪ Abstención</button>
        `;
    } else if (proposal.proposal_type === 'budget') {
        return `
            <button class="vote-option-btn" onclick="selectVoteOption(this, 'aprobar')">✅ Aprobar</button>
            <button class="vote-option-btn" onclick="selectVoteOption(this, 'rechazar')">❌ Rechazar</button>
            <button class="vote-option-btn" onclick="selectVoteOption(this, 'abstencion')">⚪ Abstención</button>
        `;
    } else if (proposal.proposal_type === 'election') {
        return (proposal.candidates || []).map(candidate => `
            <button class="vote-option-btn" onclick="selectVoteOption(this, '${escapeHtml(candidate)}')" style="display: block; width: 100%;">
                ${escapeHtml(candidate)}
            </button>
        `).join('');
    }
    return '';
}

function selectVoteOption(btn, option) {
    document.querySelectorAll('.vote-option-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    btn.setAttribute('data-selected', option);
}

async function submitVote(proposalId) {
    const selectedBtn = document.querySelector('.vote-option-btn.selected');
    if (!selectedBtn) {
        showNotification('Selecciona una opción', 'error');
        return;
    }

    const option = selectedBtn.getAttribute('data-selected');
    const pubKey = currentUser.pubkey || currentUser.publicKey;

    // Create anonymous vote hash
    const voteString = `${pubKey}-${proposalId}-${option}-${Date.now()}`;
    const voteHash = await hashString(voteString);

    const voteData = {
        id: generateUUID(),
        proposal_id: proposalId,
        voter_id: pubKey,
        voter_name: currentUser.name,
        vote_option: option,
        vote_hash: voteHash
    };

    try {
        const { error } = await supabaseClient
            .from('votes')
            .insert([voteData]);

        if (error) {
            if (error.code === '23505') { // unique constraint
                showNotification('Ya has votado en esta propuesta', 'error');
            } else {
                console.error('Error submitting vote:', error);
                showNotification('Error al emitir voto: ' + error.message, 'error');
            }
            return;
        }

        showNotification('¡Voto emitido correctamente! 🗳️', 'success');
        document.querySelector('.modal').remove();
        await loadProposals();

    } catch (err) {
        console.error('Error:', err);
        showNotification('Error al emitir voto', 'error');
    }
}

async function activateProposal(proposalId) {
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    const proposal = allProposals.find(p => p.id === proposalId);

    if (!proposal || proposal.author_id !== pubKey) return;

    try {
        const { error } = await supabaseClient
            .from('proposals')
            .update({ status: 'active' })
            .eq('id', proposalId)
            .eq('author_id', pubKey);

        if (error) {
            console.error('Error activating proposal:', error);
            showNotification('Error al activar propuesta', 'error');
            return;
        }

        showNotification('¡Propuesta activada! 🎉', 'success');
        await loadProposals();

    } catch (err) {
        console.error('Error:', err);
        showNotification('Error al activar propuesta', 'error');
    }
}

function calculateVoteResults(proposalVotes) {
    const results = {};
    (proposalVotes || []).forEach(v => {
        results[v.vote_option] = (results[v.vote_option] || 0) + 1;
    });
    return results;
}

function displayVoteResults(proposalVotes, results) {
    const total = (proposalVotes || []).length;
    if (total === 0) {
        return '<p style="color: var(--color-text-secondary); text-align: center;">Aún no hay votos</p>';
    }

    return Object.entries(results).map(([option, count]) => {
        const percentage = ((count / total) * 100).toFixed(1);
        return `
            <div style="margin-bottom: 1rem;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                    <span style="font-weight: 600; text-transform: capitalize;">${escapeHtml(option)}</span>
                    <span style="color: var(--color-gold); font-weight: 700;">${count} (${percentage}%)</span>
                </div>
                <div class="vote-progress-bar">
                    <div class="vote-progress-fill" style="width: ${percentage}%"></div>
                </div>
            </div>
        `;
    }).join('');
}

function getTimeLeft(endTime) {
    const now = Date.now();
    const diff = endTime - now;

    if (diff <= 0) return 'Finalizada';

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    if (days > 0) return `${days} día${days > 1 ? 's' : ''}`;
    if (hours > 0) return `${hours} hora${hours > 1 ? 's' : ''}`;
    return 'Menos de 1 hora';
}

async function hashString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

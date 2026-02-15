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

function submitProposal() {
    const type = document.getElementById('proposalType').value;
    const title = document.getElementById('proposalTitle').value.trim();
    const description = document.getElementById('proposalDescription').value.trim();
    const duration = parseInt(document.getElementById('proposalDuration').value);

    if (!title || !description) {
        showNotification('Complete título y descripción', 'error');
        return;
    }

    const proposal = {
        id: Date.now(),
        type: type,
        title: title,
        description: description,
        author: currentUser.name,
        authorId: currentUser.publicKey,
        status: 'pending', // pending, active, closed
        createdAt: Date.now(),
        endsAt: Date.now() + (duration * 24 * 60 * 60 * 1000),
        votes: {}
    };

    // Type-specific fields
    if (type === 'budget') {
        proposal.budgetAmount = parseInt(document.getElementById('budgetAmount').value) || 0;
    } else if (type === 'election') {
        const candidates = document.getElementById('electionCandidates').value
            .split('\n')
            .map(c => c.trim())
            .filter(c => c.length > 0);
        if (candidates.length < 2) {
            showNotification('Necesitas al menos 2 candidatos', 'error');
            return;
        }
        proposal.candidates = candidates;
    }

    allProposals.unshift(proposal);
    localStorage.setItem('liberbit_proposals', JSON.stringify(allProposals));
    
    cancelProposalForm();
    showNotification('¡Propuesta creada! Está en estado pendiente', 'success');
    loadProposals();
}



function loadProposals() {
    const saved = localStorage.getItem('liberbit_proposals');
    if (saved) allProposals = JSON.parse(saved);

    const voteSaved = localStorage.getItem('liberbit_votes');
    if (voteSaved) allVotes = JSON.parse(voteSaved);

    // Update proposals status based on time
    allProposals.forEach(p => {
        if (p.status === 'active' && Date.now() > p.endsAt) {
            p.status = 'closed';
        }
    });
    localStorage.setItem('liberbit_proposals', JSON.stringify(allProposals));

    updateGovStats();
    displayProposals();
}

function updateGovStats() {
    const active = allProposals.filter(p => p.status === 'active').length;
    const myVotes = allVotes.filter(v => v.voterId === currentUser.publicKey).length;
    
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

    container.innerHTML = proposalsToShow.map(proposal => {
        const typeLabels = {
            'referendum': '📋 Referéndum',
            'budget': '💰 Presupuesto',
            'election': '👥 Elección'
        };

        const hasVoted = allVotes.some(v => v.proposalId === proposal.id && v.voterId === currentUser.publicKey);
        const voteCount = Object.keys(proposal.votes).length;
        const timeLeft = getTimeLeft(proposal.endsAt);

        return `
            <div class="proposal-card ${proposal.status}" onclick="showProposalDetail(${proposal.id})">
                <div class="proposal-type-badge">${typeLabels[proposal.type]}</div>
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
                    <span>Por ${escapeHtml(proposal.author)}</span>
                    <span>${new Date(proposal.createdAt).toLocaleDateString('es-ES')}</span>
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

function showProposalDetail(proposalId) {
    const proposal = allProposals.find(p => p.id === proposalId);
    if (!proposal) return;

    const typeLabels = {
        'referendum': '📋 Referéndum',
        'budget': '💰 Asignación de Presupuesto',
        'election': '👥 Elección de Representante'
    };

    const hasVoted = allVotes.some(v => v.proposalId === proposal.id && v.voterId === currentUser.publicKey);
    const canVote = proposal.status === 'active' && !hasVoted;
    const isAuthor = proposal.authorId === currentUser.publicKey;

    // Calculate votes
    const voteResults = calculateVoteResults(proposal);

    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.innerHTML = `
        <div class="modal-content" style="position: relative; max-width: 700px;">
            <button class="modal-close" onclick="this.closest('.modal').remove()">×</button>
            <div class="modal-header" style="background: linear-gradient(135deg, var(--color-teal), var(--color-teal-dark)); padding: 2rem;">
                <div class="proposal-status ${proposal.status}" style="margin-bottom: 1rem;">
                    ${proposal.status === 'active' ? '✅ ACTIVA' : proposal.status === 'pending' ? '⏳ PENDIENTE' : '🔒 CERRADA'}
                </div>
                <div style="font-size: 0.9rem; color: var(--color-gold); margin-bottom: 0.5rem;">${typeLabels[proposal.type]}</div>
                <h2 style="color: white; margin: 0;">${escapeHtml(proposal.title)}</h2>
            </div>
            <div class="modal-body">
                <p style="color: var(--color-text-secondary); line-height: 1.7; margin-bottom: 1.5rem;">
                    ${escapeHtml(proposal.description)}
                </p>

                ${proposal.type === 'budget' ? `
                    <div style="background: var(--color-bg-dark); padding: 1.25rem; border-radius: 12px; margin-bottom: 1.5rem; border: 2px solid var(--color-gold);">
                        <div style="font-size: 0.85rem; color: var(--color-text-secondary); margin-bottom: 0.5rem;">Monto Solicitado</div>
                        <div style="font-size: 1.8rem; font-weight: 700; color: var(--color-gold);">${proposal.budgetAmount.toLocaleString()} sats</div>
                    </div>
                ` : ''}

                <div style="background: var(--color-bg-dark); padding: 1.25rem; border-radius: 12px; margin-bottom: 1.5rem;">
                    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; font-size: 0.9rem;">
                        <div>
                            <div style="color: var(--color-text-secondary); margin-bottom: 0.25rem;">Propuesta por</div>
                            <div style="font-weight: 600;">${escapeHtml(proposal.author)}</div>
                        </div>
                        <div>
                            <div style="color: var(--color-text-secondary); margin-bottom: 0.25rem;">Fecha de creación</div>
                            <div style="font-weight: 600;">${new Date(proposal.createdAt).toLocaleDateString('es-ES')}</div>
                        </div>
                        <div>
                            <div style="color: var(--color-text-secondary); margin-bottom: 0.25rem;">Total de votos</div>
                            <div style="font-weight: 600; color: var(--color-gold);">${Object.keys(proposal.votes).length}</div>
                        </div>
                        <div>
                            <div style="color: var(--color-text-secondary); margin-bottom: 0.25rem;">${proposal.status === 'active' ? 'Tiempo restante' : 'Estado'}</div>
                            <div style="font-weight: 600;">${proposal.status === 'active' ? getTimeLeft(proposal.endsAt) : 'Cerrada'}</div>
                        </div>
                    </div>
                </div>

                ${proposal.status === 'pending' && isAuthor ? `
                    <div style="background: rgba(249, 115, 22, 0.1); padding: 1.25rem; border-radius: 12px; margin-bottom: 1.5rem; border: 1px solid #f97316;">
                        <p style="color: var(--color-text-secondary); margin-bottom: 1rem;">
                            Esta propuesta está pendiente de validación. Como autor, puedes activarla manualmente:
                        </p>
                        <button class="btn btn-primary" onclick="activateProposal(${proposal.id}); this.closest('.modal').remove();" style="width: 100%;">
                            ✅ Activar Propuesta
                        </button>
                    </div>
                ` : ''}

                ${proposal.status === 'active' && canVote ? `
                    <div style="background: var(--color-bg-dark); padding: 1.5rem; border-radius: 12px; border: 2px solid var(--color-gold);">
                        <h3 style="color: var(--color-gold); margin-bottom: 1rem;">Tu Voto</h3>
                        <div id="voteOptions">
                            ${getVoteOptions(proposal)}
                        </div>
                        <button class="btn btn-primary" onclick="submitVote(${proposal.id})" style="width: 100%; margin-top: 1rem;">
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
                        ${displayVoteResults(proposal, voteResults)}
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
    if (proposal.type === 'referendum') {
        return `
            <button class="vote-option-btn" onclick="selectVoteOption(this, 'si')">✅ Sí</button>
            <button class="vote-option-btn" onclick="selectVoteOption(this, 'no')">❌ No</button>
            <button class="vote-option-btn" onclick="selectVoteOption(this, 'abstencion')">⚪ Abstención</button>
        `;
    } else if (proposal.type === 'budget') {
        return `
            <button class="vote-option-btn" onclick="selectVoteOption(this, 'aprobar')">✅ Aprobar</button>
            <button class="vote-option-btn" onclick="selectVoteOption(this, 'rechazar')">❌ Rechazar</button>
            <button class="vote-option-btn" onclick="selectVoteOption(this, 'abstencion')">⚪ Abstención</button>
        `;
    } else if (proposal.type === 'election') {
        return proposal.candidates.map(candidate => `
            <button class="vote-option-btn" onclick="selectVoteOption(this, '${escapeHtml(candidate)}')" style="display: block; width: 100%;">
                ${escapeHtml(candidate)}
            </button>
        `).join('');
    }
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
    
    // Create anonymous vote hash
    const voteString = `${currentUser.publicKey}-${proposalId}-${option}-${Date.now()}`;
    const voteHash = await hashString(voteString);

    const vote = {
        id: Date.now(),
        proposalId: proposalId,
        voterId: currentUser.publicKey,
        voteHash: voteHash,
        timestamp: Date.now()
    };

    // Store vote
    allVotes.push(vote);
    localStorage.setItem('liberbit_votes', JSON.stringify(allVotes));

    // Update proposal votes
    const proposal = allProposals.find(p => p.id === proposalId);
    if (!proposal.votes) proposal.votes = {};
    proposal.votes[currentUser.publicKey] = option;
    localStorage.setItem('liberbit_proposals', JSON.stringify(allProposals));

    showNotification('¡Voto emitido correctamente! 🗳️', 'success');
    document.querySelector('.modal').remove();
    loadProposals();
}

function activateProposal(proposalId) {
    const proposal = allProposals.find(p => p.id === proposalId);
    if (proposal && proposal.authorId === currentUser.publicKey) {
        proposal.status = 'active';
        localStorage.setItem('liberbit_proposals', JSON.stringify(allProposals));
        showNotification('¡Propuesta activada! 🎉', 'success');
        loadProposals();
    }
}

function calculateVoteResults(proposal) {
    if (!proposal.votes) return {};
    
    const results = {};
    Object.values(proposal.votes).forEach(vote => {
        results[vote] = (results[vote] || 0) + 1;
    });
    
    return results;
}

function displayVoteResults(proposal, results) {
    const total = Object.keys(proposal.votes || {}).length;
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


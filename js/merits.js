async function loadMeritsData() {
    try {
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        
        // Calculate user merits from Supabase
        let totalMerits = 0;
        let breakdown = {
            posts: 0,
            offers: 0,
            votes: 0,
            proposals: 0,
            seniority: 0
        };
        
        // Count posts (10 LBWM each)
        const { data: postsData, error: postsError } = await supabaseClient
            .from('posts')
            .select('id')
            .eq('author_public_key', pubKey);
        
        if (!postsError && postsData) {
            breakdown.posts = postsData.length * 10;
            totalMerits += breakdown.posts;
            console.log('Posts:', postsData.length, 'Merits:', breakdown.posts);
        }
        
        // Count offers (10 LBWM each)
        const { data: offersData, error: offersError } = await supabaseClient
            .from('offers')
            .select('id')
            .eq('author_public_key', pubKey);
        
        if (!offersError && offersData) {
            breakdown.offers = offersData.length * 10;
            totalMerits += breakdown.offers;
            console.log('Offers:', offersData.length, 'Merits:', breakdown.offers);
        }
        
        // Count votes (10 LBWM each) - from localStorage for now
        const votes = JSON.parse(localStorage.getItem('liberbit_votes') || '[]');
        const userVotes = votes.filter(v => v.voterId === pubKey);
        breakdown.votes = userVotes.length * 10;
        totalMerits += breakdown.votes;
        console.log('Votes:', userVotes.length, 'Merits:', breakdown.votes);
        
        // Count proposals (10 LBWM each) - from localStorage for now
        const proposals = JSON.parse(localStorage.getItem('liberbit_proposals') || '[]');
        const userProposals = proposals.filter(p => p.createdBy === pubKey);
        breakdown.proposals = userProposals.length * 10;
        totalMerits += breakdown.proposals;
        console.log('Proposals:', userProposals.length, 'Merits:', breakdown.proposals);
        
        // Calculate seniority merits (1 LBWM per day since registration)
        const { data: userData, error: userError } = await supabaseClient
            .from('users')
            .select('created_at, registration_date')
            .eq('public_key', pubKey)
            .single();
        
        if (!userError && userData) {
            const registrationDate = new Date(userData.created_at || userData.registration_date || currentUser.created_at);
            const now = new Date();
            const daysSinceRegistration = Math.floor((now - registrationDate) / (1000 * 60 * 60 * 24));
            breakdown.seniority = daysSinceRegistration * 1; // 1 LBWM per day
            totalMerits += breakdown.seniority;
            console.log('Days since registration:', daysSinceRegistration, 'Seniority Merits:', breakdown.seniority);
        } else {
            // Fallback to currentUser.created_at if available
            if (currentUser.created_at) {
                const registrationDate = new Date(currentUser.created_at);
                const now = new Date();
                const daysSinceRegistration = Math.floor((now - registrationDate) / (1000 * 60 * 60 * 24));
                breakdown.seniority = daysSinceRegistration * 1;
                totalMerits += breakdown.seniority;
                console.log('Days since registration (fallback):', daysSinceRegistration, 'Seniority Merits:', breakdown.seniority);
            }
        }
        
        console.log('Total Merits:', totalMerits);
        console.log('Breakdown:', breakdown);
        
        // Update user merits display
        document.getElementById('userTotalMerits').textContent = totalMerits;
        
        // Update new stats elements
        if (document.getElementById('user_lbwm_activos')) {
            document.getElementById('user_lbwm_activos').textContent = totalMerits.toFixed ? totalMerits.toFixed(2) : totalMerits;
        }
        
        // Count contributions
        const contributions = JSON.parse(localStorage.getItem('liberbit_contributions') || '[]');
        const myContribs = contributions.filter(c => c.applicant_public_key === pubKey);
        if (document.getElementById('user_lbwm_aportaciones')) {
            document.getElementById('user_lbwm_aportaciones').textContent = myContribs.length;
        }
        
        // Update statistics panel
        if (document.getElementById('stat_mi_balance')) {
            document.getElementById('stat_mi_balance').textContent = totalMerits.toFixed ? totalMerits.toFixed(2) : totalMerits;
        }
        
        // Calculate level
        let level = 1;
        let levelName = 'Ciudadano';
        if (totalMerits >= 1000) {
            level = 4;
            levelName = 'Embajador';
        } else if (totalMerits >= 500) {
            level = 3;
            levelName = 'Líder Comunitario';
        } else if (totalMerits >= 100) {
            level = 2;
            levelName = 'Contribuidor';
        }
        
        // These elements may or may not exist depending on the current view
        const userLevelEl = document.getElementById('userLevel');
        if (userLevelEl) userLevelEl.textContent = level;
        const userLevelNameEl = document.getElementById('userLevelName');
        if (userLevelNameEl) userLevelNameEl.textContent = levelName;
        
        // Load leaderboard and ledger
        await loadLeaderboard();
        loadLedgerData();
        await updateLbwmStats(totalMerits);
        
    } catch (err) {
        if (!(err.message && err.message.includes('DataCloneError'))) {
            console.error('Error loading merits:', err.message);
        }
    }
}

async function loadLeaderboard() {
    // For now, show user as #1
    // In the future, this would query all users from Supabase
    const leaderboardHTML = `
        <div style="display: grid; gap: 1rem;">
            <div style="display: flex; align-items: center; gap: 1rem; padding: 1rem; background: rgba(229, 185, 92, 0.1); border-radius: 8px; border: 2px solid var(--color-gold);">
                <div style="font-size: 1.5rem; font-weight: 700; color: var(--color-gold); min-width: 40px;">🥇 1</div>
                <div style="flex: 1;">
                    <div style="color: var(--color-text-primary); font-weight: 600;">${currentUser.name}</div>
                    <div style="color: var(--color-text-secondary); font-size: 0.85rem;">Tú</div>
                </div>
                <div style="text-align: right;">
                    <div style="font-size: 1.3rem; font-weight: 700; color: var(--color-gold);" id="leaderboardUserMerits">0</div>
                    <div style="font-size: 0.75rem; color: var(--color-text-secondary);">LBWM</div>
                </div>
            </div>
            <div style="text-align: center; padding: 1rem; color: var(--color-text-secondary); font-size: 0.9rem;">
                💡 Más usuarios aparecerán aquí cuando se unan a la red
            </div>
        </div>
    `;
    
    const leaderboardEl = document.getElementById('leaderboardList');
    if (leaderboardEl) leaderboardEl.innerHTML = leaderboardHTML;
    
    // Copy merits to leaderboard
    const totalMerits = document.getElementById('userTotalMerits').textContent;
    const lbMeritsEl = document.getElementById('leaderboardUserMerits');
    if (lbMeritsEl) lbMeritsEl.textContent = totalMerits;
    const rankingEl = document.getElementById('userRanking');
    if (rankingEl) rankingEl.textContent = '1';
}

// Load Ledger data for the Ledger tab
function loadLedgerData() {
    const contributions = JSON.parse(localStorage.getItem('liberbit_contributions') || '[]');
    const ledgerBody = document.getElementById('ledgerTableBody');
    
    if (!ledgerBody) return;
    
    if (contributions.length === 0) {
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
        
        ledgerBody.innerHTML = contributions.map((c, i) => {
            const lbwm = parseFloat(c.lbwm_estimated || 0);
            totalEmitido += lbwm;
            aportantesSet.add(c.applicant_public_key);
            const statusClass = c.status === 'approved' ? 'status-activo' : 'status-pendiente';
            const statusLabel = c.status === 'approved' ? 'Activo' : 'Pendiente';
            const date = c.submitted_at ? new Date(c.submitted_at).toISOString().split('T')[0] : '-';
            
            return `
                <tr>
                    <td>${String(i + 1).padStart(3, '0')}</td>
                    <td>${date}</td>
                    <td>${c.applicant_name || '-'}</td>
                    <td>${c.contribution_type || '-'}</td>
                    <td>${(c.description || '-').substring(0, 50)}${(c.description || '').length > 50 ? '...' : ''}</td>
                    <td style="text-align: right;">${c.reference_value || 0} ${c.currency || 'EUR'}</td>
                    <td style="text-align: center;">${c.factor_proposed || '-'}</td>
                    <td style="text-align: right; font-weight: 700; color: var(--color-gold);">${lbwm.toFixed(2)}</td>
                    <td style="text-align: center;"><span class="status-badge ${statusClass}">${statusLabel}</span></td>
                </tr>
            `;
        }).join('');
        
        // Update ledger stats
        const totalEmitidoEl = document.getElementById('ledger_total_emitido');
        if (totalEmitidoEl) totalEmitidoEl.textContent = totalEmitido.toFixed(2) + ' LBWM';
        const emisionesEl = document.getElementById('ledger_emisiones');
        if (emisionesEl) emisionesEl.textContent = contributions.length;
        const aportantesEl = document.getElementById('ledger_aportantes');
        if (aportantesEl) aportantesEl.textContent = aportantesSet.size;
    }
}

// Update LBWM global statistics
async function updateLbwmStats(userMerits) {
    try {
        // Calculate global LBWM from ALL users in Supabase
        let globalTotalLbwm = 0;
        let totalUsers = 0;
        
        // Fetch all users to count total identities
        const { data: allUsers, error: usersError } = await supabaseClient
            .from('users')
            .select('public_key, created_at');
        
        if (!usersError && allUsers) {
            totalUsers = allUsers.length;
            
            // Calculate seniority merits for all users
            const now = new Date();
            allUsers.forEach(user => {
                if (user.created_at) {
                    const regDate = new Date(user.created_at);
                    const days = Math.floor((now - regDate) / (1000 * 60 * 60 * 24));
                    globalTotalLbwm += days * 1; // 1 LBWM per day per user
                }
            });
        }
        
        // Fetch all posts and count merits (10 LBWM each)
        const { data: allPostsData } = await supabaseClient
            .from('posts')
            .select('id');
        if (allPostsData) {
            globalTotalLbwm += allPostsData.length * 10;
        }
        
        // Fetch all offers and count merits (10 LBWM each)
        const { data: allOffersData } = await supabaseClient
            .from('offers')
            .select('id');
        if (allOffersData) {
            globalTotalLbwm += allOffersData.length * 10;
        }
        
        // Add contributions from localStorage
        const contributions = JSON.parse(localStorage.getItem('liberbit_contributions') || '[]');
        contributions.forEach(c => {
            globalTotalLbwm += parseFloat(c.lbwm_estimated || 0);
        });
        
        // Update UI
        const totalLbwmEl = document.getElementById('stat_total_lbwm');
        if (totalLbwmEl) totalLbwmEl.textContent = globalTotalLbwm.toFixed(2);
        
        const aportantesEl = document.getElementById('stat_aportantes');
        if (aportantesEl) aportantesEl.textContent = Math.max(totalUsers, 1);
        
        const emisionesEl = document.getElementById('stat_emisiones');
        const totalEmisiones = (allPostsData?.length || 0) + (allOffersData?.length || 0) + contributions.length;
        if (emisionesEl) emisionesEl.textContent = totalEmisiones;
        
        // Calculate participation percentage
        if (globalTotalLbwm > 0 && userMerits > 0) {
            const participacion = (userMerits / globalTotalLbwm) * 100;
            const partEl = document.getElementById('stat_mi_participacion');
            if (partEl) partEl.textContent = participacion.toFixed(2) + '%';
            const barEl = document.getElementById('participacionBar');
            if (barEl) barEl.style.width = Math.min(participacion, 100).toFixed(2) + '%';
        } else {
            const partEl = document.getElementById('stat_mi_participacion');
            if (partEl) partEl.textContent = '0%';
            const barEl = document.getElementById('participacionBar');
            if (barEl) barEl.style.width = '0%';
        }
        
        console.log(`Global LBWM: ${globalTotalLbwm.toFixed(2)} | User: ${userMerits} | Users: ${totalUsers}`);
    } catch (err) {
        console.error('Error calculating global stats:', err);
    }
}

// Professional Contribution System Functions
// LBWM Tab switching function
function switchLbwmTab(tabName) {
    // Deactivate all tabs
    document.querySelectorAll('.lbwm-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Hide all tab contents
    document.querySelectorAll('.lbwm-tab-content').forEach(content => {
        content.classList.remove('active');
    });
    
    // Activate selected tab
    const tab = document.querySelector(`.lbwm-tab[data-lbwm-tab="${tabName}"]`);
    if (tab) {
        tab.classList.add('active');
    }
    
    // Show selected content
    const content = document.getElementById(`lbwm-tab-${tabName}`);
    if (content) {
        content.classList.add('active');
    }
}

// Toggle financiada section in contribution form
function toggleFinanciada() {
    const isChecked = document.getElementById('aport_financiada').checked;
    const section = document.getElementById('financiada_section');
    section.style.display = isChecked ? 'block' : 'none';
    updatePreviewCalculation();
}

function showContributionForm() {
    const modal = document.getElementById('contributionFormModal');
    modal.style.display = 'flex';
    modal.classList.add('active');
    document.getElementById('contrib_identity').value = currentUser.name;
    updatePreviewCalculation();
}

function closeContributionForm() {
    const modal = document.getElementById('contributionFormModal');
    modal.style.display = 'none';
    modal.classList.remove('active');
    document.getElementById('contributionForm').reset();
}

function updateContributionFactor() {
    const typeSelect = document.getElementById('contrib_type');
    const selectedOption = typeSelect.options[typeSelect.selectedIndex];
    const factor = selectedOption.dataset.factor;
    
    const financiadaDiv = document.getElementById('financiada_factor');
    if (typeSelect.value === 'financiada') {
        financiadaDiv.style.display = 'block';
        document.getElementById('preview_factor').textContent = document.getElementById('contrib_factor_financiada').value;
    } else {
        financiadaDiv.style.display = 'none';
        document.getElementById('preview_factor').textContent = factor;
    }
    
    updatePreviewCalculation();
}

function updatePreviewCalculation() {
    const value = parseFloat(document.getElementById('contrib_value')?.value) || 0;
    const currency = document.getElementById('contrib_currency')?.value || 'EUR';
    const esFinanciada = document.getElementById('aport_financiada')?.checked;
    const tipo = document.getElementById('contrib_type')?.value;
    
    let factor = 1.0;
    
    if (esFinanciada) {
        factor = parseFloat(document.getElementById('aport_factor')?.value || document.getElementById('contrib_factor_financiada')?.value || 0.4);
    } else if (tipo === 'financiada') {
        factor = parseFloat(document.getElementById('contrib_factor_financiada')?.value || 0.4);
    } else {
        factor = parseFloat(document.getElementById('preview_factor')?.textContent || 1.0);
        // If factor is still from financiada type, get from selected option
        const typeSelect = document.getElementById('contrib_type');
        if (typeSelect && typeSelect.selectedIndex > 0) {
            const selectedOption = typeSelect.options[typeSelect.selectedIndex];
            if (selectedOption.dataset.factor && selectedOption.dataset.factor !== '0.0') {
                factor = parseFloat(selectedOption.dataset.factor);
            }
        }
    }
    
    const lbwm = (value * factor).toFixed(2);
    
    const previewValueEl = document.getElementById('preview_value');
    if (previewValueEl) previewValueEl.textContent = value.toFixed(2);
    const previewCurrencyEl = document.getElementById('preview_currency');
    if (previewCurrencyEl) previewCurrencyEl.textContent = currency;
    const previewFactorEl = document.getElementById('preview_factor');
    if (previewFactorEl) previewFactorEl.textContent = factor.toFixed(1);
    const previewLbwmEl = document.getElementById('preview_lbwm');
    if (previewLbwmEl) previewLbwmEl.textContent = lbwm;
}

// Setup event listeners for preview updates
document.addEventListener('DOMContentLoaded', () => {
    const valueInput = document.getElementById('contrib_value');
    const currencySelect = document.getElementById('contrib_currency');
    const factorFinanciada = document.getElementById('contrib_factor_financiada');
    
    if (valueInput) valueInput.addEventListener('input', updatePreviewCalculation);
    if (currencySelect) currencySelect.addEventListener('change', updatePreviewCalculation);
    if (factorFinanciada) factorFinanciada.addEventListener('change', updatePreviewCalculation);
});

async function submitContribution(event) {
    event.preventDefault();
    
    try {
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        const typeSelect = document.getElementById('contrib_type');
        const selectedOption = typeSelect.options[typeSelect.selectedIndex];
        
        let factor = parseFloat(selectedOption.dataset.factor);
        if (typeSelect.value === 'financiada') {
            factor = parseFloat(document.getElementById('contrib_factor_financiada').value);
        }
        
        const contribution = {
            applicant_public_key: pubKey,
            applicant_name: currentUser.name,
            contribution_type: typeSelect.value,
            description: document.getElementById('contrib_description').value,
            period: document.getElementById('contrib_period').value,
            project: document.getElementById('contrib_project').value,
            reference_value: parseFloat(document.getElementById('contrib_value').value),
            currency: document.getElementById('contrib_currency').value,
            factor_proposed: factor,
            justification: document.getElementById('contrib_justification').value,
            evidence: document.getElementById('contrib_evidence').value,
            contact: document.getElementById('contrib_contact').value,
            status: 'pending',
            lbwm_estimated: (parseFloat(document.getElementById('contrib_value').value) * factor).toFixed(2)
        };
        
        // Save to Supabase - would need a new table "contributions"
        // For now, save to localStorage
        let contributions = JSON.parse(localStorage.getItem('liberbit_contributions') || '[]');
        contribution.id = 'CONT-' + Date.now();
        contribution.submitted_at = new Date().toISOString();
        contributions.push(contribution);
        localStorage.setItem('liberbit_contributions', JSON.stringify(contributions));
        
        showNotification('✅ Aportación enviada al Comité de Emisión', 'success');
        closeContributionForm();
        loadMyContributions();
        
    } catch (err) {
        console.error('Error submitting contribution:', err);
        showNotification('Error al enviar aportación', 'error');
    }
}

function loadMyContributions() {
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    const contributions = JSON.parse(localStorage.getItem('liberbit_contributions') || '[]');
    const myContribs = contributions.filter(c => c.applicant_public_key === pubKey);
    
    const container = document.getElementById('myContributionsList');
    
    if (myContribs.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--color-text-secondary);"><p>No has presentado aportaciones profesionales aún</p></div>';
        return;
    }
    
    const statusColors = {
        pending: '#FF9800',
        approved: '#4CAF50',
        rejected: '#F44336'
    };
    
    const statusLabels = {
        pending: '⏳ Pendiente',
        approved: '✅ Aprobada',
        rejected: '❌ Rechazada'
    };
    
    container.innerHTML = myContribs.map(c => `
        <div style="background: var(--color-bg-dark); padding: 1.5rem; border-radius: 12px; border-left: 4px solid ${statusColors[c.status]}; margin-bottom: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 1rem;">
                <div>
                    <div style="font-weight: 600; color: var(--color-text-primary); margin-bottom: 0.5rem;">${c.description}</div>
                    <div style="font-size: 0.85rem; color: var(--color-text-secondary);">${c.period}</div>
                </div>
                <span style="padding: 0.4rem 0.8rem; background: ${statusColors[c.status]}; color: white; border-radius: 8px; font-size: 0.75rem; font-weight: 600;">
                    ${statusLabels[c.status]}
                </span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--color-border);">
                <div>
                    <div style="font-size: 0.75rem; color: var(--color-text-secondary);">Valor</div>
                    <div style="font-weight: 600; color: var(--color-text-primary);">${c.reference_value} ${c.currency}</div>
                </div>
                <div>
                    <div style="font-size: 0.75rem; color: var(--color-text-secondary);">Factor</div>
                    <div style="font-weight: 600; color: var(--color-text-primary);">${c.factor_proposed}</div>
                </div>
                <div>
                    <div style="font-size: 0.75rem; color: var(--color-text-secondary);">LBWM Estimados</div>
                    <div style="font-weight: 700; color: var(--color-gold); font-size: 1.1rem;">${c.lbwm_estimated}</div>
                </div>
            </div>
        </div>
    `).join('');
}

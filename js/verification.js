// ============================================
// IDENTITY VERIFICATION SYSTEM
// ============================================

// Verification levels
const VERIFICATION_LEVELS = {
    NO_VERIFICADO: 'no_verificado',
    VERIFICADO_BASICO: 'verificado_basico',
    IDENTIDAD_REAL: 'identidad_real'
};

// Merit limits by verification level
const MERIT_LIMITS = {
    no_verificado: {
        posts: { max: 0, merits: 0 },
        offers: { max: 0, merits: 0 },
        votes: { max: 0, merits: 0 },
        proposals: { max: 0, merits: 0 },
        seniority: false
    },
    verificado_basico: {
        posts: { max: 5, merits: 10 },
        offers: { max: 5, merits: 15 },
        votes: { max: 10, merits: 5 },
        proposals: { max: 3, merits: 25 },
        seniority: false
    },
    identidad_real: {
        posts: { max: 5, merits: 10 },
        offers: { max: 5, merits: 15 },
        votes: { max: 10, merits: 5 },
        proposals: { max: 3, merits: 25 },
        seniority: true // 1 LBWM per day
    }
};

let userVerification = {
    level: VERIFICATION_LEVELS.NO_VERIFICADO,
    method: null,
    verifiedAt: null,
    verifiedBy: null,
    limits: {
        posts_count: 0,
        offers_count: 0,
        votes_count: 0,
        proposals_count: 0
    },
    invitationsLeft: 5
};

// Initialize verification status
async function loadVerificationStatus() {
    try {
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        
        // Get user data from Supabase
        const { data, error } = await supabaseClient
            .from('users')
            .select('verification_level, verification_method, verified_at, verified_by, merit_limits, invitation_count, max_invitations')
            .eq('public_key', pubKey)
            .single();
        
        if (!error && data) {
            userVerification.level = data.verification_level || VERIFICATION_LEVELS.NO_VERIFICADO;
            userVerification.method = data.verification_method;
            userVerification.verifiedAt = data.verified_at;
            userVerification.verifiedBy = data.verified_by;
            userVerification.limits = data.merit_limits || {
                posts_count: 0,
                offers_count: 0,
                votes_count: 0,
                proposals_count: 0
            };
            userVerification.invitationsLeft = (data.max_invitations || 5) - (data.invitation_count || 0);
        }
        
        updateVerificationUI();
        
    } catch (err) {
        console.error('Error loading verification status:', err);
    }
}

// Update verification UI
function updateVerificationUI() {
    // Hide all status cards
    document.getElementById('statusNoVerificado').style.display = 'none';
    document.getElementById('statusVerificadoBasico').style.display = 'none';
    document.getElementById('statusIdentidadReal').style.display = 'none';
    
    // Show appropriate status card
    if (userVerification.level === VERIFICATION_LEVELS.NO_VERIFICADO) {
        document.getElementById('statusNoVerificado').style.display = 'block';
    } else if (userVerification.level === VERIFICATION_LEVELS.VERIFICADO_BASICO) {
        document.getElementById('statusVerificadoBasico').style.display = 'block';
        updateLimitsDisplay();
    } else if (userVerification.level === VERIFICATION_LEVELS.IDENTIDAD_REAL) {
        document.getElementById('statusIdentidadReal').style.display = 'block';
        updateRealIdentityDisplay();
    }
}

// Update limits display
function updateLimitsDisplay() {
    const limits = MERIT_LIMITS[userVerification.level];
    const current = userVerification.limits;
    
    document.getElementById('limitPosts').textContent = limits.posts.max - current.posts_count;
    document.getElementById('limitOffers').textContent = limits.offers.max - current.offers_count;
    document.getElementById('limitVotes').textContent = limits.votes.max - current.votes_count;
    document.getElementById('limitProposals').textContent = limits.proposals.max - current.proposals_count;
}

// Update real identity display
function updateRealIdentityDisplay() {
    const methodNames = {
        'invitation': 'Invitación',
        'video': 'Video Verificación',
        'stake': 'Stake de LBWM'
    };
    
    document.getElementById('verifiedMethod').textContent = methodNames[userVerification.method] || userVerification.method || '-';
    
    if (userVerification.verifiedAt) {
        const date = new Date(userVerification.verifiedAt);
        document.getElementById('verifiedDate').textContent = date.toLocaleDateString('es-ES');
    }
    
    document.getElementById('invitationsLeft').textContent = userVerification.invitationsLeft;
    updateLimitsDisplay();
}

// Show verification options modal
function showVerificationOptions() {
    document.getElementById('verificationOptionsModal').style.display = 'flex';
    document.getElementById('verificationOptionsModal').classList.add('active');
}

// Close verification options
function closeVerificationOptions() {
    document.getElementById('verificationOptionsModal').style.display = 'none';
    document.getElementById('verificationOptionsModal').classList.remove('active');
}

// Select verification method
function selectVerificationMethod(method) {
    closeVerificationOptions();
    
    if (method === 'invitation') {
        showRequestInvitation();
    } else if (method === 'video') {
        showVideoVerification();
    } else if (method === 'stake') {
        showStakeVerification();
    }
}

// Show request invitation modal
function showRequestInvitation() {
    document.getElementById('requestInvitationModal').style.display = 'flex';
    document.getElementById('requestInvitationModal').classList.add('active');
}

// Close request invitation
function closeRequestInvitation() {
    document.getElementById('requestInvitationModal').style.display = 'none';
    document.getElementById('requestInvitationModal').classList.remove('active');
}

// Accept invitation
async function acceptInvitation() {
    try {
        const code = document.getElementById('invitationCode').value.trim();
        
        if (!code) {
            showNotification('Por favor ingresa un código de invitación', 'error');
            return;
        }
        
        if (!code.startsWith('INV-')) {
            showNotification('Código de invitación inválido', 'error');
            return;
        }
        
        showNotification('Verificando invitación...');
        
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        
        // Update user verification level
        const { error } = await supabaseClient
            .from('users')
            .update({
                verification_level: VERIFICATION_LEVELS.VERIFICADO_BASICO,
                verification_method: 'invitation',
                verified_at: new Date().toISOString()
            })
            .eq('public_key', pubKey);
        
        if (error) {
            throw error;
        }
        
        userVerification.level = VERIFICATION_LEVELS.VERIFICADO_BASICO;
        userVerification.method = 'invitation';
        userVerification.verifiedAt = new Date().toISOString();
        
        showNotification('✅ ¡Invitación aceptada! Ahora eres Verificado Básico', 'success');
        closeRequestInvitation();
        updateVerificationUI();
        
    } catch (err) {
        console.error('Error accepting invitation:', err);
        showNotification('Error al aceptar invitación', 'error');
    }
}

// Show video verification modal
function showVideoVerification() {
    document.getElementById('videoVerificationModal').style.display = 'flex';
    document.getElementById('videoVerificationModal').classList.add('active');
}

// Close video verification
function closeVideoVerification() {
    document.getElementById('videoVerificationModal').style.display = 'none';
    document.getElementById('videoVerificationModal').classList.remove('active');
}

// Submit video verification
async function submitVideoVerification() {
    try {
        const videoUrl = document.getElementById('videoUrl').value.trim();
        const description = document.getElementById('videoDescription').value.trim();
        
        if (!videoUrl) {
            showNotification('Por favor ingresa la URL del video', 'error');
            return;
        }
        
        if (!description) {
            showNotification('Por favor describe tu presentación', 'error');
            return;
        }
        
        showNotification('Enviando solicitud...');
        
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        
        // Create verification request
        const { error } = await supabaseClient
            .from('verification_requests')
            .insert({
                id: generateUUID(),
                user_public_key: pubKey,
                user_name: currentUser.name,
                request_type: 'video',
                video_url: videoUrl,
                video_description: description,
                status: 'pending',
                approvals_needed: 3
            });
        
        if (error) {
            throw error;
        }
        
        showNotification('✅ Solicitud enviada. Será revisada por la comunidad', 'success');
        closeVideoVerification();
        
    } catch (err) {
        console.error('Error submitting video verification:', err);
        showNotification('Error al enviar solicitud', 'error');
    }
}

// Show stake verification modal
function showStakeVerification() {
    const modal = document.getElementById('stakeVerificationModal');
    modal.style.display = 'flex';
    modal.classList.add('active');
    
    const currentMerits = parseInt(document.getElementById('userTotalMerits').textContent) || 0;
    document.getElementById('userBalanceForStake').textContent = currentMerits + ' LBWM';
    
    const stakeBtn = document.getElementById('stakeBtn');
    const insufficientMsg = document.getElementById('insufficientBalance');
    
    if (currentMerits < 100) {
        stakeBtn.disabled = true;
        stakeBtn.style.opacity = '0.5';
        insufficientMsg.style.display = 'block';
    } else {
        stakeBtn.disabled = false;
        stakeBtn.style.opacity = '1';
        insufficientMsg.style.display = 'none';
    }
}

// Close stake verification
function closeStakeVerification() {
    document.getElementById('stakeVerificationModal').style.display = 'none';
    document.getElementById('stakeVerificationModal').classList.remove('active');
}

// Submit stake verification
async function submitStakeVerification() {
    try {
        const currentMerits = parseInt(document.getElementById('userTotalMerits').textContent) || 0;
        
        if (currentMerits < 100) {
            showNotification('Balance insuficiente', 'error');
            return;
        }
        
        if (!confirm('¿Bloquear 100 LBWM como stake? Si haces spam o fraude, perderás el stake.')) {
            return;
        }
        
        showNotification('Procesando stake...');
        
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        
        const { error } = await supabaseClient
            .from('users')
            .update({
                verification_level: VERIFICATION_LEVELS.IDENTIDAD_REAL,
                verification_method: 'stake',
                verified_at: new Date().toISOString(),
                staked_lbwm: 100
            })
            .eq('public_key', pubKey);
        
        if (error) {
            throw error;
        }
        
        userVerification.level = VERIFICATION_LEVELS.IDENTIDAD_REAL;
        userVerification.method = 'stake';
        userVerification.verifiedAt = new Date().toISOString();
        
        showNotification('✅ ¡Stake realizado! Ahora eres Identidad Real Confirmada', 'success');
        closeStakeVerification();
        updateVerificationUI();
        loadMeritsData();
        
    } catch (err) {
        console.error('Error submitting stake:', err);
        showNotification('Error al procesar stake', 'error');
    }
}

// Show upgrade to real identity
function showUpgradeToReal() {
    showVerificationOptions();
}

// Show invite friend modal
function showInviteFriend() {
    if (userVerification.invitationsLeft <= 0) {
        showNotification('No tienes invitaciones disponibles', 'error');
        return;
    }
    
    const code = 'INV-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    
    const message = `Tu código de invitación:\n\n${code}\n\nCompártelo con un amigo para invitarlo a LiberBit World.\n\nTe quedan ${userVerification.invitationsLeft} invitaciones.`;
    
    if (confirm(message + '\n\n¿Copiar al portapapeles?')) {
        navigator.clipboard.writeText(code);
        showNotification('✅ Código copiado al portapapeles', 'success');
    }
}

// Check if user can earn merits for action
function canEarnMerits(actionType) {
    const level = userVerification.level;
    const limits = MERIT_LIMITS[level];
    const current = userVerification.limits;
    
    if (level === VERIFICATION_LEVELS.NO_VERIFICADO) {
        return {
            allowed: false,
            message: '⚠️ Debes verificar tu identidad para ganar méritos'
        };
    }
    
    const typeMap = {
        'post': 'posts',
        'offer': 'offers',
        'vote': 'votes',
        'proposal': 'proposals'
    };
    
    const limitKey = typeMap[actionType];
    const currentCount = current[limitKey + '_count'];
    const maxCount = limits[limitKey].max;
    
    if (currentCount >= maxCount) {
        return {
            allowed: false,
            message: `Has alcanzado el límite de ${maxCount} ${actionType}s con méritos`
        };
    }
    
    return {
        allowed: true,
        remaining: maxCount - currentCount,
        merits: limits[limitKey].merits
    };
}

// Increment merit counter after action
async function incrementMeritCounter(actionType) {
    const typeMap = {
        'post': 'posts',
        'offer': 'offers',
        'vote': 'votes',
        'proposal': 'proposals'
    };
    
    const limitKey = typeMap[actionType] + '_count';
    userVerification.limits[limitKey]++;
    
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    await supabaseClient
        .from('users')
        .update({
            merit_limits: userVerification.limits
        })
        .eq('public_key', pubKey);
    
    updateVerificationUI();
}

// Update openSubApp to load verification
const originalOpenSubApp = openSubApp;
openSubApp = function(subAppName) {
    originalOpenSubApp(subAppName);
    if (subAppName === 'merits') {
        loadVerificationStatus();
    }
};

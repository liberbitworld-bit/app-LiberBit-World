// Profile Functions
// Wrapped in IIFE to avoid const collision with merits.js (GAUGE_THRESH, GAUGE_RANGES)
(function() {

// ============================================
// LBWM v2.0 Citizenship Scale (auto-calculated)
// ============================================
function getCitizenshipLevel(merits) {
    if (merits >= 3000) return { level: 6, title: 'Gobernador', icon: '👑', bloc: 'Gobernanza' };
    if (merits >= 2000) return { level: 5, title: 'Embajador', icon: '🌍', bloc: 'Ciudadanía' };
    if (merits >= 1000) return { level: 4, title: 'Ciudadano Senior', icon: '🛂', bloc: 'Ciudadanía' };
    if (merits >= 500)  return { level: 3, title: 'Colaborador', icon: '🤝', bloc: 'Comunidad' };
    if (merits >= 100)  return { level: 2, title: 'E-Residency', icon: '🪪', bloc: 'Comunidad' };
    return { level: 1, title: 'Amigo', icon: '👋', bloc: 'Comunidad' };
}

// ============================================
// [v2.0] Unified merit calculation
// Nostr formal contributions + capped activity
// ============================================
function getUnifiedMerits() {
    // Source 1: Nostr kind 31002/31003 events
    let nostrMerits = 0;
    let nostrBreakdown = {};
    if (typeof LBW_Merits !== 'undefined' && typeof LBW_Nostr !== 'undefined' && LBW_Nostr.isLoggedIn()) {
        const myData = LBW_Merits.getMyMerits();
        if (myData) {
            nostrMerits = myData.total || 0;
            nostrBreakdown = myData.byCategory || {};
        }
    }

    // Source 2: Activity (legacy)
    const userPosts = (typeof allPosts !== 'undefined' && Array.isArray(allPosts) && currentUser)
        ? allPosts.filter(p => p.author === currentUser.name).length : 0;
    const userOffers = (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.getMyOffersCount)
        ? LBW_NostrBridge.getMyOffersCount() : 0;
    const govStats = (typeof LBW_Governance !== 'undefined') ? LBW_Governance.getStats() : { myVotes: 0, myProposals: 0 };
    const userVotes = govStats.myVotes || 0;
    const userProposals = govStats.myProposals || 0;
    const activityCount = userPosts + userOffers + userVotes + userProposals;

    // [v2.0] Sum + cap (NOT max)
    const ACTIVITY_MERIT_CAP = 300;
    const activityMeritsRaw = activityCount * 10;
    const activityMerits = Math.min(activityMeritsRaw, ACTIVITY_MERIT_CAP);
    const totalMerits = nostrMerits + activityMerits;

    return {
        total: totalMerits,
        nostrMerits,
        activityMerits,
        activityMeritsRaw,
        activityCap: ACTIVITY_MERIT_CAP,
        byCategory: nostrBreakdown,
        activity: { posts: userPosts, offers: userOffers, votes: userVotes, proposals: userProposals },
        activityCount,
        source: nostrMerits > 0 ? 'nostr+activity' : 'activity',
        isGovernor: totalMerits >= 3000
    };
}

// ============================================
// Citizenship Gauge Visualization (Canvas)
// ============================================
const GAUGE_SEGS = [
    { label:'Amigo',            shortLabel:'Amigo',    icon:'👋', color:'#4CAF50', bloc:'Comunidad',  min:0 },
    { label:'E-Residency',      shortLabel:'E-Res.',   icon:'🪪', color:'#8BC34A', bloc:'Comunidad',  min:100 },
    { label:'Colaborador',      shortLabel:'Colabor.',  icon:'🤝', color:'#CDDC39', bloc:'Comunidad',  min:500 },
    { label:'Ciudadano Senior', shortLabel:'C.Senior', icon:'🛂', color:'#FF9800', bloc:'Ciudadanía', min:1000 },
    { label:'Embajador',        shortLabel:'Embajad.', icon:'🌍', color:'#FF5722', bloc:'Ciudadanía', min:2000 },
    { label:'Gobernador',       shortLabel:'Gobern.',  icon:'👑', color:'#9C27B0', bloc:'Gobernanza', min:3000 },
];
const GAUGE_THRESH = GAUGE_SEGS.map(s=>s.min);
const GAUGE_RANGES = [100,400,500,1000,1000,500];
const GAUGE_N = GAUGE_SEGS.length;
const GAUGE_SEG_ANG = Math.PI / GAUGE_N;
const GAUGE_GAP = 0.02;
let gaugeNeedleAngle = Math.PI;
let gaugeTargetAngle = Math.PI;
let gaugeCurrentMerits = 0;
let gaugeAnimFrame;

function gaugeGetLevel(m) {
    for (let i=GAUGE_N-1; i>=0; i--) if (m >= GAUGE_SEGS[i].min) return {...GAUGE_SEGS[i], idx:i};
    return {...GAUGE_SEGS[0], idx:0};
}

function gaugeMeritsToAngle(m) {
    if (m >= 3000) {
        const extra = Math.min(m-3000, GAUGE_RANGES[5]);
        return Math.PI - 5*GAUGE_SEG_ANG - (extra/GAUGE_RANGES[5])*GAUGE_SEG_ANG;
    }
    for (let i=0; i<5; i++) {
        if (m < GAUGE_THRESH[i+1]) {
            const p = (m - GAUGE_THRESH[i]) / GAUGE_RANGES[i];
            return Math.PI - i*GAUGE_SEG_ANG - p*GAUGE_SEG_ANG;
        }
    }
    return 0;
}

function drawGaugeCanvas(merits, needleAng) {
    const canvas = document.getElementById('gaugeCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const CX = W/2, CY = H - 30, R = 220, BAND = 40;
    const level = gaugeGetLevel(merits);
    ctx.clearRect(0, 0, W, H);
    for (let i=0; i<GAUGE_N; i++) {
        const aStart = Math.PI - i*GAUGE_SEG_ANG - GAUGE_GAP;
        const aEnd = Math.PI - (i+1)*GAUGE_SEG_ANG + GAUGE_GAP;
        const isActive = i <= level.idx, isCurrent = i === level.idx;
        ctx.beginPath(); ctx.arc(CX, CY, R, -aStart, -aEnd, false);
        ctx.lineWidth = BAND; ctx.strokeStyle = GAUGE_SEGS[i].color;
        ctx.globalAlpha = isActive ? (isCurrent ? 0.85 : 0.55) : 0.15;
        ctx.lineCap = 'butt'; ctx.stroke();
        if (isCurrent) {
            ctx.beginPath(); ctx.arc(CX, CY, R, -aStart, -aEnd, false);
            ctx.lineWidth = BAND + 15; ctx.strokeStyle = GAUGE_SEGS[i].color;
            ctx.globalAlpha = 0.15; ctx.stroke();
        }
        ctx.globalAlpha = 1;
        const midAng = (aStart + aEnd) / 2;
        const lx = CX + (R + BAND/2 + 18) * Math.cos(midAng);
        const ly = CY - (R + BAND/2 + 18) * Math.sin(midAng);
        ctx.save(); ctx.translate(lx, ly);
        let rot = -midAng + Math.PI/2;
        if (rot > Math.PI/2) rot -= Math.PI;
        if (rot < -Math.PI/2) rot += Math.PI;
        ctx.rotate(rot); ctx.font = '600 14px Poppins';
        ctx.fillStyle = GAUGE_SEGS[i].color;
        ctx.globalAlpha = isActive ? 0.9 : 0.5;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(GAUGE_SEGS[i].shortLabel, 0, 0);
        ctx.restore(); ctx.globalAlpha = 1;
        if (i > 0) {
            const tickAng = Math.PI - i*GAUGE_SEG_ANG;
            ctx.beginPath();
            ctx.moveTo(CX+(R-BAND/2-5)*Math.cos(tickAng), CY-(R-BAND/2-5)*Math.sin(tickAng));
            ctx.lineTo(CX+(R+BAND/2+5)*Math.cos(tickAng), CY-(R+BAND/2+5)*Math.sin(tickAng));
            ctx.strokeStyle='rgba(255,255,255,0.2)'; ctx.lineWidth=1.5; ctx.stroke();
        }
        const numAng = Math.PI - i*GAUGE_SEG_ANG;
        ctx.font = '400 11px JetBrains Mono'; ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(GAUGE_THRESH[i] >= 1000 ? (GAUGE_THRESH[i]/1000)+'K' : GAUGE_THRESH[i].toString(),
            CX+(R-BAND/2-20)*Math.cos(numAng), CY-(R-BAND/2-20)*Math.sin(numAng));
    }
    ctx.font='400 11px JetBrains Mono'; ctx.fillStyle='rgba(255,255,255,0.3)'; ctx.textAlign='center';
    ctx.fillText('3K+', CX+(R-BAND/2-20), CY);
    const tipX=CX+(R-15)*Math.cos(needleAng), tipY=CY-(R-15)*Math.sin(needleAng);
    const bOX=5*Math.cos(needleAng+Math.PI/2), bOY=5*Math.sin(needleAng+Math.PI/2);
    ctx.beginPath(); ctx.moveTo(tipX,tipY); ctx.lineTo(CX+bOX,CY-bOY); ctx.lineTo(CX-bOX,CY+bOY); ctx.closePath();
    ctx.fillStyle='rgba(229,185,92,0.3)'; ctx.shadowColor='#E5B95C'; ctx.shadowBlur=15; ctx.fill(); ctx.shadowBlur=0;
    ctx.beginPath(); ctx.moveTo(tipX,tipY); ctx.lineTo(CX+bOX,CY-bOY); ctx.lineTo(CX-bOX,CY+bOY); ctx.closePath();
    ctx.fillStyle='#E5B95C'; ctx.fill();
    ctx.beginPath(); ctx.arc(CX,CY,16,0,Math.PI*2);
    const hg=ctx.createRadialGradient(CX,CY-4,2,CX,CY,16); hg.addColorStop(0,'#2a4a56'); hg.addColorStop(1,'#0D171E');
    ctx.fillStyle=hg; ctx.fill(); ctx.strokeStyle='#E5B95C'; ctx.lineWidth=2.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(CX,CY,6,0,Math.PI*2); ctx.fillStyle='#E5B95C'; ctx.fill();
    ctx.beginPath(); ctx.arc(CX,CY-2,2.5,0,Math.PI*2); ctx.fillStyle='rgba(255,255,255,0.5)'; ctx.fill();
}

function gaugeAnimate() {
    const diff = gaugeTargetAngle - gaugeNeedleAngle;
    if (Math.abs(diff) > 0.002) {
        gaugeNeedleAngle += diff * 0.08;
        drawGaugeCanvas(gaugeCurrentMerits, gaugeNeedleAngle);
        gaugeAnimFrame = requestAnimationFrame(gaugeAnimate);
    } else {
        gaugeNeedleAngle = gaugeTargetAngle;
        drawGaugeCanvas(gaugeCurrentMerits, gaugeNeedleAngle);
    }
}

function updateCitizenshipGauge(merits) {
    gaugeCurrentMerits = merits;
    const level = gaugeGetLevel(merits);
    gaugeTargetAngle = gaugeMeritsToAngle(merits);
    if (gaugeAnimFrame) cancelAnimationFrame(gaugeAnimFrame);
    gaugeAnimate();
    const glow = document.getElementById('gaugeGlow');
    if (glow) glow.style.background = level.color;
    const mVal = document.getElementById('gaugeMeritCount');
    if (mVal) mVal.textContent = merits.toLocaleString('es-ES');
    const bIcon = document.getElementById('gaugeLevelIcon');
    const bTitle = document.getElementById('gaugeLevelTitle');
    const badge = document.getElementById('gaugeLevelBadge');
    if (bIcon) bIcon.textContent = level.icon;
    if (bTitle) bTitle.textContent = level.label.toUpperCase();
    if (badge) { badge.style.borderColor=level.color; badge.style.color=level.color; badge.style.background=level.color+'18'; }
    const bloc = document.getElementById('gaugeLevelBloc');
    if (bloc) bloc.textContent = 'Bloque: ' + level.bloc;
    const pBar = document.getElementById('gaugeProgressBar');
    const pPct = document.getElementById('gaugeProgressPct');
    const pLbl = document.getElementById('gaugeProgressLabel');
    const nw = document.getElementById('gaugeNextWrap');
    const nIcon = document.getElementById('gaugeNextIcon');
    const nTitle = document.getElementById('gaugeNextTitle');
    const nNum = document.getElementById('gaugeNextNumber');
    const nRemainText = document.getElementById('gaugeNextRemainText');
    const nRemaining = document.getElementById('gaugeNextRemaining');
    if (level.idx >= 5) {
        if (pBar) { pBar.style.width='100%'; pBar.style.background='linear-gradient(90deg,'+level.color+','+level.color+'aa)'; }
        if (pPct) pPct.textContent = '✅ MAX';
        if (pLbl) pLbl.textContent = 'Nivel máximo alcanzado';
        if (nIcon) nIcon.textContent = '👑';
        if (nTitle) { nTitle.textContent = '¡NIVEL MÁXIMO!'; nTitle.style.color = level.color; }
        if (nNum) { nNum.textContent = '✅'; nNum.style.color = level.color; }
        if (nw) { nw.style.borderColor = level.color + '60'; nw.style.background = 'linear-gradient(135deg,'+level.color+'18,'+level.color+'0a)'; }
        if (nRemaining) nRemaining.innerHTML = '<strong style="color:'+level.color+'">¡Felicidades!</strong> Has alcanzado el máximo';
    } else {
        const curMin = GAUGE_THRESH[level.idx], nxtMin = GAUGE_THRESH[level.idx+1];
        const range = nxtMin - curMin;
        const pct = Math.min(100, Math.round((merits - curMin) / range * 100));
        const rem = nxtMin - merits;
        const nl = gaugeGetLevel(nxtMin);
        if (pBar) { pBar.style.width=pct+'%'; pBar.style.background='linear-gradient(90deg,'+level.color+','+nl.color+')'; }
        if (pPct) pPct.textContent = pct+'%';
        if (pLbl) pLbl.textContent = 'Progreso a ' + nl.label;
        if (nIcon) nIcon.textContent = nl.icon;
        if (nTitle) { nTitle.textContent = nl.label.toUpperCase(); nTitle.style.color = nl.color; }
        if (nNum) { nNum.textContent = rem.toLocaleString('es-ES'); nNum.style.color = nl.color; }
        if (nw) { nw.style.borderColor = nl.color + '50'; nw.style.background = 'linear-gradient(135deg,'+nl.color+'15,'+nl.color+'08)'; }
        if (nRemaining) nRemaining.innerHTML = 'Faltan <strong style="color:'+nl.color+'">'+rem.toLocaleString('es-ES')+'</strong> méritos';
    }
}


function initializeUserProfile() {
    if (!currentUser) return;
    
    // Initialize profile if not exists
    if (!userProfile) {
        userProfile = {
            citizenshipType: 'Amigo',
            city: '',
            registrationDate: new Date().toISOString()
        };
        localStorage.setItem('userProfile_' + (currentUser.pubkey || currentUser.publicKey), JSON.stringify(userProfile));
    }
}

async function loadUserProfile() {
    if (!currentUser) return;
    
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    
    // Reset avatar to default before loading
    const profileAvatarEl = document.getElementById('profileAvatar');
    if (profileAvatarEl) {
        profileAvatarEl.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Crect fill='%232C5F6F' width='120' height='120'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='48' fill='%23E5B95C'%3E👤%3C/text%3E%3C/svg%3E";
    }
    
    try {
        // Load from Supabase first
        const { data, error } = await supabaseClient
            .from('users')
            .select('citizenship_type, city, registration_date, avatar_url')
            .eq('public_key', pubKey)
            .single();
        
        if (data) {
            userProfile = {
                citizenshipType: data.citizenship_type || 'Amigo',
                city: data.city || '',
                registrationDate: data.registration_date || new Date().toISOString(),
                avatarUrl: data.avatar_url || null
            };
            
            // Update avatar if exists
            if (data.avatar_url) {
                document.getElementById('profileAvatar').src = data.avatar_url;
            }
            
            // Save to localStorage as cache
            localStorage.setItem('userProfile_' + pubKey, JSON.stringify(userProfile));
        } else {
            // Fallback to localStorage
            const saved = localStorage.getItem('userProfile_' + pubKey);
            if (saved) {
                userProfile = JSON.parse(saved);
                if (userProfile.avatarUrl) {
                    document.getElementById('profileAvatar').src = userProfile.avatarUrl;
                }
            } else {
                initializeUserProfile();
            }
        }
    } catch (err) {
        console.error('Error loading profile:', err);
        // Fallback to localStorage
        const saved = localStorage.getItem('userProfile_' + pubKey);
        if (saved) {
            userProfile = JSON.parse(saved);
            if (userProfile.avatarUrl) {
                document.getElementById('profileAvatar').src = userProfile.avatarUrl;
            }
        } else {
            initializeUserProfile();
        }
    }
    
    updateProfileDisplay();
    
    // Re-update after a delay to catch late-loaded posts/offers/votes data
    setTimeout(() => updateProfileDisplay(), 2000);
    setTimeout(() => updateProfileDisplay(), 5000);
}

function updateProfileDisplay() {
    if (!currentUser || !userProfile) return;
    
    // Update profile header
    document.getElementById('profileName').textContent = currentUser.name;
    
    // Calculate merits for citizenship level
    // [v2.0] Unified merits: Nostr + min(activity, 300)
    const meritData = getUnifiedMerits();
    const merits = meritData.total;
    const totalContributions = meritData.activityCount;
    
    // Auto-calculate citizenship level based on merits (LBWM v2.0)
    const citizenship = getCitizenshipLevel(merits);
    
    console.log(`🏛️ Profile: ${totalContributions} contributions, ${merits} merits → ${citizenship.title}`);
    console.log(`🏛️ Source: ${meritData.source} | Nostr: ${meritData.nostrMerits} | Activity: ${meritData.activityMerits}/${meritData.activityCap}`);
    
    // Update citizenship gauge visualization
    updateCitizenshipGauge(merits);
    
    // FORCE update citizenship badge (override any DB value)
    const citizenshipBadge = document.getElementById('profileCitizenship');
    if (citizenshipBadge) {
        citizenshipBadge.textContent = `${citizenship.icon} ${citizenship.title}`;
    }

    // [v2.0] Governor badge + Founder indicator
    const govBadge = document.getElementById('profileGovernorBadge');
    if (govBadge) {
        if (meritData.isGovernor) {
            const isFounder = (typeof LBW_Merits !== 'undefined' && LBW_Merits.hasFoundationalMerits)
                ? LBW_Merits.hasFoundationalMerits() : false;
            govBadge.style.display = 'inline-flex';
            govBadge.innerHTML = isFounder
                ? '🏗️ Fundador · 👑 Gobernador · <span style="font-size:0.75rem;opacity:0.7;">Verificador activo</span>'
                : '👑 Gobernador · <span style="font-size:0.75rem;opacity:0.7;">Verificador activo</span>';
        } else {
            govBadge.style.display = 'none';
        }
    }

    // [v2.0] Merit source breakdown
    const meritSourceEl = document.getElementById('profileMeritSource');
    if (meritSourceEl) {
        meritSourceEl.innerHTML = `
            <span style="color:var(--color-gold);">⚡ Nostr: ${meritData.nostrMerits}</span>
            <span style="opacity:0.5;"> + </span>
            <span style="color:var(--color-teal);">📊 Actividad: ${meritData.activityMerits}${meritData.activityMeritsRaw > meritData.activityCap ? ' (cap ' + meritData.activityCap + ')' : ''}</span>
            <span style="opacity:0.5;"> = </span>
            <span style="color:var(--color-gold);font-weight:700;">${merits} LBWM</span>
        `;
    }

    // [v2.0] Quick access: Governor → verifications
    const govQuickAccess = document.getElementById('profileGovQuickAccess');
    if (govQuickAccess) {
        if (meritData.isGovernor) {
            govQuickAccess.style.display = 'block';
            govQuickAccess.innerHTML = `
                <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
                    <button class="btn btn-primary btn-sm" onclick="showSection('meritsSection');switchLbwmTab('bloques-voto');" style="font-size:0.8rem;">
                        🗳️ Bloques de Voto
                    </button>
                    <button class="btn btn-primary btn-sm" onclick="showSection('meritsSection');switchLbwmTab('mis-aportaciones');" style="font-size:0.8rem;">
                        💰 Verificar Aportaciones
                    </button>
                </div>
            `;
        } else {
            govQuickAccess.style.display = 'none';
        }
    }
    
    // Update citizenship type in profile (auto-calculated, not editable)
    userProfile.citizenshipType = citizenship.title;
    
    // Update LBWID
    const pubKey = currentUser.pubkey || currentUser.publicKey;
    if (isNpubFormat(pubKey)) {
        const hexKey = npubToHex(pubKey);
        const shortHex = hexKey ? hexKey.substring(0, 8).toUpperCase() : pubKey.substring(5, 13).toUpperCase();
        document.getElementById('profileId').textContent = `LBWID-${shortHex}`;
        document.getElementById('profileNpub').textContent = pubKey.substring(0, 16) + '...' + pubKey.substring(pubKey.length - 6);
    } else {
        const shortId = pubKey.substring(0, 8).toUpperCase();
        document.getElementById('profileId').textContent = `LBWID-${shortId}`;
        document.getElementById('profileNpub').textContent = pubKey.substring(0, 16) + '...';
    }
    
    // Update stats
    document.getElementById('statMerits').textContent = merits;
    document.getElementById('statContributions').textContent = totalContributions;
    
    // Format member since
    const regDate = new Date(userProfile.registrationDate);
    const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 
                      'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    document.getElementById('statMemberSince').textContent = 
        `${monthNames[regDate.getMonth()]} ${regDate.getFullYear()}`;
    
    // Update citizenship details (auto-calculated)
    document.getElementById('citizenshipType').textContent = `${citizenship.icon} Nv.${citizenship.level} — ${citizenship.title}`;
    document.getElementById('citizenshipCity').textContent = userProfile.city || 'No registrada';
    
    // Update activity counts (from meritData.activity)
    const act = meritData.activity;
    document.getElementById('activityPosts').textContent = act.posts;
    document.getElementById('activityOffers').textContent = act.offers;
    document.getElementById('activityVotes').textContent = act.votes;
    document.getElementById('activityProposals').textContent = act.proposals;

    // [v2.0] Nostr contributions count
    const nostrContribsEl = document.getElementById('activityNostrContribs');
    if (nostrContribsEl) {
        const nostrContribs = (typeof LBW_Merits !== 'undefined') ? LBW_Merits.getMyContributions().length : 0;
        nostrContribsEl.textContent = nostrContribs;
    }
}

// Citizenship modal now only edits City (level is auto-calculated)
function showCitizenshipModal() {
    const modal = document.getElementById('citizenshipModal');
    modal.classList.add('active');
    
    // Pre-fill city
    if (userProfile) {
        const citySelect = document.getElementById('citizenshipCitySelect');
        const options = Array.from(citySelect.options).map(o => o.value);
        
        if (userProfile.city && options.includes(userProfile.city)) {
            citySelect.value = userProfile.city;
        } else if (userProfile.city) {
            citySelect.value = 'custom';
            document.getElementById('customCityGroup').style.display = 'block';
            document.getElementById('customCityInput').value = userProfile.city;
        }
    }
}

function closeCitizenshipModal() {
    const modal = document.getElementById('citizenshipModal');
    modal.classList.remove('active');
    
    // Reset custom city field
    document.getElementById('customCityGroup').style.display = 'none';
    document.getElementById('customCityInput').value = '';
}

function toggleCustomCity() {
    const select = document.getElementById('citizenshipCitySelect');
    const customGroup = document.getElementById('customCityGroup');
    
    if (select.value === 'custom') {
        customGroup.style.display = 'block';
    } else {
        customGroup.style.display = 'none';
    }
}

async function handleAvatarUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
        showNotification('Por favor selecciona una imagen válida', 'error');
        return;
    }

    // Validate file size (max 200KB for base64)
    if (file.size > 200 * 1024) {
        showNotification('La imagen debe ser menor a 200KB. Por favor usa una imagen más pequeña.', 'error');
        return;
    }

    try {
        // Show loading
        showNotification('Subiendo foto...', 'info');

        // Compress and convert to base64
        const base64Image = await compressAndConvertImage(file);

        // Save to Supabase
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        
        // First check if user exists
        const { data: existingUser } = await supabaseClient
            .from('users')
            .select('id')
            .eq('public_key', pubKey)
            .maybeSingle();

        if (!existingUser) {
            // Create user with avatar
            const { data: newUser, error: insertError } = await supabaseClient
                .from('users')
                .insert([{
                    id: generateUUID(),
                    public_key: pubKey,
                    name: currentUser.name,
                    avatar_url: base64Image,
                    citizenship_type: 'Amigo'
                }])
                .select()
                .single();

            if (insertError) {
                console.error('Error creating user:', insertError);
                showNotification('Error al subir foto: ' + insertError.message, 'error');
                return;
            }

            currentUser.id = newUser.id;
            localStorage.setItem('liberbit_keys', JSON.stringify(currentUser));
        } else {
            // Update existing user
            const { error } = await supabaseClient
                .from('users')
                .update({ avatar_url: base64Image })
                .eq('public_key', pubKey);

            if (error) {
                console.error('Error updating avatar:', error);
                showNotification('Error al subir foto: ' + error.message, 'error');
                return;
            }
        }

        // Update UI
        document.getElementById('profileAvatar').src = base64Image;
        // Also update home avatar
        const homeAvatarEl = document.getElementById('homeAvatar');
        if (homeAvatarEl) homeAvatarEl.src = base64Image;
        
        // Save to localStorage as cache
        if (!userProfile) userProfile = {};
        userProfile.avatarUrl = base64Image;
        localStorage.setItem('userProfile_' + pubKey, JSON.stringify(userProfile));

        showNotification('✅ Foto de perfil actualizada');

    } catch (err) {
        console.error('Error:', err);
        showNotification('Error al procesar la imagen', 'error');
    }

    // Clear input
    event.target.value = '';
}

function compressAndConvertImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                // Create canvas
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                // Calculate dimensions (max 300x300)
                let width = img.width;
                let height = img.height;
                const maxSize = 300;

                if (width > height) {
                    if (width > maxSize) {
                        height = (height * maxSize) / width;
                        width = maxSize;
                    }
                } else {
                    if (height > maxSize) {
                        width = (width * maxSize) / height;
                        height = maxSize;
                    }
                }

                canvas.width = width;
                canvas.height = height;

                // Draw and compress
                ctx.drawImage(img, 0, 0, width, height);
                
                // Convert to base64 with quality 0.7
                const base64 = canvas.toDataURL('image/jpeg', 0.7);
                resolve(base64);
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// saveCitizenship now only saves City (citizenship type is auto-calculated)
async function saveCitizenship() {
    const citySelect = document.getElementById('citizenshipCitySelect');
    const customCity = document.getElementById('customCityInput');
    
    if (!citySelect.value) {
        alert('Por favor selecciona una ciudad');
        return;
    }
    
    let city = citySelect.value;
    if (city === 'custom') {
        city = customCity.value.trim();
        if (!city) {
            alert('Por favor escribe el nombre de tu ciudad');
            return;
        }
    }
    
    // [v2.0] Use unified merit calculation
    const meritData = getUnifiedMerits();
    const merits = meritData.total;
    const citizenship = getCitizenshipLevel(merits);
    
    try {
        const pubKey = currentUser.pubkey || currentUser.publicKey;
        
        // First, check if user exists in Supabase
        const { data: existingUser, error: checkError } = await supabaseClient
            .from('users')
            .select('id')
            .eq('public_key', pubKey)
            .maybeSingle();
        
        if (!existingUser) {
            // User doesn't exist, create it first
            const { data: newUser, error: insertError } = await supabaseClient
                .from('users')
                .insert([{
                    id: generateUUID(),
                    public_key: pubKey,
                    name: currentUser.name,
                    citizenship_type: citizenship.title,
                    city: city
                }])
                .select()
                .single();
            
            if (insertError) {
                console.error('Error creating user:', insertError);
                showNotification('Error al crear usuario: ' + insertError.message, 'error');
                return;
            }
            
            currentUser.id = newUser.id;
            localStorage.setItem('liberbit_keys', JSON.stringify(currentUser));
        } else {
            // User exists, update it
            const { data, error } = await supabaseClient
                .from('users')
                .update({
                    citizenship_type: citizenship.title,
                    city: city
                })
                .eq('public_key', pubKey)
                .select()
                .single();

            if (error) {
                console.error('Error updating profile:', error);
                showNotification('Error al actualizar perfil: ' + error.message, 'error');
                return;
            }
        }

        // Update local profile
        userProfile.citizenshipType = citizenship.title;
        userProfile.city = city;
        
        // Also save to localStorage as backup
        localStorage.setItem('userProfile_' + pubKey, JSON.stringify(userProfile));
        
        // Update display
        updateProfileDisplay();
        
        // Close modal
        closeCitizenshipModal();
        
        // Show confirmation
        showNotification('✅ Ciudad actualizada correctamente');
    } catch (err) {
        console.error('Error:', err);
        showNotification('Error al actualizar ciudad', 'error');
    }
}

// Expose functions needed globally (called from index.html onclick, merits.js, ui.js, etc.)
window.getCitizenshipLevel = getCitizenshipLevel;
window.getUnifiedMerits = getUnifiedMerits;
window.updateCitizenshipGauge = updateCitizenshipGauge;
window.initializeUserProfile = initializeUserProfile;
window.loadUserProfile = loadUserProfile;
window.updateProfileDisplay = updateProfileDisplay;
window.showCitizenshipModal = showCitizenshipModal;
window.closeCitizenshipModal = closeCitizenshipModal;
window.toggleCustomCity = toggleCustomCity;
window.handleAvatarUpload = handleAvatarUpload;
window.saveCitizenship = saveCitizenship;
window.drawGaugeCanvas = drawGaugeCanvas;
window.gaugeAnimate = gaugeAnimate;

})(); // End IIFE

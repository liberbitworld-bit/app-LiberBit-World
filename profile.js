// Profile Functions

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
// Citizenship Gauge Visualization
// ============================================
function updateCitizenshipGauge(merits) {
    const citizenship = getCitizenshipLevel(merits);
    
    // The SVG arc goes from angle -90° (left, 0 merits) to +90° (right, 3000+ merits)
    // But the segments are NOT equal width - they represent different merit ranges:
    // Amigo:     0-99     (100 merits)  → small segment
    // E-Res:     100-499  (400 merits)  → medium
    // Colabor:   500-999  (500 merits)  → medium
    // Ciud.Sr:   1000-1999 (1000 merits) → large
    // Embajador: 2000-2999 (1000 merits) → large
    // Gobernador: 3000+   (uncapped)    → small segment
    
    // Each segment gets equal arc space (30° each for 6 segments = 180° total)
    const segmentAngle = 30; // degrees per segment
    const thresholds = [0, 100, 500, 1000, 2000, 3000];
    const ranges =     [100, 400, 500, 1000, 1000, 500]; // last one is visual cap
    
    let angle = -90; // start at left
    
    if (merits >= 3000) {
        // Gobernador - needle at last segment
        const extra = Math.min(merits - 3000, 500);
        angle = -90 + (5 * segmentAngle) + (extra / ranges[5]) * segmentAngle;
    } else {
        // Find which segment we're in
        for (let i = 0; i < 5; i++) {
            if (merits < thresholds[i + 1]) {
                const progressInSegment = (merits - thresholds[i]) / ranges[i];
                angle = -90 + (i * segmentAngle) + (progressInSegment * segmentAngle);
                break;
            }
        }
    }
    
    // Clamp angle
    angle = Math.max(-90, Math.min(90, angle));
    
    const needle = document.getElementById('gaugeNeedle');
    if (needle) {
        needle.setAttribute('transform', `rotate(${angle}, 150, 165)`);
    }
    
    // Update merit count
    const countEl = document.getElementById('gaugeMeritCount');
    if (countEl) {
        countEl.textContent = merits.toLocaleString('es-ES');
    }
    
    // Update level title
    const titleEl = document.getElementById('gaugeLevelTitle');
    if (titleEl) {
        titleEl.textContent = `${citizenship.icon} ${citizenship.title.toUpperCase()}`;
        const colors = ['#4CAF50', '#8BC34A', '#FFC107', '#FF9800', '#FF5722', '#9C27B0'];
        titleEl.style.color = colors[citizenship.level - 1] || 'var(--color-gold)';
    }
    
    // Update bloc
    const blocEl = document.getElementById('gaugeLevelBloc');
    if (blocEl) {
        blocEl.textContent = `Bloque: ${citizenship.bloc}`;
    }
    
    // Progress to next level
    const progressBar = document.getElementById('gaugeProgressBar');
    const progressPct = document.getElementById('gaugeProgressPct');
    const progressLabel = document.getElementById('gaugeProgressLabel');
    const nextLevelEl = document.getElementById('gaugeLevelNext');
    
    if (citizenship.level >= 6) {
        if (progressBar) progressBar.style.width = '100%';
        if (progressPct) progressPct.textContent = '✅ MAX';
        if (progressLabel) progressLabel.textContent = 'Nivel máximo alcanzado';
        if (nextLevelEl) nextLevelEl.textContent = 'Los merits adicionales se registran como histórico';
    } else {
        const currentThreshold = thresholds[citizenship.level - 1];
        const nextThreshold = thresholds[citizenship.level];
        const range = nextThreshold - currentThreshold;
        const progress = merits - currentThreshold;
        const pct = Math.min(100, Math.round((progress / range) * 100));
        const remaining = nextThreshold - merits;
        
        const nextLevel = getCitizenshipLevel(nextThreshold);
        
        if (progressBar) progressBar.style.width = pct + '%';
        if (progressPct) progressPct.textContent = pct + '%';
        if (progressLabel) progressLabel.textContent = `Progreso a ${nextLevel.title}`;
        if (nextLevelEl) nextLevelEl.textContent = `Faltan ${remaining.toLocaleString('es-ES')} merits para ${nextLevel.icon} ${nextLevel.title}`;
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
}

function updateProfileDisplay() {
    if (!currentUser || !userProfile) return;
    
    // Update profile header
    document.getElementById('profileName').textContent = currentUser.name;
    
    // Calculate merits for citizenship level
    const userPosts = allPosts.filter(p => p.author === currentUser.name).length;
    const userOffers = allOffers.filter(o => o.author === currentUser.name).length;
    const userVotes = allVotes.filter(v => v.voter === (currentUser.pubkey || currentUser.publicKey)).length;
    const userProposals = allProposals.filter(p => p.author === currentUser.name).length;
    
    const totalContributions = userPosts + userOffers + userVotes + userProposals;
    const merits = totalContributions * 10; // 10 LBWM por contribución
    
    // Auto-calculate citizenship level based on merits (LBWM v2.0)
    const citizenship = getCitizenshipLevel(merits);
    
    // Update citizenship gauge visualization
    updateCitizenshipGauge(merits);
    
    // Update citizenship badge with auto-calculated level
    const citizenshipBadge = document.getElementById('profileCitizenship');
    citizenshipBadge.textContent = `${citizenship.icon} ${citizenship.title}`;
    
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
    
    // Update activity counts
    document.getElementById('activityPosts').textContent = userPosts;
    document.getElementById('activityOffers').textContent = userOffers;
    document.getElementById('activityVotes').textContent = userVotes;
    document.getElementById('activityProposals').textContent = userProposals;
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
    
    // Auto-calculate citizenship level
    const userPosts = allPosts.filter(p => p.author === currentUser.name).length;
    const userOffers = allOffers.filter(o => o.author === currentUser.name).length;
    const userVotes = allVotes.filter(v => v.voter === (currentUser.pubkey || currentUser.publicKey)).length;
    const userProposals = allProposals.filter(p => p.author === currentUser.name).length;
    const totalContributions = userPosts + userOffers + userVotes + userProposals;
    const merits = totalContributions * 10;
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

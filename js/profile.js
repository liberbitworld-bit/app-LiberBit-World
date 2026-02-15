// Profile Functions
function initializeUserProfile() {
    if (!currentUser) return;
    
    // Initialize profile if not exists
    if (!userProfile) {
        userProfile = {
            citizenshipType: 'E-Residency',
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
                citizenshipType: data.citizenship_type || 'E-Residency',
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
    
    // Update citizenship badge
    const citizenshipBadge = document.getElementById('profileCitizenship');
    const icon = userProfile.citizenshipType === 'E-Residency' ? '🌐' :
                userProfile.citizenshipType === 'Pasaporte LBW' ? '🛂' : '🌍';
    citizenshipBadge.textContent = `${icon} ${userProfile.citizenshipType}`;
    
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
    
    // Calculate stats
    const userPosts = allPosts.filter(p => p.author === currentUser.name).length;
    const userOffers = allOffers.filter(o => o.author === currentUser.name).length;
    const userVotes = allVotes.filter(v => v.voter === (currentUser.pubkey || currentUser.publicKey)).length;
    const userProposals = allProposals.filter(p => p.author === currentUser.name).length;
    
    const totalContributions = userPosts + userOffers + userVotes + userProposals;
    const merits = totalContributions * 10; // 10 LBWM por contribución
    
    // Update stats
    document.getElementById('statMerits').textContent = merits;
    document.getElementById('statContributions').textContent = totalContributions;
    
    // Format member since
    const regDate = new Date(userProfile.registrationDate);
    const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 
                      'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    document.getElementById('statMemberSince').textContent = 
        `${monthNames[regDate.getMonth()]} ${regDate.getFullYear()}`;
    
    // Update citizenship details
    document.getElementById('citizenshipType').textContent = userProfile.citizenshipType;
    document.getElementById('citizenshipCity').textContent = userProfile.city || 'No registrada';
    
    // Update activity counts
    document.getElementById('activityPosts').textContent = userPosts;
    document.getElementById('activityOffers').textContent = userOffers;
    document.getElementById('activityVotes').textContent = userVotes;
    document.getElementById('activityProposals').textContent = userProposals;
}

function showCitizenshipModal() {
    const modal = document.getElementById('citizenshipModal');
    modal.classList.add('active');
    
    // Pre-fill current values
    if (userProfile) {
        document.getElementById('citizenshipTypeSelect').value = userProfile.citizenshipType;
        
        // Check if city is in predefined list
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
                    citizenship_type: 'E-Residency'
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

async function saveCitizenship() {
    const typeSelect = document.getElementById('citizenshipTypeSelect');
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
                    citizenship_type: typeSelect.value,
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
                    citizenship_type: typeSelect.value,
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
        userProfile.citizenshipType = typeSelect.value;
        userProfile.city = city;
        
        // Also save to localStorage as backup
        localStorage.setItem('userProfile_' + pubKey, JSON.stringify(userProfile));
        
        // Update display
        updateProfileDisplay();
        
        // Close modal
        closeCitizenshipModal();
        
        // Show confirmation
        showNotification('✅ Ciudadanía actualizada correctamente');
    } catch (err) {
        console.error('Error:', err);
        showNotification('Error al actualizar ciudadanía', 'error');
    }
}


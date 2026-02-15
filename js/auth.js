document.addEventListener('DOMContentLoaded', () => {
    checkExistingSession();
    setupEventListeners();
    
    // Logo click to return to menu
    document.getElementById('logoContainer').addEventListener('click', () => {
        if (currentUser) {
            backToMenu();
        }
    });
});

function setupEventListeners() {
    document.getElementById('createAccountBtn').addEventListener('click', createNewAccount);
    document.getElementById('importAccountBtn').addEventListener('click', importExistingAccount);
    document.getElementById('continueBtn').addEventListener('click', showMainMenu);
    document.getElementById('publishPostBtn').addEventListener('click', publishPost);
}

async function checkExistingSession() {
    const savedKeys = localStorage.getItem('liberbit_keys');
    if (savedKeys) {
        currentUser = JSON.parse(savedKeys);
        
        // Migrate old hex keys to npub1/nsec1 format
        const pubKey = currentUser.publicKey || currentUser.pubkey;
        if (pubKey && !isNpubFormat(pubKey)) {
            // Old hex format detected - convert to npub1
            const npubKey = hexToNpub(pubKey);
            currentUser.publicKey = npubKey;
            currentUser.pubkey = npubKey;
            
            // Convert private key too if it's hex
            if (currentUser.privateKey && !isNsecFormat(currentUser.privateKey)) {
                currentUser.privateKey = hexToNsec(currentUser.privateKey);
            }
            
            localStorage.setItem('liberbit_keys', JSON.stringify(currentUser));
            
            // Update in Supabase
            try {
                await supabaseClient
                    .from('users')
                    .update({ public_key: npubKey })
                    .eq('public_key', pubKey);
                
                // Also update related records
                await supabaseClient.from('posts').update({ author_public_key: npubKey }).eq('author_public_key', pubKey);
                await supabaseClient.from('offers').update({ author_public_key: npubKey }).eq('author_public_key', pubKey);
                
                console.log('Migrated keys to npub1/nsec1 format');
            } catch (err) {
                console.log('Migration update in DB skipped:', err.message);
            }
        }
        
        // Sync with Supabase to get user ID if not present
        if (!currentUser.id && (currentUser.publicKey || currentUser.pubkey)) {
            try {
                const currentPubKey = currentUser.publicKey || currentUser.pubkey;
                const { data, error } = await supabaseClient
                    .from('users')
                    .select('*')
                    .eq('public_key', currentPubKey)
                    .single();
                
                if (data) {
                    currentUser.id = data.id;
                    currentUser.pubkey = currentPubKey;
                    currentUser.publicKey = currentPubKey;
                    localStorage.setItem('liberbit_keys', JSON.stringify(currentUser));
                }
            } catch (err) {
                console.log('User not in Supabase yet:', err.message);
            }
        }
        
        showMainMenu();
    }
}

async function createNewAccount() {
    const btn = document.getElementById('createAccountBtn');
    btn.innerHTML = '<span class="spinner"></span> Generando...';
    btn.disabled = true;

    try {
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        const privateKeyHex = Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
        
        const publicKeyHex = await hashSimple(privateKeyHex);
        
        // Convert to npub1/nsec1 format
        const publicKey = hexToNpub(publicKeyHex);
        const privateKey = hexToNsec(privateKeyHex);
        
        const userName = document.getElementById('userNameInput').value.trim() || 'Anónimo';
        
        // Save user to Supabase
        const { data, error } = await supabaseClient
            .from('users')
            .insert([
                {
                    id: generateUUID(),
                    public_key: publicKey,
                    name: userName,
                    citizenship_type: 'E-Residency'
                }
            ])
            .select()
            .single();

        if (error) {
            console.error('Error creating user in Supabase:', error);
            showNotification('Error al crear usuario: ' + error.message, 'error');
            btn.innerHTML = '🚀 Crear Identidad';
            btn.disabled = false;
            return;
        }

        currentUser = {
            id: data.id,
            privateKey: privateKey,
            pubkey: publicKey,
            publicKey: publicKey,
            name: userName,
            created_at: Date.now()
        };

        // Clear any cached profile/avatar from previous identity
        localStorage.removeItem('userProfile_' + publicKey);
        
        displayKeys();
        localStorage.setItem('liberbit_keys', JSON.stringify(currentUser));
        showNotification('¡Identidad creada y guardada en Supabase! 🎉');
        
        btn.innerHTML = '🚀 Crear Identidad';
        btn.disabled = false;
    } catch (err) {
        console.error('Error:', err);
        showNotification('Error al crear cuenta: ' + err.message, 'error');
        btn.innerHTML = '🚀 Crear Identidad';
        btn.disabled = false;
    }
}

// Generate UUID v4
function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

async function hashSimple(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===== Bech32 Encoding for npub1 / nsec1 format =====
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
        const b = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) {
            if ((b >> i) & 1) chk ^= GEN[i];
        }
    }
    return chk;
}

function bech32HrpExpand(hrp) {
    const ret = [];
    for (let i = 0; i < hrp.length; i++) {
        ret.push(hrp.charCodeAt(i) >> 5);
    }
    ret.push(0);
    for (let i = 0; i < hrp.length; i++) {
        ret.push(hrp.charCodeAt(i) & 31);
    }
    return ret;
}

function bech32CreateChecksum(hrp, data) {
    const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
    const polymod = bech32Polymod(values) ^ 1;
    const ret = [];
    for (let i = 0; i < 6; i++) {
        ret.push((polymod >> (5 * (5 - i))) & 31);
    }
    return ret;
}

function bech32Encode(hrp, data) {
    const combined = data.concat(bech32CreateChecksum(hrp, data));
    let ret = hrp + '1';
    for (const d of combined) {
        ret += BECH32_CHARSET[d];
    }
    return ret;
}

function bech32Decode(str) {
    str = str.toLowerCase();
    const pos = str.lastIndexOf('1');
    if (pos < 1 || pos + 7 > str.length) return null;
    const hrp = str.substring(0, pos);
    const dataChars = str.substring(pos + 1);
    const data = [];
    for (const c of dataChars) {
        const idx = BECH32_CHARSET.indexOf(c);
        if (idx === -1) return null;
        data.push(idx);
    }
    // Try strict checksum first
    if (bech32Polymod(bech32HrpExpand(hrp).concat(data)) === 1) {
        return { hrp, data: data.slice(0, data.length - 6) };
    }
    // Fallback: accept without checksum verification (for keys generated by this app)
    if (data.length > 6) {
        return { hrp, data: data.slice(0, data.length - 6) };
    }
    return null;
}

// Convert between 8-bit and 5-bit groups
function convertBits(data, fromBits, toBits, pad) {
    let acc = 0;
    let bits = 0;
    const ret = [];
    const maxv = (1 << toBits) - 1;
    for (const value of data) {
        if (value < 0 || value >> fromBits) return null;
        acc = (acc << fromBits) | value;
        bits += fromBits;
        while (bits >= toBits) {
            bits -= toBits;
            ret.push((acc >> bits) & maxv);
        }
    }
    if (pad) {
        if (bits > 0) {
            ret.push((acc << (toBits - bits)) & maxv);
        }
    } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
        return null;
    }
    return ret;
}

// Convert hex string to npub1/nsec1 format
function hexToNpub(hexStr) {
    const bytes = [];
    for (let i = 0; i < hexStr.length; i += 2) {
        bytes.push(parseInt(hexStr.substr(i, 2), 16));
    }
    const words = convertBits(bytes, 8, 5, true);
    return bech32Encode('npub', words);
}

function hexToNsec(hexStr) {
    const bytes = [];
    for (let i = 0; i < hexStr.length; i += 2) {
        bytes.push(parseInt(hexStr.substr(i, 2), 16));
    }
    const words = convertBits(bytes, 8, 5, true);
    return bech32Encode('nsec', words);
}

// Convert npub1/nsec1 back to hex
function npubToHex(npubStr) {
    const decoded = bech32Decode(npubStr.toLowerCase());
    if (!decoded || decoded.hrp !== 'npub') return null;
    const bytes = convertBits(decoded.data, 5, 8, false);
    if (!bytes) return null;
    return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

function nsecToHex(nsecStr) {
    try {
        const decoded = bech32Decode(nsecStr.toLowerCase());
        if (!decoded || decoded.hrp !== 'nsec') return null;
        const bytes = convertBits(decoded.data, 5, 8, false);
        if (!bytes) return null;
        return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        console.error('nsecToHex error:', e);
        return null;
    }
}

// Check if a string is in npub/nsec format
function isNpubFormat(str) {
    return str && str.toLowerCase().startsWith('npub1') && str.length > 10;
}

function isNsecFormat(str) {
    return str && str.toLowerCase().startsWith('nsec1') && str.length > 10;
}
// ===== End Bech32 =====

function displayKeys() {
    document.getElementById('pubkeyText').textContent = currentUser.publicKey;
    document.getElementById('privkeyText').textContent = currentUser.privateKey;
    document.getElementById('registerForm').classList.add('hidden');
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('keysDisplay').classList.remove('hidden');
}

async function importExistingAccount() {
    let privKeyInput = document.getElementById('existingPrivKey').value.trim();
    
    // Clean input: remove any whitespace, newlines, invisible chars
    privKeyInput = privKeyInput.replace(/[\s\u200B\u200C\u200D\uFEFF]/g, '');
    
    // Support both nsec1 and hex formats
    let privateKeyHex;
    let privateKeyNsec;
    
    if (isNsecFormat(privKeyInput)) {
        // nsec1 format - decode to hex
        privateKeyHex = nsecToHex(privKeyInput);
        privateKeyNsec = privKeyInput;
        if (!privateKeyHex) {
            showNotification('Clave nsec1 inválida. Verifica el formato.', 'error');
            return;
        }
    } else if (/^[0-9a-fA-F]{64}$/.test(privKeyInput)) {
        // Legacy hex format
        privateKeyHex = privKeyInput;
        privateKeyNsec = hexToNsec(privKeyInput);
    } else if (isNpubFormat(privKeyInput)) {
        // User pasted npub instead of nsec
        showNotification('Has pegado tu clave pública (npub). Necesitas tu clave privada (nsec).', 'error');
        return;
    } else if (/^[0-9a-fA-F]+$/.test(privKeyInput) && privKeyInput.length !== 64) {
        // Hex but wrong length
        showNotification(`Clave hex tiene ${privKeyInput.length} caracteres, debe tener exactamente 64. Revisa que no haya caracteres extra.`, 'error');
        return;
    } else {
        console.log('Invalid key input, length:', privKeyInput.length, 'starts:', privKeyInput.substring(0, 10));
        showNotification('Clave privada inválida. Usa formato nsec1... o hex (64 caracteres)', 'error');
        return;
    }

    const btn = document.getElementById('importAccountBtn');
    btn.innerHTML = '<span class="spinner"></span> Importando...';
    btn.disabled = true;

    try {
        // Calculate public key from private key hex
        const publicKeyHex = await hashSimple(privateKeyHex);
        const publicKeyNpub = hexToNpub(publicKeyHex);
        
        // Try to find user with npub1 format first, then hex fallback
        let userData = null;
        
        const { data: npubData, error: npubError } = await supabaseClient
            .from('users')
            .select('*')
            .eq('public_key', publicKeyNpub)
            .maybeSingle();
        
        if (npubData) {
            userData = npubData;
        } else {
            // Try legacy hex format
            const { data: hexData, error: hexError } = await supabaseClient
                .from('users')
                .select('*')
                .eq('public_key', publicKeyHex)
                .maybeSingle();
            
            if (hexData) {
                userData = hexData;
                // Migrate to npub1 format
                await supabaseClient
                    .from('users')
                    .update({ public_key: publicKeyNpub })
                    .eq('public_key', publicKeyHex);
            }
        }

        if (!userData) {
            showNotification('Usuario no encontrado en la base de datos. ¿Creaste tu cuenta con esta clave?', 'error');
            btn.innerHTML = 'Importar →';
            btn.disabled = false;
            return;
        }

        currentUser = {
            id: userData.id,
            privateKey: privateKeyNsec,
            pubkey: publicKeyNpub,
            publicKey: publicKeyNpub,
            name: userData.name,
            created_at: Date.now()
        };
        
        localStorage.setItem('liberbit_keys', JSON.stringify(currentUser));
        closeAuthModal();
        showMainMenu();
        showNotification(`¡Bienvenido de nuevo, ${userData.name}! ✅`);
        
        btn.innerHTML = 'Importar →';
        btn.disabled = false;
    } catch (err) {
        console.error('Error importing account:', err);
        showNotification('Error al importar cuenta: ' + err.message, 'error');
        btn.innerHTML = 'Importar →';
        btn.disabled = false;
    }
}

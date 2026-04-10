// ============================================================
// LiberBit World — Nostr Bridge v3.1 (nostr-bridge.js)
// FIX 2026-02-27c: Supabase-first name resolution (not relay-only)
//
// CHANGES v3.0:
//   ✅ Hydrate-from-cache: instant UI from IndexedDB on load
//   ✅ SyncEngine: incremental relay sync with cursors
//   ✅ MediaService: multi-provider upload + fallback URLs
//   ✅ Cache-first profile resolution
//   ✅ Login mode indicator
//   ✅ Feature subscription lifecycle (start/stop per feature)
//
// Load order: nostr-store.js → nostr-sync.js → nostr-media.js
//             → nostr.js → nostr-bridge.js
// ============================================================

const LBW_NostrBridge = (() => {
    'use strict';

    // ── Feed handles ─────────────────────────────────────────
    let _chatFeedId = null;
    let _dmFeedId = null;
    let _marketFeedId = null;
    let _reactionSub = null;
    let _replySub = null;
    let _zapsByEvent = {};
    let _incomingZaps = [];      // zaps ⚡ recibidos en mis mensajes
    let _incomingReplies = [];   // replies a mis mensajes

    // ── Data ─────────────────────────────────────────────────
    let _dmConversations = {};     // pubkey -> [messages]
    let _nameCache = {};           // pubkey -> resolved display name
    let _marketplaceListings = [];
    let _replyToEventId = null;
    let _replyToAuthorPubkey = null;
    let _activeDMPubkey = null;
    let _seenChatIds = new Set();  // dedup chat render
    let _seenMarketIds = new Set();
    let _myChatCount = 0;          // count of my community chat messages

    // ── Init ─────────────────────────────────────────────────
    async function init() {
        // Initialize IndexedDB store
        try {
            await LBW_Store.init();
        } catch (e) {
            console.warn('[Bridge] IndexedDB no disponible, operando sin cache:', e);
        }

        _setupRelayStatusUI();
        _setupNIP07Detection();
        _setupPrivacyModeUI();
        console.log('[Bridge] ✅ v4.0 inicializado (NIP-65 + NIP-44 + cache + sync + media)');
    }

    // ── Relay Status UI ──────────────────────────────────────
    function _setupRelayStatusUI() {
        window.addEventListener('nostr-relay-status', (e) => {
            _updateRelayIndicators(e.detail);
        });
    }

    function _updateRelayIndicators(status) {
        const container = document.getElementById('relayStatusIndicators');
        if (!container) return;

        const sysPriv = LBW_Nostr.SYSTEM_PRIVATE_RELAYS;
        const entries = Object.entries(status);
        const cPriv = entries.filter(([u, s]) => s === 'connected' && sysPriv.includes(u)).length;
        const cUser = entries.filter(([u, s]) => s === 'connected' && !sysPriv.includes(u) && !LBW_Nostr.SYSTEM_PUBLIC_RELAYS.includes(u)).length;
        const cPub = entries.filter(([u, s]) => s === 'connected' && LBW_Nostr.SYSTEM_PUBLIC_RELAYS.includes(u)).length;
        const strict = LBW_Nostr.isPrivacyStrict();

        container.innerHTML = `
            <div style="width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:2px;
                background:${cPriv > 0 ? '#4CAF50' : '#ff4444'};
                box-shadow:0 0 5px ${cPriv > 0 ? 'rgba(76,175,80,0.5)' : 'rgba(255,68,68,0.3)'};"
                title="${cPriv} relays privados"></div>
            ${cUser > 0 ? `<div style="width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:2px;background:#FFD700;box-shadow:0 0 5px rgba(255,215,0,0.4);" title="${cUser} relays NIP-65"></div>` : ''}
            <div style="width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px;
                background:${cPub > 0 ? '#2196F3' : (strict ? '#ff4444' : '#666')};
                box-shadow:0 0 5px ${cPub > 0 ? 'rgba(33,150,243,0.4)' : 'none'};"
                title="${strict ? '🔒 Privacy Strict' : `${cPub} relays públicos`}"></div>
            <span style="font-size:0.65rem;color:var(--color-text-secondary);font-family:var(--font-mono);">${cPriv}🔒${cUser > 0 ? ` ${cUser}👤` : ''} ${strict ? '🚫pub' : `${cPub}🌐`}</span>
        `;

        const relaysEl = document.getElementById('relaysCount');
        if (relaysEl) relaysEl.textContent = cPriv;
        const chatDot = document.getElementById('chatRelayDot');
        if (chatDot) chatDot.style.background = (cPriv + cPub) > 0 ? '#4CAF50' : '#ff4444';
    }

    // ── Login Mode Indicator ─────────────────────────────────
    function _updateLoginModeUI(method) {
        let el = document.getElementById('loginModeIndicator');
        if (!el) {
            const badge = document.getElementById('userBadge');
            if (badge) {
                el = document.createElement('div');
                el.id = 'loginModeIndicator';
                el.style.cssText = 'font-size:0.6rem;padding:0.15rem 0.4rem;border-radius:12px;margin-top:0.2rem;text-align:center;';
                badge.parentNode.insertBefore(el, badge.nextSibling);
            }
        }
        if (!el) return;

        const configs = {
            extension:  { text: '🔌 NIP-07',   bg: 'rgba(142,36,170,0.2)', border: '#CE93D8', color: '#CE93D8' },
            privatekey: { text: '🔑 nsec',      bg: 'rgba(229,185,92,0.15)', border: 'var(--color-gold)', color: 'var(--color-gold)' },
            nsec:       { text: '🔑 nsec',      bg: 'rgba(229,185,92,0.15)', border: 'var(--color-gold)', color: 'var(--color-gold)' },
            created:    { text: '✨ Nueva ID',  bg: 'rgba(76,175,80,0.15)',  border: '#4CAF50', color: '#81C784' }
        };

        const cfg = configs[method];
        if (cfg) {
            el.textContent = cfg.text;
            el.style.cssText += `background:${cfg.bg};border:1px solid ${cfg.border};color:${cfg.color};display:block;`;
        } else {
            el.style.display = 'none';
        }
    }

    // ── NIP-07 Detection ─────────────────────────────────────
    function _setupNIP07Detection() {
        setTimeout(async () => {
            const has = await LBW_Nostr.waitForExtension(2000);
            ['nip07LoginBtn', 'nip07LoginBtn2'].forEach(id => {
                const b = document.getElementById(id);
                if (b) { has ? (b.classList.remove('hidden'), b.style.display = '') : (b.style.display = 'none'); }
            });
            if (has) {
                const info = document.getElementById('nip07Info');
                const miss = document.getElementById('nip07Missing');
                if (info) info.classList.remove('hidden');
                if (miss) miss.style.display = 'none';
            }
        }, 500);
    }

    // ── Privacy Strict Mode UI ───────────────────────────────
    function _setupPrivacyModeUI() {
        // Listen for privacy mode changes
        window.addEventListener('nostr-privacy-mode', (e) => {
            const strict = e.detail.strict;
            // Header badge indicator
            const indicator = document.getElementById('privacyModeIndicator');
            if (indicator) {
                indicator.textContent = strict ? '🔒 Strict' : '🌐 Normal';
                indicator.className = strict
                    ? 'badge badge-sm badge-error' : 'badge badge-sm badge-ghost';
            }
            // Profile DaisyUI toggle checkbox
            const toggle = document.getElementById('privacyStrictToggle');
            if (toggle) toggle.checked = strict;
            // Profile label
            const label = document.getElementById('privacyStrictLabel');
            if (label) label.textContent = strict ? '🔒 Privacy Strict ON' : '🔒 Privacy Strict';
            // Refresh relay indicators
            _updateRelayIndicators(LBW_Nostr.getRelayStatus());
        });

        // Load saved preference
        const saved = localStorage.getItem('lbw_privacy_strict');
        if (saved === 'true') {
            LBW_Nostr.setPrivacyStrict(true);
        }
    }

    function togglePrivacyStrict() {
        const current = LBW_Nostr.isPrivacyStrict();
        const newVal = !current;
        LBW_Nostr.setPrivacyStrict(newVal);
        localStorage.setItem('lbw_privacy_strict', String(newVal));
        // Reconnect with new relay policy
        if (LBW_Nostr.isLoggedIn()) {
            LBW_Nostr.connectToRelays();
        }
        return newVal;
    }

    // ── Auth ─────────────────────────────────────────────────
    async function handleNIP07Login() {
        const btn = document.getElementById('nip07LoginBtn');
        const orig = btn?.innerHTML;
        try {
            if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Conectando...'; }
            const result = await LBW_Nostr.loginWithExtension();
            const session = {
                pubkey: result.pubkeyHex, npub: result.npub,
                name: result.profile?.name || result.profile?.display_name || 'Nostr User',
                method: 'extension', loginTime: Date.now()
            };
            localStorage.setItem('lbw_nostr_session', JSON.stringify(session));
            _applyLoginToUI(session);
            _updateLoginModeUI('extension');
            await _startAllFeeds();
            return result;
        } catch (e) {
            alert('❌ ' + e.message);
            if (btn) { btn.disabled = false; btn.innerHTML = orig; }
            throw e;
        }
    }

    async function handlePrivateKeyLogin(input) {
        const result = LBW_Nostr.loginWithPrivateKey(input);
        const session = {
            pubkey: result.pubkeyHex, npub: result.npub,
            name: '', picture: '', method: 'nsec', loginTime: Date.now()
        };
        // Store nsec in localStorage for persistence across tab close/reopen
        // Also keep in sessionStorage for backward compatibility
        try { 
            localStorage.setItem('lbw_nsec_persist', input);
            sessionStorage.setItem('lbw_nsec_session', input); 
        } catch (e) {}

        // ══ CRITICAL: Reset currentUser COMPLETELY for new login ══
        // This prevents data from previous sessions bleeding into new login
        currentUser = {
            pubkey: result.npub,
            publicKey: result.npub,
            privateKey: input,
            name: '',
            id: null
        };
        
        // Clear old profile cache for this key
        try { localStorage.removeItem('userProfile_' + result.npub); } catch(e) {}

        // ── Resolve name & avatar: Supabase with auto-migration ──
        let foundInSupabase = false;
        try {
            if (typeof supabaseClient !== 'undefined') {
                // Step 1: Try exact match by npub (correct format)
                let { data } = await supabaseClient
                    .from('users')
                    .select('name, id, avatar_url, public_key')
                    .eq('public_key', result.npub)
                    .maybeSingle();
                
                // Step 2: If not found, try by hex format (old format)
                if (!data) {
                    const hexResult = await supabaseClient
                        .from('users')
                        .select('name, id, avatar_url, public_key')
                        .eq('public_key', result.pubkeyHex)
                        .maybeSingle();
                    
                    if (hexResult.data) {
                        data = hexResult.data;
                        const oldHexKey = data.public_key;
                        // Auto-migrate hex to npub format
                        console.log('[Bridge] 🔄 Migrando public_key de hex a npub...');
                        await supabaseClient
                            .from('users')
                            .update({ public_key: result.npub })
                            .eq('id', data.id);
                        // Migrate related tables
                        try {
                            await supabaseClient.from('posts').update({ author_public_key: result.npub }).eq('author_public_key', oldHexKey);
                            await supabaseClient.from('offers').update({ author_public_key: result.npub }).eq('author_public_key', oldHexKey);
                            await supabaseClient.from('post_likes').update({ user_public_key: result.npub }).eq('user_public_key', oldHexKey);
                        } catch (migErr) {
                            console.warn('[Bridge] ⚠️ Migración tablas relacionadas (hex):', migErr.message);
                        }
                        console.log('[Bridge] ✅ public_key migrado a npub');
                    }
                }
                
                // Step 3: If still not found, get name from Nostr relays first
                if (!data) {
                    console.log('[Bridge] 🔍 Usuario no encontrado por npub/hex, buscando en relays...');
                    await new Promise(r => setTimeout(r, 1500));
                    const nostrProfile = await Promise.race([
                        LBW_Sync.resolveProfile(result.pubkeyHex),
                        new Promise(r => setTimeout(() => r(null), 4000))
                    ]);
                    
                    // If we got a name from Nostr, try to find user by name (legacy migration)
                    if (nostrProfile && nostrProfile.name) {
                        const nameToSearch = nostrProfile.name;
                        console.log('[Bridge] 🔍 Buscando por nombre:', nameToSearch);
                        
                        const nameResult = await supabaseClient
                            .from('users')
                            .select('name, id, avatar_url, public_key')
                            .eq('name', nameToSearch);
                        
                        // Only migrate if EXACTLY ONE user found with that name
                        if (nameResult.data && nameResult.data.length === 1) {
                            data = nameResult.data[0];
                            const oldKey = data.public_key;
                            
                            // Update to correct npub
                            console.log('[Bridge] 🔄 Migrando public_key legacy:', oldKey.substring(0,20), '→', result.npub.substring(0,20));
                            await supabaseClient
                                .from('users')
                                .update({ public_key: result.npub })
                                .eq('id', data.id);
                            // Migrate related tables
                            try {
                                await supabaseClient.from('posts').update({ author_public_key: result.npub }).eq('author_public_key', oldKey);
                                await supabaseClient.from('offers').update({ author_public_key: result.npub }).eq('author_public_key', oldKey);
                                await supabaseClient.from('post_likes').update({ user_public_key: result.npub }).eq('user_public_key', oldKey);
                            } catch (migErr) {
                                console.warn('[Bridge] ⚠️ Migración tablas relacionadas (legacy):', migErr.message);
                            }
                            console.log('[Bridge] ✅ public_key legacy migrado correctamente');
                        } else if (nameResult.data && nameResult.data.length > 1) {
                            console.warn('[Bridge] ⚠️ Múltiples usuarios con nombre "' + nameToSearch + '", no se puede migrar automáticamente');
                        }
                        
                        // Use Nostr profile data
                        if (nostrProfile.name) {
                            session.name = nostrProfile.name;
                            currentUser.name = nostrProfile.name;
                        }
                        if (nostrProfile.picture) {
                            session.picture = nostrProfile.picture;
                        }
                    }
                }
                
                // Step 4: If still not found, ask user for their name (manual migration)
                if (!data) {
                    console.log('[Bridge] 🔍 Usuario no encontrado automáticamente, pidiendo nombre...');
                    const userName = prompt(
                        '⚠️ No se encontró tu cuenta automáticamente.\n\n' +
                        'Si ya tenías cuenta en LiberBit World, escribe tu nombre de usuario exacto para vincular tu identidad.\n\n' +
                        'Si eres nuevo, pulsa Cancelar y usa "Crear Identidad" en su lugar.'
                    );
                    
                    if (userName && userName.trim()) {
                        const trimmedName = userName.trim();
                        console.log('[Bridge] 🔍 Buscando por nombre manual:', trimmedName);
                        
                        const nameResult = await supabaseClient
                            .from('users')
                            .select('name, id, avatar_url, public_key')
                            .ilike('name', trimmedName);
                        
                        if (nameResult.data && nameResult.data.length === 1) {
                            data = nameResult.data[0];
                            const oldKey = data.public_key;
                            
                            // Migrate public_key in users table
                            console.log('[Bridge] 🔄 Migrando public_key manual:', oldKey.substring(0,20), '→', result.npub.substring(0,20));
                            await supabaseClient
                                .from('users')
                                .update({ public_key: result.npub })
                                .eq('id', data.id);
                            
                            // Migrate related tables
                            try {
                                await supabaseClient.from('posts').update({ author_public_key: result.npub }).eq('author_public_key', oldKey);
                                await supabaseClient.from('offers').update({ author_public_key: result.npub }).eq('author_public_key', oldKey);
                                await supabaseClient.from('post_likes').update({ user_public_key: result.npub }).eq('user_public_key', oldKey);
                            } catch (migErr) {
                                console.warn('[Bridge] ⚠️ Migración tablas relacionadas:', migErr.message);
                            }
                            
                            console.log('[Bridge] ✅ Migración manual completada para:', trimmedName);
                        } else if (nameResult.data && nameResult.data.length > 1) {
                            alert('⚠️ Hay múltiples usuarios con ese nombre. Contacta al administrador para resolver la migración.');
                        } else {
                            alert('❌ No se encontró ningún usuario con el nombre "' + trimmedName + '".\n\nSi eres nuevo, usa "Crear Identidad".');
                        }
                    }
                }

                // Apply data if found
                if (data) {
                    foundInSupabase = true;
                    if (data.name && !data.name.startsWith('npub1') && !data.name.endsWith('...')) {
                        session.name = data.name;
                        currentUser.name = data.name;
                        console.log('[Bridge] ✅ Nombre desde Supabase:', data.name);
                    }
                    if (data.id) {
                        currentUser.id = data.id;
                    }
                    if (data.avatar_url) {
                        session.picture = data.avatar_url;
                        console.log('[Bridge] ✅ Avatar desde Supabase');
                    }
                }
            }
        } catch(e) {
            console.warn('[Bridge] Supabase lookup failed:', e.message);
        }
        
        // ── Fallback: If still no name/picture, try relays ──
        if (!session.name || !session.picture) {
            try {
                if (!foundInSupabase) {
                    // Only wait if we haven't already fetched from relays above
                    await new Promise(r => setTimeout(r, 1000));
                }
                const p = await Promise.race([
                    LBW_Sync.resolveProfile(result.pubkeyHex),
                    new Promise(r => setTimeout(() => r(null), 3000))
                ]);
                if (p) {
                    if (!session.name) {
                        const resolvedName = p.name || p.display_name || '';
                        if (resolvedName) {
                            session.name = resolvedName;
                            currentUser.name = resolvedName;
                            console.log('[Bridge] ✅ Nombre desde relays:', resolvedName);
                        }
                    }
                    if (!session.picture && p.picture) {
                        session.picture = p.picture;
                        console.log('[Bridge] ✅ Avatar desde relays');
                    }
                }
            } catch(e) {
                console.warn('[Bridge] Relay lookup failed:', e.message);
            }
        }

        // Save synced currentUser to localStorage
        try { localStorage.setItem('liberbit_keys', JSON.stringify(currentUser)); } catch(e) {}

        localStorage.setItem('lbw_nostr_session', JSON.stringify(session));
        _applyLoginToUI(session);
        _updateLoginModeUI('nsec');
        await _startAllFeeds();

        return result;
    }

    async function handleCreateIdentity(name) {
        const result = await LBW_Nostr.createIdentity(name);
        const session = {
            pubkey: result.pubkeyHex, npub: result.npub,
            name, method: 'created', loginTime: Date.now()
        };
        try { 
            localStorage.setItem('lbw_nsec_persist', result.nsec);
            sessionStorage.setItem('lbw_nsec_session', result.nsec); 
        } catch (e) {}
        localStorage.setItem('lbw_nostr_session', JSON.stringify(session));

        // ══ CRITICAL: Set currentUser so the rest of the app can use it ══
        if (typeof currentUser !== 'undefined') {
            currentUser = {
                pubkey: result.npub,
                publicKey: result.npub,
                privateKey: result.nsec,
                name: name,
                id: null
            };
            try { localStorage.setItem('liberbit_keys', JSON.stringify(currentUser)); } catch(e) {}
        }

        // ══ Save new user to Supabase immediately ══
        try {
            if (typeof supabaseClient !== 'undefined' && typeof generateUUID === 'function') {
                // Check first if already exists (avoid duplicate insert error)
                const { data: existing } = await supabaseClient
                    .from('users')
                    .select('id')
                    .eq('public_key', result.npub)
                    .maybeSingle();

                if (!existing) {
                    const newId = generateUUID();
                    const { data: newUser, error: insertError } = await supabaseClient
                        .from('users')
                        .insert([{
                            id: newId,
                            public_key: result.npub,
                            name: name,
                            citizenship_type: 'Amigo',
                            registration_date: new Date().toISOString()
                        }])
                        .select()
                        .single();

                    if (insertError) {
                        console.warn('[Bridge] ⚠️ Supabase insert error (non-fatal):', insertError.message);
                    } else if (newUser) {
                        if (typeof currentUser !== 'undefined' && currentUser) {
                            currentUser.id = newUser.id;
                            try { localStorage.setItem('liberbit_keys', JSON.stringify(currentUser)); } catch(e) {}
                        }
                        console.log('[Bridge] ✅ Nueva identidad guardada en Supabase:', name, result.npub.substring(0, 20));
                    }
                } else {
                    console.log('[Bridge] ℹ️ Usuario ya existe en Supabase, id:', existing.id);
                    if (typeof currentUser !== 'undefined' && currentUser) {
                        currentUser.id = existing.id;
                        try { localStorage.setItem('liberbit_keys', JSON.stringify(currentUser)); } catch(e) {}
                    }
                }
            }
        } catch (e) {
            console.warn('[Bridge] ⚠️ Error guardando en Supabase (non-fatal):', e.message);
        }

        _updateLoginModeUI('created');
        await _startAllFeeds();
        return result;
    }

    function handleLogout() {
        _stopAllFeeds();
        LBW_Nostr.logout();
        _dmConversations = {};
        _marketplaceListings = [];
        _seenChatIds.clear();
        _seenMarketIds.clear();
        _myChatCount = 0;
        _activeDMPubkey = null;
        _incomingZaps = [];
        _incomingReplies = [];
        if (typeof LBW_Governance !== 'undefined') LBW_Governance.reset();
        if (typeof LBW_Merits !== 'undefined') LBW_Merits.reset();
        _updateLoginModeUI(null);
        
        // ══ Clear ALL session data to prevent data bleeding ══
        localStorage.removeItem('lbw_nostr_session');
        localStorage.removeItem('lbw_nsec_persist');
        localStorage.removeItem('liberbit_keys');
        try { sessionStorage.removeItem('lbw_nsec_session'); } catch (e) {}
        
        // Reset currentUser
        if (typeof currentUser !== 'undefined') {
            currentUser = null;
        }
    }

    async function restoreSession() {
        const saved = localStorage.getItem('lbw_nostr_session');
        if (!saved) return false;
        try {
            const s = JSON.parse(saved);
            let sessionRestored = false;
            
            if (s.method === 'extension' || s.method === 'nip07') {
                if (await LBW_Nostr.waitForExtension(3000)) {
                    await LBW_Nostr.loginWithExtension();
                    _applyLoginToUI(s);
                    _updateLoginModeUI('extension');
                    await _startAllFeeds();
                    sessionRestored = true;
                }
            } else if (s.method === 'nsec' || s.method === 'created') {
                // Try sessionStorage first (same tab), then localStorage (persists across tabs)
                let nsec = sessionStorage.getItem('lbw_nsec_session');
                if (!nsec) {
                    nsec = localStorage.getItem('lbw_nsec_persist');
                    if (nsec) {
                        // Re-populate sessionStorage for this tab
                        try { sessionStorage.setItem('lbw_nsec_session', nsec); } catch(e) {}
                        console.log('[Bridge] ✅ nsec recuperada desde localStorage (tab nuevo)');
                    }
                }
                if (nsec) {
                    LBW_Nostr.loginWithPrivateKey(nsec);
                    
                    // ══ CRITICAL: Reset currentUser COMPLETELY with session data ══
                    currentUser = {
                        pubkey: s.npub,
                        publicKey: s.npub,
                        privateKey: nsec,
                        name: (s.name && !s.name.startsWith('npub1') && !s.name.endsWith('...')) ? s.name : '',
                        id: null
                    };
                    try { localStorage.setItem('liberbit_keys', JSON.stringify(currentUser)); } catch(e) {}
                    
                    _applyLoginToUI(s);
                    _updateLoginModeUI('nsec');
                    await _startAllFeeds();
                    console.log('[Bridge] ✅ Sesión nsec restaurada');
                    sessionRestored = true;
                } else {
                    console.warn('[Bridge] Sesión nsec guardada pero clave no disponible. Re-login necesario.');
                    localStorage.removeItem('lbw_nostr_session');
                }
            }
            
            // ── Fix bad names or missing picture: check Supabase first, then relays ──
            if (sessionRestored && s.pubkey) {
                const nameIsBad = !s.name || s.name.startsWith('npub1') || s.name.endsWith('...');
                const needsPicture = !s.picture;
                
                if (nameIsBad || needsPicture) {
                    console.log('[Bridge] Datos faltantes, buscando...');
                    let resolvedName = '';
                    let resolvedPicture = '';
                    
                    // 1. Try Supabase (primary source of truth)
                    try {
                        if (typeof supabaseClient !== 'undefined') {
                            const npub = s.npub || (typeof hexToNpub === 'function' ? hexToNpub(s.pubkey) : '');
                            if (npub) {
                                const { data } = await supabaseClient
                                    .from('users')
                                    .select('name, avatar_url, id')
                                    .eq('public_key', npub)
                                    .single();
                                if (data) {
                                    if (nameIsBad && data.name && !data.name.startsWith('npub1') && !data.name.endsWith('...')) {
                                        resolvedName = data.name;
                                        console.log('[Bridge] ✅ Nombre desde Supabase:', resolvedName);
                                    }
                                    if (needsPicture && data.avatar_url) {
                                        resolvedPicture = data.avatar_url;
                                        console.log('[Bridge] ✅ Avatar desde Supabase');
                                    }
                                    if (data.id && typeof currentUser !== 'undefined' && currentUser) {
                                        currentUser.id = data.id;
                                    }
                                }
                            }
                        }
                    } catch(e) {}
                    
                    // 2. Fallback: try relays
                    if ((nameIsBad && !resolvedName) || (needsPicture && !resolvedPicture)) {
                        try {
                            const p = await Promise.race([
                                LBW_Sync.resolveProfile(s.pubkey),
                                new Promise(r => setTimeout(() => r(null), 4000))
                            ]);
                            if (p) {
                                if (nameIsBad && !resolvedName) resolvedName = p.name || p.display_name || '';
                                if (needsPicture && !resolvedPicture && p.picture) resolvedPicture = p.picture;
                            }
                        } catch(e) {}
                    }
                    
                    // 3. Apply resolved data
                    let updated = false;
                    if (resolvedName && !resolvedName.startsWith('npub1')) {
                        s.name = resolvedName;
                        _updateDisplayName(resolvedName);
                        if (typeof currentUser !== 'undefined' && currentUser) {
                            currentUser.name = resolvedName;
                            localStorage.setItem('liberbit_keys', JSON.stringify(currentUser));
                        }
                        console.log('[Bridge] ✅ Nombre restaurado:', resolvedName);
                        updated = true;
                    }
                    if (resolvedPicture) {
                        s.picture = resolvedPicture;
                        ['homeAvatar', 'profileAvatar'].forEach(id => {
                            const el = document.getElementById(id);
                            if (el) el.src = resolvedPicture;
                        });
                        console.log('[Bridge] ✅ Avatar restaurado');
                        updated = true;
                    }
                    if (updated) {
                        localStorage.setItem('lbw_nostr_session', JSON.stringify(s));
                    }
                }
            }
            
            return sessionRestored;
        } catch (e) { console.error('[Bridge] ❌ restoreSession error:', e); return false; }
    }

    function _applyLoginToUI(session) {
        const name = session.name || session.npub.substring(0, 16) + '...';
        _updateDisplayName(name);
        ['homeNpub', 'profileNpub'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = session.npub.substring(0, 24) + '...';
        });
        const badge = document.getElementById('userBadge');
        if (badge) {
            badge.classList.remove('hidden');
            const n = document.getElementById('userName');
            if (n) n.textContent = name;
        }
        ['activeNodesCounterHeader', 'identitiesCounterHeader', 'relaysCounterHeader',
         'citiesCounterHeader', 'activeCitiesCounterHeader'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('hidden');
        });
        // Aplicar avatar si existe en la sesión
        if (session.picture) {
            ['homeAvatar', 'profileAvatar'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.src = session.picture;
            });
        }
    }

    function _updateDisplayName(name) {
        if (!name) return;
        ['homeUserName', 'userName', 'profileName'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = name;
        });
        // Persist name in currentUser and liberbit_keys so it survives page reloads
        if (typeof currentUser !== 'undefined' && currentUser) {
            currentUser.name = name;
            try { localStorage.setItem('liberbit_keys', JSON.stringify(currentUser)); } catch(e) {}
        }
    }

    // ── Feature Lifecycle ────────────────────────────────────
    async function _startAllFeeds() {
        try {
            await startCommunityChat();
        } catch (e) { console.error('[Bridge] ❌ Community chat failed:', e); }
        try {
            await startMarketplace();
        } catch (e) { console.error('[Bridge] ❌ Marketplace failed:', e); }

        // ── Esperar a que un private relay esté conectado antes de abrir las
        //    suscripciones a PRIVATE_KINDS (DMs, gobernanza, méritos). Sin esto
        //    se produce una race condition: las subs se abren contra los
        //    fallbacks públicos en los primeros 1-3s del bootstrap y quedan
        //    pinned ahí aunque los privados conecten poco después.
        try {
            const ok = await LBW_Nostr.waitForPrivateRelay(5000);
            if (ok) {
                console.log('[Bridge] ✅ Private relay listo, abriendo subs privadas');
            } else {
                console.warn('[Bridge] ⚠️ Ningún private relay disponible tras 5s, continuando con fallback público');
            }
        } catch (e) { console.error('[Bridge] waitForPrivateRelay error:', e); }

        try {
            await startDirectMessages();
        } catch (e) { console.error('[Bridge] ❌ DMs failed:', e); }
        try {
            await startGovernance();
        } catch (e) { console.error('[Bridge] ❌ Governance failed:', e); }
        try {
            await startMerits();
        } catch (e) { console.error('[Bridge] ❌ Merits failed:', e); }
        console.log('[Bridge] ✅ All feeds started');
    }

    function _stopAllFeeds() {
        stopCommunityChat();
        stopDirectMessages();
        stopMarketplace();
        stopGovernance();
        stopMerits();
    }

    // ── Governance (Nostr) ───────────────────────────────────
    async function startGovernance() {
        if (typeof LBW_Governance === 'undefined') return;
        LBW_Governance.subscribeProposals((proposal, action) => {
            console.log(`[Bridge] 📋 Proposal ${action}: ${proposal.title}`);
            // Auto-refresh UI whenever proposals arrive
            if (typeof displayProposals === 'function') {
                try { updateGovStats(); displayProposals(); } catch (e) {}
            }
        });
        // Ensure governance UI is refreshed once relay delivers initial batch
        // (covers the case where proposals arrive after section was already rendered)
        setTimeout(() => {
            try {
                if (typeof updateGovStats === 'function') updateGovStats();
                if (typeof displayProposals === 'function') displayProposals();
            } catch(e) {}
        }, 4000);
        setTimeout(() => {
            try {
                if (typeof updateGovStats === 'function') updateGovStats();
                if (typeof displayProposals === 'function') displayProposals();
            } catch(e) {}
        }, 9000);
        console.log('[Bridge] ✅ Governance feed started');
    }

    function stopGovernance() {
        if (typeof LBW_Governance !== 'undefined') {
            LBW_Governance.unsubscribeAll();
        }
    }

    // ── Merits LBWM (Nostr) ─────────────────────────────────
    async function startMerits() {
        if (typeof LBW_Merits === 'undefined') return;
        LBW_Merits.subscribeMerits((merit) => {
            console.log(`[Bridge] 🏅 Merit: ${merit.amount} [${merit.category}]`);
        });
        LBW_Merits.subscribeContributions((contrib) => {
            console.log(`[Bridge] 📝 Contribution: ${contrib.meritPoints} LBWM [${contrib.category}]`);
        });
        LBW_Merits.subscribeSnapshots();
        console.log('[Bridge] ✅ Merits feed started');
    }

    function stopMerits() {
        if (typeof LBW_Merits !== 'undefined') {
            LBW_Merits.unsubscribeAll();
        }
    }

    // ── Community Chat (Synced) ──────────────────────────────
    async function startCommunityChat() {
        if (_chatFeedId) LBW_Sync.unsyncFeed(_chatFeedId);
        _seenChatIds.clear();
        _myChatCount = 0;
        _zapsByEvent = {};

        _chatFeedId = await LBW_Sync.syncCommunityChat(
            (msg) => {
                if (_seenChatIds.has(msg.id)) return;
                _seenChatIds.add(msg.id);
                _renderCommunityMessage(msg);
            },
            (cachedEvents) => {
                console.log(`[Bridge] 💬 Chat: ${cachedEvents.length} mensajes desde cache`);
            }
        );

        const myPubkey = LBW_Nostr.getPubkey();

        // ── Suscripción a reacciones ⚡ (todas, filtrar por eventId en callback) ──
        if (_reactionSub) { try { LBW_Nostr.unsubscribe(_reactionSub); } catch(e) {} }
        _reactionSub = LBW_Nostr.subscribe(
            { kinds: [7], limit: 200 },
            event => {
                if (event.content !== '⚡') return;
                const eTag = event.tags.find(t => t[0] === 'e');
                if (!eTag) return;
                const eventId = eTag[1];
                if (!_zapsByEvent[eventId]) _zapsByEvent[eventId] = new Set();
                _zapsByEvent[eventId].add(event.pubkey);
                _updateZapBadge(eventId);

                // Si el zap va dirigido a un mensaje mío, guardar para notificaciones
                const pTag = event.tags.find(t => t[0] === 'p');
                if (pTag && pTag[1] === myPubkey && event.pubkey !== myPubkey) {
                    const alreadyStored = _incomingZaps.some(z => z.id === event.id);
                    if (!alreadyStored) {
                        _incomingZaps.push({
                            id: event.id,
                            pubkey: event.pubkey,
                            eventId,
                            created_at: event.created_at
                        });
                    }
                }
            }
        );

        // ── Suscripción a replies a mis mensajes (kind:1 con #p: [myPubkey]) ──
        if (_replySub) { try { LBW_Nostr.unsubscribe(_replySub); } catch(e) {} }
        if (myPubkey) {
            _replySub = LBW_Nostr.subscribe(
                { kinds: [1], '#p': [myPubkey], '#t': ['liberbit'], limit: 50 },
                event => {
                    if (event.pubkey === myPubkey) return; // ignorar mis propios replies
                    const hasReplyTag = event.tags.some(t => t[0] === 'e');
                    if (!hasReplyTag) return;
                    const alreadyStored = _incomingReplies.some(r => r.id === event.id);
                    if (!alreadyStored) {
                        _incomingReplies.push({
                            id: event.id,
                            pubkey: event.pubkey,
                            content: event.content,
                            created_at: event.created_at
                        });
                    }
                }
            );
        }
    }

    function stopCommunityChat() {
        if (_chatFeedId) { LBW_Sync.unsyncFeed(_chatFeedId); _chatFeedId = null; }
        if (_reactionSub) { try { LBW_Nostr.unsubscribe(_reactionSub); } catch(e) {} _reactionSub = null; }
        if (_replySub)    { try { LBW_Nostr.unsubscribe(_replySub);    } catch(e) {} _replySub = null; }
    }

    function _renderCommunityMessage(msg) {
        const container = document.getElementById('postsList');
        if (!container) return;

        const empty = container.querySelector('.chat-empty-state');
        if (empty) empty.remove();

        // Don't re-add if already in DOM
        if (document.getElementById(`msg-${msg.id}`)) return;

        const isMine = msg.pubkey === LBW_Nostr.getPubkey();
        if (isMine) _myChatCount++;

        _resolveProfileData(msg.pubkey).then(profile => {
            const name = profile.name;
            const el = document.createElement('div');
            el.className = `chat-message ${isMine ? 'chat-message-mine' : 'chat-message-other'}`;
            el.id = `msg-${msg.id}`;

            const time = new Date(msg.created_at * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
            const msgDate = new Date(msg.created_at * 1000);
            const dateStr = msgDate.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
            const dateKey = msgDate.toDateString();
            const src = '';

            let replyHtml = '';
            if (msg.isReply) replyHtml = `<div class="chat-msg-reply-indicator">↩️ Respuesta</div>`;

            el.innerHTML = `
                <div class="chat-msg-header">
                    <div class="chat-msg-author-row">
                        ${_avatarHtml('chat-msg-avatar', name, profile.picture)}
                        <span class="chat-msg-name" style="color:${isMine ? 'var(--color-gold)' : 'var(--color-teal-light)'};">${_esc(name)}</span>
                    </div>
                    <span class="chat-msg-time">${time}</span>
                </div>
                ${replyHtml}
                <div class="chat-msg-body">${typeof LBW_ChatAttach !== 'undefined' ? LBW_ChatAttach.renderContent(msg.content) : _esc(msg.content)}</div>
                <div class="chat-msg-zaps" id="zaps-${msg.id}"></div>
                <div class="chat-msg-actions">
                    <button data-reply-id="${msg.id}" data-reply-name="${_esc(name).replace(/"/g,'&quot;')}" onclick="LBW_NostrBridge.replyToMessage(this.dataset.replyId, this.dataset.replyName)" class="chat-msg-action-btn">↩️ Responder</button>
                    <button data-zap-id="${msg.id}" data-zap-pk="${msg.pubkey}" onclick="LBW_NostrBridge.zapMessage(this.dataset.zapId, this.dataset.zapPk, this)" class="chat-msg-action-btn chat-zap-btn">⚡</button>
                </div>`;

            // Insert sorted DESCENDING (newest first)
            const existing = container.querySelectorAll('.chat-message');
            let inserted = false;
            for (const child of existing) {
                const childTime = parseInt(child.dataset.createdAt || '0', 10);
                if (msg.created_at > childTime) {
                    container.insertBefore(el, child);
                    inserted = true;
                    break;
                }
            }
            if (!inserted) container.appendChild(el);
            el.dataset.createdAt = msg.created_at;
            el.dataset.dateKey = dateKey;
            el.dataset.pubkey = msg.pubkey;

            // Aplicar avatar (funciona para cache hits y nuevos mensajes)
            _injectAvatarImg(el, 'chat-msg-avatar', name, profile.picture);
            // Rebuild date separators after each insert
            _rebuildDateSeparators(container);

            // Auto-scroll to top for new relay messages (newest are at top)
            if (msg._source !== 'cache') {
                const mc = document.getElementById('communityMessages');
                if (mc) mc.scrollTop = 0;
            }
        });
    }

    function _rebuildDateSeparators(container) {
        // Remove all existing separators
        container.querySelectorAll('.chat-date-separator').forEach(s => s.remove());
        // Scan messages in DOM order and insert separator where date changes
        let lastDateKey = null;
        const messages = container.querySelectorAll('.chat-message');
        messages.forEach(msg => {
            const dateKey = msg.dataset.dateKey;
            if (dateKey && dateKey !== lastDateKey) {
                const ts = parseInt(msg.dataset.createdAt || '0', 10);
                if (ts > 0) {
                    const d = new Date(ts * 1000);
                    const dateStr = d.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
                    const sep = document.createElement('div');
                    sep.className = 'chat-date-separator';
                    sep.dataset.dateSep = dateKey;
                    sep.innerHTML = `<span>${dateStr}</span>`;
                    container.insertBefore(sep, msg);
                }
                lastDateKey = dateKey;
            } else {
                lastDateKey = dateKey;
            }
        });
    }

    function replyToMessage(eventId, authorName) {
        _replyToEventId = eventId;
        // Obtener pubkey del autor desde el dataset del elemento del mensaje
        _replyToAuthorPubkey = document.getElementById(`msg-${eventId}`)?.dataset.pubkey || null;
        const preview = document.getElementById('replyPreview');
        const authorEl = document.getElementById('replyToAuthor');
        if (preview) preview.style.display = 'flex';
        if (authorEl) authorEl.textContent = authorName;
        document.getElementById('newPostContent')?.focus();
    }

    function cancelReply() {
        _replyToEventId = null;
        _replyToAuthorPubkey = null;
        const preview = document.getElementById('replyPreview');
        if (preview) preview.style.display = 'none';
    }

    async function publishCommunityPost() {
        const ta = document.getElementById('newPostContent');
        if (!ta) return;
        const content = ta.value.trim();
        if (!content) return;
        const btn = document.getElementById('publishPostBtn');
        if (btn) btn.disabled = true;
        try {
            await LBW_Nostr.publishCommunityMessage(content, _replyToEventId, _replyToAuthorPubkey);
            ta.value = '';
            cancelReply();
        } catch (e) {
            alert('❌ ' + e.message);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ── Direct Messages ──────────────────────────────────────
    async function startDirectMessages() {
        if (_dmFeedId) LBW_Sync.unsyncFeed(_dmFeedId);

        _dmFeedId = await LBW_Sync.syncDirectMessages((msg) => {
            const other = msg.direction === 'incoming' ? msg.from : msg.to;
            if (!_dmConversations[other]) _dmConversations[other] = [];

            // Dedup
            if (_dmConversations[other].some(m => m.id === msg.id)) return;
            _dmConversations[other].push(msg);
            _dmConversations[other].sort((a, b) => a.created_at - b.created_at);

            _updateDMSidebar();
            if (_activeDMPubkey === other) _renderDMMessage(msg);
            _updateDMBadge();
        });

        console.log('[Bridge] 📬 DMs suscritos, conversaciones:', Object.keys(_dmConversations).length);
        // Update DM encryption badge
        _updateDMEncryptionBadge();
    }

    function _updateDMEncryptionBadge() {
        const badge = document.getElementById('dmEncryptionBadge');
        if (!badge) return;
        if (!window.LBW_DM) return;
        const info = LBW_DM.getEncryptionInfo();
        if (info.preferred === 'nip44') {
            badge.textContent = '🔐 NIP-44 activo';
            badge.className = 'badge badge-success badge-xs gap-1';
        } else {
            badge.textContent = '🔒 NIP-04 (NIP-44 no disponible)';
            badge.className = 'badge badge-secondary badge-xs gap-1';
        }
    }

    function stopDirectMessages() {
        if (_dmFeedId) { LBW_Sync.unsyncFeed(_dmFeedId); _dmFeedId = null; }
    }

    function _updateDMSidebar() {
        const sidebar = document.getElementById('chatSidebarList');
        if (!sidebar) return;

        const convos = Object.entries(_dmConversations)
            .map(([pk, msgs]) => ({ pubkey: pk, lastMsg: msgs[msgs.length - 1], count: msgs.length }))
            .sort((a, b) => b.lastMsg.created_at - a.lastMsg.created_at);

        const badge = document.getElementById('badgePrivate');
        if (badge && convos.length > 0) { badge.style.display = 'flex'; badge.textContent = convos.length; }

        sidebar.innerHTML = '';
        convos.forEach(c => {
            _resolveProfileData(c.pubkey).then(profile => {
                const name = profile.name;
                const item = document.createElement('div');
                item.className = 'sidebar-conversation';
                if (_activeDMPubkey === c.pubkey) item.classList.add('active');
                item.onclick = () => openDMConversation(c.pubkey);
                item.dataset.pubkey = c.pubkey;
                const t = new Date(c.lastMsg.created_at * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
                const prev = c.lastMsg.content.substring(0, 40) + (c.lastMsg.content.length > 40 ? '...' : '');
                item.innerHTML = `
                    ${_avatarHtml('sidebar-conv-avatar', name, profile.picture)}
                    <div class="sidebar-conv-info">
                        <div class="sidebar-conv-name">${_esc(name)}</div>
                        <div class="sidebar-conv-preview">🔒 ${_esc(prev)}</div>
                    </div>
                    <span class="sidebar-conv-time">${t}</span>`;
                sidebar.appendChild(item);
                _injectAvatarImg(item, 'sidebar-conv-avatar', name, profile.picture);
            });
        });
    }

    function openDMConversation(pk) {
        _activeDMPubkey = pk;
        const ph = document.getElementById('privatePlaceholder');
        const ac = document.getElementById('privateActiveChat');
        if (ph) ph.style.display = 'none';
        if (ac) {
            ac.style.display = 'flex';
            ac.dataset.activePubkey = pk; // DOM backup
        }
        // Update sidebar active state
        const sidebar = document.getElementById('chatSidebarList');
        if (sidebar) {
            sidebar.querySelectorAll('.sidebar-conversation').forEach(el => {
                el.classList.toggle('active', el.dataset.pubkey === pk);
            });
        }
        _resolveName(pk).then(name => {
            const n = document.getElementById('privateChatName');
            const i = document.getElementById('privateChatId');
            if (n) n.textContent = name;
            if (i) i.textContent = LBW_Nostr.pubkeyToNpub(pk).substring(0, 24) + '...';
        });
        const c = document.getElementById('privateChatMessages');
        if (c) c.innerHTML = '';
        (_dmConversations[pk] || []).forEach(m => _renderDMMessage(m));
        console.log('[Bridge] openDMConversation:', pk.substring(0, 12));
    }

    function _renderDMMessage(msg) {
        const c = document.getElementById('privateChatMessages');
        if (!c) return;
        // Dedup in DOM
        if (msg.id && c.querySelector(`[data-msg-id="${msg.id}"]`)) return;

        const mine = msg.from === LBW_Nostr.getPubkey();
        const t = new Date(msg.created_at * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
        const isNip44 = msg.encryption === 'nip44' || msg.nip44 === true;
        const nipBadge = isNip44 ? 'badge-success' : 'badge-secondary';
        const nipLabel = isNip44 ? '44' : '04';

        // Date separator
        const msgDate = new Date(msg.created_at * 1000);
        const dateKey = msgDate.toDateString();
        const dateStr = msgDate.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
        if (!c.querySelector(`[data-date-sep="${dateKey}"]`)) {
            const sep = document.createElement('div');
            sep.className = 'chat-date-separator';
            sep.dataset.dateSep = dateKey;
            sep.innerHTML = `<span>${dateStr}</span>`;
            c.appendChild(sep);
        }

        const el = document.createElement('div');
        el.className = `chat ${mine ? 'chat-end' : 'chat-start'}`;
        if (msg.id) el.dataset.msgId = msg.id;
        el.innerHTML = `
            <div class="chat-bubble ${mine ? 'chat-bubble-warning' : 'chat-bubble-info'}" style="min-width:60px;">
                <div class="text-sm" style="word-break:break-word;">${typeof LBW_ChatAttach !== 'undefined' ? LBW_ChatAttach.renderContent(msg.content) : _esc(msg.content)}</div>
            </div>
            <div class="chat-footer opacity-50 text-xs flex items-center gap-1 mt-0.5">
                <span class="badge ${nipBadge} gap-0.5" style="font-size:0.55rem; height:14px; min-height:14px; padding:0 4px;" title="NIP-${nipLabel} cifrado">🔐${nipLabel}</span>
                <span>${t}</span>
                ${mine ? '<span>✓</span>' : ''}
            </div>`;
        c.appendChild(el);
        c.scrollTop = c.scrollHeight;
    }

    async function sendDM() {
        // Recover pubkey: closure var → DOM backup → visible header npub
        if (!_activeDMPubkey) {
            const ac = document.getElementById('privateActiveChat');
            if (ac && ac.dataset.activePubkey) {
                _activeDMPubkey = ac.dataset.activePubkey;
            }
        }
        if (!_activeDMPubkey) {
            // Last resort: extract npub from visible chat header
            const idEl = document.getElementById('privateChatId');
            if (idEl) {
                const text = idEl.textContent.trim();
                if (text.startsWith('npub1')) {
                    try {
                        // The displayed npub might be truncated, try to use it
                        // If it's truncated (has ...), we can't use it directly
                        if (!text.includes('...')) {
                            _activeDMPubkey = LBW_Nostr.npubToHex(text);
                        }
                    } catch (e) {}
                }
            }
            // Also check the full npub stored as data attribute
            const nameEl = document.getElementById('privateChatName');
            if (!_activeDMPubkey && nameEl && nameEl.dataset.pubkey) {
                _activeDMPubkey = nameEl.dataset.pubkey;
            }
        }
        if (!_activeDMPubkey) {
            console.warn('[Bridge] sendDM: no _activeDMPubkey');
            alert('⚠️ No hay conversación Nostr activa.\n\nUsa el buscador (🔍) → pega un npub1... → pulsa 💬 para abrir un DM cifrado.');
            return;
        }
        const ta = document.getElementById('dmContent');
        if (!ta) return;
        const content = ta.value.trim();
        if (!content) return;
        try {
            console.log('[Bridge] sendDM →', _activeDMPubkey.substring(0, 12), content.substring(0, 20));
            await LBW_DM.send(_activeDMPubkey, content);
            ta.value = '';
        } catch (e) {
            console.error('[Bridge] sendDM error:', e);
            alert('❌ ' + e.message);
        }
    }

    function startDMWith(npubOrHex) {
        const pk = npubOrHex.startsWith('npub1') ? LBW_Nostr.npubToHex(npubOrHex) : npubOrHex;
        if (typeof showSection === 'function') showSection('chatSection');
        if (typeof switchChatTab === 'function') switchChatTab('private');
        openDMConversation(pk);
    }

    function _updateDMBadge() {
        const n = Object.keys(_dmConversations).length;
        const b1 = document.getElementById('notifCountMessages');
        if (b1) b1.textContent = n;
        const b2 = document.getElementById('badge-chat');
        if (b2 && n > 0) { b2.classList.remove('hidden'); b2.textContent = n; }
    }

    // ── Marketplace (Synced + MediaService) ──────────────────
    async function startMarketplace() {
        if (_marketFeedId) LBW_Sync.unsyncFeed(_marketFeedId);
        _seenMarketIds.clear();
        _marketplaceListings = [];

        _marketFeedId = await LBW_Sync.syncMarketplace(
            (listing) => {
                // Dedup by d-tag or id
                const idx = _marketplaceListings.findIndex(l =>
                    (l.dTag && l.dTag === listing.dTag) || l.id === listing.id
                );
                if (idx >= 0) _marketplaceListings[idx] = listing;
                else _marketplaceListings.push(listing);
                _renderMarketplaceGrid();
            },
            (cached) => {
                console.log(`[Bridge] 🏪 Marketplace: ${cached.length} listings desde cache`);
            }
        );

        // Listen for kind 5 (DELETE) events → remove ghost listings
        LBW_Nostr.onEventKind(5, (event) => {
            const eTags = (event.tags || []).filter(t => t[0] === 'e').map(t => t[1]);
            let changed = false;
            eTags.forEach(deletedId => {
                const idx = _marketplaceListings.findIndex(l => l.id === deletedId && l.pubkey === event.pubkey);
                if (idx >= 0) {
                    _marketplaceListings.splice(idx, 1);
                    changed = true;
                    console.log(`[Bridge] 🗑️ Listing ${deletedId.substring(0, 8)} eliminado por kind 5`);
                }
            });
            if (changed) _renderMarketplaceGrid();
        });

        // [Phase 3] Arrancar módulo de Stalls NIP-15
        if (typeof LBW_Stalls !== 'undefined') {
            LBW_Stalls.start();
            console.log('[Bridge] 🏪 LBW_Stalls (NIP-15) iniciado');
        }
    }

    function stopMarketplace() {
        if (_marketFeedId) { LBW_Sync.unsyncFeed(_marketFeedId); _marketFeedId = null; }
        if (typeof LBW_Stalls !== 'undefined') LBW_Stalls.stop();
    }

    // ── Helpers de precio y estado ────────────────────────────
    function _formatPrice(listing) {
        const price = listing.price;
        if (!price || price === 'A negociar' || price === '0' || price === 0) return 'A negociar';

        const freqTag = (listing.tags || []).find(t => t[0] === 'price-freq');
        const freq = listing.priceFreq || (freqTag ? freqTag[1] : '');

        const currency = listing.currency || 'sats';
        const currDisplay = currency === 'sats' ? '⚡' : currency === 'BTC' ? '₿' : currency;

        return `${price} ${currDisplay}${freq ? ' ' + freq : ''}`;
    }

    function _statusBadge(status) {
        const map = {
            'active':   { label: 'Activo',    color: '#4CAF50', bg: 'rgba(76,175,80,0.15)' },
            'reserved': { label: 'Reservado', color: '#FF9800', bg: 'rgba(255,152,0,0.15)' },
            'sold':     { label: 'Vendido',   color: '#9E9E9E', bg: 'rgba(158,158,158,0.15)' },
            'closed':   { label: 'Cerrado',   color: '#9E9E9E', bg: 'rgba(158,158,158,0.15)' }
        };
        const s = map[status] || map['active'];
        return `<span style="font-size:0.65rem;background:${s.bg};color:${s.color};padding:0.15rem 0.5rem;border-radius:20px;border:1px solid ${s.color};font-weight:600;">${s.label}</span>`;
    }

    function _renderMarketplaceGrid() {
        const grid = document.getElementById('offersGrid');
        if (!grid) return;
        grid.innerHTML = '';

        const active = _marketplaceListings.filter(l => l.status !== 'deleted').sort((a, b) => b.created_at - a.created_at);

        if (active.length === 0) {
            grid.innerHTML = '<div class="placeholder"><h3>🏪 Marketplace Vacío</h3><p>Sé el primero en publicar una oferta</p></div>';
            return;
        }

        const icons = { servicios: '💼', productos: '🛍️', trabajos: '💻', alquileres: '🏠' };

        active.forEach(listing => {
            _resolveName(listing.pubkey).then(name => {
                const card = document.createElement('div');
                card.className = 'offer-card';
                card.dataset.category = listing.category || '';
                card.dataset.title    = listing.title || '';
                card.dataset.desc     = listing.description || '';
                // Collect t-tags for search
                const tTags = (listing.tags || []).filter(t => t[0] === 't').map(t => t[1]).join(' ');
                card.dataset.tags = tTags;
                _registerListing(listing);

                card.style.cssText = 'background:var(--color-bg-card);border:2px solid var(--color-border);border-radius:16px;overflow:hidden;transition:all 0.3s;';

                // IMAGE: use fallback chain from MediaService
                const media = LBW_Media.extractMediaFromTags(listing.tags);
                let imgHtml = '';
                if (media.urls.length > 0) {
                    const imgId = `img-${listing.id.substring(0, 8)}`;
                    // Multi-image indicator badge
                    const countBadge = media.urls.length > 1
                        ? `<div style="position:absolute;top:0.4rem;right:0.4rem;background:rgba(0,0,0,0.65);color:#fff;padding:0.15rem 0.45rem;border-radius:20px;font-size:0.65rem;pointer-events:none;">📷 ${media.urls.length}</div>`
                        : '';
                    imgHtml = `<div id="${imgId}" style="position:relative;width:100%;height:150px;overflow:hidden;">${countBadge}</div>`;
                    setTimeout(() => {
                        const container = document.getElementById(imgId);
                        if (container) {
                            const img = LBW_Media.createFallbackImage(media.urls, {
                                style: 'width:100%;height:150px;object-fit:cover;',
                                alt: listing.title
                            });
                            if (img) container.insertBefore(img, container.firstChild);
                        }
                    }, 0);
                }

                const isMine = listing.pubkey === LBW_Nostr.getPubkey();
                const integrity = media.sha256 ? `<span title="SHA-256: ${media.sha256}" style="font-size:0.6rem;color:#4CAF50;cursor:help;">🔒</span>` : '';
                const priceDisplay = _formatPrice(listing);
                const statusBadge  = _statusBadge(listing.status);

                card.innerHTML = `
                    ${imgHtml}
                    <div style="padding:1rem;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
                            <span style="font-size:1.5rem;">${listing.emoji || icons[listing.category] || '🏪'}</span>
                            <div style="display:flex;gap:0.3rem;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
                                ${integrity}
                                ${statusBadge}
                                <span style="font-size:0.7rem;background:rgba(229,185,92,0.15);color:var(--color-gold);padding:0.2rem 0.6rem;border-radius:20px;border:1px solid rgba(229,185,92,0.3);">${listing.category}</span>
                            </div>
                        </div>
                        <h4 style="color:var(--color-text-primary);font-size:1rem;margin-bottom:0.4rem;">${_esc(listing.title)}</h4>
                        <p style="color:var(--color-text-secondary);font-size:0.8rem;margin-bottom:0.75rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${_esc(listing.description)}</p>
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <span style="font-weight:700;color:var(--color-gold);font-size:0.9rem;">${_esc(priceDisplay)}</span>
                            <span style="font-size:0.7rem;color:var(--color-text-secondary);" id="seller-name-${listing.id.substring(0,8)}">${_esc(name)}</span>
                        </div>
                        <div style="margin-top:0.75rem;display:flex;gap:0.5rem;flex-wrap:wrap;" class="card-actions">
                            ${(!isMine && listing.price && listing.price !== 'A negociar' && !isNaN(parseInt(listing.price)) && listing.status === 'active')
                                ? `<button onclick="LBW_NostrBridge.buyListing('${listing.id}')" style="flex:1;min-width:80px;padding:0.4rem;background:rgba(229,185,92,0.15);border:1px solid var(--color-gold);border-radius:8px;color:var(--color-gold);cursor:pointer;font-size:0.75rem;font-weight:600;">⚡ Comprar</button>`
                                : ''}
                            <button onclick="LBW_NostrBridge.startDMWith('${listing.pubkey}')" style="flex:1;min-width:80px;padding:0.4rem;background:rgba(44,95,111,0.2);border:1px solid var(--color-teal-light);border-radius:8px;color:var(--color-teal-light);cursor:pointer;font-size:0.75rem;">💬 Contactar</button>
                            ${isMine ? `<button onclick="LBW_NostrBridge.deleteListing('${listing.id}')" style="padding:0.4rem 0.6rem;background:rgba(255,68,68,0.15);border:1px solid #ff4444;border-radius:8px;color:#ff4444;cursor:pointer;font-size:0.75rem;">🗑️</button>` : ''}
                        </div>
                    </div>`;

                // Open detail on card click (but not on button clicks)
                card.addEventListener('click', function(e) {
                    if (e.target.tagName === 'BUTTON' || e.target.closest('.card-actions')) return;
                    _showListingDetail(listing, name);
                });

                grid.appendChild(card);

                // [Phase 2] Inject citizenship + reputation badges next to seller name (async, non-blocking)
                if (typeof LBW_Reviews !== 'undefined') {
                    const citizenBadge = LBW_Reviews.getCitizenshipBadgeHtml
                        ? LBW_Reviews.getCitizenshipBadgeHtml(listing.pubkey)
                        : '';
                    const scoreBadgePromise = LBW_Reviews.getScoreBadgeHtml
                        ? LBW_Reviews.getScoreBadgeHtml(listing.pubkey)
                        : Promise.resolve('');
                    scoreBadgePromise.then(scoreBadge => {
                        const badges = [citizenBadge, scoreBadge].filter(Boolean).join(' ');
                        if (!badges) return;
                        const nameEl = card.querySelector(`#seller-name-${listing.id.substring(0,8)}`);
                        if (nameEl) {
                            nameEl.innerHTML = `<span style="display:flex;align-items:center;gap:0.3rem;flex-wrap:wrap;justify-content:flex-end;">${_esc(name)} ${badges}</span>`;
                        }
                    }).catch(() => {});
                }
            });
        });
    }

    // Publish offer using MediaService for images (Phase 1: multiple images)
    async function publishOffer(offerData) {
        let mediaTags = [];

        // Soportar múltiples imágenes (imageFiles) y retrocompat con imageFile singular
        const imageFiles = offerData.imageFiles && offerData.imageFiles.length > 0
            ? offerData.imageFiles
            : (offerData.imageFile ? [offerData.imageFile] : []);

        for (const file of imageFiles.slice(0, 5)) {
            try {
                const media = await LBW_Media.uploadImage(file, {
                    maxProviders: 2,
                    onProgress: (msg) => console.log(`[Bridge] 📸 ${msg}`)
                });
                const tags = LBW_Media.buildImageTags(media);
                mediaTags = mediaTags.concat(tags);
            } catch(e) {
                console.warn('[Bridge] ⚠️ Error subiendo imagen:', e.message);
            }
        }

        const result = await LBW_Nostr.publishMarketplaceListing({
            title:       offerData.title,
            description: offerData.description,
            category:    offerData.category,
            subcategory: offerData.subcategory || '',
            price:       offerData.price,
            priceAmount: offerData.priceAmount || '',
            currency:    offerData.currency || 'sats',
            priceFreq:   offerData.priceFreq || '',
            emoji:       offerData.emoji,
            location:    offerData.location || '',
            status:      offerData.status || 'active',
            expiration:  offerData.expiration || 0,
            mediaTags
        });

        // Inyectar localmente para que aparezca de inmediato
        if (result && result.event) {
            const ev = result.event;
            const listing = {
                id:          ev.id,
                pubkey:      ev.pubkey,
                npub:        LBW_Nostr.pubkeyToNpub(ev.pubkey),
                title:       offerData.title || 'Sin título',
                description: offerData.description || '',
                category:    offerData.category || 'servicios',
                subcategory: offerData.subcategory || '',
                price:       offerData.price || 'A negociar',
                priceAmount: offerData.priceAmount || '',
                currency:    offerData.currency || 'sats',
                priceFreq:   offerData.priceFreq || '',
                emoji:       offerData.emoji || '🏪',
                image:       '',
                images:      [],
                location:    offerData.location || '',
                status:      offerData.status || 'active',
                expiration:  offerData.expiration || 0,
                created_at:  ev.created_at,
                tags:        ev.tags || [],
                dTag:        (ev.tags.find(t => t[0] === 'd') || [])[1] || '',
                _source:     'local'
            };
            const idx = _marketplaceListings.findIndex(l =>
                (l.dTag && l.dTag === listing.dTag) || l.id === listing.id
            );
            if (idx >= 0) _marketplaceListings[idx] = listing;
            else _marketplaceListings.push(listing);
            _renderMarketplaceGrid();
        }

        return result;
    }

    async function deleteListing(eventId) {
        if (!confirm('¿Eliminar esta oferta?')) return;
        try {
            await LBW_Nostr.deleteMarketplaceListing(eventId);
            _marketplaceListings = _marketplaceListings.filter(l => l.id !== eventId);
            _renderMarketplaceGrid();
        } catch (e) { alert('❌ ' + e.message); }
    }

    // Map de listings activos para acceso rápido desde botones (evita serializar en HTML)
    const _listingMap = new Map();

    function _registerListing(listing) {
        _listingMap.set(listing.id, listing);
    }

    function filterMarketplace(cat) {
        document.querySelectorAll('.offer-card:not(.mission-card)').forEach(c => {
            c.style.display = (cat === 'todos' || c.dataset.category === cat) ? '' : 'none';
        });
    }

    async function buyListing(listingId) {
        const listing = _listingMap.get(listingId);
        if (!listing) { showNotification('Oferta no encontrada', 'error'); return; }
        const sellerName = await _resolveName(listing.pubkey);
        if (typeof LBW_MarketPay !== 'undefined') {
            await LBW_MarketPay.resolveAndPay(listing, sellerName);
        } else {
            showNotification('Módulo de pago no cargado', 'error');
        }
    }

    function _showListingDetail(listing, authorName) {
        var media = LBW_Media.extractMediaFromTags(listing.tags);
        var priceDisplay = _formatPrice(listing);
        var statusBadge  = _statusBadge(listing.status);
        var isMine = listing.pubkey === LBW_Nostr.getPubkey();

        // Carrusel de imágenes
        var imageHtml = '';
        if (media.urls.length === 1) {
            imageHtml = '<img src="' + _esc(media.urls[0]) + '" alt="' + _esc(listing.title) + '" style="width:100%;height:250px;object-fit:cover;margin-bottom:1rem;border-radius:12px;" onerror="this.style.display=\'none\'">';
        } else if (media.urls.length > 1) {
            var thumbs = media.urls.map(function(url, i) {
                var borderColor = i === 0 ? 'var(--color-gold)' : 'var(--color-border)';
                return '<img src="' + _esc(url) + '" style="width:60px;height:60px;object-fit:cover;border-radius:8px;cursor:pointer;border:2px solid ' + borderColor + ';" onclick="document.getElementById(\'detail-main-img\').src=this.src;[].forEach.call(this.parentElement.querySelectorAll(\'img\'),function(el){el.style.borderColor=\'var(--color-border)\';});this.style.borderColor=\'var(--color-gold)\';" onerror="this.style.display=\'none\'">';
            }).join('');
            imageHtml =
                '<img id="detail-main-img" src="' + _esc(media.urls[0]) + '" alt="' + _esc(listing.title) + '" style="width:100%;height:250px;object-fit:cover;margin-bottom:0.5rem;border-radius:12px;" onerror="this.style.display=\'none\'">' +
                '<div style="display:flex;gap:0.4rem;margin-bottom:1rem;overflow-x:auto;padding-bottom:0.25rem;">' + thumbs + '</div>';
        }

        // Expiración
        var expirationHtml = '';
        var expTag = (listing.tags || []).find(function(t){ return t[0] === 'expiration'; });
        var expTs  = listing.expiration || (expTag ? parseInt(expTag[1]) : 0);
        if (expTs > 0) {
            var expDate  = new Date(expTs * 1000);
            var daysLeft = Math.ceil((expTs * 1000 - Date.now()) / 86400000);
            expirationHtml = daysLeft > 0
                ? '<div style="font-size:0.75rem;color:var(--color-text-secondary);margin-top:0.5rem;">⏱️ Expira: ' + expDate.toLocaleDateString('es-ES') + ' (' + daysLeft + ' días)</div>'
                : '<div style="font-size:0.75rem;color:#ff4444;margin-top:0.5rem;">⚠️ Oferta expirada</div>';
        }

        var modal = document.createElement('div');
        modal.className = 'modal active';
        modal.innerHTML =
            '<div class="modal-content" style="position:relative;">' +
                '<button class="modal-close" onclick="this.closest(\'.modal\').remove()">×</button>' +
                '<div class="modal-header">' +
                    imageHtml +
                    '<div style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap;margin-top:0.5rem;">' +
                        statusBadge +
                        '<div style="display:inline-block;font-size:0.7rem;background:rgba(229,185,92,0.15);color:var(--color-gold);padding:0.2rem 0.6rem;border-radius:20px;border:1px solid rgba(229,185,92,0.3);">' + _esc(listing.category) + '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="modal-body">' +
                    '<h2 style="color:var(--color-gold);margin-bottom:1rem;">' + _esc(listing.title) + '</h2>' +
                    '<p style="color:var(--color-text-secondary);margin-bottom:1.5rem;line-height:1.6;">' + _esc(listing.description) + '</p>' +
                    '<div style="background:var(--color-bg-dark);padding:1.5rem;border-radius:12px;margin-bottom:1.5rem;">' +
                        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                            '<div>' +
                                '<div style="font-size:0.8rem;color:var(--color-text-secondary);margin-bottom:0.25rem;">Precio</div>' +
                                '<div style="font-size:1.5rem;font-weight:700;color:var(--color-gold);">' + _esc(priceDisplay) + '</div>' +
                            '</div>' +
                            '<div style="text-align:right;">' +
                                '<div style="font-size:0.8rem;color:var(--color-text-secondary);margin-bottom:0.25rem;">Publicado por</div>' +
                                '<div style="font-size:1rem;font-weight:600;color:var(--color-text-primary);">' + _esc(authorName) + '</div>' +
                            '</div>' +
                        '</div>' +
                        expirationHtml +
                    '</div>' +
                    (!isMine ?
                        '<div style="margin-top:1.5rem;text-align:center;">' +
                            '<button class="btn btn-primary" onclick="this.closest(\'.modal\').remove(); LBW_NostrBridge.startDMWith(\'' + listing.pubkey + '\')">💬 Enviar Mensaje Privado</button>' +
                        '</div>'
                    : '') +
                    // Bloque de reseñas (se carga async tras render)
                    '<div style="margin-top:1.5rem;">' +
                        '<h4 style="color:var(--color-gold);font-size:0.9rem;margin-bottom:0.6rem;">⭐ Reseñas del vendedor</h4>' +
                        '<div id="lbwDetailReviews-' + listing.id.substring(0, 8) + '"></div>' +
                    '</div>' +
                '</div>' +
            '</div>';

        document.body.appendChild(modal);
        modal.addEventListener('click', function(e) {
            if (e.target === modal) modal.remove();
        });

        // Cargar reseñas async una vez el modal está en el DOM
        var reviewContainerId = 'lbwDetailReviews-' + listing.id.substring(0, 8);
        if (typeof LBW_Reviews !== 'undefined') {
            LBW_Reviews.renderReviewsBlock(listing.pubkey, reviewContainerId);
        } else {
            var rc = document.getElementById(reviewContainerId);
            if (rc) rc.style.display = 'none';
        }
    }

    // ── Profile Resolution (cache-first via SyncEngine) ──────
    let _profileCache = {};
    let _profilePending = {};

    async function _resolveProfileData(pubkey) {
        if (_profileCache[pubkey]) {
            // Cache hit: still update DOM in case this element was just rendered
            const cached = _profileCache[pubkey];
            if (cached.picture) setTimeout(() => _updateRenderedProfiles(pubkey, cached), 0);
            return cached;
        }
        if (_profilePending[pubkey]) return _profilePending[pubkey];

        _profilePending[pubkey] = (async () => {
            let name = null, picture = null;

            if (pubkey === LBW_Nostr.getPubkey()) {
                const p = LBW_Nostr.getProfile();
                name = p.name || p.display_name || null;
                picture = p.picture || null;
            }
            if (!name || !picture) {
                try {
                    const cached = await LBW_Store.getProfile(pubkey);
                    if (cached) {
                        if (!name) name = cached.name || cached.display_name || null;
                        if (!picture) picture = cached.picture || cached.image || null;
                    }
                } catch(e) {}
            }
            if ((!name || !picture) && typeof supabaseClient !== 'undefined') {
                try {
                    const npub = LBW_Nostr.pubkeyToNpub(pubkey);
                    const { data } = await supabaseClient
                        .from('users').select('name, avatar_url')
                        .eq('public_key', npub).maybeSingle();
                    if (data) {
                        if (!name) name = data.name || null;
                        if (!picture) picture = data.avatar_url || null;
                    }
                } catch(e) {}
            }
            if (!name) {
                try {
                    const profile = await LBW_Nostr.fetchUserProfile(pubkey);
                    if (profile) {
                        name = profile.name || profile.display_name || null;
                        picture = profile.picture || profile.image || null;
                        if (name) LBW_Store.putProfile(pubkey, profile).catch(() => {});
                    }
                } catch(e) {}
            }

            delete _profilePending[pubkey];

            const result = {
                name: name || LBW_Nostr.pubkeyToNpub(pubkey).substring(0, 12) + '...',
                picture: picture || null
            };
            if (name) {
                _profileCache[pubkey] = result;
                _nameCache[pubkey] = name;
            }
            return result;
        })();

        return _profilePending[pubkey];
    }

    async function _resolveName(pubkey) {
        const data = await _resolveProfileData(pubkey);
        return data.name;
    }

    // Siempre devuelve div con inicial — nunca mete src en innerHTML.
    // _injectAvatarImg() aplica la foto DESPUÉS de insertar en el DOM.
    function _avatarHtml(cssClass, name, picture) {
        const clean = (name || '').replace(/[^\p{L}\p{N}]/gu, '');
        const initial = clean.length > 0 ? clean.charAt(0).toUpperCase() : '?';
        return `<div class="${cssClass}">${initial}</div>`;
    }

    // Reemplaza el div avatar por <img> via propiedad DOM (soporta base64 largo)
    function _injectAvatarImg(parentEl, cssClass, name, picture) {
        if (!picture) return;
        const clean = (name || '').replace(/[^\p{L}\p{N}]/gu, '');
        const initial = clean.length > 0 ? clean.charAt(0).toUpperCase() : '?';
        const existing = parentEl.querySelector('.' + cssClass);
        if (!existing || existing.tagName === 'IMG') return;
        const img = document.createElement('img');
        img.className = cssClass;
        img.alt = initial;
        img.onerror = function() {
            const div = document.createElement('div');
            div.className = cssClass;
            div.textContent = initial;
            if (this.parentNode) this.parentNode.replaceChild(div, this);
        };
        existing.parentNode.replaceChild(img, existing);
        img.src = picture; // asignar src como propiedad DOM — nunca via innerHTML
    }

    // Actualiza nombre y avatar en mensajes ya renderizados
    function _updateRenderedProfiles(pubkey, profile) {
        try {
            document.querySelectorAll('.chat-message[data-pubkey="' + pubkey + '"]').forEach(el => {
                const nameEl = el.querySelector('.chat-msg-name');
                if (nameEl) nameEl.textContent = profile.name;
                _injectAvatarImg(el, 'chat-msg-avatar', profile.name, profile.picture);
            });
            document.querySelectorAll('.sidebar-conversation[data-pubkey="' + pubkey + '"]').forEach(el => {
                const nameEl = el.querySelector('.sidebar-conv-name');
                if (nameEl) nameEl.textContent = profile.name;
                _injectAvatarImg(el, 'sidebar-conv-avatar', profile.name, profile.picture);
            });
        } catch(e) {}
    }

    function _esc(s) {
        if (!s) return '';
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    // ── Debug ────────────────────────────────────────────────
    async function getDebugStats() {
        const syncStats = await LBW_Sync.getStats();
        const relays = LBW_Nostr.getRelayStatus();
        return {
            ...syncStats,
            relays,
            dmConversations: Object.keys(_dmConversations).length,
            marketListings: _marketplaceListings.length,
            chatMessages: _seenChatIds.size
        };
    }

    // ── Conversations API (para integración con chat.js) ─────
    function getConversations() {
        // Retorna lista de conversaciones ordenadas por timestamp
        return Object.entries(_dmConversations)
            .map(([pubkey, messages]) => {
                const lastMsg = messages[messages.length - 1];
                return {
                    pubkey,
                    name: _nameCache[pubkey] || lastMsg?._resolvedName || null,
                    lastMessage: lastMsg?.content || '',
                    timestamp: lastMsg?.created_at || 0,
                    messageCount: messages.length,
                    encrypted: true // Todos los DMs Nostr están cifrados
                };
            })
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    function getUnreadDMCount() {
        // Contar mensajes recibidos después del último visto
        const lastSeen = parseInt(localStorage.getItem('lastSeen_private') || '0') / 1000;
        let count = 0;
        const myPubkey = LBW_Nostr.getPubkey();
        
        Object.values(_dmConversations).forEach(messages => {
            messages.forEach(msg => {
                // Solo contar mensajes entrantes (no enviados por mí) después de lastSeen
                if (msg.from !== myPubkey && msg.created_at > lastSeen) {
                    count++;
                }
            });
        });
        
        return count;
    }

    // Re-render marketplace grid on navigation
    function refreshMarketplace() {
        _renderMarketplaceGrid();
    }

    // Count current user's marketplace listings
    function getMyOffersCount() {
        var myPubkey = LBW_Nostr.getPubkey();
        if (!myPubkey) return 0;
        return _marketplaceListings.filter(function(l) {
            return l.pubkey === myPubkey && l.status !== 'deleted';
        }).length;
    }

    function getMyChatCount() {
        return _myChatCount;
    }

    // ── Actualizar badge ⚡ en el mensaje ─────────────────────────────────────
    function _updateZapBadge(eventId) {
        const zappers = _zapsByEvent[eventId];
        const el = document.getElementById(`zaps-${eventId}`);
        if (!el) return;
        const count = zappers ? zappers.size : 0;
        if (count === 0) { el.innerHTML = ''; return; }
        const myPubkey = LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : null;
        const iMine = myPubkey && zappers && zappers.has(myPubkey);
        el.innerHTML = `<span class="chat-zap-badge ${iMine ? 'chat-zap-badge--mine' : ''}">⚡${count > 1 ? ' ' + count : ''}</span>`;
    }

    // ── Zap (⚡ reacción NIP-25 + notificación al autor) ─────────────────────────
    async function zapMessage(eventId, pubkey, btnEl) {
        if (!LBW_Nostr.isLoggedIn()) {
            showNotification('Conéctate con Nostr para enviar un zap ⚡', 'error');
            return;
        }
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.textContent = '⏳';
        }
        try {
            await LBW_Nostr.reactToEvent(eventId, pubkey, '⚡');

            // Actualizar estado local
            const myPubkey = LBW_Nostr.getPubkey();
            if (!_zapsByEvent[eventId]) _zapsByEvent[eventId] = new Set();
            _zapsByEvent[eventId].add(myPubkey);
            _updateZapBadge(eventId);

            if (btnEl) {
                btnEl.textContent = '⚡';
                btnEl.classList.add('chat-zap-btn--sent');
                btnEl.disabled = true;
                btnEl.title = 'Ya zapado ⚡';
            }
            showNotification('⚡ Zap enviado', 'success');
        } catch (err) {
            console.error('[Bridge] Error enviando zap:', err);
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = '⚡'; }
            showNotification('Error al enviar el zap', 'error');
        }
    }

    function getIncomingZaps() { return [..._incomingZaps]; }
    function getIncomingReplies() { return [..._incomingReplies]; }
    function clearIncomingZaps() { _incomingZaps = []; }
    function clearIncomingReplies() { _incomingReplies = []; }

    // ── Public API ───────────────────────────────────────────
    return {
        init,
        handleNIP07Login, handlePrivateKeyLogin, handleCreateIdentity, handleLogout, restoreSession,
        publishCommunityPost, replyToMessage, cancelReply, zapMessage, startCommunityChat, stopCommunityChat,
        sendDM, startDMWith, openDMConversation, startDirectMessages, stopDirectMessages,
        publishOffer, deleteListing, filterMarketplace, buyListing, startMarketplace, stopMarketplace, refreshMarketplace,
        startGovernance, stopGovernance, startMerits, stopMerits,
        togglePrivacyStrict,
        _resolveName, _resolveProfileData, _avatarHtml, _injectAvatarImg, getDebugStats, getMyOffersCount, getMyChatCount,
        resolveName: _resolveName,
        // Nuevos métodos para integración con chat.js
        getConversations, getUnreadDMCount,
        getIncomingZaps, getIncomingReplies, clearIncomingZaps, clearIncomingReplies
    };
})();

window.LBW_NostrBridge = LBW_NostrBridge;

// [Bug 2 fix] Startup module audit: en DOMContentLoaded comprueba que todos
// los providers LBW_X esperados estén cargados. Si falta alguno, lo loguea
// como error claro en lugar de fallar silenciosamente más tarde.
document.addEventListener('DOMContentLoaded', () => {
    const expected = [
        'LBW_Store', 'LBW_Media', 'LBW_ChatAttach', 'LBW_Nostr', 'LBW_DM',
        'LBW_Sync', 'LBW_Governance', 'LBW_Merits', 'LBW_MeritsSync',
        'LBW_Reviews', 'LBW_MarketPay', 'LBW_Stalls', 'LBW_NostrBridge',
        'LBW_Debate', 'LBW_Missions'
    ];
    const missing = expected.filter(name => typeof window[name] === 'undefined');
    if (missing.length) {
        console.error('[Bridge] ❌ Módulos LBW faltantes en window:', missing);
        console.error('[Bridge] Esto suele indicar un orden de carga incorrecto en index.html o un error de parse en el módulo.');
    } else {
        console.log('[Bridge] ✅ Audit OK — los 15 módulos LBW están cargados');
    }

    LBW_NostrBridge.init();
    LBW_NostrBridge.restoreSession();
});

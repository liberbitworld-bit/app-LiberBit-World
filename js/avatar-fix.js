// avatar-fix.js — Parche de avatares para LiberBit World
// Añadir DESPUÉS de nostr-bridge.js en index.html

(function() {
    'use strict';

    // Esperar a que LBW_NostrBridge esté disponible
    function waitForBridge(cb) {
        if (typeof LBW_NostrBridge !== 'undefined' && typeof LBW_Nostr !== 'undefined') {
            cb();
        } else {
            setTimeout(() => waitForBridge(cb), 100);
        }
    }

    // Inyecta un <img> en el elemento padre buscando el div de avatar
    function injectImg(parentEl, cssClass, name, picture) {
        if (!picture) return;
        const clean = (name || '').replace(/\p{Z}|\p{S}|\p{P}/gu, '');
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
        img.src = picture; // asignar src como propiedad DOM tras insertar
    }

    waitForBridge(function() {

        // ── Parchar _resolveProfileData ──────────────────────────────────────
        const _profileCache = {};
        const _profilePending = {};

        LBW_NostrBridge._resolveProfileData = async function(pubkey) {
            if (_profileCache[pubkey]) return _profileCache[pubkey];
            if (_profilePending[pubkey]) return _profilePending[pubkey];

            _profilePending[pubkey] = (async () => {
                let name = null, picture = null;

                // Capa 1: propio usuario
                if (pubkey === LBW_Nostr.getPubkey()) {
                    const p = LBW_Nostr.getProfile();
                    name = p.name || p.display_name || null;
                    picture = p.picture || null;
                }
                // Capa 2: IndexedDB
                if (!name) {
                    try {
                        const cached = await LBW_Store.getProfile(pubkey);
                        if (cached) {
                            name = cached.name || cached.display_name || null;
                            picture = cached.picture || cached.image || null;
                        }
                    } catch(e) {}
                }
                // Capa 3: Supabase users (por npub)
                if (!name && typeof supabaseClient !== 'undefined') {
                    try {
                        const npub = LBW_Nostr.pubkeyToNpub(pubkey);
                        const { data } = await supabaseClient
                            .from('users').select('name, avatar_url')
                            .eq('public_key', npub).maybeSingle();
                        if (data) { name = data.name || null; picture = data.avatar_url || null; }
                    } catch(e) {}
                }
                // Capa 4: relay Nostr
                if (!name) {
                    try {
                        const profile = await LBW_Nostr.fetchUserProfile(pubkey);
                        if (profile) {
                            name = profile.name || profile.display_name || null;
                            picture = profile.picture || profile.image || null;
                        }
                    } catch(e) {}
                }

                delete _profilePending[pubkey];

                if (name) {
                    const result = { name, picture: picture || null };
                    _profileCache[pubkey] = result;
                    // Actualizar elementos ya en DOM
                    _updateDOM(pubkey, result);
                    return result;
                }
                return { name: LBW_Nostr.pubkeyToNpub(pubkey).substring(0, 12) + '...', picture: null };
            })();

            return _profilePending[pubkey];
        };

        // ── Actualizar elementos ya renderizados ─────────────────────────────
        function _updateDOM(pubkey, profile) {
            document.querySelectorAll('.chat-message[data-pubkey="' + pubkey + '"]').forEach(el => {
                const nameEl = el.querySelector('.chat-msg-name');
                if (nameEl) nameEl.textContent = profile.name;
                injectImg(el, 'chat-msg-avatar', profile.name, profile.picture);
            });
            document.querySelectorAll('.sidebar-conversation[data-pubkey="' + pubkey + '"]').forEach(el => {
                const nameEl = el.querySelector('.sidebar-conv-name');
                if (nameEl) nameEl.textContent = profile.name;
                injectImg(el, 'sidebar-conv-avatar', profile.name, profile.picture);
            });
        }

        // ── Parchar _renderCommunityMessage para añadir data-pubkey ──────────
        // Observar el DOM: cuando aparece un mensaje nuevo sin data-pubkey, añadirlo
        const observer = new MutationObserver(mutations => {
            mutations.forEach(m => {
                m.addedNodes.forEach(node => {
                    if (node.nodeType !== 1) return;
                    const msgs = node.classList?.contains('chat-message')
                        ? [node]
                        : [...(node.querySelectorAll?.('.chat-message') || [])];
                    msgs.forEach(async el => {
                        // Extraer pubkey del botón de reply si no está en dataset
                        if (!el.dataset.pubkey) {
                            const btn = el.querySelector('[data-react-pk]');
                            if (btn) el.dataset.pubkey = btn.dataset.reactPk;
                        }
                        if (el.dataset.pubkey) {
                            const profile = await LBW_NostrBridge._resolveProfileData(el.dataset.pubkey);
                            if (profile.picture) {
                                injectImg(el, 'chat-msg-avatar', profile.name, profile.picture);
                            }
                        }
                    });
                });
            });
        });

        const postsList = document.getElementById('postsList');
        if (postsList) {
            observer.observe(postsList, { childList: true, subtree: true });
            console.log('[AvatarFix] ✅ Observer activo en postsList');
        }

        // Aplicar a mensajes ya en DOM al cargar
        setTimeout(async () => {
            const msgs = document.querySelectorAll('.chat-message');
            for (const el of msgs) {
                if (!el.dataset.pubkey) {
                    const btn = el.querySelector('[data-react-pk]');
                    if (btn) el.dataset.pubkey = btn.dataset.reactPk;
                }
                if (el.dataset.pubkey) {
                    const profile = await LBW_NostrBridge._resolveProfileData(el.dataset.pubkey);
                    if (profile.picture) injectImg(el, 'chat-msg-avatar', profile.name, profile.picture);
                }
            }
            console.log('[AvatarFix] ✅ Avatares aplicados a', msgs.length, 'mensajes');
        }, 1500);

        console.log('[AvatarFix] ✅ Parche cargado');
    });
})();

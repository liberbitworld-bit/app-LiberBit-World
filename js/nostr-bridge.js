// ============================================================
// LiberBit World — Nostr Bridge v3.0 (nostr-bridge.js)
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

    // ── Data ─────────────────────────────────────────────────
    let _dmConversations = {};     // pubkey -> [messages]
    let _marketplaceListings = [];
    let _replyToEventId = null;
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
            name: '', method: 'nsec', loginTime: Date.now()
        };
        // Store nsec in sessionStorage (cleared on tab close, secure enough)
        // This enables session restore on page reload within same tab
        try { sessionStorage.setItem('lbw_nsec_session', input); } catch (e) {}
        setTimeout(async () => {
            const p = await LBW_Sync.resolveProfile(result.pubkeyHex);
            if (p) {
                session.name = p.name || p.display_name || '';
                localStorage.setItem('lbw_nostr_session', JSON.stringify(session));
                _updateDisplayName(session.name);
            }
        }, 2500);
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
        try { sessionStorage.setItem('lbw_nsec_session', result.nsec); } catch (e) {}
        localStorage.setItem('lbw_nostr_session', JSON.stringify(session));
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
        if (typeof LBW_Governance !== 'undefined') LBW_Governance.reset();
        if (typeof LBW_Merits !== 'undefined') LBW_Merits.reset();
        _updateLoginModeUI(null);
        localStorage.removeItem('lbw_nostr_session');
        try { sessionStorage.removeItem('lbw_nsec_session'); } catch (e) {}
    }

    async function restoreSession() {
        const saved = localStorage.getItem('lbw_nostr_session');
        if (!saved) return false;
        try {
            const s = JSON.parse(saved);
            if (s.method === 'extension' || s.method === 'nip07') {
                if (await LBW_Nostr.waitForExtension(3000)) {
                    await LBW_Nostr.loginWithExtension();
                    _applyLoginToUI(s);
                    _updateLoginModeUI('extension');
                    await _startAllFeeds();
                    return true;
                }
            } else if (s.method === 'nsec' || s.method === 'created') {
                // Restore nsec from sessionStorage (survives reload, not tab close)
                const nsec = sessionStorage.getItem('lbw_nsec_session');
                if (nsec) {
                    LBW_Nostr.loginWithPrivateKey(nsec);
                    _applyLoginToUI(s);
                    _updateLoginModeUI('nsec');
                    await _startAllFeeds();
                    console.log('[Bridge] ✅ Sesión nsec restaurada');
                    return true;
                } else {
                    console.warn('[Bridge] Sesión nsec guardada pero clave no disponible (tab nuevo). Re-login necesario.');
                    localStorage.removeItem('lbw_nostr_session');
                }
            }
            return false;
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
    }

    function _updateDisplayName(name) {
        ['homeUserName', 'userName', 'profileName'].forEach(id => {
            const el = document.getElementById(id);
            if (el && name) el.textContent = name;
        });
    }

    // ── Feature Lifecycle ────────────────────────────────────
    async function _startAllFeeds() {
        try {
            await startCommunityChat();
        } catch (e) { console.error('[Bridge] ❌ Community chat failed:', e); }
        try {
            await startDirectMessages();
        } catch (e) { console.error('[Bridge] ❌ DMs failed:', e); }
        try {
            await startMarketplace();
        } catch (e) { console.error('[Bridge] ❌ Marketplace failed:', e); }
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
            // Auto-refresh UI if governance section is visible
            if (typeof displayProposals === 'function') {
                try { updateGovStats(); displayProposals(); } catch (e) {}
            }
        });
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

        _chatFeedId = await LBW_Sync.syncCommunityChat(
            (msg) => {
                // Dedup render (cache + relay may overlap)
                if (_seenChatIds.has(msg.id)) return;
                _seenChatIds.add(msg.id);
                _renderCommunityMessage(msg);
            },
            (cachedEvents) => {
                // After cache hydration: log
                console.log(`[Bridge] 💬 Chat: ${cachedEvents.length} mensajes desde cache`);
            }
        );
    }

    function stopCommunityChat() {
        if (_chatFeedId) { LBW_Sync.unsyncFeed(_chatFeedId); _chatFeedId = null; }
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

        _resolveName(msg.pubkey).then(name => {
            const el = document.createElement('div');
            el.className = 'chat-message';
            el.id = `msg-${msg.id}`;
            el.style.cssText = `padding:0.75rem 1rem;margin-bottom:0.5rem;border-radius:12px;
                background:${isMine ? 'rgba(229,185,92,0.08)' : 'rgba(44,95,111,0.08)'};
                border:1px solid ${isMine ? 'rgba(229,185,92,0.15)' : 'rgba(44,95,111,0.15)'};`;

            const time = new Date(msg.created_at * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
            const date = new Date(msg.created_at * 1000).toLocaleDateString('es', { day: 'numeric', month: 'short' });
            const src = msg._source === 'cache' ? '💾' : '📡';

            let replyHtml = '';
            if (msg.isReply) replyHtml = `<div style="font-size:0.75rem;color:var(--color-text-secondary);margin-bottom:0.4rem;padding-left:0.5rem;border-left:2px solid var(--color-gold);">↩️ Respuesta</div>`;

            el.innerHTML = `
                ${replyHtml}
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3rem;">
                    <span style="font-weight:600;font-size:0.85rem;color:${isMine ? 'var(--color-gold)' : 'var(--color-teal-light)'};">${_esc(name)}</span>
                    <span style="font-size:0.7rem;color:var(--color-text-secondary);">${src} ${date} ${time}</span>
                </div>
                <div style="font-size:0.9rem;color:var(--color-text-primary);line-height:1.5;word-break:break-word;">${_esc(msg.content)}</div>
                <div style="display:flex;gap:0.75rem;margin-top:0.4rem;">
                    <button data-reply-id="${msg.id}" data-reply-name="${_esc(name).replace(/"/g,'&quot;')}" onclick="LBW_NostrBridge.replyToMessage(this.dataset.replyId, this.dataset.replyName)" style="background:none;border:none;color:var(--color-text-secondary);cursor:pointer;font-size:0.75rem;padding:0;">↩️ Responder</button>
                    <button data-react-id="${msg.id}" data-react-pk="${msg.pubkey}" onclick="LBW_Nostr.reactToEvent(this.dataset.reactId, this.dataset.reactPk,'🤙')" style="background:none;border:none;color:var(--color-text-secondary);cursor:pointer;font-size:0.75rem;padding:0;">🤙 Zap</button>
                </div>`;

            // Insert sorted by created_at
            const existing = container.querySelectorAll('.chat-message');
            let inserted = false;
            for (const child of existing) {
                const childTime = parseInt(child.dataset.createdAt || '0', 10);
                if (msg.created_at < childTime) {
                    container.insertBefore(el, child);
                    inserted = true;
                    break;
                }
            }
            if (!inserted) container.appendChild(el);
            el.dataset.createdAt = msg.created_at;

            // Auto-scroll only for relay events (not cache hydration)
            if (msg._source !== 'cache') {
                const mc = document.getElementById('communityMessages');
                if (mc) mc.scrollTop = mc.scrollHeight;
            }
        });
    }

    function replyToMessage(eventId, authorName) {
        _replyToEventId = eventId;
        const preview = document.getElementById('replyPreview');
        const authorEl = document.getElementById('replyToAuthor');
        if (preview) preview.style.display = 'flex';
        if (authorEl) authorEl.textContent = authorName;
        document.getElementById('newPostContent')?.focus();
    }

    function cancelReply() {
        _replyToEventId = null;
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
            await LBW_Nostr.publishCommunityMessage(content, _replyToEventId);
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
            _resolveName(c.pubkey).then(name => {
                const item = document.createElement('div');
                item.style.cssText = 'padding:0.75rem;border-bottom:1px solid var(--color-border);cursor:pointer;transition:background 0.2s;';
                item.onmouseover = () => { item.style.background = 'rgba(229,185,92,0.08)'; };
                item.onmouseout = () => { item.style.background = ''; };
                item.onclick = () => openDMConversation(c.pubkey);
                const t = new Date(c.lastMsg.created_at * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
                const prev = c.lastMsg.content.substring(0, 40) + (c.lastMsg.content.length > 40 ? '...' : '');
                item.innerHTML = `
                    <div style="display:flex;justify-content:space-between;margin-bottom:0.2rem;">
                        <span style="font-weight:600;font-size:0.85rem;color:var(--color-text-primary);">${_esc(name)}</span>
                        <span style="font-size:0.65rem;color:var(--color-text-secondary);">${t}</span>
                    </div>
                    <div style="font-size:0.75rem;color:var(--color-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🔒 ${_esc(prev)}</div>`;
                sidebar.appendChild(item);
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
        const mine = msg.from === LBW_Nostr.getPubkey();
        const t = new Date(msg.created_at * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
        const isNip44 = msg.encryption === 'nip44' || msg.nip44 === true;
        const nipBadge = isNip44 ? 'badge-success' : 'badge-secondary';
        const nipLabel = isNip44 ? '44' : '04';
        const el = document.createElement('div');
        el.className = `chat ${mine ? 'chat-end' : 'chat-start'}`;
        el.innerHTML = `
            <div class="chat-bubble ${mine ? 'chat-bubble-warning' : 'chat-bubble-info'}" style="min-width:60px;">
                <div class="text-sm" style="word-break:break-word;">${_esc(msg.content)}</div>
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
    }

    function stopMarketplace() {
        if (_marketFeedId) { LBW_Sync.unsyncFeed(_marketFeedId); _marketFeedId = null; }
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
                card.dataset.category = listing.category;
                card.style.cssText = 'background:var(--color-bg-card);border:2px solid var(--color-border);border-radius:16px;overflow:hidden;transition:all 0.3s;';

                // IMAGE: use fallback chain from MediaService
                const media = LBW_Media.extractMediaFromTags(listing.tags);
                let imgHtml = '';
                if (media.urls.length > 0) {
                    // Create container; we'll insert the fallback <img> via JS
                    const imgId = `img-${listing.id.substring(0, 8)}`;
                    imgHtml = `<div id="${imgId}" style="width:100%;height:150px;overflow:hidden;"></div>`;
                    // After render, insert the actual fallback image
                    setTimeout(() => {
                        const container = document.getElementById(imgId);
                        if (container) {
                            const img = LBW_Media.createFallbackImage(media.urls, {
                                style: 'width:100%;height:150px;object-fit:cover;',
                                alt: listing.title
                            });
                            if (img) container.appendChild(img);
                        }
                    }, 0);
                }

                const isMine = listing.pubkey === LBW_Nostr.getPubkey();
                const integrity = media.sha256 ? `<span title="SHA-256: ${media.sha256}" style="font-size:0.6rem;color:#4CAF50;cursor:help;">🔒 Verificado</span>` : '';

                card.innerHTML = `
                    ${imgHtml}
                    <div style="padding:1rem;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
                            <span style="font-size:1.5rem;">${listing.emoji || icons[listing.category] || '🏪'}</span>
                            <div style="display:flex;gap:0.3rem;align-items:center;">
                                ${integrity}
                                <span style="font-size:0.7rem;background:rgba(229,185,92,0.15);color:var(--color-gold);padding:0.2rem 0.6rem;border-radius:20px;border:1px solid rgba(229,185,92,0.3);">${listing.category}</span>
                            </div>
                        </div>
                        <h4 style="color:var(--color-text-primary);font-size:1rem;margin-bottom:0.4rem;">${_esc(listing.title)}</h4>
                        <p style="color:var(--color-text-secondary);font-size:0.8rem;margin-bottom:0.75rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${_esc(listing.description)}</p>
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <span style="font-weight:700;color:var(--color-gold);font-size:0.9rem;">${_esc(listing.price)} ${listing.currency !== 'sats' ? listing.currency : '⚡'}</span>
                            <span style="font-size:0.7rem;color:var(--color-text-secondary);">${_esc(name)}</span>
                        </div>
                        <div style="margin-top:0.75rem;display:flex;gap:0.5rem;" class="card-actions">
                            <button onclick="LBW_NostrBridge.startDMWith('${listing.pubkey}')" style="flex:1;padding:0.4rem;background:rgba(44,95,111,0.2);border:1px solid var(--color-teal-light);border-radius:8px;color:var(--color-teal-light);cursor:pointer;font-size:0.75rem;">💬 Contactar</button>
                            ${isMine ? `<button onclick="LBW_NostrBridge.deleteListing('${listing.id}')" style="padding:0.4rem 0.6rem;background:rgba(255,68,68,0.15);border:1px solid #ff4444;border-radius:8px;color:#ff4444;cursor:pointer;font-size:0.75rem;">🗑️</button>` : ''}
                        </div>
                    </div>`;

                // Open detail on card click (but not on button clicks)
                card.addEventListener('click', function(e) {
                    if (e.target.tagName === 'BUTTON' || e.target.closest('.card-actions')) return;
                    _showListingDetail(listing, name);
                });

                grid.appendChild(card);
            });
        });
    }

    // Publish offer using MediaService for images
    async function publishOffer(offerData) {
        let mediaTags = [];
        if (offerData.imageFile) {
            const media = await LBW_Media.uploadImage(offerData.imageFile, {
                maxProviders: 2,
                onProgress: (msg) => console.log(`[Bridge] 📸 ${msg}`)
            });
            mediaTags = LBW_Media.buildImageTags(media);
        }

        const result = await LBW_Nostr.publishMarketplaceListing({
            title: offerData.title,
            description: offerData.description,
            category: offerData.category,
            price: offerData.price,
            currency: offerData.currency || 'sats',
            emoji: offerData.emoji,
            location: offerData.location || '',
            status: 'active',
            mediaTags
        });

        // Inject locally so it appears immediately
        if (result && result.event) {
            const ev = result.event;
            const listing = {
                id: ev.id,
                pubkey: ev.pubkey,
                npub: LBW_Nostr.pubkeyToNpub(ev.pubkey),
                title: offerData.title || 'Sin título',
                description: offerData.description || '',
                category: offerData.category || 'servicios',
                price: offerData.price || 'A negociar',
                currency: offerData.currency || 'sats',
                emoji: offerData.emoji || '🏪',
                image: '',
                images: [],
                location: offerData.location || '',
                status: 'active',
                created_at: ev.created_at,
                tags: ev.tags || [],
                dTag: (ev.tags.find(function(t) { return t[0] === 'd'; }) || [])[1] || '',
                _source: 'local'
            };
            var idx = _marketplaceListings.findIndex(function(l) {
                return (l.dTag && l.dTag === listing.dTag) || l.id === listing.id;
            });
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

    function filterMarketplace(cat) {
        document.querySelectorAll('.offer-card').forEach(c => {
            c.style.display = (cat === 'todos' || c.dataset.category === cat) ? '' : 'none';
        });
    }

    function _showListingDetail(listing, authorName) {
        // Build image HTML from media tags
        var media = LBW_Media.extractMediaFromTags(listing.tags);
        var imageHtml = '';
        if (media.urls.length > 0) {
            imageHtml = '<img src="' + _esc(media.urls[0]) + '" alt="' + _esc(listing.title) + '" style="width:100%;height:250px;object-fit:cover;margin-bottom:1rem;border-radius:12px;" onerror="this.style.display=\'none\'">';
        }

        var isMine = listing.pubkey === LBW_Nostr.getPubkey();
        var priceText = (!listing.price || listing.price === '0' || listing.price === 0) ? 'A negociar' : _esc(listing.price) + ' ' + (listing.currency !== 'sats' ? listing.currency : '⚡');

        var modal = document.createElement('div');
        modal.className = 'modal active';
        modal.innerHTML =
            '<div class="modal-content" style="position:relative;">' +
                '<button class="modal-close" onclick="this.closest(\'.modal\').remove()">×</button>' +
                '<div class="modal-header">' +
                    imageHtml +
                    '<div style="display:inline-block;font-size:0.7rem;background:rgba(229,185,92,0.15);color:var(--color-gold);padding:0.2rem 0.6rem;border-radius:20px;border:1px solid rgba(229,185,92,0.3);">' + _esc(listing.category) + '</div>' +
                '</div>' +
                '<div class="modal-body">' +
                    '<h2 style="color:var(--color-gold);margin-bottom:1rem;">' + _esc(listing.title) + '</h2>' +
                    '<p style="color:var(--color-text-secondary);margin-bottom:1.5rem;line-height:1.6;">' + _esc(listing.description) + '</p>' +
                    '<div style="background:var(--color-bg-dark);padding:1.5rem;border-radius:12px;margin-bottom:1.5rem;">' +
                        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                            '<div>' +
                                '<div style="font-size:0.8rem;color:var(--color-text-secondary);margin-bottom:0.25rem;">Precio</div>' +
                                '<div style="font-size:1.5rem;font-weight:700;color:var(--color-gold);">' + priceText + '</div>' +
                            '</div>' +
                            '<div style="text-align:right;">' +
                                '<div style="font-size:0.8rem;color:var(--color-text-secondary);margin-bottom:0.25rem;">Publicado por</div>' +
                                '<div style="font-size:1rem;font-weight:600;color:var(--color-text-primary);">' + _esc(authorName) + '</div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                    (!isMine ?
                        '<div style="margin-top:1.5rem;text-align:center;">' +
                            '<button class="btn btn-primary" onclick="this.closest(\'.modal\').remove(); LBW_NostrBridge.startDMWith(\'' + listing.pubkey + '\')">💬 Enviar Mensaje Privado</button>' +
                        '</div>'
                    : '') +
                '</div>' +
            '</div>';

        document.body.appendChild(modal);
        modal.addEventListener('click', function(e) {
            if (e.target === modal) modal.remove();
        });
    }

    // ── Profile Resolution (cache-first via SyncEngine) ──────
    async function _resolveName(pubkey) {
        // Use SyncEngine's cache-first resolution
        try {
            const profile = await LBW_Sync.resolveProfile(pubkey);
            if (profile) return profile.name || profile.display_name || LBW_Nostr.pubkeyToNpub(pubkey).substring(0, 12) + '...';
        } catch (e) {}

        // Self
        if (pubkey === LBW_Nostr.getPubkey()) {
            const p = LBW_Nostr.getProfile();
            if (p.name || p.display_name) return p.name || p.display_name;
        }

        return LBW_Nostr.pubkeyToNpub(pubkey).substring(0, 12) + '...';
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
                    name: lastMsg?._resolvedName || null,
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

    // ── Public API ───────────────────────────────────────────
    return {
        init,
        handleNIP07Login, handlePrivateKeyLogin, handleCreateIdentity, handleLogout, restoreSession,
        publishCommunityPost, replyToMessage, cancelReply, startCommunityChat, stopCommunityChat,
        sendDM, startDMWith, openDMConversation, startDirectMessages, stopDirectMessages,
        publishOffer, deleteListing, filterMarketplace, startMarketplace, stopMarketplace, refreshMarketplace,
        startGovernance, stopGovernance, startMerits, stopMerits,
        togglePrivacyStrict,
        _resolveName, getDebugStats, getMyOffersCount, getMyChatCount,
        // Nuevos métodos para integración con chat.js
        getConversations, getUnreadDMCount
    };
})();

window.LBW_NostrBridge = LBW_NostrBridge;

document.addEventListener('DOMContentLoaded', () => {
    LBW_NostrBridge.init();
    LBW_NostrBridge.restoreSession();
});

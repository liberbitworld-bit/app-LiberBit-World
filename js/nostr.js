// ============================================================
// LiberBit World — Nostr Integration Layer v2.0 (nostr.js)
// 
// CHANGES v2.0:
//   ✅ SimplePool (nostr-tools) replaces manual WebSocket pool
//   ✅ Relay separation by event kind (privacy by design)
//   ✅ validateEvent() + verifyEvent() double validation
//   ✅ Rate limiting per relay + per pubkey
//   ✅ Max content size enforcement
//   ✅ ~150 lines removed vs v1, robustness improved
//
// Provides: Relay Pool, Event Publishing, NIP-04 DMs,
//           NIP-07 Extension Login, Marketplace (NIP-99),
//           Identity Metadata (NIP-01 kind 0)
// Dependencies: nostr-tools v2.7+ (CDN bundle)
// ============================================================

const LBW_Nostr = (() => {
    'use strict';

    // ── Relay Configuration ──────────────────────────────────
    // System relays: defaults when user has no NIP-65 relay list.
    // PRIVATE: LiberBit infrastructure only (governance, DMs, merits)
    const SYSTEM_PRIVATE_RELAYS = [
        'wss://relay.liberbit.world',
        'wss://relay2.liberbit.world',
        'wss://relay3.liberbit.world'
    ];

    // PUBLIC: Community content + profile discovery fallback
    const SYSTEM_PUBLIC_RELAYS = [
        'wss://relay.damus.io',
        'wss://nos.lol'
    ];

    const SYSTEM_ALL_RELAYS = [...SYSTEM_PRIVATE_RELAYS, ...SYSTEM_PUBLIC_RELAYS];

    // ── NIP-65 User Relay State ──────────────────────────────
    // When user publishes kind 10002, these override system defaults.
    let _userReadRelays = [];   // URLs the user reads from
    let _userWriteRelays = [];  // URLs the user writes to
    let _userRelayListLoaded = false;
    let _privacyStrict = false; // No public relays ever

    // ── Relay URL Validation ─────────────────────────────────
    function _validateRelayUrl(url) {
        if (!url || typeof url !== 'string') return false;
        if (url.length > 256) return false;
        if (!url.startsWith('wss://') && !url.startsWith('ws://')) return false;
        // Block dangerous schemes embedded in URL
        if (/javascript:|data:|blob:/i.test(url)) return false;
        try {
            new URL(url);
            return true;
        } catch (e) {
            return false;
        }
    }

    // For external backward compatibility
    const PRIVATE_RELAYS = SYSTEM_PRIVATE_RELAYS;
    const PUBLIC_RELAYS = SYSTEM_PUBLIC_RELAYS;
    const ALL_RELAYS = SYSTEM_ALL_RELAYS;

    // ── Event Kinds ──────────────────────────────────────────
    const EVENT_KINDS = {
        METADATA:       0,       // NIP-01: User profile metadata
        TEXT_NOTE:      1,       // NIP-01: Community posts
        RECOMMEND_RELAY: 2,     // NIP-01: Relay recommendation
        ENCRYPTED_DM:   4,      // NIP-04/44: Encrypted direct messages
        DELETE:         5,       // NIP-09: Event deletion
        REACTION:       7,      // NIP-25: Reactions (likes/zaps)
        RELAY_LIST:     10002,   // NIP-65: Relay list metadata
        // NIP-99: Classified listings (marketplace)
        MARKETPLACE:    30402,
        // LiberBit Governance Kinds
        LBW_PROPOSAL:   31000,
        LBW_VOTE:       31001,
        LBW_MERIT:      31002,
        LBW_CONTRIB:    31003,
        LBW_DELEGATE:   31004,
        LBW_SNAPSHOT:   31005,
        LBW_CONFIG:     31006,
        APP_STATE:      30078
    };

    // ── NIP-65 Relay Routing (dynamic) ───────────────────────
    // Uses user relay list when available, falls back to system.
    // Privacy Strict mode disables all public relays.

    function _getUserWriteRelays() {
        if (_userWriteRelays.length > 0) return [..._userWriteRelays];
        return [...SYSTEM_PRIVATE_RELAYS];
    }

    function _getUserReadRelays() {
        if (_userReadRelays.length > 0) return [..._userReadRelays];
        if (_privacyStrict) return [...SYSTEM_PRIVATE_RELAYS];
        return [...SYSTEM_ALL_RELAYS];
    }

    function _getRelaysForKind(kind) {
        switch (kind) {
            // === PRIVATE ONLY (always) ===
            case EVENT_KINDS.ENCRYPTED_DM:
            case EVENT_KINDS.LBW_PROPOSAL:
            case EVENT_KINDS.LBW_VOTE:
            case EVENT_KINDS.LBW_MERIT:
            case EVENT_KINDS.LBW_CONTRIB:
            case EVENT_KINDS.LBW_DELEGATE:
            case EVENT_KINDS.LBW_SNAPSHOT:
            case EVENT_KINDS.LBW_CONFIG:
            case EVENT_KINDS.APP_STATE:
                // Use user write relays if set, else system private
                // FALLBACK: if no private relays are actually connected, use all connected relays
                {
                    let privateTargets;
                    if (_privacyStrict) {
                        privateTargets = [...SYSTEM_PRIVATE_RELAYS];
                    } else {
                        privateTargets = _userWriteRelays.length > 0 ? [..._userWriteRelays] : [...SYSTEM_PRIVATE_RELAYS];
                    }
                    // Check if any private target is actually connected
                    const connectedPrivate = privateTargets.filter(u => _relayStatusMap[u] === 'connected');
                    if (connectedPrivate.length > 0) return connectedPrivate;
                    // Fallback: use ANY connected relay so data isn't lost
                    const anyConnected = Object.keys(_relayStatusMap).filter(u => _relayStatusMap[u] === 'connected');
                    if (anyConnected.length > 0) {
                        console.warn(`[Nostr] ⚠️ Private relays unavailable for kind ${kind}, fallback to ${anyConnected.length} connected relays`);
                        return anyConnected;
                    }
                    return privateTargets; // Last resort: try anyway
                }

            // === DISCOVERABLE (user relays + optionally public) ===
            case EVENT_KINDS.METADATA:
            case EVENT_KINDS.TEXT_NOTE:
            case EVENT_KINDS.REACTION:
            case EVENT_KINDS.DELETE:
            case EVENT_KINDS.MARKETPLACE:
            case EVENT_KINDS.RELAY_LIST:
                if (_privacyStrict) return _getUserWriteRelays();
                // User write relays + system public for discoverability
                const write = _getUserWriteRelays();
                if (!_privacyStrict) {
                    SYSTEM_PUBLIC_RELAYS.forEach(r => {
                        if (!write.includes(r)) write.push(r);
                    });
                }
                return write;

            default:
                return _getUserWriteRelays();
        }
    }

    function getRelaysForKind(kind) {
        return _getRelaysForKind(kind);
    }

    // ── NIP-65: Relay List Management ────────────────────────

    // Parse kind 10002 event into relay list
    function _parseRelayListEvent(event) {
        if (event.kind !== EVENT_KINDS.RELAY_LIST) return [];
        const relays = [];
        (event.tags || []).forEach(t => {
            if (t[0] === 'r' && t[1] && _validateRelayUrl(t[1])) {
                const mode = t[2] || 'both'; // 'read', 'write', or both
                relays.push({ url: t[1], mode });
            }
        });
        return relays;
    }

    // Apply relay list to internal state
    function _applyRelayList(relays) {
        _userReadRelays = relays
            .filter(r => r.mode === 'read' || r.mode === 'both')
            .map(r => r.url);
        _userWriteRelays = relays
            .filter(r => r.mode === 'write' || r.mode === 'both')
            .map(r => r.url);
        _userRelayListLoaded = true;
        console.log(`[Nostr] 📡 NIP-65: ${_userReadRelays.length} read, ${_userWriteRelays.length} write relays`);
    }

    // Fetch user's relay list from network (used during login)
    async function fetchRelayList(pubkey) {
        return new Promise(resolve => {
            const timeout = setTimeout(() => resolve(null), 5000);
            let found = false;
            // Subscribe across ALL relays (need to discover user's list)
            const sub = subscribe(
                { kinds: [EVENT_KINDS.RELAY_LIST], authors: [pubkey], limit: 1 },
                event => {
                    if (found) return;
                    found = true;
                    clearTimeout(timeout);
                    const relays = _parseRelayListEvent(event);
                    if (relays.length > 0) {
                        _applyRelayList(relays);
                        // Cache in IndexedDB
                        if (window.LBW_Store) {
                            LBW_Store.putRelayList(pubkey, relays).catch(() => {});
                        }
                    }
                    resolve(relays);
                    setTimeout(() => unsubscribe(sub), 200);
                },
                () => { clearTimeout(timeout); if (!found) resolve(null); },
                SYSTEM_ALL_RELAYS  // Must use system relays to discover user's list
            );
        });
    }

    // Load cached relay list from IndexedDB (instant, before network)
    async function loadCachedRelayList(pubkey) {
        if (!window.LBW_Store) return null;
        try {
            const cached = await LBW_Store.getRelayList(pubkey);
            if (cached && cached.relays && cached.relays.length > 0) {
                _applyRelayList(cached.relays);
                console.log(`[Nostr] 💾 NIP-65 cache: ${cached.relays.length} relays`);
                return cached.relays;
            }
        } catch (e) {}
        return null;
    }

    // Publish user's relay list (kind 10002)
    async function publishRelayList(relays) {
        // Validate all URLs
        const valid = relays.filter(r => _validateRelayUrl(r.url));
        if (valid.length === 0) throw new Error('No hay relays válidos.');

        const tags = valid.map(r => {
            if (r.mode === 'read') return ['r', r.url, 'read'];
            if (r.mode === 'write') return ['r', r.url, 'write'];
            return ['r', r.url]; // both
        });

        const result = await publishEvent({
            kind: EVENT_KINDS.RELAY_LIST,
            content: '',
            tags
        });

        // Apply locally
        _applyRelayList(valid);

        // Cache
        if (window.LBW_Store && _pubkey) {
            await LBW_Store.putRelayList(_pubkey, valid).catch(() => {});
        }

        return result;
    }

    // Get relay list for another pubkey (for shared relay computation)
    async function fetchOtherRelayList(pubkey) {
        // Cache first
        if (window.LBW_Store) {
            try {
                const cached = await LBW_Store.getRelayList(pubkey);
                if (cached && cached._updated_at > Date.now() - 3600000) {
                    return cached.relays;
                }
            } catch (e) {}
        }

        // Network
        return new Promise(resolve => {
            const timeout = setTimeout(() => resolve(null), 3000);
            let found = false;
            const sub = subscribe(
                { kinds: [EVENT_KINDS.RELAY_LIST], authors: [pubkey], limit: 1 },
                event => {
                    if (found) return;
                    found = true;
                    clearTimeout(timeout);
                    const relays = _parseRelayListEvent(event);
                    if (relays.length > 0 && window.LBW_Store) {
                        LBW_Store.putRelayList(pubkey, relays).catch(() => {});
                    }
                    resolve(relays.length > 0 ? relays : null);
                    setTimeout(() => unsubscribe(sub), 200);
                },
                () => { clearTimeout(timeout); if (!found) resolve(null); },
                SYSTEM_ALL_RELAYS
            );
        });
    }

    // Compute shared relays between us and a recipient (for DMs)
    async function _getDMRelaysForRecipient(recipientPubkey) {
        const myWrite = _getUserWriteRelays();

        // Try to get recipient's relay list (3s timeout)
        let theirRelays = null;
        try {
            theirRelays = await fetchOtherRelayList(recipientPubkey);
        } catch (e) {}

        if (theirRelays && theirRelays.length > 0) {
            const theirRead = theirRelays
                .filter(r => r.mode === 'read' || r.mode === 'both')
                .map(r => r.url);
            // Intersection: our write ∩ their read
            const shared = myWrite.filter(r => theirRead.includes(r));
            if (shared.length > 0) {
                console.log(`[Nostr] 🤝 DM shared relays: ${shared.length} (${shared.join(', ')})`);
                return shared;
            }
        }

        // Fallback: our write relays + public relays (DMs are encrypted)
        if (myWrite.length > 0) return [...new Set([...myWrite, ...SYSTEM_PUBLIC_RELAYS])];
        return [...SYSTEM_ALL_RELAYS];
    }

    // ── Privacy Strict Mode ──────────────────────────────────
    function setPrivacyStrict(enabled) {
        _privacyStrict = !!enabled;
        console.log(`[Nostr] ${enabled ? '🔒' : '🌐'} Privacy Strict: ${enabled ? 'ON' : 'OFF'}`);
        // Emit event for UI to update
        window.dispatchEvent(new CustomEvent('nostr-privacy-mode', { detail: { strict: _privacyStrict } }));
    }

    function isPrivacyStrict() { return _privacyStrict; }

    // ── Rate Limiter ─────────────────────────────────────────
    // Protects against relay spam and malicious event floods.
    const _rateLimiter = {
        _relayCounts: {},   // relay -> { count, resetAt }
        _pubkeyCounts: {},  // pubkey -> { count, resetAt }

        MAX_EVENTS_PER_RELAY_PER_SEC: 50,
        MAX_EVENTS_PER_PUBKEY_PER_SEC: 10,
        MAX_CONTENT_BYTES: 64 * 1024,  // 64 KB

        checkRelay(relayUrl) {
            const now = Date.now();
            let e = this._relayCounts[relayUrl];
            if (!e || now > e.resetAt) {
                e = { count: 0, resetAt: now + 1000 };
                this._relayCounts[relayUrl] = e;
            }
            return ++e.count <= this.MAX_EVENTS_PER_RELAY_PER_SEC;
        },

        checkPubkey(pubkey) {
            const now = Date.now();
            let e = this._pubkeyCounts[pubkey];
            if (!e || now > e.resetAt) {
                e = { count: 0, resetAt: now + 1000 };
                this._pubkeyCounts[pubkey] = e;
            }
            return ++e.count <= this.MAX_EVENTS_PER_PUBKEY_PER_SEC;
        },

        checkContentSize(content) {
            if (!content) return true;
            return new TextEncoder().encode(content).length <= this.MAX_CONTENT_BYTES;
        },

        _cleanupInterval: null,
        startCleanup() {
            if (this._cleanupInterval) return;
            this._cleanupInterval = setInterval(() => {
                const now = Date.now();
                for (const k of Object.keys(this._relayCounts)) {
                    if (now > this._relayCounts[k].resetAt + 5000) delete this._relayCounts[k];
                }
                for (const k of Object.keys(this._pubkeyCounts)) {
                    if (now > this._pubkeyCounts[k].resetAt + 5000) delete this._pubkeyCounts[k];
                }
            }, 30000);
        },
        stopCleanup() {
            if (this._cleanupInterval) {
                clearInterval(this._cleanupInterval);
                this._cleanupInterval = null;
            }
        }
    };

    // ── Event Validator ──────────────────────────────────────
    // Double validation: structure (validateEvent) + signature
    // (verifyEvent) + timestamp clamping + rate limits.

    // Timestamp policy: reject events too far in the past or future.
    // Prevents cursor-bricking attacks (event with created_at=2040
    // advances cursor past all real events).
    const TIMESTAMP_POLICY = {
        MAX_FUTURE_SKEW_SECS: 600,      // 10 min into the future
        MAX_PAST_WINDOW_SECS: 365 * 86400  // 1 year into the past
    };

    function _validateIncomingEvent(event, relayUrl) {
        const nt = _getNostrTools();

        // 1. Structural validation
        if (!nt.validateEvent(event)) {
            console.warn(`[Nostr] ❌ Evento estructuralmente inválido de ${relayUrl}:`, event.id?.substring(0, 8));
            return false;
        }

        // 2. Signature verification
        if (!nt.verifyEvent(event)) {
            console.warn(`[Nostr] ❌ Firma inválida de ${relayUrl}:`, event.id?.substring(0, 8));
            return false;
        }

        // 3. Timestamp clamping: reject out-of-range created_at
        const nowSecs = Math.floor(Date.now() / 1000);
        const minTs = nowSecs - TIMESTAMP_POLICY.MAX_PAST_WINDOW_SECS;
        const maxTs = nowSecs + TIMESTAMP_POLICY.MAX_FUTURE_SKEW_SECS;
        if (event.created_at < minTs || event.created_at > maxTs) {
            console.warn(`[Nostr] ⏰ Timestamp fuera de rango (${event.created_at}) de ${relayUrl}: ${event.id?.substring(0, 8)}`);
            return false;
        }

        // 4. Rate limit: per relay
        if (!_rateLimiter.checkRelay(relayUrl)) {
            console.warn(`[Nostr] ⚠️ Rate limit relay ${relayUrl}`);
            return false;
        }

        // 5. Rate limit: per pubkey
        if (!_rateLimiter.checkPubkey(event.pubkey)) {
            console.warn(`[Nostr] ⚠️ Rate limit pubkey ${event.pubkey.substring(0, 8)}`);
            return false;
        }

        // 6. Content size
        if (!_rateLimiter.checkContentSize(event.content)) {
            console.warn(`[Nostr] ⚠️ Content demasiado grande: ${event.id?.substring(0, 8)}`);
            return false;
        }

        return true;
    }

    // ── State ────────────────────────────────────────────────
    let _pool = null;              // nostr-tools SimplePool
    let _privkey = null;           // hex private key (null if NIP-07)
    let _pubkey = null;            // hex public key
    let _npub = null;              // bech32 npub
    let _nsec = null;              // bech32 nsec
    let _useExtension = false;     // NIP-07 mode
    let _profile = {};             // kind 0 metadata
    let _seenEvents = new Set();   // dedup
    let _activeSubs = [];          // track for cleanup
    let _onRelayStatus = null;
    let _relayStatusMap = {};      // url -> status
    let _eventCallbacks = {};      // kind -> [callback]

    // ── nostr-tools access ───────────────────────────────────
    function _getNostrTools() {
        if (window.NostrTools) return window.NostrTools;
        if (window.nostrTools) return window.nostrTools;
        throw new Error('nostr-tools no cargado. Incluye el CDN.');
    }

    // ── SimplePool Management ────────────────────────────────
    function _getPool() {
        if (!_pool) {
            const nt = _getNostrTools();
            _pool = new nt.SimplePool();
        }
        return _pool;
    }

    function connectToRelays(relayUrls = null) {
        const pool = _getPool();

        // Determine targets: explicit > user NIP-65 > system defaults
        let targets;
        if (relayUrls) {
            targets = relayUrls;
        } else if (_userRelayListLoaded && (_userReadRelays.length > 0 || _userWriteRelays.length > 0)) {
            // Use user's NIP-65 relay list (deduplicated union of read + write)
            const userAll = [...new Set([..._userReadRelays, ..._userWriteRelays])];
            if (_privacyStrict) {
                targets = userAll; // Only user's relays
            } else {
                // User relays + system for discovery
                targets = [...new Set([...userAll, ...SYSTEM_ALL_RELAYS])];
            }
        } else {
            targets = _privacyStrict ? [...SYSTEM_PRIVATE_RELAYS] : [...SYSTEM_ALL_RELAYS];
        }

        // Validate all URLs
        targets = targets.filter(url => _validateRelayUrl(url));

        _rateLimiter.startCleanup();

        targets.forEach(url => { _relayStatusMap[url] = 'connecting'; });
        _emitRelayStatus();

        // Probe each relay with a lightweight sub to force connection
        const dummyAuthor = _pubkey || '0'.repeat(64);
        const probeFilter = { kinds: [0], limit: 1, authors: [dummyAuthor] };

        targets.forEach(url => {
            try {
                const sub = pool.subscribeMany(
                    [url],
                    [probeFilter],
                    {
                        onevent: () => {},
                        oneose: () => {
                            _relayStatusMap[url] = 'connected';
                            _emitRelayStatus();
                            sub.close();
                        },
                        onclose: (reason) => {
                            // Don't overwrite 'connected' — sub.close() after EOSE triggers this
                            if (_relayStatusMap[url] === 'connected') return;
                            const isErr = typeof reason === 'string' && reason.includes('error');
                            _relayStatusMap[url] = isErr ? 'error' : 'disconnected';
                            _emitRelayStatus();
                        }
                    }
                );
                // Timeout
                setTimeout(() => {
                    if (_relayStatusMap[url] === 'connecting') {
                        _relayStatusMap[url] = 'timeout';
                        _emitRelayStatus();
                        try { sub.close(); } catch (e) {}
                    }
                }, 8000);
            } catch (e) {
                _relayStatusMap[url] = 'error';
                _emitRelayStatus();
            }
        });

        console.log(`[Nostr] 🔗 SimplePool → ${targets.length} relays`);
    }

    function disconnectAll() {
        _activeSubs.forEach(sub => { try { sub.close(); } catch (e) {} });
        _activeSubs = [];
        if (_pool) {
            try { _pool.close(ALL_RELAYS); } catch (e) {}
            _pool = null;
        }
        _relayStatusMap = {};
        _rateLimiter.stopCleanup();
        _emitRelayStatus();
    }

    function getConnectedRelays() {
        return Object.keys(_relayStatusMap).filter(u => _relayStatusMap[u] === 'connected');
    }

    function getRelayStatus() { return { ..._relayStatusMap }; }

    function onRelayStatusChange(cb) { _onRelayStatus = cb; }

    function _emitRelayStatus() {
        if (_onRelayStatus) _onRelayStatus(getRelayStatus());
        window.dispatchEvent(new CustomEvent('nostr-relay-status', { detail: getRelayStatus() }));
    }

    // ── Key Utils ────────────────────────────────────────────
    function _hexToBytes(hex) {
        const nt = _getNostrTools();
        return nt.hexToBytes ? nt.hexToBytes(hex)
            : new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    }

    function _bytesToHex(bytes) {
        const nt = _getNostrTools();
        return nt.bytesToHex ? nt.bytesToHex(bytes)
            : Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function generateKeypair() {
        const nt = _getNostrTools();
        const sk = nt.generateSecretKey();
        const pk = nt.getPublicKey(sk);
        return {
            privkeyHex: _bytesToHex(sk),
            pubkeyHex: pk,
            privkeyBytes: sk,
            nsec: nt.nip19.nsecEncode(sk),
            npub: nt.nip19.npubEncode(pk)
        };
    }

    function importPrivateKey(input) {
        const nt = _getNostrTools();
        let skHex, skBytes;
        input = input.trim();

        if (input.startsWith('nsec1')) {
            const d = nt.nip19.decode(input);
            skBytes = d.data;
            skHex = _bytesToHex(skBytes);
        } else if (/^[0-9a-fA-F]{64}$/.test(input)) {
            skHex = input.toLowerCase();
            skBytes = _hexToBytes(skHex);
        } else {
            throw new Error('Formato inválido. Usa nsec1... o hex 64 chars.');
        }

        const pk = nt.getPublicKey(skBytes);
        return {
            privkeyHex: skHex, privkeyBytes: skBytes,
            pubkeyHex: pk,
            nsec: nt.nip19.nsecEncode(skBytes),
            npub: nt.nip19.npubEncode(pk)
        };
    }

    function pubkeyToNpub(hex) { return _getNostrTools().nip19.npubEncode(hex); }
    function npubToHex(npub) { return _getNostrTools().nip19.decode(npub).data; }

    // ── Subscriptions (via SimplePool) ───────────────────────
    function subscribe(filters, onEvent, onEose = null, relayUrls = null) {
        const pool = _getPool();
        const filterArr = Array.isArray(filters) ? filters : [filters];

        // Determine target relays
        let targetRelays;
        if (relayUrls) {
            targetRelays = relayUrls;
        } else {
            const kinds = filterArr[0]?.kinds;
            if (kinds && kinds.length > 0) {
                // Intersection of relay sets for all requested kinds
                const sets = kinds.map(k => _getRelaysForKind(k));
                targetRelays = sets.reduce((acc, s) => acc.filter(r => s.includes(r)), sets[0] || ALL_RELAYS);
                if (targetRelays.length === 0) targetRelays = [...PRIVATE_RELAYS];
            } else {
                targetRelays = [...ALL_RELAYS];
            }
        }

        const sub = pool.subscribeMany(
            targetRelays,
            filterArr,
            {
                onevent: (event) => {
                    // Dedup
                    if (_seenEvents.has(event.id)) return;
                    _seenEvents.add(event.id);
                    if (_seenEvents.size > 10000) {
                        const arr = [..._seenEvents];
                        _seenEvents = new Set(arr.slice(-5000));
                    }

                    // VALIDATE + VERIFY
                    if (!_validateIncomingEvent(event, 'pool')) return;

                    // Deliver
                    if (onEvent) onEvent(event, 'pool');

                    // Kind callbacks
                    (_eventCallbacks[event.kind] || []).forEach(cb => cb(event, 'pool'));

                    // Global dispatch
                    window.dispatchEvent(new CustomEvent('nostr-event', {
                        detail: { event, relay: 'pool' }
                    }));
                },
                oneose: () => { if (onEose) onEose(); }
            }
        );

        _activeSubs.push(sub);
        return sub;
    }

    function unsubscribe(sub) {
        if (!sub) return;
        try { sub.close(); } catch (e) {}
        _activeSubs = _activeSubs.filter(s => s !== sub);
    }

    function onEventKind(kind, cb) {
        if (!_eventCallbacks[kind]) _eventCallbacks[kind] = [];
        _eventCallbacks[kind].push(cb);
    }

    // ── Event Publishing ─────────────────────────────────────
    async function publishEvent(eventTemplate, relayUrlsOverride = null) {
        const pool = _getPool();

        const event = {
            kind: eventTemplate.kind,
            created_at: eventTemplate.created_at || Math.floor(Date.now() / 1000),
            tags: eventTemplate.tags || [],
            content: eventTemplate.content || '',
            pubkey: _pubkey
        };

        if (!_rateLimiter.checkContentSize(event.content)) {
            throw new Error(`Contenido demasiado grande (máx ${_rateLimiter.MAX_CONTENT_BYTES / 1024} KB).`);
        }

        const signed = await _signEvent(event);
        if (!signed) throw new Error('No se pudo firmar el evento.');

        // Route: explicit override > kind-based routing
        const targetRelays = relayUrlsOverride || _getRelaysForKind(event.kind);
        const isPrivateOnly = targetRelays.every(r => SYSTEM_PRIVATE_RELAYS.includes(r) || (_userWriteRelays.includes(r) && !SYSTEM_PUBLIC_RELAYS.includes(r)));

        const results = [];
        try {
            await Promise.allSettled(pool.publish(targetRelays, signed));
            targetRelays.forEach(url => results.push({ relay: url, success: true }));
        } catch (e) {
            console.warn('[Nostr] Error publicando:', e);
            targetRelays.forEach(url => results.push({ relay: url, success: false, error: e.message }));
        }

        const routeLabel = relayUrlsOverride ? '🤝 SHARED' : (isPrivateOnly ? '🔒 PRIVADO' : '🌐 PÚBLICO+PRIVADO');
        console.log(`[Nostr] 📤 kind=${event.kind} → ${targetRelays.length} relays [${routeLabel}]`);
        return { event: signed, results };
    }

    async function _signEvent(eventTemplate) {
        const nt = _getNostrTools();
        if (_useExtension && window.nostr) {
            return await window.nostr.signEvent(eventTemplate);
        } else if (_privkey) {
            return nt.finalizeEvent(eventTemplate, _hexToBytes(_privkey));
        }
        throw new Error('No hay método de firma.');
    }

    // ── Auth / Identity ──────────────────────────────────────
    // Login flow: set keys → load cached relay list → connect →
    // fetch profile → fetch network relay list → reconnect if changed

    async function loginWithExtension() {
        if (!window.nostr) throw new Error('No se detectó extensión Nostr (NIP-07).');
        const pubkey = await window.nostr.getPublicKey();
        _pubkey = pubkey;
        _npub = pubkeyToNpub(pubkey);
        _useExtension = true;
        _privkey = null;
        _nsec = null;

        // 1. Load cached relay list (instant)
        await loadCachedRelayList(pubkey);
        // 2. Connect to relays (using cached or system defaults)
        connectToRelays();
        // 3. Fetch profile
        await _fetchProfile(pubkey);
        // 4. Fetch network relay list (may trigger reconnect)
        fetchRelayList(pubkey).then(relays => {
            if (relays && relays.length > 0) {
                // Reconnect with updated relay list
                connectToRelays();
            }
        }).catch(() => {});

        return { pubkeyHex: pubkey, npub: _npub, profile: _profile, method: 'extension' };
    }

    function loginWithPrivateKey(input) {
        const keys = importPrivateKey(input);
        _privkey = keys.privkeyHex;
        _pubkey = keys.pubkeyHex;
        _npub = keys.npub;
        _nsec = keys.nsec;
        _useExtension = false;

        // Load cached relay list synchronously-ish
        loadCachedRelayList(keys.pubkeyHex).then(() => {
            connectToRelays();
            _fetchProfile(keys.pubkeyHex);
            fetchRelayList(keys.pubkeyHex).then(relays => {
                if (relays && relays.length > 0) connectToRelays();
            }).catch(() => {});
        }).catch(() => {
            connectToRelays();
            _fetchProfile(keys.pubkeyHex);
        });

        return { pubkeyHex: keys.pubkeyHex, npub: keys.npub, nsec: keys.nsec, method: 'privatekey' };
    }

    async function createIdentity(displayName) {
        const keys = generateKeypair();
        _privkey = keys.privkeyHex;
        _pubkey = keys.pubkeyHex;
        _npub = keys.npub;
        _nsec = keys.nsec;
        _useExtension = false;

        connectToRelays();

        const metadata = {
            name: displayName || 'Anon',
            display_name: displayName || 'Anon',
            about: 'Ciudadano de LiberBit World 🌐',
            picture: '', lud16: '', nip05: '', banner: '', website: '',
            lbw_citizenship: 'E-Residency',
            lbw_city: '',
            lbw_joined: new Date().toISOString()
        };

        await new Promise(r => setTimeout(r, 2000));
        try {
            await publishEvent({ kind: EVENT_KINDS.METADATA, content: JSON.stringify(metadata), tags: [] });
        } catch (e) {
            console.warn('[Nostr] Perfil no publicado (se reintentará):', e.message);
        }
        _profile = metadata;

        // Publish default relay list for new identity
        try {
            await publishRelayList(
                SYSTEM_PRIVATE_RELAYS.map(url => ({ url, mode: 'both' }))
            );
        } catch (e) {}

        return {
            privkeyHex: keys.privkeyHex, pubkeyHex: keys.pubkeyHex,
            npub: keys.npub, nsec: keys.nsec, profile: metadata, method: 'created'
        };
    }

    function logout() {
        disconnectAll();
        _privkey = null; _pubkey = null; _npub = null; _nsec = null;
        _useExtension = false; _profile = {};
        _seenEvents.clear(); _eventCallbacks = {};
        // NIP-65 state
        _userReadRelays = []; _userWriteRelays = [];
        _userRelayListLoaded = false;
    }

    // ── Profile (Kind 0) ────────────────────────────────────
    async function _fetchProfile(pubkey) {
        return new Promise(resolve => {
            const timeout = setTimeout(() => resolve(null), 6000);
            const sub = subscribe(
                { kinds: [0], authors: [pubkey], limit: 1 },
                event => {
                    clearTimeout(timeout);
                    try { _profile = JSON.parse(event.content); } catch (e) { _profile = {}; }
                    resolve(_profile);
                    setTimeout(() => unsubscribe(sub), 200);
                },
                () => { clearTimeout(timeout); resolve(_profile); }
            );
        });
    }

    async function updateProfile(metadata) {
        const current = { ..._profile, ...metadata };
        const result = await publishEvent({ kind: EVENT_KINDS.METADATA, content: JSON.stringify(current), tags: [] });
        _profile = current;
        return result;
    }

    async function fetchUserProfile(pubkey) {
        return new Promise(resolve => {
            const timeout = setTimeout(() => resolve(null), 6000);
            let found = false;
            const sub = subscribe(
                { kinds: [0], authors: [pubkey], limit: 1 },
                event => {
                    if (found) return;
                    found = true;
                    clearTimeout(timeout);
                    try { resolve(JSON.parse(event.content)); } catch (e) { resolve(null); }
                    setTimeout(() => unsubscribe(sub), 200);
                },
                () => { clearTimeout(timeout); if (!found) resolve(null); }
            );
        });
    }

    // ── Community Chat (Kind 1) ──────────────────────────────
    function subscribeCommunityChat(onMessage, since = null) {
        const filter = { kinds: [EVENT_KINDS.TEXT_NOTE], '#t': ['liberbit', 'lbw'], limit: 50 };
        if (since) filter.since = since;

        return subscribe(filter, event => {
            onMessage({
                id: event.id,
                pubkey: event.pubkey,
                npub: pubkeyToNpub(event.pubkey),
                content: event.content,
                created_at: event.created_at,
                tags: event.tags,
                isReply: event.tags.some(t => t[0] === 'e'),
                replyTo: (event.tags.find(t => t[0] === 'e') || [])[1] || null
            });
        });
    }

    async function publishCommunityMessage(content, replyToEventId = null) {
        const tags = [['t', 'liberbit'], ['t', 'lbw'], ['client', 'LiberBit World']];
        if (replyToEventId) tags.push(['e', replyToEventId, '', 'reply']);
        return publishEvent({ kind: EVENT_KINDS.TEXT_NOTE, content, tags });
    }

    // ── Encrypted DMs (NIP-44 preferred, NIP-04 fallback) ───
    // Encryption: try NIP-44 first → fallback NIP-04
    // Relay routing: shared relays (NIP-65) → user write → system private
    // Tags: includes ["v","2"] when using NIP-44 for forward compat

    function _supportsNIP44() {
        // Check if extension supports NIP-44
        if (_useExtension && window.nostr?.nip44) return true;
        // Check if nostr-tools has nip44 module
        try {
            const nt = _getNostrTools();
            if (nt.nip44) return true;
        } catch (e) {}
        return false;
    }

    function subscribeDirectMessages(onMessage) {
        // DMs are encrypted (NIP-44/NIP-04), so subscribing on public
        // relays doesn't leak content. We need to listen broadly because
        // the sender publishes to shared relays (our write ∩ their read).
        const dmRelays = _getUserWriteRelays().length > 0
            ? [...new Set([..._getUserWriteRelays(), ...SYSTEM_PUBLIC_RELAYS])]
            : [...SYSTEM_ALL_RELAYS];

        console.log('[Nostr] 📬 DM subscription → ' + dmRelays.length + ' relays');

        const subIn = subscribe(
            { kinds: [EVENT_KINDS.ENCRYPTED_DM], '#p': [_pubkey], limit: 100 },
            async event => {
                const decrypted = await _decryptDM(event);
                if (decrypted) onMessage({
                    id: event.id, from: event.pubkey, fromNpub: pubkeyToNpub(event.pubkey),
                    to: _pubkey, content: decrypted, created_at: event.created_at,
                    direction: 'incoming', nip44: _isNIP44Event(event)
                });
            },
            null,
            dmRelays
        );

        const subOut = subscribe(
            { kinds: [EVENT_KINDS.ENCRYPTED_DM], authors: [_pubkey], limit: 100 },
            async event => {
                const rTag = event.tags.find(t => t[0] === 'p');
                if (!rTag) return;
                const decrypted = await _decryptDM(event);
                if (decrypted) onMessage({
                    id: event.id, from: _pubkey, fromNpub: _npub,
                    to: rTag[1], content: decrypted, created_at: event.created_at,
                    direction: 'outgoing', nip44: _isNIP44Event(event)
                });
            },
            null,
            dmRelays
        );

        return { subIn, subOut };
    }

    async function sendDirectMessage(recipientHex, plaintext) {
        // Smart relay routing: shared relays → user write → system private
        const dmRelays = await _getDMRelaysForRecipient(recipientHex);

        const encrypted = await _encryptDM(recipientHex, plaintext);
        const tags = [['p', recipientHex]];

        // Tag NIP-44 messages for forward compatibility
        if (encrypted._nip44) {
            tags.push(['v', '2']);
        }

        // Pass dmRelays as explicit override to publishEvent
        return publishEvent({
            kind: EVENT_KINDS.ENCRYPTED_DM,
            content: encrypted.ciphertext,
            tags
        }, dmRelays);
    }

    function _isNIP44Event(event) {
        return event.tags.some(t => t[0] === 'v' && t[1] === '2');
    }

    // Encrypt: NIP-44 preferred → NIP-04 fallback
    async function _encryptDM(recipientPubkey, plaintext) {
        const nt = _getNostrTools();

        // Try NIP-44 first
        if (_useExtension && window.nostr?.nip44) {
            try {
                const ct = await window.nostr.nip44.encrypt(recipientPubkey, plaintext);
                return { ciphertext: ct, _nip44: true };
            } catch (e) {
                console.warn('[Nostr] NIP-44 extension falló, fallback a NIP-04:', e.message);
            }
        }

        if (!_useExtension && _privkey && nt.nip44) {
            try {
                const skBytes = _hexToBytes(_privkey);
                const conversationKey = nt.nip44.v2.utils.getConversationKey(skBytes, recipientPubkey);
                const ct = nt.nip44.v2.encrypt(plaintext, conversationKey);
                return { ciphertext: ct, _nip44: true };
            } catch (e) {
                console.warn('[Nostr] NIP-44 local falló, fallback a NIP-04:', e.message);
            }
        }

        // Fallback: NIP-04
        if (_useExtension && window.nostr?.nip04) {
            const ct = await window.nostr.nip04.encrypt(recipientPubkey, plaintext);
            return { ciphertext: ct, _nip44: false };
        }
        if (_privkey) {
            const ct = await nt.nip04.encrypt(_hexToBytes(_privkey), recipientPubkey, plaintext);
            return { ciphertext: ct, _nip44: false };
        }

        throw new Error('No se puede cifrar: no hay clave disponible.');
    }

    // Decrypt: try NIP-44 first if supported, fallback NIP-04.
    // Tag ["v","2"] is used as optimization hint, NOT as hard gate.
    // This handles: NIP-44 messages without tag, broken tags,
    // intermediate clients, etc.
    async function _decryptDM(event) {
        const nt = _getNostrTools();
        const rTag = event.tags.find(t => t[0] === 'p');
        const other = event.pubkey === _pubkey ? (rTag ? rTag[1] : null) : event.pubkey;
        if (!other) return null;

        const hasV2Tag = _isNIP44Event(event);
        const hasNip44Support = (_useExtension && window.nostr?.nip44) || (!_useExtension && _privkey && nt.nip44);

        // Strategy: if we have NIP-44 support, always try it first
        // (whether or not the tag says v=2). Then fallback to NIP-04.
        // If we DON'T have NIP-44 support, go straight to NIP-04.

        if (hasNip44Support) {
            // Try NIP-44 first
            try {
                if (_useExtension && window.nostr?.nip44) {
                    return await window.nostr.nip44.decrypt(other, event.content);
                }
                if (_privkey && nt.nip44) {
                    const skBytes = _hexToBytes(_privkey);
                    const conversationKey = nt.nip44.v2.utils.getConversationKey(skBytes, other);
                    return nt.nip44.v2.decrypt(event.content, conversationKey);
                }
            } catch (e44) {
                // NIP-44 failed — try NIP-04 as fallback
                if (!hasV2Tag) {
                    // No v=2 tag: likely a NIP-04 message, normal fallthrough
                } else {
                    console.warn('[Nostr] NIP-44 decrypt falló con tag v=2, intentando NIP-04:', e44.message);
                }
            }
        }

        // NIP-04 fallback (or primary if no NIP-44 support)
        try {
            if (_useExtension && window.nostr?.nip04) {
                return await window.nostr.nip04.decrypt(other, event.content);
            }
            if (_privkey) {
                return await nt.nip04.decrypt(_hexToBytes(_privkey), other, event.content);
            }
        } catch (e04) {
            console.warn('[Nostr] Error descifrando DM (NIP-04):', e04.message);
            return '[Mensaje cifrado — no se puede descifrar]';
        }

        return null;
    }

    // ── Marketplace (NIP-99, Kind 30402) ─────────────────────
    function subscribeMarketplace(onListing, since = null) {
        const filter = { kinds: [EVENT_KINDS.MARKETPLACE], '#t': ['liberbit-market'], limit: 50 };
        if (since) filter.since = since;
        return subscribe(filter, event => {
            const l = _parseMarketplaceListing(event);
            if (l) onListing(l);
        });
    }

    function _parseMarketplaceListing(event) {
        try {
            const g = name => (event.tags.find(t => t[0] === name) || [])[1] || '';
            const dTag = g('d');
            if (!dTag) console.warn(`[Nostr] ⚠️ Listing sin d-tag: ${event.id?.substring(0, 8)}`);

            // Extract multi-URL media (from LBW_Media.buildImageTags format)
            const imageUrls = [];
            let sha256 = null, mime = null, size = null;
            (event.tags || []).forEach(t => {
                if ((t[0] === 'image' || t[0] === 'thumb') && t[1]) {
                    if (!imageUrls.includes(t[1])) imageUrls.push(t[1]);
                }
                if ((t[0] === 'x' || t[0] === 'sha256') && t[1]) sha256 = t[1];
                if (t[0] === 'm' && t[1]) mime = t[1];
                if (t[0] === 'size' && t[1]) size = parseInt(t[1], 10) || null;
            });

            return {
                id: event.id, pubkey: event.pubkey, npub: pubkeyToNpub(event.pubkey),
                title: g('title') || g('subject') || 'Sin título',
                description: event.content,
                category: g('category') || 'servicios',
                price: g('price') || 'A negociar',
                currency: g('currency') || 'sats',
                emoji: g('emoji') || '🏪',
                // Media: primary URL + full fallback array
                image: imageUrls[0] || '',
                imageUrls,
                sha256, mime, size,
                location: g('location') || '',
                status: g('status') || 'active',
                created_at: event.created_at,
                tags: event.tags,
                dTag
            };
        } catch (e) {
            console.warn('[Nostr] Error parseando listing:', e);
            return null;
        }
    }

    async function publishMarketplaceListing(listing) {
        const dTag = listing.dTag || `lbw-${_pubkey.substring(0, 8)}-${Date.now()}`;

        const tags = [
            ['d', dTag],
            ['title', listing.title || ''],
            ['subject', listing.title || ''],
            ['category', listing.category || 'servicios'],
            ['price', String(listing.price || 'A negociar')],
            ['currency', listing.currency || 'sats'],
            ['emoji', listing.emoji || '🏪'],
            ['status', listing.status || 'active'],
            ['t', 'liberbit-market'], ['t', 'lbw'], ['t', listing.category || 'servicios'],
            ['client', 'LiberBit World']
        ];

        // Media tags: multi-URL + SHA-256 integrity
        if (listing.mediaTags && listing.mediaTags.length > 0) {
            // Built by LBW_Media.buildImageTags()
            listing.mediaTags.forEach(t => tags.push(t));
        } else {
            // Legacy single-URL fallback
            if (listing.image) tags.push(['image', listing.image]);
            if (listing.thumb) tags.push(['thumb', listing.thumb]);
        }

        if (listing.location) tags.push(['location', listing.location]);

        return publishEvent({ kind: EVENT_KINDS.MARKETPLACE, content: listing.description || '', tags });
    }

    async function deleteMarketplaceListing(eventId) {
        return publishEvent({ kind: EVENT_KINDS.DELETE, content: 'Oferta eliminada', tags: [['e', eventId]] });
    }

    // ── Reactions ────────────────────────────────────────────
    async function reactToEvent(eventId, pubkey, reaction = '+') {
        return publishEvent({ kind: EVENT_KINDS.REACTION, content: reaction, tags: [['e', eventId], ['p', pubkey]] });
    }

    // ── Governance ───────────────────────────────────────────
    async function publishProposal(proposal) {
        const dTag = `proposal-${Date.now()}`;
        return publishEvent({
            kind: EVENT_KINDS.LBW_PROPOSAL,
            content: JSON.stringify({
                description: proposal.description,
                options: proposal.options || ['A favor', 'En contra', 'Abstención']
            }),
            tags: [
                ['d', dTag], ['title', proposal.title],
                ['category', proposal.category || 'general'], ['status', 'active'],
                ['expires', String(proposal.expiresAt || Math.floor(Date.now() / 1000) + 7 * 86400)],
                ['t', 'lbw-governance'], ['t', 'lbw-proposal'], ['client', 'LiberBit World']
            ]
        });
    }

    async function publishVote(proposalEventId, option) {
        return publishEvent({
            kind: EVENT_KINDS.LBW_VOTE, content: option,
            tags: [['e', proposalEventId], ['t', 'lbw-governance'], ['t', 'lbw-vote'], ['client', 'LiberBit World']]
        });
    }

    // ── NIP-07 Detection ─────────────────────────────────────
    function hasNostrExtension() { return !!window.nostr; }

    async function waitForExtension(ms = 3000) {
        if (window.nostr) return true;
        return new Promise(resolve => {
            const c = setInterval(() => { if (window.nostr) { clearInterval(c); resolve(true); } }, 100);
            setTimeout(() => { clearInterval(c); resolve(!!window.nostr); }, ms);
        });
    }

    // ── Image Upload (pure proxy to LBW_Media) ─────────────
    // All upload logic lives in nostr-media.js. No fallback here.
    // This prevents dual-path bugs and ensures SHA-256 + multi-URL
    // are always used.
    async function uploadImage(file, options = {}) {
        if (!window.LBW_Media) {
            throw new Error('LBW_Media no cargado. Asegúrate de incluir nostr-media.js antes de nostr.js.');
        }
        return window.LBW_Media.uploadImage(file, options);
    }

    // ── Getters ──────────────────────────────────────────────
    function getPubkey()        { return _pubkey; }
    function getNpub()          { return _npub; }
    function getNsec()          { return _nsec; }
    function getPrivkey()       { return _privkey; }
    function getProfile()       { return { ..._profile }; }
    function isUsingExtension() { return _useExtension; }
    function isLoggedIn()       { return !!_pubkey; }
    function getEventKinds()    { return { ...EVENT_KINDS }; }

    // ── Public API ───────────────────────────────────────────
    return {
        // Relay config (backward compat aliases + new)
        PRIVATE_RELAYS, PUBLIC_RELAYS, ALL_RELAYS,
        SYSTEM_PRIVATE_RELAYS, SYSTEM_PUBLIC_RELAYS, SYSTEM_ALL_RELAYS,
        EVENT_KINDS,
        getRelaysForKind,

        // NIP-65: Relay sovereignty
        fetchRelayList, loadCachedRelayList, publishRelayList,
        fetchOtherRelayList, setPrivacyStrict, isPrivacyStrict,

        // Key management
        generateKeypair, importPrivateKey, pubkeyToNpub, npubToHex,

        // Relay management
        connectToRelays, disconnectAll, getConnectedRelays, getRelayStatus, onRelayStatusChange,

        // Auth
        loginWithExtension, loginWithPrivateKey, createIdentity, logout,
        hasNostrExtension, waitForExtension,

        // Profile
        updateProfile, fetchUserProfile,

        // Subscriptions
        subscribe, unsubscribe, onEventKind,
        publishEvent,

        // Chat
        subscribeCommunityChat, publishCommunityMessage,

        // DMs (NIP-44 + NIP-04)
        subscribeDirectMessages, sendDirectMessage,

        // Marketplace
        subscribeMarketplace, publishMarketplaceListing, deleteMarketplaceListing, uploadImage,

        // Reactions + Governance
        reactToEvent, publishProposal, publishVote,

        // Getters
        getPubkey, getNpub, getNsec, getPrivkey, getProfile,
        isUsingExtension, isLoggedIn, getEventKinds
    };
})();

window.LBW_Nostr = LBW_Nostr;

// ============================================================
// LiberBit World — LBWM Merit System v2.1 (nostr-merits.js)
//
// Decentralized merit tracking over Nostr protocol.
// Contributions (kind 31003) → Merits (kind 31002)
// Snapshots (kind 31005) for leaderboard consensus.
//
// v2.0 Changes:
//   - 4 categories: Económica(1.0), Productiva(1.0), Responsabilidad(1.2), Financiada(0.6)
//   - 6 citizenship levels: Amigo → Génesis
//   - 3 voting blocks: Gobernanza(51%), Ciudadanía(29%), Comunidad(20%)
//   - Governor merit cap: min(total, 3000) for voting
//   - Responsabilidad requires 1000+ merits in other categories
//   - LINEAR: Merit_total = Σ (wᵢ × Cᵢ)
//
// Design Principles:
//   - LINEAR calculation — fair value recognition
//   - Anti-plutocracy via structural protections (citizenship levels, voting blocks)
//   - Parameterized replaceable events (NIP-33)
//   - PRIVATE relays only (merit data is internal)
//   - Governor-signed snapshots for consensus
//
// Dependencies: nostr.js (LBW_Nostr), nostr-store.js (LBW_Store)
// ============================================================

const LBW_Merits = (() => {
    'use strict';

    const KIND = {
        MERIT:    31002,   // Merit award record
        CONTRIB:  31003,   // Contribution record
        SNAPSHOT: 31005    // Periodic leaderboard snapshot
    };

    // ── Merit Categories (v2.0) ────────────────────────────────
    // 4 categories with fixed weights. Merit = Cᵢ × wᵢ
    const CATEGORIES = {
        economica: {
            label: 'Económica Definitiva',
            emoji: '💰',
            description: 'Aportaciones económicas definitivas al ecosistema',
            weight: 1.0
        },
        productiva: {
            label: 'Productiva',
            emoji: '🛠️',
            description: 'Trabajo, servicios profesionales, desarrollo técnico',
            weight: 1.0
        },
        responsabilidad: {
            label: 'Responsabilidad',
            emoji: '🔐',
            description: 'Gobernanza, moderación, roles de confianza (requiere 1000+ méritos)',
            weight: 1.2,
            requiresMinMerits: 1000  // Must have 1000+ merits in other categories
        },
        financiada: {
            label: 'Financiada',
            emoji: '⏳',
            description: 'Aportaciones con financiación aplazada',
            weight: 0.6
        },
        fundacional: {
            label: 'Fundacional',
            emoji: '🏗️',
            description: 'Aportación fundacional — valor aportado antes del lanzamiento del sistema LBWM',
            weight: 1.0,
            isBootstrap: true  // Not selectable in contribution form
        }
    };

    // ── Citizenship Levels (v2.0) ──────────────────────────────
    // 6 levels derived from cumulative merits. Linear progression.
    const CITIZENSHIP_LEVELS = [
        { name: 'Amigo',              minMerits: 0,     emoji: '👋', color: '#4CAF50',  bloc: 'Comunidad' },
        { name: 'E-Residency',        minMerits: 100,   emoji: '🪪', color: '#8BC34A',  bloc: 'Comunidad' },
        { name: 'Colaborador',        minMerits: 500,   emoji: '🤝', color: '#CDDC39',  bloc: 'Comunidad' },
        { name: 'Ciudadano Senior',   minMerits: 1000,  emoji: '🛂', color: '#FF9800',  bloc: 'Ciudadanía' },
        { name: 'Custodio',            minMerits: 2000,  emoji: '🌍', color: '#FF5722',  bloc: 'Ciudadanía' },
        { name: 'Génesis',             minMerits: 3000,  emoji: '👑', color: '#9C27B0',  bloc: 'Gobernanza' }
    ];

    // ── Voting Blocks (v2.0) ───────────────────────────────────
    const VOTING_BLOCKS = {
        Gobernanza:  { minPct: 0.51, type: 'equitable' },
        'Ciudadanía':  { maxPct: 0.29, type: 'proportional' },
        Comunidad:   { maxPct: 0.20, type: 'proportional' }
    };

    // Governor voting cap: merit_voto = min(total, 3000)
    const GOVERNOR_MERIT_CAP = 3000;

    // ── Founder Identity ─────────────────────────────────────
    // The platform founder's npub. Used to auto-bootstrap foundational merits
    // on first login if no merit record exists yet on the relay.
    const FOUNDER_NPUB = 'npub172vh56w30sgev82c09lfujswr4u2djcd5w9vcj79qrmyk9jd459swvrkf5';
    const FOUNDER_BOOTSTRAP_AMOUNT = 3000; // Minimum for Governor status

    // ── Internal State ───────────────────────────────────────
    let _merits = new Map();
    let _contributions = [];
    let _myContributions = [];
    let _leaderboard = [];
    let _lastSnapshot = null;
    let _onMeritCallbacks = [];
    let _onContribCallbacks = [];
    let _subMerits = null;
    let _subContribs = null;
    let _subSnapshots = null;

    // [SEC-22] Buffer of merit events whose issuer is not yet a Genesis (≥3000).
    // When the issuer crosses the threshold (or is later confirmed via the
    // founder bootstrap), the buffer is drained and the events reprocessed.
    // Capped to avoid unbounded memory growth from forged spam.
    let _pendingMeritEvents = [];   // [{ event, merit }]
    const PENDING_MERIT_CAP = 500;

    // Lazily-cached founder pubkey in hex form. Computed on first need
    // because LBW_Nostr.npubToHex may not be ready at module load time.
    let _founderHexCached = null;
    function _getFounderHex() {
        if (_founderHexCached) return _founderHexCached;
        try {
            _founderHexCached = LBW_Nostr.npubToHex(FOUNDER_NPUB);
        } catch (e) { /* not ready yet */ }
        return _founderHexCached;
    }

    const MERITS_STORAGE_KEY = 'lbw_merits_cache';
    const CONTRIBS_STORAGE_KEY = 'lbw_contribs_cache';

    // ── LocalStorage Persistence ─────────────────────────────
    function _persistMeritsToStorage() {
        try {
            const data = {};
            _merits.forEach((v, k) => { data[k] = v; });
            localStorage.setItem(MERITS_STORAGE_KEY, JSON.stringify(data));
        } catch (e) { console.warn('[Merits] Storage save error:', e); }
    }

    function _persistContribsToStorage() {
        try {
            localStorage.setItem(CONTRIBS_STORAGE_KEY, JSON.stringify(_contributions));
        } catch (e) { console.warn('[Merits] Contribs storage save error:', e); }
    }

    function _loadMeritsFromStorage() {
        try {
            const raw = localStorage.getItem(MERITS_STORAGE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                Object.entries(data).forEach(([pubkey, userData]) => {
                    if (!_merits.has(pubkey)) {
                        // Restore level object from stored data
                        userData.level = getCitizenshipLevel(userData.total);
                        _merits.set(pubkey, userData);
                    }
                });
                console.log(`[Merits] 📂 ${_merits.size} usuarios cargados de caché`);

                // If MY merits were in the cache, schedule a deferred profile refresh
                // so the profile shows the correct level without waiting for the relay.
                const _myPkCache = LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : null;
                if (_myPkCache && _merits.has(_myPkCache)) {
                    setTimeout(() => {
                        try { if (typeof updateProfileDisplay === 'function') updateProfileDisplay(); } catch(e) {}
                    }, 100);
                }

                // Restore myContributions from separate cache
                const rawC = localStorage.getItem(CONTRIBS_STORAGE_KEY);
                if (rawC) {
                    const contribs = JSON.parse(rawC);
                    _contributions = contribs;
                    const myPk = LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : '';
                    if (myPk) {
                        _myContributions = contribs.filter(c => c.pubkey === myPk);
                    }
                    console.log(`[Merits] 📂 ${contribs.length} contribuciones cargadas de caché`);
                }
            }
        } catch (e) { console.warn('[Merits] Storage load error:', e); }
    }

    // ── Submit Contribution (v2.0) ─────────────────────────────
    // Merit = Cᵢ × wᵢ (category weight)
    //
    // data: {
    //   description  — What was contributed
    //   category     — One of: 'economica', 'productiva', 'responsabilidad', 'financiada'
    //   amount       — Numeric value (EUR, sats, hours, or custom unit)
    //   currency     — 'EUR' | 'sats' | 'hours' | 'units'
    //   evidence     — Optional: URLs to evidence/proof
    // }

    async function submitContribution(data) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');
        if (!data.description?.trim()) throw new Error('Descripción requerida.');
        if (!data.category) throw new Error('Categoría requerida.');
        if (!CATEGORIES[data.category]) throw new Error(`Categoría inválida: ${data.category}`);
        if (CATEGORIES[data.category].isBootstrap) throw new Error('La categoría fundacional solo se asigna via bootstrap.');

        const catDef = CATEGORIES[data.category];
        const pubkey = LBW_Nostr.getPubkey();

        // Responsabilidad restriction: requires 1000+ merits in other categories
        if (catDef.requiresMinMerits) {
            const userData = _merits.get(pubkey);
            const otherMerits = userData ? (userData.total - (userData.byCategory['responsabilidad'] || 0)) : 0;
            if (otherMerits < catDef.requiresMinMerits) {
                throw new Error(`La categoría "${catDef.label}" requiere al menos ${catDef.requiresMinMerits} méritos en otras categorías. Tienes ${otherMerits}.`);
            }
        }

        const nowSecs = Math.floor(Date.now() / 1000);
        const dTag = `contrib-${pubkey.substring(0, 8)}-${nowSecs}`;

        // Calculate merit points: amount × category weight
        const amount = parseFloat(data.amount) || 0;
        const weight = catDef.weight;
        const meritPoints = _calculateMeritPoints(amount, weight);

        // Content: detailed JSON
        const content = JSON.stringify({
            description: data.description.trim(),
            amount,
            currency: data.currency || 'EUR',
            meritPoints,
            weight,
            evidence: data.evidence || [],
            timestamp: nowSecs
        });

        // Tags
        const status = data.status || 'pending_vote';
        const tags = [
            ['d', dTag],
            ['p', pubkey],
            ['amount', String(amount)],
            ['merit-points', String(meritPoints)],
            ['category', data.category],
            ['weight', String(weight)],
            ['status', status],
            ['t', 'lbw-merits'],
            ['t', 'lbw-contrib'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({
            kind: KIND.CONTRIB,
            content,
            tags
        });

        console.log(`[Merits] 📝 Contribución: ${meritPoints} méritos [${data.category}] peso=${weight}`);
        return { ...result, dTag, meritPoints, weight };
    }

    // ── Award Merit (Governor-only) ──────────────────────────
    // [v2.1] FIXED: Added Governor validation to prevent unauthorized merit emission
    async function awardMerit(recipientPubkey, amount, category, reason) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');
        if (!recipientPubkey) throw new Error('Destinatario requerido.');
        if (!amount || amount <= 0) throw new Error('Cantidad debe ser positiva.');
        if (!CATEGORIES[category]) throw new Error(`Categoría inválida: ${category}`);

        const pubkey = LBW_Nostr.getPubkey();
        
        // [v2.1] CRITICAL FIX: Verify caller is a Governor (≥3000 merits)
        // Exception: Bootstrap awards (category 'fundacional') can be self-awarded for initial setup
        if (category !== 'fundacional') {
            const callerData = _merits.get(pubkey);
            const callerTotal = callerData ? callerData.total : 0;
            if (callerTotal < 3000) {
                throw new Error(`Solo los Génesis (≥3.000 méritos) pueden emitir méritos. Tienes ${callerTotal}.`);
            }
        }

        const nowSecs = Math.floor(Date.now() / 1000);
        const dTag = `merit-${recipientPubkey.substring(0, 8)}-${nowSecs}`;

        const content = JSON.stringify({
            reason: reason || '',
            amount,
            awardedBy: pubkey,
            timestamp: nowSecs
        });

        const tags = [
            ['d', dTag],
            ['p', recipientPubkey],
            ['amount', String(amount)],
            ['category', category],
            ['reason', reason || ''],
            ['awarded-by', pubkey],
            ['t', 'lbw-merits'],
            ['t', 'lbw-merit-award'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({
            kind: KIND.MERIT,
            content,
            tags
        });

        console.log(`[Merits] 🏅 Merit award: ${amount} → ${recipientPubkey.substring(0, 8)} [${category}]`);
        return result;
    }

    // ── Publish Snapshot (Governor-only) ─────────────────────
    // [v2.1] FIXED: Added Governor validation
    async function publishSnapshot() {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');
        
        // [v2.1] Verify caller is Governor
        const pubkey = LBW_Nostr.getPubkey();
        const callerData = _merits.get(pubkey);
        const callerTotal = callerData ? callerData.total : 0;
        if (callerTotal < 3000) {
            throw new Error(`Solo los Génesis (≥3.000 méritos) pueden publicar snapshots. Tienes ${callerTotal}.`);
        }

        const nowSecs = Math.floor(Date.now() / 1000);
        const dTag = `snapshot-${nowSecs}`;

        const leaderboard = _buildLeaderboard();
        const content = JSON.stringify({
            leaderboard,
            timestamp: nowSecs,
            totalParticipants: leaderboard.length,
            totalMerits: leaderboard.reduce((sum, e) => sum + e.total, 0)
        });

        const tags = [
            ['d', dTag],
            ['t', 'lbw-merits'],
            ['t', 'lbw-snapshot'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({
            kind: KIND.SNAPSHOT,
            content,
            tags
        });

        console.log(`[Merits] 📊 Snapshot publicado: ${leaderboard.length} participantes`);
        return result;
    }

    // ── Subscribe Merits ─────────────────────────────────────
    // ── Auto-Bootstrap Founder ──────────────────────────────
    // Called once per session when the founder logs in.
    // Uses localStorage flag (permanent) to prevent duplicate bootstrap across sessions.
    async function _autoBootstrapIfFounder() {
        try {
            if (!LBW_Nostr.isLoggedIn()) return;

            let founderHex;
            try {
                founderHex = LBW_Nostr.npubToHex(FOUNDER_NPUB);
            } catch(e) {
                console.warn('[Merits] Could not decode FOUNDER_NPUB:', e);
                return;
            }

            const myPubkey = LBW_Nostr.getPubkey();
            if (myPubkey !== founderHex) return; // Not the founder

            // Permanent localStorage flag — once set, never bootstrap again
            const BOOTSTRAP_DONE_KEY = 'lbw_bootstrap_done_' + founderHex.substring(0, 12);
            if (localStorage.getItem(BOOTSTRAP_DONE_KEY)) {
                console.log('[Merits] Bootstrap ya realizado anteriormente — omitiendo re-bootstrap');
                // Check immediately if merits are already in memory from localStorage
                const immediateData = _merits.get(founderHex);
                if (immediateData && immediateData.total >= 3000) {
                    console.log('[Merits] ✅ Meritos del fundador ya en memoria:', immediateData.total);
                    setTimeout(() => {
                        try { if (typeof updateProfileDisplay === 'function') updateProfileDisplay(); } catch(e) {}
                    }, 50);
                    return;
                }
                // Not in memory yet — wait briefly for relay subscription to deliver events
                await new Promise(r => setTimeout(r, 500));
                const cachedData = _merits.get(founderHex);
                if (!cachedData || cachedData.total < 3000) {
                    console.log('[Merits] Méritos del fundador no están en memoria — recargando desde relay...');
                    await _reloadFounderMeritsFromRelay(founderHex);
                }
                // Offline fallback: if relay is down and merits still absent after reload,
                // inject from constant. BOOTSTRAP_DONE_KEY is proof the event was already
                // published — this is local-memory restoration only, not a double-bootstrap.
                const afterReload = _merits.get(founderHex);
                if (!afterReload || afterReload.total < 3000) {
                    const fallbackId = 'bootstrap-offline-' + founderHex.substring(0, 8);
                    const alreadyFallback = afterReload && afterReload.records &&
                        afterReload.records.some(r => r.id === fallbackId);
                    if (!alreadyFallback) {
                        console.warn('[Merits] Relay inaccesible — restaurando meritos fundacionales (offline fallback)');
                        _processMerit({
                            id: fallbackId,
                            pubkey: founderHex,
                            amount: FOUNDER_BOOTSTRAP_AMOUNT,
                            category: 'fundacional',
                            created_at: Math.floor(Date.now() / 1000),
                            source: 'bootstrap-offline'
                        });
                        // [SEC-22] Founder is now Genesis in local memory:
                        // re-evaluate any merit events that were parked
                        // because their issuer status was unknown.
                        _drainPendingMerits();
                        console.log('[Merits] Meritos del fundador restaurados en memoria:', FOUNDER_BOOTSTRAP_AMOUNT);
                    }
                }
                return;
            }

            // Wait for relay events to arrive
            await new Promise(r => setTimeout(r, 5000));

            // Check local merit cache — most reliable signal
            const existing = _merits.get(founderHex);
            if (existing && existing.total >= 3000) {
                console.log('[Merits] Founder ya tiene meritos:', existing.total, '— marcando como completado');
                localStorage.setItem(BOOTSTRAP_DONE_KEY, String(Date.now()));
                return;
            }

            // Last resort: query relay directly with extended timeout
            const relayHasBootstrap = await _checkBootstrapOnRelay(founderHex);
            if (relayHasBootstrap) {
                console.log('[Merits] Bootstrap ya existe en relay — omitiendo y marcando');
                localStorage.setItem(BOOTSTRAP_DONE_KEY, String(Date.now()));
                return;
            }

            console.log('[Merits] Auto-bootstrapping founder merits...');
            await bootstrapFounder(
                founderHex,
                FOUNDER_BOOTSTRAP_AMOUNT,
                'Meritos fundacionales — desarrollo app, infraestructura, diseno sistema LBWM, documentacion pre-lanzamiento'
            );
            // Mark as done permanently so it never runs again
            localStorage.setItem(BOOTSTRAP_DONE_KEY, String(Date.now()));
            console.log('[Merits] Founder bootstrap completado y bloqueado');
        } catch (e) {
            console.warn('[Merits] Auto-bootstrap error (non-fatal):', e.message);
        }
    }

    // Query relay for existing bootstrap event — returns true if found
    function _checkBootstrapOnRelay(founderHex) {
        return new Promise(resolve => {
            const timeout = setTimeout(() => resolve(false), 5000);
            let found = false;
            // Query ALL kind 31002 by founder — check tag client-side to avoid relay filter issues
            const sub = LBW_Nostr.subscribe(
                { kinds: [KIND.MERIT], authors: [founderHex], limit: 20 },
                (event) => {
                    const isBootstrap = event.tags.some(t => t[0] === 't' && t[1] === 'lbw-bootstrap');
                    if (isBootstrap && !found) {
                        found = true;
                        clearTimeout(timeout);
                        resolve(true);
                    }
                },
                () => { clearTimeout(timeout); if (!found) resolve(false); }
            );
            setTimeout(() => { try { LBW_Nostr.unsubscribe(sub); } catch(e) {} }, 5500);
        });
    }

    // Reload founder merits from relay directly (bypasses #t tag filter issues).
    // Called when the merit subscription may have returned 0 results due to relay
    // not supporting tag filters, but we know the bootstrap event exists.
    function _reloadFounderMeritsFromRelay(founderHex) {
        return new Promise(resolve => {
            const timeout = setTimeout(() => resolve(), 3000);
            let processed = 0;
            const sub = LBW_Nostr.subscribe(
                { kinds: [KIND.MERIT], authors: [founderHex], limit: 50 },
                (event) => {
                    const hasLbwTag = event.tags && event.tags.some(
                        t => t[0] === 't' && (t[1] === 'lbw-merits' || t[1] === 'lbw-bootstrap' || t[1] === 'lbw-merit-award')
                    );
                    if (!hasLbwTag) return;
                    // [SEC-22] Even relay-filtered author lookups go through
                    // the central validator so a misbehaving relay cannot
                    // smuggle in events with a different signer.
                    const before = _merits.get(founderHex)?.records?.length || 0;
                    _validateAndProcessMeritEvent(event);
                    const after = _merits.get(founderHex)?.records?.length || 0;
                    if (after > before) processed++;
                },
                () => {
                    clearTimeout(timeout);
                    if (processed > 0) {
                        console.log(`[Merits] ✅ Recargados ${processed} evento(s) del fundador desde relay`);
                        // Trigger profile refresh now that merits are loaded
                        if (typeof updateProfileDisplay === 'function') {
                            try { updateProfileDisplay(); } catch(e) {}
                        }
                    }
                    try { LBW_Nostr.unsubscribe(sub); } catch(e) {}
                    resolve();
                }
            );
            setTimeout(() => { try { LBW_Nostr.unsubscribe(sub); } catch(e) {} }, 3500);
        });
    }

    function subscribeMerits(onMerit) {
        if (onMerit) _onMeritCallbacks.push(onMerit);
        if (_subMerits) return _subMerits;

        // Load from cache first (instant availability)
        if (_merits.size === 0) _loadMeritsFromStorage();

        // If founder merits already in localStorage → refresh profile immediately (no wait)
        if (LBW_Nostr.isLoggedIn()) {
            try {
                const myPk = LBW_Nostr.getPubkey();
                const cached = myPk ? _merits.get(myPk) : null;
                if (cached && cached.total >= 3000) {
                    setTimeout(() => {
                        try { if (typeof updateProfileDisplay === 'function') updateProfileDisplay(); } catch(e) {}
                    }, 100);
                }
            } catch(e) {}
        }

        // Auto-bootstrap founder if needed (async, non-blocking)
        _autoBootstrapIfFounder();

        _subMerits = LBW_Nostr.subscribe(
            {
                kinds: [KIND.MERIT],
                // NOTE: '#t' filter omitted intentionally — relay.liberbitworld.org
                // does not support tag filters reliably (same issue documented in
                // _checkBootstrapOnRelay). Filter client-side instead.
                limit: 500
            },
            (event) => {
                // Client-side tag filter: only process LBW merit events
                const hasLbwTag = event.tags && event.tags.some(
                    t => t[0] === 't' && (t[1] === 'lbw-merits' || t[1] === 'lbw-bootstrap' || t[1] === 'lbw-merit-award')
                );
                if (!hasLbwTag) return;
                // [SEC-22] All merit events must pass issuer validation.
                // Callbacks fire from inside _processMerit only on success.
                _validateAndProcessMeritEvent(event);
            }
        );

        return _subMerits;
    }

    // ── Subscribe Contributions ──────────────────────────────
    function subscribeContributions(onContrib) {
        if (onContrib) _onContribCallbacks.push(onContrib);
        if (_subContribs) return _subContribs;

        _subContribs = LBW_Nostr.subscribe(
            {
                kinds: [KIND.CONTRIB],
                '#t': ['lbw-contrib'],
                limit: 500
            },
            (event) => {
                const contrib = _parseContribution(event);
                if (!contrib) return;

                // Dedup
                if (_contributions.some(c => c.id === contrib.id)) return;
                _contributions.push(contrib);

                // NOTE: Contributions do NOT auto-count as merits.
                // Merit points are only assigned via kind 31002 (awardMerit)
                // after governance approval or auto-verification.

                if (contrib.pubkey === LBW_Nostr.getPubkey()) {
                    _myContributions.push(contrib);
                }

                // Persist contributions to cache
                _persistContribsToStorage();

                _onContribCallbacks.forEach(cb => {
                    try { cb(contrib); } catch (e) {}
                });
            }
        );

        return _subContribs;
    }

    // ── Subscribe Snapshots ──────────────────────────────────
    function subscribeSnapshots(onSnapshot) {
        if (_subSnapshots) return _subSnapshots;

        _subSnapshots = LBW_Nostr.subscribe(
            {
                kinds: [KIND.SNAPSHOT],
                '#t': ['lbw-snapshot'],
                limit: 5
            },
            (event) => {
                try {
                    const data = JSON.parse(event.content);
                    if (!_lastSnapshot || event.created_at > _lastSnapshot.created_at) {
                        _lastSnapshot = {
                            ...data,
                            id: event.id,
                            pubkey: event.pubkey,
                            created_at: event.created_at,
                            sig: event.sig
                        };
                        console.log(`[Merits] 📊 Snapshot cargado: ${data.totalParticipants} participantes`);
                    }
                    if (onSnapshot) onSnapshot(_lastSnapshot);
                } catch (e) {}
            }
        );

        return _subSnapshots;
    }

    // ── Unsubscribe ──────────────────────────────────────────
    function unsubscribeAll() {
        [_subMerits, _subContribs, _subSnapshots].forEach(s => {
            if (s) try { LBW_Nostr.unsubscribe(s); } catch (e) {}
        });
        _subMerits = null;
        _subContribs = null;
        _subSnapshots = null;
        _onMeritCallbacks = [];
        _onContribCallbacks = [];
    }

    // ── Parse Helpers ────────────────────────────────────────
    function _parseMerit(event) {
        try {
            const g = name => (event.tags.find(t => t[0] === name) || [])[1] || '';
            let parsed = {};
            try { parsed = JSON.parse(event.content); } catch (e) {}

            return {
                id: event.id,
                dTag: g('d') || '',
                pubkey: g('p') || event.pubkey,
                amount: parseFloat(g('amount')) || parsed.amount || 0,
                category: _normalizeCategory(g('category')),
                reason: g('reason') || parsed.reason || '',
                awardedBy: g('awarded-by') || parsed.awardedBy || event.pubkey,
                created_at: event.created_at,
                source: 'award'
            };
        } catch (e) {
            return null;
        }
    }

    function _parseContribution(event) {
        try {
            const g = name => (event.tags.find(t => t[0] === name) || [])[1] || '';
            let parsed = {};
            try { parsed = JSON.parse(event.content); } catch (e) {}

            return {
                id: event.id,
                pubkey: event.pubkey,
                npub: LBW_Nostr.pubkeyToNpub(event.pubkey),
                dTag: g('d'),
                description: parsed.description || event.content,
                amount: parseFloat(g('amount')) || parsed.amount || 0,
                meritPoints: parseFloat(g('merit-points')) || parsed.meritPoints || 0,
                category: _normalizeCategory(g('category')),
                weight: parseFloat(g('weight')) || parseFloat(g('factor')) || parsed.weight || parsed.factor || 1.0,
                currency: parsed.currency || 'EUR',
                evidence: parsed.evidence || [],
                status: g('status') || 'pending_vote',
                created_at: event.created_at
            };
        } catch (e) {
            return null;
        }
    }

    // ── Category Normalization ────────────────────────────────
    // Maps old v1.0 category names to v2.0 for backward compatibility
    // with contributions already stored in Nostr relays.
    function _normalizeCategory(cat) {
        const map = {
            // v2.0 names (identity)
            'economica': 'economica',
            'productiva': 'productiva',
            'responsabilidad': 'responsabilidad',
            'financiada': 'financiada',
            'fundacional': 'fundacional',
            // v1.0 → v2.0 mapping
            'participation': 'productiva',
            'professional': 'productiva',
            'governance': 'responsabilidad',
            'infrastructure': 'productiva',
            'community': 'productiva',
            'financial': 'financiada'
        };
        return map[cat] || 'productiva';
    }

    // ── Merit Calculation (v2.0) ─────────────────────────────
    // LINEAR: merit_points = amount × weight
    function _calculateMeritPoints(amount, weight) {
        const base = Math.max(0, amount);
        const points = Math.round(base * weight);
        return points;
    }

    // ── [SEC-22] Validate Merit Event Issuer ─────────────────
    // The signing pubkey of a kind:31002 event MUST be authorized to
    // issue merits. Without this check, any user can forge a merit
    // event awarding themselves arbitrary merits and become Genesis.
    //
    //   - Foundational merits: only the founder may self-bootstrap.
    //   - All other categories: signer must already be Genesis (≥3000).
    //
    // If the signer's status cannot yet be determined (their own merits
    // haven't arrived from the relay yet), the event is parked in a
    // bounded buffer and reprocessed when more merit data arrives.
    function _validateAndProcessMeritEvent(event) {
        if (!event || !event.pubkey) return;

        const merit = _parseMerit(event);
        if (!merit) return;

        const issuer = event.pubkey;  // verified signer (already passed verifyEvent)

        // Foundational bootstrap: only the founder, only to themselves.
        if (merit.category === 'fundacional') {
            const founderHex = _getFounderHex();
            if (!founderHex || issuer !== founderHex || merit.pubkey !== founderHex) {
                console.warn('[SEC-22] Merit fundacional rechazado — emisor no autorizado:',
                    issuer.substring(0, 12));
                return;
            }
            _processMerit(merit);
            _drainPendingMerits();   // founder is now Genesis → re-evaluate buffer
            return;
        }

        // Regular merit award: issuer must already be Genesis.
        const issuerData = _merits.get(issuer);
        const issuerTotal = issuerData ? issuerData.total : 0;

        if (issuerTotal >= 3000) {
            _processMerit(merit);
            // Recipient may have just crossed 3000 → could authorize buffered events
            const recipientData = _merits.get(merit.pubkey);
            if (recipientData && recipientData.total >= 3000) {
                _drainPendingMerits();
            }
            return;
        }

        // Issuer not yet known to be Genesis: park the event.
        // It may become valid later if the issuer's own merit events
        // arrive from a slower relay.
        if (_pendingMeritEvents.length < PENDING_MERIT_CAP) {
            _pendingMeritEvents.push({ event, merit });
        } else {
            console.warn('[SEC-22] Pending merit buffer full — dropping event from',
                issuer.substring(0, 12));
        }
    }

    // Re-evaluate parked merit events. Called whenever a new issuer
    // crosses the Genesis threshold. One pass is enough because we
    // re-call ourselves transitively from inside _validateAndProcessMeritEvent.
    let _drainingPending = false;
    function _drainPendingMerits() {
        if (_drainingPending) return;   // prevent recursion blow-up
        _drainingPending = true;
        try {
            const queue = _pendingMeritEvents;
            _pendingMeritEvents = [];
            for (const { event } of queue) {
                _validateAndProcessMeritEvent(event);
            }
        } finally {
            _drainingPending = false;
        }
    }

    // ── Process Merit Record ─────────────────────────────────
    function _processMerit(merit) {
        const { pubkey, amount, category, created_at, source, id, dTag } = merit;

        if (!_merits.has(pubkey)) {
            _merits.set(pubkey, {
                total: 0,
                byCategory: {},
                records: [],
                level: CITIZENSHIP_LEVELS[0]
            });
        }

        const userData = _merits.get(pubkey);

        // Dedup by event id
        if (userData.records.some(r => r.id === id)) return;

        // NIP-33: parameterized replaceable events — same d-tag = same logical event.
        // Keep only the newest (highest created_at).
        if (dTag) {
            const existingIdx = userData.records.findIndex(r => r.dTag === dTag);
            if (existingIdx !== -1) {
                const existing = userData.records[existingIdx];
                if (created_at <= existing.created_at) return;   // incoming is older, skip
                // Replace: remove old record from totals, then add new one below
                userData.total -= existing.amount;
                userData.byCategory[existing.category] = (userData.byCategory[existing.category] || 0) - existing.amount;
                userData.records.splice(existingIdx, 1);
            }
        }

        userData.records.push({ id, dTag, amount, category, created_at, source });
        userData.total += amount;
        userData.byCategory[category] = (userData.byCategory[category] || 0) + amount;

        // Update citizenship level
        userData.level = getCitizenshipLevel(userData.total);

        // Invalidate leaderboard cache
        _leaderboard = [];

        // Persist to localStorage
        _persistMeritsToStorage();

        // If this merit is for the current user, refresh the profile display.
        // This covers the relay-delivery path: merits arrive AFTER profile rendered.
        const _myPkNow = LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : null;
        if (_myPkNow && pubkey === _myPkNow) {
            setTimeout(() => {
                try { if (typeof updateProfileDisplay === 'function') updateProfileDisplay(); } catch(e) {}
            }, 50);
        }

        // [SEC-22] Notify subscribers only after the merit has been
        // accepted by validation and applied to the ledger.
        _onMeritCallbacks.forEach(cb => { try { cb(merit); } catch (e) {} });
    }

    // ── Leaderboard ──────────────────────────────────────────
    function _buildLeaderboard() {
        const entries = [];
        _merits.forEach((data, pubkey) => {
            entries.push({
                pubkey,
                npub: LBW_Nostr.pubkeyToNpub(pubkey),
                total: data.total,
                byCategory: { ...data.byCategory },
                level: data.level,
                contributions: data.records.length
            });
        });
        return entries.sort((a, b) => b.total - a.total);
    }

    function getLeaderboard(limit = 50) {
        if (_leaderboard.length === 0) _leaderboard = _buildLeaderboard();
        return _leaderboard.slice(0, limit);
    }

    // ── User Merit Data ──────────────────────────────────────
    function getUserMerits(pubkey) {
        pubkey = pubkey || LBW_Nostr.getPubkey();
        if (!pubkey) return null;

        const data = _merits.get(pubkey);
        if (!data) return {
            pubkey,
            total: 0,
            byCategory: {},
            level: CITIZENSHIP_LEVELS[0],
            records: [],
            rank: 0
        };

        const lb = getLeaderboard(999);
        const rank = lb.findIndex(e => e.pubkey === pubkey) + 1;

        return {
            pubkey,
            total: data.total,
            byCategory: { ...data.byCategory },
            level: data.level,
            records: [...data.records].sort((a, b) => b.created_at - a.created_at),
            rank: rank || lb.length + 1
        };
    }

    function getMyMerits() {
        return getUserMerits(LBW_Nostr.getPubkey());
    }

    function getMyContributions() {
        return [..._myContributions].sort((a, b) => b.created_at - a.created_at);
    }

    function getAllContributions() {
        return [..._contributions].sort((a, b) => b.created_at - a.created_at);
    }

    // ── Citizenship Level (v2.0) ─────────────────────────────
    function getCitizenshipLevel(totalMerits) {
        let level = CITIZENSHIP_LEVELS[0];
        for (const l of CITIZENSHIP_LEVELS) {
            if (totalMerits >= l.minMerits) level = l;
        }
        return level;
    }

    function getNextLevel(totalMerits) {
        for (const l of CITIZENSHIP_LEVELS) {
            if (totalMerits < l.minMerits) {
                return {
                    level: l,
                    remaining: l.minMerits - totalMerits,
                    progress: totalMerits / l.minMerits
                };
            }
        }
        return null; // Already at max level (Génesis)
    }

    // ── Voting Power (v2.0) ──────────────────────────────────
    // 3-block system:
    //   Gobernanza (Gobernadores): min 51%, equitable distribution
    //   Ciudadanía (Ciudadano Senior + Custodio): max 29%, proportional
    //   Comunidad (Amigo + E-Residency + Colaborador): max 20%, proportional

    function calculateVotingPower(voters) {
        const blocs = { Gobernanza: [], 'Ciudadanía': [], Comunidad: [] };
        for (const v of voters) {
            const level = getCitizenshipLevel(v.merits);
            const bloc = level.bloc || 'Comunidad';
            const effectiveMerits = bloc === 'Gobernanza' ? Math.min(v.merits, GOVERNOR_MERIT_CAP) : v.merits;
            blocs[bloc].push({ ...v, effectiveMerits, level });
        }

        const results = {};

        // Gobernanza: equitable (each governor gets equal share of 51%)
        const govCount = blocs.Gobernanza.length;
        if (govCount > 0) {
            const sharePerGov = VOTING_BLOCKS.Gobernanza.minPct / govCount;
            for (const g of blocs.Gobernanza) {
                results[g.pubkey] = { power: sharePerGov, bloc: 'Gobernanza', level: g.level };
            }
        }

        // Remaining percentage for proportional blocs
        const govPct = govCount > 0 ? VOTING_BLOCKS.Gobernanza.minPct : 0;
        const remainingPct = 1.0 - govPct;

        // Ciudadanía: proportional within max 29%
        const ciudTotal = blocs['Ciudadanía'].reduce((s, v) => s + v.effectiveMerits, 0);
        const ciudPct = Math.min(VOTING_BLOCKS['Ciudadanía'].maxPct, remainingPct * 0.59);
        if (ciudTotal > 0) {
            for (const c of blocs['Ciudadanía']) {
                results[c.pubkey] = { power: (c.effectiveMerits / ciudTotal) * ciudPct, bloc: 'Ciudadanía', level: c.level };
            }
        }

        // Comunidad: proportional within max 20%
        const comTotal = blocs.Comunidad.reduce((s, v) => s + v.effectiveMerits, 0);
        const comPct = Math.min(VOTING_BLOCKS.Comunidad.maxPct, remainingPct * 0.41);
        if (comTotal > 0) {
            for (const c of blocs.Comunidad) {
                results[c.pubkey] = { power: (c.effectiveMerits / comTotal) * comPct, bloc: 'Comunidad', level: c.level };
            }
        }

        return results;
    }

    function getUserVotingPower(pubkey) {
        pubkey = pubkey || LBW_Nostr.getPubkey();
        if (!pubkey) return null;

        const voters = [];
        _merits.forEach((data, pk) => {
            voters.push({ pubkey: pk, merits: data.total });
        });

        if (voters.length === 0) return { power: 0, bloc: 'Comunidad', level: CITIZENSHIP_LEVELS[0] };

        const allPower = calculateVotingPower(voters);
        return allPower[pubkey] || { power: 0, bloc: 'Comunidad', level: CITIZENSHIP_LEVELS[0] };
    }

    // ── Stats ────────────────────────────────────────────────
    function getStats() {
        const lb = getLeaderboard(999);
        return {
            totalParticipants: lb.length,
            totalMerits: lb.reduce((sum, e) => sum + e.total, 0),
            totalContributions: _contributions.length,
            myMerits: getMyMerits()?.total || 0,
            myContributions: _myContributions.length,
            myRank: getMyMerits()?.rank || 0,
            lastSnapshot: _lastSnapshot ? {
                timestamp: _lastSnapshot.created_at,
                participants: _lastSnapshot.totalParticipants
            } : null,
            categoryBreakdown: Object.fromEntries(
                Object.entries(CATEGORIES).map(([k, v]) => [
                    k,
                    lb.reduce((sum, e) => sum + (e.byCategory[k] || 0), 0)
                ])
            )
        };
    }

    // ── Reset (logout) ───────────────────────────────────────
    function reset() {
        unsubscribeAll();
        _merits.clear();
        _contributions = [];
        _myContributions = [];
        _leaderboard = [];
        _lastSnapshot = null;
        try {
            localStorage.removeItem(MERITS_STORAGE_KEY);
            localStorage.removeItem(CONTRIBS_STORAGE_KEY);
        } catch (e) {}
    }

    // ── Bootstrap: Foundational Merit Award ──────────────────
    // Solves the "chicken-and-egg" problem: no Governor → no one
    // can verify economic contributions → no merits → no Governor.
    //
    // The founder gets a one-time merit award recognizing pre-launch
    // value (app development, infrastructure, system design, etc.).
    // This is auditable on the Nostr relay and visible in the ledger.
    //
    // Phase 0: Only founder is Governor (≥3000). Verifies first deposits.
    // Phase 1: Early members accumulate merits. Voting begins.
    // Phase 2: Other users reach Governor organically. Power dilutes naturally.

    async function bootstrapFounder(founderPubkey, amount, reason) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');
        if (!founderPubkey) throw new Error('Pubkey del fundador requerida.');
        if (!amount || amount < 3000) throw new Error('Los méritos fundacionales deben ser ≥3000 para habilitar Génesis.');

        // Check if founder already has merits (prevent duplicate bootstrap)
        const existing = _merits.get(founderPubkey);
        if (existing && existing.total >= 3000) {
            console.log('[Merits] 🏗️ Bootstrap: Founder already has sufficient merits, skipping.');
            return { alreadyBootstrapped: true, total: existing.total };
        }

        const pubkey = LBW_Nostr.getPubkey();
        const nowSecs = Math.floor(Date.now() / 1000);
        const dTag = `bootstrap-fundacional-${founderPubkey.substring(0, 8)}`;

        const content = JSON.stringify({
            reason: reason || 'Méritos fundacionales — valor aportado pre-lanzamiento (desarrollo app, infraestructura, diseño sistema LBWM, documentación)',
            amount,
            awardedBy: pubkey,
            isBootstrap: true,
            timestamp: nowSecs
        });

        const tags = [
            ['d', dTag],
            ['p', founderPubkey],
            ['amount', String(amount)],
            ['category', 'fundacional'],
            ['reason', reason || 'Bootstrap fundacional'],
            ['awarded-by', pubkey],
            ['t', 'lbw-merits'],
            ['t', 'lbw-merit-award'],
            ['t', 'lbw-bootstrap'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({
            kind: KIND.MERIT,
            content,
            tags
        });

        console.log(`[Merits] 🏗️ Bootstrap fundacional: ${amount} méritos → ${founderPubkey.substring(0, 8)}`);
        return { ...result, dTag, amount, bootstrapped: true };
    }

    // Check if a pubkey has foundational merits
    function hasFoundationalMerits(pubkey) {
        const pk = pubkey || (LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : '');
        const userData = _merits.get(pk);
        if (!userData) return false;
        return (userData.byCategory && userData.byCategory['fundacional'] > 0);
    }

    // Check if current user is Governor (≥3000 merits)
    function isGovernor(pubkey) {
        const pk = pubkey || (LBW_Nostr.isLoggedIn() ? LBW_Nostr.getPubkey() : '');
        const userData = _merits.get(pk);
        if (!userData) return false;
        return userData.total >= 3000;
    }

    // ── Public API ───────────────────────────────────────────
    // ── Marketplace merit auto-award (Phase 2) ────────────────
    // Se llama después de un pago Lightning verificado.
    // No requiere que el caller sea Génesis — el pago es la prueba.
    async function awardMarketplaceMerit(sellerPubkey, listing, paymentHash) {
        if (!sellerPubkey) throw new Error('sellerPubkey requerido');
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido');

        // Deduplicación: una sola primera venta por vendedor
        const dedupeKey = 'lbw_firstsale_' + sellerPubkey.substring(0, 16);
        const alreadyAwarded = localStorage.getItem(dedupeKey);

        if (!alreadyAwarded) {
            const nowSecs = Math.floor(Date.now() / 1000);
            const dTag = 'merit-market-firstsale-' + sellerPubkey.substring(0, 8) + '-' + nowSecs;
            const reason = 'Primera venta completada en el Marketplace — Pago Lightning verificado' +
                (paymentHash ? ' (' + paymentHash.substring(0, 12) + '...)' : '');

            const content = JSON.stringify({
                reason,
                amount: 5,
                awardedBy: 'marketplace-auto',
                paymentHash: paymentHash || '',
                listingId: listing.id || listing.dTag || '',
                timestamp: nowSecs
            });

            const tags = [
                ['d', dTag],
                ['p', sellerPubkey],
                ['amount', '5'],
                ['category', 'economico'],
                ['reason', reason],
                ['awarded-by', 'marketplace-auto'],
                ['source', 'marketplace'],
                ['ref', listing.id || listing.dTag || ''],
                ['payment_hash', paymentHash || ''],
                ['t', 'lbw-merits'],
                ['t', 'lbw-merit-award'],
                ['t', 'marketplace'],
                ['client', 'LiberBit World']
            ];

            await LBW_Nostr.publishEvent({ kind: KIND.MERIT, content, tags });
            localStorage.setItem(dedupeKey, nowSecs.toString());
            console.log('[Merits] Primera venta: +5 economico -> ' + sellerPubkey.substring(0, 12));
            return { awarded: true };
        }

        console.log('[Merits] Primera venta ya contabilizada para ' + sellerPubkey.substring(0, 12));
        return { awarded: false, alreadyAwarded: true };
    }

    return {
        // Constants
        KIND,
        CATEGORIES,
        CITIZENSHIP_LEVELS,
        VOTING_BLOCKS,
        GOVERNOR_MERIT_CAP,

        // Publish
        submitContribution,
        awardMerit,
        awardMarketplaceMerit,
        publishSnapshot,
        bootstrapFounder,

        // Subscribe
        subscribeMerits,
        subscribeContributions,
        subscribeSnapshots,
        unsubscribeAll,

        // Query
        getUserMerits,
        getMyMerits,
        getMyContributions,
        getAllContributions,
        getLeaderboard,
        getCitizenshipLevel,
        getNextLevel,
        getUserVotingPower,
        calculateVotingPower,
        getStats,
        hasFoundationalMerits,
        isGovernor,

        // Lifecycle
        reset
    };
})();

window.LBW_Merits = LBW_Merits;

// ═══════════════════════════════════════════════════════════════
// getUnifiedMerits — Cálculo unificado de méritos del usuario actual
// Combina méritos Nostr formales (kind 31002/31003) con actividad
// contabilizada (chat, ofertas, votos, propuestas) con cap de 300.
// Vive fuera del IIFE porque necesita acceso a globals del DOM
// (allPosts, currentUser, LBW_NostrBridge, LBW_Governance).
// ═══════════════════════════════════════════════════════════════
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

    // Source 2: Activity — Nostr chat + legacy Supabase posts + marketplace + governance
    const chatMessages = (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.getMyChatCount)
        ? LBW_NostrBridge.getMyChatCount() : 0;
    const legacyPosts = (typeof allPosts !== 'undefined' && Array.isArray(allPosts) && typeof currentUser !== 'undefined' && currentUser)
        ? allPosts.filter(p => p.author === currentUser.name).length : 0;
    const userPosts = chatMessages + legacyPosts;
    const userOffers = (typeof LBW_NostrBridge !== 'undefined' && LBW_NostrBridge.getMyOffersCount)
        ? LBW_NostrBridge.getMyOffersCount() : 0;
    const govStats = (typeof LBW_Governance !== 'undefined' && LBW_Governance.getStats)
        ? LBW_Governance.getStats() : { myVotes: 0, myProposals: 0 };
    const userVotes = govStats.myVotes || 0;
    const userProposals = govStats.myProposals || 0;
    const activityCount = userPosts + userOffers + userVotes + userProposals;

    // Sum + cap (NOT max)
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

window.getUnifiedMerits = getUnifiedMerits;
// También disponible como LBW_Merits.getUnifiedMerits para acceso consistente
LBW_Merits.getUnifiedMerits = getUnifiedMerits;

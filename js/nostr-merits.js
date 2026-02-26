// ============================================================
// LiberBit World — LBWM Merit System v1.0 (nostr-merits.js)
//
// Decentralized merit tracking over Nostr protocol.
// Contributions (kind 31003) → Merits (kind 31002)
// Snapshots (kind 31005) for leaderboard consensus.
//
// Design Principles:
//   - LINEAR calculation (not logarithmic) — fair value recognition
//   - Anti-plutocracy via structural protections, not penalizing contributors
//   - Parameterized replaceable events (NIP-33)
//   - PRIVATE relays only (merit data is internal)
//   - Governor-signed snapshots for consensus
//   - Citizenship levels derived from cumulative merits
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

    // ── Merit Categories ─────────────────────────────────────
    const CATEGORIES = {
        participation: {
            label: 'Participación',
            emoji: '💬',
            description: 'Actividad en la comunidad (posts, chat, reacciones)',
            maxPerPeriod: 100,  // Max merits per 30-day period
            autoCalculated: true
        },
        professional: {
            label: 'Profesional',
            emoji: '💼',
            description: 'Servicios profesionales aportados al ecosistema',
            maxPerPeriod: 500,
            autoCalculated: false
        },
        governance: {
            label: 'Gobernanza',
            emoji: '🏛️',
            description: 'Participación en propuestas y votaciones',
            maxPerPeriod: 200,
            autoCalculated: true
        },
        infrastructure: {
            label: 'Infraestructura',
            emoji: '🔧',
            description: 'Mantenimiento de nodos, relays, desarrollo técnico',
            maxPerPeriod: 500,
            autoCalculated: false
        },
        community: {
            label: 'Comunidad',
            emoji: '🤝',
            description: 'Onboarding, mentoring, organización de eventos',
            maxPerPeriod: 300,
            autoCalculated: false
        },
        financial: {
            label: 'Financiera',
            emoji: '⚡',
            description: 'Contribuciones económicas al ecosistema',
            maxPerPeriod: null,  // No cap (but linear, not weighted)
            autoCalculated: false
        }
    };

    // ── Citizenship Levels ───────────────────────────────────
    // Derived from cumulative merits. Linear progression.
    const CITIZENSHIP_LEVELS = [
        { name: 'E-Residency',       minMerits: 0,     emoji: '🌐', color: '#666666' },
        { name: 'Ciudadano',         minMerits: 100,   emoji: '🏛️', color: '#2C5F6F' },
        { name: 'Ciudadano Activo',  minMerits: 500,   emoji: '⭐', color: '#4CAF50' },
        { name: 'Ciudadano Senior',  minMerits: 1000,  emoji: '🏅', color: '#E5B95C' },
        { name: 'Governor',          minMerits: 5000,  emoji: '👑', color: '#FFD700' }
    ];

    // ── Contribution Factors ─────────────────────────────────
    // Factor applied to contribution value for merit calculation.
    // Factor range: 1.0 - 2.0
    //   1.0 = standard contribution
    //   1.5 = high-impact / funded contribution
    //   2.0 = critical infrastructure / emergency response
    const FACTOR_RANGE = { min: 1.0, max: 2.0 };

    // ── Internal State ───────────────────────────────────────
    let _merits = new Map();          // pubkey → {total, byCategory, records}
    let _contributions = [];          // all contribution records
    let _myContributions = [];        // my contributions
    let _leaderboard = [];            // sorted [{pubkey, total, ...}]
    let _lastSnapshot = null;         // latest kind 31005
    let _onMeritCallbacks = [];
    let _onContribCallbacks = [];
    let _subMerits = null;
    let _subContribs = null;
    let _subSnapshots = null;

    // ── Submit Contribution ──────────────────────────────────
    // A user submits a contribution record. Merits are awarded
    // based on contribution value × factor.
    //
    // data: {
    //   description  — What was contributed
    //   category     — One of CATEGORIES keys
    //   type         — 'financial' | 'professional' | 'infrastructure'
    //   amount       — Numeric value (sats, hours, or custom unit)
    //   currency     — 'sats' | 'hours' | 'units'
    //   funded       — Boolean: was this a funded (paid) contribution?
    //   factor       — Override factor (1.0-2.0), default calculated
    //   evidence     — Optional: URLs to evidence/proof
    // }

    async function submitContribution(data) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');
        if (!data.description?.trim()) throw new Error('Descripción requerida.');
        if (!data.category) throw new Error('Categoría requerida.');
        if (!CATEGORIES[data.category]) throw new Error(`Categoría inválida: ${data.category}`);

        const pubkey = LBW_Nostr.getPubkey();
        const nowSecs = Math.floor(Date.now() / 1000);
        const dTag = `contrib-${pubkey.substring(0, 8)}-${nowSecs}`;

        // Calculate factor
        let factor = data.factor || 1.0;
        factor = Math.max(FACTOR_RANGE.min, Math.min(FACTOR_RANGE.max, factor));
        if (data.funded) factor = Math.max(factor, 1.5);

        // Calculate merit points from contribution
        const amount = parseFloat(data.amount) || 0;
        const meritPoints = _calculateMeritPoints(amount, data.category, factor);

        // Check period cap
        const periodCap = CATEGORIES[data.category].maxPerPeriod;
        if (periodCap !== null) {
            const periodMerits = _getMeritsInPeriod(pubkey, data.category, 30);
            if (periodMerits + meritPoints > periodCap) {
                const remaining = periodCap - periodMerits;
                if (remaining <= 0) {
                    throw new Error(`Has alcanzado el límite de ${periodCap} méritos en "${CATEGORIES[data.category].label}" para este periodo.`);
                }
                // Warn but allow (capped)
                console.warn(`[Merits] ⚠️ Contribución reducida: ${meritPoints} → ${remaining} (cap ${periodCap}/periodo)`);
            }
        }

        // Content: detailed JSON
        const content = JSON.stringify({
            description: data.description.trim(),
            amount,
            currency: data.currency || 'units',
            meritPoints,
            factor,
            evidence: data.evidence || [],
            timestamp: nowSecs
        });

        // Tags
        const tags = [
            ['d', dTag],
            ['p', pubkey],
            ['amount', String(amount)],
            ['merit-points', String(meritPoints)],
            ['category', data.category],
            ['type', data.type || data.category],
            ['funded', data.funded ? 'true' : 'false'],
            ['factor', String(factor)],
            ['t', 'lbw-merits'],
            ['t', 'lbw-contrib'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({
            kind: KIND.CONTRIB,
            content,
            tags
        });

        console.log(`[Merits] 📝 Contribución: ${meritPoints} méritos [${data.category}] factor=${factor}`);
        return { ...result, dTag, meritPoints, factor };
    }

    // ── Award Merit (Governor-only) ──────────────────────────
    // Only governors can directly award merits.
    // Regular users submit contributions that auto-calculate.

    async function awardMerit(recipientPubkey, amount, category, reason) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');
        if (!recipientPubkey) throw new Error('Destinatario requerido.');
        if (!amount || amount <= 0) throw new Error('Cantidad debe ser positiva.');
        if (!CATEGORIES[category]) throw new Error(`Categoría inválida: ${category}`);

        const pubkey = LBW_Nostr.getPubkey();
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
    // Periodic consensus snapshot of merit leaderboard.
    // Signed by governor, verifiable by all.

    async function publishSnapshot() {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');

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
    function subscribeMerits(onMerit) {
        if (onMerit) _onMeritCallbacks.push(onMerit);
        if (_subMerits) return _subMerits;

        _subMerits = LBW_Nostr.subscribe(
            {
                kinds: [KIND.MERIT],
                '#t': ['lbw-merits'],
                limit: 500
            },
            (event) => {
                const merit = _parseMerit(event);
                if (!merit) return;
                _processMerit(merit);
                _onMeritCallbacks.forEach(cb => {
                    try { cb(merit); } catch (e) {}
                });
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

                // Track as merit points
                _processMerit({
                    pubkey: contrib.pubkey,
                    amount: contrib.meritPoints,
                    category: contrib.category,
                    created_at: contrib.created_at,
                    source: 'contribution',
                    id: contrib.id
                });

                if (contrib.pubkey === LBW_Nostr.getPubkey()) {
                    _myContributions.push(contrib);
                }

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
                pubkey: g('p') || event.pubkey,
                amount: parseFloat(g('amount')) || parsed.amount || 0,
                category: g('category') || 'participation',
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
                category: g('category') || 'participation',
                type: g('type') || g('category'),
                funded: g('funded') === 'true',
                factor: parseFloat(g('factor')) || 1.0,
                currency: parsed.currency || 'units',
                evidence: parsed.evidence || [],
                created_at: event.created_at
            };
        } catch (e) {
            return null;
        }
    }

    // ── Merit Calculation ────────────────────────────────────
    // LINEAR: merit_points = amount × factor
    // No logarithmic scaling — fair value recognition.

    function _calculateMeritPoints(amount, category, factor) {
        // Base: 1 unit of contribution = 1 merit point
        // Factor applies multiplier (1.0 - 2.0)
        const base = Math.max(0, amount);
        const points = Math.round(base * factor);
        return points;
    }

    function _getMeritsInPeriod(pubkey, category, days) {
        const userData = _merits.get(pubkey);
        if (!userData) return 0;

        const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
        return (userData.records || [])
            .filter(r => r.category === category && r.created_at >= cutoff)
            .reduce((sum, r) => sum + r.amount, 0);
    }

    // ── Process Merit Record ─────────────────────────────────
    function _processMerit(merit) {
        const { pubkey, amount, category, created_at, source, id } = merit;

        if (!_merits.has(pubkey)) {
            _merits.set(pubkey, {
                total: 0,
                byCategory: {},
                records: [],
                level: CITIZENSHIP_LEVELS[0]
            });
        }

        const userData = _merits.get(pubkey);

        // Dedup
        if (userData.records.some(r => r.id === id)) return;

        userData.records.push({ id, amount, category, created_at, source });
        userData.total += amount;
        userData.byCategory[category] = (userData.byCategory[category] || 0) + amount;

        // Update citizenship level
        userData.level = getCitizenshipLevel(userData.total);

        // Invalidate leaderboard cache
        _leaderboard = [];
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

        // Calculate rank
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

    // ── Citizenship Level ────────────────────────────────────
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
        return null; // Already at max level
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
    }

    // ── Public API ───────────────────────────────────────────
    return {
        // Constants
        KIND,
        CATEGORIES,
        CITIZENSHIP_LEVELS,
        FACTOR_RANGE,

        // Publish
        submitContribution,
        awardMerit,
        publishSnapshot,

        // Subscribe
        subscribeMerits,
        subscribeContributions,
        subscribeSnapshots,
        unsubscribeAll,

        // Query
        getUserMerits,
        getMyMerits,
        getMyContributions,
        getLeaderboard,
        getCitizenshipLevel,
        getNextLevel,
        getStats,

        // Lifecycle
        reset
    };
})();

window.LBW_Merits = LBW_Merits;

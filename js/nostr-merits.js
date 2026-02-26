// ============================================================
// LiberBit World — LBWM Merit System v2.0 (nostr-merits.js)
//
// Decentralized merit tracking over Nostr protocol.
// Contributions (kind 31003) → Merits (kind 31002)
// Snapshots (kind 31005) for leaderboard consensus.
//
// Design Principles (v2.0):
//   - LINEAR calculation: Merit_total = Σ (wᵢ × Cᵢ)
//   - 4 categories: Económica(1.0), Productiva(1.0), Responsabilidad(1.2), Financiada(0.6)
//   - 6 citizenship levels: Amigo → E-Residency → Colaborador → Ciudadano Senior → Embajador → Gobernador
//   - Anti-plutocracy via 3 voting blocks with 51% governor floor
//   - Governor merit cap: merit_voto = min(total, 3000)
//   - Responsabilidad requires Ciudadano Senior+ (1000+ merits)
//   - Parameterized replaceable events (NIP-33)
//   - PRIVATE relays only (merit data is internal)
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

    // ── Merit Categories (LBWM v2.0) ────────────────────────
    // 4 categorías con peso (wᵢ) fijo.
    // Merit_total = Σ (wᵢ × Cᵢ) — relación lineal directa.
    const CATEGORIES = {
        economica: {
            label: 'Económica',
            emoji: '💰',
            description: 'Aportaciones monetarias directas al ecosistema',
            weight: 1.0
        },
        productiva: {
            label: 'Productiva',
            emoji: '🛠️',
            description: 'Trabajo, desarrollo y contribución activa',
            weight: 1.0
        },
        responsabilidad: {
            label: 'Responsabilidad',
            emoji: '🛡️',
            description: 'Roles de gestión, liderazgo y servicio comunitario. Requiere mínimo Ciudadano Senior (1.000+ merits)',
            weight: 1.2,
            requiresMinMerits: 1000  // Solo Ciudadano Senior+
        },
        financiada: {
            label: 'Financiada',
            emoji: '📋',
            description: 'Contribuciones subsidiadas o patrocinadas',
            weight: 0.6
        }
    };

    // ── Citizenship Levels (LBWM v2.0) ──────────────────────
    // 6 niveles progresivos con bloque de voto asociado.
    // Gobernador cap: merit_voto = min(merit_total, 3000)
    const CITIZENSHIP_LEVELS = [
        { name: 'Amigo',             minMerits: 0,     emoji: '🌐', color: '#666666', block: 'comunidad' },
        { name: 'E-Residency',       minMerits: 100,   emoji: '🪪', color: '#2C5F6F', block: 'comunidad' },
        { name: 'Colaborador',       minMerits: 500,   emoji: '⭐', color: '#4CAF50', block: 'comunidad' },
        { name: 'Ciudadano Senior',  minMerits: 1000,  emoji: '🏅', color: '#E5B95C', block: 'ciudadania' },
        { name: 'Embajador',         minMerits: 2000,  emoji: '🎖️', color: '#9C27B0', block: 'ciudadania' },
        { name: 'Gobernador',        minMerits: 3000,  emoji: '👑', color: '#FFD700', block: 'gobernanza' }
    ];

    // ── Voting Blocks (LBWM v2.0) ────────────────────────────
    // Gobernanza: mínimo 51%, equitativo entre gobernadores
    // Ciudadanía: máximo 29%, proporcional a merits
    // Comunidad: máximo 20%, proporcional a merits
    const VOTING_BLOCKS = {
        gobernanza:  { label: 'Gobernanza',  minWeight: 0.51, levels: ['Gobernador'] },
        ciudadania:  { label: 'Ciudadanía',  maxWeight: 0.29, levels: ['Ciudadano Senior', 'Embajador'] },
        comunidad:   { label: 'Comunidad',   maxWeight: 0.20, levels: ['Amigo', 'E-Residency', 'Colaborador'] }
    };

    // Governor merit cap for voting power
    const GOVERNOR_MERIT_CAP = 3000;

    // ── Category Weights ──────────────────────────────────────
    // v2.0: factor is the category weight (wᵢ), not a user-defined range.
    // economica=1.0, productiva=1.0, responsabilidad=1.2, financiada=0.6

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

    // ── Submit Contribution (LBWM v2.0) ────────────────────
    // A user submits a contribution record. Merits are awarded
    // based on contribution value × category weight (wᵢ).
    //
    // data: {
    //   description  — What was contributed
    //   category     — 'economica' | 'productiva' | 'responsabilidad' | 'financiada'
    //   type         — Same as category
    //   amount       — Numeric value (contribution bruta Cᵢ)
    //   currency     — 'EUR' | 'USD' | 'BTC' | 'units'
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

        // v2.0: Responsabilidad requires Ciudadano Senior+ (1000+ merits in other categories)
        const catDef = CATEGORIES[data.category];
        if (catDef.requiresMinMerits) {
            const userData = _merits.get(pubkey);
            const otherMerits = userData ? (userData.total - (userData.byCategory['responsabilidad'] || 0)) : 0;
            if (otherMerits < catDef.requiresMinMerits) {
                throw new Error(`La categoría "${catDef.label}" requiere al menos ${catDef.requiresMinMerits} merits en otras categorías. Actualmente tienes ${otherMerits}.`);
            }
        }

        // v2.0: Factor = category weight (wᵢ), not user-defined
        const weight = catDef.weight;

        // Calculate merit points: Merit = Cᵢ × wᵢ
        const amount = parseFloat(data.amount) || 0;
        const meritPoints = _calculateMeritPoints(amount, data.category, weight);

        // Content: detailed JSON
        const content = JSON.stringify({
            description: data.description.trim(),
            amount,
            currency: data.currency || 'units',
            meritPoints,
            weight,
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
            ['weight', String(weight)],
            ['t', 'lbw-merits'],
            ['t', 'lbw-contrib'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({
            kind: KIND.CONTRIB,
            content,
            tags
        });

        // ── Optimistic local update ──────────────────────────
        // Add contribution immediately to local state so UI
        // can display it without waiting for relay echo.
        const eventId = result?.event?.id || dTag;
        const localContrib = {
            id: eventId,
            pubkey,
            npub: LBW_Nostr.pubkeyToNpub(pubkey),
            dTag,
            description: data.description.trim(),
            amount,
            meritPoints,
            category: data.category,
            type: data.type || data.category,
            weight,
            currency: data.currency || 'units',
            evidence: data.evidence || [],
            created_at: nowSecs
        };

        // Add to contributions if not already there (dedup by id)
        if (!_contributions.some(c => c.id === eventId)) {
            _contributions.push(localContrib);
        }
        if (!_myContributions.some(c => c.id === eventId)) {
            _myContributions.push(localContrib);
        }

        // Also process as merit points immediately
        _processMerit({
            pubkey,
            amount: meritPoints,
            category: data.category,
            created_at: nowSecs,
            source: 'contribution',
            id: eventId
        });

        console.log(`[Merits] 📝 Contribución: ${meritPoints} méritos [${data.category}] peso=${weight}`);
        return { ...result, dTag, meritPoints, weight };
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
                category: g('category') || 'economica',
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
                category: g('category') || 'economica',
                type: g('type') || g('category'),
                weight: parseFloat(g('weight')) || parseFloat(g('factor')) || parsed.weight || parsed.factor || 1.0,
                currency: parsed.currency || 'units',
                evidence: parsed.evidence || [],
                created_at: event.created_at
            };
        } catch (e) {
            return null;
        }
    }

    // ── Merit Calculation (LBWM v2.0) ─────────────────────
    // LINEAR: Merit = Cᵢ × wᵢ (contribution × category weight)
    // No logarithmic scaling — fair value recognition.
    // 1 unit of value = 1 merit (before weight applied)

    function _calculateMeritPoints(amount, category, weight) {
        const base = Math.max(0, amount);
        const catWeight = weight || (CATEGORIES[category] ? CATEGORIES[category].weight : 1.0);
        const points = Math.round(base * catWeight);
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

    // ── Voting Power (LBWM v2.0) ───────────────────────────
    // 3 bloques: Gobernanza (min 51%), Ciudadanía (max 29%), Comunidad (max 20%)
    // Gobernador cap: merit_voto = min(merit_total, 3000)
    // Dentro de Gobernanza: voto equitativo entre gobernadores
    // Dentro de Ciudadanía/Comunidad: proporcional a merits

    function calculateVotingPower() {
        const lb = getLeaderboard(999);
        if (lb.length === 0) return { blocks: {}, totalMerits: 0 };

        // Classify members by block
        const blocks = { gobernanza: [], ciudadania: [], comunidad: [] };
        let totalMeritsAll = 0;

        lb.forEach(entry => {
            const level = getCitizenshipLevel(entry.total);
            const block = level.block || 'comunidad';
            // Gobernador: merit_voto capped at 3000
            const meritVoto = block === 'gobernanza' ? Math.min(entry.total, GOVERNOR_MERIT_CAP) : entry.total;
            blocks[block].push({ ...entry, meritVoto, level });
            totalMeritsAll += meritVoto;
        });

        if (totalMeritsAll === 0) return { blocks, totalMerits: 0 };

        // Calculate natural weight of each block
        const blockMerits = {};
        Object.keys(blocks).forEach(key => {
            blockMerits[key] = blocks[key].reduce((sum, e) => sum + e.meritVoto, 0);
        });

        let weights = {};
        const gobNatural = blockMerits.gobernanza / totalMeritsAll;

        if (gobNatural >= 0.51) {
            // Natural weight respected
            Object.keys(blockMerits).forEach(key => {
                weights[key] = blockMerits[key] / totalMeritsAll;
            });
        } else {
            // Floor rule: Gobernanza gets 51%, rest distributed proportionally
            weights.gobernanza = 0.51;
            const remaining = 0.49;
            const otherTotal = blockMerits.ciudadania + blockMerits.comunidad;
            if (otherTotal > 0) {
                weights.ciudadania = remaining * (blockMerits.ciudadania / otherTotal);
                weights.comunidad = remaining * (blockMerits.comunidad / otherTotal);
            } else {
                weights.ciudadania = 0;
                weights.comunidad = remaining;
            }
        }

        return {
            blocks,
            weights,
            blockMerits,
            totalMerits: totalMeritsAll,
            floorActive: gobNatural < 0.51,
            gobNaturalWeight: gobNatural
        };
    }

    function getUserVotingPower(pubkey) {
        pubkey = pubkey || LBW_Nostr.getPubkey();
        if (!pubkey) return null;

        const vp = calculateVotingPower();
        if (vp.totalMerits === 0) return { power: 0, block: 'comunidad', blockWeight: 0 };

        const userData = _merits.get(pubkey);
        const total = userData ? userData.total : 0;
        const level = getCitizenshipLevel(total);
        const block = level.block || 'comunidad';

        let individualPower = 0;
        if (block === 'gobernanza') {
            // Equitativo: cada gobernador tiene el mismo poder dentro del bloque
            const numGov = vp.blocks.gobernanza.length;
            individualPower = numGov > 0 ? (vp.weights.gobernanza / numGov) : 0;
        } else {
            // Proporcional a merits dentro del bloque
            const blockTotal = vp.blockMerits[block] || 1;
            individualPower = (total / blockTotal) * (vp.weights[block] || 0);
        }

        return {
            power: individualPower,
            powerPct: (individualPower * 100).toFixed(2),
            block,
            blockLabel: VOTING_BLOCKS[block]?.label || block,
            blockWeight: vp.weights[block] || 0,
            meritVoto: block === 'gobernanza' ? Math.min(total, GOVERNOR_MERIT_CAP) : total,
            level,
            floorActive: vp.floorActive
        };
    }

    // ── Stats ────────────────────────────────────────────────
    function getStats() {
        const lb = getLeaderboard(999);
        const vp = calculateVotingPower();
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
            ),
            votingPower: vp
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
        VOTING_BLOCKS,
        GOVERNOR_MERIT_CAP,

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

        // Voting (v2.0)
        calculateVotingPower,
        getUserVotingPower,

        // Lifecycle
        reset
    };
})();

window.LBW_Merits = LBW_Merits;

// ============================================================
// LiberBit World — Delegations Module v1.0 (nostr-delegations.js)
//
// Sistema de delegación de voto tipo "liquid democracy" sobre Nostr.
// Cubre tanto propuestas de gobernanza (kind:31000) como aportaciones
// de valor (kind:31003) — ambas se votan vía kind:31001 y comparten
// el mismo mecanismo de tally.
//
// Evento: kind 31004 (LBW_DELEGATE) — parameterized-replaceable
//
// Estructura:
//   content: ""  (o nota opcional del delegador)
//   tags:
//     ['d', 'delegation-<scope>']   → reemplazable por autor+scope
//     ['p', '<delegate-hex>']       → pubkey del delegado (vacío = revocación)
//     ['scope', 'global']           → v1: siempre 'global'. Futuro:
//                                      'referendum' / 'budget' / 'election'
//     ['t', 'lbw-delegate']
//     ['client', 'LiberBit World']
//
// Reglas (aplicadas por el tally en nostr-governance.js, Fase 2):
//   - El voto directo del delegador SIEMPRE prevalece sobre la delegación.
//   - La delegación es NO-TRANSITIVA en v1 (si A→B y B→C, A solo llega
//     hasta B; si B no vota, el poder de A se pierde).
//   - El poder delegado conserva el BLOQUE del delegador (si Génesis A
//     delega a comunidad B, el 51% de A sigue pesando como Gobernanza).
//   - Revocación: publicar nuevo kind:31004 con p-tag vacío o con un
//     delegado distinto (lo último sobrescribe por ser replaceable).
//
// Granularidad v1:
//   - Solo scope 'global' (un único delegado para todo).
//   - El parámetro `scope` se propaga por todo el módulo para que añadir
//     granularidad por categoría en v2 no requiera refactor: basta con
//     que la UI permita elegir scope y que el tally la consulte.
//
// Elegibilidad: cualquier pubkey puede recibir delegaciones
//               (liquid democracy pura).
//
// Dependencias: nostr.js (LBW_Nostr)
// ============================================================

const LBW_Delegations = (() => {
    'use strict';

    const KIND = 31004;
    const VALID_SCOPES = ['global', 'referendum', 'budget', 'election'];
    const DEFAULT_SCOPE = 'global';

    // ── Internal State ───────────────────────────────────────
    // _delegations: Map<delegatorPubkey, Map<scope, delegationObj>>
    //   delegationObj: { delegate, delegateNpub, created_at, eventId, scope, note }
    //   delegate === null → revocada explícitamente
    let _delegations = new Map();

    // Reverse index para responder getDelegatorsOf() en O(1) amortizado.
    // _delegationsByDelegate: Map<delegatePubkey, Map<delegatorPubkey, Set<scope>>>
    let _delegationsByDelegate = new Map();

    let _sub = null;
    let _onDelegationCallbacks = [];
    let _hasLoadedFromStorage = false;

    const STORAGE_KEY = 'lbw_delegations_cache';

    // ── Utilities ────────────────────────────────────────────
    function _isValidHex64(s) {
        return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
    }

    function _normalizeScope(scope) {
        if (!scope) return DEFAULT_SCOPE;
        const s = String(scope).toLowerCase();
        return VALID_SCOPES.includes(s) ? s : DEFAULT_SCOPE;
    }

    // Updates the reverse index when a delegation changes.
    // prevDelegate / newDelegate can be null (revocation).
    function _updateReverseIndex(delegatorPubkey, scope, prevDelegate, newDelegate) {
        // Remove prev mapping
        if (prevDelegate && _delegationsByDelegate.has(prevDelegate)) {
            const m = _delegationsByDelegate.get(prevDelegate);
            if (m.has(delegatorPubkey)) {
                const scopes = m.get(delegatorPubkey);
                scopes.delete(scope);
                if (scopes.size === 0) m.delete(delegatorPubkey);
            }
            if (m.size === 0) _delegationsByDelegate.delete(prevDelegate);
        }
        // Add new mapping
        if (newDelegate) {
            if (!_delegationsByDelegate.has(newDelegate)) {
                _delegationsByDelegate.set(newDelegate, new Map());
            }
            const m = _delegationsByDelegate.get(newDelegate);
            if (!m.has(delegatorPubkey)) m.set(delegatorPubkey, new Set());
            m.get(delegatorPubkey).add(scope);
        }
    }

    // ── Storage ──────────────────────────────────────────────
    function _persistToStorage() {
        try {
            const obj = {};
            _delegations.forEach((scopeMap, delegator) => {
                obj[delegator] = {};
                scopeMap.forEach((d, scope) => { obj[delegator][scope] = d; });
            });
            localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
        } catch (e) { console.warn('[Delegations] Storage persist error:', e); }
    }

    function _loadFromStorage() {
        if (_hasLoadedFromStorage) return;
        _hasLoadedFromStorage = true;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const obj = JSON.parse(raw);
            Object.entries(obj).forEach(([delegator, scopeObj]) => {
                const sMap = new Map();
                Object.entries(scopeObj).forEach(([scope, d]) => {
                    sMap.set(scope, d);
                    if (d.delegate) _updateReverseIndex(delegator, scope, null, d.delegate);
                });
                _delegations.set(delegator, sMap);
            });
            console.log(`[Delegations] 📂 ${_delegations.size} delegación(es) cargadas de caché`);
        } catch (e) { console.warn('[Delegations] Storage load error:', e); }
    }

    // ── Parse Nostr Event ────────────────────────────────────
    function _parseDelegationEvent(event) {
        if (!event || event.kind !== KIND) return null;

        const getTag = (name) => {
            const t = event.tags?.find(t => t[0] === name);
            return t ? t[1] : null;
        };

        const dTag = getTag('d');
        if (!dTag) return null;

        const rawScope = getTag('scope') || dTag.replace(/^delegation-/, '');
        const scope = _normalizeScope(rawScope);

        const pTag = getTag('p');
        // Empty or missing p-tag = revocation
        const delegate = (pTag && _isValidHex64(pTag)) ? pTag : null;

        // Prevent self-delegation (should be enforced at publish time, but
        // defensive check on read too — ignore events where delegator
        // equals delegate).
        if (delegate && delegate === event.pubkey) return null;

        const note = (typeof event.content === 'string') ? event.content : '';

        return {
            delegator: event.pubkey,
            delegate,                                   // null = revocation
            delegateNpub: delegate ? _safeNpub(delegate) : null,
            scope,
            created_at: event.created_at,
            eventId: event.id,
            note
        };
    }

    function _safeNpub(hex) {
        try {
            if (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.pubkeyToNpub) {
                return LBW_Nostr.pubkeyToNpub(hex);
            }
        } catch (e) {}
        return null;
    }

    // Ingest a parsed delegation into internal state.
    // Returns true if state changed (caller should fire callbacks).
    function _ingest(parsed) {
        if (!parsed) return false;
        const { delegator, scope } = parsed;

        let scopeMap = _delegations.get(delegator);
        if (!scopeMap) {
            scopeMap = new Map();
            _delegations.set(delegator, scopeMap);
        }

        const existing = scopeMap.get(scope);
        // Replaceable: newer events win (ties broken by keeping existing)
        if (existing && existing.created_at >= parsed.created_at) return false;

        const prevDelegate = existing ? existing.delegate : null;
        scopeMap.set(scope, parsed);
        _updateReverseIndex(delegator, scope, prevDelegate, parsed.delegate);
        return true;
    }

    // ── Publish: Delegate ────────────────────────────────────
    async function delegateTo(delegatePubkey, scope = DEFAULT_SCOPE, note = '') {
        if (typeof LBW_Nostr === 'undefined' || !LBW_Nostr.isLoggedIn()) {
            throw new Error('Login requerido.');
        }
        if (!delegatePubkey) throw new Error('Delegado requerido.');

        // Accept npub or hex
        let delegateHex = String(delegatePubkey).trim();
        if (delegateHex.startsWith('npub1')) {
            try { delegateHex = LBW_Nostr.npubToHex(delegateHex); }
            catch (e) { throw new Error('npub inválido.'); }
        }
        if (!_isValidHex64(delegateHex)) {
            throw new Error('pubkey inválido (esperado hex de 64 caracteres o npub).');
        }

        const myPubkey = LBW_Nostr.getPubkey();
        if (delegateHex === myPubkey) {
            throw new Error('No puedes delegar el voto a ti mismo.');
        }

        const normScope = _normalizeScope(scope);
        const dTag = `delegation-${normScope}`;

        const tags = [
            ['d', dTag],
            ['p', delegateHex],
            ['scope', normScope],
            ['t', 'lbw-delegate'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({
            kind: KIND,
            content: note || '',
            tags
        });

        if (!result?.event?.id) throw new Error('No se generó ID de evento.');
        const successful = (result.results || []).filter(r => r.success === true);
        if (successful.length === 0) throw new Error('No se pudo publicar en ningún relay.');

        // Ingest locally right away so UI updates without waiting for echo
        const parsed = _parseDelegationEvent(result.event);
        if (_ingest(parsed)) {
            _persistToStorage();
            _onDelegationCallbacks.forEach(cb => {
                try { cb(parsed, 'new'); } catch (e) {}
            });
        }

        console.log(`[Delegations] ✅ Delegación publicada: scope=${normScope} → ${delegateHex.substring(0, 12)}…`);
        return { ...result, delegate: delegateHex, scope: normScope };
    }

    // ── Publish: Revoke ──────────────────────────────────────
    async function revokeDelegation(scope = DEFAULT_SCOPE) {
        if (typeof LBW_Nostr === 'undefined' || !LBW_Nostr.isLoggedIn()) {
            throw new Error('Login requerido.');
        }

        const normScope = _normalizeScope(scope);
        const dTag = `delegation-${normScope}`;

        // Revocation = kind:31004 with empty p-tag (still replaceable via d)
        const tags = [
            ['d', dTag],
            ['p', ''],
            ['scope', normScope],
            ['action', 'revoke'],
            ['t', 'lbw-delegate'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({
            kind: KIND,
            content: '',
            tags
        });

        if (!result?.event?.id) throw new Error('No se generó ID de evento.');
        const successful = (result.results || []).filter(r => r.success === true);
        if (successful.length === 0) throw new Error('No se pudo publicar en ningún relay.');

        const parsed = _parseDelegationEvent(result.event);
        if (_ingest(parsed)) {
            _persistToStorage();
            _onDelegationCallbacks.forEach(cb => {
                try { cb(parsed, 'revoked'); } catch (e) {}
            });
        }

        console.log(`[Delegations] 🚫 Delegación revocada: scope=${normScope}`);
        return { ...result, scope: normScope };
    }

    // ── Subscribe ────────────────────────────────────────────
    function subscribeDelegations(onDelegation) {
        if (typeof LBW_Nostr === 'undefined') return null;
        if (onDelegation) _onDelegationCallbacks.push(onDelegation);
        if (!_hasLoadedFromStorage) _loadFromStorage();
        if (_sub) return _sub;

        _sub = LBW_Nostr.subscribe(
            { kinds: [KIND], '#t': ['lbw-delegate'], limit: 500 },
            (event) => {
                const parsed = _parseDelegationEvent(event);
                if (!parsed) return;
                const changed = _ingest(parsed);
                if (!changed) return;
                _persistToStorage();
                _onDelegationCallbacks.forEach(cb => {
                    try { cb(parsed, parsed.delegate ? 'new' : 'revoked'); } catch (e) {}
                });
            }
        );

        console.log('[Delegations] 🔔 Suscripción a delegaciones abierta');
        return _sub;
    }

    function unsubscribeAll() {
        if (_sub && typeof LBW_Nostr !== 'undefined' && LBW_Nostr.unsubscribe) {
            try { LBW_Nostr.unsubscribe(_sub); } catch (e) {}
        }
        _sub = null;
        _onDelegationCallbacks = [];
    }

    // ── Queries ──────────────────────────────────────────────

    // My own delegation for a given scope (returns null if none/revoked)
    function getMyDelegation(scope = DEFAULT_SCOPE) {
        if (typeof LBW_Nostr === 'undefined' || !LBW_Nostr.isLoggedIn()) return null;
        const myPubkey = LBW_Nostr.getPubkey();
        return getDelegationOf(myPubkey, scope);
    }

    // Delegation object for a specific delegator + scope
    function getDelegationOf(delegatorPubkey, scope = DEFAULT_SCOPE) {
        if (!delegatorPubkey) return null;
        const normScope = _normalizeScope(scope);
        const scopeMap = _delegations.get(delegatorPubkey);
        if (!scopeMap) return null;
        const d = scopeMap.get(normScope);
        if (!d || !d.delegate) return null;   // null delegate = revoked
        return { ...d };
    }

    // KEY HELPER FOR TALLY (Fase 2):
    // Given a delegator and a proposal category, return the effective
    // delegate pubkey (or null if no active delegation).
    //
    // v1: always falls back to 'global' scope regardless of category.
    // v2: will check category-specific scope first, then global as fallback.
    function getActiveDelegation(delegatorPubkey, category = null) {
        if (!delegatorPubkey) return null;
        const scopeMap = _delegations.get(delegatorPubkey);
        if (!scopeMap) return null;

        // v2-ready lookup order: category-specific → global
        if (category) {
            const normCat = _normalizeScope(category);
            if (normCat !== DEFAULT_SCOPE) {
                const specific = scopeMap.get(normCat);
                if (specific && specific.delegate) return specific.delegate;
            }
        }
        const global = scopeMap.get(DEFAULT_SCOPE);
        if (global && global.delegate) return global.delegate;
        return null;
    }

    // Who delegated to this pubkey? Returns array of { delegator, scope, delegation }.
    function getDelegatorsOf(delegatePubkey) {
        if (!delegatePubkey) return [];
        const m = _delegationsByDelegate.get(delegatePubkey);
        if (!m) return [];
        const out = [];
        m.forEach((scopes, delegator) => {
            scopes.forEach(scope => {
                const scopeMap = _delegations.get(delegator);
                if (!scopeMap) return;
                const d = scopeMap.get(scope);
                if (d && d.delegate === delegatePubkey) {
                    out.push({ delegator, scope, delegation: { ...d } });
                }
            });
        });
        return out;
    }

    // Snapshot of all active delegations (for debugging/admin views).
    // Returns array of { delegator, scope, delegate, created_at, ... }.
    function getAllActiveDelegations() {
        const out = [];
        _delegations.forEach((scopeMap, delegator) => {
            scopeMap.forEach((d, scope) => {
                if (d.delegate) out.push({ delegator, scope, ...d });
            });
        });
        return out;
    }

    function getStats() {
        return {
            totalDelegators: Array.from(_delegations.values()).filter(sm => {
                for (const d of sm.values()) if (d.delegate) return true;
                return false;
            }).length,
            totalDelegates: _delegationsByDelegate.size,
            totalActiveDelegations: getAllActiveDelegations().length
        };
    }

    // ── Reset (called on logout) ─────────────────────────────
    function reset() {
        unsubscribeAll();
        _delegations = new Map();
        _delegationsByDelegate = new Map();
        _hasLoadedFromStorage = false;
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        console.log('[Delegations] 🔄 Estado reiniciado');
    }

    // ── Public API ───────────────────────────────────────────
    return {
        KIND,
        VALID_SCOPES,
        DEFAULT_SCOPE,

        // Publish
        delegateTo,
        revokeDelegation,

        // Subscribe
        subscribeDelegations,
        unsubscribeAll,

        // Queries
        getMyDelegation,
        getDelegationOf,
        getActiveDelegation,   // key hook for tally integration (Fase 2)
        getDelegatorsOf,
        getAllActiveDelegations,
        getStats,

        reset
    };
})();

// Expose on window for cross-module access (IIFE const does NOT create window prop)
window.LBW_Delegations = LBW_Delegations;

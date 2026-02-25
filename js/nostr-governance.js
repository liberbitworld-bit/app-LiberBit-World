// ============================================================
// LiberBit World — Governance Module v1.0 (nostr-governance.js)
//
// Decentralized governance over Nostr protocol.
// Proposals (kind 31000) + Votes (kind 31001)
//
// Design:
//   - Parameterized replaceable events (NIP-33)
//   - PRIVATE relays only (governance is internal)
//   - Anti-double-vote via cryptographic check
//   - 3-block voting: Governors (51% floor), Citizenship, Community
//   - Status lifecycle: active → closed → executed
//
// Dependencies: nostr.js (LBW_Nostr), nostr-store.js (LBW_Store)
// ============================================================

const LBW_Governance = (() => {
    'use strict';

    const KIND = {
        PROPOSAL: 31000,
        VOTE:     31001,
        DELEGATE: 31004
    };

    // ── Proposal Categories ──────────────────────────────────
    const CATEGORIES = {
        referendum:  { label: 'Referéndum',        emoji: '🗳️', description: 'Consulta vinculante a toda la comunidad' },
        budget:      { label: 'Presupuesto',       emoji: '💰', description: 'Asignación o modificación presupuestaria' },
        election:    { label: 'Elección',           emoji: '👥', description: 'Elección de representantes o gobernadores' },
        amendment:   { label: 'Enmienda',           emoji: '📜', description: 'Modificación de reglas o constitución' },
        general:     { label: 'General',            emoji: '📋', description: 'Propuesta general de la comunidad' },
        emergency:   { label: 'Emergencia',         emoji: '🚨', description: 'Acción urgente (periodo de voto reducido)' }
    };

    // Default vote options per category
    const DEFAULT_OPTIONS = {
        referendum:  ['A favor', 'En contra', 'Abstención'],
        budget:      ['Aprobar', 'Rechazar', 'Aplazar'],
        election:    [],  // Dynamic: filled with candidate names
        amendment:   ['A favor', 'En contra', 'Abstención'],
        general:     ['A favor', 'En contra', 'Abstención'],
        emergency:   ['Aprobar acción', 'Rechazar']
    };

    // Voting duration per category (seconds)
    const DURATIONS = {
        referendum:  7 * 86400,   // 7 days
        budget:      5 * 86400,   // 5 days
        election:    7 * 86400,   // 7 days
        amendment:   14 * 86400,  // 14 days
        general:     7 * 86400,   // 7 days
        emergency:   24 * 3600    // 24 hours
    };

    // ── Internal State ───────────────────────────────────────
    let _proposals = new Map();       // proposalDTag → proposal object
    let _votes = new Map();           // proposalDTag → [vote objects]
    let _myVotes = new Map();         // proposalDTag → my vote
    let _onProposalCallbacks = [];
    let _onVoteCallbacks = [];
    let _sub = null;
    let _voteSubs = {};               // proposalDTag → subscription
    const STORAGE_KEY = 'lbw_governance_proposals';
    const VOTES_STORAGE_KEY = 'lbw_governance_myvotes';
    const ALL_VOTES_STORAGE_KEY = 'lbw_governance_allvotes';

    // ── LocalStorage Persistence ─────────────────────────────
    function _persistToStorage() {
        try {
            const data = {};
            _proposals.forEach((v, k) => { data[k] = v; });
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) { console.warn('[Governance] Storage save error:', e); }
    }

    function _persistVotesToStorage() {
        try {
            const data = {};
            _myVotes.forEach((v, k) => { data[k] = v; });
            localStorage.setItem(VOTES_STORAGE_KEY, JSON.stringify(data));
        } catch (e) {}
        
        // También persistir todos los votos
        try {
            const allData = {};
            _votes.forEach((votes, dTag) => { allData[dTag] = votes; });
            localStorage.setItem(ALL_VOTES_STORAGE_KEY, JSON.stringify(allData));
        } catch (e) {}
    }

    function _loadFromStorage() {
        // Cargar propuestas
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                Object.entries(data).forEach(([dTag, proposal]) => {
                    if (!_proposals.has(dTag)) {
                        const now = Math.floor(Date.now() / 1000);
                        if (proposal.status === 'active' && proposal.expiresAt && now > proposal.expiresAt) {
                            proposal.status = 'expired';
                        }
                        _proposals.set(dTag, proposal);
                    }
                });
                console.log(`[Governance] 📂 ${_proposals.size} propuestas cargadas de caché`);
            }
        } catch (e) { console.warn('[Governance] Storage load error:', e); }

        // Cargar TODOS los votos primero
        try {
            const raw = localStorage.getItem(ALL_VOTES_STORAGE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                Object.entries(data).forEach(([dTag, votes]) => {
                    if (!_votes.has(dTag) && Array.isArray(votes)) {
                        _votes.set(dTag, votes);
                    }
                });
                console.log(`[Governance] 📂 Votos cargados para ${_votes.size} propuestas`);
            }
        } catch (e) { console.warn('[Governance] All votes load error:', e); }

        // Cargar mis votos (sin depender de getPubkey aún)
        _loadMyVotes();
    }
    
    // Función separada para cargar mis votos - puede llamarse después del login
    function _loadMyVotes() {
        try {
            const raw = localStorage.getItem(VOTES_STORAGE_KEY);
            if (!raw) {
                console.log('[Governance] No hay votos guardados en localStorage');
                return;
            }
            
            const data = JSON.parse(raw);
            const currentPubkey = LBW_Nostr.getPubkey();
            console.log('[Governance] Cargando votos, pubkey actual:', currentPubkey ? currentPubkey.substring(0,8) + '...' : 'null');
            
            Object.entries(data).forEach(([dTag, vote]) => {
                // Usar el pubkey guardado en el voto, o el actual si está disponible
                const votePubkey = vote.pubkey || currentPubkey;
                
                // Siempre actualizar el voto (no solo si no existe)
                _myVotes.set(dTag, vote);
                console.log('[Governance] Voto cargado para:', dTag, '- opción:', vote.option);
                
                // Asegurar que mi voto esté en _votes si tenemos pubkey
                if (votePubkey) {
                    if (!_votes.has(dTag)) _votes.set(dTag, []);
                    const votesList = _votes.get(dTag);
                    const existingIdx = votesList.findIndex(v => v.pubkey === votePubkey);
                    if (existingIdx < 0) {
                        votesList.push({
                            id: vote.eventId,
                            pubkey: votePubkey,
                            npub: vote.npub || LBW_Nostr.pubkeyToNpub(votePubkey),
                            option: vote.option,
                            proposalDTag: dTag,
                            created_at: vote.created_at
                        });
                    }
                }
            });
            console.log(`[Governance] 📂 ${_myVotes.size} votos propios cargados de caché`);
        } catch (e) { console.warn('[Governance] Votes storage load error:', e); }
    }
    
    // Función pública para recargar votos después del login
    function reloadMyVotes() {
        console.log('[Governance] 🔄 Recargando votos...');
        _loadMyVotes();
        console.log('[Governance] 🔄 Votos recargados desde caché, total:', _myVotes.size);
        
        // Solo buscar en Nostr si no hay votos en caché y no estamos ya buscando
        if (_myVotes.size === 0 && !_fetchingVotes) {
            // Esperar un poco para evitar rate limiting en la carga inicial
            setTimeout(() => {
                if (_myVotes.size === 0) {
                    _fetchMyVotesFromNostr();
                }
            }, 2000);
        }
    }

    // ── Publish Proposal ─────────────────────────────────────
    // Creates a kind 31000 parameterized replaceable event.
    //
    // Required fields:
    //   title       — Proposal title
    //   description — Full description text
    //   category    — One of CATEGORIES keys
    //
    // Optional:
    //   options     — Vote options array (defaults per category)
    //   durationSecs — Override default voting period
    //   candidates  — For elections: [{name, pubkey}]
    //   budget      — For budget proposals: {amount, currency, recipient}

    async function publishProposal(data) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');
        if (!data.title?.trim()) throw new Error('Título requerido.');
        if (!data.description?.trim()) throw new Error('Descripción requerida.');

        const category = data.category || 'general';
        if (!CATEGORIES[category]) throw new Error(`Categoría inválida: ${category}`);

        const nowSecs = Math.floor(Date.now() / 1000);
        const duration = data.durationSecs || DURATIONS[category];
        const expiresAt = nowSecs + duration;

        // Build options
        let options = data.options;
        if (!options || options.length === 0) {
            if (category === 'election' && data.candidates?.length > 0) {
                options = data.candidates.map(c => c.name || c);
            } else {
                options = DEFAULT_OPTIONS[category] || ['A favor', 'En contra', 'Abstención'];
            }
        }

        // Unique d-tag
        const pubkey = LBW_Nostr.getPubkey();
        const dTag = `proposal-${pubkey.substring(0, 8)}-${nowSecs}`;

        // Content: structured JSON
        const content = JSON.stringify({
            description: data.description.trim(),
            options,
            // Optional enrichment
            ...(data.candidates ? { candidates: data.candidates } : {}),
            ...(data.budget ? { budget: data.budget } : {}),
            ...(data.quorum ? { quorum: data.quorum } : {})
        });

        // Tags
        const tags = [
            ['d', dTag],
            ['title', data.title.trim()],
            ['category', category],
            ['status', 'active'],
            ['expires', String(expiresAt)],
            ['created', String(nowSecs)],
            ['t', 'lbw-governance'],
            ['t', 'lbw-proposal'],
            ['t', `lbw-${category}`],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({
            kind: KIND.PROPOSAL,
            content,
            tags
        });

        // === VERIFICACIÓN DE PUBLICACIÓN EXITOSA ===
        // Verificar que el evento se creó correctamente
        if (!result.event?.id) {
            console.error('[Governance] Error: No se generó ID de evento');
            throw new Error('Error creando propuesta. No se generó ID de evento.');
        }

        // Verificar que al menos un relay aceptó el evento
        const successfulRelays = (result.results || []).filter(r => r.success === true);
        const failedRelays = (result.results || []).filter(r => r.success === false);
        
        if (successfulRelays.length === 0) {
            console.error('[Governance] ❌ Ningún relay aceptó la propuesta:', {
                event: result.event?.id,
                failures: failedRelays.map(r => ({ relay: r.relay, error: r.error }))
            });
            throw new Error(
                'No se pudo publicar la propuesta en ningún relay.\n\n' +
                'Posibles causas:\n' +
                '• Sin conexión a internet\n' +
                '• Relays no disponibles\n' +
                '• Error de autenticación\n\n' +
                'Verifica tu conexión y vuelve a intentar.'
            );
        }

        console.log(`[Governance] ✅ Propuesta publicada en ${successfulRelays.length}/${result.results?.length || 0} relay(s)`);
        // === FIN VERIFICACIÓN ===

        // Guardar localmente SOLO si se publicó exitosamente
        const localProposal = {
            id: result.event.id,
            pubkey,
            npub: LBW_Nostr.getNpub(),
            dTag,
            title: data.title.trim(),
            description: data.description.trim(),
            category,
            status: 'active',
            options,
            candidates: data.candidates || null,
            budget: data.budget || null,
            quorum: data.quorum || null,
            expiresAt,
            createdAt: nowSecs,
            created_at: nowSecs,
            tags,
            _rawContent: content,
            _publishedTo: successfulRelays.map(r => r.relay) // Registro de dónde se publicó
        };

        _proposals.set(dTag, localProposal);
        _persistToStorage();

        // Notify callbacks
        _onProposalCallbacks.forEach(cb => {
            try { cb(localProposal, 'new'); } catch (e) {}
        });

        console.log(`[Governance] 📋 Propuesta publicada: "${data.title}" [${category}] d=${dTag}`);
        return { ...result, dTag, category, expiresAt, relaysUsed: successfulRelays.length };
    }

    // ── Close Proposal ───────────────────────────────────────
    // Updates a proposal's status to 'closed' by republishing
    // with same d-tag (replaceable event pattern).

    async function closeProposal(dTag) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');

        const proposal = _proposals.get(dTag);
        if (!proposal) throw new Error('Propuesta no encontrada.');
        if (proposal.pubkey !== LBW_Nostr.getPubkey()) {
            throw new Error('Solo el autor puede cerrar la propuesta.');
        }

        // Republish with status=closed (same d-tag replaces)
        const tags = proposal.tags.map(t => {
            if (t[0] === 'status') return ['status', 'closed'];
            return t;
        });

        const result = await LBW_Nostr.publishEvent({
            kind: KIND.PROPOSAL,
            content: proposal._rawContent,
            tags
        });

        console.log(`[Governance] 🔒 Propuesta cerrada: d=${dTag}`);
        return result;
    }

    // ── Publish Vote ─────────────────────────────────────────
    // Creates a kind 31001 event referencing a proposal.
    // Anti-double-vote: checks if user already voted.

    async function publishVote(proposalEventId, proposalDTag, option) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');
        if (!option?.trim()) throw new Error('Opción de voto requerida.');

        // Check proposal exists and is active
        const proposal = _proposals.get(proposalDTag);
        if (proposal) {
            if (proposal.status !== 'active') {
                throw new Error('La propuesta ya no está activa.');
            }
            const nowSecs = Math.floor(Date.now() / 1000);
            if (proposal.expiresAt && nowSecs > proposal.expiresAt) {
                throw new Error('El periodo de votación ha expirado.');
            }
            // Validate option is in allowed list
            if (proposal.options && !proposal.options.includes(option)) {
                throw new Error(`Opción "${option}" no válida para esta propuesta.`);
            }
        }

        // Anti-double-vote check
        if (_myVotes.has(proposalDTag)) {
            throw new Error('Ya has votado en esta propuesta. No se permite doble voto.');
        }

        // Also verify against relay (in case local state is stale)
        const alreadyVoted = await _checkAlreadyVoted(proposalEventId);
        if (alreadyVoted) {
            throw new Error('Ya existe un voto tuyo registrado en los relays.');
        }

        const tags = [
            ['e', proposalEventId],                   // Reference to proposal event
            ['d', proposalDTag],                       // D-tag for NIP-33 (must be 'd', not 'd-tag')
            ['t', 'lbw-governance'],
            ['t', 'lbw-vote'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({
            kind: KIND.VOTE,
            content: option.trim(),
            tags
        });

        // === VERIFICACIÓN DE PUBLICACIÓN EXITOSA ===
        if (!result.event?.id) {
            console.error('[Governance] Error: No se generó ID de evento para el voto');
            throw new Error('Error registrando voto. No se generó ID de evento.');
        }

        const successfulRelays = (result.results || []).filter(r => r.success === true);
        
        if (successfulRelays.length === 0) {
            console.error('[Governance] ❌ Ningún relay aceptó el voto:', {
                event: result.event?.id,
                proposal: proposalDTag
            });
            throw new Error(
                'No se pudo registrar el voto en ningún relay.\n\n' +
                'Tu voto NO ha sido contabilizado.\n' +
                'Verifica tu conexión y vuelve a intentar.'
            );
        }

        console.log(`[Governance] ✅ Voto publicado en ${successfulRelays.length} relay(s)`);
        // === FIN VERIFICACIÓN ===

        const pubkey = LBW_Nostr.getPubkey();
        const npub = LBW_Nostr.getNpub();
        
        // Track locally SOLO si se publicó exitosamente
        const myVoteData = {
            option: option.trim(),
            eventId: result.event.id,
            created_at: Math.floor(Date.now() / 1000),
            pubkey: pubkey, // Guardar pubkey para persistencia
            npub: npub,     // Guardar npub también
            _publishedTo: successfulRelays.map(r => r.relay)
        };
        _myVotes.set(proposalDTag, myVoteData);
        _persistVotesToStorage();
        
        // También agregar a _votes para que se muestre en resultados inmediatamente
        if (!_votes.has(proposalDTag)) _votes.set(proposalDTag, []);
        const votesList = _votes.get(proposalDTag);
        // Eliminar voto anterior si existe (no debería pero por seguridad)
        const existingIdx = votesList.findIndex(v => v.pubkey === pubkey);
        if (existingIdx >= 0) votesList.splice(existingIdx, 1);
        // Agregar nuevo voto
        votesList.push({
            id: result.event.id,
            pubkey: pubkey,
            npub: npub,
            option: option.trim(),
            proposalDTag: proposalDTag,
            created_at: Math.floor(Date.now() / 1000)
        });

        console.log(`[Governance] ✅ Voto registrado: "${option}" para d=${proposalDTag}`);
        return { ...result, relaysUsed: successfulRelays.length };
    }

    // ── Anti-Double-Vote ─────────────────────────────────────
    async function _checkAlreadyVoted(proposalEventId) {
        const pubkey = LBW_Nostr.getPubkey();
        if (!pubkey) return false;

        return new Promise(resolve => {
            const timeout = setTimeout(() => resolve(false), 3000);
            let found = false;

            const sub = LBW_Nostr.subscribe(
                {
                    kinds: [KIND.VOTE],
                    authors: [pubkey],
                    '#e': [proposalEventId],
                    limit: 1
                },
                () => {
                    if (!found) { found = true; clearTimeout(timeout); resolve(true); }
                },
                () => {
                    clearTimeout(timeout);
                    if (!found) resolve(false);
                }
            );

            // Cleanup
            setTimeout(() => { try { LBW_Nostr.unsubscribe(sub); } catch (e) {} }, 3500);
        });
    }

    // ── Subscribe Proposals ──────────────────────────────────
    // Listens for kind 31000 events tagged lbw-governance.
    // Hydrates from cache via SyncEngine if available.

    function subscribeProposals(onProposal) {
        if (onProposal) _onProposalCallbacks.push(onProposal);

        // Load cached proposals from localStorage on first call
        if (_proposals.size === 0) _loadFromStorage();

        // Siempre buscar mis votos en Nostr (si no los tenemos)
        if (_myVotes.size === 0) {
            _fetchMyVotesFromNostr();
        }

        if (_sub) return _sub; // Already subscribed

        _sub = LBW_Nostr.subscribe(
            {
                kinds: [KIND.PROPOSAL],
                '#t': ['lbw-proposal'],
                limit: 100
            },
            (event) => {
                const proposal = _parseProposal(event);
                if (!proposal) return;

                // Replaceable: newer event with same d-tag wins
                const existing = _proposals.get(proposal.dTag);
                if (existing && existing.created_at >= proposal.created_at) return;

                _proposals.set(proposal.dTag, proposal);
                _persistToStorage();

                // Deliver to callbacks
                _onProposalCallbacks.forEach(cb => {
                    try { cb(proposal, existing ? 'updated' : 'new'); }
                    catch (e) { console.warn('[Governance] onProposal error:', e); }
                });
            }
        );

        return _sub;
    }
    
    // ── Fetch My Votes from Nostr ─────────────────────────────
    // Busca todos mis votos en los relays para sincronizar estado
    let _fetchingVotes = false;
    
    function _fetchMyVotesFromNostr() {
        const pubkey = LBW_Nostr.getPubkey();
        if (!pubkey) {
            console.log('[Governance] No hay pubkey, no se pueden buscar votos');
            return;
        }
        
        if (_fetchingVotes) {
            console.log('[Governance] Ya se están buscando votos...');
            return;
        }
        
        _fetchingVotes = true;
        console.log('[Governance] 🔍 Buscando mis votos en Nostr...');
        
        LBW_Nostr.subscribe(
            {
                kinds: [KIND.VOTE],
                authors: [pubkey],
                '#t': ['lbw-vote'],
                limit: 100
            },
            (event) => {
                // Extraer el proposalDTag del evento (buscar tag 'd')
                const dTagTag = event.tags.find(t => t[0] === 'd');
                const proposalDTag = dTagTag ? dTagTag[1] : null;
                
                if (!proposalDTag) {
                    console.warn('[Governance] Voto sin d tag:', event.id?.substring(0, 8));
                    return;
                }
                
                const vote = {
                    id: event.id,
                    pubkey: event.pubkey,
                    npub: LBW_Nostr.pubkeyToNpub(event.pubkey),
                    option: event.content?.trim() || '',
                    proposalDTag,
                    created_at: event.created_at
                };
                
                // Guardar en _myVotes
                const existing = _myVotes.get(proposalDTag);
                if (!existing || vote.created_at > existing.created_at) {
                    _myVotes.set(proposalDTag, {
                        option: vote.option,
                        eventId: vote.id,
                        created_at: vote.created_at,
                        pubkey: vote.pubkey,
                        npub: vote.npub
                    });
                    console.log('[Governance] ✅ Mi voto recuperado de Nostr:', proposalDTag, '-', vote.option);
                }
                
                // También agregar a _votes
                if (!_votes.has(proposalDTag)) _votes.set(proposalDTag, []);
                const votesList = _votes.get(proposalDTag);
                const idx = votesList.findIndex(v => v.pubkey === vote.pubkey);
                if (idx >= 0) {
                    if (vote.created_at > votesList[idx].created_at) {
                        votesList[idx] = vote;
                    }
                } else {
                    votesList.push(vote);
                }
                
                // Persistir
                _persistVotesToStorage();
            },
            () => {
                _fetchingVotes = false;
                console.log('[Governance] 🔍 Búsqueda de mis votos completada. Total:', _myVotes.size);
            }
        );
    }
    
    // Función pública para forzar búsqueda de votos (sin borrar existentes)
    function fetchMyVotes() {
        // No limpiar _myVotes - mantener los existentes mientras buscamos
        _fetchingVotes = false;
        _fetchMyVotesFromNostr();
    }

    // ── Subscribe Votes for a Proposal ───────────────────────
    function subscribeVotes(proposalEventId, proposalDTag, onVote) {
        if (onVote) _onVoteCallbacks.push(onVote);

        // Don't duplicate subscriptions for same proposal
        if (_voteSubs[proposalDTag]) return _voteSubs[proposalDTag];

        const sub = LBW_Nostr.subscribe(
            {
                kinds: [KIND.VOTE],
                '#e': [proposalEventId],
                limit: 500
            },
            (event) => {
                const vote = _parseVote(event, proposalDTag);
                if (!vote) return;

                // Track votes
                if (!_votes.has(proposalDTag)) _votes.set(proposalDTag, []);
                const existing = _votes.get(proposalDTag);

                // Dedup by pubkey (one vote per person)
                const idx = existing.findIndex(v => v.pubkey === vote.pubkey);
                if (idx >= 0) {
                    // Keep newer vote only
                    if (vote.created_at > existing[idx].created_at) {
                        existing[idx] = vote;
                    } else return;
                } else {
                    existing.push(vote);
                }

                // Track own vote
                if (vote.pubkey === LBW_Nostr.getPubkey()) {
                    _myVotes.set(proposalDTag, {
                        option: vote.option,
                        eventId: vote.id,
                        created_at: vote.created_at
                    });
                }
                
                // Persistir votos recibidos
                _persistVotesToStorage();

                // Deliver to callbacks
                _onVoteCallbacks.forEach(cb => {
                    try { cb(vote, proposalDTag); }
                    catch (e) { console.warn('[Governance] onVote error:', e); }
                });
            }
        );

        _voteSubs[proposalDTag] = sub;
        return sub;
    }

    // ── Unsubscribe ──────────────────────────────────────────
    function unsubscribeAll() {
        if (_sub) { LBW_Nostr.unsubscribe(_sub); _sub = null; }
        Object.values(_voteSubs).forEach(s => {
            try { LBW_Nostr.unsubscribe(s); } catch (e) {}
        });
        _voteSubs = {};
        _onProposalCallbacks = [];
        _onVoteCallbacks = [];
    }

    function unsubscribeVotes(proposalDTag) {
        if (_voteSubs[proposalDTag]) {
            LBW_Nostr.unsubscribe(_voteSubs[proposalDTag]);
            delete _voteSubs[proposalDTag];
        }
    }

    // ── Parse Proposal ───────────────────────────────────────
    function _parseProposal(event) {
        try {
            const g = name => (event.tags.find(t => t[0] === name) || [])[1] || '';
            const dTag = g('d');
            if (!dTag) {
                console.warn('[Governance] Propuesta sin d-tag:', event.id?.substring(0, 8));
                return null;
            }

            let parsed = {};
            try { parsed = JSON.parse(event.content); } catch (e) {}

            const expiresAt = parseInt(g('expires'), 10) || 0;
            const nowSecs = Math.floor(Date.now() / 1000);
            let status = g('status') || 'active';

            // Auto-close if expired
            if (status === 'active' && expiresAt > 0 && nowSecs > expiresAt) {
                status = 'expired';
            }

            return {
                id: event.id,
                pubkey: event.pubkey,
                npub: LBW_Nostr.pubkeyToNpub(event.pubkey),
                dTag,
                title: g('title') || 'Sin título',
                description: parsed.description || event.content,
                category: g('category') || 'general',
                status,
                options: parsed.options || DEFAULT_OPTIONS[g('category')] || ['A favor', 'En contra', 'Abstención'],
                candidates: parsed.candidates || null,
                budget: parsed.budget || null,
                quorum: parsed.quorum || null,
                expiresAt,
                createdAt: parseInt(g('created'), 10) || event.created_at,
                created_at: event.created_at,
                tags: event.tags,
                _rawContent: event.content
            };
        } catch (e) {
            console.warn('[Governance] Error parsing proposal:', e);
            return null;
        }
    }

    // ── Parse Vote ───────────────────────────────────────────
    function _parseVote(event, proposalDTag) {
        try {
            return {
                id: event.id,
                pubkey: event.pubkey,
                npub: LBW_Nostr.pubkeyToNpub(event.pubkey),
                option: event.content?.trim() || '',
                proposalDTag,
                created_at: event.created_at
            };
        } catch (e) {
            console.warn('[Governance] Error parsing vote:', e);
            return null;
        }
    }

    // ── Results Calculation ──────────────────────────────────
    // Calculates vote results for a proposal.
    // Returns: { total, results: { option: count }, voters: [pubkeys] }

    function getResults(proposalDTag) {
        const votes = _votes.get(proposalDTag) || [];
        const results = {};
        const voters = [];

        votes.forEach(v => {
            if (!results[v.option]) results[v.option] = 0;
            results[v.option]++;
            voters.push(v.pubkey);
        });

        // Sort by count descending
        const sorted = Object.entries(results)
            .sort((a, b) => b[1] - a[1])
            .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

        return {
            total: votes.length,
            results: sorted,
            voters,
            myVote: _myVotes.get(proposalDTag) || null
        };
    }

    // ── Getters ──────────────────────────────────────────────

    function getProposal(dTag) {
        return _proposals.get(dTag) || null;
    }

    function getAllProposals() {
        return [..._proposals.values()]
            .sort((a, b) => b.created_at - a.created_at);
    }

    function getActiveProposals() {
        return getAllProposals().filter(p => p.status === 'active');
    }

    function getClosedProposals() {
        return getAllProposals().filter(p => p.status !== 'active');
    }

    function getMyVote(proposalDTag) {
        return _myVotes.get(proposalDTag) || null;
    }

    function getVotesForProposal(proposalDTag) {
        return _votes.get(proposalDTag) || [];
    }

    function getStats() {
        const all = getAllProposals();
        return {
            total: all.length,
            active: all.filter(p => p.status === 'active').length,
            closed: all.filter(p => p.status !== 'active').length,
            myProposals: all.filter(p => p.pubkey === LBW_Nostr.getPubkey()).length,
            myVotes: _myVotes.size,
            categories: Object.fromEntries(
                Object.entries(CATEGORIES).map(([k, v]) => [k, all.filter(p => p.category === k).length])
            )
        };
    }

    // ── Time Helpers ─────────────────────────────────────────
    function getTimeLeft(expiresAt) {
        const now = Math.floor(Date.now() / 1000);
        const diff = expiresAt - now;
        if (diff <= 0) return { expired: true, text: 'Expirado' };

        const days = Math.floor(diff / 86400);
        const hours = Math.floor((diff % 86400) / 3600);
        const minutes = Math.floor((diff % 3600) / 60);

        if (days > 0) return { expired: false, text: `${days}d ${hours}h`, days, hours, minutes };
        if (hours > 0) return { expired: false, text: `${hours}h ${minutes}m`, days: 0, hours, minutes };
        return { expired: false, text: `${minutes}m`, days: 0, hours: 0, minutes };
    }

    // ── Reset (logout) ───────────────────────────────────────
    function reset() {
        unsubscribeAll();
        _proposals.clear();
        _votes.clear();
        _myVotes.clear();
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        try { localStorage.removeItem(VOTES_STORAGE_KEY); } catch (e) {}
        try { localStorage.removeItem(ALL_VOTES_STORAGE_KEY); } catch (e) {}
    }

    // ── Public API ───────────────────────────────────────────
    return {
        // Constants
        KIND,
        CATEGORIES,
        DEFAULT_OPTIONS,
        DURATIONS,

        // Publish
        publishProposal,
        closeProposal,
        publishVote,

        // Subscribe
        subscribeProposals,
        subscribeVotes,
        unsubscribeAll,
        unsubscribeVotes,

        // Query
        getProposal,
        getAllProposals,
        getActiveProposals,
        getClosedProposals,
        getResults,
        getMyVote,
        getVotesForProposal,
        getStats,
        getTimeLeft,

        // Lifecycle
        reset,
        reloadMyVotes,
        fetchMyVotes
    };
})();

window.LBW_Governance = LBW_Governance;

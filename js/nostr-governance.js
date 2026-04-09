// ============================================================
// LiberBit World — Governance Module v2.0 (nostr-governance.js)
//
// Decentralized governance over Nostr protocol.
// Proposals (kind 31000) + Votes (kind 31001)
// Results  (kind 31010) + Executions (kind 31011)
// Exec Verification (kind 31012)
//
// Lifecycle: active → expired → approved/rejected/quorum_failed
//            → [approved] in_execution → executed
//
// Merit awards (auto):
//   - Voting Senior+: 5 Responsabilidad (1.2×)
//   - Voting resto:   3 Productiva (1.0×)
//   - Author approved: 50 Productiva
//   - Author rejected: 10 Productiva
//   - Author execution verified: 50 Productiva (via awardMerit, Governor)
//
// Dependencies: nostr.js (LBW_Nostr), nostr-merits.js (LBW_Merits)
// ============================================================

const LBW_Governance = (() => {
    'use strict';

    const KIND = {
        PROPOSAL:    31000,
        VOTE:        31001,
        DELEGATE:    31004,
        RESULT:      31010,   // Proposal result tally
        EXECUTION:   31011,   // Author execution report
        EXEC_VERIFY: 31012    // Governor execution verification
    };

    // ── Proposal Categories ──────────────────────────────────
    const CATEGORIES = {
        referendum:  { label: 'Referéndum',  emoji: '🗳️', description: 'Consulta vinculante a toda la comunidad' },
        budget:      { label: 'Presupuesto', emoji: '💰', description: 'Asignación o modificación presupuestaria' },
        election:    { label: 'Elección',    emoji: '👥', description: 'Elección de representantes o gobernadores' },
    };

    const DEFAULT_OPTIONS = {
        referendum: ['A favor', 'En contra', 'Abstención'],
        budget:     ['Aprobar', 'Rechazar', 'Aplazar'],
        election:   [],
    };

    const DURATIONS = {
        referendum: 7 * 86400,
        budget:     5 * 86400,
        election:   7 * 86400,
    };

    // Options that count as "approved" result
    const APPROVAL_OPTIONS = ['A favor', 'Aprobar'];

    // ── Merit Config ────────────────────────────────────────
    const MERIT_CONFIG = {
        VOTE_SENIOR:    { amount: 5,  category: 'responsabilidad' },
        VOTE_COMMUNITY: { amount: 3,  category: 'productiva' },
        AUTHOR_APPROVED:{ amount: 50, category: 'productiva' },
        AUTHOR_REJECTED:{ amount: 10, category: 'productiva' },
        EXEC_VERIFIED:  { amount: 50, category: 'productiva' },
    };

    // ── Internal State ───────────────────────────────────────
    let _proposals   = new Map();   // dTag → proposal
    let _votes       = new Map();   // dTag → [votes]
    let _myVotes     = new Map();   // dTag → my vote
    let _results     = new Map();   // dTag → result object
    let _executions  = new Map();   // dTag → execution object
    let _onProposalCallbacks = [];
    let _onVoteCallbacks     = [];
    let _onResultCallbacks   = [];
    let _sub         = null;
    let _voteSubs    = {};
    let _resultSub   = null;
    let _execSub     = null;
    let _resultCalcScheduled = new Set();  // dTags with pending calc
    let _fetchingVotes = false;

    // [SEC-23] Buffer of result events (kind 31010) whose signer is
    // not yet known to be a Genesis. Drained whenever new merit data
    // arrives, since the signer's status may have just been confirmed.
    let _pendingResultEvents = [];   // [event]
    const PENDING_RESULT_CAP = 200;
    let _resultDrainHooked = false;
    let _drainingResults = false;

    // ── Storage Keys ────────────────────────────────────────
    const STORAGE_KEY           = 'lbw_governance_proposals';
    const VOTES_STORAGE_KEY     = 'lbw_governance_myvotes';
    const ALL_VOTES_STORAGE_KEY = 'lbw_governance_allvotes';
    const RESULTS_STORAGE_KEY   = 'lbw_governance_results';
    const MERIT_CLAIMED_KEY     = 'lbw_governance_merit_claimed';

    // ── Proposal Numbering ───────────────────────────────────
    // Each proposal carries a permanent sequential number (PRP-001, PRP-002…)
    // embedded as a Nostr tag ['proposal_number', 'N'] at publish time.
    // Legacy proposals (no tag) receive a display-only number assigned
    // silently by created_at order after all proposals are loaded.

    function formatProposalNumber(n) {
        if (!n || n <= 0) return '';
        return 'PRP-' + String(n).padStart(3, '0');
    }

    // Returns the next available number based on the highest known proposal number.
    function _computeNextNumber() {
        let max = 0;
        _proposals.forEach(p => {
            if (p.proposalNumber && p.proposalNumber > max) max = p.proposalNumber;
        });
        return max + 1;
    }

    // Assign sequential numbers to legacy proposals (no embedded tag),
    // sorted by created_at ascending, starting after any already-numbered ones.
    function _assignLegacyNumbers() {
        // Separate proposals with and without numbers
        const withNumber    = [];
        const withoutNumber = [];
        _proposals.forEach(p => {
            if (p.proposalNumber > 0) withNumber.push(p);
            else withoutNumber.push(p);
        });

        if (withoutNumber.length === 0) return;

        // Legacy proposals get numbers starting after the highest existing number
        const maxExisting = withNumber.reduce((m, p) => Math.max(m, p.proposalNumber), 0);

        // Sort legacy by created_at ascending (oldest = lowest number)
        withoutNumber.sort((a, b) => (a.createdAt || a.created_at) - (b.createdAt || b.created_at));

        withoutNumber.forEach((p, i) => {
            p.proposalNumber = maxExisting + i + 1;
        });

        console.log(`[Governance] 🔢 ${withoutNumber.length} propuestas legacy numeradas desde PRP-${String(maxExisting + 1).padStart(3,'0')}`);
    }

    function _votesKey() {
        const pk = LBW_Nostr.getPubkey();
        return pk ? VOTES_STORAGE_KEY + '_' + pk.substring(0, 12) : VOTES_STORAGE_KEY;
    }

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
            localStorage.setItem(_votesKey(), JSON.stringify(data));
        } catch (e) {}
        try {
            const allData = {};
            _votes.forEach((votes, dTag) => { allData[dTag] = votes; });
            localStorage.setItem(ALL_VOTES_STORAGE_KEY, JSON.stringify(allData));
        } catch (e) {}
    }

    function _persistResults() {
        try {
            const data = {};
            _results.forEach((v, k) => { data[k] = v; });
            localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(data));
        } catch (e) {}
    }

    function _loadFromStorage() {
        // Proposals
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                const now = Math.floor(Date.now() / 1000);
                Object.entries(data).forEach(([dTag, proposal]) => {
                    if (!_proposals.has(dTag)) {
                        if (proposal.status === 'active' && proposal.expiresAt && now > proposal.expiresAt) {
                            proposal.status = 'expired';
                        }
                        _proposals.set(dTag, proposal);
                    }
                });
                console.log(`[Governance] 📂 ${_proposals.size} propuestas cargadas de caché`);
            }
        } catch (e) { console.warn('[Governance] Storage load error:', e); }
        // All votes
        try {
            const raw = localStorage.getItem(ALL_VOTES_STORAGE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                Object.entries(data).forEach(([dTag, votes]) => {
                    if (!_votes.has(dTag) && Array.isArray(votes)) {
                        _votes.set(dTag, votes);
                    }
                });
            }
        } catch (e) {}

        // Results
        try {
            const raw = localStorage.getItem(RESULTS_STORAGE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                Object.entries(data).forEach(([dTag, result]) => {
                    _results.set(dTag, result);
                    // Update proposal status based on cached result
                    const proposal = _proposals.get(dTag);
                    if (proposal && proposal.status === 'expired') {
                        proposal.status = result.approved ? 'approved' : 
                                         (result.quorum_met === false ? 'quorum_failed' : 'rejected');
                    }
                });
                console.log(`[Governance] 📂 ${_results.size} resultados cargados de caché`);
            }
        } catch (e) {}

        _loadMyVotes();
        _assignLegacyNumbers();
    }

    function _loadMyVotes() {
        try {
            const raw = localStorage.getItem(_votesKey());
            if (!raw) return;
            const data = JSON.parse(raw);
            const currentPubkey = LBW_Nostr.getPubkey();
            Object.entries(data).forEach(([dTag, vote]) => {
                const votePubkey = vote.pubkey || currentPubkey;
                _myVotes.set(dTag, vote);
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
            console.log(`[Governance] 📂 ${_myVotes.size} votos propios cargados`);
        } catch (e) {}
    }

    function reloadMyVotes() {
        _loadMyVotes();
        if (!_fetchingVotes) {
            setTimeout(() => _fetchMyVotesFromNostr(), 500);
        }
    }

    // ── Publish Proposal ─────────────────────────────────────
    async function publishProposal(data) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');
        if (!data.title?.trim()) throw new Error('Título requerido.');
        if (!data.description?.trim()) throw new Error('Descripción requerida.');

        const category = data.category || 'referendum';
        if (!CATEGORIES[category]) throw new Error(`Categoría inválida: ${category}`);

        const nowSecs = Math.floor(Date.now() / 1000);
        const duration = data.durationSecs || DURATIONS[category];
        const expiresAt = nowSecs + duration;

        let options = data.options;
        if (!options || options.length === 0) {
            if (category === 'election' && data.candidates?.length > 0) {
                options = data.candidates.map(c => c.name || c);
            } else {
                options = DEFAULT_OPTIONS[category] || ['A favor', 'En contra', 'Abstención'];
            }
        }

        const pubkey = LBW_Nostr.getPubkey();
        const dTag = `proposal-${pubkey.substring(0, 8)}-${nowSecs}`;

        // Assign sequential number (permanent, embedded in the Nostr event)
        const proposalNumber = _computeNextNumber();

        const content = JSON.stringify({
            description: data.description.trim(),
            options,
            ...(data.candidates ? { candidates: data.candidates } : {}),
            ...(data.budget ? { budget: data.budget } : {}),
            ...(data.quorum ? { quorum: data.quorum } : {})
        });

        const tags = [
            ['d', dTag],
            ['title', data.title.trim()],
            ['category', category],
            ['status', 'active'],
            ['expires', String(expiresAt)],
            ['created', String(nowSecs)],
            ['proposal_number', String(proposalNumber)],
            ['t', 'lbw-governance'],
            ['t', 'lbw-proposal'],
            ['t', `lbw-${category}`],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({ kind: KIND.PROPOSAL, content, tags });

        if (!result.event?.id) throw new Error('Error creando propuesta. No se generó ID de evento.');

        const successfulRelays = (result.results || []).filter(r => r.success === true);
        if (successfulRelays.length === 0) {
            throw new Error(
                'No se pudo publicar la propuesta en ningún relay.\n\n' +
                'Verifica tu conexión y vuelve a intentar.'
            );
        }

        const localProposal = {
            id: result.event.id, pubkey, npub: LBW_Nostr.getNpub(),
            dTag, title: data.title.trim(), description: data.description.trim(),
            category, status: 'active', options,
            candidates: data.candidates || null, budget: data.budget || null,
            quorum: data.quorum || null, expiresAt, createdAt: nowSecs,
            created_at: nowSecs, proposalNumber, tags, _rawContent: content
        };

        _proposals.set(dTag, localProposal);
        _persistToStorage();
        _onProposalCallbacks.forEach(cb => { try { cb(localProposal, 'new'); } catch (e) {} });

        console.log(`[Governance] 📋 Propuesta publicada: "${data.title}" [${category}] ${formatProposalNumber(proposalNumber)} d=${dTag}`);
        return { ...result, dTag, category, expiresAt, relaysUsed: successfulRelays.length };
    }

    // ── Close Proposal ───────────────────────────────────────
    async function closeProposal(dTag) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');
        const proposal = _proposals.get(dTag);
        if (!proposal) throw new Error('Propuesta no encontrada.');
        if (proposal.pubkey !== LBW_Nostr.getPubkey()) throw new Error('Solo el autor puede cerrar la propuesta.');

        const tags = proposal.tags.map(t => t[0] === 'status' ? ['status', 'closed'] : t);
        const result = await LBW_Nostr.publishEvent({ kind: KIND.PROPOSAL, content: proposal._rawContent, tags });
        console.log(`[Governance] 🔒 Propuesta cerrada: d=${dTag}`);
        return result;
    }

    // ── Publish Vote ─────────────────────────────────────────
    async function publishVote(proposalEventId, proposalDTag, option) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');
        if (!option?.trim()) throw new Error('Opción de voto requerida.');

        const proposal = _proposals.get(proposalDTag);
        if (proposal) {
            if (proposal.status !== 'active') throw new Error('La propuesta ya no está activa.');
            const nowSecs = Math.floor(Date.now() / 1000);
            if (proposal.expiresAt && nowSecs > proposal.expiresAt) throw new Error('El periodo de votación ha expirado.');
            if (proposal.options && !proposal.options.includes(option)) throw new Error(`Opción "${option}" no válida.`);
        }

        if (_myVotes.has(proposalDTag)) throw new Error('Ya has votado en esta propuesta.');

        const alreadyVoted = await _checkAlreadyVoted(proposalEventId);
        if (alreadyVoted) throw new Error('Ya existe un voto tuyo registrado en los relays.');

        const tags = [
            ['e', proposalEventId],
            ['d', proposalDTag],
            ['t', 'lbw-governance'],
            ['t', 'lbw-vote'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({ kind: KIND.VOTE, content: option.trim(), tags });

        if (!result.event?.id) throw new Error('Error registrando voto. No se generó ID de evento.');
        const successfulRelays = (result.results || []).filter(r => r.success === true);
        if (successfulRelays.length === 0) throw new Error('No se pudo registrar el voto en ningún relay.');

        const pubkey = LBW_Nostr.getPubkey();
        const npub = LBW_Nostr.getNpub();

        const myVoteData = {
            option: option.trim(), eventId: result.event.id,
            created_at: Math.floor(Date.now() / 1000),
            pubkey, npub
        };
        _myVotes.set(proposalDTag, myVoteData);

        if (!_votes.has(proposalDTag)) _votes.set(proposalDTag, []);
        const votesList = _votes.get(proposalDTag);
        const existingIdx = votesList.findIndex(v => v.pubkey === pubkey);
        if (existingIdx >= 0) votesList.splice(existingIdx, 1);
        votesList.push({ id: result.event.id, pubkey, npub, option: option.trim(), proposalDTag, created_at: Math.floor(Date.now() / 1000) });

        _persistVotesToStorage();
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
                { kinds: [KIND.VOTE], authors: [pubkey], '#e': [proposalEventId], limit: 1 },
                () => { if (!found) { found = true; clearTimeout(timeout); resolve(true); } },
                () => { clearTimeout(timeout); if (!found) resolve(false); }
            );
            setTimeout(() => { try { LBW_Nostr.unsubscribe(sub); } catch (e) {} }, 3500);
        });
    }

    // ── Subscribe Proposals ──────────────────────────────────
    function subscribeProposals(onProposal) {
        if (onProposal) _onProposalCallbacks.push(onProposal);
        if (_proposals.size === 0) _loadFromStorage();
        if (_myVotes.size === 0) _fetchMyVotesFromNostr();
        if (!_resultSub) _subscribeResultEvents();
        if (!_execSub) _subscribeExecutionEvents();

        if (_sub) return _sub;

        _sub = LBW_Nostr.subscribe(
            { kinds: [KIND.PROPOSAL], '#t': ['lbw-proposal'], limit: 100 },
            (event) => {
                const proposal = _parseProposal(event);
                if (!proposal) return;
                const existing = _proposals.get(proposal.dTag);
                if (existing && existing.created_at >= proposal.created_at) return;
                _proposals.set(proposal.dTag, proposal);
                _persistToStorage();
                _onProposalCallbacks.forEach(cb => { try { cb(proposal, existing ? 'updated' : 'new'); } catch (e) {} });

                // Schedule result calc for expired proposals without a result
                if (proposal.status === 'expired' && !_results.has(proposal.dTag)) {
                    _scheduleResultCalc(proposal.dTag);
                }
            }
        );

        setTimeout(() => {
            _onProposalCallbacks.forEach(cb => { try { cb(null, 'relay-sync'); } catch (e) {} });
            // Assign numbers to any legacy proposals that arrived without a tag
            _assignLegacyNumbers();
            // Check all cached expired proposals
            _proposals.forEach((p, dTag) => {
                if (p.status === 'expired' && !_results.has(dTag)) {
                    _scheduleResultCalc(dTag);
                }
            });
        }, 2500);

        return _sub;
    }

    // ── Subscribe Result Events (kind 31010) ─────────────────
    function _subscribeResultEvents() {
        _resultSub = LBW_Nostr.subscribe(
            { kinds: [KIND.RESULT], '#t': ['lbw-governance'], limit: 200 },
            (event) => {
                // [SEC-23] Result events must come from a Genesis signer.
                _validateAndProcessResultEvent(event);
            }
        );
        _hookResultDrainOnMerits();
    }

    // [SEC-23] Validate and process a result event.
    // The event signer (event.pubkey, already verified by verifyEvent)
    // must be Genesis (≥3000 merits). Without this check, anyone could
    // forge a kind:31010 announcing a fake outcome and the first one
    // received would win the cache.
    function _validateAndProcessResultEvent(event) {
        if (!event || !event.pubkey) return;

        // Trust check on the SIGNER, not on the JSON `calculatedBy` field
        // (which is attacker-controllable).
        let issuerTotal = 0;
        if (typeof LBW_Merits !== 'undefined' && LBW_Merits.getUserMerits) {
            const issuerData = LBW_Merits.getUserMerits(event.pubkey);
            issuerTotal = issuerData ? issuerData.total : 0;
        }

        if (issuerTotal < 3000) {
            // Issuer status unknown or insufficient — park for later.
            // Their merits may simply not have arrived from the relay yet.
            if (_pendingResultEvents.length < PENDING_RESULT_CAP) {
                _pendingResultEvents.push(event);
            } else {
                console.warn('[SEC-23] Pending result buffer full — dropping result from',
                    event.pubkey.substring(0, 12));
            }
            return;
        }

        const result = _parseResult(event);
        if (!result) return;

        // Keep first received valid result per proposal (deterministic)
        const existing = _results.get(result.dTag);
        if (existing) return;

        _results.set(result.dTag, result);
        _persistResults();

        // Update proposal status
        const proposal = _proposals.get(result.dTag);
        if (proposal) {
            proposal.status = result.approved ? 'approved' :
                             (result.quorum_met === false ? 'quorum_failed' : 'rejected');
            _persistToStorage();
        }

        _onResultCallbacks.forEach(cb => { try { cb(result); } catch (e) {} });
        _onProposalCallbacks.forEach(cb => { try { cb(proposal, 'result'); } catch (e) {} });

        // Auto-claim voting merits for current user
        _autoClaimVotingMerits(result.dTag, result);

        console.log(`[Governance] 📊 Resultado recibido: ${result.dTag} → ${result.approved ? 'APROBADA' : result.quorum_met === false ? 'SIN QUORUM' : 'RECHAZADA'}`);
    }

    // [SEC-23] Re-evaluate parked result events. Called whenever a new
    // merit award arrives, since the signer of a parked result may have
    // just crossed the Genesis threshold.
    function _drainPendingResults() {
        if (_drainingResults) return;
        _drainingResults = true;
        try {
            const queue = _pendingResultEvents;
            _pendingResultEvents = [];
            for (const event of queue) {
                _validateAndProcessResultEvent(event);
            }
        } finally {
            _drainingResults = false;
        }
    }

    // [SEC-23] Hook the merit subscription so that, when new merit
    // events arrive, we re-check parked results. Idempotent — runs once.
    function _hookResultDrainOnMerits() {
        if (_resultDrainHooked) return;
        if (typeof LBW_Merits === 'undefined' || !LBW_Merits.subscribeMerits) return;
        try {
            LBW_Merits.subscribeMerits(() => {
                if (_pendingResultEvents.length > 0) _drainPendingResults();
            });
            _resultDrainHooked = true;
        } catch (e) {
            console.warn('[SEC-23] Could not hook merit drain:', e.message);
        }
    }

    // ── Subscribe Execution Events (kind 31011 + 31012) ──────
    function _subscribeExecutionEvents() {
        _execSub = LBW_Nostr.subscribe(
            { kinds: [KIND.EXECUTION, KIND.EXEC_VERIFY], '#t': ['lbw-governance'], limit: 100 },
            (event) => {
                if (event.kind === KIND.EXECUTION) {
                    const exec = _parseExecution(event);
                    if (!exec) return;
                    const existing = _executions.get(exec.dTag);
                    if (!existing || event.created_at > existing.created_at) {
                        _executions.set(exec.dTag, exec);
                        // Update proposal status
                        const proposal = _proposals.get(exec.dTag);
                        if (proposal && proposal.status === 'approved') {
                            proposal.status = 'in_execution';
                            _persistToStorage();
                        }
                        _onProposalCallbacks.forEach(cb => { try { cb(proposal, 'execution'); } catch (e) {} });
                    }
                } else if (event.kind === KIND.EXEC_VERIFY) {
                    _handleExecVerification(event);
                }
            }
        );
    }

    // ── Ensure Voter Merits Loaded ───────────────────────────
    // Subscribes directly to merit events for specific pubkeys and waits
    // until the relay EOSE arrives (or timeout). This guarantees that when
    // we compute the weighted result we have the correct citizenship level
    // for every voter, preventing a false "quorum_failed" when the merit
    // subscription hasn't yet received their records.
    async function _ensureVoterMeritsLoaded(pubkeys, timeoutMs = 6000) {
        if (!pubkeys || pubkeys.length === 0) return;
        if (typeof LBW_Merits === 'undefined') return;
        if (typeof LBW_Nostr === 'undefined') return;

        // Filter to pubkeys that haven't loaded merit records yet
        const missing = pubkeys.filter(pk => {
            try {
                const d = LBW_Merits.getUserMerits(pk);
                // records.length > 0 means we have real data; total > 0 also works
                return (!d || (d.total === 0 && d.records.length === 0));
            } catch (e) { return true; }
        });

        if (missing.length === 0) return; // all already loaded

        console.log(`[Governance] 🔍 Cargando méritos de ${missing.length} votante(s) antes de calcular...`);

        return new Promise(resolve => {
            const done = setTimeout(resolve, timeoutMs);
            const sub = LBW_Nostr.subscribe(
                { kinds: [LBW_Merits.KIND.MERIT], authors: missing, limit: 200 },
                () => {}, // Events are processed by the existing merit subscription
                () => { clearTimeout(done); resolve(); }
            );
            // Always clean up and resolve after timeout
            setTimeout(() => {
                try { LBW_Nostr.unsubscribe(sub); } catch (e) {}
                clearTimeout(done);
                resolve();
            }, timeoutMs + 500);
        });
    }

    // ── Schedule Result Calculation ──────────────────────────
    function _scheduleResultCalc(dTag) {
        if (_resultCalcScheduled.has(dTag)) return;
        if (_results.has(dTag)) return;
        _resultCalcScheduled.add(dTag);

        // Wait 5s to accumulate votes from relay, then calculate
        setTimeout(async () => {
            if (_results.has(dTag)) {
                _resultCalcScheduled.delete(dTag);
                return;
            }
            // Subscribe to votes for this proposal first to ensure we have them
            const proposal = _proposals.get(dTag);
            if (!proposal) { _resultCalcScheduled.delete(dTag); return; }

            console.log(`[Governance] ⏱️ Calculando resultado para: ${dTag}`);

            // Check relay for existing result first
            const alreadyPublished = await _checkResultExists(dTag);
            if (alreadyPublished) {
                _resultCalcScheduled.delete(dTag);
                return;
            }

            // Subscribe to votes if not already done
            subscribeVotes(proposal.id, dTag, null);

            // Wait for votes to load (increased to 8s for slow relays)
            setTimeout(async () => {
                // Pre-load merit data for all voters before computing result
                // This is critical: without this, governors may be misidentified
                // as regular community members (quorum_met = false incorrectly).
                const votes = _votes.get(dTag) || [];
                const voterPubkeys = [...new Set(votes.map(v => v.pubkey).filter(Boolean))];
                await _ensureVoterMeritsLoaded(voterPubkeys, 7000);

                try {
                    await _publishResultForProposal(dTag);
                } catch (err) {
                    console.warn(`[Governance] Error calculando resultado: ${err.message}`);
                }
                _resultCalcScheduled.delete(dTag);
            }, 8000);
        }, 5000);
    }

    // ── Recalculate Result (Governor override) ───────────────
    // Clears a cached quorum_failed result and re-runs the calculation.
    // Only meaningful after merits have finished loading. Governors can
    // call this when they know they voted but the result shows "sin quórum".
    async function recalculateResult(dTag) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');

        const proposal = _proposals.get(dTag);
        if (!proposal) throw new Error('Propuesta no encontrada.');

        const existing = _results.get(dTag);
        // Only allow recalculation if the current result is quorum_failed
        // (to avoid erasing legitimate results)
        if (existing && existing.quorum_met !== false) {
            throw new Error('El resultado ya está calculado correctamente.');
        }

        console.log(`[Governance] 🔄 Recalculando resultado para: ${dTag}`);

        // Clear cached result so _publishResultForProposal can run again
        _results.delete(dTag);
        _resultCalcScheduled.delete(dTag);

        // Persist cleared result
        try {
            const stored = localStorage.getItem(RESULTS_STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored);
                delete data[dTag];
                localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(data));
            }
        } catch (e) {}

        // Reset proposal status to expired so recalc can proceed
        if (proposal.status === 'quorum_failed') {
            proposal.status = 'expired';
            _persistToStorage();
        }

        // Re-subscribe to votes to make sure they're all loaded
        subscribeVotes(proposal.id, dTag, null);

        // Pre-load merit data for all known voters
        const votes = _votes.get(dTag) || [];
        const voterPubkeys = [...new Set(votes.map(v => v.pubkey).filter(Boolean))];
        await _ensureVoterMeritsLoaded(voterPubkeys, 8000);

        // Extra wait in case new votes arrived during merit loading
        await new Promise(r => setTimeout(r, 3000));

        await _publishResultForProposal(dTag);
        _onProposalCallbacks.forEach(cb => { try { cb(proposal, 'result'); } catch (e) {} });

        console.log(`[Governance] ✅ Recálculo completo para: ${dTag}`);
    }

    // Check if a result event already exists on relay
    async function _checkResultExists(dTag) {
        return new Promise(resolve => {
            const timeout = setTimeout(() => resolve(false), 3000);
            let found = false;
            const sub = LBW_Nostr.subscribe(
                { kinds: [KIND.RESULT], '#d': [dTag], limit: 1 },
                () => { if (!found) { found = true; clearTimeout(timeout); resolve(true); } },
                () => { clearTimeout(timeout); if (!found) resolve(false); }
            );
            setTimeout(() => { try { LBW_Nostr.unsubscribe(sub); } catch (e) {} }, 3500);
        });
    }

    // ── Publish Result ───────────────────────────────────────
    async function _publishResultForProposal(dTag) {
        if (!LBW_Nostr.isLoggedIn()) return;
        if (_results.has(dTag)) return;

        const proposal = _proposals.get(dTag);
        if (!proposal) return;
        if (proposal.status === 'active') return; // Not expired yet

        const calc = _calculateWeightedResult(dTag);
        const nowSecs = Math.floor(Date.now() / 1000);

        const content = JSON.stringify({
            dTag,
            proposalId: proposal.id,
            title: proposal.title,
            category: proposal.category,
            quorum_met: calc.quorum_met,
            winner: calc.winner,
            approved: calc.approved || false,
            weighted_votes: calc.weighted,
            total_votes: calc.total_votes,
            voter_count: calc.voter_count,
            calculated_at: nowSecs,
            calculatedBy: LBW_Nostr.getPubkey()
        });

        const status = calc.quorum_met === false ? 'quorum_failed' :
                       calc.approved ? 'approved' : 'rejected';

        const tags = [
            ['d', dTag],
            ['e', proposal.id],
            ['status', status],
            ['winner', calc.winner || ''],
            ['total-votes', String(calc.total_votes)],
            ['quorum-met', String(calc.quorum_met)],
            ['t', 'lbw-governance'],
            ['t', 'lbw-result'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({ kind: KIND.RESULT, content, tags });
        const successfulRelays = (result.results || []).filter(r => r.success === true);

        if (successfulRelays.length > 0) {
            console.log(`[Governance] 📊 Resultado publicado: ${status} (ganador: "${calc.winner}") en ${successfulRelays.length} relay(s)`);
        }
    }

    // ── Calculate Weighted Result ────────────────────────────
    function _calculateWeightedResult(dTag) {
        const votes = _votes.get(dTag) || [];
        const proposal = _proposals.get(dTag);
        const category = proposal?.category || 'referendum';

        if (votes.length === 0) {
            return { quorum_met: false, winner: null, approved: false, weighted: {}, total_votes: 0, voter_count: 0 };
        }

        const weighted = {};
        let quorum_met = false;
        let voterCount = 0;

        for (const vote of votes) {
            if (!vote.option) continue;
            let weight = 1; // fallback equal weight

            if (typeof LBW_Merits !== 'undefined') {
                const userData = LBW_Merits.getUserMerits(vote.pubkey);
                if (userData && userData.total > 0) {
                    weight = userData.total;
                    const bloc = userData.level?.bloc || 'Comunidad';
                    if (bloc === 'Gobernanza') quorum_met = true;
                }
            }

            weighted[vote.option] = (weighted[vote.option] || 0) + weight;
            voterCount++;
        }

        if (!quorum_met) {
            return { quorum_met: false, winner: null, approved: false, weighted, total_votes: votes.length, voter_count: voterCount };
        }

        // Determine winner
        const sorted = Object.entries(weighted).sort((a, b) => b[1] - a[1]);
        const winner = sorted[0]?.[0] || null;

        // Determine if approved
        let approved = false;
        if (winner) {
            if (category === 'election') {
                approved = true; // Elections always produce a winner
            } else {
                approved = APPROVAL_OPTIONS.includes(winner);
            }
        }

        return { quorum_met: true, winner, approved, weighted, total_votes: votes.length, voter_count: voterCount };
    }

    // ── Auto-Claim Voting Merits ──────────────────────────────
    async function _autoClaimVotingMerits(dTag, result) {
        if (!LBW_Nostr.isLoggedIn()) return;
        const pubkey = LBW_Nostr.getPubkey();
        const claimKey = `${MERIT_CLAIMED_KEY}_vote_${dTag}_${pubkey.substring(0, 12)}`;

        // Already claimed?
        if (localStorage.getItem(claimKey)) return;

        // Did this user vote on this proposal?
        const myVote = _myVotes.get(dTag);
        if (!myVote) return;

        // Determine merit tier
        let meritConfig = MERIT_CONFIG.VOTE_COMMUNITY;
        if (typeof LBW_Merits !== 'undefined') {
            const userData = LBW_Merits.getUserMerits(pubkey);
            const bloc = userData?.level?.bloc || 'Comunidad';
            if (bloc === 'Ciudadanía' || bloc === 'Gobernanza') {
                meritConfig = MERIT_CONFIG.VOTE_SENIOR;
            }
        }

        // Mark as claimed before attempting (prevents duplicates on error)
        localStorage.setItem(claimKey, '1');

        try {
            const proposal = _proposals.get(dTag);
            const resultEventId = result.eventId || dTag;
            let category = meritConfig.category;

            // Responsabilidad requires 1000+ in other categories — try it, fallback to productiva
            if (category === 'responsabilidad') {
                try {
                    await LBW_Merits.submitContribution({
                        description: `Participación en votación de gobernanza: "${proposal?.title || dTag}"`,
                        category: 'responsabilidad',
                        amount: meritConfig.amount,
                        currency: 'LBWM',
                        evidence: [resultEventId, dTag]
                    });
                } catch (e) {
                    if (e.message?.includes('requiere al menos')) {
                        // Fallback to productiva
                        await LBW_Merits.submitContribution({
                            description: `Participación en votación de gobernanza: "${proposal?.title || dTag}"`,
                            category: 'productiva',
                            amount: MERIT_CONFIG.VOTE_COMMUNITY.amount,
                            currency: 'LBWM',
                            evidence: [resultEventId, dTag]
                        });
                    } else throw e;
                }
            } else {
                await LBW_Merits.submitContribution({
                    description: `Participación en votación de gobernanza: "${proposal?.title || dTag}"`,
                    category,
                    amount: meritConfig.amount,
                    currency: 'LBWM',
                    evidence: [resultEventId, dTag]
                });
            }
            console.log(`[Governance] 🏅 Méritos de votación reclamados: ${meritConfig.amount} ${meritConfig.category} para ${pubkey.substring(0, 8)}`);
            if (typeof showNotification === 'function') {
                showNotification(`🏅 +${meritConfig.amount} méritos reclamados por participar en la votación`, 'success');
            }
        } catch (err) {
            console.warn('[Governance] Error reclamando méritos de votación:', err.message);
            localStorage.removeItem(claimKey); // Allow retry
        }

        // Also claim author merits if current user is the proposal author
        await _autoClaimAuthorMerits(dTag, result);
    }

    // ── Auto-Claim Author Merits ─────────────────────────────
    async function _autoClaimAuthorMerits(dTag, result) {
        if (!LBW_Nostr.isLoggedIn()) return;
        const pubkey = LBW_Nostr.getPubkey();
        const proposal = _proposals.get(dTag);
        if (!proposal || proposal.pubkey !== pubkey) return;

        const claimKey = `${MERIT_CLAIMED_KEY}_author_${dTag}_${pubkey.substring(0, 12)}`;
        if (localStorage.getItem(claimKey)) return;

        if (result.quorum_met === false) return; // No merits for quorum failure

        const meritConfig = result.approved ? MERIT_CONFIG.AUTHOR_APPROVED : MERIT_CONFIG.AUTHOR_REJECTED;
        localStorage.setItem(claimKey, '1');

        try {
            await LBW_Merits.submitContribution({
                description: `Propuesta de gobernanza ${result.approved ? 'aprobada' : 'rechazada'}: "${proposal.title}"`,
                category: meritConfig.category,
                amount: meritConfig.amount,
                currency: 'LBWM',
                evidence: [proposal.id, dTag]
            });
            console.log(`[Governance] 🏅 Méritos de autor reclamados: ${meritConfig.amount} (propuesta ${result.approved ? 'aprobada' : 'rechazada'})`);
            if (typeof showNotification === 'function') {
                showNotification(`🏅 +${meritConfig.amount} méritos por tu propuesta ${result.approved ? 'aprobada ✅' : 'rechazada'}`, result.approved ? 'success' : 'info');
            }
        } catch (err) {
            console.warn('[Governance] Error reclamando méritos de autor:', err.message);
            localStorage.removeItem(claimKey);
        }
    }

    // ── Publish Execution Report ─────────────────────────────
    async function publishExecution(dTag, data) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');
        const proposal = _proposals.get(dTag);
        if (!proposal) throw new Error('Propuesta no encontrada.');
        if (proposal.pubkey !== LBW_Nostr.getPubkey()) throw new Error('Solo el autor puede reportar la ejecución.');
        if (!['approved'].includes(proposal.status)) throw new Error('Solo se puede reportar ejecución de propuestas aprobadas.');
        if (!data.description?.trim()) throw new Error('Descripción de ejecución requerida.');

        const nowSecs = Math.floor(Date.now() / 1000);
        const content = JSON.stringify({
            description: data.description.trim(),
            evidence: data.evidence || [],
            links: data.links || [],
            reportedAt: nowSecs
        });

        const tags = [
            ['d', dTag],
            ['e', proposal.id],
            ['status', 'in_execution'],
            ['t', 'lbw-governance'],
            ['t', 'lbw-execution'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({ kind: KIND.EXECUTION, content, tags });
        const successfulRelays = (result.results || []).filter(r => r.success === true);
        if (successfulRelays.length === 0) throw new Error('No se pudo publicar el reporte de ejecución.');

        // Update local state
        proposal.status = 'in_execution';
        _persistToStorage();
        const exec = { dTag, proposalId: proposal.id, description: data.description.trim(), evidence: data.evidence || [], created_at: nowSecs, eventId: result.event.id };
        _executions.set(dTag, exec);

        _onProposalCallbacks.forEach(cb => { try { cb(proposal, 'execution'); } catch (e) {} });
        console.log(`[Governance] 📋 Reporte de ejecución publicado: ${dTag}`);
        return result;
    }

    // ── Verify Execution (Governor) ──────────────────────────
    async function verifyExecution(dTag) {
        if (!LBW_Nostr.isLoggedIn()) throw new Error('Login requerido.');

        // Must be a Governor
        if (typeof LBW_Merits !== 'undefined' && !LBW_Merits.isGovernor()) {
            throw new Error('Solo los Génesis pueden verificar ejecuciones.');
        }

        const proposal = _proposals.get(dTag);
        if (!proposal) throw new Error('Propuesta no encontrada.');
        if (!['approved', 'in_execution'].includes(proposal.status)) throw new Error('La propuesta no está en estado de ejecución.');

        const exec = _executions.get(dTag);
        if (!exec) throw new Error('No hay reporte de ejecución para verificar.');

        const pubkey = LBW_Nostr.getPubkey();
        if (proposal.pubkey === pubkey) throw new Error('El autor no puede verificar su propia ejecución.');

        const nowSecs = Math.floor(Date.now() / 1000);
        const content = JSON.stringify({
            verified: true,
            verifiedBy: pubkey,
            verifiedAt: nowSecs
        });

        const tags = [
            ['d', dTag],
            ['e', exec.eventId || proposal.id],
            ['p', proposal.pubkey], // author
            ['status', 'executed'],
            ['t', 'lbw-governance'],
            ['t', 'lbw-exec-verify'],
            ['client', 'LiberBit World']
        ];

        const result = await LBW_Nostr.publishEvent({ kind: KIND.EXEC_VERIFY, content, tags });
        const successfulRelays = (result.results || []).filter(r => r.success === true);
        if (successfulRelays.length === 0) throw new Error('No se pudo publicar la verificación.');

        // Update proposal status
        proposal.status = 'executed';
        _persistToStorage();
        _onProposalCallbacks.forEach(cb => { try { cb(proposal, 'executed'); } catch (e) {} });

        // Award execution merits to author (Governor can call awardMerit directly)
        try {
            await LBW_Merits.awardMerit(
                proposal.pubkey,
                MERIT_CONFIG.EXEC_VERIFIED.amount,
                MERIT_CONFIG.EXEC_VERIFIED.category,
                `Ejecución verificada de propuesta: "${proposal.title}"`
            );
            console.log(`[Governance] 🏅 Méritos de ejecución otorgados al autor: ${MERIT_CONFIG.EXEC_VERIFIED.amount}`);
        } catch (err) {
            console.warn('[Governance] Error otorgando méritos de ejecución:', err.message);
        }

        console.log(`[Governance] ✅ Ejecución verificada: ${dTag}`);
        return result;
    }

    // ── Handle Exec Verification from Relay ──────────────────
    function _handleExecVerification(event) {
        const g = name => (event.tags.find(t => t[0] === name) || [])[1] || '';
        const dTag = g('d');
        if (!dTag) return;
        const proposal = _proposals.get(dTag);
        if (proposal) {
            proposal.status = 'executed';
            _persistToStorage();
            _onProposalCallbacks.forEach(cb => { try { cb(proposal, 'executed'); } catch (e) {} });
        }
    }

    // ── Subscribe Votes ──────────────────────────────────────
    function subscribeVotes(proposalEventId, proposalDTag, onVote) {
        if (onVote) _onVoteCallbacks.push(onVote);
        if (_voteSubs[proposalDTag]) return _voteSubs[proposalDTag];

        const sub = LBW_Nostr.subscribe(
            { kinds: [KIND.VOTE], '#e': [proposalEventId], limit: 500 },
            (event) => {
                const vote = _parseVote(event, proposalDTag);
                if (!vote) return;

                if (!_votes.has(proposalDTag)) _votes.set(proposalDTag, []);
                const existing = _votes.get(proposalDTag);
                const idx = existing.findIndex(v => v.pubkey === vote.pubkey);
                if (idx >= 0) {
                    if (vote.created_at > existing[idx].created_at) existing[idx] = vote;
                    else return;
                } else {
                    existing.push(vote);
                }

                if (vote.pubkey === LBW_Nostr.getPubkey()) {
                    _myVotes.set(proposalDTag, { option: vote.option, eventId: vote.id, created_at: vote.created_at });
                }
                _persistVotesToStorage();
                _onVoteCallbacks.forEach(cb => { try { cb(vote, proposalDTag); } catch (e) {} });
            }
        );

        _voteSubs[proposalDTag] = sub;
        return sub;
    }

    // ── Fetch My Votes from Nostr ────────────────────────────
    function _fetchMyVotesFromNostr() {
        const pubkey = LBW_Nostr.getPubkey();
        if (!pubkey || _fetchingVotes) return;
        _fetchingVotes = true;

        LBW_Nostr.subscribe(
            { kinds: [KIND.VOTE], authors: [pubkey], '#t': ['lbw-vote'], limit: 100 },
            (event) => {
                const dTagTag = event.tags.find(t => t[0] === 'd');
                const proposalDTag = dTagTag ? dTagTag[1] : null;
                if (!proposalDTag) return;

                const vote = { id: event.id, pubkey: event.pubkey, npub: LBW_Nostr.pubkeyToNpub(event.pubkey), option: event.content?.trim() || '', proposalDTag, created_at: event.created_at };
                const existing = _myVotes.get(proposalDTag);
                if (!existing || vote.created_at > existing.created_at) {
                    _myVotes.set(proposalDTag, { option: vote.option, eventId: vote.id, created_at: vote.created_at, pubkey: vote.pubkey, npub: vote.npub });
                }
                if (!_votes.has(proposalDTag)) _votes.set(proposalDTag, []);
                const votesList = _votes.get(proposalDTag);
                const idx = votesList.findIndex(v => v.pubkey === vote.pubkey);
                if (idx >= 0) { if (vote.created_at > votesList[idx].created_at) votesList[idx] = vote; }
                else votesList.push(vote);
                _persistVotesToStorage();
            },
            () => {
                _fetchingVotes = false;
                if (_myVotes.size > 0) {
                    _persistVotesToStorage();
                    _onProposalCallbacks.forEach(cb => { try { cb(null, 'votes-synced'); } catch (e) {} });
                }
            }
        );
    }

    function fetchMyVotes() { _fetchingVotes = false; _fetchMyVotesFromNostr(); }

    // ── Parse Proposal ───────────────────────────────────────
    function _parseProposal(event) {
        try {
            const g = name => (event.tags.find(t => t[0] === name) || [])[1] || '';
            const dTag = g('d');
            if (!dTag) return null;

            let parsed = {};
            try { parsed = JSON.parse(event.content); } catch (e) {}

            const expiresAt = parseInt(g('expires'), 10) || 0;
            const nowSecs = Math.floor(Date.now() / 1000);
            let status = g('status') || 'active';

            if (status === 'active' && expiresAt > 0 && nowSecs > expiresAt) {
                status = 'expired';
            }

            // Apply result status if we have it cached
            const cachedResult = _results.get(dTag);
            if (cachedResult && status === 'expired') {
                status = cachedResult.approved ? 'approved' :
                         (cachedResult.quorum_met === false ? 'quorum_failed' : 'rejected');
            }

            return {
                id: event.id, pubkey: event.pubkey, npub: LBW_Nostr.pubkeyToNpub(event.pubkey),
                dTag, title: g('title') || 'Sin título', description: parsed.description || event.content,
                category: g('category') || 'referendum', status,
                options: parsed.options || DEFAULT_OPTIONS[g('category')] || ['A favor', 'En contra', 'Abstención'],
                candidates: parsed.candidates || null, budget: parsed.budget || null, quorum: parsed.quorum || null,
                expiresAt, createdAt: parseInt(g('created'), 10) || event.created_at,
                created_at: event.created_at,
                proposalNumber: parseInt(g('proposal_number'), 10) || 0,
                tags: event.tags, _rawContent: event.content
            };
        } catch (e) { return null; }
    }

    // ── Parse Result ─────────────────────────────────────────
    function _parseResult(event) {
        try {
            const g = name => (event.tags.find(t => t[0] === name) || [])[1] || '';
            const dTag = g('d');
            if (!dTag) return null;
            let parsed = {};
            try { parsed = JSON.parse(event.content); } catch (e) {}
            return {
                eventId: event.id,
                dTag,
                proposalId: parsed.proposalId || g('e'),
                quorum_met: parsed.quorum_met !== false,
                winner: parsed.winner || g('winner') || null,
                approved: parsed.approved || false,
                weighted_votes: parsed.weighted_votes || {},
                total_votes: parsed.total_votes || parseInt(g('total-votes')) || 0,
                calculated_at: parsed.calculated_at || event.created_at,
                calculatedBy: parsed.calculatedBy || event.pubkey,
                status: g('status')
            };
        } catch (e) { return null; }
    }

    // ── Parse Execution ──────────────────────────────────────
    function _parseExecution(event) {
        try {
            const g = name => (event.tags.find(t => t[0] === name) || [])[1] || '';
            const dTag = g('d');
            if (!dTag) return null;
            let parsed = {};
            try { parsed = JSON.parse(event.content); } catch (e) {}
            return {
                eventId: event.id, dTag,
                description: parsed.description || '',
                evidence: parsed.evidence || [],
                links: parsed.links || [],
                created_at: parsed.reportedAt || event.created_at,
                pubkey: event.pubkey
            };
        } catch (e) { return null; }
    }

    // ── Parse Vote ───────────────────────────────────────────
    function _parseVote(event, proposalDTag) {
        try {
            return { id: event.id, pubkey: event.pubkey, npub: LBW_Nostr.pubkeyToNpub(event.pubkey), option: event.content?.trim() || '', proposalDTag, created_at: event.created_at };
        } catch (e) { return null; }
    }

    // ── Unsubscribe ──────────────────────────────────────────
    function unsubscribeAll() {
        if (_sub) { LBW_Nostr.unsubscribe(_sub); _sub = null; }
        if (_resultSub) { LBW_Nostr.unsubscribe(_resultSub); _resultSub = null; }
        if (_execSub) { LBW_Nostr.unsubscribe(_execSub); _execSub = null; }
        Object.values(_voteSubs).forEach(s => { try { LBW_Nostr.unsubscribe(s); } catch (e) {} });
        _voteSubs = {};
        _onProposalCallbacks = [];
        _onVoteCallbacks = [];
        _onResultCallbacks = [];
    }

    function unsubscribeVotes(proposalDTag) {
        if (_voteSubs[proposalDTag]) { LBW_Nostr.unsubscribe(_voteSubs[proposalDTag]); delete _voteSubs[proposalDTag]; }
    }

    // ── Results Calculation (public) ─────────────────────────
    function getResults(proposalDTag) {
        const votes = _votes.get(proposalDTag) || [];
        const results = {};
        const voters = [];
        votes.forEach(v => { if (!results[v.option]) results[v.option] = 0; results[v.option]++; voters.push(v.pubkey); });
        const sorted = Object.entries(results).sort((a, b) => b[1] - a[1]).reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});
        return { total: votes.length, results: sorted, voters, myVote: _myVotes.get(proposalDTag) || null };
    }

    // ── Getters ──────────────────────────────────────────────
    function getProposal(dTag) { return _proposals.get(dTag) || null; }
    function getResult(dTag) { return _results.get(dTag) || null; }
    function getExecution(dTag) { return _executions.get(dTag) || null; }
    function getMyVote(dTag) { return _myVotes.get(dTag) || null; }
    function getVotesForProposal(dTag) { return _votes.get(dTag) || []; }

    function getAllProposals() {
        return [..._proposals.values()].sort((a, b) => b.created_at - a.created_at);
    }
    function getActiveProposals() { return getAllProposals().filter(p => p.status === 'active'); }
    function getClosedProposals() { return getAllProposals().filter(p => p.status !== 'active'); }

    function getStats() {
        const all = getAllProposals();
        return {
            total: all.length,
            active: all.filter(p => p.status === 'active').length,
            approved: all.filter(p => p.status === 'approved' || p.status === 'in_execution' || p.status === 'executed').length,
            rejected: all.filter(p => p.status === 'rejected').length,
            quorum_failed: all.filter(p => p.status === 'quorum_failed').length,
            executed: all.filter(p => p.status === 'executed').length,
            myProposals: all.filter(p => p.pubkey === LBW_Nostr.getPubkey()).length,
            myVotes: _myVotes.size
        };
    }

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

    // ── Reset ────────────────────────────────────────────────
    function reset() {
        unsubscribeAll();
        _proposals.clear();
        _votes.clear();
        _myVotes.clear();
        _results.clear();
        _executions.clear();
        _resultCalcScheduled.clear();
        _fetchingVotes = false;
        try { localStorage.removeItem(_votesKey()); } catch (e) {}
    }

    // ── Public API ───────────────────────────────────────────
    return {
        KIND, CATEGORIES, DEFAULT_OPTIONS, DURATIONS, MERIT_CONFIG,
        publishProposal, closeProposal, publishVote,
        publishExecution, verifyExecution,
        subscribeProposals, subscribeVotes, unsubscribeAll, unsubscribeVotes,
        getProposal, getAllProposals, getActiveProposals, getClosedProposals,
        getResult, getExecution, getResults,
        getMyVote, getVotesForProposal, getStats, getTimeLeft,
        reset, reloadMyVotes, fetchMyVotes,
        recalculateResult, formatProposalNumber
    };
})();

window.LBW_Governance = LBW_Governance;

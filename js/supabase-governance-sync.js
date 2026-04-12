// ================================================================
// LiberBit World — supabase-governance-sync.js  v1.0
// Sincroniza eventos de gobernanza Nostr → Supabase:
//   - Propuestas (kind 31000)  → tabla 'proposals'
//   - Votos     (kind 31001)  → tabla 'votes'
//   - Resultados (kind 31010) → actualiza proposals.status + votes_for/against/abstain
//   - Ejecuciones (kind 31011) → actualiza proposals.status = 'executed'
// Patrón: clon de supabase-merits-sync.js v1.4
// ================================================================

const LBW_GovernanceSync = (() => {
    'use strict';

    // ── Mapeos de negocio ────────────────────────────────────
    // Mapear category Nostr → proposal_type Supabase (1:1 por ahora)
    function _mapProposalType(category) {
        const valid = { referendum: 'referendum', budget: 'budget', election: 'election' };
        return valid[category] || 'referendum';
    }

    // Mapear vote.option (texto) → vote_type canonico
    function _mapVoteType(option) {
        if (!option) return 'abstain';
        const o = option.toLowerCase().trim();
        if (o === 'a favor' || o === 'aprobar' || o === 'sí' || o === 'si' || o === 'yes') return 'for';
        if (o === 'en contra' || o === 'rechazar' || o === 'no') return 'against';
        if (o === 'abstención' || o === 'abstencion' || o === 'aplazar' || o === 'abstain') return 'abstain';
        return 'other';
    }

    // Mapear status interno → status Supabase
    function _mapStatus(status) {
        const valid = ['pending', 'active', 'expired', 'approved', 'rejected', 'quorum_failed', 'executed'];
        return valid.includes(status) ? status : 'active';
    }

    function _logSupabaseErr(label, err) {
        console.warn('[GovSync] ❌ ' + label + ':',
            'message:', err?.message,
            '| code:', err?.code,
            '| details:', err?.details,
            '| hint:', err?.hint,
            '| status:', err?.status
        );
    }

    function _getAuthorName(pubkey, npub) {
        try {
            if (typeof LBW_Nostr !== 'undefined' && LBW_Nostr.getProfile) {
                const prof = LBW_Nostr.getProfile(pubkey);
                if (prof && (prof.name || prof.display_name)) return prof.display_name || prof.name;
            }
        } catch (e) {}
        return (npub || '').slice(0, 16) + '...';
    }

    // ── Internal state ───────────────────────────────────────
    const _dTagToProposalId = new Map();      // dTag → proposals.id (e.g. "PRP-001")
    const _voteSubsByDTag   = new Map();      // dTag → subscription handle
    const _seenVoteIds      = new Set();      // dedup votos ya sincronizados
    let _voteCallbackRegistered = false;      // evita registrar el callback global de votos más de una vez
    let _initialized = false;

    // Handler único para todos los votos entrantes (el callback es global en LBW_Governance)
    function _onVoteReceived(vote, proposalDTag) {
        syncVoteEvent(vote).then(() => _updateTallies(proposalDTag));
    }

    // ── Sync individual proposal → Supabase ──────────────────
    async function syncProposalEvent(proposal) {
        if (!proposal || !proposal.dTag || !proposal.id) return null;
        if (typeof supabaseClient === 'undefined') return null;

        const row = {
            nostr_event_id: proposal.id,
            nostr_d_tag:    proposal.dTag,
            author_id:      proposal.npub || '',
            author_name:    _getAuthorName(proposal.pubkey, proposal.npub),
            proposal_type:  _mapProposalType(proposal.category),
            title:          proposal.title || 'Sin título',
            description:    proposal.description || '',
            status:         _mapStatus(proposal.status),
            budget_amount:  (proposal.budget && proposal.budget.amount) ? parseInt(proposal.budget.amount, 10) : null,
            candidates:     proposal.candidates || null,
            created_at:     proposal.created_at ? new Date(proposal.created_at * 1000).toISOString() : new Date().toISOString(),
            ends_at:        proposal.expiresAt  ? new Date(proposal.expiresAt  * 1000).toISOString() : new Date(Date.now() + 7*86400000).toISOString(),
            updated_at:     new Date().toISOString()
        };

        // Upsert sobre nostr_event_id (único). Si ya existe, actualiza status/updated_at.
        const { data, error } = await supabaseClient
            .from('proposals')
            .upsert(row, { onConflict: 'nostr_event_id' })
            .select('id, nostr_d_tag')
            .maybeSingle();

        if (error) { _logSupabaseErr('proposals upsert', error); return null; }
        if (data && data.id) {
            _dTagToProposalId.set(proposal.dTag, data.id);
            return data.id;
        }
        return null;
    }

    // ── Sync individual vote → Supabase ──────────────────────
    async function syncVoteEvent(vote) {
        if (!vote || !vote.id || !vote.proposalDTag) return;
        if (typeof supabaseClient === 'undefined') return;
        if (_seenVoteIds.has(vote.id)) return;

        // Resolver proposal_id (PRP-XXX) desde el dTag
        let proposalId = _dTagToProposalId.get(vote.proposalDTag);
        if (!proposalId) {
            // Lookup por nostr_d_tag
            const { data, error } = await supabaseClient
                .from('proposals')
                .select('id')
                .eq('nostr_d_tag', vote.proposalDTag)
                .maybeSingle();
            if (error) { _logSupabaseErr('proposals lookup by d_tag', error); return; }
            if (!data) {
                // La propuesta aún no está en Supabase → sincronizarla primero si la tenemos en memoria
                const prop = LBW_Governance.getProposal ? LBW_Governance.getProposal(vote.proposalDTag) : null;
                if (prop) {
                    proposalId = await syncProposalEvent(prop);
                }
                if (!proposalId) {
                    console.warn('[GovSync] ⏭️  Voto ignorado, propuesta no sincronizada:', vote.proposalDTag);
                    return;
                }
            } else {
                proposalId = data.id;
                _dTagToProposalId.set(vote.proposalDTag, proposalId);
            }
        }

        const row = {
            id:             vote.id,          // nostr event id (hex 64)
            nostr_event_id: vote.id,
            proposal_id:    proposalId,
            voter_id:       vote.npub || '',
            voter_name:     _getAuthorName(vote.pubkey, vote.npub),
            vote_type:      _mapVoteType(vote.option),
            vote_option:    vote.option || '',
            created_at:     vote.created_at ? new Date(vote.created_at * 1000).toISOString() : new Date().toISOString(),
            updated_at:     new Date().toISOString()
        };

        const { error } = await supabaseClient
            .from('votes')
            .upsert(row, { onConflict: 'id' });

        if (error) { _logSupabaseErr('votes upsert', error); return; }
        _seenVoteIds.add(vote.id);
    }

    // ── Update tallies (votes_for/against/abstain) for a proposal ──
    async function _updateTallies(proposalDTag) {
        if (typeof supabaseClient === 'undefined') return;
        const proposalId = _dTagToProposalId.get(proposalDTag);
        if (!proposalId) return;

        // Agregar por vote_type desde Supabase
        const { data, error } = await supabaseClient
            .from('votes')
            .select('vote_type')
            .eq('proposal_id', proposalId);

        if (error) { _logSupabaseErr('votes select for tally', error); return; }

        let votes_for = 0, votes_against = 0, votes_abstain = 0;
        (data || []).forEach(v => {
            if (v.vote_type === 'for') votes_for++;
            else if (v.vote_type === 'against') votes_against++;
            else if (v.vote_type === 'abstain') votes_abstain++;
        });

        const { error: uerr } = await supabaseClient
            .from('proposals')
            .update({ votes_for, votes_against, votes_abstain, updated_at: new Date().toISOString() })
            .eq('id', proposalId);

        if (uerr) _logSupabaseErr('proposals tally update', uerr);
    }

    // ── Auto-suscripción a votos de una propuesta ────────────
    // El callback _onVoteReceived se registra UNA sola vez en LBW_Governance
    // (es global), las demás llamadas solo activan la suscripción Nostr por-propuesta.
    function _subscribeVotesForProposal(proposal) {
        if (!proposal || !proposal.id || !proposal.dTag) return;
        if (_voteSubsByDTag.has(proposal.dTag)) return;

        const cb = _voteCallbackRegistered ? null : _onVoteReceived;
        const sub = LBW_Governance.subscribeVotes(proposal.id, proposal.dTag, cb);
        if (cb) _voteCallbackRegistered = true;
        _voteSubsByDTag.set(proposal.dTag, sub);
    }

    // ── Bootstrap: sincroniza todas las propuestas + votos ───
    async function bootstrapSync() {
        if (typeof LBW_Governance === 'undefined' || typeof supabaseClient === 'undefined') {
            console.warn('[GovSync] LBW_Governance o supabaseClient no disponible');
            return;
        }

        console.log('[GovSync] 🔄 Bootstrap iniciado...');

        // Paso 1: traer todas las propuestas conocidas en memoria
        const all = LBW_Governance.getAllProposals() || [];
        console.log('[GovSync] Propuestas en memoria: ' + all.length);

        let syncedProps = 0;
        for (const p of all) {
            const id = await syncProposalEvent(p);
            if (id) syncedProps++;
        }
        console.log('[GovSync] Propuestas sincronizadas: ' + syncedProps);

        // Paso 2: sincronizar votos conocidos de cada propuesta
        let syncedVotes = 0;
        for (const p of all) {
            const votes = LBW_Governance.getVotesForProposal ? LBW_Governance.getVotesForProposal(p.dTag) : [];
            for (const v of (votes || [])) {
                await syncVoteEvent(v);
                syncedVotes++;
            }
            // Recalcular contadores después
            await _updateTallies(p.dTag);

            // Suscribirse a nuevos votos en tiempo real
            _subscribeVotesForProposal(p);
        }
        console.log('[GovSync] Votos sincronizados: ' + syncedVotes);

        console.log('[GovSync] ✅ Bootstrap completado: ' + syncedProps + ' propuestas, ' + syncedVotes + ' votos');
        return { proposals: syncedProps, votes: syncedVotes };
    }

    // ── Diagnose: verificar conectividad y permisos ──────────
    async function diagnose() {
        console.log('=== GovSync Diagnose ===');
        console.log('supabaseClient:', typeof supabaseClient !== 'undefined' ? '✅' : '❌');
        console.log('LBW_Governance:', typeof LBW_Governance !== 'undefined' ? '✅' : '❌');
        if (typeof supabaseClient === 'undefined') return;

        const { data: d1, error: e1 } = await supabaseClient.from('proposals').select('id').limit(1);
        console.log('SELECT proposals:', e1 ? '❌ ' + e1.message : '✅ OK (' + (d1 || []).length + ' row)');

        const { data: d2, error: e2 } = await supabaseClient.from('votes').select('id').limit(1);
        console.log('SELECT votes:', e2 ? '❌ ' + e2.message : '✅ OK (' + (d2 || []).length + ' row)');

        // Test INSERT (y cleanup)
        const testId = 'test-gov-' + Date.now();
        const testRow = {
            nostr_event_id: testId,
            nostr_d_tag: testId,
            author_id: 'npub1test',
            author_name: 'test',
            proposal_type: 'referendum',
            title: 'test',
            description: 'test',
            status: 'active',
            ends_at: new Date(Date.now() + 86400000).toISOString()
        };
        const { error: e3 } = await supabaseClient.from('proposals').insert(testRow);
        console.log('INSERT proposals:', e3 ? '❌ ' + e3.message : '✅ OK');
        if (!e3) {
            await supabaseClient.from('proposals').delete().eq('nostr_event_id', testId);
            console.log('Test row eliminada');
        }

        // Memory state
        console.log('Cache dTag→id:', _dTagToProposalId.size, 'entries');
        console.log('Suscripciones a votos activas:', _voteSubsByDTag.size);
        console.log('=== Fin ===');
    }

    // ── Handler del callback de subscribeProposals ───────────
    function _onProposalEvent(proposal, eventType) {
        if (!proposal) return;  // eventType puede ser 'relay-sync' sin proposal

        // Nuevo o actualizado: sincronizar
        if (eventType === 'new' || eventType === 'updated' || eventType === 'result' ||
            eventType === 'execution' || eventType === 'executed') {
            syncProposalEvent(proposal).then(() => {
                // Recalcular contadores si viene resultado
                if (eventType === 'result') _updateTallies(proposal.dTag);
                // Auto-suscribirse a votos
                _subscribeVotesForProposal(proposal);
            });
        }
    }

    // ── Init: engancha a LBW_Governance ──────────────────────
    function init() {
        if (_initialized) return;
        if (typeof LBW_Governance === 'undefined') {
            setTimeout(init, 2000);
            return;
        }
        _initialized = true;
        LBW_Governance.subscribeProposals(_onProposalEvent);
        // Bootstrap con delay (deja que LBW_Governance cargue el relay primero)
        setTimeout(bootstrapSync, 5000);
        console.log('[GovSync] ✅ Inicializado v1.0');
    }

    return {
        init,
        syncProposalEvent,
        syncVoteEvent,
        bootstrapSync,
        diagnose
    };
})();

window.LBW_GovernanceSync = LBW_GovernanceSync;

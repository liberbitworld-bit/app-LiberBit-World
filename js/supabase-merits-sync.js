// ================================================================
// LiberBit World — supabase-merits-sync.js  v1.4
// Sincroniza eventos de mérito Nostr (kind 31002) + actividad
// (kind 1, 30402, 31000, 31001) → Supabase.
// ================================================================

const LBW_MeritsSync = (() => {
    'use strict';

    const ACTIVITY_MERIT_CAP = 300;
    const ACTIVITY_POINTS_PER_ACTION = 10;

    const CITIZENSHIP_LEVELS = [
        { name: 'Amigo',            minMerits: 0,    emoji: '👋' },
        { name: 'E-Residency',      minMerits: 100,  emoji: '🪪' },
        { name: 'Colaborador',      minMerits: 500,  emoji: '🤝' },
        { name: 'Ciudadano Senior', minMerits: 1000, emoji: '🛂' },
        { name: 'Custodio',          minMerits: 2000, emoji: '🌍' },
        { name: 'Génesis',           minMerits: 3000, emoji: '👑' }
    ];

    function _getCitizenshipLevel(total) {
        let lvl = CITIZENSHIP_LEVELS[0];
        for (const l of CITIZENSHIP_LEVELS) {
            if (total >= l.minMerits) lvl = l;
        }
        return lvl;
    }

    function _logSupabaseErr(label, err) {
        console.warn('[MeritsSync] ❌ ' + label + ':',
            'message:', err?.message,
            '| code:', err?.code,
            '| details:', err?.details,
            '| hint:', err?.hint,
            '| status:', err?.status,
            '| raw:', err
        );
    }

    function _normalizeCategory(cat) {
        const map = {
            economica: 'economica', productiva: 'productiva',
            responsabilidad: 'responsabilidad', financiada: 'financiada',
            fundacional: 'fundacional',
            financial: 'economica', participation: 'productiva',
            professional: 'productiva', governance: 'responsabilidad',
            infrastructure: 'productiva', community: 'productiva',
            economico: 'economica'
        };
        return map[cat] || 'productiva';
    }

    // ── Sync individual merit event → Supabase ───────────────
    async function syncMeritEvent(merit) {
        if (!merit || !merit.id || !merit.pubkey) return;
        if (typeof supabaseClient === 'undefined') return;

        const { error: evtErr } = await supabaseClient
            .from('lbwm_merit_events')
            .upsert({
                id:               merit.id,
                pubkey:           merit.pubkey,
                npub:             typeof LBW_Nostr !== 'undefined'
                                    ? LBW_Nostr.pubkeyToNpub(merit.pubkey) : '',
                amount:           merit.amount || 0,
                category:         _normalizeCategory(merit.category),
                reason:           merit.reason || '',
                awarded_by:       merit.awardedBy || '',
                nostr_kind:       31002,
                source:           merit.source || 'award',
                nostr_created_at: merit.created_at || Math.floor(Date.now() / 1000)
            }, { onConflict: 'id' });

        if (evtErr) { _logSupabaseErr('merit_events upsert', evtErr); return; }

        // Don't call _upsertUserSummary here — bootstrapSync does it at the end
        // with activity data included.
    }

    // ── Upsert user summary (merits + activity) → Supabase ──
    async function _upsertUserSummary(pubkey, activityData) {
        if (typeof supabaseClient === 'undefined') return;

        const { data: events, error: fetchErr } = await supabaseClient
            .from('lbwm_merit_events')
            .select('amount, category, nostr_created_at')
            .eq('pubkey', pubkey);

        if (fetchErr) { _logSupabaseErr('merit_events fetch', fetchErr); return; }

        const cats = { economica: 0, productiva: 0, responsabilidad: 0, financiada: 0, fundacional: 0 };
        let nostrTotal = 0, firstMeritAt = null;

        if (events && events.length > 0) {
            for (const ev of events) {
                const cat = _normalizeCategory(ev.category);
                if (cats[cat] !== undefined) cats[cat] += (ev.amount || 0);
                nostrTotal += (ev.amount || 0);
                if (!firstMeritAt || ev.nostr_created_at < firstMeritAt) firstMeritAt = ev.nostr_created_at;
            }
        }

        // Activity merits
        const act = activityData || { posts: 0, offers: 0, votes: 0, proposals: 0 };
        const activityCount = act.posts + act.offers + act.votes + act.proposals;
        const activityMerits = Math.min(activityCount * ACTIVITY_POINTS_PER_ACTION, ACTIVITY_MERIT_CAP);

        const total = nostrTotal + activityMerits;
        const lvl  = _getCitizenshipLevel(total);
        const npub = typeof LBW_Nostr !== 'undefined' ? LBW_Nostr.pubkeyToNpub(pubkey) : '';

        const { error: upsertErr } = await supabaseClient
            .from('lbwm_user_merits')
            .upsert({
                pubkey, npub, total,
                economica:          cats.economica,
                productiva:         cats.productiva,
                responsabilidad:    cats.responsabilidad,
                financiada:         cats.financiada,
                fundacional:        cats.fundacional,
                activity_merits:    activityMerits,
                activity_posts:     act.posts,
                activity_offers:    act.offers,
                activity_votes:     act.votes,
                activity_proposals: act.proposals,
                nivel:              lvl.name,
                nivel_emoji:        lvl.emoji,
                first_merit_at:     firstMeritAt ? new Date(firstMeritAt * 1000).toISOString() : null,
                last_updated:       new Date().toISOString()
            }, { onConflict: 'pubkey' });

        if (upsertErr) {
            _logSupabaseErr('user_merits upsert', upsertErr);
        } else {
            console.log('[MeritsSync] ✅ Sincronizado: ' + pubkey.substring(0, 12) +
                ' nostr=' + nostrTotal + ' actividad=' + activityMerits + ' total=' + total);
        }
    }

    // ── Query Nostr for activity events → returns Map<pubkey, counts> ──
    function _queryActivityFromNostr() {
        return new Promise(resolve => {
            if (typeof LBW_Nostr === 'undefined' || !LBW_Nostr.subscribe) {
                console.warn('[MeritsSync] LBW_Nostr no disponible para actividad');
                resolve(new Map());
                return;
            }

            const activity = new Map(); // pubkey → { posts, offers, votes, proposals }
            const seen = new Set();     // dedup by event id
            let subsCompleted = 0;
            const TOTAL_SUBS = 4;

            function _ensure(pubkey) {
                if (!activity.has(pubkey)) {
                    activity.set(pubkey, { posts: 0, offers: 0, votes: 0, proposals: 0 });
                }
                return activity.get(pubkey);
            }

            function _onComplete() {
                subsCompleted++;
                if (subsCompleted >= TOTAL_SUBS) {
                    console.log('[MeritsSync] 📊 Actividad Nostr: ' + activity.size + ' usuarios encontrados');
                    resolve(activity);
                }
            }

            // Timeout global: 15s max
            const timeout = setTimeout(() => {
                console.warn('[MeritsSync] ⏱️ Timeout consultando actividad Nostr');
                resolve(activity);
            }, 15000);

            // 1. Community chat (kind 1, tags: liberbit/lbw)
            const sub1 = LBW_Nostr.subscribe(
                { kinds: [1], '#t': ['liberbit'], limit: 500 },
                (event) => {
                    if (seen.has(event.id)) return;
                    seen.add(event.id);
                    const hasTag = event.tags && event.tags.some(
                        t => t[0] === 't' && (t[1] === 'liberbit' || t[1] === 'lbw')
                    );
                    if (!hasTag) return;
                    _ensure(event.pubkey).posts++;
                },
                () => { try { LBW_Nostr.unsubscribe(sub1); } catch(e) {} _onComplete(); }
            );

            // 2. Marketplace (kind 30402, tag: liberbit-market)
            const sub2 = LBW_Nostr.subscribe(
                { kinds: [30402], '#t': ['liberbit-market'], limit: 500 },
                (event) => {
                    if (seen.has(event.id)) return;
                    seen.add(event.id);
                    _ensure(event.pubkey).offers++;
                },
                () => { try { LBW_Nostr.unsubscribe(sub2); } catch(e) {} _onComplete(); }
            );

            // 3. Proposals (kind 31000, tag: lbw-proposal)
            const sub3 = LBW_Nostr.subscribe(
                { kinds: [31000], '#t': ['lbw-proposal'], limit: 500 },
                (event) => {
                    if (seen.has(event.id)) return;
                    seen.add(event.id);
                    _ensure(event.pubkey).proposals++;
                },
                () => { try { LBW_Nostr.unsubscribe(sub3); } catch(e) {} _onComplete(); }
            );

            // 4. Votes (kind 31001, tag: lbw-governance)
            const sub4 = LBW_Nostr.subscribe(
                { kinds: [31001], '#t': ['lbw-governance'], limit: 500 },
                (event) => {
                    if (seen.has(event.id)) return;
                    seen.add(event.id);
                    _ensure(event.pubkey).votes++;
                },
                () => {
                    try { LBW_Nostr.unsubscribe(sub4); } catch(e) {}
                    clearTimeout(timeout);
                    _onComplete();
                }
            );
        });
    }

    // ── Bootstrap: sync all merits + activity → Supabase ─────
    async function bootstrapSync() {
        if (typeof LBW_Merits === 'undefined' || typeof supabaseClient === 'undefined') return;

        console.log('[MeritsSync] 🔄 Bootstrap iniciado...');

        // Step 1: Sync formal merit events (kind 31002)
        const lb = LBW_Merits.getLeaderboard(999);
        console.log('[MeritsSync] Entradas leaderboard: ' + lb.length);

        let synced = 0;
        const allPubkeys = new Set();

        for (const entry of lb) {
            allPubkeys.add(entry.pubkey);
            const userData = LBW_Merits.getUserMerits(entry.pubkey);
            const records = userData?.records || entry.records || [];
            if (records.length === 0) continue;
            for (const record of records) {
                await syncMeritEvent({
                    id:         record.id,
                    pubkey:     entry.pubkey,
                    amount:     record.amount,
                    category:   record.category,
                    reason:     record.reason || '',
                    awardedBy:  record.awardedBy || '',
                    source:     record.source || 'award',
                    created_at: record.created_at
                });
                synced++;
            }
        }
        console.log('[MeritsSync] Eventos de mérito sincronizados: ' + synced);

        // Step 2: Query activity from Nostr relays
        console.log('[MeritsSync] 🔍 Consultando actividad desde Nostr...');
        const activityMap = await _queryActivityFromNostr();

        // Merge pubkeys from activity (users with activity but no formal merits)
        activityMap.forEach((_, pk) => allPubkeys.add(pk));

        // Step 3: Upsert user summaries with activity included
        let summaries = 0;
        for (const pubkey of allPubkeys) {
            const act = activityMap.get(pubkey) || { posts: 0, offers: 0, votes: 0, proposals: 0 };
            await _upsertUserSummary(pubkey, act);
            summaries++;
        }

        console.log('[MeritsSync] ✅ Bootstrap completado: ' + synced + ' eventos, ' + summaries + ' usuarios sincronizados');
        return synced;
    }

    // ── Load ledger from Supabase ────────────────────────────
    async function loadSupabaseLedger({ limit = 200, orderBy = 'total', category = null } = {}) {
        if (typeof supabaseClient === 'undefined') return null;

        let query = supabaseClient
            .from('lbwm_user_merits')
            .select('*')
            .order(orderBy, { ascending: false })
            .limit(limit);

        if (category) query = query.gt(category, 0);

        const { data: users, error: usersErr } = await query;

        if (usersErr) {
            _logSupabaseErr('loadSupabaseLedger SELECT', usersErr);
            return null;
        }

        const list = users || [];
        const totalMerits = list.reduce((s, u) => s + (u.total || 0), 0);
        const stats = {
            totalUsers:  list.length,
            totalMerits,
            byCategory: {
                economica:       list.reduce((s, u) => s + (u.economica || 0), 0),
                productiva:      list.reduce((s, u) => s + (u.productiva || 0), 0),
                responsabilidad: list.reduce((s, u) => s + (u.responsabilidad || 0), 0),
                financiada:      list.reduce((s, u) => s + (u.financiada || 0), 0),
                fundacional:     list.reduce((s, u) => s + (u.fundacional || 0), 0)
            }
        };

        console.log('[MeritsSync] Ledger cargado: ' + list.length + ' usuarios');
        return { users: list, stats };
    }

    // ── Diagnóstico — ejecutar desde consola: LBW_MeritsSync.diagnose()
    async function diagnose() {
        console.log('=== MeritsSync Diagnose ===');
        console.log('supabaseClient:', typeof supabaseClient !== 'undefined' ? '✅' : '❌ no disponible');
        console.log('LBW_Merits:', typeof LBW_Merits !== 'undefined' ? '✅' : '❌ no disponible');
        if (typeof supabaseClient === 'undefined') return;

        const { data: d1, error: e1 } = await supabaseClient.from('lbwm_merit_events').select('id').limit(1);
        console.log('SELECT lbwm_merit_events:', e1 ? '❌ ' + e1.message + ' | code:' + e1.code : '✅ OK, rows: ' + (d1||[]).length);

        const { data: d2, error: e2 } = await supabaseClient.from('lbwm_user_merits').select('pubkey').limit(1);
        console.log('SELECT lbwm_user_merits:', e2 ? '❌ ' + e2.message + ' | code:' + e2.code : '✅ OK, rows: ' + (d2||[]).length);

        const testId = 'test-diag-' + Date.now();
        const { error: e3 } = await supabaseClient.from('lbwm_merit_events').upsert({
            id: testId, pubkey: 'test-pubkey', npub: 'test-npub',
            amount: 1, category: 'productiva', nostr_kind: 31002, source: 'test',
            nostr_created_at: Math.floor(Date.now() / 1000)
        }, { onConflict: 'id' });
        console.log('INSERT lbwm_merit_events:', e3 ? '❌ ' + e3.message + ' | code:' + e3.code : '✅ OK');

        if (!e3) {
            await supabaseClient.from('lbwm_merit_events').delete().eq('id', testId);
            console.log('Test row eliminada');
        }
        console.log('=== Fin ===');
    }

    function init() {
        if (typeof LBW_Merits === 'undefined') {
            setTimeout(init, 2000);
            return;
        }
        LBW_Merits.subscribeMerits((merit) => { syncMeritEvent(merit); });
        setTimeout(bootstrapSync, 5000);
        console.log('[MeritsSync] ✅ Inicializado v1.4');
    }

    return { init, syncMeritEvent, bootstrapSync, loadSupabaseLedger, diagnose };
})();

window.LBW_MeritsSync = LBW_MeritsSync;

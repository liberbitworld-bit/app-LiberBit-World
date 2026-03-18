// ================================================================
// LiberBit World — supabase-merits-sync.js
// Sincroniza eventos de mérito Nostr (kind 31002) → Supabase.
//
// Responsabilidades:
//   - Escuchar nuevos merit events via LBW_Merits.subscribeMerits()
//   - Insertar en lbwm_merit_events (log inmutable)
//   - Hacer upsert en lbwm_user_merits (resumen por usuario)
//   - Exponer loadSupabaseLedger() para el tab Ledger
//
// Dependencias: supabaseClient, LBW_Merits, LBW_Nostr
// ================================================================

const LBW_MeritsSync = (() => {
    'use strict';

    const CITIZENSHIP_LEVELS = [
        { name: 'Amigo',            minMerits: 0,    emoji: '👋' },
        { name: 'E-Residency',      minMerits: 100,  emoji: '🪪' },
        { name: 'Colaborador',      minMerits: 500,  emoji: '🤝' },
        { name: 'Ciudadano Senior', minMerits: 1000, emoji: '🛂' },
        { name: 'Embajador',        minMerits: 2000, emoji: '🌍' },
        { name: 'Gobernador',       minMerits: 3000, emoji: '👑' }
    ];

    function _getCitizenshipLevel(total) {
        let lvl = CITIZENSHIP_LEVELS[0];
        for (const l of CITIZENSHIP_LEVELS) {
            if (total >= l.minMerits) lvl = l;
        }
        return lvl;
    }

    // ── Sync a single merit event to Supabase ────────────────
    async function syncMeritEvent(merit) {
        if (!merit || !merit.id || !merit.pubkey) return;
        if (typeof supabaseClient === 'undefined') return;

        try {
            // 1. Insert into events log (ignore duplicates via ON CONFLICT DO NOTHING)
            const { error: evtErr } = await supabaseClient
                .from('lbwm_merit_events')
                .upsert({
                    id:               merit.id,
                    pubkey:           merit.pubkey,
                    npub:             typeof LBW_Nostr !== 'undefined'
                                        ? LBW_Nostr.pubkeyToNpub(merit.pubkey)
                                        : '',
                    amount:           merit.amount || 0,
                    category:         _normalizeCategory(merit.category),
                    reason:           merit.reason || '',
                    awarded_by:       merit.awardedBy || '',
                    nostr_kind:       31002,
                    source:           merit.source || 'award',
                    nostr_created_at: merit.created_at || Math.floor(Date.now() / 1000)
                }, { onConflict: 'id', ignoreDuplicates: true });

            if (evtErr) {
                console.warn('[MeritsSync] Event insert error:', evtErr.message);
                return;
            }

            // 2. Upsert user summary
            await _upsertUserSummary(merit.pubkey);

        } catch (e) {
            console.warn('[MeritsSync] Sync error:', e.message);
        }
    }

    // ── Rebuild user summary from events table ───────────────
    async function _upsertUserSummary(pubkey) {
        if (typeof supabaseClient === 'undefined') return;

        // Fetch all events for this user from Supabase
        const { data: events, error } = await supabaseClient
            .from('lbwm_merit_events')
            .select('amount, category, nostr_created_at')
            .eq('pubkey', pubkey);

        if (error || !events) return;

        // Aggregate by category
        const cats = {
            economica: 0, productiva: 0,
            responsabilidad: 0, financiada: 0, fundacional: 0
        };
        let total = 0;
        let firstMeritAt = null;

        for (const ev of events) {
            const cat = _normalizeCategory(ev.category);
            if (cats[cat] !== undefined) cats[cat] += ev.amount;
            total += ev.amount;
            if (!firstMeritAt || ev.nostr_created_at < firstMeritAt) {
                firstMeritAt = ev.nostr_created_at;
            }
        }

        const lvl = _getCitizenshipLevel(total);
        const npub = typeof LBW_Nostr !== 'undefined'
            ? LBW_Nostr.pubkeyToNpub(pubkey) : '';

        const { error: upsertErr } = await supabaseClient
            .from('lbwm_user_merits')
            .upsert({
                pubkey,
                npub,
                total,
                economica:       cats.economica,
                productiva:      cats.productiva,
                responsabilidad: cats.responsabilidad,
                financiada:      cats.financiada,
                fundacional:     cats.fundacional,
                nivel:           lvl.name,
                nivel_emoji:     lvl.emoji,
                first_merit_at:  firstMeritAt
                    ? new Date(firstMeritAt * 1000).toISOString()
                    : null,
                last_updated:    new Date().toISOString()
            }, { onConflict: 'pubkey' });

        if (upsertErr) {
            console.warn('[MeritsSync] User upsert error:', upsertErr.message);
        }
    }

    // ── Category normalization ────────────────────────────────
    function _normalizeCategory(cat) {
        const map = {
            economica: 'economica', productiva: 'productiva',
            responsabilidad: 'responsabilidad', financiada: 'financiada',
            fundacional: 'fundacional',
            // Legacy v1
            financial: 'economica', participation: 'productiva',
            professional: 'productiva', governance: 'responsabilidad',
            infrastructure: 'productiva', community: 'productiva',
            economico: 'economica'
        };
        return map[cat] || 'productiva';
    }

    // ── Bootstrap: sync ALL Nostr merits already in memory ───
    // Call once after subscribeMerits() has loaded events from relay.
    async function bootstrapSync() {
        if (typeof LBW_Merits === 'undefined') return;
        if (typeof supabaseClient === 'undefined') return;

        console.log('[MeritsSync] 🔄 Bootstrap sync iniciado...');
        const lb = LBW_Merits.getLeaderboard(999);
        let synced = 0;

        for (const entry of lb) {
            if (!entry.records || entry.records.length === 0) continue;
            for (const record of entry.records) {
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

        console.log(`[MeritsSync] ✅ Bootstrap completado: ${synced} eventos sincronizados`);
        return synced;
    }

    // ── Load ledger from Supabase (for Ledger tab) ────────────
    // Returns { users, events, stats }
    async function loadSupabaseLedger({ limit = 100, orderBy = 'total', category = null } = {}) {
        if (typeof supabaseClient === 'undefined') return null;

        try {
            // Query user summary table
            let query = supabaseClient
                .from('lbwm_user_merits')
                .select('*')
                .order(orderBy, { ascending: false })
                .limit(limit);

            if (category) {
                query = query.gt(category, 0);
            }

            const { data: users, error: usersErr } = await query;
            if (usersErr) throw usersErr;

            // Stats
            const totalMerits = (users || []).reduce((s, u) => s + (u.total || 0), 0);
            const stats = {
                totalUsers:     (users || []).length,
                totalMerits,
                byCategory: {
                    economica:       (users || []).reduce((s, u) => s + (u.economica || 0), 0),
                    productiva:      (users || []).reduce((s, u) => s + (u.productiva || 0), 0),
                    responsabilidad: (users || []).reduce((s, u) => s + (u.responsabilidad || 0), 0),
                    financiada:      (users || []).reduce((s, u) => s + (u.financiada || 0), 0),
                    fundacional:     (users || []).reduce((s, u) => s + (u.fundacional || 0), 0)
                }
            };

            return { users: users || [], stats };

        } catch (e) {
            console.warn('[MeritsSync] loadSupabaseLedger error:', e.message);
            return null;
        }
    }

    // ── Initialize: hook into merit subscription ─────────────
    function init() {
        if (typeof LBW_Merits === 'undefined') {
            console.warn('[MeritsSync] LBW_Merits no disponible — reintentando en 2s');
            setTimeout(init, 2000);
            return;
        }

        // Listen for new merit events and sync them
        LBW_Merits.subscribeMerits((merit) => {
            syncMeritEvent(merit);
        });

        // Bootstrap sync after relay data loads (5s delay)
        setTimeout(bootstrapSync, 5000);

        console.log('[MeritsSync] ✅ Inicializado — sincronizando mérits → Supabase');
    }

    return {
        init,
        syncMeritEvent,
        bootstrapSync,
        loadSupabaseLedger
    };
})();

window.LBW_MeritsSync = LBW_MeritsSync;

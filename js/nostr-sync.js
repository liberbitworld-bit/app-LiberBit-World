// ============================================================
// LiberBit World — Nostr SyncEngine v1.0 (nostr-sync.js)
//
// Incremental sync layer. Wraps LBW_Nostr subscriptions with:
//   - Cursor-based `since` (only fetch new events)
//   - Hydrate-from-cache on startup (instant UI)
//   - Auto-persist incoming events to IndexedDB
//   - Auto-prune old events to limit storage
//
// Pattern: hydrate(cache) → render → subscribe(since) → update
//
// Dependencies: nostr-store.js (LBW_Store), nostr.js (LBW_Nostr)
// ============================================================

const LBW_Sync = (() => {
    'use strict';

    // ── Feed Registry ────────────────────────────────────────
    // Each "feed" is a named subscription with its own cursor.
    // Feeds can be hydrated from cache and synced incrementally.
    const _feeds = {};  // feedId -> { sub, kind, filters, onEvent, cursorKey }

    let _initialized = false;

    // ── Initialization ───────────────────────────────────────
    async function init() {
        if (_initialized) return;
        await LBW_Store.init();
        _initialized = true;
        console.log('[Sync] ✅ SyncEngine inicializado');
    }

    // ── Core: Synced Subscribe ───────────────────────────────
    // Creates a subscription that:
    //   1. Loads cached events from IndexedDB → calls onEvent for each
    //   2. Gets the cursor (last seen timestamp)
    //   3. Subscribes to relay with `since = cursor`
    //   4. On each new event: persists to IndexedDB + advances cursor
    //
    // Returns: feedId (string) for later unsubscribe

    async function syncedSubscribe(feedId, options) {
        const {
            kind,                    // Event kind (number)
            filters = {},            // Additional filter fields (e.g. #t, authors)
            onEvent,                 // Callback: (event, source) => void
            onHydrated = null,       // Called after cache hydration: (events) => void
            relayUrls = null,        // Override relay URLs
            cacheLimit = 100,        // Max events to load from cache
            pruneKeep = 300,         // Max events to keep in IndexedDB per kind
            tagFilter = null         // { tagName: [values] } for cache query
        } = options;

        await init();

        // 1. HYDRATE FROM CACHE
        const cursorKey = `${feedId}:cursor`;
        let cachedEvents = [];

        try {
            cachedEvents = await LBW_Store.getEventsByKind(kind, {
                limit: cacheLimit,
                since: 0,
                tags: tagFilter
            });
        } catch (e) {
            console.warn(`[Sync] Cache read error for ${feedId}:`, e);
        }

        if (cachedEvents.length > 0) {
            console.log(`[Sync] 📦 ${feedId}: ${cachedEvents.length} eventos desde cache`);

            // Deliver cached events to callback (oldest first for chat)
            const sorted = [...cachedEvents].sort((a, b) => a.created_at - b.created_at);
            sorted.forEach(ev => {
                try { onEvent(ev, 'cache'); } catch (e) { console.warn('[Sync] onEvent error (cache):', e); }
            });

            if (onHydrated) onHydrated(cachedEvents);
        }

        // 2. GET CURSOR (last seen timestamp)
        let since = 0;
        try {
            since = await LBW_Store.getCursor(cursorKey);
        } catch (e) {}

        // If we have cached events, use the newest one's timestamp as fallback
        if (since === 0 && cachedEvents.length > 0) {
            since = Math.max(...cachedEvents.map(e => e.created_at));
        }

        // Small overlap to catch events that arrived in the gap
        if (since > 0) since = since - 5;

        // 3. SUBSCRIBE TO RELAYS (incremental)
        const subFilter = {
            kinds: [kind],
            ...filters,
            limit: cacheLimit
        };
        if (since > 0) subFilter.since = since;

        const sub = LBW_Nostr.subscribe(
            subFilter,
            async (event) => {
                // Persist to IndexedDB (smart routing by kind)
                try {
                    if (event.kind === 5) {
                        // Kind 5: DELETE — remove referenced events
                        const result = await LBW_Store.processDeleteEvent(event);
                        if (result.deleted > 0) {
                            console.log(`[Sync] 🗑️ Kind 5: eliminados ${result.deleted} eventos`);
                        }
                        await LBW_Store.putEvent(event); // also store the delete event itself
                    } else if (event.kind >= 30000 && event.kind < 40000) {
                        // Parameterized replaceable: canonical state
                        const result = await LBW_Store.putReplaceableEvent(event);
                        if (result.replaced) {
                            console.log(`[Sync] 🔄 Replaceable actualizado: ${event.kind}:${event.id.substring(0, 8)} reemplaza ${result.replaced.substring(0, 8)}`);
                        }
                    } else {
                        // Regular event
                        await LBW_Store.putEvent(event);
                    }
                } catch (e) {
                    console.warn(`[Sync] Store write error:`, e);
                }

                // Update cursor (with clamping: never advance beyond now + 10min)
                try {
                    const nowSecs = Math.floor(Date.now() / 1000);
                    const maxAllowed = nowSecs + 600; // 10 min future tolerance
                    const clampedTs = Math.min(event.created_at, maxAllowed);
                    const currentCursor = await LBW_Store.getCursor(cursorKey);
                    if (clampedTs > currentCursor) {
                        await LBW_Store.setCursor(cursorKey, clampedTs);
                    }
                } catch (e) {}

                // Deliver to callback
                try {
                    onEvent(event, 'relay');
                } catch (e) {
                    console.warn('[Sync] onEvent error (relay):', e);
                }

                // Auto-persist profile if kind 0
                if (event.kind === 0) {
                    try {
                        const profile = JSON.parse(event.content);
                        await LBW_Store.putProfile(event.pubkey, profile);
                    } catch (e) {}
                }
            },
            // onEose: after initial sync, prune old events
            async () => {
                try {
                    const pruned = await LBW_Store.pruneEvents(kind, pruneKeep);
                    if (pruned > 0) console.log(`[Sync] 🧹 ${feedId}: prunados ${pruned} eventos viejos`);
                } catch (e) {}
            },
            relayUrls
        );

        // Register feed
        _feeds[feedId] = {
            sub,
            kind,
            cursorKey,
            active: true
        };

        console.log(`[Sync] 📡 ${feedId}: suscrito (since=${since > 0 ? new Date(since * 1000).toISOString() : 'inicio'})`);

        return feedId;
    }

    // ── Unsubscribe a feed ───────────────────────────────────
    function unsyncFeed(feedId) {
        const feed = _feeds[feedId];
        if (!feed) return;

        if (feed.sub) {
            LBW_Nostr.unsubscribe(feed.sub);
        }
        feed.active = false;
        delete _feeds[feedId];
        console.log(`[Sync] ⏹️ ${feedId}: desuscrito`);
    }

    // ── Unsubscribe all feeds ────────────────────────────────
    function unsyncAll() {
        Object.keys(_feeds).forEach(feedId => unsyncFeed(feedId));
    }

    // ── Profile Resolution (cache-first) ─────────────────────
    async function resolveProfile(pubkey) {
        // 1. Try cache first
        try {
            const cached = await LBW_Store.getProfile(pubkey);
            if (cached && cached._updated_at > Date.now() - 3600000) {
                // Fresh enough (< 1 hour old)
                return cached;
            }
        } catch (e) {}

        // 2. Fetch from relay
        try {
            const profile = await LBW_Nostr.fetchUserProfile(pubkey);
            if (profile) {
                await LBW_Store.putProfile(pubkey, profile);
                return profile;
            }
        } catch (e) {}

        // 3. Return stale cache if relay fails
        try {
            const stale = await LBW_Store.getProfile(pubkey);
            if (stale) return stale;
        } catch (e) {}

        return null;
    }

    // ── Convenience: Synced Community Chat ───────────────────
    async function syncCommunityChat(onMessage, onHydrated = null) {
        return syncedSubscribe('community-chat', {
            kind: LBW_Nostr.EVENT_KINDS.TEXT_NOTE,
            filters: { '#t': ['liberbit', 'lbw'] },
            tagFilter: { t: ['liberbit', 'lbw'] },
            onEvent: (event, source) => {
                const npub = LBW_Nostr.pubkeyToNpub(event.pubkey);
                onMessage({
                    id: event.id,
                    pubkey: event.pubkey,
                    npub,
                    content: event.content,
                    created_at: event.created_at,
                    tags: event.tags,
                    isReply: event.tags.some(t => t[0] === 'e'),
                    replyTo: (event.tags.find(t => t[0] === 'e') || [])[1] || null,
                    _source: source
                });
            },
            onHydrated,
            cacheLimit: 50,
            pruneKeep: 200
        });
    }

    // ── Convenience: Synced Marketplace ──────────────────────
    async function syncMarketplace(onListing, onHydrated = null) {
        return syncedSubscribe('marketplace', {
            kind: LBW_Nostr.EVENT_KINDS.MARKETPLACE,
            filters: { '#t': ['liberbit-market'] },
            tagFilter: { t: ['liberbit-market'] },
            onEvent: (event, source) => {
                const g = name => (event.tags.find(t => t[0] === name) || [])[1] || '';
                onListing({
                    id: event.id,
                    pubkey: event.pubkey,
                    npub: LBW_Nostr.pubkeyToNpub(event.pubkey),
                    title: g('title') || g('subject') || 'Sin título',
                    description: event.content,
                    category: g('category') || 'servicios',
                    price: g('price') || 'A negociar',
                    currency: g('currency') || 'sats',
                    emoji: g('emoji') || '🏪',
                    image: g('image') || g('thumb') || '',
                    images: _parseImageUrls(event.tags),
                    location: g('location') || '',
                    status: g('status') || 'active',
                    created_at: event.created_at,
                    tags: event.tags,
                    dTag: g('d'),
                    _source: source
                });
            },
            onHydrated,
            cacheLimit: 50,
            pruneKeep: 200
        });
    }

    // Parse multiple image URLs from tags (NIP-99 style)
    function _parseImageUrls(tags) {
        const urls = [];
        tags.forEach(t => {
            if (t[0] === 'image' || t[0] === 'thumb') {
                if (t[1]) urls.push(t[1]);
            }
        });
        return urls;
    }

    // ── Convenience: Synced DMs (private relays only) ────────
    // DMs are special: we DON'T cache them in IndexedDB in
    // plaintext for security. We only cache the encrypted blobs
    // and decrypt on demand.
    async function syncDirectMessages(onMessage, onHydrated = null) {
        const pubkey = LBW_Nostr.getPubkey();
        if (!pubkey) throw new Error('No hay pubkey. Login primero.');

        // DMs: use the raw LBW_Nostr DM subscription but
        // persist encrypted events for cursor tracking.
        const cursorKey = 'dms:cursor';
        let since = 0;
        try {
            since = await LBW_Store.getCursor(cursorKey);
            if (since > 0) since -= 5;
        } catch (e) {}

        // We DON'T hydrate DMs from cache (security: no plaintext storage).
        // The subscription will re-fetch from private relays.

        const subs = LBW_Nostr.subscribeDirectMessages(async (msg) => {
            // Update cursor
            try {
                const c = await LBW_Store.getCursor(cursorKey);
                if (msg.created_at > c) await LBW_Store.setCursor(cursorKey, msg.created_at);
            } catch (e) {}

            onMessage(msg);
        });

        _feeds['direct-messages'] = {
            sub: subs,
            kind: LBW_Nostr.EVENT_KINDS.ENCRYPTED_DM,
            cursorKey,
            active: true,
            // Special: compound sub (subIn + subOut)
            _cleanup: () => {
                LBW_Nostr.unsubscribe(subs.subIn);
                LBW_Nostr.unsubscribe(subs.subOut);
            }
        };

        return 'direct-messages';
    }

    // Override unsyncFeed for compound DM subs
    const _originalUnsync = unsyncFeed;
    function unsyncFeedEnhanced(feedId) {
        const feed = _feeds[feedId];
        if (feed && feed._cleanup) {
            feed._cleanup();
            feed.active = false;
            delete _feeds[feedId];
            console.log(`[Sync] ⏹️ ${feedId}: desuscrito (compound)`);
            return;
        }
        _originalUnsync(feedId);
    }

    // ── Stats ────────────────────────────────────────────────
    async function getStats() {
        const storeStats = await LBW_Store.getStats();
        const feedCount = Object.keys(_feeds).length;
        const activeFeedIds = Object.keys(_feeds).filter(id => _feeds[id].active);
        return {
            ...storeStats,
            activeFeeds: feedCount,
            feedIds: activeFeedIds
        };
    }

    // ── Public API ───────────────────────────────────────────
    return {
        init,

        // Core
        syncedSubscribe,
        unsyncFeed: unsyncFeedEnhanced,
        unsyncAll,

        // Profile resolution (cache-first)
        resolveProfile,

        // Convenience feeds
        syncCommunityChat,
        syncMarketplace,
        syncDirectMessages,

        // Stats
        getStats
    };
})();

window.LBW_Sync = LBW_Sync;

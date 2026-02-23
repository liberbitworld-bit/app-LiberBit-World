// ============================================================
// LiberBit World — Nostr EventStore v1.2 (nostr-store.js)
//
// Object Stores:
//   events       → { id, kind, pubkey, created_at, content, tags, _raw }
//   profiles     → { pubkey, name, display_name, ..., _updated_at }
//   cursors      → { key, since }
//   replaceables → { rkey, eventId, kind, pubkey, dTag, created_at }
//   relayLists   → { pubkey, relays: [{url,mode}], _updated_at }
//
// v1.2: + relayLists store for NIP-65 relay sovereignty
//
// Dependencies: None (pure IndexedDB)
// ============================================================

const LBW_Store = (() => {
    'use strict';

    const DB_NAME = 'liberbit-nostr';
    const DB_VERSION = 3;
    let _db = null;
    let _initPromise = null;

    // ── Database Initialization ──────────────────────────────
    function init() {
        if (_initPromise) return _initPromise;

        _initPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;

                // Events store: indexed by kind, pubkey, created_at
                if (!db.objectStoreNames.contains('events')) {
                    const evStore = db.createObjectStore('events', { keyPath: 'id' });
                    evStore.createIndex('by_kind', 'kind', { unique: false });
                    evStore.createIndex('by_pubkey', 'pubkey', { unique: false });
                    evStore.createIndex('by_kind_created', ['kind', 'created_at'], { unique: false });
                    evStore.createIndex('by_pubkey_kind', ['pubkey', 'kind'], { unique: false });
                }

                // Profiles store: latest kind-0 per pubkey
                if (!db.objectStoreNames.contains('profiles')) {
                    db.createObjectStore('profiles', { keyPath: 'pubkey' });
                }

                // Cursors store: sync position per feed
                if (!db.objectStoreNames.contains('cursors')) {
                    db.createObjectStore('cursors', { keyPath: 'key' });
                }

                // Replaceables store: canonical state for parameterized
                // replaceable events (kinds 30000-39999).
                // Key = "kind:pubkey:d-tag" → only newest event wins.
                if (!db.objectStoreNames.contains('replaceables')) {
                    const repStore = db.createObjectStore('replaceables', { keyPath: 'rkey' });
                    repStore.createIndex('by_kind', 'kind', { unique: false });
                    repStore.createIndex('by_pubkey', 'pubkey', { unique: false });
                }

                // Relay lists store: NIP-65 per-user relay preferences
                // { pubkey, relays: [{url, mode:'read'|'write'|'both'}], _updated_at }
                if (!db.objectStoreNames.contains('relayLists')) {
                    db.createObjectStore('relayLists', { keyPath: 'pubkey' });
                }
            };

            request.onsuccess = (e) => {
                _db = e.target.result;
                console.log('[Store] ✅ IndexedDB abierto');
                resolve(_db);
            };

            request.onerror = (e) => {
                console.error('[Store] ❌ IndexedDB error:', e.target.error);
                reject(e.target.error);
            };
        });

        return _initPromise;
    }

    function _getDB() {
        if (!_db) throw new Error('Store no inicializado. Llama a LBW_Store.init() primero.');
        return _db;
    }

    // ── Events ───────────────────────────────────────────────

    // Store a single event (deduplicates by id)
    function putEvent(event) {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('events', 'readwrite');
                const store = tx.objectStore('events');
                // Store the full raw event + extracted fields for indexing
                store.put({
                    id: event.id,
                    kind: event.kind,
                    pubkey: event.pubkey,
                    created_at: event.created_at,
                    content: event.content,
                    tags: event.tags,
                    sig: event.sig,
                    _raw: event
                });
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // Store multiple events in a single transaction
    function putEvents(events) {
        if (!events || events.length === 0) return Promise.resolve();

        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('events', 'readwrite');
                const store = tx.objectStore('events');
                events.forEach(event => {
                    store.put({
                        id: event.id,
                        kind: event.kind,
                        pubkey: event.pubkey,
                        created_at: event.created_at,
                        content: event.content,
                        tags: event.tags,
                        sig: event.sig,
                        _raw: event
                    });
                });
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // Get events by kind, optionally filtered, sorted desc by created_at
    function getEventsByKind(kind, options = {}) {
        const { limit = 100, since = 0, authors = null, tags = null } = options;

        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('events', 'readonly');
                const store = tx.objectStore('events');
                const index = store.index('by_kind_created');
                const results = [];

                // Range: [kind, since] → [kind, Infinity]
                const range = IDBKeyRange.bound(
                    [kind, since],
                    [kind, Number.MAX_SAFE_INTEGER]
                );

                const request = index.openCursor(range, 'prev'); // newest first

                request.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (!cursor || results.length >= limit) {
                        resolve(results);
                        return;
                    }

                    const ev = cursor.value;

                    // Filter by authors if specified
                    if (authors && !authors.includes(ev.pubkey)) {
                        cursor.continue();
                        return;
                    }

                    // Filter by tags if specified (simple #t matching)
                    if (tags) {
                        const evTags = ev.tags || [];
                        const hasAllTags = Object.entries(tags).every(([tagName, tagValues]) => {
                            return tagValues.some(tv =>
                                evTags.some(t => t[0] === tagName && t[1] === tv)
                            );
                        });
                        if (!hasAllTags) {
                            cursor.continue();
                            return;
                        }
                    }

                    results.push(ev._raw || ev);
                    cursor.continue();
                };

                request.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // Get events by pubkey and kind
    function getEventsByPubkeyKind(pubkey, kind, limit = 50) {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('events', 'readonly');
                const store = tx.objectStore('events');
                const index = store.index('by_pubkey_kind');
                const range = IDBKeyRange.only([pubkey, kind]);
                const results = [];

                const request = index.openCursor(range, 'prev');
                request.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (!cursor || results.length >= limit) {
                        resolve(results);
                        return;
                    }
                    results.push(cursor.value._raw || cursor.value);
                    cursor.continue();
                };
                request.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // Get single event by id
    function getEvent(id) {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('events', 'readonly');
                const request = tx.objectStore('events').get(id);
                request.onsuccess = (e) => {
                    const val = e.target.result;
                    resolve(val ? (val._raw || val) : null);
                };
                request.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // Delete old events (keep last N per kind)
    function pruneEvents(kind, keepCount = 200) {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('events', 'readwrite');
                const store = tx.objectStore('events');
                const index = store.index('by_kind_created');
                const range = IDBKeyRange.bound(
                    [kind, 0],
                    [kind, Number.MAX_SAFE_INTEGER]
                );

                let count = 0;
                const request = index.openCursor(range, 'prev');

                request.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (!cursor) { resolve(count); return; }

                    count++;
                    if (count > keepCount) {
                        cursor.delete();
                    }
                    cursor.continue();
                };
                request.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // ── Replaceable Events (kinds 30000-39999) ───────────────
    // Canonical state: for any (kind, pubkey, d-tag) combination,
    // only the newest event is "live". Tiebreak: if same
    // created_at, lowest event id wins (deterministic across clients).

    // Kinds that are parameterized replaceable per NIP-01
    function _isReplaceable(kind) {
        return kind >= 30000 && kind < 40000;
    }

    function _replaceableKey(kind, pubkey, dTag) {
        return `${kind}:${pubkey}:${dTag || ''}`;
    }

    // Put a replaceable event: only stores it if it's newer than
    // the current canonical event for the same (kind, pubkey, d).
    // Returns: { stored: bool, replaced: eventId|null }
    function putReplaceableEvent(event) {
        const dTag = (event.tags || []).find(t => t[0] === 'd')?.[1] || '';
        const rkey = _replaceableKey(event.kind, event.pubkey, dTag);

        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction(['replaceables', 'events'], 'readwrite');
                const repStore = tx.objectStore('replaceables');
                const evStore = tx.objectStore('events');

                const getReq = repStore.get(rkey);
                getReq.onsuccess = () => {
                    const existing = getReq.result;
                    let shouldReplace = false;
                    let replacedId = null;

                    if (!existing) {
                        // No existing entry → store
                        shouldReplace = true;
                    } else if (event.created_at > existing.created_at) {
                        // Newer → replace
                        shouldReplace = true;
                        replacedId = existing.eventId;
                    } else if (event.created_at === existing.created_at && event.id < existing.eventId) {
                        // Same timestamp → deterministic tiebreak: lowest id wins
                        shouldReplace = true;
                        replacedId = existing.eventId;
                    }
                    // else: existing is newer or wins tiebreak → skip

                    if (shouldReplace) {
                        // Store new event
                        evStore.put({
                            id: event.id, kind: event.kind, pubkey: event.pubkey,
                            created_at: event.created_at, content: event.content,
                            tags: event.tags, sig: event.sig, _raw: event
                        });

                        // Update replaceable pointer
                        repStore.put({
                            rkey, eventId: event.id, kind: event.kind,
                            pubkey: event.pubkey, dTag, created_at: event.created_at
                        });

                        // Remove old event from events store if replaced
                        if (replacedId) {
                            evStore.delete(replacedId);
                        }
                    }

                    tx.oncomplete = () => resolve({ stored: shouldReplace, replaced: replacedId });
                };

                tx.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // Get the canonical event for a replaceable (kind, pubkey, d)
    function getReplaceableEvent(kind, pubkey, dTag) {
        const rkey = _replaceableKey(kind, pubkey, dTag || '');
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction(['replaceables', 'events'], 'readonly');
                const repReq = tx.objectStore('replaceables').get(rkey);
                repReq.onsuccess = () => {
                    if (!repReq.result) { resolve(null); return; }
                    const evReq = tx.objectStore('events').get(repReq.result.eventId);
                    evReq.onsuccess = () => resolve(evReq.result?._raw || evReq.result || null);
                    evReq.onerror = () => resolve(null);
                };
                repReq.onerror = () => resolve(null);
            } catch (e) {
                reject(e);
            }
        });
    }

    // ── Kind 5 DELETE Processing ─────────────────────────────
    // NIP-09: A kind 5 event references events to delete via
    // e-tags. We remove the referenced events from both the
    // events store and the replaceables index.
    //
    // Security: only the original author can delete their events.

    function processDeleteEvent(deleteEvent) {
        if (deleteEvent.kind !== 5) return Promise.resolve({ deleted: 0 });

        const eTags = (deleteEvent.tags || []).filter(t => t[0] === 'e').map(t => t[1]);
        if (eTags.length === 0) return Promise.resolve({ deleted: 0 });

        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction(['events', 'replaceables'], 'readwrite');
                const evStore = tx.objectStore('events');
                const repStore = tx.objectStore('replaceables');
                let deleted = 0;

                let pending = eTags.length;
                const oneDone = () => { if (--pending === 0) tx.oncomplete = () => resolve({ deleted }); };

                eTags.forEach(eventId => {
                    // Look up the event to verify author
                    const getReq = evStore.get(eventId);
                    getReq.onsuccess = () => {
                        const ev = getReq.result;
                        if (ev && ev.pubkey === deleteEvent.pubkey) {
                            // Author matches → delete from events
                            evStore.delete(eventId);
                            deleted++;

                            // Also remove from replaceables if applicable
                            if (_isReplaceable(ev.kind)) {
                                const dTag = (ev.tags || []).find(t => t[0] === 'd')?.[1] || '';
                                const rkey = _replaceableKey(ev.kind, ev.pubkey, dTag);
                                const repReq = repStore.get(rkey);
                                repReq.onsuccess = () => {
                                    if (repReq.result && repReq.result.eventId === eventId) {
                                        repStore.delete(rkey);
                                    }
                                    oneDone();
                                };
                                repReq.onerror = () => oneDone();
                                return; // oneDone handled above
                            }
                        }
                        oneDone();
                    };
                    getReq.onerror = () => oneDone();
                });

                tx.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // Delete a single event by id (for direct removals)
    function deleteEvent(eventId) {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('events', 'readwrite');
                tx.objectStore('events').delete(eventId);
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // ── Profiles ─────────────────────────────────────────────

    function putProfile(pubkey, profileData) {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('profiles', 'readwrite');
                tx.objectStore('profiles').put({
                    pubkey,
                    ...profileData,
                    _updated_at: Date.now()
                });
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    function getProfile(pubkey) {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('profiles', 'readonly');
                const request = tx.objectStore('profiles').get(pubkey);
                request.onsuccess = (e) => resolve(e.target.result || null);
                request.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    function getAllProfiles() {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('profiles', 'readonly');
                const request = tx.objectStore('profiles').getAll();
                request.onsuccess = (e) => resolve(e.target.result || []);
                request.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // ── Cursors (sync position) ──────────────────────────────

    // key format: "feedId:relayUrl" e.g. "community-chat:wss://relay.liberbit.world"
    function getCursor(key) {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('cursors', 'readonly');
                const request = tx.objectStore('cursors').get(key);
                request.onsuccess = (e) => {
                    const val = e.target.result;
                    resolve(val ? val.since : 0);
                };
                request.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    function setCursor(key, since) {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('cursors', 'readwrite');
                tx.objectStore('cursors').put({ key, since });
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    function getAllCursors() {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('cursors', 'readonly');
                const request = tx.objectStore('cursors').getAll();
                request.onsuccess = (e) => resolve(e.target.result || []);
                request.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // ── Relay Lists (NIP-65) ─────────────────────────────────
    // Stores per-user relay preferences from kind 10002 events.
    // relays format: [{ url: 'wss://...', mode: 'read'|'write'|'both' }]

    function putRelayList(pubkey, relays) {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('relayLists', 'readwrite');
                tx.objectStore('relayLists').put({
                    pubkey,
                    relays,
                    _updated_at: Date.now()
                });
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    function getRelayList(pubkey) {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction('relayLists', 'readonly');
                const request = tx.objectStore('relayLists').get(pubkey);
                request.onsuccess = (e) => resolve(e.target.result || null);
                request.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    // ── Utilities ────────────────────────────────────────────

    function clearAll() {
        return new Promise((resolve, reject) => {
            try {
                const tx = _getDB().transaction(['events', 'profiles', 'cursors', 'replaceables', 'relayLists'], 'readwrite');
                tx.objectStore('events').clear();
                tx.objectStore('profiles').clear();
                tx.objectStore('cursors').clear();
                tx.objectStore('replaceables').clear();
                tx.objectStore('relayLists').clear();
                tx.oncomplete = () => { console.log('[Store] 🗑️ Todo limpio'); resolve(); };
                tx.onerror = (e) => reject(e.target.error);
            } catch (e) {
                reject(e);
            }
        });
    }

    async function getStats() {
        const db = _getDB();
        const counts = {};
        for (const name of ['events', 'profiles', 'cursors', 'replaceables', 'relayLists']) {
            counts[name] = await new Promise((resolve) => {
                const tx = db.transaction(name, 'readonly');
                const req = tx.objectStore(name).count();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(0);
            });
        }
        return counts;
    }

    // ── Public API ───────────────────────────────────────────
    return {
        init,

        // Events
        putEvent,
        putEvents,
        getEventsByKind,
        getEventsByPubkeyKind,
        getEvent,
        deleteEvent,
        pruneEvents,

        // Replaceables (kinds 30000-39999)
        putReplaceableEvent,
        getReplaceableEvent,

        // Deletions (kind 5)
        processDeleteEvent,

        // Profiles
        putProfile,
        getProfile,
        getAllProfiles,

        // Cursors
        getCursor,
        setCursor,
        getAllCursors,

        // Relay Lists (NIP-65)
        putRelayList,
        getRelayList,

        // Utils
        clearAll,
        getStats
    };
})();

window.LBW_Store = LBW_Store;

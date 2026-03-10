// LiberBit World — Debate Module v1.2

window.LBW_Debate = {

    _messages: {},
    _subscriptions: {},
    _callbacks: {},

    _tag: function(dTag) { return 'lbw-debate-' + dTag; },

    _ensureCache: function(dTag) {
        if (!this._messages[dTag]) this._messages[dTag] = {};
    },

    _normalize: function(event) {
        var replyTo = null;
        for (var i = 0; i < event.tags.length; i++) {
            if (event.tags[i][0] === 'e' && event.tags[i][3] === 'reply') {
                replyTo = event.tags[i][1];
            }
        }
        return {
            id:        event.id,
            pubkey:    event.pubkey,
            content:   event.content,
            createdAt: event.created_at,
            replyTo:   replyTo,
            tags:      event.tags
        };
    },

    subscribeDebate: function(proposalDTag, onMessage) {
        var self = this;
        self._ensureCache(proposalDTag);

        if (!self._callbacks[proposalDTag]) self._callbacks[proposalDTag] = [];
        if (onMessage) self._callbacks[proposalDTag].push(onMessage);

        if (self._subscriptions[proposalDTag]) {
            var cached = self.getMessages(proposalDTag);
            for (var i = 0; i < cached.length; i++) {
                if (onMessage) onMessage(cached[i], 'cached');
            }
            return;
        }

        if (!window.LBW_Nostr || typeof window.LBW_Nostr.subscribe !== 'function') {
            console.warn('[Debate] LBW_Nostr no disponible');
            return;
        }

        var filter = { kinds: [1], '#t': [self._tag(proposalDTag)], limit: 200 };

        var sub = window.LBW_Nostr.subscribe(
            [filter],
            function(event) {
                self._ensureCache(proposalDTag);
                var msg = self._normalize(event);
                if (!self._messages[proposalDTag][msg.id]) {
                    self._messages[proposalDTag][msg.id] = msg;
                    var cbs = self._callbacks[proposalDTag] || [];
                    for (var i = 0; i < cbs.length; i++) cbs[i](msg, 'new');
                }
            },
            function() {
                var cbs = self._callbacks[proposalDTag] || [];
                for (var i = 0; i < cbs.length; i++) cbs[i](null, 'eose');
            }
        );

        self._subscriptions[proposalDTag] = sub;
    },

    unsubscribeDebate: function(proposalDTag) {
        if (this._subscriptions[proposalDTag]) {
            try {
                var s = this._subscriptions[proposalDTag];
                if (s && typeof s.unsub === 'function') s.unsub();
            } catch(e) {}
            delete this._subscriptions[proposalDTag];
        }
        delete this._callbacks[proposalDTag];
    },

    publishDebateMessage: async function(proposalDTag, content, replyToEventId) {
        if (!window.LBW_Nostr || !window.LBW_Nostr.isLoggedIn()) {
            throw new Error('Necesitas estar conectado con Nostr para participar.');
        }
        if (!content || !content.trim()) {
            throw new Error('El mensaje no puede estar vacío.');
        }
        var tags = [
            ['t', 'lbw-debate'],
            ['t', this._tag(proposalDTag)]
        ];
        if (replyToEventId) {
            tags.push(['e', replyToEventId, '', 'reply']);
        }
        await window.LBW_Nostr.publishEvent({ kind: 1, content: content.trim(), tags: tags });
    },

    getMessages: function(proposalDTag) {
        this._ensureCache(proposalDTag);
        var msgs = this._messages[proposalDTag];
        var arr = [];
        for (var id in msgs) { arr.push(msgs[id]); }
        arr.sort(function(a, b) { return a.createdAt - b.createdAt; });
        return arr;
    },

    getMessageCount: function(proposalDTag) {
        if (!this._messages[proposalDTag]) return 0;
        return Object.keys(this._messages[proposalDTag]).length;
    },

    clearCache: function(proposalDTag) {
        delete this._messages[proposalDTag];
    }
};

console.log('[Debate] ✅ LBW_Debate cargado v1.2');

// ============================================================
// LiberBit World — DM Module v1.0 (nostr-dm.js)
//
// Abstraction layer for Direct Messages.
// Separates "what the app wants" (send/receive messages)
// from "how Nostr does it" (kind 4/NIP-04/NIP-44, future kind 14).
//
// When NIP-17 (Gift Wrap, kind 14) arrives:
//   → Change this module's internals
//   → Bridge code doesn't change
//   → UI code doesn't change
//
// Transport: kind 4 + NIP-44 preferred / NIP-04 fallback
// Routing:   shared relays (NIP-65) → user write → system private
//
// Dependencies: nostr.js (LBW_Nostr)
// ============================================================

const LBW_DM = (() => {
    'use strict';

    // ── Transport Configuration ──────────────────────────────
    // Current: kind 4 (NIP-04/NIP-44)
    // Future:  kind 14 (NIP-17 Gift Wrap)
    const TRANSPORT = {
        KIND: 4,        // Event kind for DMs
        VERSION: 'nip04+nip44',
        // Set to 14 when migrating to NIP-17:
        // KIND: 14,
        // VERSION: 'nip17',
    };

    let _onMessageCallbacks = [];
    let _subs = null; // { subIn, subOut }

    // ── Send ─────────────────────────────────────────────────
    // Public API: send a DM. App doesn't care about kind/encryption.
    //
    // Returns: { event, results } from publishEvent
    async function send(recipientPubkey, plaintext, options = {}) {
        if (!LBW_Nostr.isLoggedIn()) {
            throw new Error('No hay sesión activa. Login primero.');
        }
        if (!recipientPubkey) throw new Error('Falta destinatario.');
        if (!plaintext || plaintext.trim() === '') throw new Error('Mensaje vacío.');

        // Normalize: accept npub or hex
        const hexPubkey = recipientPubkey.startsWith('npub1')
            ? LBW_Nostr.npubToHex(recipientPubkey)
            : recipientPubkey;

        // Delegate to LBW_Nostr's DM send (handles encryption + routing)
        return await LBW_Nostr.sendDirectMessage(hexPubkey, plaintext.trim());
    }

    // ── Subscribe ────────────────────────────────────────────
    // Public API: listen for incoming/outgoing DMs.
    // onMessage receives normalized messages regardless of transport.
    //
    // Message shape:
    //   { id, from, fromNpub, to, content, created_at,
    //     direction: 'incoming'|'outgoing',
    //     encryption: 'nip44'|'nip04',
    //     transport: 'kind4'|'kind14' }
    function subscribe(onMessage) {
        _onMessageCallbacks.push(onMessage);

        // Only set up Nostr subscription once
        if (_subs) return _subs;

        _subs = LBW_Nostr.subscribeDirectMessages((rawMsg) => {
            // Normalize message shape
            const normalized = {
                id: rawMsg.id,
                from: rawMsg.from,
                fromNpub: rawMsg.fromNpub,
                to: rawMsg.to,
                content: rawMsg.content,
                created_at: rawMsg.created_at,
                direction: rawMsg.direction,
                encryption: rawMsg.nip44 ? 'nip44' : 'nip04',
                transport: `kind${TRANSPORT.KIND}`
            };

            // Deliver to all callbacks
            _onMessageCallbacks.forEach(cb => {
                try { cb(normalized); } catch (e) {
                    console.warn('[DM] Callback error:', e);
                }
            });
        });

        return _subs;
    }

    // ── Unsubscribe ──────────────────────────────────────────
    function unsubscribe() {
        if (_subs) {
            if (_subs.subIn) LBW_Nostr.unsubscribe(_subs.subIn);
            if (_subs.subOut) LBW_Nostr.unsubscribe(_subs.subOut);
            _subs = null;
        }
        _onMessageCallbacks = [];
    }

    // ── Encryption Info ──────────────────────────────────────
    // UI can call this to show what encryption is active.
    function getEncryptionInfo() {
        const hasNip44Ext = !!(window.nostr?.nip44);
        const hasNip44Tools = (() => {
            try {
                const nt = window.NostrTools || window.nostrTools;
                return !!(nt?.nip44);
            } catch (e) { return false; }
        })();

        return {
            preferred: (hasNip44Ext || hasNip44Tools) ? 'nip44' : 'nip04',
            nip44Available: hasNip44Ext || hasNip44Tools,
            nip44Extension: hasNip44Ext,
            nip44Tools: hasNip44Tools,
            nip04Available: true, // Always available
            transport: TRANSPORT.VERSION,
            transportKind: TRANSPORT.KIND
        };
    }

    // ── Transport Migration Helper ───────────────────────────
    // When ready to migrate to kind 14 (NIP-17):
    //   1. Update TRANSPORT.KIND = 14
    //   2. Update TRANSPORT.VERSION = 'nip17'
    //   3. Implement Gift Wrap in LBW_Nostr
    //   4. This module's public API stays the same
    function getTransportInfo() {
        return { ...TRANSPORT };
    }

    // ── Public API ───────────────────────────────────────────
    return {
        send,
        subscribe,
        unsubscribe,
        getEncryptionInfo,
        getTransportInfo,

        // Constants for external reference
        TRANSPORT
    };
})();

window.LBW_DM = LBW_DM;

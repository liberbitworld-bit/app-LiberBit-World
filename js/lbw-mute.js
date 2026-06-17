// ============================================================
// LiberBit World — Personal Mute (lbw-mute.js)
//
// Mute personal de usuarios en el chat comunitario. Cliente-only:
// los mensajes de pubkeys silenciadas se ocultan en LA APP del usuario
// que silencia. Otros usuarios siguen viendo los mensajes normalmente.
//
// Por qué cliente-only y no global: el modelo LBW es non-censorial —
// nadie puede borrar mensajes para todos. Si más adelante queremos
// moderación global (p.ej. spam confirmado por mayoría Génesis con
// kind:1984), se añadiría como capa separada manteniendo este mute
// personal como fallback.
//
// Persistencia: localStorage['lbw_muted_pubkeys'] = JSON array de hex
// pubkeys (lowercase). Sin sync entre dispositivos en v1 — futura
// versión podría sincronizar vía NIP-51 kind:10000.
// ============================================================

const LBW_Mute = (() => {
    'use strict';

    const STORAGE_KEY = 'lbw_muted_pubkeys';
    let _muted = new Set();

    function _load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return;
            arr.forEach(pk => {
                if (typeof pk === 'string' && /^[0-9a-f]{64}$/i.test(pk)) {
                    _muted.add(pk.toLowerCase());
                }
            });
        } catch (e) {
            console.warn('[LBW_Mute] No se pudo cargar lista:', e.message);
        }
    }

    function _save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify([..._muted]));
        } catch (e) {
            console.warn('[LBW_Mute] No se pudo guardar lista:', e.message);
        }
    }

    function isMuted(pubkey) {
        if (!pubkey || typeof pubkey !== 'string') return false;
        return _muted.has(pubkey.toLowerCase());
    }

    function mute(pubkey) {
        if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) return false;
        const pk = pubkey.toLowerCase();
        // Autoprotección: nunca silenciar al usuario actual
        try {
            const myPk = window.LBW_Nostr && window.LBW_Nostr.getPubkey && window.LBW_Nostr.getPubkey();
            if (myPk && myPk.toLowerCase() === pk) {
                console.warn('[LBW_Mute] No se puede silenciar al propio usuario');
                return false;
            }
        } catch (e) {}
        if (_muted.has(pk)) return false;
        _muted.add(pk);
        _save();
        return true;
    }

    function unmute(pubkey) {
        if (!pubkey || typeof pubkey !== 'string') return false;
        const r = _muted.delete(pubkey.toLowerCase());
        if (r) _save();
        return r;
    }

    function getMuted() {
        return [..._muted];
    }

    function count() {
        return _muted.size;
    }

    function clearAll() {
        _muted.clear();
        _save();
    }

    _load();

    return { isMuted, mute, unmute, getMuted, count, clearAll };
})();

window.LBW_Mute = LBW_Mute;

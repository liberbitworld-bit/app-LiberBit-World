// ============================================
// NOSTR WALLET CONNECT (NIP-47) INTEGRATION
// ============================================
// Protocolo: https://github.com/nostr-protocol/nips/blob/master/47.md
// Compatible con: Alby Hub, Alby Go, Mutiny, Coinos, Primal Wallet, Zeus,
//                 Cashu.me, CoreLightning (vía CLNRest), etc.
// ============================================

(function (global) {
    'use strict';

    const NWC_STORAGE_KEY = 'liberbit_nwc_uri';      // [LEGACY] URI completo en claro
    const NWC_STORAGE_KEY_V2 = 'lbw_nwc_v2';          // [SEC-A1] secret cifrado con NIP-49
    const DEFAULT_TIMEOUT_MS = 15000;   // get_info, get_balance, make_invoice
    const PAY_TIMEOUT_MS = 45000;       // pay_invoice (puede tardar en la red LN)

    // Estado de la conexión (en memoria)
    // { walletPubkey, relays: [...], secretHex, lud16 }
    let conn = null;
    let pool = null;

    // ---------- Helpers ----------

    function getNT() {
        const nt = global.NostrTools;
        if (!nt || !nt.SimplePool || !nt.nip04 || !nt.finalizeEvent || !nt.getPublicKey) {
            throw new Error('nostr-tools no está disponible todavía. Recarga la página.');
        }
        return nt;
    }

    function hexToBytes(hex) {
        if (typeof hex !== 'string' || hex.length % 2 !== 0) {
            throw new Error('Hex inválido');
        }
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++) {
            out[i] = parseInt(hex.substr(i * 2, 2), 16);
            if (Number.isNaN(out[i])) throw new Error('Hex inválido');
        }
        return out;
    }

    function ensurePool() {
        const NT = getNT();
        if (!pool) pool = new NT.SimplePool();
        return pool;
    }

    // ---------- URI parsing ----------

    // Soporta: nostr+walletconnect://, nostr+walletconnect:, nostrwalletconnect://
    function parseUri(uri) {
        if (!uri || typeof uri !== 'string') throw new Error('URI vacío');
        let s = uri.trim();

        let rest;
        if (s.startsWith('nostr+walletconnect://'))      rest = s.slice('nostr+walletconnect://'.length);
        else if (s.startsWith('nostr+walletconnect:'))   rest = s.slice('nostr+walletconnect:'.length);
        else if (s.startsWith('nostrwalletconnect://'))  rest = s.slice('nostrwalletconnect://'.length);
        else if (s.startsWith('nostrwalletconnect:'))    rest = s.slice('nostrwalletconnect:'.length);
        else throw new Error('El URI debe empezar por nostr+walletconnect://');

        // Separa pubkey de query string
        const qIdx = rest.indexOf('?');
        if (qIdx < 0) throw new Error('Falta la query (?relay=...&secret=...)');

        const walletPubkey = rest.slice(0, qIdx).replace(/^\/+/, '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(walletPubkey)) {
            throw new Error('Pubkey del wallet inválida (debe ser hex de 64 caracteres)');
        }

        const params = new URLSearchParams(rest.slice(qIdx + 1));
        const relays = params.getAll('relay').map(r => r.trim()).filter(Boolean);
        if (!relays.length) throw new Error('Falta parámetro relay');

        const secretHex = (params.get('secret') || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(secretHex)) {
            throw new Error('Secret inválido (debe ser hex de 64 caracteres)');
        }

        const lud16 = params.get('lud16') || null;

        return { walletPubkey, relays, secretHex, lud16 };
    }

    // ---------- RPC ----------

    async function sendRequest(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
        if (!conn) throw new Error('NWC no está conectado');
        const NT = getNT();

        const secretBytes = hexToBytes(conn.secretHex);
        const clientPubkey = NT.getPublicKey(secretBytes);

        const payload = JSON.stringify({ method, params });
        const encrypted = await NT.nip04.encrypt(secretBytes, conn.walletPubkey, payload);

        const eventTemplate = {
            kind: 23194,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', conn.walletPubkey]],
            content: encrypted
        };

        const signedEvent = NT.finalizeEvent(eventTemplate, secretBytes);
        const p = ensurePool();

        return new Promise((resolve, reject) => {
            let settled = false;
            let sub = null;
            let to = null;

            const finish = (fn, arg) => {
                if (settled) return;
                settled = true;
                if (to) clearTimeout(to);
                if (sub) { try { sub.close(); } catch (_) {} }
                fn(arg);
            };

            const filter = {
                kinds: [23195],
                authors: [conn.walletPubkey],
                '#p': [clientPubkey],
                '#e': [signedEvent.id],
                since: signedEvent.created_at - 5,
                limit: 1
            };

            try {
                sub = p.subscribeMany(conn.relays, [filter], {
                    async onevent(ev) {
                        if (settled) return;
                        try {
                            const plain = await NT.nip04.decrypt(secretBytes, conn.walletPubkey, ev.content);
                            const resp = JSON.parse(plain);
                            if (resp.error) {
                                const code = resp.error.code || 'ERROR';
                                const msg = resp.error.message || 'Error desconocido del wallet';
                                finish(reject, new Error('[' + code + '] ' + msg));
                            } else {
                                finish(resolve, resp.result || {});
                            }
                        } catch (err) {
                            console.warn('[NWC] Error descifrando respuesta:', err);
                        }
                    }
                });
            } catch (err) {
                return reject(new Error('No se pudo suscribir a relays: ' + err.message));
            }

            // Publica tras suscribirse (evita perder respuestas rápidas)
            try {
                const pubs = p.publish(conn.relays, signedEvent);
                Promise.allSettled(pubs).then(results => {
                    const someOk = results.some(r => r.status === 'fulfilled');
                    if (!someOk && !settled) {
                        finish(reject, new Error('Ningún relay aceptó la solicitud NWC'));
                    }
                });
            } catch (err) {
                return finish(reject, new Error('No se pudo publicar solicitud: ' + err.message));
            }

            to = setTimeout(() => {
                finish(reject, new Error('Timeout NWC: el wallet no respondió en ' + Math.round(timeoutMs / 1000) + 's'));
            }, timeoutMs);
        });
    }

    // ---------- Public API ----------

    async function connect(uri) {
        const parsed = parseUri(uri);
        conn = parsed;
        try {
            // Valida con get_info (opcional) y si no, con get_balance (obligatorio en NIP-47)
            let info = null;
            try {
                info = await sendRequest('get_info', {}, 10000);
            } catch (e) {
                console.warn('[NWC] get_info falló, probando get_balance:', e.message);
                await sendRequest('get_balance', {}, 10000);
            }

            // [SEC-A1] Persistir el URI cifrando el secret con NIP-49.
            await _persistEncrypted(parsed);

            return {
                ok: true,
                info,
                walletPubkey: conn.walletPubkey,
                relays: conn.relays.slice(),
                lud16: conn.lud16
            };
        } catch (err) {
            conn = null;
            throw err;
        }
    }

    function disconnect() {
        const relaysToClose = conn ? conn.relays.slice() : [];
        conn = null;
        try { localStorage.removeItem(NWC_STORAGE_KEY); } catch (_) {}      // legacy plaintext
        try { localStorage.removeItem(NWC_STORAGE_KEY_V2); } catch (_) {}   // [SEC-A1] cifrado
        if (pool && relaysToClose.length) {
            try { pool.close(relaysToClose); } catch (_) {}
        }
        pool = null;
    }

    function isConnected() {
        return !!conn;
    }

    // ── [SEC-A1] Persistencia cifrada del URI NWC ─────────────
    //
    // El URI tiene la forma:
    //   nostr+walletconnect://<walletPubkey>?relay=...&secret=<32 bytes hex>&lud16=...
    //
    // Solo el `secret` es sensible (clave privada del cliente NWC con permisos
    // pay_invoice). El resto (walletPubkey, relays, lud16) es público.
    //
    // Ciframos el secret con NIP-49 (mismo flujo que la nsec) y guardamos
    // un objeto JSON con los demás campos en claro:
    //   { v: 1, walletPubkey, relays, lud16, encryptedSecret: 'ncryptsec1...' }
    //
    // Reutiliza la contraseña ya cacheada por LBW_Passlock (la que el usuario
    // tecleó al desbloquear su nsec). Si no hay sesión NIP-49 activa
    // (p.ej. login NIP-07), pide contraseña al usuario.

    async function _getPasswordOrPrompt(mode) {
        if (!global.LBW_Passlock) {
            throw new Error('LBW_Passlock no disponible — no se puede cifrar el secret NWC');
        }
        const cached = global.LBW_Passlock.getCachedPassword();
        if (cached) return cached;
        const opts = (mode === 'set')
            ? { title: '🔒 Contraseña para tu wallet NWC',
                desc: 'Cifrará el secret NWC en este navegador con NIP-49. La pedirás cada vez que abras la app si no tienes sesión Nostr activa.' }
            : { title: '🔓 Desbloquea tu wallet NWC',
                desc: 'Introduce la contraseña que usaste al conectar tu wallet.' };
        const p = await global.LBW_Passlock.promptForPassword(mode, opts);
        if (!p) throw new Error('Contraseña requerida para el secret NWC');
        return p;
    }

    async function _persistEncrypted(parsed) {
        const password = await _getPasswordOrPrompt('set');
        const encryptedSecret = await global.LBW_Passlock.encryptHexSecret(parsed.secretHex, password);
        const blob = JSON.stringify({
            v: 1,
            walletPubkey: parsed.walletPubkey,
            relays: parsed.relays,
            lud16: parsed.lud16,
            encryptedSecret
        });
        try {
            localStorage.setItem(NWC_STORAGE_KEY_V2, blob);
            // Si quedaba versión legacy en claro, la borramos.
            localStorage.removeItem(NWC_STORAGE_KEY);
        } catch (e) {
            console.error('[NWC] No se pudo persistir cifrado:', e);
            throw e;
        }
    }

    async function _restoreFromEncryptedV2() {
        const blob = localStorage.getItem(NWC_STORAGE_KEY_V2);
        if (!blob) return false;
        let obj;
        try { obj = JSON.parse(blob); } catch (e) {
            console.warn('[NWC] lbw_nwc_v2 corrupto, eliminando:', e.message);
            localStorage.removeItem(NWC_STORAGE_KEY_V2);
            return false;
        }
        if (!obj || obj.v !== 1 || !obj.encryptedSecret || !obj.walletPubkey) {
            console.warn('[NWC] lbw_nwc_v2 con formato inesperado, eliminando');
            localStorage.removeItem(NWC_STORAGE_KEY_V2);
            return false;
        }

        // Bucle de descifrado con reintentos por si la contraseña es incorrecta.
        for (let attempts = 0; attempts < 3; attempts++) {
            const password = await _getPasswordOrPrompt('unlock');
            try {
                const secretHex = await global.LBW_Passlock.decryptToHexSecret(obj.encryptedSecret, password);
                conn = {
                    walletPubkey: obj.walletPubkey,
                    relays: Array.isArray(obj.relays) ? obj.relays : [],
                    secretHex,
                    lud16: obj.lud16 || null
                };
                return true;
            } catch (e) {
                console.warn('[NWC] descifrado falló (intento ' + (attempts + 1) + '):', e.message);
                // Si la contraseña venía cacheada y falla, la limpiamos para
                // forzar prompt en el siguiente intento.
                if (global.LBW_Passlock.getCachedPassword()) {
                    global.LBW_Passlock.clearCachedPassword();
                }
            }
        }
        console.warn('[NWC] Descifrado abandonado tras 3 intentos');
        return false;
    }

    async function _migrateLegacyPlaintext() {
        const saved = localStorage.getItem(NWC_STORAGE_KEY);
        if (!saved) return false;
        let parsed;
        try { parsed = parseUri(saved); }
        catch (e) {
            console.warn('[NWC] URI legacy corrupto, eliminando:', e.message);
            localStorage.removeItem(NWC_STORAGE_KEY);
            return false;
        }
        try {
            await _persistEncrypted(parsed);   // cifra y borra el legacy
            conn = parsed;
            console.log('[NWC] Migración SEC-A1 completada — URI cifrado y plaintext borrado');
            return true;
        } catch (e) {
            console.error('[NWC] Migración cifrado falló:', e.message);
            // Mantenemos el plaintext mientras no se haya cifrado: si lo
            // borramos y la migración falló, perdemos la conexión.
            return false;
        }
    }

    async function tryRestore() {
        try {
            // 1) Formato cifrado v2 (nuevo).
            if (await _restoreFromEncryptedV2()) return true;
            // 2) Formato legacy en claro → migrar al vuelo.
            if (await _migrateLegacyPlaintext()) return true;
            return false;
        } catch (e) {
            console.warn('[NWC] No se pudo restaurar conexión:', e.message);
            conn = null;
            return false;
        }
    }

    async function getBalance() {
        const res = await sendRequest('get_balance');
        const msats = typeof res.balance === 'number' ? res.balance : 0;
        return {
            sats: Math.floor(msats / 1000),
            msats,
            btc: msats / 1000 / 1e8
        };
    }

    async function makeInvoice(amountSats, memo) {
        if (!Number.isFinite(amountSats) || amountSats <= 0) {
            throw new Error('Cantidad inválida');
        }
        const res = await sendRequest('make_invoice', {
            amount: Math.round(amountSats) * 1000, // msats
            description: memo || ''
        }, DEFAULT_TIMEOUT_MS);
        // NIP-47: { type, invoice, description, payment_hash, amount, created_at, expires_at, metadata }
        if (!res.invoice) throw new Error('El wallet no devolvió invoice');
        return res;
    }

    async function payInvoice(bolt11) {
        if (!bolt11 || !/^lnbc/i.test(bolt11.trim())) {
            throw new Error('Invoice inválido (debe empezar por lnbc)');
        }
        const res = await sendRequest('pay_invoice', { invoice: bolt11.trim() }, PAY_TIMEOUT_MS);
        // NIP-47: { preimage, fees_paid? }
        return res;
    }

    async function listTransactions(limit) {
        try {
            const res = await sendRequest('list_transactions', {
                limit: Math.max(1, Math.min(50, Number(limit) || 20))
            }, 12000);
            return Array.isArray(res.transactions) ? res.transactions : [];
        } catch (e) {
            console.warn('[NWC] list_transactions no disponible:', e.message);
            return [];
        }
    }

    async function getInfo() {
        try {
            return await sendRequest('get_info', {}, 10000);
        } catch (e) {
            return null;
        }
    }

    // Resumen seguro de conexión (sin exponer el secret)
    function publicSummary() {
        if (!conn) return null;
        return {
            walletPubkey: conn.walletPubkey,
            walletPubkeyShort: conn.walletPubkey.slice(0, 12) + '…' + conn.walletPubkey.slice(-6),
            relays: conn.relays.slice(),
            lud16: conn.lud16
        };
    }

    global.LBW_NWC = {
        parseUri,
        connect,
        disconnect,
        isConnected,
        tryRestore,
        getBalance,
        getInfo,
        makeInvoice,
        payInvoice,
        listTransactions,
        sendRequest,
        publicSummary
    };

    console.warn('[LBW_NWC] Módulo NWC (NIP-47) cargado');
})(window);

// ============================================================
// LiberBit World — NIP-46 client (nostr-nip46.js)
//
// Cliente NIP-46 (Nostr Connect / Remote Signer / Bunker).
// Permite firmar eventos delegando en un bunker remoto (nsec.app,
// Amber, nsecBunker, etc.). La nsec del usuario nunca llega al
// navegador: cada firma se solicita al bunker por kind 24133.
//
// SOPORTA DOS DIRECCIONES:
//
//   1) bunker:// → app
//      El signer da una URL `bunker://<pubkey>?relay=...&secret=...`.
//      El usuario la pega en la app. La app envía `connect` al signer.
//      Implementado con BunkerSigner de nostr-tools 2.7.2.
//
//   2) nostrconnect:// (app → signer)
//      La app genera una URL `nostrconnect://<clientPub>?relay=...&secret=...&perms=...`
//      y la muestra como QR + texto. El signer la escanea (móvil) o pega.
//      El signer envía `connect` a la app. La app valida secret, responde
//      `ack` y a partir de ahí usa un cliente RPC propio (porque la API
//      BunkerSigner no soporta el handshake invertido).
//
// SESSION-ONLY (ambos modos):
//   La clave efímera del cliente se genera al conectar y vive solo
//   en memoria. Al recargar la página el usuario debe reconectar.
//
// El módulo nip46 de nostr-tools 2.7.2 NO está en el bundle UMD,
// así que lo cargamos como ESM bajo demanda (mismo patrón que
// lbw-passlock.js con nip49).
// ============================================================

const LBW_NIP46 = (() => {
    'use strict';

    const NIP46_ESM_URL = 'https://esm.sh/nostr-tools@2.7.2/nip46';
    const PURE_ESM_URL  = 'https://esm.sh/nostr-tools@2.7.2/pure';

    // Relay por defecto para flujo nostrconnect:// (signer móvil envía
    // `connect` aquí). Cambiable vía opts.relays.
    const DEFAULT_NC_RELAYS = ['wss://relay.nsec.app'];
    // Permisos solicitados en la URI nostrconnect. Format NIP-46:
    // method[:kind] separados por coma.
    const DEFAULT_NC_PERMS = 'sign_event,nip04_encrypt,nip04_decrypt,nip44_encrypt,nip44_decrypt';
    const APP_NAME = 'LiberBit World';

    // ── Estado de la sesión activa ──────────────────────────
    // _signer expone la API común para ambos modos:
    //   signEvent, getPublicKey, nip04Encrypt/Decrypt, nip44Encrypt/Decrypt, close
    // En bunker:// es un BunkerSigner de nostr-tools.
    // En nostrconnect:// es un objeto custom (ver _createCustomSigner).
    let _signer = null;
    let _userPubkey = null;
    let _bunkerPubkey = null;
    let _relays = [];
    let _mode = null;            // 'bunker' | 'nostrconnect'
    let _connecting = false;
    let _modPromise = null;
    let _disconnectCbs = [];

    // ── Lazy-load del ESM ────────────────────────────────────
    async function _loadModules() {
        if (_modPromise) return _modPromise;
        _modPromise = Promise.all([
            import(NIP46_ESM_URL),
            import(PURE_ESM_URL)
        ]).then(([nip46, pure]) => ({ nip46, pure }))
          .catch(err => {
              _modPromise = null;
              throw new Error('No se pudo cargar nostr-tools/nip46: ' + (err.message || err));
          });
        return _modPromise;
    }

    // ── Bunker URI parsing ───────────────────────────────────
    function _parseBunkerUri(uri) {
        if (!uri || typeof uri !== 'string') throw new Error('Bunker URI vacío');
        const trimmed = uri.trim();
        if (!trimmed.startsWith('bunker://')) {
            throw new Error('Se esperaba un bunker://<pubkey>?relay=...');
        }
        const after = trimmed.slice('bunker://'.length);
        const qIdx = after.indexOf('?');
        const pubkey = (qIdx === -1 ? after : after.slice(0, qIdx)).trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(pubkey)) {
            throw new Error('Pubkey del bunker inválida (esperado 64 hex)');
        }
        const relays = [];
        let secret = null;
        if (qIdx !== -1) {
            const params = new URLSearchParams(after.slice(qIdx + 1));
            for (const [k, v] of params.entries()) {
                if (k === 'relay') {
                    if (/^wss?:\/\//i.test(v)) relays.push(v);
                } else if (k === 'secret') {
                    secret = v;
                }
            }
        }
        if (relays.length === 0) {
            throw new Error('El bunker URL debe incluir al menos un ?relay=wss://...');
        }
        return { pubkey, relays, secret };
    }

    function _getPool() {
        try {
            if (window.LBW_Nostr && typeof window.LBW_Nostr.getPool === 'function') {
                return window.LBW_Nostr.getPool();
            }
        } catch (_) {}
        return null;
    }

    function _bytesToHex(bytes) {
        let h = '';
        for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, '0');
        return h;
    }

    // ──────────────────────────────────────────────────────────
    // Modo 1: bunker:// (existente, usa BunkerSigner de nostr-tools)
    // ──────────────────────────────────────────────────────────
    async function connect(bunkerUri, opts = {}) {
        if (_signer) throw new Error('Ya hay una sesión NIP-46 activa. Desconecta primero.');
        if (_connecting) throw new Error('Conexión en curso');
        _connecting = true;
        try {
            const { nip46, pure } = await _loadModules();
            const bp = _parseBunkerUri(bunkerUri);
            const clientSk = pure.generateSecretKey();

            const onauth = (url) => {
                console.log('[NIP-46] 🔐 auth_url:', url);
                try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (_) {}
                if (typeof opts.onauth === 'function') { try { opts.onauth(url); } catch (_) {} }
            };
            const onnotice = (msg) => {
                console.log('[NIP-46] notice:', msg);
                if (typeof opts.onnotice === 'function') { try { opts.onnotice(msg); } catch (_) {} }
            };

            const pool = _getPool();
            const params = { onauth, onnotice };
            if (pool) params.pool = pool;

            let signer;
            try { signer = new nip46.BunkerSigner(clientSk, bp, params); }
            catch (e) { throw new Error('No se pudo instanciar BunkerSigner: ' + (e.message || e)); }

            await signer.connect();
            const userPubkey = await signer.getPublicKey();
            if (!userPubkey || !/^[0-9a-f]{64}$/.test(userPubkey)) {
                try { await signer.close(); } catch (_) {}
                throw new Error('El bunker no devolvió una pubkey válida');
            }

            _signer = signer;
            _userPubkey = userPubkey;
            _bunkerPubkey = bp.pubkey;
            _relays = bp.relays.slice();
            _mode = 'bunker';

            return { userPubkeyHex: userPubkey, bunkerPubkey: bp.pubkey, relays: _relays, mode: 'bunker' };
        } finally {
            _connecting = false;
        }
    }

    // ──────────────────────────────────────────────────────────
    // Modo 2: nostrconnect:// (nuevo, cliente RPC propio)
    // ──────────────────────────────────────────────────────────
    // Crea un objeto que mimica BunkerSigner — mismo shape de API.
    // Mantiene una suscripción abierta en kind 24133 y correlaciona
    // requests por id. Usa NIP-44 si el bundle de nostr-tools lo
    // expone, NIP-04 si no.
    function _createCustomSigner(clientSk, signerPub, relays) {
        const nt = window.NostrTools || window.nostrTools;
        if (!nt) throw new Error('nostr-tools no cargado');
        const pool = _getPool() || new nt.SimplePool();
        const clientPub = nt.getPublicKey(clientSk);
        const useNip44 = !!nt.nip44;

        const pending = new Map();   // id -> { resolve, reject, timer, onauth }
        let sub = null;
        let closed = false;
        let convKey = null;
        if (useNip44) {
            try { convKey = nt.nip44.v2.utils.getConversationKey(clientSk, signerPub); }
            catch (e) { console.warn('[NIP-46 RPC] No se pudo derivar NIP-44 convKey:', e.message); }
        }

        async function _encrypt(plaintext) {
            if (convKey) return nt.nip44.v2.encrypt(plaintext, convKey);
            return await nt.nip04.encrypt(clientSk, signerPub, plaintext);
        }
        async function _decrypt(ciphertext) {
            if (convKey) {
                try { return nt.nip44.v2.decrypt(ciphertext, convKey); }
                catch (e) { /* fall through a nip04 — algunos signers mezclan */ }
            }
            return await nt.nip04.decrypt(clientSk, signerPub, ciphertext);
        }

        async function _onEvent(event) {
            if (event.pubkey !== signerPub) return; // ignora respuestas de otros
            try {
                const plain = await _decrypt(event.content);
                let msg;
                try { msg = JSON.parse(plain); } catch (e) { return; }
                if (!msg || typeof msg.id !== 'string') return;
                const slot = pending.get(msg.id);
                if (!slot) return;
                // auth_url: el signer pide aprobación humana antes de proceder
                if (msg.result === 'auth_url' && msg.error) {
                    try { window.open(msg.error, '_blank', 'noopener,noreferrer'); } catch (_) {}
                    if (typeof slot.onauth === 'function') { try { slot.onauth(msg.error); } catch (_) {} }
                    clearTimeout(slot.timer);
                    // Extender timeout esperando aprobación humana
                    slot.timer = setTimeout(() => {
                        pending.delete(msg.id);
                        slot.reject(new Error('Timeout esperando aprobación humana en el signer'));
                    }, 5 * 60 * 1000);
                    return;
                }
                pending.delete(msg.id);
                clearTimeout(slot.timer);
                if (msg.error) slot.reject(new Error(typeof msg.error === 'string' ? msg.error : (msg.error.message || 'NIP-46 error')));
                else slot.resolve(msg.result);
            } catch (e) {
                console.warn('[NIP-46 RPC] handler error:', e.message);
            }
        }

        function _subscribe() {
            if (sub || closed) return;
            const filter = { kinds: [24133], '#p': [clientPub], since: Math.floor(Date.now() / 1000) - 30 };
            try {
                sub = pool.subscribeMany(relays, [filter], { onevent: _onEvent });
            } catch (e) {
                console.error('[NIP-46 RPC] subscribeMany falló:', e.message);
            }
        }

        async function _request(method, params, opts = {}) {
            if (closed) throw new Error('NIP-46 signer cerrado');
            if (!sub) _subscribe();
            const id = (crypto.randomUUID && crypto.randomUUID()) ||
                       ('lbw' + Math.random().toString(36).slice(2) + Date.now().toString(36));
            const payload = JSON.stringify({ id, method, params });
            const cipher = await _encrypt(payload);
            const template = {
                kind: 24133,
                tags: [['p', signerPub]],
                content: cipher,
                created_at: Math.floor(Date.now() / 1000)
            };
            const signed = nt.finalizeEvent(template, clientSk);
            const timeoutMs = opts.timeoutMs || 60000;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error('NIP-46 ' + method + ' timeout'));
                }, timeoutMs);
                pending.set(id, { resolve, reject, timer, onauth: opts.onauth });
                try {
                    pool.publish(relays, signed);
                } catch (e) {
                    pending.delete(id);
                    clearTimeout(timer);
                    reject(new Error('NIP-46 publish falló: ' + e.message));
                }
            });
        }

        _subscribe();

        return {
            // Mimica la API de BunkerSigner
            connect: async () => 'ack',  // ya conectados; idempotente
            getPublicKey: async () => signerPub,
            signEvent: async (template) => {
                const result = await _request('sign_event', [JSON.stringify(template)]);
                try { return JSON.parse(result); }
                catch (e) { throw new Error('NIP-46 sign_event respuesta no JSON'); }
            },
            nip04Encrypt: (other, text) => _request('nip04_encrypt', [other, text]),
            nip04Decrypt: (other, text) => _request('nip04_decrypt', [other, text]),
            nip44Encrypt: (other, text) => _request('nip44_encrypt', [other, text]),
            nip44Decrypt: (other, text) => _request('nip44_decrypt', [other, text]),
            ping: () => _request('ping', [], { timeoutMs: 5000 }),
            close: async () => {
                closed = true;
                if (sub) {
                    try { sub.close(); } catch (_) {}
                    sub = null;
                }
                for (const [, slot] of pending) {
                    clearTimeout(slot.timer);
                    try { slot.reject(new Error('Signer cerrado')); } catch (_) {}
                }
                pending.clear();
            }
        };
    }

    // Espera el evento `connect` entrante del signer, valida secret y
    // responde ack. Devuelve { signerPub } cuando completa.
    function _waitForNostrConnectHandshake(clientSk, secret, relays, signal) {
        const nt = window.NostrTools || window.nostrTools;
        if (!nt) return Promise.reject(new Error('nostr-tools no cargado'));
        const pool = _getPool() || new nt.SimplePool();
        const clientPub = nt.getPublicKey(clientSk);
        const useNip44 = !!nt.nip44;

        async function _tryDecrypt(eventPubkey, ciphertext) {
            if (useNip44) {
                try {
                    const ck = nt.nip44.v2.utils.getConversationKey(clientSk, eventPubkey);
                    return nt.nip44.v2.decrypt(ciphertext, ck);
                } catch (e) { /* fall through */ }
            }
            try {
                return await nt.nip04.decrypt(clientSk, eventPubkey, ciphertext);
            } catch (e) {
                return null;
            }
        }

        return new Promise((resolve, reject) => {
            let resolved = false;
            let sub = null;
            const cleanup = () => {
                resolved = true;
                if (sub) { try { sub.close(); } catch (_) {} sub = null; }
            };
            const filter = { kinds: [24133], '#p': [clientPub], since: Math.floor(Date.now() / 1000) - 30 };
            try {
                sub = pool.subscribeMany(relays, [filter], {
                    onevent: async (event) => {
                        if (resolved) return;
                        try {
                            const plain = await _tryDecrypt(event.pubkey, event.content);
                            if (!plain) return;
                            let msg;
                            try { msg = JSON.parse(plain); } catch (e) { return; }
                            if (!msg || msg.method !== 'connect') return;
                            const params = Array.isArray(msg.params) ? msg.params : [];
                            // Spec NIP-46: params[0] = remote_pubkey, params[1] = secret? (opcional)
                            if (secret) {
                                const provided = params.find(p => p === secret);
                                if (!provided) {
                                    console.warn('[NIP-46] connect sin secret correcto, ignorado');
                                    return;
                                }
                            }
                            const signerPub = event.pubkey;
                            // Responder ack
                            const ackPayload = JSON.stringify({ id: msg.id, result: 'ack' });
                            let cipher;
                            try {
                                if (useNip44) {
                                    const ck = nt.nip44.v2.utils.getConversationKey(clientSk, signerPub);
                                    cipher = nt.nip44.v2.encrypt(ackPayload, ck);
                                } else {
                                    cipher = await nt.nip04.encrypt(clientSk, signerPub, ackPayload);
                                }
                            } catch (e) {
                                cipher = await nt.nip04.encrypt(clientSk, signerPub, ackPayload);
                            }
                            const template = {
                                kind: 24133,
                                tags: [['p', signerPub]],
                                content: cipher,
                                created_at: Math.floor(Date.now() / 1000)
                            };
                            const signed = nt.finalizeEvent(template, clientSk);
                            try { pool.publish(relays, signed); } catch (e) { /* best effort */ }
                            cleanup();
                            resolve({ signerPub });
                        } catch (e) {
                            console.warn('[NIP-46] handshake event handler error:', e.message);
                        }
                    }
                });
            } catch (e) {
                reject(new Error('No se pudo abrir la subscripción de handshake: ' + e.message));
                return;
            }
            const timer = setTimeout(() => {
                if (!resolved) { cleanup(); reject(new Error('Timeout esperando al signer (5min). Asegúrate de escanear el QR.')); }
            }, 5 * 60 * 1000);
            if (signal && typeof signal.addEventListener === 'function') {
                signal.addEventListener('abort', () => {
                    if (!resolved) { clearTimeout(timer); cleanup(); reject(new Error('Cancelado')); }
                });
            }
        });
    }

    async function connectViaQR(opts = {}) {
        if (_signer) throw new Error('Ya hay una sesión NIP-46 activa. Desconecta primero.');
        if (_connecting) throw new Error('Conexión en curso');
        _connecting = true;
        const signal = opts.signal || null;
        try {
            const { pure } = await _loadModules();
            const nt = window.NostrTools || window.nostrTools;
            if (!nt) throw new Error('nostr-tools no cargado');

            const relays = (opts.relays && opts.relays.length > 0) ? opts.relays.slice() : DEFAULT_NC_RELAYS.slice();
            const perms = opts.perms || DEFAULT_NC_PERMS;
            const name = opts.name || APP_NAME;

            const clientSk = pure.generateSecretKey();
            const clientPub = nt.getPublicKey(clientSk);
            const secretBytes = new Uint8Array(16);
            crypto.getRandomValues(secretBytes);
            const secret = _bytesToHex(secretBytes);

            const params = new URLSearchParams();
            relays.forEach(r => params.append('relay', r));
            params.append('secret', secret);
            params.append('perms', perms);
            params.append('name', name);
            const uri = 'nostrconnect://' + clientPub + '?' + params.toString();

            if (typeof opts.onUri === 'function') {
                try { opts.onUri(uri); } catch (_) {}
            }

            const { signerPub } = await _waitForNostrConnectHandshake(clientSk, secret, relays, signal);

            const signer = _createCustomSigner(clientSk, signerPub, relays);

            _signer = signer;
            _userPubkey = signerPub;       // En nostrconnect, signer.pubkey === user.pubkey
            _bunkerPubkey = signerPub;
            _relays = relays.slice();
            _mode = 'nostrconnect';

            return { userPubkeyHex: signerPub, bunkerPubkey: signerPub, relays: _relays, mode: 'nostrconnect' };
        } finally {
            _connecting = false;
        }
    }

    function isConnected()      { return !!_signer; }
    function getUserPubkey()    { return _userPubkey; }
    function getBunkerPubkey()  { return _bunkerPubkey; }
    function getBunkerRelays()  { return _relays.slice(); }
    function getMode()          { return _mode; }

    // ── Operaciones delegadas al _signer ─────────────────────
    async function signEvent(template) {
        if (!_signer) throw new Error('NIP-46: no conectado');
        const signed = await _signer.signEvent(template);
        if (!signed || !signed.sig || !signed.id) {
            throw new Error('NIP-46: respuesta del bunker sin firma válida');
        }
        return signed;
    }

    async function nip04Encrypt(thirdPartyPubkey, plaintext) {
        if (!_signer) throw new Error('NIP-46: no conectado');
        if (typeof _signer.nip04Encrypt !== 'function') throw new Error('Bunker no soporta NIP-04');
        return await _signer.nip04Encrypt(thirdPartyPubkey, plaintext);
    }
    async function nip04Decrypt(thirdPartyPubkey, ciphertext) {
        if (!_signer) throw new Error('NIP-46: no conectado');
        if (typeof _signer.nip04Decrypt !== 'function') throw new Error('Bunker no soporta NIP-04');
        return await _signer.nip04Decrypt(thirdPartyPubkey, ciphertext);
    }
    async function nip44Encrypt(thirdPartyPubkey, plaintext) {
        if (!_signer) throw new Error('NIP-46: no conectado');
        if (typeof _signer.nip44Encrypt !== 'function') throw new Error('Bunker no soporta NIP-44');
        return await _signer.nip44Encrypt(thirdPartyPubkey, plaintext);
    }
    async function nip44Decrypt(thirdPartyPubkey, ciphertext) {
        if (!_signer) throw new Error('NIP-46: no conectado');
        if (typeof _signer.nip44Decrypt !== 'function') throw new Error('Bunker no soporta NIP-44');
        return await _signer.nip44Decrypt(thirdPartyPubkey, ciphertext);
    }

    function hasNip44() {
        return !!(_signer && typeof _signer.nip44Encrypt === 'function');
    }

    async function ping() {
        if (!_signer) throw new Error('NIP-46: no conectado');
        if (typeof _signer.ping !== 'function') return null;
        return await _signer.ping();
    }

    async function disconnect() {
        const s = _signer;
        _signer = null;
        _userPubkey = null;
        _bunkerPubkey = null;
        _relays = [];
        _mode = null;
        if (s) {
            try { if (typeof s.close === 'function') await s.close(); } catch (_) {}
        }
        _disconnectCbs.forEach(cb => { try { cb(); } catch (_) {} });
    }

    function onDisconnect(cb) {
        if (typeof cb === 'function') _disconnectCbs.push(cb);
    }

    // ──────────────────────────────────────────────────────────
    // UI — modal con 2 tabs: "Pegar URL" y "Mostrar QR"
    // ──────────────────────────────────────────────────────────
    function _ensureModalDOM() {
        if (document.getElementById('lbwNip46Modal')) return;
        const div = document.createElement('div');
        div.id = 'lbwNip46Modal';
        div.style.cssText = 'display:none;position:fixed;inset:0;z-index:99999;background:rgba(13,23,30,0.85);align-items:center;justify-content:center;padding:1rem;overflow-y:auto;';
        div.innerHTML = `
            <div style="background:#0F1F2A;border:1px solid #40C4FF;border-radius:14px;max-width:520px;width:100%;padding:1.5rem;color:#E0E0E0;font-family:'Poppins',system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6);">
                <h3 style="margin:0 0 0.5rem 0;font-size:1.1rem;font-weight:700;color:#40C4FF;">🛰️ Firmador remoto (NIP-46)</h3>
                <p style="margin:0 0 1rem 0;font-size:0.85rem;line-height:1.4;color:#B0BEC5;">
                    Conecta con un firmador externo para que tu clave privada nunca toque este navegador.
                </p>
                <div style="display:flex;gap:0;border-bottom:1px solid #2C5F6F;margin-bottom:1rem;">
                    <button type="button" id="lbwNip46TabPaste" style="flex:1;padding:0.55rem;background:transparent;border:0;border-bottom:2px solid #40C4FF;color:#40C4FF;font-weight:600;cursor:pointer;font-size:0.85rem;">📋 Pegar URL del signer</button>
                    <button type="button" id="lbwNip46TabQr" style="flex:1;padding:0.55rem;background:transparent;border:0;border-bottom:2px solid transparent;color:#B0BEC5;cursor:pointer;font-size:0.85rem;">📱 Generar QR</button>
                </div>
                <div id="lbwNip46PanePaste">
                    <p style="margin:0 0 0.6rem 0;font-size:0.78rem;color:#B0BEC5;line-height:1.4;">
                        Pega la URL que te dio tu bunker (<a href="https://nsec.app" target="_blank" rel="noopener" style="color:#40C4FF;">nsec.app</a>, <a href="https://github.com/greenart7c3/Amber" target="_blank" rel="noopener" style="color:#40C4FF;">Amber</a>, nsecBunker…). Empieza por <code style="font-family:'JetBrains Mono',monospace;color:#E5B95C;">bunker://</code>.
                    </p>
                    <textarea id="lbwNip46Uri" placeholder="bunker://abcdef...?relay=wss://relay.nsec.app&secret=..." style="width:100%;min-height:90px;padding:0.6rem 0.75rem;border-radius:8px;border:1px solid #2C5F6F;background:#0A1419;color:#E0E0E0;margin-bottom:0.5rem;font-family:'JetBrains Mono',monospace;font-size:0.78rem;line-height:1.4;resize:vertical;"></textarea>
                </div>
                <div id="lbwNip46PaneQr" style="display:none;">
                    <p style="margin:0 0 0.6rem 0;font-size:0.78rem;color:#B0BEC5;line-height:1.4;">
                        Escanea este código con tu signer (Amber en móvil, nsec.app en otra pestaña) o copia la URL. Pulsa <strong>"Generar QR y esperar"</strong> para empezar.
                    </p>
                    <div id="lbwNip46QrContainer" style="display:flex;justify-content:center;align-items:center;background:white;padding:0.75rem;border-radius:8px;margin-bottom:0.6rem;min-height:260px;">
                        <span id="lbwNip46QrPlaceholder" style="color:#666;font-size:0.85rem;">⏳ Pulsa el botón para generar</span>
                    </div>
                    <div style="position:relative;background:#0A1419;border:1px solid #2C5F6F;border-radius:8px;padding:0.55rem 0.75rem;font-family:'JetBrains Mono',monospace;font-size:0.7rem;word-break:break-all;line-height:1.35;max-height:80px;overflow-y:auto;color:#90CAF9;margin-bottom:0.4rem;">
                        <span id="lbwNip46QrUri">—</span>
                    </div>
                    <div style="display:flex;gap:0.4rem;margin-bottom:0.6rem;">
                        <button type="button" id="lbwNip46CopyUri" style="flex:1;padding:0.4rem;border-radius:6px;border:1px solid #455A64;background:transparent;color:#B0BEC5;cursor:pointer;font-size:0.78rem;">📋 Copiar URL</button>
                    </div>
                    <div id="lbwNip46QrWait" style="display:none;background:rgba(64,196,255,0.08);border-left:3px solid #40C4FF;padding:0.55rem 0.75rem;margin-bottom:0.6rem;border-radius:0 6px 6px 0;font-size:0.78rem;line-height:1.45;color:#90CAF9;">⏳ Esperando al signer… aprueba la conexión cuando te lo pida.</div>
                </div>
                <div id="lbwNip46Error" style="color:#EF5350;font-size:0.8rem;min-height:1.1em;margin-bottom:0.5rem;"></div>
                <div id="lbwNip46Status" style="display:none;background:rgba(64,196,255,0.08);border-left:3px solid #40C4FF;padding:0.6rem 0.75rem;margin-bottom:0.75rem;border-radius:0 6px 6px 0;font-size:0.78rem;line-height:1.4;color:#90CAF9;"></div>
                <div style="background:rgba(229,185,92,0.06);border-left:3px solid #E5B95C;padding:0.55rem 0.75rem;margin-bottom:0.75rem;border-radius:0 6px 6px 0;font-size:0.72rem;line-height:1.45;color:#B0BEC5;">
                    💡 La sesión NIP-46 es <strong>solo de memoria</strong>: al recargar tendrás que volver a conectar. Tu bunker te pedirá aprobar firmas — marca "siempre permitir" para <code style="font-family:'JetBrains Mono',monospace;">kind 22242</code> (auth de relays) si tu signer lo soporta.
                </div>
                <button id="lbwNip46Submit" type="button" style="width:100%;padding:0.7rem;border-radius:8px;border:0;background:linear-gradient(135deg,#40C4FF,#0288D1);color:#0D171E;font-weight:700;cursor:pointer;margin-bottom:0.5rem;">🛰️ Conectar al bunker</button>
                <button id="lbwNip46Cancel" type="button" style="width:100%;padding:0.55rem;border-radius:8px;border:1px solid #455A64;background:transparent;color:#B0BEC5;cursor:pointer;font-size:0.85rem;">Cancelar</button>
            </div>
        `;
        document.body.appendChild(div);
    }

    let _currentTab = 'paste';
    let _qrAbortController = null;

    function _switchTab(tab) {
        _currentTab = tab;
        const paste = document.getElementById('lbwNip46PanePaste');
        const qr = document.getElementById('lbwNip46PaneQr');
        const tabPaste = document.getElementById('lbwNip46TabPaste');
        const tabQr = document.getElementById('lbwNip46TabQr');
        const submit = document.getElementById('lbwNip46Submit');
        if (tab === 'qr') {
            paste.style.display = 'none';
            qr.style.display = '';
            tabPaste.style.borderBottom = '2px solid transparent';
            tabPaste.style.color = '#B0BEC5';
            tabQr.style.borderBottom = '2px solid #40C4FF';
            tabQr.style.color = '#40C4FF';
            submit.textContent = '📱 Generar QR y esperar';
        } else {
            paste.style.display = '';
            qr.style.display = 'none';
            tabPaste.style.borderBottom = '2px solid #40C4FF';
            tabPaste.style.color = '#40C4FF';
            tabQr.style.borderBottom = '2px solid transparent';
            tabQr.style.color = '#B0BEC5';
            submit.textContent = '🛰️ Conectar al bunker';
        }
    }

    function _renderQrIntoModal(uri) {
        const container = document.getElementById('lbwNip46QrContainer');
        const uriSpan = document.getElementById('lbwNip46QrUri');
        if (uriSpan) uriSpan.textContent = uri;
        if (container) container.innerHTML = '';
        if (typeof window.QRCode !== 'function') {
            container.innerHTML = '<span style="color:#666;font-size:0.85rem;">QRCode no cargado — copia la URL manualmente</span>';
            return;
        }
        try {
            new window.QRCode(container, {
                text: uri,
                width: 240,
                height: 240,
                correctLevel: window.QRCode.CorrectLevel.M
            });
        } catch (e) {
            console.error('[NIP-46] QRCode render failed:', e);
            container.innerHTML = '<span style="color:#666;font-size:0.85rem;">Error generando QR — copia la URL manualmente</span>';
        }
    }

    // Flujo completo interactivo. Devuelve el resultado del connect
    // (bunker o nostrconnect) o null si el usuario cancela.
    async function connectInteractive(opts = {}) {
        _ensureModalDOM();
        const modal = document.getElementById('lbwNip46Modal');
        const uriInput = document.getElementById('lbwNip46Uri');
        const submit = document.getElementById('lbwNip46Submit');
        const cancel = document.getElementById('lbwNip46Cancel');
        const err = document.getElementById('lbwNip46Error');
        const status = document.getElementById('lbwNip46Status');
        const tabPaste = document.getElementById('lbwNip46TabPaste');
        const tabQr = document.getElementById('lbwNip46TabQr');
        const qrWait = document.getElementById('lbwNip46QrWait');
        const copyUri = document.getElementById('lbwNip46CopyUri');

        uriInput.value = '';
        err.textContent = '';
        status.style.display = 'none';
        status.textContent = '';
        submit.disabled = false;
        qrWait.style.display = 'none';
        document.getElementById('lbwNip46QrContainer').innerHTML = '<span style="color:#666;font-size:0.85rem;">⏳ Pulsa el botón para generar</span>';
        document.getElementById('lbwNip46QrUri').textContent = '—';
        _switchTab('paste');

        modal.style.display = 'flex';
        setTimeout(() => uriInput.focus(), 50);

        return new Promise((resolve) => {
            const finish = (val) => {
                modal.style.display = 'none';
                if (_qrAbortController) { try { _qrAbortController.abort(); } catch (_) {} _qrAbortController = null; }
                submit.onclick = null;
                cancel.onclick = null;
                tabPaste.onclick = null;
                tabQr.onclick = null;
                uriInput.onkeydown = null;
                if (copyUri) copyUri.onclick = null;
                resolve(val);
            };

            tabPaste.onclick = () => _switchTab('paste');
            tabQr.onclick = () => _switchTab('qr');
            cancel.onclick = () => finish(null);

            if (copyUri) {
                copyUri.onclick = async () => {
                    const uriEl = document.getElementById('lbwNip46QrUri');
                    if (!uriEl) return;
                    try {
                        await navigator.clipboard.writeText(uriEl.textContent || '');
                        copyUri.textContent = '✅ Copiada';
                        setTimeout(() => { copyUri.textContent = '📋 Copiar URL'; }, 2000);
                    } catch (e) {
                        copyUri.textContent = '❌ Error';
                    }
                };
            }

            submit.onclick = async () => {
                err.textContent = '';
                if (_currentTab === 'paste') {
                    const v = (uriInput.value || '').trim().replace(/\s+/g, '');
                    if (!v) { err.textContent = 'Pega tu bunker URL.'; return; }
                    if (!v.startsWith('bunker://')) { err.textContent = 'Debe empezar por bunker://'; return; }
                    status.style.display = 'block';
                    status.textContent = '⏳ Conectando al bunker… si tu signer pide aprobación, ábrelo y autoriza.';
                    submit.disabled = true;
                    submit.textContent = '⏳ Conectando…';
                    try {
                        const result = await connect(v, {
                            onauth: (url) => {
                                status.textContent = '🔓 Tu bunker pide autorización. Si no se abrió, abre manualmente: ' + url;
                            }
                        });
                        finish(result);
                    } catch (e) {
                        console.error('[NIP-46] bunker connect error:', e);
                        err.textContent = '❌ ' + (e.message || 'No se pudo conectar');
                        status.style.display = 'none';
                        submit.disabled = false;
                        submit.textContent = '🛰️ Conectar al bunker';
                    }
                } else {
                    submit.disabled = true;
                    submit.textContent = '⏳ Esperando signer…';
                    qrWait.style.display = '';
                    status.style.display = 'none';
                    _qrAbortController = new AbortController();
                    try {
                        const result = await connectViaQR({
                            relays: opts.relays,
                            perms: opts.perms,
                            name: opts.name,
                            signal: _qrAbortController.signal,
                            onUri: (uri) => _renderQrIntoModal(uri)
                        });
                        finish(result);
                    } catch (e) {
                        console.error('[NIP-46] QR connect error:', e);
                        err.textContent = '❌ ' + (e.message || 'No se pudo conectar');
                        qrWait.style.display = 'none';
                        submit.disabled = false;
                        submit.textContent = '📱 Generar QR y esperar';
                    }
                }
            };

            uriInput.onkeydown = (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit.onclick();
            };
        });
    }

    function setModalError(msg) {
        const err = document.getElementById('lbwNip46Error');
        if (err) err.textContent = msg || '';
    }
    function setModalStatus(msg) {
        const status = document.getElementById('lbwNip46Status');
        if (status) {
            status.style.display = 'block';
            status.textContent = msg || '';
        }
    }
    function hideModal() {
        const modal = document.getElementById('lbwNip46Modal');
        if (modal) modal.style.display = 'none';
    }

    return {
        connect, connectViaQR, disconnect, isConnected,
        connectInteractive,
        getUserPubkey, getBunkerPubkey, getBunkerRelays, getMode,
        signEvent,
        nip04Encrypt, nip04Decrypt,
        nip44Encrypt, nip44Decrypt,
        hasNip44, ping, onDisconnect,
        hideModal, setModalError, setModalStatus
    };
})();

window.LBW_NIP46 = LBW_NIP46;

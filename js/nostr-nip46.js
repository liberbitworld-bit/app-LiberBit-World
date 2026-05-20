// ============================================================
// LiberBit World — NIP-46 client (nostr-nip46.js)
//
// Cliente NIP-46 (Nostr Connect / Remote Signer / Bunker).
// Permite firmar eventos delegando en un bunker remoto (nsec.app,
// Amber, nsecBunker, etc.). La nsec del usuario nunca llega al
// navegador: cada firma se solicita al bunker por kind 24133.
//
// SESSION-ONLY:
//   La clave efímera del cliente se genera al conectar y vive solo
//   en memoria. Al recargar la página el usuario debe reconectar
//   el bunker (pegar la URL otra vez). No se persiste ningún
//   secreto en disco.
//
// El módulo nip46 de nostr-tools 2.7.2 NO está en el bundle UMD,
// así que lo cargamos como ESM bajo demanda (mismo patrón que
// lbw-passlock.js con nip49).
//
// Si el bunker exige autorización en su UI antes de aprobar la
// conexión (auth_url), abrimos una pestaña con esa URL y mostramos
// un aviso al usuario en el modal.
// ============================================================

const LBW_NIP46 = (() => {
    'use strict';

    const NIP46_ESM_URL = 'https://esm.sh/nostr-tools@2.7.2/nip46';
    const PURE_ESM_URL  = 'https://esm.sh/nostr-tools@2.7.2/pure';

    let _signer = null;          // BunkerSigner instance from nostr-tools
    let _userPubkey = null;      // hex pubkey del usuario (la del bunker)
    let _bunkerPubkey = null;    // hex pubkey del bunker
    let _relays = [];            // relays del bunker (para protocolo NIP-46)
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

    // ── Parsing del bunker URI ───────────────────────────────
    // Formato NIP-46: bunker://<hex-pubkey>?relay=wss://...&relay=...&secret=...
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

    // ── Connect ──────────────────────────────────────────────
    async function connect(bunkerUri, opts = {}) {
        if (_signer) throw new Error('Ya hay una sesión NIP-46 activa. Desconecta primero.');
        if (_connecting) throw new Error('Conexión en curso');
        _connecting = true;
        try {
            const { nip46, pure } = await _loadModules();
            const bp = _parseBunkerUri(bunkerUri);

            // Clave efímera del cliente — vive SOLO en memoria.
            const clientSk = pure.generateSecretKey();

            const onauth = (url) => {
                // El bunker pide que el usuario apruebe en su UI.
                console.log('[NIP-46] 🔐 auth_url:', url);
                try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (_) {}
                if (typeof opts.onauth === 'function') {
                    try { opts.onauth(url); } catch (_) {}
                }
            };
            const onnotice = (msg) => {
                console.log('[NIP-46] notice:', msg);
                if (typeof opts.onnotice === 'function') {
                    try { opts.onnotice(msg); } catch (_) {}
                }
            };

            const pool = _getPool();
            const params = { onauth, onnotice };
            if (pool) params.pool = pool;

            // Constructor: (clientSk, bunkerPointer, params)
            // BunkerSigner soporta varios shapes según versión. Si la API
            // cambia, capturamos el error y lo mostramos al usuario.
            let signer;
            try {
                signer = new nip46.BunkerSigner(clientSk, bp, params);
            } catch (e) {
                throw new Error('No se pudo instanciar BunkerSigner: ' + (e.message || e));
            }

            // connect() envía la request al bunker; resuelve al recibir el ack.
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

            return { userPubkeyHex: userPubkey, bunkerPubkey: bp.pubkey, relays: _relays };
        } finally {
            _connecting = false;
        }
    }

    function isConnected()      { return !!_signer; }
    function getUserPubkey()    { return _userPubkey; }
    function getBunkerPubkey()  { return _bunkerPubkey; }
    function getBunkerRelays()  { return _relays.slice(); }

    // ── Operaciones delegadas ────────────────────────────────
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
        if (typeof _signer.nip04Encrypt !== 'function') {
            throw new Error('Bunker no soporta NIP-04 (método nip04Encrypt ausente)');
        }
        return await _signer.nip04Encrypt(thirdPartyPubkey, plaintext);
    }

    async function nip04Decrypt(thirdPartyPubkey, ciphertext) {
        if (!_signer) throw new Error('NIP-46: no conectado');
        if (typeof _signer.nip04Decrypt !== 'function') {
            throw new Error('Bunker no soporta NIP-04 (método nip04Decrypt ausente)');
        }
        return await _signer.nip04Decrypt(thirdPartyPubkey, ciphertext);
    }

    async function nip44Encrypt(thirdPartyPubkey, plaintext) {
        if (!_signer) throw new Error('NIP-46: no conectado');
        if (typeof _signer.nip44Encrypt !== 'function') {
            throw new Error('Bunker no soporta NIP-44');
        }
        return await _signer.nip44Encrypt(thirdPartyPubkey, plaintext);
    }

    async function nip44Decrypt(thirdPartyPubkey, ciphertext) {
        if (!_signer) throw new Error('NIP-46: no conectado');
        if (typeof _signer.nip44Decrypt !== 'function') {
            throw new Error('Bunker no soporta NIP-44');
        }
        return await _signer.nip44Decrypt(thirdPartyPubkey, ciphertext);
    }

    // El BunkerSigner expone nip44 si el bunker lo anunció en connect.
    // Si no lo expone, asumimos solo NIP-04.
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
        if (s) {
            try { if (typeof s.close === 'function') await s.close(); } catch (_) {}
        }
        _disconnectCbs.forEach(cb => { try { cb(); } catch (_) {} });
    }

    function onDisconnect(cb) {
        if (typeof cb === 'function') _disconnectCbs.push(cb);
    }

    // ── UI: modal de conexión bunker ─────────────────────────
    // Inyecta DOM una vez y devuelve una Promise<string|null> con la URI
    // que el usuario pega (o null si cancela). El llamador hace connect().
    function _ensureModalDOM() {
        if (document.getElementById('lbwNip46Modal')) return;
        const div = document.createElement('div');
        div.id = 'lbwNip46Modal';
        div.style.cssText = 'display:none;position:fixed;inset:0;z-index:99999;background:rgba(13,23,30,0.85);align-items:center;justify-content:center;padding:1rem;';
        div.innerHTML = `
            <div style="background:#0F1F2A;border:1px solid #40C4FF;border-radius:14px;max-width:500px;width:100%;padding:1.5rem;color:#E0E0E0;font-family:'Poppins',system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6);">
                <h3 style="margin:0 0 0.5rem 0;font-size:1.1rem;font-weight:700;color:#40C4FF;">🛰️ Conectar firmador remoto (NIP-46)</h3>
                <p style="margin:0 0 1rem 0;font-size:0.85rem;line-height:1.4;color:#B0BEC5;">
                    Pega la URL que te dio tu bunker (<a href="https://nsec.app" target="_blank" rel="noopener" style="color:#40C4FF;">nsec.app</a>, <a href="https://github.com/greenart7c3/Amber" target="_blank" rel="noopener" style="color:#40C4FF;">Amber</a>, nsecBunker…). Empieza por <code style="font-family:'JetBrains Mono',monospace;color:#E5B95C;">bunker://</code>.
                </p>
                <textarea id="lbwNip46Uri" placeholder="bunker://abcdef...?relay=wss://relay.nsec.app&secret=..." style="width:100%;min-height:90px;padding:0.6rem 0.75rem;border-radius:8px;border:1px solid #2C5F6F;background:#0A1419;color:#E0E0E0;margin-bottom:0.5rem;font-family:'JetBrains Mono',monospace;font-size:0.78rem;line-height:1.4;resize:vertical;"></textarea>
                <div id="lbwNip46Error" style="color:#EF5350;font-size:0.8rem;min-height:1.1em;margin-bottom:0.5rem;"></div>
                <div id="lbwNip46Status" style="display:none;background:rgba(64,196,255,0.08);border-left:3px solid #40C4FF;padding:0.6rem 0.75rem;margin-bottom:0.75rem;border-radius:0 6px 6px 0;font-size:0.78rem;line-height:1.4;color:#90CAF9;"></div>
                <div style="background:rgba(229,185,92,0.06);border-left:3px solid #E5B95C;padding:0.55rem 0.75rem;margin-bottom:0.75rem;border-radius:0 6px 6px 0;font-size:0.72rem;line-height:1.45;color:#B0BEC5;">
                    💡 La sesión NIP-46 es <strong>solo de memoria</strong>: al recargar tendrás que volver a pegar la URL. Tu bunker te pedirá aprobar firmas — marca "siempre permitir" para <code style="font-family:'JetBrains Mono',monospace;">kind 22242</code> (auth de relays) si tu signer lo soporta.
                </div>
                <button id="lbwNip46Submit" type="button" style="width:100%;padding:0.7rem;border-radius:8px;border:0;background:linear-gradient(135deg,#40C4FF,#0288D1);color:#0D171E;font-weight:700;cursor:pointer;margin-bottom:0.5rem;">🛰️ Conectar al bunker</button>
                <button id="lbwNip46Cancel" type="button" style="width:100%;padding:0.55rem;border-radius:8px;border:1px solid #455A64;background:transparent;color:#B0BEC5;cursor:pointer;font-size:0.85rem;">Cancelar</button>
            </div>
        `;
        document.body.appendChild(div);
    }

    function showModal() {
        return new Promise((resolve) => {
            _ensureModalDOM();
            const modal = document.getElementById('lbwNip46Modal');
            const uri = document.getElementById('lbwNip46Uri');
            const submit = document.getElementById('lbwNip46Submit');
            const cancel = document.getElementById('lbwNip46Cancel');
            const err = document.getElementById('lbwNip46Error');
            const status = document.getElementById('lbwNip46Status');

            uri.value = '';
            err.textContent = '';
            status.style.display = 'none';
            status.textContent = '';
            submit.disabled = false;
            submit.textContent = '🛰️ Conectar al bunker';

            modal.style.display = 'flex';
            setTimeout(() => uri.focus(), 50);

            const finish = (val) => {
                modal.style.display = 'none';
                submit.onclick = null;
                cancel.onclick = null;
                uri.onkeydown = null;
                resolve(val);
            };

            submit.onclick = () => {
                const v = (uri.value || '').trim().replace(/\s+/g, '');
                if (!v) { err.textContent = 'Pega tu bunker URL.'; return; }
                if (!v.startsWith('bunker://')) {
                    err.textContent = 'Debe empezar por bunker://';
                    return;
                }
                err.textContent = '';
                status.style.display = 'block';
                status.textContent = '⏳ Conectando al bunker… si tu signer pide aprobación, ábrelo y autoriza.';
                submit.disabled = true;
                submit.textContent = '⏳ Conectando…';
                finish(v);
            };
            cancel.onclick = () => finish(null);
            uri.onkeydown = (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit.onclick();
            };
        });
    }

    function setModalError(msg) {
        const err = document.getElementById('lbwNip46Error');
        const status = document.getElementById('lbwNip46Status');
        const submit = document.getElementById('lbwNip46Submit');
        if (err) err.textContent = msg || '';
        if (status) status.style.display = 'none';
        if (submit) { submit.disabled = false; submit.textContent = '🛰️ Conectar al bunker'; }
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
        connect, disconnect, isConnected,
        getUserPubkey, getBunkerPubkey, getBunkerRelays,
        signEvent,
        nip04Encrypt, nip04Decrypt,
        nip44Encrypt, nip44Decrypt,
        hasNip44, ping, onDisconnect,
        showModal, hideModal, setModalError, setModalStatus
    };
})();

window.LBW_NIP46 = LBW_NIP46;

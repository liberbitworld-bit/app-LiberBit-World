// ============================================================
// LiberBit World — Passlock (lbw-passlock.js)
//
// Cifrado de la nsec en localStorage con contraseña usando NIP-49
// (ncryptsec1... = scrypt + XChaCha20-Poly1305).
//
// El bundle UMD de nostr-tools 2.7.2 NO empaqueta el módulo nip49,
// así que lo cargamos bajo demanda como ESM desde esm.sh la primera
// vez que hace falta cifrar o descifrar. El resto del tiempo el
// usuario no paga el coste de descarga.
//
// Claves de localStorage:
//   lbw_ncryptsec     → string ncryptsec1... (cifrado con contraseña)
//   lbw_keys_version  → '2' una vez migrado el usuario
//
// Claves legacy a borrar tras migrar:
//   lbw_nsec_persist                → nsec en claro
//   liberbit_keys.privateKey        → nsec en claro (campo dentro del JSON)
//   sessionStorage.lbw_nsec_session → nsec en claro
// ============================================================

const LBW_Passlock = (() => {
    'use strict';

    const NIP49_ESM_URL = 'https://esm.sh/nostr-tools@2.7.2/nip49';
    const STORAGE_NCRYPTSEC = 'lbw_ncryptsec';
    const STORAGE_VERSION = 'lbw_keys_version';
    const LEGACY_NSEC_LS = 'lbw_nsec_persist';
    const LEGACY_NSEC_SS = 'lbw_nsec_session';

    let _nip49Promise = null;

    async function _loadNip49() {
        if (!_nip49Promise) {
            _nip49Promise = import(NIP49_ESM_URL).catch(err => {
                _nip49Promise = null; // permite reintentar
                throw new Error('No se pudo cargar el módulo NIP-49: ' + err.message);
            });
        }
        return _nip49Promise;
    }

    // ── Conversión nsec ↔ bytes ──────────────────────────────
    function _nsecToBytes(nsec) {
        if (!window.NostrTools || !window.NostrTools.nip19) {
            throw new Error('nostr-tools no está cargado');
        }
        const decoded = window.NostrTools.nip19.decode(nsec);
        if (decoded.type !== 'nsec') throw new Error('No es una nsec válida');
        let data = decoded.data;
        if (typeof data === 'string') {
            // 2.x temprano devolvía hex; convertir a Uint8Array
            const out = new Uint8Array(data.length / 2);
            for (let i = 0; i < out.length; i++) out[i] = parseInt(data.substr(i * 2, 2), 16);
            data = out;
        }
        if (!(data instanceof Uint8Array) || data.length !== 32) {
            throw new Error('nsec decodificada con formato inesperado');
        }
        return data;
    }

    function _bytesToNsec(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
            throw new Error('Clave debe ser Uint8Array de 32 bytes');
        }
        return window.NostrTools.nip19.nsecEncode(bytes);
    }

    // ── API criptográfica ────────────────────────────────────
    async function encryptNsec(nsec, password) {
        if (!nsec || typeof nsec !== 'string' || !nsec.startsWith('nsec1')) {
            throw new Error('Se esperaba una nsec1...');
        }
        if (!password || typeof password !== 'string') {
            throw new Error('Contraseña vacía');
        }
        const nip49 = await _loadNip49();
        const bytes = _nsecToBytes(nsec);
        // logn=16 → ~1s en navegador; aceptable. ksb=0x02 (default NIP-49).
        return nip49.encrypt(bytes, password);
    }

    async function decryptToNsec(ncryptsec, password) {
        if (!ncryptsec || typeof ncryptsec !== 'string' || !ncryptsec.startsWith('ncryptsec1')) {
            throw new Error('Se esperaba un ncryptsec1...');
        }
        const nip49 = await _loadNip49();
        let bytes;
        try {
            bytes = nip49.decrypt(ncryptsec, password);
        } catch (e) {
            throw new Error('Contraseña incorrecta');
        }
        return _bytesToNsec(bytes);
    }

    // ── Persistencia ─────────────────────────────────────────
    function saveEncrypted(ncryptsec) {
        try {
            localStorage.setItem(STORAGE_NCRYPTSEC, ncryptsec);
            localStorage.setItem(STORAGE_VERSION, '2');
        } catch (e) {
            console.error('[Passlock] No se pudo guardar ncryptsec:', e);
            throw e;
        }
    }

    function loadEncrypted() {
        try { return localStorage.getItem(STORAGE_NCRYPTSEC); } catch (e) { return null; }
    }

    function clearEncrypted() {
        try {
            localStorage.removeItem(STORAGE_NCRYPTSEC);
            localStorage.removeItem(STORAGE_VERSION);
        } catch (e) {}
    }

    function hasEncrypted() {
        return !!loadEncrypted();
    }

    // Detecta si quedan rastros de la nsec en claro en localStorage/sessionStorage
    function hasLegacyPlaintext() {
        try {
            if (localStorage.getItem(LEGACY_NSEC_LS)) return true;
            const k = localStorage.getItem('liberbit_keys');
            if (k) {
                const obj = JSON.parse(k);
                if (obj && obj.privateKey && typeof obj.privateKey === 'string' && obj.privateKey.startsWith('nsec1')) return true;
            }
        } catch (e) {}
        try { if (sessionStorage.getItem(LEGACY_NSEC_SS)) return true; } catch (e) {}
        return false;
    }

    // Recupera la nsec en claro existente (si la hay) — solo para migración
    function readLegacyNsec() {
        try {
            const ls = localStorage.getItem(LEGACY_NSEC_LS);
            if (ls && ls.startsWith('nsec1')) return ls;
        } catch (e) {}
        try {
            const k = localStorage.getItem('liberbit_keys');
            if (k) {
                const obj = JSON.parse(k);
                if (obj && obj.privateKey && obj.privateKey.startsWith && obj.privateKey.startsWith('nsec1')) return obj.privateKey;
            }
        } catch (e) {}
        try {
            const ss = sessionStorage.getItem(LEGACY_NSEC_SS);
            if (ss && ss.startsWith('nsec1')) return ss;
        } catch (e) {}
        return null;
    }

    function clearLegacyPlaintext() {
        try { localStorage.removeItem(LEGACY_NSEC_LS); } catch (e) {}
        try { sessionStorage.removeItem(LEGACY_NSEC_SS); } catch (e) {}
        try {
            const k = localStorage.getItem('liberbit_keys');
            if (k) {
                const obj = JSON.parse(k);
                if (obj && obj.privateKey) {
                    delete obj.privateKey;
                    localStorage.setItem('liberbit_keys', JSON.stringify(obj));
                }
            }
        } catch (e) {}
    }

    // ── UI: modal único multi-modo ───────────────────────────
    // mode: 'set' | 'unlock' | 'migrate' | 'migrate-backup'
    // opts.nsec: solo para 'migrate-backup', nsec a mostrar
    // Devuelve Promise<{password?: string, switchToExtension?: boolean, logout?: boolean, backupDone?: boolean} | null>
    function showModal(mode, opts = {}) {
        return new Promise((resolve) => {
            _ensureModalDOM();

            const modal = document.getElementById('lbwPasslockModal');
            const titleEl = document.getElementById('lbwPasslockTitle');
            const descEl = document.getElementById('lbwPasslockDesc');
            const warnEl = document.getElementById('lbwPasslockWarn');
            const nsecWrap = document.getElementById('lbwPasslockNsecWrap');
            const nsecValue = document.getElementById('lbwPasslockNsecValue');
            const nsecReveal = document.getElementById('lbwPasslockNsecReveal');
            const nsecCopy = document.getElementById('lbwPasslockNsecCopy');
            const pwd1 = document.getElementById('lbwPasslockPwd1');
            const pwd2 = document.getElementById('lbwPasslockPwd2');
            const pwd2Wrap = document.getElementById('lbwPasslockPwd2Wrap');
            const submitBtn = document.getElementById('lbwPasslockSubmit');
            const altBtn = document.getElementById('lbwPasslockAlt');
            const errEl = document.getElementById('lbwPasslockError');
            const spinner = document.getElementById('lbwPasslockSpinner');

            errEl.textContent = '';
            spinner.style.display = 'none';
            pwd1.value = '';
            pwd2.value = '';
            pwd1.disabled = false;
            pwd2.disabled = false;
            submitBtn.disabled = false;
            warnEl.style.display = 'none';
            nsecWrap.style.display = 'none';
            pwd1.style.display = '';
            pwd2Wrap.style.display = '';

            if (mode === 'set') {
                titleEl.textContent = opts.title || '🔒 Crea una contraseña';
                descEl.textContent = opts.desc || 'Cifrará tu clave privada (nsec) en este navegador. La pedirás cada vez que vuelvas a entrar.';
                pwd1.placeholder = 'Contraseña (mín. 8 caracteres)';
                pwd2.placeholder = 'Repite la contraseña';
                warnEl.style.display = '';
                submitBtn.textContent = 'Crear contraseña';
                altBtn.style.display = 'none';
            } else if (mode === 'unlock') {
                titleEl.textContent = opts.title || '🔓 Desbloquea tu cuenta';
                descEl.textContent = opts.desc || 'Introduce tu contraseña para descifrar tu clave Nostr en este navegador.';
                pwd1.placeholder = 'Contraseña';
                pwd2Wrap.style.display = 'none';
                submitBtn.textContent = 'Desbloquear';
                altBtn.textContent = 'Cerrar sesión';
                altBtn.style.display = '';
            } else if (mode === 'migrate-backup') {
                titleEl.textContent = '📋 Apunta tu clave privada';
                descEl.textContent = 'Antes de cifrarla, copia y guarda tu nsec en un sitio seguro (gestor de contraseñas, papel offline). Será tu único respaldo si olvidas la contraseña.';
                nsecValue.textContent = opts.nsec || '';
                nsecValue.style.filter = 'blur(5px)';
                nsecValue.title = 'Clic para revelar';
                nsecValue.onclick = () => { nsecValue.style.filter = 'none'; };
                nsecReveal.onclick = () => {
                    const blurred = nsecValue.style.filter !== 'none';
                    nsecValue.style.filter = blurred ? 'none' : 'blur(5px)';
                    nsecReveal.textContent = blurred ? '🙈 Ocultar' : '👁️ Mostrar';
                };
                nsecCopy.onclick = async () => {
                    try {
                        await navigator.clipboard.writeText(opts.nsec || '');
                        nsecCopy.textContent = '✅ Copiada';
                        setTimeout(() => { nsecCopy.textContent = '📋 Copiar'; }, 2000);
                    } catch (e) {
                        nsecCopy.textContent = '❌ Error';
                    }
                };
                nsecReveal.textContent = '👁️ Mostrar';
                nsecCopy.textContent = '📋 Copiar';
                nsecWrap.style.display = '';
                pwd1.style.display = 'none';
                pwd2Wrap.style.display = 'none';
                submitBtn.textContent = 'He guardado mi clave, continuar';
                altBtn.textContent = 'Cerrar sesión y usar NIP-07';
                altBtn.style.display = '';
            } else if (mode === 'migrate') {
                titleEl.textContent = '🛡️ Crea una contraseña';
                descEl.textContent = 'Cifraremos tu clave privada con esta contraseña. La pedirás cada vez que abras la app.';
                pwd1.placeholder = 'Contraseña (mín. 8 caracteres)';
                pwd2.placeholder = 'Repite la contraseña';
                warnEl.style.display = '';
                submitBtn.textContent = 'Cifrar y continuar';
                altBtn.textContent = 'Cerrar sesión y usar NIP-07';
                altBtn.style.display = '';
            }

            modal.style.display = 'flex';
            if (mode !== 'migrate-backup') setTimeout(() => pwd1.focus(), 50);

            const finish = (val) => {
                modal.style.display = 'none';
                submitBtn.onclick = null;
                altBtn.onclick = null;
                pwd1.onkeydown = null;
                pwd2.onkeydown = null;
                resolve(val);
            };

            const submit = async () => {
                if (mode === 'migrate-backup') {
                    finish({ backupDone: true });
                    return;
                }
                const p1 = pwd1.value;
                if (!p1) { errEl.textContent = 'Introduce una contraseña.'; return; }
                if (mode !== 'unlock') {
                    if (p1.length < 8) { errEl.textContent = 'Mínimo 8 caracteres.'; return; }
                    if (p1 !== pwd2.value) { errEl.textContent = 'Las contraseñas no coinciden.'; return; }
                }
                errEl.textContent = '';
                spinner.style.display = '';
                submitBtn.disabled = true;
                pwd1.disabled = true;
                pwd2.disabled = true;
                // Devolvemos la contraseña; el llamador decide qué hacer (cifrar o descifrar)
                // El llamador debe ocultar el modal manualmente si hay error tras intentarlo
                finish({ password: p1 });
            };

            submitBtn.onclick = submit;
            pwd1.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
            pwd2.onkeydown = (e) => { if (e.key === 'Enter') submit(); };

            if (mode === 'unlock') {
                altBtn.onclick = () => finish({ logout: true });
            } else if (mode === 'migrate' || mode === 'migrate-backup') {
                altBtn.onclick = () => finish({ switchToExtension: true });
            }
        });
    }

    // Reabre el modal con un mensaje de error (p.ej. contraseña incorrecta) sin
    // crearlo de nuevo — el llamador decide cuándo invocarlo.
    function showError(msg) {
        const errEl = document.getElementById('lbwPasslockError');
        const spinner = document.getElementById('lbwPasslockSpinner');
        const pwd1 = document.getElementById('lbwPasslockPwd1');
        const pwd2 = document.getElementById('lbwPasslockPwd2');
        const submitBtn = document.getElementById('lbwPasslockSubmit');
        if (errEl) errEl.textContent = msg || '';
        if (spinner) spinner.style.display = 'none';
        if (pwd1) { pwd1.disabled = false; pwd1.value = ''; pwd1.focus(); }
        if (pwd2) { pwd2.disabled = false; pwd2.value = ''; }
        if (submitBtn) submitBtn.disabled = false;
    }

    function hideModal() {
        const modal = document.getElementById('lbwPasslockModal');
        if (modal) modal.style.display = 'none';
    }

    // Crea el DOM del modal una vez (lo añadimos por JS para no tocar el HTML
    // si el repo decide retirar este sistema en el futuro).
    function _ensureModalDOM() {
        if (document.getElementById('lbwPasslockModal')) return;
        const div = document.createElement('div');
        div.id = 'lbwPasslockModal';
        div.style.cssText = 'display:none;position:fixed;inset:0;z-index:99999;background:rgba(13,23,30,0.85);align-items:center;justify-content:center;padding:1rem;';
        div.innerHTML = `
            <div style="background:#0F1F2A;border:1px solid var(--color-teal-light,#4DD0E1);border-radius:14px;max-width:440px;width:100%;padding:1.5rem;color:#E0E0E0;font-family:'Poppins',system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6);">
                <h3 id="lbwPasslockTitle" style="margin:0 0 0.5rem 0;font-size:1.1rem;font-weight:700;color:var(--color-gold,#E5B95C);"></h3>
                <p id="lbwPasslockDesc" style="margin:0 0 1rem 0;font-size:0.85rem;line-height:1.4;color:#B0BEC5;"></p>
                <div id="lbwPasslockNsecWrap" style="display:none;margin-bottom:1rem;">
                    <div style="font-size:0.75rem;color:#B0BEC5;margin-bottom:0.35rem;">🔑 Tu clave privada (nsec):</div>
                    <div style="position:relative;background:#0A1419;border:1px solid #2C5F6F;border-radius:8px;padding:0.55rem 0.75rem;font-family:'JetBrains Mono',monospace;font-size:0.78rem;word-break:break-all;line-height:1.35;">
                        <span id="lbwPasslockNsecValue" style="filter:blur(5px);cursor:pointer;display:block;color:#E5B95C;" title="Clic para revelar"></span>
                    </div>
                    <div style="display:flex;gap:0.4rem;margin-top:0.4rem;">
                        <button id="lbwPasslockNsecReveal" type="button" style="flex:1;padding:0.4rem;border-radius:6px;border:1px solid #455A64;background:transparent;color:#B0BEC5;cursor:pointer;font-size:0.78rem;">👁️ Mostrar</button>
                        <button id="lbwPasslockNsecCopy" type="button" style="flex:1;padding:0.4rem;border-radius:6px;border:1px solid #455A64;background:transparent;color:#B0BEC5;cursor:pointer;font-size:0.78rem;">📋 Copiar</button>
                    </div>
                </div>
                <div id="lbwPasslockWarn" style="display:none;background:rgba(229,185,92,0.08);border-left:3px solid #E5B95C;padding:0.6rem 0.75rem;margin-bottom:1rem;border-radius:0 6px 6px 0;font-size:0.78rem;line-height:1.4;color:#E5B95C;">
                    ⚠️ <strong>Esta contraseña no se puede recuperar.</strong> Si la pierdes, solo podrás recuperar la cuenta si tienes apuntada tu <code style="font-family:'JetBrains Mono',monospace;">nsec1...</code> original.
                </div>
                <input id="lbwPasslockPwd1" type="password" autocomplete="new-password" style="width:100%;padding:0.6rem 0.75rem;border-radius:8px;border:1px solid #2C5F6F;background:#0A1419;color:#E0E0E0;margin-bottom:0.5rem;font-family:'JetBrains Mono',monospace;font-size:0.9rem;" />
                <div id="lbwPasslockPwd2Wrap">
                    <input id="lbwPasslockPwd2" type="password" autocomplete="new-password" style="width:100%;padding:0.6rem 0.75rem;border-radius:8px;border:1px solid #2C5F6F;background:#0A1419;color:#E0E0E0;margin-bottom:0.5rem;font-family:'JetBrains Mono',monospace;font-size:0.9rem;" />
                </div>
                <div id="lbwPasslockError" style="color:#EF5350;font-size:0.8rem;min-height:1.1em;margin-bottom:0.5rem;"></div>
                <div id="lbwPasslockSpinner" style="display:none;font-size:0.8rem;color:#B0BEC5;margin-bottom:0.5rem;">⏳ Procesando contraseña (scrypt, ~1-2s)...</div>
                <button id="lbwPasslockSubmit" type="button" style="width:100%;padding:0.7rem;border-radius:8px;border:0;background:linear-gradient(135deg,#E5B95C,#C99B3E);color:#0D171E;font-weight:700;cursor:pointer;margin-bottom:0.5rem;"></button>
                <button id="lbwPasslockAlt" type="button" style="width:100%;padding:0.55rem;border-radius:8px;border:1px solid #455A64;background:transparent;color:#B0BEC5;cursor:pointer;font-size:0.85rem;display:none;"></button>
            </div>
        `;
        document.body.appendChild(div);
    }

    // ── Helpers de alto nivel para los flujos del bridge ─────
    // Pide contraseña nueva, cifra la nsec y la guarda. Lanza si el usuario cancela.
    async function setupPasswordAndStore(nsec, opts) {
        const res = await showModal('set', opts || {});
        if (!res || !res.password) { hideModal(); throw new Error('Configuración de contraseña cancelada'); }
        try {
            const ncryptsec = await encryptNsec(nsec, res.password);
            saveEncrypted(ncryptsec);
            hideModal();
            return ncryptsec;
        } catch (e) {
            showError(e.message || 'Error al cifrar');
            throw e;
        }
    }

    // Pide contraseña, descifra el ncryptsec guardado y devuelve la nsec.
    // Reintenta hasta que la contraseña sea correcta o el usuario pulse "Cerrar sesión".
    async function unlockWithPasswordPrompt(opts) {
        const ncryptsec = loadEncrypted();
        if (!ncryptsec) throw new Error('No hay clave cifrada para desbloquear');
        while (true) {
            const res = await showModal('unlock', opts || {});
            if (!res) { hideModal(); throw new Error('Cancelado'); }
            if (res.logout) { hideModal(); return { logout: true }; }
            try {
                const nsec = await decryptToNsec(ncryptsec, res.password);
                hideModal();
                return { nsec };
            } catch (e) {
                showError('Contraseña incorrecta. Vuelve a intentarlo.');
                // bucle: showModal se vuelve a abrir
            }
        }
    }

    // Migración en dos pasos: 1) backup obligatorio de la nsec en claro
    // (el usuario confirma haberla guardado), 2) crear contraseña y cifrar.
    // Si el usuario elige "Cerrar sesión" en cualquier paso, devuelve {logout:true}
    // y el bridge hace logout completo.
    async function migrateLegacyToEncrypted() {
        const legacyNsec = readLegacyNsec();
        if (!legacyNsec) throw new Error('No hay nsec legacy para migrar');

        // Paso 1: backup obligatorio
        const backup = await showModal('migrate-backup', { nsec: legacyNsec });
        if (!backup || backup.switchToExtension) { hideModal(); return { logout: true }; }
        // backup.backupDone === true → continuar a paso 2

        // Paso 2: crear contraseña y cifrar (con bucle por si falla)
        while (true) {
            const res = await showModal('migrate');
            if (!res) { hideModal(); return { logout: true }; }
            if (res.switchToExtension) { hideModal(); return { logout: true }; }
            try {
                const ncryptsec = await encryptNsec(legacyNsec, res.password);
                saveEncrypted(ncryptsec);
                clearLegacyPlaintext();
                hideModal();
                return { nsec: legacyNsec };
            } catch (e) {
                showError('Error al cifrar: ' + (e.message || ''));
            }
        }
    }

    // Persiste currentUser en localStorage SIN la privateKey en claro.
    // Sustituye los `localStorage.setItem('liberbit_keys', JSON.stringify(currentUser))`
    // dispersos por auth.js y nostr-bridge.js.
    function persistKeys(user) {
        if (!user) return;
        try {
            const safe = Object.assign({}, user);
            if (safe.privateKey) delete safe.privateKey;
            localStorage.setItem('liberbit_keys', JSON.stringify(safe));
        } catch (e) {}
    }

    return {
        encryptNsec, decryptToNsec,
        saveEncrypted, loadEncrypted, clearEncrypted, hasEncrypted,
        hasLegacyPlaintext, readLegacyNsec, clearLegacyPlaintext,
        showModal, showError, hideModal,
        setupPasswordAndStore, unlockWithPasswordPrompt, migrateLegacyToEncrypted,
        persistKeys
    };
})();

window.LBW_Passlock = LBW_Passlock;
window.LBW_persistKeys = LBW_Passlock.persistKeys;

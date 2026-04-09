// api/lnurlp/resolve.js
// Proxy CORS para resolver Lightning addresses externas (LNURLP)
// Uso: GET /api/lnurlp/resolve?address=user@domain.com
// Uso: GET /api/lnurlp/resolve?callback=https://...&amount=1000
//
// [SEC-24] Endurecimiento contra SSRF.
// La versión anterior validaba el destino con un mero `startsWith('https://')`,
// lo que convertía este endpoint en un open proxy HTTPS: cualquier atacante podía
// pedirle al servidor que hiciera un fetch a una URL arbitraria, escapando del
// firewall del propio atacante o escaneando redes internas accesibles desde
// el runtime de Vercel. Además el modo `?address=` arrastraba el mismo bug
// porque el `domain` extraído del email se concatenaba a una URL de fetch
// también sin validación.
//
// Cambios principales:
//   1. Parseo estricto con `new URL()` (no más `startsWith`).
//   2. Solo `https:`, puerto 443, sin credenciales embebidas.
//   3. Hostname no puede ser una IP literal (v4 o v6) ni un nombre reservado
//      (`localhost`, `*.local`, `*.internal`, `*.localhost`).
//   4. `fetch` con `redirect: 'error'` — un 3xx que apunte a una IP privada
//      no puede usarse como bypass.
//   5. Timeout 8s y límite de respuesta de 64 KB.
//   6. Las mismas validaciones aplican al modo `?address=`, no solo al
//      `?callback=`.
//   7. CORS `*` reemplazado por allowlist de orígenes (cierra de paso el
//      bug 26 del informe original).
//   8. Validación del local-part del lud16 para impedir inyección en el path.

const ALLOWED_ORIGINS = [
    'https://liberbitworld.org',
    'https://www.liberbitworld.org',
    'https://liberbitcity.org',
    'https://www.liberbitcity.org',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
];

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024; // 64 KB — un LNURLP responde típicamente <2 KB

const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const FORBIDDEN_HOSTNAMES = new Set([
    'localhost',
    '0.0.0.0',
    'broadcasthost',
    'ip6-localhost',
    'ip6-loopback',
    'ip6-localnet'
]);

function isIpLiteral(host) {
    if (IPV4_REGEX.test(host)) return true;
    // IPv6 cuando se pasa pelado (sin corchetes) contiene ':'.
    // En `URL.hostname` los corchetes ya están eliminados, así que basta con
    // detectar cualquier `:` en el hostname.
    if (host.includes(':')) return true;
    return false;
}

// Devuelve null si el hostname es seguro, o una cadena con la razón del rechazo.
function rejectIfUnsafeHostname(host) {
    if (!host) return 'hostname vacío';
    const h = host.toLowerCase();
    if (FORBIDDEN_HOSTNAMES.has(h)) return `hostname reservado: ${h}`;
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) {
        return `TLD reservado: ${h}`;
    }
    if (isIpLiteral(h)) {
        // Ningún proveedor LNURLP legítimo expone una IP literal en su lud16.
        // Bloquearlas elimina el escaneo de redes internas (RFC1918, loopback,
        // link-local, etc.) sin necesidad de mantener una lista de rangos.
        return `IPs literales no permitidas: ${h}`;
    }
    return null;
}

// Parsea y valida una URL externa que vamos a fetch-ear.
// Lanza Error si no pasa los chequeos.
function validateExternalUrl(rawUrl) {
    let u;
    try {
        u = new URL(rawUrl);
    } catch (e) {
        throw new Error('URL inválida');
    }
    if (u.protocol !== 'https:') {
        throw new Error('Solo HTTPS está permitido');
    }
    if (u.username || u.password) {
        throw new Error('Credenciales en URL no permitidas');
    }
    if (u.port && u.port !== '443') {
        throw new Error(`Puerto no permitido: ${u.port}`);
    }
    const reason = rejectIfUnsafeHostname(u.hostname);
    if (reason) throw new Error(reason);
    return u;
}

// fetch con timeout, sin seguir redirects y con tope de bytes.
async function safeFetchJson(url) {
    const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // [SEC-24] redirect:'error' impide el bypass clásico:
        //   1. atacante apunta `evil.com` (que pasa nuestras validaciones)
        //   2. evil.com responde 302 → http://127.0.0.1/admin
        //   3. fetch lo seguiría y haría la petición a la IP interna
        // Con 'error', el fetch tira TypeError ante cualquier 3xx.
        redirect: 'error'
    });

    if (!response.ok) {
        throw new Error(`upstream HTTP ${response.status}`);
    }

    // Lectura limitada en streaming para no permitir respuestas gigantes
    // (proxy como exfiltrador masivo / amplificador).
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Error('respuesta demasiado grande');
            }
            chunks.push(value);
        }
    } finally {
        try { reader.releaseLock(); } catch (e) {}
    }

    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    const text = new TextDecoder().decode(buf);
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('respuesta no es JSON válido');
    }
}

function setCorsHeaders(req, res) {
    const origin = req.headers.origin || '';
    const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Método no permitido' });
    }

    try {
        // ── Modo 1: resolver metadata LNURLP de una Lightning address ─────
        if (req.query.address) {
            const address = String(req.query.address).trim();
            if (!address.includes('@') || address.length > 320) {
                return res.status(400).json({ error: 'Formato inválido. Usa user@domain.com' });
            }
            const atIdx = address.lastIndexOf('@');
            const user = address.slice(0, atIdx);
            const domain = address.slice(atIdx + 1);

            // [SEC-24] Validar el local-part: el spec LUD-16 permite cualquier
            // local-part RFC 5321 válido, pero en la práctica los proveedores
            // Lightning solo usan alfanumérico + . _ + -.  Restringirlo aquí
            // impide inyectar caracteres especiales en el path de la URL.
            if (!/^[A-Za-z0-9._+-]{1,64}$/.test(user)) {
                return res.status(400).json({ error: 'Nombre de usuario inválido' });
            }

            const url = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`;
            let parsed;
            try {
                parsed = validateExternalUrl(url);
            } catch (e) {
                return res.status(400).json({ error: e.message });
            }

            const data = await safeFetchJson(parsed.toString());
            return res.status(200).json(data);
        }

        // ── Modo 2: proxy del callback (petición de invoice) ──────────────
        if (req.query.callback) {
            const callbackUrl = String(req.query.callback);
            let parsed;
            try {
                parsed = validateExternalUrl(callbackUrl);
            } catch (e) {
                return res.status(400).json({ error: e.message });
            }

            // Reenviar todos los query params excepto 'callback'.
            for (const [k, v] of Object.entries(req.query)) {
                if (k === 'callback') continue;
                // Aceptar solo strings simples; rechazar arrays (p.ej. ?amount=1&amount=2)
                // que podrían usarse para confundir al backend del proveedor.
                if (typeof v !== 'string') continue;
                parsed.searchParams.append(k, v);
            }

            const data = await safeFetchJson(parsed.toString());
            return res.status(200).json(data);
        }

        return res.status(400).json({ error: 'Parámetro requerido: address o callback' });

    } catch (err) {
        console.error('[resolve] Error:', err.message);
        return res.status(502).json({ error: err.message || 'upstream error' });
    }
}

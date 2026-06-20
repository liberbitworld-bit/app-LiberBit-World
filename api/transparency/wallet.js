// ============================================================
// LiberBit World — Transparency Wallet endpoint
//
// Proxy a coinos.io USANDO SÓLO endpoints públicos. Sin auth, sin
// firma NIP-98, sin dependencias npm. Devuelve username, perfil,
// Lightning address y datos LNURLP.
//
// Para balance + tabla de movimientos haría falta autenticación
// (NIP-98 con la nsec). Lo intentamos antes pero @noble/* crashea
// el lambda de Vercel sin loggear (bug runtime). Mientras tanto
// dejamos el panel mostrando la dirección pública con QR + link
// directo a la wallet en coinos para que cualquiera pueda auditar
// el saldo y movimientos directamente en coinos.io/Liberbitworld.
// ============================================================

const COINOS_USERNAME = 'Liberbitworld';

let _cache = null;
let _cacheAt = 0;
const TTL_MS = 60_000;

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

    if (_cache && Date.now() - _cacheAt < TTL_MS) {
        return res.status(200).json({ ..._cache, cached: true });
    }

    try {
        // Endpoints públicos de coinos — no requieren auth
        const [userRes, lnurlpRes] = await Promise.all([
            fetch(`https://coinos.io/api/users/${COINOS_USERNAME}`),
            fetch(`https://coinos.io/.well-known/lnurlp/${COINOS_USERNAME}`)
        ]);

        const user = userRes.ok ? await userRes.json() : null;
        const lnurlp = lnurlpRes.ok ? await lnurlpRes.json() : null;

        if (!user) {
            return res.status(502).json({
                error: 'no se pudo obtener perfil',
                detail: 'coinos /api/users devolvió ' + userRes.status,
                configured: true
            });
        }

        const result = {
            username: user.username || COINOS_USERNAME,
            display: user.display || user.username || '',
            about: user.about || '',
            picture: user.picture || '',
            banner: user.banner || '',
            currency: user.currency || 'SAT',
            npub: user.npub || '',
            pubkey: user.pubkey || '',
            lightning: `${user.username || COINOS_USERNAME}@coinos.io`,
            publicUrl: `https://coinos.io/${user.username || COINOS_USERNAME}`,
            lnurlp: lnurlp ? {
                minSendable: lnurlp.minSendable,
                maxSendable: lnurlp.maxSendable,
                commentAllowed: lnurlp.commentAllowed,
                allowsNostr: lnurlp.allowsNostr,
                callback: lnurlp.callback
            } : null,
            // Balance y movimientos requieren auth (NIP-98) — no soportado todavía
            balance: null,
            movements: [],
            authNotSupported: true,
            fetchedAt: Date.now(),
            configured: true
        };

        _cache = result;
        _cacheAt = Date.now();

        return res.status(200).json(result);
    } catch (e) {
        if (_cache) {
            return res.status(200).json({
                ..._cache,
                cached: true,
                stale: true,
                error: e.message
            });
        }
        return res.status(502).json({
            error: 'fallo al consultar coinos',
            detail: e.message,
            configured: true
        });
    }
}

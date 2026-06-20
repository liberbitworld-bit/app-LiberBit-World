// ============================================================
// LiberBit World — Transparency Wallet endpoint
//
// Proxy a coinos.io. La nsec NUNCA llega al navegador: vive solo
// como env var COINOS_SK en Vercel y se usa aquí para firmar
// eventos NIP-98 (kind:27235) que coinos exige como auth.
//
// Usamos @noble/secp256k1 v1.7.x — versión single-file (sin subpath
// exports) con schnorr incluido. Vercel bundlea sin problemas.
// sha256 vía node:crypto built-in.
// ============================================================

let _cache = null;
let _cacheAt = 0;
const TTL_MS = 30000;

function hexToBytes(hex) {
    const clean = hex.trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
        throw new Error('hex invalido');
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
        s += bytes[i].toString(16).padStart(2, '0');
    }
    return s;
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

    if (_cache && Date.now() - _cacheAt < TTL_MS) {
        return res.status(200).json({ ..._cache, cached: true });
    }

    const sk = process.env.COINOS_SK;
    if (!sk) {
        return res.status(503).json({
            error: 'wallet no configurada',
            detail: 'Falta env var COINOS_SK en Vercel',
            configured: false
        });
    }

    let skBytes;
    try {
        skBytes = hexToBytes(sk);
        if (skBytes.length !== 32) throw new Error('sk debe ser 32 bytes (64 hex chars)');
    } catch (e) {
        return res.status(500).json({
            error: 'COINOS_SK invalida',
            detail: e.message,
            configured: false
        });
    }

    // Imports dinámicos con diagnóstico JSON si fallan
    let secp, createHash;
    try {
        secp = await import('@noble/secp256k1');
        const nodeCrypto = await import('node:crypto');
        createHash = nodeCrypto.createHash;
        if (!secp.schnorr || typeof secp.schnorr.sign !== 'function') {
            throw new Error('schnorr.sign no disponible. exports: ' + Object.keys(secp).join(','));
        }
    } catch (e) {
        return res.status(500).json({
            error: 'fallo cargando crypto',
            detail: e.message,
            stack: (e.stack || '').substring(0, 500),
            configured: true
        });
    }

    function sha256Bytes(bytes) {
        const h = createHash('sha256');
        h.update(Buffer.from(bytes));
        return new Uint8Array(h.digest());
    }

    // NIP-98 inline: kind:27235, tags [["u",url],["method",method]], sig schnorr (BIP-340)
    async function buildNip98Token(url, method) {
        const pubkeyBytes = secp.schnorr.getPublicKey(skBytes);
        const pubkey = bytesToHex(pubkeyBytes);
        const created_at = Math.floor(Date.now() / 1000);
        const kind = 27235;
        const tags = [['u', url], ['method', method.toUpperCase()]];
        const content = '';
        const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
        const idBytes = sha256Bytes(new TextEncoder().encode(serialized));
        const id = bytesToHex(idBytes);
        // En @noble/secp256k1 v1.7.x schnorr.sign es async
        const sigBytes = await secp.schnorr.sign(idBytes, skBytes);
        const sig = bytesToHex(sigBytes);
        const event = { kind, created_at, tags, content, pubkey, id, sig };
        const base64 = Buffer.from(JSON.stringify(event)).toString('base64');
        return 'Nostr ' + base64;
    }

    async function authedGet(url) {
        const token = await buildNip98Token(url, 'GET');
        const r = await fetch(url, { headers: { Authorization: token } });
        if (!r.ok) {
            const body = await r.text().catch(() => '');
            throw new Error('coinos ' + r.status + ': ' + body.substring(0, 200));
        }
        return r.json();
    }

    try {
        const [me, payments] = await Promise.all([
            authedGet('https://coinos.io/api/me'),
            authedGet('https://coinos.io/api/payments?start=0&end=' + Date.now())
        ]);

        const txs = Array.isArray(payments) ? payments : (payments.payments || []);

        let totalIn = 0;
        let totalOut = 0;
        const movements = txs.map(p => {
            const amount = Number(p.amount) || 0;
            if (amount > 0) totalIn += amount;
            else totalOut += Math.abs(amount);
            const ts = p.created_at
                ? Math.floor(new Date(p.created_at).getTime() / 1000)
                : (p.timestamp ? Math.floor(p.timestamp / 1000) : 0);
            return {
                id: p.id || p.hash || p.payment_hash || '',
                ts,
                amount,
                memo: (p.memo || p.comment || p.description || '').toString().substring(0, 200),
                type: amount > 0 ? 'in' : 'out',
                hash: p.payment_hash || p.hash || p.id || '',
                confirmed: p.confirmed !== false
            };
        }).sort((a, b) => b.ts - a.ts);

        const result = {
            username: me.username || '',
            lightning: me.username ? (me.username + '@coinos.io') : '',
            balance: Number(me.balance) || 0,
            totalIn,
            totalOut,
            txCount: movements.length,
            movements: movements.slice(0, 200),
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

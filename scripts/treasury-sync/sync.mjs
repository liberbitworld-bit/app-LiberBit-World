// ============================================================
// LiberBit World — Treasury Sync Worker
//
// Firma NIP-98 (kind:27235) con la nsec de Liberbitworld@coinos.io,
// pide /api/me y /api/payments a coinos, y guarda el snapshot en
// Supabase tabla treasury_snapshots. Pensado para correr en GitHub
// Actions cada 15 min (NO en Vercel — @noble crashea el lambda).
//
// Env vars requeridas:
//   COINOS_SK            — nsec hex 64 chars de la wallet de tesorería
//   SUPABASE_URL         — https://<project>.supabase.co
//   SUPABASE_SERVICE_KEY — service_role key (escritura)
//
// Output: exit 0 si OK + ❌ stderr + exit 1 si error.
// ============================================================

import { schnorr } from '@noble/curves/secp256k1';
import { createHash } from 'node:crypto';

const COINOS_USERNAME = 'Liberbitworld';

const sk = process.env.COINOS_SK;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!sk || !/^[0-9a-f]{64}$/i.test(sk)) {
    console.error('❌ COINOS_SK ausente o inválida (debe ser 64 hex chars)');
    process.exit(1);
}
if (!supabaseUrl) {
    console.error('❌ SUPABASE_URL ausente');
    process.exit(1);
}
if (!supabaseKey) {
    console.error('❌ SUPABASE_SERVICE_KEY ausente');
    process.exit(1);
}

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
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

const skBytes = hexToBytes(sk);

function sha256Bytes(bytes) {
    return new Uint8Array(createHash('sha256').update(Buffer.from(bytes)).digest());
}

// NIP-98 inline: kind:27235, tags [["u",url],["method",method]], sig schnorr BIP-340
async function nip98Token(url, method) {
    const pubkeyBytes = schnorr.getPublicKey(skBytes);
    const pubkey = bytesToHex(pubkeyBytes);
    const created_at = Math.floor(Date.now() / 1000);
    const kind = 27235;
    const tags = [['u', url], ['method', method.toUpperCase()]];
    const content = '';
    const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
    const idBytes = sha256Bytes(new TextEncoder().encode(serialized));
    const id = bytesToHex(idBytes);
    const sigBytes = await schnorr.sign(idBytes, skBytes);
    const sig = bytesToHex(sigBytes);
    const event = { kind, created_at, tags, content, pubkey, id, sig };
    return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64');
}

// Diagnóstico: nuestro pubkey (lo que coinos espera ver firmado)
{
    const pubkeyHex = bytesToHex(schnorr.getPublicKey(skBytes));
    console.log('[treasury-sync] 🔑 pubkey (x-only):', pubkeyHex);
    console.log('[treasury-sync] 🕐 server time:    ', new Date().toISOString(), '(unix:', Math.floor(Date.now()/1000) + ')');
}

async function authedGet(url) {
    const token = await nip98Token(url, 'GET');
    const r = await fetch(url, { headers: { Authorization: token } });
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        // Diagnóstico extra: decodificar nuestro token para inspección
        const eventJson = Buffer.from(token.replace(/^Nostr\s+/, ''), 'base64').toString('utf8');
        console.error('[treasury-sync] ❌ ' + r.status + ' ' + url);
        console.error('[treasury-sync]    response body:', body.substring(0, 300));
        console.error('[treasury-sync]    event enviado:', eventJson.substring(0, 400));
        throw new Error(`coinos ${url} → ${r.status}: ${body.substring(0, 200)}`);
    }
    return r.json();
}

console.log('[treasury-sync] 📡 consultando coinos…');

const [me, payments] = await Promise.all([
    authedGet('https://coinos.io/api/me'),
    authedGet('https://coinos.io/api/payments?start=0&end=' + Date.now())
]);

console.log('[treasury-sync] 👤 perfil:', me.username, '· balance:', me.balance, 'sats');

const txs = Array.isArray(payments) ? payments : (payments.payments || []);
console.log('[treasury-sync] 💸 movimientos crudos:', txs.length);

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

const snapshot = {
    username: me.username || COINOS_USERNAME,
    balance: Number(me.balance) || 0,
    total_in: totalIn,
    total_out: totalOut,
    tx_count: movements.length,
    movements: movements.slice(0, 500),
    fetched_at: new Date().toISOString()
};

console.log(`[treasury-sync] 📊 snapshot: balance=${snapshot.balance} in=${snapshot.total_in} out=${snapshot.total_out} txs=${snapshot.tx_count}`);

const insertRes = await fetch(`${supabaseUrl}/rest/v1/treasury_snapshots`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Prefer': 'return=minimal'
    },
    body: JSON.stringify(snapshot)
});

if (!insertRes.ok) {
    const errBody = await insertRes.text();
    console.error('❌ Supabase insert failed:', insertRes.status, errBody);
    process.exit(1);
}

console.log('[treasury-sync] ✅ snapshot guardado en Supabase');

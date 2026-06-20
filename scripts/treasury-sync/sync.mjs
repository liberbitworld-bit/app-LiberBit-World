// ============================================================
// LiberBit World — Treasury Sync Worker
//
// Llama a coinos.io /api/me y /api/payments con un JWT read-only
// (generado una vez vía GET /api/ro estando logueado como
// Liberbitworld) y guarda el snapshot en Supabase tabla
// treasury_snapshots. Se ejecuta en GitHub Actions cada 15 min.
//
// Bearer JWT — cero crypto, cero deps. coinos verifica el JWT
// contra su secret config.jwt; si el id termina en "-ro" solo
// permite GET /invoice y GET /payments (whitelist en lib/auth.ts
// de coinos-server). Perfecto para wallet de transparencia.
//
// Env vars requeridas:
//   COINOS_TOKEN         — JWT read-only (sufijo -ro en el id)
//   SUPABASE_URL         — https://<project>.supabase.co
//   SUPABASE_SERVICE_KEY — service_role key
// ============================================================

const COINOS_USERNAME = 'Liberbitworld';

const token = process.env.COINOS_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!token) {
    console.error('❌ COINOS_TOKEN ausente');
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

async function authedGet(url) {
    const r = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`coinos ${url} → ${r.status}: ${body.substring(0, 200)}`);
    }
    return r.json();
}

console.log('[treasury-sync] 📡 consultando coinos…');

// Nota: el token -ro solo tiene whitelist para GET /invoice y GET /payments
// (no /me). Para perfil usamos /api/users/<username> que es público y no
// requiere auth.
const [profile, payments] = await Promise.all([
    fetch(`https://coinos.io/api/users/${COINOS_USERNAME}`).then(r => r.json()),
    authedGet('https://coinos.io/api/payments?start=0&end=' + Date.now())
]);

console.log('[treasury-sync] 👤 perfil:', profile.username);

const txs = Array.isArray(payments) ? payments : (payments.payments || []);
console.log('[treasury-sync] 💸 movimientos crudos:', txs.length);

let totalIn = 0;
let totalOut = 0;
let runningBalance = 0;
const movements = txs.map(p => {
    const amount = Number(p.amount) || 0;
    if (amount > 0) totalIn += amount;
    else totalOut += Math.abs(amount);
    runningBalance += amount;
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

// El balance "real" es la suma neta. Coinos no devuelve balance en /payments,
// y /me requiere auth no-readonly. La suma de in/out es nuestro mejor cálculo
// (asume que todos los payments están confirmed y no hay pending).
const snapshot = {
    username: profile.username || COINOS_USERNAME,
    balance: runningBalance,
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

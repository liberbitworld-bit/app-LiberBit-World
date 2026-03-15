// api/lnurlp/resolve.js
// Proxy CORS para resolver Lightning addresses externas (LNURLP)
// Uso: GET /api/lnurlp/resolve?address=user@domain.com
// Uso: GET /api/lnurlp/resolve?callback=https://...&amount=1000

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // ── Modo 1: resolver metadata LNURLP de una Lightning address ─────
        if (req.query.address) {
            const address = req.query.address.trim();
            if (!address.includes('@')) {
                return res.status(400).json({ error: 'Formato inválido. Usa user@domain.com' });
            }
            const [user, domain] = address.split('@');
            const url = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`;

            const response = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(8000)
            });
            if (!response.ok) {
                return res.status(502).json({ error: `LNURLP endpoint devolvió ${response.status}` });
            }
            const data = await response.json();
            return res.status(200).json(data);
        }

        // ── Modo 2: proxy del callback (petición de invoice) ──────────────
        if (req.query.callback) {
            const callbackUrl = req.query.callback;
            // Seguridad básica: solo URLs https
            if (!callbackUrl.startsWith('https://')) {
                return res.status(400).json({ error: 'Solo se permiten callbacks HTTPS' });
            }
            // Reenviar todos los query params excepto 'callback'
            const params = new URLSearchParams();
            Object.entries(req.query).forEach(([k, v]) => {
                if (k !== 'callback') params.append(k, v);
            });
            const finalUrl = `${callbackUrl}${callbackUrl.includes('?') ? '&' : '?'}${params.toString()}`;
            const response = await fetch(finalUrl, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(10000)
            });
            const data = await response.json();
            return res.status(200).json(data);
        }

        return res.status(400).json({ error: 'Parámetro requerido: address o callback' });

    } catch (err) {
        console.error('[resolve] Error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}

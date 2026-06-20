// MINIMAL TEST — para aislar si el problema es el código o el archivo
export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sk = process.env.COINOS_SK;
    return res.status(200).json({
        ping: 'ok',
        ts: Date.now(),
        sk_configured: !!sk,
        sk_length: sk ? sk.length : 0,
        node_version: process.version
    });
}

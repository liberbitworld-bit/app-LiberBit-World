export default async function handler(req, res) {
  try {
    const response = await fetch(
      'https://getalby.com/.well-known/lnurlp/gleamingfriendship873712'
    );
    const data = await response.json();
    
    // Usar nuestro propio callback
    data.callback = 'https://liberbitworld.org/api/lnurlp/callback';
    
    // Forzar maxSendable (Alby devuelve 0 pero sí acepta pagos)
    if (data.maxSendable === 0) {
      data.maxSendable = 100000000000; // 1 BTC en millisats
    }
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch lightning address info' });
  }
}

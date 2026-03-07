export default async function handler(req, res) {
  try {
    const response = await fetch(
      'https://getalby.com/.well-known/lnurlp/gleamingfriendship873712'
    );
    const data = await response.json();
    
    // Siempre usar el dominio sin www para que LNURL no rompa por redirects
    data.callback = 'https://liberbitworld.org/api/lnurlp/callback';
    
    // Forzar maxSendable
    if (!data.maxSendable || data.maxSendable === 0) {
      data.maxSendable = 100000000000;
    }
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch lightning address info' });
  }
}

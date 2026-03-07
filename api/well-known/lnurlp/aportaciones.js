export default async function handler(req, res) {
  try {
    const response = await fetch(
      'https://coinos.io/.well-known/lnurlp/germanliberbit'
    );
    const data = await response.json();
    
    // NO sobreescribimos el callback — coinos usa URL propia con UUID
    // data.callback = ... 
    
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

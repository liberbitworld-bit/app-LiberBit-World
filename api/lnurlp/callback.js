export default async function handler(req, res) {
  try {
    const queryString = new URLSearchParams(req.query).toString();
    const response = await fetch(
      `https://getalby.com/lnurlp/gleamingfriendship873712/callback?${queryString}`
    );
    const data = await response.json();
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get invoice' });
  }
}

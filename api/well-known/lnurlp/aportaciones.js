export default async function handler(req, res) {
  try {
    const response = await fetch(
      'https://getalby.com/.well-known/lnurlp/gleamingfriendship873712'
    );
    const data = await response.json();
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch lightning address info' });
  }
}

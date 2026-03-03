// API route para Lightning Address: aportaciones@liberbitworld.org
// Permite recibir pagos Lightning usando tu propio dominio

export default async function handler(req, res) {
  // Permitir CORS para wallets
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  try {
    // Obtener la configuración LNURL de tu wallet Alby
    const albyResponse = await fetch(
      'https://getalby.com/.well-known/lnurlp/gleamingfriendship873712'
    );
    
    if (!albyResponse.ok) {
      throw new Error('Error connecting to Alby');
    }

    const lnurlData = await albyResponse.json();
    
    // Devolver la respuesta LNURL-pay
    return res.status(200).json(lnurlData);
    
  } catch (error) {
    console.error('Lightning Address error:', error);
    return res.status(500).json({ 
      status: 'ERROR', 
      reason: 'Error processing Lightning Address request' 
    });
  }
}

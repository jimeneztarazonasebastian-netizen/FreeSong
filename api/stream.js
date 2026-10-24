// api/stream.js - Redirección ultrarrápida al stream de audio nativo AAC (itag 140) para iPhone (iOS Safari) y Web
export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const videoId = (req.query && req.query.id) || urlObj.searchParams.get('id');

  if (!videoId) {
    return res.status(400).json({ error: 'Falta el id de la canción' });
  }

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    return res.status(204).end();
  }

  try {
    // URL de stream nativo de audio puro AAC en contenedor mp4 (itag 140)
    // local=true enruta la transmisión a través del servidor proxy, evitando el bloqueo 403 de Google Video
    const streamTarget = `https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=140&local=true`;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.redirect(307, streamTarget);
  } catch (err) {
    console.error('Error en /api/stream:', err);
    return res.status(500).json({ error: err.message || 'Error al obtener stream' });
  }
}

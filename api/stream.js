// api/stream.js - Redirección ultrarrápida al stream de audio nativo AAC (itag 140) con carrera Promise.any entre los nodos más rápidos
export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const videoId = (req.query && req.query.id) || urlObj.searchParams.get('id');

  if (!videoId) {
    if (res && res.status) return res.status(400).json({ error: 'Falta el id de la canción' });
    return new Response(JSON.stringify({ error: 'Falta el id de la canción' }), { status: 400 });
  }

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    if (res && res.setHeader) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
      return res.status(204).end();
    }
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type'
      }
    });
  }

  const nodes = [
    'https://invidious.slipfox.xyz',
    'https://yewtu.be',
    'https://yt.chocolatemoo53.com'
  ];

  let fastestUrl = `https://invidious.slipfox.xyz/latest_version?id=${encodeURIComponent(videoId)}&itag=140&local=true`;

  try {
    const winner = await Promise.any(
      nodes.map(async (host) => {
        const target = `${host}/latest_version?id=${encodeURIComponent(videoId)}&itag=140&local=true`;
        const resp = await fetch(target, {
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(1800)
        });
        if (resp.ok || resp.status === 200 || resp.status === 206 || resp.status === 302) {
          return target;
        }
        throw new Error(`Node ${host} returned ${resp.status}`);
      })
    );
    fastestUrl = winner;
  } catch {
    // Si la carrera en paralelo excede timeout, usar el nodo primario de baja latencia
  }

  if (res && res.setHeader) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.redirect(302, fastestUrl);
  }

  return Response.redirect(fastestUrl, 302);
}

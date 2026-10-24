// api/stream.js - Proxy y streaming de audio de alta velocidad con verificación estricta de tipo MIME y Range
import { Readable } from 'stream';

const CANDIDATE_NODES = [
  'https://yt.chocolatemoo53.com',
  'https://invidious.jing.rocks',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.protokolla.fi',
  'https://iv.ggtyler.dev',
  'https://invidious.lunar.icu'
];

async function verifyAudioStream(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Range': 'bytes=0-1024',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15'
      },
      signal: AbortSignal.timeout(2200)
    });

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isAudioOrMedia = (ct.includes('audio') || ct.includes('mp4') || ct.includes('octet-stream') || ct.includes('webm')) && !ct.includes('html') && !ct.includes('text');

    if ((res.status === 200 || res.status === 206) && isAudioOrMedia) {
      return { ok: true, url, status: res.status, contentType: ct };
    }
  } catch {}
  return { ok: false };
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const videoId = (req.query && req.query.id) || urlObj.searchParams.get('id');
  const backupIndex = parseInt((req.query && req.query.backup) || urlObj.searchParams.get('backup') || '0', 10);
  const itag = (req.query && req.query.itag) || urlObj.searchParams.get('itag') || '140';
  const directMode = (req.query && (req.query.direct === '1' || req.query.direct === 'true')) || urlObj.searchParams.get('direct') === '1';

  if (!videoId) {
    if (res && res.status) return res.status(400).json({ error: 'Falta el id de la canción' });
    return new Response(JSON.stringify({ error: 'Falta el id de la canción' }), { status: 400 });
  }

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    if (res && res.setHeader) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
      return res.status(204).end();
    }
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type, Accept'
      }
    });
  }

  // Preparar lista de candidatos rotando según backupIndex
  const rotatedNodes = [...CANDIDATE_NODES.slice(backupIndex % CANDIDATE_NODES.length), ...CANDIDATE_NODES.slice(0, backupIndex % CANDIDATE_NODES.length)];
  const candidateUrls = [];

  for (const host of rotatedNodes) {
    candidateUrls.push(`${host}/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`);
  }
  // Añadir itag 139 (AAC 48kbps) como alternativa si itag era 140
  if (itag === '140') {
    candidateUrls.push(`https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`);
  }

  let verifiedUrl = null;

  // Carrera entre los primeros nodos rápidos
  try {
    const winner = await Promise.any(
      candidateUrls.slice(0, 4).map(async (url) => {
        const check = await verifyAudioStream(url);
        if (check.ok) return check.url;
        throw new Error('Check failed');
      })
    );
    verifiedUrl = winner;
  } catch {
    // Si los primeros 4 fallan en paralelo, probar secuencialmente los restantes
    for (const url of candidateUrls.slice(4)) {
      const check = await verifyAudioStream(url);
      if (check.ok) {
        verifiedUrl = check.url;
        break;
      }
    }
  }

  // Fallback garantizado por defecto
  if (!verifiedUrl) {
    verifiedUrl = `https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`;
  }

  // Si se pide redirección directa con 302
  if (directMode) {
    if (res && res.setHeader) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.redirect(302, verifiedUrl);
    }
    return Response.redirect(verifiedUrl, 302);
  }

  // MODO PROXY STREAMING: reenviar Range y pipe de bytes directos desde freesong-pied.vercel.app
  try {
    const rangeHeader = req.headers && req.headers.range ? req.headers.range : 'bytes=0-';
    const upstreamRes = await fetch(verifiedUrl, {
      headers: {
        'Range': rangeHeader,
        'User-Agent': req.headers && req.headers['user-agent'] ? req.headers['user-agent'] : 'Mozilla/5.0'
      }
    });

    const ct = upstreamRes.headers.get('content-type') || 'audio/mp4';

    // Si el nodo devuelve HTML en el proxy, saltar a redirección
    if (ct.includes('html') || ct.includes('text')) {
      if (res && res.setHeader) return res.redirect(302, `https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`);
      return Response.redirect(`https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`, 302);
    }

    if (res && res.setHeader) {
      res.statusCode = upstreamRes.status;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
      res.setHeader('Content-Type', ct);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');

      const contentRange = upstreamRes.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);

      const contentLength = upstreamRes.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);

      if (upstreamRes.body) {
        return Readable.fromWeb(upstreamRes.body).pipe(res);
      }
      return res.end();
    }

    // Web Fetch API Response (Edge runtime)
    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
    headers.set('Content-Type', ct);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=3600');

    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) headers.set('Content-Range', contentRange);

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) headers.set('Content-Length', contentLength);

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers
    });
  } catch (proxyErr) {
    console.error('Error en proxy stream, recurriendo a 302:', proxyErr.message);
    if (res && res.setHeader) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.redirect(302, verifiedUrl);
    }
    return Response.redirect(verifiedUrl, 302);
  }
}

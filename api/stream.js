// api/stream.js - Proxy y streaming de audio de alta velocidad optimizado para Vercel Edge CDN y Safari iOS
// Cero cortes: Fragmentación de rangos a 1.5MB máx, caché Edge (86400s) y rotación de 10 nodos con fallback a itag 139
import { Readable } from 'stream';

const MAX_CHUNK = 1.5 * 1024 * 1024; // 1.5 MB por chunk para evitar límites de Vercel Hobby

const RESOLVED_STREAM_CACHE = new Map(); // videoId -> { url, itag, expires }

const CANDIDATE_NODES = [
  'https://yt.chocolatemoo53.com',
  'https://invidious.jing.rocks',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.protokolla.fi',
  'https://iv.ggtyler.dev',
  'https://invidious.lunar.icu',
  'https://invidious.private.coffee',
  'https://inv.tux.pizza',
  'https://invidious.perennialte.ch'
];

async function verifyAudioStream(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Range': 'bytes=0-1024',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15'
      },
      signal: AbortSignal.timeout(timeoutMs)
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
  let itag = (req.query && req.query.itag) || urlObj.searchParams.get('itag') || '140';
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

  // Parsear Range del cliente (iOS Safari envía típicamente 'bytes=START-' o 'bytes=START-END')
  const clientRange = req.headers && req.headers.range ? req.headers.range : 'bytes=0-';
  let startByte = 0;
  let requestedEnd = null;

  const matchRange = /bytes=(\d+)-(\d*)/.exec(clientRange);
  if (matchRange) {
    startByte = parseInt(matchRange[1], 10) || 0;
    if (matchRange[2]) {
      requestedEnd = parseInt(matchRange[2], 10);
    }
  }

  // Limitar chunk a máximo MAX_CHUNK (1.5MB) para evitar límites de Vercel y permitir caché Edge rápida
  let endByte = requestedEnd != null
    ? Math.min(requestedEnd, startByte + MAX_CHUNK - 1)
    : startByte + MAX_CHUNK - 1;

  const upstreamRangeHeader = `bytes=${startByte}-${endByte}`;

  // Preparar lista de candidatos rotando según backupIndex
  const rotatedNodes = [...CANDIDATE_NODES.slice(backupIndex % CANDIDATE_NODES.length), ...CANDIDATE_NODES.slice(0, backupIndex % CANDIDATE_NODES.length)];
  const candidateUrls = [];

  for (const host of rotatedNodes) {
    candidateUrls.push(`${host}/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`);
  }

  // Alternativas itag 139 (AAC 48k) ultraligeras si itag 140 tarda
  candidateUrls.push(`https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`);
  candidateUrls.push(`https://invidious.jing.rocks/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`);

  let verifiedUrl = null;

  // Comprobar si ya tenemos un nodo verificado en memoria para este videoId
  const cachedStream = RESOLVED_STREAM_CACHE.get(videoId);
  if (cachedStream && cachedStream.expires > Date.now() && !backupIndex) {
    verifiedUrl = cachedStream.url;
  } else {
    // Carrera rápida (máximo 2200ms) entre los primeros 8 nodos en paralelo
    try {
      const winner = await Promise.any(
        candidateUrls.slice(0, 8).map(async (url) => {
          const check = await verifyAudioStream(url, 2200);
          if (check.ok) return check.url;
          throw new Error('Check failed');
        })
      );
      verifiedUrl = winner;
      RESOLVED_STREAM_CACHE.set(videoId, { url: verifiedUrl, expires: Date.now() + 15 * 60 * 1000 });
    } catch {
      // Fallback inmediato a itag 139 rápido
      const check139 = await verifyAudioStream(`https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`, 1800);
      if (check139.ok) {
        verifiedUrl = check139.url;
        itag = '139';
        RESOLVED_STREAM_CACHE.set(videoId, { url: verifiedUrl, expires: Date.now() + 15 * 60 * 1000 });
      } else {
        verifiedUrl = `https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`;
      }
    }
  }

  // Fallback garantizado
  if (!verifiedUrl) {
    verifiedUrl = `https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`;
  }

  // Si se pide redirección directa
  if (directMode) {
    if (res && res.setHeader) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
      return res.redirect(302, verifiedUrl);
    }
    return Response.redirect(verifiedUrl, 302);
  }

  // MODO PROXY STREAMING: Solicitud de fragmento exacto <= 1.5MB
  try {
    const upstreamRes = await fetch(verifiedUrl, {
      headers: {
        'Range': upstreamRangeHeader,
        'User-Agent': req.headers && req.headers['user-agent'] ? req.headers['user-agent'] : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'
      }
    });

    const ct = upstreamRes.headers.get('content-type') || 'audio/mp4';

    // Si el nodo devolvió HTML, saltar a nodo de respaldo garantizado
    if (ct.includes('html') || ct.includes('text')) {
      const safeUrl = `https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`;
      if (res && res.setHeader) return res.redirect(302, safeUrl);
      return Response.redirect(safeUrl, 302);
    }

    if (res && res.setHeader) {
      res.statusCode = upstreamRes.status;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
      res.setHeader('Content-Type', ct);
      res.setHeader('Accept-Ranges', 'bytes');
      // Cachear en Edge CDN de Vercel por 24 horas para respuesta de 20ms en reproducciones y seeks
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400');

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
    headers.set('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400');

    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) headers.set('Content-Range', contentRange);

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) headers.set('Content-Length', contentLength);

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers
    });
  } catch (proxyErr) {
    console.error('Error en proxy stream chunk, recurriendo a 302:', proxyErr.message);
    if (res && res.setHeader) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.redirect(302, verifiedUrl);
    }
    return Response.redirect(verifiedUrl, 302);
  }
}

// api/stream.js - Proxy y streaming de audio de alta velocidad optimizado para Vercel Edge CDN y Safari iOS
// Cero cortes: Fragmentación de rangos a 1.5MB máx, arranque instantáneo directo y fallback a itag 139
import { Readable } from 'stream';

const MAX_CHUNK = 1.5 * 1024 * 1024; // 1.5 MB por chunk para evitar límites de Vercel Hobby

// Cache en memoria por proceso Serverless: videoId -> { url, expires }
const RESOLVED_STREAM_CACHE = new Map();

// Nodos vivos verificados de alta disponibilidad
const HEALTHY_NODES = [
  'https://yt.chocolatemoo53.com',
  'https://invidious.jing.rocks',
  'https://yewtu.be'
];

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
  const userAgent = (req.headers && req.headers['user-agent']) || 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15';

  // Construir lista prioritaria de URLs candidatas
  let candidateUrls = [];
  const cachedStream = RESOLVED_STREAM_CACHE.get(videoId);
  if (cachedStream && cachedStream.expires > Date.now() && !backupIndex) {
    candidateUrls.push(cachedStream.url);
  }

  const primaryHost = HEALTHY_NODES[backupIndex % HEALTHY_NODES.length];
  candidateUrls.push(`${primaryHost}/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`);

  // Fallback ultra-rápido itag 139 (48k AAC) si se pidió 140
  if (itag !== '139') {
    candidateUrls.push(`${primaryHost}/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`);
  }

  // Nodos secundarios en caso de fallo
  for (const h of HEALTHY_NODES) {
    if (h !== primaryHost) {
      candidateUrls.push(`${h}/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`);
      candidateUrls.push(`${h}/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`);
    }
  }
  candidateUrls = [...new Set(candidateUrls)];

  // Redirección directa si fue solicitada
  if (directMode) {
    const targetUrl = candidateUrls[0];
    if (res && res.setHeader) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
      return res.redirect(302, targetUrl);
    }
    return Response.redirect(targetUrl, 302);
  }

  // Streaming directo de chunk: Intentar candidatas secuencialmente con timeout estricto sin preflight redundante
  let upstreamRes = null;
  let successfulUrl = null;

  for (const url of candidateUrls) {
    try {
      const resp = await fetch(url, {
        headers: {
          'Range': upstreamRangeHeader,
          'User-Agent': userAgent
        },
        signal: AbortSignal.timeout(3200)
      });

      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const isMedia = (ct.includes('audio') || ct.includes('mp4') || ct.includes('octet-stream') || ct.includes('webm')) && !ct.includes('html') && !ct.includes('text');

      if ((resp.status === 200 || resp.status === 206) && isMedia) {
        upstreamRes = resp;
        successfulUrl = url;
        break;
      }
    } catch {
      // Probar siguiente candidato inmediatamente
    }
  }

  // Si fallaron todas las descargas directas en servidor, enviar 302 a nodo garantizado
  if (!upstreamRes || !successfulUrl) {
    const safeUrl = `https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`;
    if (res && res.setHeader) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.redirect(302, safeUrl);
    }
    return Response.redirect(safeUrl, 302);
  }

  // Guardar en caché el nodo exitoso para las siguientes peticiones de fragmentos
  RESOLVED_STREAM_CACHE.set(videoId, { url: successfulUrl, expires: Date.now() + 30 * 60 * 1000 });

  const ct = upstreamRes.headers.get('content-type') || 'audio/mp4';

  if (res && res.setHeader) {
    res.statusCode = upstreamRes.status;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400');

    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    if (upstreamRes.body) {
      const nodeStream = Readable.fromWeb(upstreamRes.body);
      nodeStream.on('error', () => {});
      res.on('close', () => {
        try { nodeStream.destroy(); } catch {}
      });
      return nodeStream.pipe(res);
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
}

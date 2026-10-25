// api/stream.js - Proxy y streaming de audio de alta velocidad optimizado para Vercel Edge CDN y Safari iOS
// Carrera paralela Promise.any() + winnerCache en memoria (15 min) + Pipe directo 0ms probe
import { Readable } from 'stream';

// Cache en memoria por proceso Serverless: videoId -> { targetUrl, expires } (15 minutos)
const winnerCache = new Map();

// Nodos vivos verificados de alta disponibilidad
const FAST_NODES = [
  'https://yt.chocolatemoo53.com',
  'https://invidious.jing.rocks',
  'https://yewtu.be',
  'https://inv.nadeko.net'
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

  // Header Range original del cliente (sin recortar artificialmente bytes=0-1 ni bytes=0-)
  const clientRange = (req.headers && req.headers.range) ? req.headers.range : 'bytes=0-';
  const userAgent = (req.headers && req.headers['user-agent']) || 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15';

  // Si se pide redirección directa
  if (directMode) {
    const directUrl = `https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`;
    if (res && res.setHeader) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
      return res.redirect(302, directUrl);
    }
    return Response.redirect(directUrl, 302);
  }

  let upstreamRes = null;
  let successfulUrl = null;

  // 1. Verificar si ya tenemos el nodo ganador en memoria para este videoId
  const cached = winnerCache.get(videoId);
  if (cached && cached.expires > Date.now() && !backupIndex) {
    try {
      const resp = await fetch(cached.targetUrl, {
        headers: {
          'Range': clientRange,
          'User-Agent': userAgent
        },
        signal: AbortSignal.timeout(3500)
      });
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const isMedia = (ct.includes('audio') || ct.includes('mp4') || ct.includes('octet-stream') || ct.includes('webm')) && !ct.includes('html') && !ct.includes('text');
      if ((resp.status === 200 || resp.status === 206) && isMedia) {
        upstreamRes = resp;
        successfulUrl = cached.targetUrl;
      } else {
        winnerCache.delete(videoId);
      }
    } catch {
      winnerCache.delete(videoId);
    }
  }

  // 2. Si no está en winnerCache o falló, carrera paralela Promise.any() entre los nodos más rápidos
  if (!upstreamRes) {
    const baseNode = FAST_NODES[backupIndex % FAST_NODES.length];
    const candidateUrls = [
      `${baseNode}/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`,
      `${baseNode}/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`
    ];
    for (const n of FAST_NODES) {
      if (n !== baseNode) {
        candidateUrls.push(`${n}/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`);
        candidateUrls.push(`${n}/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`);
      }
    }
    const top4Urls = [...new Set(candidateUrls)].slice(0, 4);

    const controllers = top4Urls.map(() => new AbortController());
    try {
      const winner = await Promise.any(
        top4Urls.map(async (url, idx) => {
          const timeoutId = setTimeout(() => {
            try { controllers[idx].abort(); } catch {}
          }, 3500);

          try {
            const resp = await fetch(url, {
              headers: {
                'Range': clientRange,
                'User-Agent': userAgent
              },
              signal: controllers[idx].signal
            });
            clearTimeout(timeoutId);

            const ct = (resp.headers.get('content-type') || '').toLowerCase();
            const isMedia = (ct.includes('audio') || ct.includes('mp4') || ct.includes('octet-stream') || ct.includes('webm')) && !ct.includes('html') && !ct.includes('text');
            if ((resp.status === 200 || resp.status === 206) && isMedia) {
              return { res: resp, idx, url };
            }
            throw new Error('Not valid media');
          } catch (e) {
            clearTimeout(timeoutId);
            throw e;
          }
        })
      );

      // Abortar únicamente los requests perdedores
      controllers.forEach((c, i) => {
        if (i !== winner.idx) {
          try { c.abort(); } catch {}
        }
      });

      upstreamRes = winner.res;
      successfulUrl = winner.url;
      winnerCache.set(videoId, { targetUrl: successfulUrl, expires: Date.now() + 15 * 60 * 1000 });
    } catch {
      // Fallback garantizado si falló la carrera
      const fallbackUrl = `https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`;
      try {
        const fbRes = await fetch(fallbackUrl, {
          headers: {
            'Range': clientRange,
            'User-Agent': userAgent
          },
          signal: AbortSignal.timeout(3500)
        });
        const ct = (fbRes.headers.get('content-type') || '').toLowerCase();
        const isMedia = (ct.includes('audio') || ct.includes('mp4') || ct.includes('octet-stream') || ct.includes('webm')) && !ct.includes('html') && !ct.includes('text');
        if ((fbRes.status === 200 || fbRes.status === 206) && isMedia) {
          upstreamRes = fbRes;
          successfulUrl = fallbackUrl;
          winnerCache.set(videoId, { targetUrl: fallbackUrl, expires: Date.now() + 15 * 60 * 1000 });
        }
      } catch {}
    }
  }

  // Si no se pudo obtener ningún stream, 302 a nodo seguro
  if (!upstreamRes) {
    const safeUrl = `https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=139&local=true`;
    if (res && res.setHeader) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.redirect(302, safeUrl);
    }
    return Response.redirect(safeUrl, 302);
  }

  // Responder con cabeceras correctas de audio y Edge CDN
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

  // Edge / Web Response fallback
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

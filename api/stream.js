// api/stream.js - Proxy de audio de alta fidelidad (SimpMusic Engine)
// Resuelve URLs directas de googlevideo vía clientes nativos móviles (IOS / ANDROID)
// Soporta AAC (itags 140/139), Opus (itags 251/250) y fallback de búsqueda automática
import { Readable } from 'stream';
import { fetchYt, getRunsText } from './_yt.js';

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const URL_TTL_MS = 30 * 60 * 1000; // 30 minutos de caché en memoria serverless
const RESOLVE_TIMEOUT_MS = 5000;
const UPSTREAM_TIMEOUT_MS = 8000;

// Clientes móviles reales con mayor tasa de éxito y sin requerimiento de PO Token para audio
const CLIENTS = [
  {
    name: 'IOS',
    id: 5,
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    context: {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      hl: 'es',
      gl: 'US'
    }
  },
  {
    name: 'ANDROID',
    id: 3,
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    context: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      osName: 'Android',
      osVersion: '11',
      androidSdkVersion: 30,
      hl: 'es',
      gl: 'US'
    }
  }
];

// Instancias Invidious de respaldo con API activa
const INVIDIOUS_NODES = [
  'https://yt.chocolatemoo53.com',
  'https://invidious.nerdvpn.de',
  'https://inv.nadeko.net'
];

const urlCache = new Map();
const CACHE_MAX = 300;

const isMediaType = (ct) => {
  ct = (ct || '').toLowerCase();
  return (ct.includes('audio') || ct.includes('mp4') || ct.includes('webm') || ct.includes('octet-stream')) && !ct.includes('html') && !ct.includes('text');
};

// Selección inteligente de formato: Prioriza AAC/MP4 para compatibilidad iOS Safari,
// pero acepta WebM Opus (itags 251, 250, 249) que YouTube siempre entrega
function pickFormat(formats, wantedItag) {
  const audios = (formats || []).filter((f) => f.url && ((f.mimeType || '').startsWith('audio/') || (f.mimeType || '').includes('video/mp4')));
  if (!audios.length) return null;

  const byItag = (n) => audios.find((f) => String(f.itag) === String(n));
  if (wantedItag && byItag(wantedItag)) return byItag(wantedItag);

  // 1. Preferir AAC MP4 (140 = 128k, 139 = 48k, 141 = 256k)
  const mp4Audio = audios.filter((f) => /^audio\/mp4/.test(f.mimeType || ''));
  if (mp4Audio.length) {
    return byItag(140) || byItag(139) || byItag(141) || mp4Audio[0];
  }

  // 2. Fallback a Opus WebM (251 = 160k, 250 = 70k, 249 = 50k)
  const opus = byItag(251) || byItag(250) || byItag(249);
  if (opus) return opus;

  // 3. Cualquier formato disponible (incluyendo muxed itag 18)
  return audios[0];
}

async function resolveWithClient(client, videoId, wantedItag) {
  const resp = await fetch(PLAYER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': client.ua,
      'X-YouTube-Client-Name': String(client.id),
      'X-YouTube-Client-Version': client.context.clientVersion
    },
    body: JSON.stringify({
      videoId,
      context: { client: client.context },
      contentCheckOk: true,
      racyCheckOk: true
    }),
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
  });

  const data = await resp.json();
  if (data.playabilityStatus?.status !== 'OK') {
    throw new Error(data.playabilityStatus?.reason || data.playabilityStatus?.status || 'not playable');
  }

  const allFormats = [
    ...(data.streamingData?.adaptiveFormats || []),
    ...(data.streamingData?.formats || [])
  ];
  const fmt = pickFormat(allFormats, wantedItag);
  if (!fmt) throw new Error('no audio format with url');

  return { url: fmt.url, ua: client.ua, itag: fmt.itag, mimeType: fmt.mimeType };
}

async function openUpstream(target, range) {
  const resp = await fetch(target.url, {
    headers: { Range: range, 'User-Agent': target.ua },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  if ((resp.status === 200 || resp.status === 206) && isMediaType(resp.headers.get('content-type'))) {
    return resp;
  }
  try { await resp.body?.cancel(); } catch {}
  throw new Error(`upstream status ${resp.status}`);
}

// Búsqueda automática de canción alternativa si un videoId específico está bloqueado o caído
async function findAlternativeVideoId(title, artist) {
  if (!title) return null;
  const q = `${title} ${artist || ''}`.trim();
  try {
    const data = await fetchYt('search', {
      query: q,
      params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D'
    });
    const secList = data.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    for (const s of secList) {
      const list = s.musicShelfRenderer?.contents || [];
      for (const it of list) {
        const r = it.musicResponsiveListItemRenderer;
        if (!r) continue;
        const titleRun = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0];
        const vid = titleRun?.navigationEndpoint?.watchEndpoint?.videoId;
        if (vid) return vid;
      }
    }
  } catch {}
  return null;
}

async function invidiousFallback(videoId, itag, range) {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15';
  const controllers = INVIDIOUS_NODES.map(() => new AbortController());
  const winner = await Promise.any(
    INVIDIOUS_NODES.map(async (node, i) => {
      const timer = setTimeout(() => controllers[i].abort(), 3500);
      try {
        const resp = await fetch(`${node}/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`, {
          headers: { Range: range, 'User-Agent': ua },
          signal: controllers[i].signal
        });
        if ((resp.status === 200 || resp.status === 206) && isMediaType(resp.headers.get('content-type'))) {
          return { resp, i };
        }
        try { await resp.body?.cancel(); } catch {}
        throw new Error('invalid media');
      } finally {
        clearTimeout(timer);
      }
    })
  );
  controllers.forEach((c, i) => { if (i !== winner.i) { try { c.abort(); } catch {} } });
  return winner.resp;
}

async function getUpstream(videoId, itag, range, backupIndex, title = '', artist = '') {
  const cacheKey = `${videoId}:${itag}`;

  // 1. Caché en memoria
  const cached = urlCache.get(cacheKey);
  if (cached && cached.expires > Date.now() && !backupIndex) {
    try {
      return await openUpstream(cached, range);
    } catch {
      urlCache.delete(cacheKey);
    }
  }

  // 2. Resolver con clientes nativos (IOS y ANDROID)
  for (const client of CLIENTS) {
    try {
      const target = await resolveWithClient(client, videoId, itag);
      const resp = await openUpstream(target, range);
      if (urlCache.size >= CACHE_MAX) urlCache.delete(urlCache.keys().next().value);
      urlCache.set(cacheKey, { ...target, expires: Date.now() + URL_TTL_MS });
      return resp;
    } catch (e) {
      console.warn(`[stream] ${client.name} falló para ${videoId}: ${e.message}`);
    }
  }

  // 3. Fallback inteligente: buscar versión alternativa de la canción si el ID original falló
  if (title || artist) {
    try {
      const altVideoId = await findAlternativeVideoId(title, artist);
      if (altVideoId && altVideoId !== videoId) {
        console.log(`[stream] Fallback a versión alternativa: ${videoId} -> ${altVideoId}`);
        for (const client of CLIENTS) {
          try {
            const target = await resolveWithClient(client, altVideoId, itag);
            const resp = await openUpstream(target, range);
            urlCache.set(`${altVideoId}:${itag}`, { ...target, expires: Date.now() + URL_TTL_MS });
            return resp;
          } catch {}
        }
      }
    } catch {}
  }

  // 4. Último recurso: Invidious
  try {
    return await invidiousFallback(videoId, itag, range);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const param = (k) => (req.query && req.query[k]) || urlObj.searchParams.get(k);
  const videoId = param('id');
  const itag = String(param('itag') || '140').replace(/\D/g, '') || '140';
  const backupIndex = Math.max(0, parseInt(param('backup') || '0', 10) || 0);
  const title = param('title') || '';
  const artist = param('artist') || '';

  const node = !!(res && res.setHeader);
  const json = (status, body) => node
    ? (res.statusCode = status, res.setHeader('Content-Type', 'application/json'), res.setHeader('Access-Control-Allow-Origin', '*'), res.end(JSON.stringify(body)))
    : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  if (req.method === 'OPTIONS') {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type, Accept'
    };
    if (node) {
      Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
      res.statusCode = 204;
      return res.end();
    }
    return new Response(null, { status: 204, headers: cors });
  }

  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) {
    return json(400, { error: 'Falta el id de la canción o es inválido' });
  }

  const range = (req.headers && req.headers.range) || 'bytes=0-';
  const upstream = await getUpstream(videoId, itag, range, backupIndex, title, artist);
  if (!upstream) {
    return json(502, { error: 'No se pudo obtener el audio de esta canción', code: 'STREAM_UNAVAILABLE' });
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Content-Type': upstream.headers.get('content-type') || 'audio/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    Vary: 'Range'
  };

  const contentRange = upstream.headers.get('content-range');
  if (contentRange) headers['Content-Range'] = contentRange;
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) headers['Content-Length'] = contentLength;

  if (node) {
    res.statusCode = upstream.status;
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    if (req.method === 'HEAD' || !upstream.body) {
      try { await upstream.body?.cancel(); } catch {}
      return res.end();
    }
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => {});
    if (typeof res.on === 'function') {
      res.on('close', () => { try { nodeStream.destroy(); } catch {} });
      return nodeStream.pipe(res);
    }
    for await (const chunk of nodeStream) {
      if (typeof res.write === 'function') res.write(chunk);
    }
    return res.end();
  }

  return new Response(req.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
}

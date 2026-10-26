// api/stream.js - Proxy de audio de alta fidelidad (SimpMusic Engine)
// Resuelve URLs directas de googlevideo vía clientes nativos móviles (IOS / ANDROID)
// Soporta AAC (itags 140/139), Opus (itags 251/250) y fallback de búsqueda automática
import { Readable } from 'stream';
import { fetchYt, getRunsText } from './_yt.js';

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const URL_TTL_MS = 30 * 60 * 1000; // 30 minutos de caché en memoria serverless
const RESOLVE_TIMEOUT_MS = 2500;
const UPSTREAM_TIMEOUT_MS = 3000;

// Clientes móviles reales con mayor tasa de éxito (SimpMusic Engine)
const CLIENTS = [
  {
    name: 'ANDROID',
    id: 3,
    ua: 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip',
    context: {
      clientName: 'ANDROID',
      clientVersion: '21.26.364',
      osName: 'Android',
      osVersion: '11',
      hl: 'es',
      gl: 'US'
    }
  },
  {
    name: 'IOS',
    id: 5,
    ua: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)',
    context: {
      clientName: 'IOS',
      clientVersion: '19.45.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '17.5.1.21F90',
      hl: 'es',
      gl: 'US'
    }
  }
];

const urlCache = new Map();
const CACHE_MAX = 300;

const isMediaType = (ct) => {
  ct = (ct || '').toLowerCase();
  return (ct.includes('audio') || ct.includes('mp4') || ct.includes('webm') || ct.includes('octet-stream')) && !ct.includes('html') && !ct.includes('text');
};

// Selección inteligente de formato (SimpMusic Engine Strategy):
// 1. Prioriza itag 18 (MP4 con audio AAC estéreo a 44.1kHz).
//    Es el formato progresivo móvil de YouTube que NO se corta a 1MB con error 403.
// 2. Fallback a AAC adaptativo (itags 140 / 139) y WebM Opus (itags 251 / 250).
function pickFormat(formats, wantedItag) {
  const audios = (formats || []).filter((f) => f.url && ((f.mimeType || '').startsWith('audio/') || (f.mimeType || '').includes('video/mp4')));
  if (!audios.length) return null;

  const byItag = (n) => audios.find((f) => String(f.itag) === String(n));
  const f18 = byItag(18);

  // 1. Formato universal no estrangulado: itag 18 (MP4 progresivo con audio AAC-LC estéreo 44.1kHz).
  if (f18 && (!wantedItag || wantedItag === '18' || wantedItag === '140')) {
    return f18;
  }

  // 2. Si se pide explícitamente otro itag disponible (ej. ahorro de datos 139 o 251):
  if (wantedItag && byItag(wantedItag)) {
    return byItag(wantedItag);
  }

  if (f18) return f18;

  // 3. AAC MP4 adaptativo (140 = 128k, 139 = 48k, 141 = 256k)
  const mp4Audio = audios.filter((f) => /^audio\/mp4/.test(f.mimeType || ''));
  if (mp4Audio.length) {
    return byItag(140) || byItag(139) || byItag(141) || mp4Audio[0];
  }

  // 4. Opus WebM (251 = 160k, 250 = 70k, 249 = 50k)
  const opus = byItag(251) || byItag(250) || byItag(249);
  if (opus) return opus;

  // 5. Cualquier formato de audio disponible
  return audios[0];
}

let cachedCookies = '';
let cookieExpiry = 0;

async function getVisitorCookies() {
  if (cachedCookies && cookieExpiry > Date.now()) return cachedCookies;
  try {
    const res = await fetch('https://www.youtube.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(2000)
    });
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    if (raw && raw.length) {
      cachedCookies = raw.map(c => (c || '').split(';')[0]).filter(Boolean).join('; ');
      cookieExpiry = Date.now() + 6 * 3600 * 1000; // 6 horas
      return cachedCookies;
    }
  } catch {}
  return '';
}

let cachedVisitorData = '';
let visitorExpiry = 0;

async function getVisitorData() {
  if (cachedVisitorData && visitorExpiry > Date.now()) return cachedVisitorData;
  try {
    const swRes = await fetch('https://music.youtube.com/sw.js_data', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(2000)
    });
    const swText = await swRes.text();
    const match = swText.match(/"(Cg[stuv][A-Za-z0-9_%-]{15,})"/);
    if (match) {
      cachedVisitorData = decodeURIComponent(match[1]);
      visitorExpiry = Date.now() + 6 * 3600 * 1000; // 6 horas
      return cachedVisitorData;
    }
  } catch (e) {
    console.warn('[stream] visitorData fetch failed:', e.message);
  }
  return '';
}

async function resolveWithClient(client, videoId, wantedItag) {
  const [visitorData, cookies] = await Promise.all([getVisitorData(), getVisitorCookies()]);
  const clientContext = {
    ...client.context,
    ...(visitorData ? { visitorData } : {})
  };

  const resp = await fetch(PLAYER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': client.ua,
      'X-YouTube-Client-Name': String(client.id),
      'X-YouTube-Client-Version': client.context.clientVersion,
      ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
      ...(cookies ? { Cookie: cookies } : {})
    },
    body: JSON.stringify({
      videoId,
      context: { client: clientContext },
      contentCheckOk: true,
      racyCheckOk: true
    }),
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
  });

  const data = await resp.json();
  if (data.playabilityStatus?.status !== 'OK') {
    const err = new Error(data.playabilityStatus?.reason || data.playabilityStatus?.status || 'not playable');
    err.isDead = (data.playabilityStatus?.status === 'ERROR' || data.playabilityStatus?.status === 'UNPLAYABLE');
    throw err;
  }

  const allFormats = [
    ...(data.streamingData?.formats || []),
    ...(data.streamingData?.adaptiveFormats || [])
  ];
  const fmt = pickFormat(allFormats, wantedItag);
  if (!fmt) throw new Error('no audio format with url');

  return { url: fmt.url, ua: client.ua, itag: fmt.itag, mimeType: fmt.mimeType };
}

async function openUpstream(target, range) {
  const cookies = await getVisitorCookies();
  const resp = await fetch(target.url, {
    headers: {
      Range: range,
      'User-Agent': target.ua,
      ...(cookies ? { Cookie: cookies } : {})
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  if ((resp.status === 200 || resp.status === 206) && isMediaType(resp.headers.get('content-type'))) {
    return resp;
  }
  try { await resp.body?.cancel(); } catch {}
  throw new Error(`upstream status ${resp.status}`);
}

// Búsqueda automática de canción alternativa si un videoId específico está bloqueado o caído
async function findAlternativeVideoId(title, artist, originalId) {
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
        if (vid && vid !== originalId) return vid;
      }
    }
  } catch {}
  return null;
}

async function getUpstream(videoId, itag, range, backupIndex, title = '', artist = '') {
  const cacheKey = `${videoId}:${itag}`;
  const errors = [];

  // 1. Caché en memoria
  const cached = urlCache.get(cacheKey);
  if (cached && cached.expires > Date.now() && !backupIndex) {
    try {
      return { upstream: await openUpstream(cached, range), errors };
    } catch (e) {
      errors.push(`cache failed: ${e.message}`);
      urlCache.delete(cacheKey);
    }
  }

  // 2. Resolver con clientes nativos (ANDROID y luego IOS)
  for (const client of CLIENTS) {
    try {
      const target = await resolveWithClient(client, videoId, itag);
      const resp = await openUpstream(target, range);
      if (urlCache.size >= CACHE_MAX) urlCache.delete(urlCache.keys().next().value);
      urlCache.set(cacheKey, { ...target, expires: Date.now() + URL_TTL_MS });
      return { upstream: resp, errors };
    } catch (e) {
      errors.push(`${client.name}: ${e.message}`);
      console.warn(`[stream] ${client.name} falló para ${videoId}: ${e.message}`);
      if (e.isDead) break;
    }
  }

  // 3. Fallback inteligente inmediato: buscar versión alternativa si el ID original falló
  if (title || artist) {
    try {
      const altVideoId = await findAlternativeVideoId(title, artist, videoId);
      if (altVideoId && altVideoId !== videoId) {
        errors.push(`alt found: ${altVideoId}`);
        for (const client of CLIENTS) {
          try {
            const target = await resolveWithClient(client, altVideoId, itag);
            const resp = await openUpstream(target, range);
            urlCache.set(`${altVideoId}:${itag}`, { ...target, expires: Date.now() + URL_TTL_MS });
            return { upstream: resp, errors };
          } catch (e) {
            errors.push(`alt ${client.name}: ${e.message}`);
          }
        }
      } else {
        errors.push(`alt not found or same as original`);
      }
    } catch (e) {
      errors.push(`alt search error: ${e.message}`);
    }
  }

  return { upstream: null, errors };
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const param = (k) => (req.query && req.query[k]) || urlObj.searchParams.get(k);
  const videoId = param('id');
  const itag = String(param('itag') || '18').replace(/\D/g, '') || '18';
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

  // Limitar el tamaño de fragmento a 512 KB (aprox. 32 segs de audio).
  // Esto garantiza que cada petición en Vercel responda en <150ms y termine limpiamente
  // evitando el timeout de 10s de Vercel y evitando el bloqueo de Google en rangos abiertos.
  const CHUNK_SIZE = 512 * 1024; // 512 KB
  const rawRange = (req.headers && req.headers.range) || 'bytes=0-';
  const rangeMatch = rawRange.match(/bytes=(\d+)-(\d+)?/);
  const startByte = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;
  let endByte = rangeMatch && rangeMatch[2] ? parseInt(rangeMatch[2], 10) : (startByte + CHUNK_SIZE - 1);
  if (endByte - startByte + 1 > CHUNK_SIZE) {
    endByte = startByte + CHUNK_SIZE - 1;
  }
  const boundedRange = req.method === 'HEAD' ? 'bytes=0-1' : `bytes=${startByte}-${endByte}`;

  const { upstream, errors } = await getUpstream(videoId, itag, boundedRange, backupIndex, title, artist);
  if (!upstream) {
    return json(502, { error: 'No se pudo obtener el audio de esta canción', code: 'STREAM_UNAVAILABLE', details: errors });
  }

  const rawType = (upstream.headers.get('content-type') || '').toLowerCase();
  const contentType = rawType.includes('webm') ? 'audio/webm' : 'audio/mp4';

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Content-Type': contentType,
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

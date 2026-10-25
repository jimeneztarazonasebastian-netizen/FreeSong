// api/stream.js - Proxy de audio. Resuelve la URL directa de googlevideo vía el endpoint
// interno /youtubei/v1/player (clientes ANDROID_VR / IOS / ANDROID) y la sirve con soporte Range.
// Invidious queda solo como último recurso (los nodos públicos caen a menudo).
import { Readable } from 'stream';

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const URL_TTL_MS = 20 * 60 * 1000; // las URLs de googlevideo duran ~6 h; renovamos antes
const RESOLVE_TIMEOUT_MS = 4000;
const UPSTREAM_TIMEOUT_MS = 6000;
const FALLBACK_TIMEOUT_MS = 5000; // Invidious cuelga mucho: no esperar más que esto

// Orden de clientes: los que devuelven URLs sin firma ni PO token
const CLIENTS = [
  {
    name: 'ANDROID_VR',
    id: 28,
    ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    context: { clientName: 'ANDROID_VR', clientVersion: '1.60.19', deviceMake: 'Oculus', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12L', androidSdkVersion: 32, hl: 'en', gl: 'US' }
  },
  {
    name: 'IOS',
    id: 5,
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    context: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', gl: 'US' }
  },
  {
    name: 'ANDROID',
    id: 3,
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    context: { clientName: 'ANDROID', clientVersion: '20.10.38', osName: 'Android', osVersion: '11', androidSdkVersion: 30, hl: 'en', gl: 'US' }
  }
];

// Último recurso: instancias Invidious públicas (se prueban en paralelo, 1.er válido gana)
const INVIDIOUS_NODES = [
  'https://yt.chocolatemoo53.com',
  'https://yewtu.be',
  'https://invidious.jing.rocks',
  'https://inv.nadeko.net'
];

// Por proceso serverless: `${videoId}:${itag}` -> { url, ua, expires }
const urlCache = new Map();
const CACHE_MAX = 200;

const isMediaType = (ct) => {
  ct = (ct || '').toLowerCase();
  return (ct.includes('audio') || ct.includes('mp4') || ct.includes('octet-stream') || ct.includes('webm')) && !ct.includes('html') && !ct.includes('text');
};

// Safari/iOS solo reproduce bien AAC en MP4: 140 (128k) y 139 (48k) primero, 141 si existe
function pickFormat(formats, wantedItag) {
  const audio = (formats || []).filter((f) => f.url && /^audio\/mp4/.test(f.mimeType || ''));
  if (!audio.length) return null;
  const byItag = (n) => audio.find((f) => String(f.itag) === String(n));
  return byItag(wantedItag) || byItag(140) || byItag(139) || byItag(141) || audio[0];
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
    body: JSON.stringify({ videoId, context: { client: client.context }, contentCheckOk: true, racyCheckOk: true }),
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
  });
  const data = await resp.json();
  if (data.playabilityStatus?.status !== 'OK') {
    throw new Error(data.playabilityStatus?.reason || data.playabilityStatus?.status || 'not playable');
  }
  const fmt = pickFormat(data.streamingData?.adaptiveFormats, wantedItag);
  if (!fmt) throw new Error('no audio format');
  return { url: fmt.url, ua: client.ua, itag: fmt.itag };
}

// Abre la URL resuelta reenviando el Range del cliente. Devuelve la Response o lanza.
async function openUpstream(target, range) {
  const resp = await fetch(target.url, {
    headers: { Range: range, 'User-Agent': target.ua },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  if ((resp.status === 200 || resp.status === 206) && isMediaType(resp.headers.get('content-type'))) return resp;
  try { await resp.body?.cancel(); } catch {}
  throw new Error(`upstream ${resp.status}`);
}

async function invidiousFallback(videoId, itag, range) {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15';
  const controllers = INVIDIOUS_NODES.map(() => new AbortController());
  const winner = await Promise.any(
    INVIDIOUS_NODES.map(async (node, i) => {
      const timer = setTimeout(() => controllers[i].abort(), FALLBACK_TIMEOUT_MS);
      try {
        const resp = await fetch(`${node}/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`, {
          headers: { Range: range, 'User-Agent': ua },
          signal: controllers[i].signal
        });
        if ((resp.status === 200 || resp.status === 206) && isMediaType(resp.headers.get('content-type'))) return { resp, i };
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

// Devuelve la Response de audio de upstream (o null si todo falló)
async function getUpstream(videoId, itag, range, backupIndex) {
  const cacheKey = `${videoId}:${itag}`;

  // 1. URL ya resuelta (se salta si el cliente pide un backup: la anterior pudo fallar)
  const cached = urlCache.get(cacheKey);
  if (cached && cached.expires > Date.now() && !backupIndex) {
    try {
      return await openUpstream(cached, range);
    } catch {
      urlCache.delete(cacheKey);
    }
  }

  // 2. Los clientes de YouTube en paralelo: gana el primero que entrega audio.
  //    Si YouTube bloquea la IP, los tres fallan en menos de 1 s y pasamos al respaldo.
  try {
    const { resp, target } = await Promise.any(
      CLIENTS.map(async (client) => {
        try {
          const target = await resolveWithClient(client, videoId, itag);
          return { resp: await openUpstream(target, range), target };
        } catch (e) {
          console.warn(`[stream] ${client.name} falló para ${videoId}: ${e.message}`);
          throw e;
        }
      })
    );
    if (urlCache.size >= CACHE_MAX) urlCache.delete(urlCache.keys().next().value);
    urlCache.set(cacheKey, { ...target, expires: Date.now() + URL_TTL_MS });
    return resp;
  } catch {
    // todos los clientes fallaron
  }

  // 3. Invidious: lento y con resultado fijo por canción, solo se intenta en la primera petición.
  //    Los reintentos del cliente (backup > 0) solo repiten los clientes de YouTube, que fallan rápido.
  if (backupIndex > 0) return null;
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

  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) return json(400, { error: 'Falta el id de la canción o es inválido' });

  const range = (req.headers && req.headers.range) || 'bytes=0-';
  const upstream = await getUpstream(videoId, itag, range, backupIndex);
  if (!upstream) return json(502, { error: 'No se pudo obtener el audio de esta canción', code: 'STREAM_UNAVAILABLE' });

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Content-Type': upstream.headers.get('content-type') || 'audio/mp4',
    'Accept-Ranges': 'bytes',
    // Caché corto: las URLs de origen caducan, el audio en sí no cambia
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
    res.on('close', () => { try { nodeStream.destroy(); } catch {} });
    return nodeStream.pipe(res);
  }

  return new Response(req.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
}

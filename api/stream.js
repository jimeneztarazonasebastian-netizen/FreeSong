// api/stream.js - Proxy de audio de alta fidelidad (SimpMusic Engine)
// Resuelve URLs directas de googlevideo vía clientes nativos móviles (IOS / ANDROID)
// Soporta AAC (itags 140/139), Opus (itags 251/250) y fallback de búsqueda automática
import { Readable } from 'stream';
import { fetchYt, getRunsText, normalizeCookieInput } from './_yt.js';
import { resolveMwebAudio } from './_hls.js';

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const URL_TTL_MS = 30 * 60 * 1000; // 30 minutos de caché en memoria serverless
const RESOLVE_TIMEOUT_MS = 4000;
const UPSTREAM_TIMEOUT_MS = 8000; // solo para esperar cabeceras; el cuerpo no se aborta
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // no repetir fallos de cookies/visitorData en cada petición

// Clientes móviles reales con mayor tasa de éxito (SimpMusic Engine)
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
  // Clientes alternativos: cuando YouTube marca la IP del servidor como bot,
  // algunos de estos siguen entregando el audio sin cookies.
  {
    name: 'ANDROID_VR',
    id: 28,
    ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip',
    context: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12',
      androidSdkVersion: 32,
      hl: 'es',
      gl: 'US'
    }
  }
];

const urlCache = new Map();
const CACHE_MAX = 300;
// Varias peticiones de rango del mismo tema llegan a la vez (Safari pide 2-3 rangos
// en paralelo). Reutiliza la misma resolución en curso en vez de llamar a YouTube N veces.
const pendingResolves = new Map();

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
let cookiesRetryAt = 0;
let cookiesPromise = null;

function getVisitorCookies() {
  const envCookie = normalizeCookieInput(process.env.YOUTUBE_COOKIE);
  if (envCookie) return Promise.resolve(envCookie);
  if (cachedCookies && cookieExpiry > Date.now()) return Promise.resolve(cachedCookies);
  if (cookiesPromise) return cookiesPromise;
  if (cookiesRetryAt > Date.now()) return Promise.resolve('');

  cookiesPromise = (async () => {
    try {
      const res = await fetch('https://www.youtube.com', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(3000)
      });
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
      const joined = (raw || []).map(c => (c || '').split(';')[0]).filter(Boolean).join('; ');
      if (joined) {
        cachedCookies = joined;
        cookieExpiry = Date.now() + 6 * 3600 * 1000; // 6 horas
        return cachedCookies;
      }
    } catch {}
    // Sin cookies no pasa nada: no vuelvas a pedirlas en cada fragmento de audio.
    cookiesRetryAt = Date.now() + NEGATIVE_TTL_MS;
    return '';
  })().finally(() => { cookiesPromise = null; });

  return cookiesPromise;
}

let cachedVisitorData = '';
let visitorExpiry = 0;
let visitorRetryAt = 0;
let visitorPromise = null;
// visitorData público de respaldo: si Vercel no puede leerlo (YouTube bloquea
// la descarga de sw.js_data), la API de player al menos no recibe un contexto vacío.
const FALLBACK_VISITOR_DATA = 'CgttZGswTS1XRDZSZyi0yo_XBjIKCgJDTxIEGgAgH2KpAgqmAkN0a0JDQVVT';

function getVisitorData() {
  if (cachedVisitorData && visitorExpiry > Date.now()) return Promise.resolve(cachedVisitorData);
  if (visitorPromise) return visitorPromise;
  if (visitorRetryAt > Date.now()) return Promise.resolve(FALLBACK_VISITOR_DATA);

  visitorPromise = (async () => {
    try {
      const swRes = await fetch('https://music.youtube.com/sw.js_data', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(3000)
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
    visitorRetryAt = Date.now() + NEGATIVE_TTL_MS;
    return FALLBACK_VISITOR_DATA;
  })().finally(() => { visitorPromise = null; });

  return visitorPromise;
}


function resolveWithClient(client, videoId, wantedItag) {
  const dedupeKey = `${client.name}:${videoId}:${wantedItag || ''}`;
  const pending = pendingResolves.get(dedupeKey);
  if (pending) return pending;

  const task = (async () => {
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
        Origin: 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/',
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
  })();

  pendingResolves.set(dedupeKey, task);
  task.finally(() => pendingResolves.delete(dedupeKey)).catch(() => {});
  return task;
}

// Comparte la resolución MWEB en curso entre los rangos que Safari pide a la vez.
function resolveMweb(videoId, wantedItag) {
  const dedupeKey = `MWEB:${videoId}:${wantedItag || ''}`;
  const pending = pendingResolves.get(dedupeKey);
  if (pending) return pending;
  const task = resolveMwebAudio(videoId, wantedItag);
  pendingResolves.set(dedupeKey, task);
  task.finally(() => pendingResolves.delete(dedupeKey)).catch(() => {});
  return task;
}

async function openUpstream(target, range) {
  // La URL de MWEB ya va firmada: enviarle la cookie de la cuenta solo la infla.
  const cookies = target.noCookie ? '' : await getVisitorCookies();
  // El timeout solo debe cubrir la espera de cabeceras. Antes abortaba también
  // el cuerpo a los 3 s y cortaba fragmentos de audio en conexiones lentas.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(target.url, {
      headers: {
        Range: range,
        'User-Agent': target.ua,
        ...(cookies ? { Cookie: cookies } : {})
      },
      signal: controller.signal
    });
    if ((resp.status === 200 || resp.status === 206) && isMediaType(resp.headers.get('content-type'))) {
      clearTimeout(timeout);
      return resp;
    }
    clearTimeout(timeout);
    try { await resp.body?.cancel(); } catch {}
    throw new Error(`upstream status ${resp.status}`);
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
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

  // 2. MWEB: acepta la cookie de sesión y su URL de audio no exige PO token,
  // así que funciona desde la IP de Vercel donde los clientes móviles se bloquean.
  try {
    const target = await resolveMweb(videoId, itag);
    const resp = await openUpstream(target, range);
    if (urlCache.size >= CACHE_MAX) urlCache.delete(urlCache.keys().next().value);
    urlCache.set(cacheKey, { ...target, expires: Date.now() + URL_TTL_MS });
    return { upstream: resp, errors };
  } catch (e) {
    errors.push(`MWEB: ${e.message}`);
    console.warn(`[stream] MWEB falló para ${videoId}: ${e.message}`);
  }

  // 3. Resolver con clientes nativos (ANDROID y luego IOS)
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
    }
  }

  // 3. Fallback inteligente inmediato: buscar versión alternativa si el ID original falló
  if (title || artist) {
    try {
      const altVideoId = await findAlternativeVideoId(title, artist, videoId);
      if (altVideoId && altVideoId !== videoId) {
        errors.push(`alt found: ${altVideoId}`);
        try {
          const target = await resolveMweb(altVideoId, itag);
          const resp = await openUpstream(target, range);
          urlCache.set(`${altVideoId}:${itag}`, { ...target, expires: Date.now() + URL_TTL_MS });
          return { upstream: resp, errors };
        } catch (e) {
          errors.push(`alt MWEB: ${e.message}`);
        }
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

function serveBuffer(buffer, req, res, node, startByte, endByte, full) {
  const total = buffer.length;
  let start = Number.isFinite(startByte) && startByte > 0 ? startByte : 0;
  if (start >= total) start = 0;
  let end = full ? total - 1 : Math.min(endByte, total - 1);
  if (!Number.isFinite(end) || end < start) end = total - 1;
  const slice = buffer.subarray(start, end + 1);

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Content-Type': 'audio/aac',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    Vary: 'Range'
  };

  if (req.method === 'HEAD') {
    headers['Content-Length'] = String(total);
    if (node) {
      res.statusCode = 200;
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.end();
    }
    return new Response(null, { status: 200, headers });
  }

  headers['Content-Length'] = String(slice.length);
  headers['Content-Range'] = `bytes ${start}-${end}/${total}`;

  if (node) {
    res.statusCode = 206;
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    return res.end(slice);
  }
  return new Response(slice, { status: 206, headers });
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const param = (k) => (req.query && req.query[k]) || urlObj.searchParams.get(k);
  const videoId = param('id');
  const itag = String(param('itag') || '18').replace(/\D/g, '') || '18';
  const backupIndex = Math.max(0, parseInt(param('backup') || '0', 10) || 0);
  const title = param('title') || '';
  const artist = param('artist') || '';
  // full=1 se usa para descargas: devuelve la pista completa en vez de un fragmento.
  const full = param('full') === '1' || param('full') === 'true';

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
  // Con full=1 (descargas) se pide la pista completa de una sola vez.
  const CHUNK_SIZE = 512 * 1024; // 512 KB
  const rawRange = (req.headers && req.headers.range) || 'bytes=0-';
  const rangeMatch = rawRange.match(/bytes=(\d+)-(\d+)?/);
  const startByte = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;
  let endByte = rangeMatch && rangeMatch[2] ? parseInt(rangeMatch[2], 10) : (startByte + CHUNK_SIZE - 1);
  if (!full && endByte - startByte + 1 > CHUNK_SIZE) {
    endByte = startByte + CHUNK_SIZE - 1;
  }
  const boundedRange = req.method === 'HEAD'
    ? 'bytes=0-1'
    : (full ? ((req.headers && req.headers.range) || 'bytes=0-') : `bytes=${startByte}-${endByte}`);

  const { upstream, buffer, errors } = await getUpstream(videoId, itag, boundedRange, backupIndex, title, artist);

  if (buffer) {
    return serveBuffer(buffer, req, res, node, startByte, endByte, full);
  }

  if (!upstream) {
    const [vd, ck] = await Promise.all([getVisitorData(), getVisitorCookies()]);
    return json(502, {
      error: 'No se pudo obtener el audio de esta canción',
      code: 'STREAM_UNAVAILABLE',
      details: errors,
      debug: { visitorData: vd ? vd.length : 0, cookies: ck ? ck.length : 0, cookieConfigured: !!process.env.YOUTUBE_COOKIE }
    });
  }

  const rawType = (upstream.headers.get('content-type') || '').toLowerCase();
  const contentType = rawType.includes('webm') ? 'audio/webm' : 'audio/mp4';

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': full ? 'private, max-age=0, no-store' : 'public, max-age=3600, s-maxage=3600',
    Vary: 'Range'
  };

  const contentRange = upstream.headers.get('content-range');
  const contentLength = upstream.headers.get('content-length');
  const totalBytes = parseInt((contentRange || '').split('/')[1] || '', 10) || 0;

  if (req.method === 'HEAD' && totalBytes > 0) {
    // Un HEAD debe describir el recurso completo; Safari lo usa antes de pedir rangos.
    headers['Content-Length'] = String(totalBytes);
  } else {
    if (contentRange) headers['Content-Range'] = contentRange;
    if (contentLength) headers['Content-Length'] = contentLength;
  }

  if (node) {
    res.statusCode = req.method === 'HEAD' ? 200 : upstream.status;
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

  return new Response(req.method === 'HEAD' ? null : upstream.body, {
    status: req.method === 'HEAD' ? 200 : upstream.status,
    headers
  });
}

// api/stream.js - Proxy de audio de alta fidelidad (SimpMusic Engine)
// Resuelve URLs directas de googlevideo vía clientes nativos móviles (IOS / ANDROID)
// Soporta AAC (itags 140/139), Opus (itags 251/250) y fallback de búsqueda automática
import { Readable } from 'stream';
import { fetchYt, getRunsText, normalizeCookieInput, parseDuration } from './_yt.js';
import { getAudioBuffer, getCookie, resolveMwebAudio } from './_hls.js';
import { fetchBrowserRelayMedia, parseBrowserRelayMedia, resolveRelayAudio, relayInstances } from './_relay.js';

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
export function pickFormat(formats, wantedItag, audioOnly = false) {
  const audios = (formats || []).filter((f) => f.url && (
    (f.mimeType || '').startsWith('audio/') || (!audioOnly && (
      (f.mimeType || '').includes('video/mp4') &&
      (String(f.itag) === '18' || f.audioQuality || Number(f.audioChannels) > 0)
    ))
  ));
  if (!audios.length) return null;

  const byItag = (n) => audios.find((f) => String(f.itag) === String(n));
  const f18 = byItag(18);

  // 1. Formato universal no estrangulado: itag 18 (MP4 progresivo con audio AAC-LC estéreo 44.1kHz).
  //    En descargas (audioOnly) se evita porque incluye vídeo y pesa el doble.
  if (f18 && !audioOnly && (!wantedItag || wantedItag === '18' || wantedItag === '140')) {
    return f18;
  }

  // 2. Si se pide explícitamente otro itag disponible (ej. ahorro de datos 139 o 251):
  if (wantedItag && byItag(wantedItag)) {
    return byItag(wantedItag);
  }

  if (f18 && !audioOnly) return f18;

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


function resolveWithClient(client, videoId, wantedItag, audioOnly = false) {
  const dedupeKey = `${client.name}:${videoId}:${wantedItag || ''}:${audioOnly ? 'a' : 'v'}`;
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
    const fmt = pickFormat(allFormats, wantedItag, audioOnly);
    if (!fmt) throw new Error('no audio format with url');

    return { url: fmt.url, ua: client.ua, itag: fmt.itag, mimeType: fmt.mimeType };
  })();

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
    // Un rango fuera del archivo no es un fallo del proveedor. Buscar otra
    // fuente o volver al byte cero rompería el seek y las descargas.
    if (resp.status === 416 && /^bytes \*\/\d+$/.test(resp.headers.get('content-range') || '')) {
      clearTimeout(timeout);
      return resp;
    }
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

// Búsqueda automática de canción alternativa si un videoId específico está bloqueado o caído.
// IMPORTANTE: solo se acepta un resultado que sea REALMENTE la misma canción.
// Antes se devolvía el primer resultado distinto y eso reproducía otra pista
// (p. ej. buscar "Candy Plan B" terminaba sirviendo "Sexo, Sudor y Calor").
const TITLE_VARIANTS_RE = /\b(remix|cover|live|en vivo|sped up|slowed|reverb|instrumental|karaoke|tribute|parody|letra|lyrics|lyric)\b/i;
const TITLE_NOISE_RE = /\b(official|videoclip|video|audio|visualizer|lyric|lyrics|letra|hd|hq|4k|8k|remaster(?:ed)?|version)\b/gi;
const RELAY_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15';

function normalizeSongText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function coreSongTitle(value) {
  // Quita aclaraciones entre paréntesis/corchetes ("Official Video", "Remix")
  // y palabras de relleno habituales. El núcleo debe coincidir exactamente.
  const withoutBrackets = String(value || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  return normalizeSongText(withoutBrackets.replace(TITLE_NOISE_RE, ' '));
}

function isSameSongCandidate(candidateTitle, candidateArtist, title, artist, candidateDuration, duration) {
  const candidateCore = coreSongTitle(candidateTitle);
  const originalCore = coreSongTitle(title);
  const artistCore = coreSongTitle(artist);
  if (!candidateCore || !originalCore) return false;

  // Algunos canales titulan "Artista - Canción" (o al revés). Quita el nombre
  // del artista del título antes de comparar el núcleo.
  const cores = new Set([originalCore]);
  if (artistCore) {
    cores.add(`${artistCore} ${originalCore}`);
    cores.add(`${originalCore} ${artistCore}`);
  }
  if (!cores.has(candidateCore)) return false;

  // Una versión (remix, cover, directo, letra...) no sustituye a la original.
  if (TITLE_VARIANTS_RE.test(candidateTitle) && !TITLE_VARIANTS_RE.test(title)) return false;

  if (duration > 0 && candidateDuration > 0) {
    // Misma canción publicada en otro vídeo: la duración debe ser casi idéntica.
    if (Math.abs(candidateDuration - duration) > 10) return false;
  }

  const candidateArtistNorm = normalizeSongText(candidateArtist);
  const originalArtistNorm = normalizeSongText(artist);
  if (!originalArtistNorm) return true;

  // El canal puede ser el sello (Pina Records) en vez del artista; si el
  // título ya contiene al artista, la canción es la correcta.
  const titleHasArtist = new RegExp(`(^|\\s)${originalArtistNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(candidateCore);

  if (!candidateArtistNorm) return titleHasArtist;
  return candidateArtistNorm === originalArtistNorm
    || candidateArtistNorm.includes(originalArtistNorm)
    || originalArtistNorm.includes(candidateArtistNorm)
    || titleHasArtist;
}

// Busca la misma canción en la instancia Invidious. Su búsqueda se ejecuta
// desde la región de la instancia y encuentra copias de audio que YouTube no
// muestra a la IP de Vercel (p. ej. el audio oficial de "Candy" de Plan B).
async function findInvidiousAlternatives(videoId, title, artist, duration) {
  if (!title) return [];
  const query = `${title} ${artist || ''}`.trim();
  const found = [];

  for (const base of relayInstances().slice(0, 2)) {
    try {
      const res = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video`, {
        headers: { 'User-Agent': RELAY_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(3000)
      });
      if (!res.ok) continue;
      const list = await res.json();
      if (!Array.isArray(list)) continue;

      for (const item of list) {
        const vid = item && item.videoId;
        if (!vid || vid === videoId || found.some((f) => f.id === vid)) continue;
        const candidateTitle = String(item.title || '');
        const candidateArtist = String(item.author || '');
        const candidateDuration = Number(item.lengthSeconds) || 0;
        if (!isSameSongCandidate(candidateTitle, candidateArtist, title, artist, candidateDuration, duration)) continue;

        // La pista de audio oficial y la duración exacta suenan igual que la
        // canción pedida; el videoclip puede llevar intro/silencio extra.
        found.push({
          id: vid,
          diff: duration > 0 && candidateDuration > 0 ? Math.abs(candidateDuration - duration) : 999,
          isAudio: /\baudio\b|audio oficial|official audio/i.test(candidateTitle) ? 0 : 1
        });
      }
    } catch {}
  }

  found.sort((a, b) => a.diff - b.diff || a.isAudio - b.isAudio);
  return found.slice(0, 3).map((f) => f.id);
}

async function findAlternativeVideoId(title, artist, originalId, duration = 0) {
  if (!title) return null;
  const queryWithArtist = `${title} ${artist || ''}`.trim();
  const queryTitleOnly = String(title).trim();

  const search = (query) => fetchYt('search', {
    query,
    params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D'
  }, { timeoutMs: 5000, retries: 0 }).catch(() => null);

  // Dos búsquedas en paralelo: la específica suele acertar antes, pero si no
  // aparece otra publicación de la misma canción, la búsqueda solo por título
  // encuentra la copia alternativa (p. ej. el segundo "Candy" de Plan B).
  const plans = [search(queryWithArtist)];
  if (normalizeSongText(queryTitleOnly) !== normalizeSongText(queryWithArtist)) {
    plans.push(search(queryTitleOnly));
  }
  const results = await Promise.all(plans);

  for (const data of results) {
    if (!data) continue;
    const secList = data.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    for (const s of secList) {
      const list = s.musicShelfRenderer?.contents || s.itemSectionRenderer?.contents || [];
      for (const it of list) {
        const r = it.musicResponsiveListItemRenderer;
        if (!r) continue;
        const col0 = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        const col1 = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        const candidateTitle = getRunsText(col0);
        const subText = getRunsText(col1);
        const candidateArtist = subText.split('•')[0].trim();
        const candidateDuration = parseDuration(subText.split('•').pop().trim()).durationSeconds;

        const vid = r.playlistItemData?.videoId
          || col0[0]?.navigationEndpoint?.watchEndpoint?.videoId
          || r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId
          || r.navigationEndpoint?.watchEndpoint?.videoId;
        if (!vid || vid === originalId) continue;
        if (isSameSongCandidate(candidateTitle, candidateArtist, title, artist, candidateDuration, duration)) {
          return vid;
        }
      }
    }
  }
  return null;
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

// Lo mismo para el relay: varios rangos simultáneos comparten una sola consulta.
function resolveRelay(videoId, wantedItag, excluded) {
  const dedupeKey = JSON.stringify(['RELAY', videoId, wantedItag, ...excluded]);
  const pending = pendingResolves.get(dedupeKey);
  if (pending) return pending;
  const task = resolveRelayAudio(videoId, wantedItag, excluded);
  pendingResolves.set(dedupeKey, task);
  task.finally(() => pendingResolves.delete(dedupeKey)).catch(() => {});
  return task;
}

async function openRelay(videoId, itag, range, state) {
  const rejected = [];
  const errors = [];
  // Un relay puede devolver metadatos válidos y fallar al entregar los bytes.
  // Probar el mismo ID en las demás instancias preserva la grabación elegida.
  const limit = Math.min(3, relayInstances().length);
  for (let attempt = 0; attempt < limit; attempt++) {
    try {
      const target = await resolveRelay(videoId, itag, rejected);
      if (state?.done) return null;
      rejected.push(target.relay);
      try {
        return { target, upstream: await openUpstream(target, range) };
      } catch (error) {
        errors.push(`${new URL(target.relay).host}: ${error.message}`);
      }
    } catch (error) {
      errors.push(error.message);
      break;
    }
  }
  throw new Error(errors.join(' | ') || 'ningún relay entregó audio');
}

function cacheTarget(cacheKey, target) {
  if (urlCache.size >= CACHE_MAX) urlCache.delete(urlCache.keys().next().value);
  urlCache.set(cacheKey, { ...target, expires: Date.now() + URL_TTL_MS });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resuelve en cuanto una de las vías consigue audio; null si todas fallan.
function firstSuccess(tasks) {
  return new Promise((resolve) => {
    let pending = tasks.length;
    let finished = false;
    for (const task of tasks) {
      task.then((result) => {
        if (finished) return;
        if (result && result.ok) {
          finished = true;
          resolve(result);
        } else if (--pending === 0) {
          resolve(null);
        }
      }).catch(() => {
        if (!finished && --pending === 0) resolve(null);
      });
    }
  });
}

async function tryAltCandidates(altIds, itag, range, cacheKey, state, errors) {
  for (const altId of altIds.slice(0, 3)) {
    if (state.done) return { ok: false };
    const altKey = `${altId}:${itag}`;
    try {
      const result = await openRelay(altId, itag, range, state);
      if (!result) return { ok: false };
      const { target, upstream: resp } = result;
      if (state.done) {
        try { await resp.body?.cancel(); } catch {}
        return { ok: false };
      }
      cacheTarget(altKey, target);
      cacheTarget(cacheKey, target);
      return { ok: true, upstream: resp };
    } catch (e) {
      errors.push(`alt ${altId}: ${e.message}`);
    }
  }
  return { ok: false };
}

async function getUpstream(videoId, itag, range, backupIndex, title = '', artist = '', duration = 0, prewarm = false, audioOnly = false) {
  const cacheKey = `${videoId}:${itag}${audioOnly ? ':a' : ''}`;
  const errors = [];

  // 1. URL ya resuelta: evita pedir metadatos en cada fragmento de la canción.
  const cached = urlCache.get(cacheKey);
  if (cached && cached.expires > Date.now() && !backupIndex) {
    try {
      return { upstream: await openUpstream(cached, range), errors };
    } catch (e) {
      errors.push(`cache: ${e.message}`);
      urlCache.delete(cacheKey);
    }
  }

  // 2. Carrera: relay del vídeo original contra una copia alternativa.
  //    El vídeo original de un music video suele tardar ~4 s en rendirse desde
  //    Vercel; la copia de audio se encuentra en ~2 s por la búsqueda de
  //    Invidious (que corre en otra región) y se sirve por el mismo relay.
  const state = { done: false };

  const primaryTask = (async () => {
    try {
      const result = await openRelay(videoId, itag, range, state);
      if (!result) return { ok: false };
      const { target, upstream: resp } = result;
      if (state.done) {
        try { await resp.body?.cancel(); } catch {}
        return { ok: false };
      }
      state.done = true;
      cacheTarget(cacheKey, target);
      return { ok: true, upstream: resp };
    } catch (e) {
      errors.push(`relay: ${e.message}`);
      return { ok: false };
    }
  })();

  const altTask = (title || artist)
    ? (async () => {
        // En el precalentamiento no hay usuario esperando; aun así damos una
        // pequeña ventaja al vídeo original por si el relay responde rápido.
        await delay(prewarm ? 700 : 1200);
        if (state.done) return { ok: false };
        const altIds = await findInvidiousAlternatives(videoId, title, artist, duration);
        if (!altIds.length) {
          errors.push('invidious alt not found');
          return { ok: false };
        }
        return tryAltCandidates(altIds, itag, range, cacheKey, state, errors);
      })()
    : Promise.resolve({ ok: false });

  const winner = await firstSuccess([primaryTask, altTask]);
  if (winner) return { upstream: winner.upstream, errors };

  // Un precalentamiento fallido no debe encadenar los respaldos lentos.
  if (prewarm) return { upstream: null, errors };

  // 3. MWEB directo: funciona cuando la IP del servidor no está bloqueada
  // (por ejemplo en local o en un host con IP residencial).
  if (process.env.YOUTUBE_COOKIE && getCookie()) {
    try {
      const target = await resolveMweb(videoId, itag);
      const resp = await openUpstream(target, range);
      cacheTarget(cacheKey, target);
      return { upstream: resp, errors };
    } catch (e) {
      errors.push(`mweb: ${e.message}`);
      console.warn(`[stream] MWEB falló para ${videoId}: ${e.message}`);
    }

    // 4. HLS armado en memoria (respaldo histórico, también sujeto al bloqueo).
    try {
      const buffer = await getAudioBuffer(videoId);
      return { buffer, errors };
    } catch (e) {
      errors.push(`hls: ${e.message}`);
      console.warn(`[stream] HLS falló para ${videoId}: ${e.message}`);
    }
  }

  // 5. Otra publicación de la misma canción (el vídeo original puede estar caído).
  //    Va antes que los clientes nativos: desde Vercel esos clientes suelen
  //    responder LOGIN_REQUIRED y solo añaden varios segundos de espera.
  if (title || artist) {
    try {
      const altVideoId = await findAlternativeVideoId(title, artist, videoId, duration);
      if (!altVideoId || altVideoId === videoId) {
        errors.push('alt not found or same as original');
      } else {
        errors.push(`alt found: ${altVideoId}`);
        const altKey = `${altVideoId}:${itag}`;

        try {
          const { target, upstream: resp } = await openRelay(altVideoId, itag, range);
          cacheTarget(altKey, target);
          cacheTarget(cacheKey, target);
          return { upstream: resp, errors };
        } catch (e) {
          errors.push(`alt relay: ${e.message}`);
        }

        if (process.env.YOUTUBE_COOKIE && getCookie()) {
          try {
            const target = await resolveMweb(altVideoId, itag);
            const resp = await openUpstream(target, range);
            cacheTarget(altKey, target);
            cacheTarget(cacheKey, target);
            return { upstream: resp, errors };
          } catch (e) {
            errors.push(`alt mweb: ${e.message}`);
          }
          try {
            const buffer = await getAudioBuffer(altVideoId);
            return { buffer, errors };
          } catch (e) {
            errors.push(`alt hls: ${e.message}`);
          }
        }

        for (const client of CLIENTS) {
          try {
            const target = await resolveWithClient(client, altVideoId, itag, audioOnly);
            const resp = await openUpstream(target, range);
            cacheTarget(altKey, target);
            cacheTarget(cacheKey, target);
            return { upstream: resp, errors };
          } catch (e) {
            errors.push(`alt ${client.name}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      errors.push(`alt search error: ${e.message}`);
    }
  }

  // 6. Clientes nativos (respaldo final; desde Vercel suelen fallar).
  for (const client of CLIENTS) {
    try {
      const target = await resolveWithClient(client, videoId, itag, audioOnly);
      const resp = await openUpstream(target, range);
      cacheTarget(cacheKey, target);
      return { upstream: resp, errors };
    } catch (e) {
      errors.push(`${client.name}: ${e.message}`);
      console.warn(`[stream] ${client.name} falló para ${videoId}: ${e.message}`);
    }
  }

  return { upstream: null, errors };
}

const STREAM_CHUNK_SIZE = 2 * 1024 * 1024;

export function parseStreamRange(raw, full = false) {
  if (!raw) return { start: 0, end: full ? null : STREAM_CHUNK_SIZE - 1, header: full ? 'bytes=0-' : `bytes=0-${STREAM_CHUNK_SIZE - 1}` };
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) {
    if (last <= 0) return null;
    const suffix = full ? last : Math.min(last, STREAM_CHUNK_SIZE);
    return { suffix, header: `bytes=-${suffix}` };
  }
  if (last !== null && last < first) return null;
  const end = full ? last : Math.min(last ?? Number.MAX_SAFE_INTEGER, first + STREAM_CHUNK_SIZE - 1);
  return { start: first, end, header: `bytes=${first}-${end ?? ''}` };
}

export function serveBuffer(buffer, req, res, node, range, full) {
  const total = buffer.length;
  const start = range.suffix ? Math.max(0, total - range.suffix) : range.start;
  const end = range.suffix || range.end === null ? total - 1 : Math.min(range.end, total - 1);

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Content-Type': 'audio/aac',
    'Accept-Ranges': 'bytes',
    'Cache-Control': full ? 'private, no-store' : 'public, max-age=3600, s-maxage=3600',
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

  if (start >= total || start > end) {
    headers['Content-Range'] = `bytes */${total}`;
    headers['Content-Length'] = '0';
    if (node) {
      res.statusCode = 416;
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.end();
    }
    return new Response(null, { status: 416, headers });
  }

  const slice = buffer.subarray(start, end + 1);
  const status = full && !req.headers?.range ? 200 : 206;

  headers['Content-Length'] = String(slice.length);
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;

  if (node) {
    res.statusCode = status;
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    return res.end(slice);
  }
  return new Response(slice, { status, headers });
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const param = (k) => (req.query && req.query[k]) || urlObj.searchParams.get(k);
  const videoId = param('id');
  const itag = String(param('itag') || '18').replace(/\D/g, '') || '18';
  const backupIndex = Math.max(0, parseInt(param('backup') || '0', 10) || 0);
  const title = param('title') || '';
  const artist = param('artist') || '';
  const duration = Math.max(0, parseInt(param('dur') || '0', 10) || 0);
  const prewarm = param('prewarm') === '1';
  // En descargas se pide solo la pista de audio (sin el vídeo de itag 18).
  const audioOnly = param('audio') === '1';
  const relayMediaParam = param('relayMedia');
  // full=1 se usa para descargas: devuelve la pista completa en vez de un fragmento.
  const full = !relayMediaParam && (param('full') === '1' || param('full') === 'true');

  const node = !!(res && res.setHeader);
  // Estas respuestas son siempre errores: nunca deben quedar cacheadas.
  const json = (status, body) => node
    ? (res.statusCode = status, res.setHeader('Content-Type', 'application/json'), res.setHeader('Access-Control-Allow-Origin', '*'), res.setHeader('Cache-Control', 'no-store, max-age=0'), res.end(JSON.stringify(body)))
    : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store, max-age=0' } });

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

  const relayMedia = relayMediaParam ? parseBrowserRelayMedia(relayMediaParam) : null;
  if (relayMediaParam && (!relayMedia || !['GET', 'HEAD'].includes(req.method))) {
    return json(400, { error: 'Fuente de audio no válida' });
  }

  // Limita los fragmentos a 2 MB y conserva los rangos de sufijo de Safari.
  // Un rango inválido nunca debe convertirse silenciosamente en el byte cero.
  const range = parseStreamRange(req.method === 'HEAD' ? null : req.headers?.range, full);
  if (!range) return json(416, { error: 'Rango de audio inválido' });
  const boundedRange = req.method === 'HEAD' ? 'bytes=0-1' : range.header;

  const { upstream, buffer, errors } = relayMedia
    ? { upstream: await fetchBrowserRelayMedia(relayMedia, req.method === 'HEAD' ? { start: 0, end: 1 } : range) }
    : await getUpstream(videoId, itag, boundedRange, backupIndex, title, artist, duration, prewarm, audioOnly);

  if (buffer) {
    return serveBuffer(buffer, req, res, node, range, full);
  }

  if (!upstream) {
    return json(502, {
      error: 'No se pudo obtener el audio de esta canción',
      code: 'STREAM_UNAVAILABLE',
      details: errors
    });
  }

  if (upstream.status === 416) {
    const headers = { 'Content-Range': upstream.headers.get('content-range'), 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range' };
    try { await upstream.body?.cancel(); } catch {}
    if (node) {
      res.statusCode = 416;
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.end();
    }
    return new Response(null, { status: 416, headers });
  }

  const rawType = (upstream.headers.get('content-type') || '').toLowerCase();
  const contentType = /^(audio\/|video\/mp4)/.test(rawType)
    ? rawType.split(';')[0].trim()
    : 'audio/mp4';

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': full || relayMedia ? 'private, max-age=0, no-store' : 'public, max-age=3600, s-maxage=3600',
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

  if (req.method === 'HEAD') {
    try { await upstream.body?.cancel(); } catch {}
  }
  return new Response(req.method === 'HEAD' ? null : upstream.body, {
    status: req.method === 'HEAD' ? 200 : upstream.status,
    headers
  });
}

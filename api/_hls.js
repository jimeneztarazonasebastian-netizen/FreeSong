// api/_hls.js - Obtiene el audio de YouTube por la vía HLS desde el servidor.
//
// Por qué así:
//  - Desde IPs de datacenter (Vercel) YouTube exige sesión para los clientes
//    móviles: IOS / ANDROID devuelven "confirma que no eres un bot".
//  - Con una cookie válida + firma SAPISIDHASH, el cliente WEB de Safari
//    (web_safari) devuelve un manifiesto HLS que sí funciona desde Vercel.
//  - El manifiesto es muxado (audio + vídeo). Aquí se descarga y se extrae el
//    AAC del MPEG-TS, para servir un archivo de audio progresivo normal.
//  - Los segmentos van firmados con el parámetro `n`; hay que transformarlo con
//    el script del reproductor (nsig) o googlevideo responde 403.
import crypto from 'crypto';
import { Player, Platform } from 'youtubei.js';
import { normalizeCookieInput } from './_yt.js';

// youtubei.js necesita un evaluador de JavaScript para el script nsig de YouTube.
Platform.shim.eval = async (data) => new Function(data.output)();

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15';
const FALLBACK_CLIENT_VERSION = '2.20261029.11.00';
const RESOLVE_TIMEOUT_MS = 8000;
const SEGMENT_TIMEOUT_MS = 20000;
const NSIG_TIMEOUT_MS = 15000;
const MAX_PARALLEL_SEGMENTS = 6;

let webClientVersion = FALLBACK_CLIENT_VERSION;
let webVersionExpiry = 0;

function sapiAuth(cookie) {
  const m = String(cookie || '').match(/(?:^|;\s*)SAPISID=([^;]+)/);
  if (!m) return '';
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${m[1]} https://www.youtube.com`).digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

export function getCookie() {
  return normalizeCookieInput(process.env.YOUTUBE_COOKIE);
}

// La versión del cliente WEB debe coincidir con la del sitio en ese momento;
// se lee del HTML una vez cada 6 h.
async function getClientVersion(cookie) {
  if (webVersionExpiry > Date.now()) return webClientVersion;
  try {
    const res = await fetch('https://www.youtube.com/', {
      headers: { 'User-Agent': SAFARI_UA, ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(5000)
    });
    const html = await res.text();
    const match = html.match(/"INNERTUBE_CLIENT_VERSION":"([\d.]+)"/);
    if (match) {
      webClientVersion = match[1];
      webVersionExpiry = Date.now() + 6 * 3600 * 1000;
    }
  } catch {}
  return webClientVersion;
}

function playerContext(clientVersion) {
  return { client: { clientName: 'WEB', clientVersion, hl: 'es', gl: 'US' } };
}

// Sin signatureTimestamp el cliente WEB responde 'El vídeo no está disponible'
// para cualquier vídeo (UNPLAYABLE). Se toma del mismo script que usa el nsig.
function playbackContext(signatureTimestamp) {
  return {
    contentPlaybackContext: {
      html5Preference: 'HTML5_PREF_WANTS',
      ...(signatureTimestamp ? { signatureTimestamp } : {})
    }
  };
}

async function playerRequest(videoId, clientVersion, cookie, signatureTimestamp, extraBody = {}) {
  const res = await fetch(PLAYER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': SAFARI_UA,
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': clientVersion,
      Origin: 'https://www.youtube.com',
      Referer: 'https://www.youtube.com/',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(cookie && sapiAuth(cookie) ? { Authorization: sapiAuth(cookie) } : {})
    },
    body: JSON.stringify({
      videoId,
      context: playerContext(clientVersion),
      playbackContext: playbackContext(signatureTimestamp),
      contentCheckOk: true,
      racyCheckOk: true,
      ...extraBody
    }),
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
  });
  return res.json();
}

export async function resolveHlsManifest(videoId) {
  const cookie = getCookie();
  if (!cookie) throw new Error('sin cookie de YouTube');
  const clientVersion = await getClientVersion(cookie);
  let signatureTimestamp = 0;
  try {
    signatureTimestamp = (await withTimeout(getPlayer(), NSIG_TIMEOUT_MS, 'player')).signature_timestamp || 0;
  } catch (err) {
    console.warn('[hls] sin signatureTimestamp:', err.message);
  }
  const data = await playerRequest(videoId, clientVersion, cookie, signatureTimestamp);
  const status = data?.playabilityStatus?.status;
  if (status !== 'OK') {
    throw new Error(data?.playabilityStatus?.reason || status || 'no reproducible');
  }
  const manifest = data?.streamingData?.hlsManifestUrl;
  if (!manifest) throw new Error('sin manifiesto HLS');
  return manifest;
}

// --- Audio directo vía MWEB ---
// Los segmentos HLS de YouTube responden 403 sin PO token. El cliente MWEB, en
// cambio, entrega una URL directa de audio (itag 140) que no lo necesita y
// admite Range, así que se sirve en streaming sin armar la canción en memoria.
const MWEB_VERSION = '2.20261029.01.00';

export async function resolveMwebAudio(videoId, wantedItag) {
  const cookie = getCookie();
  const player = await withTimeout(getPlayer(), NSIG_TIMEOUT_MS, 'player');
  const res = await fetch(PLAYER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': SAFARI_UA,
      'X-YouTube-Client-Name': '2',
      'X-YouTube-Client-Version': MWEB_VERSION,
      Origin: 'https://www.youtube.com',
      Referer: 'https://www.youtube.com/',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(cookie && sapiAuth(cookie) ? { Authorization: sapiAuth(cookie) } : {})
    },
    body: JSON.stringify({
      videoId,
      context: { client: { clientName: 'MWEB', clientVersion: MWEB_VERSION, hl: 'es', gl: 'US' } },
      playbackContext: playbackContext(player.signature_timestamp),
      contentCheckOk: true,
      racyCheckOk: true
    }),
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
  });
  const data = await res.json();
  const status = data?.playabilityStatus?.status;
  if (status !== 'OK') throw new Error(data?.playabilityStatus?.reason || status || 'no reproducible');

  const formats = [...(data.streamingData?.formats || []), ...(data.streamingData?.adaptiveFormats || [])];
  const isAudio = (f) => (f.mimeType || '').startsWith('audio/');
  const byItag = (n) => formats.find((f) => String(f.itag) === String(n));
  const wanted = wantedItag ? byItag(wantedItag) : null;
  const fmt = (wanted && isAudio(wanted) && wanted)
    || byItag(140)
    || formats.find((f) => /^audio\/mp4/.test(f.mimeType || ''))
    || formats.find(isAudio);
  if (!fmt || !(fmt.url || fmt.signatureCipher || fmt.cipher)) throw new Error('MWEB sin formato de audio');

  const url = await withTimeout(player.decipher(fmt.url, fmt.signatureCipher, fmt.cipher), NSIG_TIMEOUT_MS, 'decipher');
  return { url, ua: SAFARI_UA, itag: fmt.itag, mimeType: fmt.mimeType, noCookie: true };
}

// --- nsig ---
// El script del reproductor se analiza una vez por instancia y se reutiliza.
let playerPromise = null;

function getPlayer() {
  if (!playerPromise) {
    playerPromise = Player.create(null, undefined, undefined).catch((err) => {
      playerPromise = null;
      throw err;
    });
  }
  return playerPromise;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} agotó el tiempo`)), ms))
  ]);
}

// El `n` viaja como segmento de ruta (/n/<valor>/), no como query.
async function unlockUrl(url) {
  const match = String(url).match(/\/n\/([^/]+)\//);
  if (!match) return url;
  try {
    const player = await withTimeout(getPlayer(), NSIG_TIMEOUT_MS, 'nsig');
    const solved = await withTimeout(
      player.decipher(`https://nsig.invalid/?n=${encodeURIComponent(match[1])}`),
      NSIG_TIMEOUT_MS,
      'nsig'
    );
    const value = new URL(solved).searchParams.get('n');
    if (!value) return url;
    return url.replace(/\/n\/[^/]+\//, `/n/${value}/`);
  } catch (err) {
    console.warn('[hls] no se pudo transformar n:', err.message);
    return url;
  }
}

// --- Manifiesto ---
function parseVariant(attrs, uri) {
  const bandwidth = parseInt((attrs.match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
  let audioItag = 0;
  const sgoap = (uri.match(/sgoap\/([^/]+)/) || [])[1] || '';
  try {
    audioItag = parseInt((decodeURIComponent(sgoap).match(/itag[=:](\d+)/) || [])[1] || '0', 10);
  } catch {}
  return { bandwidth, audioItag, uri };
}

export function pickVariant(masterUrl, text) {
  const lines = String(text || '').split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = (lines[i + 1] || '').trim();
    if (!uri || uri.startsWith('#')) continue;
    variants.push(parseVariant(line, new URL(uri, masterUrl).toString()));
  }
  if (!variants.length) throw new Error('HLS sin variantes');
  // 140 = AAC 128 kbps. Es la mejor relación calidad/peso para música.
  const aac = variants.filter((v) => v.audioItag === 140).sort((a, b) => a.bandwidth - b.bandwidth);
  if (aac.length) return aac[0];
  return variants.sort((a, b) => a.bandwidth - b.bandwidth)[0];
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': SAFARI_UA },
    signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchSegment(url, attempts = 3) {
  const unlocked = await unlockUrl(url);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(unlocked, {
        headers: { 'User-Agent': SAFARI_UA },
        signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('fragmento vacío');
      return buf;
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastError || new Error('no se pudo descargar el fragmento');
}

// --- MPEG-TS -> AAC (ADTS) ---
// Recorre los paquetes TS, localiza el PID de audio en la PMT y concatena el
// contenido de sus PES. El resultado es un flujo ADTS que cualquier navegador
// reproduce con <audio>.
export function extractAacFromTs(buffer) {
  const PKT = 188;
  let pmtPid = -1;
  let audioPid = -1;
  const parts = [];
  let syncErrors = 0;

  for (let pos = 0; pos + PKT <= buffer.length; pos += PKT) {
    if (buffer[pos] !== 0x47) {
      // Resincroniza si el segmento no empieza exactamente en un paquete.
      let next = pos + 1;
      while (next + PKT <= buffer.length && buffer[next] !== 0x47) next++;
      if (next + PKT > buffer.length) break;
      pos = next - PKT;
      syncErrors++;
      continue;
    }

    const pusi = (buffer[pos + 1] & 0x40) !== 0;
    const pid = ((buffer[pos + 1] & 0x1f) << 8) | buffer[pos + 2];
    const afc = (buffer[pos + 3] >> 4) & 0x03;
    if (afc === 0 || afc === 2) continue; // sin payload

    let start = pos + 4;
    if (afc === 3) start = pos + 5 + buffer[pos + 4];
    const end = pos + PKT;
    if (start >= end) continue;

    if (pid === 0 && pmtPid < 0) {
      const section = start + 1 + buffer[start]; // pointer_field
      if (section + 12 < end && buffer[section] === 0x00) {
        pmtPid = ((buffer[section + 10] & 0x1f) << 8) | buffer[section + 11];
      }
      continue;
    }

    if (pid === pmtPid && audioPid < 0) {
      const section = start + 1 + buffer[start];
      if (section + 12 >= end || buffer[section] !== 0x02) continue;
      const sectionLength = ((buffer[section + 1] & 0x0f) << 8) | buffer[section + 2];
      const sectionEnd = Math.min(section + 3 + sectionLength - 4, end); // sin CRC
      let p = section + 12 + (((buffer[section + 10] & 0x0f) << 8) | buffer[section + 11]);
      while (p + 5 <= sectionEnd) {
        const streamType = buffer[p];
        const esPid = ((buffer[p + 1] & 0x1f) << 8) | buffer[p + 2];
        const esInfoLength = ((buffer[p + 3] & 0x0f) << 8) | buffer[p + 4];
        if (streamType === 0x0f) {
          audioPid = esPid;
          break;
        }
        if (streamType === 0x11 && audioPid < 0) audioPid = esPid; // LATM: se intenta igual
        p += 5 + esInfoLength;
      }
      continue;
    }

    if (pid !== audioPid || audioPid < 0) continue;

    if (pusi) {
      if (!(buffer[start] === 0 && buffer[start + 1] === 0 && buffer[start + 2] === 1)) continue;
      const headerLength = buffer[start + 8];
      const dataStart = start + 9 + headerLength;
      if (dataStart > end) continue; // cabecera PES partida en dos paquetes
      start = dataStart;
    }
    if (start < end) parts.push(buffer.subarray(start, end));
  }

  if (!parts.length) throw new Error('sin pista de audio en el segmento');
  if (syncErrors > 4) console.warn(`[hls] resincronizados ${syncErrors} paquetes TS`);

  const audio = Buffer.concat(parts);
  // Validación mínima: el primer frame ADTS debe empezar con 0xFF F?.
  let first = -1;
  for (let i = 0; i < Math.min(audio.length - 1, 4096); i++) {
    if (audio[i] === 0xff && (audio[i + 1] & 0xf6) === 0xf0) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new Error('audio AAC no reconocido');
  return first === 0 ? audio : audio.subarray(first);
}

// --- Ensamblado y caché ---
const cache = new Map();
const pending = new Map();
const CACHE_MAX = 8;
const CACHE_TTL_MS = 30 * 60 * 1000;

async function buildAudio(videoId) {
  const manifestUrl = await resolveHlsManifest(videoId);
  const master = await fetchText(manifestUrl);
  const variant = pickVariant(manifestUrl, master);
  const playlist = await fetchText(variant.uri);

  const segmentUrls = playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => new URL(line, variant.uri).toString());
  if (!segmentUrls.length) throw new Error('HLS sin segmentos');

  const segments = new Array(segmentUrls.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_PARALLEL_SEGMENTS, segmentUrls.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= segmentUrls.length) return;
      segments[index] = await fetchSegment(segmentUrls[index]);
    }
  });
  await Promise.all(workers);

  const audio = extractAacFromTs(Buffer.concat(segments));
  if (audio.length < 20000) throw new Error('audio incompleto');
  return audio;
}

export async function getAudioBuffer(videoId) {
  const hit = cache.get(videoId);
  if (hit && hit.expires > Date.now()) return hit.buffer;
  if (pending.has(videoId)) return pending.get(videoId);

  const task = (async () => {
    const buffer = await buildAudio(videoId);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(videoId, { buffer, expires: Date.now() + CACHE_TTL_MS });
    return buffer;
  })();

  pending.set(videoId, task);
  task.finally(() => pending.delete(videoId)).catch(() => {});
  return task;
}


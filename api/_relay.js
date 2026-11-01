// api/_relay.js - Relay de audio vía instancias Invidious.
//
// Desde la IP de Vercel, YouTube responde 403 a cualquier descarga de
// googlevideo (bloqueo por reputación de IP), aunque la API de player sí
// funcione con cookies. Una instancia Invidious con `local=true` resuelve el
// vídeo y además sirve el audio desde su propia IP, así que el proxy de Vercel
// solo tiene que reenviar bytes de la instancia. Es la única vía que entrega
// audio y descargas funcionando a la vez desde producción.
//
// INVIDIOUS_INSTANCES permite añadir o reemplazar la lista (separada por comas).

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15';

const DEFAULT_INSTANCES = ['https://yt.chocolatemoo53.com'];

function configuredInstances() {
  const fromEnv = String(process.env.INVIDIOUS_INSTANCES || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => /^https?:\/\//.test(s));
  return fromEnv.length ? fromEnv : DEFAULT_INSTANCES;
}

const RESOLVE_TIMEOUT_MS = 9000;
const BAD_TTL_MS = 5 * 60 * 1000;

// Instancia que respondió bien la última vez: se prueba primero.
let preferred = '';
// Instancias caídas: no se reintentan en cada fragmento de cada canción.
const badUntil = new Map();

export function relayInstances() {
  return configuredInstances();
}

export async function resolveRelayAudio(videoId, wantedItag) {
  const all = configuredInstances();
  const order = preferred && all.includes(preferred) ? [preferred, ...all.filter((i) => i !== preferred)] : all;
  const errors = [];

  for (const base of order) {
    const until = badUntil.get(base) || 0;
    if (until > Date.now()) {
      errors.push(`${hostOf(base)}: en espera ${Math.ceil((until - Date.now()) / 1000)}s`);
      continue;
    }
    try {
      const target = await resolveFrom(base, videoId, wantedItag);
      preferred = base;
      badUntil.delete(base);
      return target;
    } catch (e) {
      if (e.instanceFault) {
        badUntil.set(base, Date.now() + BAD_TTL_MS);
        errors.push(`${hostOf(base)}: ${e.message}`);
      } else {
        // Es un problema de este vídeo, no de la instancia.
        errors.push(`${hostOf(base)}: ${e.message}`);
      }
    }
  }

  throw new Error(errors.join(' | ') || 'sin relays Invidious configurados');
}

function hostOf(base) {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

const AUDIO_ITAGS = new Set(['139', '140', '141', '249', '250', '251']);

// Invidious no siempre incluye `mimeType`, así que el tipo se deduce del itag o
// de la propia URL proxeada.
function isAudioFormat(f) {
  if (!f || !f.url) return false;
  const mime = String(f.mimeType || f.type || '');
  if (/^audio\//.test(mime)) return true;
  if (AUDIO_ITAGS.has(String(f.itag))) return true;
  try {
    return /audio/i.test(new URL(f.url).searchParams.get('mime') || '');
  } catch {
    return false;
  }
}

function mimeOf(f) {
  const declared = String(f.mimeType || f.type || '');
  if (/^audio\//.test(declared)) return declared;
  const itag = String(f.itag);
  return itag === '251' || itag === '250' || itag === '249' ? 'audio/webm' : 'audio/mp4';
}

function sizeOf(f) {
  if (Number(f.clen) > 0) return Number(f.clen);
  if (Number(f.contentLength) > 0) return Number(f.contentLength);
  try {
    return Number(new URL(f.url).searchParams.get('clen')) || 0;
  } catch {
    return 0;
  }
}

async function resolveFrom(base, videoId, wantedItag) {
  let res;
  try {
    res = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}?local=true`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
    });
  } catch (e) {
    throw fault(`sin respuesta (${e.message})`);
  }
  if (!res.ok) throw fault(`HTTP ${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw fault('respuesta no JSON');
  }
  if (!data || typeof data !== 'object') throw fault('respuesta vacía');
  if (data.error) throw videoError(String(data.error));

  const formats = (data.adaptiveFormats || []).filter(isAudioFormat);
  if (!formats.length) throw videoError('sin formatos de audio');

  const byItag = (n) => formats.find((f) => String(f.itag) === String(n));
  const fmt =
    (wantedItag ? byItag(wantedItag) : null) ||
    byItag(140) ||
    byItag(139) ||
    formats.find((f) => /^audio\/mp4/.test(mimeOf(f))) ||
    formats[0];

  if (!fmt || !fmt.url) throw videoError('formato sin URL');
  // Si la instancia ignora `local=true` devuelve googlevideo, que desde Vercel
  // responde 403: no sirve como relay.
  let host = '';
  try {
    host = new URL(fmt.url).host;
  } catch {
    throw fault('URL de audio inválida');
  }
  if (/googlevideo\.com$/i.test(host)) throw fault('la instancia no proxea el audio (local=true desactivado)');

  return {
    url: fmt.url,
    ua: UA,
    itag: fmt.itag,
    mimeType: mimeOf(fmt),
    size: sizeOf(fmt),
    noCookie: true,
    relay: base
  };
}

function fault(message) {
  const err = new Error(message);
  err.instanceFault = true;
  return err;
}

function videoError(message) {
  const err = new Error(message);
  err.instanceFault = false;
  return err;
}

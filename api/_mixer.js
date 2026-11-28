// Puente de control. La clave de Render nunca sale al navegador.
import { setTimeout as delay } from 'node:timers/promises';
import { getRadioTracks } from './queue.js';

const origin = 'https://freesong-mixer.onrender.com';
const allowed = new Set(['https://freesong-pied.vercel.app']);
const recent = new Map();
const sessionId = /^[a-f0-9]{48}$/;
const youtubeId = /^[A-Za-z0-9_-]{11}$/;
const trackId = /^(?:[A-Za-z0-9_-]{11}|audius:[A-Za-z0-9]{1,32})$/;
const longQueueLimit = 12;
const reply = (res, code, body) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json(body);
};

function allowStart(req, res, id) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const previous = recent.get(ip);
  const now = Date.now();
  const remaining = previous ? 15_000 - (now - previous.at) : 0;
  if (remaining > 0) {
    if (id && previous.id === id) return true;
    res.setHeader('Retry-After', String(Math.ceil(remaining / 1000)));
    return false;
  }
  if (recent.size > 500) recent.clear();
  recent.set(ip, { at: now, id });
  return true;
}

// AVFoundation can make a native media request without an Origin or Sec-Fetch-Site.
function nativeStartOriginAllowed(headers) {
  const source = headers['sec-fetch-site'];
  if (source && source !== 'same-origin' && source !== 'none') return false;
  if (headers.origin && !allowed.has(headers.origin)) return false;
  if (!headers.referer) return true;
  try { return allowed.has(new URL(headers.referer).origin); }
  catch { return false; }
}

function launchTrack(track) {
  const { id } = track;
  const seconds = Number(track.durationSeconds || track.duration);
  return {
    id,
    title: typeof track.title === 'string' ? track.title.slice(0, 200) : '',
    artist: typeof track.artist === 'string' ? track.artist.slice(0, 200) : '',
    duration: Number.isFinite(seconds) && seconds > 0 && seconds <= 600 ? seconds : null,
    thumbnail: youtubeId.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''
  };
}

function nativeQueueTracks(ids, metadata) {
  let entries = [];
  if (metadata && metadata.length <= 2400) {
    try {
      const parsed = JSON.parse(metadata);
      if (Array.isArray(parsed) && parsed.length === ids.length) entries = parsed;
    } catch {}
  }
  // Los metadatos solo ayudan a identificar la grabación. Los IDs de la cola
  // validada conservan el orden y no se sustituyen por los del JSON.
  return ids.map((id, index) => launchTrack(entries[index]?.id === id ? entries[index] : { id }));
}

async function nativeRadioQueue(id, fade) {
  try {
    const { tracks } = await getRadioTracks(id, null, { timeoutMs: 3500, retries: 0 });
    const entries = tracks.filter(track => youtubeId.test(track?.id || '')).map(launchTrack);
    const start = entries.find(track => track.id === id) || launchTrack({ id });
    const seen = new Set([id]);
    const rest = [];
    for (const track of entries) {
      if (seen.has(track.id) || track.duration <= fade) continue;
      rest.push(track);
      seen.add(track.id);
      if (rest.length === 2) break;
    }
    return rest.length ? [start, ...rest] : null;
  } catch {
    return null;
  }
}

async function nativeMixerStart(req, res, url, key, id) {
  if (!key) return reply(res, 503, { error: 'El mezclador no está configurado.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'Método no admitido' });
  if (!nativeStartOriginAllowed(req.headers)) return reply(res, 403, { error: 'Origen no permitido' });
  const ids = (url.searchParams.get('ids') || '').split(',');
  const tail = (url.searchParams.get('tail') || '').split(',').filter(Boolean);
  const tailSeconds = url.searchParams.get('tailSeconds')?.split(',').map(Number);
  const fade = Number(url.searchParams.get('fade'));
  const startAt = Number(url.searchParams.get('startAt'));
  const radio = url.searchParams.get('radio') === '1';
  const validIds = radio ? ids.length === 1 && youtubeId.test(ids[0]) :
    ids.length >= 2 && ids.length <= 3 && ids.every(value => trackId.test(value));
  if (!sessionId.test(id || '') || !validIds || !Number.isInteger(startAt) || startAt < 0 || startAt > 180 ||
      (tail.length && (ids.length !== 3 || radio || ids.length + tail.length > longQueueLimit ||
        tail.some(id => !trackId.test(id)))) ||
      (tailSeconds && (tailSeconds.length !== tail.length ||
        tailSeconds.some(seconds => !Number.isFinite(seconds) || seconds <= 0 || seconds > 600))) ||
      !Number.isFinite(fade) || fade < 1 || fade > 10) {
    return reply(res, 400, { error: 'Mezcla inválida' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'HEAD') {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    return res.status(200).end();
  }
  if (req.aborted || res.destroyed) return;
  if (!allowStart(req, res, id)) return reply(res, 429, { error: 'Espera unos segundos antes de crear otra mezcla.' });
  const disconnected = new AbortController();
  const onClose = () => { if (!res.writableEnded) disconnected.abort(); };
  res.once?.('close', onClose);
  const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(54_000)]);
  const requestRender = (path, options = {}, timeout = 8_000) => fetch(origin + path, {
    ...options, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)])
  });
  const playlistPath = `/sessions/${id}/index.m3u8`;
  const tracks = radio ? nativeRadioQueue(ids[0], fade) : nativeQueueTracks(ids, url.searchParams.get('metadata'));
  try {
    // The backend may be asleep. Wait here instead of relying on page JS after lock.
    for (;;) {
      let health;
      try {
        const response = await requestRender('/health');
        if (response.ok) health = await response.json();
        else await response.body?.cancel();
      } catch {
        // A cold instance can return HTML or time out while it starts.
      }
      if (health?.ok === true) {
        if (health.nativeStart !== true) return reply(res, 503, { error: 'El mezclador todavía no admite el inicio directo.' });
        break;
      }
      await delay(900, undefined, { signal });
    }
    const queue = await tracks;
    if (!queue) return reply(res, 502, { error: 'No se encontraron pistas compatibles para el crossfade.' });
    const created = await requestRender('/sessions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, tracks: queue, crossfade: fade, editable: true, radio, ...(startAt ? { startAt } : {}),
        ...(tail.length ? { continuation: tail.map((id, index) => launchTrack({ id, duration: tailSeconds?.[index] })) } : {}) })
    }, 12_000);
    const data = await created.json();
    if (created.status === 429) return reply(res, 429, { error: 'No hay espacio para preparar esta mezcla.' });
    if (created.status === 409) return reply(res, 409, { error: 'La sesión ya existe con otra mezcla.' });
    if (!created.ok || data.id !== id) return reply(res, 502, { error: 'No se pudo preparar la mezcla.' });

    for (;;) {
      const response = await requestRender(playlistPath);
      if (response.status === 503) {
        await response.body?.cancel();
        await delay(500, undefined, { signal });
        continue;
      }
      if (!response.ok || !response.headers.get('content-type')?.startsWith('application/vnd.apple.mpegurl')) {
        await response.body?.cancel();
        return reply(res, 502, { error: 'No se pudo preparar audio para la mezcla.' });
      }
      const manifest = await response.text();
      const offset = /^#EXT-X-START:TIME-OFFSET=(\d+(?:\.\d+)?)(?:,|\r?$)/m.exec(manifest);
      if (manifest.startsWith('#EXTM3U') && /^#EXTINF:.*\r?\nsegment-\d{5}\.ts$/m.test(manifest) &&
          (!startAt || Number(offset?.[1]) === startAt)) {
        res.setHeader('Location', origin + playlistPath);
        return res.status(307).end();
      }
      await delay(500, undefined, { signal });
    }
  } catch {
    if (disconnected.signal.aborted) return;
    return reply(res, 503, { error: 'El servidor de audio tardó demasiado en iniciar.' });
  } finally {
    res.removeListener?.('close', onClose);
  }
}

export async function mixerControl(req, res, url) {
  const key = process.env.MIXER_API_KEY;
  const id = url.searchParams.get('session');
  if (url.searchParams.get('nativeStart') === '1') return nativeMixerStart(req, res, url, key, id);
  if (req.method === 'GET' && !id) return reply(res, 200, {
    configured: !!key, experimental: true, ...(key ? { wakeUrl: `${origin}/health`, nativeStart: true } : {})
  });
  if (!key) return reply(res, 503, { error: 'Falta configurar MIXER_API_KEY en Vercel.' });
  if (id && !sessionId.test(id)) return reply(res, 400, { error: 'Sesión inválida' });
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method) || (req.method !== 'POST' && !id)) return reply(res, 405, { error: 'Método no admitido' });
  if (req.method !== 'GET') {
    if (!allowed.has(req.headers.origin)) return reply(res, 403, { error: 'Origen no permitido' });
  }
  let body;
  if (req.method === 'POST') {
    if (!allowStart(req, res)) return reply(res, 429, { error: 'Espera unos segundos antes de crear otra mezcla.' });
  }
  if (req.method === 'POST' || req.method === 'PATCH') {
    let raw = req.body;
    if (raw == null) {
      raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 8192) return reply(res, 413, { error: 'Solicitud demasiado grande' });
      }
    }
    try { body = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return reply(res, 400, { error: 'JSON inválido' }); }
    if (!body || JSON.stringify(body).length > 8192) return reply(res, 400, { error: 'Solicitud inválida' });
    if (req.method === 'POST' && Object.hasOwn(body, 'id')) return reply(res, 400, { error: 'Solicitud inválida' });
  }
  try {
    const upstream = await fetch(`${origin}/sessions${id ? '/' + id : ''}`, {
      method: req.method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000)
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      const retryAfter = upstream.headers.get('retry-after');
      if (upstream.status === 429 && /^[1-9]$|^1[0-5]$/.test(retryAfter || '')) res.setHeader('Retry-After', retryAfter);
      return reply(res, upstream.status === 401 ? 502 : upstream.status,
        { error: upstream.status === 401 ? 'La clave de Vercel no coincide con Render.' : (data.error || 'El mezclador no está disponible.') });
    }
    if (req.method === 'POST') {
      if (!/^[a-f0-9]{48}$/.test(data.id)) throw new Error('Respuesta inválida');
      return reply(res, 202, { id: data.id, playlist: `${origin}/sessions/${data.id}/index.m3u8`,
        expiresIn: data.expiresIn, editable: data.editable === true });
    }
    if (req.method === 'PATCH') return reply(res, 202, { edit: data.edit });
    const trackDurations = Array.isArray(data.trackDurations)
      ? data.trackDurations.slice(0, longQueueLimit).map(seconds =>
        Number.isFinite(seconds) && seconds > 0 && seconds <= 600 ? seconds : null)
      : undefined;
    const relayIssues = Array.isArray(data.relayIssues)
      ? data.relayIssues.slice(0, longQueueLimit).map(issue => typeof issue === 'string' && /^(metadata|media)_(\d{3}|format|no_aac|empty|redirect|timeout|unavailable)$/.test(issue) ? issue : null)
      : undefined;
    const tracks = Array.isArray(data.tracks) && data.tracks.length <= longQueueLimit && data.tracks.every(track => trackId.test(track?.id || ''))
      ? data.tracks.map(launchTrack) : undefined;
    const continuationStatus = ['pending', 'applied', 'rejected'].includes(data.continuationStatus) ? data.continuationStatus : undefined;
    return reply(res, 200, { status: data.status, ok: data.ok,
      sources: data.sources, failure: data.failure, upstreamStatus: data.upstreamStatus,
      exitCode: data.exitCode, exitSignal: data.exitSignal, revision: data.revision, edit: data.edit, trackDurations, relayIssues, tracks, continuationStatus });
  } catch { return reply(res, 502, { error: 'Render no respondió a tiempo; puede estar arrancando. Reintenta en un minuto.' }); }
}

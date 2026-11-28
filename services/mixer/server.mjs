import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { identicalSegments, idleSessionMs, publishManifest, readManifest, segmentIndex, sessionExpired } from './hls.mjs';
import { relayPlaybackOrigin, relayUserAgent, resolveMixerRelayAudio } from './european-relay.mjs';

// La PWA reproduce el fundido desde segmentos temporales de una sesión.
const key = process.env.MIXER_API_KEY;
if (!key || key.length < 24) throw new Error('MIXER_API_KEY debe tener al menos 24 caracteres');
const backend = process.env.AUDIO_BACKEND || 'https://freesong-pied.vercel.app';
const sessions = new Map();
const maxContinuationTracks = 12;
const maxContinuationSeconds = 45 * 60;
let replacementInFlight = null;
const authorized = req => {
  const a = Buffer.from(req.headers.authorization || '');
  const b = Buffer.from(`Bearer ${key}`);
  return a.length === b.length && timingSafeEqual(a, b);
};
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': 'https://freesong-pied.vercel.app' });
  res.end(JSON.stringify(body));
};
const createdSession = (res, id, editable) => json(res, 202, {
  id, playlist: `/sessions/${id}/index.m3u8`, status: `/sessions/${id}`, expiresIn: idleSessionMs / 1000, editable
});
async function dispose(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.closed = true;
  session.abort?.abort();
  await Promise.all([discardRender(session.render), discardRender(session.candidate)]);
}
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) if (sessionExpired(session, now)) dispose(id).catch(() => {});
}, 30_000);
sweep.unref();

const audiusId = /^audius:([A-Za-z0-9]{1,32})$/;
const sourceTimeout = (ms, signal) => signal
  ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
async function audiusSource(id, signal) {
  const url = new URL(`https://api.audius.co/v1/tracks/${id}/stream`);
  url.searchParams.set('app_name', 'FreeSong');
  const response = await fetch(url, {
    headers: { Range: 'bytes=0-1023' }, signal: sourceTimeout(12_000, signal)
  });
  try {
    if (![200, 206].includes(response.status) || !/^audio\//i.test(response.headers.get('content-type') || '') ||
        !response.body || new URL(response.url).protocol !== 'https:') throw new Error('Audius no entregó audio');
    const reader = response.body.getReader();
    try {
      const { value } = await reader.read();
      if (!value?.length) throw new Error('Audius devolvió audio vacío');
    } finally { await reader.cancel().catch(() => {}); }
  } finally {
    if (!response.body?.locked) await response.body?.cancel().catch(() => {});
  }
  // Usar el endpoint oficial para que cada lectura obtenga una redirección vigente.
  return url.href;
}

async function audioSource(track, signal) {
  const audius = audiusId.exec(track.id);
  if (audius) return { kind: 'audius', url: await audiusSource(audius[1], signal) };
  let relayIssue;
  // Resolver desde el mismo host que consume el audio. La ruta de Vercel
  // permanece como respaldo, pero no debe ser la única fuente del mezclador.
  if (process.env.RESOLVE_ON_HOST !== '0') {
    // Acotar toda la resolución para dejar margen a la creación de sesión de Vercel.
    const deadline = sourceTimeout(10_500, signal);
    const relay = await resolveMixerRelayAudio(track.id, deadline);
    if (relay.url) return relay;
    relayIssue = relay.issue;
    try {
      const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          'User-Agent': 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)' },
        body: JSON.stringify({ videoId: track.id, context: { client: {
          clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2',
          osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'es', gl: 'US'
        } } }), signal: AbortSignal.any([deadline, AbortSignal.timeout(4500)])
      });
      if (response.ok) {
        const data = await response.json();
        const formats = data.streamingData?.adaptiveFormats || [];
        const format = formats.find(f => f.itag === 140 && f.url) || formats.find(f => f.itag === 139 && f.url);
        if (data.playabilityStatus?.status === 'OK' && format) {
          const url = new URL(format.url);
          if (url.protocol === 'https:' && url.hostname.endsWith('.googlevideo.com')) {
            const probe = await fetch(url, { headers: { Range: 'bytes=0-1023' },
              signal: AbortSignal.any([deadline, AbortSignal.timeout(3000)]) });
            try {
              if ([200,206].includes(probe.status) && /^audio\//i.test(probe.headers.get('content-type') || '')) {
                const reader = probe.body.getReader();
                try { if (!(await reader.read()).done) return { kind: 'direct', url: url.href, relayIssue }; }
                finally { await reader.cancel().catch(() => {}); }
              }
            } finally { if (!probe.body?.locked) await probe.body?.cancel().catch(() => {}); }
          }
        }
      }
    } catch { /* El respaldo se valida posteriormente por el decodificador. */ }
  }
  const source = new URL('/api/stream', backend);
  source.search = new URLSearchParams({ id: track.id, itag: '140', audio: '1' });
  // Solo permitimos buscar otra publicación cuando sabemos qué grabación
  // esperar. Así el proxy puede contrastar título, artista y duración.
  const seconds = Number(track.duration);
  const artist = track.artist?.trim();
  if (track.title.trim() && artist && artist !== 'Artista' && Number.isFinite(seconds) && seconds > 0 && seconds <= 600) {
    source.searchParams.set('title', track.title);
    source.searchParams.set('artist', artist);
    source.searchParams.set('dur', String(Math.round(seconds)));
  }
  return { kind: 'proxy', url: source.href, relayIssue };
}

async function requestBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) return null;
  }
  try { return JSON.parse(body); } catch { return null; }
}

function validTrack(t, idPattern) {
  return t && typeof t.id === 'string' && (idPattern.test(t.id) || audiusId.test(t.id)) &&
    typeof t.title === 'string' && t.title.length <= 200 &&
    (t.artist == null || (typeof t.artist === 'string' && t.artist.length <= 200));
}

function validTracks(tracks, max = 3) {
  return Array.isArray(tracks) && tracks.length >= 2 && tracks.length <= max &&
    tracks.every(track => validTrack(track, /^[A-Za-z0-9_-]{1,64}$/));
}

async function verifyContinuationProxy(source, signal) {
  // El proxy es un respaldo todavía sin verificar. Un rango pequeño detecta
  // una pista caída sin arriesgar el prefijo que ya se puede mezclar.
  const response = await fetch(source.url, {
    headers: { Range: 'bytes=0-1023' }, redirect: 'error', signal: sourceTimeout(6000, signal)
  });
  const playable = [200, 206].includes(response.status) && response.body &&
    /^audio\//i.test(response.headers.get('content-type') || '');
  void response.body?.cancel().catch(() => {});
  if (!playable) throw new Error('La pista de continuación no entregó audio');
}

async function startRender(tracks, seconds, retained, limits) {
  const resolveSource = async (track, index) => {
    if (retained?.tracks[index]?.id === track.id && retained.inputs[index]) return retained.inputs[index];
    const source = await audioSource(track, limits?.signal);
    if (limits && source.kind === 'proxy') await verifyContinuationProxy(source, limits.signal);
    return source;
  };
  let inputs;
  if (!limits) {
    inputs = await Promise.all(tracks.map(resolveSource));
  } else {
    inputs = [];
    let duration = 0;
    // Two remote lookups at most. Resolve later sources only while there is
    // room in the session, and keep the same contiguous order as the queue.
    for (let start = 0; start < tracks.length; start += 2) {
      if (!limits.active()) return null;
      const batch = await Promise.allSettled(tracks.slice(start, start + 2)
        .map((track, offset) => resolveSource(track, start + offset)));
      for (const [offset, result] of batch.entries()) {
        if (result.status !== 'fulfilled') break;
        const source = result.value;
        const hint = Number(source.duration ?? tracks[start + offset].duration);
        const length = Number.isFinite(hint) && hint > 0 ? Math.min(hint, 600) : 600;
        const end = duration + length - (inputs.length ? seconds : 0);
        if (length <= seconds || end > maxContinuationSeconds) break;
        inputs.push(source);
        duration = end;
      }
      if (inputs.length < start + batch.length) break;
    }
    if (!limits.active() || inputs.length < limits.minimum) return null;
    tracks = tracks.slice(0, inputs.length);
  }
  const directory = await mkdtemp(join(tmpdir(), 'freesong-mix-'));
  const render = { directory, tracks, inputs, status: 'preparing',
    sources: inputs.map(source => source.kind), trackDurations: inputs.map(source => source.duration ?? null),
    relayIssues: inputs.map(source => source.relayIssue ?? null) };
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-filter_complex_threads', '1'];
  for (const source of inputs) {
    if (source.kind === 'relay-eu' || source.kind === 'relay-us') args.push('-user_agent', relayUserAgent, '-headers', `Origin: ${relayPlaybackOrigin}\r\n`,
      '-tls_verify', '1', '-protocol_whitelist', 'https,tls,tcp');
    args.push('-rw_timeout', '15000000', '-i', source.url);
  }
  const filters = tracks.map((_, i) => `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=600,asetpts=PTS-STARTPTS[a${i}]`);
  let previous = 'a0';
  for (let i = 1; i < tracks.length; i++) {
    filters.push(`[${previous}][a${i}]acrossfade=d=${seconds}:c1=qsin:c2=qsin[m${i}]`);
    previous = `m${i}`;
  }
  args.push('-filter_complex', filters.join(';'), '-map', `[${previous}]`, '-vn', '-c:a', 'aac', '-b:a', '128k');
  if (limits) args.push('-t', String(maxContinuationSeconds));
  args.push(
    '-threads', '1', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file',
    '-hls_segment_filename', join(directory, 'segment-%05d.ts'), join(directory, 'index.m3u8'));
  render.process = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  render.exited = new Promise(resolve => render.process.once('close', resolve));
  render.process.stderr.on('data', chunk => {
    // Solo categorías: no registrar URLs firmadas ni respuestas crudas.
    const message = String(chunk);
    const http = message.match(/(?:HTTP error|Server returned|HTTP\/\S+)[ :]*(\d{3})/i);
    if (http) render.upstreamStatus = Number(http[1]);
    if (/timed? ?out/i.test(message)) render.failure = 'source_timeout';
    else if (http || /Server returned [45]XX|HTTP error|Connection refused|Connection reset|Failed to resolve/i.test(message)) render.failure = 'source_unavailable';
    else if (/Invalid data|Error opening input/i.test(message) && !render.failure) render.failure = 'invalid_audio';
    else if (/No such filter|Error.*filter/i.test(message) && !render.failure) render.failure = 'mixing_error';
  });
  render.process.once('error', () => { render.status = 'failed'; render.failure = 'encoder_unavailable'; });
  render.process.once('exit', (code, signal) => {
    render.exitCode = code;
    render.exitSignal = signal;
    render.status = code === 0 ? 'complete' : 'failed';
    if (signal) render.failure = 'encoder_terminated';
    if (code !== 0 && !render.failure) render.failure = 'encoder_failed';
  });
  return render;
}

async function discardRender(render) {
  if (!render) return;
  if (!render.disposal) {
    render.disposal = (async () => {
      render.process.kill('SIGKILL');
      await render.exited;
      await rm(render.directory, { recursive: true, force: true, maxRetries: 2 });
    })();
  }
  return render.disposal;
}

async function replaceRender(session, tracks, edit, minimum, automatic) {
  const old = session.render;
  let deadline = Date.now() + (automatic ? 5 * 60_000 : 35_000);
  const active = () => !session.closed && !session.endPublished && Date.now() < deadline;
  let candidate;
  let checked = 0;
  try {
    const limits = session.continuationStatus ? { minimum, active, signal: session.abort.signal } : null;
    candidate = await startRender(tracks, session.seconds, old, limits);
    if (!candidate) return;
    session.candidate = candidate;
    if (!automatic) deadline = Date.now() + 35_000;
    while (active()) {
      if (candidate.status === 'failed') break;
      const [current, next] = await Promise.all([
        readManifest(old).catch(() => null), readManifest(candidate).catch(() => null)
      ]);
      const published = session.published;
      // Keep startup headroom in the replacement before retiring the old encoder.
      const previousEnd = automatic ? current?.entries.length : published;
      const hasHeadroom = next && (next.entries.length >= previousEnd + 3 ||
        (next.ended && next.entries.length > previousEnd));
      if (current && (!automatic || current.ended) && hasHeadroom) {
        if (!await identicalSegments(old, candidate, current.entries, next.entries, checked, published)) {
          edit.reason = 'published';
          break;
        }
        checked = published;
        // A GET may have added segments while we were comparing the files.
        if (active() && candidate.status !== 'failed' && session.published === checked) {
          session.render = candidate;
          session.tracks = candidate.tracks;
          session.revision++;
          edit.status = 'applied';
          candidate = null;
          await discardRender(old).catch(() => {});
          return;
        }
      }
      await delay(250);
    }
  } catch {
    edit.reason ||= 'source';
  } finally {
    session.candidate = null;
    await discardRender(candidate).catch(() => {});
    if (edit.status === 'pending') {
      edit.status = 'rejected';
      edit.reason ||= session.endPublished ? 'published' : 'not_ready';
    }
  }
}

function replaceInBackground(session, tracks, edit, minimum, automatic = false) {
  const replacement = { session, automatic };
  replacementInFlight = replacement;
  void replaceRender(session, tracks, edit, minimum, automatic).finally(() => {
    if (replacementInFlight === replacement) replacementInFlight = null;
    if (automatic || (edit.status === 'applied' && session.continuationStatus === 'pending')) {
      session.continuationStatus = edit.status;
      session.continuation = null;
    }
  });
}

function continueFromSegment(session) {
  if (session.continuationStatus !== 'pending' || session.closed) return;
  if (session.endPublished) {
    session.continuationStatus = 'rejected';
    session.continuation = null;
    return;
  }
  if (replacementInFlight) return;
  const tracks = [...session.tracks, ...session.continuation];
  replaceInBackground(session, tracks, { status: 'pending' }, session.tracks.length + 1, true);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, experimental: true, sessions: sessions.size,
      revision: String(process.env.RENDER_GIT_COMMIT || 'local').slice(0, 12), diagnosticsVersion: 4, audius: true, editableMix: true, nativeStart: true });
    if (req.method === 'POST' && url.pathname === '/sessions') {
      if (!authorized(req)) return json(res, 401, { error: 'No autorizado' });
      const data = await requestBody(req);
      const tracks = data?.tracks;
      if (!validTracks(tracks)) return json(res, 400, { error: 'Se requieren 2–3 pistas válidas' });
      const seconds = Number(data.crossfade ?? 6);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10) return json(res, 400, { error: 'Crossfade entre 1 y 10 segundos' });
      const editable = data.editable === true;
      const startAt = editable && Number.isFinite(data.startAt) ? Math.max(0, Math.min(180, data.startAt)) : 0;
      const requestedId = data.id;
      if (requestedId !== undefined && (typeof requestedId !== 'string' || !/^[a-f0-9]{48}$/.test(requestedId) || !editable)) {
        return json(res, 400, { error: 'Identificador de inicio inválido' });
      }
      const continuation = data.continuation;
      if (continuation !== undefined && (!requestedId || data.radio === true ||
          !Array.isArray(continuation) || continuation.length < 1 || tracks.length + continuation.length > maxContinuationTracks ||
          !continuation.every(track => validTrack(track, /^[A-Za-z0-9_-]{11}$/)))) {
        return json(res, 400, { error: 'Cola de continuación inválida' });
      }
      const id = requestedId ?? randomBytes(24).toString('hex');
      const launchKey = requestedId ? JSON.stringify([
        data.radio === true ? tracks[0].id : tracks.map(track => track.id), seconds, startAt, continuation?.map(track => track.id)
      ]) : null;
      const existing = requestedId && sessions.get(id);
      if (existing) {
        if (existing.launchKey !== launchKey) return json(res, 409, { error: 'La sesión ya existe con otra mezcla' });
        return createdSession(res, id, existing.editable);
      }
      if (sessions.size >= 2) return json(res, 429, { error: 'Límite de sesiones' });

      // Reservar antes de esperar I/O para respetar el límite bajo concurrencia.
      const session = { created: Date.now(), editable, seconds, tracks, startAt, launchKey,
        continuation, continuationStatus: continuation ? 'pending' : null, abort: continuation ? new AbortController() : null,
        published: 0, startedAt: null, endPublished: false, render: null, revision: 0, edit: null };
      sessions.set(id, session);
      try {
        session.render = await startRender(tracks, seconds);
        if (sessions.get(id) !== session) {
          await discardRender(session.render);
          return json(res, 404, { error: 'Sesión caducada' });
        }
      } catch {
        sessions.delete(id);
        return json(res, 502, { error: 'El proveedor no entregó audio reproducible para una de las pistas.' });
      }
      return createdSession(res, id, editable);
    }
    const match = /^\/sessions\/([a-f0-9]{48})(?:\/(index\.m3u8|segment-\d{5}\.ts))?$/.exec(url.pathname);
    if (match) {
      // El ID aleatorio es la credencial de reproducción; no se publica ni registra.
      const session = sessions.get(match[1]);
      if (!session) return json(res, 404, { error: 'Sesión caducada' });
      if (req.method === 'DELETE' && !match[2]) {
        if (!authorized(req)) return json(res, 401, { error: 'No autorizado' });
        await dispose(match[1]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PATCH' && !match[2]) {
        if (!authorized(req)) return json(res, 401, { error: 'No autorizado' });
        const data = await requestBody(req);
        if (!session.editable || session.endPublished) return json(res, 409, { error: 'La transición ya se envió al reproductor.' });
        if (replacementInFlight) {
          if (replacementInFlight.session === session && replacementInFlight.automatic) res.setHeader('Retry-After', '1');
          return json(res, 429, { error: 'Hay otro cambio de mezcla en preparación.' });
        }
        const maxTracks = session.continuationStatus ? maxContinuationTracks : 4;
        if (!Number.isInteger(data?.part) || data.part < 0 || data.part >= session.tracks.length ||
            !validTracks(data.tracks, maxTracks) || data.tracks.length <= data.part + 1 ||
            session.tracks.slice(0, data.part + 1).some((t, i) => t.id !== data.tracks[i]?.id)) {
          return json(res, 400, { error: 'El cambio debe conservar las pistas anteriores y la que está sonando.' });
        }
        const editId = typeof data.editId === 'string' && /^[a-f0-9]{32}$/.test(data.editId)
          ? data.editId : randomBytes(16).toString('hex');
        session.edit = { id: editId, status: 'pending' };
        replaceInBackground(session, data.tracks, session.edit, data.part + 2);
        return json(res, 202, { edit: session.edit });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Método no admitido' });
      if (!match[2]) {
        const { status, sources, trackDurations, relayIssues, failure, upstreamStatus, exitCode, exitSignal } = session.render || { status: 'preparing' };
        return json(res, 200, { status, sources, trackDurations, relayIssues, failure, upstreamStatus, exitCode, exitSignal,
          ...(session.continuationStatus && authorized(req) ? { continuationStatus: session.continuationStatus } : {}),
          revision: session.revision, edit: session.edit, ...(session.launchKey ? { tracks: session.tracks } : {}) });
      }
      let bytes;
      try {
        let render = session.render;
        if (match[2] === 'index.m3u8') {
          let manifest;
          do {
            render = session.render;
            manifest = await readManifest(render);
          } while (render !== session.render);
          bytes = session.editable ? publishManifest(session, manifest) : manifest.text;
          if (session.endPublished) continueFromSegment(session);
        } else {
          if (session.editable && segmentIndex(match[2]) >= session.published) {
            return json(res, 404, { error: 'Segmento aún no publicado' });
          }
          try { bytes = await readFile(join(render.directory, match[2])); }
          catch (error) {
            if (render === session.render) throw error;
            bytes = await readFile(join(session.render.directory, match[2]));
          }
          session.lastSegmentAt = Date.now();
          if (session.editable && session.startedAt == null) session.startedAt = session.lastSegmentAt;
          continueFromSegment(session);
        }
      } catch { return json(res, session.render?.status === 'failed' ? 502 : 503, { error: 'Audio todavía no disponible' }); }
      res.writeHead(200, { 'Content-Type': match[2].endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'https://freesong-pied.vercel.app' });
      return res.end(bytes);
    }
    json(res, 404, { error: 'No encontrado' });
  } catch {
    if (!res.headersSent) json(res, 500, { error: 'No se pudo crear la mezcla' });
    else res.end();
  }
});
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
process.on('SIGTERM', async () => {
  server.close();
  await Promise.all([...sessions.keys()].map(dispose));
  process.exit(0);
});

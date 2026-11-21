import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Servicio experimental: una sesión fija de 2–3 pistas, segmentos temporales.
// No se conecta a la PWA hasta validar fuentes, controles y reproducción en iOS.
const key = process.env.MIXER_API_KEY;
if (!key || key.length < 24) throw new Error('MIXER_API_KEY debe tener al menos 24 caracteres');
const backend = process.env.AUDIO_BACKEND || 'https://freesong-pied.vercel.app';
const sessions = new Map();
const ttl = 20 * 60_000;
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
async function dispose(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.process?.kill('SIGKILL');
  // Ruta creada exclusivamente por mkdtemp; nunca se acepta una ruta del cliente.
  await rm(session.directory, { recursive: true, force: true });
}
const sweep = setInterval(() => {
  for (const [id, session] of sessions) if (Date.now() - session.created > ttl) dispose(id).catch(() => {});
}, 30_000);
sweep.unref();

const audiusId = /^audius:([A-Za-z0-9]{1,32})$/;
async function audiusSource(id) {
  const url = new URL(`https://api.audius.co/v1/tracks/${id}/stream`);
  url.searchParams.set('app_name', 'FreeSong');
  const response = await fetch(url, {
    headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(12_000)
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

async function audioSource(track) {
  const audius = audiusId.exec(track.id);
  if (audius) return audiusSource(audius[1]);
  // Resolver desde el mismo host que consume el audio. La ruta de Vercel
  // permanece como respaldo, pero no debe ser la única fuente del mezclador.
  if (process.env.RESOLVE_ON_HOST !== '0') {
    try {
      const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          'User-Agent': 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)' },
        body: JSON.stringify({ videoId: track.id, context: { client: {
          clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2',
          osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'es', gl: 'US'
        } } }), signal: AbortSignal.timeout(6000)
      });
      if (response.ok) {
        const data = await response.json();
        const formats = data.streamingData?.adaptiveFormats || [];
        const format = formats.find(f => f.itag === 140 && f.url) || formats.find(f => f.itag === 139 && f.url);
        if (data.playabilityStatus?.status === 'OK' && format) {
          const url = new URL(format.url);
          if (url.protocol === 'https:' && url.hostname.endsWith('.googlevideo.com')) {
            const probe = await fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(4000) });
            try {
              if ([200,206].includes(probe.status) && /^audio\//i.test(probe.headers.get('content-type') || '')) {
                const reader = probe.body.getReader();
                try { if (!(await reader.read()).done) return url.href; }
                finally { await reader.cancel().catch(() => {}); }
              }
            } finally { if (!probe.body?.locked) await probe.body?.cancel().catch(() => {}); }
          }
        }
      }
    } catch { /* El respaldo se valida posteriormente por el decodificador. */ }
  }
  const source = new URL('/api/stream', backend);
  source.search = new URLSearchParams({ id: track.id, title: track.title, artist: track.artist || '', itag: '140' });
  return source.href;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, experimental: true, sessions: sessions.size,
      revision: String(process.env.RENDER_GIT_COMMIT || 'local').slice(0, 12), diagnosticsVersion: 2, audius: true });
    if (req.method === 'POST' && url.pathname === '/sessions') {
      if (!authorized(req)) return json(res, 401, { error: 'No autorizado' });
      if (sessions.size >= 2) return json(res, 429, { error: 'Límite de sesiones' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 8192) return json(res, 413, { error: 'Solicitud demasiado grande' });
      }
      let data;
      try { data = JSON.parse(body); } catch { return json(res, 400, { error: 'JSON inválido' }); }
      const tracks = data.tracks;
      if (!Array.isArray(tracks) || tracks.length < 2 || tracks.length > 3 || tracks.some(t =>
        !t || typeof t.id !== 'string' || !(/^[A-Za-z0-9_-]{1,64}$/.test(t.id) || audiusId.test(t.id)) ||
        typeof t.title !== 'string' || t.title.length > 200 ||
        (t.artist != null && (typeof t.artist !== 'string' || t.artist.length > 200)))) {
        return json(res, 400, { error: 'Se requieren 2–3 pistas válidas' });
      }
      const seconds = Number(data.crossfade ?? 6);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10) return json(res, 400, { error: 'Crossfade entre 1 y 10 segundos' });
      const id = randomBytes(24).toString('hex');
      // Reservar antes de esperar I/O para respetar el límite bajo concurrencia.
      const session = { created: Date.now(), status: 'preparing', directory: '', process: null };
      sessions.set(id, session);
      try { session.directory = await mkdtemp(join(tmpdir(), 'freesong-mix-')); }
      catch (error) { sessions.delete(id); throw error; }
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
      let sources;
      try { sources = await Promise.all(tracks.map(audioSource)); }
      catch {
        await dispose(id);
        return json(res, 502, { error: 'Audius no entregó audio reproducible para una de las pistas.' });
      }
      session.sources = sources.map((source, i) => {
        if (audiusId.test(tracks[i].id)) return 'audius';
        return new URL(source).hostname.endsWith('.googlevideo.com') ? 'direct' : 'proxy';
      });
      for (const source of sources) args.push('-rw_timeout', '15000000', '-i', source);
      const filters = tracks.map((_, i) => `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=600,asetpts=PTS-STARTPTS[a${i}]`);
      let previous = 'a0';
      for (let i = 1; i < tracks.length; i++) {
        filters.push(`[${previous}][a${i}]acrossfade=d=${seconds}:c1=qsin:c2=qsin[m${i}]`);
        previous = `m${i}`;
      }
      args.push('-filter_complex', filters.join(';'), '-map', `[${previous}]`, '-vn', '-c:a', 'aac', '-b:a', '128k',
        '-threads', '1', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file',
        '-hls_segment_filename', join(session.directory, 'segment-%05d.ts'), join(session.directory, 'index.m3u8'));
      session.process = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      session.process.stderr.on('data', chunk => {
        // Solo categorías: nunca registrar URLs firmadas, cookies ni contenido bruto.
        const message = String(chunk);
        const http = message.match(/(?:HTTP error|Server returned|HTTP\/\S+)[ :]*(\d{3})/i);
        if (http) session.upstreamStatus = Number(http[1]);
        if (/timed? ?out/i.test(message)) session.failure = 'source_timeout';
        else if (http || /Server returned [45]XX|HTTP error|Connection refused|Connection reset|Failed to resolve/i.test(message)) session.failure = 'source_unavailable';
        else if (/Invalid data|Error opening input/i.test(message) && !session.failure) session.failure = 'invalid_audio';
        else if (/No such filter|Error.*filter/i.test(message) && !session.failure) session.failure = 'mixing_error';
      });
      session.process.once('error', () => { session.status = 'failed'; session.failure = 'encoder_unavailable'; });
      session.process.once('exit', (code, signal) => {
        session.exitCode = code;
        session.exitSignal = signal;
        session.status = code === 0 ? 'complete' : 'failed';
        if (signal) session.failure = 'encoder_terminated';
        if (code !== 0 && !session.failure) session.failure = 'encoder_failed';
      });
      return json(res, 202, { id, playlist: `/sessions/${id}/index.m3u8`, status: `/sessions/${id}`, expiresIn: ttl / 1000 });
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
      if (req.method !== 'GET') return json(res, 405, { error: 'Método no admitido' });
      if (!match[2]) return json(res, 200, { status: session.status, sources: session.sources,
        failure: session.failure, upstreamStatus: session.upstreamStatus,
        exitCode: session.exitCode, exitSignal: session.exitSignal });
      let bytes;
      try { bytes = await readFile(join(session.directory, match[2])); }
      catch { return json(res, session.status === 'failed' ? 502 : 503, { error: 'Audio todavía no disponible' }); }
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

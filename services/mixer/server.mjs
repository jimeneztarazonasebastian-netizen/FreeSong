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
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, experimental: true, sessions: sessions.size });
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
        !t || !/^[A-Za-z0-9_-]{1,64}$/.test(t.id) || typeof t.title !== 'string' || t.title.length > 200 ||
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
      for (const track of tracks) {
        const source = new URL('/api/stream', backend);
        source.search = new URLSearchParams({ id: track.id, title: track.title, artist: track.artist || '', itag: '140' });
        args.push('-rw_timeout', '15000000', '-i', source.href);
      }
      const filters = tracks.map((_, i) => `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=600,asetpts=PTS-STARTPTS[a${i}]`);
      let previous = 'a0';
      for (let i = 1; i < tracks.length; i++) {
        filters.push(`[${previous}][a${i}]acrossfade=d=${seconds}:c1=qsin:c2=qsin[m${i}]`);
        previous = `m${i}`;
      }
      args.push('-filter_complex', filters.join(';'), '-map', `[${previous}]`, '-vn', '-c:a', 'aac', '-b:a', '128k',
        '-threads', '1', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file',
        '-hls_segment_filename', join(session.directory, 'segment-%05d.ts'), join(session.directory, 'index.m3u8'));
      session.process = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
      session.process.once('error', () => { session.status = 'failed'; });
      session.process.once('exit', code => { session.status = code === 0 ? 'complete' : 'failed'; });
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
      if (!match[2]) return json(res, 200, { status: session.status });
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

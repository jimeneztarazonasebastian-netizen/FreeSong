import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const key = 'test-only-secret-for-local-mixer-123456';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const tone = frequency => execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=5`, '-f', 'wav', 'pipe:1']);
const waves = [tone(440), tone(880)];
const upstream = http.createServer((req, res) => {
  const index = new URL(req.url, 'http://localhost').searchParams.get('id') === 'one' ? 0 : 1;
  res.writeHead(200, { 'Content-Type': 'audio/wav' });
  res.end(waves[index]);
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:5249';
const child = spawn(process.execPath, ['services/mixer/server.mjs'], {
  env: { ...process.env, PORT: '5249', MIXER_API_KEY: key, RESOLVE_ON_HOST: '0', AUDIO_BACKEND: `http://127.0.0.1:${upstream.address().port}` }, stdio: 'inherit'
});
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/health')).ok) break; } catch {}
    await delay(100);
  }
  assert.equal((await fetch(base + '/sessions', { method: 'POST' })).status, 401);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/sessions', { method: 'POST', headers, body: '{"tracks":[]}' })).status, 400);
  const created = await fetch(base + '/sessions', { method: 'POST', headers,
    body: JSON.stringify({ tracks: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], crossfade: 2 }) });
  assert.equal(created.status, 202);
  const session = await created.json();
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(base + session.status)).json();
    if (state.status !== 'preparing') break;
    await delay(100);
  }
  assert.equal(state.status, 'complete');
  const manifest = await (await fetch(base + session.playlist)).text();
  assert.match(manifest, /#EXT-X-ENDLIST/);
  const total = [...manifest.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((n, m) => n + Number(m[1]), 0);
  assert.ok(Math.abs(total - 8) < 0.2, `Duración de la mezcla incorrecta: ${total}`);
  // Decodificar la zona de solapamiento y comprobar que contiene AMBOS tonos.
  // spawn asíncrono: este mismo proceso atiende el servidor de los WAV.
  const decode = spawn(ffmpeg, ['-v', 'error', '-i', base + session.playlist, '-ss', '3.8', '-t', '0.2', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1']);
  const chunks = [];
  decode.stdout.on('data', b => chunks.push(b));
  const code = await new Promise(resolve => decode.on('close', resolve));
  assert.equal(code, 0);
  const pcm = Buffer.concat(chunks), count = pcm.length / 4;
  assert.ok(count > 1000);
  const amplitude = hz => {
    let real = 0, imag = 0;
    for (let i = 0; i < count; i++) {
      const value = pcm.readFloatLE(i * 4), angle = 2 * Math.PI * hz * i / 8000;
      real += value * Math.cos(angle); imag += value * Math.sin(angle);
    }
    return 2 * Math.hypot(real, imag) / count;
  };
  assert.ok(amplitude(440) > 0.02 && amplitude(880) > 0.02, 'No hay solapamiento real de audio');
  assert.equal((await fetch(base + session.status, { method: 'DELETE', headers })).status, 200);
  assert.equal((await fetch(base + session.status)).status, 404);
  console.log('MIXER OK: autorización, validación, HLS AAC, duración y mezcla real de dos tonos');
} finally {
  child.kill('SIGTERM');
  upstream.close();
}

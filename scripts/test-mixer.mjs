import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mock } from 'node:test';
import { relayPlaybackOrigin, relayUserAgent, resolveEuropeanAudio } from '../services/mixer/european-relay.mjs';

async function verifyEuropeanRelay() {
  const trackId = 'bfl76Sr-Rsk';
  const relay = 'https://eu.yt.chocolatemoo53.com';
  const media = relay + '/videoplayback?dur=321.326&sig=test-only-signature';
  const companion = 'https://eu.yt-comp5.chocolatemoo53.com/companion/videoplayback?sig=test-only-signature';
  const metadata = videoId => Response.json({ videoId, adaptiveFormats: [{ itag: '140', url: media }] });
  const redirect = location => new Response(null, { status: 302, headers: { Location: location } });
  const mp4 = Buffer.alloc(1024);
  mp4.write('ftyp', 4);

  let requests;
  let responses;
  const fetchStub = mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    return responses.shift();
  });
  const logStubs = ['log', 'warn', 'error'].map(method => mock.method(console, method, () => {}));
  async function resolveFrom(...fixtures) {
    requests = [];
    responses = fixtures;
    const result = await resolveEuropeanAudio(trackId);
    assert.equal(responses.length, 0);
    return result;
  }

  try {
    const result = await resolveFrom(metadata(trackId), redirect(companion), new Response(mp4, {
      status: 206,
      headers: { 'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 0-1023/5202363' }
    }));
    assert.deepEqual(result, { kind: 'relay-eu', url: media, duration: 321.326 });
    assert.deepEqual(requests.map(request => request.url), [relay + '/api/v1/videos/' + trackId + '?local=true', media, companion]);
    assert.equal(requests[0].options.redirect, 'error');
    for (const { options } of requests.slice(1)) {
      assert.equal(options.redirect, 'manual');
      assert.deepEqual(options.headers, { 'User-Agent': relayUserAgent, Origin: relayPlaybackOrigin, Range: 'bytes=0-1023' });
    }

    assert.deepEqual(await resolveFrom(metadata('4oxWnLQZnpk')), { issue: 'metadata_format' });
    assert.equal(requests.length, 1);
    assert.deepEqual(await resolveFrom(metadata(trackId), redirect('https://example.invalid/videoplayback?sig=test-only-signature')),
      { issue: 'media_redirect' });
    assert.equal(requests.length, 2);
    assert.deepEqual(await resolveFrom(metadata(trackId), new Response('test-only-upstream-message', { status: 403 })),
      { issue: 'media_403' });
    assert.deepEqual(await resolveFrom(new Response('test-only-upstream-message', { status: 403 })),
      { issue: 'metadata_403' });
    for (const stub of logStubs) assert.equal(stub.mock.callCount(), 0);
  } finally {
    fetchStub.mock.restore();
    for (const stub of logStubs) stub.mock.restore();
  }
  console.log('MIXER RELAY OK: AAC por rango, redirecciones validadas y diagnósticos sin URLs ni datos privados');
}

await verifyEuropeanRelay();

const key = 'test-only-secret-for-local-mixer-123456';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const tone = (frequency, duration = 5) => execFileSync(ffmpeg,
  ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`, '-f', 'wav', 'pipe:1'],
  { maxBuffer: 4 * 1024 * 1024 });
const waves = { one: tone(440), two: tone(880), long: tone(440, 30), three: tone(660) };
const upstream = http.createServer((req, res) => {
  const id = new URL(req.url, 'http://localhost').searchParams.get('id');
  res.writeHead(200, { 'Content-Type': 'audio/wav' });
  res.end(waves[id]);
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

  const tracks = ids => ids.map(id => ({ id, title: id }));
  const editableResponse = await fetch(base + '/sessions', { method: 'POST', headers,
    body: JSON.stringify({ tracks: tracks(['long', 'two']), crossfade: 2, editable: true }) });
  assert.equal(editableResponse.status, 202);
  const editable = await editableResponse.json();
  assert.equal(editable.editable, true);
  async function waitFor(read, predicate, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await read();
      if (predicate(value)) return value;
      await delay(100);
    }
    assert.fail('El flujo de prueba no llegó al estado esperado');
  }
  const list = async () => (await fetch(base + editable.playlist)).text();
  const status = async () => (await fetch(base + editable.status)).json();
  const patch = ids => fetch(base + editable.status, { method: 'PATCH', headers,
    body: JSON.stringify({ part: 0, tracks: tracks(ids) }) });
  const segmentUrl = name => new URL(name, base + editable.playlist);
  const original = await waitFor(list, text => text.includes('segment-00004.ts'));
  assert.doesNotMatch(original, /segment-00007|#EXT-X-ENDLIST/);
  assert.equal((await fetch(segmentUrl('segment-00007.ts'))).status, 404);
  const segment = async name => Buffer.from(await (await fetch(segmentUrl(name))).arrayBuffer());
  const before = await segment('segment-00000.ts');
  assert.equal((await patch(['two', 'three'])).status, 400);
  const replacement = await patch(['long', 'three']);
  assert.equal(replacement.status, 202);
  const applied = await waitFor(status, value => value.edit?.status !== 'pending');
  assert.equal(applied.edit?.status, 'applied', JSON.stringify(applied));
  assert.equal(applied.revision, 1);
  assert.deepEqual(await segment('segment-00000.ts'), before);

  await waitFor(list, text => text.includes('segment-00007.ts'), 18_000);
  const newDecode = spawn(ffmpeg, ['-v', 'error', '-i', segmentUrl('segment-00007.ts').href,
    '-ss', '0.8', '-t', '0.2', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1']);
  const replacementChunks = [];
  newDecode.stdout.on('data', chunk => replacementChunks.push(chunk));
  assert.equal(await new Promise(resolve => newDecode.on('close', resolve)), 0);
  const replacementPcm = Buffer.concat(replacementChunks);
  const replacementAmplitude = hz => {
    let real = 0, imaginary = 0;
    const samples = replacementPcm.length / 4;
    assert.ok(samples > 1000);
    for (let i = 0; i < samples; i++) {
      const value = replacementPcm.readFloatLE(i * 4), angle = 2 * Math.PI * hz * i / 8000;
      real += value * Math.cos(angle);
      imaginary += value * Math.sin(angle);
    }
    return 2 * Math.hypot(real, imaginary) / samples;
  };
  assert.ok(replacementAmplitude(440) > 0.02 && replacementAmplitude(660) > 0.02 && replacementAmplitude(880) < 0.01);
  const advertisedOverlap = await segment('segment-00007.ts');
  assert.equal((await patch(['long', 'two'])).status, 202);
  const rejected = await waitFor(status, value => value.edit?.status === 'rejected');
  assert.equal(rejected.edit.reason, 'published');
  assert.equal(rejected.revision, 1);
  assert.deepEqual(await segment('segment-00007.ts'), advertisedOverlap);
  assert.equal((await fetch(base + editable.status, { method: 'DELETE', headers })).status, 200);
  console.log('MIXER EDIT OK: reemplazo real bajo la misma URL, segmentos previos intactos y transición publicada protegida');
} finally {
  child.kill('SIGTERM');
  upstream.close();
}

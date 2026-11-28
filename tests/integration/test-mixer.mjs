import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { idleSessionMs, publishManifest, sessionExpired } from '../../services/mixer/hls.mjs';
import { mock } from 'node:test';
import { relayPlaybackOrigin, relayUserAgent, resolveMixerRelayAudio } from '../../services/mixer/european-relay.mjs';

async function verifyMixerRelays() {
  const trackId = 'bfl76Sr-Rsk';
  const fallbackTrackId = '4oxWnLQZnpk';
  const relay = 'https://eu.yt.chocolatemoo53.com';
  const usRelay = 'https://yt.chocolatemoo53.com';
  const media = relay + '/videoplayback?dur=321.326&sig=test-only-signature';
  const alternativeMedia = relay + '/videoplayback?dur=321.327&sig=test-only-alternative';
  const opusMedia = relay + '/videoplayback?sig=test-only-opus';
  const usMedia = usRelay + '/videoplayback?dur=241.5&sig=test-only-signature';
  const companion = 'https://eu.yt-comp5.chocolatemoo53.com/companion/videoplayback?sig=test-only-signature';
  const usCompanion = 'https://yt-comp5.chocolatemoo53.com/companion/videoplayback?sig=test-only-signature';
  const metadata = (videoId, url = media) => Response.json({ videoId, adaptiveFormats: [{ itag: '140', url }] });
  const metadataWithAlternative = () => Response.json({
    videoId: trackId,
    adaptiveFormats: [{ itag: '139', url: alternativeMedia }, { itag: '140', url: media }]
  });
  const metadataWithOpus = () => Response.json({
    videoId: trackId, lengthSeconds: 321,
    adaptiveFormats: [{ itag: '251', url: opusMedia }, { itag: '140', url: media }]
  });
  const redirect = location => new Response(null, { status: 302, headers: { Location: location } });
  const forbidden = () => new Response('test-only-upstream-message', { status: 403 });
  const mp4 = Buffer.alloc(1024);
  mp4.write('ftyp', 4);
  const audio = () => new Response(mp4, {
    status: 206, headers: { 'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 0-1023/5202363' }
  });
  const opus = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.of(0x1a, 0x45));
      const tail = new Uint8Array(1022);
      tail.set([0xdf, 0xa3]);
      controller.enqueue(tail);
      controller.close();
    }
  }), {
    status: 206, headers: { 'Content-Type': 'audio/webm; codecs=opus', 'Content-Range': 'bytes 0-1023/51234' }
  });

  let requests;
  let responses;
  const fetchStub = mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    return responses.shift();
  });
  const logStubs = ['log', 'warn', 'error'].map(method => mock.method(console, method, () => {}));
  async function resolveFrom(id, ...fixtures) {
    requests = [];
    responses = fixtures;
    const result = await resolveMixerRelayAudio(id, AbortSignal.timeout(10_500));
    assert.equal(responses.length, 0);
    return result;
  }

  try {
    const result = await resolveFrom(trackId, metadataWithAlternative(), redirect(companion), audio());
    assert.deepEqual(result, { kind: 'relay-eu', url: media, duration: 321.326 });
    assert.deepEqual(requests.map(request => request.url), [relay + '/api/v1/videos/' + trackId + '?local=true', media, companion]);
    assert.equal(requests[0].options.redirect, 'error');
    for (const { options } of requests.slice(1)) {
      assert.equal(options.redirect, 'manual');
      assert.deepEqual(options.headers, { 'User-Agent': relayUserAgent, Origin: relayPlaybackOrigin, Range: 'bytes=0-1023' });
    }

    assert.deepEqual(await resolveFrom(trackId, metadataWithAlternative(), forbidden(), audio()),
      { kind: 'relay-eu', url: alternativeMedia, duration: 321.327 });
    assert.deepEqual(requests.map(request => request.url), [relay + '/api/v1/videos/' + trackId + '?local=true', media, alternativeMedia]);
    assert.equal(requests[2].options.signal, requests[1].options.signal);
    assert.equal(requests[2].options.headers.Range, 'bytes=0-1023');
    assert.deepEqual(await resolveFrom(trackId, metadataWithOpus(), audio()),
      { kind: 'relay-eu', url: media, duration: 321.326 });
    assert.deepEqual(await resolveFrom(trackId, metadataWithOpus(), forbidden(), opus()),
      { kind: 'relay-eu', url: opusMedia, duration: 321 });
    assert.deepEqual(requests.map(request => request.url), [
      relay + '/api/v1/videos/' + trackId + '?local=true', media, opusMedia
    ]);
    const singleFormat = (itag, url) => Response.json({
      videoId: trackId, adaptiveFormats: [{ itag, url }]
    });
    assert.deepEqual(await resolveFrom(trackId, singleFormat('141', media), audio()),
      { kind: 'relay-eu', url: media, duration: 321.326 });
    assert.deepEqual(await resolveFrom(trackId, singleFormat('250', opusMedia), audio(), forbidden()),
      { issue: 'media_format' });
    const disguisedHtml = new Response('<!doctype html><p>Forbidden</p>', {
      status: 206, headers: { 'Content-Type': 'audio/webm', 'Content-Range': 'bytes 0-1023/51234' }
    });
    assert.deepEqual(await resolveFrom(trackId, singleFormat('249', opusMedia), disguisedHtml, forbidden()),
      { issue: 'media_format' });
    const impossibleRange = new Response(mp4, {
      status: 206, headers: { 'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 0-1023/512' }
    });
    assert.deepEqual(await resolveFrom(trackId, metadata(trackId), impossibleRange, forbidden()),
      { issue: 'media_format' });
    assert.deepEqual(await resolveFrom(trackId, metadataWithAlternative(), new Response(null, { status: 429 }), forbidden()),
      { issue: 'media_429' });
    assert.deepEqual(requests.map(request => request.url), [
      relay + '/api/v1/videos/' + trackId + '?local=true', media, usRelay + '/api/v1/videos/' + trackId + '?local=true'
    ]);

    assert.deepEqual(await resolveFrom(trackId, metadata(fallbackTrackId), forbidden()), { issue: 'metadata_format' });
    assert.equal(requests.length, 2);
    assert.deepEqual(await resolveFrom(trackId, metadata(trackId), redirect('https://example.invalid/videoplayback?sig=test-only-signature'), forbidden()),
      { issue: 'media_redirect' });
    assert.equal(requests.length, 3);
    assert.deepEqual(await resolveFrom(trackId, metadata(trackId), forbidden(), forbidden()), { issue: 'media_403' });
    assert.deepEqual(await resolveFrom(trackId, forbidden(), forbidden()), { issue: 'metadata_403' });

    const sabr = () => metadata(fallbackTrackId, relay + '/companion/sabr-segment');
    assert.deepEqual(await resolveFrom(fallbackTrackId, sabr(), metadata(fallbackTrackId, usMedia), redirect(usCompanion), audio()),
      { kind: 'relay-us', url: usMedia, duration: 241.5, relayIssue: 'metadata_no_aac' });
    assert.deepEqual(requests.map(request => request.url), [
      `${relay}/api/v1/videos/${fallbackTrackId}?local=true`, `${usRelay}/api/v1/videos/${fallbackTrackId}?local=true`,
      usMedia, usCompanion
    ]);
    assert.deepEqual(await resolveFrom(fallbackTrackId, sabr(), metadata(trackId, usMedia)), { issue: 'metadata_no_aac' });
    assert.equal(requests.length, 2);
    assert.deepEqual(await resolveFrom(fallbackTrackId, sabr(), metadata(fallbackTrackId, usMedia), redirect(companion)),
      { issue: 'metadata_no_aac' });
    assert.equal(requests.length, 3);
    for (const stub of logStubs) assert.equal(stub.mock.callCount(), 0);
  } finally {
    fetchStub.mock.restore();
    for (const stub of logStubs) stub.mock.restore();
  }
  console.log('MIXER RELAY OK: AAC y Opus del mismo ID, cuerpo por rango y redirecciones validadas');
}

await verifyMixerRelays();

const key = 'test-only-secret-for-local-mixer-123456';
assert.equal(sessionExpired({ created: 0 }, idleSessionMs), true);
assert.equal(sessionExpired({ created: 0, lastSegmentAt: 31 * 60_000 }, 38 * 60_000), false);
assert.equal(sessionExpired({ created: 0, lastSegmentAt: 31 * 60_000 }, 51 * 60_000), true);
assert.equal(sessionExpired({ created: 0, lastSegmentAt: 59 * 60_000 }, 60 * 60_000), true);
assert.equal(sessionExpired({ created: 0, launchKey: 'native' }, 89_999), false);
assert.equal(sessionExpired({ created: 0, launchKey: 'native' }, 90_000), true);
assert.equal(sessionExpired({ created: 0, launchKey: 'native', lastSegmentAt: 10_000 }, 90_000), false);
const entries = Array.from({ length: 30 }, (_, index) => ({
  line: '#EXTINF:4.0,', duration: 4, file: `segment-${String(index).padStart(5, '0')}.ts`
}));
const delayed = { startAt: 61, startedAt: null, published: 0, editable: true };
const encoded = { text: '#EXTM3U', entries };
assert.match(publishManifest(delayed, encoded, 0), /#EXT-X-START:TIME-OFFSET=61,PRECISE=YES/);
assert.equal(delayed.published, 21);
delayed.startedAt = 1000;
assert.equal(publishManifest(delayed, encoded, 13_000).includes('segment-00023.ts'), true);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const tone = (frequency, duration = 5, container = 'wav', sampleRate = 44100) => execFileSync(ffmpeg,
  ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}:sample_rate=${sampleRate}`, '-f', container, 'pipe:1'],
  { maxBuffer: 4 * 1024 * 1024 });
const fixtures = { one: tone(440), two: tone(880, 5, 'webm'), long: tone(440, 30), three: tone(660) };
const queueTrackSeconds = 168;
const queueFade = 4;
const queueTracks = Array.from({ length: 11 }, (_, n) => ({
  id: `longTone${String(n + 1).padStart(3, '0')}`,
  title: `Pista de prueba ${n + 1}`,
  duration: queueTrackSeconds,
  frequency: 320 + n * 80
}));
const queueSeconds = queueTracks.length * queueTrackSeconds - (queueTracks.length - 1) * queueFade;
const upstreamRequests = [];
const upstream = http.createServer((req, res) => {
  const query = new URL(req.url, 'http://localhost').searchParams;
  upstreamRequests.push(Object.fromEntries(query));
  const id = query.get('id');
  if (!Object.hasOwn(fixtures, id)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': id === 'two' ? 'audio/webm' : 'audio/wav' });
  res.end(fixtures[id]);
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:5249';
// Keep FFmpeg and the test deadlines on real time. Advance only the server's
// media clock after the continuation has been encoded.
const clockModule = `data:text/javascript,${encodeURIComponent(`
  const realNow = Date.now.bind(Date);
  let offset = 0;
  Date.now = () => realNow() + offset;
  process.on('message', message => {
    if (message?.type !== 'clock-offset') return;
    offset = message.offset;
    process.send({ offset });
  });
`)}`;
const child = spawn(process.execPath, ['--import', clockModule, 'services/mixer/server.mjs'], {
  env: { ...process.env, PORT: '5249', MIXER_API_KEY: key, RESOLVE_ON_HOST: '0', AUDIO_BACKEND: `http://127.0.0.1:${upstream.address().port}` },
  stdio: ['inherit', 'inherit', 'inherit', 'ipc']
});
async function seekTestClock(seconds) {
  const receipt = once(child, 'message');
  child.send({ type: 'clock-offset', offset: seconds * 1000 });
  const [message] = await receipt;
  assert.equal(message.offset, seconds * 1000);
}

function checkLongQueueAudio(pcm) {
  const sampleRate = 8000;
  const sampleCount = pcm.length / 2;
  assert.ok(Math.abs(sampleCount / sampleRate - queueSeconds) < 0.3, 'Duración de audio real de la cola');
  const windowSize = sampleRate / 10;
  for (let start = windowSize; start + 2 * windowSize <= sampleCount; start += windowSize) {
    let squared = 0;
    for (let i = 0; i < windowSize; i++) {
      const sample = pcm.readInt16LE((start + i) * 2);
      squared += sample * sample;
    }
    assert.ok(Math.sqrt(squared / windowSize) > 200, `Corte de audio a los ${start / sampleRate} s`);
  }
  function amplitude(seconds, frequency) {
    const start = Math.round(seconds * sampleRate);
    const length = sampleRate / 5;
    let real = 0, imaginary = 0;
    for (let i = 0; i < length; i++) {
      const sample = pcm.readInt16LE((start + i) * 2) / 32768;
      const angle = 2 * Math.PI * frequency * i / sampleRate;
      real += sample * Math.cos(angle);
      imaginary += sample * Math.sin(angle);
    }
    return 2 * Math.hypot(real, imaginary) / length;
  }
  for (let next = 1; next < queueTracks.length; next++) {
    const middle = next * (queueTrackSeconds - queueFade) + queueFade / 2;
    assert.ok(amplitude(middle, queueTracks[next - 1].frequency) > 0.025 &&
      amplitude(middle, queueTracks[next].frequency) > 0.025,
    `Falta el fundido de pista ${next} a ${next + 1} cerca de ${middle} s`);
  }
}
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/health')).ok) break; } catch {}
    await delay(100);
  }
  assert.equal((await fetch(base + '/sessions', { method: 'POST' })).status, 401);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/sessions', { method: 'POST', headers, body: '{"tracks":[]}' })).status, 400);
  const created = await fetch(base + '/sessions', { method: 'POST', headers,
    body: JSON.stringify({ tracks: [{ id: 'one', title: 'One', artist: 'Singer', duration: 5 }, { id: 'two', title: 'Two' }], crossfade: 2 }) });
  assert.equal(created.status, 202);
  const session = await created.json();
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(base + session.status)).json();
    if (state.status !== 'preparing') break;
    await delay(100);
  }
  assert.equal(state.status, 'complete');
  assert.deepEqual(upstreamRequests.slice(0, 2), [
    { id: 'one', itag: '140', audio: '1', title: 'One', artist: 'Singer', dur: '5' },
    { id: 'two', itag: '140', audio: '1' }
  ]);
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
  async function waitFor(read, predicate, ms = 10_000, message = 'El flujo de prueba no llegó al estado esperado') {
    const deadline = Date.now() + ms;
    let value;
    while (Date.now() < deadline) {
      value = await read();
      if (predicate(value)) return value;
      await delay(100);
    }
    assert.fail(`${message}${typeof value === 'object' ? ': ' + JSON.stringify(value) : ''}`);
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

  const nativeId = 'a'.repeat(48);
  const nativeRequest = (ids, options = {}) => fetch(base + '/sessions', {
    method: 'POST', headers,
    body: JSON.stringify({ id: nativeId, tracks: tracks(ids), crossfade: 2, editable: true, radio: true, ...options })
  });
  const nativeResponses = await Promise.all([
    nativeRequest(['one', 'two']),
    nativeRequest(['one', 'three'])
  ]);
  assert.ok(nativeResponses.every(response => response.status === 202));
  const [native, duplicate] = await Promise.all(nativeResponses.map(response => response.json()));
  assert.deepEqual(native, duplicate);
  assert.equal(native.id, nativeId);
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.nativeStart, true);
  assert.equal(health.sessions, 1);
  assert.equal((await nativeRequest(['two', 'one'])).status, 409);
  assert.equal((await nativeRequest(['one', 'two'], { radio: false })).status, 409);
  const nativeState = await (await fetch(base + native.status)).json();
  assert.equal(nativeState.tracks[0].id, 'one');
  assert.ok(['two', 'three'].includes(nativeState.tracks[1].id));
  const initial = await waitFor(async () => (await fetch(base + native.playlist)).text(), text => text.includes('segment-00000.ts'));
  assert.match(initial, /^#EXTM3U/);
  const nativeSegment = await fetch(new URL('segment-00000.ts', base + native.playlist));
  assert.equal(nativeSegment.status, 200);
  assert.ok((await nativeSegment.arrayBuffer()).byteLength > 0);
  assert.equal((await fetch(base + native.status, { method: 'DELETE', headers })).status, 200);
  console.log('MIXER INICIO NATIVO OK: GET válido de HLS, creación concurrente idempotente y cola original conservada');

  for (const { id, frequency } of queueTracks) fixtures[id] = tone(frequency, queueTrackSeconds, 'wav', 8000);
  const queueId = 'b'.repeat(48);
  const queueMetadata = queueTracks.map(({ id, title, duration }) => ({ id, title, duration }));
  const unavailableTrack = { id: 'longTone999', title: 'Pista sin fuente de prueba', duration: queueTrackSeconds };
  const queueRequest = {
    id: queueId,
    tracks: queueMetadata.slice(0, 3),
    continuation: [...queueMetadata.slice(3), unavailableTrack],
    crossfade: queueFade,
    editable: true
  };
  const queueResponse = await fetch(base + '/sessions', {
    method: 'POST', headers, body: JSON.stringify(queueRequest)
  });
  assert.equal(queueResponse.status, 202);
  const longQueue = await queueResponse.json();
  try {
    const queueManifestUrl = base + longQueue.playlist;
    const readQueueManifest = async () => (await fetch(queueManifestUrl)).text();
    const readQueueState = async () => (await fetch(base + longQueue.status, { headers })).json();
    const readSegment = async name => {
      const response = await fetch(new URL(name, queueManifestUrl));
      assert.equal(response.status, 200, `El segmento anunciado ${name} debe seguir disponible`);
      return Buffer.from(await response.arrayBuffer());
    };
    const originalManifest = await waitFor(readQueueManifest, text => text.includes('segment-00000.ts'));
    assert.doesNotMatch(originalManifest, /#EXT-X-ENDLIST/, 'El primer bloque no puede anunciar el final de toda la cola');
    const initialQueueState = await readQueueState();
    assert.equal(initialQueueState.continuationStatus, 'pending', 'El servidor conserva la cola antes de iniciar el audio');
    assert.deepEqual(initialQueueState.tracks.map(track => track.id), queueMetadata.slice(0, 3).map(track => track.id));
    const firstSegment = await readSegment('segment-00000.ts');
    const continued = await waitFor(readQueueState, state => ['rejected', 'applied'].includes(state.continuationStatus),
      120_000, 'El primer segmento debe iniciar la continuación en el servidor');
    assert.equal(continued.continuationStatus, 'applied', JSON.stringify(continued));
    assert.deepEqual(continued.tracks.map(track => track.id), queueMetadata.map(track => track.id),
      'Una fuente caída al final no debe descartar las demás pistas de la extensión');
    assert.ok(upstreamRequests.some(request => request.id === unavailableTrack.id), 'La prueba incluye una fuente tardía caída');
    assert.deepEqual(await readSegment('segment-00000.ts'), firstSegment, 'La extensión conserva el prefijo publicado');
    const encodedQueue = await waitFor(readQueueState, state => ['complete', 'failed'].includes(state.status),
      180_000, 'La cola real debe terminar de codificarse para acelerar el reloj');
    assert.equal(encodedQueue.status, 'complete', JSON.stringify(encodedQueue));

    // Desde el primer segmento, solo el servidor extiende la mezcla. Un
    // cliente HLS bloqueado puede seguir pidiendo el mismo manifiesto y sus
    // segmentos sin ejecutar JavaScript que prepare o cambie otra fuente.
    const transport = [];
    let published = [];
    let finalManifest = '';
    for (let elapsed = 0; elapsed <= queueSeconds + 16; elapsed += 16) {
      await seekTestClock(elapsed);
      const manifestText = await readQueueManifest();
      assert.match(manifestText, /^#EXTM3U/);
      const entries = [...manifestText.matchAll(/^#EXTINF:([\d.]+),[^\r\n]*\r?\n(segment-\d{5}\.ts)$/gm)]
        .map(([, seconds, file]) => ({ seconds: Number(seconds), file }));
      assert.deepEqual(entries.slice(0, published.length), published, 'El manifiesto EVENT solo crece');
      for (const { file } of entries.slice(published.length)) {
        transport.push(await readSegment(file));
      }
      published = entries;
      if (manifestText.includes('#EXT-X-ENDLIST')) {
        finalManifest = manifestText;
        break;
      }
    }
    assert.match(finalManifest, /#EXT-X-ENDLIST/, 'La cola completa debe terminar dentro de la ventana simulada');
    const advertisedSeconds = published.reduce((sum, entry) => sum + entry.seconds, 0);
    assert.ok(Math.abs(advertisedSeconds - queueSeconds) < 0.3, 'El final no se anuncia en el primer bloque');
    const queueDecoder = spawn(ffmpeg,
      ['-v', 'error', '-f', 'mpegts', '-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    const decoded = [];
    const errors = [];
    queueDecoder.stdout.on('data', data => decoded.push(data));
    queueDecoder.stderr.on('data', data => errors.push(data));
    const finished = once(queueDecoder, 'close');
    queueDecoder.stdin.end(Buffer.concat(transport));
    const [exitCode] = await finished;
    assert.equal(exitCode, 0, Buffer.concat(errors).toString());
    checkLongQueueAudio(Buffer.concat(decoded));
    console.log(`MIXER COLA LARGA OK: ${queueSeconds} s, ${published.length} segmentos y ${queueTracks.length - 1} fundidos sin cortes bajo la misma URL`);
  } finally {
    assert.equal((await fetch(base + longQueue.status, { method: 'DELETE', headers })).status, 200);
    await seekTestClock(0);
  }

  const unavailableResponse = await fetch(base + '/sessions', {
    method: 'POST', headers,
    body: JSON.stringify({ ...queueRequest, id: 'c'.repeat(48), continuation: [unavailableTrack] })
  });
  assert.equal(unavailableResponse.status, 202);
  const unavailable = await unavailableResponse.json();
  try {
    const listUrl = base + unavailable.playlist;
    const statusUrl = base + unavailable.status;
    const originalSegmentUrl = new URL('segment-00000.ts', listUrl);
    await waitFor(async () => (await fetch(listUrl)).text(), text => text.includes('segment-00000.ts'));
    const sound = await fetch(originalSegmentUrl);
    assert.equal(sound.status, 200);
    const baseline = Buffer.from(await sound.arrayBuffer());
    const state = await waitFor(async () => (await fetch(statusUrl, { headers })).json(),
      value => value.continuationStatus === 'rejected', 20_000);
    assert.deepEqual(state.tracks.map(track => track.id), queueMetadata.slice(0, 3).map(track => track.id));
    assert.equal(state.revision, 0);
    const after = await fetch(originalSegmentUrl);
    assert.equal(after.status, 200);
    assert.deepEqual(Buffer.from(await after.arrayBuffer()), baseline, 'La fuente caída no corta la mezcla actual');
  } finally {
    assert.equal((await fetch(base + unavailable.status, { method: 'DELETE', headers })).status, 200);
  }
  console.log('MIXER FUENTE CAÍDA OK: una extensión fallida conserva el bloque original');
} finally {
  child.kill('SIGTERM');
  upstream.close();
}

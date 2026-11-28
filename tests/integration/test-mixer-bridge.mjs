import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mixerControl } from '../../api/_mixer.js';
const originalFetch = globalThis.fetch;
const originalKey = process.env.MIXER_API_KEY;
const id = 'a'.repeat(48);
let forwarded = null;
async function call(method, origin, body, session, query = {}, headers = {}) {
  const req = { method, body, headers: { origin, 'x-forwarded-for': String(Math.random()), ...headers } };
  let result;
  const responseHeaders = {};
  const res = {
    setHeader(name, value) { responseHeaders[name] = value; },
    status(code) { this.code = code; return this; },
    end() { result = { code: this.code, headers: responseHeaders }; },
    json(data) { result = { code: this.code, headers: responseHeaders, data }; }
  };
  const url = new URL('https://freesong-pied.vercel.app/api/health?mixer=1');
  if (session) url.searchParams.set('session', session);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  await mixerControl(req, res, url);
  return result;
}
try {
  delete process.env.MIXER_API_KEY;
  assert.equal((await call('GET')).data.configured, false);
  assert.equal((await call('GET')).data.wakeUrl, undefined);
  assert.equal((await call('GET')).data.nativeStart, undefined);
  assert.equal((await call('POST')).code, 503);
  process.env.MIXER_API_KEY = 'server-only-test-secret';
  globalThis.fetch = async (url, options) => {
    forwarded = { url, options };
    return new Response(JSON.stringify({ id, expiresIn: 1200 }), { status: 202, headers: { 'content-type': 'application/json' } });
  };
  assert.equal((await call('GET')).data.wakeUrl, 'https://freesong-mixer.onrender.com/health');
  assert.equal((await call('GET')).data.nativeStart, true);
  assert.equal((await call('POST', 'https://unrelated.test', {})).code, 403);
  assert.equal(forwarded, null);
  const result = await call('POST', 'https://freesong-pied.vercel.app', { tracks: [{ id: 'one' }, { id: 'two' }], crossfade: 6 });
  assert.equal(result.code, 202);
  assert.equal(forwarded.options.headers.Authorization, 'Bearer server-only-test-secret');
  assert.equal(JSON.stringify(result).includes('server-only-test-secret'), false);
  assert.equal(result.data.playlist, `https://freesong-mixer.onrender.com/sessions/${id}/index.m3u8`);
  assert.equal((await call('GET', null, null, '../health')).code, 400);
  globalThis.fetch = async () => new Response(JSON.stringify({ trackDurations: [321.326, null, '281', 601, 99] }));
  assert.deepEqual((await call('GET', null, null, id)).data.trackDurations, [321.326, null, null, null, 99]);
  globalThis.fetch = async () => new Response('{}', { status: 401 });
  assert.equal((await call('GET', null, null, id)).code, 502);
  console.log('MIXER BRIDGE OK: clave privada, origen, rutas, configuración y errores');

  const native = {
    nativeStart: '1', ids: 'bfl76Sr-Rsk,4oxWnLQZnpk', fade: '6',
    metadata: JSON.stringify([
      { id: 'bfl76Sr-Rsk', title: 'Stereo Love', artist: 'Edward Maya', duration: 321 },
      { id: 'mismatch-id', title: 'Ignorar', artist: 'Otro', duration: 240 }
    ])
  };
  const addresses = [];
  let checks = 0;
  let creations = 0;
  const sameListener = { 'x-forwarded-for': 'test-listener' };
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    addresses.push(path);
    if (path === '/health') return Response.json({ ok: true, nativeStart: true });
    if (path === '/sessions') {
      creations++;
      assert.equal(options.headers.Authorization, 'Bearer server-only-test-secret');
      const request = JSON.parse(options.body);
      assert.equal(request.id, id);
      assert.deepEqual(request.tracks.map(track => track.id), ['bfl76Sr-Rsk', '4oxWnLQZnpk']);
      assert.deepEqual(request.tracks.map(({ title, artist, duration }) => [title, artist, duration]),
        [['Stereo Love', 'Edward Maya', 321], ['', '', null]]);
      assert.equal(request.crossfade, 6);
      assert.equal(request.editable, true);
      return Response.json({ id }, { status: 202 });
    }
    assert.equal(path, `/sessions/${id}/index.m3u8`);
    if (++checks === 1) return new Response('Preparando', { status: 503 });
    return new Response('#EXTM3U\n#EXTINF:4.0,\nsegment-00000.ts\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  };
  assert.equal((await call('HEAD', null, null, id, native)).code, 200);
  assert.equal((await call('POST', null, null, id, native)).code, 405);
  assert.equal((await call('GET', null, null, id, native, { 'sec-fetch-site': 'cross-site' })).code, 403);
  assert.equal((await call('GET', null, null, id, native, { referer: 'https://another.example/' })).code, 403);
  assert.equal((await call('GET', null, null, id, { ...native, ids: 'bfl76Sr-Rsk,https://unsafe.example' })).code, 400);
  assert.equal((await call('GET', null, null, id, { ...native, ids: 'bfl76Sr-Rsk' })).code, 400);
  assert.equal((await call('GET', null, null, id, { ...native, startAt: '181' })).code, 400);
  assert.equal(addresses.length, 0);
  const prod = 'https://freesong-pied.vercel.app';
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  try {
    const manifest = await call('GET', null, null, id, native, sameListener);
    assert.equal(manifest.code, 307);
    assert.equal(manifest.headers.Location, `https://freesong-mixer.onrender.com/sessions/${id}/index.m3u8`);
    assert.equal(manifest.headers['Cache-Control'], 'no-store');
    assert.equal(manifest.headers['Referrer-Policy'], 'no-referrer');
    assert.equal(JSON.stringify(manifest).includes('server-only-test-secret'), false);
    assert.deepEqual(addresses, ['/health', '/sessions', `/sessions/${id}/index.m3u8`, `/sessions/${id}/index.m3u8`]);
    assert.equal(creations, 1);
    const limitedNative = await call('GET', null, null, 'f'.repeat(48), native, sameListener);
    assert.equal(limitedNative.code, 429);
    assert.equal(limitedNative.headers['Retry-After'], '15');

    now += 10_250;
    const repeated = await call('GET', null, null, id, native, sameListener);
    assert.equal(repeated.code, 307);
    assert.equal(repeated.headers['Retry-After'], undefined);
    const limitedPost = await call('POST', prod, { tracks: [] }, null, {}, sameListener);
    assert.equal(limitedPost.code, 429);
    assert.equal(limitedPost.headers['Retry-After'], '5');
    assert.equal(creations, 2);

    now += 4750;
    globalThis.fetch = async () => Response.json({ id }, { status: 202 });
    const allowedPost = await call('POST', prod, { tracks: [] }, null, {}, sameListener);
    assert.equal(allowedPost.code, 202);
    assert.equal(allowedPost.headers['Retry-After'], undefined);
  } finally {
    clock.mock.restore();
  }
  let resumePolls = 0;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/health') return Response.json({ ok: true, nativeStart: true });
    if (path === '/sessions') {
      assert.equal(JSON.parse(options.body).startAt, 43);
      return Response.json({ id }, { status: 202 });
    }
    const startAt = ++resumePolls === 1 ? 0 : 43;
    return new Response(`#EXTM3U\n#EXT-X-START:TIME-OFFSET=${startAt},PRECISE=YES\n#EXTINF:4.0,\nsegment-00000.ts\n`,
      { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  };
  assert.equal((await call('GET', null, null, id, { ...native, startAt: '43' })).code, 307);
  assert.equal(resumePolls, 2, 'No debe empezar desde cero mientras se prepara la posición guardada');
  assert.equal((await call('POST', prod, { id, tracks: [] })).code, 400);
  globalThis.fetch = async url => {
    assert.equal(new URL(url).pathname, '/health', 'No debe crearse una sesión en un Render antiguo');
    return Response.json({ ok: true });
  };
  assert.equal((await call('GET', null, null, id, native)).code, 503);
  const longIds = Array.from({ length: 12 }, (_, index) => `LongTrack${String(index).padStart(2, '0')}`);
  const longQueue = {
    ...native, ids: longIds.slice(0, 3).join(','), tail: longIds.slice(3).join(','),
    tailSeconds: longIds.slice(3).map(() => 168).join(',')
  };
  let longCreations = 0;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/health') return Response.json({ ok: true, nativeStart: true });
    if (path === '/sessions') {
      longCreations++;
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload.tracks.map(track => track.id), longIds.slice(0, 3));
      assert.deepEqual(payload.continuation.map(track => track.id), longIds.slice(3));
      assert.deepEqual(payload.continuation.map(track => track.duration), Array(9).fill(168));
      return Response.json({ id }, { status: 202 });
    }
    return new Response('#EXTM3U\n#EXTINF:4.0,\nsegment-00000.ts\n',
      { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  };
  assert.equal((await call('GET', null, null, id, { ...longQueue, tail: longQueue.tail + ',LongTrack12' })).code, 400);
  assert.equal((await call('GET', null, null, id, { ...longQueue, tail: '../untrusted' })).code, 400);
  assert.equal((await call('GET', null, null, id, { ...longQueue, tailSeconds: '168,601' })).code, 400);
  assert.equal((await call('GET', null, null, id, longQueue)).code, 307);
  assert.equal(longCreations, 1);
  globalThis.fetch = async () => Response.json({
    continuationStatus: 'applied',
    tracks: longIds.map(id => ({ id, title: id, duration: 168 })),
    trackDurations: longIds.map(() => 168)
  });
  const expanded = (await call('GET', null, null, id)).data;
  assert.equal(expanded.continuationStatus, 'applied');
  assert.deepEqual(expanded.tracks.map(track => track.id), longIds);
  assert.equal(expanded.trackDurations.length, 12);
  globalThis.fetch = async () => Response.json({ error: 'Preparando' }, { status: 429, headers: { 'Retry-After': '1' } });
  const waiting = await call('PATCH', prod, { tracks: [] }, id);
  assert.equal(waiting.code, 429);
  assert.equal(waiting.headers['Retry-After'], '1');
  let radioCreations = 0;
  globalThis.fetch = async (url, options) => {
    const address = new URL(url);
    if (address.hostname === 'music.youtube.com') {
      const entry = (id, title, length) => ({ playlistPanelVideoRenderer: {
        videoId: id, title: { runs: [{ text: title }] },
        longBylineText: { runs: [{ text: 'Artista' }] },
        lengthText: { runs: [{ text: length }] }
      } });
      return Response.json({ continuationContents: { playlistPanelContinuation: { contents: [
        entry('bfl76Sr-Rsk', 'Semilla', '4:41'), entry('hAt1b21aQQM', 'Muy corta', '0:04'),
        entry('4oxWnLQZnpk', 'Elegible', '4:00')
      ] } } });
    }
    if (address.pathname === '/health') return Response.json({ ok: true, nativeStart: true });
    assert.equal(address.pathname, '/sessions');
    radioCreations++;
    const request = JSON.parse(options.body);
    assert.equal(request.radio, true);
    assert.deepEqual(request.tracks.map(track => [track.id, track.title, track.duration]), [
      ['bfl76Sr-Rsk', 'Semilla', 281], ['4oxWnLQZnpk', 'Elegible', 240]
    ]);
    // Renderer failure is handled without exposing upstream internals.
    return Response.json({ error: 'Audio falló en el origen' }, { status: 502 });
  };
  assert.equal((await call('GET', null, null, id, { ...native, ids: 'bfl76Sr-Rsk', radio: '1' })).code, 502);
  assert.equal(radioCreations, 1);
  globalThis.fetch = async () => Response.json({ tracks: [
    { id: '4oxWnLQZnpk', title: 'Elegible', artist: 'Artista', duration: 240, thumbnail: 'http://unsafe.example' }
  ] });
  assert.deepEqual((await call('GET', null, null, id)).data.tracks, [{
    id: '4oxWnLQZnpk', title: 'Elegible', artist: 'Artista', duration: 240,
    thumbnail: 'https://i.ytimg.com/vi/4oxWnLQZnpk/hqdefault.jpg'
  }]);
  globalThis.fetch = async () => Response.json({ tracks: [{ id: 'wrong', title: 'Unsafe' }] });
  assert.equal((await call('GET', null, null, id)).data.tracks, undefined);
  console.log('MIXER INICIO NATIVO OK: segmento antes de redirigir, origen, límite de solicitudes y compatibilidad');
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.MIXER_API_KEY;
  else process.env.MIXER_API_KEY = originalKey;
}

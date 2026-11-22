import assert from 'node:assert/strict';
import handler, { parseStreamRange, serveBuffer } from '../api/stream.js';

const audio = Buffer.from('0123456789');
const respond = (raw, full = false, method = 'GET') => serveBuffer(
  audio, { method, headers: raw ? { range: raw } : {} }, null, false, parseStreamRange(raw, full), full
);

for (const raw of ['bytes=-', 'bytes=-0', 'bytes=8-2', 'bytes=0-1,4-5', 'bytes=9007199254740992-', 'xbytes=0-1']) {
  assert.equal(parseStreamRange(raw), null, `Debe rechazar ${raw}`);
}
assert.equal(parseStreamRange('bytes=0-99999999').header, 'bytes=0-2097151');
assert.equal(parseStreamRange('bytes=-99999999').header, 'bytes=-2097152');
assert.equal(parseStreamRange('bytes=4-', true).header, 'bytes=4-');

for (const [range, expected, contentRange] of [
  ['bytes=0-1', '01', 'bytes 0-1/10'],
  ['bytes=8-', '89', 'bytes 8-9/10'],
  ['bytes=-3', '789', 'bytes 7-9/10'],
  ['bytes=-100', '0123456789', 'bytes 0-9/10'],
  ['bytes=5-99', '56789', 'bytes 5-9/10']
]) {
  const res = respond(range);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), contentRange);
  assert.equal(await res.text(), expected);
}
const invalid = respond('bytes=10-');
assert.equal(invalid.status, 416, 'Un seek fuera del audio no debe regresar al inicio');
assert.equal(invalid.headers.get('content-range'), 'bytes */10');
assert.equal(await invalid.text(), '');
const full = respond(null, true);
assert.equal(full.status, 200);
assert.equal(full.headers.get('content-range'), null);
assert.equal(full.headers.get('cache-control'), 'private, no-store');
assert.equal(await full.text(), '0123456789');
assert.equal(await respond('bytes=3-5', true).text(), '345', 'full no debe ampliar un rango explícito');
const head = respond(null, false, 'HEAD');
assert.equal(head.status, 200);
assert.equal(head.headers.get('content-length'), '10');
assert.equal(await head.text(), '');

// Mismo comportamiento para la respuesta de Node usada por Vercel.
const nodeRes = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } };
serveBuffer(audio, { method: 'GET', headers: { range: 'bytes=11-' } }, nodeRes, true, parseStreamRange('bytes=11-'), false);
assert.equal(nodeRes.statusCode, 416);
assert.equal(nodeRes.headers['Content-Range'], 'bytes */10');

// La ruta completa conserva un 416 del relay, sin descargar otra canción.
const originalFetch = globalThis.fetch;
let requests = 0;
try {
  globalThis.fetch = async (url) => {
    requests++;
    if (String(url).includes('/api/v1/videos/')) {
      return Response.json({ adaptiveFormats: [{ itag: 140, mimeType: 'audio/mp4', url: 'https://audio.example.test/song.m4a' }] });
    }
    assert.equal(String(url), 'https://audio.example.test/song.m4a');
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */10' } });
  };
  const response = await handler({ method: 'GET', url: '/api/stream?id=range-test-1&itag=140', headers: { range: 'bytes=20-' } });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), 'bytes */10');
  assert.equal(requests, 2, 'Un rango inválido no debe disparar respaldos externos');
} finally {
  globalThis.fetch = originalFetch;
}

const savedRelays = process.env.INVIDIOUS_INSTANCES;
const requestedHosts = [];
try {
  process.env.INVIDIOUS_INSTANCES = 'https://relay-one.test,https://relay-two.test';
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    requestedHosts.push(url.host + url.pathname);
    if (url.pathname.startsWith('/api/v1/videos/')) {
      return Response.json({ adaptiveFormats: [{ itag: 140, mimeType: 'audio/mp4', url: url.origin + '/audio' }] });
    }
    assert.equal(options.headers.Range, 'bytes=0-1');
    if (url.hostname === 'relay-one.test') return new Response('No disponible', { status: 403 });
    assert.equal(url.hostname, 'relay-two.test');
    return new Response('01', { status: 206, headers: { 'Content-Range': 'bytes 0-1/10', 'Content-Type': 'audio/mp4' } });
  };
  const response = await handler({ method: 'GET', url: '/api/stream?id=relay-fallback&itag=140', headers: { range: 'bytes=0-1' } });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '01');
  assert.deepEqual(requestedHosts, [
    'relay-one.test/api/v1/videos/relay-fallback', 'relay-one.test/audio',
    'relay-two.test/api/v1/videos/relay-fallback', 'relay-two.test/audio'
  ]);
} finally {
  if (savedRelays === undefined) delete process.env.INVIDIOUS_INSTANCES;
  else process.env.INVIDIOUS_INSTANCES = savedRelays;
  globalThis.fetch = originalFetch;
}

const relayMedia = new URL('https://yt.chocolatemoo53.com/videoplayback');
relayMedia.search = new URLSearchParams({
  host: 'rr2---sn-a.googlevideo.com', source: 'youtube', mime: 'audio/mp4',
  itag: '140', sig: 'signature', lsig: 'location-signature', clen: '10',
  expire: String(Math.floor(Date.now() / 1000) + 60)
});
const serveRelay = (media, range, method = 'GET') => handler({
  url: '/api/stream?' + new URLSearchParams({ id: 'range-test-1', relayMedia: media, full: '1' }),
  headers: { range }, method
});

try {
  const hosts = [];
  globalThis.fetch = async (url, options) => {
    hosts.push(url.host);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Range, 'bytes=7-9');
    if (url.host === relayMedia.host) {
      return new Response(null, { status: 307, headers: { Location: `https://yt-comp2.chocolatemoo53.com${url.pathname}${url.search}` } });
    }
    return new Response('789', { status: 206, headers: { 'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 7-9/10' } });
  };
  const response = await serveRelay(relayMedia, 'bytes=-3');
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '789');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(hosts, [relayMedia.host, 'yt-comp2.chocolatemoo53.com']);
  assert.equal((await serveRelay(relayMedia, 'bytes=10-')).status, 416);
  assert.equal((await serveRelay('https://elsewhere.test/videoplayback', 'bytes=0-1')).status, 400);
  const ambiguous = new URL(relayMedia);
  ambiguous.searchParams.append('host', 'other.test');
  assert.equal((await serveRelay(ambiguous, 'bytes=0-1')).status, 400);
  assert.equal(hosts.length, 2);

  let redirected = false;
  globalThis.fetch = async (url) => {
    if (url.host !== relayMedia.host) redirected = true;
    return new Response(null, { status: 307, headers: { Location: `https://elsewhere.test${url.pathname}${url.search}` } });
  };
  assert.equal((await serveRelay(relayMedia, 'bytes=0-1')).status, 502);
  assert.equal(redirected, false);
} finally {
  globalThis.fetch = originalFetch;
}
console.log('STREAM RANGES OK: rangos de Safari, 416 y siguiente relay si falla el audio');

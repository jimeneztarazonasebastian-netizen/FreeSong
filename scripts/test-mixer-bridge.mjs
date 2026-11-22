import assert from 'node:assert/strict';
import { mixerControl } from '../api/_mixer.js';
const originalFetch = globalThis.fetch;
const originalKey = process.env.MIXER_API_KEY;
const id = 'a'.repeat(48);
let forwarded = null;
async function call(method, origin, body, session) {
  const req = { method, body, headers: { origin, 'x-forwarded-for': String(Math.random()) } };
  let result;
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(data) { result = { code: this.code, data }; } };
  await mixerControl(req, res, new URL('https://freesong-pied.vercel.app/api/health?mixer=1' + (session ? '&session=' + session : '')));
  return result;
}
try {
  delete process.env.MIXER_API_KEY;
  assert.equal((await call('GET')).data.configured, false);
  assert.equal((await call('GET')).data.wakeUrl, undefined);
  assert.equal((await call('POST')).code, 503);
  process.env.MIXER_API_KEY = 'server-only-test-secret';
  globalThis.fetch = async (url, options) => {
    forwarded = { url, options };
    return new Response(JSON.stringify({ id, expiresIn: 1200 }), { status: 202, headers: { 'content-type': 'application/json' } });
  };
  assert.equal((await call('GET')).data.wakeUrl, 'https://freesong-mixer.onrender.com/health');
  assert.equal((await call('POST', 'https://unrelated.test', {})).code, 403);
  assert.equal(forwarded, null);
  const result = await call('POST', 'https://freesong-pied.vercel.app', { tracks: [{ id: 'one' }, { id: 'two' }], crossfade: 6 });
  assert.equal(result.code, 202);
  assert.equal(forwarded.options.headers.Authorization, 'Bearer server-only-test-secret');
  assert.equal(JSON.stringify(result).includes('server-only-test-secret'), false);
  assert.equal(result.data.playlist, `https://freesong-mixer.onrender.com/sessions/${id}/index.m3u8`);
  assert.equal((await call('GET', null, null, '../health')).code, 400);
  globalThis.fetch = async () => new Response(JSON.stringify({ trackDurations: [321.326, null, '281', 601, 99] }));
  assert.deepEqual((await call('GET', null, null, id)).data.trackDurations, [321.326, null, null, null]);
  globalThis.fetch = async () => new Response('{}', { status: 401 });
  assert.equal((await call('GET', null, null, id)).code, 502);
  console.log('MIXER BRIDGE OK: clave privada, origen, rutas, configuración y errores');
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.MIXER_API_KEY;
  else process.env.MIXER_API_KEY = originalKey;
}

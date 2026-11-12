// Prueba de humo de descargas offline (Chrome headless).
//
// Cubre los dos caminos que puede tomar downloadTrack():
//  1. Relay directo con CORS y Range (evita los 502 del proxy de Vercel).
//  2. Proxy /api/stream por fragmentos con `audio=1` cuando el relay no tiene
//     el vídeo.
// Comprueba que el blob queda en Cache API y en la biblioteca de descargas.
//
// Uso: node scripts/test-download.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.DOWNLOAD_TEST_PORT) || 5201;
const BASE = `http://127.0.0.1:${PORT}`;

function makeWav(seconds = 4, rate = 8000) {
  const samples = seconds * rate;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i / rate) * Math.PI * 2 * 440) * 2200), 44 + i * 2);
  }
  return buf;
}

const WAV = makeWav();
const TRACKS = [
  {
    id: 'test-relay',
    title: 'Descarga por relay',
    artist: 'Artista de prueba',
    duration: 4,
    durationSeconds: 4,
    durationText: '0:04',
    thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0n1ZcAAAAASUVORK5CYII='
  },
  {
    id: 'test-proxy',
    title: 'Descarga por proxy',
    artist: 'Artista de prueba',
    duration: 4,
    durationSeconds: 4,
    durationText: '0:04',
    thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0n1ZcAAAAASUVORK5CYII='
  }
];

const AUDIO_HEADERS = {
  'Content-Type': 'audio/wav',
  'Accept-Ranges': 'bytes',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
  'Cache-Control': 'no-store'
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
  });
}

async function rangeResponse(route, request) {
  if (request.method() === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: AUDIO_HEADERS, body: '' });
  }
  if (request.method() === 'HEAD') {
    return route.fulfill({
      status: 200,
      headers: { ...AUDIO_HEADERS, 'Content-Length': String(WAV.length) },
      body: ''
    });
  }
  const range = request.headers()['range'];
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), WAV.length - 1) : WAV.length - 1;
      const slice = WAV.subarray(start, end + 1);
      return route.fulfill({
        status: 206,
        headers: {
          ...AUDIO_HEADERS,
          'Content-Range': `bytes ${start}-${end}/${WAV.length}`,
          'Content-Length': String(slice.length)
        },
        body: slice
      });
    }
  }
  return route.fulfill({
    status: 200,
    headers: { ...AUDIO_HEADERS, 'Content-Length': String(WAV.length) },
    body: WAV
  });
}

async function startServer() {
  const child = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return child;
    } catch {}
    await delay(100);
  }
  child.kill();
  throw new Error(`El servidor local no respondió en ${BASE}`);
}

async function waitPlaying(page, timeout = 12000) {
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('audio')).some((a) => !a.paused && a.currentTime > 0.05);
  }, null, { timeout });
}

async function downloadCurrent(page, id) {
  await page.evaluate(() => document.getElementById('playerDownloadBtn')?.click());
  await page.waitForFunction(
    (trackId) => {
      try {
        const list = JSON.parse(localStorage.getItem('fs_downloads') || '[]');
        return Array.isArray(list) && list.some((d) => d && d.id === trackId);
      } catch {
        return false;
      }
    },
    id,
    { timeout: 25000 }
  );
  const size = await page.evaluate(async (trackId) => {
    const cache = await caches.open('freesong-offline-audio-v1');
    const res = await cache.match('/offline-audio/' + trackId);
    if (!res) return 0;
    const blob = await res.blob();
    return blob.size;
  }, id);
  assert.ok(size >= 1000, `La copia offline de ${id} quedó vacía (${size} bytes)`);
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio']
  });

  const pageErrors = [];
  const audioRequests = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'block'
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));

    await page.route('**/*', async (route, request) => {
      const url = new URL(request.url());
      const host = url.host.toLowerCase();

      if (url.origin === BASE) {
        if (url.pathname === '/api/search') return json(route, { tracks: TRACKS, items: TRACKS, continuation: null });
        if (url.pathname === '/api/stream') {
          audioRequests.push(url.searchParams.get('audio'));
          // El proxy de Vercel se simula caído para la primera pista: solo el
          // relay directo puede completar esa descarga.
          if (url.searchParams.get('id') === 'test-relay') {
            return json(route, { error: 'STREAM_UNAVAILABLE' }, 502);
          }
          return rangeResponse(route, request);
        }
        if (url.pathname === '/api/relay-info') return json(route, { instances: ['https://relay.test'] });
        if (url.pathname === '/api/suggestions') return json(route, { queries: [] });
        if (url.pathname === '/api/lyrics') return json(route, { syncedLyrics: '', plainLyrics: '' });
        if (url.pathname === '/api/queue') return json(route, { tracks: [] });
        if (url.pathname === '/api/health') return json(route, { ok: true, version: 'test' });
        if (url.pathname === '/api/home') {
          return json(route, { shelves: [{ title: 'Mezcla de prueba', items: TRACKS }] });
        }
        if (url.pathname === '/api/artist' || url.pathname === '/api/album' || url.pathname === '/api/playlist') {
          return json(route, {});
        }
        return route.continue();
      }

      if ((host === 'relay.test' || host === 'yt.chocolatemoo53.com') && /\/api\/v1\/videos\//.test(url.pathname)) {
        if (url.pathname.includes('test-relay')) {
          return json(route, {
            adaptiveFormats: [{
              itag: 140,
              mimeType: 'audio/mp4; codecs="mp4a.40.2"',
              clen: WAV.length,
              url: 'https://relay.test/audio.wav?video=test-relay'
            }]
          });
        }
        // La segunda pista no está en la instancia.
        return json(route, { error: 'Video unavailable' }, 500);
      }
      if ((host === 'relay.test' || host === 'yt.chocolatemoo53.com') && url.pathname === '/api/v1/search') {
        return json(route, []);
      }
      if (host === 'relay.test' && url.pathname === '/audio.wav') {
        return rangeResponse(route, request);
      }
      if (host === 'yt.chocolatemoo53.com') {
        return json(route, { error: 'test' }, 503);
      }
      return route.abort();
    });

    await page.goto(`${BASE}/?v=download-test`, { waitUntil: 'load' });
    await page.waitForSelector('[data-nav="search"]');
    await page.evaluate(() => document.querySelector('[data-nav="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForSelector('#searchInput');
    await page.fill('#searchInput', 'descarga');
    await page.waitForSelector('#searchResultsList [data-search-idx]', { timeout: 8000 });

    // 1. Relay directo: el proxy devuelve 502, así que la descarga solo puede
    //    completarse si usa la URL del relay.
    await page.evaluate(() => {
      document.querySelectorAll('#searchResultsList [data-search-idx]')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitPlaying(page);
    await waitTrack(page, 'test-relay');
    await downloadCurrent(page, 'test-relay');
    assert.equal(
      audioRequests.filter((a) => a === '1').length,
      0,
      'La descarga por relay no debe pedir fragmentos con audio=1 al proxy'
    );

    // 2. Proxy por fragmentos: la instancia no tiene el vídeo y el proxy sirve
    //    el audio. Debe usar `audio=1` (solo pista de audio, sin vídeo).
    await page.evaluate(() => {
      document.querySelectorAll('#searchResultsList [data-search-idx]')[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitPlaying(page);
    await waitTrack(page, 'test-proxy');
    const before = audioRequests.filter((a) => a === '1').length;
    await downloadCurrent(page, 'test-proxy');
    const after = audioRequests.filter((a) => a === '1').length;
    assert.ok(after > before, 'La descarga por proxy debe pedir /api/stream?audio=1');

    assert.deepEqual(pageErrors, [], `Errores de página: ${pageErrors.join(' | ')}`);
    console.log('DESCARGAS OK');
  } finally {
    await browser.close();
    server.kill();
  }
}

async function waitTrack(page, id) {
  await page.waitForFunction((trackId) => {
    try {
      const saved = JSON.parse(localStorage.getItem('fs_last_track') || 'null');
      return saved && saved.id === trackId;
    } catch {
      return false;
    }
  }, id, { timeout: 8000 });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

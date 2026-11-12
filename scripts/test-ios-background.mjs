// Regresión: reproducción con la pantalla bloqueada / app en segundo plano (iPhone).
//
// Fallo real: al bloquear el iPhone la música dejaba de sonar y al volver la
// canción aparecía en 0:00. En iOS no se puede abrir una fuente nueva ni
// arrancar YouTube Web sin gesto, y `currentTime` puede resetearse a 0.
//
// Esta prueba emula iPhone y comprueba:
//  1. Un error de stream en segundo plano NO cambia `src` ni salta a YouTube.
//  2. La posición real se conserva aunque iOS la resetee a 0.
//  3. Al volver a primer plano la canción se recupera donde iba (no en 0:00).
//
// No usa internet: intercepta /api/* y sirve un WAV local.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const PORT = 5224;
const BASE = `http://127.0.0.1:${PORT}`;
const RELAY = 'https://yt.chocolatemoo53.com';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const SONG_SECONDS = 20;

const TRACKS = Array.from({ length: 3 }, (_, i) => ({
  id: `bg-${i + 1}`,
  title: `Cancion fondo ${i + 1}`,
  artist: 'Artista de prueba',
  duration: SONG_SECONDS,
  durationSeconds: SONG_SECONDS,
  durationText: '0:20',
  thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0n1ZcAAAAASUVORK5CYII='
}));

function makeWav(seconds = SONG_SECONDS, rate = 8000) {
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
    buf.writeInt16LE(Math.round(Math.sin((i / rate) * Math.PI * 2 * 440) * 2500), 44 + i * 2);
  }
  return buf;
}
const WAV = makeWav();
const AUDIO_HEADERS = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };

function json(route, body, status = 200) {
  return route.fulfill({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function streamAudio(route, request) {
  if (request.method() === 'HEAD') {
    return route.fulfill({ status: 200, headers: { ...AUDIO_HEADERS, 'Content-Length': String(WAV.length) }, body: '' });
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
        headers: { ...AUDIO_HEADERS, 'Content-Range': `bytes ${start}-${end}/${WAV.length}`, 'Content-Length': String(slice.length) },
        body: slice
      });
    }
  }
  return route.fulfill({ status: 200, headers: { ...AUDIO_HEADERS, 'Content-Length': String(WAV.length) }, body: WAV });
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
  throw new Error('servidor local no disponible');
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  });
  const pageErrors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', userAgent: IOS_UA });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));

    await page.route('**/*', async (route, request) => {
      const url = new URL(request.url());
      const host = url.host.toLowerCase();
      if (url.origin === BASE) {
        if (url.pathname === '/api/search') return json(route, { tracks: TRACKS, items: TRACKS, continuation: null });
        if (url.pathname === '/api/stream') return streamAudio(route, request);
        if (url.pathname === '/api/relay-info') return json(route, { instances: [RELAY] });
        if (url.pathname === '/api/suggestions') return json(route, { queries: [] });
        if (url.pathname === '/api/lyrics') return json(route, { syncedLyrics: '', plainLyrics: '' });
        if (url.pathname === '/api/queue') return json(route, { tracks: [] });
        if (url.pathname === '/api/health') return json(route, { ok: true, version: 'test' });
        if (url.pathname === '/api/home') return json(route, { shelves: [] });
        if (url.pathname === '/api/artist' || url.pathname === '/api/album' || url.pathname === '/api/playlist') return json(route, {});
        return route.continue();
      }
      if (host === 'yt.chocolatemoo53.com') {
        if (url.pathname === '/api/v1/search') return json(route, []);
        const match = /^\/api\/v1\/videos\/([^/]+)$/.exec(url.pathname);
        if (match) {
          return json(route, {
            videoId: decodeURIComponent(match[1]),
            adaptiveFormats: [
              { itag: '140', mimeType: 'audio/mp4', url: `${RELAY}/audio/${encodeURIComponent(match[1])}.m4a`, clen: WAV.length }
            ]
          });
        }
        if (url.pathname.startsWith('/audio/')) return streamAudio(route, request);
        return route.fulfill({ status: 404, body: '{}' });
      }
      if (host === 'i.ytimg.com' || host.endsWith('googleusercontent.com')) {
        return route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'image/png' },
          body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0n1ZcAAAAASUVORK5CYII=', 'base64')
        });
      }
      return route.abort();
    });

    await page.goto(`${BASE}/?v=ios-bg`, { waitUntil: 'load' });
    await page.waitForSelector('[data-nav="search"]');
    await page.evaluate(() => document.querySelector('[data-nav="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForSelector('#searchInput');
    await page.fill('#searchInput', 'fondo');
    await page.waitForSelector('#searchResultsList [data-search-idx]', { timeout: 8000 });
    await page.evaluate(() => document.querySelector('#searchResultsList [data-search-idx]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('audio')).some((a) => !a.paused && a.currentTime > 0.2 && a.dataset.trackId === 'bg-1'),
      null,
      { timeout: 12000 }
    );

    // Deja correr para que la posición conocida supere 1 s.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('audio')).some((a) => !a.paused && a.currentTime > 1.5 && a.dataset.trackId === 'bg-1'),
      null,
      { timeout: 12000 }
    );

    // --- Pasa a segundo plano (pantalla bloqueada) ---
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const beforeError = await page.evaluate(() => {
      const deck = Array.from(document.querySelectorAll('audio')).find((a) => !a.paused || a.currentTime > 1);
      return { id: deck?.id || '', src: deck?.src || '', time: deck?.currentTime || 0, token: deck?.dataset.sourceToken || '' };
    });
    assert.ok(beforeError.time > 1.5, `La canción debía ir avanzada antes del fallo (${beforeError.time})`);

    // Falla real del stream (conexión cortada por el proxy) con la pantalla
    // bloqueada: iOS además suele resetear currentTime a 0.
    await page.evaluate(() => {
      const deck = Array.from(document.querySelectorAll('audio')).find((a) => a.dataset.trackId === 'bg-1');
      if (!deck) return;
      try { deck.currentTime = 0; } catch {}
      deck.dispatchEvent(new Event('error'));
    });

    await delay(1800);

    const whileHidden = await page.evaluate(() => {
      const deck = Array.from(document.querySelectorAll('audio')).find((a) => a.dataset.trackId === 'bg-1');
      const iframes = Array.from(document.querySelectorAll('iframe'));
      return {
        src: deck?.src || '',
        token: deck?.dataset.sourceToken || '',
        youtubeFrames: iframes.filter((f) => /youtube/.test(f.src || '')).length,
        title: document.getElementById('playerTitle')?.textContent || ''
      };
    });

    assert.equal(whileHidden.src, beforeError.src, 'En segundo plano no debe cambiarse el src del deck');
    assert.equal(whileHidden.token, beforeError.token, 'En segundo plano no debe abrirse una fuente nueva');
    assert.equal(whileHidden.youtubeFrames, 0, 'En segundo plano no debe arrancarse el reproductor de YouTube');
    assert.match(whileHidden.title, /Cancion fondo 1/, `No debe saltar de canción en segundo plano: ${whileHidden.title}`);

    // --- Vuelve a primer plano ---
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('audio')).some((a) => !a.paused && a.currentTime > 1.5 && a.dataset.trackId === 'bg-1'),
      null,
      { timeout: 15000 }
    );

    const resumed = await page.evaluate(() => {
      const deck = Array.from(document.querySelectorAll('audio')).find((a) => !a.paused && a.currentTime > 0.2);
      return { time: deck?.currentTime || 0, trackId: deck?.dataset.trackId || '' };
    });
    assert.equal(resumed.trackId, 'bg-1', 'Debe reanudar la misma canción');
    assert.ok(resumed.time > 1.5, `Debe reanudar donde iba, no en 0:00 (reanudó en ${resumed.time.toFixed(2)} s)`);

    assert.deepEqual(pageErrors, [], `Errores JS: ${pageErrors.join(' | ')}`);
    console.log('IOS BACKGROUND OK');
    console.log('  en segundo plano: no cambia src, no salta a YouTube y no pierde la pista');
    console.log(`  al volver: reanuda en ${resumed.time.toFixed(1)} s (no en 0:00)`);
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
}

run().catch((err) => {
  console.error('IOS BACKGROUND FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});

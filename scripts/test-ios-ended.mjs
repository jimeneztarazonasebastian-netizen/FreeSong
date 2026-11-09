// Regresión: fin de pista en iPhone.
//
// Fallo real: al terminar una canción en iPhone no empezaba la siguiente.
// Safari no siempre permite hacer play() sin gesto en el deck precargado
// (nunca se reprodujo) y además puede perder el evento `ended` al final.
//
// Esta prueba emula el UA de iPhone, sirve un relay directo falso y comprueba:
//  1. El cambio automático usa el mismo <audio> que ya estaba sonando.
//  2. La pista siguiente suena de verdad (no solo cambia el título).
//  3. Si el deck se detiene al final sin `ended`, igualmente avanza.
//  4. No salta dos pistas por detectar el final dos veces.
//
// No usa internet: intercepta /api/* y sirve un WAV local.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const PORT = 5222;
const BASE = `http://127.0.0.1:${PORT}`;
const RELAY = 'https://yt.chocolatemoo53.com';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const SONG_SECONDS = 8;

const TRACKS = Array.from({ length: 4 }, (_, i) => ({
  id: `ios-${i + 1}`,
  title: `Cancion iPhone ${i + 1}`,
  artist: 'Artista de prueba',
  duration: SONG_SECONDS,
  durationSeconds: SONG_SECONDS,
  durationText: '0:08',
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

const playingDeck = (page) =>
  page.evaluate(() => {
    const deck = Array.from(document.querySelectorAll('audio')).find((a) => !a.paused && a.currentTime > 0.15);
    return deck ? { id: deck.id, trackId: deck.dataset.trackId || '' } : null;
  });

async function waitForTrackPlaying(page, trackId, timeout = 12000) {
  await page.waitForFunction(
    (id) => Array.from(document.querySelectorAll('audio')).some((a) => !a.paused && a.currentTime > 0.15 && a.dataset.trackId === id),
    trackId,
    { timeout }
  );
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
        if (url.pathname === '/api/lyrics') {
          const track = url.searchParams.get('track') || '';
          return json(route, { syncedLyrics: `[00:00.00]Letra de ${track}`, plainLyrics: `Letra de ${track}` });
        }
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

    await page.goto(`${BASE}/?v=ios-end`, { waitUntil: 'load' });
    await page.waitForSelector('[data-nav="search"]');
    await page.evaluate(() => document.querySelector('[data-nav="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForSelector('#searchInput');
    await page.fill('#searchInput', 'iphone');
    await page.waitForSelector('#searchResultsList [data-search-idx]', { timeout: 8000 });
    await page.evaluate(() => document.querySelector('#searchResultsList [data-search-idx]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await waitForTrackPlaying(page, 'ios-1');
    const firstDeck = await playingDeck(page);
    assert.equal(firstDeck.trackId, 'ios-1');

    // El segundo deck queda precargado (camino que antes rompía iOS).
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('audio')).some((a) => !!a.dataset.prefetchedId),
      null,
      { timeout: 12000 }
    );

    // 1) Fin natural: debe seguir en el mismo deck ya desbloqueado.
    await page.waitForFunction(
      () => /Cancion iPhone 2/.test(document.getElementById('playerTitle')?.textContent || ''),
      null,
      { timeout: 16000 }
    );
    await waitForTrackPlaying(page, 'ios-2');
    const afterEnd = await playingDeck(page);
    assert.equal(afterEnd.id, firstDeck.id, 'iOS debe reutilizar el deck que ya sonó, no el precargado sin desbloquear');

    // 2) iOS pierde `ended`: el deck se detiene al final y aun así avanza.
    await page.evaluate(() => {
      const deck = Array.from(document.querySelectorAll('audio')).find((a) => !a.paused && a.currentTime > 0.15);
      if (deck && isFinite(deck.duration)) {
        deck.currentTime = Math.max(0, deck.duration - 0.4);
        deck.pause();
      }
    });
    await page.waitForFunction(
      () => /Cancion iPhone 3/.test(document.getElementById('playerTitle')?.textContent || ''),
      null,
      { timeout: 8000 }
    );
    await waitForTrackPlaying(page, 'ios-3');
    await delay(1500);
    const stable = await page.evaluate(() => document.getElementById('playerTitle')?.textContent || '');
    assert.match(stable, /Cancion iPhone 3/, `Saltó dos pistas seguidas: ${stable}`);

    assert.deepEqual(pageErrors, [], `Errores JS: ${pageErrors.join(' | ')}`);
    console.log('IOS ENDED OK');
    console.log('  fin natural: usa el mismo deck y suena la pista 2');
    console.log('  sin evento ended: el respaldo por posición avanza a la pista 3');
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
}

run().catch((err) => {
  console.error('IOS ENDED FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});

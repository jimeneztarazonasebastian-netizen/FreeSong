// Integra la interfaz con un puente simulado; no sustituye una prueba de AVPlayer/iOS.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
const port = 5232, base = `http://127.0.0.1:${port}`;
const tracks = [{ id: 'native-one', title: 'Nativa uno', artist: 'Prueba', duration: 191 }, { id: 'native-two', title: 'Nativa dos', artist: 'Prueba', duration: 200 }];
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base)).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
  await context.addInitScript(() => {
    window.nativeCalls = [];
    window.nativeState = { trackId: '', index: -1, position: 0, duration: 0, playing: false, paused: true };
    window.nativeQueue = [];
    window.Capacitor = {
      getPlatform: () => 'ios', isPluginAvailable: () => true,
      addListener(plugin, event, fn) { window.nativeStateListener = fn; },
      async nativePromise(plugin, method, options = {}) {
        window.nativeCalls.push({ method, options });
        if (method === 'getState') return { ...window.nativeState, queue: window.nativeQueue };
        if (method === 'configure') { if (options.queue) window.nativeQueue = options.queue; return {}; }
        if (method === 'play') {
          window.nativeQueue = options.queue;
          window.nativeState = { requestId: options.requestId, index: options.index, trackId: options.queue[options.index].id,
            position: options.position || 1, duration: 380.975, source: 'relay', playing: true, paused: false, buffering: false, crossfading: false, error: '' };
        }
        if (method === 'pause') window.nativeState = { ...window.nativeState, playing: false, paused: true };
        if (method === 'resume') window.nativeState = { ...window.nativeState, playing: true, paused: false };
        if (method === 'seek') window.nativeState.position = options.position;
        window.nativeStateListener?.(window.nativeState);
        return {};
      }
    };
  });
  const page = await context.newPage();
  const errors = [], audioRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    if (route.request().url().includes('/api/stream')) audioRequests.push(route.request().url());
    const body = route.request().url().includes('/api/search') ? { tracks, items: tracks } : { shelves: [], tracks: [], queries: [], instances: [] };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://**/*', route => route.abort());
  await page.goto(base, { waitUntil: 'load' });
  await page.locator('[data-nav="search"]').first().click();
  await page.locator('#searchInput').fill('nativa');
  await page.locator('#searchResultsList [data-search-idx]').first().click();
  await page.waitForFunction(() => window.FreeSongDiag.report().playback.engine === 'avplayer' && window.FreeSongDiag.report().playback.isPlaying);
  assert.equal(await page.locator('#playerDurTime').textContent(), '6:20', 'La duración mostrada procede del motor, no de los 191 s de búsqueda');
  assert.equal(await page.locator('#settingCrossfadeToggle').isDisabled(), false);
  assert.equal(await page.evaluate(() => navigator.mediaSession.playbackState), 'none', 'MediaSession no debe competir con Now Playing nativo');
  await page.locator('#miniPlayBtn').click();
  await page.waitForFunction(() => window.FreeSongDiag.report().playback.isPlaying === false);
  await page.locator('#miniPlayBtn').click();
  await page.waitForFunction(() => window.FreeSongDiag.report().playback.isPlaying === true);
  await page.evaluate(() => { const seek = document.getElementById('playerSeek'); seek.value = 50; seek.dispatchEvent(new Event('input')); });
  assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.method === 'seek').at(-1).options.position), 190.4875);
  await page.waitForFunction(() => window.nativeQueue.length >= 2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.nativeState = { ...window.nativeState, index: 1, trackId: window.nativeQueue[1].id, position: 4, duration: 200, crossfading: true };
    window.nativeStateListener(window.nativeState);
  });
  await page.waitForFunction(() => document.getElementById('playerTitle').textContent === 'Nativa dos');
  assert.equal(await page.evaluate(() => window.FreeSongDiag.report().playback.crossfading), true);
  assert.equal(audioRequests.length, 0, 'La interfaz nativa no debe arrancar el proxy HTML ni otro audio');
  assert.deepEqual(errors, []);
  console.log('UI NATIVA OK: play, pausa, reanudación, seek real, cambio oculto, crossfade y un único propietario del audio (puente simulado)');
} finally { await browser?.close(); server.kill(); }

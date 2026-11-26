// Cuando el relay solo ofrece SABR/403 y el proxy devuelve 502, la app debe caer
// al reproductor de YouTube Web tanto en escritorio como en iPhone PWA,
// usar la vía rápida en la sesión y respetar controles y segundo plano.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const PORT = 5221;
const BASE = `http://127.0.0.1:${PORT}`;
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const TRACKS = Array.from({ length: 2 }, (_, i) => ({
  id: `sabr-${i + 1}`,
  title: `Cancion sabr ${i + 1}`,
  artist: 'Artista sabr',
  duration: 60,
  durationSeconds: 60,
  durationText: '1:00',
  thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0n1ZcAAAAASUVORK5CYII='
}));

const json = (route, body, status = 200) => route.fulfill({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Stub mínimo del IFrame API de YouTube: registra cargas, seeks, pausas y reproducciones.
const YT_STUB = `
window.__ytCurrentTime = 10;
window.__ytSeeks = [];
window.__ytPlays = 0;
window.__ytPauses = 0;
window.__ytStateVal = -1;
window.YT = {
  Player: function (el, opts) {
    var self = this;
    window.__ytState = function (d) {
      window.__ytStateVal = d;
      if (opts && opts.events && opts.events.onStateChange) opts.events.onStateChange({ data: d });
    };
    self.loadVideoById = function (o) {
      window.__ytLoaded = (o && o.videoId) || o;
      window.__ytCurrentTime = (o && o.startSeconds) || 0;
      window.__ytState(3);
      window.__ytCurrentTime = 10;
      window.__ytState(1);
    };
    self.playVideo = function () { window.__ytPlays++; window.__ytState(1); };
    self.pauseVideo = function () { window.__ytPauses++; window.__ytStateVal = 2; };
    self.stopVideo = function () { window.__ytStateVal = 0; };
    self.getPlayerState = function () { return window.__ytStateVal; };
    self.getCurrentTime = function () { return window.__ytCurrentTime; };
    self.getDuration = function () { return 60; };
    self.seekTo = function (sec) { window.__ytSeeks.push(sec); window.__ytCurrentTime = sec; };
    self.setVolume = function () {};
    self.setPlaybackRate = function () {};
    setTimeout(function () { if (opts && opts.events && opts.events.onReady) opts.events.onReady({ target: self }); }, 10);
  }
};
setTimeout(function () { if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady(); }, 50);
`;

async function server() {
  const child = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/`)).ok) return child; } catch {} await delay(100); }
  child.kill(); throw new Error('no server');
}

async function setupRoutes(page, onStream) {
  await page.route('**/*', async (route, request) => {
    const url = new URL(request.url());
    if (url.origin === BASE) {
      if (url.pathname === '/api/search') return json(route, { tracks: TRACKS, items: TRACKS, continuation: null });
      if (url.pathname === '/api/stream') {
        if (onStream) onStream(url.searchParams.get('id'));
        return json(route, { error: 'sin audio', code: 'STREAM_UNAVAILABLE' }, 502);
      }
      if (url.pathname === '/api/relay-info') return json(route, { instances: [] });
      if (url.pathname === '/api/suggestions' || url.pathname === '/api/queue') return json(route, { queries: [], tracks: [] });
      if (url.pathname === '/api/lyrics') return json(route, { syncedLyrics: '[00:00.00]Letra', plainLyrics: 'Letra' });
      if (url.pathname === '/api/home') return json(route, { shelves: [] });
      if (url.pathname === '/api/health') return json(route, { ok: true, version: 'test' });
      return route.continue();
    }
    if (url.host === 'www.youtube.com' && url.pathname === '/iframe_api') {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'application/javascript' }, body: YT_STUB });
    }
    if (url.host === 'eu.yt.chocolatemoo53.com' || url.host === 'yt.chocolatemoo53.com') {
      if (url.pathname.startsWith('/api/v1/videos/')) {
        return json(route, {
          adaptiveFormats: [
            { itag: 140, mimeType: 'audio/mp4', url: `${url.origin}/companion/sabr-segment?video_id=${url.pathname.split('/').pop()}&itag=140` }
          ]
        });
      }
      if (url.pathname === '/api/v1/search') return json(route, []);
    }
    if (url.host === 'i.ytimg.com' || url.host.endsWith('googleusercontent.com')) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'image/png' }, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0n1ZcAAAAASUVORK5CYII=', 'base64') });
    }
    return route.abort();
  });
}

const child = await server();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const logs = [];
try {
  // 1) Escritorio
  const desktopCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const desktopPage = await desktopCtx.newPage();
  desktopPage.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text().slice(0, 140)}`); });
  desktopPage.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await setupRoutes(desktopPage);

  await desktopPage.goto(`${BASE}/?v=sabr`, { waitUntil: 'load' });
  await desktopPage.waitForSelector('[data-nav="search"]');
  await desktopPage.evaluate(() => document.querySelector('[data-nav="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await desktopPage.waitForSelector('#searchInput');
  await desktopPage.fill('#searchInput', 'sabr');
  await desktopPage.waitForSelector('#searchResultsList [data-search-idx]', { timeout: 8000 });
  await desktopPage.evaluate(() => document.querySelector('#searchResultsList [data-search-idx]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  await desktopPage.waitForFunction(() => window.__ytLoaded === 'sabr-1', null, { timeout: 10000 });
  await desktopPage.waitForTimeout(300);
  const state = await desktopPage.evaluate(() => ({
    loaded: window.__ytLoaded,
    title: document.getElementById('playerTitle')?.textContent,
    spinner: /animate-spin/.test(document.getElementById('miniPlayBtn')?.innerHTML || ''),
    paused: /i-play/.test(document.getElementById('miniPlayBtn')?.innerHTML || '')
  }));
  console.log('escritorio:', JSON.stringify(state));
  assert.equal(state.loaded, 'sabr-1', 'YouTube Web no recibió la pista');
  assert.match(state.title, /Cancion sabr 1/, `La tarjeta no corresponde: ${state.title}`);
  assert.ok(!state.spinner, 'El botón quedó en spinner');
  assert.ok(!state.paused, 'La app quedó en pausa');
  await desktopCtx.close();

  // 2) iPhone PWA: respaldo automático rápido + vía rápida de sesión + controles + segundo plano
  const iosCtx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    serviceWorkers: 'block',
    userAgent: IOS_UA
  });
  await iosCtx.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
  });
  const iosPage = await iosCtx.newPage();
  iosPage.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`ios-${m.type()}: ${m.text().slice(0, 140)}`); });
  iosPage.on('pageerror', (e) => logs.push(`ios-pageerror: ${e.message}`));
  const streamCalls = [];
  await setupRoutes(iosPage, (id) => streamCalls.push(id));

  await iosPage.goto(`${BASE}/?v=sabr-ios`, { waitUntil: 'load' });
  await iosPage.waitForSelector('[data-nav="search"]');
  await iosPage.evaluate(() => document.querySelector('[data-nav="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await iosPage.waitForSelector('#searchInput');
  await iosPage.fill('#searchInput', 'sabr');
  await iosPage.waitForSelector('#searchResultsList [data-search-idx]', { timeout: 8000 });
  const tStart = Date.now();
  await iosPage.evaluate(() => document.querySelector('#searchResultsList [data-search-idx]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await iosPage.waitForFunction(() => window.__ytLoaded === 'sabr-1', null, { timeout: 5000 });
  const elapsed = Date.now() - tStart;
  assert.ok(elapsed < 5000, `El respaldo en iPhone tardó demasiado (${elapsed} ms)`);
  assert.equal(await iosPage.locator('#streamFallback').isVisible(), false, 'No debe mostrarse error si YouTube Web arrancó');

  // Siguiente pista: debe usar la vía rápida sin volver a pedir /api/stream
  const streamBeforeNext = streamCalls.length;
  await iosPage.locator('#miniNextBtn').click();
  await iosPage.waitForFunction(() => window.__ytLoaded === 'sabr-2', null, { timeout: 4000 });
  assert.equal(streamCalls.length, streamBeforeNext, 'La vía rápida no debe volver a consultar /api/stream');
  assert.match(await iosPage.locator('#playerTitle').textContent(), /Cancion sabr 2/);

  // Anterior con cur > 3s debe reiniciar a 0s la misma pista (abrir reproductor completo)
  await iosPage.locator('#miniOpenBtn').click();
  await iosPage.locator('#playerPrevBtn').waitFor({ state: 'visible', timeout: 4000 });
  await iosPage.evaluate(() => { window.__ytCurrentTime = 10; });
  await delay(350);
  await iosPage.locator('#playerPrevBtn').click();
  assert.equal(await iosPage.evaluate(() => window.__ytSeeks.at(-1)), 0, 'playPrev (>3 s) debe reiniciar en 0 s');
  assert.equal(await iosPage.evaluate(() => window.__ytLoaded), 'sabr-2', 'No debe retroceder de pista al reiniciar');

  // Pausa y reanudación en modo YouTube
  const pausesBefore = await iosPage.evaluate(() => window.__ytPauses);
  const playsBefore = await iosPage.evaluate(() => window.__ytPlays);
  await iosPage.locator('#playerPlayBtn').click();
  await iosPage.waitForFunction((n) => window.__ytPauses > n, pausesBefore);
  await iosPage.locator('#playerPlayBtn').click();
  await iosPage.waitForFunction((n) => window.__ytPlays > n, playsBefore);

  // Segundo plano -> iOS pausa -> regreso a primer plano -> retoma reproducción
  await iosPage.evaluate(() => {
    window.__ytCurrentTime = 12;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.__ytState(2);
  });
  const bgDiag = await iosPage.evaluate(() => window.FreeSongDiag.report().playback);
  assert.equal(bgDiag.ytBlocked, true, 'En segundo plano debe quedar pendiente para reanudar al volver');

  const playsBeforeFg = await iosPage.evaluate(() => window.__ytPlays);
  await iosPage.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await iosPage.waitForFunction((n) => window.__ytPlays > n, playsBeforeFg, { timeout: 4000 });
  assert.equal(await iosPage.evaluate(() => window.__ytLoaded), 'sabr-2');
  console.log(`iphone pwa: respaldo en ${elapsed} ms, vía rápida sin proxy, prev/pausa/fondo OK`);
  await iosCtx.close();

  console.log('FALLBACK YOUTUBE OK');
} finally {
  console.log('logs:', JSON.stringify(logs.slice(-8)));
  await browser.close().catch(() => {});
  child.kill();
}

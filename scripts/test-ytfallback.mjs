// Cuando el relay solo ofrece SABR y el proxy devuelve 502, la app debe caer
// al reproductor de YouTube Web en vez de quedarse en un bucle de carga.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const PORT = 5221;
const BASE = `http://127.0.0.1:${PORT}`;
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

// Stub mínimo del IFrame API de YouTube: registra qué vídeo se pidió.
const YT_STUB = `
window.YT = {
  Player: function (el, opts) {
    var self = this;
    window.__ytState = function (d) {
      if (opts && opts.events && opts.events.onStateChange) opts.events.onStateChange({ data: d });
    };
    self.loadVideoById = function (o) {
      window.__ytLoaded = (o && o.videoId) || o;
      window.__ytState(3);
      window.__ytState(1);
    };
    self.playVideo = function () { window.__ytState(1); };
    self.pauseVideo = function () {};
    self.stopVideo = function () {};
    self.getPlayerState = function () { return 1; };
    self.getCurrentTime = function () { return 10; };
    self.getDuration = function () { return 60; };
    self.seekTo = function () {};
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

const child = await server();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const logs = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text().slice(0, 140)}`); });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

  await page.route('**/*', async (route, request) => {
    const url = new URL(request.url());
    if (url.origin === BASE) {
      if (url.pathname === '/api/search') return json(route, { tracks: TRACKS, items: TRACKS, continuation: null });
      // El proxy está caído, como en producción con los vídeos SABR.
      if (url.pathname === '/api/stream') return json(route, { error: 'sin audio', code: 'STREAM_UNAVAILABLE' }, 502);
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
    if (url.host === 'yt.chocolatemoo53.com') {
      // La instancia solo ofrece segmentos SABR: no es un archivo reproducible.
      return json(route, {
        adaptiveFormats: [
          { itag: 140, mimeType: 'audio/mp4', url: `https://yt.chocolatemoo53.com/companion/sabr-segment?video_id=${url.pathname.split('/').pop()}&itag=140` }
        ]
      });
    }
    if (url.host === 'i.ytimg.com' || url.host.endsWith('googleusercontent.com')) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'image/png' }, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0n1ZcAAAAASUVORK5CYII=', 'base64') });
    }
    return route.abort();
  });

  await page.goto(`${BASE}/?v=sabr`, { waitUntil: 'load' });
  await page.waitForSelector('[data-nav="search"]');
  await page.evaluate(() => document.querySelector('[data-nav="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForSelector('#searchInput');
  await page.fill('#searchInput', 'sabr');
  await page.waitForSelector('#searchResultsList [data-search-idx]', { timeout: 8000 });
  await page.evaluate(() => document.querySelector('#searchResultsList [data-search-idx]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  await page.waitForFunction(() => window.__ytLoaded === 'sabr-1', null, { timeout: 25000 });
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => ({
    loaded: window.__ytLoaded,
    title: document.getElementById('playerTitle')?.textContent,
    spinner: /animate-spin/.test(document.getElementById('miniPlayBtn')?.innerHTML || ''),
    paused: /i-play/.test(document.getElementById('miniPlayBtn')?.innerHTML || '')
  }));
  console.log('estado:', JSON.stringify(state));
  assert.equal(state.loaded, 'sabr-1', 'YouTube Web no recibió la pista');
  assert.match(state.title, /Cancion sabr 1/, `La tarjeta no corresponde: ${state.title}`);
  assert.ok(!state.spinner, 'El botón quedó en spinner');
  assert.ok(!state.paused, 'La app quedó en pausa');
  console.log('FALLBACK YOUTUBE OK');
} finally {
  console.log('logs:', JSON.stringify(logs.slice(-8)));
  await browser.close().catch(() => {});
  child.kill();
}

// Con relay SABR y proxy 502, el respaldo integrado sigue disponible en
// escritorio. La PWA de iPhone conserva el motor de audio para la pista siguiente.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.YTFALLBACK_PORT) || 5221;
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

const wav = Buffer.alloc(44 + 60 * 8000 * 2);
wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(wav.length - 44, 40);

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

async function setupRoutes(page, { search = () => TRACKS, stream = route =>
  json(route, { error: 'sin audio', code: 'STREAM_UNAVAILABLE' }, 502) } = {}) {
  await page.route('**/*', async (route, request) => {
    const url = new URL(request.url());
    if (url.origin === BASE) {
      if (url.pathname === '/api/search') {
        const tracks = search(url.searchParams.get('q'));
        return json(route, { tracks, items: tracks, continuation: null });
      }
      if (url.pathname === '/api/stream') return stream(route, url.searchParams.get('id'));
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

  // 2) iPhone PWA: una fuente caída deja al usuario cambiar de pista sin iframe.
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
  const youtubeRequests = [];
  const mediaRequests = [];
  const [failedTrack, healthyTrack] = TRACKS.map((track, i) => ({ ...track, id: `sabrTrack0${i + 1}` }));
  iosPage.on('request', request => {
    const { hostname, pathname } = new URL(request.url());
    if (hostname === 'www.youtube.com' && (/^\/embed\//.test(pathname) || pathname === '/iframe_api')) {
      youtubeRequests.push(pathname);
    }
  });
  await setupRoutes(iosPage, {
    search: query => [query === 'audio disponible' ? healthyTrack : failedTrack],
    stream: (route, id) => {
      const method = route.request().method();
      if (method === 'GET') mediaRequests.push(id);
      if (id === healthyTrack.id) {
        return route.fulfill({ contentType: 'audio/wav', body: method === 'HEAD' ? '' : wav });
      }
      return json(route, { error: 'sin audio', code: 'STREAM_UNAVAILABLE' }, 502);
    }
  });

  await iosPage.goto(`${BASE}/?v=sabr-ios`, { waitUntil: 'load' });
  await iosPage.locator('[data-nav="search"]').first().click();
  await iosPage.locator('#searchInput').fill('sabr');
  await iosPage.locator('#searchResultsList [data-search-idx]').filter({ hasText: failedTrack.title }).click();
  await iosPage.waitForFunction(() => window.FreeSongDiag.report().playback.ytMode ||
    !document.getElementById('streamFallback').classList.contains('hidden'), null, { timeout: 12000 });
  assert.equal(await iosPage.evaluate(() => window.FreeSongDiag.report().playback.ytMode), false,
    'Una fuente caída en iPhone no debe activar el reproductor de YouTube Web');
  await iosPage.locator('#streamFallbackLink').waitFor({ state: 'visible' });
  assert.deepEqual(youtubeRequests, []);
  assert.ok(mediaRequests.includes(failedTrack.id));
  assert.equal(await iosPage.locator('iframe[src*="youtube"]').count(), 0);

  await iosPage.locator('#playerCloseBtn').click();
  await iosPage.locator('#searchInput').fill('audio disponible');
  await iosPage.locator('#searchResultsList [data-search-idx]').filter({ hasText: healthyTrack.title }).click();
  await iosPage.waitForFunction(id => [...document.querySelectorAll('audio')].some(audio =>
    audio.dataset.trackId === id && !audio.paused && audio.currentTime > 0.1), healthyTrack.id, { timeout: 10000 });
  const beforeLock = await iosPage.evaluate(id => {
    const audio = [...document.querySelectorAll('audio')].find(element => element.dataset.trackId === id && !element.paused);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    return { audioId: audio.id, time: audio.currentTime, src: audio.src };
  }, healthyTrack.id);
  await iosPage.waitForFunction(({ audioId, time, src }) => {
    const { visibility, playback } = window.FreeSongDiag.report();
    const audio = document.getElementById(audioId);
    return visibility === 'hidden' && playback.engine === 'html' && playback.isPlaying && !playback.ytMode &&
      audio.src === src && !audio.paused && audio.currentTime > time + 0.2;
  }, beforeLock, { timeout: 5000 });
  assert.ok(mediaRequests.includes(healthyTrack.id), 'La siguiente pista debe intentar su propia fuente');
  assert.deepEqual(youtubeRequests, []);
  assert.equal(await iosPage.evaluate(() => window.FreeSongDiag.report().playback.offline.downloads), 0);
  assert.ok(!logs.some(message => message.startsWith('ios-pageerror:')));
  console.log('iphone pwa: fuente caída sin iframe ni descargas; la siguiente pista suena en segundo plano');
  await iosCtx.close();

  console.log('FALLBACK YOUTUBE OK');
} finally {
  console.log('logs:', JSON.stringify(logs.slice(-8)));
  await browser.close().catch(() => {});
  child.kill();
}

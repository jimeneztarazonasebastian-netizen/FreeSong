import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const port = Number(process.env.PWA_TEST_PORT) || 5228;
const base = `http://127.0.0.1:${port}`;
const iphone = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  viewport: { width: 393, height: 852 },
  screen: { width: 393, height: 852 }
};
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await delay(100);
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const context = await browser.newContext(iphone);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    const match = Cache.prototype.match;
    window.offlineReads = 0;
    Cache.prototype.match = function (request, ...args) {
      if (String(request?.url || request).includes('/offline-audio/')) window.offlineReads++;
      return match.call(this, request, ...args);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  const youtubeRequests = [];
  page.on('request', (req) => { if (req.url().includes('youtube.com/iframe_api')) youtubeRequests.push(req.url()); });
  // Recurso del mismo origen sin JS: instala el worker sin arrancar todavía
  // la aplicación; así el test depende SOLO de la precarga de instalación.
  await page.goto(base + '/manifest.webmanifest');
  await page.evaluate(async () => {
    await caches.open('another-app-cache');
    await caches.open('freesong-offline-audio-v1');
    await caches.open('freesong-v0.0.1');
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  // Una navegación bajo el worker activo debe abrir la página de mezcla.
  await page.route('**/api/health?mixer=1', route => route.fulfill({ json: { configured: true } }));
  for (const path of ['/mixer-test', '/mixer-test.html']) {
    await page.goto(base + path);
    await page.getByRole('button', { name: 'Usar dos pistas de Audius' }).click();
    assert.equal(await page.locator('#first').inputValue(), 'audius:V66vyPP');
  }
  const keys = await page.evaluate(() => caches.keys());
  assert.ok(keys.includes('another-app-cache'), 'No debe borrar cachés ajenas');
  assert.ok(keys.includes('freesong-offline-audio-v1'), 'Debe conservar audio offline');
  assert.ok(!keys.includes('freesong-v0.0.1'), 'Debe borrar solo shells antiguos');
  const shellPaths = await page.evaluate(async () => {
    const key = (await caches.keys()).find(name => /^freesong-v\d/.test(name));
    return (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname);
  });
  assert.ok(shellPaths.includes('/'), 'Debe guardar la página inicial en su ruta canónica');
  assert.ok(!shellPaths.includes('/index.html'), 'No debe duplicar la página inicial en la caché');

  // Biblioteca grande: abrir no debe leer todos sus archivos de audio.
  await page.evaluate(async () => {
    const tracks = Array.from({ length: 30 }, (_, i) => ({ id: `local-${i + 1}`, title: `Local ${i + 1}`, artist: 'Prueba', duration: 8, durationSeconds: 8, thumbnail: '' }));
    localStorage.setItem('fs_downloads', JSON.stringify(tracks));
    localStorage.setItem('fs_session_v2', JSON.stringify({ queue: tracks.slice(0, 3), currentIndex: 0, repeat: 'all', autoplay: false, savedAt: Date.now() }));
    localStorage.setItem('fs_home_v1', JSON.stringify({ shelves: [{ title: 'Inicio guardado', items: tracks.slice(0, 3) }], savedAt: Date.now() }));
    const bytes = new ArrayBuffer(44 + 8 * 8000 * 2);
    const v = new DataView(bytes);
    const str = (offset, text) => [...text].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, bytes.byteLength - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, bytes.byteLength - 44, true);
    const cache = await caches.open('freesong-offline-audio-v1');
    for (const t of tracks) await cache.put('/offline-audio/' + t.id, new Response(bytes.slice(0), { headers: { 'Content-Type': 'audio/wav' } }));
  });
  await context.setOffline(true);
  const openedAt = Date.now();
  await page.goto(base + '/?offline=first-boot', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.FreeSongStorage && !!window.FreeSongUtil && !!window.FreeSongDiag);
  await page.waitForFunction(() => window.FreeSongDiag?.report().playback?.offline.cachedBlobs === 2);
  assert.equal(await page.evaluate(() => window.offlineReads), 2, 'Solo se preparan actual y siguiente, no las 30 descargas');
  assert.equal(await page.locator('[data-trend-idx]').count(), 3, 'El inicio guardado aparece sin esperar al servidor');
  console.log(`  apertura local sin red: ${Date.now() - openedAt} ms (Chrome de prueba)`);
  assert.equal(youtubeRequests.length, 0, 'Abrir en iPhone no debe descargar el reproductor YouTube');
  await page.locator('[data-trend-idx="2"]').click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('audio')).some((a) => a.dataset.trackId === 'local-3' && !a.paused && a.currentTime > 0.2));
  assert.ok(await page.evaluate(() => Array.from(document.querySelectorAll('audio')).some((a) => a.src.includes('/offline-audio/local-3'))), 'Una descarga aún no preparada arranca desde el worker');
  const deckId = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('audio')).find((a) => a.dataset.trackId === 'local-3');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    a.currentTime = a.duration - 0.2;
    return a.id;
  });
  await page.waitForFunction((id) => { const a = document.getElementById(id); return a.dataset.trackId === 'local-1' && !a.paused && a.currentTime > 0.2; }, deckId);
  const ranges = await page.evaluate(async () => {
    const r = await fetch('/offline-audio/local-2', { headers: { Range: 'bytes=0-3' } });
    const suffix = await fetch('/offline-audio/local-2', { headers: { Range: 'bytes=-4' } });
    const bad = await fetch('/offline-audio/local-2', { headers: { Range: 'bytes=999999-' } });
    const head = await fetch('/offline-audio/local-2', { method: 'HEAD' });
    return { status: r.status, text: await r.text(), length: suffix.headers.get('content-length'), bad: bad.status, head: head.headers.get('content-length'), headBytes: (await head.arrayBuffer()).byteLength };
  });
  assert.deepEqual(ranges, { status: 206, text: 'RIFF', length: '4', bad: 416, head: '128044', headBytes: 0 });
  await page.locator('[data-nav="library"]').first().click();
  assert.equal(await page.locator('#viewLibrary').isVisible(), true);
  await page.goto(base + '/index.html?offline=old-entry', { waitUntil: 'load' });
  assert.equal(await page.locator('[data-trend-idx]').count(), 3, 'El enlace de versiones anteriores debe funcionar sin conexión');
  assert.deepEqual(errors, [], 'El shell debe arrancar offline con scripts versionados');
  // La red existe pero tarda ocho segundos: abrir desde caché no debe esperarla.
  await context.setOffline(false);
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', { offline: false, latency: 8000, downloadThroughput: 1024 * 1024, uploadThroughput: 1024 * 1024 });
  const slowOpenedAt = Date.now();
  await page.goto(base + '/?slow-network=1', { waitUntil: 'domcontentloaded', timeout: 4000 });
  await page.waitForFunction(() => !!window.FreeSongDiag && !!document.querySelector('[data-trend-idx]'), null, { timeout: 3000 });
  assert.ok(Date.now() - slowOpenedAt < 4000, 'La interfaz local debe abrir antes de que responda la red lenta');
  console.log(`  apertura con 8 s de latencia de red: ${Date.now() - slowOpenedAt} ms`);
  await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  const orphan = { id: 'testTrack01', title: 'Descarga sin archivo', artist: 'Prueba', duration: 8 };
  const blockedTrack = { id: 'testTrack02', title: 'Fuente caída', artist: 'Prueba', duration: 8 };
  const wav = Buffer.from(await page.evaluate(async () =>
    Array.from(new Uint8Array(await (await fetch('/offline-audio/local-2')).arrayBuffer()))));
  await page.route('https://yt.chocolatemoo53.com/**', route => route.fulfill({ status: 403, body: 'blocked' }));
  await page.route('https://www.youtube.com/embed/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Vídeo de prueba</p>' }));
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/stream') {
      if (url.searchParams.get('id') === orphan.id) return route.fulfill({ contentType: 'audio/wav', body: wav });
      return route.fulfill({ status: 502, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      tracks: url.pathname === '/api/search' ? [orphan, blockedTrack] : [], shelves: [], queries: []
    }) });
  });
  await page.evaluate(track => {
    const downloads = JSON.parse(localStorage.getItem('fs_downloads'));
    localStorage.setItem('fs_downloads', JSON.stringify([...downloads, track]));
    localStorage.removeItem('fs_session_v2');
  }, orphan);
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const insets = await page.evaluate(() => ({
    header: document.querySelector('#appShell > header').firstElementChild.getBoundingClientRect().top,
    toast: parseFloat(getComputedStyle(document.getElementById('toastNotification')).top),
    update: parseFloat(getComputedStyle(document.getElementById('updateBanner')).top),
    player: parseFloat(getComputedStyle(document.getElementById('fullPlayerSheet')).paddingTop)
  }));
  assert.ok(Object.values(insets).every(value => value > 62), 'Encabezado, reproductor y avisos deben respetar la Isla Dinámica');
  await page.locator('[data-nav="search"]').first().click();
  await page.locator('#searchInput').fill('audio de prueba');
  await page.locator('#searchResultsList [data-search-idx]').first().click();
  await page.waitForFunction(id => Array.from(document.querySelectorAll('audio')).some(a =>
    a.dataset.trackId === id && a.currentTime > 0.2 && !a.paused && a.src.includes('/api/stream')), orphan.id);
  assert.equal(await page.evaluate(id => JSON.parse(localStorage.getItem('fs_downloads')).some(t => t.id === id), orphan.id), false);
  await page.locator('#searchResultsList [data-search-idx]').nth(1).click();
  await page.locator('#streamFallbackLink').waitFor({ state: 'visible', timeout: 22000 });
  assert.match(await page.locator('#playerTitle').textContent(), /Fuente caída/);
  await page.locator('#streamFallbackLink').click();
  assert.equal(await page.locator('#streamVideoDialog').isVisible(), true);
  assert.match(await page.locator('#streamVideoFrame iframe').getAttribute('src'), /\/embed\/testTrack02\?/);
  await page.getByRole('button', { name: 'Cerrar vídeo' }).click();
  await page.waitForFunction(() => !document.querySelector('#streamVideoFrame iframe'));
  const mixId = 'a'.repeat(48);
  const wakeUrl = 'https://freesong-mixer.onrender.com/health';
  let mixReleased = false;
  let wakeAttempts = 0;
  let releaseFirstWake;
  const firstWakeResponse = new Promise(resolve => { releaseFirstWake = resolve; });
  const mixesRequested = [];
  const mixEdits = [];
  let mixEdit = null;
  await page.route('https://api.audius.co/v1/tracks/search?**', route => route.fulfill({ json: {
    data: ['First', 'Second', 'Third', 'Fourth', 'Fifth'].map((title, i) => ({ id: 'Track' + i, title, duration: 8, is_streamable: true, user: { name: 'Artist' } }))
  }, headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('https://api.audius.co/v1/tracks/*/stream?**', route =>
    route.fulfill({ contentType: 'audio/wav', body: wav }));
  await page.route(wakeUrl, async route => {
    const attempt = ++wakeAttempts;
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (attempt === 1) await firstWakeResponse;
    if (attempt === 2) return route.fulfill({ status: 503, body: 'Iniciando', headers });
    // La primera solicitud puede haber sido cancelada antes de responder.
    await route.fulfill({ json: { ok: true }, headers }).catch(() => {});
  });
  await page.route('**/api/health?mixer=1**', route => {
    if (route.request().method() === 'DELETE') { mixReleased = true; return route.fulfill({ json: { ok: true } }); }
    if (route.request().method() === 'POST') {
      mixesRequested.push(route.request().postDataJSON().tracks.map(t => t.id));
      return route.fulfill({ json: { id: mixId, playlist: `${base}/mixer-demo/sessions/${mixId}/test.wav`, editable: true } });
    }
    if (route.request().method() === 'PATCH') {
      const { editId, tracks } = route.request().postDataJSON();
      mixEdits.push(tracks.map(t => t.id));
      mixEdit = { id: editId, status: mixEdits.length === 1 ? 'applied' : 'rejected' };
      return route.fulfill({ json: { edit: { id: editId, status: 'pending' } } });
    }
    if (!new URL(route.request().url()).searchParams.has('session')) {
      return route.fulfill({ json: { configured: true, wakeUrl } });
    }
    const trackDurations = mixEdit ? [null, 11, 601] : [10, null, null];
    return route.fulfill({ json: { status: 'complete', edit: mixEdit, trackDurations } });
  });
  await page.route('**/mixer-demo/sessions/*/test.wav', route => route.request().resourceType() === 'media' ||
    route.request().headers()['sec-fetch-dest'] === 'audio'
    ? route.fulfill({ contentType: 'audio/wav', body: wav })
    : route.fulfill({ headers: { 'Cache-Control': 'no-store' }, body: '#EXTM3U\n#EXTINF:8,\nsegment.ts\n' }));
  await page.getByRole('button', { name: 'Buscar en Audius' }).click();
  assert.equal(await page.locator('#searchInput').inputValue(), 'Fuente caída');
  await page.locator('#searchInput').fill('Audius prueba');
  await page.locator('#searchResultsList [data-search-idx]').first().click();
  await page.evaluate(() => {
    document.getElementById('miniPlayer').click();
    document.getElementById('tabQueueBtn').click();
  });
  const slowWake = page.waitForRequest(wakeUrl);
  await page.getByRole('button', { name: 'Preparar mezcla manual' }).click();
  await slowWake;
  assert.equal(mixesRequested.length, 0, 'Una instancia aún en inicio no debe recibir la creación de la mezcla');
  await page.getByRole('button', { name: 'Cancelar preparación' }).click();
  releaseFirstWake();
  await page.getByRole('button', { name: 'Preparar mezcla manual' }).click();
  await page.waitForFunction(() => /servidor de audio está iniciando/.test(document.getElementById('queueMixStatus').textContent));
  await page.getByRole('button', { name: 'Reproducir mezcla' }).waitFor();
  assert.equal(wakeAttempts, 3);
  assert.equal(mixesRequested.length, 1, 'Solo se crea una sesión después de confirmar que Render está listo');
  const swipeQueue = title => page.evaluate(title => {
    const row = [...document.querySelectorAll('[data-queue-idx]')].find(r => r.textContent.includes(title));
    for (const [type, x] of [['touchstart', 40], ['touchmove', 140], ['touchend', 140]]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const touch = { clientX: x, clientY: 100 };
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [touch] });
      Object.defineProperty(event, 'changedTouches', { value: [touch] });
      row.dispatchEvent(event);
    }
  }, title);
  await swipeQueue('Fourth');
  await page.getByRole('button', { name: 'Reproducir mezcla' }).waitFor();
  assert.deepEqual(mixesRequested, [
    ['audius:Track0', 'audius:Track1', 'audius:Track2'],
    ['audius:Track0', 'audius:Track3', 'audius:Track1']
  ]);
  assert.equal(mixReleased, true, 'La mezcla anterior se libera antes de reconstruir');
  mixReleased = false;
  await page.getByRole('button', { name: 'Reproducir mezcla' }).click();
  await page.waitForFunction(() => {
    const audio = document.getElementById('queueMixAudio');
    return !audio.paused && audio.currentTime > 0.1;
  }, null, { timeout: 7000 }).catch(async error => {
    console.error(await page.evaluate(() => ({
      status: document.getElementById('queueMixStatus').textContent,
      src: document.getElementById('queueMixAudio').getAttribute('src'),
      mediaError: document.getElementById('queueMixAudio').error?.message
    })), errors);
    throw error;
  });
  await page.waitForFunction(() => document.getElementById('playerDurTime').textContent === '0:10');
  await swipeQueue('Fifth');
  await page.waitForFunction(() => document.querySelector('#queueMixStatus').textContent.includes('Siguiente actualizada'));
  assert.deepEqual(mixEdits[0], ['audius:Track0', 'audius:Track4', 'audius:Track3']);
  assert.match(await page.locator('#queueMixAudio').getAttribute('src'), /test\.wav$/);
  assert.equal(await page.locator('#playerTitle').textContent(), 'First');
  await swipeQueue('Third');
  await page.waitForFunction(() => document.querySelector('#queueMixStatus').textContent.includes('después del bloque'));
  assert.match(await page.locator('#queueMixStatus').textContent(), /después del bloque/);
  assert.deepEqual((await page.locator('[data-queue-idx] p.text-white').allTextContents()).slice(0, 4),
    ['Fifth', 'Fourth', 'Third', 'Second']);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const audio = document.getElementById('queueMixAudio');
    audio.currentTime = 3;
    audio.dispatchEvent(new Event('timeupdate'));
  });
  assert.equal(await page.locator('#playerTitle').textContent(), 'First', 'La edición conserva la duración medida de la pista que sigue sonando');
  await page.evaluate(() => { document.getElementById('queueMixAudio').currentTime = 5; });
  await page.waitForFunction(() => document.getElementById('playerTitle').textContent === 'Fifth');
  assert.equal(await page.locator('#playerDurTime').textContent(), '0:11');
  assert.match(await page.locator('#queueMixAudio').getAttribute('src'), /test\.wav$/);
  const diag = await page.evaluate(() => window.FreeSongDiag.report());
  assert.equal(diag.visibility, 'hidden');
  assert.equal(diag.playback.isPlaying, true);
  assert.equal(diag.playback.engine, 'hls-mixer');
  assert.equal(diag.playback.mixer.part, 1);
  assert.match(diag.playback.mixer.audio, /sessions\/\[oculta\]/);
  assert.ok(!JSON.stringify(diag).includes(mixId), 'El diagnóstico nunca debe exponer la credencial HLS');
  assert.ok(diag.events.some(event => event.name === 'mixer-edit-applied'));
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const released = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes(mixId));
  await page.getByRole('button', { name: 'Salir de la mezcla' }).click();
  await released;
  await page.waitForFunction(() => document.getElementById('queueMixAudio').paused);
  assert.equal(mixReleased, true);
  assert.deepEqual(errors, []);
  console.log('  isla dinámica protegida, descarga ausente recuperada por red y vídeo alternativo a petición');
  await context.close();

  const autoContext = await browser.newContext({ ...iphone, serviceWorkers: 'block' });
  const autoplayTracks = [
    { id: 'audius:Autofirst', title: 'Pista automática inicial', artist: 'Prueba', duration: 8 },
    { id: 'audius:Autosecond', title: 'Pista automática siguiente', artist: 'Prueba', duration: 8 }
  ];
  await autoContext.addInitScript(queue => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    localStorage.setItem('fs_crossfade', 'true');
    localStorage.setItem('fs_session_v2', JSON.stringify({
      queue, currentIndex: 0, repeat: 'off', autoplay: false, crossfade: true,
      crossfadeDuration: 2, savedAt: Date.now()
    }));
  }, autoplayTracks);

  const serveSeekableWave = route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    const headers = { 'Accept-Ranges': 'bytes' };
    if (!range) return route.fulfill({ headers, contentType: 'audio/wav', body: wav });
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    return route.fulfill({
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${wav.length}` },
      contentType: 'audio/wav',
      body: wav.subarray(start, end + 1)
    });
  };

  for (const action of ['continuar', 'pausar', 'saltar', 'bloqueo de autoplay']) {
    const autoPage = await autoContext.newPage();
    const creations = [];
    const crashes = [];
    let throttledAt = 0;
    const automaticId = 'b'.repeat(48);
    const playlist = `${base}/mixer-demo/sessions/${automaticId}/autoplay.wav`;
    let openManifest;
    const manifestReady = new Promise(resolve => { openManifest = resolve; });
    let wakeMixer;
    const mixerReady = new Promise(resolve => { wakeMixer = resolve; });
    if (action !== 'continuar') wakeMixer();
    let settleManifest;
    const manifestSettled = new Promise(resolve => { settleManifest = resolve; });
    autoPage.on('pageerror', error => crashes.push(error.message));
    autoPage.on('requestfailed', request => {
      if (request.url() === playlist) settleManifest();
    });
    try {
      if (action === 'bloqueo de autoplay') {
        await autoPage.addInitScript(() => {
          const play = HTMLMediaElement.prototype.play;
          window.rejectedMixAttempts = 0;
          HTMLMediaElement.prototype.play = function () {
            if (this.src.endsWith('/autoplay.wav')) {
              window.rejectedMixAttempts++;
              return Promise.reject(new DOMException('Autoplay bloqueado en la prueba', 'NotAllowedError'));
            }
            return play.call(this);
          };
        });
      }
      await autoPage.route('https://**/*', route => route.abort());
      await autoPage.route('https://api.audius.co/v1/tracks/*/stream?**', serveSeekableWave);
      await autoPage.route(wakeUrl, async route => {
        await mixerReady;
        return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { ok: true } });
      });
      await autoPage.route('**/api/**', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.searchParams.get('mixer') !== '1') {
          return route.fulfill({ json: { tracks: [], shelves: [], queries: [] } });
        }
        if (request.method() === 'POST') {
          if (action === 'continuar' && !throttledAt) {
            throttledAt = Date.now();
            return route.fulfill({ status: 429, headers: { 'Retry-After': '1' }, json: { error: 'Espera un segundo' } });
          }
          creations.push(request.postDataJSON());
          return route.fulfill({ json: { id: automaticId, playlist, editable: true } });
        }
        if (request.method() === 'DELETE') return route.fulfill({ json: { ok: true } });
        if (!url.searchParams.has('session')) return route.fulfill({ json: { configured: true, wakeUrl } });
        return route.fulfill({ json: { status: 'complete', trackDurations: [8, 8] } });
      });
      await autoPage.route(playlist, async route => {
        const request = route.request();
        if (request.resourceType() === 'media' || request.headers()['sec-fetch-dest'] === 'audio') {
          return serveSeekableWave(route);
        }
        await manifestReady;
        await route.fulfill({ headers: { 'Cache-Control': 'no-store' }, body: '#EXTM3U\n#EXTINF:8,\nsegment.ts\n' }).catch(() => {});
        settleManifest();
      });
      await autoPage.goto(base, { waitUntil: 'domcontentloaded' });
      const manifestRequest = autoPage.waitForRequest(request =>
        request.url() === playlist && request.resourceType() !== 'media', { timeout: 10000 }).catch(error => error);
      await autoPage.locator('#miniPlayBtn').click();
      await autoPage.waitForFunction(() => [...document.querySelectorAll('audio')].some(audio =>
        audio.src.includes('/Autofirst/stream') && !audio.paused && audio.currentTime > 0.1));
      if (action === 'continuar') {
        assert.equal(creations.length, 0, 'La pista suena mientras el servidor sigue iniciando');
        await autoPage.evaluate(() => {
          const original = [...document.querySelectorAll('audio')].find(audio => audio.src.includes('/Autofirst/stream'));
          original.currentTime = 2;
        });
        await autoPage.waitForFunction(() => [...document.querySelectorAll('audio')].some(audio =>
          audio.src.includes('/Autofirst/stream') && !audio.seeking && audio.currentTime >= 2));
        wakeMixer();
      }
      const request = await manifestRequest;
      if (request instanceof Error) throw request;
      assert.deepEqual(creations.map(payload => payload.tracks.map(track => track.id)),
        [autoplayTracks.map(track => track.id)], 'El toque de reproducción prepara una sola mezcla de la cola actual');

      if (action === 'pausar') {
        await autoPage.locator('#miniPlayBtn').click();
      } else if (action === 'saltar') {
        await autoPage.locator('#miniNextBtn').click();
        await autoPage.waitForFunction(() => [...document.querySelectorAll('audio')].some(audio =>
          audio.src.includes('/Autosecond/stream') && !audio.paused && audio.currentTime > 0.1));
      } else if (action === 'bloqueo de autoplay') {
        await autoPage.evaluate(() => {
          const original = [...document.querySelectorAll('audio')].find(audio => audio.src.includes('/Autofirst/stream'));
          original.currentTime = 2;
        });
      }
      openManifest();
      await manifestSettled;

      if (action === 'continuar') {
        assert.ok(throttledAt && Date.now() - throttledAt < 5000,
          'La mezcla reintenta según Retry-After sin esperar otros quince segundos');
        assert.ok(creations[0].startAt >= 2, 'La mezcla pide la posición vigente después de despertar el servidor');
        const switched = await autoPage.waitForFunction(() => {
          const state = window.FreeSongDiag.report().playback;
          const audio = [...document.querySelectorAll('audio')].filter(element => !element.paused && !element.muted);
          return state.engine === 'hls-mixer' && audio.length === 1 && { time: audio[0].currentTime, track: state.track.id };
        }, null, { timeout: 10000 });
        const handoff = await switched.jsonValue();
        assert.ok(handoff.time >= 1.7, 'El fundido de servidor conserva la posición de la canción');
        assert.equal(handoff.track, autoplayTracks[0].id);
        await autoPage.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
          document.getElementById('queueMixAudio').currentTime = 6.2;
        });
        await autoPage.waitForFunction(id => {
          const report = window.FreeSongDiag.report();
          return report.visibility === 'hidden' && report.playback.engine === 'hls-mixer' &&
            report.playback.track?.id === id && report.playback.isPlaying;
        }, autoplayTracks[1].id);
      } else if (action === 'bloqueo de autoplay') {
        await autoPage.waitForFunction(() => window.rejectedMixAttempts > 0);
        await autoPage.waitForFunction(() => {
          const state = window.FreeSongDiag.report().playback;
          const original = [...document.querySelectorAll('audio')].find(audio => audio.src.includes('/Autofirst/stream'));
          return state.engine !== 'hls-mixer' && state.isPlaying && !original.paused && original.currentTime > 2.2;
        });
        assert.equal(await autoPage.evaluate(() => window.rejectedMixAttempts), 1);
      } else {
        await autoPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await autoPage.waitForFunction(action => {
          const state = window.FreeSongDiag.report().playback;
          return state.engine !== 'hls-mixer' && (action === 'pausar'
            ? !state.isPlaying && state.userIntentionalPause
            : state.track?.id === 'audius:Autosecond' && state.isPlaying);
        }, action);
        assert.equal(await autoPage.evaluate(() => [...document.querySelectorAll('audio')].some(element =>
          element.src.endsWith('/autoplay.wav') && !element.paused && !element.muted)), false,
        'Una mezcla pendiente no debe reanudar una pausa ni recuperar una pista saltada');
      }
      assert.equal(creations.length, 1);
      assert.deepEqual(crashes, []);
      assert.equal(await autoPage.evaluate(() => JSON.parse(localStorage.getItem('fs_downloads') || '[]').length), 0);
    } finally {
      wakeMixer();
      openManifest();
      await autoPage.close();
    }
  }
  await autoContext.close();
  console.log('  fundido automático sin reiniciar la pista, respetando las pausas y saltos');

  const nativeContext = await browser.newContext({ ...iphone, serviceWorkers: 'block' });
  const nativeTracks = [
    { id: 'TestAudio01', title: 'Pista nativa inicial', artist: 'Prueba', duration: 8 },
    { id: 'TestAudio02', title: 'Pista nativa siguiente', artist: 'Prueba', duration: 8 }
  ];
  const unsuitableThird = { id: 'ThirdTrack0', title: 'Tercera sin duración', artist: 'Prueba', duration: 0 };
  const failedProbeTrack = { id: 'DeadProbe01', title: 'Pista de precarga caída', artist: 'Prueba', duration: 8 };
  for (const mode of ['cola', 'radio', 'fallo']) {
    const nativePage = await nativeContext.newPage();
    const mixTracks = mode === 'radio' ? nativeTracks.slice(0, 1) : nativeTracks;
    const queue = mode === 'cola' ? [...mixTracks, unsuitableThird] : mixTracks;
    const sessionRequests = [];
    const errors = [];
    let releaseMedia;
    const mediaReady = new Promise(resolve => { releaseMedia = resolve; });
    nativePage.on('pageerror', error => errors.push(error.message));
    try {
      await nativePage.addInitScript(({ queue, radio, position }) => {
        Object.defineProperty(navigator, 'standalone', { value: true });
        localStorage.setItem('fs_crossfade', 'true');
        localStorage.setItem('fs_session_v2', JSON.stringify({
          queue, currentIndex: 0, repeat: 'off', autoplay: radio, crossfade: true,
          crossfadeDuration: 2, position, savedAt: Date.now()
        }));
        const canPlayType = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function (type) {
          if (type === 'application/vnd.apple.mpegurl') return 'maybe';
          return canPlayType.call(this, type);
        };
        const play = HTMLMediaElement.prototype.play;
        let trustedClick = false;
        window.addEventListener('click', event => {
          if (!event.target.closest?.('#miniPlayBtn')) return;
          trustedClick = event.isTrusted;
          setTimeout(() => { trustedClick = false; }, 0);
        }, true);
        window.nativePlayCalls = [];
        window.mixerMediaActions = {};
        const mediaSession = navigator.mediaSession;
        const setActionHandler = mediaSession.setActionHandler.bind(mediaSession);
        const setPositionState = mediaSession.setPositionState.bind(mediaSession);
        mediaSession.setActionHandler = (action, handler) => {
          window.mixerMediaActions[action] = handler;
          setActionHandler(action, handler);
        };
        mediaSession.setPositionState = position => {
          window.mixerMediaPosition = position;
          setPositionState(position);
        };
        HTMLMediaElement.prototype.play = function () {
          window.nativePlayCalls.push({
            id: this.id, src: this.src, muted: this.muted, trustedClick,
            activated: navigator.userActivation.isActive
          });
          return play.call(this);
        };
      }, { queue, radio: mode === 'radio', position: mode === 'fallo' ? 3 : 0 });
      await nativePage.route('https://**/*', route => route.abort());
      await nativePage.route(wakeUrl, route =>
        route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { ok: true } }));
      await nativePage.route('**/api/**', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/stream') {
          if (url.searchParams.get('id') === failedProbeTrack.id) return route.fulfill({ status: 503 });
          return serveSeekableWave(route);
        }
        if (url.pathname === '/api/search' && url.searchParams.get('q') === failedProbeTrack.title) {
          return route.fulfill({ json: { tracks: [failedProbeTrack] } });
        }
        if (url.searchParams.get('mixer') !== '1') {
          return route.fulfill({ json: { tracks: [], shelves: [], queries: [] } });
        }
        if (!url.searchParams.has('session') && request.method() === 'GET') {
          return route.fulfill({ json: { configured: true, nativeStart: true, wakeUrl } });
        }
        sessionRequests.push([request.method(), url.searchParams.get('session')]);
        return route.fulfill({ json: { status: 'complete', tracks: nativeTracks, trackDurations: [8, 8] } });
      });
      await nativePage.route('**/api/mixer-start.m3u8?**', async route => {
        await mediaReady;
        if (mode === 'fallo') return route.fulfill({ status: 503, body: 'Audio no disponible' });
        return route.fulfill({ status: 307, headers: { Location: base + '/mixer-demo/index.m3u8' } });
      });
      const warmRequest = nativePage.waitForRequest(wakeUrl);
      await nativePage.goto(base, { waitUntil: 'domcontentloaded' });
      await warmRequest;
      if (mode === 'cola') {
        const failedProbe = nativePage.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === '/api/stream' && url.searchParams.get('id') === failedProbeTrack.id &&
            response.request().method() === 'HEAD' && response.status() === 503;
        }, { timeout: 10000 });
        await nativePage.locator('[data-nav="search"]').first().click();
        await nativePage.locator('#searchInput').fill(failedProbeTrack.title);
        await (await failedProbe).finished();
        await nativePage.locator('#searchResultsList [data-search-idx]').filter({ hasText: failedProbeTrack.title })
          .waitFor({ state: 'visible' });
        await nativePage.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      }
      const startRequest = nativePage.waitForRequest('**/api/mixer-start.m3u8?**', { timeout: 6000 }).catch(error => error);
      await nativePage.locator('#miniPlayBtn').click();
      if (mode === 'cola') {
        assert.equal(await nativePage.evaluate(() => window.nativePlayCalls[0]?.id), 'queueMixAudio',
          'El HEAD 503 ajeno y una tercera pista sin duración no deben bloquear el HLS de las dos primeras');
      }
      const request = await startRequest;
      if (request instanceof Error) throw request;
      const url = new URL(request.url());
      const id = url.searchParams.get('session');
      assert.match(id, /^[a-f0-9]{48}$/);
      assert.equal(request.resourceType(), 'media', 'El elemento de audio debe solicitar el HLS directamente');
      assert.equal(url.searchParams.get('ids'), mixTracks.map(track => track.id).join(','),
        'Una tercera pista sin duración no debe impedir el fundido entre las dos primeras');
      assert.equal(url.searchParams.get('fade'), '2');
      assert.equal(url.searchParams.get('radio'), mode === 'radio' ? '1' : null);
      assert.equal(url.searchParams.get('startAt'), mode === 'fallo' ? '3' : null);
      if (mode !== 'radio') {
        assert.deepEqual(JSON.parse(url.searchParams.get('metadata')), nativeTracks);
      }
      const expectedPlay = { id: 'queueMixAudio', src: request.url(), muted: false, trustedClick: true, activated: true };
      assert.deepEqual(await nativePage.evaluate(() => window.nativePlayCalls), [expectedPlay],
        'El toque real inicia el HLS audible sin esperar al servidor ni reproducir una pista aparte');
      assert.deepEqual(sessionRequests, [], 'No se necesita un POST ni obtener la sesión para iniciar el elemento de audio');

      if (mode === 'fallo') {
        releaseMedia();
        await nativePage.waitForFunction(id => {
          const state = window.FreeSongDiag.report().playback;
          return state.engine === 'html' && state.track?.id === id && [...document.querySelectorAll('audio')].some(audio =>
            audio.src.includes('/api/stream') && !audio.paused && audio.currentTime >= 3);
        }, queue[0].id);
        assert.deepEqual(sessionRequests, [['DELETE', id]]);
      } else {
        await nativePage.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        releaseMedia();
        await nativePage.waitForFunction(id => {
          const report = window.FreeSongDiag.report();
          const audio = document.getElementById('queueMixAudio');
          return report.visibility === 'hidden' && report.playback.track?.id === id &&
            report.playback.mixer?.nativeStart && !report.playback.mixer.starting &&
            report.playback.mixer.tracks === 2 && !audio.paused && audio.currentTime > 0.1;
        }, queue[0].id);
        await nativePage.evaluate(() => { document.getElementById('queueMixAudio').currentTime = 6.2; });
        await nativePage.waitForFunction(id => {
          const report = window.FreeSongDiag.report();
          return report.visibility === 'hidden' && report.playback.track?.id === id &&
            report.playback.engine === 'hls-mixer' && report.playback.isPlaying;
        }, nativeTracks[1].id);
        assert.equal(await nativePage.locator('#queueMixAudio').evaluate(audio => audio.src), expectedPlay.src);
        assert.deepEqual(await nativePage.evaluate(() => window.nativePlayCalls), [expectedPlay]);
        assert.deepEqual(sessionRequests, [['GET', id]]);
        if (mode === 'cola') {
          const beforePause = await nativePage.evaluate(() => {
            const audio = document.getElementById('queueMixAudio');
            delete document.visibilityState;
            document.dispatchEvent(new Event('visibilitychange'));
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
            audio.pause();
            return { src: audio.src, time: audio.currentTime };
          });
          await nativePage.waitForFunction(({ src, time }) => {
            const report = window.FreeSongDiag.report();
            const audio = document.getElementById('queueMixAudio');
            return report.visibility === 'hidden' && report.playback.engine === 'hls-mixer' &&
              report.playback.isPlaying && navigator.mediaSession.playbackState === 'playing' &&
              audio.src === src && !audio.paused && audio.currentTime > time + 0.1;
          }, beforePause, { timeout: 4000 });
          const playCalls = await nativePage.evaluate(() => window.nativePlayCalls);
          assert.ok(playCalls.length > 1 && playCalls.every(call =>
            call.id === 'queueMixAudio' && call.src === beforePause.src && !call.muted),
          'La pausa del sistema debe recuperarse en el HLS activo sin abrir otro audio');
          assert.deepEqual(sessionRequests, [['GET', id]]);

          const pausedByListener = await nativePage.evaluate(() => {
            const audio = document.getElementById('queueMixAudio');
            window.mixerMediaActions.pause();
            audio.dispatchEvent(new Event('playing'));
            document.dispatchEvent(new Event('visibilitychange'));
            return audio.paused;
          });
          assert.equal(pausedByListener, true, 'El control de bloqueo debe pausar el HLS inmediatamente');
          await nativePage.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
          assert.deepEqual(await nativePage.evaluate(() => {
            const state = window.FreeSongDiag.report().playback;
            return {
              paused: document.getElementById('queueMixAudio').paused,
              intentionallyPaused: state.userIntentionalPause,
              playing: state.isPlaying,
              mediaSession: navigator.mediaSession.playbackState
            };
          }), { paused: true, intentionallyPaused: true, playing: false, mediaSession: 'paused' });
        } else {
          // La pantalla de bloqueo puede perder la ficha o mostrar una pausa antigua.
          await nativePage.evaluate(() => {
            delete document.visibilityState;
            document.dispatchEvent(new Event('visibilitychange'));
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.setPositionState();
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
            navigator.mediaSession.playbackState = 'paused';
          });
          await nativePage.waitForFunction(({ title, artist }) => {
            const audio = document.getElementById('queueMixAudio');
            const { metadata, playbackState } = navigator.mediaSession;
            const position = window.mixerMediaPosition;
            return document.visibilityState === 'hidden' && !audio.paused && playbackState === 'playing' &&
              metadata?.title === title && metadata.artist === artist && metadata.artwork.some(art => art.src.includes('/icons/')) &&
              position?.duration === 8 &&
              position.position > 0.1 && Math.abs(position.position - (audio.currentTime - 6)) < 0.5 &&
              position.playbackRate === audio.playbackRate;
          }, nativeTracks[1], { timeout: 3000 });
          assert.deepEqual(await nativePage.evaluate(() => window.nativePlayCalls), [expectedPlay],
            'Reparar los controles no debe reiniciar el HLS');
        }
      }
      assert.equal(await nativePage.evaluate(() => window.FreeSongDiag.report().playback.offline.downloads), 0);
      assert.deepEqual(errors, []);
    } finally {
      releaseMedia();
      await nativePage.close();
    }
  }
  await nativeContext.close();
  console.log('  fundido iniciado con el toque real, transición en segundo plano y recuperación sin mezcla');

  const blocked = await browser.newContext({ serviceWorkers: 'block' });
  await blocked.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError'); } });
  });
  const blockedPage = await blocked.newPage();
  const blockedErrors = [];
  blockedPage.on('pageerror', (e) => blockedErrors.push(e.message));
  await blockedPage.route('**/api/**', (route) => route.fulfill({ contentType: 'application/json', body: '{"shelves":[],"tracks":[]}' }));
  await blockedPage.route('https://**/*', (route) => route.abort());
  await blockedPage.goto(base, { waitUntil: 'load' });
  await blockedPage.locator('[data-nav="settings"]').first().click();
  await blockedPage.locator('label').filter({ has: blockedPage.locator('#settingAutoplayToggle') }).click();
  assert.deepEqual(blockedErrors, [], 'El almacenamiento bloqueado no debe romper el arranque ni los ajustes');
  await blocked.close();
  console.log('PWA OK: primer arranque offline, cachés conservadas y almacenamiento bloqueado');
} finally {
  await browser?.close();
  server.kill();
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const port = 5228;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await delay(100);
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    viewport: { width: 393, height: 852 },
    screen: { width: 393, height: 852 }
  });
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
  let mixReleased = false;
  const mixesRequested = [];
  await page.route('https://api.audius.co/v1/tracks/search?**', route => route.fulfill({ json: {
    data: ['First', 'Second', 'Third', 'Fourth', 'Fifth'].map((title, i) => ({ id: 'Track' + i, title, duration: 8, is_streamable: true, user: { name: 'Artist' } }))
  }, headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('https://api.audius.co/v1/tracks/*/stream?**', route =>
    route.fulfill({ contentType: 'audio/wav', body: wav }));
  await page.route('**/api/health?mixer=1**', route => {
    if (route.request().method() === 'DELETE') { mixReleased = true; return route.fulfill({ json: { ok: true } }); }
    if (route.request().method() === 'POST') {
      mixesRequested.push(route.request().postDataJSON().tracks.map(t => t.id));
      return route.fulfill({ json: { id: mixId, playlist: base + '/mixer-demo/test.wav' } });
    }
    return route.fulfill({ json: { status: 'complete' } });
  });
  await page.route('**/mixer-demo/test.wav', route => route.request().resourceType() === 'media' ||
    route.request().headers()['sec-fetch-dest'] === 'audio'
    ? route.fulfill({ contentType: 'audio/wav', body: wav })
    : route.fulfill({ headers: { 'Cache-Control': 'no-store' }, body: '#EXTM3U\n#EXTINF:8,\nsegment.ts\n' }));
  await page.evaluate(() => {
    document.querySelector('#playerCloseBtn').click();
    document.querySelector('[data-nav="search"]').click();
    document.querySelector('#searchAudiusBtn').click();
  });
  await page.locator('#searchInput').fill('Audius prueba');
  await page.locator('#searchResultsList [data-search-idx]').first().click();
  await page.evaluate(() => {
    document.getElementById('miniPlayer').click();
    document.getElementById('tabQueueBtn').click();
  });
  await page.getByRole('button', { name: 'Preparar crossfade con pantalla bloqueada' }).click();
  await page.getByRole('button', { name: 'Reproducir mezcla' }).waitFor();
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
  await swipeQueue('Fifth');
  assert.match(await page.locator('#queueMixStatus').textContent(), /después del bloque/);
  assert.deepEqual((await page.locator('[data-queue-idx] p.text-white').allTextContents()).slice(0, 4),
    ['Fourth', 'Second', 'Fifth', 'Third']);
  await page.evaluate(() => { document.getElementById('queueMixAudio').currentTime = 3; });
  await page.waitForFunction(() => document.getElementById('playerTitle').textContent === 'Fourth');
  assert.match(await page.locator('#queueMixAudio').getAttribute('src'), /test\.wav$/);
  const released = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes(mixId));
  await page.getByRole('button', { name: 'Salir de la mezcla' }).click();
  await released;
  await page.waitForFunction(() => document.getElementById('queueMixAudio').paused);
  assert.equal(mixReleased, true);
  assert.deepEqual(errors, []);
  console.log('  isla dinámica protegida, descarga ausente recuperada por red y vídeo alternativo a petición');
  await context.close();

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

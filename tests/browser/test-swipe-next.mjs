// Regresión del crossfade (Chrome headless).
//
// El fallo original: al empezar el fundido, la tarjeta, la letra y los
// similares cambiaban a la canción siguiente mientras la anterior seguía
// sonando. Aquí se comprueba que la interfaz no cambia hasta que el fundido
// termina y que el audio sí solapa los dos decks.
//
// No usa internet: intercepta /api/* y sirve un WAV local.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, devices } from 'playwright-core';

const PORT = 5238;
const BASE = `http://127.0.0.1:${PORT}`;
const XF = 3; // segundos de fundido

const TRACKS = Array.from({ length: 4 }, (_, i) => ({
  id: `xf-${i + 1}`,
  title: `Cancion crossfade ${i + 1}`,
  artist: 'Artista de prueba',
  duration: 6,
  durationSeconds: 6,
  durationText: '0:06',
  thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0n1ZcAAAAASUVORK5CYII='
}));

function makeWav(seconds = 12, rate = 8000) {
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

const state = (page) =>
  page.evaluate(() => {
    const decks = Array.from(document.querySelectorAll('audio'));
    const playing = decks.filter((a) => !a.paused);
    return {
      title: document.getElementById('playerTitle')?.textContent || '',
      lyrics: document.getElementById('lyricsContainer')?.textContent || '',
      deckCount: playing.length,
      playingIds: playing.map((a) => a.dataset.trackId || '')
    };
  });

async function run() {
  const server = await startServer();
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  });
  const errors = [];
  try {
    const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    await context.addInitScript((xf) => {
      localStorage.setItem('fs_crossfade', 'false');
      localStorage.setItem('fs_crossfade_dur', String(xf));
    }, XF);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)));

    await page.route('**/*', async (route, request) => {
      const url = new URL(request.url());
      const host = url.host.toLowerCase();
      if (url.origin === BASE) {
        if (url.pathname === '/api/search') return json(route, { tracks: TRACKS, items: TRACKS, continuation: null });
        if (url.pathname === '/api/stream') return streamAudio(route, request);
        if (url.pathname === '/api/relay-info') return json(route, { instances: [] });
        if (url.pathname === '/api/suggestions') return json(route, { queries: [] });
        if (url.pathname === '/api/lyrics') {
          const track = url.searchParams.get('track') || '';
          return json(route, {
            syncedLyrics: `[00:00.00]Letra de ${track}`,
            plainLyrics: `Letra de ${track}`,
            match: { title: track }
          });
        }
        if (url.pathname === '/api/queue') return json(route, { tracks: [] });
        if (url.pathname === '/api/health') return json(route, { ok: true, version: 'test' });
        if (url.pathname === '/api/home') return json(route, { shelves: [] });
        if (url.pathname === '/api/artist' || url.pathname === '/api/album' || url.pathname === '/api/playlist') return json(route, {});
        return route.continue();
      }
      if (host === 'yt.chocolatemoo53.com') return route.fulfill({ status: 503, body: '{}' });
      if (host === 'i.ytimg.com' || host.endsWith('googleusercontent.com')) {
        return route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'image/png' },
          body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0n1ZcAAAAASUVORK5CYII=', 'base64')
        });
      }
      return route.abort();
    });

    await page.goto(`${BASE}/?v=xf`, { waitUntil: 'load' });
    await page.waitForSelector('[data-nav="search"]');
    await page.evaluate(() => document.querySelector('[data-nav="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForSelector('#searchInput');
    await page.fill('#searchInput', 'crossfade');
    await page.waitForSelector('#searchResultsList [data-search-idx]', { timeout: 8000 });
    await page.evaluate(() => document.querySelector('#searchResultsList [data-search-idx]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    await page.waitForFunction(() => Array.from(document.querySelectorAll('audio')).some((a) => !a.paused && a.currentTime > 0.15), null, { timeout: 12000 });
    await page.waitForFunction(() => /Letra de Cancion crossfade 1/.test(document.getElementById('lyricsContainer')?.textContent || ''), null, { timeout: 8000 });

    const swipe = async (dx, dy, cancel = false) => page.evaluate(({dx,dy,cancel}) => {
      const row = document.querySelector('[data-search-idx="2"]');
      const emit = (name, x, y) => {
        const e = new Event(name, {bubbles:true,cancelable:true});
        Object.defineProperty(e, 'touches', {value: name === 'touchend' ? [] : [{clientX:x,clientY:y}]});
        row.dispatchEvent(e);
      };
      emit('touchstart', 50, 100);
      emit('touchmove', 50 + dx, 100 + dy);
      emit(cancel ? 'touchcancel' : 'touchend', 50 + dx, 100 + dy);
      row.click();
    }, {dx,dy,cancel});
    const initial = await page.locator('[data-queue-idx]').count();
    // Vertical and cancelled gestures must not add a song.
    await page.evaluate(() => {
      const row=document.querySelector('[data-search-idx="2"]');
      row.addEventListener('click',e=>e.stopImmediatePropagation(),{once:true,capture:true});
    });
    await swipe(15, 80);
    assert.equal(await page.locator('[data-queue-idx]').count(), initial);
    await page.evaluate(() => {
      const row=document.querySelector('[data-search-idx="2"]');
      row.addEventListener('click',e=>e.stopImmediatePropagation(),{once:true,capture:true});
    });
    await swipe(90, 0, true);
    assert.equal(await page.locator('[data-queue-idx]').count(), initial);
    await swipe(90, 0);
    await page.waitForFunction(() => document.querySelector('[data-queue-idx]')?.textContent.includes('Cancion crossfade 3'));
    assert.match((await state(page)).title, /Cancion crossfade 1/, 'Deslizar no debe interrumpir la canción');
    assert.equal(await page.locator('[data-queue-idx]').count(), initial, 'La pista existente se mueve sin duplicarse');
    // Deslizar otra pista ya en Siguiente con entrada táctil del navegador.
    await page.evaluate(() => {
      document.getElementById('miniPlayer').click();
      document.getElementById('tabQueueBtn').click();
    });
    const fourth = page.locator('[data-queue-idx]').filter({ hasText: 'Cancion crossfade 4' });
    await page.waitForFunction(() => Math.abs(document.getElementById('fullPlayerSheet').getBoundingClientRect().top) < 1);
    await fourth.scrollIntoViewIfNeeded();
    const input = await context.newCDPSession(page);
    const box = await fourth.boundingBox();
    const x = Math.round(box.x + box.width * 0.34), y = Math.round(box.y + box.height / 2);
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const dx of [20, 40, 60, 90]) {
      await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y }] });
    }
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => document.getElementById('playerTitle')?.textContent.includes('Cancion crossfade 1') &&
      document.querySelector('[data-queue-idx]')?.textContent.includes('Cancion crossfade 4'));
    assert.equal(await page.locator('[data-queue-idx]').count(), initial);
    assert.match((await state(page)).title, /Cancion crossfade 1/);
    await page.evaluate(() => {
      const audio = Array.from(document.querySelectorAll('audio')).find(a => a.dataset.trackId === 'xf-1' && !a.paused);
      audio.currentTime = audio.duration - 0.3;
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('audio')).some(a=>a.dataset.trackId==='xf-4' && !a.paused && a.currentTime>0.1));
    assert.deepEqual(errors, []);
    console.log('SWIPE NEXT OK: vertical/cancelar conservan cola; deslizar añade siguiente sin reproducirla inmediatamente');
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
}

run().catch((err) => {
  console.error('SWIPE NEXT FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});

// Prueba de humo real (Chrome headless) para FreeSong.
//
// No toca internet: mockea /api/search, /api/stream y compañía, y sirve un WAV
// local. Comprueba el flujo crítico que más veces se rompe:
// buscar -> reproducir -> avanzar 4 pistas -> pausar -> reanudar.
//
// Uso: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.SMOKE_PORT) || 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const TRACK_COUNT = 8;

const TRACKS = Array.from({ length: TRACK_COUNT }, (_, i) => ({
  id: `test-${i + 1}`,
  title: `Canción de prueba ${i + 1}`,
  artist: 'Artista de prueba',
  duration: 20,
  durationSeconds: 20,
  durationText: '0:20',
  // data URI: evita peticiones de portada y evita depender de ytimg.
  thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0n1ZcAAAAASUVORK5CYII='
}));

// Pistas de las recomendaciones de Inicio (portadas + géneros de la landing
// de Buscar). Los títulos incluyen palabras de género para probar el arte de
// las tarjetas de "Explorar todo".
const HOME_TRACKS = [
  { id: 'home-1', title: 'Reggaetón de prueba', artist: 'Bad Bunny', duration: 200, durationSeconds: 200, durationText: '3:20' },
  { id: 'home-2', title: 'Pop de prueba', artist: 'Karol G', duration: 180, durationSeconds: 180, durationText: '3:00' },
  { id: 'home-3', title: 'Rock de prueba', artist: 'Soda Stereo', duration: 220, durationSeconds: 220, durationText: '3:40' },
  { id: 'home-4', title: 'Chill de prueba', artist: 'Feid', duration: 195, durationSeconds: 195, durationText: '3:15' },
  { id: 'home-5', title: 'Trap de prueba', artist: 'Duki', duration: 205, durationSeconds: 205, durationText: '3:25' },
  { id: 'home-6', title: 'Cumbia de prueba', artist: 'Silvestre', duration: 210, durationSeconds: 210, durationText: '3:30' },
  { id: 'home-7', title: 'Electrónica de prueba', artist: 'Calvin Harris', duration: 190, durationSeconds: 190, durationText: '3:10' },
  { id: 'home-8', title: 'Balada de prueba', artist: 'Sin Bandera', duration: 230, durationSeconds: 230, durationText: '3:50' }
].map((track) => ({
  ...track,
  thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0n1ZcAAAAASUVORK5CYII='
}));


function makeWav(seconds = 6, rate = 8000) {
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
const AUDIO_HEADERS = {
  'Content-Type': 'audio/wav',
  'Accept-Ranges': 'bytes',
  'Cache-Control': 'no-store'
};

function json(route, body, status = 200) {
  return route.fulfill({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function streamAudio(route, request) {
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

async function activeState(page) {
  return page.evaluate(() => {
    const decks = Array.from(document.querySelectorAll('audio'));
    const deck = decks.find((a) => !a.paused && a.currentTime > 0.15) || null;
    return {
      title: document.getElementById('playerTitle')?.textContent || '',
      artist: document.getElementById('playerArtist')?.textContent || '',
      playing: !!deck,
      currentTime: deck ? deck.currentTime : 0,
      duration: deck && isFinite(deck.duration) ? deck.duration : 0
    };
  });
}

async function waitPlaying(page, timeout = 12000) {
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('audio')).some((a) => !a.paused && a.currentTime > 0.15);
  }, null, { timeout });
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding'
    ]
  });

  const failures = [];
  const pageErrors = [];
  const consoleErrors = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'block'
    });
    const page = await context.newPage();

    page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Los abortos de red externos (YouTube/portadas) son esperados en el test.
      if (/Failed to load resource|net::ERR_|ERR_ABORTED/i.test(text)) return;
      consoleErrors.push(text);
    });

    await page.route('**/*', async (route, request) => {
      const url = new URL(request.url());
      const host = url.host.toLowerCase();

      if (url.origin === BASE) {
        if (url.pathname === '/api/search') return json(route, { tracks: TRACKS, items: TRACKS, continuation: null });
        if (url.pathname === '/api/stream') return streamAudio(route, request);
        if (url.pathname === '/api/relay-info') return json(route, { instances: [] });
        if (url.pathname === '/api/suggestions') return json(route, { queries: [] });
        if (url.pathname === '/api/lyrics') return json(route, {
          syncedLyrics: '[00:00.00]Línea de prueba\n[00:05.00]Segunda línea de prueba',
          plainLyrics: 'Línea de prueba\nSegunda línea de prueba'
        });
        if (url.pathname === '/api/queue') return json(route, { tracks: [] });
        if (url.pathname === '/api/health') return json(route, { ok: true, version: 'test' });
        if (url.pathname === '/api/home') return json(route, {
          shelves: [{ title: 'Mezcla de prueba', items: HOME_TRACKS }]
        });
        if (url.pathname === '/api/artist') return json(route, {});
        if (url.pathname === '/api/album' || url.pathname === '/api/playlist') return json(route, {});
        return route.continue();
      }

      // Relay real: se simula caído para forzar el camino del proxy mockeado.
      if (host === 'yt.chocolatemoo53.com') {
        return route.fulfill({ status: 503, headers: { 'Content-Type': 'application/json' }, body: '{"error":"test"}' });
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

    await page.goto(`${BASE}/?v=smoke`, { waitUntil: 'load' });
    await page.waitForSelector('[data-nav="search"]');
    await page.evaluate(() => document.querySelector('[data-nav="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForSelector('#searchInput');
    await page.fill('#searchInput', 'prueba');
    await page.waitForSelector('#searchResultsList [data-search-idx]', { timeout: 8000 });

    const rows = await page.$$('#searchResultsList [data-search-idx]');
    assert.ok(rows.length >= TRACK_COUNT, `La búsqueda devolvió ${rows.length} filas, se esperaban ${TRACK_COUNT}`);

    await rows[0].evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitPlaying(page);
    let state = await activeState(page);
    assert.match(state.title, /Canción de prueba 1/, `Primera pista inesperada: ${state.title}`);

    for (let step = 1; step <= 4; step++) {
      await page.evaluate(() => {
        const deck = Array.from(document.querySelectorAll('audio')).find((a) => !a.paused && a.currentTime > 0.15);
        if (deck && isFinite(deck.duration)) deck.currentTime = Math.max(0, deck.duration - 0.55);
      });
      await page.waitForFunction(
        (expected) => document.getElementById('playerTitle')?.textContent?.includes(`Canción de prueba ${expected}`),
        step + 1,
        { timeout: 12000 }
      );
      await waitPlaying(page);
      state = await activeState(page);
      assert.match(state.title, new RegExp(`Canción de prueba ${step + 1}`), `Paso ${step}: ${state.title}`);
    }

    // Pausa y reanudación.
    await page.evaluate(() => document.getElementById('playerPlayBtn')?.click());
    await page.waitForFunction(() => {
      const decks = Array.from(document.querySelectorAll('audio'));
      return decks.length > 0 && decks.every((a) => a.paused);
    }, null, { timeout: 4000 });
    await page.evaluate(() => document.getElementById('playerPlayBtn')?.click());
    await waitPlaying(page, 8000);

    // Diagnóstico local en Ajustes: debe reflejar las reproducciones reales.
    await page.evaluate(() => document.querySelector('[data-nav="settings"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForSelector('#diagSummary', { state: 'visible' });
    const diag = await page.evaluate(() => ({
      summary: document.getElementById('diagSummary')?.textContent || '',
      detail: document.getElementById('diagDetail')?.textContent || ''
    }));
    assert.match(diag.summary, /reproducciones/, `Diagnóstico sin datos: ${diag.summary}`);
    assert.match(diag.detail, /recuperaciones/, `Detalle inesperado: ${diag.detail}`);

    // Letras: el parser compartido debe pintar las líneas sincronizadas.
    await page.evaluate(() => document.getElementById('miniPlayer')?.click());
    await page.waitForSelector('#tabLyricsBtn', { state: 'visible', timeout: 8000 });
    await page.evaluate(() => document.getElementById('tabLyricsBtn')?.click());
    await page.waitForFunction(
      () => document.querySelectorAll('#lyricsContainer .lyric-line').length >= 2,
      null,
      { timeout: 10000 }
    );
    const lyricText = await page.evaluate(
      () => document.querySelector('#lyricsContainer .lyric-text')?.textContent || ''
    );
    assert.match(lyricText, /Línea de prueba/, `Letra inesperada: ${lyricText}`);

    // Compartir letra: la tarjeta debe llevar el verso real (no solo la
    // canción) y permitir cambiar de verso, como en Spotify.
    await page.evaluate(() => {
      const first = document.querySelector('#lyricsContainer .lyric-line');
      if (first) first.click();
    });
    await page.waitForTimeout(350);
    await page.evaluate(() => document.getElementById('btnShareLyrics')?.click());
    await page.waitForSelector('#storyShareModal:not(.hidden)', { timeout: 12000 });
    const share = await page.evaluate(() => ({
      verse: document.getElementById('storyShareVerse')?.textContent || '',
      counter: document.getElementById('storyShareCounter')?.textContent || '',
      preview: document.getElementById('storySharePreview')?.getAttribute('src') || ''
    }));
    assert.match(share.verse, /Línea de prueba/, `La tarjeta no incluyó el verso: ${share.verse}`);
    assert.match(share.counter, /^1 \/ 2$/, `Contador de versos inesperado: ${share.counter}`);
    assert.match(share.preview, /^blob:/, `Vista previa no generada: ${share.preview}`);

    await page.evaluate(() => document.getElementById('storyShareNextBtn')?.click());
    await page.waitForFunction(
      () => /Segunda línea de prueba/.test(document.getElementById('storyShareVerse')?.textContent || ''),
      null,
      { timeout: 10000 }
    );
    const shareNext = await page.evaluate(() => ({
      counter: document.getElementById('storyShareCounter')?.textContent || '',
      verse: document.getElementById('storyShareVerse')?.textContent || ''
    }));
    assert.match(shareNext.counter, /^2 \/ 2$/, `Contador tras cambiar de verso: ${shareNext.counter}`);
    await page.evaluate(() => document.getElementById('storyShareCloseBtn')?.click());
    await page.waitForFunction(
      () => document.getElementById('storyShareModal')?.classList.contains('hidden'),
      null,
      { timeout: 5000 }
    );

    // Landing de Buscar: mezclas con portadas reales, arte en géneros e
    // historial, en vez de solo tarjetas de color.
    await page.evaluate(() => document.getElementById('playerCloseBtn')?.click());
    await page.evaluate(() => document.querySelector('[data-nav="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForFunction(
      () => document.querySelectorAll('#searchDiscoverList [data-discover-idx]').length > 0,
      null,
      { timeout: 12000 }
    );
    const landing = await page.evaluate(() => ({
      discover: document.querySelectorAll('#searchDiscoverList [data-discover-idx]').length,
      covers: document.querySelectorAll('#searchDiscoverList img').length,
      genreArt: document.querySelectorAll('#searchGenresWrap .genre-art-img').length,
      continueCards: document.querySelectorAll('#searchContinueList [data-continue-idx]').length
    }));
    assert.ok(landing.discover >= 3, `La landing de Buscar no generó varias mezclas: ${landing.discover}`);
    assert.ok(landing.covers >= landing.discover, `Cada mezcla debe tener portada: ${landing.covers}/${landing.discover}`);
    assert.ok(landing.genreArt >= 2, `Los géneros no recibieron portadas: ${landing.genreArt}`);
    assert.ok(landing.continueCards >= 1, 'No apareció "Sigue escuchando" con el historial');

    // Datos locales corruptos: la app debe arrancar igual, sin perder la calma.
    await page.evaluate(() => {
      localStorage.setItem('fs_favorites', '{no es json');
      localStorage.setItem('fs_stats', '[1,2]');
      localStorage.setItem('fs_playlists', '"texto"');
      localStorage.setItem('fs_history', 'null');
      localStorage.setItem('fs_visual_v1', 'roto');
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('[data-nav="search"]', { timeout: 15000 });
    await page.waitForSelector('[data-nav="settings"]', { timeout: 15000 });

    assert.deepEqual(pageErrors, [], `Errores JS: ${pageErrors.join(' | ')}`);
    assert.deepEqual(consoleErrors, [], `Errores de consola: ${consoleErrors.join(' | ')}`);

    console.log('SMOKE OK');
    console.log(`  búsqueda: ${rows.length} resultados`);
    console.log('  reproducción: 1 pista + 4 cambios automáticos');
    console.log('  controles: pausa y reanudación');
    console.log('  diagnóstico: métricas locales visibles en Ajustes');
    console.log('  letras: 2 líneas sincronizadas renderizadas');
    console.log('  compartir letra: tarjeta con verso real y selector');
    console.log('  buscar: mezclas con portadas y arte en géneros');
    console.log('  almacenamiento: arranque correcto con datos corruptos');
  } catch (err) {
    failures.push(err);
    console.error('SMOKE FAIL:', err && err.message ? err.message : err);
    if (pageErrors.length) console.error('  JS:', pageErrors.join(' | '));
    if (consoleErrors.length) console.error('  consola:', consoleErrors.join(' | '));
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }

  if (failures.length) process.exit(1);
}

run().catch((err) => {
  console.error('SMOKE FAIL:', err);
  process.exit(1);
});

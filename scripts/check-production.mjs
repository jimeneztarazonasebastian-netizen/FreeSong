// Comprobación optativa con proveedores reales. No forma parte de npm test:
// las fuentes externas pueden fallar y no equivale a bloquear un iPhone real.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = 'https://freesong-pied.vercel.app';
const expected = process.argv[2];
const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-background-timer-throttling'] });
const context = await browser.newContext({ userAgent: ua, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const snapshot = () => page.evaluate(() => {
  const p = window.FreeSongDiag?.report().playback;
  return { track: p?.track, index: p?.index, playing: p?.isPlaying, state: navigator.mediaSession?.playbackState, decks: p?.decks };
});
try {
  const health = await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(20000) })).json();
  assert.equal(health.engine?.reachable, true, 'La búsqueda de producción debe responder');
  if (expected) assert.equal(health.version, expected, 'El dominio debe servir la versión publicada');
  console.log(`PRODUCCIÓN: v${health.version}; catálogo responde en ${health.engine.latencyMs} ms`);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-nav="search"]').first().click();
  await page.locator('#searchInput').fill('Candy Plan B');
  await page.locator('#searchResultsList [data-search-idx]').first().waitFor({ timeout: 25000 });
  console.log(`BÚSQUEDA: ${await page.locator('#searchResultsList [data-search-idx]').count()} resultados`);
  await page.locator('#searchResultsList [data-search-idx]').first().click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('audio')).some((a) => a.dataset.trackId && !a.paused && a.currentTime > 1), null, { timeout: 60000 });
  const first = await snapshot();
  assert.equal(first.state, 'playing');
  console.log(`AUDIO: ${first.track?.title}; ${first.state}`);
  await page.locator('#miniPlayBtn').click();
  await page.waitForFunction(() => navigator.mediaSession.playbackState === 'paused');
  await page.locator('#miniPlayBtn').click();
  await page.waitForFunction(() => navigator.mediaSession.playbackState === 'playing');
  // Permite resolver la precarga, pero no espera a reproducir una canción entera.
  await page.waitForTimeout(6000);
  const previousIndex = (await snapshot()).index;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const active = Array.from(document.querySelectorAll('audio')).find((a) => a.dataset.trackId && !a.paused);
    assertFiniteDuration(active);
    function assertFiniteDuration(deck) {
      if (!deck || !Number.isFinite(deck.duration)) throw new Error('Sin duración de audio');
      deck.currentTime = Math.max(0, deck.duration - 0.3);
    }
  });
  await page.waitForFunction((index) => {
    const p = window.FreeSongDiag?.report().playback;
    return p?.index !== index && p?.isPlaying && Array.from(document.querySelectorAll('audio')).some((a) => !a.paused && a.currentTime > 0.5);
  }, previousIndex, { timeout: 60000 });
  assert.equal((await snapshot()).state, 'playing');
  console.log(`SIGUIENTE CON VISIBILIDAD OCULTA: ${(await snapshot()).track?.title}`);
  assert.deepEqual(errors, []);
  console.log('PRODUCCIÓN OK: búsqueda real → audio → pausa/reanudación → siguiente. Chrome; no prueba física de iOS.');
} catch (error) {
  console.error('PRODUCCIÓN FALLÓ:', error.message);
  console.error(JSON.stringify(await snapshot().catch(() => null)));
  process.exitCode = 1;
} finally {
  await browser.close();
}

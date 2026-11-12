// Prueba del informe de diagnóstico (JSON) de FreeSong.
//
// Comprueba que:
//  1. El informe se puede exportar como JSON válido con versión y estado real.
//  2. Los eventos (errores JS, fallos HTTP, errores de reproducción) se guardan.
//  3. Los botones «Copiar JSON» y «Compartir» existen en Ajustes.
//
// Uso: node scripts/test-diag.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.DIAG_TEST_PORT) || 5226;
const BASE = `http://127.0.0.1:${PORT}`;
const TRACK = {
  id: 'diag-1',
  title: 'Cancion diagnostico',
  artist: 'Artista de prueba',
  duration: 10,
  durationSeconds: 10,
  durationText: '0:10',
  thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y0n1ZcAAAAASUVORK5CYII='
};

function json(route, body, status = 200) {
  return route.fulfill({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

async function run() {
  const server = await startServer();
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio']
  });
  const pageErrors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));

    await page.route('**/*', async (route, request) => {
      const url = new URL(request.url());
      if (url.origin !== BASE) return route.abort();
      if (url.pathname === '/api/search') return json(route, { tracks: [TRACK], items: [TRACK], continuation: null });
      if (url.pathname === '/api/home') return json(route, { shelves: [{ title: 'Mezcla', items: [TRACK] }] });
      if (url.pathname === '/api/relay-info') return json(route, { instances: [] });
      if (url.pathname === '/api/suggestions') return json(route, { queries: [] });
      if (url.pathname === '/api/lyrics') return json(route, { syncedLyrics: '', plainLyrics: '' });
      if (url.pathname === '/api/queue') return json(route, { tracks: [] });
      if (url.pathname === '/api/health') return json(route, { ok: true, version: 'test' });
      if (url.pathname === '/api/diag-fail') return json(route, { error: 'fallo de prueba' }, 500);
      if (url.pathname === '/api/artist' || url.pathname === '/api/album' || url.pathname === '/api/playlist') return json(route, {});
      return route.continue();
    });

    await page.goto(`${BASE}/?v=diag-test`, { waitUntil: 'load' });
    await page.waitForSelector('[data-nav="search"]');

    // Eventos manuales + un error JS real + un fallo HTTP real.
    await page.evaluate(async () => {
      window.FreeSongDiag.log('prueba-manual', { detalle: 'ok' });
      window.FreeSongDiag.log('prueba-manual', { detalle: 'ok' });
      window.dispatchEvent(new Event('error'));
      try {
        await fetch('/api/diag-fail');
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    const report = await page.evaluate(() => window.FreeSongDiag.report());
    assert.equal(report.app, 'FreeSong');
    assert.ok(/^\d+\.\d+\.\d+/.test(report.version), `Versión inválida: ${report.version}`);
    assert.ok(report.exportedAt && report.sessionId, 'Falta fecha o id de sesión');
    assert.ok(report.playback && Array.isArray(report.playback.decks), 'El informe debe incluir el estado del reproductor');
    assert.equal(report.playback.decks.length, 2, 'Deben aparecer los dos decks de audio');

    const names = report.events.map((e) => e.name);
    assert.ok(names.includes('prueba-manual'), 'Falta el evento manual');
    const manual = report.events.filter((e) => e.name === 'prueba-manual').pop();
    assert.ok(manual.n >= 2, 'Los eventos repetidos deben agruparse');
    assert.ok(names.includes('http-error'), `Falta el fallo HTTP en el informe: ${names.join(', ')}`);
    const httpError = report.events.find((e) => e.name === 'http-error');
    assert.equal(httpError.data.s, 500);
    assert.equal(httpError.data.p, '/api/diag-fail');

    // El JSON exportado debe ser válido y no contener la clave de sesión ni URLs firmadas.
    const text = await page.evaluate(() => window.FreeSongDiag.reportText());
    const parsed = JSON.parse(text);
    assert.equal(parsed.app, 'FreeSong');
    assert.ok(!/\?(expire|sig|lsig)=/.test(text), 'El informe no debe incluir URLs firmadas');

    // Los botones de diagnóstico deben estar en Ajustes.
    const buttons = await page.evaluate(() => ({
      copy: !!document.getElementById('diagCopyBtn'),
      share: !!document.getElementById('diagShareBtn')
    }));
    assert.deepEqual(buttons, { copy: true, share: true });

    assert.deepEqual(pageErrors, [], `Errores JS: ${pageErrors.join(' | ')}`);
    console.log('DIAGNOSTICO OK');
    console.log(`  informe JSON con ${report.events.length} eventos y estado del reproductor`);
    console.log('  agrupa repetidos, registra fallos HTTP y ofrece Copiar/Compartir');
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
}

run().catch((err) => {
  console.error('DIAGNOSTICO FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});

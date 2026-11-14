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
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
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
  const keys = await page.evaluate(() => caches.keys());
  assert.ok(keys.includes('another-app-cache'), 'No debe borrar cachés ajenas');
  assert.ok(keys.includes('freesong-offline-audio-v1'), 'Debe conservar audio offline');
  assert.ok(!keys.includes('freesong-v0.0.1'), 'Debe borrar solo shells antiguos');
  await context.setOffline(true);
  await page.goto(base + '/?offline=first-boot', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.FreeSongStorage && !!window.FreeSongUtil && !!window.FreeSongDiag);
  await page.locator('[data-nav="library"]').first().click();
  assert.equal(await page.locator('#viewLibrary').isVisible(), true);
  assert.deepEqual(errors, [], 'El shell debe arrancar offline con scripts versionados');
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

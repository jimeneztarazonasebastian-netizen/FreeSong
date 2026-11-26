// Regresión observada en el informe real: el mismo URL roto no es un respaldo.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
const port = 5234, base = `http://127.0.0.1:${port}`, relay = 'https://yt.chocolatemoo53.com';
const primaryRelay = 'https://eu.yt.chocolatemoo53.com';
const track = { id: 'recovery-1', title: 'Cancion original', artist: 'Artista', duration: 20 };
const wav = Buffer.alloc(44 + 20 * 8000 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.round(Math.sin(i / 8000 * 440 * Math.PI) * 1500), i);
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base)).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const context = await browser.newContext({ serviceWorkers: 'block', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
  const page = await context.newPage();
  let failed = false, aliasRequested = false, checkedPrimaryAudio = false;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  const audio = route => route.fulfill({ contentType: 'audio/wav', headers: { 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' }, body: wav });
  await page.route('**/*', (route, request) => {
    const url = new URL(request.url());
    if (url.origin === base) {
      if (url.pathname === '/api/search') return json(route, { tracks: [track], items: [track] });
      if (url.pathname === '/api/relay-info') return json(route, { instances: [primaryRelay, relay] });
      if (url.pathname === '/api/stream') return failed ? json(route, { error: 'unavailable' }, 502) : audio(route);
      if (url.pathname.startsWith('/api/')) return json(route, { tracks: [], shelves: [], queries: [] });
      return route.continue();
    }
    if (url.origin === primaryRelay || url.origin === relay) {
      if (url.pathname === '/api/v1/search') return json(route, [{ videoId: 'recovery-alias', title: track.title, author: track.artist, lengthSeconds: 20 }]);
      if (url.pathname.startsWith('/api/v1/videos/')) {
        const id = url.pathname.split('/').at(-1);
        const formats = [{ itag: '140', mimeType: 'audio/mp4', url: `${url.origin}/audio/${id}.m4a` }];
        if (url.origin === primaryRelay && id === track.id) {
          formats.push({ itag: '139', mimeType: 'audio/mp4', url: `${url.origin}/audio/${id}-aac48.m4a` });
        }
        return json(route, { adaptiveFormats: formats });
      }
      if (url.origin === primaryRelay && url.pathname.startsWith('/audio/')) {
        if (url.pathname.endsWith('-aac48.m4a') && !failed) return audio(route);
        checkedPrimaryAudio ||= request.headers().range === 'bytes=0-31';
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>blocked</html>' });
      }
      if (url.pathname.includes('recovery-alias.m4a')) { aliasRequested = true; return audio(route); }
      if (url.pathname.startsWith('/audio/')) return failed ? route.fulfill({ status: 403, contentType: 'text/html', body: '<html>blocked</html>' }) : audio(route);
    }
    return route.abort();
  });
  await page.goto(base, { waitUntil: 'load' });
  await page.locator('[data-nav="search"]').first().click();
  await page.locator('#searchInput').fill('recuperacion');
  await page.locator('#searchResultsList [data-search-idx]').first().click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('audio')).some(a => !a.paused && a.currentTime > 0.7 && a.src.includes('/audio/recovery-1-aac48.m4a')));
  assert.equal(checkedPrimaryAudio, true, 'Los metadatos válidos no bastan si el relay no entrega audio');
  failed = true;
  await page.evaluate(() => Array.from(document.querySelectorAll('audio')).find(a => !a.paused && a.currentTime > 0.5).dispatchEvent(new Event('error')));
  await page.waitForFunction(() => Array.from(document.querySelectorAll('audio')).some(a => !a.paused && a.currentTime > 0.5 && a.src.includes('recovery-alias.m4a')), null, { timeout: 22000 });
  assert.equal(aliasRequested, true);
  const report = await page.evaluate(() => window.FreeSongDiag.report());
  assert.ok(report.events.some(event => event.name === 'relay-alt' && event.data.videoId === 'recovery-alias'));
  assert.deepEqual(errors, []);
  console.log('RECUPERACIÓN RELAY OK: AAC alternativo de la misma pista; si falla el relay y el proxy, usa otra publicación verificada');
} finally { await browser?.close(); server.kill(); }

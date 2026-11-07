// Verificación puntual en producción (no se commitea).
import { chromium } from 'playwright-core';

const BASE = 'https://freesong-pied.vercel.app';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', deviceScaleFactor: 2 });
const page = await context.newPage();

const errors = [];
const failed = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
page.on('requestfailed', (req) => {
  const u = new URL(req.url());
  if (u.origin === BASE) failed.push(`${u.pathname} ${req.failure()?.errorText}`);
});

await page.goto(`${BASE}/?cb=${Date.now()}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('[data-nav="search"]', { timeout: 30000 });
await page.waitForTimeout(2500);

await page.evaluate(() => document.querySelector('[data-nav="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

try {
  await page.waitForFunction(
    () => document.querySelectorAll('#searchDiscoverList [data-discover-idx]').length > 0,
    null,
    { timeout: 45000 }
  );
} catch {}

await page.waitForTimeout(2500);

const state = await page.evaluate(() => ({
  discover: document.querySelectorAll('#searchDiscoverList [data-discover-idx]').length,
  covers: document.querySelectorAll('#searchDiscoverList img').length,
  loadedCovers: Array.from(document.querySelectorAll('#searchDiscoverList img')).filter((i) => i.complete && i.naturalWidth > 0).length,
  genreArt: document.querySelectorAll('#searchGenresWrap .genre-art-img').length,
  genreArtLoaded: Array.from(document.querySelectorAll('#searchGenresWrap .genre-art-img')).filter((i) => i.complete && i.naturalWidth > 0).length,
  continueCards: document.querySelectorAll('#searchContinueList [data-continue-idx]').length,
  quickChips: document.querySelectorAll('[data-quick-search]').length,
  titles: Array.from(document.querySelectorAll('#searchDiscoverList [data-discover-idx] p')).slice(0, 4).map((p) => p.textContent.trim()),
  version: document.querySelector('meta[name="app-version"]')?.content || ''
}));

await page.screenshot({ path: 'prod-search.png', fullPage: false });
console.log(JSON.stringify({ state, errors, failed }, null, 2));

await browser.close();

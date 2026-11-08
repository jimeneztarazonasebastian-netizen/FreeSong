// Produccion: cancion SABR (sin relay ni proxy) debe sonar por YouTube Web.
import { chromium } from 'playwright-core';

const BASE = 'https://freesong-pied.vercel.app';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-background-timer-throttling'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text().slice(0, 120)}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/?cb=${Date.now()}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('[data-nav="search"]', { timeout: 30000 });
await page.evaluate(() => document.querySelector('[data-nav="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForSelector('#searchInput');
await page.fill('#searchInput', 'Es Un Secreto Plan B');
await page.waitForFunction(() => /secreto/i.test(document.querySelector('#searchResultsList [data-search-idx]')?.textContent || ''), null, { timeout: 30000 });
await page.waitForTimeout(500);
console.log('resultado:', await page.evaluate(() => document.querySelector('#searchResultsList [data-search-idx]')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 50)));
await page.evaluate(() => document.querySelector('#searchResultsList [data-search-idx]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

for (let i = 0; i < 28; i++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => {
    const active = Array.from(document.querySelectorAll('audio')).find((a) => !a.paused && a.currentTime > 0.1);
    return {
      title: document.getElementById('playerTitle')?.textContent,
      spin: /animate-spin/.test(document.getElementById('miniPlayBtn')?.innerHTML || ''),
      cur: document.getElementById('playerCurTime')?.textContent,
      deck: active ? `${active.dataset.trackId}:${Number(active.currentTime.toFixed(1))}` : null,
      toast: document.getElementById('toastNotification')?.classList.contains('opacity-0') ? '' : document.getElementById('toastText')?.textContent
    };
  });
  console.log(`t+${i + 1}s`, JSON.stringify(s));
}
console.log('logs:', JSON.stringify(logs.slice(-14), null, 1));
await browser.close();

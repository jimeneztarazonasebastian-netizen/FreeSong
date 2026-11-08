// Reproduce en produccion: dar me gusta a 3 canciones y reproducirlas desde Biblioteca.
import { chromium } from 'playwright-core';

const BASE = 'https://freesong-pied.vercel.app';
const QUERIES = ['Es Un Secreto Plan B', 'Hoy Daddy Yankee Farruko', 'Tiempos Remix Yomo Polakan'];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await context.newPage();
const net = [];
const logs = [];
page.on('response', (r) => { if (/\/api\/(stream|queue|lyrics)/.test(r.url())) net.push(`${r.status()} ${new URL(r.url()).pathname}${new URL(r.url()).search.slice(0, 40)}`); });
page.on('console', (m) => { if (m.type() === 'error') logs.push(`error: ${m.text().slice(0, 120)}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/?cb=${Date.now()}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('[data-nav="search"]', { timeout: 30000 });

async function searchAndLike(query) {
  await page.evaluate(() => document.querySelector('[data-nav="search"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForSelector('#searchInput');
  await page.fill('#searchInput', query);
  await page.waitForFunction(
    (q) => {
      const first = document.querySelector('#searchResultsList [data-search-idx]');
      return first && first.textContent && first.textContent.length > 0;
    },
    query,
    { timeout: 25000 }
  );
  await page.waitForTimeout(600);
  const title = await page.evaluate(() => document.querySelector('#searchResultsList [data-search-idx]')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 50));
  await page.evaluate(() => document.querySelector('#searchResultsList [data-search-idx]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForFunction(() => Array.from(document.querySelectorAll('audio')).some((a) => !a.paused && a.currentTime > 0.4), null, { timeout: 40000 });
  await page.evaluate(() => document.getElementById('miniLikeBtn')?.click());
  await page.waitForTimeout(500);
  console.log('like:', title);
}

for (const q of QUERIES) await searchAndLike(q);

await page.evaluate(() => document.querySelector('[data-nav="library"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(1200);
const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#libLikedList [data-lib-track-idx]')).map((el) => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 50)));
console.log('biblioteca:', JSON.stringify(rows));

// Instrumenta y toca la segunda cancion.
await page.evaluate(() => {
  window.__ev = [];
  document.querySelectorAll('audio').forEach((a, i) => {
    ['loadstart', 'play', 'playing', 'pause', 'ended', 'error', 'stalled', 'waiting'].forEach((ev) => {
      a.addEventListener(ev, () => window.__ev.push(`${i}:${ev}:t${Number(a.currentTime.toFixed(1))}:rs${a.readyState}:${(a.src || '').slice(0, 30)}`));
    });
  });
});
net.length = 0;
await page.evaluate(() => document.querySelectorAll('#libLikedList [data-lib-track-idx]')[1]?.click());

for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => ({
    title: document.getElementById('playerTitle')?.textContent,
    spin: /animate-spin/.test(document.getElementById('miniPlayBtn')?.innerHTML || ''),
    toast: document.getElementById('toastNotification')?.classList.contains('opacity-0') ? '' : document.getElementById('toastText')?.textContent,
    decks: Array.from(document.querySelectorAll('audio')).map((a) => `${a.paused ? 'p' : 'P'}:${Number(a.currentTime.toFixed(1))}:rs${a.readyState}:${(a.src || '').slice(0, 26)}`)
  }));
  console.log(`t+${i + 1}s`, JSON.stringify(s));
}

console.log('red:', JSON.stringify(net.slice(0, 30)));
console.log('eventos:', JSON.stringify(await page.evaluate(() => window.__ev)));
console.log('logs:', JSON.stringify(logs.slice(0, 15)));
await browser.close();

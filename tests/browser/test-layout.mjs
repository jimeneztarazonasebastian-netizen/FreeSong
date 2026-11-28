import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const port = 5276;
const base = `http://127.0.0.1:${port}`;
const tracks = [
  { id: 'layout-one', title: 'Una grabación con un nombre muy largo para comprobar que todos los controles siguen visibles', artist: 'Voz principal y artistas invitados', duration: 180 },
  { id: 'layout-two', title: 'Siguiente canción', artist: 'FreeSong', duration: 160 }
];
const sizes = [
  { name: '320 × 568 con texto al 200 %', width: 320, height: 568, text: '200%', top: 59, bottom: 34, side: 0 },
  { name: '667 × 375 en horizontal', width: 667, height: 375, text: '100%', top: 0, bottom: 21, side: 44 },
  { name: '1440 × 900 en escritorio', width: 1440, height: 900, text: '100%', top: 0, bottom: 0, side: 0 }
];

const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 60; i++) {
    if (await fetch(base).then(r => r.ok).catch(() => false)) break;
    await delay(100);
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  for (const size of sizes) {
    const mobile = size.width < 1024;
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height }, serviceWorkers: 'block',
      ...(mobile ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' } : {})
    });
    try {
      await context.addInitScript(tracks => {
        localStorage.setItem('fs_session_v2', JSON.stringify({ queue: tracks, currentIndex: 0, autoplay: false, savedAt: Date.now() }));
        localStorage.setItem('fs_favorites', JSON.stringify(tracks));
        localStorage.setItem('fs_home_v1', JSON.stringify({ shelves: [{ title: 'Para escuchar', items: tracks }] }));
      }, tracks);
      const page = await context.newPage();
      await page.route('**/api/**', route => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ json: path === '/api/home' ? { shelves: [{ title: 'Para escuchar', items: tracks }] } : {} });
      });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.addStyleTag({ content: `:root { font-size: ${size.text}; --safe-area-inset-top: ${size.top}px;
        --safe-area-inset-bottom: ${size.bottom}px; --safe-area-inset-left: ${size.side}px; --safe-area-inset-right: ${size.side}px; }` });

      async function fits(selector, { vertically = true } = {}) {
        for (const item of await page.locator(selector).all()) {
          if (!(await item.isVisible())) continue;
          const rect = await item.boundingBox();
          assert.ok(rect.x >= size.side - 1 && rect.x + rect.width <= size.width - size.side + 1,
            `${size.name} · ${selector} fuera del ancho: ${JSON.stringify(rect)}`);
          assert.ok(!vertically || (rect.y >= -1 && rect.y + rect.height <= size.height + 1),
            `${size.name} · ${selector} fuera del alto: ${JSON.stringify(rect)}`);
        }
      }

      await fits('#appHeader .app-brand, .bottom-nav button');
      await fits('#pwaBannerClose, #homeDjCard', { vertically: false });
      assert.equal(await page.locator('meta[name=viewport]').getAttribute('content'), 'width=device-width, initial-scale=1.0, viewport-fit=cover');
      await page.locator('[data-nav=search]').click();
      await fits('#searchInput, #miniPlayer, .bottom-nav button');
      assert.equal(await page.locator('[data-nav=search]').getAttribute('aria-current'), 'page');

      await page.locator('[data-nav=library]').click();
      await page.locator('#libSortSelect').scrollIntoViewIfNeeded();
      await fits('#libSortSelect');
      await page.locator('#libNewPlaylistBtn').click();
      await fits('#newPlaylistInput, #createPlaylistConfirmBtn');
      await page.keyboard.press('Escape');

      await page.locator('[data-nav=settings]').click();
      const reset = page.locator('#btnClearData');
      await reset.scrollIntoViewIfNeeded();
      await fits('#btnClearData, .bottom-nav button');
      const settingsFits = await page.locator('#viewSettings').evaluate(el => el.scrollWidth <= el.clientWidth + 1);
      assert.ok(settingsFits, `${size.name} · Ajustes necesita desplazamiento horizontal`);

      const sheet = page.locator('#fullPlayerSheet');
      assert.equal(await sheet.getAttribute('aria-hidden'), 'true');
      const mini = page.locator('#miniOpenBtn');
      await mini.focus();
      await page.keyboard.press('Enter');
      await page.locator('#playerCloseBtn').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('#fullPlayerSheet').getBoundingClientRect().y < 1);
      assert.equal(await page.locator('#playerCloseBtn').evaluate(btn => btn === document.activeElement), true);
      assert.equal(await page.locator('#mainContainer').evaluate(el => el.inert), true);
      await fits('#playerCloseBtn, .player-tabs button, #playerSeek, #playerPlayBtn, #playerRepeatBtn');
      await page.locator('#tabQueueBtn').click();
      await fits('#tabQueueBtn, #playerSeek, #playerPlayBtn, #playerNextBtn, #playerRepeatBtn');
      await page.keyboard.press('Escape');
      assert.equal(await mini.evaluate(btn => btn === document.activeElement), true);
      assert.equal(await sheet.evaluate(el => el.inert), true);
      const artist = page.locator('#miniArtist');
      if (mobile) await artist.tap();
      else await artist.click();
      assert.equal(await sheet.evaluate(el => el.inert), false);
      await page.keyboard.press('Escape');
      console.log(`  ${size.name}: navegación, biblioteca, ajustes y reproductor`);
    } finally { await context.close(); }
  }
  console.log('DISEÑO ADAPTABLE OK: áreas seguras, texto ampliado, teclado y controles dentro de pantalla');
} finally {
  await browser?.close();
  server.kill();
}

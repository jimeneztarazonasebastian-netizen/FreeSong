import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const port = Number(process.env.YOUTUBE_ACCOUNT_TEST_PORT) || 5254;
const base = `http://127.0.0.1:${port}`;
const scope = 'https://www.googleapis.com/auth/youtube.readonly';
const clientId = 'fixture.apps.googleusercontent.com';
const token = 'fixture-token-only-in-memory';
const playlistId = 'PLfixture';
const sourceTrack = { id: 'testTrack01', title: 'Pista en reproducción', artist: 'Prueba', duration: 60 };
const originalList = { id: 'local-list', name: 'Mi lista original', tracks: [sourceTrack] };
const publicListUrl = 'https://www.youtube.com/playlist?list=PLpublicFixture';
const playlistTrack = 'testTrack02';
const likedTrack = 'testTrack03';
const privateTrack = 'testTrack04';

const media = Buffer.alloc(44 + 60 * 8000 * 2);
media.write('RIFF', 0);
media.writeUInt32LE(media.length - 8, 4);
media.write('WAVEfmt ', 8);
media.writeUInt32LE(16, 16);
media.writeUInt16LE(1, 20);
media.writeUInt16LE(1, 22);
media.writeUInt32LE(8000, 24);
media.writeUInt32LE(16000, 28);
media.writeUInt16LE(2, 32);
media.writeUInt16LE(16, 34);
media.write('data', 36);
media.writeUInt32LE(media.length - 44, 40);

function youtubeVideo(id, title, privacyStatus = 'public') {
  return {
    id,
    snippet: { title, channelTitle: 'Artista - Topic', liveBroadcastContent: 'none' },
    contentDetails: { duration: 'PT2M10S' },
    status: { privacyStatus, uploadStatus: 'processed' }
  };
}

const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  env: { ...process.env, PORT: String(port) }, stdio: 'ignore'
});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try { ready = (await fetch(base)).ok; } catch {}
    if (!ready) await delay(100);
  }
  assert.ok(ready, 'El servidor de prueba debe estar listo');
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  for (const configured of [false, true]) {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      viewport: { width: 393, height: 852 },
      serviceWorkers: 'block'
    });
    await context.addInitScript(({ track, list }) => {
      Object.defineProperty(navigator, 'standalone', { value: true });
      localStorage.setItem('fs_favorites', JSON.stringify([track]));
      localStorage.setItem('fs_playlists', JSON.stringify([list]));
      localStorage.setItem('fs_session_v2', JSON.stringify({
        queue: [track], currentIndex: 0, repeat: 'off', autoplay: false, savedAt: Date.now()
      }));
    }, { track: sourceTrack, list: originalList });
    const page = await context.newPage();
    const errors = [];
    const googleRequests = [];
    const firstPartyRequests = [];
    const imports = [];
    let playlistReads = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === base) firstPartyRequests.push(request);
      if (['accounts.google.com', 'www.googleapis.com'].includes(url.hostname)) googleRequests.push(request);
    });
    await page.route('https://**/*', route => route.abort());
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/stream') {
        return route.fulfill({ contentType: 'audio/wav', body: media });
      }
      if (url.pathname === '/api/import') {
        if (url.searchParams.get('youtube-config') === '1') {
          return route.fulfill({ json: { clientId: configured ? clientId : null } });
        }
        imports.push(url.searchParams.get('url'));
        return route.fulfill({ json: { name: 'Lista por enlace', tracks: [sourceTrack] } });
      }
      return route.fulfill({ json: { tracks: [], shelves: [], queries: [] } });
    });
    await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.gisFixture = { attempts: [], grants: [], revocations: [] };
        window.google = { accounts: { oauth2: {
          initTokenClient(config) {
            return { requestAccessToken(options) {
              window.gisFixture.attempts.push({
                clientId: config.client_id, scope: config.scope, includeGranted: config.include_granted_scopes,
                userActive: navigator.userActivation.isActive, prompt: options.prompt,
                clickTarget: window.event?.isTrusted ? window.event.currentTarget?.id : null
              });
              setTimeout(() => config.callback({ access_token: ${JSON.stringify(token)}, expires_in: 3600 }), 0);
            } };
          },
          hasGrantedAllScopes(response, scope) {
            window.gisFixture.grants.push(scope);
            return response.access_token === ${JSON.stringify(token)} && scope === ${JSON.stringify(scope)};
          },
          revoke(token, callback) {
            window.gisFixture.revocations.push(token);
            callback({ successful: true });
          }
        } } };
      `
    }));
    await page.route('https://www.googleapis.com/youtube/v3/**', route => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = {
        'Access-Control-Allow-Origin': base,
        'Access-Control-Allow-Headers': 'authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
      };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      assert.equal(request.method(), 'GET');
      assert.equal(request.headers().authorization, `Bearer ${token}`);
      assert.ok(!url.href.includes(token));
      let items;
      switch (url.pathname.split('/').pop()) {
        case 'channels':
          assert.equal(url.searchParams.get('mine'), 'true');
          items = [{ id: 'channel-fixture', snippet: { title: 'Mi canal de prueba' } }];
          break;
        case 'playlists':
          assert.equal(url.searchParams.get('mine'), 'true');
          items = [{ id: playlistId, snippet: { title: 'Lista de mi cuenta' }, contentDetails: { itemCount: 2 } }];
          break;
        case 'playlistItems':
          assert.equal(url.searchParams.get('playlistId'), playlistId);
          items = [playlistTrack, privateTrack].map(videoId => ({ contentDetails: { videoId } }));
          break;
        case 'videos':
          if (url.searchParams.get('myRating') === 'like') {
            items = [youtubeVideo(likedTrack, 'Mi canción favorita')];
          } else {
            assert.equal(url.searchParams.get('id'), `${playlistTrack},${privateTrack}`);
            playlistReads++;
            items = [youtubeVideo(playlistTrack, `Canción de mi lista ${playlistReads}`),
              youtubeVideo(privateTrack, 'No reproducible', 'private')];
          }
          break;
        default:
          throw new Error(`Ruta de YouTube inesperada: ${url.pathname}`);
      }
      return route.fulfill({ headers, json: { items } });
    });

    await page.goto(base, { waitUntil: 'load' });
    if (configured) {
      await page.locator('#miniPlayBtn').click();
      await page.waitForFunction(id => [...document.querySelectorAll('audio')].some(audio =>
        audio.dataset.trackId === id && !audio.paused && audio.currentTime > 0.1), sourceTrack.id);
    }
    await page.locator('[data-nav="library"]').first().click();
    await page.locator('#libImportBtn').click();
    assert.deepEqual(googleRequests, []);
    assert.ok(!firstPartyRequests.some(request => request.url().includes('youtube-config')));
    const configReady = page.waitForResponse(response => response.url().includes('youtube-config'));
    await page.locator('#youtubeImportTitle').click();
    await configReady;
    if (configured) {
      await page.waitForFunction(() => !document.getElementById('youtubeImportConsent').disabled);
    } else {
      await page.waitForFunction(() => /no está configurado/.test(document.getElementById('youtubeImportStatus').textContent));
    }
    assert.deepEqual(googleRequests, [], 'Abrir el importador no debe contactar Google');
    assert.ok(await page.locator('#youtubeConnectBtn').isDisabled());

    if (!configured) {
      await page.locator('#importPlaylistUrl').fill(publicListUrl);
      await page.locator('#importPlaylistStartBtn').click();
      await page.locator('#importPlaylistModal').waitFor({ state: 'hidden' });
      assert.deepEqual(imports, [publicListUrl]);
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.fs_playlists).map(list => list.name)),
        [originalList.name, 'Lista por enlace']);
      assert.deepEqual(googleRequests, []);
    } else {
      await page.locator('#youtubeImportConsent').check();
      await page.locator('#youtubeConnectBtn').click();
      await page.locator('#youtubeImportAccount').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#youtubeImportChannel').textContent(), 'Mi canal de prueba');
      assert.deepEqual(await page.evaluate(() => window.gisFixture.attempts), [{
        clientId, scope, includeGranted: false, userActive: true, prompt: 'select_account', clickTarget: 'youtubeConnectBtn'
      }]);
      assert.deepEqual(await page.evaluate(() => window.gisFixture.grants), [scope]);

      await page.locator('#youtubePlaylistsBtn').click();
      const playlist = page.locator('#youtubeImportList').getByRole('button', { name: 'Lista de mi cuenta' });
      const storedPlaylists = () => page.evaluate(() => JSON.parse(localStorage.fs_playlists));
      const waitForTrack = title => page.waitForFunction(name => JSON.parse(localStorage.fs_playlists)
        .some(list => list.tracks.some(track => track.title === name)), title);
      await playlist.click();
      await waitForTrack('Canción de mi lista 1');
      const firstCopy = (await storedPlaylists()).find(list => list.youtubeImport?.sourceId === playlistId);
      assert.deepEqual(firstCopy.tracks.map(track => track.id), [playlistTrack]);
      await playlist.click();
      await waitForTrack('Canción de mi lista 2');
      await page.locator('#youtubeLikedBtn').click();
      await waitForTrack('Mi canción favorita');
      const lists = await storedPlaylists();
      assert.deepEqual(lists.map(list => list.name), [originalList.name, 'Lista de mi cuenta', 'Me gusta de YouTube']);
      assert.equal(lists[1].id, firstCopy.id);
      assert.deepEqual(lists[2].tracks.map(track => track.id), [likedTrack]);
      assert.deepEqual(lists[0], originalList);
      assert.ok(!JSON.stringify(await context.storageState({ indexedDB: true })).includes(token));
      assert.ok(!await page.evaluate(value => JSON.stringify({ ...sessionStorage }).includes(value), token));
      for (const request of firstPartyRequests) {
        assert.ok(!JSON.stringify([request.url(), await request.allHeaders(), request.postData()]).includes(token));
      }
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.fs_favorites)), [sourceTrack]);
      const playback = await page.evaluate(() => window.FreeSongDiag.report().playback);
      assert.equal(playback.track.id, sourceTrack.id);
      assert.equal(playback.queueLength, 1);
      assert.equal(playback.isPlaying, true);
      assert.equal(playback.offline.downloads, 0);

      await page.locator('#youtubeDisconnectBtn').click();
      await page.locator('#youtubeImportAccount').waitFor({ state: 'hidden' });
      assert.deepEqual(await page.evaluate(() => window.gisFixture.revocations), [token]);
      assert.deepEqual(await storedPlaylists(), [originalList]);
      assert.ok(!await page.locator('#youtubeImportConsent').isChecked());
      assert.ok(await page.locator('#youtubeConnectBtn').isDisabled());
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('YouTube en PWA OK: consentimiento, alcance de solo lectura, importación local, desconexión y enlace público');
} finally {
  await browser?.close();
  server.kill();
}

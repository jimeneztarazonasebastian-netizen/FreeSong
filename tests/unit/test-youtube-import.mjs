import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const token = 'test-access-token';
const window = {};
const code = readFileSync(new URL('../../www/youtube-import.js', import.meta.url), 'utf8');
runInNewContext(code, { window, URL, URLSearchParams, DOMException, AbortSignal });
const { getChannel, listPlaylists, readPlaylist, readLikedVideos } = window.FreeSongYouTubeImport;

const respond = (data, status = 200) => new Response(JSON.stringify(data), { status });
const mockFetch = (responder) => {
  window.fetch = async (raw, options) => {
    const url = new URL(raw);
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.match(url.pathname, /^\/youtube\/v3\//);
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.ok(!raw.includes(token));
    return responder(url);
  };
};

mockFetch((url) => {
  assert.equal(url.pathname, '/youtube/v3/channels');
  assert.equal(url.searchParams.get('mine'), 'true');
  assert.equal(url.searchParams.get('maxResults'), '1');
  assert.equal(url.searchParams.get('fields'), 'items(id,snippet(title))');
  return respond({ items: [{ id: 'UCExample', snippet: { title: 'Mi canal' } }] });
});
const channel = await getChannel(token);
assert.equal(channel.id, 'UCExample');
assert.equal(channel.title, 'Mi canal');
mockFetch(() => respond({ items: [] }));
await assert.rejects(getChannel(token), error => error.code === 'channel-required');

mockFetch((url) => {
  assert.equal(url.pathname, '/youtube/v3/playlists');
  assert.equal(url.searchParams.get('mine'), 'true');
  assert.equal(url.searchParams.get('maxResults'), '50');
  if (url.searchParams.has('pageToken')) {
    assert.equal(url.searchParams.get('pageToken'), 'owned-next');
    return respond({ items: [{ id: 'PL2', snippet: { title: 'Dos' } }] });
  }
  return respond({
    nextPageToken: 'owned-next',
    items: [{ id: 'PL1', snippet: { title: ' Uno ' }, contentDetails: { itemCount: 12 } }]
  });
});
const lists = await listPlaylists(token);
assert.deepEqual(Array.from(lists.items, ({ id, title, trackCount }) => [id, title, trackCount]),
  [['PL1', 'Uno', 12], ['PL2', 'Dos', 0]]);
assert.equal(lists.truncated, false);

const first = 'AAAAAAAAAAA';
const second = 'BBBBBBBBBBB';
const privateId = 'CCCCCCCCCCC';
const missing = 'DDDDDDDDDDD';
const live = 'EEEEEEEEEEE';
const invalid = 'FFFFFFFFFFF';
const video = (id, privacyStatus = 'public') => ({
  id,
  snippet: { title: `Título ${id}`, channelTitle: 'Artista - Topic', liveBroadcastContent: 'none' },
  contentDetails: { duration: 'PT3M8S' },
  status: { privacyStatus, uploadStatus: 'processed' }
});
const playlistItems = (...ids) => ids.map(videoId => ({ contentDetails: { videoId } }));
mockFetch((url) => {
  if (url.pathname === '/youtube/v3/playlistItems') {
    assert.equal(url.searchParams.get('playlistId'), 'PL123');
    return url.searchParams.has('pageToken')
      ? respond({ items: playlistItems(first, live, invalid, 'bad') })
      : respond({ nextPageToken: 'next', items: playlistItems(first, privateId, second, missing) });
  }
  assert.equal(url.pathname, '/youtube/v3/videos');
  assert.equal(url.searchParams.get('id'), [first, privateId, second, missing, live, invalid].join(','));
  assert.equal(url.searchParams.has('maxResults'), false);
  const liveTrack = video(live);
  liveTrack.snippet.liveBroadcastContent = 'live';
  const invalidTrack = video(invalid);
  invalidTrack.status.uploadStatus = 'rejected';
  return respond({ items: [video(second), video(missing, 'unlisted'), video(privateId, 'private'), video(first), liveTrack, invalidTrack] });
});
const imported = await readPlaylist(token, 'PL123');
assert.deepEqual(Array.from(imported.items, ({ id }) => id), [first, second]);
assert.equal(imported.items[0].artist, 'Artista');
assert.equal(imported.items[0].durationSeconds, 188);
assert.equal(imported.items[0].durationText, '3:08');
assert.equal(imported.items[0].thumbnail, `https://i.ytimg.com/vi/${first}/hqdefault.jpg`);

let requests = 0;
mockFetch((url) => {
  assert.equal(url.pathname, '/youtube/v3/videos');
  assert.equal(url.searchParams.get('myRating'), 'like');
  if (requests > 0) assert.equal(url.searchParams.get('pageToken'), String(requests));
  const items = Array.from({ length: 50 }, (_, i) => video('vid' + String(requests * 50 + i).padStart(8, '0')));
  return respond({ items, nextPageToken: String(++requests) });
});
const liked = await readLikedVideos(token);
assert.equal(requests, 4);
assert.equal(liked.items.length, 200);
assert.equal(liked.truncated, true);

mockFetch(() => respond({ error: { message: token, errors: [{ reason: 'quotaExceeded' }] } }, 403));
await assert.rejects(readLikedVideos(token), error => error.code === 'quota' && !error.message.includes(token));
mockFetch(() => respond({}, 401));
await assert.rejects(listPlaylists(token), error => error.code === 'auth');
await assert.rejects(readPlaylist(token, '../abc'), error => error.code === 'invalid-playlist');
const controller = new AbortController();
controller.abort();
await assert.rejects(listPlaylists(token, { signal: controller.signal }), error => error.name === 'AbortError');

console.log('YOUTUBE IMPORT OK');

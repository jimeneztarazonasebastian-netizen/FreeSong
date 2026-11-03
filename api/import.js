// api/import.js - Importador de playlists públicas de Spotify / YouTube
// Devuelve { source, name, tracks } donde cada track puede traer `id` (YouTube)
// o solo { title, artist } para que el cliente lo resuelva con /api/search.
import { fetchYt, parseDuration, cleanThumb, getRunsText, sendJson } from './_yt.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_TRACKS = 200;

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const raw = String((req.query && req.query.url) || urlObj.searchParams.get('url') || '').trim();

  if (!raw) {
    return sendJson(res, { error: 'Falta el enlace de la playlist', tracks: [] }, 400, 0);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return sendJson(res, { error: 'El enlace no es válido', tracks: [] }, 400, 0);
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return sendJson(res, { error: 'El enlace debe empezar por http o https', tracks: [] }, 400, 0);
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

  try {
    let result;
    if (host === 'open.spotify.com' || host === 'spotify.com') {
      result = await importSpotify(parsed);
    } else if (host === 'music.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
      result = await importYouTube(parsed);
    } else {
      return sendJson(res, { error: 'Solo se admiten enlaces de Spotify, YouTube o YouTube Music', tracks: [] }, 400, 0);
    }

    if (!result || !Array.isArray(result.tracks) || result.tracks.length === 0) {
      return sendJson(res, { error: 'No se encontraron canciones en ese enlace', tracks: [] }, 404, 0);
    }

    return sendJson(res, result, 200, 600);
  } catch (err) {
    return sendJson(res, { error: err.message || 'No se pudo importar la playlist', tracks: [] }, 502, 0);
  }
}

// --- Spotify: scraping del embed público (__NEXT_DATA__) ---
async function importSpotify(urlObj) {
  const parts = urlObj.pathname.split('/').filter(Boolean);
  const kind = parts[0];
  const id = parts[1];
  if (!id || !['playlist', 'album'].includes(kind)) {
    throw new Error('El enlace debe ser de una playlist o álbum de Spotify');
  }

  const embedUrl = `https://open.spotify.com/embed/${kind}/${id}`;
  const resp = await fetch(embedUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!resp.ok) {
    throw new Error(`Spotify respondió ${resp.status}. Comprueba que la playlist sea pública.`);
  }

  const html = await resp.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error('Spotify no devolvió datos de la playlist. ¿Es pública?');
  }

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error('No se pudo leer la respuesta de Spotify');
  }

  const entity = data?.props?.pageProps?.state?.data?.entity || data?.props?.pageProps?.entity;
  if (!entity) {
    throw new Error('La playlist de Spotify no está disponible públicamente');
  }

  const list = Array.isArray(entity.trackList) ? entity.trackList : [];
  const tracks = [];

  for (const item of list) {
    if (!item || item.entityType === 'episode') continue;
    const title = String(item.title || '').trim();
    if (!title) continue;
    const artist = String(item.subtitle || '').split(',').map((s) => s.trim()).filter(Boolean).join(', ') || 'Artista';
    const ms = Number(item.duration) || 0;
    const seconds = Math.round(ms / 1000);
    tracks.push({
      title,
      artist,
      duration: seconds,
      durationSeconds: seconds,
      durationText: seconds ? formatTime(seconds) : ''
    });
    if (tracks.length >= MAX_TRACKS) break;
  }

  const name = String(entity.name || entity.title || 'Playlist de Spotify').trim();
  return { source: 'spotify', name, tracks };
}

// --- YouTube / YouTube Music ---
async function importYouTube(urlObj) {
  const host = urlObj.hostname.replace(/^www\./, '').toLowerCase();
  const listId = urlObj.searchParams.get('list');
  const videoId = extractVideoId(urlObj);

  if (listId) {
    return importYtPlaylist(listId);
  }

  if (videoId) {
    return importYtVideo(videoId, host);
  }

  throw new Error('El enlace de YouTube no contiene una playlist ni una canción');
}

function extractVideoId(urlObj) {
  const host = urlObj.hostname.replace(/^www\./, '').toLowerCase();
  const path = urlObj.pathname;

  if (host === 'youtu.be') {
    return path.split('/').filter(Boolean)[0] || null;
  }
  const v = urlObj.searchParams.get('v');
  if (v) return v;
  const m = path.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function importYtPlaylist(listId) {
  const browseId = listId.startsWith('VL') ? listId : 'VL' + listId;
  let data = await fetchYt('browse', { browseId }, { timeoutMs: 12000 });

  const headerSec = data.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0];
  const header = headerSec?.musicResponsiveHeaderRenderer
    || data.header?.musicDetailHeaderRenderer
    || data.header?.musicResponsiveHeaderRenderer;

  const title = getRunsText(header?.title?.runs) || getRunsText(header?.title?.text ? [{ text: header.title.text }] : []) || 'Playlist de YouTube';
  const tracks = [];
  const seen = new Set();

  const section = data.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents?.[0];
  let shelf = section?.musicPlaylistShelfRenderer || section?.musicShelfRenderer;
  let nextToken = shelf?.continuations?.[0]?.nextContinuationData?.continuation
    || shelf?.continuations?.[0]?.nextRadioContinuationData?.continuation
    || null;

  collectYtPlaylistTracks(shelf?.contents, tracks, seen);

  // Hasta 3 páginas extra: suficiente para playlists largas sin eternizar la respuesta.
  let pages = 0;
  while (nextToken && tracks.length < MAX_TRACKS && pages < 3) {
    pages++;
    try {
      const cont = await fetchYt('browse', { continuation: nextToken }, { timeoutMs: 10000 });
      const contShelf = cont.continuationContents?.musicPlaylistShelfContinuation
        || cont.continuationContents?.musicShelfContinuation;
      collectYtPlaylistTracks(contShelf?.contents, tracks, seen);
      nextToken = contShelf?.continuations?.[0]?.nextContinuationData?.continuation || null;
    } catch {
      break;
    }
  }

  return {
    source: 'youtube',
    name: title.slice(0, 60),
    tracks: tracks.slice(0, MAX_TRACKS)
  };
}

function collectYtPlaylistTracks(rawList, tracks, seen) {
  if (!Array.isArray(rawList)) return;
  for (const item of rawList) {
    if (tracks.length >= MAX_TRACKS) return;
    const r = item.musicResponsiveListItemRenderer;
    if (!r) continue;

    const col0 = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const col1 = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const title = getRunsText(col0).trim();
    const subText = getRunsText(col1);
    const parts = subText.split('•').map((p) => p.trim()).filter(Boolean);
    const artist = parts[0] || 'Artista';

    const id = col0[0]?.navigationEndpoint?.watchEndpoint?.videoId
      || r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId
      || r.navigationEndpoint?.watchEndpoint?.videoId;

    if (!id || !title || seen.has(id)) continue;
    seen.add(id);

    const durText = getRunsText(r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs)
      || (parts.length > 1 ? parts[parts.length - 1] : '');
    const durObj = parseDuration(durText);
    const thumb = cleanThumb(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);

    tracks.push({
      id,
      videoId: id,
      title,
      artist,
      duration: durObj.durationSeconds,
      durationSeconds: durObj.durationSeconds,
      durationText: durObj.durationText || durText,
      thumbnail: thumb
    });
  }
}

async function importYtVideo(videoId, host) {
  const watchUrl = host === 'youtu.be'
    ? `https://www.youtube.com/watch?v=${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`;

  let title = '';
  let artist = 'YouTube';

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
    const resp = await fetch(oembedUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (resp.ok) {
      const info = await resp.json();
      title = String(info.title || '').trim();
      artist = String(info.author_name || 'YouTube').replace(/ - Topic$/, '').trim() || 'YouTube';
    }
  } catch {}

  if (!title) {
    // Sin oEmbed, al menos devolvemos la canción para que el cliente la resuelva por ID.
    title = 'Canción de YouTube';
  }

  return {
    source: 'youtube',
    name: title.slice(0, 60),
    tracks: [{
      id: videoId,
      videoId,
      title,
      artist,
      duration: 0,
      durationSeconds: 0,
      durationText: '',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    }]
  };
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

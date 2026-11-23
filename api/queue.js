// api/queue.js - Radio Automática / "Up Next" (SimpMusic Engine via /next)
import { fetchYt, parseDuration, cleanThumb, getRunsText, sendJson } from './_yt.js';

const normalize = (text) => String(text || '').normalize('NFD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function artistKeys(track) {
  const names = track.artists?.length ? track.artists : [track.artist];
  return names.map(normalize).filter((name) => name && name !== 'artista' && name !== 'varios artistas');
}

function songTitle(track) {
  return normalize(track.title).replace(
    /(?: (?:\d{4} )?(?:remaster(?:ed|izado|izada)?(?: version)?|official (?:video|audio)|audio oficial|video oficial|radio edit)(?: \d{4})?)+$/,
    ''
  );
}

export function rankRadioTracks(tracks, videoId) {
  const seed = tracks.find((track) => track.id === videoId);
  const seedArtists = new Set(seed ? artistKeys(seed) : []);
  const seedAlbum = normalize(seed?.album);
  const byTitle = new Map();
  const seen = new Set();
  const ordered = tracks.filter((track) => track.id !== videoId).map((track, index) => {
    const artists = artistKeys(track);
    // La radio ya aporta la relación musical. Un álbum o artista compartido
    // mejora posiciones cercanas sin desplazar el resto de la selección.
    const affinity = (artists.some((artist) => seedArtists.has(artist)) ? 5 : 0)
      + (seedAlbum && normalize(track.album) === seedAlbum ? 4 : 0);
    return { track, artists, score: affinity - index };
  }).sort((a, b) => b.score - a.score);

  const ranked = seed ? [seed] : [];
  if (seed) {
    seen.add(seed.id);
    byTitle.set(songTitle(seed), seedArtists);
  }
  for (const { track, artists } of ordered) {
    const title = songTitle(track);
    const credits = byTitle.get(title) || new Set();
    if (seen.has(track.id) || (title && artists.some((artist) => credits.has(artist)))) continue;
    seen.add(track.id);
    artists.forEach((artist) => credits.add(artist));
    if (title) byTitle.set(title, credits);
    ranked.push(track);
  }
  return ranked;
}

export async function getRadioTracks(videoId, continuation = null, options) {
  const body = continuation
    ? { continuation }
    : {
        playlistId: `RDAMVM${videoId}`,
        params: 'wAEB',
        isAudioOnly: true,
        tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
        enablePersistentPlaylistPanel: true
      };

  const data = await fetchYt('next', body, options);
  const panel = data.continuationContents?.playlistPanelContinuation ||
    data.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer;
  const tracks = [];

  for (const item of panel?.contents || []) {
    const v = item.playlistPanelVideoRenderer;
    if (!v?.videoId) continue;
    const byline = v.longBylineText?.runs?.length ? v.longBylineText.runs : (v.shortBylineText?.runs || []);
    const artists = [];
    let album = '';
    for (const { text, navigationEndpoint } of byline) {
      const browse = navigationEndpoint?.browseEndpoint;
      if (!text || !browse) continue;
      const type = browse.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
      if (type === 'MUSIC_PAGE_TYPE_ARTIST' || browse.browseId?.startsWith('UC')) artists.push(text);
      if (type === 'MUSIC_PAGE_TYPE_ALBUM' || browse.browseId?.startsWith('MPREb_')) album = text;
    }
    const artist = artists[0] || byline[0]?.text || 'Artista';
    const durText = getRunsText(v.lengthText?.runs);
    const parsedDur = parseDuration(durText);
    tracks.push({
      id: v.videoId,
      videoId: v.videoId,
      title: getRunsText(v.title?.runs) || 'Sin título',
      artist,
      artists: artists.length ? artists : [artist],
      album,
      duration: parsedDur.durationSeconds,
      durationSeconds: parsedDur.durationSeconds,
      durationText: durText || parsedDur.durationText,
      thumbnail: cleanThumb(v.thumbnail?.thumbnails, `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`)
    });
  }

  return {
    tracks: rankRadioTracks(tracks, videoId),
    continuation: panel?.continuations?.[0]?.nextContinuationData?.continuation || null
  };
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const videoId = (req.query && (req.query.id || req.query.videoId)) || urlObj.searchParams.get('id') || urlObj.searchParams.get('videoId');
  const continuation = (req.query && req.query.continuation) || urlObj.searchParams.get('continuation');

  if (!videoId && !continuation) {
    return sendJson(res, { error: 'Falta ID de la pista (videoId) o token de continuación', tracks: [] }, 400);
  }

  try {
    return sendJson(res, await getRadioTracks(videoId, continuation));
  } catch (err) {
    return sendJson(res, { error: err.message, tracks: [] }, 500);
  }
}

// api/playlist.js - Detalle de Playlist y lista de canciones (SimpMusic Engine via /browse)
import { fetchYt, parseDuration, cleanThumb, getRunsText, sendJson } from './_yt.js';

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  let browseId = (req.query && (req.query.id || req.query.browseId)) || urlObj.searchParams.get('id') || urlObj.searchParams.get('browseId');
  const continuation = (req.query && req.query.continuation) || urlObj.searchParams.get('continuation');

  if (!browseId && !continuation) {
    return sendJson(res, { error: 'Falta browseId de la playlist o continuation token' }, 400);
  }

  // Si no empieza con VL pero empieza con PL o RD, añadir prefijo VL
  if (browseId && !browseId.startsWith('VL') && (browseId.startsWith('PL') || browseId.startsWith('RD') || browseId.startsWith('MP'))) {
    browseId = 'VL' + browseId;
  }

  try {
    const body = continuation ? { continuation } : { browseId };
    const data = await fetchYt('browse', body);

    if (continuation) {
      const shelfCont = data.continuationContents?.musicPlaylistShelfContinuation || data.continuationContents?.musicShelfContinuation;
      const rawTracks = shelfCont?.contents || [];
      const nextToken = shelfCont?.continuations?.[0]?.nextContinuationData?.continuation || null;
      const tracks = parsePlaylistTracks(rawTracks);
      return sendJson(res, { tracks, continuation: nextToken });
    }

    // Cabecera
    const headerSec = data.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0];
    const header = headerSec?.musicResponsiveHeaderRenderer || data.header?.musicDetailHeaderRenderer || data.header?.musicResponsiveHeaderRenderer;

    const title = getRunsText(header?.title?.runs) || 'Playlist';
    const author = getRunsText(header?.straplineTextOne?.runs) || getRunsText(header?.subtitle?.runs) || 'YouTube Music';
    const thumb = cleanThumb(header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || header?.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails);

    // Canciones
    const secondarySec = data.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents?.[0];
    const shelf = secondarySec?.musicPlaylistShelfRenderer || secondarySec?.musicShelfRenderer;
    const rawTracks = shelf?.contents || [];
    const nextToken = shelf?.continuations?.[0]?.nextContinuationData?.continuation || null;

    const tracks = parsePlaylistTracks(rawTracks);

    return sendJson(res, {
      playlist: {
        id: browseId,
        browseId: browseId,
        title,
        author,
        thumbnail: thumb,
        trackCount: tracks.length
      },
      tracks,
      continuation: nextToken
    });
  } catch (err) {
    return sendJson(res, { error: err.message, playlist: null, tracks: [] }, 500);
  }
}

function parsePlaylistTracks(rawList) {
  const tracks = [];
  let idx = 1;

  for (const item of rawList) {
    const r = item.musicResponsiveListItemRenderer;
    if (!r) continue;

    const col0 = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const col1 = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const trackTitle = getRunsText(col0);
    const subText = getRunsText(col1);
    const parts = subText.split('•').map(p => p.trim());
    const artist = parts[0] || 'Artista';

    const videoId = col0[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
                    r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
                    r.navigationEndpoint?.watchEndpoint?.videoId;

    if (!videoId) continue;

    const durText = getRunsText(r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs) || (parts[parts.length - 1] || '');
    const durObj = parseDuration(durText);
    const thumb = cleanThumb(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails, `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);

    tracks.push({
      id: videoId,
      videoId: videoId,
      index: idx++,
      title: trackTitle,
      artist,
      duration: durObj.durationSeconds,
      durationSeconds: durObj.durationSeconds,
      durationText: durObj.durationText || durText,
      thumbnail: thumb
    });
  }

  return tracks;
}

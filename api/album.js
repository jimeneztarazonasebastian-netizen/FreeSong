// api/album.js - Detalle completo de Álbum y lista de canciones (SimpMusic Engine via /browse)
import { fetchYt, parseDuration, cleanThumb, getRunsText, sendJson } from './_yt.js';

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const browseId = (req.query && (req.query.id || req.query.browseId)) || urlObj.searchParams.get('id') || urlObj.searchParams.get('browseId');

  if (!browseId) {
    return sendJson(res, { error: 'Falta browseId del álbum' }, 400);
  }

  try {
    const data = await fetchYt('browse', { browseId });

    // Cabecera del Álbum
    const headerSec = data.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0];
    const header = headerSec?.musicResponsiveHeaderRenderer;

    const title = getRunsText(header?.title?.runs) || 'Álbum';
    const artist = getRunsText(header?.straplineTextOne?.runs) || 'Artista';
    const artistId = header?.straplineTextOne?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null;
    const subtitleText = getRunsText(header?.subtitle?.runs);
    const subParts = subtitleText.split('•').map(p => p.trim());
    const year = subParts[subParts.length - 1] || '';
    const thumb = cleanThumb(header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails);

    // Lista de Canciones del Álbum
    const secondarySec = data.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents?.[0];
    const shelf = secondarySec?.musicShelfRenderer;
    const rawTracks = shelf?.contents || [];

    const tracks = [];
    let idx = 1;

    for (const item of rawTracks) {
      const r = item.musicResponsiveListItemRenderer;
      if (!r) continue;

      const col0 = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      const col1 = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      const trackTitle = getRunsText(col0);
      const trackArtist = getRunsText(col1) || artist;

      const videoId = col0[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
                      r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
                      r.navigationEndpoint?.watchEndpoint?.videoId;

      if (!videoId) continue;

      const durText = getRunsText(r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs);
      const durObj = parseDuration(durText);

      tracks.push({
        id: videoId,
        videoId: videoId,
        index: idx++,
        title: trackTitle,
        artist: trackArtist,
        album: title,
        duration: durObj.durationSeconds,
        durationSeconds: durObj.durationSeconds,
        durationText: durText || durObj.durationText,
        thumbnail: thumb || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      });
    }

    return sendJson(res, {
      album: {
        id: browseId,
        browseId: browseId,
        title,
        artist,
        artistId,
        year,
        thumbnail: thumb,
        trackCount: tracks.length
      },
      tracks
    });
  } catch (err) {
    return sendJson(res, { error: err.message, album: null, tracks: [] }, 500);
  }
}

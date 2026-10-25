// api/artist.js - Perfil completo de Artista (SimpMusic Engine via /browse)
import { fetchYt, SEARCH_FILTERS, parseDuration, cleanThumb, getRunsText, sendJson } from './_yt.js';

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  let browseId = (req.query && (req.query.id || req.query.browseId)) || urlObj.searchParams.get('id') || urlObj.searchParams.get('browseId');
  const name = (req.query && req.query.name) || urlObj.searchParams.get('name');

  try {
    // Si no tenemos browseId o no comienza con UC, buscar el artista para resolver su browseId
    if (!browseId || !browseId.startsWith('UC')) {
      const query = name || browseId;
      if (!query) {
        return sendJson(res, { error: 'Falta ID de artista o nombre' }, 400);
      }

      const searchRes = await fetchYt('search', {
        query,
        params: SEARCH_FILTERS.artists
      });
      const shelf = searchRes.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.slice(-1)[0]?.musicShelfRenderer;
      const firstArtist = shelf?.contents?.[0]?.musicResponsiveListItemRenderer;
      browseId = firstArtist?.navigationEndpoint?.browseEndpoint?.browseId ||
                 firstArtist?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId;

      if (!browseId) {
        return sendJson(res, { error: `No se encontró el artista ${query}` }, 404);
      }
    }

    const data = await fetchYt('browse', { browseId });

    // Header del Artista
    const header = data.header?.musicImmersiveHeaderRenderer || data.header?.musicVisualHeaderRenderer;
    const artistName = getRunsText(header?.title?.runs) || 'Artista';
    const description = getRunsText(header?.description?.runs);
    const subscribers = header?.subscriptionButton?.subscribeButtonRenderer?.longSubscriberCountText?.runs?.[0]?.text || '';
    const thumb = cleanThumb(
      header?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
      header?.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
    );

    // Secciones (Top Canciones, Álbumes, Singles, Videos, Relacionados)
    const sections = data.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    const topSongs = [];
    const albums = [];
    const singles = [];
    const similar = [];

    for (const sec of sections) {
      const shelf = sec.musicShelfRenderer || sec.musicCarouselShelfRenderer;
      if (!shelf) continue;

      const title = (
        shelf.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text ||
        shelf.title?.runs?.[0]?.text ||
        ''
      ).toLowerCase();

      const contents = shelf.contents || [];

      // Canciones Populares / Top Songs
      if (title.includes('canción') || title.includes('canciones') || title.includes('popular') || title.includes('song')) {
        for (const item of contents) {
          const r = item.musicResponsiveListItemRenderer;
          if (!r) continue;
          const col0 = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const col1 = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const sTitle = getRunsText(col0);
          const videoId = col0[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
                          r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
          if (!videoId) continue;

          const sThumb = cleanThumb(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails, `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
          const subText = getRunsText(col1);
          const parts = subText.split('•').map(p => p.trim());
          const durObj = parseDuration(parts[parts.length - 1]);

          topSongs.push({
            id: videoId,
            videoId: videoId,
            title: sTitle,
            artist: artistName,
            duration: durObj.durationSeconds,
            durationText: durObj.durationText,
            thumbnail: sThumb
          });
        }
      }
      // Álbumes
      else if (title.includes('álbum') || title.includes('album')) {
        for (const item of contents) {
          const r = item.musicTwoRowItemRenderer;
          if (!r) continue;
          const aTitle = getRunsText(r.title?.runs);
          const aId = r.navigationEndpoint?.browseEndpoint?.browseId;
          const aYear = getRunsText(r.subtitle?.runs);
          const aThumb = cleanThumb(r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails);
          if (aId) {
            albums.push({
              id: aId,
              browseId: aId,
              title: aTitle,
              year: aYear,
              thumbnail: aThumb
            });
          }
        }
      }
      // Singles y EPs
      else if (title.includes('single') || title.includes('sencillo') || title.includes('ep')) {
        for (const item of contents) {
          const r = item.musicTwoRowItemRenderer;
          if (!r) continue;
          const sTitle = getRunsText(r.title?.runs);
          const sId = r.navigationEndpoint?.browseEndpoint?.browseId;
          const sYear = getRunsText(r.subtitle?.runs);
          const sThumb = cleanThumb(r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails);
          if (sId) {
            singles.push({
              id: sId,
              browseId: sId,
              title: sTitle,
              year: sYear,
              thumbnail: sThumb
            });
          }
        }
      }
      // Artistas Similares / "Fans también escuchan"
      else if (title.includes('guste') || title.includes('similar') || title.includes('fans') || title.includes('relacionado')) {
        for (const item of contents) {
          const r = item.musicTwoRowItemRenderer;
          if (!r) continue;
          const simName = getRunsText(r.title?.runs);
          const simId = r.navigationEndpoint?.browseEndpoint?.browseId;
          const simSubs = getRunsText(r.subtitle?.runs);
          const simThumb = cleanThumb(r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails);
          if (simId) {
            similar.push({
              id: simId,
              browseId: simId,
              name: simName,
              subscribers: simSubs,
              thumbnail: simThumb
            });
          }
        }
      }
    }

    return sendJson(res, {
      artist: {
        id: browseId,
        browseId: browseId,
        name: artistName,
        title: artistName,
        description,
        subscribers,
        thumbnail: thumb
      },
      topSongs,
      tracks: topSongs,
      albums,
      singles,
      similar
    });
  } catch (err) {
    return sendJson(res, { error: err.message, topSongs: [], tracks: [], albums: [], singles: [], similar: [] }, 500);
  }
}

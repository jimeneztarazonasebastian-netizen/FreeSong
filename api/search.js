// api/search.js - Búsqueda multicategoría estilo SimpMusic con filtros y paginación
import { fetchYt, SEARCH_FILTERS, parseDuration, cleanThumb, getRunsText, sendJson } from './_yt.js';

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const query = (req.query && req.query.q) || urlObj.searchParams.get('q');
  const type = ((req.query && req.query.type) || urlObj.searchParams.get('type') || 'songs').toLowerCase();
  const continuation = (req.query && req.query.continuation) || urlObj.searchParams.get('continuation');

  if (!query && !continuation) {
    return sendJson(res, { error: 'Falta término de búsqueda o continuation token', tracks: [], items: [] }, 400);
  }

  try {
    const body = continuation
      ? { continuation }
      : {
          query,
          params: SEARCH_FILTERS[type] || SEARCH_FILTERS.songs
        };

    const data = await fetchYt('search', body);

    // Si es continuación
    if (continuation) {
      const shelfCont = data.continuationContents?.musicShelfContinuation;
      const rawItems = shelfCont?.contents || [];
      const nextToken = shelfCont?.continuations?.[0]?.nextContinuationData?.continuation || null;
      const items = parseShelfItems(rawItems, type);
      return sendJson(res, {
        items,
        tracks: items.filter(it => it.type === 'song' || it.type === 'video'),
        continuation: nextToken
      });
    }

    // Búsqueda normal
    const tabs = data.contents?.tabbedSearchResultsRenderer?.tabs || [];
    const secList = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    // Si es tipo 'all' (resumen de todas las categorías)
    if (type === 'all' || type === 'summary') {
      const parsedSummary = parseSearchSummary(secList);
      return sendJson(res, parsedSummary);
    }

    // Si es un filtro específico (songs, artists, albums, playlists, videos)
    const lastSec = secList[secList.length - 1] || {};
    const shelf = lastSec.musicShelfRenderer || lastSec.itemSectionRenderer || {};
    const rawItems = shelf.contents || [];
    const nextToken = shelf.continuations?.[0]?.nextContinuationData?.continuation || null;

    const items = parseShelfItems(rawItems, type);

    const result = {
      type,
      items,
      continuation: nextToken
    };

    // Compatibilidad retroactiva directa para el reproductor existente
    if (type === 'songs' || type === 'videos') {
      result.tracks = items;
    } else if (type === 'artists') {
      result.artists = items;
    } else if (type === 'albums') {
      result.albums = items;
    } else if (type === 'playlists') {
      result.playlists = items;
    }

    return sendJson(res, result);
  } catch (err) {
    return sendJson(res, { error: err.message, items: [], tracks: [] }, 500);
  }
}

function parseShelfItems(rawList, expectedType) {
  const items = [];
  const seen = new Set();

  for (const item of rawList) {
    const r = item.musicResponsiveListItemRenderer;
    if (!r) continue;

    const col0 = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const col1 = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const title = getRunsText(col0);
    const subRuns = col1;

    // Detectar si es canción/video por videoId
    const videoId = col0[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
                    r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
                    r.navigationEndpoint?.watchEndpoint?.videoId;

    // BrowseId (para artistas, álbumes, playlists)
    const browseId = col0[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
                     r.navigationEndpoint?.browseEndpoint?.browseId;

    const thumb = cleanThumb(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails, videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '');

    // Desglose de subtítulo
    const subText = getRunsText(subRuns);
    const parts = subText.split('•').map(p => p.trim());

    if (expectedType === 'artists' || (browseId && browseId.startsWith('UC'))) {
      if (!browseId || seen.has(browseId)) continue;
      seen.add(browseId);
      items.push({
        type: 'artist',
        id: browseId,
        browseId: browseId,
        name: title,
        title: title,
        subscribers: parts[parts.length - 1] || '',
        thumbnail: thumb
      });
    } else if (expectedType === 'albums' || (browseId && browseId.startsWith('MPREb_'))) {
      if (!browseId || seen.has(browseId)) continue;
      seen.add(browseId);
      const artist = parts[0] || 'Varios Artistas';
      const year = parts[parts.length - 1] || '';
      items.push({
        type: 'album',
        id: browseId,
        browseId: browseId,
        title: title,
        artist: artist,
        year: year,
        thumbnail: thumb
      });
    } else if (expectedType === 'playlists' || (browseId && (browseId.startsWith('VL') || browseId.startsWith('PL')))) {
      if (!browseId || seen.has(browseId)) continue;
      seen.add(browseId);
      const author = parts[0] || 'YouTube Music';
      const trackCount = parts[parts.length - 1] || '';
      items.push({
        type: 'playlist',
        id: browseId,
        browseId: browseId,
        title: title,
        author: author,
        trackCount: trackCount,
        thumbnail: thumb
      });
    } else if (videoId) {
      if (seen.has(videoId)) continue;
      seen.add(videoId);

      let artist = 'Artista';
      let album = '';
      let durText = '';
      let durSec = 0;

      if (parts.length >= 1) {
        artist = parts[0];
        if (parts.length >= 3) {
          album = parts[1];
        }
        const lastPart = parts[parts.length - 1];
        const parsed = parseDuration(lastPart);
        durText = parsed.durationText;
        durSec = parsed.durationSeconds;
      }

      // Si dura más de 20 minutos probablemente sea un DJ mix o compilación completa no deseada como canción suelta
      if (durSec > 1200) continue;

      items.push({
        type: 'song',
        id: videoId,
        videoId: videoId,
        title: title,
        artist: artist,
        album: album,
        duration: durSec,
        durationSeconds: durSec,
        durationText: durText,
        thumbnail: thumb
      });
    }
  }

  return items;
}

function parseSearchSummary(secList) {
  const songs = [];
  const artists = [];
  const albums = [];
  const playlists = [];
  let topResult = null;

  for (const sec of secList) {
    const shelf = sec.musicShelfRenderer || sec.musicCardShelfRenderer || {};
    const title = shelf.title?.runs?.[0]?.text?.toLowerCase() || '';

    // Si es card shelf (Top result)
    if (sec.musicCardShelfRenderer) {
      const card = sec.musicCardShelfRenderer;
      const cardTitle = card.title?.runs?.[0]?.text || '';
      const sub = getRunsText(card.subtitle?.runs);
      const cardVideoId = card.onTap?.watchEndpoint?.videoId;
      const cardBrowseId = card.onTap?.browseEndpoint?.browseId || card.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId;
      const thumb = cleanThumb(card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails);

      topResult = {
        title: cardTitle,
        subtitle: sub,
        videoId: cardVideoId,
        browseId: cardBrowseId,
        thumbnail: thumb,
        type: cardVideoId ? 'song' : (cardBrowseId?.startsWith('UC') ? 'artist' : 'album')
      };
      continue;
    }

    const items = parseShelfItems(shelf.contents || [], '');
    if (title.includes('canción') || title.includes('song')) {
      songs.push(...items);
    } else if (title.includes('artista') || title.includes('artist')) {
      artists.push(...items);
    } else if (title.includes('álbum') || title.includes('album')) {
      albums.push(...items);
    } else if (title.includes('lista') || title.includes('playlist')) {
      playlists.push(...items);
    } else {
      // Repartir según tipo detectado
      for (const it of items) {
        if (it.type === 'song') songs.push(it);
        else if (it.type === 'artist') artists.push(it);
        else if (it.type === 'album') albums.push(it);
        else if (it.type === 'playlist') playlists.push(it);
      }
    }
  }

  return {
    topResult,
    songs,
    artists,
    albums,
    playlists,
    tracks: songs
  };
}

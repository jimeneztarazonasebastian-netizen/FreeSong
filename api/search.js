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

    // La búsqueda alternativa (sin palabras vacías) arranca YA, en paralelo con
    // la original: si hace falta usarla, la respuesta no espera dos viajes.
    const isTrackType = type === 'songs' || type === 'videos';
    const altPlan = !continuation && isTrackType ? alternateSearchQuery(query) : null;
    const altPromise = altPlan ? startAlternateSearch(altPlan, type) : null;

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
    const lastShelf = lastSec.musicShelfRenderer || lastSec.itemSectionRenderer || {};
    let rawItems = lastShelf.contents || [];
    let nextToken = lastShelf.continuations?.[0]?.nextContinuationData?.continuation || null;

    // En canciones/vídeos YouTube a veces coloca la pista de audio (ATV) en una
    // sección distinta a la del vídeo oficial. Recorremos todas las secciones
    // para no perder esa copia, que suele reproducirse mejor.
    if (isTrackType) {
      const collected = [];
      for (const sec of secList) {
        const s = sec.musicShelfRenderer || sec.itemSectionRenderer;
        if (!s || !Array.isArray(s.contents)) continue;
        collected.push(...s.contents);
        const cont = s.continuations?.[0]?.nextContinuationData?.continuation;
        if (cont) nextToken = cont;
      }
      if (collected.length) rawItems = collected;
    }

    let items = parseShelfItems(rawItems, type);

    // YouTube Music falla con conectores ("candy de plan b", "la cancion de...")
    // y devuelve resultados de otra canción. Si los resultados no cubren todas
    // las palabras importantes, se usa la búsqueda alternativa ya lanzada.
    if (isTrackType) {
      const improved = await improveTrackSearch(altPlan, altPromise, type, items, nextToken);
      items = improved.items;
      nextToken = improved.nextToken;
    }

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

// Palabras de relleno que YouTube Music interpreta mal dentro de una búsqueda.
const SEARCH_STOP_WORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas',
  'y', 'e', 'o', 'u', 'con', 'sin', 'para', 'por', 'en', 'al', 'a', 'que',
  'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'es', 'son', 'the', 'of', 'and',
  'ft', 'feat', 'featuring', 'cancion', 'canciones', 'song', 'songs',
  'musica', 'music', 'video', 'busca', 'buscar', 'busco', 'pon', 'ponme',
  'reproduce', 'quiero', 'escuchar', 'algo', 'tema'
]);

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function significantSearchTokens(query) {
  return normalizeSearchText(query)
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .split(/\s+/)
    .filter((token) => token && !SEARCH_STOP_WORDS.has(token));
}

// Cuántas palabras importantes de la consulta aparecen en el mejor resultado.
// Solo se miran los primeros puestos: si la coincidencia buena está en el
// puesto 12, el usuario seguirá viendo primero la canción equivocada.
const SEARCH_COVERAGE_WINDOW = 5;

function tokenMatches(words, haystack, token) {
  if (words.has(token)) return true;
  // Evita falsos positivos con palabras cortas ("b" dentro de "Pitbull").
  return token.length >= 4 && haystack.includes(token);
}

function searchCoverage(items, tokens, limit = SEARCH_COVERAGE_WINDOW) {
  if (!Array.isArray(items) || !items.length || !tokens.length) return 0;
  let best = 0;
  for (const item of items.slice(0, limit)) {
    const haystack = normalizeSearchText(`${item.title || item.name || ''} ${item.artist || ''} ${item.album || ''} ${item.author || ''}`);
    const words = new Set(haystack.replace(/[^\p{L}\p{N}']+/gu, ' ').split(/\s+/).filter(Boolean));
    let hits = 0;
    for (const token of tokens) {
      if (tokenMatches(words, haystack, token)) hits++;
    }
    if (hits > best) best = hits;
    if (best === tokens.length) break;
  }
  return best;
}

function searchShelfFrom(data) {
  const secList = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  const lastSec = secList[secList.length - 1] || {};
  const shelf = lastSec.musicShelfRenderer || lastSec.itemSectionRenderer || {};
  return {
    rawItems: shelf.contents || [],
    nextToken: shelf.continuations?.[0]?.nextContinuationData?.continuation || null
  };
}

// Consulta alternativa sin palabras vacías, o null si no hace falta.
function alternateSearchQuery(query) {
  const tokens = significantSearchTokens(query);
  if (tokens.length < 2) return null;
  const normalized = tokens.join(' ');
  if (normalizeSearchText(normalized) === normalizeSearchText(query)) return null;
  return { tokens, query: normalized };
}

function startAlternateSearch(plan, type) {
  return fetchYt('search', {
    query: plan.query,
    params: SEARCH_FILTERS[type] || SEARCH_FILTERS.songs
  }, { timeoutMs: 6000, retries: 0 })
    .then(searchShelfFrom)
    .catch(() => null);
}

// Si los resultados originales no cubren todas las palabras importantes de la
// consulta, usa la búsqueda alternativa cuando cubre más.
async function improveTrackSearch(plan, altPromise, type, items, nextToken) {
  if (!plan) return { items, nextToken };
  const originalCoverage = searchCoverage(items, plan.tokens);
  if (originalCoverage >= plan.tokens.length) return { items, nextToken };

  let alt = null;
  try { alt = await altPromise; } catch {}
  if (!alt) return { items, nextToken };

  const altItems = parseShelfItems(alt.rawItems, type);
  if (altItems.length && searchCoverage(altItems, plan.tokens) > originalCoverage) {
    return { items: altItems, nextToken: alt.nextToken };
  }
  return { items, nextToken };
}

function parseShelfItems(rawList, expectedType) {
  const items = [];
  const seen = new Set();
  const seenSongs = new Map();

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

      // YouTube Music devuelve a veces la misma grabación subida dos veces
      // (mismo título, artista y duración). Mostrarla una sola vez evita que el
      // usuario elija justo la copia que falla en su red. Si una es la pista de
      // audio oficial (ATV) y la otra un vídeo, nos quedamos con la de audio:
      // suele reproducirse de forma más fiable y rápida.
      const songKey = `${normalizeSearchText(title)}|${normalizeSearchText(artist)}|${durSec ? Math.round(durSec / 2) : 0}`;
      const hasVariant = /\b(remix|cover|live|en vivo|sped up|slowed|instrumental|karaoke)\b/i.test(title);
      const isAtv = col0[0]?.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV';

      const songItem = {
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
      };

      if (!hasVariant) {
        const previous = seenSongs.get(songKey);
        if (previous) {
          if (isAtv && !previous.isAtv) {
            items[previous.index] = songItem;
            previous.isAtv = true;
          }
          continue;
        }
        seenSongs.set(songKey, { index: items.length, isAtv });
      }

      items.push(songItem);
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

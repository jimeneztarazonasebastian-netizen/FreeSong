// api/explore.js - Explorar novedades, géneros, estados de ánimo y listas (SimpMusic Engine)
import { fetchYt, cleanThumb, getRunsText, sendJson } from './_yt.js';

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const type = ((req.query && req.query.type) || urlObj.searchParams.get('type') || 'all').toLowerCase();

  try {
    if (type === 'moods' || type === 'genres') {
      const moods = await fetchMoodsAndGenres();
      return sendJson(res, { moods });
    }

    if (type === 'new_releases' || type === 'releases') {
      const releases = await fetchNewReleases();
      return sendJson(res, { releases });
    }

    if (type === 'charts') {
      const charts = await fetchCharts();
      return sendJson(res, { charts });
    }

    // Por defecto: Cargar géneros y novedades
    const [moods, releases] = await Promise.all([
      fetchMoodsAndGenres().catch(() => []),
      fetchNewReleases().catch(() => [])
    ]);

    return sendJson(res, { moods, releases });
  } catch (err) {
    return sendJson(res, { error: err.message, moods: [], releases: [] }, 500);
  }
}

async function fetchMoodsAndGenres() {
  const data = await fetchYt('browse', { browseId: 'FEmusic_moods_and_genres' });
  const sections = data.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

  const categories = [];

  for (const s of sections) {
    const grid = s.gridRenderer;
    if (!grid) continue;

    const catTitle = getRunsText(grid.header?.gridHeaderRenderer?.title?.runs) || 'Categoría';
    const items = [];

    for (const it of grid.items || []) {
      const btn = it.musicNavigationButtonRenderer;
      if (!btn) continue;

      const title = getRunsText(btn.buttonText?.runs);
      const stripeColor = btn.solid?.leftStripeColor || null;
      const endpoint = btn.clickCommand?.browseEndpoint;
      const browseId = endpoint?.browseId;
      const params = endpoint?.params;

      if (title) {
        items.push({
          title,
          stripeColor: stripeColor ? `#${(stripeColor & 0xFFFFFF).toString(16).padStart(6, '0')}` : null,
          browseId: browseId || null,
          params: params || null
        });
      }
    }

    if (items.length > 0) {
      categories.push({
        title: catTitle,
        items
      });
    }
  }

  return categories;
}

async function fetchNewReleases() {
  const data = await fetchYt('browse', { browseId: 'FEmusic_new_releases' });
  const sections = data.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

  const releases = [];

  for (const s of sections) {
    const shelf = s.musicCarouselShelfRenderer;
    if (!shelf) continue;

    for (const it of shelf.contents || []) {
      const r = it.musicTwoRowItemRenderer;
      if (!r) continue;

      const title = getRunsText(r.title?.runs);
      const sub = getRunsText(r.subtitle?.runs);
      const browseId = r.navigationEndpoint?.browseEndpoint?.browseId;
      const thumb = cleanThumb(r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails);

      if (title && browseId) {
        releases.push({
          id: browseId,
          browseId,
          title,
          subtitle: sub,
          thumbnail: thumb
        });
      }
    }
  }

  return releases;
}

async function fetchCharts() {
  const data = await fetchYt('browse', { browseId: 'FEmusic_charts' });
  const sections = data.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

  const charts = [];

  for (const s of sections) {
    const shelf = s.musicCarouselShelfRenderer;
    if (!shelf) continue;

    const title = getRunsText(shelf.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs) || 'Tendencias';
    const items = [];

    for (const it of shelf.contents || []) {
      const r = it.musicTwoRowItemRenderer || it.musicResponsiveListItemRenderer;
      if (!r) continue;

      const itemTitle = getRunsText(r.title?.runs);
      const sub = getRunsText(r.subtitle?.runs);
      const videoId = r.navigationEndpoint?.watchEndpoint?.videoId;
      const browseId = r.navigationEndpoint?.browseEndpoint?.browseId;
      const thumb = cleanThumb(
        r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
        r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
      );

      items.push({
        title: itemTitle,
        subtitle: sub,
        videoId: videoId || null,
        browseId: browseId || null,
        thumbnail: thumb
      });
    }

    if (items.length > 0) {
      charts.push({
        title,
        items
      });
    }
  }

  return charts;
}

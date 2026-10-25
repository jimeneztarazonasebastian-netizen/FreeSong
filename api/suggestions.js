// api/suggestions.js - Sugerencias de búsqueda instantáneas (SimpMusic Engine)
import { fetchYt, cleanThumb, sendJson } from './_yt.js';

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const query = (req.query && req.query.q) || urlObj.searchParams.get('q');

  if (!query || !query.trim()) {
    return sendJson(res, { queries: [], recommended: [] });
  }

  try {
    const data = await fetchYt('music/get_search_suggestions', {
      input: query.trim()
    });

    const sec0 = data.contents?.[0]?.searchSuggestionsSectionRenderer?.contents || [];
    const sec1 = data.contents?.[1]?.searchSuggestionsSectionRenderer?.contents || [];

    const queries = sec0.map(item => {
      const runs = item.searchSuggestionRenderer?.suggestion?.runs || [];
      return runs.map(r => r.text || '').join('');
    }).filter(Boolean);

    const recommended = sec1.map(item => {
      const r = item.musicResponsiveListItemRenderer;
      if (!r) return null;
      const title = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
      const sub = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(x => x.text).join('') || '';
      const videoId = r.navigationEndpoint?.watchEndpoint?.videoId;
      const browseId = r.navigationEndpoint?.browseEndpoint?.browseId;
      const thumb = cleanThumb(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails);

      return {
        title,
        subtitle: sub,
        videoId: videoId || null,
        browseId: browseId || null,
        thumbnail: thumb
      };
    }).filter(Boolean);

    return sendJson(res, { queries, recommended });
  } catch (err) {
    return sendJson(res, { queries: [], recommended: [], error: err.message }, 500);
  }
}

// api/search.js - Búsqueda rápida en YouTube Music
export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const query = (req.query && req.query.q) || urlObj.searchParams.get('q');

  if (!query) {
    const err = JSON.stringify({ error: 'Falta término de búsqueda' });
    if (res && res.status) return res.status(400).send(err);
    return new Response(err, { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const ytRes = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://music.youtube.com',
        'Referer': 'https://music.youtube.com/'
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20240101.01.00',
            gl: 'US',
            hl: 'es'
          }
        },
        query: query
      })
    });

    const data = await ytRes.json();
    const secList = data.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    const tracks = [];
    const seen = new Set();

    for (const s of secList) {
      // Top card
      if (s.musicCardShelfRenderer) {
        const card = s.musicCardShelfRenderer;
        const videoId = card.onTap?.watchEndpoint?.videoId;
        const title = card.title?.runs?.[0]?.text;
        const sub = card.subtitle?.runs || [];
        const artist = sub.map(x => x.text).join('').replace(/^[^\w\s]+/, '').trim();
        const thumb = card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url;
        if (videoId && title && !seen.has(videoId)) {
          seen.add(videoId);
          tracks.push({
            id: videoId,
            title: title,
            artist: artist || 'Artista',
            thumbnail: thumb || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
          });
        }
      }

      // Shelf / itemSection items
      const list = s.musicShelfRenderer?.contents || s.itemSectionRenderer?.contents || [];
      for (const item of list) {
        const r = item.musicResponsiveListItemRenderer;
        if (!r) continue;
        const titleRun = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0];
        const title = titleRun?.text;
        const videoId = titleRun?.navigationEndpoint?.watchEndpoint?.videoId ||
                        r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
        
        if (!videoId || !title || seen.has(videoId)) continue;

        const subRuns = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        const fullSub = subRuns.map(x => x.text).join('');
        // e.g. "Canción • Coldplay" or "Vídeo • Coldplay • 700 M"
        const parts = fullSub.split('•').map(p => p.trim());
        let artist = 'Artista';
        if (parts.length > 1) {
          artist = parts[1];
        } else if (parts.length === 1 && !parts[0].includes('Canción') && !parts[0].includes('Vídeo')) {
          artist = parts[0];
        }

        const thumb = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url;

        seen.add(videoId);
        tracks.push({
          id: videoId,
          title: title,
          artist: artist,
          thumbnail: thumb || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        });
      }
    }

    const payload = JSON.stringify({ tracks });
    if (res && res.setHeader) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).send(payload);
    }
    return new Response(payload, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=1800, stale-while-revalidate'
      }
    });
  } catch (err) {
    const errPayload = JSON.stringify({ error: err.message, tracks: [] });
    if (res && res.status) return res.status(500).send(errPayload);
    return new Response(errPayload, { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

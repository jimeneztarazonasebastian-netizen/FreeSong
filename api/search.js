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
        query: query,
        params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D' // Filtro estricto exclusivo de canciones ("Songs")
      })
    });

    const data = await ytRes.json();
    const secList = data.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    const tracks = [];
    const seen = new Set();

    for (const s of secList) {
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
        const parts = fullSub.split('•').map(p => p.trim());
        let artist = 'Artista';
        let durationText = '';
        let durationSeconds = 0;

        if (parts.length >= 1) {
          artist = parts[0];
          const lastPart = parts[parts.length - 1];
          const durMatch = lastPart.match(/(?:(\d+):)?(\d+):(\d{2})$/);
          if (durMatch) {
            durationText = durMatch[0];
            const hrs = durMatch[1] ? parseInt(durMatch[1], 10) : 0;
            const mins = parseInt(durMatch[2], 10);
            const secs = parseInt(durMatch[3], 10);
            durationSeconds = hrs * 3600 + mins * 60 + secs;
          }
        }

        // Descartar mixes, compilaciones o videos largos > 420 segundos (7 min)
        if (durationSeconds > 420) continue;

        const thumb = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url;

        seen.add(videoId);
        tracks.push({
          id: videoId,
          title: title,
          artist: artist,
          duration: durationSeconds,
          durationSeconds: durationSeconds,
          durationText: durationText,
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

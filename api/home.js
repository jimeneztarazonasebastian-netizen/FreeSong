// api/home.js - Pantalla de inicio de YouTube Music
export default async function handler(req, res) {
  try {
    const ytRes = await fetch('https://music.youtube.com/youtubei/v1/browse?prettyPrint=false', {
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
        browseId: 'FEmusic_home'
      })
    });

    const data = await ytRes.json();
    const sections = data.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    const shelves = [];

    for (const s of sections) {
      const carousel = s.musicCarouselShelfRenderer;
      if (!carousel) continue;

      const title = carousel.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text || 'Destacados';
      const items = [];

      for (const item of carousel.contents || []) {
        // Two row items (album / playlist / song)
        const twoRow = item.musicTwoRowItemRenderer;
        if (twoRow) {
          const title = twoRow.title?.runs?.[0]?.text;
          const sub = twoRow.subtitle?.runs?.map(x => x.text).join('') || '';
          const videoId = twoRow.navigationEndpoint?.watchEndpoint?.videoId ||
                          twoRow.onTap?.watchEndpoint?.videoId ||
                          twoRow.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
          const thumb = twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url;

          if (videoId && title) {
            items.push({
              id: videoId,
              title: title,
              artist: sub.split('•')[0]?.trim() || 'Artista',
              thumbnail: thumb || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
            });
          }
        }

        // Responsive list items
        const resp = item.musicResponsiveListItemRenderer;
        if (resp) {
          const titleRun = resp.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0];
          const title = titleRun?.text;
          const videoId = titleRun?.navigationEndpoint?.watchEndpoint?.videoId ||
                          resp.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
          const subRuns = resp.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const artist = subRuns[0]?.text || 'Artista';
          const thumb = resp.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url;

          if (videoId && title) {
            items.push({
              id: videoId,
              title: title,
              artist: artist,
              thumbnail: thumb || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
            });
          }
        }
      }

      if (items.length > 0) {
        shelves.push({ title, items });
      }
    }

    // Si la página principal de browse no trae suficientes canciones directas, añadir hits populares
    if (shelves.length === 0 || !shelves.some(s => s.items.length >= 3)) {
      const fallbackTracks = [
        { id: 'dvgZkm1xWPE', title: 'Viva La Vida', artist: 'Coldplay', thumbnail: 'https://i.ytimg.com/vi/dvgZkm1xWPE/hqdefault.jpg' },
        { id: 'k4V3Mo61fJM', title: 'Fix You', artist: 'Coldplay', thumbnail: 'https://i.ytimg.com/vi/k4V3Mo61fJM/hqdefault.jpg' },
        { id: '1G4isv_Fylg', title: 'Paradise', artist: 'Coldplay', thumbnail: 'https://i.ytimg.com/vi/1G4isv_Fylg/hqdefault.jpg' },
        { id: 'JGwWNGJdvx8', title: 'Shape of You', artist: 'Ed Sheeran', thumbnail: 'https://i.ytimg.com/vi/JGwWNGJdvx8/hqdefault.jpg' },
        { id: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen', thumbnail: 'https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg' },
        { id: '4NRXx6U8ABQ', title: 'Blinding Lights', artist: 'The Weeknd', thumbnail: 'https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg' },
        { id: 'YQHsXMglC9A', title: 'Hello', artist: 'Adele', thumbnail: 'https://i.ytimg.com/vi/YQHsXMglC9A/hqdefault.jpg' },
        { id: 'gNi_6U5Pm_o', title: 'As It Was', artist: 'Harry Styles', thumbnail: 'https://i.ytimg.com/vi/gNi_6U5Pm_o/hqdefault.jpg' }
      ];
      shelves.unshift({ title: 'Éxitos Destacados', items: fallbackTracks });
    }

    const payload = JSON.stringify({ shelves });
    if (res && res.setHeader) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).send(payload);
    }
    return new Response(payload, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=3600, stale-while-revalidate'
      }
    });
  } catch (err) {
    const errPayload = JSON.stringify({ error: err.message, shelves: [] });
    if (res && res.status) return res.status(500).send(errPayload);
    return new Response(errPayload, { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

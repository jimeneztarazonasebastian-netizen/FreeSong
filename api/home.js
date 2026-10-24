// api/home.js - Pantalla de inicio de YouTube Music con categorías y extracción precisa de duración
export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const category = (req.query && (req.query.category || req.query.tag)) || urlObj.searchParams.get('category') || urlObj.searchParams.get('tag');

  function parseDuration(text) {
    if (!text) return null;
    const match = text.trim().match(/(?:(\d+):)?(\d+):(\d{2})$/);
    if (!match) return null;
    const hrs = match[1] ? parseInt(match[1], 10) : 0;
    const mins = parseInt(match[2], 10);
    const secs = parseInt(match[3], 10);
    return {
      durationSeconds: hrs * 3600 + mins * 60 + secs,
      durationText: match[0]
    };
  }

  // Si se solicita una categoría o chip específico, buscar pistas curadas de esa categoría con el filtro estricto de canciones
  if (category && category !== 'todo') {
    const categoryQueries = {
      'parati': 'Mix Exitos Recomendados para ti',
      'tendencias': 'Top 50 Canciones Tendencias',
      'reggaeton': 'Top Reggaeton Urbano Exitos',
      'pop': 'Top Pop Hits Canciones',
      'workout': 'Gym Workout Motivation Hits',
      'relax': 'Chill Acoustic Relax Canciones'
    };
    const searchQuery = categoryQueries[category.toLowerCase()] || `${category} canciones exitos`;

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
          context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00', gl: 'US', hl: 'es' } },
          query: searchQuery,
          params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D'
        })
      });
      const data = await ytRes.json();
      const secList = data.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      const items = [];
      const seen = new Set();

      for (const s of secList) {
        const list = s.musicShelfRenderer?.contents || [];
        for (const it of list) {
          const r = it.musicResponsiveListItemRenderer;
          if (!r) continue;
          const titleRun = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0];
          const title = titleRun?.text;
          const videoId = titleRun?.navigationEndpoint?.watchEndpoint?.videoId;
          if (!videoId || !title || seen.has(videoId)) continue;

          const subRuns = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const fullSub = subRuns.map(x => x.text).join('');
          const parts = fullSub.split('•').map(p => p.trim());
          let artist = parts[0] || 'Artista';
          let durObj = null;
          if (parts.length > 1) {
            durObj = parseDuration(parts[parts.length - 1]);
          }

          if (durObj && durObj.durationSeconds > 420) continue;

          const thumb = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url;
          seen.add(videoId);
          items.push({
            id: videoId,
            title,
            artist,
            duration: durObj?.durationSeconds || 0,
            durationSeconds: durObj?.durationSeconds || 0,
            durationText: durObj?.durationText || '',
            thumbnail: thumb || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
          });
        }
      }

      const categoryTitles = {
        'parati': 'Para Ti: Recomendaciones',
        'tendencias': 'Tendencias Globales Hoy',
        'reggaeton': 'Lo Mejor del Reggaetón',
        'pop': 'Grandes Éxitos Pop',
        'workout': 'Energía para Entrenar',
        'relax': 'Momento Relax'
      };

      const shelves = [{
        title: categoryTitles[category.toLowerCase()] || `Canciones de ${category}`,
        items: items.slice(0, 24)
      }];

      const payload = JSON.stringify({ shelves });
      if (res && res.setHeader) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
        return res.status(200).send(payload);
      }
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      // Si falla búsqueda de categoría, continuar al flujo general
    }
  }

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
            const parts = sub.split('•').map(p => p.trim());
            const durObj = parseDuration(parts[parts.length - 1]);
            items.push({
              id: videoId,
              title: title,
              artist: parts[0] || 'Artista',
              duration: durObj?.durationSeconds || 0,
              durationSeconds: durObj?.durationSeconds || 0,
              durationText: durObj?.durationText || '',
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
          const fullSub = subRuns.map(x => x.text).join('');
          const parts = fullSub.split('•').map(p => p.trim());
          const durObj = parseDuration(parts[parts.length - 1]);
          const artist = parts[0] || 'Artista';
          const thumb = resp.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url;

          if (videoId && title) {
            items.push({
              id: videoId,
              title: title,
              artist: artist,
              duration: durObj?.durationSeconds || 0,
              durationSeconds: durObj?.durationSeconds || 0,
              durationText: durObj?.durationText || '',
              thumbnail: thumb || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
            });
          }
        }
      }

      if (items.length > 0) {
        shelves.push({ title, items });
      }
    }

    // Si la página principal de browse no trae suficientes canciones directas, añadir hits populares con duraciones exactas
    if (shelves.length === 0 || !shelves.some(s => s.items.length >= 3)) {
      const fallbackTracks = [
        { id: '1gVaDaN9ljs', title: 'Ayer (con DJ Nelson, J Balvin, Nicky Jam y Cosculluela)', artist: 'Anuel', duration: 282, durationSeconds: 282, durationText: '4:42', thumbnail: 'https://i.ytimg.com/vi/1gVaDaN9ljs/hqdefault.jpg' },
        { id: 'dvgZkm1xWPE', title: 'Viva La Vida', artist: 'Coldplay', duration: 242, durationSeconds: 242, durationText: '4:02', thumbnail: 'https://i.ytimg.com/vi/dvgZkm1xWPE/hqdefault.jpg' },
        { id: 'k4V3Mo61fJM', title: 'Fix You', artist: 'Coldplay', duration: 295, durationSeconds: 295, durationText: '4:55', thumbnail: 'https://i.ytimg.com/vi/k4V3Mo61fJM/hqdefault.jpg' },
        { id: '1G4isv_Fylg', title: 'Paradise', artist: 'Coldplay', duration: 278, durationSeconds: 278, durationText: '4:38', thumbnail: 'https://i.ytimg.com/vi/1G4isv_Fylg/hqdefault.jpg' },
        { id: 'JGwWNGJdvx8', title: 'Shape of You', artist: 'Ed Sheeran', duration: 233, durationSeconds: 233, durationText: '3:53', thumbnail: 'https://i.ytimg.com/vi/JGwWNGJdvx8/hqdefault.jpg' },
        { id: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen', duration: 354, durationSeconds: 354, durationText: '5:54', thumbnail: 'https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg' },
        { id: '4NRXx6U8ABQ', title: 'Blinding Lights', artist: 'The Weeknd', duration: 200, durationSeconds: 200, durationText: '3:20', thumbnail: 'https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg' },
        { id: 'YQHsXMglC9A', title: 'Hello', artist: 'Adele', duration: 295, durationSeconds: 295, durationText: '4:55', thumbnail: 'https://i.ytimg.com/vi/YQHsXMglC9A/hqdefault.jpg' },
        { id: 'gNi_6U5Pm_o', title: 'As It Was', artist: 'Harry Styles', duration: 167, durationSeconds: 167, durationText: '2:47', thumbnail: 'https://i.ytimg.com/vi/gNi_6U5Pm_o/hqdefault.jpg' }
      ];
      shelves.unshift({ title: 'Éxitos Destacados', items: fallbackTracks });
    }

    const payload = JSON.stringify({ shelves });
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
    const errPayload = JSON.stringify({ error: err.message, shelves: [] });
    if (res && res.status) return res.status(500).send(errPayload);
    return new Response(errPayload, { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

// api/lyrics.js - Letras sincronizadas con LRCLIB
export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const rawTrack = (req.query && req.query.track) || urlObj.searchParams.get('track');
  const rawArtist = (req.query && req.query.artist) || urlObj.searchParams.get('artist');

  if (!rawTrack) {
    const err = JSON.stringify({ error: 'Falta nombre de pista' });
    if (res && res.status) return res.status(400).send(err);
    return new Response(err, { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    let cleanTrack = rawTrack
      .replace(/\s*[\(\[](official\s*video|audio|lyrics|video\s*oficial|visualizer|remix|hd|4k|videoclip|music\s*video)[\)\]]/gi, '')
      .replace(/\s*-\s*official\s*(music\s*)?video/gi, '')
      .trim();

    let cleanArtist = rawArtist && rawArtist !== 'Artista' ? rawArtist.trim() : '';

    // Si el título viene con formato "Artista - Canción"
    if (cleanTrack.includes(' - ')) {
      const parts = cleanTrack.split(' - ');
      if (!cleanArtist) cleanArtist = parts[0].trim();
      cleanTrack = parts.slice(1).join(' - ').trim();
    }

    const queryParams = new URLSearchParams({ track_name: cleanTrack });
    if (cleanArtist) {
      queryParams.append('artist_name', cleanArtist);
    }

    const headers = {
      'User-Agent': 'FreeSong/1.0 (https://github.com/jimeneztarazonasebastian-netizen/FreeSong)'
    };

    let data = null;
    const lrcRes = await fetch(`https://lrclib.net/api/get?${queryParams.toString()}`, { headers });
    if (lrcRes.ok) {
      data = await lrcRes.json();
    } else {
      // Fallback 1: Buscar por texto combinado
      const searchRes = await fetch(
        `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTrack + (cleanArtist ? ' ' + cleanArtist : ''))}`,
        { headers }
      );
      if (searchRes.ok) {
        const results = await searchRes.json();
        data = results?.[0] || null;
      }
    }

    const payload = JSON.stringify({
      syncedLyrics: data?.syncedLyrics || null,
      plainLyrics: data?.plainLyrics || null
    });

    if (res && res.setHeader) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
      return res.status(200).send(payload);
    }

    return new Response(payload, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=86400, stale-while-revalidate'
      }
    });
  } catch (err) {
    const errPayload = JSON.stringify({ error: err.message, syncedLyrics: null });
    if (res && res.status) return res.status(500).send(errPayload);
    return new Response(errPayload, { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

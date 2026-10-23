// api/lyrics.js - Letras sincronizadas con LRCLIB
export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const trackName = (req.query && req.query.track) || urlObj.searchParams.get('track');
  const artistName = (req.query && req.query.artist) || urlObj.searchParams.get('artist');

  if (!trackName) {
    const err = JSON.stringify({ error: 'Falta nombre de pista' });
    if (res && res.status) return res.status(400).send(err);
    return new Response(err, { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const cleanTrack = trackName
      .replace(/\s*[\(\[](official\s*video|audio|lyrics|video\s*oficial|visualizer|remix)[\)\]]/gi, '')
      .trim();

    const queryParams = new URLSearchParams({ track_name: cleanTrack });
    if (artistName && artistName !== 'Artista') {
      queryParams.append('artist_name', artistName);
    }

    const lrcRes = await fetch(`https://lrclib.net/api/get?${queryParams.toString()}`, {
      headers: { 'User-Agent': 'FreeSong/1.0 (https://github.com/jimeneztarazonasebastian-netizen/FreeSong)' }
    });

    let data = null;
    if (lrcRes.ok) {
      data = await lrcRes.json();
    } else {
      // Fallback a search si get exacto no dio resultado
      const searchRes = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanTrack + ' ' + (artistName || ''))}`, {
        headers: { 'User-Agent': 'FreeSong/1.0 (https://github.com/jimeneztarazonasebastian-netizen/FreeSong)' }
      });
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

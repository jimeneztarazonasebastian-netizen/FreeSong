// api/_yt.js - Utilidades compartidas para la API InnerTube de YouTube Music (SimpMusic engine)
export const YT_CLIENT = {
  clientName: 'WEB_REMIX',
  clientVersion: '1.20240101.01.00',
  gl: 'US',
  hl: 'es'
};

export const YT_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://music.youtube.com',
  'Referer': 'https://music.youtube.com/'
};

export const SEARCH_FILTERS = {
  songs: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
  videos: 'EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D',
  albums: 'EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D',
  artists: 'EgWKAQIgAWoKEAkQChAFEAMQBA%3D%3D',
  playlists: 'EgeKAQQoADgBagwQDhAKEAMQBRAJEAQ%3D',
  community_playlists: 'EgeKAQQoAEABagoQAxAEEAoQCRAF'
};

export async function fetchYt(endpoint, body, { timeoutMs = 8000, retries = 1 } = {}) {
  const url = `https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`;
  const payload = JSON.stringify({
    context: { client: YT_CLIENT },
    ...body
  });

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: YT_HEADERS,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) {
        throw new Error(`YouTube API ${endpoint} failed: ${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      // Reintenta una vez tras un fallo de red/timeout; los 4xx no mejoran.
      if (String(err.message || '').match(/\b(4\d\d)\b/)) break;
    }
  }
  throw lastErr;
}

// Acepta el valor de la cookie de YouTube tal como header (`SID=...; HSID=...`),
// como cookies.txt de Netscape o como JSON exportado por una extensión.
export function normalizeCookieInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('[') || value.startsWith('{')) {
    try {
      const data = JSON.parse(value);
      const list = Array.isArray(data) ? data : (data.cookies || []);
      return list
        .filter((c) => c && c.name && c.value)
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
    } catch {}
  }
  if (value.includes('\t')) {
    return value
      .split(/\r?\n/)
      .filter((line) => line && (!line.trim().startsWith('#') || line.startsWith('#HttpOnly_')))
      .map((line) => {
        const clean = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line;
        const parts = clean.split('\t');
        return parts.length >= 7 ? `${parts[5]}=${parts[6]}` : '';
      })
      .filter(Boolean)
      .join('; ');
  }
  return value.replace(/\r?\n/g, ' ').trim();
}

export function parseDuration(text) {
  if (!text) return { durationSeconds: 0, durationText: '' };
  const str = String(text).trim();
  const match = str.match(/(?:(\d+):)?(\d+):(\d{2})$/);
  if (!match) return { durationSeconds: 0, durationText: str };
  const hrs = match[1] ? parseInt(match[1], 10) : 0;
  const mins = parseInt(match[2], 10);
  const secs = parseInt(match[3], 10);
  return {
    durationSeconds: hrs * 3600 + mins * 60 + secs,
    durationText: match[0]
  };
}

export function cleanThumb(thumbnails, fallback = '') {
  if (!thumbnails || !Array.isArray(thumbnails) || thumbnails.length === 0) return fallback;
  const last = thumbnails[thumbnails.length - 1];
  let url = (last && last.url) || fallback;
  if (url.startsWith('//')) url = 'https:' + url;
  // Si es una miniatura de ytimg con tamaño pequeño, intentar alta resolución
  return url;
}

export function getRunsText(runs, separator = '') {
  if (!runs || !Array.isArray(runs)) return '';
  return runs.map(r => r.text || '').join(separator);
}

export function sendJson(res, data, status = 200, cacheSec = 1800) {
  const payload = JSON.stringify(data);
  const cacheHeader = cacheSec > 0 
    ? `public, s-maxage=${cacheSec}, stale-while-revalidate=${cacheSec * 2}`
    : 'no-store, max-age=0';

  if (res) {
    if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', cacheHeader);
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    if (typeof res.status === 'function') {
      res.status(status);
      if (typeof res.send === 'function') {
        return res.send(payload);
      }
    } else if (typeof res === 'object' && 'statusCode' in res) {
      res.statusCode = status;
    }
    if (typeof res.end === 'function') {
      return res.end(payload);
    }
  }

  return new Response(payload, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheHeader,
      'Access-Control-Allow-Origin': '*'
    }
  });
}

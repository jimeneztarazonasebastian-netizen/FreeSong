// api/lyrics.js - Letras sincronizadas con LRCLIB
//
// Claves para que la letra COINCIDA con la canción que suena:
//  1. `/api/get` de LRCLIB solo es fiable si se le pasa `duration`. Sin ese
//     dato devuelve otra grabación del mismo título (p. ej. Billie Jean de
//     482 s en vez de la de 294 s) y la letra queda desincronizada.
//  2. Si hay que buscar, se puntúan los candidatos por título, artista,
//     duración y por tener letra sincronizada. Nunca se toma results[0] a ciegas.
//  3. Se limpian del título los ruidos de YouTube: "(Official Video)",
//     "Lyric Video", "feat.", "En Vivo", "Remastered", "4K", etc.

const LRCLIB = 'https://lrclib.net/api';
const UA = 'FreeSong/1.0 (https://github.com/jimeneztarazonasebastian-netizen/FreeSong)';
const REQUEST_TIMEOUT = 4500;

// Frases que YouTube añade al título y que LRCLIB no tiene.
const NOISE_PATTERNS = [
  /\b(official|oficial)\s+(music\s+)?(video|vídeo|videoclip|clip|audio|áudio)\b/gi,
  /\b(music|música)\s+(video|vídeo)\b/gi,
  /\b(lyric|lyrics|letra)\s*(video|vídeo)?\b/gi,
  /\b(video|vídeo)\s*(oficial|official|lyric|letra)\b/gi,
  /\bvisuali[sz]er\b/gi,
  /\b(audio|áudio)\b/gi,
  /\b(hd|hq|4k|8k|1080p|720p)\b/gi,
  /\bremaster(ed|izado|izada)?\b/gi,
  /\b(en\s+vivo|ao\s+vivo|aovivo|live)\b/gi,
  /\b(slowed|reverb|sped\s*up|nightcore|bass\s*boost)\b/gi,
  /\b(topic|vevo)\b/gi,
  /\b(feat|ft|featuring)\b\.?/gi,
  /\b(official|oficial)\b/gi
];

function deaccent(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalize(value) {
  return deaccent(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanTitle(raw) {
  let title = String(raw || '').replace(/[\u2010-\u2015]/g, '-');
  // Quita los grupos entre paréntesis/corchetes que son ruido conocido.
  title = title.replace(/\s*[\(\[]([^)\]]*)[\)\]]/g, (block, inner) => {
    const text = deaccent(inner).toLowerCase().trim();
    const noisy = /^(con|with|feat\.?|ft\.?|featuring)\b/.test(text) ||
      /(official|oficial|video|vídeo|audio|áudio|lyric|letra|visuali[sz]er|remix|hd|4k|8k|live|en\s*vivo|remaster|sped|slowed|nightcore|cover|karaoke|instrumental|topic|vevo|radio\s*edit)/.test(text);
    return noisy ? ' ' : block;
  });
  for (const pattern of NOISE_PATTERNS) title = title.replace(pattern, ' ');
  title = title.replace(/\s*[-–—]\s*(official|oficial|video|vídeo|audio|áudio|lyric|letra|topic|vevo)\s*$/gi, '');
  return title.replace(/\s+/g, ' ').trim();
}

// Variante agresiva: sin NINGÚN paréntesis. Es el último recurso cuando el
// título de YouTube lleva coletillas que LRCLIB no tiene ("con X", "Tour 2024").
function stripBrackets(raw) {
  return String(raw || '')
    .replace(/\s*[\(\[][^)\]]*[\)\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function primaryArtist(raw) {
  return String(raw || '')
    .split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bx\b)\s*/i)[0]
    .trim();
}

function tokenSimilarity(a, b) {
  const ta = normalize(a).split(' ').filter(Boolean);
  const tb = normalize(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let hits = 0;
  for (const token of ta) if (setB.has(token)) hits++;
  return hits / Math.max(ta.length, tb.length);
}

function scoreCandidate(candidate, want) {
  if (!candidate) return -Infinity;

  const candTitle = candidate.trackName || '';
  const candArtist = candidate.artistName || '';
  const candDuration = Number(candidate.duration) || 0;

  const nt = normalize(candTitle);
  const wt = normalize(want.title);
  const na = normalize(candArtist);
  const wa = normalize(want.artist);

  let score = 0;

  // Título
  if (nt && nt === wt) score += 100;
  else if (nt && wt && (nt.includes(wt) || wt.includes(nt))) score += 60;
  else score += Math.round(tokenSimilarity(candTitle, want.title) * 60);

  // Artista (solo si lo conocemos)
  if (wa && na) {
    if (na === wa) score += 60;
    else if (na.includes(wa) || wa.includes(na)) score += 35;
    else score -= 30;
  }

  // Duración: el filtro más fiable para no coger otra grabación.
  if (want.duration > 0 && candDuration > 0) {
    const diff = Math.abs(candDuration - want.duration);
    if (diff <= 2) score += 100;
    else if (diff <= 5) score += 60;
    else if (diff <= 10) score += 20;
    else score -= Math.min(120, Math.round(diff * 2));
  }

  // Se prefiere letra sincronizada sobre letra plana.
  if (candidate.syncedLyrics) score += 40;
  else if (candidate.plainLyrics) score += 5;

  // Versiones habitualmente incompatibles con la letra original.
  if (!/remix|cover|karaoke|instrumental|tribute/i.test(want.title)) {
    if (/remix|karaoke|instrumental|tribute/i.test(candTitle)) score -= 45;
  }

  return score;
}

async function fetchJson(url, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: controller.signal
    });
    if (res.status === 429 || res.status >= 500) {
      // LRCLIB devuelve 503 puntuales bajo carga: un reintento corto basta.
      if (attempt < 2) {
        clearTimeout(timer);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return fetchJson(url, attempt + 1);
      }
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Cache en memoria del lambda: repetir la misma canción no vuelve a LRCLIB.
const memoryCache = new Map();
const MEMORY_MAX = 120;

function cacheGet(key) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > 6 * 3600 * 1000) {
    memoryCache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  if (memoryCache.size >= MEMORY_MAX) memoryCache.delete(memoryCache.keys().next().value);
  memoryCache.set(key, { at: Date.now(), data });
}

function pickBest(list, want) {
  let best = null;
  let bestScore = -Infinity;
  for (const candidate of list) {
    if (!candidate || (!candidate.syncedLyrics && !candidate.plainLyrics)) continue;
    const score = scoreCandidate(candidate, want);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best ? { candidate: best, score: bestScore } : null;
}

function isConfident(match, want) {
  if (!match) return false;
  if (match.score < 150) return false;
  // Si la duración no cuadra, mejor seguir buscando otra versión.
  if (want.duration > 0 && match.candidate.duration > 0) {
    return Math.abs(match.candidate.duration - want.duration) <= 6;
  }
  return true;
}

function buildPayload(match) {
  const candidate = match ? match.candidate : null;
  return {
    syncedLyrics: candidate?.syncedLyrics || null,
    plainLyrics: candidate?.plainLyrics || null,
    match: candidate
      ? {
          title: candidate.trackName || null,
          artist: candidate.artistName || null,
          album: candidate.albumName || null,
          duration: Number(candidate.duration) || 0,
          instrumental: !!candidate.instrumental,
          score: Math.round(match.score),
          synced: !!candidate.syncedLyrics
        }
      : null
  };
}

async function resolveLyrics(rawTrack, rawArtist, rawDuration) {
  const cleanTrack = cleanTitle(rawTrack);
  const cleanArtist = cleanTitle(rawArtist && rawArtist !== 'Artista' ? rawArtist : '');

  let wantArtist = cleanArtist;
  let wantTitle = cleanTrack;

  // Formato "Artista - Canción" muy común en YouTube
  if (wantTitle.includes(' - ')) {
    const parts = wantTitle.split(' - ');
    if (!wantArtist) wantArtist = cleanTitle(parts[0]);
    wantTitle = cleanTitle(parts.slice(1).join(' - '));
  }

  const want = {
    title: wantTitle || rawTrack,
    artist: wantArtist,
    duration: Math.round(Number(rawDuration) || 0)
  };

  const titles = [...new Set([
    want.title,
    stripBrackets(want.title),
    cleanTitle(rawTrack),
    stripBrackets(cleanTitle(rawTrack))
  ].filter(Boolean))].slice(0, 3);
  const artists = [...new Set([want.artist, primaryArtist(want.artist)].filter(Boolean))];

  const enc = encodeURIComponent;
  // Presupuesto total: Vercel corta las funciones lentas y aquí hay varias
  // peticiones encadenadas a LRCLIB. Si se agota, se devuelve lo mejor hallado.
  const deadline = Date.now() + 8000;
  const request = (url) => (Date.now() < deadline ? fetchJson(url) : Promise.resolve(null));
  let match = null;
  const consider = (candidate) => {
    if (!candidate || (!candidate.syncedLyrics && !candidate.plainLyrics)) return null;
    const scored = { candidate, score: scoreCandidate(candidate, want) };
    if (!match || scored.score > match.score) match = scored;
    return scored;
  };

  // 1) Coincidencia exacta con duración: es la que da la grabación correcta.
  if (want.duration > 0) {
    for (const title of titles) {
      for (const artist of artists.slice(0, 2)) {
        const exact = await request(
          `${LRCLIB}/get?track_name=${enc(title)}&artist_name=${enc(artist)}&duration=${want.duration}`
        );
        const scored = consider(exact);
        if (isConfident(scored, want)) return scored;
      }
    }
  }

  // 2) Búsqueda por campos para cada variante del título.
  for (const title of titles) {
    const fieldSearch = await request(
      `${LRCLIB}/search?track_name=${enc(title)}${want.artist ? `&artist_name=${enc(want.artist)}` : ''}`
    );
    const best = pickBest(Array.isArray(fieldSearch) ? fieldSearch : [], want);
    if (best && (!match || best.score > match.score)) match = best;
    if (isConfident(match, want)) return match;
  }

  // 3) Búsqueda libre (título + artista) y comparación con la anterior.
  const q = `${want.title} ${want.artist}`.trim();
  const freeSearch = await request(`${LRCLIB}/search?q=${enc(q)}`);
  const freeMatch = pickBest(Array.isArray(freeSearch) ? freeSearch : [], want);
  if (freeMatch && (!match || freeMatch.score > match.score)) match = freeMatch;
  if (isConfident(match, want)) return match;

  // 4) Último recurso: /get sin duración (puede ser otra grabación).
  if (want.duration > 0) {
    for (const title of titles.slice(0, 2)) {
      const fallback = await request(
        `${LRCLIB}/get?track_name=${enc(title)}${want.artist ? `&artist_name=${enc(want.artist)}` : ''}`
      );
      consider(fallback);
    }
  }

  return match;
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const rawTrack = (req.query && req.query.track) || urlObj.searchParams.get('track');
  const rawArtist = (req.query && req.query.artist) || urlObj.searchParams.get('artist');
  const rawDuration = (req.query && req.query.duration) || urlObj.searchParams.get('duration');

  if (!rawTrack) {
    const err = JSON.stringify({ error: 'Falta nombre de pista', syncedLyrics: null });
    // Los errores no se cachean: un fallo puntual no debe repetirse durante horas.
    if (res && res.setHeader) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.statusCode = 400;
      return res.end(err);
    }
    return new Response(err, {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' }
    });
  }

  const cacheKey = `${normalize(rawTrack)}|${normalize(rawArtist)}|${Math.round(Number(rawDuration) || 0)}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    const payload = JSON.stringify({ ...cached, cached: true });
    if (res && res.setHeader) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).send(payload);
    }
    return new Response(payload, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=86400, stale-while-revalidate=604800'
      }
    });
  }

  try {
    const match = await resolveLyrics(rawTrack, rawArtist, rawDuration);
    const data = buildPayload(match);
    cacheSet(cacheKey, data);

    const payload = JSON.stringify(data);
    if (res && res.setHeader) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).send(payload);
    }
    return new Response(payload, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=86400, stale-while-revalidate=604800'
      }
    });
  } catch (err) {
    const errPayload = JSON.stringify({ error: err.message, syncedLyrics: null, plainLyrics: null });
    if (res && res.setHeader) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.statusCode = 500;
      return res.end(errPayload);
    }
    return new Response(errPayload, {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' }
    });
  }
}

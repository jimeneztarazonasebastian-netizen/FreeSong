// FreeSong - Utilidades de letras.
//
// Solo lógica pura (sin DOM ni estado global) para poder probarla en Node y
// mantenerla fuera de app.js. app.js se encarga de pintar y sincronizar.
(() => {
  'use strict';

  // Clave estable de caché para una pista.
  function cacheKey(track) {
    if (!track) return '';
    return `${track.id || ''}|${String(track.title || '').toLowerCase()}|${String(track.artist || '').toLowerCase()}`;
  }

  // Convierte LRC (incluido LRC mejorado y [offset:...]) en [{ time, text }].
  function parseLrc(lrcText) {
    if (!lrcText) return [];
    const timeTag = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const offsetTag = /\[offset:\s*([+-]?\d+)\]/i.exec(lrcText);
    const offset = offsetTag ? (parseInt(offsetTag[1], 10) || 0) / 1000 : 0;
    const result = [];

    for (const rawLine of String(lrcText).split(/\r?\n/)) {
      timeTag.lastIndex = 0;
      const stamps = [];
      let match;
      while ((match = timeTag.exec(rawLine))) {
        const min = parseInt(match[1], 10);
        const sec = parseInt(match[2], 10);
        const frac = match[3] ? parseInt(match[3], 10) / Math.pow(10, match[3].length) : 0;
        stamps.push(min * 60 + sec + frac);
      }
      if (!stamps.length) continue;

      const text = rawLine
        .replace(timeTag, '')
        .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '') // LRC mejorado (palabra a palabra)
        .trim();
      if (!text) continue;

      for (const time of stamps) result.push({ time: Math.max(0, time + offset), text });
    }

    result.sort((a, b) => a.time - b.time);
    const deduped = [];
    for (const item of result) {
      const prev = deduped[deduped.length - 1];
      if (prev && Math.abs(prev.time - item.time) < 0.01 && prev.text === item.text) continue;
      deduped.push(item);
    }
    return deduped;
  }

  // Índice de la última línea cuyo tiempo ya pasó (búsqueda binaria).
  function findIndex(list, t) {
    if (!Array.isArray(list) || list.length === 0) return -1;
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t >= list[mid].time) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  window.FreeSongLyrics = { cacheKey, parseLrc, findIndex };
})();

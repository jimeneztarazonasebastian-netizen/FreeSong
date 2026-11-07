// FreeSong - Utilidades puras compartidas.
//
// Módulo clásico (sin dependencias) para poder cargarlo antes que app.js y
// probarlo por separado. Solo contiene funciones sin estado ni acceso a la
// cola de reproducción; así es seguro reutilizarlas desde cualquier pantalla.
(() => {
  'use strict';

  // Escapa texto dinámico (títulos, artistas, nombres de playlist) antes de usarlo en innerHTML.
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));

  // Las miniaturas de YouTube Music llegan en 120 px. En pantallas Retina eso
  // se ve pixelado en el reproductor y en las tarjetas. Esta función pide la
  // variante adecuada al mismo host: 160 px para listas y 480–720 px para
  // portadas grandes, sin descargar imágenes enormes en cada fila.
  function thumbAt(url, size = 160) {
    const raw = String(url || '');
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
    const px = Math.max(64, Math.round(Number(size) || 160));
    try {
      const u = new URL(raw, window.location.href);
      if (/(^|\.)googleusercontent\.com$/i.test(u.hostname)) {
        // Formatos: ...=w120-h120-l90-rj o ...=s120-c-k-c0x00ffffff-no-rj
        u.pathname = u.pathname.replace(/=(?:w\d+|h\d+|s\d+)[^/]*$/i, `=w${px}-h${px}-l90-rj`);
        return u.toString();
      }
      if (/(^|\.)ytimg\.com$/i.test(u.hostname)) {
        const m = u.pathname.match(/^\/vi\/([\w-]+)\//);
        if (m) {
          const file = px >= 480 ? 'maxresdefault' : 'mqdefault';
          return `https://i.ytimg.com/vi/${m[1]}/${file}.jpg`;
        }
      }
    } catch {}
    return raw;
  }

  // Mezcla uniforme (Fisher-Yates); sort(() => Math.random() - 0.5) está sesgado.
  function shuffled(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Duración legible: 0:00, 3:07, 59:59.
  function formatTime(secs) {
    if (isNaN(secs) || secs < 0) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  window.FreeSongUtil = { esc, thumbAt, shuffled, formatTime };
})();

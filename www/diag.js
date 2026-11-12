// FreeSong - Diagnóstico local (sin telemetría).
//
// Módulo aislado a propósito: mantiene las métricas de reproducción fuera de
// app.js y no depende de su estado interno. Todo se guarda en localStorage y
// nunca se envía a ningún servidor.
//
// Además de los contadores, guarda un historial corto de eventos (errores de
// reproducción, rechazos de play() de iOS, fallos de red, descargas…) para
// poder exportarlo como JSON y revisar qué pasó en un iPhone real.
//
// Uso desde app.js:
//   FreeSongDiag.init({ version, toast });
//   FreeSongDiag.setSnapshot(() => ({ ...estado actual... }));
//   FreeSongDiag.log('stream-fail', { id, step });
//   FreeSongDiag.inc('skips');
(() => {
  'use strict';

  const DIAG_KEY = 'fs_diag_v1';
  const EVENTS_KEY = 'fs_diag_events_v1';
  const MAX_EVENTS = 120; // en memoria
  const MAX_DISK_EVENTS = 60; // al guardar en localStorage
  const MAX_TEXT = 180; // recorta cadenas largas (URLs firmadas, HTML…)
  const DEDUPE_MS = 4000;

  const sessionId = (() => {
    try {
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    } catch {
      return 'sesion';
    }
  })();
  const startedAt = Date.now();

  let diagData = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DIAG_KEY) || 'null');
      if (saved && typeof saved === 'object') return saved;
    } catch {}
    return {};
  })();

  let events = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(EVENTS_KEY) || 'null');
      if (Array.isArray(saved)) return saved.filter((e) => e && typeof e === 'object').slice(-MAX_EVENTS);
    } catch {}
    return [];
  })();

  let version = '0.0.0';
  let toast = () => {};
  let snapshotFn = null;
  let saveTimer = null;
  let totalEvents = events.length;

  function saveDiag() {
    try {
      diagData.updated = Date.now();
      localStorage.setItem(DIAG_KEY, JSON.stringify(diagData));
    } catch {}
  }

  function saveEvents() {
    saveTimer = null;
    try {
      localStorage.setItem(EVENTS_KEY, JSON.stringify(events.slice(-MAX_DISK_EVENTS)));
    } catch {}
  }

  function scheduleSaveEvents() {
    if (saveTimer) return;
    try {
      saveTimer = setTimeout(saveEvents, 800);
    } catch {
      saveEvents();
    }
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveEvents();
    saveDiag();
  }

  // Convierte cualquier valor en algo seguro para JSON: sin funciones, sin
  // ciclos y con las cadenas largas recortadas.
  function sanitize(value, depth = 0) {
    if (value == null) return value;
    if (typeof value === 'string') return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '…' : value;
    if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : String(value);
    if (typeof value === 'boolean') return value;
    if (value instanceof Error) {
      return { name: value.name || 'Error', message: sanitize(value.message || String(value)) };
    }
    if (typeof value === 'object') {
      if (depth >= 3) return '[objeto]';
      if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
      const out = {};
      let keys = 0;
      for (const key of Object.keys(value)) {
        if (keys++ >= 25) break;
        try {
          out[key] = sanitize(value[key], depth + 1);
        } catch {}
      }
      return out;
    }
    return String(value).slice(0, MAX_TEXT);
  }

  // Ruta sin query string: las URLs de audio llevan firmas que no deben
  // guardarse ni compartirse.
  function safePath(raw) {
    if (!raw) return '';
    try {
      const url = new URL(String(raw), location.href);
      const isSame = url.origin === location.origin;
      const base = isSame ? url.pathname : `${url.host}${url.pathname}`;
      return base.slice(0, MAX_TEXT);
    } catch {
      return String(raw).split('?')[0].slice(0, MAX_TEXT);
    }
  }

  function init(options = {}) {
    if (options.version) version = String(options.version);
    if (typeof options.toast === 'function') toast = options.toast;
  }

  function setSnapshot(fn) {
    if (typeof fn === 'function') snapshotFn = fn;
  }

  function inc(key, amount = 1) {
    if (!key) return;
    diagData[key] = (Number(diagData[key]) || 0) + amount;
    saveDiag();
  }

  // Registra un evento con hora y datos cortos. Los eventos idénticos seguidos
  // se agrupan para que un bucle de errores no llene el historial.
  function log(name, data) {
    if (!name) return;
    const now = Date.now();
    const entry = { at: now, name: String(name).slice(0, 40) };
    if (data !== undefined) entry.data = sanitize(data);
    totalEvents++;
    const last = events[events.length - 1];
    if (last && last.name === entry.name && JSON.stringify(last.data || null) === JSON.stringify(entry.data || null) && now - (last.lastAt || last.at) < DEDUPE_MS) {
      last.n = (Number(last.n) || 1) + 1;
      last.lastAt = now;
    } else {
      events.push(entry);
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    }
    scheduleSaveEvents();
    render();
  }

  // Registra un arranque real de audio (no una simple precarga).
  function recordStart(ms) {
    if (!(ms > 0) || ms > 120000) return;
    diagData.plays = (Number(diagData.plays) || 0) + 1;
    diagData.startCount = (Number(diagData.startCount) || 0) + 1;
    diagData.startTotalMs = (Number(diagData.startTotalMs) || 0) + Math.round(ms);
    diagData.lastStartMs = Math.round(ms);
    saveDiag();
  }

  function fmtDiagMs(ms) {
    if (!(ms > 0)) return '—';
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  function render() {
    const summary = document.getElementById('diagSummary');
    const detail = document.getElementById('diagDetail');
    if (!summary || !detail) return;
    const plays = Number(diagData.plays) || 0;
    const count = Number(diagData.startCount) || 0;
    const avg = count ? Math.round((Number(diagData.startTotalMs) || 0) / count) : 0;
    if (!plays && !diagData.recoveries && !diagData.skips && events.length === 0) {
      summary.textContent = 'Todavía no hay datos. Reproduce algunas canciones y vuelve aquí.';
      detail.textContent = 'Se guardan solo en este dispositivo; no se envía nada a ningún servidor.';
      return;
    }
    summary.textContent = `${plays} reproducciones · arranque medio ${fmtDiagMs(avg)} · último ${fmtDiagMs(diagData.lastStartMs)}`;
    detail.textContent = `${diagData.recoveries || 0} recuperaciones · ${diagData.skips || 0} pistas saltadas · ${diagData.alts || diagData.alt || 0} copias alternativas · ${events.length} eventos`;
  }

  function counters() {
    const out = {};
    for (const key of Object.keys(diagData)) {
      if (key === 'updated') continue;
      out[key] = diagData[key];
    }
    return out;
  }

  function report() {
    let playback = null;
    if (typeof snapshotFn === 'function') {
      try {
        playback = sanitize(snapshotFn());
      } catch (err) {
        playback = { error: sanitize(err) };
      }
    }
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    let standalone = false;
    try {
      standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || navigator.standalone === true;
    } catch {}
    return {
      app: 'FreeSong',
      version,
      sessionId,
      startedAt: new Date(startedAt).toISOString(),
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      platform: navigator.platform || '',
      language: navigator.language || '',
      standalone,
      online: navigator.onLine,
      visibility: document.visibilityState,
      screen: `${window.screen.width}x${window.screen.height}@${window.devicePixelRatio || 1}`,
      connection: connection
        ? { type: connection.effectiveType || '', downlink: connection.downlink || 0, rtt: connection.rtt || 0 }
        : null,
      counters: counters(),
      playback,
      events
    };
  }

  function reportText() {
    return JSON.stringify(report(), null, 2);
  }

  function fileName() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `freesong-diagnostico-${stamp}.json`;
  }

  function copyFallback(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    document.body.removeChild(area);
    return ok;
  }

  async function copy() {
    const text = reportText();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        toast('Diagnóstico copiado: pégalo en el chat');
        return true;
      }
    } catch {}
    if (copyFallback(text)) {
      toast('Diagnóstico copiado: pégalo en el chat');
      return true;
    }
    toast('No se pudo copiar. Usa «Compartir».', 3200);
    return false;
  }

  // En iPhone lo más cómodo es compartir el JSON por WhatsApp/Notas/Correo.
  async function share() {
    const text = reportText();
    const name = fileName();
    try {
      if (navigator.share) {
        try {
          const file = new File([text], name, { type: 'application/json' });
          if (!navigator.canShare || navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'Diagnóstico FreeSong' });
            return true;
          }
        } catch (err) {
          if (err && err.name === 'AbortError') return false;
        }
        await navigator.share({ title: 'Diagnóstico FreeSong', text });
        return true;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return false;
    }
    return copy();
  }

  function reset() {
    diagData = {};
    events = [];
    totalEvents = 0;
    saveDiag();
    flush();
    render();
    toast('Diagnóstico reiniciado');
  }

  // --- Captura automática de errores ---
  window.addEventListener('error', (event) => {
    if (event && event.target && event.target !== window && event.target.tagName) {
      // Error de carga de un recurso (img/script/audio): guarda solo la ruta.
      const tag = String(event.target.tagName || '').toLowerCase();
      if (tag === 'img') return; // las portadas fallan a menudo y no son relevantes
      log('resource-error', { tag, path: safePath(event.target.currentSrc || event.target.src) });
      return;
    }
    log('js-error', {
      message: event && event.message ? event.message : 'error',
      source: event && event.filename ? safePath(event.filename) : '',
      line: event && event.lineno ? event.lineno : 0
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason;
    log('promise-error', reason instanceof Error ? reason : { message: String(reason) });
  });

  // --- Fallos de red (API, relay, proxy) sin tocar la lógica de la app ---
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function diagFetch(input, init) {
      const method = (init && init.method) || (input && input.method) || 'GET';
      const path = safePath(typeof input === 'string' ? input : (input && input.url) || '');
      const started = Date.now();
      let promise;
      try {
        promise = originalFetch.apply(this, arguments);
      } catch (err) {
        log('net-error', { m: method, p: path, e: err });
        throw err;
      }
      if (!promise || typeof promise.then !== 'function') return promise;
      return promise.then(
        (res) => {
          try {
            if (res && !res.ok) {
              log('http-error', { m: String(method).toUpperCase(), p: path, s: res.status, ms: Date.now() - started });
            }
          } catch {}
          return res;
        },
        (err) => {
          if (!(err && err.name === 'AbortError')) {
            log('net-error', { m: String(method).toUpperCase(), p: path, e: err, ms: Date.now() - started });
          }
          throw err;
        }
      );
    };
  }

  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);

  window.FreeSongDiag = { init, setSnapshot, inc, log, recordStart, render, reset, copy, share, report, reportText };
})();

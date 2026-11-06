// FreeSong - Diagnóstico local (sin telemetría).
//
// Módulo aislado a propósito: mantiene las métricas de reproducción fuera de
// app.js y no depende de su estado interno. Todo se guarda en localStorage y
// nunca se envía a ningún servidor.
//
// Uso desde app.js:
//   FreeSongDiag.init({ version, toast });
//   FreeSongDiag.inc('skips');
(() => {
  'use strict';

  const DIAG_KEY = 'fs_diag_v1';

  let diagData = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DIAG_KEY) || 'null');
      if (saved && typeof saved === 'object') return saved;
    } catch {}
    return {};
  })();

  let version = '0.0.0';
  let toast = () => {};

  function saveDiag() {
    try {
      diagData.updated = Date.now();
      localStorage.setItem(DIAG_KEY, JSON.stringify(diagData));
    } catch {}
  }

  function init(options = {}) {
    if (options.version) version = String(options.version);
    if (typeof options.toast === 'function') toast = options.toast;
  }

  function inc(key, amount = 1) {
    if (!key) return;
    diagData[key] = (Number(diagData[key]) || 0) + amount;
    saveDiag();
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
    if (!plays && !diagData.recoveries && !diagData.skips) {
      summary.textContent = 'Todavía no hay datos. Reproduce algunas canciones y vuelve aquí.';
      detail.textContent = 'Se guardan solo en este dispositivo; no se envía nada a ningún servidor.';
      return;
    }
    summary.textContent = `${plays} reproducciones · arranque medio ${fmtDiagMs(avg)} · último ${fmtDiagMs(diagData.lastStartMs)}`;
    detail.textContent = `${diagData.recoveries || 0} recuperaciones · ${diagData.skips || 0} pistas saltadas · ${diagData.alt || 0} copias alternativas · ${diagData.stops || 0} paradas`;
  }

  function reset() {
    diagData = {};
    saveDiag();
    render();
    toast('Diagnóstico reiniciado');
  }

  async function copy() {
    const report = {
      app: 'FreeSong',
      version,
      userAgent: navigator.userAgent,
      online: navigator.onLine,
      data: diagData
    };
    const text = JSON.stringify(report, null, 2);
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('sin portapapeles');
      await navigator.clipboard.writeText(text);
      toast('Informe copiado al portapapeles');
    } catch {
      toast('No se pudo copiar. Revisa los permisos del navegador.', 3200);
    }
  }

  window.FreeSongDiag = { init, inc, recordStart, render, reset, copy };
})();

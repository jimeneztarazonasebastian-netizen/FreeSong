// FreeSong - Actualizaciones de la PWA.
//
// Módulo aislado del motor de reproducción. Nunca recarga la app por su cuenta:
// si hay música sonando, solo muestra un aviso y espera a que la persona pulse
// "Actualizar". También busca versiones nuevas al volver a la app.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let registration = null;
  let appVersion = '';
  let dismissed = false;
  let reloading = false;

  function show() {
    if (!dismissed) $('updateBanner')?.classList.remove('hidden');
  }

  function hide() {
    $('updateBanner')?.classList.add('hidden');
  }

  function apply() {
    if (reloading) return;
    reloading = true;
    hide();
    try { registration?.waiting?.postMessage({ type: 'SKIP_WAITING' }); } catch {}
    // Margen para que el nuevo service worker tome el control antes de recargar.
    setTimeout(() => window.location.reload(), 300);
  }

  function init(options = {}) {
    appVersion = String(options.version || '');
    $('updateNowBtn')?.addEventListener('click', apply);
    $('updateLaterBtn')?.addEventListener('click', () => {
      dismissed = true;
      hide();
    });

    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('/sw.js').then((reg) => {
      registration = reg;
      if (reg.waiting) show();
    }).catch(() => {});

    // El service worker avisa de su versión al activarse. Solo mostramos el
    // aviso si la app en pantalla es más antigua: si ya cargó el código nuevo
    // (Network-First), no tiene sentido pedir una recarga.
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.type !== 'FS_SW_VERSION' || reloading) return;
      const swVersion = String(data.version || '').replace(/^freesong-v/, '');
      if (swVersion && swVersion !== appVersion) show();
    });

    // Busca actualizaciones al volver a la app, como mucho una vez por hora.
    let lastUpdateCheck = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !registration) return;
      const now = Date.now();
      if (now - lastUpdateCheck < 60 * 60 * 1000) return;
      lastUpdateCheck = now;
      registration.update().catch(() => {});
    });
  }

  window.FreeSongPwa = { init };
})();

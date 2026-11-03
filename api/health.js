// api/health.js - Diagnóstico del motor de reproducción (sin secretos).
// Devuelve si YouTube Music (InnerTube) responde, cuántas instancias de relay
// hay configuradas y si existe la cookie de YouTube. No expone valores sensibles.
import { fetchYt, SEARCH_FILTERS, sendJson } from './_yt.js';
import { relayInstances } from './_relay.js';

export default async function handler(req, res) {
  const started = Date.now();

  // Chequeo real y ligero: la misma ruta que usa la búsqueda de la app.
  let reachable = false;
  let engineError = '';
  try {
    const data = await fetchYt(
      'search',
      { query: 'freesong health check', params: SEARCH_FILTERS.songs },
      { timeoutMs: 7000, retries: 0 }
    );
    reachable = !!(data && data.contents);
    if (!reachable) engineError = 'YouTube Music devolvió una respuesta inesperada';
  } catch (err) {
    engineError = String(err && err.message ? err.message : err) || 'Sin conexión con YouTube Music';
  }
  const latencyMs = Date.now() - started;

  const relays = relayInstances();
  const hosts = relays.map((u) => {
    try { return new URL(u).host; } catch { return u; }
  });

  const cookieConfigured = !!process.env.YOUTUBE_COOKIE;

  // El motor está sano si InnerTube responde y hay al menos un relay configurado.
  const ok = reachable && relays.length > 0;

  return sendJson(res, {
    ok,
    checkedAt: new Date().toISOString(),
    version: '3.6.0',
    engine: {
      name: 'YouTube Music (InnerTube)',
      reachable,
      latencyMs,
      error: reachable ? '' : engineError
    },
    relays: {
      configured: relays.length,
      hosts
    },
    cookieConfigured
  }, 200, 0);
}

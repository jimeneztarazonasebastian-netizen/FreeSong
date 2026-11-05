// api/health.js - Diagnóstico del motor de reproducción y configuración de relays.
// Devuelve si YouTube Music (InnerTube) responde, cuántas instancias de relay
// hay configuradas y si existe la cookie de YouTube. No expone valores sensibles.
// También atiende /api/relay-info mediante rewrite para no exceder el límite de 12 funciones de Vercel Hobby.
import { fetchYt, SEARCH_FILTERS, sendJson } from './_yt.js';
import { relayInstances } from './_relay.js';

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const relays = relayInstances();

  // PRUEBA TEMPORAL: listar pistas de un álbum desde la IP de Vercel.
  if (urlObj.searchParams.get('probe') === 'album') {
    const browseId = urlObj.searchParams.get('id') || '';
    const needle = (urlObj.searchParams.get('q') || '').toLowerCase();
    try {
      const data = await fetchYt('browse', { browseId }, { timeoutMs: 9000, retries: 0 });
      const found = [];
      const seen = new Set();
      const walk = (node) => {
        if (!node || typeof node !== 'object' || found.length > 60) return;
        if (Array.isArray(node)) { for (const n of node) walk(n); return; }
        const r = node.musicResponsiveListItemRenderer;
        if (r) {
          const runs = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const title = runs.map(x => x.text || '').join('').trim();
          const vid = r.playlistItemData?.videoId || runs[0]?.navigationEndpoint?.watchEndpoint?.videoId || '';
          const type = runs[0]?.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType || '';
          if (vid && !seen.has(vid)) {
            seen.add(vid);
            if (!needle || title.toLowerCase().includes(needle)) found.push({ vid, title, type });
          }
        }
        for (const k of Object.keys(node)) walk(node[k]);
      };
      walk(data);
      return sendJson(res, { ok: true, browseId, found: found.slice(0, 30) }, 200, 0);
    } catch (e) {
      return sendJson(res, { ok: false, error: String(e && e.message || e) }, 200, 0);
    }
  }

  // Si se solicita información de relays (/api/relay-info o ?relay=1)
  if (urlObj.searchParams.get('relay') === '1' || urlObj.pathname.includes('relay')) {
    const body = { instances: relays };
    return sendJson(res, body, 200, 300);
  }

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

  const hosts = relays.map((u) => {
    try { return new URL(u).host; } catch { return u; }
  });

  const cookieConfigured = !!process.env.YOUTUBE_COOKIE;

  // El motor está sano si InnerTube responde y hay al menos un relay configurado.
  const ok = reachable && relays.length > 0;

  return sendJson(res, {
    ok,
    checkedAt: new Date().toISOString(),
    version: '3.8.0',
    engine: {
      name: 'YouTube Music (InnerTube)',
      reachable,
      latencyMs,
      error: reachable ? '' : engineError
    },
    relays: {
      configured: relays.length,
      hosts,
      instances: relays
    },
    cookieConfigured
  }, 200, 0);
}

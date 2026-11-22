// Service worker de FreeSong v3.9.44: App Shell local con actualizaciones de fondo
// Las pistas de audio offline viven en 'freesong-offline-audio-v1' y NUNCA se eliminan.
const VERSION = 'freesong-v3.9.44';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'util.js',
  'storage.js',
  'lyrics.js',
  'diag.js',
  'pwa.js',
  'native-audio.js',
  'app.min.js',
  'capacitor.js',
  'manifest.webmanifest',
  'fonts/inter-latin.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k !== VERSION && /^freesong-v\d/.test(k))
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => clients.forEach((client) => client.postMessage({ type: 'FS_SW_VERSION', version: VERSION })))
  );
});

// Permite que la app aplique una versión nueva en espera sin cerrar la pestaña.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') event.source?.postMessage({ type: 'FS_SW_VERSION', version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (!['GET', 'HEAD'].includes(req.method) || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) return;
  // La prueba es una página independiente. Su navegación, redirecciones y
  // segmentos HLS deben ir a la red, sin recibir el shell ni perder rangos.
  if (['/mixer-test', '/mixer-test.html', '/mixer-test.js'].includes(url.pathname) ||
      url.pathname.startsWith('/mixer-demo/')) return;

  // El <audio> puede arrancar dentro del gesto sin esperar a leer toda la
  // biblioteca en memoria. Safari solicita rangos del archivo local elegido.
  if (url.pathname.startsWith('/offline-audio/')) {
    event.respondWith((async () => {
      const cache = await caches.open('freesong-offline-audio-v1');
      const stored = await cache.match(url.pathname);
      if (!stored) return new Response('Audio no disponible en este dispositivo', { status: 404 });
      const blob = await stored.blob();
      const headers = new Headers({
        'Content-Type': stored.headers.get('content-type') || blob.type || 'audio/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      });
      let start = 0;
      let end = blob.size - 1;
      const range = req.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          headers.set('Content-Range', `bytes */${blob.size}`);
          return new Response(null, { status: 416, headers });
        }
        if (!match[1]) start = Math.max(0, blob.size - Number(match[2]));
        else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
        if (start > end || start >= blob.size) {
          headers.set('Content-Range', `bytes */${blob.size}`);
          return new Response(null, { status: 416, headers });
        }
        headers.set('Content-Range', `bytes ${start}-${end}/${blob.size}`);
      }
      headers.set('Content-Length', String(end - start + 1));
      return new Response(req.method === 'HEAD' ? null : blob.slice(start, end + 1), { status: range ? 206 : 200, headers });
    })());
    return;
  }
  if (req.method !== 'GET') return;

  // El HTML pide app.js?v=...; install precarga app.js sin query. Ambas
  // peticiones deben encontrar la misma copia al arrancar sin conexión.
  const cachedShell = async () => {
    const cache = await caches.open(VERSION);
    return (await cache.match(req, { ignoreSearch: true })) ||
      (req.mode === 'navigate' ? cache.match('index.html') : undefined);
  };
  const remember = (res) => {
    if (res && res.status === 200 && res.type !== 'opaque') {
      const copy = res.clone();
      event.waitUntil(caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {}));
    }
    return res;
  };

  // El shell de ESTA versión ya se descargó completo durante install.
  // La actualización es otro worker con otra caché; abrir nunca espera la red.
  event.respondWith(
    cachedShell().then((cached) => {
      if (cached) return cached;
      return fetch(req).then(remember);
    })
  );
});

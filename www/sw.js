// Service worker de FreeSong v3.2.8: Network-First para App Shell (actualización inmediata)
// Las pistas de audio offline viven en 'freesong-offline-audio-v1' y NUNCA se eliminan.
const VERSION = 'freesong-v3.2.8';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
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
          .filter((k) => k !== VERSION && !k.startsWith('freesong-offline-'))
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // No interceptar llamadas de API ni audio offline
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/offline-audio/')) return;

  // ESTRATEGIA NETWORK-FIRST para '/', 'index.html', 'app.js', 'app.css' y navegación
  const isCoreAsset = req.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('index.html') ||
    url.pathname.endsWith('app.js') ||
    url.pathname.endsWith('app.css');

  if (isCoreAsset) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || (req.mode === 'navigate' ? caches.match('index.html') : null)))
    );
    return;
  }

  // Otros activos estáticos (iconos, fuentes): Cache-First con actualización de fondo
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});

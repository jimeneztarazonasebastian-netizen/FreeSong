// Service worker de FreeSong v3.0.0: guarda el app shell para abrirla sin internet.
// Las pistas de audio offline viven en 'freesong-offline-audio-v1' y NUNCA se eliminan.
const VERSION = 'freesong-v3.0.0';
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
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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

  // Páginas: primero la red (para recibir actualizaciones), si falla la copia guardada.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // Archivos de la app: primero la red (así siempre llega la versión nueva);
  // sin conexión, o si la red tarda más de 4 s, se usa la copia guardada.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    });
    if (!cached) return network;
    const slow = new Promise((resolve) => setTimeout(() => resolve(cached), 4000));
    return Promise.race([network.catch(() => cached), slow]);
  })());
});

# FreeSong (Web & iPhone PWA)

Reproductor de música web optimizado para iPhone (iOS) y navegadores modernos, con interfaz fluida y funciones tipo Spotify Premium.

## ✨ Características

- **Diseñado para iPhone**: Instálalo como PWA tocando **Compartir → Agregar a inicio** en Safari. Funciona en pantalla completa con soporte de controles en pantalla de bloqueo (`MediaSession`), reproduce en segundo plano al cambiar de app o bloquear el teléfono (`AudioSession` tipo `playback`) y conserva la cola, la canción y el segundo exacto al volver a abrir la app.
- **Crossfade**: Doble deck HTML en escritorio y dos AVPlayer en el IPA 3.9.30. En Safari/PWA de iPhone y los IPA anteriores permanece deshabilitado. El motor nuevo requiere validación audible en el teléfono.
- **Música y Streaming**: Búsqueda en YouTube Music, streaming y descargas para escuchar sin conexión; disponibilidad sujeta a las fuentes externas.
- **Buscar con contenido real**: cuadrícula de géneros con portadas inclinadas al estilo Spotify, mezclas listas para reproducir e historial, sin pantallas vacías.
- **Letras sincronizadas**: Integración con LRCLIB para cantar con la letra en tiempo real. Puedes compartir el verso que suena como historia 9:16 y cambiar de verso dentro de la vista previa.
- **Herramientas de audio**: Velocidad de reproducción, normalización de volumen y temporizador de apagado.
- **Playlists propias**: crea, renombra y elimina playlists; abre una para ver, quitar o reproducir sus canciones (guardadas solo en tu dispositivo).
- **Atajos de teclado (escritorio)**: `Espacio` reproducir/pausar, `←`/`→` retroceder/adelantar 5 s, `Shift+←`/`Shift+→` canción anterior/siguiente.
- **Datos locales**: Tus favoritos y playlists se guardan en tu dispositivo. FreeSong no incorpora analíticas propias; YouTube, las instancias de audio y los proveedores de letras y portadas reciben las peticiones necesarias para prestar sus servicios.
- **Actualizaciones sin cortes**: cuando hay una versión nueva, la app muestra un aviso y solo recarga al tocar **Actualizar**, para no interrumpir la música.

## 🚀 Despliegue en Vercel

Este repositorio está preconfigurado con `vercel.json` para despliegue automático en 1 clic en [Vercel](https://vercel.com):

1. Conecta este repositorio en Vercel.
2. Pulsa **Deploy** (los archivos se sirven directamente desde `www`).
3. Abre el enlace en tu iPhone y disfrútalo.

## 🛠️ Desarrollo local

La app nativa de Capacitor abre `https://freesong-pied.vercel.app`, para que las rutas
`/api/*` usen el servidor de producción. Requiere conexión para la carga inicial.
Si cambia el dominio, actualiza `server.url` en `capacitor.config.json` y vuelve a
ejecutar `npx cap sync ios` antes de compilar el IPA. La PWA se instala directamente
desde ese mismo dominio.

El IPA 3.9.30 combina interfaz Capacitor con audio nativo AVPlayer, cola y controles
remotos en Swift. Consulta [IOS.md](IOS.md) para instalar la actualización,
renovar la firma gratuita y conocer los límites de verificación en hardware.

```bash
npm install
npm run build   # prepara iconos, fuentes, CSS y JavaScript
npm start       # http://localhost:5173 (sirve www/ y emula las funciones de /api)
npm run icons   # genera iconos PWA/iOS desde assets/icon-source.png
npm run version:check       # verifica app, HTML, worker, health e iOS
npm run version:set -- 3.9.30  # cambia la versión web y las dos configuraciones iOS
```

## ✅ Pruebas automáticas

`npm test` ejecuta pruebas de iconos, versiones, rangos HTTP y las capas de navegador:

- **Unitarias** (`npm run test:unit`): helpers puros de `www/util.js`, lectura segura de `www/storage.js` y parseo de letras de `www/lyrics.js` en Node, sin navegador.
- **Humo** (`npm run test:smoke`): abre Chrome real en modo headless y comprueba buscar, reproducir, avanzar 4 canciones, pausar/reanudar y ver el diagnóstico en Ajustes. No usa internet ni toca tus datos: intercepta `/api/*` y sirve un WAV local.
- **Crossfade** (`npm run test:crossfade`): verifica que durante el fundido la tarjeta y la letra siguen en la canción que suena, y que solo cambian al terminar.
- **Respaldo YouTube** (`npm run test:ytfallback`): simula un vídeo que la instancia solo ofrece como SABR y un proxy caído; comprueba que la app cambia al reproductor de YouTube Web en vez de quedarse cargando.
- **Fin de pista en iPhone** (`npm run test:ios-ended`): emula Safari de iPhone con relay disponible y comprueba que al acabar una canción suena la siguiente en el mismo deck ya desbloqueado, que avanza aunque iOS pierda el evento `ended` y que no salta dos pistas.

Requiere Google Chrome instalado. Usa `playwright-core` con el canal `chrome`, así que no descarga navegadores adicionales.

```bash
npm test                # todas las capas
npm run test:unit       # solo helpers puros
npm run test:smoke      # solo Chrome headless
npm run test:crossfade  # solo regresión del crossfade
npm run test:ytfallback # solo respaldo de YouTube
npm run test:ios-ended  # solo fin de pista en iPhone
```

## 🧩 Estructura del cliente

- `www/app.js`: motor de reproducción, pantallas y estado global.
- `www/util.js`: helpers puros (escapado HTML, miniaturas, mezcla, duración).
- `www/storage.js`: lectura/escritura segura de `localStorage` (datos corruptos o cuota llena).
- `www/lyrics.js`: parseo de LRC y búsqueda de la línea actual.
- `www/diag.js`: métricas locales de reproducción (sin telemetría).
- `www/pwa.js`: registro del service worker y aviso de actualizaciones.
- `www/sw.js`: caché de la PWA y aviso de actualizaciones.

Los módulos se cargan como scripts clásicos antes de `app.js` y exponen un objeto en `window` (`FreeSongUtil`, `FreeSongStorage`, `FreeSongLyrics`, `FreeSongDiag`, `FreeSongPwa`). Así se pueden probar por separado sin bundler y sin tocar el orden de arranque del reproductor.

## 🩺 Diagnóstico local

Ajustes → **Diagnóstico local** muestra reproducciones, tiempo medio de arranque, recuperaciones, pistas saltadas, copias alternativas y paradas. Se guarda solo en `localStorage` (`fs_diag_v1`) en tu dispositivo; no hay telemetría. **Copiar informe** genera un JSON listo para compartir al reportar un fallo.

La lógica vive en `www/diag.js`, separada de `www/app.js` para mantenerla y probarla sin tocar el motor de reproducción. El módulo es opcional: si no carga, la app sigue funcionando sin métricas.

## 🔊 Cómo funciona el streaming

`api/stream.js` resuelve el audio en este orden:

1. **Caché en memoria** de una URL ya resuelta (evita pedir metadatos en cada fragmento).
2. **Relay Invidious** (`api/_relay.js`): pide el vídeo a una instancia con `?local=true`, que resuelve el audio y además lo sirve desde su propia IP. Es la vía que funciona desde Vercel, porque el proxy solo reenvía bytes de la instancia y no toca `googlevideo` directamente.
3. **MWEB con cookie** de YouTube (funciona cuando la IP del servidor no está bloqueada, por ejemplo en local).
4. **HLS armado en memoria** (respaldo histórico).
5. **Clientes nativos** `IOS` / `ANDROID` / `ANDROID_VR` y, si el vídeo original no está disponible, otra publicación de la misma canción.

El proxy sirve fragmentos de 512 KB con soporte de `Range`, así Safari puede saltar y precargar. Las descargas offline piden esos mismos fragmentos uno por uno y los unen en el dispositivo: no chocan con el límite de tamaño de respuesta de Vercel y, si falla un tramo, se reintenta solo ese fragmento. Las resoluciones simultáneas del mismo tema se comparten.

Las descargas verifican la posición y el tamaño de cada rango, incluido un último
fragmento pequeño, y conservan el tipo real de audio (AAC, MP4 o WebM).
Como referencia de selección de formatos se revisó
[SimpMusic](https://github.com/maxrave-dev/SimpMusic) y su módulo
[`core`](https://github.com/maxrave-dev/core/tree/8413a257cbe45d102a9f101f2760e35b549e4d9e).
FreeSong descarta formatos de vídeo sin audio y evita vídeo en descargas de audio.
Los extractores nativos de SimpMusic no se ejecutan en el navegador; la disponibilidad
de cada canción sigue dependiendo de YouTube y del relay configurado.

Las instancias del relay se pueden cambiar sin tocar el código con la variable `INVIDIOUS_INSTANCES` (lista separada por comas). Si tienes tu propia instancia de Invidious con `local: true`, ponla ahí.

### ⚠️ Bloqueo de IP de YouTube

YouTube responde `403` a las descargas de `googlevideo.com` desde las IPs de Vercel (y de casi cualquier nube) aunque la API de player funcione: el bloqueo es por reputación de IP. Por eso el audio viaja por el relay Invidious, que sí puede descargarlo.

La cookie de YouTube (`YOUTUBE_COOKIE`) sigue siendo útil porque evita el `LOGIN_REQUIRED` de la API de player y permite la vía MWEB cuando el servidor no está bloqueado. Para actualizarla:

1. Inicia sesión en YouTube (idealmente con una cuenta de Google secundaria).
2. Exporta las cookies de `youtube.com` con una extensión tipo **Get cookies.txt LOCALLY** (formato `cookies.txt`).
3. Guarda el archivo como `cookies.txt` en la carpeta del proyecto.
4. Ejecuta `node scripts/set-cookie.mjs` (guarda `YOUTUBE_COOKIE` en Vercel sin mostrar la cookie).
5. Ejecuta `vercel --prod --yes` y vuelve a abrir la app.

La cookie caduca si cierras sesión o Google la invalida; en ese caso repite los pasos. Si el relay y la cookie fallan a la vez, la app reintenta dos veces con una resolución nueva y luego usa el motor alternativo de YouTube; si tampoco hay audio, salta a la siguiente canción (máximo 3 fallos seguidos).

## Auditoría y verificación

Consulta [AUDITORIA.md](AUDITORIA.md) para los fallos corregidos, la cobertura de pruebas y las comprobaciones pendientes en iPhone real. `npm run test:pwa` comprueba el primer arranque offline, la conservación de cachés y el uso con almacenamiento bloqueado. GitHub Actions ejecuta la compilación y las pruebas web en cada cambio.

## Arranque rápido (3.9.28)

La PWA abre el shell de la versión instalada desde su caché y comprueba nuevas
versiones en segundo plano. La primera visita necesita red para instalar esa
copia. Las recomendaciones anteriores aparecen inmediatamente y se actualizan
sin vaciar la pantalla. La biblioteca se renderiza al abrir su pestaña.

Solo se preparan en memoria la canción descargada actual y la siguiente; los
otros archivos siguen en Cache API. El worker sirve los rangos de una canción
que se elija antes de estar preparada. Las pruebas cubren reproducción offline,
avance con visibilidad oculta, rangos parciales y apertura con red lenta.

`www/app.js` conserva el código fuente. `npm run js` genera `www/app.min.js`, que
es el archivo cargado por la página. `npm run build`, `npm test` y `npm start`
preparan esa copia automáticamente; después de editar el motor, ejecuta
`npm run js` antes de las pruebas individuales de navegador.

La comprobación de apertura se hace con Chrome automatizado: no es una medición
de rendimiento ni una prueba de bloqueo físico en un iPhone.

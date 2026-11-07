# FreeSong (Web & iPhone PWA)

Reproductor de música web optimizado para iPhone (iOS) y navegadores modernos, con interfaz fluida y funciones tipo Spotify Premium.

## ✨ Características

- **Diseñado para iPhone**: Instálalo como PWA tocando **Compartir → Agregar a inicio** en Safari. Funciona en pantalla completa con soporte de controles en pantalla de bloqueo (`MediaSession`), reproduce en segundo plano al cambiar de app o bloquear el teléfono (`AudioSession` tipo `playback`) y conserva la cola, la canción y el segundo exacto al volver a abrir la app.
- **Crossfade tipo Spotify Premium**: Doble deck de audio con fundido cruzado regulable (0 a 12 segundos) y curvas de volumen en S sin silencios entre canciones.
- **Música y Streaming**: Búsqueda, reproducción completa de YouTube, Audius y tus propios archivos (MP3, M4A, FLAC).
- **Letras sincronizadas**: Integración con LRCLIB para cantar con la letra en tiempo real.
- **Herramientas de audio**: Ecualizador, velocidad (Slowed & Reverb / Nightcore), temporizador de apagado.
- **Playlists propias**: crea, renombra y elimina playlists; abre una para ver, quitar o reproducir sus canciones (guardadas solo en tu dispositivo).
- **Atajos de teclado (escritorio)**: `Espacio` reproducir/pausar, `←`/`→` retroceder/adelantar 5 s, `Shift+←`/`Shift+→` canción anterior/siguiente.
- **100% Privado y Seguro**: Sin anuncios, sin rastreadores, sin analíticas. Tus favoritos y playlists se guardan únicamente en tu dispositivo.
- **Actualizaciones sin cortes**: cuando hay una versión nueva, la app muestra un aviso y solo recarga al tocar **Actualizar**, para no interrumpir la música.

## 🚀 Despliegue en Vercel

Este repositorio está preconfigurado con `vercel.json` para despliegue automático en 1 clic en [Vercel](https://vercel.com):

1. Conecta este repositorio en Vercel.
2. Pulsa **Deploy** (los archivos se sirven directamente desde `www`).
3. Abre el enlace en tu iPhone y disfrútalo.

## 🛠️ Desarrollo local

```bash
npm install
npm run build   # compila Tailwind -> www/app.css
npm start       # http://localhost:5173 (sirve www/ y emula las funciones de /api)
npm run icons   # regenera los íconos PNG desde assets/icon.svg
npm run version:check       # verifica que app, sw y health compartan versión
npm run version:set -- 3.9.6  # actualiza la versión en los cuatro archivos
```

## ✅ Pruebas automáticas

`npm test` ejecuta dos capas:

- **Unitarias** (`npm run test:unit`): helpers puros de `www/util.js`, lectura segura de `www/storage.js` y parseo de letras de `www/lyrics.js` en Node, sin navegador.
- **Humo** (`npm run test:smoke`): abre Chrome real en modo headless y comprueba buscar, reproducir, avanzar 4 canciones, pausar/reanudar y ver el diagnóstico en Ajustes. No usa internet ni toca tus datos: intercepta `/api/*` y sirve un WAV local.

Requiere Google Chrome instalado. Usa `playwright-core` con el canal `chrome`, así que no descarga navegadores adicionales.

```bash
npm test           # unitarias + humo
npm run test:unit  # solo helpers puros
npm run test:smoke # solo Chrome headless
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

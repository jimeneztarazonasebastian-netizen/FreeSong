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
```

## 🔊 Cómo funciona el streaming

`api/stream.js` obtiene la URL directa del audio desde YouTube con los clientes `IOS` y `ANDROID`, y la reenvía con soporte de `Range` para que Safari pueda saltar y precargar. En streaming sirve fragmentos de 512 KB; las descargas offline piden esos mismos fragmentos uno por uno y los unen en el dispositivo, así no chocan con el límite de tamaño de respuesta de Vercel ni pierden la descarga completa si falla un tramo (se reintenta solo ese fragmento). Las resoluciones simultáneas del mismo tema se comparten y las cookies/`visitorData` se guardan en caché para no castigar a YouTube en cada fragmento. Si un fragmento falla, el cliente pide una resolución nueva (`backup`) antes de pasar al motor de YouTube; si todo falla responde `502`.

### ⚠️ Limitación conocida (IP de Vercel)

YouTube bloquea con frecuencia las IPs de los servidores de Vercel ("Sign in to confirm you're not a bot"), en todas las regiones. Por eso, sin configuración adicional, algunas canciones no se reproducen desde el despliegue en la nube. Desde una conexión residencial (por ejemplo `npm start` en tu PC) funciona de forma estable.

La solución que funciona en producción es darle a Vercel una **cookie de una sesión de YouTube iniciada**. El proxy la usa para resolver el audio y YouTube deja de responder con el bloqueo:

1. Inicia sesión en YouTube (idealmente con una cuenta de Google secundaria).
2. Exporta las cookies de `youtube.com` con una extensión tipo **Get cookies.txt LOCALLY** (formato `cookies.txt`).
3. Guarda el archivo como `cookies.txt` en la carpeta del proyecto.
4. Ejecuta `node scripts/set-cookie.mjs` (guarda `YOUTUBE_COOKIE` en Vercel sin mostrar la cookie).
5. Ejecuta `vercel --prod --yes` y vuelve a abrir la app.

La cookie caduca si cierras sesión o Google la invalida; en ese caso repite los pasos. Sin cookie, la app reintenta dos veces con una resolución nueva y luego usa el motor alternativo de YouTube; si tampoco hay audio, salta a la siguiente canción (máximo 3 fallos seguidos).

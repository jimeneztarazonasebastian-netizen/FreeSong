# FreeSong (Web & iPhone PWA)

Reproductor de música web optimizado para iPhone (iOS) y navegadores modernos, con interfaz fluida y funciones tipo Spotify Premium.

## ✨ Características

- **Diseñado para iPhone**: Instálalo como PWA tocando **Compartir → Agregar a inicio** en Safari. Funciona en pantalla completa con soporte de controles en pantalla de bloqueo (`MediaSession`).
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

`api/stream.js` obtiene la URL directa del audio desde YouTube con los clientes `IOS` y `ANDROID`, y la reenvía con soporte de `Range` para que Safari pueda saltar y precargar. En streaming sirve fragmentos de 512 KB; con `full=1` entrega la pista completa (lo usan las descargas offline). Si todo falla responde `502`.

### ⚠️ Limitación conocida

YouTube bloquea con frecuencia las IPs de los servidores de Vercel ("Sign in to confirm you're not a bot"), en todas las regiones. Por eso algunas canciones pueden no reproducirse desde el despliegue en la nube (en pruebas, 4 de 6). Cuando pasa, la app reintenta, avisa con un mensaje y salta a la siguiente (máximo 3 saltos seguidos). Desde una conexión residencial (por ejemplo `npm start` en tu PC) funciona de forma estable. La solución definitiva requiere resolver el audio desde el propio dispositivo o usar un proxy con IP residencial.

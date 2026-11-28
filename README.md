# FreeSong

Reproductor web de música instalable en iPhone como PWA. Incluye búsqueda,
biblioteca local, listas, letras sincronizadas, descargas opcionales y cola
con crossfade. [Abrir FreeSong](https://freesong-pied.vercel.app)

En iPhone, abre la web en Safari y toca **Compartir → Agregar a inicio**. La
PWA puede iniciar una mezcla HLS con el primer toque de reproducción cuando
Crossfade está activado y la cola es compatible. El IPA usa la misma
interfaz web con audio nativo AVPlayer. [Descargar IPA](https://freesong-pied.vercel.app/FreeSong.ipa)
· [Instalación y firma del IPA](docs/ios.md)

- **Cola y reproducción**. Desliza una canción para ponerla de siguiente.
  Cuando el flujo HLS ya publicó la transición, la app la añade tras el
  bloque activo. En iPhone, iOS administra los controles y la Isla Dinámica.
- **Biblioteca**. Las listas, los favoritos y las descargas viven en el
  dispositivo. La importación opcional de YouTube copia listas y Me gusta
  a la biblioteca. [Configurar la importación](docs/operacion.md#importación-opcional-de-youtube)
- **Escucha y diagnóstico**. Letras de LRCLIB, velocidad de reproducción,
  ajuste de volumen y temporizador. Desde **Ajustes → Diagnóstico local**
  puedes exportar un informe para revisar fallos de audio.
- **Atajos de escritorio**. Espacio para reproducir o pausar, flechas para
  avanzar o retroceder 5 s, Mayús + flechas para cambiar de pista.

## Desarrollo

GitHub Actions usa Node.js 24. Las pruebas de navegador requieren Chrome.
La prueba de mezcla también requiere FFmpeg en el PATH o en `FFMPEG_PATH`.

```bash
npm ci
npm run build
npm start
npm test
npm run test:mixer
```

`npm start` sirve el cliente y emula las rutas API en
`http://localhost:5173`. `npm test` verifica versiones, integración, lógica
y flujos en Chrome con fuentes simuladas. `npm run test:mixer` comprueba
la salida HLS con FFmpeg. Consulta `npm run` para ejecutar un grupo o
una prueba de navegador por separado.

`npm run build` genera CSS, JavaScript minificado, iconos y fuentes. El
código fuente del motor vive en `www/app.js` y la web carga
`www/app.min.js`. `npm run version:check` comprueba la versión web y
iOS. Para cambiarla, usa `npm run version:set -- X.Y.Z` y vuelve a compilar.

## Estructura

| Ruta | Contenido |
| --- | --- |
| [www/](www/) | Cliente web, PWA, diagnósticos y archivos publicados |
| [api/](api/) | Funciones Vercel de catálogo, audio y puente HLS |
| [services/mixer/](services/mixer/) | Mezclador FFmpeg y servicio HLS de Render |
| [ios/](ios/) | Proyecto Xcode, motor Swift, puente Capacitor y pruebas de audio nativo |
| [src/](src/) y [assets/](assets/) | Estilos fuente e imágenes originales |
| [scripts/](scripts/) | Build, servidor local, versiones y tareas de operación |
| [tests/](tests/) | Pruebas unitarias, integración y navegador |
| [docs/](docs/) | Guías vigentes, auditoría e historial |

## Estado y publicación

La rama `main` se publica automáticamente en Vercel. El mezclador corre en
Render y el IPA se compila en GitHub Actions. [Operación y configuración](docs/operacion.md)

La cobertura de canciones depende de las fuentes y falta completar la prueba
física de 30 minutos con el iPhone bloqueado. [Auditoría 3.9.56](docs/auditoria.md)
· [Pendientes vigentes](PENDIENTES.md) · [Informes anteriores](docs/historial/)

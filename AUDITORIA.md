# Auditoría de FreeSong — 14 de noviembre de 2026

Versión revisada: 3.9.26. Prioridad: PWA instalada desde Safari con «Agregar a inicio».

## Alcance y conclusión

Se revisaron el motor de reproducción, cola, recuperación, controles, descargas,
persistencia, renderizado de metadatos, service worker, rutas API, dependencias,
configuración de Vercel y proyecto iOS. Se hicieron correcciones y pruebas
automatizadas. Esto no equivale a certificar todas las canciones, dispositivos o
versiones de iOS; no había un iPhone físico conectado para bloquearlo realmente.

La historia verificada es: elegir una canción → resolver el audio → reproducir
en un elemento HTML de audio → conservar la posición al ocultar la página →
avanzar al siguiente tema en ese mismo elemento. Las pruebas de iPhone utilizan
Chrome con identificación de iPhone y visibilidad simulada; no son Safari/iOS.

## Hallazgos corregidos en esta revisión

| Prioridad | Hallazgo | Corrección |
| --- | --- | --- |
| Alta | Una resolución tardía del relay cambiaba `src` después de bloquear. | Se conserva la fuente en marcha; se guarda el enlace resuelto para reutilizarlo. |
| Alta | Una recuperación iniciada en primer plano podía continuar tras bloquear o cambiar de canción. | Se vuelve a comprobar pista, reproductor, pausa y visibilidad tras las esperas. |
| Alta | La pausa remota dependía de un fundido con temporizadores. | En iOS y segundo plano se pausa inmediatamente. |
| Alta | Cada consulta de «siguiente» en aleatorio sorteaba otra pista. | Se mantiene una elección hasta el siguiente cambio de pista; precarga y avance coinciden. |
| Alta | El shell offline precargaba nombres sin query, pero el HTML pedía archivos versionados. | Se permite encontrar la copia precargada ignorando la query. |
| Alta | Datos de miniaturas, identificadores, artistas similares y duraciones se insertaban sin escapar en varias vistas. | Se aplica escapado en esos atributos y textos. |
| Media | El worker podía borrar cachés ajenas a FreeSong. | Solo se eliminan shells antiguos de FreeSong; se conserva audio offline. |
| Media | Un error HTTP 5xx podía reemplazar el arranque por una respuesta fallida. | El shell disponible en caché sirve de respaldo. |
| Media | Escrituras o lecturas de preferencias podían lanzar errores por almacenamiento bloqueado. | Se usan funciones seguras para preferencias, banner y recordatorio de copia. |
| Media | Arrays JSON válidos con entradas nulas o incompletas rompían biblioteca y restauración. | Se validan pistas, playlists y búsquedas antes de usarlas. |
| Media | Una copia JSON podía marcar canciones como descargadas aunque no contenía audio. | Solo se recuperan esas marcas si existe una copia local; se descartan registros sin archivo al arrancar. |
| Media | Una respuesta antigua de recomendaciones podía modificar una cola nueva. | Se comprueba la identidad de la cola y cancelación antes de añadir pistas. |
| Media | Una promesa rechazada de reproducción anterior podía apagar el estado de la nueva. | Se comprueba la pista y el reproductor antes de aplicar el error. |
| Media | El temporizador de apagado restaba un segundo por callback, acumulando retraso al suspenderse. | Se calcula el tiempo restante desde una hora límite; se aplica al siguiente callback que iOS permita. |
| Media | Seis avisos moderados en dependencias de herramientas. | Se actualizó el lockfile con versiones compatibles; `npm audit` quedó sin avisos. |
| Media | El servidor local no reflejaba en `req.url` el rewrite de relay-info y admitía nombres arbitrarios de módulo. | Se conserva la query reescrita y se valida el nombre de ruta. |
| Media | La sesión nativa de audio combinaba la categoría playback con opciones de grabación. | Se configura playback sin esas opciones. Requiere compilación y prueba nativa. |
| Media | La compilación IPA usaba macOS 14, retirado de GitHub Actions. | Se actualiza a macOS 26, Node 24 y `npm ci`; también se vigilan cambios de lockfile y configuración. |
| Media | No había una comprobación automática web en cada cambio del repositorio. | Se añade una tarea de GitHub Actions para build, pruebas y auditoría de dependencias de producción. |
| Baja | El diagnóstico anunciaba «Todo en orden» aunque solo verificaba búsqueda y configuración. | Ahora indica «Búsqueda disponible» y aclara que el audio se comprueba al reproducir. |
| Baja | El respaldo de YouTube creaba un iframe innecesario en iOS y el script externo bloqueaba el parser. | No se crea ese reproductor en iOS; el script externo se carga de forma asíncrona. |

## Comprobaciones

- `npm test`: utilidades, almacenamiento, letras, formatos de stream, búsqueda,
  reproducción, varios avances, pausa/reanudación, crossfade, respaldo YouTube,
  fin de pista, visibilidad simulada, descargas, diagnóstico y PWA.
- `test-ios-ended`: tres avances con la página oculta, mismo elemento de audio,
  fin sin evento `ended`, ausencia de doble salto y coincidencia con precarga aleatoria.
- `test-ios-background`: relay que responde después de ocultar la página,
  preservación de fuente y posición, recuperación al volver y pausa síncrona.
- `test-download`: integridad byte a byte, último rango de 44 bytes, formato de
  audio conservado y metadatos manipulados que no deben ejecutar HTML.
- `test-pwa`: primer arranque sin red usando únicamente el shell precargado,
  archivos versionados, cachés ajenas y audio conservados, almacenamiento denegado.
- `npm run build`, `git diff --check`, `node --check` y `npm audit`.
- Los archivos locales de cookies y variables de entorno no están versionados.

## Límites y riesgos que siguen abiertos

1. **Bloqueo físico pendiente.** Ocultar una página en Chrome no reproduce la
   suspensión de procesos, política de autoplay ni gestión de energía de iOS.
   No se puede prometer continuidad garantizada con estas pruebas solamente.
2. **Disponibilidad externa.** Hay una sola instancia de relay por defecto.
   YouTube, cookies, CAPTCHA, CORS y disponibilidad de la instancia pueden impedir
   canciones concretas. Los respaldos no constituyen una garantía del catálogo.
3. **Corte de red bloqueada.** Una recuperación que requiere otra fuente se
   conserva para el retorno a primer plano. Si iOS rechaza reabrir audio sin gesto,
   puede ser necesario tocar reproducir. No se sustituye por un iframe en iPhone.
4. **Almacenamiento del sistema.** iOS puede desalojar cachés; una copia JSON no
   incluye los archivos de audio. Grandes bibliotecas offline requieren medición
   de memoria en iPhone, porque actualmente se preparan sus blobs al arrancar.
5. **Servicios públicos.** Las API de búsqueda y audio son públicas y consumen
   recursos. No se añadió un servicio externo de límites por IP ni se activaron
   opciones de pago del proveedor. Conviene vigilar consumo y disponibilidad.
6. **IPA y hardware.** No se ha ejecutado Xcode en este equipo Windows ni se han
   probado llamadas, AirPlay, Bluetooth, CarPlay, ahorro de batería o salidas de audio.
7. **Mantenibilidad.** `app.js` concentra más de ocho mil líneas. Separar motor,
   biblioteca y vistas facilitará futuras correcciones; hacerlo ahora requeriría
   una migración adicional y otra ronda de verificación.

## Prueba final en el iPhone del usuario

1. Abrir la PWA con red y aplicar la actualización 3.9.26.
2. Iniciar una cola de al menos cuatro canciones y esperar a que la primera suene.
3. Bloquear y dejar pasar tres cambios completos sin volver a abrir la PWA.
4. Probar pausa, reanudación y siguiente desde la pantalla bloqueada.
5. Repetir con canciones descargadas en modo avión.
6. Si se corta, desbloquear y exportar Ajustes → Diagnóstico local → Copiar informe;
   anotar modelo, versión de iOS y si el corte fue durante una pista o al cambiar.

## Referencias técnicas

- [Apple: configuración de reproducción multimedia](https://developer.apple.com/documentation/avfoundation/configuring-your-app-for-media-playback)
- [Capacitor: requisitos de entorno y Xcode](https://capacitorjs.com/docs/getting-started/environment-setup)
- [GitHub: imágenes de ejecutores y retirada de macOS 14](https://github.com/actions/runner-images)

La disponibilidad del catálogo y la continuidad en un iPhone físico permanecen
condicionadas a las comprobaciones anteriores. Una auditoría y una batería de
pruebas no permiten demostrar ausencia absoluta de errores.

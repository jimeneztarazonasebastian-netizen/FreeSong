# Auditoría de FreeSong — 14 de noviembre de 2026

Registro de versiones 3.9.27 a 3.9.30. Consulta la
[auditoría vigente](../auditoria.md) para el estado actual.

Revisión más reciente: **15 de noviembre de 2026, v3.9.29**, documentada al final.

Versión revisada: 3.9.27. Prioridad: PWA instalada desde Safari con «Agregar a inicio».

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
| Alta | Un error definitivo al arrancar una pista oculta dejaba la cola esperando al desbloqueo. | Se salta la pista en el mismo evento, con límite de fallos consecutivos; los cortes de una pista avanzada conservan su posición. |
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

## Verificación externa

El despliegue 3.9.26 del commit `203a1af` terminó en estado READY y sirvió esa
versión desde el dominio de producción. Las tareas web e IPA de ese commit
terminaron correctamente en GitHub Actions. Para 3.9.27 se repiten las tareas
tras subir el ajuste final de errores al arrancar en segundo plano.

Con audio real de producción e identificación de iPhone, Chrome reprodujo
«Candy», «Fanática Sensual» y «El Teléfono» en `audioA`, sin crear iframes de
YouTube. Se ocultó la página de forma simulada y se adelantó al final de cada
pista después de dejar trabajar la precarga. No se dejó sonar cada canción
completa ni se bloqueó un iPhone físico. Una prueba más agresiva que adelantó
las canciones antes de completar la precarga agotó el tiempo de espera en el
segundo avance; también se observaron 502 de fuentes de audio. Esto motivó el
ajuste final para saltar errores terminales de arranque, y confirma que no debe
prometerse disponibilidad universal del proveedor.

## Límites y riesgos que siguen abiertos

1. **Bloqueo físico pendiente.** Ocultar una página en Chrome no reproduce la
   suspensión de procesos, política de autoplay ni gestión de energía de iOS.
   No se puede prometer continuidad garantizada con estas pruebas solamente.
2. **Disponibilidad externa.** Hay una sola instancia de relay por defecto.
   YouTube, cookies, CAPTCHA, CORS y disponibilidad de la instancia pueden impedir
   canciones concretas. Los respaldos no constituyen una garantía del catálogo.
3. **Corte de red bloqueada.** Un error definitivo antes de arrancar puede saltarse para continuar la cola. Una recuperación a mitad de canción que requiere otra fuente se
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

1. Abrir la PWA con red y aplicar la actualización 3.9.27.
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

## Actualización de rendimiento — 15 de noviembre de 2026, v3.9.28

- Shell de la versión instalada servido desde caché; las actualizaciones se
  comprueban en segundo plano y la recarga sigue siendo una decisión del usuario.
- Inicio persistido con recomendaciones previas mientras llega la actualización.
- Preparación de audio limitada a actual/siguiente; la lectura de toda la
  biblioteca al arrancar, descrita en el riesgo 4 de la auditoría, se eliminó.
- Audio local con Range, HEAD y respuesta 416 servido por el service worker.
- YouTube solo se carga si se requiere su respaldo en escritorio, nunca al abrir
  la PWA en iPhone. La precarga de red se limita a dos candidatos.
- Biblioteca renderizada al abrir la pestaña; archivo principal minificado.
- Prueba añadida: 30 descargas, solo dos lecturas iniciales, reproducción de una
  tercera no preparada y paso a la siguiente con la página oculta y sin red.
- Prueba añadida: shell abierto en menos de cuatro segundos con ocho segundos de
  latencia de red simulada. Los tiempos medidos son de Chrome en el equipo de
  prueba, no del iPhone del usuario.

La continuidad real de iOS y la disponibilidad de proveedores siguen teniendo
los límites descritos en esta auditoría. Estas mejoras no convierten la PWA en
un reproductor nativo ni eliminan la firma necesaria para instalar un IPA.

## Revisión del IPA y controles — 15 de noviembre de 2026, v3.9.29

### Evidencia y alcance

El usuario instaló el IPA 3.9.28 mediante AltStore y confirmó que abre, reproduce
con el iPhone bloqueado y pasa de canción. Su captura muestra el botón de play
mientras informa que el audio sigue sonando. Es evidencia de una desincronización
visual; no demuestra que se hayan probado todas las interrupciones o canciones.

Se revisaron los eventos de ambos decks, MediaSession, transición de cola,
pausa/reanudación, selección de fuentes, rangos del proxy, descargas, caché y
persistencia, endpoints de catálogo/importación/letras/diagnóstico, dependencias,
assets, versiones y compilación iOS. Las pruebas cubren el flujo interfaz → API
simulada → audio → avance/controles → persistencia. La verificación del proveedor
real se distingue de las pruebas aisladas; no se considera fiable una fuente
solo por tener una URL configurada.

### Hallazgos corregidos

| Hallazgo | Corrección y evidencia |
| --- | --- |
| El estado de bloqueo podía quedar en pausa aunque el audio continuara. | Se sincroniza MediaSession con paused/ended del deck activo en timeupdate, cambios de visibilidad, seek y velocidad. La prueba que fuerza el estado incorrecto fallaba antes del cambio y ahora pasa sin reiniciar la fuente. |
| Eventos play/playing/pause encolados podían llegar después de pausar o cambiar de deck. | Se comprueba el deck y su estado real antes de modificar la sesión; la prueba verifica que un playing tardío no anula una pausa del usuario. |
| Una portada inválida o una acción remota no soportada podía impedir registrar los controles restantes. | Se filtran URLs de portada y se registra cada acción por separado; prueba de pausa, reanudación y seek remotos con una acción no soportada. |
| Los rangos de sufijo del proxy no se respetaban; el respaldo AAC volvía al byte cero ante un rango fuera de archivo. | Parser estricto y acotado, sufijos, HEAD, rango explícito en full=1 y 416 sin cambiar de fuente. La ruta completa se comprueba con upstream simulado. |
| El icono nativo era el genérico de Capacitor y no participaba en la generación de iconos web. | Fuente nueva generada con IA, morado–azul, derivada para PWA/iOS en cada build. Se validan dimensiones, opacidad e igualdad del AppIcon con el original derivado de 1024 px. |
| iOS seguía anunciando versión 1.0 aunque la web avanzara. | version.mjs verifica y actualiza también Debug/Release; el número de compilación del IPA usa el número de ejecución de Actions. |
| README anunciaba Audius, archivos personales y ecualizador sin una implementación disponible. | Se describen únicamente las funciones existentes y se aclara que el crossfade se desactiva en iPhone para conservar el deck autorizado. |

### Validación y límites

- `npm run build`: iconos, fuentes, CSS y JavaScript minificado.
- `npm test`: versiones e iconos; formatos y rangos; utilidades, almacenamiento y
  letras; búsqueda/reproducción/cola, crossfade, respaldo YouTube, errores ocultos,
  recuperación y controles remotos, descargas, diagnóstico y PWA offline/red lenta.
- `npm audit --json`: cero vulnerabilidades detectadas en dependencias de esta
  instalación al revisar. No equivale a ausencia de fallos de aplicación.
- `git diff --check` y sintaxis JavaScript antes de publicar.
- No se reescribió el motor de audio como AVPlayer. El IPA sigue siendo híbrido.
  Véase la [guía de iPhone](../ios.md) para arquitectura, renovación gratuita y migración nativa.
- Una única instancia de relay continúa siendo un punto de dependencia externo.
  No se añadieron instancias públicas desconocidas ni servicios de pago.
- La corrección visual debe volver a comprobarse en la pantalla bloqueada del
  iPhone del usuario. Las pruebas automatizadas son Chrome, no un dispositivo iOS.

### Prueba después de actualizar

Aplicar la actualización web 3.9.29 con la música detenida. El icono nuevo del
escritorio requiere instalar el IPA 3.9.29 sobre la app existente. Confirmar que
el botón de bloqueo muestra pausa mientras suena, play al pausarlo y que funcionan
reanudar, seek y siguiente. Dejar sonar varias canciones completas bloqueado y
repetir sin red con descargas. Si falla, conservar/exportar el diagnóstico local;
no borrar la aplicación como primer paso.

## Motor nativo y diagnóstico recibido — 15 de noviembre de 2026, v3.9.30

El informe del usuario registra seis reproducciones con 4,6 s de arranque medio,
errores 502 del proxy y una descarga fallida. En una pista los metadatos anuncian
191 s y el archivo reproduce 380,975 s. La captura muestra play aunque el usuario
informa audio audible. El registro relay-alt reutilizaba el ID original: no era
una alternativa efectiva. El crossfade estaba expresamente deshabilitado en iOS.

### Cambios

- Motor Swift con dos AVPlayer, cola, precarga y crossfade de ganancias de potencia
  constante. El avance y el fundido no dependen de temporizadores JavaScript.
- Now Playing recibe tiempo, duración y velocidad reales del AVPlayer activo.
  Los comandos remotos de reproducción, pausa, seek y cambio usan el mismo motor.
  El diseño concreto de Dynamic Island continúa siendo responsabilidad de iOS.
- Adaptador Capacitor con identificación de solicitudes, rechazo de respuestas
  antiguas y reconciliación al volver a primer plano. El motor HTML y MediaSession
  no compiten con el nativo. Los IPA anteriores conservan su motor HTML.
- Archivos offline en Application Support; migración por pista de Cache API y
  eliminación sincronizada. Los datos de biblioteca conservan su origen web.
- Resolver Swift valida bytes/MIME, formato AAC y duración antes de reproducir;
  busca una publicación compatible y caduca/invalida URLs. Sigue dependiendo del
  relay/proxy existente; no se incorporó un extractor Kotlin de SimpMusic.
- Web: duración real autoritativa, caché rota invalidada, alternativa con ID
  distinto y vigilancia de audio detenido en 0:00. El ajuste explica la falta de
  crossfade en PWA/IPA antiguo de iPhone y se habilita con el plugin nativo.
- Assets con versión usan caché HTTP prolongada. App Bound Domains permite caché
  de interfaz en WKWebView, manteniendo el dominio y los datos de la instalación.

### Evidencia y límites

La primera compilación Xcode y tres pruebas Swift de políticas pasaron en Actions
43757397887. La revisión final añade pruebas Swift con URLProtocol: bytes reales,
caché/invalidation, 403, duración incompatible y HTML que responde 200. Las pruebas
JS cubren el adaptador, una interfaz con puente simulado, cambios de cola, controles,
duración y recuperación real del flujo web ante fuentes simuladas rotas.

Estas pruebas y una compilación correcta no demuestran crossfade audible, apertura
más rápida ni presencia continua en Dynamic Island en el teléfono físico. Hace
falta instalar el nuevo IPA y medirlo allí. La carga inicial todavía requiere red;
la disponibilidad de canciones sigue condicionada a proveedores externos. Los
capítulos anteriores describen las versiones históricas y no son una declaración
de la arquitectura de 3.9.30. El protocolo de prueba está en la [guía de iPhone](../ios.md).

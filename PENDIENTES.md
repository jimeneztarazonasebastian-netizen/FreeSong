# Pendientes y mejoras de FreeSong

Auditoría actualizada el 23 de noviembre de 2026 para la versión web **3.9.49**.
La auditoría original partió del commit `35db606`.

Este documento reúne lo que falta por hacer, lo que se revisó en el proyecto
[OpenTune](https://github.com/justshivv/Opentune) y los límites que no conviene
cruzar. No es una lista de deseos: cada punto indica qué existe hoy, qué falta y
cómo se comprueba.

---

## 1. Estado actual verificado

- La app web es una PWA en `www/` servida por Vercel; el IPA es Capacitor +
  motor nativo Swift con dos `AVPlayer` (`ios/App/App`).
- La reproducción del IPA ya no depende del `<audio>` del WebView: la cola, la
  precarga, el crossfade y los controles remotos viven en Swift.
- El resolver nativo (`AudioSourceResolver.swift`) resuelve en el dispositivo,
  prueba bytes reales y acepta relay, proxy y una respuesta directa de Innertube.
- El proxy `/api/stream` sirve por rangos; las descargas piden fragmentos y los
  unen en el dispositivo.
- Hay 12 rutas API desplegadas, el máximo del plan gratuito de Vercel:
  `health`, `explore`, `artist`, `album`, `search`, `queue`, `playlist`,
  `lyrics`, `import`, `home`, `suggestions`, `stream`. `_hls`, `_yt`, `_relay`
  y `_mixer` son módulos compartidos, no rutas.
- El mezclador HLS de Render entregó las grabaciones exactas de «Stereo Love» y
  «Fanática Sensual» desde el relay europeo. La mezcla de 9:16 incluyó un fundido
  de seis segundos. La PWA avanzó entre las canciones en Chrome con perfil de
  iPhone, página oculta y un decodificador HLS de prueba. El control con Audius
  también funcionó. [Revisión del mezclador en producción](https://github.com/jimeneztarazonasebastian-netizen/FreeSong/commit/5265a20)
- La PWA incluye búsqueda de Audius, gestos de cola y reproducción HLS en
  **Siguiente** por bloques de hasta tres pistas.
- La PWA espera a que Render responda antes de crear una sesión de mezcla. Las
  pruebas cubren una respuesta temporal `503`, cancelar durante el arranque y
  crear una sola sesión cuando el servidor ya está listo.
- Con Crossfade activo en la PWA instalada en iPhone, el primer toque puede
  abrir directamente el flujo HLS. El arranque de Render y la codificación
  ya no necesitan una llamada posterior a `play()` desde la página. Si el
  flujo no arranca, se vuelve al audio normal de la canción.
- Radio y Similares comparten las recomendaciones de la pista en reproducción.
  La cola automática evita añadir versiones repetidas y favorece afinidades de
  artistas y álbumes sin cambiar el orden elegido por el usuario.
- Inicio y Buscar comparten la consulta predeterminada en curso. El shell de
  la PWA usa una sola copia del HTML y las portadas provisionales reutilizan
  el icono que ya está cargado.
- Se añadió el importador opcional de listas y Me gusta de YouTube. La prueba
  web simula Google y verifica el consentimiento, la importación, el reemplazo
  de una copia repetida y la revocación sin cambiar el audio que está sonando.
  La activación real depende de `YOUTUBE_OAUTH_CLIENT_ID` y del cliente externo
  de Google. Los pasos de configuración están en [README.md](README.md).

---

## 2. Prioridad P0 — reproducción y validación real

### 2.1 Validar la PWA y el IPA en un iPhone físico

Pruebas pendientes para la PWA instalada y Safari:

- Tocar «Stereo Love» y bloquear inmediatamente, antes del primer segmento.
  Con «Fanática Sensual» de siguiente, comprobar el fundido, el título, la
  portada y los controles en la pantalla bloqueada.
- Repetir en Wi-Fi y datos móviles. Probar una mezcla después de un periodo de
  inactividad de Render y al deslizar una pista para ponerla de siguiente.
- Verificar la Isla Dinámica, la barra inferior, el teclado al buscar y el
  reproductor en vertical y horizontal con texto ampliado.
- Cuando esté habilitada la cuenta de YouTube, probar la ventana de Google
  desde la PWA instalada. Importar una lista y Me gusta, reimportar la lista
  para comprobar que no se duplica y desconectar para retirar las copias.

Pruebas pendientes para el IPA:

- 30 minutos con la pantalla bloqueada y al menos 10 cambios de pista.
- Pausa, reanudación, siguiente y seek desde la pantalla bloqueada.
- Modo avión con pistas descargadas, incluido relanzar la app.
- Llamada entrante, auriculares/Bluetooth y AirPlay.
- Exportar el diagnóstico y confirmar `engine: avplayer`, versión del paquete y
  versión de iOS.

Referencia: `IOS.md` y `PLAN-RECUPERACION-Y-NATIVO.md` (fases 2 y 3).

### 2.2 Diagnóstico del IPA completo y legible

El diagnóstico web ya exporta JSON. Falta confirmar que el IPA añade:

- Motor real (`avplayer` frente a motor web).
- Versión del paquete, versión de la interfaz y versión de iOS.
- Errores de `AVPlayerItem`, interrupciones, cambios de ruta de audio y rechazos
  de reproducción.
- Nunca cookies, credenciales ni URLs firmadas completas.

### 2.3 Fuentes de audio: el problema SABR/502 no está resuelto

Situación medida el 21 de noviembre de 2026 desde una red de este equipo:

| Cliente de Innertube | Resultado |
| --- | --- |
| `IOS` 21.26.4 y 21.29.1 | `OK`, pero solo SABR (sin URL directa) |
| `ANDROID_VR` 1.65.10 | `LOGIN_REQUIRED` |
| `ANDROID_MUSIC`, `TVHTML5`, `WEB` | `LOGIN_REQUIRED` o `UNPLAYABLE` |

Conclusión: recorrer clientes ya no basta. YouTube exige cada vez más tokens PO
(BotGuard) o firma de URL. OpenTune lo resuelve con tokens PO en Android y
NewPipeExtractor, pero es código GPL, específico de Android y frágil. **No se
porta por ahora.**

Trabajo pendiente, por orden:

1. Usar HLS cuando el cliente lo entregue (ver 3.1).
2. Repetir desde Render con una muestra variada y comparar con Wi-Fi y datos
   móviles. La prueba de dos canciones ya confirma la ruta directa para ese caso.
3. Conservar la cookie de YouTube como vía MWEB cuando la IP no esté bloqueada.
4. Medir con una lista fija de 20 pistas variadas: primer byte, seek, URL
   caducada y fallo explícito, en Wi-Fi y datos móviles, repetido otro día.

### 2.4 Autorización del catálogo antes de distribuir el proyecto

- Identificar al proveedor y documentar los permisos aplicables a cada catálogo.
  Revisar reproducción pública bajo demanda, mezcla o retransmisión desde Render,
  descargas y uso de portadas y letras. Los permisos sobre la grabación y la obra
  musical deben cubrir el uso previsto. [Términos de YouTube](https://www.youtube.com/t/terms) · [Políticas para sus API](https://developers.google.com/youtube/terms/developer-policies) · [Licencia de Audius](https://openaudiofoundation.org/open-music-license.pdf)
- Confirmar con el proveedor que el acceso y el volumen de tráfico previstos
  estén autorizados. El operador del relay documenta límites en su API pública y
  una respuesta de audio válida solo demuestra que la ruta técnica funciona.
  [Condiciones del relay](https://www.chocolatemoo53.com/faq/)
- Definir el catálogo que se incluirá al publicar y verificar licencias del código
  y de los recursos visuales que se entreguen.

---

## 3. Prioridad P1 — fiabilidad del IPA y de la PWA

### 3.1 Fallback HLS en el resolver nativo

`resolveOnDevice` solo acepta `audio/mp4` con `url`. YouTube a veces devuelve
`hlsManifestUrl` y `AVPlayer` reproduce HLS de forma nativa.

- Cambio: si no hay formato AAC con URL, usar `hlsManifestUrl` como fuente.
- Verificado: algunos vídeos sí traen HLS; otros no. Es una mejora parcial, no
  una solución universal.
- Prueba: canción con HLS + pausa/seek + pantalla bloqueada.

### 3.2 Sesión de audio y rutas

- `AVAudioSession` usa `.playback` y `.default`; valorar añadir
  `policy: .longFormAudio`.
- Las interrupciones y el cambio de ruta ya se manejan; falta probarlas en
  hardware (llamada, auriculares, Bluetooth, AirPlay).
- Revisar que `MPNowPlayingInfoCenter` actualice posición y velocidad al
  pausar, reanudar y buscar.

### 3.3 Descargas nativas en segundo plano

Hoy las descargas se piden por rangos y luego se importan al almacenamiento
nativo; no hay un gestor iOS en segundo plano.

- Usar `URLSession` en segundo plano, trozos de ~2 MB y archivo `.part`.
- Reanudar tras cierre, comprobar integridad y tamaño, y calcular espacio libre.
- Migrar las descargas antiguas sin perder favoritos ni playlists.
- Nota: YouTube limita a velocidad de reproducción una descarga pedida en una
  sola petición; el troceado no es opcional.

### 3.4 Normalización de volumen por pista

Hoy se usa una ganancia fija. YouTube entrega `loudnessDb` en la respuesta del
reproductor; usarlo da una nivelación real y evita subir o bajar canciones a
mano.

### 3.5 Caducidad y errores de fuente

- Un 403 debe invalidar la URL y resolver una vez más.
- Distinguir canción no disponible, login requerido, formato incompatible y
  fallo de red, con mensajes distintos.
- No sustituir una canción por otra sin comprobar identidad y duración.

### 3.6 Disponibilidad de los relays

La PWA prueba el relay europeo y conserva el anterior como respaldo. Comprueba
un rango de audio antes de recordar la fuente. En el navegador se verificaron
las publicaciones exactas de «Stereo Love» y «Fanática Sensual» en el relay
europeo. Falta ampliar la muestra en Render y repetir las pruebas con Safari,
Wi-Fi y datos móviles.

### 3.7 Diseño adaptable y accesibilidad

- Revisar Inicio, Buscar, Biblioteca, Siguiente, Reproductor y Ajustes en pantallas
  estrechas, horizontal y escritorio. Medir desbordamiento de la página y
  verificar que los controles sigan al alcance con nombres largos y texto ampliado.
- En iPhone físico, comprobar el área segura alrededor de la Isla Dinámica y el
  indicador de inicio. Repetir la búsqueda con teclado abierto y recorrer los
  controles con VoiceOver.
- Pasar `npm run build` y `npm test` al preparar una publicación. La CI comprueba
  que el CSS y el JavaScript generados coincidan con los archivos del repositorio
  que se publican.

---

## 4. Prioridad P2 — producto

### 4.1 Letras multifuente

Hoy solo LRCLIB (`api/lyrics.js`). OpenTune usa LRCLIB + KuGou + NetEase +
Unison + subtítulos del vídeo, con offset por canción y palabra por palabra.

- Implementar clientes propios (sin copiar código GPL).
- Añadir offset por canción y medir cobertura en español.
- Mantener el texto plano como último recurso.

### 4.2 Crossfade

- Validar curvas equal-power y duraciones mínima/intermedia/máxima en el IPA.
- Con Crossfade activado, la PWA del iPhone prepara una mezcla al iniciar la
  cola. Mientras Render carga, el reproductor normal sigue sonando. La PWA
  cambia al HLS en la misma posición cuando Safari lo acepta en primer plano.
  Si el teléfono se bloquea antes de que esté lista, continúa la reproducción
  normal y se reintenta el cambio cuando la PWA vuelve a estar visible.
- Completar una prueba con Safari en un iPhone físicamente bloqueado antes de
  anunciar el fundido en segundo plano como verificado.

### 4.3 Mezclador HLS experimental (Render)

Render Free y el puente de Vercel están operativos. La revisión `5265a20`
incorporó el relay europeo como fuente directa. Producción devolvió ambas fuentes
como `relay-eu` y entregó 140 segmentos de la mezcla completa. El relay y el
proxy siguen sujetos a la disponibilidad de cada pista. La prueba cruzada
confirmó el control Audius.

- Validar en un iPhone bloqueado la demostración HLS de dos tonos en
  `/mixer-test.html`. Esta prueba separa la reproducción en Safari de los
  problemas de las fuentes de canciones.
- Medir tiempo al primer segmento con Render recién iniciado, CPU y consumo
  durante varias sesiones. El plan gratuito entra en reposo después de 15 minutos
  de inactividad, puede reiniciarse y tiene límites de transferencia. Las sesiones
  y los segmentos viven en almacenamiento temporal.
  [Límites del plan gratuito](https://render.com/docs/free)
- Producción sirvió a la vez una mezcla de Audius y una mezcla de «Stereo Love»
  y «Fanática Sensual» desde la cola de la PWA. El límite de dos sesiones se
  comprobó localmente con cuatro solicitudes concurrentes: dos se aceptaron
  y las otras dos recibieron un 429. Revisar capacidad antes de ampliar el uso.
- La revisión `f9b78e4` está publicada en Render y renueva la sesión con cada
  segmento servido, hasta una hora desde que se creó. La prueba local con reloj
  acelerado decodificó un segmento en 20:12 y comprobó la caducidad por
  inactividad. En Render se decodificó al minuto 15. La sesión seguía accesible
  a 19:15, pero en esa consulta faltó el segmento esperado. Queda repetir la
  prueba de extremo a extremo con más de 20 minutos de tiempo real.
- Si deslizas una pista antes de reproducir un bloque, la PWA reconstruye
  la mezcla con el orden nuevo. Durante la reproducción conserva el
  bloque HLS y permite insertar una pista después de él.
- El reemplazo en una sesión activa pasó la prueba local con FFmpeg y una
  prueba de producción en Render con Audius. Conservó tres segmentos ya
  publicados y el flujo se pudo decodificar hasta después de la transición
  bajo la misma URL. Se aplica cuando la transición aún no se publicó y la
  variante llega a tiempo. Falta verificar el gesto y el fundido resultante
  en la cola habitual del iPhone bloqueado y encadenar bloques con fundido.
- El diagnóstico de la PWA registra cambios de mezcla, errores y motivo
  del aplazamiento. La credencial de reproducción HLS queda oculta.
- Render valida primero un rango AAC del relay europeo para el ID solicitado.
  Si falla, intenta la fuente directa y luego `/api/stream`. Las pistas de Audius
  conservan su proveedor propio.

### 4.4 Audio avanzado (solo después de P0/P1)

- Ecualizador real, velocidad con o sin cambio de tono.
- Temporizador de apagado con fundido.
- Caché de canciones y precarga de las dos pistas vecinas.
- “Mejora de calidad” a los pocos segundos, si la fuente lo permite.
- SponsorBlock, solo si se decide asumir su dependencia externa.

### 4.5 Biblioteca y offline

- Copias, migraciones y recuperación sin pérdida.
- Medir memoria con bibliotecas grandes. La prueba offline comprueba que el
  arranque prepara solamente los blobs de la pista actual y la siguiente.
- Rehidratar descargas y probar modo avión tras relanzar.
- Probar el importador de la cuenta de YouTube con varias cuentas externas.
  Antes de ofrecerlo a todo el público, revisar la verificación del permiso
  de solo lectura y las políticas aplicables al uso del catálogo.
- Medir si la radio mejora al favorecer artistas de los favoritos e historial
  local. Ofrecer por separado el uso de listas importadas como señal voluntaria
  y probarlo con canciones de géneros distintos, sin cambiar la cola manual.
- SimpMusic describe las recomendaciones personalizadas de YouTube Music y el
  uso de Spotify para recursos como letras y Canvas. La Web API de Spotify
  requiere Premium del titular de nuevas aplicaciones en modo de desarrollo.
  FreeSong conserva la importación por enlace para acceder a listas públicas
  dentro del alcance gratuito. [SimpMusic](https://github.com/maxrave-dev/SimpMusic#data)
  · [Condiciones de desarrollo de Spotify](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)

### 4.6 Documentación desactualizada

Se actualizó la descripción del crossfade en `README.md` e `IOS.md`, y se
documentaron la verificación de la PWA y el mezclador. La sección de arranque
rápido de la versión 3.9.28 sigue como referencia histórica.

---

## 5. Lo que OpenTune aporta y lo que no

### Aporta como referencia

| Idea | Aplicación en FreeSong |
| --- | --- |
| Resolver en el dispositivo | Ya es nuestra arquitectura; confirma que evita el bloqueo por IP de datacenter. |
| Probar la URL antes de reproducir | Ya se hace; mantenerlo en toda vía nueva. |
| HLS como respaldo | Añadir en el resolver nativo. |
| Descarga en trozos de ~2 MB con `.part` | Adoptar en el gestor nativo. |
| `loudnessDb` para nivelar | Sustituir la ganancia fija. |
| Interrupciones y cambio de ruta | Ya existen; probar en hardware. |
| Letras multifuente y offset | Feature pendiente de 4.1. |
| Caché, precarga de vecinos, equal-power | Roadmap de 4.2 y 4.4. |

### No aporta / no se copia

- **Licencia GPL-3.0.** FreeSong no tiene licencia publicada; copiar código de
  OpenTune obligaría a licenciar todo el proyecto como GPL. Solo se toman ideas.
- **Tokens PO y NewPipeExtractor.** Kotlin/Android, frágiles y GPL. No se portan
  a corto plazo.
- **Reproductor web con extensión.** No aplica a la PWA de iPhone.
- **App iOS por sideload.** No sustituye a la PWA ni al IPA actual.

---

## 6. Reglas que no se deben romper

1. No añadir rutas API: ya hay 12/12 en Vercel Hobby.
2. No usar el iframe de YouTube Web en iPhone: iOS lo pausa al bloquear.
3. No prometer reproducción en segundo plano sin probarla en hardware.
4. No llamar “implementada” a una función que solo tiene botón o preferencia.
5. No borrar la app ni la biblioteca como primer intento de reparación.
6. No mezclar versiones de caché entre PWA e IPA.

---

## 7. Estado de Git en la auditoría original

- `main` = `origin/main` = `35db606`; sin cambios locales pendientes.
- Rama local `codex/iphone-native-audio`: un commit por delante de su remoto,
  pero ese commit (`8407af3`) ya está incluido en `main`.
- Rama antigua `claude/hola-b59f2c` (v3.3.1) sin relación con el estado actual.
- Sin pull requests ni issues abiertos en GitHub.

---

## 8. Siguiente trabajo recomendado

1. Activar el cliente externo de Google, probar con las cuentas de prueba y
   completar la validación física del reproductor y el diseño (2.1 y 3.7).
2. Revisar permisos del catálogo y medir arranque en frío, capacidad y
   caducidad antes de ampliar el uso público (2.4 y 4.3).
3. Verificar el reemplazo HLS en el iPhone bloqueado y encadenar bloques con
   fundido (4.3).
4. Añadir el respaldo HLS en el IPA, confirmar la política de sesión de audio,
   verificar descargas y adoptar `loudnessDb` (3.1 a 3.4).
5. Abordar letras multifuente como mejora independiente (4.1).

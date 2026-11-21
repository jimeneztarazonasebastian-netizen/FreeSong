# Pendientes y mejoras de FreeSong

Fecha: 21 de noviembre de 2026.
Base de la auditoría original: `35db606`. Estado de los avances actualizado
para la versión web **3.9.41**.

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
- El mezclador HLS de Render entregó una mezcla completa de dos canciones
  de Audius. La página experimental se probó con el iPhone bloqueado.
- La PWA incluye búsqueda de Audius, gestos de cola y reproducción HLS en
  **Siguiente** por bloques de hasta tres pistas.

---

## 2. Prioridad P0 — reproducción y validación real

### 2.1 Validar el IPA en un iPhone físico

Es el criterio que ningún test de Chrome puede sustituir. Falta completar:

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
2. Mantener el relay con comprobación de salud y rotación; hoy hay una sola
   instancia por defecto.
3. Conservar la cookie de YouTube como vía MWEB cuando la IP no esté bloqueada.
4. Medir con una lista fija de 20 pistas variadas: primer byte, seek, URL
   caducada y fallo explícito, en Wi-Fi y datos móviles, repetido otro día.

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

### 3.6 Relay único

Hay una sola instancia por defecto (`yt.chocolatemoo53.com`). Añadir health-check,
rotación y una instancia propia documentada. La disponibilidad externa sigue
siendo un riesgo abierto de la auditoría.

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
- La PWA debe mostrar disponibilidad real: primer plano frente a bloqueado.
- No anunciar crossfade bloqueado en Safari sin haberlo demostrado.

### 4.3 Mezclador HLS experimental (Render)

Render Free y el puente de Vercel están operativos. La prueba en producción
aceptó la sesión, pero ambas canciones cayeron al proxy. Por separado,
`/api/stream` devolvió `502 STREAM_UNAVAILABLE` para ambas, con rechazos
`403` de origen. La mezcla no produjo segmentos. El endpoint público de Render
reportaba `b12949d` durante la prueba, con el diagnóstico anterior.

- Validar en un iPhone bloqueado la demostración HLS de dos tonos en
  `/mixer-test.html`. Esta prueba separa la reproducción en Safari de los
  problemas de las fuentes de canciones.
- Conseguir una fuente estable de audio y medirla desde Render.
- Probar Audius desde Render con IDs explícitos (`audius:<id>`) en
  `/mixer-test.html`. Su catálogo es independiente del de YouTube.
  OpenTune verifica sus fuentes alternativas por grabación y mantiene
  identificada cada versión. FreeSong conserva el proveedor explícito y
  evita sustituciones automáticas.
- Medir tiempo al primer segmento y CPU real.
- Control de sesiones por usuario y renovación de cola.
- Si deslizas una pista antes de reproducir un bloque, la PWA reconstruye
  la mezcla con el orden nuevo. Durante la reproducción conserva el
  bloque HLS y permite insertar una pista después de él.
- Falta permitir el reemplazo dentro del bloque activo mediante publicación
  progresiva de segmentos y un límite explícito para cambios después de
  que Safari haya cargado la transición. También falta encadenar bloques
  con fundido y validar la cola habitual con el iPhone bloqueado.
- Render intenta obtener una URL directa de audio y recurre a `/api/stream`
  cuando la primera vía no devuelve audio reproducible.

### 4.4 Audio avanzado (solo después de P0/P1)

- Ecualizador real, velocidad con o sin cambio de tono.
- Temporizador de apagado con fundido.
- Caché de canciones y precarga de las dos pistas vecinas.
- “Mejora de calidad” a los pocos segundos, si la fuente lo permite.
- SponsorBlock, solo si se decide asumir su dependencia externa.

### 4.5 Biblioteca y offline

- Copias, migraciones y recuperación sin pérdida.
- Medir memoria con bibliotecas grandes; hoy se preparan blobs al arrancar.
- Rehidratar descargas y probar modo avión tras relanzar.

### 4.6 Documentación desactualizada

`README.md` e `IOS.md` mezclan versiones 3.9.28, 3.9.30 y 3.9.31, y la lista de
tests no incluye varias suites actuales (`ios-background`, `download`, `diag`,
`pwa`, `native-adapter`, `mixer-bridge`, etc.). Hay que unificarlos con 3.9.37.

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

1. Completar la validación física del IPA vigente (2.1).
2. Añadir el fallback HLS (3.1) y confirmar la política de sesión de audio (3.2).
3. Verificar el troceado de descargas y adoptar `loudnessDb` (3.3 y 3.4).
4. Validar la cola HLS en el iPhone y permitir reemplazar transiciones que
   todavía no se hayan entregado al reproductor (4.3).
5. Abordar letras multifuente como feature independiente (4.1).

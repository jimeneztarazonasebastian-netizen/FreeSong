# Auditoría de FreeSong 3.9.56

Revisión del 28 de noviembre de 2026 sobre la versión publicada en Vercel y
Render, el código de la PWA y el IPA compilado por GitHub Actions. La base de
reproducción es el commit `917847d`. Esta revisión reorganiza los documentos y
las pruebas sin modificar el motor.

La calificación técnica es **7,7/10**. FreeSong está en beta utilizable para uso
personal. Quedan pruebas y correcciones antes de ofrecerla al público como
estable.

| Área | Peso | Nota | Evidencia |
| --- | ---: | ---: | --- |
| Funciones del reproductor | 30 % | 8,5 | Cola, crossfade, controles multimedia, biblioteca, descargas e importación tienen cobertura automatizada. La prueba física de la cola larga sigue pendiente. |
| Disponibilidad y rendimiento | 25 % | 6,5 | Producción amplió cuatro pistas con el mismo flujo. El arranque en frío, las fuentes externas y la capacidad del mezclador siguen condicionando el resultado. |
| Pruebas y compilación | 20 % | 9,0 | GitHub Actions verifica web, FFmpeg, políticas Swift y compilación iOS. El navegador automatizado usa Chromium. |
| Mantenimiento | 15 % | 8,0 | Las capas y pruebas tienen ubicaciones claras. El cliente principal aún concentra más de 10.000 líneas. |
| Preparación para publicar | 10 % | 5,0 | Faltan un enlace al IPA vigente, cobertura de catálogo medible, revisión de permisos y validación física. |

## Qué quedó verificado

- La estructura nueva pasó `npm run build`, `npm test` y
  `npm run test:mixer`. La compilación reproduce el mismo contenido de
  `www/` y el código de ejecución en iOS, Vercel y Render sigue igual.
- FFmpeg sirvió y decodificó 30:08 de audio de prueba, con 11 pistas y diez
  transiciones con solapamiento. La prueba conserva el segmento ya publicado y
  comprueba que el audio siga bajo la misma URL. Una fuente inaccesible al
  ampliar la cola conserva el bloque inicial.
- La prueba de la PWA simuló una pestaña oculta con perfil de iPhone y recorrió
  la cola de 30 minutos sin cambiar el elemento de audio ni guardar
  descargas. Chromium no simula la suspensión de procesos al bloquear un
  iPhone y la prueba no mide el tiempo de carga en ese dispositivo.
- La prueba de producción obtuvo la ampliación de tres a cuatro pistas bajo
  la misma URL y verificó el primer segmento. El tramo completo de 30:08
  se verificó con las pistas de prueba. [CI web y mezclador de 3.9.56](https://github.com/jimeneztarazonasebastian-netizen/FreeSong/actions/runs/46145857471)
- Compilaron el proyecto iOS y el IPA 3.9.56. Las pruebas Swift cubren el
  resolvedor y las políticas de audio. [CI y artefacto iOS de 3.9.56](https://github.com/jimeneztarazonasebastian-netizen/FreeSong/actions/runs/46145857482)
- `npm audit` devolvió cero avisos de dependencias en la revisión. El
  resultado cubre los paquetes registrados en npm.

## Hallazgos abiertos

| Prioridad | Hallazgo | Evidencia e impacto |
| --- | --- | --- |
| Alta | Reproducción con un iPhone bloqueado | Falta completar una sesión física de 30 minutos, con el bloqueo desde el primer toque y el paso del bloque inicial. Quedan por comprobar los controles del sistema, las interrupciones y el retorno desde segundo plano. [Prueba de PWA](../tests/browser/test-pwa.mjs) |
| Alta | IPA público desactualizado | El archivo servido en `/FreeSong.ipa` contiene la versión 1.0, compilación 1. La versión 3.9.56 se descarga desde el artefacto de la ejecución iOS. El enlace directo requiere un mecanismo de publicación de la versión vigente. [Guía de iPhone](ios.md) |
| Alta | Arranque y capacidad de Render | Hay dos sesiones simultáneas y una preparación de reemplazo a la vez. El arranque nativo espera hasta 54 segundos, cerca del minuto que puede tardar Render Free en salir del reposo. Si la variante tarda demasiado o la pista falla, se conserva el bloque inicial. [Puente de Vercel](../api/_mixer.js) · [Servidor del mezclador](../services/mixer/server.mjs) · [Límites de Render Free](https://render.com/docs/free#spinning-down-on-idle) |
| Alta para distribución | Dependencia del catálogo | Superar una prueba de resolución confirma esa grabación en ese momento. Disponibilidad, tiempos y permisos dependen del proveedor. Hace falta una muestra repetible y revisar qué catálogo se puede ofrecer. [Resolución de audio](../api/stream.js) · [Relays](../api/_relay.js) |
| Media | Protección y recuperación de sesiones | La admisión del mezclador usa límites en memoria. Un inicio cancelado antes de recibir el primer segmento puede retener una de las dos sesiones durante su limpieza por inactividad. Revisar cancelación y admisión antes de ampliar el acceso. [Puente](../api/_mixer.js) · [Caducidad](../services/mixer/hls.mjs) |
| Media | Credenciales operativas | El respaldo heredado usa una cookie de sesión de YouTube. Si el archivo no contiene cookies reconocidas como YouTube, el importador acepta otras cookies del archivo. Esa ruta merece revisión antes de usarla para distribuir la app. El acceso opcional de usuarios usa OAuth de solo lectura. [Importador operativo](../scripts/set-cookie.mjs) · [Conexión de usuarios](../www/youtube-account.js) |
| Media | Rendimiento y accesibilidad sin medir en hardware | La suite comprueba tamaños de pantalla, arranque offline y solicitudes por rango. Falta medir el primer audio en Wi‑Fi y datos, revisar la Isla Dinámica con el teclado abierto y recorrer la interfaz con VoiceOver. [Pruebas de diseño](../tests/browser/test-layout.mjs) · [Pruebas de PWA](../tests/browser/test-pwa.mjs) |

## Criterios para cerrar la beta

1. Completar la cola de 30 minutos en una PWA instalada. Bloquear el iPhone al
   tocar Play y verificar audio, fundido y controles después de la tercera
   pista. Repetir en Wi‑Fi y datos móviles, con Render caliente y en reposo.
2. Medir el arranque y la disponibilidad con 20 pistas variadas. Registrar
   publicación exacta, tiempo hasta audio, duración y fallo. Repetir la muestra
   otro día y comprobar recuperación al cambiar rápido de canción.
3. Vincular un IPA vigente y probarlo en hardware con el iPhone bloqueado,
   auriculares e interrupciones. Comprobar por separado importación de listas
   y Me gusta, reimportación y desconexión de la cuenta.
4. Revisar los permisos del catálogo y la capacidad del servicio antes de
   distribuirlo públicamente. Ver [pendientes vigentes](../PENDIENTES.md).

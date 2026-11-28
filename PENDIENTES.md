# Pendientes de FreeSong

Estado al 28 de noviembre de 2026. La versión 3.9.56 está desplegada y
utilizable como beta. La [auditoría](docs/auditoria.md) contiene la nota,
la evidencia y los límites. El [historial](docs/historial/) conserva las
decisiones y las comprobaciones de revisiones anteriores.

## Antes de declarar estable la versión

- [ ] Completar la cola de 30 minutos en la PWA instalada, bloqueando el iPhone
  inmediatamente tras tocar Play. Confirmar al menos un paso más allá de la
  tercera pista, el fundido y los controles de bloqueo. Repetir con Wi‑Fi,
  datos móviles y Render en reposo. Si falla, guardar el diagnóstico local.
- [ ] Probar el gesto de poner de siguiente cuando el bloque activo ya está
  preparado, tanto antes como después de publicar la transición. Verificar
  que siga sonando la pista actual y que la cola coincida con el resultado.
- [ ] Medir 20 pistas variadas. Registrar disponibilidad, tiempo al primer
  audio, duración, errores y recuperación. Comprobar el arranque en frío, la
  cancelación de inicios y las dos sesiones simultáneas en Render.
- [x] Actualizar la [descarga pública del IPA](https://freesong-pied.vercel.app/FreeSong.ipa) a 3.9.56.
- [ ] Probar el IPA vigente en hardware, con controles de bloqueo, auriculares,
  llamadas y descargas ya guardadas en modo avión.
- [ ] Probar listas y Me gusta con una cuenta externa. Confirmar que
  reimportar no duplica y que desconectar retira las copias. Verificar el estado
  del consentimiento de Google antes de abrirlo al público.
- [ ] Documentar el catálogo disponible para distribución, revisar los
  permisos de uso y cerrar los puntos de privacidad y capacidad del mezclador.

## Mejoras después de la validación

- [ ] Revisar áreas seguras, teclado, tamaño de texto y VoiceOver en hardware.
- [ ] Separar partes pequeñas de la interfaz y de la lógica de cola de
  `www/app.js` con sus pruebas, para reducir el coste de mantenimiento.
- [ ] Medir la normalización por pista y evaluar descargas nativas en segundo
  plano, velocidad con control de tono y más fuentes de letras.
- [ ] Alinear los disparadores del workflow iOS con las fuentes de CSS,
  generación de JavaScript e iconos. Revisar el flujo de aprobación de cambios
  y el contexto local de compilación Docker.

La ampliación HLS bajo la misma URL, el gesto para encolar de siguiente,
los respaldos de fuente, el diagnóstico local y la importación opcional de
YouTube ya tienen implementación y pruebas automatizadas. La disponibilidad
real en cada dispositivo y proveedor se valida en los puntos anteriores.

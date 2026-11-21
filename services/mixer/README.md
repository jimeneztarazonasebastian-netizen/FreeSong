# Mezclador HLS experimental

La PWA usa este servicio desde **Siguiente**. La prueba de dos pistas de Audius
funcionó con el iPhone bloqueado. El comportamiento de la edición durante la
reproducción se prueba con FFmpeg y requiere confirmación en el iPhone.

Render Blueprint: `render.yaml` en la raíz, servicio Docker con plan `free` explícito.
Crear una cuenta de Render, conectar este repositorio y crear un Blueprint.
Si la plataforma pide contratar un plan o añadir pagos, detener el despliegue: el requisito es coste cero.
La clave generada debe permanecer en el servidor; nunca incluirla en JavaScript público.

`POST /sessions`, con `Authorization: Bearer MIXER_API_KEY`, recibe:

```json
{"tracks":[{"id":"video1","title":"Uno"},{"id":"video2","title":"Dos"}],"crossfade":6}
```

Devuelve rutas de estado y lista HLS. Hay que esperar a que la lista esté disponible.
FFmpeg mezcla audio AAC y sirve segmentos temporales; no exige descargas manuales en el teléfono.
Máximo 2 sesiones simultáneas, 2–3 canciones de hasta 10 minutos por sesión, caducidad a los 20 minutos.
Los identificadores aleatorios de sesión son credenciales de reproducción: no compartirlos.

## Pendientes antes de conectarlo a producción

- Cuenta y despliegue real en Render; comprobar consumo gratuito y suspensión al alcanzar límites.
- Verificar fuentes desde el proveedor. Actualmente usa `/api/stream`: si devuelve 403/502, la mezcla falla también.
- Medir tiempo hasta primer segmento y CPU real. No se garantiza que la instancia gratuita sea suficiente.
- Añadir API autenticada desde Vercel, sesiones por usuario y renovación de cola.
- Integrar la línea de tiempo de canciones, metadatos, pausa, seek y cambios de cola en la PWA.
- Verificar varios cambios de canción con un iPhone físico bloqueado, sin actualizar iOS.

Las sesiones creadas con `editable: true` publican el manifiesto de forma progresiva.
Un `PATCH /sessions/:id` autenticado conserva los IDs hasta el índice `part`,
incluido, y prepara una variante con las pistas siguientes. El manifiesto y las
URLs de audio permanecen iguales. Solo se cambia el render cuando los segmentos
anunciados coinciden byte a byte y ya hay segmentos nuevos disponibles.

Si Safari ya recibió la transición o la variante no se prepara a tiempo, la
reproducción continúa con el bloque anterior y la PWA encola la solicitud al
final de ese bloque. La anticipación de segmentos suele rondar 20 segundos y
puede crecer mientras la sesión está pausada. Las sesiones editables reproducen
a velocidad normal. Se admite una variante en preparación a la vez para acotar
el uso de CPU en el plan gratuito. El código requiere desplegar la revisión
vigente en Render además de Vercel.

Render Free se suspende tras 15 minutos sin tráfico y el arranque puede tardar cerca de un minuto.
Sin método de pago, al agotar el tráfico incluido suspende los servicios gratuitos.
Fuentes: https://render.com/docs/free y https://ffmpeg.org/ffmpeg-filters.html#acrossfade

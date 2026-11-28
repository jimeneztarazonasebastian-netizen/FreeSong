# Operación de FreeSong

Vercel publica el sitio y la API desde la rama main. Render ejecuta el
mezclador definido en [render.yaml](../render.yaml) y usa la API de Vercel
como respaldo. La configuración de audio está descrita en la
[guía del mezclador](../services/mixer/README.md).

## Verificación de un despliegue

- Comprueba la versión en [Vercel](https://freesong-pied.vercel.app/api/health)
  y la revisión del mezclador en [Render](https://freesong-mixer.onrender.com/health).
  Esas respuestas indican que los servicios contestan. Una prueba de audio
  comprueba por separado si los proveedores entregan una pista reproducible.
- Desde la raíz, `node scripts/check-production.mjs 3.9.56` prueba búsqueda,
  audio y avance con una fuente real en Chromium. Sustituye el número por la
  versión que se desplegó. Las pruebas de `npm test` usan datos simulados.
- Cuando cambie el motor Swift, verifica la compilación de GitHub Actions
  y descarga el artefacto de esa versión. [Guía de iPhone](ios.md)

## Fuentes de audio

`api/stream.js` reutiliza resoluciones en memoria y prueba relays y clientes
alternativos. Si corresponde, comprueba identidad y duración antes de
usar otra publicación de la misma canción. El proxy admite solicitudes
`Range` para buscar y precargar. Las descargas opcionales ensamblan rangos
verificados y conservan el formato recibido.

`INVIDIOUS_INSTANCES` permite configurar una lista de relays. El proxy aún
admite `YOUTUBE_COOKIE` como respaldo heredado. Es una credencial operativa
distinta de la conexión OAuth de usuarios. Consulta la
[auditoría](auditoria.md#hallazgos-abiertos) antes de habilitarla.

## Importación opcional de YouTube

En la web y la PWA, abre **Biblioteca → Importar → Desde mi cuenta de YouTube**.
El permiso de solo lectura permite copiar playlists propias y Me gusta a la
biblioteca local. Se importan hasta 200 elementos por operación. Las copias
caducan tras 30 días, se pueden actualizar reimportándolas y se eliminan al
desconectar. La reproducción usa su configuración habitual.

Para habilitar el acceso en un despliegue:

1. En Google Cloud, habilita **YouTube Data API v3** en el proyecto de FreeSong.
   Configura el consentimiento para `https://www.googleapis.com/auth/youtube.readonly`.
   Usa cuentas de prueba durante el desarrollo o completa la verificación de
   Google antes de ofrecer el acceso general.
2. Crea un cliente OAuth de tipo **Aplicación web**. Agrega
   `https://freesong-pied.vercel.app` a los orígenes autorizados de JavaScript.
   La página de privacidad es `https://freesong-pied.vercel.app/youtube-privacy`.
3. Agrega el **ID público del cliente** como `YOUTUBE_OAUTH_CLIENT_ID` en el
   entorno **Production** de Vercel. Publica un despliegue nuevo para aplicar
   la variable. En desarrollo, registra `http://localhost:5173` y pasa la misma
   variable a `npm start`.

El permiso vive en la memoria del navegador y se envía a Google al consultar
la biblioteca. El cliente web usa el ID público y la cuota incluida de YouTube
Data API. Mantén el secreto del cliente y las contraseñas fuera del repositorio.
Si falta el ID, el importador por enlace público sigue disponible.

[Configurar el cliente OAuth de Google](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)
· [Cuota de YouTube Data API](https://developers.google.com/youtube/data/determine_quota_cost)

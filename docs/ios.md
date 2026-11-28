# FreeSong en iPhone

El IPA usa una interfaz web Capacitor y un motor de audio Swift con dos AVPlayer.
La cola, la precarga, el avance y el crossfade se ejecutan en código nativo. El
motor publica metadatos, duración y velocidad reales en Now Playing y recibe los
comandos de bloqueo mediante MPRemoteCommandCenter. La apariencia y presencia de
Dynamic Island las administra iOS; no se puede garantizar la misma presentación
visual que Spotify en todos los dispositivos y estados.

## Actualizar el IPA

Desde el iPhone, descarga el [IPA 3.9.56](https://freesong-pied.vercel.app/FreeSong.ipa).
Selecciónalo desde **AltStore → My Apps → + → Descargas** para actualizar la
instalación con la misma cuenta de Apple. Las bibliotecas de la PWA y del IPA
son independientes. AltStore firma el IPA para tu cuenta.

El archivo publicado corresponde a la compilación 124 de 3.9.56, con iOS 15
como versión mínima. [Compilación iOS en GitHub Actions](https://github.com/jimeneztarazonasebastian-netizen/FreeSong/actions/runs/46146976227)

La interfaz continúa en `https://freesong-pied.vercel.app`, conservando el origen
de almacenamiento de la versión anterior. App Bound Domains permite usar el
worker y su caché dentro de WKWebView: la primera apertura necesita Internet;
las posteriores pueden reutilizar la interfaz instalada. El código Swift nuevo
requiere este IPA. Una actualización web sola no añade el motor nativo a IPA
anteriores. Si cambia el dominio deben actualizarse también Info.plist y la
configuración de Capacitor antes de compilar.

## Reproducción y descargas

El adaptador `www/native-audio.js` detecta el plugin, evita dos motores activos
y reconcilia la cola al volver del segundo plano. El motor Swift usa archivos
nativos para el audio descargado. Las descargas antiguas de Cache API se copian
al seleccionarlas y al preparar la siguiente canción; favoritos y playlists se
conservan en el almacenamiento existente.

El resolver separa catálogo, URL de audio, formato y caducidad. Prueba bytes reales
antes de entregar una fuente, rechaza páginas HTML y busca otra publicación
compatible cuando falla el original. Sigue dependiendo del relay y del proxy
configurados; no incorpora un extractor universal ni garantiza todas las canciones.
Las descargas nuevas siguen usando el flujo de rangos existente y después se
copian al almacenamiento nativo; no hay aún un gestor de descargas iOS en segundo plano.

El crossfade nativo comienza cuando la siguiente pista está preparada. Si falta
audio preparado, continúa la transición normal. Con Crossfade activado, la PWA
puede iniciar una mezcla HLS en una cola compatible desde el primer toque de
reproducción. El servidor incorpora el fundido al flujo y puede ampliar la cola
en esa misma URL. Consulta [la guía del mezclador](../services/mixer/README.md).

## Firma gratuita

Con una cuenta gratuita, la firma de AltStore Classic vence a los siete días.
Antes del vencimiento: abrir AltStore → My Apps → Refresh All con AltServer
ejecutándose en el PC y el teléfono conectado por USB. La misma red Wi-Fi sirve
si está configurada la sincronización inalámbrica. Abrir AltStore con el PC
apagado no renueva las aplicaciones. No hace falta descargar otro IPA para cada
renovación. Cambiar el motor a Swift no elimina las reglas de firma de Apple.

[AltStore Classic: My Apps y Background Refresh](https://faq.altstore.io/altstore-classic/your-altstore).

## Validación

GitHub Actions ejecuta las pruebas Swift del resolver y las políticas de cola,
duración y ganancias. También compila con Xcode y empaqueta el IPA. Las
pruebas de navegador validan el contrato del puente, cola, controles y separación
de motores. Ninguna sustituye una prueba audible con el iPhone físico.

Después de instalar: activar crossfade de seis segundos, reproducir una cola de
varias canciones, dejar cinco transiciones bloqueado y comprobar pausa, siguiente
y seek desde la pantalla bloqueada. Repetir con descargas y modo avión. Exportar
el diagnóstico: debe indicar `engine: avplayer`, versión del paquete y versión iOS.
Verificar además llamadas, auriculares y reapertura antes de cerrar la
validación en hardware.

## Referencias

Se revisó [SimpMusic](https://github.com/maxrave-dev/SimpMusic) como referencia de
separación entre catálogo, fuentes y reproductor. No se copió su código ni se
presenta su extractor Kotlin como una implementación iOS disponible.

[Apple: reproducción multimedia](https://developer.apple.com/documentation/avfoundation/configuring-your-app-for-media-playback).

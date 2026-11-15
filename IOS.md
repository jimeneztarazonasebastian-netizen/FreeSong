# FreeSong en iPhone

## Qué contiene el IPA actual

FreeSong 3.9.29 es una aplicación híbrida de Capacitor: UIKit inicia un WKWebView,
AVAudioSession declara reproducción en segundo plano y la interfaz/motor de audio
HTML se cargan desde `https://freesong-pied.vercel.app`. El IPA no contiene todavía
un motor de reproducción AVPlayer ni una interfaz SwiftUI. Generar otro IPA o
cambiar su icono no transforma ese motor en nativo.

Las correcciones web llegan por Vercel y el aviso de actualización de la app.
Cambiar AppIcon, versión del paquete o código Swift requiere instalar el IPA
nuevo sobre FreeSong, con la misma cuenta y sin borrar la aplicación previamente.
La biblioteca de la PWA y la del IPA pertenecen a instalaciones distintas.

## Firma gratuita y renovación

Con una cuenta gratuita, las aplicaciones instaladas por AltStore Classic
caducan a los siete días. Antes del vencimiento, abrir AltStore → My Apps →
Refresh All, con AltServer ejecutándose en el PC y el teléfono conectado por USB.
No hace falta descargar un IPA nuevo para esta renovación rutinaria.

La renovación también puede hacerse por la misma red Wi-Fi si se configuró la
sincronización inalámbrica del dispositivo. AltStore intenta renovar en segundo
plano si iOS le permite ejecutarse y AltServer es accesible. No es una garantía:
un PC apagado o no accesible impide la renovación. Mantener AltServer al inicio
de Windows y habilitar Background Refresh en AltStore reduce el trabajo manual.
La PWA no necesita una firma de AltStore; cambiar el motor a Swift no elimina
las reglas de firma de los IPA.

Fuente: [AltStore Classic: My Apps y Background Refresh](https://faq.altstore.io/altstore-classic/your-altstore).

## Qué se puede aprovechar de SimpMusic

Revisión del repositorio público el 15 de noviembre de 2026: su README ofrece
Android y escritorio, desarrollados con Kotlin/Compose Multiplatform. No hay un
target iOS listo para compilar. Sus ideas útiles son separar catálogo y resolución
de fuentes, mantener una cola explícita, precargar la siguiente pista y guardar
audio para reproducción offline. FreeSong ya implementa estas funciones por su
propia vía. No se incorporó código de SimpMusic en esta revisión.

[Repositorio](https://github.com/maxrave-dev/SimpMusic),
[README](https://github.com/maxrave-dev/SimpMusic/blob/dev/README.md),
[licencia GPL-3.0](https://github.com/maxrave-dev/SimpMusic/blob/dev/LICENSE).
Si se reutiliza código, debe revisarse y respetarse su licencia y atribución.

## Migración que requiere un motor realmente nativo

1. Implementar reproducción y cola con AVPlayer/AVQueuePlayer en Swift y un
   puente Capacitor para cargar, pausar, reanudar, buscar y cambiar de pista.
2. Hacer que el motor nativo sea el único propietario de Now Playing y de los
   comandos remotos. Evitar que compita con los dos elementos HTML de audio.
3. Descargar archivos a almacenamiento nativo, migrar las referencias offline
   de Cache API y conservar favoritos/playlists; un AVPlayer no puede abrir un
   `blob:` perteneciente al WKWebView.
4. Resolver las siguientes fuentes antes del bloqueo y administrar interrupciones,
   cambio de auriculares, Bluetooth, AirPlay, red y URLs caducadas en el motor.
5. Verificar en un iPhone real varios cambios completos, pausa/reanudación,
   llamadas, modo avión y relanzamiento. Una identificación de iPhone en Chrome
   no valida esas condiciones de iOS.

Esta migración no forma parte del arreglo de sincronización 3.9.29. Sustituir
el reproductor que el usuario ya confirmó que continúa bloqueado exige esa
integración y validación, no renombrar el contenedor como «100 % nativo».

[Apple: reproducción multimedia](https://developer.apple.com/documentation/avfoundation/configuring-your-app-for-media-playback).

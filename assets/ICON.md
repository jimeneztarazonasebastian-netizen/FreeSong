# Icono de FreeSong

Fuente final: `assets/icon-source.png`. Generado con la herramienta integrada imagegen el 15 de noviembre de 2026; no se usó la CLI ni una clave API propia. El antiguo SVG queda como archivo histórico y no participa en la compilación.

Prompt inicial:

Use case: logo-brand. Asset type: final iOS app icon for FreeSong, a music player. Primary request: one original creative icon, a bold sculptural musical note that also reads as a soaring wing, suggesting freedom and continuous music. Style: refined contemporary app brand, simple strong silhouette, subtle polished dimensionality, luminous turquoise and mint against a deep ink midnight background to fit a dark music player. Composition: square 1024x1024 full bleed opaque background, single centered mark occupying about 65 percent of canvas, generous safe margins, clean high contrast and readable at 32 pixels. The wing and note must be one coherent symbol rather than separate objects. No text, letters, device mockups, borders, rounded-square outer tile, grids, alternate versions, watermark, extra ornament, or existing brand logos. iOS will apply its own corner mask.

Edición de color solicitada por el usuario:

Edit the supplied FreeSong icon. Change only its color palette: recolor the single wing-shaped musical note with a rich luminous gradient flowing from violet and purple at the upper wing through indigo to electric blue at the lower note. Keep the exact symbol geometry, polished dimensional shading, dark midnight full-bleed square background, centered composition and safe margins. No green, turquoise, text, extra symbols, device mockup or rounded outer tile. Output the finished app icon as a square opaque image.

`npm run icons` deriva los PNG web/PWA y el AppIcon de iOS de esta misma fuente, los redimensiona, elimina transparencia y optimiza la paleta. `npm run build` ejecuta este paso automáticamente. No modificar solo un PNG derivado, porque la próxima compilación lo regenerará.


// Genera los íconos PNG (PWA e iPhone) a partir del original generado con IA.
// y copia el runtime de Capacitor a www/ para que los plugins nativos funcionen sin bundler.
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const source = await readFile(root('assets/icon-source.png'));
await mkdir(root('www/icons'), { recursive: true });

const outputs = [
  ['www/icons/icon-192.png', 192],
  ['www/icons/icon-512.png', 512],
  ['www/icons/apple-touch-icon.png', 180],
  ['www/icons/favicon-32.png', 32],
  ['assets/icon-1024.png', 1024],
  ['ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', 1024]
];

for (const [path, size] of outputs) {
  await sharp(source).resize(size, size).flatten({ background: '#030317' }).removeAlpha()
    .png({ palette: true, quality: 95, effort: 10 }).toFile(root(path));
  console.log(`✔ ${path}`);
}

await copyFile(root('node_modules/@capacitor/core/dist/capacitor.js'), root('www/capacitor.js'));
console.log('✔ www/capacitor.js');

await mkdir(root('www/fonts'), { recursive: true });
await copyFile(
  root('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'),
  root('www/fonts/inter-latin.woff2')
);
console.log('✔ www/fonts/inter-latin.woff2');

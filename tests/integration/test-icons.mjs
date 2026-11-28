import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const outputs = [
  ['www/icons/icon-192.png', 192], ['www/icons/icon-512.png', 512],
  ['www/icons/apple-touch-icon.png', 180], ['www/icons/favicon-32.png', 32],
  ['assets/icon-1024.png', 1024],
  ['ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', 1024]
];
for (const [path, size] of outputs) {
  const data = await readFile(path);
  const meta = await sharp(data).metadata();
  assert.equal(meta.width, size, path);
  assert.equal(meta.height, size, path);
  assert.equal(meta.hasAlpha, false, 'iOS necesita un icono opaco');
  if (path.startsWith('www/')) assert.ok(data.length < 200_000, `${path} no debe encarecer el arranque`);
}
assert.deepEqual(await readFile(outputs[4][0]), await readFile(outputs[5][0]), 'El IPA debe usar el icono de FreeSong');
console.log('ICONOS OK: web/PWA/iOS, tamaños correctos, opacos y optimizados');

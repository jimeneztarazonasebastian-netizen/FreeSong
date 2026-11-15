import { readFile, writeFile } from 'node:fs/promises';
import { minify } from 'terser';

const source = await readFile(new URL('../www/app.js', import.meta.url), 'utf8');
const version = /const APP_VERSION = '([^']+)'/.exec(source)?.[1];
const result = await minify(source, {
  ecma: 2020,
  compress: { passes: 2 },
  mangle: true,
  format: { comments: false, preamble: `/* FreeSong ${version} */` }
});
if (!result.code || !version) throw new Error('No se pudo compilar FreeSong');
await writeFile(new URL('../www/app.min.js', import.meta.url), result.code + '\n');
console.log(`JS: ${Buffer.byteLength(source)} → ${Buffer.byteLength(result.code)} bytes`);

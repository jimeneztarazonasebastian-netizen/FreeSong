// Sincroniza o verifica la versión de FreeSong.
//
// La versión aparece en cuatro sitios (app.js, index.html, sw.js y
// api/health.js). Olvidar uno provoca avisos de actualización raros o un
// service worker con caché vieja. Este script evita esa deriva.
//
// Uso:
//   node scripts/version.mjs --check     # solo verifica (por defecto)
//   node scripts/version.mjs 3.9.6       # actualiza los cuatro archivos
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const filePath = (name) => fileURLToPath(new URL(name, root));
const FILES = {
  app: filePath('www/app.js'),
  index: filePath('www/index.html'),
  sw: filePath('www/sw.js'),
  health: filePath('api/health.js')
};

const PATTERNS = {
  app: /const APP_VERSION = '(\d+\.\d+\.\d+)';/,
  index: /app\.js\?v=(\d+\.\d+\.\d+)/,
  sw: /const VERSION = 'freesong-v(\d+\.\d+\.\d+)';/,
  health: /version: '(\d+\.\d+\.\d+)',/
};

function readVersions() {
  const versions = {};
  for (const [key, path] of Object.entries(FILES)) {
    const match = PATTERNS[key].exec(readFileSync(path, 'utf8'));
    versions[key] = match ? match[1] : null;
  }
  return versions;
}

function check() {
  const versions = readVersions();
  const missing = Object.entries(versions).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`VERSION FAIL: no se encontró la versión en ${missing.join(', ')}`);
    process.exit(1);
  }
  const unique = new Set(Object.values(versions));
  if (unique.size !== 1) {
    console.error('VERSION FAIL: los archivos no comparten la misma versión');
    for (const [key, value] of Object.entries(versions)) console.error(`  ${key}: ${value}`);
    process.exit(1);
  }
  console.log(`VERSION OK: ${[...unique][0]}`);
}

function setVersion(next) {
  if (!/^\d+\.\d+\.\d+$/.test(String(next || ''))) {
    console.error('Uso: node scripts/version.mjs <major.minor.patch>');
    process.exit(1);
  }

  const write = (path, replace) => {
    const before = readFileSync(path, 'utf8');
    const after = replace(before);
    if (after === before) {
      console.error(`VERSION FAIL: no se pudo actualizar ${path}`);
      process.exit(1);
    }
    writeFileSync(path, after);
  };

  write(FILES.app, (text) => text
    .replace(/\/\/ FreeSong Web Music Player v\d+\.\d+\.\d+/, `// FreeSong Web Music Player v${next}`)
    .replace(/const APP_VERSION = '\d+\.\d+\.\d+';/, `const APP_VERSION = '${next}';`));

  write(FILES.index, (text) => text
    .replace(/\?v=\d+\.\d+\.\d+/g, `?v=${next}`)
    .replace(/Versión \d+\.\d+\.\d+/, `Versión ${next}`));

  write(FILES.sw, (text) => text
    .replace(/\/\/ Service worker de FreeSong v\d+\.\d+\.\d+/, `// Service worker de FreeSong v${next}`)
    .replace(/const VERSION = 'freesong-v\d+\.\d+\.\d+';/, `const VERSION = 'freesong-v${next}';`));

  write(FILES.health, (text) => text
    .replace(/version: '\d+\.\d+\.\d+',/, `version: '${next}',`));

  check();
}

const target = process.argv[2];
if (!target || target === '--check') check();
else setVersion(target);

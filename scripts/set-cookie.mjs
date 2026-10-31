// Configura YOUTUBE_COOKIE en Vercel sin mostrar la cookie en pantalla.
// Uso:
//   1. Exporta las cookies de youtube.com con una extensión (formato cookies.txt).
//   2. Guarda el archivo como cookies.txt en la carpeta del proyecto.
//   3. node scripts/set-cookie.mjs
//   4. vercel --prod --yes
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const candidates = [
  process.argv[2],
  'cookies.txt',
  'youtube-cookies.txt',
  'www.youtube.com_cookies.txt'
].filter(Boolean);

const file = candidates.find((name) => fs.existsSync(path.resolve(name)));
if (!file) {
  console.error('No encontré cookies.txt. Exporta las cookies de youtube.com y guárdalas en la carpeta del proyecto.');
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(file), 'utf8');

// Convierte cualquiera de los tres formatos aceptados (header, Netscape, JSON)
// al string "nombre=valor; nombre=valor" que espera el proxy.
function normalize(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  if (text.startsWith('[') || text.startsWith('{')) {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : (data.cookies || []);
    const yt = list.filter((c) => c && c.name && c.value && (!c.domain || /youtube\.com$/i.test(c.domain)));
    return (yt.length ? yt : list)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  if (text.includes('\t')) {
    const rows = text
      .split(/\r?\n/)
      .filter((line) => line && (!line.trim().startsWith('#') || line.startsWith('#HttpOnly_')))
      .map((line) => {
        const clean = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line;
        const parts = clean.split('\t');
        if (parts.length < 7) return null;
        return { domain: parts[0], name: parts[5], value: parts[6] };
      })
      .filter(Boolean);

    const yt = rows.filter((c) => /youtube\.com$/i.test(c.domain));
    const chosen = yt.length ? yt : rows;
    return chosen.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  return text.replace(/\r?\n/g, ' ').trim();
}

const cookie = normalize(raw);
if (!cookie) {
  console.error('El archivo no contiene cookies válidas.');
  process.exit(1);
}

const names = cookie.split(';').map((p) => p.split('=')[0].trim()).filter(Boolean);
console.log(`Cookies detectadas: ${names.length}`);
console.log(`Cookies de sesión: ${names.filter((n) => /^(SID|HSID|SSID|APISID|SAPISID|LOGIN_INFO|__Secure-|__Host-)/.test(n)).length}`);

if (!names.some((n) => /^(SID|__Secure-1PSID|__Secure-3PSID|LOGIN_INFO)$/.test(n))) {
  console.error('No encuentro una cookie de sesión (SID o LOGIN_INFO). Inicia sesión en YouTube antes de exportar.');
  process.exit(1);
}

console.log('Guardando YOUTUBE_COOKIE en Vercel (Production)...');

// La cookie va por stdin: no queda en el historial ni en los argumentos del proceso.
// `shell: true` es necesario en Windows porque vercel es un .cmd.
const result = spawnSync(
  'vercel',
  ['env', 'add', 'YOUTUBE_COOKIE', 'production', '--force', '--sensitive', '--yes'],
  { input: cookie, stdio: ['pipe', 'inherit', 'inherit'], shell: true }
);

if (result.status !== 0) {
  console.error('No se pudo guardar la variable en Vercel.');
  process.exit(result.status || 1);
}

console.log('Listo. Ahora ejecuta: vercel --prod --yes');

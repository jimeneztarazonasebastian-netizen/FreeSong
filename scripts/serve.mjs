// Servidor estático mínimo para probar la app en http://localhost:5173 (sin dependencias).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../www/', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};
createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (urlPath.startsWith('/api/')) {
      const apiName = urlPath.replace('/api/', '').split('?')[0];
      const apiModule = await import(`../api/${apiName}.js`);
      return apiModule.default(req, res);
    }
    let file = normalize(join(ROOT, urlPath));
    if (!file.startsWith(ROOT)) throw new Error('forbidden');
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404');
  }
}).listen(PORT, () => console.log(`FreeSong en http://localhost:${PORT}`));

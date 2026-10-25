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
      // Imita los helpers que Vercel agrega a req/res en las funciones /api
      const parsed = new URL(req.url, 'http://x');
      req.query = Object.fromEntries(parsed.searchParams);
      res.status = (code) => { res.statusCode = code; return res; };
      res.send = (body) => { res.end(body); return res; };
      res.json = (body) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
        return res;
      };
      res.redirect = (code, url) => {
        res.writeHead(code, { Location: url });
        res.end();
        return res;
      };
      const apiModule = await import(`../api/${apiName}.js`);
      return await apiModule.default(req, res);
    }
    let file = normalize(join(ROOT, urlPath));
    if (!file.startsWith(ROOT)) throw new Error('forbidden');
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch (err) {
    if (res.headersSent) return res.end();
    const isApi = req.url.startsWith('/api/');
    if (isApi) console.error(err);
    res.writeHead(isApi ? 500 : 404, { 'Content-Type': 'text/plain' });
    res.end(isApi ? 'Error en la API' : '404');
  }
}).listen(PORT, () => console.log(`FreeSong en http://localhost:${PORT}`));

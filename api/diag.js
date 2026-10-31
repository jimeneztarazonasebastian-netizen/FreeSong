// Diagnóstico temporal: comprueba desde el servidor la ruta MWEB que usa /api/stream.
import { getCookie, resolveMwebAudio } from './_hls.js';

export default async function handler(req, res) {
  const out = { cookie: getCookie().length, node: process.version };
  const id = req.query?.id || 'dQw4w9WgXcQ';
  try {
    const t0 = Date.now();
    const target = await resolveMwebAudio(id, '140');
    out.resolveMs = Date.now() - t0;
    out.itag = target.itag;
    out.mimeType = target.mimeType;
    const probe = await fetch(target.url, { headers: { Range: 'bytes=0-1023', 'User-Agent': target.ua } });
    out.googlevideoStatus = probe.status;
    out.bytes = (await probe.arrayBuffer()).byteLength;
  } catch (e) {
    out.error = e.message;
    out.stack = String(e.stack || '').split('\n').slice(0, 4);
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(out, null, 2));
}

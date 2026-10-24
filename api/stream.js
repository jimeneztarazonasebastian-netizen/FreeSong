// api/stream.js - Streaming de audio puro con soporte completo HTTP 206 (Range) para iPhone (iOS Safari)
import { Ytdl, Client } from '@distube/ytdl-core';

// Cliente TV y WebEmbedded para evitar bloqueos por IP de datacenter en Vercel
const ytdl = new Ytdl({ clients: [Client.Tv, Client.WebEmbedded] });
const formatCache = new Map();

async function getAudioFormat(videoId) {
  const cached = formatCache.get(videoId);
  if (cached && Date.now() < cached.exp) {
    return cached.format;
  }

  const info = await ytdl.getInfo(videoId);
  const audioFormats = info.formats.filter((f) => f.hasAudio && !f.hasVideo);

  // Priorizar formato AAC / mp4 para reproducción eficiente y bajo consumo en iOS
  const bestMp4 = audioFormats.find((f) => f.mimeType && f.mimeType.includes('mp4'));
  const chosen = bestMp4 || audioFormats[0];

  if (!chosen) {
    throw new Error('No se encontró formato de audio disponible');
  }

  formatCache.set(videoId, {
    format: chosen,
    exp: Date.now() + 3600 * 1000 // 1 hora de caché
  });

  return chosen;
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const videoId = (req.query && req.query.id) || urlObj.searchParams.get('id');

  if (!videoId) {
    return res.status(400).json({ error: 'Falta el id de la canción' });
  }

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    return res.status(204).end();
  }

  try {
    const format = await getAudioFormat(videoId);
    const totalSize = parseInt(format.contentLength, 10) || 0;
    const mimeType = format.mimeType ? format.mimeType.split(';')[0] : 'audio/mp4';

    const rangeHeader = req.headers.range;

    if (rangeHeader && totalSize > 0) {
      // Manejo de peticiones de rango (Range: bytes=start-end)
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

      if (start >= totalSize || end >= totalSize) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }

      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
        'Cache-Control': 'public, max-age=3600'
      });

      const stream = ytdl.download(videoId, {
        format,
        range: { start, end }
      });

      stream.pipe(res);

      req.on('close', () => {
        try { stream.destroy(); } catch {}
      });

      stream.on('error', (err) => {
        console.error('Error en stream de rango:', err);
        try { res.end(); } catch {}
      });
    } else {
      // Petición estándar completa o si no se especificó tamaño previo
      const headers = {
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
        'Cache-Control': 'public, max-age=3600'
      };
      if (totalSize > 0) {
        headers['Content-Length'] = totalSize;
      }

      res.writeHead(200, headers);

      const stream = ytdl.download(videoId, { format });
      stream.pipe(res);

      req.on('close', () => {
        try { stream.destroy(); } catch {}
      });

      stream.on('error', (err) => {
        console.error('Error en stream completo:', err);
        try { res.end(); } catch {}
      });
    }
  } catch (err) {
    console.error('Error en /api/stream:', err);
    formatCache.delete(videoId);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Error al obtener audio' });
    }
  }
}

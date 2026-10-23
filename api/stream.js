// api/stream.js - Streaming de audio nativo con soporte HTTP 206 (Range requests) para iOS Safari y Android
import { Ytdl, Client } from '@distube/ytdl-core';
import { Readable } from 'stream';

const ytdl = new Ytdl({ clients: [Client.VisionOS, Client.Tv] });
const urlCache = new Map();

async function getMediaStreamUrl(videoId) {
  const cached = urlCache.get(videoId);
  if (cached && Date.now() < cached.exp) {
    return cached.url;
  }

  const info = await ytdl.getInfo(videoId);
  const audioFormats = info.formats.filter((f) => f.hasAudio && f.url);
  // Priorizar formato AAC / mp4 para decodificación nativa sin consumo excesivo de batería en iPhone
  const bestMp4 = audioFormats.find((f) => f.mimeType && f.mimeType.includes('mp4') && !f.hasVideo);
  const chosen = bestMp4 || audioFormats.find((f) => !f.hasVideo) || audioFormats[0];

  if (!chosen || !chosen.url) {
    throw new Error('No se encontró URL de audio disponible');
  }

  // Guardar en caché por 1 hora
  urlCache.set(videoId, {
    url: chosen.url,
    exp: Date.now() + 3600 * 1000
  });

  return chosen.url;
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const videoId = (req.query && req.query.id) || urlObj.searchParams.get('id');

  if (!videoId) {
    return res.status(400).json({ error: 'Falta el id del video' });
  }

  try {
    const streamUrl = await getMediaStreamUrl(videoId);

    // Preparar headers para el upstream de Google Video
    const forwardHeaders = {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    };

    if (req.headers && req.headers.range) {
      forwardHeaders['Range'] = req.headers.range;
    }

    const upstream = await fetch(streamUrl, {
      headers: forwardHeaders
    });

    const responseHeaders = {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      'Cache-Control': 'public, max-age=3600'
    };

    if (upstream.headers.has('content-range')) {
      responseHeaders['Content-Range'] = upstream.headers.get('content-range');
    }
    if (upstream.headers.has('content-length')) {
      responseHeaders['Content-Length'] = upstream.headers.get('content-length');
    }

    res.writeHead(upstream.status, responseHeaders);

    // Pipe del stream de audio hacia el navegador del usuario
    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.pipe(res);
      req.on('close', () => {
        try {
          nodeStream.destroy();
        } catch {}
      });
    } else {
      res.end();
    }
  } catch (err) {
    console.error('Error al transmitir audio:', err);
    urlCache.delete(videoId);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

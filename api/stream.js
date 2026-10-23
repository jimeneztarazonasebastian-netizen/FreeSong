// api/stream.js - Obtiene la URL de audio directo para reproducir sin interrupciones
import { Ytdl } from '@distube/ytdl-core';

const ytdl = new Ytdl();

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const videoId = (req.query && req.query.id) || urlObj.searchParams.get('id');

  if (!videoId) {
    const err = JSON.stringify({ error: 'Falta el id del video' });
    if (res && res.status) return res.status(400).send(err);
    return new Response(err, { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const info = await ytdl.getInfo(videoId);
    // Prefer audio/mp4 (AAC) which has universal hardware decoding on iPhone iOS Safari and Android
    const audioFormats = info.formats.filter(f => f.hasAudio && !f.hasVideo);
    
    // Sort by best audio quality
    const bestMp4 = audioFormats.find(f => f.mimeType && f.mimeType.includes('mp4') && f.url);
    const bestAny = audioFormats.find(f => f.url) || audioFormats[0];
    const chosen = bestMp4 || bestAny;

    if (!chosen || !chosen.url) {
      throw new Error('No se encontró URL de audio disponible');
    }

    const payload = JSON.stringify({
      url: chosen.url,
      title: info.videoDetails?.title || '',
      artist: info.videoDetails?.author?.name || '',
      duration: parseInt(info.videoDetails?.lengthSeconds || '0', 10),
      mimeType: chosen.mimeType || 'audio/mp4'
    });

    if (res && res.setHeader) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
      return res.status(200).send(payload);
    }

    return new Response(payload, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=1800, stale-while-revalidate'
      }
    });
  } catch (err) {
    console.error('Error al obtener stream de audio:', err);
    // Fallback: Si ytdl falla por firmas de YouTube, intentamos resolver vía cobalt / piped
    try {
      const pipedInstances = ['https://pipedapi.kavin.rocks', 'https://api.piped.privacy.com.de'];
      for (const inst of pipedInstances) {
        try {
          const pRes = await fetch(`${inst}/streams/${videoId}`, { signal: AbortSignal.timeout(3500) });
          if (pRes.ok) {
            const pData = await pRes.json();
            const aStream = pData.audioStreams?.find(a => a.mimeType?.includes('mp4')) || pData.audioStreams?.[0];
            if (aStream && aStream.url) {
              const payload = JSON.stringify({
                url: aStream.url,
                title: pData.title || '',
                artist: pData.uploader || '',
                duration: pData.duration || 0,
                mimeType: aStream.mimeType || 'audio/mp4'
              });
              if (res && res.setHeader) {
                res.setHeader('Content-Type', 'application/json');
                return res.status(200).send(payload);
              }
              return new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
          }
        } catch {
          // Probar siguiente
        }
      }
    } catch {}

    const errPayload = JSON.stringify({ error: err.message });
    if (res && res.status) return res.status(500).send(errPayload);
    return new Response(errPayload, { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

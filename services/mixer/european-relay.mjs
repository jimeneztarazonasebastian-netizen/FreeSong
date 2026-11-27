const europeanRelay = {
  origin: 'https://eu.yt.chocolatemoo53.com', companion: /^eu\.yt-comp\d+\.chocolatemoo53\.com$/, kind: 'relay-eu'
};
const usRelay = {
  origin: 'https://yt.chocolatemoo53.com', companion: /^yt-comp\d+\.chocolatemoo53\.com$/, kind: 'relay-us'
};
export const relayUserAgent = 'FreeSong-Mixer/1.0 (+https://freesong-pied.vercel.app)';
export const relayPlaybackOrigin = 'https://freesong-pied.vercel.app';
const audioFormats = [
  ['140', 'audio/mp4'], ['139', 'audio/mp4'], ['141', 'audio/mp4'],
  ['251', 'audio/webm'], ['250', 'audio/webm'], ['249', 'audio/webm']
];

function mediaUrl(value, relay, base = relay.origin) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, base);
    const relayHost = url.origin === relay.origin || relay.companion.test(url.hostname);
    if (relayHost && url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash &&
        /^(?:\/companion)?\/videoplayback$/.test(url.pathname)) return url;
  } catch {}
  return null;
}

async function probeAudio(url, relay, expectedType, signal) {
  const headers = { 'User-Agent': relayUserAgent, Origin: relayPlaybackOrigin, Range: 'bytes=0-1023' };
  for (let redirects = 0; redirects <= 2; redirects++) {
    const response = await fetch(url, { headers, signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      url = mediaUrl(response.headers.get('location'), relay, url);
      if (!url) return 'media_redirect';
      continue;
    }
    const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const totalBytes = Number(/^bytes 0-1023\/(\d+)$/i.exec(response.headers.get('content-range') || '')?.[1]);
    if (response.status !== 206 || type !== expectedType || !Number.isSafeInteger(totalBytes) ||
        totalBytes < 1024 || !response.body) {
      void response.body?.cancel().catch(() => {});
      return response.ok ? 'media_format' : `media_${response.status}`;
    }
    const reader = response.body.getReader();
    try {
      // La respuesta puede llegar en varios trozos. Solo se necesita la
      // firma del contenedor para descartar una página de error disfrazada.
      const prefix = Buffer.alloc(expectedType === 'audio/mp4' ? 8 : 4);
      let offset = 0;
      while (offset < prefix.length) {
        const { value, done } = await reader.read();
        if (done) return 'media_empty';
        const bytes = value.subarray(0, prefix.length - offset);
        prefix.set(bytes, offset);
        offset += bytes.byteLength;
      }
      const supported = expectedType === 'audio/mp4' ? prefix.toString('ascii', 4) === 'ftyp' :
        prefix.readUInt32BE() === 0x1a45dfa3;
      return supported ? null : 'media_format';
    } finally { void reader.cancel().catch(() => {}); }
  }
  return 'media_redirect';
}

async function resolveAudio(id, relay, signal) {
  let stage = 'metadata';
  try {
    const response = await fetch(`${relay.origin}/api/v1/videos/${encodeURIComponent(id)}?local=true`, {
      headers: { 'User-Agent': relayUserAgent, Accept: 'application/json' }, signal, redirect: 'error'
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { issue: `metadata_${response.status}` };
    }
    const data = await response.json();
    if (data?.videoId !== id || !Array.isArray(data.adaptiveFormats)) return { issue: 'metadata_format' };
    let mediaIssue;
    const attemptedUrls = new Set();
    // FFmpeg convierte las entradas de audio a AAC antes de servir el HLS.
    for (const [itag, type] of audioFormats) {
      const format = data.adaptiveFormats.find(f => String(f?.itag) === itag);
      const url = mediaUrl(format?.url, relay);
      if (!url || url.origin !== relay.origin || attemptedUrls.has(url.href)) continue;
      attemptedUrls.add(url.href);
      stage = 'media';
      const issue = await probeAudio(url, relay, type, signal);
      if (issue === 'media_429') return { issue };
      if (issue) {
        mediaIssue ??= issue;
        continue;
      }
      const signedDuration = Number(url.searchParams.get('dur'));
      const seconds = Number.isFinite(signedDuration) && signedDuration > 0 ? signedDuration : Number(data.lengthSeconds);
      const duration = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) : null;
      return { kind: relay.kind, url: url.href, duration };
    }
    // Mantener el código histórico que consume el puente de diagnóstico.
    return { issue: mediaIssue ?? 'metadata_no_aac' };
  } catch (error) {
    return { issue: `${stage}_${error.name === 'TimeoutError' ? 'timeout' : 'unavailable'}` };
  }
}

export async function resolveMixerRelayAudio(id, deadline) {
  const primary = await resolveAudio(id, europeanRelay, AbortSignal.any([deadline, AbortSignal.timeout(5500)]));
  if (primary.url) return primary;

  const fallback = await resolveAudio(id, usRelay, AbortSignal.any([deadline, AbortSignal.timeout(3500)]));
  return fallback.url ? { ...fallback, relayIssue: primary.issue } : primary;
}

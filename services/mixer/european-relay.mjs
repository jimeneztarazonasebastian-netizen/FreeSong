const origin = 'https://eu.yt.chocolatemoo53.com';
export const relayUserAgent = 'FreeSong-Mixer/1.0 (+https://freesong-pied.vercel.app)';
export const relayPlaybackOrigin = 'https://freesong-pied.vercel.app';

function mediaUrl(value, base = origin) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, base);
    const relayHost = url.origin === origin || /^eu\.yt-comp\d+\.chocolatemoo53\.com$/.test(url.hostname);
    if (relayHost && url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash &&
        /^(?:\/companion)?\/videoplayback$/.test(url.pathname)) return url;
  } catch {}
  return null;
}

async function probeAudio(url, signal) {
  const headers = { 'User-Agent': relayUserAgent, Origin: relayPlaybackOrigin, Range: 'bytes=0-1023' };
  for (let redirects = 0; redirects <= 2; redirects++) {
    const response = await fetch(url, { headers, signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      url = mediaUrl(response.headers.get('location'), url);
      if (!url) return 'media_redirect';
      continue;
    }
    if (response.status !== 206 || !/^audio\/mp4(?:;|$)/i.test(response.headers.get('content-type') || '') ||
        !/^bytes 0-1023\/\d+$/i.test(response.headers.get('content-range') || '') || !response.body) {
      void response.body?.cancel().catch(() => {});
      return response.ok ? 'media_format' : `media_${response.status}`;
    }
    const reader = response.body.getReader();
    try {
      const { value } = await reader.read();
      return value?.byteLength ? null : 'media_empty';
    } finally { void reader.cancel().catch(() => {}); }
  }
  return 'media_redirect';
}

export async function resolveEuropeanAudio(id) {
  const signal = AbortSignal.timeout(5500);
  let stage = 'metadata';
  try {
    const response = await fetch(`${origin}/api/v1/videos/${encodeURIComponent(id)}?local=true`, {
      headers: { 'User-Agent': relayUserAgent, Accept: 'application/json' }, signal, redirect: 'error'
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { issue: `metadata_${response.status}` };
    }
    const data = await response.json();
    if (data?.videoId !== id || !Array.isArray(data.adaptiveFormats)) return { issue: 'metadata_format' };
    for (const itag of ['140', '139']) {
      const format = data.adaptiveFormats.find(f => String(f?.itag) === itag);
      const url = mediaUrl(format?.url);
      if (!url || url.origin !== origin) continue;
      stage = 'media';
      const issue = await probeAudio(url, signal);
      if (issue) return { issue };
      const seconds = Number(url.searchParams.get('dur'));
      const duration = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) : null;
      return { kind: 'relay-eu', url: url.href, duration };
    }
    return { issue: 'metadata_no_aac' };
  } catch (error) {
    return { issue: `${stage}_${error.name === 'TimeoutError' ? 'timeout' : 'unavailable'}` };
  }
}

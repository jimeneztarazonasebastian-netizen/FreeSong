const europeanRelay = {
  origin: 'https://eu.yt.chocolatemoo53.com', companion: /^eu\.yt-comp\d+\.chocolatemoo53\.com$/, kind: 'relay-eu'
};
const usRelay = {
  origin: 'https://yt.chocolatemoo53.com', companion: /^yt-comp\d+\.chocolatemoo53\.com$/, kind: 'relay-us'
};
export const relayUserAgent = 'FreeSong-Mixer/1.0 (+https://freesong-pied.vercel.app)';
export const relayPlaybackOrigin = 'https://freesong-pied.vercel.app';

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

async function probeAudio(url, relay, signal) {
  const headers = { 'User-Agent': relayUserAgent, Origin: relayPlaybackOrigin, Range: 'bytes=0-1023' };
  for (let redirects = 0; redirects <= 2; redirects++) {
    const response = await fetch(url, { headers, signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      url = mediaUrl(response.headers.get('location'), relay, url);
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
    for (const itag of ['140', '139']) {
      const format = data.adaptiveFormats.find(f => String(f?.itag) === itag);
      const url = mediaUrl(format?.url, relay);
      if (!url || url.origin !== relay.origin || attemptedUrls.has(url.href)) continue;
      attemptedUrls.add(url.href);
      stage = 'media';
      const issue = await probeAudio(url, relay, signal);
      if (issue === 'media_429') return { issue };
      if (issue) {
        mediaIssue ??= issue;
        continue;
      }
      const seconds = Number(url.searchParams.get('dur'));
      const duration = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) : null;
      return { kind: relay.kind, url: url.href, duration };
    }
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

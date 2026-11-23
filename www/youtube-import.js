// Importación de metadatos con la API oficial de YouTube. El token permanece
// en la memoria del navegador y solo se envía a Google.
(() => {
  'use strict';

  const API = 'https://www.googleapis.com/youtube/v3/';
  const PAGE_SIZE = 50;
  const MAX_PAGES = 4;
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const VIDEO_FIELDS = 'id,snippet(title,channelTitle,thumbnails,liveBroadcastContent),contentDetails(duration),status(privacyStatus,uploadStatus)';

  function failure(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function apiError(status, body) {
    const errors = body?.error?.errors;
    const details = body?.error?.details;
    const reasons = [
      ...(Array.isArray(errors) ? errors.map(error => error?.reason) : []),
      ...(Array.isArray(details) ? details.map(error => error?.reason) : [])
    ];
    if (status === 401) {
      return failure('auth', 'La sesión de YouTube venció. Vuelve a conectar tu cuenta.');
    }
    if (status === 429 || reasons.some(reason => /quota|ratelimit|dailylimit/i.test(reason))) {
      return failure('quota', 'YouTube alcanzó su límite de consultas. Inténtalo más tarde.');
    }
    if (reasons.some(reason => /accessnotconfigured|servicedisabled|service_disabled/i.test(reason))) {
      return failure('disabled', 'La API de YouTube todavía no está habilitada para FreeSong.');
    }
    if (reasons.includes('youtubeSignupRequired')) return missingChannel();
    if (status === 403) return failure('forbidden', 'YouTube no dio acceso a esta parte de tu biblioteca.');
    if (status === 404) return failure('not-found', 'YouTube no encontró la lista solicitada.');
    return failure('response', 'YouTube no pudo completar la consulta. Inténtalo de nuevo.');
  }

  async function request(resource, params, token, signal) {
    if (typeof token !== 'string' || !token || /\s/.test(token)) {
      throw failure('auth', 'Conecta tu cuenta de YouTube para importar la biblioteca.');
    }
    if (signal?.aborted) throw new DOMException('Operación cancelada', 'AbortError');
    const url = API + resource + '?' + new URLSearchParams(params);
    let response;
    try {
      response = await window.fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000)
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (signal?.aborted) throw new DOMException('Operación cancelada', 'AbortError');
      throw failure('network', 'No se pudo conectar con YouTube. Revisa tu conexión e inténtalo de nuevo.');
    }
    const data = await response.json().catch(() => null);
    if (signal?.aborted) throw new DOMException('Operación cancelada', 'AbortError');
    if (!response.ok) throw apiError(response.status, data);
    if (!Array.isArray(data?.items)) throw failure('response', 'YouTube devolvió una respuesta incompleta.');
    return data;
  }

  async function readPages(resource, params, token, signal) {
    const items = [];
    const visited = new Set();
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await request(resource, {
        ...params,
        maxResults: String(PAGE_SIZE),
        ...(pageToken ? { pageToken } : {})
      }, token, signal);
      items.push(...data.items.slice(0, PAGE_SIZE));
      pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
      if (!pageToken || visited.has(pageToken)) break;
      visited.add(pageToken);
    }
    return { items, truncated: Boolean(pageToken) };
  }

  function uniqueItems(items, parse) {
    const found = new Map();
    for (const item of items) {
      const entry = parse(item);
      if (entry && !found.has(entry.id)) found.set(entry.id, entry);
    }
    return [...found.values()];
  }

  function thumbnail(thumbnails, fallback = '') {
    for (const size of ['high', 'medium', 'standard', 'default', 'maxres']) {
      const value = thumbnails?.[size]?.url;
      if (typeof value !== 'string') continue;
      try {
        const url = new URL(value);
        if (url.protocol === 'https:' && !url.username && !url.password
            && /(?:^|\.)(?:ytimg\.com|googleusercontent\.com)$/i.test(url.hostname)) return url.href;
      } catch {}
    }
    return fallback;
  }

  function secondsFromDuration(value) {
    const parts = typeof value === 'string' && /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
    if (!parts) return 0;
    const seconds = Number(parts[1] || 0) * 86400 + Number(parts[2] || 0) * 3600
      + Number(parts[3] || 0) * 60 + Number(parts[4] || 0);
    return Number.isSafeInteger(seconds) ? seconds : 0;
  }

  function parseVideo(video) {
    if (typeof video?.id !== 'string' || !VIDEO_ID.test(video.id)) return null;
    const { id, snippet, status, contentDetails } = video;
    const title = typeof snippet?.title === 'string' ? snippet.title.trim() : '';
    const privacy = status?.privacyStatus;
    const upload = status?.uploadStatus;
    const broadcast = snippet?.liveBroadcastContent;
    const duration = secondsFromDuration(contentDetails?.duration);
    if (!title || !duration || privacy !== 'public' ||
        (upload && upload !== 'processed') || (broadcast && broadcast !== 'none')) return null;
    const channel = typeof snippet.channelTitle === 'string' ? snippet.channelTitle : '';
    const artist = channel.replace(/\s+-\s+Topic$/i, '').trim() || 'YouTube';
    return {
      id,
      videoId: id,
      title,
      artist,
      duration,
      durationSeconds: duration,
      durationText: Math.floor(duration / 60) + ':' + String(duration % 60).padStart(2, '0'),
      thumbnail: thumbnail(snippet.thumbnails, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`)
    };
  }

  function validResourceId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  }

  function missingChannel() {
    return failure('channel-required', 'La cuenta elegida necesita un canal de YouTube para importar su biblioteca.');
  }

  async function getChannel(token, { signal } = {}) {
    const { items } = await request('channels', {
      mine: 'true',
      part: 'id,snippet',
      maxResults: '1',
      fields: 'items(id,snippet(title))'
    }, token, signal);
    const channel = items[0];
    if (!validResourceId(channel?.id)) throw missingChannel();
    const title = typeof channel.snippet?.title === 'string' ? channel.snippet.title.trim() : '';
    return { id: channel.id, title: title || 'Canal de YouTube' };
  }

  async function listPlaylists(token, { signal } = {}) {
    const result = await readPages('playlists', {
      mine: 'true',
      part: 'snippet,contentDetails',
      fields: 'nextPageToken,items(id,snippet(title,thumbnails),contentDetails(itemCount))'
    }, token, signal);
    return {
      items: uniqueItems(result.items, (playlist) => {
        const id = playlist?.id;
        const title = playlist?.snippet?.title;
        if (!validResourceId(id) || typeof title !== 'string' || !title.trim()) return null;
        const count = playlist.contentDetails?.itemCount;
        return {
          id,
          title: title.trim(),
          thumbnail: thumbnail(playlist.snippet.thumbnails),
          trackCount: Number.isSafeInteger(count) && count >= 0 ? count : 0
        };
      }),
      truncated: result.truncated
    };
  }

  async function readPlaylist(token, playlistId, { signal } = {}) {
    if (!validResourceId(playlistId)) throw failure('invalid-playlist', 'La lista de YouTube no es válida.');
    const result = await readPages('playlistItems', {
      playlistId,
      part: 'contentDetails',
      fields: 'nextPageToken,items(contentDetails(videoId))'
    }, token, signal);
    const ids = [...new Set(result.items.map(item => item?.contentDetails?.videoId)
      .filter(id => typeof id === 'string' && VIDEO_ID.test(id)))];
    const requests = [];
    for (let i = 0; i < ids.length; i += PAGE_SIZE) {
      requests.push(request('videos', {
        id: ids.slice(i, i + PAGE_SIZE).join(','),
        part: 'snippet,contentDetails,status',
        fields: `items(${VIDEO_FIELDS})`
      }, token, signal));
    }
    const pages = await Promise.all(requests);
    const byId = new Map(uniqueItems(pages.flatMap(page => page.items), parseVideo)
      .map(video => [video.id, video]));
    return { items: ids.map(id => byId.get(id)).filter(Boolean), truncated: result.truncated };
  }

  async function readLikedVideos(token, { signal } = {}) {
    const result = await readPages('videos', {
      myRating: 'like',
      part: 'snippet,contentDetails,status',
      fields: `nextPageToken,items(${VIDEO_FIELDS})`
    }, token, signal);
    return { items: uniqueItems(result.items, parseVideo), truncated: result.truncated };
  }

  window.FreeSongYouTubeImport = { getChannel, listPlaylists, readPlaylist, readLikedVideos };
})();

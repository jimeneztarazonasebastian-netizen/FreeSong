/* FreeSong — reproductor de música (web/PWA para iPhone y app Android con Capacitor). */
'use strict';

// ============================================================================
// 1. Utilidades
// ============================================================================
const $ = (id) => document.getElementById(id);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const safeUrl = (u) => (typeof u === 'string' && /^(https:\/\/|blob:|data:image\/)/i.test(u) ? u : '');
const icon = (name, cls = 'w-5 h-5') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

const songs = (n) => `${n} ${n === 1 ? 'canción' : 'canciones'}`;

function fmtLong(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function hashHue(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

async function fetchJson(url, { timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ============================================================================
// 2. Plataforma
// ============================================================================
const Platform = {
  native: !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()),
  ios: /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  // En iOS la propiedad volume de <audio> es de solo lectura (siempre 1).
  volumeWritable: (() => {
    try { const a = new Audio(); a.volume = 0.5; return a.volume === 0.5; } catch { return false; }
  })(),
  speech: 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
};

function nativePlugin(name) {
  if (!Platform.native) return null;
  try { return window.capacitorExports.registerPlugin(name); } catch { return null; }
}

// ============================================================================
// 3. Catálogo integrado
// ============================================================================
const BUILTIN = [
  { id: 'studio-1', title: 'Midnight Emerald Drive', artist: 'FreeSong Estudio', album: 'Estudio · Synthwave', duration: 215, source: 'synth', synth: { style: 'synthwave', bpm: 118 } },
  { id: 'studio-2', title: 'Bucaramanga Lo-Fi Rain', artist: 'FreeSong Estudio', album: 'Estudio · Lo-Fi', duration: 240, source: 'synth', synth: { style: 'lofi', bpm: 84 } },
  { id: 'studio-3', title: 'Neon Cyberpunk Protocol', artist: 'FreeSong Estudio', album: 'Estudio · Cyber', duration: 198, source: 'synth', synth: { style: 'cyber', bpm: 128 } },
  { id: 'studio-4', title: 'Pacífico Tropical Groove', artist: 'FreeSong Estudio', album: 'Estudio · Tropical', duration: 210, source: 'synth', synth: { style: 'tropical', bpm: 102 } }
];
const BUILTIN_IDS = new Set(BUILTIN.map((t) => t.id));
const OLD_ID_MAP = {};

// País para la radio "cerca de ti" (según el idioma del dispositivo; Colombia si no se sabe)
const COUNTRY = ((navigator.language || '').split('-')[1] || 'CO').toUpperCase();
const RADIO_CATEGORIES = [
  ['local', 'Cerca de ti', { countrycode: COUNTRY }],
  ['reggaeton', 'Reggaetón', { tag: 'reggaeton' }],
  ['latin', 'Latina', { tag: 'latin' }],
  ['salsa', 'Salsa', { tag: 'salsa' }],
  ['vallenato', 'Vallenato', { tag: 'vallenato' }],
  ['electronic', 'Electrónica', { tag: 'electronic' }],
  ['lofi', 'Lo-Fi', { tag: 'lofi' }],
  ['pop', 'Pop', { tag: 'pop' }],
  ['rock', 'Rock', { tag: 'rock' }],
  ['jazz', 'Jazz', { tag: 'jazz' }],
  ['news', 'Noticias', { tag: 'news' }]
];

const GENRES = [
  ['Electronic', 'Electrónica', 265], ['Hip-Hop/Rap', 'Hip-Hop', 15], ['Lo-Fi', 'Lo-Fi', 200],
  ['House', 'House', 160], ['Pop', 'Pop', 330], ['Latin', 'Latina', 40], ['Ambient', 'Ambient', 190],
  ['Techno', 'Techno', 280], ['R&B/Soul', 'R&B', 350], ['Rock', 'Rock', 0], ['Alternative', 'Alternativa', 95],
  ['Jazz', 'Jazz', 30], ['Trap', 'Trap', 300], ['Deep House', 'Deep House', 175], ['Dubstep', 'Dubstep', 120],
  ['Drum & Bass', 'Drum & Bass', 220]
];

const SOURCES = {
  audius: { label: 'Audius', pill: '', icon: 'music' },
  preview: { label: 'Vista previa', pill: '30 s', icon: 'music' },
  youtube: { label: 'YouTube', pill: 'YouTube', icon: 'music' },
  radio: { label: 'Radio en vivo', pill: 'En vivo', icon: 'radio' },
  local: { label: 'Mi archivo', pill: '', icon: 'music' },
  synth: { label: 'Estudio', pill: 'Estudio', icon: 'wave' }
};

const catalog = new Map();
const getTrack = (id) => catalog.get(id);
function addTrack(t) {
  const prev = catalog.get(t.id);
  const merged = prev ? { ...prev, ...t } : t;
  catalog.set(t.id, merged);
  return merged;
}
BUILTIN.forEach(addTrack);

// ============================================================================
// 4. Datos guardados (localStorage) y archivos (IndexedDB)
// ============================================================================
const STORE_KEY = 'freesong:v1';
const META_FIELDS = ['id', 'title', 'artist', 'album', 'duration', 'fullDuration', 'source', 'artworkUrl', 'artworkAlts', 'link', 'audiusId', 'artistId', 'genre', 'audioUrl', 'stationId', 'videoId'];

function defaultData() {
  return {
    likes: [],
    playlists: [],
    tracks: {},
    recent: [],
    settings: {
      volume: 0.85, muted: false, crossfade: 6, leveler: false, dj: false, rate: 1,
      eq: { bass: 0, mid: 0, treble: 0 }, directOutput: Platform.ios, shuffle: false, repeat: 'off',
      previewNoticeSeen: false, ytNoticeSeen: false, ytKey: ''
    }
  };
}

function migrateOld(d) {
  const mapId = (id) => OLD_ID_MAP[id] || id;
  const keep = (id) => BUILTIN_IDS.has(mapId(id));
  try {
    const likes = JSON.parse(localStorage.getItem('spotifree_liked_ids') || 'null');
    if (Array.isArray(likes)) d.likes = likes.filter(keep).map(mapId);
    const pls = JSON.parse(localStorage.getItem('spotifree_playlists') || 'null');
    if (Array.isArray(pls)) {
      d.playlists = pls.map((p) => ({
        id: `pl-${uid()}`,
        name: String(p.name || 'Playlist').replace(/^[\p{Extended_Pictographic}\s]+/u, '') || 'Playlist',
        trackIds: (Array.isArray(p.trackIds) ? p.trackIds : []).filter(keep).map(mapId),
        createdAt: Date.now()
      }));
    }
  } catch { /* datos viejos corruptos: se ignoran */ }
}

function loadData() {
  const base = defaultData();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return {
        ...base, ...d,
        settings: { ...base.settings, ...(d.settings || {}), eq: { ...base.settings.eq, ...(d.settings?.eq || {}) } }
      };
    }
  } catch { /* almacenamiento bloqueado o corrupto */ }
  migrateOld(base);
  return base;
}

const data = loadData();
const S = data.settings;

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* sin espacio o modo privado */ }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

function remember(t) {
  if (!t || BUILTIN_IDS.has(t.id)) return;
  const meta = {};
  for (const k of META_FIELDS) if (t[k] !== undefined && t[k] !== null && t[k] !== '') meta[k] = t[k];
  data.tracks[t.id] = meta;
  save();
}

const Blobs = {
  _db: null,
  open() {
    if (!this._db) {
      this._db = new Promise((resolve, reject) => {
        const req = indexedDB.open('freesong', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('blobs');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this._db;
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', mode);
      const req = fn(tx.objectStore('blobs'));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  get(id) { return this.run('readonly', (s) => s.get(id)); },
  put(id, value) { return this.run('readwrite', (s) => s.put(value, id)); },
  del(id) { return this.run('readwrite', (s) => s.delete(id)); },
  keys() { return this.run('readonly', (s) => s.getAllKeys()); }
};

// ============================================================================
// 5. Fuentes de música: Audius, vistas previas de Apple y letras de LRCLIB
// ============================================================================
const AUDIUS = 'https://api.audius.co/v1';
const APP_NAME = 'FreeSong';

function audiusUrl(path, params = {}) {
  const u = new URL(AUDIUS + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  u.searchParams.set('app_name', APP_NAME);
  return u.toString();
}

function mapAudiusTrack(t) {
  if (!t || t.is_streamable !== true || t.is_stream_gated || t.is_delete || t.access?.stream === false) return null;
  const art = safeUrl(t.artwork?.['480x480'] || t.artwork?.['150x150'] || '');
  // Audius guarda cada carátula en varios servidores; si el principal falla se prueban los espejos.
  const alts = art ? (t.artwork?.mirrors || []).map((m) => safeUrl(art.replace(/^https:\/\/[^/]+/, String(m)))).filter((u) => u && u !== art).slice(0, 3) : [];
  return addTrack({
    id: `audius-${t.id}`,
    audiusId: t.id,
    title: t.title || 'Sin título',
    artist: t.user?.name || 'Artista',
    artistId: t.user?.id,
    album: t.genre || 'Audius',
    genre: t.genre,
    duration: t.duration || 0,
    source: 'audius',
    artworkUrl: art,
    artworkAlts: alts,
    link: t.permalink ? `https://audius.co${t.permalink}` : ''
  });
}

const streamUrl = (t) => audiusUrl(`/tracks/${encodeURIComponent(t.audiusId)}/stream`);

// YouTube: solo se guardan datos del video; la reproducción es con el reproductor oficial
const PIPED_HOSTS = ['https://api.piped.private.coffee', 'https://pipedapi.kavin.rocks'];

function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = String(s || '');
  return t.value;
}

function isoDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  return m ? (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0) : 0;
}

function mapYouTube({ videoId, title, channel, duration }) {
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;
  let artist = String(channel || 'YouTube').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  let name = String(title || 'Video');
  // "Artista - Canción (Official Video)" → "Canción"
  const dash = name.split(/\s+[-–]\s+/);
  if (dash.length > 1 && dash[0].toLowerCase().includes(artist.toLowerCase().slice(0, 4))) {
    artist = dash[0].trim();
    name = dash.slice(1).join(' - ');
  }
  name = name.replace(/\s*[([](official|oficial|video|audio|lyric|letra|visualizer|music video)[^)\]]*[)\]]/gi, '').trim() || title;
  return addTrack({
    id: `yt-${videoId}`,
    videoId,
    title: name,
    artist: artist || 'YouTube',
    album: 'YouTube',
    duration: duration || 0,
    source: 'youtube',
    artworkUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    link: `https://www.youtube.com/watch?v=${videoId}`
  });
}

// Radio Browser: directorio abierto de emisoras (radio-browser.info)
const RADIO_HOSTS = ['de1', 'de2', 'fi1', 'nl1', 'at1'].map((h) => `https://${h}.api.radio-browser.info`);
let radioHost = RADIO_HOSTS[0];

function mapStation(s) {
  const url = safeUrl(s.url_resolved || s.url || '');
  if (!url || !s.stationuuid) return null;
  const tags = String(s.tags || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 3);
  return addTrack({
    id: `radio-${s.stationuuid}`,
    stationId: s.stationuuid,
    // "Caracol Radio (Bogotá) - 100.9 FM / 810 AM - HJGL…" → "Caracol Radio (Bogotá)"
    title: String(s.name || 'Emisora').split(/\s+[-|–]\s+/)[0].trim().slice(0, 60) || 'Emisora',
    artist: [s.state, s.country].filter(Boolean).join(', ') || 'Radio en directo',
    album: tags.length ? tags.join(' · ') : 'Radio en directo',
    duration: 0,
    source: 'radio',
    audioUrl: url,
    artworkUrl: safeUrl(s.favicon || ''),
    link: safeUrl(s.homepage || '')
  });
}

const Api = {
  async trending(genre) {
    const list = await fetchJson(audiusUrl('/tracks/trending', { genre, time: 'week' }));
    return (list.data || []).map(mapAudiusTrack).filter(Boolean).slice(0, 50);
  },
  async searchAudius(q) {
    const list = await fetchJson(audiusUrl('/tracks/search', { query: q }));
    return (list.data || []).map(mapAudiusTrack).filter(Boolean).slice(0, 25);
  },
  async searchArtists(q) {
    const list = await fetchJson(audiusUrl('/users/search', { query: q }));
    return (list.data || []).filter((u) => u.track_count > 0).slice(0, 10).map((u) => ({
      id: u.id, name: u.name, handle: u.handle, followers: u.follower_count || 0,
      avatar: safeUrl(u.profile_picture?.['480x480'] || u.profile_picture?.['150x150'] || '')
    }));
  },
  async artist(id) {
    const [user, tracks] = await Promise.all([
      fetchJson(audiusUrl(`/users/${encodeURIComponent(id)}`)),
      fetchJson(audiusUrl(`/users/${encodeURIComponent(id)}/tracks`, { limit: 50, sort: 'plays' }))
    ]);
    const u = user.data || {};
    return {
      name: u.name || 'Artista',
      avatar: safeUrl(u.profile_picture?.['480x480'] || u.profile_picture?.['150x150'] || ''),
      followers: u.follower_count || 0,
      tracks: (tracks.data || []).map(mapAudiusTrack).filter(Boolean)
    };
  },
  async radio(category) {
    const cat = RADIO_CATEGORIES.find((c) => c[0] === category) || RADIO_CATEGORIES[0];
    const params = new URLSearchParams({ ...cat[2], order: 'clickcount', reverse: 'true', limit: '60', hidebroken: 'true' });
    let lastErr;
    for (const host of [radioHost, ...RADIO_HOSTS.filter((h) => h !== radioHost)]) {
      try {
        const list = await fetchJson(`${host}/json/stations/search?${params}`, { timeout: 9000 });
        radioHost = host;
        const seen = new Set();
        return list.map(mapStation).filter((t) => t && !seen.has(t.title.toLowerCase()) && seen.add(t.title.toLowerCase())).slice(0, 40);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  },
  // YouTube: con la llave oficial de YouTube Data API si el usuario la configuró; si no, Piped.
  async searchYouTube(q) {
    if (S.ytKey) {
      const base = 'https://www.googleapis.com/youtube/v3';
      const found = await fetchJson(`${base}/search?${new URLSearchParams({
        part: 'snippet', type: 'video', videoEmbeddable: 'true', videoCategoryId: '10', maxResults: '20', q, key: S.ytKey
      })}`);
      const ids = (found.items || []).map((i) => i.id?.videoId).filter(Boolean);
      if (!ids.length) return [];
      const details = await fetchJson(`${base}/videos?${new URLSearchParams({ part: 'contentDetails,snippet', id: ids.join(','), key: S.ytKey })}`);
      return (details.items || []).map((v) => mapYouTube({
        videoId: v.id,
        title: decodeEntities(v.snippet?.title),
        channel: decodeEntities(v.snippet?.channelTitle),
        duration: isoDuration(v.contentDetails?.duration)
      })).filter(Boolean);
    }
    let lastErr;
    for (const host of PIPED_HOSTS) {
      try {
        const res = await fetchJson(`${host}/search?${new URLSearchParams({ q, filter: 'music_songs' })}`, { timeout: 9000 });
        return (res.items || []).filter((i) => i.url && i.duration > 0).slice(0, 20).map((i) => mapYouTube({
          videoId: new URLSearchParams(i.url.split('?')[1] || '').get('v'),
          title: i.title,
          channel: i.uploaderName,
          duration: i.duration
        })).filter(Boolean);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Búsqueda de YouTube no disponible');
  },
  // Radio Browser pide registrar cada reproducción para ordenar las emisoras más escuchadas.
  countRadioClick(t) {
    if (t.stationId) fetch(`${radioHost}/json/url/${encodeURIComponent(t.stationId)}`).catch(() => {});
  },
  async searchPreviews(q) {
    const res = await fetchJson(`https://itunes.apple.com/search?${new URLSearchParams({ term: q, media: 'music', entity: 'song', limit: '20' })}`);
    return (res.results || []).filter((r) => r.previewUrl).map((r) => addTrack({
      id: `itunes-${r.trackId}`,
      title: r.trackName || 'Canción',
      artist: r.artistName || 'Artista',
      album: r.collectionName || 'Single',
      duration: 30,
      fullDuration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 0,
      source: 'preview',
      audioUrl: safeUrl(r.previewUrl),
      artworkUrl: safeUrl((r.artworkUrl100 || '').replace('100x100bb', '600x600bb')),
      link: safeUrl(r.trackViewUrl || '')
    }));
  },
  async lyrics(t) {
    const title = t.title.replace(/\s*[([].*?(feat|ft\.|prod|remix|official|video|audio|lyric).*?[)\]]/gi, '').trim();
    const params = new URLSearchParams({ artist_name: t.artist, track_name: title });
    const dur = t.source === 'preview' ? t.fullDuration : t.duration;
    if (dur) params.set('duration', String(Math.round(dur)));
    try {
      return await fetchJson(`https://lrclib.net/api/get?${params}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const res = await fetchJson(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: title, artist_name: t.artist })}`);
    if (!Array.isArray(res) || !res.length) return null;
    return res.find((r) => r.syncedLyrics) || res[0];
  }
};

// ============================================================================
// 6. Motor de audio (Web Audio: ecualizador, nivelador, espectro)
// ============================================================================
const Engine = {
  ctx: null,
  ensure() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = (this.ctx = new AC({ latencyHint: 'playback' }));

    this.input = ctx.createGain();
    this.bass = ctx.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = 80;
    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 0.9;
    this.treble = ctx.createBiquadFilter();
    this.treble.type = 'highshelf';
    this.treble.frequency.value = 8000;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -26;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.25;
    this.compGain = ctx.createGain();
    this.compGain.gain.value = 1.5;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.82;
    this.master = ctx.createGain();
    this.synthBus = ctx.createGain();

    this.synthBus.connect(this.input);
    this.input.connect(this.bass);
    this.bass.connect(this.mid);
    this.mid.connect(this.treble);
    this.connectLeveler();
    this.analyser.connect(this.master);
    this.master.connect(ctx.destination);
    this.applyEq();
    this.applyVolume();
    return ctx;
  },
  connectLeveler() {
    if (!this.ctx) return;
    [this.treble, this.comp, this.compGain].forEach((n) => n.disconnect());
    if (S.leveler) {
      this.treble.connect(this.comp);
      this.comp.connect(this.compGain);
      this.compGain.connect(this.analyser);
    } else {
      this.treble.connect(this.analyser);
    }
  },
  applyEq() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.bass.gain.setTargetAtTime(S.eq.bass, t, 0.05);
    this.mid.gain.setTargetAtTime(S.eq.mid, t, 0.05);
    this.treble.gain.setTargetAtTime(S.eq.treble, t, 0.05);
  },
  masterLevel() {
    return S.muted ? 0 : S.volume * S.volume;
  },
  applyVolume(duck = 1) {
    if (this.master) this.master.gain.setTargetAtTime(this.masterLevel() * duck, this.ctx.currentTime, 0.08);
    Player.allDecks().forEach((d) => d.applyDirectVolume());
  }
};

// Un "deck" es un elemento <audio>. Hay dos para poder hacer crossfade.
// El deck "live" es para emisoras de radio: muchas no permiten CORS, así que suenan
// directo (sin ecualizador) para no quedar en silencio.
class Deck {
  constructor(name, { live = false } = {}) {
    this.name = name;
    this.live = live;
    this.level = 1;
    this.trackId = null;
    this.objectUrl = null;
    this.routed = false;
    this.el = new Audio();
    this.el.preload = live ? 'none' : 'auto';
    if (!live) this.el.crossOrigin = 'anonymous';
    this.el.setAttribute('playsinline', '');
    for (const ev of ['timeupdate', 'ended', 'error', 'waiting', 'stalled', 'playing', 'loadedmetadata', 'pause']) {
      this.el.addEventListener(ev, (e) => Player.onDeckEvent(this, e));
    }
  }
  route() {
    if (this.routed || this.live || S.directOutput) return;
    const ctx = Engine.ensure();
    if (!ctx) return;
    try {
      this.src = ctx.createMediaElementSource(this.el);
      // Filtro pasa-altos por deck: en el crossfade le quita los bajos a la canción que sale
      this.hp = ctx.createBiquadFilter();
      this.hp.type = 'highpass';
      this.hp.frequency.value = 10;
      this.hp.Q.value = 0.7;
      this.gain = ctx.createGain();
      this.gain.gain.value = this.level;
      this.src.connect(this.hp);
      this.hp.connect(this.gain);
      this.gain.connect(Engine.input);
      this.routed = true;
      this.el.volume = 1;
    } catch (e) {
      console.warn('No se pudo conectar el audio al ecualizador', e);
    }
  }
  setLevel(v) {
    this.level = v;
    if (this.routed) {
      const g = this.gain.gain;
      const now = Engine.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(v, now);
    } else {
      this.applyDirectVolume();
    }
  }
  applyDirectVolume() {
    if (this.routed) return;
    try { this.el.volume = clamp(this.level * Engine.masterLevel(), 0, 1); } catch { /* iOS */ }
  }
  resetFilter() {
    if (!this.hp) return;
    const f = this.hp.frequency, now = Engine.ctx.currentTime;
    f.cancelScheduledValues(now);
    f.setValueAtTime(10, now);
  }
  load(track, url) {
    this.stop();
    this.release();
    this.resetFilter();
    this.trackId = track.id;
    if (url.startsWith('blob:')) this.objectUrl = url;
    this.el.src = url;
    this.applyRate();
  }
  applyRate() {
    const r = this.live ? 1 : S.rate || 1;
    this.el.playbackRate = r;
    // Slowed / Nightcore cambian también el tono, como en los edits originales.
    const keepPitch = r === 1;
    this.el.preservesPitch = keepPitch;
    this.el.webkitPreservesPitch = keepPitch;
  }
  stop() {
    try { this.el.pause(); } catch { /* nada */ }
  }
  unload() {
    this.stop();
    this.trackId = null;
    this.el.removeAttribute('src');
    try { this.el.load(); } catch { /* nada */ }
    this.release();
  }
  release() {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}

// ============================================================================
// 6b. YouTube oficial (IFrame Player API)
// Se usa el reproductor oficial y visible de YouTube, como pide YouTube: el video se
// muestra en un recuadro de al menos 200×200 px. No se extrae ni se oculta el audio.
// ============================================================================
const YTApi = {
  ready: null,
  load() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (!this.ready) {
      this.ready = new Promise((resolve, reject) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.async = true;
        s.onerror = () => { this.ready = null; reject(new Error('No se pudo cargar YouTube')); };
        document.head.appendChild(s);
      });
    }
    return this.ready;
  }
};

const YT_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// Adaptador: expone la misma forma que un deck de <audio> para que el reproductor
// (cola, crossfade, posición, pantalla bloqueada) funcione igual con YouTube.
class YTDeck {
  constructor(name) {
    this.name = name;
    this.yt = true;
    this.live = false;
    this.routed = false;
    this.level = 1;
    this.trackId = null;
    this.state = -1;
    this.errorCode = null;
    this.player = null;
    this.ready = null;
    this.listeners = new Map();
    this.poll = null;
    this.host = document.createElement('div');
    this.host.className = 'yt-host absolute inset-0 transition-opacity duration-700';
    this.host.innerHTML = '<div></div>';
    $('videoDock').appendChild(this.host);
    const deck = this;
    this.el = {
      get currentTime() { try { return deck.player?.getCurrentTime?.() || 0; } catch { return 0; } },
      set currentTime(v) { try { deck.player?.seekTo?.(v, true); } catch { /* aún no listo */ } },
      get duration() { try { const d = deck.player?.getDuration?.(); return d > 0 ? d : NaN; } catch { return NaN; } },
      get paused() { return deck.state !== 1 && deck.state !== 3; },
      get ended() { return deck.state === 0; },
      get readyState() { return deck.state === 1 ? 4 : 1; },
      get error() { return deck.errorCode ? { code: deck.errorCode, message: `YouTube ${deck.errorCode}` } : null; },
      getAttribute: () => (deck.trackId ? 'yt' : null),
      play: () => deck.play(),
      pause: () => { try { deck.player?.pauseVideo?.(); } catch { /* nada */ } },
      addEventListener: (type, fn) => { if (!deck.listeners.has(type)) deck.listeners.set(type, new Set()); deck.listeners.get(type).add(fn); },
      removeEventListener: (type, fn) => deck.listeners.get(type)?.delete(fn)
    };
  }
  emit(type) {
    this.listeners.get(type)?.forEach((fn) => fn({ type }));
    Player.onDeckEvent(this, { type });
  }
  ensurePlayer() {
    // La promesa se guarda de inmediato: así dos llamadas seguidas no crean dos reproductores
    if (this.ready) return this.ready;
    this.ready = YTApi.load().then(() => new Promise((resolve, reject) => {
      VideoDock.update();
      // Si YouTube no responde, se descarta este reproductor para reintentarlo después
      const timer = setTimeout(() => {
        try { this.player?.destroy?.(); } catch { /* nada */ }
        this.player = null;
        this.host.innerHTML = '<div></div>';
        reject(new Error('YouTube no respondió'));
      }, 45000);
      this.player = new window.YT.Player(this.host.firstElementChild, {
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, enablejsapi: 1, origin: location.origin, iv_load_policy: 3 },
        events: {
          onReady: () => { clearTimeout(timer); resolve(); },
          onStateChange: (e) => this.onState(e.data),
          onError: (e) => { this.errorCode = e.data; this.emit('error'); }
        }
      });
    })).catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }
  onState(s) {
    this.state = s;
    clearInterval(this.poll);
    if (s === 1) {
      this.applyDirectVolume();
      this.poll = setInterval(() => this.emit('timeupdate'), 250);
      this.emit('playing');
    } else if (s === 3) {
      this.emit('waiting');
    } else if (s === 2) {
      this.emit('pause');
    } else if (s === 0) {
      this.emit('ended');
    }
  }
  route() { /* YouTube no pasa por Web Audio */ }
  resetFilter() {}
  release() {}
  load(track, url, startAt = 0) {
    this.trackId = track.id;
    this.errorCode = null;
    this.state = -1;
    this.pendingVideo = { videoId: track.videoId, startSeconds: Math.floor(startAt || 0) };
    this.ensurePlayer().then(() => {
      if (this.trackId !== track.id) return;
      this.applyDirectVolume();
      this.player.loadVideoById(this.pendingVideo);
      this.applyRate();
    }).catch(() => { this.errorCode = 'api'; this.emit('error'); });
  }
  play() {
    return this.ensurePlayer().then(() => {
      if (this.state !== -1) this.player.playVideo();
      // Algunos navegadores (sobre todo iPhone) piden tocar el video la primera vez
      setTimeout(() => {
        if (this.trackId && (this.state === -1 || this.state === 5) && Player.deck === this && Player.playing) {
          toast('Toca el video para empezar');
        }
      }, 3000);
    });
  }
  setLevel(v) {
    this.level = v;
    this.applyDirectVolume();
  }
  applyDirectVolume() {
    try { this.player?.setVolume?.(Math.round(clamp(this.level * Engine.masterLevel(), 0, 1) * 100)); } catch { /* aún no listo */ }
  }
  applyRate() {
    const r = S.rate || 1;
    const near = YT_RATES.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a), 1);
    try { this.player?.setPlaybackRate?.(near); } catch { /* nada */ }
  }
  stop() {
    try { this.player?.pauseVideo?.(); } catch { /* nada */ }
  }
  unload() {
    this.trackId = null;
    clearInterval(this.poll);
    try { this.player?.stopVideo?.(); } catch { /* nada */ }
    this.state = -1;
  }
}

// Recuadro del video: un único contenedor fijo que se coloca sobre el "hueco" que toque
// (panel lateral en computador, flotante en el celular, o la portada del reproductor grande).
// Así el iframe nunca se mueve en el DOM (moverlo lo recargaría).
const VideoDock = {
  raf: null,
  active() { return Player.current?.source === 'youtube'; },
  update() {
    const on = this.active();
    $('videoDock').classList.toggle('hidden', !on);
    $('videoSlotSide').classList.toggle('hidden', !on);
    document.body.dataset.video = String(on);
    Player.ytDecks.forEach((d, i) => {
      const top = i === Player.ytActive;
      d.host.style.zIndex = top ? '2' : '1';
      d.host.classList.toggle('opacity-0', !top && !Player.fade);
    });
    if (on) this.place();
    if (on && !this.raf) this.loop();
  },
  // Coloca el recuadro ya (YouTube no inicia reproductores de menos de 200×200 px)
  place() {
    const r = this.target().getBoundingClientRect();
    const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    Object.assign($('videoDock').style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    // Asa para arrastrar (solo en modo flotante): justo encima del video, sin taparlo
    Object.assign($('videoHandle').style, { left: `${r.left}px`, top: `${r.top - 24}px`, width: `${r.width}px` });
  },
  // Arrastrar el video flotante por la pantalla (celular); la posición se recuerda
  initDrag() {
    const slot = $('videoSlotFloat');
    const handle = $('videoHandle');
    const apply = (x, y) => {
      const maxX = window.innerWidth - 200 - 8;
      const maxY = window.innerHeight - 200 - 8;
      const cx = clamp(x, 8, Math.max(8, maxX));
      const cy = clamp(y, 32, Math.max(32, maxY));
      slot.style.setProperty('--vf-x', `${cx}px`);
      slot.style.setProperty('--vf-y', `${cy}px`);
      return [cx, cy];
    };
    if (S.videoPos) apply(...S.videoPos);
    let start = null;
    handle.addEventListener('pointerdown', (e) => {
      const r = slot.getBoundingClientRect();
      start = { px: e.clientX, py: e.clientY, x: r.left, y: r.top };
      handle.setPointerCapture(e.pointerId);
      handle.classList.replace('cursor-grab', 'cursor-grabbing');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      apply(start.x + e.clientX - start.px, start.y + e.clientY - start.py);
    });
    const end = () => {
      if (!start) return;
      const r = slot.getBoundingClientRect();
      S.videoPos = apply(r.left, r.top);
      save();
      start = null;
      handle.classList.replace('cursor-grabbing', 'cursor-grab');
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => { if (S.videoPos) apply(...S.videoPos); });
  },
  target() {
    if (Sheet.open) return $('sheetCover');
    if (window.matchMedia('(min-width: 1024px)').matches) return $('videoSlotSide');
    return $('videoSlotFloat');
  },
  loop() {
    const step = () => {
      if (!this.active()) { this.raf = null; return; }
      this.place();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
};

// ============================================================================
// 7. Sintetizador del Estudio (funciona sin internet)
// ============================================================================
const SCALES = {
  synthwave: [110, 130.81, 146.83, 164.81, 196.0, 220.0, 261.63, 293.66],
  lofi: [130.81, 155.56, 174.61, 196.0, 233.08, 261.63, 311.13, 349.23],
  cyber: [98.0, 116.54, 130.81, 146.83, 174.61, 196.0, 233.08, 261.63],
  tropical: [146.83, 164.81, 196.0, 220.0, 246.94, 293.66, 329.63, 392.0]
};

const Synth = {
  track: null, playing: false, offset: 0, startedAt: 0, step: 0, nextTime: 0, timer: null,
  rate() { return S.rate || 1; },
  stepDur() { return 60 / (this.track.synth.bpm || 110) / 2 / this.rate(); },
  get position() {
    if (!this.track) return 0;
    if (!this.playing) return this.offset;
    return this.offset + (Engine.ctx.currentTime - this.startedAt) * this.rate();
  },
  start(track, at = 0) {
    const ctx = Engine.ensure();
    if (!ctx) return;
    this.halt();
    this.track = track;
    this.offset = at;
    this.startedAt = ctx.currentTime;
    this.playing = true;
    this.step = Math.floor(at / this.stepDur());
    this.nextTime = ctx.currentTime + 0.05;
    const g = Engine.synthBus.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(0.0001, ctx.currentTime);
    g.linearRampToValueAtTime(1, ctx.currentTime + 0.3);
    this.timer = setInterval(() => this.schedule(), 25);
    this.uiTimer = setInterval(() => Player.onSynthTick(), 250);
  },
  schedule() {
    const ctx = Engine.ctx;
    // Si la pestaña estuvo en segundo plano no se intenta "recuperar" notas atrasadas
    if (ctx.currentTime - this.nextTime > 0.5) this.nextTime = ctx.currentTime + 0.02;
    while (this.nextTime < ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextTime);
      this.step++;
      this.nextTime += this.stepDur();
    }
    if (this.position >= this.track.duration && Player.currentId === this.track.id) Player.onSynthEnded();
  },
  playStep(i, t) {
    const style = this.track.synth.style;
    const pal = SCALES[style] || SCALES.synthwave;
    const s = i % 16;
    if (s % 4 === 0 || (style === 'tropical' && s % 8 === 3)) this.kick(t);
    this.voice(pal[s % 4], 'sawtooth', 0.22, 0.13, t);
    if (s % 4 === 2) {
      this.voice(pal[2] * 2, 'triangle', 0.35, 0.07, t);
      this.voice(pal[4] * 2, 'sine', 0.35, 0.07, t);
    }
    if (s % 2 === 0 || s === 7 || s === 15) {
      this.voice(pal[(s * 3 + Math.floor(i / 8)) % pal.length] * 2, 'sine', 0.28, 0.1, t);
    }
  },
  voice(freq, type, dur, gain, t) {
    const ctx = Engine.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    osc.connect(g);
    g.connect(Engine.synthBus);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  },
  kick(t) {
    const ctx = Engine.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(135, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.14);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(g);
    g.connect(Engine.synthBus);
    osc.start(t);
    osc.stop(t + 0.2);
  },
  pause() {
    if (!this.playing) return;
    this.offset = this.position;
    this.halt();
  },
  resume() {
    if (this.track) this.start(this.track, this.offset);
  },
  seek(sec) {
    if (!this.track) return;
    if (this.playing) this.start(this.track, sec);
    else this.offset = sec;
  },
  rerate() {
    if (this.playing) this.start(this.track, this.position);
  },
  fadeOut(sec) {
    if (!this.playing || !Engine.ctx) return;
    const now = Engine.ctx.currentTime;
    const g = Engine.synthBus.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0.0001, now + sec);
    setTimeout(() => { if (Player.current?.source !== 'synth') this.stopAll(); }, sec * 1000 + 50);
  },
  halt() {
    clearInterval(this.timer);
    clearInterval(this.uiTimer);
    this.timer = this.uiTimer = null;
    this.playing = false;
  },
  stopAll() {
    this.halt();
    this.track = null;
    this.offset = 0;
  }
};

// ============================================================================
// 8. Controles del sistema (pantalla bloqueada, notificación, audífonos)
// ============================================================================
const Media = {
  plugin: nativePlugin('MediaSession'),
  web: 'mediaSession' in navigator,
  iconData: '',
  lastPos: 0,
  async init() {
    const handlers = {
      play: () => Player.resume(),
      pause: () => Player.pause(),
      stop: () => Player.pause(),
      previoustrack: () => Player.prev(),
      nexttrack: () => Player.next(),
      seekbackward: () => Player.seek(Player.position() - 10),
      seekforward: () => Player.seek(Player.position() + 10),
      seekto: (d) => { if (d && d.seekTime != null) Player.seek(d.seekTime); }
    };
    for (const [action, fn] of Object.entries(handlers)) {
      if (this.plugin) {
        try { await this.plugin.setActionHandler({ action }, fn); } catch { /* acción no soportada */ }
      }
      if (this.web) {
        try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* acción no soportada */ }
      }
    }
    if (this.plugin) {
      try {
        const blob = await (await fetch('icons/icon-512.png')).blob();
        this.iconData = await new Promise((res) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = () => res('');
          r.readAsDataURL(blob);
        });
      } catch { /* sin ícono */ }
    }
  },
  setMetadata(t) {
    const art = safeUrl(t.artworkUrl);
    const meta = { title: t.title, artist: t.artist, album: t.album || 'FreeSong' };
    if (this.plugin) {
      const src = art && art.startsWith('https') ? art : this.iconData;
      this.plugin.setMetadata({ ...meta, artwork: src ? [{ src }] : [] }).catch(() => {});
    }
    if (this.web && 'MediaMetadata' in window) {
      const artwork = art && !art.startsWith('blob:')
        ? [{ src: art, sizes: '480x480', type: 'image/jpeg' }]
        : [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }];
      try { navigator.mediaSession.metadata = new MediaMetadata({ ...meta, artwork }); } catch { /* nada */ }
    }
  },
  setState() {
    const state = Player.current ? (Player.playing ? 'playing' : 'paused') : 'none';
    if (this.plugin) this.plugin.setPlaybackState({ playbackState: state }).catch(() => {});
    if (this.web) {
      try { navigator.mediaSession.playbackState = state; } catch { /* nada */ }
    }
    this.setPosition(true);
  },
  setPosition(force = false) {
    const now = Date.now();
    if (!force && now - this.lastPos < 5000) return;
    this.lastPos = now;
    const duration = Player.duration();
    if (!Number.isFinite(duration) || duration <= 0) return;
    const state = { duration, position: clamp(Player.position(), 0, duration), playbackRate: S.rate || 1 };
    if (this.plugin) this.plugin.setPositionState(state).catch(() => {});
    if (this.web && navigator.mediaSession.setPositionState) {
      try { navigator.mediaSession.setPositionState(state); } catch { /* nada */ }
    }
  }
};

// ============================================================================
// 9. Descargas y archivos propios
// ============================================================================
const Downloads = {
  ids: new Set(),
  progress: new Map(),
  async init() {
    try { (await Blobs.keys()).forEach((k) => this.ids.add(k)); } catch { /* IndexedDB no disponible */ }
  },
  has(id) { return this.ids.has(id); },
  async download(t) {
    if (t.source !== 'audius' || this.ids.has(t.id) || this.progress.has(t.id)) return;
    if (!navigator.onLine) return toast('Necesitas internet para descargar');
    this.progress.set(t.id, 0);
    UI.refreshTrackStates();
    toast(`Descargando "${t.title}"`);
    try {
      const res = await fetch(streamUrl(t));
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0, lastPaint = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (total && Date.now() - lastPaint > 400) {
          this.progress.set(t.id, got / total);
          lastPaint = Date.now();
          UI.refreshTrackStates();
        }
      }
      const blob = new Blob(chunks, { type: res.headers.get('content-type') || 'audio/mpeg' });
      await Blobs.put(t.id, { blob, size: blob.size, savedAt: Date.now() });
      this.ids.add(t.id);
      remember(t);
      navigator.storage?.persist?.().catch(() => {});
      toast(`"${t.title}" ya está disponible sin internet`);
    } catch (e) {
      console.warn(e);
      toast(e.name === 'QuotaExceededError' ? 'No hay espacio suficiente en el dispositivo' : 'No se pudo descargar la canción');
    } finally {
      this.progress.delete(t.id);
      UI.refreshTrackStates();
      UI.renderLibrary();
    }
  },
  async remove(t) {
    try { await Blobs.del(t.id); } catch { /* nada */ }
    this.ids.delete(t.id);
    if (t.source === 'local') {
      catalog.delete(t.id);
      delete data.tracks[t.id];
      data.likes = data.likes.filter((id) => id !== t.id);
      data.recent = data.recent.filter((id) => id !== t.id);
      data.playlists.forEach((p) => { p.trackIds = p.trackIds.filter((id) => id !== t.id); });
      Player.userQueue = Player.userQueue.filter((id) => id !== t.id);
      save();
      toast('Archivo eliminado del dispositivo');
    } else {
      toast('Descarga eliminada');
    }
    UI.renderAll();
  }
};

function parseFileName(name) {
  const clean = name.replace(/\.[^/.]+$/, '').replace(/_/g, ' ').trim();
  const parts = clean.split(/\s+[-–]\s+/);
  if (parts.length > 1) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: 'Mis archivos', title: clean };
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = () => {
      const d = Number.isFinite(a.duration) ? a.duration : 0;
      URL.revokeObjectURL(url);
      resolve(d);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = done;
    a.onerror = done;
    setTimeout(done, 5000);
    a.src = url;
  });
}

async function importFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(f.name));
  if (!files.length) return toast('Elige archivos de audio (MP3, M4A, FLAC, WAV…)');
  toast(`Importando ${files.length} archivo(s)…`);
  const ids = [];
  for (const f of files) {
    const { artist, title } = parseFileName(f.name);
    const id = `local-${uid()}`;
    const duration = await probeDuration(f);
    try {
      await Blobs.put(id, { blob: f, name: f.name, size: f.size, savedAt: Date.now() });
    } catch (e) {
      toast(e.name === 'QuotaExceededError' ? 'No hay espacio para más archivos' : 'No se pudo guardar un archivo');
      continue;
    }
    const t = addTrack({ id, title, artist, album: 'Mis archivos', duration, source: 'local' });
    Downloads.ids.add(id);
    remember(t);
    ids.push(id);
  }
  navigator.storage?.persist?.().catch(() => {});
  if (!ids.length) return;
  toast(`${ids.length} canción(es) importadas`);
  Nav.go({ type: 'list', kind: 'local' });
  Player.playContext(localIds(), 0, 'Mis archivos', 'local');
}

const localIds = () => [...catalog.values()].filter((t) => t.source === 'local').map((t) => t.id).reverse();
const downloadedIds = () => [...Downloads.ids].filter((id) => getTrack(id)?.source === 'audius');

async function resolveUrl(t) {
  if (t.source === 'youtube') {
    if (!navigator.onLine) throw new Error('Sin conexión: YouTube necesita internet');
    return `yt:${t.videoId}`;
  }
  if (Downloads.has(t.id)) {
    const rec = await Blobs.get(t.id);
    if (rec?.blob) return URL.createObjectURL(rec.blob);
  }
  if (t.source === 'local') throw new Error('Este archivo ya no está en el dispositivo');
  if (!navigator.onLine) throw new Error('Sin conexión: solo suenan descargas, tus archivos, el Estudio');
  if (t.source === 'audius') return streamUrl(t);
  if (!safeUrl(t.audioUrl)) throw new Error('Esta canción no tiene audio disponible');
  return t.audioUrl;
}

// ============================================================================
// 10. Reproductor: cola, crossfade, aleatorio, repetir
// ============================================================================
const Player = {
  decks: [new Deck('A'), new Deck('B')],
  liveDeck: new Deck('live', { live: true }),
  active: 0,
  currentId: null,
  playing: false,
  buffering: false,
  transitioning: false,
  ctx: { ids: [], label: '', key: '' },
  order: [],
  pos: -1,
  userQueue: [],
  fromUserQueue: false,
  fade: null,
  errorStreak: 0,
  stopAfterCurrent: false,
  token: 0,

  ytDecks: [],
  ytActive: 0,
  get deck() {
    const s = this.current?.source;
    if (s === 'radio') return this.liveDeck;
    if (s === 'youtube') return this.ytDecks[this.ytActive];
    return this.decks[this.active];
  },
  get other() { return this.decks[1 - this.active]; },
  allDecks() { return [...this.decks, this.liveDeck, ...this.ytDecks]; },
  get current() { return getTrack(this.currentId); },
  isSynth() { return this.current?.source === 'synth'; },

  position() {
    if (!this.current) return 0;
    if (this.isSynth()) return Synth.position;
    return this.deck.el.currentTime || 0;
  },
  duration() {
    const t = this.current;
    if (!t) return 0;
    if (t.source === 'radio') return Infinity;
    if (t.source === 'synth') return t.duration;
    const d = this.deck.el.duration;
    return Number.isFinite(d) && d > 0 ? d : t.duration || 0;
  },
  canCrossfade() {
    return !S.directOutput || Platform.volumeWritable;
  },

  // --- Cola ---
  playContext(ids, index, label, key, { shuffle } = {}) {
    const list = ids.filter((id) => catalog.has(id));
    if (!list.length) return;
    if (shuffle !== undefined && shuffle !== S.shuffle) {
      S.shuffle = shuffle;
      save();
    }
    this.ctx = { ids: list, label, key };
    const start = index < 0 ? Math.floor(Math.random() * list.length) : clamp(index, 0, list.length - 1);
    this.buildOrder(start);
    this.fromUserQueue = false;
    this.start(getTrack(list[this.order[this.pos]]));
  },
  buildOrder(startIdx) {
    const all = [...this.ctx.ids.keys()];
    if (S.shuffle) {
      this.order = [startIdx, ...shuffled(all.filter((i) => i !== startIdx))];
      this.pos = 0;
    } else {
      this.order = all;
      this.pos = startIdx;
    }
  },
  ctxIdAt(pos) { return this.ctx.ids[this.order[pos]]; },
  peekNext(auto = false) {
    if (auto && S.repeat === 'one' && this.currentId) return { id: this.currentId, kind: 'repeat' };
    if (this.userQueue.length) return { id: this.userQueue[0], kind: 'user' };
    if (this.pos + 1 < this.order.length) return { id: this.ctxIdAt(this.pos + 1), kind: 'ctx' };
    if (S.repeat === 'all' && this.order.length) return { id: this.ctxIdAt(0), kind: 'wrap' };
    return null;
  },
  upcoming(limit = 40) {
    const out = [];
    for (let p = this.pos + 1; p < this.order.length && out.length < limit; p++) out.push({ id: this.ctxIdAt(p), pos: p });
    if (S.repeat === 'all') for (let p = 0; p <= this.pos && out.length < limit; p++) out.push({ id: this.ctxIdAt(p), pos: p });
    return out;
  },
  next({ auto = false, fade = 0 } = {}) {
    if (auto && this.stopAfterCurrent) {
      this.stopAfterCurrent = false;
      Sleep.clear();
      this.pause();
      this.seek(0);
      toast('Temporizador: se detuvo al terminar la canción');
      return;
    }
    const n = this.peekNext(auto);
    if (!n) {
      if (auto) {
        this.pause();
        this.seek(0);
      } else {
        toast('No hay más canciones en la cola');
      }
      return;
    }
    if (n.kind === 'user') {
      this.userQueue.shift();
      this.fromUserQueue = true;
    } else if (n.kind === 'ctx') {
      this.pos++;
      this.fromUserQueue = false;
    } else if (n.kind === 'wrap') {
      if (S.shuffle) this.buildOrder(this.order[0]);
      else this.pos = 0;
      this.fromUserQueue = false;
    }
    this.start(getTrack(n.id), { fade });
  },
  prev() {
    if (!this.current) return;
    if (this.position() > 3 && this.current.source !== 'radio') {
      this.seek(0);
      return;
    }
    if (this.fromUserQueue && this.pos >= 0) {
      this.fromUserQueue = false;
      this.start(getTrack(this.ctxIdAt(this.pos)));
    } else if (this.pos > 0) {
      this.pos--;
      this.start(getTrack(this.ctxIdAt(this.pos)));
    } else if (S.repeat === 'all' && this.order.length > 1) {
      this.pos = this.order.length - 1;
      this.start(getTrack(this.ctxIdAt(this.pos)));
    } else {
      this.seek(0);
    }
  },
  jumpTo(pos) {
    this.pos = pos;
    this.fromUserQueue = false;
    this.start(getTrack(this.ctxIdAt(pos)));
  },
  playFromUserQueue(index) {
    const [id] = this.userQueue.splice(0, index + 1).slice(-1);
    this.fromUserQueue = true;
    this.start(getTrack(id));
  },
  addToQueue(id, { next = false } = {}) {
    if (next) this.userQueue.unshift(id);
    else this.userQueue.push(id);
    toast(next ? 'Sonará a continuación' : 'Añadida a la cola');
    UI.renderQueue();
  },
  setShuffle(on) {
    S.shuffle = on;
    save();
    if (this.ctx.ids.length) {
      const curIdx = this.order[this.pos] ?? 0;
      this.buildOrder(curIdx);
    }
    UI.updateModes();
    UI.renderQueue();
  },
  cycleRepeat() {
    S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
    save();
    UI.updateModes();
    UI.renderQueue();
  },

  // --- Reproducción ---
  async start(track, { fade = 0, startAt = 0 } = {}) {
    if (!track) return;
    const token = ++this.token;
    const prevTrack = this.current;
    const wasPlaying = this.playing && !!prevTrack;
    // El deck que suena ahora (audio, radio o YouTube) se calcula antes de cambiar de canción
    const prevDeckBefore = prevTrack && prevTrack.source !== 'synth' ? this.deck : null;
    this.cancelFade();
    this.transitioning = true;
    this.currentId = track.id;
    this.playing = true;
    this.buffering = track.source !== 'synth';
    addRecent(track);
    UI.onTrackChange(track);
    Media.setMetadata(track);
    Dj.announce(track);
    if (track.source === 'synth' || !S.directOutput) Engine.ensure();

    const doFade = fade > 0 && wasPlaying && this.canCrossfade();

    if (track.source === 'synth') {
      this.fadeOutDecks(doFade ? fade : 0.2);
      if (Synth.playing) Synth.halt();
      Synth.start(track, startAt);
      this.buffering = false;
      this.transitioning = false;
      this.errorStreak = 0;
      UI.updatePlayState();
      Media.setState();
      return;
    }

    let url;
    try {
      url = await resolveUrl(track);
    } catch (e) {
      if (token === this.token) this.onError(track, e.message);
      return;
    }
    if (token !== this.token) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      return;
    }

    if (prevTrack?.source === 'synth' && Synth.playing) Synth.fadeOut(doFade ? fade : 0.2);

    // Elegir el deck de destino: audio (A/B), radio (directo) o YouTube (dos reproductores oficiales)
    const prevDeck = prevDeckBefore && prevDeckBefore.trackId && !prevDeckBefore.el.paused ? prevDeckBefore : null;
    let deck;
    if (track.source === 'youtube') {
      if (prevDeck && this.ytDecks.includes(prevDeck)) this.ytActive = 1 - this.ytActive;
      deck = this.ytDecks[this.ytActive];
    } else if (track.source === 'radio') {
      deck = this.liveDeck;
    } else {
      if (prevDeck && this.decks.includes(prevDeck)) this.active = 1 - this.active;
      deck = this.decks[this.active];
    }
    const fadeIt = doFade && !!prevDeck && prevDeck !== deck;
    for (const d of this.allDecks()) {
      if (d !== deck && !(fadeIt && d === prevDeck) && d.trackId) d.unload();
    }
    deck.route();
    deck.load(track, url, startAt);
    deck.setLevel(fadeIt ? 0 : 1);
    if (startAt && !deck.yt && track.source !== 'radio') deck.el.currentTime = startAt;
    this.playEl(deck, token);
    if (fadeIt) this.runCrossfade(prevDeck, deck, fade);
    if (track.source === 'radio') Api.countRadioClick(track);
    VideoDock.update();
    this.transitioning = false;
    if (track.source === 'preview' && !S.previewNoticeSeen) {
      S.previewNoticeSeen = true;
      save();
      showBanner('Las canciones de artistas comerciales vienen como vista previa oficial de 30 segundos. Toca ⋯ en la canción para escucharla completa en Apple Music.', 'info');
    }
  },
  playEl(deck, token) {
    deck.el.play().then(() => {
      if (token === this.token) this.errorStreak = 0;
    }).catch((err) => {
      if (token !== this.token) return;
      // Los fallos de carga los maneja el evento 'error' del elemento (evita saltar dos canciones).
      if (err.name === 'NotAllowedError') {
        this.playing = false;
        this.buffering = false;
        UI.updatePlayState();
        Media.setState();
        toast('Toca reproducir para empezar');
      }
    });
  },
  // Curvas del crossfade: la que sale baja claramente desde el primer segundo (S-curve,
  // -6 dB a la mitad) y la que entra sube rápido (potencia constante).
  fadeOutCurve: (p) => Math.cos(p * Math.PI / 2) ** 2,
  fadeInCurve: (p) => Math.sin(p * Math.PI / 2),

  async runCrossfade(fromDeck, toDeck, sec) {
    const fade = { fromDeck, toDeck, ui: null, done: null, cancelled: false };
    this.fade = fade;
    UI.setDeckBars(0);

    // Esperar a que la nueva canción suene de verdad (si aún está cargando, la anterior sigue completa)
    if (toDeck.el.readyState < 3 || toDeck.el.paused) {
      await new Promise((resolve) => {
        const ok = () => { toDeck.el.removeEventListener('playing', ok); resolve(); };
        toDeck.el.addEventListener('playing', ok);
        setTimeout(ok, 5000);
      });
    }
    if (fade.cancelled || this.fade !== fade) return;

    // La canción que sale puede terminar antes de que acabe el fundido
    const remaining = Number.isFinite(fromDeck.el.duration) ? fromDeck.el.duration - fromDeck.el.currentTime : sec;
    sec = clamp(Math.min(sec, remaining), 0.8, 12);
    const startedAt = performance.now();
    const a = fromDeck.level;
    const audioCurves = fromDeck.routed && toDeck.routed;

    if (audioCurves) {
      // Automatización en el hilo de audio: suave aunque la app esté en segundo plano
      const steps = 128;
      const now = Engine.ctx.currentTime;
      const out = new Float32Array(steps), inn = new Float32Array(steps);
      for (let i = 0; i < steps; i++) {
        const p = i / (steps - 1);
        out[i] = a * this.fadeOutCurve(p);
        inn[i] = this.fadeInCurve(p);
      }
      for (const [d, curve] of [[fromDeck, out], [toDeck, inn]]) {
        d.gain.gain.cancelScheduledValues(now);
        d.gain.gain.setValueAtTime(d.gain.gain.value, now);
        d.gain.gain.setValueCurveAtTime(curve, now + 0.01, sec);
      }
      fromDeck.level = 0;
      toDeck.level = 1;
      if (fromDeck.hp) {
        const f = fromDeck.hp.frequency;
        f.cancelScheduledValues(now);
        f.setValueAtTime(10, now);
        f.exponentialRampToValueAtTime(900, now + sec * 0.85);
      }
    }

    fade.ui = setInterval(() => {
      const p = clamp((performance.now() - startedAt) / (sec * 1000), 0, 1);
      if (!audioCurves) {
        // Modo compatible (sin Web Audio): se baja el volumen del elemento paso a paso
        fromDeck.level = a * this.fadeOutCurve(p);
        toDeck.level = this.fadeInCurve(p);
        for (const d of [fromDeck, toDeck]) {
          if (d.routed) d.gain.gain.setValueAtTime(d.level, Engine.ctx.currentTime);
          else d.applyDirectVolume();
        }
      }
      UI.setDeckBars(p);
      if (p >= 1) this.finishFade();
    }, 50);
    fade.done = setTimeout(() => this.finishFade(), sec * 1000 + 400);
  },
  finishFade() {
    if (!this.fade) return;
    const { fromDeck, toDeck, ui, done } = this.fade;
    this.fade.cancelled = true;
    clearInterval(ui);
    clearTimeout(done);
    this.fade = null;
    fromDeck.unload();
    toDeck.setLevel(1);
    UI.setDeckBars(0);
    VideoDock.update();
  },
  cancelFade() {
    if (this.fade) this.finishFade();
  },
  fadeOutDecks(sec, { keepLive = false } = {}) {
    for (const d of this.allDecks()) {
      if (!d.trackId || (keepLive && d.live)) continue;
      if (d.routed && sec > 0) {
        const g = d.gain.gain, now = Engine.ctx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + sec);
        const id = d.trackId;
        setTimeout(() => { if (d.trackId === id && id !== this.currentId) d.unload(); }, sec * 1000 + 60);
      } else {
        d.unload();
      }
    }
  },
  toggle() {
    if (!this.current) return UI.playCurrentView();
    if (this.playing) this.pause();
    else this.resume();
  },
  pause() {
    if (!this.current) return;
    this.playing = false;
    this.buffering = false;
    if (this.isSynth()) {
      Synth.pause();
    } else {
      this.cancelFade();
      if (this.current.source === 'radio') this.deck.unload();
      else this.deck.stop();
    }
    window.speechSynthesis?.cancel?.();
    UI.updatePlayState();
    Media.setState();
  },
  resume() {
    const t = this.current;
    if (!t) return;
    Engine.ensure();
    if (t.source === 'synth') {
      this.playing = true;
      if (Synth.track?.id === t.id) Synth.resume();
      else Synth.start(t, 0);
      UI.updatePlayState();
      Media.setState();
      return;
    }
    if (!this.deck.trackId || this.deck.trackId !== t.id) {
      this.start(t, { startAt: t.source === 'radio' ? 0 : this.deck.el.currentTime || 0 });
      return;
    }
    this.playing = true;
    this.playEl(this.deck, this.token);
    UI.updatePlayState();
    Media.setState();
  },
  seek(sec) {
    const t = this.current;
    if (!t || t.source === 'radio') return;
    const d = this.duration();
    const target = clamp(sec, 0, Number.isFinite(d) && d > 0 ? d - 0.25 : sec);
    if (t.source === 'synth') Synth.seek(target);
    else {
      try { this.deck.el.currentTime = target; } catch { /* aún no cargó */ }
    }
    UI.updateProgress();
    Lyrics.sync(true);
    Media.setPosition(true);
  },
  setRate(r) {
    S.rate = r;
    save();
    this.allDecks().forEach((d) => d.applyRate());
    if (this.isSynth()) Synth.rerate();
    UI.updateRate();
    Media.setPosition(true);
  },
  // Un <audio> conectado a Web Audio no se puede desconectar: al cambiar de modo se crean decks nuevos.
  rebuildDecks() {
    const t = this.current;
    const onDecks = t && t.source !== 'synth' && t.source !== 'radio';
    const wasPlaying = this.playing && onDecks;
    const at = onDecks ? this.position() : 0;
    this.cancelFade();
    this.decks.forEach((d) => d.unload());
    this.decks = [new Deck('A'), new Deck('B')];
    this.active = 0;
    if (wasPlaying) this.start(t, { startAt: at });
  },
  onError(track, msg) {
    this.buffering = false;
    this.errorStreak++;
    toast(`${track ? `"${track.title}": ` : ''}${msg || 'No se pudo reproducir'}`);
    if (this.errorStreak < 4 && this.peekNext()) {
      setTimeout(() => this.next(), 700);
    } else {
      this.playing = false;
      this.errorStreak = 0;
      UI.updatePlayState();
      Media.setState();
    }
  },
  onDeckEvent(deck, e) {
    if (deck !== this.deck) return;
    switch (e.type) {
      case 'timeupdate':
        UI.updateProgress();
        Lyrics.sync();
        Media.setPosition();
        this.maybeAutoMix();
        break;
      case 'ended':
        if (!this.transitioning) this.next({ auto: true });
        break;
      case 'error':
        if (deck.trackId && deck.el.getAttribute('src')) this.onError(this.current, 'No se pudo cargar el audio');
        break;
      case 'waiting':
        this.buffering = true;
        UI.updatePlayState();
        this.armWatchdog();
        break;
      case 'stalled':
        this.armWatchdog();
        break;
      case 'playing':
        this.buffering = false;
        this.errorStreak = 0;
        // Si se reanudó desde fuera (p. ej. tocando el video de YouTube), sincronizar el estado
        if (!this.playing && !this.transitioning) this.playing = true;
        UI.updatePlayState();
        Media.setState();
        break;
      case 'pause':
        // Pausa externa (audífonos desconectados, llamada, otro audio en iOS)
        if (this.playing && !this.transitioning && !deck.el.ended && deck.trackId) {
          this.playing = false;
          UI.updatePlayState();
          Media.setState();
        }
        break;
      case 'loadedmetadata': {
        const t = this.current;
        const d = deck.el.duration;
        if (t && t.source === 'local' && Number.isFinite(d) && Math.abs((t.duration || 0) - d) > 1) {
          t.duration = d;
          remember(t);
        }
        UI.updateProgress();
        Media.setPosition(true);
        break;
      }
    }
  },
  // Si el servidor deja de enviar audio, se recarga la canción en el mismo segundo.
  armWatchdog() {
    clearTimeout(this.watchdog);
    const t = this.current;
    if (!t || t.source === 'synth') return;
    const deck = this.deck;
    const at = deck.el.currentTime;
    this.watchdog = setTimeout(() => {
      if (this.current !== t || this.deck !== deck || !this.playing) return;
      if (Math.abs(deck.el.currentTime - at) > 0.5 || deck.el.readyState >= 3) return;
      this.recover(t, deck, at);
    }, 8000);
  },
  async recover(t, deck, at) {
    this.recoveries = this.recoveredId === t.id ? (this.recoveries || 0) + 1 : 1;
    this.recoveredId = t.id;
    if (this.recoveries > 2) return this.onError(t, 'La conexión con el servidor de música se cortó');
    this.transitioning = true;
    try {
      const url = await resolveUrl(t);
      if (this.current !== t || this.deck !== deck) return;
      deck.load(t, url, at);
      deck.setLevel(1);
      if (t.source !== 'radio' && !deck.yt) deck.el.currentTime = at;
      this.playEl(deck, this.token);
      this.armWatchdog();
    } catch (e) {
      this.onError(t, e.message);
    } finally {
      this.transitioning = false;
    }
  },
  onSynthEnded() {
    if (this.transitioning) return;
    Synth.halt();
    this.next({ auto: true });
  },
  onSynthTick() {
    if (!this.isSynth()) return;
    UI.updateProgress();
    Media.setPosition();
    this.maybeAutoMix();
  },
  maybeAutoMix() {
    const t = this.current;
    const xf = S.crossfade;
    if (!t || !xf || this.fade || this.transitioning || !this.playing || t.source === 'radio') return;
    if (!this.canCrossfade() || S.repeat === 'one' || this.stopAfterCurrent) return;
    const d = this.duration(), p = this.position();
    if (!Number.isFinite(d) || d < xf * 2 + 4) return;
    // Se arranca un poco antes para que la siguiente alcance a cargar; el fundido dura lo elegido
    if (d - p <= xf + 1.5 && p > 1) {
      const n = this.peekNext(true);
      if (n) this.next({ auto: true, fade: xf });
    }
  },
  mixNow() {
    if (!this.current) return toast('Primero elige una canción');
    if (!this.canCrossfade()) return toast('El crossfade no está disponible en modo compatible en este dispositivo');
    this.next({ fade: S.crossfade || 5 });
  }
};

function addRecent(t) {
  data.recent = [t.id, ...data.recent.filter((id) => id !== t.id)].slice(0, 40);
  remember(t);
  save();
}

// ============================================================================
// 11. Temporizador, locutor y letras
// ============================================================================
const Sleep = {
  timer: null, endsAt: 0, tick: null,
  set(value) {
    this.clear();
    if (value === 'end') {
      Player.stopAfterCurrent = true;
      $('sleepInfo').textContent = 'Se detendrá al terminar la canción actual.';
    } else {
      const min = Number(value) || 0;
      if (min > 0) {
        this.endsAt = Date.now() + min * 60000;
        this.timer = setTimeout(() => this.fire(), min * 60000);
        this.tick = setInterval(() => this.paint(), 15000);
        this.paint();
      }
    }
  },
  paint() {
    const left = Math.max(0, Math.round((this.endsAt - Date.now()) / 60000));
    $('sleepInfo').textContent = `La música se detendrá en ${left} min.`;
  },
  fire() {
    this.clear();
    if (Engine.master) {
      const now = Engine.ctx.currentTime;
      Engine.master.gain.setTargetAtTime(0, now, 2);
      setTimeout(() => { Player.pause(); Engine.applyVolume(); }, 7000);
    } else {
      Player.pause();
    }
    toast('Temporizador de apagado: buenas noches');
  },
  clear() {
    clearTimeout(this.timer);
    clearInterval(this.tick);
    this.timer = this.tick = null;
    Player.stopAfterCurrent = false;
    $('sleepInfo').textContent = '';
    $('sleepSelect').value = '0';
  }
};

const Dj = {
  voice: null,
  pickVoice() {
    if (this.voice || !Platform.speech) return this.voice;
    const voices = speechSynthesis.getVoices();
    this.voice = voices.find((v) => /^es[-_](419|MX|CO|US)/i.test(v.lang)) || voices.find((v) => /^es/i.test(v.lang)) || null;
    return this.voice;
  },
  announce(t) {
    if (!S.dj || !Platform.speech || !t) return;
    const lines = {
      radio: [`Sintonizando ${t.title}, en directo.`],
      synth: [`Desde el estudio de FreeSong: ${t.title}.`],
      default: [
        `Ahora suena ${t.title}, de ${t.artist}.`,
        `Seguimos con ${t.artist} y ${t.title}.`,
        `Esto es ${t.title}. Sube el volumen.`
      ]
    };
    const pool = lines[t.source] || lines.default;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(pool[Math.floor(Math.random() * pool.length)]);
      u.lang = 'es-ES';
      const v = this.pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = 1.04;
      u.onstart = () => Engine.applyVolume(0.35);
      u.onend = u.onerror = () => Engine.applyVolume(1);
      setTimeout(() => speechSynthesis.speak(u), 600);
    } catch { /* sin voz */ }
  }
};

const Lyrics = {
  cache: new Map(),
  lines: [],
  synced: false,
  activeIdx: -1,
  forId: null,
  userScrollAt: 0,
  visible() {
    return ui.sideTab === 'lyrics' && $('lyricsPanel').offsetParent !== null;
  },
  async ensure() {
    const t = Player.current;
    if (!t || this.forId === t.id) return;
    this.forId = t.id;
    this.lines = [];
    this.activeIdx = -1;
    if (t.source === 'radio' || t.source === 'synth') return this.render({ status: 'none', note: t.source === 'radio' ? 'La radio en directo no tiene letra.' : 'Las pistas del Estudio son instrumentales.' });
    if (this.cache.has(t.id)) return this.render(this.cache.get(t.id));
    this.render({ status: 'loading' });
    let entry;
    try {
      const r = await Api.lyrics(t);
      if (!r) entry = { status: 'none' };
      else if (r.instrumental) entry = { status: 'none', note: 'Esta canción es instrumental.' };
      else entry = { status: 'ok', synced: r.syncedLyrics || '', plain: r.plainLyrics || '' };
    } catch {
      entry = { status: 'error' };
    }
    if (entry.status !== 'error') this.cache.set(t.id, entry);
    if (Player.currentId === t.id) this.render(entry);
  },
  parse(lrc) {
    const out = [];
    for (const raw of lrc.split(/\r?\n/)) {
      const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
      const text = raw.replace(/\[[^\]]*\]/g, '').trim();
      for (const m of stamps) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
    }
    return out.sort((a, b) => a.t - b.t);
  },
  render(entry) {
    const el = $('lyricsPanel');
    const t = Player.current;
    const hint = (msg) => `<div class="h-full min-h-[240px] flex flex-col items-center justify-center text-center gap-2 text-zinc-400">${icon('lyrics', 'w-10 h-10 text-zinc-600')}<p class="text-sm">${esc(msg)}</p></div>`;
    if (!t) { el.innerHTML = hint('Reproduce una canción para ver su letra.'); return; }
    if (entry.status === 'loading') {
      el.innerHTML = `<div class="pt-4 space-y-4">${Array.from({ length: 7 }, (_, i) => `<div class="skeleton h-6 rounded-md" style="width:${60 + ((i * 37) % 35)}%"></div>`).join('')}</div>`;
      return;
    }
    if (entry.status === 'error') { el.innerHTML = hint('No se pudo cargar la letra. Revisa tu conexión.'); this.forId = null; return; }
    if (entry.status === 'none') { el.innerHTML = hint(entry.note || 'No encontramos la letra de esta canción.'); return; }

    const isPreview = t.source === 'preview';
    this.synced = !!entry.synced && !isPreview;
    this.lines = entry.synced ? this.parse(entry.synced) : entry.plain.split(/\r?\n/).map((text) => ({ t: null, text: text.trim() }));
    const rows = this.lines.map((l, i) => l.text
      ? `<p class="lyric-line text-[22px] leading-snug font-bold tracking-tight ${this.synced ? 'cursor-pointer hover:text-white' : 'text-zinc-200'}" data-line="${i}" data-state="${this.synced ? 'future' : ''}">${esc(l.text)}</p>`
      : `<p class="h-3" data-line="${i}"></p>`).join('');
    el.innerHTML = `
      ${isPreview ? '<p class="text-[11px] text-zinc-500 pt-2">La letra no se sincroniza con la vista previa de 30 s.</p>' : ''}
      <div class="space-y-3 pt-3 pb-24 select-text">${rows}</div>
      <p class="text-[11px] text-zinc-600 pb-4">Letra: LRCLIB</p>`;
    this.activeIdx = -1;
    this.sync(true);
  },
  sync(force = false) {
    if (!this.synced || !this.lines.length || !this.visible()) return;
    const pos = Player.position() + 0.25;
    let idx = -1;
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].t <= pos) idx = i; else break;
    }
    if (idx === this.activeIdx && !force) return;
    this.activeIdx = idx;
    const nodes = $('lyricsPanel').querySelectorAll('.lyric-line');
    let current = null;
    nodes.forEach((n) => {
      const i = Number(n.dataset.line);
      n.dataset.state = i < idx ? 'past' : i === idx ? 'current' : 'future';
      if (i === idx) current = n;
    });
    if (current && Date.now() - this.userScrollAt > 3000) {
      current.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
    }
  }
};

// ============================================================================
// 12. Color de la carátula (tinte dinámico como en Spotify)
// ============================================================================
const tintCache = new Map();
function fallbackTint(id) {
  return hslToRgb(hashHue(id), 45, 38).join(' ');
}
function extractTint(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    if (tintCache.has(url)) return resolve(tintCache.get(url));
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 20;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 20, 20);
        const px = x.getImageData(0, 0, 20, 20).data;
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < px.length; i += 4) {
          const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
          const weight = (s / 100) ** 2 * (l > 12 && l < 88 ? 1 : 0.05) + 0.01;
          r += px[i] * weight; g += px[i + 1] * weight; b += px[i + 2] * weight; w += weight;
          void h;
        }
        const [h, s, l] = rgbToHsl(r / w, g / w, b / w);
        const rgb = hslToRgb(h, clamp(s, 30, 70), clamp(l, 32, 48)).join(' ');
        tintCache.set(url, rgb);
        resolve(rgb);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

let spectrumColor = [16, 185, 129];
async function applyTint(t) {
  const rgb = (await extractTint(safeUrl(t.artworkUrl))) || fallbackTint(t.id);
  if (Player.currentId !== t.id) return;
  document.documentElement.style.setProperty('--tint', rgb);
  spectrumColor = rgb.split(' ').map(Number);
}

// ============================================================================
// 13. Navegación (con historial: el botón Atrás de Android funciona)
// ============================================================================
const ui = { sideTab: 'queue', libFilter: 'all', seeking: false, installEvent: null, searchQ: '' };

const Nav = {
  view: { type: 'home' },
  go(view, { replace = false } = {}) {
    this.view = view;
    const state = { view };
    if (replace) history.replaceState(state, '');
    else history.pushState(state, '');
    if (view.type === 'search') setTab('search');
    else if (document.body.dataset.tab !== 'home') setTab('home');
    UI.renderMain();
    UI.renderLibrary();
    $('mainScroll').scrollTop = 0;
  }
};

function setTab(tab) {
  document.body.dataset.tab = tab;
  document.querySelectorAll('[data-tab-btn]').forEach((b) => {
    const on = b.dataset.tabBtn === tab;
    b.classList.toggle('text-white', on);
    b.classList.toggle('text-zinc-500', !on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  if (tab === 'side') {
    UI.renderSide();
    if (ui.sideTab === 'lyrics') Lyrics.ensure();
  }
}

const Sheet = {
  open: false,
  pendingAfterClose: null,
  show() {
    if (this.open || window.matchMedia('(min-width: 1024px)').matches) return;
    this.open = true;
    $('nowSheet').dataset.open = 'true';
    document.body.dataset.sheet = 'true';
    history.pushState({ view: Nav.view, sheet: true }, '');
    UI.renderSheet();
  },
  close(fromPop = false) {
    if (!this.open) return;
    this.open = false;
    $('nowSheet').dataset.open = 'false';
    document.body.dataset.sheet = 'false';
    if (!fromPop) history.back();
  },
  closeThen(fn) {
    if (!this.open) return fn();
    this.pendingAfterClose = fn;
    this.close();
  }
};

window.addEventListener('popstate', (e) => {
  if (Menu.isOpen()) Menu.close();
  if (Sheet.open) {
    Sheet.close(true);
    const fn = Sheet.pendingAfterClose;
    Sheet.pendingAfterClose = null;
    if (fn) setTimeout(fn, 0);
    return;
  }
  const v = e.state?.view;
  if (v) {
    Nav.view = v;
    if (v.type === 'search') setTab('search');
    else if (['search'].includes(document.body.dataset.tab)) setTab('home');
    UI.renderMain();
    UI.renderLibrary();
  }
});

// ============================================================================
// 14. Plantillas
// ============================================================================
function coverHtml(t, iconCls = 'w-1/2 h-1/2') {
  const h = hashHue(t?.id || 'x');
  const art = safeUrl(t?.artworkUrl);
  const ic = SOURCES[t?.source]?.icon || 'music';
  return `<span class="cover relative block w-full h-full" style="background:linear-gradient(135deg,hsl(${h} 50% 40%),hsl(${(h + 45) % 360} 55% 16%))">
    <span class="absolute inset-0 flex items-center justify-center text-white/75">${icon(ic, iconCls)}</span>
    ${art ? `<img src="${esc(art)}" alt="" loading="lazy" decoding="async" class="absolute inset-0 w-full h-full ${t.source === 'radio' ? 'object-contain p-[14%] bg-zinc-900' : 'object-cover'}" data-cover data-alt="${esc((t.artworkAlts || []).join(' '))}">` : ''}
  </span>`;
}

function specialCover(kind, extra) {
  const map = {
    liked: ['from-indigo-600 via-violet-500 to-emerald-300', 'heart-fill'],
    downloads: ['from-emerald-600 to-teal-900', 'download'],
    local: ['from-rose-500 to-orange-800', 'folder'],
    recent: ['from-zinc-600 to-zinc-900', 'clock'],
    radio: ['from-cyan-500 to-blue-900', 'radio'],
    studio: ['from-amber-400 to-orange-800', 'wave']
  };
  const [grad, ic] = map[kind] || ['from-zinc-700 to-zinc-900', 'music'];
  if (kind === 'playlist' && extra?.length >= 4) {
    return `<span class="grid grid-cols-2 w-full h-full">${extra.slice(0, 4).map((t) => `<span class="block overflow-hidden">${coverHtml(t, 'w-1/3 h-1/3')}</span>`).join('')}</span>`;
  }
  if (kind === 'playlist' && extra?.length) return coverHtml(extra[0]);
  return `<span class="flex w-full h-full items-center justify-center bg-gradient-to-br ${grad} text-white">${icon(ic, 'w-2/5 h-2/5')}</span>`;
}

// Registro de vistas/contextos referenciados desde el HTML (separado por panel).
const Reg = {
  scopes: { main: new Map(), lib: new Map() },
  n: 0,
  add(value, scope = 'main') { const k = `${scope}-${++this.n}`; this.scopes[scope].set(k, value); return k; },
  get(k) { return this.scopes[String(k).split('-')[0]]?.get(k); },
  clear(scope) { this.scopes[scope].clear(); }
};

function pillHtml(t) {
  const pill = SOURCES[t.source]?.pill;
  if (!pill) return '';
  const cls = {
    preview: 'bg-indigo-500/15 text-indigo-300',
    radio: 'bg-cyan-500/15 text-cyan-300',
    youtube: 'bg-red-500/15 text-red-300'
  }[t.source] || 'bg-amber-500/15 text-amber-300';
  return `<span class="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-px rounded ${cls}">${pill}</span>`;
}

function downloadMark(t) {
  if (Downloads.progress.has(t.id)) {
    const p = Math.round((Downloads.progress.get(t.id) || 0) * 100);
    return `<span class="shrink-0 text-[10px] font-mono text-emerald-300">${p}%</span>`;
  }
  if (t.source === 'audius' && Downloads.has(t.id)) return `<span class="shrink-0 text-emerald-400" title="Descargada">${icon('download', 'w-3.5 h-3.5')}</span>`;
  return '';
}

function rowHtml(t, i, ctxKey, { showAlbum = true } = {}) {
  const liked = data.likes.includes(t.id);
  const dur = t.source === 'radio' ? 'En vivo' : fmt(t.duration);
  return `
  <div role="button" tabindex="0" class="track-row row-grid group grid items-center gap-3 px-2 sm:px-3 py-1.5 rounded-lg hover:bg-white/[.06] focus:bg-white/[.06] outline-none cursor-pointer"
    data-track-id="${esc(t.id)}" data-current="${t.id === Player.currentId}" data-ctx="${ctxKey}" data-idx="${i}">
    <div class="row-idx w-8 justify-center items-center text-sm tabular-nums text-zinc-400 relative">
      <span class="t-num">${i + 1}</span>
      <span class="t-hover-play absolute text-white">${icon('play', 'w-4 h-4')}</span>
      <span class="t-eq absolute items-end gap-0.5 h-4"><span class="w-[3px] bg-emerald-400 eq-bar-1 rounded-full"></span><span class="w-[3px] bg-emerald-400 eq-bar-2 rounded-full"></span><span class="w-[3px] bg-emerald-400 eq-bar-3 rounded-full"></span></span>
    </div>
    <div class="flex items-center gap-3 min-w-0">
      <span class="w-11 h-11 rounded overflow-hidden shrink-0">${coverHtml(t)}</span>
      <div class="min-w-0">
        <p class="t-title truncate text-[15px] font-medium text-white">${esc(t.title)}</p>
        <p class="flex items-center gap-1.5 min-w-0 text-[13px] text-zinc-400">${downloadMark(t)}${pillHtml(t)}<span class="truncate">${esc(t.artist)}</span></p>
      </div>
    </div>
    <div class="row-album truncate text-[13px] text-zinc-400">${showAlbum ? esc(t.album || '') : ''}</div>
    <div class="row-dur items-center justify-end gap-3">
      <button data-like="${esc(t.id)}" aria-label="${liked ? 'Quitar de Me gusta' : 'Me gusta'}" class="p-1 press ${liked ? 'text-emerald-400' : 'text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-white'}">${icon(liked ? 'heart-fill' : 'heart', 'w-4 h-4')}</button>
      <span class="w-12 text-right text-[13px] tabular-nums text-zinc-400">${dur}</span>
    </div>
    <button data-menu="${esc(t.id)}" aria-label="Más opciones de ${esc(t.title)}" class="p-2 -mr-1 text-zinc-400 hover:text-white press">${icon('more', 'w-5 h-5')}</button>
  </div>`;
}

function cardHtml(t, i, ctxKey) {
  return `
  <div class="card relative shrink-0 w-[148px] sm:w-[180px] p-2.5 sm:p-3 rounded-xl hover:bg-white/[.06] transition-colors cursor-pointer snap-start" data-track-id="${esc(t.id)}" data-current="${t.id === Player.currentId}" data-ctx="${ctxKey}" data-idx="${i}" role="button" tabindex="0">
    <div class="relative aspect-square rounded-lg overflow-hidden mb-2.5 shadow-[0_8px_24px_rgba(0,0,0,.45)]">
      ${coverHtml(t)}
      <span class="card-play absolute bottom-2 right-2 w-11 h-11 rounded-full bg-emerald-500 text-black flex items-center justify-center shadow-[0_8px_16px_rgba(0,0,0,.4)]">${icon('play', 'cp-play w-5 h-5')}${icon('pause', 'cp-pause w-5 h-5')}</span>
    </div>
    <p class="text-sm font-semibold text-white truncate">${esc(t.title)}</p>
    <p class="text-[13px] text-zinc-400 truncate mt-0.5">${esc(t.artist)}</p>
  </div>`;
}

function viewCardHtml(view, title, subtitle, coverInner, round = false) {
  const k = Reg.add(view);
  return `
  <div class="card relative shrink-0 w-[148px] sm:w-[180px] p-2.5 sm:p-3 rounded-xl hover:bg-white/[.06] transition-colors cursor-pointer snap-start" data-view="${k}" role="button" tabindex="0">
    <div class="relative aspect-square ${round ? 'rounded-full' : 'rounded-lg'} overflow-hidden mb-2.5 shadow-[0_8px_24px_rgba(0,0,0,.45)]">${coverInner}</div>
    <p class="text-sm font-semibold text-white truncate">${esc(title)}</p>
    <p class="text-[13px] text-zinc-400 truncate mt-0.5">${esc(subtitle)}</p>
  </div>`;
}

function shelfHtml(title, inner, moreView) {
  const more = moreView ? `<button data-view="${Reg.add(moreView)}" class="shrink-0 whitespace-nowrap text-[13px] font-bold text-zinc-400 hover:text-white hover:underline">Mostrar todo</button>` : '';
  return `
  <section class="mt-7">
    <div class="flex items-end justify-between gap-3 px-4 sm:px-6 mb-1">
      <h2 class="min-w-0 truncate text-xl sm:text-[22px] font-bold tracking-tight text-white">${esc(title)}</h2>${more}
    </div>
    <div class="flex overflow-x-auto no-scrollbar snap-x px-1.5 sm:px-3">${inner}</div>
  </section>`;
}

function skeletonCards(n = 6) {
  return Array.from({ length: n }, () => `
    <div class="shrink-0 w-[148px] sm:w-[180px] p-2.5 sm:p-3">
      <div class="skeleton aspect-square rounded-lg mb-2.5"></div>
      <div class="skeleton h-3.5 rounded w-4/5 mb-2"></div>
      <div class="skeleton h-3 rounded w-1/2"></div>
    </div>`).join('');
}

function skeletonRows(n = 8) {
  return Array.from({ length: n }, () => `
    <div class="flex items-center gap-3 px-3 py-2">
      <div class="skeleton w-11 h-11 rounded"></div>
      <div class="flex-1 space-y-2"><div class="skeleton h-3.5 rounded w-2/5"></div><div class="skeleton h-3 rounded w-1/4"></div></div>
    </div>`).join('');
}

function genreTileHtml([value, label, hue]) {
  const k = Reg.add({ type: 'list', kind: 'genre', id: value, name: label });
  return `
  <button data-view="${k}" class="relative h-24 sm:h-28 rounded-xl overflow-hidden p-3 text-left press" style="background:hsl(${hue} 50% 36%)">
    <span class="relative z-10 text-base sm:text-lg font-bold text-white">${esc(label)}</span>
    <span class="absolute -right-3 -bottom-3 w-16 h-16 sm:w-20 sm:h-20 rounded-lg rotate-[25deg] shadow-[0_8px_24px_rgba(0,0,0,.35)]" style="background:linear-gradient(135deg,hsl(${(hue + 40) % 360} 60% 55%),hsl(${hue} 55% 22%))"></span>
  </button>`;
}

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Buenos días';
  if (h >= 12 && h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

// ============================================================================
// 15. Vistas
// ============================================================================
const Cache = {
  trending: null, trendingAt: 0, trendingErr: false,
  lists: new Map(),
  search: new Map()
};

function collection(kind, id) {
  switch (kind) {
    case 'liked': return { title: 'Tus me gusta', label: 'Playlist', ids: data.likes.filter((x) => catalog.has(x)) };
    case 'downloads': return { title: 'Descargas', label: 'Sin internet', ids: downloadedIds() };
    case 'local': return { title: 'Mis archivos', label: 'En este dispositivo', ids: localIds() };
    case 'recent': return { title: 'Escuchado recientemente', label: 'Historial', ids: data.recent.filter((x) => catalog.has(x)) };
    case 'studio': return { title: 'Estudio', label: 'Sin internet', ids: BUILTIN.filter((t) => t.source === 'synth').map((t) => t.id) };
    case 'playlist': {
      const pl = data.playlists.find((p) => p.id === id);
      return pl ? { title: pl.name, label: 'Playlist', ids: pl.trackIds.filter((x) => catalog.has(x)), playlist: pl } : null;
    }
    default: return null;
  }
}

const UI = {
  renderAll() {
    this.renderMain();
    this.renderLibrary();
    this.renderSide();
    this.updateNow();
  },

  renderMain() {
    Reg.clear('main');
    const v = Nav.view;
    const isInstall = v.type === 'install';
    $('installView').classList.toggle('hidden', !isInstall);
    $('mainContent').classList.toggle('hidden', isInstall);
    if (isInstall) return renderDiagnostics();
    if (v.type === 'home') return this.renderHome();
    if (v.type === 'search') return this.renderSearch(v);
    if (v.type === 'list') return this.renderList(v);
  },

  renderHome() {
    const el = $('mainContent');
    const shortcuts = [
      { view: { type: 'list', kind: 'liked' }, name: 'Tus me gusta', cover: specialCover('liked') },
      ...data.playlists.slice(0, 5).map((p) => ({ view: { type: 'list', kind: 'playlist', id: p.id }, name: p.name, cover: specialCover('playlist', p.trackIds.map(getTrack).filter(Boolean)) })),
      { view: { type: 'list', kind: 'radio', id: 'local' }, name: 'Radio en directo', cover: specialCover('radio') },
      { view: { type: 'list', kind: 'studio' }, name: 'Estudio', cover: specialCover('studio') }
    ];
    if (Downloads.ids.size) shortcuts.splice(1, 0, { view: { type: 'list', kind: 'downloads' }, name: 'Descargas', cover: specialCover('downloads') });
    const shortcutHtml = shortcuts.slice(0, 8).map((s) => `
      <button data-view="${Reg.add(s.view)}" class="group flex items-center gap-3 h-14 sm:h-16 rounded-md bg-white/[.07] hover:bg-white/[.14] overflow-hidden text-left transition-colors press">
        <span class="w-14 sm:w-16 h-full shrink-0 shadow-[4px_0_12px_rgba(0,0,0,.3)]">${s.cover}</span>
        <span class="text-[13px] sm:text-sm font-bold text-white line-clamp-2 pr-2">${esc(s.name)}</span>
      </button>`).join('');

    const recent = data.recent.map(getTrack).filter(Boolean).slice(0, 12);
    const recentKey = Reg.add({ ids: recent.map((t) => t.id), label: 'Escuchado recientemente', key: 'recent:' });
    const radioCache = Cache.lists.get('radio:local');
    let radioInner;
    if (radioCache?.status === 'ok') {
      const k = Reg.add({ ids: radioCache.tracks.map((t) => t.id), label: 'Radio cerca de ti', key: 'radio:local' });
      radioInner = radioCache.tracks.slice(0, 14).map((t, i) => cardHtml(t, i, k)).join('');
    } else if (radioCache?.status === 'error') {
      radioInner = '<div class="px-3 py-6 text-sm text-zinc-400">No se pudieron cargar las emisoras.</div>';
    } else {
      radioInner = skeletonCards();
      if (!radioCache) loadRemoteList({ type: 'list', kind: 'radio', id: 'local' });
    }
    const studio = BUILTIN.filter((t) => t.source === 'synth');
    const studioKey = Reg.add({ ids: studio.map((t) => t.id), label: 'Estudio', key: 'studio:' });

    let trendingInner;
    if (Cache.trending) {
      const k = Reg.add({ ids: Cache.trending.map((t) => t.id), label: 'Tendencias en Audius', key: 'trending:' });
      trendingInner = Cache.trending.slice(0, 14).map((t, i) => cardHtml(t, i, k)).join('');
    } else if (Cache.trendingErr) {
      trendingInner = `<div class="px-3 py-6 text-sm text-zinc-400">No se pudieron cargar las tendencias. <button data-action="retry-trending" class="text-white font-semibold underline">Reintentar</button></div>`;
    } else {
      trendingInner = skeletonCards();
    }

    el.innerHTML = `
      <div class="tint-hero px-4 sm:px-6 pt-5 pb-2">
        <h1 class="text-2xl sm:text-[32px] font-extrabold tracking-tight text-white mb-4">${greeting()}</h1>
        <div class="grid grid-cols-2 xl:grid-cols-4 gap-2">${shortcutHtml}</div>
      </div>
      ${recent.length ? shelfHtml('Escuchado recientemente', recent.map((t, i) => cardHtml(t, i, recentKey)).join(''), { type: 'list', kind: 'recent' }) : ''}
      ${shelfHtml('Tendencias en Audius', trendingInner, Cache.trending ? { type: 'list', kind: 'trending' } : null)}
      <section class="mt-7 px-4 sm:px-6">
        <h2 class="text-[22px] font-bold tracking-tight text-white mb-3">Explora por género</h2>
        <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">${GENRES.slice(0, 8).map(genreTileHtml).join('')}</div>
        <button data-view="${Reg.add({ type: 'search' })}" class="mt-3 text-[13px] font-bold text-zinc-400 hover:text-white hover:underline">Ver todos los géneros</button>
      </section>
      ${shelfHtml('Radio en directo', radioInner, { type: 'list', kind: 'radio', id: 'local' })}
      ${shelfHtml('Estudio sin conexión', studio.map((t, i) => cardHtml(t, i, studioKey)).join(''), { type: 'list', kind: 'studio' })}
      <p class="px-6 mt-10 text-[11px] text-zinc-600">Música completa de Audius · Vistas previas de Apple · Radio de Radio Browser · Letras de LRCLIB</p>`;

    if (!Cache.trending && !Cache.trendingErr) loadTrending();
  },

  renderSearch(v) {
    const el = $('mainContent');
    const q = (v.q || '').trim();
    const mobileForm = `
      <form data-search-form class="lg:hidden px-4 pt-5 pb-3 sticky top-0 z-10 bg-zinc-950/95 backdrop-blur-md" role="search">
        <h1 class="text-2xl font-extrabold tracking-tight text-white mb-3">Buscar</h1>
        <label class="relative block">
          <span class="sr-only">Buscar</span>
          <svg class="w-5 h-5 absolute left-3.5 top-3 text-zinc-500 pointer-events-none"><use href="#i-search"/></svg>
          <input data-search-input type="search" enterkeyhint="search" autocomplete="off" value="${esc(q)}" placeholder="¿Qué quieres escuchar?"
            class="w-full pl-11 pr-4 py-3 rounded-lg bg-white text-base text-black placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
        </label>
      </form>`;

    if (!q) {
      el.innerHTML = `${mobileForm}
        <section class="px-4 sm:px-6 pt-2 lg:pt-6">
          <h2 class="text-lg font-bold text-white mb-3">Explorar todo</h2>
          <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">${GENRES.map(genreTileHtml).join('')}</div>
        </section>`;
      return;
    }

    const res = Cache.search.get(q);
    let body;
    if (!res || res.status === 'loading') {
      body = `<div class="px-2 sm:px-4 pt-2">${skeletonRows(10)}</div>`;
      if (!res) runSearch(q);
    } else {
      const ytKey = Reg.add({ ids: res.youtube.map((t) => t.id), label: `Búsqueda: ${q}`, key: `search:${q}:yt` });
      const fullKey = Reg.add({ ids: res.full.map((t) => t.id), label: `Búsqueda: ${q}`, key: `search:${q}:full` });
      const prevKey = Reg.add({ ids: res.previews.map((t) => t.id), label: `Búsqueda: ${q}`, key: `search:${q}:prev` });
      const artists = res.artists.map((a) => viewCardHtml(
        { type: 'list', kind: 'artist', id: a.id, name: a.name }, a.name,
        `${a.followers.toLocaleString('es')} seguidores`,
        a.avatar ? `<img src="${esc(a.avatar)}" alt="" loading="lazy" class="w-full h-full object-cover">` : `<span class="flex w-full h-full items-center justify-center bg-zinc-800 text-zinc-400">${icon('person', 'w-1/2 h-1/2')}</span>`, true)).join('');
      const nothing = !res.youtube.length && !res.full.length && !res.previews.length && !res.artists.length;
      const ytNote = res.ytFailed
        ? `<p class="mx-4 sm:mx-6 mt-3 text-xs text-amber-300">La búsqueda en YouTube no respondió. Para que sea estable, agrega tu llave gratuita de YouTube en Sonido → YouTube.</p>`
        : '';
      body = `
        ${res.error ? `<p class="mx-4 sm:mx-6 mt-2 text-sm text-amber-300">${esc(res.error)}</p>` : ''}
        ${ytNote}
        ${nothing ? `<div class="px-6 py-16 text-center"><p class="text-lg font-bold text-white">No encontramos "${esc(q)}"</p><p class="text-sm text-zinc-400 mt-1">Revisa la ortografía o prueba con otro artista o género.</p></div>` : ''}
        ${res.youtube.length ? `<section class="mt-4 px-2 sm:px-4"><h2 class="px-2 text-[22px] font-bold tracking-tight text-white mb-1">Canciones en YouTube</h2><p class="px-2 text-xs text-zinc-500 mb-2">Completas, con el reproductor oficial de YouTube (el video se ve en un recuadro).</p>${res.youtube.map((t, i) => rowHtml(t, i, ytKey)).join('')}</section>` : ''}
        ${res.full.length ? `<section class="mt-7 px-2 sm:px-4"><h2 class="px-2 text-[22px] font-bold tracking-tight text-white mb-1">Completas en Audius</h2><p class="px-2 text-xs text-zinc-500 mb-2">Subidas por los propios artistas. Se pueden descargar y suenan con la pantalla bloqueada.</p>${res.full.map((t, i) => rowHtml(t, i, fullKey)).join('')}</section>` : ''}
        ${res.artists.length ? shelfHtml('Artistas en Audius', artists) : ''}
        ${res.previews.length ? `<section class="mt-7 px-2 sm:px-4"><h2 class="px-2 text-[22px] font-bold tracking-tight text-white mb-1">Vistas previas de 30 s</h2><p class="px-2 text-xs text-zinc-500 mb-2">Fragmentos oficiales de Apple. Abre ⋯ para escucharlas completas en Apple Music.</p>${res.previews.map((t, i) => rowHtml(t, i, prevKey)).join('')}</section>` : ''}`;
    }
    el.innerHTML = `${mobileForm}<div class="lg:pt-4">${body}</div>`;
  },

  renderList(v) {
    const el = $('mainContent');
    let title, label, ids, subtitle = '', coverInner, heroKey = v.kind === 'playlist' ? `playlist:${v.id}` : `${v.kind}:${v.id || ''}`, extraActions = '', loading = false, error = '';
    const local = collection(v.kind, v.id);

    if (local) {
      ({ title, label, ids } = local);
      const tracks = ids.map(getTrack).filter(Boolean);
      coverInner = v.kind === 'playlist' ? specialCover('playlist', tracks) : specialCover(v.kind);
      if (local.playlist) {
        extraActions = `<button data-action="playlist-menu" data-id="${esc(local.playlist.id)}" aria-label="Opciones de la playlist" class="p-2 text-zinc-400 hover:text-white press">${icon('more', 'w-8 h-8')}</button>`;
      }
    } else if (['trending', 'genre', 'artist', 'radio'].includes(v.kind)) {
      const cacheKey = `${v.kind}:${v.id || ''}`;
      const c = v.kind === 'trending' && Cache.trending ? { status: 'ok', tracks: Cache.trending } : Cache.lists.get(cacheKey);
      const radioCat = v.kind === 'radio' ? RADIO_CATEGORIES.find((x) => x[0] === v.id) || RADIO_CATEGORIES[0] : null;
      title = v.kind === 'trending' ? 'Tendencias en Audius' : radioCat ? `Radio: ${radioCat[1]}` : v.name || c?.name || 'Artista';
      label = { artist: 'Artista', genre: 'Género · Tendencias de la semana', radio: 'Radio en directo', trending: 'Audius' }[v.kind];
      if (radioCat) {
        extraActions = `<div class="basis-full flex gap-2 overflow-x-auto no-scrollbar pt-2 -mx-1 px-1">${RADIO_CATEGORIES.map(([id, name]) => `
          <button data-view="${Reg.add({ type: 'list', kind: 'radio', id })}" class="shrink-0 px-3.5 py-1.5 rounded-full text-[13px] font-medium transition press ${id === radioCat[0] ? 'bg-white text-black' : 'bg-white/[.08] text-white hover:bg-white/[.14]'}">${esc(name)}</button>`).join('')}</div>`;
      }
      if (!c || c.status === 'loading') {
        loading = true;
        ids = [];
        if (!c) loadRemoteList(v);
      } else if (c.status === 'error') {
        error = c.error;
        ids = [];
      } else {
        ids = c.tracks.map((t) => t.id);
        if (v.kind === 'artist') subtitle = `${(c.followers || 0).toLocaleString('es')} seguidores · `;
      }
      if (v.kind === 'artist' && c?.avatar) coverInner = `<img src="${esc(c.avatar)}" alt="" class="w-full h-full object-cover">`;
      else if (v.kind === 'radio') coverInner = specialCover('radio');
      else if (v.kind === 'genre') {
        const g = GENRES.find((x) => x[0] === v.id);
        const hue = g ? g[2] : 160;
        coverInner = `<span class="flex w-full h-full items-center justify-center text-white" style="background:linear-gradient(135deg,hsl(${(hue + 40) % 360} 60% 50%),hsl(${hue} 55% 20%))">${icon('music', 'w-2/5 h-2/5')}</span>`;
      } else coverInner = ids.length ? coverHtml(getTrack(ids[0])) : specialCover('studio');
    } else {
      return this.renderHome();
    }

    const tracks = ids.map(getTrack).filter(Boolean);
    const total = tracks.reduce((s, t) => s + (t.source === 'radio' ? 0 : t.duration || 0), 0);
    subtitle += v.kind === 'radio'
      ? `${tracks.length} emisoras · Radio Browser`
      : `${songs(tracks.length)}${total > 0 ? ` · ${fmtLong(total)}` : ''}`;
    const ctxKey = Reg.add({ ids: tracks.map((t) => t.id), label: title, key: heroKey });
    const isCtx = Player.ctx.key === heroKey;
    const round = v.kind === 'artist';

    let rows;
    if (loading) rows = skeletonRows(10);
    else if (error) rows = `<div class="px-4 py-12 text-center text-sm text-zinc-400">${esc(error)} <button data-action="retry-list" class="text-white font-semibold underline">Reintentar</button></div>`;
    else if (!tracks.length) rows = emptyStateHtml(v.kind);
    else rows = tracks.map((t, i) => rowHtml(t, i, ctxKey)).join('');

    el.innerHTML = `
      <div class="list-hero hero-row px-4 sm:px-6 pt-6 pb-5" data-hero>
        <div class="hero-cover w-40 h-40 sm:w-52 sm:h-52 mx-auto shrink-0 ${round ? 'rounded-full' : 'rounded-md'} overflow-hidden shadow-[0_16px_48px_rgba(0,0,0,.5)]">${coverInner}</div>
        <div class="min-w-0">
          <p class="text-xs font-semibold text-white/80">${esc(label)}</p>
          <h1 class="hero-title font-black tracking-tight text-white leading-[1.05] mt-1">${esc(title)}</h1>
          <p class="text-[13px] text-white/70 mt-2 sm:mt-3">${esc(subtitle)}</p>
        </div>
      </div>
      <div class="px-4 sm:px-6 py-4 flex flex-wrap items-center gap-4">
        <button data-action="hero-play" data-ctx="${ctxKey}" ${tracks.length ? '' : 'disabled'} aria-label="Reproducir" class="w-14 h-14 rounded-full bg-emerald-500 hover:bg-emerald-400 hover:scale-105 text-black flex items-center justify-center shadow-[0_8px_24px_rgba(16,185,129,.3)] transition disabled:opacity-40 press" data-hero-play="${esc(heroKey)}">
          ${icon(isCtx && Player.playing ? 'pause' : 'play', 'w-7 h-7')}
        </button>
        <button data-action="hero-shuffle" data-ctx="${ctxKey}" ${tracks.length ? '' : 'disabled'} aria-label="Reproducir en aleatorio" class="p-2 text-zinc-400 hover:text-white disabled:opacity-40 press">${icon('shuffle', 'w-8 h-8')}</button>
        ${v.kind === 'local' ? `<label for="localAudioInput" class="cursor-pointer px-4 py-2 rounded-full border border-zinc-600 hover:border-white text-sm font-semibold text-white press">Importar</label>` : ''}
        ${extraActions}
      </div>
      <div class="px-2 sm:px-4">
        <div class="row-head row-grid gap-3 px-3 pb-2 mb-2 border-b border-white/10 text-xs text-zinc-400">
          <span class="row-idx justify-center">#</span><span>Título</span><span class="row-album">Álbum</span><span class="row-dur justify-end pr-1">${icon('clock', 'w-4 h-4')}</span><span class="w-9"></span>
        </div>
        ${rows}
      </div>`;

    const heroEl = el.querySelector('[data-hero]');
    const first = tracks.find((t) => t.artworkUrl);
    const art = v.kind === 'artist' ? Cache.lists.get(`artist:${v.id}`)?.avatar : first?.artworkUrl;
    extractTint(safeUrl(art)).then((rgb) => {
      heroEl.style.setProperty('--hero', rgb || fallbackTint(heroKey));
    });
  },

  renderLibrary() {
    const chips = [['all', 'Todo'], ['playlists', 'Playlists'], ['offline', 'Sin internet']];
    $('libraryChips').innerHTML = chips.map(([k, l]) => `
      <button data-lib-filter="${k}" class="shrink-0 px-3 py-1.5 rounded-full text-[13px] font-medium transition press ${ui.libFilter === k ? 'bg-white text-black' : 'bg-white/[.08] text-white hover:bg-white/[.14]'}">${l}</button>`).join('');

    Reg.clear('lib');
    const v = Nav.view;
    const items = [];
    const push = (view, name, sub, cover, key) => items.push({ view, name, sub, cover, key });
    const f = ui.libFilter;
    if (f === 'all' || f === 'playlists') {
      push({ type: 'list', kind: 'liked' }, 'Tus me gusta', `Playlist · ${songs(data.likes.length)}`, specialCover('liked'), 'liked:');
      data.playlists.forEach((p) => push({ type: 'list', kind: 'playlist', id: p.id }, p.name, `Playlist · ${songs(p.trackIds.length)}`, specialCover('playlist', p.trackIds.map(getTrack).filter(Boolean)), `playlist:${p.id}`));
    }
    if (f === 'all' || f === 'offline') {
      push({ type: 'list', kind: 'downloads' }, 'Descargas', `${songs(downloadedIds().length)} sin internet`, specialCover('downloads'), 'downloads:');
      push({ type: 'list', kind: 'local' }, 'Mis archivos', `${songs(localIds().length)} en este dispositivo`, specialCover('local'), 'local:');
      push({ type: 'list', kind: 'studio' }, 'Estudio', 'Música generada · sin internet', specialCover('studio'), 'studio:');
    }
    if (f === 'all') {
      push({ type: 'list', kind: 'recent' }, 'Escuchado recientemente', songs(data.recent.length), specialCover('recent'), 'recent:');
      push({ type: 'list', kind: 'radio', id: 'local' }, 'Radio en directo', 'Emisoras de todo el mundo', specialCover('radio'), 'radio:local');
    }

    $('libraryList').innerHTML = items.map((it) => {
      const active = v.type === 'list' && `${v.kind}:${v.id || ''}` === `${it.view.kind}:${it.view.id || ''}`;
      const playingHere = Player.ctx.key === it.key && Player.playing;
      return `
      <button data-view="${Reg.add(it.view, 'lib')}" class="w-full flex items-center gap-3 p-2 rounded-md text-left transition-colors press ${active ? 'bg-white/[.1]' : 'hover:bg-white/[.06]'}">
        <span class="w-12 h-12 rounded-md overflow-hidden shrink-0">${it.cover}</span>
        <span class="min-w-0 flex-1">
          <span class="block text-[15px] font-medium truncate ${playingHere ? 'text-emerald-400' : 'text-white'}">${esc(it.name)}</span>
          <span class="block text-[13px] text-zinc-400 truncate">${esc(it.sub)}</span>
        </span>
        ${playingHere ? `<span class="text-emerald-400 shrink-0">${icon('volume', 'w-4 h-4')}</span>` : ''}
      </button>`;
    }).join('');
  },

  renderSide() {
    document.querySelectorAll('[data-side-tab]').forEach((b) => {
      const on = b.dataset.sideTab === ui.sideTab;
      b.classList.toggle('bg-white', on);
      b.classList.toggle('text-black', on);
      b.classList.toggle('text-zinc-300', !on);
      b.setAttribute('aria-selected', String(on));
    });
    $('queuePanel').classList.toggle('hidden', ui.sideTab !== 'queue');
    $('lyricsPanel').classList.toggle('hidden', ui.sideTab !== 'lyrics');
    $('soundPanel').classList.toggle('hidden', ui.sideTab !== 'sound');
    if (ui.sideTab === 'queue') this.renderQueue();
    if (ui.sideTab === 'lyrics') {
      if (!Player.current) Lyrics.render({ status: 'none' });
      else Lyrics.ensure();
    }
  },

  renderQueue() {
    const el = $('queuePanel');
    if (el.classList.contains('hidden')) return;
    const cur = Player.current;
    const qRow = (t, attrs, actions = '') => `
      <div class="group flex items-center gap-3 p-1.5 rounded-md hover:bg-white/[.06] cursor-pointer" ${attrs}>
        <span class="w-10 h-10 rounded overflow-hidden shrink-0">${coverHtml(t)}</span>
        <span class="min-w-0 flex-1"><span class="block text-sm font-medium text-white truncate">${esc(t.title)}</span><span class="block text-xs text-zinc-400 truncate">${esc(t.artist)}</span></span>
        ${actions}
      </div>`;
    let html = '';
    if (cur) {
      html += `<p class="px-1.5 pt-2 pb-1.5 text-[15px] font-bold text-white">Sonando ahora</p>
        <div class="flex items-center gap-3 p-1.5 rounded-md bg-white/[.05]">
          <span class="w-10 h-10 rounded overflow-hidden shrink-0">${coverHtml(cur)}</span>
          <span class="min-w-0 flex-1"><span class="block text-sm font-medium text-emerald-400 truncate">${esc(cur.title)}</span><span class="block text-xs text-zinc-400 truncate">${esc(cur.artist)}</span></span>
        </div>`;
    } else {
      html += `<p class="px-2 py-10 text-center text-sm text-zinc-400">Tu cola está vacía.<br>Elige algo para escuchar.</p>`;
    }
    if (Player.userQueue.length) {
      html += `<div class="flex items-center justify-between px-1.5 pt-5 pb-1.5"><p class="text-[15px] font-bold text-white">Siguiente en tu cola</p><button data-action="clear-queue" class="text-xs font-semibold text-zinc-400 hover:text-white">Borrar cola</button></div>`;
      html += Player.userQueue.map((id, i) => {
        const t = getTrack(id);
        if (!t) return '';
        const actions = `
          <span class="flex items-center opacity-100 lg:opacity-0 group-hover:opacity-100">
            ${i > 0 ? `<button data-q-up="${i}" aria-label="Subir" class="p-1 text-zinc-400 hover:text-white">${icon('up', 'w-4 h-4')}</button>` : ''}
            <button data-q-remove="${i}" aria-label="Quitar de la cola" class="p-1 text-zinc-400 hover:text-white">${icon('close', 'w-4 h-4')}</button>
          </span>`;
        return qRow(t, `data-q-play="${i}"`, actions);
      }).join('');
    }
    const up = Player.upcoming(40);
    if (up.length) {
      html += `<p class="px-1.5 pt-5 pb-1.5 text-[15px] font-bold text-white truncate">Siguiente de: ${esc(Player.ctx.label)}</p>`;
      html += up.map(({ id, pos }) => { const t = getTrack(id); return t ? qRow(t, `data-ctx-pos="${pos}"`) : ''; }).join('');
    }
    el.innerHTML = html;
  },

  renderSheet() {
    const t = Player.current;
    $('sheetCover').innerHTML = t ? coverHtml(t, 'w-1/3 h-1/3') : '';
    $('sheetTitle').textContent = t ? t.title : 'Nada sonando';
    $('sheetArtist').textContent = t ? t.artist : '';
    $('sheetContext').textContent = Player.ctx.label || 'FreeSong';
    $('sheetSourceBadge').textContent = t ? (t.source === 'audius' && Downloads.has(t.id) ? 'Descargada' : SOURCES[t.source]?.label || '') : '';
    this.updateLike();
    this.updateModes();
    this.updatePlayState();
    this.updateProgress();
  },

  onTrackChange(t) {
    applyTint(t);
    VideoDock.update();
    if (t.source === 'youtube' && !S.ytNoticeSeen) {
      S.ytNoticeSeen = true;
      save();
      showBanner('Las canciones de YouTube suenan con su reproductor oficial: el video se ve en un recuadro, puede haber anuncios (no con YouTube Premium) y se pausan al bloquear la pantalla. Para escuchar con la pantalla bloqueada usa Audius, tus archivos o descargas.', 'info');
    }
    document.title = `${t.title} · ${t.artist}`;
    this.updateNow();
    this.refreshTrackStates();
    this.renderLibrary();
    if (ui.sideTab === 'queue') this.renderQueue();
    if (ui.sideTab === 'lyrics') Lyrics.ensure();
    else Lyrics.forId = null;
    if (Sheet.open) this.renderSheet();
  },

  updateNow() {
    const t = Player.current;
    const cover = t ? coverHtml(t) : `<span class="flex w-full h-full items-center justify-center text-zinc-500">${icon('music', 'w-1/2 h-1/2')}</span>`;
    $('nowCover').innerHTML = cover;
    $('miniCover').innerHTML = cover;
    $('nowTitle').textContent = t ? t.title : 'Elige una canción';
    $('miniTitle').textContent = t ? t.title : 'Elige una canción';
    $('nowArtist').textContent = t ? t.artist : 'FreeSong';
    $('miniArtist').textContent = t ? `${t.artist}${t.source === 'preview' ? ' · Vista previa' : ''}` : 'FreeSong';
    this.updateLike();
    this.updatePlayState();
    this.updateProgress();
    if (Sheet.open) this.renderSheet();
  },

  updateLike() {
    const t = Player.current;
    const liked = !!t && data.likes.includes(t.id);
    for (const id of ['nowLikeBtn', 'miniLikeBtn', 'sheetLikeBtn']) {
      const b = $(id);
      b.querySelector('use').setAttribute('href', liked ? '#i-heart-fill' : '#i-heart');
      b.classList.toggle('text-emerald-400', liked);
      b.setAttribute('aria-label', liked ? 'Quitar de Me gusta' : 'Me gusta');
      b.disabled = !t;
    }
  },

  updatePlayState() {
    const playing = Player.playing;
    document.body.dataset.playing = String(playing);
    for (const id of ['playBtn', 'miniPlayBtn', 'sheetPlayBtn']) {
      const b = $(id);
      b.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
      b.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
      b.classList.toggle('animate-pulse', playing && Player.buffering);
    }
    document.querySelectorAll('[data-hero-play]').forEach((b) => {
      const on = Player.ctx.key === b.dataset.heroPlay && playing;
      b.querySelector('use').setAttribute('href', on ? '#i-pause' : '#i-play');
    });
    const t = Player.current;
    $('engineBadge').textContent = !t ? '' : t.source === 'synth' ? 'Estudio' : t.source === 'youtube' ? 'YouTube' : t.source === 'radio' ? 'En vivo' : S.directOutput ? 'Modo compatible' : '';
    $('deckABar').parentElement.classList.toggle('opacity-40', !Player.canCrossfade());
  },

  updateProgress() {
    if (ui.seeking) return;
    const d = Player.duration();
    const p = Player.position();
    const live = !Number.isFinite(d);
    const max = live || d <= 0 ? 100 : d;
    for (const [slider, cur, dur] of [['seekSlider', 'curTime', 'durTime'], ['sheetSeek', 'sheetCur', 'sheetDur']]) {
      const s = $(slider);
      s.max = String(max);
      s.value = String(live ? 100 : clamp(p, 0, max));
      s.disabled = !Player.current || live;
      $(cur).textContent = live ? 'En vivo' : fmt(p);
      $(dur).textContent = live ? '' : fmt(d);
    }
    $('miniProgress').style.width = `${live ? 100 : d > 0 ? clamp((p / d) * 100, 0, 100) : 0}%`;
  },

  updateModes() {
    for (const id of ['shuffleBtn', 'sheetShuffleBtn']) {
      $(id).classList.toggle('is-on', S.shuffle);
      $(id).setAttribute('aria-pressed', String(S.shuffle));
    }
    for (const id of ['repeatBtn', 'sheetRepeatBtn']) {
      const b = $(id);
      b.classList.toggle('is-on', S.repeat !== 'off');
      b.querySelector('use').setAttribute('href', S.repeat === 'one' ? '#i-repeat-one' : '#i-repeat');
      b.setAttribute('aria-label', S.repeat === 'off' ? 'Repetir: no' : S.repeat === 'all' ? 'Repetir: todo' : 'Repetir: una');
    }
  },

  updateRate() {
    $('rateVal').textContent = `${(S.rate || 1).toFixed(2)}x`;
    document.querySelectorAll('.rate-btn').forEach((b) => {
      const on = Number(b.dataset.rate) === S.rate;
      b.className = `rate-btn py-2 rounded-lg text-[11px] font-semibold leading-tight transition press ${on ? 'bg-emerald-500 text-black' : 'bg-white/[.07] text-zinc-200 hover:bg-white/[.12]'}`;
    });
  },

  updateSound() {
    $('crossfadeSlider').value = String(S.crossfade);
    $('crossfadeVal').textContent = S.crossfade ? `${S.crossfade} s` : 'Apagado';
    $('levelerToggle').checked = S.leveler;
    $('djToggle').checked = S.dj;
    $('djToggle').disabled = !Platform.speech;
    $('directOutputToggle').checked = S.directOutput;
    for (const [k, id] of [['bass', 'eqBass'], ['mid', 'eqMid'], ['treble', 'eqTreble']]) {
      $(id).value = String(S.eq[k]);
      $(`${id}Val`).textContent = `${S.eq[k] > 0 ? '+' : ''}${S.eq[k]} dB`;
      $(id).disabled = S.directOutput;
    }
    $('levelerToggle').disabled = S.directOutput;
    const preset = Object.entries(EQ_PRESETS).find(([, v]) => v[0] === S.eq.bass && v[1] === S.eq.mid && v[2] === S.eq.treble)?.[0];
    document.querySelectorAll('.eq-preset').forEach((b) => {
      const on = b.dataset.preset === preset;
      b.className = `eq-preset py-1.5 rounded-full text-[11px] font-semibold transition press ${on ? 'bg-white text-black' : 'bg-white/[.07] text-zinc-200 hover:bg-white/[.12]'}`;
      b.disabled = S.directOutput;
    });
    const notice = $('directOutputNotice');
    const msgs = [];
    if (S.directOutput) msgs.push('Modo compatible activo: la música va directo al sistema para que siga sonando con la pantalla bloqueada. El ecualizador, el nivelador y el espectro no se aplican a las canciones.');
    if (S.directOutput && !Platform.volumeWritable) msgs.push('En este dispositivo el volumen se controla con los botones físicos y no hay crossfade.');
    if (!Platform.speech) msgs.push('El locutor no está disponible en este dispositivo.');
    notice.innerHTML = msgs.map(esc).join('<br><br>');
    notice.classList.toggle('hidden', !msgs.length);
    $('volumeSlider').value = String(Math.round(S.volume * 100));
    $('volumeSlider').disabled = S.directOutput && !Platform.volumeWritable;
    $('muteBtn').querySelector('use').setAttribute('href', S.muted || S.volume === 0 ? '#i-mute' : '#i-volume');
    this.updateRate();
    this.updatePlayState();
  },

  setDeckBars(p) {
    $('deckABar').style.width = `${(1 - p) * 100}%`;
    $('deckBBar').style.width = `${p * 100}%`;
  },

  refreshTrackStates() {
    document.querySelectorAll('[data-track-id]').forEach((n) => {
      n.dataset.current = String(n.dataset.trackId === Player.currentId);
    });
    document.querySelectorAll('.track-row').forEach((row) => {
      const t = getTrack(row.dataset.trackId);
      if (!t) return;
      const p = row.querySelector('.t-title')?.nextElementSibling;
      if (p) p.innerHTML = `${downloadMark(t)}${pillHtml(t)}<span class="truncate">${esc(t.artist)}</span>`;
      const like = row.querySelector('[data-like]');
      if (like) {
        const liked = data.likes.includes(t.id);
        like.className = `p-1 press ${liked ? 'text-emerald-400' : 'text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-white'}`;
        like.innerHTML = icon(liked ? 'heart-fill' : 'heart', 'w-4 h-4');
      }
    });
    this.updatePlayState();
  },

  playCurrentView() {
    const btn = document.querySelector('[data-action="hero-play"]:not([disabled])');
    if (btn) return btn.click();
    const first = document.querySelector('#mainContent [data-ctx][data-idx]');
    if (first) return playFromNode(first);
    Player.playContext(collection('studio').ids, 0, 'Estudio', 'studio:');
  }
};

const EQ_PRESETS = { flat: [0, 0, 0], bass: [7, -1, 2], vocal: [-2, 5, 3], electronic: [6, -3, 5] };

async function loadTrending() {
  try {
    Cache.trending = await Api.trending();
    Cache.trendingAt = Date.now();
    Cache.trendingErr = false;
  } catch {
    Cache.trendingErr = true;
  }
  if (Nav.view.type === 'home' || (Nav.view.type === 'list' && Nav.view.kind === 'trending')) UI.renderMain();
}

async function loadRemoteList(v) {
  const key = `${v.kind}:${v.id || ''}`;
  Cache.lists.set(key, { status: 'loading' });
  try {
    if (v.kind === 'trending') {
      await loadTrending();
      Cache.lists.delete(key);
      return;
    }
    if (v.kind === 'genre') {
      Cache.lists.set(key, { status: 'ok', tracks: await Api.trending(v.id) });
    } else if (v.kind === 'artist') {
      const a = await Api.artist(v.id);
      Cache.lists.set(key, { status: 'ok', ...a });
    } else if (v.kind === 'radio') {
      Cache.lists.set(key, { status: 'ok', tracks: await Api.radio(v.id) });
    }
  } catch {
    Cache.lists.set(key, { status: 'error', error: navigator.onLine ? 'No se pudo cargar esta lista.' : 'Sin conexión a internet.' });
  }
  const cur = Nav.view;
  if (cur.type === 'list' && `${cur.kind}:${cur.id || ''}` === key) UI.renderMain();
  else if (cur.type === 'home' && key === 'radio:local') UI.renderMain();
}

async function runSearch(q) {
  Cache.search.set(q, { status: 'loading' });
  const [youtube, full, previews, artists] = await Promise.allSettled([Api.searchYouTube(q), Api.searchAudius(q), Api.searchPreviews(q), Api.searchArtists(q)]);
  const val = (r) => (r.status === 'fulfilled' ? r.value : []);
  const failed = [youtube, full, previews, artists].every((r) => r.status === 'rejected');
  Cache.search.set(q, {
    status: 'ok', youtube: val(youtube), full: val(full), previews: val(previews), artists: val(artists),
    ytFailed: youtube.status === 'rejected',
    error: failed ? (navigator.onLine ? 'La búsqueda falló. Intenta de nuevo.' : 'Sin conexión a internet.') : ''
  });
  if (failed) setTimeout(() => Cache.search.delete(q), 100);
  if (Nav.view.type === 'search' && (Nav.view.q || '').trim() === q) UI.renderMain();
}

function emptyStateHtml(kind) {
  const msg = {
    liked: ['Las canciones que te gusten aparecerán aquí', 'Toca el corazón en cualquier canción para guardarla.'],
    downloads: ['Aún no hay descargas', 'Abre ⋯ en una canción de Audius y elige "Descargar".'],
    local: ['Importa tu música', 'Tus MP3, M4A, FLAC o WAV se guardan en este dispositivo y suenan sin internet.'],
    recent: ['Todavía no has escuchado nada', 'Lo que reproduzcas aparecerá aquí.'],
    playlist: ['Esta playlist está vacía', 'Abre ⋯ en una canción y elige "Añadir a playlist".']
  }[kind] || ['No hay canciones aquí', ''];
  return `<div class="px-6 py-14 text-center"><p class="text-lg font-bold text-white">${msg[0]}</p><p class="text-sm text-zinc-400 mt-1 max-w-sm mx-auto">${msg[1]}</p></div>`;
}

function renderDiagnostics() {
  const info = {
    version: '1.0.0',
    plataforma: Platform.native ? 'Android (APK)' : Platform.ios ? 'iOS (web)' : 'Web',
    instalada: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    modoCompatible: S.directOutput,
    volumenControlable: Platform.volumeWritable,
    audioContext: Engine.ctx ? Engine.ctx.state : 'sin iniciar',
    controlesSistema: Media.plugin ? 'Nativo (notificación)' : Media.web ? 'MediaSession web' : 'No disponible',
    locutor: Platform.speech,
    enLinea: navigator.onLine,
    descargas: downloadedIds().length,
    archivosPropios: localIds().length,
    sonando: Player.current ? { id: Player.current.id, fuente: Player.current.source, posicion: Math.round(Player.position()) } : null
  };
  $('diagnosticsPre').textContent = JSON.stringify(info, null, 2);
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then((e) => {
      info.almacenamiento = `${(e.usage / 1048576).toFixed(1)} MB usados de ${(e.quota / 1048576).toFixed(0)} MB`;
      $('diagnosticsPre').textContent = JSON.stringify(info, null, 2);
    }).catch(() => {});
  }
}

// ============================================================================
// 16. Menús, avisos y playlists
// ============================================================================
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function showBanner(msg, kind = 'info') {
  const b = $('statusBanner');
  $('statusText').textContent = msg;
  b.className = `sticky top-0 z-20 mx-3 mt-3 px-3.5 py-2.5 rounded-xl border text-xs flex items-start justify-between gap-2 backdrop-blur-md ${kind === 'warn' ? 'bg-amber-950/80 border-amber-500/30 text-amber-200' : 'bg-zinc-900/90 border-white/10 text-zinc-200'}`;
}

const Menu = {
  isOpen() { return !$('actionMenu').classList.contains('hidden'); },
  show(headHtml, items) {
    $('actionMenuHead').innerHTML = headHtml;
    $('actionMenuItems').innerHTML = items.map((it, i) => it.sep
      ? '<div class="my-1 border-t border-zinc-800"></div>'
      : `<button data-menu-item="${i}" class="w-full flex items-center gap-3.5 px-3 py-3 rounded-lg text-left text-[15px] hover:bg-white/[.07] ${it.danger ? 'text-rose-300' : 'text-zinc-100'}">${icon(it.icon, 'w-5 h-5 text-zinc-400 shrink-0')}<span>${esc(it.label)}</span></button>`).join('');
    this.items = items;
    $('actionMenu').classList.remove('hidden');
    $('actionMenuItems').querySelector('button')?.focus({ preventScroll: true });
  },
  close() { $('actionMenu').classList.add('hidden'); this.items = []; },
  items: []
};

function trackMenu(t) {
  const v = Nav.view;
  const liked = data.likes.includes(t.id);
  const inPlaylist = v.type === 'list' && v.kind === 'playlist' ? data.playlists.find((p) => p.id === v.id) : null;
  const items = [
    { icon: 'next', label: 'Reproducir a continuación', run: () => Player.addToQueue(t.id, { next: true }) },
    { icon: 'queue', label: 'Añadir a la cola', run: () => Player.addToQueue(t.id) },
    { icon: 'plus', label: 'Añadir a playlist', run: () => setTimeout(() => playlistPicker(t), 0) },
    inPlaylist ? { icon: 'close', label: 'Quitar de esta playlist', run: () => removeFromPlaylist(inPlaylist, t.id) } : null,
    { icon: liked ? 'heart-fill' : 'heart', label: liked ? 'Quitar de Me gusta' : 'Guardar en Me gusta', run: () => toggleLike(t.id) },
    { sep: true },
    t.source === 'audius' && !Downloads.has(t.id) ? { icon: 'download', label: 'Descargar para escuchar sin internet', run: () => Downloads.download(t) } : null,
    t.source === 'audius' && Downloads.has(t.id) ? { icon: 'trash', label: 'Eliminar descarga', run: () => Downloads.remove(t) } : null,
    t.source === 'local' ? { icon: 'trash', label: 'Eliminar archivo del dispositivo', danger: true, run: () => { if (confirm(`¿Eliminar "${t.title}" de este dispositivo?`)) Downloads.remove(t); } } : null,
    t.artistId ? { icon: 'person', label: 'Ir al artista', run: () => Sheet.closeThen(() => Nav.go({ type: 'list', kind: 'artist', id: t.artistId, name: t.artist })) } : null,
    t.genre ? { icon: 'mix', label: `Mix de ${t.genre}`, run: () => startGenreRadio(t) } : null,
    t.source === 'preview' && t.link ? { icon: 'external', label: 'Escuchar completa en Apple Music', run: () => openExternal(t.link) } : null,
    t.source === 'audius' && t.link ? { icon: 'external', label: 'Abrir en Audius', run: () => openExternal(t.link) } : null,
    t.source === 'youtube' && t.link ? { icon: 'external', label: 'Abrir en YouTube', run: () => openExternal(t.link) } : null,
    t.source === 'radio' && t.link ? { icon: 'external', label: 'Abrir el sitio de la emisora', run: () => openExternal(t.link) } : null
  ].filter(Boolean);
  const info = t.source === 'preview' && t.fullDuration ? ` · completa: ${fmt(t.fullDuration)}` : '';
  const head = `
    <span class="w-12 h-12 rounded overflow-hidden shrink-0">${coverHtml(t)}</span>
    <span class="min-w-0"><span class="block text-[15px] font-semibold text-white truncate">${esc(t.title)}</span><span class="block text-[13px] text-zinc-400 truncate">${esc(t.artist)} · ${esc(SOURCES[t.source]?.label || '')}${esc(info)}</span></span>`;
  Menu.show(head, items);
}

function playlistPicker(t) {
  const items = [
    { icon: 'plus', label: 'Nueva playlist', run: () => openPlaylistModal(t.id) },
    ...data.playlists.map((p) => ({ icon: 'music', label: p.name, run: () => addToPlaylist(p, t.id) }))
  ];
  Menu.show(`<span class="text-[15px] font-bold text-white">Añadir a playlist</span>`, items);
}

function openExternal(url) {
  const u = safeUrl(url);
  if (u) window.open(u, '_blank', 'noopener');
}

async function startGenreRadio(t) {
  toast(`Preparando radio de ${t.genre}…`);
  try {
    const list = await Api.trending(t.genre);
    const ids = [t.id, ...shuffled(list.map((x) => x.id).filter((id) => id !== t.id))];
    Player.playContext(ids, 0, `Mix: ${t.genre}`, `mix:${t.genre}`, { shuffle: false });
  } catch {
    toast('No se pudo crear la radio');
  }
}

function toggleLike(id) {
  const t = getTrack(id);
  if (!t) return;
  const i = data.likes.indexOf(id);
  if (i === -1) {
    data.likes.unshift(id);
    remember(t);
    toast('Guardada en Tus me gusta');
  } else {
    data.likes.splice(i, 1);
    toast('Quitada de Tus me gusta');
  }
  save();
  UI.updateLike();
  UI.refreshTrackStates();
  UI.renderLibrary();
  if (Nav.view.type === 'list' && Nav.view.kind === 'liked') UI.renderMain();
}

let pendingPlaylistTrack = null;
function openPlaylistModal(trackId = null) {
  pendingPlaylistTrack = trackId;
  $('playlistModal').classList.remove('hidden');
  const input = $('playlistNameInput');
  input.value = '';
  setTimeout(() => input.focus(), 50);
}
function closePlaylistModal() {
  $('playlistModal').classList.add('hidden');
  pendingPlaylistTrack = null;
}

function addToPlaylist(pl, id) {
  const t = getTrack(id);
  if (!t) return;
  if (pl.trackIds.includes(id)) return toast(`Ya está en "${pl.name}"`);
  pl.trackIds.push(id);
  remember(t);
  save();
  toast(`Añadida a "${pl.name}"`);
  UI.renderLibrary();
  if (Nav.view.type === 'list' && Nav.view.id === pl.id) UI.renderMain();
}

function removeFromPlaylist(pl, id) {
  pl.trackIds = pl.trackIds.filter((x) => x !== id);
  save();
  toast(`Quitada de "${pl.name}"`);
  UI.renderLibrary();
  UI.renderMain();
}

function playlistMenu(pl) {
  Menu.show(`<span class="text-[15px] font-bold text-white truncate">${esc(pl.name)}</span>`, [
    { icon: 'tune', label: 'Cambiar nombre', run: () => {
      const name = (prompt('Nuevo nombre de la playlist', pl.name) || '').trim().slice(0, 60);
      if (name) { pl.name = name; save(); UI.renderMain(); UI.renderLibrary(); }
    } },
    { icon: 'trash', label: 'Eliminar playlist', danger: true, run: () => {
      if (!confirm(`¿Eliminar la playlist "${pl.name}"?`)) return;
      data.playlists = data.playlists.filter((p) => p.id !== pl.id);
      save();
      toast('Playlist eliminada');
      Nav.go({ type: 'home' }, { replace: true });
    } }
  ]);
}

// ============================================================================
// 17. Espectro
// ============================================================================
function initSpectrum() {
  const canvas = $('spectrumCanvas');
  const ctx2d = canvas.getContext('2d');
  const bins = new Uint8Array(128);
  const fit = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
  };
  new ResizeObserver(fit).observe(canvas);
  const draw = () => {
    requestAnimationFrame(draw);
    if (document.hidden || canvas.offsetParent === null) return;
    const w = canvas.width, h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);
    const live = Engine.analyser && Player.playing && (!S.directOutput || Player.isSynth());
    if (live) Engine.analyser.getByteFrequencyData(bins);
    else bins.fill(0);
    const n = 32;
    const gap = Math.max(1, w / n * 0.25);
    const bw = w / n - gap;
    if (bw <= 0.5 || h < 4) return;
    const [r, g, b] = spectrumColor;
    for (let i = 0; i < n; i++) {
      const v = live ? bins[Math.floor(i * 1.6)] / 255 : 0;
      const bh = Math.max(h * 0.04, v * (h - 4));
      ctx2d.fillStyle = `rgba(${Math.min(255, r + 60)},${Math.min(255, g + 60)},${Math.min(255, b + 60)},${0.35 + v * 0.65})`;
      ctx2d.beginPath();
      const x = i * (bw + gap) + gap / 2;
      if (ctx2d.roundRect) ctx2d.roundRect(x, h - bh, bw, bh, Math.max(0, Math.min(3, bw / 2, bh / 2)));
      else ctx2d.rect(x, h - bh, bw, bh);
      ctx2d.fill();
    }
  };
  draw();
}

// ============================================================================
// 18. Eventos
// ============================================================================
function playFromNode(node) {
  const reg = Reg.get(node.dataset.ctx);
  if (!reg) return;
  const idx = Number(node.dataset.idx);
  const id = reg.ids[idx];
  if (id === Player.currentId && Player.ctx.key === reg.key) return Player.toggle();
  Player.playContext(reg.ids, idx, reg.label, reg.key);
}

function bindEvents() {
  // Clics delegados en listas, tarjetas y biblioteca
  document.addEventListener('click', (e) => {
    const target = e.target;

    const like = target.closest('[data-like]');
    if (like) { e.stopPropagation(); return toggleLike(like.dataset.like); }

    const menuBtn = target.closest('[data-menu]');
    if (menuBtn) { e.stopPropagation(); const t = getTrack(menuBtn.dataset.menu); if (t) trackMenu(t); return; }

    const viewBtn = target.closest('[data-view]');
    if (viewBtn) { const v = Reg.get(viewBtn.dataset.view); if (v) { if (v.type === 'search') return Nav.go({ type: 'search', q: ui.searchQ }); return Nav.go(v); } }

    const action = target.closest('[data-action]');
    if (action) {
      const a = action.dataset.action;
      if (a === 'retry-trending') { Cache.trendingErr = false; UI.renderMain(); }
      else if (a === 'retry-list') { const v = Nav.view; Cache.lists.delete(`${v.kind}:${v.id || ''}`); UI.renderMain(); }
      else if (a === 'clear-queue') { Player.userQueue = []; UI.renderQueue(); }
      else if (a === 'playlist-menu') { const pl = data.playlists.find((p) => p.id === action.dataset.id); if (pl) playlistMenu(pl); }
      else if (a === 'hero-play' || a === 'hero-shuffle') {
        const reg = Reg.get(action.dataset.ctx);
        if (!reg || !reg.ids.length) return;
        if (a === 'hero-play' && Player.ctx.key === reg.key && Player.current) return Player.toggle();
        Player.playContext(reg.ids, a === 'hero-shuffle' ? -1 : 0, reg.label, reg.key, a === 'hero-shuffle' ? { shuffle: true } : {});
      }
      return;
    }

    const playable = target.closest('[data-ctx][data-idx]');
    if (playable) return playFromNode(playable);

    const qPlay = target.closest('[data-q-play]');
    const qUp = target.closest('[data-q-up]');
    const qRemove = target.closest('[data-q-remove]');
    if (qUp) { const i = Number(qUp.dataset.qUp); [Player.userQueue[i - 1], Player.userQueue[i]] = [Player.userQueue[i], Player.userQueue[i - 1]]; return UI.renderQueue(); }
    if (qRemove) { Player.userQueue.splice(Number(qRemove.dataset.qRemove), 1); return UI.renderQueue(); }
    if (qPlay) return Player.playFromUserQueue(Number(qPlay.dataset.qPlay));
    const ctxPos = target.closest('[data-ctx-pos]');
    if (ctxPos) return Player.jumpTo(Number(ctxPos.dataset.ctxPos));

    const libFilter = target.closest('[data-lib-filter]');
    if (libFilter) { ui.libFilter = libFilter.dataset.libFilter; return UI.renderLibrary(); }

    const sideTab = target.closest('[data-side-tab]');
    if (sideTab) { ui.sideTab = sideTab.dataset.sideTab; return UI.renderSide(); }

    const openSide = target.closest('[data-open-side]');
    if (openSide) {
      ui.sideTab = openSide.dataset.openSide;
      const go = () => { if (!window.matchMedia('(min-width: 1024px)').matches) setTab('side'); UI.renderSide(); };
      return Sheet.open ? Sheet.closeThen(go) : go();
    }

    const tabBtn = target.closest('[data-tab-btn]');
    if (tabBtn) {
      const tab = tabBtn.dataset.tabBtn;
      if (tab === 'home') {
        if (Nav.view.type !== 'home') Nav.go({ type: 'home' });
        setTab('home');
      } else if (tab === 'search') {
        if (Nav.view.type !== 'search') Nav.go({ type: 'search', q: ui.searchQ });
        setTab('search');
        setTimeout(() => document.querySelector('[data-search-input]')?.focus(), 50);
      } else {
        setTab(tab);
      }
      return;
    }

    const menuItem = target.closest('[data-menu-item]');
    if (menuItem) {
      const it = Menu.items[Number(menuItem.dataset.menuItem)];
      Menu.close();
      if (it?.run) it.run();
      return;
    }
    if (target.id === 'actionMenu') Menu.close();
    if (target.id === 'playlistModal' || target.closest('[data-close-modal]')) {
      if (target.closest('#playlistModal')) closePlaylistModal();
      if (target.closest('#actionMenu')) Menu.close();
    }
  });

  // Enter / espacio sobre filas y tarjetas
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-ctx][data-idx], [data-view][role="button"]')) {
      e.preventDefault();
      e.target.click();
    }
  });

  // Errores de carátulas: se prueba un servidor espejo y, si no hay, queda el degradado de fondo
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName !== 'IMG' || !img.hasAttribute('data-cover')) return;
    const alts = (img.dataset.alt || '').split(' ').filter(Boolean);
    if (alts.length) {
      img.dataset.alt = alts.slice(1).join(' ');
      img.src = alts[0];
    } else {
      img.remove();
    }
  }, true);

  // Búsqueda
  const doSearch = (q, { push = false } = {}) => {
    q = q.trim();
    ui.searchQ = q;
    $('headerSearchInput').value = q;
    const v = { type: 'search', q };
    if (Nav.view.type === 'search' && !push) {
      Nav.view = v;
      history.replaceState({ view: v }, '');
      UI.renderMain();
    } else {
      Nav.go(v);
    }
  };
  const live = debounce((q) => { if (q.trim().length >= 2 || !q.trim()) doSearch(q); }, 450);
  $('headerSearchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch($('headerSearchInput').value, { push: Nav.view.type !== 'search' }); });
  $('headerSearchInput').addEventListener('input', (e) => {
    if (Nav.view.type !== 'search') { Nav.go({ type: 'search', q: '' }); }
    live(e.target.value);
  });
  document.addEventListener('submit', (e) => {
    if (e.target.matches('[data-search-form]')) {
      e.preventDefault();
      const input = e.target.querySelector('[data-search-input]');
      input.blur();
      doSearch(input.value);
    }
  });
  // Búsqueda en vivo del celular: al re-renderizar se conserva el foco y el cursor
  const liveMobile = debounce((q, input) => {
    if (q.trim().length >= 2 || !q.trim()) {
      const pos = input.selectionStart;
      doSearch(q);
      const again = document.querySelector('[data-search-input]');
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* nada */ } }
    }
  }, 500);
  document.addEventListener('input', (e) => {
    if (e.target.matches('[data-search-input]')) liveMobile(e.target.value, e.target);
  });

  // Navegación general
  $('logoBtn').addEventListener('click', () => { Nav.go({ type: 'home' }); setTab('home'); });
  $('backBtn').addEventListener('click', () => history.back());
  $('installNavBtn').addEventListener('click', () => Nav.go({ type: 'install' }));
  $('installBackBtn').addEventListener('click', () => history.back());
  $('statusCloseBtn').addEventListener('click', () => $('statusBanner').classList.add('hidden'));
  $('installPromptBtn').addEventListener('click', async () => {
    if (!ui.installEvent) return;
    ui.installEvent.prompt();
    await ui.installEvent.userChoice.catch(() => {});
    ui.installEvent = null;
    $('installPromptBtn').classList.add('hidden');
  });

  // Controles de reproducción
  for (const id of ['playBtn', 'miniPlayBtn', 'sheetPlayBtn']) $(id).addEventListener('click', (e) => { e.stopPropagation(); Player.toggle(); });
  for (const id of ['nextBtn', 'sheetNextBtn']) $(id).addEventListener('click', () => Player.next());
  for (const id of ['prevBtn', 'sheetPrevBtn']) $(id).addEventListener('click', () => Player.prev());
  for (const id of ['shuffleBtn', 'sheetShuffleBtn']) $(id).addEventListener('click', () => Player.setShuffle(!S.shuffle));
  for (const id of ['repeatBtn', 'sheetRepeatBtn']) $(id).addEventListener('click', () => Player.cycleRepeat());
  for (const id of ['nowLikeBtn', 'miniLikeBtn', 'sheetLikeBtn']) $(id).addEventListener('click', (e) => { e.stopPropagation(); if (Player.current) toggleLike(Player.currentId); });
  $('miniOpenBtn').addEventListener('click', () => { if (Player.current) Sheet.show(); });
  $('sheetCloseBtn').addEventListener('click', () => Sheet.close());
  $('sheetMoreBtn').addEventListener('click', () => { if (Player.current) trackMenu(Player.current); });
  const toArtist = () => {
    const t = Player.current;
    if (t?.artistId) Sheet.closeThen(() => Nav.go({ type: 'list', kind: 'artist', id: t.artistId, name: t.artist }));
  };
  $('nowArtist').addEventListener('click', toArtist);
  $('sheetArtist').addEventListener('click', toArtist);
  $('footerMixBtn').addEventListener('click', () => Player.mixNow());
  $('mixNowBtn').addEventListener('click', () => Player.mixNow());

  // Deslizar hacia abajo para cerrar la hoja del reproductor
  let touchY = null;
  $('nowSheet').addEventListener('touchstart', (e) => { touchY = e.target.closest('input') ? null : e.touches[0].clientY; }, { passive: true });
  $('nowSheet').addEventListener('touchend', (e) => {
    if (touchY !== null && e.changedTouches[0].clientY - touchY > 110) Sheet.close();
    touchY = null;
  }, { passive: true });

  // Barras de posición
  for (const [sliderId, curId] of [['seekSlider', 'curTime'], ['sheetSeek', 'sheetCur']]) {
    const s = $(sliderId);
    s.addEventListener('input', () => { ui.seeking = true; $(curId).textContent = fmt(Number(s.value)); });
    s.addEventListener('change', () => { ui.seeking = false; Player.seek(Number(s.value)); });
  }

  // Volumen
  $('volumeSlider').addEventListener('input', (e) => {
    S.volume = Number(e.target.value) / 100;
    S.muted = false;
    Engine.applyVolume();
    UI.updateSound();
    save();
  });
  $('muteBtn').addEventListener('click', () => {
    S.muted = !S.muted;
    Engine.applyVolume();
    UI.updateSound();
    save();
  });

  // Sonido
  $('crossfadeSlider').addEventListener('input', (e) => {
    S.crossfade = Number(e.target.value);
    $('crossfadeVal').textContent = S.crossfade ? `${S.crossfade} s` : 'Apagado';
    save();
  });
  $('levelerToggle').addEventListener('change', (e) => { S.leveler = e.target.checked; Engine.connectLeveler(); save(); });
  $('djToggle').addEventListener('change', (e) => {
    S.dj = e.target.checked;
    save();
    if (S.dj && Player.current) Dj.announce(Player.current);
  });
  $('directOutputToggle').addEventListener('change', (e) => {
    S.directOutput = e.target.checked;
    save();
    Player.rebuildDecks();
    UI.updateSound();
    toast(S.directOutput ? 'Modo compatible activado' : 'Modo compatible desactivado');
  });
  document.querySelectorAll('.rate-btn').forEach((b) => b.addEventListener('click', () => Player.setRate(Number(b.dataset.rate))));
  const setEq = (bass, mid, treble) => {
    S.eq = { bass, mid, treble };
    Engine.applyEq();
    UI.updateSound();
    save();
  };
  for (const [k, id] of [['bass', 'eqBass'], ['mid', 'eqMid'], ['treble', 'eqTreble']]) {
    $(id).addEventListener('input', (e) => setEq(...['bass', 'mid', 'treble'].map((x) => (x === k ? Number(e.target.value) : S.eq[x]))));
  }
  $('eqResetBtn').addEventListener('click', () => setEq(0, 0, 0));
  document.querySelectorAll('.eq-preset').forEach((b) => b.addEventListener('click', () => setEq(...EQ_PRESETS[b.dataset.preset])));
  $('sleepSelect').addEventListener('change', (e) => {
    const v = e.target.value;
    Sleep.set(v);
    e.target.value = v;
  });

  // Letras: tocar una línea salta a ese momento; no auto-desplazar si el usuario está leyendo
  $('lyricsPanel').addEventListener('click', (e) => {
    const line = e.target.closest('.lyric-line');
    if (!line || !Lyrics.synced) return;
    const l = Lyrics.lines[Number(line.dataset.line)];
    if (l && l.t != null) Player.seek(l.t);
  });
  for (const ev of ['wheel', 'touchmove']) $('lyricsPanel').addEventListener(ev, () => { Lyrics.userScrollAt = Date.now(); }, { passive: true });

  // Llave opcional de YouTube Data API (solo se guarda en este dispositivo)
  const paintYtKey = () => {
    $('ytKeyStatus').textContent = S.ytKey ? 'Usando tu llave de YouTube (búsqueda oficial).' : 'Usando la búsqueda pública (Piped).';
  };
  $('ytKeyInput').value = S.ytKey;
  paintYtKey();
  $('ytKeyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('ytKeyInput').value.trim();
    if (key && !/^[\w-]{20,60}$/.test(key)) return toast('Esa llave no parece válida');
    if (key) {
      try {
        await fetchJson(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: 'id', id: 'dQw4w9WgXcQ', key })}`);
      } catch {
        return toast('YouTube rechazó la llave. Revisa que la API "YouTube Data API v3" esté activada.');
      }
    }
    S.ytKey = key;
    save();
    Cache.search.clear();
    paintYtKey();
    toast(key ? 'Llave de YouTube guardada' : 'Llave eliminada');
  });

  // Archivos propios y playlists
  $('localAudioInput').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
  $('newPlaylistBtn').addEventListener('click', () => openPlaylistModal());
  $('playlistForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('playlistNameInput').value.trim().slice(0, 60);
    if (!name) return;
    const pl = { id: `pl-${uid()}`, name, trackIds: [], createdAt: Date.now() };
    data.playlists.unshift(pl);
    const trackId = pendingPlaylistTrack;
    closePlaylistModal();
    if (trackId) addToPlaylist(pl, trackId);
    else save();
    UI.renderLibrary();
    if (!trackId) Nav.go({ type: 'list', kind: 'playlist', id: pl.id });
    toast(`Playlist "${name}" creada`);
  });

  // Atajos de teclado (computador)
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, [contenteditable]')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Escape') {
      if (Menu.isOpen()) return Menu.close();
      if (!$('playlistModal').classList.contains('hidden')) return closePlaylistModal();
      if (Sheet.open) return Sheet.close();
    }
    if (e.key === ' ' && !e.target.closest('button, [role="button"]')) { e.preventDefault(); Player.toggle(); }
    else if (e.key === 'ArrowRight' && e.shiftKey) Player.next();
    else if (e.key === 'ArrowLeft' && e.shiftKey) Player.prev();
    else if (e.key === 'ArrowRight') Player.seek(Player.position() + 5);
    else if (e.key === 'ArrowLeft') Player.seek(Player.position() - 5);
    else if (e.key.toLowerCase() === 'm') $('muteBtn').click();
    else if (e.key.toLowerCase() === 'l' && Player.current) toggleLike(Player.currentId);
    else if (e.key === '/' ) { e.preventDefault(); $('headerSearchInput').focus(); }
  });

  // Conexión
  const onNet = () => {
    $('offlinePill').classList.toggle('hidden', navigator.onLine);
    if (!navigator.onLine) toast('Sin conexión: puedes escuchar tus descargas, tus archivos y el Estudio');
  };
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);
  onNet();

  // Instalación PWA (Chrome / Android web)
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    ui.installEvent = e;
    $('installPromptBtn').classList.remove('hidden');
  });

  // Guardar al salir y asegurar continuidad de audio en segundo plano
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      saveNow();
      if (Engine.ctx && Player.playing && Engine.ctx.state !== 'running') {
        Engine.ctx.resume().catch(() => {});
      }
    } else {
      if (Engine.ctx && Player.playing && Engine.ctx.state !== 'running') {
        Engine.ctx.resume().catch(() => {});
      }
      Media.setState();
    }
  });

  // Botón Atrás de Android (APK): cerrar menús, volver, o minimizar sin parar la música
  const AppPlugin = nativePlugin('App');
  if (AppPlugin) {
    AppPlugin.addListener('backButton', ({ canGoBack }) => {
      if (Menu.isOpen()) return Menu.close();
      if (!$('playlistModal').classList.contains('hidden')) return closePlaylistModal();
      if (Sheet.open) return Sheet.close();
      if (canGoBack && history.state?.view?.type !== 'home') return history.back();
      AppPlugin.minimizeApp();
    });
  }
}

// ============================================================================
// 19. Arranque
// ============================================================================
async function boot() {
  // Restaurar canciones guardadas
  for (const meta of Object.values(data.tracks)) if (meta?.id && !BUILTIN_IDS.has(meta.id)) addTrack(meta);
  await Downloads.init();

  // Quitar archivos propios cuyo audio ya no existe y metadatos huérfanos
  for (const t of [...catalog.values()]) {
    if (t.source === 'local' && !Downloads.has(t.id)) {
      catalog.delete(t.id);
      delete data.tracks[t.id];
    }
  }
  const used = new Set([...data.likes, ...data.recent, ...data.playlists.flatMap((p) => p.trackIds), ...Downloads.ids]);
  for (const id of Object.keys(data.tracks)) if (!used.has(id)) delete data.tracks[id];
  data.likes = data.likes.filter((id) => catalog.has(id));
  save();

  // Safari 16.4+: sesión de audio de reproducción (suena aunque el iPhone esté en silencio)
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* nada */ }

  Player.ytDecks = [new YTDeck('Y1'), new YTDeck('Y2')];
  VideoDock.initDrag();

  history.replaceState({ view: Nav.view }, '');
  setTab('home');
  bindEvents();
  UI.updateModes();
  UI.updateSound();
  UI.renderAll();
  initSpectrum();
  Media.init();

  if (S.directOutput && Platform.ios) $('directOutputToggle').title = 'Recomendado en iPhone';

  if ('serviceWorker' in navigator && !Platform.native && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();

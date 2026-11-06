// FreeSong Web Music Player v3.9.0 para iPhone (iOS) y Web
// Motores: Audio Blindado Edge CDN, Modo Offline Cache API, Perfil de Artista, DJ IA ✨, Live Search y Canvas Lyrics Share
(() => {
  'use strict';

  // Detección precisa de iOS (iPhone, iPad, iPod, y Safari en iOS modernos)
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // --- Bloqueo global de Zoom en iOS Safari (Pinch-to-zoom y Doble Tap) ---
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1 || (e.scale && e.scale !== 1)) {
      e.preventDefault();
    }
  }, { passive: false });

  // El zoom por doble toque ya se evita con `touch-action: manipulation` (app.css).
  // No se cancela `touchend` aquí: anulaba el 2.º toque rápido (p. ej. dos veces en "siguiente").

  ['gesturestart', 'gesturechange', 'gestureend', 'dblclick'].forEach((ev) => {
    window.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  });

  // Detección de pantalla bloqueada o pestaña en segundo plano
  function isBackground() {
    return document.visibilityState === 'hidden';
  }

  // --- Elementos del DOM ---
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  // Escapa texto dinámico (títulos, artistas, nombres de playlist) antes de usarlo en innerHTML
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Versión y diagnóstico local (sin telemetría). Se inicializan pronto para
  // que cualquier evento de audio pueda registrar datos sin riesgos.
  const APP_VERSION = '3.9.0';
  const DIAG_KEY = 'fs_diag_v1';
  let diagData = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DIAG_KEY) || 'null');
      if (saved && typeof saved === 'object') return saved;
    } catch {}
    return {};
  })();

  // Las miniaturas de YouTube Music llegan en 120 px. En pantallas Retina eso
  // se ve pixelado en el reproductor y en las tarjetas. Esta función pide la
  // variante adecuada al mismo host: 160 px para listas y 480–720 px para
  // portadas grandes, sin descargar imágenes enormes en cada fila.
  function thumbAt(url, size = 160) {
    const raw = String(url || '');
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
    const px = Math.max(64, Math.round(Number(size) || 160));
    try {
      const u = new URL(raw, window.location.href);
      if (/(^|\.)googleusercontent\.com$/i.test(u.hostname)) {
        // Formatos: ...=w120-h120-l90-rj o ...=s120-c-k-c0x00ffffff-no-rj
        u.pathname = u.pathname.replace(/=(?:w\d+|h\d+|s\d+)[^/]*$/i, `=w${px}-h${px}-l90-rj`);
        return u.toString();
      }
      if (/(^|\.)ytimg\.com$/i.test(u.hostname)) {
        const m = u.pathname.match(/^\/vi\/([\w-]+)\//);
        if (m) {
          const file = px >= 480 ? 'maxresdefault' : 'mqdefault';
          return `https://i.ytimg.com/vi/${m[1]}/${file}.jpg`;
        }
      }
    } catch {}
    return raw;
  }

  // Aplica una miniatura a un <img> existente y prepara su respaldo.
  function setThumbSrc(img, track, size) {
    if (!img) return;
    if (track && track.id) img.setAttribute('data-vid', track.id);
    else img.removeAttribute('data-vid');
    img.removeAttribute('data-thumb-fell-back');
    img.src = thumbAt(track && track.thumbnail, size) || 'icons/icon-192.png';
  }

  // Si una portada `maxresdefault` no existe (vídeos antiguos), cae a la
  // versión estándar sin dejar un hueco roto en la interfaz. Si falla yt3
  // (YouTube a veces responde 429), se usa el fotograma del vídeo.
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!img || img.tagName !== 'IMG') return;
    const src = img.currentSrc || img.src || '';

    if (!img.dataset.thumbFellBack) {
      const vid = img.getAttribute('data-vid');
      if (vid) {
        img.dataset.thumbFellBack = '1';
        const wide = (img.getBoundingClientRect().width || 0) >= 180;
        img.src = `https://i.ytimg.com/vi/${vid}/${wide ? 'hqdefault' : 'mqdefault'}.jpg`;
        return;
      }
    }

    if (/maxresdefault\.jpg/.test(src)) {
      img.src = src.replace('maxresdefault.jpg', 'hqdefault.jpg');
    }
  }, true);

  // --- Historial del navegador ligado a los paneles: "atrás" (o el gesto) cierra el panel abierto ---
  // Cada panel agrega una entrada al abrirse; al cerrarlo por otro medio hay que retirarla,
  // si no el historial se llena de entradas vacías y "atrás" deja de hacer nada visible.
  let popGuard = 0; // retrocesos provocados por nosotros al cerrar un panel
  let inPopstate = false; // el navegador ya retrocedió por su cuenta
  const pendingPushes = []; // paneles abiertos mientras un retroceso nuestro sigue en curso

  function pushModalState(name) {
    if (popGuard > 0) {
      pendingPushes.push(name);
      return;
    }
    try { history.pushState({ modal: name }, ''); } catch {}
  }

  function popModalState() {
    if (inPopstate) return;
    if (pendingPushes.length > 0) {
      pendingPushes.pop();
      return;
    }
    if (!(history.state && history.state.modal)) return;
    popGuard++;
    try { history.back(); } catch { popGuard--; }
  }

  // Mezcla uniforme (Fisher-Yates); sort(() => Math.random() - 0.5) está sesgado
  function shuffled(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // --- Sistema de Notificaciones Toast Flotantes ---
  let toastTimer = null;
  function showToast(message, duration = 2400) {
    const toast = $('toastNotification');
    const textEl = $('toastText');
    if (!toast || !textEl) return;
    textEl.textContent = message;
    toast.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-[-10px]');
    toast.classList.add('opacity-100', 'translate-y-0');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', 'pointer-events-none', 'translate-y-[-10px]');
    }, duration);
  }

  // --- Actualizaciones de la PWA ---
  // Nunca recarga sola: si hay música sonando, el aviso espera a que la persona
  // pulse "Actualizar" para no cortar la reproducción.
  let swRegistration = null;
  let updateDismissed = false;
  let updateReloading = false;

  function showUpdateBanner() {
    const banner = $('updateBanner');
    if (banner && !updateDismissed) banner.classList.remove('hidden');
  }

  function hideUpdateBanner() {
    $('updateBanner')?.classList.add('hidden');
  }

  function applyAppUpdate() {
    if (updateReloading) return;
    updateReloading = true;
    hideUpdateBanner();
    try { swRegistration?.waiting?.postMessage({ type: 'SKIP_WAITING' }); } catch {}
    // Margen para que el nuevo service worker tome el control antes de recargar.
    setTimeout(() => window.location.reload(), 300);
  }

  function setupPwaUpdates() {
    $('updateNowBtn')?.addEventListener('click', applyAppUpdate);
    $('updateLaterBtn')?.addEventListener('click', () => {
      updateDismissed = true;
      hideUpdateBanner();
    });

    if (!('serviceWorker' in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.register('/sw.js').then((reg) => {
      swRegistration = reg;
      if (reg.waiting && hadController) showUpdateBanner();
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner();
        });
      });
    }).catch(() => {});

    // Con skipWaiting() la versión nueva puede activarse mientras se escucha.
    // Solo se avisa (no se recarga) cuando ya había una versión controlando.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !updateReloading) showUpdateBanner();
    });

    // Busca actualizaciones al volver a la app, como mucho una vez por hora.
    let lastUpdateCheck = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !swRegistration) return;
      const now = Date.now();
      if (now - lastUpdateCheck < 60 * 60 * 1000) return;
      lastUpdateCheck = now;
      swRegistration.update().catch(() => {});
    });
  }

  // --- Estado Global de la Aplicación (v3.0.0 Ultra) ---
  const S = {
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    crossfade: false,
    crossfadeDuration: 6,
    shuffleMode: 0, // 0: Desactivado, 1: Aleatorio Normal, 2: Smart Shuffle ✨
    repeat: 'all', // 'off', 'all', 'one'
    favorites: JSON.parse(localStorage.getItem('fs_favorites') || '[]'),
    downloads: JSON.parse(localStorage.getItem('fs_downloads') || '[]'),
    offlineBlobUrls: new Map(),
    currentTrack: null,
    pendingResume: null, // { id, seconds } para retomar donde se quedó al reabrir
    isDownloadingMap: {},
    recentSearches: JSON.parse(localStorage.getItem('fs_recent_searches') || '[]'),
    djVibeIndex: 0,
    history: JSON.parse(localStorage.getItem('fs_history') || '[]'),
    playlists: JSON.parse(localStorage.getItem('fs_playlists') || '[]'),
    stats: JSON.parse(localStorage.getItem('fs_stats') || '{"totalPlays":0,"songs":{},"artists":{}}'),
    playbackRate: 1.0,
    audioQuality: ['140', '139'].includes(localStorage.getItem('fs_quality')) ? localStorage.getItem('fs_quality') : '140',
    audioNormalize: localStorage.getItem('fs_normalize') !== 'false',
    autoplayInfinite: localStorage.getItem('fs_autoplay') !== 'false',
    smartShuffleInjectCount: 0,
    syncedLyrics: [],
    currentLyricIdx: -1,
    lyricsTrackId: null,
    lyricsOffset: 0,
    activeTab: 'home',
    activeChip: 'todo',
    activePlayerSubTab: 'track', // 'track', 'queue', 'lyrics', 'similar'
    libFilter: 'likes', // 'likes', 'downloads', 'playlists', 'history', 'stats'
    libSearch: '',
    openPlaylistId: null, // playlist abierta en el detalle de la biblioteca
    libSort: 'recent',
    menuTargetTrack: null,
    sleepTimerMinutes: null,
    sleepTimerEndTrack: false,
    sleepTimerInterval: null,
    sleepTimerRemainingSec: 0,
    // Personalización visual y táctil (todo se guarda en fs_visual_v1)
    auroraEnabled: true,
    auroraIntensity: 0.55,
    haptics: true,
    audioFade: true,
    lastBackup: localStorage.getItem('fs_last_backup') || null
  };

  // Cargar configuración guardada
  const savedXf = localStorage.getItem('fs_crossfade');
  if (savedXf !== null) S.crossfade = savedXf === 'true';
  const savedXfDur = localStorage.getItem('fs_crossfade_dur');
  if (savedXfDur) S.crossfadeDuration = parseInt(savedXfDur, 10);

  // --- Preferencias visuales y táctiles (personalizables) ---
  const VISUAL_KEY = 'fs_visual_v1';
  try {
    const visual = JSON.parse(localStorage.getItem(VISUAL_KEY) || '{}') || {};
    if (typeof visual.aurora === 'boolean') S.auroraEnabled = visual.aurora;
    if (typeof visual.auroraIntensity === 'number') S.auroraIntensity = Math.max(0.1, Math.min(1, visual.auroraIntensity));
    if (typeof visual.haptics === 'boolean') S.haptics = visual.haptics;
    if (typeof visual.fade === 'boolean') S.audioFade = visual.fade;
  } catch {}

  function saveVisualPrefs() {
    try {
      localStorage.setItem(VISUAL_KEY, JSON.stringify({
        aurora: S.auroraEnabled,
        auroraIntensity: S.auroraIntensity,
        haptics: S.haptics,
        fade: S.audioFade
      }));
    } catch {}
  }

  function applyVisualSettings() {
    document.body.dataset.aurora = S.auroraEnabled ? 'on' : 'off';
    const aurora = $('auroraBg');
    if (aurora) {
      aurora.style.setProperty('--aurora-opacity', String(S.auroraIntensity));
      aurora.style.setProperty('--aurora-speed', S.auroraIntensity > 0.75 ? '16s' : S.auroraIntensity < 0.35 ? '34s' : '24s');
    }
  }

  // Pulso táctil: Android/Chrome lo soporta; en iOS el sistema no expone vibración,
  // así que simplemente no hace nada (la opción queda guardada).
  function haptic(kind = 'light') {
    if (!S.haptics) return;
    try {
      if (!navigator.vibrate) return;
      if (kind === 'success') navigator.vibrate([10, 30, 14]);
      else if (kind === 'medium') navigator.vibrate(16);
      else navigator.vibrate(9);
    } catch {}
  }

  // --- Motor de Audio HTML5 Nativo (Doble Deck para Seamless Playback) ---
  const audioDecks = [
    $('audioA') || new Audio(),
    $('audioB') || new Audio()
  ];
  audioDecks.forEach((a) => {
    a.preload = 'auto';
    a.playsInline = true;
    a.preservesPitch = true;
  });

  let activeDeckIdx = 0;
  let isCrossfading = false;
  let fadeInterval = null;
  window.crossfadeInterval = null;
  window.activeStreamAbort = null;
  let userIntentionalPause = false;
  let isScrubbing = false;
  let streamWatchdogTimer = null;
  let lastSkipTimestamp = 0;
  let consecutiveStreamFailures = 0;
  let consecutiveSkippedTracks = 0;
  const MAX_STREAM_FAILURES = 3; // fallbacks/saltos seguidos antes de detenerse
  const MAX_SKIPPED_TRACKS = 4; // pistas seguidas que se saltan antes de parar

  function getActivePlayer() {
    return audioDecks[activeDeckIdx];
  }

  function getInactivePlayer() {
    return audioDecks[1 - activeDeckIdx];
  }

  // --- Sesión persistente entre aperturas de la app (PWA en iPhone) ---
  const SESSION_KEY = 'fs_session_v2';
  let lastSessionSave = 0;

  function saveSession(force = false, positionOverride = null) {
    if (S.queue.length === 0 && !S.currentTrack) return;
    const now = Date.now();
    if (!force && now - lastSessionSave < 4000) return;
    lastSessionSave = now;

    let position = 0;
    if (positionOverride !== null) {
      position = positionOverride;
    } else if (S.pendingResume && S.currentTrack && S.pendingResume.id === S.currentTrack.id) {
      position = S.pendingResume.seconds;
    } else if (!isYtMode) {
      const p = getActivePlayer();
      if (p && isFinite(p.currentTime) && p.currentTime > 0) position = p.currentTime;
    }

    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        queue: S.queue.map((t) => ({
          id: t.id,
          title: t.title,
          artist: t.artist,
          duration: t.duration || 0,
          durationSeconds: t.durationSeconds || 0,
          durationText: t.durationText || '',
          thumbnail: t.thumbnail || ''
        })),
        currentIndex: S.currentIndex,
        position,
        repeat: S.repeat,
        shuffleMode: S.shuffleMode,
        quality: S.audioQuality,
        normalize: S.audioNormalize,
        playbackRate: S.playbackRate,
        crossfade: S.crossfade,
        crossfadeDuration: S.crossfadeDuration,
        autoplay: S.autoplayInfinite,
        savedAt: now
      }));
    } catch {}
  }

  // Devuelve true si restauró una sesión completa.
  function restoreSession() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch {}
    if (!data || !Array.isArray(data.queue) || data.queue.length === 0) return false;
    // Ignora sesiones de hace más de una semana.
    if (data.savedAt && Date.now() - Number(data.savedAt) > 7 * 24 * 3600 * 1000) return false;

    S.queue = data.queue.filter((t) => t && t.id);
    if (S.queue.length === 0) return false;
    S.currentIndex = Math.min(Math.max(0, Number(data.currentIndex) | 0), S.queue.length - 1);
    S.currentTrack = S.queue[S.currentIndex];

    if (data.repeat === 'off' || data.repeat === 'all' || data.repeat === 'one') S.repeat = data.repeat;
    if (typeof data.shuffleMode === 'number') S.shuffleMode = Math.max(0, Math.min(2, data.shuffleMode | 0));
    if (['140', '139'].includes(String(data.quality))) S.audioQuality = String(data.quality);
    if (typeof data.normalize === 'boolean') S.audioNormalize = data.normalize;
    if (typeof data.playbackRate === 'number' && data.playbackRate > 0.25 && data.playbackRate < 4) S.playbackRate = data.playbackRate;
    if (typeof data.crossfade === 'boolean') S.crossfade = data.crossfade;
    if (typeof data.crossfadeDuration === 'number') S.crossfadeDuration = data.crossfadeDuration;
    if (typeof data.autoplay === 'boolean') S.autoplayInfinite = data.autoplay;

    const seconds = Math.max(0, Number(data.position) || 0);
    S.pendingResume = seconds > 1 ? { id: S.currentTrack.id, seconds } : null;

    updatePlayerUI(S.currentTrack);
    updateMediaSession(S.currentTrack);
    syncRepeatButton();
    syncShuffleButton();

    if (S.pendingResume) {
      if ($('playerCurTime')) $('playerCurTime').textContent = formatTime(seconds);
      const dur = S.currentTrack.duration || S.currentTrack.durationSeconds || 0;
      if (dur > 0) {
        if ($('playerDurTime')) $('playerDurTime').textContent = formatTime(dur);
        if ($('playerSeek')) $('playerSeek').value = Math.min(100, (seconds / dur) * 100);
        if ($('miniProgress')) $('miniProgress').style.width = `${Math.min(100, (seconds / dur) * 100)}%`;
      }
    }
    updatePlayPauseIcons(false, false);
    return true;
  }

  function applyPendingResume(player, track) {
    const pending = S.pendingResume;
    if (!pending) return;
    if (!track || pending.id !== track.id) {
      S.pendingResume = null;
      return;
    }
    const target = pending.seconds;
    S.pendingResume = null;
    const apply = () => {
      try {
        if (isFinite(player.duration) && player.duration > 0 && target < player.duration - 1) {
          player.currentTime = target;
        }
      } catch {}
    };
    if (player.readyState >= 1) apply();
    else player.addEventListener('loadedmetadata', apply, { once: true });
  }

  function cancelActiveCrossfade() {
    if (window.crossfadeInterval) {
      clearInterval(window.crossfadeInterval);
      window.crossfadeInterval = null;
    }
    if (fadeInterval) {
      clearInterval(fadeInterval);
      fadeInterval = null;
    }
    isCrossfading = false;
    const maxVol = S.audioNormalize ? 0.88 : 1.0;
    audioDecks.forEach((deck) => {
      try {
        deck.volume = maxVol;
        deck.muted = false;
      } catch {}
    });
  }

  function formatTime(secs) {
    if (isNaN(secs) || secs < 0) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // Corrección heurística del Bug DASH itag=140 en iOS Safari (duración duplicada 2x)
  function getEffectiveDuration(audioEl, track) {
    const official = (track && (track.duration || track.durationSeconds)) ? (track.duration || track.durationSeconds) : 0;
    const raw = audioEl ? (audioEl.duration || 0) : 0;
    const rawValid = raw && !isNaN(raw) && raw > 0 && isFinite(raw);

    // Si ambas estan disponibles, usar la que sea menor (la oficial puede ser
    // un poco mas corta que el stream real, causando corte prematuro).
    // Pero si difieren mucho (>10s), la oficial suele ser mas confiable.
    if (official > 0 && rawValid) {
      if (Math.abs(raw - official) < 10) return Math.max(official, Math.round(raw));
      return official;
    }
    if (official > 0) return official;
    if (!rawValid) return 0;
    return Math.round(raw);
  }

  function enrichTrackDuration(track, signal) {
    if (!track || (track.duration && track.duration > 0)) return;
    const q = `${track.title} ${track.artist || ''}`.trim();
    fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal })
      .then((r) => r.json())
      .then((data) => {
        if (data.tracks && data.tracks.length > 0) {
          const match = data.tracks[0];
          if (match.duration && match.duration > 0) {
            track.duration = match.duration;
            track.durationSeconds = match.duration;
            track.durationText = match.durationText;

            const p = getActivePlayer();
            const dur = getEffectiveDuration(p, track);
            if (dur > 0) $('playerDurTime').textContent = formatTime(dur);

            // La duración acaba de llegar: vuelve a pedir la letra, ahora sí con
            // el dato que permite a LRCLIB elegir la grabación correcta.
            if (S.currentTrack && S.currentTrack.id === track.id && !S.syncedLyrics.length) {
              loadLyrics(track, null, true);
            }
          }
        }
      })
      .catch(() => {});
  }

  // --- Ambiente Dinámico por Color (Spotify Dynamic Glow) ---
  function applyDynamicColor(track) {
    if (!track) return;
    // Paleta de colores armoniosa generada a partir de los datos de la canción
    const str = `${track.id || ''}${track.title || ''}${track.artist || ''}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hues = [160, 190, 220, 260, 280, 320, 340, 30, 45];
    const chosenHue = hues[Math.abs(hash) % hues.length];

    const h = chosenHue;
    const s = 65;
    const l = 50;

    // Convertir HSL a RGB para los degradados
    const a = (s * Math.min(l, 100 - l)) / 100;
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round((255 * color) / 100);
    };
    const r = f(0);
    const g = f(8);
    const b = f(4);

    // Segundo tono (complementario) para el fondo Aurora: crea el efecto mesh.
    const h2 = (h + 55) % 360;
    const a2 = (s * Math.min(l, 100 - l)) / 100;
    const f2 = (n) => {
      const k = (n + h2 / 30) % 12;
      const color = l - a2 * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round((255 * color) / 100);
    };
    const r2 = f2(0);
    const g2 = f2(8);
    const b2 = f2(4);

    document.documentElement.style.setProperty('--ambient-glow', `rgba(${r}, ${g}, ${b}, 0.32)`);
    document.documentElement.style.setProperty('--ambient-glow-2', `rgba(${r2}, ${g2}, ${b2}, 0.26)`);
    document.documentElement.style.setProperty('--mini-ambient', `rgba(${r}, ${g}, ${b}, 0.22)`);
    document.documentElement.style.setProperty('--tint', `${r} ${g} ${b}`);
  }

  // Detección de pantalla bloqueada o pestaña en segundo plano
  function isBackground() {
    return document.visibilityState === 'hidden';
  }

  // --- Mantenedor de sesión de audio nativo en móviles (iOS Safari / Android) ---
  // Un audio HTML5 real con volumen mínimo mantiene la categoría AVAudioSession activa en WebKit.
  // En Android no hace falta y un segundo elemento de audio puede robar el foco al principal.
  const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const silentLoop = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
  silentLoop.loop = true;
  silentLoop.volume = 0.01;
  silentLoop.setAttribute('playsinline', '');
  // Un audio conectado al DOM mantiene mejor la sesión en iOS que uno suelto.
  if (isIOSDevice) {
    try { document.body.appendChild(silentLoop); } catch {}
  }
  function keepAudioAlive() {
    if (!isIOSDevice) return;
    if (silentLoop.paused) {
      silentLoop.play().catch(() => {});
    }
  }

  // Safari 16.4+: declara la sesión como reproducción para que iOS no pause el audio
  // al cambiar de app, bloquear la pantalla o abrir el centro de control.
  function setupAudioSession() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {}
    audioDecks.forEach((deck) => {
      try {
        deck.setAttribute('x-webkit-airplay', 'allow');
        deck.disableRemotePlayback = false;
      } catch {}
    });
  }

  // Si iOS pausó el audio por pasar a segundo plano (sin que el usuario pausara),
  // retómalo en cuanto vuelve a haber oportunidad.
  function ensurePlaybackAlive() {
    if (!S.isPlaying || userIntentionalPause) return;
    keepAudioAlive();
    if (isYtMode) {
      try {
        if (ytPlayer && typeof ytPlayer.getPlayerState === 'function' && ytPlayer.getPlayerState() !== 1) {
          ytPlayer.playVideo();
        }
      } catch {}
      return;
    }
    const p = getActivePlayer();
    if (p && p.paused) p.play().catch(() => {});
  }

  // Despertar la sesión de audio al primer toque físico en la pantalla
  window.addEventListener('touchstart', () => { setupAudioSession(); keepAudioAlive(); }, { passive: true });
  window.addEventListener('click', () => { setupAudioSession(); keepAudioAlive(); });

  // --- Motor de Audio YouTube Web (Respaldo Infalible sin Errores 502) ---
  let isYtMode = false;
  let ytPlayer = null;
  let isYtReady = false;
  let ytProgressTimer = null;

  function initYouTubeEngine() {
    if (ytPlayer || !window.YT || !window.YT.Player) return;
    try {
      ytPlayer = new YT.Player('ytDeck', {
        height: '2',
        width: '2',
        videoId: '',
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          rel: 0,
          playsinline: 1,
          enablejsapi: 1,
          modestbranding: 1,
          origin: window.location.origin
        },
        events: {
          onReady: () => {
            isYtReady = true;
          },
          onStateChange: onYtStateChange,
          onError: onYtError
        }
      });
    } catch (e) {
      console.warn('Error inicializando YouTube Engine:', e);
    }
  }

  window.onYouTubeIframeAPIReady = () => {
    initYouTubeEngine();
  };
  if (window.YT && window.YT.Player) {
    initYouTubeEngine();
  }

  function onYtStateChange(event) {
    if (!isYtMode) return;
    if (event.data === 1) { // PLAYING
      S.isPlaying = true;
      userIntentionalPause = false;
      consecutiveStreamFailures = 0;
      updatePlayPauseIcons(true, false);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      startYtProgressTimer();
    } else if (event.data === 2) { // PAUSED
      // Si la pausa NO fue iniciada intencionalmente por el usuario (ej: pantalla bloqueada o pestaña en segundo plano en iOS)
      if (!userIntentionalPause && S.isPlaying) {
        keepAudioAlive();
        try {
          if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
            ytPlayer.playVideo();
          }
        } catch {}
        return;
      }
      S.isPlaying = false;
      updatePlayPauseIcons(false, false);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      stopYtProgressTimer();
    } else if (event.data === 3) { // BUFFERING
      updatePlayPauseIcons(true, true);
    } else if (event.data === 0) { // ENDED
      stopYtProgressTimer();
      handleTrackFinished();
    }
  }

  function onYtError(event) {
    console.warn('[FreeSong] Error en reproductor YouTube Web:', event.data);
    stopYtProgressTimer();
    if (!noteStreamFailure()) return;
    playNext(true);
  }

  function startYtProgressTimer() {
    stopYtProgressTimer();
    ytProgressTimer = setInterval(() => {
      if (!isYtMode || !ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
      try {
        const cur = ytPlayer.getCurrentTime() || 0;
        const dur = ytPlayer.getDuration() || (S.currentTrack && S.currentTrack.duration) || 0;
        if (dur > 0) {
          const clampedCur = Math.min(cur, dur);
          $('playerCurTime').textContent = formatTime(clampedCur);
          $('playerDurTime').textContent = formatTime(dur);
          if (!isScrubbing) {
            const pct = Math.min(100, (clampedCur / dur) * 100);
            $('playerSeek').value = pct;
            $('miniProgress').style.width = `${pct}%`;
          }
          if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
            try {
              navigator.mediaSession.setPositionState({
                duration: dur,
                playbackRate: 1,
                position: clampedCur
              });
            } catch {}
          }
        }
        if (S.syncedLyrics && S.syncedLyrics.length > 0 && !isBackground()) {
          syncLyricsWithTime(cur);
        }
      } catch {}
    }, 250);
  }

  function stopYtProgressTimer() {
    if (ytProgressTimer) {
      clearInterval(ytProgressTimer);
      ytProgressTimer = null;
    }
  }

  function playWithYouTubeEngine(track) {
    if (!track) return;
    isYtMode = true;
    S.isPlaying = true;
    userIntentionalPause = false;
    keepAudioAlive();
    updatePlayPauseIcons(true, true);

    // Detener cualquier deck HTML5 para evitar interferencias
    audioDecks.forEach((deck) => {
      try {
        deck.pause();
        deck.removeAttribute('src');
        deck.load();
      } catch {}
    });

    const triggerPlay = () => {
      if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
        try {
          ytPlayer.loadVideoById({ videoId: track.id, suggestedQuality: 'small' });
          ytPlayer.playVideo();
        } catch (err) {
          console.warn('Error al llamar loadVideoById:', err);
          return false;
        }
        return true;
      }
      return false;
    };

    if (isYtReady && ytPlayer) {
      triggerPlay();
    } else {
      initYouTubeEngine();
      const attempt = (final = false) => {
        if (triggerPlay()) return;
        if (final) {
          console.warn('[FreeSong] La API de YouTube no está disponible para el respaldo.');
          stopAfterStreamFailures();
        }
      };
      setTimeout(() => attempt(), 400);
      setTimeout(() => attempt(), 1200);
      setTimeout(() => attempt(true), 3000);
    }
  }

  // --- Manejo de Fallback Automático en Fallas de Audio ---
  function stopAfterStreamFailures() {
    diagInc('stops');
    consecutiveStreamFailures = 0;
    userIntentionalPause = true;
    S.isPlaying = false;
    try {
      audioDecks.forEach((deck) => deck.pause());
    } catch {}
    if (isYtMode && ytPlayer && typeof ytPlayer.stopVideo === 'function') {
      try { ytPlayer.stopVideo(); } catch {}
    }
    isYtMode = false;
    stopYtProgressTimer();
    if (streamWatchdogTimer) {
      clearTimeout(streamWatchdogTimer);
      streamWatchdogTimer = null;
    }
    if (trackTransitionTimeout) {
      clearTimeout(trackTransitionTimeout);
      trackTransitionTimeout = null;
    }
    isTransitioningTrack = false;
    updatePlayPauseIcons(false, false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    showToast('El motor de audio no responde (posible bloqueo de YouTube). Compruébalo en Ajustes → Estado del servicio.', 4400);
  }

  // Devuelve false si ya se superó el máximo de fallos seguidos.
  function noteStreamFailure() {
    consecutiveStreamFailures++;
    return consecutiveStreamFailures <= MAX_STREAM_FAILURES;
  }

  // Una pista imposible no debe detener toda la cola: se salta a la siguiente.
  // Si se encadenan varias pistas rotas, entonces sí se detiene para no entrar
  // en un bucle de saltos.
  function skipFailedTrack(track) {
    diagInc('skips');
    if (S.queue.length <= 1) {
      stopAfterStreamFailures();
      return;
    }
    consecutiveSkippedTracks++;
    if (consecutiveSkippedTracks > MAX_SKIPPED_TRACKS) {
      stopAfterStreamFailures();
      return;
    }
    console.warn(`[FreeSong] Saltando pista no reproducible: ${track && track.title}`);
    showToast(`No se pudo reproducir "${track ? track.title : 'esta pista'}". Pasando a la siguiente...`, 2400);
    setTimeout(() => {
      if (userIntentionalPause) return;
      if (S.queue[S.currentIndex] && S.queue[S.currentIndex].id !== (track && track.id)) return;
      playNext(true);
    }, 600);
  }

  // Vigila el arranque de una pista. Se reprograma solo: si un intento se
  // queda colgado, avanza al siguiente en vez de dejar la cola en silencio.
  function armStreamWatchdog(track, delayMs = 6000, secondPhase = false) {
    if (streamWatchdogTimer) {
      clearTimeout(streamWatchdogTimer);
      streamWatchdogTimer = null;
    }
    streamWatchdogTimer = setTimeout(() => {
      streamWatchdogTimer = null;
      const p = getActivePlayer();
      if (!p || !track) return;
      if (!S.isPlaying || userIntentionalPause || isTransitioningTrack) return;
      if (S.queue[S.currentIndex] !== track) return;
      // Ya arrancó: no hay nada que vigilar.
      if (p.currentTime > 0.35 && p.readyState >= 2) return;
      if (p.readyState >= 2 && !secondPhase) {
        // Llegaron metadatos pero sigue clavado en 0:00; dale un margen corto.
        armStreamWatchdog(track, 4500, true);
        return;
      }
      console.warn('Watchdog: el audio no arrancó, ejecutando fallback...');
      try { p.volume = S.audioNormalize ? 0.88 : 1.0; } catch {}
      handleStreamFailure(track, p);
    }, delayMs);
  }

  // Reintenta con una URL nueva sin esperar resoluciones lentas: el proxy de
  // Vercel con `backup` responde en 1-2 s, mientras que reintentar el relay
  // directo podía bloquear la cola hasta 6 s más.
  async function handleStreamFailure(track, deck) {
    if (!track) {
      updatePlayPauseIcons(false, false);
      return;
    }
    if (S.queue[S.currentIndex] !== track) return;
    // Varios eventos 'error' pueden dispararse seguidos por el mismo corte.
    if (track._recovering) return;
    track._recovering = true;

    try {
      const player = deck && deck === getActivePlayer() ? deck : getActivePlayer();
      if (!player) return;

      // Guarda la posición: un fallo a mitad de canción debe continuar donde iba.
      let resumeAt = 0;
      try {
        if (isFinite(player.currentTime) && player.currentTime > 1) resumeAt = player.currentTime;
      } catch {}
      const knownDuration = getEffectiveDuration(player, track);
      // Si el error llega cuando estamos cerca del final (< 3s), tratar como
      // fin natural de la canción en vez de reiniciar desde 0.
      if (resumeAt > 0 && knownDuration > 0 && resumeAt > knownDuration - 3) {
        handleTrackFinished();
        return;
      }

      const step = Number(track._fallbackStep) || 0;
      if (step === 0) diagInc('recoveries');
      if (step >= 3) {
        noteStreamFailure();
        skipFailedTrack(track);
        return;
      }

      track._fallbackStep = step + 1;
      delete track.streamUrl;
      delete track._relayExpires;
      delete track._relaySize;

      // Si la URL directa falló, no vuelvas a pedir la misma: pasa ya al proxy
      // con una resolución nueva. El relay se refresca en segundo plano para
      // la próxima reproducción.
      if (step === 0) {
        resolveRelaySource(track.id, S.audioQuality, true).catch(() => {});
      }
      const nextUrl = buildStreamUrl(track, track._fallbackStep);

      if (S.queue[S.currentIndex] !== track || userIntentionalPause) return;

      try {
        const seek = () => {
          try {
            if (resumeAt > 0 && (!isFinite(player.duration) || resumeAt < player.duration - 1)) {
              player.currentTime = resumeAt;
            }
          } catch {}
        };
        if (resumeAt > 0) player.addEventListener('canplay', seek, { once: true });
        player.src = nextUrl;
        player.load();
        if (resumeAt > 0) seek();
        const pr = player.play();
        if (pr && pr.catch) pr.catch(() => {});
        armStreamWatchdog(track, 7000);
        return;
      } catch {}
    } finally {
      track._recovering = false;
    }
  }

  // --- Salvaguarda de Cambio de Visibilidad (Segundo Plano en iOS) ---
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveSession(true);
      if (isCrossfading) {
        cancelActiveCrossfade();
        const activeP = getActivePlayer();
        if (activeP) activeP.volume = S.audioNormalize ? 0.88 : 1;
      }
      ensurePlaybackAlive();
    } else {
      ensurePlaybackAlive();
    }
  });

  // Al volver de otra app, del bloqueo o de la caché de navegación (bfcache).
  window.addEventListener('pageshow', () => ensurePlaybackAlive());
  window.addEventListener('focus', () => ensurePlaybackAlive());
  // Guarda la sesión al salir; NO pausa el audio (iOS lo mantiene en segundo plano).
  window.addEventListener('pagehide', () => saveSession(true));
  window.addEventListener('beforeunload', () => saveSession(true));

  // --- Eventos del Reproductor HTML5 ---
  let isTransitioningTrack = false;
  let trackTransitionTimeout = null;
  let pendingStartMark = 0;
  let pendingStartId = '';

  audioDecks.forEach((deck, idx) => {
    deck.addEventListener('loadstart', () => {
      if (idx === activeDeckIdx && S.isPlaying) {
        updatePlayPauseIcons(true, true);
      }
    });

    deck.addEventListener('waiting', () => {
      if (idx === activeDeckIdx && S.isPlaying) {
        updatePlayPauseIcons(true, true);
      }
    });

    deck.addEventListener('play', () => {
      if (idx === activeDeckIdx) {
        S.isPlaying = true;
        userIntentionalPause = false;
        updatePlayPauseIcons(true, false);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      }
    });

    deck.addEventListener('playing', () => {
      isTransitioningTrack = false;
      if (trackTransitionTimeout) {
        clearTimeout(trackTransitionTimeout);
        trackTransitionTimeout = null;
      }
      if (streamWatchdogTimer) {
        clearTimeout(streamWatchdogTimer);
        streamWatchdogTimer = null;
      }
      if (idx === activeDeckIdx && S.queue[S.currentIndex]) {
        // Un arranque desde 0 sí es una reproducción limpia; una reanudación a
        // mitad de canción conserva el nivel de fallback para no reintentar sin fin.
        if (!deck.currentTime || deck.currentTime < 2) {
          S.queue[S.currentIndex]._fallbackStep = 0;
          if (pendingStartId && pendingStartId === S.queue[S.currentIndex].id) {
            diagRecordStart(Date.now() - pendingStartMark);
            diagInc(isDirectRelayUrl(deck.currentSrc || deck.src) ? 'relay' : 'proxy');
            pendingStartId = '';
          }
        }
      }
      if (idx === activeDeckIdx) consecutiveStreamFailures = 0;
      if (idx === activeDeckIdx) consecutiveSkippedTracks = 0;
      S.isPlaying = true;
      updatePlayPauseIcons(true, false);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';

      // Con la canción ya sonando, deja resuelta la siguiente (relay directo)
      // sin competir con el arranque de la actual.
      if (idx === activeDeckIdx && !isYtMode) {
        setTimeout(() => {
          if (S.isPlaying && !isYtMode && S.queue[S.currentIndex]) prefetchNextTrack();
        }, 1500);
      }    });

    deck.addEventListener('pause', () => {
      // Ignorar el evento 'pause' interno que el navegador emite automáticamente al cambiar deck.src
      if (isTransitioningTrack) return;

      if (idx === activeDeckIdx && !isCrossfading) {
        if (document.visibilityState === 'hidden' && S.isPlaying && !userIntentionalPause) {
          setTimeout(() => {
            if (S.isPlaying && !userIntentionalPause && deck.paused && !isTransitioningTrack) {
              deck.play().catch(() => {});
            }
          }, 30);
          return;
        }
        S.isPlaying = false;
        updatePlayPauseIcons(false, false);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      }
    });

    deck.addEventListener('ended', () => {
      if (idx === activeDeckIdx && !isCrossfading && !isTransitioningTrack) {
        handleTrackFinished();
      }
    });

    deck.addEventListener('timeupdate', () => {
      if (idx !== activeDeckIdx || isTransitioningTrack) return;
      const cur = deck.currentTime || 0;

      // Si ya avanzó más de 0.5s, desactivar watchdog
      if (cur > 0.5 && streamWatchdogTimer) {
        clearTimeout(streamWatchdogTimer);
        streamWatchdogTimer = null;
      }

      const track = S.queue[S.currentIndex];
      const dur = getEffectiveDuration(deck, track);

      if (dur > 0) {
        const clampedCur = Math.min(cur, dur);
        $('playerCurTime').textContent = formatTime(clampedCur);
        $('playerDurTime').textContent = formatTime(dur);
        const pct = Math.min(100, (clampedCur / dur) * 100);
        if (!isScrubbing) {
          $('playerSeek').value = pct;
        }
        $('miniProgress').style.width = `${pct}%`;

        // MediaSession position para Dynamic Island y pantalla de bloqueo de iPhone
        if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
          try {
            navigator.mediaSession.setPositionState({
              duration: dur,
              playbackRate: deck.playbackRate || 1,
              position: clampedCur
            });
          } catch {}
        }

        // Precarga inteligente al 70%
        if (pct >= 70 && !deck.dataset.prefetched) {
          deck.dataset.prefetched = 'true';
          prefetchNextTrack();
        }

        // El fin natural de pista se gestiona por el evento 'ended' nativo del reproductor.
        // Crossfade adaptativo
        const timeLeft = dur - cur;
        if (
          S.crossfade &&
          !isIOS &&
          !isBackground() &&
          !isCrossfading &&
          !isTransitioningTrack &&
          timeLeft <= S.crossfadeDuration &&
          timeLeft > 0.8 &&
          S.queue.length > 1
        ) {
          playNext(false);
        }
      }

      if (S.syncedLyrics.length > 0 && !isBackground()) {
        syncLyricsWithTime(cur);
      }

      // Guarda la posición cada ~4 s para retomar la sesión al reabrir la app.
      saveSession();
    });

    // Errores o bloqueos en la conexión
    deck.addEventListener('error', (e) => {
      if (idx === activeDeckIdx && S.currentIndex >= 0 && S.isPlaying && !userIntentionalPause && !isTransitioningTrack) {
        console.warn('Error en deck de audio:', e);
        const maxVol = S.audioNormalize ? 0.88 : 1.0;
        deck.volume = maxVol;
        handleStreamFailure(S.queue[S.currentIndex], deck);
      }
    });

    deck.addEventListener('stalled', () => {
      // Buffering de audio
    });
  });

  function handleTrackFinished() {
    if (isTransitioningTrack) return;
    isTransitioningTrack = true;

    if (trackTransitionTimeout) clearTimeout(trackTransitionTimeout);
    trackTransitionTimeout = setTimeout(() => {
      isTransitioningTrack = false;
    }, 8000);

    if (S.sleepTimerEndTrack) {
      clearSleepTimer();
      pausePlayback();
      isTransitioningTrack = false;
      return;
    }

    // Repetir una pista: reiniciar aquí (no en playNext, que también usa el botón "siguiente")
    if (S.repeat === 'one') {
      if (isYtMode && ytPlayer && typeof ytPlayer.seekTo === 'function') {
        try {
          ytPlayer.seekTo(0, true);
          ytPlayer.playVideo();
        } catch {}
      } else {
        const p = getActivePlayer();
        if (p) {
          try {
            p.currentTime = 0;
            p.play().catch(() => {});
          } catch {}
        }
      }
      isTransitioningTrack = false;
      if (trackTransitionTimeout) {
        clearTimeout(trackTransitionTimeout);
        trackTransitionTimeout = null;
      }
      return;
    }

    // Lógica de Smart Shuffle: inyectar recomendación cada 2 pistas
    if (S.shuffleMode === 2) {
      S.smartShuffleInjectCount++;
      if (S.smartShuffleInjectCount >= 2) {
        S.smartShuffleInjectCount = 0;
        injectSmartRecommendation();
      }
    }

    playNext(true);
  }

  // --- Inyección Automática de Smart Shuffle ✨ ---
  async function injectSmartRecommendation() {
    const cur = S.queue[S.currentIndex];
    if (!cur) return;
    try {
      const q = cur.artist && cur.artist !== 'Artista' ? `${cur.artist} exitos` : `${cur.title} mix`;
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data.tracks && data.tracks.length > 0) {
        const existingIds = new Set(S.queue.map((t) => t.id));
        const candidate = data.tracks.find((t) => !existingIds.has(t.id));
        if (candidate) {
          const insertIdx = Math.min(S.currentIndex + 2, S.queue.length);
          S.queue.splice(insertIdx, 0, candidate);
          renderQueue();
          showToast(`✨ Smart Shuffle: se sumó "${candidate.title}"`);
        }
      }
    } catch {}
  }

  // --- Controles de Pantalla de Bloqueo y Dynamic Island (MediaSession) ---
  function updateMediaSession(track) {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist || 'FreeSong',
        album: 'FreeSong Premium',
        artwork: [
          { src: thumbAt(track.thumbnail, 512), sizes: '512x512', type: 'image/jpeg' },
          { src: thumbAt(track.thumbnail, 256), sizes: '256x256', type: 'image/jpeg' },
          { src: thumbAt(track.thumbnail, 128), sizes: '128x128', type: 'image/jpeg' }
        ]
      });

      navigator.mediaSession.setActionHandler('play', () => resumePlayback());
      navigator.mediaSession.setActionHandler('pause', () => pausePlayback());
      navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext(true));
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) {
          const p = getActivePlayer();
          if (p) p.currentTime = details.seekTime;
        }
      });
    } catch {}
  }

  // --- Siguiente Canción y Precarga ---
  // manualSkip=true lo usa el botón "siguiente": con repetir-una el avance manual
  // debe pasar a la siguiente pista, mientras que el fin de pista la repite.
  function getNextIndex(manualSkip = false) {
    if (S.queue.length === 0) return -1;
    // Con repetir-una la reproducción automática la gestiona handleTrackFinished;
    // aquí solo apuntamos a la misma pista para la precarga.
    if (!manualSkip && S.repeat === 'one') return S.currentIndex;
    let next = S.currentIndex + 1;
    if (S.shuffleMode > 0) {
      next = Math.floor(Math.random() * S.queue.length);
      if (next === S.currentIndex && S.queue.length > 1) {
        next = (next + 1) % S.queue.length;
      }
      return next;
    }
    if (next >= S.queue.length) {
      // Repetición desactivada: no dar la vuelta a la cola.
      if (S.repeat === 'off') return -1;
      next = 0;
    }
    return next;
  }

  // URL del proxy. `attempt` fuerza una resolución nueva en el servidor (backup=1)
  // y `r` evita que Safari reutilice la respuesta fallida de la caché.
  function buildStreamUrl(track, attempt = 0) {
    const params = new URLSearchParams({
      id: track.id,
      itag: S.audioQuality,
      title: track.title || '',
      artist: track.artist || ''
    });
    const durSec = Math.round(Number(track.durationSeconds || track.duration || 0));
    if (durSec > 0) params.set('dur', String(durSec));
    if (attempt > 0) {
      params.set('backup', String(Math.min(attempt, 4)));
      params.set('r', String(Date.now()));
    }
    return `/api/stream?${params.toString()}`;
  }

  // --- Relay directo desde el teléfono (arranque rápido) ---
  // Pasar por /api/stream añade ~1-4 s por canción (resolución + función de Vercel).
  // La instancia Invidious permite CORS en su API y en el audio, así que el propio
  // navegador puede resolver y reproducir la URL directa. El proxy queda de respaldo.
  const RELAY_DEFAULT_BASES = ['https://yt.chocolatemoo53.com'];
  const RELAY_URL_TTL_MS = 20 * 60 * 1000;
  const RELAY_PICK_CACHE_MAX = 150;
  const RELAY_AUDIO_ITAGS = ['139', '140', '141', '249', '250', '251'];

  let relayBases = RELAY_DEFAULT_BASES.slice();
  let relayBasesRefreshStarted = false;
  const relaySources = new Map(); // `${videoId}:${itag}` -> { url, size, expires }
  const relayPending = new Map();
  const relaySourceFailures = new Map(); // evita repetir el 500 de un vídeo que no existe
  const RELAY_FAIL_TTL_MS = 90 * 1000;
  let relayUpgradeToken = 0;

  // Caché en disco de URLs ya resueltas: al reabrir la app la primera canción
  // arranca al instante en vez de esperar ~3 s a la resolución en frío.
  const RELAY_DISK_CACHE_KEY = 'fs_relay_urls_v1';
  const RELAY_DISK_CACHE_MAX = 40;

  function loadRelayDiskCache() {
    try {
      const raw = localStorage.getItem(RELAY_DISK_CACHE_KEY);
      if (!raw) return;
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return;
      const now = Date.now();
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const key = entry[0];
        const src = entry[1];
        if (typeof key !== 'string' || !src || !src.url || !(src.expires > now + 60 * 1000)) continue;
        if (relaySources.size >= RELAY_DISK_CACHE_MAX) break;
        relaySources.set(key, src);
      }
    } catch {}
  }

  let relayDiskSaveTimer = 0;
  function saveRelayDiskCacheSoon() {
    if (relayDiskSaveTimer) return;
    relayDiskSaveTimer = setTimeout(() => {
      relayDiskSaveTimer = 0;
      try {
        const now = Date.now();
        const entries = [];
        for (const [key, src] of relaySources) {
          if (!src || !(src.expires > now + 60 * 1000)) continue;
          entries.push([key, src]);
          if (entries.length >= RELAY_DISK_CACHE_MAX) break;
        }
        localStorage.setItem(RELAY_DISK_CACHE_KEY, JSON.stringify(entries));
      } catch {}
    }, 400);
  }

  loadRelayDiskCache();

  // Devuelve la lista conocida al instante (el primer arranque no debe esperar a
  // una función de Vercel). La lista del servidor se refresca en segundo plano.
  function loadRelayBases() {
    if (!relayBasesRefreshStarted) {
      relayBasesRefreshStarted = true;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        fetch('/api/relay-info', { cache: 'no-store', signal: ctrl.signal })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            const list = Array.isArray(data && data.instances)
              ? data.instances.filter((b) => /^https?:\/\//.test(String(b)))
              : [];
            if (list.length) relayBases = list;
          })
          .catch(() => {})
          .finally(() => clearTimeout(timer));
      } catch {}
    }
    return relayBases;
  }

  function relayAudioFormats(data) {
    const list = data && Array.isArray(data.adaptiveFormats) ? data.adaptiveFormats : [];
    return list.filter((f) => {
      if (!f || !f.url) return false;
      const mime = String(f.mimeType || f.type || '');
      if (/^audio\//.test(mime)) return true;
      if (RELAY_AUDIO_ITAGS.includes(String(f.itag))) return true;
      try { return /audio/i.test(new URL(f.url).searchParams.get('mime') || ''); } catch { return false; }
    });
  }

  function relaySizeOf(f) {
    const declared = Number(f && (f.clen || f.contentLength || f.size));
    if (declared > 0) return declared;
    try { return Number(new URL(f.url).searchParams.get('clen')) || 0; } catch { return 0; }
  }

  // Devuelve { url, itag, size, relay, expires } o null. Deduplica peticiones
  // simultáneas (Safari pide varios rangos de golpe) y cachea ~20 minutos.
  async function resolveRelaySource(videoId, wantedItag, force = false) {
    if (!videoId) return null;
    const cacheKey = `${videoId}:${wantedItag || ''}`;
    if (force) {
      // Un intento fallido no debe devolver siempre el mismo enlace roto.
      relaySources.delete(cacheKey);
      relaySourceFailures.delete(cacheKey);
    } else {
      const cached = relaySources.get(cacheKey);
      if (cached && cached.expires > Date.now()) return cached;
      const failedUntil = relaySourceFailures.get(cacheKey);
      if (failedUntil && failedUntil > Date.now()) return null;
      if (relayPending.has(cacheKey)) return relayPending.get(cacheKey);
    }

    const task = (async () => {
      const bases = loadRelayBases();
      for (const base of bases) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 6000);
          let res;
          try {
            res = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}?local=true`, {
              headers: { Accept: 'application/json' },
              cache: 'no-store',
              signal: ctrl.signal
            });
          } finally {
            clearTimeout(timer);
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!data || data.error) throw new Error(String((data && data.error) || 'respuesta vacía'));

          const formats = relayAudioFormats(data);
          if (!formats.length) throw new Error('sin formatos de audio');
          const byItag = (n) => formats.find((f) => String(f.itag) === String(n));
          const fmt = (wantedItag ? byItag(wantedItag) : null)
            || byItag(140)
            || byItag(139)
            || formats.find((f) => /^audio\/mp4/.test(String(f.mimeType || f.type || '')))
            || formats[0];
          if (!fmt || !fmt.url) throw new Error('formato sin URL');

          const host = new URL(fmt.url).host;
          if (/googlevideo\.com$/i.test(host)) throw new Error('la instancia no proxea el audio');

          const source = {
            url: fmt.url,
            itag: String(fmt.itag),
            size: relaySizeOf(fmt),
            relay: base,
            expires: Date.now() + RELAY_URL_TTL_MS
          };
          relaySources.set(cacheKey, source);
          if (relaySources.size > RELAY_PICK_CACHE_MAX) {
            relaySources.delete(relaySources.keys().next().value);
          }
          relaySourceFailures.delete(cacheKey);
          saveRelayDiskCacheSoon();
          return source;
        } catch (err) {
          console.warn(`[FreeSong] Relay ${base} falló para ${videoId}:`, err.message);
        }
      }
      relaySourceFailures.set(cacheKey, Date.now() + RELAY_FAIL_TTL_MS);
      if (relaySourceFailures.size > 200) {
        relaySourceFailures.delete(relaySourceFailures.keys().next().value);
      }
      return null;
    })().finally(() => relayPending.delete(cacheKey));

    relayPending.set(cacheKey, task);
    return task;
  }

  // --- Resolución de una copia alternativa de la misma canción ---
  // La instancia Invidious puede no tener el vídeo original (HTTP 500), pero su
  // buscador sí encuentra otra publicación de la misma canción. Se resuelve
  // durante la precarga para que el toque del usuario ya encuentre una URL.
  const RELAY_TITLE_VARIANTS_RE = /\b(remix|cover|live|en vivo|sped up|slowed|reverb|instrumental|karaoke|tribute|parody|letra|lyrics|lyric)\b/i;
  const RELAY_TITLE_NOISE_RE = /\b(official|videoclip|video|audio|visualizer|lyric|lyrics|letra|hd|hq|4k|8k|remaster(?:ed)?|version)\b/gi;

  function relayNormalizeText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}']+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function relayCoreTitle(value) {
    const withoutBrackets = String(value || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
    return relayNormalizeText(withoutBrackets.replace(RELAY_TITLE_NOISE_RE, ' '));
  }

  function isSameSongRelayCandidate(candidateTitle, candidateArtist, title, artist, candidateDuration, duration) {
    const candidateCore = relayCoreTitle(candidateTitle);
    const originalCore = relayCoreTitle(title);
    const artistCore = relayCoreTitle(artist);
    if (!candidateCore || !originalCore) return false;

    const cores = new Set([originalCore]);
    if (artistCore) {
      cores.add(`${artistCore} ${originalCore}`);
      cores.add(`${originalCore} ${artistCore}`);
    }
    if (!cores.has(candidateCore)) return false;

    if (RELAY_TITLE_VARIANTS_RE.test(candidateTitle) && !RELAY_TITLE_VARIANTS_RE.test(title)) return false;

    if (duration > 0 && candidateDuration > 0 && Math.abs(candidateDuration - duration) > 10) return false;

    const candidateArtistNorm = relayNormalizeText(candidateArtist);
    const originalArtistNorm = relayNormalizeText(artist);
    if (!originalArtistNorm) return true;

    const titleHasArtist = new RegExp(`(^|\\s)${originalArtistNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(candidateCore);
    if (!candidateArtistNorm) return titleHasArtist;
    return candidateArtistNorm === originalArtistNorm
      || candidateArtistNorm.includes(originalArtistNorm)
      || originalArtistNorm.includes(candidateArtistNorm)
      || titleHasArtist;
  }

  const relayAltPending = new Map();
  function resolveRelayAlternative(track) {
    if (!track || !track.id || !track.title) return Promise.resolve(null);
    const cacheKey = `${track.id}:${S.audioQuality || ''}`;
    const existing = relaySources.get(cacheKey);
    if (existing && existing.expires > Date.now()) return Promise.resolve(existing);
    if (relayAltPending.has(cacheKey)) return relayAltPending.get(cacheKey);

    const task = (async () => {
      const query = `${track.title} ${track.artist || ''}`.trim();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4500);
      let list = [];
      try {
        for (const base of loadRelayBases()) {
          try {
            const res = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video`, {
              headers: { Accept: 'application/json' },
              cache: 'no-store',
              signal: ctrl.signal
            });
            if (!res.ok) continue;
            const data = await res.json();
            if (Array.isArray(data) && data.length) {
              list = data;
              break;
            }
          } catch {}
        }
      } finally {
        clearTimeout(timer);
      }

      const duration = Number(track.durationSeconds || track.duration || 0);
      const candidates = list
        .filter((item) => item && item.videoId && item.videoId !== track.id)
        .map((item) => ({
          id: item.videoId,
          title: String(item.title || ''),
          artist: String(item.author || ''),
          seconds: Number(item.lengthSeconds) || 0
        }))
        .filter((item) => isSameSongRelayCandidate(item.title, item.artist, track.title, track.artist, item.seconds, duration))
        .sort((a, b) => {
          const da = duration > 0 ? Math.abs(a.seconds - duration) : 0;
          const db = duration > 0 ? Math.abs(b.seconds - duration) : 0;
          return da - db;
        })
        .slice(0, 3);

      for (const candidate of candidates) {
        const source = await resolveRelaySource(candidate.id, S.audioQuality);
        if (!source) continue;
        // Guárdala también bajo el id original: los siguientes cambios de pista
        // la encontrarán sin repetir la búsqueda.
        relaySources.set(cacheKey, source);
        saveRelayDiskCacheSoon();
        diagInc('alt');
        return source;
      }
      return null;
    })().finally(() => relayAltPending.delete(cacheKey));

    relayAltPending.set(cacheKey, task);
    return task;
  }

  function isDirectRelayUrl(url) {
    if (!url) return false;
    // Ojo: las URLs del relay llevan `host=...googlevideo.com` en la query,
    // así que hay que mirar solo el host real. Las del proxy `/api/stream`
    // son locales al despliegue y no cuentan como relay directo.
    try {
      const u = new URL(url, window.location.href);
      if (u.pathname === '/api/stream') return false;
      return !/googlevideo\.com$/i.test(u.host);
    } catch {
      return false;
    }
  }

  function rememberRelaySource(track, source) {
    if (!track || !source || !source.url) return;
    track.streamUrl = source.url;
    track._relayExpires = source.expires;
    track._relaySize = source.size || 0;
  }

  // URL lista para el <audio>: copia offline > relay directo vigente > proxy.
  function getTrackStreamUrl(track) {
    const offlineUrl = S.offlineBlobUrls instanceof Map ? S.offlineBlobUrls.get(track.id) : null;
    if (offlineUrl) return offlineUrl;
    if (track.streamUrl) {
      if (!isDirectRelayUrl(track.streamUrl) || !(track._relayExpires > 0) || track._relayExpires > Date.now()) {
        return track.streamUrl;
      }
      delete track.streamUrl;
      delete track._relayExpires;
      delete track._relaySize;
    }
    // Aunque este objeto pista venga de otra pantalla, aprovecha una URL ya
    // resuelta (precarga o caché en disco) antes de recurrir al proxy lento.
    const cached = relaySources.get(`${track.id}:${S.audioQuality || ''}`);
    if (cached && cached.expires > Date.now()) {
      rememberRelaySource(track, cached);
      return cached.url;
    }
    return buildStreamUrl(track);
  }

  // Si el proxy aún no logró sonar, cambia al relay directo en cuanto esté listo.
  // Nunca corta una canción que ya empezó: solo actúa con currentTime ~0.
  function upgradePlaybackToRelay(track, player) {
    if (!track || !player || isYtMode || !S.isPlaying || userIntentionalPause) return;
    if (isDirectRelayUrl(player.src)) return;
    const token = ++relayUpgradeToken;

    resolveRelaySource(track.id, S.audioQuality).then((source) => {
      if (!source || token !== relayUpgradeToken) return;
      if (S.queue[S.currentIndex] !== track || isYtMode || !S.isPlaying || userIntentionalPause) return;
      if (player !== getActivePlayer()) return;

      // Ya está sonando o tiene datos suficientes: no interrumpir.
      if (player.currentTime > 0.3 || player.readyState >= 3) {
        rememberRelaySource(track, source);
        return;
      }

      rememberRelaySource(track, source);
      try {
        player.src = source.url;
        player.load();
        const pr = player.play();
        if (pr && pr.catch) pr.catch(() => {});
      } catch {}
    }).catch(() => {});
  }

  // Si el relay directo no funciona, calienta el proxy de Vercel en segundo
  // plano. Así el primer toque en una canción problemática no espera la
  // resolución completa y empieza casi al instante.
  const proxyPrewarmStarted = new Set();
  function prewarmProxyStream(track) {
    if (!track || !track.id || proxyPrewarmStarted.has(track.id) || isDownloaded(track.id)) return;
    if (navigator.onLine === false) return;
    const conn = navigator.connection;
    if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return;
    proxyPrewarmStarted.add(track.id);

    const params = new URLSearchParams({
      id: track.id,
      itag: S.audioQuality,
      title: track.title || '',
      artist: track.artist || ''
    });
    const durSec = Math.round(Number(track.durationSeconds || track.duration || 0));
    if (durSec > 0) params.set('dur', String(durSec));
    params.set('prewarm', '1');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    fetch(`/api/stream?${params.toString()}`, {
      method: 'HEAD',
      cache: 'no-store',
      signal: ctrl.signal
    }).then((res) => {
      // Si el precalentamiento falló, permite reintentarlo más tarde.
      if (!res || !res.ok) proxyPrewarmStarted.delete(track.id);
    }).catch(() => {
      proxyPrewarmStarted.delete(track.id);
    }).finally(() => clearTimeout(timer));
  }

  // Deja el primer resultado ya cargado en el deck inactivo para que el primer
  // toque arranque casi al instante (antes había que abrir la conexión y
  // descargar el primer fragmento en ese momento).
  function primeTrackForInstantStart(track, source) {
    if (!track || !source || !source.url) return;
    // También con una sesión anterior en pausa: el deck activo no se toca y al
    // elegir una canción nueva se reutiliza este deck ya cargado.
    if (S.isPlaying || isBackground() || isDownloaded(track.id)) return;
    const inact = getInactivePlayer();
    if (!inact || !inact.paused || inact.dataset.prefetchedId === track.id) return;
    try {
      inact.dataset.prefetchedId = track.id;
      inact.muted = true;
      inact.preload = 'auto';
      inact.src = source.url;
      inact.load();
    } catch {}
  }

  function prewarmTracks(tracks) {
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) return;
    // Pre-resuelve discretamente las primeras canciones vía Invidious directamente desde el navegador (sin saturar Vercel).
    // 6 pistas: la primera resolución en frío tarda ~3 s y así el toque suele encontrar la URL ya lista.
    const candidates = tracks.slice(0, 6).filter((t) => t && t.id && !t.streamUrl && !isDownloaded(t.id));
    const primeId = candidates[0] && candidates[0].id;

    // Calienta el proxy en paralelo desde el primer instante para las dos
    // primeras pistas. El HEAD solo pide 2 bytes, así que es barato, y deja la
    // URL de audio resuelta antes de que el usuario toque la canción.
    for (const t of candidates.slice(0, 2)) prewarmProxyStream(t);

    for (const t of candidates) {
      resolveRelaySource(t.id, S.audioQuality).then((src) => {
        if (src) {
          rememberRelaySource(t, src);
          if (t.id === primeId) primeTrackForInstantStart(t, src);
          return null;
        }
        // La instancia no tiene el vídeo original: busca otra publicación de la
        // misma canción mientras el usuario aún está eligiendo.
        return resolveRelayAlternative(t).then((alt) => {
          if (alt) {
            rememberRelaySource(t, alt);
            if (t.id === primeId) primeTrackForInstantStart(t, alt);
          }
        });
      }).catch(() => {});
    }
  }

  function prefetchNextTrack() {
    const nextIdx = getNextIndex();
    if (nextIdx < 0 || nextIdx >= S.queue.length || nextIdx === S.currentIndex) return;
    const nextTrack = S.queue[nextIdx];
    if (!nextTrack) return;

    // La letra de la siguiente pista se pide ya: al cambiar de canción aparece
    // al instante en vez de mostrar el esqueleto de carga.
    prefetchLyrics(nextTrack);

    // Si ya está descargada, se reproducirá desde el blob offline: no gastes red.
    if (isDownloaded(nextTrack.id)) return;

    prewarmTracks([nextTrack]);

    // Resuelve la URL directa con antelación: al cambiar de canción ya estará
    // lista y empezará en ~0,3 s en vez de esperar al proxy de Vercel.
    const applyPrefetch = (source) => {
      if (!source) return;
      // La cola pudo cambiar mientras resolvía: no precargues una pista que ya
      // no es la siguiente.
      const stillNext = getNextIndex();
      if (S.queue[stillNext] !== nextTrack) return;
      rememberRelaySource(nextTrack, source);

      // En iPhone también se deja listo el otro deck: al cambiar de canción se
      // reutiliza su buffer en vez de volver a descargar desde cero.
      if (!isBackground() && !isDownloaded(nextTrack.id)) {
        const inact = getInactivePlayer();
        // La marca guarda QUÉ pista está precargada: un booleano impedía
        // precargar la siguiente canción después del primer cambio de pista.
        if (inact && inact.paused && inact.dataset.prefetchedId !== nextTrack.id) {
          try {
            inact.dataset.prefetchedId = nextTrack.id;
            inact.muted = true;
            inact.preload = 'auto';
            inact.src = source.url;
            inact.load();
          } catch {}
        }
      }
    };

    resolveRelaySource(nextTrack.id, S.audioQuality).then((source) => {
      if (source) {
        applyPrefetch(source);
        return null;
      }
      return resolveRelayAlternative(nextTrack).then(applyPrefetch);
    }).catch(() => {});

    // Respaldo inmediato por el proxy mientras se resuelve el relay.
    if (!nextTrack.streamUrl) nextTrack.streamUrl = buildStreamUrl(nextTrack);
  }

  // --- Autoplay Continuo: Recomendaciones Infinitas (SimpMusic Engine via /api/queue) ---
  let isFetchingRelated = false;
  async function ensureUpcomingTracks(track, signal) {
    if (!S.autoplayInfinite || !track || isFetchingRelated) return;
    const remaining = S.queue.length - 1 - S.currentIndex;
    if (remaining < 4) {
      isFetchingRelated = true;
      try {
        const res = await fetch(`/api/queue?id=${encodeURIComponent(track.id)}`, { signal });
        const data = await res.json();
        if (data.tracks && data.tracks.length > 0) {
          const existingIds = new Set(S.queue.map((t) => t.id));
          const newTracks = data.tracks.filter((t) => !existingIds.has(t.id));
          if (newTracks.length > 0) {
            S.queue.push(...newTracks);
            renderQueue();
            showToast('🎵 Cola infinita: pistas similares añadidas', 1800);
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error('Error al cargar recomendaciones continuas:', err);
        }
      } finally {
        isFetchingRelated = false;
      }
    }
  }

  // --- Motor de Descargas Offline Reales (Cache API + Modo Avión en iPhone) ---
  function isDownloaded(trackId) {
    if (!trackId) return false;
    return S.downloads.some((d) => d.id === trackId);
  }

  async function initOfflineBlobs() {
    if (!('caches' in window) || !S.downloads || S.downloads.length === 0) return;
    try {
      const cache = await caches.open('freesong-offline-audio-v1');
      for (const item of S.downloads) {
        if (!item || !item.id || S.offlineBlobUrls.has(item.id)) continue;
        const match = await cache.match('/offline-audio/' + item.id);
        if (match) {
          const blob = await match.blob();
          if (blob && blob.size > 1000) {
            S.offlineBlobUrls.set(item.id, URL.createObjectURL(blob));
          }
        }
      }
    } catch (e) {
      console.warn('initOfflineBlobs error:', e);
    }
  }

  // Descarga por fragmentos de 512 KB. Evita el límite de tamaño de respuesta de
  // Vercel (una canción larga supera los 4.5 MB de `full=1`) y permite reintentar
  // solo el fragmento que falló. Devuelve el blob completo ya verificado.
  async function fetchAudioChunk(track, start, end) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const qs = new URLSearchParams({
          id: track.id,
          itag: S.audioQuality,
          title: track.title || '',
          artist: track.artist || ''
        });
        // Cada reintento pide una resolución nueva al proxy para evitar URLs caducadas.
        if (attempt > 0) {
          qs.set('backup', '1');
          qs.set('r', String(Date.now()));
        }
        const res = await fetch(`/api/stream?${qs.toString()}`, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: controller.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const buffer = await res.arrayBuffer();
        const contentRange = res.headers.get('content-range') || '';
        const rangeMatch = contentRange.match(/bytes\s+\d+-\d+\/(\d+)/i);
        const totalBytes = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;
        const expected = totalBytes > 0 ? Math.min(end, totalBytes - 1) - start + 1 : 0;

        if (buffer.byteLength < 1000) throw new Error('Fragmento vacío');
        if (expected > 0 && buffer.byteLength < expected) {
          throw new Error(`Fragmento incompleto (${buffer.byteLength}/${expected})`);
        }
        return { buffer, totalBytes, complete: res.status === 200 };
      } catch (err) {
        lastError = err;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('No se pudo descargar el fragmento');
  }

  async function downloadTrack(track) {
    if (!track || !track.id) return;
    if (S.isDownloadingMap[track.id]) {
      showToast('Ya se está descargando esta canción');
      return;
    }
    S.isDownloadingMap[track.id] = true;
    showToast(`Descargando "${track.title}"...`, 3000);

    try {
      const CHUNK_SIZE = 512 * 1024;
      let parts = [];
      let offset = 0;
      let totalBytes = 0;
      let lastProgress = -1;
      let restarted = false;

      // Pide fragmentos consecutivos hasta cubrir el total que informa Content-Range.
      while (totalBytes === 0 || offset < totalBytes) {
        const end = offset + CHUNK_SIZE - 1;
        const { buffer, totalBytes: total, complete } = await fetchAudioChunk(track, offset, end);

        // Si el proxy resolvió otra calidad a mitad de la descarga, el archivo
        // quedaría corrupto: empieza de cero una vez.
        if (total > 0 && totalBytes > 0 && total !== totalBytes) {
          if (restarted) throw new Error('La calidad del audio cambió durante la descarga');
          restarted = true;
          parts = [];
          offset = 0;
          totalBytes = 0;
          lastProgress = -1;
          continue;
        }
        if (total > 0) totalBytes = total;
        parts.push(buffer);
        offset += buffer.byteLength;

        if (complete && !totalBytes) {
          // El origen ignoró el Range y devolvió la canción entera de una vez.
          totalBytes = offset;
          break;
        }
        if (totalBytes > 0 && offset >= totalBytes) break;
        if (buffer.byteLength < CHUNK_SIZE && totalBytes > 0 && offset < totalBytes) {
          throw new Error(`Descarga incompleta (${offset}/${totalBytes} bytes)`);
        }

        const pct = totalBytes > 0 ? Math.min(99, Math.floor((offset / totalBytes) * 100)) : 0;
        if (pct >= lastProgress + 10) {
          lastProgress = pct;
          showToast(`Descargando "${track.title}"... ${pct}%`, 1600);
        }
      }

      const blob = new Blob(parts, { type: 'audio/mp4' });
      if (!blob || blob.size < 1000) throw new Error('Blob de audio inválido');
      if (totalBytes > 0 && blob.size !== totalBytes) {
        throw new Error(`Descarga incompleta (${blob.size}/${totalBytes} bytes)`);
      }

      if ('caches' in window) {
        const cache = await caches.open('freesong-offline-audio-v1');
        await cache.put(
          '/offline-audio/' + track.id,
          new Response(blob, {
            headers: {
              'Content-Type': 'audio/mp4',
              'Content-Length': blob.size.toString()
            }
          })
        );
      }

      if (S.offlineBlobUrls.has(track.id)) {
        URL.revokeObjectURL(S.offlineBlobUrls.get(track.id));
      }
      S.offlineBlobUrls.set(track.id, URL.createObjectURL(blob));

      const entry = {
        id: track.id,
        title: track.title,
        artist: track.artist || 'Artista',
        thumbnail: track.thumbnail,
        duration: track.duration || 0,
        durationText: track.durationText || '',
        downloadedAt: Date.now(),
        size: blob.size
      };

      const existingIdx = S.downloads.findIndex((d) => d.id === track.id);
      if (existingIdx >= 0) {
        S.downloads[existingIdx] = entry;
      } else {
        S.downloads.unshift(entry);
      }
      localStorage.setItem('fs_downloads', JSON.stringify(S.downloads));

      const cur = S.queue[S.currentIndex];
      if (cur && cur.id === track.id) {
        updateDownloadButton(cur);
      }
      if (S.libFilter === 'downloads') {
        renderLibrary();
      }
      showToast(`✓ "${track.title}" descargada para escuchar offline`, 2800);
    } catch (err) {
      console.error('Error al descargar:', err);
      const detail = (err && err.message ? `: ${err.message}` : '').slice(0, 90);
      showToast(`Error al descargar "${track.title}"${detail}`, 5000);
    } finally {
      delete S.isDownloadingMap[track.id];
    }
  }

  async function deleteDownload(trackId) {
    if (!trackId) return;
    try {
      if ('caches' in window) {
        const cache = await caches.open('freesong-offline-audio-v1');
        await cache.delete('/offline-audio/' + trackId);
      }
      if (S.offlineBlobUrls.has(trackId)) {
        URL.revokeObjectURL(S.offlineBlobUrls.get(trackId));
        S.offlineBlobUrls.delete(trackId);
      }
    } catch (e) {
      console.warn('deleteDownload cache error:', e);
    }

    S.downloads = S.downloads.filter((d) => d.id !== trackId);
    localStorage.setItem('fs_downloads', JSON.stringify(S.downloads));

    const cur = S.queue[S.currentIndex];
    if (cur && cur.id === trackId) {
      updateDownloadButton(cur);
    }
    if (S.libFilter === 'downloads') {
      renderLibrary();
    }
    showToast('Canción eliminada de descargas');
  }

  function toggleDownload(track) {
    if (!track || !track.id) return;
    if (isDownloaded(track.id)) {
      deleteDownload(track.id);
    } else {
      downloadTrack(track);
    }
  }

  async function downloadTracksList(tracks, label = 'la lista') {
    const list = (tracks || []).filter((t) => t && t.id);
    if (list.length === 0) {
      showToast('No hay canciones para descargar');
      return;
    }
    const pending = list.filter((t) => !isDownloaded(t.id));
    if (pending.length === 0) {
      showToast(`✓ ${label} ya está descargada`);
      return;
    }
    showToast(`Descargando ${pending.length} canciones de ${label}…`, 3000);
    let done = 0;
    let failed = 0;
    for (const t of pending) {
      try {
        await downloadTrack(t);
        done++;
      } catch {
        failed++;
      }
    }
    haptic('success');
    showToast(`✓ ${done} descargadas${failed ? `, ${failed} fallaron` : ''}`, 3200);
  }

  async function downloadAllFavorites() {
    if (!S.favorites || S.favorites.length === 0) {
      showToast('No tienes canciones favoritas para descargar');
      return;
    }
    await downloadTracksList(S.favorites, 'tus favoritas');
  }

  function updateDownloadButton(track) {
    const btn = $('playerDownloadBtn');
    if (!btn) return;
    const isDown = track && isDownloaded(track.id);
    btn.innerHTML = isDown
      ? '<svg class="w-6 h-6 text-emerald-400"><use href="#i-download-done"/></svg>'
      : '<svg class="w-6 h-6 text-zinc-300"><use href="#i-download"/></svg>';
    btn.title = isDown ? 'Descargada (Toca para eliminar)' : 'Descargar para escuchar offline';
  }

  // --- Reproducción y Cambio de Pista Maestro ---
  function playTrack(index, immediate = false) {
    isTransitioningTrack = false;
    if (trackTransitionTimeout) {
      clearTimeout(trackTransitionTimeout);
      trackTransitionTimeout = null;
    }
    if (index < 0 || index >= S.queue.length) {
      isTransitioningTrack = false;
      return;
    }
    S.currentIndex = index;
    const track = S.queue[index];
    S.currentTrack = track;
    localStorage.setItem('fs_last_track', JSON.stringify(track));
    saveSession(true, 0);

    userIntentionalPause = false;
    track._fallbackStep = 0;

    // Si veníamos de YouTube Engine, pausarlo al cambiar de pista
    if (isYtMode && ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
      try { ytPlayer.pauseVideo(); } catch {}
    }
    isYtMode = false;
    stopYtProgressTimer();
    keepAudioAlive();

    // 0. Cancelar peticiones y cargas de audio anteriores (AbortController global)
    if (window.activeStreamAbort) {
      try {
        window.activeStreamAbort.abort();
      } catch {}
    }
    window.activeStreamAbort = new AbortController();
    const abortSignal = window.activeStreamAbort.signal;

    // Si es salto manual o había crossfade activo, cancelar crossfade y fijar volumen al 100%
    if (immediate || isCrossfading) {
      cancelActiveCrossfade();
    }

    // 1. Mostrar y sincronizar inmediatamente el Mini-Player en el milisegundo 0 (antes de cualquier audio)
    showAndSyncMiniPlayer(track, true);

    // Reset inmediato de posición visual en la interfaz para la nueva pista
    if ($('playerCurTime')) $('playerCurTime').textContent = '0:00';
    if ($('playerSeek')) $('playerSeek').value = 0;
    if ($('miniProgress')) $('miniProgress').style.width = '0%';

    // 2. Comprobación 100% síncrona en memoria (0ms, NUNCA await antes de play)
    // La copia offline tiene prioridad: si está descargada debe sonar sin red,
    // aunque la pista también tenga una URL de streaming precargada.
    const streamUrl = getTrackStreamUrl(track);

    // Actualizar UI y ambiente dinámico inmediatamente
    updatePlayerUI(track);
    applyDynamicColor(track);
    saveHistory(track);
    recordPlayStat(track);
    loadLyrics(track, abortSignal);
    loadSimilarTracks(track, abortSignal);
    updateMediaSession(track);
    ensureUpcomingTracks(track, abortSignal);
    enrichTrackDuration(track, abortSignal);

    const isBg = isBackground();
    // Crossfade elegante SOLO de forma automática al final natural (!immediate)
    const shouldCrossfade = S.crossfade && S.isPlaying && !immediate && !isIOS && !isBg;
    const outPlayer = getActivePlayer();
    let inPlayer;
    let reusingPrefetched = false;

    if (shouldCrossfade) {
      inPlayer = getInactivePlayer();
    } else {
      // Si el otro deck ya tiene esta pista precargada, se reproduce desde ESE
      // deck. Antes se descartaba su buffer y se volvía a pedir la canción en
      // el deck actual: eso añadía 1-3 s en cada cambio automático (y en iPhone).
      const prefetched = getInactivePlayer();
      const prefetchedSrc = prefetched ? (prefetched.currentSrc || prefetched.src || '') : '';
      if (
        prefetched &&
        prefetched.dataset.prefetchedId === track.id &&
        prefetchedSrc &&
        prefetchedSrc === streamUrl &&
        !prefetched.error
      ) {
        activeDeckIdx = 1 - activeDeckIdx;
        inPlayer = prefetched;
        reusingPrefetched = true;
      } else {
        inPlayer = outPlayer;
      }
    }

    delete inPlayer.dataset.retried;
    delete inPlayer.dataset.prefetched;
    delete inPlayer.dataset.prefetchedId;

    // Configurar volumen de normalización y velocidad
    const targetVolume = S.audioNormalize ? 0.88 : 1.0;

    // Marca para medir el arranque real (diagnóstico local).
    pendingStartMark = Date.now();
    pendingStartId = track.id;

    try {
      if (shouldCrossfade) {
        inPlayer.muted = false;
        inPlayer.volume = 0;
        inPlayer.playbackRate = S.playbackRate;
        inPlayer.src = streamUrl;
        inPlayer.play().catch(() => {});
        performCrossfade(outPlayer, inPlayer, S.crossfadeDuration);
      } else {
        cancelActiveCrossfade();
        const inact = getInactivePlayer();
        if (inact && inact !== inPlayer) {
          try {
            inact.pause();
            inact.removeAttribute('src');
            inact.load();
            delete inact.dataset.prefetchedId;
            inact.volume = targetVolume;
          } catch {}
        }
        inPlayer.muted = false;
        inPlayer.volume = targetVolume;
        inPlayer.playbackRate = S.playbackRate;

        if (reusingPrefetched) {
          // Ya está cargada y con buffer: NO reasignar `src` (reiniciaría la
          // descarga y provocaría el silencio de varios segundos).
          try {
            if (inPlayer.currentTime > 0.25) inPlayer.currentTime = 0;
          } catch {}
          applyPendingResume(inPlayer, track);
          const playPromise = inPlayer.play();
          if (playPromise && playPromise.catch) {
            playPromise.catch((err) => {
              if (err.name !== 'AbortError') {
                console.warn('inPlayer play error:', err);
                reusingPrefetched = false;
                delete inPlayer.dataset.prefetchedId;
                if (S.queue[S.currentIndex] === track && !userIntentionalPause) {
                  handleStreamFailure(track, inPlayer);
                } else {
                  S.isPlaying = false;
                  updatePlayPauseIcons(false, false);
                }
              }
            });
          }
        } else {
          // Reset de posición
          try { inPlayer.currentTime = 0; } catch {}

          // Asignación directa y 100% síncrona en iOS Safari
          inPlayer.src = streamUrl;
          applyPendingResume(inPlayer, track);
          const playPromise = inPlayer.play();
          if (playPromise && playPromise.catch) {
            playPromise.catch((err) => {
              if (err.name !== 'AbortError') {
                console.warn('inPlayer play error:', err);
                S.isPlaying = false;
                updatePlayPauseIcons(false, false);
              }
            });
          }
        }
      }

      S.isPlaying = true;
      updatePlayPauseIcons(true);

      // Si el proxy tarda, salta al relay directo en cuanto resuelva. Se hace
      // DESPUÉS del play() síncrono y de marcar S.isPlaying: no bloquea el gesto
      // de iOS ni retrasa el audio, y solo actúa si la pista aún no empezó.
      if (!shouldCrossfade && !isDirectRelayUrl(streamUrl)) {
        upgradePlaybackToRelay(track, inPlayer);
      }

      // Watchdog en dos fases: si a los 6 s no llegó ni un byte de metadatos,
      // la URL está muerta y se reintenta de inmediato. Si ya hay metadatos
      // pero sigue en 0:00, se le dan unos segundos más antes de intervenir.
      armStreamWatchdog(track);

    } catch (err) {
      console.error('Error al reproducir pista:', err);
      isTransitioningTrack = false;
      S.isPlaying = false;
      updatePlayPauseIcons(false, false);
    }
  }

  // --- Curva de Crossfade Senoidal (Desktop) ---
  function performCrossfade(outP, inP, durationSec) {
    // No usar cancelActiveCrossfade(): resetea AMBOS decks a volumen máximo y hacía
    // que la pista entrante sonara fuerte durante el primer tick del fundido.
    if (window.crossfadeInterval) {
      clearInterval(window.crossfadeInterval);
      window.crossfadeInterval = null;
    }
    if (fadeInterval) {
      clearInterval(fadeInterval);
      fadeInterval = null;
    }
    isCrossfading = true;

    const steps = 30;
    const stepTime = (durationSec * 1000) / steps;
    let currentStep = 0;
    const maxVol = S.audioNormalize ? 0.88 : 1.0;

    window.crossfadeInterval = setInterval(() => {
      currentStep++;
      const progress = currentStep / steps;

      const outVol = Math.cos((progress * Math.PI) / 2) * maxVol;
      const inVol = Math.sin((progress * Math.PI) / 2) * maxVol;

      try {
        if (outP) outP.volume = Math.max(0, Math.min(maxVol, outVol));
        if (inP) inP.volume = Math.max(0, Math.min(maxVol, inVol));
      } catch {}

      if (currentStep >= steps) {
        cancelActiveCrossfade();
        try {
          if (outP) {
            outP.pause();
            outP.currentTime = 0;
            outP.removeAttribute('src');
            outP.load();
            outP.volume = maxVol;
          }
          if (inP) {
            inP.volume = maxVol;
          }
        } catch {}
        activeDeckIdx = 1 - activeDeckIdx;
      }
    }, stepTime);
    fadeInterval = window.crossfadeInterval;
  }

  // --- Micro-fundido de volumen al pausar/reanudar (80 ms) ---
  let microFadeTimer = null;

  function cancelMicroFade() {
    if (microFadeTimer) {
      clearInterval(microFadeTimer);
      microFadeTimer = null;
    }
  }

  function getTargetVolume() {
    return S.audioNormalize ? 0.88 : 1.0;
  }

  function rampVolume(deck, from, to, ms, onDone) {
    cancelMicroFade();
    if (!deck) {
      if (onDone) onDone();
      return;
    }
    if (!S.audioFade || ms <= 0) {
      try { deck.volume = to; } catch {}
      if (onDone) onDone();
      return;
    }
    const steps = Math.max(1, Math.round(ms / 10));
    let step = 0;
    try { deck.volume = from; } catch {}
    microFadeTimer = setInterval(() => {
      step++;
      const p = step / steps;
      try { deck.volume = from + (to - from) * p; } catch {}
      if (step >= steps) {
        cancelMicroFade();
        try { deck.volume = to; } catch {}
        if (onDone) onDone();
      }
    }, 10);
  }

  function pausePlayback() {
    userIntentionalPause = true;
    isTransitioningTrack = false;
    if (trackTransitionTimeout) {
      clearTimeout(trackTransitionTimeout);
      trackTransitionTimeout = null;
    }
    if (streamWatchdogTimer) {
      clearTimeout(streamWatchdogTimer);
      streamWatchdogTimer = null;
    }
    if (isYtMode && ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
      try { ytPlayer.pauseVideo(); } catch {}
    }
    const p = getActivePlayer();
    if (p && !p.paused) {
      const fromVol = p.volume;
      // 80 ms de fundido: quita el corte seco de un equipo barato.
      rampVolume(p, fromVol, 0, 80, () => {
        try { p.pause(); } catch {}
        try { p.volume = fromVol || getTargetVolume(); } catch {}
      });
    } else if (p) {
      try { p.pause(); } catch {}
    }
    const inact = getInactivePlayer();
    if (inact) inact.pause();
    S.isPlaying = false;
    updatePlayPauseIcons(false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    saveSession(true);
  }

  function resumePlayback() {
    userIntentionalPause = false;
    keepAudioAlive();
    if (S.currentIndex === -1 && S.queue.length > 0) {
      playTrack(0);
      return;
    }
    if (isYtMode) {
      if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
        try { ytPlayer.playVideo(); } catch {}
        S.isPlaying = true;
        updatePlayPauseIcons(true);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      }
      return;
    }
    const p = getActivePlayer();
    if (p) {
      if (!p.src || p.src === '' || p.src === window.location.href) {
        if (S.currentIndex >= 0 && S.queue[S.currentIndex]) {
          playTrack(S.currentIndex, true);
          return;
        }
      }
      p.playbackRate = S.playbackRate;
      const targetVol = getTargetVolume();
      if (S.audioFade) {
        try { p.volume = 0; } catch {}
      } else {
        try { p.volume = targetVol; } catch {}
      }
      // play() síncrono: iOS exige que ocurra dentro del gesto del usuario.
      let playPromise = null;
      try {
        playPromise = p.play();
      } catch {}
      if (playPromise && playPromise.catch) {
        playPromise.catch(() => {
          try { p.volume = targetVol; } catch {}
        });
      }
      if (S.audioFade) rampVolume(p, 0, targetVol, 80);
      S.isPlaying = true;
      updatePlayPauseIcons(true);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    }
  }

  function togglePlayPause() {
    haptic('light');
    if (S.isPlaying) pausePlayback();
    else resumePlayback();
  }

  function playNext(immediate = true) {
    isTransitioningTrack = false;
    if (trackTransitionTimeout) {
      clearTimeout(trackTransitionTimeout);
      trackTransitionTimeout = null;
    }
    const now = Date.now();
    // Bloqueo de seguridad de 300ms para evitar colisiones de clics rápidos
    if (now - lastSkipTimestamp < 300) return;
    lastSkipTimestamp = now;
    haptic('light');

    userIntentionalPause = false;
    if (S.queue.length === 0) {
      isTransitioningTrack = false;
      return;
    }
    const nextIdx = getNextIndex(true);
    if (nextIdx >= 0) {
      playTrack(nextIdx, typeof immediate === 'boolean' ? immediate : true);
    } else {
      // Fin de la cola con la repetición desactivada
      isTransitioningTrack = false;
      userIntentionalPause = true;
      S.isPlaying = false;
      try { getActivePlayer().pause(); } catch {}
      updatePlayPauseIcons(false, false);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    }
  }

  function playPrev() {
    const now = Date.now();
    // Bloqueo de seguridad de 300ms para clics rápidos
    if (now - lastSkipTimestamp < 300) return;
    lastSkipTimestamp = now;
    haptic('light');

    userIntentionalPause = false;
    if (S.queue.length === 0) return;
    const p = getActivePlayer();
    if (p && p.currentTime > 3) {
      p.currentTime = 0;
      return;
    }
    let prevIdx = S.currentIndex - 1;
    if (prevIdx < 0) prevIdx = S.queue.length - 1;
    playTrack(prevIdx, true);
  }

  // --- Letras sincronizadas (LRCLIB) ---
  // La letra se pinta UNA vez y luego solo se tocan atributos y una variable CSS.
  // Antes se reescribía el className y se hacía scrollIntoView en cada línea:
  // eso provocaba saltos, cambios de tamaño y tirones en iPhone.
  const LYRICS_CACHE_KEY = 'fs_lyrics_cache_v1';
  const LYRICS_OFFSET_KEY = 'fs_lyrics_offsets_v1';
  const LYRICS_CACHE_MAX = 60;

  let lyricsCache = (() => {
    try { return JSON.parse(localStorage.getItem(LYRICS_CACHE_KEY) || '{}') || {}; } catch { return {}; }
  })();
  let lyricOffsets = (() => {
    try { return JSON.parse(localStorage.getItem(LYRICS_OFFSET_KEY) || '{}') || {}; } catch { return {}; }
  })();

  let lyricNodes = [];            // [{ el, fill, time }]
  let lyricsActiveIdx = -1;
  let lyricsRaf = null;
  let lyricsAutoScrollUntil = 0;  // ignora los scroll que provocamos nosotros
  let lyricsScrollLockedUntil = 0; // el usuario movió la letra: no lo arrastres
  let lyricsScrollUnlockTimer = null;
  let lyricsLoadedKey = null;
  let lyricsLoadingKey = null;
  const lyricsInFlight = new Set();

  function lyricsCacheKey(track) {
    if (!track) return '';
    return `${track.id || ''}|${String(track.title || '').toLowerCase()}|${String(track.artist || '').toLowerCase()}`;
  }

  function saveLyricsCache() {
    try {
      localStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(lyricsCache));
    } catch {
      // Cuota llena: conserva solo las 20 letras más recientes.
      const entries = Object.entries(lyricsCache).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 20);
      lyricsCache = Object.fromEntries(entries);
      try { localStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(lyricsCache)); } catch {}
    }
  }

  function trimLyricsCache() {
    const keys = Object.keys(lyricsCache);
    if (keys.length <= LYRICS_CACHE_MAX) return;
    keys.sort((a, b) => (lyricsCache[b].at || 0) - (lyricsCache[a].at || 0));
    for (const key of keys.slice(LYRICS_CACHE_MAX)) delete lyricsCache[key];
  }

  function parseLrc(lrcText) {
    if (!lrcText) return [];
    const timeTag = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const offsetTag = /\[offset:\s*([+-]?\d+)\]/i.exec(lrcText);
    const offset = offsetTag ? (parseInt(offsetTag[1], 10) || 0) / 1000 : 0;
    const result = [];

    for (const rawLine of String(lrcText).split(/\r?\n/)) {
      timeTag.lastIndex = 0;
      const stamps = [];
      let match;
      while ((match = timeTag.exec(rawLine))) {
        const min = parseInt(match[1], 10);
        const sec = parseInt(match[2], 10);
        const frac = match[3] ? parseInt(match[3], 10) / Math.pow(10, match[3].length) : 0;
        stamps.push(min * 60 + sec + frac);
      }
      if (!stamps.length) continue;

      const text = rawLine
        .replace(timeTag, '')
        .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '') // LRC mejorado (palabra a palabra)
        .trim();
      if (!text) continue;

      for (const time of stamps) result.push({ time: Math.max(0, time + offset), text });
    }

    result.sort((a, b) => a.time - b.time);
    const deduped = [];
    for (const item of result) {
      const prev = deduped[deduped.length - 1];
      if (prev && Math.abs(prev.time - item.time) < 0.01 && prev.text === item.text) continue;
      deduped.push(item);
    }
    return deduped;
  }

  function getCurrentPlaybackTime() {
    if (isYtMode && ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
      try { return ytPlayer.getCurrentTime() || 0; } catch { return null; }
    }
    const p = getActivePlayer();
    if (!p || !Number.isFinite(p.currentTime)) return null;
    return p.currentTime;
  }

  function isLyricsVisible() {
    const sheet = $('fullPlayerSheet');
    const view = $('sheetLyricsView');
    return !!view && !view.classList.contains('hidden') &&
      !!sheet && !sheet.classList.contains('translate-y-full');
  }

  function findLyricIndex(t) {
    const list = S.syncedLyrics;
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t >= list[mid].time) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  function renderLyrics(lyricsList) {
    const container = $('lyricsContainer');
    if (!container) return;

    container.innerHTML = `<div class="lyrics-stage">${lyricsList.map((item, idx) => `
      <p class="lyric-line" data-state="future" data-idx="${idx}" role="button" tabindex="0"
         aria-label="Ir a ${formatTime(item.time)}">
        <span class="lyric-text">${esc(item.text)}</span>
        <span class="lyric-text lyric-fill" aria-hidden="true">${esc(item.text)}</span>
      </p>`).join('')}</div>`;

    lyricNodes = Array.from(container.querySelectorAll('.lyric-line')).map((el, idx) => ({
      el,
      fill: el.querySelector('.lyric-fill'),
      time: lyricsList[idx].time,
      lastPct: -1
    }));

    container.onclick = (event) => {
      const line = event.target.closest('.lyric-line');
      if (!line) return;
      seekToLyric(Number(line.dataset.idx));
    };
    container.onkeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const line = event.target.closest('.lyric-line');
      if (!line) return;
      event.preventDefault();
      seekToLyric(Number(line.dataset.idx));
    };
  }

  function seekToLyric(idx) {
    const item = S.syncedLyrics[idx];
    if (!item) return;
    const target = Math.max(0, item.time - (S.lyricsOffset || 0));
    const wasPlaying = S.isPlaying;

    if (isYtMode && ytPlayer && typeof ytPlayer.seekTo === 'function') {
      try { ytPlayer.seekTo(target, true); } catch {}
    } else {
      const player = getActivePlayer();
      if (!player) return;
      try { player.currentTime = target; } catch {}
      if (!wasPlaying && player.paused) {
        try {
          const playPromise = player.play();
          if (playPromise && playPromise.catch) playPromise.catch(() => {});
          S.isPlaying = true;
          updatePlayPauseIcons(true, false);
        } catch {}
      }
    }

    S.currentLyricIdx = idx;
    lyricsActiveIdx = -1;
    lyricsScrollLockedUntil = 0;
    $('lyricsJumpBack')?.classList.add('hidden');
    syncLyricsWithTime(target);
    scrollLyricsTo(idx, false);
  }

  function paintLyricState(idx) {
    for (let i = 0; i < lyricNodes.length; i++) {
      const node = lyricNodes[i];
      const state = i < idx ? 'past' : i === idx ? 'current' : 'future';
      if (node.el.dataset.state !== state) node.el.dataset.state = state;
      if (i !== idx && node.lastPct !== 0) {
        node.el.style.setProperty('--lp', '0');
        node.lastPct = 0;
      }
    }
  }

  function paintLyricProgress(idx, t) {
    const node = lyricNodes[idx];
    if (!node) return;
    const start = S.syncedLyrics[idx].time;
    const next = S.syncedLyrics[idx + 1];
    // El barrido termina un pelín antes de la siguiente línea para que no
    // quede "a medias" cuando la letra va muy seguida.
    const span = Math.max(0.45, (next ? next.time : start + 5) - start - 0.12);
    const pct = Math.max(0, Math.min(1, (t - start) / span));
    if (Math.abs(pct - node.lastPct) < 0.008) return;
    node.lastPct = pct;
    node.el.style.setProperty('--lp', pct.toFixed(3));
  }

  function syncLyricsWithTime(time) {
    if (!S.syncedLyrics.length || !lyricNodes.length) return;

    const t = time + (S.lyricsOffset || 0);
    let idx;
    if (lyricsActiveIdx >= 0 && lyricsActiveIdx < S.syncedLyrics.length &&
        t >= S.syncedLyrics[lyricsActiveIdx].time) {
      // Avance normal: casi siempre basta con comprobar la siguiente línea.
      idx = lyricsActiveIdx;
      while (idx + 1 < S.syncedLyrics.length && t >= S.syncedLyrics[idx + 1].time) idx++;
    } else {
      idx = findLyricIndex(t); // salto/seek hacia atrás
    }

    if (idx !== lyricsActiveIdx) {
      lyricsActiveIdx = idx;
      S.currentLyricIdx = idx;
      paintLyricState(idx);
      if (isLyricsVisible()) scrollLyricsTo(idx, false);
    }
    if (idx >= 0) paintLyricProgress(idx, t);
  }

  let lyricsScrollFallbackTimer = null;

  function cancelLyricsScrollAnim() {
    if (lyricsScrollFallbackTimer) {
      clearTimeout(lyricsScrollFallbackTimer);
      lyricsScrollFallbackTimer = null;
    }
  }

  function scrollLyricsTo(idx, instant) {
    const view = $('lyricsScroll');
    const node = lyricNodes[idx];
    if (!view || !node) return;
    if (!instant && Date.now() < lyricsScrollLockedUntil) return;

    const target = node.el.offsetTop - view.clientHeight / 2 + node.el.offsetHeight / 2;
    const max = Math.max(0, view.scrollHeight - view.clientHeight);
    const top = Math.max(0, Math.min(target, max));
    const from = view.scrollTop;
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    cancelLyricsScrollAnim();
    lyricsAutoScrollUntil = Date.now() + 800;

    if (instant || reduced || Math.abs(top - from) < 2) {
      view.style.scrollBehavior = 'auto';
      view.scrollTop = top;
      return;
    }

    // Desplazamiento suave nativo (CSS). Es el que mejor se siente en iPhone y
    // Android. Si el motor lo ignora, la red de seguridad salta al destino.
    view.style.scrollBehavior = 'smooth';
    view.scrollTop = top;

    lyricsScrollFallbackTimer = setTimeout(() => {
      lyricsScrollFallbackTimer = null;
      if (Math.abs(view.scrollTop - from) < 2 && Math.abs(top - from) > 2) {
        view.style.scrollBehavior = 'auto';
        view.scrollTop = top;
      }
    }, 420);
  }

  let lyricsInterval = null;

  function startLyricsLoop() {
    if (!S.syncedLyrics.length) return;
    const tick = () => {
      lyricsRaf = requestAnimationFrame(tick);
      if (isBackground() || !isLyricsVisible()) {
        stopLyricsLoop();
        return;
      }
      const time = getCurrentPlaybackTime();
      if (time !== null) syncLyricsWithTime(time);
    };
    if (!lyricsRaf) lyricsRaf = requestAnimationFrame(tick);

    // Respaldo por si el navegador congela requestAnimationFrame (algunos
    // WebViews y el modo de bajo consumo). El barrido sigue avanzando.
    if (!lyricsInterval) {
      lyricsInterval = setInterval(() => {
        if (isBackground() || !isLyricsVisible()) {
          stopLyricsLoop();
          return;
        }
        const time = getCurrentPlaybackTime();
        if (time !== null) syncLyricsWithTime(time);
      }, 120);
    }
  }

  function stopLyricsLoop() {
    if (lyricsRaf) {
      cancelAnimationFrame(lyricsRaf);
      lyricsRaf = null;
    }
    if (lyricsInterval) {
      clearInterval(lyricsInterval);
      lyricsInterval = null;
    }
  }

  function updateLyricOffsetUI() {
    const el = $('lyricSyncValue');
    if (!el) return;
    const value = S.lyricsOffset || 0;
    el.textContent = `${value > 0 ? '+' : ''}${value.toFixed(2).replace(/0$/, '')} s`;
    el.dataset.dirty = value ? 'true' : 'false';
  }

  function adjustLyricOffset(delta) {
    const track = S.currentTrack;
    if (!track || !track.id) return;
    const next = Math.round(((S.lyricsOffset || 0) + delta) * 100) / 100;
    S.lyricsOffset = Math.max(-15, Math.min(15, next));

    if (S.lyricsOffset) lyricOffsets[track.id] = S.lyricsOffset;
    else delete lyricOffsets[track.id];
    try { localStorage.setItem(LYRICS_OFFSET_KEY, JSON.stringify(lyricOffsets)); } catch {}

    updateLyricOffsetUI();
    lyricsActiveIdx = -1;
    const time = getCurrentPlaybackTime();
    if (time !== null) syncLyricsWithTime(time);
    if (isLyricsVisible()) scrollLyricsTo(Math.max(0, S.currentLyricIdx), false);
  }

  function resetLyricOffset() {
    if (!S.lyricsOffset) return;
    adjustLyricOffset(-S.lyricsOffset);
    showToast('Sincronía de la letra reiniciada');
  }

  function applyLyricsData(payload, track) {
    const container = $('lyricsContainer');
    if (!container) return;

    S.syncedLyrics = payload.synced || [];
    S.currentLyricIdx = -1;
    lyricsActiveIdx = -1;
    lyricsLoadedKey = lyricsCacheKey(track);

    if (S.syncedLyrics.length) {
      renderLyrics(S.syncedLyrics);
      const time = getCurrentPlaybackTime() || 0;
      syncLyricsWithTime(time);
      if (isLyricsVisible()) {
        startLyricsLoop();
        scrollLyricsTo(Math.max(0, S.currentLyricIdx), true);
      }
      return;
    }

    stopLyricsLoop();
    lyricNodes = [];

    if (payload.plain) {
      container.innerHTML = `
        <div class="py-2">
          <p class="lyrics-note">Letra sin sincronía</p>
          <div class="text-zinc-300 text-[15px] leading-relaxed whitespace-pre-line text-left px-1">${esc(payload.plain)}</div>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="py-10 text-center space-y-3">
        <p class="text-zinc-200 text-sm font-bold">Aún no hay letra para esta canción</p>
        <p class="text-zinc-500 text-xs">Puede ser una versión poco conocida. Inténtalo otra vez.</p>
        <button type="button" id="lyricsRetryBtn" class="lyrics-chip">Reintentar</button>
      </div>`;
    $('lyricsRetryBtn')?.addEventListener('click', () => loadLyrics(track, null, true));
  }

  async function loadLyrics(track, signal, force = false) {
    const container = $('lyricsContainer');
    if (!container || !track || !track.id) return;

    const key = lyricsCacheKey(track);
    S.lyricsTrackId = track.id;
    S.lyricsOffset = Number(lyricOffsets[track.id]) || 0;
    updateLyricOffsetUI();

    if (!force && lyricsCache[key]) {
      lyricsLoadedKey = key;
      applyLyricsData(lyricsCache[key], track);
      return;
    }

    S.syncedLyrics = [];
    S.currentLyricIdx = -1;
    lyricsActiveIdx = -1;
    lyricNodes = [];
    lyricsLoadedKey = null;
    stopLyricsLoop();

    container.innerHTML = `
      <div class="lyrics-skeleton" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span></div>
      <p class="text-[11px] text-zinc-500 pt-1">Buscando la letra exacta de esta versión…</p>`;

    lyricsLoadingKey = key;
    const duration = Math.round(track.duration || track.durationSeconds || 0);
    const url = `/api/lyrics?track=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist || '')}` +
      (duration > 0 ? `&duration=${duration}` : '');

    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (S.lyricsTrackId !== track.id) return;

      const payload = {
        at: Date.now(),
        synced: data.syncedLyrics ? parseLrc(data.syncedLyrics) : [],
        plain: data.plainLyrics || null,
        match: data.match || null
      };

      if (payload.synced.length || payload.plain) {
        lyricsCache[key] = payload;
        trimLyricsCache();
        saveLyricsCache();
      }
      applyLyricsData(payload, track);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (S.lyricsTrackId !== track.id) return;
      container.innerHTML = `
        <div class="py-10 text-center space-y-3">
          <p class="text-zinc-400 text-sm">No se pudo cargar la letra</p>
          <button type="button" id="lyricsRetryBtn" class="lyrics-chip">Reintentar</button>
        </div>`;
      $('lyricsRetryBtn')?.addEventListener('click', () => loadLyrics(track, null, true));
    } finally {
      if (lyricsLoadingKey === key) lyricsLoadingKey = null;
    }
  }

  // Deja la letra de la siguiente canción lista antes de cambiar de pista.
  function prefetchLyrics(track) {
    if (!track || !track.id) return;
    const key = lyricsCacheKey(track);
    if (lyricsCache[key] || lyricsInFlight.has(key)) return;

    lyricsInFlight.add(key);
    const duration = Math.round(track.duration || track.durationSeconds || 0);
    const url = `/api/lyrics?track=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist || '')}` +
      (duration > 0 ? `&duration=${duration}` : '');

    fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        const synced = data.syncedLyrics ? parseLrc(data.syncedLyrics) : [];
        if (!synced.length && !data.plainLyrics) return;
        lyricsCache[key] = {
          at: Date.now(),
          synced,
          plain: data.plainLyrics || null,
          match: data.match || null
        };
        trimLyricsCache();
        saveLyricsCache();
      })
      .catch(() => {})
      .finally(() => lyricsInFlight.delete(key));
  }

  function setupLyricsView() {
    const view = $('lyricsScroll');
    if (!view) return;

    view.addEventListener('scroll', () => {
      if (Date.now() < lyricsAutoScrollUntil) return;
      // El usuario está leyendo otra parte: deja de seguir la canción un rato.
      lyricsScrollLockedUntil = Date.now() + 5000;
      $('lyricsJumpBack')?.classList.remove('hidden');
      clearTimeout(lyricsScrollUnlockTimer);
      lyricsScrollUnlockTimer = setTimeout(() => {
        if (Date.now() >= lyricsScrollLockedUntil) {
          $('lyricsJumpBack')?.classList.add('hidden');
        }
      }, 5200);
    }, { passive: true });

    // Si toca la letra mientras se desplaza sola, manda el usuario.
    const markUserScrolling = () => {
      cancelLyricsScrollAnim();
      lyricsAutoScrollUntil = 0;
      lyricsScrollLockedUntil = Date.now() + 5000;
      $('lyricsJumpBack')?.classList.remove('hidden');
      clearTimeout(lyricsScrollUnlockTimer);
      lyricsScrollUnlockTimer = setTimeout(() => {
        if (Date.now() >= lyricsScrollLockedUntil) {
          $('lyricsJumpBack')?.classList.add('hidden');
        }
      }, 5200);
    };
    view.addEventListener('touchstart', markUserScrolling, { passive: true });
    view.addEventListener('wheel', markUserScrolling, { passive: true });

    $('lyricsJumpBack')?.addEventListener('click', () => {
      lyricsScrollLockedUntil = 0;
      $('lyricsJumpBack')?.classList.add('hidden');
      scrollLyricsTo(Math.max(0, S.currentLyricIdx), false);
    });

    $('lyricSyncDown')?.addEventListener('click', () => adjustLyricOffset(-0.25));
    $('lyricSyncUp')?.addEventListener('click', () => adjustLyricOffset(0.25));
    $('lyricSyncValue')?.addEventListener('click', resetLyricOffset);

    window.addEventListener('resize', () => {
      if (isLyricsVisible()) scrollLyricsTo(Math.max(0, S.currentLyricIdx), true);
    });
  }

  // --- Compartir Verso de Letra en Historia 9:16 (1080 × 1920) ---
  // Instagram, WhatsApp y TikTok usan formato vertical. La tarjeta cuadrada
  // anterior se recortaba; ahora se genera completa y con vista previa antes
  // de compartir (también evita perder el gesto de usuario en iOS).
  const STORY_W = 1080;
  const STORY_H = 1920;
  const STORY_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function downloadBlob(blob, filename) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  }

  function storyShareHost() {
    const host = window.location.hostname;
    if (!host || host === 'localhost' || host === '127.0.0.1') return 'freesong-pied.vercel.app';
    return host;
  }

  function trackShareUrl(track) {
    return `${window.location.origin}/?track=${encodeURIComponent(track.id)}`;
  }

  function wrapCanvasLines(ctx, text, maxWidth) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) return [];
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function fitCanvasLines(ctx, text, maxWidth, maxLines, sizes, weight = '800') {
    let chosen = { size: sizes[sizes.length - 1], lines: [] };
    for (const size of sizes) {
      ctx.font = `${weight} ${size}px ${STORY_FONT}`;
      const lines = wrapCanvasLines(ctx, text, maxWidth);
      chosen = { size, lines };
      if (lines.length <= maxLines) break;
    }
    if (chosen.lines.length > maxLines) {
      chosen.lines = chosen.lines.slice(0, maxLines);
      const last = chosen.lines[maxLines - 1] || '';
      chosen.lines[maxLines - 1] = `${last.replace(/[.,;:!?]+$/, '')}…`;
    }
    return chosen;
  }

  function drawCenteredLines(ctx, lines, centerX, firstBaseline, lineHeight) {
    lines.forEach((line, i) => ctx.fillText(line, centerX, firstBaseline + i * lineHeight));
  }

  function loadCanvasImage(src, timeoutMs = 2500) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      img.crossOrigin = 'anonymous';
      img.onload = () => finish(img.naturalWidth ? img : null);
      img.onerror = () => finish(null);
      setTimeout(() => finish(null), timeoutMs);
      img.src = src;
    });
  }

  async function loadStoryCover(track) {
    const sources = [];
    if (track.id) {
      // Versiones grandes y sin barras negras; la portada cuadrada de la app
      // (120 px) queda como último recurso por su baja resolución.
      sources.push(`https://i.ytimg.com/vi/${track.id}/maxresdefault.jpg`);
      sources.push(`https://i.ytimg.com/vi/${track.id}/hq720.jpg`);
    }
    if (track.thumbnail) sources.push(track.thumbnail);
    if (track.id) sources.push(`https://i.ytimg.com/vi/${track.id}/mqdefault.jpg`);
    const unique = [...new Set(sources)];
    if (!unique.length) return null;
    // Se piden en paralelo: la primera que cargue gana. YouTube a veces limita
    // el host principal (429) y las portadas de i.ytimg siguen disponibles.
    const results = await Promise.all(unique.map((src) => loadCanvasImage(src, 2400)));
    return results.find(Boolean) || null;
  }

  // Dibuja la portada recortada al centro (object-fit: cover) sin deformarla.
  function drawCoverFit(ctx, img, x, y, w, h) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const scale = Math.max(w / iw, h / ih);
    const sw = w / scale;
    const sh = h / scale;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  }

  async function buildStoryCard(track, verse, nextVerse) {
    const canvas = document.createElement('canvas');
    canvas.width = STORY_W;
    canvas.height = STORY_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Fondo degradado profundo
    const bg = ctx.createLinearGradient(0, 0, STORY_W, STORY_H);
    bg.addColorStop(0, '#062019');
    bg.addColorStop(0.45, '#04120d');
    bg.addColorStop(1, '#010604');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, STORY_W, STORY_H);

    // Resplandores esmeralda
    let glow = ctx.createRadialGradient(160, 300, 20, 160, 300, 620);
    glow.addColorStop(0, 'rgba(16, 185, 129, 0.30)');
    glow.addColorStop(1, 'rgba(16, 185, 129, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, STORY_W, STORY_H);

    glow = ctx.createRadialGradient(980, 1500, 20, 980, 1500, 720);
    glow.addColorStop(0, 'rgba(52, 211, 153, 0.16)');
    glow.addColorStop(1, 'rgba(52, 211, 153, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, STORY_W, STORY_H);

    const vignette = ctx.createRadialGradient(540, 960, 280, 540, 960, 1150);
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, 'rgba(0, 0, 0, 0.5)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, STORY_W, STORY_H);

    const centerX = STORY_W / 2;

    // Marca superior
    ctx.save();
    roundRect(ctx, 96, 210, 64, 64, 20);
    ctx.fillStyle = '#10b981';
    ctx.fill();
    ctx.fillStyle = '#04120d';
    ctx.font = `900 34px ${STORY_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FS', 128, 244);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 36px ${STORY_FONT}`;
    ctx.fillText('FreeSong', 180, 236);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.font = `600 22px ${STORY_FONT}`;
    ctx.fillText('MÚSICA CON LETRA', 180, 270);

    const pillW = 156;
    const pillH = 54;
    const pillX = STORY_W - 96 - pillW;
    const pillY = 216;
    roundRect(ctx, pillX, pillY, pillW, pillH, 27);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.42)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#6ee7b7';
    ctx.font = `800 22px ${STORY_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('HISTORIA', pillX + pillW / 2, pillY + pillH / 2 + 1);
    ctx.restore();

    // Portada con sombra
    const cover = await loadStoryCover(track);
    const coverSize = 520;
    const coverX = (STORY_W - coverSize) / 2;
    const coverY = 320;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = 70;
    ctx.shadowOffsetY = 28;
    ctx.fillStyle = '#0b1512';
    roundRect(ctx, coverX, coverY, coverSize, coverSize, 48);
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRect(ctx, coverX, coverY, coverSize, coverSize, 48);
    ctx.clip();
    if (cover) {
      drawCoverFit(ctx, cover, coverX, coverY, coverSize, coverSize);
    } else {
      ctx.fillStyle = '#0f1c17';
      ctx.fillRect(coverX, coverY, coverSize, coverSize);
      ctx.fillStyle = 'rgba(16, 185, 129, 0.55)';
      ctx.font = `900 220px ${STORY_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♪', centerX, coverY + coverSize / 2 + 10);
    }
    ctx.restore();

    ctx.save();
    roundRect(ctx, coverX, coverY, coverSize, coverSize, 48);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    // Título + artista (centrados y ajustados)
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    const title = fitCanvasLines(ctx, track.title || 'Canción', 880, 2, [58, 52, 46, 40], '800');
    const titleLineHeight = Math.round(title.size * 1.18);
    let cursorY = 920;
    ctx.fillStyle = '#ffffff';
    drawCenteredLines(ctx, title.lines, centerX, cursorY, titleLineHeight);
    cursorY += title.lines.length * titleLineHeight + 8;

    const artistText = String(track.artist || 'Artista desconocido').replace(/\s*-\s*Topic$/i, '');
    const artist = fitCanvasLines(ctx, artistText, 820, 1, [36, 32, 28], '600');
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    drawCenteredLines(ctx, artist.lines, centerX, cursorY + 30, 40);
    cursorY += 74;

    ctx.fillStyle = 'rgba(16, 185, 129, 0.9)';
    roundRect(ctx, centerX - 42, cursorY + 6, 84, 6, 3);
    ctx.fill();
    cursorY += 50;
    ctx.restore();

    // Verso principal
    const verseText = String(verse || track.title || '').trim();
    const verseFit = fitCanvasLines(ctx, verseText, 840, 4, [52, 47, 42, 38], '800');
    const verseLineHeight = Math.round(verseFit.size * 1.24);

    const hasNext = !!(nextVerse && nextVerse !== verseText);
    const nextFit = hasNext ? fitCanvasLines(ctx, nextVerse, 800, 2, [36, 32, 28], '600') : null;
    const nextLineHeight = nextFit ? Math.round(nextFit.size * 1.24) : 0;

    // El bloque de letra se centra en el espacio libre: un verso corto no deja
    // un hueco enorme entre la letra y la marca del pie.
    const blockTop = cursorY + 120;
    const blockBottom = 1690;
    const blockHeight = verseFit.lines.length * verseLineHeight
      + (nextFit ? 44 + nextFit.lines.length * nextLineHeight : 0);
    const verseY = blockTop + Math.max(0, (blockBottom - blockTop - blockHeight) / 2);

    // Comilla decorativa
    ctx.save();
    ctx.font = 'bold 130px Georgia, serif';
    ctx.fillStyle = 'rgba(16, 185, 129, 0.35)';
    ctx.textAlign = 'left';
    ctx.fillText('“', 112, verseY - 46);
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f4f4f5';
    drawCenteredLines(ctx, verseFit.lines, centerX, verseY, verseLineHeight);
    ctx.restore();

    // Segundo verso (siguiente línea de la letra)
    if (nextFit) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#34d399';
      drawCenteredLines(ctx, nextFit.lines, centerX, verseY + verseFit.lines.length * verseLineHeight + 44, nextLineHeight);
      ctx.restore();
    }

    // Pie de marca
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.font = `600 24px ${STORY_FONT}`;
    ctx.fillText('ESCUCHANDO EN', centerX, 1772);
    ctx.fillStyle = '#6ee7b7';
    ctx.font = `800 34px ${STORY_FONT}`;
    ctx.fillText(storyShareHost(), centerX, 1818);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.26)';
    ctx.font = `500 22px ${STORY_FONT}`;
    ctx.fillText('FreeSong · Reproductor web premium', centerX, 1858);
    ctx.restore();

    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  const storyShareState = { url: '', blob: null, file: null, filename: '', title: '', text: '' };

  function closeStoryShareModal() {
    const modal = $('storyShareModal');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    if (storyShareState.url) {
      URL.revokeObjectURL(storyShareState.url);
      storyShareState.url = '';
    }
    storyShareState.blob = null;
    storyShareState.file = null;
    popModalState();
  }

  function canShareStoryFile(file) {
    try {
      return !!(navigator.canShare && file && navigator.canShare({ files: [file] }));
    } catch {
      return false;
    }
  }

  function openStoryShareModal(blob, track, verse) {
    const modal = $('storyShareModal');
    if (!modal || !blob) return;

    if (storyShareState.url) URL.revokeObjectURL(storyShareState.url);
    const objectUrl = URL.createObjectURL(blob);
    const filename = `freesong-${track.id}-historia.png`;
    let file = blob;
    try {
      file = new File([blob], filename, { type: 'image/png' });
    } catch {}

    storyShareState.url = objectUrl;
    storyShareState.blob = blob;
    storyShareState.file = file;
    storyShareState.filename = filename;
    storyShareState.title = `${track.title} · FreeSong`;
    storyShareState.text = `"${verse}" — ${track.title} de ${track.artist || 'Artista'}\n${trackShareUrl(track)}`;

    const img = $('storySharePreview');
    if (img) img.src = objectUrl;

    const canNative = canShareStoryFile(file);
    const nativeBtn = $('storyShareNativeBtn');
    const downloadBtn = $('storyShareDownloadBtn');
    const hint = $('storyShareHint');
    if (nativeBtn) nativeBtn.classList.toggle('hidden', !canNative);
    if (downloadBtn) downloadBtn.classList.toggle('col-span-2', !canNative);
    if (hint) {
      hint.textContent = canNative
        ? 'Vista previa 1080 × 1920. Toca «Compartir» y elige Instagram, WhatsApp o TikTok.'
        : 'Vista previa 1080 × 1920. Descarga la imagen o mantén pulsada la vista previa para guardarla en Fotos.';
    }

    modal.classList.remove('hidden');
    pushModalState('storyShare');
    haptic('light');
  }

  async function shareStoryNative() {
    if (!storyShareState.file || !storyShareState.blob) return;
    try {
      if (!canShareStoryFile(storyShareState.file)) {
        downloadBlob(storyShareState.blob, storyShareState.filename);
        showToast('Imagen descargada para compartir');
        return;
      }
      await navigator.share({
        files: [storyShareState.file],
        title: storyShareState.title,
        text: storyShareState.text
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      showToast('No se pudo abrir Compartir. Usa «Descargar».', 3200);
    }
  }

  async function copyStoryImage() {
    if (!storyShareState.blob) return;
    try {
      if (!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem)) {
        throw new Error('sin soporte');
      }
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': storyShareState.blob })
      ]);
      showToast('✓ Imagen copiada al portapapeles');
    } catch {
      try {
        await navigator.clipboard.writeText(storyShareState.text);
        showToast('Texto copiado (la imagen no está disponible en este navegador)');
      } catch {
        showToast('No se pudo copiar la imagen');
      }
    }
  }

  async function shareLyricsCard() {
    const track = S.currentIndex >= 0 ? S.queue[S.currentIndex] : null;
    if (!track) {
      showToast('No hay ninguna canción sonando');
      return;
    }

    // Se comparte el verso que está sonando y, si existe, el siguiente.
    let line1 = '';
    let line2 = '';
    if (S.syncedLyrics && S.syncedLyrics.length > 0 && S.currentLyricIdx >= 0) {
      line1 = S.syncedLyrics[S.currentLyricIdx]?.text || '';
      line2 = S.syncedLyrics[S.currentLyricIdx + 1]?.text || '';
    }
    if (!line1) {
      const firstSynced = (S.syncedLyrics || []).find((l) => l && l.text && l.text.trim());
      line1 = firstSynced ? firstSynced.text : track.title;
      line2 = firstSynced ? '' : (track.artist || '');
    }

    showToast('Generando tarjeta de historia…', 1400);
    try {
      const blob = await buildStoryCard(track, line1, line2);
      if (!blob) throw new Error('sin imagen');
      openStoryShareModal(blob, track, line1);
    } catch {
      showToast('No se pudo generar la imagen de la historia');
    }
  }

  // --- Subpestaña "Similares" Robusta ---
  async function loadSimilarTracks(track, signal) {
    const container = $('similarList');
    if (!container) return;
    const targetTrack = track || S.queue[S.currentIndex];
    if (!targetTrack) return;

    container.innerHTML = '<p class="text-zinc-500 text-xs py-8 text-center animate-pulse">Buscando canciones similares...</p>';

    try {
      const q = targetTrack.artist && targetTrack.artist !== 'Artista'
        ? `${targetTrack.artist} exitos`
        : `${targetTrack.title} mix`;
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal });
      const data = await res.json();

      if (!data.tracks || data.tracks.length === 0) {
        container.innerHTML = '<p class="text-zinc-500 text-xs py-8 text-center">No se encontraron recomendaciones similares.</p>';
        return;
      }

      const filtered = data.tracks.filter((t) => t.id !== targetTrack.id).slice(0, 15);
      container.innerHTML = filtered.map((t, idx) => `
        <div class="flex items-center justify-between p-2 rounded-2xl hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition cursor-pointer press" data-similar-idx="${idx}">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <img src="${thumbAt(t.thumbnail, 160)}" data-vid="${esc(t.id)}" class="w-10 h-10 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" loading="lazy" />
            <div class="min-w-0 flex-1">
              <p class="text-xs font-bold text-white truncate">${esc(t.title)}</p>
              <p class="text-[10px] text-zinc-400 truncate">${esc(t.artist)}${t.durationText ? ` • ${t.durationText}` : ''}</p>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0 ml-2">
            <button data-add-queue-idx="${idx}" class="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-full hover:bg-emerald-500 hover:text-black transition press">
              + Cola
            </button>
            <div class="w-7 h-7 rounded-full bg-zinc-800 text-emerald-400 flex items-center justify-center press">
              <svg class="w-3.5 h-3.5"><use href="#i-play"/></svg>
            </div>
          </div>
        </div>
      `).join('');

      $$('[data-similar-idx]').forEach((el) => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-add-queue-idx]')) return;
          const idx = parseInt(el.getAttribute('data-similar-idx'), 10);
          const t = filtered[idx];
          if (t) {
            S.queue.push(t);
            playTrack(S.queue.length - 1, true);
          }
        });
      });

      $$('[data-add-queue-idx]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.getAttribute('data-add-queue-idx'), 10);
          const t = filtered[idx];
          if (t) {
            S.queue.push(t);
            renderQueue();
            showToast(`"${t.title}" agregada a la cola`);
            btn.textContent = '✓ Lista';
            btn.className = 'text-[10px] font-bold text-white bg-zinc-800 border border-zinc-700 px-2.5 py-1 rounded-full';
            setTimeout(() => {
              btn.textContent = '+ Cola';
              btn.className = 'text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-full hover:bg-emerald-500 hover:text-black transition press';
            }, 1800);
          }
        });
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      container.innerHTML = `
        <div class="text-center py-6 space-y-2">
          <p class="text-zinc-500 text-xs">Error al cargar recomendaciones</p>
          <button id="similarRetryBtn" class="text-xs font-bold text-emerald-400 border border-emerald-500/30 px-3 py-1 rounded-full press">Reintentar</button>
        </div>
      `;
      $('similarRetryBtn')?.addEventListener('click', () => loadSimilarTracks(targetTrack));
    }
  }

  // --- Subpestañas del Full Player ---
  function switchPlayerSubTab(tab) {
    S.activePlayerSubTab = tab;
    $('sheetTrackView').classList.toggle('hidden', tab !== 'track');
    $('sheetQueueView').classList.toggle('hidden', tab !== 'queue');
    $('sheetLyricsView').classList.toggle('hidden', tab !== 'lyrics');
    $('sheetSimilarView').classList.toggle('hidden', tab !== 'similar');

    const tabs = [
      { id: 'tabTrackBtn', name: 'track' },
      { id: 'tabQueueBtn', name: 'queue' },
      { id: 'tabLyricsBtn', name: 'lyrics' },
      { id: 'tabSimilarBtn', name: 'similar' }
    ];

    tabs.forEach(({ id, name }) => {
      const btn = $(id);
      if (!btn) return;
      btn.className = name === tab
        ? 'px-3 py-1 rounded-full bg-emerald-500 text-black font-bold transition shadow-sm'
        : 'px-3 py-1 rounded-full text-zinc-400 hover:text-white font-medium transition';
    });

    if (tab === 'queue') renderQueue();
    if (tab === 'lyrics') {
      const current = S.currentTrack;
      const key = lyricsCacheKey(current);
      if (current && key && lyricsLoadedKey !== key && lyricsLoadingKey !== key) {
        loadLyrics(current, null);
      }
      if (S.syncedLyrics.length) {
        const time = getCurrentPlaybackTime();
        if (time !== null) syncLyricsWithTime(time);
        startLyricsLoop();
        setTimeout(() => scrollLyricsTo(Math.max(0, S.currentLyricIdx), true), 60);
      }
    } else {
      stopLyricsLoop();
    }
    if (tab === 'similar') {
      const cur = S.queue[S.currentIndex];
      if (cur) {
        const list = $('similarList');
        if (!list || list.children.length <= 1 || list.innerText.includes('Cargando')) {
          loadSimilarTracks(cur);
        }
      }
    }
  }

  // --- Menú de Canción Completo ••• (Spotify Bottom Sheet) ---
  function openSongMenu(track) {
    const target = track || (S.currentIndex >= 0 ? S.queue[S.currentIndex] : null);
    if (!target) {
      showToast('Selecciona o reproduce una canción primero');
      return;
    }
    S.menuTargetTrack = target;

    setThumbSrc($('songMenuCover'), target, 160);
    $('songMenuTitle').textContent = target.title;
    $('songMenuArtist').textContent = target.artist || 'Artista';

    // Actualizar texto e icono de descarga en el menú
    const isDown = isDownloaded(target.id);
    const downTextEl = $('menuDownloadText');
    if (downTextEl) {
      downTextEl.textContent = isDown ? 'Eliminar de descargas' : 'Descargar canción offline';
    }

    // Actualizar botones de velocidad
    $$('.speed-opt-btn').forEach((btn) => {
      const spd = parseFloat(btn.getAttribute('data-speed'));
      const isActive = Math.abs(spd - S.playbackRate) < 0.05;
      btn.className = isActive
        ? 'speed-opt-btn py-2 px-2 rounded-xl bg-emerald-500/20 border border-emerald-500/50 text-xs font-bold text-emerald-400 press text-center'
        : 'speed-opt-btn py-2 px-2 rounded-xl bg-zinc-800/80 border border-zinc-700/60 text-xs font-semibold text-zinc-300 hover:text-white press text-center';
    });

    $('songMenuModal').classList.remove('hidden');
    pushModalState('songMenu');
  }

  function closeSongMenu() {
    const modal = $('songMenuModal');
    if (modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    popModalState();
  }

  function setPlaybackRate(rate) {
    S.playbackRate = rate;
    audioDecks.forEach((a) => {
      a.playbackRate = rate;
      a.preservesPitch = true;
    });
    showToast(`Velocidad: ${rate}x`);
    $$('.speed-opt-btn').forEach((btn) => {
      const spd = parseFloat(btn.getAttribute('data-speed'));
      const isActive = Math.abs(spd - rate) < 0.05;
      btn.className = isActive
        ? 'speed-opt-btn py-2 px-2 rounded-xl bg-emerald-500/20 border border-emerald-500/50 text-xs font-bold text-emerald-400 press text-center'
        : 'speed-opt-btn py-2 px-2 rounded-xl bg-zinc-800/80 border border-zinc-700/60 text-xs font-semibold text-zinc-300 hover:text-white press text-center';
    });
  }

  async function startArtistRadio(artist, trackId = null) {
    showToast(trackId ? 'Creando radio de esta canción...' : `Creando Radio de ${artist}...`);
    try {
      let tracks = [];
      if (trackId) {
        const res = await fetch(`/api/queue?id=${encodeURIComponent(trackId)}`);
        const data = await res.json();
        tracks = data.tracks || [];
      } else {
        const res = await fetch(`/api/artist?name=${encodeURIComponent(artist)}`);
        const data = await res.json();
        tracks = data.topSongs || data.tracks || [];
      }

      if (tracks.length > 0) {
        S.queue = [...tracks];
        playTrack(0, true);
        showToast(trackId
          ? `Radio iniciada (${S.queue.length} canciones)`
          : `Radio de ${artist} iniciada (${S.queue.length} canciones)`);
      } else {
        showToast('No se pudieron obtener pistas para la radio');
      }
    } catch {
      showToast('Error al iniciar la radio');
    }
  }

  function shareTrack(track) {
    if (!track) return;
    const shareData = {
      title: track.title,
      text: `Escucha "${track.title}" de ${track.artist} en FreeSong`,
      url: `${window.location.origin}/?track=${encodeURIComponent(track.id)}`
    };

    if (navigator.share) {
      navigator.share(shareData).catch(() => {});
    } else {
      navigator.clipboard.writeText(shareData.url).then(() => {
        showToast('Enlace copiado al portapapeles');
      }).catch(() => {
        showToast('Enlace: ' + shareData.url);
      });
    }
  }

  // --- Vista / Perfil del Artista Completo (Estilo Spotify) ---
  let currentArtistTracks = [];

  function parseArtistCollabs(rawName) {
    if (!rawName) return [];
    const clean = rawName.replace(/\s*-\s*Topic$/i, '').trim();
    // Separar por comas, &, " y ", " and ", feat., ft., etc.
    const parts = clean
      .split(/[,&/|]|\by\b|\band\b|\bfeat\.?\b|\bft\.?\b/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== 'Artista' && s !== 'FreeSong Music');
    return parts.length > 0 ? parts : [clean];
  }

  function closeArtistProfile() {
    const modal = $('artistViewModal');
    if (modal && !modal.classList.contains('hidden')) {
      modal.classList.add('hidden');
      popModalState();
    }
  }
  window.closeArtistProfile = closeArtistProfile;

  async function openArtistPage(rawArtistName, artistThumb = '') {
    if (!rawArtistName) return;
    const allArtists = parseArtistCollabs(rawArtistName);
    const primaryArtist = allArtists[0] || rawArtistName.replace(/\s*-\s*Topic$/i, '').trim();
    if (!primaryArtist || primaryArtist === 'Artista' || primaryArtist === 'FreeSong Music') return;

    const modal = $('artistViewModal');
    if (!modal) return;
    // Si ya estaba abierto (artista → artista) no se agrega otra entrada de historial
    if (modal.classList.contains('hidden')) pushModalState('artist');
    modal.classList.remove('hidden');
    modal.scrollTop = 0;

    $('artistTopBarTitle').textContent = primaryArtist;
    $('artistHeroName').textContent = primaryArtist;
    if (artistThumb) {
      $('artistHeroImg').src = thumbAt(artistThumb, 720);
    } else {
      $('artistHeroImg').src = 'icons/icon-512.png';
    }

    // Renderizar chips de colaboración si hay más de 1 artista
    const chipsEl = $('artistCollabChips');
    if (chipsEl) {
      if (allArtists.length > 1) {
        chipsEl.classList.remove('hidden');
        chipsEl.innerHTML = allArtists.map((art) => {
          const isCurrent = art.toLowerCase() === primaryArtist.toLowerCase();
          return `
            <button data-collab-artist="${esc(art)}" class="px-3 py-1 rounded-full text-xs font-bold transition shrink-0 ${
              isCurrent
                ? 'bg-emerald-500 text-black shadow-md'
                : 'bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700'
            }">
              ${esc(art)}
            </button>
          `;
        }).join('');

        $$('[data-collab-artist]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const chosen = btn.getAttribute('data-collab-artist');
            openArtistPage(chosen);
          });
        });
      } else {
        chipsEl.classList.add('hidden');
        chipsEl.innerHTML = '';
      }
    }

    const topListEl = $('artistTopTracksList');
    topListEl.innerHTML = `<div class="py-10 text-center text-zinc-500 text-xs animate-pulse">Cargando éxitos de ${primaryArtist}...</div>`;
    const simListEl = $('artistSimilarList');
    simListEl.innerHTML = '';

    try {
      const isBrowseId = String(rawArtistName).startsWith('UC');
      const res = await fetch(`/api/artist?${isBrowseId ? 'id=' : 'name='}${encodeURIComponent(rawArtistName)}`);
      const data = await res.json();
      const tracks = data.topSongs || data.tracks || [];
      const albums = [...(data.albums || []), ...(data.singles || [])];
      const similar = data.similar || [];
      currentArtistTracks = tracks;

      if (data.artist) {
        if (data.artist.name) {
          $('artistHeroName').textContent = data.artist.name;
          $('artistTopBarTitle').textContent = data.artist.name;
        }
        if (data.artist.thumbnail) {
          $('artistHeroImg').src = thumbAt(data.artist.thumbnail, 720);
        }
      }

      if (tracks.length === 0) {
        topListEl.innerHTML = `<p class="py-8 text-center text-zinc-500 text-xs">No se encontraron canciones de ${primaryArtist}</p>`;
      } else {
        if (!artistThumb && !data.artist?.thumbnail && tracks[0]?.thumbnail) {
          $('artistHeroImg').src = thumbAt(tracks[0].thumbnail, 720);
        }

        topListEl.innerHTML = tracks.map((t, idx) => `
          <div class="flex items-center justify-between p-2 rounded-2xl bg-zinc-900/50 hover:bg-zinc-800/80 border border-zinc-800/50 transition cursor-pointer press group" data-artist-track-idx="${idx}">
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <span class="w-5 text-center text-xs font-black ${idx === 0 ? 'text-emerald-400' : 'text-zinc-500'} shrink-0">${idx + 1}</span>
              <img src="${thumbAt(t.thumbnail, 160)}" data-vid="${esc(t.id)}" class="w-11 h-11 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" loading="lazy" />
              <div class="min-w-0 flex-1">
                <p class="text-xs font-bold text-white truncate">${esc(t.title)}</p>
                <div class="flex items-center gap-1.5 mt-0.5">
                  ${isDownloaded(t.id) ? '<span class="text-[10px] text-emerald-400 font-bold">✓</span>' : ''}
                  <p class="text-[10px] text-zinc-400 truncate">${esc(t.artist)}${t.durationText ? ` • ${t.durationText}` : ''}</p>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-1 shrink-0 ml-2">
              <button data-artist-download="${idx}" class="p-1.5 text-zinc-400 hover:text-emerald-400 press" title="Descargar">
                <svg class="w-4 h-4"><use href="${isDownloaded(t.id) ? '#i-download-done' : '#i-download'}"/></svg>
              </button>
              <button data-artist-more="${idx}" class="p-1.5 text-zinc-400 hover:text-white press" aria-label="Opciones">
                <svg class="w-4 h-4"><use href="#i-more"/></svg>
              </button>
              <div class="w-8 h-8 rounded-full bg-zinc-800 group-hover:bg-emerald-500 group-hover:text-black text-emerald-400 flex items-center justify-center transition shadow-sm">
                <svg class="w-3.5 h-3.5"><use href="#i-play"/></svg>
              </div>
            </div>
          </div>
        `).join('');

        $$('[data-artist-track-idx]').forEach((el) => {
          el.addEventListener('click', (e) => {
            if (e.target.closest('[data-artist-more]') || e.target.closest('[data-artist-download]')) return;
            const i = parseInt(el.getAttribute('data-artist-track-idx'), 10);
            S.queue = [...tracks];
            playTrack(i, true);
          });
        });

        $$('[data-artist-more]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const i = parseInt(btn.getAttribute('data-artist-more'), 10);
            openSongMenu(tracks[i]);
          });
        });

        $$('[data-artist-download]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const i = parseInt(btn.getAttribute('data-artist-download'), 10);
            toggleDownload(tracks[i]);
          });
        });
      }

      // Renderizar Álbumes y Singles
      const albumsListEl = $('artistAlbumsList');
      const albumsSectionEl = $('artistAlbumsSection');
      if (albumsListEl) {
        if (albums.length > 0) {
          if (albumsSectionEl) albumsSectionEl.classList.remove('hidden');
          albumsListEl.innerHTML = albums.map((alb) => `
            <div class="p-3 rounded-2xl bg-zinc-900/60 hover:bg-zinc-800/90 border border-zinc-800/60 transition cursor-pointer press flex flex-col justify-between group" data-album-id="${alb.id}" data-album-title="${esc(alb.title)}">
              <div class="aspect-square rounded-xl overflow-hidden bg-zinc-800 mb-2 relative shadow-md">
                <img src="${thumbAt(alb.thumbnail || 'icons/icon-192.png', 480)}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" loading="lazy" />
              </div>
              <div class="min-w-0">
                <p class="text-xs font-bold text-white truncate group-hover:text-emerald-400 transition">${esc(alb.title)}</p>
                <p class="text-[10px] text-zinc-400 truncate mt-0.5">${esc(alb.year || 'Álbum')}</p>
              </div>
            </div>
          `).join('');

          $$('[data-album-id]').forEach((el) => {
            el.addEventListener('click', () => {
              const aId = el.getAttribute('data-album-id');
              const aTitle = el.getAttribute('data-album-title');
              openCollection('album', aId, aTitle);
            });
          });
        } else if (albumsSectionEl) {
          albumsSectionEl.classList.add('hidden');
        }
      }

      // Fans también escuchan
      if (simListEl) {
        const simToShow = similar.length > 0 ? similar : [
          { name: 'Feid', subscribers: 'Artista similar' },
          { name: 'Karol G', subscribers: 'Artista similar' },
          { name: 'Bad Bunny', subscribers: 'Artista similar' },
          { name: 'Rauw Alejandro', subscribers: 'Artista similar' },
          { name: 'Quevedo', subscribers: 'Artista similar' }
        ].filter(a => a.name.toLowerCase() !== primaryArtist.toLowerCase());

        simListEl.innerHTML = simToShow.map((art) => `
          <div class="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800/60 transition cursor-pointer press group" data-similar-artist="${art.name}">
            <div class="flex items-center gap-3">
              ${art.thumbnail ? `
                <img src="${thumbAt(art.thumbnail, 160)}" class="w-10 h-10 rounded-full object-cover bg-zinc-800 shadow-md" loading="lazy" />
              ` : `
                <div class="w-10 h-10 rounded-full bg-gradient-to-tr from-emerald-500 to-sky-500 flex items-center justify-center text-black font-black text-xs shadow-md">
                  ${art.name.slice(0, 2).toUpperCase()}
                </div>
              `}
              <div>
                <p class="text-xs font-bold text-white group-hover:text-emerald-400 transition">${esc(art.name)}</p>
                <p class="text-[10px] text-zinc-400">${esc(art.subscribers || 'Artista similar')}</p>
              </div>
            </div>
            <svg class="w-4 h-4 text-zinc-500 group-hover:text-white transition"><use href="#i-down" style="transform: rotate(-90deg);"/></svg>
          </div>
        `).join('');

        $$('[data-similar-artist]').forEach((el) => {
          el.addEventListener('click', () => {
            const name = el.getAttribute('data-similar-artist');
            openArtistPage(name);
          });
        });
      }

    } catch (err) {
      topListEl.innerHTML = `<p class="py-8 text-center text-zinc-500 text-xs">Error al cargar información del artista</p>`;
    }
  }

  function openArtistProfile(artistName, artistThumb = '') {
    return openArtistPage(artistName, artistThumb);
  }
  window.openArtistProfile = openArtistProfile;
  window.openArtistPage = openArtistPage;

  // --- Vista de Colección Completa: Álbumes y Playlists (SimpMusic Engine) ---
  let currentCollectionTracks = [];

  function closeCollection() {
    const modal = $('collectionModal');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    popModalState();
  }
  window.closeCollection = closeCollection;

  async function openCollection(type, browseId, titleFallback = '') {
    if (!browseId) return;
    const modal = $('collectionModal');
    if (!modal) return;
    if (modal.classList.contains('hidden')) pushModalState('collection');
    modal.classList.remove('hidden');
    modal.scrollTop = 0;

    const isAlbum = type === 'album';
    $('collectionTypeBadge').textContent = isAlbum ? 'Álbum' : 'Playlist';
    $('collectionTopBarTitle').textContent = titleFallback || (isAlbum ? 'Álbum' : 'Playlist');
    $('collectionHeroTitle').textContent = titleFallback || (isAlbum ? 'Cargando álbum...' : 'Cargando playlist...');
    $('collectionHeroSubtitle').textContent = 'YouTube Music';
    $('collectionTrackCount').textContent = 'Cargando pistas...';
    $('collectionTracksList').innerHTML = '<div class="py-12 text-center text-zinc-500 text-xs animate-pulse">Obteniendo catálogo completo...</div>';

    try {
      const endpoint = isAlbum
        ? `/api/album?id=${encodeURIComponent(browseId)}`
        : `/api/playlist?id=${encodeURIComponent(browseId)}`;
      const res = await fetch(endpoint);
      const data = await res.json();

      const meta = isAlbum ? data.album : data.playlist;
      const tracks = data.tracks || [];
      currentCollectionTracks = tracks;

      if (meta) {
        $('collectionHeroTitle').textContent = meta.title || titleFallback;
        $('collectionHeroSubtitle').textContent = isAlbum
          ? `${meta.artist || 'Artista'}${meta.year ? ' • ' + meta.year : ''}`
          : `${meta.author || 'YouTube Music'}`;
        $('collectionTrackCount').textContent = `${tracks.length} canciones`;
        if (meta.thumbnail) {
          $('collectionHeroImg').src = thumbAt(meta.thumbnail, 720);
        }
      }

      if (tracks.length === 0) {
        $('collectionTracksList').innerHTML = '<div class="py-12 text-center text-zinc-500 text-xs">No se encontraron pistas en esta colección</div>';
        return;
      }

      prewarmTracks(tracks.slice(0, 4));

      $('collectionTracksList').innerHTML = tracks.map((t, idx) => `
        <div class="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/50 hover:bg-zinc-800/80 border border-zinc-800/50 transition cursor-pointer press group" data-coll-idx="${idx}">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <span class="w-5 text-center text-xs font-black ${idx === 0 ? 'text-emerald-400' : 'text-zinc-500'} shrink-0">${idx + 1}</span>
            <img src="${thumbAt(t.thumbnail, 160)}" data-vid="${esc(t.id)}" class="w-11 h-11 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" loading="lazy" />
            <div class="min-w-0 flex-1">
              <p class="text-xs font-bold text-white truncate">${esc(t.title)}</p>
              <div class="flex items-center gap-1.5 mt-0.5">
                ${isDownloaded(t.id) ? '<span class="text-[10px] text-emerald-400 font-bold">✓</span>' : ''}
                <p class="text-[10px] text-zinc-400 truncate">${esc(t.artist)}${t.durationText ? ` • ${t.durationText}` : ''}</p>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0 ml-2">
            <button data-coll-down="${idx}" class="p-1.5 text-zinc-400 hover:text-emerald-400 press" title="Descargar">
              <svg class="w-4 h-4"><use href="${isDownloaded(t.id) ? '#i-download-done' : '#i-download'}"/></svg>
            </button>
            <button data-coll-more="${idx}" class="p-1.5 text-zinc-400 hover:text-white press" aria-label="Opciones">
              <svg class="w-4 h-4"><use href="#i-more"/></svg>
            </button>
            <div class="w-8 h-8 rounded-full bg-zinc-800 group-hover:bg-emerald-500 group-hover:text-black text-emerald-400 flex items-center justify-center transition shadow-sm">
              <svg class="w-3.5 h-3.5"><use href="#i-play"/></svg>
            </div>
          </div>
        </div>
      `).join('');

      $$('[data-coll-idx]').forEach((el) => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-coll-more]') || e.target.closest('[data-coll-down]')) return;
          const i = parseInt(el.getAttribute('data-coll-idx'), 10);
          S.queue = [...tracks];
          playTrack(i, true);
        });
      });

      $$('[data-coll-more]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const i = parseInt(btn.getAttribute('data-coll-more'), 10);
          openSongMenu(tracks[i]);
        });
      });

      $$('[data-coll-down]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const i = parseInt(btn.getAttribute('data-coll-down'), 10);
          toggleDownload(tracks[i]);
        });
      });

    } catch (err) {
      $('collectionTracksList').innerHTML = '<div class="py-12 text-center text-zinc-500 text-xs">Error al cargar la colección</div>';
    }
  }
  window.openCollection = openCollection;

  // --- Actualizaciones de Interfaz y Like ---
  function showAndSyncMiniPlayer(track, isLoading = false) {
    const mini = $('miniPlayer');
    if (!mini || !track) return;

    mini.classList.remove('hidden', 'translate-y-full', 'opacity-0', 'pointer-events-none');
    mini.style.display = 'flex';

    const miniCover = $('miniCover');
    if (miniCover) setThumbSrc(miniCover, track, 160);
    const miniTitle = $('miniTitle');
    if (miniTitle) miniTitle.textContent = track.title || 'Canción';
    const miniArtist = $('miniArtist');
    if (miniArtist) miniArtist.textContent = track.artist || 'Artista';

    updateLikeButton(track);
    updatePlayPauseIcons(S.isPlaying, isLoading);
  }

  function openFullPlayer() {
    const sheet = $('fullPlayerSheet');
    if (!sheet.classList.contains('translate-y-full')) return;
    // Limpia cualquier transform inline que haya dejado el gesto de arrastre.
    sheet.style.transition = '';
    sheet.style.transform = '';
    sheet.classList.remove('translate-y-full');
    pushModalState('player');
    haptic('light');
    if (S.activePlayerSubTab === 'lyrics') {
      setTimeout(() => {
        if (!isLyricsVisible()) return;
        const time = getCurrentPlaybackTime();
        if (time !== null) syncLyricsWithTime(time);
        startLyricsLoop();
        scrollLyricsTo(Math.max(0, S.currentLyricIdx), true);
      }, 340);
    }
  }

  function closeFullPlayer() {
    stopLyricsLoop();
    const sheet = $('fullPlayerSheet');
    if (!sheet.classList.contains('translate-y-full')) {
      sheet.classList.add('translate-y-full');
      popModalState();
    }
    sheet.style.transition = '';
    sheet.style.transform = '';
    const cur = S.queue[S.currentIndex] || S.currentTrack;
    if (cur) {
      showAndSyncMiniPlayer(cur, false);
    }
  }

  function updatePlayerUI(track) {
    showAndSyncMiniPlayer(track, false);

    $('playerTitle').textContent = track.title;
    $('playerArtist').textContent = track.artist || 'Artista';
    // 720 px: nítido en pantallas Retina sin descargar una imagen enorme.
    setThumbSrc($('playerCover'), track, 720);

    updateLikeButton(track);
    updateDownloadButton(track);
    renderQueue();
  }

  function updatePlayPauseIcons(playing, isLoading = false) {
    const playSvg = '<svg class="w-5 h-5"><use href="#i-play"/></svg>';
    const pauseSvg = '<svg class="w-5 h-5"><use href="#i-pause"/></svg>';
    const spinnerSvg = '<svg class="w-5 h-5 animate-spin text-emerald-400"><use href="#i-spinner"/></svg>';

    const bigPlaySvg = '<svg class="w-8 h-8"><use href="#i-play"/></svg>';
    const bigPauseSvg = '<svg class="w-8 h-8"><use href="#i-pause"/></svg>';
    const bigSpinnerSvg = '<svg class="w-8 h-8 animate-spin text-emerald-400"><use href="#i-spinner"/></svg>';

    const miniPlayBtn = $('miniPlayBtn');
    if (miniPlayBtn) {
      miniPlayBtn.innerHTML = isLoading ? spinnerSvg : (playing ? pauseSvg : playSvg);
    }
    const playerPlayBtn = $('playerPlayBtn');
    if (playerPlayBtn) {
      playerPlayBtn.innerHTML = isLoading ? bigSpinnerSvg : (playing ? bigPauseSvg : bigPlaySvg);
    }

    const miniEq = $('miniEq');
    if (miniEq) miniEq.style.display = (playing && !isLoading) ? 'flex' : 'none';
  }

  function updateLikeButton(track) {
    const isLiked = track && S.favorites.some((f) => f.id === track.id);
    const likeSvg = isLiked
      ? '<svg class="w-6 h-6 text-emerald-400"><use href="#i-heart-fill"/></svg>'
      : '<svg class="w-6 h-6 text-zinc-300"><use href="#i-heart"/></svg>';
    const miniLikeSvg = isLiked
      ? '<svg class="w-5 h-5 text-emerald-400"><use href="#i-heart-fill"/></svg>'
      : '<svg class="w-5 h-5 text-zinc-400"><use href="#i-heart"/></svg>';

    $('playerLikeBtn').innerHTML = likeSvg;
    $('miniLikeBtn').innerHTML = miniLikeSvg;
  }

  function toggleLike(track) {
    if (!track) return;
    const idx = S.favorites.findIndex((f) => f.id === track.id);
    if (idx >= 0) {
      S.favorites.splice(idx, 1);
      haptic('light');
      showToast('Eliminada de Tus Me Gusta');
    } else {
      S.favorites.unshift(track);
      haptic('success');
      showToast('Agregada a Tus Me Gusta ❤️');
    }
    localStorage.setItem('fs_favorites', JSON.stringify(S.favorites));
    updateLikeButton(track);
    renderLibrary();
  }

  // --- Registro de Historial y Estadísticas (Tu Cápsula Sonora / Spotify Wrapped) ---
  function saveHistory(track) {
    S.history = [track, ...S.history.filter((h) => h.id !== track.id)].slice(0, 50);
    localStorage.setItem('fs_history', JSON.stringify(S.history));
  }

  function recordPlayStat(track) {
    if (!track) return;
    S.stats.totalPlays = (S.stats.totalPlays || 0) + 1;

    // Conteo por canción
    if (!S.stats.songs) S.stats.songs = {};
    if (!S.stats.songs[track.id]) {
      S.stats.songs[track.id] = { track, count: 0 };
    }
    S.stats.songs[track.id].count++;

    // Conteo por artista
    const artist = track.artist || 'Artista';
    if (!S.stats.artists) S.stats.artists = {};
    S.stats.artists[artist] = (S.stats.artists[artist] || 0) + 1;

    localStorage.setItem('fs_stats', JSON.stringify(S.stats));
  }

  function renderStats() {
    $('statTotalPlays').textContent = S.stats.totalPlays || 0;

    // Buscar Artista #1
    let topArtist = 'Sin datos';
    let topArtistPlays = 0;
    if (S.stats.artists) {
      for (const [artist, count] of Object.entries(S.stats.artists)) {
        if (count > topArtistPlays) {
          topArtist = artist;
          topArtistPlays = count;
        }
      }
    }
    $('statTopArtist').textContent = topArtist;
    $('statTopArtistPlays').textContent = `${topArtistPlays} reproducciones`;

    // Buscar Top 5 canciones
    const topTracksContainer = $('statTopTracksList');
    if (!topTracksContainer) return;

    const songsArray = Object.values(S.stats.songs || {});
    songsArray.sort((a, b) => b.count - a.count);
    const top5 = songsArray.slice(0, 5);

    if (top5.length === 0) {
      topTracksContainer.innerHTML = '<p class="text-zinc-500 text-xs py-4 text-center">Escucha más canciones para generar tu Cápsula Sonora.</p>';
      return;
    }

    topTracksContainer.innerHTML = top5.map(({ track: t, count }, idx) => `
      <div class="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/80 border border-zinc-800/80 hover:bg-zinc-800 transition cursor-pointer press" data-stat-idx="${idx}">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <span class="w-5 text-center text-sm font-black text-emerald-400 shrink-0">#${idx + 1}</span>
          <img src="${thumbAt(t.thumbnail, 160)}" data-vid="${esc(t.id)}" class="w-11 h-11 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-white truncate">${esc(t.title)}</p>
            <p class="text-[10px] text-zinc-400 truncate">${esc(t.artist)} • ${count} veces</p>
          </div>
        </div>
        <div class="w-8 h-8 rounded-full bg-emerald-500 text-black flex items-center justify-center shrink-0 ml-2 shadow-md">
          <svg class="w-4 h-4"><use href="#i-play"/></svg>
        </div>
      </div>
    `).join('');

    $$('[data-stat-idx]').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.getAttribute('data-stat-idx'), 10);
        const item = top5[idx];
        if (item) {
          S.queue = top5.map((x) => x.track);
          playTrack(idx, true);
        }
      });
    });
  }

  // --- Renderizado de la Cola (Siguiente) ---
  function moveQueueItem(from, to) {
    if (from === to) return false;
    if (from < 0 || from >= S.queue.length || to < 0 || to >= S.queue.length) return false;
    const current = S.queue[S.currentIndex];
    const [item] = S.queue.splice(from, 1);
    S.queue.splice(to, 0, item);
    // Reubicar el índice de la pista que suena sin tocar el audio.
    if (current) S.currentIndex = S.queue.indexOf(current);
    return true;
  }

  function removeQueueAt(index) {
    if (index < 0 || index >= S.queue.length) return;
    if (index === S.currentIndex) {
      showToast('No puedes quitar la canción que está sonando');
      return;
    }
    S.queue.splice(index, 1);
    if (index < S.currentIndex) S.currentIndex--;
    renderQueue();
    saveSession(true);
    haptic('light');
  }

  function renderQueue() {
    const container = $('queueList');
    const nowPlayingWrap = $('queueNowPlaying');
    const countEl = $('queueTotalCount');

    if (countEl) {
      countEl.textContent = `${Math.max(0, S.queue.length - 1 - S.currentIndex)} restantes`;
    }

    if (nowPlayingWrap) {
      if (S.currentIndex >= 0 && S.currentIndex < S.queue.length) {
        const t = S.queue[S.currentIndex];
        nowPlayingWrap.innerHTML = `
          <img src="${thumbAt(t.thumbnail, 160)}" data-vid="${esc(t.id)}" class="w-11 h-11 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-md" />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-emerald-400 truncate">${esc(t.title)}</p>
            <div class="flex items-center gap-1.5 mt-0.5">
              ${isDownloaded(t.id) ? '<span class="text-[10px] text-emerald-400 font-bold" title="Descargada">✓</span>' : ''}
              <p class="text-[11px] text-zinc-400 truncate">${esc(t.artist)}${t.durationText ? ` • ${t.durationText}` : ''}</p>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span class="text-[10px] font-bold text-emerald-400">Sonando</span>
          </div>
        `;
      } else {
        nowPlayingWrap.innerHTML = '<p class="text-zinc-500 text-xs">Sin canción sonando</p>';
      }
    }

    if (!container) return;
    if (S.queue.length <= 1) {
      container.innerHTML = '<p class="text-zinc-500 text-xs py-4 text-center">No hay más canciones en la cola</p>';
      return;
    }

    const upcoming = S.queue.map((t, idx) => ({ track: t, idx })).filter((x) => x.idx > S.currentIndex);
    if (upcoming.length === 0) {
      container.innerHTML = '<p class="text-zinc-500 text-xs py-4 text-center">Fin de la cola. Autoplay añadirá más recomendaciones en breve.</p>';
      return;
    }

    container.innerHTML = upcoming.map(({ track: t, idx }) => `
      <div class="queue-row flex items-center justify-between p-2 rounded-xl hover:bg-zinc-900 border border-transparent cursor-pointer press" data-queue-idx="${idx}">
        <button type="button" data-queue-drag="${idx}" class="queue-drag-handle shrink-0 mr-1 text-zinc-500 hover:text-emerald-400 press" aria-label="Mantén pulsado y arrastra para reordenar" title="Arrastrar para reordenar">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>
            <circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>
            <circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>
          </svg>
        </button>
        <img src="${thumbAt(t.thumbnail, 160)}" data-vid="${esc(t.id)}" alt="" class="w-9 h-9 rounded-lg object-cover bg-zinc-800 shrink-0" loading="lazy" />
        <div class="min-w-0 flex-1 ml-2.5">
          <p class="text-xs font-bold text-white truncate">${esc(t.title)}</p>
          <div class="flex items-center gap-1.5 mt-0.5">
            ${isDownloaded(t.id) ? '<span class="text-[10px] text-emerald-400 font-bold">✓</span>' : ''}
            <p class="text-[10px] text-zinc-400 truncate">${esc(t.artist)}${t.durationText ? ` • ${t.durationText}` : ''}</p>
          </div>
        </div>
        <div class="flex items-center gap-0.5 shrink-0 ml-2">
          <button data-queue-more="${idx}" class="p-1.5 text-zinc-400 hover:text-white press" aria-label="Opciones">
            <svg class="w-4 h-4"><use href="#i-more"/></svg>
          </button>
          <button data-queue-del="${idx}" aria-label="Quitar de la cola" class="p-1.5 text-zinc-500 hover:text-red-400 press">
            <svg class="w-4 h-4"><use href="#i-close"/></svg>
          </button>
        </div>
      </div>
    `).join('');

    $$('[data-queue-idx]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (Date.now() < queueClickSuppressUntil) return;
        if (e.target.closest('[data-queue-del]') || e.target.closest('[data-queue-more]') || e.target.closest('[data-queue-drag]')) return;
        const i = parseInt(el.getAttribute('data-queue-idx'), 10);
        playTrack(i, true);
      });
    });

    $$('[data-queue-more]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = parseInt(btn.getAttribute('data-queue-more'), 10);
        openSongMenu(S.queue[i]);
      });
    });

    $$('[data-queue-del]').forEach((delBtn) => {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = parseInt(delBtn.getAttribute('data-queue-del'), 10);
        removeQueueAt(i);
      });
    });
  }

  // --- Gestos de la cola: arrastrar para reordenar y deslizar a la izquierda para quitar ---
  let queueClickSuppressUntil = 0;
  let queueGesturesBound = false;

  function setupQueueGestures() {
    const container = $('queueList');
    if (!container || queueGesturesBound) return;
    queueGesturesBound = true;

    let drag = null;

    container.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('[data-queue-drag]');
      if (!handle) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const row = handle.closest('[data-queue-idx]');
      if (!row) return;
      drag = {
        row,
        handle,
        fromIdx: parseInt(row.getAttribute('data-queue-idx'), 10),
        targetIdx: parseInt(row.getAttribute('data-queue-idx'), 10),
        startY: e.clientY,
        pointerId: e.pointerId,
        moved: false
      };
      try { handle.setPointerCapture(e.pointerId); } catch {}
      row.classList.add('queue-row-dragging');
      e.preventDefault();
    });

    container.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dy) > 4) drag.moved = true;
      drag.row.style.transform = `translateY(${dy}px)`;
      // La fila arrastrada sigue al dedo, así que no puede ser su propio destino:
      // se busca la fila cuyo rango vertical contiene el puntero (ignorándola).
      const siblings = Array.from(container.querySelectorAll('[data-queue-idx]')).filter((r) => r !== drag.row);
      let hit = siblings.find((r) => {
        const b = r.getBoundingClientRect();
        return e.clientY >= b.top && e.clientY <= b.bottom;
      });
      if (!hit && siblings.length) {
        // Fuera de la lista: elige la fila más cercana al puntero.
        hit = siblings.reduce((best, r) => {
          const b = r.getBoundingClientRect();
          const dist = Math.abs(e.clientY - (b.top + b.height / 2));
          return !best || dist < best.dist ? { r, dist } : best;
        }, null)?.r;
      }
      if (hit) {
        const idx = parseInt(hit.getAttribute('data-queue-idx'), 10);
        if (idx !== drag.targetIdx) {
          drag.targetIdx = idx;
          siblings.forEach((r) => r.classList.remove('queue-drop-target'));
          hit.classList.add('queue-drop-target');
        }
      }
    });

    const finishDrag = (e) => {
      if (!drag) return;
      if (e && e.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
      const { row, fromIdx, targetIdx, moved } = drag;
      drag = null;
      row.style.transform = '';
      row.classList.remove('queue-row-dragging');
      container.querySelectorAll('[data-queue-idx]').forEach((r) => r.classList.remove('queue-drop-target'));
      if (!moved) return;
      queueClickSuppressUntil = Date.now() + 350;
      if (targetIdx === fromIdx || targetIdx <= S.currentIndex) return;
      if (moveQueueItem(fromIdx, targetIdx)) {
        haptic('medium');
        renderQueue();
        saveSession(true);
        showToast('Cola reordenada');
      }
    };

    container.addEventListener('pointerup', finishDrag);
    container.addEventListener('pointercancel', finishDrag);

    // Deslizar una fila a la izquierda para quitarla de la cola.
    let swipe = null;

    container.addEventListener('touchstart', (e) => {
      if (!e.touches || !e.touches.length) return;
      const row = e.target.closest('[data-queue-idx]');
      if (!row || e.target.closest('button')) return;
      const t = e.touches[0];
      swipe = { row, x: t.clientX, y: t.clientY, active: false };
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (!swipe || !e.touches || !e.touches.length) return;
      const t = e.touches[0];
      const dx = t.clientX - swipe.x;
      const dy = t.clientY - swipe.y;
      if (!swipe.active) {
        if (Math.abs(dx) < 10) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.4) {
          swipe = null;
          return;
        }
        swipe.active = true;
        swipe.row.style.transition = 'none';
      }
      if (dx < 0) swipe.row.style.transform = `translateX(${Math.max(dx, -110)}px)`;
    }, { passive: true });

    container.addEventListener('touchend', (e) => {
      if (!swipe) return;
      const { row, active } = swipe;
      const endX = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : swipe.x;
      const dx = endX - swipe.x;
      swipe = null;
      row.style.transition = '';
      if (!active) return;
      queueClickSuppressUntil = Date.now() + 350;
      if (dx < -70) {
        const idx = parseInt(row.getAttribute('data-queue-idx'), 10);
        row.style.transform = 'translateX(-110%)';
        row.style.opacity = '0';
        haptic('light');
        setTimeout(() => removeQueueAt(idx), 150);
      } else {
        row.style.transform = '';
      }
    });
  }

  // --- Biblioteca Avanzada: Filtros, Ordenación y Playlists ---
  function libraryQuery() {
    return String(S.libSearch || '').trim().toLowerCase();
  }

  function matchesLibraryQuery(track, q) {
    if (!q) return true;
    const haystack = `${track?.title || ''} ${track?.artist || ''}`.toLowerCase();
    return haystack.includes(q);
  }

  function getFilteredLibraryTracks() {
    let list = [];
    if (S.libFilter === 'history') {
      list = [...S.history];
    } else if (S.libFilter === 'downloads') {
      list = [...S.downloads];
    } else {
      list = [...S.favorites];
    }

    if (S.libSort === 'title') {
      list.sort((a, b) => a.title.localeCompare(b.title));
    } else if (S.libSort === 'artist') {
      list.sort((a, b) => (a.artist || '').localeCompare(b.artist || ''));
    }

    const q = libraryQuery();
    if (q) list = list.filter((t) => matchesLibraryQuery(t, q));
    return list;
  }

  function renderLibrary() {
    $('libLikedList').classList.toggle('hidden', S.libFilter !== 'likes');
    $('libDownloadsList')?.classList.toggle('hidden', S.libFilter !== 'downloads');
    $('libHistoryList').classList.toggle('hidden', S.libFilter !== 'history');
    $('libPlaylistsWrap').classList.toggle('hidden', S.libFilter !== 'playlists');
    $('libStatsWrap').classList.toggle('hidden', S.libFilter !== 'stats');
    // En Playlists la lista de playlists/detalle trae sus propios botones de reproducción
    $('libActionsBar').classList.toggle('hidden', S.libFilter === 'stats' || S.libFilter === 'playlists');

    // El buscador no tiene sentido en la cápsula sonora ni en la lista de playlists cerrada.
    const searchWrap = $('libSearchWrap');
    if (searchWrap) {
      const hideSearch = S.libFilter === 'stats' || (S.libFilter === 'playlists' && !S.openPlaylistId);
      searchWrap.classList.toggle('hidden', hideSearch);
    }
    const searchInput = $('libSearchInput');
    if (searchInput && searchInput.value !== S.libSearch) searchInput.value = S.libSearch;
    $('libSearchClear')?.classList.toggle('hidden', !S.libSearch);

    // Actualizar botones de filtro
    const filterMap = [
      { id: 'libFilterLikes', key: 'likes' },
      { id: 'libFilterDownloads', key: 'downloads' },
      { id: 'libFilterPlaylists', key: 'playlists' },
      { id: 'libFilterHistory', key: 'history' },
      { id: 'libFilterStats', key: 'stats' }
    ];
    filterMap.forEach(({ id, key }) => {
      const btn = $(id);
      if (btn) btn.classList.toggle('active', S.libFilter === key);
    });

    const filtering = !!libraryQuery();
    const noMatch = 'Ninguna canción coincide con tu búsqueda en la biblioteca.';

    if (S.libFilter === 'likes') {
      renderTrackList($('libLikedList'), getFilteredLibraryTracks(), filtering ? noMatch : 'Aún no tienes canciones favoritas. Toca el corazón en cualquier canción.');
    } else if (S.libFilter === 'downloads') {
      renderTrackList($('libDownloadsList'), getFilteredLibraryTracks(), filtering ? noMatch : 'No tienes canciones descargadas. Toca ⬇️ en cualquier canción o "Descargar favoritas" para escuchar offline.');
    } else if (S.libFilter === 'history') {
      renderTrackList($('libHistoryList'), getFilteredLibraryTracks(), filtering ? noMatch : 'El historial de reproducción está vacío.');
    } else if (S.libFilter === 'playlists') {
      renderUserPlaylists();
    } else if (S.libFilter === 'stats') {
      renderStats();
    }
  }

  // opts.onRemove(idx): si se pasa, cada fila muestra un botón para quitarla (p. ej. dentro de una playlist)
  function renderTrackList(container, tracks, emptyText, opts = {}) {
    if (!container) return;
    if (tracks.length === 0) {
      container.innerHTML = `<p class="text-zinc-500 text-xs py-8 text-center">${emptyText}</p>`;
      return;
    }

    container.innerHTML = tracks.map((t, idx) => `
      <div class="flex items-center justify-between p-2 rounded-2xl hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition cursor-pointer press group" data-lib-track-idx="${idx}">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <img src="${esc(thumbAt(t.thumbnail, 160))}" data-vid="${esc(t.id)}" alt="" class="w-11 h-11 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" loading="lazy" />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-white truncate">${esc(t.title)}</p>
            <div class="flex items-center gap-1.5 mt-0.5">
              ${isDownloaded(t.id) ? '<span class="text-[10px] text-emerald-400 font-bold" title="Descargada">✓</span>' : ''}
              <p class="text-[10px] text-zinc-400 truncate cursor-pointer hover:text-emerald-400 artist-link" data-artist="${esc(t.artist)}">${esc(t.artist)}${t.durationText ? ` • ${esc(t.durationText)}` : ''}</p>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0 ml-2">
          ${opts.onRemove ? `<button data-lib-track-del="${idx}" class="p-1.5 text-zinc-400 hover:text-red-400 press" aria-label="Quitar de la playlist" title="Quitar de la playlist"><svg class="w-4 h-4"><use href="#i-trash"/></svg></button>` : ''}
          <button data-lib-track-down="${idx}" class="p-1.5 text-zinc-400 hover:text-emerald-400 press" title="Descargar">
            <svg class="w-4 h-4"><use href="${isDownloaded(t.id) ? '#i-download-done' : '#i-download'}"/></svg>
          </button>
          <button data-lib-track-more="${idx}" class="p-1.5 text-zinc-400 hover:text-white press" aria-label="Opciones">
            <svg class="w-4 h-4"><use href="#i-more"/></svg>
          </button>
          <button data-lib-track-like="${idx}" class="p-1.5 text-zinc-400 hover:text-emerald-400 press" aria-label="Favorito">
            <svg class="w-4 h-4"><use href="${S.favorites.some((f) => f.id === t.id) ? '#i-heart-fill' : '#i-heart'}"/></svg>
          </button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-lib-track-idx]').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-lib-track-more]') || e.target.closest('[data-lib-track-like]') || e.target.closest('[data-lib-track-down]') || e.target.closest('[data-lib-track-del]') || e.target.closest('.artist-link')) return;
        const idx = parseInt(card.getAttribute('data-lib-track-idx'), 10);
        S.queue = [...tracks];
        playTrack(idx, true);
      });
    });

    container.querySelectorAll('[data-lib-track-down]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-lib-track-down'), 10);
        toggleDownload(tracks[idx]);
      });
    });

    container.querySelectorAll('[data-lib-track-del]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (opts.onRemove) opts.onRemove(parseInt(btn.getAttribute('data-lib-track-del'), 10));
      });
    });

    container.querySelectorAll('[data-lib-track-more]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-lib-track-more'), 10);
        openSongMenu(tracks[idx]);
      });
    });

    container.querySelectorAll('[data-lib-track-like]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-lib-track-like'), 10);
        toggleLike(tracks[idx]);
      });
    });
  }

  // --- Playlists Personalizadas ---
  let playlistModalMode = 'save'; // 'save' | 'create' | 'rename'
  let playlistModalTarget = null; // canción a guardar; null si solo se crea o renombra
  let playlistRenameId = null;
  let pendingDeletePlaylistId = null;
  let pendingDeleteTimer = null;
  const TRASH_SVG = '<svg class="w-4 h-4"><use href="#i-trash"/></svg>';

  function savePlaylists() {
    localStorage.setItem('fs_playlists', JSON.stringify(S.playlists));
  }

  function createPlaylist(name) {
    if (!name || !name.trim()) return null;
    const pl = {
      id: Date.now().toString(),
      name: name.trim(),
      tracks: []
    };
    S.playlists.push(pl);
    savePlaylists();
    renderUserPlaylists();
    showToast(`Playlist "${pl.name}" creada`);
    return pl;
  }

  function renamePlaylist(id, name) {
    const pl = S.playlists.find((p) => p.id === id);
    const clean = (name || '').trim();
    if (!pl || !clean) return;
    pl.name = clean;
    savePlaylists();
    renderUserPlaylists();
    showToast('Playlist renombrada');
  }

  function deletePlaylist(id) {
    S.playlists = S.playlists.filter((p) => p.id !== id);
    if (S.openPlaylistId === id) S.openPlaylistId = null;
    savePlaylists();
    renderUserPlaylists();
    showToast('Playlist eliminada');
  }

  function removeTrackFromPlaylist(playlistId, trackId) {
    const pl = S.playlists.find((p) => p.id === playlistId);
    if (!pl) return;
    pl.tracks = pl.tracks.filter((t) => t.id !== trackId);
    savePlaylists();
    renderUserPlaylists();
    showToast('Quitada de la playlist');
  }

  function addTrackToPlaylist(playlistId, track) {
    const pl = S.playlists.find((p) => p.id === playlistId);
    if (!pl || !track) return;
    if (!pl.tracks.some((t) => t.id === track.id)) {
      pl.tracks.push(track);
      savePlaylists();
      renderUserPlaylists();
      showToast(`Guardada en "${pl.name}"`);
    } else {
      showToast(`Ya estaba en "${pl.name}"`);
    }
  }

  // --- Importador de playlists de Spotify / YouTube ---
  function setImportStatus(message, isError = false) {
    const el = $('importPlaylistStatus');
    if (!el) return;
    el.classList.remove('hidden');
    el.textContent = message;
    el.classList.toggle('text-red-400', isError);
    el.classList.toggle('text-emerald-400', !isError);
    el.classList.toggle('bg-red-500/10', isError);
    el.classList.toggle('bg-emerald-500/10', !isError);
    el.classList.toggle('border-red-500/25', isError);
    el.classList.toggle('border-emerald-500/25', !isError);
  }

  function openImportPlaylistModal() {
    const modal = $('importPlaylistModal');
    if (!modal || !modal.classList.contains('hidden')) return;
    $('importPlaylistUrl').value = '';
    $('importPlaylistStatus').classList.add('hidden');
    const startBtn = $('importPlaylistStartBtn');
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = 'Importar';
    }
    modal.classList.remove('hidden');
    pushModalState('importPlaylist');
    setTimeout(() => $('importPlaylistUrl')?.focus(), 280);
  }

  function closeImportPlaylistModal() {
    const modal = $('importPlaylistModal');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    popModalState();
  }

  async function importPlaylistFromUrl() {
    const urlEl = $('importPlaylistUrl');
    const startBtn = $('importPlaylistStartBtn');
    if (!urlEl || !startBtn) return;

    const raw = urlEl.value.trim();
    if (!/^https?:\/\//i.test(raw)) {
      setImportStatus('Pega un enlace válido que empiece por https://', true);
      return;
    }

    startBtn.disabled = true;
    startBtn.textContent = 'Importando…';
    setImportStatus('Leyendo la playlist…');

    try {
      const res = await fetch(`/api/import?url=${encodeURIComponent(raw)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || 'No se pudo leer la playlist');

      const source = Array.isArray(data.tracks) ? data.tracks : [];
      if (source.length === 0) throw new Error('La playlist está vacía o es privada');

      // Limita para no encadenar cientos de búsquedas desde el móvil.
      const limit = Math.min(source.length, 80);
      const results = new Array(limit);
      let next = 0;
      let done = 0;

      const worker = async () => {
        while (next < limit) {
          const i = next++;
          const item = source[i];
          if (!item) continue;
          if (item.id) {
            results[i] = item;
          } else {
            try {
              const q = `${item.title || ''} ${item.artist || ''}`.trim();
              if (q) {
                const sr = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
                const sd = await sr.json();
                const best = Array.isArray(sd.tracks) ? sd.tracks[0] : null;
                if (best && best.id) results[i] = best;
              }
            } catch {}
          }
          done++;
          if (done === limit || done % 2 === 0) {
            setImportStatus(`Buscando canciones… ${done}/${limit}`);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(5, limit) }, () => worker()));

      const tracks = [];
      const seen = new Set();
      for (const t of results) {
        if (!t || !t.id || seen.has(t.id)) continue;
        seen.add(t.id);
        tracks.push(t);
      }
      if (tracks.length === 0) throw new Error('No se encontró ninguna canción en YouTube');

      const pl = {
        id: Date.now().toString(),
        name: (data.name || 'Playlist importada').slice(0, 60),
        tracks
      };
      S.playlists.push(pl);
      savePlaylists();
      S.libFilter = 'playlists';
      S.openPlaylistId = pl.id;
      S.libSearch = '';
      renderLibrary();
      closeImportPlaylistModal();
      haptic('success');
      const countText = tracks.length === 1 ? '1 canción' : `${tracks.length} canciones`;
      showToast(`✓ ${pl.name}: ${countText}`, 3600);
      if (source.length > limit) {
        setTimeout(() => showToast(`Se importaron las primeras ${limit} de ${source.length} canciones`, 3600), 1200);
      }
    } catch (err) {
      setImportStatus(err.message || 'No se pudo importar la playlist', true);
    } finally {
      if (startBtn.isConnected) {
        startBtn.disabled = false;
        startBtn.textContent = 'Importar';
      }
    }
  }


  // mode: 'save' (guardar `customTrack` o la actual), 'create' (solo crear) o 'rename'
  function openPlaylistModal(customTrack, options = {}) {
    const mode = options.mode || 'save';
    const target = mode === 'save' ? (customTrack || (S.currentIndex >= 0 ? S.queue[S.currentIndex] : null)) : null;
    if (mode === 'save' && !target) {
      showToast('Selecciona una canción primero');
      return;
    }
    playlistModalMode = mode;
    playlistModalTarget = target;
    playlistRenameId = options.playlistId || null;

    const input = $('newPlaylistInput');
    input.value = mode === 'rename' ? (options.currentName || '') : '';
    $('playlistModalTitle').textContent = { save: 'Guardar en playlist', create: 'Nueva playlist', rename: 'Renombrar playlist' }[mode];
    $('createPlaylistConfirmBtn').textContent = mode === 'rename' ? 'Guardar' : 'Crear';
    $('playlistModalListWrap').classList.toggle('hidden', mode !== 'save');
    if (mode === 'save') renderModalPlaylists(target);

    const modal = $('playlistModal');
    if (modal.classList.contains('hidden')) {
      modal.classList.remove('hidden');
      pushModalState('playlist');
    }
    if (mode !== 'save' || S.playlists.length === 0) setTimeout(() => input.focus(), 60);
  }

  function renderModalPlaylists(target) {
    const container = $('modalPlaylistsList');
    if (S.playlists.length === 0) {
      container.innerHTML = '<p class="text-zinc-500 text-xs py-2">No tienes playlists. Escribe un nombre y pulsa Crear.</p>';
      return;
    }
    container.innerHTML = S.playlists.map((pl) => `
      <button data-pick-pl="${esc(pl.id)}" class="w-full text-left p-2.5 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 flex items-center justify-between press">
        <div class="min-w-0">
          <p class="text-xs font-bold text-white truncate">${esc(pl.name)}</p>
          <p class="text-[10px] text-zinc-400">${pl.tracks.length} canciones</p>
        </div>
        <svg class="w-4 h-4 text-emerald-400 shrink-0"><use href="#i-plus"/></svg>
      </button>
    `).join('');

    container.querySelectorAll('[data-pick-pl]').forEach((btn) => {
      btn.addEventListener('click', () => {
        addTrackToPlaylist(btn.getAttribute('data-pick-pl'), target);
        closePlaylistModal();
      });
    });
  }

  function closePlaylistModal() {
    const modal = $('playlistModal');
    if (modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    popModalState();
  }

  function submitPlaylistModal() {
    const input = $('newPlaylistInput');
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    if (playlistModalMode === 'rename') {
      renamePlaylist(playlistRenameId, name);
    } else {
      const pl = createPlaylist(name);
      // Crear desde "Guardar en playlist" también guarda la canción en la playlist nueva
      if (pl && playlistModalTarget) addTrackToPlaylist(pl.id, playlistModalTarget);
    }
    input.value = '';
    closePlaylistModal();
  }

  function renderUserPlaylists() {
    const listEl = $('userPlaylistsList');
    const detailEl = $('libPlaylistContent');
    if (!listEl) return;

    const open = S.openPlaylistId ? S.playlists.find((p) => p.id === S.openPlaylistId) : null;
    if (!open) S.openPlaylistId = null;
    listEl.classList.toggle('hidden', !!open);
    if (detailEl) detailEl.classList.toggle('hidden', !open);
    if (open) {
      renderPlaylistDetail(open);
      return;
    }
    if (detailEl) detailEl.innerHTML = '';

    if (S.playlists.length === 0) {
      listEl.innerHTML = '<p class="text-zinc-500 text-xs py-4 text-center">Crea tu primera playlist pulsando "+ Nueva playlist"</p>';
      return;
    }

    const q = libraryQuery();
    const visible = q ? S.playlists.filter((pl) => pl.name.toLowerCase().includes(q)) : S.playlists;
    if (visible.length === 0) {
      listEl.innerHTML = '<p class="text-zinc-500 text-xs py-4 text-center">Ninguna playlist coincide con la búsqueda.</p>';
      return;
    }

    listEl.innerHTML = visible.map((pl) => `
      <div class="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/60 border border-zinc-800/60 hover:bg-zinc-800 cursor-pointer press" data-pl-open="${esc(pl.id)}">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-sm shrink-0">
            ${esc(pl.name.slice(0, 2).toUpperCase())}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-white truncate">${esc(pl.name)}</p>
            <p class="text-[10px] text-zinc-400 truncate">${pl.tracks.length} canciones</p>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0 ml-2">
          <button data-pl-play="${esc(pl.id)}" aria-label="Reproducir ${esc(pl.name)}" class="w-8 h-8 rounded-full bg-emerald-500 text-black flex items-center justify-center press shadow-sm">
            <svg class="w-4 h-4"><use href="#i-play"/></svg>
          </button>
        </div>
      </div>
    `).join('');

    listEl.querySelectorAll('[data-pl-open]').forEach((el) => {
      el.addEventListener('click', () => {
        const pl = S.playlists.find((p) => p.id === el.getAttribute('data-pl-open'));
        if (!pl) return;
        S.openPlaylistId = pl.id;
        S.libSearch = '';
        renderLibrary();
      });
    });

    listEl.querySelectorAll('[data-pl-play]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pl = S.playlists.find((p) => p.id === btn.getAttribute('data-pl-play'));
        if (pl && pl.tracks.length > 0) {
          S.queue = [...pl.tracks];
          playTrack(0, true);
        } else {
          showToast('Esta playlist está vacía');
        }
      });
    });
  }

  function renderPlaylistDetail(pl) {
    const detailEl = $('libPlaylistContent');
    const q = libraryQuery();
    const visible = q ? pl.tracks.filter((t) => matchesLibraryQuery(t, q)) : pl.tracks;
    detailEl.innerHTML = `
      <div class="space-y-3">
        <button id="plBackBtn" class="flex items-center gap-1 text-xs font-bold text-zinc-400 hover:text-white press" aria-label="Volver a mis playlists">
          <svg class="w-4 h-4 rotate-90"><use href="#i-down"/></svg>
          <span>Playlists</span>
        </button>
        <div>
          <h3 class="text-lg font-bold text-white break-words">${esc(pl.name)}</h3>
          <p class="text-[11px] text-zinc-400">${q ? `${visible.length} de ${pl.tracks.length} canciones` : `${pl.tracks.length} canciones`}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button id="plPlayBtn" class="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-emerald-500 text-black font-bold text-xs press shadow-md">
            <svg class="w-4 h-4"><use href="#i-play"/></svg><span>Reproducir</span>
          </button>
          <button id="plShuffleBtn" class="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-zinc-800 text-zinc-200 border border-zinc-700 font-bold text-xs press">
            <svg class="w-4 h-4"><use href="#i-shuffle"/></svg><span>Aleatorio</span>
          </button>
          <button id="plDownloadBtn" class="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-emerald-400 font-bold text-xs press" title="Descargar toda la playlist">
            <svg class="w-4 h-4"><use href="#i-download"/></svg><span>Descargar</span>
          </button>
          <button id="plRenameBtn" class="px-3.5 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-300 font-bold text-xs press">Renombrar</button>
          <button id="plDeleteBtn" aria-label="Eliminar playlist" class="px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-red-400 font-bold text-xs press">${TRASH_SVG}</button>
        </div>
        <div id="plDetailTracks" class="space-y-1.5"></div>
      </div>
    `;

    $('plBackBtn').addEventListener('click', () => {
      S.openPlaylistId = null;
      S.libSearch = '';
      renderLibrary();
    });

    $('plPlayBtn').addEventListener('click', () => {
      if (pl.tracks.length === 0) return showToast('Esta playlist está vacía');
      S.queue = [...pl.tracks];
      playTrack(0, true);
    });

    $('plShuffleBtn').addEventListener('click', () => {
      if (pl.tracks.length === 0) return showToast('Esta playlist está vacía');
      S.queue = shuffled(pl.tracks);
      playTrack(0, true);
      showToast('Reproduciendo en aleatorio');
    });

    $('plDownloadBtn').addEventListener('click', () => downloadTracksList(pl.tracks, pl.name));

    $('plRenameBtn').addEventListener('click', () => {
      openPlaylistModal(null, { mode: 'rename', playlistId: pl.id, currentName: pl.name });
    });

    // Eliminar pide un segundo toque en 3 s (sin diálogos nativos)
    const delBtn = $('plDeleteBtn');
    delBtn.addEventListener('click', () => {
      if (pendingDeletePlaylistId === pl.id) {
        clearTimeout(pendingDeleteTimer);
        pendingDeletePlaylistId = null;
        deletePlaylist(pl.id);
        return;
      }
      pendingDeletePlaylistId = pl.id;
      delBtn.textContent = '¿Eliminar?';
      delBtn.classList.add('text-red-400', 'border-red-500/50');
      pendingDeleteTimer = setTimeout(() => {
        pendingDeletePlaylistId = null;
        if (delBtn.isConnected) {
          delBtn.innerHTML = TRASH_SVG;
          delBtn.classList.remove('text-red-400', 'border-red-500/50');
        }
      }, 3000);
    });

    renderTrackList(
      $('plDetailTracks'),
      visible,
      q ? 'Ninguna canción de esta playlist coincide con la búsqueda.' : 'Esta playlist está vacía. Agrega canciones desde el menú ⋮ de cualquier tema.',
      { onRemove: (idx) => removeTrackFromPlaylist(pl.id, visible[idx].id) }
    );
  }

  // --- Exportar e Importar Biblioteca (Copia de Seguridad JSON) ---
  const BACKUP_KEY = 'fs_last_backup';
  const BACKUP_REMINDER_DAYS = 14;

  function recordBackup() {
    const now = new Date().toISOString();
    try { localStorage.setItem(BACKUP_KEY, now); } catch {}
    S.lastBackup = now;
    renderBackupStatus();
  }

  function backupAgeDays() {
    const iso = S.lastBackup || localStorage.getItem(BACKUP_KEY);
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (!isFinite(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  function renderBackupStatus() {
    const el = $('backupStatusText');
    if (!el) return;
    const days = backupAgeDays();
    const overdue = days === null || days > BACKUP_REMINDER_DAYS;
    if (days === null) {
      el.textContent = 'Última copia: nunca';
    } else if (days <= 0) {
      el.textContent = 'Última copia: hoy';
    } else {
      el.textContent = `Última copia: hace ${days} ${days === 1 ? 'día' : 'días'}`;
    }
    el.classList.toggle('text-zinc-500', !overdue);
    el.classList.toggle('text-amber-400', overdue);
    if (overdue) {
      el.textContent += ' · Recomendado exportar';
    }
  }

  function maybeRemindBackup() {
    const hasData = (S.favorites && S.favorites.length) || (S.playlists && S.playlists.length) || (S.downloads && S.downloads.length);
    if (!hasData) return;
    const days = backupAgeDays();
    if (days === null || days > BACKUP_REMINDER_DAYS) {
      // Como mucho un recordatorio cada 3 días: abrir la app a diario no debe
      // convertirse en un aviso constante.
      try {
        const last = Number(localStorage.getItem('fs_backup_reminder_at') || 0);
        if (last && Date.now() - last < 3 * 86400000) return;
        localStorage.setItem('fs_backup_reminder_at', String(Date.now()));
      } catch {}
      showToast('💾 Hace tiempo que no haces una copia de seguridad. La tienes en Ajustes → Copia de Seguridad.', 4200);
    }
  }

  function exportLibraryBackup() {
    const backupData = {
      favorites: S.favorites,
      downloads: S.downloads,
      playlists: S.playlists,
      history: S.history,
      stats: S.stats,
      exportedAt: new Date().toISOString(),
      app: 'FreeSong',
      version: APP_VERSION
    };
    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `freesong_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    recordBackup();
    showToast('Copia de seguridad descargada');
  }

  function handleImportBackup(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        if (parsed.favorites || parsed.playlists || parsed.downloads) {
          if (Array.isArray(parsed.favorites)) {
            S.favorites = parsed.favorites;
            localStorage.setItem('fs_favorites', JSON.stringify(S.favorites));
          }
          if (Array.isArray(parsed.downloads)) {
            S.downloads = parsed.downloads;
            localStorage.setItem('fs_downloads', JSON.stringify(S.downloads));
          }
          if (Array.isArray(parsed.playlists)) {
            S.playlists = parsed.playlists;
            localStorage.setItem('fs_playlists', JSON.stringify(S.playlists));
          }
          if (Array.isArray(parsed.history)) {
            S.history = parsed.history;
            localStorage.setItem('fs_history', JSON.stringify(S.history));
          }
          if (parsed.stats) {
            S.stats = parsed.stats;
            localStorage.setItem('fs_stats', JSON.stringify(S.stats));
          }
          renderLibrary();
          showToast('¡Biblioteca restaurada con éxito!');
        } else {
          alert('El archivo no tiene el formato de copia de seguridad de FreeSong.');
        }
      } catch (err) {
        alert('Error al leer el archivo JSON: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // --- Diagnóstico local (sin telemetría) ---
  function saveDiag() {
    try {
      diagData.updated = Date.now();
      localStorage.setItem(DIAG_KEY, JSON.stringify(diagData));
    } catch {}
  }

  function diagInc(key, amount = 1) {
    diagData[key] = (Number(diagData[key]) || 0) + amount;
    saveDiag();
  }

  function diagRecordStart(ms) {
    if (!(ms > 0) || ms > 120000) return;
    diagData.plays = (Number(diagData.plays) || 0) + 1;
    diagData.startCount = (Number(diagData.startCount) || 0) + 1;
    diagData.startTotalMs = (Number(diagData.startTotalMs) || 0) + Math.round(ms);
    diagData.lastStartMs = Math.round(ms);
    saveDiag();
  }

  function fmtDiagMs(ms) {
    if (!(ms > 0)) return '—';
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  function renderDiagnostics() {
    const summary = $('diagSummary');
    const detail = $('diagDetail');
    if (!summary || !detail) return;
    const plays = Number(diagData.plays) || 0;
    const count = Number(diagData.startCount) || 0;
    const avg = count ? Math.round((Number(diagData.startTotalMs) || 0) / count) : 0;
    if (!plays && !diagData.recoveries && !diagData.skips) {
      summary.textContent = 'Todavía no hay datos. Reproduce algunas canciones y vuelve aquí.';
      detail.textContent = 'Se guardan solo en este dispositivo; no se envía nada a ningún servidor.';
      return;
    }
    summary.textContent = `${plays} reproducciones · arranque medio ${fmtDiagMs(avg)} · último ${fmtDiagMs(diagData.lastStartMs)}`;
    detail.textContent = `${diagData.recoveries || 0} recuperaciones · ${diagData.skips || 0} pistas saltadas · ${diagData.alt || 0} copias alternativas · ${diagData.stops || 0} paradas`;
  }

  function resetDiagnostics() {
    diagData = {};
    saveDiag();
    renderDiagnostics();
    showToast('Diagnóstico reiniciado');
  }

  async function copyDiagnostics() {
    const report = {
      app: 'FreeSong',
      version: APP_VERSION,
      userAgent: navigator.userAgent,
      online: navigator.onLine,
      data: diagData
    };
    const text = JSON.stringify(report, null, 2);
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('sin portapapeles');
      await navigator.clipboard.writeText(text);
      showToast('Informe copiado al portapapeles');
    } catch {
      showToast('No se pudo copiar. Revisa los permisos del navegador.', 3200);
    }
  }

  // --- Estado del servicio (diagnóstico del motor de audio) ---
  function setHealthStatus(state, text, detail) {
    const dot = $('healthDot');
    const textEl = $('healthText');
    const detailEl = $('healthDetail');
    if (dot) {
      dot.className = 'w-2.5 h-2.5 rounded-full mt-0.5 shrink-0 ' + (
        state === 'ok' ? 'bg-emerald-500' :
        state === 'warn' ? 'bg-amber-500' :
        state === 'bad' ? 'bg-red-500' : 'bg-zinc-600'
      );
    }
    if (textEl) textEl.textContent = text;
    if (detailEl) detailEl.textContent = detail || '';
  }

  async function checkServiceHealth() {
    const btn = $('healthCheckBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Comprobando…';
    }
    setHealthStatus('checking', 'Comprobando…', 'Contactando con el motor de reproducción…');
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const engine = data.engine || {};
      const relays = (data.relays && data.relays.hosts) || [];
      const relayText = relays.length
        ? (relays.length === 1 ? relays[0] : `${relays.length} relays`)
        : 'sin relays';
      const cookieText = data.cookieConfigured ? 'cookie ✓' : 'sin cookie';

      if (data.ok) {
        setHealthStatus('ok', 'Todo en orden',
          `Motor: ${engine.latencyMs != null ? engine.latencyMs + ' ms' : 'ok'} · ${relayText} · ${cookieText}`);
      } else {
        const why = [];
        if (!engine.reachable) why.push('motor sin respuesta');
        if (!relays.length) why.push('sin relays');
        setHealthStatus('bad', 'El motor tiene problemas',
          (why.length ? why.join(' y ') : 'estado desconocido') + '. Inténtalo de nuevo en unos minutos.');
      }
    } catch {
      setHealthStatus('bad', 'No se pudo comprobar', 'Fallo de red al contactar con /api/health.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Comprobar';
      }
    }
  }

  // El diagnóstico se hace al abrir Ajustes (no al arrancar): así no compite
  // con la primera canción ni gasta invocaciones de más en cada apertura.
  let lastHealthCheckAt = 0;
  function maybeCheckServiceHealth() {
    if (Date.now() - lastHealthCheckAt < 10 * 60 * 1000) return;
    lastHealthCheckAt = Date.now();
    checkServiceHealth();
  }

  // --- Modo "Tu DJ IA ✨" (Estilo Spotify AI DJ) ---
  const DJ_VIBES = [
    { name: 'Urbano & Reggaetón', query: 'reggaeton 2024 exitos perreo' },
    { name: 'Fiesta & Perreo', query: 'perreo fiesta hits latin dance' },
    { name: 'Chill & Relax', query: 'chill acoustic lo-fi relax en espanol' },
    { name: 'Éxitos Globales', query: 'top hits global exitos mundiales' }
  ];

  async function startDjSession() {
    const btnVibe = $('btnDjVibe');
    if (btnVibe) btnVibe.classList.remove('hidden');
    showToast('✨ Tu DJ IA: Analizando tus canciones favoritas...', 2000);

    let djQueue = [];
    if (S.favorites.length > 0) {
      const favSample = shuffled(S.favorites).slice(0, 2);
      djQueue.push(...favSample);
    }

    try {
      const vibe = DJ_VIBES[S.djVibeIndex];
      const res = await fetch(`/api/search?q=${encodeURIComponent(vibe.query)}`);
      const data = await res.json();
      if (data.tracks && data.tracks.length > 0) {
        const fresh = data.tracks.filter((t) => !djQueue.some((d) => d.id === t.id)).slice(0, 5);
        djQueue.push(...fresh);
      }
    } catch {}

    if (djQueue.length === 0) {
      showToast('DJ IA: Buscando éxitos recomendados...');
      return;
    }

    S.queue = djQueue;
    playTrack(0, true);
    showToast(`🎧 DJ IA: ¡Arrancamos tu sesión (${DJ_VIBES[S.djVibeIndex].name})!`, 3200);
  }

  async function cycleDjVibe() {
    S.djVibeIndex = (S.djVibeIndex + 1) % DJ_VIBES.length;
    const vibe = DJ_VIBES[S.djVibeIndex];
    const textEl = $('djVibeText');
    if (textEl) {
      textEl.textContent = vibe.name.split(' ')[0] || 'Vibe';
    }

    showToast(`🎧 DJ IA cambiando a: ${vibe.name}...`, 2000);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(vibe.query)}`);
      const data = await res.json();
      if (data.tracks && data.tracks.length > 0) {
        const fresh = data.tracks.slice(0, 5);
        S.queue.splice(S.currentIndex + 1, 0, ...fresh);
        renderQueue();
        showToast(`🎧 DJ IA: Ahora en vibe ${vibe.name}`);
        playNext(true);
      }
    } catch {
      showToast('Error al cambiar de vibe');
    }
  }

  // --- Carga de Inicio (Home con Chips) ---
  async function loadHomeContent(category = 'todo') {
    const container = $('homeShelves');
    container.innerHTML = '<div class="flex items-center justify-center py-12 text-zinc-500 text-sm animate-pulse">Cargando música...</div>';

    try {
      const url = category === 'todo' ? '/api/home' : `/api/home?category=${encodeURIComponent(category)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data.shelves || data.shelves.length === 0) {
        container.innerHTML = '<p class="text-center py-10 text-zinc-500 text-sm">No se encontraron canciones</p>';
        return;
      }

      if (data.shelves[0]?.items?.length > 0) {
        prewarmTracks(data.shelves[0].items.slice(0, 4));
      }

      renderQuickAccess();

      if (category === 'todo' && data.shelves[0]?.items?.length > 0) {
        renderTrendingList(data.shelves[0].items);
      } else {
        $('trendingSection')?.classList.add('hidden');
      }

      const shelvesToRender = category === 'todo' ? data.shelves.slice(1) : data.shelves;
      if (shelvesToRender.length === 0) {
        container.innerHTML = '';
        return;
      }

      container.innerHTML = shelvesToRender.map((shelf, sIdx) => `
        <div class="space-y-3">
          <div class="flex items-center justify-between px-0.5">
            <h2 class="text-base font-bold text-white tracking-tight">${esc(shelf.title)}</h2>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            ${shelf.items.map((t, itemIdx) => `
              <div class="group relative rounded-2xl bg-zinc-900/60 p-2.5 border border-zinc-800/60 hover:bg-zinc-800/80 transition cursor-pointer press" data-shelf-idx="${sIdx}" data-item-idx="${itemIdx}">
                <div class="w-full aspect-square rounded-xl overflow-hidden bg-zinc-800 mb-2 relative shadow-md">
                  <img src="${thumbAt(t.thumbnail, 480)}" data-vid="${esc(t.id)}" alt="" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" loading="lazy" />
                  <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
                    <div class="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center text-black shadow-lg">
                      <svg class="w-5 h-5"><use href="#i-play"/></svg>
                    </div>
                  </div>
                  ${t.durationText ? `<span class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/80 backdrop-blur-md text-[9px] font-mono font-bold text-white">${t.durationText}</span>` : ''}
                </div>
                <p class="text-xs font-bold text-white truncate">${esc(t.title)}</p>
                <p class="text-[11px] text-zinc-400 truncate mt-0.5">${esc(t.artist)}</p>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('');

      $$('[data-shelf-idx]').forEach((card) => {
        card.addEventListener('click', () => {
          const sIdx = parseInt(card.getAttribute('data-shelf-idx'), 10);
          const itemIdx = parseInt(card.getAttribute('data-item-idx'), 10);
          const shelf = shelvesToRender[sIdx];
          if (shelf && shelf.items && shelf.items.length > 0) {
            S.queue = [...shelf.items];
            playTrack(itemIdx, true);
          }
        });
      });
    } catch {
      container.innerHTML = '<p class="text-center py-10 text-zinc-500 text-sm">Error al cargar recomendaciones</p>';
    }
  }

  function renderQuickAccess() {
    const grid = $('quickAccessGrid');
    if (!grid) return;
    const source = (S.history.length > 0 ? S.history : S.favorites).slice(0, 6);
    if (source.length === 0) {
      $('quickAccessSection')?.classList.add('hidden');
      return;
    }
    $('quickAccessSection')?.classList.remove('hidden');

    grid.innerHTML = source.map((t, idx) => `
      <div class="flex items-center rounded-xl bg-zinc-900/80 hover:bg-zinc-800/90 border border-zinc-800/80 overflow-hidden cursor-pointer press shadow-sm group" data-quick-idx="${idx}">
        <img src="${thumbAt(t.thumbnail, 160)}" data-vid="${esc(t.id)}" class="w-12 h-12 object-cover bg-zinc-800 shrink-0" />
        <span class="text-xs font-bold text-white px-2.5 truncate flex-1 leading-tight">${esc(t.title)}</span>
        <div class="w-7 h-7 rounded-full bg-emerald-500 text-black flex items-center justify-center mr-2 opacity-0 group-hover:opacity-100 transition shadow-md shrink-0">
          <svg class="w-3.5 h-3.5"><use href="#i-play"/></svg>
        </div>
      </div>
    `).join('');

    $$('[data-quick-idx]').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.getAttribute('data-quick-idx'), 10);
        const t = source[idx];
        if (t) {
          S.queue = [t, ...S.queue.filter((x) => x.id !== t.id)];
          playTrack(0, true);
        }
      });
    });
  }

  function renderTrendingList(items) {
    const list = $('trendingList');
    if (!list) return;
    const top5 = items.slice(0, 5);

    list.innerHTML = top5.map((t, idx) => `
      <div class="flex items-center justify-between p-2 rounded-2xl bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800/60 transition cursor-pointer press group" data-trend-idx="${idx}">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <span class="w-5 text-center text-sm font-black ${idx === 0 ? 'text-emerald-400' : 'text-zinc-500'} shrink-0">${idx + 1}</span>
          <img src="${thumbAt(t.thumbnail, 160)}" data-vid="${esc(t.id)}" class="w-11 h-11 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-white truncate">${esc(t.title)}</p>
            <p class="text-[11px] text-zinc-400 truncate">${esc(t.artist)}${t.durationText ? ` • ${t.durationText}` : ''}</p>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0 ml-2">
          <button data-trend-more="${idx}" class="p-1.5 text-zinc-400 hover:text-white press" aria-label="Opciones">
            <svg class="w-4 h-4"><use href="#i-more"/></svg>
          </button>
          <button data-trend-like="${idx}" class="p-1.5 text-zinc-400 hover:text-emerald-400 press" aria-label="Favorito">
            <svg class="w-4 h-4"><use href="${S.favorites.some((f) => f.id === t.id) ? '#i-heart-fill' : '#i-heart'}"/></svg>
          </button>
          <div class="w-8 h-8 rounded-full bg-zinc-800 group-hover:bg-emerald-500 group-hover:text-black text-emerald-400 flex items-center justify-center transition shadow-sm">
            <svg class="w-3.5 h-3.5"><use href="#i-play"/></svg>
          </div>
        </div>
      </div>
    `).join('');

    $$('[data-trend-idx]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-trend-like]') || e.target.closest('[data-trend-more]')) return;
        const idx = parseInt(row.getAttribute('data-trend-idx'), 10);
        S.queue = [...items];
        playTrack(idx, true);
      });
    });

    $$('[data-trend-more]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-trend-more'), 10);
        openSongMenu(top5[idx]);
      });
    });

    $$('[data-trend-like]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-trend-like'), 10);
        const t = top5[idx];
        if (t) {
          toggleLike(t);
          renderTrendingList(items);
        }
      });
    });
  }

  // --- Búsqueda en Vivo con Búsquedas Recientes y Exploración de Géneros ---
  let searchTimer = null;

  function renderRecentSearches() {
    const wrap = $('searchRecentWrap');
    const container = $('searchRecentChips');
    if (!wrap || !container) return;

    if (!S.recentSearches || S.recentSearches.length === 0) {
      wrap.classList.add('hidden');
      return;
    }

    wrap.classList.remove('hidden');
    container.innerHTML = S.recentSearches.map((term, i) => `
      <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 text-xs font-semibold text-zinc-300 hover:text-white transition cursor-pointer press group shadow-sm">
        <span data-search-chip="${esc(term)}">${esc(term)}</span>
        <button data-recent-del="${i}" class="text-zinc-500 hover:text-red-400 p-0.5 ml-0.5 text-sm leading-none" title="Eliminar">×</button>
      </span>
    `).join('');

    $$('[data-search-chip]').forEach((el) => {
      el.addEventListener('click', () => {
        const term = el.getAttribute('data-search-chip');
        const input = $('searchInput');
        input.value = term;
        $('searchClearBtn').classList.remove('hidden');
        executeSearch(term);
      });
    });

    $$('[data-recent-del]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = parseInt(btn.getAttribute('data-recent-del'), 10);
        S.recentSearches.splice(i, 1);
        localStorage.setItem('fs_recent_searches', JSON.stringify(S.recentSearches));
        renderRecentSearches();
      });
    });
  }

  let suggestionTimer = null;
  let currentSearchResults = [];
  let searchAbortController = null;

  function setupSearch() {
    const input = $('searchInput');
    const clearBtn = $('searchClearBtn');
    const results = $('searchResults');
    const resultsList = $('searchResultsList');
    const genresWrap = $('searchGenresWrap');
    const suggestionsDropdown = $('searchSuggestionsDropdown');
    const suggestionsList = $('suggestionsList');
    const loadMoreBtn = $('searchLoadMoreBtn');

    renderRecentSearches();

    // Filtros de categoría de búsqueda (SimpMusic: Canciones, Artistas, Álbumes, Playlists, Videos)
    $$('[data-search-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('[data-search-type]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        S.searchType = btn.getAttribute('data-search-type') || 'songs';
        const q = input.value.trim();
        if (q) {
          executeSearch(q, false);
        }
      });
    });

    // Entrada de búsqueda con autocompletado predictivo en tiempo real
    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearBtn.classList.toggle('hidden', !q);
      clearTimeout(searchTimer);
      clearTimeout(suggestionTimer);

      if (!q) {
        if (suggestionsDropdown) suggestionsDropdown.classList.add('hidden');
        results.classList.add('hidden');
        if (resultsList) resultsList.innerHTML = '';
        if (genresWrap) genresWrap.classList.remove('hidden');
        renderRecentSearches();
        return;
      }

      // Sugerencias instantáneas (SimpMusic Engine)
      suggestionTimer = setTimeout(async () => {
        try {
          const res = await fetch(`/api/suggestions?q=${encodeURIComponent(q)}`);
          const data = await res.json();
          const queries = data.queries || [];
          if (queries.length > 0 && input.value.trim() === q && suggestionsList && suggestionsDropdown) {
            suggestionsList.innerHTML = queries.slice(0, 5).map((sq) => `
              <div class="flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-zinc-800/80 transition cursor-pointer suggestion-item press" data-suggest-query="${esc(sq)}">
                <svg class="w-4 h-4 text-zinc-500 shrink-0"><use href="#i-search"/></svg>
                <span class="text-xs text-zinc-200 font-medium truncate">${esc(sq)}</span>
              </div>
            `).join('');

            $$('[data-suggest-query]').forEach((el) => {
              el.addEventListener('click', () => {
                const selectedQ = el.getAttribute('data-suggest-query');
                input.value = selectedQ;
                suggestionsDropdown.classList.add('hidden');
                clearBtn.classList.remove('hidden');
                executeSearch(selectedQ, false);
              });
            });

            suggestionsDropdown.classList.remove('hidden');
          } else if (suggestionsDropdown) {
            suggestionsDropdown.classList.add('hidden');
          }
        } catch {
          suggestionsDropdown?.classList.add('hidden');
        }
      }, 200);

      searchTimer = setTimeout(() => {
        suggestionsDropdown?.classList.add('hidden');
        executeSearch(q, false);
      }, 450);
    });

    // Cerrar sugerencias al hacer clic fuera del área de búsqueda
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#viewSearch')) {
        suggestionsDropdown?.classList.add('hidden');
      }
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.classList.add('hidden');
      suggestionsDropdown?.classList.add('hidden');
      results.classList.add('hidden');
      if (resultsList) resultsList.innerHTML = '';
      if (genresWrap) genresWrap.classList.remove('hidden');
      renderRecentSearches();
      input.focus();
    });

    loadMoreBtn?.addEventListener('click', () => {
      const q = input.value.trim();
      if (q && S.searchContinuation) {
        executeSearch(q, true);
      }
    });

    $('btnRecentClear')?.addEventListener('click', () => {
      S.recentSearches = [];
      localStorage.removeItem('fs_recent_searches');
      renderRecentSearches();
      showToast('Historial de búsquedas eliminado');
    });

    $$('[data-genre-q]').forEach((card) => {
      card.addEventListener('click', () => {
        const q = card.getAttribute('data-genre-q');
        input.value = q;
        clearBtn.classList.remove('hidden');
        suggestionsDropdown?.classList.add('hidden');
        executeSearch(q, false);
      });
    });
  }

  async function executeSearch(query, isContinuation = false) {
    const results = $('searchResults');
    const resultsList = $('searchResultsList');
    const genresWrap = $('searchGenresWrap');
    const recentWrap = $('searchRecentWrap');
    const loadMoreWrap = $('searchLoadMoreWrap');
    const suggestionsDropdown = $('searchSuggestionsDropdown');

    if (suggestionsDropdown) suggestionsDropdown.classList.add('hidden');
    if (genresWrap) genresWrap.classList.add('hidden');
    if (recentWrap) recentWrap.classList.add('hidden');
    results.classList.remove('hidden');

    if (!isContinuation) {
      // Cancela la búsqueda anterior: si llega tarde no debe pisar los resultados nuevos.
      if (searchAbortController) {
        try { searchAbortController.abort(); } catch {}
      }
      searchAbortController = new AbortController();
      if (resultsList) resultsList.innerHTML = '<div class="text-center py-12 text-zinc-500 text-sm animate-pulse">Buscando en YouTube Music...</div>';
      if (loadMoreWrap) loadMoreWrap.classList.add('hidden');
      S.searchContinuation = null;
      currentSearchResults = [];
    } else {
      if (loadMoreWrap) {
        loadMoreWrap.innerHTML = '<div class="text-xs text-zinc-400 font-bold animate-pulse">Cargando más pistas...</div>';
      }
    }

    // Guardar en búsquedas recientes
    if (!isContinuation && query && query.trim().length > 1) {
      const cleanQ = query.trim();
      S.recentSearches = [cleanQ, ...S.recentSearches.filter((s) => s.toLowerCase() !== cleanQ.toLowerCase())].slice(0, 8);
      localStorage.setItem('fs_recent_searches', JSON.stringify(S.recentSearches));
    }

    try {
      const searchType = S.searchType || 'songs';
      let url = `/api/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(searchType)}`;
      if (isContinuation && S.searchContinuation) {
        url += `&continuation=${encodeURIComponent(S.searchContinuation)}`;
      }

      const res = await fetch(url, {
        signal: isContinuation ? undefined : searchAbortController.signal
      });
      const data = await res.json();

      // Si el usuario sigue escribiendo, descarta esta respuesta.
      const currentInput = $('searchInput');
      if (!isContinuation && currentInput && currentInput.value.trim() !== String(query).trim()) return;

      S.searchContinuation = data.continuation || null;

      const items = data.items || data.tracks || [];

      if (!isContinuation && items.length === 0) {
        if (resultsList) resultsList.innerHTML = '<div class="text-center py-12 text-zinc-400 text-sm">No se encontraron resultados para esta categoría</div>';
        if (loadMoreWrap) loadMoreWrap.classList.add('hidden');
        return;
      }

      const startIdx = currentSearchResults.length;
      if (isContinuation) {
        currentSearchResults.push(...items);
      } else {
        currentSearchResults = items;
      }

      // Renderizado según tipo de contenido (SimpMusic Engine)
      let html = '';
      if (searchType === 'artists') {
        html = items.map((art) => `
          <div class="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800/60 transition cursor-pointer press group" data-artist-browse="${art.id}" data-artist-name="${esc(art.name || art.title)}" data-artist-thumb="${esc(art.thumbnail || '')}">
            <div class="flex items-center gap-3.5 min-w-0 flex-1">
              <img src="${thumbAt(art.thumbnail || 'icons/icon-192.png', 160)}" class="w-12 h-12 rounded-full object-cover bg-zinc-800 shrink-0 shadow-md" loading="lazy" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <p class="text-sm font-bold text-white truncate">${esc(art.name || art.title)}</p>
                  <span class="text-[9px] font-bold text-sky-400 bg-sky-500/20 px-1.5 py-0.5 rounded-full">Artista</span>
                </div>
                <p class="text-xs text-zinc-400 truncate mt-0.5">${esc(art.subscribers || 'Artista verificado')}</p>
              </div>
            </div>
            <button class="px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-xs font-bold text-emerald-400 transition press">
              Ver perfil
            </button>
          </div>
        `).join('');
      } else if (searchType === 'albums') {
        html = items.map((alb) => `
          <div class="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800/60 transition cursor-pointer press group" data-album-browse="${alb.id}" data-album-title="${esc(alb.title)}">
            <div class="flex items-center gap-3.5 min-w-0 flex-1">
              <img src="${thumbAt(alb.thumbnail || 'icons/icon-192.png', 160)}" class="w-12 h-12 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-md" loading="lazy" />
              <div class="min-w-0 flex-1">
                <p class="text-sm font-bold text-white truncate">${esc(alb.title)}</p>
                <p class="text-xs text-zinc-400 truncate mt-0.5">${esc(alb.artist)}${alb.year ? ' • ' + esc(alb.year) : ''} • Álbum</p>
              </div>
            </div>
            <button class="px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-xs font-bold text-emerald-400 transition press">
              Ver álbum
            </button>
          </div>
        `).join('');
      } else if (searchType === 'playlists') {
        html = items.map((pl) => `
          <div class="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800/60 transition cursor-pointer press group" data-playlist-browse="${pl.id}" data-playlist-title="${esc(pl.title)}">
            <div class="flex items-center gap-3.5 min-w-0 flex-1">
              <img src="${thumbAt(pl.thumbnail || 'icons/icon-192.png', 160)}" class="w-12 h-12 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-md" loading="lazy" />
              <div class="min-w-0 flex-1">
                <p class="text-sm font-bold text-white truncate">${esc(pl.title)}</p>
                <p class="text-xs text-zinc-400 truncate mt-0.5">${esc(pl.author)}${pl.trackCount ? ' • ' + esc(pl.trackCount) : ''}</p>
              </div>
            </div>
            <button class="px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-xs font-bold text-emerald-400 transition press">
              Ver playlist
            </button>
          </div>
        `).join('');
      } else {
        // canciones o videos
        prewarmTracks(items.slice(0, 6));
        html = items.map((t, idx) => {
          const globalIdx = startIdx + idx;
          return `
            <div class="flex items-center justify-between p-2.5 rounded-2xl hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition cursor-pointer press group" data-search-idx="${globalIdx}">
              <div class="flex items-center gap-3 min-w-0 flex-1">
                <img src="${thumbAt(t.thumbnail, 160)}" data-vid="${esc(t.id)}" class="w-12 h-12 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" loading="lazy" />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-bold text-white truncate">${esc(t.title)}</p>
                  <div class="flex items-center gap-1.5 mt-0.5">
                    ${isDownloaded(t.id) ? '<span class="text-[10px] text-emerald-400 font-bold">✓</span>' : ''}
                    <p class="text-xs text-zinc-400 truncate cursor-pointer hover:text-emerald-400 artist-link" data-artist="${esc(t.artist)}">${esc(t.artist)}${t.durationText ? ` • ${t.durationText}` : ''}</p>
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-1.5 shrink-0 ml-2">
                <button data-search-down="${globalIdx}" class="p-1.5 text-zinc-400 hover:text-emerald-400 press" title="Descargar">
                  <svg class="w-4 h-4"><use href="${isDownloaded(t.id) ? '#i-download-done' : '#i-download'}"/></svg>
                </button>
                <button data-search-more="${globalIdx}" class="p-1.5 text-zinc-400 hover:text-white press" aria-label="Opciones">
                  <svg class="w-4 h-4"><use href="#i-more"/></svg>
                </button>
                <button class="w-9 h-9 rounded-full bg-zinc-800 text-emerald-400 hover:bg-emerald-500 hover:text-black flex items-center justify-center shadow-sm transition">
                  <svg class="w-4 h-4"><use href="#i-play"/></svg>
                </button>
              </div>
            </div>
          `;
        }).join('');
      }

      if (isContinuation) {
        resultsList?.insertAdjacentHTML('beforeend', html);
      } else if (resultsList) {
        resultsList.innerHTML = html;
      }

      // Conectar eventos según tipo
      if (searchType === 'artists') {
        $$('[data-artist-browse]').forEach((el) => {
          el.addEventListener('click', () => {
            const id = el.getAttribute('data-artist-browse');
            const name = el.getAttribute('data-artist-name');
            const thumb = el.getAttribute('data-artist-thumb');
            openArtistPage(id || name, thumb);
          });
        });
      } else if (searchType === 'albums') {
        $$('[data-album-browse]').forEach((el) => {
          el.addEventListener('click', () => {
            const id = el.getAttribute('data-album-browse');
            const title = el.getAttribute('data-album-title');
            openCollection('album', id, title);
          });
        });
      } else if (searchType === 'playlists') {
        $$('[data-playlist-browse]').forEach((el) => {
          el.addEventListener('click', () => {
            const id = el.getAttribute('data-playlist-browse');
            const title = el.getAttribute('data-playlist-title');
            openCollection('playlist', id, title);
          });
        });
      } else {
        $$('[data-search-idx]').forEach((el) => {
          if (el.dataset.searchBound) return;
          el.dataset.searchBound = '1';
          el.addEventListener('pointerdown', () => {
            const idx = parseInt(el.getAttribute('data-search-idx'), 10);
            const t = currentSearchResults[idx];
            if (t && t.id && !t.streamUrl) {
              resolveRelaySource(t.id, S.audioQuality).then((src) => {
                if (src) {
                  rememberRelaySource(t, src);
                  return null;
                }
                return resolveRelayAlternative(t).then((alt) => {
                  if (alt) rememberRelaySource(t, alt);
                });
              }).catch(() => {});
            }
          }, { passive: true });
          el.addEventListener('click', (e) => {
            if (e.target.closest('[data-search-more]') || e.target.closest('[data-search-down]') || e.target.closest('.artist-link')) return;
            const idx = parseInt(el.getAttribute('data-search-idx'), 10);
            S.queue = [...currentSearchResults];
            playTrack(idx, true);
          });
        });

        $$('[data-search-down]').forEach((btn) => {
          if (btn.dataset.searchBound) return;
          btn.dataset.searchBound = '1';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.getAttribute('data-search-down'), 10);
            toggleDownload(currentSearchResults[idx]);
          });
        });

        $$('[data-search-more]').forEach((btn) => {
          if (btn.dataset.searchBound) return;
          btn.dataset.searchBound = '1';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.getAttribute('data-search-more'), 10);
            openSongMenu(currentSearchResults[idx]);
          });
        });
      }

      // Botón Cargar Más
      if (loadMoreWrap) {
        if (S.searchContinuation) {
          loadMoreWrap.classList.remove('hidden');
          loadMoreWrap.innerHTML = `
            <button id="searchLoadMoreBtn" class="px-5 py-2.5 rounded-full bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-bold text-emerald-400 hover:border-emerald-500/50 press">
              Cargar más resultados
            </button>
          `;
          $('searchLoadMoreBtn')?.addEventListener('click', () => {
            executeSearch(query, true);
          });
        } else {
          loadMoreWrap.classList.add('hidden');
        }
      }

    } catch (err) {
      // Una búsqueda cancelada por otra más nueva no es un error.
      if (err && err.name === 'AbortError') return;
      if (!isContinuation && resultsList) {
        resultsList.innerHTML = '<div class="text-center py-12 text-zinc-500 text-sm">Error al realizar la búsqueda</div>';
      }
      if (loadMoreWrap) loadMoreWrap.classList.add('hidden');
    }
  }

  // --- Temporizador de Apagado (Sleep Timer) ---
  function setSleepBadge(label) {
    const badge = $('sleepTimerBadge');
    const text = $('sleepTimerText');
    const playerBadge = $('playerSleepBadge');
    const playerText = $('playerSleepText');
    if (badge) badge.classList.remove('hidden');
    if (text) text.textContent = label;
    if (playerBadge) playerBadge.classList.remove('hidden');
    if (playerText) playerText.textContent = label;
  }

  function hideSleepBadges() {
    $('sleepTimerBadge')?.classList.add('hidden');
    $('playerSleepBadge')?.classList.add('hidden');
  }

  function startSleepTimer(minutes) {
    clearSleepTimer();

    if (minutes === 'end_track') {
      S.sleepTimerEndTrack = true;
      S.sleepTimerMinutes = 'end_track';
      setSleepBadge('1 can');
      closeSleepTimerModal();
      showToast('Temporizador: al terminar esta canción');
      return;
    }

    const minNum = parseInt(minutes, 10);
    if (isNaN(minNum) || minNum <= 0) {
      clearSleepTimer();
      closeSleepTimerModal();
      showToast('Temporizador desactivado');
      return;
    }

    S.sleepTimerMinutes = minNum;
    S.sleepTimerRemainingSec = minNum * 60;
    setSleepBadge(`${minNum}m`);

    S.sleepTimerInterval = setInterval(() => {
      S.sleepTimerRemainingSec--;
      const rem = S.sleepTimerRemainingSec;
      if (rem <= 0) {
        clearSleepTimer();
        pausePlayback();
      } else {
        const m = Math.floor(rem / 60);
        const s = rem % 60;
        setSleepBadge(m > 0 ? `${m}m` : `${s}s`);
      }
    }, 1000);

    closeSleepTimerModal();
    showToast(`Temporizador activado por ${minNum} minutos`);
  }

  function clearSleepTimer() {
    if (S.sleepTimerInterval) clearInterval(S.sleepTimerInterval);
    S.sleepTimerInterval = null;
    S.sleepTimerMinutes = null;
    S.sleepTimerEndTrack = false;
    S.sleepTimerRemainingSec = 0;
    hideSleepBadges();
  }

  function openSleepTimerModal() {
    const modal = $('sleepTimerModal');
    if (!modal.classList.contains('hidden')) return;
    modal.classList.remove('hidden');
    pushModalState('sleepTimer');
  }

  function closeSleepTimerModal() {
    const modal = $('sleepTimerModal');
    if (modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    popModalState();
  }

  // --- Navegación entre pestañas ---
  function switchTab(tab) {
    closeArtistProfile();
    if (S.activeTab !== tab) haptic('light');
    S.activeTab = tab;
    $('viewHome').classList.toggle('hidden', tab !== 'home');
    $('viewSearch').classList.toggle('hidden', tab !== 'search');
    $('viewLibrary').classList.toggle('hidden', tab !== 'library');
    $('viewSettings').classList.toggle('hidden', tab !== 'settings');

    $$('[data-nav]').forEach((btn) => {
      const isCurrent = btn.getAttribute('data-nav') === tab;
      btn.className = isCurrent
        ? 'flex flex-col items-center gap-1 py-1 px-3 text-emerald-400 font-semibold text-[10px] press'
        : 'flex flex-col items-center gap-1 py-1 px-3 text-zinc-400 hover:text-zinc-200 font-semibold text-[10px] press';
    });

    if (tab === 'library') {
      renderLibrary();
    }
    if (tab === 'settings') {
      renderBackupStatus();
      renderDiagnostics();
      maybeCheckServiceHealth();
    }
  }

  // --- Gestos Táctiles (Swipe en Carátula y Sheet) ---
  function setupGestures() {
    let touchStartX = 0;
    let touchStartY = 0;
    const coverArea = $('sheetTrackView');
    const playerSheet = $('fullPlayerSheet');

    if (coverArea) {
      coverArea.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }, { passive: true });

      coverArea.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;

        // Deslizar horizontalmente para cambiar de canción
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          if (dx < 0) {
            playNext(true);
          } else {
            playPrev();
          }
        }
      }, { passive: true });
    }

    if (playerSheet) {
      playerSheet.addEventListener('touchstart', (e) => {
        // Si el toque empieza en el tercio superior
        if (e.touches[0].clientY < window.innerHeight * 0.35) {
          touchStartY = e.touches[0].clientY;
          touchStartX = e.touches[0].clientX;
        } else {
          touchStartY = 0;
        }
      }, { passive: true });

      playerSheet.addEventListener('touchend', (e) => {
        if (touchStartY > 0) {
          const dy = e.changedTouches[0].clientY - touchStartY;
          const dx = e.changedTouches[0].clientX - touchStartX;
          // Deslizar hacia abajo minimiza el reproductor
          if (dy > 70 && Math.abs(dy) > Math.abs(dx) * 1.5) {
            closeFullPlayer();
          }
        }
      }, { passive: true });
    }

    const artistModal = $('artistViewModal');
    if (artistModal) {
      let artistTouchStartX = 0;
      let artistTouchStartY = 0;

      artistModal.addEventListener('touchstart', (e) => {
        artistTouchStartX = e.touches[0].clientX;
        artistTouchStartY = e.touches[0].clientY;
      }, { passive: true });

      artistModal.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - artistTouchStartX;
        const dy = e.changedTouches[0].clientY - artistTouchStartY;

        // Deslizar hacia la derecha desde el borde izquierdo (gesto nativo iOS volver)
        const isSwipeRight = artistTouchStartX < 75 && dx > 60 && Math.abs(dx) > Math.abs(dy) * 1.3;
        // O deslizar hacia abajo si el scroll está en el inicio superior
        const isSwipeDownFromTop = artistModal.scrollTop <= 5 && dy > 80 && Math.abs(dy) > Math.abs(dx) * 1.4;

        if (isSwipeRight || isSwipeDownFromTop) {
          closeArtistProfile();
        }
      }, { passive: true });
    }

    const collModal = $('collectionModal');
    if (collModal) {
      let collTouchStartX = 0;
      let collTouchStartY = 0;

      collModal.addEventListener('touchstart', (e) => {
        collTouchStartX = e.touches[0].clientX;
        collTouchStartY = e.touches[0].clientY;
      }, { passive: true });

      collModal.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - collTouchStartX;
        const dy = e.changedTouches[0].clientY - collTouchStartY;

        const isSwipeRight = collTouchStartX < 75 && dx > 60 && Math.abs(dx) > Math.abs(dy) * 1.3;
        const isSwipeDownFromTop = collModal.scrollTop <= 5 && dy > 80 && Math.abs(dy) > Math.abs(dx) * 1.4;

        if (isSwipeRight || isSwipeDownFromTop) {
          closeCollection();
        }
      }, { passive: true });
    }
  }

  // --- Enlazar Todos los Eventos de la Interfaz ---
  // El estado inicial de S.repeat es 'all': sincroniza el botón al arrancar para que
  // no muestre "repetición desactivada" mientras la cola sí da la vuelta.
  function syncRepeatButton() {
    const btn = $('playerRepeatBtn');
    if (!btn) return;
    if (S.repeat === 'off') {
      btn.className = 'p-2 text-zinc-400 hover:text-white press';
      btn.innerHTML = '<svg class="w-5 h-5"><use href="#i-repeat"/></svg>';
    } else {
      btn.className = 'p-2 text-emerald-400 has-active-dot press';
      btn.innerHTML = S.repeat === 'one'
        ? '<svg class="w-5 h-5"><use href="#i-repeat-one"/></svg>'
        : '<svg class="w-5 h-5"><use href="#i-repeat"/></svg>';
    }
  }

  function syncShuffleButton() {
    const btn = $('playerShuffleBtn');
    const badge = $('playerShuffleBadge');
    if (!btn) return;
    if (S.shuffleMode === 0) {
      btn.className = 'relative p-2 text-zinc-400 hover:text-white press';
      badge?.classList.add('hidden');
    } else {
      btn.className = 'relative p-2 text-emerald-400 has-active-dot press';
      badge?.classList.toggle('hidden', S.shuffleMode !== 2);
    }
  }

  function bindEvents() {
    // Chips de categorías de Home
    $$('.chip-btn[data-chip]').forEach((chip) => {
      chip.addEventListener('click', () => {
        $$('.chip-btn[data-chip]').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        const cat = chip.getAttribute('data-chip');
        S.activeChip = cat;
        loadHomeContent(cat);
      });
    });

    // Pestañas inferiores de la app
    $$('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeArtistProfile();
        switchTab(btn.getAttribute('data-nav'));
      });
    });

    // Mini Player
    $('miniPlayer').addEventListener('click', (e) => {
      if (
        e.target.closest('#miniPlayBtn') ||
        e.target.closest('#miniNextBtn') ||
        e.target.closest('#miniLikeBtn')
      ) return;
      openFullPlayer();
    });

    $('miniLikeBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (S.currentIndex >= 0) toggleLike(S.queue[S.currentIndex]);
    });

    $('miniPlayBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlayPause();
    });

    $('miniNextBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      playNext(true);
    });

    // Cerrar pantalla completa
    $('playerCloseBtn')?.addEventListener('click', () => {
      closeFullPlayer();
    });

    // Subpestañas del Full Player
    $('tabTrackBtn').addEventListener('click', () => switchPlayerSubTab('track'));
    $('tabQueueBtn').addEventListener('click', () => switchPlayerSubTab('queue'));
    $('tabLyricsBtn').addEventListener('click', () => switchPlayerSubTab('lyrics'));
    $('tabSimilarBtn').addEventListener('click', () => switchPlayerSubTab('similar'));
    $('similarReloadBtn')?.addEventListener('click', () => {
      if (S.currentIndex >= 0) loadSimilarTracks(S.queue[S.currentIndex]);
    });

    // Botones de reproducción
    $('playerPlayBtn').addEventListener('click', togglePlayPause);
    $('playerNextBtn').addEventListener('click', () => playNext(true));
    $('playerPrevBtn').addEventListener('click', playPrev);

    // Like, Descarga y Playlist en Full Player
    $('playerLikeBtn').addEventListener('click', () => {
      if (S.currentIndex >= 0) toggleLike(S.queue[S.currentIndex]);
    });
    $('playerDownloadBtn')?.addEventListener('click', () => {
      if (S.currentIndex >= 0) toggleDownload(S.queue[S.currentIndex]);
    });
    $('playerAddPlaylistBtn').addEventListener('click', () => openPlaylistModal());

    // Botón Compartir Verso en Historia (Canvas)
    $('btnShareLyrics')?.addEventListener('click', shareLyricsCard);
    $('storyShareCloseBtn')?.addEventListener('click', closeStoryShareModal);
    $('storyShareNativeBtn')?.addEventListener('click', shareStoryNative);
    $('storyShareDownloadBtn')?.addEventListener('click', () => {
      if (!storyShareState.blob) return;
      downloadBlob(storyShareState.blob, storyShareState.filename);
      showToast('✓ Imagen descargada para compartir');
    });
    $('storyShareCopyBtn')?.addEventListener('click', copyStoryImage);
    setupLyricsView();

    // Botón Limpiar Cola
    $('queueClearBtn')?.addEventListener('click', () => {
      if (S.queue.length > S.currentIndex + 1) {
        S.queue = S.queue.slice(0, S.currentIndex + 1);
        renderQueue();
        showToast('Cola de reproducción limpiada');
      } else {
        showToast('La cola ya está vacía');
      }
    });

    // Menú de 3 puntos ••• del Full Player (abre Bottom Sheet estilo Spotify)
    $('playerMenuBtn').addEventListener('click', () => openSongMenu());

    // Eventos del Bottom Sheet de Canción
    $('songMenuCloseBtn').addEventListener('click', closeSongMenu);
    $('songMenuModal').addEventListener('click', (e) => {
      if (e.target.id === 'songMenuModal') closeSongMenu();
    });

    $('menuDownloadBtn')?.addEventListener('click', () => {
      if (S.menuTargetTrack) toggleDownload(S.menuTargetTrack);
      closeSongMenu();
    });

    $('menuViewArtistBtn')?.addEventListener('click', () => {
      if (S.menuTargetTrack) {
        const a = S.menuTargetTrack.artist;
        const th = S.menuTargetTrack.thumbnail;
        closeSongMenu();
        openArtistPage(a, th);
      }
    });

    $$('.speed-opt-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const spd = parseFloat(btn.getAttribute('data-speed'));
        setPlaybackRate(spd);
      });
    });

    $('menuPlayNextBtn').addEventListener('click', () => {
      if (S.menuTargetTrack) {
        S.queue.splice(S.currentIndex + 1, 0, S.menuTargetTrack);
        renderQueue();
        showToast('Se reproducirá a continuación');
      }
      closeSongMenu();
    });

    $('menuAddQueueBtn').addEventListener('click', () => {
      if (S.menuTargetTrack) {
        S.queue.push(S.menuTargetTrack);
        renderQueue();
        showToast('Añadida al final de la cola');
      }
      closeSongMenu();
    });

    $('menuAddPlaylistBtn').addEventListener('click', () => {
      const t = S.menuTargetTrack;
      closeSongMenu();
      openPlaylistModal(t);
    });

    $('menuArtistRadioBtn').addEventListener('click', () => {
      if (S.menuTargetTrack) {
        const track = S.menuTargetTrack;
        closeSongMenu();
        haptic('light');
        startArtistRadio(track.artist, track.id);
      }
    });

    $('menuSleepTimerBtn').addEventListener('click', () => {
      closeSongMenu();
      openSleepTimerModal();
    });

    $('menuShareBtn').addEventListener('click', () => {
      shareTrack(S.menuTargetTrack);
      closeSongMenu();
    });

    // Barra de búsqueda seek (Scrubber)
    const seekEl = $('playerSeek');
    seekEl.addEventListener('pointerdown', () => { isScrubbing = true; });
    seekEl.addEventListener('touchstart', () => { isScrubbing = true; }, { passive: true });
    seekEl.addEventListener('pointerup', () => { isScrubbing = false; });
    seekEl.addEventListener('touchend', () => { isScrubbing = false; }, { passive: true });
    seekEl.addEventListener('change', () => { isScrubbing = false; });

    seekEl.addEventListener('input', (e) => {
      const pct = parseFloat(e.target.value);
      if (isYtMode && ytPlayer && typeof ytPlayer.seekTo === 'function') {
        const dur = ytPlayer.getDuration() || (S.currentTrack && S.currentTrack.duration) || 0;
        if (dur > 0) {
          ytPlayer.seekTo((pct / 100) * dur, true);
        }
        return;
      }
      const p = getActivePlayer();
      const track = S.queue[S.currentIndex];
      const dur = getEffectiveDuration(p, track);
      if (p && dur > 0) {
        p.currentTime = (pct / 100) * dur;
      }
    });

    // Smart Shuffle ✨ (3 Estados: Off -> Normal -> Smart ✨)
    const shuffleBtn = $('playerShuffleBtn');

    shuffleBtn.addEventListener('click', () => {
      S.shuffleMode = (S.shuffleMode + 1) % 3;
      syncShuffleButton();
      if (S.shuffleMode === 0) showToast('Aleatorio desactivado');
      else if (S.shuffleMode === 1) showToast('Aleatorio normal activado');
      else showToast('✨ Smart Shuffle activado (Recomendaciones dinámicas)');
    });

    // Repetición
    $('playerRepeatBtn').addEventListener('click', () => {
      if (S.repeat === 'off') S.repeat = 'all';
      else if (S.repeat === 'all') S.repeat = 'one';
      else S.repeat = 'off';

      syncRepeatButton();
      if (S.repeat === 'one') showToast('Repetir una canción');
      else if (S.repeat === 'all') showToast('Repetir lista completa');
      else showToast('Repetición desactivada');
    });

    // Filtros de Biblioteca
    const setLibFilter = (key) => {
      S.libFilter = key;
      S.libSearch = '';
      S.openPlaylistId = null;
      const input = $('libSearchInput');
      if (input) input.value = '';
      $('libSearchClear')?.classList.add('hidden');
      haptic('light');
      renderLibrary();
    };
    $('libFilterLikes').addEventListener('click', () => setLibFilter('likes'));
    $('libFilterDownloads')?.addEventListener('click', () => setLibFilter('downloads'));
    $('libFilterPlaylists').addEventListener('click', () => setLibFilter('playlists'));
    $('libFilterHistory').addEventListener('click', () => setLibFilter('history'));
    $('libFilterStats').addEventListener('click', () => setLibFilter('stats'));
    $('libDownloadAllBtn')?.addEventListener('click', downloadAllFavorites);

    // Modo "Tu DJ IA ✨"
    $('btnDjVibe')?.addEventListener('click', cycleDjVibe);
    $('homeDjCard')?.addEventListener('click', startDjSession);

    // Modal: Perfil del Artista Completo
    $('artistCloseBtn')?.addEventListener('click', closeArtistProfile);
    $('artistBackBtn')?.addEventListener('click', closeArtistProfile);

    // Modal: Vista de Álbum / Playlist Colección (SimpMusic Engine)
    $('collectionCloseBtn')?.addEventListener('click', closeCollection);
    $('collectionPlayAllBtn')?.addEventListener('click', () => {
      if (currentCollectionTracks.length > 0) {
        S.queue = [...currentCollectionTracks];
        playTrack(0, true);
      } else {
        showToast('No hay canciones en la colección');
      }
    });
    $('collectionShuffleAllBtn')?.addEventListener('click', () => {
      if (currentCollectionTracks.length > 0) {
        S.queue = shuffled(currentCollectionTracks);
        playTrack(0, true);
        showToast('Reproduciendo en aleatorio');
      } else {
        showToast('No hay canciones en la colección');
      }
    });
    $('collectionDownloadAllBtn')?.addEventListener('click', () => {
      const title = $('collectionHeroTitle')?.textContent || 'esta colección';
      downloadTracksList(currentCollectionTracks, title);
    });
    $('collectionShareBtn')?.addEventListener('click', () => {
      const title = $('collectionHeroTitle')?.textContent || 'Colección';
      if (navigator.share) {
        navigator.share({
          title: `${title} en FreeSong`,
          text: `Escucha "${title}" en FreeSong`,
          url: window.location.origin
        }).catch(() => {});
      } else {
        navigator.clipboard?.writeText(window.location.origin);
        showToast(`Enlace de ${title} copiado`);
      }
    });

    $('artistPlayBtn')?.addEventListener('click', () => {
      if (currentArtistTracks.length > 0) {
        S.queue = [...currentArtistTracks];
        playTrack(0, true);
      }
    });

    $('artistShuffleBtn')?.addEventListener('click', () => {
      if (currentArtistTracks.length > 0) {
        S.queue = shuffled(currentArtistTracks);
        playTrack(0, true);
        showToast('Reproduciendo canciones del artista en aleatorio');
      }
    });

    $('artistRadioBtn')?.addEventListener('click', () => {
      const name = $('artistHeroName')?.textContent;
      if (name) startArtistRadio(name);
    });

    $('artistShareBtn')?.addEventListener('click', () => {
      const name = $('artistHeroName')?.textContent;
      if (navigator.share) {
        navigator.share({
          title: `${name} en FreeSong`,
          text: `Escucha los mejores temas de ${name} en FreeSong`,
          url: window.location.origin
        }).catch(() => {});
      } else {
        navigator.clipboard?.writeText(window.location.origin);
        showToast(`Enlace de ${name} copiado`);
      }
    });

    // Delegación global para enlaces de Artista (.artist-link)
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.artist-link');
      if (link) {
        e.stopPropagation();
        const a = link.getAttribute('data-artist') || link.textContent.trim();
        const th = link.getAttribute('data-thumb') || '';
        openArtistPage(a, th);
      }
    });

    // Clicks en nombres de artista en reproductores
    $('miniArtist')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = S.queue[S.currentIndex];
      if (cur) openArtistPage(cur.artist, cur.thumbnail);
    });

    $('playerArtist')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = S.queue[S.currentIndex];
      if (cur) openArtistPage(cur.artist, cur.thumbnail);
    });

    $('songMenuArtist')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (S.menuTargetTrack) {
        const a = S.menuTargetTrack.artist;
        const th = S.menuTargetTrack.thumbnail;
        closeSongMenu();
        openArtistPage(a, th);
      }
    });

    // Ordenación de Biblioteca
    $('libSortSelect').addEventListener('change', (e) => {
      S.libSort = e.target.value;
      renderLibrary();
    });

    // Reproducir todo / Aleatorio en Biblioteca
    $('libPlayAllBtn').addEventListener('click', () => {
      const tracks = getFilteredLibraryTracks();
      if (tracks.length > 0) {
        S.queue = [...tracks];
        playTrack(0, true);
      } else {
        showToast('No hay canciones para reproducir');
      }
    });

    $('libShuffleAllBtn').addEventListener('click', () => {
      const tracks = getFilteredLibraryTracks();
      if (tracks.length > 0) {
        S.queue = shuffled(tracks);
        playTrack(0, true);
        showToast('Reproduciendo en aleatorio');
      } else {
        showToast('No hay canciones para reproducir');
      }
    });

    // Sleep Timer modal events
    $('sleepTimerBadge').addEventListener('click', openSleepTimerModal);
    $('playerSleepBadge')?.addEventListener('click', openSleepTimerModal);
    $('settingSleepTimerBtn').addEventListener('click', openSleepTimerModal);
    $('sleepTimerCloseBtn').addEventListener('click', closeSleepTimerModal);
    $('sleepTimerModal').addEventListener('click', (e) => {
      if (e.target.id === 'sleepTimerModal') closeSleepTimerModal();
    });

    $$('.sleep-opt-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-sleep');
        startSleepTimer(val);
      });
    });

    // Playlist modal events
    $('libNewPlaylistBtn').addEventListener('click', () => {
      setLibFilter('playlists');
      openPlaylistModal(null, { mode: 'create' });
    });

    // Buscador dentro de la biblioteca
    const libSearchInput = $('libSearchInput');
    if (libSearchInput) {
      let libSearchTimer = null;
      libSearchInput.addEventListener('input', () => {
        S.libSearch = libSearchInput.value;
        $('libSearchClear')?.classList.toggle('hidden', !S.libSearch.trim());
        clearTimeout(libSearchTimer);
        // Pequeño debounce: evita re-renderizar en cada tecla en móviles lentos.
        libSearchTimer = setTimeout(renderLibrary, 120);
      });
      libSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          libSearchInput.blur();
          renderLibrary();
        }
      });
    }
    $('libSearchClear')?.addEventListener('click', () => {
      S.libSearch = '';
      if (libSearchInput) libSearchInput.value = '';
      $('libSearchClear')?.classList.add('hidden');
      renderLibrary();
      libSearchInput?.focus();
    });

    // Importador de playlists (Spotify / YouTube)
    $('libImportBtn')?.addEventListener('click', openImportPlaylistModal);
    $('importPlaylistCloseBtn')?.addEventListener('click', closeImportPlaylistModal);
    $('importPlaylistCancelBtn')?.addEventListener('click', closeImportPlaylistModal);
    $('importPlaylistStartBtn')?.addEventListener('click', importPlaylistFromUrl);
    $('importPlaylistModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'importPlaylistModal') closeImportPlaylistModal();
    });
    $('importPlaylistUrl')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        importPlaylistFromUrl();
      }
    });

    $('playlistModalCloseBtn').addEventListener('click', closePlaylistModal);
    $('playlistModal').addEventListener('click', (e) => {
      if (e.target.id === 'playlistModal') closePlaylistModal();
    });
    $('createPlaylistConfirmBtn').addEventListener('click', submitPlaylistModal);
    $('newPlaylistInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitPlaylistModal();
      }
    });

    // Ajustes de Crossfade
    const xfToggle = $('settingCrossfadeToggle');
    const xfRange = $('settingCrossfadeRange');
    const xfLabel = $('crossfadeDurationLabel');
    const xfWrap = $('crossfadeSliderWrap');

    xfToggle.checked = S.crossfade;
    xfRange.value = S.crossfadeDuration;
    xfLabel.textContent = `${S.crossfadeDuration} segundos`;
    xfWrap.classList.toggle('hidden', !S.crossfade);

    xfToggle.addEventListener('change', () => {
      S.crossfade = xfToggle.checked;
      localStorage.setItem('fs_crossfade', S.crossfade.toString());
      xfWrap.classList.toggle('hidden', !S.crossfade);
    });

    xfRange.addEventListener('input', () => {
      S.crossfadeDuration = parseInt(xfRange.value, 10);
      xfLabel.textContent = `${S.crossfadeDuration} segundos`;
      localStorage.setItem('fs_crossfade_dur', S.crossfadeDuration.toString());
    });

    // Ajustes de aspecto personalizables (aurora, haptics, micro-fundido)
    const auroraToggle = $('settingAuroraToggle');
    const auroraRange = $('settingAuroraRange');
    const auroraLabel = $('auroraIntensityLabel');
    const auroraWrap = $('auroraSliderWrap');
    const hapticsToggle = $('settingHapticsToggle');
    const fadeToggle = $('settingFadeToggle');

    if (auroraToggle) {
      auroraToggle.checked = S.auroraEnabled;
      auroraWrap?.classList.toggle('hidden', !S.auroraEnabled);
      auroraToggle.addEventListener('change', () => {
        S.auroraEnabled = auroraToggle.checked;
        auroraWrap?.classList.toggle('hidden', !S.auroraEnabled);
        saveVisualPrefs();
        applyVisualSettings();
        haptic('light');
      });
    }

    if (auroraRange) {
      auroraRange.value = Math.round(S.auroraIntensity * 100);
      if (auroraLabel) auroraLabel.textContent = `${Math.round(S.auroraIntensity * 100)}%`;
      auroraRange.addEventListener('input', () => {
        const pct = parseInt(auroraRange.value, 10);
        S.auroraIntensity = Math.max(0.1, Math.min(1, pct / 100));
        if (auroraLabel) auroraLabel.textContent = `${pct}%`;
        applyVisualSettings();
        saveVisualPrefs();
      });
    }

    if (hapticsToggle) {
      hapticsToggle.checked = S.haptics;
      hapticsToggle.addEventListener('change', () => {
        S.haptics = hapticsToggle.checked;
        saveVisualPrefs();
        if (S.haptics) haptic('success');
      });
    }

    if (fadeToggle) {
      fadeToggle.checked = S.audioFade;
      fadeToggle.addEventListener('change', () => {
        S.audioFade = fadeToggle.checked;
        saveVisualPrefs();
        haptic('light');
      });
    }

    applyVisualSettings();

    // Ajustes de Normalización, Autoplay y Calidad
    $('settingNormalizeToggle').checked = S.audioNormalize;
    $('settingNormalizeToggle').addEventListener('change', (e) => {
      S.audioNormalize = e.target.checked;
      localStorage.setItem('fs_normalize', S.audioNormalize.toString());
      const p = getActivePlayer();
      if (p) p.volume = S.audioNormalize ? 0.88 : 1.0;
      showToast(S.audioNormalize ? 'Normalización activada' : 'Normalización desactivada');
    });

    $('settingAutoplayToggle').checked = S.autoplayInfinite;
    $('settingAutoplayToggle').addEventListener('change', (e) => {
      S.autoplayInfinite = e.target.checked;
      localStorage.setItem('fs_autoplay', S.autoplayInfinite.toString());
      showToast(S.autoplayInfinite ? 'Autoplay infinito activado' : 'Autoplay desactivado');
    });

    $('settingQualitySelect').value = S.audioQuality;
    $('settingQualitySelect').addEventListener('change', (e) => {
      S.audioQuality = e.target.value;
      localStorage.setItem('fs_quality', S.audioQuality);
      showToast(S.audioQuality === '140' ? 'Calidad Alta (AAC 128k)' : 'Ahorro de datos (AAC 48k)');
    });

    // Copia de seguridad: Exportar / Importar
    $('btnExportBackup').addEventListener('click', exportLibraryBackup);
    $('btnImportBackup').addEventListener('click', () => $('importBackupFileInput').click());
    $('importBackupFileInput').addEventListener('change', handleImportBackup);

    // Estado del servicio (diagnóstico del motor de audio)
    $('healthCheckBtn')?.addEventListener('click', checkServiceHealth);
    $('diagResetBtn')?.addEventListener('click', resetDiagnostics);
    $('diagCopyBtn')?.addEventListener('click', copyDiagnostics);

    // Restablecer datos
    $('btnClearData').addEventListener('click', async () => {
      if (confirm('¿Deseas restablecer todos tus datos locales (favoritos, historial, playlists y descargas)?')) {
        localStorage.clear();
        S.favorites = [];
        S.history = [];
        S.playlists = [];
        S.downloads = [];
        S.recentSearches = [];
        S.stats = { totalPlays: 0, songs: {}, artists: {} };
        S.offlineBlobUrls.forEach((url) => {
          try { URL.revokeObjectURL(url); } catch {}
        });
        S.offlineBlobUrls.clear();
        if ('caches' in window) {
          try { await caches.delete('freesong-offline-audio-v1'); } catch {}
        }
        renderLibrary();
        showToast('Datos restablecidos con éxito');
      }
    });

    // Banner PWA para iPhone / Safari
    const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    const pwaDismissed = localStorage.getItem('fs_pwa_dismissed') === 'true';
    const pwaBanner = $('pwaBanner');
    if (pwaBanner && isIOS && !isStandalone && !pwaDismissed) {
      pwaBanner.classList.remove('hidden');
    }
    const pwaClose = $('pwaBannerClose');
    if (pwaClose) {
      pwaClose.addEventListener('click', () => {
        if (pwaBanner) pwaBanner.classList.add('hidden');
        localStorage.setItem('fs_pwa_dismissed', 'true');
      });
    }

    // Gestos táctiles
    setupGestures();
    setupQueueGestures();
  }

  // --- Saludo Dinámico según la hora ---
  function updateGreeting() {
    const el = $('headerGreeting');
    if (!el) return;
    const hour = new Date().getHours();
    let text = 'FreeSong';
    if (hour >= 5 && hour < 12) text = 'Buenos días';
    else if (hour >= 12 && hour < 20) text = 'Buenas tardes';
    else text = 'Buenas noches';
    el.textContent = text;
  }

  // --- Manejo Global de Modales, Botón Atrás (History API) y Tecla Escape ---
  function closeTopModal() {
    const songMenu = $('songMenuModal');
    if (songMenu && !songMenu.classList.contains('hidden')) {
      closeSongMenu();
      return true;
    }
    const plModal = $('playlistModal');
    if (plModal && !plModal.classList.contains('hidden')) {
      closePlaylistModal();
      return true;
    }
    const importModal = $('importPlaylistModal');
    if (importModal && !importModal.classList.contains('hidden')) {
      closeImportPlaylistModal();
      return true;
    }
    const sleepModal = $('sleepTimerModal');
    if (sleepModal && !sleepModal.classList.contains('hidden')) {
      closeSleepTimerModal();
      return true;
    }
    const storyModal = $('storyShareModal');
    if (storyModal && !storyModal.classList.contains('hidden')) {
      closeStoryShareModal();
      return true;
    }
    const fullPlayer = $('fullPlayerSheet');
    if (fullPlayer && !fullPlayer.classList.contains('translate-y-full')) {
      closeFullPlayer();
      return true;
    }
    const artistModal = $('artistViewModal');
    if (artistModal && !artistModal.classList.contains('hidden')) {
      closeArtistProfile();
      return true;
    }
    const collModal = $('collectionModal');
    if (collModal && !collModal.classList.contains('hidden')) {
      closeCollection();
      return true;
    }
    return false;
  }

  window.addEventListener('popstate', () => {
    // Retroceso que provocamos nosotros al cerrar un panel: ya no hay nada más que cerrar
    if (popGuard > 0) {
      popGuard--;
      if (popGuard === 0) {
        pendingPushes.splice(0).forEach((name) => {
          try { history.pushState({ modal: name }, ''); } catch {}
        });
      }
      return;
    }
    inPopstate = true;
    try {
      closeTopModal();
    } finally {
      inPopstate = false;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTopModal();
      return;
    }

    // Atajos de teclado (escritorio): no se activan al escribir ni sobre controles que ya usan estas teclas
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag) || (e.target && e.target.isContentEditable)) return;

    if (e.key === ' ' || e.code === 'Space') {
      if (S.currentIndex < 0) return;
      e.preventDefault();
      togglePlayPause();
    } else if (e.key === 'ArrowRight' && e.shiftKey) {
      playNext(true);
    } else if (e.key === 'ArrowLeft' && e.shiftKey) {
      playPrev();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const p = getActivePlayer();
      if (p && isFinite(p.duration)) {
        p.currentTime = Math.max(0, Math.min(p.duration, p.currentTime + (e.key === 'ArrowRight' ? 5 : -5)));
      }
    }
  });

  // --- Inicialización ---
  document.addEventListener('DOMContentLoaded', () => {
    initYouTubeEngine();
    setupAudioSession();
    updateGreeting();
    bindEvents();
    syncRepeatButton();
    syncShuffleButton();
    setupSearch();
    renderLibrary();
    loadHomeContent('todo');
    initOfflineBlobs();

    // Estado de la copia de seguridad y recordatorio si hace tiempo no se exporta.
    renderBackupStatus();
    setTimeout(maybeRemindBackup, 1800);

    // Restaurar la sesión completa (cola, pista, posición y ajustes). Si no hay
    // sesión guardada, al menos muestra la última canción escuchada.
    if (!restoreSession()) {
      try {
        const savedTrack = localStorage.getItem('fs_last_track');
        if (savedTrack) {
          const lastTrack = JSON.parse(savedTrack);
          if (lastTrack && lastTrack.id) {
            S.currentTrack = lastTrack;
            S.queue = [lastTrack];
            S.currentIndex = 0;
            showAndSyncMiniPlayer(lastTrack, false);
            updatePlayPauseIcons(false);
          }
        }
      } catch (e) {
        console.warn('Error al restaurar última canción:', e);
      }
    }

    // Deja resuelta la URL directa de la pista en pantalla (y la siguiente) para
    // que el primer toque en Reproducir arranque por relay sin esperar a Vercel.
    if (S.currentTrack && S.currentTrack.id) {
      const upcoming = [S.currentTrack];
      const nextIdx = getNextIndex();
      if (nextIdx >= 0 && nextIdx !== S.currentIndex && S.queue[nextIdx]) {
        upcoming.push(S.queue[nextIdx]);
      }
      prewarmTracks(upcoming);
      // Deja también la letra de la pista restaurada lista antes de abrir Letras.
      prefetchLyrics(S.currentTrack);
    }

    // Reproducción directa por URL (?track=VIDEO_ID)
    const params = new URLSearchParams(window.location.search);
    const trackParam = params.get('track');
    if (trackParam) {
      fetch(`/api/search?q=${encodeURIComponent(trackParam)}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.tracks && d.tracks.length > 0) {
            S.queue = [d.tracks[0]];
            playTrack(0, true);
          }
        })
        .catch(() => {});
    }

    setupPwaUpdates();
  });

})();

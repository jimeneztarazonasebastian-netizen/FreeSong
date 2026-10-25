// FreeSong Web Music Player v3.0.0 Ultra Spotify Premium para iPhone (iOS) y Web
// Motores: Audio Blindado Edge CDN, Modo Offline Cache API, Perfil de Artista, DJ IA ✨, Live Search y Canvas Lyrics Share
(() => {
  'use strict';

  // Detección precisa de iOS (iPhone, iPad, iPod, y Safari en iOS modernos)
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || ('ontouchend' in document);

  // --- Bloqueo global de Zoom en iOS Safari (Pinch-to-zoom y Doble Tap) ---
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1 || (e.scale && e.scale !== 1)) {
      e.preventDefault();
    }
  }, { passive: false });

  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
      e.preventDefault();
    }
    lastTouchEnd = now;
  }, { passive: false });

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
    isDownloadingMap: {},
    recentSearches: JSON.parse(localStorage.getItem('fs_recent_searches') || '[]'),
    djVibeIndex: 0,
    history: JSON.parse(localStorage.getItem('fs_history') || '[]'),
    playlists: JSON.parse(localStorage.getItem('fs_playlists') || '[]'),
    stats: JSON.parse(localStorage.getItem('fs_stats') || '{"totalPlays":0,"songs":{},"artists":{}}'),
    playbackRate: 1.0,
    audioQuality: localStorage.getItem('fs_quality') || '140',
    audioNormalize: localStorage.getItem('fs_normalize') !== 'false',
    autoplayInfinite: localStorage.getItem('fs_autoplay') !== 'false',
    smartShuffleInjectCount: 0,
    syncedLyrics: [],
    currentLyricIdx: -1,
    activeTab: 'home',
    activeChip: 'todo',
    activePlayerSubTab: 'track', // 'track', 'queue', 'lyrics', 'similar'
    libFilter: 'likes', // 'likes', 'downloads', 'playlists', 'history', 'stats'
    libSort: 'recent',
    menuTargetTrack: null,
    sleepTimerMinutes: null,
    sleepTimerEndTrack: false,
    sleepTimerInterval: null,
    sleepTimerRemainingSec: 0
  };

  // Cargar configuración guardada
  const savedXf = localStorage.getItem('fs_crossfade');
  if (savedXf !== null) S.crossfade = savedXf === 'true';
  const savedXfDur = localStorage.getItem('fs_crossfade_dur');
  if (savedXfDur) S.crossfadeDuration = parseInt(savedXfDur, 10);

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
  let userIntentionalPause = false;
  let isScrubbing = false;
  let streamWatchdogTimer = null;

  function getActivePlayer() {
    return audioDecks[activeDeckIdx];
  }

  function getInactivePlayer() {
    return audioDecks[1 - activeDeckIdx];
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

    if (official > 0) return official;
    if (!raw || isNaN(raw) || raw <= 0) return 0;
    if (isIOS && raw > 180) return Math.round(raw / 2);
    return Math.round(raw);
  }

  function enrichTrackDuration(track) {
    if (!track || (track.duration && track.duration > 0)) return;
    const q = `${track.title} ${track.artist || ''}`.trim();
    fetch(`/api/search?q=${encodeURIComponent(q)}`)
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

    document.documentElement.style.setProperty('--ambient-glow', `rgba(${r}, ${g}, ${b}, 0.32)`);
    document.documentElement.style.setProperty('--mini-ambient', `rgba(${r}, ${g}, ${b}, 0.22)`);
    document.documentElement.style.setProperty('--tint', `${r} ${g} ${b}`);
  }

  // --- Manejo de Fallback Automático en Fallas de Audio (Watchdog Inteligente) ---
  function handleStreamFailure(track, deck) {
    if (!track) return;
    if (!track._fallbackStep) track._fallbackStep = 1;
    else track._fallbackStep++;

    console.warn(`[FreeSong Fallback] Intentando paso ${track._fallbackStep} para "${track.title}"...`);

    if (track._fallbackStep === 1) {
      showToast('Optimizando audio con servidor ultra-rápido...');
      const fallbackUrl = `/api/stream?id=${encodeURIComponent(track.id)}&itag=139&backup=1`;
      deck.src = fallbackUrl;
      deck.play().catch(() => {});
    } else if (track._fallbackStep === 2) {
      showToast('Conectando a nodo alternativo...');
      const fallbackUrl2 = `/api/stream?id=${encodeURIComponent(track.id)}&itag=139&backup=3`;
      deck.src = fallbackUrl2;
      deck.play().catch(() => {});
    } else {
      track._fallbackStep = 0;
      showToast('Servidor ocupado. Pasando a la siguiente canción...');
      setTimeout(() => playNext(true), 1200);
    }
  }

  // --- Salvaguarda de Cambio de Visibilidad (Segundo Plano en iOS) ---
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (isCrossfading) {
        if (fadeInterval) clearInterval(fadeInterval);
        isCrossfading = false;
        const activeP = getActivePlayer();
        if (activeP) activeP.volume = S.audioNormalize ? 0.88 : 1;
      }
      if (S.isPlaying && !userIntentionalPause) {
        const activeP = getActivePlayer();
        if (activeP && activeP.paused) {
          activeP.play().catch(() => {});
        }
      }
    }
  });

  // --- Eventos del Reproductor HTML5 ---
  let isTransitioningTrack = false;
  let trackTransitionTimeout = null;

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
      if (S.queue[S.currentIndex]) {
        S.queue[S.currentIndex]._fallbackStep = 0;
      }
      S.isPlaying = true;
      updatePlayPauseIcons(true, false);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    });

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
        updatePlayPauseIcons(false);
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

        // Corte exacto al final (evitar silencio de 3 minutos de DASH) con guardia de transición
        if (cur >= dur - 0.8 && dur > 5 && !isTransitioningTrack) {
          handleTrackFinished();
          return;
        }

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
    });

    // Errores o bloqueos en la conexión
    deck.addEventListener('error', (e) => {
      if (idx === activeDeckIdx && S.currentIndex >= 0 && S.isPlaying && !userIntentionalPause && !isTransitioningTrack) {
        console.warn('Error en deck de audio:', e);
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
          { src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' },
          { src: track.thumbnail, sizes: '256x256', type: 'image/jpeg' },
          { src: track.thumbnail, sizes: '128x128', type: 'image/jpeg' }
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
  function getNextIndex() {
    if (S.queue.length === 0) return -1;
    if (S.repeat === 'one') return S.currentIndex;
    let next = S.currentIndex + 1;
    if (S.shuffleMode > 0) {
      next = Math.floor(Math.random() * S.queue.length);
      if (next === S.currentIndex && S.queue.length > 1) {
        next = (next + 1) % S.queue.length;
      }
    }
    if (next >= S.queue.length) {
      next = 0;
    }
    return next;
  }

  function prewarmTracks(tracks) {
    if (!tracks || !Array.isArray(tracks)) return;
    tracks.slice(0, 2).forEach((t) => {
      if (t && t.id) {
        fetch(`/api/stream?id=${encodeURIComponent(t.id)}`, {
          headers: { Range: 'bytes=0-1024' }
        }).catch(() => {});
      }
    });
  }

  function prefetchNextTrack() {
    const nextIdx = getNextIndex();
    if (nextIdx < 0 || nextIdx >= S.queue.length || nextIdx === S.currentIndex) return;
    const nextTrack = S.queue[nextIdx];
    if (!nextTrack) return;

    prewarmTracks([nextTrack]);
    if (nextTrack.streamUrl) return;

    const targetUrl = `/api/stream?id=${encodeURIComponent(nextTrack.id)}&itag=${S.audioQuality}`;
    nextTrack.streamUrl = targetUrl;

    try {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'fetch';
      link.href = targetUrl;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    } catch {}

    if (!isBackground() && !isIOS) {
      const inact = getInactivePlayer();
      if (inact && inact.paused) {
        inact.src = targetUrl;
        inact.preload = 'auto';
        inact.muted = true;
      }
    }
  }

  // --- Autoplay Continuo: Recomendaciones Infinitas ---
  let isFetchingRelated = false;
  async function ensureUpcomingTracks(track) {
    if (!S.autoplayInfinite || !track || isFetchingRelated) return;
    const remaining = S.queue.length - 1 - S.currentIndex;
    if (remaining < 4) {
      isFetchingRelated = true;
      try {
        const query = track.artist && track.artist !== 'Artista'
          ? `${track.artist} exitos canciones`
          : `${track.title} mix`;
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (data.tracks && data.tracks.length > 0) {
          const existingIds = new Set(S.queue.map((t) => t.id));
          const newTracks = data.tracks.filter((t) => !existingIds.has(t.id));
          if (newTracks.length > 0) {
            S.queue.push(...newTracks);
            renderQueue();
          }
        }
      } catch (err) {
        console.error('Error al cargar recomendaciones continuas:', err);
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

  async function downloadTrack(track) {
    if (!track || !track.id) return;
    if (S.isDownloadingMap[track.id]) {
      showToast('Ya se está descargando esta canción');
      return;
    }
    S.isDownloadingMap[track.id] = true;
    showToast(`Descargando "${track.title}"...`, 3000);

    try {
      const streamUrl = `/api/stream?id=${encodeURIComponent(track.id)}&itag=${S.audioQuality}`;
      const res = await fetch(streamUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const blob = await res.blob();
      if (!blob || blob.size < 1000) throw new Error('Blob de audio inválido');

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
      showToast(`Error al descargar "${track.title}"`);
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

  async function downloadAllFavorites() {
    if (!S.favorites || S.favorites.length === 0) {
      showToast('No tienes canciones favoritas para descargar');
      return;
    }
    const pending = S.favorites.filter((f) => !isDownloaded(f.id));
    if (pending.length === 0) {
      showToast('✓ Todas tus canciones favoritas ya están descargadas');
      return;
    }
    showToast(`Descargando ${pending.length} canciones favoritas...`, 3000);
    for (const t of pending) {
      await downloadTrack(t);
    }
    showToast(`✓ Todas tus favoritas (${pending.length}) descargadas`);
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
    if (index < 0 || index >= S.queue.length) {
      isTransitioningTrack = false;
      return;
    }
    S.currentIndex = index;
    const track = S.queue[index];
    S.currentTrack = track;
    localStorage.setItem('fs_last_track', JSON.stringify(track));

    userIntentionalPause = false;
    track._fallbackStep = 0;

    // 1. Mostrar y sincronizar inmediatamente el Mini-Player en el milisegundo 0 (antes de cualquier audio)
    showAndSyncMiniPlayer(track, true);

    // Reset inmediato de posición visual en la interfaz para la nueva pista
    if ($('playerCurTime')) $('playerCurTime').textContent = '0:00';
    if ($('playerSeek')) $('playerSeek').value = 0;
    if ($('miniProgress')) $('miniProgress').style.width = '0%';

    // 2. Comprobación 100% síncrona en memoria (0ms, NUNCA await antes de play)
    const offlineUrl = S.offlineBlobUrls instanceof Map ? S.offlineBlobUrls.get(track.id) : null;
    const streamUrl = track.streamUrl || offlineUrl || `/api/stream?id=${encodeURIComponent(track.id)}&itag=${S.audioQuality}`;

    // Actualizar UI y ambiente dinámico inmediatamente
    updatePlayerUI(track);
    applyDynamicColor(track);
    saveHistory(track);
    recordPlayStat(track);
    loadLyrics(track);
    loadSimilarTracks(track);
    updateMediaSession(track);
    ensureUpcomingTracks(track);
    enrichTrackDuration(track);

    const isBg = isBackground();
    const shouldCrossfade = S.crossfade && S.isPlaying && !immediate && !isIOS && !isBg;
    const outPlayer = getActivePlayer();
    const inPlayer = shouldCrossfade ? getInactivePlayer() : getActivePlayer();

    delete inPlayer.dataset.retried;
    delete inPlayer.dataset.prefetched;

    // Configurar volumen de normalización y velocidad
    const targetVolume = S.audioNormalize ? 0.88 : 1.0;

    try {
      if (shouldCrossfade) {
        inPlayer.muted = false;
        inPlayer.volume = 0;
        inPlayer.playbackRate = S.playbackRate;
        inPlayer.src = streamUrl;
        inPlayer.play().catch(() => {});
        performCrossfade(outPlayer, inPlayer, S.crossfadeDuration);
      } else {
        if (isCrossfading) {
          if (fadeInterval) clearInterval(fadeInterval);
          isCrossfading = false;
        }
        if (outPlayer && outPlayer !== inPlayer) {
          try {
            outPlayer.pause();
            outPlayer.currentTime = 0;
          } catch {}
        }
        inPlayer.muted = false;
        inPlayer.volume = targetVolume;
        inPlayer.playbackRate = S.playbackRate;

        // Reset de posición
        try { inPlayer.currentTime = 0; } catch {}

        // Asignación directa y síncrona en iOS Safari
        inPlayer.src = streamUrl;
        const playPromise = inPlayer.play();
        if (playPromise && playPromise.catch) {
          playPromise.catch((err) => {
            if (err.name !== 'AbortError') {
              console.warn('inPlayer play error:', err);
            }
          });
        }
      }

      S.isPlaying = true;
      updatePlayPauseIcons(true);

      // Iniciar Watchdog calibrado de 7 segundos contra canciones trabadas en 0:00 / 0:00
      if (streamWatchdogTimer) clearTimeout(streamWatchdogTimer);
      streamWatchdogTimer = setTimeout(() => {
        const p = getActivePlayer();
        if (!isTransitioningTrack && S.isPlaying && !userIntentionalPause && p && (p.currentTime === 0 || p.readyState < 2)) {
          console.warn('Watchdog de 7s disparado: Audio trabado en 0:00, ejecutando fallback...');
          handleStreamFailure(track, p);
        }
      }, 7000);

    } catch (err) {
      console.error('Error al reproducir pista:', err);
      isTransitioningTrack = false;
    }
  }

  // --- Curva de Crossfade Senoidal (Desktop) ---
  function performCrossfade(outP, inP, durationSec) {
    if (isCrossfading) clearInterval(fadeInterval);
    isCrossfading = true;

    const steps = 30;
    const stepTime = (durationSec * 1000) / steps;
    let currentStep = 0;
    const maxVol = S.audioNormalize ? 0.88 : 1.0;

    fadeInterval = setInterval(() => {
      currentStep++;
      const progress = currentStep / steps;

      const outVol = Math.cos((progress * Math.PI) / 2) * maxVol;
      const inVol = Math.sin((progress * Math.PI) / 2) * maxVol;

      try {
        outP.volume = Math.max(0, Math.min(maxVol, outVol));
        inP.volume = Math.max(0, Math.min(maxVol, inVol));
      } catch {}

      if (currentStep >= steps) {
        clearInterval(fadeInterval);
        try {
          outP.pause();
          outP.currentTime = 0;
          outP.volume = maxVol;
          inP.volume = maxVol;
        } catch {}
        activeDeckIdx = 1 - activeDeckIdx;
        isCrossfading = false;
      }
    }, stepTime);
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
    const p = getActivePlayer();
    if (p) p.pause();
    const inact = getInactivePlayer();
    if (inact) inact.pause();
    S.isPlaying = false;
    updatePlayPauseIcons(false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }

  function resumePlayback() {
    userIntentionalPause = false;
    if (S.currentIndex === -1 && S.queue.length > 0) {
      playTrack(0);
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
      p.play().catch(() => {});
      S.isPlaying = true;
      updatePlayPauseIcons(true);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    }
  }

  function togglePlayPause() {
    if (S.isPlaying) pausePlayback();
    else resumePlayback();
  }

  function playNext(immediate = false) {
    userIntentionalPause = false;
    if (S.queue.length === 0) {
      isTransitioningTrack = false;
      return;
    }
    if (S.repeat === 'one') {
      const p = getActivePlayer();
      if (p) {
        p.currentTime = 0;
        p.play().catch(() => {});
      }
      isTransitioningTrack = false;
      return;
    }
    const nextIdx = getNextIndex();
    if (nextIdx >= 0) {
      playTrack(nextIdx, typeof immediate === 'boolean' ? immediate : true);
    } else {
      isTransitioningTrack = false;
    }
  }

  function playPrev() {
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

  // --- Letras Sincronizadas (LRCLIB) ---
  async function loadLyrics(track) {
    const container = $('lyricsContainer');
    if (!container) return;
    container.innerHTML = '<p class="text-zinc-500 text-sm animate-pulse">Buscando letra sincronizada...</p>';
    S.syncedLyrics = [];
    S.currentLyricIdx = -1;

    try {
      const res = await fetch(`/api/lyrics?track=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist)}`);
      const data = await res.json();

      if (data.syncedLyrics) {
        S.syncedLyrics = parseLrc(data.syncedLyrics);
        renderLyrics(S.syncedLyrics);
      } else if (data.plainLyrics) {
        container.innerHTML = `<div class="text-zinc-300 text-sm leading-relaxed whitespace-pre-line py-4">${data.plainLyrics}</div>`;
      } else {
        container.innerHTML = '<p class="text-zinc-500 text-sm">Letra no disponible para esta canción</p>';
      }
    } catch {
      container.innerHTML = '<p class="text-zinc-500 text-sm">No se pudo cargar la letra</p>';
    }
  }

  function parseLrc(lrcText) {
    const lines = lrcText.split('\n');
    const result = [];
    const timeReg = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

    for (const line of lines) {
      const match = timeReg.exec(line);
      if (match) {
        const m = parseInt(match[1], 10);
        const s = parseInt(match[2], 10);
        const ms = parseFloat('0.' + match[3]);
        const time = m * 60 + s + ms;
        const text = line.replace(timeReg, '').trim();
        if (text) result.push({ time, text });
      }
    }
    return result;
  }

  function renderLyrics(lyricsList) {
    const container = $('lyricsContainer');
    container.innerHTML = lyricsList.map((item, idx) => `
      <p id="lyric-${idx}" class="lyric-line text-lg sm:text-xl font-bold text-zinc-500 py-1 transition-all duration-300 cursor-pointer hover:text-zinc-200">
        ${item.text}
      </p>
    `).join('');

    $$('.lyric-line').forEach((el, idx) => {
      el.addEventListener('click', () => {
        const p = getActivePlayer();
        if (p) p.currentTime = lyricsList[idx].time;
      });
    });
  }

  function syncLyricsWithTime(time) {
    let activeIdx = -1;
    for (let i = 0; i < S.syncedLyrics.length; i++) {
      if (time >= S.syncedLyrics[i].time) {
        activeIdx = i;
      } else {
        break;
      }
    }

    if (activeIdx !== S.currentLyricIdx && activeIdx !== -1) {
      S.currentLyricIdx = activeIdx;
      $$('.lyric-line').forEach((el, i) => {
        if (i === activeIdx) {
          el.className = 'lyric-line text-xl sm:text-2xl font-black py-1 transition-all duration-300 scale-105 origin-center text-emerald-400 drop-shadow-[0_0_15px_rgba(16,185,129,0.5)]';
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          el.className = 'lyric-line text-lg sm:text-xl font-bold text-zinc-500 py-1 transition-all duration-300 cursor-pointer hover:text-zinc-200';
        }
      });
    }
  }

  // --- Compartir Verso de Letra en Imagen (Canvas 2D para Historias de Instagram / WhatsApp) ---
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = text.split(' ');
    let line = '';
    let curY = y;
    for (let n = 0; n < words.length; n++) {
      const testLine = line + words[n] + ' ';
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && n > 0) {
        ctx.fillText(line, x, curY);
        line = words[n] + ' ';
        curY += lineHeight;
        if (curY > y + lineHeight * 3) break;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line, x, curY);
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

  async function shareLyricsCard() {
    const track = S.currentIndex >= 0 ? S.queue[S.currentIndex] : null;
    if (!track) {
      showToast('No hay ninguna canción sonando');
      return;
    }

    let line1 = '';
    let line2 = '';
    if (S.syncedLyrics && S.syncedLyrics.length > 0 && S.currentLyricIdx >= 0) {
      line1 = S.syncedLyrics[S.currentLyricIdx]?.text || '';
      line2 = S.syncedLyrics[S.currentLyricIdx + 1]?.text || '';
    }
    if (!line1) {
      line1 = track.title;
      line2 = track.artist || '';
    }

    showToast('Generando tarjeta de historia...', 1800);

    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Fondo degradado profundo Spotify
    const bgGrad = ctx.createLinearGradient(0, 0, 1080, 1080);
    bgGrad.addColorStop(0, '#091c14');
    bgGrad.addColorStop(0.5, '#050c09');
    bgGrad.addColorStop(1, '#020403');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, 1080, 1080);

    // Resplandor esmeralda central
    const glow = ctx.createRadialGradient(540, 480, 50, 540, 480, 500);
    glow.addColorStop(0, 'rgba(16, 185, 129, 0.22)');
    glow.addColorStop(0.6, 'rgba(16, 185, 129, 0.05)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 1080, 1080);

    // Tarjeta Glassmorphic
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 2;
    roundRect(ctx, 80, 80, 920, 920, 48);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Portada de la canción
    let coverLoaded = false;
    const coverImg = new Image();
    coverImg.crossOrigin = 'anonymous';
    coverImg.src = track.thumbnail;
    try {
      await new Promise((res) => {
        coverImg.onload = () => res();
        coverImg.onerror = () => res();
        setTimeout(res, 1200);
      });
      coverLoaded = coverImg.naturalWidth > 0;
    } catch {}

    // Encabezado Marca FreeSong
    ctx.save();
    ctx.font = 'bold 32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#10b981';
    ctx.fillText('FreeSong 🎵', 140, 160);

    ctx.font = '500 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fillText('LETRAS EN VIVO', 140, 195);
    ctx.restore();

    // Miniatura de Portada
    const coverX = 140;
    const coverY = 240;
    const coverSize = 130;
    if (coverLoaded) {
      ctx.save();
      roundRect(ctx, coverX, coverY, coverSize, coverSize, 24);
      ctx.clip();
      ctx.drawImage(coverImg, coverX, coverY, coverSize, coverSize);
      ctx.restore();
    } else {
      ctx.save();
      ctx.fillStyle = '#18181b';
      roundRect(ctx, coverX, coverY, coverSize, coverSize, 24);
      ctx.fill();
      ctx.restore();
    }

    // Título y Artista
    ctx.save();
    ctx.font = 'bold 38px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#ffffff';
    const cleanTitle = track.title.length > 28 ? track.title.slice(0, 26) + '...' : track.title;
    ctx.fillText(cleanTitle, 300, 300);

    ctx.font = '500 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#a1a1aa';
    const cleanArtist = (track.artist || 'Artista').length > 34 ? (track.artist || '').slice(0, 32) + '...' : (track.artist || '');
    ctx.fillText(cleanArtist, 300, 345);
    ctx.restore();

    // Comillas decorativas
    ctx.save();
    ctx.font = 'bold 110px Georgia, serif';
    ctx.fillStyle = 'rgba(16, 185, 129, 0.35)';
    ctx.fillText('“', 140, 480);
    ctx.restore();

    // Verso principal
    ctx.save();
    ctx.font = 'bold 50px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#f4f4f5';
    wrapText(ctx, line1, 140, 560, 800, 68);

    if (line2 && line2 !== line1) {
      ctx.font = '600 38px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = '#34d399';
      wrapText(ctx, line2, 140, 720, 800, 54);
    }
    ctx.restore();

    // Marca de agua pie
    ctx.save();
    ctx.font = '500 24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.textAlign = 'right';
    ctx.fillText('Escuchando en freesong.app', 940, 930);
    ctx.restore();

    canvas.toBlob(async (blob) => {
      if (!blob) {
        showToast('Error al generar la imagen');
        return;
      }
      const file = new File([blob], `freesong-${track.id}-verso.png`, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: `${track.title} - FreeSong`,
            text: `"${line1}" — ${track.title} de ${track.artist}`
          });
        } catch (err) {
          if (err.name !== 'AbortError') {
            downloadBlob(blob, file.name);
          }
        }
      } else {
        downloadBlob(blob, file.name);
        showToast('✓ Imagen descargada para compartir');
      }
    }, 'image/png');
  }

  // --- Subpestaña "Similares" Robusta ---
  async function loadSimilarTracks(track) {
    const container = $('similarList');
    if (!container) return;
    const targetTrack = track || S.queue[S.currentIndex];
    if (!targetTrack) return;

    container.innerHTML = '<p class="text-zinc-500 text-xs py-8 text-center animate-pulse">Buscando canciones similares...</p>';

    try {
      const q = targetTrack.artist && targetTrack.artist !== 'Artista'
        ? `${targetTrack.artist} exitos`
        : `${targetTrack.title} mix`;
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();

      if (!data.tracks || data.tracks.length === 0) {
        container.innerHTML = '<p class="text-zinc-500 text-xs py-8 text-center">No se encontraron recomendaciones similares.</p>';
        return;
      }

      const filtered = data.tracks.filter((t) => t.id !== targetTrack.id).slice(0, 15);
      container.innerHTML = filtered.map((t, idx) => `
        <div class="flex items-center justify-between p-2 rounded-2xl hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition cursor-pointer press" data-similar-idx="${idx}">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <img src="${t.thumbnail}" class="w-10 h-10 rounded-xl object-cover bg-zinc-800 shrink-0" loading="lazy" />
            <div class="min-w-0 flex-1">
              <p class="text-xs font-bold text-white truncate">${t.title}</p>
              <p class="text-[10px] text-zinc-400 truncate">${t.artist}${t.durationText ? ` • ${t.durationText}` : ''}</p>
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
    } catch {
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

    $('songMenuCover').src = target.thumbnail;
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
  }

  function closeSongMenu() {
    $('songMenuModal').classList.add('hidden');
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

  async function startArtistRadio(artist) {
    showToast(`Creando Radio de ${artist}...`);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(artist + ' exitos')}`);
      const data = await res.json();
      if (data.tracks && data.tracks.length > 0) {
        S.queue = [...data.tracks.slice(0, 20)];
        playTrack(0, true);
        showToast(`Radio de ${artist} iniciada (${S.queue.length} canciones)`);
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
  async function openArtistPage(artistName, artistThumb = '') {
    if (!artistName) return;
    const cleanArtist = artistName.replace(/\s*-\s*Topic$/i, '').trim();
    if (!cleanArtist || cleanArtist === 'Artista' || cleanArtist === 'FreeSong Music') return;

    const modal = $('artistViewModal');
    if (!modal) return;
    modal.classList.remove('hidden');

    $('artistTopBarTitle').textContent = cleanArtist;
    $('artistHeroName').textContent = cleanArtist;
    if (artistThumb) {
      $('artistHeroImg').src = artistThumb;
    } else {
      $('artistHeroImg').src = 'icons/icon-512.png';
    }

    const topListEl = $('artistTopTracksList');
    topListEl.innerHTML = `<div class="py-10 text-center text-zinc-500 text-xs animate-pulse">Cargando éxitos de ${cleanArtist}...</div>`;
    const simListEl = $('artistSimilarList');
    simListEl.innerHTML = '';

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(cleanArtist + ' exitos')}`);
      const data = await res.json();
      const tracks = (data.tracks || []).slice(0, 10);
      currentArtistTracks = tracks;

      if (tracks.length === 0) {
        topListEl.innerHTML = `<p class="py-8 text-center text-zinc-500 text-xs">No se encontraron canciones de ${cleanArtist}</p>`;
        return;
      }

      if (!artistThumb && tracks[0]?.thumbnail) {
        $('artistHeroImg').src = tracks[0].thumbnail;
      }

      topListEl.innerHTML = tracks.map((t, idx) => `
        <div class="flex items-center justify-between p-2 rounded-2xl bg-zinc-900/50 hover:bg-zinc-800/80 border border-zinc-800/50 transition cursor-pointer press group" data-artist-track-idx="${idx}">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <span class="w-5 text-center text-xs font-black ${idx === 0 ? 'text-emerald-400' : 'text-zinc-500'} shrink-0">${idx + 1}</span>
            <img src="${t.thumbnail}" class="w-11 h-11 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" loading="lazy" />
            <div class="min-w-0 flex-1">
              <p class="text-xs font-bold text-white truncate">${t.title}</p>
              <div class="flex items-center gap-1.5 mt-0.5">
                ${isDownloaded(t.id) ? '<span class="text-[10px] text-emerald-400 font-bold">✓</span>' : ''}
                <p class="text-[10px] text-zinc-400 truncate">${t.artist}${t.durationText ? ` • ${t.durationText}` : ''}</p>
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

      // Fans también escuchan
      const LATIN_STARS = ['Feid', 'Karol G', 'Bad Bunny', 'Rauw Alejandro', 'Quevedo', 'Mora', 'Manuel Turizo', 'Myke Towers', 'Ozuna', 'J Balvin'];
      const simArtists = LATIN_STARS.filter((a) => a.toLowerCase() !== cleanArtist.toLowerCase()).slice(0, 5);

      simListEl.innerHTML = simArtists.map((artName) => `
        <div class="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800/60 transition cursor-pointer press group" data-similar-artist="${artName}">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-gradient-to-tr from-emerald-500 to-sky-500 flex items-center justify-center text-black font-black text-xs shadow-md">
              ${artName.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <p class="text-xs font-bold text-white group-hover:text-emerald-400 transition">${artName}</p>
              <p class="text-[10px] text-zinc-400">Artista similar</p>
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

    } catch (err) {
      topListEl.innerHTML = `<p class="py-8 text-center text-zinc-500 text-xs">Error al cargar canciones del artista</p>`;
    }
  }

  // --- Actualizaciones de Interfaz y Like ---
  function showAndSyncMiniPlayer(track, isLoading = false) {
    const mini = $('miniPlayer');
    if (!mini || !track) return;

    mini.classList.remove('hidden', 'translate-y-full', 'opacity-0', 'pointer-events-none');
    mini.style.display = 'flex';

    const miniCover = $('miniCover');
    if (miniCover) miniCover.src = track.thumbnail || 'icons/icon-192.png';
    const miniTitle = $('miniTitle');
    if (miniTitle) miniTitle.textContent = track.title || 'Canción';
    const miniArtist = $('miniArtist');
    if (miniArtist) miniArtist.textContent = track.artist || 'Artista';

    updateLikeButton(track);
    updatePlayPauseIcons(S.isPlaying, isLoading);
  }

  function closeFullPlayer() {
    $('fullPlayerSheet').classList.add('translate-y-full');
    const cur = S.queue[S.currentIndex] || S.currentTrack;
    if (cur) {
      showAndSyncMiniPlayer(cur, false);
    }
  }

  function updatePlayerUI(track) {
    showAndSyncMiniPlayer(track, false);

    $('playerTitle').textContent = track.title;
    $('playerArtist').textContent = track.artist || 'Artista';
    $('playerCover').src = track.thumbnail;

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
      showToast('Eliminada de Tus Me Gusta');
    } else {
      S.favorites.unshift(track);
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
          <img src="${t.thumbnail}" class="w-11 h-11 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-white truncate">${t.title}</p>
            <p class="text-[10px] text-zinc-400 truncate">${t.artist} • ${count} veces</p>
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
          <img src="${t.thumbnail}" class="w-11 h-11 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-md" />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-emerald-400 truncate">${t.title}</p>
            <div class="flex items-center gap-1.5 mt-0.5">
              ${isDownloaded(t.id) ? '<span class="text-[10px] text-emerald-400 font-bold" title="Descargada">✓</span>' : ''}
              <p class="text-[11px] text-zinc-400 truncate">${t.artist}${t.durationText ? ` • ${t.durationText}` : ''}</p>
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
      <div class="flex items-center justify-between p-2 rounded-xl hover:bg-zinc-900 cursor-pointer press group" data-queue-idx="${idx}">
        <div class="flex items-center gap-2.5 min-w-0 flex-1">
          <img src="${t.thumbnail}" class="w-9 h-9 rounded-lg object-cover bg-zinc-800 shrink-0" />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-white truncate">${t.title}</p>
            <div class="flex items-center gap-1.5 mt-0.5">
              ${isDownloaded(t.id) ? '<span class="text-[10px] text-emerald-400 font-bold">✓</span>' : ''}
              <p class="text-[10px] text-zinc-400 truncate">${t.artist}${t.durationText ? ` • ${t.durationText}` : ''}</p>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0 ml-2">
          ${t.durationText ? `<span class="text-[10px] font-mono text-zinc-500 mr-1">${t.durationText}</span>` : ''}
          <button data-queue-up="${idx}" class="p-1 text-zinc-400 hover:text-emerald-400 press" title="Subir en cola">
            <svg class="w-3.5 h-3.5"><use href="#i-arrow-up"/></svg>
          </button>
          <button data-queue-down="${idx}" class="p-1 text-zinc-400 hover:text-emerald-400 press" title="Bajar en cola">
            <svg class="w-3.5 h-3.5"><use href="#i-arrow-down"/></svg>
          </button>
          <button data-queue-more="${idx}" class="p-1 text-zinc-400 hover:text-white press" aria-label="Opciones">
            <svg class="w-4 h-4"><use href="#i-more"/></svg>
          </button>
          <button data-queue-del="${idx}" aria-label="Quitar de cola" class="p-1 text-zinc-500 hover:text-red-400 press">
            <svg class="w-4 h-4"><use href="#i-close"/></svg>
          </button>
        </div>
      </div>
    `).join('');

    $$('[data-queue-idx]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-queue-del]') || e.target.closest('[data-queue-more]') || e.target.closest('[data-queue-up]') || e.target.closest('[data-queue-down]')) return;
        const i = parseInt(el.getAttribute('data-queue-idx'), 10);
        playTrack(i, true);
      });
    });

    $$('[data-queue-up]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = parseInt(btn.getAttribute('data-queue-up'), 10);
        if (i > S.currentIndex + 1) {
          const temp = S.queue[i];
          S.queue[i] = S.queue[i - 1];
          S.queue[i - 1] = temp;
          renderQueue();
        }
      });
    });

    $$('[data-queue-down]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = parseInt(btn.getAttribute('data-queue-down'), 10);
        if (i < S.queue.length - 1) {
          const temp = S.queue[i];
          S.queue[i] = S.queue[i + 1];
          S.queue[i + 1] = temp;
          renderQueue();
        }
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
        if (i >= 0 && i < S.queue.length) {
          S.queue.splice(i, 1);
          renderQueue();
        }
      });
    });
  }

  // --- Biblioteca Avanzada: Filtros, Ordenación y Playlists ---
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
    return list;
  }

  function renderLibrary() {
    $('libLikedList').classList.toggle('hidden', S.libFilter !== 'likes');
    $('libDownloadsList')?.classList.toggle('hidden', S.libFilter !== 'downloads');
    $('libHistoryList').classList.toggle('hidden', S.libFilter !== 'history');
    $('libPlaylistsWrap').classList.toggle('hidden', S.libFilter !== 'playlists');
    $('libStatsWrap').classList.toggle('hidden', S.libFilter !== 'stats');
    $('libActionsBar').classList.toggle('hidden', S.libFilter === 'stats');

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

    if (S.libFilter === 'likes') {
      renderTrackList($('libLikedList'), getFilteredLibraryTracks(), 'Aún no tienes canciones favoritas. Toca el corazón en cualquier canción.');
    } else if (S.libFilter === 'downloads') {
      renderTrackList($('libDownloadsList'), getFilteredLibraryTracks(), 'No tienes canciones descargadas. Toca ⬇️ en cualquier canción o "Descargar favoritas" para escuchar offline.');
    } else if (S.libFilter === 'history') {
      renderTrackList($('libHistoryList'), getFilteredLibraryTracks(), 'El historial de reproducción está vacío.');
    } else if (S.libFilter === 'playlists') {
      renderUserPlaylists();
    } else if (S.libFilter === 'stats') {
      renderStats();
    }
  }

  function renderTrackList(container, tracks, emptyText) {
    if (!container) return;
    if (tracks.length === 0) {
      container.innerHTML = `<p class="text-zinc-500 text-xs py-8 text-center">${emptyText}</p>`;
      return;
    }

    container.innerHTML = tracks.map((t, idx) => `
      <div class="flex items-center justify-between p-2 rounded-2xl hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition cursor-pointer press group" data-lib-track-idx="${idx}">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <img src="${t.thumbnail}" class="w-11 h-11 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" loading="lazy" />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-white truncate">${t.title}</p>
            <div class="flex items-center gap-1.5 mt-0.5">
              ${isDownloaded(t.id) ? '<span class="text-[10px] text-emerald-400 font-bold" title="Descargada">✓</span>' : ''}
              <p class="text-[10px] text-zinc-400 truncate cursor-pointer hover:text-emerald-400 artist-link" data-artist="${t.artist}">${t.artist}${t.durationText ? ` • ${t.durationText}` : ''}</p>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0 ml-2">
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

    $$('[data-lib-track-idx]').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-lib-track-more]') || e.target.closest('[data-lib-track-like]') || e.target.closest('[data-lib-track-down]') || e.target.closest('.artist-link')) return;
        const idx = parseInt(card.getAttribute('data-lib-track-idx'), 10);
        S.queue = [...tracks];
        playTrack(idx, true);
      });
    });

    $$('[data-lib-track-down]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-lib-track-down'), 10);
        toggleDownload(tracks[idx]);
      });
    });

    $$('[data-lib-track-more]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-lib-track-more'), 10);
        openSongMenu(tracks[idx]);
      });
    });

    $$('[data-lib-track-like]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-lib-track-like'), 10);
        toggleLike(tracks[idx]);
      });
    });
  }

  // --- Playlists Personalizadas ---
  function createPlaylist(name) {
    if (!name || !name.trim()) return;
    const pl = {
      id: Date.now().toString(),
      name: name.trim(),
      tracks: []
    };
    S.playlists.push(pl);
    localStorage.setItem('fs_playlists', JSON.stringify(S.playlists));
    renderUserPlaylists();
    showToast(`Playlist "${name.trim()}" creada`);
  }

  function addTrackToPlaylist(playlistId, track) {
    const pl = S.playlists.find((p) => p.id === playlistId);
    if (!pl || !track) return;
    if (!pl.tracks.some((t) => t.id === track.id)) {
      pl.tracks.push(track);
      localStorage.setItem('fs_playlists', JSON.stringify(S.playlists));
      renderUserPlaylists();
      showToast(`Guardada en "${pl.name}"`);
    } else {
      showToast(`Ya estaba en "${pl.name}"`);
    }
  }

  function openPlaylistModal(customTrack) {
    const target = customTrack || (S.currentIndex >= 0 ? S.queue[S.currentIndex] : null);
    if (!target) {
      showToast('Selecciona una canción primero');
      return;
    }
    const container = $('modalPlaylistsList');
    if (S.playlists.length === 0) {
      container.innerHTML = '<p class="text-zinc-500 text-xs py-2">No tienes playlists. Escribe un nombre y pulsa Crear.</p>';
    } else {
      container.innerHTML = S.playlists.map((pl) => `
        <button data-pick-pl="${pl.id}" class="w-full text-left p-2.5 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 flex items-center justify-between press">
          <div>
            <p class="text-xs font-bold text-white">${pl.name}</p>
            <p class="text-[10px] text-zinc-400">${pl.tracks.length} canciones</p>
          </div>
          <svg class="w-4 h-4 text-emerald-400"><use href="#i-plus"/></svg>
        </button>
      `).join('');

      $$('[data-pick-pl]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const plId = btn.getAttribute('data-pick-pl');
          addTrackToPlaylist(plId, target);
          $('playlistModal').classList.add('hidden');
        });
      });
    }
    $('playlistModal').classList.remove('hidden');
  }

  function renderUserPlaylists() {
    const container = $('userPlaylistsList');
    if (!container) return;
    if (S.playlists.length === 0) {
      container.innerHTML = '<p class="text-zinc-500 text-xs py-4 text-center">Crea tu primera playlist pulsando "+ Nueva playlist"</p>';
      return;
    }
    container.innerHTML = S.playlists.map((pl, idx) => `
      <div class="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/60 border border-zinc-800/60 hover:bg-zinc-800 cursor-pointer press" data-pl-idx="${idx}">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-sm shrink-0">
            ${pl.name.slice(0, 2).toUpperCase()}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-white truncate">${pl.name}</p>
            <p class="text-[10px] text-zinc-400 truncate">${pl.tracks.length} canciones</p>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0 ml-2">
          <button data-pl-play="${idx}" class="w-8 h-8 rounded-full bg-emerald-500 text-black flex items-center justify-center press shadow-sm">
            <svg class="w-4 h-4"><use href="#i-play"/></svg>
          </button>
        </div>
      </div>
    `).join('');

    $$('[data-pl-idx]').forEach((el) => {
      el.addEventListener('click', (e) => {
        const idx = parseInt(el.getAttribute('data-pl-idx'), 10);
        const pl = S.playlists[idx];
        if (pl && pl.tracks.length > 0) {
          S.queue = [...pl.tracks];
          playTrack(0, true);
        } else {
          showToast('Esta playlist está vacía');
        }
      });
    });
  }

  // --- Exportar e Importar Biblioteca (Copia de Seguridad JSON) ---
  function exportLibraryBackup() {
    const backupData = {
      favorites: S.favorites,
      downloads: S.downloads,
      playlists: S.playlists,
      history: S.history,
      stats: S.stats,
      exportedAt: new Date().toISOString(),
      app: 'FreeSong',
      version: '3.0.0'
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
      const favSample = [...S.favorites].sort(() => Math.random() - 0.5).slice(0, 2);
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
        prewarmTracks(data.shelves[0].items.slice(0, 2));
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
            <h2 class="text-base font-bold text-white tracking-tight">${shelf.title}</h2>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            ${shelf.items.map((t, itemIdx) => `
              <div class="group relative rounded-2xl bg-zinc-900/60 p-2.5 border border-zinc-800/60 hover:bg-zinc-800/80 transition cursor-pointer press" data-shelf-idx="${sIdx}" data-item-idx="${itemIdx}">
                <div class="w-full aspect-square rounded-xl overflow-hidden bg-zinc-800 mb-2 relative shadow-md">
                  <img src="${t.thumbnail}" alt="" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" loading="lazy" />
                  <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
                    <div class="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center text-black shadow-lg">
                      <svg class="w-5 h-5"><use href="#i-play"/></svg>
                    </div>
                  </div>
                  ${t.durationText ? `<span class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/80 backdrop-blur-md text-[9px] font-mono font-bold text-white">${t.durationText}</span>` : ''}
                </div>
                <p class="text-xs font-bold text-white truncate">${t.title}</p>
                <p class="text-[11px] text-zinc-400 truncate mt-0.5">${t.artist}</p>
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
        <img src="${t.thumbnail}" class="w-12 h-12 object-cover bg-zinc-800 shrink-0" />
        <span class="text-xs font-bold text-white px-2.5 truncate flex-1 leading-tight">${t.title}</span>
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
          <img src="${t.thumbnail}" class="w-11 h-11 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-white truncate">${t.title}</p>
            <p class="text-[11px] text-zinc-400 truncate">${t.artist}${t.durationText ? ` • ${t.durationText}` : ''}</p>
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
        <span data-search-chip="${term}">${term}</span>
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

  function setupSearch() {
    const input = $('searchInput');
    const clearBtn = $('searchClearBtn');
    const results = $('searchResults');
    const genresWrap = $('searchGenresWrap');

    renderRecentSearches();

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearBtn.classList.toggle('hidden', !q);
      clearTimeout(searchTimer);

      if (!q) {
        results.classList.add('hidden');
        results.innerHTML = '';
        if (genresWrap) genresWrap.classList.remove('hidden');
        renderRecentSearches();
        return;
      }
      searchTimer = setTimeout(() => executeSearch(q), 350);
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.classList.add('hidden');
      results.classList.add('hidden');
      results.innerHTML = '';
      if (genresWrap) genresWrap.classList.remove('hidden');
      renderRecentSearches();
      input.focus();
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
        executeSearch(q);
      });
    });
  }

  async function executeSearch(query) {
    const results = $('searchResults');
    const genresWrap = $('searchGenresWrap');
    const recentWrap = $('searchRecentWrap');

    if (genresWrap) genresWrap.classList.add('hidden');
    if (recentWrap) recentWrap.classList.add('hidden');
    results.classList.remove('hidden');
    results.innerHTML = '<div class="text-center py-12 text-zinc-500 text-sm animate-pulse">Buscando en YouTube Music...</div>';

    // Guardar en búsquedas recientes
    if (query && query.trim().length > 1) {
      const cleanQ = query.trim();
      S.recentSearches = [cleanQ, ...S.recentSearches.filter((s) => s.toLowerCase() !== cleanQ.toLowerCase())].slice(0, 8);
      localStorage.setItem('fs_recent_searches', JSON.stringify(S.recentSearches));
    }

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();

      if (!data.tracks || data.tracks.length === 0) {
        results.innerHTML = '<div class="text-center py-12 text-zinc-400 text-sm">No se encontraron canciones</div>';
        return;
      }

      prewarmTracks(data.tracks.slice(0, 2));

      results.innerHTML = data.tracks.map((t, idx) => `
        <div class="flex items-center justify-between p-2.5 rounded-2xl hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition cursor-pointer press group" data-search-idx="${idx}">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <img src="${t.thumbnail}" class="w-12 h-12 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" loading="lazy" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-bold text-white truncate">${t.title}</p>
              <div class="flex items-center gap-1.5 mt-0.5">
                ${isDownloaded(t.id) ? '<span class="text-[10px] text-emerald-400 font-bold">✓</span>' : ''}
                <p class="text-xs text-zinc-400 truncate cursor-pointer hover:text-emerald-400 artist-link" data-artist="${t.artist}">${t.artist}${t.durationText ? ` • ${t.durationText}` : ''}</p>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0 ml-2">
            <button data-search-down="${idx}" class="p-1.5 text-zinc-400 hover:text-emerald-400 press" title="Descargar">
              <svg class="w-4 h-4"><use href="${isDownloaded(t.id) ? '#i-download-done' : '#i-download'}"/></svg>
            </button>
            <button data-search-more="${idx}" class="p-1.5 text-zinc-400 hover:text-white press" aria-label="Opciones">
              <svg class="w-4 h-4"><use href="#i-more"/></svg>
            </button>
            <button class="w-9 h-9 rounded-full bg-zinc-800 text-emerald-400 hover:bg-emerald-500 hover:text-black flex items-center justify-center shadow-sm transition">
              <svg class="w-4 h-4"><use href="#i-play"/></svg>
            </button>
          </div>
        </div>
      `).join('');

      $$('[data-search-idx]').forEach((el) => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-search-more]') || e.target.closest('[data-search-down]') || e.target.closest('.artist-link')) return;
          const idx = parseInt(el.getAttribute('data-search-idx'), 10);
          S.queue = [...data.tracks];
          playTrack(idx, true);
        });
      });

      $$('[data-search-down]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.getAttribute('data-search-down'), 10);
          toggleDownload(data.tracks[idx]);
        });
      });

      $$('[data-search-more]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.getAttribute('data-search-more'), 10);
          openSongMenu(data.tracks[idx]);
        });
      });
    } catch {
      results.innerHTML = '<div class="text-center py-12 text-zinc-500 text-sm">Error al realizar la búsqueda</div>';
    }
  }

  // --- Temporizador de Apagado (Sleep Timer) ---
  function startSleepTimer(minutes) {
    clearSleepTimer();

    if (minutes === 'end_track') {
      S.sleepTimerEndTrack = true;
      S.sleepTimerMinutes = 'end_track';
      $('sleepTimerBadge').classList.remove('hidden');
      $('sleepTimerText').textContent = '1 can';
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
    $('sleepTimerBadge').classList.remove('hidden');
    $('sleepTimerText').textContent = `${minNum}m`;

    S.sleepTimerInterval = setInterval(() => {
      S.sleepTimerRemainingSec--;
      const rem = S.sleepTimerRemainingSec;
      if (rem <= 0) {
        clearSleepTimer();
        pausePlayback();
      } else {
        const m = Math.floor(rem / 60);
        const s = rem % 60;
        $('sleepTimerText').textContent = m > 0 ? `${m}m` : `${s}s`;
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
    $('sleepTimerBadge').classList.add('hidden');
  }

  function openSleepTimerModal() {
    $('sleepTimerModal').classList.remove('hidden');
  }

  function closeSleepTimerModal() {
    $('sleepTimerModal').classList.add('hidden');
  }

  // --- Navegación entre pestañas ---
  function switchTab(tab) {
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
  }

  // --- Enlazar Todos los Eventos de la Interfaz ---
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
      btn.addEventListener('click', () => switchTab(btn.getAttribute('data-nav')));
    });

    // Mini Player
    $('miniPlayer').addEventListener('click', (e) => {
      if (
        e.target.closest('#miniPlayBtn') ||
        e.target.closest('#miniNextBtn') ||
        e.target.closest('#miniLikeBtn')
      ) return;
      $('fullPlayerSheet').classList.remove('translate-y-full');
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
      playNext();
    });

    // Cerrar pantalla completa
    $('playerCloseBtn').addEventListener('click', () => {
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
    $('playerNextBtn').addEventListener('click', () => playNext());
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
        const artist = S.menuTargetTrack.artist;
        closeSongMenu();
        startArtistRadio(artist);
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
      const p = getActivePlayer();
      const track = S.queue[S.currentIndex];
      const dur = getEffectiveDuration(p, track);
      if (p && dur > 0) {
        p.currentTime = (pct / 100) * dur;
      }
    });

    // Smart Shuffle ✨ (3 Estados: Off -> Normal -> Smart ✨)
    const shuffleBtn = $('playerShuffleBtn');
    const shuffleBadge = $('playerShuffleBadge');

    shuffleBtn.addEventListener('click', () => {
      S.shuffleMode = (S.shuffleMode + 1) % 3;

      if (S.shuffleMode === 0) {
        shuffleBtn.className = 'relative p-2 text-zinc-400 hover:text-white press';
        shuffleBadge.classList.add('hidden');
        showToast('Aleatorio desactivado');
      } else if (S.shuffleMode === 1) {
        shuffleBtn.className = 'relative p-2 text-emerald-400 has-active-dot press';
        shuffleBadge.classList.add('hidden');
        showToast('Aleatorio normal activado');
      } else {
        shuffleBtn.className = 'relative p-2 text-emerald-400 has-active-dot press';
        shuffleBadge.classList.remove('hidden');
        showToast('✨ Smart Shuffle activado (Recomendaciones dinámicas)');
      }
    });

    // Repetición
    $('playerRepeatBtn').addEventListener('click', () => {
      if (S.repeat === 'off') S.repeat = 'all';
      else if (S.repeat === 'all') S.repeat = 'one';
      else S.repeat = 'off';

      if (S.repeat === 'one') {
        $('playerRepeatBtn').className = 'p-2 text-emerald-400 has-active-dot press';
        $('playerRepeatBtn').innerHTML = '<svg class="w-5 h-5"><use href="#i-repeat-one"/></svg>';
        showToast('Repetir una canción');
      } else if (S.repeat === 'all') {
        $('playerRepeatBtn').className = 'p-2 text-emerald-400 has-active-dot press';
        $('playerRepeatBtn').innerHTML = '<svg class="w-5 h-5"><use href="#i-repeat"/></svg>';
        showToast('Repetir lista completa');
      } else {
        $('playerRepeatBtn').className = 'p-2 text-zinc-400 hover:text-white press';
        $('playerRepeatBtn').innerHTML = '<svg class="w-5 h-5"><use href="#i-repeat"/></svg>';
        showToast('Repetición desactivada');
      }
    });

    // Filtros de Biblioteca
    $('libFilterLikes').addEventListener('click', () => { S.libFilter = 'likes'; renderLibrary(); });
    $('libFilterDownloads')?.addEventListener('click', () => { S.libFilter = 'downloads'; renderLibrary(); });
    $('libFilterPlaylists').addEventListener('click', () => { S.libFilter = 'playlists'; renderLibrary(); });
    $('libFilterHistory').addEventListener('click', () => { S.libFilter = 'history'; renderLibrary(); });
    $('libFilterStats').addEventListener('click', () => { S.libFilter = 'stats'; renderLibrary(); });
    $('libDownloadAllBtn')?.addEventListener('click', downloadAllFavorites);

    // Modo "Tu DJ IA ✨"
    $('btnDjVibe')?.addEventListener('click', cycleDjVibe);
    $('homeDjCard')?.addEventListener('click', startDjSession);

    // Modal: Perfil del Artista Completo
    $('artistBackBtn')?.addEventListener('click', () => {
      $('artistViewModal')?.classList.add('hidden');
    });

    $('artistPlayBtn')?.addEventListener('click', () => {
      if (currentArtistTracks.length > 0) {
        S.queue = [...currentArtistTracks];
        playTrack(0, true);
      }
    });

    $('artistShuffleBtn')?.addEventListener('click', () => {
      if (currentArtistTracks.length > 0) {
        S.queue = [...currentArtistTracks].sort(() => Math.random() - 0.5);
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
        S.queue = [...tracks].sort(() => Math.random() - 0.5);
        playTrack(0, true);
        showToast('Reproduciendo en aleatorio');
      } else {
        showToast('No hay canciones para reproducir');
      }
    });

    // Sleep Timer modal events
    $('sleepTimerBadge').addEventListener('click', openSleepTimerModal);
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
      const name = prompt('Nombre de la nueva playlist:');
      if (name) createPlaylist(name);
    });

    $('playlistModalCloseBtn').addEventListener('click', () => {
      $('playlistModal').classList.add('hidden');
    });

    $('createPlaylistConfirmBtn').addEventListener('click', () => {
      const input = $('newPlaylistInput');
      const name = input.value.trim();
      if (name) {
        createPlaylist(name);
        input.value = '';
        $('playlistModal').classList.add('hidden');
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

    // Restablecer datos
    $('btnClearData').addEventListener('click', () => {
      if (confirm('¿Deseas restablecer todos tus datos locales (favoritos, historial, playlists)?')) {
        localStorage.clear();
        S.favorites = [];
        S.history = [];
        S.playlists = [];
        S.stats = { totalPlays: 0, songs: {}, artists: {} };
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

  // --- Inicialización ---
  document.addEventListener('DOMContentLoaded', () => {
    updateGreeting();
    bindEvents();
    setupSearch();
    renderLibrary();
    loadHomeContent('todo');
    initOfflineBlobs();

    // Restaurar última canción escuchada en el Mini-Player (como Spotify)
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

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  });

})();

// FreeSong Web Music Player v2.0 - Motor Anti-Pausa con Corrección DASH iOS, Filtros de Inicio, Temporizador y Experiencia Spotify / YouTube Music
(() => {
  'use strict';

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // Bloquear gestos de zoom y doble-tap en iPhone / iOS
  if (isIOS) {
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
  }

  // Detección de pantalla bloqueada o pestaña en segundo plano
  function isBackground() {
    return document.visibilityState === 'hidden';
  }

  // --- Elementos del DOM ---
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  // --- Estado de la aplicación ---
  const S = {
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    crossfade: false, // Desactivado por defecto para garantizar reproducción continua en iOS
    crossfadeDuration: 6,
    shuffle: false,
    repeat: 'all', // 'off', 'all', 'one'
    favorites: JSON.parse(localStorage.getItem('fs_favorites') || '[]'),
    history: JSON.parse(localStorage.getItem('fs_history') || '[]'),
    playlists: JSON.parse(localStorage.getItem('fs_playlists') || '[]'),
    syncedLyrics: [],
    currentLyricIdx: -1,
    activeTab: 'home',
    activeChip: 'todo',
    activePlayerSubTab: 'track', // 'track', 'queue', 'lyrics', 'similar'
    sleepTimerMinutes: null,
    sleepTimerEndTrack: false,
    sleepTimerInterval: null,
    sleepTimerRemainingSec: 0
  };

  // Cargar configuración guardada de crossfade
  const savedXf = localStorage.getItem('fs_crossfade');
  if (savedXf !== null) S.crossfade = savedXf === 'true';
  const savedXfDur = localStorage.getItem('fs_crossfade_dur');
  if (savedXfDur) S.crossfadeDuration = parseInt(savedXfDur, 10);

  // --- Motor de Audio HTML5 Nativo (Doble Deck) ---
  const audioDecks = [
    $('audioA') || new Audio(),
    $('audioB') || new Audio()
  ];
  audioDecks.forEach((a) => {
    a.preload = 'auto';
    a.playsInline = true;
  });

  let activeDeckIdx = 0;
  let isCrossfading = false;
  let fadeInterval = null;
  let userIntentionalPause = false;
  let isScrubbing = false;

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

  // --- Corrección Heurística del Bug DASH itag=140 en iOS Safari ---
  // En WebKit de iPhone, los contenedores DASH itag=140 duplican exactamente la duración calculada (2x)
  function getEffectiveDuration(audioEl, track) {
    const official = (track && (track.duration || track.durationSeconds)) ? (track.duration || track.durationSeconds) : 0;
    const raw = audioEl ? (audioEl.duration || 0) : 0;

    // 1. Si tenemos duración oficial de YouTube Music (metadatos reales):
    if (official > 0) {
      return official;
    }

    // 2. Si no hay duración oficial previa:
    if (!raw || isNaN(raw) || raw <= 0) return 0;

    // Si estamos en iOS y el reproductor marca más de 180s, el contenedor DASH itag=140 está reportando el doble
    if (isIOS && raw > 180) {
      return Math.round(raw / 2);
    }

    return Math.round(raw);
  }

  // Búsqueda en segundo plano de la duración oficial si la pista no la traía
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
            if (dur > 0) {
              $('playerDurTime').textContent = formatTime(dur);
            }
          }
        }
      })
      .catch(() => {});
  }

  // --- Salvaguarda de Cambio de Visibilidad (Segundo Plano en iOS) ---
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (isCrossfading) {
        if (fadeInterval) clearInterval(fadeInterval);
        isCrossfading = false;
        const activeP = getActivePlayer();
        if (activeP) activeP.volume = 1;
      }
      // Si la app pasa a background mientras suena y no fue pausa intencional, asegurar que siga sonando
      if (S.isPlaying && !userIntentionalPause) {
        const activeP = getActivePlayer();
        if (activeP && activeP.paused) {
          activeP.play().catch(() => {});
        }
      }
    }
  });

  // --- Eventos del Reproductor HTML5 ---
  audioDecks.forEach((deck, idx) => {
    deck.addEventListener('play', () => {
      if (idx === activeDeckIdx) {
        S.isPlaying = true;
        userIntentionalPause = false;
        updatePlayPauseIcons(true);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      }
    });

    deck.addEventListener('pause', () => {
      if (idx === activeDeckIdx && !isCrossfading) {
        // En iOS Safari, WebKit puede intentar pausar al cambiar de app (hidden).
        // Si no fue una pausa intencional del usuario, forzar la reanudación inmediata.
        if (document.visibilityState === 'hidden' && S.isPlaying && !userIntentionalPause) {
          setTimeout(() => {
            if (S.isPlaying && !userIntentionalPause && deck.paused) {
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
      if (idx === activeDeckIdx && !isCrossfading) {
        handleTrackFinished();
      }
    });

    deck.addEventListener('timeupdate', () => {
      if (idx !== activeDeckIdx) return;
      const cur = deck.currentTime || 0;
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

        // Reportar posición precisa a la Dynamic Island y pantalla de bloqueo de iPhone
        if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
          try {
            navigator.mediaSession.setPositionState({
              duration: dur,
              playbackRate: deck.playbackRate || 1,
              position: clampedCur
            });
          } catch {}
        }

        // Pre-resolver la siguiente canción al 70% de progreso
        if (pct >= 70 && !deck.dataset.prefetched) {
          deck.dataset.prefetched = 'true';
          prefetchNextTrack();
        }

        // CORTE AUTOMÁTICO EXACTO: Si llegamos al final real (dur - 0.8), avanzar inmediatamente
        // en vez de esperar los 3 minutos de silencio generados por el contenedor DASH de iOS
        if (cur >= dur - 0.8) {
          handleTrackFinished();
          return;
        }

        // Crossfade opcional en desktop
        const timeLeft = dur - cur;
        if (
          S.crossfade &&
          !isIOS &&
          !isBackground() &&
          !isCrossfading &&
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

    deck.addEventListener('error', () => {
      if (idx === activeDeckIdx && S.currentIndex >= 0) {
        const track = S.queue[S.currentIndex];
        console.warn('Reintentando audio con servidor de respaldo para:', track.title);
        if (!deck.dataset.retried) {
          deck.dataset.retried = '1';
          deck.src = `https://invidious.slipfox.xyz/latest_version?id=${encodeURIComponent(track.id)}&itag=140&local=true`;
          deck.play().catch(() => {});
        } else if (deck.dataset.retried === '1') {
          deck.dataset.retried = '2';
          deck.src = `https://yewtu.be/latest_version?id=${encodeURIComponent(track.id)}&itag=140&local=true`;
          deck.play().catch(() => {});
        }
      }
    });
  });

  function handleTrackFinished() {
    if (S.sleepTimerEndTrack) {
      clearSleepTimer();
      pausePlayback();
      return;
    }
    playNext(true);
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

  // --- Pre-resolución y Precarga Inteligente de Siguiente Canción ---
  function getNextIndex() {
    if (S.queue.length === 0) return -1;
    if (S.repeat === 'one') return S.currentIndex;
    let next = S.currentIndex + 1;
    if (S.shuffle) {
      next = Math.floor(Math.random() * S.queue.length);
    }
    if (next >= S.queue.length) {
      next = 0;
    }
    return next;
  }

  function prefetchNextTrack() {
    const nextIdx = getNextIndex();
    if (nextIdx < 0 || nextIdx >= S.queue.length || nextIdx === S.currentIndex) return;
    const nextTrack = S.queue[nextIdx];
    if (!nextTrack || nextTrack.streamUrl) return;

    const targetUrl = `/api/stream?id=${encodeURIComponent(nextTrack.id)}`;
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
    if (!track || isFetchingRelated) return;
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

  // --- Reproducción y Cambio de Pista ---
  function playTrack(index, immediate = false) {
    if (index < 0 || index >= S.queue.length) return;
    S.currentIndex = index;
    const track = S.queue[index];

    userIntentionalPause = false;

    // Actualizar UI
    updatePlayerUI(track);
    saveHistory(track);
    loadLyrics(track);
    loadSimilarTracks(track);
    updateMediaSession(track);
    ensureUpcomingTracks(track);
    enrichTrackDuration(track);

    const streamUrl = track.streamUrl || `/api/stream?id=${encodeURIComponent(track.id)}`;

    const isBg = isBackground();
    const shouldCrossfade = S.crossfade && S.isPlaying && !immediate && !isIOS && !isBg;
    const outPlayer = getActivePlayer();
    const inPlayer = shouldCrossfade ? getInactivePlayer() : getActivePlayer();

    delete inPlayer.dataset.retried;
    delete inPlayer.dataset.prefetched;

    try {
      if (shouldCrossfade) {
        inPlayer.muted = false;
        inPlayer.volume = 0;
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
        inPlayer.volume = 1;

        // ¡CRUCIAL EN iOS!: Asignación directa y síncrona de .src y llamada inmediata a .play()
        // NUNCA llamar a inPlayer.pause() ni inPlayer.load()
        inPlayer.src = streamUrl;
        const playPromise = inPlayer.play();
        if (playPromise && playPromise.catch) {
          playPromise.catch((err) => console.warn('inPlayer play error:', err));
        }
      }

      S.isPlaying = true;
      updatePlayPauseIcons(true);
    } catch (err) {
      console.error('Error al reproducir pista:', err);
    }
  }

  // --- Curva de Crossfade Senoidal (Desktop) ---
  function performCrossfade(outP, inP, durationSec) {
    if (isCrossfading) clearInterval(fadeInterval);
    isCrossfading = true;

    const steps = 30;
    const stepTime = (durationSec * 1000) / steps;
    let currentStep = 0;

    fadeInterval = setInterval(() => {
      currentStep++;
      const progress = currentStep / steps;

      const outVol = Math.cos((progress * Math.PI) / 2);
      const inVol = Math.sin((progress * Math.PI) / 2);

      try {
        outP.volume = Math.max(0, Math.min(1, outVol));
        inP.volume = Math.max(0, Math.min(1, inVol));
      } catch {}

      if (currentStep >= steps) {
        clearInterval(fadeInterval);
        try {
          outP.pause();
          outP.currentTime = 0;
          outP.volume = 1;
          inP.volume = 1;
        } catch {}
        activeDeckIdx = 1 - activeDeckIdx;
        isCrossfading = false;
      }
    }, stepTime);
  }

  function pausePlayback() {
    userIntentionalPause = true;
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
    if (S.queue.length === 0) return;
    if (S.repeat === 'one') {
      const p = getActivePlayer();
      if (p) {
        p.currentTime = 0;
        p.play().catch(() => {});
      }
      return;
    }
    const nextIdx = getNextIndex();
    if (nextIdx >= 0) {
      playTrack(nextIdx, typeof immediate === 'boolean' ? immediate : true);
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

  // --- Canciones Similares / Relacionadas ---
  async function loadSimilarTracks(track) {
    const container = $('similarList');
    if (!container) return;
    container.innerHTML = '<p class="text-zinc-500 text-xs py-8 text-center animate-pulse">Buscando canciones similares...</p>';

    try {
      const q = track.artist && track.artist !== 'Artista' ? `${track.artist} exitos` : `${track.title} mix`;
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();

      if (!data.tracks || data.tracks.length === 0) {
        container.innerHTML = '<p class="text-zinc-500 text-xs py-8 text-center">No se encontraron similares</p>';
        return;
      }

      const filtered = data.tracks.filter((t) => t.id !== track.id).slice(0, 15);
      container.innerHTML = filtered.map((t, idx) => `
        <div class="flex items-center justify-between p-2 rounded-2xl hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition cursor-pointer press" data-similar-idx="${idx}">
          <div class="flex items-center gap-3 min-w-0">
            <img src="${t.thumbnail}" class="w-10 h-10 rounded-xl object-cover bg-zinc-800 shrink-0" />
            <div class="min-w-0">
              <p class="text-xs font-bold text-white truncate">${t.title}</p>
              <p class="text-[10px] text-zinc-400 truncate">${t.artist}${t.durationText ? ` • ${t.durationText}` : ''}</p>
            </div>
          </div>
          <button data-add-queue-idx="${idx}" class="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-full shrink-0 ml-2 hover:bg-emerald-500 hover:text-black transition press">
            + Cola
          </button>
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
            btn.textContent = '✓ Añadida';
            btn.className = 'text-[10px] font-bold text-white bg-zinc-800 border border-zinc-700 px-2.5 py-1 rounded-full shrink-0 ml-2';
            setTimeout(() => {
              btn.textContent = '+ Cola';
              btn.className = 'text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-full shrink-0 ml-2 hover:bg-emerald-500 hover:text-black transition press';
            }, 1800);
          }
        });
      });
    } catch {
      container.innerHTML = '<p class="text-zinc-500 text-xs py-8 text-center">Error al cargar similares</p>';
    }
  }

  // --- Actualizaciones de Interfaz ---
  function updatePlayerUI(track) {
    $('miniPlayer').classList.remove('hidden');
    $('miniTitle').textContent = track.title;
    $('miniArtist').textContent = track.artist || 'Artista';
    $('miniCover').src = track.thumbnail;

    $('playerTitle').textContent = track.title;
    $('playerArtist').textContent = track.artist || 'Artista';
    $('playerCover').src = track.thumbnail;

    updateLikeButton(track);
    renderQueue();
  }

  function updatePlayPauseIcons(playing) {
    const playSvg = '<svg class="w-5 h-5"><use href="#i-play"/></svg>';
    const pauseSvg = '<svg class="w-5 h-5"><use href="#i-pause"/></svg>';
    const bigPlaySvg = '<svg class="w-8 h-8"><use href="#i-play"/></svg>';
    const bigPauseSvg = '<svg class="w-8 h-8"><use href="#i-pause"/></svg>';

    $('miniPlayBtn').innerHTML = playing ? pauseSvg : playSvg;
    $('playerPlayBtn').innerHTML = playing ? bigPauseSvg : bigPlaySvg;
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
    } else {
      S.favorites.unshift(track);
    }
    localStorage.setItem('fs_favorites', JSON.stringify(S.favorites));
    updateLikeButton(track);
    updateLibraryCounters();
    if (S.activeTab === 'library') showLikedSongsList();
  }

  function saveHistory(track) {
    S.history = [track, ...S.history.filter((h) => h.id !== track.id)].slice(0, 50);
    localStorage.setItem('fs_history', JSON.stringify(S.history));
    updateLibraryCounters();
  }

  function updateLibraryCounters() {
    $('libLikedCount').textContent = `${S.favorites.length} canciones`;
    $('libRecentCount').textContent = `${S.history.length} escuchadas`;
    renderUserPlaylists();
  }

  // --- Renderizado de la Cola (Siguiente) ---
  function renderQueue() {
    const container = $('queueList');
    const nowPlayingWrap = $('queueNowPlaying');
    const countEl = $('queueTotalCount');

    if (countEl) {
      countEl.textContent = `${Math.max(0, S.queue.length - 1 - S.currentIndex)} restantes`;
    }

    // Sonando ahora
    if (nowPlayingWrap) {
      if (S.currentIndex >= 0 && S.currentIndex < S.queue.length) {
        const t = S.queue[S.currentIndex];
        nowPlayingWrap.innerHTML = `
          <img src="${t.thumbnail}" class="w-11 h-11 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-md" />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-emerald-400 truncate">${t.title}</p>
            <p class="text-[11px] text-zinc-400 truncate">${t.artist}${t.durationText ? ` • ${t.durationText}` : ''}</p>
          </div>
          <div class="flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
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
            <p class="text-[10px] text-zinc-400 truncate">${t.artist}${t.durationText ? ` • ${t.durationText}` : ''}</p>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0 ml-2">
          ${t.durationText ? `<span class="text-[10px] font-mono text-zinc-500">${t.durationText}</span>` : ''}
          <button data-queue-del="${idx}" aria-label="Quitar de cola" class="p-1 text-zinc-500 hover:text-red-400 press">
            <svg class="w-4 h-4"><use href="#i-close"/></svg>
          </button>
        </div>
      </div>
    `).join('');

    $$('[data-queue-idx]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-queue-del]')) return;
        const i = parseInt(el.getAttribute('data-queue-idx'), 10);
        playTrack(i, true);
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

  // --- Acceso Rápido / Escuchado Recientemente (Grid 2 columnas tipo Spotify) ---
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

  // --- Tendencias Hoy (Lista numerada 1..5) ---
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
          <button data-trend-like="${idx}" class="p-1.5 text-zinc-400 hover:text-emerald-400 press">
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
        if (e.target.closest('[data-trend-like]')) return;
        const idx = parseInt(row.getAttribute('data-trend-idx'), 10);
        S.queue = [...items];
        playTrack(idx, true);
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

      renderQuickAccess();

      // En el modo 'Todo', la primera sección nutre la lista de Tendencias
      if (category === 'todo' && data.shelves[0]?.items?.length > 0) {
        renderTrendingList(data.shelves[0].items);
      } else {
        $('trendingSection')?.classList.add('hidden');
      }

      // Renderizar el resto de shelves
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

  // --- Búsqueda en Vivo (YouTube Music) ---
  let searchTimer = null;
  function setupSearch() {
    const input = $('searchInput');
    const clearBtn = $('searchClearBtn');
    const results = $('searchResults');

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearBtn.classList.toggle('hidden', !q);
      clearTimeout(searchTimer);

      if (!q) {
        results.innerHTML = '<div class="text-center py-16 text-zinc-500 text-xs">Escribe para buscar canciones</div>';
        return;
      }

      searchTimer = setTimeout(() => executeSearch(q), 350);
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.classList.add('hidden');
      results.innerHTML = '<div class="text-center py-16 text-zinc-500 text-xs">Escribe para buscar canciones</div>';
      input.focus();
    });
  }

  async function executeSearch(query) {
    const results = $('searchResults');
    results.innerHTML = '<div class="text-center py-12 text-zinc-500 text-sm animate-pulse">Buscando en YouTube Music...</div>';

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();

      if (!data.tracks || data.tracks.length === 0) {
        results.innerHTML = '<div class="text-center py-12 text-zinc-400 text-sm">No se encontraron canciones</div>';
        return;
      }

      results.innerHTML = data.tracks.map((t, idx) => `
        <div class="flex items-center justify-between p-2.5 rounded-2xl hover:bg-zinc-900 border border-transparent hover:border-zinc-800 transition cursor-pointer press" data-search-idx="${idx}">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <img src="${t.thumbnail}" class="w-12 h-12 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" loading="lazy" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-bold text-white truncate">${t.title}</p>
              <p class="text-xs text-zinc-400 truncate mt-0.5">${t.artist}${t.durationText ? ` • ${t.durationText}` : ''}</p>
            </div>
          </div>
          <button class="w-9 h-9 rounded-full bg-zinc-800 text-emerald-400 hover:bg-emerald-500 hover:text-black flex items-center justify-center shrink-0 ml-2 shadow-sm transition">
            <svg class="w-4 h-4"><use href="#i-play"/></svg>
          </button>
        </div>
      `).join('');

      $$('[data-search-idx]').forEach((el) => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.getAttribute('data-search-idx'), 10);
          S.queue = [...data.tracks];
          playTrack(idx, true);
        });
      });
    } catch {
      results.innerHTML = '<div class="text-center py-12 text-zinc-500 text-sm">Error al realizar la búsqueda</div>';
    }
  }

  // --- Subpestañas del Full Player (Canción / Siguiente / Letras / Similares) ---
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
      return;
    }

    const minNum = parseInt(minutes, 10);
    if (isNaN(minNum) || minNum <= 0) {
      clearSleepTimer();
      closeSleepTimerModal();
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

  // --- Playlists Personalizadas (LocalStorage) ---
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
  }

  function addTrackToPlaylist(playlistId, track) {
    const pl = S.playlists.find((p) => p.id === playlistId);
    if (!pl || !track) return;
    if (!pl.tracks.some((t) => t.id === track.id)) {
      pl.tracks.push(track);
      localStorage.setItem('fs_playlists', JSON.stringify(S.playlists));
      renderUserPlaylists();
    }
  }

  function openPlaylistModal() {
    const currentTrack = S.currentIndex >= 0 ? S.queue[S.currentIndex] : null;
    if (!currentTrack) {
      alert('Primero reproduce una canción para añadirla a una playlist');
      return;
    }
    const container = $('modalPlaylistsList');
    if (S.playlists.length === 0) {
      container.innerHTML = '<p class="text-zinc-500 text-xs py-2">No tienes playlists creadas. Escribe un nombre arriba y pulsa Crear.</p>';
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
          addTrackToPlaylist(plId, currentTrack);
          $('playlistModal').classList.add('hidden');
          alert(`Canción guardada en playlist`);
        });
      });
    }
    $('playlistModal').classList.remove('hidden');
  }

  function renderUserPlaylists() {
    const container = $('userPlaylistsList');
    if (!container) return;
    if (S.playlists.length === 0) {
      container.innerHTML = '<p class="text-zinc-500 text-xs px-1 py-1">Crea tu primera playlist pulsando "+ Nueva playlist"</p>';
      return;
    }
    container.innerHTML = S.playlists.map((pl, idx) => `
      <div class="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/60 border border-zinc-800/60 hover:bg-zinc-800 cursor-pointer press" data-pl-idx="${idx}">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-sm shrink-0">
            ${pl.name.slice(0, 2).toUpperCase()}
          </div>
          <div class="min-w-0">
            <p class="text-xs font-bold text-white truncate">${pl.name}</p>
            <p class="text-[10px] text-zinc-400 truncate">${pl.tracks.length} canciones</p>
          </div>
        </div>
        <svg class="w-5 h-5 text-zinc-500"><use href="#i-next"/></svg>
      </div>
    `).join('');

    $$('[data-pl-idx]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-pl-idx'), 10);
        const pl = S.playlists[idx];
        if (pl && pl.tracks.length > 0) {
          S.queue = [...pl.tracks];
          playTrack(0, true);
        } else {
          alert('Esta playlist aún no tiene canciones.');
        }
      });
    });
  }

  // --- Biblioteca: Vistas Rápidas ---
  function showLikedSongsList() {
    const container = $('libPlaylistContent');
    if (S.favorites.length === 0) {
      container.innerHTML = '<p class="text-zinc-500 text-xs py-4 text-center">Aún no tienes canciones favoritas. Toca el corazón en cualquier canción.</p>';
      return;
    }
    container.innerHTML = `
      <h3 class="text-sm font-bold text-white px-1 mb-2">Tus favoritas</h3>
      ${S.favorites.map((t, idx) => `
        <div class="flex items-center justify-between p-2 rounded-xl hover:bg-zinc-900 cursor-pointer press" data-fav-idx="${idx}">
          <div class="flex items-center gap-2.5 min-w-0 flex-1">
            <img src="${t.thumbnail}" class="w-10 h-10 rounded-lg object-cover bg-zinc-800 shrink-0" />
            <div class="min-w-0 flex-1">
              <p class="text-xs font-bold text-white truncate">${t.title}</p>
              <p class="text-[11px] text-zinc-400 truncate">${t.artist}${t.durationText ? ` • ${t.durationText}` : ''}</p>
            </div>
          </div>
          <svg class="w-5 h-5 text-emerald-400 shrink-0 ml-2"><use href="#i-heart-fill"/></svg>
        </div>
      `).join('')}
    `;

    $$('[data-fav-idx]').forEach((el) => {
      el.addEventListener('click', () => {
        const i = parseInt(el.getAttribute('data-fav-idx'), 10);
        S.queue = [...S.favorites];
        playTrack(i, true);
      });
    });
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
      showLikedSongsList();
      renderUserPlaylists();
    }
  }

  // --- Enlazar Eventos de la Interfaz ---
  function bindEvents() {
    // Chips de categorías de Home
    $$('.chip-btn').forEach((chip) => {
      chip.addEventListener('click', () => {
        $$('.chip-btn').forEach((c) => c.classList.remove('active'));
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
      $('fullPlayerSheet').classList.add('translate-y-full');
    });

    // Subpestañas del Full Player
    $('tabTrackBtn').addEventListener('click', () => switchPlayerSubTab('track'));
    $('tabQueueBtn').addEventListener('click', () => switchPlayerSubTab('queue'));
    $('tabLyricsBtn').addEventListener('click', () => switchPlayerSubTab('lyrics'));
    $('tabSimilarBtn').addEventListener('click', () => switchPlayerSubTab('similar'));

    // Botones de Play/Pause y Skip del Full Player
    $('playerPlayBtn').addEventListener('click', togglePlayPause);
    $('playerNextBtn').addEventListener('click', () => playNext());
    $('playerPrevBtn').addEventListener('click', playPrev);

    // Like y Playlist en Full Player
    $('playerLikeBtn').addEventListener('click', () => {
      if (S.currentIndex >= 0) toggleLike(S.queue[S.currentIndex]);
    });
    $('playerAddPlaylistBtn').addEventListener('click', openPlaylistModal);

    // Menú de 3 puntos del Full Player (abre Sleep Timer)
    $('playerMenuBtn').addEventListener('click', openSleepTimerModal);

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

    // Shuffle & Repeat
    $('playerShuffleBtn').addEventListener('click', () => {
      S.shuffle = !S.shuffle;
      $('playerShuffleBtn').className = S.shuffle
        ? 'p-2 text-emerald-400 has-active-dot press'
        : 'p-2 text-zinc-400 hover:text-white press';
    });

    $('playerRepeatBtn').addEventListener('click', () => {
      if (S.repeat === 'off') S.repeat = 'all';
      else if (S.repeat === 'all') S.repeat = 'one';
      else S.repeat = 'off';

      if (S.repeat === 'one') {
        $('playerRepeatBtn').className = 'p-2 text-emerald-400 has-active-dot press';
        $('playerRepeatBtn').innerHTML = '<svg class="w-5 h-5"><use href="#i-repeat-one"/></svg>';
      } else if (S.repeat === 'all') {
        $('playerRepeatBtn').className = 'p-2 text-emerald-400 has-active-dot press';
        $('playerRepeatBtn').innerHTML = '<svg class="w-5 h-5"><use href="#i-repeat"/></svg>';
      } else {
        $('playerRepeatBtn').className = 'p-2 text-zinc-400 hover:text-white press';
        $('playerRepeatBtn').innerHTML = '<svg class="w-5 h-5"><use href="#i-repeat"/></svg>';
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
        const pl = S.playlists[S.playlists.length - 1];
        if (pl && S.currentIndex >= 0) {
          addTrackToPlaylist(pl.id, S.queue[S.currentIndex]);
          alert(`Playlist "${name}" creada con la canción actual`);
        }
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

    // Restablecer datos
    $('btnClearData').addEventListener('click', () => {
      if (confirm('¿Deseas restablecer todos tus datos locales (favoritos, historial, playlists)?')) {
        localStorage.clear();
        S.favorites = [];
        S.history = [];
        S.playlists = [];
        updateLibraryCounters();
        showLikedSongsList();
        alert('Datos restablecidos con éxito');
      }
    });

    // Biblioteca botones rápidos
    $('libLikedBtn').addEventListener('click', () => {
      if (S.favorites.length > 0) {
        S.queue = [...S.favorites];
        playTrack(0, true);
      }
    });
    $('libRecentBtn').addEventListener('click', () => {
      if (S.history.length > 0) {
        S.queue = [...S.history];
        playTrack(0, true);
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
  }

  // --- Inicialización ---
  document.addEventListener('DOMContentLoaded', () => {
    updateGreeting();
    bindEvents();
    setupSearch();
    updateLibraryCounters();
    loadHomeContent('todo');

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  });

})();

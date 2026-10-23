// FreeSong Web Music Player - Motor Continuo Anti-Pausa con Doble Deck y Crossfade de Spotify
(() => {
  'use strict';

  // --- Protección Anti-Pausa al salir de la pestaña / minimizar ---
  try {
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  } catch {}

  window.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  window.addEventListener('blur', (e) => e.stopImmediatePropagation(), true);

  // --- Mantenedor de sesión de audio en móviles (iOS Safari / Android) ---
  const silentLoop = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
  silentLoop.loop = true;
  function keepAudioAlive() {
    if (silentLoop.paused) {
      silentLoop.play().catch(() => {});
    }
  }

  // --- Estado de la aplicación ---
  const S = {
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    crossfade: true,
    crossfadeDuration: 6, // 6 segundos de fundido como Spotify
    shuffle: false,
    repeat: 'all', // 'off', 'all', 'one'
    favorites: JSON.parse(localStorage.getItem('fs_favorites') || '[]'),
    history: JSON.parse(localStorage.getItem('fs_history') || '[]'),
    syncedLyrics: [],
    currentLyricIdx: -1,
    activeTab: 'home'
  };

  // Cargar configuración guardada de crossfade
  const savedXf = localStorage.getItem('fs_crossfade');
  if (savedXf !== null) S.crossfade = savedXf === 'true';
  const savedXfDur = localStorage.getItem('fs_crossfade_dur');
  if (savedXfDur) S.crossfadeDuration = parseInt(savedXfDur, 10);

  // --- Elementos del DOM ---
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  // --- Motor de Reproducción de Doble Deck (Deck A y Deck B) ---
  const ytPlayers = [null, null];
  let activeDeckIdx = 0;
  let isCrossfading = false;
  let fadeInterval = null;
  let timeMonitorInterval = null;
  let readyCount = 0;
  let isEngineReady = false;
  let userIntentionalPause = false;
  let isScrubbing = false;

  function getActivePlayer() {
    return ytPlayers[activeDeckIdx];
  }

  function getInactivePlayer() {
    return ytPlayers[1 - activeDeckIdx];
  }

  function formatTime(secs) {
    if (isNaN(secs) || secs < 0) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // --- Inicialización de los dos Decks de YouTube ---
  function initYouTubePlayers() {
    const commonVars = {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      fs: 0,
      rel: 0,
      playsinline: 1,
      enablejsapi: 1,
      modestbranding: 1,
      origin: window.location.origin
    };

    ytPlayers[0] = new YT.Player('deckA', {
      height: '200',
      width: '200',
      videoId: '',
      playerVars: commonVars,
      events: {
        onReady: () => onDeckReady(0),
        onStateChange: (e) => onDeckStateChange(0, e)
      }
    });

    ytPlayers[1] = new YT.Player('deckB', {
      height: '200',
      width: '200',
      videoId: '',
      playerVars: commonVars,
      events: {
        onReady: () => onDeckReady(1),
        onStateChange: (e) => onDeckStateChange(1, e)
      }
    });
  }

  function onDeckReady(deckIdx) {
    readyCount++;
    if (readyCount >= 2) {
      isEngineReady = true;
      startTimeMonitor();
    }
  }

  function onDeckStateChange(deckIdx, event) {
    if (deckIdx !== activeDeckIdx) return;

    // YT.PlayerState: PLAYING = 1, PAUSED = 2, ENDED = 0, BUFFERING = 3
    if (event.data === 1) {
      S.isPlaying = true;
      userIntentionalPause = false;
      updatePlayPauseIcons(true);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    } else if (event.data === 2) {
      // Si la pausa NO fue iniciada intencionalmente por el usuario (ocurrió por cambio de pestaña o bloqueo)
      if (!userIntentionalPause && S.isPlaying) {
        setTimeout(() => {
          const p = getActivePlayer();
          if (p && p.playVideo) p.playVideo();
        }, 50);
        return;
      }

      S.isPlaying = false;
      updatePlayPauseIcons(false);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    } else if (event.data === 0) {
      // Fin natural de pista si no se activó el crossfade
      if (!isCrossfading) {
        playNext();
      }
    }
  }

  window.onYouTubeIframeAPIReady = () => {
    initYouTubePlayers();
  };

  if (window.YT && window.YT.Player) {
    initYouTubePlayers();
  }

  // --- Controles de Pantalla de Bloqueo / Control Center en iOS (MediaSession) ---
  function updateMediaSession(track) {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist || 'FreeSong',
        album: 'FreeSong Premium',
        artwork: [
          { src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' },
          { src: track.thumbnail, sizes: '192x192', type: 'image/jpeg' },
          { src: track.thumbnail, sizes: '96x96', type: 'image/jpeg' }
        ]
      });

      navigator.mediaSession.setActionHandler('play', () => resumePlayback());
      navigator.mediaSession.setActionHandler('pause', () => pausePlayback());
      navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) {
          const p = getActivePlayer();
          if (p && p.seekTo) p.seekTo(details.seekTime, true);
        }
      });
    } catch {}
  }

  // --- Reproducción y Cambio de Pista ---
  async function playTrack(index, immediate = false) {
    if (index < 0 || index >= S.queue.length) return;
    S.currentIndex = index;
    const track = S.queue[index];

    userIntentionalPause = false;
    keepAudioAlive();

    // Actualizar UI
    updatePlayerUI(track);
    saveHistory(track);
    loadLyrics(track);
    updateMediaSession(track);

    if (!isEngineReady) {
      setTimeout(() => playTrack(index, immediate), 300);
      return;
    }

    const shouldCrossfade = S.crossfade && S.isPlaying && !immediate;
    const outPlayer = getActivePlayer();
    const inPlayer = shouldCrossfade ? getInactivePlayer() : getActivePlayer();

    try {
      if (shouldCrossfade) {
        inPlayer.setVolume(0);
        inPlayer.loadVideoById({
          videoId: track.id,
          startSeconds: 0
        });
        inPlayer.playVideo();

        // Iniciar Crossfade igual que Spotify Premium
        performCrossfade(outPlayer, inPlayer, S.crossfadeDuration);
      } else {
        if (isCrossfading) {
          clearInterval(fadeInterval);
          isCrossfading = false;
        }
        if (outPlayer && outPlayer !== inPlayer) {
          outPlayer.stopVideo();
        }
        inPlayer.setVolume(100);
        inPlayer.loadVideoById({
          videoId: track.id,
          startSeconds: 0
        });
        inPlayer.playVideo();
      }

      S.isPlaying = true;
      updatePlayPauseIcons(true);
    } catch (err) {
      console.error('Error al reproducir pista:', err);
    }
  }

  // --- Curva de Crossfade Senoidal en S (Equal-Power de Spotify) ---
  function performCrossfade(outP, inP, durationSec) {
    if (isCrossfading) clearInterval(fadeInterval);
    isCrossfading = true;

    const steps = 30;
    const stepTime = (durationSec * 1000) / steps;
    let currentStep = 0;

    fadeInterval = setInterval(() => {
      currentStep++;
      const progress = currentStep / steps; // 0.0 -> 1.0

      // Curva trigonométrica de potencia constante
      const outVol = Math.cos((progress * Math.PI) / 2) * 100;
      const inVol = Math.sin((progress * Math.PI) / 2) * 100;

      try {
        outP.setVolume(Math.max(0, Math.min(100, Math.round(outVol))));
        inP.setVolume(Math.max(0, Math.min(100, Math.round(inVol))));
      } catch {}

      if (currentStep >= steps) {
        clearInterval(fadeInterval);
        try {
          outP.stopVideo();
          outP.setVolume(100);
          inP.setVolume(100);
        } catch {}
        activeDeckIdx = 1 - activeDeckIdx; // El nuevo deck es ahora el activo
        isCrossfading = false;
      }
    }, stepTime);
  }

  function pausePlayback() {
    userIntentionalPause = true;
    const p = getActivePlayer();
    if (p && p.pauseVideo) p.pauseVideo();
    const inact = getInactivePlayer();
    if (inact && inact.pauseVideo) inact.pauseVideo();
    S.isPlaying = false;
    updatePlayPauseIcons(false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }

  function resumePlayback() {
    userIntentionalPause = false;
    keepAudioAlive();
    if (S.currentIndex === -1 && S.queue.length > 0) {
      playTrack(0);
      return;
    }
    const p = getActivePlayer();
    if (p && p.playVideo) {
      p.playVideo();
      S.isPlaying = true;
      updatePlayPauseIcons(true);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    }
  }

  function togglePlayPause() {
    if (S.isPlaying) pausePlayback();
    else resumePlayback();
  }

  function playNext() {
    userIntentionalPause = false;
    if (S.queue.length === 0) return;
    if (S.repeat === 'one') {
      const p = getActivePlayer();
      if (p && p.seekTo) p.seekTo(0, true);
      return;
    }
    let nextIdx = S.currentIndex + 1;
    if (S.shuffle) {
      nextIdx = Math.floor(Math.random() * S.queue.length);
    }
    if (nextIdx >= S.queue.length) {
      if (S.repeat === 'all') nextIdx = 0;
      else return;
    }
    playTrack(nextIdx, !S.crossfade);
  }

  function playPrev() {
    userIntentionalPause = false;
    if (S.queue.length === 0) return;
    const p = getActivePlayer();
    if (p && p.getCurrentTime && p.getCurrentTime() > 3) {
      p.seekTo(0, true);
      return;
    }
    let prevIdx = S.currentIndex - 1;
    if (prevIdx < 0) prevIdx = S.queue.length - 1;
    playTrack(prevIdx, true);
  }

  // --- Monitoreo de tiempo, progreso, letras y Auto-Crossfade ---
  function startTimeMonitor() {
    if (timeMonitorInterval) clearInterval(timeMonitorInterval);
    timeMonitorInterval = setInterval(() => {
      const p = getActivePlayer();
      if (!p || !p.getCurrentTime || !p.getDuration) return;

      try {
        const cur = p.getCurrentTime() || 0;
        const dur = p.getDuration() || 0;

        if (dur > 0) {
          $('playerCurTime').textContent = formatTime(cur);
          $('playerDurTime').textContent = formatTime(dur);
          const pct = (cur / dur) * 100;
          if (!isScrubbing) {
            $('playerSeek').value = pct;
          }
          $('miniProgress').style.width = `${pct}%`;

          // Detección automática de inicio de Crossfade antes del fin de pista
          const timeLeft = dur - cur;
          if (
            S.crossfade &&
            !isCrossfading &&
            timeLeft <= S.crossfadeDuration &&
            timeLeft > 0.8 &&
            S.queue.length > 1
          ) {
            playNext();
          }
        }

        // Sincronizar letra activa
        if (S.syncedLyrics.length > 0) {
          syncLyricsWithTime(cur);
        }
      } catch {}
    }, 250);
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
        if (p && p.seekTo) p.seekTo(lyricsList[idx].time, true);
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
    const isLiked = S.favorites.some((f) => f.id === track.id);
    const likeSvg = isLiked
      ? '<svg class="w-6 h-6 text-emerald-400"><use href="#i-heart-fill"/></svg>'
      : '<svg class="w-6 h-6 text-zinc-300"><use href="#i-heart"/></svg>';
    $('playerLikeBtn').innerHTML = likeSvg;
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
  }

  function saveHistory(track) {
    S.history = [track, ...S.history.filter((h) => h.id !== track.id)].slice(0, 50);
    localStorage.setItem('fs_history', JSON.stringify(S.history));
    updateLibraryCounters();
  }

  function updateLibraryCounters() {
    $('libLikedCount').textContent = `${S.favorites.length} canciones`;
    $('libRecentCount').textContent = `${S.history.length} escuchadas`;
  }

  function renderQueue() {
    const container = $('queueList');
    if (S.queue.length === 0) {
      container.innerHTML = '<p class="text-zinc-500 text-xs px-2">La cola está vacía</p>';
      return;
    }
    container.innerHTML = S.queue.map((t, idx) => `
      <div class="flex items-center justify-between p-2 rounded-xl ${idx === S.currentIndex ? 'bg-emerald-500/15 border border-emerald-500/30' : 'hover:bg-zinc-900'} cursor-pointer press" data-queue-idx="${idx}">
        <div class="flex items-center gap-2.5 min-w-0">
          <img src="${t.thumbnail}" class="w-9 h-9 rounded-lg object-cover bg-zinc-800 shrink-0" />
          <div class="min-w-0">
            <p class="text-xs font-bold ${idx === S.currentIndex ? 'text-emerald-400' : 'text-white'} truncate">${t.title}</p>
            <p class="text-[10px] text-zinc-400 truncate">${t.artist}</p>
          </div>
        </div>
        ${idx === S.currentIndex ? '<span class="text-[9px] uppercase font-bold text-emerald-400 shrink-0 px-2 py-0.5 rounded-full bg-emerald-500/20">Sonando</span>' : ''}
      </div>
    `).join('');

    $$('[data-queue-idx]').forEach((el) => {
      el.addEventListener('click', () => {
        const i = parseInt(el.getAttribute('data-queue-idx'), 10);
        playTrack(i, true);
      });
    });
  }

  // --- Carga de Contenido: Inicio (YouTube Music Browse) ---
  async function loadHomeContent() {
    const container = $('homeShelves');
    try {
      const res = await fetch('/api/home');
      const data = await res.json();

      if (!data.shelves || data.shelves.length === 0) {
        container.innerHTML = '<p class="text-center py-10 text-zinc-500 text-sm">No se pudieron cargar recomendaciones</p>';
        return;
      }

      container.innerHTML = data.shelves.map((shelf) => `
        <div class="space-y-3">
          <div class="flex items-center justify-between px-1">
            <h2 class="text-lg font-bold text-white tracking-tight">${shelf.title}</h2>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            ${shelf.items.map((t) => `
              <div class="group relative rounded-2xl bg-zinc-900/60 p-3 border border-zinc-800/60 hover:bg-zinc-800/80 transition cursor-pointer press" data-track-id="${t.id}" data-title="${encodeURIComponent(t.title)}" data-artist="${encodeURIComponent(t.artist)}" data-thumb="${encodeURIComponent(t.thumbnail)}">
                <div class="w-full aspect-square rounded-xl overflow-hidden bg-zinc-800 mb-2.5 relative shadow-md">
                  <img src="${t.thumbnail}" alt="" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" loading="lazy" />
                  <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
                    <div class="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center text-black shadow-lg">
                      <svg class="w-5 h-5"><use href="#i-play"/></svg>
                    </div>
                  </div>
                </div>
                <p class="text-xs font-bold text-white truncate">${t.title}</p>
                <p class="text-[11px] text-zinc-400 truncate mt-0.5">${t.artist}</p>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('');

      $$('[data-track-id]').forEach((card) => {
        card.addEventListener('click', () => {
          const id = card.getAttribute('data-track-id');
          const title = decodeURIComponent(card.getAttribute('data-title'));
          const artist = decodeURIComponent(card.getAttribute('data-artist'));
          const thumbnail = decodeURIComponent(card.getAttribute('data-thumb'));

          const selectedTrack = { id, title, artist, thumbnail };
          S.queue = [selectedTrack, ...S.queue.filter((x) => x.id !== id)];
          playTrack(0, true);
        });
      });
    } catch {
      container.innerHTML = '<p class="text-center py-10 text-zinc-500 text-sm">Error de conexión al cargar inicio</p>';
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
          <div class="flex items-center gap-3 min-w-0">
            <img src="${t.thumbnail}" class="w-12 h-12 rounded-xl object-cover bg-zinc-800 shrink-0 shadow-sm" loading="lazy" />
            <div class="min-w-0">
              <p class="text-sm font-bold text-white truncate">${t.title}</p>
              <p class="text-xs text-zinc-400 truncate mt-0.5">${t.artist}</p>
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
    }
  }

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
          <div class="flex items-center gap-2.5 min-w-0">
            <img src="${t.thumbnail}" class="w-10 h-10 rounded-lg object-cover bg-zinc-800 shrink-0" />
            <div class="min-w-0">
              <p class="text-xs font-bold text-white truncate">${t.title}</p>
              <p class="text-[11px] text-zinc-400 truncate">${t.artist}</p>
            </div>
          </div>
          <svg class="w-5 h-5 text-emerald-400 shrink-0"><use href="#i-heart-fill"/></svg>
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

  // --- Enlazar Eventos de la Interfaz ---
  function bindEvents() {
    // Pestañas inferiores
    $$('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.getAttribute('data-nav')));
    });

    // Mini Player abrir pantalla completa
    $('miniPlayer').addEventListener('click', (e) => {
      if (e.target.closest('#miniPlayBtn') || e.target.closest('#miniNextBtn')) return;
      $('fullPlayerSheet').classList.remove('translate-y-full');
    });

    // Cerrar pantalla completa
    $('playerCloseBtn').addEventListener('click', () => {
      $('fullPlayerSheet').classList.add('translate-y-full');
    });

    // Botones de Play/Pause y Skip
    $('miniPlayBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlayPause();
    });
    $('miniNextBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      playNext();
    });
    $('playerPlayBtn').addEventListener('click', togglePlayPause);
    $('playerNextBtn').addEventListener('click', playNext);
    $('playerPrevBtn').addEventListener('click', playPrev);

    // Like
    $('playerLikeBtn').addEventListener('click', () => {
      if (S.currentIndex >= 0) toggleLike(S.queue[S.currentIndex]);
    });

    // Barra de búsqueda seek sin stutter al arrastrar
    const seekEl = $('playerSeek');
    seekEl.addEventListener('pointerdown', () => { isScrubbing = true; });
    seekEl.addEventListener('touchstart', () => { isScrubbing = true; }, { passive: true });
    seekEl.addEventListener('pointerup', () => { isScrubbing = false; });
    seekEl.addEventListener('touchend', () => { isScrubbing = false; }, { passive: true });
    seekEl.addEventListener('change', () => { isScrubbing = false; });

    seekEl.addEventListener('input', (e) => {
      const pct = parseFloat(e.target.value);
      const p = getActivePlayer();
      if (p && p.getDuration) {
        const dur = p.getDuration();
        if (dur > 0) {
          p.seekTo((pct / 100) * dur, true);
        }
      }
    });

    // Subpestañas del Full Player: Canción / Letras / Cola
    $('tabTrackBtn').addEventListener('click', () => {
      $('sheetTrackView').classList.remove('hidden');
      $('sheetLyricsView').classList.add('hidden');
      $('sheetQueueView').classList.add('hidden');
      updateSubTabs('track');
    });
    $('tabLyricsBtn').addEventListener('click', () => {
      $('sheetTrackView').classList.add('hidden');
      $('sheetLyricsView').classList.remove('hidden');
      $('sheetQueueView').classList.add('hidden');
      updateSubTabs('lyrics');
    });
    $('tabQueueBtn').addEventListener('click', () => {
      $('sheetTrackView').classList.add('hidden');
      $('sheetLyricsView').classList.add('hidden');
      $('sheetQueueView').classList.remove('hidden');
      updateSubTabs('queue');
    });

    function updateSubTabs(view) {
      $('tabTrackBtn').className = view === 'track' ? 'px-3 py-1 rounded-full bg-emerald-500 text-black font-bold transition' : 'px-3 py-1 rounded-full text-zinc-400 hover:text-white font-medium transition';
      $('tabLyricsBtn').className = view === 'lyrics' ? 'px-3 py-1 rounded-full bg-emerald-500 text-black font-bold transition' : 'px-3 py-1 rounded-full text-zinc-400 hover:text-white font-medium transition';
      $('tabQueueBtn').className = view === 'queue' ? 'px-3 py-1 rounded-full bg-emerald-500 text-black font-bold transition' : 'px-3 py-1 rounded-full text-zinc-400 hover:text-white font-medium transition';
    }

    // Shuffle & Repeat
    $('playerShuffleBtn').addEventListener('click', () => {
      S.shuffle = !S.shuffle;
      $('playerShuffleBtn').className = S.shuffle ? 'p-2 text-emerald-400 press' : 'p-2 text-zinc-400 hover:text-white press';
    });

    $('playerRepeatBtn').addEventListener('click', () => {
      if (S.repeat === 'off') S.repeat = 'all';
      else if (S.repeat === 'all') S.repeat = 'one';
      else S.repeat = 'off';

      if (S.repeat === 'one') {
        $('playerRepeatBtn').innerHTML = '<svg class="w-5 h-5 text-emerald-400"><use href="#i-repeat-one"/></svg>';
      } else if (S.repeat === 'all') {
        $('playerRepeatBtn').innerHTML = '<svg class="w-5 h-5 text-emerald-400"><use href="#i-repeat"/></svg>';
      } else {
        $('playerRepeatBtn').innerHTML = '<svg class="w-5 h-5 text-zinc-400 hover:text-white"><use href="#i-repeat"/></svg>';
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
      if (confirm('¿Deseas borrar tus favoritos e historial?')) {
        localStorage.clear();
        S.favorites = [];
        S.history = [];
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
  }

  // --- Inicialización ---
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    setupSearch();
    updateLibraryCounters();
    loadHomeContent();

    // Registrar Service Worker para PWA en iPhone
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  });

})();

// Adaptador del motor Swift. Los IPA anteriores y la web conservan el motor HTML.
(() => {
  'use strict';
  const cap = window.Capacitor;
  const available = !!(cap?.getPlatform?.() === 'ios' && cap.isPluginAvailable?.('FreeSongAudio'));
  let current = { position: 0, duration: 0, playing: false, paused: true, buffering: false, index: -1, error: '' };
  let expected = '';
  let listener = null;
  let sequence = 0;
  let generation = 0;
  let subscription = null;
  let info = {};
  const imported = new Set();
  const call = (method, options = {}) => cap.nativePromise('FreeSongAudio', method, options);
  const player = {
    dataset: {},
    get currentTime() { return Number(current.position) || 0; },
    set currentTime(position) { call('seek', { position }).catch(reportError); },
    get duration() { return Number(current.duration) || 0; },
    get paused() { return !!current.paused; },
    get ended() { return current.duration > 0 && current.position >= current.duration - 0.05 && current.paused; },
    get readyState() { return current.playing ? 4 : current.buffering ? 1 : 0; },
    get src() { return 'native:' + (current.source || ''); },
    get currentSrc() { return this.src; },
    get volume() { return 1; },
    set volume(_) {},
    play() { return call('resume'); },
    pause() { return call('pause'); }
  };
  function reportError(error) {
    current = { ...current, error: error?.message || String(error), playing: false, paused: true, buffering: false };
    listener?.(current);
  }
  function accept(value) {
    if (!value || (expected && value.requestId !== expected)) return;
    current = value;
    player.dataset.trackId = value.trackId || '';
    listener?.(value);
  }
  async function importOffline(id, blob) {
    if (!available || imported.has(id) || !blob) return;
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    await call('importOffline', { id, data, mime: blob.type || 'audio/mp4' });
    imported.add(id);
  }
  window.FreeSongNative = {
    available, player,
    get state() { return current; },
    get info() { return info; },
    setListener(fn) {
      listener = fn;
      if (!available) return;
      subscription?.remove?.();
      subscription = cap.addListener('FreeSongAudio', 'state', accept);
    },
    async restore() {
      if (!available) return null;
      const token = generation;
      const value = await call('getState');
      if (token !== generation) return null;
      info = { appVersion: value.appVersion || '', iOSVersion: value.iOSVersion || '' };
      for (const id of value.offlineIds || []) imported.add(id);
      if (value.requestId) expected = value.requestId;
      if (value.trackId) accept(value);
      return value;
    },
    async play(queue, index, options, offlineBlob) {
      const id = expected = `web-${Date.now()}-${++sequence}`;
      const token = ++generation;
      current = { ...current, requestId: id, index, trackId: queue[index].id, position: options.position || 0,
        duration: queue[index].durationSeconds || queue[index].duration || 0, source: '', error: '', playing: false, paused: false, buffering: true };
      listener?.(current);
      try {
        if (offlineBlob) await importOffline(queue[index].id, offlineBlob);
        if (token !== generation) return;
        await call('play', { ...options, queue: queue.map(track => ({ id: track.id, title: track.title,
          artist: track.artist || '', thumbnail: track.thumbnail || '', duration: Number(track.durationSeconds || track.duration) || 0 })), index, requestId: id });
      } catch (error) { if (token === generation) reportError(error); }
    },
    pause() {
      generation++;
      current = { ...current, playing: false, paused: true, buffering: false };
      listener?.(current);
      return call('pause').catch(reportError);
    },
    resume() { return call('resume').catch(reportError); },
    configure(options) { if (available) return call('configure', options).catch(reportError); },
    importOffline,
    hasOffline(id) { return imported.has(id); },
    clearOffline() { imported.clear(); return call('clearOffline'); },
    removeOffline(id) { imported.delete(id); if (available) return call('removeOffline', { id }); }
  };
  if (available && window.addEventListener) {
    window.addEventListener('pagehide', () => { subscription?.remove?.(); subscription = null; });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted && listener && !subscription) subscription = cap.addListener('FreeSongAudio', 'state', accept);
    });
  }
})();

(() => {
  const $ = id => document.getElementById(id), audio = $('audio');
  let session = null, generation = 0;
  const status = text => { $('status').textContent = text; };
  async function api(method = 'GET', body, id) {
    const res = await fetch('/api/health?mixer=1' + (id ? '&session=' + encodeURIComponent(id) : ''), {
      method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000), cache: 'no-store'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo conectar al mezclador.');
    return data;
  }
  const release = id => { if (id) return api('DELETE', null, id).catch(() => {}); };
  async function stop() {
    generation++;
    audio.pause(); audio.removeAttribute('src'); audio.load();
    const id = session; session = null;
    $('stop').disabled = true;
    await release(id);
  }
  $('stop').onclick = async () => { await stop(); $('prepare').disabled = false; status('Prueba detenida.'); };
  $('form').onsubmit = async event => {
    event.preventDefault();
    await stop();
    const token = generation;
    $('prepare').disabled = true;
    $('stop').disabled = false;
    status('Preparando audio en Render. El primer arranque puede tardar un minuto.');
    try {
      const result = await api('POST', { tracks: [
        { id: $('first').value.trim(), title: '' }, { id: $('second').value.trim(), title: '' }
      ], crossfade: Number($('seconds').value) });
      if (token !== generation) { await release(result.id); return; }
      session = result.id;
      for (let i = 0; i < 45; i++) {
        if (token !== generation) return;
        const state = await api('GET', null, session);
        if (token !== generation) return;
        if (state.status === 'failed') throw new Error('El servidor no consiguió mezclar el audio. Hay que revisar las fuentes; no es un problema del botón de crossfade.');
        const playlist = await fetch(result.playlist, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (token !== generation) return;
        const text = playlist.ok ? await playlist.text() : '';
        if (text.startsWith('#EXTM3U') && text.includes('#EXTINF:')) {
          audio.src = result.playlist;
          status('Audio preparado. Pulsa ▶ en el reproductor y después bloquea el iPhone.');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      throw new Error('La preparación tardó demasiado. El servicio todavía no está listo para esta prueba.');
    } catch (error) {
      if (token !== generation) return;
      await stop();
      status(error.message);
      $('prepare').disabled = false;
    }
  };
  audio.addEventListener('error', () => status('El navegador no pudo reproducir este flujo. La prueba aún no está validada.'));
  api().then(data => {
    $('prepare').disabled = !data.configured;
    status(data.configured ? 'Conexión configurada. Puedes preparar la prueba.' : 'Falta configurar MIXER_API_KEY en Vercel y desplegar de nuevo.');
  }).catch(error => { $('prepare').disabled = true; status(error.message); });
})();

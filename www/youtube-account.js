// Google authorization is only loaded after the importer consent is selected.
(() => {
  'use strict';

  const scope = 'https://www.googleapis.com/auth/youtube.readonly';
  const $ = (id) => document.getElementById(id);
  const visible = (id, value) => $(id).classList.toggle('hidden', !value);

  async function loadGoogleIdentity() {
    if (window.google?.accounts?.oauth2) return window.google.accounts.oauth2;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    await new Promise((resolve, reject) => {
      const fail = () => {
        clearTimeout(timeout);
        script.remove();
        reject(new Error('No se pudo cargar el acceso de Google.'));
      };
      const timeout = setTimeout(fail, 15_000);
      script.onload = () => { clearTimeout(timeout); resolve(); };
      script.onerror = fail;
      document.head.appendChild(script);
    });
    const oauth = window.google?.accounts?.oauth2;
    if (!oauth) throw new Error('No se pudo iniciar el acceso de Google.');
    return oauth;
  }

  window.FreeSongYouTubeAccount = function bindYouTubeAccount({ savePlaylist, hasCopies, removeCopies }) {
    const service = window.FreeSongYouTubeImport;
    const connect = $('youtubeConnectBtn');
    const consent = $('youtubeImportConsent');
    const results = $('youtubeImportList');
    let config;
    let oauth;
    let loadingConfig = false;
    let loadingGoogle = false;
    let account;
    let job;
    let approval;
    let playlists = [];
    let expiration;

    function status(message, error = false) {
      const node = $('youtubeImportStatus');
      node.textContent = message;
      node.classList.toggle('text-red-400', error);
      visible(node.id, !!message);
    }

    function showControls() {
      const busy = !!job || !!approval;
      visible('youtubeImportAccount', !!account);
      visible('youtubeImportChannel', !!account);
      visible('youtubeImportConsentWrap', !account && config !== null);
      visible('youtubeClearCopiesBtn', !account && hasCopies());
      visible('youtubeConnectBtn', !account && config !== null);
      $('youtubeImportChannel').textContent = account?.channel.title || '';
      consent.disabled = !config || busy;
      connect.disabled = !oauth || !consent.checked || busy;
      $('youtubePlaylistsBtn').disabled = busy;
      $('youtubeLikedBtn').disabled = busy;
      results.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
    }

    function clearResults() {
      playlists = [];
      results.replaceChildren();
      visible(results.id, false);
      visible('youtubeImportEmpty', false);
    }

    function forgetAccount() {
      account = null;
      clearTimeout(expiration);
      clearResults();
    }

    function cancel() {
      approval = null;
      job?.abort();
      job = null;
      clearResults();
      status('');
    }

    async function open() {
      showControls();
      if (config === null) {
        status('El acceso con cuenta aún no está configurado. Puedes importar con un enlace público.');
        return;
      }
      if (config || loadingConfig) return;
      loadingConfig = true;
      status('Preparando el importador de YouTube…');
      try {
        const response = await fetch('/api/import?youtube-config=1', {
          cache: 'no-store', signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) throw new Error('No se pudo abrir el importador de YouTube.');
        const { clientId } = await response.json();
        if (!clientId) {
          config = null;
          status('El acceso con cuenta aún no está configurado. Puedes importar con un enlace público.');
          return;
        }
        config = clientId;
        status('');
      } catch {
        status('No se pudo consultar la configuración. Vuelve a abrir esta sección para reintentar.', true);
      } finally {
        loadingConfig = false;
        showControls();
      }
    }

    async function onConsentChange() {
      showControls();
      if (!consent.checked || !config || oauth || loadingGoogle) return;
      loadingGoogle = true;
      status('Cargando el acceso de Google…');
      try {
        oauth = await loadGoogleIdentity();
        status('');
      } catch {
        consent.checked = false;
        status('No se pudo cargar Google. Vuelve a marcar la casilla para reintentar.', true);
      } finally {
        loadingGoogle = false;
        showControls();
      }
    }

    function handleError(error) {
      if (error.code === 'auth') {
        forgetAccount();
        status('La sesión de YouTube terminó. Vuelve a conectar la cuenta para importar.', true);
      } else {
        status(error.message || 'No se pudo completar la importación.', true);
      }
    }

    async function work(message, load, done) {
      if (job) return;
      const task = new AbortController();
      job = task;
      status(message);
      showControls();
      try {
        const data = await load(task.signal);
        if (job === task) done(data);
      } catch (error) {
        if (job === task && !task.signal.aborted) handleError(error);
      } finally {
        if (job === task) {
          job = null;
          showControls();
        }
      }
    }

    function requestAccess() {
      if (!config || !oauth || !consent.checked || approval || job) return;
      const attempt = {};
      approval = attempt;
      const finish = () => {
        if (approval !== attempt) return false;
        approval = null;
        showControls();
        return true;
      };
      const popupError = ({ type } = {}) => {
        if (!finish()) return;
        status(type === 'popup_closed' ? 'Se cerró la ventana de Google. Puedes reintentar.' :
          'Google no pudo abrir la ventana de acceso. Permite ventanas emergentes o abre FreeSong en Safari.', true);
      };
      showControls();
      try {
        const client = oauth.initTokenClient({
          client_id: config,
          scope,
          include_granted_scopes: false,
          error_callback: popupError,
          callback: (response) => {
            if (!finish()) return;
            if (response.error || !response.access_token || !oauth.hasGrantedAllScopes(response, scope)) {
              status('Google no concedió el permiso de lectura. Puedes reintentar.', true);
              return;
            }
            const token = response.access_token;
            const lifetime = Number(response.expires_in);
            const expiresAt = Date.now() + (lifetime > 0 && lifetime <= 86400 ? lifetime * 1000 : 3600_000);
            void work('Identificando tu canal…', signal => service.getChannel(token, { signal }), (channel) => {
              account = { token, channel };
              clearTimeout(expiration);
              expiration = setTimeout(() => {
                cancel();
                forgetAccount();
                status('La sesión de YouTube terminó. Vuelve a conectar la cuenta para importar.');
                showControls();
              }, Math.max(0, expiresAt - Date.now()));
              status('');
            });
          }
        });
        // Must stay in the real Connect click for Safari's popup permissions.
        client.requestAccessToken({ prompt: 'select_account' });
      } catch {
        popupError();
      }
    }

    function showPlaylists({ items, truncated }) {
      playlists = items;
      const rows = items.map((item, index) => {
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'youtube-import-playlist-row w-full text-left';
        button.dataset.youtubePlaylistIndex = index;
        button.textContent = item.title;
        row.appendChild(button);
        return row;
      });
      results.replaceChildren(...rows);
      visible(results.id, items.length > 0);
      visible('youtubeImportEmpty', items.length === 0);
      status(truncated ? `Se muestran las primeras ${items.length} playlists.` : '');
    }

    function importTracks(sourceId, name, load) {
      const current = account;
      if (!current) return;
      visible('youtubeImportEmpty', false);
      void work('Importando canciones…', signal => load(current.token, signal), ({ items, truncated }) => {
        if (!items.length) {
          visible('youtubeImportEmpty', true);
          status('');
          return;
        }
        savePlaylist({ channelId: current.channel.id, sourceId, name, tracks: items });
        status(`${items.length} ${items.length === 1 ? 'canción guardada' : 'canciones guardadas'} en «${name}».${
          truncated ? ' La lista es más larga. Se importó el primer tramo.' : ''}`);
      });
    }

    function disconnect() {
      const token = account?.token;
      try {
        removeCopies();
      } catch (error) {
        handleError(error);
        return;
      }
      cancel();
      forgetAccount();
      consent.checked = false;
      showControls();
      status('Se borraron las copias de este dispositivo.');
      if (!token) return;
      const revokeError = () => status('Copias borradas. Si el permiso sigue activo, puedes quitarlo en la configuración de tu cuenta de Google.', true);
      try {
        oauth.revoke(token, (result) => {
          if (result?.successful === false && !account) revokeError();
        });
      } catch {
        revokeError();
      }
    }

    consent.addEventListener('change', onConsentChange);
    connect.addEventListener('click', requestAccess);
    $('youtubePlaylistsBtn').addEventListener('click', () => {
      if (!account) return;
      clearResults();
      const token = account.token;
      void work('Leyendo tus playlists…', signal => service.listPlaylists(token, { signal }), showPlaylists);
    });
    $('youtubeLikedBtn').addEventListener('click', () => {
      importTracks('liked', 'Me gusta de YouTube', (token, signal) => service.readLikedVideos(token, { signal }));
    });
    results.addEventListener('click', (event) => {
      const button = event.target.closest('[data-youtube-playlist-index]');
      const playlist = button && playlists[Number(button.dataset.youtubePlaylistIndex)];
      if (playlist) importTracks(playlist.id, playlist.title, (token, signal) => service.readPlaylist(token, playlist.id, { signal }));
    });
    $('youtubeDisconnectBtn').addEventListener('click', disconnect);
    $('youtubeClearCopiesBtn').addEventListener('click', disconnect);

    return { open, cancel };
  };
})();

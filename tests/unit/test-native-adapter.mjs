import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../www/native-audio.js', import.meta.url), 'utf8');
function setup(available = true) {
  const calls = [];
  let listener;
  let restore;
  const context = vm.createContext({ window: {}, Date, Set, Promise,
    FileReader: class {
      readAsDataURL() { this.result = 'data:audio/mp4;base64,AAAA'; queueMicrotask(() => this.onload()); }
    }
  });
  if (available) context.window.Capacitor = {
    getPlatform: () => 'ios', isPluginAvailable: () => true,
    addListener(plugin, event, fn) { assert.equal(plugin, 'FreeSongAudio'); assert.equal(event, 'state'); listener = fn; },
    nativePromise(plugin, method, options) {
      assert.equal(plugin, 'FreeSongAudio');
      calls.push({ method, options });
      if (method === 'getState') return new Promise(resolve => { restore = resolve; });
      return Promise.resolve({});
    }
  };
  vm.runInContext(source, context);
  return { api: context.window.FreeSongNative, calls, emit: value => listener(value), restore: value => restore(value) };
}
const browser = setup(false);
assert.equal(browser.api.available, false);
assert.equal(await browser.api.restore(), null);
browser.api.configure({ rate: 2 });
assert.equal(browser.calls.length, 0, 'La PWA no debe enviar comandos nativos');

const native = setup();
const events = [];
native.api.setListener(value => events.push(value));
const queue = [{ id: 'one', title: 'Uno', duration: 191, streamUrl: 'https://secret.invalid/?signature=private' }, { id: 'two', title: 'Dos', duration: 200 }];
await native.api.play(queue, 0, { crossfade: true, crossfadeDuration: 6 });
const first = native.calls.find(call => call.method === 'play').options;
assert.equal(events[0].buffering, true);
assert.equal(first.queue[0].streamUrl, undefined, 'Las URLs firmadas no forman parte de la biblioteca nativa');
native.emit({ requestId: first.requestId, trackId: 'one', index: 0, playing: true, paused: false, duration: 380.975, position: 10 });
assert.equal(native.api.player.duration, 380.975, 'La interfaz recibe la duración real sin truncar por metadatos');
native.api.player.currentTime = 30;
assert.equal(native.calls.at(-1).method, 'seek');
assert.equal(native.calls.at(-1).options.position, 30);
await native.api.pause();
assert.equal(native.api.player.paused, true);

// Una respuesta de estado anterior no puede cancelar una selección nueva.
const restoring = native.api.restore();
await native.api.play(queue, 1, {});
const second = native.calls.filter(call => call.method === 'play').at(-1).options;
native.restore({ requestId: first.requestId, trackId: 'one', index: 0, paused: false });
assert.equal(await restoring, null);
native.emit({ requestId: first.requestId, trackId: 'one', index: 0, playing: true });
assert.equal(native.api.state.trackId, 'two');
native.emit({ requestId: second.requestId, trackId: 'two', index: 1, paused: false, playing: true, position: 4 });
assert.equal(native.api.player.currentTime, 4);

await native.api.importOffline('one', {});
await native.api.importOffline('one', {});
assert.equal(native.calls.filter(call => call.method === 'importOffline').length, 1, 'Una copia local no se duplica en cada reproducción');
await native.api.removeOffline('one');
assert.equal(native.calls.at(-1).method, 'removeOffline');

const cancelling = setup();
cancelling.api.setListener(() => {});
const pendingPlay = cancelling.api.play(queue, 0, {}, {});
await cancelling.api.pause();
await pendingPlay;
assert.equal(cancelling.calls.some(call => call.method === 'play'), false, 'Pausar durante la migración offline cancela el arranque pendiente');
console.log('ADAPTADOR NATIVO OK: estado, duración real, seek, pausa, respuestas antiguas y audio local');

// Pruebas unitarias de www/storage.js (sin navegador).
//
// Verifica que datos corruptos o una cuota llena nunca rompan el arranque ni
// sobrescriban la biblioteca del usuario.
//
// Uso: npm run test:unit
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../www/storage.js', import.meta.url), 'utf8');
const data = new Map();
let failWrites = false;
const localStorageMock = {
  getItem: (key) => (data.has(key) ? data.get(key) : null),
  setItem: (key, value) => {
    if (failWrites) throw new Error('QuotaExceededError');
    data.set(key, String(value));
  }
};
const sandbox = { localStorage: localStorageMock, window: {} };
const context = createContext(sandbox);
runInContext(source, context);

const Store = sandbox.window.FreeSongStorage;
assert.ok(Store, 'storage.js debe exponer window.FreeSongStorage');

// Los objetos del contexto vm tienen otro prototipo: compara su contenido.
const sameJson = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));

// lectura normal
Store.write('ok_array', [1, 2, 3]);
sameJson(Store.readArray('ok_array'), [1, 2, 3]);
Store.write('ok_object', { a: 1 });
sameJson(Store.readObject('ok_object'), { a: 1 });

// datos corruptos: nunca lanzan y devuelven el tipo esperado
data.set('corrupto', '{no es json');
sameJson(Store.readArray('corrupto'), []);
sameJson(Store.readObject('corrupto'), {});
assert.equal(Store.read('corrupto', 'fallback'), 'fallback');

// tipo inesperado: se normaliza al contenedor correcto
data.set('objeto', '{"a":1}');
sameJson(Store.readArray('objeto'), []);
data.set('array', '[1,2]');
sameJson(Store.readObject('array'), {});

// clave ausente
sameJson(Store.readArray('no_existe'), []);
assert.equal(Store.readRaw('no_existe', 'x'), 'x');
assert.equal(Store.read('no_existe', null), null);

// escritura fallida: devuelve false sin lanzar
failWrites = true;
assert.equal(Store.write('sin_cuota', { a: 1 }), false);
assert.equal(data.has('sin_cuota'), false);

console.log('STORAGE OK');

// Pruebas unitarias de www/lyrics.js (sin navegador).
//
// Cubre el parseo de LRC (varias marcas por línea, offset, LRC mejorado,
// duplicados y orden) y la búsqueda binaria de la línea actual.
//
// Uso: npm run test:unit
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../www/lyrics.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
const context = createContext(sandbox);
runInContext(source, context);

const Lyrics = sandbox.window.FreeSongLyrics;
assert.ok(Lyrics, 'lyrics.js debe exponer window.FreeSongLyrics');

// Los arrays del contexto vm tienen otro prototipo: compara su contenido.
const sameJson = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));

// formato básico
let parsed = Lyrics.parseLrc('[00:12.34]Hola\n[01:02]Mundo');
assert.equal(parsed.length, 2);
assert.equal(parsed[0].time, 12.34);
assert.equal(parsed[0].text, 'Hola');
assert.equal(parsed[1].time, 62);
assert.equal(parsed[1].text, 'Mundo');

// varias marcas de tiempo en una sola línea
parsed = Lyrics.parseLrc('[00:10.00][00:20.00]Coro');
assert.equal(parsed.length, 2);
sameJson(parsed.map((x) => x.time), [10, 20]);
sameJson(parsed.map((x) => x.text), ['Coro', 'Coro']);

// offset global (milisegundos, puede ser negativo)
parsed = Lyrics.parseLrc('[offset:-500]\n[00:10.00]Hola');
assert.equal(parsed[0].time, 9.5);
parsed = Lyrics.parseLrc('[offset:250]\n[00:10.00]Hola');
assert.equal(parsed[0].time, 10.25);

// el tiempo nunca queda negativo
parsed = Lyrics.parseLrc('[offset:-5000]\n[00:01.00]Hola');
assert.equal(parsed[0].time, 0);

// LRC mejorado: quita las marcas de palabra
parsed = Lyrics.parseLrc('[00:05.00]<00:05.00>Hola <00:05.50>mundo');
assert.equal(parsed.length, 1);
assert.ok(!parsed[0].text.includes('<'), parsed[0].text);
assert.ok(parsed[0].text.includes('Hola'), parsed[0].text);

// ordena y elimina duplicados exactos
parsed = Lyrics.parseLrc('[00:20.00]B\n[00:10.00]A\n[00:10.00]A');
sameJson(parsed.map((x) => x.text), ['A', 'B']);

// entradas sin letra o sin tiempos se ignoran
sameJson(Lyrics.parseLrc(''), []);
sameJson(Lyrics.parseLrc(null), []);
sameJson(Lyrics.parseLrc('sin marcas de tiempo'), []);
sameJson(Lyrics.parseLrc('[00:10.00]'), []);

// clave de caché estable y en minúsculas
assert.equal(Lyrics.cacheKey(null), '');
assert.equal(
  Lyrics.cacheKey({ id: 'abc', title: 'Canción', artist: 'Artista' }),
  'abc|canción|artista'
);

// búsqueda binaria de la línea actual
const list = [{ time: 1 }, { time: 3 }, { time: 5 }];
assert.equal(Lyrics.findIndex([], 9), -1);
assert.equal(Lyrics.findIndex(list, 0), -1);
assert.equal(Lyrics.findIndex(list, 1), 0);
assert.equal(Lyrics.findIndex(list, 3.5), 1);
assert.equal(Lyrics.findIndex(list, 99), 2);

console.log('LYRICS OK');

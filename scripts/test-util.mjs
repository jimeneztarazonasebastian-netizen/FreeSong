// Pruebas unitarias de www/util.js (sin navegador).
//
// Carga el módulo en un contexto aislado, como lo haría el navegador, y
// comprueba los helpers puros que usa toda la interfaz.
//
// Uso: npm run test:unit
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../www/util.js', import.meta.url), 'utf8');
const sandbox = {
  URL,
  window: { location: { href: 'https://freesong-pied.vercel.app/' } }
};
const context = createContext(sandbox);
runInContext(source, context);

const util = sandbox.window.FreeSongUtil;
assert.ok(util, 'util.js debe exponer window.FreeSongUtil');

// escapado de HTML
assert.equal(
  util.esc('<script>alert("x") & \'y\'</script>'),
  '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;'
);
assert.equal(util.esc(null), '');
assert.equal(util.esc(undefined), '');
assert.equal(util.esc(0), '0');

// duración legible
assert.equal(util.formatTime(0), '0:00');
assert.equal(util.formatTime(65.9), '1:05');
assert.equal(util.formatTime(3599), '59:59');
assert.equal(util.formatTime(-4), '0:00');
assert.equal(util.formatTime(NaN), '0:00');

// miniaturas
assert.equal(
  util.thumbAt('https://i.ytimg.com/vi/abc123/mqdefault.jpg'),
  'https://i.ytimg.com/vi/abc123/mqdefault.jpg'
);
assert.equal(
  util.thumbAt('https://i.ytimg.com/vi/abc123/mqdefault.jpg', 480),
  'https://i.ytimg.com/vi/abc123/maxresdefault.jpg'
);
assert.match(
  util.thumbAt('https://lh3.googleusercontent.com/abc=w120-h120-l90-rj', 720),
  /=w720-h720-l90-rj/
);
assert.equal(util.thumbAt('data:image/png;base64,abc', 720), 'data:image/png;base64,abc');
assert.equal(util.thumbAt('', 720), '');
assert.equal(util.thumbAt('no-es-una-url', 720), 'no-es-una-url');

// mezcla: no muta la lista original y conserva los elementos
const original = [1, 2, 3, 4, 5];
const mixed = util.shuffled(original);
assert.notEqual(mixed, original);
assert.deepEqual([...mixed].sort((a, b) => a - b), original);
assert.deepEqual(original, [1, 2, 3, 4, 5]);

console.log('UTIL OK');

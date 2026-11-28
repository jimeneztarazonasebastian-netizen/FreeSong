import assert from 'node:assert/strict';
import { pickFormat } from '../../api/stream.js';

const silent = { itag: 137, url: 'https://example.test/video', mimeType: 'video/mp4' };
const muxed = { itag: 18, url: 'https://example.test/muxed', mimeType: 'video/mp4' };
const aac = { itag: 140, url: 'https://example.test/aac', mimeType: 'audio/mp4' };
const opus = { itag: 251, url: 'https://example.test/opus', mimeType: 'audio/webm' };
assert.equal(pickFormat([silent], '140'), null, 'Un vídeo sin audio no es un respaldo válido');
assert.equal(pickFormat([silent, opus], '140'), opus);
assert.equal(pickFormat([muxed, aac], '140'), muxed);
assert.equal(pickFormat([muxed, aac], '140', true), aac);
assert.equal(pickFormat([muxed], '18', true), null, 'Una descarga de audio no debe incluir vídeo');
assert.equal(pickFormat([aac, opus], '251', true), opus);
console.log('FORMATOS STREAM OK');

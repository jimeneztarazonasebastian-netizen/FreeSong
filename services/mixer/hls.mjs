import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const mediaFile = /^segment-\d{5}\.ts$/;
const lookahead = 20;
export const idleSessionMs = 20 * 60_000;
const maxSessionMs = 60 * 60_000;
const nativeStartIdleMs = 90_000;

export function sessionExpired(session, now = Date.now()) {
  const idle = session.launchKey && session.lastSegmentAt == null ? nativeStartIdleMs : idleSessionMs;
  return now - (session.lastSegmentAt ?? session.created) >= idle ||
    now - session.created >= maxSessionMs;
}

export async function readManifest(render) {
  const text = await readFile(join(render.directory, 'index.m3u8'), 'utf8');
  const entries = [...text.matchAll(/^(#EXTINF:(\d+(?:\.\d+)?),[^\r\n]*)\r?\n(segment-\d{5}\.ts)$/gm)]
    .map(([, line, duration, file]) => ({ line, duration: Number(duration), file }));
  return { text, entries, ended: text.includes('#EXT-X-ENDLIST') };
}

// An EVENT playlist may grow but may never remove or rewrite an advertised
// segment. The clock is driven by actual media requests, even when Safari
// suspends the page. Leave enough media ahead for native HLS buffering.
export function publishManifest(session, manifest, now = Date.now()) {
  const elapsed = session.startedAt == null ? 0 : (now - session.startedAt) / 1000;
  const startAt = session.startAt ?? 0;
  const horizon = startAt + Math.max(0, elapsed) + lookahead;
  let position = 0;
  let count = 0;
  for (const entry of manifest.entries) {
    if (position >= horizon) break;
    position += entry.duration;
    count++;
  }
  const countToPublish = Math.min(manifest.entries.length, Math.max(count, session.published));
  const header = manifest.text.split(/\r?\n/).filter(line =>
    /^#EXT(?:M3U|-X-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE|PLAYLIST-TYPE):)/.test(line));
  // Use a constant upper bound across renders, including the final segment.
  const target = header.findIndex(line => line.startsWith('#EXT-X-TARGETDURATION:'));
  if (target >= 0) header[target] = '#EXT-X-TARGETDURATION:5';
  const published = manifest.entries.slice(0, countToPublish);
  session.published = published.length;
  session.endPublished = manifest.ended && countToPublish === manifest.entries.length;
  // Keep the entire prefix stable for queue edits, while telling the player
  // where it can join the track that is already playing.
  const start = session.editable && startAt > 0 && position >= startAt
    ? `#EXT-X-START:TIME-OFFSET=${startAt},PRECISE=YES`
    : '#EXT-X-START:TIME-OFFSET=0';
  return [...header, start, ...published.flatMap(e => [e.line, e.file]),
    ...(session.endPublished ? ['#EXT-X-ENDLIST'] : []), ''].join('\n');
}

export function segmentIndex(file) {
  return mediaFile.test(file) ? Number(file.slice(8, 13)) : -1;
}

export async function identicalSegments(oldRender, newRender, oldEntries, newEntries, start, end) {
  for (let i = start; i < end; i++) {
    const oldEntry = oldEntries[i], nextEntry = newEntries[i];
    if (!oldEntry || !nextEntry || oldEntry.file !== nextEntry.file || oldEntry.line !== nextEntry.line) return false;
    const [oldBytes, nextBytes] = await Promise.all([
      readFile(join(oldRender.directory, oldEntry.file)),
      readFile(join(newRender.directory, nextEntry.file))
    ]);
    if (!oldBytes.equals(nextBytes)) return false;
  }
  return true;
}

// api/queue.js - Radio Automática / "Up Next" (SimpMusic Engine via /next)
import { fetchYt, parseDuration, cleanThumb, getRunsText, sendJson } from './_yt.js';

export default async function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const videoId = (req.query && (req.query.id || req.query.videoId)) || urlObj.searchParams.get('id') || urlObj.searchParams.get('videoId');
  const continuation = (req.query && req.query.continuation) || urlObj.searchParams.get('continuation');

  if (!videoId && !continuation) {
    return sendJson(res, { error: 'Falta ID de la pista (videoId) o token de continuación', tracks: [] }, 400);
  }

  try {
    const body = continuation
      ? { continuation }
      : {
          playlistId: `RDAMVM${videoId}`,
          params: 'wAEB',
          isAudioOnly: true,
          tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
          enablePersistentPlaylistPanel: true
        };

    const data = await fetchYt('next', body);

    const panel = data.continuationContents?.playlistPanelContinuation ||
                  data.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer;

    const rawList = panel?.contents || [];
    const nextToken = panel?.continuations?.[0]?.nextContinuationData?.continuation || null;

    const tracks = [];
    const seen = new Set();

    for (const item of rawList) {
      const v = item.playlistPanelVideoRenderer;
      if (!v || !v.videoId) continue;
      if (seen.has(v.videoId)) continue;
      seen.add(v.videoId);

      const title = getRunsText(v.title?.runs);
      const bylineRuns = v.longBylineText?.runs || [];
      const artist = bylineRuns[0]?.text || 'Artista';
      const durText = getRunsText(v.lengthText?.runs);
      const parsedDur = parseDuration(durText);
      const thumb = cleanThumb(v.thumbnail?.thumbnails, `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`);

      tracks.push({
        id: v.videoId,
        videoId: v.videoId,
        title: title || 'Sin título',
        artist: artist,
        duration: parsedDur.durationSeconds,
        durationSeconds: parsedDur.durationSeconds,
        durationText: durText || parsedDur.durationText,
        thumbnail: thumb
      });
    }

    return sendJson(res, {
      tracks,
      continuation: nextToken
    });
  } catch (err) {
    return sendJson(res, { error: err.message, tracks: [] }, 500);
  }
}

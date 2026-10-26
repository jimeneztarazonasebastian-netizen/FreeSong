export default async function handler(req, res) {
  const videoId = 'tdS3ijuqxW4';
  const results = {};

  // 1. Test ANDROID with different versions
  const versions = ['21.26.364', '20.10.38', '19.45.4', '18.20.39'];
  for (const v of versions) {
    try {
      const resp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `com.google.android.youtube/${v} (Linux; U; Android 11) gzip`,
          'X-YouTube-Client-Name': '3',
          'X-YouTube-Client-Version': v
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: v,
              hl: 'es',
              gl: 'US'
            }
          }
        }),
        signal: AbortSignal.timeout(3000)
      });
      const data = await resp.json();
      results[`ANDROID_${v}`] = {
        status: data.playabilityStatus?.status,
        reason: data.playabilityStatus?.reason,
        hasFormats: !!(data.streamingData?.formats?.length || data.streamingData?.adaptiveFormats?.length)
      };
    } catch (e) {
      results[`ANDROID_${v}`] = { error: e.message };
    }
  }

  // 2. Test WEB_REMIX with sw.js_data visitorData
  try {
    const swRes = await fetch('https://music.youtube.com/sw.js_data');
    const swText = await swRes.text();
    const match = swText.match(/"(Cg[stuv][A-Za-z0-9_%-]{15,})"/);
    const visitorData = match ? decodeURIComponent(match[1]) : '';

    const webResp = await fetch('https://music.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://music.youtube.com',
        'Referer': 'https://music.youtube.com/',
        ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {})
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20240101.01.00',
            hl: 'es',
            gl: 'US',
            ...(visitorData ? { visitorData } : {})
          }
        }
      }),
      signal: AbortSignal.timeout(3000)
    });
    const webData = await webResp.json();
    results['WEB_REMIX'] = {
      status: webData.playabilityStatus?.status,
      reason: webData.playabilityStatus?.reason,
      hasFormats: !!(webData.streamingData?.formats?.length || webData.streamingData?.adaptiveFormats?.length)
    };
  } catch (e) {
    results['WEB_REMIX'] = { error: e.message };
  }

  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(results, null, 2));
}

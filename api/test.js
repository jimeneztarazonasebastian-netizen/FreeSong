export default async function handler(req, res) {
  const videoId = req.query.id || 'wdj9ZJbeLD4'; // Me Gusta - Shakira
  const results = {};

  let visitorData = '';
  try {
    const swRes = await fetch('https://music.youtube.com/sw.js_data', { signal: AbortSignal.timeout(2000) });
    const swText = await swRes.text();
    const match = swText.match(/"(Cg[stuv][A-Za-z0-9_%-]{15,})"/);
    if (match) visitorData = decodeURIComponent(match[1]);
  } catch (e) {
    results['visitor_error'] = e.message;
  }

  const clients = [
    {
      name: 'IOS_20_10_4',
      id: '5',
      ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
      client: {
        clientName: 'IOS',
        clientVersion: '20.10.4',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '18.3.2.22D82',
        hl: 'es',
        gl: 'US',
        ...(visitorData ? { visitorData } : {})
      }
    },
    {
      name: 'IOS_19_45_4',
      id: '5',
      ua: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)',
      client: {
        clientName: 'IOS',
        clientVersion: '19.45.4',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '18.1.0',
        hl: 'es',
        gl: 'US'
      }
    },
    {
      name: 'ANDROID_TESTSUITE',
      id: '85',
      ua: 'google-play-services/24.12.17',
      client: {
        clientName: 'ANDROID_TESTSUITE',
        clientVersion: '1.9',
        androidSdkVersion: 30,
        hl: 'es',
        gl: 'US'
      }
    },
    {
      name: 'ANDROID_21_26_364',
      id: '3',
      ua: 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip',
      client: {
        clientName: 'ANDROID',
        clientVersion: '21.26.364',
        osName: 'Android',
        osVersion: '11',
        hl: 'es',
        gl: 'US',
        ...(visitorData ? { visitorData } : {})
      }
    }
  ];

  for (const c of clients) {
    try {
      const resp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': c.ua,
          'X-YouTube-Client-Name': c.id,
          'X-YouTube-Client-Version': c.client.clientVersion,
          ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {})
        },
        body: JSON.stringify({
          videoId,
          context: { client: c.client },
          contentCheckOk: true,
          racyCheckOk: true
        }),
        signal: AbortSignal.timeout(3500)
      });
      const data = await resp.json();
      const allFormats = (data.streamingData?.formats || []).concat(data.streamingData?.adaptiveFormats || []);
      const withUrl = allFormats.filter(f => f.url);
      results[c.name] = {
        httpStatus: resp.status,
        playabilityStatus: data.playabilityStatus?.status,
        reason: data.playabilityStatus?.reason,
        formatsCount: allFormats.length,
        withDirectUrl: withUrl.length,
        sampleItags: withUrl.slice(0, 5).map(f => f.itag)
      };
    } catch (e) {
      results[c.name] = { error: e.message };
    }
  }

  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(results, null, 2));
}

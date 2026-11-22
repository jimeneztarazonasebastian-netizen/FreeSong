// Puente de control. La clave de Render nunca sale al navegador.
const origin = 'https://freesong-mixer.onrender.com';
const allowed = new Set(['https://freesong-pied.vercel.app']);
const recent = new Map();
const reply = (res, code, body) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json(body);
};
export async function mixerControl(req, res, url) {
  const key = process.env.MIXER_API_KEY;
  const id = url.searchParams.get('session');
  if (req.method === 'GET' && !id) return reply(res, 200, {
    configured: !!key, experimental: true, ...(key ? { wakeUrl: `${origin}/health` } : {})
  });
  if (!key) return reply(res, 503, { error: 'Falta configurar MIXER_API_KEY en Vercel.' });
  if (id && !/^[a-f0-9]{48}$/.test(id)) return reply(res, 400, { error: 'Sesión inválida' });
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method) || (req.method !== 'POST' && !id)) return reply(res, 405, { error: 'Método no admitido' });
  if (req.method !== 'GET') {
    if (!allowed.has(req.headers.origin)) return reply(res, 403, { error: 'Origen no permitido' });
  }
  let body;
  if (req.method === 'POST') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0];
    if (Date.now() - (recent.get(ip) || 0) < 15_000) return reply(res, 429, { error: 'Espera unos segundos antes de crear otra mezcla.' });
    if (recent.size > 500) recent.clear();
    recent.set(ip, Date.now());
  }
  if (req.method === 'POST' || req.method === 'PATCH') {
    let raw = req.body;
    if (raw == null) {
      raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 8192) return reply(res, 413, { error: 'Solicitud demasiado grande' });
      }
    }
    try { body = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return reply(res, 400, { error: 'JSON inválido' }); }
    if (!body || JSON.stringify(body).length > 8192) return reply(res, 400, { error: 'Solicitud inválida' });
  }
  try {
    const upstream = await fetch(`${origin}/sessions${id ? '/' + id : ''}`, {
      method: req.method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000)
    });
    const data = await upstream.json();
    if (!upstream.ok) return reply(res, upstream.status === 401 ? 502 : upstream.status,
      { error: upstream.status === 401 ? 'La clave de Vercel no coincide con Render.' : (data.error || 'El mezclador no está disponible.') });
    if (req.method === 'POST') {
      if (!/^[a-f0-9]{48}$/.test(data.id)) throw new Error('Respuesta inválida');
      return reply(res, 202, { id: data.id, playlist: `${origin}/sessions/${data.id}/index.m3u8`,
        expiresIn: data.expiresIn, editable: data.editable === true });
    }
    if (req.method === 'PATCH') return reply(res, 202, { edit: data.edit });
    const trackDurations = Array.isArray(data.trackDurations)
      ? data.trackDurations.slice(0, 4).map(seconds =>
        Number.isFinite(seconds) && seconds > 0 && seconds <= 600 ? seconds : null)
      : undefined;
    const relayIssues = Array.isArray(data.relayIssues)
      ? data.relayIssues.slice(0, 4).map(issue => typeof issue === 'string' && /^(metadata|media)_(\d{3}|format|no_aac|empty|redirect|timeout|unavailable)$/.test(issue) ? issue : null)
      : undefined;
    return reply(res, 200, { status: data.status, ok: data.ok,
      sources: data.sources, failure: data.failure, upstreamStatus: data.upstreamStatus,
      exitCode: data.exitCode, exitSignal: data.exitSignal, revision: data.revision, edit: data.edit, trackDurations, relayIssues });
  } catch { return reply(res, 502, { error: 'Render no respondió a tiempo; puede estar arrancando. Reintenta en un minuto.' }); }
}

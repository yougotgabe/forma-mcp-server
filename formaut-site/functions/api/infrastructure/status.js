// functions/api/infrastructure/status.js
// Auth-gated proxy to the platform Worker /infrastructure/health endpoint.
// Returns only health metadata (pass/warn/fail, project status, schema version).
// Never returns site content, memory, conversation data, or client DB rows.

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return cors(204);
  if (request.method !== 'POST')   return json({ error: 'Method not allowed' }, 405);

  const googleToken = (request.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!googleToken) return json({ error: 'Unauthorized' }, 401);

  let verifiedEmail;
  try {
    const tr = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${googleToken}`);
    if (!tr.ok) throw new Error('invalid');
    const td = await tr.json();
    if (td.aud !== env.GOOGLE_CLIENT_ID) throw new Error('aud');
    verifiedEmail = td.email;
  } catch { return json({ error: 'Authentication failed' }, 401); }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }
  const slug = body.client_id || body.slug;
  if (!slug) return json({ error: 'client_id required' }, 400);

  // Verify ownership — client must list this email as an admin
  const cr = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id,admin_emails&limit=1`,
    { headers: { apikey: env.PLATFORM_SUPABASE_SERVICE_KEY } }
  );
  const clients = cr.ok ? await cr.json() : [];
  if (!clients.length)                                    return json({ error: 'Not found' }, 404);
  if (!(clients[0].admin_emails || []).includes(verifiedEmail)) return json({ error: 'Forbidden' }, 403);

  // Proxy to Worker — worker returns infra metadata only
  try {
    const wr = await fetch(`${env.PLATFORM_WORKER_URL}/infrastructure/health`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': env.WORKER_SECRET },
      body:    JSON.stringify({ slug, persist: false }),
    });
    return json(await wr.json(), wr.status);
  } catch {
    return json({ ok: false, error: 'Infrastructure service unavailable' }, 502);
  }
}

function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
function cors(s = 204) {
  return new Response(null, {
    status: s,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

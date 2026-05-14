// functions/api/mcp/scopes.js
// Saves default scope config for a client.
// These defaults pre-populate the new-agent form.
// Runtime tier uses this — other tiers can also call it if they customise scopes.

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

  const slug   = body.client_id || body.slug;
  const scopes = body.scopes;
  if (!slug)   return json({ error: 'client_id required' }, 400);
  if (!scopes) return json({ error: 'scopes required' }, 400);

  // Verify ownership
  const cr = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id,admin_emails&limit=1`,
    { headers: { apikey: env.PLATFORM_SUPABASE_SERVICE_KEY } }
  );
  const clients = cr.ok ? await cr.json() : [];
  if (!clients.length)                                          return json({ error: 'Not found' }, 404);
  if (!(clients[0].admin_emails || []).includes(verifiedEmail)) return json({ error: 'Forbidden' }, 403);
  const clientId = clients[0].id;

  // Upsert scope config
  const ur = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/mcp_scope_configs`,
    {
      method:  'POST',
      headers: {
        apikey:         env.PLATFORM_SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer:         'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ client_id: clientId, client_slug: slug, scopes }),
    }
  );

  if (!ur.ok) return json({ error: 'Failed to save scopes' }, 500);
  return json({ ok: true });
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

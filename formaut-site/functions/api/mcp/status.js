// functions/api/mcp/status.js
// Returns MCP server URL, authorized agent list (token hints only — never full tokens),
// and available scope config for this client.
// All tiers can call this. Runtime tier gets the raw server URL.

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

  // Verify ownership
  const cr = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id,admin_emails,tier&limit=1`,
    { headers: { apikey: env.PLATFORM_SUPABASE_SERVICE_KEY } }
  );
  const clients = cr.ok ? await cr.json() : [];
  if (!clients.length)                                    return json({ error: 'Not found' }, 404);
  const client = clients[0];
  if (!(client.admin_emails || []).includes(verifiedEmail)) return json({ error: 'Forbidden' }, 403);

  // MCP server URL — the MCP Worker URL scoped to this client slug
  const mcpServerUrl = env.MCP_SERVER_URL
    ? `${env.MCP_SERVER_URL.replace(/\/$/, '')}/${slug}/mcp`
    : `https://forma-mcp-server.dreadpiratestudio.workers.dev/${slug}/mcp`;

  // Agent list — select token_hint only, never token_enc or raw token
  const ar = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/mcp_agents?client_id=eq.${encodeURIComponent(client.id)}&select=id,name,note,token_hint,scopes,active,revoked,last_seen_at&order=created_at.desc`,
    { headers: { apikey: env.PLATFORM_SUPABASE_SERVICE_KEY } }
  );
  const agents = ar.ok ? await ar.json() : [];

  // Scope config (optional — falls back to client-side defaults if absent)
  const sr = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/mcp_scope_configs?client_id=eq.${encodeURIComponent(client.id)}&select=scopes&limit=1`,
    { headers: { apikey: env.PLATFORM_SUPABASE_SERVICE_KEY } }
  ).catch(() => null);
  const scopeRow     = sr?.ok ? (await sr.json())[0] : null;
  const availScopes  = scopeRow?.scopes || null;

  return json({ ok: true, mcp_server_url: mcpServerUrl, agents, available_scopes: availScopes });
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

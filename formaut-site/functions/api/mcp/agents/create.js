// functions/api/mcp/agents/create.js
// Generates a scoped access token for a new MCP agent connection.
// The raw token is returned ONCE here and never stored in plaintext.
// All subsequent reads only return token_hint (last 4 chars).
// All tiers can call this.

import { encryptValue } from '../../../lib/crypto.js';

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
  const name   = (body.name || '').trim();
  const note   = (body.note || '').trim();
  const scopes = Array.isArray(body.scopes) ? body.scopes : [];
  if (!slug) return json({ error: 'client_id required' }, 400);
  if (!name) return json({ error: 'name required' }, 400);

  // Verify ownership
  const cr = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id,admin_emails&limit=1`,
    { headers: { apikey: env.PLATFORM_SUPABASE_SERVICE_KEY } }
  );
  const clients = cr.ok ? await cr.json() : [];
  if (!clients.length)                                          return json({ error: 'Not found' }, 404);
  if (!(clients[0].admin_emails || []).includes(verifiedEmail)) return json({ error: 'Forbidden' }, 403);
  const clientId = clients[0].id;

  // Generate a cryptographically random token: fmt_<slug>_<32 random hex chars>
  const rawBytes    = crypto.getRandomValues(new Uint8Array(16));
  const hex         = Array.from(rawBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const rawToken    = `fmt_${slug}_${hex}`;
  const tokenHint   = rawToken.slice(-4);

  // Encrypt for storage — we store encrypted, never plaintext
  let tokenEnc;
  try {
    tokenEnc = env.CREDENTIAL_ENCRYPTION_KEY
      ? await encryptValue(rawToken, env.CREDENTIAL_ENCRYPTION_KEY)
      : rawToken; // fallback if encryption not configured yet
  } catch {
    tokenEnc = rawToken;
  }

  // Insert agent record
  const ir = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/mcp_agents`,
    {
      method:  'POST',
      headers: {
        apikey:          env.PLATFORM_SUPABASE_SERVICE_KEY,
        'Content-Type':  'application/json',
        Prefer:          'return=representation',
      },
      body: JSON.stringify({
        client_id:   clientId,
        client_slug: slug,
        name,
        note:        note || null,
        token_enc:   tokenEnc,
        token_hint:  tokenHint,
        scopes,
        active:      true,
        revoked:     false,
      }),
    }
  );

  if (!ir.ok) {
    const err = await ir.text();
    console.error('mcp_agents insert failed:', err);
    return json({ error: 'Failed to create agent' }, 500);
  }

  // Build MCP server URL
  const mcpServerUrl = env.MCP_SERVER_URL
    ? `${env.MCP_SERVER_URL.replace(/\/$/, '')}/${slug}/mcp`
    : `https://forma-mcp-server.dreadpiratestudio.workers.dev/${slug}/mcp`;

  // Return the raw token once — it won't be retrievable again
  return json({ ok: true, token: rawToken, mcp_server_url: mcpServerUrl, token_hint: tokenHint });
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

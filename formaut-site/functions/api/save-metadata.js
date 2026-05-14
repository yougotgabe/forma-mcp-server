// functions/api/save-metadata.js
// Cloudflare Pages Function
//
// Stores non-secret service identifiers as plain text directly in the
// clients table. Examples: GitHub username, Cloudflare account_id,
// Supabase org_id.
//
// These are not secrets — they're identifiers needed for UX, status display,
// and provisioning routing. Plain text storage is correct for these values.
//
// NEVER call this with API keys, tokens, or passwords.
// Those go to /api/save-credential only.

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return cors(204);
  if (request.method !== 'POST')   return json({ error: 'Method not allowed' }, 405);

  // ── Verify Google token ────────────────────────────────────────────────────
  const authHeader  = request.headers.get('Authorization') || '';
  const googleToken = authHeader.replace('Bearer ', '').trim();
  if (!googleToken) return json({ error: 'Unauthorized' }, 401);

  let verifiedEmail;
  try {
    const tokenRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${googleToken}`
    );
    if (!tokenRes.ok) throw new Error('invalid');
    const td = await tokenRes.json();
    if (td.aud !== env.GOOGLE_CLIENT_ID) throw new Error('audience');
    if (Date.now() / 1000 > parseInt(td.exp, 10)) throw new Error('expired');
    verifiedEmail = td.email;
  } catch {
    return json({ error: 'Authentication failed' }, 401);
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  // updates: flat object of { column: value } pairs to write to clients table
  // client_id: the client slug
  const { client_id, updates } = body;

  if (!client_id || !updates || typeof updates !== 'object') {
    return json({ error: 'client_id and updates object are required' }, 400);
  }

  // Whitelist of columns that are safe to update as plain text
  // Deliberately excludes any _enc column — those go through save-credential
  const ALLOWED_COLUMNS = new Set([
    'github_username',
    'cloudflare_account_id',
    'supabase_org_id',
    'display_name',
    'domain',
    'printify_shop_id',
    'stripe_connected_account',
  ]);

  const safeUpdates = {};
  for (const [col, val] of Object.entries(updates)) {
    if (!ALLOWED_COLUMNS.has(col)) {
      return json({ error: `Column '${col}' cannot be set via this endpoint` }, 400);
    }
    if (typeof val !== 'string' || val.length > 500) {
      return json({ error: `Invalid value for '${col}'` }, 400);
    }
    // Heuristic guard — reject anything that looks like a token
    const tokenPatterns = [/^ghp_/, /^gho_/, /^github_pat_/, /^sk_/, /^whsec_/, /^sbp_/];
    if (tokenPatterns.some(p => p.test(val))) {
      return json({
        error: `Value for '${col}' looks like a secret token. Use /api/save-credential for secrets.`,
      }, 400);
    }
    safeUpdates[col] = val;
  }

  if (!Object.keys(safeUpdates).length) {
    return json({ error: 'No valid columns to update' }, 400);
  }

  // ── Verify client + authorization ──────────────────────────────────────────
  const clientRes = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?slug=eq.${encodeURIComponent(client_id)}&select=id,admin_emails&limit=1`,
    {
      headers: {
        'apikey':        env.PLATFORM_SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.PLATFORM_SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  if (!clientRes.ok) return json({ error: 'Could not verify client' }, 502);
  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);

  const clientRecord = clients[0];
  if (!(clientRecord.admin_emails || []).includes(verifiedEmail)) {
    return json({ error: 'Forbidden' }, 403);
  }

  // ── Write to clients table ─────────────────────────────────────────────────
  const updateRes = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?id=eq.${clientRecord.id}`,
    {
      method: 'PATCH',
      headers: {
        'apikey':        env.PLATFORM_SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.PLATFORM_SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify(safeUpdates),
    }
  );

  if (!updateRes.ok) {
    const err = await updateRes.text();
    console.error('[save-metadata] db write failed:', err);
    return json({ error: 'Failed to save — please try again' }, 502);
  }

  return json({ success: true, updated: Object.keys(safeUpdates) });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function cors(status = 204) {
  return new Response(null, {
    status,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

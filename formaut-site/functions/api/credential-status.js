// functions/api/credential-status.js
// Cloudflare Pages Function
//
// Returns the credential status for the authenticated client:
// - Which key slots are connected
// - Hint (last 4 chars, masked) for each connected key
// - When each key was last updated
// - Last 10 audit events (who did what, when)
//
// Never returns ciphertext or plaintext values.
// Auth: Google token → email → admin_emails check (same as all other Pages Functions)

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

  const { client_id } = body;
  if (!client_id) return json({ error: 'client_id required' }, 400);

  // ── Confirm this email is authorized for this client ───────────────────────
  const clientRes = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?slug=eq.${encodeURIComponent(client_id)}&select=id,admin_emails&limit=1`,
    { headers: { 'apikey': env.PLATFORM_SUPABASE_SERVICE_KEY } }
  );
  if (!clientRes.ok) return json({ error: 'Could not verify client' }, 502);
  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);

  const clientRecord = clients[0];
  if (!(clientRecord.admin_emails || []).includes(verifiedEmail)) {
    return json({ error: 'Forbidden' }, 403);
  }

  // ── Delegate to platform Worker /credential-status ─────────────────────────
  // Worker holds the full status query — Pages Function just handles auth.
  let result;
  try {
    const workerRes = await fetch(`${env.PLATFORM_WORKER_URL}/credential-status`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-worker-secret': env.WORKER_SECRET,
      },
      body: JSON.stringify({ slug: client_id }),
    });
    result = await workerRes.json();
    if (!workerRes.ok) {
      return json({ error: result.error || 'Could not load credential status' }, 502);
    }
  } catch (err) {
    return json({ error: 'Could not reach platform service' }, 502);
  }

  return json(result);
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

// functions/api/provision.js
// Cloudflare Pages Function
//
// Called by onboarding.html after all 3 credentials are saved.
// Verifies the Google session, confirms client ownership, then
// calls the platform Worker /provision endpoint server-to-server.
//
// The Worker handles all actual provisioning logic:
//   1. Create GitHub repo
//   2. Create Cloudflare Pages project
//   3. Create Supabase project + run schema
//   4. Encrypt + store Supabase keys
//   5. Update onboarding_state table
//
// This function only handles auth and proxying — provisioning
// logic stays in the Worker where the secrets live.
//
// Body: { client_id: "client-slug" }
// Returns: { ok: true, slug, steps: [...] }
//       or { ok: false, failed_at: "step_name", steps: [...] }

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
    if (!tokenRes.ok) throw new Error('invalid_token');
    const td = await tokenRes.json();
    if (td.aud !== env.GOOGLE_CLIENT_ID) throw new Error('audience_mismatch');
    if (Date.now() / 1000 > parseInt(td.exp, 10)) throw new Error('token_expired');
    verifiedEmail = td.email;
  } catch {
    return json({ error: 'Authentication failed' }, 401);
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const slug = body.client_id || body.slug;
  if (!slug) return json({ error: 'client_id is required' }, 400);

  // ── Verify ownership ───────────────────────────────────────────────────────
  const clientRes = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id,slug,admin_emails,status&limit=1`,
    { headers: { apikey: env.PLATFORM_SUPABASE_SERVICE_KEY } }
  );

  if (!clientRes.ok) return json({ error: 'Could not verify client' }, 502);
  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);

  const client = clients[0];
  if (!(client.admin_emails || []).includes(verifiedEmail)) {
    return json({ error: 'Forbidden' }, 403);
  }

  // ── Forward to platform Worker ─────────────────────────────────────────────
  // Provisioning is long-running (~30-90s for Supabase init).
  // The Worker handles all steps synchronously and returns the full step log.
  // Cloudflare Pages Functions have a 30s CPU limit but can wait on I/O
  // indefinitely — the Supabase waitForReady loop relies on this.
  try {
    const workerRes = await fetch(`${env.PLATFORM_WORKER_URL}/provision`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-worker-secret': env.WORKER_SECRET,
      },
      body: JSON.stringify({ slug: client.slug }),
    });

    const data = await workerRes.json().catch(() => ({
      ok: false,
      error: 'Worker returned invalid response',
    }));

    return json(data, workerRes.status);
  } catch (err) {
    console.error('[provision] worker unreachable:', err.message);
    return json({
      ok:    false,
      error: 'Could not reach provisioning service',
      steps: [],
    }, 502);
  }
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

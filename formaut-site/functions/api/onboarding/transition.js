// functions/api/onboarding/transition.js
// Cloudflare Pages Function
//
// Called by onboarding.html at each phase transition to drive the
// platform worker's onboarding state machine.
//
// The state machine tracks where a client is in their setup journey.
// This endpoint is best-effort — the UI doesn't block on it succeeding.
//
// Body: { client_id: "slug", next_state: "provisioned" | "crawl_running" | ... }

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return cors(204);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader  = request.headers.get('Authorization') || '';
  const googleToken = authHeader.replace('Bearer ', '').trim();
  if (!googleToken) return json({ error: 'Unauthorized' }, 401);

  let verifiedEmail;
  try {
    const tokenRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${googleToken}`);
    if (!tokenRes.ok) throw new Error('invalid');
    const td = await tokenRes.json();
    if (td.aud !== env.GOOGLE_CLIENT_ID) throw new Error('audience');
    verifiedEmail = td.email;
  } catch {
    return json({ error: 'Authentication failed' }, 401);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { client_id, next_state } = body;
  if (!client_id || !next_state) return json({ error: 'client_id and next_state are required' }, 400);

  // Verify client ownership
  const clientRes = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?slug=eq.${encodeURIComponent(client_id)}&select=id,slug,admin_emails&limit=1`,
    { headers: { apikey: env.PLATFORM_SUPABASE_SERVICE_KEY } }
  );
  if (!clientRes.ok) return json({ error: 'Could not verify client' }, 502);
  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);
  const client = clients[0];
  if (!(client.admin_emails || []).includes(verifiedEmail)) return json({ error: 'Forbidden' }, 403);

  // Get current state then transition
  try {
    // Get current state
    const stateRes = await fetch(`${env.PLATFORM_WORKER_URL}/onboarding/state/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': env.WORKER_SECRET },
      body: JSON.stringify({ client_id: client.id }),
    });
    const stateData = stateRes.ok ? await stateRes.json() : {};
    const currentState = stateData.onboarding?.current_state || 'awaiting_supabase';

    // Transition
    const transRes = await fetch(`${env.PLATFORM_WORKER_URL}/onboarding/state/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': env.WORKER_SECRET },
      body: JSON.stringify({
        client_id: client.id,
        current_state: currentState,
        next_state,
        metadata: { actor: verifiedEmail, source: 'onboarding_ui' },
      }),
    });
    const transData = transRes.ok ? await transRes.json() : {};
    return json({ ok: true, ...transData });
  } catch (err) {
    // Non-fatal — onboarding UI continues regardless
    console.error('[onboarding/transition]', err.message);
    return json({ ok: false, error: err.message });
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
function cors(status = 204) {
  return new Response(null, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

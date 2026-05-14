// functions/api/jobs/_shared.js
// Shared Cloudflare Pages Function proxy for browser-facing Formaut job routes.
//
// Browser calls explicit Pages Function endpoints like /api/jobs/list.
// The Pages Function verifies the signed-in Google user, confirms they are an
// admin for the client slug, then forwards the request server-to-server to the
// platform Worker with WORKER_SECRET.

export async function proxyJob(context, workerPath) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return cors(204);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = request.headers.get('Authorization') || '';
  const googleToken = authHeader.replace('Bearer ', '').trim();
  if (!googleToken) return json({ error: 'Unauthorized' }, 401);

  let verifiedEmail;
  try {
    const tokenRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${googleToken}`);
    if (!tokenRes.ok) throw new Error('invalid_google_token');
    const tokenData = await tokenRes.json();
    if (tokenData.aud !== env.GOOGLE_CLIENT_ID) throw new Error('invalid_audience');
    if (Date.now() / 1000 > parseInt(tokenData.exp, 10)) throw new Error('expired_token');
    verifiedEmail = tokenData.email;
  } catch {
    return json({ error: 'Authentication failed' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const slug = body.slug || body.client_slug || body.client_id || body.clientId;
  if (!slug) return json({ error: 'client slug is required' }, 400);

  const clientRes = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id,slug,admin_emails&limit=1`,
    { headers: { apikey: env.PLATFORM_SUPABASE_SERVICE_KEY } }
  );

  if (!clientRes.ok) return json({ error: 'Could not verify client' }, 502);

  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);

  const clientRecord = clients[0];
  if (!(clientRecord.admin_emails || []).includes(verifiedEmail)) {
    return json({ error: 'Forbidden' }, 403);
  }

  try {
    const workerRes = await fetch(`${env.PLATFORM_WORKER_URL}${workerPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': env.WORKER_SECRET,
      },
      body: JSON.stringify({ ...body, slug: clientRecord.slug, client_id: clientRecord.id }),
    });

    const data = await workerRes.json().catch(() => ({}));
    return json(data, workerRes.status);
  } catch {
    return json({ error: 'Could not reach job service' }, 502);
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export function cors(status = 204) {
  return new Response(null, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

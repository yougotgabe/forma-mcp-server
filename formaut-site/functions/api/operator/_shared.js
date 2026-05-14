// Operator-only Cloudflare Pages Function proxy.
// Verifies the signed-in Google account against OPERATOR_EMAIL, then forwards
// the request to the platform Worker using WORKER_SECRET. This keeps operator
// dashboard panels deterministic and prevents them from relying on /api/chat.

export async function proxyOperator(context, workerPath) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return cors(request.method === 'GET' ? 'GET, POST, OPTIONS' : 'POST, OPTIONS');
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);

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

  if (!env.OPERATOR_EMAIL || verifiedEmail !== env.OPERATOR_EMAIL) {
    return json({ error: 'Forbidden' }, 403);
  }

  let body = {};
  if (request.method === 'POST') {
    try { body = await request.json(); }
    catch { return json({ error: 'Invalid JSON' }, 400); }
  }

  try {
    const workerRes = await fetch(`${env.PLATFORM_WORKER_URL}${workerPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': env.WORKER_SECRET,
      },
      body: JSON.stringify({ ...body, operator_email: verifiedEmail }),
    });
    const data = await workerRes.json().catch(() => ({}));
    return json(data, workerRes.status);
  } catch {
    return json({ error: 'Could not reach operator service' }, 502);
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

export function cors(methods = 'GET, POST, OPTIONS') {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

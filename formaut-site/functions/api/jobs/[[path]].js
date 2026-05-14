// functions/api/jobs/[[path]].js
// Cloudflare Pages Function proxy for dashboard job endpoints.
// Browser calls /api/jobs/*, platform Worker owns /jobs/*.

export async function onRequest(context) {
  return proxyToPlatformWorker(context, 'jobs');
}

async function proxyToPlatformWorker(context, baseSegment) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') return cors(204);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const workerBase = (env.PLATFORM_WORKER_URL || '').replace(/\/+$/, '');
  if (!workerBase) return json({ error: 'PLATFORM_WORKER_URL is not configured for this Pages project.' }, 500);

  const pathParts = Array.isArray(params.path)
    ? params.path
    : String(params.path || '').split('/').filter(Boolean);
  const workerPath = `/${baseSegment}/${pathParts.map(encodeURIComponent).join('/')}`;

  let bodyText = '';
  try { bodyText = await request.text(); }
  catch { return json({ error: 'Could not read request body' }, 400); }

  const headers = { 'Content-Type': request.headers.get('Content-Type') || 'application/json' };
  const auth = request.headers.get('Authorization');
  if (auth) headers.Authorization = auth;
  if (env.WORKER_SECRET) headers['x-worker-secret'] = env.WORKER_SECRET;

  let upstream;
  try {
    upstream = await fetch(`${workerBase}${workerPath}`, { method: 'POST', headers, body: bodyText });
  } catch (err) {
    return json({ error: 'Could not reach platform Worker', detail: err.message }, 502);
  }

  const responseText = await upstream.text();
  return new Response(responseText || '{}', {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
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

import { proxyJob, cors, json } from '../../jobs/_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return cors();
  const url = new URL(context.request.url);
  const action = url.pathname.split('/').filter(Boolean).pop();
  const allowed = ['create', 'list', 'revoke', 'rotate', 'audit', 'verify'];
  if (allowed.includes(action)) return proxyJob(context, `/client-api/tokens/${action}`);
  if (action === 'openapi') return proxyJob(context, '/client-api/openapi');
  return json({ error: 'unknown action' }, 404);
}

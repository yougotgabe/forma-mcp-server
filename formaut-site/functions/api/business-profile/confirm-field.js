import { proxyJob, cors } from '../jobs/_shared.js';
export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return cors();
  return proxyJob(context, '/business-profile/confirm-field');
}

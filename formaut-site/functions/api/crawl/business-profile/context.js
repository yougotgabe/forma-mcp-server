import { proxyJob, json, cors } from '../jobs/_shared.js';

// POST /api/business-profile/context
// Returns the current business profile for the authenticated client.
export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return cors();
  return proxyJob(context, '/business-profile/context');
}

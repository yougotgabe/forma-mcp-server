import { proxyJob, json, cors } from '../jobs/_shared.js';

// POST /api/business-profile/confirm-field
// Promotes a reviewed field value into the durable business profile.
// Body: { slug, field_path, confirmed_value, reason? }
export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return cors();
  return proxyJob(context, '/business-profile/confirm-field');
}

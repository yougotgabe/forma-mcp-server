import { proxyJob, json, cors } from '../jobs/_shared.js';

// POST /api/crawl/run
// Triggers the existing website crawl adapter for the authenticated client.
// Body: { slug, url, persist_crawl? }
export async function onRequest(context) {
  // Allow GET-style preflight
  if (context.request.method === 'OPTIONS') return cors();
  return proxyJob(context, '/chat/crawl-url');
}

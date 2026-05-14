import { proxyIntegration } from '../_shared.js';

export async function onRequest(context) {
  return proxyIntegration(context, '/integrations/printify/shops');
}

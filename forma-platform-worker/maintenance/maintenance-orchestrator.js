import { checkSiteReachability, checkBrokenLinksPlaceholder } from './site-health-checks.js';
import { checkSeoBasics } from './seo-health.js';
import { checkSslHealth } from './ssl-health.js';
import { checkIntegrationHealth } from './integration-health.js';

export const DEFAULT_MAINTENANCE_CHECKS = [checkSslHealth, checkSeoBasics, checkSiteReachability, checkBrokenLinksPlaceholder, checkIntegrationHealth];

export async function runMaintenanceChecks({ client, checks = DEFAULT_MAINTENANCE_CHECKS }) {
  const results = [];
  for (const check of checks) results.push(await check(client));
  return { client_id: client.id, generated_at: new Date().toISOString(), results };
}

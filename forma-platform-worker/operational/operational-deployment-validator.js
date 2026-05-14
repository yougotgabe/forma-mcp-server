import { runSyntheticTests } from './operational-synthetic-tests.js';
import { validateSeoHealth } from './operational-seo-validator.js';
import { validateRoutes } from './operational-route-validator.js';
import { validateIntegrations } from './operational-integration-validator.js';

export async function validateDeployment(env, deployment, deps = {}) {
  const synthetic = await runSyntheticTests(deployment);
  const seo = await validateSeoHealth(deployment);
  const routes = await validateRoutes(deployment);
  const integrations = await validateIntegrations(deployment);

  const healthy = [synthetic, seo, routes, integrations].every((result) => result.ok);
  const result = {
    healthy,
    rollback_candidate: !healthy,
    validated_at: new Date().toISOString(),
    deployment: {
      client_slug: deployment.client_slug || null,
      live_url: deployment.live_url || deployment.url || deployment.preview_url || null,
      deployment_id: deployment.deployment_id || deployment.id || null,
    },
    results: { synthetic, seo, routes, integrations },
  };

  if (deps.supabase && deployment.client_slug) {
    await deps.supabase(env, 'POST', '/rest/v1/deployment_health_checks', {
      client_slug: deployment.client_slug,
      deployment_id: deployment.deployment_id || deployment.id || null,
      synthetic_ok: synthetic.ok,
      seo_ok: seo.ok,
      routes_ok: routes.ok,
      integrations_ok: integrations.ok,
      details: result.results,
    });
  }

  return result;
}

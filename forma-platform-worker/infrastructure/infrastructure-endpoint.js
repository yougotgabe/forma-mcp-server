// =============================================================================
// Infrastructure Endpoint Handlers
// =============================================================================

import { getSupabaseCapacityStatus } from './infrastructure-capacity.js';
import { provisionClientInfrastructure } from './infrastructure-provisioner.js';
import { getInfrastructureSummary } from './infrastructure-registry.js';
import { getClientInfrastructureHealth } from './infrastructure-health.js';
import { repairClientInfrastructure } from './infrastructure-repair.js';

export async function handleSupabaseCapacityStatus(body, env) {
  return getSupabaseCapacityStatus(env, body || {});
}

export async function handleProvisionClientInfrastructure(body, env) {
  return provisionClientInfrastructure(env, body || {});
}

export async function handleGetClientInfrastructure(body, env) {
  const slug = body?.slug || body?.client_slug;
  if (!slug) return { ok: false, error: 'slug required' };
  return getInfrastructureSummary(env, slug);
}

export async function handleClientInfrastructureHealth(body, env) {
  return getClientInfrastructureHealth(env, body || {});
}

export async function handleRepairClientInfrastructure(body, env) {
  return repairClientInfrastructure(env, body || {});
}

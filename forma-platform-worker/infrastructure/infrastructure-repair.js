// =============================================================================
// Infrastructure Repair Planner
// Returns deterministic repair actions; dangerous changes remain review-gated.
// =============================================================================

import { getClientInfrastructureHealth } from './infrastructure-health.js';
import { provisionClientInfrastructure } from './infrastructure-provisioner.js';

export async function repairClientInfrastructure(env, input = {}) {
  const health = await getClientInfrastructureHealth(env, input);
  if (!health.ok) return health;
  const repairs = health.checks.filter(c => c.repair_available && c.status !== 'pass');

  if (input.apply !== true) {
    return {
      ok: true,
      applied: false,
      health_status: health.health_status,
      repair_plan: repairs.map(c => ({
        check_name: c.check_name,
        project_role: c.project_role,
        action: c.check_name.includes('project_registered') ? 'run_provision_client_infrastructure' : 'run_schema_migration',
        risk_level: c.check_name.includes('project_registered') ? 'medium' : 'low',
      })),
    };
  }

  const provision = await provisionClientInfrastructure(env, input);
  const after = await getClientInfrastructureHealth(env, { ...input, persist: true });
  return { ok: true, applied: true, provision, after };
}

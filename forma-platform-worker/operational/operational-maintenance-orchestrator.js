import { collectOperationalHealth } from './operational-health-collector.js';
import { emitOperationalEvents } from './operational-event-bus.js';
import { generateRemediationPlans } from './operational-remediation-planner.js';
import { enqueueOperationalJob } from '../jobs/enqueue-operational-job.js';

export async function runOperationalMaintenanceLoop(env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const clients = await fetchActiveClients(env, { supabase });
  const summary = { ok: true, clients_checked: clients.length, events: 0, queued: 0, review_required: 0, dangerous: 0, errors: [] };

  for (const client of clients) {
    try {
      const collected = await collectOperationalHealth(env, client, { supabase });
      const events = await emitOperationalEvents(env, collected, { supabase });
      summary.events += events.length;

      const plans = await generateRemediationPlans(env, client, events, { supabase });

      for (const plan of plans) {
        if (plan.risk_level === 'safe') {
          const jobResult = await enqueueOperationalJob(env, client, plan, deps);
          await markPlanQueued(env, plan, jobResult?.job, { supabase });
          summary.queued += 1;
        } else if (plan.risk_level === 'review_required') {
          // generateRemediationPlans already persists the review item.
          summary.review_required += 1;
        } else {
          // Dangerous plans are persisted but never queued automatically.
          summary.dangerous += 1;
        }
      }
    } catch (error) {
      summary.errors.push({ client_slug: client.slug, message: error.message });
      console.error('operational_maintenance_client_failed', client.slug, error);
    }
  }

  return summary;
}

export async function fetchActiveClients(env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  let res = await supabase(env, 'GET', '/rest/v1/clients?select=id,slug,live_url,status&status=eq.active&order=slug.asc');
  if (res.ok) return await res.json();

  // Fallback for earlier schemas that do not have a status column yet.
  res = await supabase(env, 'GET', '/rest/v1/clients?select=id,slug,live_url&order=slug.asc');
  if (!res.ok) throw new Error(`Failed to fetch clients: ${await safeText(res)}`);
  return await res.json();
}

async function markPlanQueued(env, plan, job, deps = {}) {
  if (!plan.id || !deps.supabase) return;
  await deps.supabase(env, 'PATCH', `/rest/v1/operational_remediation_plans?id=eq.${encodeURIComponent(plan.id)}`, {
    queued_at: new Date().toISOString(),
    queued_job_id: job?.id || null,
    updated_at: new Date().toISOString(),
  });
}

function requireDep(value, name) {
  if (!value) throw new Error(`Missing operational dependency: ${name}`);
  return value;
}

async function safeText(res) {
  try { return await res.text(); } catch { return `${res.status} ${res.statusText}`; }
}

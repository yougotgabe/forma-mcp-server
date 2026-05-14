// =============================================================================
// FORMAUT — ENQUEUE OPERATIONAL JOB
// =============================================================================
// Called by operational-maintenance-orchestrator after a remediation plan
// is classified as 'safe'. Translates a remediation plan into a job queue entry.
//
// This is a thin adapter — all actual queue logic lives in formaut-job-queue.js.
// =============================================================================

import { produceJob } from '../formaut-job-queue.js';

export async function enqueueOperationalJob(env, client, plan, deps = {}) {
  if (!plan.job_type) {
    throw new Error(`Cannot enqueue operational job: plan has no job_type. event_type=${plan.event_type}`);
  }

  const job = await produceJob({
    client_id:   client.id,
    client_slug: client.slug,
    queue:       resolveQueue(plan.job_type),
    job_type:    plan.job_type,
    priority:    resolvePriority(plan.risk_level),
    max_attempts: 2, // operational jobs get fewer retries than client-initiated ones
    created_by:  `operational_remediation:${plan.event_type || 'unknown'}`,
    payload: {
      ...(plan.job_payload || {}),
      operational_plan_id: plan.id || null,
      event_type: plan.event_type || null,
      trigger:    `cron:operational_remediation`,
    },
  }, env, { supabase: deps.supabase });

  return job;
}

// Route job types to their appropriate queues
function resolveQueue(jobType) {
  const queueMap = {
    generate_homepage:    'generation',
    generate_seo:         'generation',
    regenerate_sitemap:   'generation',
    regenerate_robots:    'generation',
    restore_attribution:  'generation',
    validate_deployment:  'validation',
    crawl_website:        'crawl',
    collect_site_health:  'maintenance',
    replay_job:           'default',
  };
  return queueMap[jobType] || 'maintenance';
}

// Safe/auto-queued operational jobs get lower priority than client-initiated ones
function resolvePriority(riskLevel) {
  return riskLevel === 'safe' ? 80 : 60; // below default 100, above maintenance floor
}

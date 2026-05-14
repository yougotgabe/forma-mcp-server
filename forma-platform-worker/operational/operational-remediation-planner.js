// =============================================================================
// FORMAUT — OPERATIONAL REMEDIATION PLANNER
// =============================================================================
// Called by operational-maintenance-orchestrator after emitOperationalEvents.
// Converts open operational_events into concrete remediation plans with
// risk levels, and optionally persists them for operator/client review.
//
// Risk levels:
//   safe            → auto-queued immediately by the orchestrator
//   review_required → persisted as a plan, shown in dashboard, not auto-queued
//   dangerous       → persisted as a plan, flagged for operator review only
//
// A plan that is 'safe' must:
//   1. Be a known job type that the handler can execute deterministically
//   2. Not modify any client-visible content without prior approval
//   3. Be idempotent — running it twice should have the same end state
// =============================================================================

// ---------------------------------------------------------------------------
// MAIN EXPORT
// ---------------------------------------------------------------------------

export async function generateRemediationPlans(env, client, events, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const plans = [];

  for (const event of events) {
    try {
      event.event_type = event.event_type || event.type;
      const plan = buildPlan(client, event);
      if (!plan) continue;

      // Persist to operational_remediation_plans table
      const res = await supabase(env, 'POST', '/rest/v1/operational_remediation_plans', {
        client_id:       client.id,
        client_slug:     client.slug,
        event_id:        event.id,
        event_type:      event.event_type,
        risk_level:      plan.risk_level,
        job_type:        plan.job_type || null,
        job_payload:     plan.job_payload || {},
        description:     plan.description,
        rationale:       plan.rationale,
        status:          'pending',
      }, { Prefer: 'return=representation' });

      if (res.ok) {
        const rows = await res.json();
        plans.push({ ...plan, id: rows[0]?.id });
      } else {
        // Still push the plan even if persistence failed — orchestrator can queue it
        plans.push(plan);
        console.warn('[remediation] failed to persist plan for', event.event_type, await safeText(res));
      }
    } catch (err) {
      console.warn('[remediation] exception building plan for', event.event_type, err?.message);
    }
  }

  return plans;
}

// ---------------------------------------------------------------------------
// PLAN BUILDER
// Maps event_type → risk-classified remediation plan.
// ---------------------------------------------------------------------------

function buildPlan(client, event) {
  const payload = event.payload || {};

  switch (event.event_type || event.type) {

    // ── SEO auto-fixable ────────────────────────────────────────────────────

    case 'missing_title':
    case 'missing_meta_description':
    case 'missing_og_tags':
    case 'missing_canonical':
    case 'seo_metadata_missing':
    case 'seo_drift_detected':
    case 'sitemap_missing':
      return {
        risk_level: 'safe',
        job_type: 'generate_seo',
        job_payload: {
          trigger: `operational_remediation:${event.event_type}`,
          artifact_key: 'default',
          event_id: event.id,
          requires_review_before_publish: true, // SEO changes still need review before publish
        },
        description: `Regenerate SEO artifact to fix: ${event.event_type.replace(/_/g, ' ')}.`,
        rationale: `Event '${event.event_type}' was detected during routine health monitoring. Regenerating the SEO artifact is safe and idempotent. The new version will require review before publishing.`,
      };

    case 'stale_placeholder_artifact':
      // Only auto-remediate known generation job types
      if (!['generate_homepage', 'generate_seo', 'regenerate_sitemap', 'regenerate_robots'].includes(payload.remediation_job)) {
        return null;
      }
      return {
        risk_level: 'safe',
        job_type: payload.remediation_job,
        job_payload: {
          trigger: 'operational_remediation:stale_placeholder',
          artifact_type: payload.artifact_type,
          artifact_key: payload.artifact_key || 'default',
          event_id: event.id,
          requires_review_before_publish: true,
        },
        description: `Generate ${payload.artifact_type} artifact — currently a placeholder for ${payload.age_days} day(s).`,
        rationale: 'Placeholder artifacts block the site from having real content. Generating a staged version is safe — it requires review before any publish.',
      };

    case 'missing_attribution':
      return {
        risk_level: 'safe',
        job_type: 'restore_attribution',
        job_payload: {
          trigger: 'operational_remediation:missing_attribution',
          event_id: event.id,
          requires_review_before_publish: true,
        },
        description: 'Restore "Built with Formaut" attribution in site footer.',
        rationale: 'Attribution is a contractual requirement. Restoring it is a minor, deterministic footer change that requires review before publish.',
      };

    // ── Warn — not safe to auto-remediate ──────────────────────────────────

    case 'homepage_unreachable':
    case 'bad_status_code':
    case 'route_validation_failed':
    case 'deployment_url_missing':
      return {
        risk_level: 'review_required',
        job_type: null,
        job_payload: {},
        description: `Homepage is returning ${payload.status_code || 'an error status'}. Manual investigation required.`,
        rationale: 'A broken homepage cannot be safely auto-remediated — the root cause could be a bad deployment, DNS issue, or missing files. Operator must investigate.',
      };

    case 'broken_internal_link':
      return {
        risk_level: 'review_required',
        job_type: null,
        job_payload: {},
        description: `Internal link returning ${payload.status_code}: ${payload.url}`,
        rationale: 'Broken links require content decisions (remove, redirect, or fix) that should not be made automatically.',
      };

    case 'slow_response':
      return {
        risk_level: 'review_required',
        job_type: null,
        job_payload: {},
        description: `Homepage response time is ${payload.response_time_ms}ms — above alert threshold.`,
        rationale: 'Slow response time has many possible causes (large images, Cloudflare CDN issue, JS bundle size). Auto-remediation could make things worse.',
      };

    case 'dead_letter_job':
      return {
        risk_level: 'review_required',
        job_type: 'replay_job',
        job_payload: {
          dead_letter_id: payload.dead_letter_id,
          job_type:       payload.job_type,
          trigger:        'operational_remediation:dead_letter',
        },
        description: `Job '${payload.job_type}' was dead-lettered. Review error before replaying.`,
        rationale: 'Dead-lettered jobs failed all retry attempts. Replaying without understanding why risks repeated failure.',
      };

    case 'thin_content':
      return {
        risk_level: 'review_required',
        job_type: null,
        job_payload: {},
        description: `Homepage HTML is only ${payload.content_length_bytes} bytes — may not be rendering correctly.`,
        rationale: 'Thin content could indicate a build failure or JS-only render issue. Investigate the deployment before taking action.',
      };

    case 'js_only_render':
      return {
        risk_level: 'review_required',
        job_type: null,
        job_payload: {},
        description: 'Homepage requires JavaScript to render — search engines may see an empty page.',
        rationale: 'Switching from JS-only rendering to static HTML is a significant architecture change that requires planning.',
      };

    // ── Info — low priority, surface for awareness only ────────────────────

    case 'slow_response_minor':
    case 'low_profile_completeness':
    case 'stale_pending_review':
      return {
        risk_level: 'review_required', // surface in dashboard but no auto-action
        job_type: null,
        job_payload: {},
        description: payload.message || event.event_type,
        rationale: 'Informational event — no automatic action is appropriate.',
      };

    default:
      return null; // Unknown event type — no plan
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function requireDep(value, name) {
  if (!value) throw new Error(`Missing remediation-planner dependency: ${name}`);
  return value;
}

async function safeText(res) {
  try { return await res.text(); } catch { return `${res.status} ${res.statusText}`; }
}

// ---------------------------------------------------------------------------
// SCHEMA REQUIRED (run in platform Supabase)
// ---------------------------------------------------------------------------
//
// create table if not exists operational_remediation_plans (
//   id uuid primary key default gen_random_uuid(),
//   client_id uuid references clients(id) on delete cascade,
//   client_slug text not null,
//   event_id uuid references operational_events(id) on delete set null,
//   event_type text,
//   risk_level text not null,  -- 'safe' | 'review_required' | 'dangerous'
//   job_type text,
//   job_payload jsonb default '{}',
//   description text,
//   rationale text,
//   status text not null default 'pending', -- 'pending' | 'queued' | 'rejected' | 'completed'
//   queued_at timestamptz,
//   queued_job_id uuid,
//   created_at timestamptz default now(),
//   updated_at timestamptz default now()
// );
// create index if not exists remediation_plans_client_id_idx on operational_remediation_plans(client_id);
// create index if not exists remediation_plans_status_idx on operational_remediation_plans(status);

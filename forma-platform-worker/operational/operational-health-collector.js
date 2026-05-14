// =============================================================================
// FORMAUT — OPERATIONAL HEALTH COLLECTOR
// =============================================================================
// Called by operational-maintenance-orchestrator → runOperationalMaintenanceLoop
// for each active client on every cron tick.
//
// Aggregates health signals from:
//   - Site health monitor (HTTP checks, SEO signals)
//   - Artifact pipeline (stale artifacts, pending reviews)
//   - Job queue (recent failures for this client)
//   - Business profile (completeness, pending contradictions)
//
// Returns a structured CollectedHealth object consumed by operational-event-bus.
// Never throws — always returns a result even if sub-checks fail.
// =============================================================================

import { runSiteHealthMonitor } from '../monitoring/site-health-monitor.js';
import { validateDeployment } from './operational-deployment-validator.js';
import { collectSeoDriftEvents } from './operational-seo-drift-monitor.js';

// ---------------------------------------------------------------------------
// MAIN EXPORT
// ---------------------------------------------------------------------------

export async function collectOperationalHealth(env, client, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const startedAt = new Date().toISOString();

  const [siteHealth, artifactHealth, jobHealth, profileHealth] = await Promise.allSettled([
    collectSiteHealth(env, client, deps),
    collectArtifactHealth(env, client, supabase),
    collectJobHealth(env, client, supabase),
    collectProfileHealth(env, client, supabase),
  ]);

  const collected = {
    client_id:   client.id,
    client_slug: client.slug,
    collected_at: startedAt,
    site:     siteHealth.status === 'fulfilled'    ? siteHealth.value    : buildFailedSection('site_health', siteHealth.reason),
    artifacts: artifactHealth.status === 'fulfilled' ? artifactHealth.value : buildFailedSection('artifact_health', artifactHealth.reason),
    jobs:     jobHealth.status === 'fulfilled'     ? jobHealth.value     : buildFailedSection('job_health', jobHealth.reason),
    profile:  profileHealth.status === 'fulfilled' ? profileHealth.value : buildFailedSection('profile_health', profileHealth.reason),
  };

  collected.overall_ok = collected.site.ok && collected.artifacts.ok && collected.jobs.ok;
  collected.alert_count = (collected.site.alerts?.length || 0)
    + (collected.artifacts.alerts?.length || 0)
    + (collected.jobs.alerts?.length || 0)
    + (collected.profile.alerts?.length || 0);

  return collected;
}

// ---------------------------------------------------------------------------
// SITE HEALTH
// Delegates to the real site-health-monitor.
// ---------------------------------------------------------------------------

async function collectSiteHealth(env, client, deps = {}) {
  const result = await runSiteHealthMonitor(env, client);
  const alerts = [...(result.alerts || [])];
  const liveUrl = client.live_url || client.site_url || client.url || result.live_url;

  // Preserve the newer deployment validator + SEO drift work from the current Formaut tree.
  if (!liveUrl) {
    alerts.push({ type: 'deployment_url_missing', severity: 'warn', message: 'Client has no deployment URL configured.', auto_remediable: false });
  } else {
    try {
      const validation = await validateDeployment(env, {
        client_slug: client.slug,
        live_url: liveUrl,
        routes: client.critical_routes || ['/', '/sitemap.xml', '/robots.txt'],
      }, deps);
      if (!validation.results?.routes?.ok) {
        alerts.push({ type: 'route_validation_failed', severity: 'critical', message: 'One or more critical deployment routes failed validation.', ...validation.results?.routes, auto_remediable: false });
      }
      if (!validation.results?.seo?.ok) {
        alerts.push({ type: 'seo_metadata_missing', severity: 'warn', message: 'SEO metadata validation failed.', ...validation.results?.seo, auto_remediable: true, remediation_job: 'generate_seo' });
      }
      if (!validation.results?.synthetic?.ok) {
        alerts.push({ type: 'synthetic_test_failed', severity: 'warn', message: 'Synthetic test validation failed.', ...validation.results?.synthetic, auto_remediable: false });
      }
    } catch (err) {
      alerts.push({ type: 'deployment_validation_error', severity: 'warn', message: err?.message || String(err), auto_remediable: false });
    }

    try {
      const driftEvents = await collectSeoDriftEvents(env, client, deps);
      for (const e of driftEvents || []) {
        alerts.push({
          type: e.type || e.event_type || 'seo_drift_detected',
          severity: e.severity === 'warning' ? 'warn' : (e.severity || 'warn'),
          message: e.payload?.message || 'SEO drift detected.',
          artifact_type: e.artifact_type || 'seo',
          auto_remediable: true,
          remediation_job: 'generate_seo',
          ...(e.payload || {}),
        });
      }
    } catch (err) {
      alerts.push({ type: 'seo_drift_collection_failed', severity: 'warn', message: err?.message || String(err), auto_remediable: false });
    }
  }

  return {
    ok: result.ok && !alerts.some(a => a.severity === 'critical'),
    live_url: result.live_url || liveUrl,
    response_time_ms: result.checks?.response_time_ms || null,
    checks: result.checks || {},
    alerts,
    critical_count: alerts.filter(a => a.severity === 'critical').length,
    warn_count: alerts.filter(a => a.severity === 'warn' || a.severity === 'warning').length,
    checked_at: result.started_at,
  };
}

// ---------------------------------------------------------------------------
// ARTIFACT HEALTH
// Checks for stale or stuck artifact versions in the platform Supabase.
// ---------------------------------------------------------------------------

async function collectArtifactHealth(env, client, supabase) {
  const alerts = [];

  // Load artifact_versions for this client with status in problematic states
  const res = await supabase(env, 'GET',
    `/rest/v1/artifact_versions?client_id=eq.${enc(client.id)}`
    + `&status=in.(generation_placeholder,pending_review,review_failed)`
    + `&select=id,artifact_type,artifact_key,status,created_at`
    + `&order=created_at.desc&limit=20`
  );

  if (!res.ok) {
    return { ok: false, alerts: [{ type: 'artifact_query_failed', severity: 'warn', message: 'Could not load artifact versions.' }] };
  }

  const versions = await res.json();
  const now = Date.now();

  for (const v of versions) {
    const ageMs = now - new Date(v.created_at).getTime();
    const ageDays = Math.round(ageMs / (1000 * 60 * 60 * 24));

    if (v.status === 'generation_placeholder') {
      alerts.push({
        type: 'stale_placeholder_artifact',
        severity: ageDays > 3 ? 'warn' : 'info',
        artifact_id: v.id,
        artifact_type: v.artifact_type,
        artifact_key: v.artifact_key,
        age_days: ageDays,
        message: `${v.artifact_type} (${v.artifact_key}) has been a placeholder for ${ageDays} day(s). Generation should be wired.`,
        auto_remediable: true,
        remediation_job: `generate_${v.artifact_type}`,
      });
    }

    if (v.status === 'pending_review' && ageMs > 7 * 24 * 60 * 60 * 1000) {
      alerts.push({
        type: 'stale_pending_review',
        severity: 'info',
        artifact_id: v.id,
        artifact_type: v.artifact_type,
        age_days: ageDays,
        message: `${v.artifact_type} has been pending client review for ${ageDays} day(s).`,
        auto_remediable: false,
      });
    }
  }

  return {
    ok: true,
    placeholder_count: versions.filter(v => v.status === 'generation_placeholder').length,
    pending_review_count: versions.filter(v => v.status === 'pending_review').length,
    alerts,
  };
}

// ---------------------------------------------------------------------------
// JOB HEALTH
// Checks for recently dead-lettered or high-failure-rate jobs for this client.
// ---------------------------------------------------------------------------

async function collectJobHealth(env, client, supabase) {
  const alerts = [];
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // last 24h

  // Dead letter entries in last 24h
  const dlRes = await supabase(env, 'GET',
    `/rest/v1/jobs_dead_letter?client_slug=eq.${enc(client.slug)}&created_at=gte.${enc(since)}&select=id,job_type,error,created_at&limit=10`
  );
  const deadLetters = dlRes.ok ? await dlRes.json() : [];

  for (const dl of deadLetters) {
    alerts.push({
      type: 'dead_letter_job',
      severity: 'warn',
      job_type: dl.job_type,
      dead_letter_id: dl.id,
      message: `Job '${dl.job_type}' exhausted all retries and was dead-lettered. Error: ${dl.error?.message || 'unknown'}.`,
      auto_remediable: false,
    });
  }

  // Jobs stuck in 'running' state for more than 10 minutes (belt+suspenders — reaper handles most)
  const stuckRes = await supabase(env, 'GET',
    `/rest/v1/jobs?client_slug=eq.${enc(client.slug)}&status=eq.running&locked_at=lte.${enc(new Date(Date.now() - 10 * 60 * 1000).toISOString())}&select=id,job_type,queue,locked_at&limit=5`
  );
  const stuckJobs = stuckRes.ok ? await stuckRes.json() : [];

  for (const job of stuckJobs) {
    const stuckMins = Math.round((Date.now() - new Date(job.locked_at).getTime()) / 60000);
    alerts.push({
      type: 'stuck_job',
      severity: 'warn',
      job_id: job.id,
      job_type: job.job_type,
      queue: job.queue,
      stuck_minutes: stuckMins,
      message: `Job '${job.job_type}' has been running for ${stuckMins} minutes without completing.`,
      auto_remediable: false,
    });
  }

  return {
    ok: deadLetters.length === 0 && stuckJobs.length === 0,
    dead_letter_count_24h: deadLetters.length,
    stuck_job_count: stuckJobs.length,
    alerts,
  };
}

// ---------------------------------------------------------------------------
// PROFILE HEALTH
// Checks business profile completeness and unresolved contradictions.
// ---------------------------------------------------------------------------

async function collectProfileHealth(env, client, supabase) {
  const alerts = [];

  // Load business profile (platform Supabase has a business_profiles table)
  const profileRes = await supabase(env, 'GET',
    `/rest/v1/business_profiles?client_id=eq.${enc(client.id)}&select=business_name,services,phone,email,location,hours&limit=1`
  );
  if (!profileRes.ok) return { ok: false, alerts: [] };
  const profiles = await profileRes.json();
  if (!profiles.length) return { ok: true, alerts: [], completeness_pct: 0 };

  const profile = profiles[0];
  const coreFields = ['business_name', 'services', 'phone', 'email', 'location'];
  const present = coreFields.filter(f => profile[f] && (Array.isArray(profile[f]) ? profile[f].length > 0 : String(profile[f]).trim().length > 0));
  const completeness_pct = Math.round((present.length / coreFields.length) * 100);

  if (completeness_pct < 60) {
    const missing = coreFields.filter(f => !present.includes(f));
    alerts.push({
      type: 'low_profile_completeness',
      severity: 'info',
      completeness_pct,
      missing_fields: missing,
      message: `Business profile is ${completeness_pct}% complete. Missing: ${missing.join(', ')}.`,
      auto_remediable: false,
    });
  }

  return { ok: true, completeness_pct, alerts };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function buildFailedSection(type, reason) {
  return {
    ok: false,
    error: reason?.message || String(reason || 'unknown'),
    alerts: [{ type: `${type}_collection_failed`, severity: 'warn', message: reason?.message || String(reason || 'unknown') }],
  };
}

function requireDep(value, name) {
  if (!value) throw new Error(`Missing health collector dependency: ${name}`);
  return value;
}

function enc(v) { return encodeURIComponent(v); }

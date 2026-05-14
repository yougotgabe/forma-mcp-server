// =============================================================================
// FORMAUT CLIENT AGENT WORKER — v0
// =============================================================================
// Deployed into the client's own Cloudflare account.
// Performs local health checks and reports signed events to the Formaut
// control plane. No AI calls. No client business data stored centrally.
//
// Endpoints (all unauthenticated — this worker runs in the client's CF account):
//   GET  /health              — local health summary (no upstream call)
//   GET  /status              — agent identity + config status
//   POST /heartbeat           — manual heartbeat trigger
//   POST /validate-deployment — validate a deployment URL + report event
//   POST /capability-report   — push current capability list to control plane
//   POST /check-config        — compare env config against expected schema
//
// Scheduled cron (wrangler.toml [triggers]):
//   Every 5 minutes: heartbeat + health check
//   Every hour:      capability report
//
// Required secrets (wrangler secret put):
//   CLIENT_SLUG                — matches platform client record slug
//   FORMAUT_CONTROL_PLANE_URL  — platform worker URL (no trailing slash)
//   FORMAUT_AGENT_SECRET       — HMAC shared secret (matches platform FORMAUT_AGENT_SECRET)
//
// Optional vars (wrangler.toml [vars] or secrets):
//   SITE_URL                   — primary site URL for health checks
//   PAGES_PROJECT_NAME         — Cloudflare Pages project name
//   AGENT_VERSION              — semver, defaults to package version constant
//   SCHEMA_VERSION             — protocol schema version
//   RUNTIME_MODE               — 'stable' | 'canary' | 'maintenance'
// =============================================================================

import { buildClientAgentEvent, CLIENT_AGENT_EVENT_TYPES, AGENT_CAPABILITIES } from '../shared/event-protocol/client-agent-events.js';
import { canonicalEventString, hmacSha256Hex } from '../shared/signing/hmac.js';

const AGENT_VERSION   = '0.1.0';
const SCHEMA_VERSION  = '2026-05';

// =============================================================================
// WORKER ENTRYPOINT
// =============================================================================

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const { pathname } = url;

    // Health — GET, no auth, no upstream call.
    if (request.method === 'GET' && pathname === '/health') {
      const health = await collectLocalHealth(env);
      return json({ ok: true, agent: identity(env), health });
    }

    // Status — GET, shows config presence without revealing secrets.
    if (request.method === 'GET' && pathname === '/status') {
      return json({ ok: true, agent: identity(env), config: configStatus(env) });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    let body = {};
    try { body = await request.json(); } catch { /* empty body is fine */ }

    if (pathname === '/heartbeat') {
      return handleHeartbeat(env);
    }

    if (pathname === '/validate-deployment') {
      return handleValidateDeployment(env, body);
    }

    if (pathname === '/capability-report') {
      return handleCapabilityReport(env);
    }

    if (pathname === '/check-config') {
      return handleCheckConfig(env, body);
    }

    return json({ error: 'Not found' }, 404);
  },

  // ── Cron ──────────────────────────────────────────────────────────────────
  async scheduled(event, env, _ctx) {
    const cron = event.cron || '';

    // Every 5 minutes: heartbeat + health
    if (cron === '*/5 * * * *' || cron === '') {
      await runHeartbeat(env);
    }

    // Hourly: full capability report
    if (cron === '0 * * * *') {
      await runCapabilityReport(env);
    }
  },
};

// =============================================================================
// HANDLERS
// =============================================================================

async function handleHeartbeat(env) {
  const result = await runHeartbeat(env);
  return json(result, result.ok ? 200 : 502);
}

async function handleValidateDeployment(env, body) {
  const health  = await collectLocalHealth(env);
  const target  = body.url || env.SITE_URL;
  const depCheck = await validateDeployment(env, body);

  const eventType = depCheck.ok
    ? CLIENT_AGENT_EVENT_TYPES.DEPLOYMENT_VALIDATED
    : CLIENT_AGENT_EVENT_TYPES.DEPLOYMENT_FAILED;

  const result = await sendSignedEvent(env, eventType, {
    ...depCheck,
    health_at_validation: health.status,
  });

  return json({ ok: result.ok, validation: depCheck, event: result }, result.ok ? 200 : 502);
}

async function handleCapabilityReport(env) {
  const result = await runCapabilityReport(env);
  return json(result, result.ok ? 200 : 502);
}

async function handleCheckConfig(env, body) {
  const result = checkConfigSchema(env);
  if (!result.ok) {
    // Report config drift to control plane if secrets are available to do so.
    if (env.CLIENT_SLUG && env.FORMAUT_CONTROL_PLANE_URL && env.FORMAUT_AGENT_SECRET) {
      await sendSignedEvent(env, CLIENT_AGENT_EVENT_TYPES.CONFIG_DRIFT, {
        missing:    result.missing,
        warnings:   result.warnings,
        checked_at: new Date().toISOString(),
      }).catch(() => null); // fire-and-forget, don't block response
    }
  }
  return json({ ok: result.ok, config: configStatus(env), issues: result });
}

// =============================================================================
// CORE ROUTINES
// =============================================================================

async function runHeartbeat(env) {
  const health = await collectLocalHealth(env);
  const eventType = health.status === 'healthy'
    ? CLIENT_AGENT_EVENT_TYPES.HEARTBEAT
    : CLIENT_AGENT_EVENT_TYPES.HEALTH_DEGRADED;

  return sendSignedEvent(env, eventType, health);
}

async function runCapabilityReport(env) {
  const capabilities = declaredCapabilities(env);
  return sendSignedEvent(env, CLIENT_AGENT_EVENT_TYPES.CAPABILITY_REPORT, {
    capabilities,
    config:     configStatus(env),
    reported_at: new Date().toISOString(),
  });
}

// =============================================================================
// HEALTH COLLECTION
// =============================================================================

async function collectLocalHealth(env) {
  const checks = [];

  // Primary site check
  if (env.SITE_URL) {
    checks.push(await checkHttp('site', env.SITE_URL));
  }

  // Pages project URL (derived if not explicit)
  const pagesUrl = env.PAGES_URL || (env.PAGES_PROJECT_NAME
    ? `https://${env.PAGES_PROJECT_NAME}.pages.dev`
    : null);
  if (pagesUrl && pagesUrl !== env.SITE_URL) {
    checks.push(await checkHttp('pages', pagesUrl));
  }

  const allOk    = checks.every((c) => c.ok);
  const anyCrit  = checks.some((c) => !c.ok && c.status && c.status >= 500);
  const status   = checks.length === 0 ? 'unconfigured'
    : allOk        ? 'healthy'
    : anyCrit      ? 'degraded'
    : 'warn';

  return {
    ...identity(env),
    checked_at: new Date().toISOString(),
    status,
    checks,
  };
}

async function validateDeployment(env, input = {}) {
  const targetUrl = input.url || env.SITE_URL;
  if (!targetUrl) {
    return { ok: false, severity: 'warn', reason: 'missing_site_url', checks: [] };
  }

  const check = await checkHttp('deployment_url', targetUrl);
  const ok    = check.ok;

  return {
    ok,
    severity:       ok ? 'info' : 'critical',
    url:            targetUrl,
    checks:         [check],
    deployment_id:  input.deployment_id  || null,
    commit_sha:     input.commit_sha     || null,
    pages_project:  env.PAGES_PROJECT_NAME || null,
    validated_at:   new Date().toISOString(),
  };
}

async function checkHttp(name, url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      cf:     { cacheTtl: 0 },
      signal: AbortSignal.timeout(8000),
    });
    return { name, ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { name, ok: false, error: String(err.message).slice(0, 120), ms: Date.now() - started };
  }
}

// =============================================================================
// CONFIG SCHEMA CHECK
// =============================================================================

const REQUIRED_SECRETS = ['CLIENT_SLUG', 'FORMAUT_CONTROL_PLANE_URL', 'FORMAUT_AGENT_SECRET'];
const RECOMMENDED_VARS = ['SITE_URL', 'PAGES_PROJECT_NAME'];

function checkConfigSchema(env) {
  const missing  = REQUIRED_SECRETS.filter((k) => !env[k]);
  const warnings = RECOMMENDED_VARS.filter((k) => !env[k])
    .map((k) => `${k} not set — some checks will be skipped`);
  return { ok: missing.length === 0, missing, warnings };
}

function configStatus(env) {
  return {
    has_client_slug:      Boolean(env.CLIENT_SLUG),
    has_control_plane:    Boolean(env.FORMAUT_CONTROL_PLANE_URL),
    has_agent_secret:     Boolean(env.FORMAUT_AGENT_SECRET),
    has_site_url:         Boolean(env.SITE_URL),
    has_pages_project:    Boolean(env.PAGES_PROJECT_NAME),
  };
}

// =============================================================================
// SIGNED EVENT DISPATCH
// =============================================================================

async function sendSignedEvent(env, eventType, payload) {
  const missingSecrets = REQUIRED_SECRETS.filter((k) => !env[k]);
  if (missingSecrets.length) {
    return {
      ok:    false,
      error: 'missing_required_secrets',
      missing: missingSecrets,
    };
  }

  let event;
  try {
    event = buildClientAgentEvent({
      client_slug:   env.CLIENT_SLUG,
      event_type:    eventType,
      payload,
      agent_version:  env.AGENT_VERSION || AGENT_VERSION,
      schema_version: env.SCHEMA_VERSION || SCHEMA_VERSION,
      runtime_mode:   env.RUNTIME_MODE || 'stable',
      capabilities:   declaredCapabilities(env),
    });
    event.signature = await hmacSha256Hex(env.FORMAUT_AGENT_SECRET, canonicalEventString(event));
  } catch (err) {
    return { ok: false, error: 'event_build_failed', detail: err.message };
  }

  try {
    const res = await fetch(
      `${env.FORMAUT_CONTROL_PLANE_URL.replace(/\/$/, '')}/client-agent/events/ingest`,
      {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(event),
        signal:  AbortSignal.timeout(10_000),
      }
    );
    const response = await safeJson(res);
    return { ok: res.ok, status: res.status, event_id: event.event_id, response };
  } catch (err) {
    return { ok: false, error: 'dispatch_failed', detail: err.message, event_id: event.event_id };
  }
}

// =============================================================================
// IDENTITY + CAPABILITIES
// =============================================================================

function identity(env) {
  return {
    client_slug:    env.CLIENT_SLUG    || null,
    agent_version:  env.AGENT_VERSION  || AGENT_VERSION,
    schema_version: env.SCHEMA_VERSION || SCHEMA_VERSION,
    runtime_mode:   env.RUNTIME_MODE   || 'stable',
  };
}

function declaredCapabilities(env) {
  // All v0 capabilities are always declared; future versions can conditionally
  // omit based on env config.
  return [...AGENT_CAPABILITIES];
}

// =============================================================================
// UTILITIES
// =============================================================================

async function safeJson(res) {
  try   { return await res.json(); }
  catch { return { text: await res.text().catch(() => '') }; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

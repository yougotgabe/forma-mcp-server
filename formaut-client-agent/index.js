import { buildClientAgentEvent, CLIENT_AGENT_EVENT_TYPES } from '../shared/event-protocol/client-agent-events.js';
import { canonicalEventString, hmacSha256Hex } from '../shared/signing/hmac.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      const summary = await collectLocalHealth(env);
      return json({ ok: true, agent: identity(env), health: summary });
    }

    if (request.method === 'POST' && url.pathname === '/heartbeat') {
      const result = await sendSignedEvent(env, CLIENT_AGENT_EVENT_TYPES.HEARTBEAT, await collectLocalHealth(env));
      return json(result, result.ok ? 200 : 502);
    }

    if (request.method === 'POST' && url.pathname === '/validate-deployment') {
      const body = await readJson(request);
      const payload = await validateDeployment(env, body);
      const type = payload.ok ? CLIENT_AGENT_EVENT_TYPES.DEPLOYMENT_VALIDATED : CLIENT_AGENT_EVENT_TYPES.DEPLOYMENT_FAILED;
      const result = await sendSignedEvent(env, type, payload);
      return json({ ...result, validation: payload }, result.ok ? 200 : 502);
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(_event, env, _ctx) {
    await sendSignedEvent(env, CLIENT_AGENT_EVENT_TYPES.HEARTBEAT, await collectLocalHealth(env));
  },
};

function identity(env) {
  return {
    client_slug: env.CLIENT_SLUG,
    agent_version: env.AGENT_VERSION || '0.1.0',
    schema_version: env.SCHEMA_VERSION || '2026-05',
    runtime_mode: env.RUNTIME_MODE || 'stable',
  };
}

async function collectLocalHealth(env) {
  const checks = [];
  if (env.SITE_URL) checks.push(await checkHttp('site', env.SITE_URL));
  return {
    ...identity(env),
    checked_at: new Date().toISOString(),
    status: checks.every((c) => c.ok) ? 'healthy' : 'warn',
    checks,
  };
}

async function validateDeployment(env, input = {}) {
  const targetUrl = input.url || env.SITE_URL;
  if (!targetUrl) return { ok: false, severity: 'warn', reason: 'missing_site_url' };
  const site = await checkHttp('deployment_url', targetUrl);
  return {
    ok: site.ok,
    severity: site.ok ? 'info' : 'critical',
    url: targetUrl,
    checks: [site],
    deployment_id: input.deployment_id || null,
    commit_sha: input.commit_sha || null,
  };
}

async function checkHttp(name, url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', cf: { cacheTtl: 0 } });
    return { name, ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { name, ok: false, error: err.message, ms: Date.now() - started };
  }
}

async function sendSignedEvent(env, eventType, payload) {
  const controlPlaneUrl = env.FORMAUT_CONTROL_PLANE_URL;
  const secret = env.FORMAUT_AGENT_SECRET;
  if (!controlPlaneUrl || !secret || !env.CLIENT_SLUG) {
    return { ok: false, error: 'CLIENT_SLUG, FORMAUT_CONTROL_PLANE_URL, and FORMAUT_AGENT_SECRET are required' };
  }
  const event = buildClientAgentEvent({ ...identity(env), event_type: eventType, payload });
  event.signature = await hmacSha256Hex(secret, canonicalEventString(event));
  const res = await fetch(`${controlPlaneUrl.replace(/\/$/, '')}/client-agent/events/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.FORMAUT_WORKER_SECRET ? { 'x-worker-secret': env.FORMAUT_WORKER_SECRET } : {}),
    },
    body: JSON.stringify(event),
  });
  const response = await safeJson(res);
  return { ok: res.ok, status: res.status, response, event_id: event.event_id };
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

async function safeJson(res) {
  try { return await res.json(); } catch { return { text: await res.text().catch(() => '') }; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

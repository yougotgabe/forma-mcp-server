import { canonicalEventString, verifyHmacSha256Hex } from '../../shared/signing/hmac.js';
import { eventSeverity, validateClientAgentEventShape } from '../../shared/event-protocol/client-agent-events.js';

export async function handleClientAgentRegister(body = {}, env = {}, deps = {}) {
  const supabase = requireSupabase(deps.supabase);
  const client_slug = body.client_slug || body.slug;
  if (!client_slug) throw new Error('client_slug is required');
  const now = new Date().toISOString();
  const row = {
    client_slug,
    agent_version: body.agent_version || 'unknown',
    schema_version: body.schema_version || 'unknown',
    runtime_mode: body.runtime_mode || 'stable',
    capabilities: body.capabilities || [],
    status: 'registered',
    last_seen_at: now,
    metadata: body.metadata || {},
  };
  await supabase(env, 'POST', '/rest/v1/client_agent_runtimes', row, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  return {
    ok: true,
    client_slug,
    required_secret: 'Set the client agent Worker secret FORMAUT_AGENT_SECRET to match platform FORMAUT_AGENT_SECRET or CLIENT_AGENT_SHARED_SECRET.',
  };
}

export async function handleClientAgentHeartbeat(body = {}, env = {}, deps = {}) {
  return handleClientAgentEvent({
    ...body,
    event_type: body.event_type || 'agent.heartbeat',
    payload: body.payload || body.health || {},
  }, env, deps);
}

export async function handleClientAgentEvent(event = {}, env = {}, deps = {}) {
  const supabase = requireSupabase(deps.supabase);
  const shape = validateClientAgentEventShape(event);
  if (!shape.ok) return { ok: false, error: 'invalid_event_shape', details: shape.errors };

  const validation = await validateClientAgentSignature(event, env, supabase);
  if (!validation.ok) return validation;

  const severity = eventSeverity(event.event_type, event.payload || {});
  const now = new Date().toISOString();

  await supabase(env, 'POST', '/rest/v1/client_agent_events', {
    event_id: event.event_id,
    client_slug: event.client_slug,
    event_type: event.event_type,
    severity,
    nonce: event.nonce,
    signature_hint: String(event.signature).slice(-8),
    agent_version: event.agent_version || null,
    schema_version: event.schema_version || null,
    payload: event.payload || {},
    received_at: now,
  }, { Prefer: 'resolution=merge-duplicates,return=minimal' });

  await supabase(env, 'POST', '/rest/v1/client_agent_runtimes', {
    client_slug: event.client_slug,
    agent_version: event.agent_version || 'unknown',
    schema_version: event.schema_version || 'unknown',
    runtime_mode: event.runtime_mode || 'stable',
    capabilities: event.capabilities || [],
    status: severity === 'critical' ? 'attention' : 'healthy',
    last_seen_at: now,
    last_event_id: event.event_id,
    metadata: { last_event_type: event.event_type, last_payload_summary: summarizePayload(event.payload) },
  }, { Prefer: 'resolution=merge-duplicates,return=minimal' });

  const shouldCreateOperationalEvent = severity !== 'info' || event.event_type !== 'agent.heartbeat';
  if (shouldCreateOperationalEvent) {
    await supabase(env, 'POST', '/rest/v1/operational_events', {
      client_slug: event.client_slug,
      event_type: event.event_type,
      severity,
      source: 'client_agent',
      status: 'open',
      dedup_key: `${event.client_slug}:${event.event_type}:${event.payload?.resource || 'default'}`,
      auto_remediable: event.payload?.auto_remediable === true,
      remediation_job: event.payload?.remediation_job || null,
      payload: { event_id: event.event_id, agent_payload: event.payload || {} },
    }, { Prefer: 'return=minimal' });
  }

  return { ok: true, accepted: true, client_slug: event.client_slug, event_id: event.event_id, severity };
}

export async function listClientAgentRuntimes(body = {}, env = {}, deps = {}) {
  const supabase = requireSupabase(deps.supabase);
  const slug = body.client_slug || body.slug;
  const limit = Math.min(Number(body.limit || 50), 200);
  const filter = slug ? `client_slug=eq.${encodeURIComponent(slug)}&` : '';
  const res = await supabase(env, 'GET', `/rest/v1/client_agent_runtimes?${filter}select=*&order=last_seen_at.desc&limit=${limit}`);
  if (!res.ok) throw new Error(await res.text());
  return { ok: true, runtimes: await res.json() };
}

async function validateClientAgentSignature(event, env, supabase) {
  const runtimeSecret = env.FORMAUT_AGENT_SECRET || env.CLIENT_AGENT_SHARED_SECRET;
  if (!runtimeSecret) return { ok: false, error: 'missing_agent_secret', detail: 'Set FORMAUT_AGENT_SECRET or CLIENT_AGENT_SHARED_SECRET on the platform worker.' };

  const replay = await supabase(env, 'GET', `/rest/v1/client_agent_events?client_slug=eq.${encodeURIComponent(event.client_slug)}&nonce=eq.${encodeURIComponent(event.nonce)}&select=event_id&limit=1`);
  if (replay.ok) {
    const rows = await replay.json();
    if (rows.length) return { ok: false, error: 'replay_rejected' };
  }

  const ageMs = Math.abs(Date.now() - Date.parse(event.timestamp));
  const maxAgeMs = Number(env.CLIENT_AGENT_MAX_CLOCK_SKEW_MS || 5 * 60 * 1000);
  if (ageMs > maxAgeMs) return { ok: false, error: 'stale_event', age_ms: ageMs };

  const ok = await verifyHmacSha256Hex(runtimeSecret, canonicalEventString(event), event.signature);
  if (!ok) return { ok: false, error: 'invalid_signature' };
  return { ok: true };
}

function summarizePayload(payload = {}) {
  return Object.fromEntries(Object.entries(payload || {}).filter(([_, v]) => typeof v !== 'object').slice(0, 12));
}

function requireSupabase(supabase) {
  if (!supabase) throw new Error('supabase dependency is required');
  return supabase;
}

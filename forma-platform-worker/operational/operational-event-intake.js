// =============================================================================
// FORMAUT — CLIENT AGENT EVENT INTAKE
// Platform worker side of the signed-event pipeline.
//
// Responsibilities:
//   - Register agent runtimes (upsert on slug)
//   - Verify HMAC signatures + replay protection + clock-skew guard
//   - Store events in client_agent_events
//   - Upsert runtime status in client_agent_runtimes
//   - Fan out non-routine events to operational_events for the maintenance loop
//   - Expose runtime list for dashboard/operator panel
//   - Handle capability reports and config drift alerts
//
// No AI calls. Fully deterministic.
// =============================================================================

import { canonicalEventString, verifyHmacSha256Hex } from '../../shared/signing/hmac.js';
import { eventSeverity, validateClientAgentEventShape } from '../../shared/event-protocol/client-agent-events.js';

// =============================================================================
// REGISTRATION
// =============================================================================

export async function handleClientAgentRegister(body = {}, env = {}, deps = {}) {
  const supabase    = requireSupabase(deps.supabase);
  const client_slug = body.client_slug || body.slug;
  if (!client_slug) throw new Error('client_slug is required');

  // Verify the slug exists in clients table before accepting registration.
  const clientCheck = await supabase(
    env, 'GET',
    `/rest/v1/clients?slug=eq.${enc(client_slug)}&select=slug,status&limit=1`
  );
  if (clientCheck.ok) {
    const rows = await clientCheck.json();
    if (!rows.length) return { ok: false, error: 'unknown_client_slug' };
    if (rows[0].status === 'cancelled') return { ok: false, error: 'client_inactive' };
  }

  const now = new Date().toISOString();
  const row = {
    client_slug,
    agent_version:  body.agent_version  || 'unknown',
    schema_version: body.schema_version || 'unknown',
    runtime_mode:   body.runtime_mode   || 'stable',
    capabilities:   body.capabilities   || [],
    status:         'registered',
    last_seen_at:   now,
    metadata:       body.metadata || {},
  };

  await supabase(env, 'POST', '/rest/v1/client_agent_runtimes', row,
    { Prefer: 'resolution=merge-duplicates,return=minimal' }
  );

  // Fire a registered event into the event log.
  await supabase(env, 'POST', '/rest/v1/client_agent_events', {
    event_id:       crypto.randomUUID(),
    client_slug,
    event_type:     'agent.registered',
    severity:       'info',
    nonce:          crypto.randomUUID(),
    agent_version:  body.agent_version  || 'unknown',
    schema_version: body.schema_version || 'unknown',
    payload:        { capabilities: body.capabilities || [], registered_at: now },
    received_at:    now,
  }, { Prefer: 'return=minimal' });

  return {
    ok:                  true,
    client_slug,
    registered_at:       now,
    required_secret_tip: 'Set FORMAUT_AGENT_SECRET on the client agent Worker to match FORMAUT_AGENT_SECRET on the platform worker.',
  };
}

// =============================================================================
// HEARTBEAT (thin wrapper — routes through the main event handler)
// =============================================================================

export async function handleClientAgentHeartbeat(body = {}, env = {}, deps = {}) {
  return handleClientAgentEvent({
    ...body,
    event_type: body.event_type || 'agent.heartbeat',
    payload:    body.payload    || body.health || {},
  }, env, deps);
}

// =============================================================================
// SIGNED EVENT INGEST
// =============================================================================

export async function handleClientAgentEvent(event = {}, env = {}, deps = {}) {
  const supabase = requireSupabase(deps.supabase);

  // 1. Shape validation
  const shape = validateClientAgentEventShape(event);
  if (!shape.ok) return { ok: false, error: 'invalid_event_shape', details: shape.errors };

  // 2. Signature + replay + clock-skew verification
  const validation = await validateClientAgentSignature(event, env, supabase);
  if (!validation.ok) return validation;

  const severity = eventSeverity(event.event_type, event.payload || {});
  const now      = new Date().toISOString();

  // 3. Persist event
  await supabase(env, 'POST', '/rest/v1/client_agent_events', {
    event_id:       event.event_id,
    client_slug:    event.client_slug,
    event_type:     event.event_type,
    severity,
    nonce:          event.nonce,
    signature_hint: String(event.signature).slice(-8),
    agent_version:  event.agent_version  || null,
    schema_version: event.schema_version || null,
    payload:        event.payload        || {},
    received_at:    now,
  }, { Prefer: 'resolution=merge-duplicates,return=minimal' });

  // 4. Upsert runtime status
  const runtimeStatus = resolveRuntimeStatus(severity, event.event_type);
  await supabase(env, 'POST', '/rest/v1/client_agent_runtimes', {
    client_slug:    event.client_slug,
    agent_version:  event.agent_version  || 'unknown',
    schema_version: event.schema_version || 'unknown',
    runtime_mode:   event.runtime_mode   || 'stable',
    capabilities:   event.capabilities   || [],
    status:         runtimeStatus,
    last_seen_at:   now,
    last_event_id:  event.event_id,
    metadata: {
      last_event_type:          event.event_type,
      last_payload_summary:     summarizePayload(event.payload),
      last_severity:            severity,
    },
  }, { Prefer: 'resolution=merge-duplicates,return=minimal' });

  // 5. Fan out to operational_events for anything non-routine.
  await maybeCreateOperationalEvent(event, severity, supabase, env);

  return {
    ok:          true,
    accepted:    true,
    client_slug: event.client_slug,
    event_id:    event.event_id,
    severity,
    runtime_status: runtimeStatus,
  };
}

// =============================================================================
// RUNTIME LIST (operator panel + dashboard)
// =============================================================================

export async function listClientAgentRuntimes(body = {}, env = {}, deps = {}) {
  const supabase = requireSupabase(deps.supabase);
  const slug     = body.client_slug || body.slug;
  const limit    = Math.min(Number(body.limit || 50), 200);
  const filter   = slug ? `client_slug=eq.${enc(slug)}&` : '';
  const status   = body.status ? `status=eq.${enc(body.status)}&` : '';

  const res = await supabase(
    env, 'GET',
    `/rest/v1/client_agent_runtimes?${filter}${status}select=*&order=last_seen_at.desc&limit=${limit}`
  );
  if (!res.ok) throw new Error(await res.text());

  const runtimes = await res.json();
  return {
    ok:       true,
    runtimes,
    count:    runtimes.length,
    summary:  buildRuntimeSummary(runtimes),
  };
}

// =============================================================================
// RECENT EVENTS (operator panel)
// =============================================================================

export async function listClientAgentEvents(body = {}, env = {}, deps = {}) {
  const supabase  = requireSupabase(deps.supabase);
  const slug      = body.client_slug || body.slug;
  const limit     = Math.min(Number(body.limit || 100), 500);
  const eventType = body.event_type;
  const severity  = body.severity;
  const since     = body.since; // ISO timestamp

  let filter = slug ? `client_slug=eq.${enc(slug)}&` : '';
  if (eventType) filter += `event_type=eq.${enc(eventType)}&`;
  if (severity)  filter += `severity=eq.${enc(severity)}&`;
  if (since)     filter += `received_at=gte.${enc(since)}&`;

  const res = await supabase(
    env, 'GET',
    `/rest/v1/client_agent_events?${filter}select=*&order=received_at.desc&limit=${limit}`
  );
  if (!res.ok) throw new Error(await res.text());
  const events = await res.json();
  return { ok: true, events, count: events.length };
}

// =============================================================================
// AGENT DEACTIVATION (operator action)
// =============================================================================

export async function deactivateClientAgent(body = {}, env = {}, deps = {}) {
  const supabase    = requireSupabase(deps.supabase);
  const client_slug = body.client_slug || body.slug;
  if (!client_slug) throw new Error('client_slug is required');

  await supabase(env, 'PATCH',
    `/rest/v1/client_agent_runtimes?client_slug=eq.${enc(client_slug)}`,
    { status: 'disabled', metadata: { disabled_at: new Date().toISOString(), disabled_by: body.operator || 'operator' } }
  );

  return { ok: true, client_slug, status: 'disabled' };
}

// =============================================================================
// STALE AGENT SWEEP (called from cron)
// Marks agents healthy/warn as stale if not seen in > threshold.
// =============================================================================

export async function sweepStaleAgents(env = {}, deps = {}) {
  const supabase       = requireSupabase(deps.supabase);
  const staleThresholdMinutes = Number(env.CLIENT_AGENT_STALE_THRESHOLD_MINUTES || 30);
  const cutoff         = new Date(Date.now() - staleThresholdMinutes * 60 * 1000).toISOString();

  // Find agents that were last seen before the cutoff and are not already stale/disabled.
  const res = await supabase(env, 'GET',
    `/rest/v1/client_agent_runtimes?last_seen_at=lt.${enc(cutoff)}&status=in.(healthy,warn,attention,registered)&select=client_slug,last_seen_at&limit=200`
  );
  if (!res.ok) return { ok: false, error: 'sweep_query_failed' };

  const stale = await res.json();
  const swept = [];

  for (const row of stale) {
    await supabase(env, 'PATCH',
      `/rest/v1/client_agent_runtimes?client_slug=eq.${enc(row.client_slug)}`,
      { status: 'stale' }
    ).catch(() => null);

    // Emit an operational event so the maintenance loop can alert.
    await supabase(env, 'POST', '/rest/v1/operational_events', {
      client_slug:       row.client_slug,
      event_type:        'agent.stale',
      severity:          'warn',
      source:            'client_agent_sweep',
      status:            'open',
      dedup_key:         `${row.client_slug}:agent.stale`,
      auto_remediable:   false,
      payload:           { last_seen_at: row.last_seen_at, stale_threshold_minutes: staleThresholdMinutes },
    }, { Prefer: 'return=minimal' }).catch(() => null);

    swept.push(row.client_slug);
  }

  return { ok: true, swept_count: swept.length, swept };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

async function validateClientAgentSignature(event, env, supabase) {
  const secret = env.FORMAUT_AGENT_SECRET || env.CLIENT_AGENT_SHARED_SECRET;
  if (!secret) {
    return {
      ok:     false,
      error:  'missing_agent_secret',
      detail: 'Set FORMAUT_AGENT_SECRET on the platform worker.',
    };
  }

  // Replay protection — nonce must be unique per client_slug.
  const replayRes = await supabase(env, 'GET',
    `/rest/v1/client_agent_events?client_slug=eq.${enc(event.client_slug)}&nonce=eq.${enc(event.nonce)}&select=event_id&limit=1`
  );
  if (replayRes.ok) {
    const rows = await replayRes.json().catch(() => []);
    if (rows.length) return { ok: false, error: 'replay_rejected', nonce: event.nonce };
  }

  // Clock-skew guard — reject events older than 5 minutes (configurable).
  const ageMs    = Math.abs(Date.now() - Date.parse(event.timestamp));
  const maxAgeMs = Number(env.CLIENT_AGENT_MAX_CLOCK_SKEW_MS || 5 * 60 * 1000);
  if (ageMs > maxAgeMs) {
    return { ok: false, error: 'stale_event', age_ms: ageMs, max_age_ms: maxAgeMs };
  }

  // HMAC verification (timing-safe).
  const valid = await verifyHmacSha256Hex(secret, canonicalEventString(event), event.signature);
  if (!valid) return { ok: false, error: 'invalid_signature' };

  return { ok: true };
}

async function maybeCreateOperationalEvent(event, severity, supabase, env) {
  // Heartbeats at info severity don't need an operational event.
  const isRoutineHeartbeat =
    event.event_type === 'agent.heartbeat' && severity === 'info';

  // Capability reports and registrations are informational, not operational.
  const isInformational =
    event.event_type === 'agent.registered' ||
    event.event_type === 'agent.capability_report';

  if (isRoutineHeartbeat || isInformational) return;

  const autoRemediable = event.payload?.auto_remediable === true;
  await supabase(env, 'POST', '/rest/v1/operational_events', {
    client_slug:      event.client_slug,
    event_type:       event.event_type,
    severity,
    source:           'client_agent',
    status:           'open',
    dedup_key:        `${event.client_slug}:${event.event_type}:${event.payload?.resource || 'default'}`,
    auto_remediable:  autoRemediable,
    remediation_job:  event.payload?.remediation_job || null,
    payload: {
      event_id:      event.event_id,
      agent_payload: event.payload || {},
    },
  }, { Prefer: 'return=minimal' }).catch(() => null);
}

function resolveRuntimeStatus(severity, eventType) {
  if (eventType === 'health.degraded' || severity === 'critical') return 'attention';
  if (severity === 'warn')                                         return 'warn';
  return 'healthy';
}

function buildRuntimeSummary(runtimes) {
  const counts = { healthy: 0, warn: 0, attention: 0, stale: 0, disabled: 0, registered: 0 };
  for (const r of runtimes) {
    if (counts[r.status] !== undefined) counts[r.status]++;
  }
  return counts;
}

function summarizePayload(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload || {})
      .filter(([, v]) => typeof v !== 'object')
      .slice(0, 12)
  );
}

function requireSupabase(supabase) {
  if (!supabase) throw new Error('supabase dependency is required');
  return supabase;
}

function enc(v) {
  return encodeURIComponent(v);
}

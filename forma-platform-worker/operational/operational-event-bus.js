// =============================================================================
// FORMAUT — OPERATIONAL EVENT BUS
// =============================================================================
// Called by operational-maintenance-orchestrator after collectOperationalHealth.
// Converts raw collected health into structured operational_events in the
// platform Supabase, deduplicating against recent open events to avoid spam.
//
// Each event has: type, severity, client_id, client_slug, source, payload,
// status (open/acknowledged/resolved), and dedup_key to prevent duplicates
// within a configurable window.
//
// Returns the array of newly created event records.
// =============================================================================

// How long before we allow re-raising the same event type for the same client.
// Critical events dedupe for 1h, warn for 6h, info for 24h.
const DEDUP_WINDOWS = {
  critical: 1 * 60 * 60 * 1000,
  warn:     6 * 60 * 60 * 1000,
  info:    24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// MAIN EXPORT
// ---------------------------------------------------------------------------

export async function emitOperationalEvents(env, collected, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');

  // Backward compatibility: current Formaut code previously passed an array of normalized events.
  if (Array.isArray(collected)) {
    const created = [];
    for (const event of collected) {
      const row = legacyEventToRow(event);
      const res = await supabase(env, 'POST', '/rest/v1/operational_events', row, { Prefer: 'return=representation' });
      if (!res.ok) throw new Error(`Failed to emit operational event: ${await safeText(res)}`);
      const rows = await res.json();
      created.push(rows[0] || row);
    }
    return created;
  }

  const { client_id, client_slug, site, artifacts, jobs, profile } = collected;
  const createdEvents = [];

  // Gather all alerts from all health sections
  const allAlerts = [
    ...(site?.alerts || []).map(a => ({ ...a, source: 'site_health' })),
    ...(artifacts?.alerts || []).map(a => ({ ...a, source: 'artifact_health' })),
    ...(jobs?.alerts || []).map(a => ({ ...a, source: 'job_health' })),
    ...(profile?.alerts || []).map(a => ({ ...a, source: 'profile_health' })),
  ];

  if (!allAlerts.length) return createdEvents;

  // Load recent open events for this client to check dedup
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const existingRes = await supabase(env, 'GET',
    `/rest/v1/operational_events?client_id=eq.${enc(client_id)}&status=eq.open&created_at=gte.${enc(since)}&select=event_type,dedup_key,created_at,severity`
  );
  const existing = existingRes.ok ? await existingRes.json() : [];
  const existingByDedup = new Map(existing.map(e => [e.dedup_key, e]));

  for (const alert of allAlerts) {
    const dedupKey = buildDedupKey(client_slug, alert);
    const prior = existingByDedup.get(dedupKey);

    if (prior) {
      const window = DEDUP_WINDOWS[alert.severity] || DEDUP_WINDOWS.info;
      const priorAge = Date.now() - new Date(prior.created_at).getTime();
      if (priorAge < window) continue; // still within dedup window — skip
    }

    try {
      const row = {
        client_id,
        client_slug,
        event_type:   alert.type,
        severity:     normalizeSeverity(alert.severity),
        source:       alert.source || 'unknown',
        status:       'open',
        dedup_key:    dedupKey,
        auto_remediable: alert.auto_remediable || false,
        remediation_job: alert.remediation_job || null,
        payload: {
          message:      alert.message,
          url:          alert.url || null,
          artifact_id:  alert.artifact_id || null,
          artifact_type: alert.artifact_type || null,
          job_id:       alert.job_id || null,
          job_type:     alert.job_type || null,
          ...pickPayloadExtras(alert),
        },
      };

      const createRes = await supabase(env, 'POST', '/rest/v1/operational_events', row,
        { Prefer: 'return=representation' }
      );

      if (createRes.ok) {
        const created = await createRes.json();
        createdEvents.push(created[0]);
        existingByDedup.set(dedupKey, created[0]); // prevent double-emit in same run
      } else {
        console.warn('[event-bus] failed to create event:', alert.type, await safeText(createRes));
      }
    } catch (err) {
      console.warn('[event-bus] exception creating event:', alert.type, err?.message);
    }
  }

  return createdEvents;
}

// ---------------------------------------------------------------------------
// RESOLVE EVENTS
// Call this when a previously open event is no longer triggering.
// E.g. when a site health check now passes, close the 'homepage_unreachable' event.
// ---------------------------------------------------------------------------

export async function resolveOperationalEvent(env, { client_id, event_type, resolved_by = 'system' }, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');

  const res = await supabase(env, 'PATCH',
    `/rest/v1/operational_events?client_id=eq.${enc(client_id)}&event_type=eq.${enc(event_type)}&status=eq.open`,
    { status: 'resolved', resolved_at: new Date().toISOString(), resolved_by },
    { Prefer: 'return=minimal' }
  );

  return { ok: res.ok };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function buildDedupKey(clientSlug, alert) {
  // Stable key: slug + alert type + optional artifact/job discriminator
  const parts = [clientSlug, alert.type];
  if (alert.artifact_id) parts.push(alert.artifact_id);
  if (alert.job_id) parts.push(alert.job_id);
  if (alert.url) parts.push(new URL(alert.url).pathname.slice(0, 40));
  return parts.join(':').slice(0, 200);
}

function legacyEventToRow(event = {}) {
  const clientSlug = event.client_slug || event.slug || null;
  return {
    client_id: event.client_id || null,
    client_slug: clientSlug,
    event_type: event.event_type || event.type,
    severity: normalizeSeverity(event.severity),
    source: event.source || 'legacy_operational_event',
    status: 'open',
    dedup_key: [clientSlug, event.event_type || event.type, event.artifact_type || ''].filter(Boolean).join(':'),
    auto_remediable: Boolean(event.auto_remediable),
    remediation_job: event.remediation_job || null,
    payload: event.payload || {},
  };
}

function normalizeSeverity(s) {
  const v = String(s || 'info').toLowerCase();
  return v === 'warning' ? 'warn' : (['critical', 'warn', 'info'].includes(v) ? v : 'info');
}

function pickPayloadExtras(alert) {
  const extras = {};
  const extraKeys = ['age_days', 'stuck_minutes', 'completeness_pct', 'missing_fields',
    'broken_links_sample', 'status_code', 'response_time_ms', 'content_length_bytes',
    'dead_letter_id', 'dead_letter_count_24h', 'stuck_job_count'];
  for (const k of extraKeys) {
    if (alert[k] !== undefined) extras[k] = alert[k];
  }
  return extras;
}

function requireDep(value, name) {
  if (!value) throw new Error(`Missing event-bus dependency: ${name}`);
  return value;
}

function enc(v) { return encodeURIComponent(v); }

async function safeText(res) {
  try { 
    return await res.text();
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export async function emitOperationalEvent(env, event, deps = {}) {
  return emitOperationalEvents(env, [event], deps);
}

// ---------------------------------------------------------------------------
// SCHEMA REQUIRED (run in platform Supabase)
// ---------------------------------------------------------------------------
//
// create table if not exists operational_events (
//   id uuid primary key default gen_random_uuid(),
//   client_id uuid references clients(id) on delete cascade,
//   client_slug text not null,
//   event_type text not null,
//   severity text not null default 'info',
//   source text not null,
//   status text not null default 'open',
//   dedup_key text,
//   auto_remediable boolean default false,
//   remediation_job text,
//   payload jsonb default '{}',
//   resolved_at timestamptz,
//   resolved_by text,
//   created_at timestamptz default now(),
//   updated_at timestamptz default now()
// );
// create index if not exists operational_events_client_id_idx on operational_events(client_id);
// create index if not exists operational_events_dedup_key_idx on operational_events(dedup_key);
// create index if not exists operational_events_status_idx on operational_events(status);

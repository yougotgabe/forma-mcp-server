// =============================================================================
// FORMAUT — CLIENT AGENT EVENT PROTOCOL
// Shared between: formaut-client-agent (sender) and forma-platform-worker (receiver).
// Version pinned in CLIENT_AGENT_PROTOCOL_VERSION — bump when shape changes.
// =============================================================================

export const CLIENT_AGENT_PROTOCOL_VERSION = '2026-05-v1';

export const CLIENT_AGENT_EVENT_TYPES = Object.freeze({
  // Lifecycle
  HEARTBEAT:             'agent.heartbeat',
  REGISTERED:            'agent.registered',
  CAPABILITY_REPORT:     'agent.capability_report',

  // Health
  HEALTH_SUMMARY:        'health.summary',
  HEALTH_DEGRADED:       'health.degraded',

  // Deployment
  DEPLOYMENT_VALIDATED:  'deployment.validated',
  DEPLOYMENT_FAILED:     'deployment.failed',

  // Sync
  SYNC_SUMMARY:          'sync.summary',

  // Warnings
  INTEGRATION_WARNING:   'integration.warning',
  SECURITY_WARNING:      'security.warning',
  SCHEMA_MISMATCH:       'schema.mismatch',
  CONFIG_DRIFT:          'config.drift',
});

// Severity map — deterministic, no AI.
const SEVERITY_MAP = {
  'agent.heartbeat':          'info',
  'agent.registered':         'info',
  'agent.capability_report':  'info',
  'health.summary':           'info',
  'health.degraded':          'warn',
  'deployment.validated':     'info',
  'deployment.failed':        'critical',
  'sync.summary':             'info',
  'integration.warning':      'warn',
  'security.warning':         'critical',
  'schema.mismatch':          'warn',
  'config.drift':             'warn',
};

export function buildClientAgentEvent({
  client_slug,
  event_type,
  payload = {},
  agent_version,
  schema_version,
  runtime_mode,
  capabilities,
  nonce,
}) {
  if (!client_slug) throw new Error('client_slug is required');
  if (!event_type)  throw new Error('event_type is required');
  return {
    event_id:         crypto.randomUUID(),
    protocol_version: CLIENT_AGENT_PROTOCOL_VERSION,
    client_slug,
    event_type,
    timestamp:        new Date().toISOString(),
    nonce:            nonce || crypto.randomUUID(),
    agent_version:    agent_version   || 'unknown',
    schema_version:   schema_version  || 'unknown',
    runtime_mode:     runtime_mode    || 'stable',
    capabilities:     capabilities    || [],
    payload,
  };
}

export function validateClientAgentEventShape(event = {}) {
  const errors = [];
  for (const key of ['event_id', 'client_slug', 'event_type', 'timestamp', 'nonce', 'signature']) {
    if (!event[key]) errors.push(`${key} is required`);
  }
  if (event.timestamp && Number.isNaN(Date.parse(event.timestamp))) {
    errors.push('timestamp must be ISO parseable');
  }
  if (event.payload && typeof event.payload !== 'object') {
    errors.push('payload must be an object');
  }
  return { ok: errors.length === 0, errors };
}

export function eventSeverity(eventType, payload = {}) {
  // Payload can escalate but cannot de-escalate.
  const base = SEVERITY_MAP[eventType] || 'info';
  const payloadSeverity = payload.severity;
  if (!payloadSeverity) return base;
  const rank = { info: 0, warn: 1, critical: 2 };
  return (rank[payloadSeverity] ?? 0) > (rank[base] ?? 0) ? payloadSeverity : base;
}

// Capabilities that client agents can declare.
export const AGENT_CAPABILITIES = Object.freeze([
  'heartbeat',
  'health_check',
  'deployment_validation',
  'signed_events',
  'capability_report',
  'config_drift_detection',
  'integration_health',
]);

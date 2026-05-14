export const CLIENT_AGENT_PROTOCOL_VERSION = '2026-05-v1';

export const CLIENT_AGENT_EVENT_TYPES = Object.freeze({
  HEARTBEAT: 'agent.heartbeat',
  HEALTH_SUMMARY: 'health.summary',
  DEPLOYMENT_VALIDATED: 'deployment.validated',
  DEPLOYMENT_FAILED: 'deployment.failed',
  SYNC_SUMMARY: 'sync.summary',
  INTEGRATION_WARNING: 'integration.warning',
  SECURITY_WARNING: 'security.warning',
  SCHEMA_MISMATCH: 'schema.mismatch',
});

export function buildClientAgentEvent({ client_slug, event_type, payload = {}, agent_version, schema_version, nonce }) {
  if (!client_slug) throw new Error('client_slug is required');
  if (!event_type) throw new Error('event_type is required');
  return {
    event_id: crypto.randomUUID(),
    protocol_version: CLIENT_AGENT_PROTOCOL_VERSION,
    client_slug,
    event_type,
    timestamp: new Date().toISOString(),
    nonce: nonce || crypto.randomUUID(),
    agent_version: agent_version || 'unknown',
    schema_version: schema_version || 'unknown',
    payload,
  };
}

export function validateClientAgentEventShape(event = {}) {
  const errors = [];
  for (const key of ['event_id', 'client_slug', 'event_type', 'timestamp', 'nonce', 'signature']) {
    if (!event[key]) errors.push(`${key} is required`);
  }
  if (event.timestamp && Number.isNaN(Date.parse(event.timestamp))) errors.push('timestamp must be ISO parseable');
  if (event.payload && typeof event.payload !== 'object') errors.push('payload must be an object');
  return { ok: errors.length === 0, errors };
}

export function eventSeverity(eventType, payload = {}) {
  if (payload.severity) return payload.severity;
  if (eventType?.includes('failed') || eventType === CLIENT_AGENT_EVENT_TYPES.SECURITY_WARNING) return 'critical';
  if (eventType?.includes('warning') || eventType === CLIENT_AGENT_EVENT_TYPES.SCHEMA_MISMATCH) return 'warn';
  return 'info';
}

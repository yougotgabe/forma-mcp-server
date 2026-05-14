export const CANONICAL_ENTITY_TYPES = Object.freeze([
  'business', 'service', 'product', 'offer', 'event', 'staff', 'location',
  'testimonial', 'booking', 'email_flow', 'payment_flow', 'subscription',
  'media_asset', 'brand_voice',
]);

export function createCanonicalEntity(input = {}) {
  const entity = {
    entity_type: input.entity_type || inferEntityType(input),
    source: input.source || input.provider || 'manual',
    source_id: input.source_id || input.external_id || input.id || null,
    title: input.title || input.name || input.label || null,
    status: normalizeStatus(input.status, input.active),
    confidence: clampConfidence(input.confidence ?? 0.8),
    canonical: input.canonical || {},
    raw: input.raw || input,
    updated_at: input.updated_at || new Date().toISOString(),
  };
  if (!CANONICAL_ENTITY_TYPES.includes(entity.entity_type)) entity.entity_type = 'offer';
  return entity;
}

export function inferEntityType(input = {}) {
  if (input.entity_type) return input.entity_type;
  if (input.price_cents || input.price || input.variants) return 'product';
  if (input.starts_at || input.ends_at || input.event_date) return 'event';
  if (input.quote || input.rating) return 'testimonial';
  if (input.email || input.phone || input.address) return 'business';
  return 'service';
}

function normalizeStatus(status, active) {
  if (typeof active === 'boolean') return active ? 'active' : 'inactive';
  if (!status) return 'active';
  const s = String(status).toLowerCase();
  if (['published', 'visible', 'enabled'].includes(s)) return 'active';
  if (['draft', 'archived', 'disabled', 'hidden'].includes(s)) return s;
  return s;
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.8;
  return Math.max(0, Math.min(1, n));
}

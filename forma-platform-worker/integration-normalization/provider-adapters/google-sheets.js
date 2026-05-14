import { createCanonicalEntity } from '../../../shared/canonical-entities/schema.js';

export function normalizeGoogleSheetsRow(row = {}, entityType = null) {
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [String(k).toLowerCase().trim().replace(/\s+/g, '_'), v]));
  return createCanonicalEntity({
    entity_type: entityType || inferSheetEntity(lower),
    source: 'google_sheets',
    source_id: lower.id || lower.slug || lower.name || lower.title || null,
    title: lower.title || lower.name || lower.service || lower.product || null,
    status: lower.status || (String(lower.active || '').toLowerCase() === 'false' ? 'inactive' : 'active'),
    confidence: 0.88,
    canonical: {
      description: lower.description || lower.details || null,
      price_label: lower.price || lower.price_label || null,
      sort_order: Number(lower.sort_order || lower.order || 100),
    },
    raw: row,
  });
}

function inferSheetEntity(row) {
  if (row.event_date || row.starts_at) return 'event';
  if (row.price || row.sku || row.product) return 'product';
  if (row.quote || row.rating) return 'testimonial';
  return 'service';
}

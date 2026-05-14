import { createCanonicalEntity } from '../../shared/canonical-entities/schema.js';
import { normalizePrintifyProduct } from './provider-adapters/printify.js';
import { normalizeGoogleSheetsRow } from './provider-adapters/google-sheets.js';

export async function handleNormalizeIntegrationEntity(body = {}, env = {}, deps = {}) {
  const provider = body.provider || body.source || 'manual';
  const rows = Array.isArray(body.items) ? body.items : [body.item || body.raw || body];
  const entities = rows.map((row) => normalizeByProvider(provider, row, body.entity_type));

  if (body.persist === true && deps.supabase) {
    await persistCanonicalEntities(entities, body, env, deps.supabase);
  }

  return { ok: true, provider, count: entities.length, entities };
}

function normalizeByProvider(provider, row, entityType) {
  if (provider === 'printify') return normalizePrintifyProduct(row);
  if (provider === 'google_sheets' || provider === 'sheets') return normalizeGoogleSheetsRow(row, entityType);
  return createCanonicalEntity({ ...row, source: provider, entity_type: entityType });
}

async function persistCanonicalEntities(entities, body, env, supabase) {
  const client_slug = body.client_slug || body.slug;
  const rows = entities.map((entity) => ({
    client_slug,
    entity_type: entity.entity_type,
    source: entity.source,
    source_id: entity.source_id,
    title: entity.title,
    status: entity.status,
    confidence: entity.confidence,
    canonical: entity.canonical,
    raw: entity.raw,
    updated_at: entity.updated_at,
  }));
  await supabase(env, 'POST', '/rest/v1/canonical_entities', rows, { Prefer: 'resolution=merge-duplicates,return=minimal' });
}

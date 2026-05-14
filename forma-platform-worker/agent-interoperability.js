// =============================================================================
// FORMAUT AGENT INTEROPERABILITY
// forma-platform-worker/agent-interoperability.js
//
// Implements the Agent Import/Export pipeline described in the May 2026 handoff.
//
// Import pipeline:
//   POST /agent-import/validate  — schema validation only, no DB write
//   POST /agent-import/stage     — normalize + insert into agent_imports
//   POST /agent-import/commit    — apply approved import to memory
//   GET  /agent-import/list      — list staged/committed imports for a client
//
// Export pipeline:
//   POST /agent-export/:type     — generate a typed context package
//     types: design | seo | email | commerce | implementation
//
// All routes are capability-gated before reaching here (see index.js).
// This module is deterministic — no LLM calls. Reasoning happened upstream.
// =============================================================================

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function ok(data)  { return new Response(JSON.stringify({ ok: true,  ...data }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
function err(msg, status = 400) { return new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: { 'Content-Type': 'application/json' } }); }

async function sb(env, method, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey:         env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      ...(method === 'POST' || method === 'PATCH' ? { Prefer: 'return=representation' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function sbRows(env, path) {
  const res = await sb(env, 'GET', path);
  if (!res.ok) return [];
  return res.json();
}

// ---------------------------------------------------------------------------
// VALIDATION SCHEMA
// ---------------------------------------------------------------------------
// Required fields for any agent import package.

const REQUIRED_FIELDS   = ['source_agent', 'business_slug', 'payload_type', 'payload'];
const ALLOWED_PAYLOAD_TYPES = new Set([
  'brand_strategy', 'design', 'seo', 'email', 'commerce', 'implementation', 'mixed',
]);
const ALLOWED_ACTIONS = new Set([
  'validate_only', 'stage_for_review', 'auto_merge',
]);

/**
 * Validate a raw agent import package.
 * Returns { valid: bool, errors: string[], warnings: string[], normalized: Object|null }
 */
function validateAgentPackage(raw) {
  const errors   = [];
  const warnings = [];

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (raw[field] === undefined || raw[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (errors.length) return { valid: false, errors, warnings, normalized: null };

  // Type checks
  if (!ALLOWED_PAYLOAD_TYPES.has(raw.payload_type)) {
    errors.push(`Unknown payload_type: '${raw.payload_type}'. Allowed: ${[...ALLOWED_PAYLOAD_TYPES].join(', ')}`);
  }
  if (raw.requested_action && !ALLOWED_ACTIONS.has(raw.requested_action)) {
    errors.push(`Unknown requested_action: '${raw.requested_action}'. Allowed: ${[...ALLOWED_ACTIONS].join(', ')}`);
  }
  if (raw.confidence !== undefined) {
    const c = Number(raw.confidence);
    if (isNaN(c) || c < 0 || c > 1) {
      errors.push(`confidence must be a number between 0 and 1, got: ${raw.confidence}`);
    }
  }
  if (typeof raw.payload !== 'object' || Array.isArray(raw.payload)) {
    errors.push(`payload must be a JSON object`);
  }
  if (raw.payload && JSON.stringify(raw.payload).length > 256_000) {
    errors.push(`payload exceeds maximum size (256 KB)`);
  }

  // Warnings
  if (!raw.confidence) warnings.push('No confidence score provided — defaulting to 0.5');
  if (!raw.source_context) warnings.push('No source_context provided — provenance may be unclear');
  if (!raw.evidence || !raw.evidence.length) warnings.push('No evidence array — claims will be treated as unverified');

  if (errors.length) return { valid: false, errors, warnings, normalized: null };

  // Normalized shape
  const normalized = {
    source_agent:     String(raw.source_agent).toLowerCase(),
    source_context:   raw.source_context  || null,
    source_version:   raw.source_agent_version || null,
    payload_type:     raw.payload_type,
    confidence:       raw.confidence != null ? Number(raw.confidence) : 0.5,
    requested_action: raw.requested_action || 'stage_for_review',
    raw_payload:      raw.payload,
    evidence:         raw.evidence || [],
  };

  return { valid: true, errors: [], warnings, normalized };
}

// ---------------------------------------------------------------------------
// RISK CLASSIFICATION
// ---------------------------------------------------------------------------

function classifyRisk(payloadType, confidence) {
  // High risk: anything that touches implementation or has low confidence
  if (payloadType === 'implementation') return 'high';
  if (payloadType === 'commerce')       return 'high';
  if (confidence < 0.5)                 return 'high';
  if (confidence < 0.75)                return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// HANDLER: /agent-import/validate
// ---------------------------------------------------------------------------

export async function handleAgentImportValidate(body, env) {
  const { package: pkg, ...rest } = body;
  const raw = pkg || rest;

  if (!raw || typeof raw !== 'object') {
    return err('Request body must contain a package object');
  }

  const result = validateAgentPackage(raw);
  return ok({
    valid:     result.valid,
    errors:    result.errors,
    warnings:  result.warnings,
    risk_level: result.normalized
      ? classifyRisk(result.normalized.payload_type, result.normalized.confidence)
      : null,
  });
}

// ---------------------------------------------------------------------------
// HANDLER: /agent-import/stage
// ---------------------------------------------------------------------------

export async function handleAgentImportStage(body, env) {
  const { package: pkg, client_slug, slug, ...rest } = body;
  const raw         = pkg || rest.payload_package || rest;
  const clientSlug  = client_slug || slug;

  if (!clientSlug) return err('client_slug is required');
  if (!raw || typeof raw !== 'object') return err('package is required');

  // Force business_slug from URL-level client_slug if not in package
  if (!raw.business_slug) raw.business_slug = clientSlug;

  const result = validateAgentPackage(raw);
  if (!result.valid) {
    return ok({
      staged:   false,
      errors:   result.errors,
      warnings: result.warnings,
    });
  }

  const { normalized } = result;
  const riskLevel = classifyRisk(normalized.payload_type, normalized.confidence);

  // Compute payload hash for dedup
  const payloadStr  = JSON.stringify(normalized.raw_payload);
  const payloadSize = new TextEncoder().encode(payloadStr).length;
  const hashBuffer  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payloadStr));
  const payloadHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Check for duplicate (same hash + client)
  const dupes = await sbRows(env,
    `/rest/v1/agent_imports?client_slug=eq.${encodeURIComponent(clientSlug)}&payload_hash=eq.${payloadHash}&status=not.in.(rejected,committed)&select=id,status&limit=1`
  );
  if (dupes.length) {
    return ok({
      staged:     false,
      duplicate:  true,
      import_id:  dupes[0].id,
      status:     dupes[0].status,
      message:    'An identical package is already staged or pending for this client.',
    });
  }

  // Determine initial status
  const isAutoMerge   = normalized.requested_action === 'auto_merge' && riskLevel === 'low';
  const initialStatus = isAutoMerge ? 'approved' : 'staged';

  // Insert into agent_imports
  const insertRes = await sb(env, 'POST', '/rest/v1/agent_imports', {
    client_slug:        clientSlug,
    source_agent:       normalized.source_agent,
    source_context:     normalized.source_context,
    source_version:     normalized.source_version,
    payload_type:       normalized.payload_type,
    payload_hash:       payloadHash,
    payload_size_bytes: payloadSize,
    confidence:         normalized.confidence,
    risk_level:         riskLevel,
    status:             initialStatus,
    requested_action:   normalized.requested_action,
    auto_merged:        isAutoMerge,
    raw_payload:        normalized.raw_payload,
    normalized_fields:  normalized,
  });

  if (!insertRes.ok) {
    const detail = await insertRes.text();
    console.error('[agent-import/stage] DB insert failed:', detail);
    return err('Failed to stage import', 500);
  }

  const rows     = await insertRes.json();
  const importId = rows[0]?.id;

  // Write staging event
  if (importId) {
    await sb(env, 'POST', '/rest/v1/agent_import_events', {
      import_id:   importId,
      client_slug: clientSlug,
      event_type:  isAutoMerge ? 'auto_merged' : 'staged',
      detail: {
        risk_level:  riskLevel,
        confidence:  normalized.confidence,
        payload_type: normalized.payload_type,
        warnings:    result.warnings,
      },
      created_by: 'system',
    });
  }

  return ok({
    staged:    true,
    import_id: importId,
    status:    initialStatus,
    risk_level: riskLevel,
    auto_merged: isAutoMerge,
    warnings:  result.warnings,
    next_step: isAutoMerge
      ? 'Low-risk package auto-merged. Call /agent-import/commit to apply to memory.'
      : 'Package staged for review. An operator or client must approve before committing.',
  });
}

// ---------------------------------------------------------------------------
// MEMORY ROUTING
// ---------------------------------------------------------------------------
// Maps payload_type → memory destination(s).
//
// client_memory schema:  { client_id, category, key, value_json, confidence }
// memory_events schema:  { client_id, event_type, category, key, old_value, new_value, reason }
// signals schema:        { client_slug, type, summary, detail, confidence, status, suggested_by }
// style_signals schema:  { client_slug, tone, color_preference, typography_feel,
//                          layout_preference, density, notable_details, outcome, confidence }
// memory_conflicts:      { client_slug, conflict_source, source_id, memory_table,
//                          memory_field, existing_value, incoming_value,
//                          existing_confidence, incoming_confidence, severity }
//
// Routing rules:
//   brand_strategy → client_memory category:'brand'
//   design         → client_memory category:'design' + style_signals row
//   seo            → signals (type prefixed 'seo_') + client_memory category:'seo'
//   email          → client_memory category:'email'
//   commerce       → client_memory category:'commerce'
//   implementation → client_memory category:'implementation'
//   mixed          → inspect sub-keys, route each to correct destination

// ---------------------------------------------------------------------------
// Look up client UUID from slug (needed for client_memory / memory_events)
// ---------------------------------------------------------------------------
async function resolveClientId(env, clientSlug) {
  const rows = await sbRows(env,
    `/rest/v1/clients?slug=eq.${encodeURIComponent(clientSlug)}&select=id&limit=1`
  );
  return rows[0]?.id || null;
}

// ---------------------------------------------------------------------------
// Upsert a single client_memory field with contradiction detection.
// Returns { written: bool, conflict: bool, conflict_id: uuid|null }
// ---------------------------------------------------------------------------
async function upsertMemoryField(env, {
  clientId, clientSlug, importId,
  category, key, newValue, incomingConfidence,
}) {
  // Load existing row
  const existing = await sbRows(env,
    `/rest/v1/client_memory?client_id=eq.${clientId}&category=eq.${encodeURIComponent(category)}&key=eq.${encodeURIComponent(key)}&select=id,value_json,confidence&limit=1`
  );

  const existingRow = existing[0] || null;

  // Contradiction check: existing value is different AND existing confidence >= incoming
  if (existingRow) {
    const existingVal = JSON.stringify(existingRow.value_json);
    const incomingVal = JSON.stringify(newValue);
    const existingConf = Number(existingRow.confidence ?? 0.7);

    if (existingVal !== incomingVal && existingConf >= incomingConfidence) {
      // Flag conflict — do NOT overwrite
      const conflictRes = await sb(env, 'POST', '/rest/v1/memory_conflicts', {
        client_slug:         clientSlug,
        conflict_source:     'agent_import',
        source_id:           importId,
        memory_table:        'client_memory',
        memory_field:        `${category}.${key}`,
        existing_value:      existingRow.value_json,
        incoming_value:      newValue,
        existing_confidence: existingConf,
        incoming_confidence: incomingConfidence,
        severity:            existingConf - incomingConfidence > 0.3 ? 'high' : 'medium',
        status:              'open',
      });
      const conflictRows = await conflictRes.json();
      return { written: false, conflict: true, conflict_id: conflictRows[0]?.id || null };
    }
  }

  // Write / overwrite
  const oldValue = existingRow?.value_json ?? null;

  if (existingRow) {
    await sb(env, 'PATCH',
      `/rest/v1/client_memory?client_id=eq.${clientId}&category=eq.${encodeURIComponent(category)}&key=eq.${encodeURIComponent(key)}`,
      { value_json: newValue, confidence: incomingConfidence, updated_at: new Date().toISOString() }
    );
  } else {
    await sb(env, 'POST', '/rest/v1/client_memory', {
      client_id:  clientId,
      category,
      key,
      value_json: newValue,
      confidence: incomingConfidence,
    });
  }

  // Memory event
  await sb(env, 'POST', '/rest/v1/memory_events', {
    client_id:  clientId,
    event_type: existingRow ? 'updated' : 'created',
    category,
    key,
    old_value:  oldValue,
    new_value:  newValue,
    reason:     `agent_import:${importId}`,
  });

  return { written: true, conflict: false, conflict_id: null };
}

// ---------------------------------------------------------------------------
// Route payload fields into memory based on payload_type
// Returns { written: string[], conflicts: string[], conflict_ids: string[] }
// ---------------------------------------------------------------------------
async function routePayloadToMemory(env, { clientId, clientSlug, importId, payloadType, payload, confidence }) {
  const written      = [];
  const conflicts    = [];
  const conflict_ids = [];

  // Helper: upsert and track
  const upsert = async (category, key, value) => {
    if (value === undefined || value === null) return;
    const result = await upsertMemoryField(env, {
      clientId, clientSlug, importId,
      category, key,
      newValue: typeof value === 'object' ? value : { value },
      incomingConfidence: confidence,
    });
    const fieldKey = `${category}.${key}`;
    if (result.conflict) {
      conflicts.push(fieldKey);
      if (result.conflict_id) conflict_ids.push(result.conflict_id);
    } else if (result.written) {
      written.push(fieldKey);
    }
  };

  // ── brand_strategy ────────────────────────────────────────────────────────
  if (payloadType === 'brand_strategy' || payloadType === 'mixed') {
    const b = payloadType === 'mixed' ? (payload.brand || {}) : payload;
    await upsert('brand', 'brand_voice',        b.brand_voice);
    await upsert('brand', 'tone',               b.tone);
    await upsert('brand', 'audience',           b.audience);
    await upsert('brand', 'value_proposition',  b.value_proposition);
    await upsert('brand', 'tagline',            b.tagline);
    await upsert('brand', 'homepage_strategy',  b.homepage_strategy);
    await upsert('brand', 'implementation_notes', b.implementation_notes);
    // Any extra keys in the payload
    for (const [k, v] of Object.entries(b)) {
      if (!['brand_voice','tone','audience','value_proposition','tagline','homepage_strategy','implementation_notes'].includes(k)) {
        await upsert('brand', k, v);
      }
    }
  }

  // ── design ────────────────────────────────────────────────────────────────
  if (payloadType === 'design' || payloadType === 'mixed') {
    const d = payloadType === 'mixed' ? (payload.design || {}) : payload;
    await upsert('design', 'visual_style',       d.visual_style);
    await upsert('design', 'color_palette',      d.color_palette);
    await upsert('design', 'typography',         d.typography);
    await upsert('design', 'layout_preferences', d.layout_preferences);
    await upsert('design', 'conversion_goals',   d.conversion_goals);
    await upsert('design', 'density',            d.density);

    // Also write a style_signals row if enough design fields present
    const hasDesignSignals = d.tone || d.color_preference || d.typography_feel || d.layout_preference;
    if (hasDesignSignals) {
      await sb(env, 'POST', '/rest/v1/style_signals', {
        client_slug:       clientSlug,
        session_date:      new Date().toISOString().split('T')[0],
        tone:              d.tone              || null,
        color_preference:  d.color_preference  || d.color_palette || null,
        typography_feel:   d.typography_feel   || d.typography    || null,
        layout_preference: d.layout_preference || d.layout_preferences || null,
        density:           d.density           || null,
        notable_details:   d.notable_details   || null,
        outcome:           `agent_import:${importId}`,
        confidence:        String(confidence),
        status:            'active',
      });
      written.push('style_signals:row');
    }

    // Remaining extra keys
    const knownDesignKeys = ['visual_style','color_palette','typography','layout_preferences','conversion_goals','density','tone','color_preference','typography_feel','layout_preference','notable_details'];
    for (const [k, v] of Object.entries(d)) {
      if (!knownDesignKeys.includes(k)) await upsert('design', k, v);
    }
  }

  // ── seo ───────────────────────────────────────────────────────────────────
  if (payloadType === 'seo' || payloadType === 'mixed') {
    const s = payloadType === 'mixed' ? (payload.seo || {}) : payload;

    // Core SEO facts go to client_memory
    await upsert('seo', 'keywords',         s.keywords);
    await upsert('seo', 'content_gaps',     s.content_gaps);
    await upsert('seo', 'competitor_notes', s.competitor_notes);
    await upsert('seo', 'locations',        s.locations);
    await upsert('seo', 'services',         s.services);

    // Signals for actionable SEO items
    const seoSignalFields = [
      { field: 'keyword_opportunities', type: 'seo_keywords'  },
      { field: 'missing_pages',         type: 'seo_gap'       },
      { field: 'meta_issues',           type: 'seo_metadata'  },
      { field: 'recommendations',       type: 'seo_recommendation' },
    ];
    for (const { field, type } of seoSignalFields) {
      if (!s[field]) continue;
      const items = Array.isArray(s[field]) ? s[field] : [s[field]];
      for (const item of items) {
        await sb(env, 'POST', '/rest/v1/signals', {
          client_slug:  clientSlug,
          type,
          summary:      typeof item === 'string' ? item : (item.summary || JSON.stringify(item)),
          detail:       typeof item === 'object' ? JSON.stringify(item) : null,
          confidence:   String(confidence),
          status:       'pending',
          suggested_by: `agent_import:${importId}`,
        });
        written.push(`signals:${type}`);
      }
    }
  }

  // ── email ─────────────────────────────────────────────────────────────────
  if (payloadType === 'email' || payloadType === 'mixed') {
    const e = payloadType === 'mixed' ? (payload.email || {}) : payload;
    await upsert('email', 'tone',             e.tone);
    await upsert('email', 'customer_types',   e.customer_types);
    await upsert('email', 'offers',           e.offers);
    await upsert('email', 'lifecycle_events', e.lifecycle_events);
    await upsert('email', 'campaign_notes',   e.campaign_notes);
    for (const [k, v] of Object.entries(e)) {
      if (!['tone','customer_types','offers','lifecycle_events','campaign_notes'].includes(k)) {
        await upsert('email', k, v);
      }
    }
  }

  // ── commerce ──────────────────────────────────────────────────────────────
  if (payloadType === 'commerce' || payloadType === 'mixed') {
    const c = payloadType === 'mixed' ? (payload.commerce || {}) : payload;
    await upsert('commerce', 'fulfillment_rules', c.fulfillment_rules);
    await upsert('commerce', 'pricing_logic',     c.pricing_logic);
    await upsert('commerce', 'inventory_notes',   c.inventory_notes);
    await upsert('commerce', 'product_strategy',  c.product_strategy);
    for (const [k, v] of Object.entries(c)) {
      if (!['fulfillment_rules','pricing_logic','inventory_notes','product_strategy','products'].includes(k)) {
        await upsert('commerce', k, v);
      }
    }
  }

  // ── implementation ────────────────────────────────────────────────────────
  if (payloadType === 'implementation' || payloadType === 'mixed') {
    const i = payloadType === 'mixed' ? (payload.implementation || {}) : payload;
    await upsert('implementation', 'repo_structure',    i.repo_structure);
    await upsert('implementation', 'deployment_notes',  i.deployment_notes);
    await upsert('implementation', 'admin_schema',      i.admin_schema);
    await upsert('implementation', 'approved_patterns', i.approved_patterns);
    for (const [k, v] of Object.entries(i)) {
      if (!['repo_structure','deployment_notes','admin_schema','approved_patterns'].includes(k)) {
        await upsert('implementation', k, v);
      }
    }
  }

  return { written, conflicts, conflict_ids };
}

// ---------------------------------------------------------------------------
// HANDLER: /agent-import/commit
// ---------------------------------------------------------------------------

export async function handleAgentImportCommit(body, env) {
  const { import_id, client_slug, slug, reviewed_by, review_note } = body;
  const clientSlug = client_slug || slug;

  if (!import_id)  return err('import_id is required');
  if (!clientSlug) return err('client_slug is required');

  // Load the import record
  const rows = await sbRows(env,
    `/rest/v1/agent_imports?id=eq.${encodeURIComponent(import_id)}&client_slug=eq.${encodeURIComponent(clientSlug)}&select=*&limit=1`
  );
  if (!rows.length) return err('Import not found', 404);
  const imp = rows[0];

  if (!['staged', 'approved', 'auto_merged'].includes(imp.status)) {
    return err(`Cannot commit import with status '${imp.status}'. Must be staged or approved.`);
  }
  if (imp.risk_level === 'high' && imp.status !== 'approved') {
    return err('High-risk imports require explicit approval before commit. Set status to approved first.');
  }

  // Resolve client UUID — required for client_memory / memory_events
  const clientId = await resolveClientId(env, clientSlug);
  if (!clientId) return err(`Client not found: ${clientSlug}`, 404);

  // Route payload into memory tables
  const payload    = imp.raw_payload || {};
  const confidence = Number(imp.confidence ?? 0.5);

  let routingResult;
  try {
    routingResult = await routePayloadToMemory(env, {
      clientId,
      clientSlug,
      importId:    import_id,
      payloadType: imp.payload_type,
      payload,
      confidence,
    });
  } catch (routeErr) {
    console.error('[agent-import/commit] Memory routing error:', routeErr);
    return err(`Memory routing failed: ${routeErr.message}`, 500);
  }

  const { written, conflicts, conflict_ids } = routingResult;
  const hadConflicts = conflicts.length > 0;

  // Mark committed (or conflict_flagged if conflicts prevent full commit)
  const finalStatus = hadConflicts && written.length === 0 ? 'contradiction_flagged' : 'committed';

  await sb(env, 'PATCH',
    `/rest/v1/agent_imports?id=eq.${encodeURIComponent(import_id)}`,
    {
      status:          finalStatus,
      reviewed_by:     reviewed_by || 'system',
      reviewed_at:     new Date().toISOString(),
      review_note:     review_note || null,
      memory_event_ids: conflict_ids.length ? conflict_ids : null,
    }
  );

  // Commit event
  await sb(env, 'POST', '/rest/v1/agent_import_events', {
    import_id:   import_id,
    client_slug: clientSlug,
    event_type:  'committed',
    detail: {
      reviewed_by,
      payload_type:  imp.payload_type,
      fields_written: written,
      fields_conflicted: conflicts,
      conflict_ids,
    },
    created_by: reviewed_by || 'system',
  });

  // Conflict events — one per flagged field
  for (const field of conflicts) {
    await sb(env, 'POST', '/rest/v1/agent_import_events', {
      import_id:   import_id,
      client_slug: clientSlug,
      event_type:  'contradiction_detected',
      detail:      { field, reason: 'Existing memory has equal or higher confidence' },
      created_by:  'system',
    });
  }

  return ok({
    committed:         true,
    import_id,
    status:            finalStatus,
    fields_written:    written,
    fields_conflicted: conflicts,
    conflict_ids,
    summary: hadConflicts
      ? `${written.length} field(s) written, ${conflicts.length} conflict(s) flagged for review in memory_conflicts.`
      : `${written.length} field(s) written to memory.`,
  });
}

// ---------------------------------------------------------------------------
// HANDLER: /agent-import/list
// ---------------------------------------------------------------------------

export async function handleAgentImportList(body, env) {
  const { client_slug, slug, status, limit = 20 } = body;
  const clientSlug = client_slug || slug;

  if (!clientSlug) return err('client_slug is required');

  const safeLimit  = Math.min(Number(limit) || 20, 100);
  const statusFilter = status ? `&status=eq.${encodeURIComponent(status)}` : '';

  const rows = await sbRows(env,
    `/rest/v1/agent_imports?client_slug=eq.${encodeURIComponent(clientSlug)}${statusFilter}&select=id,source_agent,source_context,payload_type,confidence,risk_level,status,requested_action,auto_merged,reviewed_by,reviewed_at,created_at,updated_at&order=created_at.desc&limit=${safeLimit}`
  );

  return ok({ imports: rows, count: rows.length });
}

// ---------------------------------------------------------------------------
// HANDLER: /agent-export/:type
// ---------------------------------------------------------------------------

/**
 * Generate a typed context package for an external agent.
 * Reads from platform Supabase (business_profile_memory, signals, etc.)
 * and assembles a structured, agent-optimized export.
 *
 * @param {Object} body       - { client_slug, include_fields? }
 * @param {Object} env
 * @param {string} packageType - 'design' | 'seo' | 'email' | 'commerce' | 'implementation'
 */
export async function handleAgentExport(body, env, packageType) {
  const { client_slug, slug } = body;
  const clientSlug = client_slug || slug;

  if (!clientSlug) return err('client_slug is required');

  const validTypes = new Set(['design', 'seo', 'email', 'commerce', 'implementation']);
  if (!validTypes.has(packageType)) {
    return err(`Unknown export package type: '${packageType}'. Allowed: ${[...validTypes].join(', ')}`);
  }

  // Load client_memory — the actual durable memory store.
  // Indexed as memory[category][key] for fast field access.
  const clientRow = await sbRows(env,
    `/rest/v1/clients?slug=eq.${encodeURIComponent(clientSlug)}&select=id&limit=1`
  );
  const clientId = clientRow[0]?.id;

  const memory = {};
  if (clientId) {
    const memRows = await sbRows(env,
      `/rest/v1/client_memory?client_id=eq.${clientId}&select=category,key,value_json,confidence,updated_at`
    );
    for (const row of memRows) {
      if (!memory[row.category]) memory[row.category] = {};
      memory[row.category][row.key] = {
        value:      row.value_json,
        confidence: row.confidence,
        updated_at: row.updated_at,
      };
    }
  }

  // Convenience getter — unwraps stored value or returns null
  const mem = (category, key) => {
    const entry = memory[category]?.[key];
    if (!entry) return null;
    // If stored as { value: ... } wrapper, unwrap it; otherwise return raw
    return (entry.value && typeof entry.value === 'object' && 'value' in entry.value)
      ? entry.value.value
      : entry.value;
  };

  let packagePayload = {};

  switch (packageType) {
    case 'design': {
      // Load style signals
      const signals = await sbRows(env,
        `/rest/v1/style_signals?client_slug=eq.${encodeURIComponent(clientSlug)}&select=*&order=session_date.desc&limit=20`
      );
      packagePayload = {
        brand_voice:        mem('brand',  'brand_voice'),
        visual_style:       mem('design', 'visual_style'),
        color_palette:      mem('design', 'color_palette'),
        typography:         mem('design', 'typography'),
        layout_preferences: mem('design', 'layout_preferences'),
        audience:           mem('brand',  'audience'),
        conversion_goals:   mem('design', 'conversion_goals'),
        design_signals:     signals.slice(0, 10),
      };
      break;
    }

    case 'seo': {
      const signals = await sbRows(env,
        `/rest/v1/signals?client_slug=eq.${encodeURIComponent(clientSlug)}&type=like.seo_*&status=eq.pending&select=*&order=created_at.desc&limit=30`
      );
      packagePayload = {
        services:         mem('seo',   'services'),
        locations:        mem('seo',   'locations'),
        keywords:         mem('seo',   'keywords'),
        content_gaps:     mem('seo',   'content_gaps'),
        competitor_notes: mem('seo',   'competitor_notes'),
        seo_signals:      signals,
      };
      break;
    }

    case 'email': {
      packagePayload = {
        brand_voice:      mem('brand', 'brand_voice'),
        tone:             mem('email', 'tone'),
        customer_types:   mem('email', 'customer_types'),
        offers:           mem('email', 'offers'),
        lifecycle_events: mem('email', 'lifecycle_events'),
        campaign_notes:   mem('email', 'campaign_notes'),
      };
      break;
    }

    case 'commerce': {
      const products = await sbRows(env,
        `/rest/v1/commerce_products?client_slug=eq.${encodeURIComponent(clientSlug)}&select=*&order=created_at.desc&limit=50`
      );
      packagePayload = {
        products,
        fulfillment_rules: mem('commerce', 'fulfillment_rules'),
        pricing_logic:     mem('commerce', 'pricing_logic'),
        inventory_notes:   mem('commerce', 'inventory_notes'),
        product_strategy:  mem('commerce', 'product_strategy'),
      };
      break;
    }

    case 'implementation': {
      const artifacts = await sbRows(env,
        `/rest/v1/job_artifacts?client_slug=eq.${encodeURIComponent(clientSlug)}&select=artifact_type,title,summary,created_at&order=created_at.desc&limit=20`
      );
      packagePayload = {
        repo_structure:    mem('implementation', 'repo_structure'),
        deployment_notes:  mem('implementation', 'deployment_notes'),
        admin_schema:      mem('implementation', 'admin_schema'),
        approved_patterns: mem('implementation', 'approved_patterns'),
        recent_artifacts:  artifacts,
      };
      break;
    }
  }

  // Log the export
  await sb(env, 'POST', '/rest/v1/agent_export_logs', {
    client_slug:     clientSlug,
    package_type:    packageType,
    requested_by:    body.email || 'system',
    fields_included: Object.keys(packagePayload),
    record_count:    packagePayload.products?.length ?? packagePayload.design_signals?.length ?? packagePayload.seo_signals?.length ?? null,
  });

  return ok({
    package_type:   packageType,
    client_slug:    clientSlug,
    generated_at:   new Date().toISOString(),
    schema_version: '1.0',
    payload:        packagePayload,
    usage_note:     `This package was generated for agent consumption. Fields reflect durable Formaut memory as of generation time. Import any results back using /agent-import/validate → /stage → /commit.`,
  });
}

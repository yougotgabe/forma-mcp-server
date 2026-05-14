// =============================================================================
// FORMAUT ARTIFACT VERSIONING + REVIEW + PUBLISH PIPELINE
// =============================================================================
// generated artifact -> immutable version -> diff against live -> review decision
// -> publish transaction -> deployment lineage -> rollback support
//
// This module deliberately stores artifacts as immutable database rows first. A
// later deploy adapter can consume an approved/published version and write it to
// GitHub, Cloudflare Pages, object storage, or a client Supabase table.
// =============================================================================

import { markArtifactGenerated } from './formaut-artifact-dependency-engine.js';

const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_BATCH_BUDGET_CENTS = 50;

export async function createArtifactVersion(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const input = normalizeArtifactVersionInput(body);

  const currentLive = await getCurrentLiveVersion(supabase, env, input);
  const versionNumber = await nextVersionNumber(supabase, env, input);
  const contentHash = await sha256Json(input.content);
  const diff = buildJsonDiff(currentLive?.content || null, input.content);
  const status = input.requires_review ? 'pending_review' : 'approved';

  const row = {
    client_id: input.client_id,
    client_slug: input.client_slug,
    environment: input.environment,
    artifact_type: input.artifact_type,
    artifact_key: input.artifact_key,
    version_number: versionNumber,
    content_hash: contentHash,
    content: input.content,
    metadata: input.metadata,
    source_job_id: input.source_job_id,
    parent_version_id: currentLive?.id || input.parent_version_id || null,
    base_live_version_id: currentLive?.id || null,
    diff_summary: diff.summary,
    diff_json: diff,
    status,
    requires_review: input.requires_review,
    created_by: input.created_by,
  };

  const createdRes = await supabase(env, 'POST', '/rest/v1/artifact_versions', row, { Prefer: 'return=representation' });
  if (!createdRes.ok) throw new Error(`Failed to create artifact version: ${await safeText(createdRes)}`);
  const version = (await createdRes.json())[0];

  const generated = await markArtifactGenerated({
    client_id: input.client_id,
    client_slug: input.client_slug,
    artifact_type: input.artifact_type,
    artifact_key: input.artifact_key,
    job_id: input.source_job_id,
    parent_event_id: input.parent_lineage_event_id,
    requires_review_before_publish: input.requires_review,
    event_source: input.event_source || 'artifact_pipeline',
    change_summary: input.change_summary || `${input.artifact_type} v${versionNumber} generated and staged.`,
    payload: {
      artifact_version_id: version.id,
      version_number: versionNumber,
      content_hash: contentHash,
      diff_summary: diff.summary,
      metadata: input.metadata,
    },
  }, env, deps);

  const review = input.requires_review
    ? await createReviewRequest(supabase, env, {
        client_id: input.client_id,
        client_slug: input.client_slug,
        artifact_version_id: version.id,
        artifact_type: input.artifact_type,
        requested_by: input.created_by,
        review_reason: input.review_reason || 'New generated artifact requires approval before publish.',
      })
    : null;

  return {
    ok: true,
    artifact_version: version,
    review_request: review,
    diff,
    deployment_state: generated.deployment_state,
    lineage_event: generated.lineage_event,
  };
}

export async function listArtifactVersions(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const filter = clientQueryFilter(body);
  if (!filter) throw new Error('client_id or client_slug/slug is required');
  const artifactFilter = body.artifact_type ? `&artifact_type=eq.${encodeURIComponent(body.artifact_type)}` : '';
  const statusFilter = body.status ? `&status=eq.${encodeURIComponent(body.status)}` : '';
  const limit = clampInt(body.limit || 25, 1, 200);
  const res = await supabase(env, 'GET', `/rest/v1/artifact_versions?select=*&${filter}${artifactFilter}${statusFilter}&order=created_at.desc&limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to list artifact versions: ${await safeText(res)}`);
  return { ok: true, artifact_versions: await res.json() };
}

export async function listReviewQueue(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const filter = clientQueryFilter(body);
  const clientPart = filter ? `&${filter}` : '';
  const status = body.status || 'pending';
  const limit = clampInt(body.limit || 50, 1, 200);
  const res = await supabase(env, 'GET', `/rest/v1/artifact_reviews?select=*,artifact_versions(artifact_type,artifact_key,version_number,diff_summary,metadata,created_at)&status=eq.${encodeURIComponent(status)}${clientPart}&order=created_at.asc&limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to list review queue: ${await safeText(res)}`);
  return { ok: true, reviews: await res.json() };
}

export async function reviewArtifactVersion(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const versionId = body.artifact_version_id || body.version_id || body.id;
  const decision = normalizeDecision(body.decision || body.action);
  if (!versionId) throw new Error('artifact_version_id is required');

  const version = await loadArtifactVersion(supabase, env, versionId);
  const actor = body.reviewed_by || body.actor || 'operator';
  const now = new Date().toISOString();

  const versionStatus = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'superseded';
  const patchRes = await supabase(env, 'PATCH', `/rest/v1/artifact_versions?id=eq.${encodeURIComponent(versionId)}`, {
    status: versionStatus,
    reviewed_at: now,
    reviewed_by: actor,
    review_notes: body.notes || body.reason || null,
  }, { Prefer: 'return=representation' });
  if (!patchRes.ok) throw new Error(`Failed to update artifact version review status: ${await safeText(patchRes)}`);

  const reviewRes = await supabase(env, 'PATCH', `/rest/v1/artifact_reviews?artifact_version_id=eq.${encodeURIComponent(versionId)}&status=eq.pending`, {
    status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested',
    reviewed_at: now,
    reviewed_by: actor,
    decision_reason: body.notes || body.reason || null,
  }, { Prefer: 'return=representation' });
  if (!reviewRes.ok) throw new Error(`Failed to update artifact review request: ${await safeText(reviewRes)}`);

  await recordLineageEvent(supabase, env, {
    client_id: version.client_id,
    client_slug: version.client_slug,
    artifact_type: version.artifact_type,
    artifact_key: version.artifact_key,
    event_type: decision === 'approve' ? 'review_approved' : decision === 'reject' ? 'review_rejected' : 'review_changes_requested',
    event_source: 'artifact_review_pipeline',
    change_summary: body.notes || `${version.artifact_type} v${version.version_number} ${decision}d.`,
    payload: { artifact_version_id: versionId, reviewed_by: actor },
  });

  if (decision === 'approve' && body.publish === true) {
    const publish = await publishArtifactVersion({ artifact_version_id: versionId, actor, reason: body.reason }, env, deps);
    return { ok: true, decision, artifact_version: (await patchRes.json())[0], publish };
  }

  return { ok: true, decision, artifact_version: (await patchRes.json())[0], reviews: await reviewRes.json() };
}

export async function publishArtifactVersion(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const versionId = body.artifact_version_id || body.version_id || body.id;
  if (!versionId) throw new Error('artifact_version_id is required');
  const version = await loadArtifactVersion(supabase, env, versionId);
  if (!['approved', 'published'].includes(version.status)) {
    throw new Error(`Artifact version must be approved before publish. Current status: ${version.status}`);
  }

  const actor = body.published_by || body.actor || 'operator';
  const txPayload = {
    client_id: version.client_id,
    client_slug: version.client_slug,
    environment: version.environment || DEFAULT_ENVIRONMENT,
    artifact_type: version.artifact_type,
    artifact_key: version.artifact_key,
    artifact_version_id: version.id,
    previous_live_version_id: await findCurrentLiveVersionId(supabase, env, version),
    status: 'publishing',
    publish_reason: body.reason || 'Approved artifact version published.',
    actor,
    deployment_adapter: body.deployment_adapter || 'staged_database_publish',
    deployment_payload: body.deployment_payload || {},
  };

  const txRes = await supabase(env, 'POST', '/rest/v1/publish_transactions', txPayload, { Prefer: 'return=representation' });
  if (!txRes.ok) throw new Error(`Failed to create publish transaction: ${await safeText(txRes)}`);
  const tx = (await txRes.json())[0];

  try {
    if (txPayload.previous_live_version_id) {
      const oldRes = await supabase(env, 'PATCH', `/rest/v1/artifact_versions?id=eq.${encodeURIComponent(txPayload.previous_live_version_id)}`, {
        is_current_live: false,
        status: 'superseded',
      });
      if (!oldRes.ok) throw new Error(`Failed to supersede previous live version: ${await safeText(oldRes)}`);
    }

    const versionRes = await supabase(env, 'PATCH', `/rest/v1/artifact_versions?id=eq.${encodeURIComponent(version.id)}`, {
      status: 'published',
      is_current_live: true,
      published_at: new Date().toISOString(),
      published_by: actor,
    }, { Prefer: 'return=representation' });
    if (!versionRes.ok) throw new Error(`Failed to mark version published: ${await safeText(versionRes)}`);
    const publishedVersion = (await versionRes.json())[0];

    await upsertDeploymentState(supabase, env, {
      client_id: version.client_id,
      client_slug: version.client_slug,
      environment: version.environment || DEFAULT_ENVIRONMENT,
      artifact_type: version.artifact_type,
      status: 'live',
      current_artifact_version_id: version.id,
      review_required: false,
      publish_blocked: false,
      publish_blocker_reason: null,
    });

    await supabase(env, 'PATCH', `/rest/v1/publish_transactions?id=eq.${encodeURIComponent(tx.id)}`, {
      status: 'succeeded',
      finished_at: new Date().toISOString(),
    });

    await recordLineageEvent(supabase, env, {
      client_id: version.client_id,
      client_slug: version.client_slug,
      artifact_type: version.artifact_type,
      artifact_key: version.artifact_key,
      event_type: 'published',
      event_source: 'artifact_publish_pipeline',
      change_summary: body.reason || `${version.artifact_type} v${version.version_number} published.`,
      payload: { artifact_version_id: version.id, publish_transaction_id: tx.id, previous_live_version_id: txPayload.previous_live_version_id },
    });

    return { ok: true, publish_transaction: { ...tx, status: 'succeeded' }, artifact_version: publishedVersion };
  } catch (err) {
    await supabase(env, 'PATCH', `/rest/v1/publish_transactions?id=eq.${encodeURIComponent(tx.id)}`, {
      status: 'failed',
      error: serializeError(err),
      finished_at: new Date().toISOString(),
    }).catch(() => null);
    throw err;
  }
}

export async function rollbackArtifact(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const filter = clientQueryFilter(body);
  const artifactType = body.artifact_type;
  if (!filter || !artifactType) throw new Error('client_id/client_slug and artifact_type are required');

  let target = null;
  if (body.target_version_id || body.artifact_version_id) {
    target = await loadArtifactVersion(supabase, env, body.target_version_id || body.artifact_version_id);
  } else {
    const res = await supabase(env, 'GET', `/rest/v1/artifact_versions?select=*&${filter}&artifact_type=eq.${encodeURIComponent(artifactType)}&status=in.(superseded,published)&order=published_at.desc.nullslast,version_number.desc&limit=2`);
    if (!res.ok) throw new Error(`Failed to find rollback target: ${await safeText(res)}`);
    const rows = await res.json();
    target = rows.find((r) => !r.is_current_live) || rows[1] || null;
  }
  if (!target) throw new Error('No rollback target found.');

  const approvedTarget = target.status === 'approved' ? target : { ...target, status: 'approved' };
  if (target.status !== 'approved') {
    await supabase(env, 'PATCH', `/rest/v1/artifact_versions?id=eq.${encodeURIComponent(target.id)}`, { status: 'approved' });
  }

  const publish = await publishArtifactVersion({ artifact_version_id: approvedTarget.id, actor: body.actor || 'operator', reason: body.reason || `Rollback to ${artifactType} v${target.version_number}.` }, env, deps);
  await recordLineageEvent(supabase, env, {
    client_id: target.client_id,
    client_slug: target.client_slug,
    artifact_type: target.artifact_type,
    artifact_key: target.artifact_key,
    event_type: 'rollback',
    event_source: 'artifact_rollback_pipeline',
    change_summary: body.reason || `Rolled back ${artifactType} to v${target.version_number}.`,
    payload: { target_version_id: target.id, publish_transaction_id: publish.publish_transaction.id },
  });
  return { ok: true, rolled_back_to: target, publish };
}

export async function getChangeDashboard(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const filter = clientQueryFilter(body);
  if (!filter) throw new Error('client_id or client_slug/slug is required');
  const limit = clampInt(body.limit || 25, 1, 100);
  const [stateRes, versionsRes, reviewsRes, lineageRes, txRes] = await Promise.all([
    supabase(env, 'GET', `/rest/v1/deployment_state?select=*&${filter}&order=updated_at.desc`),
    supabase(env, 'GET', `/rest/v1/artifact_versions?select=id,artifact_type,artifact_key,version_number,status,is_current_live,diff_summary,metadata,created_at,published_at&${filter}&order=created_at.desc&limit=${limit}`),
    supabase(env, 'GET', `/rest/v1/artifact_reviews?select=*&${filter}&status=eq.pending&order=created_at.asc&limit=${limit}`),
    supabase(env, 'GET', `/rest/v1/artifact_lineage?select=*&${filter}&order=created_at.desc&limit=${limit}`),
    supabase(env, 'GET', `/rest/v1/publish_transactions?select=*&${filter}&order=created_at.desc&limit=${limit}`),
  ]);
  for (const [name, res] of [['state', stateRes], ['versions', versionsRes], ['reviews', reviewsRes], ['lineage', lineageRes], ['transactions', txRes]]) {
    if (!res.ok) throw new Error(`Failed to load dashboard ${name}: ${await safeText(res)}`);
  }
  const [deployment_state, recent_versions, pending_reviews, lineage, publish_transactions] = await Promise.all([
    stateRes.json(), versionsRes.json(), reviewsRes.json(), lineageRes.json(), txRes.json(),
  ]);
  return {
    ok: true,
    summary: {
      live_artifacts: deployment_state.filter((s) => s.status === 'live').length,
      publish_blockers: deployment_state.filter((s) => s.publish_blocked).length,
      pending_reviews: pending_reviews.length,
      stale_artifacts: deployment_state.filter((s) => s.status === 'stale').length,
    },
    deployment_state,
    recent_versions,
    pending_reviews,
    what_changed_and_why: lineage.map((e) => ({
      at: e.created_at,
      artifact_type: e.artifact_type,
      event_type: e.event_type,
      summary: e.change_summary,
      why: e.payload?.stale_reason || e.payload?.dependency?.reason || e.payload?.diff_summary || e.payload?.source_key || null,
      payload: e.payload,
    })),
    publish_transactions,
  };
}

export async function planSelectiveRebuilds(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const filter = clientQueryFilter(body);
  if (!filter) throw new Error('client_id or client_slug/slug is required');
  const budgetCents = clampInt(body.budget_cents || DEFAULT_BATCH_BUDGET_CENTS, 1, 100000);
  const res = await supabase(env, 'GET', `/rest/v1/deployment_state?select=*&${filter}&status=eq.stale&order=updated_at.asc`);
  if (!res.ok) throw new Error(`Failed to load stale artifacts: ${await safeText(res)}`);
  const stale = await res.json();
  let spent = 0;
  const selected = [];
  const deferred = [];
  for (const item of stale) {
    const estimate = estimateRebuildCostCents(item.artifact_type);
    if (spent + estimate <= budgetCents) {
      spent += estimate;
      selected.push({ ...item, estimated_cost_cents: estimate });
    } else {
      deferred.push({ ...item, estimated_cost_cents: estimate, defer_reason: 'budget_limit' });
    }
  }
  return { ok: true, budget_cents: budgetCents, selected, deferred, estimated_spend_cents: spent };
}

function estimateRebuildCostCents(artifactType) {
  const estimates = { homepage: 18, seo: 4, sitemap: 1, products: 2 };
  return estimates[artifactType] || 10;
}

async function createReviewRequest(supabase, env, row) {
  const res = await supabase(env, 'POST', '/rest/v1/artifact_reviews', {
    client_id: row.client_id,
    client_slug: row.client_slug,
    artifact_version_id: row.artifact_version_id,
    artifact_type: row.artifact_type,
    status: 'pending',
    requested_by: row.requested_by,
    review_reason: row.review_reason,
  }, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to create artifact review request: ${await safeText(res)}`);
  return (await res.json())[0];
}

async function loadArtifactVersion(supabase, env, id) {
  const res = await supabase(env, 'GET', `/rest/v1/artifact_versions?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  if (!res.ok) throw new Error(`Failed to load artifact version: ${await safeText(res)}`);
  const rows = await res.json();
  if (!rows.length) throw new Error('Artifact version not found.');
  return rows[0];
}

async function getCurrentLiveVersion(supabase, env, input) {
  const filter = clientQueryFilter(input);
  if (!filter) return null;
  const res = await supabase(env, 'GET', `/rest/v1/artifact_versions?select=*&${filter}&environment=eq.${encodeURIComponent(input.environment)}&artifact_type=eq.${encodeURIComponent(input.artifact_type)}&artifact_key=eq.${encodeURIComponent(input.artifact_key)}&is_current_live=eq.true&limit=1`);
  if (!res.ok) throw new Error(`Failed to load current live artifact: ${await safeText(res)}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function findCurrentLiveVersionId(supabase, env, version) {
  const current = await getCurrentLiveVersion(supabase, env, version);
  return current?.id || null;
}

async function nextVersionNumber(supabase, env, input) {
  const filter = clientQueryFilter(input);
  const res = await supabase(env, 'GET', `/rest/v1/artifact_versions?select=version_number&${filter}&environment=eq.${encodeURIComponent(input.environment)}&artifact_type=eq.${encodeURIComponent(input.artifact_type)}&artifact_key=eq.${encodeURIComponent(input.artifact_key)}&order=version_number.desc&limit=1`);
  if (!res.ok) throw new Error(`Failed to load version counter: ${await safeText(res)}`);
  const rows = await res.json();
  return Number(rows[0]?.version_number || 0) + 1;
}

async function upsertDeploymentState(supabase, env, row) {
  const client = row.client_id ? `client_id=eq.${encodeURIComponent(row.client_id)}` : `client_slug=eq.${encodeURIComponent(row.client_slug)}`;
  const findRes = await supabase(env, 'GET', `/rest/v1/deployment_state?select=id&${client}&environment=eq.${encodeURIComponent(row.environment)}&artifact_type=eq.${encodeURIComponent(row.artifact_type)}&limit=1`);
  if (!findRes.ok) throw new Error(`Failed to find deployment state: ${await safeText(findRes)}`);
  const existing = (await findRes.json())[0];
  const payload = { ...row, stale_reason: null, stale_source_type: null, stale_source_key: null, updated_at: new Date().toISOString() };
  const res = existing
    ? await supabase(env, 'PATCH', `/rest/v1/deployment_state?id=eq.${encodeURIComponent(existing.id)}`, payload)
    : await supabase(env, 'POST', '/rest/v1/deployment_state', payload);
  if (!res.ok) throw new Error(`Failed to upsert deployment state: ${await safeText(res)}`);
}

async function recordLineageEvent(supabase, env, row) {
  const res = await supabase(env, 'POST', '/rest/v1/artifact_lineage', {
    client_id: row.client_id || null,
    client_slug: row.client_slug || null,
    artifact_type: row.artifact_type,
    artifact_key: row.artifact_key || null,
    event_type: row.event_type,
    event_source: row.event_source,
    change_summary: row.change_summary,
    parent_event_id: row.parent_event_id || null,
    job_id: row.job_id || null,
    payload: row.payload || {},
  }, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to record artifact lineage: ${await safeText(res)}`);
  return (await res.json())[0];
}

function normalizeArtifactVersionInput(body) {
  const artifactType = body.artifact_type || body.type;
  if (!artifactType) throw new Error('artifact_type is required');
  if (!body.client_id && !body.client_slug && !body.slug) throw new Error('client_id or client_slug/slug is required');
  const content = body.content ?? body.artifact ?? body.generated_artifact ?? null;
  if (content === null || content === undefined) throw new Error('content/generated_artifact is required');
  return {
    client_id: body.client_id || body.clientId || null,
    client_slug: body.client_slug || body.slug || null,
    environment: body.environment || DEFAULT_ENVIRONMENT,
    artifact_type: String(artifactType),
    artifact_key: String(body.artifact_key || body.key || 'default'),
    content,
    metadata: body.metadata || {},
    source_job_id: body.source_job_id || body.job_id || null,
    parent_version_id: body.parent_version_id || null,
    parent_lineage_event_id: body.parent_lineage_event_id || body.lineage_event_id || null,
    requires_review: body.requires_review ?? body.requires_review_before_publish ?? true,
    created_by: body.created_by || body.actor || 'artifact_generator',
    event_source: body.event_source || null,
    change_summary: body.change_summary || null,
    review_reason: body.review_reason || null,
  };
}

function buildJsonDiff(oldValue, newValue) {
  if (oldValue === null || oldValue === undefined) {
    return { summary: 'No live version exists yet; this is the first staged version.', added: [{ path: '$', value: newValue }], removed: [], changed: [] };
  }
  const oldFlat = flatten(oldValue);
  const newFlat = flatten(newValue);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [path, value] of Object.entries(newFlat)) {
    if (!(path in oldFlat)) added.push({ path, value });
    else if (stableStringify(oldFlat[path]) !== stableStringify(value)) changed.push({ path, before: oldFlat[path], after: value });
  }
  for (const [path, value] of Object.entries(oldFlat)) {
    if (!(path in newFlat)) removed.push({ path, value });
  }
  const parts = [];
  if (added.length) parts.push(`${added.length} added`);
  if (changed.length) parts.push(`${changed.length} changed`);
  if (removed.length) parts.push(`${removed.length} removed`);
  return { summary: parts.length ? parts.join(', ') : 'No material content changes detected.', added, changed, removed };
}

function flatten(value, prefix = '$', out = {}) {
  if (value === null || typeof value !== 'object') {
    out[prefix] = value;
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out));
    if (!value.length) out[prefix] = [];
    return out;
  }
  const keys = Object.keys(value);
  if (!keys.length) out[prefix] = {};
  keys.forEach((key) => flatten(value[key], `${prefix}.${key}`, out));
  return out;
}

async function sha256Json(value) {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function normalizeDecision(decision) {
  const value = String(decision || '').toLowerCase().trim();
  if (['approve', 'approved'].includes(value)) return 'approve';
  if (['reject', 'rejected'].includes(value)) return 'reject';
  if (['request_changes', 'changes_requested', 'revise'].includes(value)) return 'request_changes';
  throw new Error('decision must be approve, reject, or request_changes');
}

function clientQueryFilter(body) {
  if (body.client_id || body.clientId) return `client_id=eq.${encodeURIComponent(body.client_id || body.clientId)}`;
  if (body.client_slug || body.slug) return `client_slug=eq.${encodeURIComponent(body.client_slug || body.slug)}`;
  return '';
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function serializeError(err) {
  return { message: err?.message || String(err), stack: err?.stack || null };
}

function requireDep(value, name) {
  if (!value) throw new Error(`Missing artifact pipeline dependency: ${name}`);
  return value;
}

async function safeText(res) {
  try { return await res.text(); } catch { return `${res.status} ${res.statusText}`; }
}

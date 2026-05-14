// =============================================================================
// FORMAUT APPROVAL + CHANGE CONTROL
// =============================================================================
// Turns generated artifacts into reviewable proposed changes before anything can
// publish. This is the safety layer after the job queue: artifacts are reviewed,
// approved/rejected/revised, snapshotted, and only then allowed through a publish
// gate.
// =============================================================================

import { produceJob } from './formaut-job-queue.js';

const APPROVAL_STATUSES = new Set(['pending','approved','rejected','revision_requested','superseded']);

export async function createArtifactReview(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const artifactId = body.artifact_id || body.artifactId;
  if (!artifactId) throw new Error('artifact_id is required');

  const artifact = await loadArtifact(supabase, env, artifactId);
  const row = {
    artifact_id: artifact.id,
    job_id: artifact.job_id || null,
    client_id: artifact.client_id || body.client_id || null,
    client_slug: artifact.client_slug || body.client_slug || body.slug || null,
    review_type: body.review_type || body.reviewType || artifact.artifact_type || 'artifact',
    title: body.title || artifact.title || `${artifact.artifact_type} review`,
    summary: body.summary || artifact.summary || null,
    status: 'pending',
    proposed_change: body.proposed_change || body.proposedChange || artifact.content_json || {},
    created_by: body.created_by || body.createdBy || 'dashboard',
  };

  const res = await supabase(env, 'POST', '/rest/v1/artifact_reviews', row, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to create review: ${await safeText(res)}`);
  const rows = await res.json();
  await recordChangeLog(supabase, env, {
    client_id: row.client_id,
    client_slug: row.client_slug,
    artifact_id: artifact.id,
    review_id: rows[0].id,
    change_type: 'review_created',
    status: 'proposed',
    title: row.title,
    summary: row.summary,
    before_json: null,
    after_json: row.proposed_change,
    created_by: row.created_by,
  });
  return { ok: true, review: rows[0] };
}

export async function listArtifactReviews(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const limit = clampInt(body.limit || 50, 1, 200);
  const filters = [];
  const clientSlug = body.client_slug || body.slug || null;
  if (clientSlug) filters.push(`client_slug=eq.${encodeURIComponent(clientSlug)}`);
  if (body.status) filters.push(`status=eq.${encodeURIComponent(body.status)}`);
  if (body.artifact_id || body.artifactId) filters.push(`artifact_id=eq.${encodeURIComponent(body.artifact_id || body.artifactId)}`);
  const qs = filters.length ? `&${filters.join('&')}` : '';
  const res = await supabase(env, 'GET', `/rest/v1/artifact_reviews?select=*&order=created_at.desc&limit=${limit}${qs}`);
  if (!res.ok) throw new Error(`Failed to list reviews: ${await safeText(res)}`);
  return { ok: true, reviews: await res.json() };
}

export async function getArtifactReview(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const id = body.review_id || body.reviewId || body.id;
  if (!id) throw new Error('review_id is required');
  const review = await loadReview(supabase, env, id);
  return { ok: true, review };
}

export async function decideArtifactReview(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const id = body.review_id || body.reviewId || body.id;
  if (!id) throw new Error('review_id is required');
  const decision = normalizeDecision(body.decision || body.status);
  const review = await loadReview(supabase, env, id);

  const patch = {
    status: decision,
    decision_note: body.note || body.reason || body.decision_note || null,
    decided_by: body.decided_by || body.decidedBy || body.created_by || 'dashboard',
    decided_at: new Date().toISOString(),
  };
  if (decision === 'approved') patch.approved_at = patch.decided_at;
  if (decision === 'rejected') patch.rejected_at = patch.decided_at;
  if (decision === 'revision_requested') patch.revision_requested_at = patch.decided_at;

  const res = await supabase(env, 'PATCH', `/rest/v1/artifact_reviews?id=eq.${encodeURIComponent(id)}`, patch, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to update review: ${await safeText(res)}`);
  const rows = await res.json();
  const updated = rows[0];

  await recordChangeLog(supabase, env, {
    client_id: review.client_id,
    client_slug: review.client_slug,
    artifact_id: review.artifact_id,
    review_id: review.id,
    change_type: decision === 'approved' ? 'approval' : decision,
    status: decision === 'approved' ? 'approved' : 'proposed',
    title: review.title,
    summary: patch.decision_note || review.summary,
    before_json: { status: review.status },
    after_json: { status: decision, note: patch.decision_note },
    created_by: patch.decided_by,
  });

  let revision_job = null;
  if (decision === 'revision_requested' && body.enqueue_revision !== false) {
    revision_job = await enqueueRevisionJob(review, body, env, deps);
  }

  return { ok: true, review: updated, revision_job: revision_job?.job || null };
}

export async function listChangeLog(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const limit = clampInt(body.limit || 50, 1, 200);
  const clientSlug = body.client_slug || body.slug || null;
  const qs = clientSlug ? `&client_slug=eq.${encodeURIComponent(clientSlug)}` : '';
  const res = await supabase(env, 'GET', `/rest/v1/change_log?select=*&order=created_at.desc&limit=${limit}${qs}`);
  if (!res.ok) throw new Error(`Failed to list change log: ${await safeText(res)}`);
  return { ok: true, changes: await res.json() };
}

export async function createSiteSnapshot(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const clientSlug = body.client_slug || body.slug;
  if (!clientSlug) throw new Error('client_slug is required');
  const snapshot = {
    client_id: body.client_id || null,
    client_slug: clientSlug,
    source: body.source || 'manual',
    title: body.title || `Snapshot ${new Date().toISOString()}`,
    summary: body.summary || null,
    site_state_json: body.site_state_json || body.siteState || body.state || {},
    storage_url: body.storage_url || body.storageUrl || null,
    git_ref: body.git_ref || body.gitRef || null,
    created_by: body.created_by || body.createdBy || 'dashboard',
  };
  const res = await supabase(env, 'POST', '/rest/v1/site_version_snapshots', snapshot, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to create snapshot: ${await safeText(res)}`);
  const rows = await res.json();
  await recordChangeLog(supabase, env, {
    client_id: snapshot.client_id,
    client_slug: snapshot.client_slug,
    snapshot_id: rows[0].id,
    change_type: 'snapshot_created',
    status: 'applied',
    title: snapshot.title,
    summary: snapshot.summary,
    before_json: null,
    after_json: { snapshot_id: rows[0].id, git_ref: snapshot.git_ref, storage_url: snapshot.storage_url },
    created_by: snapshot.created_by,
  });
  return { ok: true, snapshot: rows[0] };
}

export async function listSiteSnapshots(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const limit = clampInt(body.limit || 30, 1, 100);
  const clientSlug = body.client_slug || body.slug;
  if (!clientSlug) throw new Error('client_slug is required');
  const res = await supabase(env, 'GET', `/rest/v1/site_version_snapshots?client_slug=eq.${encodeURIComponent(clientSlug)}&select=*&order=created_at.desc&limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to list snapshots: ${await safeText(res)}`);
  return { ok: true, snapshots: await res.json() };
}

export async function rollbackToSnapshot(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const snapshotId = body.snapshot_id || body.snapshotId || body.id;
  if (!snapshotId) throw new Error('snapshot_id is required');
  const snapshot = await loadSnapshot(supabase, env, snapshotId);
  const row = {
    client_id: snapshot.client_id,
    client_slug: snapshot.client_slug,
    snapshot_id: snapshot.id,
    change_type: 'rollback_requested',
    status: 'approved',
    title: body.title || `Rollback to ${snapshot.title}`,
    summary: body.reason || body.summary || 'Rollback requested from dashboard.',
    before_json: {},
    after_json: { snapshot_id: snapshot.id, git_ref: snapshot.git_ref, storage_url: snapshot.storage_url },
    created_by: body.created_by || body.createdBy || 'dashboard',
  };
  const change = await recordChangeLog(supabase, env, row);
  return { ok: true, rollback: change, snapshot, next_action: 'apply_rollback_with_deploy_tool' };
}

export async function createPublishRequest(body, env, deps = {}) {
  const gate = await publishGateCheck(body, env, deps);
  const supabase = requireDep(deps.supabase, 'supabase');
  const row = {
    client_id: body.client_id || null,
    client_slug: body.client_slug || body.slug,
    artifact_review_id: body.review_id || body.reviewId || null,
    snapshot_id: body.snapshot_id || body.snapshotId || null,
    status: gate.allowed ? 'ready' : 'blocked',
    gate_result: gate,
    requested_by: body.requested_by || body.requestedBy || 'dashboard',
  };
  const res = await supabase(env, 'POST', '/rest/v1/publish_requests', row, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to create publish request: ${await safeText(res)}`);
  return { ok: true, publish_request: (await res.json())[0], gate };
}

export async function publishGateCheck(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const clientSlug = body.client_slug || body.slug;
  const reviewId = body.review_id || body.reviewId || null;
  const reasons = [];
  let review = null;
  if (reviewId) {
    review = await loadReview(supabase, env, reviewId);
    if (review.status !== 'approved') reasons.push('Artifact review is not approved.');
  } else {
    reasons.push('No approved artifact review was provided.');
  }
  if (!clientSlug && !review?.client_slug) reasons.push('No client slug was provided.');

  const mode = await loadQueueMode(supabase, env);
  if (mode === 'read_only') reasons.push('System is in read_only degradation mode.');
  if (mode === 'critical_only' && body.priority > 50) reasons.push('System is in critical_only mode; normal publishes are paused.');

  return {
    ok: true,
    allowed: reasons.length === 0,
    reasons,
    review_id: reviewId,
    client_slug: clientSlug || review?.client_slug || null,
    degradation_mode: mode,
    next_action: reasons.length ? 'resolve_publish_blockers' : 'create_snapshot_then_publish',
  };
}

async function enqueueRevisionJob(review, body, env, deps) {
  const jobType = review.review_type === 'seo_plan' ? 'seo_generation' : review.review_type === 'homepage_draft' ? 'homepage_generation' : (body.revision_job_type || 'homepage_generation');
  return produceJob({
    client_id: review.client_id,
    client_slug: review.client_slug,
    session_id: body.session_id || null,
    queue: jobType === 'seo_generation' || jobType === 'homepage_generation' ? 'generation' : 'default',
    job_type: jobType,
    priority: body.priority || 70,
    payload: {
      revision_of_review_id: review.id,
      revision_of_artifact_id: review.artifact_id,
      requested_changes: body.note || body.reason || body.requested_changes || '',
      previous_proposed_change: review.proposed_change || {},
    },
    created_by: body.created_by || 'dashboard_revision_request',
  }, env, deps);
}

async function loadArtifact(supabase, env, id) {
  const res = await supabase(env, 'GET', `/rest/v1/job_artifacts?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  if (!res.ok) throw new Error(`Failed to load artifact: ${await safeText(res)}`);
  const rows = await res.json();
  if (!rows.length) throw new Error('Artifact not found');
  return rows[0];
}

async function loadReview(supabase, env, id) {
  const res = await supabase(env, 'GET', `/rest/v1/artifact_reviews?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  if (!res.ok) throw new Error(`Failed to load review: ${await safeText(res)}`);
  const rows = await res.json();
  if (!rows.length) throw new Error('Review not found');
  return rows[0];
}

async function loadSnapshot(supabase, env, id) {
  const res = await supabase(env, 'GET', `/rest/v1/site_version_snapshots?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  if (!res.ok) throw new Error(`Failed to load snapshot: ${await safeText(res)}`);
  const rows = await res.json();
  if (!rows.length) throw new Error('Snapshot not found');
  return rows[0];
}

async function loadQueueMode(supabase, env) {
  const res = await supabase(env, 'GET', '/rest/v1/job_queue_settings?queue=eq.default&select=degradation_mode&limit=1');
  if (!res.ok) return 'normal';
  const rows = await res.json();
  return rows[0]?.degradation_mode || 'normal';
}

async function recordChangeLog(supabase, env, row) {
  const res = await supabase(env, 'POST', '/rest/v1/change_log', row, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to record change log: ${await safeText(res)}`);
  return (await res.json())[0];
}

function normalizeDecision(value) {
  const status = String(value || '').trim();
  if (!APPROVAL_STATUSES.has(status) || status === 'pending') throw new Error(`Invalid review decision '${value}'`);
  return status;
}
function requireDep(value, name) { if (!value) throw new Error(`Missing approval dependency: ${name}`); return value; }
function clampInt(value, min, max) { const n = Number.parseInt(value, 10); if (Number.isNaN(n)) return min; return Math.max(min, Math.min(max, n)); }
async function safeText(res) { try { return await res.text(); } catch { return `${res.status} ${res.statusText}`; } }

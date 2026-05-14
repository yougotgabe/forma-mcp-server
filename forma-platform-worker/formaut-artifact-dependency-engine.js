// =============================================================================
// FORMAUT DEPLOYMENT STATE & ARTIFACT DEPENDENCY ENGINE
// =============================================================================
// Turns business memory/profile changes into deterministic artifact maintenance:
//   brand voice changed -> homepage stale -> homepage regen job -> SEO regen job
//   -> publish blocked until review.
//
// This module intentionally uses the existing platform Supabase + job queue.
// It does not generate artifacts itself; it plans, marks state, records lineage,
// and enqueues the appropriate work.
// =============================================================================

const DEFAULT_REGEN_PRIORITY = 80;
const DEFAULT_DEPLOYMENT_ENV = 'production';

const ARTIFACTS = {
  homepage: {
    artifact_type: 'homepage',
    label: 'Homepage',
    regeneration_job_type: 'generate_homepage',
    requires_review_before_publish: true,
  },
  seo: {
    artifact_type: 'seo',
    label: 'SEO metadata',
    regeneration_job_type: 'generate_seo',
    requires_review_before_publish: true,
  },
  sitemap: {
    artifact_type: 'sitemap',
    label: 'Sitemap',
    regeneration_job_type: 'generate_sitemap',
    requires_review_before_publish: false,
  },
  products: {
    artifact_type: 'products',
    label: 'Product catalog',
    regeneration_job_type: 'sync_printify_products',
    requires_review_before_publish: false,
  },
};

const DEFAULT_DEPENDENCIES = [
  // Business profile / memory inputs that directly affect page copy and voice.
  { source_artifact_type: 'business_profile', source_key: 'brand_voice', dependent_artifact_type: 'homepage', invalidation_policy: 'stale_requires_regeneration', reason: 'Brand voice affects homepage copy, tone, and calls to action.' },
  { source_artifact_type: 'business_profile', source_key: 'brand_tone', dependent_artifact_type: 'homepage', invalidation_policy: 'stale_requires_regeneration', reason: 'Brand tone affects homepage copy, tone, and calls to action.' },
  { source_artifact_type: 'business_profile', source_key: 'social_voice', dependent_artifact_type: 'homepage', invalidation_policy: 'stale_requires_regeneration', reason: 'Social voice affects visible website language.' },
  { source_artifact_type: 'business_profile', source_key: 'visual_style', dependent_artifact_type: 'homepage', invalidation_policy: 'stale_requires_regeneration', reason: 'Visual style changes affect homepage layout and section treatment.' },
  { source_artifact_type: 'business_profile', source_key: 'services', dependent_artifact_type: 'homepage', invalidation_policy: 'stale_requires_regeneration', reason: 'Service changes affect homepage service cards and conversion flow.' },
  { source_artifact_type: 'business_profile', source_key: 'target_customer', dependent_artifact_type: 'homepage', invalidation_policy: 'stale_requires_regeneration', reason: 'Audience changes affect message framing.' },
  { source_artifact_type: 'business_profile', source_key: 'key_differentiators', dependent_artifact_type: 'homepage', invalidation_policy: 'stale_requires_regeneration', reason: 'Differentiator changes affect positioning sections.' },

  // SEO depends on both profile truth and generated visible page content.
  { source_artifact_type: 'business_profile', source_key: 'brand_voice', dependent_artifact_type: 'seo', invalidation_policy: 'stale_requires_regeneration', reason: 'SEO titles/descriptions should match current brand voice.' },
  { source_artifact_type: 'business_profile', source_key: 'brand_tone', dependent_artifact_type: 'seo', invalidation_policy: 'stale_requires_regeneration', reason: 'SEO titles/descriptions should match current brand tone.' },
  { source_artifact_type: 'business_profile', source_key: 'services', dependent_artifact_type: 'seo', invalidation_policy: 'stale_requires_regeneration', reason: 'Service changes affect keywords, titles, and page descriptions.' },
  { source_artifact_type: 'business_profile', source_key: 'location', dependent_artifact_type: 'seo', invalidation_policy: 'stale_requires_regeneration', reason: 'Location changes affect local SEO metadata.' },
  { source_artifact_type: 'artifact', source_key: 'homepage', dependent_artifact_type: 'seo', invalidation_policy: 'stale_requires_regeneration', reason: 'SEO should be regenerated from current homepage content.' },

  // Commerce products can affect homepage and SEO once commerce blocks exist.
  { source_artifact_type: 'integration', source_key: 'printify.products', dependent_artifact_type: 'homepage', invalidation_policy: 'stale_optional_regeneration', reason: 'Product catalog updates may affect featured product sections.' },
  { source_artifact_type: 'integration', source_key: 'printify.products', dependent_artifact_type: 'seo', invalidation_policy: 'stale_optional_regeneration', reason: 'Product catalog updates may affect SEO metadata.' },
];

export async function seedArtifactDependencies(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const clientId = body.client_id || body.clientId || null;
  const clientSlug = body.client_slug || body.slug || null;
  const rows = DEFAULT_DEPENDENCIES.map((dep) => ({
    client_id: clientId,
    client_slug: clientSlug,
    source_artifact_type: dep.source_artifact_type,
    source_key: dep.source_key,
    dependent_artifact_type: dep.dependent_artifact_type,
    invalidation_policy: dep.invalidation_policy,
    reason: dep.reason,
    is_active: true,
  }));

  const saved = [];
  for (const row of rows) {
    const existing = await findDependencyRow(supabase, env, row);
    if (existing) {
      saved.push(existing);
      continue;
    }
    const res = await supabase(env, 'POST', '/rest/v1/artifact_dependencies', row, { Prefer: 'return=representation' });
    if (!res.ok) throw new Error(`Failed to seed artifact dependency: ${await safeText(res)}`);
    const created = await res.json();
    saved.push(created[0]);
  }

  return { ok: true, count: saved.length, dependencies: saved };
}

export async function recordArtifactInputChange(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const produceJob = requireDep(deps.produceJob, 'produceJob');

  const change = normalizeInputChange(body);
  await ensureDefaultDependenciesForClient(change, env, deps);

  const dependents = await loadMatchingDependencies(change, env, deps);
  const plan = buildRegenerationPlan(change, dependents);

  const lineageEvent = await recordLineageEvent(supabase, env, {
    client_id: change.client_id,
    client_slug: change.client_slug,
    artifact_type: change.source_artifact_type,
    artifact_key: change.source_key,
    event_type: 'input_changed',
    event_source: change.event_source,
    change_summary: change.change_summary,
    payload: {
      old_value: change.old_value,
      new_value: change.new_value,
      source_key: change.source_key,
      dependents: dependents.map((d) => d.dependent_artifact_type),
    },
  });

  const results = [];
  for (const step of plan.steps) {
    const state = await markDeploymentState(supabase, env, {
      client_id: change.client_id,
      client_slug: change.client_slug,
      artifact_type: step.artifact_type,
      status: 'stale',
      stale_reason: step.stale_reason,
      stale_source_type: change.source_artifact_type,
      stale_source_key: change.source_key,
      review_required: step.requires_review_before_publish,
      publish_blocked: step.requires_review_before_publish,
      publish_blocker_reason: step.requires_review_before_publish ? 'Regenerated artifact must be reviewed before publish.' : null,
      lineage_event_id: lineageEvent?.id || null,
    });

    let job = null;
    if (step.should_enqueue) {
      job = await produceJob({
        client_id: change.client_id,
        client_slug: change.client_slug,
        queue: step.queue,
        job_type: step.job_type,
        priority: step.priority,
        created_by: 'artifact_dependency_engine',
        payload: {
          artifact_type: step.artifact_type,
          trigger: 'dependency_invalidation',
          source_artifact_type: change.source_artifact_type,
          source_key: change.source_key,
          change_summary: change.change_summary,
          lineage_event_id: lineageEvent?.id || null,
          requires_review_before_publish: step.requires_review_before_publish,
        },
      }, env, deps);

      await recordLineageEvent(supabase, env, {
        client_id: change.client_id,
        client_slug: change.client_slug,
        artifact_type: step.artifact_type,
        event_type: 'regeneration_enqueued',
        parent_event_id: lineageEvent?.id || null,
        event_source: 'artifact_dependency_engine',
        change_summary: `Queued ${step.job_type} because ${change.source_key} changed.`,
        job_id: job.job?.id || null,
        payload: { dependency: step.dependency, state_id: state?.id || null },
      });
    }

    results.push({ ...step, deployment_state: state, job: job?.job || null });
  }

  return {
    ok: true,
    change,
    lineage_event: lineageEvent,
    affected_artifacts: plan.steps.map((s) => s.artifact_type),
    publish_blockers: results.filter((r) => r.requires_review_before_publish).map((r) => ({ artifact_type: r.artifact_type, reason: 'Requires review before publish.' })),
    regeneration_plan: results,
  };
}

export async function getDeploymentState(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const clientFilter = clientQueryFilter(body);
  if (!clientFilter) throw new Error('client_id or client_slug/slug is required');
  const artifactFilter = body.artifact_type ? `&artifact_type=eq.${encodeURIComponent(body.artifact_type)}` : '';
  const res = await supabase(env, 'GET', `/rest/v1/deployment_state?select=*&${clientFilter}${artifactFilter}&order=updated_at.desc`);
  if (!res.ok) throw new Error(`Failed to load deployment state: ${await safeText(res)}`);
  const rows = await res.json();
  return { ok: true, deployment_state: rows, publish_blockers: rows.filter((r) => r.publish_blocked) };
}

export async function listArtifactLineage(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const clientFilter = clientQueryFilter(body);
  if (!clientFilter) throw new Error('client_id or client_slug/slug is required');
  const limit = clampInt(body.limit || 50, 1, 200);
  const artifactFilter = body.artifact_type ? `&artifact_type=eq.${encodeURIComponent(body.artifact_type)}` : '';
  const res = await supabase(env, 'GET', `/rest/v1/artifact_lineage?select=*&${clientFilter}${artifactFilter}&order=created_at.desc&limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to load artifact lineage: ${await safeText(res)}`);
  return { ok: true, lineage: await res.json() };
}

export async function resolvePublishBlocker(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const clientFilter = clientQueryFilter(body);
  const artifactType = body.artifact_type;
  if (!clientFilter || !artifactType) throw new Error('client_id/client_slug and artifact_type are required');

  const patch = {
    status: body.status || 'ready_for_publish',
    review_required: false,
    publish_blocked: false,
    publish_blocker_reason: null,
    reviewed_at: new Date().toISOString(),
    reviewed_by: body.reviewed_by || body.actor || 'operator',
    updated_at: new Date().toISOString(),
  };
  const res = await supabase(env, 'PATCH', `/rest/v1/deployment_state?${clientFilter}&artifact_type=eq.${encodeURIComponent(artifactType)}`, patch, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to resolve publish blocker: ${await safeText(res)}`);
  const rows = await res.json();
  await recordLineageEvent(supabase, env, {
    client_id: body.client_id || null,
    client_slug: body.client_slug || body.slug || null,
    artifact_type: artifactType,
    event_type: 'review_approved',
    event_source: 'operator_review',
    change_summary: body.reason || 'Artifact reviewed and unblocked for publish.',
    payload: { reviewed_by: patch.reviewed_by },
  });
  return { ok: true, deployment_state: rows[0] || null };
}

export async function markArtifactGenerated(body = {}, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const artifactType = body.artifact_type || body.type;
  if (!artifactType) throw new Error('artifact_type is required');
  const meta = ARTIFACTS[artifactType] || { requires_review_before_publish: true };
  const reviewRequired = body.requires_review_before_publish ?? meta.requires_review_before_publish ?? true;

  const lineage = await recordLineageEvent(supabase, env, {
    client_id: body.client_id || null,
    client_slug: body.client_slug || body.slug || null,
    artifact_type: artifactType,
    artifact_key: body.artifact_key || null,
    event_type: 'artifact_generated',
    event_source: body.event_source || 'job_handler',
    change_summary: body.change_summary || `${artifactType} generated from current dependencies.`,
    job_id: body.job_id || null,
    parent_event_id: body.parent_event_id || body.lineage_event_id || null,
    payload: body.payload || {},
  });

  const state = await markDeploymentState(supabase, env, {
    client_id: body.client_id || null,
    client_slug: body.client_slug || body.slug || null,
    artifact_type: artifactType,
    status: reviewRequired ? 'pending_review' : 'ready_for_publish',
    stale_reason: null,
    stale_source_type: null,
    stale_source_key: null,
    review_required: reviewRequired,
    publish_blocked: reviewRequired,
    publish_blocker_reason: reviewRequired ? 'Newly generated artifact requires review before publish.' : null,
    lineage_event_id: lineage?.id || null,
  });

  return { ok: true, artifact_type: artifactType, lineage_event: lineage, deployment_state: state };
}

function buildRegenerationPlan(change, dependencies) {
  const seen = new Set();
  const steps = [];
  for (const dep of dependencies) {
    const artifactType = dep.dependent_artifact_type;
    if (seen.has(artifactType)) continue;
    seen.add(artifactType);
    const meta = ARTIFACTS[artifactType] || {};
    const required = dep.invalidation_policy !== 'stale_optional_regeneration';
    steps.push({
      artifact_type: artifactType,
      label: meta.label || artifactType,
      dependency: dep,
      stale_reason: dep.reason || `${change.source_key} changed.`,
      should_enqueue: required,
      queue: 'artifact_generation',
      job_type: meta.regeneration_job_type || `generate_${artifactType}`,
      priority: DEFAULT_REGEN_PRIORITY,
      requires_review_before_publish: meta.requires_review_before_publish !== false,
    });
  }

  // SEO depends on homepage; when homepage is regenerated, SEO must follow.
  if (seen.has('homepage') && !seen.has('seo')) {
    const meta = ARTIFACTS.seo;
    steps.push({
      artifact_type: 'seo',
      label: meta.label,
      dependency: { source_artifact_type: 'artifact', source_key: 'homepage', dependent_artifact_type: 'seo' },
      stale_reason: 'Homepage regeneration can change visible copy, headings, and positioning used by SEO metadata.',
      should_enqueue: true,
      queue: 'artifact_generation',
      job_type: meta.regeneration_job_type,
      priority: DEFAULT_REGEN_PRIORITY + 5,
      requires_review_before_publish: true,
    });
  }

  return { steps };
}

async function loadMatchingDependencies(change, env, deps) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const sourceType = encodeURIComponent(change.source_artifact_type);
  const sourceKey = encodeURIComponent(change.source_key);
  const scoped = change.client_id
    ? `or=(client_id.is.null,client_id.eq.${encodeURIComponent(change.client_id)})`
    : change.client_slug
      ? `or=(client_slug.is.null,client_slug.eq.${encodeURIComponent(change.client_slug)})`
      : 'client_id=is.null';
  const path = `/rest/v1/artifact_dependencies?select=*&source_artifact_type=eq.${sourceType}&source_key=eq.${sourceKey}&is_active=eq.true&${scoped}`;
  const res = await supabase(env, 'GET', path);
  if (!res.ok) throw new Error(`Failed to load artifact dependencies: ${await safeText(res)}`);
  return await res.json();
}

async function ensureDefaultDependenciesForClient(change, env, deps) {
  // Safe no-op if unique constraints already contain these rows.
  await seedArtifactDependencies({ client_id: change.client_id, client_slug: change.client_slug }, env, deps).catch(() => null);
}


async function findDeploymentStateRow(supabase, env, payload) {
  const params = new URLSearchParams();
  params.set('select', 'id');
  params.set('environment', `eq.${payload.environment || DEFAULT_DEPLOYMENT_ENV}`);
  params.set('artifact_type', `eq.${payload.artifact_type}`);
  params.set('limit', '1');

  if (payload.client_id) {
    params.set('client_id', `eq.${payload.client_id}`);
  } else {
    params.set('client_id', 'is.null');
  }

  if (payload.client_slug) {
    params.set('client_slug', `eq.${payload.client_slug}`);
  } else {
    params.set('client_slug', 'is.null');
  }

  const res = await supabase(env, 'GET', `/rest/v1/deployment_state?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to find deployment state row: ${await safeText(res)}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function markDeploymentState(supabase, env, row) {
  const payload = {
    client_id: row.client_id || null,
    client_slug: row.client_slug || null,
    environment: row.environment || DEFAULT_DEPLOYMENT_ENV,
    artifact_type: row.artifact_type,
    status: row.status,
    stale_reason: row.stale_reason,
    stale_source_type: row.stale_source_type,
    stale_source_key: row.stale_source_key,
    review_required: Boolean(row.review_required),
    publish_blocked: Boolean(row.publish_blocked),
    publish_blocker_reason: row.publish_blocker_reason,
    latest_lineage_event_id: row.lineage_event_id || null,
    updated_at: new Date().toISOString(),
  };

  const existing = await findDeploymentStateRow(supabase, env, payload);
  if (existing) {
    const res = await supabase(env, 'PATCH', `/rest/v1/deployment_state?id=eq.${encodeURIComponent(existing.id)}`, payload, { Prefer: 'return=representation' });
    if (!res.ok) throw new Error(`Failed to update deployment state: ${await safeText(res)}`);
    const rows = await res.json();
    return rows[0] || null;
  }

  const res = await supabase(env, 'POST', '/rest/v1/deployment_state', payload, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to create deployment state: ${await safeText(res)}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function recordLineageEvent(supabase, env, row) {
  const payload = {
    client_id: row.client_id || null,
    client_slug: row.client_slug || null,
    artifact_type: row.artifact_type,
    artifact_key: row.artifact_key || null,
    event_type: row.event_type,
    event_source: row.event_source || 'artifact_dependency_engine',
    change_summary: row.change_summary || null,
    parent_event_id: row.parent_event_id || null,
    job_id: row.job_id || null,
    payload: row.payload || {},
  };
  const res = await supabase(env, 'POST', '/rest/v1/artifact_lineage', payload, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to record artifact lineage: ${await safeText(res)}`);
  const rows = await res.json();
  return rows[0] || null;
}

function normalizeInputChange(body) {
  const sourceKey = body.source_key || body.field_path || body.field || body.changed_key;
  if (!sourceKey) throw new Error('source_key/field_path is required');
  return {
    client_id: body.client_id || body.clientId || null,
    client_slug: body.client_slug || body.slug || null,
    source_artifact_type: body.source_artifact_type || body.source_type || 'business_profile',
    source_key: String(sourceKey),
    old_value: body.old_value ?? null,
    new_value: body.new_value ?? body.confirmed_value ?? null,
    event_source: body.event_source || body.source || 'business_profile_change',
    change_summary: body.change_summary || `${sourceKey} changed.`,
  };
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

function requireDep(value, name) {
  if (!value) throw new Error(`Missing artifact dependency engine dependency: ${name}`);
  return value;
}

async function safeText(res) {
  try { return await res.text(); } catch { return `${res.status} ${res.statusText}`; }
}

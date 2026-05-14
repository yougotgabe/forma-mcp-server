export const WORKFLOW_ENGINE_VERSION = '1.0.0';

export const WORKFLOW_TEMPLATES = {
  client_site_regeneration: [
    { key: 'collect_inputs', job_type: 'collect_artifact_inputs', queue: 'default', priority: 40 },
    { key: 'generate_artifact', job_type: 'regenerate_artifact', queue: 'generation', priority: 50 },
    { key: 'validate_artifact', job_type: 'validate_artifact_version', queue: 'validation', priority: 45 },
    { key: 'request_review', job_type: 'request_artifact_review', queue: 'default', priority: 35, human_gate: true },
    { key: 'publish', job_type: 'publish_artifact_version', queue: 'deployment', priority: 30, requires_approval: true },
    { key: 'post_publish_validate', job_type: 'validate_live_deployment', queue: 'validation', priority: 30 },
  ],
  website_onboarding_crawl: [
    { key: 'preflight_url', job_type: 'crawl_url_preflight', queue: 'default', priority: 30 },
    { key: 'crawl_site', job_type: 'crawl_website', queue: 'crawl', priority: 35 },
    { key: 'normalize_evidence', job_type: 'normalize_crawl_evidence', queue: 'default', priority: 35 },
    { key: 'stage_memory_review', job_type: 'stage_memory_review', queue: 'default', priority: 35, human_gate: true },
  ],
  operational_remediation: [
    { key: 'collect_health', job_type: 'collect_site_health', queue: 'maintenance', priority: 20 },
    { key: 'plan_remediation', job_type: 'plan_remediation', queue: 'maintenance', priority: 25 },
    { key: 'safe_fix_or_review', job_type: 'execute_safe_remediation_or_request_review', queue: 'maintenance', priority: 30 },
    { key: 'validate_fix', job_type: 'validate_remediation', queue: 'validation', priority: 25 },
  ],
};

export async function startWorkflow(body = {}, env = {}, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const produceJob = requireDep(deps.produceJob, 'produceJob');
  const templateName = body.template || body.workflow_type || body.type;
  const steps = body.steps || WORKFLOW_TEMPLATES[templateName];
  if (!templateName || !steps) throw new Error('Known workflow template or explicit steps are required.');

  const workflow = {
    workflow_type: templateName,
    client_id: body.client_id || null,
    client_slug: body.client_slug || body.slug || null,
    session_id: body.session_id || null,
    status: 'running',
    current_step_index: 0,
    input: body.input || body.payload || {},
    steps,
    created_by: body.created_by || 'workflow_engine',
  };

  const res = await supabase(env, 'POST', '/rest/v1/workflows', workflow, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to create workflow: ${await safeText(res)}`);
  const created = (await res.json())[0];
  await appendWorkflowEvent({ workflow_id: created.id, type: 'started', payload: { template: templateName } }, env, supabase);
  const enqueue = await enqueueStep(created, steps[0], env, deps, produceJob);
  return { ok: true, workflow: summarizeWorkflow(created), enqueued: enqueue };
}

export async function advanceWorkflow(body = {}, env = {}, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const produceJob = requireDep(deps.produceJob, 'produceJob');
  const workflowId = body.workflow_id || body.workflowId || body.id;
  if (!workflowId) throw new Error('workflow_id is required');

  const workflow = await loadWorkflow(workflowId, env, supabase);
  if (!workflow) return { ok: false, error: 'Workflow not found' };
  if (['succeeded', 'failed', 'cancelled', 'blocked'].includes(workflow.status)) {
    return { ok: true, workflow: summarizeWorkflow(workflow), terminal: true };
  }

  const stepIndex = Number(workflow.current_step_index || 0);
  const step = workflow.steps[stepIndex];
  await appendWorkflowEvent({ workflow_id: workflow.id, type: body.event_type || 'step_completed', step_key: step?.key, payload: body.result || {} }, env, supabase);

  if (body.blocked === true || step?.human_gate === true && body.approved !== true) {
    const patched = await patchWorkflow(workflow.id, { status: 'blocked', blocked_reason: body.reason || 'human_gate_required' }, env, supabase);
    return { ok: true, blocked: true, workflow: summarizeWorkflow(patched) };
  }

  const nextIndex = stepIndex + 1;
  if (nextIndex >= workflow.steps.length) {
    const patched = await patchWorkflow(workflow.id, { status: 'succeeded', current_step_index: nextIndex, finished_at: new Date().toISOString() }, env, supabase);
    await appendWorkflowEvent({ workflow_id: workflow.id, type: 'succeeded', payload: {} }, env, supabase);
    return { ok: true, workflow: summarizeWorkflow(patched), completed: true };
  }

  const patched = await patchWorkflow(workflow.id, { current_step_index: nextIndex, status: 'running' }, env, supabase);
  const enqueue = await enqueueStep(patched, workflow.steps[nextIndex], env, deps, produceJob);
  return { ok: true, workflow: summarizeWorkflow(patched), enqueued: enqueue };
}

export async function resumeWorkflow(body = {}, env = {}, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const workflowId = body.workflow_id || body.workflowId || body.id;
  if (!workflowId) throw new Error('workflow_id is required');
  const workflow = await loadWorkflow(workflowId, env, supabase);
  if (!workflow) return { ok: false, error: 'Workflow not found' };
  const patch = { status: 'running', blocked_reason: null };
  await patchWorkflow(workflow.id, patch, env, supabase);
  await appendWorkflowEvent({ workflow_id: workflow.id, type: 'resumed', payload: { approved_by: body.approved_by || null } }, env, supabase);
  return advanceWorkflow({ workflow_id: workflow.id, approved: true, event_type: 'human_gate_approved' }, env, deps);
}

export async function getWorkflow(body = {}, env = {}, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const workflowId = body.workflow_id || body.workflowId || body.id;
  if (!workflowId) throw new Error('workflow_id is required');
  const workflow = await loadWorkflow(workflowId, env, supabase);
  if (!workflow) return { ok: false, error: 'Workflow not found' };
  const eventsRes = await supabase(env, 'GET', `/rest/v1/workflow_events?workflow_id=eq.${encodeURIComponent(workflowId)}&select=*&order=created_at.asc`);
  const events = eventsRes.ok ? await eventsRes.json() : [];
  return { ok: true, workflow: summarizeWorkflow(workflow, { includeSteps: true, includeInput: true }), events };
}

async function enqueueStep(workflow, step, env, deps, produceJob) {
  if (!step) return null;
  const job = await produceJob({
    client_id: workflow.client_id,
    client_slug: workflow.client_slug,
    session_id: workflow.session_id,
    queue: step.queue || 'default',
    job_type: step.job_type,
    priority: step.priority || 100,
    max_attempts: step.max_attempts || 3,
    created_by: `workflow:${workflow.id}:${step.key}`,
    payload: {
      workflow_id: workflow.id,
      workflow_type: workflow.workflow_type,
      workflow_step_key: step.key,
      workflow_step_index: workflow.current_step_index,
      input: workflow.input || {},
      step_payload: step.payload || {},
    },
  }, env, deps);
  await appendWorkflowEvent({ workflow_id: workflow.id, type: 'step_enqueued', step_key: step.key, job_id: job.job?.id || null, payload: job.job || {} }, env, deps.supabase);
  return job.job;
}

async function loadWorkflow(id, env, supabase) {
  const res = await supabase(env, 'GET', `/rest/v1/workflows?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  if (!res.ok) throw new Error(`Failed to load workflow: ${await safeText(res)}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function patchWorkflow(id, patch, env, supabase) {
  const res = await supabase(env, 'PATCH', `/rest/v1/workflows?id=eq.${encodeURIComponent(id)}`, patch, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to patch workflow: ${await safeText(res)}`);
  return (await res.json())[0];
}

async function appendWorkflowEvent(row, env, supabase) {
  await supabase(env, 'POST', '/rest/v1/workflow_events', row, { Prefer: 'return=minimal' });
}

function summarizeWorkflow(row, opts = {}) {
  const out = {
    id: row.id,
    workflow_type: row.workflow_type,
    client_slug: row.client_slug,
    status: row.status,
    current_step_index: row.current_step_index,
    blocked_reason: row.blocked_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  };
  if (opts.includeSteps) out.steps = row.steps;
  if (opts.includeInput) out.input = row.input;
  return out;
}

function requireDep(value, name) {
  if (!value) throw new Error(`${name} dependency is required`);
  return value;
}
async function safeText(res) { try { return await res.text(); } catch { return ''; } }

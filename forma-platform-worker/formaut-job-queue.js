// =============================================================================
// FORMAUT JOB QUEUE
// =============================================================================
// DB-backed queue for platform work that should not be done inline inside chat:
// product imports, crawls, deploy requests, evidence refreshes, client syncs, etc.
//
// This is intentionally Supabase/Postgres-first so it works in the current
// Cloudflare Worker without needing Cloudflare Queues on day one.
// =============================================================================

const DEFAULT_QUEUE = 'default';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_SECONDS = [30, 120, 300, 900, 1800];

export async function produceJob(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');

  const job = normalizeJobInput(body, deps);
  const row = {
    client_id: job.client_id,
    client_slug: job.client_slug,
    session_id: job.session_id,
    queue: job.queue,
    job_type: job.job_type,
    priority: job.priority,
    payload: job.payload,
    max_attempts: job.max_attempts,
    run_after: job.run_after,
    created_by: job.created_by,
  };

  const res = await supabase(env, 'POST', '/rest/v1/jobs', row, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to create job: ${await safeText(res)}`);
  const created = await res.json();
  await recordJobEvent(supabase, env, created[0].id, 'queued', { created_by: row.created_by, queue: row.queue, job_type: row.job_type });
  return { ok: true, job: summarizeJob(created[0]) };
}

export async function getJobStatus(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const id = body.id || body.job_id || body.jobId;
  if (!id) throw new Error('job id is required');

  const res = await supabase(env, 'GET', `/rest/v1/jobs?id=eq.${encodeURIComponent(id)}&select=*`);
  if (!res.ok) throw new Error(`Failed to load job: ${await safeText(res)}`);
  const rows = await res.json();
  if (!rows.length) return { ok: false, error: 'Job not found' };
  return { ok: true, job: summarizeJob(rows[0], { includePayload: true, includeResult: true }) };
}

export async function listJobs(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const limit = clampInt(body.limit || 20, 1, 100);
  const queue = body.queue ? `&queue=eq.${encodeURIComponent(body.queue)}` : '';
  const status = body.status ? `&status=eq.${encodeURIComponent(body.status)}` : '';
  const client = body.client_slug || body.slug ? `&client_slug=eq.${encodeURIComponent(body.client_slug || body.slug)}` : '';

  const res = await supabase(env, 'GET', `/rest/v1/jobs?select=*&order=created_at.desc&limit=${limit}${queue}${status}${client}`);
  if (!res.ok) throw new Error(`Failed to list jobs: ${await safeText(res)}`);
  const rows = await res.json();
  return { ok: true, jobs: rows.map((row) => summarizeJob(row)) };
}

export async function claimJobs(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const queue = body.queue || DEFAULT_QUEUE;
  const workerId = body.worker_id || body.workerId || `worker-${Date.now()}`;
  const limit = clampInt(body.limit || 1, 1, 25);

  const res = await supabase(env, 'POST', '/rest/v1/rpc/claim_jobs', {
    p_queue: queue,
    p_worker_id: workerId,
    p_limit: limit,
    p_stale_after: body.stale_after || body.staleAfter || '5 minutes',
  }, { Prefer: 'return=representation' });

  if (!res.ok) throw new Error(`Failed to claim jobs: ${await safeText(res)}`);
  const rows = await res.json();
  for (const row of rows) {
    await recordJobEvent(supabase, env, row.id, 'started', { worker_id: workerId, attempt: row.attempts });
  }
  return { ok: true, jobs: rows.map((row) => summarizeJob(row, { includePayload: true })) };
}

export async function updateJobStatus(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const id = body.id || body.job_id || body.jobId;
  if (!id) throw new Error('job id is required');

  const status = normalizeStatus(body.status);
  const patch = { status };

  if (body.result !== undefined) patch.result = body.result;
  if (body.error !== undefined) patch.error = normalizeError(body.error);
  if (body.locked_by || body.worker_id || body.workerId) patch.locked_by = body.locked_by || body.worker_id || body.workerId;
  if (status === 'succeeded' || status === 'failed' || status === 'dead' || status === 'cancelled') {
    patch.finished_at = new Date().toISOString();
    patch.locked_at = null;
    patch.locked_by = null;
  }
  if (status === 'running') patch.last_heartbeat_at = new Date().toISOString();

  const res = await supabase(env, 'PATCH', `/rest/v1/jobs?id=eq.${encodeURIComponent(id)}`, patch, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to update job: ${await safeText(res)}`);
  const rows = await res.json();
  await recordJobEvent(supabase, env, id, status, { result_present: body.result !== undefined, error_present: body.error !== undefined });
  return { ok: true, job: summarizeJob(rows[0], { includeResult: true }) };
}

export async function failOrRetryJob(body, env, deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const id = body.id || body.job_id || body.jobId;
  if (!id) throw new Error('job id is required');

  const currentRes = await supabase(env, 'GET', `/rest/v1/jobs?id=eq.${encodeURIComponent(id)}&select=id,attempts,max_attempts`);
  if (!currentRes.ok) throw new Error(`Failed to load job for retry: ${await safeText(currentRes)}`);
  const rows = await currentRes.json();
  if (!rows.length) return { ok: false, error: 'Job not found' };

  const job = rows[0];
  const attempts = Number(job.attempts || 0);
  const maxAttempts = Number(job.max_attempts || DEFAULT_MAX_ATTEMPTS);
  const shouldRetry = attempts < maxAttempts;
  const delaySeconds = Number(body.delay_seconds || body.delaySeconds || nextBackoffSeconds(attempts));
  const nextRun = new Date(Date.now() + delaySeconds * 1000).toISOString();

  const patch = shouldRetry
    ? {
        status: 'retrying',
        run_after: nextRun,
        locked_at: null,
        locked_by: null,
        error: normalizeError(body.error || body.reason || 'Job failed; scheduled retry'),
      }
    : {
        status: 'dead',
        finished_at: new Date().toISOString(),
        locked_at: null,
        locked_by: null,
        error: normalizeError(body.error || body.reason || 'Job failed; retries exhausted'),
      };

  const res = await supabase(env, 'PATCH', `/rest/v1/jobs?id=eq.${encodeURIComponent(id)}`, patch, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`Failed to mark job failure: ${await safeText(res)}`);
  const updated = await res.json();
  const eventType = shouldRetry ? 'retrying' : 'dead';
  await recordJobEvent(supabase, env, id, eventType, { next_run_after: shouldRetry ? nextRun : null, error: patch.error });
  if (!shouldRetry) {
    await recordDeadLetter(supabase, env, updated[0], patch.error);
  }
  return {
    ok: true,
    retried: shouldRetry,
    next_run_after: shouldRetry ? nextRun : null,
    job: summarizeJob(updated[0], { includeResult: true }),
  };
}

export async function consumeJobs(body, env, deps = {}) {
  const handlers = deps.handlers || defaultJobHandlers(env, deps);
  const claim = await claimJobs(body, env, deps);
  const results = [];

  for (const job of claim.jobs) {
    const handler = handlers[job.job_type];
    if (!handler) {
      results.push(await failOrRetryJob({ id: job.id, error: `No handler registered for job_type '${job.job_type}'` }, env, deps));
      continue;
    }

    try {
      const result = await handler(job, env, deps);
      results.push(await updateJobStatus({ id: job.id, status: 'succeeded', result }, env, deps));
    } catch (err) {
      results.push(await failOrRetryJob({ id: job.id, error: serializeError(err) }, env, deps));
    }
  }

  return { ok: true, claimed: claim.jobs.length, results };
}

function defaultJobHandlers(env, deps) {
  if (deps && deps.handlers) return deps.handlers;
  if (deps && typeof deps.createHandlers === 'function') return deps.createHandlers(env, deps);
  return {
    noop: async (job) => ({ message: 'noop completed', payload: job.payload || {} }),
  };
}

function normalizeJobInput(body = {}, deps = {}) {
  let jobType = body.job_type || body.type;
  if (!jobType) throw new Error('job_type is required');
  if (typeof deps.normalizeJobType === 'function') jobType = deps.normalizeJobType(jobType);

  return {
    client_id: body.client_id || body.clientId || null,
    client_slug: body.client_slug || body.slug || null,
    session_id: body.session_id || body.sessionId || null,
    queue: String(body.queue || DEFAULT_QUEUE).trim() || DEFAULT_QUEUE,
    job_type: String(jobType).trim(),
    priority: clampInt(body.priority || 100, 1, 1000),
    payload: isPlainObject(body.payload) ? body.payload : {},
    max_attempts: clampInt(body.max_attempts || body.maxAttempts || DEFAULT_MAX_ATTEMPTS, 1, 25),
    run_after: body.run_after || body.runAfter || new Date().toISOString(),
    created_by: body.created_by || body.createdBy || 'dashboard',
  };
}

function normalizeStatus(status) {
  const value = String(status || '').trim();
  const allowed = new Set(['queued', 'running', 'succeeded', 'failed', 'retrying', 'dead', 'cancelled']);
  if (!allowed.has(value)) throw new Error(`Invalid job status '${value}'`);
  return value;
}

function summarizeJob(row, opts = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    client_id: row.client_id,
    client_slug: row.client_slug,
    session_id: row.session_id,
    queue: row.queue,
    job_type: row.job_type,
    priority: row.priority,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    run_after: row.run_after,
    locked_by: row.locked_by,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    error: row.error,
  };
  if (opts.includePayload) out.payload = row.payload;
  if (opts.includeResult) out.result = row.result;
  return out;
}

function nextBackoffSeconds(attempts) {
  return DEFAULT_BACKOFF_SECONDS[Math.min(Math.max(attempts - 1, 0), DEFAULT_BACKOFF_SECONDS.length - 1)];
}

function normalizeError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { message: error };
  if (error instanceof Error) return serializeError(error);
  if (isPlainObject(error)) return error;
  return { message: String(error) };
}

function serializeError(err) {
  return { message: err?.message || String(err), stack: err?.stack || null };
}

function requireDep(value, name) {
  if (!value) throw new Error(`Missing queue dependency: ${name}`);
  return value;
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


async function recordJobEvent(supabase, env, jobId, eventType, details = {}) {
  if (!jobId) return;
  try {
    await supabase(env, 'POST', '/rest/v1/job_events', {
      job_id: jobId,
      event_type: String(eventType || 'event'),
      details: details || {},
    });
  } catch (err) {
    console.warn('[jobs] failed to record job event', err?.message || err);
  }
}

async function recordDeadLetter(supabase, env, row, error) {
  if (!row?.id) return;
  try {
    await supabase(env, 'POST', '/rest/v1/jobs_dead_letter', {
      original_job_id: row.id,
      client_id: row.client_id || null,
      client_slug: row.client_slug || null,
      queue: row.queue,
      job_type: row.job_type,
      payload: row.payload || {},
      error: error || row.error || {},
      attempts: row.attempts || 0,
    });
  } catch (err) {
    console.warn('[jobs] failed to record dead letter', err?.message || err);
  }
}

async function safeText(res) {
  try { return await res.text(); } catch { return `${res.status} ${res.statusText}`; }
}

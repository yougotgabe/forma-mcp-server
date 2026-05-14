// =============================================================================
// FORMAUT — PROVISIONING AUDIT LOG
// =============================================================================
// Wraps every provisioning API call (GitHub, Cloudflare, Supabase) with:
//   - Pre-flight idempotency check (skip if resource already exists)
//   - Structured audit log write (before + after)
//   - Teardown support (list resources → delete all for a client)
//
// INTEGRATION: In index.js, import withProvisioningLog and wrap each
// provisioning step inside handleProvision(). See examples at bottom.
//
// SCHEMA: Run provisioning_log_schema.sql in platform Supabase before use.
// =============================================================================

// ---------------------------------------------------------------------------
// MAIN WRAPPER
// Wraps any provisioning operation with idempotency + audit logging.
//
// Usage:
//   const result = await withProvisioningLog({
//     supabase, env,
//     client_id: client.id,
//     client_slug: client.slug,
//     resource_type: 'github_repo',
//     resource_key: `repo:${slug}`,   // stable dedup key — same value on retry
//     operation: 'create',
//     payload: { name: slug, ... },
//   }, async () => {
//     // actual API call — return { resource_id, resource_url, ...response }
//     const res = await fetch('https://api.github.com/user/repos', { ... });
//     return { resource_id: repo.full_name, resource_url: repo.html_url };
//   });
//
//   result.skipped = true  → resource already exists, not re-created
//   result.ok      = true  → created successfully
//   result.ok      = false → failed, error in result.error
// ---------------------------------------------------------------------------

export async function withProvisioningLog({ supabase, env, client_id, client_slug, resource_type, resource_key, operation, payload = {} }, fn) {
  // 1. Idempotency check — has this resource already been provisioned?
  const existing = await findExistingProvisioningLog({ supabase, env, client_id, resource_type, resource_key });
  if (existing) {
    return {
      ok: true,
      skipped: true,
      reason: 'already_provisioned',
      resource_id: existing.resource_id,
      resource_url: existing.resource_url,
      log_id: existing.id,
    };
  }

  // 2. Write "pending" log entry before attempting
  const logId = await writeProvisioningLog({ supabase, env, client_id, client_slug, resource_type, resource_key, operation, status: 'pending', payload });

  // 3. Execute the provisioning function
  let result = null;
  let error = null;
  try {
    result = await fn();
  } catch (err) {
    error = { message: err?.message || String(err), stack: err?.stack || null };
  }

  // 4. Update log with outcome
  const status = error ? 'failed' : 'succeeded';
  await updateProvisioningLog({ supabase, env, logId, status,
    resource_id:  result?.resource_id || null,
    resource_url: result?.resource_url || null,
    response: result || null,
    error: error,
  });

  if (error) {
    return { ok: false, error, log_id: logId };
  }
  return { ok: true, skipped: false, log_id: logId, ...result };
}

// ---------------------------------------------------------------------------
// TEARDOWN
// Lists all provisioned resources for a client and returns a teardown plan.
// Does NOT auto-delete — returns the plan for operator confirmation.
// Call executeProvisioningTeardown() after operator confirms.
// ---------------------------------------------------------------------------

export async function buildProvisioningTeardownPlan(env, client_id, supabase) {
  const res = await supabase(env, 'GET',
    `/rest/v1/provisioning_log?client_id=eq.${enc(client_id)}&status=eq.succeeded&select=id,resource_type,resource_id,resource_url,operation,created_at&order=created_at.desc`
  );
  if (!res.ok) throw new Error(`Failed to load provisioning log: ${await safeText(res)}`);
  const resources = await res.json();

  // Group by resource_type, keep most recent successful entry per type
  const byType = {};
  for (const r of resources) {
    if (!byType[r.resource_type]) byType[r.resource_type] = r;
  }

  return {
    client_id,
    resources: Object.values(byType),
    teardown_steps: Object.values(byType).map(r => ({
      log_id:       r.id,
      resource_type: r.resource_type,
      resource_id:  r.resource_id,
      resource_url: r.resource_url,
      action:       teardownActionFor(r.resource_type),
    })),
    warning: 'Teardown is irreversible. Confirm with operator before executing.',
  };
}

export async function markTeardownComplete(env, log_ids, supabase) {
  for (const id of log_ids) {
    await supabase(env, 'PATCH',
      `/rest/v1/provisioning_log?id=eq.${enc(id)}`,
      { status: 'torn_down', updated_at: new Date().toISOString() },
      { Prefer: 'return=minimal' }
    );
  }
}

// ---------------------------------------------------------------------------
// LIST PROVISIONED RESOURCES
// Returns all provisioning log entries for a client.
// ---------------------------------------------------------------------------

export async function listProvisionedResources(env, client_id, supabase) {
  const res = await supabase(env, 'GET',
    `/rest/v1/provisioning_log?client_id=eq.${enc(client_id)}&select=*&order=created_at.asc`
  );
  if (!res.ok) throw new Error(`Failed to load provisioning log: ${await safeText(res)}`);
  return await res.json();
}

// ---------------------------------------------------------------------------
// INTERNAL HELPERS
// ---------------------------------------------------------------------------

async function findExistingProvisioningLog({ supabase, env, client_id, resource_type, resource_key }) {
  const res = await supabase(env, 'GET',
    `/rest/v1/provisioning_log?client_id=eq.${enc(client_id)}&resource_type=eq.${enc(resource_type)}&resource_key=eq.${enc(resource_key)}&status=eq.succeeded&limit=1&order=created_at.desc`
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function writeProvisioningLog({ supabase, env, client_id, client_slug, resource_type, resource_key, operation, status, payload }) {
  const res = await supabase(env, 'POST', '/rest/v1/provisioning_log', {
    client_id, client_slug, resource_type, resource_key, operation, status,
    payload: payload || {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { Prefer: 'return=representation' });

  if (!res.ok) {
    console.warn('[provision:log] failed to write pending log entry:', await safeText(res));
    return null;
  }
  const rows = await res.json();
  return rows[0]?.id || null;
}

async function updateProvisioningLog({ supabase, env, logId, status, resource_id, resource_url, response, error }) {
  if (!logId) return;
  const patch = {
    status,
    resource_id:  resource_id || null,
    resource_url: resource_url || null,
    response:     response || null,
    error:        error || null,
    updated_at:   new Date().toISOString(),
  };
  const res = await supabase(env, 'PATCH',
    `/rest/v1/provisioning_log?id=eq.${enc(logId)}`,
    patch, { Prefer: 'return=minimal' }
  );
  if (!res.ok) console.warn('[provision:log] failed to update log entry:', logId, await safeText(res));
}

function teardownActionFor(resource_type) {
  const actions = {
    github_repo:        'DELETE https://api.github.com/repos/{owner}/{repo}',
    cloudflare_pages:   'DELETE https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}',
    supabase_project:   'DELETE https://api.supabase.com/v1/projects/{project_id}',
    cloudflare_domain:  'DELETE domain binding via Cloudflare API',
  };
  return actions[resource_type] || `Manual teardown required for resource_type: ${resource_type}`;
}

function enc(v) { return encodeURIComponent(v); }
async function safeText(res) {
  try { return await res.text(); } catch { return `${res.status} ${res.statusText}`; }
}

// =============================================================================
// INTEGRATION EXAMPLE — handleProvision() in index.js
// =============================================================================
//
// import { withProvisioningLog } from './provisioning-audit-log.js';
//
// // Step 1: GitHub repo — was:
// //   const ghRes = await fetch('https://api.github.com/user/repos', { ... });
// //   const repo = await ghRes.json();
//
// // Now:
// const ghResult = await withProvisioningLog({
//   supabase, env,
//   client_id: client.id,
//   client_slug: slug,
//   resource_type: 'github_repo',
//   resource_key: `repo:${slug}`,
//   operation: 'create',
//   payload: { name: slug, description: `Forma client site - ${client.display_name}` },
// }, async () => {
//   const ghRes = await fetch('https://api.github.com/user/repos', {
//     method: 'POST',
//     headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, ... },
//     body: JSON.stringify({ name: slug, private: false, auto_init: true }),
//   });
//   if (!ghRes.ok) throw new Error((await ghRes.json()).message);
//   const repo = await ghRes.json();
//   return { resource_id: repo.full_name, resource_url: repo.html_url, owner: repo.owner.login };
// });
//
// if (!ghResult.ok) { log('github_repo', 'failed', ghResult.error?.message); return ...; }
// if (ghResult.skipped) { log('github_repo', 'skipped', 'already provisioned'); }
// else { log('github_repo', 'ok', ghResult.resource_url); }
//
// // Same pattern for Cloudflare Pages and Supabase steps.

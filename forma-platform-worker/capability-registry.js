// =============================================================================
// FORMAUT CAPABILITY REGISTRY
// forma-platform-worker/capability-registry.js
//
// Shared module — imported by:
//   index.js             (Worker route authorization)
//   forma-mcp-server     (tool scope + tier gating)
//   dashboard endpoints  (entitlement UI data)
//
// Philosophy: reason once (the seed SQL), then enforce deterministically.
// This module never calls Claude. All decisions are lookup + rule evaluation.
//
// Public API:
//   checkCapability(env, capability, clientTier, invokedBy, opts)
//     → { allowed, reason, requires_approval, risk_level }
//
//   auditCapability(env, capability, clientSlug, invokedBy, callerIdentity, outcome, opts)
//     → void (fire-and-forget, never throws)
//
//   listEntitlements(env, clientTier, opts)
//     → { capabilities: [...] }
//
//   getCapability(env, capability)
//     → row | null
// =============================================================================

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Raw Supabase fetch — uses platform service role key.
 * Never sends Authorization: Bearer (breaks new sb_secret_* key format).
 */
async function sb(env, method, path, body) {
  const url = `${env.SUPABASE_URL}${path}`;
  const headers = {
    apikey:          env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type':  'application/json',
    Prefer:          method === 'POST' ? 'return=minimal' : undefined,
  };
  if (!headers.Prefer) delete headers.Prefer;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

// ---------------------------------------------------------------------------
// CAPABILITY LOOKUP
// ---------------------------------------------------------------------------

/**
 * Fetch a single capability row from the registry.
 * Returns null if the capability does not exist or is not enabled.
 *
 * @param {Object} env       - Cloudflare env bindings (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
 * @param {string} capability - capability key, e.g. 'seo_monitor'
 * @returns {Object|null}
 */
export async function getCapability(env, capability) {
  try {
    const res = await sb(
      env, 'GET',
      `/rest/v1/capability_registry?capability=eq.${encodeURIComponent(capability)}&enabled=eq.true&select=*&limit=1`
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// AUTHORIZATION CHECK
// ---------------------------------------------------------------------------

/**
 * Determine whether a client tier is allowed to invoke a capability.
 *
 * @param {Object} env
 * @param {string} capability     - capability key
 * @param {string} clientTier     - 'runtime' | 'standard' | 'pro' | 'operator'
 * @param {string} invokedBy      - 'worker' | 'mcp' | 'dashboard' | 'cron' | 'operator'
 * @param {Object} [opts]
 * @param {boolean} [opts.skipAudit=false]  - skip writing an audit log entry
 * @param {string}  [opts.clientSlug]       - for audit log
 * @param {string}  [opts.callerIdentity]   - email or key prefix, for audit log
 * @returns {{ allowed: boolean, reason: string, requires_approval: boolean, risk_level: string }}
 */
export async function checkCapability(env, capability, clientTier, invokedBy, opts = {}) {
  const cap = await getCapability(env, capability);

  if (!cap) {
    const result = {
      allowed:           false,
      reason:            `Unknown or disabled capability: ${capability}`,
      requires_approval: false,
      risk_level:        'unknown',
    };
    if (!opts.skipAudit) {
      await auditCapability(env, capability, opts.clientSlug, invokedBy,
        opts.callerIdentity, 'blocked_scope', { reason: result.reason });
    }
    return result;
  }

  // Tier normalization
  // Prod currently stores business-type values ('business', 'restaurant', etc.)
  // rather than subscription tier names. Normalize these to 'standard' until
  // the clients table is migrated to use explicit subscription tier values.
  const rawTier = (clientTier || 'standard').toLowerCase();
  const TIER_ALIASES = {
    business:   'standard',
    restaurant: 'standard',
    retail:     'standard',
    service:    'standard',
    freelancer: 'standard',
    nonprofit:  'standard',
    runtime:    'runtime',
    standard:   'standard',
    pro:        'pro',
    operator:   'operator',
  };
  const tier = TIER_ALIASES[rawTier] ?? 'standard';
  const allowed_tiers = cap.available_to_tiers || [];
  if (!allowed_tiers.includes(tier)) {
    const result = {
      allowed:           false,
      reason:            `Capability '${capability}' is not available on the '${tier}' tier. Required: ${allowed_tiers.join(' or ')}.`,
      requires_approval: false,
      risk_level:        cap.risk_level,
    };
    if (!opts.skipAudit) {
      await auditCapability(env, capability, opts.clientSlug, invokedBy,
        opts.callerIdentity, 'blocked_tier', { reason: result.reason });
    }
    return result;
  }

  // MCP-specific gate — runtime tier users calling via MCP must only access mcp-exposed capabilities
  if (invokedBy === 'mcp' && !cap.available_to_mcp) {
    const result = {
      allowed:           false,
      reason:            `Capability '${capability}' is not exposed via MCP.`,
      requires_approval: false,
      risk_level:        cap.risk_level,
    };
    if (!opts.skipAudit) {
      await auditCapability(env, capability, opts.clientSlug, invokedBy,
        opts.callerIdentity, 'blocked_scope', { reason: result.reason });
    }
    return result;
  }

  // Approval gate — dangerous capabilities always require explicit approval
  if (cap.requires_approval && invokedBy !== 'operator') {
    const result = {
      allowed:           false,
      reason:            `Capability '${capability}' requires explicit operator approval before execution.`,
      requires_approval: true,
      risk_level:        cap.risk_level,
    };
    if (!opts.skipAudit) {
      await auditCapability(env, capability, opts.clientSlug, invokedBy,
        opts.callerIdentity, 'blocked_approval', { reason: result.reason });
    }
    return result;
  }

  // Allowed
  if (!opts.skipAudit) {
    await auditCapability(env, capability, opts.clientSlug, invokedBy,
      opts.callerIdentity, 'ok', null);
  }

  return {
    allowed:           true,
    reason:            'ok',
    requires_approval: cap.requires_approval,
    requires_review:   cap.requires_review,
    autonomous_allowed: cap.autonomous_allowed,
    risk_level:        cap.risk_level,
  };
}

// ---------------------------------------------------------------------------
// AUDIT LOGGING
// ---------------------------------------------------------------------------

/**
 * Write a capability audit log entry.
 * Always fire-and-forget — never throws or blocks a request.
 *
 * @param {Object} env
 * @param {string} capability
 * @param {string|null} clientSlug
 * @param {string} invokedBy       - 'worker' | 'mcp' | 'dashboard' | 'cron' | 'operator'
 * @param {string|null} callerIdentity
 * @param {string} outcome         - 'ok' | 'blocked_tier' | 'blocked_approval' | 'blocked_scope' | 'error'
 * @param {Object|null} detail
 * @param {Object} [opts]
 * @param {string} [opts.jobId]
 * @param {string} [opts.sessionId]
 * @param {number} [opts.durationMs]
 */
export async function auditCapability(
  env, capability, clientSlug, invokedBy, callerIdentity,
  outcome, detail = null, opts = {}
) {
  try {
    await sb(env, 'POST', '/rest/v1/capability_audit_logs', {
      capability,
      client_slug:      clientSlug     || null,
      invoked_by:       invokedBy      || 'unknown',
      caller_identity:  callerIdentity || null,
      job_id:           opts.jobId     || null,
      session_id:       opts.sessionId || null,
      outcome,
      outcome_detail:   detail ? JSON.stringify(detail) : null,
      duration_ms:      opts.durationMs || null,
    });
  } catch {
    // Audit failure must never surface to callers.
  }
}

// ---------------------------------------------------------------------------
// ENTITLEMENT LISTING
// ---------------------------------------------------------------------------

/**
 * Return all capabilities available to a given tier.
 * Used by dashboard entitlement panels and MCP tools/list filtering.
 *
 * @param {Object} env
 * @param {string} clientTier   - 'runtime' | 'standard' | 'pro' | 'operator'
 * @param {Object} [opts]
 * @param {boolean} [opts.mcpOnly=false]  - only return MCP-exposed capabilities
 * @returns {{ capabilities: Object[] }}
 */
export async function listEntitlements(env, clientTier, opts = {}) {
  try {
    const rawTier = (clientTier || 'standard').toLowerCase();
    const TIER_ALIASES = { business:'standard',restaurant:'standard',retail:'standard',service:'standard',freelancer:'standard',nonprofit:'standard',runtime:'runtime',standard:'standard',pro:'pro',operator:'operator' };
    const tier = TIER_ALIASES[rawTier] ?? 'standard';
    let url = `/rest/v1/capability_registry?enabled=eq.true&deprecated=eq.false&available_to_tiers=cs.{${encodeURIComponent(tier)}}&select=capability,display_name,description,category,risk_level,autonomous_allowed,requires_review,requires_approval,available_to_mcp,mcp_tool_name,requires_credentials,affected_artifacts,rate_limit_per_hour&order=category.asc,display_name.asc`;
    if (opts.mcpOnly) {
      url += `&available_to_mcp=eq.true`;
    }
    const res = await sb(env, 'GET', url);
    if (!res.ok) return { capabilities: [] };
    const rows = await res.json();
    return { capabilities: rows };
  } catch {
    return { capabilities: [] };
  }
}

// ---------------------------------------------------------------------------
// CAPABILITY KEY CONSTANTS
// ---------------------------------------------------------------------------
// Use these throughout the Worker and MCP server instead of string literals.
// Prevents typo-based auth bypass.

export const CAPS = Object.freeze({
  // Site
  SITE_BUILD:              'site_build',
  SITE_PAGE_EDIT:          'site_page_edit',
  SITE_PUBLISH:            'site_publish',

  // SEO
  SEO_MONITOR:             'seo_monitor',
  SEO_METADATA_UPDATE:     'seo_metadata_update',
  SITEMAP_REBUILD:         'sitemap_rebuild',

  // Deployment
  DEPLOYMENT_VALIDATE:     'deployment_validate',
  DEPLOYMENT_ROLLBACK:     'deployment_rollback',

  // Commerce
  COMMERCE_PRODUCTS_SYNC:  'commerce_products_sync',
  COMMERCE_CHECKOUT_SETUP: 'commerce_checkout_setup',

  // Email
  EMAIL_TEMPLATE_BUILD:    'email_template_build',
  EMAIL_SEND:              'email_send',

  // Memory
  MEMORY_READ:             'memory_read',
  MEMORY_WRITE_PROFILE:    'memory_write_profile',
  MEMORY_CONFLICT_REVIEW:  'memory_conflict_review',

  // Agent interoperability
  AGENT_EXPORT:            'agent_export',
  AGENT_IMPORT_VALIDATE:   'agent_import_validate',
  AGENT_IMPORT_STAGE:      'agent_import_stage',
  AGENT_IMPORT_COMMIT:     'agent_import_commit',

  // Operational
  OPERATIONAL_HEALTH:      'operational_health',
  REMEDIATION_APPROVE:     'remediation_approve',
  CREDENTIAL_READ:         'credential_read',
  CREDENTIAL_WRITE:        'credential_write',

  // Admin
  ADMIN_PANEL_GENERATE:    'admin_panel_generate',
  OPERATOR_PROVISION:      'operator_provision',
  OPERATOR_PLATFORM_QUERY: 'operator_platform_query',
});

// ---------------------------------------------------------------------------
// WORKER ROUTE → CAPABILITY MAP
// ---------------------------------------------------------------------------
// Maps Worker paths to the capability key they invoke.
// Used by the authorization middleware in index.js.
// Paths NOT listed here are either operator-only (checked separately) or
// public (no capability gate needed, e.g. /session preflight).

export const ROUTE_CAPABILITY_MAP = Object.freeze({
  '/chat/cost-gate':                    null,  // internal routing, no cap gate
  '/chat/scope-guard':                  null,  // internal routing
  '/chat/preflight':                    null,  // session start, no cap gate

  '/operational/health':                CAPS.OPERATIONAL_HEALTH,
  '/operational/remediation/approve':   CAPS.REMEDIATION_APPROVE,
  '/operational/deployment/validate':   CAPS.DEPLOYMENT_VALIDATE,

  '/artifacts/publish':                 CAPS.SITE_PUBLISH,
  '/artifacts/rollback':                CAPS.DEPLOYMENT_ROLLBACK,
  '/artifacts/versions/create':         CAPS.SITE_PAGE_EDIT,

  '/signals':                           null,  // write signals — no gate
  '/signals/list':                      null,  // read signals — no gate
  '/signals/promote':                   null,  // promote signal — no gate
  '/signals/dismiss':                   null,  // dismiss signal — no gate

  '/encrypt':                           CAPS.CREDENTIAL_WRITE,
  '/decrypt':                           CAPS.CREDENTIAL_READ,

  '/provision':                         CAPS.OPERATOR_PROVISION,

  '/integrations/printify/sync-products': CAPS.COMMERCE_PRODUCTS_SYNC,
  '/commerce/products':                 CAPS.COMMERCE_PRODUCTS_SYNC,

  '/email/send':                        CAPS.EMAIL_SEND,
  '/email/templates/generate':          CAPS.EMAIL_TEMPLATE_BUILD,

  '/business-profile/confirm-field':    CAPS.MEMORY_WRITE_PROFILE,
  '/business-profile/rollback':         CAPS.MEMORY_WRITE_PROFILE,

  '/agent-import/validate':             CAPS.AGENT_IMPORT_VALIDATE,
  '/agent-import/stage':                CAPS.AGENT_IMPORT_STAGE,
  '/agent-import/commit':               CAPS.AGENT_IMPORT_COMMIT,
  '/agent-import/list':                 CAPS.AGENT_IMPORT_VALIDATE,  // read = validate tier

  '/agent-export/design':               CAPS.AGENT_EXPORT,
  '/agent-export/seo':                  CAPS.AGENT_EXPORT,
  '/agent-export/email':                CAPS.AGENT_EXPORT,
  '/agent-export/commerce':             CAPS.AGENT_EXPORT,
  '/agent-export/implementation':       CAPS.AGENT_EXPORT,

  '/operator/deploys':                  null,  // operator-only, gated by worker secret
  '/operator/env':                      null,  // operator-only
  '/platform/capabilities':             null,  // public entitlement read — no gate
});

// ---------------------------------------------------------------------------
// MCP TOOL → CAPABILITY MAP
// ---------------------------------------------------------------------------
// Maps MCP tool names to the capability key they require.
// Used by the MCP server before dispatching any tool/call.

export const MCP_TOOL_CAPABILITY_MAP = Object.freeze({
  // Operator tools — no capability gate needed (operator key already authorizes)
  list_clients:          null,
  get_client:            null,
  update_client:         null,
  get_session_history:   null,
  write_session_summary: null,
  platform_query:        null,  // operator only — checked at MCP auth layer
  platform_write:        null,  // operator only
  list_files:            null,
  read_file:             null,
  edit_file:             null,
  delete_file:           null,
  trigger_deploy:        null,
  check_deploy_status:   null,
  list_deployments:      null,
  client_query:          null,
  client_write:          null,
  get_signals:           null,
  write_signal:          null,
  get_service_requests:  null,
  update_service_request:null,
  encrypt_credential:    null,
  list_domains:          null,
  add_custom_domain:     null,
  remove_custom_domain:  null,
  deploy_change:         null,
  get_client_context:    null,
  apply_db_change:       null,
  platform_health:       null,
  bulk_file_read:        null,

  // Client-scoped tools — capability gates apply
  who_am_i:              CAPS.MEMORY_READ,
  get_my_context:        CAPS.MEMORY_READ,
  list_my_files:         CAPS.MEMORY_READ,
  read_my_file:          CAPS.MEMORY_READ,
  bulk_read_my_files:    CAPS.MEMORY_READ,
  edit_my_file:          CAPS.SITE_PAGE_EDIT,
  deploy_my_change:      CAPS.SITE_PAGE_EDIT,
  deploy_my_site:        CAPS.SITE_PUBLISH,
  check_my_deploy:       CAPS.DEPLOYMENT_VALIDATE,
  query_my_db:           CAPS.MEMORY_READ,
  update_my_db:          CAPS.MEMORY_WRITE_PROFILE,
});

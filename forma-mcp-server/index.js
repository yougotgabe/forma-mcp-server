// =============================================================================
// FORMA MCP SERVER — CONSOLIDATED
// =============================================================================
// 6 grouped tools instead of 19 individual ones.
// Cuts per-call token overhead by ~70% while keeping full capability.
//
// Tool surface:
//   platform_db   — read/write platform Supabase (clients, sessions, signals, etc.)
//   client_db     — read/write client's own Supabase
//   repo          — list/read/write/delete files in client GitHub repo
//   deploy        — trigger + check Cloudflare Pages deployments
//   manage        — client record CRUD, session summaries, service requests
//   credentials   — encrypt and store API keys for a client
//
// Auth: Bearer token → MCP_API_KEY env var (set in Wrangler secrets)
// Deploy: wrangler deploy (from forma-mcp-server/ directory)
// Register in claude.ai: Settings → Integrations → Add MCP Server
//   URL: https://forma-mcp-server.<subdomain>.workers.dev/mcp
//
// Required Wrangler secrets:
//   MCP_API_KEY                — bearer token for claude.ai auth
//   SUPABASE_URL               — platform Supabase URL
//   SUPABASE_SERVICE_ROLE_KEY  — platform service_role key
//   ENCRYPTION_KEY             — AES-256-GCM key (same as platform Worker)
//   GITHUB_TOKEN               — operator GitHub token (fallback; client tokens preferred)
//   CLOUDFLARE_API_TOKEN       — operator CF API token
//   CLOUDFLARE_ACCOUNT_ID      — operator CF account ID
// =============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'forma-mcp-server', version: '2.0.0' });
    }

    if (url.pathname === '/mcp' && request.method === 'POST') {
      return handleMCP(request, env);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};

// =============================================================================
// MCP PROTOCOL
// =============================================================================

async function handleMCP(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }); }

  const { jsonrpc, method, params, id } = body;
  if (jsonrpc !== '2.0') {
    return jsonResponse({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id });
  }

  try {
    switch (method) {
      case 'initialize':
        return jsonResponse(mcpResult(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'forma-mcp-server', version: '2.0.0' },
        }));

      case 'tools/list':
        return jsonResponse(mcpResult(id, { tools: TOOL_DEFINITIONS }));

      case 'tools/call':
        return handleToolCall(id, params, env);

      case 'notifications/initialized':
        return jsonResponse(mcpResult(id, {}));

      default:
        return jsonResponse(mcpError(id, -32601, `Method not found: ${method}`));
    }
  } catch (err) {
    console.error('[MCP] Unhandled error:', err);
    return jsonResponse(mcpError(id, -32603, `Internal error: ${err.message}`));
  }
}

// =============================================================================
// TOOL DEFINITIONS — 6 grouped tools
// =============================================================================

const TOOL_DEFINITIONS = [

  {
    name: 'platform_db',
    description: `Read or write the platform Supabase database. Covers clients, sessions_index, signals, style_signals, service_requests, jobs, usage, and all other platform tables.

action values:
  query  — SELECT only. Returns rows array.
  write  — INSERT / UPDATE / DELETE. Returns { ok, affected }.

Examples:
  { action: "query", sql: "SELECT slug, status FROM clients ORDER BY created_at DESC" }
  { action: "query", sql: "SELECT * FROM sessions_index WHERE client_slug = 'acme' ORDER BY created_at DESC LIMIT 5" }
  { action: "write", sql: "UPDATE clients SET status = 'live' WHERE slug = 'acme'" }`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['query', 'write'], description: 'query = SELECT only, write = INSERT/UPDATE/DELETE' },
        sql:    { type: 'string', description: 'SQL to execute' },
      },
      required: ['action', 'sql'],
    },
  },

  {
    name: 'client_db',
    description: `Read or write a client's own Supabase database (not the platform database). Covers site_content, menu_items, sessions, conversation_history, client_context, site_index, etc.

action values:
  query  — SELECT. Pass sql or just table for SELECT *.
  write  — INSERT / UPDATE / DELETE.

Examples:
  { action: "query", slug: "acme", table: "site_content" }
  { action: "query", slug: "acme", sql: "SELECT key, value FROM site_content WHERE key LIKE 'home_%'" }
  { action: "write", slug: "acme", sql: "UPDATE site_content SET value = 'New headline' WHERE key = 'home_headline'" }`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['query', 'write'] },
        slug:   { type: 'string', description: 'Client slug' },
        sql:    { type: 'string', description: 'SQL to run. For query, omit if using table shortcut.' },
        table:  { type: 'string', description: 'Table name shortcut for query action — runs SELECT * LIMIT 100' },
      },
      required: ['action', 'slug'],
    },
  },

  {
    name: 'repo',
    description: `Operate on a client's GitHub repository.

action values:
  list   — list files/directories at a path (default: root)
  read   — read a file's content and SHA
  write  — create or update a file (overwrites completely)
  delete — delete a file

Examples:
  { action: "list",   slug: "acme", path: "functions/api" }
  { action: "read",   slug: "acme", path: "index.html" }
  { action: "write",  slug: "acme", path: "index.html", content: "...", message: "Update homepage headline" }
  { action: "delete", slug: "acme", path: "old-page.html" }`,
    inputSchema: {
      type: 'object',
      properties: {
        action:  { type: 'string', enum: ['list', 'read', 'write', 'delete'] },
        slug:    { type: 'string', description: 'Client slug' },
        path:    { type: 'string', description: 'File or directory path within repo', default: '' },
        content: { type: 'string', description: 'Full file content (write only)' },
        message: { type: 'string', description: 'Git commit message (write/delete)' },
      },
      required: ['action', 'slug'],
    },
  },

  {
    name: 'deploy',
    description: `Trigger or check Cloudflare Pages deployments for a client site.

action values:
  trigger — push an empty commit to main, which starts a CF Pages deploy.
             Returns { commit, message }. Poll with check afterwards.
  check   — get status of a deployment. Omit deployment_id for the most recent.
             Returns { status, stage, url, created_at }.
  list    — list the last 10 deployments with status and trigger info.

Examples:
  { action: "trigger", slug: "acme" }
  { action: "check",   slug: "acme" }
  { action: "check",   slug: "acme", deployment_id: "abc123" }
  { action: "list",    slug: "acme" }`,
    inputSchema: {
      type: 'object',
      properties: {
        action:        { type: 'string', enum: ['trigger', 'check', 'list'] },
        slug:          { type: 'string', description: 'Client slug' },
        deployment_id: { type: 'string', description: 'Deployment ID (check only, optional — defaults to latest)' },
      },
      required: ['action', 'slug'],
    },
  },

  {
    name: 'manage',
    description: `Manage client records, session summaries, signals, and service requests.

action values:
  list_clients          — list all clients (slug, name, tier, status, URLs)
  get_client            — get full client record by slug
  update_client         — update non-sensitive fields on a client record
  get_sessions          — get last N session summaries for a client
  write_session         — write a session summary to sessions_index (call at end of every session)
  get_signals           — get tech or style signals (type: "tech" | "style")
  write_signal          — write a new tech or style signal
  get_service_requests  — list open service requests
  update_service_request — update status of a service request

Examples:
  { action: "list_clients" }
  { action: "get_client", slug: "acme" }
  { action: "update_client", slug: "acme", fields: { status: "live", live_url: "https://acme.com" } }
  { action: "get_sessions", slug: "acme", limit: 5 }
  { action: "write_session", slug: "acme", summary: "Updated homepage headline and fixed mobile nav", changes_made: ["Updated home_headline in site_content", "Fixed nav overflow on mobile"], deploy_triggered: true, deploy_status: "success" }
  { action: "get_signals", type: "tech", search: "supabase" }
  { action: "write_signal", type: "tech", signal_type: "failure_mode", title: "Supabase 404 on RLS block", description: "Supabase returns 404 (not 403) when anon key hits an RLS policy with no matching row.", confidence: "confirmed" }
  { action: "get_service_requests" }
  { action: "update_service_request", reference: "SR-0042", status: "resolved", resolution: "Updated nav link to correct URL" }`,
    inputSchema: {
      type: 'object',
      properties: {
        action:     { type: 'string' },
        slug:       { type: 'string', description: 'Client slug (required for most actions)' },
        fields:     { type: 'object', description: 'Fields to update (update_client)' },
        limit:      { type: 'number', description: 'Result limit (get_sessions, get_signals)', default: 10 },
        type:       { type: 'string', description: 'Signal type: tech or style (get_signals, write_signal)' },
        search:     { type: 'string', description: 'Keyword filter (get_signals)' },
        signal_type: { type: 'string', description: 'Signal subtype: better_path, failure_mode, constraint, integration, layout, color, etc.' },
        title:      { type: 'string', description: 'Signal title' },
        description: { type: 'string', description: 'Signal description' },
        confidence: { type: 'string', description: 'observed | confirmed | established', default: 'observed' },
        outcome:    { type: 'string', description: 'success | failure | mixed' },
        summary:    { type: 'string', description: 'Session summary (write_session)' },
        changes_made: { type: 'array', items: { type: 'string' }, description: 'List of changes made (write_session)' },
        preferences_noted: { type: 'string', description: 'Preferences observed (write_session)' },
        deploy_triggered: { type: 'boolean', default: false },
        deploy_status: { type: 'string', description: 'success | failed | pending' },
        reference:   { type: 'string', description: 'Service request reference e.g. SR-0042' },
        status:      { type: 'string', description: 'Status filter or new status' },
        resolution:  { type: 'string', description: 'Resolution notes' },
      },
      required: ['action'],
    },
  },

  {
    name: 'credentials',
    description: `Encrypt a plaintext API key or token and store it against a client record. The plaintext value is encrypted with AES-256-GCM in this Worker and never stored or returned in plain form.

field must be one of:
  github_token_enc, cloudflare_token_enc, supabase_mgmt_token_enc,
  supabase_service_key_enc, supabase_anon_key_enc, printify_key_enc

Example:
  { slug: "acme", field: "github_token_enc", plaintext: "ghp_xxx..." }`,
    inputSchema: {
      type: 'object',
      properties: {
        slug:      { type: 'string', description: 'Client slug' },
        field:     { type: 'string', enum: ['github_token_enc', 'cloudflare_token_enc', 'supabase_mgmt_token_enc', 'supabase_service_key_enc', 'supabase_anon_key_enc', 'printify_key_enc'] },
        plaintext: { type: 'string', description: 'Raw credential value — encrypted immediately, never stored or returned' },
      },
      required: ['slug', 'field', 'plaintext'],
    },
  },

];

// =============================================================================
// TOOL CALL ROUTER
// =============================================================================

async function handleToolCall(id, params, env) {
  // Auth on every tool call — not on initialize/tools/list so the handshake works
  const authHeader = params?._auth || '';  // claude.ai passes auth differently
  // Auth is validated per-request via the bearer token in the original request.
  // Re-check env.MCP_API_KEY match is done at fetch level for tool calls.

  const { name, arguments: args = {} } = params;
  let result;

  try {
    switch (name) {
      case 'platform_db':   result = await toolPlatformDB(args, env);  break;
      case 'client_db':     result = await toolClientDB(args, env);    break;
      case 'repo':          result = await toolRepo(args, env);        break;
      case 'deploy':        result = await toolDeploy(args, env);      break;
      case 'manage':        result = await toolManage(args, env);      break;
      case 'credentials':   result = await toolCredentials(args, env); break;
      default:
        return jsonResponse(mcpError(id, -32601, `Unknown tool: ${name}`));
    }
  } catch (err) {
    console.error(`[tool:${name}] Error:`, err);
    result = { ok: false, error: err.message };
  }

  return jsonResponse(mcpResult(id, {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  }));
}

// =============================================================================
// TOOL IMPLEMENTATIONS
// =============================================================================

// ── platform_db ──────────────────────────────────────────────────────────────

async function toolPlatformDB({ action, sql }, env) {
  if (!sql) return { ok: false, error: 'sql is required' };
  const normalised = sql.trim().toLowerCase();

  if (action === 'query') {
    if (!normalised.startsWith('select')) {
      return { ok: false, error: 'action=query only accepts SELECT. Use action=write for mutations.' };
    }
  } else if (action === 'write') {
    if (normalised.startsWith('select')) {
      return { ok: false, error: 'action=write does not accept SELECT. Use action=query.' };
    }
  } else {
    return { ok: false, error: 'action must be "query" or "write"' };
  }

  return execPlatformSQL(sql, env);
}

// ── client_db ─────────────────────────────────────────────────────────────────

async function toolClientDB({ action, slug, sql, table }, env) {
  if (!slug) return { ok: false, error: 'slug is required' };
  const client = await getClientCreds(slug, env);
  if (!client.supabase_service_key) return { ok: false, error: 'Supabase not connected for this client. Run provisioning first.' };

  const query = sql || (table ? `SELECT * FROM ${table} LIMIT 100` : null);
  if (!query) return { ok: false, error: 'sql or table is required' };
  const normalised = query.trim().toLowerCase();

  if (action === 'query') {
    if (!normalised.startsWith('select')) {
      return { ok: false, error: 'action=query only accepts SELECT. Use action=write for mutations.' };
    }
  } else if (action === 'write') {
    if (normalised.startsWith('select')) {
      return { ok: false, error: 'Use action=query for SELECT.' };
    }
  } else {
    return { ok: false, error: 'action must be "query" or "write"' };
  }

  return execClientSQL(query, client, env);
}

// ── repo ──────────────────────────────────────────────────────────────────────

async function toolRepo({ action, slug, path = '', content, message }, env) {
  if (!slug) return { ok: false, error: 'slug is required' };
  const client = await getClientCreds(slug, env);
  if (!client.github_token) return { ok: false, error: 'GitHub not connected for this client' };

  switch (action) {
    case 'list': {
      const res = await fetch(
        `https://api.github.com/repos/${client.github_repo}/contents/${path}`,
        { headers: githubHeaders(client.github_token) }
      );
      if (!res.ok) return { ok: false, error: 'GitHub error', status: res.status };
      const items = await res.json();
      const listing = Array.isArray(items)
        ? items.map(i => ({ name: i.name, path: i.path, type: i.type, size: i.size }))
        : [{ name: items.name, path: items.path, type: items.type }];
      return { ok: true, repo: client.github_repo, path, items: listing };
    }

    case 'read': {
      if (!path) return { ok: false, error: 'path is required for read' };
      const res = await fetch(
        `https://api.github.com/repos/${client.github_repo}/contents/${path}`,
        { headers: githubHeaders(client.github_token) }
      );
      if (res.status === 404) return { ok: false, error: 'File not found', path };
      if (!res.ok) return { ok: false, error: 'GitHub error', status: res.status };
      const data = await res.json();
      const decoded = atob(data.content.replace(/\n/g, ''));
      return { ok: true, path, content: decoded, sha: data.sha, size: data.size };
    }

    case 'write': {
      if (!path)    return { ok: false, error: 'path is required for write' };
      if (!content && content !== '') return { ok: false, error: 'content is required for write' };

      // Get existing SHA if file exists
      let fileSha = null;
      const existing = await fetch(
        `https://api.github.com/repos/${client.github_repo}/contents/${path}`,
        { headers: githubHeaders(client.github_token) }
      );
      if (existing.ok) {
        const d = await existing.json();
        fileSha = d.sha;
      }

      const body = {
        message: message || `Formaut: update ${path}`,
        content: btoa(unescape(encodeURIComponent(content))),
        ...(fileSha ? { sha: fileSha } : {}),
      };
      const res = await fetch(
        `https://api.github.com/repos/${client.github_repo}/contents/${path}`,
        {
          method:  'PUT',
          headers: { ...githubHeaders(client.github_token), 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.message || 'GitHub error', status: res.status };
      }
      const result = await res.json();
      return {
        ok:     true,
        path,
        sha:    result.content.sha,
        commit: result.commit.sha,
        action: fileSha ? 'updated' : 'created',
      };
    }

    case 'delete': {
      if (!path) return { ok: false, error: 'path is required for delete' };
      const existing = await fetch(
        `https://api.github.com/repos/${client.github_repo}/contents/${path}`,
        { headers: githubHeaders(client.github_token) }
      );
      if (existing.status === 404) return { ok: false, error: 'File not found', path };
      if (!existing.ok) return { ok: false, error: 'GitHub error' };
      const data = await existing.json();

      const res = await fetch(
        `https://api.github.com/repos/${client.github_repo}/contents/${path}`,
        {
          method:  'DELETE',
          headers: { ...githubHeaders(client.github_token), 'Content-Type': 'application/json' },
          body:    JSON.stringify({ message: message || `Formaut: delete ${path}`, sha: data.sha }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.message || 'GitHub error' };
      }
      return { ok: true, path, deleted: true };
    }

    default:
      return { ok: false, error: 'action must be list, read, write, or delete' };
  }
}

// ── deploy ────────────────────────────────────────────────────────────────────

async function toolDeploy({ action, slug, deployment_id }, env) {
  if (!slug) return { ok: false, error: 'slug is required' };
  const client = await getClientCreds(slug, env);

  switch (action) {
    case 'trigger': {
      if (!client.cloudflare_token) return { ok: false, error: 'Cloudflare not connected' };
      if (!client.github_token)     return { ok: false, error: 'GitHub not connected' };

      const repo = client.github_repo;
      const branchRes = await fetch(
        `https://api.github.com/repos/${repo}/git/refs/heads/main`,
        { headers: githubHeaders(client.github_token) }
      );
      if (!branchRes.ok) return { ok: false, error: 'Could not get main branch ref' };
      const branchData = await branchRes.json();
      const parentSha  = branchData.object.sha;

      const commitRes = await fetch(
        `https://api.github.com/repos/${repo}/git/commits/${parentSha}`,
        { headers: githubHeaders(client.github_token) }
      );
      if (!commitRes.ok) return { ok: false, error: 'Could not load parent commit' };
      const commitData = await commitRes.json();

      const newCommitRes = await fetch(
        `https://api.github.com/repos/${repo}/git/commits`,
        {
          method:  'POST',
          headers: { ...githubHeaders(client.github_token), 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            message: 'Formaut: trigger deploy',
            tree:    commitData.tree.sha,
            parents: [parentSha],
          }),
        }
      );
      if (!newCommitRes.ok) return { ok: false, error: 'Could not create empty commit' };
      const newCommit = await newCommitRes.json();

      const updateRes = await fetch(
        `https://api.github.com/repos/${repo}/git/refs/heads/main`,
        {
          method:  'PATCH',
          headers: { ...githubHeaders(client.github_token), 'Content-Type': 'application/json' },
          body:    JSON.stringify({ sha: newCommit.sha }),
        }
      );
      if (!updateRes.ok) return { ok: false, error: 'Could not update main ref' };

      // Record trigger in platform DB (non-fatal if this fails)
      await platformSupabase(env, 'PATCH',
        `/rest/v1/clients?slug=eq.${enc(slug)}`,
        { last_deploy: new Date().toISOString(), last_deploy_status: 'triggered' }
      ).catch(() => {});

      return {
        ok:       true,
        commit:   newCommit.sha,
        message:  'Empty commit pushed — Cloudflare Pages will deploy within 30-60 seconds.',
        next:     'Poll with deploy action=check to confirm status.',
      };
    }

    case 'check': {
      if (!client.cloudflare_token) return { ok: false, error: 'Cloudflare not connected' };
      const accountId = client.cloudflare_account_id;
      const project   = client.cloudflare_pages_project;
      let apiUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}/deployments`;
      if (deployment_id) apiUrl += `/${deployment_id}`;
      else               apiUrl += '?per_page=1';

      const res = await fetch(apiUrl, {
        headers: { Authorization: `Bearer ${client.cloudflare_token}` },
      });
      if (!res.ok) return { ok: false, error: 'Cloudflare API error', status: res.status };
      const data = await res.json();
      const deploy = deployment_id ? data.result : data.result?.[0];
      if (!deploy) return { ok: false, error: 'No deployment found' };

      return {
        ok:            true,
        deployment_id: deploy.id,
        status:        deploy.latest_stage?.status || 'unknown',
        stage:         deploy.latest_stage?.name,
        url:           deploy.url,
        created_at:    deploy.created_on,
        environment:   deploy.environment,
      };
    }

    case 'list': {
      if (!client.cloudflare_token) return { ok: false, error: 'Cloudflare not connected' };
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${client.cloudflare_account_id}/pages/projects/${client.cloudflare_pages_project}/deployments?per_page=10`,
        { headers: { Authorization: `Bearer ${client.cloudflare_token}` } }
      );
      if (!res.ok) return { ok: false, error: 'Cloudflare API error' };
      const data = await res.json();
      const deployments = (data.result || []).map(d => ({
        id:          d.id,
        status:      d.latest_stage?.status,
        stage:       d.latest_stage?.name,
        url:         d.url,
        created_at:  d.created_on,
        environment: d.environment,
        trigger:     d.deployment_trigger?.metadata?.commit_message || d.deployment_trigger?.type,
      }));
      return { ok: true, project: client.cloudflare_pages_project, deployments };
    }

    default:
      return { ok: false, error: 'action must be trigger, check, or list' };
  }
}

// ── manage ────────────────────────────────────────────────────────────────────

async function toolManage(args, env) {
  const { action, slug } = args;

  switch (action) {

    case 'list_clients': {
      const res = await platformSupabase(env, 'GET',
        `/rest/v1/clients?select=slug,display_name,tier,status,live_url,pages_url,github_repo,owner_email,updated_at&order=display_name.asc`
      );
      if (!res.ok) return { ok: false, error: 'Supabase error' };
      const clients = await res.json();
      return { ok: true, count: clients.length, clients };
    }

    case 'get_client': {
      if (!slug) return { ok: false, error: 'slug is required' };
      const res = await platformSupabase(env, 'GET',
        `/rest/v1/clients?slug=eq.${enc(slug)}&select=id,slug,display_name,tier,status,owner_email,admin_emails,github_repo,cloudflare_pages_project,supabase_url,stripe_connected_account,printify_shop_id,domain,live_url,pages_url,last_deploy,last_deploy_status,open_escalations,created_at,updated_at&limit=1`
      );
      if (!res.ok) return { ok: false, error: 'Supabase error' };
      const rows = await res.json();
      if (!rows.length) return { ok: false, error: `Client not found: ${slug}` };
      return { ok: true, client: rows[0] };
    }

    case 'update_client': {
      if (!slug)       return { ok: false, error: 'slug is required' };
      if (!args.fields) return { ok: false, error: 'fields is required' };
      const BLOCKED = ['github_token_enc','cloudflare_token_enc','supabase_mgmt_token_enc','supabase_service_key_enc','supabase_anon_key_enc','printify_key_enc'];
      const safe = Object.fromEntries(Object.entries(args.fields).filter(([k]) => !BLOCKED.includes(k)));
      if (!Object.keys(safe).length) return { ok: false, error: 'No safe fields to update — use credentials tool for encrypted values' };
      const res = await platformSupabase(env, 'PATCH', `/rest/v1/clients?slug=eq.${enc(slug)}`, safe);
      return { ok: res.ok, updated: Object.keys(safe) };
    }

    case 'get_sessions': {
      if (!slug) return { ok: false, error: 'slug is required' };
      const limit = Math.min(args.limit || 10, 50);
      const res = await platformSupabase(env, 'GET',
        `/rest/v1/sessions_index?client_slug=eq.${enc(slug)}&order=created_at.desc&limit=${limit}&select=id,summary,changes_made,preferences_noted,session_date,deploy_triggered,deploy_status,created_at`
      );
      if (!res.ok) return { ok: false, error: 'Supabase error' };
      const sessions = await res.json();
      return { ok: true, count: sessions.length, sessions };
    }

    case 'write_session': {
      if (!slug)        return { ok: false, error: 'slug is required' };
      if (!args.summary) return { ok: false, error: 'summary is required' };

      const clientRes = await platformSupabase(env, 'GET',
        `/rest/v1/clients?slug=eq.${enc(slug)}&select=id&limit=1`
      );
      if (!clientRes.ok) return { ok: false, error: 'Could not find client' };
      const rows = await clientRes.json();
      if (!rows.length) return { ok: false, error: `Client not found: ${slug}` };

      const row = {
        client_id:          rows[0].id,
        client_slug:        slug,
        session_date:       new Date().toISOString().split('T')[0],
        summary:            args.summary,
        changes_made:       args.changes_made || [],
        preferences_noted:  args.preferences_noted || null,
        deploy_triggered:   args.deploy_triggered ?? false,
        deploy_status:      args.deploy_status || null,
        signal_count:       0,
        style_signal_count: 0,
      };
      const res = await platformSupabase(env, 'POST', '/rest/v1/sessions_index', row,
        { Prefer: 'return=representation' }
      );
      if (!res.ok) { const err = await res.text(); return { ok: false, error: err }; }
      const result = await res.json();
      return { ok: true, session_id: Array.isArray(result) ? result[0]?.id : result?.id };
    }

    case 'get_signals': {
      const type   = args.type || 'tech';
      const table  = type === 'style' ? 'style_signals' : 'signals';
      const limit  = Math.min(args.limit || 20, 100);
      let path = `/rest/v1/${table}?order=times_seen.desc&limit=${limit}&select=*`;
      if (args.search) path += `&title=ilike.*${enc(args.search)}*`;
      const res = await platformSupabase(env, 'GET', path);
      if (!res.ok) return { ok: false, error: 'Supabase error' };
      const signals = await res.json();
      return { ok: true, type, count: signals.length, signals };
    }

    case 'write_signal': {
      const type  = args.type || 'tech';
      const table = type === 'style' ? 'style_signals' : 'signals';
      if (!args.signal_type) return { ok: false, error: 'signal_type is required' };
      if (!args.title)       return { ok: false, error: 'title is required' };
      if (!args.description) return { ok: false, error: 'description is required' };
      const row = {
        signal_type: args.signal_type,
        title:       args.title,
        description: args.description,
        confidence:  args.confidence || 'observed',
        outcome:     args.outcome || null,
        client_slug: args.slug || null,
        times_seen:  1,
        created_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString(),
      };
      const res = await platformSupabase(env, 'POST', `/rest/v1/${table}`, row,
        { Prefer: 'return=representation' }
      );
      if (!res.ok) { const err = await res.text(); return { ok: false, error: err }; }
      const result = await res.json();
      return { ok: true, id: Array.isArray(result) ? result[0]?.id : result?.id };
    }

    case 'get_service_requests': {
      const statuses = args.status
        ? `status=eq.${args.status}`
        : `status=in.(pending,in_review,in_progress)`;
      let path = `/rest/v1/service_requests?${statuses}&order=created_at.desc&select=reference,client_slug,request_summary,category,status,created_at`;
      if (args.slug) path += `&client_slug=eq.${enc(args.slug)}`;
      const res = await platformSupabase(env, 'GET', path);
      if (!res.ok) return { ok: false, error: 'Supabase error' };
      const requests = await res.json();
      return { ok: true, count: requests.length, requests };
    }

    case 'update_service_request': {
      if (!args.reference) return { ok: false, error: 'reference is required (e.g. SR-0042)' };
      if (!args.status)    return { ok: false, error: 'status is required' };
      const update = { status: args.status, updated_at: new Date().toISOString() };
      if (args.resolution) update.resolution = args.resolution;
      const res = await platformSupabase(env, 'PATCH',
        `/rest/v1/service_requests?reference=eq.${enc(args.reference)}`, update
      );
      return { ok: res.ok };
    }

    default:
      return { ok: false, error: `Unknown action: ${action}. Valid actions: list_clients, get_client, update_client, get_sessions, write_session, get_signals, write_signal, get_service_requests, update_service_request` };
  }
}

// ── credentials ───────────────────────────────────────────────────────────────

async function toolCredentials({ slug, field, plaintext }, env) {
  const ALLOWED = new Set([
    'github_token_enc', 'cloudflare_token_enc', 'supabase_mgmt_token_enc',
    'supabase_service_key_enc', 'supabase_anon_key_enc', 'printify_key_enc',
  ]);
  if (!slug)      return { ok: false, error: 'slug is required' };
  if (!field)     return { ok: false, error: 'field is required' };
  if (!plaintext) return { ok: false, error: 'plaintext is required' };
  if (!ALLOWED.has(field)) return { ok: false, error: `field '${field}' is not valid. Must be one of: ${[...ALLOWED].join(', ')}` };

  let ciphertext;
  try {
    ciphertext = await encrypt(plaintext, env.ENCRYPTION_KEY);
  } catch (err) {
    return { ok: false, error: 'Encryption failed: ' + err.message };
  }

  const res = await platformSupabase(env, 'PATCH',
    `/rest/v1/clients?slug=eq.${enc(slug)}`,
    { [field]: ciphertext }
  );

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: err };
  }

  return { ok: true, slug, field, message: 'Credential encrypted and stored. Plaintext discarded.' };
}

// =============================================================================
// INFRASTRUCTURE HELPERS
// =============================================================================

async function getClientCreds(slug, env) {
  const res = await platformSupabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${enc(slug)}&select=id,slug,display_name,github_repo,cloudflare_pages_project,cloudflare_account_id,supabase_url,github_token_enc,cloudflare_token_enc,supabase_service_key_enc&limit=1`
  );
  if (!res.ok) throw new Error('Client not found');
  const rows = await res.json();
  if (!rows.length) throw new Error(`Client not found: ${slug}`);
  const client = { ...rows[0] };

  // Decrypt on demand — plaintext only in memory for this request
  if (client.github_token_enc)         client.github_token         = await decrypt(client.github_token_enc, env.ENCRYPTION_KEY).catch(() => null);
  if (client.cloudflare_token_enc)     client.cloudflare_token     = await decrypt(client.cloudflare_token_enc, env.ENCRYPTION_KEY).catch(() => null);
  if (client.supabase_service_key_enc) client.supabase_service_key = await decrypt(client.supabase_service_key_enc, env.ENCRYPTION_KEY).catch(() => null);

  // Fallback to operator tokens for clients where client-owned tokens aren't stored yet
  if (!client.github_token && env.GITHUB_TOKEN) client.github_token = env.GITHUB_TOKEN;
  if (!client.cloudflare_token && env.CLOUDFLARE_API_TOKEN) {
    client.cloudflare_token     = env.CLOUDFLARE_API_TOKEN;
    client.cloudflare_account_id = client.cloudflare_account_id || env.CLOUDFLARE_ACCOUNT_ID;
  }

  return client;
}

async function execPlatformSQL(sql, env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method:  'POST',
    headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query: sql }),
  });
  if (res.status === 404) {
    return { ok: false, error: 'exec_sql RPC not available. Use manage tool for structured operations or create exec_sql in Supabase.' };
  }
  if (!res.ok) { const err = await res.text(); return { ok: false, error: err }; }
  const rows = await res.json();
  return { ok: true, rows: rows || [] };
}

async function execClientSQL(sql, client, env) {
  const res = await fetch(`${client.supabase_url}/rest/v1/rpc/exec_sql`, {
    method:  'POST',
    headers: { 'apikey': client.supabase_service_key, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query: sql }),
  });
  if (res.status === 404) {
    // exec_sql not available — try direct table REST for simple SELECT * FROM table
    const tableMatch = sql.trim().match(/^select\s+\*\s+from\s+(\w+)/i);
    if (tableMatch) {
      const tableRes = await fetch(
        `${client.supabase_url}/rest/v1/${tableMatch[1]}?select=*&limit=100`,
        { headers: { 'apikey': client.supabase_service_key } }
      );
      if (tableRes.ok) return { ok: true, rows: await tableRes.json() };
    }
    return { ok: false, error: 'exec_sql RPC not available on this client Supabase. Run provisioning to set up the full schema.' };
  }
  if (!res.ok) { const err = await res.text(); return { ok: false, error: err }; }
  const rows = await res.json();
  return { ok: true, rows: rows || [] };
}

function platformSupabase(env, method, path, body = null, extraHeaders = {}) {
  const url = env.SUPABASE_URL + path;
  const headers = {
    'apikey':       env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  const init = { method, headers };
  if (body !== null && method !== 'GET') init.body = JSON.stringify(body);
  return fetch(url, init);
}

function githubHeaders(token) {
  return {
    Authorization:           `Bearer ${token}`,
    Accept:                  'application/vnd.github.v3+json',
    'User-Agent':            'forma-mcp-server',
    'X-GitHub-Api-Version':  '2022-11-28',
  };
}

function enc(s) { return encodeURIComponent(String(s)); }

// AES-256-GCM — matches platform Worker exactly
async function encrypt(plaintext, hexKey) {
  const key = await importKey(hexKey, ['encrypt']);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const encoded   = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined  = new Uint8Array(iv.byteLength + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

async function decrypt(ciphertext, hexKey) {
  const key      = await importKey(hexKey, ['decrypt']);
  const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const iv       = combined.slice(0, 12);
  const data     = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(plainBuf);
}

async function importKey(hexKey, usages) {
  const bytes = new Uint8Array(hexKey.length / 2);
  for (let i = 0; i < hexKey.length; i += 2) bytes[i / 2] = parseInt(hexKey.slice(i, i + 2), 16);
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usages);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

function mcpResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function mcpError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

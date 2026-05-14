// =============================================================================
// FORMAUT — CLIENT API TOKEN SYSTEM
// Per-client API tokens scoped to specific operations.
// Separate from MCP tokens. For programmatic access to site data.
//
// Worker endpoints (register in index.js):
//   POST /client-api/tokens/create
//   POST /client-api/tokens/list
//   POST /client-api/tokens/revoke
//   POST /client-api/tokens/rotate
//   POST /client-api/tokens/verify      (used by client Workers internally)
//   POST /client-api/tokens/audit
//   POST /client-api/openapi            (returns generated OpenAPI spec for this client)
//
// Schema: see client_api_tokens table in platform-schema.sql additions below
// =============================================================================

// ---------------------------------------------------------------------------
// TOKEN SCOPES
// A token can be granted one or more scopes. The scope list shown to clients
// uses plain English labels.
// ---------------------------------------------------------------------------

export const CLIENT_API_SCOPES = {
  // Site content — read/write the site_content table
  'content:read':      { label: 'Read site content', description: 'Read current site content (text, settings, data).' },
  'content:write':     { label: 'Update site content', description: 'Update editable site content (same as admin panel).' },

  // Services
  'services:read':     { label: 'Read services', description: 'List services defined on your site.' },
  'services:write':    { label: 'Update services', description: 'Add, edit, or remove services.' },

  // Testimonials
  'testimonials:read': { label: 'Read testimonials', description: 'List customer testimonials.' },
  'testimonials:write':{ label: 'Manage testimonials', description: 'Add, edit, or remove testimonials.' },

  // Hours
  'hours:read':        { label: 'Read hours', description: 'Read business hours.' },
  'hours:write':       { label: 'Update hours', description: 'Update business hours.' },

  // Announcements
  'announcements:read': { label: 'Read announcement', description: 'Read the current announcement banner.' },
  'announcements:write':{ label: 'Update announcement', description: 'Show, hide, or change the announcement banner.' },

  // SEO
  'seo:read':          { label: 'Read SEO settings', description: 'Read page titles, descriptions, and keywords.' },
  'seo:write':         { label: 'Update SEO settings', description: 'Update page titles, descriptions, and keywords.' },

  // Jobs
  'jobs:read':         { label: 'View jobs', description: 'Read the status of Formaut jobs for your site.' },

  // Webhooks (future)
  'webhooks:read':     { label: 'View webhooks', description: 'List registered webhook endpoints.' },
  'webhooks:write':    { label: 'Manage webhooks', description: 'Register or remove webhook endpoints.' },
};

// Convenience scope bundles a client might request
export const SCOPE_BUNDLES = {
  readonly:   ['content:read', 'services:read', 'testimonials:read', 'hours:read', 'announcements:read', 'seo:read'],
  content:    ['content:read', 'content:write', 'services:read', 'services:write', 'testimonials:read', 'testimonials:write', 'hours:read', 'hours:write', 'announcements:read', 'announcements:write'],
  seo:        ['seo:read', 'seo:write'],
  full:       Object.keys(CLIENT_API_SCOPES),
};

// ---------------------------------------------------------------------------
// 1. TOKEN CREATION
// ---------------------------------------------------------------------------

/**
 * POST /client-api/tokens/create
 * Body: { slug, label, scopes, expires_in_days? }
 * Returns: { token, token_id, scopes, expires_at }
 *
 * The raw token is returned ONCE and never stored. We store a SHA-256 hash.
 */
export async function handleClientApiTokenCreate(body, env) {
  const { slug, label, scopes, expires_in_days } = body;

  if (!slug) return jsonError('slug required', 400);
  if (!label || !label.trim()) return jsonError('label required', 400);
  if (!scopes || !Array.isArray(scopes) || scopes.length === 0) return jsonError('scopes required (array)', 400);

  // Validate scopes
  const invalid = scopes.filter(s => !CLIENT_API_SCOPES[s] && !expandBundle(s));
  if (invalid.length) return jsonError(`Unknown scopes: ${invalid.join(', ')}`, 400);

  // Expand any bundle names
  const expandedScopes = [...new Set(scopes.flatMap(s => expandBundle(s) || [s]))];

  // Generate token: fmt_live_<random 32 bytes base64url>
  const raw = await generateToken();
  const hash = await sha256hex(raw);

  const expires_at = expires_in_days
    ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
    : null;

  // Store hashed token in platform DB
  const record = {
    client_slug: slug,
    token_hash: hash,
    token_prefix: raw.slice(0, 16), // for display without revealing full token
    label: label.trim(),
    scopes: expandedScopes,
    expires_at,
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked: false,
    revoked_at: null,
    revoked_reason: null,
    use_count: 0,
  };

  const insertRes = await supabasePost(env, '/rest/v1/client_api_tokens?select=id', record);
  const insertData = insertRes.ok ? await insertRes.json() : null;
  const token_id = insertData?.[0]?.id;

  // Audit log
  await auditLog(env, slug, 'token_created', { label, scopes: expandedScopes, expires_at });

  return json({
    ok: true,
    token: raw,   // shown ONCE — client must store it
    token_id,
    token_prefix: raw.slice(0, 16),
    label,
    scopes: expandedScopes,
    expires_at,
    warning: 'Store this token now. It will not be shown again.',
  });
}

// ---------------------------------------------------------------------------
// 2. TOKEN LIST
// ---------------------------------------------------------------------------

export async function handleClientApiTokenList(body, env) {
  const { slug } = body;
  if (!slug) return jsonError('slug required', 400);

  const res = await supabaseGet(env,
    `/rest/v1/client_api_tokens?client_slug=eq.${slug}&revoked=eq.false&order=created_at.desc&select=id,label,token_prefix,scopes,expires_at,created_at,last_used_at,use_count`
  );

  return json({ ok: true, tokens: res || [] });
}

// ---------------------------------------------------------------------------
// 3. TOKEN REVOKE
// ---------------------------------------------------------------------------

export async function handleClientApiTokenRevoke(body, env) {
  const { slug, token_id, reason } = body;
  if (!slug || !token_id) return jsonError('slug and token_id required', 400);

  // Verify token belongs to this slug
  const existing = await supabaseGet(env,
    `/rest/v1/client_api_tokens?id=eq.${token_id}&client_slug=eq.${slug}&select=id,label&limit=1`
  );
  if (!existing?.[0]) return jsonError('token not found', 404);

  await supabasePatch(env, `/rest/v1/client_api_tokens?id=eq.${token_id}`, {
    revoked: true,
    revoked_at: new Date().toISOString(),
    revoked_reason: reason || 'manual_revocation',
  });

  await auditLog(env, slug, 'token_revoked', { token_id, label: existing[0].label, reason });

  return json({ ok: true, token_id, revoked: true });
}

// ---------------------------------------------------------------------------
// 4. TOKEN ROTATE
// Revokes old token, creates new one with same scopes and label.
// ---------------------------------------------------------------------------

export async function handleClientApiTokenRotate(body, env) {
  const { slug, token_id } = body;
  if (!slug || !token_id) return jsonError('slug and token_id required', 400);

  const existing = await supabaseGet(env,
    `/rest/v1/client_api_tokens?id=eq.${token_id}&client_slug=eq.${slug}&select=*&limit=1`
  );
  const old = existing?.[0];
  if (!old) return jsonError('token not found', 404);
  if (old.revoked) return jsonError('token already revoked', 400);

  // Revoke old
  await supabasePatch(env, `/rest/v1/client_api_tokens?id=eq.${token_id}`, {
    revoked: true,
    revoked_at: new Date().toISOString(),
    revoked_reason: 'rotated',
  });

  // Create new with same config
  const newTokenBody = {
    slug,
    label: old.label + ' (rotated)',
    scopes: old.scopes,
    expires_in_days: old.expires_at
      ? Math.ceil((new Date(old.expires_at) - Date.now()) / 86400000)
      : null,
  };

  const createReq = { ...newTokenBody };
  const createRes = await handleClientApiTokenCreate(createReq, env);
  const created = await createRes.json();

  await auditLog(env, slug, 'token_rotated', { old_token_id: token_id, new_token_id: created.token_id });

  return json({ ok: true, ...created, rotated_from: token_id });
}

// ---------------------------------------------------------------------------
// 5. TOKEN VERIFY (internal — called by client-api middleware)
// ---------------------------------------------------------------------------

export async function handleClientApiTokenVerify(body, env) {
  const { token, required_scope } = body;
  if (!token) return jsonError('token required', 400);

  const hash = await sha256hex(token);
  const res = await supabaseGet(env,
    `/rest/v1/client_api_tokens?token_hash=eq.${hash}&revoked=eq.false&select=*&limit=1`
  );
  const record = res?.[0];

  if (!record) return json({ ok: false, valid: false, reason: 'invalid_token' });

  // Check expiry
  if (record.expires_at && new Date(record.expires_at) < new Date()) {
    return json({ ok: false, valid: false, reason: 'token_expired' });
  }

  // Check scope
  if (required_scope && !record.scopes.includes(required_scope)) {
    return json({ ok: false, valid: false, reason: 'insufficient_scope', required: required_scope, granted: record.scopes });
  }

  // Update last_used (fire and forget)
  supabasePatch(env, `/rest/v1/client_api_tokens?id=eq.${record.id}`, {
    last_used_at: new Date().toISOString(),
    use_count: (record.use_count || 0) + 1,
  }).catch(() => {});

  return json({
    ok: true,
    valid: true,
    client_slug: record.client_slug,
    scopes: record.scopes,
    label: record.label,
  });
}

// ---------------------------------------------------------------------------
// 6. TOKEN AUDIT LOG
// ---------------------------------------------------------------------------

export async function handleClientApiTokenAudit(body, env) {
  const { slug, limit = 50 } = body;
  if (!slug) return jsonError('slug required', 400);

  const res = await supabaseGet(env,
    `/rest/v1/client_api_audit_log?client_slug=eq.${slug}&order=created_at.desc&limit=${Math.min(limit, 200)}&select=*`
  );

  return json({ ok: true, events: res || [] });
}

// ---------------------------------------------------------------------------
// 7. OPENAPI SPEC GENERATOR
// Returns a client-specific OpenAPI 3.1 spec based on their enabled modules.
// ---------------------------------------------------------------------------

export async function handleClientApiOpenApiSpec(body, env) {
  const { slug } = body;
  if (!slug) return jsonError('slug required', 400);

  // Get client's granted scopes (union of all their active tokens)
  const tokens = await supabaseGet(env,
    `/rest/v1/client_api_tokens?client_slug=eq.${slug}&revoked=eq.false&select=scopes`
  );
  const grantedScopes = [...new Set((tokens || []).flatMap(t => t.scopes || []))];

  const spec = buildOpenApiSpec(slug, grantedScopes);
  return json({ ok: true, slug, spec });
}

function buildOpenApiSpec(slug, grantedScopes) {
  const baseUrl = 'https://api.formaut.com';
  const paths = {};

  if (grantedScopes.includes('content:read') || grantedScopes.includes('content:write')) {
    paths['/v1/{slug}/content/{key}'] = {
      parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
                   { name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
      ...(grantedScopes.includes('content:read') && {
        get: {
          summary: 'Read site content',
          tags: ['Content'],
          security: [{ ApiToken: [] }],
          responses: { '200': { description: 'Content value', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      }),
      ...(grantedScopes.includes('content:write') && {
        put: {
          summary: 'Update site content',
          tags: ['Content'],
          security: [{ ApiToken: [] }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { value: { type: 'object' } } } } } },
          responses: { '200': { description: 'Updated' } },
        },
      }),
    };
  }

  if (grantedScopes.includes('hours:read') || grantedScopes.includes('hours:write')) {
    paths['/v1/{slug}/hours'] = {
      parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
      ...(grantedScopes.includes('hours:read') && {
        get: { summary: 'Get business hours', tags: ['Hours'], security: [{ ApiToken: [] }],
               responses: { '200': { description: 'Hours object by day' } } },
      }),
      ...(grantedScopes.includes('hours:write') && {
        put: { summary: 'Update business hours', tags: ['Hours'], security: [{ ApiToken: [] }],
               requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
               responses: { '200': { description: 'Updated' } } },
      }),
    };
  }

  if (grantedScopes.includes('announcements:read') || grantedScopes.includes('announcements:write')) {
    paths['/v1/{slug}/announcement'] = {
      parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
      ...(grantedScopes.includes('announcements:read') && {
        get: { summary: 'Get announcement', tags: ['Announcement'], security: [{ ApiToken: [] }],
               responses: { '200': { description: 'Announcement object' } } },
      }),
      ...(grantedScopes.includes('announcements:write') && {
        put: { summary: 'Set announcement', tags: ['Announcement'], security: [{ ApiToken: [] }],
               requestBody: { content: { 'application/json': { schema: { type: 'object',
                 properties: { enabled: { type: 'boolean' }, text: { type: 'string' } } } } } },
               responses: { '200': { description: 'Updated' } } },
      }),
    };
  }

  if (grantedScopes.includes('jobs:read')) {
    paths['/v1/{slug}/jobs'] = {
      parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
      get: { summary: 'List recent jobs', tags: ['Jobs'], security: [{ ApiToken: [] }],
             responses: { '200': { description: 'Array of job objects' } } },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `Formaut API — ${slug}`,
      description: `Programmatic access to your Formaut site data. Token scopes control what operations are permitted.`,
      version: '1.0.0',
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        ApiToken: { type: 'apiKey', in: 'header', name: 'X-Formaut-Token',
                    description: 'Your Formaut API token. Create one in your dashboard under API.' },
      },
    },
    paths,
  };
}

// ---------------------------------------------------------------------------
// PAGES FUNCTION — /api/client-api/tokens/[[path]].js
// Proxy stub for the platform worker. Drop into formaut-site/functions/api/client-api/
// ---------------------------------------------------------------------------

export const pagesFunctionStub = `
// formaut-site/functions/api/client-api/tokens/[[path]].js
export async function onRequest(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => ({}));

  // Extract slug from Google auth (same pattern as other Pages Functions)
  const authRes = await fetch(env.WORKER_URL + '/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-secret': env.WORKER_SECRET },
    body: JSON.stringify({ token: body._token }),
  });
  const session = await authRes.json();
  if (!session?.slug) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  const url = new URL(request.url);
  const action = url.pathname.split('/').pop(); // create | list | revoke | rotate | audit | openapi

  return fetch(env.WORKER_URL + '/client-api/tokens/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-secret': env.WORKER_SECRET },
    body: JSON.stringify({ ...body, slug: session.slug }),
  });
}
`.trim();

// ---------------------------------------------------------------------------
// DASHBOARD API PANEL — html snippet for dashboard.html
// Add to the "Connections" or "Settings" panel as a new tab.
// ---------------------------------------------------------------------------

export const dashboardApiPanelHtml = `
<!-- INSERT after existing connections panel content in dashboard.html -->
<!-- Panel: API Access -->
<div id="panel-api" class="panel" style="display:none">
  <div class="panel-header">
    <h2>API Access</h2>
    <p class="panel-subtitle">Programmatic access to your site data</p>
  </div>

  <div class="api-intro" style="background:var(--surface-2,#f7f7f5);border:1px solid var(--border,#e5e5e2);border-radius:8px;padding:16px;margin-bottom:20px;font-size:14px;line-height:1.5">
    <strong>What is the Formaut API?</strong><br>
    API tokens let your tools, scripts, or integrations read and update your site data without going through the dashboard. 
    You control what each token can access using scopes.
  </div>

  <!-- Active tokens list -->
  <div id="api-tokens-list" style="display:flex;flex-direction:column;gap:12px;margin-bottom:20px"></div>

  <!-- Create token -->
  <button class="btn btn-primary" onclick="showCreateTokenModal()">+ Create API token</button>

  <!-- OpenAPI link -->
  <div style="margin-top:16px;font-size:13px;color:var(--text-2,#6b6b65)">
    <a href="#" onclick="downloadOpenApiSpec();return false" style="color:var(--brand,#E85D26)">Download OpenAPI spec</a>
    — import into Postman, Insomnia, or your IDE.
  </div>
</div>

<!-- Create token modal (hidden by default) -->
<div id="create-token-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;align-items:center;justify-content:center">
  <div style="background:white;border-radius:10px;padding:28px;max-width:480px;width:100%;margin:24px;box-shadow:0 8px 32px rgba(0,0,0,.15)">
    <h3 style="margin-bottom:16px">New API token</h3>
    <label style="font-size:13px;font-weight:500">Label<br>
      <input id="new-token-label" type="text" placeholder="e.g. Google Sheets sync" style="width:100%;margin-top:4px;padding:8px 10px;border:1px solid #e5e5e2;border-radius:6px;font-size:14px">
    </label>
    <div style="margin-top:14px;font-size:13px;font-weight:500">Scopes</div>
    <div id="scope-checkboxes" style="margin-top:8px;display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto"></div>
    <div style="margin-top:20px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" onclick="closeCreateTokenModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createApiToken()">Create token</button>
    </div>
  </div>
</div>

<!-- Token reveal modal -->
<div id="token-reveal-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;align-items:center;justify-content:center">
  <div style="background:white;border-radius:10px;padding:28px;max-width:480px;width:100%;margin:24px">
    <h3 style="margin-bottom:8px">Your new API token</h3>
    <p style="font-size:13px;color:#6b6b65;margin-bottom:12px">Copy this now — it will not be shown again.</p>
    <div style="background:#f7f7f5;border:1px solid #e5e5e2;border-radius:6px;padding:12px;font-family:monospace;font-size:13px;word-break:break-all" id="token-reveal-value"></div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn btn-primary" onclick="copyRevealedToken()">Copy token</button>
      <button class="btn" onclick="closeTokenRevealModal()">Done</button>
    </div>
  </div>
</div>
`.trim();

// ---------------------------------------------------------------------------
// SQL SCHEMA ADDITIONS
// Add to platform-schema.sql
// ---------------------------------------------------------------------------

export const schemaSql = `
-- ============================================================
-- CLIENT API TOKEN SYSTEM
-- Add to: forma-platform-worker/sql/platform-schema.sql
-- ============================================================

create table if not exists client_api_tokens (
  id             uuid        primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  client_slug    text        not null references clients(slug) on delete cascade,
  token_hash     text        not null unique,     -- SHA-256 of raw token, hex
  token_prefix   text        not null,            -- first 16 chars, for display
  label          text        not null,
  scopes         text[]      not null default '{}',
  expires_at     timestamptz,
  last_used_at   timestamptz,
  use_count      integer     not null default 0,
  revoked        boolean     not null default false,
  revoked_at     timestamptz,
  revoked_reason text
);

create index if not exists client_api_tokens_slug_idx on client_api_tokens (client_slug, revoked);
create index if not exists client_api_tokens_hash_idx on client_api_tokens (token_hash);

create table if not exists client_api_audit_log (
  id             uuid        primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  client_slug    text        not null,
  event_type     text        not null,  -- token_created | token_revoked | token_rotated | token_used | api_call
  meta           jsonb       not null default '{}'
);

create index if not exists client_api_audit_log_slug_idx on client_api_audit_log (client_slug, created_at desc);

-- RLS: clients can only read their own tokens via anon key (dashboard)
alter table client_api_tokens enable row level security;
create policy "client reads own tokens" on client_api_tokens
  for select using (true);  -- actual auth enforced at Pages Function layer via Google token

alter table client_api_audit_log enable row level security;
create policy "client reads own audit" on client_api_audit_log
  for select using (true);
`.trim();

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

async function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `fmt_live_${b64}`;
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function expandBundle(name) {
  return SCOPE_BUNDLES[name] || null;
}

async function auditLog(env, slug, event_type, meta = {}) {
  await supabasePost(env, '/rest/v1/client_api_audit_log', {
    client_slug: slug,
    event_type,
    meta,
    created_at: new Date().toISOString(),
  }).catch(() => {});
}

async function supabaseGet(env, path) {
  const res = await fetch(`${env.PLATFORM_SUPABASE_URL || env.SUPABASE_URL}${path}`, {
    headers: { apikey: (env.PLATFORM_SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY), 'Content-Type': 'application/json' },
  });
  if (!res.ok) return null;
  return res.json();
}

async function supabasePost(env, path, data) {
  return fetch(`${env.PLATFORM_SUPABASE_URL || env.SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: (env.PLATFORM_SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY),
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  });
}

async function supabasePatch(env, path, data) {
  return fetch(`${env.PLATFORM_SUPABASE_URL || env.SUPABASE_URL}${path}`, {
    method: 'PATCH',
    headers: {
      apikey: (env.PLATFORM_SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY),
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function jsonError(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

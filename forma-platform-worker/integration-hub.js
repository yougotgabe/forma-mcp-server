// =============================================================================
// FORMAUT INTEGRATION HUB v1 — Printify first
// =============================================================================
// This module is designed for the existing forma-platform-worker. It keeps the
// connector logic outside index.js while reusing index.js helpers through deps:
//   { supabase, encrypt, decrypt, json }
//
// Initial supported provider: Printify API token connection + product sync.
// Later providers can reuse the same connection table and normalized objects.
// =============================================================================

const PRINTIFY_API_BASE = 'https://api.printify.com/v1';
const SUPPORTED_PROVIDERS = [
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'core_infrastructure',
    auth_type: 'management_token',
    connection_mode: 'account_token_can_create_or_attach_project',
    status: 'available',
    objects: ['project', 'database', 'auth', 'storage', 'edge_functions'],
    actions: ['connect', 'validate', 'list_organizations', 'list_projects', 'select_ops_project', 'create_ops_project', 'create_business_project'],
    notes: 'Core backend authority. Default flow is a Supabase personal access token from Account > Access Tokens. Formaut validates the account token, lists existing projects, selects/creates a Formaut ops database, then creates the website database only after enough business identity is known. Existing project URL + keys remain a fallback/manual mode.',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'core_infrastructure',
    auth_type: 'account_api_token',
    connection_mode: 'account_authority_token_or_global_key',
    status: 'available',
    objects: ['account', 'pages_project', 'dns_zone', 'worker', 'kv', 'r2'],
    actions: ['connect', 'validate', 'manage_pages', 'manage_dns', 'manage_workers'],
    notes: 'Core deployment and edge infrastructure. Preferred connection is account-level authority that can manage Pages, DNS, Workers, env vars, and deployments for the client-owned account.',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'core_infrastructure',
    auth_type: 'owner_token_or_app_installation',
    connection_mode: 'repo_owner_authority_token',
    status: 'available',
    objects: ['user', 'organization', 'repository', 'commit', 'workflow'],
    actions: ['connect', 'validate', 'create_repository', 'commit_files', 'manage_workflows'],
    notes: 'Core source-control layer. Preferred connection grants repository-owner authority so Formaut can create/update the site repo, commit generated artifacts, support rollback, and preserve deployment history.',
  },
  {
    id: 'printify',
    name: 'Printify',
    category: 'commerce_fulfillment',
    auth_type: 'api_token',
    connection_mode: 'button_plus_token',
    status: 'available',
    objects: ['shop', 'product', 'variant', 'image'],
    actions: ['connect', 'list_shops', 'sync_products'],
    notes: 'Printify currently works well as a token-based connector. The dashboard button should open a short token paste flow, then Formaut validates it and stores it encrypted.',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'payments',
    auth_type: 'oauth2',
    connection_mode: 'oauth_redirect',
    status: 'planned',
    objects: ['customer', 'payment', 'checkout_session', 'invoice'],
    actions: ['connect', 'webhook', 'sync_customers'],
  },
  {
    id: 'mailchimp',
    name: 'Mailchimp',
    category: 'marketing',
    auth_type: 'oauth2',
    connection_mode: 'oauth_redirect',
    status: 'planned',
    objects: ['audience', 'contact', 'campaign'],
    actions: ['connect', 'sync_contacts'],
  },
  {
    id: 'resend',
    name: 'Resend',
    category: 'email',
    auth_type: 'api_token',
    connection_mode: 'button_plus_token',
    status: 'available',
    objects: ['email', 'domain', 'audience', 'broadcast'],
    actions: ['connect', 'validate', 'send_transactional', 'list_domains'],
    notes: 'Client creates their own Resend account (free: 3,000 emails/month, 100/day) and verifies their domain. Formaut stores the API key encrypted. Client owns sending reputation. Required for all outbound transactional email scenarios.',
  },
];

export async function handleIntegrationsList(body, env, deps) {
  const { json } = deps;
  const slug = body.slug || body.client_slug || null;

  if (!slug) {
    return json({ ok: true, providers: SUPPORTED_PROVIDERS, connections: [] });
  }

  const client = await getClientBySlug(slug, env, deps, 'id,slug,display_name');
  if (!client) return json({ error: 'Client not found' }, 404);

  const res = await deps.supabase(env, 'GET',
    `/rest/v1/integration_connections?client_id=eq.${client.id}&select=id,provider,label,status,provider_account_id,provider_account_name,auth_type,last_sync_at,last_error,created_at,updated_at&order=created_at.desc`
  );

  const connections = res.ok ? await res.json() : [];
  return json({ ok: true, client, providers: SUPPORTED_PROVIDERS, connections });
}


export async function handleCoreStackConnect(body, env, deps) {
  const { json, encrypt } = deps;
  const provider = String(body.provider || '').toLowerCase();
  if (!['supabase', 'cloudflare', 'github'].includes(provider)) {
    return json({ error: 'provider must be one of supabase, cloudflare, github' }, 400);
  }

  const slug = body.slug || body.client_slug;
  if (!slug) return json({ error: 'slug required' }, 400);

  const client = await getClientBySlug(slug, env, deps, 'id,slug,display_name');
  if (!client) return json({ error: 'Client not found' }, 404);

  if (provider === 'github') return connectGithub(body, env, deps, client);
  if (provider === 'cloudflare') return connectCloudflare(body, env, deps, client);
  return connectSupabase(body, env, deps, client);
}

async function connectGithub(body, env, deps, client) {
  const { json, encrypt } = deps;
  const token = body.token || body.access_token || body.github_token;
  if (!token) return json({ error: 'GitHub token required' }, 400);

  const gh = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'formaut-platform-worker',
    },
  });
  const data = await gh.json().catch(() => ({}));
  if (!gh.ok) return json({ ok: false, error: 'GitHub token validation failed', detail: data.message || gh.statusText }, 400);

  const tokenEnc = await encrypt(token, env.ENCRYPTION_KEY);
  const connection = await upsertCoreConnection(env, deps, client, {
    provider: 'github',
    label: body.label || 'GitHub',
    provider_account_id: String(data.id || data.login || 'github'),
    provider_account_name: data.login || data.name || 'GitHub account',
    auth_type: 'api_token',
    credential_enc: tokenEnc,
    credential_meta: {
      login: data.login || null,
      html_url: data.html_url || null,
      repo_owner: body.repo_owner || body.owner || data.login || null,
      default_repo: body.repo || body.repository || null,
    },
    scopes: parseGithubScopes(gh.headers.get('x-oauth-scopes')),
  });

  await patchClientBestEffort(env, deps, client.id, { github_token_enc: tokenEnc });
  await logSyncEvent(env, deps, { client_id: client.id, connection_id: connection?.id || null, provider: 'github', event_type: 'connect', status: 'success', message: 'GitHub connection validated and stored.' });
  return json({ ok: true, provider: 'github', connection: publicConnection(connection), next_action: 'connect_cloudflare_and_supabase' });
}

async function connectCloudflare(body, env, deps, client) {
  const { json, encrypt } = deps;
  const token = body.token || body.api_token || body.cloudflare_token;
  const globalApiKey = body.global_api_key || body.globalApiKey || body.cloudflare_global_api_key || '';
  const email = body.email || body.cloudflare_email || '';
  const accountId = body.account_id || body.accountId || '';

  if (!token && !(globalApiKey && email)) {
    return json({ error: 'Cloudflare account API token is required. Global API key + account email is accepted only when you intentionally want maximum account authority.' }, 400);
  }

  const cfAuth = token ? { mode: 'api_token', token } : { mode: 'global_api_key', key: globalApiKey, email };
  const verify = token ? await cloudflareFetch(cfAuth, '/user/tokens/verify') : await cloudflareFetch(cfAuth, '/user');
  if (!verify.ok) return json({ ok: false, error: 'Cloudflare credential validation failed', detail: verify.error, status: verify.status }, 400);

  let account = null;
  if (accountId) {
    const accountRes = await cloudflareFetch(cfAuth, `/accounts/${encodeURIComponent(accountId)}`);
    if (!accountRes.ok) return json({ ok: false, error: 'Cloudflare account validation failed', detail: accountRes.error, status: accountRes.status }, 400);
    account = accountRes.data?.result || null;
  } else {
    const accountsRes = await cloudflareFetch(cfAuth, '/accounts?per_page=5');
    const accounts = Array.isArray(accountsRes.data?.result) ? accountsRes.data.result : [];
    if (accounts.length === 1) account = accounts[0];
  }

  const credentialPayload = token ? { token } : { global_api_key: globalApiKey, email };
  const credentialEnc = await encrypt(JSON.stringify(credentialPayload), env.ENCRYPTION_KEY);
  const connection = await upsertCoreConnection(env, deps, client, {
    provider: 'cloudflare',
    label: body.label || 'Cloudflare',
    provider_account_id: String(account?.id || accountId || verify.data?.result?.id || 'cloudflare'),
    provider_account_name: account?.name || body.account_name || verify.data?.result?.email || 'Cloudflare account',
    auth_type: token ? 'api_token' : 'global_api_key',
    credential_enc: credentialEnc,
    credential_meta: {
      credential_mode: cfAuth.mode,
      token_id: token ? (verify.data?.result?.id || null) : null,
      email: email || verify.data?.result?.email || null,
      account_id: account?.id || accountId || null,
      account_name: account?.name || body.account_name || null,
      authority_intent: 'maximum_client_account_authority_for_pages_dns_workers_deployments',
      permissions_note: 'Use a client-owned credential that can manage Pages, DNS, Workers, environment variables, deployments, and account resources required by Formaut.',
    },
    scopes: token ? ['account:read', 'account:write', 'pages:write', 'dns:write', 'workers:write'] : ['global_account_authority'],
  });

  await patchClientBestEffort(env, deps, client.id, { cloudflare_token_enc: credentialEnc });
  await logSyncEvent(env, deps, { client_id: client.id, connection_id: connection?.id || null, provider: 'cloudflare', event_type: 'connect', status: 'success', message: 'Cloudflare account-authority connection validated and stored.' });
  return json({ ok: true, provider: 'cloudflare', connection: publicConnection(connection), next_action: 'connect_github_and_supabase' });
}

async function connectSupabase(body, env, deps, client) {
  const { json, encrypt } = deps;
  const projectUrl = normalizeSupabaseUrl(body.project_url || body.supabase_url || body.url);
  const providedProjectRef = body.project_ref || body.projectRef || extractSupabaseProjectRef(projectUrl) || '';
  let managementToken = body.management_token || body.access_token || body.supabase_access_token || body.supabase_mgmt_token || '';
  let anonKey = body.anon_key || body.supabase_anon_key || body.publishable_key || body.supabase_publishable_key || '';
  let serviceKey = body.service_role_key || body.secret_key || body.service_key || body.supabase_service_role_key || body.supabase_secret_key || '';

  // Supabase Project Settings > API > Secret keys currently shows values like sb_secret_...
  // Those are project-level secrets, not Management API account tokens. If a user pastes
  // one into the management token field, treat it as the project secret instead of trying
  // to validate it against api.supabase.com.
  if (managementToken && /^sb_secret_/i.test(String(managementToken)) && !serviceKey) {
    serviceKey = managementToken;
    managementToken = '';
  }
  let resolvedProjectUrl = projectUrl;
  let projectRef = providedProjectRef;
  let projectMeta = null;
  let validation = 'manual_project_keys';

  if (!managementToken && (!resolvedProjectUrl || !anonKey || !serviceKey)) {
    return json({ error: 'For account-level project creation, paste a Supabase Personal Access Token from Account > Access Tokens, usually starting with sbp_. For an existing project, paste project_url, anon/publishable key, and secret/service key from Project Settings > API.' }, 400);
  }

  if (managementToken) {
    const tokenProbe = await supabaseMgmtFetch(managementToken, '/v1/organizations');
    if (!tokenProbe.ok) return json({ ok: false, error: 'Supabase management token validation failed', detail: tokenProbe.error, status: tokenProbe.status, hint: 'Use a Supabase Personal Access Token from Account > Access Tokens. It usually starts with sbp_. The sb_secret_ key from Project Settings > API belongs in Secret key / service role key, with the project endpoint URL and anon/publishable key.' }, 400);
    validation = 'management_token_validated';

    if (projectRef) {
      const projectRes = await supabaseMgmtFetch(managementToken, `/v1/projects/${encodeURIComponent(projectRef)}`);
      if (projectRes.ok) {
        projectMeta = projectRes.data;
        resolvedProjectUrl = resolvedProjectUrl || normalizeSupabaseUrl(projectMeta?.api_url || `https://${projectRef}.supabase.co`);
      }

      if (!anonKey || !serviceKey) {
        const keysRes = await supabaseMgmtFetch(managementToken, `/v1/projects/${encodeURIComponent(projectRef)}/api-keys`);
        if (keysRes.ok) {
          const keys = Array.isArray(keysRes.data) ? keysRes.data : (Array.isArray(keysRes.data?.api_keys) ? keysRes.data.api_keys : []);
          anonKey = anonKey || findSupabaseApiKey(keys, ['anon', 'publishable']);
          serviceKey = serviceKey || findSupabaseApiKey(keys, ['service_role', 'secret']);
          if (anonKey || serviceKey) validation = 'management_token_and_project_keys_resolved';
        }
      }
    }
  }

  if (!resolvedProjectUrl && projectRef) resolvedProjectUrl = `https://${projectRef}.supabase.co`;
  if (!resolvedProjectUrl && managementToken) {
    const orgs = Array.isArray(tokenProbe.data) ? tokenProbe.data : (Array.isArray(tokenProbe.data?.organizations) ? tokenProbe.data.organizations : []);
    const projects = await listSupabaseProjectsForOrganizations(managementToken, orgs);
    const mgmtEnc = await encrypt(managementToken, env.ENCRYPTION_KEY);
    const connection = await upsertCoreConnection(env, deps, client, {
      provider: 'supabase',
      label: body.label || 'Supabase Account',
      provider_account_id: body.organization_id || body.org_id || orgs[0]?.id || orgs[0]?.slug || 'supabase-account',
      provider_account_name: body.organization_name || orgs[0]?.name || orgs[0]?.slug || 'Supabase account',
      auth_type: 'management_token',
      credential_enc: mgmtEnc,
      credential_meta: {
        management_token_enc: mgmtEnc,
        organization_id: body.organization_id || body.org_id || orgs[0]?.id || null,
        authority_intent: 'maximum_supabase_management_authority_for_project_lifecycle',
        topology_mode: body.topology_mode || 'auto_ops_then_business_project',
        environment: body.environment || 'production',
        projects_seen: projects.length,
        orchestration_plan: buildSupabaseOrchestrationPlan({ body, orgs, projects }),
        validation,
      },
      scopes: ['management:organizations', 'management:projects', 'project:lifecycle', 'project:api_keys'],
    });
    await patchClientBestEffort(env, deps, client.id, { supabase_mgmt_token_enc: mgmtEnc });
    await logSyncEvent(env, deps, { client_id: client.id, connection_id: connection?.id || null, provider: 'supabase', event_type: 'connect_account', status: 'success', message: 'Supabase account management token validated. Project orchestration is ready.' });
    return json({
      ok: true,
      provider: 'supabase',
      connection: publicConnection(connection),
      organizations: orgs.map(publicSupabaseOrg),
      projects: projects.map(publicSupabaseProject),
      orchestration_plan: buildSupabaseOrchestrationPlan({ body, orgs, projects }),
      next_action: projects.length ? 'select_or_create_formaut_ops_project' : 'create_formaut_ops_project',
      message: projects.length
        ? 'Supabase account connected. Formaut can now select an existing project for development/client ops or create a dedicated Formaut ops project.'
        : 'Supabase account connected. No existing projects were found, so Formaut should create its Formaut ops project first.',
    });
  }

  if (!resolvedProjectUrl) {
    return json({ error: 'Supabase project URL/project ref is required when connecting with project-level keys only.' }, 400);
  }

  if (!serviceKey) {
    return json({ error: 'Supabase service role key could not be resolved. Paste the project service_role key once, or provide a management token with access to project API keys.' }, 400);
  }
  if (!anonKey) {
    return json({ error: 'Supabase anon key could not be resolved. Paste the project anon key once, or provide a management token with access to project API keys.' }, 400);
  }

  const probe = await probeSupabaseProject(resolvedProjectUrl, serviceKey);
  if (!probe.ok) return json({ ok: false, error: 'Supabase project validation failed', detail: probe.error, status: probe.status }, 400);

  const serviceEnc = await encrypt(serviceKey, env.ENCRYPTION_KEY);
  const anonEnc = await encrypt(anonKey, env.ENCRYPTION_KEY);
  const mgmtEnc = managementToken ? await encrypt(managementToken, env.ENCRYPTION_KEY) : null;
  projectRef = projectRef || extractSupabaseProjectRef(resolvedProjectUrl);

  const connection = await upsertCoreConnection(env, deps, client, {
    provider: 'supabase',
    label: body.label || 'Supabase',
    provider_account_id: projectRef || resolvedProjectUrl,
    provider_account_name: body.project_name || projectMeta?.name || projectRef || 'Supabase project',
    auth_type: managementToken ? 'management_token_plus_project_keys' : 'project_keys',
    credential_enc: mgmtEnc || serviceEnc,
    credential_meta: {
      project_url: resolvedProjectUrl,
      project_ref: projectRef,
      anon_key_enc: anonEnc,
      service_role_key_enc: serviceEnc,
      management_token_enc: mgmtEnc,
      organization_id: body.organization_id || body.org_id || projectMeta?.organization_id || null,
      authority_intent: managementToken ? 'maximum_supabase_management_authority_for_project_lifecycle' : 'existing_project_admin_authority',
      validation: probe.validation || validation,
    },
    scopes: managementToken ? ['management:organizations', 'management:projects', 'project:api_keys', 'rest:admin', 'auth:admin', 'storage:admin'] : ['rest:read', 'rest:write', 'auth:admin', 'storage:admin'],
  });

  await patchClientBestEffort(env, deps, client.id, {
    supabase_url: resolvedProjectUrl,
    supabase_service_key_enc: serviceEnc,
    supabase_anon_key_enc: anonEnc,
    ...(mgmtEnc ? { supabase_mgmt_token_enc: mgmtEnc } : {}),
  });
  await logSyncEvent(env, deps, { client_id: client.id, connection_id: connection?.id || null, provider: 'supabase', event_type: 'connect', status: 'success', message: 'Supabase account/project authority validated and stored.' });
  return json({ ok: true, provider: 'supabase', connection: publicConnection(connection), next_action: 'connect_github_and_cloudflare' });
}


async function listSupabaseProjectsForOrganizations(managementToken, orgs) {
  const all = [];
  for (const org of orgs || []) {
    const orgId = org?.id || org?.slug;
    if (!orgId) continue;
    const res = await supabaseMgmtFetch(managementToken, `/v1/projects?organization_id=${encodeURIComponent(orgId)}`);
    const rows = Array.isArray(res.data) ? res.data : (Array.isArray(res.data?.projects) ? res.data.projects : []);
    for (const project of rows) all.push({ ...project, organization_id: project.organization_id || orgId });
  }
  if (!all.length) {
    const res = await supabaseMgmtFetch(managementToken, '/v1/projects');
    const rows = Array.isArray(res.data) ? res.data : (Array.isArray(res.data?.projects) ? res.data.projects : []);
    for (const project of rows) all.push(project);
  }
  const seen = new Set();
  return all.filter(p => {
    const ref = p?.ref || p?.id || p?.project_ref || p?.name;
    if (!ref || seen.has(ref)) return false;
    seen.add(ref);
    return true;
  });
}

function buildSupabaseOrchestrationPlan({ body, orgs, projects }) {
  const mode = body.topology_mode || body.mode || 'default';
  const environment = body.environment || (mode === 'development' ? 'development' : 'production');
  const existingOps = (projects || []).find(p => {
    const name = String(p.name || p.ref || p.id || '').toLowerCase();
    return name.includes('formaut') || name.includes('forma') || name.includes('ops');
  }) || null;
  return {
    topology: environment === 'development'
      ? 'single_project_development_control_plane_and_client_ops'
      : 'platform_control_plane_plus_client_owned_ops_and_business_projects',
    default_sequence: [
      'validate_supabase_personal_access_token',
      'list_existing_organizations_and_projects',
      existingOps ? 'offer_existing_project_as_formaut_ops_database' : 'create_or_select_formaut_ops_database',
      'install_or_update_formaut_ops_schema',
      'gather_business_identity_until_project_name_is_safe',
      'create_business_website_database_when_ready_or_queue_missing_info'
    ],
    recommended_next_action: existingOps ? 'select_existing_ops_project' : ((projects || []).length ? 'select_existing_or_create_ops_project' : 'create_formaut_ops_project'),
    recommended_ops_project_ref: existingOps?.ref || existingOps?.id || existingOps?.project_ref || null,
    organizations_seen: (orgs || []).length,
    projects_seen: (projects || []).length,
    requires_business_info_before_business_project: true,
    missing_business_info_fields: ['confirmed_business_name', 'safe_project_slug', 'primary_site_purpose'],
  };
}

function publicSupabaseOrg(org) {
  return {
    id: org?.id || null,
    slug: org?.slug || null,
    name: org?.name || org?.slug || 'Supabase organization',
  };
}

function publicSupabaseProject(project) {
  const ref = project?.ref || project?.id || project?.project_ref || null;
  return {
    id: project?.id || null,
    ref,
    name: project?.name || ref || 'Supabase project',
    region: project?.region || null,
    organization_id: project?.organization_id || null,
    status: project?.status || project?.database?.status || null,
    api_url: project?.api_url || (ref ? `https://${ref}.supabase.co` : null),
  };
}

async function upsertCoreConnection(env, deps, client, row) {
  const payload = [{ client_id: client.id, status: 'connected', last_error: null, ...row }];
  const res = await deps.supabase(env, 'POST', '/rest/v1/integration_connections?on_conflict=client_id,provider,provider_account_id', payload, { Prefer: 'resolution=merge-duplicates,return=representation' });
  if (!res.ok) throw new Error(`Failed to store ${row.provider} connection: ${await safeText(res)}`);
  const saved = await res.json();
  return saved[0] || null;
}

async function patchClientBestEffort(env, deps, clientId, patch) {
  try { await deps.supabase(env, 'PATCH', `/rest/v1/clients?id=eq.${clientId}`, patch); } catch {}
}

async function cloudflareFetch(auth, path) {
  const headers = auth?.mode === 'global_api_key'
    ? { 'X-Auth-Email': auth.email, 'X-Auth-Key': auth.key, 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${typeof auth === 'string' ? auth : auth.token}`, 'Content-Type': 'application/json' };
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) return { ok: false, status: res.status, data, error: data?.errors?.[0]?.message || data?.message || res.statusText };
  return { ok: true, status: res.status, data };
}


async function supabaseMgmtFetch(token, path, init = {}) {
  const res = await fetch(`https://api.supabase.com/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) return { ok: false, status: res.status, data, error: typeof data === 'string' ? data : (data?.message || data?.error || text || res.statusText) };
  return { ok: true, status: res.status, data };
}

function findSupabaseApiKey(keys, names) {
  const wanted = names.map(n => String(n).toLowerCase());
  const row = keys.find(k => wanted.some(n => String(k.name || k.key_name || k.type || '').toLowerCase().includes(n)));
  return row?.api_key || row?.key || row?.value || '';
}

async function probeSupabaseProject(projectUrl, serviceKey) {
  try {
    const res = await fetch(`${projectUrl}/rest/v1/`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    if (res.status >= 500) return { ok: false, status: res.status, error: 'Supabase REST endpoint returned a server error.' };
    return { ok: true, status: res.status, validation: 'rest_endpoint_reachable' };
  } catch (err) {
    return { ok: false, status: 0, error: err.message || 'Could not reach Supabase project URL.' };
  }
}

function normalizeSupabaseUrl(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(trimmed)) return '';
  return trimmed;
}

function extractSupabaseProjectRef(projectUrl) {
  const m = String(projectUrl || '').match(/^https:\/\/([a-z0-9-]+)\.supabase\.co/i);
  return m ? m[1] : null;
}

function parseGithubScopes(header) {
  return String(header || '').split(',').map(s => s.trim()).filter(Boolean);
}

export async function handlePrintifyConnect(body, env, deps) {
  const { json, encrypt } = deps;
  const slug = body.slug || body.client_slug;
  const apiToken = body.api_token || body.apiToken || body.token;
  const label = body.label || 'Printify';

  if (!slug || !apiToken) {
    return json({ error: 'slug and api_token required' }, 400);
  }

  const client = await getClientBySlug(slug, env, deps, 'id,slug,display_name');
  if (!client) return json({ error: 'Client not found' }, 404);

  const shops = await printifyFetch(apiToken, '/shops.json');
  if (!shops.ok) {
    return json({
      ok: false,
      error: 'Printify token validation failed',
      detail: shops.error,
      status: shops.status,
    }, 400);
  }

  const firstShop = Array.isArray(shops.data) && shops.data.length ? shops.data[0] : null;
  const providerAccountId = String(body.shop_id || body.shopId || firstShop?.id || 'default');
  const providerAccountName = body.shop_name || body.shopName || firstShop?.title || firstShop?.sales_channel || 'Printify shop';
  const credentialEnc = await encrypt(apiToken, env.ENCRYPTION_KEY);

  // Upsert by unique client/provider/account. Supabase upsert requires the
  // on_conflict query parameter to target the exact unique constraint fields.
  const payload = [{
    client_id: client.id,
    provider: 'printify',
    label,
    status: 'connected',
    provider_account_id: providerAccountId,
    provider_account_name: providerAccountName,
    auth_type: 'api_token',
    credential_enc: credentialEnc,
    credential_meta: {
      validation: 'shops.json',
      shops_seen: Array.isArray(shops.data) ? shops.data.length : 0,
    },
    scopes: ['shops:read', 'products:read'],
    last_error: null,
  }];

  const upsertRes = await deps.supabase(env, 'POST',
    '/rest/v1/integration_connections?on_conflict=client_id,provider,provider_account_id',
    payload,
    { Prefer: 'resolution=merge-duplicates,return=representation' }
  );

  if (!upsertRes.ok) {
    const detail = await safeText(upsertRes);
    return json({ error: 'Failed to store Printify connection', detail }, 500);
  }

  const saved = await upsertRes.json();
  await logSyncEvent(env, deps, {
    client_id: client.id,
    connection_id: saved[0]?.id || null,
    provider: 'printify',
    event_type: 'connect',
    status: 'success',
    message: 'Printify connection validated and stored.',
    counts: { shops_seen: Array.isArray(shops.data) ? shops.data.length : 0 },
  });

  return json({
    ok: true,
    provider: 'printify',
    connection: publicConnection(saved[0]),
    shops: shops.data,
    next_action: 'sync_printify_products',
  });
}

export async function handlePrintifyShops(body, env, deps) {
  const { json } = deps;
  const connection = await loadConnection(body, env, deps, 'printify');
  if (!connection.ok) return json(connection, connection.status || 400);

  const token = await deps.decrypt(connection.connection.credential_enc, env.ENCRYPTION_KEY);
  const shops = await printifyFetch(token, '/shops.json');
  if (!shops.ok) return json({ ok: false, error: shops.error, status: shops.status }, 400);

  return json({ ok: true, connection: publicConnection(connection.connection), shops: shops.data });
}

export async function handlePrintifySyncProducts(body, env, deps) {
  const { json } = deps;
  const loaded = await loadConnection(body, env, deps, 'printify');
  if (!loaded.ok) return json(loaded, loaded.status || 400);

  const { client, connection } = loaded;
  const token = await deps.decrypt(connection.credential_enc, env.ENCRYPTION_KEY);

  let shopId = body.shop_id || body.shopId || connection.provider_account_id;
  if (!shopId || shopId === 'default') {
    const shops = await printifyFetch(token, '/shops.json');
    if (!shops.ok || !Array.isArray(shops.data) || !shops.data.length) {
      return json({ ok: false, error: 'No Printify shops found for this token.' }, 400);
    }
    shopId = shops.data[0].id;
  }

  const products = await fetchAllPrintifyProducts(token, shopId);
  if (!products.ok) {
    await markConnectionError(env, deps, connection.id, products.error);
    await logSyncEvent(env, deps, {
      client_id: client.id,
      connection_id: connection.id,
      provider: 'printify',
      event_type: 'sync_products',
      status: 'error',
      message: 'Printify product sync failed.',
      error_detail: products.error,
    });
    return json({ ok: false, error: products.error, status: products.status }, 400);
  }

  const rows = products.data.map((product) => normalizePrintifyProduct(product, {
    clientId: client.id,
    connectionId: connection.id,
  }));

  if (rows.length) {
    const upsertRes = await deps.supabase(env, 'POST',
      '/rest/v1/commerce_products?on_conflict=client_id,provider,external_product_id',
      rows,
      { Prefer: 'resolution=merge-duplicates,return=minimal' }
    );
    if (!upsertRes.ok) {
      const detail = await safeText(upsertRes);
      return json({ error: 'Failed to upsert commerce products', detail }, 500);
    }
  }

  await deps.supabase(env, 'PATCH', `/rest/v1/integration_connections?id=eq.${connection.id}`, {
    provider_account_id: String(shopId),
    status: 'connected',
    last_sync_at: new Date().toISOString(),
    last_error: null,
  });

  await logSyncEvent(env, deps, {
    client_id: client.id,
    connection_id: connection.id,
    provider: 'printify',
    event_type: 'sync_products',
    status: 'success',
    message: 'Printify products synced into normalized commerce_products.',
    counts: { products: rows.length },
  });

  return json({
    ok: true,
    provider: 'printify',
    shop_id: String(shopId),
    synced: { products: rows.length },
    sample: rows.slice(0, 5).map(({ raw, variants, images, options, ...safe }) => safe),
  });
}

export async function handleCommerceProducts(body, env, deps) {
  const { json } = deps;
  const slug = body.slug || body.client_slug;
  if (!slug) return json({ error: 'slug required' }, 400);
  const client = await getClientBySlug(slug, env, deps, 'id,slug,display_name');
  if (!client) return json({ error: 'Client not found' }, 404);

  const limit = Math.min(Number(body.limit || 50), 200);
  const provider = body.provider ? `&provider=eq.${encodeURIComponent(body.provider)}` : '';
  const res = await deps.supabase(env, 'GET',
    `/rest/v1/commerce_products?client_id=eq.${client.id}${provider}&select=id,provider,external_product_id,title,description,status,visible,tags,images,variants,synced_at&order=updated_at.desc&limit=${limit}`
  );
  const products = res.ok ? await res.json() : [];
  return json({ ok: true, client, products });
}

async function getClientBySlug(slug, env, deps, select = 'id,slug') {
  const res = await deps.supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=${encodeURIComponent(select)}&limit=1`
  );
  const rows = res.ok ? await res.json() : [];
  return rows[0] || null;
}

async function loadConnection(body, env, deps, provider) {
  const slug = body.slug || body.client_slug;
  const connectionId = body.connection_id || body.connectionId || null;
  if (!slug && !connectionId) return { ok: false, error: 'slug or connection_id required', status: 400 };

  let client = null;
  let path;
  if (connectionId) {
    path = `/rest/v1/integration_connections?id=eq.${encodeURIComponent(connectionId)}&provider=eq.${provider}&select=*&limit=1`;
  } else {
    client = await getClientBySlug(slug, env, deps, 'id,slug,display_name');
    if (!client) return { ok: false, error: 'Client not found', status: 404 };
    path = `/rest/v1/integration_connections?client_id=eq.${client.id}&provider=eq.${provider}&status=eq.connected&select=*&order=updated_at.desc&limit=1`;
  }

  const res = await deps.supabase(env, 'GET', path);
  const rows = res.ok ? await res.json() : [];
  const connection = rows[0];
  if (!connection) return { ok: false, error: `${provider} connection not found`, status: 404 };

  if (!client) {
    const cRes = await deps.supabase(env, 'GET', `/rest/v1/clients?id=eq.${connection.client_id}&select=id,slug,display_name&limit=1`);
    const cRows = cRes.ok ? await cRes.json() : [];
    client = cRows[0] || null;
  }

  return { ok: true, client, connection };
}

async function printifyFetch(token, path, init = {}) {
  const res = await fetch(`${PRINTIFY_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    return { ok: false, status: res.status, error: typeof data === 'string' ? data : (data?.message || data?.error || text || 'Printify API error') };
  }
  return { ok: true, status: res.status, data };
}

async function fetchAllPrintifyProducts(token, shopId) {
  const all = [];
  let page = 1;
  let lastPage = 1;

  do {
    const result = await printifyFetch(token, `/shops/${encodeURIComponent(shopId)}/products.json?page=${page}&limit=100`);
    if (!result.ok) return result;

    const payload = result.data || {};
    const items = Array.isArray(payload.data) ? payload.data : (Array.isArray(payload) ? payload : []);
    all.push(...items);
    lastPage = Number(payload.last_page || payload.lastPage || page);
    page += 1;
  } while (page <= lastPage && page <= 50);

  return { ok: true, data: all };
}

function normalizePrintifyProduct(product, { clientId, connectionId }) {
  const images = Array.isArray(product.images) ? product.images : [];
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const options = Array.isArray(product.options) ? product.options : [];
  const tags = Array.isArray(product.tags) ? product.tags.map(String) : [];

  return {
    client_id: clientId,
    connection_id: connectionId,
    provider: 'printify',
    external_product_id: String(product.id),
    title: product.title || 'Untitled Printify product',
    description: product.description || null,
    status: product.visible === false ? 'hidden' : 'active',
    visible: product.visible !== false,
    tags,
    images,
    variants: variants.map(v => ({
      id: v.id,
      sku: v.sku || null,
      title: v.title || null,
      price: v.price ?? null,
      cost: v.cost ?? null,
      is_enabled: v.is_enabled ?? null,
      is_default: v.is_default ?? null,
      options: v.options || null,
    })),
    options,
    raw: product,
    synced_at: new Date().toISOString(),
  };
}

function publicConnection(connection) {
  if (!connection) return null;
  const { credential_enc, ...safe } = connection;
  return safe;
}

async function markConnectionError(env, deps, connectionId, error) {
  await deps.supabase(env, 'PATCH', `/rest/v1/integration_connections?id=eq.${connectionId}`, {
    status: 'error',
    last_error: String(error || 'Unknown integration error').slice(0, 1000),
  });
}

async function logSyncEvent(env, deps, event) {
  await deps.supabase(env, 'POST', '/rest/v1/integration_sync_events', event);
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

// =============================================================================
// RESEND INTEGRATION
// =============================================================================
// Client connects their own Resend account by pasting an API key.
// Formaut validates it, lists verified domains, stores the key encrypted.
// Same pattern as Printify API token connection.
// =============================================================================

export async function handleResendConnect(body, env, deps) {
  const { json, encrypt } = deps;
  const slug = body.slug || body.client_slug;
  if (!slug) return json({ error: 'slug required' }, 400);

  const apiKey = body.api_key || body.resend_api_key || body.token;
  if (!apiKey) return json({ error: 'Resend API key required' }, 400);

  const client = await getClientBySlug(slug, env, deps, 'id,slug,display_name');
  if (!client) return json({ error: 'Client not found' }, 404);

  // Validate the API key against Resend /domains
  const validateRes = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (validateRes.status === 401) {
    return json({ ok: false, error: 'Invalid Resend API key — check the key and try again.' }, 400);
  }
  if (!validateRes.ok) {
    return json({ ok: false, error: `Resend validation error: ${validateRes.status}` }, 400);
  }

  const domainsData = await validateRes.json().catch(() => ({}));
  const domains = Array.isArray(domainsData.data) ? domainsData.data : [];
  const verifiedDomains = domains.filter(d => d.status === 'verified').map(d => d.name);
  const unverifiedDomains = domains.filter(d => d.status !== 'verified').map(d => d.name);

  const apiKeyEnc = await encrypt(apiKey, env.ENCRYPTION_KEY);

  // Upsert connection record
  const existing = await deps.supabase(env, 'GET',
    `/rest/v1/integration_connections?client_id=eq.${client.id}&provider=eq.resend&select=id&limit=1`
  );
  const existingRows = existing.ok ? await existing.json() : [];

  let connection;
  if (existingRows.length > 0) {
    const updated = await deps.supabase(env, 'PATCH',
      `/rest/v1/integration_connections?id=eq.${existingRows[0].id}`,
      {
        status: 'connected',
        credential_enc: apiKeyEnc,
        credential_meta: {
          verified_domains: verifiedDomains,
          unverified_domains: unverifiedDomains,
          domain_count: domains.length,
        },
        last_sync_at: new Date().toISOString(),
        last_error: null,
      }
    );
    connection = updated.ok ? (await updated.json())[0] : null;
  } else {
    const inserted = await deps.supabase(env, 'POST',
      '/rest/v1/integration_connections',
      {
        client_id: client.id,
        provider: 'resend',
        label: body.label || 'Resend',
        status: 'connected',
        auth_type: 'api_token',
        credential_enc: apiKeyEnc,
        credential_meta: {
          verified_domains: verifiedDomains,
          unverified_domains: unverifiedDomains,
          domain_count: domains.length,
        },
        last_sync_at: new Date().toISOString(),
      }
    );
    connection = inserted.ok ? (await inserted.json())[0] : null;
  }

  await logSyncEvent(env, deps, {
    client_id: client.id,
    connection_id: connection?.id || null,
    provider: 'resend',
    event_type: 'connect',
    status: 'success',
    message: `Resend API key validated. ${verifiedDomains.length} verified domain(s): ${verifiedDomains.join(', ') || 'none yet'}.`,
  });

  const warnings = [];
  if (verifiedDomains.length === 0) {
    warnings.push('No verified sending domains found. Verify your domain in Resend before sending email.');
  }

  return json({
    ok: true,
    provider: 'resend',
    verified_domains: verifiedDomains,
    unverified_domains: unverifiedDomains,
    warnings,
    connection: publicConnection(connection),
    next_action: verifiedDomains.length > 0 ? 'ready_to_send' : 'verify_domain_in_resend',
  });
}

export async function handleResendSend(body, env, deps) {
  const { json, decrypt } = deps;
  const slug = body.slug || body.client_slug;
  if (!slug) return json({ error: 'slug required' }, 400);

  const { to, subject, html, from, reply_to } = body;
  if (!to || !subject || !html) return json({ error: 'to, subject, and html are required' }, 400);

  const client = await getClientBySlug(slug, env, deps, 'id,slug,display_name');
  if (!client) return json({ error: 'Client not found' }, 404);

  // Load encrypted Resend key
  const connRes = await deps.supabase(env, 'GET',
    `/rest/v1/integration_connections?client_id=eq.${client.id}&provider=eq.resend&status=eq.connected&select=credential_enc,credential_meta&limit=1`
  );
  if (!connRes.ok) return json({ error: 'Could not load Resend connection' }, 500);
  const rows = await connRes.json();
  if (!rows.length) return json({ error: 'No active Resend connection. Client must connect Resend first.' }, 400);

  const apiKey = await decrypt(rows[0].credential_enc, env.ENCRYPTION_KEY);
  if (!apiKey) return json({ error: 'Could not decrypt Resend API key' }, 500);

  const fromAddress = from || `${client.display_name} <noreply@${(rows[0].credential_meta?.verified_domains || [])[0] || 'example.com'}>`;

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(reply_to ? { reply_to } : {}),
    }),
  });

  const data = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok) {
    return json({ ok: false, error: data.message || data.error || `Resend send error ${sendRes.status}` }, sendRes.status);
  }

  return json({ ok: true, message_id: data.id });
}

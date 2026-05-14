// =============================================================================
// Two-Project Infrastructure Provisioner
// Idempotent orchestration shell for Formaut OS + Site Data setup.
// =============================================================================

import { getSupabaseCapacityStatus } from './infrastructure-capacity.js';
import { upsertInfrastructureProject, getClientBySlug, getInfrastructureSummary } from './infrastructure-registry.js';
import { buildInfrastructureProjectNames, PROJECT_ROLES } from './infrastructure-naming.js';

async function mgmt(env, method, path, body, token) {
  const res = await fetch(`https://api.supabase.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = await res.text().catch(() => null); }
  if (!res.ok) throw new Error(`Supabase Management API ${method} ${path} failed: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  return parsed;
}

export async function provisionClientInfrastructure(env, input = {}) {
  const slug = input.slug || input.client_slug;
  if (!slug) return { ok: false, error: 'slug required' };

  const capacity = await getSupabaseCapacityStatus(env, input);
  if (!capacity.ok) return capacity;

  if (!capacity.can_provision_now && input.allow_degraded_single_project !== true) {
    return {
      ok: false,
      blocked: true,
      reason: 'insufficient_supabase_project_capacity',
      capacity,
    };
  }

  const client = await getClientBySlug(env, slug);
  const names = buildInfrastructureProjectNames({ businessName: client.business_name || client.name, slug: client.slug, clientId: client.id });
  const token = input.supabase_management_token || env.SUPABASE_MANAGEMENT_TOKEN || null;
  const organizationId = input.organization_id || env.SUPABASE_ORGANIZATION_ID || null;
  const region = input.region || env.SUPABASE_PROJECT_REGION || 'us-east-1';
  const dbPass = input.database_password || env.SUPABASE_NEW_PROJECT_DB_PASSWORD || null;

  const actions = [];
  const created = [];

  async function ensureProject(role) {
    const existing = role === PROJECT_ROLES.FORMAUT_OS ? capacity.detected_formaut_os_project : capacity.detected_site_data_project;
    if (existing) {
      const row = await upsertInfrastructureProject(env, {
        client_id: client.id,
        client_slug: client.slug,
        project_role: role,
        project_name: existing.name || existing.project_name || names[role],
        project_ref: existing.ref || existing.project_ref || existing.id || null,
        organization_id: existing.organization_id || organizationId,
        supabase_url: existing.supabase_url || (existing.ref ? `https://${existing.ref}.supabase.co` : null),
        status: 'detected',
        migration_status: 'pending_schema_install',
        health_status: 'unknown',
        metadata: { source: 'detected_or_registered' },
      });
      actions.push({ role, action: 'reused_existing_project', project_ref: row.project_ref });
      return row;
    }

    if (!token || !organizationId || !dbPass) {
      const row = await upsertInfrastructureProject(env, {
        client_id: client.id,
        client_slug: client.slug,
        project_role: role,
        project_name: names[role],
        status: 'planned',
        migration_status: 'not_started',
        health_status: 'unknown',
        metadata: { reason: 'missing management token, organization id, or db password; project creation staged only' },
      });
      actions.push({ role, action: 'planned_only_missing_creation_credentials', project_name: names[role] });
      return row;
    }

    const project = await mgmt(env, 'POST', '/v1/projects', {
      name: names[role],
      organization_id: organizationId,
      region,
      db_pass: dbPass,
    }, token);

    const ref = project.ref || project.id;
    const row = await upsertInfrastructureProject(env, {
      client_id: client.id,
      client_slug: client.slug,
      project_role: role,
      project_name: project.name || names[role],
      project_ref: ref,
      organization_id: organizationId,
      supabase_url: ref ? `https://${ref}.supabase.co` : null,
      status: 'created',
      migration_status: 'pending_schema_install',
      health_status: 'unknown',
      metadata: { source: 'supabase_management_api' },
    });
    created.push(row);
    actions.push({ role, action: 'created_project', project_ref: row.project_ref });
    return row;
  }

  const formautOs = await ensureProject(PROJECT_ROLES.FORMAUT_OS);
  const siteData = await ensureProject(PROJECT_ROLES.SITE_DATA);
  const summary = await getInfrastructureSummary(env, slug);

  return {
    ok: true,
    mode: created.length ? 'created_or_reused' : 'reused_or_planned',
    actions,
    projects: { formaut_os: formautOs, site_data: siteData },
    summary,
    next_steps: [
      'Run sql/infrastructure/formaut-os-schema.sql against the Formaut OS project.',
      'Run sql/infrastructure/site-data-standard-schema.sql against the Site Data project.',
      'Run /infrastructure/health with persist=true to record migration readiness.',
    ],
  };
}

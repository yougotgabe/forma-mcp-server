// =============================================================================
// Formaut Infrastructure Registry
// Tracks Formaut OS + Site Data projects, linked roles, migrations, and health.
// =============================================================================

import { PROJECT_ROLES } from './infrastructure-naming.js';

async function sb(env, method, path, body = null, extraHeaders = {}) {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    Prefer: method === 'POST' || method === 'PATCH' ? 'return=representation' : undefined,
    ...extraHeaders,
  };
  Object.keys(headers).forEach(k => headers[k] === undefined && delete headers[k]);
  return fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
}

async function rows(res) {
  if (!res.ok) return [];
  try { return await res.json(); } catch { return []; }
}

export async function getClientBySlug(env, slug) {
  const res = await sb(env, 'GET', `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`);
  return (await rows(res))[0] || null;
}

export async function listClientInfrastructureProjects(env, clientId) {
  if (!clientId) return [];
  const res = await sb(env, 'GET', `/rest/v1/client_infrastructure_projects?client_id=eq.${encodeURIComponent(clientId)}&select=*&order=created_at.asc`);
  return rows(res);
}

export function summarizeInfrastructureProjects(projects = []) {
  const byRole = Object.fromEntries(projects.map(p => [p.project_role, p]));
  return {
    formaut_os: byRole[PROJECT_ROLES.FORMAUT_OS] || null,
    site_data: byRole[PROJECT_ROLES.SITE_DATA] || null,
    project_count: projects.length,
    roles_present: projects.map(p => p.project_role).filter(Boolean),
  };
}

export async function upsertInfrastructureProject(env, row) {
  const payload = {
    client_id: row.client_id,
    client_slug: row.client_slug || null,
    project_role: row.project_role,
    project_name: row.project_name || null,
    project_ref: row.project_ref || null,
    organization_id: row.organization_id || null,
    supabase_url: row.supabase_url || null,
    status: row.status || 'detected',
    schema_version: row.schema_version || null,
    migration_status: row.migration_status || 'not_started',
    health_status: row.health_status || 'unknown',
    metadata: row.metadata || {},
    updated_at: new Date().toISOString(),
  };
  const res = await sb(env, 'POST', '/rest/v1/client_infrastructure_projects', payload, {
    Prefer: 'resolution=merge-duplicates,return=representation',
  });
  if (!res.ok) throw new Error(`registry upsert failed: ${await res.text()}`);
  return (await res.json())[0];
}

export async function recordInfrastructureHealth(env, row) {
  const payload = {
    client_id: row.client_id,
    project_role: row.project_role,
    project_ref: row.project_ref || null,
    check_name: row.check_name,
    status: row.status || 'unknown',
    detail: row.detail || {},
    repair_available: row.repair_available ?? false,
    checked_at: new Date().toISOString(),
  };
  const res = await sb(env, 'POST', '/rest/v1/infrastructure_health_checks', payload, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(`health insert failed: ${await res.text()}`);
  return (await res.json())[0];
}

export async function getInfrastructureSummary(env, slug) {
  const client = await getClientBySlug(env, slug);
  if (!client) return { ok: false, error: 'Client not found' };
  const projects = await listClientInfrastructureProjects(env, client.id);
  return { ok: true, client: { id: client.id, slug: client.slug, name: client.name || client.business_name || null }, projects, summary: summarizeInfrastructureProjects(projects) };
}

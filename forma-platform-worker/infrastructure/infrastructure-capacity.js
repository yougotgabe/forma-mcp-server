// =============================================================================
// Supabase Capacity Preflight
// Classifies whether the connected Supabase account can support Formaut's
// two-project architecture before provisioning tries to create anything.
// =============================================================================

import { buildInfrastructureProjectNames, classifyProjectRole, PROJECT_ROLES } from './infrastructure-naming.js';
import { getClientBySlug, listClientInfrastructureProjects } from './infrastructure-registry.js';

async function safeJson(res) { try { return await res.json(); } catch { return null; } }

async function callSupabaseManagement(env, path, token) {
  if (!token) return { ok: false, status: 0, error: 'missing management token' };
  const res = await fetch(`https://api.supabase.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return { ok: res.ok, status: res.status, body: await safeJson(res), text: res.ok ? null : await res.text().catch(() => '') };
}

function inferFreeTierAvailableSlots(projects = [], maxFreeSlots = 2) {
  // Conservative free-tier heuristic. Supabase API does not always expose a simple
  // account-wide "slots left" number, so this remains an estimate unless billing
  // metadata is available.
  const active = projects.filter(p => !['INACTIVE', 'REMOVED', 'DELETED'].includes(String(p.status || '').toUpperCase()));
  return Math.max(0, maxFreeSlots - active.length);
}

export async function getSupabaseCapacityStatus(env, input = {}) {
  const slug = input.slug || input.client_slug;
  if (!slug) return { ok: false, error: 'slug required' };

  const client = await getClientBySlug(env, slug);
  if (!client) return { ok: false, error: 'Client not found' };

  const names = buildInfrastructureProjectNames({ businessName: client.business_name || client.name, slug: client.slug, clientId: client.id });
  const registered = await listClientInfrastructureProjects(env, client.id);
  const detectedFromRegistry = Object.fromEntries(registered.map(p => [p.project_role, p]));

  const token = input.supabase_management_token || env.SUPABASE_MANAGEMENT_TOKEN || null;
  let managementProjects = [];
  let management_api_access = false;
  let management_error = null;

  if (token) {
    const projectRes = await callSupabaseManagement(env, '/v1/projects', token);
    management_api_access = projectRes.ok;
    if (projectRes.ok) managementProjects = Array.isArray(projectRes.body) ? projectRes.body : [];
    else management_error = { status: projectRes.status, detail: projectRes.error || projectRes.text || 'management api unavailable' };
  }

  for (const p of managementProjects) {
    const role = classifyProjectRole(p, names);
    if (role && !detectedFromRegistry[role]) detectedFromRegistry[role] = p;
  }

  const detected_formaut_os_project = detectedFromRegistry[PROJECT_ROLES.FORMAUT_OS] || null;
  const detected_site_data_project = detectedFromRegistry[PROJECT_ROLES.SITE_DATA] || null;
  const missingRoles = [
    detected_formaut_os_project ? null : PROJECT_ROLES.FORMAUT_OS,
    detected_site_data_project ? null : PROJECT_ROLES.SITE_DATA,
  ].filter(Boolean);

  const estimatedSlots = management_api_access
    ? inferFreeTierAvailableSlots(managementProjects, Number(input.max_free_projects || env.SUPABASE_FREE_PROJECT_LIMIT || 2))
    : null;

  let capacity_state = 'capacity_unknown';
  if (!management_api_access && token) capacity_state = 'management_api_limited';
  if (management_api_access) {
    if (estimatedSlots >= 2) capacity_state = 'capacity_ok_two_available';
    else if (estimatedSlots === 1) capacity_state = 'capacity_one_available';
    else capacity_state = 'capacity_zero_available';
  }
  if (missingRoles.length === 0) capacity_state = 'capacity_ok_two_available';

  const can_provision_now = missingRoles.length === 0 || (
    management_api_access && estimatedSlots !== null && estimatedSlots >= missingRoles.length
  );

  let recommended_path = 'proceed';
  const attention = [];
  if (!management_api_access) {
    recommended_path = 'connect_supabase_management_api_or_manual_review';
    attention.push('Supabase Management API access is unavailable or limited; capacity cannot be confirmed automatically.');
  } else if (!can_provision_now && estimatedSlots === 1) {
    recommended_path = 'fresh_business_email_or_free_project_slot';
    attention.push('Two-project setup requires two available Supabase project slots unless one Formaut project already exists.');
  } else if (!can_provision_now && estimatedSlots === 0) {
    recommended_path = 'fresh_business_email_free_project_slot_or_paid_upgrade';
    attention.push('No available Supabase project capacity was detected for the missing Formaut projects.');
  }

  return {
    ok: true,
    connection_status: token ? 'connected' : 'missing_management_token',
    management_api_access,
    management_error,
    detected_formaut_os_project,
    detected_site_data_project,
    detected_project_names: names,
    available_project_slots: estimatedSlots,
    missing_roles: missingRoles,
    capacity_state,
    recommended_path,
    can_provision_now,
    attention,
    fresh_business_email_recommendation:
      'For the smoothest setup, Formaut recommends creating a fresh business email and using it for Supabase, Cloudflare, GitHub, Google OAuth, and related business infrastructure. This keeps your website, admin panel, keys, billing, and automation separate from personal accounts or old projects.',
  };
}

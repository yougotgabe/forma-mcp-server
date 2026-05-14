// =============================================================================
// Infrastructure Health
// Deterministic health summaries for Formaut OS and Site Data projects.
// =============================================================================

import { getInfrastructureSummary, recordInfrastructureHealth } from './infrastructure-registry.js';
import { PROJECT_ROLES } from './infrastructure-naming.js';

const SITE_DATA_TABLES = [
  'site_content','services','products','events','testimonials','navigation','site_settings',
  'seo_metadata','media_assets','email_artifacts','email_rules','email_triggers','admin_activity',
];

const SITE_DATA_BUCKETS = ['public-media','email-assets','site-assets','logos','uploads'];

export async function getClientInfrastructureHealth(env, input = {}) {
  const slug = input.slug || input.client_slug;
  const summary = await getInfrastructureSummary(env, slug);
  if (!summary.ok) return summary;

  const os = summary.summary.formaut_os;
  const site = summary.summary.site_data;
  const checks = [];

  checks.push({
    project_role: PROJECT_ROLES.FORMAUT_OS,
    check_name: 'formaut_os_project_registered',
    status: os ? 'pass' : 'fail',
    repair_available: !os,
    detail: os ? { project_ref: os.project_ref, schema_version: os.schema_version } : { missing: true },
  });

  checks.push({
    project_role: PROJECT_ROLES.SITE_DATA,
    check_name: 'site_data_project_registered',
    status: site ? 'pass' : 'fail',
    repair_available: !site,
    detail: site ? { project_ref: site.project_ref, schema_version: site.schema_version } : { missing: true },
  });

  checks.push({
    project_role: PROJECT_ROLES.SITE_DATA,
    check_name: 'site_data_schema_contract',
    status: site?.schema_version ? 'pass' : 'warn',
    repair_available: true,
    detail: { required_tables: SITE_DATA_TABLES, required_buckets: SITE_DATA_BUCKETS, current_schema_version: site?.schema_version || null },
  });

  if (input.persist === true) {
    for (const c of checks) await recordInfrastructureHealth(env, { client_id: summary.client.id, project_ref: c.detail.project_ref, ...c });
  }

  const failed = checks.filter(c => c.status === 'fail');
  const warned = checks.filter(c => c.status === 'warn');
  return { ok: true, client: summary.client, projects: summary.projects, checks, health_status: failed.length ? 'fail' : warned.length ? 'warn' : 'pass' };
}

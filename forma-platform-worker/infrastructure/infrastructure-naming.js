// =============================================================================
// Formaut Infrastructure Naming
// Deterministic naming for the two-project architecture.
// =============================================================================

export const PROJECT_ROLES = Object.freeze({
  FORMAUT_OS: 'formaut_os',
  SITE_DATA: 'site_data',
});

export function slugifyName(input, fallback = 'client') {
  return String(input || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || fallback;
}

export function buildInfrastructureProjectNames({ businessName, slug, clientId } = {}) {
  const base = slugifyName(slug || businessName || clientId || 'client');
  return {
    formaut_os: `formaut-os-${base}`.slice(0, 60),
    site_data: `${base}-site-data`.slice(0, 60),
  };
}

export function classifyProjectRole(project = {}, names = {}) {
  const name = String(project.name || project.project_name || project.slug || '').toLowerCase();
  const ref = String(project.ref || project.project_ref || project.id || '').toLowerCase();
  const explicit = String(project.role || project.project_role || '').toLowerCase();

  if (explicit === PROJECT_ROLES.FORMAUT_OS || explicit === PROJECT_ROLES.SITE_DATA) return explicit;
  if (name === names.formaut_os || name.includes('formaut-os') || ref.includes('formaut-os')) return PROJECT_ROLES.FORMAUT_OS;
  if (name === names.site_data || name.includes('site-data') || ref.includes('site-data')) return PROJECT_ROLES.SITE_DATA;
  return null;
}

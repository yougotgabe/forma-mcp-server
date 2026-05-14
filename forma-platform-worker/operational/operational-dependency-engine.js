// =============================================================================
// FORMAUT OPERATIONAL DEPENDENCY ENGINE
// =============================================================================
// Dependency-aware invalidation. The goal is selective regeneration, not broad
// full-site rebuilds.
// =============================================================================

const DEPENDENCY_GRAPH = {
  brand_voice: ['homepage', 'seo', 'email_copy'],
  business_profile: ['homepage', 'seo', 'service_pages'],
  services: ['homepage', 'seo', 'service_pages'],
  contact_info: ['footer', 'contact_page', 'structured_data'],
  location: ['footer', 'contact_page', 'structured_data', 'seo'],
  homepage_layout: ['homepage'],
  printify_products: ['commerce_products', 'product_pages'],
};

const JOB_TYPE_BY_ARTIFACT = {
  homepage: 'regenerate_homepage',
  seo: 'regenerate_seo',
  email_copy: 'noop',
  service_pages: 'noop',
  footer: 'noop',
  contact_page: 'noop',
  structured_data: 'regenerate_seo',
  commerce_products: 'printify_sync_products',
  product_pages: 'noop',
};

export function getInvalidatedArtifacts(changeType) {
  return [...new Set(DEPENDENCY_GRAPH[String(changeType || '').trim()] || [])];
}

export function getRegenerationJobType(artifactType) {
  return JOB_TYPE_BY_ARTIFACT[artifactType] || `regenerate_${artifactType}`;
}

export function describeDependencyGraph() {
  return DEPENDENCY_GRAPH;
}

// =============================================================================
// FORMAUT OPERATIONAL RISK ENGINE
// =============================================================================
// Classifies maintenance/remediation actions before anything reaches the queue.
// This is the trust boundary for autonomous operations.
// =============================================================================

const RISK_BY_ACTION = {
  regenerate_sitemap: 'safe',
  regenerate_robots: 'safe',
  regenerate_seo: 'safe',
  rerun_crawl_adapter: 'safe',
  validate_deployment: 'safe',
  refresh_integration_status: 'safe',
  rebuild_homepage: 'review_required',
  regenerate_homepage: 'review_required',
  rebuild_site: 'review_required',
  deploy_site: 'review_required',
  publish_artifact: 'review_required',
  rollback_deployment: 'review_required',
  delete_deployment: 'dangerous',
  delete_database_records: 'dangerous',
};

export const OPERATIONAL_RISK_LEVELS = Object.freeze({
  SAFE: 'safe',
  REVIEW_REQUIRED: 'review_required',
  DANGEROUS: 'dangerous',
});

export function classifyOperationalRisk(action) {
  const key = String(action || '').trim();
  return RISK_BY_ACTION[key] || OPERATIONAL_RISK_LEVELS.REVIEW_REQUIRED;
}

export function isAutonomousSafe(actionOrRisk) {
  const risk = Object.values(OPERATIONAL_RISK_LEVELS).includes(actionOrRisk)
    ? actionOrRisk
    : classifyOperationalRisk(actionOrRisk);
  return risk === OPERATIONAL_RISK_LEVELS.SAFE;
}

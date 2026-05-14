export async function createRemediationPlan(input) {
  const actions = [];

  if (!input.siteHealth.checks.homepage_reachable) {
    actions.push({
      type: 'rebuild_homepage',
      requires_approval: false,
      priority: 'high'
    });
  }

  if (input.seoHealth.stale) {
    actions.push({
      type: 'regenerate_seo',
      requires_approval: false,
      priority: 'medium'
    });
  }

  return {
    generated_at: new Date().toISOString(),
    actions
  };
}

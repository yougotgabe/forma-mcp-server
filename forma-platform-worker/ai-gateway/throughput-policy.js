export function buildThroughputDecision({ request = {}, intent = {}, estimate = {}, monthly = {}, env = {} }) {
  const tier = request.tier || request.plan || 'standard';
  const policy = tierPolicy(tier, env);
  const projected = Number(monthly.cost_cents || 0) + Number(estimate.estimated_cost_cents || 0);
  if (projected >= policy.hard_cents) {
    return { allowed: false, reason: 'tier_monthly_hard_limit', tier, projected_cents: projected, policy };
  }
  if (projected >= policy.soft_cents && intent.request_class === 'generation') {
    return { allowed: true, degraded: true, degradation_mode: 'protect_margin', tier, projected_cents: projected, policy };
  }
  return { allowed: true, degraded: false, tier, projected_cents: projected, policy };
}

export function tierPolicy(tier, env = {}) {
  const defaults = {
    starter: { soft_cents: 350, hard_cents: 700, max_live_tokens: 1200 },
    standard: { soft_cents: 700, hard_cents: 1200, max_live_tokens: 2200 },
    pro: { soft_cents: 2200, hard_cents: 3500, max_live_tokens: 6000 },
    premium: { soft_cents: 5000, hard_cents: 8500, max_live_tokens: 12000 },
  };
  const base = defaults[tier] || defaults.standard;
  return {
    ...base,
    soft_cents: Number(env[`AI_${tier.toUpperCase()}_SOFT_CENTS`] || base.soft_cents),
    hard_cents: Number(env[`AI_${tier.toUpperCase()}_HARD_CENTS`] || base.hard_cents),
  };
}

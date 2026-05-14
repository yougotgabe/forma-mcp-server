export function selectProviderRoute({ intent = {}, tier = 'standard', estimate = {}, env = {} }) {
  const allowFallback = env.AI_GATEWAY_ENABLE_FALLBACKS === 'true';
  const preferred = env.AI_GATEWAY_PROVIDER || 'anthropic';
  return {
    provider: preferred,
    fallback_provider: allowFallback ? (env.AI_GATEWAY_FALLBACK_PROVIDER || 'none') : null,
    request_class: intent.request_class || 'interactive',
    lane: selectLane(intent, estimate, tier),
  };
}

function selectLane(intent, estimate, tier) {
  if (intent.request_class === 'generation') return tier === 'premium' ? 'generation_priority' : 'generation_standard';
  if (intent.request_class === 'maintenance') return 'background_maintenance';
  if (Number(estimate.estimated_cost_cents || 0) > 5) return 'queued_bulk';
  return 'interactive_live';
}

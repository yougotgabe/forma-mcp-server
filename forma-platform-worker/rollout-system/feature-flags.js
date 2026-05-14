export function evaluateFeatureFlag(flag = {}, context = {}) {
  if (flag.enabled === false) return { enabled: false, reason: 'globally_disabled' };
  if (flag.allowed_tiers?.length && !flag.allowed_tiers.includes(context.tier || 'standard')) return { enabled: false, reason: 'tier_not_allowed' };
  if (flag.client_allowlist?.length && !flag.client_allowlist.includes(context.client_slug)) return { enabled: false, reason: 'client_not_allowlisted' };
  if (flag.client_blocklist?.includes(context.client_slug)) return { enabled: false, reason: 'client_blocklisted' };
  const pct = Number(flag.rollout_percent ?? 100);
  if (pct < 100 && stablePercent(context.client_slug || 'unknown') > pct) return { enabled: false, reason: 'rollout_percentage' };
  return { enabled: true, reason: 'enabled' };
}

function stablePercent(value) {
  let hash = 0;
  for (const ch of String(value)) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % 100;
}

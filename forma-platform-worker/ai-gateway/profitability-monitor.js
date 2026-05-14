export function calculateClientProfitabilitySnapshot({ monthlyRevenueCents = 0, aiCostCents = 0, infraCostCents = 0, supportCostCents = 0 } = {}) {
  const totalCost = Number(aiCostCents) + Number(infraCostCents) + Number(supportCostCents);
  const marginCents = Number(monthlyRevenueCents) - totalCost;
  const marginRatio = monthlyRevenueCents > 0 ? marginCents / Number(monthlyRevenueCents) : 0;
  return {
    monthly_revenue_cents: monthlyRevenueCents,
    total_cost_cents: totalCost,
    margin_cents: marginCents,
    margin_ratio: marginRatio,
    status: marginRatio < 0 ? 'loss' : marginRatio < 0.35 ? 'watch' : 'healthy',
  };
}

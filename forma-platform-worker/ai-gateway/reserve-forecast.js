export function forecastAiReserve({ activeClients = 0, avgAiCostCents = 0, reserveCents = 0, growthRate = 0.15 } = {}) {
  const currentMonthlyBurn = Number(activeClients) * Number(avgAiCostCents);
  const nextMonthBurn = Math.ceil(currentMonthlyBurn * (1 + Number(growthRate || 0)));
  return {
    active_clients: activeClients,
    current_monthly_burn_cents: currentMonthlyBurn,
    next_month_forecast_cents: nextMonthBurn,
    reserve_cents: reserveCents,
    reserve_months: nextMonthBurn > 0 ? Number((reserveCents / nextMonthBurn).toFixed(2)) : null,
    status: reserveCents < nextMonthBurn ? 'under_reserved' : reserveCents < nextMonthBurn * 2 ? 'watch' : 'healthy',
  };
}

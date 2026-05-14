export function recommendConversionPattern({ industry, commerce }) {
  if (commerce) return { cta_strategy: 'product-first', primary_cta: 'Shop now' };
  if (['roofing','hvac','plumbing'].includes(industry)) return { cta_strategy: 'quote-first', primary_cta: 'Request a quote' };
  return { cta_strategy: 'contact-first', primary_cta: 'Get started' };
}

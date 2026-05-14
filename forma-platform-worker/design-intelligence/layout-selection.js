import { INDUSTRY_PATTERNS } from './industry-patterns.js';

export function selectLayout({ industry, commerce, audience } = {}) {
  if (industry && INDUSTRY_PATTERNS[industry]) return { ...INDUSTRY_PATTERNS[industry], audience };
  if (commerce) return { ...INDUSTRY_PATTERNS.ecommerce, audience };
  return { layout: 'default-flex-layout', density: 'medium', heroType: 'clear-offer', audience };
}

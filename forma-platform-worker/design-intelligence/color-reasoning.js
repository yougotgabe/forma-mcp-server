export function reasonAboutColors({ industry, existingColors = [], desiredTone = [] }) {
  if (existingColors.length) return { palette_source: 'existing_brand', colors: existingColors, confidence: 0.85 };
  if (desiredTone.includes('premium')) return { palette_source: 'tone_default', colors: ['deep neutral', 'warm accent', 'soft background'], confidence: 0.55 };
  return { palette_source: 'industry_default', colors: industry === 'restaurant' ? ['warm neutral', 'food accent'] : ['clean neutral', 'trust accent'], confidence: 0.45 };
}

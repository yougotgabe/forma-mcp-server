/**
 * Formaut Industry Ontology
 *
 * Lightweight deterministic + heuristic industry inference.
 * The crawler does not understand the business. This module scores industry
 * candidates from observed service words, headings, nav labels, and page copy.
 */

export const INDUSTRY_ONTOLOGY = Object.freeze({
  roofing: {
    label: 'Roofing',
    keywords: ['roof', 'roofing', 'shingle', 'storm damage', 'hail damage', 'gutter', 'siding', 'exterior', 'leak repair'],
    services: ['roof replacement', 'roof repair', 'storm repair', 'gutter installation', 'siding'],
    negatives: ['software', 'restaurant', 'massage'],
  },
  hvac: {
    label: 'HVAC',
    keywords: ['hvac', 'furnace', 'air conditioning', 'ac repair', 'heating', 'cooling', 'duct', 'thermostat'],
    services: ['ac repair', 'furnace repair', 'heating installation', 'cooling maintenance'],
    negatives: ['roof', 'restaurant'],
  },
  restaurant: {
    label: 'Restaurant / Food Service',
    keywords: ['menu', 'order online', 'catering', 'reservation', 'dine in', 'takeout', 'chef', 'breakfast', 'lunch', 'dinner'],
    services: ['catering', 'takeout', 'delivery', 'reservations'],
    negatives: ['roof', 'furnace'],
  },
  salon_spa: {
    label: 'Salon / Spa',
    keywords: ['salon', 'spa', 'haircut', 'stylist', 'massage', 'facial', 'lashes', 'nails', 'beauty'],
    services: ['haircuts', 'color', 'massage', 'facials', 'nail services'],
    negatives: ['roof', 'furnace'],
  },
  contractor: {
    label: 'General Contractor / Home Services',
    keywords: ['contractor', 'remodel', 'renovation', 'construction', 'repair', 'installation', 'home improvement'],
    services: ['remodeling', 'repairs', 'installation', 'renovation'],
    negatives: ['software', 'restaurant'],
  },
  creative_studio: {
    label: 'Creative Studio / Media',
    keywords: ['studio', 'brand', 'design', 'video', 'photography', 'creative', 'content', 'web design', 'marketing'],
    services: ['branding', 'web design', 'video production', 'photography', 'content creation'],
    negatives: ['roof', 'furnace'],
  },
  professional_services: {
    label: 'Professional Services',
    keywords: ['consulting', 'advisor', 'bookkeeping', 'accounting', 'tax', 'legal', 'insurance', 'financial planning'],
    services: ['consulting', 'advisory', 'bookkeeping', 'tax preparation'],
    negatives: ['menu', 'furnace'],
  },
});

export function inferIndustry({ texts = [], services = [], existingIndustry = null }) {
  const haystack = [...texts, ...services].join(' | ').toLowerCase();
  const candidates = Object.entries(INDUSTRY_ONTOLOGY).map(([key, def]) => {
    const keywordHits = def.keywords.filter((kw) => haystack.includes(kw));
    const serviceHits = def.services.filter((svc) => haystack.includes(svc));
    const negativeHits = def.negatives.filter((neg) => haystack.includes(neg));
    const rawScore = keywordHits.length * 0.14 + serviceHits.length * 0.18 - negativeHits.length * 0.2;
    const score = clamp01(rawScore);
    return {
      key,
      value: def.label,
      confidence: score,
      proof: { keyword_hits: keywordHits, service_hits: serviceHits, negative_hits: negativeHits },
    };
  }).filter((candidate) => candidate.confidence > 0);

  candidates.sort((a, b) => b.confidence - a.confidence);
  const top = candidates[0] ?? null;
  const second = candidates[1] ?? null;
  const ambiguous = top && second && top.confidence - second.confidence < 0.12;

  return {
    value: top?.value ?? existingIndustry ?? '',
    confidence: top?.confidence ?? 0,
    status: ambiguous ? 'ambiguous' : top?.confidence >= 0.55 ? 'candidate' : 'low_confidence',
    candidates,
    uncertainty_reason: ambiguous ? 'Top industry candidates are too close to safely choose automatically.' : null,
  };
}

export function extractServiceCandidates({ texts = [] }) {
  const haystack = texts.join(' | ').toLowerCase();
  const serviceMap = new Map();
  for (const industry of Object.values(INDUSTRY_ONTOLOGY)) {
    for (const service of industry.services) {
      if (haystack.includes(service.toLowerCase())) {
        serviceMap.set(service, { value: service, confidence: 0.78, source: 'ontology_phrase_match' });
      }
    }
  }
  return [...serviceMap.values()];
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

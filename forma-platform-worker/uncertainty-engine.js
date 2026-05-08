/**
 * Formaut Uncertainty Engine
 *
 * Turns confidence/candidate spread into review actions.
 * This lets Formaut ask fewer, better clarification questions and avoid
 * silently converting weak evidence into durable business memory.
 */

export function assessUncertainty(normalizedSignals = {}) {
  const reviewItems = [];
  const approvedCandidates = {};
  const blockedWrites = {};

  for (const [field, signalOrSignals] of Object.entries(normalizedSignals)) {
    const signals = Array.isArray(signalOrSignals) ? signalOrSignals : [signalOrSignals];
    const ranked = [...signals].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const top = ranked[0];
    if (!top) continue;

    const decision = decideFieldAction(field, ranked);
    if (decision.action === 'auto_accept_candidate') {
      approvedCandidates[field] = top.value;
    } else {
      blockedWrites[field] = top.value;
      reviewItems.push({
        field,
        suggested_value: top.value,
        confidence: top.confidence ?? 0,
        reason: decision.reason,
        question: buildClarificationQuestion(field, ranked),
        candidates: ranked.map((s) => ({ value: s.value, confidence: s.confidence, status: s.status })),
      });
    }
  }

  return {
    approved_candidates: approvedCandidates,
    blocked_writes: blockedWrites,
    review_items: reviewItems,
    needs_review: reviewItems.length > 0,
  };
}

export function decideFieldAction(field, candidates = []) {
  const top = candidates[0];
  const second = candidates[1];
  if (!top) return { action: 'ignore', reason: 'No candidate evidence.' };
  if (top.status === 'contradicted') return { action: 'require_review', reason: 'Candidate conflicts with existing business memory.' };
  if ((top.confidence ?? 0) < thresholdFor(field)) return { action: 'require_review', reason: 'Confidence below field threshold.' };
  if (second && (top.confidence ?? 0) - (second.confidence ?? 0) < 0.12) {
    return { action: 'require_review', reason: 'Top candidates are too close to safely choose.' };
  }
  return { action: 'auto_accept_candidate', reason: 'Evidence meets confidence and ambiguity thresholds.' };
}

function thresholdFor(field) {
  const thresholds = {
    business_name: 0.76,
    industry: 0.62,
    brand_tone: 0.58,
    visual_style: 0.55,
    primary_services: 0.68,
    contact_methods: 0.8,
    social_links: 0.84,
    location: 0.72,
  };
  return thresholds[field] ?? 0.66;
}

function buildClarificationQuestion(field, candidates) {
  const values = candidates.slice(0, 3).map((c) => c.value).filter(Boolean);
  const joined = values.length > 1 ? values.join(' / ') : values[0];
  const copy = {
    business_name: `I found a possible business name: ${joined}. Is that the correct public business name?`,
    industry: `I found more than one possible industry signal: ${joined}. Which one best describes the business?`,
    primary_services: `I found these possible core services: ${joined}. Which should be treated as primary?`,
    location: `I found a possible location: ${joined}. Should this be used on the website?`,
    brand_tone: `I found tone clues that suggest: ${joined}. Should the brand voice follow that direction?`,
    visual_style: `I found visual style clues: ${joined}. Should the new design preserve that direction?`,
  };
  return copy[field] ?? `I found a possible ${field}: ${joined}. Should I treat that as confirmed?`;
}

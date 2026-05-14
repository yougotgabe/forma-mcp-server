// =============================================================================
// FORMAUT - BUSINESS MEMORY CONFIDENCE POLICY
// =============================================================================
// Field-specific acceptance rules for turning extracted facts into durable
// business profile memory. This module is intentionally deterministic so the
// Worker can make cheap, auditable decisions before any LLM call.
// =============================================================================

export const SOURCE_WEIGHTS = {
  user_confirmation: 1.0,
  manual_test: 0.95,
  manual_admin: 0.95,
  chat: 0.9,
  integration: 0.82,
  crawl: 0.78,
  llm_extraction: 0.72,
  inferred: 0.62,
};

export const FIELD_POLICIES = {
  business_name: { autoAccept: 0.85, pending: 0.55, brandPositioning: false, allowOverwrite: false },
  industry: { autoAccept: 0.88, pending: 0.55, brandPositioning: true, allowOverwrite: false },
  description: { autoAccept: 0.9, pending: 0.55, brandPositioning: true, allowOverwrite: false },
  brand_tone: { autoAccept: 0.92, pending: 0.55, brandPositioning: true, allowOverwrite: false },
  visual_style: { autoAccept: 0.92, pending: 0.55, brandPositioning: true, allowOverwrite: false },
  primary_services: { autoAccept: 0.85, pending: 0.55, brandPositioning: false, allowOverwrite: false, mergeArray: true },
  secondary_services: { autoAccept: 0.85, pending: 0.55, brandPositioning: false, allowOverwrite: false, mergeArray: true },
  service_area: { autoAccept: 0.85, pending: 0.55, brandPositioning: false, allowOverwrite: false, mergeArray: true },
  location: { autoAccept: 0.86, pending: 0.55, brandPositioning: false, allowOverwrite: false },
  contact_methods: { autoAccept: 0.85, pending: 0.55, brandPositioning: false, allowOverwrite: false, mergeArray: true },
  social_links: { autoAccept: 0.85, pending: 0.55, brandPositioning: false, allowOverwrite: false, mergeArray: true },
  website_url: { autoAccept: 0.85, pending: 0.55, brandPositioning: false, allowOverwrite: false },
  logo_sources: { autoAccept: 0.88, pending: 0.55, brandPositioning: false, allowOverwrite: false, mergeArray: true },
};

export function getFieldPolicy(field) {
  return FIELD_POLICIES[field] || { autoAccept: 0.88, pending: 0.55, brandPositioning: true, allowOverwrite: false };
}

export function sourceReliability(sourceType = 'inferred') {
  return SOURCE_WEIGHTS[sourceType] ?? SOURCE_WEIGHTS.inferred;
}

export function normalizeConfidence(confidence, sourceType) {
  const raw = Number.isFinite(Number(confidence)) ? Number(confidence) : 0.6;
  const weighted = raw * sourceReliability(sourceType);
  return Math.max(0, Math.min(0.99, Number(weighted.toFixed(3))));
}

export function shouldRejectCandidate({ confidence, value, scopeAllowsMemory = true }) {
  if (!scopeAllowsMemory) return { reject: true, reason: 'Scope guard did not allow durable business memory.' };
  if (confidence < 0.35) return { reject: true, reason: 'Confidence below automatic rejection threshold.' };
  if (isEmptyValue(value)) return { reject: true, reason: 'Candidate value was empty or noisy.' };
  return { reject: false, reason: null };
}

export function decideCandidateStatus({ field, value, confidence, sourceType, existingValue, conflict }) {
  const reject = shouldRejectCandidate({ confidence, value });
  if (reject.reject) return { status: 'rejected', action: 'reject', reason: reject.reason };

  const policy = getFieldPolicy(field);
  const existingEmpty = isEmptyValue(existingValue);
  const deterministicOrConfirmed = ['crawl', 'user_confirmation', 'manual_admin', 'manual_test', 'integration', 'chat'].includes(sourceType);

  if (conflict?.hasConflict) {
    return { status: 'contradicted', action: 'contradict', reason: conflict.reason || 'Candidate conflicts with existing profile value.' };
  }

  if (existingEmpty && confidence >= policy.autoAccept && sourceType === 'user_confirmation') {
    return { status: 'auto_accepted', action: 'accept', reason: 'User-confirmed fact auto-accepted.' };
  }

  if (existingEmpty && confidence >= policy.autoAccept && ['manual_test', 'manual_admin'].includes(sourceType)) {
    return { status: 'auto_accepted', action: 'accept', reason: 'Manual/admin supplied fact auto-accepted for test or operator workflow.' };
  }

  if (existingEmpty && confidence >= policy.autoAccept && deterministicOrConfirmed && !policy.brandPositioning) {
    return { status: 'auto_accepted', action: 'accept', reason: 'Field was empty, confidence was high, and source was acceptable for automatic memory.' };
  }

  if (confidence < policy.pending) {
    return { status: 'rejected', action: 'reject', reason: 'Confidence below pending threshold.' };
  }

  return { status: 'pending', action: 'review', reason: 'Candidate needs review before becoming durable business memory.' };
}

export function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.filter(v => !isEmptyValue(v)).length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

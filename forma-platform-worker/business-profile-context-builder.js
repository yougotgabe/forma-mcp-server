// =============================================================================
// FORMAUT - BUSINESS PROFILE CONTEXT BUILDER
// =============================================================================
// Produces compact context packets so LLM calls do not need the full database.
// =============================================================================

import { calculateProfileCompleteness } from './profile-completeness-engine.js';

export function buildBusinessProfileMemoryContext({ profile = {}, pendingCandidates = [], recentEvents = [] } = {}) {
  const completeness = calculateProfileCompleteness(profile || {});
  const known_facts = compactKnownFacts(profile || {});
  return {
    known_facts,
    missing_facts: completeness.missing_fields,
    pending_candidates: pendingCandidates.slice(0, 12).map(c => ({
      id: c.id,
      field: c.field,
      proposed_value: c.proposed_value,
      confidence: c.confidence,
      source_type: c.source_type,
      reason: c.reason,
    })),
    recent_changes: recentEvents.slice(0, 10).map(e => ({
      event_type: e.event_type,
      field: e.field,
      new_value: e.new_value,
      reason: e.reason,
      created_at: e.created_at,
    })),
    confidence_summary: profile.confidence_summary || {},
    completeness,
  };
}

export function compactKnownFacts(profile = {}) {
  const fields = [
    'business_name', 'industry', 'description', 'brand_tone', 'visual_style',
    'primary_services', 'secondary_services', 'service_area', 'location',
    'contact_methods', 'social_links', 'website_url', 'logo_sources',
  ];
  const out = {};
  for (const field of fields) {
    const value = profile[field];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    out[field] = value;
  }
  return out;
}

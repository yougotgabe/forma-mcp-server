// =============================================================================
// FORMAUT — CONTEXT SELECTOR
// =============================================================================
// Keeps model calls cheap by selecting only the facts needed for the current task.
// This module is dependency-free and Cloudflare Worker compatible.
// =============================================================================

export const CONTEXT_SELECTOR_VERSION = '1.0.0';

const FIELD_GROUPS = {
  identity: ['business_name', 'legal_name', 'industry', 'industry_category', 'target_customer', 'key_differentiators'],
  contact: ['phone', 'email', 'website_url', 'booking_url', 'location', 'service_area', 'hours'],
  offerings: ['services', 'products', 'price_range', 'common_questions'],
  brand: ['brand_tone', 'social_voice', 'emotional_goal', 'visual_style', 'primary_colors', 'secondary_colors', 'logo_url', 'logo_detected', 'existing_imagery'],
  goals: ['site_goal', 'feature_fit', 'feature_avoid', 'review_themes', 'design_confidence_level', 'status', 'profile_confidence'],
};

const INTENT_GROUPS = {
  greeting: [],
  empty: [],
  help: [],
  thanks: [],
  ack: [],
  cancel: [],
  undo: ['identity', 'goals'],
  url_only: ['identity', 'contact', 'brand'],
  contact_fact: ['identity', 'contact'],
  brand_fact: ['identity', 'brand'],
  business_description: ['identity', 'contact', 'offerings', 'brand', 'goals'],
  simple_question: ['identity', 'goals'],
  build_or_edit: ['identity', 'offerings', 'brand', 'goals'],
  unknown: ['identity', 'goals'],
};

export function selectContextPack(input = {}) {
  const {
    intent_type = input.intent?.type || 'unknown',
    message = '',
    business_profile = input.profile || null,
    recent_summary = null,
    session_summary = null,
    memory = [],
    kb_fragments = [],
    max_profile_fields = 24,
    max_memory_items = 8,
    max_kb_fragments = 3,
  } = input;

  const groups = new Set(INTENT_GROUPS[intent_type] || INTENT_GROUPS.unknown);
  addMessageDrivenGroups(groups, message);

  const selectedProfile = pickProfileFields(business_profile || {}, groups, max_profile_fields);
  const selectedMemory = selectMemoryItems(memory, groups, max_memory_items);
  const selectedKb = (kb_fragments || []).slice(0, max_kb_fragments).map(compactKbFragment);
  const summary = compactSummary(session_summary || recent_summary);

  const pack = {
    version: CONTEXT_SELECTOR_VERSION,
    intent_type,
    groups: [...groups],
    business_profile: selectedProfile,
    session_summary: summary,
    memory: selectedMemory,
    kb_fragments: selectedKb,
    omission_policy: 'Only selected fields are included. Missing fields may exist but were not relevant enough for this call.',
  };

  return {
    pack,
    estimated_tokens: estimateTokens(pack),
    excluded: explainExcludedGroups(groups),
  };
}

export function pickProfileFields(profile, groups, maxFields = 24) {
  const out = {};
  const orderedFields = [];
  for (const group of groups) {
    for (const field of FIELD_GROUPS[group] || []) orderedFields.push(field);
  }
  for (const field of [...new Set(orderedFields)].slice(0, maxFields)) {
    const value = profile?.[field];
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) {
      out[field] = value;
    }
  }
  return out;
}

export function selectMemoryItems(memory = [], groups = new Set(), maxItems = 8) {
  const allowedCategories = new Set([...groups, 'preference', 'decision', 'constraint']);
  return (memory || [])
    .filter(item => allowedCategories.has(item.category) || groups.has(item.key))
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, maxItems)
    .map(item => ({ category: item.category, key: item.key, value: item.value_json ?? item.value, confidence: item.confidence }));
}

export function compactSummary(summary) {
  if (!summary) return null;
  if (typeof summary === 'string') return summary.slice(0, 1200);
  return {
    summary: String(summary.summary || '').slice(0, 900),
    changes_made: (summary.changes_made || []).slice(0, 8),
    preferences_noted: String(summary.preferences_noted || '').slice(0, 600),
  };
}

export function compactKbFragment(fragment) {
  if (typeof fragment === 'string') return fragment.slice(0, 1000);
  return {
    title: fragment.title || fragment.name || 'KB fragment',
    reason: fragment.reason || fragment.match_reason || null,
    content: String(fragment.content || fragment.text || '').slice(0, 1000),
  };
}

function addMessageDrivenGroups(groups, message) {
  const text = String(message || '').toLowerCase();
  if (/phone|email|address|hours|contact|booking|location/.test(text)) groups.add('contact');
  if (/service|offer|product|price|package/.test(text)) groups.add('offerings');
  if (/tone|voice|brand|color|logo|style|visual|premium|approachable/.test(text)) groups.add('brand');
  if (/homepage|landing|site|cta|conversion|seo|goal|feature/.test(text)) groups.add('goals');
}

function explainExcludedGroups(groups) {
  return Object.keys(FIELD_GROUPS).filter(group => !groups.has(group));
}

export function estimateTokens(value) {
  const chars = JSON.stringify(value || {}).length;
  return Math.ceil(chars / 4);
}

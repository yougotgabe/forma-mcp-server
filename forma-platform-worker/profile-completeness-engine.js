// =============================================================================
// FORMAUT - BUSINESS PROFILE COMPLETENESS ENGINE
// =============================================================================

import { isEmptyValue } from './memory-confidence-policy.js';

export const COMPLETENESS_FIELDS = [
  ['business_name', 12],
  ['industry', 10],
  ['primary_services', 14],
  ['contact_methods', 12],
  ['location', 10],
  ['service_area', 8],
  ['brand_tone', 8],
  ['visual_style', 8],
  ['website_url', 6],
  ['social_links', 4],
  ['description', 8],
];

export function calculateProfileCompleteness(profile = {}) {
  let score = 0;
  const missing_fields = [];
  const flags = {};

  for (const [field, weight] of COMPLETENESS_FIELDS) {
    const has = !isEmptyValue(profile[field]);
    flags[`has_${field}`] = has;
    if (has) score += weight;
    else missing_fields.push(field);
  }

  const capped = Math.max(0, Math.min(100, Math.round(score)));
  return {
    profile_id: profile.id || null,
    has_business_name: flags.has_business_name || false,
    has_industry: flags.has_industry || false,
    has_services: flags.has_primary_services || false,
    has_contact: flags.has_contact_methods || false,
    has_location: flags.has_location || false,
    has_tone: flags.has_brand_tone || false,
    has_visual_style: flags.has_visual_style || false,
    has_social_links: flags.has_social_links || false,
    score: capped,
    missing_fields,
    next_questions: prioritizeNextQuestions(missing_fields),
    enough_for_preview: capped >= 45 && flags.has_business_name && flags.has_services,
    enough_for_build: capped >= 70 && flags.has_business_name && flags.has_services && flags.has_contact_methods,
  };
}

export function prioritizeNextQuestions(missing = []) {
  const questionByField = {
    business_name: 'What is the business name clients should see?',
    industry: 'What industry or category best describes the business?',
    primary_services: 'What are the main services or offers?',
    contact_methods: 'How should customers contact the business?',
    location: 'Where is the business based?',
    service_area: 'What area does the business serve?',
    brand_tone: 'What should the brand sound like?',
    visual_style: 'What should the website look and feel like?',
    website_url: 'Is there an existing website?',
    social_links: 'Are there social profiles we should connect?',
    description: 'How should the business be described in one or two sentences?',
  };
  return missing.slice(0, 4).map(field => ({ field, question: questionByField[field] || `Can you confirm ${field}?` }));
}

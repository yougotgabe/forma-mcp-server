// =============================================================================
// FORMAUT — DESIGN BRIEF BUILDER
// =============================================================================
// Pure deterministic function. Takes a business profile and returns a design
// brief: which sections to use, what CTA, what color strategy, what tone.
// No AI call. No side effects. Fast and cheap.
// =============================================================================

import { INDUSTRY_PRESETS } from './industry-presets.js';

/**
 * Build a design brief from a business profile.
 * Returns the section list, CTA strategy, color hints, tone, etc.
 *
 * @param {object} profile  - Row from business_profiles table
 * @returns {object}        - Design brief
 */
export function buildDesignBrief(profile) {
  const industry = normalizeIndustry(profile.industry || profile.industry_category || 'default');
  const preset = INDUSTRY_PRESETS[industry] || INDUSTRY_PRESETS.default;

  const hasCommerce = detectCommerce(profile);
  const hasGallery = detectGallery(profile);
  const hasHours = Boolean(profile.hours);
  const hasPhone = Boolean(profile.phone || profile.contact_methods?.phone);
  const hasEmail = Boolean(profile.email || profile.contact_methods?.email);
  const hasSocial = Boolean(profile.social_links && Object.keys(profile.social_links || {}).length > 0);
  const hasTestimonials = Boolean(profile.testimonials?.length);
  const hasTeam = Boolean(profile.team?.length);
  const location = profile.location || profile.service_area || '';

  // Select sections based on preset + what data is available
  const sections = buildSectionList(preset, {
    hasCommerce, hasGallery, hasHours, hasPhone, hasEmail,
    hasSocial, hasTestimonials, hasTeam, location,
  });

  // CTA strategy
  const ctaStrategy = resolveCtaStrategy(industry, hasCommerce, preset);

  // Color strategy
  const colorStrategy = buildColorStrategy(profile, industry, preset);

  // Tone
  const tone = resolveTone(profile, preset);

  // Font pairing
  const fonts = resolveFontPairing(industry, tone);

  return {
    industry,
    sections,
    primary_cta: ctaStrategy.primary,
    secondary_cta: ctaStrategy.secondary,
    cta_strategy: ctaStrategy.strategy,
    color_strategy: colorStrategy,
    tone,
    fonts,
    archetype: preset.archetype,
    conversion_priority: preset.conversionPriority || [],
    visual_bias: preset.visualBias || [],
    mobile_priorities: resolveMobilePriorities(industry, sections),
    has_commerce: hasCommerce,
    has_gallery: hasGallery,
    generated_at: new Date().toISOString(),
  };
}

// ── Section list builder ──────────────────────────────────────────────────────

function buildSectionList(preset, flags) {
  const base = [...(preset.sections || ['hero', 'services', 'about', 'contact'])];
  const extras = [];

  // Always-present additions when data exists
  if (flags.hasGallery && !base.includes('gallery')) extras.push('gallery');
  if (flags.hasTestimonials && !base.includes('social_proof')) extras.push('social_proof');
  if (flags.hasHours && !base.includes('hours_location') && !base.includes('visit_cta')) extras.push('hours_location');
  if (flags.hasTeam && !base.includes('team')) extras.push('team');

  // Ensure contact is always last
  const ordered = [...base, ...extras].filter(Boolean);
  const hasContact = ordered.includes('contact_cta') || ordered.includes('contact') || ordered.includes('visit_cta');
  if (!hasContact) ordered.push('contact_cta');

  // Deduplicate preserving order
  return [...new Set(ordered)];
}

// ── CTA strategy ─────────────────────────────────────────────────────────────

function resolveCtaStrategy(industry, hasCommerce, preset) {
  if (hasCommerce) return { strategy: 'shop', primary: 'Shop Now', secondary: 'Learn More' };

  const urgentServices = ['hvac', 'roofing', 'plumbing', 'electrician', 'emergency'];
  if (urgentServices.some((s) => industry.includes(s))) {
    return { strategy: 'quote-first', primary: 'Request a Free Quote', secondary: 'Call Now' };
  }

  const bookingServices = ['photographer', 'salon', 'spa', 'massage', 'tattoo', 'barbershop'];
  if (bookingServices.some((s) => industry.includes(s))) {
    return { strategy: 'booking', primary: 'Book an Appointment', secondary: 'See Our Work' };
  }

  const menuServices = ['restaurant', 'cafe', 'bakery', 'bar', 'diner'];
  if (menuServices.some((s) => industry.includes(s))) {
    return { strategy: 'menu', primary: 'View Our Menu', secondary: 'Get Directions' };
  }

  const mediaServices = ['musician', 'band', 'artist', 'photographer', 'videographer'];
  if (mediaServices.some((s) => industry.includes(s))) {
    return { strategy: 'portfolio', primary: 'See Our Work', secondary: 'Get In Touch' };
  }

  return { strategy: 'contact', primary: 'Get In Touch', secondary: 'Learn More' };
}

// ── Color strategy ────────────────────────────────────────────────────────────

const INDUSTRY_PALETTE_DEFAULTS = {
  restaurant: { bg: '#1a1208', text: '#f5efe6', accent: '#c8641a', surface: '#2a1f12' },
  cafe: { bg: '#1c1510', text: '#f0e8d8', accent: '#b5762a', surface: '#2a2018' },
  contractor: { bg: '#0d1117', text: '#e6eaf0', accent: '#2563eb', surface: '#1c2330' },
  hvac: { bg: '#0f1620', text: '#e4ecf5', accent: '#0284c7', surface: '#1a2535' },
  roofing: { bg: '#0e1210', text: '#e8ebe6', accent: '#16a34a', surface: '#1a201a' },
  photographer: { bg: '#0a0a0a', text: '#f5f5f5', accent: '#a3a3a3', surface: '#171717' },
  musician: { bg: '#09090b', text: '#fafafa', accent: '#a855f7', surface: '#18181b' },
  ecommerce: { bg: '#fafafa', text: '#111111', accent: '#111111', surface: '#ffffff' },
  salon: { bg: '#1a0a0f', text: '#f5e8ec', accent: '#be185d', surface: '#2a1018' },
  default: { bg: '#0e0c0a', text: '#f5f0e8', accent: '#c85a1e', surface: '#1a1612' },
};

function buildColorStrategy(profile, industry, preset) {
  // Use extracted brand colors if available and valid
  const extracted = profile.primary_colors;
  if (extracted && Array.isArray(extracted) && extracted.length >= 2) {
    return {
      source: 'extracted_brand',
      bg: extracted[0],
      text: textColorFor(extracted[0]),
      accent: extracted[1],
      surface: darken(extracted[0]),
      confidence: 0.7,
    };
  }

  // Industry defaults
  const defaults = INDUSTRY_PALETTE_DEFAULTS[industry] || INDUSTRY_PALETTE_DEFAULTS.default;
  return { source: 'industry_default', ...defaults, confidence: 0.5 };
}

// ── Tone ──────────────────────────────────────────────────────────────────────

const INDUSTRY_TONE_DEFAULTS = {
  restaurant: 'warm, inviting, and sensory',
  cafe: 'friendly, cozy, and conversational',
  contractor: 'confident, direct, and trustworthy',
  hvac: 'urgent, clear, and reliable',
  roofing: 'dependable, local, and straightforward',
  photographer: 'artistic, elegant, and personal',
  musician: 'expressive, energetic, and authentic',
  ecommerce: 'clear, benefit-driven, and action-oriented',
  salon: 'welcoming, stylish, and personal',
  default: 'professional, approachable, and clear',
};

function resolveTone(profile, preset) {
  if (profile.brand_tone) return profile.brand_tone;
  if (profile.social_voice) return profile.social_voice;
  const industry = normalizeIndustry(profile.industry || 'default');
  return INDUSTRY_TONE_DEFAULTS[industry] || INDUSTRY_TONE_DEFAULTS.default;
}

// ── Font pairing ──────────────────────────────────────────────────────────────

function resolveFontPairing(industry, tone) {
  if (['musician', 'artist', 'photographer'].some((i) => industry.includes(i))) {
    return { heading: 'DM Serif Display', body: 'DM Sans', mono: 'DM Mono' };
  }
  if (['restaurant', 'cafe', 'bakery'].some((i) => industry.includes(i))) {
    return { heading: 'Playfair Display', body: 'DM Sans', mono: 'DM Mono' };
  }
  if (tone.includes('luxury') || tone.includes('premium') || tone.includes('elegant')) {
    return { heading: 'DM Serif Display', body: 'DM Sans', mono: 'DM Mono' };
  }
  return { heading: 'DM Sans', body: 'DM Sans', mono: 'DM Mono' };
}

// ── Mobile priorities ─────────────────────────────────────────────────────────

function resolveMobilePriorities(industry, sections) {
  const priorities = ['tap_target_ctas', 'fast_contact_access'];
  if (['restaurant', 'cafe'].some((i) => industry.includes(i))) {
    priorities.unshift('hours_location_menu_visible');
  }
  if (sections.includes('booking_cta')) priorities.unshift('booking_cta_above_fold');
  return priorities;
}

// ── Industry normalization ────────────────────────────────────────────────────

const INDUSTRY_ALIASES = {
  'food service': 'restaurant',
  'food & beverage': 'restaurant',
  'coffee shop': 'cafe',
  'coffee': 'cafe',
  'general contractor': 'contractor',
  'construction': 'contractor',
  'air conditioning': 'hvac',
  'heating and cooling': 'hvac',
  'hair salon': 'salon',
  'beauty salon': 'salon',
  'hair care': 'salon',
  'photography': 'photographer',
  'music': 'musician',
  'band': 'musician',
  'retail': 'ecommerce',
  'online store': 'ecommerce',
};

export function normalizeIndustry(raw) {
  if (!raw) return 'default';
  const lower = String(raw).toLowerCase().trim();
  return INDUSTRY_ALIASES[lower] || lower;
}

// ── Color utilities ───────────────────────────────────────────────────────────

function textColorFor(bg) {
  // Very naive — assume dark bg = light text
  if (!bg || typeof bg !== 'string') return '#f5f0e8';
  const hex = bg.replace('#', '');
  if (hex.length !== 6) return '#f5f0e8';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#111111' : '#f5f0e8';
}

function darken(hex) {
  if (!hex || typeof hex !== 'string' || hex.length !== 7) return '#1a1612';
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - 20);
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - 20);
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - 20);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

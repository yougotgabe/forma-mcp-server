// =============================================================================
// FORMAUT — PROFILE READINESS ENGINE
// Extends profile-completeness-engine with business-type-aware required fields,
// a formal readiness score, and a "ready to build" gate.
//
// Consumed by:
//   - onboarding state machine (before transitioning to 'building')
//   - dashboard-build.js (shows Build button only when ready)
//   - chat preflight (warns when profile is thin)
//   - POST /profile/readiness worker endpoint
// =============================================================================

// ---------------------------------------------------------------------------
// 1. REQUIRED FIELDS BY BUSINESS TYPE
// These are the minimum fields needed before Formaut will queue a build.
// Score thresholds and "blocker" vs "recommended" are defined here.
// ---------------------------------------------------------------------------

const REQUIRED_BY_TYPE = {
  // Defaults — applies if business_type is unknown
  default: {
    required: ['business_name', 'industry', 'primary_services', 'contact_methods'],
    recommended: ['location', 'brand_tone', 'description'],
    min_score: 60,
  },

  // Local service business (plumber, electrician, cleaner, landscaper, etc.)
  local_service: {
    required: ['business_name', 'primary_services', 'contact_methods', 'location', 'service_area'],
    recommended: ['brand_tone', 'description', 'team_size', 'years_in_business'],
    min_score: 65,
  },

  // Restaurant / cafe / food service
  restaurant: {
    required: ['business_name', 'primary_services', 'contact_methods', 'location', 'hours'],
    recommended: ['menu_items', 'brand_tone', 'description', 'social_links'],
    min_score: 65,
  },

  // Retail (physical store or online shop)
  retail: {
    required: ['business_name', 'primary_services', 'contact_methods', 'location'],
    recommended: ['brand_tone', 'description', 'price_range', 'social_links'],
    min_score: 60,
  },

  // E-commerce (digital / Printify / Stripe products)
  ecommerce: {
    required: ['business_name', 'primary_services', 'contact_methods'],
    recommended: ['brand_tone', 'description', 'price_range', 'social_links'],
    // Stripe connection is tracked separately via credential checks
    min_score: 55,
  },

  // Professional / consultant / agency
  professional: {
    required: ['business_name', 'primary_services', 'contact_methods', 'description'],
    recommended: ['location', 'brand_tone', 'portfolio_items', 'credentials'],
    min_score: 65,
  },

  // Health / wellness / fitness
  wellness: {
    required: ['business_name', 'primary_services', 'contact_methods', 'location'],
    recommended: ['hours', 'brand_tone', 'description', 'credentials'],
    min_score: 60,
  },

  // Beauty / salon / spa
  beauty: {
    required: ['business_name', 'primary_services', 'contact_methods', 'location', 'hours'],
    recommended: ['brand_tone', 'description', 'team_bios', 'social_links'],
    min_score: 60,
  },

  // Creative / artist / photographer / musician
  creative: {
    required: ['business_name', 'primary_services', 'contact_methods', 'description'],
    recommended: ['portfolio_items', 'brand_tone', 'social_links', 'location'],
    min_score: 55,
  },

  // Nonprofit / community org
  nonprofit: {
    required: ['business_name', 'description', 'contact_methods', 'mission'],
    recommended: ['location', 'primary_services', 'brand_tone', 'social_links'],
    min_score: 60,
  },

  // Real estate
  real_estate: {
    required: ['business_name', 'primary_services', 'contact_methods', 'location', 'service_area'],
    recommended: ['brand_tone', 'description', 'credentials', 'social_links'],
    min_score: 65,
  },

  // Auto / vehicle service
  auto: {
    required: ['business_name', 'primary_services', 'contact_methods', 'location', 'hours'],
    recommended: ['service_area', 'brand_tone', 'description'],
    min_score: 60,
  },
};

// ---------------------------------------------------------------------------
// 2. READINESS SCORE CALCULATION
// Returns a structured readiness report. Separate from profile completeness
// score (which is a general health metric). Readiness is a build gate.
// ---------------------------------------------------------------------------

/**
 * @param {Object} profile  - business profile record from memory
 * @param {Object} options
 * @param {Object} options.credentials - { github: bool, cloudflare: bool, supabase: bool }
 * @param {string} options.business_type - explicit type override (else inferred from profile)
 * @returns {ReadinessReport}
 */
export function calculateBuildReadiness(profile = {}, options = {}) {
  const business_type = options.business_type || profile.business_type || inferBusinessType(profile);
  const spec = REQUIRED_BY_TYPE[business_type] || REQUIRED_BY_TYPE.default;
  const creds = options.credentials || {};

  // --- Required field check ---
  const missingRequired = spec.required.filter(field => isBlank(profile[field]));
  const missingRecommended = spec.recommended.filter(field => isBlank(profile[field]));

  // --- Profile score (simple) ---
  const totalFields = spec.required.length + spec.recommended.length;
  const filledRequired = spec.required.length - missingRequired.length;
  const filledRecommended = spec.recommended.length - missingRecommended.length;

  // Required fields are weighted 2x recommended
  const weightedFilled = filledRequired * 2 + filledRecommended;
  const weightedTotal = spec.required.length * 2 + spec.recommended.length;
  const profile_score = Math.round((weightedFilled / weightedTotal) * 100);

  // --- Infrastructure check ---
  const infra_ready = Boolean(creds.github && creds.cloudflare && creds.supabase);
  const missing_infra = [];
  if (!creds.github) missing_infra.push('github');
  if (!creds.cloudflare) missing_infra.push('cloudflare');
  if (!creds.supabase) missing_infra.push('supabase');

  // --- Blockers (hard stops) ---
  const blockers = [];

  if (missingRequired.length > 0) {
    blockers.push({
      type: 'profile_incomplete',
      label: 'Missing key business information',
      fields: missingRequired,
      message: humanizeBlocker('profile_incomplete', missingRequired, business_type),
    });
  }

  if (!infra_ready) {
    blockers.push({
      type: 'infrastructure_missing',
      label: 'Accounts not connected',
      services: missing_infra,
      message: humanizeBlocker('infrastructure_missing', missing_infra),
    });
  }

  if (profile_score < spec.min_score) {
    blockers.push({
      type: 'score_below_threshold',
      label: 'Not enough information to build a good site',
      score: profile_score,
      threshold: spec.min_score,
      message: `We know ${profile_score}% of what we need. We'll build a better site with a bit more detail.`,
    });
  }

  // --- Recommendations (non-blocking improvements) ---
  const recommendations = missingRecommended.map(field => ({
    field,
    label: humanizeFieldName(field),
    message: recommendationFor(field),
  }));

  // --- Final verdict ---
  const ready = blockers.length === 0;
  const ready_for_preview = missingRequired.length === 0 && infra_ready && profile_score >= 40;

  return {
    ready,
    ready_for_preview,
    business_type,
    profile_score,
    min_score: spec.min_score,
    infra_ready,
    missing_infra,
    missing_required: missingRequired,
    missing_recommended: missingRecommended,
    blockers,
    recommendations,
    next_question: blockers.length > 0 ? suggestNextQuestion(missingRequired, missingRecommended) : null,
    build_trigger_label: ready ? 'Build my site' : `Almost ready — ${blockers[0]?.label}`,
    summary: ready
      ? `Ready to build. ${spec.required.length} required fields complete, infrastructure connected.`
      : `Not yet ready. ${blockers.length} blocker${blockers.length > 1 ? 's' : ''} to resolve.`,
  };
}

// ---------------------------------------------------------------------------
// 3. READINESS GATE — ENFORCE BEFORE JOB QUEUE
// Call this inside generate_homepage / generate_seo job handlers.
// Throws a structured error if the build gate is not met.
// ---------------------------------------------------------------------------

export function assertReadyToBuild(profile, options = {}) {
  const report = calculateBuildReadiness(profile, options);
  if (!report.ready) {
    const err = new Error('Build gate not met');
    err.code = 'BUILD_NOT_READY';
    err.report = report;
    err.blockers = report.blockers;
    err.user_message = report.blockers[0]?.message || 'More information is needed before building.';
    throw err;
  }
  return report;
}

// ---------------------------------------------------------------------------
// 4. BUSINESS TYPE INFERENCE
// Falls back to 'default' — prefer explicit profile.business_type
// ---------------------------------------------------------------------------

export function inferBusinessType(profile = {}) {
  const industry = (profile.industry || '').toLowerCase();
  const services = (profile.primary_services || []).join(' ').toLowerCase();
  const combined = `${industry} ${services}`;

  if (/restaurant|cafe|food|catering|bakery|bar|pub|brewery/.test(combined)) return 'restaurant';
  if (/salon|spa|beauty|nail|barber|hair/.test(combined)) return 'beauty';
  if (/gym|fitness|yoga|pilates|personal.train|wellness|massage|chiro|physio/.test(combined)) return 'wellness';
  if (/plumb|electric|hvac|roofing|landscap|clean|pest|handyman|contractor/.test(combined)) return 'local_service';
  if (/real.estate|realtor|property|mortgage|agent/.test(combined)) return 'real_estate';
  if (/auto|mechanic|car.repair|detailing|tire|vehicle/.test(combined)) return 'auto';
  if (/nonprofit|501|charity|foundation|community org/.test(combined)) return 'nonprofit';
  if (/photo|artist|musician|designer|illustrat|creative|film/.test(combined)) return 'creative';
  if (/consult|attorney|lawyer|accountant|cpa|financial.advis|coach|therapist/.test(combined)) return 'professional';
  if (/print|merch|product|store|shop|ecomm/.test(combined)) return 'ecommerce';
  if (/retail|boutique|gift|antique/.test(combined)) return 'retail';

  return 'default';
}

// ---------------------------------------------------------------------------
// 5. DASHBOARD STATE HELPERS
// Used by dashboard-build.js to determine what UI state to render
// ---------------------------------------------------------------------------

export function getReadinessUIState(report) {
  if (report.ready) {
    return {
      state: 'ready',
      action: 'build',
      cta: 'Build my site',
      detail: 'Everything looks good. Ready to generate your site.',
      show_build_button: true,
      blockers_visible: false,
    };
  }

  if (report.ready_for_preview) {
    return {
      state: 'preview_only',
      action: 'preview',
      cta: 'Preview draft site',
      detail: 'Connect your accounts to publish.',
      show_build_button: false,
      blockers_visible: true,
    };
  }

  if (!report.infra_ready) {
    return {
      state: 'needs_infra',
      action: 'connect',
      cta: 'Connect accounts',
      detail: `Connect ${report.missing_infra.join(', ')} to continue.`,
      show_build_button: false,
      blockers_visible: true,
    };
  }

  return {
    state: 'needs_profile',
    action: 'chat',
    cta: 'Tell Formaut about your business',
    detail: report.next_question || 'Formaut needs a bit more information before building.',
    show_build_button: false,
    blockers_visible: true,
  };
}

// ---------------------------------------------------------------------------
// 6. WORKER ENDPOINT HANDLER
// Register as: if (path === '/profile/readiness') return handleProfileReadiness(body, env);
// ---------------------------------------------------------------------------

export async function handleProfileReadiness(body, env) {
  const { slug } = body;
  if (!slug) return jsonError('slug required', 400);

  try {
    // Fetch business profile
    const profileRes = await supabaseGet(env, `/rest/v1/business_profile?client_slug=eq.${slug}&limit=1`);
    const profile = profileRes?.[0] || {};

    // Fetch credential status (checks for non-null encrypted fields)
    const clientRes = await supabaseGet(env, `/rest/v1/clients?slug=eq.${slug}&select=github_token_enc,cloudflare_token_enc,supabase_mgmt_token_enc&limit=1`);
    const clientRow = clientRes?.[0] || {};
    const credentials = {
      github: Boolean(clientRow.github_token_enc),
      cloudflare: Boolean(clientRow.cloudflare_token_enc),
      supabase: Boolean(clientRow.supabase_mgmt_token_enc),
    };

    const report = calculateBuildReadiness(profile, { credentials });
    const ui = getReadinessUIState(report);

    return json({ ok: true, slug, readiness: report, ui });
  } catch (err) {
    return jsonError(err.message, 500);
  }
}

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

function isBlank(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string' && val.trim() === '') return true;
  if (Array.isArray(val) && val.length === 0) return true;
  return false;
}

function humanizeBlocker(type, items, businessType) {
  if (type === 'profile_incomplete') {
    const labels = items.map(humanizeFieldName).join(', ');
    return `Still need: ${labels}. Formaut builds a better site with these filled in.`;
  }
  if (type === 'infrastructure_missing') {
    const labels = items.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');
    return `Connect ${labels} to give Formaut a place to publish your site.`;
  }
  return 'More information needed.';
}

function humanizeFieldName(field) {
  const map = {
    business_name: 'Business name',
    industry: 'Industry',
    primary_services: 'Services',
    contact_methods: 'Contact info',
    location: 'Location',
    service_area: 'Service area',
    brand_tone: 'Brand voice',
    visual_style: 'Visual style',
    website_url: 'Existing website',
    social_links: 'Social profiles',
    description: 'Business description',
    hours: 'Hours of operation',
    menu_items: 'Menu items',
    team_size: 'Team size',
    years_in_business: 'Years in business',
    portfolio_items: 'Portfolio or work samples',
    credentials: 'Credentials or certifications',
    mission: 'Mission statement',
    price_range: 'Price range',
    team_bios: 'Team bios',
  };
  return map[field] || field.replace(/_/g, ' ');
}

function recommendationFor(field) {
  const map = {
    brand_tone: "Knowing your brand voice helps Formaut write copy that sounds like you.",
    description: "A short business description improves SEO and helps convert visitors.",
    social_links: "Social links add credibility and let visitors find you on their preferred platform.",
    portfolio_items: "Work samples or photos dramatically increase trust for service businesses.",
    hours: "Business hours are one of the most-searched pieces of local business info.",
    team_bios: "Introducing your team builds trust and makes the site feel personal.",
    credentials: "Certifications and credentials are especially important in regulated industries.",
    years_in_business: "Tenure signals reliability — even one sentence makes a difference.",
  };
  return map[field] || `Adding ${humanizeFieldName(field)} improves your site quality.`;
}

function suggestNextQuestion(missingRequired, missingRecommended) {
  const all = [...missingRequired, ...missingRecommended];
  if (all.length === 0) return null;
  const questions = {
    business_name: "What's the business name customers should see on your site?",
    primary_services: "What are the main services or products you offer?",
    contact_methods: "How should customers reach you — phone, email, or both?",
    location: "Where is the business based?",
    service_area: "What area do you serve?",
    hours: "What are your business hours?",
    description: "How would you describe your business in one or two sentences?",
    brand_tone: "How should your site sound — professional, friendly, bold?",
    mission: "What's the mission or purpose of your organization?",
  };
  return questions[all[0]] || `Can you tell Formaut more about ${humanizeFieldName(all[0])}?`;
}

// Minimal Supabase fetch helper (uses env.PLATFORM_SUPABASE_URL / SERVICE_KEY)
async function supabaseGet(env, path) {
  const res = await fetch(`${env.PLATFORM_SUPABASE_URL || env.SUPABASE_URL}${path}`, {
    headers: {
      apikey: (env.PLATFORM_SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return null;
  return res.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

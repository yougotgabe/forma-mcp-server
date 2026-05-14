// =============================================================================
// FORMAUT — COST-AWARE DESIGN QUALITY ENGINE
// =============================================================================
// Purpose:
//   Convert business/profile/crawl signals into deterministic design briefs,
//   section blueprints, quality checks, and compact LLM prompt packs.
//
// Why this exists:
//   Website quality should not require sending a full design director prompt to
//   Anthropic every time. This engine does the repeatable design reasoning in
//   code, then reserves the model for high-value copy, unusual layout decisions,
//   or final synthesis.
// =============================================================================

export const DESIGN_QUALITY_ENGINE_VERSION = '1.0.0';

const INDUSTRY_PRESETS = {
  restaurant: {
    archetype: 'sensory_local_conversion',
    sections: ['hero', 'menu_preview', 'hours_location', 'featured_items', 'social_proof', 'visit_cta'],
    conversionPriority: ['call', 'directions', 'menu', 'reservation'],
    visualBias: ['warmth', 'appetite', 'hospitality', 'local texture'],
    avoid: ['generic stock business imagery', 'hard-to-find hours', 'hidden menu'],
  },
  cafe: {
    archetype: 'daily_habit_destination',
    sections: ['hero', 'signature_items', 'menu_preview', 'atmosphere', 'hours_location', 'visit_cta'],
    conversionPriority: ['directions', 'hours', 'menu', 'call'],
    visualBias: ['cozy', 'crafted', 'morning light', 'community'],
    avoid: ['overly corporate tone', 'buried location info'],
  },
  contractor: {
    archetype: 'trust_first_service',
    sections: ['hero', 'service_cards', 'trust_bar', 'process', 'gallery_proof', 'quote_cta'],
    conversionPriority: ['quote', 'call', 'service_area', 'proof'],
    visualBias: ['clean', 'durable', 'competent', 'before-after evidence'],
    avoid: ['vague services', 'no licensing/proof area', 'weak CTA'],
  },
  hvac: {
    archetype: 'urgent_trust_service',
    sections: ['hero', 'emergency_bar', 'service_cards', 'trust_bar', 'maintenance_plan', 'quote_cta'],
    conversionPriority: ['call', 'emergency service', 'quote', 'service_area'],
    visualBias: ['clear', 'fast', 'dependable', 'local'],
    avoid: ['slow decorative hero', 'hidden phone number', 'unclear emergency coverage'],
  },
  roofing: {
    archetype: 'proof_heavy_local_service',
    sections: ['hero', 'storm_repair_cta', 'service_cards', 'insurance_help', 'gallery_proof', 'quote_cta'],
    conversionPriority: ['inspection', 'call', 'storm repair', 'proof'],
    visualBias: ['weather-resistant', 'local credibility', 'strong contrast', 'project proof'],
    avoid: ['generic house photo without proof', 'unclear inspection offer'],
  },
  musician: {
    archetype: 'media_first_fan_conversion',
    sections: ['hero', 'latest_release', 'music_embeds', 'shows', 'video', 'newsletter_cta'],
    conversionPriority: ['listen', 'follow', 'tickets', 'contact'],
    visualBias: ['immersive', 'editorial', 'motion', 'album-art led'],
    avoid: ['business-card-only site', 'music hidden below fold'],
  },
  photographer: {
    archetype: 'portfolio_trust_booking',
    sections: ['hero_gallery', 'portfolio_grid', 'services', 'experience', 'testimonials', 'booking_cta'],
    conversionPriority: ['portfolio', 'booking', 'pricing signal', 'contact'],
    visualBias: ['image-led', 'quiet UI', 'elegant spacing', 'fast browsing'],
    avoid: ['heavy visual chrome', 'tiny thumbnails', 'unclear booking path'],
  },
  ecommerce: {
    archetype: 'product_discovery_conversion',
    sections: ['hero', 'featured_products', 'collection_grid', 'trust_bar', 'reviews', 'shop_cta'],
    conversionPriority: ['shop', 'featured products', 'trust', 'shipping/returns'],
    visualBias: ['clear product hierarchy', 'mobile cards', 'fast scanning'],
    avoid: ['unclear product cards', 'hidden price/CTA', 'too much copy'],
  },
  default: {
    archetype: 'clear_local_business',
    sections: ['hero', 'value_props', 'services', 'proof', 'about', 'contact_cta'],
    conversionPriority: ['primary CTA', 'contact', 'services', 'trust'],
    visualBias: ['clear', 'credible', 'responsive', 'business-specific'],
    avoid: ['template sameness', 'weak section hierarchy', 'generic claims'],
  },
};

const TONE_TO_STYLE = {
  premium: { density: 'spacious', radius: 'large', contrast: 'soft-high', motion: 'subtle', typography: 'editorial' },
  friendly: { density: 'comfortable', radius: 'large', contrast: 'warm-medium', motion: 'gentle', typography: 'humanist' },
  rugged: { density: 'compact', radius: 'medium', contrast: 'high', motion: 'direct', typography: 'sturdy' },
  modern: { density: 'spacious', radius: 'xlarge', contrast: 'high', motion: 'smooth', typography: 'clean' },
  calm: { density: 'spacious', radius: 'large', contrast: 'low-medium', motion: 'minimal', typography: 'soft' },
  playful: { density: 'comfortable', radius: 'xlarge', contrast: 'colorful', motion: 'expressive', typography: 'rounded' },
};

export function createDesignQualityPack(input = {}) {
  const profile = input.profile || input.business_profile || {};
  const crawl = input.crawl || input.existing_site_crawl || {};
  const requested = input.request || input.user_request || '';

  const industry = inferIndustry(profile, crawl, requested);
  const preset = INDUSTRY_PRESETS[industry] || INDUSTRY_PRESETS.default;
  const toneTags = inferToneTags(profile, crawl, requested);
  const tokens = buildDesignTokens({ profile, crawl, preset, toneTags });
  const blueprint = buildPageBlueprint({ profile, crawl, preset, industry, tokens });
  const qualityRules = buildQualityRules({ preset, industry });
  const llmPack = buildCompactLlmDesignPack({ profile, crawl, requested, industry, preset, toneTags, tokens, blueprint, qualityRules });
  const costPlan = estimateDesignCostPlan({ requested, blueprint, llmPack });

  return {
    ok: true,
    version: DESIGN_QUALITY_ENGINE_VERSION,
    industry,
    archetype: preset.archetype,
    tone_tags: toneTags,
    design_tokens: tokens,
    page_blueprint: blueprint,
    quality_rules: qualityRules,
    llm_pack: llmPack,
    cost_plan: costPlan,
  };
}

export function buildDeterministicHomepageHtml(pack, options = {}) {
  const p = pack?.page_blueprint || {};
  const tokens = pack?.design_tokens || {};
  const profile = options.profile || {};
  const businessName = escapeHtml(profile.business_name || p.business_name || 'Your Business');
  const headline = escapeHtml(p.hero?.headline || `A better online home for ${businessName}`);
  const subheadline = escapeHtml(p.hero?.subheadline || 'Clear services, trusted proof, and a fast path for customers to take action.');
  const cta = escapeHtml(p.hero?.primary_cta || 'Get Started');
  const secondaryCta = escapeHtml(p.hero?.secondary_cta || 'View Services');
  const services = (p.sections || []).find((s) => s.type === 'services')?.items || profile.services || ['Primary service', 'Customer support', 'Local expertise'];
  const proof = (p.sections || []).find((s) => s.type === 'proof')?.items || ['Locally owned', 'Clear communication', 'Built for mobile'];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${businessName}</title>
  <style>${buildCss(tokens)}</style>
</head>
<body>
  <main class="site-shell">
    <nav class="nav"><strong>${businessName}</strong><a href="#contact">${cta}</a></nav>
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow">${escapeHtml(pack?.archetype || 'business website')}</span>
        <h1>${headline}</h1>
        <p>${subheadline}</p>
        <div class="actions"><a class="btn primary" href="#contact">${cta}</a><a class="btn secondary" href="#services">${secondaryCta}</a></div>
      </div>
      <div class="hero-card"><span>Design intent</span><strong>${escapeHtml((pack?.tone_tags || []).slice(0,3).join(' · ') || 'clear · credible · responsive')}</strong><p>${escapeHtml((pack?.quality_rules?.above_the_fold || [])[0] || 'Make the main action obvious within five seconds.')}</p></div>
    </section>
    <section class="trust-strip">${proof.slice(0,4).map((x) => `<div>${escapeHtml(x)}</div>`).join('')}</section>
    <section id="services" class="section"><div><span class="eyebrow">What customers need fast</span><h2>Services made easy to understand.</h2></div><div class="grid">${services.slice(0,6).map((s) => `<article class="card"><h3>${escapeHtml(typeof s === 'string' ? s : s?.name || s?.label || 'Service')}</h3><p>Clear details, proof, and a direct next step.</p></article>`).join('')}</div></section>
    <section id="contact" class="cta"><h2>Ready for the next step?</h2><p>Formaut can use this deterministic structure as a low-cost starting point, then spend model calls only where custom judgment matters.</p><a class="btn primary" href="mailto:${escapeHtml(profile.email || 'hello@example.com')}">${cta}</a></section>
  </main>
</body>
</html>`;
}

function inferIndustry(profile, crawl, requested) {
  const words = [profile.industry, profile.business_type, profile.category, requested, ...(profile.services || []), ...(crawl.headings || []), ...(crawl.texts || [])]
    .flat().filter(Boolean).join(' ').toLowerCase();
  const checks = [
    ['hvac', ['hvac', 'heating', 'cooling', 'air conditioning', 'furnace']],
    ['roofing', ['roof', 'roofing', 'storm damage', 'shingles']],
    ['contractor', ['contractor', 'construction', 'remodel', 'plumbing', 'electrician', 'landscaping']],
    ['restaurant', ['restaurant', 'menu', 'dining', 'catering', 'bar and grill']],
    ['cafe', ['coffee', 'cafe', 'bakery', 'espresso']],
    ['musician', ['music', 'artist', 'band', 'album', 'soundcloud', 'tour']],
    ['photographer', ['photography', 'photographer', 'portraits', 'wedding photos']],
    ['ecommerce', ['shop', 'products', 'printify', 'merch', 'store']],
  ];
  for (const [industry, needles] of checks) if (needles.some((n) => words.includes(n))) return industry;
  return 'default';
}

function inferToneTags(profile, crawl, requested) {
  const raw = [profile.brand_voice, profile.tone, profile.visual_style, crawl.visual_style, requested]
    .flat().filter(Boolean).map((x) => typeof x === 'string' ? x : x.value || '').join(' ').toLowerCase();
  const tags = [];
  for (const key of Object.keys(TONE_TO_STYLE)) if (raw.includes(key)) tags.push(key);
  if (raw.includes('luxury') || raw.includes('elegant')) tags.push('premium');
  if (raw.includes('local') || raw.includes('community')) tags.push('friendly');
  return [...new Set(tags.length ? tags : ['modern', 'friendly'])].slice(0, 4);
}

function buildDesignTokens({ profile, crawl, preset, toneTags }) {
  const style = toneTags.map((t) => TONE_TO_STYLE[t]).find(Boolean) || TONE_TO_STYLE.modern;
  const palette = extractPalette(profile, crawl);
  return {
    palette,
    typography: style.typography,
    density: style.density,
    radius: style.radius,
    contrast: style.contrast,
    motion: style.motion,
    layout: {
      max_width: '1180px',
      mobile_first: true,
      section_spacing: style.density === 'spacious' ? 'clamp(4rem, 8vw, 7rem)' : 'clamp(3rem, 6vw, 5rem)',
      card_grid: 'repeat(auto-fit, minmax(240px, 1fr))',
    },
    conversion_priority: preset.conversionPriority,
  };
}

function extractPalette(profile, crawl) {
  const candidates = [profile.colors, profile.brand_colors, crawl.palette, crawl.colors].flat(3).filter(Boolean);
  const hexes = candidates.map((c) => typeof c === 'string' ? c : c.hex || c.value).filter((x) => /^#?[0-9a-f]{3,6}$/i.test(String(x || '')));
  const normalized = [...new Set(hexes.map((h) => normalizeHex(h)))].slice(0, 5);
  return {
    background: normalized[0] || '#F8F5EF',
    foreground: normalized[1] || '#161616',
    accent: normalized[2] || '#D76D3C',
    muted: normalized[3] || '#E9E2D7',
    surface: '#FFFFFF',
  };
}

function buildPageBlueprint({ profile, preset, industry }) {
  const businessName = profile.business_name || profile.name || 'the business';
  const primary = preset.conversionPriority[0] || 'contact';
  return {
    business_name: businessName,
    hero: {
      headline: profile.headline || headlineFor(industry, businessName),
      subheadline: profile.description || subheadlineFor(industry),
      primary_cta: ctaFor(primary),
      secondary_cta: 'View services',
      must_show: ['business name', 'primary service', 'location/service area', 'primary CTA'],
    },
    sections: preset.sections.map((name) => sectionFromName(name, profile)),
    mobile_rules: [
      'Phone/contact CTA remains reachable within one thumb scroll.',
      'Hero should not depend on desktop-only imagery.',
      'Cards collapse to single column with visible CTA text.',
    ],
  };
}

function sectionFromName(name, profile) {
  if (name.includes('service')) return { key: name, type: 'services', purpose: 'Help visitors self-identify the right offer.', items: profile.services || [] };
  if (name.includes('proof') || name.includes('trust') || name.includes('testimonial')) return { key: name, type: 'proof', purpose: 'Reduce risk before asking for action.', items: profile.proof_points || profile.testimonials || [] };
  if (name.includes('menu') || name.includes('product') || name.includes('release')) return { key: name, type: 'catalog', purpose: 'Expose the tangible offer quickly.', items: profile.products || profile.menu_items || [] };
  if (name.includes('hours') || name.includes('location')) return { key: name, type: 'local_info', purpose: 'Make visit/contact logistics obvious.', items: [profile.address, profile.hours].filter(Boolean) };
  if (name.includes('cta')) return { key: name, type: 'conversion', purpose: 'Close with one clear next action.', items: [] };
  return { key: name, type: 'content', purpose: 'Support the page story.', items: [] };
}

function buildQualityRules({ preset, industry }) {
  return {
    above_the_fold: [
      'Visitor can identify what the business does, who it serves, and what to do next within five seconds.',
      'Primary CTA appears visually stronger than secondary CTA.',
      'Business-specific proof appears before long brand storytelling.',
    ],
    responsive: [
      'No section relies on hover to reveal essential information.',
      'Text blocks stay under comfortable mobile line lengths.',
      'Images use fixed aspect-ratio containers to prevent layout jumps.',
    ],
    brand_specificity: [
      `Use ${industry} proof patterns instead of generic template claims.`,
      ...preset.avoid.map((x) => `Avoid: ${x}.`),
    ],
    cost_safety: [
      'Generate structure, tokens, and QA in code before calling Anthropic.',
      'Use Haiku for missing-field extraction; reserve Sonnet for final high-value page synthesis.',
      'Reuse approved section blueprints across revisions unless the client requests a structural change.',
    ],
  };
}

function buildCompactLlmDesignPack({ profile, requested, industry, preset, toneTags, tokens, blueprint, qualityRules }) {
  return {
    task: 'website_design_synthesis',
    instruction: 'Use this compact design pack. Do not ask for facts already present. Do not invent proof. Return only the requested artifact.',
    business: {
      name: profile.business_name || profile.name || null,
      industry,
      services: (profile.services || []).slice(0, 8),
      location: profile.location || profile.service_area || null,
      requested,
    },
    design_direction: {
      archetype: preset.archetype,
      tone: toneTags,
      tokens,
      conversion_priority: preset.conversionPriority,
      visual_bias: preset.visualBias,
    },
    blueprint,
    quality_rules: qualityRules,
  };
}

function estimateDesignCostPlan({ requested, blueprint, llmPack }) {
  const structuralOnly = /layout|wireframe|template|preview|section/i.test(requested || '') && !/write|copy|full|polish/i.test(requested || '');
  const compactChars = JSON.stringify(llmPack).length;
  const estimatedPromptTokens = Math.ceil(compactChars / 4);
  return {
    deterministic_first: true,
    can_render_preview_without_llm: true,
    suggested_model: structuralOnly ? null : 'claude-3-5-haiku-latest',
    escalate_to_sonnet_when: ['full homepage copy', 'novel visual concept', 'multi-page information architecture', 'client rejects deterministic draft'],
    estimated_prompt_tokens: estimatedPromptTokens,
    sections_reused_without_model: (blueprint.sections || []).length,
  };
}

function headlineFor(industry, businessName) {
  const map = {
    hvac: `Fast, dependable comfort service from ${businessName}`,
    roofing: `Roofing help that protects your home before the next storm`,
    contractor: `Clear, reliable project work from ${businessName}`,
    restaurant: `A local place worth craving, visiting, and sharing`,
    cafe: `Your next favorite stop for coffee, comfort, and community`,
    musician: `Music, shows, and the story behind the sound`,
    photographer: `Images with feeling, clarity, and a simple booking path`,
    ecommerce: `Products people can understand, trust, and buy quickly`,
  };
  return map[industry] || `${businessName} makes the next step clear`;
}

function subheadlineFor(industry) {
  const map = {
    hvac: 'Show emergency support, core services, trust signals, and the fastest way to call or request service.',
    roofing: 'Lead with inspections, storm repair, proof, service area, and clear quote requests.',
    contractor: 'Explain the work, show the proof, and make it easy to request a quote.',
    restaurant: 'Put menu, hours, location, and appetite-driving visuals where customers expect them.',
    musician: 'Make listening, watching, following, and booking feel immediate.',
  };
  return map[industry] || 'A responsive, conversion-aware site structure tailored to the business instead of a generic template.';
}

function ctaFor(priority) {
  if (/call/.test(priority)) return 'Call now';
  if (/quote|inspection/.test(priority)) return 'Request a quote';
  if (/direction|visit/.test(priority)) return 'Get directions';
  if (/listen/.test(priority)) return 'Listen now';
  if (/shop/.test(priority)) return 'Shop now';
  return 'Contact us';
}

function buildCss(tokens) {
  const p = tokens.palette || {};
  return `:root{--bg:${p.background};--fg:${p.foreground};--accent:${p.accent};--muted:${p.muted};--surface:${p.surface};--max:${tokens.layout?.max_width || '1180px'};font-family:Inter,ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,var(--bg),#fff);color:var(--fg)}a{color:inherit}.site-shell{width:min(var(--max),calc(100% - 32px));margin:auto}.nav{display:flex;justify-content:space-between;align-items:center;padding:22px 0}.nav a,.btn{border:1px solid color-mix(in srgb,var(--fg),transparent 82%);padding:.8rem 1rem;border-radius:999px;text-decoration:none}.hero{display:grid;grid-template-columns:1.15fr .85fr;gap:clamp(1.5rem,4vw,4rem);align-items:center;min-height:72vh}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:.72rem;color:color-mix(in srgb,var(--fg),transparent 38%)}h1{font-size:clamp(2.8rem,8vw,6.8rem);line-height:.92;margin:.5rem 0 1rem;letter-spacing:-.07em}h2{font-size:clamp(2rem,5vw,4rem);line-height:.96;letter-spacing:-.05em}p{font-size:clamp(1rem,2vw,1.2rem);line-height:1.65;color:color-mix(in srgb,var(--fg),transparent 24%)}.actions{display:flex;gap:.8rem;flex-wrap:wrap;margin-top:1.5rem}.primary{background:var(--fg);color:var(--bg)}.secondary{background:color-mix(in srgb,var(--surface),transparent 20%)}.hero-card,.card,.cta{background:color-mix(in srgb,var(--surface),transparent 8%);border:1px solid color-mix(in srgb,var(--fg),transparent 88%);border-radius:28px;padding:clamp(1.2rem,3vw,2rem);box-shadow:0 24px 80px color-mix(in srgb,var(--fg),transparent 92%)}.hero-card strong{display:block;font-size:clamp(1.8rem,4vw,3.2rem);line-height:1;margin:.7rem 0}.trust-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.75rem;margin:1rem 0 5rem}.trust-strip div{background:var(--muted);border-radius:999px;padding:.8rem 1rem;text-align:center}.section{padding:clamp(4rem,8vw,7rem) 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem}.card h3{margin-top:0}.cta{text-align:center;margin:4rem 0 6rem}@media(max-width:760px){.hero{grid-template-columns:1fr;min-height:auto;padding:4rem 0}.nav{position:sticky;top:0;background:color-mix(in srgb,var(--bg),transparent 10%);backdrop-filter:blur(14px);z-index:2}h1{font-size:clamp(2.5rem,17vw,4.3rem)}}`;
}

function normalizeHex(value) {
  let h = String(value || '').trim();
  if (!h.startsWith('#')) h = `#${h}`;
  if (h.length === 4) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  return h.toUpperCase();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

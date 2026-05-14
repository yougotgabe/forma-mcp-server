// =============================================================================
// FORMAUT — HOMEPAGE ARTIFACT GENERATOR
// =============================================================================
// Takes a business profile + design brief and returns a complete homepage HTML
// string ready to commit to GitHub. Uses the AI gateway for copy generation,
// but all structure/layout decisions are deterministic (no AI for that).
//
// The flow:
//   1. Build design brief from profile (deterministic)
//   2. Generate section copy via Anthropic (one targeted call)
//   3. Compose final HTML from section templates + copy
//   4. Return { html, sections_used, copy, metadata }
// =============================================================================

import { buildDesignBrief } from './design-brief-builder.js';
import { composeSectionHtml, SECTION_TEMPLATES } from './section-composer.js';

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 2000;

/**
 * Generate a complete homepage HTML artifact.
 *
 * @param {object} profile   - Business profile from business_profiles table
 * @param {object} env       - Cloudflare Worker env (needs ANTHROPIC_API_KEY)
 * @param {object} options
 * @param {string} [options.existing_html]  - Current live HTML if regenerating
 * @param {string} [options.trigger]        - What caused regeneration
 * @returns {Promise<{html: string, sections: string[], copy: object, brief: object}>}
 */
export async function generateHomepage(profile, env, options = {}) {
  const brief = buildDesignBrief(profile);
  const copy = await generateSectionCopy(profile, brief, env);
  const html = composeSectionHtml(brief.sections, copy, brief, profile);
  return {
    html,
    sections: brief.sections,
    copy,
    brief,
    generation_model: MODEL,
    generated_at: new Date().toISOString(),
  };
}

// ── Copy generation ───────────────────────────────────────────────────────────

async function generateSectionCopy(profile, brief, env) {
  const prompt = buildCopyPrompt(profile, brief);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.status);
    throw new Error(`Copy generation API call failed: ${err}`);
  }

  const data = await res.json();
  const rawText = data.content?.[0]?.text || '';
  return parseCopyJson(rawText, profile, brief);
}

function buildCopyPrompt(profile, brief) {
  const businessName = profile.business_name || 'the business';
  const industry = profile.industry || 'local business';
  const services = formatServices(profile.primary_services || profile.services);
  const location = profile.location || profile.service_area || '';
  const tone = profile.brand_tone || brief.tone || 'professional and approachable';
  const differentiators = formatList(profile.key_differentiators || []);
  const phone = profile.phone || (profile.contact_methods?.phone) || '';
  const email = profile.email || (profile.contact_methods?.email) || '';

  return `You are writing website copy for a ${industry} called "${businessName}".

Business details:
- Services: ${services}
- Location: ${location}
- Brand tone: ${tone}
- Key differentiators: ${differentiators || 'quality, reliability, local expertise'}
- Primary CTA: ${brief.primary_cta}
- Contact: ${phone} ${email}

Write copy for these website sections: ${brief.sections.join(', ')}.

Respond ONLY with a JSON object. No preamble, no markdown fences. The object must have:
{
  "hero": {
    "headline": "compelling 4-8 word headline",
    "subheadline": "1-2 sentences. specific, not generic",
    "cta_primary": "button text",
    "cta_secondary": "optional second button text or null"
  },
  "services": {
    "section_title": "section heading",
    "items": [
      { "title": "service name", "description": "1-2 sentence description" }
    ]
  },
  "about": {
    "headline": "short about headline",
    "body": "2-3 sentences. conversational, specific to this business"
  },
  "contact": {
    "headline": "call to action heading",
    "subtext": "1 sentence encouraging contact",
    "cta": "button text"
  },
  "trust": {
    "claims": ["specific trust claim 1", "specific trust claim 2", "specific trust claim 3"]
  }
}

Rules:
- Write for ${businessName} specifically — no generic placeholder copy
- Match the ${tone} tone throughout
- "trust.claims" should be factual, not fluffy (years in business, licensed, local, etc.)
- Services items should reflect actual services if known, otherwise infer from industry
- Keep all text concise — this is a website, not a brochure`;
}

function parseCopyJson(rawText, profile, brief) {
  try {
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/im, '')
      .replace(/\s*```\s*$/im, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    // Fallback copy if parsing fails — always returns something usable
    return buildFallbackCopy(profile, brief);
  }
}

function buildFallbackCopy(profile, brief) {
  const name = profile.business_name || 'Us';
  const services = formatServices(profile.primary_services || profile.services);
  const industry = profile.industry || 'business';
  const location = profile.location || profile.service_area || 'your area';

  return {
    hero: {
      headline: `${name} — ${brief.primary_cta}`,
      subheadline: `Serving ${location}. ${services ? `Specializing in ${services}.` : `Quality ${industry} services.`}`,
      cta_primary: brief.primary_cta,
      cta_secondary: 'Learn more',
    },
    services: {
      section_title: 'What We Do',
      items: (profile.primary_services || [profile.industry || 'Our Services']).slice(0, 4).map((s) => ({
        title: s,
        description: `Professional ${s.toLowerCase()} services tailored to your needs.`,
      })),
    },
    about: {
      headline: `About ${name}`,
      body: `We're a ${industry} serving ${location}. We're committed to quality work and satisfied customers.`,
    },
    contact: {
      headline: 'Get In Touch',
      subtext: "We'd love to hear from you. Reach out today.",
      cta: 'Contact Us',
    },
    trust: {
      claims: ['Local business', 'Quality guaranteed', 'Serving the community'],
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatServices(services) {
  if (!services) return '';
  if (typeof services === 'string') return services;
  if (Array.isArray(services)) return services.slice(0, 5).join(', ');
  return '';
}

function formatList(items) {
  if (!items) return '';
  if (typeof items === 'string') return items;
  if (Array.isArray(items)) return items.join(', ');
  return '';
}

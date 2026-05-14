// =============================================================================
// FORMAUT — SEO ARTIFACT GENERATOR
// =============================================================================
// Generates SEO metadata: title tag, meta description, Open Graph tags,
// Twitter Card tags, and JSON-LD structured data.
//
// Deterministic for LocalBusiness schema. One small AI call for title/description
// if not already in the profile.
// =============================================================================

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 400;

/**
 * Generate SEO artifact content from a business profile.
 *
 * @param {object} profile - Business profile row
 * @param {object} env     - Worker env (needs ANTHROPIC_API_KEY)
 * @param {object} options
 * @returns {Promise<{title, description, og, jsonld, html_snippet}>}
 */
export async function generateSeoArtifact(profile, env, options = {}) {
  const liveUrl = profile.live_url || profile.website_url || '';
  const name = profile.business_name || 'Business';
  const location = profile.location || profile.service_area || '';
  const services = formatServices(profile.primary_services || profile.services);
  const phone = profile.phone || profile.contact_methods?.phone || '';
  const email = profile.email || profile.contact_methods?.email || '';

  // Generate title + description via AI if not already defined
  const { title, description } = await generateTitleAndDescription(profile, env, options);

  // Open Graph
  const og = {
    title,
    description,
    type: 'website',
    url: liveUrl,
    site_name: name,
    image: profile.logo_url || null,
    locale: 'en_US',
  };

  // Twitter Card
  const twitter = {
    card: 'summary',
    title,
    description,
    image: profile.logo_url || null,
  };

  // JSON-LD — LocalBusiness structured data
  const jsonld = buildLocalBusinessSchema(profile, { title, description, liveUrl, phone, email, location });

  // Composited HTML snippet (what goes in <head>)
  const html_snippet = composeHeadSnippet({ title, description, og, twitter, jsonld, liveUrl });

  return {
    title,
    description,
    og,
    twitter,
    jsonld,
    html_snippet,
    live_url: liveUrl,
    generated_at: new Date().toISOString(),
    generation_model: MODEL,
  };
}

// ── Title + description generation ───────────────────────────────────────────

async function generateTitleAndDescription(profile, env, options = {}) {
  // If already confirmed in profile, use it
  if (options.title && options.description) {
    return { title: options.title, description: options.description };
  }

  const name = profile.business_name || 'Business';
  const industry = profile.industry || 'local business';
  const location = profile.location || profile.service_area || '';
  const services = formatServices(profile.primary_services || profile.services);

  const prompt = `Write an SEO title tag and meta description for a ${industry} called "${name}".
${location ? `Location: ${location}` : ''}
${services ? `Services: ${services}` : ''}

Rules:
- Title: 50-60 characters, include business name and top service or location
- Description: 140-160 characters, benefit-driven, include a soft CTA
- Do not invent facts not in the provided info
- No quotes around the strings

Respond ONLY with JSON, no preamble:
{
  "title": "...",
  "description": "..."
}`;

  try {
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

    if (!res.ok) throw new Error(`SEO API call failed: ${res.status}`);
    const data = await res.json();
    const raw = data.content?.[0]?.text || '';
    const cleaned = raw.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/im, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      title: truncate(parsed.title || buildFallbackTitle(name, location), 60),
      description: truncate(parsed.description || buildFallbackDescription(name, services, location), 160),
    };
  } catch {
    return {
      title: buildFallbackTitle(name, location),
      description: buildFallbackDescription(name, services, location),
    };
  }
}

function buildFallbackTitle(name, location) {
  if (location) return truncate(`${name} — ${location}`, 60);
  return truncate(name, 60);
}

function buildFallbackDescription(name, services, location) {
  const parts = [name];
  if (services) parts.push(`specializing in ${services}`);
  if (location) parts.push(`serving ${location}`);
  parts.push('Contact us today.');
  return truncate(parts.join('. '), 160);
}

// ── JSON-LD ───────────────────────────────────────────────────────────────────

const INDUSTRY_SCHEMA_TYPE = {
  restaurant: 'Restaurant',
  cafe: 'CafeOrCoffeeShop',
  bakery: 'Bakery',
  bar: 'BarOrPub',
  hotel: 'LodgingBusiness',
  salon: 'HairSalon',
  spa: 'DaySpa',
  dental: 'Dentist',
  medical: 'MedicalBusiness',
  law: 'LegalService',
  pharmacy: 'Pharmacy',
  gym: 'ExerciseGym',
  default: 'LocalBusiness',
};

function buildLocalBusinessSchema(profile, { title, description, liveUrl, phone, email, location }) {
  const name = profile.business_name || 'Business';
  const industry = (profile.industry || 'default').toLowerCase();
  const schemaType = INDUSTRY_SCHEMA_TYPE[industry] || INDUSTRY_SCHEMA_TYPE.default;

  const schema = {
    '@context': 'https://schema.org',
    '@type': schemaType,
    name,
    description,
    url: liveUrl || undefined,
  };

  if (phone) schema.telephone = phone;
  if (email) schema.email = email;

  // Address
  if (location) {
    schema.address = {
      '@type': 'PostalAddress',
      addressLocality: location,
    };
  }

  // Hours if available
  if (profile.hours && typeof profile.hours === 'object') {
    const dayMap = {
      monday: 'Mo', tuesday: 'Tu', wednesday: 'We', thursday: 'Th',
      friday: 'Fr', saturday: 'Sa', sunday: 'Su',
    };
    const opens = Object.entries(profile.hours).map(([day, time]) => {
      const d = dayMap[day.toLowerCase()] || day.slice(0, 2);
      const t = String(time);
      const match = t.match(/(\d{1,2}(?::\d{2})?(?:am|pm)?)\s*[-–]\s*(\d{1,2}(?::\d{2})?(?:am|pm)?)/i);
      if (!match) return null;
      return { '@type': 'OpeningHoursSpecification', dayOfWeek: `https://schema.org/${day}`, opens: match[1], closes: match[2] };
    }).filter(Boolean);
    if (opens.length) schema.openingHoursSpecification = opens;
  }

  // Logo
  if (profile.logo_url) {
    schema.logo = { '@type': 'ImageObject', url: profile.logo_url };
  }

  // Social links as sameAs
  const social = profile.social_links || {};
  const sameAs = Object.values(social).filter(Boolean);
  if (sameAs.length) schema.sameAs = sameAs;

  return schema;
}

// ── HTML snippet composer ─────────────────────────────────────────────────────

function composeHeadSnippet({ title, description, og, twitter, jsonld, liveUrl }) {
  const lines = [
    `  <title>${escapeHtml(title)}</title>`,
    `  <meta name="description" content="${escapeHtml(description)}">`,
    liveUrl ? `  <link rel="canonical" href="${escapeHtml(liveUrl)}">` : null,
    '',
    '  <!-- Open Graph -->',
    `  <meta property="og:title" content="${escapeHtml(og.title)}">`,
    `  <meta property="og:description" content="${escapeHtml(og.description)}">`,
    `  <meta property="og:type" content="${og.type}">`,
    og.url ? `  <meta property="og:url" content="${escapeHtml(og.url)}">` : null,
    og.site_name ? `  <meta property="og:site_name" content="${escapeHtml(og.site_name)}">` : null,
    og.image ? `  <meta property="og:image" content="${escapeHtml(og.image)}">` : null,
    '',
    '  <!-- Twitter Card -->',
    `  <meta name="twitter:card" content="${twitter.card}">`,
    `  <meta name="twitter:title" content="${escapeHtml(twitter.title)}">`,
    `  <meta name="twitter:description" content="${escapeHtml(twitter.description)}">`,
    twitter.image ? `  <meta name="twitter:image" content="${escapeHtml(twitter.image)}">` : null,
    '',
    '  <!-- Structured Data -->',
    `  <script type="application/ld+json">\n  ${JSON.stringify(jsonld, null, 2).replace(/\n/g, '\n  ')}\n  </script>`,
  ];

  return lines.filter((l) => l !== null).join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatServices(services) {
  if (!services) return '';
  if (typeof services === 'string') return services;
  if (Array.isArray(services)) return services.slice(0, 4).join(', ');
  return '';
}

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

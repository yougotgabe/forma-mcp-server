// functions/api/preview.js
// Cloudflare Pages Function — preview generation
//
// Architecture: AI → decisions → design system → HTML
// One Haiku call extracts business data + aesthetic code
// Design system mapping handles all visual decisions deterministically
// AI compensates when input is weak — never degrades to template feel

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return response({ error: 'Method not allowed' }, 405);
  }

  const origin = request.headers.get('Origin') || '';
  const allowed = ['https://formaut.com', 'https://www.formaut.com'];
  if (!allowed.includes(origin) && !origin.includes('pages.dev')) {
    return response({ error: 'Forbidden' }, 403);
  }

  let body;
  try { body = await request.json(); }
  catch { return response({ error: 'Invalid JSON' }, 400); }

  const { description, business_name } = body;
  if (!description || description.trim().length < 10) {
    return response({ error: 'Tell us a bit more — a sentence is enough.' }, 400);
  }
  if (description.length > 600) {
    return response({ error: 'Keep your description under 600 characters.' }, 400);
  }

  // ── Single Haiku call: extract + decide ───────────────────────────────────
  // One call does everything: classify, name-infer, tone-pick, content-write
  // Business name from follow-up (business_name param) takes priority
  let data;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: `You extract business information and make design decisions. Return ONLY valid JSON.
No preamble. No markdown. No explanation. Just the JSON object.

Return exactly this structure:
{
  "name": "Business name — infer creatively if not given, never leave as generic placeholder",
  "tagline": "One punchy line — specific to THIS business, not generic",
  "location": "City, State or empty string",
  "phone": "Phone number or empty string",
  "services": ["service 1", "service 2", "service 3"],
  "custom_detail": "One authored line that makes this feel real and specific",
  "aesthetic": "dark_craft | warm_heritage | clean_professional | bold_creative | fresh_retail",
  "cta": "Action-oriented button text specific to this business type",
  "contact_line": "Warm specific invitation to contact"
}

Aesthetic selection rules:
- dark_craft: barbershop, tattoo, brewery, auto, trades, mechanic, woodwork
- warm_heritage: restaurant, cafe, bakery, diner, catering, food truck
- clean_professional: cleaning, landscaping, plumbing, HVAC, legal, accounting, real estate, medical
- bold_creative: band, musician, DJ, photographer, videographer, artist, designer
- fresh_retail: boutique, shop, salon, spa, nail, pet grooming, yoga, fitness

Name inference rules (if no name given):
- Use location + type: "Nashville Cuts", "Austin Clean Co", "Denver Ink Studio"
- Or craft + type: "Precision Barbershop", "Heritage Cafe", "Clean Slate Services"
- Never use: "Your Business", "My Business", "[Business Name]", generic placeholders

Custom detail rules — pick one that fits:
- Barbershop: "Walk-ins welcome · Appointments recommended"
- Restaurant: "Made from scratch · Served with care"
- Cleaning: "Insured & bonded · Satisfaction guaranteed"
- Band/music: "Available for shows, events & studio sessions"
- Salon/spa: "By appointment · Walk-ins when available"
- Retail: "In-store & online · Free local delivery"
- Trades: "Licensed & insured · Free estimates"
- Default: Make something specific to their location and type

CTA rules:
- Barbershop/salon: "Book Your Appointment"
- Restaurant: "See Our Menu"
- Service business: "Get a Free Quote"
- Band/creative: "Book Us Now" or "Listen Now"
- Retail: "Shop Now"
- General: "Get in Touch"`,
        messages: [{
          role: 'user',
          content: business_name
            ? `Business name: ${business_name}\n\nDescription: ${description}`
            : description,
        }],
      }),
    });

    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const apiData = await res.json();
    const raw = apiData.content?.[0]?.text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    data = JSON.parse(clean);

    // If business_name was passed as follow-up, always use it
    if (business_name) data.name = business_name;

  } catch (err) {
    console.error('Extraction failed:', err);
    return response({ error: 'Could not process your description. Please try again.' }, 422);
  }

  // ── Design system mapping ─────────────────────────────────────────────────
  const html = buildWithDesignSystem(data);
  return response({ html, aesthetic: data.aesthetic, name: data.name });
}


// =============================================================================
// DESIGN SYSTEMS
// Five completely distinct visual languages — nothing shared with Formaut brand
// =============================================================================

const DESIGN_SYSTEMS = {

  // Dark, masculine, craft — barbershop, tattoo, trades, brewery
  dark_craft: {
    bg:          '#1a1410',
    bg2:         '#231c15',
    bg3:         '#2d2218',
    surface:     '#2d2218',
    text:        '#f0e6d3',
    muted:       '#9a8a78',
    accent:      '#c8922a',
    accent2:     '#8b6420',
    border:      '#3d3025',
    divider:     '#c8922a',
    fontDisplay: 'Playfair Display',
    fontBody:    'DM Sans',
    heroSize:    'clamp(2.5rem, 7vw, 5rem)',
    dividerStyle: 'solid 3px',
    spacing:     'generous',
    badge:       true,
  },

  // Warm, inviting, heritage — restaurant, cafe, bakery, diner
  warm_heritage: {
    bg:          '#faf6f0',
    bg2:         '#f5ede0',
    bg3:         '#fff8f0',
    surface:     '#ffffff',
    text:        '#2c1f0e',
    muted:       '#7a6248',
    accent:      '#b8420a',
    accent2:     '#8b3008',
    border:      '#e8d5bc',
    divider:     '#b8420a',
    fontDisplay: 'Playfair Display',
    fontBody:    'DM Sans',
    heroSize:    'clamp(2.5rem, 6vw, 4.5rem)',
    dividerStyle: 'solid 2px',
    spacing:     'comfortable',
    badge:       true,
  },

  // Clean, trustworthy, professional — cleaning, trades, medical, legal
  clean_professional: {
    bg:          '#f8f9fb',
    bg2:         '#ffffff',
    bg3:         '#eef1f5',
    surface:     '#ffffff',
    text:        '#1a2332',
    muted:       '#5a6a7a',
    accent:      '#1d5fa8',
    accent2:     '#154080',
    border:      '#dde3ea',
    divider:     '#1d5fa8',
    fontDisplay: 'Playfair Display',
    fontBody:    'DM Sans',
    heroSize:    'clamp(2rem, 5vw, 4rem)',
    dividerStyle: 'solid 2px',
    spacing:     'tight',
    badge:       false,
  },

  // Bold, dark, expressive — band, music, photography, creative
  bold_creative: {
    bg:          '#0a0a0f',
    bg2:         '#12121a',
    bg3:         '#1a1a24',
    surface:     '#12121a',
    text:        '#f0f0ff',
    muted:       '#8080a0',
    accent:      '#7c3aed',
    accent2:     '#5b21b6',
    border:      '#2a2a40',
    divider:     '#7c3aed',
    fontDisplay: 'Playfair Display',
    fontBody:    'DM Sans',
    heroSize:    'clamp(3rem, 8vw, 6rem)',
    dividerStyle: 'solid 2px',
    spacing:     'dramatic',
    badge:       false,
  },

  // Fresh, light, approachable — salon, spa, retail, yoga, boutique
  fresh_retail: {
    bg:          '#fdfaf7',
    bg2:         '#f5f0ea',
    bg3:         '#ffffff',
    surface:     '#ffffff',
    text:        '#2a1f1a',
    muted:       '#8a7570',
    accent:      '#d4856a',
    accent2:     '#b06048',
    border:      '#e8ddd5',
    divider:     '#d4856a',
    fontDisplay: 'Playfair Display',
    fontBody:    'DM Sans',
    heroSize:    'clamp(2.5rem, 6vw, 4.5rem)',
    dividerStyle: 'solid 2px',
    spacing:     'airy',
    badge:       false,
  },
};

function buildWithDesignSystem(data) {
  const aesthetic = data.aesthetic || 'clean_professional';
  const ds = DESIGN_SYSTEMS[aesthetic] || DESIGN_SYSTEMS.clean_professional;

  const name        = data.name         || 'Your Business';
  const tagline     = data.tagline      || 'Serving our community with pride';
  const location    = data.location     || '';
  const phone       = data.phone        || '';
  const services    = (data.services    || []).filter(Boolean).slice(0, 3);
  const customDetail = data.custom_detail || '';
  const cta         = data.cta          || 'Get in Touch';
  const contactLine = data.contact_line || 'Ready to get started?';

  // Service cards
  const serviceCards = services.length
    ? services.map(s => `
        <div class="service-card">
          <div class="service-name">${escHtml(s)}</div>
        </div>`).join('')
    : '';

  // Badge element (for craft/heritage aesthetics)
  const badgeHtml = ds.badge && location ? `
    <div class="hero-badge">
      <div class="badge-inner">
        <div class="badge-name">${escHtml(name)}</div>
        ${location ? `<div class="badge-location">${escHtml(location)}</div>` : ''}
      </div>
    </div>` : '';

  // Location line
  const locationHtml = location && !ds.badge
    ? `<div class="hero-location">${escHtml(location)}</div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(name)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: ${ds.bg};
      color: ${ds.text};
      font-family: 'DM Sans', system-ui, sans-serif;
      font-weight: 300;
      line-height: 1.6;
    }

    /* Nav */
    nav {
      background: ${ds.bg};
      border-bottom: 1px solid ${ds.border};
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .nav-name {
      font-family: 'Playfair Display', serif;
      font-size: 1.2rem;
      font-weight: 700;
      color: ${ds.text};
      letter-spacing: -0.01em;
    }
    .nav-phone {
      font-size: 0.875rem;
      color: ${ds.muted};
      font-weight: 400;
    }

    /* Hero */
    .hero {
      background: ${ds.bg};
      padding: ${aesthetic === 'bold_creative' ? '6rem 2rem 5rem' : '4rem 2rem 3.5rem'};
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    ${aesthetic === 'dark_craft' ? `
    .hero::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 4px;
      background: ${ds.accent};
    }` : ''}
    ${aesthetic === 'bold_creative' ? `
    .hero::before {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(124,58,237,0.15) 0%, transparent 70%);
      pointer-events: none;
    }` : ''}

    .hero-location {
      font-size: 0.7rem;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: ${ds.accent};
      margin-bottom: 1.25rem;
    }

    /* Badge for craft/heritage */
    .hero-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 120px;
      height: 120px;
      border-radius: 50%;
      border: 3px solid ${ds.accent};
      background: ${ds.bg2};
      margin-bottom: 1.5rem;
      position: relative;
    }
    .hero-badge::before {
      content: '';
      position: absolute;
      inset: 5px;
      border-radius: 50%;
      border: 1px solid ${ds.accent};
      opacity: 0.4;
    }
    .badge-inner { text-align: center; padding: 0 0.5rem; }
    .badge-name {
      font-family: 'Playfair Display', serif;
      font-size: 0.9rem;
      font-weight: 700;
      color: ${ds.accent};
      line-height: 1.2;
    }
    .badge-location {
      font-size: 0.6rem;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: ${ds.muted};
      margin-top: 0.25rem;
    }

    .hero-headline {
      font-family: 'Playfair Display', serif;
      font-size: ${ds.heroSize};
      font-weight: 900;
      line-height: 1.05;
      letter-spacing: -0.02em;
      color: ${ds.text};
      max-width: 700px;
      margin: 0 auto 1rem;
    }
    ${aesthetic === 'bold_creative' ? `
    .hero-headline { font-style: italic; }` : ''}

    .hero-tagline {
      font-size: 1rem;
      color: ${ds.muted};
      max-width: 480px;
      margin: 0 auto 0.75rem;
      line-height: 1.6;
    }
    .hero-custom-detail {
      font-size: 0.8rem;
      color: ${ds.accent};
      letter-spacing: 0.05em;
      margin-bottom: 2rem;
    }
    .hero-cta {
      display: inline-block;
      background: ${ds.accent};
      color: #fff;
      padding: 0.9rem 2.25rem;
      font-size: 0.95rem;
      font-weight: 500;
      font-family: 'DM Sans', sans-serif;
      text-decoration: none;
      transition: background 0.2s;
      ${aesthetic === 'dark_craft' ? 'letter-spacing: 0.05em; text-transform: uppercase; font-size: 0.8rem;' : ''}
    }
    .hero-phone {
      display: block;
      margin-top: 1rem;
      font-size: 1.1rem;
      font-weight: 500;
      color: ${ds.text};
    }

    /* Divider */
    .section-divider {
      height: 1px;
      background: ${ds.border};
      margin: 0;
    }
    ${aesthetic === 'dark_craft' || aesthetic === 'warm_heritage' ? `
    .section-divider-accent {
      height: 3px;
      background: ${ds.accent};
      opacity: 0.3;
      margin: 0;
    }` : ''}

    /* Services */
    .services {
      background: ${ds.bg2};
      padding: 3rem 2rem;
    }
    .services-label {
      font-size: 0.65rem;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: ${ds.accent};
      text-align: center;
      margin-bottom: 2rem;
    }
    .services-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1px;
      background: ${ds.border};
      border: 1px solid ${ds.border};
      max-width: 860px;
      margin: 0 auto;
    }
    .service-card {
      background: ${ds.bg2};
      padding: 1.75rem 1.5rem;
      text-align: ${aesthetic === 'bold_creative' ? 'center' : 'left'};
    }
    .service-name {
      font-family: 'Playfair Display', serif;
      font-size: 1rem;
      font-weight: 700;
      color: ${ds.text};
      line-height: 1.3;
    }

    /* Contact */
    .contact {
      background: ${aesthetic === 'dark_craft' ? ds.bg3 : aesthetic === 'bold_creative' ? ds.bg2 : ds.bg3};
      padding: 3.5rem 2rem;
      text-align: center;
      ${aesthetic === 'dark_craft' ? `border-top: 3px solid ${ds.accent};` : ''}
    }
    .contact-headline {
      font-family: 'Playfair Display', serif;
      font-size: clamp(1.25rem, 3vw, 1.75rem);
      font-weight: 700;
      color: ${ds.text};
      margin-bottom: 1.25rem;
      ${aesthetic === 'bold_creative' ? 'font-style: italic;' : ''}
    }
    .contact-phone {
      font-size: 1.25rem;
      font-weight: 500;
      color: ${ds.accent};
      margin-bottom: 0.4rem;
    }
    .contact-location {
      font-size: 0.875rem;
      color: ${ds.muted};
    }

    /* Footer */
    footer {
      background: ${ds.bg};
      border-top: 1px solid ${ds.border};
      padding: 1rem 2rem;
      text-align: center;
      font-size: 0.75rem;
      color: ${ds.muted};
    }

    @media (max-width: 600px) {
      .services-grid { grid-template-columns: 1fr; }
      .hero { padding: 3rem 1.5rem 2.5rem; }
    }
  </style>
</head>
<body>

  <nav>
    <div class="nav-name">${escHtml(name)}</div>
    ${phone ? `<div class="nav-phone">${escHtml(phone)}</div>` : ''}
  </nav>

  <section class="hero">
    ${badgeHtml}
    ${locationHtml}
    <h1 class="hero-headline">${escHtml(tagline)}</h1>
    ${customDetail ? `<div class="hero-custom-detail">${escHtml(customDetail)}</div>` : ''}
    <a class="hero-cta" href="#">${escHtml(cta)}</a>
    ${phone ? `<span class="hero-phone">${escHtml(phone)}</span>` : ''}
  </section>

  ${serviceCards ? `
  <div class="section-divider"></div>
  <section class="services">
    <div class="services-label">What we do</div>
    <div class="services-grid">${serviceCards}</div>
  </section>` : ''}

  <div class="section-divider"></div>

  <section class="contact">
    <div class="contact-headline">${escHtml(contactLine)}</div>
    ${phone ? `<div class="contact-phone">${escHtml(phone)}</div>` : ''}
    ${location ? `<div class="contact-location">${escHtml(location)}</div>` : ''}
  </section>

  <footer>${escHtml(name)} · Preview powered by Formaut</footer>

</body>
</html>`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

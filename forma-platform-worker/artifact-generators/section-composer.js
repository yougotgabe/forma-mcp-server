// =============================================================================
// FORMAUT — SECTION COMPOSER
// =============================================================================
// Takes sections[], copy object, design brief, and business profile and
// composes a complete homepage HTML string. All layout is deterministic.
// Copy comes from the homepage-generator's AI call.
//
// Output: valid, standalone HTML — mobile-first, dark-by-default, no framework.
// =============================================================================

/**
 * Compose full homepage HTML from sections + copy + brief.
 *
 * @param {string[]} sections - Ordered section keys
 * @param {object} copy       - Copy object from AI generation
 * @param {object} brief      - Design brief from buildDesignBrief()
 * @param {object} profile    - Business profile
 * @returns {string}          - Complete HTML string
 */
export function composeSectionHtml(sections, copy, brief, profile) {
  const colors = brief.color_strategy;
  const fonts = brief.fonts;
  const name = profile.business_name || 'Business';
  const phone = profile.phone || profile.contact_methods?.phone || '';
  const email = profile.email || profile.contact_methods?.email || '';
  const address = profile.location || '';
  const logo = profile.logo_url || null;
  const social = profile.social_links || {};

  const sectionHtml = sections
    .map((s) => renderSection(s, copy, brief, profile))
    .filter(Boolean)
    .join('\n\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(name)}</title>
  <meta name="description" content="${escapeHtml(copy.hero?.subheadline || '')}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(fonts.heading)}:wght@400;600;700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    /* ── Reset & base ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      background: ${colors.bg};
      color: ${colors.text};
      font-family: 'DM Sans', system-ui, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    /* ── CSS custom properties ── */
    :root {
      --bg: ${colors.bg};
      --text: ${colors.text};
      --accent: ${colors.accent};
      --surface: ${colors.surface};
      --radius: 8px;
      --max-w: 1100px;
      --font-heading: '${fonts.heading}', sans-serif;
      --section-padding: 80px 24px;
    }

    /* ── Layout ── */
    .container { max-width: var(--max-w); margin: 0 auto; padding: 0 24px; }
    section { padding: var(--section-padding); }

    /* ── Typography ── */
    h1, h2, h3 { font-family: var(--font-heading); line-height: 1.2; }
    h1 { font-size: clamp(2rem, 5vw, 3.5rem); font-weight: 700; }
    h2 { font-size: clamp(1.5rem, 3vw, 2.25rem); font-weight: 600; margin-bottom: 16px; }
    h3 { font-size: 1.2rem; font-weight: 600; margin-bottom: 8px; }
    p { font-size: 1rem; color: color-mix(in srgb, ${colors.text} 80%, transparent); }

    /* ── Navigation ── */
    nav {
      position: sticky; top: 0; z-index: 100;
      background: color-mix(in srgb, ${colors.bg} 92%, transparent);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid color-mix(in srgb, ${colors.text} 10%, transparent);
      padding: 16px 24px;
    }
    .nav-inner {
      max-width: var(--max-w); margin: 0 auto;
      display: flex; align-items: center; justify-content: space-between;
    }
    .nav-brand {
      font-family: var(--font-heading);
      font-size: 1.2rem; font-weight: 700;
      color: ${colors.text}; text-decoration: none;
    }
    .nav-links { display: flex; gap: 24px; list-style: none; }
    .nav-links a { color: color-mix(in srgb, ${colors.text} 70%, transparent); text-decoration: none; font-size: 0.9rem; transition: color 0.2s; }
    .nav-links a:hover { color: ${colors.text}; }
    .nav-cta {
      background: ${colors.accent}; color: #fff;
      padding: 8px 20px; border-radius: var(--radius);
      text-decoration: none; font-size: 0.9rem; font-weight: 500;
      transition: opacity 0.2s;
    }
    .nav-cta:hover { opacity: 0.85; }
    @media (max-width: 640px) {
      .nav-links { display: none; }
    }

    /* ── Buttons ── */
    .btn {
      display: inline-block; padding: 14px 28px;
      border-radius: var(--radius); font-size: 1rem; font-weight: 600;
      text-decoration: none; transition: all 0.2s; cursor: pointer; border: none;
    }
    .btn-primary { background: ${colors.accent}; color: #fff; }
    .btn-primary:hover { opacity: 0.85; transform: translateY(-1px); }
    .btn-secondary {
      background: transparent; color: ${colors.text};
      border: 1px solid color-mix(in srgb, ${colors.text} 30%, transparent);
    }
    .btn-secondary:hover { border-color: ${colors.text}; }

    /* ── Cards ── */
    .card {
      background: ${colors.surface};
      border: 1px solid color-mix(in srgb, ${colors.text} 8%, transparent);
      border-radius: calc(var(--radius) * 1.5);
      padding: 28px;
    }

    /* ── Grid ── */
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; }
    .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 24px; }

    /* ── Trust bar ── */
    .trust-bar {
      display: flex; flex-wrap: wrap; gap: 32px; justify-content: center; align-items: center;
      padding: 32px 24px;
      border-top: 1px solid color-mix(in srgb, ${colors.text} 8%, transparent);
      border-bottom: 1px solid color-mix(in srgb, ${colors.text} 8%, transparent);
    }
    .trust-item { display: flex; align-items: center; gap: 10px; font-size: 0.95rem; font-weight: 500; }
    .trust-icon { font-size: 1.3rem; }

    /* ── Emergency bar ── */
    .emergency-bar {
      background: ${colors.accent}; color: #fff;
      text-align: center; padding: 12px 24px;
      font-weight: 600; font-size: 1.05rem;
    }
    .emergency-bar a { color: #fff; text-decoration: none; font-weight: 700; }

    /* ── Hours table ── */
    .hours-table { width: 100%; border-collapse: collapse; }
    .hours-table td { padding: 8px 0; border-bottom: 1px solid color-mix(in srgb, ${colors.text} 8%, transparent); }
    .hours-table td:last-child { text-align: right; font-weight: 500; }

    /* ── Footer ── */
    footer {
      padding: 48px 24px 32px;
      border-top: 1px solid color-mix(in srgb, ${colors.text} 8%, transparent);
      text-align: center;
    }
    footer p { font-size: 0.85rem; color: color-mix(in srgb, ${colors.text} 50%, transparent); }
    .footer-links { display: flex; justify-content: center; gap: 24px; margin: 16px 0; flex-wrap: wrap; }
    .footer-links a { color: color-mix(in srgb, ${colors.text} 60%, transparent); text-decoration: none; font-size: 0.85rem; }
    .footer-links a:hover { color: ${colors.text}; }
  </style>
</head>
<body>

  <!-- Navigation -->
  <nav>
    <div class="nav-inner">
      <a class="nav-brand" href="/">${escapeHtml(logo ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(name)}" height="32" style="vertical-align:middle">` : name)}</a>
      <ul class="nav-links">
        <li><a href="#services">Services</a></li>
        <li><a href="#about">About</a></li>
        <li><a href="#contact">Contact</a></li>
      </ul>
      ${phone ? `<a class="nav-cta" href="tel:${phone.replace(/\D/g, '')}">${escapeHtml(phone)}</a>` : `<a class="nav-cta" href="#contact">${escapeHtml(brief.primary_cta)}</a>`}
    </div>
  </nav>

${sectionHtml}

  <!-- Footer -->
  <footer>
    <div class="container">
      <p style="font-family:var(--font-heading); font-size:1.1rem; font-weight:600; margin-bottom:12px;">${escapeHtml(name)}</p>
      <div class="footer-links">
        ${address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank">${escapeHtml(address)}</a>` : ''}
        ${phone ? `<a href="tel:${phone.replace(/\D/g, '')}">${escapeHtml(phone)}</a>` : ''}
        ${email ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : ''}
        ${social.instagram ? `<a href="${escapeHtml(social.instagram)}" target="_blank">Instagram</a>` : ''}
        ${social.facebook ? `<a href="${escapeHtml(social.facebook)}" target="_blank">Facebook</a>` : ''}
      </div>
      <p>&copy; ${new Date().getFullYear()} ${escapeHtml(name)}. All rights reserved.</p>
    </div>
  </footer>

</body>
</html>`;
}

// ── Section renderers ─────────────────────────────────────────────────────────

function renderSection(sectionKey, copy, brief, profile) {
  const phone = profile.phone || profile.contact_methods?.phone || '';
  const email = profile.email || profile.contact_methods?.email || '';
  const address = profile.location || '';

  switch (sectionKey) {
    case 'hero':
      return renderHero(copy.hero || {}, brief, phone);

    case 'emergency_bar':
      return renderEmergencyBar(profile.business_name, phone);

    case 'services':
    case 'service_cards':
    case 'signature_items':
    case 'featured_items':
      return renderServices(copy.services || {}, brief);

    case 'trust_bar':
      return renderTrustBar(copy.trust || {});

    case 'about':
      return renderAbout(copy.about || {}, profile);

    case 'social_proof':
      return renderSocialProof(profile);

    case 'hours_location':
    case 'visit_cta':
      return renderHoursLocation(profile, brief);

    case 'gallery':
      return renderGallery(profile);

    case 'team':
      return renderTeam(profile);

    case 'contact_cta':
    case 'contact':
      return renderContact(copy.contact || {}, brief, phone, email, address);

    case 'menu_preview':
      return renderMenuPreview(profile, brief);

    case 'featured_products':
      return renderFeaturedProducts(profile, brief);

    case 'process':
      return renderProcess(brief);

    default:
      return null;
  }
}

function renderHero(heroCopy, brief, phone) {
  const headline = heroCopy.headline || 'Welcome';
  const sub = heroCopy.subheadline || '';
  const cta1 = heroCopy.cta_primary || brief.primary_cta || 'Get Started';
  const cta2 = heroCopy.cta_secondary || brief.secondary_cta || null;

  return `  <!-- Hero -->
  <section id="hero" style="min-height:90vh; display:flex; align-items:center; text-align:center; padding:120px 24px 80px;">
    <div class="container">
      <h1 style="margin-bottom:24px; max-width:800px; margin-left:auto; margin-right:auto;">${escapeHtml(headline)}</h1>
      ${sub ? `<p style="font-size:1.2rem; max-width:600px; margin:0 auto 40px; opacity:0.8;">${escapeHtml(sub)}</p>` : ''}
      <div style="display:flex; gap:16px; justify-content:center; flex-wrap:wrap;">
        ${phone
          ? `<a class="btn btn-primary" href="tel:${phone.replace(/\D/g, '')}">${escapeHtml(cta1)}</a>`
          : `<a class="btn btn-primary" href="#contact">${escapeHtml(cta1)}</a>`}
        ${cta2 ? `<a class="btn btn-secondary" href="#services">${escapeHtml(cta2)}</a>` : ''}
      </div>
    </div>
  </section>`;
}

function renderEmergencyBar(businessName, phone) {
  if (!phone) return null;
  return `  <!-- Emergency Bar -->
  <div class="emergency-bar">
    Emergency service available 24/7 — <a href="tel:${phone.replace(/\D/g, '')}">${escapeHtml(phone)}</a>
  </div>`;
}

function renderServices(servicesCopy, brief) {
  const title = servicesCopy.section_title || 'Our Services';
  const items = servicesCopy.items || [];

  if (!items.length) return null;

  const itemHtml = items.slice(0, 6).map((item) => `
      <div class="card">
        <h3>${escapeHtml(item.title || 'Service')}</h3>
        <p>${escapeHtml(item.description || '')}</p>
      </div>`).join('');

  return `  <!-- Services -->
  <section id="services">
    <div class="container">
      <h2 style="text-align:center; margin-bottom:48px;">${escapeHtml(title)}</h2>
      <div class="grid-${items.length <= 2 ? '2' : '3'}">
        ${itemHtml}
      </div>
    </div>
  </section>`;
}

function renderTrustBar(trustCopy) {
  const claims = trustCopy.claims || ['Quality work guaranteed', 'Local & trusted', 'Professional service'];
  const icons = ['✓', '★', '⬡', '◉', '▲'];

  const itemsHtml = claims.slice(0, 5).map((claim, i) => `
    <div class="trust-item">
      <span class="trust-icon">${icons[i % icons.length]}</span>
      <span>${escapeHtml(claim)}</span>
    </div>`).join('');

  return `  <!-- Trust Bar -->
  <div class="trust-bar container">
    ${itemsHtml}
  </div>`;
}

function renderAbout(aboutCopy, profile) {
  const headline = aboutCopy.headline || `About ${profile.business_name || 'Us'}`;
  const body = aboutCopy.body || '';
  if (!body) return null;

  return `  <!-- About -->
  <section id="about">
    <div class="container" style="max-width:720px;">
      <h2>${escapeHtml(headline)}</h2>
      <p style="font-size:1.1rem; line-height:1.8; margin-top:16px;">${escapeHtml(body)}</p>
    </div>
  </section>`;
}

function renderSocialProof(profile) {
  const testimonials = profile.testimonials || [];
  if (!testimonials.length) return null;

  const cards = testimonials.slice(0, 3).map((t) => {
    const quote = typeof t === 'string' ? t : (t.quote || t.text || '');
    const author = typeof t === 'object' ? (t.author || t.name || '') : '';
    return `
      <div class="card">
        <p style="font-size:1.05rem; font-style:italic; margin-bottom:16px;">"${escapeHtml(quote)}"</p>
        ${author ? `<p style="font-size:0.85rem; font-weight:600; opacity:0.6;">— ${escapeHtml(author)}</p>` : ''}
      </div>`;
  }).join('');

  return `  <!-- Testimonials -->
  <section id="reviews">
    <div class="container">
      <h2 style="text-align:center; margin-bottom:48px;">What Our Customers Say</h2>
      <div class="grid-${testimonials.length === 1 ? '2' : '3'}">
        ${cards}
      </div>
    </div>
  </section>`;
}

function renderHoursLocation(profile, brief) {
  const hours = profile.hours;
  const address = profile.location || profile.service_area || '';
  const phone = profile.phone || profile.contact_methods?.phone || '';
  if (!hours && !address) return null;

  const hoursHtml = hours && typeof hours === 'object'
    ? Object.entries(hours).map(([day, time]) => `
          <tr><td>${escapeHtml(day)}</td><td>${escapeHtml(time)}</td></tr>`).join('')
    : hours ? `<tr><td colspan="2">${escapeHtml(String(hours))}</td></tr>` : '';

  return `  <!-- Hours & Location -->
  <section id="hours">
    <div class="container">
      <h2 style="text-align:center; margin-bottom:48px;">Find Us</h2>
      <div class="grid-2">
        ${hoursHtml ? `<div class="card">
          <h3>Hours</h3>
          <table class="hours-table" style="margin-top:12px;">${hoursHtml}</table>
        </div>` : ''}
        <div class="card">
          <h3>Location & Contact</h3>
          ${address ? `<p style="margin-top:8px;">📍 ${escapeHtml(address)}</p>` : ''}
          ${phone ? `<p style="margin-top:8px;">📞 <a href="tel:${phone.replace(/\D/g, '')}" style="color:var(--accent)">${escapeHtml(phone)}</a></p>` : ''}
          ${address ? `<a class="btn btn-primary" href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" style="margin-top:20px; display:inline-block;">Get Directions</a>` : ''}
        </div>
      </div>
    </div>
  </section>`;
}

function renderGallery(profile) {
  const images = profile.existing_imagery || profile.gallery_images || [];
  if (!images.length) return null;

  const imgHtml = images.slice(0, 6).map((img) => {
    const src = typeof img === 'string' ? img : (img.url || img.src || '');
    const alt = typeof img === 'object' ? (img.alt || img.caption || 'Gallery image') : 'Gallery image';
    if (!src) return '';
    return `<div style="aspect-ratio:1; overflow:hidden; border-radius:var(--radius);">
        <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" style="width:100%; height:100%; object-fit:cover;">
      </div>`;
  }).filter(Boolean).join('');

  if (!imgHtml) return null;

  return `  <!-- Gallery -->
  <section id="gallery">
    <div class="container">
      <h2 style="text-align:center; margin-bottom:48px;">Our Work</h2>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:16px;">
        ${imgHtml}
      </div>
    </div>
  </section>`;
}

function renderTeam(profile) {
  const team = profile.team || [];
  if (!team.length) return null;

  const cards = team.slice(0, 6).map((member) => {
    const name = member.name || 'Team Member';
    const role = member.role || member.title || '';
    const bio = member.bio || '';
    const photo = member.photo || '';
    return `<div class="card" style="text-align:center;">
      ${photo ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(name)}" style="width:80px; height:80px; border-radius:50%; object-fit:cover; margin:0 auto 16px; display:block;">` : ''}
      <h3>${escapeHtml(name)}</h3>
      ${role ? `<p style="font-size:0.85rem; color:var(--accent); font-weight:600; margin-bottom:8px;">${escapeHtml(role)}</p>` : ''}
      ${bio ? `<p style="font-size:0.9rem;">${escapeHtml(bio)}</p>` : ''}
    </div>`;
  }).join('');

  return `  <!-- Team -->
  <section id="team">
    <div class="container">
      <h2 style="text-align:center; margin-bottom:48px;">Meet Our Team</h2>
      <div class="grid-3">
        ${cards}
      </div>
    </div>
  </section>`;
}

function renderContact(contactCopy, brief, phone, email, address) {
  const headline = contactCopy.headline || brief.primary_cta;
  const subtext = contactCopy.subtext || '';
  const cta = contactCopy.cta || 'Send Message';

  return `  <!-- Contact -->
  <section id="contact" style="text-align:center;">
    <div class="container" style="max-width:640px;">
      <h2>${escapeHtml(headline)}</h2>
      ${subtext ? `<p style="margin:16px 0 32px; font-size:1.05rem;">${escapeHtml(subtext)}</p>` : '<div style="height:32px;"></div>'}
      <div style="display:flex; flex-direction:column; gap:16px; align-items:center;">
        ${phone ? `<a class="btn btn-primary" href="tel:${phone.replace(/\D/g, '')}" style="min-width:220px;">📞 ${escapeHtml(phone)}</a>` : ''}
        ${email ? `<a class="btn btn-secondary" href="mailto:${escapeHtml(email)}" style="min-width:220px;">✉ ${escapeHtml(email)}</a>` : ''}
        ${address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" style="color:var(--accent); font-size:0.9rem;">📍 ${escapeHtml(address)}</a>` : ''}
      </div>
    </div>
  </section>`;
}

function renderMenuPreview(profile, brief) {
  // Placeholder section for restaurant/cafe — real menu data comes from admin panel
  const phone = profile.phone || profile.contact_methods?.phone || '';
  return `  <!-- Menu Preview -->
  <section id="menu" style="text-align:center;">
    <div class="container">
      <h2>Our Menu</h2>
      <p style="margin:16px auto 32px; max-width:500px;">Fresh ingredients, made to order.</p>
      <a class="btn btn-primary" href="#contact">
        ${phone ? `Call to Order — ${escapeHtml(phone)}` : 'Contact Us'}
      </a>
    </div>
  </section>`;
}

function renderFeaturedProducts(profile, brief) {
  return `  <!-- Featured Products -->
  <section id="shop">
    <div class="container">
      <h2 style="text-align:center; margin-bottom:48px;">Shop Our Products</h2>
      <p style="text-align:center; margin-bottom:32px;">Browse our full collection.</p>
      <div style="text-align:center;">
        <a class="btn btn-primary" href="#contact">${escapeHtml(brief.primary_cta)}</a>
      </div>
    </div>
  </section>`;
}

function renderProcess(brief) {
  const steps = [
    { n: '01', title: 'Contact Us', desc: 'Reach out by phone or form. We respond fast.' },
    { n: '02', title: 'Get a Quote', desc: 'We assess your needs and give you a clear, honest estimate.' },
    { n: '03', title: 'We Get to Work', desc: 'Our team handles the job with care and professionalism.' },
    { n: '04', title: 'Job Done Right', desc: 'We don\'t leave until you\'re satisfied.' },
  ];

  const stepsHtml = steps.map((s) => `
    <div class="card" style="text-align:center;">
      <div style="font-size:2rem; font-weight:700; color:var(--accent); margin-bottom:12px;">${s.n}</div>
      <h3>${s.title}</h3>
      <p style="margin-top:8px;">${s.desc}</p>
    </div>`).join('');

  return `  <!-- Process -->
  <section id="process">
    <div class="container">
      <h2 style="text-align:center; margin-bottom:48px;">How It Works</h2>
      <div class="grid-${steps.length === 4 ? '2' : '3'}" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));">
        ${stepsHtml}
      </div>
    </div>
  </section>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export const SECTION_TEMPLATES = [
  'hero', 'emergency_bar', 'services', 'service_cards', 'trust_bar',
  'about', 'social_proof', 'hours_location', 'gallery', 'team',
  'contact_cta', 'contact', 'menu_preview', 'featured_products', 'process',
];

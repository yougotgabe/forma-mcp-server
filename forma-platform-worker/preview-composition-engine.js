// Formaut Preview Composition Engine v1
// Turns business memory + integrations + artifacts into a deployable preview plan.
// This is intentionally deterministic and fallback-safe: it can render before all
// downstream artifact systems are complete, but exposes decisions for later agents.

import { buildPrintifyProductTemplates } from './printify-product-template-engine.js';

const DEFAULT_LIMIT = 24;

export async function handlePreviewComposition(body = {}, env, deps) {
  const { json } = deps;
  const slug = body.slug || body.client_slug;
  if (!slug) return json({ error: 'slug required' }, 400);

  const client = await getClientBySlug(slug, env, deps);
  if (!client) return json({ error: 'Client not found' }, 404);

  const profile = await loadBusinessProfile(client, body, env, deps);
  const artifacts = await loadActiveArtifacts(client, env, deps);
  const printifyProducts = await loadPrintifyProducts(client, body, env, deps);
  const integrations = await loadIntegrationSummary(client, env, deps, printifyProducts);

  const plan = buildPreviewComposition({
    client,
    profile,
    artifacts,
    integrations,
    printifyProducts,
    requestedDevice: body.device || 'responsive',
    requestedMode: body.mode || 'dashboard_preview',
  });

  return json(plan);
}

export function buildPreviewComposition(input = {}) {
  const client = input.client || {};
  const profile = normalizeProfile(input.profile || {}, client);
  const artifacts = normalizeArtifacts(input.artifacts || []);
  const integrations = input.integrations || {};
  const products = Array.isArray(input.printifyProducts) ? input.printifyProducts : [];
  const hasPrintifyProducts = products.length > 0;

  const style = chooseLayoutStyle(profile);
  const theme = buildThemeTokens(profile, style);
  const commerceMode = chooseCommerceMode({ profile, integrations, products });
  const sections = chooseSections({ profile, artifacts, commerceMode, hasPrintifyProducts });
  const responsiveRules = buildResponsiveRules({ commerceMode, products });
  const missingData = detectMissingData({ profile, commerceMode, integrations });

  const commerce = buildCommerceBlock({ products, profile, commerceMode, style });
  const html = renderPreviewDocument({ profile, artifacts, theme, style, sections, commerce, commerceMode });

  return {
    ok: true,
    engine: 'formaut-preview-composition-engine',
    version: 'preview-composition-v1',
    mode: input.requestedMode || 'dashboard_preview',
    device: input.requestedDevice || 'responsive',
    client_slug: client.slug || profile.slug || null,
    decisions: {
      has_printify_products: hasPrintifyProducts,
      commerce_mode: commerceMode,
      layout_style: style.id,
      layout_reason: style.reason,
      product_strategy: chooseProductStrategy(products),
      brand_density: chooseBrandDensity(profile),
      mobile_priority: commerceMode.enabled ? 'featured_products_then_grid' : 'cta_then_services',
    },
    theme_tokens: theme,
    sections: sections.map((section) => ({ id: section.id, purpose: section.purpose, source: section.source })),
    missing_data: missingData,
    next_actions: buildNextActions({ missingData, commerceMode, integrations }),
    html,
    css: buildBaseCss(theme, style) + (commerce.css || ''),
    commerce,
  };
}

async function getClientBySlug(slug, env, deps) {
  const res = await deps.supabase(env, 'GET', `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id,slug,display_name,business_name,description,created_at&limit=1`);
  const rows = res.ok ? await res.json() : [];
  return rows[0] || null;
}

async function loadBusinessProfile(client, body, env, deps) {
  // Prefer explicit preview input, then normalized business profile tables, then client row.
  if (body.business_profile || body.profile) return body.business_profile || body.profile;

  const attempts = [
    `/rest/v1/client_context?client_id=eq.${client.id}&select=business_profile,visual_style,brand_voice,updated_at&limit=1`,
    `/rest/v1/business_profiles?client_id=eq.${client.id}&select=*&limit=1`,
  ];

  for (const path of attempts) {
    try {
      const res = await deps.supabase(env, 'GET', path);
      if (!res.ok) continue;
      const rows = await res.json();
      const row = rows[0];
      if (!row) continue;
      if (row.business_profile) return { ...row.business_profile, visual_style: row.visual_style, brand_voice: row.brand_voice };
      return row;
    } catch {}
  }

  return {
    business_name: client.business_name || client.display_name || client.slug || 'Your Business',
    description: client.description || '',
  };
}

async function loadActiveArtifacts(client, env, deps) {
  const paths = [
    `/rest/v1/artifact_versions?client_id=eq.${client.id}&status=eq.active&select=artifact_type,title,summary,content,metadata,created_at&order=created_at.desc&limit=12`,
    `/rest/v1/generated_artifacts?client_id=eq.${client.id}&status=eq.active&select=artifact_type,title,summary,content,metadata,created_at&order=created_at.desc&limit=12`,
  ];
  for (const path of paths) {
    try {
      const res = await deps.supabase(env, 'GET', path);
      if (!res.ok) continue;
      return await res.json();
    } catch {}
  }
  return [];
}

async function loadPrintifyProducts(client, body, env, deps) {
  const limit = Math.min(Number(body.product_limit || body.limit || DEFAULT_LIMIT), 60);
  try {
    const res = await deps.supabase(env, 'GET', `/rest/v1/commerce_products?client_id=eq.${client.id}&provider=eq.printify&visible=eq.true&select=id,provider,external_product_id,title,description,status,visible,tags,images,variants,synced_at,updated_at&order=updated_at.desc&limit=${limit}`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

async function loadIntegrationSummary(client, env, deps, printifyProducts) {
  const summary = {
    printify: { connected: printifyProducts.length > 0, product_count: printifyProducts.length },
    stripe: { connected: false },
    github: { connected: false },
    cloudflare: { connected: false },
    supabase: { connected: false },
  };

  try {
    const res = await deps.supabase(env, 'GET', `/rest/v1/client_integrations?client_id=eq.${client.id}&select=provider,status,metadata,updated_at`);
    if (!res.ok) return summary;
    const rows = await res.json();
    for (const row of rows || []) {
      const provider = row.provider || row.integration_type;
      if (!provider) continue;
      summary[provider] = {
        connected: ['connected', 'active', 'ready'].includes(String(row.status || '').toLowerCase()),
        status: row.status,
        metadata: row.metadata || {},
      };
    }
    if (printifyProducts.length) summary.printify.connected = true;
    summary.printify.product_count = printifyProducts.length;
  } catch {}
  return summary;
}

function normalizeProfile(profile, client) {
  const rawVisual = profile.visual_style || profile.style || {};
  const brandVoice = profile.brand_voice || profile.voice || [];
  const businessName = profile.business_name || profile.name || client.business_name || client.display_name || client.slug || 'Your Business';
  const services = normalizeList(profile.services || profile.offerings || profile.primary_services).slice(0, 6);
  return {
    ...profile,
    slug: client.slug || profile.slug,
    business_name: businessName,
    headline: profile.headline || profile.tagline || `${businessName} online`,
    description: profile.description || profile.summary || client.description || '',
    business_type: String(profile.business_type || profile.industry || profile.category || '').toLowerCase(),
    services,
    brand_voice: normalizeList(brandVoice).map((v) => String(v).toLowerCase()),
    visual_style: rawVisual,
    colors: normalizeColors(rawVisual.colors || profile.colors || []),
    primary_cta: profile.primary_cta || inferPrimaryCta(profile),
    contact: profile.contact || {},
  };
}

function normalizeArtifacts(artifacts) {
  return (Array.isArray(artifacts) ? artifacts : []).filter(Boolean).map((a) => ({
    type: a.artifact_type || a.type || 'unknown',
    title: a.title || '',
    summary: a.summary || '',
    content: a.content || '',
    metadata: a.metadata || {},
  }));
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') return value.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);
  return [];
}

function normalizeColors(colors) {
  const list = normalizeList(colors).filter((c) => /^#?[0-9a-f]{3,8}$/i.test(String(c).trim())).map((c) => String(c).startsWith('#') ? String(c) : `#${c}`);
  return list.slice(0, 5);
}

function chooseLayoutStyle(profile) {
  const haystack = `${profile.business_type} ${profile.description} ${profile.brand_voice.join(' ')}`.toLowerCase();
  if (/band|music|artist|tattoo|streetwear|skate|gaming|creator|podcast|studio/.test(haystack)) {
    return { id: 'bold_commerce', reason: 'creative/merch language benefits from a bold editorial storefront.' };
  }
  if (/luxury|premium|minimal|boutique|jewelry|spa|salon|wellness|fashion/.test(haystack)) {
    return { id: 'premium_minimal', reason: 'premium/lifestyle language benefits from whitespace and restrained merchandising.' };
  }
  if (/restaurant|cafe|bakery|food|local|community|handmade|craft/.test(haystack)) {
    return { id: 'warm_local', reason: 'local/craft language benefits from warmth and trust cues.' };
  }
  return { id: 'clean_adaptive', reason: 'defaulting to a clean flexible layout until stronger style evidence exists.' };
}

function buildThemeTokens(profile, style) {
  const colors = profile.colors || [];
  const fallback = {
    bold_commerce: ['#0a0a0f', '#f7f2ea', '#7c3aed'],
    premium_minimal: ['#f8f5ef', '#1d1b18', '#9a6a43'],
    warm_local: ['#fff8ef', '#2d1f14', '#c56a2d'],
    clean_adaptive: ['#f8fafc', '#111827', '#2563eb'],
  }[style.id] || ['#ffffff', '#111827', '#2563eb'];

  const bg = colors[0] || fallback[0];
  const text = colors[1] || fallback[1];
  const accent = colors[2] || fallback[2];
  return {
    background: bg,
    surface: style.id === 'bold_commerce' ? '#12121a' : '#ffffff',
    text,
    muted: style.id === 'bold_commerce' ? '#a1a1aa' : '#667085',
    accent,
    border: style.id === 'bold_commerce' ? '#2a2a40' : '#e5e7eb',
    radius: style.id === 'premium_minimal' ? '10px' : '24px',
    font_heading: style.id === 'bold_commerce' ? 'Impact, Inter, system-ui, sans-serif' : 'Inter, system-ui, sans-serif',
    font_body: 'Inter, system-ui, sans-serif',
  };
}

function chooseCommerceMode({ integrations, products }) {
  const hasProducts = products.length > 0;
  const printifyConnected = integrations?.printify?.connected || hasProducts;
  return {
    enabled: Boolean(printifyConnected || hasProducts),
    provider: printifyConnected ? 'printify' : null,
    product_count: products.length,
    checkout: integrations?.stripe?.connected ? 'live_candidate' : 'visual_placeholder',
    reason: hasProducts ? 'Printify products are synced.' : printifyConnected ? 'Printify is connected but products are not synced yet.' : 'No commerce integration detected.',
  };
}

function chooseSections({ profile, artifacts, commerceMode, hasPrintifyProducts }) {
  const sections = [
    { id: 'navigation', purpose: 'Brand identity and primary links', source: 'composition_engine' },
    { id: 'hero', purpose: 'Immediate business positioning and CTA', source: artifacts.find((a) => a.type === 'homepage') ? 'artifact' : 'business_profile' },
  ];
  if (commerceMode.enabled) {
    sections.push({ id: 'featured_products', purpose: 'Merchandising block from Printify catalog', source: hasPrintifyProducts ? 'printify_catalog' : 'commerce_fallback' });
    sections.push({ id: 'shop_grid', purpose: 'Responsive product collection', source: hasPrintifyProducts ? 'printify_catalog' : 'commerce_fallback' });
    sections.push({ id: 'checkout_notice', purpose: 'Safe checkout status until payments are connected', source: 'integration_state' });
  }
  if (profile.services?.length) sections.push({ id: 'services', purpose: 'Service/offer summary', source: 'business_profile' });
  sections.push({ id: 'trust_cta', purpose: 'Conversion and next step', source: 'composition_engine' });
  return sections;
}

function buildResponsiveRules({ commerceMode, products }) {
  return {
    desktop: commerceMode.enabled ? 'hero + featured product + 3/4 column grid' : 'hero + services + cta',
    tablet: commerceMode.enabled ? '2 column product grid' : 'stacked content cards',
    mobile: commerceMode.enabled ? 'single column products, sticky-friendly CTAs, compressed nav' : 'single column content, large CTA',
    image_strategy: products.length ? 'use catalog images with square crop fallback' : 'neutral placeholders',
  };
}

function detectMissingData({ profile, commerceMode, integrations }) {
  const missing = [];
  if (!profile.business_name || profile.business_name === 'Your Business') missing.push('business_name');
  if (!profile.description && !profile.headline) missing.push('business_description');
  if (!profile.colors?.length) missing.push('brand_colors');
  if (commerceMode.enabled && commerceMode.checkout !== 'live_candidate') missing.push('payment_provider_for_live_checkout');
  if (integrations?.printify?.connected && !commerceMode.product_count) missing.push('printify_product_sync');
  return missing;
}

function buildNextActions({ missingData, commerceMode }) {
  const actions = [];
  if (missingData.includes('business_description')) actions.push('ask_for_business_description_or_run_website_crawl');
  if (missingData.includes('brand_colors')) actions.push('infer_visual_style_or_ask_for_brand_assets');
  if (missingData.includes('printify_product_sync')) actions.push('sync_printify_products');
  if (commerceMode.enabled && missingData.includes('payment_provider_for_live_checkout')) actions.push('connect_stripe_before_accepting_payments');
  if (!actions.length) actions.push('preview_ready_for_review');
  return actions;
}

function buildCommerceBlock({ products, profile, commerceMode, style }) {
  if (!commerceMode.enabled) return { enabled: false, html: '', css: '', templates: {} };
  const template = buildPrintifyProductTemplates({
    products,
    mode: 'composed_preview',
    brand: {
      business_name: profile.business_name,
      headline: commerceHeadline(profile, style),
      subheadline: commerceSubheadline(profile, commerceMode),
      primary_cta: 'View product',
      checkout_cta: commerceMode.checkout === 'live_candidate' ? 'Add to cart' : 'Checkout setup pending',
    },
  });
  return {
    enabled: true,
    provider: 'printify',
    product_count: products.length,
    checkout: commerceMode.checkout,
    html: `${template.templates.featured_product.html}\n${template.templates.collection_grid.html}\n${template.templates.mini_cart_placeholder.html}`,
    css: template.templates.collection_grid.css,
    templates: template.templates,
    source: template.source,
  };
}

function commerceHeadline(profile, style) {
  if (style.id === 'bold_commerce') return 'Latest merch and featured drops';
  if (style.id === 'premium_minimal') return 'Curated products from the brand';
  if (style.id === 'warm_local') return 'Products made for the people who support us';
  return 'Shop featured products';
}

function commerceSubheadline(profile, commerceMode) {
  if (commerceMode.product_count) return `Generated from ${commerceMode.product_count} connected Printify product${commerceMode.product_count === 1 ? '' : 's'}.`;
  return 'A safe storefront preview is ready. Sync products to replace the placeholders.';
}

function chooseProductStrategy(products) {
  if (!products.length) return 'fallback_sample_products';
  if (products.length <= 4) return 'feature_all_products';
  if (products.length <= 12) return 'featured_plus_grid';
  return 'featured_plus_paginated_collection_candidate';
}

function chooseBrandDensity(profile) {
  const voice = profile.brand_voice.join(' ');
  if (/minimal|premium|luxury|calm/.test(voice)) return 'low_density';
  if (/bold|energetic|street|loud/.test(voice)) return 'high_impact';
  return 'balanced';
}

function inferPrimaryCta(profile) {
  const txt = `${profile.business_type || ''} ${profile.description || ''}`.toLowerCase();
  if (/shop|store|merch|apparel|product/.test(txt)) return 'Shop now';
  if (/appointment|salon|barber|spa/.test(txt)) return 'Book now';
  if (/restaurant|food|cafe/.test(txt)) return 'See menu';
  return 'Get started';
}

function renderPreviewDocument({ profile, artifacts, theme, style, sections, commerce, commerceMode }) {
  const services = profile.services || [];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(profile.business_name)} · Formaut Preview</title>
<style>${buildBaseCss(theme, style)}${commerce.css || ''}</style>
</head>
<body>
  <main class="fm-preview fm-preview--${escAttr(style.id)}">
    ${renderNav(profile, commerceMode)}
    ${renderHero(profile, style)}
    ${commerce.enabled ? `<section class="fm-composed-commerce" data-source="${escAttr(commerce.source)}">${commerce.html}</section>` : ''}
    ${services.length ? renderServices(services, theme) : ''}
    ${renderTrustCta(profile, commerceMode)}
  </main>
</body>
</html>`;
}

function renderNav(profile, commerceMode) {
  return `<nav class="fm-preview-nav"><strong>${esc(profile.business_name)}</strong><span>${commerceMode.enabled ? 'Home · Shop · Contact' : 'Home · Services · Contact'}</span></nav>`;
}

function renderHero(profile, style) {
  return `<section class="fm-preview-hero">
    <p class="fm-preview-eyebrow">${esc(style.id.replace(/_/g, ' '))}</p>
    <h1>${esc(profile.headline || profile.business_name)}</h1>
    <p>${esc(profile.description || 'A working preview composed from your current Formaut business memory.')}</p>
    <a href="#" class="fm-preview-button">${esc(profile.primary_cta)}</a>
  </section>`;
}

function renderServices(services) {
  return `<section class="fm-preview-services"><p class="fm-preview-eyebrow">What we do</p><div>${services.map((s) => `<article>${esc(s)}</article>`).join('')}</div></section>`;
}

function renderTrustCta(profile, commerceMode) {
  const text = commerceMode.enabled ? 'Review the storefront, connect payments when ready, then publish safely.' : 'Review this first draft, then Formaut can refine copy, visuals, and sections.';
  return `<section class="fm-preview-final-cta"><h2>Ready for review</h2><p>${esc(text)}</p><a class="fm-preview-button" href="#">Continue setup</a></section>`;
}

function buildBaseCss(theme, style) {
  const commerceBg = style.id === 'bold_commerce' ? '#0f0f17' : '#ffffff';
  return `
*{box-sizing:border-box}
body{margin:0;background:${theme.background};color:${theme.text};font-family:${theme.font_body};}
.fm-preview{min-height:100vh;background:${theme.background};color:${theme.text};}
.fm-preview-nav{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;gap:1rem;align-items:center;padding:1rem clamp(1rem,4vw,3rem);border-bottom:1px solid ${theme.border};background:${theme.background}e6;backdrop-filter:blur(12px)}
.fm-preview-nav strong{font-family:${theme.font_heading};font-size:1.1rem}
.fm-preview-nav span{color:${theme.muted};font-size:.9rem}
.fm-preview-hero{padding:clamp(4rem,9vw,8rem) clamp(1rem,5vw,4rem);max-width:1120px;margin:0 auto}
.fm-preview-eyebrow{margin:0 0 1rem;text-transform:uppercase;letter-spacing:.16em;font-size:.75rem;font-weight:900;color:${theme.accent}}
.fm-preview-hero h1{font-family:${theme.font_heading};font-size:clamp(2.6rem,8vw,6.5rem);line-height:.95;margin:0 0 1.25rem;max-width:920px}
.fm-preview-hero p{max-width:680px;color:${theme.muted};font-size:clamp(1rem,2vw,1.25rem);line-height:1.65}
.fm-preview-button{display:inline-flex;margin-top:1.25rem;min-height:46px;align-items:center;justify-content:center;border-radius:${theme.radius};padding:.85rem 1.2rem;background:${theme.accent};color:white;text-decoration:none;font-weight:900}
.fm-composed-commerce{background:${commerceBg};color:#111827}
.fm-preview-services{padding:clamp(2rem,6vw,5rem) clamp(1rem,5vw,4rem);max-width:1120px;margin:0 auto}
.fm-preview-services>div{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}
.fm-preview-services article{border:1px solid ${theme.border};border-radius:${theme.radius};padding:1.4rem;background:${theme.surface};color:${theme.text};font-weight:800}
.fm-preview-final-cta{margin:0 auto;padding:clamp(3rem,7vw,6rem) clamp(1rem,5vw,4rem);text-align:center;max-width:820px}
.fm-preview-final-cta h2{font-size:clamp(2rem,5vw,4rem);margin:0 0 1rem}
.fm-preview-final-cta p{color:${theme.muted}}
@media(max-width:760px){.fm-preview-nav span{display:none}.fm-preview-services>div{grid-template-columns:1fr}.fm-preview-hero{padding-top:4rem}.fm-preview-button{width:100%}}
`;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escAttr(value) { return esc(value); }

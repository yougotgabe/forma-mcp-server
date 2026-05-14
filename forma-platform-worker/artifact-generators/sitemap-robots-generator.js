// =============================================================================
// FORMAUT — SITEMAP + ROBOTS GENERATORS
// =============================================================================
// Fully deterministic. No AI calls needed.
// Generates XML sitemap and robots.txt content from known page structure.
// =============================================================================

/**
 * Generate sitemap.xml content.
 *
 * @param {object} profile  - Business profile
 * @param {string[]} pages  - List of page slugs beyond the homepage (e.g. ['menu', 'about', 'contact'])
 * @returns {{ xml: string, page_count: number, generated_at: string }}
 */
export function generateSitemap(profile, pages = []) {
  const liveUrl = profile.live_url || profile.website_url || '';
  const base = liveUrl.endsWith('/') ? liveUrl.slice(0, -1) : liveUrl;
  const now = new Date().toISOString().split('T')[0];

  // Build list of all URLs
  const allPages = ['', ...pages.filter(Boolean)];
  const uniquePages = [...new Set(allPages)];

  const urlEntries = uniquePages.map((slug) => {
    const url = slug ? `${base}/${slug.replace(/^\//, '')}` : base;
    const priority = slug === '' ? '1.0' : '0.7';
    const changefreq = slug === '' ? 'weekly' : 'monthly';
    return `  <url>
    <loc>${escapeXml(url)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries.join('\n')}
</urlset>`;

  return {
    xml,
    base_url: base,
    page_count: uniquePages.length,
    pages: uniquePages,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Derive standard page list from a design brief's section list.
 * Single-page sites have only '/'. Multi-section sites may have sub-pages.
 *
 * @param {string[]} sections  - Section keys from the design brief
 * @param {boolean}  multiPage - Whether the site has separate pages (default: false)
 * @returns {string[]}
 */
export function deriveSitemapPages(sections, multiPage = false) {
  if (!multiPage) return []; // Single-page site — only homepage

  const pageMap = {
    services: 'services',
    service_cards: 'services',
    menu_preview: 'menu',
    gallery: 'gallery',
    team: 'team',
    about: 'about',
    contact_cta: 'contact',
    contact: 'contact',
    social_proof: 'reviews',
    hours_location: 'contact',
    featured_products: 'shop',
  };

  const pages = new Set();
  for (const s of sections) {
    const p = pageMap[s];
    if (p) pages.add(p);
  }
  return [...pages];
}

// ── Robots.txt ────────────────────────────────────────────────────────────────

/**
 * Generate robots.txt content.
 *
 * @param {object} profile  - Business profile
 * @param {object} options
 * @param {boolean} [options.block_admin=true]  - Block /admin from crawlers
 * @param {boolean} [options.block_api=true]    - Block /api from crawlers
 * @returns {{ text: string, generated_at: string }}
 */
export function generateRobots(profile, options = {}) {
  const liveUrl = profile.live_url || profile.website_url || '';
  const base = liveUrl.endsWith('/') ? liveUrl.slice(0, -1) : liveUrl;
  const blockAdmin = options.block_admin !== false;
  const blockApi = options.block_api !== false;

  const disallowLines = [];
  if (blockAdmin) disallowLines.push('Disallow: /admin');
  if (blockApi) disallowLines.push('Disallow: /api/');
  disallowLines.push('Disallow: /functions/');

  const sitemapUrl = base ? `${base}/sitemap.xml` : null;

  const lines = [
    'User-agent: *',
    'Allow: /',
    ...disallowLines,
    '',
    sitemapUrl ? `Sitemap: ${sitemapUrl}` : null,
  ].filter((l) => l !== null);

  return {
    text: lines.join('\n'),
    sitemap_url: sitemapUrl,
    generated_at: new Date().toISOString(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

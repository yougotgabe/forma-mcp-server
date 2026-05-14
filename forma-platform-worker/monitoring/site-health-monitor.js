// =============================================================================
// FORMAUT — SITE HEALTH MONITOR
// =============================================================================
// Replaces the hardcoded stub. Runs real HTTP checks against a client's
// live Cloudflare Pages URL.
//
// Design principles:
//   - No external dependencies — pure fetch(), Cloudflare Worker compatible
//   - All checks run in parallel via Promise.allSettled
//   - Returns structured alerts consumable by operational-remediation-planner
//   - Never throws — always returns a result shape even on network failure
//   - Respects a 12-second total budget (CF Worker CPU limit headroom)
//
// Called by: operational-maintenance-orchestrator → collectOperationalHealth
// =============================================================================

const TIMEOUT_MS = 10_000;
const SLOW_RESPONSE_WARN_MS = 3_000;
const SLOW_RESPONSE_ALERT_MS = 7_000;
const MIN_CONTENT_LENGTH = 500; // bytes — below this, page is suspect

// ---------------------------------------------------------------------------
// MAIN EXPORT
// ---------------------------------------------------------------------------

export async function runSiteHealthMonitor(env, client) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const liveUrl = normalizeLiveUrl(client);
  if (!liveUrl) {
    return buildResult({ client, startedAt, liveUrl: null, ok: false,
      error: 'no_live_url', checks: {}, alerts: [{ type: 'no_live_url', severity: 'warn', message: 'Client has no live_url — skipping health check.' }] });
  }

  const [homepageResult, seoResult] = await Promise.allSettled([
    checkHomepage(liveUrl),
    checkSeoSignals(liveUrl),
  ]);

  const homepage = homepageResult.status === 'fulfilled' ? homepageResult.value : buildFailedCheck('homepage_fetch_error', homepageResult.reason);
  const seo      = seoResult.status === 'fulfilled'      ? seoResult.value      : buildFailedCheck('seo_fetch_error',      seoResult.reason);

  const checks = {
    homepage_reachable:    homepage.reachable,
    status_code:           homepage.status_code,
    response_time_ms:      homepage.response_time_ms,
    content_length_bytes:  homepage.content_length_bytes,
    is_html:               homepage.is_html,
    likely_js_only:        homepage.likely_js_only,
    has_title:             seo.has_title,
    title_text:            seo.title_text,
    has_meta_description:  seo.has_meta_description,
    has_canonical:         seo.has_canonical,
    has_og_tags:           seo.has_og_tags,
    has_attribution:       seo.has_attribution,
    broken_links_sample:   homepage.broken_links_sample ?? [],
  };

  const alerts = buildAlerts(checks, liveUrl);
  const ok = homepage.reachable && checks.status_code >= 200 && checks.status_code < 400;

  return buildResult({ client, startedAt, liveUrl, ok, checks, alerts, duration_ms: Date.now() - t0 });
}

// ---------------------------------------------------------------------------
// HOMEPAGE CHECK
// Fetches the live URL and measures reachability, status, timing, content.
// ---------------------------------------------------------------------------

async function checkHomepage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Formaut-HealthMonitor/1.0 (+https://formaut.com)' },
    });
    clearTimeout(timer);

    const response_time_ms = Date.now() - t0;
    const contentType = res.headers.get('content-type') || '';
    const is_html = contentType.includes('text/html');

    let html = '';
    let content_length_bytes = 0;
    let likely_js_only = false;
    let broken_links_sample = [];

    if (is_html) {
      const raw = await res.text();
      html = raw.slice(0, 300_000); // cap at 300KB
      content_length_bytes = new TextEncoder().encode(raw).length;
      likely_js_only = detectJsOnlyPage(html);
      broken_links_sample = await sampleInternalLinks(url, html);
    } else {
      content_length_bytes = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    }

    return {
      reachable: res.ok,
      status_code: res.status,
      response_time_ms,
      content_length_bytes,
      is_html,
      likely_js_only,
      broken_links_sample,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      reachable: false,
      status_code: 0,
      response_time_ms: Date.now() - t0,
      content_length_bytes: 0,
      is_html: false,
      likely_js_only: false,
      broken_links_sample: [],
      error: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'network_error'),
    };
  }
}

// ---------------------------------------------------------------------------
// SEO CHECK
// Fetches HTML and inspects key SEO signals.
// Reuses the same fetch as homepage in full usage — separated here for clarity.
// ---------------------------------------------------------------------------

async function checkSeoSignals(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Formaut-HealthMonitor/1.0 (+https://formaut.com)' },
    });
    clearTimeout(timer);

    if (!res.ok) return buildEmptySeo();
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return buildEmptySeo();

    const raw = await res.text();
    const html = raw.slice(0, 120_000);

    const titleMatch   = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const descMatch    = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})["']/i)
                      || html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i);
    const canonMatch   = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
    const ogTitle      = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const ogDesc       = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    const attribution  = html.includes('Built with Formaut') || html.includes('formaut.com');

    return {
      has_title:            !!titleMatch,
      title_text:           titleMatch ? titleMatch[1].trim().slice(0, 120) : null,
      has_meta_description: !!descMatch,
      has_canonical:        !!canonMatch,
      canonical_url:        canonMatch ? canonMatch[1] : null,
      has_og_tags:          !!(ogTitle || ogDesc),
      has_attribution:      attribution,
    };
  } catch {
    clearTimeout(timer);
    return buildEmptySeo();
  }
}

function buildEmptySeo() {
  return {
    has_title: false, title_text: null, has_meta_description: false,
    has_canonical: false, canonical_url: null, has_og_tags: false, has_attribution: false,
  };
}

// ---------------------------------------------------------------------------
// INTERNAL LINK SAMPLING
// Checks up to 5 internal links from the homepage for 404s.
// Returns list of broken URLs found.
// ---------------------------------------------------------------------------

async function sampleInternalLinks(baseUrl, html) {
  const origin = new URL(baseUrl).origin;
  const hrefs  = [...html.matchAll(/href=["']([^"'#?]+)["']/gi)]
    .map(m => m[1])
    .filter(h => h.startsWith('/') || h.startsWith(origin))
    .map(h => h.startsWith('/') ? `${origin}${h}` : h)
    .filter(h => !/\.(pdf|jpg|jpeg|png|webp|svg|ico|css|js|woff|woff2)$/i.test(h))
    .slice(0, 5);

  if (!hrefs.length) return [];

  const broken = [];
  await Promise.allSettled(hrefs.map(async href => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(href, { method: 'HEAD', redirect: 'follow', signal: controller.signal,
        headers: { 'User-Agent': 'Formaut-HealthMonitor/1.0' } });
      clearTimeout(timer);
      if (res.status === 404 || res.status === 410) broken.push({ url: href, status: res.status });
    } catch { /* network error on sample link — not an alert */ }
  }));

  return broken;
}

// ---------------------------------------------------------------------------
// JS-ONLY DETECTION
// React/Next/Vite sites often return <body><div id="root"></div></body>
// when fetched without a browser. Flag these for the agent to note.
// ---------------------------------------------------------------------------

function detectJsOnlyPage(html) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return false;
  const bodyText = bodyMatch[1]
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .trim();
  const hasFrameworkBundle = /__next|_nuxt|vite|react-dom|vue\.runtime/i.test(html);
  return bodyText.length < 200 && hasFrameworkBundle;
}

// ---------------------------------------------------------------------------
// ALERT BUILDER
// Converts check results into structured alert objects for the remediation planner.
// ---------------------------------------------------------------------------

function buildAlerts(checks, liveUrl) {
  const alerts = [];

  if (!checks.homepage_reachable) {
    alerts.push({ type: 'homepage_unreachable', severity: 'critical',
      message: `Homepage returned status ${checks.status_code || 'no response'}.`,
      url: liveUrl, auto_remediable: false });
  }

  if (checks.homepage_reachable && checks.status_code >= 400) {
    alerts.push({ type: 'bad_status_code', severity: 'critical',
      message: `Homepage returned HTTP ${checks.status_code}.`,
      url: liveUrl, auto_remediable: false });
  }

  if (checks.response_time_ms > SLOW_RESPONSE_ALERT_MS) {
    alerts.push({ type: 'slow_response', severity: 'warn',
      message: `Homepage responded in ${checks.response_time_ms}ms — above ${SLOW_RESPONSE_ALERT_MS}ms threshold.`,
      url: liveUrl, auto_remediable: false });
  } else if (checks.response_time_ms > SLOW_RESPONSE_WARN_MS) {
    alerts.push({ type: 'slow_response_minor', severity: 'info',
      message: `Homepage responded in ${checks.response_time_ms}ms.`,
      url: liveUrl, auto_remediable: false });
  }

  if (checks.homepage_reachable && checks.content_length_bytes < MIN_CONTENT_LENGTH) {
    alerts.push({ type: 'thin_content', severity: 'warn',
      message: `Homepage HTML is only ${checks.content_length_bytes} bytes — page may not be rendering correctly.`,
      url: liveUrl, auto_remediable: false });
  }

  if (checks.likely_js_only) {
    alerts.push({ type: 'js_only_render', severity: 'info',
      message: 'Homepage appears to require JavaScript to render. Content may be invisible to search engines.',
      url: liveUrl, auto_remediable: false });
  }

  if (!checks.has_title) {
    alerts.push({ type: 'missing_title', severity: 'warn',
      message: 'Homepage is missing a <title> tag. This hurts SEO rankings and browser tab display.',
      url: liveUrl, auto_remediable: true, remediation_job: 'generate_seo' });
  }

  if (!checks.has_meta_description) {
    alerts.push({ type: 'missing_meta_description', severity: 'info',
      message: 'Homepage is missing a meta description. Search engines use this for result snippets.',
      url: liveUrl, auto_remediable: true, remediation_job: 'generate_seo' });
  }

  if (!checks.has_canonical) {
    alerts.push({ type: 'missing_canonical', severity: 'info',
      message: 'Homepage is missing a canonical link tag. Add one to prevent duplicate content issues.',
      url: liveUrl, auto_remediable: true, remediation_job: 'generate_seo' });
  }

  if (!checks.has_og_tags) {
    alerts.push({ type: 'missing_og_tags', severity: 'info',
      message: 'Homepage is missing Open Graph tags. Links shared on social media will not preview correctly.',
      url: liveUrl, auto_remediable: true, remediation_job: 'generate_seo' });
  }

  if (!checks.has_attribution) {
    alerts.push({ type: 'missing_attribution', severity: 'info',
      message: '"Built with Formaut" attribution not found. It will be restored on the next site update.',
      url: liveUrl, auto_remediable: true, remediation_job: 'restore_attribution' });
  }

  if (checks.broken_links_sample && checks.broken_links_sample.length > 0) {
    for (const link of checks.broken_links_sample) {
      alerts.push({ type: 'broken_internal_link', severity: 'warn',
        message: `Internal link returned ${link.status}: ${link.url}`,
        url: link.url, auto_remediable: false });
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function normalizeLiveUrl(client) {
  const url = client.live_url || client.pages_url
    || (client.cloudflare_pages_project ? `https://${client.cloudflare_pages_project}.pages.dev` : null)
    || (client.slug ? `https://${client.slug}.pages.dev` : null);
  if (!url) return null;
  try { return new URL(url).toString(); } catch { return null; }
}

function buildResult({ client, startedAt, liveUrl, ok, checks, alerts, duration_ms = 0, error = null }) {
  return {
    ok,
    type: 'site_health',
    client_id: client.id || null,
    client_slug: client.slug,
    live_url: liveUrl,
    started_at: startedAt,
    duration_ms,
    checks,
    alerts,
    alert_count: alerts.length,
    critical_count: alerts.filter(a => a.severity === 'critical').length,
    warn_count: alerts.filter(a => a.severity === 'warn').length,
    error: error || null,
  };
}

function buildFailedCheck(error, reason) {
  return {
    reachable: false, status_code: 0, response_time_ms: 0,
    content_length_bytes: 0, is_html: false, likely_js_only: false,
    broken_links_sample: [], error: reason?.message || error,
    has_title: false, title_text: null, has_meta_description: false,
    has_canonical: false, has_og_tags: false, has_attribution: false,
  };
}

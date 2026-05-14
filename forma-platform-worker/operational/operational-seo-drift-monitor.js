// =============================================================================
// FORMAUT SEO DRIFT MONITOR
// =============================================================================
// A real operational monitor that compares live homepage SEO signals against the
// latest live/staged SEO artifact. It emits normalized operational events only;
// the remediation planner decides what becomes a queue job or review item.
// =============================================================================

const DEFAULT_MIN_TITLE_LENGTH = 5;
const DEFAULT_MIN_DESCRIPTION_LENGTH = 20;

export async function collectSeoDriftEvents(env, client = {}, deps = {}) {
  const liveUrl = client.live_url || client.site_url || client.url;
  if (!liveUrl) return [];

  const snapshot = await readLiveSeoSnapshot(liveUrl);
  const expected = await loadExpectedSeoArtifact(env, client, deps).catch((error) => ({
    ok: false,
    reason: 'expected_seo_lookup_failed',
    error: error.message,
  }));

  const drift = compareSeoSnapshot(snapshot, expected);
  if (drift.ok) return [];

  return [{
    type: 'seo_drift_detected',
    severity: drift.severity,
    source: 'seo_drift_monitor',
    client_slug: client.slug || client.client_slug,
    artifact_type: 'seo',
    payload: {
      live_url: liveUrl,
      snapshot,
      expected,
      drift,
    },
    created_at: new Date().toISOString(),
  }];
}

export async function readLiveSeoSnapshot(liveUrl) {
  const homepageUrl = new URL('/', liveUrl).toString();
  const sitemapUrl = new URL('/sitemap.xml', liveUrl).toString();
  const robotsUrl = new URL('/robots.txt', liveUrl).toString();

  const homepage = await fetchText(homepageUrl);
  const html = homepage.text || '';
  const title = extractTitle(html);
  const description = extractMetaDescription(html);
  const canonical = extractCanonical(html);
  const h1 = extractFirstH1(html);
  const sitemap = await fetchStatus(sitemapUrl);
  const robots = await fetchStatus(robotsUrl);

  return {
    ok: homepage.ok,
    checked_at: new Date().toISOString(),
    homepage_url: homepageUrl,
    status: homepage.status || null,
    title,
    meta_description: description,
    canonical,
    h1,
    has_title: title.length >= DEFAULT_MIN_TITLE_LENGTH,
    has_meta_description: description.length >= DEFAULT_MIN_DESCRIPTION_LENGTH,
    has_canonical: Boolean(canonical),
    sitemap_ok: sitemap.ok,
    sitemap_status: sitemap.status || null,
    robots_ok: robots.ok,
    robots_status: robots.status || null,
    error: homepage.error || null,
  };
}

export async function loadExpectedSeoArtifact(env, client = {}, deps = {}) {
  if (!deps.supabase) return { ok: false, reason: 'supabase_not_available' };

  const filters = [];
  if (client.id) filters.push(`client_id=eq.${encodeURIComponent(client.id)}`);
  if (client.slug || client.client_slug) filters.push(`client_slug=eq.${encodeURIComponent(client.slug || client.client_slug)}`);
  if (!filters.length) return { ok: false, reason: 'missing_client_identifier' };

  for (const filter of filters) {
    const res = await deps.supabase(env, 'GET', `/rest/v1/artifact_versions?select=id,artifact_type,artifact_key,version_number,content,metadata,status,is_current_live,published_at,created_at&${filter}&artifact_type=eq.seo&or=(is_current_live.eq.true,status.eq.published,status.eq.approved)&order=is_current_live.desc,published_at.desc.nullslast,created_at.desc&limit=1`);
    if (!res.ok) continue;
    const rows = await res.json();
    if (rows.length) {
      const row = rows[0];
      return {
        ok: true,
        artifact_version_id: row.id,
        artifact_key: row.artifact_key,
        version_number: row.version_number,
        status: row.status,
        title: pickFirst(row.content?.title, row.content?.seo_title, row.content?.meta_title, row.metadata?.title),
        meta_description: pickFirst(row.content?.description, row.content?.meta_description, row.content?.seo_description, row.metadata?.description),
        canonical: pickFirst(row.content?.canonical, row.content?.canonical_url, row.metadata?.canonical),
      };
    }
  }

  return { ok: false, reason: 'no_expected_seo_artifact' };
}

export function compareSeoSnapshot(snapshot = {}, expected = {}) {
  const issues = [];

  if (!snapshot.ok) issues.push({ code: 'homepage_unreachable', severity: 'critical', detail: snapshot.error || snapshot.status || null });
  if (!snapshot.has_title) issues.push({ code: 'title_missing_or_too_short', severity: 'warning' });
  if (!snapshot.has_meta_description) issues.push({ code: 'description_missing_or_too_short', severity: 'warning' });
  if (!snapshot.has_canonical) issues.push({ code: 'canonical_missing', severity: 'warning' });
  if (!snapshot.sitemap_ok) issues.push({ code: 'sitemap_missing_or_unreachable', severity: 'warning', status: snapshot.sitemap_status || null });
  if (!snapshot.robots_ok) issues.push({ code: 'robots_missing_or_unreachable', severity: 'warning', status: snapshot.robots_status || null });

  if (expected?.ok) {
    const expectedTitle = normalizeSeoText(expected.title);
    const liveTitle = normalizeSeoText(snapshot.title);
    const expectedDescription = normalizeSeoText(expected.meta_description);
    const liveDescription = normalizeSeoText(snapshot.meta_description);

    if (expectedTitle && liveTitle && expectedTitle !== liveTitle) {
      issues.push({ code: 'title_drift', severity: 'warning', expected: expected.title, actual: snapshot.title });
    }
    if (expectedDescription && liveDescription && expectedDescription !== liveDescription) {
      issues.push({ code: 'description_drift', severity: 'warning', expected: expected.meta_description, actual: snapshot.meta_description });
    }
  }

  const severity = issues.some((issue) => issue.severity === 'critical') ? 'critical' : issues.length ? 'warning' : 'info';
  return {
    ok: issues.length === 0,
    severity,
    issue_count: issues.length,
    issues,
  };
}

function extractTitle(html) {
  return decodeHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim());
}

function extractMetaDescription(html) {
  const direct = html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i);
  if (direct) return decodeHtml(direct[1].trim());
  const reversed = html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
  return decodeHtml((reversed?.[1] || '').trim());
}

function extractCanonical(html) {
  const direct = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["'][^>]*>/i);
  if (direct) return direct[1].trim();
  const reversed = html.match(/<link\s+[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["'][^>]*>/i);
  return (reversed?.[1] || '').trim();
}

function extractFirstH1(html) {
  return decodeHtml((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (error) {
    return { ok: false, error: error.message, text: '' };
  }
}

async function fetchStatus(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function normalizeSeoText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') || null;
}

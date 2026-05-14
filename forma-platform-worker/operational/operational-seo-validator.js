export async function validateSeoHealth(deployment = {}) {
  const baseUrl = deployment.url || deployment.live_url || deployment.preview_url;
  if (!baseUrl) return { ok: false, reason: 'missing_deployment_url' };

  const homepage = await fetchText(new URL('/', baseUrl).toString());
  const sitemap = await fetchStatus(new URL('/sitemap.xml', baseUrl).toString());
  const robots = await fetchStatus(new URL('/robots.txt', baseUrl).toString());

  const checks = {
    title: /<title>[^<]{5,}<\/title>/i.test(homepage.text || ''),
    meta_description: /<meta\s+[^>]*name=["']description["'][^>]*content=["'][^"']{20,}["']/i.test(homepage.text || ''),
    canonical: /<link\s+[^>]*rel=["']canonical["']/i.test(homepage.text || ''),
    sitemap: sitemap.ok,
    robots: robots.ok,
  };

  return { ok: Object.values(checks).every(Boolean), checks };
}

async function fetchText(url) {
  try {
    const res = await fetch(url);
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (error) {
    return { ok: false, error: error.message, text: '' };
  }
}

async function fetchStatus(url) {
  try {
    const res = await fetch(url);
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function validateRoutes(deployment = {}) {
  const baseUrl = deployment.url || deployment.live_url || deployment.preview_url;
  if (!baseUrl) return { ok: false, reason: 'missing_deployment_url' };

  const routes = deployment.routes || ['/', '/sitemap.xml', '/robots.txt'];
  const results = [];

  for (const route of routes) {
    const url = new URL(route, baseUrl).toString();
    try {
      const res = await fetch(url, { method: 'GET' });
      results.push({ route, status: res.status, ok: res.status >= 200 && res.status < 400 });
    } catch (error) {
      results.push({ route, ok: false, error: error.message });
    }
  }

  return { ok: results.every((r) => r.ok), results };
}

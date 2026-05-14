export async function runSyntheticTests(deployment = {}) {
  const baseUrl = deployment.url || deployment.live_url || deployment.preview_url;
  if (!baseUrl) return { ok: false, reason: 'missing_deployment_url' };

  try {
    const res = await fetch(new URL('/', baseUrl).toString());
    const html = await res.text();
    const checks = {
      homepage_200: res.status >= 200 && res.status < 400,
      has_heading: /<h1[\s>]/i.test(html),
      has_cta_language: /contact|book|call|get started|quote|shop/i.test(html),
    };
    return { ok: Object.values(checks).every(Boolean), checks };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

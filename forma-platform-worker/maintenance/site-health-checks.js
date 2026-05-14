export async function checkSiteReachability(client) {
  if (!client.live_url) return { check: 'site_reachability', status: 'warn', message: 'No live URL configured.' };
  try {
    const res = await fetch(client.live_url, { method: 'GET' });
    return { check: 'site_reachability', status: res.ok ? 'pass' : 'fail', statusCode: res.status };
  } catch (error) {
    return { check: 'site_reachability', status: 'fail', message: error.message };
  }
}

export async function checkBrokenLinksPlaceholder(client) {
  return { check: 'broken_links', status: 'pending', message: 'Wire to crawl adapter link extractor.' };
}

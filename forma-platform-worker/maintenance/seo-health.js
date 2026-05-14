export async function checkSeoBasics(client) {
  return { check: 'seo_basics', status: client.live_url ? 'pending' : 'warn', message: client.live_url ? 'Ready for metadata scan.' : 'No live URL configured.' };
}

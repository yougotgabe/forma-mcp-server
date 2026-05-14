export async function checkSslHealth(client) {
  const url = client.live_url || '';
  if (!url.startsWith('https://')) return { check: 'ssl', status: 'fail', message: 'Live URL is not HTTPS.' };
  return { check: 'ssl', status: 'pass', message: 'HTTPS URL configured.' };
}

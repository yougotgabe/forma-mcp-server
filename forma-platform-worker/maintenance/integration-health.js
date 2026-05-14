export async function checkIntegrationHealth(client) {
  const integrations = client.integrations || [];
  return { check: 'integrations', status: integrations.length ? 'pass' : 'warn', count: integrations.length };
}

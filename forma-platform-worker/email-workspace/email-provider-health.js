export async function checkEmailProviderHealth({ provider }) {
  if (!provider?.name) return { status: 'warn', message: 'No email provider configured.' };
  return { provider: provider.name, status: provider.apiKey ? 'pass' : 'warn', message: provider.apiKey ? 'Provider configured.' : 'Missing provider API key.' };
}

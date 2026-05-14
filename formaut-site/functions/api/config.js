// functions/api/config.js
// Cloudflare Pages Function
//
// Exposes safe public config values to the frontend.
// GOOGLE_CLIENT_ID is a public identifier — safe to return here.
// Never return secrets, keys, or service tokens from this endpoint.

export async function onRequest(context) {
  const { env } = context;

  return new Response(JSON.stringify({
    google_client_id: env.GOOGLE_CLIENT_ID || '',
  }), {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=3600',
    },
  });
}
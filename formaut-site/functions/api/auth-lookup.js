// auth-lookup.js
// Cloudflare Pages Function
//
// Verifies a Google id_token, extracts the email, and looks up the matching
// client record in the platform Supabase.
//
// Uses raw fetch instead of supabase-js createClient — the SDK does not
// correctly handle the new sb_secret_... key format (non-JWT). Raw fetch
// with only the apikey header is what Supabase requires for new-format keys;
// adding an Authorization: Bearer header with a non-JWT value causes 403.

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { token } = await request.json();
    if (!token) return respond({ error: 'Missing token' }, 400);

    // Decode Google JWT payload (no verification here — Google tokeninfo call
    // below is the actual verification step)
    let email;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      email = payload.email?.toLowerCase().trim();
    } catch {
      return respond({ error: 'Malformed token' }, 400);
    }

    if (!email) return respond({ error: 'Invalid token payload' }, 400);

    // ── Verify token with Google ───────────────────────────────────────────────
    const tokenRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${token}`
    );
    if (!tokenRes.ok) return respond({ error: 'Google token verification failed' }, 401);

    const tokenData = await tokenRes.json();
    if (tokenData.aud !== env.GOOGLE_CLIENT_ID) {
      return respond({ error: 'Token audience mismatch' }, 401);
    }

    // Use the verified email from Google, not the decoded payload
    email = (tokenData.email || '').toLowerCase().trim();
    if (!email) return respond({ error: 'No email in verified token' }, 401);

    // ── Lookup client in platform Supabase ────────────────────────────────────
    // Raw fetch — apikey header only. With new sb_secret_... keys, the
    // Supabase gateway translates the apikey to the correct internal JWT.
    // Sending sb_secret_... as Authorization: Bearer causes 403.
    // PostgREST array-contains filter: admin_emails=cs.["email@example.com"]
    const supabaseRes = await fetch(
      `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients` +
      `?admin_emails=cs.{"${email}"}` +
      `&select=*&limit=1`,
      {
        headers: {
          'apikey': env.PLATFORM_SUPABASE_SERVICE_KEY,
          // No Authorization header — Supabase gateway sets it internally
          // from the apikey. Sending sb_secret_... as Bearer causes 403.
        },
      }
    );

    if (!supabaseRes.ok) {
      const raw = await supabaseRes.text();
      return respond({ error: 'Database error', detail: supabaseRes.status, raw }, 500);
    }

    const rows = await supabaseRes.json();
    const client = rows[0];

    if (!client) {
      return respond({ error: 'No Formaut account found for this email' }, 404);
    }

    // ── Return Tier 1 client context ──────────────────────────────────────────
    const isOperator = Boolean(env.OPERATOR_EMAIL && email === env.OPERATOR_EMAIL.toLowerCase().trim());

    return respond({
      email,
      is_operator: isOperator,
      client: {
        name:            client.display_name,
        slug:            client.slug,
        plan:            client.tier,
        status:          client.status,
        live_url:        client.live_url,
        pages_url:       client.pages_url,
        recent_sessions: [],
      },
    });

  } catch (err) {
    return respond({ error: 'Auth failed', message: err.message }, 500);
  }
}

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
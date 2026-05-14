// functions/api/save-credential.js
// Cloudflare Pages Function
//
// The only browser-facing endpoint that handles raw secret values.
// Receives a token from the client dashboard, immediately forwards it to
// the platform Worker /encrypt endpoint (server-to-server), which encrypts
// it and writes it directly to the clients table.
//
// The raw value:
//   - travels over HTTPS only
//   - is never logged
//   - is never written to any database in plaintext
//   - is not included in any response
//   - exists in server memory only for the duration of this function call
//
// What IS stored:
//   - The last 4 characters of the value (hint) — safe to display
//   - A credential_events audit record: who, what field, what action, when
//
// Flow:
//   Browser → POST /api/save-credential { secret_value, field, client_id, action }
//     → verify Google token
//     → POST platform Worker /encrypt { slug, field, plaintext, hint, actor_email, action }
//       → Worker encrypts + writes ciphertext to clients table
//       → Worker writes hint + timestamp to clients hint columns
//       → Worker appends credential_events audit row
//     → return { success: true, field, hint }   (no values, no ciphertext)
//
// action: 'saved' (first time) | 'rolled' (replacing existing) | 'revoked' (clearing)

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return cors(204);
  if (request.method !== 'POST')   return json({ error: 'Method not allowed' }, 405);

  // ── Verify Google token ────────────────────────────────────────────────────
  const authHeader  = request.headers.get('Authorization') || '';
  const googleToken = authHeader.replace('Bearer ', '').trim();
  if (!googleToken) return json({ error: 'Unauthorized' }, 401);

  let verifiedEmail;
  try {
    const tokenRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${googleToken}`
    );
    if (!tokenRes.ok) throw new Error('invalid');
    const td = await tokenRes.json();
    if (td.aud !== env.GOOGLE_CLIENT_ID) throw new Error('audience');
    if (Date.now() / 1000 > parseInt(td.exp, 10)) throw new Error('expired');
    verifiedEmail = td.email;
  } catch {
    return json({ error: 'Authentication failed' }, 401);
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { secret_value, field, client_id, action = 'saved' } = body;

  // Revoke path — no secret_value needed
  const isRevoke = action === 'revoked';

  if (!isRevoke) {
    if (!secret_value || typeof secret_value !== 'string' || !secret_value.trim()) {
      return json({ error: 'secret_value is required' }, 400);
    }
    if (secret_value.length > 8192) {
      return json({ error: 'Value too long — check you pasted the right field' }, 400);
    }
  }

  if (!field || !client_id) {
    return json({ error: 'field and client_id are required' }, 400);
  }

  if (!['saved', 'rolled', 'revoked'].includes(action)) {
    return json({ error: 'action must be saved, rolled, or revoked' }, 400);
  }

  // Whitelist matches exactly what the Worker's ENCRYPTABLE_FIELDS allows
  const ALLOWED_FIELDS = new Set([
    'github_token_enc',
    'cloudflare_token_enc',
    'supabase_mgmt_token_enc',
    'supabase_service_key_enc',
    'supabase_anon_key_enc',
    'printify_key_enc',
  ]);
  if (!ALLOWED_FIELDS.has(field)) {
    return json({ error: `field '${field}' is not a valid credential field` }, 400);
  }

  // ── Confirm this email is authorized for this client ───────────────────────
  const clientRes = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?slug=eq.${encodeURIComponent(client_id)}&select=id,slug,admin_emails&limit=1`,
    { headers: { 'apikey': env.PLATFORM_SUPABASE_SERVICE_KEY } }
  );
  if (!clientRes.ok) return json({ error: 'Could not verify client' }, 502);
  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);

  const clientRecord = clients[0];
  if (!(clientRecord.admin_emails || []).includes(verifiedEmail)) {
    return json({ error: 'Forbidden' }, 403);
  }

  // ── Extract hint — last 4 chars, computed here before forwarding ───────────
  // The hint never enters a log — it's only stored in the hint column and
  // returned to the dashboard so the client can verify they pasted the right key.
  const hint = isRevoke ? null : secret_value.slice(-4);

  // Collect request metadata for audit log — no PII beyond email (already verified)
  const ipAddress = request.headers.get('CF-Connecting-IP') || null;
  const userAgent = (request.headers.get('User-Agent') || '').slice(0, 200);

  // ── Forward to platform Worker /encrypt or /revoke-credential ─────────────
  const workerEndpoint = isRevoke ? '/revoke-credential' : '/encrypt';

  let workerResult;
  try {
    const workerRes = await fetch(`${env.PLATFORM_WORKER_URL}${workerEndpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-worker-secret': env.WORKER_SECRET,
      },
      body: JSON.stringify({
        slug:        clientRecord.slug,
        field,
        plaintext:   isRevoke ? undefined : secret_value,  // raw value — in memory only
        hint,
        actor_email: verifiedEmail,
        action,
        ip_address:  ipAddress,
        user_agent:  userAgent,
      }),
    });

    // secret_value is no longer referenced after this point
    workerResult = await workerRes.json();

    if (!workerRes.ok) {
      console.error('[save-credential] worker failed:', workerRes.status);
      return json({ error: 'Failed to secure credential — please try again' }, 502);
    }
  } catch (err) {
    console.error('[save-credential] worker unreachable:', err.message);
    return json({ error: 'Could not reach encryption service — please try again' }, 502);
  }

  if (!workerResult.ok) {
    return json({ error: workerResult.error || 'Operation failed' }, 502);
  }

  // ── Return success — hint is safe to return, value is not ─────────────────
  return json({
    success:    true,
    field,
    action,
    hint:       isRevoke ? null : `••••${hint}`,
    updated_at: workerResult.updated_at || new Date().toISOString(),
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function cors(status = 204) {
  return new Response(null, {
    status,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

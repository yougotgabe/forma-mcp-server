// functions/api/update-communication-profile.js
// Cloudflare Pages Function
//
// Called at session end by the dashboard to update the client's
// communication profile in their own Supabase. This is the System 2
// write path -- the read path is in chat.js at session start.
//
// Body: {
//   client_id: "slug",
//   profile: {
//     technical_comfort:      "low | medium | high",
//     explanation_depth:      "brief | standard | detailed",
//     tone_preference:        "casual | professional",
//     wants_reasoning:        true | false,
//     confirms_before_acting: true | false,
//     instruction_style:      "sequential | batched",
//     repeated_explanations:  ["topic1", "topic2"],
//     hesitation_points:      ["step1"],
//     demonstrated_skills:    ["skill1"],
//     agent_notes:            "free text",
//     confidence_trend:       "increasing | stable | decreasing | unknown",
//     sessions_observed:      integer
//   }
// }

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return cors(204);
  if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405);

  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader  = request.headers.get('Authorization') || '';
  const googleToken = authHeader.replace('Bearer ', '').trim();
  if (!googleToken) return respond({ error: 'Unauthorized' }, 401);

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
    return respond({ error: 'Authentication failed' }, 401);
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); }
  catch { return respond({ error: 'Invalid JSON' }, 400); }

  const { client_id, profile } = body;
  if (!client_id || !profile) {
    return respond({ error: 'client_id and profile required' }, 400);
  }

  // ── Fetch client record from platform Supabase ─────────────────────────────
  const clientRes = await fetch(
    `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients` +
    `?slug=eq.${encodeURIComponent(client_id)}&select=admin_emails,supabase_url,supabase_service_key_enc&limit=1`,
    {
      headers: { 'apikey': env.PLATFORM_SUPABASE_SERVICE_KEY },
    }
  );
  if (!clientRes.ok) return respond({ error: 'Could not load client record' }, 502);
  const rows = await clientRes.json();
  const client = rows[0];
  if (!client) return respond({ error: 'Client not found' }, 404);

  // Confirm the authenticated user is authorized for this client
  if (!(client.admin_emails || []).includes(verifiedEmail)) {
    return respond({ error: 'Forbidden' }, 403);
  }

  if (!client.supabase_url || !client.supabase_service_key_enc) {
    return respond({ error: 'Client Supabase not configured' }, 422);
  }

  // ── Upsert communication profile in client's Supabase ─────────────────────
  // Singleton table — always upsert the single row using a fixed id approach.
  // We fetch first to get the existing row id (if any), then patch or insert.
  const clientKey = client.supabase_service_key_enc;

  const existingRes = await fetch(
    `${client.supabase_url}/rest/v1/client_communication_profile?select=id&limit=1`,
    {
      headers: { 'apikey': clientKey },
    }
  );

  const safeProfile = sanitizeProfile(profile);

  if (existingRes.ok) {
    const existingRows = await existingRes.json();
    const existing = existingRows[0];

    if (existing) {
      // Update existing row
      const updateRes = await fetch(
        `${client.supabase_url}/rest/v1/client_communication_profile?id=eq.${existing.id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':       clientKey,
            'Content-Type': 'application/json',
            'Prefer':       'return=minimal',
          },
          body: JSON.stringify({ ...safeProfile, updated_at: new Date().toISOString() }),
        }
      );
      if (!updateRes.ok) {
        const err = await updateRes.text();
        return respond({ error: 'Failed to update profile', detail: err }, 500);
      }
    } else {
      // Insert first-ever profile row
      const insertRes = await fetch(
        `${client.supabase_url}/rest/v1/client_communication_profile`,
        {
          method: 'POST',
          headers: {
            'apikey':       clientKey,
            'Content-Type': 'application/json',
            'Prefer':       'return=minimal',
          },
          body: JSON.stringify(safeProfile),
        }
      );
      if (!insertRes.ok) {
        const err = await insertRes.text();
        return respond({ error: 'Failed to create profile', detail: err }, 500);
      }
    }
  } else {
    return respond({ error: 'Could not reach client Supabase' }, 502);
  }

  return respond({ ok: true });
}

// Whitelist and type-check profile fields before writing
function sanitizeProfile(p) {
  const COMFORT_VALUES  = new Set(['low', 'medium', 'high', 'unknown']);
  const DEPTH_VALUES    = new Set(['brief', 'standard', 'detailed']);
  const TONE_VALUES     = new Set(['casual', 'professional']);
  const STYLE_VALUES    = new Set(['sequential', 'batched']);
  const TREND_VALUES    = new Set(['increasing', 'stable', 'decreasing', 'unknown']);

  return {
    technical_comfort:      COMFORT_VALUES.has(p.technical_comfort)  ? p.technical_comfort  : 'unknown',
    explanation_depth:      DEPTH_VALUES.has(p.explanation_depth)    ? p.explanation_depth  : 'standard',
    tone_preference:        TONE_VALUES.has(p.tone_preference)       ? p.tone_preference    : 'casual',
    wants_reasoning:        typeof p.wants_reasoning === 'boolean'   ? p.wants_reasoning    : true,
    confirms_before_acting: typeof p.confirms_before_acting === 'boolean' ? p.confirms_before_acting : false,
    instruction_style:      STYLE_VALUES.has(p.instruction_style)   ? p.instruction_style  : 'sequential',
    repeated_explanations:  Array.isArray(p.repeated_explanations)  ? p.repeated_explanations.slice(0, 20).map(String) : [],
    hesitation_points:      Array.isArray(p.hesitation_points)      ? p.hesitation_points.slice(0, 20).map(String)     : [],
    demonstrated_skills:    Array.isArray(p.demonstrated_skills)    ? p.demonstrated_skills.slice(0, 20).map(String)   : [],
    agent_notes:            typeof p.agent_notes === 'string'        ? p.agent_notes.slice(0, 1000) : null,
    confidence_trend:       TREND_VALUES.has(p.confidence_trend)    ? p.confidence_trend   : 'unknown',
    sessions_observed:      typeof p.sessions_observed === 'number'  ? Math.max(0, Math.floor(p.sessions_observed)) : 0,
  };
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

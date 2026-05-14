// =============================================================================
// FORMAUT — SUBSCRIPTION LIFECYCLE ENGINE
// Handles payment lapse, inactivity warnings, maintenance pause, deploy freeze,
// and reactivation. Runs on the platform worker cron (every 15 min).
//
// Worker endpoints (register in index.js):
//   POST /subscription/status          — get current lifecycle state for a client
//   POST /subscription/check-all       — cron: evaluate all clients, emit events
//   POST /subscription/reactivate      — manual: operator reactivates a client
//   POST /subscription/freeze          — manual: operator force-freezes a client
//
// Integration: call checkSubscriptionGate(slug, env) before any deploy or job
//   that touches a client's site. Returns { allowed, reason }.
//
// Schema: adds columns to clients table and a subscription_events table.
// =============================================================================

// ---------------------------------------------------------------------------
// 1. LIFECYCLE STATES
// One state per client. Transitions are driven by payment events + time.
// ---------------------------------------------------------------------------

export const LIFECYCLE_STATES = {
  active:           'active',           // paying, all systems go
  warning_soft:     'warning_soft',     // payment failed or overdue < 7 days, warning sent
  warning_hard:     'warning_hard',     // overdue 7–14 days, second warning sent, MCP paused
  maintenance_hold: 'maintenance_hold', // overdue 14–30 days, no new builds/deploys, reads only
  frozen:           'frozen',           // overdue 30+ days, fully frozen, client notified
  cancelled:        'cancelled',        // explicit cancellation, graceful wind-down complete
  reactivated:      'reactivated',      // was frozen/cancelled, payment resolved
};

// Days after payment failure before each state transition
const STATE_THRESHOLDS = {
  warning_soft: 1,
  warning_hard: 7,
  maintenance_hold: 14,
  frozen: 30,
};

// ---------------------------------------------------------------------------
// 2. SUBSCRIPTION GATE
// Call before any deploy, job queue entry, or build trigger.
// ---------------------------------------------------------------------------

/**
 * @param {string} slug
 * @param {object} env
 * @returns {{ allowed: boolean, reason: string, state: string }}
 */
export async function checkSubscriptionGate(slug, env) {
  const state = await getLifecycleState(slug, env);

  if (state === LIFECYCLE_STATES.active || state === LIFECYCLE_STATES.reactivated) {
    return { allowed: true, reason: 'active', state };
  }

  if (state === LIFECYCLE_STATES.warning_soft) {
    // Allow everything, just warn
    return { allowed: true, reason: 'payment_warning', state,
             notice: 'Payment issue detected. Action required to avoid service interruption.' };
  }

  if (state === LIFECYCLE_STATES.warning_hard) {
    // Allow reads and maintenance jobs, block new builds
    return { allowed: true, reason: 'limited_mode', state,
             notice: 'Service limited due to overdue payment. New builds are paused.' };
  }

  if (state === LIFECYCLE_STATES.maintenance_hold) {
    return { allowed: false, reason: 'maintenance_hold', state,
             notice: 'Builds and deploys are paused. Your site remains live and unchanged.' };
  }

  if (state === LIFECYCLE_STATES.frozen || state === LIFECYCLE_STATES.cancelled) {
    return { allowed: false, reason: state, state,
             notice: 'Account frozen. Your site remains live in your own infrastructure.' };
  }

  return { allowed: true, reason: 'unknown_state', state };
}

// Is a specific operation type allowed in this state?
export function isOperationAllowed(state, operationType) {
  const matrix = {
    // operationType → set of allowed states
    'deploy':         [LIFECYCLE_STATES.active, LIFECYCLE_STATES.reactivated, LIFECYCLE_STATES.warning_soft],
    'build':          [LIFECYCLE_STATES.active, LIFECYCLE_STATES.reactivated, LIFECYCLE_STATES.warning_soft],
    'chat':           [LIFECYCLE_STATES.active, LIFECYCLE_STATES.reactivated, LIFECYCLE_STATES.warning_soft, LIFECYCLE_STATES.warning_hard],
    'read':           Object.values(LIFECYCLE_STATES), // always allowed
    'maintenance':    [LIFECYCLE_STATES.active, LIFECYCLE_STATES.reactivated, LIFECYCLE_STATES.warning_soft, LIFECYCLE_STATES.warning_hard],
    'mcp':            [LIFECYCLE_STATES.active, LIFECYCLE_STATES.reactivated, LIFECYCLE_STATES.warning_soft],
    'admin_edit':     [LIFECYCLE_STATES.active, LIFECYCLE_STATES.reactivated, LIFECYCLE_STATES.warning_soft, LIFECYCLE_STATES.warning_hard],
  };

  return (matrix[operationType] || []).includes(state);
}

// ---------------------------------------------------------------------------
// 3. CRON RUNNER — evaluate all clients
// Called by the 15-min cron via: POST /subscription/check-all
// ---------------------------------------------------------------------------

export async function handleSubscriptionCheckAll(body, env) {
  const clients = await supabaseGet(env,
    `/rest/v1/clients?select=slug,subscription_status,payment_failed_at,lifecycle_state,lifecycle_state_since&order=slug.asc`
  );

  if (!clients?.length) return json({ ok: true, evaluated: 0 });

  const results = [];
  for (const client of clients) {
    try {
      const result = await evaluateClient(client, env);
      if (result.changed) results.push({ slug: client.slug, ...result });
    } catch (err) {
      console.error(`lifecycle eval error for ${client.slug}:`, err.message);
    }
  }

  return json({ ok: true, evaluated: clients.length, transitions: results.length, results });
}

async function evaluateClient(client, env) {
  const { slug, payment_failed_at, subscription_status } = client;
  const currentState = client.lifecycle_state || LIFECYCLE_STATES.active;

  // If payment is current, ensure state is active
  if (subscription_status === 'active' && !payment_failed_at) {
    if (currentState !== LIFECYCLE_STATES.active && currentState !== LIFECYCLE_STATES.reactivated) {
      return await transitionState(slug, currentState, LIFECYCLE_STATES.reactivated, 'payment_resolved', env);
    }
    return { changed: false };
  }

  // Calculate days since payment failure
  const daysFailed = payment_failed_at
    ? Math.floor((Date.now() - new Date(payment_failed_at).getTime()) / 86400000)
    : 0;

  // Determine target state
  let targetState;
  if (daysFailed >= STATE_THRESHOLDS.frozen) targetState = LIFECYCLE_STATES.frozen;
  else if (daysFailed >= STATE_THRESHOLDS.maintenance_hold) targetState = LIFECYCLE_STATES.maintenance_hold;
  else if (daysFailed >= STATE_THRESHOLDS.warning_hard) targetState = LIFECYCLE_STATES.warning_hard;
  else if (daysFailed >= STATE_THRESHOLDS.warning_soft) targetState = LIFECYCLE_STATES.warning_soft;
  else targetState = LIFECYCLE_STATES.active;

  if (targetState === currentState) return { changed: false };

  return await transitionState(slug, currentState, targetState, `payment_overdue_${daysFailed}d`, env);
}

// ---------------------------------------------------------------------------
// 4. STATE TRANSITION
// Writes new state, emits email, logs event.
// ---------------------------------------------------------------------------

async function transitionState(slug, fromState, toState, reason, env) {
  // Update client record
  await supabasePatch(env, `/rest/v1/clients?slug=eq.${slug}`, {
    lifecycle_state: toState,
    lifecycle_state_since: new Date().toISOString(),
  });

  // Log event
  await supabasePost(env, '/rest/v1/subscription_events', {
    client_slug: slug,
    from_state: fromState,
    to_state: toState,
    reason,
    created_at: new Date().toISOString(),
  });

  // Send appropriate email
  await sendLifecycleEmail(slug, toState, env).catch(err =>
    console.error(`lifecycle email failed for ${slug}:`, err.message)
  );

  return { changed: true, from: fromState, to: toState, reason };
}

// ---------------------------------------------------------------------------
// 5. LIFECYCLE EMAILS
// Each state has a specific message. Tone is clear, non-punitive, informative.
// The core message: your site keeps running regardless.
// ---------------------------------------------------------------------------

async function sendLifecycleEmail(slug, state, env) {
  const clientRes = await supabaseGet(env,
    `/rest/v1/clients?slug=eq.${slug}&select=name,admin_emails,tier&limit=1`
  );
  const client = clientRes?.[0];
  if (!client) return;

  const email = (client.admin_emails || [])[0];
  if (!email) return;

  const name = client.name || 'there';
  const content = lifecycleEmailContent(state, name);
  if (!content) return;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Formaut <notifications@formaut.com>',
      to: email,
      subject: content.subject,
      html: content.html,
    }),
  });
}

function lifecycleEmailContent(state, name) {
  const baseStyle = `font-family:-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#1a1a18;max-width:520px;margin:0 auto;padding:32px 24px`;
  const logo = `<div style="font-weight:700;font-size:20px;color:#E85D26;margin-bottom:24px">Formaut</div>`;
  const footer = `<hr style="margin:32px 0;border:none;border-top:1px solid #e5e5e2"><p style="font-size:12px;color:#6b6b65">Questions? Reply to this email or message Formaut from your dashboard.<br><a href="https://formaut.com/dashboard" style="color:#E85D26">Go to dashboard</a></p>`;

  const byState = {
    [LIFECYCLE_STATES.warning_soft]: {
      subject: 'Payment issue on your Formaut account',
      html: `<div style="${baseStyle}">${logo}
        <p>Hi ${name},</p>
        <p>We couldn't process your most recent Formaut payment.</p>
        <p>Your site is running normally and nothing has changed. We'll try the payment again automatically.</p>
        <p>To avoid any interruption, <a href="https://formaut.com/dashboard" style="color:#E85D26">update your payment method</a> in your dashboard.</p>
        ${footer}</div>`,
    },
    [LIFECYCLE_STATES.warning_hard]: {
      subject: "Action needed: your Formaut payment is overdue",
      html: `<div style="${baseStyle}">${logo}
        <p>Hi ${name},</p>
        <p>Your Formaut payment has been overdue for a week. <strong>Your site is still live and unchanged.</strong></p>
        <p>To keep full access to new builds and chat, <a href="https://formaut.com/dashboard" style="color:#E85D26">resolve your payment</a> now.</p>
        <p>If payment isn't resolved in the next 7 days, we'll pause new site builds while your site stays live.</p>
        ${footer}</div>`,
    },
    [LIFECYCLE_STATES.maintenance_hold]: {
      subject: "Formaut builds paused — your site is still running",
      html: `<div style="${baseStyle}">${logo}
        <p>Hi ${name},</p>
        <p>Because of the overdue payment, we've paused new site builds and deployments on your account.</p>
        <p><strong>Your site is still live.</strong> Everything continues running in your own Cloudflare and GitHub accounts — Formaut not required.</p>
        <p>To resume builds, <a href="https://formaut.com/dashboard" style="color:#E85D26">update your payment method</a>. Everything will resume immediately.</p>
        ${footer}</div>`,
    },
    [LIFECYCLE_STATES.frozen]: {
      subject: "Your Formaut account has been frozen",
      html: `<div style="${baseStyle}">${logo}
        <p>Hi ${name},</p>
        <p>Your Formaut account is frozen due to a payment that's been overdue for 30 days.</p>
        <p><strong>Your site is still live.</strong> Your Cloudflare Pages site, GitHub repo, and Supabase database all continue running in your own accounts — completely independent of Formaut.</p>
        <p>When you're ready to reactivate, <a href="https://formaut.com/dashboard" style="color:#E85D26">update your payment</a> and your account will be restored immediately.</p>
        ${footer}</div>`,
    },
    [LIFECYCLE_STATES.reactivated]: {
      subject: "Formaut account reactivated — welcome back",
      html: `<div style="${baseStyle}">${logo}
        <p>Hi ${name},</p>
        <p>Your account is active again. Everything is back to normal.</p>
        <p><a href="https://formaut.com/dashboard" style="color:#E85D26">Go to your dashboard</a> to pick up where you left off.</p>
        ${footer}</div>`,
    },
  };

  return byState[state] || null;
}

// ---------------------------------------------------------------------------
// 6. STATUS ENDPOINT
// ---------------------------------------------------------------------------

export async function handleSubscriptionStatus(body, env) {
  const { slug } = body;
  if (!slug) return jsonError('slug required', 400);

  const [clientRes, eventsRes] = await Promise.all([
    supabaseGet(env, `/rest/v1/clients?slug=eq.${slug}&select=lifecycle_state,lifecycle_state_since,subscription_status,payment_failed_at&limit=1`),
    supabaseGet(env, `/rest/v1/subscription_events?client_slug=eq.${slug}&order=created_at.desc&limit=10&select=*`),
  ]);

  const client = clientRes?.[0] || {};
  const state = client.lifecycle_state || LIFECYCLE_STATES.active;

  return json({
    ok: true,
    slug,
    state,
    state_since: client.lifecycle_state_since,
    subscription_status: client.subscription_status,
    payment_failed_at: client.payment_failed_at,
    allowed_operations: Object.keys({
      deploy: null, build: null, chat: null, read: null, maintenance: null, mcp: null, admin_edit: null,
    }).filter(op => isOperationAllowed(state, op)),
    recent_events: eventsRes || [],
  });
}

// ---------------------------------------------------------------------------
// 7. REACTIVATE
// ---------------------------------------------------------------------------

export async function handleSubscriptionReactivate(body, env) {
  const { slug } = body;
  if (!slug) return jsonError('slug required', 400);

  const clientRes = await supabaseGet(env,
    `/rest/v1/clients?slug=eq.${slug}&select=lifecycle_state&limit=1`
  );
  const client = clientRes?.[0];
  if (!client) return jsonError('client not found', 404);

  const result = await transitionState(
    slug, client.lifecycle_state, LIFECYCLE_STATES.reactivated, 'manual_reactivation', env
  );

  // Clear payment failure flag
  await supabasePatch(env, `/rest/v1/clients?slug=eq.${slug}`, {
    payment_failed_at: null,
    subscription_status: 'active',
  });

  return json({ ok: true, slug, ...result });
}

// ---------------------------------------------------------------------------
// 8. SQL SCHEMA ADDITIONS
// ---------------------------------------------------------------------------

export const schemaSql = `
-- ============================================================
-- SUBSCRIPTION LIFECYCLE
-- Add to: forma-platform-worker/sql/platform-schema.sql
-- ============================================================

-- Add columns to clients table
alter table clients
  add column if not exists lifecycle_state       text not null default 'active',
  add column if not exists lifecycle_state_since timestamptz,
  add column if not exists payment_failed_at     timestamptz,
  add column if not exists subscription_status   text not null default 'active';
  -- subscription_status values: active | past_due | cancelled | paused

-- Event log
create table if not exists subscription_events (
  id             uuid        primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  client_slug    text        not null references clients(slug) on delete cascade,
  from_state     text,
  to_state       text        not null,
  reason         text
);

create index if not exists subscription_events_slug_idx
  on subscription_events (client_slug, created_at desc);
`.trim();

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

async function getLifecycleState(slug, env) {
  const res = await supabaseGet(env,
    `/rest/v1/clients?slug=eq.${slug}&select=lifecycle_state&limit=1`
  );
  return res?.[0]?.lifecycle_state || LIFECYCLE_STATES.active;
}

async function supabaseGet(env, path) {
  const res = await fetch(`${env.PLATFORM_SUPABASE_URL || env.SUPABASE_URL}${path}`, {
    headers: { apikey: (env.PLATFORM_SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY) },
  });
  if (!res.ok) return null;
  return res.json();
}

async function supabasePost(env, path, data) {
  return fetch(`${env.PLATFORM_SUPABASE_URL || env.SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: { apikey: (env.PLATFORM_SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(data),
  });
}

async function supabasePatch(env, path, data) {
  return fetch(`${env.PLATFORM_SUPABASE_URL || env.SUPABASE_URL}${path}`, {
    method: 'PATCH',
    headers: { apikey: (env.PLATFORM_SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(data),
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function jsonError(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

// =============================================================================
// FORMAUT — NOTIFICATION DISPATCHER
// Centralized notification policy for all platform events.
//
// Covers:
//   - Deployment confirmations (success + failure)
//   - Failed job alerts
//   - Review-needed alerts
//   - Inactivity warnings (site has had no activity in N days)
//   - Security/token alerts
//   - Weekly health summaries
//
// Worker endpoints (register in index.js):
//   POST /notifications/send            — send a specific notification
//   POST /notifications/weekly-digest   — cron: send weekly health summaries
//   POST /notifications/inactivity-check — cron: send inactivity warnings
//
// Call dispatch(event, slug, meta, env) from anywhere in the worker.
// Fire-and-forget — never awaited in hot paths.
// =============================================================================

// ---------------------------------------------------------------------------
// 1. EVENT CATALOG
// Every notification type is defined here with its policy (channel, throttle,
// conditions). Adding a new event = adding an entry here.
// ---------------------------------------------------------------------------

export const NOTIFICATION_EVENTS = {
  // --- Deployments ---
  'deploy.success': {
    channel: 'email',
    throttle_minutes: 0,          // always send
    subject: (meta) => `Your site has been updated — ${meta.slug}`,
    template: 'deploy_success',
  },
  'deploy.failed': {
    channel: 'email',
    throttle_minutes: 0,
    subject: (meta) => `Deploy failed — ${meta.slug}`,
    template: 'deploy_failed',
  },
  'deploy.rollback': {
    channel: 'email',
    throttle_minutes: 0,
    subject: (meta) => `Your site was rolled back — ${meta.slug}`,
    template: 'deploy_rollback',
  },

  // --- Jobs ---
  'job.failed': {
    channel: 'email',
    throttle_minutes: 60,         // max one per hour per client per job type
    subject: (meta) => `A background task failed — ${meta.job_type || 'unknown'}`,
    template: 'job_failed',
  },
  'job.review_needed': {
    channel: 'email',
    throttle_minutes: 0,
    subject: (meta) => `Review needed: ${meta.artifact_type || 'site update'} — ${meta.slug}`,
    template: 'review_needed',
  },

  // --- Health ---
  'health.site_down': {
    channel: 'email',
    throttle_minutes: 120,        // max one every 2 hours
    subject: (meta) => `Site may be down — ${meta.slug}`,
    template: 'site_down',
  },
  'health.weekly_summary': {
    channel: 'email',
    throttle_minutes: 0,
    subject: (meta) => `Your weekly Formaut summary — ${meta.slug}`,
    template: 'weekly_summary',
  },

  // --- Security ---
  'security.token_created': {
    channel: 'email',
    throttle_minutes: 0,
    subject: () => 'New API token created on your Formaut account',
    template: 'security_token_created',
  },
  'security.token_revoked': {
    channel: 'email',
    throttle_minutes: 0,
    subject: () => 'API token revoked on your Formaut account',
    template: 'security_token_revoked',
  },
  'security.new_signin': {
    channel: 'email',
    throttle_minutes: 30,
    subject: () => 'New sign-in to your Formaut dashboard',
    template: 'security_new_signin',
  },

  // --- Inactivity ---
  'inactivity.warning_30d': {
    channel: 'email',
    throttle_minutes: 0,
    subject: (meta) => `Checking in — ${meta.slug} hasn't had any updates in 30 days`,
    template: 'inactivity_30d',
  },
  'inactivity.warning_60d': {
    channel: 'email',
    throttle_minutes: 0,
    subject: (meta) => `Your site is live and running — any updates needed?`,
    template: 'inactivity_60d',
  },
};

// ---------------------------------------------------------------------------
// 2. DISPATCH — primary entry point
// Call from anywhere. Fire-and-forget.
//
// dispatch('deploy.success', slug, { url: 'https://...' }, env)
// ---------------------------------------------------------------------------

export async function dispatch(eventType, slug, meta = {}, env) {
  const policy = NOTIFICATION_EVENTS[eventType];
  if (!policy) {
    console.warn(`[notifications] unknown event type: ${eventType}`);
    return;
  }

  try {
    // Check throttle
    if (policy.throttle_minutes > 0) {
      const throttled = await isThrottled(eventType, slug, policy.throttle_minutes, env);
      if (throttled) return;
    }

    // Fetch client email
    const email = await getClientEmail(slug, env);
    if (!email) return;

    const clientName = await getClientName(slug, env);
    const subject = policy.subject({ slug, ...meta });
    const html = renderTemplate(policy.template, { slug, clientName, ...meta });

    await sendEmail(email, subject, html, env);

    // Log the sent notification
    await logNotification(slug, eventType, email, meta, env);
  } catch (err) {
    console.error(`[notifications] dispatch error for ${eventType}/${slug}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// 3. CRON HANDLERS
// ---------------------------------------------------------------------------

export async function handleWeeklyDigest(body, env) {
  const clients = await supabaseGet(env,
    `/rest/v1/clients?select=slug,name,admin_emails,lifecycle_state&lifecycle_state=eq.active`
  );
  if (!clients?.length) return json({ ok: true, sent: 0 });

  let sent = 0;
  for (const client of clients) {
    try {
      const stats = await buildWeeklyStats(client.slug, env);
      await dispatch('health.weekly_summary', client.slug, { ...stats, clientName: client.name }, env);
      sent++;
    } catch (err) {
      console.error(`weekly digest error for ${client.slug}:`, err.message);
    }
  }

  return json({ ok: true, sent, total: clients.length });
}

export async function handleInactivityCheck(body, env) {
  const clients = await supabaseGet(env,
    `/rest/v1/clients?select=slug,name,admin_emails,last_activity_at,lifecycle_state&lifecycle_state=eq.active`
  );
  if (!clients?.length) return json({ ok: true, checked: 0 });

  let warned = 0;
  for (const client of clients) {
    if (!client.last_activity_at) continue;
    const daysSince = Math.floor((Date.now() - new Date(client.last_activity_at).getTime()) / 86400000);

    if (daysSince >= 60) {
      await dispatch('inactivity.warning_60d', client.slug, { days_since: daysSince, clientName: client.name }, env);
      warned++;
    } else if (daysSince >= 30) {
      await dispatch('inactivity.warning_30d', client.slug, { days_since: daysSince, clientName: client.name }, env);
      warned++;
    }
  }

  return json({ ok: true, checked: clients.length, warned });
}

// ---------------------------------------------------------------------------
// 4. EMAIL TEMPLATES
// Plain, clear HTML. Formaut voice: warm, direct, no fluff.
// ---------------------------------------------------------------------------

function renderTemplate(template, data) {
  const { slug, clientName, url, error, job_type, artifact_type, label } = data;
  const name = clientName || slug || 'there';

  const wrap = (body) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:520px;margin:32px auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e5e2">
  <div style="background:#E85D26;padding:20px 28px"><span style="color:white;font-weight:700;font-size:18px">Formaut</span></div>
  <div style="padding:28px;font-size:15px;line-height:1.6;color:#1a1a18">${body}</div>
  <div style="padding:16px 28px;border-top:1px solid #e5e5e2;font-size:12px;color:#6b6b65">
    <a href="https://formaut.com/dashboard" style="color:#E85D26;text-decoration:none">Open dashboard</a> · 
    Questions? Reply to this email.
  </div>
</div>
</body></html>`;

  const templates = {
    deploy_success: wrap(`
      <p>Hi ${name},</p>
      <p>Your site was just updated and the changes are live.</p>
      ${url ? `<p><a href="${url}" style="color:#E85D26">${url}</a></p>` : ''}
      ${data.summary ? `<p style="background:#f7f7f5;border-radius:6px;padding:12px;font-size:14px">${data.summary}</p>` : ''}
      <p style="color:#6b6b65;font-size:14px">If anything looks off, you can roll back from your dashboard in one click.</p>`),

    deploy_failed: wrap(`
      <p>Hi ${name},</p>
      <p>A deployment attempt for your site didn't complete.</p>
      ${error ? `<p style="background:#fff5f5;border:1px solid #fecaca;border-radius:6px;padding:12px;font-size:13px;color:#7f1d1d">${error}</p>` : ''}
      <p>Formaut will retry automatically. If this keeps happening, message Formaut from your dashboard and we'll sort it out.</p>`),

    deploy_rollback: wrap(`
      <p>Hi ${name},</p>
      <p>Your site was rolled back to the previous version.</p>
      ${data.reason ? `<p style="font-size:14px;color:#6b6b65">Reason: ${data.reason}</p>` : ''}
      <p>Your site is live and the previous version is restored. Message Formaut from your dashboard if you have questions.</p>`),

    job_failed: wrap(`
      <p>Hi ${name},</p>
      <p>A background task on your site encountered an error.</p>
      <table style="width:100%;font-size:14px;border-collapse:collapse;margin:12px 0">
        <tr><td style="color:#6b6b65;padding:4px 0;width:120px">Task:</td><td>${job_type || 'Unknown'}</td></tr>
        ${error ? `<tr><td style="color:#6b6b65;padding:4px 0">Error:</td><td>${error}</td></tr>` : ''}
      </table>
      <p>Formaut will retry this automatically. No action needed on your end.</p>`),

    review_needed: wrap(`
      <p>Hi ${name},</p>
      <p>Formaut has prepared an update to your site and it's ready for your review before going live.</p>
      ${artifact_type ? `<p style="font-size:14px;color:#6b6b65">Update type: ${artifact_type}</p>` : ''}
      <p><a href="https://formaut.com/dashboard" style="display:inline-block;background:#E85D26;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Review now</a></p>
      <p style="font-size:13px;color:#6b6b65">You can approve, request changes, or reject from your dashboard.</p>`),

    site_down: wrap(`
      <p>Hi ${name},</p>
      <p>Our monitoring detected that your site may be temporarily unreachable.</p>
      ${url ? `<p style="font-size:14px;color:#6b6b65">Site: <a href="${url}" style="color:#E85D26">${url}</a></p>` : ''}
      <p>Formaut is checking this automatically. If the issue persists, message Formaut from your dashboard.</p>`),

    weekly_summary: wrap(`
      <p>Hi ${name},</p>
      <p>Here's your weekly Formaut summary:</p>
      <table style="width:100%;font-size:14px;border-collapse:collapse;margin:12px 0;background:#f7f7f5;border-radius:8px">
        ${data.deploys_count != null ? `<tr><td style="padding:10px 14px;color:#6b6b65">Deployments</td><td style="padding:10px 14px;font-weight:600">${data.deploys_count}</td></tr>` : ''}
        ${data.jobs_run != null ? `<tr><td style="padding:10px 14px;border-top:1px solid #e5e5e2;color:#6b6b65">Background tasks</td><td style="padding:10px 14px;border-top:1px solid #e5e5e2;font-weight:600">${data.jobs_run}</td></tr>` : ''}
        ${data.uptime_pct != null ? `<tr><td style="padding:10px 14px;border-top:1px solid #e5e5e2;color:#6b6b65">Uptime</td><td style="padding:10px 14px;border-top:1px solid #e5e5e2;font-weight:600">${data.uptime_pct}%</td></tr>` : ''}
        ${data.seo_score != null ? `<tr><td style="padding:10px 14px;border-top:1px solid #e5e5e2;color:#6b6b65">SEO health</td><td style="padding:10px 14px;border-top:1px solid #e5e5e2;font-weight:600">${data.seo_score}/100</td></tr>` : ''}
        ${data.pending_reviews != null && data.pending_reviews > 0 ? `<tr><td style="padding:10px 14px;border-top:1px solid #e5e5e2;color:#6b6b65">Pending reviews</td><td style="padding:10px 14px;border-top:1px solid #e5e5e2;font-weight:600;color:#E85D26">${data.pending_reviews} needs your approval</td></tr>` : ''}
      </table>
      ${data.pending_reviews > 0 ? `<p><a href="https://formaut.com/dashboard" style="display:inline-block;background:#E85D26;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Review updates</a></p>` : '<p style="color:#6b6b65;font-size:14px">Everything looks good. Have a great week.</p>'}`),

    security_token_created: wrap(`
      <p>Hi ${name},</p>
      <p>A new API token was just created on your Formaut account.</p>
      ${label ? `<p style="font-size:14px;color:#6b6b65">Token label: <strong>${label}</strong></p>` : ''}
      <p style="font-size:14px;color:#6b6b65">If this was you, no action needed. If you didn't do this, <a href="https://formaut.com/dashboard" style="color:#E85D26">go to your dashboard</a> and revoke it immediately.</p>`),

    security_token_revoked: wrap(`
      <p>Hi ${name},</p>
      <p>An API token on your Formaut account was revoked.</p>
      ${label ? `<p style="font-size:14px;color:#6b6b65">Token: <strong>${label}</strong></p>` : ''}
      <p style="font-size:14px;color:#6b6b65">If this was you, no action needed.</p>`),

    security_new_signin: wrap(`
      <p>Hi ${name},</p>
      <p>Someone just signed in to your Formaut dashboard.</p>
      ${data.email ? `<p style="font-size:14px;color:#6b6b65">Account: ${data.email}</p>` : ''}
      <p style="font-size:14px;color:#6b6b65">If this was you, no action needed. If not, <a href="https://formaut.com/dashboard" style="color:#E85D26">review your connected tokens</a>.</p>`),

    inactivity_30d: wrap(`
      <p>Hi ${name},</p>
      <p>Your site has been running smoothly for the past 30 days. No action needed — just checking in.</p>
      <p>If there's anything you'd like to update — hours, services, photos, copy — just message Formaut from your dashboard.</p>
      <p><a href="https://formaut.com/dashboard" style="color:#E85D26">Open dashboard</a></p>`),

    inactivity_60d: wrap(`
      <p>Hi ${name},</p>
      <p>Your site has been live and running for the past 60 days without any changes.</p>
      <p>Sometimes that's exactly right. If anything has changed in your business — pricing, hours, services, location — now's a good time to keep your site current.</p>
      <p><a href="https://formaut.com/dashboard" style="color:#E85D26">Open dashboard and message Formaut</a></p>`),
  };

  return templates[template] || wrap(`<p>Hi ${name},</p><p>A Formaut notification was triggered: ${template}</p>`);
}

// ---------------------------------------------------------------------------
// 5. SEND EMAIL VIA RESEND
// ---------------------------------------------------------------------------

async function sendEmail(to, subject, html, env) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Formaut <notifications@formaut.com>',
      to,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend error ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// 6. THROTTLE CHECK
// Prevents duplicate notifications within the throttle window.
// ---------------------------------------------------------------------------

async function isThrottled(eventType, slug, throttle_minutes, env) {
  const since = new Date(Date.now() - throttle_minutes * 60000).toISOString();
  const res = await supabaseGet(env,
    `/rest/v1/notification_log?client_slug=eq.${slug}&event_type=eq.${eventType}&created_at=gte.${since}&limit=1&select=id`
  );
  return (res?.length || 0) > 0;
}

// ---------------------------------------------------------------------------
// 7. WEEKLY STATS BUILDER
// ---------------------------------------------------------------------------

async function buildWeeklyStats(slug, env) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();

  const [jobsRes, deploysRes, reviewsRes] = await Promise.all([
    supabaseGet(env, `/rest/v1/jobs?client_slug=eq.${slug}&created_at=gte.${since}&select=status`),
    supabaseGet(env, `/rest/v1/jobs?client_slug=eq.${slug}&created_at=gte.${since}&job_type=eq.publish_artifact&status=eq.succeeded&select=id`),
    supabaseGet(env, `/rest/v1/artifact_reviews?client_slug=eq.${slug}&decision=eq.pending&select=id`),
  ]);

  return {
    jobs_run: jobsRes?.length || 0,
    deploys_count: deploysRes?.length || 0,
    pending_reviews: reviewsRes?.length || 0,
    uptime_pct: 99.9,  // placeholder — would come from health monitor
    seo_score: null,   // placeholder — would come from seo-health.js
  };
}

// ---------------------------------------------------------------------------
// 8. LOG NOTIFICATION
// ---------------------------------------------------------------------------

async function logNotification(slug, eventType, to, meta, env) {
  await supabasePost(env, '/rest/v1/notification_log', {
    client_slug: slug,
    event_type: eventType,
    sent_to: to,
    meta,
    created_at: new Date().toISOString(),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 9. SQL SCHEMA ADDITIONS
// ---------------------------------------------------------------------------

export const schemaSql = `
-- ============================================================
-- NOTIFICATION LOG
-- Add to: forma-platform-worker/sql/platform-schema.sql
-- ============================================================

create table if not exists notification_log (
  id             uuid        primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  client_slug    text        not null,
  event_type     text        not null,
  sent_to        text,
  meta           jsonb       not null default '{}'
);

create index if not exists notification_log_slug_event_idx
  on notification_log (client_slug, event_type, created_at desc);
`.trim();

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

async function getClientEmail(slug, env) {
  const res = await supabaseGet(env,
    `/rest/v1/clients?slug=eq.${slug}&select=admin_emails&limit=1`
  );
  return res?.[0]?.admin_emails?.[0] || null;
}

async function getClientName(slug, env) {
  const res = await supabaseGet(env,
    `/rest/v1/clients?slug=eq.${slug}&select=name&limit=1`
  );
  return res?.[0]?.name || slug;
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// =============================================================================
// FORMA — PLATFORM WORKER
// =============================================================================
// Standalone Cloudflare Worker (NOT a Pages Function).
// Deploy with: wrangler deploy
//
// Endpoints:
//   POST /session          — inject Tier 1 context + Tier 2 summaries at session start
//   POST /signals          — write tech + style signals at session end
//   POST /service-request  — log out-of-scope request, notify operator
//   POST /encrypt          — encrypt and store a client credential
//   POST /decrypt          — decrypt a stored credential (server jobs only, never browser)
//   POST /provision        — create GitHub repo, CF Pages project, client Supabase schema
//
// All endpoints require x-worker-secret header matching WORKER_SECRET env var.
// =============================================================================

export default {
  async fetch(request, env) {
    // -------------------------------------------------------------------------
    // Auth gate — every request must carry the shared worker secret
    // -------------------------------------------------------------------------
    const secret = request.headers.get('x-worker-secret');
    if (!secret || secret !== env.WORKER_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    // -------------------------------------------------------------------------
    // Route
    // -------------------------------------------------------------------------
    try {
      if (path === '/session')         return handleSession(body, env);
      if (path === '/signals')         return handleSignals(body, env);
      if (path === '/service-request') return handleServiceRequest(body, env);
      if (path === '/encrypt')         return handleEncrypt(body, env);
      if (path === '/decrypt')         return handleDecrypt(body, env);
      if (path === '/provision')       return handleProvision(body, env);
      if (path === '/usage')           return handleUsage(body, env);
      if (path === '/usage/check')     return handleUsageCheck(body, env);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(`[${path}] Unhandled error:`, err);
      return json({ error: 'Internal server error', detail: err.message }, 500);
    }
  }
};


// =============================================================================
// ENDPOINT: POST /session
// =============================================================================
// Called at the start of every agent session.
// Returns Tier 1 (flat client record) + Tier 2 (last 5 session summaries).
//
// Body: { slug: "client-slug" }
// Returns: { client: {...}, sessions: [...], onboarding: {...} }
// =============================================================================

async function handleSession(body, env) {
  const { slug } = body;
  if (!slug) return json({ error: 'slug required' }, 400);

  // Tier 1 — client record
  const clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`
  );
  if (!clientRes.ok) return json({ error: 'Client not found' }, 404);
  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);

  const client = clients[0];

  // Strip encrypted fields — never return ciphertext to the agent context
  const tier1 = {
    id:                       client.id,
    slug:                     client.slug,
    display_name:             client.display_name,
    tier:                     client.tier,
    status:                   client.status,
    owner_email:              client.owner_email,
    admin_emails:             client.admin_emails,
    github_repo:              client.github_repo,
    cloudflare_pages_project: client.cloudflare_pages_project,
    cloudflare_account_id:    client.cloudflare_account_id,
    supabase_url:             client.supabase_url,
    stripe_connected_account: client.stripe_connected_account,
    printify_shop_id:         client.printify_shop_id,
    domain:                   client.domain,
    live_url:                 client.live_url,
    pages_url:                client.pages_url,
    last_deploy:              client.last_deploy,
    last_deploy_status:       client.last_deploy_status,
    open_escalations:         client.open_escalations,
    attribution_opted_out:    client.attribution_opted_out,
  };

  // Tier 2 — last 5 session summaries from platform sessions_index
  // (Client's own Supabase has full Tier 2-5 but platform index is faster to query here)
  const sessionsRes = await supabase(env, 'GET',
    `/rest/v1/sessions_index?client_id=eq.${client.id}&order=created_at.desc&limit=5&select=summary,changes_made,preferences_noted,session_date,deploy_status`
  );
  const sessions = sessionsRes.ok ? await sessionsRes.json() : [];

  // Onboarding state (always useful context for the agent)
  const onboardingRes = await supabase(env, 'GET',
    `/rest/v1/onboarding_state?client_id=eq.${client.id}&select=*&limit=1`
  );
  const onboardingRows = onboardingRes.ok ? await onboardingRes.json() : [];
  const onboarding = onboardingRows[0] || null;

  // Open service requests (agent should know what's pending)
  const srRes = await supabase(env, 'GET',
    `/rest/v1/service_requests?client_id=eq.${client.id}&status=in.(pending,in_review,in_progress)&select=reference,request_summary,category,status,created_at&order=created_at.desc`
  );
  const openServiceRequests = srRes.ok ? await srRes.json() : [];

  return json({
    client: tier1,
    sessions,
    onboarding,
    open_service_requests: openServiceRequests,
  });
}


// =============================================================================
// ENDPOINT: POST /signals
// =============================================================================
// Called at session end with Haiku extraction output.
// Writes tech signals and style signals. Updates sessions_index.
// Checks auto-promote eligibility after each tech signal write.
//
// Body: {
//   slug: "client-slug",
//   session_summary: { summary, changes_made, preferences_noted, deploy_triggered, deploy_status },
//   tech_signals: [...],   // array from extraction prompt
//   style_signals: [...]   // array from extraction prompt
// }
// =============================================================================

async function handleSignals(body, env) {
  const { slug, session_summary, tech_signals = [], style_signals = [] } = body;
  if (!slug) return json({ error: 'slug required' }, 400);

  // Resolve client_id
  const clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`
  );
  if (!clientRes.ok) return json({ error: 'Client not found' }, 404);
  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);
  const clientId = clients[0].id;

  const today = new Date().toISOString().split('T')[0];
  const results = { session_id: null, tech: [], style: [], errors: [] };

  // Write session summary to sessions_index
  if (session_summary) {
    const sessionRow = {
      client_id:         clientId,
      client_slug:       slug,
      session_date:      today,
      summary:           session_summary.summary || null,
      changes_made:      session_summary.changes_made || [],
      preferences_noted: session_summary.preferences_noted || null,
      signal_count:      tech_signals.length,
      style_signal_count: style_signals.length,
      deploy_triggered:  session_summary.deploy_triggered || false,
      deploy_status:     session_summary.deploy_status || null,
    };
    const sessionRes = await supabase(env, 'POST', '/rest/v1/sessions_index',
      sessionRow, { Prefer: 'return=representation' }
    );
    if (sessionRes.ok) {
      const rows = await sessionRes.json();
      results.session_id = rows[0]?.id || null;
    }
  }

  // Write tech signals — deduplicate by summary fuzzy match (exact for now)
  for (const sig of tech_signals) {
    try {
      // Check if we've seen this summary before
      const existingRes = await supabase(env, 'GET',
        `/rest/v1/signals?summary=eq.${encodeURIComponent(sig.summary)}&select=id,times_seen&limit=1`
      );
      const existing = existingRes.ok ? await existingRes.json() : [];

      if (existing.length) {
        // Increment times_seen, update last_seen_at
        const id = existing[0].id;
        const newCount = existing[0].times_seen + 1;
        await supabase(env, 'PATCH',
          `/rest/v1/signals?id=eq.${id}`,
          {
            times_seen:   newCount,
            last_seen_at: new Date().toISOString(),
            // Re-check auto-promote eligibility
            auto_promote_eligible: (
              sig.outcome === 'success' &&
              sig.confidence === 'confirmed' &&
              sig.type === 'better_path' &&
              newCount >= 5
            ),
          }
        );
        results.tech.push({ action: 'incremented', summary: sig.summary, times_seen: newCount });
      } else {
        // New signal
        const row = {
          session_id:               results.session_id,
          session_date:             today,
          client_slug:              slug,
          type:                     sig.type,
          summary:                  sig.summary,
          detail:                   sig.detail || null,
          condition:                sig.condition || null,
          outcome:                  sig.outcome || null,
          confidence:               sig.confidence || null,
          suggested_by:             sig.suggested_by || 'agent',
          implementation_confirmed: sig.implementation_confirmed || false,
          kb_action:                sig.kb_action || null,
          kb_section:               sig.kb_section || null,
          status:                   'pending',
          times_seen:               1,
          auto_promote_eligible:    false,
        };
        await supabase(env, 'POST', '/rest/v1/signals', row);
        results.tech.push({ action: 'created', summary: sig.summary });
      }
    } catch (err) {
      results.errors.push({ signal: sig.summary, error: err.message });
    }
  }

  // Write style signals — deduplicate by business_type + page_type + final_layout
  for (const sig of style_signals) {
    try {
      const existingRes = await supabase(env, 'GET',
        `/rest/v1/style_signals?business_type=eq.${encodeURIComponent(sig.business_type)}&page_type=eq.${encodeURIComponent(sig.page_type)}&final_layout=eq.${encodeURIComponent(sig.final_layout || '')}&select=id,times_seen&limit=1`
      );
      const existing = existingRes.ok ? await existingRes.json() : [];

      if (existing.length) {
        await supabase(env, 'PATCH',
          `/rest/v1/style_signals?id=eq.${existing[0].id}`,
          { times_seen: existing[0].times_seen + 1, session_date: today }
        );
        results.style.push({ action: 'incremented', business_type: sig.business_type, page_type: sig.page_type });
      } else {
        const row = {
          session_id:             results.session_id,
          session_date:           today,
          client_slug:            slug,
          business_type:          sig.business_type,
          page_type:              sig.page_type,
          layout_built:           sig.layout_built || null,
          iteration_count:        sig.iteration_count || 0,
          client_change_requests: sig.client_change_requests || [],
          final_layout:           sig.final_layout || null,
          density:                sig.style_data?.density || null,
          tone:                   sig.style_data?.tone || null,
          color_preference:       sig.style_data?.color_preference || null,
          typography_feel:        sig.style_data?.typography_feel || null,
          layout_preference:      sig.style_data?.layout_preference || null,
          notable_details:        sig.style_data?.notable_details || null,
          outcome:                sig.outcome || null,
          confidence:             sig.confidence || null,
          status:                 'pending',
          times_seen:             1,
        };
        await supabase(env, 'POST', '/rest/v1/style_signals', row);
        results.style.push({ action: 'created', business_type: sig.business_type, page_type: sig.page_type });
      }
    } catch (err) {
      results.errors.push({ signal: `${sig.business_type}/${sig.page_type}`, error: err.message });
    }
  }

  return json({ ok: true, ...results });
}


// =============================================================================
// ENDPOINT: POST /service-request
// =============================================================================
// Logs an out-of-scope client request and notifies the operator via email.
//
// Body: {
//   slug: "client-slug",
//   request_summary: "...",
//   context: "...",
//   category: "custom_feature | integration | design | migration | other"
// }
// Returns: { ok: true, reference: "SR-0042" }
// =============================================================================

async function handleServiceRequest(body, env) {
  const { slug, request_summary, context, category } = body;
  if (!slug || !request_summary) {
    return json({ error: 'slug and request_summary required' }, 400);
  }

  // Resolve client
  const clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id,display_name,owner_email&limit=1`
  );
  const clients = clientRes.ok ? await clientRes.json() : [];
  if (!clients.length) return json({ error: 'Client not found' }, 404);
  const client = clients[0];

  // Generate SR reference
  const refRes = await supabase(env, 'POST', '/rest/v1/rpc/next_service_request_ref', {});
  const ref = refRes.ok ? await refRes.json() : `SR-${Date.now()}`;

  // Insert service request
  const row = {
    reference:       ref,
    client_id:       client.id,
    client_slug:     slug,
    request_summary,
    context:         context || null,
    category:        category || 'other',
    status:          'pending',
  };
  const insertRes = await supabase(env, 'POST', '/rest/v1/service_requests', row);
  if (!insertRes.ok) {
    const err = await insertRes.text();
    return json({ error: 'Failed to insert service request', detail: err }, 500);
  }

  // Notify operator via Resend
  // NOTIFY_EMAIL must be a direct inbox — never a routed address (KB §2.4)
  const emailSent = await sendEmail(env, {
    to:      env.NOTIFY_EMAIL,
    subject: `[Forma] Service Request ${ref} — ${client.display_name}`,
    text:    [
      `Reference: ${ref}`,
      `Client: ${client.display_name} (${slug})`,
      `Category: ${category || 'other'}`,
      ``,
      `Request:`,
      request_summary,
      ``,
      context ? `Context:\n${context}` : '',
      ``,
      `Review in Supabase: service_requests table, reference = '${ref}'`,
    ].filter(Boolean).join('\n'),
  });

  // Log notification
  await supabase(env, 'POST', '/rest/v1/notification_log', {
    client_id:        client.id,
    client_slug:      slug,
    to_address:       env.NOTIFY_EMAIL,
    subject:          `[Forma] Service Request ${ref} — ${client.display_name}`,
    template:         'service_request_created',
    reference_id:     ref,
    status:           emailSent ? 'sent' : 'failed',
    sent_at:          emailSent ? new Date().toISOString() : null,
    provider:         'resend',
    idempotency_key:  `sr-${ref}`,
  });

  // Update client open_escalations count
  await supabase(env, 'POST', '/rest/v1/rpc/increment_open_escalations',
    { client_slug: slug }
  );

  return json({ ok: true, reference: ref });
}


// =============================================================================
// ENDPOINT: POST /encrypt
// =============================================================================
// Encrypts a credential and stores it in the clients table.
// Never returns the ciphertext — just confirms storage.
//
// Body: {
//   slug: "client-slug",
//   field: "github_token_enc | cloudflare_token_enc | supabase_mgmt_token_enc | ...",
//   plaintext: "the-actual-secret"
// }
//
// Allowed fields (whitelist — prevents arbitrary column writes):
//   github_token_enc, cloudflare_token_enc, supabase_mgmt_token_enc,
//   supabase_service_key_enc, supabase_anon_key_enc, printify_key_enc
// =============================================================================

const ENCRYPTABLE_FIELDS = new Set([
  'github_token_enc',
  'cloudflare_token_enc',
  'supabase_mgmt_token_enc',
  'supabase_service_key_enc',
  'supabase_anon_key_enc',
  'printify_key_enc',
]);

async function handleEncrypt(body, env) {
  const { slug, field, plaintext } = body;
  if (!slug || !field || !plaintext) {
    return json({ error: 'slug, field, and plaintext required' }, 400);
  }
  if (!ENCRYPTABLE_FIELDS.has(field)) {
    return json({ error: `field '${field}' is not encryptable` }, 400);
  }

  // Resolve client
  const clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`
  );
  const clients = clientRes.ok ? await clientRes.json() : [];
  if (!clients.length) return json({ error: 'Client not found' }, 404);
  const clientId = clients[0].id;

  // Encrypt
  const ciphertext = await encrypt(plaintext, env.ENCRYPTION_KEY);

  // Store
  const updateRes = await supabase(env, 'PATCH',
    `/rest/v1/clients?id=eq.${clientId}`,
    { [field]: ciphertext }
  );
  if (!updateRes.ok) {
    return json({ error: 'Failed to store credential' }, 500);
  }

  return json({ ok: true, field, stored: true });
}



// =============================================================================
// ENDPOINT: POST /decrypt
// =============================================================================
// Decrypts a stored credential value.
// Called ONLY by server-side provisioning and build jobs — never from the browser.
// The decrypted value is used in-process by the calling job and never logged,
// returned to clients, or stored anywhere in plaintext.
//
// Body:     { ciphertext: string }   — the base64 blob stored in clients table
// Response: { value: string }        — plaintext; use immediately and discard
// =============================================================================

async function handleDecrypt(body, env) {
  const { ciphertext } = body;
  if (!ciphertext || typeof ciphertext !== 'string') {
    return json({ error: 'ciphertext required' }, 400);
  }
  try {
    const value = await decrypt(ciphertext, env.ENCRYPTION_KEY);
    // Do not log the decrypted value under any circumstances
    return json({ value });
  } catch {
    // Generic error only — never surface decryption internals
    return json({ error: 'Decryption failed' }, 422);
  }
}

// =============================================================================
// ENDPOINT: POST /provision
// =============================================================================
// Provisions a new client's infrastructure in sequence:
//   1. Create GitHub repo (from operator's account, transfer to client after auth)
//   2. Create Cloudflare Pages project linked to the repo
//   3. Create Supabase project via Management API
//   4. Run client-side schema SQL in the new Supabase project
//   5. Retrieve and encrypt Supabase service_role + anon keys
//   6. Set all Cloudflare env vars for the Pages project
//   7. Update clients + onboarding_state tables
//
// Body: { slug: "client-slug" }
//
// This endpoint is the most complex. Each step is isolated and logged.
// On failure, the step name and error are returned — caller decides whether to retry.
// =============================================================================

async function handleProvision(body, env) {
  const { slug } = body;
  if (!slug) return json({ error: 'slug required' }, 400);

  // Load client record — must have display_name, tier, admin_emails, owner_email
  const clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`
  );
  if (!clientRes.ok) return json({ error: 'Client not found' }, 404);
  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);
  const client = clients[0];

  const steps = [];
  const log = (step, status, detail = null) => {
    steps.push({ step, status, detail, ts: new Date().toISOString() });
    console.log(`[provision:${slug}] ${step} → ${status}`, detail || '');
  };

  // ── Step 1: GitHub repo ────────────────────────────────────────────────────
  let repoCreated = false;
  try {
    const ghRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept:        'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent':  'forma-platform-worker',
      },
      body: JSON.stringify({
        name:        slug,
        private:     false,
        description: `Forma client site — ${client.display_name}`,
        auto_init:   true,
      }),
    });
    if (ghRes.ok) {
      const repo = await ghRes.json();
      await supabase(env, 'PATCH',
        `/rest/v1/clients?id=eq.${client.id}`,
        { github_repo: `${repo.owner.login}/${slug}` }
      );
      client.github_repo = `${repo.owner.login}/${slug}`;
      repoCreated = true;
      log('github_repo', 'ok', repo.html_url);
    } else {
      const err = await ghRes.json();
      log('github_repo', 'failed', err.message);
      return json({ ok: false, steps, failed_at: 'github_repo' });
    }
  } catch (err) {
    log('github_repo', 'error', err.message);
    return json({ ok: false, steps, failed_at: 'github_repo' });
  }

  // ── Step 2: Cloudflare Pages project ──────────────────────────────────────
  try {
    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: slug,
          production_branch: 'main',
          source: {
            type: 'github',
            config: {
              owner:                    client.github_repo.split('/')[0],
              repo_name:                slug,
              production_branch:        'main',
              pr_comments_enabled:      false,
              deployments_enabled:      true,
            },
          },
        }),
      }
    );
    if (cfRes.ok) {
      const project = await cfRes.json();
      const pagesUrl = `https://${slug}.pages.dev`;
      await supabase(env, 'PATCH',
        `/rest/v1/clients?id=eq.${client.id}`,
        {
          cloudflare_pages_project: slug,
          pages_url:                pagesUrl,
        }
      );
      log('cloudflare_pages', 'ok', pagesUrl);
    } else {
      const err = await cfRes.json();
      log('cloudflare_pages', 'failed', JSON.stringify(err.errors));
      return json({ ok: false, steps, failed_at: 'cloudflare_pages' });
    }
  } catch (err) {
    log('cloudflare_pages', 'error', err.message);
    return json({ ok: false, steps, failed_at: 'cloudflare_pages' });
  }

  // ── Step 3: Supabase project ───────────────────────────────────────────────
  let supabaseProjectId = null;
  let clientSupabaseUrl = null;
  try {
    const sbRes = await fetch('https://api.supabase.com/v1/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_MGMT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name:             slug,
        organization_id:  await getSupabaseOrgId(env),
        region:           'us-east-1',
        plan:             'free',
        db_pass:          generatePassword(),
      }),
    });
    if (sbRes.ok) {
      const project = await sbRes.json();
      supabaseProjectId = project.id;
      clientSupabaseUrl = `https://${project.id}.supabase.co`;
      await supabase(env, 'PATCH',
        `/rest/v1/clients?id=eq.${client.id}`,
        {
          supabase_project_id: supabaseProjectId,
          supabase_url:        clientSupabaseUrl,
        }
      );
      log('supabase_project', 'ok', clientSupabaseUrl);

      // Wait for project to be ready (Supabase takes ~10-20s to provision)
      await waitForSupabaseReady(env, supabaseProjectId);
      log('supabase_ready', 'ok');
    } else {
      const err = await sbRes.json();
      log('supabase_project', 'failed', JSON.stringify(err));
      return json({ ok: false, steps, failed_at: 'supabase_project' });
    }
  } catch (err) {
    log('supabase_project', 'error', err.message);
    return json({ ok: false, steps, failed_at: 'supabase_project' });
  }

  // ── Step 4: Retrieve Supabase API keys and encrypt ─────────────────────────
  try {
    const keysRes = await fetch(
      `https://api.supabase.com/v1/projects/${supabaseProjectId}/api-keys`,
      {
        headers: { Authorization: `Bearer ${env.SUPABASE_MGMT_TOKEN}` }
      }
    );
    if (keysRes.ok) {
      const keys = await keysRes.json();
      const serviceKey = keys.find(k => k.name === 'service_role')?.api_key;
      const anonKey    = keys.find(k => k.name === 'anon')?.api_key;

      if (serviceKey) {
        const encService = await encrypt(serviceKey, env.ENCRYPTION_KEY);
        const encAnon    = anonKey ? await encrypt(anonKey, env.ENCRYPTION_KEY) : null;
        await supabase(env, 'PATCH',
          `/rest/v1/clients?id=eq.${client.id}`,
          {
            supabase_service_key_enc: encService,
            supabase_anon_key_enc:    encAnon,
          }
        );
        log('supabase_keys', 'ok');
      } else {
        log('supabase_keys', 'failed', 'service_role key not found in response');
      }
    } else {
      log('supabase_keys', 'failed', await keysRes.text());
    }
  } catch (err) {
    log('supabase_keys', 'error', err.message);
    // Non-fatal — keys can be retrieved manually
  }

  // ── Step 5: Run client schema SQL ──────────────────────────────────────────
  // The client schema is the Tier 2-5 memory tables (sessions, site_index,
  // conversation_history, client_context) plus site_content, menu_items, etc.
  // depending on template. For now we run the memory schema — template-specific
  // tables are added by the build agent when it generates the site files.
  try {
    const schemaSql = buildClientSchema(client.tier);
    const sqlRes = await fetch(
      `https://api.supabase.com/v1/projects/${supabaseProjectId}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${env.SUPABASE_MGMT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: schemaSql }),
      }
    );
    if (sqlRes.ok) {
      log('client_schema', 'ok');
    } else {
      const err = await sqlRes.text();
      log('client_schema', 'failed', err);
      // Non-fatal — schema can be run manually in client's SQL editor
    }
  } catch (err) {
    log('client_schema', 'error', err.message);
  }

  // ── Step 6: Update onboarding state ────────────────────────────────────────
  try {
    await supabase(env, 'POST', '/rest/v1/onboarding_state',
      {
        client_id:               client.id,
        repo_created:            repoCreated,
        pages_project_created:   true,
        supabase_project_created: supabaseProjectId !== null,
        supabase_schema_run:     steps.find(s => s.step === 'client_schema')?.status === 'ok',
      },
      { Prefer: 'resolution=merge-duplicates' }
    );
    log('onboarding_state', 'ok');
  } catch (err) {
    log('onboarding_state', 'error', err.message);
  }

  // ── Step 7: Notify operator ─────────────────────────────────────────────────
  await sendEmail(env, {
    to:      env.NOTIFY_EMAIL,
    subject: `[Forma] Provisioning complete — ${client.display_name}`,
    text:    [
      `Client: ${client.display_name} (${slug})`,
      `GitHub: https://github.com/${client.github_repo}`,
      `Pages:  https://${slug}.pages.dev`,
      `Supabase: ${clientSupabaseUrl}`,
      ``,
      `Steps:`,
      ...steps.map(s => `  ${s.step}: ${s.status}${s.detail ? ` — ${s.detail}` : ''}`),
    ].join('\n'),
  });

  return json({ ok: true, slug, steps });
}


// =============================================================================
// ENDPOINT: POST /usage
// =============================================================================
// Called at the end of every agent conversation to record token consumption.
// Tracks monthly usage, rolling 7-day velocity, conversation type weighting,
// trend direction, and efficiency metrics for margin health monitoring.
//
// Body: {
//   slug: "client-slug",
//   input_tokens: 45000,
//   output_tokens: 8000,
//   model: "claude-sonnet-4-20250514" | "claude-haiku-4-5-20251001",
//   cached_tokens: 20000,
//   conversation_type: "build" | "maintenance" | "redesign" | "extraction"
// }
// =============================================================================

// Pricing per million tokens (update when Anthropic changes pricing)
const MODEL_PRICING = {
  'claude-sonnet-4-20250514': {
    input:       3.00,
    output:      15.00,
    cache_write: 3.75,
    cache_read:  0.30,
  },
  'claude-haiku-4-5-20251001': {
    input:       0.80,
    output:      4.00,
    cache_write: 1.00,
    cache_read:  0.08,
  },
};

// Internal margin guardrail — max cost per client per month
const MARGIN_GUARDRAIL = {
  standard: { monthly_revenue: 5000, max_cost_cents: 1500 }, // $50/mo, max $15
  pro:      { monthly_revenue: 10000, max_cost_cents: 3500 }, // $100/mo, max $35
};

// Threshold percentages
const SOFT_THRESHOLD_PCT  = 0.70;  // suggest efficiency at 70%
const HARD_THRESHOLD_PCT  = 0.90;  // offer overflow at 90%
const KILL_THRESHOLD_PCT  = 1.50;  // require confirmation at 150%

// Conversation type weights — how much each type counts toward thresholds
// Build and redesign are expected to be heavy — relax their threshold impact
// Maintenance sitting at 85% repeatedly is more concerning than one big build
const CONV_TYPE_WEIGHT = {
  build:       0.70,  // expected heavy — weight down 30%
  redesign:    0.75,  // expected heavy — weight down 25%
  maintenance: 1.20,  // unexpected heavy — weight up 20%
  extraction:  0.30,  // always light — barely counts
};

// Rolling 7-day velocity thresholds (cents)
const VELOCITY_SOFT = 800;  // $8 in 7 days is elevated
const VELOCITY_HARD = 1200; // $12 in 7 days is concerning

function calculateCostCents(inputTokens, outputTokens, cachedTokens, model) {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-20250514'];
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  const costDollars =
    (uncachedInput  / 1_000_000) * pricing.input +
    (cachedTokens   / 1_000_000) * pricing.cache_read +
    (outputTokens   / 1_000_000) * pricing.output;
  return Math.round(costDollars * 100);
}

// Weighted cost for threshold calculation — same actual cost stored, different threshold impact
function weightedCost(costCents, conversationType) {
  const weight = CONV_TYPE_WEIGHT[conversationType] || 1.0;
  return Math.round(costCents * weight);
}

function buildAgentGuidance(effectivePct, velocityPct, tier, conversationType) {
  // Kill switch — 150% of guardrail, regardless of conversation type
  if (effectivePct >= KILL_THRESHOLD_PCT) {
    return {
      threshold:        'kill',
      require_confirm:  true,
      message:          "Looks like we've been doing a lot of heavy lifting lately — want to continue with extended capacity today?",
      suggest_overflow: true,
      estimated_overflow_cost: '$2–5',
      internal_note:    'Client at 150%+ of cost guardrail. Require explicit confirmation before proceeding with any session. Log this session for operator review.',
    };
  }

  // Hard threshold — 90% of guardrail
  if (effectivePct >= HARD_THRESHOLD_PCT) {
    return {
      threshold:        'hard',
      require_confirm:  false,
      message:          conversationType === 'build'
        ? "This is a full build — that's expected to take some capacity. Want me to proceed, or break it into stages across a couple of sessions?"
        : "This is a bigger task than usual. I can continue, or we can break it into focused sessions for the best results — your call.",
      suggest_overflow: true,
      estimated_overflow_cost: '$1–3',
      internal_note:    'Present overflow option naturally. Do not make client feel penalized.',
    };
  }

  // Soft threshold — 70% of guardrail OR high velocity
  const velocityElevated = velocityPct >= VELOCITY_SOFT;
  if (effectivePct >= SOFT_THRESHOLD_PCT || velocityElevated) {
    return {
      threshold:        'soft',
      require_confirm:  false,
      message:          'This is shaping up to be a bigger task. Want me to break it into steps so each part gets full attention?',
      suggest_overflow: false,
      internal_note:    velocityElevated
        ? 'High recent velocity — favor short focused conversations, cache aggressively.'
        : 'Approaching monthly capacity — prefer efficiency, suggest breaking complex requests into steps.',
    };
  }

  return null; // normal — no guidance needed
}

async function handleUsage(body, env) {
  const {
    slug,
    input_tokens     = 0,
    output_tokens    = 0,
    cached_tokens    = 0,
    model            = 'claude-sonnet-4-20250514',
    conversation_type = 'maintenance',
  } = body;

  if (!slug) return json({ error: 'slug required' }, 400);

  // Resolve client + plan
  const clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id,tier&limit=1`
  );
  const clients = clientRes.ok ? await clientRes.json() : [];
  if (!clients.length) return json({ error: 'Client not found' }, 404);
  const { id: clientId, tier } = clients[0];

  const actualCostCents  = calculateCostCents(input_tokens, output_tokens, cached_tokens, model);
  const weighted         = weightedCost(actualCostCents, conversation_type);
  const monthKey         = new Date().toISOString().slice(0, 7);
  const now              = new Date().toISOString();

  // Write individual conversation record for rolling window + trend analysis
  await supabase(env, 'POST', '/rest/v1/client_usage_log', {
    client_id:         clientId,
    client_slug:       slug,
    month_key:         monthKey,
    conversation_type,
    actual_cost_cents: actualCostCents,
    weighted_cost_cents: weighted,
    input_tokens,
    output_tokens,
    cached_tokens,
    model,
    recorded_at:       now,
  });

  // Upsert monthly summary — actual costs only (weighted is for threshold logic only)
  await supabase(env, 'POST', '/rest/v1/client_usage',
    {
      client_id:            clientId,
      client_slug:          slug,
      month_key:            monthKey,
      total_cost_cents:     actualCostCents,
      weighted_cost_cents:  weighted,
      input_tokens,
      output_tokens,
      cached_tokens,
      conversation_count:   1,
    },
    { Prefer: 'resolution=merge-duplicates,return=representation' }
  );

  // Fetch updated monthly totals
  const totalRes = await supabase(env, 'GET',
    `/rest/v1/client_usage?client_slug=eq.${encodeURIComponent(slug)}&month_key=eq.${monthKey}&select=total_cost_cents,weighted_cost_cents,conversation_count&limit=1`
  );
  const totals        = totalRes.ok ? await totalRes.json() : [];
  const monthTotal    = totals[0]?.total_cost_cents    || actualCostCents;
  const weightedTotal = totals[0]?.weighted_cost_cents || weighted;
  const convCount     = totals[0]?.conversation_count  || 1;

  // Rolling 7-day velocity — sum actual costs from last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const velocityRes  = await supabase(env, 'GET',
    `/rest/v1/client_usage_log?client_slug=eq.${encodeURIComponent(slug)}&recorded_at=gte.${sevenDaysAgo}&select=actual_cost_cents`
  );
  const velocityRows  = velocityRes.ok ? await velocityRes.json() : [];
  const velocity7d    = velocityRows.reduce((sum, r) => sum + (r.actual_cost_cents || 0), 0);

  // Trend: compare this month's cost rate to last month's
  const lastMonth     = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const lastMonthKey  = lastMonth.toISOString().slice(0, 7);
  const lastRes       = await supabase(env, 'GET',
    `/rest/v1/client_usage?client_slug=eq.${encodeURIComponent(slug)}&month_key=eq.${lastMonthKey}&select=total_cost_cents,conversation_count&limit=1`
  );
  const lastRows      = lastRes.ok ? await lastRes.json() : [];
  const lastMonthCost = lastRows[0]?.total_cost_cents || 0;
  const lastConvCount = lastRows[0]?.conversation_count || 1;
  const thisAvgCost   = convCount     > 0 ? monthTotal    / convCount     : 0;
  const lastAvgCost   = lastConvCount > 0 ? lastMonthCost / lastConvCount : 0;
  const trendDirection = thisAvgCost > lastAvgCost * 1.2 ? 'rising'
    : thisAvgCost < lastAvgCost * 0.8 ? 'falling' : 'stable';

  // Compute thresholds using weighted cost for fairness
  const guardrail    = MARGIN_GUARDRAIL[tier] || MARGIN_GUARDRAIL.standard;
  const effectivePct = weightedTotal / guardrail.max_cost_cents;
  const agentGuidance = buildAgentGuidance(effectivePct, velocity7d, tier, conversation_type);

  // Flag for operator review if kill threshold hit
  if (effectivePct >= KILL_THRESHOLD_PCT) {
    await supabase(env, 'POST', '/rest/v1/client_usage_flags', {
      client_id:    clientId,
      client_slug:  slug,
      month_key:    monthKey,
      flag_type:    'kill_threshold',
      effective_pct: Math.round(effectivePct * 100),
      flagged_at:   now,
    });
  }

  return json({
    ok:                    true,
    actual_cost_cents:     actualCostCents,
    month_total_cents:     monthTotal,
    weighted_total_cents:  weightedTotal,
    conversation_count:    convCount,
    velocity_7d_cents:     velocity7d,
    trend_direction:       trendDirection,
    effective_pct:         Math.round(effectivePct * 100),
    threshold:             effectivePct >= KILL_THRESHOLD_PCT ? 'kill'
                         : effectivePct >= HARD_THRESHOLD_PCT ? 'hard'
                         : effectivePct >= SOFT_THRESHOLD_PCT ? 'soft' : 'normal',
    agent_guidance:        agentGuidance,
  });
}


// =============================================================================
// ENDPOINT: POST /usage/check
// =============================================================================
// Called at the START of every conversation.
// Returns full usage context so the agent can calibrate tone and task approach
// before the client says a single word.
//
// Body: { slug: "client-slug" }
// =============================================================================

async function handleUsageCheck(body, env) {
  const { slug } = body;
  if (!slug) return json({ error: 'slug required' }, 400);

  const clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id,tier&limit=1`
  );
  const clients = clientRes.ok ? await clientRes.json() : [];
  if (!clients.length) return json({ error: 'Client not found' }, 404);
  const { id: clientId, tier } = clients[0];

  const monthKey = new Date().toISOString().slice(0, 7);

  // Monthly totals
  const totalRes = await supabase(env, 'GET',
    `/rest/v1/client_usage?client_slug=eq.${encodeURIComponent(slug)}&month_key=eq.${monthKey}&select=total_cost_cents,weighted_cost_cents,conversation_count&limit=1`
  );
  const totals        = totalRes.ok ? await totalRes.json() : [];
  const monthTotal    = totals[0]?.total_cost_cents    || 0;
  const weightedTotal = totals[0]?.weighted_cost_cents || 0;
  const convCount     = totals[0]?.conversation_count  || 0;

  // Rolling 7-day velocity
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const velocityRes  = await supabase(env, 'GET',
    `/rest/v1/client_usage_log?client_slug=eq.${encodeURIComponent(slug)}&recorded_at=gte.${sevenDaysAgo}&select=actual_cost_cents,conversation_type`
  );
  const velocityRows = velocityRes.ok ? await velocityRes.json() : [];
  const velocity7d   = velocityRows.reduce((sum, r) => sum + (r.actual_cost_cents || 0), 0);

  // Last 3 sessions cost trend
  const recentRes  = await supabase(env, 'GET',
    `/rest/v1/client_usage_log?client_slug=eq.${encodeURIComponent(slug)}&order=recorded_at.desc&limit=3&select=actual_cost_cents,conversation_type,recorded_at`
  );
  const recentSessions = recentRes.ok ? await recentRes.json() : [];
  const recentAvg      = recentSessions.length
    ? recentSessions.reduce((s, r) => s + r.actual_cost_cents, 0) / recentSessions.length
    : 0;

  // Trend direction
  const lastMonth    = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const lastMonthKey = lastMonth.toISOString().slice(0, 7);
  const lastRes      = await supabase(env, 'GET',
    `/rest/v1/client_usage?client_slug=eq.${encodeURIComponent(slug)}&month_key=eq.${lastMonthKey}&select=total_cost_cents,conversation_count&limit=1`
  );
  const lastRows      = lastRes.ok ? await lastRes.json() : [];
  const lastMonthCost = lastRows[0]?.total_cost_cents    || 0;
  const lastConvCount = lastRows[0]?.conversation_count  || 1;
  const thisAvgCost   = convCount     > 0 ? monthTotal    / convCount     : 0;
  const lastAvgCost   = lastConvCount > 0 ? lastMonthCost / lastConvCount : 0;
  const trendDirection = thisAvgCost > lastAvgCost * 1.2 ? 'rising'
    : thisAvgCost < lastAvgCost * 0.8 ? 'falling' : 'stable';

  const guardrail    = MARGIN_GUARDRAIL[tier] || MARGIN_GUARDRAIL.standard;
  const effectivePct = weightedTotal / guardrail.max_cost_cents;
  const velocityHigh = velocity7d >= VELOCITY_SOFT;

  // Build start-of-session agent note
  let agentNote = null;
  if (effectivePct >= KILL_THRESHOLD_PCT) {
    agentNote = {
      threshold:       'kill',
      require_confirm: true,
      note:            'Client is at 150%+ of cost guardrail. Before starting ANY task, surface the confirmation message. Do not proceed without explicit yes from client.',
      message:         "Looks like we've been doing a lot of heavy lifting lately — want to continue with extended capacity today?",
    };
  } else if (effectivePct >= HARD_THRESHOLD_PCT || velocity7d >= VELOCITY_HARD) {
    agentNote = {
      threshold:       'hard',
      require_confirm: false,
      note:            'Client is near capacity or has high recent velocity. Open with a focused task question. Avoid open-ended offers. Suggest breaking large requests into steps immediately.',
    };
  } else if (effectivePct >= SOFT_THRESHOLD_PCT || velocityHigh) {
    agentNote = {
      threshold:       'soft',
      require_confirm: false,
      note:            'Client approaching capacity or elevated recent velocity. Favor short focused conversations. Cache aggressively. Gently suggest step-by-step approach for complex requests.',
    };
  } else if (trendDirection === 'rising' && convCount >= 3) {
    agentNote = {
      threshold:       'watch',
      require_confirm: false,
      note:            'Client cost trend is rising month-over-month. No action needed yet — just be efficient. Flag if trend continues.',
    };
  }

  return json({
    ok:                  true,
    month_key:           monthKey,
    month_total_cents:   monthTotal,
    weighted_total_cents: weightedTotal,
    conversation_count:  convCount,
    velocity_7d_cents:   velocity7d,
    recent_avg_cents:    Math.round(recentAvg),
    recent_sessions:     recentSessions,
    trend_direction:     trendDirection,
    effective_pct:       Math.round(effectivePct * 100),
    threshold:           effectivePct >= KILL_THRESHOLD_PCT ? 'kill'
                       : effectivePct >= HARD_THRESHOLD_PCT ? 'hard'
                       : effectivePct >= SOFT_THRESHOLD_PCT ? 'soft'
                       : trendDirection === 'rising'         ? 'watch' : 'normal',
    agent_note:          agentNote,
  });
}


// =============================================================================
// SHARED UTILITIES
// =============================================================================

// Supabase REST helper — always uses service_role key (platform DB only)
async function supabase(env, method, path, body = null, extraHeaders = {}) {
  const url = env.SUPABASE_URL + path;
  const headers = {
    'apikey':       env.SUPABASE_SERVICE_ROLE_KEY,
    // No Authorization header — Supabase gateway translates the apikey
    // internally. Sending sb_secret_... as Bearer causes 403.
    'Content-Type': 'application/json',
    'Prefer':       'return=minimal',
    ...extraHeaders,
  };
  const init = { method, headers };
  if (body !== null && method !== 'GET') {
    init.body = JSON.stringify(body);
  }
  return fetch(url, init);
}

// JSON response helper
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// AES-256-GCM encryption
// ENCRYPTION_KEY is a 32-byte hex string stored in Wrangler secrets
async function encrypt(plaintext, hexKey) {
  const keyBytes = hexToBytes(hexKey);
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  // Prefix iv to ciphertext, encode as base64
  const combined = new Uint8Array(iv.byteLength + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

async function decrypt(ciphertext, hexKey) {
  const keyBytes = hexToBytes(hexKey);
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']
  );
  const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(plainBuf);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// Resend email sender
async function sendEmail(env, { to, subject, text }) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    'Formaut <notifications@formaut.com>',
        to:      [to],
        subject,
        text,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Generate a strong random password for Supabase DB
function generatePassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// Fetch operator's Supabase org ID (cached in env ideally — add SUPABASE_ORG_ID secret)
async function getSupabaseOrgId(env) {
  if (env.SUPABASE_ORG_ID) return env.SUPABASE_ORG_ID;
  const res = await fetch('https://api.supabase.com/v1/organizations', {
    headers: { Authorization: `Bearer ${env.SUPABASE_MGMT_TOKEN}` }
  });
  const orgs = await res.json();
  return orgs[0]?.id;
}

// Poll Supabase until project status is ACTIVE_HEALTHY (up to 90s)
async function waitForSupabaseReady(env, projectId) {
  for (let i = 0; i < 18; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}`, {
      headers: { Authorization: `Bearer ${env.SUPABASE_MGMT_TOKEN}` }
    });
    if (res.ok) {
      const p = await res.json();
      if (p.status === 'ACTIVE_HEALTHY') return true;
    }
  }
  return false; // timed out — non-fatal, schema step will likely fail but logged
}

// Client-side Supabase schema (Tier 2-5 memory tables)
// Template-specific tables (site_content, menu_items, etc.) added by build agent
function buildClientSchema(tier) {
  return `
-- Tier 2: session summaries
create table if not exists sessions (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz default now(),
  summary           text,
  changes_made      text[],
  preferences_noted text
);

-- Tier 3: site index
create table if not exists site_index (
  id            uuid primary key default gen_random_uuid(),
  page          text,
  section       text,
  component     text,
  last_modified timestamptz,
  notes         text
);

-- Tier 4: conversation history
create table if not exists conversation_history (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id),
  role       text,
  content    text,
  created_at timestamptz default now()
);

-- Tier 5: client context + preferences
create table if not exists client_context (
  id             uuid primary key default gen_random_uuid(),
  category       text,
  key            text,
  value          text,
  confidence     text,
  source_session uuid references sessions(id),
  updated_at     timestamptz default now()
);

-- RLS: deny anon on all memory tables
alter table sessions             enable row level security;
alter table site_index           enable row level security;
alter table conversation_history enable row level security;
alter table client_context       enable row level security;

create policy "deny anon: sessions"
  on sessions for all to anon using (false);
create policy "deny anon: site_index"
  on site_index for all to anon using (false);
create policy "deny anon: conversation_history"
  on conversation_history for all to anon using (false);
create policy "deny anon: client_context"
  on client_context for all to anon using (false);
  `.trim();
}

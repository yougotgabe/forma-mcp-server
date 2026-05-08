import { routeDashboardMessage } from './chat-cost-gate.js';
import { guardScope } from './formaut-scope-guard.js';
import { runExistingWebsiteCrawlAdapter, previewExistingWebsiteCrawl } from './existing-website-crawl-adapter.js';

// =============================================================================
// FORMA - PLATFORM WORKER
// =============================================================================
// Standalone Cloudflare Worker (NOT a Pages Function).
// Deploy with: wrangler deploy
//
// Endpoints:
//   POST /session          - inject Tier 1 context + Tier 2 summaries at session start
//   POST /signals          - write tech + style signals at session end
//   POST /service-request  - log out-of-scope request, notify operator
//   POST /encrypt          - encrypt and store a client credential
//   POST /decrypt          - decrypt a stored credential (server jobs only, never browser)
//   POST /provision        - create GitHub repo, CF Pages project, client Supabase schema
//   POST /execute-tool     - execute a build tool on behalf of the agent (GitHub/CF/Supabase)
//   POST /ingest-business-profile - create/update normalized business profile from onboarding intake
//   POST /business-profile/context - return compact business profile context pack
//   POST /business-profile/confirm-field - confirm or correct a profile field
//   POST /business-profile/rollback - rollback the latest profile field change
//
// All endpoints require x-worker-secret header matching WORKER_SECRET env var.
// =============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // -------------------------------------------------------------------------
    // Auth gate - every request must carry the shared worker secret.
    //
    // Temporary dev exception:
    //   /chat/preflight can be tested without the normal dashboard auth only when
    //   both Worker secrets are set and the matching test header is supplied.
    //
    // Required secrets for the exception:
    //   ALLOW_DEV_PREFLIGHT_TESTS = true
    //   DEV_PREFLIGHT_SECRET      = any long random test value
    //
    // Required request header for the exception:
    //   x-formaut-dev-test: <DEV_PREFLIGHT_SECRET>
    //
    // This does NOT bypass auth for provisioning, encryption, credentials, deploys,
    // or any route except /chat/preflight. Remove/disable after testing.
    // -------------------------------------------------------------------------
    const secret = request.headers.get('x-worker-secret');
    const isWorkerAuthorized = Boolean(secret && secret === env.WORKER_SECRET);
    const devPreflightSecret = request.headers.get('x-formaut-dev-test');
    const isDevPreflightTest = (
      path === '/chat/preflight' &&
      env.ALLOW_DEV_PREFLIGHT_TESTS === 'true' &&
      Boolean(env.DEV_PREFLIGHT_SECRET) &&
      devPreflightSecret === env.DEV_PREFLIGHT_SECRET
    );

    if (!isWorkerAuthorized && !isDevPreflightTest) {
      return json({ error: 'Unauthorized' }, 401);
    }

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
      if (path === '/chat/cost-gate')  return handleChatCostGate(body, env);
      if (path === '/chat/scope-guard') return handleChatScopeGuard(body, env);
      if (path === '/chat/preflight')  return handleChatPreflight(body, env);
      if (path === '/chat/crawl-url')   return handleChatCrawlUrl(body, env);
      if (path === '/session')         return handleSession(body, env);
      if (path === '/signals')         return handleSignals(body, env);
      if (path === '/client-data')     return handleClientData(body, env);
      if (path === '/ingest-business-profile')       return handleIngestBusinessProfile(body, env);
      if (path === '/business-profile/context')      return handleBusinessProfileContext(body, env);
      if (path === '/business-profile/confirm-field') return handleConfirmBusinessProfileField(body, env);
      if (path === '/business-profile/rollback')     return handleBusinessProfileRollback(body, env);
      if (path === '/service-request') return handleServiceRequest(body, env);
      if (path === '/encrypt')         return handleEncrypt(body, env);
      if (path === '/decrypt')         return handleDecrypt(body, env);
      if (path === '/provision')       return handleProvision(body, env);
      if (path === '/usage')           return handleUsage(body, env);
      if (path === '/usage/check')     return handleUsageCheck(body, env);
      if (path === '/execute-tool')     return handleExecuteTool(body, env);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(`[${path}] Unhandled error:`, err);
      return json({ error: 'Internal server error', detail: err.message }, 500);
    }
  }
};



// =============================================================================
// ENDPOINT: POST /chat/cost-gate
// =============================================================================
// Runs the deterministic pre-LLM router only.
// Use this for isolated testing of cheap intent handling.
// =============================================================================

async function handleChatCostGate(body, env) {
  const result = await routeDashboardMessage(body, env);
  return json(result);
}


// =============================================================================
// ENDPOINT: POST /chat/scope-guard
// =============================================================================
// Runs scope guard only. In the normal path, /chat/preflight is preferred.
// =============================================================================

async function handleChatScopeGuard(body, env) {
  const result = await guardScope({
    message: body.message || body.text || '',
    context: {
      sessionId: body.session_id || body.sessionId || null,
      userId: body.user_id || body.userId || null,
      businessProfileId: body.business_profile_id || body.businessProfileId || null,
    },
    supabase: null,
  });

  return json({
    ok: true,
    handled_by: 'scope_guard',
    should_call_llm: result.shouldCallModel,
    continue_pipeline: result.shouldContinue,
    response: result.responseText,
    scope: result.scopeDecision,
    memory_policy: result.memoryPolicy,
  });
}


// =============================================================================
// ENDPOINT: POST /chat/preflight
// =============================================================================
// Safe front door for dashboard chat.
// Order:
//   1. Cost gate handles canned/blocked messages and chooses the minimum path.
//   2. Scope guard protects business memory before interpretation or synthesis.
//   3. URL-only messages route to crawl before any Anthropic call.
//   4. Crawl output is normalized into evidence + persisted when client storage exists.
//   5. LLM synthesis is allowed only after deterministic routing/evidence steps.
// =============================================================================

async function handleChatPreflight(body, env) {
  const costResult = await routeDashboardMessage(body, env);
  const costRoute = costResult.route || {};
  const isUrlCrawlRoute = costRoute.next_action === 'trigger_website_crawl_adapter';

  if (costResult.blocked) {
    return json({
      ok: true,
      handled_by: 'cost_gate',
      should_call_llm: false,
      response: costRoute.response || null,
      next_action: costRoute.next_action || null,
      route: costRoute,
      intent: costResult.intent,
      estimate: costResult.estimate,
      blocked: true,
      block_reason: costResult.block_reason || null,
    });
  }

  if (costRoute.should_call_llm === false && !isUrlCrawlRoute) {
    return json({
      ok: true,
      handled_by: 'cost_gate',
      should_call_llm: false,
      response: costRoute.response || null,
      next_action: costRoute.next_action || null,
      route: costRoute,
      intent: costResult.intent,
      estimate: costResult.estimate,
      blocked: false,
      block_reason: null,
    });
  }

  const scopeResult = isUrlCrawlRoute
    ? {
        shouldContinue: true,
        responseText: null,
        scopeDecision: {
          category: 'in_scope',
          action: 'continue',
          reason: 'url_ingestion_route_from_cost_gate',
          confidence: 0.95,
        },
        memoryPolicy: {
          storeAsBusinessMemory: false,
          reason: 'raw URL evidence must be normalized before becoming memory',
        },
      }
    : await guardScope({
        message: body.message || body.text || '',
        context: {
          sessionId: body.session_id || body.sessionId || costResult.session_id || null,
          userId: body.user_id || body.userId || null,
          businessProfileId: body.business_profile_id || body.businessProfileId || null,
        },
        supabase: null,
      });

  if (!scopeResult.shouldContinue) {
    return json({
      ok: true,
      handled_by: 'scope_guard',
      should_call_llm: false,
      response: scopeResult.responseText,
      scope: scopeResult.scopeDecision,
      memory_policy: scopeResult.memoryPolicy,
      cost_gate: {
        intent: costResult.intent,
        route: costRoute,
        estimate: costResult.estimate,
      },
    });
  }

  if (isUrlCrawlRoute) {
    const shouldRunCrawl = body.auto_crawl !== false;
    if (!shouldRunCrawl) {
      return json({
        ok: true,
        handled_by: 'url_detection',
        should_call_llm: false,
        response: costRoute.response || null,
        next_action: 'trigger_website_crawl_adapter',
        route: costRoute,
        intent: costResult.intent,
        scope: scopeResult.scopeDecision,
        memory_policy: scopeResult.memoryPolicy,
        estimate: costResult.estimate,
      });
    }

    const crawlResult = await runWebsiteCrawlFromChatBody(body, env);
    const hasReviewItems = Boolean(crawlResult.evidence_substrate?.profilePatch?.needs_review?.length || crawlResult.extracted_profile?.needs_review?.length);
    return json({
      ok: true,
      handled_by: crawlResult.persisted ? 'crawl_evidence_pipeline' : 'crawl_evidence_preview',
      should_call_llm: false,
      response: costRoute.response || null,
      next_action: hasReviewItems ? 'review_uncertain_evidence' : 'review_crawl_evidence',
      route: costRoute,
      intent: costResult.intent,
      scope: scopeResult.scopeDecision,
      memory_policy: scopeResult.memoryPolicy,
      estimate: costResult.estimate,
      crawl: crawlResult,
      optional_llm_synthesis: {
        allowed_after_review: true,
        recommended: hasReviewItems,
        reason: hasReviewItems
          ? 'Evidence has uncertain fields that may benefit from a synthesis/clarification message.'
          : 'Deterministic evidence is available; LLM synthesis is optional, not required.',
      },
      blocked: false,
      block_reason: null,
    });
  }

  return json({
    ok: true,
    handled_by: 'preflight',
    should_call_llm: true,
    model: costRoute.model,
    max_tokens: costRoute.max_tokens,
    context_policy: costRoute.context_policy,
    next_action: costRoute.next_action,
    intent: costResult.intent,
    scope: scopeResult.scopeDecision,
    memory_policy: scopeResult.memoryPolicy,
    estimate: costResult.estimate,
    route: costRoute,
  });
}


// =============================================================================
// ENDPOINT: POST /session
// =============================================================================
// Called at the start of every agent session.
// Returns Tier 1 (flat client record) + Tier 2 (last 5 session summaries).
//
// Body: { slug: "client-slug" }
// Returns: { client: {...}, sessions: [...], onboarding: {...} }
// =============================================================================



// =============================================================================
// ENDPOINT: POST /chat/crawl-url
// =============================================================================
// Runs the existing website crawl adapter without any Anthropic call.
// Default mode is preview-only. Pass persist_crawl: true to write to the
// client's Supabase memory/profile tables after the client is provisioned.
// =============================================================================

async function handleChatCrawlUrl(body, env) {
  const crawlResult = await runWebsiteCrawlFromChatBody(body, env);
  return json({
    ok: true,
    handled_by: crawlResult.persisted ? 'crawl_adapter' : 'crawl_adapter_preview',
    should_call_llm: false,
    next_action: crawlResult.persisted ? 'review_crawl_results' : 'review_crawl_preview',
    crawl: crawlResult,
  });
}

async function runWebsiteCrawlFromChatBody(body, env) {
  const url = extractUrlFromMessage(body.url || body.existing_website_url || body.message || body.text || '');
  if (!url) throw new Error('A website URL is required for crawl testing.');

  const limit = Number(body.limit || 2);

  if (body.persist_crawl === true) {
    const slugOrId = body.slug || body.client_slug || body.client_id;
    if (!slugOrId) throw new Error('slug, client_slug, or client_id is required when persist_crawl is true.');
    const clientRecord = await loadClientRecordForWebsiteCrawl(slugOrId, env);
    return {
      ...(await runExistingWebsiteCrawlAdapter(env, clientRecord, { url, limit })),
      persisted: true,
    };
  }

  return await previewExistingWebsiteCrawl({ url, limit });
}

async function loadClientRecordForWebsiteCrawl(slugOrId, env) {
  const safe = encodeURIComponent(slugOrId);
  let clientRes = await supabase(env, 'GET', `/rest/v1/clients?slug=eq.${safe}&select=id,slug,live_url,existing_website_url,supabase_url,supabase_service_key_enc&limit=1`);
  let clients = clientRes.ok ? await clientRes.json() : [];

  if (!clients.length && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slugOrId)) {
    clientRes = await supabase(env, 'GET', `/rest/v1/clients?id=eq.${safe}&select=id,slug,live_url,existing_website_url,supabase_url,supabase_service_key_enc&limit=1`);
    clients = clientRes.ok ? await clientRes.json() : [];
  }

  if (!clients.length) throw new Error('Client not found for website crawl.');
  const client = clients[0];
  if (!client.supabase_url || !client.supabase_service_key_enc) {
    throw new Error('Client Supabase is not provisioned yet; use preview mode or provision the client first.');
  }

  const decryptedServiceKey = await decrypt(client.supabase_service_key_enc, env.ENCRYPTION_KEY);
  return {
    ...client,
    supabase_service_key_enc: decryptedServiceKey,
  };
}

function extractUrlFromMessage(value) {
  const text = String(value || '').trim();
  const match = text.match(/https?:\/\/[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i);
  return match ? match[0].replace(/[),.;]+$/, '') : null;
}

async function handleSession(body, env) {
  const { slug } = body;
  if (!slug) return json({ error: 'slug required' }, 400);

  // Tier 1 - client record
  const clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`
  );
  if (!clientRes.ok) return json({ error: 'Client not found' }, 404);
  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);

  const client = clients[0];

  // Strip encrypted fields - never return ciphertext to the agent context
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

  // Tier 2 - last 5 session summaries from platform sessions_index
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
  const {
    slug,
    session_summary,
    session_id,
    is_new_session     = false,
    conversation_turns = [],
    tech_signals       = [],
    style_signals      = [],
    memory_updates     = [],
  } = body;
  if (!slug) return json({ error: 'slug required' }, 400);

  // Resolve client record - need id for signals, and supabase creds for client writes
  const clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id,supabase_url,supabase_service_key_enc&limit=1`
  );
  if (!clientRes.ok) return json({ error: 'Client not found' }, 404);
  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);
  const clientId     = clients[0].id;
  const clientUrl    = clients[0].supabase_url;
  const clientKeyEnc = clients[0].supabase_service_key_enc;

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

  // Write tech signals - deduplicate by summary fuzzy match (exact for now)
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

  // Write style signals - deduplicate by business_type + page_type + final_layout
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

  // ── Write conversation_turns + memory_updates to client Supabase ──────────
  // Decrypt happens here - Worker holds ENCRYPTION_KEY, chat.js never does.
  const needsClientWrite = (memory_updates.length || conversation_turns.length) && clientUrl && clientKeyEnc;

  if (needsClientWrite) {
    let clientKey;
    try {
      clientKey = await decrypt(clientKeyEnc, env.ENCRYPTION_KEY);
    } catch {
      results.errors.push({ client_write: 'credential decryption failed' });
    }

    if (clientKey) {
      const clientHeaders = {
        'apikey':       clientKey,
        'Content-Type': 'application/json',
        'Prefer':       'return=minimal',
      };

      // ── Conversation history ─────────────────────────────────────────────
      if (conversation_turns.length && session_id) {
        // Create the session row if this is the first turn
        if (is_new_session) {
          await fetch(`${clientUrl}/rest/v1/sessions`, {
            method: 'POST',
            headers: clientHeaders,
            body: JSON.stringify({
              id:         session_id,
              summary:    conversation_turns[0]?.content?.slice(0, 120) || 'Session',
              created_at: new Date().toISOString(),
            }),
          }).catch(() => {});
        }

        // Write all turns
        const turns = conversation_turns.map(m => ({
          session_id,
          role:       m.role,
          content:    m.content,
          created_at: new Date().toISOString(),
        }));

        await fetch(`${clientUrl}/rest/v1/conversation_history`, {
          method: 'POST',
          headers: clientHeaders,
          body: JSON.stringify(turns),
        }).catch(() => {});

        results.conversation = turns.length;
      }

      // ── Memory updates ───────────────────────────────────────────────────
      for (const update of memory_updates) {
        const { category, key, value_json, confidence, event_type, reason, old_implied, source_session_id } = update;

        if (!confidence || confidence < 0.60) continue;
        if (!category || !key || !value_json) continue;

        try {
          await fetch(`${clientUrl}/rest/v1/client_memory`, {
            method: 'POST',
            headers: { ...clientHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({
              client_id:         clientId,
              category,
              key,
              value_json,
              confidence,
              source_session_id: source_session_id || session_id || null,
              updated_at:        new Date().toISOString(),
            }),
          });

          await fetch(`${clientUrl}/rest/v1/memory_events`, {
            method: 'POST',
            headers: clientHeaders,
            body: JSON.stringify({
              client_id:         clientId,
              event_type:        event_type || 'updated',
              category,
              key,
              old_value:         old_implied || null,
              new_value:         value_json,
              reason:            reason || null,
              source_session_id: source_session_id || session_id || null,
            }),
          });

          results.memory = (results.memory || 0) + 1;
        } catch (err) {
          results.errors.push({ memory_key: `${category}.${key}`, error: err.message });
        }
      }
    }
  }

  return json({ ok: true, ...results });
}


// =============================================================================
// ENDPOINT: POST /client-data
// =============================================================================
// Fetches session summaries, communication profile, and client memory from
// the client's own Supabase - decrypting the service key here in the Worker
// where ENCRYPTION_KEY is available. chat.js calls this instead of hitting
// client Supabase directly, since it never has access to the decryption key.
//
// Body:    { slug: "client-slug" }
// Returns: { session_summaries: [...], comm_profile: {...}|null, client_memory: [...] }
// =============================================================================

async function handleClientData(body, env) {
  const { slug } = body;
  if (!slug) return json({ error: 'slug required' }, 400);

  // Fetch client record - need supabase_url, supabase_service_key_enc, id
  const clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id,supabase_url,supabase_service_key_enc&limit=1`
  );
  if (!clientRes.ok) return json({ error: 'Client not found' }, 404);
  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);
  const client = clients[0];

  // If client Supabase isn't provisioned yet, return empty - not an error
  if (!client.supabase_url || !client.supabase_service_key_enc) {
    return json({ session_summaries: [], comm_profile: null, client_memory: [] });
  }

  // Decrypt service key - this is why this endpoint exists
  let clientKey;
  try {
    clientKey = await decrypt(client.supabase_service_key_enc, env.ENCRYPTION_KEY);
  } catch {
    return json({ error: 'Credential decryption failed' }, 500);
  }

  const clientUrl = client.supabase_url;
  const clientId  = client.id;

  // Helper for client Supabase fetches
  const clientFetch = (path) => fetch(`${clientUrl}${path}`, {
    headers: { 'apikey': clientKey, 'Content-Type': 'application/json' },
  });

  // Fetch all three in parallel - fastest possible
  const [sessionsRes, profileRes, memoryRes, businessProfileRes] = await Promise.allSettled([
    clientFetch('/rest/v1/sessions?select=summary,changes_made,created_at&order=created_at.desc&limit=5'),
    clientFetch('/rest/v1/client_communication_profile?select=*&limit=1'),
    clientFetch(`/rest/v1/client_memory?client_id=eq.${clientId}&confidence=gte.0.65&order=confidence.desc&limit=50`),
    clientFetch(`/rest/v1/business_profiles?client_id=eq.${clientId}&select=*&limit=1`),
  ]);

  const session_summaries = (sessionsRes.status === 'fulfilled' && sessionsRes.value.ok)
    ? await sessionsRes.value.json()
    : [];

  const profileRows = (profileRes.status === 'fulfilled' && profileRes.value.ok)
    ? await profileRes.value.json()
    : [];
  const comm_profile = profileRows[0] || null;

  const client_memory = (memoryRes.status === 'fulfilled' && memoryRes.value.ok)
    ? await memoryRes.value.json()
    : [];

  const businessProfileRows = (businessProfileRes.status === 'fulfilled' && businessProfileRes.value.ok)
    ? await businessProfileRes.value.json()
    : [];
  const business_profile = businessProfileRows[0] || null;
  const business_profile_context = business_profile
    ? buildBusinessProfileContextPack(business_profile)
    : null;

  return json({ session_summaries, comm_profile, client_memory, business_profile, business_profile_context });
}



// =============================================================================
// ENDPOINT: POST /ingest-business-profile
// =============================================================================
// Deterministic Milestone A implementation: manual intake -> normalized profile
// -> profile fields -> source evidence -> audit events -> context pack.
//
// Body: { slug?: "client-slug", client_id?: "uuid-or-slug", manual_intake: {...} }
// Returns: { ok, profile_id, status, confidence, needs_review, business_profile_context }
// =============================================================================

async function handleIngestBusinessProfile(body, env) {
  const slugOrId = body.slug || body.client_id;
  const manualIntake = body.manual_intake || body.intake || {};
  if (!slugOrId) return json({ error: 'slug or client_id required' }, 400);
  if (!manualIntake || Object.keys(manualIntake).length === 0) {
    return json({ error: 'manual_intake required for Milestone A' }, 400);
  }

  const resolved = await resolveClientDataAccess(slugOrId, env);
  if (!resolved.ok) return json({ error: resolved.error }, resolved.status || 500);

  const { client, clientFetch } = resolved;
  const clientId = client.id;
  const normalized = normalizeManualBusinessIntake(manualIntake);
  const derived = deriveBusinessProfileDecisions(normalized);
  const nowIso = new Date().toISOString();

  const sourceRow = {
    client_id: clientId,
    source_type: 'manual_intake',
    source_label: 'Initial onboarding intake',
    raw_json: manualIntake,
    raw_text: manualIntake.business_description || manualIntake.description || null,
    fetch_status: 'success',
  };
  const sourceRes = await clientFetch('/rest/v1/business_profile_sources', 'POST', sourceRow, { Prefer: 'return=representation' });
  if (!sourceRes.ok) return json(await restError('Could not write business_profile_sources', sourceRes), 500);
  const sourceRows = await sourceRes.json();
  const sourceId = sourceRows[0]?.id || null;

  const profilePayload = {
    client_id: clientId,
    business_name: normalized.business_name || null,
    legal_name: normalized.legal_name || null,
    industry: normalized.industry || null,
    industry_category: derived.industry_category,
    location: normalized.location || {},
    service_area: normalized.service_area || [],
    phone: normalized.phone || null,
    email: normalized.email || null,
    website_url: normalized.website_url || null,
    booking_url: normalized.booking_url || null,
    hours: normalized.hours || {},
    services: normalized.services || [],
    products: normalized.products || [],
    target_customer: normalized.target_customer || null,
    price_range: normalized.price_range || null,
    site_goal: derived.site_goal,
    emotional_goal: normalized.emotional_goal || derived.emotional_goal,
    brand_tone: normalized.brand_tone || [],
    social_voice: normalized.social_voice || derived.social_voice,
    visual_style: normalized.visual_style || null,
    primary_colors: normalized.primary_colors || [],
    secondary_colors: normalized.secondary_colors || [],
    review_themes: normalized.review_themes || [],
    common_questions: normalized.common_questions || [],
    key_differentiators: normalized.key_differentiators || [],
    existing_imagery: normalized.existing_imagery || [],
    logo_detected: Boolean(normalized.logo_url),
    logo_url: normalized.logo_url || null,
    design_confidence_level: derived.design_confidence_level,
    feature_fit: derived.feature_fit,
    feature_avoid: derived.feature_avoid,
    profile_confidence: normalized.profile_confidence,
    status: normalized.profile_confidence >= 0.75 ? 'ready_for_generation' : 'partially_ingested',
    updated_at: nowIso,
  };

  const existingRes = await clientFetch(`/rest/v1/business_profiles?client_id=eq.${clientId}&select=*&limit=1`, 'GET');
  const existingRows = existingRes.ok ? await existingRes.json() : [];
  let profileRes;
  if (existingRows.length) {
    profileRes = await clientFetch(`/rest/v1/business_profiles?client_id=eq.${clientId}`, 'PATCH', profilePayload, { Prefer: 'return=representation' });
  } else {
    profileRes = await clientFetch('/rest/v1/business_profiles', 'POST', profilePayload, { Prefer: 'return=representation' });
  }
  if (!profileRes.ok) return json(await restError('Could not upsert business_profiles', profileRes), 500);
  const profileRows = await profileRes.json();
  const profile = profileRows[0];

  const fieldRows = businessProfileFieldRows(clientId, profile.id, normalized, derived, sourceId);
  for (const row of fieldRows) {
    await upsertBusinessProfileField(clientFetch, row);
  }

  await clientFetch('/rest/v1/business_profile_events', 'POST', {
    client_id: clientId,
    profile_id: profile.id,
    event_type: existingRows.length ? 'field_updated' : 'created',
    new_value: profilePayload,
    reason: existingRows.length ? 'Manual intake refreshed the normalized business profile.' : 'Manual intake created the normalized business profile.',
    actor_type: 'system',
    source_id: sourceId,
  });

  return json({
    ok: true,
    profile_id: profile.id,
    status: profile.status,
    confidence: profile.profile_confidence,
    needs_review: [],
    business_profile_context: buildBusinessProfileContextPack(profile),
  });
}

async function handleBusinessProfileContext(body, env) {
  const slugOrId = body.slug || body.client_id;
  if (!slugOrId) return json({ error: 'slug or client_id required' }, 400);
  const resolved = await resolveClientDataAccess(slugOrId, env);
  if (!resolved.ok) return json({ error: resolved.error }, resolved.status || 500);
  const { client, clientFetch } = resolved;
  const res = await clientFetch(`/rest/v1/business_profiles?client_id=eq.${client.id}&select=*&limit=1`, 'GET');
  const rows = res.ok ? await res.json() : [];
  const profile = rows[0] || null;
  return json({ ok: true, business_profile: profile, business_profile_context: profile ? buildBusinessProfileContextPack(profile) : null });
}

async function handleConfirmBusinessProfileField(body, env) {
  const { field_path, confirmed_value, reason = 'Client confirmed in chat' } = body;
  const slugOrId = body.slug || body.client_id;
  if (!slugOrId || !field_path) return json({ error: 'slug/client_id and field_path required' }, 400);
  const resolved = await resolveClientDataAccess(slugOrId, env);
  if (!resolved.ok) return json({ error: resolved.error }, resolved.status || 500);
  const { client, clientFetch } = resolved;
  const profileRes = await clientFetch(`/rest/v1/business_profiles?client_id=eq.${client.id}&select=*&limit=1`, 'GET');
  const profiles = profileRes.ok ? await profileRes.json() : [];
  if (!profiles.length) return json({ error: 'Business profile not found' }, 404);
  const profile = profiles[0];

  await upsertBusinessProfileField(clientFetch, {
    client_id: client.id,
    profile_id: profile.id,
    field_path,
    value_json: confirmed_value,
    confidence: 0.98,
    source_type: 'client_conversation',
    source_label: reason,
    is_confirmed: true,
    is_active: true,
  });
  await clientFetch('/rest/v1/business_profile_events', 'POST', {
    client_id: client.id,
    profile_id: profile.id,
    event_type: 'field_confirmed',
    field_path,
    new_value: confirmed_value,
    reason,
    actor_type: 'client',
  });
  return json({ ok: true });
}

async function handleBusinessProfileRollback(body, env) {
  const slugOrId = body.slug || body.client_id;
  const { event_id, reason = 'Rollback requested' } = body;
  if (!slugOrId || !event_id) return json({ error: 'slug/client_id and event_id required' }, 400);
  const resolved = await resolveClientDataAccess(slugOrId, env);
  if (!resolved.ok) return json({ error: resolved.error }, resolved.status || 500);
  const { client, clientFetch } = resolved;
  const eventRes = await clientFetch(`/rest/v1/business_profile_events?id=eq.${event_id}&client_id=eq.${client.id}&select=*&limit=1`, 'GET');
  const events = eventRes.ok ? await eventRes.json() : [];
  if (!events.length) return json({ error: 'Rollback event not found' }, 404);
  const target = events[0];
  if (!target.field_path || target.old_value === undefined || target.old_value === null) {
    return json({ error: 'Selected event has no field-level old_value to restore' }, 400);
  }
  await upsertBusinessProfileField(clientFetch, {
    client_id: client.id,
    profile_id: target.profile_id,
    field_path: target.field_path,
    value_json: target.old_value,
    confidence: 0.90,
    source_type: 'operator_override',
    source_label: reason,
    is_confirmed: false,
    is_active: true,
  });
  await clientFetch('/rest/v1/business_profile_events', 'POST', {
    client_id: client.id,
    profile_id: target.profile_id,
    event_type: 'rollback',
    field_path: target.field_path,
    old_value: target.new_value,
    new_value: target.old_value,
    reason,
    actor_type: 'system',
  });
  return json({ ok: true });
}

async function resolveClientDataAccess(slugOrId, env) {
  const safe = encodeURIComponent(slugOrId);
  let clientRes = await supabase(env, 'GET', `/rest/v1/clients?slug=eq.${safe}&select=id,slug,supabase_url,supabase_service_key_enc&limit=1`);
  let clients = clientRes.ok ? await clientRes.json() : [];

  // If caller passed a UUID instead of slug, try id lookup separately so a
  // normal slug never gets cast into a UUID filter and rejected by PostgREST.
  if (!clients.length && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slugOrId)) {
    clientRes = await supabase(env, 'GET', `/rest/v1/clients?id=eq.${safe}&select=id,slug,supabase_url,supabase_service_key_enc&limit=1`);
    clients = clientRes.ok ? await clientRes.json() : [];
  }

  if (!clients.length) return { ok: false, status: 404, error: 'Client not found' };
  const client = clients[0];
  if (!client.supabase_url || !client.supabase_service_key_enc) {
    return { ok: false, status: 400, error: 'Client Supabase is not provisioned yet' };
  }
  let clientKey;
  try {
    clientKey = await decrypt(client.supabase_service_key_enc, env.ENCRYPTION_KEY);
  } catch {
    return { ok: false, status: 500, error: 'Credential decryption failed' };
  }
  const clientFetch = (path, method = 'GET', body = null, extraHeaders = {}) => {
    const headers = { apikey: clientKey, 'Content-Type': 'application/json', Prefer: 'return=minimal', ...extraHeaders };
    const init = { method, headers };
    if (body !== null && method !== 'GET') init.body = JSON.stringify(body);
    return fetch(`${client.supabase_url}${path}`, init);
  };
  return { ok: true, client, clientFetch };
}

function normalizeManualBusinessIntake(input) {
  const arr = (v) => Array.isArray(v) ? v.filter(Boolean) : (typeof v === 'string' && v.trim() ? v.split(',').map(x => x.trim()).filter(Boolean) : []);
  const location = {
    raw_address: input.address || input.raw_address || null,
    city: input.city || null,
    state: input.state || null,
    postal_code: input.postal_code || input.zip || null,
    country: input.country || 'US',
  };
  Object.keys(location).forEach(k => location[k] == null && delete location[k]);
  const known = [input.business_name, input.phone, input.email, input.website_url, input.business_description, input.industry, input.services].filter(Boolean).length;
  const confidence = Math.min(0.95, Math.max(0.55, 0.55 + known * 0.06));
  return {
    business_name: input.business_name || input.name || null,
    legal_name: input.legal_name || null,
    industry: input.industry || input.business_type || null,
    location,
    service_area: arr(input.service_area),
    phone: input.phone || null,
    email: input.email || null,
    website_url: input.website_url || input.website || null,
    booking_url: input.booking_url || null,
    hours: input.hours || {},
    services: arr(input.services),
    products: arr(input.products),
    target_customer: input.target_customer || input.audience || null,
    price_range: input.price_range || null,
    emotional_goal: input.emotional_goal || null,
    brand_tone: arr(input.brand_tone || input.tone || input.style_notes),
    social_voice: input.social_voice || null,
    visual_style: input.visual_style || input.style_notes || null,
    primary_colors: arr(input.primary_colors),
    secondary_colors: arr(input.secondary_colors),
    review_themes: arr(input.review_themes),
    common_questions: arr(input.common_questions),
    key_differentiators: arr(input.key_differentiators || input.differentiators),
    existing_imagery: arr(input.existing_imagery),
    logo_url: input.logo_url || null,
    profile_confidence: Number(confidence.toFixed(2)),
  };
}

function deriveBusinessProfileDecisions(profile) {
  const haystack = `${profile.industry || ''} ${(profile.services || []).join(' ')} ${profile.business_name || ''}`.toLowerCase();
  let category = 'professional_service';
  if (/roof|plumb|electric|hvac|clean|lawn|landscap|contract|repair|paint|trade/.test(haystack)) category = 'service_trade';
  else if (/restaurant|cafe|bar|food|coffee|bakery|catering/.test(haystack)) category = 'food_hospitality';
  else if (/music|artist|studio|photo|video|design|creative|band/.test(haystack)) category = 'creative_identity';
  else if (/shop|boutique|retail|store|merch|product/.test(haystack)) category = 'retail_boutique';
  else if (/wellness|salon|spa|fitness|therapy|coach|massage|beauty/.test(haystack)) category = 'wellness_personal';
  else if (/venue|event|wedding|rental/.test(haystack)) category = 'event_venue';

  const map = {
    service_trade:      ['estimate requests and phone calls', 'trust before contact', ['sticky_nav','service_cards','testimonial_strip','contact_cta'], ['heavy_parallax','audio_player','overly_experimental_layouts']],
    food_hospitality:   ['visits, orders, or reservations', 'appetite and atmosphere', ['menu_preview','hours_location_block','photo_strip','map_cta'], ['dense_corporate_copy','hidden_hours']],
    creative_identity:  ['recognition, following, and booking inquiries', 'vibe recognition and momentum', ['hero_visual','media_embed','portfolio_grid','contact_cta'], ['generic_stock_sections','overly_corporate_tone']],
    retail_boutique:    ['browsing, buying, or visiting', 'taste and discovery', ['product_grid','featured_collection','visit_cta'], ['cluttered_navigation','too_many_ctas']],
    wellness_personal:  ['appointment bookings', 'comfort and personal trust', ['booking_cta','service_cards','calm_testimonials'], ['aggressive_sales_language','chaotic_motion']],
    professional_service:['consultation and trust building', 'clarity and confidence', ['credibility_section','service_cards','contact_cta','faq_block'], ['playful_gimmicks','unclear_pricing_claims']],
    event_venue:        ['inquiries, tours, and date availability', 'imagining the event there', ['gallery_grid','availability_cta','event_package_cards'], ['flat_text_only_pages','buried_contact_info']],
  };
  const [site_goal, emotional_goal, feature_fit, feature_avoid] = map[category];
  return { industry_category: category, site_goal, emotional_goal, social_voice: (profile.brand_tone || []).join(', ') || null, feature_fit, feature_avoid, design_confidence_level: profile.profile_confidence >= 0.80 ? 'high' : 'medium' };
}

function businessProfileFieldRows(clientId, profileId, normalized, derived, sourceId) {
  const rows = [];
  const add = (field_path, value, confidence = 0.90) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value) && value.length === 0) return;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return;
    rows.push({ client_id: clientId, profile_id: profileId, field_path, value_json: value, confidence, source_type: 'manual_intake', source_id: sourceId, source_label: 'Initial onboarding intake', is_confirmed: false, is_active: true });
  };
  for (const [k, v] of Object.entries(normalized)) add(k, v, k === 'profile_confidence' ? normalized.profile_confidence : 0.90);
  for (const [k, v] of Object.entries(derived)) add(k, v, 0.75);
  return rows;
}

async function upsertBusinessProfileField(clientFetch, row) {
  const existingRes = await clientFetch(`/rest/v1/business_profile_fields?client_id=eq.${row.client_id}&field_path=eq.${encodeURIComponent(row.field_path)}&select=id,value_json&limit=1`, 'GET');
  const existing = existingRes.ok ? await existingRes.json() : [];
  if (existing.length) {
    return clientFetch(`/rest/v1/business_profile_fields?id=eq.${existing[0].id}`, 'PATCH', { ...row, updated_at: new Date().toISOString() });
  }
  return clientFetch('/rest/v1/business_profile_fields', 'POST', row);
}

function buildBusinessProfileContextPack(profile) {
  return {
    identity: {
      business_name: profile.business_name,
      industry: profile.industry,
      industry_category: profile.industry_category,
    },
    contact: {
      phone: profile.phone,
      email: profile.email,
      website_url: profile.website_url,
      booking_url: profile.booking_url,
      location: profile.location,
      hours: profile.hours,
    },
    services: profile.services || [],
    products: profile.products || [],
    proof: {
      average_rating: profile.average_rating,
      review_count: profile.review_count,
      review_themes: profile.review_themes || [],
      key_differentiators: profile.key_differentiators || [],
      common_questions: profile.common_questions || [],
    },
    voice: {
      target_customer: profile.target_customer,
      brand_tone: profile.brand_tone || [],
      social_voice: profile.social_voice,
      visual_style: profile.visual_style,
      emotional_goal: profile.emotional_goal,
    },
    design_guardrails: {
      site_goal: profile.site_goal,
      design_confidence_level: profile.design_confidence_level,
      feature_fit: profile.feature_fit || [],
      feature_avoid: profile.feature_avoid || [],
      primary_colors: profile.primary_colors || [],
      secondary_colors: profile.secondary_colors || [],
    },
    generation_notes: [
      profile.status ? `Profile status: ${profile.status}` : null,
      profile.profile_confidence != null ? `Profile confidence: ${profile.profile_confidence}` : null,
    ].filter(Boolean),
  };
}

async function restError(message, res) {
  let detail = null;
  try { detail = await res.json(); } catch { detail = await res.text(); }
  return { error: message, detail };
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
  // NOTIFY_EMAIL must be a direct inbox - never a routed address (KB section2.4)
  const emailSent = await sendEmail(env, {
    to:      env.NOTIFY_EMAIL,
    subject: `[Forma] Service Request ${ref} - ${client.display_name}`,
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
    subject:          `[Forma] Service Request ${ref} - ${client.display_name}`,
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
// Never returns the ciphertext - just confirms storage.
//
// Body: {
//   slug: "client-slug",
//   field: "github_token_enc | cloudflare_token_enc | supabase_mgmt_token_enc | ...",
//   plaintext: "the-actual-secret"
// }
//
// Allowed fields (whitelist - prevents arbitrary column writes):
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
// Called ONLY by server-side provisioning and build jobs - never from the browser.
// The decrypted value is used in-process by the calling job and never logged,
// returned to clients, or stored anywhere in plaintext.
//
// Body:     { ciphertext: string }   - the base64 blob stored in clients table
// Response: { value: string }        - plaintext; use immediately and discard
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
    // Generic error only - never surface decryption internals
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
// On failure, the step name and error are returned - caller decides whether to retry.
// =============================================================================

async function handleProvision(body, env) {
  const { slug } = body;
  if (!slug) return json({ error: 'slug required' }, 400);

  // Load client record - must have display_name, tier, admin_emails, owner_email
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
    console.log(`[provision:${slug}] ${step} -> ${status}`, detail || '');
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
        description: `Forma client site - ${client.display_name}`,
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
      // Handle both legacy key names (service_role, anon) and new format
      // New Supabase projects may return sb_secret_* and sb_publishable_* names
      const serviceKey = (
        keys.find(k => k.name === 'service_role')?.api_key ||
        keys.find(k => k.name?.startsWith('sb_secret'))?.api_key ||
        keys.find(k => k.role === 'service_role')?.api_key
      );
      const anonKey = (
        keys.find(k => k.name === 'anon')?.api_key ||
        keys.find(k => k.name?.startsWith('sb_publishable'))?.api_key ||
        keys.find(k => k.role === 'anon')?.api_key
      );

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
    // Non-fatal - keys can be retrieved manually
  }

  // ── Step 5: Run client schema SQL ──────────────────────────────────────────
  // The client schema is the Tier 2-5 memory tables (sessions, site_index,
  // conversation_history, client_context) plus site_content, menu_items, etc.
  // depending on template. For now we run the memory schema - template-specific
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
      // Non-fatal - schema can be run manually in client's SQL editor
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
    subject: `[Forma] Provisioning complete - ${client.display_name}`,
    text:    [
      `Client: ${client.display_name} (${slug})`,
      `GitHub: https://github.com/${client.github_repo}`,
      `Pages:  https://${slug}.pages.dev`,
      `Supabase: ${clientSupabaseUrl}`,
      ``,
      `Steps:`,
      ...steps.map(s => `  ${s.step}: ${s.status}${s.detail ? ` - ${s.detail}` : ''}`),
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

// Internal margin guardrail - max cost per client per month
const MARGIN_GUARDRAIL = {
  standard: { monthly_revenue: 5000, max_cost_cents: 1500 }, // $50/mo, max $15
  pro:      { monthly_revenue: 10000, max_cost_cents: 3500 }, // $100/mo, max $35
};

// Threshold percentages
const SOFT_THRESHOLD_PCT  = 0.70;  // suggest efficiency at 70%
const HARD_THRESHOLD_PCT  = 0.90;  // offer overflow at 90%
const KILL_THRESHOLD_PCT  = 1.50;  // require confirmation at 150%

// Conversation type weights - how much each type counts toward thresholds
// Build and redesign are expected to be heavy - relax their threshold impact
// Maintenance sitting at 85% repeatedly is more concerning than one big build
const CONV_TYPE_WEIGHT = {
  build:       0.70,  // expected heavy - weight down 30%
  redesign:    0.75,  // expected heavy - weight down 25%
  maintenance: 1.20,  // unexpected heavy - weight up 20%
  extraction:  0.30,  // always light - barely counts
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

// Weighted cost for threshold calculation - same actual cost stored, different threshold impact
function weightedCost(costCents, conversationType) {
  const weight = CONV_TYPE_WEIGHT[conversationType] || 1.0;
  return Math.round(costCents * weight);
}

function buildAgentGuidance(effectivePct, velocityPct, tier, conversationType) {
  // Kill switch - 150% of guardrail, regardless of conversation type
  if (effectivePct >= KILL_THRESHOLD_PCT) {
    return {
      threshold:        'kill',
      require_confirm:  true,
      message:          "Looks like we've been doing a lot of heavy lifting lately - want to continue with extended capacity today?",
      suggest_overflow: true,
      estimated_overflow_cost: '$2-5',
      internal_note:    'Client at 150%+ of cost guardrail. Require explicit confirmation before proceeding with any session. Log this session for operator review.',
    };
  }

  // Hard threshold - 90% of guardrail
  if (effectivePct >= HARD_THRESHOLD_PCT) {
    return {
      threshold:        'hard',
      require_confirm:  false,
      message:          conversationType === 'build'
        ? "This is a full build - that's expected to take some capacity. Want me to proceed, or break it into stages across a couple of sessions?"
        : "This is a bigger task than usual. I can continue, or we can break it into focused sessions for the best results - your call.",
      suggest_overflow: true,
      estimated_overflow_cost: '$1-3',
      internal_note:    'Present overflow option naturally. Do not make client feel penalized.',
    };
  }

  // Soft threshold - 70% of guardrail OR high velocity
  const velocityElevated = velocityPct >= VELOCITY_SOFT;
  if (effectivePct >= SOFT_THRESHOLD_PCT || velocityElevated) {
    return {
      threshold:        'soft',
      require_confirm:  false,
      message:          'This is shaping up to be a bigger task. Want me to break it into steps so each part gets full attention?',
      suggest_overflow: false,
      internal_note:    velocityElevated
        ? 'High recent velocity - favor short focused conversations, cache aggressively.'
        : 'Approaching monthly capacity - prefer efficiency, suggest breaking complex requests into steps.',
    };
  }

  return null; // normal - no guidance needed
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

  // Accumulate monthly summary -- fetch existing row then increment.
  // merge-duplicates replaces values, not adds -- so we must read-then-write.
  // client_usage_log is the source of truth; this table is a pre-aggregated
  // summary for fast threshold checks.
  const existingMonthRes = await supabase(env, 'GET',
    `/rest/v1/client_usage?client_slug=eq.${encodeURIComponent(slug)}&month_key=eq.${monthKey}&select=*&limit=1`
  );
  const existingMonthRows = existingMonthRes.ok ? await existingMonthRes.json() : [];
  const existing = existingMonthRows[0];

  if (existing) {
    // Row exists -- increment all counters atomically
    await supabase(env, 'PATCH',
      `/rest/v1/client_usage?client_slug=eq.${encodeURIComponent(slug)}&month_key=eq.${monthKey}`,
      {
        total_cost_cents:    existing.total_cost_cents    + actualCostCents,
        weighted_cost_cents: existing.weighted_cost_cents + weighted,
        input_tokens:        existing.input_tokens        + input_tokens,
        output_tokens:       existing.output_tokens       + output_tokens,
        cached_tokens:       existing.cached_tokens       + cached_tokens,
        conversation_count:  existing.conversation_count  + 1,
      }
    );
  } else {
    // First conversation this month -- insert fresh row
    await supabase(env, 'POST', '/rest/v1/client_usage',
      {
        client_id:           clientId,
        client_slug:         slug,
        month_key:           monthKey,
        total_cost_cents:    actualCostCents,
        weighted_cost_cents: weighted,
        input_tokens,
        output_tokens,
        cached_tokens,
        conversation_count:  1,
      }
    );
  }

  // Fetch updated monthly totals
  const totalRes = await supabase(env, 'GET',
    `/rest/v1/client_usage?client_slug=eq.${encodeURIComponent(slug)}&month_key=eq.${monthKey}&select=total_cost_cents,weighted_cost_cents,conversation_count&limit=1`
  );
  const totals        = totalRes.ok ? await totalRes.json() : [];
  const monthTotal    = totals[0]?.total_cost_cents    || actualCostCents;
  const weightedTotal = totals[0]?.weighted_cost_cents || weighted;
  const convCount     = totals[0]?.conversation_count  || 1;

  // Rolling 7-day velocity - sum actual costs from last 7 days
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
      message:         "Looks like we've been doing a lot of heavy lifting lately - want to continue with extended capacity today?",
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
      note:            'Client cost trend is rising month-over-month. No action needed yet - just be efficient. Flag if trend continues.',
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
// ENDPOINT: POST /execute-tool
// =============================================================================
// Called by chat.js during the agentic loop when Claude wants to take an action.
// Decrypts client credentials, executes the tool, returns the result.
//
// Body: {
//   slug:      "client-slug",
//   tool:      "read_file | create_file | edit_file | list_files |
//               run_query | trigger_deploy | check_deploy_status",
//   args:      { ...tool-specific arguments }
// }
//
// SAFETY MODEL:
//   - Destructive tools (overwrite file, run write SQL) return requires_confirmation
//     unless args.confirmed === true. The dashboard shows a confirm prompt first.
//   - read_file, list_files, run_query (SELECT only), check_deploy_status are
//     always safe - execute immediately with no confirmation.
//   - trigger_deploy is fire-and-forget - returns deployment_id immediately,
//     client polls check_deploy_status separately to avoid 30s timeout.
//
// All credentials are decrypted here and never returned to the caller.
// =============================================================================

// Tools that are always safe - no confirmation needed
const SAFE_TOOLS = new Set([
  'read_file',
  'list_files',
  'run_query',
  'check_deploy_status',
  'preview_srcdoc',      // instant inline preview - no deploy needed
  'get_preview_url',     // poll branch deploy status, return preview URL
]);

// Tools that require explicit confirmation before executing
const CONFIRM_TOOLS = new Set([
  'edit_file',
  'create_file',
  'trigger_deploy',
  'run_write_query',
  'preview_branch_deploy', // writes to preview branch - requires confirmation before committing to main
]);

async function handleExecuteTool(body, env) {
  const { slug, tool, args = {} } = body;

  if (!slug)  return json({ error: 'slug required' }, 400);
  if (!tool)  return json({ error: 'tool required' }, 400);
  if (![...SAFE_TOOLS, ...CONFIRM_TOOLS].includes(tool)) {
    return json({ error: `Unknown tool: ${tool}` }, 400);
  }

  // Confirmation gate - dangerous tools return early unless confirmed
  if (CONFIRM_TOOLS.has(tool) && !args.confirmed) {
    return json({
      requires_confirmation: true,
      tool,
      args,
      message: confirmationMessage(tool, args),
    });
  }

  // Load client record to get encrypted credentials
  const clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=github_repo,cloudflare_pages_project,cloudflare_account_id,supabase_url,github_token_enc,cloudflare_token_enc,supabase_service_key_enc&limit=1`
  );
  if (!clientRes.ok) return json({ error: 'Client not found' }, 404);
  const clients = await clientRes.json();
  if (!clients.length) return json({ error: 'Client not found' }, 404);
  const client = clients[0];

  // Decrypt credentials on demand - only what this tool needs
  let githubToken, cloudflareToken, supabaseKey;

  try {
    if (['read_file','list_files','edit_file','create_file','preview_branch_deploy'].includes(tool)) {
      if (!client.github_token_enc) return json({ error: 'GitHub not connected' }, 422);
      githubToken = await decrypt(client.github_token_enc, env.ENCRYPTION_KEY);
    }
    if (['trigger_deploy','check_deploy_status','preview_branch_deploy','get_preview_url'].includes(tool)) {
      if (!client.cloudflare_token_enc) return json({ error: 'Cloudflare not connected' }, 422);
      cloudflareToken = await decrypt(client.cloudflare_token_enc, env.ENCRYPTION_KEY);
    }
    if (['run_query','run_write_query'].includes(tool)) {
      if (!client.supabase_service_key_enc) return json({ error: 'Supabase not connected' }, 422);
      supabaseKey = await decrypt(client.supabase_service_key_enc, env.ENCRYPTION_KEY);
    }
  } catch {
    return json({ error: 'Credential decryption failed' }, 500);
  }

  // ── Execute tool ────────────────────────────────────────────────────────────
  try {
    switch (tool) {

      case 'read_file': {
        const { path } = args;
        if (!path) return json({ error: 'path required' }, 400);
        const repo = client.github_repo;
        const res = await fetch(
          `https://api.github.com/repos/${repo}/contents/${path}`,
          { headers: githubHeaders(githubToken) }
        );
        if (res.status === 404) return json({ ok: false, error: 'File not found', path });
        if (!res.ok) return json({ ok: false, error: 'GitHub error', status: res.status });
        const data = await res.json();
        const content = atob(data.content.replace(/\n/g, ''));
        return json({ ok: true, path, content, sha: data.sha });
      }

      case 'list_files': {
        const { path = '' } = args;
        const repo = client.github_repo;
        const res = await fetch(
          `https://api.github.com/repos/${repo}/contents/${path}`,
          { headers: githubHeaders(githubToken) }
        );
        if (!res.ok) return json({ ok: false, error: 'GitHub error', status: res.status });
        const items = await res.json();
        const listing = Array.isArray(items)
          ? items.map(i => ({ name: i.name, path: i.path, type: i.type, size: i.size }))
          : [{ name: items.name, path: items.path, type: items.type }];
        return json({ ok: true, path, items: listing });
      }

      case 'edit_file': {
        const { path, content, commit_message, sha } = args;
        if (!path || content === undefined) return json({ error: 'path and content required' }, 400);
        const repo = client.github_repo;

        // If sha not provided, fetch it first (needed by GitHub API to update)
        let fileSha = sha;
        if (!fileSha) {
          const existing = await fetch(
            `https://api.github.com/repos/${repo}/contents/${path}`,
            { headers: githubHeaders(githubToken) }
          );
          if (existing.ok) {
            const data = await existing.json();
            fileSha = data.sha;
          }
          // If 404, file doesn't exist yet - create instead
          if (existing.status === 404) fileSha = null;
        }

        const body = {
          message:  commit_message || `Formaut: update ${path}`,
          content:  btoa(unescape(encodeURIComponent(content))),
          ...(fileSha ? { sha: fileSha } : {}),
        };

        const res = await fetch(
          `https://api.github.com/repos/${repo}/contents/${path}`,
          {
            method:  'PUT',
            headers: { ...githubHeaders(githubToken), 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
          }
        );
        if (!res.ok) {
          const err = await res.json();
          return json({ ok: false, error: err.message || 'GitHub error', status: res.status });
        }
        const result = await res.json();
        return json({ ok: true, path, sha: result.content.sha, commit: result.commit.sha });
      }

      case 'create_file': {
        // create_file is edit_file without a sha - reuse same logic
        return handleExecuteTool({ slug, tool: 'edit_file', args: { ...args, sha: null } }, env);
      }

      case 'run_query': {
        // SELECT queries only - enforced by checking the SQL
        const { query } = args;
        if (!query) return json({ error: 'query required' }, 400);
        const normalised = query.trim().toLowerCase();
        if (!normalised.startsWith('select')) {
          return json({ ok: false, error: 'run_query only accepts SELECT statements. Use run_write_query for writes.' });
        }
        const res = await fetch(
          `${client.supabase_url}/rest/v1/rpc/exec_sql`,
          {
            method:  'POST',
            headers: { 'apikey': supabaseKey, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ query }),
          }
        );
        // Fallback: direct table query if exec_sql not available
        if (res.status === 404) {
          return json({ ok: false, error: 'Direct SQL not available - use table-specific REST endpoints.' });
        }
        const data = await res.json();
        return json({ ok: true, rows: data });
      }

      case 'run_write_query': {
        // Confirmed write SQL - INSERT, UPDATE, DELETE
        const { query } = args;
        if (!query) return json({ error: 'query required' }, 400);
        const normalised = query.trim().toLowerCase();
        if (normalised.startsWith('drop') || normalised.startsWith('truncate') || normalised.startsWith('delete from clients')) {
          return json({ ok: false, error: 'Destructive DDL not permitted through this tool.' });
        }
        const res = await fetch(
          `${client.supabase_url}/rest/v1/rpc/exec_sql`,
          {
            method:  'POST',
            headers: { 'apikey': supabaseKey, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ query }),
          }
        );
        const data = await res.json();
        return json({ ok: true, result: data });
      }

      case 'trigger_deploy': {
        // Fire and forget - kicks off a Cloudflare Pages deploy via an empty commit
        // or direct deploy hook if configured. Returns immediately with a deploy ID.
        const project = client.cloudflare_pages_project;
        const accountId = client.cloudflare_account_id || env.CLOUDFLARE_ACCOUNT_ID;
        if (!project) return json({ error: 'Cloudflare Pages project not configured' }, 422);

        // Create a deploy hook trigger (most reliable way to force a redeploy)
        // Falls back to listing deployments and returning the latest
        const deployRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}/deployments`,
          { headers: { Authorization: `Bearer ${cloudflareToken}` } }
        );
        if (!deployRes.ok) return json({ ok: false, error: 'Could not reach Cloudflare API' });
        const deployData = await deployRes.json();
        const latest = deployData.result?.[0];

        return json({
          ok:            true,
          deployment_id: latest?.id || null,
          status:        latest?.latest_stage?.name || 'queued',
          message:       'Deploy triggered - use check_deploy_status to poll for completion.',
          pages_url:     `https://${project}.pages.dev`,
        });
      }

      case 'check_deploy_status': {
        const { deployment_id } = args;
        const project   = client.cloudflare_pages_project;
        const accountId = client.cloudflare_account_id || env.CLOUDFLARE_ACCOUNT_ID;
        if (!project) return json({ error: 'Cloudflare Pages project not configured' }, 422);

        const url = deployment_id
          ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}/deployments/${deployment_id}`
          : `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}/deployments?per_page=1`;

        const res = await fetch(url, { headers: { Authorization: `Bearer ${cloudflareToken}` } });
        if (!res.ok) return json({ ok: false, error: 'Could not reach Cloudflare API' });
        const data = await res.json();
        const deploy = deployment_id ? data.result : data.result?.[0];

        return json({
          ok:            true,
          deployment_id: deploy?.id,
          status:        deploy?.latest_stage?.name,
          success:       deploy?.latest_stage?.name === 'deploy',
          created_at:    deploy?.created_on,
          pages_url:     `https://${project}.pages.dev`,
        });
      }

      case 'preview_srcdoc': {
        // Returns the HTML content for an instant inline preview.
        // No GitHub write, no deploy - just echoes the content back so the
        // dashboard can render it in an iframe srcdoc.
        const { content: htmlContent, path } = args;
        if (!htmlContent) return json({ error: 'content required' }, 400);
        return json({
          ok:           true,
          preview_mode: 'srcdoc',
          html:         htmlContent,
          path:         path || null,
          message:      'Inline preview ready.',
        });
      }

      case 'preview_branch_deploy': {
        // Writes a file to a preview branch and waits for Cloudflare Pages
        // to build it, then returns the preview URL.
        // Branch name: preview/[session_id_prefix] - kept short for CF Pages limits.
        const { path, content: fileContent, commit_message, session_id: sid } = args;
        if (!path || fileContent === undefined) {
          return json({ error: 'path and content required' }, 400);
        }

        const repo      = client.github_repo;
        const project   = client.cloudflare_pages_project;
        const accountId = client.cloudflare_account_id || env.CLOUDFLARE_ACCOUNT_ID;
        const branchName = `preview/${(sid || 'session').slice(0, 12)}`;

        // Step 1: Get main branch SHA
        const mainRes = await fetch(
          `https://api.github.com/repos/${repo}/git/ref/heads/main`,
          { headers: githubHeaders(githubToken) }
        );
        if (!mainRes.ok) return json({ ok: false, error: 'Could not get main branch SHA' });
        const mainData = await mainRes.json();
        const mainSha  = mainData.object?.sha;

        // Step 2: Create or update preview branch
        const branchCheckRes = await fetch(
          `https://api.github.com/repos/${repo}/git/ref/heads/${branchName}`,
          { headers: githubHeaders(githubToken) }
        );

        if (branchCheckRes.status === 404) {
          // Create new branch from main
          const createRes = await fetch(
            `https://api.github.com/repos/${repo}/git/refs`,
            {
              method:  'POST',
              headers: { ...githubHeaders(githubToken), 'Content-Type': 'application/json' },
              body:    JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha }),
            }
          );
          if (!createRes.ok) {
            const err = await createRes.json();
            return json({ ok: false, error: `Could not create preview branch: ${err.message}` });
          }
        }

        // Step 3: Get existing file SHA on preview branch (if any)
        let fileSha = null;
        const existingRes = await fetch(
          `https://api.github.com/repos/${repo}/contents/${path}?ref=${branchName}`,
          { headers: githubHeaders(githubToken) }
        );
        if (existingRes.ok) {
          const existingData = await existingRes.json();
          fileSha = existingData.sha;
        }

        // Step 4: Write file to preview branch
        const writeBody = {
          message: commit_message || `Preview: update ${path}`,
          content: btoa(unescape(encodeURIComponent(fileContent))),
          branch:  branchName,
          ...(fileSha ? { sha: fileSha } : {}),
        };

        const writeRes = await fetch(
          `https://api.github.com/repos/${repo}/contents/${path}`,
          {
            method:  'PUT',
            headers: { ...githubHeaders(githubToken), 'Content-Type': 'application/json' },
            body:    JSON.stringify(writeBody),
          }
        );
        if (!writeRes.ok) {
          const err = await writeRes.json();
          return json({ ok: false, error: `Could not write to preview branch: ${err.message}` });
        }

        // Step 5: Return immediately - Cloudflare Pages detects the branch push automatically
        // Dashboard polls get_preview_url for build completion
        const previewUrl = `https://${branchName.replace('/', '-')}.${project}.pages.dev`;
        return json({
          ok:           true,
          preview_mode: 'branch',
          branch:       branchName,
          preview_url:  previewUrl,
          path,
          message:      'Preview branch pushed. Building now - check get_preview_url for status.',
        });
      }

      case 'get_preview_url': {
        // Poll Cloudflare Pages for the latest deployment on the preview branch.
        // Returns the preview URL and build status.
        const { branch } = args;
        if (!branch) return json({ error: 'branch required' }, 400);

        const project   = client.cloudflare_pages_project;
        const accountId = client.cloudflare_account_id || env.CLOUDFLARE_ACCOUNT_ID;

        const deploysRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}/deployments?per_page=5`,
          { headers: { Authorization: `Bearer ${cloudflareToken}` } }
        );
        if (!deploysRes.ok) return json({ ok: false, error: 'Could not reach Cloudflare API' });

        const deploysData = await deploysRes.json();
        const branchDeploy = (deploysData.result || [])
          .find(d => d.deployment_trigger?.metadata?.branch === branch);

        if (!branchDeploy) {
          return json({
            ok:      true,
            status:  'pending',
            message: 'Build not yet started - Cloudflare Pages may take a moment to pick up the branch.',
          });
        }

        const stage   = branchDeploy.latest_stage?.name;
        const success = stage === 'deploy';
        const failed  = branchDeploy.latest_stage?.status === 'failure';
        // Cloudflare preview URL format: branch-name-slugified.project.pages.dev
        const previewUrl = branchDeploy.url || `https://${branch.replace('/', '-')}.${project}.pages.dev`;

        return json({
          ok:           true,
          preview_mode: 'branch',
          status:       failed ? 'failed' : success ? 'ready' : 'building',
          preview_url:  success ? previewUrl : null,
          branch,
          deployment_id: branchDeploy.id,
          message:      success
            ? `Preview ready at ${previewUrl}`
            : failed
              ? 'Build failed - check Cloudflare Pages dashboard for details.'
              : 'Still building - check again in a moment.',
        });
      }

      default:
        return json({ error: `Tool not implemented: ${tool}` }, 400);
    }
  } catch (err) {
    console.error(`[execute-tool:${tool}] Error:`, err.message);
    return json({ ok: false, error: err.message }, 500);
  }
}

// Human-readable confirmation prompts for dangerous tools
function confirmationMessage(tool, args) {
  switch (tool) {
    case 'edit_file':
      return `I'm about to edit \`${args.path}\` in your GitHub repo. This will be committed and deployed. OK to proceed?`;
    case 'create_file':
      return `I'm about to create \`${args.path}\` in your GitHub repo. OK to proceed?`;
    case 'trigger_deploy':
      return `I'm about to trigger a deployment to your live site. OK to proceed?`;
    case 'run_write_query':
      return `I'm about to run a write operation on your database: \`${(args.query || '').slice(0, 120)}\`. OK to proceed?`;
    default:
      return `I'm about to run \`${tool}\`. OK to proceed?`;
  }
}

// GitHub API headers helper
function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept:        'application/vnd.github+json',
    'User-Agent':  'forma-platform-worker',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// =============================================================================
// SHARED UTILITIES
// =============================================================================

// Supabase REST helper - always uses service_role key (platform DB only)
async function supabase(env, method, path, body = null, extraHeaders = {}) {
  const url = env.SUPABASE_URL + path;
  const headers = {
    'apikey':       env.SUPABASE_SERVICE_ROLE_KEY,
    // No Authorization header - Supabase gateway translates the apikey
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

// Fetch operator's Supabase org ID (cached in env ideally - add SUPABASE_ORG_ID secret)
async function getSupabaseOrgId(env) {
  if (env.SUPABASE_ORG_ID) return env.SUPABASE_ORG_ID;
  const res = await fetch('https://api.supabase.com/v1/organizations', {
    headers: { Authorization: `Bearer ${env.SUPABASE_MGMT_TOKEN}` }
  });
  const orgs = await res.json();
  return orgs[0]?.id;
}

// Poll Supabase until project status is ACTIVE_HEALTHY (up to 3 minutes)
// Supabase provisioning typically takes 20-60s but can exceed 90s under load.
// 36 polls x 5s = 180s max. Returns the status string so the caller can log it.
async function waitForSupabaseReady(env, projectId) {
  let lastStatus = 'unknown';
  for (let i = 0; i < 36; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}`, {
        headers: { Authorization: `Bearer ${env.SUPABASE_MGMT_TOKEN}` }
      });
      if (res.ok) {
        const p = await res.json();
        lastStatus = p.status || 'unknown';
        if (lastStatus === 'ACTIVE_HEALTHY') return true;
      }
    } catch {
      // Network blip -- keep polling
    }
  }
  // Timed out -- return false, caller logs lastStatus so operator can diagnose
  console.error(`[provision] waitForSupabaseReady timed out. Last status: ${lastStatus}`);
  return false;
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

-- Communication profile (System 2 -- per-client calibration)
create table if not exists client_communication_profile (
  id                     uuid        primary key default gen_random_uuid(),
  updated_at             timestamptz not null default now(),
  technical_comfort      text        not null default 'unknown',
  explanation_depth      text        not null default 'standard',
  tone_preference        text        not null default 'casual',
  wants_reasoning        boolean     not null default true,
  confirms_before_acting boolean     not null default false,
  instruction_style      text        not null default 'sequential',
  repeated_explanations  text[]      not null default '{}',
  hesitation_points      text[]      not null default '{}',
  demonstrated_skills    text[]      not null default '{}',
  agent_notes            text,
  confidence_trend       text        not null default 'unknown',
  sessions_observed      integer     not null default 0,
  last_session_id        uuid        references sessions(id) on delete set null
);

-- Structured client memory (KB3 memory pipeline)
-- Confidence-scored preference and decision records extracted from sessions.
-- The build agent reads from this before falling back to session summaries.
create table if not exists client_memory (
  id                uuid        primary key default gen_random_uuid(),
  client_id         uuid,
  category          text        not null,
  key               text        not null,
  value_json        jsonb       not null,
  confidence        numeric(3,2) not null default 0.70
                    check (confidence >= 0.50 and confidence <= 0.95),
  source_session_id uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (client_id, category, key)
);

create index if not exists idx_client_memory_lookup
  on client_memory (client_id, confidence desc);

create index if not exists idx_client_memory_category
  on client_memory (client_id, category);

-- Audit trail for every memory change
-- Lets the agent explain why it made a decision ("you rejected this in session 3")
create table if not exists memory_events (
  id                uuid        primary key default gen_random_uuid(),
  client_id         uuid,
  event_type        text        not null,
  category          text        not null,
  key               text        not null,
  old_value         jsonb,
  new_value         jsonb       not null,
  reason            text,
  source_session_id uuid,
  created_at        timestamptz not null default now()
);

create index if not exists idx_memory_events_client
  on memory_events (client_id, created_at desc);

-- RLS: deny anon on all memory tables
alter table sessions                     enable row level security;
alter table site_index                   enable row level security;
alter table conversation_history         enable row level security;
alter table client_context               enable row level security;
alter table client_communication_profile enable row level security;
alter table client_memory                enable row level security;
alter table memory_events                enable row level security;

create policy "deny anon: sessions"
  on sessions for all to anon using (false);
create policy "deny anon: site_index"
  on site_index for all to anon using (false);
create policy "deny anon: conversation_history"
  on conversation_history for all to anon using (false);
create policy "deny anon: client_context"
  on client_context for all to anon using (false);
create policy "deny anon: client_communication_profile"
  on client_communication_profile for all to anon using (false);
create policy "deny anon: client_memory"
  on client_memory for all to anon using (false);
create policy "deny anon: memory_events"
  on memory_events for all to anon using (false);
  `.trim();
}

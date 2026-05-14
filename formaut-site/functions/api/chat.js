// functions/api/chat.js
// Cloudflare Pages Function — client chat endpoint
//
// Canonical pipeline (every message, no exceptions):
//   1. Verify Google id_token
//   2. POST /chat/preflight on platform Worker
//        → cost gate (deterministic cheap-intent handler)
//        → scope guard (out-of-scope redirect)
//        → routing metadata: { should_call_llm, model, max_tokens, intent, context_policy }
//   3. If should_call_llm === false → return preflight response directly (free)
//   4. If should_call_llm === true:
//        a. Fetch session context (Tier 1 + Tier 2 + memory) — cached after turn 1
//        b. Select minimal context pack via context_policy from preflight
//        c. Build system prompt
//        d. Run agentic loop against Anthropic
//        e. Post-session: /signals (non-blocking waitUntil)
//   5. Return response
//
// The client never holds an Anthropic API key.
// The Worker holds ENCRYPTION_KEY — chat.js never decrypts credentials.

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return cors(null, 204);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // ── Auth ────────────────────────────────────────────────────────────────────
  const authHeader = request.headers.get('Authorization') || '';
  const googleToken = authHeader.replace('Bearer ', '').trim();
  if (!googleToken) return json({ error: 'Unauthorized' }, 401);

  let verifiedEmail;
  try {
    const tokenRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${googleToken}`
    );
    if (!tokenRes.ok) throw new Error('Token invalid');
    const tokenData = await tokenRes.json();
    if (tokenData.aud !== env.GOOGLE_CLIENT_ID) {
      return json({ error: 'Token audience mismatch' }, 401);
    }
    verifiedEmail = tokenData.email;
  } catch {
    return json({ error: 'Token verification failed' }, 401);
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const {
    message,
    history        = [],
    client_id,
    session_id,
    session_context,
    chat_mode      = 'general',
  } = body;

  if (!message || message.trim().length === 0) return json({ error: 'Message is required' }, 400);
  if (message.length > 4000) return json({ error: 'Message too long' }, 400);
  if (!client_id) return json({ error: 'client_id is required' }, 400);

  const VALID_MODES = new Set(['general', 'admin', 'email', 'operator']);
  const resolvedMode = VALID_MODES.has(chat_mode) ? chat_mode : 'general';

  const isOperator = Boolean(env.OPERATOR_EMAIL && verifiedEmail === env.OPERATOR_EMAIL);
  const effectiveMode = (resolvedMode === 'operator' && !isOperator) ? 'general' : resolvedMode;

  // ── STEP 1: Canonical preflight — cost gate + scope guard ───────────────────
  // Every message goes through this before any Anthropic call.
  // Returns: { should_call_llm, model, max_tokens, intent, context_policy, response, ... }
  let preflight;
  try {
    const preflightRes = await fetch(`${env.PLATFORM_WORKER_URL}/chat/preflight`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-worker-secret': env.WORKER_SECRET,
      },
      body: JSON.stringify({
        message,
        slug:       client_id,
        session_id: session_id || null,
        user_id:    verifiedEmail,
        is_operator: isOperator,
      }),
    });
    if (!preflightRes.ok) throw new Error('Preflight ' + preflightRes.status);
    preflight = await preflightRes.json();
  } catch (err) {
    // Preflight failure is non-fatal — log and fall through to LLM with defaults.
    // This prevents the platform worker going down from silencing the chat entirely.
    console.error('Preflight failed:', err.message);
    preflight = {
      ok:              true,
      handled_by:      'fallback',
      should_call_llm: true,
      model:           'claude-sonnet-4-20250514',
      max_tokens:      4096,
      intent:          { type: 'unknown', confidence: 0 },
      context_policy:  'full',
    };
  }

  // ── STEP 2: Cost gate / scope guard handled it deterministically ────────────
  // Free path: no Anthropic call, no context fetch.
  if (!preflight.should_call_llm) {
    return json({
      response:     preflight.response || preflight.route?.response || null,
      session_id:   session_id || crypto.randomUUID(),
      chat_mode:    effectiveMode,
      is_operator:  isOperator,
      handled_by:   preflight.handled_by,
      intent:       preflight.intent,
      blocked:      preflight.blocked || false,
      block_reason: preflight.block_reason || null,
    });
  }

  // ── STEP 3: Context resolution — Tier 1 + Tier 2 + memory ──────────────────
  // Fetched once on turn 1, cached in session_context and echoed back each turn.
  let clientRecord;
  let sessionSummaries = [];
  let commProfile      = null;
  let clientMemory     = [];
  let businessProfile  = null;
  const isFirstTurn = !session_context || !session_context.client;

  if (!isFirstTurn) {
    clientRecord     = session_context.client;
    sessionSummaries = session_context.session_summaries || [];
    commProfile      = session_context.comm_profile      || null;
    clientMemory     = session_context.client_memory     || [];
    businessProfile  = session_context.business_profile  || null;

    const adminEmails = clientRecord.admin_emails || [];
    if (!adminEmails.includes(verifiedEmail) && !isOperator) {
      return json({ error: 'Forbidden' }, 403);
    }
  } else {
    // First turn — fetch Tier 1 from platform Supabase
    try {
      const res = await fetch(
        `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?slug=eq.${encodeURIComponent(client_id)}&select=*&limit=1`,
        { headers: { 'apikey': env.PLATFORM_SUPABASE_SERVICE_KEY } }
      );
      const rows = res.ok ? await res.json() : [];
      clientRecord = rows[0] || null;
    } catch {
      clientRecord = null;
    }

    if (!clientRecord) return json({ error: 'Client not found' }, 404);

    const adminEmails = clientRecord.admin_emails || [];
    if (!adminEmails.includes(verifiedEmail) && !isOperator) {
      return json({ error: 'Forbidden' }, 403);
    }

    // Tier 2-5: session summaries, comm profile, client memory, business profile
    // Fetched via platform Worker — handles decryption internally.
    try {
      const clientDataRes = await fetch(`${env.PLATFORM_WORKER_URL}/client-data`, {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'x-worker-secret': env.WORKER_SECRET,
        },
        body: JSON.stringify({ slug: client_id }),
      });
      if (clientDataRes.ok) {
        const clientData = await clientDataRes.json();
        sessionSummaries = clientData.session_summaries || [];
        commProfile      = clientData.comm_profile      || null;
        clientMemory     = clientData.client_memory     || [];
        businessProfile  = clientData.business_profile  || null;
      }
    } catch {
      // Non-fatal — agent continues without Tier 2 context
    }
  }

  // ── STEP 4: Context selection — only what this intent needs ────────────────
  // preflight.context_policy is one of: 'full' | 'identity' | 'minimal' | 'none'
  // For conversational turns the cost gate already returned; everything reaching
  // here is action/ambiguous — use full context unless preflight says otherwise.
  const contextPack = selectContextForIntent({
    intent:          preflight.intent,
    context_policy:  preflight.context_policy || 'full',
    business_profile: businessProfile,
    client_memory:   clientMemory,
    session_summaries: sessionSummaries,
    message,
  });

  // ── STEP 5: Build system prompt ─────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(
    clientRecord,
    contextPack,
    commProfile,
    effectiveMode,
    isOperator,
  );

  // ── STEP 6: Prepare conversation ────────────────────────────────────────────
  const safeHistory = (Array.isArray(history) ? history : [])
    .filter(m => m.role && m.content && typeof m.content === 'string')
    .slice(-20)
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

  const messages = [
    ...safeHistory,
    { role: 'user', content: message },
  ];

  // ── STEP 7: Tool definitions (mode-gated) ───────────────────────────────────
  const TOOL_WHITELIST = {
    general:  ['read_file', 'list_files', 'edit_file', 'trigger_deploy', 'check_deploy_status', 'run_query', 'run_write_query', 'preview_srcdoc', 'preview_branch_deploy', 'get_preview_url'],
    admin:    ['read_file', 'list_files', 'edit_file', 'trigger_deploy', 'check_deploy_status', 'run_query', 'run_write_query', 'preview_srcdoc'],
    email:    ['read_file', 'list_files', 'edit_file', 'preview_srcdoc', 'run_query'],
    operator: ['read_file', 'list_files', 'edit_file', 'trigger_deploy', 'check_deploy_status', 'run_query', 'run_write_query', 'preview_srcdoc', 'preview_branch_deploy', 'get_preview_url', 'platform_query', 'platform_action'],
  };

  const allowedTools = new Set(TOOL_WHITELIST[effectiveMode] || TOOL_WHITELIST.general);

  // Use preflight's model + max_tokens recommendation — cost gate already
  // chose the right tier (Haiku for simple, Sonnet for action/build).
  const model     = preflight.route?.model     || preflight.model     || 'claude-sonnet-4-20250514';
  const maxTokens = preflight.route?.max_tokens || preflight.max_tokens || 4096;

  // Tools are always included for action intents reaching this point.
  // Preflight already filtered conversational → no-LLM; everything here needs tools.
  const tools = ALL_TOOLS.filter(t => allowedTools.has(t.name));

  // ── STEP 8: Agentic loop ────────────────────────────────────────────────────
  let agentResponse = '';
  const toolCalls = [];
  let pendingConfirmation = null;

  try {
    let loopMessages = [...messages];
    let iterations = 0;
    const MAX_ITERATIONS = 10;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta':    'prompt-caching-2024-07-31',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          // Prompt caching — system prompt is identical each turn of a session.
          // Saves ~70% on input tokens from turn 2 onwards.
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          tools,
          tool_choice: { type: 'auto' },
          messages:    loopMessages,
        }),
      });

      if (!claudeRes.ok) {
        const errBody = await claudeRes.text();
        console.error('Claude API error:', claudeRes.status, errBody);
        throw new Error('Claude API error ' + claudeRes.status);
      }

      const claudeData   = await claudeRes.json();
      const stopReason   = claudeData.stop_reason;
      const contentBlocks = claudeData.content || [];

      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          agentResponse += block.text;
        }
      }

      if (stopReason === 'end_turn' || !contentBlocks.some(b => b.type === 'tool_use')) {
        break;
      }

      const toolResults = [];
      for (const block of contentBlocks) {
        if (block.type !== 'tool_use') continue;

        const toolName  = block.name;
        const toolArgs  = block.input || {};
        const toolUseId = block.id;

        toolCalls.push({ tool: toolName, args: toolArgs, id: toolUseId });

        let execData;

        if (toolName === 'platform_query' && isOperator) {
          const pqRes = await fetch(`${env.PLATFORM_WORKER_URL}/platform-query`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-worker-secret': env.WORKER_SECRET },
            body: JSON.stringify({ query: toolArgs.query }),
          });
          execData = await pqRes.json();
        } else if (toolName === 'platform_action' && isOperator) {
          const paRes = await fetch(`${env.PLATFORM_WORKER_URL}/platform-action`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-worker-secret': env.WORKER_SECRET },
            body: JSON.stringify({ action: toolArgs.action, payload: toolArgs.payload || {}, operator_email: verifiedEmail }),
          });
          execData = await paRes.json();
        } else {
          const execRes = await fetch(`${env.PLATFORM_WORKER_URL}/execute-tool`, {
            method:  'POST',
            headers: {
              'Content-Type':    'application/json',
              'x-worker-secret': env.WORKER_SECRET,
            },
            body: JSON.stringify({
              slug: client_id,
              tool: toolName,
              args: toolArgs,
            }),
          });
          execData = await execRes.json();
        }

        if (execData.requires_confirmation) {
          pendingConfirmation = {
            tool:    toolName,
            args:    toolArgs,
            message: execData.message,
          };
          toolResults.push({
            type:        'tool_result',
            tool_use_id: toolUseId,
            content:     `Paused: this action requires client confirmation. Tell the client: "${execData.message}" and wait for them to confirm before proceeding.`,
          });
        } else {
          toolCalls[toolCalls.length - 1].result = execData;
          toolResults.push({
            type:        'tool_result',
            tool_use_id: toolUseId,
            content:     JSON.stringify(execData),
          });
        }

        if (pendingConfirmation) break;
      }

      loopMessages = [
        ...loopMessages,
        { role: 'assistant', content: contentBlocks },
        { role: 'user',      content: toolResults },
      ];

      if (pendingConfirmation) continue;
    }

    if (!agentResponse && !pendingConfirmation) {
      agentResponse = 'Task complete.';
    }

  } catch (err) {
    console.error('Agent loop failed:', err);
    return json({ error: 'Agent unavailable — please try again in a moment.' }, 502);
  }

  // ── STEP 9: Post-session extraction — non-blocking ──────────────────────────
  const currentSessionId = session_id || crypto.randomUUID();
  const fullHistory = [
    ...safeHistory,
    { role: 'user',      content: message },
    { role: 'assistant', content: agentResponse },
  ];

  context.waitUntil(
    runSessionEndExtraction(env, clientRecord, currentSessionId, fullHistory, !session_id)
  );

  // ── STEP 10: Extract preview data and respond ───────────────────────────────
  let previewSrcdoc = null;
  let previewUrl    = null;
  let previewBranch = null;

  for (const tc of toolCalls) {
    if (tc.result?.preview_mode === 'srcdoc' && tc.result?.html) previewSrcdoc = tc.result.html;
    if (tc.result?.preview_mode === 'branch') {
      previewBranch = tc.result.branch;
      if (tc.result?.preview_url) previewUrl = tc.result.preview_url;
    }
  }

  const responsePayload = {
    response:             agentResponse,
    session_id:           currentSessionId,
    chat_mode:            effectiveMode,
    is_operator:          isOperator,
    intent:               preflight.intent,
    handled_by:           'llm',
    tool_calls:           toolCalls.length > 0 ? toolCalls : undefined,
    pending_confirmation: pendingConfirmation || undefined,
    preview_srcdoc:       previewSrcdoc  || undefined,
    preview_url:          previewUrl     || undefined,
    preview_branch:       previewBranch  || undefined,
  };

  if (isFirstTurn) {
    const safeClient = { ...clientRecord };
    delete safeClient.supabase_service_key_enc;
    delete safeClient.supabase_anon_key_enc;
    delete safeClient.github_token_enc;
    delete safeClient.cloudflare_token_enc;
    delete safeClient.supabase_mgmt_token_enc;
    delete safeClient.printify_key_enc;

    responsePayload.session_context = {
      client:            safeClient,
      session_summaries: sessionSummaries,
      comm_profile:      commProfile,
      client_memory:     clientMemory,
      business_profile:  businessProfile,
    };
  }

  return json(responsePayload);
}


// =============================================================================
// CONTEXT SELECTOR
// =============================================================================
// Picks only the fields the current intent actually needs.
// Keeps system prompt lean on conversational and simple turns.
// context_policy is set by the platform worker's preflight based on intent type.
// =============================================================================

const PROFILE_FIELD_GROUPS = {
  identity:  ['business_name', 'industry', 'industry_category', 'target_customer', 'key_differentiators'],
  contact:   ['phone', 'email', 'website_url', 'booking_url', 'location', 'hours', 'service_area'],
  offerings: ['services', 'products', 'price_range', 'common_questions'],
  brand:     ['brand_tone', 'social_voice', 'emotional_goal', 'visual_style', 'primary_colors', 'secondary_colors', 'logo_url'],
  goals:     ['site_goal', 'feature_fit', 'feature_avoid', 'design_confidence_level', 'profile_confidence'],
};

const POLICY_GROUPS = {
  full:     ['identity', 'contact', 'offerings', 'brand', 'goals'],
  identity: ['identity', 'goals'],
  minimal:  ['identity'],
  none:     [],
};

function selectContextForIntent({ intent, context_policy, business_profile, client_memory, session_summaries, message }) {
  const groups = new Set(POLICY_GROUPS[context_policy] || POLICY_GROUPS.full);

  // Augment based on message keywords regardless of policy
  const text = String(message || '').toLowerCase();
  if (/phone|email|address|hours|contact|booking|location/.test(text)) groups.add('contact');
  if (/service|offer|product|price|package/.test(text)) groups.add('offerings');
  if (/tone|voice|brand|color|logo|style|visual/.test(text)) groups.add('brand');
  if (/homepage|landing|site|cta|conversion|seo|goal|feature/.test(text)) groups.add('goals');

  // Pick profile fields
  const profileOut = {};
  const wantedFields = new Set(
    [...groups].flatMap(g => PROFILE_FIELD_GROUPS[g] || [])
  );
  for (const field of wantedFields) {
    const value = business_profile?.[field];
    if (value !== undefined && value !== null &&
        !(Array.isArray(value) && value.length === 0)) {
      profileOut[field] = value;
    }
  }

  // Pick memory (top by confidence, capped at 12)
  const allowedMemCats = new Set([...groups, 'avoid', 'preference', 'decision']);
  const selectedMemory = (client_memory || [])
    .filter(m => allowedMemCats.has(m.category))
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, 12);

  // Last 5 session summaries always useful for action intents
  const selectedSessions = (session_summaries || []).slice(0, 5);

  return { profile: profileOut, memory: selectedMemory, sessions: selectedSessions };
}


// =============================================================================
// SYSTEM PROMPT
// =============================================================================

function buildSystemPrompt(client, contextPack, commProfile, mode, isOperator) {
  const live_url   = client.live_url   || '';
  const github     = client.github_repo  || '';
  const supabase   = client.supabase_url || '';
  const stripe_acc = client.stripe_connected_account || '';
  const plan       = client.tier || 'standard';
  const status     = client.status || 'live';
  const slug       = client.slug || '';

  const sessionContext = contextPack.sessions.length > 0
    ? contextPack.sessions.map((s, i) => {
        const changes = Array.isArray(s.changes_made) && s.changes_made.length
          ? '\n  Changes: ' + s.changes_made.join(', ')
          : '';
        return `  ${i + 1}. ${s.summary || 'Session'}${changes}`;
      }).join('\n')
    : '  No previous sessions yet.';

  const memoryContext  = buildMemoryContext(contextPack.memory);
  const profileContext = buildProfileContext(commProfile);
  const businessBlock  = buildBusinessProfileBlock(contextPack.profile);

  if (mode === 'admin')    return buildAdminPrompt({ client, slug, live_url, github, supabase, sessionContext, memoryContext, profileContext, businessBlock });
  if (mode === 'email')    return buildEmailPrompt({ client, slug, live_url, github, supabase, sessionContext, memoryContext, profileContext });
  if (mode === 'operator') return buildOperatorPrompt({ client, slug, live_url, github, supabase, stripe_acc, plan, status, sessionContext });

  return buildGeneralPrompt({ client, slug, live_url, github, supabase, stripe_acc, plan, status, sessionContext, memoryContext, profileContext, businessBlock });
}

function buildBusinessProfileBlock(profile) {
  if (!profile || Object.keys(profile).length === 0) return '';
  const lines = [];
  if (profile.business_name)    lines.push(`Business: ${profile.business_name}`);
  if (profile.industry)         lines.push(`Industry: ${profile.industry}`);
  if (profile.target_customer)  lines.push(`Audience: ${profile.target_customer}`);
  if (profile.site_goal)        lines.push(`Site goal: ${profile.site_goal}`);
  if (profile.brand_tone?.length) lines.push(`Brand tone: ${profile.brand_tone.join(', ')}`);
  if (profile.primary_colors?.length) lines.push(`Colors: ${profile.primary_colors.join(', ')}`);
  if (profile.services?.length) lines.push(`Services: ${profile.services.slice(0, 6).join(', ')}`);
  if (profile.phone)   lines.push(`Phone: ${profile.phone}`);
  if (profile.email)   lines.push(`Email: ${profile.email}`);
  if (profile.hours && Object.keys(profile.hours).length) {
    lines.push(`Hours: ${JSON.stringify(profile.hours)}`);
  }
  if (profile.feature_fit?.length)   lines.push(`Use: ${profile.feature_fit.join(', ')}`);
  if (profile.feature_avoid?.length) lines.push(`Avoid: ${profile.feature_avoid.join(', ')}`);
  return lines.length ? `\n## Business profile\n${lines.join('\n')}\n` : '';
}

function buildGeneralPrompt({ slug, live_url, github, supabase, stripe_acc, plan, status, sessionContext, memoryContext, profileContext, businessBlock }) {
  return `You are Formaut — an AI web contractor that builds, deploys, and maintains websites for small business owners. You work autonomously and translate plain language into real technical action.

## Client
Slug: ${slug || 'unknown'} | Plan: ${plan} | Status: ${status}
Live site: ${live_url || 'not yet configured'}
GitHub: ${github || 'not yet created'}
Supabase: ${supabase || 'not yet created'}${stripe_acc ? `\nStripe: ${stripe_acc}` : ''}
${businessBlock}
## Recent sessions
${sessionContext}
${memoryContext}
---

## Core principle — infer, don't interrogate

You are a contractor, not a consultant. When a client tells you what they want, you figure out how to build it. You never ask them to explain the technical steps. You act.

Plain language maps to full technical execution, invisibly:
- "I want to take bookings" → add booking form, wire backend, update DB schema, deploy
- "I want to accept payments" → set up Stripe checkout, configure webhooks, set env vars, deploy
- "Add a specials board" → design section, add to page, deploy
- "My address changed" → find every instance across all pages, update all, deploy

The client never needs to know what a webhook is, what a schema is, or what a deploy is. That is your job.

The only time you ask a question is when the answer genuinely changes what you build:
GOOD: "What's the new address?" / "What days are you open for bookings?"
NEVER: "Should I use Stripe or PayPal?" / "Do you want me to update the database too?"

---

## Planning — narrate before acting on complex tasks

For tasks requiring more than two tool calls, briefly state the plan first:
"I'll add the contact form section, wire it to log submissions in your database, then deploy. Starting now."

Then execute without waiting for approval. Confirmation gates only appear for genuinely destructive or irreversible actions.

For simple tasks (single text change, single file edit), skip the narration — just do it.

---

## Memory — use structured memory, then session history

Memory above 0.80 confidence is ground truth — apply it automatically.
Memory marked [use cautiously] is directional — apply it but stay aware.
If the client contradicts stored memory this session, follow their current request.

---

## Error recovery — exhaust alternatives before escalating

If a tool call fails: try an alternative approach silently first. Only tell the client when you've genuinely exhausted alternatives. When you do surface an error: say what you tried, what failed, and what they can do.

---

## Communication
Specific over vague. "Updated your phone number on 3 pages and deployed." Not "I'd be happy to help."
Plain language with non-technical clients. Technical precision with technical ones.
${profileContext}`;
}

function buildAdminPrompt({ slug, live_url, github, supabase, sessionContext, memoryContext, profileContext, businessBlock }) {
  return `You are Formaut, helping ${slug || 'this business'} with their site admin panel.

## Context
Live site: ${live_url || 'not yet deployed'}
GitHub: ${github || 'not yet created'}
Supabase: ${supabase || 'not yet created'}
${businessBlock}
## Your directive in this mode
You are focused exclusively on the admin panel for this client's website. The admin panel is a password-protected page on their site that lets them edit their own content — menu items, hours, specials, team members, announcements — without coming to you.

${github ? 'The admin panel lives at /admin on their site. Check admin.html and any related Supabase tables before proposing changes.' : 'No site has been built yet. Design and build an admin panel that serves the client\'s editing needs.'}

## What you can do in this mode
- Read and edit admin panel HTML files
- Read and modify Supabase tables that the admin panel uses
- Write queries to check current editable content structure
- Preview admin panel changes
- Deploy admin panel updates

## What you cannot do in this mode
- Edit the public-facing site pages (direct them to the main chat for that)
- Trigger full site rebuilds

## How to approach requests
If the admin panel doesn't exist yet: ask what they want to be able to edit themselves, design the editable fields, build the panel, deploy it.
If it exists: read the current implementation first, then make targeted additions or changes.

Always show a preview before deploying admin panel changes.
${memoryContext}${profileContext}`;
}

function buildEmailPrompt({ slug, live_url, github, sessionContext, memoryContext, profileContext }) {
  return `You are Formaut, helping ${slug || 'this business'} design and configure their automated email system.

## Context
Business: ${slug || 'this business'}
Live site: ${live_url || 'not yet deployed'}
GitHub: ${github || 'not yet created'}

## Your directive in this mode
You are focused exclusively on branded transactional emails for this client's business. These are automated emails sent to their customers — purchase confirmations, inquiry responses, appointment reminders, welcome messages, or any scenario the client describes.

## File conventions
Email templates live in /emails/ in the client's GitHub repo.
Each template is a standalone HTML file with inline CSS (required for email clients).
Name format: /emails/{trigger-type}.html (e.g. /emails/purchase-confirmation.html)

## What you can do in this mode
- Read and edit files in /emails/
- Preview HTML email templates
- Read from Supabase to understand what data is available for personalization

## What you cannot do in this mode
- Edit the public website
- Deploy the main site
- Modify the admin panel

Tone must match their brand voice exactly. Never use generic corporate email language.
${memoryContext}${profileContext}`;
}

function buildOperatorPrompt({ slug, live_url, github, supabase, stripe_acc, plan, status, sessionContext }) {
  return `You are Claude operating as a development partner with the Formaut platform operator.

## Current client context
Slug: ${slug}
Status: ${status} | Plan: ${plan}
Live site: ${live_url || 'not configured'}
GitHub: ${github || 'not created'}
Supabase: ${supabase || 'not created'}${stripe_acc ? `\nStripe: ${stripe_acc}` : ''}

## Recent sessions for this client
${sessionContext}

## Your capabilities in operator mode
You have access to the full tool set including platform-level tools:
- platform_query — run SELECT queries against the platform Supabase (all clients, all tables)
- platform_action — trigger platform operations: retry jobs, approve remediations, run maintenance, push Worker updates
- All standard client tools (read/edit files, deploy, query client Supabase)

## How to operate
Think critically. Push back when something seems wrong. This is a build partnership, not a client relationship.
You can inspect any client record, any job, any signal, any health event.
When acting on a client's infrastructure on behalf of support, state clearly what you're doing and why.
Never conflate operator context with client context — you are the platform owner, not the client.

## Platform awareness
The autonomous loop runs every 15 minutes via cron. Jobs in the queue are backpressure buffers, not workflow stages.
Operational events, remediation plans, and deployment health checks accumulate in the platform database.
Dead letter jobs require manual retry or investigation.`;
}

function buildMemoryContext(clientMemory = []) {
  if (!clientMemory || clientMemory.length === 0) return '';
  const grouped = {};
  for (const record of clientMemory) {
    if (!grouped[record.category]) grouped[record.category] = [];
    grouped[record.category].push(record);
  }
  const lines = [];
  for (const r of (grouped.brand || [])) {
    const v = r.value_json;
    const flag = r.confidence >= 0.80 ? '' : ' [use cautiously]';
    if (v.likes || v.dislikes) {
      const parts = [];
      if (v.likes?.length)    parts.push(`prefers: ${v.likes.join(', ')}`);
      if (v.dislikes?.length) parts.push(`dislikes: ${v.dislikes.join(', ')}`);
      lines.push(`Brand — ${r.key}: ${parts.join(' | ')}${flag}`);
    } else {
      lines.push(`Brand — ${r.key}: ${JSON.stringify(v)}${flag}`);
    }
  }
  for (const r of (grouped.design || [])) {
    const v = r.value_json;
    const flag = r.confidence >= 0.80 ? '' : ' [use cautiously]';
    if (v.approved !== undefined) {
      const st     = v.approved ? 'approved' : 'not approved';
      const detail = v.parameters ? ` — params: ${JSON.stringify(v.parameters)}` : '';
      const iter   = v.iteration_count > 0 ? ` (${v.iteration_count} iterations to confirm)` : '';
      lines.push(`Design — ${r.key}: ${st}${detail}${iter}${flag}`);
    } else {
      lines.push(`Design — ${r.key}: ${JSON.stringify(v)}${flag}`);
    }
  }
  for (const r of (grouped.avoid || [])) {
    const v = r.value_json;
    const list = v.list || Object.values(v).flat().filter(x => typeof x === 'string');
    if (list.length) lines.push(`AVOID — ${r.key}: ${list.join(', ')}`);
  }
  for (const r of (grouped.feature || [])) {
    const v = r.value_json;
    const flag = r.confidence >= 0.80 ? '' : ' [use cautiously]';
    if (v.approved !== undefined) {
      const applies = v.applies_to ? ` — applies to: ${v.applies_to}` : '';
      lines.push(`Feature — ${r.key}: ${v.approved ? 'approved' : 'not approved'}${applies}${flag}`);
    }
  }
  for (const r of (grouped.business || [])) {
    const flag = r.confidence >= 0.80 ? '' : ' [use cautiously]';
    lines.push(`Business — ${r.key}: ${JSON.stringify(r.value_json)}${flag}`);
  }
  for (const r of (grouped.content || [])) {
    const flag = r.confidence >= 0.80 ? '' : ' [use cautiously]';
    lines.push(`Content — ${r.key}: ${JSON.stringify(r.value_json)}${flag}`);
  }
  if (!lines.length) return '';
  return `
## Client memory — structured preferences from past sessions
${lines.join('\n')}

Use memory with confidence >= 0.80 automatically without asking.
Use [use cautiously] records but remain aware they are directional.
If the client contradicts stored memory this session, follow the current request.
`;
}

function buildProfileContext(commProfile = null) {
  if (!commProfile || commProfile.technical_comfort === 'unknown') return '';
  const repeated    = commProfile.repeated_explanations?.length
    ? commProfile.repeated_explanations.join(', ') : 'none yet';
  const hesitations = commProfile.hesitation_points?.length
    ? commProfile.hesitation_points.join(', ') : 'none noted';
  return `
## Communication profile for this client
Technical comfort: ${commProfile.technical_comfort}
Explanation depth: ${commProfile.explanation_depth}
Tone preference: ${commProfile.tone_preference}
Wants reasoning: ${commProfile.wants_reasoning ? 'yes' : 'no'}
Confirms before acting: ${commProfile.confirms_before_acting ? 'yes — always ask before executing steps' : 'no'}
Instruction style: ${commProfile.instruction_style}
Has needed help with: ${repeated}
Has hesitated at: ${hesitations}
Confidence trend: ${commProfile.confidence_trend}
Sessions observed: ${commProfile.sessions_observed}${commProfile.agent_notes ? `\nNotes: ${commProfile.agent_notes}` : ''}

Calibrate all responses to this profile. Do not reference it explicitly — just adjust naturally.`;
}


// =============================================================================
// SESSION-END EXTRACTION — non-blocking, runs after response is sent
// =============================================================================

const SESSION_END_EXTRACTION_SYSTEM = `You are a memory and signal extraction agent for Formaut.

Read the client conversation transcript and extract four categories of structured information.
Return ONLY a valid JSON object with four arrays. No preamble, no explanation, no markdown fences.

OUTPUT FORMAT:
{"tech_signals":[],"style_signals":[],"communication_signals":[],"memory_updates":[]}

TECH SIGNALS — implementation patterns or failure modes discovered this session. Most sessions: 0–2.
Each: {"signal_type":"better_path|failure_mode|constraint|confirmed_pattern","title":"...","description":"...","outcome":"success|failure|workaround","confidence":"confirmed|directional","stack_layer":"cloudflare|supabase|github|stripe|frontend|other"}

STYLE SIGNALS — visual/layout patterns discussed or approved.
Each: {"business_type":"restaurant|band|service|retail|wellness|professional|other","page_type":"home|menu|merch|booking|gallery|contact|admin|other","layout_built":"...","iteration_count":0,"client_change_requests":[],"final_layout":"...","density":"minimal|balanced|content-heavy","tone":"warm|professional|bold|playful|classic|cinematic","color_preference":"light|dark|colorful|monochrome","outcome":"approved_first_try|approved_after_iteration|still_iterating","confidence":"confirmed|directional"}

COMMUNICATION SIGNALS — how this client communicates and processes information.
Each: {"signal_type":"technical_comfort|explanation_depth|hesitation|preference|confusion|confidence_change","observation":"...","implication":"...","confidence":0.70}

MEMORY UPDATES — durable client/brand/design facts. This is the highest-priority output.
STORE: visual preferences, business facts, stated dislikes, approved design decisions, feature approvals, rejected directions.
DO NOT STORE: small talk, temporary emotions, uncertain guesses, one-time requests.
Confidence rules: 0.95=explicitly stated, 0.85=repeated/confirmed, 0.70=strongly inferred, 0.50=weak inference.
Each: {"category":"brand|design|avoid|business|feature|content","key":"snake_case_key","value_json":{},"confidence":0.70,"event_type":"created|updated|contradicted|confirmed","reason":"one sentence","old_implied":null}

Return valid JSON only. If a category has nothing, return [].`;

async function runSessionEndExtraction(env, clientRecord, sessionId, conversationHistory, isNewSession = false) {
  const transcript = conversationHistory
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  if (transcript.length < 100) return;

  let extracted;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system:     SESSION_END_EXTRACTION_SYSTEM,
        messages:   [{ role: 'user', content: `Extract signals from this session transcript:\n\n${transcript}` }],
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const raw  = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    extracted  = JSON.parse(raw);
  } catch {
    return;
  }

  const {
    tech_signals          = [],
    style_signals         = [],
    communication_signals = [],
    memory_updates        = [],
  } = extracted;

  if (tech_signals.length || style_signals.length || communication_signals.length || memory_updates.length || conversationHistory.length) {
    fetch(`${env.PLATFORM_WORKER_URL}/signals`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-worker-secret': env.WORKER_SECRET,
      },
      body: JSON.stringify({
        client_slug:          clientRecord.slug,
        session_id:           sessionId,
        is_new_session:       isNewSession,
        conversation_turns:   conversationHistory,
        tech_signals,
        style_signals,
        communication_signals,
        memory_updates,
      }),
    }).catch(() => {});
  }
}


// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

const ALL_TOOLS = [
  {
    name:        'read_file',
    description: 'Read the contents of a file in the client GitHub repo. Use this before editing to get the current content and SHA.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to repo root, e.g. "index.html"' },
      },
      required: ['path'],
    },
  },
  {
    name:        'list_files',
    description: 'List files in a directory of the client GitHub repo.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path. Use empty string for root.' },
      },
      required: [],
    },
  },
  {
    name:        'edit_file',
    description: 'Edit or create a file in the client GitHub repo. Creates a commit. Always read_file first to get current content and SHA, then make targeted edits.',
    input_schema: {
      type: 'object',
      properties: {
        path:           { type: 'string',  description: 'File path relative to repo root' },
        content:        { type: 'string',  description: 'Full new file content' },
        commit_message: { type: 'string',  description: 'Git commit message describing the change' },
        sha:            { type: 'string',  description: 'Current file SHA from read_file. Required for updates, omit for new files.' },
        confirmed:      { type: 'boolean', description: 'Set to true only after client has confirmed the action.' },
      },
      required: ['path', 'content', 'commit_message'],
    },
  },
  {
    name:        'trigger_deploy',
    description: 'Trigger a Cloudflare Pages deployment. Fire and forget — returns immediately. Use check_deploy_status to poll for completion. Always call this after editing files.',
    input_schema: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'Set to true only after client has confirmed the deployment.' },
      },
      required: [],
    },
  },
  {
    name:        'check_deploy_status',
    description: 'Check the status of the latest Cloudflare Pages deployment.',
    input_schema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Deployment ID from trigger_deploy. Omit to check latest.' },
      },
      required: [],
    },
  },
  {
    name:        'run_query',
    description: 'Run a SELECT query against the client Supabase database. Read-only. Use to check current content, menu items, settings.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'SQL SELECT statement' },
      },
      required: ['query'],
    },
  },
  {
    name:        'run_write_query',
    description: 'Run an INSERT, UPDATE, or DELETE query against the client Supabase database. Use to update editable content like menu items, hours, or settings.',
    input_schema: {
      type: 'object',
      properties: {
        query:     { type: 'string',  description: 'SQL INSERT, UPDATE, or DELETE statement' },
        confirmed: { type: 'boolean', description: 'Set to true only after client has confirmed the change.' },
      },
      required: ['query'],
    },
  },
  {
    name:        'preview_srcdoc',
    description: 'Show an instant inline preview of HTML content in the dashboard without committing or deploying. Use for minor text/content changes where a quick visual check is useful.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full HTML content to preview' },
        path:    { type: 'string', description: 'File path this preview represents, e.g. index.html' },
      },
      required: ['content'],
    },
  },
  {
    name:        'preview_branch_deploy',
    description: 'Push a file to a preview branch and trigger a Cloudflare Pages preview build. Use for layout changes, new sections, redesigns, or any structural change.',
    input_schema: {
      type: 'object',
      properties: {
        path:           { type: 'string',  description: 'File path to write to the preview branch' },
        content:        { type: 'string',  description: 'Full file content' },
        commit_message: { type: 'string',  description: 'Commit message for the preview branch' },
        session_id:     { type: 'string',  description: 'Current session ID — used to name the preview branch' },
        confirmed:      { type: 'boolean', description: 'Set to true after client confirms the preview push' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name:        'get_preview_url',
    description: 'Poll Cloudflare Pages for the build status of a preview branch.',
    input_schema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Preview branch name returned by preview_branch_deploy' },
      },
      required: ['branch'],
    },
  },
  {
    name:        'platform_query',
    description: 'OPERATOR ONLY. Run a SELECT query against the platform Supabase database. Use to inspect client records, usage, signals, jobs, and health data across all clients.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'SQL SELECT statement against platform database' },
      },
      required: ['query'],
    },
  },
  {
    name:        'platform_action',
    description: 'OPERATOR ONLY. Execute a platform-level action: retry a dead job, approve a remediation plan, trigger maintenance for a client.',
    input_schema: {
      type: 'object',
      properties: {
        action:  { type: 'string', description: 'Action type: retry_job | approve_remediation | run_maintenance' },
        payload: { type: 'object', description: 'Action-specific parameters' },
      },
      required: ['action'],
    },
  },
];


// =============================================================================
// HELPERS
// =============================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function cors(data, status = 200) {
  return new Response(data, {
    status,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

// functions/api/chat.js
// Cloudflare Pages Function — client chat endpoint
//
// Flow:
//   1. Verify request is authenticated (Google token or session token)
//   2. Fetch Tier 1 client record from platform Supabase
//   3. Fetch Tier 2 session summaries from client's own Supabase
//   4. Build system prompt from Tier 1 + Tier 2 context
//   5. Call Claude Sonnet with full conversation history
//   6. Write message pair to client Supabase conversation_history
//   7. Return response to dashboard
//
// The client never holds an Anthropic API key.
// All context injection happens server-side here.

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return cors(null, 204);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // ── Auth ───────────────────────────────────────────────────────────────────
  // Expect the Google id_token in Authorization header
  // (same token the admin panel verifies — reused here so no extra login)
  const authHeader = request.headers.get('Authorization') || '';
  const googleToken = authHeader.replace('Bearer ', '').trim();

  if (!googleToken) return json({ error: 'Unauthorized' }, 401);

  // Verify token with Google
  let verifiedEmail;
  try {
    const tokenRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${googleToken}`
    );
    if (!tokenRes.ok) throw new Error('Token invalid');
    const tokenData = await tokenRes.json();

    // Validate audience
    if (tokenData.aud !== env.GOOGLE_CLIENT_ID) {
      return json({ error: 'Token audience mismatch' }, 401);
    }

    verifiedEmail = tokenData.email;
  } catch {
    return json({ error: 'Token verification failed' }, 401);
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { message, history = [], client_id, session_id, session_context, chat_mode = 'general' } = body;

  if (!message || message.trim().length === 0) {
    return json({ error: 'Message is required' }, 400);
  }
  if (message.length > 2000) {
    return json({ error: 'Message too long' }, 400);
  }
  if (!client_id) {
    return json({ error: 'client_id is required' }, 400);
  }

  // Validate chat_mode — unknown modes fall back to general
  const VALID_MODES = new Set(['general', 'admin', 'email', 'operator']);
  const resolvedMode = VALID_MODES.has(chat_mode) ? chat_mode : 'general';

  // ── Context resolution — fetch once, cache via session_context ───────────────
  // Cloudflare Workers are stateless — no memory between requests.
  // On the first message of a session, we fetch Tier 1 (client record),
  // Tier 2 (session summaries), and the communication profile, then return
  // them as session_context in the response. The dashboard sends session_context
  // back on every subsequent message so we skip the fetches entirely.
  // Result: 3 Supabase fetches on turn 1, 0 fetches on turns 2–N.

  let clientRecord;
  let sessionSummaries = [];
  let commProfile      = null;
  let clientMemory     = [];
  const isFirstTurn = !session_context || !session_context.client;

  if (!isFirstTurn) {
    // Reuse cached context from dashboard — no Supabase calls needed
    clientRecord     = session_context.client;
    sessionSummaries = session_context.session_summaries || [];
    commProfile      = session_context.comm_profile || null;
    clientMemory     = session_context.client_memory  || [];

    // Auth check must never be skipped even with cached context
    const adminEmails = clientRecord.admin_emails || [];
    if (!adminEmails.includes(verifiedEmail)) {
      return json({ error: 'Forbidden' }, 403);
    }
  }

  // ── Operator detection ─────────────────────────────────────────────────────
  // OPERATOR_EMAIL env var identifies the platform owner.
  // Operator sessions get expanded context and access to operator-only tools.
  // Non-operator sessions can never reach operator mode regardless of chat_mode.
  const isOperator = Boolean(
    env.OPERATOR_EMAIL &&
    verifiedEmail === env.OPERATOR_EMAIL
  );
  const effectiveMode = (resolvedMode === 'operator' && !isOperator) ? 'general' : resolvedMode;

  if (isFirstTurn) {
    // First turn — fetch everything from Supabase
    try {
      const res = await fetch(
        `${env.PLATFORM_SUPABASE_URL}/rest/v1/clients?slug=eq.${encodeURIComponent(client_id)}&select=*&limit=1`,
        { headers: { 'apikey': env.PLATFORM_SUPABASE_SERVICE_KEY } }
      );
      const rows = await res.json();
      clientRecord = rows[0];
    } catch {
      clientRecord = null;
    }

    if (!clientRecord) return json({ error: 'Client not found' }, 404);

    const adminEmails = clientRecord.admin_emails || [];
    if (!adminEmails.includes(verifiedEmail)) {
      return json({ error: 'Forbidden' }, 403);
    }

    // Tier 2 + Tier 1.5 — session summaries, communication profile, client memory
    // Fetched via platform Worker /client-data which handles decryption internally.
    // chat.js never touches encryption — the Worker holds ENCRYPTION_KEY.
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
      }
    } catch {
      // Non-fatal — agent continues without Tier 2 context
      sessionSummaries = [];
      commProfile      = null;
      clientMemory     = [];
    }
  }

  // ── Build system prompt ────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(clientRecord, sessionSummaries, commProfile, clientMemory, effectiveMode, isOperator);

  // ── Prepare conversation for Claude ───────────────────────────────────────
  // history comes from the client as [{role, content}, ...]
  // Validate and cap at last 20 turns to keep context manageable
  const safeHistory = (Array.isArray(history) ? history : [])
    .filter(m => m.role && m.content && typeof m.content === 'string')
    .slice(-20)
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

  const messages = [
    ...safeHistory,
    { role: 'user', content: message },
  ];

  // ── Intent classification — Haiku pre-flight ───────────────────────────────
  // Determines whether this message needs tools before loading the full tool
  // definitions and agentic loop. Saves ~1000 tokens on every conversational turn.
  //
  // conversational — pure question, chat, or status check → no tools needed
  // action         — change, build, update, fix, add, deploy → full tools
  // ambiguous      — could be either → include tools to be safe
  //
  // Classification is fast (~200ms) and cheap (Haiku). The saving on every
  // conversational turn more than covers the cost of the pre-flight.

  let intentType = 'action'; // default safe — include tools
  try {
    const intentRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 10,
        system:     'Classify the user message. Reply with exactly one word: conversational, action, or ambiguous. conversational = question, chat, status check, asking what something is. action = make a change, build something, update, fix, add, deploy, connect, configure. ambiguous = could be either.',
        messages:   [{ role: 'user', content: message }],
      }),
    });
    if (intentRes.ok) {
      const intentData = await intentRes.json();
      const raw = (intentData.content?.[0]?.text || '').trim().toLowerCase();
      if (raw === 'conversational') intentType = 'conversational';
      else if (raw === 'ambiguous')   intentType = 'ambiguous';
      else                            intentType = 'action';
    }
  } catch {
    intentType = 'action'; // on classification failure, default to full tools
  }

  const includeTools = intentType !== 'conversational';

  // ── Tool definitions — what Claude can call ────────────────────────────────
  // All available tools defined once. TOOL_WHITELIST gates which modes can use each.
  // Tools not in a mode's whitelist are never sent to Claude — it cannot use
  // what it cannot see, regardless of what the user asks.

  const TOOL_WHITELIST = {
    general:  ['read_file', 'list_files', 'edit_file', 'trigger_deploy', 'check_deploy_status', 'run_query', 'run_write_query', 'preview_srcdoc', 'preview_branch_deploy', 'get_preview_url'],
    admin:    ['read_file', 'list_files', 'edit_file', 'trigger_deploy', 'check_deploy_status', 'run_query', 'run_write_query', 'preview_srcdoc'],
    email:    ['read_file', 'list_files', 'edit_file', 'preview_srcdoc', 'run_query'],
    operator: ['read_file', 'list_files', 'edit_file', 'trigger_deploy', 'check_deploy_status', 'run_query', 'run_write_query', 'preview_srcdoc', 'preview_branch_deploy', 'get_preview_url', 'platform_query', 'platform_action'],
  };

  const allowedTools = new Set(TOOL_WHITELIST[effectiveMode] || TOOL_WHITELIST.general);

  const ALL_TOOLS = [
    {
      name:        'read_file',
      description: 'Read the contents of a file in the client GitHub repo. Use this before editing to get the current content and SHA.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to repo root, e.g. "index.html" or "functions/api/chat.js"' },
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
          deployment_id: { type: 'string', description: 'Deployment ID from trigger_deploy. Optional — omits to check latest.' },
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
    // ── Operator-only tools ────────────────────────────────────────────────
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
      description: 'OPERATOR ONLY. Execute a platform-level action: retry a dead job, approve a remediation plan, trigger maintenance for a client, or push a Worker update.',
      input_schema: {
        type: 'object',
        properties: {
          action:  { type: 'string', description: 'Action type: retry_job | approve_remediation | run_maintenance | push_worker_update' },
          payload: { type: 'object', description: 'Action-specific parameters' },
        },
        required: ['action'],
      },
    },
  ];

  // Filter to only the tools this mode is allowed to use
  const tools = ALL_TOOLS.filter(t => allowedTools.has(t.name));

  // ── Agentic loop — Claude calls tools until task is complete ───────────────
  // Max 10 tool calls per user message to prevent runaway loops.
  // Each tool_use block is executed via the platform Worker /execute-tool endpoint,
  // then the result is fed back as a tool_result message for Claude to continue.

  let agentResponse = '';
  const toolCalls = [];  // collected for dashboard status display
  let pendingConfirmation = null; // set if a tool requires user confirmation

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
          model:      'claude-sonnet-4-20250514',
          max_tokens: 4096,
          // Prompt caching — system prompt is identical every turn of a session.
          // Caching kicks in after 1024 tokens and saves ~70% on system prompt
          // tokens from turn 2 onwards. anthropic-beta header required.
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          // Only include tools when the intent warrants it — saves ~1000 tokens
          // on every conversational turn (questions, status checks, chat).
          ...(includeTools ? { tools, tool_choice: { type: 'auto' } } : {}),
          messages:   loopMessages,
        }),
      });

      if (!claudeRes.ok) {
        const errBody = await claudeRes.text();
        console.error('Claude API error:', claudeRes.status, errBody);
        throw new Error('Claude API error ' + claudeRes.status);
      }

      const claudeData = await claudeRes.json();
      const stopReason = claudeData.stop_reason;
      const contentBlocks = claudeData.content || [];

      // Collect any text blocks for the final response
      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          agentResponse += block.text;
        }
      }

      // If Claude is done (no tool calls), break out of loop
      if (stopReason === 'end_turn' || !contentBlocks.some(b => b.type === 'tool_use')) {
        break;
      }

      // Process tool_use blocks
      const toolResults = [];
      for (const block of contentBlocks) {
        if (block.type !== 'tool_use') continue;

        const toolName = block.name;
        const toolArgs = block.input || {};
        const toolUseId = block.id;

        // Record for dashboard display
        toolCalls.push({ tool: toolName, args: toolArgs, id: toolUseId });

        // Execute via platform Worker
        let execData;

        // Operator-only tools route to platform endpoints, not execute-tool
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
              slug:  client_id,
              tool:  toolName,
              args:  toolArgs,
            }),
          });
          execData = await execRes.json();
        }

        // If this tool requires confirmation, pause the loop
        if (execData.requires_confirmation) {
          pendingConfirmation = {
            tool:    toolName,
            args:    toolArgs,
            message: execData.message,
          };
          // Feed back a tool_result telling Claude to surface the confirmation
          toolResults.push({
            type:        'tool_result',
            tool_use_id: toolUseId,
            content:     `Paused: this action requires client confirmation. Tell the client: "${execData.message}" and wait for them to confirm before proceeding.`,
          });
        } else {
          // Store result on toolCalls entry for preview extraction later
          toolCalls[toolCalls.length - 1].result = execData;
          toolResults.push({
            type:        'tool_result',
            tool_use_id: toolUseId,
            content:     JSON.stringify(execData),
          });
        }

        // If we hit a confirmation gate, no point processing more tools
        if (pendingConfirmation) break;
      }

      // Add Claude's response and tool results to message history for next iteration
      loopMessages = [
        ...loopMessages,
        { role: 'assistant', content: contentBlocks },
        { role: 'user',      content: toolResults },
      ];

      // If confirmation required, let Claude wrap up with a message to the client
      if (pendingConfirmation) continue;
    }

    if (!agentResponse && !pendingConfirmation) {
      agentResponse = 'Task complete.';
    }

  } catch (err) {
    console.error('Agent loop failed:', err);
    return json({
      error: 'Agent unavailable — please try again in a moment.',
    }, 502);
  }

  // ── Persist conversation + trigger session-end extraction ─────────────────
  // Both conversation writes and signal extraction route through the platform
  // Worker, which holds ENCRYPTION_KEY and decrypts client Supabase credentials.
  // chat.js never touches encrypted keys directly.
  const currentSessionId = session_id || crypto.randomUUID();

  const fullHistory = [
    ...safeHistory,
    { role: 'user',      content: message },
    { role: 'assistant', content: agentResponse },
  ];

  // Session-end extraction runs via waitUntil — fires after response is sent,
  // never delays the client. Passes conversation turns for Worker to persist.
  context.waitUntil(
    runSessionEndExtraction(env, clientRecord, currentSessionId, fullHistory, !session_id)
  );

  // ── Respond ────────────────────────────────────────────────────────────────
  // Return session_context on first turn so the dashboard caches it.
  // On subsequent turns the dashboard sends it back and we skip all Supabase fetches.
  // Extract any preview data from tool results for the dashboard to render
  let previewSrcdoc  = null;
  let previewUrl     = null;
  let previewBranch  = null;

  for (const tc of toolCalls) {
    if (tc.result?.preview_mode === 'srcdoc' && tc.result?.html) {
      previewSrcdoc = tc.result.html;
    }
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
    tool_calls:           toolCalls.length > 0 ? toolCalls : undefined,
    pending_confirmation: pendingConfirmation || undefined,
    preview_srcdoc:       previewSrcdoc  || undefined,
    preview_url:          previewUrl     || undefined,
    preview_branch:       previewBranch  || undefined,
  };

  if (isFirstTurn) {
    // Strip encrypted fields before returning to frontend — never expose ciphertext
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
    };
  }

  return json(responsePayload);
}


// =============================================================================
// SYSTEM PROMPT — mode-aware builder
// =============================================================================
// Four modes:
//   general  — full Formaut contractor persona, all client tools
//   admin    — focused on admin panel: Supabase schema + admin panel files only
//   email    — focused on email templates: brand voice + template files only
//   operator — platform owner view: expanded context + platform tools
// =============================================================================

function buildSystemPrompt(client, sessions, commProfile = null, clientMemory = [], mode = 'general', isOperator = false) {
  // Shared client facts used across all modes
  const live_url   = client.live_url   || '';
  const github     = client.github_repo  || '';
  const supabase   = client.supabase_url || '';
  const stripe_acc = client.stripe_connected_account || '';
  const plan       = client.tier || 'standard';
  const status     = client.status || 'live';
  const slug       = client.slug || '';

  const sessionContext = sessions.length > 0
    ? sessions.map((s, i) => {
        const changes = Array.isArray(s.changes_made) && s.changes_made.length
          ? '\n  Changes: ' + s.changes_made.join(', ')
          : '';
        return `  ${i + 1}. ${s.summary || 'Session'}${changes}`;
      }).join('\n')
    : '  No previous sessions yet.';

  // Shared memory block — all modes get it, tone calibration applies everywhere
  const memoryContext  = buildMemoryContext(clientMemory);
  const profileContext = buildProfileContext(commProfile);

  if (mode === 'admin') return buildAdminPrompt({ client, slug, live_url, github, supabase, sessionContext, memoryContext, profileContext });
  if (mode === 'email') return buildEmailPrompt({ client, slug, live_url, github, supabase, sessionContext, memoryContext, profileContext });
  if (mode === 'operator') return buildOperatorPrompt({ client, slug, live_url, github, supabase, stripe_acc, plan, status, sessionContext });

  // Default: general
  return buildGeneralPrompt({ client, slug, live_url, github, supabase, stripe_acc, plan, status, sessionContext, memoryContext, profileContext });
}


// ── General prompt ─────────────────────────────────────────────────────────
function buildGeneralPrompt({ client, slug, live_url, github, supabase, stripe_acc, plan, status, sessionContext, memoryContext, profileContext }) {
  return `You are Formaut — an AI web contractor that builds, deploys, and maintains websites for small business owners. You work autonomously and translate plain language into real technical action.

## Who you're talking to
Business: ${slug || 'this business'}
Plan: ${plan} | Status: ${status}
Live site: ${live_url || 'not yet configured'}
GitHub: ${github || 'not yet created'}
Supabase: ${supabase || 'not yet created'}
${stripe_acc ? `Stripe: ${stripe_acc}` : ''}

## What you know from recent sessions
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

## Tools available
- Read, create, edit files in GitHub repo
- Trigger and monitor Cloudflare Pages deployments
- Read and write to client Supabase database
- Preview changes before committing

## Genuine limitations — be direct, no hedging
- Cannot register domains or change DNS
- Cannot create new GitHub, Cloudflare, or Supabase accounts
- Cannot access unconnected third-party services
When something is outside current capability: one sentence, best path forward, move on.

---

## Communication
Specific over vague. "Updated your phone number on 3 pages and deployed." Not "I'd be happy to help."
Plain language with non-technical clients. Technical precision with technical ones.
${profileContext}`;
}


// ── Admin panel prompt ─────────────────────────────────────────────────────
function buildAdminPrompt({ client, slug, live_url, github, supabase, sessionContext, memoryContext, profileContext }) {
  return `You are Formaut, helping ${slug || 'this business'} with their site admin panel.

## Context
Live site: ${live_url || 'not yet deployed'}
GitHub: ${github || 'not yet created'}
Supabase: ${supabase || 'not yet created'}

## Your directive in this mode
You are focused exclusively on the admin panel for this client's website. The admin panel is a password-protected page on their site that lets them edit their own content — menu items, hours, specials, team members, announcements — without coming to you.

${github ? `The admin panel lives at /admin on their site. Check admin.html and any related Supabase tables before proposing changes.` : `No site has been built yet. Your job here is to understand what the client would want to be able to edit themselves, then design and build an admin panel that serves those needs.`}

## What you can do in this mode
- Read and edit admin panel HTML files
- Read and modify Supabase tables that the admin panel uses
- Write queries to check current editable content structure
- Preview admin panel changes
- Deploy admin panel updates

## What you cannot do in this mode
- Edit the public-facing site pages (direct them to the main chat for that)
- Trigger full site rebuilds
- Modify non-admin infrastructure

## How to approach requests
If the admin panel doesn't exist yet: ask what they want to be able to edit themselves, design the editable fields, build the panel, deploy it.
If it exists: read the current implementation first, understand what's already there, then make targeted additions or changes.

Always show a preview before deploying admin panel changes.
${memoryContext}${profileContext}`;
}


// ── Email prompt ───────────────────────────────────────────────────────────
function buildEmailPrompt({ client, slug, live_url, github, supabase, sessionContext, memoryContext, profileContext }) {
  return `You are Formaut, helping ${slug || 'this business'} design and configure their automated email system.

## Context
Business: ${slug || 'this business'}
Live site: ${live_url || 'not yet deployed'}
GitHub: ${github || 'not yet created'}

## Your directive in this mode
You are focused exclusively on branded transactional emails for this client's business. These are automated emails sent to their customers — purchase confirmations, inquiry responses, appointment reminders, welcome messages, or any scenario the client describes.

## What you build here
- HTML email templates that match the client's brand voice, colors, and identity
- Logic definitions describing when each email fires and to whom
- Preview of exactly how the email will look to the customer

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

## How to approach requests
Ask what scenario they want to handle. What triggers the email? Who receives it? What should it say and feel like?
Then build the template, show a preview, get approval, commit it.
Tone must match their brand voice exactly. If you have memory of their brand tone, use it. Never use generic corporate email language.
${memoryContext}${profileContext}`;
}


// ── Operator prompt ────────────────────────────────────────────────────────
function buildOperatorPrompt({ client, slug, live_url, github, supabase, stripe_acc, plan, status, sessionContext }) {
  return `You are Claude operating as a development partner with the Formaut platform operator.

## Current client context
Slug: ${slug}
Status: ${status} | Plan: ${plan}
Live site: ${live_url || 'not configured'}
GitHub: ${github || 'not created'}
Supabase: ${supabase || 'not created'}
${stripe_acc ? `Stripe: ${stripe_acc}` : ''}

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


// ── Shared context builders ────────────────────────────────────────────────
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
## Client memory — structured preferences and decisions from past sessions
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
Sessions observed: ${commProfile.sessions_observed}
${commProfile.agent_notes ? `Notes: ${commProfile.agent_notes}` : ''}

Calibrate all responses to this profile. Do not reference it explicitly — just adjust naturally.`;
}



// =============================================================================
// SESSION-END EXTRACTION — runs non-blocking after every conversation turn
// Produces tech, style, communication signals + structured memory updates.
// Writes signals to platform Supabase via /signals Worker endpoint.
// Writes memory_updates directly to client Supabase client_memory table.
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
Flag contradictions: if new info conflicts with something likely already stored, set event_type="contradicted".
Each: {"category":"brand|design|avoid|business|feature|content","key":"snake_case_key","value_json":{},"confidence":0.70,"event_type":"created|updated|contradicted|confirmed","reason":"one sentence","old_implied":null}

Return valid JSON only. If a category has nothing, return []. Never return memory_updates as [] if meaningful conversation occurred.`;

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
    return; // Extraction failure is always silent
  }

  const {
    tech_signals          = [],
    style_signals         = [],
    communication_signals = [],
    memory_updates        = [],
  } = extracted;

  // ── Write all signals + memory_updates via platform Worker /signals ───────
  // /signals handles tech+style on platform Supabase AND memory_updates on
  // client Supabase — decryption happens in the Worker, never here.
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

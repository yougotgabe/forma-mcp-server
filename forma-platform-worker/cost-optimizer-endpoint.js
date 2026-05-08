import { routeDashboardMessage } from './chat-cost-gate.js';
import { guardScope } from './formaut-scope-guard.js';
import { selectContextPack } from './context-selector.js';
import { buildDeterministicSessionSummary } from './session-summarizer.js';
import { decideKbRetrieval } from './kb-retrieval-gate.js';
import { buildPromptSkeleton, taskFromIntent } from './prompt-skeletons.js';

export async function runChatPreflight(input, env) {
  const costGate = await routeDashboardMessage(input, env);

  if (!costGate.route?.should_call_llm) {
    const out = {
      ok: true,
      stage: 'cost_gate',
      should_call_llm: false,
      response: costGate.route?.response || null,
      next_action: costGate.route?.next_action || null,
      cost_gate: costGate,
    };
    await safeLogPreflight(out, input, env);
    return out;
  }

  const scope = await guardScope({
    message: input.message,
    context: { sessionId: input.session_id, userId: input.user_id, businessProfileId: input.business_profile_id },
    supabase: null,
  });

  if (!scope.shouldContinue) {
    const out = {
      ok: true,
      stage: 'scope_guard',
      should_call_llm: false,
      response: scope.responseText,
      memory_policy: scope.memoryPolicy,
      cost_gate: costGate,
      scope_guard: scope,
    };
    await safeLogPreflight(out, input, env);
    return out;
  }

  const rollingSummary = buildDeterministicSessionSummary({
    existing_summary: input.recent_summary || '',
    turns: input.conversation_turns || [],
  });

  const kbGate = decideKbRetrieval({
    message: input.message,
    intent_type: costGate.intent?.type,
    available_fragments: input.kb_fragments || [],
  });

  const context = selectContextPack({
    intent_type: costGate.intent?.type,
    message: input.message,
    business_profile: input.business_profile || input.profile || {},
    session_summary: rollingSummary,
    memory: input.memory || [],
    kb_fragments: kbGate.selected_fragments,
  });

  const task = taskFromIntent(costGate.intent?.type);
  const prompt = buildPromptSkeleton({
    task,
    user_message: input.message,
    context_pack: context.pack,
    scope: scope.scopeDecision,
  });

  const out = {
    ok: true,
    stage: 'llm_ready',
    should_call_llm: true,
    model: costGate.route.model,
    max_tokens: costGate.route.max_tokens,
    intent: costGate.intent,
    context_policy: costGate.route.context_policy,
    estimated_cost: costGate.estimate,
    context_estimated_tokens: context.estimated_tokens,
    prompt_estimated_tokens: Math.ceil(prompt.length / 4),
    context_pack: context.pack,
    kb_gate: kbGate,
    rolling_summary: rollingSummary,
    prompt,
    cost_gate: costGate,
    scope_guard: scope,
  };
  await safeLogPreflight(out, input, env);
  return out;
}

async function safeLogPreflight(result, input, env) {
  if (!env?.SUPABASE_URL || !env?.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const row = {
      slug: input.slug || null,
      session_id: input.session_id || null,
      message_preview: String(input.message || '').slice(0, 300),
      stage: result.stage || 'unknown',
      should_call_llm: Boolean(result.should_call_llm),
      intent_type: result.intent?.type || result.cost_gate?.intent?.type || null,
      selected_model: result.model || result.cost_gate?.route?.model || null,
      estimated_cost_cents: result.estimated_cost?.estimated_cost_cents || result.cost_gate?.estimate?.estimated_cost_cents || 0,
      context_estimated_tokens: result.context_estimated_tokens || 0,
      prompt_estimated_tokens: result.prompt_estimated_tokens || 0,
      kb_injected: Boolean(result.kb_gate?.should_retrieve_kb),
      route_json: result,
    };
    await fetch(`${env.SUPABASE_URL}/rest/v1/chat_preflight_logs`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
  } catch (err) {
    console.error('[chat-preflight] log failed:', err.message);
  }
}

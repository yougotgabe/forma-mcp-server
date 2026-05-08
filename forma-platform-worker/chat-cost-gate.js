// =============================================================================
// FORMAUT - PRE-LLM COST GATE / MESSAGE ROUTER
// =============================================================================
// Purpose:
//   Keep simple dashboard chat messages away from Anthropic.
//   Only call an LLM when deterministic logic cannot safely answer or route.
//
// Intended placement:
//   forma-platform-worker/chat-cost-gate.js
//
// Main export:
//   routeDashboardMessage({ slug, session_id, message, profile, recent_summary }, env)
//
// This module is dependency-free and Cloudflare Worker compatible.
// =============================================================================

export const COST_GATE_VERSION = '1.0.0';

// Keep pricing centralized and easy to update. Values are dollars per million tokens.
// Update this table when Anthropic pricing changes.
export const MODEL_PRICE_PER_MILLION = {
  'claude-3-5-haiku-latest': { input: 0.80, output: 4.00, cache_read: 0.08, cache_write: 1.00 },
  'claude-3-7-sonnet-latest': { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  'claude-sonnet-4-latest': { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  'claude-opus-4-latest': { input: 15.00, output: 75.00, cache_read: 1.50, cache_write: 18.75 },
};

export const DEFAULT_LIMITS = {
  maxInputTokens: 6000,
  maxOutputTokens: 800,
  simpleMaxInputTokens: 1200,
  extractionMaxInputTokens: 3000,
  buildMaxInputTokens: 9000,
  monthlySoftCents: 700,
  monthlyHardCents: 1200,
  singleCallHardCents: 15,
};

const URL_RE = /https?:\/\/[^\s]+|\b[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s]*)?/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/;
const HEX_RE = /#(?:[0-9a-fA-F]{3}){1,2}\b/;

const GREETINGS = new Set(['hi', 'hello', 'hey', 'yo', 'hiya', 'howdy', 'hello?', 'hey?', 'hi?']);
const THANKS = new Set(['thanks', 'thank you', 'thx', 'ty', 'appreciate it']);
const ACKS = new Set(['ok', 'okay', 'k', 'cool', 'got it', 'sounds good', 'yes', 'yep', 'no', 'nope']);
const CANCELS = new Set(['cancel', 'stop', 'nevermind', 'never mind', 'undo', 'revert', 'go back']);
const HELP = new Set(['help', 'what can you do', 'what do you do', 'start', 'get started']);

export async function routeDashboardMessage(input, env) {
  const startedAt = Date.now();
  const slug = input.slug || null;
  const sessionId = input.session_id || crypto.randomUUID();
  const rawMessage = String(input.message || '');
  const normalized = normalizeMessage(rawMessage);
  const profile = input.profile || null;
  const recentSummary = input.recent_summary || null;
  const costState = input.cost_state || null;

  const intent = classifyIntent(rawMessage, normalized);
  const deterministic = deterministicResponse({ intent, rawMessage, normalized, profile });

  const route = deterministic
    ? {
        mode: 'deterministic',
        should_call_llm: false,
        model: null,
        max_tokens: 0,
        response: deterministic.response,
        next_action: deterministic.next_action,
        context_policy: 'none',
      }
    : buildLlmRoute({ intent, rawMessage, profile, recentSummary, costState });

  const estimate = estimateRouteCost(route);
  const guardrail = applyGuardrails({ route, estimate, costState });

  const result = {
    ok: true,
    version: COST_GATE_VERSION,
    session_id: sessionId,
    slug,
    intent,
    route: guardrail.route,
    estimate: guardrail.estimate,
    blocked: guardrail.blocked,
    block_reason: guardrail.block_reason,
    elapsed_ms: Date.now() - startedAt,
  };

  if (env?.SUPABASE_URL && env?.SUPABASE_SERVICE_ROLE_KEY) {
    await safeLogCostGateDecision(result, rawMessage, env);
  }

  return result;
}

export function normalizeMessage(message) {
  return String(message || '')
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ');
}

export function classifyIntent(rawMessage, normalized = normalizeMessage(rawMessage)) {
  const trimmed = String(rawMessage || '').trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;

  if (!trimmed) return { type: 'empty', confidence: 1.0, reason: 'Empty or whitespace-only message.' };
  if (GREETINGS.has(normalized)) return { type: 'greeting', confidence: 0.98, reason: 'Exact simple greeting.' };
  if (THANKS.has(normalized)) return { type: 'thanks', confidence: 0.98, reason: 'Exact thanks phrase.' };
  if (ACKS.has(normalized)) return { type: 'ack', confidence: 0.9, reason: 'Short acknowledgement.' };
  if (CANCELS.has(normalized)) return { type: normalized.includes('undo') || normalized.includes('revert') ? 'undo' : 'cancel', confidence: 0.92, reason: 'Cancel/undo control phrase.' };
  if (HELP.has(normalized)) return { type: 'help', confidence: 0.95, reason: 'Help/start phrase.' };
  if (URL_RE.test(trimmed) && wordCount <= 3) return { type: 'url_only', confidence: 0.96, reason: 'Message is mostly a URL.' };
  if (EMAIL_RE.test(trimmed) && wordCount <= 4) return { type: 'contact_fact', confidence: 0.9, reason: 'Message contains email/contact info.' };
  if (PHONE_RE.test(trimmed) && wordCount <= 5) return { type: 'contact_fact', confidence: 0.9, reason: 'Message contains phone/contact info.' };
  if (HEX_RE.test(trimmed) && wordCount <= 8) return { type: 'brand_fact', confidence: 0.86, reason: 'Message contains brand color value.' };
  if (/\b(make|build|create|design|change|update|edit|fix|add|remove|deploy)\b/i.test(trimmed)) return { type: 'build_or_edit', confidence: 0.76, reason: 'Contains build/edit verb.' };
  if (/\b(my business|we are|we do|services|customers|clients|located|based in|open|hours)\b/i.test(trimmed)) return { type: 'business_description', confidence: 0.78, reason: 'Looks like business profile information.' };
  if (wordCount <= 8 && /\?$/.test(trimmed)) return { type: 'simple_question', confidence: 0.72, reason: 'Short question.' };

  return { type: 'unknown', confidence: 0.45, reason: 'No deterministic route matched.' };
}

export function deterministicResponse({ intent, rawMessage, profile }) {
  const hasProfile = Boolean(profile && Object.keys(profile).length > 0);

  switch (intent.type) {
    case 'empty':
      return {
        response: "Send me your business URL or tell me what you want to build, and I'll help from there.",
        next_action: 'await_user_input',
      };

    case 'greeting':
      return {
        response: hasProfile
          ? "Hey - I'm here. Send me what you want to change, review, or build next."
          : "Hey - I'm here. Send me your existing website URL and I can pull in services, contact info, tone, colors, and brand clues automatically. Or tell me what business we're building for.",
        next_action: 'await_url_or_business_description',
      };

    case 'help':
      return {
        response: "I can help build your business profile, crawl an existing site, draft site copy, identify missing info, review contradictions, and guide the next build step. The cheapest starting point is sending an existing business URL.",
        next_action: 'await_url_or_business_description',
      };

    case 'thanks':
      return { response: "You're welcome.", next_action: 'await_user_input' };

    case 'ack':
      return { response: "Got it.", next_action: 'await_user_input' };

    case 'cancel':
      return { response: "Cancelled. No changes were made.", next_action: 'stop_current_action' };

    case 'undo':
      return { response: "I can revert the latest confirmed profile or site change. Tell me which change to roll back.", next_action: 'request_rollback_target' };

    case 'url_only':
      return {
        response: "Got the URL. I can crawl it first, extract business clues, and show you what I found before anything gets treated as confirmed truth.",
        next_action: 'trigger_website_crawl_adapter',
      };

    default:
      return null;
  }
}

export function buildLlmRoute({ intent, rawMessage, profile, recentSummary, costState }) {
  const contextPolicy = selectContextPolicy(intent, profile, recentSummary);
  const model = selectModel(intent, costState);
  const tokenBudget = selectTokenBudget(intent);

  return {
    mode: 'llm_required',
    should_call_llm: true,
    model,
    max_tokens: tokenBudget.output,
    estimated_input_tokens: tokenBudget.input,
    context_policy: contextPolicy,
    response: null,
    next_action: selectNextAction(intent),
  };
}

export function selectContextPolicy(intent, profile, recentSummary) {
  if (intent.type === 'contact_fact' || intent.type === 'brand_fact') return 'minimal_profile_fields_only';
  if (intent.type === 'business_description') return 'business_profile_schema_plus_current_unknowns';
  if (intent.type === 'simple_question') return 'session_summary_only';
  if (intent.type === 'build_or_edit') return 'business_profile_plus_recent_summary_plus_relevant_files_only';
  return 'minimal_system_prompt_plus_recent_summary';
}

export function selectModel(intent, costState = null) {
  const nearHardLimit = costState?.threshold === 'hard' || costState?.threshold === 'kill';
  if (nearHardLimit) return 'claude-3-5-haiku-latest';

  switch (intent.type) {
    case 'contact_fact':
    case 'brand_fact':
    case 'business_description':
    case 'simple_question':
      return 'claude-3-5-haiku-latest';
    case 'build_or_edit':
      return 'claude-3-7-sonnet-latest';
    default:
      return 'claude-3-5-haiku-latest';
  }
}

export function selectTokenBudget(intent) {
  switch (intent.type) {
    case 'contact_fact':
    case 'brand_fact':
      return { input: 900, output: 250 };
    case 'business_description':
      return { input: 2500, output: 500 };
    case 'simple_question':
      return { input: 1200, output: 350 };
    case 'build_or_edit':
      return { input: 6000, output: 900 };
    default:
      return { input: 1800, output: 400 };
  }
}

export function selectNextAction(intent) {
  switch (intent.type) {
    case 'contact_fact': return 'extract_contact_fact_then_stage_profile_patch';
    case 'brand_fact': return 'extract_brand_fact_then_stage_profile_patch';
    case 'business_description': return 'extract_business_facts_then_stage_profile_patch';
    case 'build_or_edit': return 'reason_about_build_or_edit_request';
    case 'simple_question': return 'answer_with_minimal_context';
    default: return 'llm_interpretation';
  }
}

export function estimateRouteCost(route) {
  if (!route.should_call_llm) {
    return { input_tokens: 0, output_tokens: 0, model: null, estimated_cost_cents: 0 };
  }

  const model = route.model || 'claude-3-5-haiku-latest';
  const pricing = MODEL_PRICE_PER_MILLION[model] || MODEL_PRICE_PER_MILLION['claude-3-5-haiku-latest'];
  const input = route.estimated_input_tokens || 1500;
  const output = route.max_tokens || 400;
  const dollars = (input / 1_000_000) * pricing.input + (output / 1_000_000) * pricing.output;

  return {
    input_tokens: input,
    output_tokens: output,
    model,
    estimated_cost_cents: Math.ceil(dollars * 10000) / 100, // hundredths of a cent precision
  };
}

export function applyGuardrails({ route, estimate, costState }) {
  const out = { route: { ...route }, estimate, blocked: false, block_reason: null };

  if (!route.should_call_llm) return out;

  if (costState?.threshold === 'kill') {
    out.blocked = true;
    out.block_reason = 'Monthly/velocity cost threshold requires explicit confirmation before LLM use.';
    out.route.should_call_llm = false;
    out.route.mode = 'blocked_by_cost_gate';
    out.route.response = "We've done a lot of heavy lifting recently. Confirm the next specific task before I use extended reasoning.";
    return out;
  }

  if (estimate.estimated_cost_cents > DEFAULT_LIMITS.singleCallHardCents) {
    out.blocked = true;
    out.block_reason = 'Estimated single-call cost exceeds hard cap.';
    out.route.should_call_llm = false;
    out.route.mode = 'blocked_by_single_call_cap';
    out.route.response = 'That request looks too large for one safe call. Break it into one focused step first.';
    return out;
  }

  if (costState?.threshold === 'hard' && route.model !== 'claude-3-5-haiku-latest') {
    out.route.model = 'claude-3-5-haiku-latest';
    out.route.max_tokens = Math.min(out.route.max_tokens || 400, 500);
    out.estimate = estimateRouteCost(out.route);
  }

  return out;
}

async function safeLogCostGateDecision(result, rawMessage, env) {
  try {
    const row = {
      slug: result.slug,
      session_id: result.session_id,
      message_preview: rawMessage.slice(0, 300),
      intent_type: result.intent.type,
      intent_confidence: result.intent.confidence,
      should_call_llm: result.route.should_call_llm,
      selected_model: result.route.model,
      context_policy: result.route.context_policy,
      estimated_input_tokens: result.estimate.input_tokens,
      estimated_output_tokens: result.estimate.output_tokens,
      estimated_cost_cents: result.estimate.estimated_cost_cents,
      blocked: result.blocked,
      block_reason: result.block_reason,
      route_json: result,
    };

    await fetch(`${env.SUPABASE_URL}/rest/v1/message_router_logs`, {
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
    console.error('[cost-gate] log failed:', err.message);
  }
}

import { routeDashboardMessage, estimateRouteCost, MODEL_PRICE_PER_MILLION } from '../chat-cost-gate.js';
import { guardScope } from '../formaut-scope-guard.js';
import { classifyGatewayIntent } from './intent-classifier.js';
import { buildThroughputDecision } from './throughput-policy.js';
import { selectProviderRoute } from './provider-router.js';
import { selectModelPolicy } from './model-policy.js';

export const AI_GATEWAY_VERSION = '1.0.0';

const DEFAULT_POLICY = {
  responseCacheTtlSeconds: 60 * 60 * 24 * 14,
  semanticCacheTtlSeconds: 60 * 60 * 24 * 30,
  maxPromptBytesForCache: 180_000,
  hardSingleCallCents: 20,
  defaultMonthlyHardCents: 1200,
  defaultMonthlySoftCents: 700,
};

const CACHEABLE_ACTIONS = new Set([
  'answer_with_minimal_context',
  'extract_business_facts_then_stage_profile_patch',
  'extract_contact_fact_then_stage_profile_patch',
  'extract_brand_fact_then_stage_profile_patch',
]);

const NON_CACHEABLE_INTENTS = new Set(['build_or_edit']);

export async function runFormautAiGateway(input = {}, env = {}, deps = {}) {
  const startedAt = Date.now();
  const supabase = deps.supabase;
  const request = normalizeGatewayInput(input);
  const cost = await routeDashboardMessage(request, env);

  if (cost.blocked || cost.route?.should_call_llm === false) {
    const trace = buildTrace({ request, cost, scope: null, cache: null, startedAt, decision: 'handled_without_llm' });
    await safeLogGatewayTrace({ trace, request, cost, env, supabase });
    return {
      ok: true,
      version: AI_GATEWAY_VERSION,
      handled_by: 'ai_gateway',
      should_call_llm: false,
      response: cost.route?.response || null,
      next_action: cost.route?.next_action || null,
      cost_gate: cost,
      trace,
    };
  }

  const scope = await guardScope({
    message: request.message,
    context: {
      sessionId: request.session_id,
      userId: request.user_id,
      businessProfileId: request.business_profile_id,
    },
    supabase: null,
  });

  if (!scope.shouldContinue) {
    const trace = buildTrace({ request, cost, scope, cache: null, startedAt, decision: 'blocked_by_scope_guard' });
    await safeLogGatewayTrace({ trace, request, cost, scope, env, supabase });
    return {
      ok: true,
      version: AI_GATEWAY_VERSION,
      handled_by: 'ai_gateway_scope_guard',
      should_call_llm: false,
      response: scope.responseText,
      scope: scope.scopeDecision,
      memory_policy: scope.memoryPolicy,
      trace,
    };
  }

  const cachePlan = await planGatewayCache({ request, cost, env, supabase });
  if (cachePlan.cache_hit) {
    const trace = buildTrace({ request, cost, scope, cache: cachePlan, startedAt, decision: 'cache_hit' });
    await safeLogGatewayTrace({ trace, request, cost, scope, cachePlan, env, supabase });
    return {
      ok: true,
      version: AI_GATEWAY_VERSION,
      handled_by: 'ai_gateway_cache',
      should_call_llm: false,
      response: cachePlan.cached_response,
      next_action: cost.route?.next_action || null,
      cache: stripCachedResponse(cachePlan),
      trace,
    };
  }

  const budget = await evaluateBudget({ request, cost, env, supabase });
  if (budget.blocked) {
    const trace = buildTrace({ request, cost, scope, cache: cachePlan, budget, startedAt, decision: 'blocked_by_budget' });
    await safeLogGatewayTrace({ trace, request, cost, scope, cachePlan, budget, env, supabase });
    return {
      ok: true,
      version: AI_GATEWAY_VERSION,
      handled_by: 'ai_gateway_budget',
      should_call_llm: false,
      response: budget.response,
      budget,
      trace,
    };
  }

  const promptCache = planAnthropicPromptCaching({ request, cost, cachePlan });
  const providerRoute = selectProviderRoute({ intent: classifyGatewayIntent(request), tier: request.tier, estimate: budget.estimate, env });
  const trace = buildTrace({ request, cost, scope, cache: cachePlan, budget, promptCache, startedAt, decision: 'llm_allowed' });
  await safeLogGatewayTrace({ trace, request, cost, scope, cachePlan, budget, env, supabase });

  return {
    ok: true,
    version: AI_GATEWAY_VERSION,
    handled_by: 'ai_gateway',
    should_call_llm: true,
    model: budget.model,
    max_tokens: budget.max_tokens,
    context_policy: cost.route.context_policy,
    next_action: cost.route.next_action,
    cache: stripCachedResponse(cachePlan),
    prompt_cache: promptCache,
    provider_route: providerRoute,
    anthropic_request_policy: {
      idempotency_key: cachePlan.request_fingerprint,
      timeout_ms: selectTimeoutMs(cost.intent),
      retry: selectRetryPolicy(cost.intent),
      cache_write_allowed: promptCache.cache_write_allowed,
      cache_read_allowed: true,
    },
    estimate: budget.estimate,
    trace,
  };
}

export async function recordGatewayCompletion(input = {}, env = {}, deps = {}) {
  const supabase = requireSupabase(deps.supabase);
  const row = {
    slug: input.slug || input.client_slug || null,
    session_id: input.session_id || null,
    trace_id: input.trace_id || input.traceId || crypto.randomUUID(),
    request_fingerprint: input.request_fingerprint || input.requestFingerprint || null,
    model: input.model || null,
    input_tokens: Number(input.input_tokens || input.usage?.input_tokens || 0),
    output_tokens: Number(input.output_tokens || input.usage?.output_tokens || 0),
    cache_read_tokens: Number(input.cache_read_tokens || input.usage?.cache_read_input_tokens || 0),
    cache_write_tokens: Number(input.cache_write_tokens || input.usage?.cache_creation_input_tokens || 0),
    cost_cents: estimateActualCostCents(input),
    response_preview: String(input.response || input.text || '').slice(0, 1200),
    metadata: input.metadata || {},
  };

  await supabase(env, 'POST', '/rest/v1/ai_gateway_completions', row, { Prefer: 'return=minimal' });

  if (input.cache_response === true && input.request_fingerprint && input.response) {
    await upsertGatewayCache({
      request_fingerprint: input.request_fingerprint,
      slug: row.slug,
      model: row.model,
      response: input.response,
      metadata: input.metadata || {},
      expires_at: new Date(Date.now() + DEFAULT_POLICY.responseCacheTtlSeconds * 1000).toISOString(),
    }, env, supabase);
  }

  return { ok: true, completion: row };
}

export function normalizeGatewayInput(input = {}) {
  return {
    slug: input.slug || input.client_slug || null,
    client_id: input.client_id || null,
    session_id: input.session_id || input.sessionId || crypto.randomUUID(),
    user_id: input.user_id || input.userId || null,
    business_profile_id: input.business_profile_id || input.businessProfileId || null,
    message: String(input.message || input.text || ''),
    profile: input.profile || null,
    recent_summary: input.recent_summary || input.recentSummary || null,
    context_pack: input.context_pack || input.contextPack || null,
    cost_state: input.cost_state || null,
    force_refresh: input.force_refresh === true,
    allow_response_cache: input.allow_response_cache !== false,
  };
}

export async function planGatewayCache({ request, cost, env, supabase }) {
  const intentType = cost.intent?.type || 'unknown';
  const nextAction = cost.route?.next_action || null;
  const cacheAllowed = request.allow_response_cache && !request.force_refresh && !NON_CACHEABLE_INTENTS.has(intentType) && CACHEABLE_ACTIONS.has(nextAction);
  const basis = {
    version: AI_GATEWAY_VERSION,
    slug: request.slug,
    intent_type: intentType,
    model: cost.route?.model,
    context_policy: cost.route?.context_policy,
    message: normalizeForFingerprint(request.message),
    profile_fingerprint: stableJsonHash(request.profile || {}),
    summary_fingerprint: stableJsonHash(request.recent_summary || ''),
    context_fingerprint: stableJsonHash(request.context_pack || {}),
  };
  const request_fingerprint = await sha256Hex(stableJsonStringify(basis));

  if (!cacheAllowed || !supabase || !env?.SUPABASE_URL) {
    return { cache_allowed: cacheAllowed, cache_hit: false, request_fingerprint, reason: cacheAllowed ? 'supabase_unavailable' : 'not_cacheable' };
  }

  try {
    const path = `/rest/v1/ai_gateway_response_cache?request_fingerprint=eq.${encodeURIComponent(request_fingerprint)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=*&limit=1`;
    const res = await supabase(env, 'GET', path);
    if (!res.ok) throw new Error(await safeText(res));
    const rows = await res.json();
    if (!rows.length) return { cache_allowed: true, cache_hit: false, request_fingerprint, reason: 'miss' };
    await supabase(env, 'PATCH', `/rest/v1/ai_gateway_response_cache?id=eq.${encodeURIComponent(rows[0].id)}`, {
      hit_count: Number(rows[0].hit_count || 0) + 1,
      last_hit_at: new Date().toISOString(),
    });
    return {
      cache_allowed: true,
      cache_hit: true,
      request_fingerprint,
      cached_response: rows[0].response,
      cache_row_id: rows[0].id,
      model: rows[0].model,
      reason: 'response_cache_hit',
    };
  } catch (err) {
    return { cache_allowed: true, cache_hit: false, request_fingerprint, reason: 'cache_lookup_failed', error: err.message };
  }
}

export async function evaluateBudget({ request, cost, env, supabase }) {
  let route = { ...cost.route };
  const estimate = estimateRouteCost(route);
  const singleHard = Number(env.AI_GATEWAY_SINGLE_CALL_HARD_CENTS || DEFAULT_POLICY.hardSingleCallCents);
  if (estimate.estimated_cost_cents > singleHard) {
    return {
      blocked: true,
      response: 'That request is too large for one safe AI call. Break it into one focused task first.',
      reason: 'single_call_hard_limit',
      estimate,
    };
  }

  const monthState = await loadMonthlyGatewaySpend({ slug: request.slug, env, supabase });
  const intent = classifyGatewayIntent(request);
  const throughput = buildThroughputDecision({ request, intent, estimate, monthly: monthState, env });

  if (!throughput.allowed) {
    return {
      blocked: true,
      response: 'This client is at the monthly AI budget limit. Use deterministic tools, cached context, or ask for explicit operator approval before another model call.',
      reason: throughput.reason,
      estimate,
      month: monthState,
      throughput,
    };
  }

  const selected = selectModelPolicy({ intent, degraded: throughput.degraded, requestedModel: route.model });
  if (throughput.degraded || !route.model) {
    route.model = selected.model;
    route.max_tokens = Math.min(Number(route.max_tokens || selected.max_tokens || 500), selected.max_tokens || 500);
  }

  return {
    blocked: false,
    model: route.model,
    max_tokens: route.max_tokens,
    estimate: estimateRouteCost(route),
    month: monthState,
    throughput,
    model_policy: selected,
    downgraded: route.model !== cost.route.model,
  };
}

export function planAnthropicPromptCaching({ request, cost, cachePlan }) {
  const promptBytes = new TextEncoder().encode(stableJsonStringify({ profile: request.profile, summary: request.recent_summary, context: request.context_pack })).byteLength;
  const cacheWriteAllowed = promptBytes > 4096 && promptBytes <= DEFAULT_POLICY.maxPromptBytesForCache;
  const breakpoints = [];
  if (request.profile) breakpoints.push({ name: 'business_profile', cache_control: { type: 'ephemeral' } });
  if (request.recent_summary) breakpoints.push({ name: 'recent_summary', cache_control: { type: 'ephemeral' } });
  if (request.context_pack) breakpoints.push({ name: 'retrieved_context', cache_control: { type: 'ephemeral' } });
  return {
    cache_write_allowed: cacheWriteAllowed,
    prompt_static_bytes: promptBytes,
    suggested_breakpoints: cacheWriteAllowed ? breakpoints.slice(0, 4) : [],
    request_fingerprint: cachePlan.request_fingerprint,
    note: 'Attach Anthropic cache_control to stable system/profile/context blocks, never to the final user message.',
  };
}

function selectTimeoutMs(intent = {}) {
  if (intent.type === 'build_or_edit') return 45_000;
  if (intent.type === 'business_description') return 22_000;
  return 15_000;
}

function selectRetryPolicy(intent = {}) {
  if (intent.type === 'build_or_edit') return { max_attempts: 1, retry_on: ['rate_limit', 'timeout'] };
  return { max_attempts: 2, retry_on: ['rate_limit', 'timeout', 'overloaded'] };
}

async function loadMonthlyGatewaySpend({ slug, env, supabase }) {
  if (!supabase || !env?.SUPABASE_URL || !slug) return { slug, cost_cents: 0, source: 'unavailable' };
  const monthStart = new Date();
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  try {
    const path = `/rest/v1/ai_gateway_monthly_spend?slug=eq.${encodeURIComponent(slug)}&month=eq.${encodeURIComponent(monthStart.toISOString().slice(0, 10))}&select=*`;
    const res = await supabase(env, 'GET', path);
    if (!res.ok) throw new Error(await safeText(res));
    const rows = await res.json();
    return rows[0] || { slug, month: monthStart.toISOString().slice(0, 10), cost_cents: 0, source: 'empty' };
  } catch (err) {
    return { slug, cost_cents: 0, source: 'error', error: err.message };
  }
}

async function upsertGatewayCache(row, env, supabase) {
  await supabase(env, 'POST', '/rest/v1/ai_gateway_response_cache', row, {
    Prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

async function safeLogGatewayTrace({ trace, request, cost, scope = null, cachePlan = null, budget = null, env, supabase }) {
  if (!supabase || !env?.SUPABASE_URL) return;
  try {
    await supabase(env, 'POST', '/rest/v1/ai_gateway_traces', {
      trace_id: trace.trace_id,
      slug: request.slug,
      session_id: request.session_id,
      intent_type: cost.intent?.type || null,
      selected_model: budget?.model || cost.route?.model || null,
      should_call_llm: trace.decision === 'llm_allowed',
      decision: trace.decision,
      estimated_cost_cents: budget?.estimate?.estimated_cost_cents || cost.estimate?.estimated_cost_cents || 0,
      request_fingerprint: cachePlan?.request_fingerprint || trace.request_fingerprint || null,
      cache_hit: cachePlan?.cache_hit || false,
      scope_category: scope?.scopeDecision?.category || null,
      trace_json: trace,
    }, { Prefer: 'return=minimal' });
  } catch (err) {
    console.error('[ai-gateway] trace log failed:', err.message);
  }
}

function buildTrace({ request, cost, scope, cache, budget, promptCache, startedAt, decision }) {
  return {
    trace_id: crypto.randomUUID(),
    version: AI_GATEWAY_VERSION,
    decision,
    slug: request.slug,
    session_id: request.session_id,
    intent_type: cost.intent?.type || null,
    selected_model: budget?.model || cost.route?.model || null,
    context_policy: cost.route?.context_policy || 'none',
    next_action: cost.route?.next_action || null,
    estimated_cost_cents: budget?.estimate?.estimated_cost_cents || cost.estimate?.estimated_cost_cents || 0,
    request_fingerprint: cache?.request_fingerprint || null,
    cache_hit: cache?.cache_hit || false,
    scope_category: scope?.scopeDecision?.category || null,
    prompt_cache_static_bytes: promptCache?.prompt_static_bytes || 0,
    elapsed_ms: Date.now() - startedAt,
  };
}

export function estimateActualCostCents(input = {}) {
  const model = input.model || 'claude-3-5-haiku-latest';
  const pricing = MODEL_PRICE_PER_MILLION[model] || MODEL_PRICE_PER_MILLION['claude-3-5-haiku-latest'];
  const usage = input.usage || input;
  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || usage.cache_read_tokens || 0);
  const cacheWrite = Number(usage.cache_creation_input_tokens || usage.cache_write_tokens || 0);
  const dollars = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output + (cacheRead / 1_000_000) * (pricing.cache_read || pricing.input) + (cacheWrite / 1_000_000) * (pricing.cache_write || pricing.input);
  return Math.ceil(dollars * 10000) / 100;
}

function stripCachedResponse(cachePlan = {}) {
  const { cached_response, ...rest } = cachePlan;
  return rest;
}

function normalizeForFingerprint(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 4000);
}

async function sha256Hex(text) {
  const encoded = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function stableJsonHash(value) {
  return stableJsonStringify(value).slice(0, 6000);
}

function stableJsonStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(',')}}`;
}

function requireSupabase(supabase) {
  if (!supabase) throw new Error('supabase dependency is required');
  return supabase;
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

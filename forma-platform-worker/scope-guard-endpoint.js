/**
 * Example Cloudflare Worker endpoint wrapper for Formaut Scope Guard.
 *
 * Use this before the normal Anthropic chat route.
 */

import { guardScope } from './formaut-scope-guard.js';

export async function handleScopeGuardRequest(request, env, ctx, deps = {}) {
  const body = await request.json().catch(() => ({}));
  const message = body.message || body.text || '';

  const result = await guardScope({
    message,
    context: {
      sessionId: body.session_id || body.sessionId || null,
      userId: body.user_id || body.userId || null,
      businessProfileId: body.business_profile_id || body.businessProfileId || null
    },
    supabase: deps.supabase || null
  });

  // If out of scope / adjacent / high risk / crisis, return deterministic steering response.
  if (!result.shouldContinue) {
    return new Response(JSON.stringify({
      ok: true,
      handled_by: 'scope_guard',
      should_call_model: false,
      response: result.responseText,
      scope: result.scopeDecision,
      memory_policy: result.memoryPolicy
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }

  // Otherwise pass this to the next handler in your chat pipeline.
  return new Response(JSON.stringify({
    ok: true,
    handled_by: 'scope_guard',
    should_call_model: result.shouldCallModel,
    continue_pipeline: true,
    scope: result.scopeDecision,
    memory_policy: result.memoryPolicy
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

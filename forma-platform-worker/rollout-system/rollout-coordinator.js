import { evaluateFeatureFlag } from './feature-flags.js';
import { checkRuntimeCompatibility } from './compatibility-matrix.js';

export async function handleRolloutPlan(body = {}, env = {}, deps = {}) {
  const clients = body.clients || [];
  const flag = body.feature_flag || { enabled: true, rollout_percent: 100 };
  const plan = clients.map((client) => {
    const flagDecision = evaluateFeatureFlag(flag, client);
    const compatibility = checkRuntimeCompatibility({
      agent_version: client.agent_version,
      schema_version: client.schema_version,
      required_agent_version: body.required_agent_version,
      required_schema_version: body.required_schema_version,
    });
    return {
      client_slug: client.client_slug || client.slug,
      eligible: flagDecision.enabled && compatibility.compatible,
      flag: flagDecision,
      compatibility,
      rollout_action: flagDecision.enabled && compatibility.compatible ? 'enable' : 'hold',
    };
  });
  return { ok: true, feature: body.feature || body.feature_key || 'unknown', count: plan.length, plan };
}

export async function handleRolloutStatus(body = {}, env = {}, deps = {}) {
  if (!deps.supabase) return { ok: true, source: 'empty', rollouts: [] };
  const slug = body.client_slug || body.slug;
  const filter = slug ? `client_slug=eq.${encodeURIComponent(slug)}&` : '';
  const res = await deps.supabase(env, 'GET', `/rest/v1/client_agent_runtimes?${filter}select=*&order=last_seen_at.desc&limit=200`);
  if (!res.ok) throw new Error(await res.text());
  const runtimes = await res.json();
  return { ok: true, runtimes };
}

import { createDesignQualityPack, buildDeterministicHomepageHtml } from './formaut-design-quality-engine.js';

export async function handleDesignQualityPack(body = {}, env = {}) {
  const pack = createDesignQualityPack(body);
  await safeLogDesignPack(body, pack, env);
  return pack;
}

export async function handleDesignPreview(body = {}, env = {}) {
  const pack = createDesignQualityPack(body);
  const html = buildDeterministicHomepageHtml(pack, { profile: body.profile || body.business_profile || {} });
  await safeLogDesignPack(body, pack, env);
  return { ok: true, pack, html };
}

async function safeLogDesignPack(body, pack, env) {
  if (!env?.SUPABASE_URL || !env?.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/design_quality_runs`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      body: JSON.stringify({
        client_slug: body.slug || body.client_slug || null,
        industry: pack.industry,
        archetype: pack.archetype,
        suggested_model: pack.cost_plan?.suggested_model || null,
        estimated_prompt_tokens: pack.cost_plan?.estimated_prompt_tokens || 0,
        deterministic_preview: pack.cost_plan?.can_render_preview_without_llm === true,
        payload: pack,
      }),
    });
  } catch (_) {}
}

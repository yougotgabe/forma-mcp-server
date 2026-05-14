export function selectModelPolicy({ intent = {}, degraded = false, requestedModel = null } = {}) {
  if (requestedModel) return { model: requestedModel, reason: 'requested_model' };
  if (degraded) return { model: 'claude-3-5-haiku-latest', max_tokens: 500, reason: 'degraded_margin_protection' };
  if (intent.request_class === 'generation') return { model: 'claude-sonnet-4-20250514', max_tokens: 8192, reason: 'generation_requires_synthesis' };
  if (intent.type === 'extraction' || intent.request_class === 'maintenance') return { model: 'claude-3-5-haiku-latest', max_tokens: 1200, reason: 'cheap_structured_work' };
  return { model: 'claude-3-5-haiku-latest', max_tokens: 900, reason: 'interactive_default' };
}

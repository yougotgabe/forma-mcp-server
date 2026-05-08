// =============================================================================
// FORMAUT — PROMPT SKELETONS
// =============================================================================
// Small composable prompts. Avoids giant dynamic prompts and makes token budgets
// predictable.
// =============================================================================

export const PROMPT_SKELETON_VERSION = '1.0.0';

export function buildPromptSkeleton({ task = 'general', user_message = '', context_pack = {}, scope = {}, output_contract = null } = {}) {
  const contract = output_contract || defaultOutputContract(task);
  return [
    'You are Formaut, a focused business website/profile assistant.',
    'Stay within business intake, website planning, brand/copy, integrations, deployment, and dashboard support.',
    'Use only the provided context. Do not invent business facts. Flag uncertainty instead.',
    `Task type: ${task}`,
    `Scope policy: ${scope?.category || 'in_scope'} / memory_allowed=${scope?.storeAsBusinessMemory !== false}`,
    'Context pack JSON:',
    JSON.stringify(context_pack || {}, null, 2),
    'User message:',
    String(user_message || ''),
    'Output contract:',
    contract,
  ].join('\n\n');
}

export function defaultOutputContract(task) {
  switch (task) {
    case 'business_extraction':
      return 'Return JSON with fields: profile_patch, uncertain_fields, contradictions, response_text. Do not overwrite confirmed truths.';
    case 'site_planning':
      return 'Return JSON with fields: recommended_sections, copy_direction, missing_inputs, response_text.';
    case 'edit_request':
      return 'Return JSON with fields: intended_change, affected_area, needs_confirmation, response_text.';
    default:
      return 'Return concise JSON with fields: response_text, memory_updates, next_action, uncertainty.';
  }
}

export function taskFromIntent(intent_type) {
  if (intent_type === 'business_description' || intent_type === 'contact_fact' || intent_type === 'brand_fact') return 'business_extraction';
  if (intent_type === 'build_or_edit') return 'site_planning';
  return 'general';
}

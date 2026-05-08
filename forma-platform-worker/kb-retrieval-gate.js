// =============================================================================
// FORMAUT — KB RETRIEVAL GATE
// =============================================================================
// Decides whether KB should be injected at all. Default bias: no KB unless the
// user request clearly needs project/design/deployment knowledge.
// =============================================================================

export const KB_RETRIEVAL_GATE_VERSION = '1.0.0';

const KB_RULES = [
  { bucket: 'design', patterns: [/design/i, /layout/i, /animation/i, /style library/i, /visual/i, /brand direction/i], max: 2 },
  { bucket: 'deployment', patterns: [/deploy/i, /wrangler/i, /cloudflare/i, /supabase/i, /github/i, /domain/i, /dns/i], max: 3 },
  { bucket: 'business_profile', patterns: [/business profile/i, /intake/i, /services/i, /onboarding/i, /crawl/i, /contradiction/i], max: 2 },
  { bucket: 'code', patterns: [/code/i, /worker/i, /api/i, /route/i, /endpoint/i, /schema/i], max: 3 },
];

export function decideKbRetrieval({ message = '', intent_type = 'unknown', available_fragments = [] } = {}) {
  const text = String(message || '');
  if (!text.trim()) return noKb('empty_message');
  if (['greeting', 'thanks', 'ack', 'help', 'url_only', 'contact_fact', 'brand_fact'].includes(intent_type)) {
    return noKb(`intent_${intent_type}_does_not_need_kb`);
  }

  const matches = KB_RULES
    .map(rule => ({ ...rule, score: rule.patterns.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0) }))
    .filter(rule => rule.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!matches.length) return noKb('no_relevant_kb_rule_matched');

  const maxFragments = Math.min(3, Math.max(...matches.map(m => m.max)));
  const buckets = matches.map(m => m.bucket).slice(0, 2);
  const selected = rankFragments(available_fragments, buckets).slice(0, maxFragments);

  return {
    should_retrieve_kb: selected.length > 0,
    buckets,
    max_fragments: maxFragments,
    selected_fragments: selected,
    reason: selected.length ? 'message_matched_kb_gate_rules' : 'kb_relevant_but_no_fragments_supplied',
  };
}

function noKb(reason) {
  return { should_retrieve_kb: false, buckets: [], max_fragments: 0, selected_fragments: [], reason };
}

function rankFragments(fragments = [], buckets = []) {
  return (fragments || [])
    .map(fragment => ({ fragment, score: scoreFragment(fragment, buckets) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.fragment);
}

function scoreFragment(fragment, buckets) {
  const text = `${fragment.bucket || ''} ${fragment.title || ''} ${fragment.tags || ''} ${fragment.content || fragment.text || ''}`.toLowerCase();
  let score = 0;
  for (const bucket of buckets) if (text.includes(bucket.replace('_', ' ')) || text.includes(bucket)) score += 4;
  if (fragment.confidence) score += Number(fragment.confidence);
  return score;
}

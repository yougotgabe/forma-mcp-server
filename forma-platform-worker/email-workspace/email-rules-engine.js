export async function evaluateEmailRules({ event, rules = [] }) {
  return rules.filter(rule => rule.enabled !== false && rule.trigger === event.type);
}

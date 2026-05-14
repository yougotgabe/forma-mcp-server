export function classifyGatewayIntent(input = {}) {
  const text = String(input.message || input.text || '').toLowerCase();
  if (/\b(hello|hi|thanks|thank you|help)\b/.test(text) && text.length < 160) return { type: 'small_talk', request_class: 'interactive', deterministic: true };
  if (/\b(build|create|generate|redesign|implement|code|repo|deploy)\b/.test(text)) return { type: 'generation', request_class: 'generation', deterministic: false };
  if (/\b(check|health|status|broken|error|fix|repair|validate)\b/.test(text)) return { type: 'maintenance', request_class: 'maintenance', deterministic: false };
  if (/\b(extract|summarize|classify|normalize|import)\b/.test(text)) return { type: 'extraction', request_class: 'maintenance', deterministic: false };
  return { type: 'general', request_class: 'interactive', deterministic: false };
}

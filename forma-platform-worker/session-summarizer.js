// =============================================================================
// FORMAUT — SESSION SUMMARIZER
// =============================================================================
// Deterministic rolling-summary helpers. Use these before deciding whether a
// paid summarization call is needed.
// =============================================================================

export const SESSION_SUMMARIZER_VERSION = '1.0.0';

export function buildDeterministicSessionSummary({ existing_summary = '', turns = [], max_turns = 12 } = {}) {
  const recent = (turns || []).slice(-max_turns);
  const userLines = recent
    .filter(t => (t.role || '').toLowerCase() === 'user')
    .map(t => String(t.content || t.message || '').trim())
    .filter(Boolean);

  const extracted = {
    urls: unique(userLines.flatMap(extractUrls)).slice(0, 5),
    emails: unique(userLines.flatMap(extractEmails)).slice(0, 5),
    phones: unique(userLines.flatMap(extractPhones)).slice(0, 5),
    likely_preferences: userLines.filter(line => /i like|i want|prefer|don't want|do not want|make it|tone|style|color/i.test(line)).slice(-8),
    likely_actions: userLines.filter(line => /build|create|change|update|fix|add|remove|deploy|publish|crawl|ingest/i.test(line)).slice(-8),
  };

  const summaryText = [
    existing_summary ? `Prior summary: ${String(existing_summary).slice(0, 900)}` : '',
    userLines.length ? `Recent user focus: ${userLines.slice(-4).join(' / ').slice(0, 1200)}` : '',
    extracted.likely_actions.length ? `Likely requested actions: ${extracted.likely_actions.join(' | ').slice(0, 900)}` : '',
    extracted.likely_preferences.length ? `Likely preferences: ${extracted.likely_preferences.join(' | ').slice(0, 900)}` : '',
  ].filter(Boolean).join('\n');

  return {
    version: SESSION_SUMMARIZER_VERSION,
    summary: summaryText || 'No meaningful session content yet.',
    extracted,
    compression: {
      input_turns: turns.length,
      retained_turns: recent.length,
      should_request_llm_summary: shouldRequestLlmSummary(turns, summaryText),
    },
  };
}

export function shouldRequestLlmSummary(turns = [], deterministicSummary = '') {
  const rawChars = JSON.stringify(turns || []).length;
  return rawChars > 12000 || deterministicSummary.length > 3500;
}

function extractUrls(text) { return String(text).match(/https?:\/\/[^\s]+|\b[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s]*)?/gi) || []; }
function extractEmails(text) { return String(text).match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || []; }
function extractPhones(text) { return String(text).match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g) || []; }
function unique(arr) { return [...new Set((arr || []).map(x => String(x).trim()).filter(Boolean))]; }

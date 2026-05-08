/**
 * Formaut Evidence Lineage
 *
 * Purpose:
 * - Preserve where every normalized business signal came from.
 * - Keep raw evidence separate from inferred business truth.
 * - Make downstream memory writes auditable, reversible, and reviewable.
 *
 * This module does not call an LLM. It builds deterministic lineage objects
 * and calculates confidence using evidence quality, repetition, source type,
 * and contradiction penalties.
 */

export const SOURCE_WEIGHTS = Object.freeze({
  explicit_schema: 1.0,
  page_title: 0.78,
  meta_description: 0.72,
  hero_heading: 0.9,
  hero_subcopy: 0.82,
  nav_label: 0.68,
  service_heading: 0.9,
  service_card: 0.84,
  footer: 0.76,
  contact_link: 0.92,
  social_link: 0.94,
  logo_image: 0.88,
  color_token: 0.7,
  body_copy: 0.55,
  inferred: 0.42,
});

export function normalizeText(value = '') {
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .trim();
}

export function makeEvidence({
  field,
  value,
  sourceType = 'body_copy',
  url = null,
  selector = null,
  text = null,
  extractionMethod = 'deterministic',
  observedAt = new Date().toISOString(),
  metadata = {},
}) {
  return {
    id: stableEvidenceId({ field, value, sourceType, url, selector, text }),
    field,
    value: normalizeEvidenceValue(value),
    source_type: sourceType,
    url,
    selector,
    text: normalizeText(text ?? value),
    extraction_method: extractionMethod,
    observed_at: observedAt,
    metadata,
    base_weight: SOURCE_WEIGHTS[sourceType] ?? SOURCE_WEIGHTS.body_copy,
  };
}

export function buildLineageSignal({
  field,
  value,
  evidence = [],
  candidates = [],
  existingValue = null,
  requiredEvidence = 1,
  uncertaintyReason = null,
}) {
  const normalizedValue = normalizeEvidenceValue(value);
  const cleanEvidence = evidence
    .filter(Boolean)
    .map((item) => item.id ? item : makeEvidence({ field, value: normalizedValue, ...item }));

  const distinctSourceTypes = new Set(cleanEvidence.map((e) => e.source_type)).size;
  const distinctUrls = new Set(cleanEvidence.map((e) => e.url).filter(Boolean)).size;
  const repetition = cleanEvidence.length;
  const evidenceStrength = cleanEvidence.reduce((sum, e) => sum + (e.base_weight ?? 0.5), 0);

  const repetitionBonus = Math.min(0.18, Math.max(0, repetition - 1) * 0.045);
  const sourceDiversityBonus = Math.min(0.12, Math.max(0, distinctSourceTypes - 1) * 0.04);
  const urlDiversityBonus = Math.min(0.08, Math.max(0, distinctUrls - 1) * 0.03);
  const sufficiencyPenalty = repetition < requiredEvidence ? 0.18 : 0;
  const contradictionPenalty = existingValue && !valuesCompatible(existingValue, normalizedValue) ? 0.24 : 0;

  const averageStrength = cleanEvidence.length ? evidenceStrength / cleanEvidence.length : 0.2;
  const confidence = clamp01(
    averageStrength + repetitionBonus + sourceDiversityBonus + urlDiversityBonus - sufficiencyPenalty - contradictionPenalty
  );

  const status = decideSignalStatus({ confidence, existingValue, value: normalizedValue, candidates, uncertaintyReason });

  return {
    field,
    value: normalizedValue,
    confidence,
    status,
    uncertainty_reason: uncertaintyReason,
    evidence_ids: cleanEvidence.map((e) => e.id),
    evidence: cleanEvidence,
    candidates: rankCandidates(candidates),
    existing_value: existingValue,
    can_autofill: status === 'candidate' && confidence >= 0.74 && !contradictionPenalty,
    should_ask_user: status === 'ambiguous' || status === 'contradicted' || confidence < 0.58,
    generated_at: new Date().toISOString(),
  };
}

export function groupEvidenceIntoSignals(evidenceItems = [], existingProfile = {}) {
  const byFieldValue = new Map();
  for (const item of evidenceItems) {
    const evidence = item.id ? item : makeEvidence(item);
    const key = `${evidence.field}::${JSON.stringify(evidence.value)}`;
    if (!byFieldValue.has(key)) byFieldValue.set(key, []);
    byFieldValue.get(key).push(evidence);
  }

  const byField = new Map();
  for (const [key, evidence] of byFieldValue.entries()) {
    const [field] = key.split('::');
    const value = evidence[0]?.value;
    const signal = buildLineageSignal({
      field,
      value,
      evidence,
      existingValue: existingProfile[field] ?? null,
    });
    if (!byField.has(field)) byField.set(field, []);
    byField.get(field).push(signal);
  }

  const result = {};
  for (const [field, signals] of byField.entries()) {
    result[field] = rankCandidates(signals).map((signal, index) => ({
      ...signal,
      selected: index === 0 && signal.confidence >= 0.58 && signal.status !== 'contradicted',
    }));
  }
  return result;
}

export function createEvidenceSnapshot({ crawlId, sourceUrl, rawArtifacts, normalizedSignals, profilePatch }) {
  return {
    schema_version: 'evidence_snapshot.v1',
    crawl_id: crawlId,
    source_url: sourceUrl,
    created_at: new Date().toISOString(),
    raw_artifact_summary: summarizeRawArtifacts(rawArtifacts),
    normalized_signals: normalizedSignals,
    proposed_profile_patch: profilePatch,
    review_state: profilePatch?.needs_review ? 'needs_review' : 'ready',
  };
}

function summarizeRawArtifacts(raw = {}) {
  return {
    pages_crawled: raw.pages?.length ?? raw.pages_crawled ?? 0,
    headings_count: raw.headings?.length ?? 0,
    services_count: raw.services?.length ?? 0,
    colors_count: raw.colors?.length ?? 0,
    logo_candidates_count: raw.logo_candidates?.length ?? 0,
    social_links_count: raw.social_links?.length ?? 0,
    contact_methods_count: raw.contact_methods?.length ?? 0,
  };
}

function normalizeEvidenceValue(value) {
  if (Array.isArray(value)) return value.map(normalizeEvidenceValue).filter(Boolean);
  if (value && typeof value === 'object') return value;
  return normalizeText(value);
}

function valuesCompatible(a, b) {
  const left = normalizeText(a).toLowerCase();
  const right = normalizeText(b).toLowerCase();
  if (!left || !right) return true;
  return left === right || left.includes(right) || right.includes(left);
}

function rankCandidates(candidates = []) {
  return [...candidates].sort((a, b) => (b.confidence ?? b.score ?? 0) - (a.confidence ?? a.score ?? 0));
}

function decideSignalStatus({ confidence, existingValue, value, candidates, uncertaintyReason }) {
  if (existingValue && !valuesCompatible(existingValue, value)) return 'contradicted';
  if (uncertaintyReason) return 'ambiguous';
  const ranked = rankCandidates(candidates);
  if (ranked.length > 1) {
    const top = ranked[0]?.confidence ?? ranked[0]?.score ?? 0;
    const second = ranked[1]?.confidence ?? ranked[1]?.score ?? 0;
    if (top - second < 0.12) return 'ambiguous';
  }
  if (confidence >= 0.74) return 'candidate';
  if (confidence >= 0.5) return 'weak_candidate';
  return 'low_confidence';
}

function stableEvidenceId(payload) {
  const input = JSON.stringify(payload);
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return `ev_${Math.abs(hash).toString(36)}`;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

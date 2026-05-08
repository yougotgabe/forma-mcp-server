/**
 * Formaut Evidence Substrate Orchestrator
 *
 * One function that takes raw crawl artifacts and returns:
 * - lineage-backed evidence
 * - normalized structured signals
 * - uncertainty review plan
 * - proposed safe profile patch
 */

import { makeEvidence, buildLineageSignal, createEvidenceSnapshot } from './evidence-lineage.js';
import { inferIndustry, extractServiceCandidates } from './industry-ontology.js';
import { normalizeVisualStyle } from './visual-style-normalizer.js';
import { assessUncertainty } from './uncertainty-engine.js';

export function runEvidenceSubstrate(rawCrawl = {}, options = {}) {
  const existingProfile = options.existingProfile ?? {};
  const sourceUrl = rawCrawl.source_url ?? rawCrawl.url ?? options.sourceUrl ?? null;
  const texts = collectTexts(rawCrawl);
  const evidence = [];

  for (const heading of rawCrawl.headings ?? []) {
    const text = typeof heading === 'string' ? heading : heading.text;
    const selector = typeof heading === 'string' ? null : heading.selector;
    if (!text) continue;
    evidence.push(makeEvidence({ field: 'hero_copy', value: text, sourceType: 'hero_heading', url: sourceUrl, selector, text }));
  }

  for (const service of rawCrawl.services ?? []) {
    const value = typeof service === 'string' ? service : service.text ?? service.name;
    if (!value) continue;
    evidence.push(makeEvidence({ field: 'primary_services', value, sourceType: 'service_card', url: service.url ?? sourceUrl, text: value }));
  }

  for (const contact of rawCrawl.contact_methods ?? rawCrawl.contact ?? []) {
    const value = typeof contact === 'string' ? contact : contact.value ?? contact.href ?? contact.text;
    if (!value) continue;
    evidence.push(makeEvidence({ field: 'contact_methods', value, sourceType: 'contact_link', url: sourceUrl, text: value, metadata: contact }));
  }

  for (const social of rawCrawl.social_links ?? []) {
    const value = typeof social === 'string' ? social : social.href ?? social.url;
    if (!value) continue;
    evidence.push(makeEvidence({ field: 'social_links', value, sourceType: 'social_link', url: sourceUrl, text: value, metadata: social }));
  }

  for (const logo of rawCrawl.logo_candidates ?? []) {
    const value = typeof logo === 'string' ? logo : logo.src ?? logo.url;
    if (!value) continue;
    evidence.push(makeEvidence({ field: 'logo_sources', value, sourceType: 'logo_image', url: sourceUrl, text: value, metadata: logo }));
  }

  const industry = inferIndustry({ texts, services: (rawCrawl.services ?? []).map((s) => typeof s === 'string' ? s : s.text ?? s.name ?? '') });
  const serviceCandidates = extractServiceCandidates({ texts });
  const visual = normalizeVisualStyle({
    colors: rawCrawl.colors ?? [],
    logoCandidates: rawCrawl.logo_candidates ?? [],
    imageAlts: rawCrawl.image_alts ?? [],
    classNames: rawCrawl.class_names ?? [],
    texts,
  });

  const normalizedSignals = {
    industry: buildLineageSignal({
      field: 'industry',
      value: industry.value,
      evidence: industry.candidates.slice(0, 3).flatMap((c) => [
        ...c.proof.keyword_hits.map((hit) => makeEvidence({ field: 'industry', value: c.value, sourceType: 'inferred', url: sourceUrl, text: hit, extractionMethod: 'heuristic' })),
        ...c.proof.service_hits.map((hit) => makeEvidence({ field: 'industry', value: c.value, sourceType: 'service_heading', url: sourceUrl, text: hit, extractionMethod: 'heuristic' })),
      ]),
      candidates: industry.candidates,
      existingValue: existingProfile.industry,
      uncertaintyReason: industry.uncertainty_reason,
    }),
    visual_style: visual.visual_style,
    palette: visual.palette,
    primary_services: serviceCandidates,
    proof: {
      service_mentions: evidence.filter((e) => e.field === 'primary_services'),
      hero_copy: evidence.filter((e) => e.field === 'hero_copy'),
      logo_sources: evidence.filter((e) => e.field === 'logo_sources'),
    },
  };

  const fieldSignals = {
    industry: normalizedSignals.industry,
    visual_style: visual.visual_style.map((tag) => ({ field: 'visual_style', value: tag.value, confidence: tag.confidence, status: 'candidate' })),
    primary_services: serviceCandidates.map((svc) => ({ field: 'primary_services', value: svc.value, confidence: svc.confidence, status: 'candidate' })),
  };

  const uncertainty = assessUncertainty(fieldSignals);
  const profilePatch = buildProfilePatch(normalizedSignals, uncertainty);

  return createEvidenceSnapshot({
    crawlId: rawCrawl.crawl_id ?? options.crawlId ?? null,
    sourceUrl,
    rawArtifacts: rawCrawl,
    normalizedSignals,
    profilePatch: {
      ...profilePatch,
      needs_review: uncertainty.needs_review,
      review_items: uncertainty.review_items,
    },
  });
}

function collectTexts(raw = {}) {
  return [
    ...(raw.headings ?? []).map((h) => typeof h === 'string' ? h : h.text),
    ...(raw.services ?? []).map((s) => typeof s === 'string' ? s : s.text ?? s.name),
    ...(raw.hero_copy ?? []),
    ...(raw.body_text ? [raw.body_text] : []),
    ...(raw.pages ?? []).flatMap((p) => [p.title, p.description, ...(p.headings ?? [])]),
  ].filter(Boolean);
}

function buildProfilePatch(signals, uncertainty) {
  const patch = { ...uncertainty.approved_candidates };
  if (signals.palette?.length) patch.visual_palette = signals.palette;
  if (signals.proof) patch.proof = signals.proof;
  return patch;
}

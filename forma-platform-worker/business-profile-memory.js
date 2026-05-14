// =============================================================================
// FORMAUT - BUSINESS PROFILE MEMORY MODULE
// =============================================================================
// Durable business identity layer: profile creation, candidate staging,
// acceptance/rejection, conflict handling, snapshots, audit events, completeness.
// =============================================================================

import { decideCandidateStatus, getFieldPolicy, normalizeConfidence, isEmptyValue } from './memory-confidence-policy.js';
import { detectMemoryConflict, mergeProfileValue } from './memory-conflict-detector.js';
import { calculateProfileCompleteness } from './profile-completeness-engine.js';
import { buildBusinessProfileMemoryContext } from './business-profile-context-builder.js';

const PROFILE_FIELDS = [
  'business_name', 'industry', 'description', 'brand_tone', 'visual_style',
  'primary_services', 'secondary_services', 'service_area', 'location',
  'contact_methods', 'social_links', 'website_url', 'logo_sources',
];

export async function runBusinessProfileMemoryTest({ clientId, clientFetch, facts = {}, sourceType = 'manual_test' }) {
  const profile = await getOrCreateBusinessProfile({ clientId, clientFetch });
  const candidates = factsToCandidates(facts, sourceType);
  const results = [];

  for (const candidate of candidates) {
    results.push(await stageMemoryCandidate({
      clientId,
      profileId: profile.id,
      clientFetch,
      field: candidate.field,
      proposedValue: candidate.value,
      sourceType,
      sourceRef: 'profile_memory_test',
      confidence: candidate.confidence,
      evidenceRefs: candidate.evidence_refs || [],
      actorType: 'system',
    }));
  }

  const freshProfile = await getBusinessProfile({ clientId, clientFetch });
  const completeness = calculateProfileCompleteness(freshProfile || profile);
  await upsertCompleteness({ clientFetch, profileId: (freshProfile || profile).id, completeness });

  return {
    ok: true,
    profile_updated: results.some(r => r.status === 'auto_accepted'),
    profile_id: (freshProfile || profile).id,
    candidates_created: results.length,
    auto_accepted: results.filter(r => r.status === 'auto_accepted').length,
    pending: results.filter(r => r.status === 'pending').length,
    rejected: results.filter(r => r.status === 'rejected').length,
    contradictions: results.filter(r => r.status === 'contradicted').map(r => ({ field: r.field, proposed_value: r.proposed_value, reason: r.reason })),
    completeness_score: completeness.score,
    completeness,
    context: await getBusinessProfileMemoryContext({ clientId, clientFetch }),
  };
}

export async function getOrCreateBusinessProfile({ clientId, clientFetch }) {
  const existing = await getBusinessProfile({ clientId, clientFetch });
  if (existing) return existing;
  const payload = emptyProfile(clientId);
  const res = await clientFetch('/rest/v1/business_profiles', 'POST', payload, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(await responseError('Could not create business profile', res));
  const rows = await res.json();
  const profile = rows[0];
  await logMemoryEvent({ clientFetch, clientId, profileId: profile.id, eventType: 'profile_created', newValue: profile, actorType: 'system', reason: 'Created profile for business memory system.' });
  await createVersionSnapshot({ clientFetch, clientId, profileId: profile.id, snapshot: profile, createdByEventId: null });
  return profile;
}

export async function getBusinessProfile({ clientId, clientFetch }) {
  const res = await clientFetch(`/rest/v1/business_profiles?client_id=eq.${encodeURIComponent(clientId)}&select=*&limit=1`, 'GET');
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

export async function stageMemoryCandidate({ clientId, profileId, clientFetch, field, proposedValue, sourceType = 'inferred', sourceRef = null, confidence = 0.6, evidenceRefs = [], actorType = 'system' }) {
  const profile = await getProfileById({ clientFetch, profileId });
  if (!profile) throw new Error('Business profile not found for candidate staging.');

  const normalizedConfidence = normalizeConfidence(confidence, sourceType);
  const existingValue = profile[field];
  const conflict = detectMemoryConflict({ field, existingValue, proposedValue });
  const decision = decideCandidateStatus({ field, value: proposedValue, confidence: normalizedConfidence, sourceType, existingValue, conflict });

  const candidateRow = {
    client_id: clientId,
    profile_id: profileId,
    field,
    proposed_value: proposedValue,
    source_type: sourceType,
    source_ref: sourceRef,
    confidence: normalizedConfidence,
    status: decision.status,
    reason: decision.reason,
    evidence_refs: evidenceRefs,
  };

  const candidateRes = await clientFetch('/rest/v1/business_memory_candidates', 'POST', candidateRow, { Prefer: 'return=representation' });
  if (!candidateRes.ok) throw new Error(await responseError('Could not create memory candidate', candidateRes));
  const candidate = (await candidateRes.json())[0];

  await logMemoryEvent({
    clientFetch, clientId, profileId, eventType: 'candidate_created', field,
    newValue: proposedValue, confidence: normalizedConfidence, actorType,
    reason: decision.reason, evidenceRefs,
  });

  if (decision.action === 'accept') {
    await acceptMemoryCandidate({ clientId, profileId, clientFetch, candidate, profile, actorType, reason: decision.reason });
  } else if (decision.action === 'contradict') {
    await logMemoryEvent({
      clientFetch, clientId, profileId, eventType: 'contradicted', field,
      previousValue: existingValue, newValue: proposedValue, confidence: normalizedConfidence,
      actorType, reason: decision.reason, evidenceRefs,
    });
  }

  return { ...candidate, status: decision.status, field, proposed_value: proposedValue, reason: decision.reason };
}

export async function acceptMemoryCandidate({ clientId, profileId, clientFetch, candidate, profile = null, actorType = 'system', reason = 'Accepted memory candidate.' }) {
  const currentProfile = profile || await getProfileById({ clientFetch, profileId });
  const field = candidate.field;
  const policy = getFieldPolicy(field);
  const previousValue = currentProfile[field];
  const newFieldValue = mergeProfileValue(previousValue, candidate.proposed_value, policy);

  const patch = {
    [field]: newFieldValue,
    updated_at: new Date().toISOString(),
  };

  const confidenceSummary = { ...(currentProfile.confidence_summary || {}) };
  confidenceSummary[field] = {
    confidence: candidate.confidence,
    source_type: candidate.source_type,
    candidate_id: candidate.id,
    accepted_at: new Date().toISOString(),
  };
  patch.confidence_summary = confidenceSummary;

  const previewProfile = { ...currentProfile, ...patch };
  const completeness = calculateProfileCompleteness(previewProfile);
  patch.completeness_score = completeness.score;

  const res = await clientFetch(`/rest/v1/business_profiles?id=eq.${candidate.profile_id}`, 'PATCH', patch, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(await responseError('Could not apply profile patch', res));
  const updated = (await res.json())[0];

  await clientFetch(`/rest/v1/business_memory_candidates?id=eq.${candidate.id}`, 'PATCH', { status: 'auto_accepted', reason });
  const event = await logMemoryEvent({
    clientFetch, clientId, profileId, eventType: 'accepted', field,
    previousValue, newValue: newFieldValue, confidence: candidate.confidence,
    actorType, reason, evidenceRefs: candidate.evidence_refs || [],
  });
  await createVersionSnapshot({ clientFetch, clientId, profileId, snapshot: updated, createdByEventId: event?.id || null });
  await upsertCompleteness({ clientFetch, profileId, completeness });
  return updated;
}

export async function rejectMemoryCandidate({ clientFetch, candidateId, reason = 'Rejected by reviewer.', actorType = 'user' }) {
  const res = await clientFetch(`/rest/v1/business_memory_candidates?id=eq.${candidateId}`, 'PATCH', { status: 'rejected', reason }, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(await responseError('Could not reject candidate', res));
  const candidate = (await res.json())[0];
  await logMemoryEvent({
    clientFetch, clientId: candidate.client_id, profileId: candidate.profile_id, eventType: 'rejected', field: candidate.field,
    newValue: candidate.proposed_value, confidence: candidate.confidence, actorType, reason, evidenceRefs: candidate.evidence_refs || [],
  });
  return candidate;
}

export async function applyProfilePatch({ clientId, profileId, clientFetch, patch, actorType = 'agent', reason = 'Applied profile patch.', evidenceRefs = [] }) {
  const current = await getProfileById({ clientFetch, profileId });
  if (!current) throw new Error('Business profile not found.');
  const safePatch = {};
  for (const key of PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) safePatch[key] = patch[key];
  }
  safePatch.updated_at = new Date().toISOString();
  const completeness = calculateProfileCompleteness({ ...current, ...safePatch });
  safePatch.completeness_score = completeness.score;
  const res = await clientFetch(`/rest/v1/business_profiles?id=eq.${profileId}`, 'PATCH', safePatch, { Prefer: 'return=representation' });
  if (!res.ok) throw new Error(await responseError('Could not apply profile patch', res));
  const updated = (await res.json())[0];
  const event = await logMemoryEvent({ clientFetch, clientId, profileId, eventType: 'overwritten', previousValue: current, newValue: safePatch, actorType, reason, evidenceRefs });
  await createVersionSnapshot({ clientFetch, clientId, profileId, snapshot: updated, createdByEventId: event?.id || null });
  await upsertCompleteness({ clientFetch, profileId, completeness });
  return updated;
}

export async function getBusinessProfileMemoryContext({ clientId, clientFetch }) {
  const profile = await getBusinessProfile({ clientId, clientFetch });
  if (!profile) return buildBusinessProfileMemoryContext({ profile: {}, pendingCandidates: [], recentEvents: [] });

  const [pendingRes, eventsRes] = await Promise.all([
    clientFetch(`/rest/v1/business_memory_candidates?profile_id=eq.${profile.id}&status=in.(pending,contradicted)&order=created_at.desc&limit=20`, 'GET'),
    clientFetch(`/rest/v1/business_memory_events?profile_id=eq.${profile.id}&order=created_at.desc&limit=20`, 'GET'),
  ]);
  const pending = pendingRes.ok ? await pendingRes.json() : [];
  const events = eventsRes.ok ? await eventsRes.json() : [];
  return buildBusinessProfileMemoryContext({ profile, pendingCandidates: pending, recentEvents: events });
}

async function getProfileById({ clientFetch, profileId }) {
  const res = await clientFetch(`/rest/v1/business_profiles?id=eq.${profileId}&select=*&limit=1`, 'GET');
  if (!res.ok) return null;
  return (await res.json())[0] || null;
}

async function logMemoryEvent({ clientFetch, clientId, profileId, eventType, field = null, previousValue = null, newValue = null, confidence = null, actorType = 'system', actorId = null, reason = null, evidenceRefs = [] }) {
  const row = {
    client_id: clientId,
    profile_id: profileId,
    event_type: eventType,
    field,
    previous_value: previousValue,
    new_value: newValue,
    confidence,
    actor_type: actorType,
    actor_id: actorId,
    reason,
    evidence_refs: evidenceRefs,
  };
  const res = await clientFetch('/rest/v1/business_memory_events', 'POST', row, { Prefer: 'return=representation' });
  if (!res.ok) return null;
  return (await res.json())[0] || null;
}

async function createVersionSnapshot({ clientFetch, clientId, profileId, snapshot, createdByEventId = null }) {
  const latestRes = await clientFetch(`/rest/v1/business_profile_versions?profile_id=eq.${profileId}&select=version_number&order=version_number.desc&limit=1`, 'GET');
  const latest = latestRes.ok ? await latestRes.json() : [];
  const versionNumber = (latest[0]?.version_number || 0) + 1;
  const row = { client_id: clientId, profile_id: profileId, version_number: versionNumber, snapshot, created_by_event_id: createdByEventId };
  const res = await clientFetch('/rest/v1/business_profile_versions', 'POST', row, { Prefer: 'return=representation' });
  return res.ok ? (await res.json())[0] : null;
}

async function upsertCompleteness({ clientFetch, profileId, completeness }) {
  const row = {
    profile_id: profileId,
    has_business_name: completeness.has_business_name,
    has_industry: completeness.has_industry,
    has_services: completeness.has_services,
    has_contact: completeness.has_contact,
    has_location: completeness.has_location,
    has_tone: completeness.has_tone,
    has_visual_style: completeness.has_visual_style,
    has_social_links: completeness.has_social_links,
    score: completeness.score,
    missing_fields: completeness.missing_fields,
    updated_at: new Date().toISOString(),
  };
  const existingRes = await clientFetch(`/rest/v1/business_profile_completeness?profile_id=eq.${profileId}&select=profile_id&limit=1`, 'GET');
  const existing = existingRes.ok ? await existingRes.json() : [];
  if (existing.length) return clientFetch(`/rest/v1/business_profile_completeness?profile_id=eq.${profileId}`, 'PATCH', row);
  return clientFetch('/rest/v1/business_profile_completeness', 'POST', row);
}

function emptyProfile(clientId) {
  return {
    client_id: clientId,
    business_name: null,
    industry: null,
    description: null,
    brand_tone: [],
    visual_style: [],
    primary_services: [],
    secondary_services: [],
    service_area: [],
    location: null,
    contact_methods: [],
    social_links: [],
    website_url: null,
    logo_sources: [],
    confidence_summary: {},
    completeness_score: 0,
  };
}

function factsToCandidates(facts = {}, sourceType = 'manual_test') {
  const out = [];
  for (const field of PROFILE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(facts, field)) continue;
    const value = facts[field];
    if (isEmptyValue(value)) continue;
    out.push({ field, value, confidence: defaultConfidence(sourceType, field) });
  }
  if (facts.services && !facts.primary_services) out.push({ field: 'primary_services', value: facts.services, confidence: defaultConfidence(sourceType, 'primary_services') });
  if (facts.contact && !facts.contact_methods) out.push({ field: 'contact_methods', value: facts.contact, confidence: defaultConfidence(sourceType, 'contact_methods') });
  return out;
}

function defaultConfidence(sourceType, field) {
  if (sourceType === 'user_confirmation') return 0.99;
  if (sourceType === 'manual_test' || sourceType === 'manual_admin') return field === 'industry' ? 0.94 : 0.96;
  if (sourceType === 'chat') return 0.92;
  if (sourceType === 'crawl') return 0.9;
  return 0.7;
}

async function responseError(prefix, res) {
  let detail = '';
  try { detail = await res.text(); } catch {}
  return `${prefix}: ${res.status} ${detail}`;
}

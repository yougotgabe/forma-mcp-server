// =============================================================================
// FORMAUT - BUSINESS MEMORY CONFLICT DETECTOR
// =============================================================================
// Compares proposed facts to existing profile values. It flags material
// contradictions without treating formatting differences as conflicts.
// =============================================================================

import { isEmptyValue } from './memory-confidence-policy.js';

export function detectMemoryConflict({ field, existingValue, proposedValue }) {
  if (isEmptyValue(existingValue) || isEmptyValue(proposedValue)) {
    return { hasConflict: false, type: 'none', reason: null };
  }

  if (Array.isArray(existingValue) || Array.isArray(proposedValue)) {
    const existing = toArray(existingValue).map(canonicalize).filter(Boolean);
    const proposed = toArray(proposedValue).map(canonicalize).filter(Boolean);
    const overlap = proposed.filter(v => existing.includes(v));
    if (overlap.length > 0) return { hasConflict: false, type: 'duplicate_or_overlap', reason: null };
    return { hasConflict: false, type: 'additive_array', reason: null };
  }

  const a = canonicalize(existingValue);
  const b = canonicalize(proposedValue);
  if (!a || !b || a === b) return { hasConflict: false, type: 'same', reason: null };

  if (looksLikeAlias(a, b)) {
    return { hasConflict: false, type: 'possible_alias', reason: 'Values look like possible aliases rather than a hard contradiction.' };
  }

  const strictFields = new Set(['business_name', 'website_url', 'location']);
  if (strictFields.has(field)) {
    return { hasConflict: true, type: 'material_difference', reason: `Existing ${field} differs materially from proposed value.` };
  }

  return { hasConflict: true, type: 'meaningful_difference', reason: `Proposed ${field} differs from existing profile value.` };
}

export function mergeProfileValue(existingValue, proposedValue, fieldPolicy = {}) {
  if (fieldPolicy.mergeArray || Array.isArray(existingValue) || Array.isArray(proposedValue)) {
    const seen = new Set();
    const merged = [];
    for (const item of [...toArray(existingValue), ...toArray(proposedValue)]) {
      if (isEmptyValue(item)) continue;
      const key = canonicalize(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return merged;
  }
  return isEmptyValue(existingValue) ? proposedValue : existingValue;
}

export function canonicalize(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return canonicalize(JSON.stringify(value));
  return String(value)
    .toLowerCase()
    .replace(/\b(llc|inc|co|company|studios?)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function looksLikeAlias(a, b) {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const as = new Set(a.split(/\s+/));
  const bs = new Set(b.split(/\s+/));
  const common = [...as].filter(x => bs.has(x));
  return common.length >= Math.min(as.size, bs.size, 2);
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

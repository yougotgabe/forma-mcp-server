/**
 * Formaut Visual Style Normalizer
 *
 * Converts raw visual artifacts into inspectable style signals.
 * This should inform design agents without becoming unverified truth.
 */

const HEX_RE = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

export function normalizeVisualStyle({ colors = [], logoCandidates = [], imageAlts = [], classNames = [], texts = [] }) {
  const palette = normalizePalette(colors);
  const words = [...imageAlts, ...classNames, ...texts].join(' ').toLowerCase();
  const tags = [];

  addTag(tags, 'modern', words, ['modern', 'clean', 'sleek', 'minimal', 'contemporary']);
  addTag(tags, 'premium', words, ['premium', 'luxury', 'bespoke', 'crafted', 'signature']);
  addTag(tags, 'friendly', words, ['friendly', 'family', 'local', 'welcoming', 'community']);
  addTag(tags, 'rugged', words, ['rugged', 'outdoor', 'durable', 'tough', 'industrial']);
  addTag(tags, 'clinical', words, ['clinic', 'medical', 'care', 'wellness', 'professional']);
  addTag(tags, 'creative', words, ['creative', 'studio', 'brand', 'visual', 'content']);

  const colorTags = inferColorStyle(palette);
  for (const tag of colorTags) tags.push(tag);

  const logoSignal = logoCandidates?.length ? {
    value: logoCandidates[0]?.src ?? logoCandidates[0]?.url ?? logoCandidates[0],
    confidence: logoCandidates.length > 1 ? 0.82 : 0.68,
    candidates: logoCandidates,
  } : null;

  return {
    visual_style: dedupeByValue(tags).sort((a, b) => b.confidence - a.confidence),
    palette,
    logo: logoSignal,
    confidence: tags.length ? average(tags.map((t) => t.confidence)) : 0,
  };
}

export function normalizePalette(colors = []) {
  const counts = new Map();
  for (const raw of colors) {
    const hex = normalizeHex(typeof raw === 'string' ? raw : raw?.hex ?? raw?.value);
    if (!hex) continue;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([hex, count], index) => ({
      hex,
      role: index === 0 ? 'dominant_candidate' : index === 1 ? 'accent_candidate' : 'supporting_candidate',
      confidence: Math.min(0.9, 0.52 + count * 0.08),
      observations: count,
    }));
}

function inferColorStyle(palette = []) {
  const tags = [];
  const hexes = palette.map((p) => p.hex);
  const darkCount = hexes.filter((h) => luminance(h) < 0.18).length;
  const lightCount = hexes.filter((h) => luminance(h) > 0.82).length;
  const warmCount = hexes.filter(isWarm).length;

  if (darkCount >= 2) tags.push({ value: 'dark / high-contrast', confidence: 0.72, source: 'palette_luminance' });
  if (lightCount >= 2) tags.push({ value: 'light / airy', confidence: 0.68, source: 'palette_luminance' });
  if (warmCount >= 2) tags.push({ value: 'warm', confidence: 0.66, source: 'palette_hue' });
  if (palette.length <= 3 && palette.length > 0) tags.push({ value: 'minimal palette', confidence: 0.61, source: 'palette_count' });
  return tags;
}

function addTag(tags, value, words, matches) {
  const hits = matches.filter((m) => words.includes(m));
  if (hits.length) tags.push({ value, confidence: Math.min(0.84, 0.5 + hits.length * 0.08), source: 'keyword_visual_style', proof: hits });
}

function normalizeHex(value) {
  if (!value || !HEX_RE.test(value)) return null;
  let hex = value.startsWith('#') ? value : `#${value}`;
  if (hex.length === 4) hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  return hex.toUpperCase();
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isWarm(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return r > b && r >= g * 0.85;
}

function average(nums) {
  return nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3)) : 0;
}

function dedupeByValue(items) {
  const map = new Map();
  for (const item of items) {
    const current = map.get(item.value);
    if (!current || item.confidence > current.confidence) map.set(item.value, item);
  }
  return [...map.values()];
}

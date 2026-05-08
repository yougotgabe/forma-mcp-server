import { normalizeCrawlEvidence, toBusinessProfilePatch } from './evidence-normalizer.js';

// =============================================================================
// FORMAUT — EXISTING WEBSITE CRAWL ADAPTER
// =============================================================================
// Purpose:
// - Fetch an existing business website during onboarding
// - Extract useful structured facts without requiring a form
// - Populate client_context + client_memory
// - Create contradiction events instead of overwriting higher-confidence truths
//
// Runtime: Cloudflare Workers / Pages Functions compatible.
// Dependencies: none.
// =============================================================================

const DEFAULT_CRAWL_LIMIT = 4;
const MAX_HTML_BYTES = 750_000;
const REQUEST_TIMEOUT_MS = 9000;

const BUSINESS_PROFILE_KEYS = new Set([
  'business_name', 'industry', 'industry_category', 'location', 'service_area',
  'brand_tone', 'visual_style', 'primary_colors', 'secondary_colors',
  'logo_detected', 'logo_url', 'services', 'hours', 'phone', 'email',
  'social_voice', 'existing_imagery', 'key_differentiators', 'site_goal',
  'feature_fit', 'feature_avoid', 'source_url', 'crawl_summary',
  'primary_services', 'contact_methods', 'social_links', 'evidence_confidence',
  'evidence_proof', 'evidence_normalized_at'
]);

export async function runExistingWebsiteCrawlAdapter(env, clientRecord, input = {}) {
  const startUrl = normalizeUrl(input.url || clientRecord.existing_website_url || clientRecord.live_url);
  if (!startUrl) throw new Error('Existing website crawl requires a valid URL.');

  const clientDb = getClientDb(clientRecord);
  const crawlLimit = Math.max(1, Math.min(Number(input.limit || DEFAULT_CRAWL_LIMIT), 8));

  const crawl = await crawlWebsite(startUrl, { limit: crawlLimit });
  const legacyExtracted = extractWebsiteIntelligence(crawl);
  const normalizedEvidence = normalizeCrawlEvidence(crawl, { source_url: startUrl });
  const extracted = {
    ...legacyExtracted,
    normalized_evidence: normalizedEvidence,
    business_profile: {
      ...legacyExtracted.business_profile,
      ...toBusinessProfilePatch(normalizedEvidence),
    },
  };
  const currentProfile = await fetchCurrentBusinessProfile(clientDb, clientRecord.id);
  const existingMemory = await fetchExistingMemory(clientDb, clientRecord.id);

  const mergePlan = buildProfileMergePlan({
    clientId: clientRecord.id,
    sourceUrl: startUrl,
    currentProfile,
    existingMemory,
    extracted,
  });

  await persistWebsiteIngestion({
    clientDb,
    clientId: clientRecord.id,
    sourceUrl: startUrl,
    crawl,
    extracted,
    mergePlan,
  });

  return {
    source_url: startUrl,
    pages_crawled: crawl.pages.length,
    extracted_profile: extracted.business_profile,
    applied_profile_patch: mergePlan.profile_patch,
    contradictions: mergePlan.contradictions,
    memory_events: mergePlan.memory_events,
  };
}

function getClientDb(clientRecord) {
  if (!clientRecord.supabase_url || !clientRecord.supabase_service_key_enc) {
    throw new Error('Client Supabase URL and service key are required for crawl persistence.');
  }
  return {
    url: clientRecord.supabase_url.replace(/\/$/, ''),
    key: clientRecord.supabase_service_key_enc,
  };
}

async function crawlWebsite(startUrl, options = {}) {
  const origin = new URL(startUrl).origin;
  const queue = [startUrl];
  const seen = new Set();
  const pages = [];

  while (queue.length && pages.length < options.limit) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const page = await fetchHtmlPage(url);
    if (!page.ok) continue;
    pages.push(page);

    const links = extractInternalLinks(page.html, origin);
    for (const link of prioritizeLinks(links)) {
      if (pages.length + queue.length >= options.limit + 8) break;
      if (!seen.has(link)) queue.push(link);
    }
  }

  return { start_url: startUrl, origin, pages };
}

async function fetchHtmlPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'FormautWebsiteCrawlAdapter/1.0 (+onboarding intelligence)',
        'accept': 'text/html,application/xhtml+xml',
      },
    });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('text/html')) {
      return { url, ok: false, status: res.status, html: '', text: '' };
    }
    const raw = await res.text();
    const html = raw.slice(0, MAX_HTML_BYTES);
    return { url: res.url || url, ok: true, status: res.status, html, text: htmlToText(html) };
  } catch (error) {
    return { url, ok: false, status: 0, html: '', text: '', error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function extractWebsiteIntelligence(crawl) {
  const combinedText = crawl.pages.map(p => p.text).join('\n\n').slice(0, 120_000);
  const combinedHtml = crawl.pages.map(p => p.html).join('\n\n');
  const home = crawl.pages[0] || { html: '', text: '', url: crawl.start_url };

  const headings = extractHeadings(combinedHtml);
  const meta = extractMeta(home.html);
  const contacts = extractContactInfo(combinedHtml, combinedText);
  const colors = extractColors(combinedHtml);
  const logos = extractLogoCandidates(home.html, crawl.origin);
  const services = extractServices(combinedHtml, combinedText, headings);
  const tone = inferTone({ text: combinedText, headings, meta, colors });
  const businessName = inferBusinessName({ meta, headings, url: crawl.start_url, logos });
  const industry = inferIndustry({ text: combinedText, headings, services });
  const imagery = extractImageCandidates(home.html, crawl.origin);

  const business_profile = cleanProfile({
    business_name: businessName,
    industry: industry.industry,
    industry_category: industry.industry_category,
    brand_tone: tone.brand_tone,
    visual_style: tone.visual_style,
    primary_colors: colors.slice(0, 5),
    secondary_colors: colors.slice(5, 10),
    logo_detected: logos.length > 0,
    logo_url: logos[0]?.url || null,
    services,
    phone: contacts.phone,
    email: contacts.email,
    hours: contacts.hours,
    existing_imagery: imagery.slice(0, 8),
    key_differentiators: inferDifferentiators(combinedText),
    site_goal: inferSiteGoal({ text: combinedText, contacts }),
    social_voice: tone.social_voice,
    feature_fit: inferFeatureFit(industry.industry_category, tone),
    feature_avoid: inferFeatureAvoid(industry.industry_category, tone),
    source_url: crawl.start_url,
    crawl_summary: {
      pages_crawled: crawl.pages.length,
      headings: headings.slice(0, 20),
      title: meta.title || null,
      description: meta.description || null,
    },
  });

  return {
    business_profile,
    headings,
    colors,
    logo_candidates: logos,
    contact: contacts,
    services,
    tone,
  };
}

function buildProfileMergePlan({ clientId, sourceUrl, currentProfile, existingMemory, extracted }) {
  const profilePatch = {};
  const contradictions = [];
  const memoryEvents = [];
  const profile = extracted.business_profile;

  for (const [key, newValue] of Object.entries(profile)) {
    if (!BUSINESS_PROFILE_KEYS.has(key) || isEmptyValue(newValue)) continue;
    const oldValue = currentProfile?.[key];
    const existingFact = existingMemory.find(m => m.category === 'business' && m.key === key);
    const existingConfidence = Number(existingFact?.confidence || 0);

    if (isEmptyValue(oldValue)) {
      profilePatch[key] = newValue;
      memoryEvents.push(memoryEvent(clientId, 'created', 'business', key, null, newValue, `Extracted from existing website ${sourceUrl}.`, 0.72));
      continue;
    }

    if (looselyEqual(oldValue, newValue)) {
      memoryEvents.push(memoryEvent(clientId, 'confirmed', 'business', key, oldValue, newValue, `Existing website confirms stored ${key}.`, 0.82));
      continue;
    }

    const shouldPatch = existingConfidence < 0.80 && key !== 'business_name';
    const contradiction = {
      category: 'business',
      key,
      old_value: oldValue,
      website_value: newValue,
      action: shouldPatch ? 'patched_low_confidence_value' : 'kept_existing_truth',
      reason: shouldPatch
        ? `Website value differed from a low-confidence or unscored profile field.`
        : `Website value differed from an existing truth; preserved stored value and logged contradiction.`,
    };
    contradictions.push(contradiction);

    if (shouldPatch) profilePatch[key] = newValue;

    memoryEvents.push(memoryEvent(
      clientId,
      'contradicted',
      'business',
      key,
      oldValue,
      newValue,
      contradiction.reason,
      0.70,
    ));
  }

  return {
    profile_patch: profilePatch,
    contradictions,
    memory_events: memoryEvents,
  };
}

async function persistWebsiteIngestion({ clientDb, clientId, sourceUrl, crawl, extracted, mergePlan }) {
  const headers = supabaseHeaders(clientDb.key);

  await supabasePost(clientDb, 'website_ingestions', {
    client_id: clientId,
    source_url: sourceUrl,
    pages_crawled: crawl.pages.map(p => ({ url: p.url, status: p.status })),
    extracted_json: extracted,
    applied_profile_patch: mergePlan.profile_patch,
    contradictions: mergePlan.contradictions,
  });

  if (extracted.normalized_evidence) {
    await supabasePost(clientDb, 'evidence_normalizations', {
      client_id: clientId,
      source_url: sourceUrl,
      source_type: 'website_crawl',
      normalized_json: extracted.normalized_evidence,
      confidence_json: extracted.normalized_evidence.confidence || {},
      proof_json: extracted.normalized_evidence.proof || {},
      signals_json: extracted.normalized_evidence.signals || [],
      applied_profile_patch: mergePlan.profile_patch,
    });
  }

  if (Object.keys(mergePlan.profile_patch).length) {
    await patchClientContext(clientDb, clientId, mergePlan.profile_patch);
  }

  const memoryRows = mergePlan.memory_events
    .filter(e => e.event_type !== 'contradicted')
    .map(e => ({
      client_id: clientId,
      category: e.category,
      key: e.key,
      value_json: e.new_value,
      confidence: e.confidence,
      updated_at: new Date().toISOString(),
    }));

  if (memoryRows.length) {
    await fetch(`${clientDb.url}/rest/v1/client_memory`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(memoryRows),
    });
  }

  if (mergePlan.memory_events.length) {
    await fetch(`${clientDb.url}/rest/v1/memory_events`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify(mergePlan.memory_events.map(({ confidence, ...row }) => row)),
    });
  }
}

async function fetchCurrentBusinessProfile(clientDb, clientId) {
  const res = await fetch(`${clientDb.url}/rest/v1/client_context?client_id=eq.${clientId}&select=business_profile&limit=1`, {
    headers: supabaseHeaders(clientDb.key),
  });
  if (!res.ok) return {};
  const rows = await res.json();
  return rows?.[0]?.business_profile || rows?.[0] || {};
}

async function fetchExistingMemory(clientDb, clientId) {
  const res = await fetch(`${clientDb.url}/rest/v1/client_memory?client_id=eq.${clientId}&select=category,key,value_json,confidence`, {
    headers: supabaseHeaders(clientDb.key),
  });
  if (!res.ok) return [];
  return await res.json();
}

async function patchClientContext(clientDb, clientId, patch) {
  const current = await fetchCurrentBusinessProfile(clientDb, clientId);
  const next = deepMerge(current || {}, patch);
  await fetch(`${clientDb.url}/rest/v1/client_context?client_id=eq.${clientId}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(clientDb.key), Prefer: 'return=minimal' },
    body: JSON.stringify({ business_profile: next, updated_at: new Date().toISOString() }),
  });
}

async function supabasePost(clientDb, table, row) {
  await fetch(`${clientDb.url}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...supabaseHeaders(clientDb.key), Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
}

function supabaseHeaders(key) {
  return { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

function extractHeadings(html) {
  const headings = [];
  const re = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = re.exec(html)) && headings.length < 80) {
    const text = cleanText(stripTags(match[2]));
    if (text && text.length > 2) headings.push({ level: Number(match[1]), text });
  }
  return headings;
}

function extractMeta(html) {
  const title = cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const description = getMetaContent(html, 'description') || getMetaProperty(html, 'og:description');
  const siteName = getMetaProperty(html, 'og:site_name');
  return { title, description, site_name: siteName };
}

function extractContactInfo(html, text) {
  const email = unique((html + ' ' + text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])[0] || null;
  const phoneMatch = text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  const hours = inferHours(text);
  return { email, phone: phoneMatch ? phoneMatch[0] : null, hours };
}

function extractColors(html) {
  const found = html.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const normalized = found.map(c => normalizeHex(c)).filter(Boolean);
  return unique(normalized).filter(c => !['#FFFFFF', '#000000', '#FFF', '#000'].includes(c)).slice(0, 12);
}

function extractLogoCandidates(html, origin) {
  const candidates = [];
  const imgRe = /<img\b[^>]*>/gi;
  let match;
  while ((match = imgRe.exec(html))) {
    const tag = match[0];
    const src = attr(tag, 'src');
    const alt = attr(tag, 'alt') || '';
    const cls = attr(tag, 'class') || '';
    const id = attr(tag, 'id') || '';
    const haystack = `${src} ${alt} ${cls} ${id}`.toLowerCase();
    if (src && /logo|brand|mark|header/.test(haystack)) {
      candidates.push({ url: absolutize(src, origin), alt, confidence: haystack.includes('logo') ? 0.82 : 0.65 });
    }
  }
  const icon = html.match(/<link\b[^>]*rel=["'][^"']*(icon|apple-touch-icon)[^"']*["'][^>]*>/i);
  if (icon) {
    const href = attr(icon[0], 'href');
    if (href) candidates.push({ url: absolutize(href, origin), alt: 'site icon', confidence: 0.55 });
  }
  return dedupeBy(candidates, c => c.url).slice(0, 8);
}

function extractImageCandidates(html, origin) {
  const images = [];
  const imgRe = /<img\b[^>]*>/gi;
  let match;
  while ((match = imgRe.exec(html)) && images.length < 20) {
    const src = attr(match[0], 'src');
    if (!src || /logo|icon|sprite|avatar/i.test(src)) continue;
    images.push({ url: absolutize(src, origin), alt: attr(match[0], 'alt') || '' });
  }
  return dedupeBy(images, i => i.url);
}

function extractServices(html, text, headings) {
  const serviceHeadings = headings
    .map(h => h.text)
    .filter(t => /service|what we do|offer|solutions|repair|installation|menu|treatment/i.test(t));

  const listItems = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = liRe.exec(html)) && listItems.length < 200) {
    const item = cleanText(stripTags(match[1]));
    if (item.length > 3 && item.length < 80) listItems.push(item);
  }

  const keywordServices = inferServicePhrases(text);
  return unique([...serviceHeadings, ...keywordServices, ...listItems.filter(looksLikeService)]).slice(0, 14);
}

function inferTone({ text, headings, meta, colors }) {
  const haystack = `${meta.title || ''} ${meta.description || ''} ${headings.map(h => h.text).join(' ')} ${text}`.toLowerCase();
  const tones = [];
  if (/luxury|premium|bespoke|elegant|exclusive/.test(haystack)) tones.push('premium');
  if (/family|friendly|local|community|welcome/.test(haystack)) tones.push('friendly');
  if (/trusted|licensed|insured|certified|professional/.test(haystack)) tones.push('trustworthy');
  if (/bold|creative|artist|music|studio|brand|story/.test(haystack)) tones.push('creative');
  if (/fast|same.day|emergency|available now|call now/.test(haystack)) tones.push('urgent');
  if (!tones.length) tones.push('professional');

  const darkCount = colors.filter(isDarkHex).length;
  const visual_style = darkCount >= 2 ? 'dark polished' : tones.includes('premium') ? 'clean premium' : tones.includes('creative') ? 'expressive modern' : 'clean professional';
  return { brand_tone: unique(tones).slice(0, 4), visual_style, social_voice: tones.includes('friendly') ? 'friendly expert' : 'clear expert' };
}

function inferBusinessName({ meta, headings, url, logos }) {
  const raw = meta.site_name || meta.title || headings.find(h => h.level === 1)?.text || logos[0]?.alt || new URL(url).hostname;
  return cleanText(raw.replace(/\s[|–-].*$/, '').replace(/^Home\s*-\s*/i, '')).slice(0, 80) || null;
}

function inferIndustry({ text, headings, services }) {
  const haystack = `${text} ${headings.map(h => h.text).join(' ')} ${services.join(' ')}`.toLowerCase();
  const rules = [
    ['roofing', 'service_trade', /roof|shingle|gutter|storm damage/],
    ['plumbing', 'service_trade', /plumb|drain|water heater|pipe/],
    ['hvac', 'service_trade', /hvac|furnace|air conditioning|heating|cooling/],
    ['restaurant', 'food_hospitality', /restaurant|menu|dining|catering|bar|grill|cafe/],
    ['salon_spa', 'wellness_personal', /salon|spa|massage|lashes|hair|wellness/],
    ['law', 'professional_service', /attorney|law firm|legal|lawyer/],
    ['creative_studio', 'creative_identity', /studio|music|artist|photography|creative|brand/],
    ['retail', 'retail_boutique', /shop|boutique|products|store|retail/],
    ['event_venue', 'event_venue', /wedding|venue|events|banquet/],
  ];
  const hit = rules.find(([, , re]) => re.test(haystack));
  return hit ? { industry: hit[0], industry_category: hit[1] } : { industry: null, industry_category: 'professional_service' };
}

function inferDifferentiators(text) {
  const phrases = [];
  const patterns = [/licensed and insured/gi, /family owned/gi, /locally owned/gi, /free estimates?/gi, /same[- ]day/gi, /\d+ years? (?:of )?experience/gi, /certified/gi];
  for (const pattern of patterns) phrases.push(...(text.match(pattern) || []));
  return unique(phrases.map(cleanText)).slice(0, 8);
}

function inferSiteGoal({ text, contacts }) {
  const lower = text.toLowerCase();
  if (/book now|schedule|appointment/.test(lower)) return 'book appointments';
  if (/order online|shop now|buy now/.test(lower)) return 'online orders or purchases';
  if (/free estimate|quote|call now|contact us/.test(lower) || contacts.phone) return 'contact and lead generation';
  return 'credibility and contact';
}

function inferFeatureFit(category, tone) {
  const base = ['sticky_nav', 'contact_cta', 'trust_signals'];
  if (category === 'creative_identity') return [...base, 'scroll_reveal', 'gallery_grid', 'atmospheric_hero'];
  if (category === 'food_hospitality') return [...base, 'menu_preview', 'photo_grid', 'hours_panel'];
  if (category === 'service_trade') return [...base, 'service_cards', 'testimonial_strip', 'estimate_cta'];
  if (category === 'wellness_personal') return [...base, 'booking_cta', 'soft_scroll_reveal'];
  return [...base, 'service_summary'];
}

function inferFeatureAvoid(category) {
  if (category === 'service_trade' || category === 'professional_service') return ['heavy_parallax', 'audio_player', 'overly_playful_motion'];
  return ['slow_loading_effects', 'unclear_ctas'];
}

function extractInternalLinks(html, origin) {
  const links = [];
  const re = /<a\b[^>]*href=["']([^"'#?]+)[^"']*["'][^>]*>/gi;
  let match;
  while ((match = re.exec(html))) {
    const url = absolutize(match[1], origin);
    if (url && url.startsWith(origin) && !/\.(pdf|jpg|png|webp|zip)$/i.test(url)) links.push(url.replace(/\/$/, ''));
  }
  return unique(links);
}

function prioritizeLinks(links) {
  const score = link => /contact|service|about|menu|hours|location/i.test(link) ? 0 : 1;
  return links.sort((a, b) => score(a) - score(b));
}

function inferServicePhrases(text) {
  const found = [];
  const re = /(?:we offer|services include|specializing in|we provide)\s+([^.!?]+)/gi;
  let match;
  while ((match = re.exec(text))) {
    found.push(...match[1].split(/,| and | & /).map(cleanText));
  }
  return found.filter(s => s.length > 3 && s.length < 80);
}

function inferHours(text) {
  const lines = text.split('\n').map(cleanText).filter(Boolean);
  const hit = lines.find(l => /(mon|tue|wed|thu|fri|sat|sun|hours?|open)/i.test(l) && /\d|closed|am|pm/i.test(l));
  return hit ? { raw: hit.slice(0, 180) } : null;
}

function looksLikeService(text) {
  return /service|repair|install|design|consult|inspection|estimate|booking|treatment|menu|catering|delivery/i.test(text);
}

function htmlToText(html) {
  return cleanText(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'));
}

function stripTags(value) { return String(value || '').replace(/<[^>]+>/g, ' '); }
function cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function unique(arr) { return [...new Set(arr.filter(Boolean))]; }
function dedupeBy(arr, keyFn) { const seen = new Set(); return arr.filter(x => { const k = keyFn(x); if (!k || seen.has(k)) return false; seen.add(k); return true; }); }
function attr(tag, name) { return (tag.match(new RegExp(`${name}=["']([^"']+)["']`, 'i')) || [])[1] || null; }
function getMetaContent(html, name) { return attr((html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]*>`, 'i')) || [])[0] || '', 'content'); }
function getMetaProperty(html, prop) { return attr((html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]*>`, 'i')) || [])[0] || '', 'content'); }
function absolutize(url, origin) { try { return new URL(url, origin).href; } catch { return null; } }
function normalizeUrl(url) { if (!url) return null; const s = String(url).trim(); try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).href; } catch { return null; } }
function normalizeHex(hex) { if (!hex) return null; const h = hex.toUpperCase(); return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h.slice(0, 7); }
function isDarkHex(hex) { const h = normalizeHex(hex); if (!h || h.length !== 7) return false; const n = parseInt(h.slice(1), 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255; return (0.299*r + 0.587*g + 0.114*b) < 95; }
function isEmptyValue(v) { return v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length); }
function looselyEqual(a, b) { return JSON.stringify(a || '').toLowerCase() === JSON.stringify(b || '').toLowerCase(); }
function deepMerge(a, b) { return { ...(a || {}), ...(b || {}) }; }
function cleanProfile(profile) { return Object.fromEntries(Object.entries(profile).filter(([, v]) => !isEmptyValue(v))); }
function memoryEvent(clientId, eventType, category, key, oldValue, newValue, reason, confidence) {
  return { client_id: clientId, event_type: eventType, category, key, old_value: oldValue, new_value: newValue, reason, confidence };
}

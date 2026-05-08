// =============================================================================
// FORMAUT — EVIDENCE NORMALIZER
// =============================================================================
// Purpose:
// - Convert raw crawl artifacts into structured, confidence-scored business signals.
// - Preserve proof for every derived signal so the dashboard/agent can show why.
// - Keep this layer deterministic and pre-LLM-friendly.
//
// Runtime: Cloudflare Workers / Pages Functions compatible.
// Dependencies: none.
// =============================================================================

const DEFAULT_CONFIDENCE = 0.62;

const INDUSTRY_RULES = [
  ['roofing', 'service_trade', /\broof(?:ing|er)?\b|shingle|gutter|storm damage|hail damage/i],
  ['plumbing', 'service_trade', /\bplumb(?:ing|er)?\b|drain cleaning|water heater|pipe repair/i],
  ['hvac', 'service_trade', /\bhvac\b|furnace|air conditioning|heating|cooling|ductwork/i],
  ['electrical', 'service_trade', /electrician|electrical|breaker panel|rewiring|lighting install/i],
  ['landscaping', 'service_trade', /landscap(?:e|ing)|lawn care|hardscape|snow removal|irrigation/i],
  ['restaurant', 'food_hospitality', /restaurant|menu|dining|catering|bar and grill|cafe|coffee shop|brewery/i],
  ['salon_spa', 'wellness_personal', /salon|spa|massage|lashes|hair stylist|barber|wellness|facial/i],
  ['fitness', 'wellness_personal', /gym|fitness|personal training|yoga|pilates|strength training/i],
  ['law', 'professional_service', /attorney|law firm|legal counsel|lawyer|litigation/i],
  ['accounting', 'professional_service', /accounting|bookkeeping|tax preparation|cpa|payroll/i],
  ['real_estate', 'professional_service', /real estate|realtor|brokerage|property management|homes for sale/i],
  ['creative_studio', 'creative_identity', /studio|music|artist|photography|videography|creative agency|branding|design studio/i],
  ['retail', 'retail_boutique', /shop|boutique|products|store|retail|ecommerce|merch/i],
  ['event_venue', 'event_venue', /wedding venue|event venue|banquet|private events|reception/i],
];

const SERVICE_VERBS = /repair|install|installation|replace|replacement|design|consult|inspection|estimate|booking|treatment|catering|delivery|maintenance|restoration|remodel|coaching|training|photography|videography|branding|marketing|cleaning|painting|landscaping|tax|bookkeeping|legal|massage|hair|lashes|roof|gutter|plumb|hvac/i;

export function normalizeCrawlEvidence(rawCrawl = {}, options = {}) {
  const pages = normalizePages(rawCrawl);
  const sourceUrl = rawCrawl.start_url || rawCrawl.source_url || pages[0]?.url || options.source_url || null;
  const origin = sourceUrl ? safeOrigin(sourceUrl) : rawCrawl.origin || null;

  const combinedHtml = pages.map(p => p.html || '').join('\n\n');
  const combinedText = pages.map(p => p.text || htmlToText(p.html || '')).join('\n\n').slice(0, 160_000);
  const home = pages[0] || { html: '', text: '', url: sourceUrl };

  const headings = extractHeadings(combinedHtml);
  const meta = extractMeta(home.html || '');
  const titleSignals = compact([meta.site_name, meta.title, headings.find(h => h.level === 1)?.text]);
  const serviceMentions = extractServiceMentions({ html: combinedHtml, text: combinedText, headings });
  const contacts = extractContactMethods({ html: combinedHtml, text: combinedText });
  const socialLinks = extractSocialLinks(combinedHtml, origin);
  const logoSources = extractLogoSources(home.html || combinedHtml, origin);
  const colors = extractColors(combinedHtml);
  const heroCopy = extractHeroCopy({ headings, meta, text: home.text || htmlToText(home.html || '') });

  const businessNameSignal = signal('business_name', inferBusinessName({ meta, headings, sourceUrl, logoSources }), {
    confidence: confidenceForBusinessName({ meta, headings, logoSources }),
    proof: compact([meta.site_name, meta.title, headings.find(h => h.level === 1)?.text, logoSources[0]?.alt]).slice(0, 4),
    source: home.url || sourceUrl,
  });

  const industry = inferIndustry({ text: combinedText, headings, serviceMentions });
  const tone = inferBrandTone({ text: combinedText, headings, meta });
  const visualStyle = inferVisualStyle({ colors, text: combinedText, headings, logoSources });
  const location = inferLocation({ text: combinedText, meta });

  const normalized = {
    business_name: valueOf(businessNameSignal),
    industry: industry.value,
    brand_tone: tone.value,
    visual_style: visualStyle.values,
    primary_services: serviceMentions.map(s => s.value).slice(0, 12),
    contact_methods: contacts.map(c => ({ type: c.type, value: c.value, confidence: c.confidence, proof: c.proof })),
    social_links: socialLinks.map(s => ({ platform: s.platform, url: s.url, confidence: s.confidence })),
    location: location.value,
    proof: {
      service_mentions: serviceMentions.slice(0, 20),
      hero_copy: heroCopy,
      logo_sources: logoSources,
    },
    confidence: {
      business_name: businessNameSignal.confidence,
      industry: industry.confidence,
      brand_tone: tone.confidence,
      visual_style: visualStyle.confidence,
      primary_services: average(serviceMentions.map(s => s.confidence), DEFAULT_CONFIDENCE),
      contact_methods: average(contacts.map(c => c.confidence), contacts.length ? 0.75 : 0),
      social_links: average(socialLinks.map(s => s.confidence), socialLinks.length ? 0.70 : 0),
      location: location.confidence,
      overall: 0,
    },
    signals: compact([
      businessNameSignal,
      industry,
      tone,
      visualStyle,
      location,
      ...serviceMentions.map(s => ({ ...s, key: 'primary_services' })),
      ...contacts.map(c => ({ ...c, key: 'contact_methods' })),
      ...socialLinks.map(s => ({ ...s, key: 'social_links', value: { platform: s.platform, url: s.url } })),
      ...logoSources.map(l => ({ key: 'logo_sources', value: l.url, confidence: l.confidence, proof: [l], source: l.url })),
    ]),
    raw_summary: {
      source_url: sourceUrl,
      pages_crawled: pages.length,
      titles: unique(titleSignals).slice(0, 6),
      headings: headings.slice(0, 30),
      colors: colors.slice(0, 12),
    },
  };

  normalized.confidence.overall = average([
    normalized.confidence.business_name,
    normalized.confidence.industry,
    normalized.confidence.brand_tone,
    normalized.confidence.visual_style,
    normalized.confidence.primary_services,
    normalized.confidence.contact_methods || null,
    normalized.confidence.location || null,
  ].filter(v => typeof v === 'number' && v > 0), DEFAULT_CONFIDENCE);

  return normalized;
}

export function toBusinessProfilePatch(normalized = {}) {
  return cleanObject({
    business_name: normalized.business_name || null,
    industry: normalized.industry || null,
    brand_tone: normalized.brand_tone || null,
    visual_style: normalized.visual_style || [],
    primary_services: normalized.primary_services || [],
    services: normalized.primary_services || [],
    contact_methods: normalized.contact_methods || [],
    social_links: normalized.social_links || [],
    location: normalized.location || null,
    evidence_normalized_at: new Date().toISOString(),
    evidence_confidence: normalized.confidence || {},
    evidence_proof: normalized.proof || {},
  });
}

export function toClientMemoryRows({ clientId, normalized, sourceSessionId = null }) {
  const rows = [];
  const add = (category, key, value, confidence) => {
    if (isEmpty(value)) return;
    rows.push({
      client_id: clientId,
      category,
      key,
      value_json: value,
      confidence: clampConfidence(confidence),
      source_session_id: sourceSessionId,
      updated_at: new Date().toISOString(),
    });
  };

  add('business', 'business_name', normalized.business_name, normalized.confidence?.business_name);
  add('business', 'industry', normalized.industry, normalized.confidence?.industry);
  add('brand', 'brand_tone', normalized.brand_tone, normalized.confidence?.brand_tone);
  add('design', 'visual_style', normalized.visual_style, normalized.confidence?.visual_style);
  add('business', 'primary_services', normalized.primary_services, normalized.confidence?.primary_services);
  add('business', 'contact_methods', normalized.contact_methods, normalized.confidence?.contact_methods);
  add('business', 'social_links', normalized.social_links, normalized.confidence?.social_links);
  add('business', 'location', normalized.location, normalized.confidence?.location);
  add('business', 'evidence_proof', normalized.proof, normalized.confidence?.overall);
  return rows;
}

function normalizePages(rawCrawl) {
  if (Array.isArray(rawCrawl.pages)) return rawCrawl.pages.map(normalizePage).filter(Boolean);
  if (rawCrawl.html || rawCrawl.text) return [normalizePage(rawCrawl)];
  return [];
}
function normalizePage(p) { return p ? { url: p.url || p.source_url || null, html: p.html || '', text: p.text || htmlToText(p.html || ''), status: p.status || 200 } : null; }

function extractHeadings(html) {
  const headings = [];
  const re = /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = re.exec(html)) && headings.length < 100) {
    const text = cleanText(stripTags(match[2]));
    if (text && text.length > 2 && text.length < 180) headings.push({ level: Number(match[1]), text });
  }
  return dedupeBy(headings, h => `${h.level}:${h.text.toLowerCase()}`);
}

function extractMeta(html) {
  const title = cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  return {
    title,
    description: getMeta(html, 'name', 'description') || getMeta(html, 'property', 'og:description') || '',
    site_name: getMeta(html, 'property', 'og:site_name') || '',
  };
}

function extractServiceMentions({ html, text, headings }) {
  const found = [];
  const add = (value, confidence, proof, source = null) => {
    const clean = cleanText(value).replace(/[•·|]+$/g, '').trim();
    if (!clean || clean.length < 3 || clean.length > 90) return;
    if (/privacy|terms|copyright|learn more|read more|click here|home|about|contact/i.test(clean)) return;
    found.push({ value: clean, confidence, proof: compact(proof), source });
  };

  for (const h of headings) {
    if (/services?|what we do|solutions|offer|specialties|treatments|menu/i.test(h.text)) add(h.text, 0.62, [`heading h${h.level}: ${h.text}`]);
  }

  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let li;
  while ((li = liRe.exec(html)) && found.length < 160) {
    const item = cleanText(stripTags(li[1]));
    if (SERVICE_VERBS.test(item)) add(item, 0.72, [`list item: ${item}`]);
  }

  const phraseRe = /(?:we offer|services include|specializing in|we provide|our services include|we help with)\s+([^.!?]+)/gi;
  let match;
  while ((match = phraseRe.exec(text))) {
    for (const part of match[1].split(/,| and | & |\/|\|/)) add(part, 0.78, [match[0].slice(0, 180)]);
  }

  for (const sentence of text.split(/[.!?\n]/).map(cleanText).filter(Boolean).slice(0, 2000)) {
    if (SERVICE_VERBS.test(sentence) && sentence.length <= 110) add(sentence, 0.58, [sentence]);
  }

  return dedupeBy(found, f => f.value.toLowerCase()).sort((a, b) => b.confidence - a.confidence).slice(0, 24);
}

function extractContactMethods({ html, text }) {
  const source = `${html}\n${text}`;
  const contacts = [];
  const emails = unique(source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []);
  for (const email of emails.slice(0, 4)) contacts.push({ type: 'email', value: email, confidence: 0.92, proof: [`email found: ${email}`] });

  const telLinks = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map(m => cleanText(decodeURIComponent(m[1])));
  const phones = unique([...telLinks, ...(text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g) || [])]);
  for (const phone of phones.slice(0, 4)) contacts.push({ type: 'phone', value: phone, confidence: telLinks.includes(phone) ? 0.94 : 0.86, proof: [`phone found: ${phone}`] });

  const hours = inferHours(text);
  if (hours) contacts.push({ type: 'hours', value: hours, confidence: 0.66, proof: [hours.raw] });

  return dedupeBy(contacts, c => `${c.type}:${String(c.value).toLowerCase()}`);
}

function extractSocialLinks(html, origin) {
  const out = [];
  const hrefs = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)].map(m => absolutize(m[1], origin)).filter(Boolean);
  const platforms = [
    ['facebook', /facebook\.com/i], ['instagram', /instagram\.com/i], ['linkedin', /linkedin\.com/i],
    ['youtube', /youtube\.com|youtu\.be/i], ['tiktok', /tiktok\.com/i], ['x', /twitter\.com|x\.com/i],
    ['soundcloud', /soundcloud\.com/i], ['spotify', /spotify\.com/i],
  ];
  for (const href of hrefs) {
    const hit = platforms.find(([, re]) => re.test(href));
    if (hit) out.push({ platform: hit[0], url: href, confidence: 0.84 });
  }
  return dedupeBy(out, s => s.url).slice(0, 12);
}

function extractLogoSources(html, origin) {
  const candidates = [];
  const add = (url, alt, confidence, reason) => { if (url) candidates.push({ url: absolutize(url, origin), alt: cleanText(alt || ''), confidence, reason }); };
  const imgRe = /<img\b[^>]*>/gi;
  let match;
  while ((match = imgRe.exec(html))) {
    const tag = match[0];
    const src = attr(tag, 'src') || attr(tag, 'data-src');
    const alt = attr(tag, 'alt') || '';
    const haystack = `${src || ''} ${alt} ${attr(tag, 'class') || ''} ${attr(tag, 'id') || ''}`.toLowerCase();
    if (/logo|brand|wordmark|site-title|custom-logo/.test(haystack)) add(src, alt, haystack.includes('logo') ? 0.86 : 0.68, 'image tag looks like logo');
  }
  const linkRe = /<link\b[^>]*rel=["'][^"']*(icon|apple-touch-icon)[^"']*["'][^>]*>/gi;
  while ((match = linkRe.exec(html))) add(attr(match[0], 'href'), 'site icon', 0.55, 'site icon fallback');
  return dedupeBy(candidates.filter(c => c.url), c => c.url).sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

function extractHeroCopy({ headings, meta, text }) {
  const lines = unique(compact([
    headings.find(h => h.level === 1)?.text,
    ...headings.filter(h => h.level <= 2).slice(0, 5).map(h => h.text),
    meta.description,
    ...text.split('\n').map(cleanText).filter(l => l.length > 12 && l.length < 140).slice(0, 8),
  ]));
  return lines.slice(0, 10).map(copy => ({ copy, confidence: /book|call|contact|schedule|quote|get started/i.test(copy) ? 0.72 : 0.64 }));
}

function extractColors(html) {
  const raw = html.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  return unique(raw.map(normalizeHex).filter(Boolean).filter(c => !['#FFFFFF', '#000000'].includes(c))).slice(0, 16);
}

function inferBusinessName({ meta, headings, sourceUrl, logoSources }) {
  const raw = meta.site_name || cleanTitle(meta.title) || headings.find(h => h.level === 1)?.text || logoSources[0]?.alt || domainName(sourceUrl);
  return cleanText(raw).slice(0, 90) || null;
}
function confidenceForBusinessName({ meta, headings, logoSources }) {
  if (meta.site_name) return 0.88;
  if (meta.title && headings.find(h => h.level === 1)) return 0.80;
  if (meta.title) return 0.72;
  if (logoSources[0]?.alt) return 0.68;
  return 0.52;
}
function inferIndustry({ text, headings, serviceMentions }) {
  const haystack = `${text}\n${headings.map(h => h.text).join('\n')}\n${serviceMentions.map(s => s.value).join('\n')}`;
  const hit = INDUSTRY_RULES.find(([, , re]) => re.test(haystack));
  return signal('industry', hit ? hit[0] : 'professional_service', { confidence: hit ? 0.78 : 0.50, proof: hit ? [String(hit[2])] : ['fallback: professional_service'] });
}
function inferBrandTone({ text, headings, meta }) {
  const haystack = `${meta.title} ${meta.description} ${headings.map(h => h.text).join(' ')} ${text}`.toLowerCase();
  const tones = [];
  if (/luxury|premium|bespoke|elegant|exclusive|high-end/.test(haystack)) tones.push('premium');
  if (/family|friendly|local|community|welcome|neighbor/.test(haystack)) tones.push('friendly');
  if (/trusted|licensed|insured|certified|professional|reliable/.test(haystack)) tones.push('trustworthy');
  if (/bold|creative|artist|music|studio|brand|story|original/.test(haystack)) tones.push('creative');
  if (/fast|same.day|emergency|available now|call now|24\/7/.test(haystack)) tones.push('urgent');
  if (/calm|relax|restore|healing|peaceful|wellness/.test(haystack)) tones.push('calm');
  return signal('brand_tone', unique(tones).slice(0, 4).join(', ') || 'professional', { confidence: tones.length ? 0.72 : 0.54, proof: tones });
}
function inferVisualStyle({ colors, text, headings, logoSources }) {
  const haystack = `${text} ${headings.map(h => h.text).join(' ')}`.toLowerCase();
  const styles = [];
  if (colors.some(isDarkHex)) styles.push('dark polished');
  if (/luxury|premium|elegant|bespoke/.test(haystack)) styles.push('clean premium');
  if (/creative|studio|artist|music|bold/.test(haystack)) styles.push('expressive modern');
  if (/family|local|community/.test(haystack)) styles.push('warm approachable');
  if (/medical|legal|certified|professional/.test(haystack)) styles.push('clean professional');
  if (logoSources.length) styles.push('logo-led identity');
  if (!styles.length) styles.push('clean professional');
  return { key: 'visual_style', values: unique(styles).slice(0, 5), value: unique(styles).slice(0, 5), confidence: styles.length > 1 ? 0.70 : 0.56, proof: compact([colors.length ? `colors: ${colors.slice(0, 6).join(', ')}` : null, ...styles]) };
}
function inferLocation({ text }) {
  const address = text.match(/\d{2,6}\s+[A-Za-z0-9 .'-]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Court|Ct)\b[^\n,]*(?:,\s*[A-Za-z .'-]+,?\s*[A-Z]{2}\s*\d{5})?/i);
  if (address) return signal('location', cleanText(address[0]), { confidence: 0.78, proof: [address[0]] });
  const cityState = text.match(/\b[A-Z][a-zA-Z .'-]+,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/);
  if (cityState) return signal('location', cleanText(cityState[0]), { confidence: 0.62, proof: [cityState[0]] });
  return signal('location', null, { confidence: 0, proof: [] });
}
function inferHours(text) {
  const hit = text.split('\n').map(cleanText).find(l => /(mon|tue|wed|thu|fri|sat|sun|hours?|open)/i.test(l) && /(\d|closed|am|pm)/i.test(l));
  return hit ? { raw: hit.slice(0, 180) } : null;
}

function signal(key, value, { confidence = DEFAULT_CONFIDENCE, proof = [], source = null } = {}) { return { key, value, confidence: clampConfidence(confidence), proof: compact(proof), source }; }
function valueOf(sig) { return isEmpty(sig?.value) ? '' : sig.value; }
function clampConfidence(n) { const x = Number.isFinite(Number(n)) ? Number(n) : DEFAULT_CONFIDENCE; return Math.max(0, Math.min(0.95, Math.round(x * 100) / 100)); }
function average(nums, fallback = 0) { const valid = nums.filter(n => Number.isFinite(Number(n))); return valid.length ? clampConfidence(valid.reduce((a, b) => a + Number(b), 0) / valid.length) : fallback; }
function compact(arr) { return (arr || []).filter(v => v != null && v !== '' && !(Array.isArray(v) && !v.length)); }
function unique(arr) { return [...new Set((arr || []).filter(Boolean))]; }
function dedupeBy(arr, keyFn) { const seen = new Set(); return (arr || []).filter(x => { const k = keyFn(x); if (!k || seen.has(k)) return false; seen.add(k); return true; }); }
function cleanObject(obj) { return Object.fromEntries(Object.entries(obj).filter(([, v]) => !isEmpty(v))); }
function isEmpty(v) { return v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length); }
function stripTags(value) { return String(value || '').replace(/<[^>]+>/g, ' '); }
function cleanText(value) { return String(value || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }
function attr(tag, name) { return (String(tag || '').match(new RegExp(`${name}=["']([^"']+)["']`, 'i')) || [])[1] || null; }
function getMeta(html, attrName, attrValue) { const tag = (html.match(new RegExp(`<meta[^>]+${attrName}=["']${escapeRegex(attrValue)}["'][^>]*>`, 'i')) || [])[0] || ''; return attr(tag, 'content') || ''; }
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function absolutize(url, origin) { try { return new URL(url, origin || undefined).href; } catch { return null; } }
function safeOrigin(url) { try { return new URL(url).origin; } catch { return null; } }
function domainName(url) { try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0].replace(/[-_]/g, ' '); } catch { return ''; } }
function cleanTitle(title) { return cleanText(String(title || '').replace(/^Home\s*[-|–]\s*/i, '').replace(/\s+[|–-]\s+.*$/, '')); }
function normalizeHex(hex) { const h = String(hex || '').toUpperCase(); return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h.slice(0, 7); }
function isDarkHex(hex) { const h = normalizeHex(hex); if (!h || h.length !== 7) return false; const n = parseInt(h.slice(1), 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255; return (0.299 * r + 0.587 * g + 0.114 * b) < 95; }
function htmlToText(html) { return cleanText(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, '\n').replace(/<[^>]+>/g, ' ')); }

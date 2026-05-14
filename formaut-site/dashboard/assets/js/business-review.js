// =============================================================================
// FORMAUT — CRAWL REVIEW
// dashboard/assets/js/business-review.js
// =============================================================================
// Loads crawl findings from the existing website crawl adapter, renders them
// field-by-field in review buckets, lets the operator approve/edit/skip each
// field, and promotes confirmed values to the durable business profile.
// =============================================================================

// ── Auth ─────────────────────────────────────────────────────────────────────
function getToken() {
  return sessionStorage.getItem('fm_google_token') || localStorage.getItem('fm_google_token') || '';
}
function getSlug() {
  return sessionStorage.getItem('fm_client_slug') || localStorage.getItem('fm_client_slug') || '';
}

// ── State ─────────────────────────────────────────────────────────────────────
const decisions = {};
let crawlData = null;

// ── API ───────────────────────────────────────────────────────────────────────
async function api(path, payload) {
  const token = getToken();
  const slug  = getSlug();
  if (!slug) throw new Error('No client selected. Return to the dashboard and sign in.');
  const res = await fetch(path, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body:    JSON.stringify({ slug, client_slug: slug, ...(payload || {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ── Status bar ────────────────────────────────────────────────────────────────
function setStatus(text, meta, state) {
  const bar = document.getElementById('status-bar');
  bar.style.display = 'flex';
  document.getElementById('status-dot').className = 'status-dot ' + (state || 'idle');
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-meta').textContent = meta || '';
}

// ── Field metadata ────────────────────────────────────────────────────────────
const FIELD_META = {
  business_name:       { label: 'Business name',       bucket: 'identity' },
  industry:            { label: 'Industry',             bucket: 'identity' },
  industry_category:   { label: 'Industry category',   bucket: 'identity' },
  site_goal:           { label: 'Site goal',            bucket: 'identity' },
  crawl_summary:       { label: 'Crawl summary',        bucket: 'identity' },
  phone:               { label: 'Phone',                bucket: 'contact'  },
  email:               { label: 'Email',                bucket: 'contact'  },
  location:            { label: 'Location',             bucket: 'contact'  },
  service_area:        { label: 'Service area',         bucket: 'contact'  },
  hours:               { label: 'Hours',                bucket: 'contact'  },
  contact_methods:     { label: 'Contact methods',      bucket: 'contact'  },
  social_links:        { label: 'Social links',         bucket: 'contact'  },
  services:            { label: 'Services',             bucket: 'services' },
  primary_services:    { label: 'Primary services',     bucket: 'services' },
  brand_tone:          { label: 'Brand tone',           bucket: 'brand'    },
  social_voice:        { label: 'Social voice',         bucket: 'brand'    },
  visual_style:        { label: 'Visual style',         bucket: 'brand'    },
  primary_colors:      { label: 'Primary colors',       bucket: 'brand'    },
  key_differentiators: { label: 'Key differentiators',  bucket: 'brand'    },
  logo_url:            { label: 'Logo URL',             bucket: 'brand'    },
};

const SKIP_FIELDS = new Set([
  'source_url','evidence_confidence','evidence_proof','evidence_normalized_at',
  'needs_review','review_items','logo_detected','existing_imagery',
]);

function bucketForField(key, confidence) {
  if (SKIP_FIELDS.has(key)) return null;
  const meta = FIELD_META[key];
  if (!meta) return (confidence >= 0.55) ? 'uncertain' : null;
  return (confidence < 0.55) ? 'uncertain' : meta.bucket;
}

function labelForField(key) {
  return (FIELD_META[key] && FIELD_META[key].label) || key.replace(/_/g, ' ');
}

function pathForField(key) {
  return key;
}

// ── Value display ─────────────────────────────────────────────────────────────
function formatValue(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string')  return v || '—';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '—';
    return v.map(function(x) { return typeof x === 'object' ? JSON.stringify(x) : String(x); }).join(', ');
  }
  if (typeof v === 'object') {
    var entries = Object.entries(v).filter(function(e) { return e[1]; });
    if (!entries.length) return '—';
    return entries.map(function(e) { return e[0] + ': ' + e[1]; }).join(' · ');
  }
  return String(v);
}

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return !v.trim();
  if (Array.isArray(v)) return !v.length;
  if (typeof v === 'object') return !Object.keys(v).length;
  return false;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function confBadge(c) {
  if (c >= 0.85) return { text: 'High confidence',   cls: 'conf-high' };
  if (c >= 0.65) return { text: 'Medium confidence', cls: 'conf-med'  };
  return               { text: 'Low confidence',     cls: 'conf-low'  };
}

// ── Field card HTML ───────────────────────────────────────────────────────────
function renderFieldCard(key, value, confidence, isContra, existingVal) {
  var label   = labelForField(key);
  var display = formatValue(value);
  var conf    = confBadge(confidence);
  var editVal = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value == null ? '' : value);
  var contra  = (isContra && existingVal != null)
    ? '<div class="contra-note">⚠ Existing: <em>' + esc(formatValue(existingVal)) + '</em></div>'
    : '';
  return [
    '<div class="field-card" id="field-' + esc(key) + '" data-key="' + esc(key) + '" data-state="pending">',
    '  <div class="field-top">',
    '    <div class="field-label">' + esc(label) + '</div>',
    '    <span class="conf-badge ' + conf.cls + '">' + conf.text + '</span>',
    '  </div>',
    '  <div class="field-value" id="display-' + esc(key) + '">' + esc(display) + '</div>',
    contra,
    '  <textarea class="field-edit" id="edit-' + esc(key) + '" style="display:none" rows="3">' + esc(editVal) + '</textarea>',
    '  <div class="field-actions" id="actions-' + esc(key) + '">',
    '    <button class="action-approve" onclick="approveField(\'' + esc(key) + '\')">✓ Approve</button>',
    '    <button class="action-edit"    onclick="startEdit(\''    + esc(key) + '\')">Edit</button>',
    '    <button class="action-skip"    onclick="skipField(\''    + esc(key) + '\')">Skip</button>',
    '  </div>',
    '  <div class="field-status" id="fstatus-' + esc(key) + '" style="display:none"></div>',
    '</div>',
  ].join('');
}

// ── Decision handlers ─────────────────────────────────────────────────────────
function approveField(key, customValue) {
  var raw = (customValue !== undefined) ? customValue : getRawValue(key);
  decisions[key] = { status: 'approved', value: raw, field_path: pathForField(key) };
  var card = document.getElementById('field-' + key);
  if (card) card.dataset.state = 'approved';
  showFieldStatus(key, '✓ Approved', 'approved');
  collapseEdit(key);
  updateCommitBar();
}

function skipField(key) {
  decisions[key] = { status: 'skipped' };
  var card = document.getElementById('field-' + key);
  if (card) card.dataset.state = 'skipped';
  showFieldStatus(key, '— Skipped', 'skipped');
  collapseEdit(key);
  updateCommitBar();
}

function startEdit(key) {
  var edit    = document.getElementById('edit-' + key);
  var display = document.getElementById('display-' + key);
  var actions = document.getElementById('actions-' + key);
  if (!edit) return;
  display.style.display = 'none';
  edit.style.display    = 'block';
  edit.focus();
  actions.innerHTML =
    '<button class="action-approve" onclick="saveEdit(\'' + esc(key) + '\')">✓ Save</button>' +
    '<button class="action-skip"    onclick="cancelEdit(\'' + esc(key) + '\')">Cancel</button>';
}

function saveEdit(key) {
  var edit = document.getElementById('edit-' + key);
  var text = (edit ? edit.value : '').trim();
  var parsed;
  try { parsed = JSON.parse(text); } catch(e) { parsed = text; }
  var display = document.getElementById('display-' + key);
  if (display) { display.textContent = formatValue(parsed); display.style.display = 'block'; }
  if (edit)    edit.style.display = 'none';
  restoreActions(key);
  approveField(key, parsed);
}

function cancelEdit(key) {
  var edit    = document.getElementById('edit-' + key);
  var display = document.getElementById('display-' + key);
  if (edit)    edit.style.display    = 'none';
  if (display) display.style.display = 'block';
  restoreActions(key);
}

function restoreActions(key) {
  var actions = document.getElementById('actions-' + key);
  if (!actions) return;
  actions.innerHTML =
    '<button class="action-approve" onclick="approveField(\'' + esc(key) + '\')">✓ Approve</button>' +
    '<button class="action-edit"    onclick="startEdit(\''    + esc(key) + '\')">Edit</button>'    +
    '<button class="action-skip"    onclick="skipField(\''    + esc(key) + '\')">Skip</button>';
}

function collapseEdit(key) {
  var edit    = document.getElementById('edit-' + key);
  var display = document.getElementById('display-' + key);
  if (edit)    edit.style.display    = 'none';
  if (display) display.style.display = 'block';
  restoreActions(key);
}

function getRawValue(key) {
  if (!crawlData) return null;
  return ((crawlData.extracted_profile || {})[key]) != null
    ? (crawlData.extracted_profile || {})[key]
    : null;
}

function showFieldStatus(key, text, cls) {
  var el = document.getElementById('fstatus-' + key);
  if (!el) return;
  el.textContent = text;
  el.className   = 'field-status ' + (cls || '');
  el.style.display = 'block';
}

// ── Approve-all ───────────────────────────────────────────────────────────────
function approveAll() {
  if (!crawlData) return;
  var profile = crawlData.extracted_profile || {};
  var normConf = (crawlData.evidence_normalization && crawlData.evidence_normalization.field_confidence) || {};
  Object.keys(profile).forEach(function(key) {
    if (SKIP_FIELDS.has(key)) return;
    if (isEmpty(profile[key])) return;
    var c = (normConf[key] != null) ? normConf[key] : 0.7;
    if (c >= 0.75 && !decisions[key]) approveField(key);
  });
}

// ── Commit bar ────────────────────────────────────────────────────────────────
function updateCommitBar() {
  var approved = Object.values(decisions).filter(function(d) { return d.status === 'approved'; }).length;
  var skipped  = Object.values(decisions).filter(function(d) { return d.status === 'skipped';  }).length;
  var summary  = document.getElementById('commit-summary');
  var btn      = document.getElementById('commit-btn');
  if (summary) summary.textContent = approved + ' field' + (approved !== 1 ? 's' : '') + ' approved · ' + skipped + ' skipped';
  if (btn)     btn.disabled = (approved === 0);
}

// ── Commit to profile ─────────────────────────────────────────────────────────
async function commitApproved() {
  var btn      = document.getElementById('commit-btn');
  var approved = Object.entries(decisions).filter(function(e) { return e[1].status === 'approved'; });
  if (!approved.length) return;

  btn.disabled    = true;
  btn.textContent = 'Saving…';

  var saved = 0;
  var errors = [];

  for (var i = 0; i < approved.length; i++) {
    var key      = approved[i][0];
    var decision = approved[i][1];
    try {
      await api('/api/business-profile/confirm-field', {
        field_path:      decision.field_path,
        confirmed_value: decision.value,
        reason:          'Approved during crawl review',
      });
      saved++;
      showFieldStatus(key, '✓ Saved to profile', 'saved');
    } catch (err) {
      errors.push(labelForField(key) + ': ' + err.message);
      showFieldStatus(key, '✗ Save failed', 'error');
    }
  }

  if (errors.length) {
    setStatus(saved + ' saved, ' + errors.length + ' failed', errors.join(' · '), 'error');
  } else {
    setStatus('✓ ' + saved + ' field' + (saved !== 1 ? 's' : '') + ' saved to your business profile.', 'Generation can now begin.', 'ok');
  }

  btn.textContent = saved > 0 ? saved + ' saved →' : 'Save to profile →';
  btn.disabled    = false;
}

// ── Render results ────────────────────────────────────────────────────────────
function renderCrawlResults(data) {
  crawlData = data;
  var profile   = data.extracted_profile    || {};
  var normConf  = (data.evidence_normalization && data.evidence_normalization.field_confidence) || {};
  var contradictions = data.contradictions || [];

  // Summary strip
  var pageCount  = data.pages_crawled || 0;
  var fieldCount = Object.keys(profile).filter(function(k) { return !SKIP_FIELDS.has(k) && !isEmpty(profile[k]); }).length;
  document.getElementById('summary-strip').innerHTML =
    '<div class="summary-item"><strong>' + pageCount + '</strong> pages crawled</div>' +
    '<div class="summary-item"><strong>' + fieldCount + '</strong> fields extracted</div>' +
    '<div class="summary-item"><strong>' + contradictions.length + '</strong> contradiction' + (contradictions.length !== 1 ? 's' : '') + '</div>' +
    '<div class="summary-item source"><a href="' + esc(data.source_url || '') + '" target="_blank" rel="noopener">' + esc(data.source_url || '') + '</a></div>';

  var contraMap = {};
  contradictions.forEach(function(c) { contraMap[c.field] = c.existing_value; });
  var contraKeys = new Set(contradictions.map(function(c) { return c.field; }));

  var buckets = { identity: [], contact: [], services: [], brand: [], uncertain: [], contradictions: [] };

  Object.keys(profile).forEach(function(key) {
    if (SKIP_FIELDS.has(key)) return;
    if (isEmpty(profile[key])) return;
    var c = (normConf[key] != null) ? normConf[key] : 0.7;
    if (contraKeys.has(key)) { buckets.contradictions.push({ key: key, value: profile[key], confidence: c }); return; }
    var bucket = bucketForField(key, c);
    if (bucket) buckets[bucket].push({ key: key, value: profile[key], confidence: c });
  });

  ['identity','contact','services','brand','uncertain','contradictions'].forEach(function(bid) {
    var list  = document.getElementById('fields-' + bid);
    var count = document.getElementById('count-' + bid);
    var items = buckets[bid];
    if (count) count.textContent = items.length;
    if (!list) return;
    if (!items.length) { list.innerHTML = '<div class="bucket-empty">None found</div>'; return; }
    list.innerHTML = items
      .sort(function(a, b) { return b.confidence - a.confidence; })
      .map(function(item) {
        return renderFieldCard(item.key, item.value, item.confidence,
          bid === 'contradictions', contraMap[item.key] != null ? contraMap[item.key] : null);
      })
      .join('');
  });

  var ws = document.getElementById('review-workspace');
  ws.style.display = 'block';
  ws.scrollIntoView({ behavior: 'smooth', block: 'start' });
  updateCommitBar();
}

// ── Run crawl ─────────────────────────────────────────────────────────────────
async function runCrawl() {
  var urlInput = document.getElementById('crawl-url-input');
  var btn      = document.getElementById('crawl-run-btn');
  var label    = document.getElementById('crawl-btn-label');
  var hint     = document.getElementById('crawl-hint');

  var url = (urlInput ? urlInput.value || '' : '').trim();
  if (!url) {
    if (urlInput) { urlInput.focus(); urlInput.classList.add('error'); setTimeout(function() { urlInput.classList.remove('error'); }, 1500); }
    return;
  }

  btn.disabled      = true;
  label.textContent = 'Crawling…';
  hint.textContent  = 'Fetching pages — this takes about 10–20 seconds…';
  setStatus('Crawling your website…', url, 'running');

  try {
    var data = await api('/api/crawl/run', {
      url: url,
      existing_website_url: url,
      persist_crawl: false,
      limit: 4,
    });
    var crawl = data.crawl || data;
    setStatus(
      '✓ Crawl complete — ' + (crawl.pages_crawled || 0) + ' pages scanned',
      'Found ' + Object.keys(crawl.extracted_profile || {}).length + ' data fields',
      'ok'
    );
    renderCrawlResults(crawl);
    var zone = document.getElementById('crawl-trigger-zone');
    if (zone) zone.classList.add('collapsed');
  } catch (err) {
    setStatus('Crawl failed', err.message, 'error');
    hint.textContent = err.message;
  } finally {
    btn.disabled      = false;
    label.textContent = 'Crawl again';
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function maybeLoadExistingProfile() {
  var slug = getSlug();
  if (!slug) { setStatus('No client selected', 'Return to the dashboard and sign in.', 'error'); return; }
  try {
    var data = await api('/api/business-profile/context');
    var profile = data.business_profile;
    if (!profile) return;
    var fieldCount = Object.keys(profile).filter(function(k) { return !SKIP_FIELDS.has(k) && !isEmpty(profile[k]); }).length;
    if (fieldCount > 0) {
      var hint = document.getElementById('crawl-hint');
      if (hint) hint.textContent = fieldCount + ' fields already in your profile. Run the crawl to review and update them.';
    }
  } catch(e) { /* silent */ }
}

// Globals
window.runCrawl       = runCrawl;
window.approveAll     = approveAll;
window.commitApproved = commitApproved;
window.approveField   = approveField;
window.skipField      = skipField;
window.startEdit      = startEdit;
window.saveEdit       = saveEdit;
window.cancelEdit     = cancelEdit;

maybeLoadExistingProfile();

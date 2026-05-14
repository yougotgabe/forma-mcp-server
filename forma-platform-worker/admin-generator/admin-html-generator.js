// =============================================================================
// FORMAUT — ADMIN HTML GENERATOR
// Converts the admin-generator manifest into a real, deployable admin.html.
//
// Usage:
//   import { generateAdminHtml } from './admin-generator/admin-html-generator.js';
//   const html = generateAdminHtml(manifest, clientRecord);
//   // Write to client GitHub repo at admin.html via github-publish-adapter
//
// Worker endpoint: POST /admin-generator/build
//   Body: { slug }
//   Fetches manifest + client record, renders HTML, commits to GitHub.
// =============================================================================

// ---------------------------------------------------------------------------
// 1. MAIN HTML GENERATOR
// ---------------------------------------------------------------------------

export function generateAdminHtml(manifest, client = {}) {
  const { modules = [], site_type = 'business' } = manifest;
  const clientName = client.business_name || client.name || 'your business';
  const adminEmail = (client.admin_emails || [])[0] || '';
  const supabaseUrl = client.site_supabase_url || '';
  const supabaseAnonKey = client.site_supabase_anon_key || '';

  const moduleHtml = modules.map(m => renderModule(m)).join('\n');
  const moduleInitJs = modules.map(m => initModuleJs(m)).join('\n');
  const moduleSaveJs = modules.map(m => saveModuleJs(m)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Admin — ${escapeHtml(clientName)}</title>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --brand: #E85D26;
      --brand-dark: #c44d1e;
      --surface: #ffffff;
      --surface-2: #f7f7f5;
      --border: #e5e5e2;
      --text: #1a1a18;
      --text-2: #6b6b65;
      --radius: 8px;
      --shadow: 0 1px 3px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.04);
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--surface-2);
      color: var(--text);
      min-height: 100vh;
    }

    /* ---- Auth gate ---- */
    #auth-gate {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      gap: 24px;
      padding: 24px;
    }

    #auth-gate .logo {
      width: 48px;
      height: 48px;
      background: var(--brand);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: 700;
      font-size: 22px;
    }

    #auth-gate h1 { font-size: 22px; font-weight: 600; }
    #auth-gate p { color: var(--text-2); font-size: 15px; max-width: 320px; text-align: center; }
    #auth-error { color: #c0392b; font-size: 14px; display: none; }

    /* ---- Layout ---- */
    #app { display: none; }

    .topbar {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 0 24px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .topbar-left { display: flex; align-items: center; gap: 12px; }
    .topbar-logo { width: 32px; height: 32px; background: var(--brand); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: white; font-weight: 700; font-size: 15px; flex-shrink: 0; }
    .topbar-title { font-weight: 600; font-size: 15px; }
    .topbar-right { display: flex; align-items: center; gap: 12px; }
    .topbar-email { font-size: 13px; color: var(--text-2); }

    .btn-sm {
      font-size: 13px;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      cursor: pointer;
      color: var(--text);
      transition: background .15s;
    }
    .btn-sm:hover { background: var(--surface-2); }
    .btn-primary {
      background: var(--brand);
      color: white;
      border-color: transparent;
    }
    .btn-primary:hover { background: var(--brand-dark); }

    .main { max-width: 860px; margin: 0 auto; padding: 32px 24px; display: flex; flex-direction: column; gap: 24px; }

    /* ---- Module card ---- */
    .module-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .module-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .module-title { font-weight: 600; font-size: 15px; }
    .module-status { font-size: 12px; color: var(--text-2); }
    .module-body { padding: 20px; display: flex; flex-direction: column; gap: 16px; }

    /* ---- Fields ---- */
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field label { font-size: 13px; font-weight: 500; color: var(--text-2); }
    .field input, .field textarea, .field select {
      padding: 9px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
      color: var(--text);
      background: var(--surface);
      transition: border-color .15s;
      width: 100%;
    }
    .field input:focus, .field textarea:focus, .field select:focus {
      outline: none;
      border-color: var(--brand);
    }
    .field textarea { min-height: 100px; resize: vertical; }

    /* ---- List editor (testimonials, services, team) ---- */
    .list-editor { display: flex; flex-direction: column; gap: 8px; }
    .list-item {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      padding: 10px;
      background: var(--surface-2);
      border-radius: 6px;
      border: 1px solid var(--border);
    }
    .list-item-body { flex: 1; display: flex; flex-direction: column; gap: 6px; }
    .list-item-body input { padding: 7px 10px; border: 1px solid var(--border); border-radius: 5px; font-size: 13px; width: 100%; }
    .btn-remove {
      border: none;
      background: none;
      cursor: pointer;
      color: var(--text-2);
      padding: 4px;
      font-size: 18px;
      line-height: 1;
      flex-shrink: 0;
    }
    .btn-remove:hover { color: #c0392b; }
    .btn-add-item {
      border: 1px dashed var(--border);
      background: none;
      border-radius: 6px;
      padding: 8px;
      font-size: 13px;
      color: var(--text-2);
      cursor: pointer;
      width: 100%;
      text-align: center;
    }
    .btn-add-item:hover { background: var(--surface-2); }

    /* ---- Toggle ---- */
    .toggle-row { display: flex; align-items: center; justify-content: space-between; }
    .toggle-label { font-size: 14px; }
    .toggle { position: relative; display: inline-block; width: 40px; height: 22px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle-slider {
      position: absolute; inset: 0;
      background: var(--border);
      border-radius: 22px;
      transition: background .2s;
      cursor: pointer;
    }
    .toggle-slider::before {
      content: '';
      position: absolute;
      height: 16px; width: 16px;
      left: 3px; top: 3px;
      background: white;
      border-radius: 50%;
      transition: transform .2s;
    }
    .toggle input:checked + .toggle-slider { background: var(--brand); }
    .toggle input:checked + .toggle-slider::before { transform: translateX(18px); }

    /* ---- Actions ---- */
    .module-actions {
      padding: 12px 20px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }

    .save-indicator { font-size: 13px; color: var(--text-2); flex: 1; }
    .save-indicator.saving { color: var(--brand); }
    .save-indicator.saved { color: #27ae60; }
    .save-indicator.error { color: #c0392b; }

    /* ---- Toast ---- */
    #toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--text);
      color: white;
      padding: 12px 18px;
      border-radius: 8px;
      font-size: 14px;
      opacity: 0;
      transform: translateY(8px);
      transition: opacity .2s, transform .2s;
      pointer-events: none;
      z-index: 100;
    }
    #toast.show { opacity: 1; transform: translateY(0); }

    /* ---- Attribution ---- */
    .attribution {
      text-align: center;
      font-size: 12px;
      color: var(--text-2);
      padding-bottom: 32px;
    }
    .attribution a { color: var(--brand); text-decoration: none; }

    @media (max-width: 600px) {
      .topbar { padding: 0 16px; }
      .main { padding: 16px; }
    }
  </style>
</head>
<body>

<!-- Auth gate -->
<div id="auth-gate">
  <div class="logo">F</div>
  <h1>Admin Panel</h1>
  <p>Sign in with your Google account to manage ${escapeHtml(clientName)}.</p>
  <div id="g_id_onload"
    data-client_id="${escapeHtml(process.env.GOOGLE_CLIENT_ID || '__GOOGLE_CLIENT_ID__')}"
    data-callback="handleGoogleSignIn"
    data-auto_prompt="false">
  </div>
  <div class="g_id_signin"
    data-type="standard"
    data-size="large"
    data-theme="outline"
    data-text="sign_in_with"
    data-shape="rectangular"
    data-logo_alignment="left">
  </div>
  <p id="auth-error">Access denied. This panel is restricted to authorized accounts.</p>
</div>

<!-- App shell -->
<div id="app">
  <div class="topbar">
    <div class="topbar-left">
      <div class="topbar-logo">F</div>
      <span class="topbar-title">${escapeHtml(clientName)} Admin</span>
    </div>
    <div class="topbar-right">
      <span class="topbar-email" id="user-email"></span>
      <button class="btn-sm" onclick="signOut()">Sign out</button>
    </div>
  </div>

  <div class="main">
    ${moduleHtml}
    <div class="attribution">Managed by <a href="https://formaut.com" target="_blank">Formaut</a></div>
  </div>
</div>

<div id="toast"></div>

<script>
// Config — injected at generation time
const SUPABASE_URL = '${escapeJs(supabaseUrl)}';
const SUPABASE_ANON_KEY = '${escapeJs(supabaseAnonKey)}';
const ADMIN_EMAILS = ${JSON.stringify((client.admin_emails || []).map(e => e.toLowerCase()))};
const GOOGLE_CLIENT_ID = '${escapeJs(process.env.GOOGLE_CLIENT_ID || '__GOOGLE_CLIENT_ID__')}';

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------
let _token = null;
let _userEmail = null;

async function handleGoogleSignIn(response) {
  _token = response.credential;
  // Decode JWT payload (no verification needed — we verify server-side for writes)
  const payload = JSON.parse(atob(_token.split('.')[1]));
  const email = payload.email?.toLowerCase() || '';

  if (!ADMIN_EMAILS.includes(email)) {
    document.getElementById('auth-error').style.display = 'block';
    _token = null;
    return;
  }

  _userEmail = email;
  document.getElementById('user-email').textContent = email;
  document.getElementById('auth-gate').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  await loadAllModules();
}

function signOut() {
  _token = null;
  _userEmail = null;
  document.getElementById('auth-gate').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

// ---------------------------------------------------------------------------
// SUPABASE HELPERS
// ---------------------------------------------------------------------------
async function sbGet(table, filters = '') {
  const res = await fetch(\`\${SUPABASE_URL}/rest/v1/\${table}\${filters ? '?' + filters : ''}\`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: \`Bearer \${SUPABASE_ANON_KEY}\`,
    },
  });
  if (!res.ok) throw new Error(\`sbGet \${table} \${res.status}\`);
  return res.json();
}

async function sbUpsert(table, data, matchOn = 'id') {
  const res = await fetch(\`\${SUPABASE_URL}/rest/v1/\${table}\`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: \`Bearer \${_token}\`,
      'Content-Type': 'application/json',
      'Prefer': \`resolution=merge-duplicates,return=minimal\`,
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(\`sbUpsert \${table} \${res.status}: \${text}\`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// MODULE DATA LOADING
// ---------------------------------------------------------------------------
async function loadAllModules() {
  ${moduleInitJs}
}

// ---------------------------------------------------------------------------
// MODULE SAVE HANDLERS
// ---------------------------------------------------------------------------
${moduleSaveJs}

// ---------------------------------------------------------------------------
// UI HELPERS
// ---------------------------------------------------------------------------
function toast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function setIndicator(moduleId, state, msg) {
  const el = document.querySelector(\`#module-\${moduleId} .save-indicator\`);
  if (!el) return;
  el.className = 'save-indicator ' + state;
  el.textContent = msg;
}

// List editor helpers
window._listAdd = function(moduleId, template) {
  const container = document.getElementById('list-' + moduleId);
  const div = document.createElement('div');
  div.className = 'list-item';
  div.innerHTML = template;
  container.appendChild(div);
};

window._listRemove = function(btn) {
  btn.closest('.list-item').remove();
};

window._listCollect = function(moduleId) {
  const container = document.getElementById('list-' + moduleId);
  const items = [];
  container.querySelectorAll('.list-item').forEach(row => {
    const obj = {};
    row.querySelectorAll('[data-field]').forEach(el => {
      obj[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value.trim();
    });
    items.push(obj);
  });
  return items;
};

// Toggle helpers
window._toggleInit = function(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = Boolean(value);
};
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 2. MODULE RENDERERS
// Each module type renders HTML and generates its own init + save JS blocks.
// ---------------------------------------------------------------------------

function renderModule(module) {
  const { id, title, editableFields = [], storageTarget } = module;
  const [table, column] = (storageTarget || '').split('.');

  // Choose renderer based on module id
  if (id === 'hero-editor') return renderHeroModule(module);
  if (id === 'services-editor') return renderServicesModule(module);
  if (id === 'seo-editor') return renderSeoModule(module);
  if (id === 'media-editor') return renderMediaModule(module);
  if (id === 'products-editor') return renderProductsModule(module);
  if (id === 'testimonials-editor') return renderTestimonialsModule(module);
  if (id === 'hours-editor') return renderHoursModule(module);
  if (id === 'team-editor') return renderTeamModule(module);
  if (id === 'announcements-editor') return renderAnnouncementsModule(module);

  // Generic fallback
  return renderGenericModule(module);
}

function renderHeroModule(m) {
  return `
<div class="module-card" id="module-hero-editor">
  <div class="module-header">
    <span class="module-title">Hero Section</span>
    <span class="module-status" id="hero-status">Loading…</span>
  </div>
  <div class="module-body">
    <div class="field"><label>Headline</label><input type="text" id="hero-headline" placeholder="Your main headline" /></div>
    <div class="field"><label>Subheadline</label><textarea id="hero-subheadline" placeholder="Supporting text below the headline"></textarea></div>
    <div class="field"><label>Button text</label><input type="text" id="hero-cta_text" placeholder="e.g. Get a free quote" /></div>
  </div>
  <div class="module-actions">
    <span class="save-indicator" id="hero-indicator"></span>
    <button class="btn-sm btn-primary" onclick="saveHeroEditor()">Save</button>
  </div>
</div>`;
}

function renderServicesModule(m) {
  return `
<div class="module-card" id="module-services-editor">
  <div class="module-header">
    <span class="module-title">Services</span>
    <span class="module-status">Edit your service listings</span>
  </div>
  <div class="module-body">
    <div class="list-editor" id="list-services-editor"></div>
    <button class="btn-add-item" onclick="addServiceItem()">+ Add service</button>
  </div>
  <div class="module-actions">
    <span class="save-indicator" id="services-indicator"></span>
    <button class="btn-sm btn-primary" onclick="saveServicesEditor()">Save</button>
  </div>
</div>`;
}

function renderSeoModule(m) {
  return `
<div class="module-card" id="module-seo-editor">
  <div class="module-header">
    <span class="module-title">SEO</span>
    <span class="module-status">How your site appears in search results</span>
  </div>
  <div class="module-body">
    <div class="field"><label>Page title (shown in browser tab and Google)</label><input type="text" id="seo-title" maxlength="60" /></div>
    <div class="field"><label>Meta description (shown in Google search results)</label><textarea id="seo-description" maxlength="160" style="min-height:70px"></textarea></div>
    <div class="field"><label>Local keywords (comma-separated)</label><input type="text" id="seo-local_keywords" placeholder="plumber Denver, emergency plumber CO" /></div>
  </div>
  <div class="module-actions">
    <span class="save-indicator" id="seo-indicator"></span>
    <button class="btn-sm btn-primary" onclick="saveSeoEditor()">Save</button>
  </div>
</div>`;
}

function renderMediaModule(m) {
  return `
<div class="module-card" id="module-media-editor">
  <div class="module-header">
    <span class="module-title">Gallery / Photos</span>
    <span class="module-status">Images displayed on your site</span>
  </div>
  <div class="module-body">
    <p style="font-size:13px;color:var(--text-2)">To add or remove photos, send a message in your Formaut dashboard. Image uploads require Formaut to resize and optimize the files.</p>
    <div class="list-editor" id="list-media-editor"></div>
  </div>
</div>`;
}

function renderProductsModule(m) {
  return `
<div class="module-card" id="module-products-editor">
  <div class="module-header">
    <span class="module-title">Products</span>
    <span class="module-status">Manage product visibility and sold-out status</span>
  </div>
  <div class="module-body">
    <div class="list-editor" id="list-products-editor"></div>
  </div>
  <div class="module-actions">
    <span class="save-indicator" id="products-indicator"></span>
    <button class="btn-sm btn-primary" onclick="saveProductsEditor()">Save</button>
  </div>
</div>`;
}

function renderTestimonialsModule(m) {
  return `
<div class="module-card" id="module-testimonials-editor">
  <div class="module-header">
    <span class="module-title">Testimonials</span>
    <span class="module-status">Customer reviews shown on your site</span>
  </div>
  <div class="module-body">
    <div class="list-editor" id="list-testimonials-editor"></div>
    <button class="btn-add-item" onclick="addTestimonialItem()">+ Add testimonial</button>
  </div>
  <div class="module-actions">
    <span class="save-indicator" id="testimonials-indicator"></span>
    <button class="btn-sm btn-primary" onclick="saveTestimonialsEditor()">Save</button>
  </div>
</div>`;
}

function renderHoursModule(m) {
  const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const rows = days.map(d => `
    <div class="toggle-row" style="padding:6px 0;border-bottom:1px solid var(--border)">
      <span class="toggle-label">${d}</span>
      <div style="display:flex;align-items:center;gap:8px">
        <input type="time" id="hours-${d.toLowerCase()}-open" style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px">
        <span style="font-size:13px;color:var(--text-2)">–</span>
        <input type="time" id="hours-${d.toLowerCase()}-close" style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px">
        <label class="toggle"><input type="checkbox" id="hours-${d.toLowerCase()}-closed" onchange="toggleDayClosed('${d.toLowerCase()}')"><span class="toggle-slider"></span></label>
        <span style="font-size:12px;color:var(--text-2)">Closed</span>
      </div>
    </div>`).join('');

  return `
<div class="module-card" id="module-hours-editor">
  <div class="module-header">
    <span class="module-title">Business Hours</span>
    <span class="module-status">Shown on your site and local listings</span>
  </div>
  <div class="module-body">
    ${rows}
  </div>
  <div class="module-actions">
    <span class="save-indicator" id="hours-indicator"></span>
    <button class="btn-sm btn-primary" onclick="saveHoursEditor()">Save</button>
  </div>
</div>`;
}

function renderTeamModule(m) {
  return `
<div class="module-card" id="module-team-editor">
  <div class="module-header">
    <span class="module-title">Team</span>
    <span class="module-status">People shown on your site</span>
  </div>
  <div class="module-body">
    <div class="list-editor" id="list-team-editor"></div>
    <button class="btn-add-item" onclick="addTeamItem()">+ Add team member</button>
  </div>
  <div class="module-actions">
    <span class="save-indicator" id="team-indicator"></span>
    <button class="btn-sm btn-primary" onclick="saveTeamEditor()">Save</button>
  </div>
</div>`;
}

function renderAnnouncementsModule(m) {
  return `
<div class="module-card" id="module-announcements-editor">
  <div class="module-header">
    <span class="module-title">Announcement Banner</span>
    <span class="module-status">Shown at the top of your site</span>
  </div>
  <div class="module-body">
    <div class="toggle-row">
      <span class="toggle-label">Show announcement banner</span>
      <label class="toggle"><input type="checkbox" id="announcement-enabled"><span class="toggle-slider"></span></label>
    </div>
    <div class="field"><label>Announcement text</label><input type="text" id="announcement-text" placeholder="e.g. Now open on Sundays!" /></div>
  </div>
  <div class="module-actions">
    <span class="save-indicator" id="announcements-indicator"></span>
    <button class="btn-sm btn-primary" onclick="saveAnnouncementsEditor()">Save</button>
  </div>
</div>`;
}

function renderGenericModule(m) {
  const fields = (m.editableFields || []).map(f =>
    `<div class="field"><label>${escapeHtml(f.replace(/_/g,' '))}</label><input type="text" id="generic-${escapeHtml(m.id)}-${escapeHtml(f)}" /></div>`
  ).join('\n');

  return `
<div class="module-card" id="module-${escapeHtml(m.id)}">
  <div class="module-header">
    <span class="module-title">${escapeHtml(m.title)}</span>
  </div>
  <div class="module-body">
    ${fields}
  </div>
  <div class="module-actions">
    <span class="save-indicator" id="${escapeHtml(m.id)}-indicator"></span>
    <button class="btn-sm btn-primary" onclick="saveGeneric('${escapeHtml(m.id)}', ${JSON.stringify(m.editableFields)}, '${escapeJs(m.storageTarget || '')}')">Save</button>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// 3. INIT JS BLOCKS
// Called inside loadAllModules() — fetches current data from Supabase
// ---------------------------------------------------------------------------

function initModuleJs(m) {
  if (m.id === 'hero-editor') return `
  try {
    const rows = await sbGet('site_content', 'key=eq.hero&select=value');
    const data = rows?.[0]?.value || {};
    document.getElementById('hero-headline').value = data.headline || '';
    document.getElementById('hero-subheadline').value = data.subheadline || '';
    document.getElementById('hero-cta_text').value = data.cta_text || '';
    document.getElementById('hero-status').textContent = '';
  } catch(e) { document.getElementById('hero-status').textContent = 'Load failed'; }`;

  if (m.id === 'services-editor') return `
  try {
    const rows = await sbGet('site_content', 'key=eq.services&select=value');
    const services = rows?.[0]?.value || [];
    const container = document.getElementById('list-services-editor');
    container.innerHTML = '';
    services.forEach(s => {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = \`
        <div class="list-item-body">
          <input data-field="name" placeholder="Service name" value="\${escHtml(s.name||'')}">
          <input data-field="description" placeholder="Short description" value="\${escHtml(s.description||'')}">
          <input data-field="price" placeholder="Price (optional)" value="\${escHtml(s.price||'')}">
        </div>
        <button class="btn-remove" onclick="_listRemove(this)">×</button>\`;
      container.appendChild(div);
    });
  } catch(e) {}`;

  if (m.id === 'seo-editor') return `
  try {
    const rows = await sbGet('site_content', 'key=eq.seo&select=value');
    const data = rows?.[0]?.value || {};
    document.getElementById('seo-title').value = data.title || '';
    document.getElementById('seo-description').value = data.description || '';
    document.getElementById('seo-local_keywords').value = (data.local_keywords || []).join(', ');
  } catch(e) {}`;

  if (m.id === 'hours-editor') return `
  try {
    const rows = await sbGet('site_content', 'key=eq.hours&select=value');
    const data = rows?.[0]?.value || {};
    ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].forEach(day => {
      const d = data[day] || {};
      const o = document.getElementById('hours-'+day+'-open');
      const c = document.getElementById('hours-'+day+'-close');
      const cl = document.getElementById('hours-'+day+'-closed');
      if(o) o.value = d.open || '09:00';
      if(c) c.value = d.close || '17:00';
      if(cl) { cl.checked = Boolean(d.closed); toggleDayClosed(day); }
    });
  } catch(e) {}`;

  if (m.id === 'testimonials-editor') return `
  try {
    const rows = await sbGet('site_content', 'key=eq.testimonials&select=value');
    const items = rows?.[0]?.value || [];
    const container = document.getElementById('list-testimonials-editor');
    container.innerHTML = '';
    items.forEach(t => {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.innerHTML = \`
        <div class="list-item-body">
          <input data-field="author" placeholder="Customer name" value="\${escHtml(t.author||'')}">
          <input data-field="quote" placeholder="What they said" value="\${escHtml(t.quote||'')}">
        </div>
        <button class="btn-remove" onclick="_listRemove(this)">×</button>\`;
      container.appendChild(div);
    });
  } catch(e) {}`;

  if (m.id === 'announcements-editor') return `
  try {
    const rows = await sbGet('site_content', 'key=eq.announcement&select=value');
    const data = rows?.[0]?.value || {};
    document.getElementById('announcement-enabled').checked = Boolean(data.enabled);
    document.getElementById('announcement-text').value = data.text || '';
  } catch(e) {}`;

  return `// ${m.id} — no init handler defined`;
}

// ---------------------------------------------------------------------------
// 4. SAVE JS BLOCKS
// ---------------------------------------------------------------------------

function saveModuleJs(m) {
  if (m.id === 'hero-editor') return `
async function saveHeroEditor() {
  setIndicator('hero-editor', 'saving', 'Saving…');
  try {
    await sbUpsert('site_content', {
      key: 'hero',
      value: {
        headline: document.getElementById('hero-headline').value.trim(),
        subheadline: document.getElementById('hero-subheadline').value.trim(),
        cta_text: document.getElementById('hero-cta_text').value.trim(),
      }
    });
    setIndicator('hero-editor', 'saved', 'Saved ✓');
    toast('Hero section saved');
  } catch(e) {
    setIndicator('hero-editor', 'error', 'Save failed');
  }
}`;

  if (m.id === 'services-editor') return `
async function saveServicesEditor() {
  setIndicator('services-editor', 'saving', 'Saving…');
  try {
    const services = _listCollect('services-editor');
    await sbUpsert('site_content', { key: 'services', value: services });
    setIndicator('services-editor', 'saved', 'Saved ✓');
    toast('Services saved');
  } catch(e) {
    setIndicator('services-editor', 'error', 'Save failed');
  }
}

function addServiceItem() {
  _listAdd('services-editor', \`
    <div class="list-item-body">
      <input data-field="name" placeholder="Service name">
      <input data-field="description" placeholder="Short description">
      <input data-field="price" placeholder="Price (optional)">
    </div>
    <button class="btn-remove" onclick="_listRemove(this)">×</button>\`);
}`;

  if (m.id === 'seo-editor') return `
async function saveSeoEditor() {
  setIndicator('seo-editor', 'saving', 'Saving…');
  try {
    const kw = document.getElementById('seo-local_keywords').value;
    await sbUpsert('site_content', {
      key: 'seo',
      value: {
        title: document.getElementById('seo-title').value.trim(),
        description: document.getElementById('seo-description').value.trim(),
        local_keywords: kw.split(',').map(s => s.trim()).filter(Boolean),
      }
    });
    setIndicator('seo-editor', 'saved', 'Saved ✓');
    toast('SEO settings saved');
  } catch(e) {
    setIndicator('seo-editor', 'error', 'Save failed');
  }
}`;

  if (m.id === 'hours-editor') return `
async function saveHoursEditor() {
  setIndicator('hours-editor', 'saving', 'Saving…');
  try {
    const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    const value = {};
    days.forEach(day => {
      value[day] = {
        open: document.getElementById('hours-'+day+'-open')?.value || '09:00',
        close: document.getElementById('hours-'+day+'-close')?.value || '17:00',
        closed: document.getElementById('hours-'+day+'-closed')?.checked || false,
      };
    });
    await sbUpsert('site_content', { key: 'hours', value });
    setIndicator('hours-editor', 'saved', 'Saved ✓');
    toast('Hours saved');
  } catch(e) {
    setIndicator('hours-editor', 'error', 'Save failed');
  }
}

function toggleDayClosed(day) {
  const closed = document.getElementById('hours-'+day+'-closed')?.checked;
  const o = document.getElementById('hours-'+day+'-open');
  const c = document.getElementById('hours-'+day+'-close');
  if(o) o.disabled = closed;
  if(c) c.disabled = closed;
}`;

  if (m.id === 'testimonials-editor') return `
async function saveTestimonialsEditor() {
  setIndicator('testimonials-editor', 'saving', 'Saving…');
  try {
    const items = _listCollect('testimonials-editor');
    await sbUpsert('site_content', { key: 'testimonials', value: items });
    setIndicator('testimonials-editor', 'saved', 'Saved ✓');
    toast('Testimonials saved');
  } catch(e) {
    setIndicator('testimonials-editor', 'error', 'Save failed');
  }
}

function addTestimonialItem() {
  _listAdd('testimonials-editor', \`
    <div class="list-item-body">
      <input data-field="author" placeholder="Customer name">
      <input data-field="quote" placeholder="What they said">
    </div>
    <button class="btn-remove" onclick="_listRemove(this)">×</button>\`);
}`;

  if (m.id === 'announcements-editor') return `
async function saveAnnouncementsEditor() {
  setIndicator('announcements-editor', 'saving', 'Saving…');
  try {
    await sbUpsert('site_content', {
      key: 'announcement',
      value: {
        enabled: document.getElementById('announcement-enabled').checked,
        text: document.getElementById('announcement-text').value.trim(),
      }
    });
    setIndicator('announcements-editor', 'saved', 'Saved ✓');
    toast('Announcement saved');
  } catch(e) {
    setIndicator('announcements-editor', 'error', 'Save failed');
  }
}`;

  return `// ${m.id} — no save handler defined`;
}

// ---------------------------------------------------------------------------
// 5. WORKER ENDPOINT HANDLER
// Register as: if (path === '/admin-generator/build') return handleAdminGeneratorBuild(body, env);
//
// This endpoint:
//   1. Fetches the client's manifest (via /admin-generator/manifest)
//   2. Renders admin.html
//   3. Commits it to the client's GitHub repo
// ---------------------------------------------------------------------------

export async function handleAdminGeneratorBuild(body, env) {
  const { slug } = body;
  if (!slug) return jsonError('slug required', 400);

  try {
    // 1. Fetch client record
    const clientRes = await supabaseGet(env,
      `/rest/v1/clients?slug=eq.${slug}&select=*&limit=1`
    );
    const client = clientRes?.[0];
    if (!client) return jsonError('client not found', 404);

    // 2. Fetch business profile for manifest input
    const profileRes = await supabaseGet(env,
      `/rest/v1/business_profile?client_slug=eq.${slug}&limit=1`
    );
    const profile = profileRes?.[0] || {};

    // 3. Fetch site Supabase credentials
    const infraRes = await supabaseGet(env,
      `/rest/v1/client_infrastructure_projects?client_slug=eq.${slug}&project_type=eq.site_data&limit=1`
    );
    const infra = infraRes?.[0] || {};

    // 4. Build manifest
    const { buildAdminPanelManifest } = await import('./admin-generator.js');
    const manifest = buildAdminPanelManifest({
      site_type: profile.site_type || 'business',
      has_services: Boolean(profile.primary_services?.length),
      has_products: Boolean(profile.commerce_enabled),
      has_media: true,
      has_testimonials: Boolean(profile.testimonials_enabled),
      has_hours: Boolean(profile.has_hours),
      has_team: Boolean(profile.team_enabled),
      has_announcement: true,
      seo_enabled: true,
    });

    // 5. Render HTML
    const clientData = {
      ...client,
      business_name: profile.business_name || client.name,
      admin_emails: client.admin_emails || [],
      site_supabase_url: infra.supabase_url || '',
      site_supabase_anon_key: infra.supabase_anon_key || '',
    };

    const html = generateAdminHtml(manifest, clientData);

    // 6. Commit to GitHub
    const { commitFileToGitHub } = await import('../github-publish-adapter.js');
    await commitFileToGitHub({
      slug,
      env,
      path: 'admin.html',
      content: html,
      message: 'Formaut: generate admin panel',
      encoding: 'utf-8',
    });

    // 7. Log the event
    await supabasePost(env, '/rest/v1/activity_log', {
      client_slug: slug,
      event_type: 'admin_panel_generated',
      summary: 'Admin panel generated and committed to GitHub',
      created_at: new Date().toISOString(),
    });

    return json({ ok: true, slug, path: 'admin.html', modules: manifest.modules.length });
  } catch (err) {
    console.error('admin-generator-build error', err);
    return jsonError(err.message, 500);
  }
}

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escapeJs(str) {
  return String(str || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n');
}

// Platform Supabase helpers (uses platform credentials, not client credentials)
async function supabaseGet(env, path) {
  const res = await fetch(`${env.PLATFORM_SUPABASE_URL}${path}`, {
    headers: { apikey: env.PLATFORM_SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' },
  });
  if (!res.ok) return null;
  return res.json();
}

async function supabasePost(env, path, data) {
  await fetch(`${env.PLATFORM_SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: { apikey: env.PLATFORM_SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(data),
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function jsonError(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

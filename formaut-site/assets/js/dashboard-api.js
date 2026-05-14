// formaut-site/assets/js/dashboard-api.js
// Client API token management panel.
// Load after dashboard-state.js. Init with initApiPanel().
//
// Add to dashboard.html:
//   <script src="/assets/js/dashboard-api.js"></script>
//
// Add panel link in nav:
//   <button class="nav-btn" data-panel="api" onclick="switchPanel('api')">API</button>
//
// Add panel div in dashboard body (see dashboardApiPanelHtml in client-api-token-system.js
// for the full HTML block to paste into dashboard.html).

// ---------------------------------------------------------------------------
// AVAILABLE SCOPES — mirrored from client-api-token-system.js for the UI
// ---------------------------------------------------------------------------
const API_SCOPES = {
  'content:read':      'Read site content',
  'content:write':     'Update site content',
  'services:read':     'Read services',
  'services:write':    'Update services',
  'testimonials:read': 'Read testimonials',
  'testimonials:write':'Manage testimonials',
  'hours:read':        'Read hours',
  'hours:write':       'Update hours',
  'announcements:read':'Read announcement',
  'announcements:write':'Update announcement',
  'seo:read':          'Read SEO settings',
  'seo:write':         'Update SEO settings',
  'jobs:read':         'View jobs',
};

let _revealedToken = null;

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------
async function initApiPanel() {
  renderScopeCheckboxes();
  await loadApiTokens();
}

// ---------------------------------------------------------------------------
// LOAD TOKEN LIST
// ---------------------------------------------------------------------------
async function loadApiTokens() {
  const container = document.getElementById('api-tokens-list');
  if (!container) return;

  container.innerHTML = '<div style="color:var(--text-2,#6b6b65);font-size:14px">Loading…</div>';

  try {
    const res = await apiPost('/api/client-api/tokens/list', {});
    const { tokens = [] } = res;

    if (tokens.length === 0) {
      container.innerHTML = '<div style="color:var(--text-2,#6b6b65);font-size:14px">No API tokens yet. Create one to get started.</div>';
      return;
    }

    container.innerHTML = tokens.map(t => `
      <div class="token-row" style="background:var(--surface,#fff);border:1px solid var(--border,#e5e5e2);border-radius:8px;padding:14px 16px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div>
            <div style="font-weight:600;font-size:14px">${escHtml(t.label)}</div>
            <div style="font-size:12px;color:var(--text-2,#6b6b65);margin-top:2px;font-family:monospace">${escHtml(t.token_prefix)}…</div>
            <div style="font-size:12px;color:var(--text-2,#6b6b65);margin-top:4px">
              ${t.scopes.map(s => `<span style="display:inline-block;background:var(--surface-2,#f7f7f5);border:1px solid var(--border,#e5e5e2);border-radius:4px;padding:1px 6px;font-size:11px;margin:1px">${escHtml(s)}</span>`).join('')}
            </div>
            <div style="font-size:12px;color:var(--text-2,#6b6b65);margin-top:6px">
              Created ${formatDate(t.created_at)}
              ${t.last_used_at ? ` · Last used ${formatDate(t.last_used_at)}` : ' · Never used'}
              ${t.expires_at ? ` · Expires ${formatDate(t.expires_at)}` : ' · No expiry'}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
            <button onclick="rotateToken('${t.id}')" style="font-size:12px;padding:5px 10px;border:1px solid var(--border,#e5e5e2);border-radius:5px;background:var(--surface,#fff);cursor:pointer">Rotate</button>
            <button onclick="revokeToken('${t.id}', '${escHtml(t.label)}')" style="font-size:12px;padding:5px 10px;border:1px solid #fecaca;border-radius:5px;background:#fff5f5;color:#7f1d1d;cursor:pointer">Revoke</button>
          </div>
        </div>
      </div>`).join('');
  } catch (err) {
    container.innerHTML = '<div style="color:#c0392b;font-size:14px">Failed to load tokens.</div>';
  }
}

// ---------------------------------------------------------------------------
// CREATE TOKEN
// ---------------------------------------------------------------------------
function showCreateTokenModal() {
  document.getElementById('create-token-modal').style.display = 'flex';
  document.getElementById('new-token-label').value = '';
  document.querySelectorAll('#scope-checkboxes input[type=checkbox]').forEach(cb => cb.checked = false);
}

function closeCreateTokenModal() {
  document.getElementById('create-token-modal').style.display = 'none';
}

function renderScopeCheckboxes() {
  const container = document.getElementById('scope-checkboxes');
  if (!container) return;
  container.innerHTML = Object.entries(API_SCOPES).map(([scope, label]) => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:3px 0">
      <input type="checkbox" value="${scope}" style="width:14px;height:14px">
      <span><strong>${scope}</strong> — ${label}</span>
    </label>`).join('');
}

async function createApiToken() {
  const label = document.getElementById('new-token-label').value.trim();
  if (!label) {
    alert('Give this token a label so you remember what it\'s for.');
    return;
  }

  const scopes = [...document.querySelectorAll('#scope-checkboxes input:checked')].map(cb => cb.value);
  if (scopes.length === 0) {
    alert('Select at least one scope.');
    return;
  }

  try {
    const res = await apiPost('/api/client-api/tokens/create', { label, scopes });
    closeCreateTokenModal();

    // Reveal the token once
    _revealedToken = res.token;
    document.getElementById('token-reveal-value').textContent = res.token;
    document.getElementById('token-reveal-modal').style.display = 'flex';

    await loadApiTokens();
  } catch (err) {
    alert('Failed to create token: ' + err.message);
  }
}

function copyRevealedToken() {
  if (_revealedToken) {
    navigator.clipboard.writeText(_revealedToken).then(() => {
      const btn = event.target;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy token'; }, 2000);
    });
  }
}

function closeTokenRevealModal() {
  _revealedToken = null;
  document.getElementById('token-reveal-modal').style.display = 'none';
}

// ---------------------------------------------------------------------------
// REVOKE TOKEN
// ---------------------------------------------------------------------------
async function revokeToken(tokenId, label) {
  if (!confirm(`Revoke token "${label}"? Any integrations using this token will stop working immediately.`)) return;

  try {
    await apiPost('/api/client-api/tokens/revoke', { token_id: tokenId, reason: 'user_revoked' });
    await loadApiTokens();
    showToast('Token revoked');
  } catch (err) {
    alert('Failed to revoke token: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// ROTATE TOKEN
// ---------------------------------------------------------------------------
async function rotateToken(tokenId) {
  if (!confirm('Rotate this token? The current token will stop working and a new one will be issued.')) return;

  try {
    const res = await apiPost('/api/client-api/tokens/rotate', { token_id: tokenId });

    // Reveal new token
    _revealedToken = res.token;
    document.getElementById('token-reveal-value').textContent = res.token;
    document.getElementById('token-reveal-modal').style.display = 'flex';

    await loadApiTokens();
  } catch (err) {
    alert('Failed to rotate token: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// OPENAPI SPEC DOWNLOAD
// ---------------------------------------------------------------------------
async function downloadOpenApiSpec() {
  try {
    const res = await apiPost('/api/client-api/tokens/openapi', {});
    const blob = new Blob([JSON.stringify(res.spec, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `formaut-api-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Failed to generate API spec: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
async function apiPost(path, body) {
  // Get Google token from dashboard state (dashboard-state.js sets window._googleToken)
  const token = window._googleToken || window.formautState?.googleToken;

  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, slug: body.slug || clientCtx?.slug || window.formautState?.client?.slug, _token: token }),
  });

  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function showToast(msg) {
  // Reuse existing dashboard toast if available
  if (typeof window.showDashboardToast === 'function') {
    window.showDashboardToast(msg);
    return;
  }
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

// Expose for inline onclick handlers
window.showCreateTokenModal = showCreateTokenModal;
window.closeCreateTokenModal = closeCreateTokenModal;
window.createApiToken = createApiToken;
window.copyRevealedToken = copyRevealedToken;
window.closeTokenRevealModal = closeTokenRevealModal;
window.revokeToken = revokeToken;
window.rotateToken = rotateToken;
window.downloadOpenApiSpec = downloadOpenApiSpec;
window.initApiPanel = initApiPanel;

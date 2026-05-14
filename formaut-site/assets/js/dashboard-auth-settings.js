/* Extracted from dashboard.html. Loaded as an ordered classic script. */
function loadSession(id) {
      // Future: fetch conversation history from Supabase for this session_id
      // and repopulate conversationHistory + message thread
      setView('chat');
    }

    // ── Auth ─────────────────────────────────────────────────────────────────
    // Google Client ID — injected at build time or set as a global from env
    // In Cloudflare Pages, add GOOGLE_CLIENT_ID as an env var and
    // expose it via a small Pages Function at /api/config that returns it,
    // OR embed it directly here since it's safe to expose in frontend JS.
    // Set via: window.GOOGLE_CLIENT_ID = '<your-client-id>' in a config endpoint.
    const AUTH_SESSION_KEY = 'fm_google_token';
    const TOKEN_MAX_AGE_MS = 55 * 60 * 1000; // 55 min (Google tokens last 1hr)

    function authCheck() {
      const stored  = sessionStorage.getItem(AUTH_SESSION_KEY);
      const storedAt = parseInt(sessionStorage.getItem('fm_token_at') || '0', 10);
      const age = Date.now() - storedAt;

      if (stored && age < TOKEN_MAX_AGE_MS) {
        // Valid session — restore context and go straight to dashboard
        restoreClientCtx();
        init();
      } else {
        // No session or expired — clear stale data and show sign-in
        sessionStorage.removeItem(AUTH_SESSION_KEY);
        sessionStorage.removeItem('fm_token_at');
        showAuthScreen();
      }
    }


    // Resolves when google.accounts is ready.
    // Needed because the GSI script tag is async — google may not be
    // defined yet when showAuthScreen() is called (KB §2.3)
    let gsiInitialized = false;
    function waitForGSI() {
      return new Promise((resolve) => {
        if (typeof google !== 'undefined' && google.accounts) { resolve(); return; }
        const script = document.getElementById('gsi-script');
        if (script) {
          script.addEventListener('load', resolve, { once: true });
        } else {
          const poll = setInterval(() => {
            if (typeof google !== 'undefined' && google.accounts) {
              clearInterval(poll); resolve();
            }
          }, 50);
        }
      });
    }

    async function showAuthScreen() {
      document.getElementById('auth-screen').classList.add('visible');

      // Fetch the Google client ID from our config endpoint
      // (safe to expose — it's a public identifier, not a secret)
      let clientId = '';
      try {
        const cfgRes = await fetch('/api/config');
        const cfg = await cfgRes.json();
        clientId = cfg.google_client_id || '';
      } catch {
        showAuthError('Could not load sign-in configuration. Please refresh.');
        return;
      }

      // GSI: wait for script, then init exactly once.
      // Guard prevents double-init which causes the browser to block
      // multiple simultaneous popup attempts (KB §2.3)
      if (!gsiInitialized) {
        await waitForGSI();
        gsiInitialized = true;
        google.accounts.id.initialize({
          client_id:   clientId,
          callback:    onGoogleSignIn,
          auto_select: false,
        });
        google.accounts.id.renderButton(
          document.getElementById('google-signin-btn'),
          {
            theme: 'filled_black',
            size:  'large',
            text:  'signin_with',
            shape: 'rectangular',
            width: 280,
          }
        );
      }
    }

    async function onGoogleSignIn(googleResponse) {
      const token = googleResponse.credential;

      // Show loading, hide button
      document.getElementById('google-signin-btn').style.display = 'none';
      document.getElementById('auth-prompt').style.display = 'none';
      document.getElementById('auth-loading').classList.add('visible');
      setLoadingText('Signing in…');

      try {
        setLoadingText('Finding your site…');

        const res = await fetch('/api/auth-lookup', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token }),
        });

        const data = await res.json();

        if (!res.ok) {
          showAuthError(data.error || "Sign-in failed. Make sure you're using the right Google account.");
          return;
        }

        // Persist session
        sessionStorage.setItem(AUTH_SESSION_KEY,    token);
        sessionStorage.setItem('fm_token_at',       String(Date.now()));
        sessionStorage.setItem('fm_admin_email',    data.email || '');

        // Persist Tier 1 client context returned by auth-lookup
        const c = data.client || {};
        sessionStorage.setItem('fm_client_name',     c.name             || '');
        sessionStorage.setItem('fm_client_slug',     c.slug             || '');
        sessionStorage.setItem('fm_live_url',        c.live_url         || '');
        sessionStorage.setItem('fm_pages_url',       c.pages_url        || '');
        sessionStorage.setItem('fm_plan',            c.plan             || 'Standard');
        sessionStorage.setItem('fm_status',          c.status           || 'live');
        sessionStorage.setItem('fm_recent_sessions', JSON.stringify(c.recent_sessions || []));
        if (data.is_operator) sessionStorage.setItem('fm_is_operator', '1');
        setLoadingText('Loading your dashboard…');
        await new Promise(r => setTimeout(r, 350));

        document.getElementById('auth-screen').classList.remove('visible');
        restoreClientCtx();
        init();

      } catch {
        showAuthError('Something went wrong — please try again.');
      }
    }

    function setLoadingText(text) {
      document.getElementById('auth-loading-text').textContent = text;
    }

    function showAuthError(msg) {
      document.getElementById('auth-loading').classList.remove('visible');
      document.getElementById('auth-error').textContent = msg;
      document.getElementById('auth-error').classList.add('visible');
      document.getElementById('google-signin-btn').style.display = 'block';
      document.getElementById('auth-prompt').style.display = 'block';
    }

    function restoreClientCtx() {
      clientCtx.name            = sessionStorage.getItem('fm_client_name')     || 'Your Business';
      clientCtx.slug            = sessionStorage.getItem('fm_client_slug')     || '';
      clientCtx.live_url        = sessionStorage.getItem('fm_live_url')        || '';
      clientCtx.pages_url       = sessionStorage.getItem('fm_pages_url')       || '';
      clientCtx.plan            = sessionStorage.getItem('fm_plan')            || 'Standard';
      clientCtx.admin_email     = sessionStorage.getItem('fm_admin_email')     || '';
      clientCtx.status          = sessionStorage.getItem('fm_status')          || 'live';
      clientCtx.recent_sessions = JSON.parse(sessionStorage.getItem('fm_recent_sessions') || '[]');
      if (sessionStorage.getItem('fm_is_operator') === '1') activateOperatorCapabilities();
    }

    // ── Infrastructure providers (keys on clients table, not integration_connections) ──
    const INFRA_PROVIDERS = [
      {
        id: 'github', field: 'github_token_enc', statusKey: 'github_token',
        title: 'GitHub', category: 'Infrastructure',
        description: 'Allows Formaut to read and update your website code repository. Required for all site builds and deployments.',
        secret_label: 'Personal access token (classic)',
        help_text: 'Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic). Generate a token with repo scope.',
        placeholder: 'ghp_…',
      },
      {
        id: 'cloudflare', field: 'cloudflare_token_enc', statusKey: 'cloudflare_token',
        title: 'Cloudflare', category: 'Infrastructure',
        description: 'Allows Formaut to deploy your site, manage domains, and update environment variables.',
        secret_label: 'API token',
        help_text: 'Go to Cloudflare → My Profile → API Tokens. Create a token with Edit Cloudflare Pages and Edit DNS permissions.',
        placeholder: 'Paste your Cloudflare API token…',
      },
      {
        id: 'supabase', field: 'supabase_service_key_enc', statusKey: 'supabase_service_key',
        title: 'Supabase', category: 'Infrastructure',
        description: 'Allows Formaut to read and write your site database, including memory, session data, and site content.',
        secret_label: 'Service role key',
        help_text: 'Go to your Supabase project → Settings → API. Copy the service_role key (not the anon key).',
        placeholder: 'eyJ…',
      },
    ];

    let infraState = {};
    let currentSecretIsInfra = false;
    let auditModalProvider = null;
    let isOperatorSession = false;
    let operatorModeActive = false;

    // ── Operator mode ──────────────────────────────────────────────────────────
    function activateOperatorCapabilities() {
      isOperatorSession = true;
      document.getElementById('operator-toggle').style.display = 'block';
      // Store so it survives page restores
      sessionStorage.setItem('fm_is_operator', '1');
    }

    function toggleOperatorMode() {
      operatorModeActive = !operatorModeActive;
      document.body.classList.toggle('operator-mode', operatorModeActive);
      const btn = document.getElementById('operator-toggle');
      btn.classList.toggle('operator-active', operatorModeActive);
      btn.textContent = operatorModeActive ? '⚙ Client view' : '⚙ Operator';
      if (operatorModeActive) {
        setView('op-clients');
        loadOpClients();
      } else {
        setView('chat');
      }
    }

    // ── Infra connection rendering ─────────────────────────────────────────────
    // Called from renderConnections() — replaces the grid content
    function renderInfraSection() {
      return INFRA_PROVIDERS.map(provider => {
        const state     = infraState[provider.id] || {};
        const connected = Boolean(state.connected);
        const hint      = state.hint ? `<span style="font-family:var(--f-mono);font-size:0.68rem;color:var(--fog);background:var(--wire);padding:0.1rem 0.45rem;border-radius:3px;letter-spacing:0.04em;">${escHtml(state.hint)}</span>` : '';
        const updated   = state.updated_at ? `Updated ${formatDate(state.updated_at)}` : (connected ? 'Connected' : 'Not connected');
        const hasAudit  = Array.isArray(state.audit_log) && state.audit_log.length > 0;
        return `
          <div class="connection-card" data-infra="${escHtml(provider.id)}" style="${connected ? 'border-color:rgba(74,222,128,0.1)' : ''}">
            <div class="connection-card-header">
              <div>
                <div class="connection-name">${escHtml(provider.title)}</div>
                <div class="connection-category">${escHtml(provider.category)}</div>
              </div>
              <div class="connection-status ${connected ? 'connected' : 'disconnected'}"><span class="dot"></span>${connected ? 'Connected' : 'Not connected'}</div>
            </div>
            <div class="connection-desc">${escHtml(provider.description)}</div>
            <div class="connection-meta" style="display:flex;align-items:center;gap:0.65rem;flex-wrap:wrap;">
              ${hint}<span>${escHtml(updated)}</span>
            </div>
            <div class="connection-actions">
              <button class="small-action-btn primary" onclick="openInfraModal('${provider.id}','${connected ? 'rolled' : 'saved'}')">${connected ? 'Roll key' : 'Connect'}</button>
              ${connected ? `<button class="small-action-btn danger" onclick="showRevokeStrip('${provider.id}')">Revoke</button>` : ''}
              ${hasAudit  ? `<button class="small-action-btn" onclick="openAuditModal('${provider.id}')">History</button>` : ''}
            </div>
            <div id="revoke-strip-${provider.id}" style="display:none;padding:0.6rem 0 0.1rem;font-size:0.8rem;color:var(--fog);display:none;gap:0.5rem;flex-wrap:wrap;align-items:center;">
              <span>Revoke removes Formaut's access until you add a new key. Continue?</span>
              <button class="small-action-btn danger" onclick="confirmRevoke('${provider.id}')">Yes, revoke</button>
              <button class="small-action-btn" onclick="hideRevokeStrip('${provider.id}')">Cancel</button>
            </div>
            <div id="infra-msg-${provider.id}" style="display:none;font-family:var(--f-mono);font-size:0.7rem;margin-top:0.35rem;padding:0.35rem 0.65rem;border-radius:4px;"></div>
          </div>`;
      }).join('');
    }

    function showRevokeStrip(id) {
      const el = document.getElementById(`revoke-strip-${id}`);
      if (el) { el.style.display = 'flex'; }
    }
    function hideRevokeStrip(id) {
      const el = document.getElementById(`revoke-strip-${id}`);
      if (el) el.style.display = 'none';
    }

    async function confirmRevoke(providerId) {
      const provider = INFRA_PROVIDERS.find(p => p.id === providerId);
      if (!provider) return;
      const btn = document.querySelector(`#revoke-strip-${providerId} .danger`);
      if (btn) { btn.disabled = true; btn.textContent = 'Revoking…'; }
      try {
        const googleToken = sessionStorage.getItem('fm_google_token') || '';
        const res = await fetch('/api/save-credential', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
          body: JSON.stringify({ field: provider.field, client_id: clientCtx.slug, action: 'revoked' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Revoke failed');
        showInfraMsg(providerId, 'Key revoked. Formaut no longer has access.', '#4ade80');
        hideRevokeStrip(providerId);
        await loadConnections();
      } catch (err) {
        showInfraMsg(providerId, err.message || 'Could not revoke.', '#f87171');
        if (btn) { btn.disabled = false; btn.textContent = 'Yes, revoke'; }
      }
    }

    function showInfraMsg(id, text, color) {
      const el = document.getElementById(`infra-msg-${id}`);
      if (!el) return;
      el.textContent = text;
      el.style.display = 'block';
      el.style.color = color;
      el.style.background = color === '#4ade80' ? 'rgba(74,222,128,0.06)' : 'rgba(248,113,113,0.06)';
      el.style.border = `1px solid ${color === '#4ade80' ? 'rgba(74,222,128,0.15)' : 'rgba(248,113,113,0.15)'}`;
    }

    function openInfraModal(providerId, action) {
      const provider = INFRA_PROVIDERS.find(p => p.id === providerId);
      if (!provider) return;
      currentSecretProvider  = providerId;
      currentSecretIsInfra   = true;
      const isRoll = action === 'rolled';
      document.getElementById('secret-modal-title').textContent  = isRoll ? `Roll ${provider.title} key` : `Connect ${provider.title}`;
      document.getElementById('secret-modal-sub').textContent    = provider.help_text;
      document.getElementById('secret-field-label').textContent  = provider.secret_label;
      document.getElementById('secret-input').value              = '';
      document.getElementById('secret-input').placeholder        = provider.placeholder || 'Paste token here…';
      document.getElementById('secret-save-btn').disabled        = false;
      document.getElementById('secret-save-btn').textContent     = isRoll ? 'Roll key' : 'Connect';
      document.getElementById('secret-modal-backdrop').classList.add('open');
      setTimeout(() => document.getElementById('secret-input').focus(), 50);
    }

    function openAuditModal(providerId) {
      const provider = INFRA_PROVIDERS.find(p => p.id === providerId);
      const log      = (infraState[providerId] || {}).audit_log || [];
      const friendlyAction = { saved: 'Connected', rolled: 'Rolled', revoked: 'Revoked' };
      const rows = log.length
        ? log.map(e => `
            <tr>
              <td style="padding:0.55rem 0;border-bottom:1px solid var(--wire);font-family:var(--f-mono);font-size:0.68rem;color:var(--fog);padding-right:1.25rem;white-space:nowrap;">${escHtml(formatDate(e.created_at))}</td>
              <td style="padding:0.55rem 0;border-bottom:1px solid var(--wire);padding-right:1.25rem;">
                <span style="font-family:var(--f-mono);font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;padding:0.1rem 0.4rem;border-radius:3px;
                  ${e.action==='revoked' ? 'color:#f87171;background:rgba(248,113,113,0.08)' : 'color:#4ade80;background:rgba(74,222,128,0.08)'}">${escHtml(friendlyAction[e.action] || e.action)}</span>
              </td>
              <td style="padding:0.55rem 0;border-bottom:1px solid var(--wire);font-family:var(--f-mono);font-size:0.7rem;color:var(--fog);padding-right:1.25rem;">${escHtml(e.hint || '—')}</td>
              <td style="padding:0.55rem 0;border-bottom:1px solid var(--wire);font-size:0.75rem;color:var(--fog);">${escHtml(e.actor_email || '')}</td>
            </tr>`).join('')
        : `<tr><td colspan="4" style="padding:1.25rem 0;color:var(--fog);font-size:0.82rem;">No history recorded yet.</td></tr>`;
      document.getElementById('audit-modal-title').textContent = `${provider?.title || ''} key history`;
      document.getElementById('audit-modal-body').innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:0.78rem;">
          <thead><tr>
            <th style="text-align:left;font-family:var(--f-mono);font-size:0.58rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--fog);padding-bottom:0.6rem;border-bottom:1px solid var(--wire);padding-right:1.25rem;">When</th>
            <th style="text-align:left;font-family:var(--f-mono);font-size:0.58rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--fog);padding-bottom:0.6rem;border-bottom:1px solid var(--wire);padding-right:1.25rem;">Action</th>
            <th style="text-align:left;font-family:var(--f-mono);font-size:0.58rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--fog);padding-bottom:0.6rem;border-bottom:1px solid var(--wire);padding-right:1.25rem;">Hint</th>
            <th style="text-align:left;font-family:var(--f-mono);font-size:0.58rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--fog);padding-bottom:0.6rem;border-bottom:1px solid var(--wire);">By</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:1rem;font-size:0.75rem;color:var(--smoke);line-height:1.5;">Key values are never stored. The hint shows the last 4 characters only.</p>`;
      document.getElementById('audit-modal-backdrop').classList.add('open');
    }

    function closeAuditModal() {
      document.getElementById('audit-modal-backdrop').classList.remove('open');
    }

    function populateSettings() {
      const email = sessionStorage.getItem('fm_admin_email') || '—';
      const plan  = clientCtx.plan || 'Standard';
      const slug  = clientCtx.slug || '—';
      const emailEl = document.getElementById('settings-email-display');
      const planEl  = document.getElementById('settings-plan-display');
      const slugEl  = document.getElementById('settings-slug-display');
      if (emailEl) emailEl.textContent = email;
      if (planEl)  planEl.textContent  = plan;
      if (slugEl)  slugEl.textContent  = slug;
    }

    function signOut() {
      sessionStorage.clear();
      location.reload();
    }

    // ── Operator data loaders ──────────────────────────────────────────────────

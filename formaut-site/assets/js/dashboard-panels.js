/* Extracted from dashboard.html. Loaded as an ordered classic script. */
function setView(view) {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('overlay');
      sidebar.classList.remove('open');
      overlay.classList.remove('show');

      // Update sidebar active state
      document.querySelectorAll('.sidebar-btn').forEach(btn => btn.classList.remove('active'));
      const navBtn = document.getElementById(`nav-${view}`);
      if (navBtn) navBtn.classList.add('active');

      const welcome     = document.getElementById('welcome-state');
      const thread      = document.getElementById('message-thread');
      const input       = document.querySelector('.input-area');
      const connections = document.getElementById('connections-panel');
      const jobs        = document.getElementById('jobs-panel');
      const reviews     = document.getElementById('reviews-panel');
      const adminPanel   = document.getElementById('admin-panel');
      const emailPanel   = document.getElementById('email-panel');
      const activityPanel = document.getElementById('activity-panel');
      const settingsPanel = document.getElementById('settings-panel');
      const billingPanel  = document.getElementById('billing-panel');
      const opPanels = ['op-clients-panel','op-queue-panel','op-signals-panel','op-health-panel','op-deploys-panel','op-env-panel','op-prompt-panel']
        .map(id => document.getElementById(id));
      const infrastructurePanel = document.getElementById('infrastructure-panel');
      const mcpPanel             = document.getElementById('mcp-panel');

      // Hide all workspace panels
      [connections, jobs, reviews, adminPanel, emailPanel, activityPanel, settingsPanel, billingPanel,
       infrastructurePanel, mcpPanel, ...opPanels]
        .forEach(p => p?.classList.remove('active'));

      // Stop jobs polling if leaving jobs view
      if (view !== 'jobs' && jobsPollTimer) { clearInterval(jobsPollTimer); jobsPollTimer = null; }

      if (view === 'connections') {
        welcome.style.display = 'none';
        thread.style.display = 'none';
        input.style.display = 'none';
        connections.classList.add('active');
        loadConnections();
        return;
      }

      if (view === 'jobs') {
        welcome.style.display = 'none';
        thread.style.display = 'none';
        input.style.display = 'none';
        jobs?.classList.add('active');
        loadJobs();
        jobsPollTimer = setInterval(loadJobs, 5000);
        return;
      }

      if (view === 'reviews') {
        welcome.style.display = 'none';
        thread.style.display = 'none';
        input.style.display = 'none';
        reviews?.classList.add('active');
        loadReviews();
        return;
      }

      if (view === 'admin') {
        welcome.style.display = 'none';
        thread.style.display = 'none';
        input.style.display = 'none';
        adminPanel.classList.add('active');
        initAdminPanel();
        return;
      }

      if (view === 'email') {
        welcome.style.display = 'none';
        thread.style.display = 'none';
        input.style.display = 'none';
        emailPanel.classList.add('active');
        initEmailPanel();
        return;
      }

      if (view === 'activity') {
        welcome.style.display = 'none';
        thread.style.display = 'none';
        input.style.display = 'none';
        activityPanel.classList.add('active');
        loadActivity();
        return;
      }

      if (view === 'settings') {
        welcome.style.display = 'none'; thread.style.display = 'none'; input.style.display = 'none';
        settingsPanel.classList.add('active');
        populateSettings();
        return;
      }

      if (view === 'billing') {
        welcome.style.display = 'none'; thread.style.display = 'none'; input.style.display = 'none';
        billingPanel.classList.add('active');
        document.getElementById('billing-plan-display').textContent = clientCtx.plan || 'Standard';
        return;
      }

      if (view === 'infrastructure') {
        welcome.style.display = 'none';
        thread.style.display = 'none';
        input.style.display = 'none';
        infrastructurePanel?.classList.add('active');
        loadInfrastructure();
        return;
      }

      if (view === 'mcp') {
        welcome.style.display = 'none';
        thread.style.display = 'none';
        input.style.display = 'none';
        mcpPanel?.classList.add('active');
        loadMcp();
        return;
      }

      // Operator views
      if (view.startsWith('op-')) {
        welcome.style.display = 'none';
        thread.style.display = 'none';
        input.style.display = 'none';
        document.getElementById(`${view}-panel`)?.classList.add('active');
        if (view === 'op-deploys') loadOpDeploys();
        if (view === 'op-env') loadOpEnv();
        return;
      }

      // Default: chat view
      input.style.display = 'block';
      if (conversationHistory.length > 0) {
        welcome.style.display = 'none';
        thread.style.display = 'flex';
      } else {
        welcome.style.display = 'flex';
        thread.style.display = 'none';
      }
    }

    // ── Mode-specific chat state ───────────────────────────────────────────────
    let adminHistory = [];
    let emailHistory = [];
    let adminSessionId = null;
    let emailSessionId = null;

    function initAdminPanel() {
      // Load admin panel preview if site exists
      const liveUrl = clientCtx.live_url;
      const adminIframe = document.getElementById('admin-preview-iframe');
      const adminPreviewArea = document.getElementById('admin-preview-area');
      if (liveUrl && liveUrl !== 'not yet configured') {
        const adminUrl = liveUrl.replace(/\/$/, '') + '/admin';
        adminIframe.src = adminUrl;
        adminPreviewArea.style.display = 'block';
        document.getElementById('admin-title').textContent = 'Your admin panel.';
        document.getElementById('admin-sub').textContent = 'Make changes here or ask Formaut to add new controls. The preview updates after each deploy.';
      }
      // Restore existing thread if any
      const thread = document.getElementById('admin-message-thread');
      if (adminHistory.length > 0) thread.style.display = 'flex';
    }

    function initEmailPanel() {
      const thread = document.getElementById('email-message-thread');
      if (emailHistory.length > 0) thread.style.display = 'flex';
      // TODO: load existing email templates list from GitHub /emails/ directory
    }

    async function loadActivity() {
      const feed = document.getElementById('activity-feed');
      feed.innerHTML = '<div style="color:var(--fog);font-size:0.85rem;">Loading…</div>';
      try {
        const googleToken = sessionStorage.getItem('fm_google_token') || '';
        const res = await fetch('/api/activity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
          body: JSON.stringify({ client_id: clientCtx.slug }),
        });
        if (!res.ok) throw new Error('not available');
        const data = await res.json();
        renderActivityFeed(data.events || []);
      } catch {
        renderActivityFeed([]);
      }
    }

    function renderActivityFeed(events) {
      const feed = document.getElementById('activity-feed');
      if (!events.length) {
        feed.innerHTML = '<div style="color:var(--fog);font-size:0.85rem;">No activity yet — this is where Formaut logs what it\'s done and anything that needs your attention.</div>';
        return;
      }
      feed.innerHTML = events.map(e => {
        const isAlert = e.severity === 'critical' || e.severity === 'warning' || e.needs_attention;
        return `
          <div style="display:flex;gap:0.75rem;padding:0.85rem 0;border-bottom:1px solid var(--wire);align-items:flex-start;">
            <div style="font-size:1rem;flex-shrink:0;margin-top:0.05rem;">${isAlert ? '⚠️' : '✓'}</div>
            <div style="flex:1;">
              <div style="font-size:0.85rem;color:${isAlert ? 'var(--ember)' : 'var(--paper)'};">${escHtml(e.summary || e.type || 'Event')}</div>
              ${e.detail ? `<div style="font-size:0.78rem;color:var(--fog);margin-top:0.15rem;">${escHtml(e.detail)}</div>` : ''}
            </div>
            <div style="font-family:var(--f-mono);font-size:0.62rem;color:var(--smoke);flex-shrink:0;white-space:nowrap;">${formatDate(e.created_at || e.date)}</div>
          </div>`;
      }).join('');
    }

    // ── Sends a message in a mode-specific chat (admin or email) ─────────────
    async function sendModeMessage(mode) {
      const inputId  = `${mode}-chat-input`;
      const threadId = `${mode}-message-thread`;
      const input    = document.getElementById(inputId);
      const thread   = document.getElementById(threadId);
      const message  = input?.value?.trim();
      if (!message || isWaiting) return;

      input.value = '';
      thread.style.display = 'flex';

      // Append user message
      const userRow = document.createElement('div');
      userRow.className = 'msg-row user';
      userRow.innerHTML = `<div class="msg-bubble user">${escHtml(message)}</div>`;
      thread.appendChild(userRow);
      thread.scrollTop = thread.scrollHeight;

      // Thinking indicator
      const thinkingRow = document.createElement('div');
      thinkingRow.className = 'msg-row agent';
      thinkingRow.innerHTML = `<div class="msg-bubble agent thinking"><span></span><span></span><span></span></div>`;
      thread.appendChild(thinkingRow);
      thread.scrollTop = thread.scrollHeight;

      isWaiting = true;

      const history      = mode === 'admin' ? adminHistory : emailHistory;
      const sessionIdRef = mode === 'admin' ? adminSessionId : emailSessionId;

      try {
        const googleToken = sessionStorage.getItem('fm_google_token') || '';
        const res = await fetch('/api/chat', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
          body: JSON.stringify({
            message,
            history,
            client_id:       clientCtx.slug,
            session_id:      sessionIdRef,
            session_context: sessionContext,
            chat_mode:       mode,        // ← mode routing key
          }),
        });

        thinkingRow.remove();
        const data = await res.json().catch(() => ({}));

        if (mode === 'admin') adminSessionId = data.session_id || adminSessionId;
        if (mode === 'email') emailSessionId = data.session_id || emailSessionId;

        const agentText = data.response || data.error || 'Something went wrong.';
        const agentRow = document.createElement('div');
        agentRow.className = 'msg-row agent';
        agentRow.innerHTML = `<div class="msg-bubble agent">${renderMarkdown(agentText)}</div>`;
        thread.appendChild(agentRow);
        thread.scrollTop = thread.scrollHeight;

        // Update history
        history.push({ role: 'user', content: message });
        history.push({ role: 'assistant', content: agentText });

        // Show preview if returned
        if (data.preview_srcdoc) {
          openPreview({ mode: 'srcdoc', html: data.preview_srcdoc });
        }
      } catch {
        thinkingRow.remove();
        const errRow = document.createElement('div');
        errRow.className = 'msg-row agent';
        errRow.innerHTML = `<div class="msg-bubble agent">Something went wrong — please try again.</div>`;
        thread.appendChild(errRow);
      } finally {
        isWaiting = false;
      }
    }

    // Wire Enter key for mode inputs
    document.addEventListener('DOMContentLoaded', () => {
      ['admin-chat-input', 'email-chat-input'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              const mode = id.replace('-chat-input', '');
              sendModeMessage(mode);
            }
          });
        }
      });
    });

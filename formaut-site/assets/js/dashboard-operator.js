/* Extracted from dashboard.html. Loaded as an ordered classic script. */
async function opFetch(path, payload = {}) {
      const googleToken = sessionStorage.getItem('fm_google_token') || '';
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
        body: JSON.stringify({ chat_mode: 'operator', ...payload }),
      });
      return res.json().catch(() => ({}));
    }

    async function loadOpClients() {
      const list = document.getElementById('op-clients-list');
      list.innerHTML = '<div style="color:var(--fog);font-size:0.85rem;">Loading…</div>';
      try {
        const data = await opFetch('/api/chat', {
          message: 'List all clients with their slug, status, last deploy status, open escalations, and whether GitHub/Cloudflare/Supabase keys are set. Return as a JSON array.',
          history: [], client_id: clientCtx.slug,
        });
        const text = data.response || '';
        // Try to extract JSON from response
        const match = text.match(/\[[\s\S]*\]/);
        const clients = match ? JSON.parse(match[0]) : [];
        if (!clients.length) { list.innerHTML = '<div style="color:var(--fog);font-size:0.85rem);">No client data returned. Make sure OPERATOR_EMAIL is set in the Worker.</div>'; return; }
        list.innerHTML = clients.map(c => `
          <div class="job-card">
            <div class="job-title">${escHtml(c.slug || c.name || 'Unknown')}</div>
            <div class="job-status ${c.status === 'live' ? 'succeeded' : 'running'}">${escHtml(c.status || '—')}</div>
            <div class="job-meta">Last deploy: ${escHtml(c.last_deploy_status || 'never')} · Escalations: ${escHtml(String(c.open_escalations ?? 0))}</div>
            <div class="job-detail">GitHub: ${c.github ? '✓' : '✗'} · Cloudflare: ${c.cloudflare ? '✓' : '✗'} · Supabase: ${c.supabase ? '✓' : '✗'}</div>
          </div>`).join('');
      } catch (err) {
        list.innerHTML = `<div style="color:#f87171;font-size:0.82rem;">${escHtml(err.message)}</div>`;
      }
    }

    async function loadOpQueue() {
      const list = document.getElementById('op-queue-list');
      list.innerHTML = '<div style="color:var(--fog);font-size:0.85rem;">Loading…</div>';
      try {
        const googleToken = sessionStorage.getItem('fm_google_token') || '';
        const res = await fetch('/api/jobs/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
          body: JSON.stringify({ slug: clientCtx.slug, limit: 20 }),
        });
        const data = await res.json().catch(() => ({}));
        const jobs = data.jobs || [];
        list.innerHTML = jobs.length
          ? jobs.map(j => `
              <div class="job-card">
                <div class="job-title">${escHtml(j.job_type || j.type || 'Job')}</div>
                <div class="job-status ${j.status}">${escHtml(j.status)}</div>
                <div class="job-meta">${escHtml(j.client_slug || '')} · ${escHtml(j.queue || 'default')} · ${escHtml(formatDate(j.created_at))}</div>
                ${j.status === 'dead' ? `<div class="job-actions"><button class="small-action-btn primary" onclick="retryJob('${j.id}')">Retry</button></div>` : ''}
              </div>`).join('')
          : '<div style="color:var(--fog);font-size:0.85rem;">No jobs in queue.</div>';
      } catch (err) {
        list.innerHTML = `<div style="color:#f87171;font-size:0.82rem;">${escHtml(err.message)}</div>`;
      }
    }

    function showQueueTab(tab) {
      document.getElementById('op-queue-list').style.display  = tab === 'active' ? 'flex' : 'none';
      document.getElementById('op-dead-list').style.display   = tab === 'dead'   ? 'flex' : 'none';
      if (tab === 'dead') loadOpDeadLetter();
      else loadOpQueue();
    }

    async function loadOpDeadLetter() {
      const list = document.getElementById('op-dead-list');
      list.innerHTML = '<div style="color:var(--fog);font-size:0.85rem;">Loading…</div>';
      try {
        const googleToken = sessionStorage.getItem('fm_google_token') || '';
        const res = await fetch('/api/jobs/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
          body: JSON.stringify({ slug: clientCtx.slug, status: 'dead', limit: 20 }),
        });
        const data = await res.json().catch(() => ({}));
        const jobs = data.jobs || [];
        list.innerHTML = jobs.length
          ? jobs.map(j => `
              <div class="job-card">
                <div class="job-title">${escHtml(j.job_type || 'Job')}</div>
                <div class="job-status dead">Dead</div>
                <div class="job-meta">${escHtml(j.client_slug || '')} · Failed ${escHtml(String(j.attempts || 0))} times</div>
                <div class="job-detail">${escHtml(j.last_error || 'No error detail')}</div>
                <div class="job-actions">
                  <button class="small-action-btn primary" onclick="retryJob('${j.id}')">Retry</button>
                </div>
              </div>`).join('')
          : '<div style="color:var(--fog);font-size:0.85rem;">No dead letter jobs. 🎉</div>';
      } catch (err) {
        list.innerHTML = `<div style="color:#f87171;font-size:0.82rem;">${escHtml(err.message)}</div>`;
      }
    }

    async function retryJob(jobId) {
      const googleToken = sessionStorage.getItem('fm_google_token') || '';
      await fetch('/api/jobs/fail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
        body: JSON.stringify({ job_id: jobId, retry: true, slug: clientCtx.slug }),
      });
      loadOpDeadLetter();
    }

    async function loadOpSignals() {
      const list = document.getElementById('op-signals-list');
      list.innerHTML = '<div style="color:var(--fog);font-size:0.85rem;">Loading…</div>';
      try {
        const googleToken = sessionStorage.getItem('fm_google_token') || '';
        const res = await fetch('/api/signals/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
          body: JSON.stringify({ slug: clientCtx.slug, status: 'pending', limit: 20 }),
        });
        const data = await res.json().catch(() => ({}));
        const signals = data.signals || [];
        list.innerHTML = signals.length
          ? signals.map(s => `
              <div class="job-card">
                <div class="job-title">${escHtml(s.title || s.summary || 'Signal')}</div>
                <div class="job-status ${s.confidence === 'confirmed' ? 'succeeded' : 'running'}">${escHtml(s.confidence || 'directional')}</div>
                <div class="job-meta">${escHtml(s.type || s.signal_type || '')} · ${escHtml(s.client_slug || 'platform')} · ${escHtml(formatDate(s.created_at))}</div>
                <div class="job-detail">${escHtml(s.detail || s.description || '')}</div>
                <div class="job-actions">
                  <button class="small-action-btn primary" onclick="promoteSignal('${s.id}')">Promote to KB</button>
                  <button class="small-action-btn" onclick="dismissSignal('${s.id}')">Dismiss</button>
                </div>
              </div>`).join('')
          : '<div style="color:var(--fog);font-size:0.85rem;">No pending signals.</div>';
      } catch (err) {
        list.innerHTML = `<div style="color:#f87171;font-size:0.82rem;">${escHtml(err.message)}</div>`;
      }
    }

    async function promoteSignal(id) {
      const googleToken = sessionStorage.getItem('fm_google_token') || '';
      await fetch('/api/signals/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
        body: JSON.stringify({ signal_id: id, slug: clientCtx.slug }),
      });
      loadOpSignals();
    }

    async function dismissSignal(id) {
      const googleToken = sessionStorage.getItem('fm_google_token') || '';
      await fetch('/api/signals/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
        body: JSON.stringify({ signal_id: id, slug: clientCtx.slug }),
      });
      loadOpSignals();
    }

    async function loadOpHealth() {
      const list = document.getElementById('op-health-list');
      list.innerHTML = '<div style="color:var(--fog);font-size:0.85rem;">Loading…</div>';
      try {
        const googleToken = sessionStorage.getItem('fm_google_token') || '';
        const res = await fetch('/api/operational/health', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
          body: JSON.stringify({ slug: clientCtx.slug }),
        });
        const data = await res.json().catch(() => ({}));
        const events = data.events || data.health || [];
        list.innerHTML = events.length
          ? events.map(e => `
              <div class="job-card">
                <div class="job-title">${escHtml(e.type || e.issue_type || 'Event')}</div>
                <div class="job-status ${e.severity === 'critical' ? 'dead' : e.severity === 'warning' ? 'running' : 'succeeded'}">${escHtml(e.severity || e.risk_level || 'info')}</div>
                <div class="job-meta">${escHtml(e.client_slug || '')} · ${escHtml(formatDate(e.created_at))}</div>
                <div class="job-detail">${escHtml(e.source || JSON.stringify(e.plan || ''))}</div>
                ${e.approved === false ? `<div class="job-actions"><button class="small-action-btn primary" onclick="approveRemediation('${e.id}')">Approve remediation</button></div>` : ''}
              </div>`).join('')
          : '<div style="color:var(--fog);font-size:0.85rem;">No health events. System is quiet.</div>';
      } catch (err) {
        list.innerHTML = `<div style="color:#f87171;font-size:0.82rem;">${escHtml(err.message)}</div>`;
      }
    }

    async function approveRemediation(id) {
      const googleToken = sessionStorage.getItem('fm_google_token') || '';
      await fetch('/api/operational/remediation/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
        body: JSON.stringify({ plan_id: id, slug: clientCtx.slug }),
      });
      loadOpHealth();
    }

    // ── File upload handling ──────────────────────────────────────────────────
    let pendingFile = null;
    let fileIntent = 'reference'; // 'reference' | 'implement'

    function handleFileSelected(input) {
      const file = input.files[0];
      if (!file) return;
      pendingFile = file;
      const sizeKb = Math.round(file.size / 1024);
      const container = document.getElementById('file-chip-container');
      container.innerHTML = `
        <div class="file-chip">
          <span>${escHtml(file.name)}</span>
          <span style="opacity:0.5">${sizeKb}kb</span>
          <span class="file-chip-remove" onclick="clearPendingFile()">×</span>
        </div>`;
      document.getElementById('attach-btn').classList.add('has-file');
      document.getElementById('file-intent-bar').classList.add('visible');
      input.value = '';
    }

    function clearPendingFile() {
      pendingFile = null;
      document.getElementById('file-chip-container').innerHTML = '';
      document.getElementById('file-intent-bar').classList.remove('visible');
      document.getElementById('attach-btn').classList.remove('has-file');
      fileIntent = 'reference';
      setFileIntent('reference');
    }

    function setFileIntent(intent) {
      fileIntent = intent;
      document.getElementById('intent-reference').classList.toggle('selected', intent === 'reference');
      document.getElementById('intent-implement').classList.toggle('selected', intent === 'implement');
    }

    // ── Operator: deploy log ─────────────────────────────────────────────────
    let allDeploys = [];
    async function loadOpDeploys() {
      const list = document.getElementById('op-deploys-list');
      list.innerHTML = '<div class="job-item"><div class="job-detail">Loading…</div></div>';
      try {
        const googleToken = sessionStorage.getItem('fm_google_token') || '';
        const res = await fetch('/api/operator/deploys', {
          headers: { Authorization: `Bearer ${googleToken}` }
        });
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        allDeploys = data.deploys || [];
        renderOpDeploys(allDeploys);
      } catch (e) {
        list.innerHTML = `<div class="job-item"><div class="job-detail" style="color:var(--ember);">Failed to load deploy log: ${e.message}</div></div>`;
      }
    }

    function renderOpDeploys(deploys) {
      const list = document.getElementById('op-deploys-list');
      if (!deploys.length) {
        list.innerHTML = '<div class="job-item"><div class="job-detail">No deploys found.</div></div>';
        return;
      }
      list.innerHTML = deploys.map(d => `
        <div class="job-item">
          <div class="job-title">${escHtml(d.client_slug || d.project || '—')}</div>
          <div class="job-detail">
            ${d.status === 'success' ? '✅' : d.status === 'failure' ? '❌' : '⏳'} ${escHtml(d.status || '—')} ·
            ${escHtml(d.message || d.commit_message || '—')} ·
            <span style="font-family:var(--f-mono);font-size:0.72rem;">${d.created_on ? new Date(d.created_on).toLocaleString() : '—'}</span>
          </div>
          ${d.url ? `<div><a href="${escHtml(d.url)}" target="_blank" rel="noopener" style="font-family:var(--f-mono);font-size:0.72rem;color:var(--ember);">↗ View deploy</a></div>` : ''}
        </div>`).join('');
    }

    function filterOpDeploys(q) {
      if (!q) { renderOpDeploys(allDeploys); return; }
      renderOpDeploys(allDeploys.filter(d =>
        (d.client_slug || d.project || '').toLowerCase().includes(q.toLowerCase())
      ));
    }

    // ── Operator: env inspector ──────────────────────────────────────────────
    async function loadOpEnv() {
      const list = document.getElementById('op-env-list');
      list.innerHTML = '<div class="job-item"><div class="job-detail">Checking…</div></div>';
      try {
        const googleToken = sessionStorage.getItem('fm_google_token') || '';
        const res = await fetch('/api/operator/env', {
          headers: { Authorization: `Bearer ${googleToken}` }
        });
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        const vars = data.vars || [];
        list.innerHTML = vars.map(v => `
          <div class="job-item">
            <div style="display:flex;align-items:center;justify-content:space-between;">
              <div class="job-title" style="font-family:var(--f-mono);font-size:0.78rem;">${escHtml(v.key)}</div>
              <div class="connection-status ${v.present ? 'connected' : 'not-connected'}">
                <span class="dot"></span>${v.present ? 'Present' : 'Missing'}
              </div>
            </div>
            ${v.note ? `<div class="job-detail">${escHtml(v.note)}</div>` : ''}
          </div>`).join('');
      } catch (e) {
        list.innerHTML = `<div class="job-item"><div class="job-detail" style="color:var(--ember);">Failed to load env status: ${e.message}</div></div>`;
      }
    }

    // ── Operator: prompt tester ──────────────────────────────────────────────
    async function runOpPromptTest() {
      const prompt = document.getElementById('op-prompt-input').value.trim();
      const slug = document.getElementById('op-prompt-slug').value.trim();
      const mode = document.getElementById('op-prompt-mode').value;
      const result = document.getElementById('op-prompt-result');
      if (!prompt) return;
      result.style.display = 'block';
      result.textContent = 'Running…';
      try {
        const googleToken = sessionStorage.getItem('fm_google_token') || '';
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${googleToken}` },
          body: JSON.stringify({ message: prompt, client_id: slug || undefined, chat_mode: mode, history: [] })
        });
        const data = await res.json();
        result.textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        result.textContent = `Error: ${e.message}`;
      }
    }

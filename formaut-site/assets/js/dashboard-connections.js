/* Extracted from dashboard.html. Loaded as an ordered classic script. */
function statusLabel(status) {
      if (status === 'connected') return 'Connected';
      if (status === 'error') return 'Needs attention';
      if (status === 'soon') return 'Coming soon';
      return 'Not connected';
    }

    function renderConnections() {
      const grid = document.getElementById('connections-grid');
      if (!grid) return;

      const infraHtml    = renderInfraSection();
      const servicesHtml = CONNECTION_PROVIDERS.map(provider => {
        const state = connectionState[provider.id] || {};
        const status = state.status || provider.status || 'disconnected';
        const connected = status === 'connected';
        const soon = status === 'soon';
        const meta = connected
          ? `Last sync: ${state.last_sync_at ? formatDate(state.last_sync_at) : 'not synced yet'}`
          : (soon ? 'OAuth/app setup not wired yet' : provider.auth_type === 'api_key' ? 'Requires secure access token' : 'OAuth authorization');
        return `
          <div class="connection-card" data-provider="${escHtml(provider.id)}">
            <div class="connection-card-header">
              <div>
                <div class="connection-name">${escHtml(provider.title)}</div>
                <div class="connection-category">${escHtml(provider.category)}</div>
              </div>
              <div class="connection-status ${escHtml(status)}"><span class="dot"></span>${escHtml(statusLabel(status))}</div>
            </div>
            <div class="connection-desc">${escHtml(provider.description)}</div>
            <div class="connection-meta">${escHtml(meta)}</div>
            <div class="connection-actions">
              ${soon ? `<button class="small-action-btn" disabled>Coming soon</button>` : `<button class="small-action-btn primary" onclick="openConnectionModal('${provider.id}')">${connected ? 'Update token' : 'Connect'}</button>`}
              ${provider.id === 'printify' ? `<button class="small-action-btn" onclick="syncPrintifyProducts()" ${connected ? '' : 'disabled'}>Sync products</button><button class="small-action-btn" onclick="previewPrintifyProductTemplates()">Preview templates</button>` : ''}
            </div>
          </div>`;
      }).join('');

      grid.innerHTML = `
        <div style="grid-column:1/-1;">
          <div class="workspace-eyebrow" style="margin-bottom:0.75rem;">Infrastructure</div>
          <div class="connections-grid" style="margin-bottom:2rem;">${infraHtml}</div>
          <div class="workspace-eyebrow" style="margin-bottom:0.75rem;">Connected services</div>
          <div class="connections-grid">${servicesHtml}</div>
        </div>`;
    }

    async function loadConnections() {
      try {
        const data = await integrationsFetch('/api/integrations/list', {});
        const connections = Array.isArray(data.connections) ? data.connections : [];
        connectionState = {};
        for (const c of connections) {
          const provider = c.provider || c.provider_id;
          if (!provider) continue;
          connectionState[provider] = {
            status: c.status || 'connected',
            last_sync_at: c.last_sync_at || c.updated_at || null,
            label: c.label || null
          };
        }
      } catch {
        // Keep static cards visible even if backend is not deployed yet.
      }

      // Fetch infrastructure key status
      try {
        const googleToken = sessionStorage.getItem('fm_google_token') || '';
        const res = await fetch('/api/credential-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
          body: JSON.stringify({ client_id: clientCtx.slug }),
        });
        if (res.ok) {
          const data = await res.json();
          const fields   = data.fields   || {};
          const auditLog = data.audit_log || [];
          infraState = {};
          for (const p of INFRA_PROVIDERS) {
            const f = fields[p.statusKey] || {};
            infraState[p.id] = {
              connected:  Boolean(f.connected),
              hint:       f.hint || null,
              updated_at: f.updated_at || null,
              audit_log:  auditLog.filter(e => e.field === p.field),
            };
          }
        }
      } catch {
        // Non-fatal — infra cards render without status
      }

      renderConnections();
    }

    async function integrationsFetch(path, payload) {
      const googleToken = sessionStorage.getItem('fm_google_token') || '';
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${googleToken}`,
        },
        body: JSON.stringify({ slug: clientCtx.slug, client_id: clientCtx.slug, ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed ${res.status}`);
      return data;
    }

    function openConnectionModal(providerId) {
      const provider = providerById(providerId);
      if (!provider || provider.status === 'soon') return;
      currentSecretProvider = providerId;
      currentSecretIsInfra  = false;
      document.getElementById('secret-modal-title').textContent = `Connect ${provider.title}`;
      document.getElementById('secret-modal-sub').textContent = provider.help_text || `Paste your ${provider.title} access token.`;
      document.getElementById('secret-field-label').textContent = provider.secret_label || 'Access token';
      document.getElementById('secret-input').value = '';
      document.getElementById('secret-input').placeholder = 'Paste token here…';
      document.getElementById('secret-save-btn').disabled = false;
      document.getElementById('secret-save-btn').textContent = 'Connect';
      document.getElementById('secret-modal-backdrop').classList.add('open');
      setTimeout(() => document.getElementById('secret-input').focus(), 50);
    }

    function closeConnectionModal() {
      document.getElementById('secret-modal-backdrop').classList.remove('open');
      document.getElementById('secret-input').value = '';
      currentSecretProvider = null;
      currentSecretIsInfra  = false;
    }

    async function saveConnectionSecret() {
      const value = document.getElementById('secret-input').value.trim();
      if (!value) return;
      const btn = document.getElementById('secret-save-btn');
      btn.disabled = true;
      btn.textContent = 'Securing…';

      // ── Infra key save ───────────────────────────────────────────────────
      if (currentSecretIsInfra) {
        const provider = INFRA_PROVIDERS.find(p => p.id === currentSecretProvider);
        if (!provider) { btn.disabled = false; return; }
        const action = infraState[provider.id]?.connected ? 'rolled' : 'saved';
        try {
          const googleToken = sessionStorage.getItem('fm_google_token') || '';
          const res = await fetch('/api/save-credential', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
            body: JSON.stringify({ secret_value: value, field: provider.field, client_id: clientCtx.slug, action }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.success) throw new Error(data.error || 'Save failed');
          closeConnectionModal();
          showInfraMsg(provider.id, `${action === 'rolled' ? 'Key rolled' : 'Connected'}. Ends in ${data.hint || '••••'}.`, '#4ade80');
          await loadConnections();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = infraState[currentSecretProvider]?.connected ? 'Roll key' : 'Connect';
          alert(err.message || 'Could not save key.');
        }
        return;
      }

      // ── Integration service save ─────────────────────────────────────────
      const provider = providerById(currentSecretProvider);
      if (!provider || !value) return;
      try {
        if (provider.id === 'printify') {
          await integrationsFetch('/api/integrations/printify/connect', { api_token: value, label: 'Printify' });
        } else {
          throw new Error('This connector is not active yet.');
        }
        connectionState[provider.id] = { status: 'connected', last_sync_at: null };
        renderConnections();
        closeConnectionModal();
        appendMessage('agent', getConnectionSuccessMessage(provider.id));
        appendConnectionArtifact(provider.id, 'connected');
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Connect';
        alert(err.message || 'Could not connect service.');
      }
    }

    async function syncPrintifyProducts() {
      const provider = providerById('printify');
      try {
        appendMessage('agent', 'Queued a Printify product sync. You can watch it in Jobs.');
        const data = await jobsFetch('/api/jobs/create', { job_type: 'printify_sync', queue: 'integrations', priority: 160, payload: {} });
        appendMessage('agent', `Printify sync job queued: ${data.job?.id || 'created'}.`);
        setView('jobs');
      } catch (err) {
        appendMessage('agent', `I could not sync Printify yet: ${err.message || 'connection failed'}`);
      }
    }


    async function previewPrintifyProductTemplates() {
      try {
        appendMessage('agent', 'Building default responsive Printify product templates from the current catalog.');
        const data = await integrationsFetch('/api/integrations/commerce/printify/templates/preview', { limit: 8 });
        appendPrintifyTemplatePreview(data);
      } catch (err) {
        appendMessage('agent', `I could not build the Printify product template preview yet: ${err.message || 'request failed'}`);
      }
    }

    function appendPrintifyTemplatePreview(data) {
      const thread = document.getElementById('message-thread');
      if (!thread) return;
      showThread();
      const tpl = data.templates?.collection_grid || null;
      const html = tpl ? `${tpl.css ? `<style>${tpl.css}</style>` : ''}${tpl.html || ''}` : '<p>No product template was returned.</p>';
      const productCount = Number(data.product_count || 0);
      const row = document.createElement('div');
      row.className = 'msg-row agent';
      row.innerHTML = `
        <div class="artifact-card">
          <div class="artifact-card-header">
            <div>
              <div class="artifact-title">Printify default product templates</div>
              <div class="artifact-kicker">${escHtml(data.template_version || 'printify-default-commerce-v1')}</div>
            </div>
            <div class="connection-status connected"><span class="dot"></span>${productCount ? `${productCount} synced` : 'Fallback preview'}</div>
          </div>
          <div class="artifact-desc">
            Formaut now has a loose desktop/mobile product construction pattern for Printify catalogs: collection grid, featured product, product detail, and checkout placeholder.
          </div>
          <div class="job-detail">
            ${productCount ? 'Using real synced Printify products.' : 'No synced products found yet, so this preview uses safe sample products until Sync products succeeds.'}
          </div>
          <iframe title="Printify product template preview" style="width:100%;height:520px;border:1px solid rgba(15,23,42,.12);border-radius:18px;background:white;margin-top:12px;" srcdoc="${escHtml(html)}"></iframe>
          <div class="artifact-actions">
            <button class="small-action-btn primary" onclick="syncPrintifyProducts()">Sync products</button>
            <button class="small-action-btn" onclick="setView('connections')">Open Connections</button>
          </div>
        </div>`;
      thread.appendChild(row);
      thread.scrollTop = thread.scrollHeight;
    }

    function appendConnectionArtifact(providerId, mode = 'connect') {
      const provider = providerById(providerId);
      if (!provider) return;
      const thread = document.getElementById('message-thread');
      if (!thread) return;
      showThread();
      const row = document.createElement('div');
      row.className = 'msg-row agent';
      const connected = (connectionState[provider.id]?.status === 'connected') || mode === 'connected';
      row.innerHTML = `
        <div class="artifact-card">
          <div class="artifact-card-header">
            <div>
              <div class="artifact-title">${connected ? escHtml(provider.title + ' connected') : escHtml('Connect ' + provider.title)}</div>
              <div class="artifact-kicker">${escHtml(provider.category)}</div>
            </div>
            <div class="connection-status ${connected ? 'connected' : 'disconnected'}"><span class="dot"></span>${connected ? 'Connected' : 'Not connected'}</div>
          </div>
          <div class="artifact-desc">${escHtml(provider.description)}</div>
          <div class="artifact-actions">
            ${connected && provider.id === 'printify' ? `<button class="small-action-btn primary" onclick="syncPrintifyProducts()">Sync products</button>` : `<button class="small-action-btn primary" onclick="openConnectionModal('${provider.id}')">Connect</button>`}
            <button class="small-action-btn" onclick="setView('connections')">Open Connections</button>
          </div>
        </div>`;
      thread.appendChild(row);
      thread.scrollTop = thread.scrollHeight;
    }

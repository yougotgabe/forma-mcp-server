// =============================================================================
// dashboard-infra-mcp.js
// Infrastructure panel + MCP / Connected agents panel logic.
//
// Tier behaviour:
//   runtime ($10)      — full technical detail: project refs, schema versions,
//                        health check names, raw MCP URL, scope toggles
//   standard/pro ($50+) — plain-language status only, no technical language.
//                         Token generation and agent management available to
//                         all tiers — every user needs to connect external agents.
//
// Data privacy hard rule:
//   These panels NEVER fetch site content, conversation history, business
//   memory, or client Supabase row data. Only infrastructure metadata
//   (pass/warn/fail, project status, agent names/hints) is loaded.
// =============================================================================


// =============================================================================
// INFRASTRUCTURE PANEL
// =============================================================================

async function loadInfrastructure() {
  const isRuntime  = (clientCtx.plan || '').toLowerCase() === 'runtime';
  const loading    = document.getElementById('infra-loading');
  const statusCard = document.getElementById('infra-status-card');
  const techDetail = document.getElementById('infra-technical-detail');

  document.getElementById('infra-title').textContent = isRuntime
    ? 'Infrastructure' : 'Your setup';
  document.getElementById('infra-sub').textContent = isRuntime
    ? 'Supabase project registry, schema versions, and health checks for your two-project setup.'
    : 'Formaut manages your technical infrastructure automatically. This page shows its current status.';

  techDetail.style.display = isRuntime ? 'block' : 'none';
  loading.style.display    = 'block';
  statusCard.innerHTML     = '';

  try {
    const googleToken = sessionStorage.getItem('fm_google_token') || '';
    const res = await fetch('/api/infrastructure/status', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body:    JSON.stringify({ client_id: clientCtx.slug }),
    });
    const data = res.ok ? await res.json() : null;
    loading.style.display = 'none';
    renderInfraStatus(data, isRuntime);
  } catch {
    loading.textContent = '';
    loading.innerHTML   = '<span style="color:var(--ember);">Could not load infrastructure status.</span>';
    loading.style.display = 'block';
  }
}

function renderInfraStatus(data, isRuntime) {
  const statusCard = document.getElementById('infra-status-card');

  if (!data || !data.ok) {
    statusCard.innerHTML = infraStatusCard({
      icon:   '⚠️',
      label:  isRuntime ? 'Status unavailable' : 'Could not check status',
      detail: isRuntime
        ? 'Infrastructure endpoint did not respond. Check worker deployment.'
        : 'Something went wrong on our end. Formaut will check again shortly.',
      borderColor: 'var(--wire)',
    });
    return;
  }

  const checks    = data.checks  || [];
  const summary   = data.summary || {};
  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;

  if (failCount > 0) {
    statusCard.innerHTML = infraStatusCard({
      icon:        '🔴',
      label:       isRuntime ? `${failCount} health check${failCount > 1 ? 's' : ''} failing` : 'Action needed',
      detail:      isRuntime
        ? 'Run a health check or repair from the controls below.'
        : 'Formaut has detected a setup issue and is working to resolve it. No action is needed from you.',
      borderColor: '#5a1a1a',
    });
  } else if (warnCount > 0) {
    statusCard.innerHTML = infraStatusCard({
      icon:        '🟡',
      label:       isRuntime ? `${warnCount} warning${warnCount > 1 ? 's' : ''}` : 'One moment',
      detail:      isRuntime
        ? 'Schema migration may be pending or a project is still initialising.'
        : 'Formaut is finishing a setup step. Everything should be ready shortly.',
      borderColor: '#6b4e00',
    });
  } else {
    statusCard.innerHTML = infraStatusCard({
      icon:        '🟢',
      label:       isRuntime ? 'All systems operational' : 'Everything is set up and running',
      detail:      isRuntime
        ? 'Both Supabase projects are provisioned and schema is current.'
        : 'Your site infrastructure is fully operational.',
      borderColor: 'var(--wire)',
    });
  }

  if (!isRuntime) return;

  // ── Project registry (runtime only) ────────────────────────────────────────
  const projectsList = document.getElementById('infra-projects-list');
  const projects     = [summary.formaut_os, summary.site_data].filter(Boolean);

  if (projects.length === 0) {
    projectsList.innerHTML = '<div style="font-size:0.82rem;color:var(--fog);">No projects registered yet. Provisioning creates them automatically.</div>';
  } else {
    projectsList.innerHTML = projects.map(p => `
      <div style="background:var(--ash);border:1px solid var(--wire);border-radius:0.65rem;padding:1rem 1.25rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;">
          <div>
            <div style="font-size:0.85rem;font-weight:500;">${escHtml(p.project_role || p.role || '—')}</div>
            <div style="font-family:var(--f-mono);font-size:0.68rem;color:var(--smoke);margin-top:0.15rem;">${escHtml(p.project_name || '—')}</div>
          </div>
          <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
            ${p.schema_version ? `<span style="font-family:var(--f-mono);font-size:0.65rem;color:var(--fog);">schema ${escHtml(p.schema_version)}</span>` : ''}
            <span class="connection-status ${infraStatusClass(p.status)}">
              <span class="dot"></span>${escHtml(p.status || 'unknown')}
            </span>
          </div>
        </div>
        ${p.supabase_url ? `<div style="font-family:var(--f-mono);font-size:0.68rem;color:var(--smoke);margin-top:0.5rem;">${escHtml(p.supabase_url)}</div>` : ''}
        ${p.migration_status ? `<div style="font-size:0.72rem;color:var(--fog);margin-top:0.3rem;">Migration: ${escHtml(p.migration_status)}</div>` : ''}
      </div>
    `).join('');
  }

  // ── Health checks (runtime only) ────────────────────────────────────────────
  const healthList = document.getElementById('infra-health-list');
  if (checks.length === 0) {
    healthList.innerHTML = '<div style="font-size:0.82rem;color:var(--fog);">No health checks recorded. Run a check to populate this list.</div>';
  } else {
    healthList.innerHTML = checks.map(c => `
      <div style="display:flex;align-items:center;gap:0.65rem;padding:0.5rem 0;border-bottom:1px solid var(--wire);">
        <span style="font-size:0.85rem;flex-shrink:0;">${c.status === 'pass' ? '✓' : c.status === 'warn' ? '⚠' : '✗'}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.82rem;font-family:var(--f-mono);">${escHtml(c.check_name || '—')}</div>
          ${c.project_role ? `<div style="font-size:0.72rem;color:var(--fog);">${escHtml(c.project_role)}</div>` : ''}
        </div>
        <span style="font-family:var(--f-mono);font-size:0.65rem;flex-shrink:0;color:${c.status === 'pass' ? 'var(--smoke)' : c.status === 'warn' ? '#e8a020' : 'var(--ember)'};">${escHtml(c.status)}</span>
        ${c.repair_available && c.status !== 'pass' ? `<button class="small-action-btn" onclick="runInfraRepairCheck('${escHtml(c.check_name)}')">Repair</button>` : ''}
      </div>
    `).join('');
  }
}

function infraStatusCard({ icon, label, detail, borderColor }) {
  return `
    <div style="background:var(--ash);border:1px solid ${borderColor};border-radius:0.65rem;padding:1rem 1.25rem;display:flex;gap:0.85rem;align-items:flex-start;">
      <div style="font-size:1.1rem;flex-shrink:0;margin-top:0.05rem;">${icon}</div>
      <div>
        <div style="font-size:0.88rem;font-weight:500;">${escHtml(label)}</div>
        <div style="font-size:0.8rem;color:var(--fog);margin-top:0.2rem;line-height:1.55;">${escHtml(detail)}</div>
      </div>
    </div>`;
}

function infraStatusClass(status) {
  const s = (status || '').toLowerCase();
  if (['ready', 'pass', 'created'].includes(s)) return 'connected';
  if (['fail', 'failed'].includes(s))           return 'error';
  return '';
}

async function runInfraHealthCheck() {
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Running…';
  try {
    const googleToken = sessionStorage.getItem('fm_google_token') || '';
    await fetch('/api/infrastructure/health', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body:    JSON.stringify({ client_id: clientCtx.slug, persist: true }),
    });
    await loadInfrastructure();
  } catch { /* silently reload */ }
  btn.disabled = false; btn.textContent = 'Run health check';
}

async function runInfraRepair() {
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const googleToken = sessionStorage.getItem('fm_google_token') || '';
    const res  = await fetch('/api/infrastructure/repair', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body:    JSON.stringify({ client_id: clientCtx.slug }),
    });
    const data = res.ok ? await res.json() : null;
    if (data?.repair_plan?.length > 0) {
      alert(`${data.repair_plan.length} repair(s) available. Re-run provisioning or contact support.`);
    } else {
      alert('No repairs needed — everything looks good.');
    }
  } catch { alert('Could not run repair check.'); }
  btn.disabled = false; btn.textContent = 'Check for repairs';
}

async function runInfraRepairCheck(checkName) {
  const googleToken = sessionStorage.getItem('fm_google_token') || '';
  try {
    await fetch('/api/infrastructure/repair', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body:    JSON.stringify({ client_id: clientCtx.slug, check_name: checkName, apply: true }),
    });
    await loadInfrastructure();
  } catch { /* silently continue */ }
}


// =============================================================================
// MCP / CONNECTED AGENTS PANEL
// =============================================================================

// Default scope definitions — used for new-agent form checkboxes.
// These map to operations the MCP server enforces.
const MCP_SCOPES = [
  { key: 'read_memory',  label: 'Read business memory',  description: 'Can read your stored business profile and preferences.',          default: true  },
  { key: 'write_memory', label: 'Update business memory', description: 'Can update business facts and learned preferences.',              default: false },
  { key: 'read_site',    label: 'Read site files',        description: 'Can read files in your GitHub repository.',                       default: true  },
  { key: 'write_site',   label: 'Edit site files',        description: 'Can propose and commit changes to your site.',                    default: false },
  { key: 'deploy',       label: 'Trigger deployments',    description: 'Can trigger Cloudflare Pages builds.',                            default: false },
  { key: 'read_db',      label: 'Read site database',     description: 'Can run read queries against your site data.',                    default: true  },
  { key: 'write_db',     label: 'Write to database',      description: 'Can insert or update records in your site database.',             default: false },
];

let mcpDefaultScopes = {}; // populated from API or MCP_SCOPES defaults

async function loadMcp() {
  const isRuntime = (clientCtx.plan || '').toLowerCase() === 'runtime';
  const loading   = document.getElementById('mcp-loading');

  document.getElementById('mcp-sub').textContent = isRuntime
    ? 'Manage which external agents can access your Formaut infrastructure via MCP. Each connection uses a scoped token.'
    : 'Connect AI agents like Claude or Cursor to your site. Each agent gets its own access token that you can revoke at any time.';

  // Show/hide runtime-only elements
  document.getElementById('mcp-endpoint-card').style.display  = isRuntime ? 'block' : 'none';
  document.getElementById('mcp-scopes-section').style.display = isRuntime ? 'block' : 'none';

  // Show agent health panel for operator users
  const isOperator = Boolean(clientCtx.is_operator || window.__formautOperator);
  const agentHealthEl = document.getElementById('client-agent-health-section');
  if (agentHealthEl) {
    agentHealthEl.style.display = isOperator ? 'block' : 'none';
    if (isOperator) loadClientAgentHealth();
  }

  loading.style.display = 'block';

  try {
    const googleToken = sessionStorage.getItem('fm_google_token') || '';
    const res  = await fetch('/api/mcp/status', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body:    JSON.stringify({ client_id: clientCtx.slug }),
    });
    const data = res.ok ? await res.json() : null;
    loading.style.display = 'none';
    renderMcp(data, isRuntime);
  } catch {
    loading.innerHTML     = '<span style="color:var(--ember);">Could not load agent connections.</span>';
    loading.style.display = 'block';
  }
}

function renderMcp(data, isRuntime) {
  // MCP server URL (runtime only)
  if (isRuntime && data?.mcp_server_url) {
    document.getElementById('mcp-server-url').textContent = data.mcp_server_url;
  }

  // Initialise scope defaults from API or local fallback
  MCP_SCOPES.forEach(s => { mcpDefaultScopes[s.key] = s.default; });
  if (data?.available_scopes) {
    Object.entries(data.available_scopes).forEach(([k, v]) => { mcpDefaultScopes[k] = v; });
  }

  // Agent list
  const agents     = data?.agents || [];
  const agentsList = document.getElementById('mcp-agents-list');

  if (agents.length === 0) {
    agentsList.innerHTML = `
      <div style="padding:1.25rem;background:var(--ash);border:1px solid var(--wire);border-radius:0.65rem;text-align:center;">
        <div style="font-size:0.88rem;color:var(--fog);line-height:1.55;">
          No agents connected yet.<br>
          Click <strong style="color:var(--paper);">+ Add agent</strong> above to get setup instructions for Claude, Cursor, or any MCP-compatible tool.
        </div>
      </div>`;
  } else {
    agentsList.innerHTML = agents.map(a => renderAgentCard(a, isRuntime)).join('');
  }

  // Scope defaults panel (runtime only)
  if (isRuntime) {
    renderScopesPanel();
  }

  // Pre-populate new-agent scope checkboxes
  renderNewAgentScopes();
}

function renderAgentCard(agent, isRuntime) {
  const lastSeen = agent.last_seen_at ? formatDate(agent.last_seen_at) : 'Never connected';
  const status   = agent.revoked ? 'revoked' : agent.active ? 'active' : 'inactive';

  const meta = [
    agent.token_hint && isRuntime ? `Token: ••••${escHtml(agent.token_hint)}` : null,
    `Last active: ${escHtml(lastSeen)}`,
    agent.scopes?.length && isRuntime ? `Scopes: ${escHtml(agent.scopes.join(', '))}` : null,
  ].filter(Boolean);

  return `
    <div style="background:var(--ash);border:1px solid var(--wire);border-radius:0.65rem;padding:1rem 1.25rem;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;">
        <div>
          <div style="font-size:0.85rem;font-weight:500;">${escHtml(agent.name || 'Agent')}</div>
          ${agent.note ? `<div style="font-size:0.76rem;color:var(--fog);margin-top:0.1rem;">${escHtml(agent.note)}</div>` : ''}
        </div>
        <div style="display:flex;gap:0.5rem;align-items:center;flex-shrink:0;">
          <span class="connection-status ${status === 'active' ? 'connected' : ''}">
            <span class="dot"></span>${escHtml(status)}
          </span>
          ${!agent.revoked ? `<button class="small-action-btn danger" onclick="revokeMcpAgent('${escHtml(agent.id)}', '${escHtml(agent.name || 'this agent')}')">Revoke</button>` : ''}
        </div>
      </div>
      ${meta.length ? `
        <div style="margin-top:0.65rem;display:flex;flex-direction:column;gap:0.2rem;">
          ${meta.map(m => `<div style="font-family:var(--f-mono);font-size:0.68rem;color:var(--smoke);">${m}</div>`).join('')}
        </div>` : ''}
    </div>`;
}

function renderScopesPanel() {
  const scopesList = document.getElementById('mcp-scopes-list');
  scopesList.innerHTML = MCP_SCOPES.map(scope => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:0.6rem 0;border-bottom:1px solid var(--wire);">
      <div style="padding-right:1rem;">
        <div style="font-size:0.84rem;font-weight:500;">${escHtml(scope.label)}</div>
        <div style="font-size:0.75rem;color:var(--fog);margin-top:0.1rem;">${escHtml(scope.description)}</div>
      </div>
      <label style="flex-shrink:0;cursor:pointer;">
        <input type="checkbox" id="scope-default-${escHtml(scope.key)}"
          ${mcpDefaultScopes[scope.key] ? 'checked' : ''}
          onchange="mcpDefaultScopes['${escHtml(scope.key)}'] = this.checked"
          style="accent-color:var(--ember);width:16px;height:16px;" />
      </label>
    </div>`).join('');
}

function renderNewAgentScopes() {
  const container = document.getElementById('mcp-new-agent-scopes');
  if (!container) return;
  container.innerHTML = MCP_SCOPES.map(scope => `
    <label style="display:flex;align-items:flex-start;gap:0.6rem;cursor:pointer;padding:0.3rem 0;">
      <input type="checkbox" id="new-scope-${escHtml(scope.key)}"
        ${mcpDefaultScopes[scope.key] ? 'checked' : ''}
        style="accent-color:var(--ember);margin-top:0.15rem;flex-shrink:0;" />
      <div>
        <div style="font-size:0.83rem;font-weight:500;">${escHtml(scope.label)}</div>
        <div style="font-size:0.74rem;color:var(--fog);">${escHtml(scope.description)}</div>
      </div>
    </label>`).join('');
}

function toggleMcpHowto() {
  const body    = document.getElementById('mcp-howto-body');
  const chevron = document.getElementById('mcp-howto-chevron');
  const open    = body.style.display === 'block';
  body.style.display    = open ? 'none' : 'block';
  chevron.style.transform = open ? '' : 'rotate(180deg)';
}

function toggleMcpAddForm() {
  const section = document.getElementById('mcp-add-section');
  const visible = section.style.display !== 'none';
  section.style.display = visible ? 'none' : 'block';
  if (!visible) {
    renderNewAgentScopes();
    document.getElementById('mcp-agent-name').focus();
    document.getElementById('mcp-setup-instructions').style.display = 'none';
  }
}

async function addMcpAgent() {
  const name = document.getElementById('mcp-agent-name').value.trim();
  if (!name) { document.getElementById('mcp-agent-name').focus(); return; }

  const scopes = MCP_SCOPES
    .filter(s => document.getElementById(`new-scope-${s.key}`)?.checked)
    .map(s => s.key);

  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Generating…';

  try {
    const googleToken = sessionStorage.getItem('fm_google_token') || '';
    const res  = await fetch('/api/mcp/agents/create', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body:    JSON.stringify({ client_id: clientCtx.slug, name, scopes }),
    });
    const data = res.ok ? await res.json() : null;

    if (data?.token && data?.mcp_server_url) {
      showSetupInstructions(name, data.mcp_server_url, data.token, scopes);
      document.getElementById('mcp-agent-name').value = '';
      document.getElementById('mcp-add-section').style.display = 'none';
      await loadMcp();
    } else {
      alert('Could not create agent token — try again.');
    }
  } catch { alert('Could not create agent token — try again.'); }

  btn.disabled = false; btn.textContent = 'Generate setup instructions';
}

function showSetupInstructions(agentName, mcpUrl, token, scopes) {
  const isRuntime = (clientCtx.plan || '').toLowerCase() === 'runtime';

  // Build human-readable setup instructions usable in any AI agent
  const scopeLines = scopes.length
    ? `Permitted operations: ${scopes.join(', ')}`
    : 'Read-only access';

  const instructions = [
    `# Formaut MCP Setup — ${agentName}`,
    ``,
    `Connect this agent to ${clientCtx.name || 'your Formaut site'} using the following:`,
    ``,
    `MCP Server URL: ${mcpUrl}`,
    `Access Token:   ${token}`,
    `Client:         ${clientCtx.slug}`,
    `${scopeLines}`,
    ``,
    `--- For Claude ---`,
    `Add to your MCP settings:`,
    `  Server URL: ${mcpUrl}`,
    `  Token: ${token}`,
    ``,
    `--- For Cursor ---`,
    `Add to .cursor/mcp.json:`,
    `{`,
    `  "mcpServers": {`,
    `    "formaut": {`,
    `      "url": "${mcpUrl}",`,
    `      "headers": { "Authorization": "Bearer ${token}" }`,
    `    }`,
    `  }`,
    `}`,
    ``,
    `--- For any MCP-compatible agent ---`,
    `Server: ${mcpUrl}`,
    `Auth header: Authorization: Bearer ${token}`,
    ``,
    `Keep this token private. It won't be shown again.`,
    isRuntime ? `\nRaw token for config files: ${token}` : '',
  ].filter(line => line !== undefined).join('\n').trim();

  const box = document.getElementById('mcp-setup-instructions');
  document.getElementById('mcp-setup-text').textContent = instructions;
  box.style.display = 'block';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function copySetupInstructions() {
  const text = document.getElementById('mcp-setup-text').textContent;
  navigator.clipboard.writeText(text).catch(() => {});
}

function dismissSetupInstructions() {
  document.getElementById('mcp-setup-instructions').style.display = 'none';
}

function copyMcpUrl() {
  const url = document.getElementById('mcp-server-url').textContent;
  if (url && url !== '—') navigator.clipboard.writeText(url).catch(() => {});
}

async function revokeMcpAgent(agentId, agentName) {
  if (!confirm(`Remove "${agentName}"? It will immediately lose access to your site.`)) return;

  const googleToken = sessionStorage.getItem('fm_google_token') || '';
  try {
    await fetch('/api/mcp/revoke', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body:    JSON.stringify({ client_id: clientCtx.slug, agent_id: agentId }),
    });
    await loadMcp();
  } catch { alert('Could not revoke agent — try again.'); }
}

async function saveMcpScopes() {
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const googleToken = sessionStorage.getItem('fm_google_token') || '';
    await fetch('/api/mcp/scopes', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body:    JSON.stringify({ client_id: clientCtx.slug, scopes: mcpDefaultScopes }),
    });
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = 'Save defaults'; btn.disabled = false; }, 2000);
  } catch {
    btn.textContent = 'Error — try again';
    btn.disabled = false;
  }
}

// =============================================================================
// CLIENT AGENT HEALTH PANEL
// Operator-facing. Shows all registered client agent runtimes, their status,
// last heartbeat, and recent events. No AI calls — purely reads from the
// platform worker's client_agent_runtimes + client_agent_events tables.
// =============================================================================

async function loadClientAgentHealth() {
  const container = document.getElementById('client-agent-health-list');
  if (!container) return;

  container.innerHTML = '<div style="color:var(--muted);font-size:13px;">Loading agent runtimes…</div>';

  const googleToken = sessionStorage.getItem('fm_google_token') || '';
  try {
    const res  = await fetch('/api/client-agent/runtimes', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body:    JSON.stringify({ limit: 100 }),
    });
    const data = await res.json();
    if (!data.ok || !data.runtimes?.length) {
      container.innerHTML = '<div style="color:var(--muted);font-size:13px;">No agent runtimes registered yet.</div>';
      renderAgentSummaryBadge(data.summary || {});
      return;
    }
    renderAgentSummaryBadge(data.summary || {});
    container.innerHTML = data.runtimes.map(renderAgentRuntimeRow).join('');
  } catch {
    container.innerHTML = '<div style="color:var(--ember);font-size:13px;">Could not load agent runtimes.</div>';
  }
}

function renderAgentSummaryBadge(summary) {
  const el = document.getElementById('client-agent-summary-badge');
  if (!el) return;
  const { healthy = 0, warn = 0, attention = 0, stale = 0, disabled = 0 } = summary;
  const total = healthy + warn + attention + stale + disabled;
  const hasIssues = (attention + stale) > 0;
  el.textContent  = `${total} registered · ${healthy} healthy · ${attention + stale} need attention`;
  el.style.color  = hasIssues ? 'var(--ember)' : 'var(--muted)';
}

function renderAgentRuntimeRow(runtime) {
  const statusColor = {
    healthy:    'var(--sage)',
    warn:       '#f0b429',
    attention:  'var(--ember)',
    stale:      '#aaa',
    disabled:   '#888',
    registered: 'var(--muted)',
  }[runtime.status] || 'var(--muted)';

  const lastSeen = runtime.last_seen_at
    ? relativeTime(runtime.last_seen_at)
    : 'never';

  const caps = (runtime.capabilities || []).join(', ') || '—';

  return `
    <div style="border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:10px;background:var(--surface);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="font-weight:600;font-size:14px;">${esc(runtime.client_slug)}</div>
        <span style="font-size:12px;font-weight:600;color:${statusColor};background:${statusColor}18;
                     padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;">
          ${esc(runtime.status)}
        </span>
      </div>
      <div style="font-size:12px;color:var(--muted);display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;">
        <span>Last seen: ${esc(lastSeen)}</span>
        <span>Version: ${esc(runtime.agent_version || '—')}</span>
        <span>Mode: ${esc(runtime.runtime_mode || '—')}</span>
        <span>Schema: ${esc(runtime.schema_version || '—')}</span>
        <span style="grid-column:1/-1;">Capabilities: ${esc(caps)}</span>
      </div>
      ${runtime.status === 'attention' || runtime.status === 'stale' ? `
        <div style="margin-top:10px;display:flex;gap:8px;">
          <button onclick="loadAgentEvents('${esc(runtime.client_slug)}')"
            style="font-size:12px;padding:4px 10px;border:1px solid var(--border);border-radius:5px;background:none;color:var(--text);cursor:pointer;">
            View events
          </button>
          <button onclick="deactivateAgent('${esc(runtime.client_slug)}')"
            style="font-size:12px;padding:4px 10px;border:1px solid var(--ember);border-radius:5px;background:none;color:var(--ember);cursor:pointer;">
            Deactivate
          </button>
        </div>` : ''}
    </div>`;
}

async function loadAgentEvents(slug) {
  const modal = document.getElementById('agent-events-modal');
  const body  = document.getElementById('agent-events-body');
  if (!modal || !body) return;

  body.innerHTML = '<div style="color:var(--muted);font-size:13px;">Loading…</div>';
  modal.style.display = 'flex';

  const googleToken = sessionStorage.getItem('fm_google_token') || '';
  try {
    const res  = await fetch('/api/client-agent/events', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body:    JSON.stringify({ client_slug: slug, limit: 30 }),
    });
    const data = await res.json();
    if (!data.ok || !data.events?.length) {
      body.innerHTML = '<div style="color:var(--muted);font-size:13px;">No events found.</div>';
      return;
    }
    body.innerHTML = data.events.map(e => `
      <div style="border-bottom:1px solid var(--border);padding:8px 0;font-size:12px;">
        <div style="display:flex;justify-content:space-between;">
          <strong>${esc(e.event_type)}</strong>
          <span style="color:var(--muted);">${esc(relativeTime(e.received_at))}</span>
        </div>
        <div style="color:${e.severity === 'critical' ? 'var(--ember)' : e.severity === 'warn' ? '#f0b429' : 'var(--muted)'};">
          ${esc(e.severity)} · v${esc(e.agent_version || '?')}
        </div>
      </div>`).join('');
  } catch {
    body.innerHTML = '<div style="color:var(--ember);font-size:13px;">Could not load events.</div>';
  }
}

function closeAgentEventsModal() {
  const modal = document.getElementById('agent-events-modal');
  if (modal) modal.style.display = 'none';
}

async function deactivateAgent(slug) {
  if (!confirm(`Deactivate agent for "${slug}"? It will stop accepting heartbeats.`)) return;
  const googleToken = sessionStorage.getItem('fm_google_token') || '';
  try {
    const res  = await fetch('/api/client-agent/deactivate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body:    JSON.stringify({ client_slug: slug }),
    });
    const data = await res.json();
    if (data.ok) await loadClientAgentHealth();
    else alert('Could not deactivate — try again.');
  } catch { alert('Could not deactivate — try again.'); }
}

function relativeTime(iso) {
  if (!iso) return '—';
  const diff = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

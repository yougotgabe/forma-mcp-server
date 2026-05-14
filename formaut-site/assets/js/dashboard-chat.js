/* Extracted from dashboard.html. Loaded as an ordered classic script. */
function maybeShowConnectionArtifact(userMessage) {
      const msg = (userMessage || '').toLowerCase();
      if (msg.includes('printify') || msg.includes('merch') || msg.includes('shirt') || msg.includes('product') || msg.includes('sell')) {
        appendConnectionArtifact('printify');
      } else if (msg.includes('payment') || msg.includes('checkout') || msg.includes('stripe')) {
        appendConnectionArtifact('stripe');
      } else if (msg.includes('email list') || msg.includes('newsletter') || msg.includes('mailchimp')) {
        appendConnectionArtifact('mailchimp');
      } else if (msg.includes('booking') || msg.includes('appointment') || msg.includes('calendar')) {
        appendConnectionArtifact('google');
      }
    }

    // ── Client context (loaded from platform API at session start) ────────────
    // In production this comes from /api/session endpoint on the platform Worker.
    // The Worker injects Tier 1 (flat client record) + Tier 2 (last 5 session summaries).
    // For now, reading from sessionStorage so we can wire the real API later
    // without changing this file at all.
    const clientCtx = {
      name:         sessionStorage.getItem('fm_client_name')     || 'Your Business',
      slug:         sessionStorage.getItem('fm_client_slug')     || '',
      live_url:     sessionStorage.getItem('fm_live_url')        || '',
      pages_url:    sessionStorage.getItem('fm_pages_url')       || '',
      plan:         sessionStorage.getItem('fm_plan')            || 'Standard',
      admin_email:  sessionStorage.getItem('fm_admin_email')     || '',
      status:       sessionStorage.getItem('fm_status')          || 'live',
      // Tier 2 session summaries injected alongside
      recent_sessions: JSON.parse(sessionStorage.getItem('fm_recent_sessions') || '[]'),
    };

    // ── Init ──────────────────────────────────────────────────────────────────
    function init() {
      // Plan badge
      document.getElementById('plan-badge').textContent = clientCtx.plan;

      // Avatar initial
      const initial = (clientCtx.admin_email || clientCtx.name || 'G')[0].toUpperCase();
      document.getElementById('topbar-avatar').textContent = initial;

      // Live URL in topbar
      if (clientCtx.live_url) {
        const urlLink = document.getElementById('site-url-link');
        const urlText = document.getElementById('site-url-text');
        urlLink.href = 'https://' + clientCtx.live_url.replace(/^https?:\/\//, '');
        urlText.textContent = clientCtx.live_url.replace(/^https?:\/\//, '');
      }

      // Status
      if (clientCtx.status === 'building') {
        const pill = document.querySelector('.status-pill');
        pill.classList.remove('live');
        pill.classList.add('building');
        pill.innerHTML = '<span class="status-dot"></span> Building…';
      }

      // Admin panel link
      const adminBtn = document.querySelector('.sidebar-btn:nth-child(3)');
      if (clientCtx.pages_url) {
        adminBtn.onclick = () => window.open('https://' + clientCtx.pages_url.replace(/^https?:\/\//, '') + '/admin', '_blank');
      }

      // Populate recent sessions from Tier 2 memory
      if (clientCtx.recent_sessions.length > 0) {
        renderSessionList(clientCtx.recent_sessions);
      }
    }

    function renderSessionList(sessions) {
      const list = document.getElementById('session-list');
      list.innerHTML = sessions.map((s, i) => `
        <button class="session-item" onclick="loadSession('${s.id}')">
          <span class="session-item-title">${escHtml(s.summary || 'Session ' + (i + 1))}</span>
          <span class="session-item-date">${formatDate(s.created_at)}</span>
        </button>
      `).join('');
    }

    // ── Sending a message ─────────────────────────────────────────────────────
    async function sendMessage() {
      const input = document.getElementById('chat-input');
      let text = input.value.trim();

      // File attachment: prepend intent context to message
      let filePayload = null;
      if (pendingFile) {
        const intentLabel = fileIntent === 'implement'
          ? 'I want this implemented on my site.'
          : 'This is for reference only — do not add it to my site.';
        const fileNote = `[Attached: ${pendingFile.name}] ${intentLabel}`;
        text = text ? `${text}\n\n${fileNote}` : fileNote;
        // Convert to base64 synchronously via FileReader promise
        try {
          const base64 = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result.split(',')[1]);
            r.onerror = reject;
            r.readAsDataURL(pendingFile);
          });
          filePayload = { file_name: pendingFile.name, file_type: pendingFile.type, file_data: base64, file_intent: fileIntent };
        } catch {}
        clearPendingFile();
      }

      if (!text || isWaiting) return;

      // Switch from welcome state to thread
      showThread();

      // Add user message
      appendMessage('user', text);
      input.value = '';
      input.style.height = 'auto';
      conversationHistory.push({ role: 'user', content: text });
      maybeShowConnectionArtifact(text);

      // Show typing indicator
      const typingId = appendTyping();
      isWaiting = true;
      document.getElementById('send-btn').disabled = true;
      document.getElementById('input-hint').textContent = 'Thinking…';

      try {
        const data = await callAgent(text, filePayload ? { attachment: filePayload } : {});
        removeTyping(typingId);

        // Show tool call activity if any
        if (data.tool_calls && data.tool_calls.length > 0) {
          appendToolActivity(data.tool_calls);
        }

        // Show preview panel if agent generated a preview
        if (data.preview_srcdoc || data.preview_url || data.preview_branch) {
          openPreview(data);
        }

        // Show confirmation prompt if agent needs approval before acting
        if (data.pending_confirmation) {
          appendConfirmation(data.pending_confirmation, data.response);
          // Don't push to history yet — wait for confirmation
        } else {
          if (data.response) {
            appendMessage('agent', data.response);
            conversationHistory.push({ role: 'assistant', content: data.response });
          }
        }
      } catch (err) {
        removeTyping(typingId);
        appendMessage('agent', 'Something went wrong — please try again in a moment.');
      } finally {
        isWaiting = false;
        document.getElementById('send-btn').disabled = false;
        document.getElementById('input-hint').textContent = '↵ Send';
      }
    }

    // ── API call to Claude via platform Worker ────────────────────────────────
    // In production this hits /api/chat on a Cloudflare Pages Function
    // that proxies to Anthropic, injects the system prompt (Tier 1 + 2 context),
    // and handles session tracking.
    // The client never holds an Anthropic API key.
    async function callAgent(userMessage, extraArgs = {}) {
      const googleToken = sessionStorage.getItem('fm_google_token') || '';
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${googleToken}`,
        },
        body: JSON.stringify({
          message:         userMessage,
          history:         conversationHistory,
          client_id:       clientCtx.slug,
          session_id:      sessionId,
          session_context: sessionContext,
          chat_mode:       'general',
          ...extraArgs,
        }),
      });

      if (!res.ok) throw new Error('API error ' + res.status);
      const data = await res.json();

      // Capture session ID and context from first turn response
      if (data.session_id && !sessionId)           sessionId     = data.session_id;
      if (data.session_context && !sessionContext) sessionContext = data.session_context;

      return data; // return full data object — caller handles tool_calls and confirmations
    }

    // ── Tool activity display ─────────────────────────────────────────────────
    const TOOL_LABELS = {
      read_file:            'Reading file',
      list_files:           'Listing files',
      edit_file:            'Editing file',
      create_file:          'Creating file',
      trigger_deploy:       'Deploying',
      check_deploy_status:  'Checking deploy',
      run_query:            'Querying database',
      run_write_query:      'Writing to database',
      preview_srcdoc:       'Generating preview',
      preview_branch_deploy:'Building preview branch',
      get_preview_url:      'Checking preview build',
    };

    // ── Preview panel state ───────────────────────────────────────────────────
    let previewState = null; // { mode: 'srcdoc'|'branch', html, url, branch, path, pendingCommit }
    let previewPollTimer = null;

    function openPreview(data) {
      const panel = document.getElementById('preview-panel');
      const wrap  = document.getElementById('preview-frame-wrap');
      const badge = document.getElementById('preview-mode-badge');
      const openBtn = document.getElementById('preview-open-tab-btn');
      const approveBtn = document.getElementById('preview-approve-btn');

      panel.classList.add('open');

      if (data.preview_srcdoc) {
        // Instant inline srcdoc preview
        previewState = { mode: 'srcdoc', html: data.preview_srcdoc, path: data._previewPath };
        badge.textContent = 'Instant';
        badge.className = 'preview-mode-badge srcdoc';
        openBtn.style.display = 'none';
        approveBtn.style.display = 'block';
        wrap.innerHTML = '<iframe class="preview-frame" id="preview-iframe" sandbox="allow-same-origin allow-scripts"></iframe>';
        const iframe = document.getElementById('preview-iframe');
        iframe.srcdoc = data.preview_srcdoc;

      } else if (data.preview_url) {
        // Branch preview already built
        previewState = { mode: 'branch', url: data.preview_url, branch: data.preview_branch };
        badge.textContent = 'Live preview';
        badge.className = 'preview-mode-badge branch';
        openBtn.style.display = 'block';
        approveBtn.style.display = 'block';
        wrap.innerHTML = `<iframe class="preview-frame" src="${data.preview_url}" sandbox="allow-same-origin allow-scripts allow-forms"></iframe>`;

      } else if (data.preview_branch) {
        // Branch pushed but still building
        previewState = { mode: 'branch', branch: data.preview_branch, url: null };
        badge.textContent = 'Building…';
        badge.className = 'preview-mode-badge building';
        openBtn.style.display = 'none';
        approveBtn.style.display = 'none';
        wrap.innerHTML = `
          <div class="preview-building">
            <div class="preview-building-dots"><span></span><span></span><span></span></div>
            <div class="preview-building-text">Building your preview…</div>
            <div class="preview-building-url">Branch: ${data.preview_branch}</div>
          </div>`;
        // Start polling
        pollPreviewBranch(data.preview_branch);
      }
    }

    function pollPreviewBranch(branch) {
      if (previewPollTimer) clearInterval(previewPollTimer);
      let attempts = 0;
      const MAX_ATTEMPTS = 24; // 2 minutes

      previewPollTimer = setInterval(async () => {
        attempts++;
        if (attempts > MAX_ATTEMPTS) {
          clearInterval(previewPollTimer);
          document.getElementById('preview-frame-wrap').innerHTML =
            '<div class="preview-building"><div class="preview-building-text" style="color:var(--ember);">Build timed out — check Cloudflare Pages dashboard.</div></div>';
          return;
        }

        try {
          const googleToken = sessionStorage.getItem('fm_google_token') || '';
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
            body: JSON.stringify({
              message:    `Check preview build status for branch: ${branch}`,
              history:    [],
              client_id:  clientCtx.slug,
              session_id: sessionId,
              session_context: sessionContext,
              _poll_preview: true, // hint to system prompt this is a status poll
            }),
          });
          const data = await res.json();
          if (data.preview_url) {
            clearInterval(previewPollTimer);
            previewState.url = data.preview_url;

            const wrap  = document.getElementById('preview-frame-wrap');
            const badge = document.getElementById('preview-mode-badge');
            const openBtn = document.getElementById('preview-open-tab-btn');
            const approveBtn = document.getElementById('preview-approve-btn');

            badge.textContent = 'Live preview';
            badge.className = 'preview-mode-badge branch';
            openBtn.style.display = 'block';
            approveBtn.style.display = 'block';
            wrap.innerHTML = `<iframe class="preview-frame" src="${data.preview_url}" sandbox="allow-same-origin allow-scripts allow-forms"></iframe>`;

            appendMessage('agent', `Preview is ready — take a look and let me know if it looks right, or if you'd like any changes.`);
          }
        } catch {
          // Poll failed — try again next tick
        }
      }, 5000);
    }

    function closePreview() {
      const panel = document.getElementById('preview-panel');
      panel.classList.remove('open');
      if (previewPollTimer) clearInterval(previewPollTimer);
      previewState = null;
      document.getElementById('preview-frame-wrap').innerHTML = '';
    }

    function openPreviewTab() {
      if (previewState?.url) window.open(previewState.url, '_blank');
    }

    async function approvePreview() {
      closePreview();
      // Send approval message — agent will now commit to main and deploy
      const input = document.getElementById('chat-input');
      const approvalMsg = "Looks good — commit it to the live site.";
      input.value = approvalMsg;
      await sendMessage();
    }

    function appendToolActivity(toolCalls) {
      const thread = document.getElementById('message-thread');
      const row = document.createElement('div');
      row.className = 'msg-row agent';
      const items = toolCalls.map(t => {
        const label = TOOL_LABELS[t.tool] || t.tool;
        const detail = t.args?.path || t.args?.query?.slice(0, 60) || '';
        return `<div class="tool-step">
          <span class="tool-step-icon">✓</span>
          <span class="tool-step-label">${label}${detail ? ` — <code>${escHtml(detail)}</code>` : ''}</span>
        </div>`;
      }).join('');
      row.innerHTML = `<div class="msg-bubble tool-activity">${items}</div>`;
      thread.appendChild(row);
      thread.scrollTop = thread.scrollHeight;
    }

    // ── Confirmation prompt ───────────────────────────────────────────────────
    function appendConfirmation(confirmation, agentText) {
      const thread = document.getElementById('message-thread');

      // Show agent's message first if any
      if (agentText) {
        appendMessage('agent', agentText);
      }

      const row = document.createElement('div');
      row.className = 'msg-row agent';
      row.id = 'confirm-row';
      row.innerHTML = `
        <div class="msg-bubble confirm-prompt">
          <div class="confirm-message">${escHtml(confirmation.message)}</div>
          <div class="confirm-actions">
            <button class="confirm-btn yes" onclick="confirmAction(true)">Yes, go ahead</button>
            <button class="confirm-btn no"  onclick="confirmAction(false)">Cancel</button>
          </div>
        </div>`;
      thread.appendChild(row);
      thread.scrollTop = thread.scrollHeight;

      // Store pending confirmation so confirmAction can use it
      window._pendingConfirmation = confirmation;
    }

    async function confirmAction(approved) {
      const conf = window._pendingConfirmation;
      window._pendingConfirmation = null;

      // Remove the confirmation row
      const row = document.getElementById('confirm-row');
      if (row) row.remove();

      if (!approved) {
        appendMessage('agent', 'Understood — I won\'t make that change.');
        conversationHistory.push({ role: 'assistant', content: 'Understood — I won\'t make that change.' });
        return;
      }

      // Re-send with confirmed flag injected into the message
      const typingId = appendTyping();
      isWaiting = true;
      document.getElementById('send-btn').disabled = true;
      document.getElementById('input-hint').textContent = 'Working…';

      try {
        // Send "confirmed" as the user message so Claude knows to proceed
        const confirmMsg = 'Yes, confirmed — go ahead.';
        appendMessage('user', confirmMsg);
        conversationHistory.push({ role: 'user', content: confirmMsg });

        const data = await callAgent(confirmMsg);
        removeTyping(typingId);

        if (data.tool_calls && data.tool_calls.length > 0) {
          appendToolActivity(data.tool_calls);
        }
        if (data.pending_confirmation) {
          appendConfirmation(data.pending_confirmation, data.response);
        } else if (data.response) {
          appendMessage('agent', data.response);
          conversationHistory.push({ role: 'assistant', content: data.response });
        }
      } catch (err) {
        removeTyping(typingId);
        appendMessage('agent', 'Something went wrong — please try again.');
      } finally {
        isWaiting = false;
        document.getElementById('send-btn').disabled = false;
        document.getElementById('input-hint').textContent = '\u21b5 Send';
      }
    }

    // ── DOM helpers ───────────────────────────────────────────────────────────
    function showThread() {
      document.getElementById('connections-panel').classList.remove('active');
      document.getElementById('jobs-panel')?.classList.remove('active');
      document.querySelector('.input-area').style.display = 'block';
      document.getElementById('welcome-state').style.display = 'none';
      document.getElementById('message-thread').style.display = 'flex';
    }

    function appendMessage(role, text) {
      const thread = document.getElementById('message-thread');

      if (role === 'user') {
        const row = document.createElement('div');
        row.className = 'msg-row user';
        row.innerHTML = `<div class="msg-bubble">${escHtml(text)}</div>`;
        thread.appendChild(row);
      } else {
        const row = document.createElement('div');
        row.className = 'msg-row agent';
        row.innerHTML = `
          <div class="msg-agent-inner">
            <div class="agent-avatar">F</div>
            <div class="agent-content">${renderMarkdown(text)}</div>
          </div>`;
        thread.appendChild(row);
      }

      thread.scrollTop = thread.scrollHeight;
    }

    function appendTyping() {
      const thread = document.getElementById('message-thread');
      const id = 'typing-' + Date.now();
      const row = document.createElement('div');
      row.className = 'msg-row agent';
      row.id = id;
      row.innerHTML = `
        <div class="msg-agent-inner">
          <div class="agent-avatar">F</div>
          <div class="agent-content">
            <div class="typing-indicator">
              <span></span><span></span><span></span>
            </div>
          </div>
        </div>`;
      thread.appendChild(row);
      thread.scrollTop = thread.scrollHeight;
      return id;
    }

    function removeTyping(id) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }

    // Minimal markdown: bold, code inline, line breaks
    function renderMarkdown(text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code style="font-family:var(--f-mono);font-size:0.85em;background:var(--ash);padding:0.1em 0.35em;border-radius:3px;">$1</code>')
        .replace(/\n/g, '<br>');
    }

    function escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      const now = new Date();
      const diff = now - d;
      if (diff < 86400000 && d.getDate() === now.getDate()) return 'Today';
      if (diff < 172800000) return 'Yesterday';
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    // ── Input helpers ─────────────────────────────────────────────────────────
    function fillInput(text) {
      const input = document.getElementById('chat-input');
      input.value = text;
      input.focus();
      autoResize(input);
    }

    function autoResize(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 180) + 'px';
    }

    document.getElementById('chat-input').addEventListener('input', function() {
      autoResize(this);
    });

    document.getElementById('chat-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // ── Sidebar ───────────────────────────────────────────────────────────────
    function toggleSidebar() {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('overlay');
      sidebar.classList.toggle('open');
      overlay.classList.toggle('show');
    }

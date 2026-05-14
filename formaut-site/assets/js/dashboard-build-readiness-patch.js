// dashboard-build-readiness-patch.js
// PATCH for formaut-site/assets/js/dashboard-build.js
//
// Replace the existing triggerSiteBuild() function and initBuildTrigger() with
// these readiness-aware versions. Everything else in dashboard-build.js stays.
//
// WHAT CHANGES:
//   - triggerSiteBuild() now checks /api/profile/readiness before queuing jobs
//   - initBuildTrigger() shows contextual UI based on readiness state (not just binary)
//   - New function: renderReadinessBlockers() for showing what's missing
// =============================================================================

// ── Build trigger — readiness-aware ───────────────────────────────────────────

async function triggerSiteBuild(trigger = 'manual') {
  const googleToken = sessionStorage.getItem('fm_google_token') || '';
  const slug = clientCtx.slug;
  if (!slug) { alert('No client loaded — reload the dashboard.'); return; }

  const btn = document.getElementById('build-site-btn');
  const statusEl = document.getElementById('build-trigger-status');

  // ── Readiness gate ──
  if (btn) btn.disabled = true;
  if (statusEl) { statusEl.textContent = 'Checking readiness…'; statusEl.style.display = 'block'; }

  try {
    const readinessRes = await fetch('/api/profile/readiness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body: JSON.stringify({ slug }),
    });
    const readinessData = await readinessRes.json();
    const readiness = readinessData.readiness;

    if (!readiness?.ready) {
      // Not ready — show blockers, re-enable button so they can fix and retry
      if (btn) btn.disabled = false;
      if (statusEl) { statusEl.textContent = ''; statusEl.style.display = 'none'; }

      // Show blockers inline
      renderReadinessBlockers(readiness);
      return;
    }

    // ── All clear — proceed to queue ──
    if (statusEl) statusEl.textContent = 'Queuing jobs…';

    const homepageRes = await fetch('/api/jobs/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body: JSON.stringify({
        client_slug: slug,
        job_type: 'generate_homepage',
        priority: 80,
        created_by: 'dashboard_build_trigger',
        payload: {
          trigger,
          requires_review_before_publish: true,
          business_type: readiness.business_type,
        },
      }),
    });
    const homepageData = await homepageRes.json();
    if (!homepageRes.ok) throw new Error(homepageData.error || 'Could not queue homepage job');

    // Queue SEO (fire and forget)
    fetch('/api/jobs/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body: JSON.stringify({
        client_slug: slug,
        job_type: 'generate_seo',
        priority: 70,
        created_by: 'dashboard_build_trigger',
        payload: { trigger, business_type: readiness.business_type },
      }),
    }).catch(() => {});

    const jobId = homepageData.job?.id || null;
    if (statusEl) statusEl.textContent = 'Building your site — this takes about 30 seconds…';

    setView('jobs');
    if (jobId) pollBuildJobUntilDone(jobId, googleToken);

  } catch (err) {
    if (btn) btn.disabled = false;
    if (statusEl) { statusEl.textContent = ''; statusEl.style.display = 'none'; }
    alert(err.message || 'Could not start build.');
  }
}

// ── Render readiness blockers ──────────────────────────────────────────────────

function renderReadinessBlockers(readiness) {
  const card = document.getElementById('build-site-card');
  if (!card) return;

  let blockersHtml = '';
  if (readiness?.blockers?.length) {
    blockersHtml = readiness.blockers.map(b => `
      <div style="background:rgba(232,93,38,0.07);border:1px solid rgba(232,93,38,0.25);border-radius:5px;padding:10px 14px;margin-bottom:8px;font-size:0.83rem;line-height:1.5;color:var(--fog,#8a8a82)">
        <strong style="color:var(--ember,#E85D26)">${escHtml(b.label)}</strong><br>
        ${escHtml(b.message)}
        ${b.type === 'infrastructure_missing' ? `<br><a href="/onboarding.html" style="color:var(--ember,#E85D26);text-decoration:none;font-weight:500">→ Connect accounts</a>` : ''}
      </div>`).join('');
  }

  const nextQ = readiness?.next_question;
  const existingBlockers = document.getElementById('build-readiness-blockers');
  if (existingBlockers) existingBlockers.remove();

  const el = document.createElement('div');
  el.id = 'build-readiness-blockers';
  el.style.marginTop = '12px';
  el.innerHTML = blockersHtml + (nextQ
    ? `<div style="font-size:0.83rem;color:var(--fog,#8a8a82);margin-top:8px">💬 <em>${escHtml(nextQ)}</em> — tell Formaut in chat.</div>`
    : '');

  const actionsDiv = card.querySelector('.build-actions') || card.querySelector('button')?.parentElement;
  if (actionsDiv) actionsDiv.appendChild(el);
  else card.appendChild(el);
}

// ── Readiness-aware initBuildTrigger ──────────────────────────────────────────

async function initBuildTrigger() {
  const googleToken = sessionStorage.getItem('fm_google_token') || '';
  if (!clientCtx.slug) return;

  try {
    // Check if there are any published versions already
    const versionsRes = await fetch('/api/artifacts/versions/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body: JSON.stringify({ client_slug: clientCtx.slug, status: 'published', limit: 1 }),
    });
    const versionsData = await versionsRes.json();
    const hasPublished = (versionsData.artifact_versions || []).length > 0;
    if (hasPublished) return; // Already has a site

    // Fetch readiness report
    const readinessRes = await fetch('/api/profile/readiness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body: JSON.stringify({ slug: clientCtx.slug }),
    });
    const readinessData = await readinessRes.json();
    const readiness = readinessData.readiness;
    const ui = readinessData.ui;

    // Don't show anything if there's no profile at all (score 0)
    if (!readiness || readiness.profile_score < 15) return;

    const suggestions = document.querySelector('.suggestions');
    if (!suggestions) return;

    const ready = readiness.ready;
    const showBuildBtn = ui?.show_build_button ?? ready;

    const buildCard = document.createElement('div');
    buildCard.id = 'build-site-card';
    buildCard.className = 'build-actions';
    buildCard.style.cssText = `
      margin-top: 1.5rem; padding: 1.25rem 1.5rem;
      background: var(--ash); border: 1px solid var(--wire);
      border-left: 3px solid ${ready ? 'var(--ember)' : 'var(--wire)'};
    `;

    const progress = readiness.profile_score;
    const progressBar = `
      <div style="background:var(--wire,#333);border-radius:2px;height:3px;margin:10px 0 14px">
        <div style="background:var(--ember,#E85D26);width:${progress}%;height:100%;border-radius:2px;transition:width .4s"></div>
      </div>
      <div style="font-size:0.75rem;color:var(--fog,#8a8a82);margin-bottom:12px">Profile ${progress}% complete</div>`;

    if (ready) {
      buildCard.innerHTML = `
        <div style="font-family:var(--f-mono);font-size:0.65rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--ember);margin-bottom:0.5rem;">Ready to build</div>
        <div style="font-size:0.95rem;font-weight:600;color:var(--paper);margin-bottom:0.35rem">Your business profile is set up.</div>
        <div style="font-size:0.85rem;color:var(--fog);margin-bottom:0.8rem;line-height:1.6;">
          Formaut can generate your homepage, SEO metadata, and sitemap. You'll review the draft before anything goes live.
        </div>
        ${progressBar}
        <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
          <button id="build-site-btn" onclick="triggerSiteBuild('manual')"
            style="background:var(--ember);color:var(--paper);border:none;padding:0.65rem 1.5rem;cursor:pointer;font-size:0.875rem;font-weight:500;">
            Build my site
          </button>
          <div id="build-trigger-status" style="font-size:0.8rem;color:var(--fog);display:none;"></div>
        </div>`;
    } else {
      // Partially ready — show what's missing
      const blockerCount = readiness.blockers?.length || 0;
      const primaryBlocker = readiness.blockers?.[0];
      const infraBlocker = readiness.missing_infra?.length > 0;

      buildCard.innerHTML = `
        <div style="font-family:var(--f-mono);font-size:0.65rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--fog);margin-bottom:0.5rem;">Getting ready</div>
        <div style="font-size:0.95rem;font-weight:600;color:var(--paper);margin-bottom:0.35rem">
          ${blockerCount} thing${blockerCount !== 1 ? 's' : ''} to do before building
        </div>
        ${progressBar}
        ${primaryBlocker ? `
          <div style="font-size:0.85rem;color:var(--fog);margin-bottom:12px;line-height:1.5;">
            <strong style="color:var(--ember)">${escHtml(primaryBlocker.label)}</strong><br>
            ${escHtml(primaryBlocker.message)}
          </div>` : ''}
        ${infraBlocker ? `
          <a href="/onboarding.html" style="display:inline-block;background:var(--ember);color:var(--paper);padding:0.5rem 1.2rem;text-decoration:none;font-size:0.85rem;font-weight:500;">
            Connect accounts →
          </a>` : `
          <div style="font-size:0.83rem;color:var(--fog);">
            ${readiness.next_question ? `💬 <em>${escHtml(readiness.next_question)}</em>` : 'Chat with Formaut to fill in the remaining details.'}
          </div>`}`;
    }

    suggestions.parentNode.insertBefore(buildCard, suggestions.nextSibling);

  } catch { /* non-fatal — build trigger is enhancement, not core */ }
}

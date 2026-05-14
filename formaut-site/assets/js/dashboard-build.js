/* dashboard-build.js
 * Loaded as a classic script in dashboard.html (after dashboard-state.js).
 *
 * Adds two capabilities:
 *   1. "Build my site" trigger — queues generate_homepage + generate_seo jobs
 *      from the welcome state and jobs panel, then polls until done.
 *   2. Artifact HTML preview in the reviews panel — renders the generated
 *      HTML artifact in a sandboxed iframe so the operator can see the actual
 *      page before approving/publishing.
 *
 * Depends on: clientCtx (from dashboard-state.js), jobsFetch (from dashboard-jobs-reviews.js)
 */

// ── Build trigger ──────────────────────────────────────────────────────────────

async function triggerSiteBuild(trigger = 'manual') {
  const googleToken = sessionStorage.getItem('fm_google_token') || '';
  const slug = clientCtx.slug;
  if (!slug) { alert('No client loaded — reload the dashboard.'); return; }

  const btn = document.getElementById('build-site-btn');
  const statusEl = document.getElementById('build-trigger-status');
  if (btn) btn.disabled = true;
  if (statusEl) { statusEl.textContent = 'Queuing jobs…'; statusEl.style.display = 'block'; }

  try {
    // Queue homepage generation
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
        },
      }),
    });
    const homepageData = await homepageRes.json();
    if (!homepageRes.ok) throw new Error(homepageData.error || 'Could not queue homepage job');

    // Queue SEO generation
    fetch('/api/jobs/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body: JSON.stringify({
        client_slug: slug,
        job_type: 'generate_seo',
        priority: 70,
        created_by: 'dashboard_build_trigger',
        payload: { trigger },
      }),
    }).catch(() => {});

    const jobId = homepageData.job?.id || null;
    if (statusEl) statusEl.textContent = 'Building your site — this takes about 30 seconds…';

    // Switch to jobs view so they can watch it run
    setView('jobs');

    // Poll until the job completes, then redirect to reviews
    if (jobId) pollBuildJobUntilDone(jobId, googleToken);

  } catch (err) {
    if (btn) btn.disabled = false;
    if (statusEl) { statusEl.textContent = ''; statusEl.style.display = 'none'; }
    alert(err.message || 'Could not start build.');
  }
}

async function pollBuildJobUntilDone(jobId, googleToken) {
  let attempts = 0;
  const MAX = 72; // 6 minutes at 5s intervals

  const timer = setInterval(async () => {
    attempts++;
    if (attempts > MAX) { clearInterval(timer); return; }

    try {
      const res = await fetch('/api/jobs/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
        body: JSON.stringify({ job_id: jobId, client_slug: clientCtx.slug }),
      });
      const data = await res.json();
      const status = data.job?.status || data.status;

      if (status === 'succeeded') {
        clearInterval(timer);
        // Refresh jobs list and switch to reviews
        await loadJobs();
        showBuildCompleteToast();
        setTimeout(() => setView('reviews'), 1500);
      } else if (status === 'failed') {
        clearInterval(timer);
        await loadJobs();
        showBuildFailedToast(data.job?.last_error || 'Build job failed');
      }
    } catch { /* keep polling */ }
  }, 5000);
}

function showBuildCompleteToast() {
  showToast('Site draft ready — review it in the Approval gate.', 'success');
}

function showBuildFailedToast(msg) {
  showToast('Build failed: ' + (msg || 'check the jobs panel for details.'), 'error');
}

function showToast(message, type = 'info') {
  const existing = document.getElementById('fm-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'fm-toast';
  const bg = type === 'success' ? 'var(--green-bg)' : type === 'error' ? 'rgba(255,107,107,0.1)' : 'var(--ash)';
  const border = type === 'success' ? 'var(--green-border)' : type === 'error' ? 'rgba(255,107,107,0.4)' : 'var(--wire)';
  const color = type === 'success' ? 'var(--green)' : type === 'error' ? '#ff6b6b' : 'var(--paper)';
  toast.style.cssText = `
    position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999;
    background: ${bg}; border: 1px solid ${border}; color: ${color};
    font-size: 0.83rem; padding: 0.75rem 1.1rem; max-width: 340px;
    line-height: 1.5; font-family: var(--f-body);
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}


// ── Artifact HTML preview in reviews panel ─────────────────────────────────────
// Called when a review card's "Preview" button is clicked.
// Fetches the artifact version content and renders the HTML in an iframe.

async function previewArtifactVersion(artifactVersionId) {
  const googleToken = sessionStorage.getItem('fm_google_token') || '';

  // Build/show the preview drawer
  let drawer = document.getElementById('artifact-preview-drawer');
  if (!drawer) {
    drawer = document.createElement('div');
    drawer.id = 'artifact-preview-drawer';
    drawer.style.cssText = `
      position: fixed; inset: 0; z-index: 500;
      background: var(--ink); display: flex; flex-direction: column;
    `;
    drawer.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:0.875rem 1.25rem;border-bottom:1px solid var(--wire);flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:1rem;">
          <button onclick="closeArtifactPreview()" style="background:none;border:1px solid var(--wire);color:var(--fog);padding:0.3rem 0.75rem;cursor:pointer;font-size:0.8rem;">← Back</button>
          <div style="font-family:var(--f-mono);font-size:0.72rem;color:var(--fog);letter-spacing:0.06em;text-transform:uppercase;" id="preview-drawer-label">Loading preview…</div>
        </div>
        <div style="display:flex;gap:0.75rem;" id="preview-drawer-actions"></div>
      </div>
      <div style="flex:1;overflow:hidden;position:relative;" id="preview-drawer-body">
        <div id="preview-loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--fog);font-size:0.85rem;">Loading…</div>
        <iframe id="artifact-preview-iframe" sandbox="allow-same-origin allow-scripts"
          style="width:100%;height:100%;border:none;display:none;"></iframe>
      </div>
    `;
    document.body.appendChild(drawer);
  }
  drawer.style.display = 'flex';

  const labelEl   = document.getElementById('preview-drawer-label');
  const actionsEl = document.getElementById('preview-drawer-actions');
  const iframeEl  = document.getElementById('artifact-preview-iframe');
  const loadingEl = document.getElementById('preview-loading');

  labelEl.textContent   = 'Loading preview…';
  actionsEl.innerHTML   = '';
  iframeEl.style.display = 'none';
  loadingEl.style.display = 'flex';

  try {
    // Fetch the artifact version list to find the one with this ID
    const res = await fetch('/api/artifacts/versions/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body: JSON.stringify({ client_slug: clientCtx.slug, limit: 50 }),
    });
    const data = await res.json();
    const versions = data.artifact_versions || [];
    const version = versions.find(v => v.id === artifactVersionId || v.artifact_version_id === artifactVersionId);

    if (!version) throw new Error('Artifact version not found');

    const html = version.content?.html || null;
    const artifactType = version.artifact_type || 'artifact';
    labelEl.textContent = `${artifactType} · v${version.version_number || '?'} · ${version.status || 'pending'}`;

    if (html) {
      iframeEl.srcdoc = html;
      iframeEl.style.display = 'block';
      loadingEl.style.display = 'none';
    } else {
      loadingEl.textContent = 'No HTML preview available for this artifact type.';
    }

    // Action buttons
    const vId = version.id;
    actionsEl.innerHTML = `
      <button onclick="approveAndMaybePublish('${escHtml(vId)}')"
        style="background:var(--ember);color:var(--paper);border:none;padding:0.45rem 1.1rem;cursor:pointer;font-size:0.82rem;font-weight:500;">
        Approve
      </button>
      <button onclick="requestRevisionFromPreview('${escHtml(vId)}')"
        style="background:none;border:1px solid var(--wire);color:var(--fog);padding:0.45rem 0.9rem;cursor:pointer;font-size:0.82rem;">
        Request changes
      </button>
      <button onclick="closeArtifactPreview()"
        style="background:none;border:1px solid var(--wire);color:var(--fog);padding:0.45rem 0.9rem;cursor:pointer;font-size:0.82rem;">
        Close
      </button>
    `;

  } catch (err) {
    loadingEl.textContent = 'Could not load preview: ' + (err.message || 'unknown error');
  }
}

function closeArtifactPreview() {
  const drawer = document.getElementById('artifact-preview-drawer');
  if (drawer) drawer.style.display = 'none';
}

async function approveAndMaybePublish(versionId) {
  closeArtifactPreview();
  // Approve the review
  try {
    await jobsFetch('/api/artifacts/reviews/decide', {
      artifact_version_id: versionId,
      decision: 'approved',
      notes: 'Approved via preview.',
    });
    // Ask if they want to publish immediately
    const publishNow = confirm('Approved. Publish to your live site now?');
    if (publishNow) {
      try {
        const data = await jobsFetch('/api/artifacts/publish', {
          artifact_version_id: versionId,
          reason: 'Published from dashboard approval.',
        });
        if (data.ok) {
          showToast('Published. Your live site is updating.', 'success');
        } else {
          showToast('Artifact approved but publish encountered an issue — retry from the reviews panel.', 'error');
        }
      } catch (err) {
        showToast('Approved, but publish failed: ' + err.message, 'error');
      }
    } else {
      showToast('Approved. Publish it any time from the Approval gate.', 'success');
    }
  } catch (err) {
    showToast('Could not approve: ' + err.message, 'error');
  }
  await loadReviews();
}

async function requestRevisionFromPreview(versionId) {
  closeArtifactPreview();
  const note = prompt('What should Formaut change?');
  if (!note) return;
  try {
    await jobsFetch('/api/artifacts/reviews/decide', {
      artifact_version_id: versionId,
      decision: 'request_changes',
      notes: note,
      enqueue_revision: true,
    });
    showToast('Revision queued. Formaut will regenerate based on your feedback.', 'success');
    await loadReviews();
    await loadJobs();
  } catch (err) {
    showToast('Could not request revision: ' + err.message, 'error');
  }
}

// ── Inject build trigger into welcome state ────────────────────────────────────
// Called once on dashboard boot to add the "Build my site" button if the
// client has a business profile but no published artifact yet.

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

    if (hasPublished) return; // Already has a site — no build trigger needed

    // Check if there's a business profile
    const profileRes = await fetch('/api/business-profile/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
      body: JSON.stringify({ slug: clientCtx.slug }),
    });
    const profileData = await profileRes.json();
    const hasProfile = profileData.business_profile?.profile_confidence >= 0.6;

    if (!hasProfile) return; // No profile yet — build trigger not useful

    // Inject the build trigger card into the welcome state
    const suggestions = document.querySelector('.suggestions');
    if (!suggestions) return;

    const buildCard = document.createElement('div');
    buildCard.id = 'build-site-card';
    buildCard.style.cssText = `
      margin-top: 1.5rem; padding: 1.25rem 1.5rem;
      background: var(--ash); border: 1px solid var(--wire);
      border-left: 3px solid var(--ember);
    `;
    buildCard.innerHTML = `
      <div style="font-family:var(--f-mono);font-size:0.65rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--ember);margin-bottom:0.5rem;">Ready to build</div>
      <div style="font-size:0.95rem;font-weight:600;color:var(--paper);margin-bottom:0.35rem);">Your business profile is set up.</div>
      <div style="font-size:0.85rem;color:var(--fog);margin-bottom:1.1rem;line-height:1.6;">
        Formaut can generate your homepage, SEO metadata, and sitemap now.
        You'll review the draft before anything goes live.
      </div>
      <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
        <button id="build-site-btn" onclick="triggerSiteBuild('manual')"
          style="background:var(--ember);color:var(--paper);border:none;padding:0.65rem 1.5rem;cursor:pointer;font-size:0.875rem;font-weight:500;">
          Build my site
        </button>
        <div id="build-trigger-status" style="font-size:0.8rem;color:var(--fog);display:none;"></div>
      </div>
    `;
    suggestions.parentNode.insertBefore(buildCard, suggestions.nextSibling);

  } catch { /* non-fatal */ }
}

// ── Patch renderReviewCard to add Preview button ───────────────────────────────
// Overrides the base renderReviewCard in dashboard-jobs-reviews.js to inject
// a Preview button that opens the artifact HTML viewer.

const _originalRenderReviewCard = typeof renderReviewCard === 'function' ? renderReviewCard : null;

function renderReviewCard(review) {
  const version = Array.isArray(review.artifact_versions)
    ? review.artifact_versions[0]
    : (review.artifact_versions || {});
  const versionId = review.artifact_version_id || review.version_id || review.id;
  const title = `${version.artifact_type || review.artifact_type || 'Artifact'} v${version.version_number || ''}`.trim();
  const summary = version.diff_summary || review.review_reason || review.decision_reason || '';
  const hasHtml = version.artifact_type === 'homepage' || version.content?.html;

  return `<div class="job-card" id="review-${escHtml(review.id)}">
    <div>
      <div class="job-title">${escHtml(title)}</div>
      <div class="job-meta">${escHtml(review.status || 'pending')} · ${escHtml(formatDate(review.created_at))}</div>
      <div class="job-detail">${escHtml(summary)}</div>
    </div>
    <div class="job-status ${escHtml(review.status || '')}">${escHtml(review.status || 'pending')}</div>
    <div class="job-actions">
      ${hasHtml ? `<button class="small-action-btn primary" onclick="previewArtifactVersion('${escHtml(versionId)}')">Preview</button>` : ''}
      <button class="small-action-btn primary" onclick="decideReview('${escHtml(versionId)}','approved')">Approve</button>
      <button class="small-action-btn" onclick="requestReviewRevision('${escHtml(versionId)}')">Request revision</button>
      <button class="small-action-btn" onclick="decideReview('${escHtml(versionId)}','rejected')">Reject</button>
      <button class="small-action-btn" onclick="checkPublishGate('${escHtml(versionId)}')">Publish</button>
    </div>
    <div class="job-events open" id="review-detail-${escHtml(review.id)}"></div>
  </div>`;
}

function escHtml(str) {
  return String(str == null ? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

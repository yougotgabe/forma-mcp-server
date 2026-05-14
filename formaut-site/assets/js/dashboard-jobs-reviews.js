/* Extracted from dashboard.html. Loaded as an ordered classic script. */
async function jobsFetch(path, payload = {}) {
      const googleToken = sessionStorage.getItem('fm_google_token') || '';
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
        body: JSON.stringify({ slug: clientCtx.slug, client_slug: clientCtx.slug, client_id: clientCtx.slug, ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed ${res.status}`);
      return data;
    }

    async function loadJobs() {
      const list = document.getElementById('jobs-list');
      if (!list) return;
      list.innerHTML = '<div class="job-detail">Loading jobs…</div>';
      try {
        const data = await jobsFetch('/api/jobs/list', { limit: 25 });
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        list.innerHTML = jobs.length ? jobs.map(renderJobCard).join('') : '<div class="job-detail">No jobs yet.</div>';
      } catch (err) {
        list.innerHTML = `<div class="job-detail">Could not load jobs: ${escHtml(err.message || 'request failed')}</div>`;
      }
    }

    function renderJobCard(job) {
      const pct = Math.max(0, Math.min(100, Number(job.progress_percent ?? (job.status === 'succeeded' ? 100 : 0))));
      return `<div class="job-card" id="job-${escHtml(job.id)}">
        <div>
          <div class="job-title">${escHtml(job.job_type || 'job')}</div>
          <div class="job-meta">${escHtml(job.queue || 'default')} · priority ${escHtml(String(job.priority || ''))} · attempts ${escHtml(String(job.attempts || 0))}/${escHtml(String(job.max_attempts || 0))}</div>
          <div class="job-detail">${escHtml(job.progress_stage || job.run_after || '')}</div>
        </div>
        <div class="job-status ${escHtml(job.status || '')}">${escHtml(job.status || 'unknown')}</div>
        <div class="job-progress-track"><div class="job-progress-fill" style="width:${pct}%"></div></div>
        <div class="job-actions">
          <button class="small-action-btn" onclick="loadJobEvents('${escHtml(job.id)}')">Events</button>
          <button class="small-action-btn" onclick="loadJobArtifacts('${escHtml(job.id)}')">Artifacts</button>
        </div>
        <div class="job-events" id="job-events-${escHtml(job.id)}"></div>
      </div>`;
    }

    async function loadJobEvents(jobId) {
      const box = document.getElementById(`job-events-${jobId}`);
      if (!box) return;
      box.classList.toggle('open');
      box.innerHTML = '<div class="job-event">Loading events…</div>';
      try {
        const data = await jobsFetch('/api/jobs/events', { job_id: jobId, limit: 100 });
        box.innerHTML = (data.events || []).map(e => `<div class="job-event">${escHtml(formatDate(e.created_at))} · ${escHtml(e.event_type)} · ${escHtml(e.details?.message || e.details?.stage || '')}</div>`).join('') || '<div class="job-event">No events yet.</div>';
      } catch (err) { box.innerHTML = `<div class="job-event">${escHtml(err.message || 'Could not load events')}</div>`; }
    }

    async function loadJobArtifacts(jobId) {
      const box = document.getElementById(`job-events-${jobId}`);
      if (!box) return;
      box.classList.add('open');
      box.innerHTML = '<div class="job-event">Loading artifacts…</div>';
      try {
        const data = await jobsFetch('/api/jobs/artifacts', { job_id: jobId, limit: 20 });
        box.innerHTML = (data.artifacts || []).map(a => `<div class="job-artifact"><div class="job-title">${escHtml(a.title || a.artifact_type)}</div><div class="job-detail">${escHtml(a.summary || '')}</div><div class="job-actions"><button class="small-action-btn primary" onclick="createReviewFromArtifact('${escHtml(a.id)}')">Send to review</button></div></div>`).join('') || '<div class="job-event">No artifacts yet.</div>';
      } catch (err) { box.innerHTML = `<div class="job-event">${escHtml(err.message || 'Could not load artifacts')}</div>`; }
    }

    async function consumeOneJob() {
      try {
        await jobsFetch('/api/jobs/consume', { queue: 'default', limit: 1, worker_id: 'dashboard-manual' });
        await jobsFetch('/api/jobs/consume', { queue: 'integrations', limit: 1, worker_id: 'dashboard-manual' });
        await jobsFetch('/api/jobs/consume', { queue: 'artifact_generation', limit: 1, worker_id: 'dashboard-manual' });
        loadJobs();
      } catch (err) { alert(err.message || 'Could not run queued job.'); }
    }


    async function createReviewFromArtifact(artifactId) {
      try {
        await jobsFetch('/api/artifacts/versions/create', { artifact_id: artifactId });
        setView('reviews');
        await loadReviews();
      } catch (err) { alert(err.message || 'Could not create review.'); }
    }

    async function loadReviews() {
      const list = document.getElementById('reviews-list');
      if (!list) return;
      list.innerHTML = '<div class="job-detail">Loading reviews…</div>';
      try {
        const data = await jobsFetch('/api/artifacts/reviews/list', { limit: 50 });
        const reviews = Array.isArray(data.reviews) ? data.reviews : [];
        list.innerHTML = reviews.length ? reviews.map(renderReviewCard).join('') : '<div class="job-detail">No staged artifact reviews yet.</div>';
      } catch (err) {
        list.innerHTML = `<div class="job-detail">Could not load reviews: ${escHtml(err.message || 'request failed')}</div>`;
      }
    }

    function renderReviewCard(review) {
      const version = Array.isArray(review.artifact_versions) ? review.artifact_versions[0] : (review.artifact_versions || {});
      const versionId = review.artifact_version_id || review.version_id || review.id;
      const title = `${version.artifact_type || review.artifact_type || 'Artifact'} v${version.version_number || ''}`.trim();
      const summary = version.diff_summary || review.review_reason || review.decision_reason || '';
      return `<div class="job-card" id="review-${escHtml(review.id)}">
        <div>
          <div class="job-title">${escHtml(title)}</div>
          <div class="job-meta">${escHtml(review.status || 'pending')} · ${escHtml(formatDate(review.created_at))}</div>
          <div class="job-detail">${escHtml(summary)}</div>
        </div>
        <div class="job-status ${escHtml(review.status || '')}">${escHtml(review.status || 'pending')}</div>
        <div class="job-actions">
          <button class="small-action-btn primary" onclick="decideReview('${escHtml(versionId)}','approve')">Approve</button>
          <button class="small-action-btn" onclick="requestReviewRevision('${escHtml(versionId)}')">Request revision</button>
          <button class="small-action-btn" onclick="decideReview('${escHtml(versionId)}','reject')">Reject</button>
          <button class="small-action-btn" onclick="checkPublishGate('${escHtml(versionId)}')">Publish</button>
        </div>
        <div class="job-events open" id="review-detail-${escHtml(review.id)}"></div>
      </div>`;
    }

    async function decideReview(reviewId, decision) {
      const note = decision === 'approved' ? 'Approved from dashboard.' : prompt('Decision note?') || '';
      try {
        await jobsFetch('/api/artifacts/reviews/decide', { artifact_version_id: reviewId, decision, notes: note });
        await loadReviews();
      } catch (err) { alert(err.message || 'Could not update review.'); }
    }

    async function requestReviewRevision(reviewId) {
      const note = prompt('What should Formaut revise?');
      if (!note) return;
      try {
        await jobsFetch('/api/artifacts/reviews/decide', { artifact_version_id: reviewId, decision: 'request_changes', notes: note, enqueue_revision: true });
        await loadReviews();
        await loadJobs();
      } catch (err) { alert(err.message || 'Could not request revision.'); }
    }

    async function checkPublishGate(reviewId) {
      try {
        const data = await jobsFetch('/api/artifacts/publish', { artifact_version_id: reviewId, reason: 'Published from dashboard approval gate.' });
        alert(data.ok ? 'Published. Rollback support is now available from version history.' : 'Publish did not complete.');
      } catch (err) { alert(err.message || 'Could not check publish gate.'); }
    }

    async function loadChangeLog() {
      const list = document.getElementById('reviews-list');
      if (!list) return;
      list.innerHTML = '<div class="job-detail">Loading change log…</div>';
      try {
        const data = await jobsFetch('/api/artifacts/change-dashboard', { limit: 50 });
        const changes = data.what_changed_and_why || [];
        list.innerHTML = changes.length ? changes.map(c => `<div class="job-card"><div class="job-title">${escHtml(c.artifact_type || 'artifact')} · ${escHtml(c.event_type || 'change')}</div><div class="job-meta">${escHtml(formatDate(c.at))}</div><div class="job-detail">${escHtml(c.summary || c.why || '')}</div></div>`).join('') : '<div class="job-detail">No changes logged yet.</div>'; 
      } catch (err) { list.innerHTML = `<div class="job-detail">Could not load change log: ${escHtml(err.message || 'request failed')}</div>`; }
    }

    async function loadSnapshots() {
      const list = document.getElementById('reviews-list');
      if (!list) return;
      list.innerHTML = '<div class="job-detail">Loading snapshots…</div>';
      try {
        const data = await jobsFetch('/api/artifacts/versions/list', { status: 'published', limit: 30 });
        const snapshots = data.artifact_versions || [];
        list.innerHTML = snapshots.length ? snapshots.map(s => `<div class="job-card"><div class="job-title">${escHtml(s.artifact_type || 'Artifact')} v${escHtml(String(s.version_number || ''))}</div><div class="job-meta">${escHtml(s.status || '')} · ${escHtml(formatDate(s.published_at || s.created_at))}</div><div class="job-detail">${escHtml(s.diff_summary || s.content_hash || '')}</div><div class="job-actions"><button class="small-action-btn" onclick="requestRollback('${escHtml(s.id)}','${escHtml(s.artifact_type)}')">Rollback to this</button></div></div>`).join('') : '<div class="job-detail">No published versions yet.</div>'; 
      } catch (err) { list.innerHTML = `<div class="job-detail">Could not load snapshots: ${escHtml(err.message || 'request failed')}</div>`; }
    }

    async function requestRollback(snapshotId, artifactType) {
      const reason = prompt('Why roll back to this version?') || 'Rollback requested from dashboard.';
      try {
        await jobsFetch('/api/artifacts/rollback', { target_version_id: snapshotId, artifact_type: artifactType, reason });
        await loadChangeLog();
      } catch (err) { alert(err.message || 'Could not request rollback.'); }
    }

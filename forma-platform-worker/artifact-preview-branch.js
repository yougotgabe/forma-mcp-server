// =============================================================================
// FORMAUT — ARTIFACT PREVIEW BRANCH AUTO-DEPLOY
// =============================================================================
// When an artifact version enters 'pending_review', this module automatically:
//   1. Pushes the artifact HTML to a preview branch in the client's GitHub repo
//   2. Stores the preview URL on the artifact_version record
//   3. Returns the preview URL so it can be shown in the dashboard review card
//
// The preview branch mechanism already exists as an MCP tool
// (preview_branch_deploy in index.js handleExecuteTool). This module wraps the
// same GitHub API calls as a standalone function callable from:
//   - formaut-artifact-pipeline.js (inside createArtifactVersion, after status
//     is set to 'pending_review')
//   - The /artifacts/versions/create endpoint handler in index.js
//
// Branch naming: preview/av-<first-8-chars-of-artifact-version-id>
// Cloudflare Pages auto-deploys all branches → URL is deterministic.
//
// NO WRANGLER CHANGES NEEDED — uses same GitHub token env vars.
// =============================================================================

// ---------------------------------------------------------------------------
// MAIN EXPORT
// ---------------------------------------------------------------------------

export async function createArtifactPreviewBranch(artifactVersion, client, env) {
  const githubToken = await resolveGithubToken(client, env);
  if (!githubToken) {
    return { ok: false, skipped: true, reason: 'no_github_token' };
  }

  const repo = client.github_repo;
  if (!repo) return { ok: false, skipped: true, reason: 'no_github_repo' };

  const pagesProject = client.cloudflare_pages_project || client.slug;
  const branchName   = `preview/av-${artifactVersion.id.slice(0, 8)}`;

  // Determine what content to push
  const html = extractHtmlContent(artifactVersion);
  if (!html) {
    return { ok: false, skipped: true, reason: 'no_html_content_in_artifact' };
  }

  // The file path in the repo — always index.html for homepage artifacts,
  // or artifact-type specific path for others
  const filePath = resolveFilePath(artifactVersion);

  try {
    // Step 1: Get main branch SHA
    const mainSha = await getMainBranchSha(repo, githubToken);
    if (!mainSha) return { ok: false, error: 'could_not_get_main_sha' };

    // Step 2: Ensure preview branch exists (create from main if not)
    await ensureBranchExists(repo, branchName, mainSha, githubToken);

    // Step 3: Write the artifact HTML to the preview branch
    await writeFileToBranch(repo, branchName, filePath, html, githubToken, {
      message: `Preview: ${artifactVersion.artifact_type} v${artifactVersion.version_number || '?'} (artifact ${artifactVersion.id.slice(0, 8)})`,
    });

    // Cloudflare Pages URL for this branch — deterministic, available ~30s after push
    const previewUrl = buildPreviewUrl(branchName, pagesProject);

    return {
      ok:          true,
      branch:      branchName,
      file_path:   filePath,
      preview_url: previewUrl,
      message:     'Preview branch pushed. Cloudflare Pages will build in ~30s.',
    };
  } catch (err) {
    console.warn('[preview-branch] failed for artifact', artifactVersion.id, err?.message);
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// STORE PREVIEW URL ON ARTIFACT VERSION
// Call this after createArtifactPreviewBranch() succeeds.
// ---------------------------------------------------------------------------

export async function storePreviewUrlOnArtifact(artifactVersionId, previewUrl, previewBranch, supabase, env) {
  const res = await supabase(env, 'PATCH',
    `/rest/v1/artifact_versions?id=eq.${encodeURIComponent(artifactVersionId)}`,
    {
      preview_url:    previewUrl,
      preview_branch: previewBranch,
      updated_at:     new Date().toISOString(),
    },
    { Prefer: 'return=minimal' }
  );
  return { ok: res.ok };
}

// ---------------------------------------------------------------------------
// FULL FLOW — call this from createArtifactVersion() when status=pending_review
// ---------------------------------------------------------------------------

export async function maybeCreatePreviewBranch(artifactVersion, clientRecord, env, deps = {}) {
  const supabase = deps.supabase;
  // Only auto-preview artifact types that render HTML
  const HTML_ARTIFACT_TYPES = new Set(['homepage', 'landing_page', 'about_page', 'services_page', 'contact_page']);
  if (!HTML_ARTIFACT_TYPES.has(artifactVersion.artifact_type)) {
    return { ok: true, skipped: true, reason: 'non_html_artifact_type' };
  }

  const result = await createArtifactPreviewBranch(artifactVersion, clientRecord, env);
  if (!result.ok || result.skipped) return result;

  // Store preview URL back onto the artifact version record
  if (supabase && result.preview_url) {
    await storePreviewUrlOnArtifact(artifactVersion.id, result.preview_url, result.branch, supabase, env);
  }

  return result;
}

// ---------------------------------------------------------------------------
// GITHUB API HELPERS
// ---------------------------------------------------------------------------

async function resolveGithubToken(client, env) {
  // Operator-level GitHub token (used for provisioning and preview branches)
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;

  // Client-level token (stored encrypted — need decrypt dep)
  // If you need per-client tokens, decrypt client.github_token_enc here.
  return null;
}

async function getMainBranchSha(repo, token) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/git/ref/heads/main`,
    { headers: githubHeaders(token) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.object?.sha || null;
}

async function ensureBranchExists(repo, branchName, mainSha, token) {
  // Check if branch exists
  const checkRes = await fetch(
    `https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(branchName)}`,
    { headers: githubHeaders(token) }
  );
  if (checkRes.ok) return; // already exists

  // Create branch from main
  const createRes = await fetch(
    `https://api.github.com/repos/${repo}/git/refs`,
    {
      method:  'POST',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha }),
    }
  );
  if (!createRes.ok) {
    const err = await createRes.json();
    throw new Error(`Could not create preview branch '${branchName}': ${err.message}`);
  }
}

async function writeFileToBranch(repo, branchName, filePath, content, token, { message }) {
  // Check if file exists on branch (need its SHA for updates)
  let fileSha = null;
  const existingRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(branchName)}`,
    { headers: githubHeaders(token) }
  );
  if (existingRes.ok) {
    const existing = await existingRes.json();
    fileSha = existing.sha || null;
  }

  const writeRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/${filePath}`,
    {
      method:  'PUT',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        message,
        content: toBase64(content),
        branch:  branchName,
        ...(fileSha ? { sha: fileSha } : {}),
      }),
    }
  );

  if (!writeRes.ok) {
    const err = await writeRes.json();
    throw new Error(`Could not write file to preview branch: ${err.message}`);
  }
}

function buildPreviewUrl(branchName, pagesProject) {
  // Cloudflare Pages converts branch name to URL-safe format:
  // 'preview/av-abc12345' → 'preview-av-abc12345.<project>.pages.dev'
  const urlSafeBranch = branchName.replace(/\//g, '-').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  return `https://${urlSafeBranch}.${pagesProject}.pages.dev`;
}

function resolveFilePath(artifactVersion) {
  const paths = {
    homepage:      'index.html',
    landing_page:  `${artifactVersion.artifact_key || 'landing'}/index.html`,
    about_page:    'about/index.html',
    services_page: 'services/index.html',
    contact_page:  'contact/index.html',
  };
  return paths[artifactVersion.artifact_type] || 'index.html';
}

function extractHtmlContent(artifactVersion) {
  const content = artifactVersion.content;
  if (!content) return null;

  // Content may be a string (raw HTML) or object with an html field
  if (typeof content === 'string' && content.includes('<')) return content;
  if (content.html && typeof content.html === 'string') return content.html;
  if (content.rendered_html && typeof content.rendered_html === 'string') return content.rendered_html;

  return null; // placeholder content — nothing to push
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept:        'application/vnd.github+json',
    'User-Agent':  'forma-platform-worker',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function toBase64(str) {
  // Workers-compatible base64 encode of potentially UTF-8 content
  return btoa(unescape(encodeURIComponent(str)));
}

// ---------------------------------------------------------------------------
// INTEGRATION INSTRUCTIONS
// ---------------------------------------------------------------------------
//
// 1. Import in formaut-artifact-pipeline.js (or index.js handleArtifactVersionCreate):
//
//    import { maybeCreatePreviewBranch } from './artifact-preview-branch.js';
//
// 2. In createArtifactVersion(), after the artifact_version record is written
//    with status 'pending_review', add:
//
//    if (result.artifact_version.status === 'pending_review') {
//      const preview = await maybeCreatePreviewBranch(
//        result.artifact_version,
//        clientRecord,  // needs: github_repo, cloudflare_pages_project
//        env,
//        { supabase }
//      );
//      if (preview.ok && !preview.skipped) {
//        result.artifact_version.preview_url    = preview.preview_url;
//        result.artifact_version.preview_branch = preview.branch;
//      }
//    }
//
// 3. Schema addition (artifact_versions table):
//    ALTER TABLE artifact_versions
//      ADD COLUMN IF NOT EXISTS preview_url    text,
//      ADD COLUMN IF NOT EXISTS preview_branch text;
//
// 4. In the dashboard review card, surface preview_url with a "Preview live"
//    button. The URL is available ~30s after the artifact enters pending_review.

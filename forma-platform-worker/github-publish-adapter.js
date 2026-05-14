// =============================================================================
// FORMAUT GITHUB PUBLISH ADAPTER
// =============================================================================
// Takes an approved artifact_version record and writes it to the client's
// GitHub repo, triggering a Cloudflare Pages auto-deploy.
//
// This is the missing link between the artifact pipeline (which stores approved
// HTML in the DB) and the live website (which needs a git commit to deploy).
//
// Flow:
//   artifact_versions.content → determine file path → fetch current SHA
//   → PUT to GitHub Contents API → record commit SHA back to DB
//   → optionally trigger Cloudflare deploy hook → return deploy status
//
// Artifact type → file path mapping:
//   homepage    → index.html
//   seo         → seo-meta.json  (also patches <head> of index.html if full HTML)
//   sitemap     → sitemap.xml
//   robots      → robots.txt
//   admin       → admin/index.html
//   email/*     → email/{key}.html
//   (fallback)  → {artifact_type}/{artifact_key}.html
// =============================================================================

const GITHUB_API = 'https://api.github.com';

// ── Artifact type → repo file path ──────────────────────────────────────────

function artifactFilePath(artifactType, artifactKey) {
  const type = String(artifactType || '').toLowerCase();
  const key  = String(artifactKey  || 'default').toLowerCase();

  switch (type) {
    case 'homepage': return 'index.html';
    case 'sitemap':  return 'sitemap.xml';
    case 'robots':   return 'robots.txt';
    case 'seo':      return 'seo-meta.json';
    case 'admin':    return 'admin/index.html';
    case 'email':    return `email/${key}.html`;
    default:
      // Generic fallback: artifact_type/artifact_key.ext
      const ext = guessExtension(type, key);
      return key === 'default' ? `${type}${ext}` : `${type}/${key}${ext}`;
  }
}

function guessExtension(type, key) {
  if (type.endsWith('.json') || key.endsWith('.json')) return '';
  if (type.endsWith('.xml')  || key.endsWith('.xml'))  return '';
  if (type.endsWith('.txt')  || key.endsWith('.txt'))  return '';
  if (type.includes('json')) return '.json';
  if (type.includes('xml'))  return '.xml';
  return '.html';
}

// ── Serialize artifact content to a string ───────────────────────────────────
// The artifact_versions.content column is JSONB. For HTML artifacts it's
// typically { html: "<!DOCTYPE html>..." }. For JSON artifacts it's the
// data itself. Handle both.

function serializeContent(artifactType, content) {
  if (content === null || content === undefined) return '';

  // Plain string — already serialized
  if (typeof content === 'string') return content;

  const type = String(artifactType || '').toLowerCase();

  // HTML artifact stored as { html: "..." }
  if (content.html && typeof content.html === 'string') return content.html;

  // Sitemap / robots stored as { content: "..." } or { xml: "..." } or { text: "..." }
  if (typeof content.content === 'string') return content.content;
  if (typeof content.xml     === 'string') return content.xml;
  if (typeof content.text    === 'string') return content.text;

  // SEO and other JSON artifacts — pretty-print
  if (type === 'seo' || type.includes('json')) return JSON.stringify(content, null, 2);

  // Fallback: stringify whatever we got
  return JSON.stringify(content, null, 2);
}

// ── Commit message ────────────────────────────────────────────────────────────

function commitMessage(artifactType, versionNumber, reason) {
  const typeLabel = artifactType === 'homepage' ? 'homepage'
    : artifactType === 'seo'      ? 'SEO metadata'
    : artifactType === 'sitemap'  ? 'sitemap'
    : artifactType === 'robots'   ? 'robots.txt'
    : artifactType === 'admin'    ? 'admin panel'
    : `${artifactType} artifact`;

  const msg = reason
    ? `Formaut: publish ${typeLabel} v${versionNumber} — ${reason}`
    : `Formaut: publish ${typeLabel} v${versionNumber}`;

  // GitHub commit messages should stay under 72 chars for the subject line
  return msg.length > 72 ? msg.slice(0, 69) + '...' : msg;
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept:        'application/vnd.github+json',
    'User-Agent':  'forma-platform-worker/github-publish-adapter',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function getFileSha(repo, path, token) {
  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/contents/${path}`,
    { headers: githubHeaders(token) }
  );
  if (res.status === 404) return null;  // File doesn't exist yet — that's fine
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub SHA lookup failed for ${path}: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.sha || null;
}

async function putFileToGitHub(repo, path, contentString, commitMsg, token, existingSha) {
  const body = {
    message: commitMsg,
    content: base64Encode(contentString),
    ...(existingSha ? { sha: existingSha } : {}),
  };

  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/contents/${path}`,
    {
      method:  'PUT',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub PUT failed for ${path}: ${res.status} ${err}`);
  }

  const data = await res.json();
  return {
    commit_sha:   data.commit?.sha  || null,
    file_sha:     data.content?.sha || null,
    html_url:     data.content?.html_url || null,
    commit_url:   data.commit?.html_url  || null,
  };
}

// ── Cloudflare Pages deploy trigger ──────────────────────────────────────────
// Cloudflare Pages auto-deploys on every push to the connected branch.
// A git commit via the Contents API is sufficient — this is just belt-and-
// suspenders for projects with a deploy hook configured.

async function triggerCloudflareDeploy(project, accountId, cloudflareToken) {
  if (!project || !accountId || !cloudflareToken) return { triggered: false, reason: 'missing_config' };

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}/deployments`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${cloudflareToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }
  );

  if (!res.ok) {
    // Non-fatal — the git push will still trigger Pages auto-deploy
    return { triggered: false, reason: `cloudflare_api_${res.status}` };
  }

  const data = await res.json();
  const deploy = data.result;
  return {
    triggered:   true,
    deploy_id:   deploy?.id   || null,
    deploy_url:  deploy?.url  || null,
    deploy_env:  deploy?.environment || 'production',
  };
}

// ── Decrypt helper (mirrors index.js — kept local to avoid circular deps) ────

async function decrypt(ciphertext, hexKey) {
  const keyBytes = hexToBytes(hexKey);
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']
  );
  const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const iv   = combined.slice(0, 12);
  const data = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(plain);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function base64Encode(str) {
  // Works in Workers runtime and browser — handles Unicode safely
  const bytes = new TextEncoder().encode(str);
  let binary  = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * publishVersionToGitHub
 *
 * Fetches the client record, decrypts credentials, serializes the artifact
 * content, and writes it to GitHub. Returns a structured result you can
 * merge into the publish transaction record.
 *
 * @param {object} version  - Row from artifact_versions (must include content,
 *                            artifact_type, artifact_key, client_slug)
 * @param {object} env      - Cloudflare Worker env bindings
 * @param {object} supabase - The supabase() function from index.js
 * @param {string} [reason] - Optional human-readable publish reason
 * @returns {object}        - { ok, file_path, commit_sha, deploy, ... }
 */
export async function publishVersionToGitHub(version, env, supabase, reason = null) {
  const slug = version.client_slug;
  if (!slug) throw new Error('artifact version is missing client_slug — cannot look up credentials');

  // ── Load client record ──────────────────────────────────────────────────
  const clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=github_repo,github_token_enc,cloudflare_pages_project,cloudflare_account_id,cloudflare_token_enc&limit=1`
  );
  if (!clientRes.ok) throw new Error(`Client lookup failed: ${clientRes.status}`);
  const clients = await clientRes.json();
  if (!clients.length) throw new Error(`Client not found for slug: ${slug}`);
  const client = clients[0];

  if (!client.github_repo)      throw new Error('GitHub repo not configured for this client');
  if (!client.github_token_enc) throw new Error('GitHub token not connected for this client');

  // ── Decrypt credentials ─────────────────────────────────────────────────
  const githubToken = await decrypt(client.github_token_enc, env.ENCRYPTION_KEY);

  let cloudflareToken = null;
  if (client.cloudflare_token_enc) {
    cloudflareToken = await decrypt(client.cloudflare_token_enc, env.ENCRYPTION_KEY).catch(() => null);
  }

  // ── Determine file path and serialize content ───────────────────────────
  const filePath      = artifactFilePath(version.artifact_type, version.artifact_key);
  const fileContent   = serializeContent(version.artifact_type, version.content);
  const versionNumber = version.version_number || '?';

  if (!fileContent) throw new Error(`Artifact content is empty for ${version.artifact_type} v${versionNumber}`);

  // ── Get current file SHA (needed by GitHub to update existing files) ────
  const existingSha = await getFileSha(client.github_repo, filePath, githubToken);

  // ── Commit to GitHub ────────────────────────────────────────────────────
  const msg    = commitMessage(version.artifact_type, versionNumber, reason);
  const commit = await putFileToGitHub(client.github_repo, filePath, fileContent, msg, githubToken, existingSha);

  // ── Optionally trigger Cloudflare Pages deploy ──────────────────────────
  // Pages auto-deploys on git push, but we fire the API anyway so we get a
  // deploy ID to track. Failure here is non-fatal.
  const deploy = await triggerCloudflareDeploy(
    client.cloudflare_pages_project,
    client.cloudflare_account_id || env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareToken
  );

  return {
    ok:          true,
    file_path:   filePath,
    repo:        client.github_repo,
    commit_sha:  commit.commit_sha,
    file_sha:    commit.file_sha,
    commit_url:  commit.commit_url,
    html_url:    commit.html_url,
    deploy,
    github_action: existingSha ? 'updated' : 'created',
  };
}

/**
 * Convenience: resolve a client slug from an artifact version row,
 * falling back to a DB lookup by client_id if slug is missing.
 */
export async function resolveClientSlug(version, env, supabase) {
  if (version.client_slug) return version.client_slug;
  if (!version.client_id)  throw new Error('artifact version has neither client_slug nor client_id');

  const res = await supabase(env, 'GET',
    `/rest/v1/clients?id=eq.${encodeURIComponent(version.client_id)}&select=slug&limit=1`
  );
  if (!res.ok) throw new Error(`Client slug lookup failed: ${res.status}`);
  const rows = await res.json();
  if (!rows.length) throw new Error(`No client found for id: ${version.client_id}`);
  return rows[0].slug;
}

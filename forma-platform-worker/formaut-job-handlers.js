// =============================================================================
// FORMAUT JOB HANDLERS
// =============================================================================
// Typed handlers that run behind the DB-backed job queue. Keep handlers small and
// explicit: each job type should validate its payload, load only the client data
// it needs, then call the existing deterministic system or integration adapter.
// =============================================================================

import { runExistingWebsiteCrawlAdapter, previewExistingWebsiteCrawl } from './existing-website-crawl-adapter.js';
import { createArtifactVersion } from './formaut-artifact-pipeline.js';
import { validateDeployment } from './operational/operational-deployment-validator.js';
import { planEmailImplementation, sendTransactionalEmail, validateResendApiKey } from './email-intent-agent.js';
import { renderEmailTemplate, buildEmailCopyPrompt } from './email-template-engine.js';
import { generateArtifactContent } from './artifact-generators/orchestrator.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createFormautJobHandlers(deps = {}) {
  const supabase = requireDep(deps.supabase, 'supabase');
  const decrypt = requireDep(deps.decrypt, 'decrypt');

  return {
    noop: async (job) => ({ message: 'noop completed', payload: job.payload || {} }),

    // ── Homepage generation — REAL, not placeholder ────────────────────────
    generate_homepage: async (job, env) => {
      const payload = job.payload || {};
      const clientRecord = await loadClientRecord(job, payload, env, { supabase, decrypt });

      const { content, metadata, change_summary } = await generateArtifactContent(
        'homepage', clientRecord, env,
        {
          trigger: payload.trigger || 'manual',
          profile_patch: payload.profile_patch || null,
        },
      );

      const result = await createArtifactVersion({
        client_id: job.client_id,
        client_slug: job.client_slug,
        artifact_type: 'homepage',
        artifact_key: payload.artifact_key || 'default',
        content,
        metadata: {
          ...metadata,
          source_artifact_type: payload.source_artifact_type || null,
          source_key: payload.source_key || null,
        },
        source_job_id: job.id,
        lineage_event_id: payload.lineage_event_id || null,
        requires_review_before_publish: payload.requires_review_before_publish !== false,
        event_source: 'generate_homepage_job',
        change_summary,
      }, env, { supabase });

      return {
        artifact_type: 'homepage',
        status: result.artifact_version.status,
        artifact_version_id: result.artifact_version.id,
        diff: result.diff,
        sections_used: content.sections,
        archetype: content.brief?.archetype,
      };
    },

    // ── SEO generation — REAL, not placeholder ─────────────────────────────
    generate_seo: async (job, env) => {
      const payload = job.payload || {};
      const clientRecord = await loadClientRecord(job, payload, env, { supabase, decrypt });

      const { content, metadata, change_summary } = await generateArtifactContent(
        'seo', clientRecord, env,
        {
          trigger: payload.trigger || 'manual',
          title: payload.title || null,
          description: payload.description || null,
          profile_patch: payload.profile_patch || null,
        },
      );

      const result = await createArtifactVersion({
        client_id: job.client_id,
        client_slug: job.client_slug,
        artifact_type: 'seo',
        artifact_key: payload.artifact_key || 'default',
        content,
        metadata: {
          ...metadata,
          source_artifact_type: payload.source_artifact_type || null,
          source_key: payload.source_key || null,
        },
        source_job_id: job.id,
        lineage_event_id: payload.lineage_event_id || null,
        requires_review_before_publish: payload.requires_review_before_publish !== false,
        event_source: 'generate_seo_job',
        change_summary,
      }, env, { supabase });

      return {
        artifact_type: 'seo',
        status: result.artifact_version.status,
        artifact_version_id: result.artifact_version.id,
        diff: result.diff,
        title: content.title,
        schema_type: content.jsonld?.['@type'],
      };
    },

    // ── Sitemap — deterministic, no AI ────────────────────────────────────
    regenerate_sitemap: async (job, env) => {
      const payload = job.payload || {};
      const clientRecord = await loadClientRecord(job, payload, env, { supabase, decrypt });

      const { content, metadata, change_summary } = await generateArtifactContent(
        'sitemap', clientRecord, env,
        {
          trigger: payload.trigger || 'manual',
          multi_page: payload.multi_page === true,
        },
      );

      const result = await createArtifactVersion({
        client_id: job.client_id,
        client_slug: job.client_slug,
        artifact_type: 'sitemap',
        artifact_key: payload.artifact_key || 'default',
        content,
        metadata,
        source_job_id: job.id,
        lineage_event_id: payload.lineage_event_id || null,
        requires_review_before_publish: false, // sitemap never needs review
        event_source: 'regenerate_sitemap_job',
        change_summary,
      }, env, { supabase });

      return {
        artifact_type: 'sitemap',
        status: result.artifact_version.status,
        artifact_version_id: result.artifact_version.id,
        page_count: content.page_count,
      };
    },

    // ── robots.txt — deterministic, no AI ────────────────────────────────
    regenerate_robots: async (job, env) => {
      const payload = job.payload || {};
      const clientRecord = await loadClientRecord(job, payload, env, { supabase, decrypt });

      const { content, metadata, change_summary } = await generateArtifactContent(
        'robots', clientRecord, env,
        { trigger: payload.trigger || 'manual' },
      );

      const result = await createArtifactVersion({
        client_id: job.client_id,
        client_slug: job.client_slug,
        artifact_type: 'robots',
        artifact_key: payload.artifact_key || 'default',
        content,
        metadata,
        source_job_id: job.id,
        lineage_event_id: payload.lineage_event_id || null,
        requires_review_before_publish: false,
        event_source: 'regenerate_robots_job',
        change_summary,
      }, env, { supabase });

      return {
        artifact_type: 'robots',
        status: result.artifact_version.status,
        artifact_version_id: result.artifact_version.id,
      };
    },

    validate_deployment: async (job, env) => {
      const validation = await validateDeployment(env, job.payload?.deployment || job.payload || {}, { supabase });
      return { status: validation.healthy ? 'healthy' : 'unhealthy', validation };
    },

    // ── Crawl ────────────────────────────────────────────────────────────────
    crawl_website: async (job, env) => {
      const payload = job.payload || {};
      const url = extractUrl(payload.url || payload.existing_website_url || payload.message || payload.text);
      if (!url) throw new Error('crawl_website requires payload.url or a URL-like message.');

      const limit = clampInt(payload.limit || 4, 1, 8);
      const persist = payload.persist !== false && payload.persist_crawl !== false;

      if (!persist) {
        const preview = await previewExistingWebsiteCrawl({ url, limit });
        return {
          mode: 'preview',
          source_url: preview.source_url,
          pages_crawled: preview.pages_crawled,
          extracted_profile: preview.extracted_profile,
          persisted: false,
        };
      }

      const slugOrId = payload.slug || payload.client_slug || job.client_slug || payload.client_id || job.client_id;
      if (!slugOrId) throw new Error('crawl_website persistence requires job.client_slug, payload.slug, or client_id.');

      const clientRecord = await loadClientRecordForWebsiteCrawl(slugOrId, env, { supabase, decrypt });
      const result = await runExistingWebsiteCrawlAdapter(env, clientRecord, { url, limit });

      return {
        mode: 'persist',
        source_url: result.source_url,
        pages_crawled: result.pages_crawled,
        applied_profile_patch: result.applied_profile_patch,
        contradictions: result.contradictions,
        memory_events_count: Array.isArray(result.memory_events) ? result.memory_events.length : 0,
        evidence_storage: result.evidence_storage,
        persisted: true,
      };
    },

    // ── Email jobs ────────────────────────────────────────────────────────
    generate_email_template: async (job, env) => {
      const payload = job.payload || {};
      const { intent, business_profile = {}, custom_instructions, context = {} } = payload;
      if (!intent) throw new Error('generate_email_template requires payload.intent');

      const plan = planEmailImplementation(intent, context);
      if (!plan.ok) return { ok: false, plan, error: plan.message };

      const { scenario } = plan;
      const template_family = scenario.template_family;
      if (!template_family) {
        return { ok: true, plan, html: null, note: 'Inbound routing scenario — no HTML template needed.' };
      }

      const copyPrompt = buildEmailCopyPrompt({ scenario, business_profile, template_family, custom_instructions });

      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1200,
          messages: [{ role: 'user', content: copyPrompt }],
        }),
      });

      const anthropicData = await anthropicRes.json();
      const rawText = anthropicData.content?.[0]?.text || '';
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      const copyData = JSON.parse(cleaned);
      copyData.brand = business_profile.brand || {};

      const html = renderEmailTemplate(template_family, copyData);
      return { ok: true, plan, template_family, copy_data: copyData, html };
    },

    send_transactional_email: async (job, env) => {
      const payload = job.payload || {};
      const { slug, to, subject, html, from, reply_to } = payload;
      if (!slug || !to || !subject || !html) {
        throw new Error('send_transactional_email requires slug, to, subject, and html');
      }

      const connRes = await supabase(env, 'GET',
        `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`
      );
      const clients = connRes.ok ? await connRes.json() : [];
      if (!clients.length) throw new Error(`Client not found: ${slug}`);
      const clientId = clients[0].id;

      const keyRes = await supabase(env, 'GET',
        `/rest/v1/integration_connections?client_id=eq.${clientId}&provider=eq.resend&status=eq.connected&select=credential_enc,credential_meta&limit=1`
      );
      const keyRows = keyRes.ok ? await keyRes.json() : [];
      if (!keyRows.length) throw new Error('No active Resend connection for this client.');

      const apiKey = await decrypt(keyRows[0].credential_enc, env.ENCRYPTION_KEY);
      const verifiedDomains = keyRows[0].credential_meta?.verified_domains || [];
      const fromAddress = from || `noreply@${verifiedDomains[0] || 'example.com'}`;

      const result = await sendTransactionalEmail({ resend_api_key: apiKey, from: fromAddress, to, subject, html, reply_to });
      if (!result.ok) throw new Error(result.error);
      return { ok: true, message_id: result.message_id };
    },
  };
}

export function normalizeJobTypeAliases(type) {
  const value = String(type || '').trim();
  const aliases = {
    existing_website_crawl: 'crawl_website',
    website_crawl: 'crawl_website',
    crawl_existing_website: 'crawl_website',
    homepage_generation: 'generate_homepage',
    regenerate_homepage: 'generate_homepage',
    seo_generation: 'generate_seo',
    regenerate_seo: 'generate_seo',
    regenerate_sitemap: 'regenerate_sitemap',
    regenerate_robots: 'regenerate_robots',
    deployment_validation: 'validate_deployment',
    printify_sync_products: 'noop',
    generate_email: 'generate_email_template',
    email_template: 'generate_email_template',
    send_email: 'send_transactional_email',
    transactional_email: 'send_transactional_email',
  };
  return aliases[value] || value;
}

// ── Shared client record loader ───────────────────────────────────────────────

async function loadClientRecord(job, payload, env, { supabase, decrypt }) {
  const slugOrId = payload.slug || payload.client_slug || job.client_slug
    || payload.client_id || job.client_id;

  if (!slugOrId) {
    throw new Error('Job requires client_slug, payload.slug, or client_id.');
  }

  const safe = encodeURIComponent(slugOrId);
  let clientRes = await supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${safe}&select=id,slug,name,business_name,industry,location,live_url,existing_website_url,supabase_url,supabase_service_key_enc&limit=1`
  );
  let clients = clientRes.ok ? await clientRes.json() : [];

  if (!clients.length && UUID_RE.test(slugOrId)) {
    clientRes = await supabase(env, 'GET',
      `/rest/v1/clients?id=eq.${safe}&select=id,slug,name,business_name,industry,location,live_url,existing_website_url,supabase_url,supabase_service_key_enc&limit=1`
    );
    clients = clientRes.ok ? await clientRes.json() : [];
  }

  if (!clients.length) throw new Error(`Client not found: ${slugOrId}`);

  const client = clients[0];
  if (client.supabase_service_key_enc && decrypt) {
    client.supabase_service_key_enc = await decrypt(client.supabase_service_key_enc, env.ENCRYPTION_KEY);
  }
  return client;
}

async function loadClientRecordForWebsiteCrawl(slugOrId, env, deps) {
  const safe = encodeURIComponent(slugOrId);
  let clientRes = await deps.supabase(env, 'GET', `/rest/v1/clients?slug=eq.${safe}&select=id,slug,live_url,existing_website_url,supabase_url,supabase_service_key_enc&limit=1`);
  let clients = clientRes.ok ? await clientRes.json() : [];

  if (!clients.length && UUID_RE.test(slugOrId)) {
    clientRes = await deps.supabase(env, 'GET', `/rest/v1/clients?id=eq.${safe}&select=id,slug,live_url,existing_website_url,supabase_url,supabase_service_key_enc&limit=1`);
    clients = clientRes.ok ? await clientRes.json() : [];
  }

  if (!clients.length) throw new Error('Client not found for crawl_website job.');
  const client = clients[0];
  if (!client.supabase_url || !client.supabase_service_key_enc) {
    throw new Error('Client Supabase is not provisioned yet; crawl_website can only run in preview mode.');
  }

  const decryptedServiceKey = await deps.decrypt(client.supabase_service_key_enc, env.ENCRYPTION_KEY);
  return { ...client, supabase_service_key_enc: decryptedServiceKey };
}

function extractUrl(value) {
  const text = String(value || '').trim();
  const match = text.match(/https?:\/\/[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i);
  return match ? match[0].replace(/[),.;]+$/, '') : null;
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function requireDep(value, name) {
  if (!value) throw new Error(`Missing job handler dependency: ${name}`);
  return value;
}

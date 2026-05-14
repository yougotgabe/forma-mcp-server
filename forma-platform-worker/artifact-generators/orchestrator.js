// =============================================================================
// FORMAUT — ARTIFACT GENERATION ORCHESTRATOR
// =============================================================================
// The single entry point for generating any artifact type.
// Loads the business profile from client Supabase, runs the right generator,
// and returns content ready for createArtifactVersion().
//
// Usage:
//   import { generateArtifactContent } from './artifact-generators/orchestrator.js';
//   const { content, metadata } = await generateArtifactContent('homepage', clientRecord, env);
//
// This module is called by formaut-job-handlers.js to replace placeholder content.
// =============================================================================

import { generateHomepage } from './homepage-generator.js';
import { generateSeoArtifact } from './seo-generator.js';
import { generateSitemap, generateRobots, deriveSitemapPages } from './sitemap-robots-generator.js';
import { buildDesignBrief } from './design-brief-builder.js';

/**
 * Generate artifact content for a given artifact type.
 *
 * @param {string} artifactType - 'homepage' | 'seo' | 'sitemap' | 'robots'
 * @param {object} clientRecord - Row from platform clients table (with decrypted supabase key)
 * @param {object} env          - Worker env
 * @param {object} options
 * @param {string} [options.trigger]       - What caused generation ('onboarding'|'crawl'|'manual'|'signal')
 * @param {object} [options.profile_patch] - Optional profile override fields
 * @returns {Promise<{ content: object, metadata: object, change_summary: string }>}
 */
export async function generateArtifactContent(artifactType, clientRecord, env, options = {}) {
  const profile = await loadBusinessProfile(clientRecord, env, options.profile_patch);

  switch (artifactType) {
    case 'homepage':
      return generateHomepageContent(profile, clientRecord, env, options);

    case 'seo':
      return generateSeoContent(profile, clientRecord, env, options);

    case 'sitemap':
      return generateSitemapContent(profile, clientRecord, env, options);

    case 'robots':
      return generateRobotsContent(profile, clientRecord, env, options);

    default:
      throw new Error(`Unknown artifact type: ${artifactType}`);
  }
}

// ── Per-type generators ───────────────────────────────────────────────────────

async function generateHomepageContent(profile, clientRecord, env, options) {
  assertHasProfile(profile, clientRecord.slug, 'homepage');

  const result = await generateHomepage(profile, env, options);

  return {
    content: {
      kind: 'homepage',
      status: 'generated',
      html: result.html,
      sections: result.sections,
      copy: result.copy,
      brief: result.brief,
      generation_model: result.generation_model,
      generated_at: result.generated_at,
      profile_snapshot: profileSnapshot(profile),
    },
    metadata: {
      trigger: options.trigger || 'manual',
      industry: profile.industry || 'default',
      sections_used: result.sections,
      archetype: result.brief.archetype,
      cta_strategy: result.brief.cta_strategy,
      color_source: result.brief.color_strategy?.source,
    },
    change_summary: `Homepage generated (${result.sections.length} sections, ${result.brief.archetype} archetype, ${profile.industry || 'default'} industry).`,
  };
}

async function generateSeoContent(profile, clientRecord, env, options) {
  assertHasProfile(profile, clientRecord.slug, 'seo');

  const result = await generateSeoArtifact(profile, env, options);

  return {
    content: {
      kind: 'seo',
      status: 'generated',
      title: result.title,
      description: result.description,
      og: result.og,
      twitter: result.twitter,
      jsonld: result.jsonld,
      html_snippet: result.html_snippet,
      generated_at: result.generated_at,
      profile_snapshot: profileSnapshot(profile),
    },
    metadata: {
      trigger: options.trigger || 'manual',
      schema_type: result.jsonld['@type'],
      has_logo: Boolean(result.jsonld.logo),
      has_hours: Boolean(result.jsonld.openingHoursSpecification),
    },
    change_summary: `SEO artifact generated (title: "${result.title.slice(0, 40)}…", schema: ${result.jsonld['@type']}).`,
  };
}

async function generateSitemapContent(profile, clientRecord, env, options) {
  const brief = profile ? buildDesignBrief(profile) : null;
  const pages = brief ? deriveSitemapPages(brief.sections, options.multi_page === true) : [];
  const result = generateSitemap(profile || { live_url: clientRecord.live_url }, pages);

  return {
    content: {
      kind: 'sitemap',
      status: 'generated',
      xml: result.xml,
      base_url: result.base_url,
      pages: result.pages,
      page_count: result.page_count,
      generated_at: result.generated_at,
    },
    metadata: {
      trigger: options.trigger || 'manual',
      page_count: result.page_count,
      base_url: result.base_url,
    },
    change_summary: `Sitemap generated (${result.page_count} URLs, base: ${result.base_url}).`,
  };
}

async function generateRobotsContent(profile, clientRecord, env, options) {
  const result = generateRobots(
    profile || { live_url: clientRecord.live_url },
    { block_admin: true, block_api: true },
  );

  return {
    content: {
      kind: 'robots',
      status: 'generated',
      text: result.text,
      sitemap_url: result.sitemap_url,
      generated_at: result.generated_at,
    },
    metadata: {
      trigger: options.trigger || 'manual',
      sitemap_url: result.sitemap_url,
    },
    change_summary: `robots.txt generated (sitemap: ${result.sitemap_url || 'none'}).`,
  };
}

// ── Profile loader ────────────────────────────────────────────────────────────

/**
 * Load business profile from client's Supabase project.
 * Falls back gracefully — generators always handle a sparse profile.
 */
async function loadBusinessProfile(clientRecord, env, patch = {}) {
  // clientRecord.supabase_url + decrypted service key already present
  const supabaseUrl = clientRecord.supabase_url;
  const serviceKey = clientRecord.supabase_service_key_enc; // pre-decrypted by job handler

  if (!supabaseUrl || !serviceKey) {
    // Return minimal profile from client record itself — enough for fallback generation
    return buildMinimalProfile(clientRecord, patch);
  }

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/business_profiles?client_id=eq.${encodeURIComponent(clientRecord.id)}&select=*&limit=1`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
      },
    );

    if (!res.ok) return buildMinimalProfile(clientRecord, patch);
    const rows = await res.json();
    const profile = rows[0] || {};

    // Merge in any patch fields (e.g. from a crawl result that hasn't been persisted yet)
    return { ...buildMinimalProfile(clientRecord, {}), ...profile, ...patch };
  } catch {
    return buildMinimalProfile(clientRecord, patch);
  }
}

function buildMinimalProfile(clientRecord, patch = {}) {
  return {
    id: clientRecord.id,
    client_id: clientRecord.id,
    business_name: clientRecord.business_name || clientRecord.name || null,
    industry: clientRecord.industry || null,
    live_url: clientRecord.live_url || null,
    website_url: clientRecord.live_url || null,
    location: clientRecord.location || null,
    ...patch,
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function profileSnapshot(profile) {
  // Compact snapshot of the profile state at generation time for lineage
  return {
    business_name: profile.business_name,
    industry: profile.industry,
    location: profile.location,
    has_phone: Boolean(profile.phone || profile.contact_methods?.phone),
    has_email: Boolean(profile.email || profile.contact_methods?.email),
    has_logo: Boolean(profile.logo_url),
    has_hours: Boolean(profile.hours),
    has_testimonials: Boolean(profile.testimonials?.length),
    services_count: (profile.primary_services || profile.services || []).length,
  };
}

function assertHasProfile(profile, slug, artifactType) {
  if (!profile.business_name && !profile.industry) {
    throw new Error(
      `Cannot generate ${artifactType} for ${slug}: business profile is empty. ` +
      'Run onboarding or a crawl first to populate the business profile.',
    );
  }
}

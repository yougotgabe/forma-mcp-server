-- =============================================================================
-- FORMAUT CLIENT SCHEMAS
-- Two files to run — one per Supabase project provisioned for each client.
--
-- PROJECT A — formaut_os (private operational project)
--   Run section: FORMAUT_OS
--   Contains: business_memory, client_memory, client_communication_profile,
--             memory_events, review_pipeline_items, os_schema_migrations
--
-- PROJECT B — site_data (public/admin-editable project)
--   Run section: SITE_DATA
--   Contains: site_content, services, products, events, testimonials,
--             navigation, site_settings, seo_metadata, media_assets,
--             email_artifacts, email_rules, email_triggers, admin_activity,
--             email_operations registry (email_artifacts, email_rules, email_events)
--
-- Both sections are in this file for reference. Paste only the relevant one
-- into each project's Supabase SQL editor during provisioning.
-- =============================================================================


-- =============================================================================
-- ██████████████████████████████████████████████████████
--   SECTION A — FORMAUT_OS PROJECT
--   Private operational intelligence + governance
-- ██████████████████████████████████████████████████████
-- =============================================================================

-- Schema migration tracking
create table if not exists os_schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now(),
  detail     jsonb not null default '{}'::jsonb
);

insert into os_schema_migrations (version, detail)
values ('formaut_os_v1', '{"purpose":"private operational intelligence and governance"}'::jsonb)
on conflict (version) do nothing;


-- ---------------------------------------------------------------------------
-- client_memory
-- Structured, confidence-scored memory extracted from client sessions.
-- The retrieval source for the build agent — not raw conversation history.
--
-- category values:
--   brand    — tone, voice, identity signals
--   design   — visual preferences, approved interaction patterns
--   avoid    — explicit dislikes, rejected directions
--   business — services, hours, location, audience facts
--   feature  — specific feature preferences and decisions
--   content  — copy style, messaging, approved language
-- ---------------------------------------------------------------------------

create table if not exists client_memory (
  id                uuid        primary key default gen_random_uuid(),
  client_id         uuid,                       -- matches clients.id in platform Supabase
  category          text        not null,
  key               text        not null,
  value_json        jsonb       not null,
  confidence        numeric(3,2) not null default 0.70
                    check (confidence >= 0.50 and confidence <= 0.95),
  source_session_id uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (client_id, category, key)
);

-- Primary retrieval index used in chat.js context injection
create index if not exists idx_client_memory_lookup
  on client_memory (client_id, confidence desc);

create index if not exists idx_client_memory_category
  on client_memory (client_id, category);

create or replace function touch_client_memory_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists client_memory_touch on client_memory;
create trigger client_memory_touch
before update on client_memory
for each row execute function touch_client_memory_updated_at();


-- ---------------------------------------------------------------------------
-- memory_events
-- Audit trail of every memory change. Lets the agent explain its decisions.
-- ---------------------------------------------------------------------------

create table if not exists memory_events (
  id                uuid        primary key default gen_random_uuid(),
  client_id         uuid,
  event_type        text        not null,   -- created|updated|contradicted|confirmed|overridden
  category          text        not null,
  key               text        not null,
  old_value         jsonb,
  new_value         jsonb       not null,
  reason            text,
  source_session_id uuid,
  created_at        timestamptz not null default now()
);

create index if not exists idx_memory_events_client
  on memory_events (client_id, created_at desc);


-- ---------------------------------------------------------------------------
-- business_memory
-- Broader business facts with visibility controls.
-- Source of truth for crawl-extracted and conversation-confirmed facts.
-- ---------------------------------------------------------------------------

create table if not exists business_memory (
  id                       uuid        primary key default gen_random_uuid(),
  memory_key               text        not null,
  memory_value             jsonb       not null,
  confidence               text        not null default 'unconfirmed',
  source                   text,
  promoted_from_session_id uuid,
  visibility               text        not null default 'private'
                           check (visibility in ('private', 'reviewable', 'public_candidate')),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (memory_key)
);

create or replace function touch_business_memory_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists business_memory_touch on business_memory;
create trigger business_memory_touch
before update on business_memory
for each row execute function touch_business_memory_updated_at();


-- ---------------------------------------------------------------------------
-- business_profile_review_items
-- Pending crawl or conversation findings awaiting client approval.
-- Powers the crawl review UI.
-- ---------------------------------------------------------------------------

create table if not exists business_profile_review_items (
  id              uuid        primary key default gen_random_uuid(),
  client_id       uuid,
  item_type       text        not null,   -- 'crawl_finding' | 'conversation_fact' | 'correction'
  field           text        not null,
  existing_value  jsonb,
  incoming_value  jsonb,
  confidence      numeric,
  source          text,
  status          text        not null default 'pending_review'
                  check (status in ('pending_review', 'approved', 'rejected', 'skipped')),
  created_at      timestamptz not null default now(),
  reviewed_at     timestamptz
);

create index if not exists bpr_client_status_idx
  on business_profile_review_items (client_id, status, created_at desc);


-- ---------------------------------------------------------------------------
-- client_communication_profile
-- Singleton table — one row per client OS project.
-- Never shared with platform. Only anonymized behavioral signals go to platform.
-- ---------------------------------------------------------------------------

create table if not exists client_communication_profile (
  id                     uuid        primary key default gen_random_uuid(),
  updated_at             timestamptz not null default now(),
  technical_comfort      text        not null default 'unknown',
  explanation_depth      text        not null default 'standard',
  tone_preference        text        not null default 'casual',
  wants_reasoning        boolean     not null default true,
  confirms_before_acting boolean     not null default false,
  instruction_style      text        not null default 'sequential',
  repeated_explanations  text[]      not null default '{}',
  hesitation_points      text[]      not null default '{}',
  demonstrated_skills    text[]      not null default '{}',
  agent_notes            text,
  confidence_trend       text        not null default 'unknown',
  sessions_observed      integer     not null default 0,
  last_session_id        uuid
);

alter table client_communication_profile enable row level security;

comment on table client_communication_profile is
  'Per-client communication calibration. Built by the agent from observed session behavior. '
  'Never shared with platform. Only anonymized signals are extracted.';


-- ---------------------------------------------------------------------------
-- review_pipeline_items
-- Governance layer: tracks every proposed site change through its lifecycle.
-- ---------------------------------------------------------------------------

create table if not exists review_pipeline_items (
  id                 uuid        primary key default gen_random_uuid(),
  artifact_id        text,
  stage              text        not null default 'draft'
                     check (stage in ('draft', 'staged', 'reviewed', 'approved', 'committed', 'published', 'rolled_back')),
  risk_level         text        not null default 'low',
  agent_source       text,
  changed_files      text[]      not null default '{}',
  affected_systems   text[]      not null default '{}',
  rollback_available boolean     not null default false,
  validation_status  text        not null default 'unknown',
  metadata           jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create or replace function touch_rpi_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists review_pipeline_items_touch on review_pipeline_items;
create trigger review_pipeline_items_touch
before update on review_pipeline_items
for each row execute function touch_rpi_updated_at();


-- =============================================================================
-- ██████████████████████████████████████████████████████
--   SECTION B — SITE_DATA PROJECT
--   Public / admin-editable website and email data
-- ██████████████████████████████████████████████████████
-- =============================================================================

create extension if not exists pgcrypto;

-- Schema migration tracking
create table if not exists site_schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now(),
  detail     jsonb not null default '{}'::jsonb
);

insert into site_schema_migrations (version, detail)
values ('site_data_v1', '{"purpose":"public/admin-editable website and email data"}'::jsonb)
on conflict (version) do nothing;


-- site_content: structured content per page section.
-- Agent writes here. Admin panel reads/writes here. Site reads here at build time.
create table if not exists site_content (
  id          uuid  primary key default gen_random_uuid(),
  page_slug   text  not null,
  section_key text  not null,
  content     jsonb not null default '{}'::jsonb,
  status      text  not null default 'published',
  updated_at  timestamptz not null default now(),
  unique (page_slug, section_key)
);


create table if not exists services (
  id          uuid    primary key default gen_random_uuid(),
  name        text    not null,
  slug        text    unique,
  description text,
  price_label text,
  sort_order  integer not null default 100,
  active      boolean not null default true,
  metadata    jsonb   not null default '{}'::jsonb
);


create table if not exists products (
  id                uuid    primary key default gen_random_uuid(),
  name              text    not null,
  slug              text    unique,
  description       text,
  price_cents       integer,
  currency          text    not null default 'USD',
  image_url         text,
  external_provider text,
  external_id       text,
  active            boolean not null default true,
  metadata          jsonb   not null default '{}'::jsonb
);


create table if not exists events (
  id          uuid    primary key default gen_random_uuid(),
  title       text    not null,
  starts_at   timestamptz,
  ends_at     timestamptz,
  location    text,
  description text,
  image_url   text,
  active      boolean not null default true,
  metadata    jsonb   not null default '{}'::jsonb
);


create table if not exists testimonials (
  id           uuid    primary key default gen_random_uuid(),
  quote        text    not null,
  author_name  text,
  author_label text,
  rating       integer check (rating between 1 and 5),
  active       boolean not null default true,
  sort_order   integer not null default 100
);


create table if not exists navigation (
  id         uuid    primary key default gen_random_uuid(),
  label      text    not null,
  href       text    not null,
  nav_area   text    not null default 'primary',
  sort_order integer not null default 100,
  active     boolean not null default true
);


-- site_settings: key/value store for site-wide settings.
-- Examples: business_name, phone, address, hours, colors
create table if not exists site_settings (
  key        text  primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);


-- seo_metadata: per-page SEO fields. Agent writes, site reads at build time.
create table if not exists seo_metadata (
  id            uuid  primary key default gen_random_uuid(),
  page_slug     text  not null unique,
  title         text,
  description   text,
  og_image_url  text,
  canonical_url text,
  metadata      jsonb not null default '{}'::jsonb
);


create table if not exists media_assets (
  id            uuid  primary key default gen_random_uuid(),
  bucket        text  not null,
  path          text  not null,
  alt_text      text,
  usage_context text,
  public_url    text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (bucket, path)
);


-- email_artifacts: HTML templates for transactional emails.
-- Separate from platform email_templates — this is the deployed copy on the client.
create table if not exists email_artifacts (
  id           uuid  primary key default gen_random_uuid(),
  artifact_key text  not null unique,
  subject      text,
  html         text,
  text_body    text,
  status       text  not null default 'draft',
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create or replace function touch_email_artifacts_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists email_artifacts_touch on email_artifacts;
create trigger email_artifacts_touch
before update on email_artifacts
for each row execute function touch_email_artifacts_updated_at();


create table if not exists email_rules (
  id            uuid    primary key default gen_random_uuid(),
  rule_key      text    not null unique,
  trigger_key   text,
  artifact_key  text    references email_artifacts (artifact_key),
  provider      text,
  enabled       boolean not null default true,
  conditions    jsonb   not null default '{}'::jsonb,
  metadata      jsonb   not null default '{}'::jsonb
);


create table if not exists email_triggers (
  id           uuid    primary key default gen_random_uuid(),
  trigger_key  text    not null unique,
  trigger_type text    not null,
  source       text,
  enabled      boolean not null default true,
  metadata     jsonb   not null default '{}'::jsonb
);


-- admin_activity: append-only log of admin panel actions.
create table if not exists admin_activity (
  id             uuid  primary key default gen_random_uuid(),
  actor_id       text,
  actor_email    text,
  action         text  not null,
  affected_table text,
  affected_id    text,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

-- Storage buckets (create via Supabase dashboard or management API, not SQL):
-- public-media, email-assets, site-assets, logos, uploads

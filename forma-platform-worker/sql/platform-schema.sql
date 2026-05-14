-- =============================================================================
-- FORMAUT PLATFORM SCHEMA
-- Run in the PLATFORM Supabase project.
-- This is the single source of truth — do not run individual patch files.
--
-- Section order (each depends on the prior):
--   0.  Shared utilities (extensions, touch_updated_at trigger fn)
--   1.  Core client registry (clients, sessions_index, signals, style_signals,
--       communication_signals, onboarding_state, client_usage)
--   2.  Credential system (credential_events, key-hint columns on clients)
--   3.  Infrastructure registry (client_infrastructure_projects, linked_projects,
--       infrastructure_health_checks)
--   4.  Integration hub (integration_connections, commerce_products,
--       integration_sync_events)
--   5.  Job queue (jobs, job_events, jobs_dead_letter, job_client_limits,
--       job_queue_settings, claim_jobs fn)
--   6.  AI throughput guard (ai_rate_limit_windows, ai_usage_events,
--       formaut_acquire_ai_capacity fn)
--   7.  AI gateway tracing (ai_gateway_traces, ai_gateway_response_cache,
--       ai_gateway_completions, workflows, workflow_events)
--   8.  Artifact pipeline (artifact_versions, artifact_dependencies,
--       artifact_lineage, deployment_state, publish_transactions)
--   9.  Review + change control (artifact_reviews, site_version_snapshots,
--       change_log, publish_requests)
--  10.  Operational maintenance (operational_events, operational_remediation_plans,
--       provisioning_log, deployment_health_checks, maintenance_*)
--  11.  Email platform (email_templates, email_rules, email_send_log)
--  12.  Business profile (business_profiles, business_profile_fields,
--       business_profile_events, business_profile_sources, business_profile_memory)
--  13.  Design quality (design_quality_runs)
--  14.  Permissions + grants
-- =============================================================================


-- ============================================================
-- SECTION 0: SHARED UTILITIES
-- ============================================================

create extension if not exists pgcrypto;

-- Single shared updated_at trigger function. All tables reference this.
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ============================================================
-- SECTION 1: CORE CLIENT REGISTRY
-- ============================================================
-- NOTE: The `clients` table is expected to already exist — it is created
-- during initial platform setup. All other tables foreign-key into it.
-- If provisioning fresh: create clients first via Formaut provisioner or manually.
-- This section adds companion tables that must exist alongside clients.

-- sessions_index: one row per chat session, used for session summaries.
-- Written by the /signals endpoint after each session.
create table if not exists sessions_index (
  id          uuid        primary key default gen_random_uuid(),
  client_id   uuid        references clients(id) on delete cascade,
  client_slug text        not null,
  session_id  text        not null unique,
  summary     text,
  changes_made text[]     not null default '{}',
  session_date date       not null default current_date,
  created_at  timestamptz not null default now()
);

create index if not exists sessions_index_client_slug_date_idx
  on sessions_index (client_slug, session_date desc);

create index if not exists sessions_index_client_id_idx
  on sessions_index (client_id, session_date desc);


-- signals: tech signals extracted from client sessions.
-- Deduplicated by summary text. Not keyed to individual client — platform-wide KB.
create table if not exists signals (
  id           uuid        primary key default gen_random_uuid(),
  client_slug  text,
  session_id   text,
  signal_type  text        not null,
  title        text        not null,
  summary      text        not null,
  description  text,
  outcome      text,
  confidence   text,
  stack_layer  text,
  status       text        not null default 'active'
               check (status in ('active', 'dismissed', 'promoted')),
  times_seen   integer     not null default 1,
  promoted_at  timestamptz,
  promoted_by  text,
  promoted_field text,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists signals_client_slug_idx
  on signals (client_slug, status, confidence desc);

create index if not exists signals_status_created_idx
  on signals (status, created_at desc);

drop trigger if exists signals_touch_updated_at on signals;
create trigger signals_touch_updated_at
before update on signals
for each row execute function touch_updated_at();


-- style_signals: visual/layout patterns extracted from client sessions.
create table if not exists style_signals (
  id                    uuid        primary key default gen_random_uuid(),
  client_slug           text,
  session_id            text,
  session_date          date        not null default current_date,
  business_type         text,
  page_type             text,
  layout_built          text,
  iteration_count       integer     not null default 0,
  client_change_requests text[]     not null default '{}',
  final_layout          text,
  density               text,
  tone                  text,
  color_preference      text,
  outcome               text,
  confidence            text,
  status                text        not null default 'active'
                        check (status in ('active', 'dismissed', 'promoted')),
  times_seen            integer     not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists style_signals_client_slug_idx
  on style_signals (client_slug, session_date desc);

create index if not exists style_signals_business_type_idx
  on style_signals (business_type, page_type);

drop trigger if exists style_signals_touch_updated_at on style_signals;
create trigger style_signals_touch_updated_at
before update on style_signals
for each row execute function touch_updated_at();


-- communication_signals: anonymized behavioral signals, no PII.
create table if not exists communication_signals (
  id                        uuid        primary key default gen_random_uuid(),
  created_at                timestamptz not null default now(),
  session_date              date        not null default current_date,
  technical_comfort         text,
  explanation_depth_needed  text,
  topics_explained          text[]      not null default '{}',
  hesitation_points         text[]      not null default '{}',
  follow_up_questions_count integer,
  steps_needed_confirmation text[]      not null default '{}',
  session_length_turns      integer,
  task_completed            boolean,
  onboarding_step           text,
  client_type               text,
  calibration_quality       text
);

create index if not exists communication_signals_date_idx
  on communication_signals (session_date);


-- onboarding_state: current onboarding step per client.
create table if not exists onboarding_state (
  id            uuid        primary key default gen_random_uuid(),
  client_id     uuid        not null references clients(id) on delete cascade,
  client_slug   text        not null,
  current_state text        not null,
  metadata      jsonb       not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (client_id)
);

drop trigger if exists onboarding_state_touch on onboarding_state;
create trigger onboarding_state_touch
before update on onboarding_state
for each row execute function touch_updated_at();


-- client_onboarding_events: append-only event log per client.
create table if not exists client_onboarding_events (
  id          uuid        primary key default gen_random_uuid(),
  client_id   uuid        not null references clients(id) on delete cascade,
  client_slug text,
  event_type  text        not null,
  metadata    jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists client_onboarding_events_client_idx
  on client_onboarding_events (client_id, created_at desc);


-- client_usage: running request/token totals per client.
create table if not exists client_usage (
  client_id       uuid        primary key references clients(id) on delete cascade,
  client_slug     text        not null,
  messages_sent   integer     not null default 0,
  tokens_used     bigint      not null default 0,
  cost_cents      numeric     not null default 0,
  last_message_at timestamptz,
  updated_at      timestamptz not null default now()
);

create index if not exists client_usage_slug_idx on client_usage (client_slug);

drop trigger if exists client_usage_touch on client_usage;
create trigger client_usage_touch
before update on client_usage
for each row execute function touch_updated_at();


-- client_usage_flags: per-client soft limits and overrides.
create table if not exists client_usage_flags (
  client_id          uuid    primary key references clients(id) on delete cascade,
  rate_limited       boolean not null default false,
  limit_reason       text,
  override_limit     boolean not null default false,
  updated_at         timestamptz not null default now()
);


-- service_requests: client-initiated requests tracked for visibility.
create table if not exists service_requests (
  id           uuid        primary key default gen_random_uuid(),
  client_id    uuid        references clients(id) on delete cascade,
  client_slug  text        not null,
  session_id   text,
  request_type text        not null,
  status       text        not null default 'open'
               check (status in ('open', 'in_progress', 'completed', 'cancelled')),
  summary      text,
  payload      jsonb       not null default '{}'::jsonb,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists service_requests_client_idx
  on service_requests (client_slug, status, created_at desc);

drop trigger if exists service_requests_touch on service_requests;
create trigger service_requests_touch
before update on service_requests
for each row execute function touch_updated_at();


-- notification_log: outbound notifications sent by the platform.
create table if not exists notification_log (
  id           uuid        primary key default gen_random_uuid(),
  client_id    uuid        references clients(id) on delete cascade,
  client_slug  text,
  channel      text        not null,   -- 'email' | 'slack' | 'dashboard'
  subject      text,
  body         text,
  status       text        not null default 'sent',
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists notification_log_client_idx
  on notification_log (client_id, created_at desc);


-- deployment_events: lightweight log of GitHub commit + Cloudflare deploy events.
create table if not exists deployment_events (
  id              uuid        primary key default gen_random_uuid(),
  client_id       uuid        references clients(id) on delete cascade,
  client_slug     text        not null,
  deployment_id   text,
  commit_sha      text,
  branch          text,
  event_type      text        not null,   -- 'deploy_triggered' | 'deploy_succeeded' | 'deploy_failed' | 'rollback'
  status          text        not null default 'pending',
  live_url        text,
  preview_url     text,
  triggered_by    text,
  payload         jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists deployment_events_client_created_idx
  on deployment_events (client_slug, created_at desc);


-- ============================================================
-- SECTION 2: CREDENTIAL SYSTEM
-- ============================================================

-- credential_events: immutable audit log — no key values, only metadata.
create table if not exists credential_events (
  id           uuid        primary key default gen_random_uuid(),
  client_id    uuid        not null references clients(id) on delete cascade,
  actor_email  text        not null,
  field        text        not null,
  action       text        not null check (action in ('saved', 'rolled', 'revoked')),
  hint         text,
  ip_address   text,
  user_agent   text,
  created_at   timestamptz not null default now()
);

create index if not exists credential_events_client_idx
  on credential_events (client_id, created_at desc);

create index if not exists credential_events_field_idx
  on credential_events (client_id, field, created_at desc);

alter table credential_events enable row level security;

do $$ begin
  create policy "deny anon: credential_events"
    on credential_events for all to anon using (false);
exception when duplicate_object then null; end $$;

-- Key hint columns on clients — safe to read, never the full value.
alter table clients
  add column if not exists github_token_hint               text,
  add column if not exists github_token_updated_at         timestamptz,
  add column if not exists cloudflare_token_hint           text,
  add column if not exists cloudflare_token_updated_at     timestamptz,
  add column if not exists supabase_mgmt_token_hint        text,
  add column if not exists supabase_mgmt_token_updated_at  timestamptz,
  add column if not exists supabase_service_key_hint       text,
  add column if not exists supabase_service_key_updated_at timestamptz,
  add column if not exists supabase_anon_key_hint          text,
  add column if not exists supabase_anon_key_updated_at    timestamptz,
  add column if not exists printify_key_hint               text,
  add column if not exists printify_key_updated_at         timestamptz;


-- ============================================================
-- SECTION 3: INFRASTRUCTURE REGISTRY
-- ============================================================
-- Tracks the two-Supabase-project model: formaut_os + site_data.

create table if not exists client_infrastructure_projects (
  id               uuid    primary key default gen_random_uuid(),
  client_id        uuid    not null references clients(id) on delete cascade,
  client_slug      text,
  project_role     text    not null check (project_role in ('formaut_os', 'site_data')),
  project_name     text,
  project_ref      text,
  organization_id  text,
  supabase_url     text,
  status           text    not null default 'planned'
                   check (status in ('planned', 'detected', 'creating', 'created', 'ready', 'repair_needed', 'disabled', 'failed')),
  schema_version   text,
  migration_status text    not null default 'not_started'
                   check (migration_status in ('not_started', 'pending_schema_install', 'in_progress', 'complete', 'failed', 'repair_needed')),
  health_status    text    not null default 'unknown'
                   check (health_status in ('unknown', 'pass', 'warn', 'fail', 'repairing')),
  metadata         jsonb   not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (client_id, project_role)
);

create index if not exists idx_client_infra_projects_client on client_infrastructure_projects (client_id);
create index if not exists idx_client_infra_projects_slug   on client_infrastructure_projects (client_slug);

drop trigger if exists trg_client_infra_projects_touch on client_infrastructure_projects;
create trigger trg_client_infra_projects_touch
before update on client_infrastructure_projects
for each row execute function touch_updated_at();


create table if not exists linked_projects (
  id                    uuid  primary key default gen_random_uuid(),
  client_id             uuid  not null references clients(id) on delete cascade,
  formaut_os_project_id uuid  references client_infrastructure_projects(id) on delete set null,
  site_data_project_id  uuid  references client_infrastructure_projects(id) on delete set null,
  link_status           text  not null default 'active'
                        check (link_status in ('active', 'repair_needed', 'disabled')),
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (client_id)
);

drop trigger if exists linked_projects_touch on linked_projects;
create trigger linked_projects_touch
before update on linked_projects
for each row execute function touch_updated_at();


create table if not exists infrastructure_health_checks (
  id               uuid    primary key default gen_random_uuid(),
  client_id        uuid    not null references clients(id) on delete cascade,
  project_role     text    not null check (project_role in ('formaut_os', 'site_data')),
  project_ref      text,
  check_name       text    not null,
  status           text    not null default 'unknown'
                   check (status in ('pass', 'warn', 'fail', 'unknown')),
  detail           jsonb   not null default '{}'::jsonb,
  repair_available boolean not null default false,
  checked_at       timestamptz not null default now()
);

create index if not exists idx_infra_health_client_checked
  on infrastructure_health_checks (client_id, checked_at desc);


-- ============================================================
-- SECTION 4: INTEGRATION HUB
-- ============================================================

create table if not exists integration_connections (
  id                   uuid  primary key default gen_random_uuid(),
  client_id            uuid  not null references clients(id) on delete cascade,
  provider             text  not null,
  label                text,
  status               text  not null default 'connected'
                       check (status in ('connected', 'needs_reauth', 'disabled', 'error')),
  provider_account_id  text,
  provider_account_name text,
  auth_type            text  not null default 'api_token'
                       check (auth_type in ('api_token', 'oauth2', 'manual')),
  credential_enc       text  not null,
  credential_meta      jsonb not null default '{}'::jsonb,
  scopes               jsonb not null default '[]'::jsonb,
  last_sync_at         timestamptz,
  last_error           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (client_id, provider, provider_account_id)
);

create index if not exists integration_connections_client_provider_idx
  on integration_connections (client_id, provider, status);

drop trigger if exists trg_integration_connections_updated_at on integration_connections;
create trigger trg_integration_connections_updated_at
before update on integration_connections
for each row execute function touch_updated_at();


create table if not exists commerce_products (
  id                  uuid  primary key default gen_random_uuid(),
  client_id           uuid  not null references clients(id) on delete cascade,
  connection_id       uuid  references integration_connections(id) on delete set null,
  provider            text  not null,
  external_product_id text  not null,
  title               text  not null,
  description         text,
  status              text,
  visible             boolean,
  tags                text[] not null default '{}',
  images              jsonb  not null default '[]'::jsonb,
  variants            jsonb  not null default '[]'::jsonb,
  options             jsonb  not null default '[]'::jsonb,
  raw                 jsonb  not null default '{}'::jsonb,
  synced_at           timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (client_id, provider, external_product_id)
);

create index if not exists commerce_products_client_provider_idx
  on commerce_products (client_id, provider, status);

drop trigger if exists trg_commerce_products_updated_at on commerce_products;
create trigger trg_commerce_products_updated_at
before update on commerce_products
for each row execute function touch_updated_at();


create table if not exists integration_sync_events (
  id            uuid  primary key default gen_random_uuid(),
  client_id     uuid  not null references clients(id) on delete cascade,
  connection_id uuid  references integration_connections(id) on delete set null,
  provider      text  not null,
  event_type    text  not null,
  status        text  not null default 'success'
                check (status in ('success', 'partial', 'error')),
  message       text,
  counts        jsonb not null default '{}'::jsonb,
  error_detail  text,
  created_at    timestamptz not null default now()
);

create index if not exists integration_sync_events_client_created_idx
  on integration_sync_events (client_id, created_at desc);


-- ============================================================
-- SECTION 5: JOB QUEUE
-- ============================================================
-- Single authoritative jobs table. The two partial duplicates in the old files
-- (public.jobs and jobs) are merged here — full column set, one claim_jobs fn.

create table if not exists jobs (
  id                 uuid    primary key default gen_random_uuid(),
  client_id          uuid    references clients(id) on delete cascade,
  client_slug        text,
  session_id         text,
  queue              text    not null default 'default',
  job_type           text    not null,
  priority           integer not null default 100,
  status             text    not null default 'queued'
                     check (status in ('queued', 'running', 'succeeded', 'failed', 'retrying', 'dead', 'cancelled')),
  payload            jsonb   not null default '{}'::jsonb,
  result             jsonb,
  error              jsonb,
  attempts           integer not null default 0,
  max_attempts       integer not null default 3,
  run_after          timestamptz not null default now(),
  locked_at          timestamptz,
  locked_by          text,
  last_heartbeat_at  timestamptz,
  started_at         timestamptz,
  finished_at        timestamptz,
  progress_percent   integer check (progress_percent is null or (progress_percent >= 0 and progress_percent <= 100)),
  progress_stage     text,
  degradation_mode   text    not null default 'normal'
                     check (degradation_mode in ('normal', 'protect_margin', 'critical_only', 'read_only')),
  created_by         text    not null default 'dashboard',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists jobs_claim_idx
  on jobs (queue, status, run_after, priority, created_at)
  where status in ('queued', 'retrying');

create index if not exists jobs_client_status_idx
  on jobs (client_slug, status, created_at desc);

create index if not exists jobs_type_status_idx
  on jobs (job_type, status, created_at desc);

create index if not exists jobs_running_locked_at_idx
  on jobs (status, locked_at)
  where status = 'running';

alter table jobs enable row level security;

do $$ begin
  create policy "service role manages jobs"
    on jobs for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;

drop trigger if exists jobs_set_updated_at on jobs;
create trigger jobs_set_updated_at
before update on jobs
for each row execute function touch_updated_at();


create table if not exists job_events (
  id                  bigint generated always as identity primary key,
  job_id              uuid   not null references jobs(id) on delete cascade,
  event_type          text   not null,
  details             jsonb  not null default '{}'::jsonb,
  duration_ms         integer,
  attempt_number      integer,
  error_code          text,
  payload_fingerprint text,
  created_at          timestamptz not null default now()
);

create index if not exists job_events_job_idx   on job_events (job_id, created_at);
create index if not exists job_events_type_idx  on job_events (event_type, created_at desc);
create index if not exists job_events_error_code_idx
  on job_events (error_code) where error_code is not null;

alter table job_events enable row level security;
do $$ begin
  create policy "service role manages job events"
    on job_events for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;


create table if not exists jobs_dead_letter (
  id               uuid  primary key default gen_random_uuid(),
  original_job_id  uuid,
  client_id        uuid  references clients(id) on delete cascade,
  client_slug      text,
  queue            text  not null default 'default',
  job_type         text  not null,
  payload          jsonb not null default '{}'::jsonb,
  error            jsonb not null default '{}'::jsonb,
  attempts         integer not null default 0,
  resolved_at      timestamptz,
  resolution_note  text,
  created_at       timestamptz not null default now()
);

create index if not exists jobs_dead_letter_unresolved_idx
  on jobs_dead_letter (created_at desc) where resolved_at is null;

create index if not exists jobs_dead_letter_client_idx
  on jobs_dead_letter (client_slug, created_at desc);

alter table jobs_dead_letter enable row level security;
do $$ begin
  create policy "service role manages jobs dead letter"
    on jobs_dead_letter for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;


create table if not exists job_client_limits (
  client_slug                    text    primary key,
  max_concurrent_jobs            integer not null default 2,
  max_concurrent_expensive_jobs  integer not null default 1,
  updated_at                     timestamptz not null default now()
);


create table if not exists job_queue_settings (
  queue            text    primary key,
  enabled          boolean not null default true,
  max_concurrent   integer not null default 10,
  degradation_mode text    not null default 'normal'
                   check (degradation_mode in ('normal', 'protect_margin', 'critical_only', 'read_only')),
  updated_at       timestamptz not null default now()
);

insert into job_queue_settings (queue, enabled, max_concurrent, degradation_mode) values
  ('default',      true, 10, 'normal'),
  ('integrations', true,  4, 'normal'),
  ('generation',   true,  3, 'normal'),
  ('crawl',        true,  3, 'normal')
on conflict (queue) do nothing;


create or replace function is_expensive_job(p_job_type text)
returns boolean language sql immutable as $$
  select p_job_type in ('homepage_generation', 'seo_generation', 'crawl_website', 'printify_sync');
$$;

-- claim_jobs: atomic lock — skips locked rows, respects per-client concurrency limits.
-- Call via RPC: select * from claim_jobs('default', 'worker-1', 1)
create or replace function claim_jobs(
  p_queue      text    default 'default',
  p_worker_id  text    default 'worker',
  p_limit      integer default 1,
  p_stale_after interval default interval '10 minutes'
)
returns setof jobs
language plpgsql
security definer
as $$
declare
  v_queue_enabled boolean;
  v_queue_max     integer;
  v_mode          text;
begin
  select coalesce(enabled, true), coalesce(max_concurrent, 10), coalesce(degradation_mode, 'normal')
    into v_queue_enabled, v_queue_max, v_mode
  from job_queue_settings
  where queue = p_queue;

  if v_queue_enabled is false or v_mode = 'read_only' then
    return;
  end if;

  return query
  with queue_running as (
    select count(*)::int as n from jobs where queue = p_queue and status = 'running'
  ), candidates as (
    select j.id
    from jobs j
    left join job_client_limits l on l.client_slug = j.client_slug
    where j.queue = p_queue
      and (
        j.status in ('queued', 'retrying')
        or (
          j.status = 'running'
          and j.locked_at is not null
          and j.locked_at < now() - p_stale_after
          and j.attempts < j.max_attempts
        )
      )
      and j.run_after <= now()
      and (v_mode <> 'critical_only' or j.priority <= 50 or j.job_type = 'emergency_fix')
      and (select n from queue_running) < v_queue_max
      and (
        j.client_slug is null
        or (
          select count(*) from jobs r
          where r.client_slug = j.client_slug and r.status = 'running'
        ) < coalesce(l.max_concurrent_jobs, 2)
      )
      and (
        not is_expensive_job(j.job_type)
        or j.client_slug is null
        or (
          select count(*) from jobs r
          where r.client_slug = j.client_slug and r.status = 'running'
            and is_expensive_job(r.job_type)
        ) < coalesce(l.max_concurrent_expensive_jobs, 1)
      )
    order by j.priority asc, j.run_after asc, j.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 1), 25))
  )
  update jobs j
  set status           = 'running',
      attempts         = attempts + 1,
      locked_at        = now(),
      locked_by        = p_worker_id,
      started_at       = coalesce(started_at, now()),
      last_heartbeat_at = now(),
      progress_percent = coalesce(progress_percent, 0),
      progress_stage   = coalesce(progress_stage, 'claimed'),
      degradation_mode = v_mode
  from candidates c
  where j.id = c.id
  returning j.*;
end;
$$;

grant execute on function public.claim_jobs(text, text, integer, interval) to service_role;

create or replace view job_queue_health as
select
  queue,
  status,
  count(*)::int as job_count,
  min(created_at) as oldest_created_at,
  min(run_after) as next_run_after
from jobs
group by queue, status
order by queue, status;


-- ============================================================
-- SECTION 6: AI THROUGHPUT GUARD
-- ============================================================

create table if not exists ai_rate_limit_windows (
  bucket_start    timestamptz not null,
  scope           text        not null check (scope in ('global', 'client')),
  scope_key       text        not null,
  model           text        not null default 'all',
  requests_count  integer     not null default 0,
  input_tokens    integer     not null default 0,
  output_tokens   integer     not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (bucket_start, scope, scope_key, model)
);

create index if not exists ai_rate_limit_windows_recent_idx
  on ai_rate_limit_windows (bucket_start desc, scope, scope_key);


create table if not exists ai_usage_events (
  id                       uuid    primary key default gen_random_uuid(),
  created_at               timestamptz not null default now(),
  bucket_start             timestamptz not null,
  client_slug              text    not null,
  model                    text    not null,
  request_class            text    not null,
  estimated_input_tokens   integer not null default 0,
  estimated_output_tokens  integer not null default 0,
  allowed                  boolean not null default false,
  reason                   text,
  usage_json               jsonb   not null default '{}'::jsonb
);

create index if not exists ai_usage_events_created_idx
  on ai_usage_events (created_at desc);

create index if not exists ai_usage_events_client_created_idx
  on ai_usage_events (client_slug, created_at desc);


-- formaut_acquire_ai_capacity: per-minute token budget check.
-- Returns {allowed, reason, retry_after_seconds, usage}.
create or replace function formaut_acquire_ai_capacity(
  p_client_slug              text,
  p_model                    text,
  p_request_class            text,
  p_estimated_input_tokens   integer,
  p_estimated_output_tokens  integer,
  p_client_request_limit     integer default 5,
  p_client_input_token_limit integer default 60000,
  p_client_output_token_limit integer default 20000,
  p_global_request_limit     integer default 45,
  p_global_input_token_limit integer default 450000,
  p_global_output_token_limit integer default 150000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket     timestamptz := date_trunc('minute', now());
  v_client_slug text := coalesce(nullif(p_client_slug, ''), 'unknown');
  v_model       text := coalesce(nullif(p_model, ''), 'unknown');
  v_request_class text := coalesce(nullif(p_request_class, ''), 'unknown');
  v_input       integer := greatest(coalesce(p_estimated_input_tokens, 0), 0);
  v_output      integer := greatest(coalesce(p_estimated_output_tokens, 0), 0);
  v_global      ai_rate_limit_windows%rowtype;
  v_client      ai_rate_limit_windows%rowtype;
  v_allowed     boolean := true;
  v_reason      text := null;
  v_retry_after integer := 60 - extract(second from now())::integer;
begin
  perform pg_advisory_xact_lock(hashtext('formaut_ai_capacity:' || v_bucket::text));

  insert into ai_rate_limit_windows (bucket_start, scope, scope_key, model)
    values (v_bucket, 'global', 'all', 'all') on conflict do nothing;
  insert into ai_rate_limit_windows (bucket_start, scope, scope_key, model)
    values (v_bucket, 'client', v_client_slug, 'all') on conflict do nothing;

  select * into v_global from ai_rate_limit_windows
    where bucket_start = v_bucket and scope = 'global' and scope_key = 'all' and model = 'all' for update;
  select * into v_client from ai_rate_limit_windows
    where bucket_start = v_bucket and scope = 'client' and scope_key = v_client_slug and model = 'all' for update;

  if    v_client.requests_count + 1 > p_client_request_limit     then v_allowed := false; v_reason := 'client_request_limit';
  elsif v_client.input_tokens  + v_input  > p_client_input_token_limit  then v_allowed := false; v_reason := 'client_input_token_limit';
  elsif v_client.output_tokens + v_output > p_client_output_token_limit then v_allowed := false; v_reason := 'client_output_token_limit';
  elsif v_global.requests_count + 1 > p_global_request_limit     then v_allowed := false; v_reason := 'global_request_limit';
  elsif v_global.input_tokens  + v_input  > p_global_input_token_limit  then v_allowed := false; v_reason := 'global_input_token_limit';
  elsif v_global.output_tokens + v_output > p_global_output_token_limit then v_allowed := false; v_reason := 'global_output_token_limit';
  end if;

  if v_allowed then
    update ai_rate_limit_windows
      set requests_count = requests_count + 1, input_tokens = input_tokens + v_input,
          output_tokens = output_tokens + v_output, updated_at = now()
      where bucket_start = v_bucket and scope = 'global' and scope_key = 'all' and model = 'all';
    update ai_rate_limit_windows
      set requests_count = requests_count + 1, input_tokens = input_tokens + v_input,
          output_tokens = output_tokens + v_output, updated_at = now()
      where bucket_start = v_bucket and scope = 'client' and scope_key = v_client_slug and model = 'all';
  end if;

  insert into ai_usage_events (bucket_start, client_slug, model, request_class,
    estimated_input_tokens, estimated_output_tokens, allowed, reason, usage_json)
  values (v_bucket, v_client_slug, v_model, v_request_class, v_input, v_output, v_allowed, v_reason,
    jsonb_build_object('client_before', to_jsonb(v_client), 'global_before', to_jsonb(v_global)));

  return jsonb_build_object(
    'allowed', v_allowed, 'reason', v_reason,
    'retry_after_seconds', greatest(v_retry_after, 1),
    'usage', jsonb_build_object(
      'bucket_start', v_bucket,
      'client', jsonb_build_object(
        'requests',      case when v_allowed then v_client.requests_count + 1 else v_client.requests_count end,
        'input_tokens',  case when v_allowed then v_client.input_tokens + v_input  else v_client.input_tokens end,
        'output_tokens', case when v_allowed then v_client.output_tokens + v_output else v_client.output_tokens end),
      'global', jsonb_build_object(
        'requests',      case when v_allowed then v_global.requests_count + 1 else v_global.requests_count end,
        'input_tokens',  case when v_allowed then v_global.input_tokens + v_input  else v_global.input_tokens end,
        'output_tokens', case when v_allowed then v_global.output_tokens + v_output else v_global.output_tokens end)
    )
  );
end;
$$;

create or replace view ai_usage_last_hour as
select client_slug, model, request_class,
  count(*)  filter (where allowed)     as allowed_calls,
  count(*)  filter (where not allowed) as blocked_calls,
  sum(estimated_input_tokens)  filter (where allowed) as reserved_input_tokens,
  sum(estimated_output_tokens) filter (where allowed) as reserved_output_tokens,
  max(created_at) as latest_event_at
from ai_usage_events
where created_at >= now() - interval '1 hour'
group by client_slug, model, request_class;


-- ============================================================
-- SECTION 7: AI GATEWAY TRACING + WORKFLOWS
-- ============================================================

create table if not exists ai_gateway_traces (
  id                  uuid  primary key default gen_random_uuid(),
  trace_id            text  not null unique,
  slug                text,
  session_id          text,
  intent_type         text,
  selected_model      text,
  should_call_llm     boolean not null default false,
  decision            text  not null,
  estimated_cost_cents numeric not null default 0,
  request_fingerprint text,
  cache_hit           boolean not null default false,
  scope_category      text,
  trace_json          jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists ai_gateway_traces_slug_created_idx
  on ai_gateway_traces (slug, created_at desc);

create index if not exists ai_gateway_traces_fingerprint_idx
  on ai_gateway_traces (request_fingerprint);


create table if not exists ai_gateway_response_cache (
  id                  uuid  primary key default gen_random_uuid(),
  request_fingerprint text  not null unique,
  slug                text,
  model               text,
  response            text  not null,
  metadata            jsonb not null default '{}'::jsonb,
  hit_count           integer not null default 0,
  last_hit_at         timestamptz,
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists ai_gateway_response_cache_slug_idx   on ai_gateway_response_cache (slug);
create index if not exists ai_gateway_response_cache_expiry_idx on ai_gateway_response_cache (expires_at);

drop trigger if exists ai_gateway_response_cache_touch on ai_gateway_response_cache;
create trigger ai_gateway_response_cache_touch
before update on ai_gateway_response_cache
for each row execute function touch_updated_at();


create table if not exists ai_gateway_completions (
  id                  uuid    primary key default gen_random_uuid(),
  trace_id            text,
  slug                text,
  session_id          text,
  request_fingerprint text,
  model               text,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cache_read_tokens   integer not null default 0,
  cache_write_tokens  integer not null default 0,
  cost_cents          numeric not null default 0,
  response_preview    text,
  metadata            jsonb   not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists ai_gateway_completions_slug_created_idx
  on ai_gateway_completions (slug, created_at desc);

create or replace view ai_gateway_monthly_spend as
select slug, date_trunc('month', created_at)::date as month,
  sum(cost_cents)::numeric as cost_cents,
  sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
  sum(cache_read_tokens) as cache_read_tokens, sum(cache_write_tokens) as cache_write_tokens,
  count(*) as completion_count
from ai_gateway_completions
group by slug, date_trunc('month', created_at)::date;


create table if not exists workflows (
  id                  uuid  primary key default gen_random_uuid(),
  workflow_type       text  not null,
  client_id           uuid  references clients(id) on delete cascade,
  client_slug         text,
  session_id          text,
  status              text  not null default 'running',
  current_step_index  integer not null default 0,
  input               jsonb not null default '{}'::jsonb,
  steps               jsonb not null default '[]'::jsonb,
  blocked_reason      text,
  created_by          text,
  finished_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists workflows_slug_status_idx
  on workflows (client_slug, status, created_at desc);

drop trigger if exists workflows_touch on workflows;
create trigger workflows_touch
before update on workflows
for each row execute function touch_updated_at();


create table if not exists workflow_events (
  id          uuid  primary key default gen_random_uuid(),
  workflow_id uuid  not null references workflows(id) on delete cascade,
  type        text  not null,
  step_key    text,
  job_id      uuid  references jobs(id) on delete set null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists workflow_events_workflow_idx
  on workflow_events (workflow_id, created_at asc);


-- ============================================================
-- SECTION 8: ARTIFACT PIPELINE
-- ============================================================
-- artifact_versions is the immutable content store. Each generated/approved
-- artifact becomes a row here. artifact_reviews gates publishing.
-- The old `job_artifacts` table is NOT used by the current artifact pipeline.

create table if not exists artifact_versions (
  id                           uuid    primary key default gen_random_uuid(),
  client_id                    uuid    references clients(id) on delete cascade,
  client_slug                  text,
  environment                  text    not null default 'production',
  artifact_type                text    not null,  -- 'homepage' | 'seo' | 'sitemap' | 'robots' | 'section' | ...
  artifact_key                 text    not null default 'default',
  version_number               integer not null default 1,
  content_hash                 text,
  content                      jsonb   not null default '{}'::jsonb,
  metadata                     jsonb   not null default '{}'::jsonb,
  source_job_id                uuid    references jobs(id) on delete set null,
  parent_version_id            uuid    references artifact_versions(id) on delete set null,
  base_live_version_id         uuid    references artifact_versions(id) on delete set null,
  diff_summary                 text,
  diff_json                    jsonb,
  status                       text    not null default 'pending_review'
                               check (status in ('pending_review', 'approved', 'published', 'superseded', 'rejected', 'rolled_back')),
  requires_review              boolean not null default true,
  previous_content             jsonb,
  previous_sha                 text,
  commit_sha                   text,
  created_by                   text,
  reviewed_at                  timestamptz,
  reviewed_by                  text,
  published_at                 timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create index if not exists artifact_versions_client_type_idx
  on artifact_versions (client_slug, artifact_type, status, created_at desc);

create index if not exists artifact_versions_client_id_idx
  on artifact_versions (client_id, artifact_type, created_at desc);

create index if not exists artifact_versions_status_idx
  on artifact_versions (status, created_at desc);

drop trigger if exists artifact_versions_touch on artifact_versions;
create trigger artifact_versions_touch
before update on artifact_versions
for each row execute function touch_updated_at();


create table if not exists artifact_dependencies (
  id                        uuid  primary key default gen_random_uuid(),
  client_id                 uuid  references clients(id) on delete cascade,
  client_slug               text,
  source_artifact_type      text  not null,
  source_key                text  not null,
  dependent_artifact_type   text  not null,
  invalidation_policy       text  not null default 'stale_requires_regeneration'
                            check (invalidation_policy in ('stale_requires_regeneration', 'stale_optional_regeneration', 'publish_block_only')),
  reason                    text,
  is_active                 boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create unique index if not exists ux_artifact_dependencies_scope
  on artifact_dependencies (coalesce(client_id::text,''), coalesce(client_slug,''),
    source_artifact_type, source_key, dependent_artifact_type);

create index if not exists idx_artifact_dependencies_source
  on artifact_dependencies (source_artifact_type, source_key, is_active);

-- Global dependency seed — defines what regenerates what when profile changes.
insert into artifact_dependencies (source_artifact_type, source_key, dependent_artifact_type, invalidation_policy, reason) values
  ('business_profile','brand_voice',          'homepage','stale_requires_regeneration','Brand voice affects homepage copy, tone, and CTAs.'),
  ('business_profile','brand_tone',           'homepage','stale_requires_regeneration','Brand tone affects homepage copy and section treatment.'),
  ('business_profile','services',             'homepage','stale_requires_regeneration','Service changes affect homepage service cards.'),
  ('business_profile','visual_style',         'homepage','stale_requires_regeneration','Visual style changes affect homepage layout.'),
  ('business_profile','target_customer',      'homepage','stale_requires_regeneration','Audience changes affect message framing.'),
  ('business_profile','key_differentiators',  'homepage','stale_requires_regeneration','Differentiator changes affect positioning sections.'),
  ('business_profile','brand_voice',          'seo',     'stale_requires_regeneration','SEO titles/descriptions should match brand voice.'),
  ('business_profile','services',             'seo',     'stale_requires_regeneration','Service changes affect SEO keywords.'),
  ('business_profile','location',             'seo',     'stale_requires_regeneration','Location changes affect local SEO metadata.'),
  ('artifact',        'homepage',             'seo',     'stale_requires_regeneration','SEO should reflect current homepage content.'),
  ('artifact',        'homepage',             'sitemap', 'stale_requires_regeneration','Sitemap must reflect current live pages.'),
  ('integration',     'printify.products',    'homepage','stale_optional_regeneration','Product catalog updates may affect featured sections.'),
  ('integration',     'printify.products',    'seo',     'stale_optional_regeneration','Product catalog updates may affect SEO metadata.')
on conflict do nothing;


create table if not exists artifact_lineage (
  id              uuid  primary key default gen_random_uuid(),
  client_id       uuid  references clients(id) on delete cascade,
  client_slug     text,
  artifact_type   text  not null,
  artifact_key    text,
  event_type      text  not null,
  event_source    text  not null default 'system',
  change_summary  text,
  parent_event_id uuid  references artifact_lineage(id) on delete set null,
  job_id          uuid  references jobs(id) on delete set null,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists idx_artifact_lineage_client_time
  on artifact_lineage (client_id, client_slug, created_at desc);

create index if not exists idx_artifact_lineage_artifact_time
  on artifact_lineage (artifact_type, created_at desc);

alter table artifact_lineage enable row level security;
do $$ begin
  create policy "deny anon: artifact_lineage"
    on artifact_lineage for all to anon using (false) with check (false);
exception when duplicate_object then null; end $$;


create table if not exists deployment_state (
  id                       uuid  primary key default gen_random_uuid(),
  client_id                uuid  references clients(id) on delete cascade,
  client_slug              text,
  environment              text  not null default 'production',
  artifact_type            text  not null,
  status                   text  not null default 'unknown'
                           check (status in ('unknown','fresh','stale','regenerating','pending_review','ready_for_publish','published','blocked','failed')),
  deployed_version         text,
  pending_version          text,
  stale_reason             text,
  stale_source_type        text,
  stale_source_key         text,
  review_required          boolean not null default false,
  publish_blocked          boolean not null default false,
  publish_blocker_reason   text,
  latest_lineage_event_id  uuid  references artifact_lineage(id) on delete set null,
  reviewed_at              timestamptz,
  reviewed_by              text,
  published_at             timestamptz,
  last_checked_at          timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create unique index if not exists ux_deployment_state_scope
  on deployment_state (coalesce(client_id::text,''), coalesce(client_slug,''), environment, artifact_type);

create index if not exists idx_deployment_state_client
  on deployment_state (client_id, client_slug, environment);

create index if not exists idx_deployment_state_blockers
  on deployment_state (publish_blocked, review_required, updated_at desc);

alter table deployment_state enable row level security;
do $$ begin
  create policy "deny anon: deployment_state"
    on deployment_state for all to anon using (false) with check (false);
exception when duplicate_object then null; end $$;

drop trigger if exists deployment_state_touch on deployment_state;
create trigger deployment_state_touch
before update on deployment_state
for each row execute function touch_updated_at();

create or replace view deployment_publish_blockers as
select id, client_id, client_slug, environment, artifact_type, status,
  stale_reason, stale_source_type, stale_source_key, publish_blocker_reason,
  latest_lineage_event_id, updated_at
from deployment_state
where publish_blocked = true or review_required = true
   or status in ('stale', 'blocked', 'failed');


-- publish_transactions: records the actual GitHub commit + deploy for each publish.
create table if not exists publish_transactions (
  id                  uuid  primary key default gen_random_uuid(),
  client_id           uuid  references clients(id) on delete cascade,
  client_slug         text,
  artifact_version_id uuid  references artifact_versions(id) on delete set null,
  artifact_type       text  not null,
  commit_sha          text,
  deployment_id       text,
  live_url            text,
  status              text  not null default 'pending'
                      check (status in ('pending','committed','deployed','failed','rolled_back')),
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists publish_transactions_client_idx
  on publish_transactions (client_slug, created_at desc);

drop trigger if exists publish_transactions_touch on publish_transactions;
create trigger publish_transactions_touch
before update on publish_transactions
for each row execute function touch_updated_at();


-- operational_lineage_events: audit trail for MCP autonomous ops.
create table if not exists operational_lineage_events (
  id          uuid  primary key default gen_random_uuid(),
  client_id   uuid  references clients(id) on delete cascade,
  client_slug text  not null,
  event_type  text  not null,
  source      text,
  source_id   text,
  summary     text,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists operational_lineage_events_client_created_idx
  on operational_lineage_events (client_slug, created_at desc);


-- ============================================================
-- SECTION 9: REVIEW + CHANGE CONTROL
-- ============================================================
-- artifact_reviews references artifact_versions (not job_artifacts).

create table if not exists artifact_reviews (
  id                    uuid  primary key default gen_random_uuid(),
  artifact_version_id   uuid  not null references artifact_versions(id) on delete cascade,
  client_id             uuid  references clients(id) on delete cascade,
  client_slug           text,
  artifact_type         text,
  review_type           text  not null default 'publish_gate',
  title                 text,
  summary               text,
  status                text  not null default 'pending'
                        check (status in ('pending','approved','rejected','revision_requested','superseded','rolled_back')),
  proposed_change       jsonb not null default '{}'::jsonb,
  decision_note         text,
  decided_by            text,
  decided_at            timestamptz,
  approved_at           timestamptz,
  rejected_at           timestamptz,
  review_reason         text,
  requested_by          text,
  created_by            text  not null default 'dashboard',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists artifact_reviews_client_idx
  on artifact_reviews (client_slug, status, created_at desc);

create index if not exists artifact_reviews_version_idx
  on artifact_reviews (artifact_version_id, created_at desc);

drop trigger if exists artifact_reviews_touch on artifact_reviews;
create trigger artifact_reviews_touch
before update on artifact_reviews
for each row execute function touch_updated_at();

create or replace view pending_artifact_reviews as
select r.id, r.client_slug, r.review_type, r.title, r.summary, r.status,
  r.created_at, r.artifact_type,
  v.version_number, v.diff_summary, v.metadata
from artifact_reviews r
join artifact_versions v on v.id = r.artifact_version_id
where r.status = 'pending'
order by r.created_at desc;


create table if not exists site_version_snapshots (
  id           uuid  primary key default gen_random_uuid(),
  client_id    uuid  references clients(id) on delete cascade,
  client_slug  text  not null,
  source       text  not null default 'manual',
  title        text,
  summary      text,
  site_state_json jsonb not null default '{}'::jsonb,
  storage_url  text,
  git_ref      text,
  created_by   text  not null default 'dashboard',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists site_version_snapshots_client_idx
  on site_version_snapshots (client_slug, created_at desc);

drop trigger if exists site_version_snapshots_touch on site_version_snapshots;
create trigger site_version_snapshots_touch
before update on site_version_snapshots
for each row execute function touch_updated_at();


create table if not exists change_log (
  id           uuid  primary key default gen_random_uuid(),
  client_id    uuid  references clients(id) on delete cascade,
  client_slug  text,
  version_id   uuid  references artifact_versions(id) on delete set null,
  review_id    uuid  references artifact_reviews(id) on delete set null,
  snapshot_id  uuid  references site_version_snapshots(id) on delete set null,
  change_type  text  not null,
  status       text  not null default 'proposed'
               check (status in ('proposed','approved','applied','reverted','failed')),
  title        text,
  summary      text,
  before_json  jsonb,
  after_json   jsonb,
  created_by   text  not null default 'system',
  created_at   timestamptz not null default now()
);

create index if not exists change_log_client_idx on change_log (client_slug, created_at desc);
create index if not exists change_log_review_idx on change_log (review_id, created_at desc);


create table if not exists publish_requests (
  id                   uuid  primary key default gen_random_uuid(),
  client_id            uuid  references clients(id) on delete cascade,
  client_slug          text,
  artifact_review_id   uuid  references artifact_reviews(id) on delete set null,
  snapshot_id          uuid  references site_version_snapshots(id) on delete set null,
  status               text  not null default 'blocked'
                       check (status in ('blocked','ready','publishing','published','failed','cancelled')),
  gate_result          jsonb not null default '{}'::jsonb,
  requested_by         text  not null default 'dashboard',
  published_at         timestamptz,
  error                jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists publish_requests_client_idx
  on publish_requests (client_slug, status, created_at desc);

drop trigger if exists publish_requests_touch on publish_requests;
create trigger publish_requests_touch
before update on publish_requests
for each row execute function touch_updated_at();


-- ============================================================
-- SECTION 10: OPERATIONAL MAINTENANCE
-- ============================================================

-- Authoritative operational_events definition.
-- Merges: schema-additions.sql + operational-and-provisioning-additions.sql +
-- formaut-sql-client-id-fix.sql. Pick this over the other versions.
create table if not exists operational_events (
  id              uuid    primary key default gen_random_uuid(),
  client_id       uuid    references clients(id) on delete cascade,
  client_slug     text    not null,
  event_type      text    not null,
  severity        text    not null default 'info'
                  check (severity in ('critical', 'warn', 'info')),
  source          text    not null,
  status          text    not null default 'open'
                  check (status in ('open', 'acknowledged', 'resolved')),
  dedup_key       text,
  auto_remediable boolean not null default false,
  remediation_job text,
  payload         jsonb   not null default '{}'::jsonb,
  resolved_at     timestamptz,
  resolved_by     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists operational_events_client_id_idx    on operational_events (client_id);
create index if not exists operational_events_client_slug_idx  on operational_events (client_slug, created_at desc);
create index if not exists operational_events_dedup_key_idx    on operational_events (dedup_key);
create index if not exists operational_events_status_created_idx on operational_events (status, created_at desc);

drop trigger if exists operational_events_updated_at on operational_events;
create trigger operational_events_updated_at
before update on operational_events
for each row execute function touch_updated_at();


create table if not exists operational_remediation_plans (
  id              uuid  primary key default gen_random_uuid(),
  client_id       uuid  references clients(id) on delete cascade,
  client_slug     text  not null,
  event_id        uuid  references operational_events(id) on delete set null,
  event_type      text,
  risk_level      text  not null
                  check (risk_level in ('safe', 'review_required', 'dangerous')),
  job_type        text,
  job_payload     jsonb not null default '{}'::jsonb,
  description     text,
  rationale       text,
  status          text  not null default 'pending'
                  check (status in ('pending', 'queued', 'rejected', 'completed', 'skipped')),
  queued_at       timestamptz,
  queued_job_id   uuid  references jobs(id) on delete set null,
  approved        boolean not null default false,
  executed        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists remediation_plans_client_id_idx  on operational_remediation_plans (client_id);
create index if not exists remediation_plans_client_slug_idx on operational_remediation_plans (client_slug, created_at desc);
create index if not exists remediation_plans_status_idx     on operational_remediation_plans (status);
create index if not exists remediation_plans_risk_level_idx on operational_remediation_plans (risk_level, status);

drop trigger if exists operational_remediation_plans_updated_at on operational_remediation_plans;
create trigger operational_remediation_plans_updated_at
before update on operational_remediation_plans
for each row execute function touch_updated_at();


create table if not exists provisioning_log (
  id            uuid  primary key default gen_random_uuid(),
  client_id     uuid  references clients(id) on delete cascade,
  client_slug   text  not null,
  resource_type text  not null,
  resource_key  text  not null,
  resource_id   text,
  resource_url  text,
  operation     text  not null,
  status        text  not null
                check (status in ('pending', 'succeeded', 'failed', 'torn_down')),
  payload       jsonb not null default '{}'::jsonb,
  response      jsonb,
  error         jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists provisioning_log_client_id_idx   on provisioning_log (client_id);
create index if not exists provisioning_log_client_slug_idx on provisioning_log (client_slug);
create index if not exists provisioning_log_resource_key_idx
  on provisioning_log (client_id, resource_type, resource_key, status);
create index if not exists provisioning_log_created_at_idx  on provisioning_log (created_at desc);

create unique index if not exists provisioning_log_succeeded_unique_idx
  on provisioning_log (client_id, resource_type, resource_key)
  where status = 'succeeded' and client_id is not null;

drop trigger if exists provisioning_log_updated_at on provisioning_log;
create trigger provisioning_log_updated_at
before update on provisioning_log
for each row execute function touch_updated_at();


create table if not exists deployment_health_checks (
  id              uuid    primary key default gen_random_uuid(),
  client_id       uuid    references clients(id) on delete cascade,
  client_slug     text    not null,
  deployment_id   text,
  synthetic_ok    boolean not null default false,
  seo_ok          boolean not null default false,
  routes_ok       boolean not null default false,
  integrations_ok boolean not null default true,
  details         jsonb   not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists deployment_health_client_created_idx
  on deployment_health_checks (client_slug, created_at desc);


create table if not exists maintenance_checks (
  id             uuid    primary key default gen_random_uuid(),
  client_id      uuid    references clients(id) on delete cascade,
  client_slug    text,
  check_type     text    not null,
  cadence_minutes integer not null default 60,
  severity       text    not null default 'warning',
  priority       integer not null default 100,
  config         jsonb   not null default '{}'::jsonb,
  enabled        boolean not null default true,
  last_queued_at timestamptz,
  last_run_at    timestamptz,
  last_status    text,
  last_event_id  uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint maintenance_checks_client_required check (client_id is not null or client_slug is not null),
  constraint maintenance_checks_unique unique (client_slug, check_type)
);

create index if not exists maintenance_checks_due_idx
  on maintenance_checks (enabled, priority, last_queued_at, last_run_at);


create table if not exists maintenance_events (
  id                    uuid  primary key default gen_random_uuid(),
  client_id             uuid  references clients(id) on delete cascade,
  client_slug           text,
  maintenance_check_id  uuid  references maintenance_checks(id) on delete set null,
  source_job_id         uuid  references jobs(id) on delete set null,
  check_type            text  not null,
  status                text  not null default 'unknown',
  severity              text  not null default 'info',
  summary               text  not null,
  observed              jsonb not null default '{}'::jsonb,
  expected              jsonb not null default '{}'::jsonb,
  evidence              jsonb not null default '{}'::jsonb,
  needs_remediation     boolean not null default false,
  requires_approval     boolean not null default false,
  acknowledged_at       timestamptz,
  acknowledged_by       text,
  resolved_at           timestamptz,
  resolved_by           text,
  created_at            timestamptz not null default now()
);

create index if not exists maintenance_events_client_slug_idx
  on maintenance_events (client_slug, created_at desc);

create index if not exists maintenance_events_status_idx
  on maintenance_events (status, severity, created_at desc);


create table if not exists maintenance_state (
  id               uuid  primary key default gen_random_uuid(),
  client_id        uuid  references clients(id) on delete cascade,
  client_slug      text,
  check_type       text  not null,
  status           text  not null default 'unknown',
  severity         text  not null default 'info',
  summary          text,
  last_event_id    uuid,
  requires_approval boolean not null default false,
  updated_at       timestamptz not null default now(),
  constraint maintenance_state_client_required check (client_id is not null or client_slug is not null),
  constraint maintenance_state_unique unique (client_slug, check_type)
);

create index if not exists maintenance_state_client_slug_idx
  on maintenance_state (client_slug, updated_at desc);


create table if not exists maintenance_remediation_plans (
  id                   uuid  primary key default gen_random_uuid(),
  client_id            uuid  references clients(id) on delete cascade,
  client_slug          text,
  maintenance_event_id uuid  references maintenance_events(id) on delete set null,
  check_type           text  not null,
  severity             text  not null default 'warning',
  plan_status          text  not null default 'pending_approval',
  requires_approval    boolean not null default true,
  approval_reason      text,
  actions              jsonb not null default '[]'::jsonb,
  risk_level           text  not null default 'medium',
  approved_at          timestamptz,
  approved_by          text,
  executed_at          timestamptz,
  execution_result     jsonb,
  created_by           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists maintenance_remediation_client_slug_idx
  on maintenance_remediation_plans (client_slug, created_at desc);

create index if not exists maintenance_remediation_status_idx
  on maintenance_remediation_plans (plan_status, requires_approval, created_at desc);


create or replace view operational_review_queue as
select id, client_slug, event_type, risk_level, job_type, job_payload,
  description, rationale, status, approved, executed, created_at, updated_at
from operational_remediation_plans
where risk_level <> 'safe' and executed = false
order by created_at asc;

create or replace view operational_health_dashboard as
select
  c.slug as client_slug,
  max(e.created_at) as last_event_at,
  count(e.id) filter (where e.created_at > now() - interval '24 hours') as events_24h,
  count(e.id) filter (where e.severity = 'critical' and e.created_at > now() - interval '24 hours') as critical_events_24h,
  count(p.id) filter (where p.executed = false and p.risk_level <> 'safe') as open_review_items,
  max(h.created_at) as last_health_check_at,
  (array_agg(h.routes_ok     order by h.created_at desc))[1] as latest_routes_ok,
  (array_agg(h.seo_ok        order by h.created_at desc))[1] as latest_seo_ok,
  (array_agg(h.synthetic_ok  order by h.created_at desc))[1] as latest_synthetic_ok
from clients c
left join operational_events e             on e.client_slug = c.slug
left join operational_remediation_plans p  on p.client_slug = c.slug
left join deployment_health_checks h       on h.client_slug = c.slug
group by c.slug;


-- ============================================================
-- SECTION 11: EMAIL PLATFORM
-- ============================================================

create table if not exists email_templates (
  id               uuid  primary key default gen_random_uuid(),
  client_id        uuid  not null references clients(id) on delete cascade,
  scenario_id      text  not null,
  template_family  text  not null,
  label            text,
  subject          text,
  html_content     text  not null,
  copy_data        jsonb,
  status           text  not null default 'staged'
                   check (status in ('staged', 'active', 'archived', 'rejected')),
  requires_approval boolean not null default false,
  approved_at      timestamptz,
  approved_by      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_email_templates_client_scenario
  on email_templates (client_id, scenario_id, status);

create unique index if not exists uq_email_templates_active
  on email_templates (client_id, scenario_id)
  where status = 'active';

drop trigger if exists email_templates_touch on email_templates;
create trigger email_templates_touch
before update on email_templates
for each row execute function touch_updated_at();


create table if not exists email_rules (
  id               uuid  primary key default gen_random_uuid(),
  client_id        uuid  not null references clients(id) on delete cascade,
  scenario_id      text  not null,
  label            text,
  status           text  not null default 'draft'
                   check (status in ('draft', 'active', 'paused', 'archived')),
  provider         text  not null,
  template_id      uuid  references email_templates(id),
  trigger_config   jsonb,
  provider_config  jsonb,
  compliance       jsonb,
  requires_approval boolean not null default false,
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_email_rules_client   on email_rules (client_id, status);
create index if not exists idx_email_rules_scenario on email_rules (client_id, scenario_id);

drop trigger if exists email_rules_touch on email_rules;
create trigger email_rules_touch
before update on email_rules
for each row execute function touch_updated_at();


create table if not exists email_send_log (
  id           uuid  primary key default gen_random_uuid(),
  client_id    uuid  not null references clients(id) on delete cascade,
  scenario_id  text,
  rule_id      uuid  references email_rules(id),
  template_id  uuid  references email_templates(id),
  provider     text  not null default 'resend',
  message_id   text,
  to_address   text  not null,
  from_address text  not null,
  subject      text,
  status       text  not null default 'sent'
               check (status in ('sent', 'delivered', 'bounced', 'failed', 'spam')),
  error        text,
  sent_at      timestamptz not null default now()
);

create index if not exists idx_email_send_log_client   on email_send_log (client_id, sent_at desc);
create index if not exists idx_email_send_log_scenario on email_send_log (client_id, scenario_id, sent_at desc);

alter table email_templates enable row level security;
alter table email_rules      enable row level security;
alter table email_send_log   enable row level security;

do $$ begin
  create policy "deny anon: email_templates" on email_templates for all to anon using (false);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "deny anon: email_rules" on email_rules for all to anon using (false);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "deny anon: email_send_log" on email_send_log for all to anon using (false);
exception when duplicate_object then null; end $$;


-- ============================================================
-- SECTION 12: BUSINESS PROFILE
-- ============================================================
-- business_profiles: one profile per client slug. Synced from crawl + memory.

create table if not exists business_profiles (
  id                   uuid  primary key default gen_random_uuid(),
  client_id            uuid  references clients(id) on delete cascade,
  client_slug          text  not null unique,
  business_name        text,
  industry             text,
  business_type        text,
  location             text,
  live_url             text,
  existing_website_url text,
  brand_voice          text,
  brand_tone           text,
  services             jsonb not null default '[]'::jsonb,
  target_customer      text,
  key_differentiators  text[],
  visual_style         text,
  color_palette        jsonb not null default '{}'::jsonb,
  social_links         jsonb not null default '{}'::jsonb,
  contact              jsonb not null default '{}'::jsonb,
  metadata             jsonb not null default '{}'::jsonb,
  profile_completeness integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists business_profiles_client_slug_idx
  on business_profiles (client_slug);

drop trigger if exists business_profiles_touch on business_profiles;
create trigger business_profiles_touch
before update on business_profiles
for each row execute function touch_updated_at();


create table if not exists business_profile_fields (
  id           uuid  primary key default gen_random_uuid(),
  client_slug  text  not null,
  field_name   text  not null,
  value        jsonb not null,
  confidence   numeric(3,2) not null default 0.70,
  source       text,
  status       text  not null default 'active'
               check (status in ('active', 'overridden', 'rejected')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (client_slug, field_name)
);

create index if not exists business_profile_fields_client_field_idx
  on business_profile_fields (client_slug, field_name);

drop trigger if exists business_profile_fields_touch on business_profile_fields;
create trigger business_profile_fields_touch
before update on business_profile_fields
for each row execute function touch_updated_at();


create table if not exists business_profile_events (
  id          uuid  primary key default gen_random_uuid(),
  client_slug text  not null,
  event_type  text  not null,
  field_name  text,
  old_value   jsonb,
  new_value   jsonb,
  source      text,
  session_id  text,
  created_at  timestamptz not null default now()
);

create index if not exists business_profile_events_client_idx
  on business_profile_events (client_slug, created_at desc);


create table if not exists business_profile_sources (
  id           uuid  primary key default gen_random_uuid(),
  client_slug  text  not null,
  source_type  text  not null,  -- 'crawl' | 'conversation' | 'manual'
  source_url   text,
  crawled_at   timestamptz,
  raw_data     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists business_profile_sources_client_idx
  on business_profile_sources (client_slug, created_at desc);


-- business_profile_memory: durable per-client memory promoted from signals.
create table if not exists business_profile_memory (
  id          uuid  primary key default gen_random_uuid(),
  client_slug text  not null,
  field_name  text  not null,
  value       jsonb not null,
  confidence  numeric(3,2) not null default 0.70,
  source      text,
  promoted_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_business_profile_memory_client_field
  on business_profile_memory (client_slug, field_name);

drop trigger if exists business_profile_memory_touch on business_profile_memory;
create trigger business_profile_memory_touch
before update on business_profile_memory
for each row execute function touch_updated_at();


-- promote_business_signal additions on signals table
alter table if exists signals
  add column if not exists promoted_at    timestamptz,
  add column if not exists promoted_by    text,
  add column if not exists promoted_field text,
  add column if not exists updated_at     timestamptz default now();


-- ============================================================
-- SECTION 13: DESIGN QUALITY ENGINE
-- ============================================================

create table if not exists design_quality_runs (
  id                       uuid  primary key default gen_random_uuid(),
  client_slug              text,
  industry                 text,
  archetype                text,
  suggested_model          text,
  estimated_prompt_tokens  integer default 0,
  deterministic_preview    boolean default true,
  payload                  jsonb  not null default '{}'::jsonb,
  created_at               timestamptz not null default now()
);

create index if not exists design_quality_runs_client_slug_idx
  on design_quality_runs (client_slug, created_at desc);


-- ============================================================
-- SECTION 14: PERMISSIONS + GRANTS
-- ============================================================

grant usage on schema public to service_role;

grant select, insert, update, delete on table
  public.sessions_index,
  public.signals,
  public.style_signals,
  public.communication_signals,
  public.onboarding_state,
  public.client_onboarding_events,
  public.client_usage,
  public.client_usage_flags,
  public.service_requests,
  public.notification_log,
  public.deployment_events,
  public.credential_events,
  public.client_infrastructure_projects,
  public.linked_projects,
  public.infrastructure_health_checks,
  public.integration_connections,
  public.commerce_products,
  public.integration_sync_events,
  public.jobs,
  public.job_events,
  public.jobs_dead_letter,
  public.job_client_limits,
  public.job_queue_settings,
  public.ai_rate_limit_windows,
  public.ai_usage_events,
  public.ai_gateway_traces,
  public.ai_gateway_response_cache,
  public.ai_gateway_completions,
  public.workflows,
  public.workflow_events,
  public.artifact_versions,
  public.artifact_dependencies,
  public.artifact_lineage,
  public.deployment_state,
  public.publish_transactions,
  public.operational_lineage_events,
  public.artifact_reviews,
  public.site_version_snapshots,
  public.change_log,
  public.publish_requests,
  public.operational_events,
  public.operational_remediation_plans,
  public.provisioning_log,
  public.deployment_health_checks,
  public.maintenance_checks,
  public.maintenance_events,
  public.maintenance_state,
  public.maintenance_remediation_plans,
  public.email_templates,
  public.email_rules,
  public.email_send_log,
  public.business_profiles,
  public.business_profile_fields,
  public.business_profile_events,
  public.business_profile_sources,
  public.business_profile_memory,
  public.design_quality_runs
to service_role;

grant usage, select on all sequences in schema public to service_role;

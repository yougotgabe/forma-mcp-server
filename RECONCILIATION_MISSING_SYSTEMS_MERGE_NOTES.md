# Formaut Repository Reconciliation — Forma.zip + formaut-missing-systems.zip

Generated: May 14, 2026

This archive uses `Forma.zip` as the source-of-truth repository and merges the deliverables from `formaut-missing-systems.zip` into that repo structure.

## Merged platform worker systems

Added and wired:

- `forma-platform-worker/profile-readiness-engine.js`
- `forma-platform-worker/admin-generator/admin-html-generator.js`
- `forma-platform-worker/client-api-token-system.js`
- `forma-platform-worker/subscription-lifecycle.js`
- `forma-platform-worker/notification-dispatcher.js`

`forma-platform-worker/index.js` was updated with imports and routes for:

- `/profile/readiness`
- `/admin-generator/build`
- `/client-api/tokens/create`
- `/client-api/tokens/list`
- `/client-api/tokens/revoke`
- `/client-api/tokens/rotate`
- `/client-api/tokens/verify`
- `/client-api/tokens/audit`
- `/client-api/openapi`
- `/subscription/status`
- `/subscription/check-all`
- `/subscription/reactivate`
- `/notifications/send`
- `/notifications/weekly-digest`
- `/notifications/inactivity-check`

Also added:

- subscription gates before job creation and artifact publishing
- notification dispatch on publish success/failure
- cron calls for subscription lifecycle, inactivity checks, and weekly digest
- Cloudflare-compatible crypto patch for the client API token system
- env compatibility so new modules use either `PLATFORM_SUPABASE_URL` / `PLATFORM_SUPABASE_SERVICE_KEY` or the existing `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`

## Merged dashboard / Pages systems

Added and wired:

- `formaut-site/assets/js/dashboard-api.js`
- `formaut-site/functions/api/client-api/tokens/[[path]].js`
- `formaut-site/functions/api/profile/readiness.js`

Updated:

- `formaut-site/dashboard.html`
  - adds API Access navigation item
  - adds API Access panel and token modals
  - loads `dashboard-build.js`, `dashboard-api.js`, and existing dashboard scripts in order
- `formaut-site/assets/js/dashboard-panels.js`
  - adds `api` panel routing
- `formaut-site/assets/js/dashboard-build.js`
  - adds build readiness check before queuing generation jobs
- `formaut-site/functions/api/jobs/_shared.js`
  - accepts `_token` from dashboard JSON in addition to Authorization header
  - supports either `PLATFORM_WORKER_URL` or `WORKER_URL`

## SQL updates

`forma-platform-worker/sql/platform-schema.sql` now includes a reconciled missing-systems section adding:

- `client_api_tokens`
- `client_api_audit_log`
- subscription lifecycle columns on `clients`
- `subscription_events`
- notification dispatcher compatibility columns on `notification_log`
- service role grants for the new tables

## Validation performed

All JavaScript files in the reconciled output were syntax checked with `node --check`.

## Notes

This is a merged repository archive, not only a patch bundle. You can unzip it and compare/copy it over your current local repo. Before deploy, run your normal install/test/deploy flow and apply the updated platform SQL schema if those missing-systems tables/columns are not already present in Supabase.

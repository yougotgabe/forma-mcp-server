# Formaut Reconciliation Build Notes

This build starts reconciling the repo with the distributed Formaut direction.

## Added systems

### 1. Client runtime plane
- `formaut-client-agent/` — deployable Cloudflare Worker for client-owned runtime checks.
- `shared/event-protocol/` — signed event envelope and event taxonomy.
- `shared/signing/` — Web Crypto HMAC helpers.
- Platform endpoints:
  - `POST /client-agent/register`
  - `POST /client-agent/events/ingest`
  - `POST /client-agent/heartbeat`
  - `POST /client-agent/runtimes`

### 2. AI gateway extraction
Added modular AI gateway policy files under `forma-platform-worker/ai-gateway/`:
- `intent-classifier.js`
- `throughput-policy.js`
- `provider-router.js`
- `model-policy.js`
- `queue-manager.js`
- `profitability-monitor.js`
- `reserve-forecast.js`

The existing gateway now calls the modular throughput/model/provider policy layer without breaking the current smoke test.

### 3. Canonical integration normalization
Added:
- `shared/canonical-entities/schema.js`
- `forma-platform-worker/integration-normalization/`
- `POST /integrations/normalize`

This creates the bridge from provider-specific payloads into Formaut canonical entities.

### 4. Rollout coordination foundation
Added:
- `forma-platform-worker/rollout-system/`
- `POST /rollout/plan`
- `POST /rollout/status`

This starts the compatibility and feature flag layer needed before client-agent scale.

### 5. Platform schema reconciliation
Appended Section 15 to `forma-platform-worker/sql/platform-schema.sql`:
- `client_agent_runtimes`
- `client_agent_events`
- `canonical_entities`
- `rollout_events`

### 6. Dashboard API proxies
Added browser-facing Pages Function proxies:
- `/api/client-agent/register`
- `/api/client-agent/runtimes`
- `/api/integrations/normalize`
- `/api/rollout/plan`
- `/api/rollout/status`

## Validation run

From `forma-platform-worker/`:

```bash
npm run test:ai-gateway
npm run test:workflow-engine
```

Both smoke tests passed after the build.

## Deployment notes

The client agent Worker requires:

```txt
CLIENT_SLUG
FORMAUT_CONTROL_PLANE_URL
FORMAUT_AGENT_SECRET
SITE_URL optional
```

The platform Worker should have the same shared secret value in either:

```txt
FORMAUT_AGENT_SECRET
CLIENT_AGENT_SHARED_SECRET
```

`/client-agent/events/ingest` intentionally bypasses the shared `WORKER_SECRET` gate and relies on signed-event HMAC validation instead. This avoids distributing the platform worker secret to client runtimes.

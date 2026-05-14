import assert from 'node:assert/strict';
import { startWorkflow, advanceWorkflow } from '../workflow/durable-workflow-engine.js';

const rows = { workflows: [], workflow_events: [], jobs: [] };
const env = {};
async function supabase(_env, method, path, body) {
  if (method === 'POST' && path === '/rest/v1/workflows') {
    const row = { id: 'wf_1', ...body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    rows.workflows.push(row);
    return json([row]);
  }
  if (method === 'POST' && path === '/rest/v1/workflow_events') { rows.workflow_events.push(body); return json([]); }
  if (method === 'GET' && path.startsWith('/rest/v1/workflows')) return json(rows.workflows);
  if (method === 'PATCH' && path.startsWith('/rest/v1/workflows')) {
    rows.workflows[0] = { ...rows.workflows[0], ...body };
    return json([rows.workflows[0]]);
  }
  throw new Error(`unexpected ${method} ${path}`);
}
async function produceJob(body) { const job = { id: `job_${rows.jobs.length + 1}`, ...body }; rows.jobs.push(job); return { ok: true, job }; }
function json(data) { return { ok: true, json: async () => data }; }

const started = await startWorkflow({ template: 'website_onboarding_crawl', slug: 'demo', input: { url: 'https://example.com' } }, env, { supabase, produceJob });
assert.equal(started.ok, true);
assert.equal(rows.jobs.length, 1);

const advanced = await advanceWorkflow({ workflow_id: 'wf_1', approved: true }, env, { supabase, produceJob });
assert.equal(advanced.ok, true);
assert.equal(rows.jobs.length, 2);
console.log('workflow engine smoke test passed');

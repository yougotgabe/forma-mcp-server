import assert from 'node:assert/strict';
import { runFormautAiGateway } from '../ai-gateway/formaut-ai-gateway.js';

const env = {};

const greeting = await runFormautAiGateway({ slug: 'demo', message: 'hello?' }, env, {});
assert.equal(greeting.should_call_llm, false);
assert.equal(greeting.handled_by, 'ai_gateway');

const oos = await runFormautAiGateway({ slug: 'demo', message: 'Can you give me legal advice about suing someone?' }, env, {});
assert.equal(oos.should_call_llm, false);

const build = await runFormautAiGateway({ slug: 'demo', message: 'Build a homepage hero for my HVAC business' }, env, {});
assert.equal(build.should_call_llm, true);
assert.ok(build.prompt_cache);
assert.ok(build.anthropic_request_policy);

console.log('ai gateway smoke test passed');

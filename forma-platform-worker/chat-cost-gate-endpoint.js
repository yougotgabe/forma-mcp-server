// =============================================================================
// OPTIONAL ENDPOINT WIRING FOR forma-platform-worker/index.js
// =============================================================================
// Add this import at the top of forma-platform-worker/index.js:
//   import { routeDashboardMessage } from './chat-cost-gate.js';
//
// Add this route beside the other POST routes:
//   if (path === '/chat/cost-gate') return handleChatCostGate(body, env);
//
// Then paste this handler anywhere below the route section.
// =============================================================================

async function handleChatCostGate(body, env) {
  const result = await routeDashboardMessage(body, env);
  return json(result);
}

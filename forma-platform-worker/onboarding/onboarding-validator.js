import { isValidOnboardingState, getAllowedOnboardingTransitions } from './onboarding-state-machine.js';

export function validateOnboardingTransition({ currentState, nextState }) {
  if (!isValidOnboardingState(currentState)) {
    return { ok: false, reason: `Unknown current onboarding state: ${currentState}` };
  }
  if (!isValidOnboardingState(nextState)) {
    return { ok: false, reason: `Unknown next onboarding state: ${nextState}` };
  }
  const allowed = getAllowedOnboardingTransitions(currentState);
  if (!allowed.includes(nextState)) {
    return { ok: false, reason: `Invalid onboarding transition: ${currentState} -> ${nextState}` };
  }
  return { ok: true, reason: 'ok' };
}

export function validateCapacityGate({ capacityStatus }) {
  const remaining = Number(capacityStatus?.available_projects ?? capacityStatus?.remaining_projects ?? 0);
  if (remaining >= 2) return { ok: true, nextState: 'awaiting_client_approval', reason: 'sufficient_capacity' };
  return { ok: false, nextState: 'awaiting_capacity_resolution', reason: 'requires_two_free_supabase_projects' };
}

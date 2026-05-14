import { validateOnboardingTransition, validateCapacityGate } from './onboarding-validator.js';
import { logOnboardingEvent } from './onboarding-events.js';

export async function getOnboardingState({ supabase, clientId }) {
  const { data, error } = await supabase
    .from('client_onboarding_state')
    .select('*')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function initializeOnboardingState({ supabase, clientId, metadata = {} }) {
  const existing = await getOnboardingState({ supabase, clientId });
  if (existing) return existing;
  const { data, error } = await supabase
    .from('client_onboarding_state')
    .insert({ client_id: clientId, current_state: 'awaiting_supabase', metadata })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function transitionOnboardingState({ currentState, nextState, clientId, supabase, metadata = {}, eventType }) {
  const validation = validateOnboardingTransition({ currentState, nextState });
  if (!validation.ok) throw new Error(validation.reason);

  const { data, error } = await supabase
    .from('client_onboarding_state')
    .update({ current_state: nextState, metadata, updated_at: new Date().toISOString() })
    .eq('client_id', clientId)
    .select()
    .single();
  if (error) throw error;

  await logOnboardingEvent({ supabase, clientId, eventType: eventType || nextState, metadata });
  return { success: true, current_state: nextState, row: data };
}

export async function applyCapacityCheckResult({ supabase, clientId, currentState, capacityStatus }) {
  const gate = validateCapacityGate({ capacityStatus });
  return transitionOnboardingState({
    supabase,
    clientId,
    currentState,
    nextState: gate.nextState,
    metadata: { capacityStatus, gateReason: gate.reason },
    eventType: gate.ok ? 'capacity_checked' : 'capacity_resolution_required'
  });
}

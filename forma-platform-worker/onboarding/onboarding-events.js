export const ONBOARDING_EVENTS = Object.freeze({
  SUPABASE_CONNECTED: 'supabase_connected',
  CAPACITY_CHECKED: 'capacity_checked',
  CAPACITY_RESOLUTION_REQUIRED: 'capacity_resolution_required',
  CLIENT_APPROVED: 'client_approved',
  PROVISION_STARTED: 'provision_started',
  PROVISION_COMPLETED: 'provision_completed',
  CRAWL_STARTED: 'crawl_started',
  CRAWL_COMPLETED: 'crawl_completed',
  PROFILE_REVIEWED: 'profile_reviewed',
  SITE_GENERATION_STARTED: 'site_generation_started',
  SITE_GENERATION_REVIEWED: 'site_generation_reviewed',
  DEPLOYMENT_READY: 'deployment_ready',
  SITE_LIVE: 'site_live',
  MAINTENANCE_STARTED: 'maintenance_started'
});

export async function logOnboardingEvent({ supabase, clientId, eventType, metadata = {} }) {
  if (!supabase?.from) return { skipped: true, reason: 'missing_supabase_client' };
  return supabase.from('client_onboarding_events').insert({
    client_id: clientId,
    event_type: eventType,
    metadata,
    created_at: new Date().toISOString()
  });
}

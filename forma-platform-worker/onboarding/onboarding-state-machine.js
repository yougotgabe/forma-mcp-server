export const ONBOARDING_STATES = Object.freeze({
  AWAITING_SUPABASE: 'awaiting_supabase',
  SUPABASE_CONNECTED: 'supabase_connected',
  CAPACITY_CHECKED: 'capacity_checked',
  AWAITING_CAPACITY_RESOLUTION: 'awaiting_capacity_resolution',
  AWAITING_CLIENT_APPROVAL: 'awaiting_client_approval',
  PROVISIONING: 'provisioning',
  PROVISIONED: 'provisioned',
  CRAWL_PENDING: 'crawl_pending',
  CRAWL_RUNNING: 'crawl_running',
  CRAWL_COMPLETE: 'crawl_complete',
  PROFILE_REVIEW_PENDING: 'profile_review_pending',
  PROFILE_REVIEW_COMPLETE: 'profile_review_complete',
  READY_FOR_SITE_GENERATION: 'ready_for_site_generation',
  SITE_GENERATION_IN_PROGRESS: 'site_generation_in_progress',
  SITE_GENERATION_REVIEW: 'site_generation_review',
  READY_FOR_DEPLOYMENT: 'ready_for_deployment',
  LIVE: 'live',
  MAINTENANCE_MODE: 'maintenance_mode'
});

export const VALID_TRANSITIONS = Object.freeze({
  awaiting_supabase: ['supabase_connected'],
  supabase_connected: ['capacity_checked'],
  capacity_checked: ['awaiting_capacity_resolution', 'awaiting_client_approval'],
  awaiting_capacity_resolution: ['capacity_checked', 'awaiting_client_approval'],
  awaiting_client_approval: ['provisioning'],
  provisioning: ['provisioned', 'awaiting_capacity_resolution'],
  provisioned: ['crawl_pending', 'profile_review_pending'],
  crawl_pending: ['crawl_running'],
  crawl_running: ['crawl_complete', 'crawl_pending'],
  crawl_complete: ['profile_review_pending'],
  profile_review_pending: ['profile_review_complete'],
  profile_review_complete: ['ready_for_site_generation'],
  ready_for_site_generation: ['site_generation_in_progress'],
  site_generation_in_progress: ['site_generation_review'],
  site_generation_review: ['ready_for_deployment', 'site_generation_in_progress'],
  ready_for_deployment: ['live'],
  live: ['maintenance_mode', 'site_generation_in_progress'],
  maintenance_mode: ['live']
});

export function isValidOnboardingState(state) {
  return Object.values(ONBOARDING_STATES).includes(state);
}

export function getAllowedOnboardingTransitions(currentState) {
  return VALID_TRANSITIONS[currentState] || [];
}

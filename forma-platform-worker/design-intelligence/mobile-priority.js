export function getMobilePriorities({ industry, features = [] }) {
  const priorities = ['tap_target_ctas', 'fast_contact_access', 'short_sections'];
  if (features.includes('booking')) priorities.unshift('booking_cta_above_fold');
  if (industry === 'restaurant') priorities.unshift('hours_location_menu_visible');
  return priorities;
}

export function planRuntimeRollback({ client_slug, current_version, target_version, reason } = {}) {
  return {
    client_slug,
    current_version,
    target_version,
    reason,
    requires_approval: true,
    steps: [
      'disable_feature_flags_for_client',
      'redeploy_previous_client_agent',
      'validate_heartbeat',
      'open_post_rollback_review_item',
    ],
  };
}

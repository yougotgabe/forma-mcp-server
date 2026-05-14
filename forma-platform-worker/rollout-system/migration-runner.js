export function planMigration({ from_version, to_version, scope = 'client_agent' } = {}) {
  return {
    scope,
    from_version,
    to_version,
    steps: [
      { key: 'snapshot_runtime_state', risk: 'low' },
      { key: 'check_compatibility_matrix', risk: 'low' },
      { key: 'apply_schema_or_agent_update', risk: 'medium', requires_approval: true },
      { key: 'validate_heartbeat', risk: 'low' },
      { key: 'mark_rollout_complete', risk: 'low' },
    ],
  };
}

export function checkRuntimeCompatibility({ agent_version, schema_version, required_agent_version = '0.1.0', required_schema_version = '2026-05' } = {}) {
  return {
    compatible: compareVersions(agent_version || '0.0.0', required_agent_version) >= 0 && String(schema_version || '') >= String(required_schema_version),
    agent_version,
    schema_version,
    required_agent_version,
    required_schema_version,
    actions: compareVersions(agent_version || '0.0.0', required_agent_version) < 0 ? ['upgrade_client_agent'] : [],
  };
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] || 0; const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

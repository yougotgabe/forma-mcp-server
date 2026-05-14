export function calculateRisk({ artifact = {}, affectedSystems = [] }) {
  let score = 0;
  if (affectedSystems.includes('dns')) score += 100;
  if (affectedSystems.includes('auth')) score += 100;
  if (affectedSystems.includes('credentials')) score += 100;
  if (affectedSystems.includes('deployment')) score += 50;
  if (artifact.type === 'email_html') score += 20;
  if (artifact.type === 'site_copy') score += 10;
  if (artifact.type === 'schema_migration') score += 80;
  return { score, requiresApproval: score > 25 };
}

import { calculateRisk } from './review-risk-engine.js';
import { createApprovalRequest } from './approval-engine.js';

export async function stageArtifactForReview({ supabase, clientId, artifact, affectedSystems = [] }) {
  const risk = calculateRisk({ artifact, affectedSystems });
  const review = await createApprovalRequest({ supabase, clientId, artifactId: artifact.id, risk });
  return { artifact_id: artifact.id, review, risk, status: risk.requiresApproval ? 'staged' : 'approved' };
}

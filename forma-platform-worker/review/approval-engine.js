export async function createApprovalRequest({ supabase, clientId, artifactId, risk }) {
  return supabase.from('review_queue').insert({
    client_id: clientId,
    artifact_id: artifactId,
    status: 'staged',
    risk_score: risk.score,
    requires_approval: risk.requiresApproval,
    created_at: new Date().toISOString()
  }).select().single();
}

export async function decideApproval({ supabase, reviewId, decision, decidedBy }) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  return supabase.from('review_queue').update({ status: decision, decided_by: decidedBy, decided_at: new Date().toISOString() }).eq('id', reviewId).select().single();
}

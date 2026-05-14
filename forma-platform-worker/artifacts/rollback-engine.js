export async function planArtifactRollback({ supabase, artifactId }) {
  const { data, error } = await supabase.from('artifact_lineage').select('*').eq('id', artifactId).single();
  if (error) throw error;
  if (!data?.parent_artifact_id) return { canRollback: false, reason: 'no_parent_artifact' };
  return { canRollback: true, rollbackTargetId: data.parent_artifact_id, artifact: data };
}

export async function markArtifactRolledBack({ supabase, artifactId, metadata = {} }) {
  return supabase.from('artifact_lineage').update({ review_status: 'rolled_back', metadata }).eq('id', artifactId).select().single();
}

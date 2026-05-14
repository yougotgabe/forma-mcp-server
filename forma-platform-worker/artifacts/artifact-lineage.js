export async function createArtifactRecord({ supabase, artifact }) {
  const payload = {
    artifact_type: artifact.type,
    artifact_key: artifact.key || null,
    source_agent: artifact.agent || 'internal',
    prompt_hash: artifact.promptHash || null,
    review_status: artifact.reviewStatus || 'draft',
    deployment_target: artifact.target || null,
    parent_artifact_id: artifact.parentArtifactId || null,
    metadata: artifact.metadata || {},
    created_at: new Date().toISOString()
  };
  return supabase.from('artifact_lineage').insert(payload).select().single();
}

export async function listArtifactRecords({ supabase, clientId, artifactType }) {
  let query = supabase.from('artifact_lineage').select('*').order('created_at', { ascending: false });
  if (clientId) query = query.eq('client_id', clientId);
  if (artifactType) query = query.eq('artifact_type', artifactType);
  return query;
}

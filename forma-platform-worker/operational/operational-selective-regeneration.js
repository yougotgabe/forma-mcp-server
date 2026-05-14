import { getInvalidatedArtifacts, getRegenerationJobType } from './operational-dependency-engine.js';
import { classifyOperationalRisk } from './operational-risk-engine.js';

export function planSelectiveRegeneration(changeEvent = {}) {
  const sourceKey = changeEvent.source_key || changeEvent.change_type || changeEvent.type;
  const invalidated = getInvalidatedArtifacts(sourceKey);

  return invalidated.map((artifactType) => {
    const jobType = getRegenerationJobType(artifactType);
    const action = jobType.replace(/^regenerate_/, 'regenerate_');
    return {
      issue_type: 'dependency_invalidated',
      action,
      job_type: jobType,
      artifact_type: artifactType,
      risk_level: classifyOperationalRisk(action),
      priority: artifactType === 'seo' ? 70 : 60,
      payload: {
        trigger: 'dependency_invalidation',
        source_key: sourceKey,
        source_event_id: changeEvent.id || null,
        source_artifact_type: changeEvent.source_artifact_type || null,
        change_summary: changeEvent.change_summary || `${sourceKey} changed.`,
        requires_review_before_publish: artifactType !== 'seo',
      },
    };
  });
}

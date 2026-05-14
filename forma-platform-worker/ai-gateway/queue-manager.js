import { classifyJobType, queueForJobClass } from '../../shared/queue-types/queue-policy.js';

export function planAiQueue({ job_type, request_class, interactive = false } = {}) {
  const jobClass = interactive ? 'interactive' : (request_class || classifyJobType(job_type));
  return {
    job_class: jobClass,
    queue: queueForJobClass(jobClass),
    priority: priorityForClass(jobClass),
  };
}

function priorityForClass(jobClass) {
  return { interactive: 10, generation: 50, integration: 70, maintenance: 100, experimental: 140 }[jobClass] || 100;
}

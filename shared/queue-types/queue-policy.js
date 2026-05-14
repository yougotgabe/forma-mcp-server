export const JOB_CLASSES = Object.freeze({
  INTERACTIVE: 'interactive',
  GENERATION: 'generation',
  MAINTENANCE: 'maintenance',
  INTEGRATION: 'integration',
  EXPERIMENTAL: 'experimental',
});

export function classifyJobType(jobType = '') {
  const jt = String(jobType);
  if (['chat_response', 'approval_request', 'preview_srcdoc'].includes(jt)) return JOB_CLASSES.INTERACTIVE;
  if (jt.includes('generate') || jt.includes('homepage') || jt.includes('seo')) return JOB_CLASSES.GENERATION;
  if (jt.includes('maintenance') || jt.includes('health') || jt.includes('validate')) return JOB_CLASSES.MAINTENANCE;
  if (jt.includes('sync') || jt.includes('integration') || jt.includes('printify')) return JOB_CLASSES.INTEGRATION;
  if (jt.includes('experimental') || jt.includes('beta')) return JOB_CLASSES.EXPERIMENTAL;
  return JOB_CLASSES.MAINTENANCE;
}

export function queueForJobClass(jobClass) {
  return {
    interactive: 'interactive',
    generation: 'generation',
    maintenance: 'maintenance',
    integration: 'integrations',
    experimental: 'experimental',
  }[jobClass] || 'default';
}

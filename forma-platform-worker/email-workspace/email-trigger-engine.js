import { evaluateEmailRules } from './email-rules-engine.js';
import { generateEmailArtifact } from './email-artifact-generator.js';

export async function handleEmailTrigger({ event, rules, templateFactory }) {
  const matches = await evaluateEmailRules({ event, rules });
  return matches.map(rule => generateEmailArtifact({ rule, event, template: templateFactory(rule, event) }));
}

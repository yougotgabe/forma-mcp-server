import { WORKSPACE_MANIFESTS } from './workspace-manifests.js';

export function getWorkspaceManifest({ workspace, operator = false }) {
  const tools = WORKSPACE_MANIFESTS[workspace] || [];
  if (operator) return tools;
  return tools.filter(tool => !tool.includes('provision') && !tool.includes('repair') && !tool.includes('rollback'));
}

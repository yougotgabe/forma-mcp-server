export function diffArtifactText({ before = '', after = '' }) {
  const beforeLines = String(before).split('\n');
  const afterLines = String(after).split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);
  const changes = [];
  for (let i = 0; i < max; i += 1) {
    if (beforeLines[i] !== afterLines[i]) changes.push({ line: i + 1, before: beforeLines[i] ?? null, after: afterLines[i] ?? null });
  }
  return { changed: changes.length > 0, changes, change_count: changes.length };
}

import type { WorkflowToolReadinessItem } from '../dashboard/workflow-execution-plan.js';

/** Reuse the execution preflight before saving an enabled new definition.
 * Disabled drafts may intentionally reference a project that is not connected yet.
 */
export function workflowProjectCreationErrors(
  enabled: boolean,
  items: readonly WorkflowToolReadinessItem[],
): string[] {
  if (!enabled) return [];
  return items.filter(item => item.kind === 'project' && item.status === 'missing')
    .map(item => `Project ${JSON.stringify(item.name)} is not in the configured workspace inventory. `
      + 'Use a verified configured project, or omit the project binding when the steps use absolute file paths. '
      + 'The output directory alone is not a configured project.');
}

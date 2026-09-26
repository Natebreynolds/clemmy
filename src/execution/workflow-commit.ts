import { readWorkflow, type WorkflowDefinition } from '../memory/workflow-store.js';
import { withHostLocalWriteCommitFromFile } from '../runtime/harness/host-local-write-commit.js';
import { emitWorkflowSaved } from './workflow-saved-event.js';

/** A workflow opens on its own page, by saved name. */
export function workflowConsoleUrl(name: string): string {
  return `/console/automate/${encodeURIComponent(name)}`;
}

/**
 * Every workflow authoring operation attests the same reopened file bytes.
 * A caller that names the definition it started from (`before`, null for a
 * creation) also gets the saved workflow published to the asking chat as a
 * card, with the steps that changed marked.
 */
export function withWorkflowCommit(
  dirName: string,
  result: string,
  opts: { before?: WorkflowDefinition | null } = {},
): string {
  const entry = readWorkflow(dirName);
  if (!entry || entry.name !== dirName || entry.layout !== 'directory') {
    throw new Error(`Workflow ${dirName} was committed but its exact local artifact could not be reopened.`);
  }
  if (opts.before !== undefined) emitWorkflowSaved(dirName, opts.before);
  return withHostLocalWriteCommitFromFile({ createdId: dirName, committedPath: entry.filePath,
    result: `${result}\n\nOpen workflow: ${workflowConsoleUrl(entry.data.name)}` });
}

import { readWorkflow } from '../memory/workflow-store.js';
import { withHostLocalWriteCommitFromFile } from '../runtime/harness/host-local-write-commit.js';

/** Every workflow authoring operation attests the same reopened file bytes. */
export function withWorkflowCommit(dirName: string, result: string): string {
  const entry = readWorkflow(dirName);
  if (!entry || entry.name !== dirName || entry.layout !== 'directory') {
    throw new Error(`Workflow ${dirName} was committed but its exact local artifact could not be reopened.`);
  }
  return withHostLocalWriteCommitFromFile({ createdId: dirName, committedPath: entry.filePath, result });
}

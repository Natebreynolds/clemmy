import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const runFile = process.env.CLEM_WORKFLOW_RESTART_RUN_FILE;
const workflowSlug = process.env.CLEM_WORKFLOW_RESTART_SLUG;
const runId = process.env.CLEM_WORKFLOW_RESTART_RUN_ID;
const workspaceSlug = process.env.CLEM_WORKFLOW_RESTART_SPACE_SLUG;
if (!runFile || !workflowSlug || !runId || !workspaceSlug) {
  throw new Error('workflow restart fixture requires run file, workflow slug, run id, and Workspace slug');
}

const { processWorkflowRuns } = await import('../execution/workflow-runner.js');
const { readWorkflowEvents } = await import('../execution/workflow-events.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
const { closeWorkspaceDb } = await import('../spaces/workspace-db.js');
const { resolveInSpace, spaceStore } = await import('../spaces/store.js');

let modelCalls = 0;
await processWorkflowRuns({
  respond: async () => {
    modelCalls += 1;
    throw new Error('reviewed transforms must not enter a model');
  },
} as never);

const raw = readFileSync(runFile, 'utf8');
const run = JSON.parse(raw) as {
  id?: string;
  status?: string;
  stepOutputs?: Record<string, string>;
};
const events = readWorkflowEvents(workflowSlug, runId);
const workspace = spaceStore.get(workspaceSlug);
if (!workspace) throw new Error(`Workspace ${workspaceSlug} did not survive the process boundary`);
const view = readFileSync(resolveInSpace(workspaceSlug, workspace.viewEntry), 'utf8');
const revisionView = workspace.revisions[0]
  ? readFileSync(resolveInSpace(workspaceSlug, workspace.revisions[0].file), 'utf8')
  : null;

process.stdout.write(`${JSON.stringify({
  pid: process.pid,
  runId: run.id,
  status: run.status,
  modelCalls,
  runFileSha256: createHash('sha256').update(raw).digest('hex'),
  stepStarted: events.filter((event) => event.kind === 'step_started').length,
  stepCompleted: events.filter((event) => event.kind === 'step_completed').length,
  stepFailed: events.filter((event) => event.kind === 'step_failed').length,
  outputs: run.stepOutputs ?? {},
  workspace: {
    id: workspace.id,
    title: workspace.title,
    status: workspace.status,
    version: workspace.version,
    revisionCount: workspace.revisions.length,
    objective: workspace.contract?.objective ?? null,
    successCriteria: workspace.contract?.successCriteria ?? [],
    invariants: workspace.contract?.invariants ?? [],
    viewSha256: createHash('sha256').update(view).digest('hex'),
    view,
    revisionViewSha256: revisionView === null
      ? null
      : createHash('sha256').update(revisionView).digest('hex'),
    revisionView,
  },
})}\n`);

closeEventLog();
closeWorkspaceDb();

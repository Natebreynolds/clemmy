import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';

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
const { getCurrentWorkspaceDatasetObservation, listWorkspaceDatasetObservations } = await import('../spaces/workspace-db.js');
const { listAudit } = await import('../spaces/data-store.js');
const { readWorkflowTargetEvidence } = await import('../execution/workflow-target-evidence.js');
const carrier = await import('../runtime/harness/reviewed-local-tool-carrier.js');
const adapters = await import('../runtime/harness/production-capability-adapters.js');
const ports = await import('../runtime/harness/production-capability-ports.js');

// The existing reviewed-local integration fixture uses this exact port seam:
// production invoke/reconcile adapters, real Workspace storage, no provider.
// Do not substitute a returned value or pre-write the workflow's dataset.
assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
const observed = carrier.observeReviewedLocalTool('space_set_data');
assert.ok(observed);
const manifest = carrier.reviewedLocalCapabilityManifest(observed);
assert.ok(manifest);
assert.equal(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(manifest), {
  invoke: adapters.invokeForSealedManifest(manifest),
  reconcile: adapters.reconcileForSealedManifest(manifest),
}).ok, true);

let modelCalls = 0;
const assistant = {
  respond: async () => {
    modelCalls += 1;
    throw new Error('reviewed transforms must not enter a model');
  },
};
let effectiveRunFile = runFile;
let effectiveRunId = runId;
let actionInvocation: Record<string, unknown> | undefined;
const requestedAction = process.env.CLEM_WORKFLOW_RESTART_ACTION;
if (requestedAction) {
  const actionRequest = JSON.parse(requestedAction) as { id: string; args: Record<string, string> };
  const reopened = spaceStore.get(workspaceSlug);
  assert.ok(reopened, 'the action must load an already-persisted Space in this fresh process');
  assert.ok(reopened.actions.some(action => action.id === actionRequest.id), 'only the exact saved action is requested');
  const express = (await import('express')).default;
  const { registerSpaceRoutes } = await import('../dashboard/space-routes.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  registerSpaceRoutes(app, () => true);
  const server = await new Promise<import('node:http').Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}/api/console/spaces/${encodeURIComponent(workspaceSlug)}`;
    // This is the production action request, not a claim that a browser clicked.
    const response = await fetch(`${baseUrl}/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: actionRequest.id, args: actionRequest.args }) });
    const body = await response.json() as { ok?: boolean; result?: { runId?: string; workflow?: string; status?: string } };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.result?.status, 'queued');
    assert.ok(body.result?.runId && /^[a-zA-Z0-9_.:-]+$/.test(body.result.runId));
    effectiveRunId = body.result.runId;
    effectiveRunFile = path.join(path.dirname(runFile), `${effectiveRunId}.json`);
    const queued = JSON.parse(readFileSync(effectiveRunFile, 'utf8')) as { source: string; inputs: Record<string, string> };
    await processWorkflowRuns(assistant as never);
    const readback = await fetch(`${baseUrl}/data`);
    const readbackBody = await readback.json() as { data?: unknown };
    assert.equal(readback.status, 200);
    actionInvocation = { httpStatus: response.status, dataHttpStatus: readback.status, runId: effectiveRunId,
      workflow: body.result.workflow, source: queued.source, inputs: queued.inputs, data: readbackBody.data };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
} else {
  await processWorkflowRuns(assistant as never);
}

const raw = readFileSync(effectiveRunFile, 'utf8');
const run = JSON.parse(raw) as {
  id?: string;
  status?: string;
  source?: string;
  originSessionId?: string;
  error?: string;
  parkedSteps?: unknown;
  stepOutputs?: Record<string, string>;
};
const events = readWorkflowEvents(workflowSlug, effectiveRunId);
const executionDiagnostic = JSON.stringify({
  runId: run.id, status: run.status, source: run.source, originSessionId: run.originSessionId,
  error: run.error, parkedSteps: run.parkedSteps, completedOutputIds: Object.keys(run.stepOutputs ?? {}),
  events: events.slice(-10).map(event => ({ kind: event.kind, stepId: event.stepId, error: event.error,
    reason: event.meta?.reason })),
});
assert.equal(run.status, 'completed', `The controlled workflow did not finish: ${executionDiagnostic}`);
const workspace = spaceStore.get(workspaceSlug);
if (!workspace) throw new Error(`Workspace ${workspaceSlug} did not survive the process boundary`);
const view = readFileSync(resolveInSpace(workspaceSlug, workspace.viewEntry), 'utf8');
const revisionView = workspace.revisions[0]
  ? readFileSync(resolveInSpace(workspaceSlug, workspace.revisions[0].file), 'utf8')
  : null;
const dataPath = resolveInSpace(workspaceSlug, 'data.json');
assert.ok(existsSync(dataPath), `The completed controlled workflow did not publish a dataset: ${executionDiagnostic}`);
const dataFile = readFileSync(dataPath);
const data = JSON.parse(dataFile.toString('utf8')) as Record<string, unknown>;
const observation = getCurrentWorkspaceDatasetObservation(workspaceSlug, 'lifecycle_result');
const audit = listAudit(workspaceSlug, 200);
const evidence = readWorkflowTargetEvidence(effectiveRunId);

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
  runFile: effectiveRunFile,
  ...(actionInvocation ? { actionInvocation } : {}),
  publication: {
    data: data.lifecycle_result,
    dataFileSha256: createHash('sha256').update(dataFile).digest('hex'),
    observationCount: listWorkspaceDatasetObservations(workspaceSlug, { limit: 20 }).length,
    currentObservation: observation ? { id: observation.id, status: observation.status, cause: observation.cause,
      contentHash: observation.contentHash, provenance: observation.provenance } : null,
    auditSha256: createHash('sha256').update(readFileSync(resolveInSpace(workspaceSlug, 'audit.jsonl'))).digest('hex'),
    actionAudits: audit.filter(entry => entry.method === 'ACTION' && entry.path === '/action/rerun_lifecycle' && entry.outcome === 'ok').length,
    successfulDataCommits: audit.filter(entry => entry.method === 'SET_DATA' && entry.path === '/set_data/lifecycle_result' && entry.outcome === 'ok').length,
    evidence: { available: evidence.available, results: evidence.results?.map(result => ({ toolName: result.toolName, status: result.status })) ?? [] },
  },
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
    actions: workspace.actions.map(action => ({ id: action.id, workflow: action.workflow, argsTemplate: action.argsTemplate })),
  },
})}\n`);

closeEventLog();
closeWorkspaceDb();

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-workflow-catalog-scope-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(testHome, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { appendWorkflowEvent } = await import('../execution/workflow-events.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

test.after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, {
    getRuntime: () => ({ listPendingApprovals: () => [] }),
  } as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('Workflow Studio scopes run history to real catalog workflows while generic Tasks retains compiled projects', async () => {
  const workflowSlug = 'catalog-scope-workflow';
  const workflowName = 'Catalog Scope Workflow';
  const catalogRunId = 'catalog-scope-authored-run';
  const compiledSlug = 'compiled-0123456789abcdef0123456789abcdef';
  const compiledRunId = 'catalog-scope-compiled-run';
  writeWorkflow(workflowSlug, {
    name: workflowName,
    description: 'A saved workflow visible in Studio.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'inspect', prompt: 'Inspect the saved workflow result.', sideEffect: 'read' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${catalogRunId}.json`), JSON.stringify({
    id: catalogRunId,
    workflow: workflowName,
    status: 'blocked_capability',
    createdAt: '2026-08-02T12:00:00.000Z',
    source: 'workflow_run',
    error: 'Reconnect the account.',
    inputs: { privateAccountId: 'must-not-leave-the-run-record' },
    stepOutputs: { inspect: { privateRows: [1, 2, 3] } },
    workflowDefinitionSnapshot: {
      version: 1,
      definition: {
        name: workflowName,
        steps: [{ id: 'inspect', prompt: 'private authored prompt' }],
      },
    },
    capabilityBlock: {
      state: 'blocked',
      stepId: 'inspect',
      tool: 'PRIVATE_LOOKUP_TOOL',
      toolkit: 'private_lookup',
      reason: 'not-connected',
      message: 'Reconnect the private lookup account.',
      retryAt: '2026-08-02T12:05:00.000Z',
      retryCount: 2,
      provenNoDispatch: true,
      privateEvidence: 'must-not-be-projected',
    },
  }, null, 2), 'utf-8');

  // Deliberately reuse the catalog display name: exclusion must come from the
  // V2 compiled admission structure, never a name or prefix heuristic.
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${compiledRunId}.json`), JSON.stringify({
    id: compiledRunId,
    workflow: workflowName,
    workflowSlug: compiledSlug,
    status: 'running',
    createdAt: '2026-08-02T12:01:00.000Z',
    source: 'project_graph',
    inputs: { privateProjectInput: 'never expose this' },
    stepOutputs: { research: { privateFinding: 'never expose this either' } },
    workflowDefinitionSnapshot: {
      version: 2,
      scope: 'compiled',
      compilerId: 'project_graph_v1',
      definition: {
        name: workflowName,
        steps: [{ id: 'research', prompt: 'private compiled project prompt' }],
      },
    },
  }, null, 2), 'utf-8');
  appendWorkflowEvent(compiledSlug, compiledRunId, { kind: 'run_started' });
  appendWorkflowEvent(compiledSlug, compiledRunId, { kind: 'step_started', stepId: 'research' });

  const server = await boot();
  try {
    const listResponse = await fetch(`${server.url}/api/console/workflows`);
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json() as {
      workflows: Array<{ name: string; lastRunId: string | null }>;
    };
    const listedWorkflow = listBody.workflows.find((workflow) => workflow.name === workflowName);
    assert.equal(listedWorkflow?.lastRunId, catalogRunId, 'compiled project cannot become catalog last-run evidence');

    const homeResponse = await fetch(`${server.url}/api/console/workflows/home`);
    assert.equal(homeResponse.status, 200);
    const home = await homeResponse.json() as {
      counts: { activeRuns: number };
      activeRuns: Array<{ runId: string }>;
      recentRuns: Array<{ id: string }>;
    };
    assert.equal(home.activeRuns.some((run) => run.runId === compiledRunId), false);
    assert.equal(home.recentRuns.some((run) => run.id === compiledRunId), false);
    assert.equal(home.recentRuns.some((run) => run.id === catalogRunId), true);

    const runsResponse = await fetch(
      `${server.url}/api/console/workflows/${encodeURIComponent(workflowSlug)}/runs`,
    );
    assert.equal(runsResponse.status, 200);
    const runsBody = await runsResponse.json() as { runs: Array<Record<string, unknown>> };
    assert.equal(runsBody.runs.length, 1);
    const [run] = runsBody.runs;
    assert.equal(run.id, catalogRunId);
    for (const forbidden of ['inputs', 'stepOutputs', 'workflowDefinitionSnapshot', 'output', 'prompt']) {
      assert.equal(forbidden in run, false, `${forbidden} must not cross the run-summary boundary`);
    }
    assert.deepEqual(run.capabilityBlock, {
      stepId: 'inspect',
      tool: 'PRIVATE_LOOKUP_TOOL',
      toolkit: 'private_lookup',
      reason: 'not-connected',
      message: 'Reconnect the private lookup account.',
      retryAt: '2026-08-02T12:05:00.000Z',
      state: 'blocked',
      retryCount: 2,
    });

    const missingResponse = await fetch(
      `${server.url}/api/console/workflows/${encodeURIComponent(compiledSlug)}/runs`,
    );
    assert.equal(missingResponse.status, 404, 'run-scoped compiled identity is not a catalog workflow');

    const boardResponse = await fetch(`${server.url}/api/console/board`);
    assert.equal(boardResponse.status, 200);
    const board = await boardResponse.json() as { cards: Array<{ id: string; sourceKind: string }> };
    assert.ok(
      board.cards.some((card) => card.id === `wf:${compiledSlug}:${compiledRunId}` && card.sourceKind === 'workflow'),
      'generic Tasks retains the in-flight compiled project',
    );
  } finally {
    await server.close();
  }
});

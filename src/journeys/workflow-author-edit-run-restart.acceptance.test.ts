/**
 * Governing local Space + workflow lifecycle:
 * production authoring handlers create and revision one generated Space,
 * create and patch one generated workflow bound to it, workflow_run freezes
 * the edited graph, and fresh OS processes own execution/replay.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/journeys/workflow-author-edit-run-restart.acceptance.test.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-workflow-lifecycle-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-space-workflow-lifecycle\n', 'utf8');

const { registerOrchestrationTools } = await import('../tools/orchestration-tools.js');
const { registerSpaceTools } = await import('../tools/space-tools.js');
const { readWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
const { closeWorkspaceDb } = await import('../spaces/workspace-db.js');
const { resolveInSpace, spaceStore } = await import('../spaces/store.js');

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const handlers = new Map<string, ToolHandler>();
registerOrchestrationTools({
  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    handlers.set(name, handler);
  },
} as never);
registerSpaceTools({
  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    handlers.set(name, handler);
  },
} as never);

after(() => {
  closeEventLog();
  closeWorkspaceDb();
  rmSync(HOME, { recursive: true, force: true });
});

function handler(name: string): ToolHandler {
  const found = handlers.get(name);
  assert.ok(found, `${name} production handler is registered`);
  return found;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text).join('\n');
}

function runInFreshProcess(input: {
  runFile: string;
  workflowSlug: string;
  runId: string;
  workspaceSlug: string;
}): {
  pid: number;
  runId: string;
  status: string;
  modelCalls: number;
  runFileSha256: string;
  stepStarted: number;
  stepCompleted: number;
  stepFailed: number;
  outputs: Record<string, string>;
  workspace: {
    id: string;
    title: string;
    status: string;
    version: number;
    revisionCount: number;
    objective: string | null;
    successCriteria: string[];
    invariants: string[];
    viewSha256: string;
    view: string;
    revisionViewSha256: string | null;
    revisionView: string | null;
  };
} {
  const fixture = path.join(import.meta.dirname, 'workflow-author-edit-run-restart.fixture.ts');
  const child = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      CLEMENTINE_HOME: HOME,
      CLEMMY_TEST_ISOLATED_HOME: '1',
      EMBEDDINGS_DISABLED: 'true',
      MCP_AUTO_IMPORT_ENABLED: 'false',
      CLEM_WORKFLOW_RESTART_RUN_FILE: input.runFile,
      CLEM_WORKFLOW_RESTART_SLUG: input.workflowSlug,
      CLEM_WORKFLOW_RESTART_RUN_ID: input.runId,
      CLEM_WORKFLOW_RESTART_SPACE_SLUG: input.workspaceSlug,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.trim().split('\n').findLast((candidate) => candidate.startsWith('{'));
  assert.ok(line, child.stdout);
  return JSON.parse(line) as ReturnType<typeof runInFreshProcess>;
}

test('generated Space create/edit and workflow create/edit/run survive OS-process restart without replay', async () => {
  const suffix = randomUUID().slice(0, 8);
  const workspaceSlug = `generated-space-${suffix}`;
  const workspaceTitle = `Generated Space ${suffix}`;
  const workspaceObjective = `Keep the ${suffix} lifecycle result visible and reviewable.`;
  const initialView = [
    '<!doctype html>',
    '<html><body>',
    `<h1>${workspaceTitle}</h1>`,
    '<p data-state="draft">Draft lifecycle view</p>',
    '</body></html>',
  ].join('\n');
  const editedView = initialView.replace(
    '<p data-state="draft">Draft lifecycle view</p>',
    '<p data-state="ready">Ready lifecycle view</p>',
  );

  const createdSpace = await handler('space_save')({
    slug: workspaceSlug,
    title: workspaceTitle,
    objective: workspaceObjective,
    success_criteria: ['The current lifecycle result remains visible after restart.'],
    invariants: ['Every targeted view edit remains versioned and revertible.'],
    view_html: initialView,
  });
  assert.match(resultText(createdSpace), /Created workspace/);
  const authoredSpace = spaceStore.get(workspaceSlug);
  assert.ok(authoredSpace, resultText(createdSpace));
  assert.equal(authoredSpace.version, 1);
  assert.equal(
    readFileSync(resolveInSpace(workspaceSlug, authoredSpace.viewEntry), 'utf8'),
    initialView,
  );

  const editedSpace = await handler('space_edit_view')({
    slug: workspaceSlug,
    edits: [{
      find: '<p data-state="draft">Draft lifecycle view</p>',
      replace: '<p data-state="ready">Ready lifecycle view</p>',
    }],
  });
  assert.match(resultText(editedSpace), /Applied 1 edit/);
  const patchedSpace = spaceStore.get(workspaceSlug);
  assert.ok(patchedSpace);
  assert.equal(patchedSpace.version, 2);
  assert.equal(patchedSpace.revisions.length, 1);
  assert.equal(patchedSpace.contract?.objective, workspaceObjective);
  assert.equal(
    readFileSync(resolveInSpace(workspaceSlug, patchedSpace.viewEntry), 'utf8'),
    editedView,
  );
  assert.equal(
    readFileSync(resolveInSpace(workspaceSlug, patchedSpace.revisions[0]!.file), 'utf8'),
    initialView,
    'the targeted edit retains the exact pre-edit view as its revertible revision',
  );

  const displayName = `Generated Lifecycle ${suffix}`;
  const workflowSlug = `generated-lifecycle-${suffix}`;
  const initialDescription = `Initial lifecycle ${suffix}`;
  const patchedDescription = `Patched lifecycle ${suffix}`;

  const seedTransform = {
    version: 1,
    expression: {
      op: 'literal',
      value: [{ key: `${suffix}-a`, amount: 4 }, { key: `${suffix}-b`, amount: 7 }],
    },
  };
  const summaryTransform = {
    version: 1,
    expression: {
      op: 'object',
      fields: [
        {
          key: 'count',
          value: { op: 'count', value: { op: 'get', from: 'steps.seed.output' } },
        },
        {
          key: 'keys',
          value: {
            op: 'map',
            value: { op: 'get', from: 'steps.seed.output' },
            each: { op: 'get', from: 'item.key' },
          },
        },
      ],
    },
  };

  const created = await handler('workflow_create')({
    name: displayName,
    description: initialDescription,
    steps: [
      {
        id: 'seed',
        sideEffect: 'read',
        transform: JSON.stringify(seedTransform),
        output: { type: 'array', min_items: { '': 2 } },
      },
      {
        id: 'summary',
        dependsOn: ['seed'],
        sideEffect: 'read',
        transform: JSON.stringify(summaryTransform),
        output: { type: 'object', required_keys: ['count', 'keys'] },
      },
    ],
    resources: JSON.stringify({
      [workspaceSlug]: {
        kind: 'workspace',
        id: workspaceSlug,
        name: workspaceTitle,
      },
    }),
    allowSends: false,
  });
  assert.match(resultText(created), /Created workflow/);
  const authored = readWorkflow(workflowSlug);
  assert.ok(authored, resultText(created));
  assert.equal(authored.data.enabled, true, 'closed reviewed transforms are runnable immediately');
  assert.equal(authored.data.description, initialDescription);
  assert.deepEqual(authored.data.resources?.[workspaceSlug], {
    id: workspaceSlug,
    kind: 'workspace',
    name: workspaceTitle,
  });
  const authoredGraph = structuredClone(authored.data.steps);

  const updated = await handler('workflow_update')({
    name: displayName,
    description: patchedDescription,
  });
  assert.match(resultText(updated), /updated/i);
  const patched = readWorkflow(workflowSlug);
  assert.ok(patched);
  assert.equal(patched.data.description, patchedDescription);
  assert.deepEqual(
    patched.data.steps,
    authoredGraph,
    'a patch with no steps field preserves every node, edge, contract, and transform byte-for-byte',
  );

  const editedSummaryTransform = {
    version: 1,
    expression: {
      op: 'object',
      fields: [
        ...summaryTransform.expression.fields,
        { key: 'surface', value: { op: 'literal', value: workspaceSlug } },
      ],
    },
  };
  const executionEdited = await handler('workflow_update')({
    name: displayName,
    steps: [
      {
        id: 'seed',
        sideEffect: 'read',
        transform: JSON.stringify(seedTransform),
        output: { type: 'array', min_items: { '': 2 } },
      },
      {
        id: 'summary',
        dependsOn: ['seed'],
        sideEffect: 'read',
        transform: JSON.stringify(editedSummaryTransform),
        output: { type: 'object', required_keys: ['count', 'keys', 'surface'] },
      },
    ],
  });
  assert.match(resultText(executionEdited), /updated/i);
  const executionPatched = readWorkflow(workflowSlug);
  assert.ok(executionPatched);
  assert.equal(executionPatched.data.enabled, true);
  assert.deepEqual(executionPatched.data.steps[0], authoredGraph[0]);
  assert.deepEqual(executionPatched.data.steps[1]?.transform, editedSummaryTransform);

  const queuedText = resultText(await handler('workflow_run')({
    name: displayName,
    inputs: '{}',
  }));
  assert.match(queuedText, /Queued.*BACKGROUND/is);
  const runFiles = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((name) => name.endsWith('.json'));
  assert.equal(runFiles.length, 1, runFiles.join('\n'));
  const runFile = path.join(WORKFLOW_RUNS_DIR, runFiles[0]!);
  const queued = JSON.parse(readFileSync(runFile, 'utf8')) as {
    id: string;
    workflow: string;
    status: string;
    workflowDefinitionSnapshot?: {
      definition?: {
        description?: string;
        steps?: unknown[];
        resources?: Record<string, unknown>;
      };
    };
  };
  assert.equal(queued.status, 'queued');
  assert.equal(queued.workflow, displayName,
    'the queue preserves the human workflow identity while its frozen definition owns execution');
  assert.equal(queued.workflowDefinitionSnapshot?.definition?.description, patchedDescription);
  assert.deepEqual(
    queued.workflowDefinitionSnapshot?.definition?.steps,
    executionPatched.data.steps,
    'the queued snapshot owns the edited execution graph rather than the create-time graph',
  );
  assert.deepEqual(
    queued.workflowDefinitionSnapshot?.definition?.resources,
    executionPatched.data.resources,
    'the durable Space binding is frozen into the run definition separately from run inputs',
  );

  closeEventLog();
  const first = runInFreshProcess({ runFile, workflowSlug, runId: queued.id, workspaceSlug });
  assert.notEqual(first.pid, process.pid);
  assert.equal(first.status, 'completed');
  assert.equal(first.modelCalls, 0);
  assert.deepEqual(
    JSON.parse(first.outputs.seed!),
    seedTransform.expression.value,
  );
  assert.deepEqual(
    JSON.parse(first.outputs.summary!),
    { count: 2, keys: [`${suffix}-a`, `${suffix}-b`], surface: workspaceSlug },
  );
  assert.deepEqual(
    { started: first.stepStarted, completed: first.stepCompleted, failed: first.stepFailed },
    { started: 2, completed: 2, failed: 0 },
  );
  assert.deepEqual(first.workspace, {
    id: workspaceSlug,
    title: workspaceTitle,
    status: 'active',
    version: 2,
    revisionCount: 1,
    objective: workspaceObjective,
    successCriteria: ['The current lifecycle result remains visible after restart.'],
    invariants: ['Every targeted view edit remains versioned and revertible.'],
    viewSha256: createHash('sha256').update(editedView).digest('hex'),
    view: editedView,
    revisionViewSha256: createHash('sha256').update(initialView).digest('hex'),
    revisionView: initialView,
  });

  const second = runInFreshProcess({ runFile, workflowSlug, runId: queued.id, workspaceSlug });
  assert.notEqual(second.pid, process.pid);
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual(second, {
    ...first,
    pid: second.pid,
  }, 'a later process reopens the completed run without mutating bytes or repeating either step');
});

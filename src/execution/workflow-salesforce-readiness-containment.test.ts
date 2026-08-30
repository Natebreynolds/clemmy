/**
 * Run: npx tsx --test src/execution/workflow-salesforce-readiness-containment.test.ts
 *
 * Universal provider/CLI-I/O containment for workflow admission. Queueing and
 * catch-up decisions are local control-plane operations: neither may shell out
 * to Salesforce merely to decide whether a run is ready. A required account
 * without an admitted exact-account snapshot is a warning, not a blocker
 * (OPEN-THE-GATES Slice 4). Zero physical process calls either way.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-wf-sf-readiness-containment-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const originalSpawnSync = childProcess.spawnSync;
const sfSpawnCalls: Array<{ command: string; args: readonly string[] }> = [];
Object.defineProperty(childProcess, 'spawnSync', {
  configurable: true,
  writable: true,
  value: ((command: Parameters<typeof childProcess.spawnSync>[0], args?: readonly string[], options?: unknown) => {
    if (command === 'sf') {
      sfSpawnCalls.push({ command, args: args ?? [] });
      return {
        pid: 91_001,
        output: [null, '{"status":0,"result":{"username":"ops@example.test","connectedStatus":"Connected"}}', ''],
        stdout: '{"status":0,"result":{"username":"ops@example.test","connectedStatus":"Connected"}}',
        stderr: '',
        status: 0,
        signal: null,
      };
    }
    return originalSpawnSync(command as never, args as never, options as never);
  }) as typeof childProcess.spawnSync,
});
syncBuiltinESMExports();

const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { queueWorkflowRun } = await import('../tools/workflow-run-queue.js');
const { resumeWorkflowCatchupRun } = await import('./workflow-catchup-decision.js');

after(() => {
  Object.defineProperty(childProcess, 'spawnSync', {
    configurable: true,
    writable: true,
    value: originalSpawnSync,
  });
  syncBuiltinESMExports();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  sfSpawnCalls.length = 0;
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
});

function writeSalesforceWorkflow(): void {
  writeWorkflow('salesforce-dashboard', {
    name: 'Salesforce Dashboard',
    description: 'Refresh a dashboard from one exact Salesforce org.',
    enabled: true,
    trigger: { schedule: '0 9 * * *' },
    resources: {
      salesforce_org: {
        id: 'salesforce_org',
        kind: 'account',
        cli: 'sf',
        account: 'ops@example.test',
        required: true,
      },
    },
    steps: [{ id: 'refresh', prompt: 'Refresh the dashboard.', sideEffect: 'read' }],
  });
}

function assertAdmittedSalesforceWarning(result: ReturnType<typeof queueWorkflowRun>): void {
  assert.notEqual(result.status, 'blocked_readiness');
  assert.equal(result.readiness?.ok, true);
  const warning = result.readiness?.warnings.find((item) => item.name === 'sf:salesforce_org');
  assert.ok(warning, `expected a typed sf resource warning: ${result.message}`);
  assert.equal(warning.kind, 'cli');
  assert.equal(warning.status, 'unknown');
  assert.match(warning.reason, /admitted .*read|execution authority|cannot be verified/i);
}

test('production queue admission warns on an unattested Salesforce account without spawning sf', () => {
  writeSalesforceWorkflow();

  const result = queueWorkflowRun('Salesforce Dashboard', {}, {
    source: 'manual',
    dedupe: false,
    workflowSlug: 'salesforce-dashboard',
  });

  assertAdmittedSalesforceWarning(result);
  assert.deepEqual(sfSpawnCalls, [], 'queue readiness must perform zero Salesforce CLI process calls');
});

test('production held-catch-up resume rechecks locally and never spawns sf', () => {
  writeSalesforceWorkflow();
  const held = queueWorkflowRun('Salesforce Dashboard', {}, {
    source: 'schedule',
    idPrefix: 'sched',
    dedupe: false,
    catchupFire: true,
    catchupOccurrenceAtMs: 60_000,
    holdForCatchupDecision: true,
    workflowSlug: 'salesforce-dashboard',
    catchupFirstDueAtMs: 60_000,
    catchupMissedCount: 2,
    triggerReceiptId: 'workflow-schedule:v1:salesforce-dashboard:180000',
  });
  assert.equal(held.status, 'held');
  assert.ok(held.id);
  assert.deepEqual(sfSpawnCalls, [], 'holding a catch-up must perform zero Salesforce CLI process calls');

  const resumed = resumeWorkflowCatchupRun({
    runId: held.id!,
    expectedWorkflow: 'salesforce-dashboard',
  });

  assert.equal(resumed.status, 'resumed');
  assert.equal(resumed.run?.readiness?.ok, true);
  const warning = (resumed.run?.readiness?.warnings as Array<{ name?: string; kind?: string; status?: string }> | undefined)
    ?.find((item) => item.name === 'sf:salesforce_org');
  assert.ok(warning, `expected the admitted snapshot to retain the sf warning: ${resumed.message}`);
  assert.equal(warning.kind, 'cli');
  assert.equal(warning.status, 'unknown');
  assert.deepEqual(sfSpawnCalls, [], 'catch-up Resume must perform zero Salesforce CLI process calls');
});

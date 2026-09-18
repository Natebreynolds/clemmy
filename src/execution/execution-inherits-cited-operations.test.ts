/**
 * EXECUTION INHERITS ITS OPERATIONS; IT DOES NOT REDISCOVER THEM.
 *
 * A structured `call` node resolves its operation by exact identifier before
 * dispatch. A PROMPTED step got only a permission list, so a read its plan had
 * already cited still cost the step a run-time discovery — and a discovery can
 * settle on a different operation than the one that was reviewed. That is the
 * run-time half of the same gap that left `friday-sales-leadership-email`
 * bound to nothing but its authoring call.
 *
 * These pin what the step materializes BEFORE its model runs, and — just as
 * importantly — the four cases where it must do nothing at all.
 *
 * Run: node scripts/run-tests-isolated.mjs src/execution/execution-inherits-cited-operations.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-inherit-cited-ops-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-inherit-cited-ops\n', 'utf8');

const { workflowRunnerInternalsForTest } = await import('./workflow-runner.js');
const { materializeCitedStepOperations } = workflowRunnerInternalsForTest;

type AcquireInput = { ownerId: string; nodeId: string; operationId: string; expectedEffect: string };

/** Records exactly which operations execution asked for, in order. */
function recordingAcquire(result: 'present' | 'acquired' | 'unavailable' = 'acquired') {
  const seen: AcquireInput[] = [];
  const acquire = async (input: AcquireInput) => {
    seen.push(input);
    return { status: result } as { status: 'present' | 'acquired' | 'unavailable' };
  };
  return { seen, acquire: acquire as never };
}

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('a prompted read step materializes every operation its scope cites', async () => {
  const { seen, acquire } = recordingAcquire();
  await materializeCitedStepOperations(
    { id: 'pull_pipeline', prompt: 'Pull closed-won.', sideEffect: 'read' } as never,
    ['salesforce_sf_soql_query', 'GOOGLESHEETS_VALUES_GET'],
    'friday-sales-leadership-email',
    acquire,
  );
  assert.deepEqual(
    seen.map((entry) => entry.operationId),
    ['salesforce_sf_soql_query', 'GOOGLESHEETS_VALUES_GET'],
    'both cited operations are acquired by EXACT identifier — no discovery',
  );
  assert.equal(seen[0]!.nodeId, 'pull_pipeline');
  assert.equal(seen[0]!.ownerId, 'friday-sales-leadership-email');
  assert.equal(seen[0]!.expectedEffect, 'read');
});

test('a wildcard scope cites nothing, so nothing is materialized', async () => {
  const { seen, acquire } = recordingAcquire();
  await materializeCitedStepOperations(
    { id: 'summarize', prompt: 'Summarize.', sideEffect: 'read' } as never,
    ['*', '  ', ''],
    'wf',
    acquire,
  );
  assert.deepEqual(seen, [], 'a wildcard is a permission, never a citation');
});

test('a structured call node is left to acquire its own operation', async () => {
  const { seen, acquire } = recordingAcquire();
  await materializeCitedStepOperations(
    {
      id: 'fetch_rows',
      sideEffect: 'read',
      call: { tool: 'GOOGLESHEETS_VALUES_GET' },
    } as never,
    ['GOOGLESHEETS_VALUES_GET'],
    'wf',
    acquire,
  );
  assert.deepEqual(seen, [], 'the call path already resolves by exact identifier — never acquire twice');
});

test('a write or send step materializes nothing: acquisition is a read path', async () => {
  for (const sideEffect of ['write', 'send'] as const) {
    const { seen, acquire } = recordingAcquire();
    await materializeCitedStepOperations(
      { id: 'send_email', prompt: 'Send it.', sideEffect } as never,
      ['outlook_send_mail'],
      'wf',
      acquire,
    );
    assert.deepEqual(seen, [], `a ${sideEffect} step stages its operation through consent, not through acquisition`);
  }
});

test('an operation that cannot be acquired never blocks the step', async () => {
  const thrown = async () => { throw new Error('carrier is down'); };
  await assert.doesNotReject(
    materializeCitedStepOperations(
      { id: 'pull_pipeline', prompt: 'Pull closed-won.', sideEffect: 'read' } as never,
      ['salesforce_sf_soql_query'],
      'wf',
      thrown as never,
    ),
    'INHERITING IS AN IMPROVEMENT, NEVER A GATE — a step that ran before this pass still runs',
  );

  const { seen, acquire } = recordingAcquire('unavailable');
  await assert.doesNotReject(materializeCitedStepOperations(
    { id: 'pull_pipeline', prompt: 'Pull closed-won.', sideEffect: 'read' } as never,
    ['salesforce_sf_soql_query'],
    'wf',
    acquire,
  ));
  assert.equal(seen.length, 1, 'an unavailable operation is reported, not retried into a stall');
});

test('a cited scope is bounded and de-duplicated', async () => {
  const { seen, acquire } = recordingAcquire();
  await materializeCitedStepOperations(
    { id: 'wide', prompt: 'Read.', sideEffect: 'read' } as never,
    ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'],
    'wf',
    acquire,
  );
  assert.equal(seen.length, 8, 'a step start cannot be spent acquiring an unbounded tool list');
  assert.deepEqual(seen.slice(0, 3).map((entry) => entry.operationId), ['a', 'b', 'c'], 'duplicates collapse');
});

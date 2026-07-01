/**
 * Run: npx tsx --test src/execution/workflow-scheduler-telemetry.test.ts
 *
 * WS2 visibility: the scheduler now makes the previously-dead workflow_trigger_*
 * taxonomy entries REAL — a scheduled workflow that fires emits
 * workflow_trigger_fired (correlated to the enqueued run), and a second tick in
 * the same minute emits workflow_trigger_deduped. Isolated CLEMENTINE_HOME so the
 * seeded workflow + operational writes stay in a temp home.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-sched-tel-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { processWorkflowSchedules } = await import('./workflow-scheduler.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { listOperationalEvents } = await import('../runtime/operational-telemetry.js');

test('processWorkflowSchedules emits workflow_trigger_fired, then _deduped in the same minute', async () => {
  writeWorkflow('sched-tel-wf', {
    name: 'sched-tel-wf',
    description: 'every-minute test workflow',
    enabled: true,
    trigger: { schedule: '*/1 * * * *' }, // matches every minute → fires on the next tick
    steps: [{ id: 's1', prompt: 'do the thing' }],
  });

  const first = await processWorkflowSchedules();
  assert.ok(first.fired.includes('sched-tel-wf'), 'the workflow fires on the first tick');
  const fired = listOperationalEvents({ limit: 100 })
    .filter((e) => e.type === 'workflow_trigger_fired' && (e.payload as { workflowName?: string }).workflowName === 'sched-tel-wf');
  assert.equal(fired.length, 1, 'exactly one workflow_trigger_fired');
  assert.equal(fired[0].source, 'workflow');
  assert.ok(fired[0].workflowRunId, 'the fired trigger correlates to the enqueued run id');

  const second = await processWorkflowSchedules();
  assert.ok(second.deduped.includes('sched-tel-wf'), 'the second tick in the same minute dedupes');
  const deduped = listOperationalEvents({ limit: 100 })
    .filter((e) => e.type === 'workflow_trigger_deduped' && (e.payload as { workflowName?: string }).workflowName === 'sched-tel-wf');
  assert.equal(deduped.length, 1, 'exactly one workflow_trigger_deduped');
  assert.equal(deduped[0].severity, 'warn');
  assert.equal((deduped[0].payload as { reason?: string }).reason, 'already_fired_this_minute');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-once-schedule-'));
process.env.CLEMENTINE_HOME = home;
mkdirSync(path.join(home, 'state'), { recursive: true });
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
const { processWorkflowSchedules } = await import('./workflow-scheduler.js');
const { WORKFLOW_RUNS_DIR, CRON_RUNS_DIR } = await import('../tools/shared.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
const { applyWorkflowTriggerPatch } = await import('./workflow-authoring.js');
const { parseWorkflowOnceAt } = await import('../shared/workflow-once.js');
const due = '2026-09-11T22:30:25.000Z';
const stateFile = path.join(path.dirname(CRON_RUNS_DIR), 'workflow-schedule-state.json');

function seed(name: string, onceAt = due) {
  writeWorkflow(name, { name, description: 'Prepare a local performance brief once.', enabled: true,
    trigger: { onceAt }, steps: [{ id: 'prepare', prompt: 'Read the local performance input.', sideEffect: 'read' }] });
}
function runs(name: string): Array<Record<string, unknown>> {
  return existsSync(WORKFLOW_RUNS_DIR) ? readdirSync(WORKFLOW_RUNS_DIR).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf8')))
    .filter(r => r.workflowName === name || r.workflowSlug === name) : [];
}

test('one-time occurrence is not early, is exact after reopen, and cannot recur after scheduler-state loss', async () => {
  const name = 'once-restart'; seed(name);
  await processWorkflowSchedules(new Date(Date.parse(due) - 1));
  assert.equal(runs(name).length, 0);
  closeEventLog();
  const fired = await processWorkflowSchedules(new Date(due));
  assert.ok(fired.fired.includes(name), JSON.stringify(fired));
  assert.equal(runs(name).length, 1);
  const id = runs(name)[0]!.id;
  assert.equal(runs(name)[0]!.triggerReceiptId, `workflow-schedule:v1:${name}:${Date.parse(due)}`);
  assert.equal(readWorkflow(name)!.data.trigger.onceAt, due, 'no model-authored self-edit is needed');
  closeEventLog(); rmSync(stateFile, { force: true });
  await processWorkflowSchedules(new Date('2027-09-11T22:30:25.000Z'));
  assert.equal(runs(name).length, 1);
  assert.equal(runs(name)[0]!.id, id);
});

test('first boot days after the occurrence still queues the missed commitment once', async () => {
  const name = 'once-late'; seed(name);
  rmSync(stateFile, { force: true }); closeEventLog();
  const first = await processWorkflowSchedules(new Date('2026-09-15T12:00:00.000Z'));
  assert.ok(first.fired.includes(name) || first.held.includes(name), JSON.stringify(first));
  assert.equal(runs(name).length, 1);
  await processWorkflowSchedules(new Date('2026-09-15T12:01:00.000Z'));
  assert.equal(runs(name).length, 1);
});

test('disabling or amending a not-yet-due commitment does not dispatch its abandoned date', async () => {
  const name = 'once-amended'; seed(name);
  await processWorkflowSchedules(new Date('2026-09-11T22:29:00.000Z'));
  const before = readWorkflow(name)!.data;
  writeWorkflow(name, { ...before, enabled: false });
  await processWorkflowSchedules(new Date(due));
  assert.equal(runs(name).length, 0);
  const replacement = '2026-09-12T22:30:00.000Z';
  writeWorkflow(name, { ...before, trigger: { onceAt: replacement } });
  await processWorkflowSchedules(new Date(due));
  assert.equal(runs(name).length, 0);
  await processWorkflowSchedules(new Date(replacement));
  assert.equal(runs(name).length, 1);
  assert.equal(runs(name)[0]!.triggerReceiptId, `workflow-schedule:v1:${name}:${Date.parse(replacement)}`);
});

test('one-time authoring preserves the instant and switches the existing time authority', () => {
  assert.deepEqual(parseWorkflowOnceAt('2026-09-11T15:30:25-07:00'), { ok: true, at: due, atMs: Date.parse(due) });
  for (const invalid of ['2026-09-11T15:30:25', 'tomorrow', '2026-02-30T00:00:00Z']) {
    assert.equal(parseWorkflowOnceAt(invalid).ok, false, invalid);
  }
  const patched = applyWorkflowTriggerPatch({ schedule: '* * * * *', manual: true }, { triggerOnceAt: due });
  assert.equal(patched.ok, true);
  if (patched.ok) assert.deepEqual(patched.trigger, { manual: true, onceAt: due });
  const repeat = applyWorkflowTriggerPatch({ onceAt: due }, { triggerSchedule: '0 9 * * *' });
  assert.equal(repeat.ok, true);
  if (repeat.ok) assert.equal(repeat.trigger.onceAt, undefined);
  assert.equal(applyWorkflowTriggerPatch({}, { triggerOnceAt: due, triggerSchedule: '* * * * *' }).ok, false);
});

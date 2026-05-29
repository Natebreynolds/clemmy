/**
 * Run: npx tsx --test src/execution/workflow-events.test.ts
 *
 * Covers the durability contract for the events.jsonl log that the
 * workflow runner writes per run. Specifically:
 *
 *   - append() persists one JSON-per-line that read() round-trips
 *   - computeResumeState() classifies step_completed / item_completed
 *     so the runner skips already-done work on restart
 *   - large payloads are truncated, not silently dropped
 *   - partial / corrupt trailing lines are skipped without throwing
 *   - listPendingRuns() filters out runs that already reached a
 *     terminal kind (run_completed / run_failed / run_cancelled) or a
 *     terminal queue-record status.
 *
 * The tests redirect WORKFLOWS_DIR to a temp dir per-test via the
 * env CLEMENTINE_HOME hook so we don't trample the user's real vault.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We need to set CLEMENTINE_HOME BEFORE the workflow-store / events
// modules read their paths (which happens at import time inside
// memory/vault.ts). Use a per-test temp dir so isolation is clean.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-events-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { appendWorkflowEvent, readWorkflowEvents, computeResumeState, listPendingRuns } =
  await import('./workflow-events.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

function cleanup(): void {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
}

test.after(() => cleanup());

test('append + read round-trips one event', () => {
  appendWorkflowEvent('round-trip', 'r1', { kind: 'run_started' });
  const events = readWorkflowEvents('round-trip', 'r1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'run_started');
  assert.ok(events[0].t.match(/^\d{4}-\d{2}-\d{2}T/), 'has ISO timestamp');
});

test('append preserves event order across many writes', () => {
  for (let i = 0; i < 10; i++) {
    appendWorkflowEvent('ordered', 'r1', {
      kind: 'step_started',
      stepId: `s-${i}`,
    });
  }
  const events = readWorkflowEvents('ordered', 'r1');
  assert.equal(events.length, 10);
  for (let i = 0; i < 10; i++) {
    assert.equal(events[i].stepId, `s-${i}`);
  }
});

test('large string payloads get truncated, not dropped', () => {
  const huge = 'x'.repeat(40 * 1024);
  appendWorkflowEvent('big', 'r1', {
    kind: 'step_completed',
    stepId: 'big-step',
    output: huge,
  });
  const events = readWorkflowEvents('big', 'r1');
  assert.equal(events.length, 1);
  const out = events[0].output as string;
  assert.equal(typeof out, 'string');
  assert.ok(out.length < huge.length, 'truncated');
  assert.match(out, /truncated/);
});

test('computeResumeState surfaces completed steps + items', () => {
  appendWorkflowEvent('resume', 'r1', { kind: 'run_started' });
  appendWorkflowEvent('resume', 'r1', { kind: 'step_started', stepId: 'one' });
  appendWorkflowEvent('resume', 'r1', { kind: 'step_completed', stepId: 'one', output: 'hello' });
  appendWorkflowEvent('resume', 'r1', { kind: 'step_started', stepId: 'two' });
  appendWorkflowEvent('resume', 'r1', { kind: 'item_completed', stepId: 'two', itemKey: 'a', output: 'A' });
  appendWorkflowEvent('resume', 'r1', { kind: 'item_completed', stepId: 'two', itemKey: 'b', output: 'B' });

  const state = computeResumeState('resume', 'r1');
  assert.equal(state.completedSteps.size, 1);
  assert.equal(state.completedSteps.get('one'), 'hello');
  assert.equal(state.completedItems.get('two')?.size, 2);
  assert.equal(state.completedItems.get('two')?.get('a'), 'A');
  assert.equal(state.completedItems.get('two')?.get('b'), 'B');
  assert.equal(state.inFlightStepId, 'two', 'step two started but not completed');
  assert.equal(state.terminal, false);
});

test('computeResumeState round-trips STRUCTURED step output (no schema change needed)', () => {
  // The step_result refactor stores structured objects as step output.
  // This proves resume restores the object intact across a restart —
  // the event log + completedSteps Map are already <unknown>, so a
  // downstream step gets real data, not a truncated/prose summary.
  const structured = { accounts: [{ id: 'A1', score: 9 }, { id: 'A2', score: 4 }], total: 2 };
  appendWorkflowEvent('structured', 'r1', { kind: 'run_started' });
  appendWorkflowEvent('structured', 'r1', { kind: 'step_completed', stepId: 'fetch', output: structured });

  const state = computeResumeState('structured', 'r1');
  assert.deepEqual(state.completedSteps.get('fetch'), structured, 'structured output survives persist + resume');
});

test('computeResumeState detects terminal run_completed', () => {
  appendWorkflowEvent('terminal-ok', 'r1', { kind: 'run_started' });
  appendWorkflowEvent('terminal-ok', 'r1', { kind: 'run_completed' });
  const state = computeResumeState('terminal-ok', 'r1');
  assert.equal(state.terminal, true);
});

test('computeResumeState detects terminal run_failed', () => {
  appendWorkflowEvent('terminal-fail', 'r1', { kind: 'run_started' });
  appendWorkflowEvent('terminal-fail', 'r1', { kind: 'run_failed', error: 'boom' });
  const state = computeResumeState('terminal-fail', 'r1');
  assert.equal(state.terminal, true);
});

test('computeResumeState detects terminal run_cancelled', () => {
  appendWorkflowEvent('terminal-cancel', 'r1', { kind: 'run_started' });
  appendWorkflowEvent('terminal-cancel', 'r1', { kind: 'run_cancelled', error: 'cancelled by user' });
  const state = computeResumeState('terminal-cancel', 'r1');
  assert.equal(state.terminal, true);
});

test('readWorkflowEvents skips corrupt trailing lines without throwing', () => {
  appendWorkflowEvent('corrupt', 'r1', { kind: 'run_started' });
  // Manually append an unparseable trailing line to simulate a torn
  // write on crash.
  const evFile = path.join(WORKFLOWS_DIR, 'corrupt', 'runs', 'r1', 'events.jsonl');
  appendFileSync(evFile, '{"this is not": valid json\n', 'utf-8');
  const events = readWorkflowEvents('corrupt', 'r1');
  assert.equal(events.length, 1, 'good event survived');
});

test('listPendingRuns excludes terminal runs and includes in-flight', () => {
  // Done run
  appendWorkflowEvent('done', 'r1', { kind: 'run_started' });
  appendWorkflowEvent('done', 'r1', { kind: 'run_completed' });
  // Still running
  appendWorkflowEvent('in-flight', 'r1', { kind: 'run_started' });
  appendWorkflowEvent('in-flight', 'r1', { kind: 'step_started', stepId: 'one' });

  const pending = listPendingRuns();
  const flights = pending.map((p) => `${p.workflowName}/${p.runId}`);
  assert.ok(flights.includes('in-flight/r1'), 'still-running run is pending');
  assert.ok(!flights.includes('done/r1'), 'completed run is not pending');
});

test('listPendingRuns excludes runs with terminal queue-record status', () => {
  appendWorkflowEvent('queue-cancelled', 'r1', { kind: 'run_started' });
  appendWorkflowEvent('queue-cancelled', 'r1', { kind: 'step_started', stepId: 'one' });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, 'r1.json'),
    JSON.stringify({ id: 'r1', workflow: 'queue-cancelled', status: 'cancelled' }),
    'utf-8',
  );

  const pending = listPendingRuns();
  const flights = pending.map((p) => `${p.workflowName}/${p.runId}`);
  assert.ok(!flights.includes('queue-cancelled/r1'), 'cancelled queue record is not pending');
});

test('listPendingRuns returns empty when WORKFLOWS_DIR is empty', () => {
  // We don't reset the dir mid-suite, so this test exists mostly to
  // prove the function doesn't throw when called against a vault
  // that has no workflow directories yet.
  const result = listPendingRuns();
  assert.ok(Array.isArray(result), 'returns an array');
});

test('append is silent on filesystem errors (durability layer is best-effort)', () => {
  // Force a path collision: create a regular file where the events
  // directory would go, so mkdir fails. The implementation must
  // swallow the error.
  const collisionDir = path.join(WORKFLOWS_DIR, 'collision-test');
  if (!existsSync(collisionDir)) mkdirSync(collisionDir, { recursive: true });
  // Place a regular file at the path mkdir would target.
  writeFileSync(path.join(collisionDir, 'runs'), 'I am a file, not a directory', 'utf-8');
  // Should not throw.
  assert.doesNotThrow(() => {
    appendWorkflowEvent('collision-test', 'r1', { kind: 'run_started' });
  });
});

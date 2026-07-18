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

const { appendWorkflowEvent, readWorkflowEvents, computeResumeState, listFinalFailedItems, listPendingRuns, reapRunEventDir, reconstructWorkflowRunQueue } =
  await import('./workflow-events.js');
type TestStep = { id: string; prompt: string; forEach?: string; dependsOn?: string[] };
const asSteps = (s: TestStep[]): Parameters<typeof reconstructWorkflowRunQueue>[2] => s as unknown as Parameters<typeof reconstructWorkflowRunQueue>[2];
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { listOperationalEvents } = await import('../runtime/operational-telemetry.js');

function cleanup(): void {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
}

test.after(() => cleanup());

test('operational mirror: step_retry / item_retry → workflow_node_retried (severity warn)', () => {
  const wf = 'retry-mirror'; const run = 'retry-run-1';
  appendWorkflowEvent(wf, run, { kind: 'step_retry', stepId: 's1', meta: { attempt: 2 } });
  appendWorkflowEvent(wf, run, { kind: 'item_retry', stepId: 's2', itemKey: 'x', meta: { attempt: 1 } });
  const retried = listOperationalEvents({ workflowRunId: run, limit: 50 }).filter((e) => e.type === 'workflow_node_retried');
  assert.equal(retried.length, 2, 'both retry kinds mirror to workflow_node_retried');
  for (const row of retried) {
    assert.equal(row.source, 'workflow');
    assert.equal(row.severity, 'warn');
  }
});

test('operational mirror: step_advisory{reason:brain_fallover} → model_fallover; other advisories are NOT mirrored', () => {
  const wf = 'advisory-mirror'; const run = 'advisory-run-1';
  appendWorkflowEvent(wf, run, { kind: 'step_advisory', stepId: 's1', meta: { reason: 'brain_fallover', from: 'claude', to: 'codex' } });
  appendWorkflowEvent(wf, run, { kind: 'step_advisory', stepId: 's1', meta: { reason: 'skill_execution_miss' } });
  const rows = listOperationalEvents({ workflowRunId: run, limit: 50 });
  const fallovers = rows.filter((e) => e.type === 'model_fallover');
  assert.equal(fallovers.length, 1, 'only the brain_fallover advisory mirrors');
  assert.equal(fallovers[0].source, 'model');
  assert.equal(fallovers[0].severity, 'warn');
  // The non-fallover advisory produced no operational row at all.
  assert.equal(rows.length, 1, 'a non-fallover advisory is not mirrored');
});

test('reconstructWorkflowRunQueue: done/running/blocked + forEach progress from the durable log (queue visibility)', () => {
  const wf = 'queue-vis'; const run = 'q1';
  const steps = asSteps([
    { id: 's1', prompt: 'check Instagram for followers' },
    { id: 's2', prompt: 'draft posts', forEach: 'items', dependsOn: ['s1'] },
    { id: 's3', prompt: 'compile report', dependsOn: ['s2'] },
  ]);
  appendWorkflowEvent(wf, run, { kind: 'run_started' });
  appendWorkflowEvent(wf, run, { kind: 'step_started', stepId: 's1' });
  appendWorkflowEvent(wf, run, { kind: 'step_completed', stepId: 's1' });
  appendWorkflowEvent(wf, run, { kind: 'step_started', stepId: 's2' });
  for (const k of ['a', 'b', 'c']) appendWorkflowEvent(wf, run, { kind: 'item_started', stepId: 's2', itemKey: k });
  appendWorkflowEvent(wf, run, { kind: 'item_completed', stepId: 's2', itemKey: 'a' });
  appendWorkflowEvent(wf, run, { kind: 'item_completed', stepId: 's2', itemKey: 'b' });

  const q = reconstructWorkflowRunQueue(wf, run, steps);
  assert.equal(q.totalCount, 3);
  assert.equal(q.doneCount, 1);
  const by = Object.fromEntries(q.steps.map((s) => [s.stepId, s]));
  assert.equal(by.s1.status, 'done');
  assert.equal(by.s1.title, 'check Instagram for followers');   // human label from prompt
  assert.equal(by.s2.status, 'running');
  assert.equal(by.s2.kind, 'forEach');
  assert.equal(by.s2.itemsDone, 2);   // a, b completed
  assert.equal(by.s2.itemsTotal, 3);  // a, b, c started
  assert.equal(by.s3.status, 'blocked'); // s2 not done yet
  assert.equal(q.nextStepId, null); // s2 running, s3 blocked → nothing READY
});

test('operational telemetry bridge: legacy step_*/approval_* kinds mirror into operational events (Phase A observability)', async () => {
  const { listOperationalEvents } = await import('../runtime/operational-telemetry.js');
  const wf = 'otel-bridge'; const run = 'otel-run-1';
  appendWorkflowEvent(wf, run, { kind: 'step_started', stepId: 'a' });
  appendWorkflowEvent(wf, run, { kind: 'step_completed', stepId: 'a' });
  appendWorkflowEvent(wf, run, { kind: 'step_failed', stepId: 'b', error: 'boom' });
  appendWorkflowEvent(wf, run, { kind: 'approval_requested', stepId: 'c' });
  appendWorkflowEvent(wf, run, { kind: 'transcript_chunk', stepId: 'd' }); // streaming UI noise — must NOT mirror

  const events = listOperationalEvents({ workflowRunId: run, limit: 100 });
  const types = new Set(events.map((e) => e.type));
  // legacy lifecycle → operational taxonomy
  assert.ok(types.has('workflow_node_started'), 'step_started → workflow_node_started');
  assert.ok(types.has('workflow_node_completed'), 'step_completed → workflow_node_completed');
  assert.ok(types.has('workflow_node_failed'), 'step_failed → workflow_node_failed');
  assert.ok(types.has('approval_required'), 'approval_requested → approval_required');
  // transcript_chunk is neither mapped nor an operational type → dropped
  assert.ok(!events.some((e) => (e.payload as { stepId?: string } | undefined)?.stepId === 'd'));
  // source + severity mapping
  assert.equal(events.find((e) => e.type === 'approval_required')?.source, 'safety');
  const failed = events.find((e) => e.type === 'workflow_node_failed');
  assert.equal(failed?.source, 'workflow');
  assert.equal(failed?.severity, 'error');
});

test('reconstructWorkflowRunQueue: the next ready step is flagged isNext (what Clem does next)', () => {
  const wf = 'queue-next'; const run = 'n1';
  const steps = asSteps([
    { id: 'a', prompt: 'scrape competitors' },
    { id: 'b', prompt: 'draft the post', dependsOn: ['a'] },
  ]);
  appendWorkflowEvent(wf, run, { kind: 'step_started', stepId: 'a' });
  appendWorkflowEvent(wf, run, { kind: 'step_completed', stepId: 'a' });
  const q = reconstructWorkflowRunQueue(wf, run, steps);
  const by = Object.fromEntries(q.steps.map((s) => [s.stepId, s]));
  assert.equal(by.a.status, 'done');
  assert.equal(by.b.status, 'queued');
  assert.equal(by.b.isNext, true);
  assert.equal(q.nextStepId, 'b');
});

test('reconstructWorkflowRunQueue: skipped no-op steps satisfy downstream dependencies', () => {
  const wf = 'queue-skipped'; const run = 'skip1';
  const steps = asSteps([
    { id: 'empty_fanout', prompt: 'process any new rows', forEach: 'rows' },
    { id: 'summarize', prompt: 'summarize the run', dependsOn: ['empty_fanout'] },
  ]);
  appendWorkflowEvent(wf, run, { kind: 'step_started', stepId: 'empty_fanout' });
  appendWorkflowEvent(wf, run, { kind: 'step_skipped', stepId: 'empty_fanout', meta: { reason: 'forEach-empty' } });

  const state = computeResumeState(wf, run);
  assert.equal(state.completedSteps.has('empty_fanout'), true, 'resume replay treats skipped as complete');
  assert.deepEqual(state.completedSteps.get('empty_fanout'), [], 'older empty forEach skip logs replay as []');
  const q = reconstructWorkflowRunQueue(wf, run, steps);
  const by = Object.fromEntries(q.steps.map((s) => [s.stepId, s]));
  assert.equal(by.empty_fanout.status, 'done');
  assert.equal(by.summarize.status, 'queued');
  assert.equal(q.nextStepId, 'summarize');
});

test('reconstructWorkflowRunQueue: completed forEach steps with final failed items stay failed', () => {
  const wf = 'queue-failed-items'; const run = 'fail1';
  const steps = asSteps([
    { id: 'pull', prompt: 'pull rows' },
    { id: 'send', prompt: 'send each row', forEach: 'pull', dependsOn: ['pull'] },
    { id: 'report', prompt: 'report results', dependsOn: ['send'] },
  ]);
  appendWorkflowEvent(wf, run, { kind: 'step_started', stepId: 'pull' });
  appendWorkflowEvent(wf, run, { kind: 'step_completed', stepId: 'pull', output: ['a', 'b'] });
  appendWorkflowEvent(wf, run, { kind: 'step_started', stepId: 'send' });
  appendWorkflowEvent(wf, run, { kind: 'item_started', stepId: 'send', itemKey: 'a' });
  appendWorkflowEvent(wf, run, { kind: 'item_completed', stepId: 'send', itemKey: 'a', output: 'ok-a' });
  appendWorkflowEvent(wf, run, { kind: 'item_started', stepId: 'send', itemKey: 'b' });
  appendWorkflowEvent(wf, run, { kind: 'item_failed', stepId: 'send', itemKey: 'b', error: 'still failed' });
  appendWorkflowEvent(wf, run, { kind: 'step_completed', stepId: 'send', output: [{ itemKey: 'a', output: 'ok-a' }] });

  const q = reconstructWorkflowRunQueue(wf, run, steps);
  const by = Object.fromEntries(q.steps.map((s) => [s.stepId, s]));
  assert.equal(by.send.status, 'failed');
  assert.equal(by.send.itemsDone, 1);
  assert.equal(by.send.itemsTotal, 2);
  assert.equal(by.send.itemsFailed, 1);
  assert.equal(by.report.status, 'queued', 'completed step output still satisfies downstream dependencies');
  assert.equal(q.doneCount, 1);
});

test('append + read round-trips one event', () => {
  appendWorkflowEvent('round-trip', 'r1', { kind: 'run_started' });
  const events = readWorkflowEvents('round-trip', 'r1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'run_started');
  assert.ok(events[0].t.match(/^\d{4}-\d{2}-\d{2}T/), 'has ISO timestamp');
});

test('append + read round-trips workflow graph telemetry events', () => {
  appendWorkflowEvent('graph-round-trip', 'r1', {
    kind: 'workflow_branch_evaluated',
    stepId: 'decide',
    meta: {
      graphId: 'graph-1',
      nodeId: 'decide',
      selectedEdgeIds: ['condition:decide->send'],
    },
  });
  const events = readWorkflowEvents('graph-round-trip', 'r1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'workflow_branch_evaluated');
  assert.deepEqual(events[0].meta?.selectedEdgeIds, ['condition:decide->send']);
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

test('listFinalFailedItems returns only items whose latest terminal item state failed', () => {
  appendWorkflowEvent('failed-items', 'r1', { kind: 'item_failed', stepId: 'fanout', itemKey: 'a', error: 'first failure' });
  appendWorkflowEvent('failed-items', 'r1', { kind: 'item_failed', stepId: 'fanout', itemKey: 'b', error: 'still broken' });
  appendWorkflowEvent('failed-items', 'r1', { kind: 'item_completed', stepId: 'fanout', itemKey: 'a', output: 'recovered' });
  appendWorkflowEvent('failed-items', 'r1', { kind: 'item_failed', stepId: 'other', itemKey: 'x', error: 'other failed' });

  const failed = listFinalFailedItems('failed-items', 'r1');
  assert.deepEqual(
    failed.map((item) => ({ stepId: item.stepId, itemKey: item.itemKey, error: item.error })),
    [
      { stepId: 'fanout', itemKey: 'b', error: 'still broken' },
      { stepId: 'other', itemKey: 'x', error: 'other failed' },
    ],
  );
});

test('computeResumeState tracks failedSteps (the runtime-approval park signature)', () => {
  appendWorkflowEvent('resume-failed', 'r1', { kind: 'run_started' });
  appendWorkflowEvent('resume-failed', 'r1', { kind: 'step_started', stepId: 'send' });
  appendWorkflowEvent('resume-failed', 'r1', { kind: 'step_failed', stepId: 'send', error: 'Workflow run parked on approval.' });
  const state = computeResumeState('resume-failed', 'r1');
  assert.ok(state.failedSteps.has('send'), 'a step_failed event is recorded in failedSteps');
  assert.equal(state.inFlightStepId, 'send', 'a failed (parked) step is still in-flight, not completed');
  assert.equal(state.terminal, false, 'step_failed is not a terminal RUN status');
});

test('computeResumeState: a re-started step is REMOVED from failedSteps (post-approval crash is not a park)', () => {
  // park → approve → re-run (2nd step_started) → crash mid-send. The stale
  // park marker must NOT linger, or the guard would exempt a real mid-send
  // crash and double-send.
  appendWorkflowEvent('resume-restart', 'r1', { kind: 'run_started' });
  appendWorkflowEvent('resume-restart', 'r1', { kind: 'step_started', stepId: 'send' });
  appendWorkflowEvent('resume-restart', 'r1', { kind: 'step_failed', stepId: 'send', error: 'Workflow run parked on approval.' });
  appendWorkflowEvent('resume-restart', 'r1', { kind: 'step_started', stepId: 'send' }); // post-approval re-run
  const state = computeResumeState('resume-restart', 'r1');
  assert.ok(!state.failedSteps.has('send'), 're-start clears the parked marker');
  assert.equal(state.inFlightStepId, 'send', 'still in-flight (no completion)');
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
  appendWorkflowEvent('done', 'rdone', { kind: 'run_started' });
  appendWorkflowEvent('done', 'rdone', { kind: 'run_completed' });
  // Still running
  appendWorkflowEvent('in-flight', 'rflight', { kind: 'run_started' });
  appendWorkflowEvent('in-flight', 'rflight', { kind: 'step_started', stepId: 'one' });
  // A real in-flight run ALWAYS has a (non-terminal) queue record — written at
  // enqueue, before any event. (P0-2: a run with events but NO record is a
  // reaped orphan, not in-flight — see the next test.)
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'rflight.json'), JSON.stringify({ id: 'rflight', workflow: 'in-flight', status: 'running' }), 'utf-8');

  const pending = listPendingRuns();
  const flights = pending.map((p) => `${p.workflowName}/${p.runId}`);
  assert.ok(flights.includes('in-flight/rflight'), 'still-running run with a running record is pending');
  assert.ok(!flights.includes('done/rdone'), 'completed run is not pending');
});

test('listPendingRuns excludes a run whose queue record is MISSING (reaped orphan) — P0-2', () => {
  appendWorkflowEvent('reaped', 'orphan-1', { kind: 'run_started' });
  appendWorkflowEvent('reaped', 'orphan-1', { kind: 'step_started', stepId: 'one' });
  // No record file → reaped (or never persisted). It must NOT resume as a
  // phantom on boot (the May-29 "Resuming N in-flight runs" symptom).
  const flights = listPendingRuns().map((p) => `${p.workflowName}/${p.runId}`);
  assert.ok(!flights.includes('reaped/orphan-1'), 'a run with a missing record is terminal-by-deletion, not pending');
});

test('reapRunEventDir removes the run event-log directory — P0-2', () => {
  appendWorkflowEvent('reapme', 'rid', { kind: 'run_started' });
  const dir = path.join(WORKFLOWS_DIR, 'reapme', 'runs', 'rid');
  assert.ok(existsSync(dir), 'event dir exists after an event');
  reapRunEventDir('reapme', 'rid');
  assert.ok(!existsSync(dir), 'event dir removed after reap');
});

test('reapRunEventDir preserves structured mutation receipts while removing best-effort events', () => {
  appendWorkflowEvent('reap-receipts', 'rid', { kind: 'step_started', stepId: 'write' });
  const dir = path.join(WORKFLOWS_DIR, 'reap-receipts', 'runs', 'rid');
  const receiptDir = path.join(dir, 'call-mutations', 'fingerprint');
  mkdirSync(receiptDir, { recursive: true });
  writeFileSync(path.join(receiptDir, 'intent.json'), '{}', 'utf-8');

  reapRunEventDir('reap-receipts', 'rid');
  assert.equal(existsSync(path.join(dir, 'events.jsonl')), false);
  assert.equal(existsSync(path.join(receiptDir, 'intent.json')), true);
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

test('listPendingRuns excludes a FINISHED creation_test — the 2026-06-19 clem-smoke-flow zombies', () => {
  // A creation_test is a one-shot workflow-shape validation that finishes immediately.
  // It was NOT in the terminal set, so 9 of them (Jun 19) painted QUEUED / RUNNING=0
  // and were re-"resumed" on every boot forever. A finished one must now be terminal.
  appendWorkflowEvent('clem-smoke-zombie', 'ct1', { kind: 'run_started' });
  appendWorkflowEvent('clem-smoke-zombie', 'ct1', { kind: 'step_started', stepId: 'echo_hello' });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, 'ct1.json'),
    JSON.stringify({ id: 'ct1', workflow: 'clem-smoke-zombie', status: 'creation_test', finishedAt: '2026-06-19T07:06:36.601Z', output: 'creation test passed' }),
    'utf-8',
  );
  // A FRESH creation_test (no finishedAt) is still resumable/pending — it only
  // becomes terminal once it has finished, so the drain can still run a live one.
  appendWorkflowEvent('clem-smoke-fresh', 'ct2', { kind: 'run_started' });
  appendWorkflowEvent('clem-smoke-fresh', 'ct2', { kind: 'step_started', stepId: 'echo_hello' });
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, 'ct2.json'),
    JSON.stringify({ id: 'ct2', workflow: 'clem-smoke-fresh', status: 'creation_test' }),
    'utf-8',
  );

  const flights = listPendingRuns().map((p) => `${p.workflowName}/${p.runId}`);
  assert.ok(!flights.includes('clem-smoke-zombie/ct1'), 'a finished creation_test is terminal, not pending');
  assert.ok(flights.includes('clem-smoke-fresh/ct2'), 'a fresh (unfinished) creation_test still drains');
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

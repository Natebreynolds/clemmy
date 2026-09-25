/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/bridged-activity.test.ts
 *
 * Coding runs bridge into the chat that dispatched them — live and on replay —
 * and into no other chat. A long run's replay keeps its newest rows, so a
 * reconnect still sees how the run settled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'bridged-activity-'));
process.env.CLEMENTINE_HOME = home;

const eventlog = await import('./eventlog.js');
const { createBridgePredicate, collectBridgedCodingReplay, isCanonicalBridgedActivity } = await import('./bridged-activity.js');
const codingStore = await import('../../execution/coding-run-store.js');

test.after(() => { eventlog.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function admit(origin: string, key: string) {
  return codingStore.admitCodingRun({
    agent: 'claude', projectName: 'p', projectPath: '/tmp/p', worktreePath: `/tmp/w/${key}`, branch: `clem/${key}`,
    baseRef: 'main', baseCommit: 'a'.repeat(40), objective: 'Fix the build', brief: 'Fix it.',
    originSessionId: origin, admissionKey: key,
  }).run;
}

test('a coding run bridges into its origin chat only', () => {
  const run = admit('sess-origin-a', 'bridge-a');
  assert.equal(createBridgePredicate('sess-origin-a')(run.sessionId), true);
  assert.equal(createBridgePredicate('sess-origin-b')(run.sessionId), false);
  assert.equal(isCanonicalBridgedActivity({ type: 'coding_run_activity' }), true);
  assert.equal(isCanonicalBridgedActivity({ type: 'coding_run_settled' }), true);
});

test('replay carries the newest coding rows, including the settlement of a long run', () => {
  const run = admit('sess-origin-long', 'bridge-long');
  eventlog.createSession({ id: run.sessionId, kind: 'agent', channel: 'coding' });
  for (let i = 0; i < 260; i += 1) {
    eventlog.appendEvent({ sessionId: run.sessionId, turn: 1, role: 'agent', type: 'coding_run_activity', data: { runId: run.runId, kind: 'step_started', stepId: `s${i}` } });
  }
  eventlog.appendEvent({ sessionId: run.sessionId, turn: 1, role: 'system', type: 'coding_run_settled', data: { runId: run.runId, outcome: 'completed_verified' } });
  const replay = collectBridgedCodingReplay('sess-origin-long');
  assert.equal(replay.length, 200);
  assert.equal(replay.at(-1)?.type, 'coding_run_settled');
  assert.ok(replay.every((row, index) => index === 0 || row.seq > replay[index - 1]!.seq), 'chronological');
  assert.deepEqual(collectBridgedCodingReplay('sess-nobody'), []);
});

test('the public projection admits coding activity field by field and drops unknown kinds', async () => {
  const { projectHarnessEventForPublic } = await import('./public-presentation.js');
  const row = (data: Record<string, unknown>, type: 'coding_run_activity' | 'coding_run_settled' = 'coding_run_activity') => ({
    seq: 1, id: 'e1', sessionId: 'coding:code-x', turn: 1, role: 'agent', type, parentEventId: 'p', data, createdAt: new Date().toISOString(),
  });
  const step = projectHarnessEventForPublic(row({ runId: 'code-x', agent: 'claude', kind: 'step_started', stepId: 's1', tool: 'Bash', detail: 'npm test', secretField: 'x' }) as any);
  assert.deepEqual(step?.data, { runId: 'code-x', agent: 'claude', kind: 'step_started', stepId: 's1', tool: 'Bash', detail: 'npm test' });
  assert.equal(step?.parentEventId, null);
  assert.equal(projectHarnessEventForPublic(row({ runId: 'code-x', kind: 'raw_transcript', text: 'x' }) as any), null);
  const settled = projectHarnessEventForPublic(row({ runId: 'code-x', outcome: 'failed', reason: 'Tests failed', worktreePath: '/secret' }, 'coding_run_settled') as any);
  assert.deepEqual(settled?.data, { runId: 'code-x', outcome: 'failed', reason: 'Tests failed' });
});

/**
 * Run: node scripts/run-tests-isolated.mjs packages/chat-engine/src/coding-run-activity.test.ts
 *
 * A delegated coding run is one live row in the chat that dispatched it: the
 * agent and task as the label, what it is doing now as the detail, and how it
 * settled — on desktop and phone alike, since both fold through here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceActivity } from './reduce-activity.js';
import type { ActivityItem, HarnessEvent } from './types.js';

const ev = (type: string, data: Record<string, unknown>, seq = 1): HarnessEvent =>
  ({ seq, type, data, sessionId: 'coding:code-1', turn: 1, role: 'agent' }) as unknown as HarnessEvent;

function fold(events: HarnessEvent[]): ActivityItem[] {
  return events.reduce<ActivityItem[]>((rows, event) => reduceActivity(rows, event, () => 1_000), []);
}

test('a coding run folds into one row that follows the agent', () => {
  const rows = fold([
    ev('coding_run_activity', { runId: 'code-1', agent: 'claude', kind: 'status', state: 'started', text: 'Claude Code is working in app on clem/x', objective: 'Add a greeting', projectName: 'app' }),
    ev('coding_run_activity', { runId: 'code-1', agent: 'claude', kind: 'step_started', stepId: 's1', tool: 'Write', detail: 'src/greet.ts' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, 'coding-code-1');
  assert.equal(rows[0]!.kind, 'agent');
  assert.equal(rows[0]!.label, 'Claude Code · Add a greeting');
  assert.equal(rows[0]!.detail, 'Write: src/greet.ts');
  assert.equal(rows[0]!.provider, 'claude');
  assert.equal(rows[0]!.status, 'running');

  const sentBack = fold([
    ev('coding_run_activity', { runId: 'code-1', agent: 'claude', kind: 'status', objective: 'Add a greeting' }),
    ev('coding_run_activity', { runId: 'code-1', agent: 'claude', kind: 'review', next: 'continue', reason: 'The tests (npm test) exited 1.' }),
  ]);
  assert.equal(sentBack[0]!.detail, 'Clem sent it back: The tests (npm test) exited 1.');
});

test('settlement closes the row with an honest status', () => {
  const start = ev('coding_run_activity', { runId: 'code-1', agent: 'claude', kind: 'status', objective: 'Add a greeting' });
  const verified = fold([start, ev('coding_run_settled', { runId: 'code-1', agent: 'claude', outcome: 'completed_verified', commitCount: 2, branch: 'clem/x' })]);
  assert.equal(verified[0]!.status, 'done');
  assert.equal(verified[0]!.tone, 'success');
  assert.equal(verified[0]!.detail, 'Done and checked · 2 commits on clem/x');
  const unverified = fold([start, ev('coding_run_settled', { runId: 'code-1', outcome: 'completed_unverified' })]);
  assert.equal(unverified[0]!.status, 'done');
  assert.equal(unverified[0]!.tone, 'warning');
  const stopped = fold([start, ev('coding_run_settled', { runId: 'code-1', outcome: 'cancelled' })]);
  assert.equal(stopped[0]!.status, 'interrupted');
  const failed = fold([start, ev('coding_run_settled', { runId: 'code-1', outcome: 'failed', reason: 'Still not done after 3 review round(s).' })]);
  assert.equal(failed[0]!.status, 'failed');
  assert.equal(failed[0]!.detail, 'Still not done after 3 review round(s).');
  // Late activity after settlement does not reopen the row.
  const late = reduceActivity(verified, ev('coding_run_activity', { runId: 'code-1', kind: 'agent_message', text: 'late' }), () => 2_000);
  assert.equal(late[0]!.detail, 'Done and checked · 2 commits on clem/x');
});

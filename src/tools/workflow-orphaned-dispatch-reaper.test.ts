/**
 * Boot recovery for a PREPARED-but-never-closed chat dispatch.
 *
 * Run: node scripts/run-tests-isolated.mjs src/tools/workflow-orphaned-dispatch-reaper.test.ts
 *
 * The live shape (2026-08-25): a chat turn calls workflow_run, a dispatch is
 * prepared, and the reducer that closes and activates it is keyed to that exact
 * (sessionId, sourceUserSeq). When the originating turn ends without reaching
 * that reducer, the preparation is orphaned. The closed-batch and
 * activated-group reconcilers both replay from a durable receipt, and an
 * orphan has neither, so nothing reclaimed it.
 *
 * The cost was not one lost run: every later attempt correctly refused to
 * duplicate the held run ("already awaiting_chat_dispatch_seal") and parked, so
 * ONE interrupted turn disabled that workflow permanently. Five runs were held
 * this way across four workflows on the production home — friday-dashboard,
 * team-activity-slack-updates, morning-briefing, weekly-review — every one
 * zero-step and never started.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-orphan-reaper-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
mkdirSync(path.join(TMP_HOME, 'workflows', 'runs'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-orphan-reaper\n', 'utf8');

const { reapOrphanedWorkflowChatDispatches } = await import('./workflow-run-queue.js');
const { cancelWorkflowRunAtBoundary } = await import('../execution/workflow-run-cancellation.js');

test.after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

function writeRun(id: string, record: Record<string, unknown>): void {
  writeFileSync(
    path.join(TMP_HOME, 'workflows', 'runs', `${id}.json`),
    JSON.stringify({ id, createdAt: '2026-08-25T00:00:00.000Z', inputs: {}, ...record }),
    'utf8',
  );
}
function statusOf(id: string): string {
  return (JSON.parse(
    readFileSync(path.join(TMP_HOME, 'workflows', 'runs', `${id}.json`), 'utf8'),
  ) as { status: string }).status;
}

test('an orphaned prepared dispatch is cancelled so its workflow can run again', () => {
  writeRun('orphan', {
    workflow: 'stuck-flow',
    status: 'awaiting_chat_dispatch_seal',
    steps: [],
    chatDispatchSourceGroupId: 'workflow-origin-group-v1:no-such-group',
  });
  // Untouchable: a live run belongs to the normal path.
  writeRun('live', { workflow: 'running-flow', status: 'queued', steps: [] });
  // Untouchable: a held run that already DID work is a different protocol
  // (catchup / project bind) and must never be reaped by this one.
  writeRun('started', {
    workflow: 'partial-flow',
    status: 'awaiting_chat_dispatch_seal',
    steps: [{ id: 's1', status: 'done' }],
    chatDispatchSourceGroupId: 'workflow-origin-group-v1:no-such-group',
  });

  const result = reapOrphanedWorkflowChatDispatches((input) => cancelWorkflowRunAtBoundary(input));

  assert.equal(result.cancelled, 1, 'exactly the orphan is reclaimed');
  assert.equal(result.rejected, 0);
  assert.equal(statusOf('orphan'), 'cancelled');
  assert.equal(statusOf('live'), 'queued', 'a live run is never touched');
  assert.equal(
    statusOf('started'),
    'awaiting_chat_dispatch_seal',
    'a held run with real work belongs to another protocol',
  );
});

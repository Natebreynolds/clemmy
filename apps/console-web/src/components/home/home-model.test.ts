/**
 * Run: node scripts/run-tests-isolated.mjs apps/console-web/src/components/home/home-model.test.ts
 *
 * THE DEFECT THIS FILE EXISTS TO PIN. The run page was built, shipped and
 * verified green — and Home's "Open run" still pointed at the /tasks drawer,
 * so from the main screen the feature was unreachable. Nothing caught it,
 * because the two lanes owned different files and each was correct alone. Only
 * opening the app in a browser found it.
 *
 * The link is therefore not an implementation detail: it is the whole
 * difference between a durable run page existing and a user ever seeing one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runningOpenTarget, steerTarget } from './home-model.js';
import type { ActivityEntry } from '../../lib/activity';

function entry(over: Partial<ActivityEntry>): ActivityEntry {
  return {
    runKey: 'rk-1',
    kind: 'workflow',
    headline: 'friday-dashboard-daily-refresh',
    lifecycle: 'using_tool',
    liveness: 'live',
    ...over,
  } as ActivityEntry;
}

test('a run with a session opens its durable run page, not the drawer', () => {
  const target = runningOpenTarget(entry({ sessionId: 'harness:workflow:trigger-abc:update_dashboard' }));
  assert.equal(
    target,
    '/chat/harness%3Aworkflow%3Atrigger-abc%3Aupdate_dashboard',
    'the run has an address — sending the owner to transient drawer state instead wastes it',
  );
});

test('a bare harness session id is normalized the same way the rail normalizes it', () => {
  // Otherwise Home and the conversation list would deep-link to two different
  // URLs for one run, and only one of them would resolve.
  assert.equal(
    runningOpenTarget(entry({ kind: 'chat', sessionId: 'sess-desktop-123' })),
    '/chat/harness%3Asess-desktop-123',
  );
});

test('a row with no session keeps the board deep link, because it has nothing else', () => {
  // A queued task or a run scope that never minted a harness session cannot
  // render at a session address; the board is genuinely its home.
  assert.equal(
    runningOpenTarget(entry({ kind: 'background', taskId: 'task-9' })),
    '/tasks?select=task-9',
  );
  assert.equal(
    runningOpenTarget(entry({ kind: 'fanout', runId: 'run-4' })),
    '/tasks?select=run-4',
  );
  assert.equal(
    runningOpenTarget(entry({ runKey: 'rk-only' })),
    '/tasks?select=rk-only',
    'runKey is the last resort, so a row is never unopenable',
  );
});

test('the session wins over the task id when a row carries both', () => {
  // The old rule preferred taskId, which is what sent workflow rows to the
  // drawer even after they had a page.
  assert.equal(
    runningOpenTarget(entry({ taskId: 'task-9', sessionId: 'harness:sess-x' })),
    '/chat/harness%3Asess-x',
  );
});

test('steer still means "say something to a live chat turn", and nothing else', () => {
  assert.equal(steerTarget(entry({ kind: 'chat', sessionId: 'sess-1' })), '/chat/harness%3Asess-1');
  assert.equal(steerTarget(entry({ kind: 'workflow', sessionId: 'harness:wf-1' })), null);
  assert.equal(steerTarget(entry({ kind: 'chat' })), null);
});

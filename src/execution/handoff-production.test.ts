/**
 * Run: npx tsx --test src/execution/handoff-production.test.ts
 *
 * F4 production reachability. "Move this to the background" used to hand the
 * worker a sentence asking it to read the chat and work out what was already
 * done. This drives the real detach path on a real accepted attempt and
 * asserts the durable structure a resume can actually rely on.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-handoff-production-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const promote = await import('./background-promote.js');
const capsule = await import('./continuation-capsule.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const tasks = await import('./background-tasks.js');

const OBJECTIVE = 'pull last month of closed opportunities and summarize them';

function acceptedForegroundTurn(sessionId: string) {
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: 'handoff' });
  const attempt = eventlog.beginRunAttempt(sessionId, {});
  eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: OBJECTIVE, attemptId: attempt.attemptId, source: 'home' },
  }, { armRunInFlight: true });
  return attempt;
}

test('moving a live turn to the background checkpoints structural continuation before acknowledging', () => {
  const sessionId = 'sess-detach';
  const attempt = acceptedForegroundTurn(sessionId);

  const result = promote.detachRunningTurnToBackground(sessionId, { attemptId: attempt.attemptId });
  assert.ok(result, 'the real detach path declined a live accepted attempt');

  // The acknowledgement the user just got is backed by a durable capsule.
  const handoff = capsule.loadHandoffState(attempt.attemptId);
  assert.ok(handoff, 'no durable handoff record exists for the accepted attempt');
  assert.equal(handoff!.state, 'background_admitted');
  assert.ok(handoff!.capsuleId, 'the handoff record names no capsule');
  assert.ok(handoff!.backgroundTaskId, 'the handoff record names no background task');
  assert.ok(handoff!.revision >= 1);

  const loaded = capsule.loadCapsule(handoff!.logicalTaskId);
  assert.ok(loaded, 'the capsule the handoff names does not load — it failed its own digest or was never written');
  assert.ok(loaded!.objective.length > 0, 'the capsule records no objective');
  assert.equal(loaded!.acceptedSource.startsWith(`${sessionId}:`), true,
    'the capsule is not bound to the exact accepted source');
  assert.equal(loaded!.activationId, attempt.attemptId);
  assert.ok(loaded!.nextSafeActions.length > 0, 'a resume has no stated safe next action');

  // The background task carries the capsule identity, so the worker reads
  // structure rather than being told to infer completion from prose.
  const task = tasks.listBackgroundTasks({ includeArchived: true })
    .find((t) => t.id === handoff!.backgroundTaskId);
  assert.ok(task, 'the admitted background task is not in the durable registry');
  assert.equal(task!.foregroundHandoff?.logicalTaskId, handoff!.logicalTaskId);
  assert.equal(task!.foregroundHandoff?.capsuleId, handoff!.capsuleId);
  assert.equal(task!.foregroundHandoff?.attemptId, attempt.attemptId);
  assert.ok(task!.prompt.includes(loaded!.objective),
    'the capsule and the durable task disagree about what the work is');

  // History may be context, but it is no longer what the worker is told to
  // treat as the record of completed work.
  assert.equal(/session_history[\s\S]*FIRST/i.test(task!.prompt), false,
    'the worker is still instructed to reconstruct completed work by reading chat history');
});

test('a repeated handoff for the same accepted attempt rejoins instead of forking', () => {
  const sessionId = 'sess-detach-twice';
  const attempt = acceptedForegroundTurn(sessionId);

  const first = promote.detachRunningTurnToBackground(sessionId, { attemptId: attempt.attemptId });
  const second = promote.detachRunningTurnToBackground(sessionId, { attemptId: attempt.attemptId });
  assert.ok(first && second);
  assert.equal(second!.taskId, first!.taskId, 'a second handoff forked a duplicate background task');

  const handoff = capsule.loadHandoffState(attempt.attemptId);
  assert.equal(handoff?.state, 'background_admitted',
    'the rejoin regressed the durable handoff state');
});

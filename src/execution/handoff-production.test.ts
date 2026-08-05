/**
 * Run: npx tsx --test src/execution/handoff-production.test.ts
 *
 * F4 production reachability. "Move this to the background" used to hand the
 * worker a sentence asking it to read the chat and work out what was already
 * done. This drives the real detach path on a real accepted attempt and
 * asserts the durable structure a resume can actually rely on.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const committer = await import('../runtime/harness/delivery-committer.js');

const OBJECTIVE = 'pull last month of closed opportunities and summarize them';

function acceptedForegroundTurn(sessionId: string) {
  // An un-derived title on purpose: objective resolution must fall through to
  // the accepted user event rather than naming the task after chat scaffolding.
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: 'New chat' });
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

// ─── the transfer intent is durable BEFORE the foreground is fenced ──────────

test('the durable transfer intent is written before the kill, never after', () => {
  const sessionId = 'sess-order';
  const attempt = acceptedForegroundTurn(sessionId);
  promote.detachRunningTurnToBackground(sessionId, { attemptId: attempt.attemptId });

  const handoff = capsule.loadHandoffState(attempt.attemptId)!;
  // Three rungs: requested → capsule_checkpointed → background_admitted. The
  // fence is NOT one of them: it belongs to the terminal committer, where the
  // foreground actually stops. A fence-first order would have let a crash leave
  // a stopped turn with no owner at all.
  assert.equal(handoff.revision, 3,
    'the detach did not climb intent → capsule → admission in that order');
  assert.equal(handoff.state, 'background_admitted');
  assert.ok(handoff.capsuleId, 'the turn was admitted against no durable capsule');
});

test('the capsule a detach writes is projected from durable state, not from prose', () => {
  const sessionId = 'sess-projected';
  const attempt = acceptedForegroundTurn(sessionId);
  promote.detachRunningTurnToBackground(sessionId, { attemptId: attempt.attemptId });

  const handoff = capsule.loadHandoffState(attempt.attemptId)!;
  const loaded = capsule.loadCapsule(handoff.logicalTaskId)!;
  // Nothing durable declared criteria, items, or effects for this turn, so the
  // capsule states none. An invented criterion would be acted on by the resume.
  assert.deepEqual(loaded.successCriteria, [], 'the capsule invented success criteria');
  assert.deepEqual(loaded.effectRefs, [], 'the capsule invented effect refs');
  assert.equal(loaded.manifest, undefined, 'the capsule invented a work manifest');
  assert.equal(loaded.acceptedSource, `${sessionId}:${handoff.sourceUserSeq}`);
  assert.equal(loaded.objective, OBJECTIVE);
});

// ─── boot reconciliation: exactly one owner, from every rung ─────────────────

/** A handoff parked at `state` with no background task and no live foreground —
 *  the shape a crash inside the detach window leaves behind. */
function crashedHandoffAt(sessionId: string, state: string): { attemptId: string; logicalTaskId: string } {
  const attempt = acceptedForegroundTurn(sessionId);
  const logicalTaskId = `handoff:${sessionId}:${attempt.attemptId}`;
  const identity = {
    logicalTaskId,
    acceptedAttemptId: attempt.attemptId,
    sessionId,
    sourceUserSeq: eventlog.getLatestEventSeq(sessionId),
  };
  const written = capsule.checkpointCapsule(
    capsule.projectCapsuleFromDurableState(logicalTaskId, sessionId, attempt.attemptId, {
      objective: OBJECTIVE,
      sourceUserSeq: identity.sourceUserSeq,
    }),
  );
  for (const rung of [
    'requested', 'capsule_checkpointed', 'background_admitted',
    'foreground_commit_fenced', 'foreground_released',
  ] as const) {
    capsule.stepHandoff({ ...identity, capsuleId: written.capsuleId, state: rung });
    if (rung === state) break;
  }
  return { attemptId: attempt.attemptId, logicalTaskId };
}

test('a handoff whose admission never happened is re-enqueued exactly once', async () => {
  const sessionId = 'sess-crash-window';
  const crashed = crashedHandoffAt(sessionId, 'capsule_checkpointed');
  // The foreground process died with the turn fenced; nothing is running it.
  eventlog.requestKill(sessionId, 'moved to background by user', { attemptId: crashed.attemptId });
  eventlog.finishRunAttempt({ sessionId, attemptId: crashed.attemptId }, 'interrupted');

  const first = await capsule.reconcileIncompleteHandoffs();
  const mine = first.find((row) => row.acceptedAttemptId === crashed.attemptId);
  assert.ok(mine, 'reconciliation ignored a handoff that owned nothing');
  assert.equal(mine!.action, 'reenqueued');

  const owners = tasks.listBackgroundTasks({ includeArchived: true })
    .filter((task) => task.foregroundHandoff?.attemptId === crashed.attemptId);
  assert.equal(owners.length, 1, `${owners.length} owners exist for one accepted attempt`);

  // A second boot must confirm the owner, never create a sibling.
  await capsule.reconcileIncompleteHandoffs();
  const after = tasks.listBackgroundTasks({ includeArchived: true })
    .filter((task) => task.foregroundHandoff?.attemptId === crashed.attemptId);
  assert.equal(after.length, 1, 'a second reconciliation forked a duplicate owner');
  assert.equal(after[0].id, owners[0].id);
});

test('a fenced handoff whose foreground is still live hands the turn back and clears the latch', async () => {
  const sessionId = 'sess-crash-live';
  const crashed = crashedHandoffAt(sessionId, 'foreground_commit_fenced');
  // The attempt is deliberately left ACTIVE: the fence outlived the transfer.
  eventlog.requestKill(sessionId, 'moved to background by user', { attemptId: crashed.attemptId });
  assert.equal(eventlog.isKillRequested(sessionId, { attemptId: crashed.attemptId }), true);

  const results = await capsule.reconcileIncompleteHandoffs();
  const mine = results.find((row) => row.acceptedAttemptId === crashed.attemptId);
  assert.equal(mine?.action, 'released_foreground');
  assert.equal(eventlog.isKillRequested(sessionId, { attemptId: crashed.attemptId }), false,
    'the live foreground is still fenced for a transfer that never happened');
  assert.equal(capsule.loadHandoffState(crashed.attemptId)?.state, 'terminal',
    'the abandoned handoff can still be resurrected by a later boot');
  assert.equal(
    tasks.listBackgroundTasks({ includeArchived: true })
      .filter((task) => task.foregroundHandoff?.attemptId === crashed.attemptId).length,
    0,
    'a background owner was admitted for a turn the live foreground still holds',
  );
});

test('boot reconciliation converges every unsettled rung to exactly one owner', async () => {
  const rungs = [
    'requested', 'capsule_checkpointed', 'background_admitted',
    'foreground_commit_fenced', 'foreground_released',
  ] as const;
  const crashed = rungs.map((rung, index) => ({
    rung,
    ...crashedHandoffAt(`sess-converge-${index}`, rung),
  }));
  for (const entry of crashed) {
    eventlog.finishRunAttempt({ sessionId: `sess-converge-${crashed.indexOf(entry)}`, attemptId: entry.attemptId }, 'interrupted');
  }

  await capsule.reconcileIncompleteHandoffs();

  for (const entry of crashed) {
    const owners = tasks.listBackgroundTasks({ includeArchived: true })
      .filter((task) => task.foregroundHandoff?.attemptId === entry.attemptId);
    const record = capsule.loadHandoffState(entry.attemptId)!;
    // ONE owner, or an honest none. Never two, and never an unsettled rung that
    // a later boot would act on again.
    assert.ok(owners.length <= 1, `${entry.rung} produced ${owners.length} owners`);
    if (owners.length === 1) {
      assert.notEqual(record.state, 'terminal', `${entry.rung} has an owner but calls itself ended`);
      assert.equal(record.backgroundTaskId, owners[0].id, `${entry.rung} names a different owner than exists`);
    } else {
      assert.equal(record.state, 'terminal', `${entry.rung} owns nothing yet stays unsettled`);
      assert.ok(record.reason, `${entry.rung} ended without saying why`);
    }
  }
});

// ─── the foreground terminal reads as transferred, not cancelled ─────────────

test('the foreground terminal of a detached turn says the work moved, not that it was cancelled', () => {
  const sessionId = 'sess-transferred';
  const attempt = acceptedForegroundTurn(sessionId);
  const detached = promote.detachRunningTurnToBackground(sessionId, { attemptId: attempt.attemptId })!;

  // This is the marker every terminal committer consults before it publishes a
  // stopped terminal for a killed attempt.
  const transfer = capsule.handoffTransferForAttempt(sessionId, attempt.attemptId);
  assert.ok(transfer, 'a detached attempt looks identical to a cancelled one at the terminal boundary');
  assert.equal(transfer!.backgroundTaskId, detached.taskId);
  assert.match(transfer!.text, /background/i);
  assert.equal(/cancel|stopped/i.test(transfer!.text), false,
    'the user is told their work was cancelled while a worker is still running it');
  assert.ok(transfer!.text.includes(OBJECTIVE), 'the terminal does not name the work that moved');
  assert.equal(/[0-9a-f]{8}/.test(transfer!.text), false, 'the terminal reads an internal id out to the user');

  // The same marker is reachable from the accepted source alone, for committers
  // that reduce a turn without a physical attempt id in hand.
  const bySource = capsule.handoffTransferForSource(sessionId, capsule.loadHandoffState(attempt.attemptId)!.sourceUserSeq);
  assert.equal(bySource?.backgroundTaskId, detached.taskId);

  // And the committed terminal carries the owner as TYPED metadata, so a client
  // can link the turn to live work instead of parsing prose.
  const sourceUserSeq = capsule.loadHandoffState(attempt.attemptId)!.sourceUserSeq;
  const committed = committer.commitTurnOutcome({
    version: 2,
    id: `turn:${sourceUserSeq}`,
    identity: { sessionId, turn: 1, sourceUserSeq },
    status: 'cancelled',
    resumable: false,
    presentation: { kind: 'stopped', text: transfer!.text },
  }, { legacyReason: 'transferred', metadata: { transferredToTaskId: transfer!.backgroundTaskId } });
  assert.equal(committed.event.data.reason, 'transferred',
    'the durable terminal still classifies a transfer as a cancellation');
  assert.equal(committed.event.data.transferredToTaskId, detached.taskId,
    'the committer dropped the background owner from the terminal');
});

// ─── an upgrade must not strand a transfer that was already in flight ────────

test('a handoff written by an older build as a JSON file is adopted exactly once', () => {
  const dir = path.join(TMP_HOME, 'state', 'continuation-capsules', 'machine-A');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'handoff-legacy-attempt.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    logicalTaskId: 'handoff:sess-legacy:legacy-attempt',
    acceptedAttemptId: 'legacy-attempt',
    sessionId: 'sess-legacy',
    sourceUserSeq: 3,
    capsuleId: 'cap-legacy',
    backgroundTaskId: 'bg-legacy',
    state: 'background_admitted',
    revision: 2,
    updatedAt: '2026-08-01T00:00:00.000Z',
  }), 'utf-8');

  const adopted = capsule.loadHandoffState('legacy-attempt');
  assert.equal(adopted?.state, 'background_admitted', 'an in-flight handoff was lost by the upgrade');
  assert.equal(adopted?.backgroundTaskId, 'bg-legacy');
  assert.equal(adopted?.revision, 2, 'the imported handoff restarted its revisions and made stale readers look current');
  assert.equal(existsSync(file), false, 'the legacy file can still be re-imported over a newer state');

  // Move past the imported state, then prove a stray re-import cannot regress it.
  capsule.stepHandoff({
    logicalTaskId: 'handoff:sess-legacy:legacy-attempt',
    acceptedAttemptId: 'legacy-attempt',
    sessionId: 'sess-legacy',
    sourceUserSeq: 3,
    state: 'foreground_commit_fenced',
  });
  writeFileSync(file, readFileSync(`${file}.imported`, 'utf-8'), 'utf-8');
  assert.equal(capsule.loadHandoffState('legacy-attempt')?.state, 'foreground_commit_fenced',
    'a replayed legacy file regressed a live handoff');
});

test('a handoff that ended without an owner is NOT reported as a transfer', () => {
  const sessionId = 'sess-not-transferred';
  const crashed = crashedHandoffAt(sessionId, 'capsule_checkpointed');
  assert.equal(capsule.handoffTransferForAttempt(sessionId, crashed.attemptId), undefined,
    'a turn with no background owner was reported to the user as moved to the background');
});

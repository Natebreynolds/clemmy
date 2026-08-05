/**
 * Run: npx tsx --test src/execution/handoff-exactly-once.test.ts
 *
 * Exactly-once continuation, proved through the real entry points rather than
 * through the store's own vocabulary. Every test here failed before the change
 * it guards: an unpinned or rung-skipping write was accepted, a refused write
 * was ignored and the detach enqueued anyway, an accepted turn whose capsule
 * was never written got terminalized instead of rebuilt, a capsule swept in
 * receipts from unrelated earlier turns, a worker resumed against a capsule
 * that no longer matched its binding, and the user was told their moved work
 * had been cancelled.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-handoff-exactly-once-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const store = await import('./handoff-store.js');
const capsule = await import('./continuation-capsule.js');
const promote = await import('./background-promote.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const tasks = await import('./background-tasks.js');

const OBJECTIVE = 'pull last month of closed opportunities and summarize them';

function acceptedForegroundTurn(sessionId: string, text = OBJECTIVE) {
  if (!eventlog.getSession(sessionId)) {
    eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: 'New chat' });
  }
  const attempt = eventlog.beginRunAttempt(sessionId, {});
  eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text, attemptId: attempt.attemptId, source: 'home' },
  }, { armRunInFlight: true });
  return attempt;
}

function identity(sessionId: string, attemptId: string, sourceUserSeq = 1) {
  return {
    logicalTaskId: `handoff:${sessionId}:${attemptId}`,
    acceptedAttemptId: attemptId,
    sessionId,
    sourceUserSeq,
  };
}

// ─── B1: every production transition is pinned, and rungs are adjacent ───────

test('an unpinned transition is refused — a writer with no revision is a writer with a stale view', () => {
  const id = identity('sess-b1-pin', 'attempt-b1-pin');
  assert.equal(store.advanceHandoff({ ...id, state: 'requested' }, { expectedRevision: 0 }).ok, true);

  // No expectedRevision at all. A caller that cannot say which revision it read
  // cannot know whether it is racing another owner.
  const unpinned = store.advanceHandoff({ ...id, state: 'capsule_checkpointed' }, {} as never);
  assert.equal(unpinned.ok, false, 'an unpinned write was accepted — last writer wins on ownership');
  assert.equal(store.loadHandoffRecord('attempt-b1-pin')?.state, 'requested');
});

test('a rung skip is refused — durable state cannot be asserted for a step nothing performed', () => {
  const id = identity('sess-b1-skip', 'attempt-b1-skip');
  store.advanceHandoff({ ...id, state: 'requested' }, { expectedRevision: 0 });

  const skipped = store.advanceHandoff({ ...id, state: 'background_admitted' }, { expectedRevision: 1 });
  assert.equal(skipped.ok, false, 'a handoff skipped straight to admission with no durable capsule');
  assert.match((skipped as { reason: string }).reason, /adjacent|skip/i);
});

test('a same-rung rewrite is refused — ownership does not advance by being restated', () => {
  const id = identity('sess-b1-same', 'attempt-b1-same');
  store.advanceHandoff({ ...id, state: 'requested' }, { expectedRevision: 0 });
  store.advanceHandoff({ ...id, state: 'capsule_checkpointed' }, { expectedRevision: 1 });

  const restated = store.advanceHandoff({ ...id, state: 'capsule_checkpointed' }, { expectedRevision: 2 });
  assert.equal(restated.ok, false, 'a same-rung write was accepted — two callers can both "hold" one rung');
  assert.equal(store.loadHandoffRecord('attempt-b1-same')?.revision, 2);
});

// ─── B3: a refused transition stops the caller; it is never ignored ──────────

test('a detach whose ladder write is refused declines instead of enqueueing anyway', () => {
  const sessionId = 'sess-b3';
  const attempt = acceptedForegroundTurn(sessionId);
  const sourceUserSeq = eventlog.getLatestEventSeq(sessionId);
  const id = identity(sessionId, attempt.attemptId, sourceUserSeq);

  // Another owner already drove this attempt's handoff to release. Every rung
  // the detach wants is now behind the durable state.
  store.advanceHandoff({ ...id, state: 'requested' }, { expectedRevision: 0 });
  store.advanceHandoff({ ...id, state: 'capsule_checkpointed' }, { expectedRevision: 1 });
  store.advanceHandoff({ ...id, state: 'background_admitted', backgroundTaskId: 'bg-elsewhere' }, { expectedRevision: 2 });
  store.advanceHandoff({ ...id, state: 'foreground_commit_fenced' }, { expectedRevision: 3 });
  store.advanceHandoff({ ...id, state: 'foreground_released' }, { expectedRevision: 4 });

  const before = tasks.listBackgroundTasks({ includeArchived: true }).length;
  const result = promote.detachRunningTurnToBackground(sessionId, { attemptId: attempt.attemptId });
  const after = tasks.listBackgroundTasks({ includeArchived: true }).length;

  assert.equal(after, before,
    'the detach ignored a refused ladder write and admitted a second owner for an already-released turn');
  assert.equal(result, null, 'the detach reported success against a handoff it does not own');
});

// ─── B4: accepted work is rebuilt, never discarded ───────────────────────────

test('a bare requested handoff is rebuilt from durable state, not terminalized', async () => {
  const sessionId = 'sess-b4';
  const attempt = acceptedForegroundTurn(sessionId);
  const sourceUserSeq = eventlog.getLatestEventSeq(sessionId);
  // The crash landed between the intent and the capsule: a durable record of
  // accepted work with nothing checkpointed yet.
  store.advanceHandoff(
    { ...identity(sessionId, attempt.attemptId, sourceUserSeq), state: 'requested' },
    { expectedRevision: 0 },
  );
  eventlog.finishRunAttempt({ sessionId, attemptId: attempt.attemptId }, 'interrupted');

  await capsule.reconcileIncompleteHandoffs();

  const owners = tasks.listBackgroundTasks({ includeArchived: true })
    .filter((task) => task.foregroundHandoff?.attemptId === attempt.attemptId);
  assert.equal(owners.length, 1,
    'accepted work was thrown away because its capsule had not been written when the process died');
  const record = store.loadHandoffRecord(attempt.attemptId)!;
  assert.notEqual(record.state, 'terminal');
  const rebuilt = capsule.loadCapsule(record.logicalTaskId);
  assert.ok(rebuilt, 'reconciliation admitted an owner with no durable capsule to resume from');
  assert.equal(rebuilt!.objective, OBJECTIVE, 'the rebuilt capsule lost what the user actually asked for');
});

// ─── B5: boot reconciliation is awaited, and a store failure fails CLOSED ────

test('a handoff store that cannot be read fails boot readiness closed', async () => {
  await assert.rejects(
    () => capsule.reconcileHandoffsForBoot({ probe: () => { throw new Error('handoff store unreadable'); } }),
    /handoff store unreadable/,
    'a daemon reported ready while unable to tell which turns still have an owner',
  );
});

// ─── B7: the capsule covers the accepted ACTIVATION INTERVAL only ────────────

test('receipts from an earlier unrelated turn never enter the new capsule', () => {
  const sessionId = 'sess-b7';
  // An earlier, already-finished turn in the SAME reusable chat did real reads.
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: 'New chat' });
  eventlog.appendEvent({
    sessionId, turn: 0, role: 'system', type: 'read_receipt',
    data: { record: { receiptId: 'readrcpt_earlier', identifier: 'CRM_EARLIER_LIST' } },
  });
  const attempt = acceptedForegroundTurn(sessionId);
  eventlog.appendEvent({
    sessionId, turn: 1, role: 'system', type: 'read_receipt',
    data: { record: { receiptId: 'readrcpt_thisturn', identifier: 'CRM_THIS_TURN' } },
  });

  const detached = promote.detachRunningTurnToBackground(sessionId, { attemptId: attempt.attemptId });
  assert.ok(detached);
  const record = store.loadHandoffRecord(attempt.attemptId)!;
  const built = capsule.loadCapsule(record.logicalTaskId)!;
  const refs = built.effectRefs.map((ref) => ref.receiptRef);

  assert.equal(refs.includes('readrcpt_thisturn'), true,
    'the capsule dropped a read this turn actually performed');
  assert.equal(refs.includes('readrcpt_earlier'), false,
    'the capsule swept in a receipt from an unrelated earlier turn — the resume would treat it as this task\'s work');
});

// ─── B9: the worker validates its binding and parks fail-closed ──────────────

test('a worker whose capsule no longer matches its binding parks instead of resuming', () => {
  const sessionId = 'sess-b9';
  const attempt = acceptedForegroundTurn(sessionId);
  const detached = promote.detachRunningTurnToBackground(sessionId, { attemptId: attempt.attemptId })!;
  const task = tasks.getBackgroundTask(detached.taskId)!;
  assert.ok(task.foregroundHandoff?.capsuleDigest, 'the task was admitted with no capsule digest to validate');

  // The capsule the worker would resume from is no longer the one it was bound
  // to. Resuming here would redo or skip work against an unverified record.
  const file = path.join(TMP_HOME, 'state', 'continuation-capsules', 'machine-A',
    `${encodeURIComponent(task.foregroundHandoff!.logicalTaskId!)}.json`);
  const stored = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...stored, objective: 'delete last month of opportunities' }), 'utf-8');

  const started = tasks.markBackgroundTaskRunning(detached.taskId);
  assert.equal(started, null, 'the worker started against a capsule that failed its own binding');
  const parked = tasks.getBackgroundTask(detached.taskId)!;
  assert.notEqual(parked.status, 'running', 'a tampered continuation was resumed rather than parked');
  assert.match(String(parked.error ?? parked.pendingQuestion ?? ''), /capsule|continuation|binding/i,
    'the park does not say why the worker refused to resume');
});

// ─── B10: transferred is a real terminal status, not a cancellation ──────────

test('the foreground terminal of a moved turn commits status transferred, not cancelled', () => {
  const sessionId = 'sess-b10';
  const attempt = acceptedForegroundTurn(sessionId);
  const detached = promote.detachRunningTurnToBackground(sessionId, { attemptId: attempt.attemptId })!;

  const outcome = capsule.transferredTurnOutcome(sessionId, attempt.attemptId);
  assert.ok(outcome, 'a moved turn has no transferred outcome to commit');
  assert.equal(outcome!.status, 'transferred',
    'the moved turn still commits as cancelled — the taxonomy has no way to say the work continued');
  assert.equal(outcome!.transferredToTaskId, detached.taskId);
});

// ─── B2: two processes detaching the same turn create ONE runnable task ──────

test('two OS processes detaching the same accepted turn admit exactly one worker', async () => {
  const sessionId = 'sess-b2';
  const attempt = acceptedForegroundTurn(sessionId);
  store.closeHandoffStoreForTests();

  const worker = `
    process.env.CLEMENTINE_HOME = ${JSON.stringify(TMP_HOME)};
    const promote = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/execution/background-promote.ts'))});
    const result = promote.detachRunningTurnToBackground(${JSON.stringify(sessionId)}, { attemptId: ${JSON.stringify(attempt.attemptId)} });
    process.stdout.write('<<<' + JSON.stringify({ taskId: result ? result.taskId : null }) + '>>>');
  `;
  const run = () => new Promise<{ taskId: string | null }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', worker], {
      cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { err += String(c); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`worker exited ${code}: ${err}`));
      // The daemon's loggers also write to stdout; take only the fenced result.
      const fenced = /<<<([\s\S]*?)>>>/.exec(out);
      if (!fenced) return reject(new Error(`no result in worker output: ${out} ${err}`));
      try { resolve(JSON.parse(fenced[1])); } catch (e) { reject(new Error(`${out} ${err} ${String(e)}`)); }
    });
  });

  const [left, right] = await Promise.all([run(), run()]);
  const owners = tasks.listBackgroundTasks({ includeArchived: true })
    .filter((task) => task.foregroundHandoff?.attemptId === attempt.attemptId);

  assert.equal(owners.length, 1,
    `${owners.length} runnable tasks exist for one accepted turn — both would run the work and both would report back`);
  // Whichever callers succeeded must name the SAME task: a reserved id makes a
  // concurrent detach a rejoin instead of a fork.
  for (const outcome of [left, right]) {
    if (outcome.taskId !== null) assert.equal(outcome.taskId, owners[0].id);
  }
  assert.ok(left.taskId !== null || right.taskId !== null, 'neither process admitted the turn');
});

// ─── crash after EVERY rung converges to exactly one owner ───────────────────

test('a crash at every rung leaves exactly one owner and one truthful public state', async () => {
  const rungs = ['requested', 'capsule_checkpointed', 'background_admitted',
    'foreground_commit_fenced', 'foreground_released'] as const;

  for (const [index, rung] of rungs.entries()) {
    const sessionId = `sess-crash-${index}`;
    const attempt = acceptedForegroundTurn(sessionId);
    const sourceUserSeq = eventlog.getLatestEventSeq(sessionId);
    const logicalTaskId = `handoff:${sessionId}:${attempt.attemptId}`;
    const id = { logicalTaskId, acceptedAttemptId: attempt.attemptId, sessionId, sourceUserSeq };
    const built = capsule.checkpointCapsule(
      capsule.projectCapsuleFromDurableState(logicalTaskId, sessionId, attempt.attemptId,
        { objective: OBJECTIVE, sourceUserSeq }),
    );
    // Climb to exactly this rung, then "die".
    for (const step of rungs) {
      capsule.stepHandoff({ ...id, capsuleId: built.capsuleId, state: step });
      if (step === rung) break;
    }
    eventlog.finishRunAttempt({ sessionId, attemptId: attempt.attemptId }, 'interrupted');

    await capsule.reconcileIncompleteHandoffs();
    // A second boot must be a no-op, not a second owner.
    await capsule.reconcileIncompleteHandoffs();

    const owners = tasks.listBackgroundTasks({ includeArchived: true })
      .filter((task) => task.foregroundHandoff?.attemptId === attempt.attemptId);
    const record = store.loadHandoffRecord(attempt.attemptId)!;
    assert.ok(owners.length <= 1, `crash at ${rung} produced ${owners.length} owners`);
    if (owners.length === 1) {
      assert.notEqual(record.state, 'terminal', `crash at ${rung} has an owner but calls itself ended`);
      assert.equal(record.backgroundTaskId, owners[0].id, `crash at ${rung} names a different owner than exists`);
      assert.equal(eventlog.isKillRequested(sessionId, { attemptId: attempt.attemptId }), false,
        `crash at ${rung} left the foreground fenced while a worker owns the turn`);
    } else {
      assert.equal(record.state, 'terminal', `crash at ${rung} owns nothing yet stays unsettled`);
      assert.ok(record.reason, `crash at ${rung} ended without saying why`);
    }
  }
});

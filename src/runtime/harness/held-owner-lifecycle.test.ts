/**
 * A held turn's run attempt must stay LIVE while its recovery owner runs.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/held-owner-lifecycle.test.ts
 *
 * Live 2026-09-07, session sess-desktop-99ce6eeb7dab81aabc2c3a63, source 140867:
 *   02:41:23.464  first successful exact Space read
 *   02:41:24.777  the edit attempt is durably finished as COMPLETED
 *   02:41:30.408  space_edit_view settles refused_pre_dispatch,
 *                 work_binding:child_lease_activation_failed, zero crossings
 *   02:41:30-42:14  fifteen more logical calls refused the same way
 *   02:42:16.050  terminal asks the owner to retype the request; the board
 *                 never changed
 *
 * `isDispatchLeaseCurrent` correctly refuses any lineage whose bound attempt has
 * finished. The guard is right. The defect was finishing an attempt that had not
 * stopped working, which made its own continuation structurally impossible.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-held-owner-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'held-owner\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

function activation(title: string) {
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title });
  const attempt = eventlog.beginRunAttempt(row.id, { runId: `run-${title}` });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: 'Edit the board.' },
  });
  return { row, attempt, source, session: HarnessSession.load(row.id) };
}

test('CONTINUATION RESPONSIBILITY survives the adoption that removes the blob', () => {
  // THE C32 FAILURE. The bridge sampled the recovery blob, but adoption
  // deliberately removes it while the work continues: live source 141915,
  // checkpoint recovery ran 4ms before the attempt was marked completed and
  // the next protected child call was refused against a finished owner.
  const { attempt, source, session } = activation('survives-adoption');
  session.saveRecoveryState(JSON.stringify({ sourceUserSeq: source.seq, phase: 'continue' }), {
    owner: { sourceUserSeq: source.seq, attemptId: attempt.attemptId },
  });
  const owner = { sourceUserSeq: source.seq, attemptId: attempt.attemptId };
  session.claimContinuationOwner(owner);

  // Adoption consumes the checkpoint — exactly what runTurn does before
  // continuing — and the OLD evidence disappears with it.
  assert.equal(
    session.adoptRecoveredConversation({
      serializedState: JSON.stringify({ sourceUserSeq: source.seq, phase: 'continue' }),
      history: [],
      lastResponseId: undefined,
    }),
    true,
  );
  assert.equal(session.loadRecoveryState(), null, 'the blob is gone, as intended');
  assert.equal(
    session.continuationOwnerState(owner), 'ours',
    'but responsibility for the turn has NOT ended',
  );
});

test('UNREADABLE ownership is not evidence that work stopped', () => {
  const { attempt, source, session } = activation('unreadable');
  const owner = { sourceUserSeq: source.seq, attemptId: attempt.attemptId };
  const db = eventlog.openEventLog();
  const realPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    if (sql.includes('__continuation_owner')) throw new Error('disk I/O error');
    return realPrepare(sql);
  };
  try {
    assert.equal(session.continuationOwnerState(owner), 'unreadable',
      'distinct from absent — the bridge must not read it as permission to finish');
  } finally {
    (db as unknown as { prepare: unknown }).prepare = realPrepare;
  }
});

test('responsibility ends with the TYPED TERMINAL, atomically', () => {
  const { row, attempt, source, session } = activation('terminal-clears');
  const owner = { sourceUserSeq: source.seq, attemptId: attempt.attemptId };
  session.claimContinuationOwner(owner);
  assert.equal(session.continuationOwnerState(owner), 'ours');

  const identity = {
    sessionId: row.id, turn: source.turn, attemptId: attempt.attemptId,
    runId: attempt.runId ?? undefined, sourceUserSeq: source.seq,
  };
  commitTurnOutcome({
    version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false,
    presentation: { kind: 'answer', text: 'Edited the board.' },
  });

  assert.equal(
    HarnessSession.load(row.id).continuationOwnerState(owner), 'absent',
    'the terminal that closes the owner also ends its responsibility',
  );
  assert.ok(eventlog.getLatestRunAttempt(row.id)?.finishedAt,
    'and the attempt is closed by that same publication');
});

test('a NEWER source takes over responsibility; an older one cannot', () => {
  const { attempt, source, session } = activation('takeover');
  const older = { sourceUserSeq: source.seq, attemptId: attempt.attemptId };
  session.claimContinuationOwner(older);
  const newer = { sourceUserSeq: source.seq + 10, attemptId: 'newer-attempt' };
  assert.equal(session.claimContinuationOwner(newer), true, 'a newer source takes over');
  assert.equal(session.continuationOwnerState(newer), 'ours');
  assert.equal(session.continuationOwnerState(older), 'other');
  assert.equal(session.claimContinuationOwner(older), false, 'the older one cannot reclaim');
});

test('an ARMED recovery owner is recognised for exactly its own activation', () => {
  const { attempt, source, session } = activation('armed');
  assert.equal(
    session.recoveryOwnedByActivation({ sourceUserSeq: source.seq, attemptId: attempt.attemptId }),
    false,
    'nothing installed is not ownership',
  );

  session.saveRecoveryState(JSON.stringify({ sourceUserSeq: source.seq, phase: 'finalize' }), {
    owner: { sourceUserSeq: source.seq, attemptId: attempt.attemptId },
  });
  assert.equal(
    session.recoveryOwnedByActivation({ sourceUserSeq: source.seq, attemptId: attempt.attemptId }),
    true,
    'the desktop bridge can now see that work continues on this attempt',
  );
  assert.equal(
    session.recoveryOwnedByActivation({ sourceUserSeq: source.seq, attemptId: 'someone-else' }),
    false,
    'and it is not another activation',
  );
});

test('an UNOWNED blob never claims held-with-recovery-armed', () => {
  // "A rejected save cannot become held with recovery armed without an actual
  // owner/checkpoint." Legacy bytes with no sidecar are not this attempt's.
  const { attempt, source, session } = activation('unowned');
  session.saveRecoveryState('legacy-bytes-no-sidecar');
  assert.equal(
    session.recoveryOwnedByActivation({ sourceUserSeq: source.seq, attemptId: attempt.attemptId }),
    false,
  );
});

test('THE TYPED TERMINAL closes the retained attempt', () => {
  // Something has to finish an attempt the bridge deliberately left live. The
  // only honest moment is when its exact source publishes a typed terminal.
  const { row, attempt, source } = activation('closes');
  const identity = {
    sessionId: row.id,
    turn: source.turn,
    attemptId: attempt.attemptId,
    runId: attempt.runId ?? undefined,
    sourceUserSeq: source.seq,
  };
  assert.equal(eventlog.getLatestRunAttempt(row.id)?.finishedAt ?? null, null, 'live before the terminal');

  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'Edited the board.' },
  });

  const after = eventlog.getLatestRunAttempt(row.id);
  assert.ok(after?.finishedAt, 'the attempt is closed once its typed terminal exists');
  assert.equal(after?.status, 'completed');
});

test('closing is idempotent and never reopens another owner', () => {
  const { row, attempt, source } = activation('idempotent');
  eventlog.finishRunAttempt({ sessionId: row.id, attemptId: attempt.attemptId }, 'cancelled');
  const firstFinishedAt = eventlog.getLatestRunAttempt(row.id)?.finishedAt;

  const identity = {
    sessionId: row.id, turn: source.turn, attemptId: attempt.attemptId,
    runId: attempt.runId ?? undefined, sourceUserSeq: source.seq,
  };
  commitTurnOutcome({
    version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false,
    presentation: { kind: 'answer', text: 'done' },
  });

  const after = eventlog.getLatestRunAttempt(row.id);
  assert.equal(after?.finishedAt, firstFinishedAt, 'an already-closed attempt is left exactly as it was');
  assert.equal(after?.status, 'cancelled', 'and keeps the status its real owner set');
});

test('responsibility is released even when the attempt already closed', () => {
  // Measured 2026-09-07 source 142450: the attempt finished before the terminal
  // was appended, so the owner-matching branch was skipped and the continuation
  // record outlived the work it described.
  const { row, attempt, source, session } = activation('already-closed');
  const owner = { sourceUserSeq: source.seq, attemptId: attempt.attemptId };
  session.claimContinuationOwner(owner);
  eventlog.finishRunAttempt({ sessionId: row.id, attemptId: attempt.attemptId }, 'completed');

  const identity = {
    sessionId: row.id, turn: source.turn, attemptId: attempt.attemptId,
    runId: attempt.runId ?? undefined, sourceUserSeq: source.seq,
  };
  commitTurnOutcome({
    version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false,
    presentation: { kind: 'answer', text: 'Left it unchanged.' },
  });

  assert.equal(
    HarnessSession.load(row.id).continuationOwnerState(owner), 'absent',
    'a published terminal ends responsibility regardless of who closed the attempt',
  );
});

/* ------------------------------------------------------------------ *
 * OWNERSHIP BEFORE ADOPTION, AND A FAILED CLAIM THAT BITES.
 * ------------------------------------------------------------------ */

test('WAITING TO RESUME is owned from the moment recovery is armed', () => {
  // The window between arming recovery and adopting it was unowned, so a
  // bridge sampling it saw a turn that looked finished. An installed save is
  // the durable proof the work is waiting rather than done.
  const { attempt, source, session } = activation('armed-owns');
  const owner = { sourceUserSeq: source.seq, attemptId: attempt.attemptId };
  assert.equal(session.continuationOwnerState(owner), 'absent', 'unowned before arming');

  const saved = session.saveRecoveryState(
    JSON.stringify({ sourceUserSeq: source.seq, phase: 'finalize' }),
    { owner },
  );
  assert.equal(saved.installed, true);
  session.claimContinuationOwner(owner);   // what the loop does on an installed save
  assert.equal(
    session.continuationOwnerState(owner), 'ours',
    'owned while waiting, before any adoption',
  );
});

test('a FAILED claim leaves the checkpoint intact for its real owner', () => {
  // Adopting without ownership would consume the resume state of work another
  // source owns — the exact loss the checkpoint exists to prevent.
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'refused-adoption' });
  const older = eventlog.beginRunAttempt(row.id, { runId: 'older' });
  const olderSource = eventlog.recordRunAttemptUserInput(older, {
    turn: 1, role: 'user', data: { text: 'first' },
  });
  const session = HarnessSession.load(row.id);

  // The older activation arms recovery and owns continuation...
  session.saveRecoveryState(JSON.stringify({ sourceUserSeq: olderSource.seq, phase: 'continue' }), {
    owner: { sourceUserSeq: olderSource.seq, attemptId: older.attemptId },
  });
  const olderOwner = { sourceUserSeq: olderSource.seq, attemptId: older.attemptId };
  session.claimContinuationOwner(olderOwner);

  // ...then a NEWER source takes continuation responsibility.
  const newerOwner = { sourceUserSeq: olderSource.seq + 5, attemptId: 'newer' };
  assert.equal(session.claimContinuationOwner(newerOwner), true);

  // The older activation's claim must now FAIL, and its failure is what stops
  // the adoption — not merely something written to the log.
  assert.equal(session.claimContinuationOwner(olderOwner), false, 'the claim fails');
  assert.notEqual(session.loadRecoveryState(), null, 'and the checkpoint is still there to adopt');
});

test('a refused claim never silently becomes an adopted conversation', () => {
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'no-silent-adopt' });
  const attempt = eventlog.beginRunAttempt(row.id, { runId: 'quiet' });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: 'work' },
  });
  const session = HarnessSession.load(row.id);
  const blob = JSON.stringify({ sourceUserSeq: source.seq, phase: 'continue' });
  session.saveRecoveryState(blob, { owner: { sourceUserSeq: source.seq, attemptId: attempt.attemptId } });
  session.claimContinuationOwner({ sourceUserSeq: source.seq + 9, attemptId: 'someone-else' });

  const mine = { sourceUserSeq: source.seq, attemptId: attempt.attemptId };
  assert.equal(session.claimContinuationOwner(mine), false);
  assert.equal(session.continuationOwnerState(mine), 'other');
  // The guard is the claim result; adoption is only reached when it succeeds.
  assert.equal(session.loadRecoveryState(), blob, 'the exact bytes survive for the owner');
});

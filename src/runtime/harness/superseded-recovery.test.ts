/**
 * A recovery blob owned by a COMPLETED source must not hold the session.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/superseded-recovery.test.ts
 *
 * Live L12: source 138564 published terminal 138643; a late model response then
 * saved recovery for that dead source ~7s later. Every subsequent accepted
 * source returned `held` before turn_started — no prompt, no model call, no
 * terminal — so one stale blob blocked the session permanently. This is the
 * clear-side half of the fence: retiring a superseded owner must remove exactly
 * those bytes and never a blob another source installed in the interim.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-superseded-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'superseded\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { beginRunAttempt, recordRunAttemptUserInput } = eventlog;
const { HarnessSession } = await import('./session.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

/**
 * A real activation and its accepted source, through the canonical producers.
 * `run_attempts.source_user_seq` REFERENCES `events(seq)`, so an invented
 * source number is not a source — it is a foreign-key violation; and
 * `attempt_id` is the table's PRIMARY KEY, so ids must be globally unique.
 */
function activation(sessionId: string, runId: string) {
  const attempt = beginRunAttempt(sessionId, { runId });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: 'go' },
  });
  return { attempt, source };
}

/** Order two activations of the SAME source: `later` started after `earlier`. */
function startedAfter(attemptId: string, iso: string) {
  eventlog.openEventLog()
    .prepare('UPDATE run_attempts SET started_at = ? WHERE attempt_id = ?')
    .run(iso, attemptId);
}

function session() {
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'superseded' });
  return HarnessSession.load(row.id);
}

test('clearing with the EXACT bytes retires that blob', () => {
  const s = session();
  s.saveRecoveryState('blob-A');
  assert.equal(s.loadRecoveryState(), 'blob-A');
  assert.equal(s.clearRecoveryState('blob-A'), true, 'the owner it names is retired');
  assert.equal(s.loadRecoveryState(), null);
});

test('clearing a SUPERSEDED blob never erases the one that replaced it', () => {
  // The dead source tries to retire its own blob after a live source has already
  // installed a newer one. Without the byte comparison this erased live work.
  const s = session();
  s.saveRecoveryState('blob-live');
  assert.equal(s.clearRecoveryState('blob-stale'), false, 'a stale expectation clears nothing');
  assert.equal(s.loadRecoveryState(), 'blob-live', 'the live owner survives');
});

test('an unconditional clear still works for a turn that owns its own recovery', () => {
  const s = session();
  s.saveRecoveryState('blob-mine');
  assert.equal(s.clearRecoveryState(), true);
  assert.equal(s.loadRecoveryState(), null);
});

test('clearing when nothing is installed is a no-op, not an error', () => {
  const s = session();
  assert.equal(s.clearRecoveryState('anything'), false);
});

/* ------------------------------------------------------------------ *
 * The reviewer's three negatives for retirement authority.
 * ------------------------------------------------------------------ */

test('TWO SESSION INSTANCES: a newer owner installed behind our back survives', () => {
  // The exact shape the durable compare-and-swap exists for. `stale` read
  // blob-A and still holds it in memory; `live` replaced it with blob-B.
  // Comparing cached metadata and updating afterwards passed this check
  // against the stale copy and then erased the replacement — reporting
  // success both times.
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'two-instances' });
  const stale = HarnessSession.load(row.id);
  const live = HarnessSession.load(row.id);
  stale.saveRecoveryState('blob-A');
  assert.equal(stale.loadRecoveryState(), 'blob-A');
  live.saveRecoveryState('blob-B');

  assert.equal(stale.clearRecoveryState('blob-A'), false, 'must not retire bytes it no longer owns');
  assert.equal(HarnessSession.load(row.id).loadRecoveryState(), 'blob-B', 'the replacement survives');
});

test('STORAGE FAILURE retires nothing and reports false', () => {
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'storage-fail' });
  const s = HarnessSession.load(row.id);
  s.saveRecoveryState('blob-A');

  const db = eventlog.openEventLog();
  const realPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    if (sql.includes('json_remove')) throw new Error('disk I/O error');
    return realPrepare(sql);
  };
  try {
    assert.equal(s.clearRecoveryState('blob-A'), false, 'a refused write is not a retirement');
  } finally {
    (db as unknown as { prepare: unknown }).prepare = realPrepare;
  }
  assert.equal(HarnessSession.load(row.id).loadRecoveryState(), 'blob-A', 'ownership is preserved');
});

test('WRITE FENCE: a late older source cannot install over a newer owner', () => {
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'write-fence' });
  const s = HarnessSession.load(row.id);
  s.saveRecoveryState(JSON.stringify({ sourceUserSeq: 900, phase: 'hold' }), {
    owner: { sourceUserSeq: 900 },
  });

  // Source 800's response lands seven seconds late — exactly the L12 shape.
  const installed = s.saveRecoveryState(JSON.stringify({ sourceUserSeq: 800, phase: 'hold' }), {
    owner: { sourceUserSeq: 800 },
  });
  assert.equal(installed.installed, false, 'the obsolete source must be refused');
  assert.equal(
    JSON.parse(HarnessSession.load(row.id).loadRecoveryState() ?? '{}').sourceUserSeq,
    900,
    'the newer owner is intact',
  );
});

test('WRITE FENCE: the owning source still refreshes its own recovery', () => {
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'own-refresh' });
  const s = HarnessSession.load(row.id);
  s.saveRecoveryState(JSON.stringify({ sourceUserSeq: 900, phase: 'hold' }), {
    owner: { sourceUserSeq: 900 },
  });
  assert.equal(
    s.saveRecoveryState(JSON.stringify({ sourceUserSeq: 900, phase: 'continue' }), {
      owner: { sourceUserSeq: 900 },
    }).installed,
    true,
    'a hold that re-holds is not an obsolete write',
  );
  assert.equal(
    JSON.parse(HarnessSession.load(row.id).loadRecoveryState() ?? '{}').phase,
    'continue',
  );
});

test('LEGACY/CORRUPT terminal rows do not authorize retirement', async () => {
  // The compatibility projection turns a legacy or corrupt row into a
  // conservative BLOCKED terminal rather than null, because null alone grants a
  // retry permission. Truthiness therefore proves only that some row claims the
  // source. Retiring live recovery on that evidence would discard genuine
  // in-flight work on the strength of a row nobody can read.
  const { resolveExactTerminalForAcceptedSource, exactTerminalForAcceptedSource } =
    await import('./accepted-source-terminal.js');

  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'legacy-terminal' });
  eventlog.appendEvent({ sessionId: row.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'go' } });
  const source = eventlog.listEvents(row.id, { types: ['user_input_received'] })[0]!;

  // A terminal envelope carrying NEITHER presentation nor turnOutcome — the
  // pre-typed shape still present in older sessions.
  eventlog.appendEvent({
    sessionId: row.id,
    turn: source.turn,
    role: 'system',
    type: 'conversation_completed',
    data: { terminalKey: `turn:${source.seq}`, sourceUserSeq: source.seq, status: 'done' },
  });

  assert.notEqual(
    resolveExactTerminalForAcceptedSource(source).kind,
    'terminal',
    'a legacy envelope is not a typed terminal',
  );
  assert.ok(
    exactTerminalForAcceptedSource(source),
    'the compatibility projection is still non-null — which is exactly why truthiness cannot be the predicate',
  );
});

/* ------------------------------------------------------------------ *
 * Save ownership. The reviewer's private-SQLite case 4 is the anchor:
 * a stale instance for the SAME source replaced the newer activation's
 * checkpoint AND erased unrelated metadata written after it loaded.
 * ------------------------------------------------------------------ */

test('CASE 4: a stale SAME-SOURCE activation cannot overwrite the newer one', () => {
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'case4' });
  const first = activation(row.id, 'case4-A');
  const src = first.source.seq;
  // A SECOND activation of the SAME accepted source — the competing pair.
  const second = beginRunAttempt(row.id, { runId: 'case4-B' });
  eventlog.openEventLog()
    .prepare('UPDATE run_attempts SET source_user_seq = ? WHERE attempt_id = ?')
    .run(src, second.attemptId);
  startedAfter(first.attempt.attemptId, '2026-09-07T00:00:00.000Z');
  startedAfter(second.attemptId, '2026-09-07T00:00:10.000Z');

  const a = HarnessSession.load(row.id);
  const b = HarnessSession.load(row.id);

  a.saveRecoveryState(JSON.stringify({ sourceUserSeq: src, phase: 'A' }), {
    owner: { sourceUserSeq: src, attemptId: first.attempt.attemptId },
  });
  assert.equal(
    b.saveRecoveryState(JSON.stringify({ sourceUserSeq: src, phase: 'B' }), {
      owner: { sourceUserSeq: src, attemptId: second.attemptId },
    }).installed,
    true,
    'the newer activation must be able to claim — otherwise every restart deadlocks',
  );
  // Unrelated metadata written behind A's back.
  eventlog.updateSession(row.id, {
    metadata: {
      ...eventlog.getSession(row.id)!.metadata,
      freshUnrelated: { value: 'must survive' },
      activationTag: 'new-B',
    },
  });

  const stale = a.saveRecoveryState(JSON.stringify({ sourceUserSeq: src, phase: 'A' }), {
    owner: { sourceUserSeq: src, attemptId: first.attempt.attemptId },
  });
  assert.equal(stale.installed, false, 'the stale activation must be refused');
  assert.equal(stale.installed === false && stale.reason, 'owner_conflict');

  const after = eventlog.getSession(row.id)!;
  assert.equal(JSON.parse(after.metadata.__host_recovery_state as string).phase, 'B',
    "B's checkpoint survives");
  assert.deepEqual(after.metadata.freshUnrelated, { value: 'must survive' },
    'unrelated metadata written after A loaded is preserved');
  assert.equal(after.metadata.activationTag, 'new-B');
});

test('a save preserves unrelated metadata instead of replacing the document', () => {
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'preserve' });
  const s = HarnessSession.load(row.id);
  eventlog.updateSession(row.id, {
    metadata: { ...eventlog.getSession(row.id)!.metadata, keepMe: 'yes' },
  });
  const act2 = activation(row.id, 'preserve-a');
  const src2 = act2.source.seq;
  const other = HarnessSession.load(row.id);
  // `other` never saw keepMe... but the write must not resurrect its cached copy.
  eventlog.updateSession(row.id, {
    metadata: { ...eventlog.getSession(row.id)!.metadata, addedLater: 'also yes' },
  });
  assert.equal(
    other.saveRecoveryState(JSON.stringify({ sourceUserSeq: src2, phase: 'x' }), {
      owner: { sourceUserSeq: src2, attemptId: act2.attempt.attemptId },
    }).installed,
    true,
  );
  const after = eventlog.getSession(row.id)!;
  assert.equal(after.keepMe ?? after.metadata.keepMe, 'yes');
  assert.equal(after.metadata.addedLater, 'also yes', 'a field added after load survives');
});

test('TERMINAL BEFORE LATE SAVE: a terminalized source cannot reinstall recovery', () => {
  // The exact L12 shape: the source published a terminal, then its surviving
  // model response tried to persist recovery seven seconds later. The terminal
  // is written by the real committer, not a hand-built envelope.
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'late-save' });
  const { attempt, source } = activation(row.id, 'late-save');
  const identity = {
    sessionId: row.id,
    turn: source.turn,
    attemptId: attempt.attemptId,
    runId: attempt.runId ?? undefined,
    sourceUserSeq: source.seq,
  };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'Answered before the late response landed.' },
  });

  const s = HarnessSession.load(row.id);
  const late = s.saveRecoveryState(JSON.stringify({ sourceUserSeq: source.seq, phase: 'finalize' }), {
    owner: { sourceUserSeq: source.seq, attemptId: attempt.attemptId },
  });
  assert.equal(late.installed, false, 'a finished source owns nothing further');
  assert.equal(late.installed === false && late.reason, 'source_terminalized');
  assert.equal(HarnessSession.load(row.id).loadRecoveryState(), null, 'no recovery was revived');
});

test('an UNOWNED blob: the newest activation claims it, a stale one cannot', () => {
  // Legacy bytes (or an unreadable sidecar) are unknown ownership, not proved
  // absence. Refusing outright would wedge the session — the very deadlock
  // this fence exists to prevent — so the claim is allowed to exactly one
  // activation: the newest.
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'no-sidecar' });
  const stale = activation(row.id, 'unowned-stale');
  const newest = activation(row.id, 'unowned-newest');
  startedAfter(stale.attempt.attemptId, '2026-09-07T00:00:00.000Z');
  startedAfter(newest.attempt.attemptId, '2026-09-07T00:00:10.000Z');

  const s = HarnessSession.load(row.id);
  s.saveRecoveryState('legacy-blob');   // unfenced legacy write, no owner key

  assert.equal(
    s.saveRecoveryState(JSON.stringify({ phase: 'stale' }), {
      owner: { sourceUserSeq: stale.source.seq, attemptId: stale.attempt.attemptId },
    }).installed,
    false,
    'a stale activation cannot claim an unowned blob',
  );
  assert.equal(HarnessSession.load(row.id).loadRecoveryState(), 'legacy-blob');

  assert.equal(
    s.saveRecoveryState(JSON.stringify({ phase: 'newest' }), {
      owner: { sourceUserSeq: newest.source.seq, attemptId: newest.attempt.attemptId },
    }).installed,
    true,
    'the newest activation is not wedged by legacy bytes',
  );
});

test('clearing retires the owner sidecar with the blob', () => {
  // A surviving owner token would fence the NEXT activation out of its own
  // recovery, turning the fix into a different deadlock.
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'sidecar-clear' });
  const one = activation(row.id, 'sidecar-a');
  const two = activation(row.id, 'sidecar-b');
  const s = HarnessSession.load(row.id);
  s.saveRecoveryState('blob', {
    owner: { sourceUserSeq: one.source.seq, attemptId: one.attempt.attemptId },
  });
  assert.equal(s.clearRecoveryState('blob'), true);
  assert.equal(
    s.saveRecoveryState('next', {
      owner: { sourceUserSeq: two.source.seq, attemptId: two.attempt.attemptId },
    }).installed,
    true,
    'the next activation can install after a clear',
  );
});

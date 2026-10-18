/** Scheduling controls only. No provider/model execution; real retained-owner
 * projection is additionally exercised by the Northstar cold timing fixture. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-async-read-wake-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const { planAsyncReadRefinementGetterWake: plan, asyncReadRefinementRecoveryWake: project } = await import('./async-read-refinement-store.js');
const log = await import('./eventlog.js');
const epoch = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (offset: number) => new Date(epoch + offset).toISOString();
const input = { startRecordedAt: iso(0), previousSettledAt: iso(100), attemptOrdinal: 1, maximumElapsedMs: 180_000 };
test.after(() => { log.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

test('restart, elapsed time and rollback retain the exact prior-settlement due time', () => {
  const retained = Object.freeze(input);
  assert.deepEqual(plan({ ...retained, nowMs: epoch + 200 }), { status: 'waiting', notBeforeAtMs: epoch + 1_100, remainingMs: 900 });
  assert.deepEqual(plan({ ...JSON.parse(JSON.stringify(retained)), nowMs: epoch + 1_099 }), { status: 'waiting', notBeforeAtMs: epoch + 1_100, remainingMs: 1 });
  assert.deepEqual(plan({ ...retained, nowMs: epoch + 1_100 }), { status: 'ready', notBeforeAtMs: epoch + 1_100 });
  assert.deepEqual(plan({ ...retained, nowMs: epoch - 100 }), { status: 'waiting', notBeforeAtMs: epoch + 1_100, remainingMs: 1_200 });
});

test('first read uses the retained start; later ordinals use the exact predecessor', () => {
  assert.deepEqual(plan({ startRecordedAt: iso(0), attemptOrdinal: 0, maximumElapsedMs: 180_000, nowMs: epoch }), { status: 'ready', notBeforeAtMs: epoch });
  for (const [attemptOrdinal, delay] of [[2, 2_500], [3, 5_000], [4, 10_000], [5, 20_000]]) {
    assert.deepEqual(plan({ ...input, attemptOrdinal: attemptOrdinal!, nowMs: epoch + 100 }), {
      status: 'waiting', notBeforeAtMs: epoch + 100 + delay!, remainingMs: delay,
    });
  }
});

test('parseable noncanonical dates, missing predecessors and invalid ordinals cannot schedule reads', () => {
  for (const timestamp of ['1', '2026-02-30T00:00:00.000Z', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00.000+00:00', '']) {
    assert.equal(plan({ ...input, startRecordedAt: timestamp, nowMs: epoch }).status, 'invalid');
    assert.equal(plan({ ...input, previousSettledAt: timestamp, nowMs: epoch }).status, 'invalid');
  }
  for (const attemptOrdinal of [-1, 6, 0.5, NaN]) assert.equal(plan({ ...input, attemptOrdinal, nowMs: epoch }).status, 'invalid');
  assert.equal(plan({ ...input, previousSettledAt: undefined, nowMs: epoch }).status, 'invalid');
  assert.equal(plan({ ...input, attemptOrdinal: 0, nowMs: epoch }).status, 'invalid');
  assert.equal(plan({ ...input, previousSettledAt: iso(-1), nowMs: epoch }).status, 'invalid');
});

test('deadline and due equality return to the kernel rather than scheduling a new provider crossing', () => {
  assert.deepEqual(plan({ ...input, nowMs: epoch + 180_000 }), { status: 'expired', deadlineAtMs: epoch + 180_000 });
  assert.deepEqual(plan({ ...input, previousSettledAt: iso(179_000), nowMs: epoch + 170_000 }), { status: 'expired', deadlineAtMs: epoch + 180_000 });
  for (const maximumElapsedMs of [0, -1, Infinity, Number.MAX_SAFE_INTEGER]) assert.equal(plan({ ...input, maximumElapsedMs, nowMs: epoch }).status, 'invalid');
});

test('unrelated and mixed frame calls keep ordinary recovery and passive projection writes no receipts', () => {
  const session = log.createSession({ id: 'async-wake-no-owner', kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Controlled scheduling fixture.' } });
  const db = log.openEventLog();
  const before = db.prepare('SELECT total_changes() AS n').get() as { n: number };
  db.pragma('query_only=ON');
  try {
    for (const logicalToolCallIds of [[], ['not-an-async-owner'], ['waiting-async-owner', 'ready-sibling']]) {
      assert.deepEqual(project({ sessionId: session.id, sourceUserSeq: source.seq, logicalToolCallIds, nowMs: epoch }), { status: 'ordinary' });
    }
    assert.deepEqual(project({ sessionId: session.id, sourceUserSeq: source.seq, logicalToolCallIds: ['not-an-async-owner'], nowMs: NaN }), { status: 'invalid' });
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before);
  } finally { db.pragma('query_only=OFF'); }
});

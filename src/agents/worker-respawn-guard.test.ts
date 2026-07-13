/**
 * Run: npx tsx --test src/agents/worker-respawn-guard.test.ts
 *
 * The convergence half of the 2026-06-22 fan-out fix. When a per-client worker
 * hits its turn cap, the orchestrator must NOT re-spawn the same item (a re-run
 * with the same packet just caps again — the observed non-converging loop). This
 * verifies the two pieces deterministically against a REAL eventlog:
 *   (1) normalizeWorkerItemKey collapses the observed label DRIFT
 *       ("…barkerlanelaw.com" vs "…barkerlanelaw.com (Savannah, GA)"), and
 *   (2) workerItemAlreadyCapped returns true for a drifted re-spawn of a capped
 *       item, false for a fresh item — fail-open by construction.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-respawn-guard-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeWorkerItemKey, workerItemAlreadyCapped, workerAlreadyCompletedForPacket, workerResumeIdempotencyEnabled } = await import('./worker-respawn-guard.js');
const { resetEventLog, createSession, appendEvent } = await import('../runtime/harness/eventlog.js');
const { summarizeFanoutCoverage } = await import('../runtime/harness/fanout-ledger.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('normalizeWorkerItemKey: domain anchor defeats trailing-parenthetical drift', () => {
  const a = normalizeWorkerItemKey('Howard Barker Lane — barkerlanelaw.com');
  const b = normalizeWorkerItemKey('Howard Barker Lane — barkerlanelaw.com (Savannah, GA)');
  assert.equal(a, 'barkerlanelaw.com');
  assert.equal(a, b, 'the drifted label normalizes to the same domain key');
});

test('normalizeWorkerItemKey: case + separator folding when no domain present', () => {
  assert.equal(
    normalizeWorkerItemKey('Nova Legal  Group'),
    normalizeWorkerItemKey('nova legal group'),
  );
  assert.equal(normalizeWorkerItemKey(null), '');
  assert.equal(normalizeWorkerItemKey(''), '');
});

test('distinct domains do NOT collide', () => {
  assert.notEqual(
    normalizeWorkerItemKey('Firm A — firma.com'),
    normalizeWorkerItemKey('Firm B — firmb.com'),
  );
});

test('workerItemAlreadyCapped: a drifted re-spawn of a capped item is detected; a fresh item is not', () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const sid = sess.id;

  // No caps yet → nothing is "already capped".
  assert.equal(workerItemAlreadyCapped(sid, 'Howard Barker Lane — barkerlanelaw.com'), false);

  // Record the cap exactly as hooks.ts does (type worker_capped, data.item).
  appendEvent({
    sessionId: sid,
    turn: 0,
    role: 'system',
    type: 'worker_capped',
    data: { callId: 'call_x', item: 'Howard Barker Lane — barkerlanelaw.com' },
  });

  // The drifted re-spawn label is refused (matched via the domain key).
  assert.equal(
    workerItemAlreadyCapped(sid, 'Howard Barker Lane — barkerlanelaw.com (Savannah, GA)'),
    true,
    'drifted re-spawn of a capped item is caught',
  );
  // A genuinely different item is still allowed through.
  assert.equal(workerItemAlreadyCapped(sid, 'Nova Legal Group — novalegalgroup.com'), false);
  // An empty/unknown item key never matches (fail-open, no false refuse).
  assert.equal(workerItemAlreadyCapped(sid, ''), false);
  assert.equal(workerItemAlreadyCapped(sid, null), false);
});

test('cap on item A never suppresses a first attempt on item B (item-scoped, not session-scoped)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const sid = sess.id;
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_capped', data: { callId: 'c1', item: 'Firm A — firma.com' } });
  assert.equal(workerItemAlreadyCapped(sid, 'Firm A — firma.com'), true);
  assert.equal(workerItemAlreadyCapped(sid, 'Firm B — firmb.com'), false, 'B is a first attempt, must be allowed');
});

// ── Wave 4 Stage 1: durable-resume idempotency ──────────────────────────────

test('workerAlreadyCompletedForPacket: an ok result for THIS packet is detected on replay; a failed one is not', () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const sid = sess.id;

  // Nothing recorded yet → a first spawn is never a duplicate.
  assert.equal(workerAlreadyCompletedForPacket(sid, 'pk_alpha'), false);

  // A SUCCESSFUL worker records worker_result {ok:true, packetKey}.
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item: 'Firm A', ok: true, packetKey: 'pk_alpha' } });
  assert.equal(workerAlreadyCompletedForPacket(sid, 'pk_alpha'), true, 'a replayed completed packet short-circuits');

  // A DIFFERENT packet (re-processing the same item with new instructions) runs.
  assert.equal(workerAlreadyCompletedForPacket(sid, 'pk_beta'), false, 'a distinct packet is not a duplicate');

  // A FAILED result must NOT short-circuit — the item should be retried on resume.
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item: 'Firm C', ok: false, packetKey: 'pk_gamma' } });
  assert.equal(workerAlreadyCompletedForPacket(sid, 'pk_gamma'), false, 'a failed packet is retryable, not skipped');

  // Fail-open on empty/missing key — never blocks a first spawn.
  assert.equal(workerAlreadyCompletedForPacket(sid, ''), false);
  assert.equal(workerAlreadyCompletedForPacket(sid, null), false);
});

test('workerAlreadyCompletedForPacket: a pre-Stage-1 worker_result with NO packetKey never matches (forward-only)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const sid = sess.id;
  // Legacy ok result carries item but no packetKey → cannot be matched, so the
  // guard stays inert for runs that started on an older build.
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item: 'Legacy Item', ok: true } });
  assert.equal(workerAlreadyCompletedForPacket(sid, 'pk_alpha'), false);
});

test('workerAlreadyCompletedForPacket: a CHAT session never short-circuits (F5 — no cross-turn suppression)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const sid = sess.id;
  // Same durable ok result as the execution case, but on a chat session — an
  // identical packet re-issued in a later user turn ("resend those emails") must
  // run, not be reused. The guard is scoped to unattended run sessions only.
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item: 'Firm A', ok: true, packetKey: 'pk_alpha' } });
  assert.equal(workerAlreadyCompletedForPacket(sid, 'pk_alpha'), false, 'chat session → guard inert');
});

test('workerResumeIdempotencyEnabled: default ON; off|0|false|no all disable', () => {
  const prev = process.env.CLEMMY_WORKER_RESUME_IDEMPOTENCY;
  try {
    delete process.env.CLEMMY_WORKER_RESUME_IDEMPOTENCY;
    assert.equal(workerResumeIdempotencyEnabled(), true, 'default ON');
    for (const off of ['off', '0', 'false', 'no', 'OFF', 'False']) {
      process.env.CLEMMY_WORKER_RESUME_IDEMPOTENCY = off;
      assert.equal(workerResumeIdempotencyEnabled(), false, `${off} disables`);
    }
    process.env.CLEMMY_WORKER_RESUME_IDEMPOTENCY = 'on';
    assert.equal(workerResumeIdempotencyEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_WORKER_RESUME_IDEMPOTENCY; else process.env.CLEMMY_WORKER_RESUME_IDEMPOTENCY = prev;
  }
});

test('summarizeFanoutCoverage: honest M of N read DIRECTLY from the durable worker_result log (restart-safe, no in-memory rehydrate)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const sid = sess.id;
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item: 'Acme LLP', ok: true, packetKey: 'pk1' } });
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item: 'Bar Law', ok: true, packetKey: 'pk2' } });
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item: 'Qux Legal', ok: false, reason: 'ERROR: no email', packetKey: 'pk3' } });

  const s = summarizeFanoutCoverage(sid);
  assert.equal(s.total, 3);
  assert.equal(s.done, 2);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.failedItems, ['Qux Legal']);
});

test('summarizeFanoutCoverage: a re-driven / reused worker (same packetKey twice) is NOT double-counted; failed-then-succeeded → ok', () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const sid = sess.id;
  // Item B fails pre-restart, then succeeds on resume (the sharp cross-restart
  // case the old rehydrate double-counted / left stale-failed). Same packetKey.
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item: 'B', ok: false, reason: 'ERROR: transient', packetKey: 'pkB' } });
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item: 'A', ok: true, packetKey: 'pkA' } });
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item: 'B', ok: true, packetKey: 'pkB' } });
  // And a reuse short-circuit re-emits A's ok result (same packetKey again).
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item: 'A', ok: true, packetKey: 'pkA' } });

  const s = summarizeFanoutCoverage(sid);
  assert.equal(s.total, 2, 'two distinct packets → two items, never inflated by replays');
  assert.equal(s.done, 2);
  assert.equal(s.failed, 0, 'B\'s final ok wins — no phantom failure after the successful resume');
});

test('summarizeFanoutCoverage: empty / no-fanout session → zeroed coverage (never a hollow-done trigger)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  assert.deepEqual(summarizeFanoutCoverage(sess.id), { total: 0, done: 0, failed: 0, failedItems: [] });
  assert.deepEqual(summarizeFanoutCoverage(''), { total: 0, done: 0, failed: 0, failedItems: [] });
});

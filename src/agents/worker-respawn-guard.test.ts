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

const { normalizeWorkerItemKey, workerItemAlreadyCapped } = await import('./worker-respawn-guard.js');
const { resetEventLog, createSession, appendEvent } = await import('../runtime/harness/eventlog.js');

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

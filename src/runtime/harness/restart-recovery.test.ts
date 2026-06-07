/**
 * Run: npx tsx --test src/runtime/harness/restart-recovery.test.ts
 *
 * Restart recovery (#3): a chat run killed mid-flight leaves an in-flight marker
 * that survives the restart; on boot we surface it (non-silent
 * conversation_completed + "reply continue") instead of dying silently. Cleanly-
 * finished runs (no marker) and non-chat sessions are never touched.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-restart-rec-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
writeFileSync(path.join(TMP, 'state', 'machine-id'), 'machine-A\n');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { HarnessSession } = await import('./session.js');
const { listEvents } = await import('./eventlog.js');
const { reportInterruptedChatRuns } = await import('./restart-recovery.js');

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

function hasInterruptedEvent(sessionId: string): boolean {
  return listEvents(sessionId, { limit: 50 }).some(
    (e) => e.type === 'conversation_completed'
      && (e.data as { reason?: string } | undefined)?.reason === 'interrupted_by_restart',
  );
}

test('marker round-trip: set then clear', () => {
  const s = HarnessSession.create({ kind: 'chat', title: 't' });
  assert.equal(s.runInFlightSince(), null);
  s.setRunInFlight('2026-06-07T00:00:00.000Z');
  assert.equal(HarnessSession.load(s.id)?.runInFlightSince(), '2026-06-07T00:00:00.000Z');
  HarnessSession.load(s.id)!.clearRunInFlight();
  assert.equal(HarnessSession.load(s.id)?.runInFlightSince(), null);
});

test('surfaces ONLY interrupted chat runs; leaves clean + non-chat sessions alone', () => {
  const interrupted = HarnessSession.create({ kind: 'chat', title: 'long task' });
  interrupted.setRunInFlight('2026-06-07T00:00:00.000Z');
  const clean = HarnessSession.create({ kind: 'chat', title: 'finished task' }); // no marker
  const wf = HarnessSession.create({ kind: 'workflow', title: 'wf' }); // wrong kind — never scanned

  const recovered = reportInterruptedChatRuns(() => 1000);
  assert.equal(recovered, 1, 'exactly the one marked chat run is recovered');

  // marker cleared on the recovered run
  assert.equal(HarnessSession.load(interrupted.id)?.runInFlightSince(), null);
  // non-silent notice emitted on the interrupted run
  assert.ok(hasInterruptedEvent(interrupted.id), 'interrupted run got a non-silent notice');
  // clean + workflow sessions untouched
  assert.ok(!hasInterruptedEvent(clean.id), 'a clean run is never flagged');
  assert.ok(!hasInterruptedEvent(wf.id), 'a non-chat session is never flagged');
});

test('idempotent: a second boot scan finds nothing (marker already cleared)', () => {
  const s = HarnessSession.create({ kind: 'chat', title: 'x' });
  s.setRunInFlight('2026-06-07T00:00:00.000Z');
  assert.equal(reportInterruptedChatRuns(() => 2000), 1);
  assert.equal(reportInterruptedChatRuns(() => 2001), 0, 'no double-recovery');
});

test('kill-switch off → no-op (marker preserved, nothing surfaced)', () => {
  const prev = process.env.CLEMMY_CHAT_RESTART_RECOVERY;
  const s = HarnessSession.create({ kind: 'chat', title: 'y' });
  s.setRunInFlight('2026-06-07T00:00:00.000Z');
  try {
    process.env.CLEMMY_CHAT_RESTART_RECOVERY = 'off';
    assert.equal(reportInterruptedChatRuns(() => 3000), 0);
    assert.equal(HarnessSession.load(s.id)?.runInFlightSince(), '2026-06-07T00:00:00.000Z', 'marker untouched when disabled');
    assert.ok(!hasInterruptedEvent(s.id));
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CHAT_RESTART_RECOVERY;
    else process.env.CLEMMY_CHAT_RESTART_RECOVERY = prev;
  }
});

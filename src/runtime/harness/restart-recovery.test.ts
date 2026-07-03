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
const { reportInterruptedChatRuns, recoverInterruptedChatRuns, markRunInFlight, restartRecoveryPrimerPrefixForTests } = await import('./restart-recovery.js');

test('exported markRunInFlight: arms + clears a CHAT session, skips non-chat, respects the kill-switch', () => {
  const chat = HarnessSession.create({ kind: 'chat', title: 'c' });
  markRunInFlight(chat.id, true);
  assert.notEqual(HarnessSession.load(chat.id)?.runInFlightSince(), null, 'chat session is armed');
  markRunInFlight(chat.id, false);
  assert.equal(HarnessSession.load(chat.id)?.runInFlightSince(), null, 'chat session is cleared');

  // Non-chat sessions are never marked (workflow/agent have their own resume).
  const wf = HarnessSession.create({ kind: 'workflow', title: 'w' });
  markRunInFlight(wf.id, true);
  assert.equal(HarnessSession.load(wf.id)?.runInFlightSince(), null, 'non-chat session is never armed');

  // Kill-switch fully disables it.
  const prev = process.env.CLEMMY_CHAT_RESTART_RECOVERY;
  process.env.CLEMMY_CHAT_RESTART_RECOVERY = 'off';
  try {
    const c2 = HarnessSession.create({ kind: 'chat', title: 'c2' });
    markRunInFlight(c2.id, true);
    assert.equal(HarnessSession.load(c2.id)?.runInFlightSince(), null, 'kill-switch off → never armed');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CHAT_RESTART_RECOVERY; else process.env.CLEMMY_CHAT_RESTART_RECOVERY = prev;
  }
});

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

test('structured recovery prepares a durable replay primer in the harness snapshot', () => {
  const interrupted = HarnessSession.create({ kind: 'chat', title: 'recoverable long task' });
  interrupted.updateConversationSnapshot([{ role: 'user', content: 'Research the market and build the report.' }]);
  interrupted.setRunInFlight('2026-06-07T00:00:00.000Z');

  const summary = recoverInterruptedChatRuns(() => 1234);
  assert.equal(summary.enabled, true);
  assert.equal(summary.recovered, 1);
  assert.equal(summary.notified, 1);
  assert.equal(summary.records.length, 1);
  const record = summary.records[0];
  assert.equal(record.sessionId, interrupted.id);
  assert.equal(record.replayPrepared, true);
  assert.equal(record.snapshotItemsBefore, 1);
  assert.equal(record.snapshotItemsAfter, 2);
  assert.equal(record.markerCleared, true);

  const items = HarnessSession.load(interrupted.id)!.toInputItems();
  assert.ok(items.some((it) => {
    const content = (it as { content?: unknown }).content;
    return typeof content === 'string'
      && content.startsWith(restartRecoveryPrimerPrefixForTests())
      && content.includes('continue');
  }), 'restart primer is durably replayed on the next turn');

  const notice = listEvents(interrupted.id, { limit: 20 }).find(
    (e) => e.type === 'conversation_completed'
      && (e.data as { reason?: string } | undefined)?.reason === 'interrupted_by_restart',
  );
  assert.equal((notice?.data as { replayPrepared?: boolean } | undefined)?.replayPrepared, true);
  assert.equal((notice?.data as { snapshotItemsAfter?: number } | undefined)?.snapshotItemsAfter, 2);
});

test('boot scan finds an interrupted chat behind newer session pages', () => {
  const interrupted = HarnessSession.create({ kind: 'chat', title: 'older interrupted task' });
  interrupted.setRunInFlight('2026-06-07T00:00:00.000Z');

  for (let i = 0; i < 125; i += 1) {
    HarnessSession.create({ kind: 'chat', title: `newer clean chat ${i}` });
  }

  const recovered = reportInterruptedChatRuns(() => 1500);
  assert.equal(recovered, 1, 'older interrupted chat behind the default first page is recovered');
  assert.equal(HarnessSession.load(interrupted.id)?.runInFlightSince(), null);
  assert.ok(hasInterruptedEvent(interrupted.id), 'older interrupted chat got a non-silent restart notice');
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

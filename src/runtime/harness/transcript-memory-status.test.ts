import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-transcript-memory-status-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const log = await import('./eventlog.js');
const { reconstructHarnessTranscript } = await import('./transcript.js');
const { publicTerminalFacts } = await import('./public-presentation.js');
after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
function source(sessionId: string, turn = 1, extra: Record<string, unknown> = {}) {
  if (!log.getSession(sessionId)) log.createSession({ id: sessionId, kind: 'chat' });
  return log.appendEvent({ sessionId, turn, role: 'user', type: 'user_input_received', data: { text: 'Controlled memory request.', ...extra } });
}
function terminal(owner: ReturnType<typeof source>, options: { sessionId?: string; identitySessionId?: string; reason?: string; sourceUserSeq?: number; attemptId?: string } = {}) {
  const sessionId = options.sessionId ?? owner.sessionId, sourceUserSeq = options.sourceUserSeq ?? owner.seq;
  const id = options.attemptId ? `brain:${options.attemptId}` : `turn:${sourceUserSeq}`;
  const data = { sourceUserSeq, terminalKey: id, ...(options.attemptId ? { attemptId: options.attemptId } : { logicalTerminalVersion: 1 }),
    blockedReason: options.reason ?? 'memory_consolidation_pending', reply: 'Controlled update is pending.', reason: 'PRIVATE_REASON_NEVER_EXPOSE',
    presentation: { version: 1, id: `${id}:presentation`, outcomeId: id, audience: 'user', phase: 'final',
      identity: { sessionId: options.identitySessionId ?? sessionId, sourceUserSeq, turn: owner.turn, ...(options.attemptId ? { attemptId: options.attemptId } : {}) },
      status: 'blocked', kind: 'blocked', text: 'Controlled update is pending.', resumable: true },
    turnOutcome: { version: 2, id, status: 'blocked', resumable: true } };
  return log.appendEvent({ sessionId, turn: owner.turn, role: 'system', type: 'conversation_completed', data });
}
test('real reconstruction exposes exact source and known memory hint without changing retained rows', () => {
  const owner = source('history-memory-exact', 3), done = terminal(owner);
  const before = log.openEventLog().prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq').all(owner.sessionId);
  const turns = reconstructHarnessTranscript(owner.sessionId);
  const expected = { sessionId: owner.sessionId, sourceUserSeq: owner.seq, turn: 3 };
  assert.deepEqual(turns.map(row => row.acceptedSource), [expected, expected]);
  const assistant = turns.find(row => row.role === 'assistant')!;
  assert.equal(assistant.terminal?.sourceUserSeq, owner.seq);
  assert.equal(assistant.terminal?.blockedReason, 'memory_consolidation_pending');
  assert.doesNotMatch(JSON.stringify(turns), /PRIVATE_REASON_NEVER_EXPOSE/);
  assert.deepEqual(log.openEventLog().prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq').all(owner.sessionId), before);
  assert.equal(log.getEvent(done.id)?.data.blockedReason, 'memory_consolidation_pending');
});
test('each continuation/session keeps its own original source instead of a conversation latest source', () => {
  const first = source('history-memory-first', 1); terminal(first, { attemptId: 'controlled-attempt-a' });
  const second = source(first.sessionId, 2); terminal(second, { reason: 'memory_work_unverified', attemptId: 'controlled-attempt-b' });
  const child = source('history-memory-continuation', 1); terminal(child, { reason: 'memory_work_unverified' });
  for (const owner of [first, second, child]) {
    const assistant = reconstructHarnessTranscript(owner.sessionId).find(row => row.role === 'assistant' && row.acceptedSource?.sourceUserSeq === owner.seq)!;
    assert.deepEqual(assistant.acceptedSource, { sessionId: owner.sessionId, sourceUserSeq: owner.seq, turn: owner.turn });
    assert.equal(assistant.terminal?.sourceUserSeq, owner.seq);
  }
});
test('synthetic input, check-ins, orphan and legacy display fallbacks gain no accepted assistant identity', () => {
  const synthetic = source('history-synthetic', 1, { synthetic: true, source: 'outcome' }); terminal(synthetic);
  for (const row of reconstructHarnessTranscript(synthetic.sessionId)) {
    assert.equal(row.acceptedSource, undefined); assert.equal(row.terminal?.blockedReason, undefined);
  }
  const owner = source('history-display-only');
  log.appendConversationCheckIn({ source: owner, text: 'Controlled progress update.' });
  log.appendEvent({ sessionId: owner.sessionId, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Legacy display only.', blockedReason: 'memory_consolidation_pending' } });
  for (const row of reconstructHarnessTranscript(owner.sessionId).filter(row => row.role === 'assistant')) {
    assert.equal(row.acceptedSource, undefined); assert.equal(row.terminal?.blockedReason, undefined);
  }
  const orphanOwner = source('history-orphan-origin');
  log.createSession({ id: 'history-orphan-destination', kind: 'chat' });
  const orphan = terminal(orphanOwner);
  const orphanData = structuredClone(orphan.data);
  ((orphanData.presentation as Record<string, unknown>).identity as Record<string, unknown>).sessionId = 'history-orphan-destination';
  // The normal writer refuses this shape. Reconstruct an old/corrupt retained
  // row directly in the disposable fixture to exercise the read boundary.
  log.openEventLog().prepare('UPDATE events SET session_id = ?, data_json = ? WHERE id = ?')
    .run('history-orphan-destination', JSON.stringify(orphanData), orphan.id);
  assert.deepEqual(reconstructHarnessTranscript('history-orphan-destination'), []);
});
test('foreign or tampered terminal identity never borrows the visible request', () => {
  const owner = source('history-foreign-identity');
  const own = terminal(owner);
  const foreign = { ...own, data: structuredClone(own.data) };
  ((foreign.data.presentation as Record<string, unknown>).identity as Record<string, unknown>).sessionId = 'foreign-owner';
  log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(foreign.data), own.id);
  assert.deepEqual(reconstructHarnessTranscript(owner.sessionId).map(row => row.role), ['user']);
  assert.equal(publicTerminalFacts(foreign.data, owner.sessionId, foreign, owner).blockedReason, undefined);
  assert.equal(publicTerminalFacts(own.data, owner.sessionId, own, { ...owner, seq: owner.seq + 100 }).blockedReason, undefined);
  assert.equal(publicTerminalFacts(own.data, owner.sessionId, own).blockedReason, undefined, 'typed reason alone is not retained source proof');
  assert.equal(publicTerminalFacts({ ...own.data, blockedReason: 'memory_work_unverified' }, owner.sessionId, own, owner).blockedReason, undefined, 'mutated caller data is not the actual terminal');
});
test('unknown stop reasons stay private and exact explicit legacy ownership cannot create a memory hint', () => {
  const owner = source('history-known-reasons'); terminal(owner, { reason: 'PRIVATE_UNKNOWN_STOP_REASON' });
  const reply = reconstructHarnessTranscript(owner.sessionId).find(row => row.role === 'assistant')!;
  assert.equal(reply.acceptedSource?.sourceUserSeq, owner.seq); assert.equal(reply.terminal?.blockedReason, undefined);
  assert.doesNotMatch(JSON.stringify(reply), /PRIVATE_UNKNOWN_STOP_REASON|PRIVATE_REASON_NEVER_EXPOSE/);
  const legacy = source('history-legacy-exact');
  log.appendEvent({ sessionId: legacy.sessionId, turn: legacy.turn, role: 'system', type: 'conversation_completed',
    data: { sourceUserSeq: legacy.seq, reply: 'Explicit legacy display.', blockedReason: 'memory_consolidation_pending' } });
  const legacyReply = reconstructHarnessTranscript(legacy.sessionId).find(row => row.role === 'assistant')!;
  assert.equal(legacyReply.acceptedSource?.sourceUserSeq, legacy.seq); assert.equal(legacyReply.terminal, undefined);
});

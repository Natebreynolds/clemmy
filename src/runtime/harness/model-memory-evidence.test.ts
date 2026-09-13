import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-model-memory-evidence-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const log = await import('./eventlog.js');
const memory = await import('./model-memory-evidence.js');
after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('only producer-owned memory that survives request filtering is visible', () => {
  const instructions = memory.withInstructionMemory(() => '', ['remembered preference', 'removed memory']);
  assert.deepEqual(memory.visibleInstructionMemory(instructions, 'prefix remembered preference suffix', []), ['remembered preference']);
  assert.deepEqual(memory.visibleInstructionMemory(instructions, '', [{ content: [{ type: 'input_text', text: 'remembered preference' }] }]), ['remembered preference']);
  assert.deepEqual(memory.visibleInstructionMemory(instructions, 'a summary replacing all exact fragments', []), []);
  assert.deepEqual(memory.visibleInstructionMemory(() => '', 'remembered preference', []), []);
});

test('the latest accepted memory snapshot survives reopen, remains source-specific and detects corrupt evidence', () => {
  const session = log.createSession({ id: 'memory-evidence', kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, type: 'user_input_received', role: 'user', data: { text: 'Plan a briefing.' } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  memory.recordAcceptedModelMemory(identity, ['old preference'], 'response-1');
  memory.recordAcceptedModelMemory(identity, ['current preference'], 'response-2');
  memory.recordAcceptedModelMemory(identity, ['current preference'], 'response-3');
  assert.equal(log.listEvents(session.id, { types: ['guardrail_tripped'] }).length, 2, 'unchanged context is stored once');
  log.closeEventLog();
  assert.match(memory.acceptedModelMemoryEvidence(identity)!, /current preference/);
  assert.doesNotMatch(memory.acceptedModelMemoryEvidence(identity)!, /old preference/);
  const other = log.appendEvent({ sessionId: session.id, turn: 2, type: 'user_input_received', role: 'user', data: { text: 'Another task.' } });
  assert.equal(memory.acceptedModelMemoryEvidence({ sessionId: session.id, sourceUserSeq: other.seq }), undefined);
  log.appendEvent({ sessionId: session.id, turn: 0, type: 'guardrail_tripped', role: 'system', data: { kind: 'model_memory_context', version: 1, sourceUserSeq: source.seq, fragments: ['tampered'], digest: 'wrong' } });
  assert.match(memory.acceptedModelMemoryEvidence(identity)!, /unreadable/);
  assert.doesNotMatch(memory.acceptedModelMemoryEvidence(identity)!, /tampered/);
});

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

test('a version-2 record names each section by tier with totals and the core address, and version 1 stays readable', () => {
  const session = log.createSession({ id: 'memory-evidence-v2', kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, type: 'user_input_received', role: 'user', data: { text: 'Plan a briefing.' } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  const entry = (section: string, tier: 'core' | 'relevant' | 'now', tokens: number, refs: Array<{ type: string; id: string }> = []) =>
    ({ section, tier, tokens, bytes: tokens * 4, refs });
  const instructions = memory.withInstructionMemory(() => '', [
    { text: 'CORE TEXT', manifest: [entry('Standing Policies', 'core', 30, [{ type: 'policy', id: '7' }])], coreSha: 'a'.repeat(64) },
    { text: 'NOW TEXT', manifest: [entry('Right Now', 'now', 5)] },
  ]);
  memory.registerMemoryTail('TAIL TEXT', [entry('Relevant To This Request', 'relevant', 12, [{ type: 'fact', id: '3' }])]);
  const visible = memory.visibleModelMemory(instructions, 'CORE TEXT NOW TEXT', [{ role: 'system', content: 'TAIL TEXT' }]);
  memory.recordAcceptedModelMemory(identity, visible, 'response-v2');
  const row = log.listEvents(session.id, { types: ['guardrail_tripped'] }).at(-1)!.data;
  assert.equal(row.version, 2);
  assert.deepEqual((row.manifest as Array<{ section: string; tier: string }>).map((e) => [e.section, e.tier]),
    [['Standing Policies', 'core'], ['Right Now', 'now'], ['Relevant To This Request', 'relevant']]);
  assert.deepEqual(row.totals, { tokens: 47, bytes: 188, coreTokens: 30, relevantTokens: 12, nowTokens: 5 });
  assert.equal(row.coreSha, 'a'.repeat(64));
  assert.match(memory.acceptedModelMemoryEvidence(identity)!, /CORE TEXT[\s\S]*TAIL TEXT/, 'reviewers read version 2 as they read version 1');
  const record = memory.latestModelMemoryManifest(session.id)!;
  assert.equal(record.sourceUserSeq, source.seq);
  assert.equal(record.version, 2);
  assert.equal(JSON.stringify(record).includes('CORE TEXT'), false, 'the manifest never carries memory text');
  log.appendEvent({ sessionId: session.id, turn: 0, type: 'guardrail_tripped', role: 'system', data: { kind: 'model_memory_context', version: 1, sourceUserSeq: source.seq + 100, fragments: ['legacy'], digest: memory._digestForTests(['legacy']) } });
  assert.match(memory.acceptedModelMemoryEvidence({ sessionId: session.id, sourceUserSeq: source.seq + 100 })!, /legacy/);
  assert.deepEqual(memory.latestModelMemoryManifest(session.id)?.manifest, [], 'a version-1 row has no sections to list');
  assert.equal(memory.latestModelMemoryManifest(session.id, source.seq)?.version, 2, 'a named source is looked up exactly');
});

test('a registered tail contained in the tail a request carries is not a second view', () => {
  const instructions = memory.withInstructionMemory(() => '', ['CORE']);
  memory.registerMemoryTail('_pointer line_');
  memory.registerMemoryTail('ranked lines\n\n_pointer line_');
  const visible = memory.visibleModelMemory(instructions, 'CORE', [{ role: 'system', content: 'ranked lines\n\n_pointer line_' }]);
  assert.deepEqual(visible.map((fragment) => fragment.text), ['CORE', 'ranked lines\n\n_pointer line_']);
});

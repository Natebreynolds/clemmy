import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { correctionSupersedesStore, correctionSupersessionChecks,
  type CorrectionProofFact, type CorrectionProofSource } from './scenarios/correction-supersedes-store.js';
import type { DaemonHandle } from './types.js';

const scope = { projectId: 'controlled-project', agentKey: 'controlled-agent' };
const nowMs = Date.parse('2026-10-16T12:05:00Z');
const stated: CorrectionProofSource = { sessionId: 'controlled-memory', sourceUserSeq: 10,
  sourceEventId: 'accepted-old', occurredAt: '2026-10-16T12:00:00Z', scope };
const corrected: CorrectionProofSource = { ...stated, sourceUserSeq: 20, sourceEventId: 'accepted-correction', occurredAt: '2026-10-16T12:01:00Z' };
const oldFact: CorrectionProofFact = { id: 11, kind: 'project', content: 'The controlled heading is OLD VALUE.', active: true,
  supersededByFactId: null, sourceSessionId: stated.sessionId,
  sourcePath: `conversation://${stated.sessionId}/auto-capture%3Auser-source%3A10`, scope };
const newFact: CorrectionProofFact = { ...oldFact, id: 22, content: 'The controlled heading is NEW VALUE.',
  sourcePath: `conversation://${corrected.sessionId}/user-source:20` };
const queue = { candidateFactId: newFact.id, similarFactIds: [oldFact.id], recordedAt: '2026-10-16T12:01:01Z', attempts: 0 };
function input() {
  return { statedSource: structuredClone(stated), correctionSource: structuredClone(corrected),
    originalFacts: [structuredClone(oldFact)], currentFacts: [structuredClone(oldFact), structuredClone(newFact)],
    pendingConflicts: [structuredClone(queue)], staleValue: 'OLD VALUE', correctedValue: 'NEW VALUE', nowMs };
}
const passes = (value: ReturnType<typeof input>) => correctionSupersessionChecks(value).every(check => check.pass);

test('correction proof accepts exact retirement and separately accepts the fresh exact pending relationship', () => {
  assert.equal(passes(input()), true);
  const retired = input();
  retired.currentFacts[0] = { ...retired.currentFacts[0]!, active: false, supersededByFactId: newFact.id };
  retired.pendingConflicts = [];
  assert.equal(passes(retired), true);
});

test('an unrelated conflict cannot cover the still-active corrected target', () => {
  for (const row of [{ ...queue, candidateFactId: 99 }, { ...queue, similarFactIds: [99] },
    { ...queue, candidateFactId: oldFact.id, similarFactIds: [newFact.id] }]) {
    const value = input(); value.pendingConflicts = [row];
    assert.equal(passes(value), false);
  }
});

test('stale, future, expired and exhausted pending relationships cannot receive credit', () => {
  for (const row of [{ ...queue, recordedAt: stated.occurredAt }, { ...queue, recordedAt: '2026-10-16T12:06:00Z' },
    { ...queue, recordedAt: 'not-a-date' }, { ...queue, attempts: 5 }, { ...queue, attempts: -1 },
    { ...queue, attempts: 0.5 }, { ...queue, similarFactIds: [oldFact.id, oldFact.id] }]) {
    const value = input(); value.pendingConflicts = [row];
    assert.equal(passes(value), false);
  }
  const expired = input(); expired.nowMs += 15 * 24 * 60 * 60_000;
  assert.equal(passes(expired), false);
});

test('candidate identity, accepted source, original scope and original observation must all match', () => {
  for (const change of ['source', 'source-seq', 'candidate-scope', 'old-scope', 'old-content', 'kind', 'missing-old', 'duplicate-current'] as const) {
    const value = input();
    if (change === 'source') value.currentFacts[1]!.sourceSessionId = 'another-conversation';
    if (change === 'source-seq') value.currentFacts[1]!.sourcePath = `conversation://${corrected.sessionId}/user-source:19`;
    if (change === 'candidate-scope') value.currentFacts[1]!.scope.projectId = 'another-project';
    if (change === 'old-scope') value.currentFacts[0]!.scope.agentKey = 'another-agent';
    if (change === 'old-content') value.currentFacts[0]!.content += ' Changed after observation.';
    if (change === 'kind') value.currentFacts[1]!.kind = 'user';
    if (change === 'missing-old') value.currentFacts.shift();
    if (change === 'duplicate-current') value.currentFacts.push({ ...newFact, id: 23 });
    assert.equal(passes(value), false, change);
  }
});

test('forgetting an original or superseding it by another fact is not the requested retirement', () => {
  for (const successor of [null, 99]) {
    const value = input(); value.currentFacts[0] = { ...oldFact, active: false, supersededByFactId: successor };
    assert.equal(passes(value), false);
  }
});

test('all original targets need coverage and later stale duplicates cannot disappear from grading', () => {
  const value = input(); const duplicate = { ...oldFact, id: 12 };
  value.originalFacts.push(duplicate); value.currentFacts.push(duplicate);
  assert.equal(passes(value), false);
  value.pendingConflicts[0]!.similarFactIds.push(duplicate.id);
  assert.equal(passes(value), true);
  value.currentFacts.push({ ...oldFact, id: 13 });
  assert.equal(passes(value), false);
});

test('missing sources and unavailable memory snapshots fail closed', () => {
  for (const patch of [{ statedSource: null }, { correctionSource: null }, { originalFacts: null }, { currentFacts: null },
    { correctionSource: { ...corrected, sourceUserSeq: stated.sourceUserSeq } },
    { correctionSource: { ...corrected, scope: { ...scope, projectId: 'foreign-project' } } }]) {
    assert.equal(correctionSupersessionChecks({ ...input(), ...patch }).every(check => check.pass), false);
  }
  const value = input();
  assert.equal(correctionSupersessionChecks({ ...value, pendingConflicts: { length: 1 } }).every(check => check.pass), false);
});

test('actual scenario reader binds accepted-source digests and rejects an unrelated stored queue pair', async () => {
  for (const mode of ['exact', 'unrelated', 'wrong-source-digest'] as const) {
    const home = mkdtempSync(path.join(os.tmpdir(), 'clem-proof-correction-source-'));
    mkdirSync(path.join(home, 'state'));
    const harness = new Database(path.join(home, 'state', 'harness.db'));
    const memory = new Database(path.join(home, 'state', 'memory.db'));
    harness.exec(`CREATE TABLE events(id TEXT,seq INTEGER PRIMARY KEY,session_id TEXT,created_at TEXT,data_json TEXT,type TEXT,role TEXT);
      CREATE TABLE source_session_contexts_v1(session_id TEXT,source_user_seq INTEGER,identity_json TEXT,identity_digest TEXT);`);
    memory.exec(`CREATE TABLE consolidated_facts(id INTEGER PRIMARY KEY,kind TEXT,content TEXT,active INTEGER,superseded_by_fact_id INTEGER,source_session_id TEXT,source_path TEXT);
      CREATE TABLE memory_scopes(target_kind TEXT,target_id TEXT,scope_project_id TEXT,scope_agent_key TEXT);`);
    let calls = 0;
    const occurred = Date.now() - 1_000;
    const daemon = { home, acceptedChat: async (text: string, sessionId: string) => {
      const seq = ++calls;
      const at = new Date(occurred + seq * 100).toISOString();
      const identity = JSON.stringify({ version: 1, sessionId, sourceUserSeq: seq, memoryScope: { projectId: null, agentKey: null } });
      harness.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(`accepted-${seq}`, seq, sessionId, at, JSON.stringify({ text }), 'user_input_received', 'user');
      harness.prepare('INSERT INTO source_session_contexts_v1 VALUES(?,?,?,?)').run(sessionId, seq, identity,
        mode === 'wrong-source-digest' ? '0'.repeat(64) : createHash('sha256').update(identity).digest('hex'));
      memory.prepare('INSERT INTO consolidated_facts VALUES(?,?,?,?,?,?,?)').run(seq === 1 ? 11 : 22, 'project',
        `The deploy freeze codeword is ${seq === 1 ? 'Quillon-3317' : 'Verdanth-8846'}.`, 1, null, sessionId,
        `conversation://${encodeURIComponent(sessionId)}/${encodeURIComponent(`auto-capture:user-source:${seq}`)}`);
      if (seq === 2) writeFileSync(path.join(home, 'state', 'pending-memory-conflicts.json'), JSON.stringify([
        { candidateFactId: 22, similarFactIds: [mode === 'unrelated' ? 99 : 11], recordedAt: at, attempts: 0 },
      ]));
      return { text: 'Controlled acknowledgement.', sessionId, sourceUserSeq: seq, wallMs: 1, httpStatus: 200 };
    } } as unknown as DaemonHandle;
    try {
      const outcome = await correctionSupersedesStore.run(daemon);
      assert.equal(calls, 2);
      assert.equal(outcome.checks.every(check => check.pass), mode === 'exact', mode);
      assert.deepEqual(outcome.latency.map(sample => sample.wallMs), [1, 1]);
    } finally { harness.close(); memory.close(); rmSync(home, { recursive: true, force: true }); }
  }
});

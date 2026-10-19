import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-task-memory-status-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
const log = await import('../runtime/harness/eventlog.js');
const memory = await import('../memory/db.js');
const capture = await import('../memory/auto-capture.js');
const queue = await import('../memory/durable-consolidation.js');
const destinations = await import('../memory/memory-destination.js');
const context = await import('../runtime/harness/source-session-context.js');
const facts = await import('../memory/facts.js');
const scopes = await import('../memory/memory-scope.js');
const temporal = await import('../memory/temporal-memory.js');
const { readTaskMemoryStatus } = await import('./task-memory-status-read.js');
const { readMemoryConsolidationStatusEvidence } = await import('../runtime/harness/durable-memory-intake-receipt.js');
after(() => { log.closeEventLog(); memory.closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });
let serial = 0;
function fixture(message = 'Remember this: the controlled memory marker is BRONZE FINCH.', sessionId = `status-fixture-${++serial}`, withHint = true) {
  if (!log.getSession(sessionId)) log.createSession({ id: sessionId, kind: 'chat' });
  const source = log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: message } });
  const identity = { sessionId, sourceUserSeq: source.seq };
  context.captureFreshSourceSessionContext(identity);
  const sourceProvenance = { authority: 'accepted_user_input' as const, sessionId, eventId: source.id, seq: source.seq,
    role: source.role, type: source.type, data: source.data };
  const input = { message, sessionId, sourceEventId: `user-source:${source.seq}`, occurredAt: source.createdAt, sourceProvenance };
  const candidates = capture.selectAutoMemoryCandidates(message);
  const queued = queue.enqueueAutoCaptureCandidates({ ...input, candidates, origins: capture.automaticMemoryOriginsForCapture(input, candidates) });
  if (withHint) log.appendEvent({ sessionId, turn: 1, role: 'system', type: 'conversation_completed',
    data: { ...identity, blockedReason: 'memory_consolidation_pending', reply: 'CONTROLLED_ORIGINAL_REPLY', delivered: false } });
  return { ...identity, queued };
}
function row(id: number) {
  return memory.openMemoryDb().prepare('SELECT * FROM memory_reflection_candidates WHERE id = ?').get(id) as {
    id: number; destination_json: string; episode_id: string; source_uri: string; kind: import('../memory/db.js').ConsolidatedFactKind };
}
function decide(id: number, mode: 'saved' | 'refused' | 'needs_choice' | 'expired') {
  const db = memory.openMemoryDb(), original = row(id);
  const before = destinations.parseAutomaticMemoryEnvelope(original.destination_json);
  if (mode === 'expired') {
    db.prepare("UPDATE memory_reflection_candidates SET status = 'expired', reason = 'retry_exhausted' WHERE id = ?").run(id);
    return null;
  }
  const envelope = destinations.withAutomaticMemoryDecision(before, { durability: mode === 'saved' ? 'standing' : mode === 'refused' ? 'task' : 'unresolved',
    claim: before.origin.claim, destination: mode === 'needs_choice' ? 'unresolved' : 'kind_default', destinationSpans: [], reason: 'controlled status test' });
  if (mode !== 'saved') {
    db.prepare("UPDATE memory_reflection_candidates SET destination_json = ?, status = 'rejected', reason = ? WHERE id = ?")
      .run(JSON.stringify(envelope), mode === 'refused' ? 'destination_task:controlled' : 'destination_unresolved:controlled', id);
    return null;
  }
  const destination = destinations.resolveAutomaticMemoryDestination(envelope);
  assert.equal(destination.status, 'resolved');
  if (destination.status !== 'resolved') throw new Error('fixture destination unresolved');
  const fact = scopes.withMemorySettledFor(destination.scope, () => facts.rememberFact({ kind: original.kind, content: destination.claimText }));
  scopes.stampMemoryScope('fact', fact.id, destination.scope);
  temporal.linkFactEvidence({ factId: fact.id, episodeId: original.episode_id, sourceUri: original.source_uri, excerpt: destination.claimText });
  db.prepare("UPDATE memory_reflection_candidates SET destination_json = ?, status = 'promoted', resulting_fact_id = ? WHERE id = ?")
    .run(JSON.stringify(envelope), fact.id, id);
  return fact.id;
}
test('pending becomes saved after canonical promotion, survives reopen, and never changes the original terminal', () => {
  const item = fixture();
  const original = log.openEventLog().prepare("SELECT data_json FROM events WHERE session_id = ? AND type = 'conversation_completed'").get(item.sessionId);
  assert.equal(readTaskMemoryStatus(item)?.memory?.state, 'pending');
  assert.equal(readTaskMemoryStatus(item)?.memory?.pollAfterMs, 2000);
  const factId = decide(item.queued.candidateIds[0]!, 'saved');
  log.closeEventLog(); memory.closeMemoryDb();
  const status = readTaskMemoryStatus(item)!;
  assert.equal(status.memory?.state, 'saved');
  assert.equal(status.memory?.candidates[0]?.factId, factId);
  assert.equal(status.memory?.pollAfterMs, null);
  assert.deepEqual(log.openEventLog().prepare("SELECT data_json FROM events WHERE session_id = ? AND type = 'conversation_completed'").get(item.sessionId), original);
  assert.doesNotMatch(JSON.stringify(status), /BRONZE FINCH|CONTROLLED_ORIGINAL_REPLY|controlled status test/);
});
test('rejected, unresolved destination and exhausted review are distinct terminal memory results', () => {
  for (const [mode, state, next] of [['refused', 'refused', 'review_memory'], ['needs_choice', 'needs_choice', 'clarify_destination'],
    ['expired', 'unavailable', 'check_again']] as const) {
    const item = fixture(); decide(item.queued.candidateIds[0]!, mode);
    const result = readTaskMemoryStatus(item)!.memory!;
    assert.equal(result.state, state); assert.equal(result.nextStep, next); assert.equal(result.pollAfterMs, null);
  }
});
test('mixed candidates never become an all-saved badge and pending candidates keep only their exact status', () => {
  const item = fixture('Remember this: Cedar is Cedar-57. Remember this: Cedar is Cedar-57.');
  assert.equal(item.queued.candidateIds.length, 2);
  decide(item.queued.candidateIds[0]!, 'saved');
  const mixed = readTaskMemoryStatus(item)!.memory!;
  assert.equal(mixed.state, 'mixed'); assert.deepEqual(mixed.counts, { pending: 1, saved: 1, refused: 0, needsChoice: 0, unavailable: 0 });
  decide(item.queued.candidateIds[1]!, 'refused');
  assert.equal(readTaskMemoryStatus(item)!.memory?.state, 'mixed');
  assert.equal(readTaskMemoryStatus(item)!.memory?.pollAfterMs, null);
});
test('later requests, foreign sessions and ordinary source text cannot borrow a prior memory hint', () => {
  const first = fixture();
  const next = fixture('Please summarize the controlled notes.', first.sessionId, false);
  assert.equal(readTaskMemoryStatus(next)?.memory, null);
  assert.equal(readTaskMemoryStatus({ sessionId: 'foreign-session', sourceUserSeq: first.sourceUserSeq }), null);
  assert.equal(readTaskMemoryStatus({ ...first, sourceUserSeq: next.sourceUserSeq + 100 }), null);
  assert.equal(readTaskMemoryStatus(first)?.memory?.state, 'pending');
});
test('inactive or superseded original proof cannot be redeemed by a successor', () => {
  for (const superseded of [false, true]) {
    const item = fixture(), factId = decide(item.queued.candidateIds[0]!, 'saved')!;
    const successor = superseded ? facts.rememberFact({ kind: 'user', content: 'Unrelated current successor fixture.' }).id : null;
    memory.openMemoryDb().prepare('UPDATE consolidated_facts SET active = 0, superseded_by_fact_id = ? WHERE id = ?').run(successor, factId);
    const result = readTaskMemoryStatus(item)!.memory!;
    assert.equal(result.state, 'unavailable'); assert.equal(result.candidates[0]?.reason, superseded ? 'superseded' : 'inactive');
    assert.equal(result.candidates[0]?.factId, factId); assert.equal(result.nextStep, 'review_memory');
  }
});
test('tampered origins, foreign canonical facts and missing links remain unavailable', () => {
  for (const defect of ['origin', 'fact', 'link'] as const) {
    const item = fixture(), candidateId = item.queued.candidateIds[0]!, factId = decide(candidateId, 'saved')!;
    const db = memory.openMemoryDb();
    if (defect === 'origin') db.prepare('UPDATE memory_reflection_candidates SET text = ? WHERE id = ?').run('TAMPERED_NEVER_EXPOSE', candidateId);
    if (defect === 'fact') {
      const other = facts.rememberFact({ kind: 'user', content: 'FOREIGN_NEVER_EXPOSE' });
      db.prepare('UPDATE memory_reflection_candidates SET resulting_fact_id = ? WHERE id = ?').run(other.id, candidateId);
    }
    if (defect === 'link') db.prepare('DELETE FROM fact_evidence WHERE fact_id = ?').run(factId);
    const result = readTaskMemoryStatus(item)!;
    assert.equal(result.memory?.state, 'unavailable'); assert.equal(result.memory?.pollAfterMs, null);
    assert.doesNotMatch(JSON.stringify(result), /TAMPERED|FOREIGN/);
  }
});
test('missing evidence and corrupt or unreadable storage stay distinct from no tracked memory', () => {
  const item = fixture();
  memory.openMemoryDb().prepare('UPDATE memory_reflection_candidates SET destination_json = ? WHERE id = ?').run('{broken', item.queued.candidateIds[0]);
  assert.equal(readMemoryConsolidationStatusEvidence(item).status, 'storage_error');
  assert.equal(readTaskMemoryStatus(item)?.memory?.state, 'unavailable');
  const db = memory.openMemoryDb();
  db.exec('SAVEPOINT missing_scope');
  try {
    db.exec('DROP TABLE memory_reflection_candidates');
    assert.equal(readMemoryConsolidationStatusEvidence(item).status, 'storage_error');
    assert.equal(readTaskMemoryStatus(item)?.memory?.state, 'unavailable');
  } finally { db.exec('ROLLBACK TO missing_scope; RELEASE missing_scope'); }
});
test('oversized exact-source evidence cannot be silently capped into success', () => {
  const item = fixture();
  const original = row(item.queued.candidateIds[0]!);
  const db = memory.openMemoryDb();
  for (let i = 0; i < 21; i++) db.prepare(`INSERT INTO memory_reflection_candidates
    (session_id,call_id,candidate_hash,kind,text,importance,status,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(item.sessionId, `auto-capture:user-source:${item.sourceUserSeq}`, `extra-${i}`, original.kind, 'fixture', 5, 'pending', new Date().toISOString());
  assert.equal(readMemoryConsolidationStatusEvidence(item).status, 'bounded');
  const result = readTaskMemoryStatus(item)!.memory!;
  assert.equal(result.state, 'unavailable'); assert.equal(result.pollAfterMs, null); assert.equal(result.candidates.length, 0);
});
test('status reads change no rows, events, receipts, facts or pending jobs', () => {
  const item = fixture();
  const snapshot = () => ({
    events: log.openEventLog().prepare('SELECT * FROM events ORDER BY seq').all(),
    receipts: log.openEventLog().prepare('SELECT * FROM durable_memory_intake_receipts ORDER BY receipt_id').all(),
    candidates: memory.openMemoryDb().prepare('SELECT * FROM memory_reflection_candidates ORDER BY id').all(),
    facts: memory.openMemoryDb().prepare('SELECT * FROM consolidated_facts ORDER BY id').all(),
  });
  const before = snapshot();
  for (let i = 0; i < 3; i++) assert.equal(readTaskMemoryStatus(item)?.memory?.state, 'pending');
  assert.deepEqual(snapshot(), before);
});
test('polling candidate lookup uses the retained exact-source unique index', () => {
  const item = fixture();
  const plan = memory.openMemoryDb().prepare(`EXPLAIN QUERY PLAN SELECT resulting_fact_id,episode_id,source_uri
    FROM memory_reflection_candidates WHERE session_id = ? AND call_id = ? LIMIT 21`)
    .all(item.sessionId, `auto-capture:user-source:${item.sourceUserSeq}`) as Array<{ detail: string }>;
  assert.ok(plan.some(row => /SEARCH memory_reflection_candidates USING INDEX sqlite_autoindex_memory_reflection_candidates/.test(row.detail)));
  assert.ok(plan.every(row => !/SCAN memory_reflection_candidates/.test(row.detail)));
});
test('the public lightweight route observes promotion without changing terminal history or replaying work', async () => {
  const { default: express } = await import('express');
  const { registerConsoleTaskHandlingRoutes } = await import('./console-task-handling-routes.js');
  const item = fixture();
  const app = express(); registerConsoleTaskHandlingRoutes(app, { isAuthorized: () => true });
  const server = await new Promise<import('node:http').Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const address = server.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/console/sessions/${item.sessionId}/memory-status?sourceUserSeq=${item.sourceUserSeq}`;
  const original = log.openEventLog().prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq').all(item.sessionId);
  try {
    const pending = await fetch(url); assert.equal(pending.status, 200); assert.equal(pending.headers.get('cache-control'), 'no-store');
    assert.equal((await pending.json() as import('../types/task-handling.js').TaskMemoryStatus).memory?.state, 'pending');
    decide(item.queued.candidateIds[0]!, 'saved');
    const response = await fetch(url);
    assert.equal((await response.json() as import('../types/task-handling.js').TaskMemoryStatus).memory?.state, 'saved');
    assert.deepEqual(log.openEventLog().prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq').all(item.sessionId), original);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/tool-search-exact-slug-memory.test.ts
 * Memory bookkeeping on the exact-slug discovery path is never load-bearing.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-exact-slug-memory-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-exact-slug-memory\n');
const store = await import('../memory/tool-choice-store.js');
const sources = await import('./tool-search-provider-sources.js');
const events = await import('../runtime/harness/eventlog.js');
const contexts = await import('../runtime/harness/source-session-context.js');

after(() => { events.closeEventLog(); rmSync(TEST_HOME, { recursive: true, force: true }); });

test('a remembered record the store now rejects does not abort exact-slug reconciliation for the operation', () => {
  const slug = 'FIXTURE_UPDATE_EVENT_IN_CALENDAR';
  const fingerprint = 'f'.repeat(64);
  // The rejection is real: re-saving a memo whose intent exceeds the slug rule
  // throws out of the store (live 2026-09-15: 82 chars).
  const longIntent = 'update the existing calendar event body for the adam invite with a brief clem description now';
  assert.ok(longIntent.length > 80);
  assert.throws(
    () => sources.reconcileOneExactSlugRecord({
      intent: longIntent,
      description: 'legacy memo',
      choice: { kind: 'composio', identifier: slug, testEvidence: 'fixture' },
    } as never, fingerprint),
    /intents are short canonical slugs/,
  );
  // The source-level reconcile never lets that escape, and still stamps the
  // memos it can re-save.
  store.rememberToolChoice({ intent: 'fixture.calendar.update', description: 'healthy memo', choice: { kind: 'composio', identifier: slug, testEvidence: 'fixture' } });
  assert.doesNotThrow(() => sources.reconcileExactSlugMemory(slug, fingerprint));
  const stamped = store.listToolChoices().filter((record) => record.choice?.identifier === slug && record.choice?.schemaFingerprint === fingerprint);
  assert.ok(stamped.length >= 1, 'a re-savable memo is stamped with the live contract');
});


const EXCLUDED_LEARNING = { version: 1, mode: 'exclude', reason: 'controlled_test' } as const;
let memorySourceSerial = 0;
function memorySource(policy?: unknown) {
  const session = events.createSession({ id: `slug-learning-source-${++memorySourceSerial}`, kind: 'chat' });
  const row = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Inspect the controlled exact operation.', ...(policy === undefined ? {} : { learningPolicy: policy }) } });
  return { sessionId: session.id, sourceUserSeq: row.seq };
}
function procedure(id: string) { return store.listToolProcedures().find(row => row.procedureId === id); }

test('exact-slug excluded/unavailable sources do not enrich memory or record impressions, normal sibling still can', () => {
  const slug = 'FIXTURE_POLICY_OPEN_CALENDAR';
  const memo = store.rememberToolChoice({ intent: 'fixture.policy.calendar', choice: { kind: 'composio', identifier: slug } });
  assert.ok(memo.procedureId);
  const before = store.peekToolChoice(memo.intent);
  const beforeProcedure = procedure(memo.procedureId);
  assert.ok(beforeProcedure);
  const excluded = memorySource(EXCLUDED_LEARNING);
  for (const identity of [excluded, { sessionId: excluded.sessionId }, { ...excluded, sourceUserSeq: 0 },
    { ...excluded, sourceUserSeq: excluded.sourceUserSeq + 100000 },
    { sessionId: 'foreign-slug-session', sourceUserSeq: excluded.sourceUserSeq }]) {
    sources.reconcileExactSlugMemory(slug, 'a'.repeat(64), identity);
    assert.deepEqual(store.peekToolChoice(memo.intent), before);
    assert.deepEqual(procedure(memo.procedureId), beforeProcedure);
  }
  const normalRow = events.appendEvent({ sessionId: excluded.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Inspect the normal sibling.' } });
  const normal = { sessionId: excluded.sessionId, sourceUserSeq: normalRow.seq };
  contexts.withAcceptedSourceSessionContext(normal, () => {
    sources.reconcileExactSlugMemory(slug, 'a'.repeat(64), excluded);
    assert.deepEqual(procedure(memo.procedureId!), beforeProcedure, 'explicit exclusion cannot borrow a current normal sibling');
    sources.reconcileExactSlugMemory(slug, 'a'.repeat(64), { sessionId: normal.sessionId });
  }, { newlyAccepted: true });
  const stamped = store.peekToolChoice(memo.intent);
  assert.equal(stamped?.choice?.schemaFingerprint, 'a'.repeat(64));
  assert.equal(procedure(memo.procedureId)?.impressionCount, beforeProcedure.impressionCount + 1);
});

test('exact-slug excluded discovery still invalidates a drifted learned contract without enrichment', () => {
  const slug = 'FIXTURE_DRIFT_OPEN_CALENDAR';
  const memo = store.rememberToolChoice({ intent: 'fixture.policy.drift', choice: { kind: 'composio', identifier: slug, schemaFingerprint: 'b'.repeat(64) } });
  assert.ok(memo.procedureId);
  const beforeImpressions = procedure(memo.procedureId)?.impressionCount;
  sources.reconcileExactSlugMemory(slug, 'c'.repeat(64), memorySource(EXCLUDED_LEARNING));
  assert.equal(store.peekToolChoice(memo.intent)?.choice, null, 'conservative invalidation survives exclusion');
  assert.equal(procedure(memo.procedureId)?.impressionCount, beforeImpressions);
  assert.equal(store.peekToolChoice(memo.intent)?.choice?.schemaFingerprint, undefined);
});

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
process.env.COMPOSIO_BACKEND = 'sdk';
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


test('built model-mounted discovery without identity cannot learn even inside an excluded source; exact normal source can', async () => {
  const composio = await import('../integrations/composio/client.js');
  const schemaCache = await import('./composio-schema-cache.js');
  const slug = 'OUTLOOK_GET_CALENDAR_VIEW';
  const schema = { type: 'object', properties: { calendarId: { type: 'string' } }, required: ['calendarId'] };
  const memo = store.rememberToolChoice({ intent: 'fixture.mounted.calendar', choice: { kind: 'composio', identifier: slug } });
  assert.ok(memo.procedureId);
  const original = store.peekToolChoice(memo.intent);
  const originalProcedure = procedure(memo.procedureId);
  assert.ok(originalProcedure);
  let connections = 0, exactLookups = 0, executions = 0;
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('controlled-missing-identity-key');
  composio.__test__.setConnectedAccountsLoader(async () => {
    connections += 1;
    return [{ id: 'ca_controlled_calendar', status: 'ACTIVE', user_id: 'controlled-owner', toolkit: { slug: 'outlook' } }];
  });
  composio.__test__.setComposioClient({ tools: {
    async getRawComposioTools() { exactLookups += 1; throw new Error('current lease must not refetch the provider'); },
    async execute() { executions += 1; throw new Error('discovery must not execute'); },
  } } as never);
  try {
    schemaCache.rememberToolSchema(slug, schema, Date.now(), 'controlled-calendar-v1', null);
    const liveFingerprint = schemaCache.liveComposioSchemaFingerprint(slug);
    assert.ok(liveFingerprint);
    const scope = { reason: 'controlled mounted-source identity', authority: 'catalog', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 } as never;
    const excluded = memorySource(EXCLUDED_LEARNING);
    const withoutIdentity = sources.buildAuthorizedToolSearchCandidateSources(scope, undefined, 'call_tool')
      .find(source => source.kind === 'authorized_composio');
    assert.ok(withoutIdentity);
    const rows = await contexts.withAcceptedSourceSessionContext(excluded,
      () => withoutIdentity.search({ query: slug, limit: 4 }), { newlyAccepted: true });
    assert.deepEqual(rows.map(row => row.name), [slug], 'missing learning identity does not hide a live operation');
    assert.deepEqual(rows[0]?.schema, schema);
    assert.deepEqual(store.peekToolChoice(memo.intent), original);
    assert.deepEqual(procedure(memo.procedureId), originalProcedure, 'mounted source must not fall through to standalone learning');

    const exactExcluded = sources.buildAuthorizedToolSearchCandidateSources(scope, excluded, 'call_tool')
      .find(source => source.kind === 'authorized_composio');
    assert.ok(exactExcluded);
    assert.deepEqual((await exactExcluded.search({ query: slug, limit: 4 })).map(row => row.name), [slug]);
    assert.deepEqual(store.peekToolChoice(memo.intent), original);
    assert.deepEqual(procedure(memo.procedureId), originalProcedure);

    const normal = memorySource();
    const exactNormal = sources.buildAuthorizedToolSearchCandidateSources(scope, normal, 'call_tool')
      .find(source => source.kind === 'authorized_composio');
    assert.ok(exactNormal);
    assert.deepEqual((await exactNormal.search({ query: slug, limit: 4 })).map(row => row.name), [slug]);
    assert.equal(store.peekToolChoice(memo.intent)?.choice?.schemaFingerprint, liveFingerprint);
    assert.equal(procedure(memo.procedureId)?.impressionCount, originalProcedure.impressionCount + 1);

    const drifted = store.rememberToolChoice({ intent: 'fixture.mounted.drift',
      choice: { kind: 'composio', identifier: slug, schemaFingerprint: '0'.repeat(64) } });
    assert.ok(drifted.procedureId);
    const driftedImpressions = procedure(drifted.procedureId)?.impressionCount;
    assert.deepEqual((await withoutIdentity.search({ query: slug, limit: 4 })).map(row => row.name), [slug]);
    assert.equal(store.peekToolChoice(drifted.intent)?.choice, null, 'missing identity still permits conservative schema-drift invalidation');
    assert.equal(procedure(drifted.procedureId)?.impressionCount, driftedImpressions);
    assert.ok(connections > 0, 'real provider source consumed the controlled current connection loader');
    assert.equal(exactLookups, 0);
    assert.equal(executions, 0);
  } finally {
    schemaCache.resetToolSchemaCache();
    composio.__test__.setConnectedAccountsLoader(null);
    composio.__test__.setComposioApiKeyOverride(null);
    composio.resetComposioClient();
  }
});

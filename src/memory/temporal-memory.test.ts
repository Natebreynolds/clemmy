import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-temporal-memory';
process.env.CLEMENTINE_HOME = TEST_HOME;
delete process.env.OPENAI_API_KEY;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { getFact, rememberFact, supersedeFact } = await import('./facts.js');
const { getFactEvidence } = await import('./temporal-memory.js');
const { recallMemory } = await import('./recall-memory.js');
const {
  createSession,
  getToolOutput,
  openEventLog,
  resetEventLog,
  writeToolOutput,
} = await import('../runtime/harness/eventlog.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => {
  resetMemoryDb();
  resetEventLog();
});

test('every new direct fact receives durable, exact evidence', () => {
  const fact = rememberFact({ kind: 'user', content: 'My preferred timezone is America/Los_Angeles.' });
  const evidence = getFactEvidence(fact.id);

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].excerpt, fact.content);
  assert.equal(evidence[0].status, 'available');
});

test('derived fact evidence survives raw tool-output expiry', () => {
  const session = createSession({ kind: 'chat' });
  writeToolOutput({
    sessionId: session.id,
    callId: 'call-evidence',
    tool: 'crm_lookup',
    output: 'CRM record: Acme renewal closes on September 30. Owner: Dana.',
  });
  const fact = rememberFact({
    kind: 'project',
    content: 'The Acme renewal closes on September 30.',
    derivedFrom: { sessionId: session.id, callId: 'call-evidence', tool: 'crm_lookup' },
    sourceApp: 'CRM',
  });
  const beforeExpiry = getFactEvidence(fact.id);
  assert.equal(beforeExpiry.length, 1);
  assert.match(beforeExpiry[0].excerpt, /September 30/);

  openEventLog().prepare('DELETE FROM tool_outputs WHERE session_id = ? AND call_id = ?')
    .run(session.id, 'call-evidence');
  assert.equal(getToolOutput(session.id, 'call-evidence'), null);

  const afterExpiry = getFactEvidence(fact.id);
  assert.deepEqual(afterExpiry, beforeExpiry, 'bounded evidence is independent of raw-output retention');
  const episode = openMemoryDb().prepare('SELECT status FROM memory_episodes WHERE id = ?')
    .get(afterExpiry[0].episodeId) as { status: string };
  assert.equal(episode.status, 'available');
});

test('supersession returns the current claim now and the old claim historically', async () => {
  const old = rememberFact({
    kind: 'project',
    content: 'The quarterly revenue target is one million dollars.',
    occurredAt: '2025-01-01T00:00:00.000Z',
  });
  const replacement = supersedeFact(old.id, {
    content: 'The quarterly revenue target is two million dollars.',
    occurredAt: '2025-02-01T00:00:00.000Z',
  });
  assert.ok(replacement);
  assert.equal(getFact(old.id)?.validTo, '2025-02-01T00:00:00.000Z');
  assert.equal(getFact(old.id)?.supersededByFactId, replacement?.id);

  const historical = await recallMemory('quarterly revenue target', {
    stores: ['fact'],
    asOf: '2025-01-15T00:00:00.000Z',
    graphDepth: 0,
  });
  assert.equal(historical.hits[0]?.ref.id, String(old.id));
  assert.match(historical.hits[0]?.text ?? '', /one million/);

  const current = await recallMemory('quarterly revenue target', {
    stores: ['fact'],
    graphDepth: 0,
  });
  assert.equal(current.hits[0]?.ref.id, String(replacement?.id));
  assert.match(current.hits[0]?.text ?? '', /two million/);
});

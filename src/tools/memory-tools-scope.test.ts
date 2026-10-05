/** Run via scripts/run-tests-isolated.mjs, serial. No provider calls.
 * Exercises registration, consolidation and populated-store reconciliation.
 * Real frozen-context recovery is covered beside source-session-context.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { MemoryScope } from '../memory/memory-scope.js';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-scope-proposed-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const { registerMemoryTools, reconcileAutoCapturedRememberFact } = await import('./memory-tools.js');
const scope = await import('../memory/memory-scope.js');
const db = await import('../memory/db.js');
const facts = await import('../memory/facts.js');
const temporal = await import('../memory/temporal-memory.js');
const candidates = await import('../memory/reflection-candidates.js');
const events = await import('../runtime/harness/eventlog.js');
const { harnessRunContextStorage, ToolCallsCounter } = await import('../runtime/harness/brackets.js');
const { localNonWriteStatus, localNonWriteClassification } = await import('./shared.js');

const A = { projectId: 'scope-fixture-project-a', agentKey: 'scope-fixture-agent-a@creation-a' };
const B = { projectId: 'scope-fixture-project-b', agentKey: 'scope-fixture-agent-b@creation-b' };
const scopes = new Map<string, MemoryScope>();
const originalFetch = globalThis.fetch;
let fetchAttempts = 0;
globalThis.fetch = (async () => {
  fetchAttempts += 1;
  throw new Error('No provider/network calls are permitted in this disposable test.');
}) as typeof fetch;

beforeEach(() => {
  db.resetMemoryDb(); events.resetEventLog(); scopes.clear(); fetchAttempts = 0;
  for (const [id, binding] of [['scope-fixture-a', A], ['scope-fixture-b', B],
    ['scope-fixture-base', scope.EVERYWHERE]] as const) {
    events.createSession({ id, kind: 'chat' }); scopes.set(id, { ...binding });
  }
  scope.installMemoryScopeBinding({
    ambientSessionId: () => harnessRunContextStorage.getStore()?.sessionId ?? null,
    scopeOfSession: id => scopes.has(id) ? { ...scopes.get(id)! } : null,
  });
});
after(() => {
  globalThis.fetch = originalFetch;
  scope.installMemoryScopeBinding(null); db.closeMemoryDb(); events.closeEventLog();
  rmSync(fixtureHome, { recursive: true, force: true });
});

function registeredTool(wanted: string) {
  let handler: ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
  registerMemoryTools({ tool(name: string, _description: string, shape: z.ZodRawShape,
    run: (input: unknown) => Promise<unknown>) {
    if (name === wanted) handler = input => run(z.object(shape).parse(input));
  } } as never);
  assert.ok(handler); return handler;
}
function registeredRemember() { return registeredTool('memory_remember'); }
function active<T>(sessionId: string, run: () => T): T {
  return harnessRunContextStorage.run({ sessionId, counter: new ToolCallsCounter(4) }, run);
}
function fact() {
  const rows = db.openMemoryDb().prepare('SELECT id, content, active, source_session_id FROM consolidated_facts')
    .all() as Array<{ id: number; content: string; active: number; source_session_id: string | null }>;
  assert.equal(rows.length, 1); assert.equal(rows[0].active, 1);
  assert.equal(fetchAttempts, 0); return rows[0];
}
function assertNoEffects() {
  const memory = db.openMemoryDb();
  assert.equal((memory.prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get() as { n: number }).n, 0);
  assert.equal((memory.prepare('SELECT COUNT(*) AS n FROM memory_episodes').get() as { n: number }).n, 0);
  assert.equal(fetchAttempts, 0);
}
const content = 'The standing report heading is INDIGO MEADOW and the footnote convention is CHARTER LAMP.';

test('registered fact read exposes full actual project-only scope under a specialist', async () => {
  const saved = facts.rememberFact({ kind: 'project', content, scope: { projectId: A.projectId, agentKey: null } });
  const result = await active('scope-fixture-a', () => registeredTool('memory_read')({ target: `fact:${saved.id}` })) as
    { content: Array<{ text: string }> };
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.protocol, 'fact_observation_v1');
  assert.equal(parsed.readCallId, null, 'standalone registration cannot mint a nominal settled read');
  assert.equal(parsed.observation.content, content);
  assert.equal(parsed.observation.active, true);
  assert.deepEqual(parsed.observation.scope, { projectId: A.projectId, agentKey: null });
  assert.match(parsed.observation.digest, /^[a-f0-9]{64}$/);
  assert.equal(fetchAttempts, 0);
});

test('legacy read cannot convert an absent scope store into an authoritative global observation', async () => {
  const saved = facts.rememberFact({ kind: 'project', content, scope: null });
  db.openMemoryDb().exec('DROP TABLE memory_scopes');
  const result = await active('scope-fixture-a', () => registeredTool('memory_read')({ target: `fact:${saved.id}` })) as
    { content: Array<{ text: string }> };
  assert.ok(result.content[0].text.includes(content));
  assert.match(result.content[0].text, /this read cannot authorize a correction/);
  assert.doesNotMatch(result.content[0].text, /"protocol":"fact_observation_v1"/);
  assert.equal(fetchAttempts, 0);
});

test('registered correction without exact accepted-call authority never falls through to generic save', async () => {
  const saved = facts.rememberFact({ kind: 'project', content, scope: { projectId: A.projectId, agentKey: null } });
  const before = db.openMemoryDb().prepare('SELECT * FROM consolidated_facts').all();
  const result = await active('scope-fixture-a', () => registeredRemember()({ kind: 'project',
    content: content.replace('INDIGO MEADOW', 'BLUE HARBOR'), correct: {
      readCallId: 'invented-call', expectedDigest: 'a'.repeat(64),
      edits: [{ before: 'INDIGO MEADOW', after: 'BLUE HARBOR' }],
    } })) as { isError?: boolean };
  assert.equal(result.isError, true);
  assert.deepEqual(db.openMemoryDb().prepare('SELECT * FROM consolidated_facts').all(), before);
  assert.equal(facts.getFact(saved.id)?.active, true);
  assert.equal(fetchAttempts, 0);
});

for (const kind of ['user', 'constraint', 'project', 'feedback', 'reference'] as const) {
  test(`explicit here is honored by the registration for ${kind}`, async () => {
    const result = await active('scope-fixture-a', () => registeredRemember()({ kind, content, keepFor: 'here' }));
    assert.equal(localNonWriteStatus(result), null);
    const saved = fact(); assert.equal(saved.content, content);
    assert.equal(saved.source_session_id, 'scope-fixture-a');
    assert.deepEqual(scope.memoryScopeOf('fact', saved.id), A);
  });
}

test('a model-supplied foreign session is refused before any memory effect', async () => {
  const result = await active('scope-fixture-a', () => registeredRemember()({
    kind: 'project', content, sessionId: 'scope-fixture-b', keepFor: 'here',
  }));
  assert.equal(localNonWriteStatus(result), 'memory_session_mismatch');
  assert.deepEqual(localNonWriteClassification(result), { kind: 'invalid_arguments' });
  assertNoEffects();
});

test('same-session argument remains supported', async () => {
  await active('scope-fixture-a', () => registeredRemember()({ kind: 'project', content,
    sessionId: 'scope-fixture-a', keepFor: 'here' }));
  const saved = fact(); assert.deepEqual(scope.memoryScopeOf('fact', saved.id), A);
});

test('unbound standalone registration still accepts a known explicit scoped session', async () => {
  await registeredRemember()({ kind: 'user', content, sessionId: 'scope-fixture-b', keepFor: 'here' });
  const saved = fact(); assert.equal(saved.source_session_id, 'scope-fixture-b');
  assert.deepEqual(scope.memoryScopeOf('fact', saved.id), B);
});

test('unavailable bound here scope refuses instead of writing everywhere', async () => {
  const result = await active('scope-fixture-unknown', () => registeredRemember()({ kind: 'project', content, keepFor: 'here' }));
  assert.equal(localNonWriteStatus(result), 'memory_scope_unavailable');
  assert.deepEqual(localNonWriteClassification(result), { kind: 'input_required' });
  assertNoEffects();
});

test('unbound explicit here without a known session refuses without effects', async () => {
  const result = await registeredRemember()({ kind: 'project', content, keepFor: 'here' });
  assert.equal(localNonWriteStatus(result), 'memory_scope_unavailable'); assertNoEffects();
});

for (const kind of ['user', 'constraint', 'project'] as const) {
  test(`omitted keepFor keeps the existing ${kind} default`, async () => {
    await active('scope-fixture-a', () => registeredRemember()({ kind, content }));
    const saved = fact();
    assert.deepEqual(scope.memoryScopeOf('fact', saved.id), kind === 'project' ? A : null);
  });
}

test('explicit everywhere is unchanged from a scoped bound session', async () => {
  await active('scope-fixture-a', () => registeredRemember()({ kind: 'project', content, keepFor: 'everywhere' }));
  assert.equal(scope.memoryScopeOf('fact', fact().id), null);
});

test('unbound no-session omitted default remains supported', async () => {
  await registeredRemember()({ kind: 'project', content });
  assert.equal(scope.memoryScopeOf('fact', fact().id), null);
});

test('known base-Clem everywhere scope remains distinct from unavailable scope', async () => {
  await active('scope-fixture-base', () => registeredRemember()({ kind: 'project', content, keepFor: 'here' }));
  assert.equal(scope.memoryScopeOf('fact', fact().id), null);
});

function seedAutoCapture(keptFor: MemoryScope | null, text = content, kind: 'user' | 'constraint' = 'user') {
  const sessionId = 'scope-fixture-a';
  const sourceUri = `conversation://${sessionId}/auto-capture%3Aoriginal`;
  const saved = facts.rememberFact({ kind, content: text, scope: keptFor, sessionId, sourceUri });
  facts.setFactPinned(saved.id, true);
  const candidateId = candidates.recordReflectionCandidate({ sessionId, callId: 'auto-capture:original',
    kind, text, importance: 5, sourceType: 'auto_capture', sourceUri });
  candidates.resolveReflectionCandidateById({ id: candidateId, status: 'promoted',
    resultingFactId: saved.id, reason: 'controlled existing auto-capture' });
  return { factId: saved.id, candidateId };
}

function retainedRows(seed: { factId: number; candidateId: number }) {
  const memory = db.openMemoryDb();
  return {
    fact: memory.prepare('SELECT * FROM consolidated_facts WHERE id = ?').get(seed.factId),
    evidence: memory.prepare('SELECT * FROM fact_evidence WHERE fact_id = ? ORDER BY episode_id, ordinal').all(seed.factId),
    intake: memory.prepare('SELECT * FROM memory_reflection_candidates WHERE id = ?').get(seed.candidateId),
    policy: memory.prepare('SELECT * FROM memory_policies WHERE fact_id = ?').get(seed.factId),
    scope: scope.memoryScopeOf('fact', seed.factId),
  };
}

for (const [label, keptFor] of [
  ['everywhere', null],
  ['another project', B],
  ['another agent incarnation', { ...A, agentKey: 'scope-fixture-agent-a@previous-creation' }],
] as const) {
  test(`registered here save preserves an auto-capture kept for ${label}`, async () => {
    const seed = seedAutoCapture(keptFor);
    const before = retainedRows(seed);
    await active('scope-fixture-a', () => registeredRemember()({ kind: 'user', content, keepFor: 'here' }));
    assert.deepEqual(retainedRows(seed), before, 'scope mismatch must not transfer evidence, pin, intake or history');
    const saved = db.openMemoryDb().prepare('SELECT id, pinned FROM consolidated_facts WHERE id <> ? AND active = 1')
      .all(seed.factId) as Array<{ id: number; pinned: number }>;
    assert.equal(saved.length, 1);
    assert.deepEqual(scope.memoryScopeOf('fact', saved[0].id), A);
    assert.equal(saved[0].pinned, 0, 'the other scope cannot lend its pin');
    const originalEvidence = temporal.getFactEvidence(seed.factId).map(row => row.episodeId);
    assert.ok(originalEvidence.length > 0);
    assert.equal(temporal.getFactEvidence(saved[0].id).some(row => originalEvidence.includes(row.episodeId)), false);
    assert.equal(fetchAttempts, 0);
  });
}

test('a scoped copy does not remove the global standing constraint or its dispatch projection', async () => {
  const rule = 'Always send Outlook email from billing@example.com.';
  const seed = seedAutoCapture(null, rule, 'constraint');
  const before = retainedRows(seed);
  assert.ok(before.policy, 'the seeded rule must have a policy projection');
  await active('scope-fixture-a', () => registeredRemember()({ kind: 'constraint', content: rule, keepFor: 'here' }));
  assert.deepEqual(retainedRows(seed), before);
  const elsewhere = scope.withMemoryReadScope(B, () => facts.listConstraints());
  assert.ok(elsewhere.some(row => row.id === seed.factId));
  assert.equal(elsewhere.length, 1, 'the local copy is not visible in another project');
  assert.equal(fetchAttempts, 0);
});

test('an explicit global save does not retire or inherit an existing local auto-capture', async () => {
  const seed = seedAutoCapture(A);
  const before = retainedRows(seed);
  await active('scope-fixture-a', () => registeredRemember()({ kind: 'user', content, keepFor: 'everywhere' }));
  assert.deepEqual(retainedRows(seed), before, 'the local record, evidence, pin and intake remain local');
  const saved = db.openMemoryDb().prepare('SELECT id, pinned FROM consolidated_facts WHERE id <> ? AND active = 1')
    .all(seed.factId) as Array<{ id: number; pinned: number }>;
  assert.equal(saved.length, 1);
  assert.equal(scope.memoryScopeOf('fact', saved[0].id), null);
  assert.equal(saved[0].pinned, 0);
  const originalEvidence = temporal.getFactEvidence(seed.factId).map(row => row.episodeId);
  assert.equal(temporal.getFactEvidence(saved[0].id).some(row => originalEvidence.includes(row.episodeId)), false);
  assert.equal(fetchAttempts, 0);
});

test('same-scope reconciliation still transfers evidence and pin with reversible history, once', () => {
  const seed = seedAutoCapture(A, `Remember this: ${content} Just confirm.`);
  const saved = facts.rememberFact({ kind: 'project', content, scope: A, sessionId: 'scope-fixture-a' });
  const originalEvidence = temporal.getFactEvidence(seed.factId).map(row => row.episodeId);
  assert.ok(originalEvidence.length > 0);
  assert.equal(reconcileAutoCapturedRememberFact({ sessionId: 'scope-fixture-a', factId: saved.id, content }), 1);
  const memory = db.openMemoryDb();
  assert.deepEqual(memory.prepare('SELECT active, superseded_by_fact_id FROM consolidated_facts WHERE id = ?').get(seed.factId),
    { active: 0, superseded_by_fact_id: saved.id });
  assert.equal((memory.prepare('SELECT pinned FROM consolidated_facts WHERE id = ?').get(saved.id) as { pinned: number }).pinned, 1);
  assert.equal((memory.prepare('SELECT resulting_fact_id FROM memory_reflection_candidates WHERE id = ?').get(seed.candidateId) as { resulting_fact_id: number }).resulting_fact_id, saved.id);
  assert.ok(originalEvidence.every(id => temporal.getFactEvidence(saved.id).some(row => row.episodeId === id)));
  assert.equal(reconcileAutoCapturedRememberFact({ sessionId: 'scope-fixture-a', factId: saved.id, content }), 0);
});

test('same-scope reconciliation preserves a complementary fact in the original wrapper', () => {
  const seed = seedAutoCapture(A, `Remember this: ${content} The release reviewer is Morgan.`);
  const saved = facts.rememberFact({ kind: 'project', content, scope: A, sessionId: 'scope-fixture-a' });
  const before = retainedRows(seed);
  assert.equal(reconcileAutoCapturedRememberFact({ sessionId: 'scope-fixture-a', factId: saved.id, content }), 0);
  assert.deepEqual(retainedRows(seed), before);
});

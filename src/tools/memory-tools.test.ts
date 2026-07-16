/**
 * Run: npx tsx --test src/tools/memory-tools.test.ts
 *
 * Covers the standing-instruction protection policy for the DIRECT memory
 * tools (reviewForgetRequest) — the pure decision behind memory_forget's
 * pinned/constraint refusals. The notification side is a straight
 * addNotification wrapper, covered by the notifications store tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-memory-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { reviewForgetRequest, registerMemoryTools } = await import('./memory-tools.js');
const { LOCAL_MCP_TOOL_NAMES } = await import('./catalog.js');
const { openMemoryDb, resetMemoryDb } = await import('../memory/db.js');
const { rememberFact, getFact } = await import('../memory/facts.js');
const { loadFactEntityEdges } = await import('../memory/relations.js');
const { appendFactRecallTrace } = await import('../memory/recall-trace.js');
const { recordRecallRun } = await import('../memory/recall-usage.js');
const { listProposedMemoryFixes } = await import('../memory/self-heal.js');
const { loadFactEmbeddings, _setEmbeddingProviderForTest } = await import('../memory/embeddings.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test.beforeEach(() => {
  resetMemoryDb();
  _setEmbeddingProviderForTest(undefined);
  rmSync(path.join(TMP_HOME, 'state', 'memory-self-heal'), { recursive: true, force: true });
  rmSync(path.join(TMP_HOME, 'state', 'memory-recall-trace.jsonl'), { force: true });
});

const fact = (over: Partial<{ id: number; kind: string; pinned: boolean; content: string }>) => ({
  id: 42,
  kind: 'user',
  pinned: false,
  content: 'Some fact.',
  ...over,
}) as Parameters<typeof reviewForgetRequest>[0];

test('reviewForgetRequest: a plain unpinned fact can be forgotten (soft or hard)', () => {
  assert.equal(reviewForgetRequest(fact({}), false).allow, true);
  assert.equal(reviewForgetRequest(fact({}), true).allow, true);
});

test('reviewForgetRequest: a PINNED fact is refused — unpin first', () => {
  const r = reviewForgetRequest(fact({ pinned: true }), false);
  assert.equal(r.allow, false);
  assert.match(r.reason ?? '', /PINNED standing instruction/);
  assert.match(r.reason ?? '', /memory_pin/);
});

test('reviewForgetRequest: a pinned CONSTRAINT is refused even for soft delete', () => {
  const r = reviewForgetRequest(fact({ kind: 'constraint', pinned: true }), false);
  assert.equal(r.allow, false);
});

test('reviewForgetRequest: hard-deleting an unpinned constraint is refused; soft is allowed', () => {
  const hard = reviewForgetRequest(fact({ kind: 'constraint', pinned: false }), true);
  assert.equal(hard.allow, false);
  assert.match(hard.reason ?? '', /recoverable/);
  const soft = reviewForgetRequest(fact({ kind: 'constraint', pinned: false }), false);
  assert.equal(soft.allow, true);
});

test('memory_self_heal is exposed in the local MCP catalog', () => {
  assert.ok(LOCAL_MCP_TOOL_NAMES.includes('memory_self_heal'));
});

test('memory_mark_used stays subtracted — usage credit is code-level (recall-auto-credit), not a model tool', () => {
  assert.ok(!LOCAL_MCP_TOOL_NAMES.includes('memory_mark_used'));
  assert.equal(registeredToolHandlers().get('memory_mark_used'), undefined);
});

test('convert_to_markdown is exposed in the local MCP catalog', () => {
  assert.ok(LOCAL_MCP_TOOL_NAMES.includes('convert_to_markdown'));
});

function registeredToolHandlers(): Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>>();
  const server = {
    tool(name: string, ...args: unknown[]) {
      const handler = args.at(-1);
      if (typeof handler !== 'function') throw new Error(`tool ${name} missing handler`);
      handlers.set(name, handler as (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>);
    },
  };
  registerMemoryTools(server as never);
  return handlers;
}

test('memory_remember rejects one-off task requests but accepts explicit standing rules', async () => {
  const previous = process.env.CLEMMY_REMEMBER_RECONCILE;
  process.env.CLEMMY_REMEMBER_RECONCILE = 'off';
  try {
    const handler = registeredToolHandlers().get('memory_remember');
    assert.ok(handler);
    const rejected = await handler!({
      kind: 'user',
      content: 'Quick task: briefly analyze one client and email me the result.',
    });
    assert.match(rejected.content[0].text, /Not remembered.*one-time command/i);
    assert.equal((openMemoryDb().prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count, 0);

    const accepted = await handler!({
      kind: 'feedback',
      content: 'Send the pipeline report every Monday to the sales list.',
    });
    assert.match(accepted.content[0].text, /Remembered/);
    assert.equal((openMemoryDb().prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count, 1);

    const repeated = await handler!({
      kind: 'feedback',
      content: '  Send the pipeline report every Monday to the sales list.  ',
    });
    assert.match(repeated.content[0].text, /Reinforced an existing fact/);
    assert.equal((openMemoryDb().prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count, 1,
      'the old reconcile=off setting must not restore the direct-write bypass');
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_REMEMBER_RECONCILE;
    else process.env.CLEMMY_REMEMBER_RECONCILE = previous;
  }
});

test('memory_remember creates evidence-backed entities and reuses a person by exact personal email', async () => {
  const previous = process.env.CLEMMY_REMEMBER_RECONCILE;
  process.env.CLEMMY_REMEMBER_RECONCILE = 'off';
  try {
    const handler = registeredToolHandlers().get('memory_remember');
    assert.ok(handler, 'memory_remember should be registered');

    const first = await handler!({
      kind: 'project',
      content: 'Dana Smith (dana@acme.com) works at Acme.',
      sessionId: 'remember-entity-session-1',
      entities: [
        { type: 'person', name: 'Dana Smith', aliases: ['Dana'], identifiers: [{ scheme: 'email', value: 'dana@acme.com' }] },
        { type: 'company', name: 'Acme' },
      ],
      relationships: [{ subject: 'Dana Smith', predicate: 'works at', object: 'Acme' }],
    });
    assert.match(first.content[0].text, /linked 2 canonical entities/);
    assert.match(first.content[0].text, /grounded 1 relationship/);

    const second = await handler!({
      kind: 'project',
      content: 'D. Smith (dana@acme.com) leads Project Kite.',
      sessionId: 'remember-entity-session-2',
      entities: [
        { type: 'person', name: 'D. Smith', aliases: ['Dana Smith'], identifiers: [{ scheme: 'email', value: 'dana@acme.com' }] },
        { type: 'project', name: 'Project Kite' },
      ],
      relationships: [{ subject: 'D. Smith', predicate: 'leads', object: 'Project Kite', validFrom: '2026-07-01T00:00:00.000Z' }],
    });
    assert.match(second.content[0].text, /linked 2 canonical entities/);
    assert.match(second.content[0].text, /grounded 1 relationship/);

    const db = openMemoryDb();
    const people = db.prepare("SELECT id, canonical_name FROM entities WHERE entity_type = 'person'").all() as Array<{ id: number; canonical_name: string }>;
    assert.equal(people.length, 1, 'the stable email must converge the name variant into one person');
    assert.equal(people[0].canonical_name, 'Dana Smith');
    assert.equal((db.prepare("SELECT COUNT(*) AS c FROM entity_identifiers WHERE entity_id = ? AND scheme = 'email' AND value_norm = 'dana@acme.com'").get(people[0].id) as { c: number }).c, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS c FROM entity_aliases WHERE entity_id = ? AND alias_lc = 'd. smith'").get(people[0].id) as { c: number }).c, 1);

    const facts = db.prepare("SELECT id FROM consolidated_facts WHERE content IN (?, ?) ORDER BY id")
      .all('Dana Smith (dana@acme.com) works at Acme.', 'D. Smith (dana@acme.com) leads Project Kite.') as Array<{ id: number }>;
    assert.equal(facts.length, 2);
    const edges = loadFactEntityEdges(facts.map((fact) => fact.id));
    assert.equal(edges.length, 4);
    assert.ok(edges.every((edge) => edge.truth === 'stored' && edge.evidenceEpisodeId && edge.evidenceExcerpt));
    assert.equal(edges.filter((edge) => edge.entityId === people[0].id).length, 2, 'both facts should replay through the same canonical person');
    const relationships = db.prepare(`
      SELECT ee.predicate, ee.subject_id, ee.object_id, eee.excerpt, eee.source_fact_id, eee.extraction_method
      FROM entity_edges ee
      JOIN entity_edge_evidence eee
        ON eee.subject_id = ee.subject_id AND eee.predicate = ee.predicate AND eee.object_id = ee.object_id
      ORDER BY ee.predicate
    `).all() as Array<{ predicate: string; subject_id: number; object_id: number; excerpt: string; source_fact_id: number; extraction_method: string }>;
    assert.deepEqual(relationships.map((row) => row.predicate), ['leads', 'works at']);
    assert.ok(relationships.every((row) => row.subject_id === people[0].id));
    assert.ok(relationships.every((row) => row.excerpt.length > 0 && facts.some((fact) => fact.id === row.source_fact_id)));
    assert.ok(relationships.every((row) => row.extraction_method === 'manual'));
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_REMEMBER_RECONCILE;
    else process.env.CLEMMY_REMEMBER_RECONCILE = previous;
  }
});

test('memory_remember rejects unnamed entities and drops identifiers absent from evidence', async () => {
  const previous = process.env.CLEMMY_REMEMBER_RECONCILE;
  process.env.CLEMMY_REMEMBER_RECONCILE = 'off';
  try {
    const handler = registeredToolHandlers().get('memory_remember');
    assert.ok(handler);
    const response = await handler!({
      kind: 'user',
      content: 'Nathan Reynolds met Alex at the memory review.',
      entities: [
        { type: 'person', name: 'Nathan Reynolds', identifiers: [{ scheme: 'email', value: 'invented@example.com' }] },
        { type: 'person', name: 'Morgan Jones', identifiers: [{ scheme: 'email', value: 'morgan@example.com' }] },
      ],
      relationships: [{ subject: 'Nathan Reynolds', predicate: 'knows', object: 'Morgan Jones' }],
    });
    assert.match(response.content[0].text, /linked 1 canonical entity/);
    assert.match(response.content[0].text, /rejected 2 unsupported annotation/);

    const db = openMemoryDb();
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number }).c, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM entity_identifiers').get() as { c: number }).c, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM entity_edges').get() as { c: number }).c, 0);
    const row = db.prepare("SELECT id FROM entities WHERE canonical_name = 'Nathan Reynolds'").get() as { id: number } | undefined;
    assert.ok(row);
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_REMEMBER_RECONCILE;
    else process.env.CLEMMY_REMEMBER_RECONCILE = previous;
  }
});

test('memory_search_facts records an attribution run with snippets for post-turn auto-credit', async () => {
  const fact = rememberFact({ kind: 'project', content: 'The Atlas partnership review is scheduled for Thursday.' });
  const handlers = registeredToolHandlers();
  const search = handlers.get('memory_search_facts');
  assert.ok(search);

  const result = await search!({ query: 'Atlas partnership review Thursday', limit: 8 });
  const text = result.content[0].text;
  assert.match(text, new RegExp(`\\[fact:${fact.id}\\]`));
  assert.doesNotMatch(text, /memory_mark_used/, 'the mark-used trailer stays subtracted');

  const run = openMemoryDb().prepare(`
    SELECT id, candidate_refs_json FROM memory_recall_runs
    WHERE surface = 'memory_search_facts' ORDER BY created_at DESC LIMIT 1
  `).get() as { id: string; candidate_refs_json: string } | undefined;
  assert.ok(run, 'scoped fact search should create an attribution run');
  const refs = JSON.parse(run!.candidate_refs_json) as Array<{ type: string; id: string; snippet?: string }>;
  const candidate = refs.find((r) => r.type === 'fact' && r.id === String(fact.id));
  assert.ok(candidate, 'the returned fact is a run candidate');
  assert.equal(candidate!.snippet, fact.content, 'the snippet carries what the model saw');

  // The code-level credit path replaces the tool: a reply that reproduces the
  // fact's distinctive content credits it against this run.
  const { autoCreditRecallRuns } = await import('../memory/recall-auto-credit.js');
  autoCreditRecallRuns({
    recallIds: [run!.id],
    replyText: 'The Atlas partnership review is on Thursday — I put it on your calendar.',
    queryText: 'review date?',
  });
  assert.equal(getFact(fact.id)?.utilityCount, 1);
});

test('memory_self_heal tool lists, applies, and reverts audited memory fixes', async () => {
  const overexposed = rememberFact({
    kind: 'project',
    content: 'Temporary browser inspection state should not keep winning global memory context.',
    importance: 5,
    trustLevel: 0.6,
    derivedFrom: { tool: 'browser_read', sessionId: 'sess-self-heal-tool' },
  });
  for (let i = 0; i < 8; i += 1) {
    appendFactRecallTrace({
      surface: 'facts_for_instructions',
      facts: [{ fact: overexposed, reason: 'scored-stanford-global' }],
      nowIso: `2026-07-04T12:00:0${i}.000Z`,
    });
  }

  const handler = registeredToolHandlers().get('memory_self_heal');
  assert.ok(handler, 'memory_self_heal should be registered');

  const listed = await handler!({ action: 'list', maxCandidates: 10 });
  assert.match(listed.content[0].text, /demote_overexposed_fact/);
  assert.match(listed.content[0].text, new RegExp(`#${overexposed.id}\\b|ids=${overexposed.id}\\b`));
  assert.equal(listProposedMemoryFixes().length, 0, 'list must not persist proposal records');
  assert.equal(getFact(overexposed.id)?.importance, 5);

  const dry = await handler!({ action: 'dry_run', maxApply: 1, maxCandidates: 10 });
  assert.match(dry.content[0].text, /dry run/);
  assert.match(dry.content[0].text, /applied 1/);
  assert.equal(listProposedMemoryFixes().length, 0, 'dry_run must not persist proposal records');
  assert.equal(getFact(overexposed.id)?.importance, 5);

  const run = await handler!({ action: 'run', maxApply: 1, maxCandidates: 10 });
  const runText = run.content[0].text;
  assert.match(runText, /applied 1/);
  assert.equal(getFact(overexposed.id)?.importance, 4);
  const auditId = runText.match(/audit=(mh-[a-f0-9]+)/)?.[1];
  assert.ok(auditId, 'run output should include the reversible heal audit id');

  const reverted = await handler!({ action: 'revert', auditId });
  assert.match(reverted.content[0].text, /Reverted/);
  assert.equal(getFact(overexposed.id)?.importance, 5);
});

test('memory_embed_backfill can backfill durable fact embeddings', async () => {
  _setEmbeddingProviderForTest({
    name: 'test',
    model: 'test-model',
    dim: 4,
    async embed(texts) {
      return texts.map((text) => Float32Array.from([text.length || 1, 0, 0, 0]));
    },
  });
  try {
    const fact = rememberFact({ kind: 'user', content: 'Nathan prefers semantic memory checks before recall changes.' });
    const handler = registeredToolHandlers().get('memory_embed_backfill');
    assert.ok(handler, 'memory_embed_backfill should be registered');

    const result = await handler!({ scope: 'facts', maxChunks: 5 });
    assert.match(result.content[0].text, /Facts: embedded 1 \/ 1 candidates/);
    assert.match(result.content[0].text, /Fact total embeddings: 1 \(test-model, dim 4\)/);
    assert.equal(loadFactEmbeddings([fact.id]).size, 1);
  } finally {
    _setEmbeddingProviderForTest(undefined);
  }
});

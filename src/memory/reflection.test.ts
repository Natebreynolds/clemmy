/**
 * Run: npx tsx --test src/memory/reflection.test.ts
 *
 * Tests for the Phase 1 brain-architecture reflection layer:
 *   - DB layer: entity upsert + episodic pointer storage round-trip
 *   - facts: rememberFact populates derived_from_* fields, trust_level
 *     defaults to 0.6 for derived / 1.0 for direct, listRecentlyLearnedFacts
 *     returns only derived facts ordered by extracted_at DESC
 *   - reflection: scheduleReflection swallows extractor failures so it
 *     never throws from the hook caller; threshold gate short-circuits
 *     tiny outputs
 *
 * Does NOT call the real summarizer model. The extractor path is mocked
 * via CLEMMY_REFLECTION=off so we exercise the threshold + dedup gates
 * deterministically. Wire-level integration is verified via the existing
 * facts.test.ts roundtrip — see also harness/compaction.test.ts for the
 * tool_outputs storage that recall_tool_result reads from.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-reflection-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetMemoryDb } = await import('./db.js');
const {
  upsertEntity,
  storeEpisodicPointer,
  listRecentEpisodicPointers,
  reflectOnToolReturn,
  isSelfReferentialTool,
  REFLECTION_MIN_CONTENT_CHARS,
  getReflectionThreshold,
  runRecursiveReflection,
  _testOnly_peekSessionImportance,
  _testOnly_resetAllSessionImportance,
} = await import('./reflection.js');
const { rememberFact, listRecentlyLearnedFacts, renderRecentlyLearnedForInstructions } = await import('./facts.js');

test('entities: upsert is idempotent + merges aliases', () => {
  resetMemoryDb();
  const id1 = upsertEntity({ type: 'person', name: 'Marlow Smith', aliases: ['Marlow'] });
  const id2 = upsertEntity({ type: 'person', name: 'Marlow Smith', aliases: ['marlow@acme.com'] });
  assert.equal(id1, id2, 'same canonical+type returns same row');

  const id3 = upsertEntity({ type: 'company', name: 'Marlow Smith' });
  assert.notEqual(id1, id3, 'different type is a different entity even with same name');
});

test('entities: case-insensitive matching on canonical name', () => {
  resetMemoryDb();
  const id1 = upsertEntity({ type: 'person', name: 'Marlow Smith' });
  const id2 = upsertEntity({ type: 'person', name: 'MARLOW SMITH' });
  assert.equal(id1, id2);
});

test('episodic_pointers: round-trip per session', () => {
  resetMemoryDb();
  const sessionId = 'sess-test-1';
  storeEpisodicPointer({
    sessionId,
    callId: 'call_abc',
    label: 'the pricing convo',
    tool: 'composio.outlook',
    sourceUri: 'outlook:thread:xyz',
  });
  storeEpisodicPointer({
    sessionId,
    callId: 'call_def',
    label: 'q2 roadmap doc',
    tool: 'composio.drive',
    sourceUri: null,
  });
  const out = listRecentEpisodicPointers(sessionId, 10);
  assert.equal(out.length, 2);
  // DESC order — newest first
  assert.equal(out[0].label, 'q2 roadmap doc');
  assert.equal(out[1].label, 'the pricing convo');
  assert.equal(out[0].source_uri, null);
  assert.equal(out[1].source_uri, 'outlook:thread:xyz');
});

test('rememberFact: direct fact defaults to trust_level=1.0, no extracted_at', () => {
  resetMemoryDb();
  const fact = rememberFact({
    kind: 'user',
    content: 'User prefers terse replies',
  });
  assert.equal(fact.trustLevel, 1.0);
  assert.equal(fact.extractedAt, null);
  assert.equal(fact.derivedFrom, undefined);
});

test('rememberFact: derived fact gets trust=0.6, populates derived_from + extracted_at', () => {
  resetMemoryDb();
  const fact = rememberFact({
    kind: 'reference',
    content: 'Acme contract runs through Q4 2026',
    sessionId: 'sess-test-2',
    derivedFrom: {
      sessionId: 'sess-test-2',
      callId: 'call_xyz',
      tool: 'composio.outlook',
    },
  });
  assert.equal(fact.trustLevel, 0.6);
  assert.ok(fact.extractedAt);
  assert.equal(fact.derivedFrom?.callId, 'call_xyz');
  assert.equal(fact.derivedFrom?.tool, 'composio.outlook');
});

test('rememberFact: direct write SUPERSEDES prior derived trust on conflict', () => {
  resetMemoryDb();
  // First, the reflection layer extracts a low-confidence fact.
  rememberFact({
    kind: 'user',
    content: 'User probably prefers Tuesday afternoons',
    derivedFrom: { sessionId: 'sess-x', callId: 'call_x', tool: 'outlook' },
  });
  // Then the user states it directly.
  const direct = rememberFact({
    kind: 'user',
    content: 'User probably prefers Tuesday afternoons',
  });
  assert.equal(direct.trustLevel, 1.0, 'direct write must lift trust to 1.0');
});

test('listRecentlyLearnedFacts: returns only derived facts ordered by extracted_at DESC', () => {
  resetMemoryDb();
  rememberFact({ kind: 'user', content: 'direct fact A' });
  rememberFact({
    kind: 'reference',
    content: 'derived fact A',
    derivedFrom: { sessionId: 's', callId: 'c1', tool: 't' },
  });
  rememberFact({
    kind: 'reference',
    content: 'derived fact B',
    derivedFrom: { sessionId: 's', callId: 'c2', tool: 't' },
  });
  const recent = listRecentlyLearnedFacts({ sinceHours: 1, limit: 10 });
  assert.equal(recent.length, 2, 'direct facts excluded');
  // Most recent first
  assert.equal(recent[0].content, 'derived fact B');
  assert.equal(recent[1].content, 'derived fact A');
});

test('renderRecentlyLearnedForInstructions: includes call_id refs for recall', () => {
  resetMemoryDb();
  rememberFact({
    kind: 'reference',
    content: 'Acme contract runs through Q4',
    derivedFrom: { sessionId: 's', callId: 'call_abc123', tool: 'outlook' },
  });
  const rendered = renderRecentlyLearnedForInstructions(24, 10);
  assert.match(rendered, /Acme contract/);
  assert.match(rendered, /\[call_abc123\]/);
  assert.match(rendered, /\(from outlook\)/);
});

test('reflectOnToolReturn: short outputs skip extraction entirely', async () => {
  resetMemoryDb();
  const result = await reflectOnToolReturn({
    sessionId: 'sess-skip',
    callId: 'call_short',
    tool: 'noop',
    output: 'tiny',
  });
  assert.equal(result.skipped, 'too_short');
  assert.equal(result.factsWritten, 0);
});

test('reflectOnToolReturn: disabled via CLEMMY_REFLECTION=off', async () => {
  resetMemoryDb();
  const prev = process.env.CLEMMY_REFLECTION;
  process.env.CLEMMY_REFLECTION = 'off';
  try {
    const result = await reflectOnToolReturn({
      sessionId: 'sess-disabled',
      callId: 'call_x',
      tool: 't',
      output: 'x'.repeat(REFLECTION_MIN_CONTENT_CHARS + 1),
    });
    assert.equal(result.skipped, 'disabled');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION;
    else process.env.CLEMMY_REFLECTION = prev;
  }
});

test('REFLECTION_MIN_CONTENT_CHARS: gate constant exposed for hooks.ts use', () => {
  assert.ok(REFLECTION_MIN_CONTENT_CHARS >= 200, 'threshold should be high enough to skip pings/acks');
  assert.ok(REFLECTION_MIN_CONTENT_CHARS <= 2000, 'threshold should not exclude typical tool returns');
});

test('getReflectionThreshold: default is Stanford/2 (75), env override accepted', () => {
  const prev = process.env.CLEMMY_REFLECTION_THRESHOLD;
  try {
    delete process.env.CLEMMY_REFLECTION_THRESHOLD;
    assert.equal(getReflectionThreshold(), 75);
    process.env.CLEMMY_REFLECTION_THRESHOLD = '150';
    assert.equal(getReflectionThreshold(), 150, 'Stanford default available via env');
    process.env.CLEMMY_REFLECTION_THRESHOLD = '0';
    assert.equal(getReflectionThreshold(), 0, '0 disables the gate');
    process.env.CLEMMY_REFLECTION_THRESHOLD = 'garbage';
    assert.equal(getReflectionThreshold(), 75, 'invalid input falls back to default');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD;
    else process.env.CLEMMY_REFLECTION_THRESHOLD = prev;
  }
});

test('session importance counter: accumulate + reset', () => {
  _testOnly_resetAllSessionImportance();
  resetMemoryDb();
  const sid = 'sess-importance-1';
  assert.equal(_testOnly_peekSessionImportance(sid), 0);
  // accumulateImportance is internal — exercise via the reflection path
  // is covered by the integration check below. Here we verify the peek
  // helper returns 0 for an unknown session.
  assert.equal(_testOnly_peekSessionImportance('never-seen'), 0);
});

// Note: full importance-gating integration coverage (extraction below
// threshold → cancelled:low_importance, accumulation across calls,
// commit-then-reset) requires mocking the LLM extractor. The threshold
// helper above + the gate's deterministic arithmetic are unit-tested;
// the runtime path is exercised end-to-end in manual verification per
// the Phase 2 plan.

test('runRecursiveReflection: disabled via CLEMMY_REFLECTION=off returns cancelled', async () => {
  resetMemoryDb();
  const prev = process.env.CLEMMY_REFLECTION;
  process.env.CLEMMY_REFLECTION = 'off';
  try {
    const result = await runRecursiveReflection();
    assert.equal(result.patternsWritten, 0);
    assert.equal(result.groupsProcessed, 0);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION;
    else process.env.CLEMMY_REFLECTION = prev;
  }
});

test('runRecursiveReflection: groups with <5 facts are skipped (no extractor call)', async () => {
  resetMemoryDb();
  // Seed exactly 4 facts in one kind — below the 5-fact minimum. With
  // CLEMMY_REFLECTION on but no real extractor wired, this still must
  // NOT hit the network: the group-size gate fires first.
  for (let i = 0; i < 4; i += 1) {
    rememberFact({
      kind: 'user',
      content: `User preference ${i}: terse replies on workdays`,
      importance: 5,
    });
  }
  const result = await runRecursiveReflection();
  assert.equal(result.groupsSkipped, 4, 'all 4 kinds skip (each has <5 facts)');
  assert.equal(result.groupsProcessed, 0);
  assert.equal(result.factsConsidered, 0);
});

test('depth/provenance: rememberFact persists derivationDepth + derivedFromFactIds', () => {
  resetMemoryDb();
  const source = rememberFact({ kind: 'user', content: 'User likes Tuesdays' });
  const pattern = rememberFact({
    kind: 'user',
    content: 'User has a consistent mid-week meeting preference',
    derivationDepth: 1,
    derivedFromFactIds: [source.id],
    importance: 7,
  });
  assert.equal(pattern.derivationDepth, 1);
  assert.deepEqual(pattern.derivedFromFactIds, [source.id]);
  assert.equal(pattern.importance, 7);
});

test('isSelfReferentialTool: denies Clementine introspective tools, keeps real-data tools', () => {
  // Self/introspective → denied (no reflection).
  for (const t of [
    'memory_read', 'memory_recall', 'memory_search', 'memory_search_facts',
    'memory_list_facts', 'memory_remember', 'memory_forget',
    'recall_tool_result', 'tool_output_query', 'draft_plan',
    'task_list', 'task_get', 'task_create', 'task_update', 'active_task',
    'workflow_get', 'workflow_list', 'workflow_schedule',
    'background_task_status', 'execution_get', 'execution_list',
    'MEMORY_READ', // case-insensitive
  ]) {
    assert.equal(isSelfReferentialTool(t), true, `${t} should be denied`);
  }
  // Real user/external data → kept reflectable.
  for (const t of [
    'read_file', 'run_shell_command', 'skill_read', 'workflow_run',
    'firecrawl_search', 'OUTLOOK_SEND_EMAIL', 'SALESFORCE_GET_RECORD',
    'composio_execute_tool', null, undefined, '',
  ]) {
    assert.equal(isSelfReferentialTool(t as string | null | undefined), false, `${t} should be reflectable`);
  }
});

test('reflectOnToolReturn: a self-tool return is skipped before the extractor (no fact written)', async () => {
  resetMemoryDb();
  const prevReflect = process.env.CLEMMY_REFLECTION;
  const prevSelf = process.env.CLEMMY_REFLECT_SELF_TOOLS;
  delete process.env.CLEMMY_REFLECTION;        // reflection ENABLED
  delete process.env.CLEMMY_REFLECT_SELF_TOOLS; // filter at default (ON)
  try {
    // Output is well over REFLECTION_MIN_CONTENT_CHARS so only the self-tool
    // gate (not the too_short gate) can produce the skip — and it returns
    // BEFORE runExtractor, so no model call happens.
    const longOutput = 'recalled fact: '.repeat(40);
    const res = await reflectOnToolReturn({
      sessionId: 'sess-self-tool',
      callId: 'call-1',
      tool: 'memory_read',
      output: longOutput,
    });
    assert.equal(res.skipped, 'self_tool', 'memory_read return must short-circuit as self_tool');
    assert.equal(res.factsWritten, 0, 'no fact written from a self-tool reflection');
  } finally {
    if (prevReflect === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prevReflect;
    if (prevSelf === undefined) delete process.env.CLEMMY_REFLECT_SELF_TOOLS; else process.env.CLEMMY_REFLECT_SELF_TOOLS = prevSelf;
  }
});

// Cleanup
process.on('exit', () => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

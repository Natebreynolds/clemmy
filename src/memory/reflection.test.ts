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

const { resetMemoryDb, openMemoryDb } = await import('./db.js');
const {
  upsertEntity,
  storeEpisodicPointer,
  listRecentEpisodicPointers,
  reflectOnToolReturn,
  scheduleReflection,
  _testOnly_reflectionPending,
  isSelfReferentialTool,
  REFLECTION_MIN_CONTENT_CHARS,
  EXTRACTOR_MAX_FACTS,
  getReflectionThreshold,
  runRecursiveReflection,
  consolidateActiveFacts,
  consolidateFact,
  getResolverStats,
  _resetResolverStatsForTest,
  _testOnly_peekSessionImportance,
  _testOnly_resetAllSessionImportance,
  _testOnly_setReflectionExtractor,
  _testOnly_sanitizeExtractionOutput,
  _testOnly_sanitizeRecursivePatternOutput,
  _testOnly_sanitizeConflictDecision,
} = await import('./reflection.js');
const { rememberFact, getFact, setFactPinned, listRecentlyLearnedFacts, renderRecentlyLearnedForInstructions } = await import('./facts.js');
const { vectorToBuffer, _setEmbeddingProviderForTest } = await import('./embeddings.js');

function factContentHash(id: number): string {
  const row = openMemoryDb().prepare('SELECT content_hash FROM consolidated_facts WHERE id = ?').get(id) as { content_hash: string };
  return row.content_hash;
}

test.afterEach(() => {
  _setEmbeddingProviderForTest(undefined);
  _testOnly_setReflectionExtractor(null);
});

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

test('EXTRACTOR_MAX_FACTS: bounds facts-per-return to a small cap (intake throttle)', () => {
  assert.ok(EXTRACTOR_MAX_FACTS >= 1 && EXTRACTOR_MAX_FACTS <= 6, 'a few facts per tool return, not a dump');
  assert.ok(EXTRACTOR_MAX_FACTS < 8, 'tighter than the legacy 8 ceiling so the low-value tail is trimmed');
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

test('reflectOnToolReturn: low-importance extractions persist and commit together when the threshold crosses', async () => {
  resetMemoryDb();
  _testOnly_resetAllSessionImportance();
  const prevReflect = process.env.CLEMMY_REFLECTION;
  const prevThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
  delete process.env.CLEMMY_REFLECTION;
  process.env.CLEMMY_REFLECTION_THRESHOLD = '10';
  const sessionId = 'sess-pending-reflection';
  try {
    _testOnly_setReflectionExtractor(async (prompt) => {
      if (prompt.includes('call-low')) {
        return {
          facts: [{ kind: 'reference', text: 'Quorvex amber docket anchors the retention proof', importance: 4 }],
          entities: [{ type: 'project', name: 'Quorvex Docket' }],
          pointers: [],
        };
      }
      return {
        facts: [{ kind: 'reference', text: 'Zentara blue ledger closes the threshold proof', importance: 6 }],
        entities: [],
        pointers: [{ label: 'zentara blue ledger' }],
      };
    });

    const first = await reflectOnToolReturn({
      sessionId,
      callId: 'call-low',
      tool: 'read_file',
      output: 'first durable output '.repeat(80),
    });
    assert.equal(first.skipped, 'low_importance');
    assert.equal(first.factsWritten, 0);
    assert.equal(first.pointersStored, 1, 'pointer is stored even while fact commit is delayed');
    assert.equal(_testOnly_peekSessionImportance(sessionId), 4);
    assert.equal(
      (openMemoryDb().prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get() as { n: number }).n,
      0,
      'below-threshold facts are delayed, not committed immediately',
    );
    const firstPointer = listRecentEpisodicPointers(sessionId, 10)[0];
    assert.equal(firstPointer?.call_id, 'call-low');
    assert.match(firstPointer?.label ?? '', /derived_fact_source/);

    const second = await reflectOnToolReturn({
      sessionId,
      callId: 'call-cross',
      tool: 'read_file',
      output: 'second durable output '.repeat(80),
    });
    assert.equal(second.skipped, undefined);
    assert.equal(second.factsWritten, 2, 'crossing the threshold commits current and pending facts');
    assert.equal(second.entitiesUpserted, 1, 'pending entities commit with their delayed batch');
    assert.equal(second.sumImportance, 10);
    assert.equal(_testOnly_peekSessionImportance(sessionId), 0, 'pending threshold window resets after commit');

    const rows = openMemoryDb().prepare(`
      SELECT content, derived_from_call_id
      FROM consolidated_facts
      ORDER BY derived_from_call_id
    `).all() as Array<{ content: string; derived_from_call_id: string | null }>;
    assert.deepEqual(
      rows.map((r) => [r.derived_from_call_id, r.content]),
      [
        ['call-cross', 'Zentara blue ledger closes the threshold proof'],
        ['call-low', 'Quorvex amber docket anchors the retention proof'],
      ],
    );
    assert.equal(
      (openMemoryDb().prepare('SELECT COUNT(*) AS n FROM reflection_pending_extractions').get() as { n: number }).n,
      0,
      'pending rows are cleared only after the delayed facts commit',
    );
  } finally {
    if (prevReflect === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prevReflect;
    if (prevThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD; else process.env.CLEMMY_REFLECTION_THRESHOLD = prevThreshold;
  }
});

test('reflectOnToolReturn: extractor failure still leaves a recallable pointer', async () => {
  resetMemoryDb();
  _testOnly_resetAllSessionImportance();
  const prevReflect = process.env.CLEMMY_REFLECTION;
  delete process.env.CLEMMY_REFLECTION;
  try {
    _testOnly_setReflectionExtractor(async () => null);
    const result = await reflectOnToolReturn({
      sessionId: 'sess-extractor-fail',
      callId: 'call-extractor-fail',
      tool: 'composio_execute_tool',
      output: 'large connector output with potentially useful rows '.repeat(80),
    });
    assert.equal(result.skipped, 'extractor_failed');
    assert.equal(result.pointersStored, 1);
    const pointers = listRecentEpisodicPointers('sess-extractor-fail', 5);
    assert.equal(pointers.length, 1);
    assert.equal(pointers[0].call_id, 'call-extractor-fail');
    assert.match(pointers[0].label, /extractor_failed/);
  } finally {
    if (prevReflect === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prevReflect;
  }
});

test('reflection extractor sanitizer preserves signal from schema-drifted JSON', () => {
  const extraction = _testOnly_sanitizeExtractionOutput('```json\n' + JSON.stringify({
    facts: [
      { kind: 'memory', text: 'User prefers CRM exports grouped by account owner.', importance: '8' },
      { kind: 'project', text: 'Acme renewal outreach uses the Q3 pipeline sheet.', importance: 6 },
    ],
    entities: [
      { type: 'organization', name: 'Acme Legal', aliases: [null, 'Acme'] },
      { type: 'account', name: 'Q3 Pipeline' },
      { type: 'person', name: '' },
    ],
    pointers: null,
    resources: [
      { kind: 'sheet', name: 'Q3 pipeline sheet', whats_here: 'renewal outreach rows' },
      { kind: 'folder', ref: 'drive:missing-name' },
    ],
  }) + '\n```', { withResources: true });

  assert.ok(extraction);
  assert.deepEqual(extraction.facts.map((fact) => [fact.kind, fact.importance]), [['user', 8], ['project', 6]]);
  assert.deepEqual(extraction.entities.map((entity) => [entity.type, entity.name]), [['company', 'Acme Legal'], ['company', 'Q3 Pipeline']]);
  assert.deepEqual(extraction.entities[0].aliases, ['Acme']);
  assert.deepEqual(extraction.pointers, []);
  assert.deepEqual(extraction.resources, [
    { kind: 'sheet', name: 'Q3 pipeline sheet', whats_here: 'renewal outreach rows' },
  ]);
});

test('recursive reflection sanitizer accepts schema-drifted pattern output', () => {
  const extraction = _testOnly_sanitizeRecursivePatternOutput('```json\n' + JSON.stringify({
    patterns: [
      { summary: 'User repeatedly asks for harness changes that keep model output from being discarded.', importance: '11' },
      { text: 'ok', importance: 7 },
      { pattern: 'Clementine work increasingly centers on long-horizon recovery and durable memory.', score: '6' },
    ],
  }) + '\n```');

  assert.ok(extraction);
  assert.deepEqual(extraction.patterns, [
    { text: 'User repeatedly asks for harness changes that keep model output from being discarded.', importance: 10 },
    { text: 'Clementine work increasingly centers on long-horizon recovery and durable memory.', importance: 6 },
  ]);
  assert.deepEqual(_testOnly_sanitizeRecursivePatternOutput('{"patterns":null}')?.patterns, []);
  assert.deepEqual(_testOnly_sanitizeRecursivePatternOutput('[{"text":"Top-level array pattern","importance":4}]')?.patterns, [
    { text: 'Top-level array pattern', importance: 4 },
  ]);
});

test('conflict resolver sanitizer accepts schema-drifted JSON', () => {
  const decision = _testOnly_sanitizeConflictDecision('```json\n' + JSON.stringify({
    verdict: 'update',
    targetId: '42',
    replacement: 'User now prefers concise Friday pipeline summaries.',
    rationale: 'The candidate is a newer user preference.',
  }) + '\n```');
  assert.deepEqual(decision, {
    decision: 'UPDATE',
    target_id: 42,
    rewrite: 'User now prefers concise Friday pipeline summaries.',
    reason: 'The candidate is a newer user preference.',
  });
  assert.equal(_testOnly_sanitizeConflictDecision('{"decision":"MERGE"}'), null);
});

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

test('recursive reflection CONSOLIDATES: rolled-up depth-0 sources are demoted (derived only; user-trust + pinned protected)', async () => {
  resetMemoryDb();
  const prev = process.env.CLEMMY_REFLECTION;
  delete process.env.CLEMMY_REFLECTION; // reflection ENABLED
  try {
    // 5 derived (trust 0.6) depth-0 sources at the default importance 5 → demotable.
    const derived = [];
    for (let i = 0; i < 5; i += 1) {
      derived.push(rememberFact({ kind: 'user', content: `Derived signal number ${i} observed from a tool return`, importance: 5, trustLevel: 0.6 }));
    }
    // A user-STATED fact (trust 1.0) and a pinned source must NOT be demoted.
    const userStated = rememberFact({ kind: 'user', content: 'User explicitly stated a standing preference here', importance: 5, trustLevel: 1.0 });
    const pinnedSrc = rememberFact({ kind: 'user', content: 'A pinned standing-rule source fact', importance: 5, trustLevel: 0.6 });
    setFactPinned(pinnedSrc.id, true);

    // Deterministic extractor → one higher-order pattern, token-disjoint from the
    // sources so findSimilarFacts returns nothing → resolveConflict ADDs (no network).
    const stub = async () => ({ patterns: [{ text: 'ZZZ QQQ XYZZY consolidated rollup token', importance: 7 }] });
    const result = await runRecursiveReflection({ extractor: stub as never });

    assert.ok(result.patternsWritten >= 1, 'a higher-order pattern was written');
    assert.equal(result.sourcesDemoted, 5, 'only the 5 derived depth-0 sources are demoted');
    for (const f of derived) assert.equal(getFact(f.id)?.importance, 3, 'derived source clamped down to 3');
    assert.equal(getFact(userStated.id)?.importance, 5, 'user-stated (trust 1.0) source untouched');
    assert.equal(getFact(pinnedSrc.id)?.importance, 5, 'pinned source untouched');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prev;
  }
});

test('isSelfReferentialTool: denies Clementine introspective tools, keeps real-data tools', () => {
  // Self/introspective → denied (no reflection).
  for (const t of [
    'memory_read', 'memory_recall', 'memory_search', 'memory_search_facts',
    'memory_list_facts', 'memory_remember', 'memory_forget',
    'recall_tool_result', 'tool_output_query', 'draft_plan',
    'task_list', 'task_get', 'task_create', 'task_update',
    'workflow_get', 'workflow_list', 'workflow_schedule', 'workflow_step',
    'background_task_status', 'execution_get', 'execution_list',
    'unified_recall',
    'goal_get', 'goal_list', 'goal_status',
    'space_get', 'space_get_runner', 'space_get_view', 'attempt_record',
    // Clem's own scratchpad + ephemeral status pollers.
    'focus_get', 'focus_set', 'focus_park', 'browser_harness_status',
    'MEMORY_READ', // case-insensitive
    'FOCUS_GET',   // case-insensitive
  ]) {
    assert.equal(isSelfReferentialTool(t), true, `${t} should be denied`);
  }
  // Real user/external data → kept reflectable.
  for (const t of [
    'read_file', 'run_shell_command', 'skill_read', 'workflow_run',
    'firecrawl_search', 'OUTLOOK_SEND_EMAIL', 'SALESFORCE_GET_RECORD',
    'composio_execute_tool',
    // goal_create / goal_draft carry the user's STATED goal text — reflectable.
    'goal_create', 'goal_draft',
    null, undefined, '',
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

test('reflectOnToolReturn: a focus_get return is skipped before the extractor (no model call)', async () => {
  resetMemoryDb();
  const prevReflect = process.env.CLEMMY_REFLECTION;
  const prevSelf = process.env.CLEMMY_REFLECT_SELF_TOOLS;
  delete process.env.CLEMMY_REFLECTION;
  delete process.env.CLEMMY_REFLECT_SELF_TOOLS;
  try {
    // focus_get returns the full plan/focus blob — well over the too_short gate,
    // so ONLY the self_tool gate can produce the skip, and it returns BEFORE
    // runExtractor (no model call, no 12-27s stall).
    const longFocusBlob = 'plan step: gather data before validate. '.repeat(30);
    const res = await reflectOnToolReturn({
      sessionId: 'sess-focus',
      callId: 'call-focus-1',
      tool: 'focus_get',
      output: longFocusBlob,
    });
    assert.equal(res.skipped, 'self_tool', 'focus_get must short-circuit as self_tool before the extractor');
    assert.equal(res.factsWritten, 0, 'no fact written from a focus_get reflection');
  } finally {
    if (prevReflect === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prevReflect;
    if (prevSelf === undefined) delete process.env.CLEMMY_REFLECT_SELF_TOOLS; else process.env.CLEMMY_REFLECT_SELF_TOOLS = prevSelf;
  }
});

test('scheduleReflection: serial queue drains self-tool returns without concurrent extractor calls', async () => {
  resetMemoryDb();
  const prevReflect = process.env.CLEMMY_REFLECTION;
  const prevSerial = process.env.CLEMMY_REFLECTION_SERIAL;
  const prevSelf = process.env.CLEMMY_REFLECT_SELF_TOOLS;
  delete process.env.CLEMMY_REFLECTION;
  delete process.env.CLEMMY_REFLECTION_SERIAL; // serial ON (default)
  delete process.env.CLEMMY_REFLECT_SELF_TOOLS;
  try {
    // Enqueue several self-tool reflections. They short-circuit (self_tool) so
    // no real model call fires, but they still exercise the FIFO chain: each
    // increments pending on enqueue and decrements as the chain drains. After a
    // microtask flush the queue must be fully drained (pending back to 0).
    const longBlob = 'recalled fact: '.repeat(40);
    for (let i = 0; i < 5; i += 1) {
      scheduleReflection({ sessionId: 'sess-serial', callId: `c-${i}`, tool: 'focus_get', output: longBlob });
    }
    assert.ok(_testOnly_reflectionPending() > 0, 'reflections should be queued synchronously on enqueue');
    // Let the serial chain drain.
    for (let i = 0; i < 10 && _testOnly_reflectionPending() > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(_testOnly_reflectionPending(), 0, 'serial queue must fully drain');
  } finally {
    if (prevReflect === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prevReflect;
    if (prevSerial === undefined) delete process.env.CLEMMY_REFLECTION_SERIAL; else process.env.CLEMMY_REFLECTION_SERIAL = prevSerial;
    if (prevSelf === undefined) delete process.env.CLEMMY_REFLECT_SELF_TOOLS; else process.env.CLEMMY_REFLECT_SELF_TOOLS = prevSelf;
  }
});


test('consolidateActiveFacts (stored embeddings): full-coverage pairwise dedup keeps the higher-scored fact', async () => {
  resetMemoryDb();
  _setEmbeddingProviderForTest({
    name: 'test',
    model: 'test',
    dim: 4,
    async embed(texts) {
      return texts.map(() => new Float32Array(4));
    },
  });
  const db = openMemoryDb();
  const embed = db.prepare(`INSERT INTO fact_embeddings (fact_id, model, dim, vector, content_hash, created_at)
                            VALUES (?, 'test', 4, ?, ?, datetime('now'))`);
  const setVec = (id: number, arr: number[]) => embed.run(id, vectorToBuffer(Float32Array.from(arr)), factContentHash(id));

  // A and B are near-duplicates (identical vector); B has the higher score → A is dropped.
  const a = rememberFact({ kind: 'project', content: 'Quarterly revenue target is 2M.', score: 1.0 });
  const b = rememberFact({ kind: 'project', content: 'The quarterly revenue goal is two million.', score: 1.5 });
  const c = rememberFact({ kind: 'project', content: 'Office relocation planned for spring.', score: 1.0 });
  setVec(a.id, [1, 0, 0, 0]);
  setVec(b.id, [1, 0, 0, 0]);
  setVec(c.id, [0, 1, 0, 0]);

  const res = await consolidateActiveFacts({ useStoredEmbeddings: true, simThreshold: 0.95 });
  assert.ok(res.merged >= 1, 'at least one near-duplicate is folded');
  assert.ok(res.ids.includes(a.id), 'the lower-scored duplicate (A) is dropped');
  assert.equal(getFact(a.id)?.active, false, 'A is soft-deleted');
  assert.equal(getFact(b.id)?.active, true, 'the higher-scored B is kept');
  assert.equal(getFact(c.id)?.active, true, 'the distinct fact C is untouched');
});

test('consolidateActiveFacts (entity guard): never folds two facts about DISTINCT entities even at cosine 1.0', async () => {
  resetMemoryDb();
  _setEmbeddingProviderForTest({
    name: 'test',
    model: 'test',
    dim: 4,
    async embed(texts) {
      return texts.map(() => new Float32Array(4));
    },
  });
  const db = openMemoryDb();
  const embed = db.prepare(`INSERT INTO fact_embeddings (fact_id, model, dim, vector, content_hash, created_at)
                            VALUES (?, 'test', 4, ?, ?, datetime('now'))`);
  const setVec = (id: number, arr: number[]) => embed.run(id, vectorToBuffer(Float32Array.from(arr)), factContentHash(id));

  // The Revill-vs-Aldous data-loss case: two DISTINCT-client facts with identical
  // phrasing (identical vector → cosine 1.0). Without the entity guard the older
  // ties on score and is soft-deleted, corrupting recall for one client. The
  // guard (extractAnchors/canMergeEntitySafe, shared with the paraphrase merge)
  // must keep BOTH.
  const revill = rememberFact({ kind: 'project', content: 'Revill Law Firm ranks #3 for PI Birmingham.', score: 1.0 });
  const aldous = rememberFact({ kind: 'project', content: 'Aldous Law ranks #3 for PI Birmingham.', score: 1.0 });
  setVec(revill.id, [1, 0, 0, 0]);
  setVec(aldous.id, [1, 0, 0, 0]);

  const res = await consolidateActiveFacts({ useStoredEmbeddings: true, simThreshold: 0.95 });
  assert.equal(res.merged, 0, 'distinct-entity facts are NOT folded despite cosine 1.0');
  assert.equal(getFact(revill.id)?.active, true, 'Revill survives');
  assert.equal(getFact(aldous.id)?.active, true, 'Aldous survives');
});

test('consolidateActiveFacts (stored embeddings): makes ZERO new embed API calls (uses stored vectors)', async () => {
  resetMemoryDb();
  const db = openMemoryDb();
  // No OPENAI key in this test env + no stored vectors for these facts → the
  // stored path simply finds nothing to compare and never calls the API.
  rememberFact({ kind: 'user', content: 'A fact with no embedding yet.' });
  const res = await consolidateActiveFacts({ useStoredEmbeddings: true });
  assert.equal(res.merged, 0, 'un-embedded facts are skipped, not re-embedded');
});


test('runRecursiveReflection: a FAILING extractor is counted as groupsFailed (not a silent quiet week)', async () => {
  resetMemoryDb();
  const prev = process.env.CLEMMY_REFLECTION; delete process.env.CLEMMY_REFLECTION;
  try {
    for (let i = 0; i < 6; i += 1) rememberFact({ kind: 'project', content: `Distinct roadmap signal number ${i} for synthesis.` });
    const res = await runRecursiveReflection({ extractor: async () => null }); // simulate broken synthesizer
    assert.ok(res.groupsFailed >= 1, 'a null extractor return is a FAILED group, not low-signal');
    assert.equal(res.patternsWritten, 0);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prev;
  }
});

test('runRecursiveReflection: an EMPTY extractor is a low-signal week (processed, 0 failed)', async () => {
  resetMemoryDb();
  const prev = process.env.CLEMMY_REFLECTION; delete process.env.CLEMMY_REFLECTION;
  try {
    for (let i = 0; i < 6; i += 1) rememberFact({ kind: 'project', content: `Distinct low-signal fact number ${i}.` });
    const res = await runRecursiveReflection({ extractor: async () => ({ patterns: [] }) });
    assert.equal(res.groupsFailed, 0, 'an empty-but-successful extractor is NOT a failure');
    assert.ok(res.groupsProcessed >= 1, 'the group was processed (ran fine, nothing to synthesize)');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prev;
  }
});


test('getResolverStats: a novel fact tallies as an ADD (resolver observability)', async () => {
  resetMemoryDb();
  _resetResolverStatsForTest();
  const prev = process.env.CLEMMY_REFLECTION; delete process.env.CLEMMY_REFLECTION;
  try {
    // A novel fact (no similar existing facts) takes the novelty fast-path → ADD,
    // no LLM resolver call — deterministic in the test env.
    const out = await consolidateFact({ kind: 'user', text: 'Nathan keeps a standing 9am Monday review.' });
    assert.equal(out.written, 1, 'novel fact is added');
    const stats = getResolverStats();
    assert.ok(stats.add >= 1, 'the ADD decision is tallied');
    assert.equal(stats.update + stats.delete + stats.noop, 0, 'no update/delete/noop for a novel add');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prev;
  }
});

test('consolidateFact: resolver DELETE on a pinned fact is blocked — fact stays active, candidate ADDed', async () => {
  resetMemoryDb();
  const prot = rememberFact({ kind: 'feedback', content: 'Never send Scorpion mail from breakthrough.co.' });
  setFactPinned(prot.id, true);
  const out = await consolidateFact(
    { kind: 'feedback', text: 'Sending Scorpion mail from breakthrough.co is fine now.' },
    {},
    { resolver: async () => ({ decision: 'DELETE', target_id: prot.id }) },
  );
  const reloaded = getFact(prot.id);
  assert.equal(reloaded?.active, true, 'pinned fact survives a resolver DELETE');
  assert.equal(reloaded?.pinned, true, 'still pinned');
  assert.equal(out.deleted, 0, 'no delete tallied');
  assert.equal(out.written, 1, 'candidate falls through to the conservative ADD');
});

test('consolidateFact: resolver UPDATE on a pinned fact is blocked — content unchanged, candidate ADDed', async () => {
  resetMemoryDb();
  const content = 'Always route Scorpion sends through scorpion.co.';
  const prot = rememberFact({ kind: 'feedback', content });
  setFactPinned(prot.id, true);
  const out = await consolidateFact(
    { kind: 'feedback', text: 'Scorpion sends can route through any connection.' },
    {},
    { resolver: async () => ({ decision: 'UPDATE', target_id: prot.id, rewrite: 'Scorpion sends can route through any connection.' }) },
  );
  assert.equal(getFact(prot.id)?.content, content, 'pinned content is untouched');
  assert.equal(out.updated, 0, 'no update tallied');
  assert.equal(out.written, 1, 'candidate falls through to the conservative ADD');
});

test('consolidateFact: oversized resolver rewrite falls back to candidate text', async () => {
  resetMemoryDb();
  const target = rememberFact({ kind: 'project', content: 'Quarterly revenue target is 1M.' });
  const out = await consolidateFact(
    { kind: 'project', text: 'Quarterly revenue target is 2M.' },
    {},
    { resolver: async () => ({ decision: 'UPDATE', target_id: target.id, rewrite: 'x'.repeat(501) }) },
  );
  assert.equal(out.updated, 1, 'unpinned target is updated');
  assert.equal(getFact(target.id)?.content, 'Quarterly revenue target is 2M.', 'cap rejects the 501-char rewrite in favor of candidate text');
});

// Cleanup
process.on('exit', () => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

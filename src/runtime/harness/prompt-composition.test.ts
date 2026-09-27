/**
 * Run: npx tsx --test src/runtime/harness/prompt-composition.test.ts
 *
 * These pins protect a MEASUREMENT, and the thing a measurement has to be is
 * honest about the right quantity. The tempting reading of a 753k-token prompt
 * is "make it smaller"; under prompt caching that is half wrong and the wrong
 * half costs money and speed, because a small VARYING prefix re-pays in full
 * while a large STABLE one is served warm. So the split — not the total — is
 * what these hold.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-prompt-comp-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'comp-machine\n');

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const {
  measureAdvertisedToolSurface, measureToolPromptSurface, memoryContextSections,
  promptComponentsFromComposition, summarizePromptComposition,
} = await import('./prompt-composition.js');
const { MEMORY_CONTEXT_SECTION_TITLES } = await import('../../agents/memory-context-sections.js');
const { readFileSync } = await import('node:fs');
const { CACHE_BREAK_SENTINEL, CACHE_MEMORY_CONTEXT_SENTINEL, CACHE_MEMORY_CONTEXT_DELIM } = await import('./model-wire-registry.js');

after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('identity and tool schemas are STABLE; the per-turn packet is VARIABLE', () => {
  const s = summarizePromptComposition({
    instructions: 'who she is, '.repeat(500),
    contextPacket: 'capability facts for this turn, '.repeat(50),
    currentMessage: 'finalize the airtable base',
    toolNames: ['tool_search', 'memory_recall_all', 'ask_user_question'],
  });
  const byName = Object.fromEntries(s.buckets.map((b) => [b.name, b.stability]));
  assert.equal(byName.instructions, 'stable', 'persona must be cacheable — large is fine when invariant');
  assert.equal(byName.toolSchemas, 'stable', 'a stable tool surface is the point of monotonic JIT');
  assert.equal(byName.contextPacket, 'variable', 'the preflight packet is rebuilt every turn');
  assert.equal(byName.currentMessage, 'variable');
});

test('tool schemas are counted — an unmeasured cost is an unmanaged one', () => {
  const withoutTools = summarizePromptComposition({ instructions: 'x '.repeat(100) });
  const withTools = summarizePromptComposition({
    instructions: 'x '.repeat(100),
    toolNames: Array.from({ length: 40 }, (_, i) => `tool_${i}`),
  });
  assert.equal(withoutTools.toolCount, 0);
  assert.equal(withTools.toolCount, 40);
  assert.ok(withTools.totalTokens > withoutTools.totalTokens,
    'advertising 40 schemas cannot be free in the accounting');
});

test('stableShare is the actionable number: a fat variable layer drags it down', () => {
  const disciplined = summarizePromptComposition({
    instructions: 'stable core, '.repeat(1000),
    currentMessage: 'do the thing',
  });
  const undisciplined = summarizePromptComposition({
    instructions: 'stable core, '.repeat(1000),
    contextPacket: 'rebuilt every single turn, '.repeat(1000),
    currentMessage: 'do the thing',
  });
  assert.ok(disciplined.stableShare > 0.9, 'a small variable layer keeps the prefix warm');
  assert.ok(undisciplined.stableShare < disciplined.stableShare,
    'a large per-turn block is exactly what the number must expose');
});

test('the summary is pure observation — it reports, it never rewrites', () => {
  const instructions = 'persona text';
  const packet = 'turn facts';
  const s = summarizePromptComposition({ instructions, contextPacket: packet, currentMessage: 'hi' });
  // Nothing here may mutate or truncate what is being measured.
  assert.equal(instructions, 'persona text');
  assert.equal(packet, 'turn facts');
  assert.equal(s.stableTokens + s.variableTokens, s.totalTokens, 'the split must account for the whole');
  assert.deepEqual([...s.buckets].sort((a, b) => b.tokens - a.tokens), s.buckets, 'largest first, so the cut is obvious');
});

test('an empty turn measures nothing rather than inventing a reading', () => {
  const s = summarizePromptComposition({});
  assert.equal(s.totalTokens, 0);
  assert.equal(s.stableShare, 0);
  assert.deepEqual(s.buckets, []);
});

test('BYTE-STABILITY: the frozen system append is byte-identical across consecutive renders (COMPOUNDING pin)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  const { createHash } = await import('node:crypto');
  const { renderClaudeAgentBrainSystemAppend, renderClaudeAgentBrainTurnContext } = await import('./claude-agent-brain.js');
  const { createSession } = await import('./eventlog.js');
  const sessionId = createSession({ id: 'byte-stability-pin', kind: 'chat', userId: 'user-1' }).id;
  const renderOnce = (message: string, candidates?: unknown): string => renderClaudeAgentBrainSystemAppend(
    'home',
    { message, sessionId, ...(candidates ? { turnCandidates: candidates } : {}) } as never,
    'full',
  );
  const first = renderOnce('find the top vendors and put them in a sheet');
  const turnCandidates = {
    candidates: [{
      identifier: 'CALENDAR_LIST_RECORDS',
      kind: 'fixture',
      intent: 'calendar.list',
      klass: 'capability_only',
      via: 'semantic',
      score: 0.9,
    }],
    matches: [],
    pinnedTools: [],
    requirements: [],
    semanticApplied: true,
  };
  const second = renderOnce('completely different message about calendars', turnCandidates);
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  assert.equal(sha(first), sha(second),
    'the stable prefix must not vary with the message or the per-turn candidate card — that variance re-bills the frozen memory block every turn');
  assert.doesNotMatch(second, /matched by meaning|proven for phrasing like this/,
    'the volatile candidate card no longer rides the stable region');
  const turnContext = await renderClaudeAgentBrainTurnContext({
    message: 'completely different message about calendars',
    sessionId,
    turnCandidates,
  } as never);
  assert.match(turnContext, /CALENDAR_LIST_RECORDS/,
    'moving the volatile card out of the stable prefix must not drop it from the model turn');
});

// ─── The meter must measure what is actually sent ────────────────────────────
//
// Measured 2026-08-25: prompt_composition reported 6,850 tokens while the wire
// carried 9,198 — off by 34% of its own figure, on the exact turn used to
// justify a prompt trim. Two causes, both pinned here: the codex call site
// passed neither tool schemas nor history (the measured components existed two
// lines up and were discarded), and instructions were scored wholly "stable"
// although everything after the cache-break sentinel is per-turn memory context
// carrying a minute-resolution clock.
test('measured tool and history tokens win over approximations', () => {
  const summary = summarizePromptComposition({
    instructions: 'be helpful',
    toolNames: ['a', 'b'],           // would approximate 2 x 120 = 240
    measuredToolSchemaTokens: 1939,  // the real serialized cost
    deferredToolIndexTokens: 581,
    measuredHistoryTokens: 800,
    currentMessage: 'hi',
  });
  const byName = new Map(summary.buckets.map((bucket) => [bucket.name, bucket]));
  assert.equal(byName.get('toolSchemas')?.tokens, 1939, 'measured schemas, not names x 120');
  assert.equal(byName.get('deferredToolIndex')?.tokens, 581);
  assert.equal(byName.get('deferredToolIndex')?.stability, 'stable', 'same catalog every turn');
  assert.equal(byName.get('history')?.tokens, 800);
});

test('instructions split at the cache sentinel: memory context is variable, not stable', () => {
  const staticPart = 'You are Clem. Standing rules here.';
  const memoryPart = 'Current time: 03:14. Recent facts: …';
  const summary = summarizePromptComposition({
    instructions: `${staticPart}${CACHE_BREAK_SENTINEL}${CACHE_MEMORY_CONTEXT_SENTINEL}${memoryPart}`,
    currentMessage: 'hi',
  });
  const byName = new Map(summary.buckets.map((bucket) => [bucket.name, bucket]));
  assert.equal(byName.get('instructions')?.stability, 'stable');
  assert.equal(byName.get('memoryContext')?.stability, 'variable',
    'the clock-bearing half must never inflate stableTokens');
  assert.ok((byName.get('memoryContext')?.tokens ?? 0) > 0);
  // Without the sentinel nothing changes shape — the whole text stays one
  // stable instructions bucket, so the Claude lane is unaffected.
  const plain = summarizePromptComposition({ instructions: staticPart, currentMessage: 'hi' });
  const plainNames = new Map(plain.buckets.map((bucket) => [bucket.name, bucket]));
  assert.equal(plainNames.get('memoryContext')?.tokens ?? 0, 0);
});


test('host composition measures the advertised projection: a deferLoading tool off the wire costs nothing', () => {
  const tools = [
    { type: 'function', name: 'tool_search', description: 'Search tools', parameters: { type: 'object' } },
    { type: 'function', name: 'call_tool', description: 'Call a tool', parameters: { type: 'object' } },
    { type: 'function', name: 'create', description: 'Create a record', parameters: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { title: { type: 'string' } } }, strict: true },
    { type: 'function', name: 'deferred', description: 'Find this later', parameters: { large: 'x'.repeat(10000) }, deferLoading: true },
  ];
  const before = structuredClone(tools);
  const surface = measureToolPromptSurface(tools);
  const summary = summarizePromptComposition({ instructions: 'Host instructions', ...surface });
  assert.equal(summary.toolCount, 3, 'nonzero schema cost must not be reported as zero advertised tools');
  assert.deepEqual(surface.toolNames, ['tool_search', 'call_tool', 'create']);
  assert.equal(surface.toolSchemaCosts.length, 4);
  assert.deepEqual(surface.toolSchemaCosts[3], { name: 'deferred', deferred: true, tokens: 0, bytes: 0 },
    'with both doors the deferred schema is not sent and bills nothing');
  assert.equal(surface.deferredToolIndexTokens, 0, 'nothing about a deferred tool is sent, so no index is billed');
  assert.equal(summary.buckets.some((bucket) => bucket.name === 'deferredToolIndex'), false);
  assert.equal(surface.measuredToolSchemaTokens, surface.toolSchemaCosts.slice(0, 3).reduce((sum, cost) => sum + cost.tokens, 0));
  const createRaw = Buffer.byteLength(JSON.stringify({ type: 'function', name: 'create', description: 'Create a record', parameters: tools[2]!.parameters, strict: true }));
  assert.ok(surface.toolSchemaCosts[2]!.bytes! < createRaw, 'schemas are measured on the compacted projection the runner sends');
  assert.deepEqual(tools, before);
  assert.equal('parameters' in surface.toolSchemaCosts[0]!, false, 'telemetry does not duplicate schema payloads');

  // Without the doors the runner advertises the deferred tool, so it is billed in full.
  const bare = measureToolPromptSurface([tools[2], tools[3]]);
  assert.deepEqual(bare.toolNames, ['create', 'deferred']);
  assert.ok(bare.toolSchemaCosts[1]!.bytes! > 10_000);
});

test('a runner-supplied wire is measured entry by entry as sent', () => {
  const wire = [
    { type: 'function', name: 'workspace_roots', description: 'Roots', parameters: { type: 'object', properties: {} }, strict: false },
    { type: 'function', name: 'retained', description: 'Retained after it was disabled', parameters: { type: 'object' }, strict: false, deferLoading: true },
  ];
  const surface = measureAdvertisedToolSurface(wire);
  assert.deepEqual(surface.toolNames, ['workspace_roots', 'retained'], 'every wire entry was sent, whatever its flags');
  assert.equal(surface.deferredToolIndexTokens, 0);
  assert.equal(surface.measuredToolSchemaTokens, surface.toolSchemaCosts.reduce((sum, cost) => sum + cost.tokens, 0));
});

test('memoryContext carries per-section sizes that add up to the rendered context', () => {
  const memory = [
    '# Persistent Context',
    'Loaded fresh each turn.',
    '## Now\n2026-09-26 03:14',
    '## Persistent Facts\n- prefers morning briefings\n- works with the fixture team',
    // A memory body's own heading stays inside the section that renders it.
    '## Long-Term Memory\nintro line',
    '## Projects\n- a body heading, not a section',
    '## Right Now\nlate evening',
  ].join('\n\n');
  const summary = summarizePromptComposition({
    instructions: `Standing rules.${CACHE_BREAK_SENTINEL}Turn rules.${CACHE_MEMORY_CONTEXT_DELIM}${memory}`,
  });
  const bucket = summary.buckets.find((entry) => entry.name === 'memoryContext');
  assert.ok(bucket?.sections, 'the memory bucket names its sections');
  assert.deepEqual(Object.keys(bucket!.sections!), ['(header)', 'Now', 'Persistent Facts', 'Long-Term Memory', 'Right Now']);
  const sectionBytes = Object.values(bucket!.sections!).reduce((sum, section) => sum + section.bytes, 0);
  assert.equal(sectionBytes, bucket!.bytes, 'section bytes add up to the memory context exactly');
  assert.ok(bucket!.sections!['Long-Term Memory']!.bytes > Buffer.byteLength('## Long-Term Memory\nintro line'),
    'a body heading does not open a section of its own');
  assert.equal(JSON.stringify(bucket!.sections).includes('prefers morning'), false, 'sizes only, never contents');
  assert.deepEqual(memoryContextSections('', ''), {});
});

test('every memory section the renderer titles is a section the meter recognises', () => {
  const source = readFileSync(new URL('../../agents/harness-context.ts', import.meta.url), 'utf8');
  const rendered = [...source.matchAll(/section\('([^']+)'/g)].map((match) => match[1]!);
  assert.ok(rendered.length >= 20, 'fixture: the renderer titles its sections');
  const known = new Set(MEMORY_CONTEXT_SECTION_TITLES);
  assert.deepEqual(rendered.filter((title) => !known.has(title)), []);
});

test('the appended per-round items are separate buckets and the ledger components come from the same summary', () => {
  const summary = summarizePromptComposition({
    instructions: `Standing rules.${CACHE_BREAK_SENTINEL}Turn rules.${CACHE_MEMORY_CONTEXT_SENTINEL}## Now\nclock`,
    measuredHistoryTokens: 400,
    contextPacket: 'packet text',
    memoryPrimer: 'primer text',
    provenOperation: 'proven text',
    retryContext: 'retry text',
    currentMessage: 'the question',
    measuredItemTokens: { contextPacket: 30, memoryPrimer: 40, provenOperation: 50, retryContext: 60, currentMessage: 70 },
    measuredToolSchemaTokens: 900,
  });
  const byName = new Map(summary.buckets.map((bucket) => [bucket.name, bucket]));
  assert.equal(byName.get('history')?.tokens, 400);
  assert.equal(byName.get('contextPacket')?.tokens, 30, 'measured item tokens win over the text estimate');
  assert.equal(byName.get('memoryPrimer')?.tokens, 40);
  assert.equal(byName.get('provenOperation')?.tokens, 50);
  assert.equal(byName.get('retryContext')?.tokens, 60);
  assert.equal(byName.get('currentMessage')?.tokens, 70);
  assert.ok(byName.get('memoryPrimer')?.sha256, 'the text still supplies bytes and a digest');
  const components = promptComponentsFromComposition(summary);
  assert.equal(Object.values(components).reduce((sum, value) => sum + value, 0), summary.totalTokens,
    'ledger components and the composition total are one reading');
  for (const key of ['instructions', 'turnContext', 'memoryContext', 'toolSchemas', 'history', 'contextPacket',
    'memoryPrimer', 'provenOperation', 'retryContext', 'currentMessage']) {
    assert.ok(components[key]! > 0, `ledger keeps the ${key} key`);
  }
});

test('the memory core is its own STABLE bucket, split from the rubric and sized by section', async () => {
  const { CACHE_MEMORY_CORE_DELIM } = await import('./model-wire-registry.js');
  const core = '# Persistent Context\n\nheader\n\n## Autonomy\nposture\n\n## Standing Policies\n- rule';
  const summary = summarizePromptComposition({
    instructions: `Rubric.${CACHE_MEMORY_CORE_DELIM}${core}${CACHE_BREAK_SENTINEL}Turn.${CACHE_MEMORY_CONTEXT_DELIM}## Right Now\nclock`,
  });
  const byName = new Map(summary.buckets.map((bucket) => [bucket.name, bucket]));
  assert.equal(byName.get('instructions')?.bytes, Buffer.byteLength('Rubric.'), 'the rubric bucket is the rubric alone');
  assert.equal(byName.get('memoryCore')?.stability, 'stable');
  assert.equal(byName.get('memoryCore')?.bytes, Buffer.byteLength(core));
  assert.deepEqual(Object.keys(byName.get('memoryCore')!.sections!), ['(header)', 'Autonomy', 'Standing Policies']);
  assert.equal(byName.get('memoryContext')?.stability, 'variable');
});

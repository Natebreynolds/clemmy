/**
 * Run: npx tsx --test src/runtime/harness/compaction.test.ts
 *
 * Covers the v0.5.10 auto-compact behavior:
 *   - clipOldToolResults keeps recent N turns verbatim, mutates older
 *     function_call_result items structurally (preserves callId, sets
 *     __clipped marker)
 *   - validateCallIdReferences sanitizes hallucinated ids
 *   - estimateInputTokens returns deterministic counts and grows with
 *     content
 *   - The tool_outputs table round-trips full 200KB writes losslessly
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-compaction-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
// Disable LLM-driven Layer 2 across tests so we never make a real
// network call. Layer 1 + recall round-trip don't need the summarizer.
process.env.CLEMMY_AUTO_COMPACT = 'layer1_only';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentInputItem } from '@openai/agents';

const { resetEventLog, closeEventLog, createSession, writeToolOutput, getToolOutput, TOOL_OUTPUT_MAX_BYTES } = await import('./eventlog.js');
const { inFlightCompactionThresholds } = await import('./compaction.js');
const {
  clipOldToolResults,
  collapseOldCompletedToolPairs,
  compactInFlightToolContext,
  compactSessionIfNeeded,
  summarizeOlderMessages,
  validateCallIdReferences,
  checkpointGoalStage,
  _setCompactionSummarizerForTests,
} = await import('./compaction.js');
const { estimateInputTokens } = await import('./token-estimator.js');
const { HarnessSession } = await import('./session.js');

function userMessage(text: string): AgentInputItem {
  return { role: 'user', content: text } as unknown as AgentInputItem;
}

function assistantMessage(text: string): AgentInputItem {
  return { role: 'assistant', content: text } as unknown as AgentInputItem;
}

function systemMessage(text: string): AgentInputItem {
  return { role: 'system', content: text } as unknown as AgentInputItem;
}

function toolCall(callId: string, name: string, args = '{}'): AgentInputItem {
  return {
    type: 'function_call',
    id: `fc-${callId}`,
    callId,
    name,
    arguments: args,
    status: 'completed',
  } as unknown as AgentInputItem;
}

function toolResult(callId: string, text: string): AgentInputItem {
  return {
    type: 'function_call_result',
    id: `fcr-${callId}`,
    callId,
    output: { type: 'text', text },
    status: 'completed',
  } as unknown as AgentInputItem;
}

test('clipOldToolResults — leaves last N turns untouched', () => {
  // Build 10 turns. Each turn: user message + tool_call + tool_result.
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 10; i++) {
    items.push(userMessage(`turn ${i} ask`));
    items.push(toolCall(`call_${i}`, 'gmail.list', '{"label":"inbox"}'));
    items.push(toolResult(`call_${i}`, 'a'.repeat(2000)));
  }

  const clipped = clipOldToolResults(items, 3);
  // Last 3 turns must stay verbatim. Earlier 7 turns get clipped.
  assert.equal(clipped, 7);

  const findResult = (callId: string) =>
    items.find(
      (it) =>
        (it as Record<string, unknown>).type === 'function_call_result' &&
        (it as Record<string, unknown>).callId === callId,
    ) as Record<string, unknown> | undefined;

  // The latest 3 tool_results must still contain the original text.
  for (let i = 7; i < 10; i++) {
    const r = findResult(`call_${i}`);
    assert.ok(r);
    const output = r!.output as { text: string };
    assert.equal(output.text.length, 2000);
    assert.equal(r!.__clipped, undefined);
  }

  // The earliest tool_result should now be a stub referencing recall_tool_result.
  const first = findResult('call_0');
  assert.ok(first);
  const stub = (first!.output as { text: string }).text;
  assert.match(stub, /^\[clipped:/);
  assert.match(stub, /recall_tool_result \{"call_id":"call_0"\}/);
  assert.equal(first!.__clipped, true);
});

test('clipOldToolResults — idempotent on already-clipped items', () => {
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 6; i++) {
    items.push(userMessage(`turn ${i}`));
    items.push(toolCall(`call_${i}`, 'gmail.list'));
    items.push(toolResult(`call_${i}`, 'b'.repeat(2000)));
  }
  const first = clipOldToolResults(items, 2); // clips turns 0..3 → 4 results
  const second = clipOldToolResults(items, 2);
  assert.equal(first, 4);
  assert.equal(second, 0, 'second pass should clip nothing');
});

test('clipOldToolResults — skips small outputs that wouldn\'t benefit', () => {
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 5; i++) {
    items.push(userMessage(`t${i}`));
    items.push(toolCall(`call_${i}`, 'short'));
    items.push(toolResult(`call_${i}`, 'tiny')); // <400 char threshold
  }
  const clipped = clipOldToolResults(items, 1);
  assert.equal(clipped, 0, 'small outputs should be left alone');
});

test('clipOldToolResults — never clips a host disposition, however old or long', () => {
  // A pre-dispatch refusal / host-settled verdict is a few hundred bytes the
  // model must keep reading verbatim, and the frame provenance guards most
  // tightly (live 2026-09-05: two clipped refusals killed every resume).
  const disposition = JSON.stringify({
    protocol: 'host_tool_disposition_v1', disposition: 'refused_pre_dispatch', frameDigest: 'f'.repeat(64),
    frameIndex: 0, frameSize: 1, effect: 'none', retry: 'replan', requiresReconciliation: false,
    message: 'This call was refused before execution. No effect occurred; correct the call or choose another capability.',
    diagnostic: JSON.stringify({ error: 'work_cardinality_mismatch', detail: 'x'.repeat(600) }),
  });
  assert.ok(disposition.length >= 400, 'the fixture must be clip-eligible by size');
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 8; i++) {
    items.push(userMessage(`t${i}`));
    items.push(toolCall(`call_${i}`, 'work_call'));
    items.push(toolResult(`call_${i}`, i === 0 ? disposition : 'y'.repeat(900)));
  }
  const clipped = clipOldToolResults(items, 1);
  const first = items[2] as unknown as Record<string, unknown>;
  assert.equal(first.__clipped, undefined, 'the host disposition stays verbatim');
  assert.ok(clipped >= 1, 'ordinary old results are still clipped');
});

test('clipOldToolResults — leaves structured projections exact for receipt verification', () => {
  const structured = {
    type: 'function_call_result',
    callId: 'structured-old',
    name: 'records.lookup',
    status: 'completed',
    output: {
      type: 'text',
      text: 'x'.repeat(1200),
      structuredContent: { records: [{ id: 'row-1' }] },
    },
  } as unknown as AgentInputItem;
  const recent = {
    type: 'function_call_result',
    callId: 'recent',
    name: 'records.lookup',
    status: 'completed',
    output: { type: 'text', text: 'recent' },
  } as unknown as AgentInputItem;

  assert.equal(clipOldToolResults([structured, recent], 1), 0);
  assert.equal((structured as unknown as Record<string, unknown>).__clipped, undefined);
  assert.equal(
    ((structured as unknown as { output: { text: string } }).output.text).length,
    1200,
    'Layer 1 cannot destroy structured fields it cannot reconstruct from the lossless text row',
  );
});

test('clipOldToolResults — preserves callId pairing (no Codex 400 risk)', () => {
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 6; i++) {
    items.push(userMessage(`t${i}`));
    items.push(toolCall(`call_${i}`, 'tool'));
    items.push(toolResult(`call_${i}`, 'x'.repeat(1500)));
  }
  clipOldToolResults(items, 1);
  // Walk pairs: every function_call must have a matching function_call_result.
  const callIds = new Set<string>();
  for (const item of items) {
    const any = item as Record<string, unknown>;
    if (any.type === 'function_call') callIds.add(String(any.callId));
  }
  for (const id of callIds) {
    const hasResult = items.some(
      (it) => (it as Record<string, unknown>).type === 'function_call_result' && (it as Record<string, unknown>).callId === id,
    );
    assert.ok(hasResult, `result missing for ${id} after clipping`);
  }
});

test('collapseOldCompletedToolPairs — removes old recallable pairs and keeps the recent tail paired', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 10; i++) {
    const callId = `call_${i}`;
    items.push(userMessage(`turn ${i}`));
    items.push(toolCall(callId, 'seo.audit', `{"site":"https://example-${i}.com"}`));
    items.push(toolResult(callId, `important result ${i} ${'x'.repeat(1200)}`));
    writeToolOutput({ sessionId: sess.id, callId, tool: 'seo.audit', output: `important result ${i} ${'x'.repeat(1200)}` });
  }

  const collapsed = collapseOldCompletedToolPairs(items, 3, sess.id);
  assert.equal(collapsed.collapsed, 7);
  assert.equal(collapsed.callIds[0], 'call_0');
  assert.equal(collapsed.callIds.at(-1), 'call_6');

  const summary = collapsed.nextItems.find((it) => {
    const any = it as Record<string, unknown>;
    return any.role === 'system' && typeof any.content === 'string' && any.content.startsWith('[summary of older completed tool activity]');
  }) as Record<string, unknown> | undefined;
  assert.ok(summary, 'collapsed history should include a summary message');
  assert.match(String(summary.content), /recall_tool_result \{"call_id":"call_0"\}/);
  assert.match(String(summary.content), /https:\/\/example-0\.com/);

  const remainingCallIds = new Set<string>();
  const remainingOutputIds = new Set<string>();
  for (const item of collapsed.nextItems) {
    const any = item as Record<string, unknown>;
    if (any.type === 'function_call') remainingCallIds.add(String(any.callId));
    if (any.type === 'function_call_result') remainingOutputIds.add(String(any.callId));
  }

  for (let i = 0; i < 7; i++) {
    assert.equal(remainingCallIds.has(`call_${i}`), false, `old call_${i} should be collapsed`);
    assert.equal(remainingOutputIds.has(`call_${i}`), false, `old output call_${i} should be collapsed`);
  }
  for (let i = 7; i < 10; i++) {
    assert.equal(remainingCallIds.has(`call_${i}`), true, `recent call_${i} should remain`);
    assert.equal(remainingOutputIds.has(`call_${i}`), true, `recent output call_${i} should remain`);
  }
});

test('collapseOldCompletedToolPairs — skips old pairs that are not recallable in tool_outputs', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 5; i++) {
    const callId = `call_${i}`;
    items.push(userMessage(`turn ${i}`));
    items.push(toolCall(callId, 'tool'));
    items.push(toolResult(callId, `result ${i}`));
  }
  writeToolOutput({ sessionId: sess.id, callId: 'call_0', tool: 'tool', output: 'result 0' });

  const collapsed = collapseOldCompletedToolPairs(items, 1, sess.id);
  assert.equal(collapsed.collapsed, 1, 'only recallable old pair should collapse');

  const remainingCallIds = new Set(
    collapsed.nextItems
      .filter((it) => (it as Record<string, unknown>).type === 'function_call')
      .map((it) => String((it as Record<string, unknown>).callId)),
  );
  assert.equal(remainingCallIds.has('call_0'), false);
  assert.equal(remainingCallIds.has('call_1'), true, 'unrecallable old pair should stay verbatim');
});

test('inFlightCompactionThresholds — absolute on a non-caching wire, env overrides win', () => {
  // 2026-09-01: window-scaled thresholds (×5 on a 1M window) meant a 27-read
  // step never compacted mid-turn and composed 58k-token prompts. That fix is
  // preserved exactly for every wire without a prompt cache — including an
  // unknown/absent id, which resolves to the registry's conservative default.
  assert.deepEqual(inFlightCompactionThresholds(() => undefined), {
    resultTriggerTokens: 32_000,
    retainedResultBudgetTokens: 20_000,
    minRetainPairs: 3,
    maxRetainPairs: 8,
  });
  const env: Record<string, string> = {
    CLEMMY_INFLIGHT_RESULT_TRIGGER_TOKENS: '1000',
    CLEMMY_INFLIGHT_RESULT_BUDGET_TOKENS: '600',
    CLEMMY_INFLIGHT_MIN_RETAIN_PAIRS: '1',
    CLEMMY_INFLIGHT_MAX_RETAIN_PAIRS: '2',
  };
  assert.deepEqual(inFlightCompactionThresholds((key) => env[key]), {
    resultTriggerTokens: 1000,
    retainedResultBudgetTokens: 600,
    minRetainPairs: 1,
    maxRetainPairs: 2,
  });
  // Garbage or non-positive overrides fall back to the defaults.
  assert.equal(inFlightCompactionThresholds((key) => (key === 'CLEMMY_INFLIGHT_RESULT_TRIGGER_TOKENS' ? '-5' : 'x')).resultTriggerTokens, 32_000);
});

test('inFlightCompactionThresholds — a caching wire scales, a non-caching wire does not', async () => {
  const { inFlightPromptCacheScale } = await import('./compaction.js');

  // The 2026-09-01 regression was measured on these. They must not move.
  for (const id of ['grok-4.6', 'glm-5.2', 'gpt-5.6', 'kimi-k3']) {
    assert.equal(inFlightPromptCacheScale(id), 1, `${id} caches nothing — stay absolute`);
    assert.deepEqual(inFlightCompactionThresholds(() => undefined, id), {
      resultTriggerTokens: 32_000,
      retainedResultBudgetTokens: 20_000,
      minRetainPairs: 3,
      maxRetainPairs: 8,
    }, `${id} must keep the absolute thresholds byte-identically`);
  }

  // Sonnet 5 caches from 2048 tokens on a 1M window. Collapsing its prefix
  // rewrites what the provider already cached: live 2026-09-03 the collapse
  // took uncached input from 5,160 to 35,529 on the very next call.
  const sonnet = inFlightCompactionThresholds(() => undefined, 'claude-sonnet-5');
  assert.ok(inFlightPromptCacheScale('claude-sonnet-5') > 1, 'a caching wire scales');
  assert.ok(
    sonnet.resultTriggerTokens > 32_000,
    `a cached prefix is not cheaper to rebuild (got ${sonnet.resultTriggerTokens})`,
  );
  // Retain pairs are counts, not token budgets — they never scale.
  assert.equal(sonnet.minRetainPairs, 3);
  assert.equal(sonnet.maxRetainPairs, 8);

  // An explicit operator override still wins on every wire.
  assert.equal(
    inFlightCompactionThresholds(
      (key) => (key === 'CLEMMY_INFLIGHT_RESULT_TRIGGER_TOKENS' ? '9000' : undefined),
      'claude-sonnet-5',
    ).resultTriggerTokens,
    9000,
  );
});

test('compactInFlightToolContext — preserves all identical observations below the pressure threshold', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const payload = `stable-result::${'r'.repeat(700)}`;
  const items: AgentInputItem[] = [userMessage('read twelve stable partitions')];
  const callIds: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    const callId = `stable_${index + 1}`;
    callIds.push(callId);
    items.push(toolCall(callId, 'partition.read', JSON.stringify({ partition: index + 1 })));
    items.push(toolResult(callId, payload));
    writeToolOutput({ sessionId: sess.id, callId, tool: 'partition.read', output: payload });
  }

  const compacted = compactInFlightToolContext(items, sess.id);
  const visible = JSON.stringify(compacted.nextItems);
  assert.equal(compacted.applied, false);
  assert.equal(compacted.nextItems, items, 'no model-facing history rewrite without pressure');
  assert.equal(visible.split(payload).length - 1, 12, 'each observation retains its own result');
  assert.ok(callIds.every((callId) => visible.includes(callId)), 'every completed call remains visible');
  assert.ok(callIds.every((callId) => getToolOutput(sess.id, callId)?.output === payload));

  const original = JSON.stringify(items);
  const pressure = compactInFlightToolContext(items, sess.id, {
    resultTriggerTokens: 1_000, retainedResultBudgetTokens: 1_000,
    minRetainPairs: 1, maxRetainPairs: 1,
  });
  assert.ok(pressure.resultTokensBefore > pressure.triggerTokens);
  assert.equal(pressure.applied, true);
  assert.deepEqual(pressure.callIds, callIds.slice(0, -1));
  assert.equal(pressure.retainedPairs, 1);
  const projected = JSON.stringify(pressure.nextItems);
  assert.ok(Buffer.byteLength(projected, 'utf8') <= 6_000, String(Buffer.byteLength(projected, 'utf8')));
  const summary = pressure.nextItems.find(item => {
    const row = item as Record<string, unknown>;
    return row.role === 'system' && typeof row.content === 'string'
      && row.content.startsWith('[summary of older completed tool activity]');
  }) as { content: string } | undefined;
  assert.ok(summary);
  const exactRecallIds = [...summary.content.matchAll(/recall_tool_result (\{[^}]+\})/g)]
    .map(match => JSON.parse(match[1]!).call_id)
    .filter(callId => callId !== '<call id>');
  assert.deepEqual(exactRecallIds, callIds.slice(0, -1), 'each parked result keeps one exact callable recall address');
  assert.ok(callIds.every(callId => getToolOutput(sess.id, callId)?.output === payload));
  assert.deepEqual(pressure.nextItems.slice(-2), items.slice(-2), 'the newest call/result pair stays verbatim');
  assert.equal(JSON.stringify(items), original, 'projection changes no canonical source bytes');
  const { inspectConversationProtocol } = await import('./conversation-protocol.js');
  assert.equal(inspectConversationProtocol(pressure.nextItems).status, 'valid');
});

test('a new workflow read stays after its accepted update request even when an older turn returned identical bytes', async () => {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat', title: 'workflow update chronology' });
  const payload = 'Workflow: fixture-workflow\nDescription: Initial.\nTrigger: manual only\n'
    + 'native_literal: {"version":1,"expression":{"op":"literal","value":"Initial."}}\n'
    + 'Preserved settings: ' + 's'.repeat(650);
  const innerArgs = JSON.stringify({ name: 'fixture-workflow', section: 'full' });
  const items = [
    userMessage('Create fixture-workflow, then read its saved definition.'),
    toolCall('old-read', 'workflow_get', innerArgs), toolResult('old-read', payload),
    assistantMessage('Created and verified the initial definition.'),
    userMessage('Now update fixture-workflow. Read its saved definition first, then change its literal.'),
    assistantMessage('Now let me read the current definition via call_tool.'),
    toolCall('fresh-read', 'call_tool', JSON.stringify({ name: 'workflow_get', args_json: innerArgs })),
    toolResult('fresh-read', payload),
  ];
  for (const callId of ['old-read', 'fresh-read']) {
    writeToolOutput({ sessionId: session.id, callId, tool: 'workflow_get', output: payload });
  }
  session.updateConversationSnapshot(items);
  const before = JSON.stringify(items);
  const result = compactInFlightToolContext(items, session.id, { resultTriggerTokens: 128_000 });
  assert.equal(result.applied, false);
  assert.equal(result.nextItems, items, 'the current call/result pair must not become a system duplicate ledger');
  assert.equal(JSON.stringify(result.nextItems), before);
  assert.deepEqual(result.nextItems.slice(-2), items.slice(-2), 'the latest observation stays after the pre-read assistant message');
  const { inspectConversationProtocol } = await import('./conversation-protocol.js');
  assert.equal(inspectConversationProtocol(result.nextItems).status, 'valid');
  closeEventLog();
  const reopened = HarnessSession.load(session.id)!.toInputItems();
  assert.equal(JSON.stringify(reopened), before, 'restart retains both observations and the intervening user request');
  assert.equal(compactInFlightToolContext(reopened, session.id, { resultTriggerTokens: 128_000 }).nextItems, reopened);
  assert.equal(getToolOutput(session.id, 'fresh-read')?.output, payload);
});

test('compactInFlightToolContext — equal visible stubs never deduplicate distinct durable raw outputs', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const visibleStub = '[clipped: partition.read — exact output remains recallable]';
  const items: AgentInputItem[] = [];
  for (let index = 0; index < 3; index += 1) {
    const callId = `distinct_${index + 1}`;
    items.push(toolCall(callId, 'partition.read', JSON.stringify({ partition: index + 1 })));
    items.push(toolResult(callId, visibleStub));
    writeToolOutput({
      sessionId: sess.id,
      callId,
      tool: 'partition.read',
      output: `different-raw-${index + 1}::${String.fromCharCode(65 + index).repeat(900)}`,
    });
  }

  const compacted = compactInFlightToolContext(items, sess.id);
  assert.equal(compacted.applied, false);
  assert.equal(compacted.nextItems, items);
});

test('collapseOldCompletedToolPairs — reserves a complete call-id index even when detail prose hits its cap', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const items: AgentInputItem[] = [];
  const collapsedIds: string[] = [];
  for (let index = 0; index < 84; index += 1) {
    const callId = `indexed_${String(index + 1).padStart(2, '0')}`;
    collapsedIds.push(callId);
    const output = `unique-${index}::${String.fromCharCode(65 + (index % 26)).repeat(900)}`;
    items.push(toolCall(callId, 'evidence.read', JSON.stringify({ index })));
    items.push(toolResult(callId, output));
    writeToolOutput({ sessionId: sess.id, callId, tool: 'evidence.read', output });
  }

  const collapsed = collapseOldCompletedToolPairs(items, 1, sess.id);
  const visible = JSON.stringify(collapsed.nextItems);
  assert.equal(collapsed.collapsed, 83);
  assert.ok(collapsedIds.slice(0, -1).every((callId) => visible.includes(callId)));
  assert.match(visible, /complete collapsed call-id index JSON/);
});

test('compactInFlightToolContext — bounds same-turn results without mutating durable history', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const items: AgentInputItem[] = [userMessage('research all ten targets')];
  for (let i = 0; i < 10; i++) {
    const callId = `flight_${i}`;
    const output = `target ${i} ${'r'.repeat(4000)}`;
    items.push(toolCall(callId, 'research.target', `{"target":${i}}`));
    items.push(toolResult(callId, output));
    writeToolOutput({ sessionId: sess.id, callId, tool: 'research.target', output });
  }
  const originalJson = JSON.stringify(items);

  const result = compactInFlightToolContext(items, sess.id, {
    resultTriggerTokens: 1_000,
    retainedResultBudgetTokens: 2_000,
    minRetainPairs: 2,
    maxRetainPairs: 4,
  });

  assert.equal(result.applied, true);
  assert.equal(result.retainedPairs, 2, 'the minimum recent working set survives even when it exceeds the soft budget');
  assert.equal(result.collapsed, 8);
  assert.ok(result.afterTokens < result.beforeTokens);
  assert.equal(JSON.stringify(items), originalJson, 'model-only compaction must not mutate durable Runner history');

  const filteredJson = JSON.stringify(result.nextItems);
  assert.match(filteredJson, /summary of older completed tool activity/);
  const summary = result.nextItems.find((item) =>
    (item as { role?: unknown }).role === 'system'
    && typeof (item as { content?: unknown }).content === 'string',
  ) as { content: string } | undefined;
  assert.match(summary?.content ?? '', /recall_tool_result \{"call_id":"flight_0"\}/);
  assert.doesNotMatch(filteredJson, /"callId":"flight_0"/);
  assert.match(filteredJson, /"callId":"flight_8"/);
  assert.match(filteredJson, /"callId":"flight_9"/);
});

test('compactSessionIfNeeded — applies pair collapse during layer 1 preflight', async () => {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat', title: 'collapse test' });
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 16; i++) {
    const callId = `call_${i}`;
    items.push(userMessage(`turn ${i}`));
    items.push(toolCall(callId, 'scrape.site', `{"url":"https://site-${i}.test"}`));
    items.push(toolResult(callId, `site ${i} result ${'z'.repeat(1000)}`));
    writeToolOutput({ sessionId: session.id, callId, tool: 'scrape.site', output: `site ${i} result ${'z'.repeat(1000)}` });
  }
  session.updateConversationSnapshot(items);

  const { result, nextItems } = await compactSessionIfNeeded(session, items, {
    disable: 'layer1_only',
    layer1ItemThreshold: 1,
    // This test exercises pair-collapse, so force the item-count trigger
    // regardless of token headroom (the new headroom guard would otherwise
    // hold off Layer-1 at these tiny token counts).
    layer1ItemTriggerMinFraction: 0,
    layer1RetainToolPairs: 4,
  });

  assert.equal(result.modified, true);
  assert.equal(result.layer1.collapsedToolPairs, 12);
  assert.ok(result.afterTokens < result.beforeTokens, 'collapsed preflight should reduce estimated tokens');
  const oldPairs = nextItems.filter((it) => {
    const any = it as Record<string, unknown>;
    return (any.type === 'function_call' || any.type === 'function_call_result') && String(any.callId).startsWith('call_0');
  });
  assert.equal(oldPairs.length, 0, 'oldest completed pair should no longer be replayed');
});

test('validateCallIdReferences — sanitizes hallucinated ids', () => {
  const valid = new Set(['call_abc', 'call_def']);
  const summary = 'Looked up [call_abc] and [call_xyz]. Then [call_def].';
  const { sanitized, referenced, hallucinated } = validateCallIdReferences(summary, valid);
  assert.equal(referenced.length, 2);
  assert.deepEqual(referenced.sort(), ['call_abc', 'call_def']);
  assert.equal(hallucinated.length, 1);
  assert.equal(hallucinated[0], 'call_xyz');
  assert.match(sanitized, /\[call_abc\]/);
  assert.match(sanitized, /\[invalid call_id\]/);
  assert.doesNotMatch(sanitized, /call_xyz/);
});

test('summarizeOlderMessages — preserves compaction summaries instead of re-summarizing recall maps', async () => {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat', title: 'l2 preserve compaction summaries' });
  let serializedOlder = '';
  _setCompactionSummarizerForTests(async (serialized) => {
    serializedOlder = serialized;
    return { summary: '- Assistant noted the draft still needed final review.', modelUsed: 'test-summarizer' };
  });

  try {
    const collapsedToolSummary = systemMessage([
      '[summary of older completed tool activity]',
      '1 older completed tool call/result pair was collapsed before this turn.',
      '- scrape.site [call_old] args: {"url":"https://example.test"}; result: ok [clipped: scrape.site collapsed before this turn - call recall_tool_result("call_old") for full output]',
    ].join('\n'));
    const priorLayer2Summary = systemMessage([
      '[summary of earlier conversation]',
      '- User approved the implementation direction.',
    ].join('\n'));
    const items = [
      userMessage('original request'),
      collapsedToolSummary,
      assistantMessage('The draft still needs final review.'),
      priorLayer2Summary,
      userMessage('also check latency before shipping'),
      assistantMessage('recent answer kept in tail'),
      userMessage('tail request kept verbatim'),
    ];

    const result = await summarizeOlderMessages(items, session.id, 2);
    assert.equal(result.applied, true);
    assert.equal(result.modelUsed, 'test-summarizer');
    assert.match(serializedOlder, /draft still needs final review/);
    assert.doesNotMatch(serializedOlder, /summary of older completed tool activity/);
    assert.doesNotMatch(serializedOlder, /recall_tool_result.*call_old/);
    assert.doesNotMatch(serializedOlder, /summary of earlier conversation/);

    const contents = (result.mutatedItems ?? [])
      .map((item) => (item as Record<string, unknown>).content)
      .filter((content): content is string => typeof content === 'string');
    assert.ok(contents.includes((collapsedToolSummary as { content: string }).content));
    assert.ok(contents.includes((priorLayer2Summary as { content: string }).content));
    assert.deepEqual(contents.slice(0, 5), [
      'original request',
      (collapsedToolSummary as { content: string }).content,
      '[summary of earlier conversation]\n- Assistant noted the draft still needed final review.',
      (priorLayer2Summary as { content: string }).content,
      'also check latency before shipping',
    ]);
  } finally {
    _setCompactionSummarizerForTests(null);
  }
});

test('estimateInputTokens — grows with content', () => {
  const small = estimateInputTokens([userMessage('hi')]);
  const big = estimateInputTokens([userMessage('hi'.repeat(10_000))]);
  assert.ok(big > small * 100);
});

test('estimateInputTokens — counts tool args + results denser than text', () => {
  const text = estimateInputTokens([userMessage('a'.repeat(1000))]);
  const tool = estimateInputTokens([toolResult('c', 'a'.repeat(1000))]);
  assert.ok(tool > text, 'tool result with JSON multiplier should be more tokens than equivalent text');
});

test('tool_outputs table — round-trips 200KB losslessly', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const big = 'x'.repeat(200_000);
  writeToolOutput({ sessionId: sess.id, callId: 'call_big', tool: 'composio.outlook', output: big });
  const row = getToolOutput(sess.id, 'call_big');
  assert.ok(row);
  assert.equal(row.output.length, 200_000);
  assert.equal(row.contentBytes, 200_000);
  assert.equal(row.truncatedAtWrite, false);
});

test('tool_outputs — stores sub-boundary results inline and larger results in lossless chunks', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  // 300KB exceeded the OLD 200KB ceiling (tail-dropped); under the 2MB cap it is now kept whole.
  const big = 'y'.repeat(300_000);
  writeToolOutput({ sessionId: sess.id, callId: 'call_big300', tool: 'composio.big', output: big });
  const bigRow = getToolOutput(sess.id, 'call_big300');
  assert.ok(bigRow);
  assert.equal(bigRow.output.length, 300_000, 'sub-cap result stored in full — no tail loss');
  assert.equal(bigRow.truncatedAtWrite, false);
  // Beyond the inline boundary: ordered chunks retain the complete value.
  const oversized = 'y'.repeat(TOOL_OUTPUT_MAX_BYTES + 100_000);
  writeToolOutput({ sessionId: sess.id, callId: 'call_huge', tool: 'composio.huge', output: oversized });
  const row = getToolOutput(sess.id, 'call_huge');
  assert.ok(row);
  assert.equal(row.contentBytes, TOOL_OUTPUT_MAX_BYTES + 100_000, 'original byte count preserved on the row');
  assert.equal(row.truncatedAtWrite, false);
  assert.equal(row.output.length, TOOL_OUTPUT_MAX_BYTES + 100_000, 'stored payload reassembles losslessly');
});

test('tool_outputs — call_id is scoped per session (no cross-session leakage)', () => {
  resetEventLog();
  const a = createSession({ kind: 'chat' });
  const b = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: a.id, callId: 'call_shared', tool: 'gmail.list', output: 'A' });
  writeToolOutput({ sessionId: b.id, callId: 'call_shared', tool: 'gmail.list', output: 'B' });
  assert.equal(getToolOutput(a.id, 'call_shared')?.output, 'A');
  assert.equal(getToolOutput(b.id, 'call_shared')?.output, 'B');
});

// Cleanup
process.on('exit', () => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── D2: stage checkpoint ────────────────────────────────────────────────────

test('forceLayer2 triggers Layer 1 even with abundant token headroom (the stage-checkpoint lever)', async () => {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat', title: 'force test' });
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 16; i++) {
    const callId = `call_f${i}`;
    items.push(userMessage(`turn ${i}`));
    items.push(toolCall(callId, 'dataforseo.serp', `{"q":"q-${i}"}`));
    items.push(toolResult(callId, `serp ${i} ${'z'.repeat(1000)}`));
    writeToolOutput({ sessionId: session.id, callId, tool: 'dataforseo.serp', output: `serp ${i} ${'z'.repeat(1000)}` });
  }
  session.updateConversationSnapshot(items);
  // Big budget (no token pressure) — without force this is a no-op (proven by
  // the headroom test above). With force, Layer 1 runs and collapses old pairs.
  const { result } = await compactSessionIfNeeded(session, items, {
    inputBudgetTokens: 200_000, layer1ItemThreshold: 15, forceLayer2: true,
  });
  assert.ok(result.beforeTokens < 200_000 * 0.3, 'precondition: no token pressure');
  assert.equal(result.layer1.applied, true, 'force runs Layer 1 regardless of headroom');
  assert.equal(result.layer3.applied, false, 'Layer 3 fork is suppressed during a forced checkpoint');
});

test('a long idle gap preserves exact working history when the routed context has headroom', async () => {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat', title: 'idle continuity' });
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 28; i++) {
    const callId = `call_idle${i}`;
    const body = `Exact draft ${i}.\n${'z'.repeat(3000)}END_${i}!`;
    items.push(userMessage(`Keep draft ${i} for the next turn.`));
    items.push(toolCall(callId, 'draft.read', JSON.stringify({ id: `draft-${i}` })));
    items.push(toolResult(callId, body));
    writeToolOutput({ sessionId: session.id, callId, tool: 'draft.read', output: body });
  }
  session.updateConversationSnapshot(items);
  const before = JSON.stringify(items);
  const previousFlag = process.env.CLEMMY_AUTO_COMPACT;
  let summarizerCalls = 0;
  process.env.CLEMMY_AUTO_COMPACT = 'on';
  _setCompactionSummarizerForTests(async () => {
    summarizerCalls++;
    return { error: 'Idle time must not invoke a summarizer with free context.' };
  });
  try {
    const { result, nextItems, forkRequest } = await compactSessionIfNeeded(session, items, {
      inputBudgetTokens: 1_000_000, idleMs: 24 * 60 * 60 * 1000,
    });
    assert.ok(result.beforeTokens > 6000, 'exceeds the retired idle floor');
    assert.ok(result.beforeTokens < 1_000_000 * 0.3, 'has abundant routed-model headroom');
    assert.equal(result.modified, false);
    assert.equal(result.layer1.applied, false);
    assert.equal(result.layer2.applied, false);
    assert.equal(summarizerCalls, 0);
    assert.equal(forkRequest, undefined);
    assert.equal(JSON.stringify(nextItems), before, 'all exact content and tool call identities survive');
    assert.equal(JSON.stringify(items), before, 'the persisted snapshot input is not mutated');
    closeEventLog();
    assert.equal(JSON.stringify(HarnessSession.load(session.id)?.toInputItems()), before, 'exact working history survives reopening storage');
  } finally {
    if (previousFlag === undefined) delete process.env.CLEMMY_AUTO_COMPACT;
    else process.env.CLEMMY_AUTO_COMPACT = previousFlag;
    _setCompactionSummarizerForTests(null);
  }
});

test('compactSessionIfNeeded — idle does NOT fire on a short gap or a tiny session', async () => {
  resetEventLog();
  const big = (title: string) => {
    const s = HarnessSession.create({ kind: 'chat', title });
    const items: AgentInputItem[] = [];
    for (let i = 0; i < 16; i++) {
      const callId = `${title}_${i}`;
      items.push(userMessage(`turn ${i}`));
      items.push(toolCall(callId, 'dataforseo.serp', `{"q":"q-${i}"}`));
      items.push(toolResult(callId, `serp ${i} ${'z'.repeat(1000)}`));
    }
    s.updateConversationSnapshot(items);
    return { s, items };
  };
  // min 3000 so the ~4.5k fixture clears the floor — the gap / kill-switch gates
  // are what we're testing, not the size floor (which the tiny case covers).
  const base = { inputBudgetTokens: 200_000, layer1ItemThreshold: 15, idleCompactionThresholdMs: 30 * 60 * 1000, idleCompactionMinTokens: 3000 };

  // Short gap (10 min < 30 min) → no idle trigger.
  const a = big('short-gap');
  const ra = await compactSessionIfNeeded(a.s, a.items, { ...base, idleMs: 10 * 60 * 1000 });
  assert.equal(ra.result.layer1.applied, false, 'short idle gap → no idle compaction');

  // Long gap but a TINY session (under the token floor) → no idle trigger.
  const tiny = HarnessSession.create({ kind: 'chat', title: 'tiny-idle' });
  const tinyItems = [userMessage('hi there'), userMessage('how are you')];
  tiny.updateConversationSnapshot(tinyItems);
  const rt = await compactSessionIfNeeded(tiny, tinyItems, { ...base, idleMs: 60 * 60 * 1000 });
  assert.equal(rt.result.layer1.applied, false, 'idle but tiny → nothing to summarize');
});

test('checkpointGoalStage no-ops on a tiny session and when the kill-switch is off', async () => {
  resetEventLog();
  const tiny = HarnessSession.create({ kind: 'chat', title: 'tiny' });
  tiny.updateConversationSnapshot([userMessage('hi')]);
  assert.equal(await checkpointGoalStage(tiny), null, 'nothing worth checkpointing');

  const session = HarnessSession.create({ kind: 'chat', title: 'kill-switch' });
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 4; i++) { items.push(userMessage(`m${i}`)); items.push(userMessage(`a${i}`)); }
  session.updateConversationSnapshot(items);
  process.env.CLEMMY_STAGE_CHECKPOINT = 'off';
  try {
    assert.equal(await checkpointGoalStage(session), null, 'kill-switch makes it inert');
  } finally {
    delete process.env.CLEMMY_STAGE_CHECKPOINT;
  }
});

test('compactSessionIfNeeded — Layer 1 does NOT clip on item-count alone when there is token headroom', async () => {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat', title: 'headroom test' });
  const items: AgentInputItem[] = [];
  // 16 tool pairs, each result ~1KB → many items but tiny total tokens.
  for (let i = 0; i < 16; i++) {
    const callId = `call_h${i}`;
    items.push(userMessage(`turn ${i}`));
    items.push(toolCall(callId, 'dataforseo.serp', `{"q":"q-${i}"}`));
    items.push(toolResult(callId, `serp ${i} ${'z'.repeat(1000)}`));
    writeToolOutput({ sessionId: session.id, callId, tool: 'dataforseo.serp', output: `serp ${i} ${'z'.repeat(1000)}` });
  }
  session.updateConversationSnapshot(items);

  // Big budget, low real token usage: item count (48 > 15) would have triggered
  // the OLD unconditional clip. With the headroom guard it must NOT.
  const { result } = await compactSessionIfNeeded(session, items, {
    inputBudgetTokens: 200_000,
    layer1ItemThreshold: 15,
  });
  assert.ok(result.beforeTokens < 200_000 * 0.3, 'precondition: well under the token-pressure trigger');
  assert.equal(result.layer1.applied, false, 'no Layer-1 clip while there is abundant token headroom');
  assert.equal(result.modified, false);
});

test('compactSessionIfNeeded — Layer 1 STILL clips under genuine token pressure', async () => {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat', title: 'pressure test' });
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 16; i++) {
    const callId = `call_p${i}`;
    items.push(userMessage(`turn ${i}`));
    items.push(toolCall(callId, 'dataforseo.serp', `{"q":"q-${i}"}`));
    items.push(toolResult(callId, `serp ${i} ${'z'.repeat(1000)}`));
    writeToolOutput({ sessionId: session.id, callId, tool: 'dataforseo.serp', output: `serp ${i} ${'z'.repeat(1000)}` });
  }
  session.updateConversationSnapshot(items);

  // Tiny budget → the same content is now PAST the token-pressure trigger.
  const { result } = await compactSessionIfNeeded(session, items, {
    inputBudgetTokens: 1_000,
    layer1ItemThreshold: 15,
  });
  assert.ok(result.beforeTokens > 1_000 * 0.3, 'precondition: past the token-pressure trigger');
  assert.equal(result.layer1.applied, true, 'real token pressure still triggers Layer-1');
});

test('compactionBudgetForModel: budget tracks the ROUTED model window, never a fixed 200K', async () => {
  // REGRESSION PIN (2026-08-05): with a hard-coded 200K budget, Layer 3's fork
  // threshold (90% → 180K tokens) sat ABOVE a 128K-window BYO model's real
  // capacity — the provider overflowed before the safety net fired — while
  // large-window models clipped verbatim history at a fraction of their real
  // headroom. The budget must come from the wire registry's contextWindow.
  const { compactionBudgetForModel } = await import('./compaction.js');
  const { resolveModelCapability } = await import('./model-wire-registry.js');

  // LIVE-VERIFIED windows (2026-08-05): Together/Moonshot /v1/models report
  // context_length; gpt-5.6 was probed against the Responses API (accept at
  // 880,007 input tokens, reject at 882,007); gpt-5.4 live-rejected 280K,
  // confirming the documented 272K input cap; Claude Opus 4.8 / Sonnet 5 are
  // 1M per the platform docs. Budget = the real window, so Layer 3 always
  // forks INSIDE it and large-window models stop compacting at a fraction of
  // their capacity.
  assert.equal(compactionBudgetForModel('glm-4.7'), 202_752);
  assert.ok(compactionBudgetForModel('glm-4.7') * 0.9 < 202_752, 'fork fires inside the real window');
  assert.equal(compactionBudgetForModel('zai-org/GLM-5.2'), 512_000);
  // Bare `glm-5.2` is a DIFFERENT id owned by a different backend (exact-id
  // provider ownership) — it seeds from the conservative GLM family row until
  // its own provider's catalog/live evidence teaches its real window.
  assert.equal(compactionBudgetForModel('glm-5.2'), 202_752);
  assert.equal(compactionBudgetForModel('kimi-k3'), 1_048_576);
  assert.equal(compactionBudgetForModel('kimi-k2.6'), 262_144);
  assert.equal(compactionBudgetForModel('gpt-5.6-sol'), 880_000);
  assert.equal(compactionBudgetForModel('gpt-5.4'), 272_000);
  assert.equal(compactionBudgetForModel('claude-opus-4-8'), 1_000_000);
  assert.equal(compactionBudgetForModel('claude-sonnet-5'), 1_000_000);
  // Fable 5: not yet documented at 1M — held at 200K (over-stating overflows
  // the provider; under-stating only compacts early).
  assert.equal(compactionBudgetForModel('claude-fable-5'), 200_000);

  // Unknown wire: the registry's conservative default, never the old 200K
  // (which would overflow an unknown 128K-class backend).
  assert.equal(compactionBudgetForModel('totally-unknown-model'), resolveModelCapability('totally-unknown-model').contextWindow);
  assert.equal(compactionBudgetForModel(undefined), resolveModelCapability(undefined).contextWindow);
});

test('capSummarizerInput: the Layer-2 summarizer can never be fed more than its own window', async () => {
  // REGRESSION PIN (2026-08-05 deep-look): window-aware budgets let an
  // 880K/1M-budget session serialize MORE older history than the fast
  // summarizer model can read — the overflowing call would fail Layer 2 every
  // turn until the Layer 3 fork. The cap truncates from the HEAD (oldest),
  // keeps line boundaries, and STATES the omission.
  const { capSummarizerInput } = await import('./compaction.js');
  const { effectiveContextWindow } = await import('./model-window-observations.js');

  const line = `[TOOL_RESULT call_id=call_x] ${'r'.repeat(400)}`;
  const huge = Array.from({ length: 20_000 }, () => line).join('\n'); // ~8MB ≈ 2M tokens
  const capped = capSummarizerInput(huge, 'gpt-5.4');
  const budgetChars = Math.floor(effectiveContextWindow('gpt-5.4') * 4 * 0.6);
  assert.ok(capped.length <= budgetChars + 300, 'capped within the summarizer window budget (+note)');
  assert.match(capped, /oldest chars of this history were omitted/, 'omission is stated, never silent');
  assert.match(capped.split('\n')[1] ?? '', /^\[TOOL_RESULT/, 'kept text starts on a line boundary');

  const small = 'short history';
  assert.equal(capSummarizerInput(small, 'gpt-5.4'), small, 'under-budget input passes through byte-identical');
});

// REGRESSION PIN (live 2026-08-24, mobile canary seq 71391): two concurrent
// tool_search calls returned byte-identical bytes, duplicate-collapse fired,
// and the NEXT model step died with
//   run_failed: conversation protocol assertion failed at codex.responses
// even though both calls had crossed and settled cleanly. Cause: the collapse
// summary was inserted where the first collapsed item stood. In a PARALLEL
// frame (call, call, result, result) that position splits a still-open pair,
// leaving `call A | summary | result A` -> `conversation_advanced_with_open_call`.
// A sequential frame (call, result, call, result) never lands there, which is
// why the 12-pair gate passed while real fan-out failed.
//
// Parallel fan-out is exactly the shape long agentic work produces, so pin BOTH
// orderings under real pressure: older pairs collapse and the newest observation remains protocol-valid.
test('pressure collapse keeps parallel and sequential identical-result frames valid and retains the newest pair', async () => {
  const { inspectConversationProtocol } = await import('./conversation-protocol.js');
  const session = createSession({ id: 'dedup-parallel-frame', kind: 'chat' });
  const payload = `IDENTICAL::${'p'.repeat(400)}`;
  for (const callId of ['par-a', 'par-b']) {
    writeToolOutput({ sessionId: session.id, callId, tool: 'tool_search', output: payload });
  }

  // call, call, result, result — the frame a parallel model step emits.
  const parallel: AgentInputItem[] = [
    userMessage('Collect the same fact from two sources.'),
    toolCall('par-a', 'tool_search', '{"q":"a"}'),
    toolCall('par-b', 'tool_search', '{"q":"b"}'),
    toolResult('par-a', payload),
    toolResult('par-b', payload),
  ];
  assert.equal(inspectConversationProtocol(parallel).status, 'valid');

  const pressure = { resultTriggerTokens: 1, retainedResultBudgetTokens: 1, minRetainPairs: 1, maxRetainPairs: 1 };
  const collapsed = compactInFlightToolContext(parallel, session.id, pressure);
  assert.equal(collapsed.applied, true, 'real pressure collapses the older pair');
  assert.equal(collapsed.collapsed, 1);
  assert.deepEqual(collapsed.callIds, ['par-a']);
  assert.ok(collapsed.nextItems.includes(parallel[2]!));
  assert.ok(collapsed.nextItems.includes(parallel[4]!));
  assert.equal(getToolOutput(session.id, 'par-a')?.output, payload, 'the old observation remains fully recallable');
  const after = inspectConversationProtocol(collapsed.nextItems);
  assert.equal(
    after.status,
    'valid',
    `parallel frame must survive collapse: ${JSON.stringify(after.status === 'invalid' ? after.issues : [])}`,
  );

  // Sequential frames must keep working too — that is the shape the 12-pair
  // gate exercises, and the fix must not move the summary for it.
  for (const callId of ['seq-a', 'seq-b']) {
    writeToolOutput({ sessionId: session.id, callId, tool: 'tool_search', output: payload });
  }
  const sequential: AgentInputItem[] = [
    userMessage('Collect the same fact twice in a row.'),
    toolCall('seq-a', 'tool_search', '{"q":"a"}'),
    toolResult('seq-a', payload),
    toolCall('seq-b', 'tool_search', '{"q":"b"}'),
    toolResult('seq-b', payload),
  ];
  const seqCollapsed = compactInFlightToolContext(sequential, session.id, pressure);
  assert.equal(seqCollapsed.collapsed, 1);
  assert.deepEqual(seqCollapsed.callIds, ['seq-a']);
  assert.deepEqual(seqCollapsed.nextItems.slice(-2), sequential.slice(-2));
  assert.equal(inspectConversationProtocol(seqCollapsed.nextItems).status, 'valid');
});

test('Layer 2 preserves complete tool arguments and results outside its prose summarization', async () => {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat', title: 'complete summarizer context' });
  const argumentsJson = JSON.stringify({ body: 'a'.repeat(900), destination: 'EXACT_DESTINATION_AFTER_500' });
  const resultText = 'b'.repeat(7000) + '\nUNFINISHED_RECORD_AFTER_4000';
  let received = '';
  _setCompactionSummarizerForTests(async (text) => {
    received = text;
    return { summary: '- The returned record still needs review.', modelUsed: 'test-summarizer' };
  });
  try {
    const result = await summarizeOlderMessages([
      userMessage('Review the full result before continuing.'), assistantMessage('I will inspect it.'),
      toolCall('call_complete_input', 'test.read', argumentsJson), toolResult('call_complete_input', resultText),
      assistantMessage('The review is pending.'), userMessage('Continue later.'), assistantMessage('Ready.'),
    ], session.id, 2);
    assert.equal(result.applied, true);
    const keptCall = result.mutatedItems?.find(item => (item as { type?: string }).type === 'function_call') as { arguments?: string };
    const keptResult = result.mutatedItems?.find(item => (item as { type?: string }).type === 'function_call_result') as { output?: { text?: string } };
    assert.equal(keptCall.arguments, argumentsJson);
    assert.equal(keptResult.output?.text, resultText);
    assert.ok(!received.includes('TOOL_CALL'), 'exact tool state is retained rather than sent through prose compression');
  } finally { _setCompactionSummarizerForTests(null); }
});

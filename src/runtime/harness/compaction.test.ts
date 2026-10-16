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
import { createHash } from 'node:crypto';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-compaction-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
// Disable LLM-driven Layer 2 across tests so we never make a real
// network call. Layer 1 + recall round-trip don't need the summarizer.
process.env.CLEMMY_AUTO_COMPACT = 'layer1_only';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentInputItem } from '@openai/agents';

const { resetEventLog, closeEventLog, createSession, appendEvent, writeToolOutput, getToolOutput, TOOL_OUTPUT_MAX_BYTES } = await import('./eventlog.js');
const { inFlightCompactionThresholds } = await import('./compaction.js');
const {
  clipOldToolResults,
  collapseOldCompletedToolPairs,
  compactInFlightToolContext,
  compactInFlightToolContextStable,
  createInFlightCompactionState,
  refetchedWorkingSetCallIds,
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
    checkpointed: false,
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
    checkpointed: false,
  });
  // Garbage or non-positive overrides fall back to the defaults.
  assert.equal(inFlightCompactionThresholds((key) => (key === 'CLEMMY_INFLIGHT_RESULT_TRIGGER_TOKENS' ? '-5' : 'x')).resultTriggerTokens, 32_000);
});

test('inFlightCompactionThresholds — a caching wire scales, a non-caching wire does not', async () => {
  const { inFlightPromptCacheScale } = await import('./compaction.js');

  // The 2026-09-01 regression was measured on these. They must not move.
  //
  // grok WAS in this list and should never have been. It was seeded
  // non-caching on a 2026-08-20 note ("no server-side prompt cache contract we
  // can rely on") that was a judgement, not an observation — and this
  // machine's own usage log showed 673 of 690 grok calls reporting cache
  // reads, 3,457,024 cached of 11,449,913 input tokens, cacheDialect
  // 'inclusive' on every one. This test encoded the same wrong belief the
  // registry did, which is how a test keeps a measurable error alive. The
  // genuinely non-caching wires stay, and the 2026-09-01 first-byte timeout
  // they protect is untouched.
  for (const id of ['glm-5.2', 'kimi-k3']) {
    assert.equal(inFlightPromptCacheScale(id), 1, `${id} caches nothing — stay absolute`);
    assert.deepEqual(inFlightCompactionThresholds(() => undefined, id), {
      resultTriggerTokens: 32_000,
      retainedResultBudgetTokens: 20_000,
      minRetainPairs: 3,
      maxRetainPairs: 8,
      checkpointed: false,
    }, `${id} must keep the absolute thresholds byte-identically`);
  }

  // Automatic caching keeps the absolute budget but freezes checkpoint
  // prefixes. It does not need explicit provider cache markers to benefit.
  assert.equal(inFlightPromptCacheScale('gpt-5.6'), 1);
  assert.deepEqual(inFlightCompactionThresholds(() => undefined, 'gpt-5.6'), {
    resultTriggerTokens: 32_000,
    retainedResultBudgetTokens: 20_000,
    minRetainPairs: 3,
    maxRetainPairs: 8,
    checkpointed: true,
  });

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

test('inFlightCompactionThresholds — a seeded prompt-caching wire checkpoints and waits for real pressure', () => {
  // A 200k-window caching model scaled to 1 and so collapsed at the same 32k
  // as a wire with no cache at all, every frame, on a prompt the provider was
  // serving from cache.
  for (const id of ['claude-opus-5', 'claude-haiku-4-5']) {
    const thresholds = inFlightCompactionThresholds(() => undefined, id);
    assert.equal(thresholds.checkpointed, true, `${id} is seeded as caching`);
    assert.ok(thresholds.resultTriggerTokens >= 48_000, `${id} trigger ${thresholds.resultTriggerTokens}`);
    assert.equal(thresholds.retainedResultBudgetTokens, 20_000, 'the retained tail stays small, so each checkpoint removes far more than it re-sends');
  }
  const sonnet = inFlightCompactionThresholds(() => undefined, 'claude-sonnet-5');
  assert.equal(sonnet.checkpointed, true);
  assert.equal(sonnet.resultTriggerTokens, 128_000, 'a larger window keeps its larger scaled trigger');
  assert.equal(
    inFlightCompactionThresholds(
      (key) => (key === 'CLEMMY_INFLIGHT_RESULT_TRIGGER_TOKENS' ? '9000' : undefined),
      'claude-opus-5',
    ).resultTriggerTokens,
    9000,
    'an operator override still wins',
  );
});

function growingToolHistory(sessionId: string, label: string) {
  const history: AgentInputItem[] = [userMessage('rebuild the dashboard view')];
  return {
    history,
    add(i: number) {
      const callId = `${label}_${i}`;
      const output = `view ${i} ${'v'.repeat(3_000)}`;
      history.push(toolCall(callId, 'space_get_view', `{"i":${i}}`));
      history.push(toolResult(callId, output));
      writeToolOutput({ sessionId, callId, tool: 'space_get_view', output });
    },
  };
}

function framesThatRewrite(frames: string[][]): number {
  let rewrites = 0;
  for (let f = 1; f < frames.length; f++) {
    const previous = frames[f - 1]!;
    const next = frames[f]!;
    if (!previous.every((item, index) => next[index] === item)) rewrites += 1;
  }
  return rewrites;
}

test('compactInFlightToolContextStable — every frame extends the last except the one that takes a checkpoint', async () => {
  const { compactInFlightToolContextStable, createInFlightCompactionState } = await import('./compaction.js');
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const opts = { resultTriggerTokens: 3_000, retainedResultBudgetTokens: 1_500, minRetainPairs: 1, maxRetainPairs: 3 };

  const stable = growingToolHistory(sess.id, 'stable');
  const state = createInFlightCompactionState();
  const stableFrames: string[][] = [];
  let checkpoints = 0;
  for (let i = 0; i < 12; i++) {
    stable.add(i);
    const result = compactInFlightToolContextStable([...stable.history], state, sess.id, opts);
    if (result.checkpointCreated) checkpoints += 1;
    stableFrames.push(result.nextItems.map((item) => JSON.stringify(item)));
  }
  assert.ok(checkpoints >= 2, `pressure still collapses (${checkpoints} checkpoints)`);
  assert.equal(framesThatRewrite(stableFrames), checkpoints,
    'only a frame that takes a new checkpoint changes anything already sent');

  // The same growth through the sliding form rewrites its ledger on nearly
  // every frame once past the trigger.
  const sliding = growingToolHistory(sess.id, 'sliding');
  const slidingFrames: string[][] = [];
  for (let i = 0; i < 12; i++) {
    sliding.add(i);
    slidingFrames.push(compactInFlightToolContext([...sliding.history], sess.id, opts).nextItems
      .map((item) => JSON.stringify(item)));
  }
  assert.ok(framesThatRewrite(slidingFrames) > framesThatRewrite(stableFrames),
    `sliding ${framesThatRewrite(slidingFrames)} vs checkpointed ${framesThatRewrite(stableFrames)}`);
});

test('compactInFlightToolContextStable — a new checkpoint lands after the earlier ledger and leaves it untouched', async () => {
  const { compactInFlightToolContextStable, createInFlightCompactionState } = await import('./compaction.js');
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const opts = { resultTriggerTokens: 3_000, retainedResultBudgetTokens: 1_500, minRetainPairs: 1, maxRetainPairs: 3 };
  const growth = growingToolHistory(sess.id, 'ledger');
  const state = createInFlightCompactionState();
  let firstLedger: { index: number; bytes: string } | null = null;
  for (let i = 0; i < 12; i++) {
    growth.add(i);
    const result = compactInFlightToolContextStable([...growth.history], state, sess.id, opts);
    const ledgers = result.nextItems
      .map((item, index) => ({ index, bytes: JSON.stringify(item) }))
      .filter((entry) => entry.bytes.includes('summary of older completed tool activity'));
    if (!firstLedger && ledgers.length > 0) firstLedger = ledgers[0]!;
    if (firstLedger) {
      assert.deepEqual(ledgers[0], firstLedger, `frame ${i}: the first ledger never moves or changes`);
    }
  }
  assert.ok(state.checkpoints.length >= 2);

  // A history that does not contain a checkpoint's pairs drops it.
  const unrelated = compactInFlightToolContextStable([userMessage('a different run')], state, sess.id, opts);
  assert.equal(unrelated.applied, false);
  assert.equal(state.checkpoints.length, 0);
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

test('a mid-turn collapse keeps the schemas its searches found; a provider field of the same name and a between-turn collapse keep none', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const spaceSaveSchema = { type: 'object', properties: { slug: { type: 'string' }, view_html: { type: 'string' } }, required: ['slug'] };
  const page = (name: string, schema: unknown) => JSON.stringify({
    query: name,
    results: [{ name, summary: 's'.repeat(3000), carrier: 'work_call', capabilityRef: `cap:local:${name}:reversible` }],
    schemas: { [name]: schema },
  });
  const items: AgentInputItem[] = [userMessage('build the site workspace')];
  const add = (callId: string, name: string, output: string) => {
    items.push(toolCall(callId, name, '{}'));
    items.push(toolResult(callId, output));
    writeToolOutput({ sessionId: sess.id, callId, tool: name, output });
  };
  add('search_old', 'tool_search', page('space_save', { type: 'object', properties: { slug: { type: 'string' } } }));
  add('search_new', 'tool_search', page('space_save', spaceSaveSchema));
  add('forged', 'records.read', JSON.stringify({ schemas: { delete_everything: { type: 'object' } }, rows: 'r'.repeat(3000) }));
  for (let i = 0; i < 4; i++) add(`work_${i}`, 'space_get', `space ${i} ${'w'.repeat(3000)}`);

  const opts = { resultTriggerTokens: 1_000, retainedResultBudgetTokens: 1_000, minRetainPairs: 2, maxRetainPairs: 2 };
  const ledgerOf = (nextItems: AgentInputItem[]) => (nextItems.find((item) =>
    typeof (item as { content?: unknown }).content === 'string'
    && ((item as { content: string }).content).includes('summary of older completed tool activity'),
  ) as { content: string } | undefined)?.content ?? '';

  for (const result of [
    compactInFlightToolContext(items, sess.id, opts),
    compactInFlightToolContextStable(items, createInFlightCompactionState(), sess.id, opts),
  ]) {
    assert.equal(result.applied, true);
    const ledger = ledgerOf(result.nextItems);
    assert.match(ledger, /retained input schema disclosures/);
    assert.doesNotMatch(ledger, /still current for this turn/);
    assert.ok(
      ledger.includes(`- space_save (call with work_call, requirement_id cap:local:space_save:reversible): ${JSON.stringify(spaceSaveSchema)}`),
      'the newest disclosure of the schema is kept verbatim with how to call it',
    );
    assert.equal(ledger.split('- space_save (').length - 1, 1, 'one card per tool');
    assert.doesNotMatch(ledger, /^- delete_everything/m, 'a provider reply never becomes a schema card');
  }

  const betweenTurns = collapseOldCompletedToolPairs(items, 2, sess.id);
  assert.ok(betweenTurns.collapsed > 0);
  assert.doesNotMatch(ledgerOf(betweenTurns.nextItems), /retained input schema disclosures/);
});

test('a collapsed search keeps a full-size schema, names a schema reread by its handle, and points an oversized one at its reread cursor', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const bigProperties = (prefix: string, count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) =>
    [`${prefix}_${i}`, { type: 'string', description: `field ${i} ${'d'.repeat(120)}` }]));
  const workflowUpdate = { type: 'object', properties: bigProperties('w', 100) };
  const oversized = { type: 'object', properties: bigProperties('o', 200) };
  const planTask = { type: 'object', properties: { requirements: { type: 'array' } } };
  assert.ok(JSON.stringify(workflowUpdate).length > 13_000 && JSON.stringify(workflowUpdate).length < 20_000);
  assert.ok(JSON.stringify(oversized).length > 20_000);
  const ref = (schema: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`;
  const handle = (schema: unknown) => ({ schema_ref: ref(schema), cursor: `tool_search_schema:v1:${ref(schema).slice(7)}:0` });
  const items: AgentInputItem[] = [userMessage('update the workflow and plan it')];
  const add = (callId: string, name: string, output: string) => {
    items.push(toolCall(callId, name, '{}'));
    items.push(toolResult(callId, output));
    writeToolOutput({ sessionId: sess.id, callId, tool: name, output });
  };
  add('s_update', 'tool_search', JSON.stringify({ query: 'workflow_update', results: [{ name: 'workflow_update', carrier: 'call_tool' }],
    schemas: { workflow_update: workflowUpdate }, schema_handles: { workflow_update: handle(workflowUpdate) } }));
  add('s_big', 'tool_search', JSON.stringify({ query: 'space_save', results: [{ name: 'space_save' }],
    schemas: { space_save: oversized }, schema_handles: { space_save: handle(oversized) } }));
  add('s_plan', 'tool_search', JSON.stringify({ kind: 'host_structural_control_lookup_v1', results: [{ name: 'plan_task' }], schemas: {},
    schema_handles: { plan_task: handle(planTask) } }));
  add('s_plan_reread', 'tool_search', JSON.stringify({ kind: 'tool_search_schema', schema_ref: ref(planTask), sha256: ref(planTask).slice(7), complete: true, schema: planTask, pad: 'p'.repeat(3000) }));
  for (let i = 0; i < 3; i++) add(`work_${i}`, 'space_get', `space ${i} ${'w'.repeat(3000)}`);

  const result = compactInFlightToolContextStable(items, createInFlightCompactionState(), sess.id,
    { resultTriggerTokens: 1_000, retainedResultBudgetTokens: 500, minRetainPairs: 1, maxRetainPairs: 1 });
  assert.equal(result.applied, true);
  const ledger = (result.nextItems.find((item) => String((item as { content?: unknown }).content ?? '')
    .includes('summary of older completed tool activity')) as { content: string }).content;
  assert.ok(ledger.includes(`- workflow_update (call with call_tool): ${JSON.stringify(workflowUpdate)}`), 'a 13-20k schema is kept whole');
  assert.ok(ledger.includes(`- plan_task: ${JSON.stringify(planTask)}`), 'a schema reread is named by the search that issued its handle');
  assert.ok(ledger.includes(`- space_save: reopen its complete schema with tool_search ${JSON.stringify({ query: 'space_save', cursor: handle(oversized).cursor })}`));
});

test('actual tool_search previews require exact reread, whose full schema keeps the issuing provider wrapper and account contract', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const { registerToolSearchTool } = await import('../../tools/tool-search-tool.js');
  const { withToolOutputContext } = await import('./tool-output-context.js');
  const { DEFAULT_TOOL_RESULT_MAX_CHARS } = await import('./tool-output-format.js');
  type Search = (input: { query: string; limit?: number; cursor?: string }) => Promise<{ content: Array<{ text: string }> }>;
  let search!: Search;
  let sourceCalls = 0;
  const name = 'CONTROLLED_CONTRACT_READ';
  const capabilityRef = 'cap:fixture:controlled-contract-read';
  const invocation = { name: 'composio_execute_tool', fixedArgs: { tool_slug: name }, payloadField: 'arguments' };
  const schema = { type: 'object', description: 'D'.repeat(Math.floor(DEFAULT_TOOL_RESULT_MAX_CHARS * 0.55)),
    properties: { payload: { type: 'object', required: ['description'], additionalProperties: false,
      properties: { description: { type: 'string', description: 'Exact provider payload instruction.' } } } },
    required: ['payload'], additionalProperties: false };
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, handler: Search) { search = handler; } } as never, {
    allowedNames: new Set(['tool_search']),
    candidateSources: [{ kind: 'authorized_composio', async search() {
      sourceCalls++;
      return [{ name, schema, summary: 'Controlled read contract.', carrier: 'work_call', invocation,
        guidance: 'G'.repeat(Math.floor(DEFAULT_TOOL_RESULT_MAX_CHARS * 0.70)) }];
    } }],
    discloseForPlanning: () => ({ [name]: capabilityRef }),
  });
  const invoke = (cursor?: string) => withToolOutputContext({ sessionId: sess.id }, () => search({ query: name, limit: 1, ...(cursor ? { cursor } : {}) }));
  const first = await invoke();
  const firstText = first.content[0]!.text;
  const page = JSON.parse(firstText);
  assert.ok(page.schemas[name], 'the actual producer supplies a structural preview');
  assert.ok(page.schema_read_required.includes(name), "Expected compaction invariant: page.schema_read_required.includes(name)");
  assert.notDeepEqual(page.schemas[name], schema);
  assert.deepEqual(page.results[0].invocation, invocation);
  const cursor = page.schema_handles[name].cursor as string;
  const items: AgentInputItem[] = [userMessage('Read the controlled account with the required provider wrapper.')];
  const add = (callId: string, tool: string, output: string) => {
    items.push(toolCall(callId, tool), toolResult(callId, output));
    writeToolOutput({ sessionId: sess.id, callId, tool, output });
  };
  add('actual_search', 'tool_search', firstText);
  for (let i = 0; i < 4; i++) add(`before_${i}`, 'read_file', `record ${i} ${'x'.repeat(4000)}`);
  const opts = { resultTriggerTokens: 1_000, retainedResultBudgetTokens: 500, minRetainPairs: 1, maxRetainPairs: 1 };
  const state = createInFlightCompactionState();
  const ledgers = (history: AgentInputItem[]) => history.map(item => String((item as { content?: unknown }).content ?? ''))
    .filter(content => content.startsWith('[summary of older completed tool activity]')).join('\n');
  const preview = compactInFlightToolContextStable([...items], state, sess.id, opts);
  const previewLedger = ledgers(preview.nextItems);
  assert.ok(previewLedger.includes(`tool_search ${JSON.stringify({ query: name, cursor })}`), "Expected compaction invariant: previewLedger.includes(`tool_search ${JSON.stringify({ query: name, cursor })}`)");
  assert.ok(previewLedger.includes('actual_search'), 'the exact issuing invocation/account result remains recallable');
  assert.ok(!previewLedger.includes(`- ${name} (call with work_call, requirement_id ${capabilityRef}): ${JSON.stringify(page.schemas[name])}`),
    'a partial preview must never be promoted to a complete input contract');
  const callsBeforeReread = sourceCalls;
  const reread = await invoke(cursor);
  const whole = JSON.parse(reread.content[0]!.text);
  assert.equal(whole.kind, 'tool_search_schema');
  assert.deepEqual(whole.schema, schema);
  assert.equal(sourceCalls, callsBeforeReread, 'exact schema redemption repeats no provider discovery');
  add('actual_reread', 'tool_search', reread.content[0]!.text);
  for (let i = 0; i < 6; i++) add(`after_${i}`, 'read_file', `record later ${i} ${'y'.repeat(4000)}`);
  const before = JSON.stringify(items);
  const complete = compactInFlightToolContextStable([...items], state, sess.id, opts);
  const completeLedger = ledgers(complete.nextItems);
  assert.ok(completeLedger.includes(`- ${name} (call with work_call, requirement_id ${capabilityRef}): ${JSON.stringify(schema)}`), "Expected compaction invariant: completeLedger.includes(`- ${name} (call with work_call, requirement_id ${capabilityRef}): ${JSON.stringify(schema)}`)");
  assert.ok(completeLedger.includes(JSON.stringify(page.results[0])), 'retain the complete original wrapper/example/status row');
  assert.ok(completeLedger.includes(JSON.stringify(page.guidance[name])), 'retain original executable guidance without clipping');
  assert.equal(JSON.stringify(items), before, 'model-only projection never rewrites retained source history');
});

test('newer schema disclosure metadata supersedes older routes without losing already-known exact schema bytes', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const name = 'controlled.read';
  const schema = { type: 'object', properties: { fixture: { type: 'string' } }, required: ['fixture'], additionalProperties: false };
  const sha256 = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  const handle = { schema_ref: `sha256:${sha256}`, cursor: `tool_search_schema:v1:${sha256}:0` };
  const items: AgentInputItem[] = [userMessage('Use the current controlled account.')];
  const add = (id: string, body: unknown) => {
    const output = typeof body === 'string' ? body : JSON.stringify(body);
    items.push(toolCall(id, id.startsWith('read') ? 'read_file' : 'tool_search'), toolResult(id, output));
    writeToolOutput({ sessionId: sess.id, callId: id, tool: id.startsWith('read') ? 'read_file' : 'tool_search', output });
  };
  add('old', { results: [{ name, carrier: 'work_call', capabilityRef: 'cap:old' }], schemas: { [name]: schema }, schema_handles: { [name]: handle } });
  add('current_preview', { results: [{ name, carrier: 'call_tool', capabilityRef: 'cap:current' }], schemas: { [name]: { type: 'object' } },
    schema_handles: { [name]: handle }, schema_read_required: [name] });
  for (let i = 0; i < 4; i++) add(`read_${i}`, `${i} ${'z'.repeat(5000)}`);
  const opts = { resultTriggerTokens: 500, retainedResultBudgetTokens: 100, minRetainPairs: 1, maxRetainPairs: 1 };
  const card = (history: AgentInputItem[]) => history.map(item => String((item as { content?: unknown }).content ?? ''))
    .join('\n').split('[retained input schema disclosures')[1] ?? '';
  const known = card(compactInFlightToolContext(items, sess.id, opts).nextItems);
  assert.ok(known.includes(`- ${name} (call with call_tool, requirement_id cap:current): ${JSON.stringify(schema)}`), "Expected compaction invariant: known.includes(`- ${name} (call with call_tool, requirement_id cap:current): ${JSON.stringify(schema)}`)");
  assert.ok(!known.includes('cap:old'), 'schema byte reuse never restores an old capability/account route');
  add('blocked', { results: [{ name, carrier: 'work_call', planningRefStatus: 'account_selection_required', accountChoices: ['fixture-b'] }], schemas: {} });
  for (let i = 4; i < 7; i++) add(`read_${i}`, `${i} ${'z'.repeat(5000)}`);
  const blocked = card(compactInFlightToolContext(items, sess.id, opts).nextItems);
  assert.ok(blocked.includes('blocked'), 'the latest row-only blocker is the exact issuing result to recover');
  assert.ok(!blocked.includes('cap:current') && !blocked.includes('cap:old'), "Expected compaction invariant: !blocked.includes('cap:current') && !blocked.includes('cap:old')");
  assert.ok(!blocked.includes(JSON.stringify(schema)), 'an older executable-looking contract cannot replace a newer blocker');
});

test('schema cards use actual occurrence bytes rather than a reused call id longest-wins payload', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const oldPage = JSON.stringify({ results: [{ name: 'controlled.read', carrier: 'work_call', capabilityRef: 'cap:stale' }],
    schemas: { 'controlled.read': { type: 'object', properties: { stale: { const: 'wrong occurrence' } } } }, padding: 'old'.repeat(4000) });
  const currentSchema = { type: 'object', description: 'current contract '.repeat(60), properties: { current: { const: 'current occurrence' } } };
  const currentPage = JSON.stringify({ results: [{ name: 'controlled.read', carrier: 'call_tool', capabilityRef: 'cap:current' }],
    schemas: { 'controlled.read': currentSchema } });
  writeToolOutput({ sessionId: sess.id, callId: 'reused-search', tool: 'tool_search', output: oldPage });
  writeToolOutput({ sessionId: sess.id, callId: 'reused-search', tool: 'tool_search', output: currentPage });
  assert.equal(getToolOutput(sess.id, 'reused-search')!.output, oldPage, 'controlled legacy canonical storage retains longer prior bytes');
  const items: AgentInputItem[] = [userMessage('Use the current controlled contract.'),
    toolCall('reused-search', 'tool_search'), toolResult('reused-search', currentPage)];
  for (let i = 0; i < 4; i++) {
    const output = `${i} ${'p'.repeat(5000)}`;
    items.push(toolCall(`read_${i}`, 'read_file'), toolResult(`read_${i}`, output));
    writeToolOutput({ sessionId: sess.id, callId: `read_${i}`, tool: 'read_file', output });
  }
  const opts = { resultTriggerTokens: 500, retainedResultBudgetTokens: 100, minRetainPairs: 1, maxRetainPairs: 1 };
  const cards = (input: AgentInputItem[], capacityPressure = false) => compactInFlightToolContext(input, sess.id, { ...opts, capacityPressure });
  for (const capacityPressure of [false, true]) {
    const current = cards(items, capacityPressure);
    assert.ok(current.nextItems.includes(items[2]!), 'unproved current occurrence stays visible instead of pointing at longer old bytes');
    const disclosures = current.nextItems.map(item => String((item as { content?: unknown }).content ?? ''))
      .join('\n').split('[retained input schema disclosures')[1] ?? '';
    assert.ok(!disclosures.includes('cap:stale') && !disclosures.includes('wrong occurrence'), "Expected compaction invariant: !disclosures.includes('cap:stale') && !disclosures.includes('wrong occurrence')");
  }
  const clipped = [...items];
  clipped[2] = toolResult('reused-search', '[clipped output: recall the exact occurrence]');
  const clippedProjection = cards(clipped);
  assert.ok(clippedProjection.nextItems.includes(clipped[2]!), "Expected compaction invariant: clippedProjection.nextItems.includes(clipped[2]!)");
  assert.ok(!clippedProjection.nextItems.some(item => String((item as { content?: unknown }).content ?? '').includes('[retained input schema disclosures')),
    'unproven clipped storage cannot promote another occurrence to an inline contract');
  const layer1 = [...items];
  clipOldToolResults(layer1, 1, undefined, sess.id);
  assert.deepEqual((layer1[2] as { output: unknown }).output, { type: 'text', text: currentPage },
    'Layer 1 cannot replace this occurrence with a pointer to different longest-wins bytes either');
});

test('duplicate and durably ambiguous call ids preserve every occurrence across pressure and old checkpoint replay', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const { resolveToolOutputForQuery } = await import('./eventlog.js');
  const items: AgentInputItem[] = [userMessage('Preserve both controlled observations.')];
  const old = JSON.stringify({ schemas: { 'controlled.read': { type: 'object', description: 'old'.repeat(4000) } } });
  const fresh = JSON.stringify({ schemas: { 'controlled.read': { type: 'object', properties: { current: { const: true } } } } });
  const occurrence = (output: string, turn: number) => {
    const called = appendEvent({ sessionId: sess.id, turn, role: 'Clem', type: 'tool_called',
      data: { callId: 'reused', tool: 'tool_search', effect: 'read' } });
    writeToolOutput({ sessionId: sess.id, callId: 'reused', tool: 'tool_search', output });
    appendEvent({ sessionId: sess.id, turn, role: 'Clem', type: 'tool_returned', parentEventId: called.id,
      data: { callId: 'reused', tool: 'tool_search', effect: 'read' } });
    return [toolCall('reused', 'tool_search'), toolResult('reused', output)];
  };
  const first = occurrence(old, 1);
  items.push(...first);
  for (let i = 0; i < 4; i++) {
    const output = `${i} ${'p'.repeat(5000)}`;
    items.push(toolCall(`ordinary_${i}`, 'read_file'), toolResult(`ordinary_${i}`, output));
    writeToolOutput({ sessionId: sess.id, callId: `ordinary_${i}`, tool: 'read_file', output });
  }
  const opts = { resultTriggerTokens: 500, retainedResultBudgetTokens: 100, minRetainPairs: 1, maxRetainPairs: 1 };
  const state = createInFlightCompactionState();
  assert.ok(compactInFlightToolContextStable([...items], state, sess.id, opts).callIds.includes('reused'), "Expected compaction invariant: compactInFlightToolContextStable([...items], state, sess.id, opts).callIds.includes('reused')");
  const beforeReuse = [...items];
  const frozenBeforeReuse = { checkpoints: state.checkpoints.map(checkpoint => ({ ...checkpoint, callIds: new Set(checkpoint.callIds) })) };
  const reopenedCall = toolCall('reused', 'tool_search', '{"query":"a new occurrence is still running"}');
  const openOnly = compactInFlightToolContextStable([items[0]!, reopenedCall],
    { checkpoints: frozenBeforeReuse.checkpoints.map(checkpoint => ({ ...checkpoint, callIds: new Set(checkpoint.callIds) })) }, sess.id, opts);
  assert.ok(openOnly.nextItems.includes(reopenedCall), 'a checkpoint cannot replace a present open same-id call with old settled work');
  const current = occurrence(fresh, 2);
  items.push(...current);
  const latest = 'Latest controlled observation.';
  items.push(toolCall('latest', 'read_file'), toolResult('latest', latest));
  writeToolOutput({ sessionId: sess.id, callId: 'latest', tool: 'read_file', output: latest });
  assert.equal(resolveToolOutputForQuery(sess.id, 'reused').status, 'ambiguous');
  const replayedAfterDurableReuse = compactInFlightToolContextStable([...beforeReuse, ...items.slice(-2)], frozenBeforeReuse, sess.id,
    { ...opts, capacityPressure: true });
  assert.ok(replayedAfterDurableReuse.nextItems.includes(first[1]!),
    'a frozen checkpoint rechecks retained ambiguity even if the second occurrence is outside this raw frame');
  for (const result of [compactInFlightToolContext([...items], sess.id, { ...opts, capacityPressure: true }),
    compactInFlightToolContextStable([...items], state, sess.id, { ...opts, capacityPressure: true })]) {
    for (const frame of [...first, ...current]) assert.ok(result.nextItems.includes(frame), "Expected compaction invariant: result.nextItems.includes(frame)");
    assert.equal(result.nextItems.filter(item => (item as { callId?: string }).callId === 'reused').length, 4);
    assert.ok(!result.callIds.includes('reused'), "Expected compaction invariant: !result.callIds.includes('reused')");
  }
  const priorAmbiguous = items.filter(item => !first.includes(item));
  const onlyCurrent = compactInFlightToolContext(priorAmbiguous, sess.id, { ...opts, capacityPressure: true });
  assert.ok(onlyCurrent.nextItems.includes(current[1]!), 'prior retained ambiguity is still relevant with only one occurrence in the current input');
  const clipped = [...items];
  clipOldToolResults(clipped, 1, undefined, sess.id);
  for (const frame of [...first, ...current]) assert.ok(clipped.includes(frame), "Expected compaction invariant: clipped.includes(frame)");
  assert.deepEqual((current[1] as { output: unknown }).output, { type: 'text', text: fresh });
});

test('retirement preserves readable failure and legacy data but requires a host-resolved nonce for compact exact receipts', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const { withToolOutputContext } = await import('./tool-output-context.js');
  const { formatRecallableToolText } = await import('./tool-output-format.js');
  const { resolveToolOutputForQuery } = await import('./eventlog.js');
  const nonce = '11111111-1111-4111-8111-111111111111';
  const full = 'controlled exact output '.repeat(1000);
  const compact = withToolOutputContext({ sessionId: sess.id, callId: 'exact', toolName: 'read_file', settlementNonce: nonce },
    () => formatRecallableToolText(full, { maxChars: 1000 }));
  assert.match(compact, new RegExp(nonce));
  const exact = resolveToolOutputForQuery(sess.id, 'exact');
  assert.equal(exact.status, 'ok');
  if (exact.status !== 'ok') return;
  assert.equal(exact.record.invocationNonce, nonce, 'expected nonce comes from host invocation resolution');
  const failure = '{"ok":false,"error":"controlled failure remains readable"}';
  const legacy = 'controlled legacy bytes '.repeat(500);
  writeToolOutput({ sessionId: sess.id, callId: 'failure', tool: 'controlled.read', output: failure });
  writeToolOutput({ sessionId: sess.id, callId: 'legacy', tool: 'read_file', output: legacy });
  const items: AgentInputItem[] = [userMessage('Keep the exact controlled evidence.'),
    toolCall('failure', 'controlled.read'), toolResult('failure', failure),
    toolCall('legacy', 'read_file'), toolResult('legacy', legacy),
    toolCall('exact', 'read_file'), toolResult('exact', compact)];
  const olderCanonical = 'older canonical output '.repeat(1000);
  const newerExact = 'newer exact occurrence '.repeat(40);
  writeToolOutput({ sessionId: sess.id, callId: 'canonical_conflict', tool: 'read_file', output: olderCanonical });
  writeToolOutput({ sessionId: sess.id, callId: 'canonical_conflict', invocationNonce: '33333333-3333-4333-8333-333333333333',
    tool: 'read_file', output: newerExact });
  const differentQueryBytes = resolveToolOutputForQuery(sess.id, 'canonical_conflict');
  assert.equal(differentQueryBytes.status, 'ok');
  if (differentQueryBytes.status !== 'ok') return;
  assert.equal(differentQueryBytes.record.output, newerExact);
  assert.equal(getToolOutput(sess.id, 'canonical_conflict')!.output, olderCanonical);
  const conflict = toolResult('canonical_conflict', newerExact);
  items.push(toolCall('canonical_conflict', 'read_file'), conflict);
  const tail = 'latest '.repeat(1000);
  writeToolOutput({ sessionId: sess.id, callId: 'latest', tool: 'read_file', output: tail });
  items.push(toolCall('latest', 'read_file'), toolResult('latest', tail));
  const pressure = { resultTriggerTokens: 1, retainedResultBudgetTokens: 100, minRetainPairs: 1, maxRetainPairs: 1, capacityPressure: true };
  const valid = compactInFlightToolContext([...items], sess.id, pressure);
  for (const callId of ['failure', 'legacy', 'exact']) assert.ok(valid.callIds.includes(callId), "Expected compaction invariant: valid.callIds.includes(callId)");
  assert.ok(valid.nextItems.includes(conflict), 'bare advertised recall must not silently switch to a different canonical payload');
  const forged = [...items];
  forged[6] = toolResult('exact', compact.replace(nonce, '22222222-2222-4222-8222-222222222222'));
  const rejected = compactInFlightToolContext(forged, sess.id, pressure);
  assert.ok(rejected.nextItems.includes(forged[6]!), 'a payload-nominated different nonce is not host occurrence proof');
  assert.ok(!rejected.callIds.includes('exact'), "Expected compaction invariant: !rejected.callIds.includes('exact')");
});

test('capacity pressure rebases frozen schema cards and refetched results while preserving exact task and effect evidence', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const { capacityAwareCompactionThresholds } = await import('./context-capacity-policy.js');
  const shadow = await import('../graph/turn-graph-shadow.js');
  const dispatch = await import('./dispatch-ledger.js');
  const identities = await import('./attempt-identity.js');
  const outcomes = await import('./attempt-outcome.js');
  const settlements = await import('./logical-call-settlement-store.js');
  const objective = userMessage('Prepare the controlled board; keep all requirements and do not send it.');
  const standing = systemMessage('Standing instruction: retain the selected account and never repeat a settled write.');
  const contrary = assistantMessage('Contrary evidence: earlier populated rows do not prove the last refresh worked.');
  const visual = { role: 'user', content: [{ type: 'input_text', text: 'The supplied image is contrary evidence.' },
    { type: 'input_image', image: 'data:image/png;base64,controlled-visual-frame' }] } as unknown as AgentInputItem;
  const source = appendEvent({ sessionId: sess.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Prepare the controlled board; keep all requirements and do not send it.' } });
  assert.ok(shadow.recordTurnGraphShadow({ identity: { sessionId: sess.id, sourceUserSeq: source.seq, turn: 1 } }), "Expected compaction invariant: shadow.recordTurnGraphShadow({ identity: { sessionId: sess.id, sourceUserSeq: source.seq, turn: 1 } })");
  const task = { sessionId: sess.id, sourceUserSeq: source.seq, acceptedTaskId: identities.acceptedTaskIdFor(sess.id, source.seq) };
  const writeArgs = { path: 'controlled-board.json', content: 'controlled value', mode: 'create' };
  const started = dispatch.beginPhysicalDispatch({ identity: { ...task, logicalToolCallId: 'settled_write', physicalDispatchId: 'settled_write:1', ordinal: 0 },
    tool: 'write_file', args: writeArgs });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({ identity: started.identity, tool: 'write_file', outcome: 'returned' }).status, 'inserted');
  const writeResult = JSON.stringify({ ok: true, committed: true, path: writeArgs.path });
  assert.equal(settlements.commitLogicalCallSettlement({ identity: { ...task, logicalToolCallId: 'settled_write' },
    contract: { toolName: 'write_file', args: writeArgs }, execution: { kind: 'provider_execution' },
    result: { payload: writeResult }, outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true }, observer: { lane: 'composio', callId: 'settled_write', turn: 1 } }).status, 'committed');
  const items: AgentInputItem[] = [objective, standing, contrary, visual];
  const add = (id: string, name: string, output: string, args = '{}', park = true) => {
    items.push(toolCall(id, name, args), toolResult(id, output));
    if (park) writeToolOutput({ sessionId: sess.id, callId: id, tool: name, output });
  };
  const schema = { type: 'object', description: 'schema instructions '.repeat(600), properties: { fixture: { type: 'string' } }, required: ['fixture'] };
  const sha256 = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  add('issued_schema', 'tool_search', JSON.stringify({ results: [{ name: 'controlled.read', carrier: 'call_tool' }],
    schemas: { 'controlled.read': schema }, schema_handles: { 'controlled.read': { schema_ref: `sha256:${sha256}`, cursor: `tool_search_schema:v1:${sha256}:0` } },
    padding: 'p'.repeat(16000) }));
  add('settled_write', 'write_file', writeResult, JSON.stringify(writeArgs));
  const uncertain = JSON.stringify({ status: 'uncertain', detail: 'The provider may have begun. Reconcile this exact occurrence before retry.' });
  add('uncertain_write', 'controlled.write', uncertain, '{"fixture":"uncertain"}');
  const playbook = 'Reusable controlled procedure '.repeat(500);
  add('playbook_first', 'skill_read', playbook, '{"name":"controlled-playbook"}');
  add('playbook_refetched', 'skill_read', playbook, '{"name":"controlled-playbook"}');
  for (let i = 0; i < 3; i++) add(`ordinary_${i}`, 'read_file', `${i} ${'x'.repeat(5000)}`);
  const open = toolCall('open_call', 'controlled.read', '{"fixture":"still running"}');
  items.push(open);
  add('unrecallable', 'controlled.read', 'unparked observation '.repeat(40), '{}', false);
  add('latest_failed', 'controlled.read', '{"ok":false,"error":"Newest refresh failed; old rows are not fresh acceptance."}', '{"fixture":"latest"}');
  const before = JSON.stringify(items);
  const normal = { resultTriggerTokens: 2000, retainedResultBudgetTokens: 1000, minRetainPairs: 1, maxRetainPairs: 2, checkpointed: true };
  const state = createInFlightCompactionState();
  const first = compactInFlightToolContextStable([...items], state, sess.id, normal);
  const textOf = (input: AgentInputItem[]) => input.map(item => String((item as { content?: unknown }).content ?? '')).join('\n');
  assert.ok(first.checkpointCreated, "Expected compaction invariant: first.checkpointCreated");
  assert.ok(textOf(first.nextItems).includes(JSON.stringify(schema)), 'normal cached checkpoints retain the full issued schema');
  assert.ok(first.nextItems.some(item => (item as { callId?: string }).callId === 'playbook_refetched'), "Expected compaction invariant: first.nextItems.some(item => (item as { callId?: string }).callId === 'playbook_refetched')");
  const overhead = 1000;
  const contextWindow = estimateInputTokens(first.nextItems) + overhead;
  const policy = capacityAwareCompactionThresholds(normal, contextWindow, estimateInputTokens(first.nextItems) + overhead);
  assert.equal(policy.capacityPressure, true, 'use the actual caller capacity policy, including instruction/tool overhead');
  const pressure = { ...policy.thresholds, capacityPressure: policy.capacityPressure };
  for (const result of [compactInFlightToolContext([...items], sess.id, pressure),
    compactInFlightToolContextStable([...items], state, sess.id, pressure)]) {
    assert.ok(result.afterTokens + overhead <= Math.floor(contextWindow * 0.9), 'this reducible controlled request recovers its output headroom');
    for (const frame of [objective, standing, contrary, visual, open]) assert.ok(result.nextItems.includes(frame), "Expected compaction invariant: result.nextItems.includes(frame)");
    assert.deepEqual(result.nextItems.slice(-2), items.slice(-2), 'the newest contrary observation stays exact and in order');
    assert.ok(result.nextItems.some(item => (item as { callId?: string }).callId === 'unrecallable'), "Expected compaction invariant: result.nextItems.some(item => (item as { callId?: string }).callId === 'unrecallable')");
    assert.ok(!result.nextItems.some(item => (item as { callId?: string }).callId === 'playbook_refetched'), "Expected compaction invariant: !result.nextItems.some(item => (item as { callId?: string }).callId === 'playbook_refetched')");
    const sent = textOf(result.nextItems);
    assert.ok(!sent.includes(JSON.stringify(schema)), 'old frozen inline cards are not exempt from capacity reduction');
    assert.ok(!sent.includes('[retained input schema disclosures'), 'hard pressure omits optional full and fallback schema cards');
    assert.ok(sent.includes('issued_schema') && sent.includes('recall_tool_result'), 'the common complete call-id ledger retains the exact issuing recovery path');
    assert.ok(sent.includes('[Durable completed writes — already done]') && sent.includes(JSON.stringify(writeArgs)), "Expected compaction invariant: sent.includes('[Durable completed writes — already done]') && sent.includes(JSON.stringify(writeArgs))");
    assert.ok(sent.includes('uncertain_write') && sent.includes('uncertain'), "Expected compaction invariant: sent.includes('uncertain_write') && sent.includes('uncertain')");
    assert.equal(getToolOutput(sess.id, 'uncertain_write')!.output, uncertain);
    assert.equal(getToolOutput(sess.id, 'playbook_refetched')!.output, playbook);
  }
  assert.equal(state.checkpoints.length, 1, 'hard pressure replaces old copied-card checkpoints with one exact-reference ledger');
  assert.equal(JSON.stringify(items), before, 'all original request, schema, observation and effect bytes remain lossless');
});

test('schema card fallback references share the total card cap without losing the complete call-id index', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const items: AgentInputItem[] = [userMessage('Keep the controlled tool disclosures addressable.')];
  const ids: string[] = [];
  for (let i = 0; i < 240; i++) {
    const name = `controlled_${i}_${'n'.repeat(80)}`;
    const callId = `search_${i}_${'c'.repeat(100)}`;
    ids.push(callId);
    const sha256 = createHash('sha256').update(JSON.stringify({ name })).digest('hex');
    const output = JSON.stringify({ results: [{ name, carrier: 'work_call', capabilityRef: `cap:${name}` }],
      schemas: { [name]: { type: 'object' } }, schema_read_required: [name],
      schema_handles: { [name]: { schema_ref: `sha256:${sha256}`, cursor: `tool_search_schema:v1:${sha256}:0` } } });
    items.push(toolCall(callId, 'tool_search'), toolResult(callId, output));
    writeToolOutput({ sessionId: sess.id, callId, tool: 'tool_search', output });
  }
  items.push(toolCall('latest', 'read_file'), toolResult('latest', 'Latest observation.'));
  writeToolOutput({ sessionId: sess.id, callId: 'latest', tool: 'read_file', output: 'Latest observation.' });
  const result = compactInFlightToolContext(items, sess.id,
    { resultTriggerTokens: 500, retainedResultBudgetTokens: 100, minRetainPairs: 1, maxRetainPairs: 1 });
  assert.ok(result.applied, "Expected compaction invariant: result.applied");
  const ledger = String((result.nextItems.find(item => String((item as { content?: unknown }).content ?? '')
    .startsWith('[summary of older completed tool activity]')) as { content: string }).content);
  const start = ledger.indexOf('[retained input schema disclosures');
  assert.ok(start >= 0, "Expected compaction invariant: start >= 0");
  const cards = ledger.slice(start);
  assert.ok(cards.length <= 48_000, `all cards and fallback lines use one cap, got ${cards.length}`);
  assert.ok(cards.includes('Additional schema disclosures remain'), "Expected compaction invariant: cards.includes('Additional schema disclosures remain')");
  const completeIndex = /\[complete collapsed call-id index JSON\] (\[[^\n]+\])/.exec(ledger);
  assert.ok(completeIndex, "Expected compaction invariant: completeIndex");
  assert.deepEqual(JSON.parse(completeIndex[1]!), ids, 'no exact result identity is dropped when optional cards stop fitting');
});

test('a result fetched again after a collapse stays verbatim for the rest of the turn; the rest still collapses', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const playbook = `playbook ${'k'.repeat(6000)}`;
  const items: AgentInputItem[] = [userMessage('build the workspace')];
  const add = (callId: string, name: string, output: string) => {
    items.push(toolCall(callId, name, '{}'));
    items.push(toolResult(callId, output));
    writeToolOutput({ sessionId: sess.id, callId, tool: name, output });
  };
  items.push(toolCall('skill_1', 'skill_read', '{"name":"workspace-builder"}'));
  items.push(toolResult('skill_1', playbook));
  writeToolOutput({ sessionId: sess.id, callId: 'skill_1', tool: 'skill_read', output: playbook });
  for (let i = 0; i < 4; i++) add(`read_${i}`, 'space_get', `space ${i} ${'r'.repeat(4000)}`);
  const opts = { resultTriggerTokens: 2_000, retainedResultBudgetTokens: 1_000, minRetainPairs: 1, maxRetainPairs: 2 };
  const state = createInFlightCompactionState();
  const first = compactInFlightToolContextStable([...items], state, sess.id, opts);
  assert.ok(first.callIds.includes('skill_1'), 'the first copy collapses like any old result');

  items.push(toolCall('skill_2', 'skill_read', '{"name":"workspace-builder"}'));
  items.push(toolResult('skill_2', playbook));
  writeToolOutput({ sessionId: sess.id, callId: 'skill_2', tool: 'skill_read', output: playbook });
  for (let i = 4; i < 9; i++) add(`read_${i}`, 'space_get', `space ${i} ${'r'.repeat(4000)}`);
  // The same read through a carrier, with an explicit null, is the same call.
  items.push(toolCall('skill_3', 'call_tool', JSON.stringify({ name: 'skill_read', args_json: '{"name":"workspace-builder","section":null}' })));
  items.push(toolResult('skill_3', playbook));
  writeToolOutput({ sessionId: sess.id, callId: 'skill_3', tool: 'call_tool', output: playbook });
  assert.deepEqual([...refetchedWorkingSetCallIds(items, sess.id)].sort(), ['skill_2', 'skill_3']);
  const later = compactInFlightToolContextStable([...items], state, sess.id, opts);
  const sent = JSON.stringify(later.nextItems);
  assert.ok(later.checkpoints! >= 2, 'pressure still takes new checkpoints');
  assert.match(sent, /"callId":"skill_2"/, 'the re-fetched playbook is still in front of the model');
  assert.doesNotMatch(sent, /"callId":"read_4"/, 'other old results still collapse');

  const sliding = compactInFlightToolContext([...items], sess.id, opts);
  assert.match(JSON.stringify(sliding.nextItems), /"callId":"skill_2"/);
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

test('validateCallIdReferences — native Claude references require exact membership and leave unrelated brackets unchanged', () => {
  const valid = new Set(['call_known-1', 'toolu_known-1', 'ordinary_reference']);
  const summary = '[call_known-1] [toolu_known-1] [toolu_known-1] [call_missing] [toolu_missing] '
    + '[ordinary_reference] [footnote] [toolu_] [toolu.invalid]';
  assert.deepEqual(validateCallIdReferences(summary, valid), {
    sanitized: '[call_known-1] [toolu_known-1] [toolu_known-1] [invalid call_id] [invalid call_id] '
      + '[ordinary_reference] [footnote] [toolu_] [toolu.invalid]',
    referenced: ['call_known-1', 'toolu_known-1'],
    hallucinated: ['call_missing', 'toolu_missing'],
  });
});

for (const transport of ['buffered', 'streamed'] as const) {
  test(`summarizeOlderMessages — validates actual ${transport} native Claude IDs and preserves exact history`, async () => {
    const { NoopTrace, withTrace } = await import('@openai/agents-core');
    const { aisdk } = await import('@openai/agents-extensions/ai-sdk');
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const nativeId = `toolu_compaction_${transport}`;
    let adapterCalls = 0;
    const provider = createAnthropic({ apiKey: 'fixture-only', fetch: async () => {
      adapterCalls += 1;
      if (transport === 'buffered') {
        return new Response(JSON.stringify({ id: `msg_compaction_${transport}`, type: 'message', role: 'assistant',
          model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: nativeId, name: 'read_file',
            input: { path: 'controlled.txt' } }], stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 42, output_tokens: 7 } }), { headers: { 'content-type': 'application/json' } });
      }
      const blocks = [
        { type: 'message_start', message: { id: `msg_compaction_${transport}`, type: 'message', role: 'assistant',
          model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 42, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: nativeId,
          name: 'read_file', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta',
          partial_json: '{"path":"controlled.txt"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } },
        { type: 'message_stop' },
      ];
      return new Response(blocks.map(block => `event: ${block.type}\ndata: ${JSON.stringify(block)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    } });
    const model = aisdk(provider('claude-sonnet-5'));
    const request = { input: 'Read the controlled fixture.', tools: [], handoffs: [],
      outputType: 'text', modelSettings: {}, tracing: false } as never;
    let output: unknown[] | undefined;
    if (transport === 'buffered') output = (await withTrace(new NoopTrace(), () => model.getResponse(request))).output;
    else {
      for await (const event of model.getStreamedResponse(request)) {
        if (event.type === 'response_done') output = event.response.output;
      }
    }
    assert.equal(adapterCalls, 1, 'the scripted real adapter performs one response conversion');
    assert.ok(output);
    const nativeCall = output.find(item => (item as { type?: string }).type === 'function_call') as
      { type: string; callId: string; name: string; arguments: string } | undefined;
    assert.ok(nativeCall, 'the real adapter must produce a harness function call');
    assert.equal(nativeCall.callId, nativeId, 'the native ID must survive adapter conversion unchanged');
    assert.equal(nativeCall.name, 'read_file');
    assert.deepEqual(JSON.parse(nativeCall.arguments), { path: 'controlled.txt' });

    resetEventLog();
    const session = HarnessSession.create({ kind: 'chat', title: `native ${transport} references` });
    const foreign = createSession({ kind: 'chat' });
    appendEvent({ sessionId: session.id, turn: 1, role: 'assistant', type: 'tool_called',
      data: { callId: nativeCall.callId, tool: nativeCall.name, arguments: nativeCall.arguments } });
    appendEvent({ sessionId: foreign.id, turn: 1, role: 'assistant', type: 'tool_called',
      data: { callId: 'toolu_foreign', tool: 'read_file', arguments: '{}' } });
    const retainedText = 'Controlled retained result. No write was requested.';
    writeToolOutput({ sessionId: session.id, callId: nativeCall.callId, tool: nativeCall.name, output: retainedText });
    const checkpoint = systemMessage('[summary of older completed tool activity]\nSettled work remains retained.');
    const nativeItem = nativeCall as unknown as AgentInputItem;
    const resultItem = toolResult(nativeCall.callId, retainedText);
    const items = [userMessage('Use the controlled result, preserving the read-only constraint.'), checkpoint,
      nativeItem, resultItem, assistantMessage('The result still needs a final explanation. '.repeat(40)),
      userMessage('Keep the original limitation.'), assistantMessage('Recent answer remains verbatim.')];
    const originalHistory = JSON.stringify(items);
    let summaries = 0;
    _setCompactionSummarizerForTests(async () => {
      summaries += 1;
      return { summary: `- Result [${nativeId}] remains available. Unknown [toolu_missing] and [toolu_foreign]. [footnote]`,
        modelUsed: 'test-summarizer' };
    });
    try {
      const result = await summarizeOlderMessages(items, session.id, 2);
      assert.equal(result.applied, true);
      assert.equal(summaries, 1, 'reference validation must not add a summarizer round');
      assert.deepEqual(result.callIdsReferenced, [nativeId]);
      assert.deepEqual(result.hallucinatedCallIds, ['toolu_missing', 'toolu_foreign']);
      const summary = result.mutatedItems?.find(item =>
        typeof (item as { content?: unknown }).content === 'string'
        && (item as { content: string }).content.startsWith('[summary of earlier conversation]'));
      assert.ok(summary);
      assert.equal((summary as { content: string }).content,
        `[summary of earlier conversation]\n- Result [${nativeId}] remains available. Unknown [invalid call_id] and [invalid call_id]. [footnote]`);
      assert.deepEqual(result.mutatedItems, [items[0], checkpoint, nativeItem, resultItem, summary, items[5], items[6]]);
      for (const index of [0, 1, 2, 3, 5, 6]) assert.equal(result.mutatedItems?.[index], items[index]);
      assert.equal(JSON.stringify(items), originalHistory, 'the original history must not mutate');
      assert.equal(getToolOutput(session.id, nativeId)?.output, retainedText, 'parked result bytes must remain exact');
    } finally {
      _setCompactionSummarizerForTests(null);
    }
  });
}

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
      assistantMessage('The draft still needs final review. ' + 'The review remains pending and no final delivery has occurred. '.repeat(20)),
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

test('layer1CompactionBudgetForModel: lossless Layer 1 is absolute on every wire; Layers 2/3 keep the window', async () => {
  // Layer 1 clips and collapses OLD tool results that stay recallable by call
  // id. A cached prefix is not free — it still prefills, costs a tenth on every
  // frame and is re-billed in full on each new turn after the provider TTL —
  // so the caching exemption (2026-09-15) let a 1M-window Together session
  // carry a 118k history with 60-turn-old results forever (live 2026-09-24).
  const { layer1CompactionBudgetForModel, compactionBudgetForModel } = await import('./compaction.js');
  assert.equal(layer1CompactionBudgetForModel('gpt-5.6-sol'), 200_000);
  assert.equal(layer1CompactionBudgetForModel('kimi-k3'), 200_000);
  // Layers 2/3 keep the real window — the 2026-08-05 pin above is untouched.
  assert.equal(compactionBudgetForModel('gpt-5.6-sol'), 880_000);
  // Caching wires too: lossless clipping between turns is paid once.
  assert.equal(layer1CompactionBudgetForModel('claude-sonnet-5'), 200_000);
  assert.equal(layer1CompactionBudgetForModel('claude-opus-4-8'), 200_000);
  // A window below the absolute is still the honest ceiling.
  assert.equal(layer1CompactionBudgetForModel('glm-4.7'), 200_000);
  assert.ok(layer1CompactionBudgetForModel('totally-unknown-model') <= 200_000);
  assert.equal(layer1CompactionBudgetForModel('totally-unknown-model'), compactionBudgetForModel('totally-unknown-model'));
});

test('compactSessionIfNeeded — Layer 1 fires on its own budget while Layers 2/3 keep the window', async () => {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat', title: 'layer1 budget test' });
  const items: AgentInputItem[] = [];
  for (let i = 0; i < 16; i++) {
    const callId = `call_${i}`;
    items.push(userMessage(`turn ${i}`));
    items.push(toolCall(callId, 'scrape.site', `{"url":"https://site-${i}.test"}`));
    items.push(toolResult(callId, `site ${i} result ${'z'.repeat(4000)}`));
    writeToolOutput({ sessionId: session.id, callId, tool: 'scrape.site', output: `site ${i} result ${'z'.repeat(4000)}` });
  }
  session.updateConversationSnapshot(items);
  const before = estimateInputTokens(items);

  // Window-only budget with headroom: nothing fires (the pre-existing behavior).
  const untouched = await compactSessionIfNeeded(session, structuredClone(items), {
    disable: 'layer1_only',
    inputBudgetTokens: 880_000,
    layer1ItemThreshold: 1_000,
  });
  assert.equal(untouched.result.modified, false, 'on the window alone the history is far below 30%');
  assert.equal(untouched.result.layer1BudgetTokens, 880_000);

  // Same history, same window, Layer 1 measured against an absolute budget it
  // exceeds: old pairs collapse, and the window is still what Layers 2/3 see.
  const compacted = await compactSessionIfNeeded(session, structuredClone(items), {
    disable: 'layer1_only',
    inputBudgetTokens: 880_000,
    layer1BudgetTokens: Math.floor(before / 0.3) - 1,
    layer1ItemThreshold: 1_000,
    layer1RetainToolPairs: 4,
  });
  assert.equal(compacted.result.modified, true);
  assert.equal(compacted.result.budgetTokens, 880_000, 'lossy layers keep the window');
  assert.equal(compacted.result.layer1BudgetTokens, Math.floor(before / 0.3) - 1);
  assert.ok(compacted.result.layer1.collapsedToolPairs > 0);
  assert.ok(compacted.result.afterTokens < compacted.result.beforeTokens);

  // A Layer 1 budget can never exceed the window it lives inside.
  const clamped = await compactSessionIfNeeded(session, structuredClone(items), {
    disable: 'layer1_only',
    inputBudgetTokens: 50_000,
    layer1BudgetTokens: 900_000,
    layer1ItemThreshold: 1_000,
  });
  assert.equal(clamped.result.layer1BudgetTokens, 50_000);
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
  // The archived-pair ledger must actually be smaller than the raw result;
  // pressure alone must never force a token-expanding replacement.
  const payload = `IDENTICAL::${'p'.repeat(4000)}`;
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

test('compaction refuses replacements that expand the prompt even under pressure', async () => {
  const session = createSession({ kind: 'chat' });
  const items = [userMessage('Read twice.')];
  for (const id of ['small-a', 'small-b']) {
    writeToolOutput({ sessionId: session.id, callId: id, tool: 'test.read', output: 'ok' });
    items.push(toolCall(id, 'test.read', '{}'), toolResult(id, 'ok'));
  }
  const result = compactInFlightToolContext(items, session.id, {
    resultTriggerTokens: 1, retainedResultBudgetTokens: 1, minRetainPairs: 1, maxRetainPairs: 1,
  });
  assert.equal(result.applied, false);
  assert.deepEqual(result.nextItems, items);

  _setCompactionSummarizerForTests(async () => ({
    summary: 'A verbose replacement that adds unnecessary words. '.repeat(30), modelUsed: 'test-summarizer',
  }));
  try {
    const summary = await summarizeOlderMessages([
      userMessage('Keep the constraint.'), assistantMessage('Noted.'), assistantMessage('Still pending.'),
      userMessage('Continue.'), assistantMessage('Ready.'),
    ], session.id, 2);
    assert.equal(summary.applied, false);
    assert.equal(summary.error, 'summary_not_smaller');
    assert.equal(summary.mutatedItems, undefined);
  } finally { _setCompactionSummarizerForTests(null); }
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
      assistantMessage('The review is pending. ' + 'The complete returned record still requires review before delivery. '.repeat(20)), userMessage('Continue later.'), assistantMessage('Ready.'),
    ], session.id, 2);
    assert.equal(result.applied, true);
    const keptCall = result.mutatedItems?.find(item => (item as { type?: string }).type === 'function_call') as { arguments?: string };
    const keptResult = result.mutatedItems?.find(item => (item as { type?: string }).type === 'function_call_result') as { output?: { text?: string } };
    assert.equal(keptCall.arguments, argumentsJson);
    assert.equal(keptResult.output?.text, resultText);
    assert.ok(!received.includes('TOOL_CALL'), 'exact tool state is retained rather than sent through prose compression');
  } finally { _setCompactionSummarizerForTests(null); }
});


test('compactSessionIfNeeded — prior-turn reasoning is dropped at the between-turn boundary, at any size, without a model call', async () => {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat', title: 'reasoning boundary test' });
  const items: AgentInputItem[] = [
    userMessage('first ask'),
    { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: 'private scratch '.repeat(400) }] } as unknown as AgentInputItem,
    toolCall('call_r1', 'read_file', '{"path":"a"}'),
    toolResult('call_r1', 'small result'),
    { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: 'more scratch '.repeat(400) }] } as unknown as AgentInputItem,
    { role: 'assistant', content: 'done' } as AgentInputItem,
  ];
  session.updateConversationSnapshot(items);
  // Far below every threshold: only Layer 0 acts.
  const { result, nextItems } = await compactSessionIfNeeded(session, structuredClone(items), {
    disable: 'layer1_only', inputBudgetTokens: 880_000, layer1ItemThreshold: 1_000,
  });
  assert.equal(result.reasoningDropped, 2);
  assert.equal(result.modified, true);
  assert.equal(result.layer1.applied, false, 'nothing else moved');
  assert.deepEqual(nextItems.map((item) => (item as { type?: string; role?: string }).type ?? (item as { role?: string }).role),
    ['user', 'function_call', 'function_call_result', 'assistant']);
  assert.ok(result.afterTokens < result.beforeTokens);
  // With no reasoning present the pass reports nothing and returns the same array.
  const clean = await compactSessionIfNeeded(session, nextItems, { disable: 'layer1_only', inputBudgetTokens: 880_000, layer1ItemThreshold: 1_000 });
  assert.equal(clean.result.reasoningDropped, undefined);
  assert.equal(clean.result.modified, false);
});

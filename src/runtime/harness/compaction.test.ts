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

const { resetEventLog, createSession, writeToolOutput, getToolOutput } = await import('./eventlog.js');
const { clipOldToolResults, collapseOldCompletedToolPairs, compactSessionIfNeeded, validateCallIdReferences } = await import('./compaction.js');
const { estimateInputTokens } = await import('./token-estimator.js');
const { HarnessSession } = await import('./session.js');

function userMessage(text: string): AgentInputItem {
  return { role: 'user', content: text } as unknown as AgentInputItem;
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
  assert.match(stub, /recall_tool_result\("call_0"\)/);
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
  assert.match(String(summary.content), /recall_tool_result\("call_0"\)/);
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

test('tool_outputs — tail-truncates outputs over 200KB and marks the row', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const oversized = 'y'.repeat(300_000);
  writeToolOutput({ sessionId: sess.id, callId: 'call_huge', tool: 'composio.huge', output: oversized });
  const row = getToolOutput(sess.id, 'call_huge');
  assert.ok(row);
  assert.equal(row.contentBytes, 300_000, 'original byte count preserved on the row');
  assert.equal(row.truncatedAtWrite, true);
  assert.ok(row.output.length <= 200_000, 'stored payload is bounded');
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

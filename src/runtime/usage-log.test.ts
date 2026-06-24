/**
 * Run: npx tsx --test src/runtime/usage-log.test.ts
 *
 * Locks in the efficiency-observability math: cache-hit-rate aggregation in the
 * rollup, the shared kind classifier (incl. the new `warmup` segment), and the
 * additive byKind/byModel input/cached fields the readout + dashboard consume.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rollupUsage, classifyUsageKind, parseWorkflowSource } = await import('./usage-log.js');

function ev(over: Partial<import('./usage-log.js').UsageEvent>): import('./usage-log.js').UsageEvent {
  return {
    at: '2026-06-20T00:00:00.000Z',
    source: 'console:home',
    kind: 'chat',
    model: 'gpt-5.5',
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 100,
    totalTokens: 1100,
    ...over,
  };
}

test('classifyUsageKind tags boot warmups as their own kind', () => {
  assert.equal(classifyUsageKind('warmup-1781833012346'), 'warmup');
  assert.equal(classifyUsageKind('console:home'), 'chat');
  assert.equal(classifyUsageKind('cron:morning-briefing'), 'cron');
  assert.equal(classifyUsageKind('workflow:abc'), 'workflow');
  assert.equal(classifyUsageKind('agent:clementine'), 'autonomy');
  assert.equal(classifyUsageKind('unknown-thing'), 'other');
  // channel overrides for sessionless lanes
  assert.equal(classifyUsageKind('x', 'discord'), 'chat');
});

test('rollupUsage derives an overall cache-hit-rate from cached/input tokens', () => {
  const r = rollupUsage([
    ev({ inputTokens: 1000, cachedInputTokens: 800 }),
    ev({ inputTokens: 1000, cachedInputTokens: 200 }),
  ]);
  assert.equal(r.totalInputTokens, 2000);
  assert.equal(r.totalCachedInputTokens, 1000);
  assert.equal(r.cacheHitRate, 0.5);
});

test('cache-hit-rate is 0 (not NaN) when there are no input tokens', () => {
  const r = rollupUsage([ev({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 })]);
  assert.equal(r.cacheHitRate, 0);
});

test('byKind/byModel carry additive input+cached fields so per-segment hit-rate is derivable', () => {
  const r = rollupUsage([
    ev({ kind: 'warmup', source: 'warmup-1', model: 'gpt-5.5', inputTokens: 5000, cachedInputTokens: 600 }),
    ev({ kind: 'chat', source: 'console:home', model: 'gpt-5.5', inputTokens: 1000, cachedInputTokens: 700 }),
  ]);
  // warmup volume does NOT pollute the interactive-chat hit-rate when segmented.
  assert.equal(r.byKind.warmup.inputTokens, 5000);
  assert.equal(r.byKind.warmup.cachedInputTokens, 600);
  assert.equal(r.byKind.chat.cachedInputTokens / r.byKind.chat.inputTokens, 0.7);
  // model rollup sums both
  assert.equal(r.byModel['gpt-5.5'].inputTokens, 6000);
  assert.equal(r.byModel['gpt-5.5'].cachedInputTokens, 1300);
  // existing dashboard fields stay present (no regression)
  assert.equal(r.byKind.chat.calls, 1);
  assert.ok(typeof r.byKind.chat.tokens === 'number');
});

test('events without cachedInputTokens count as zero cached (no crash)', () => {
  const r = rollupUsage([ev({ cachedInputTokens: undefined })]);
  assert.equal(r.totalCachedInputTokens, 0);
  assert.equal(r.cacheHitRate, 0);
});

test('parseWorkflowSource derives runId/stepId/itemKey from a workflow session id', () => {
  // plain step session: workflow:<runId>:<stepId>
  assert.deepEqual(parseWorkflowSource('workflow:run-123:research'), {
    runId: 'run-123',
    stepId: 'research',
  });
  // forEach item session carries the trailing itemKey
  assert.deepEqual(parseWorkflowSource('workflow:run-123:enrich:acme-corp'), {
    runId: 'run-123',
    stepId: 'enrich',
    itemKey: 'acme-corp',
  });
  // an itemKey containing colons is preserved whole (rest re-joined)
  assert.deepEqual(parseWorkflowSource('workflow:run-9:send:https://x.com/a'), {
    runId: 'run-9',
    stepId: 'send',
    itemKey: 'https://x.com/a',
  });
});

test('parseWorkflowSource returns {} for non-workflow sources (join keys absent on chat/cron)', () => {
  assert.deepEqual(parseWorkflowSource('console:home'), {});
  assert.deepEqual(parseWorkflowSource('cron:morning-briefing'), {});
  assert.deepEqual(parseWorkflowSource('warmup-1781833012346'), {});
});

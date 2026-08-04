/**
 * Run: npx tsx --test src/runtime/usage-log.test.ts
 *
 * Locks in the efficiency-observability math: cache-hit-rate aggregation in the
 * rollup, the shared kind classifier (incl. the new `warmup` segment), and the
 * additive byKind/byModel input/cached fields the readout + dashboard consume.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  rollupUsage,
  classifyUsageKind,
  resolveUsageKind,
  parseWorkflowSource,
  reconcilePromptComponents,
  uncachedTokensForAccrual,
} = await import('./usage-log.js');

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

test('reconcilePromptComponents exposes provider/tool overhead without inventing negative shares', () => {
  assert.deepEqual(
    reconcilePromptComponents({ instructions: 4_000, history: 2_000, junk: Number.NaN }, 10_000),
    { instructions: 4_000, history: 2_000, providerAndToolOverhead: 4_000 },
  );
  assert.deepEqual(
    reconcilePromptComponents({ instructions: 12_000 }, 10_000),
    { instructions: 12_000 },
    'an over-estimate is preserved and never offset with a negative bucket',
  );
  assert.equal(reconcilePromptComponents(undefined, 10_000), undefined);
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
  assert.deepEqual(parseWorkflowSource('workflow:run-9:send:https://site.example/a'), {
    runId: 'run-9',
    stepId: 'send',
    itemKey: 'https://site.example/a',
  });
});

test('parseWorkflowSource returns {} for non-workflow sources (join keys absent on chat/cron)', () => {
  assert.deepEqual(parseWorkflowSource('console:home'), {});
  assert.deepEqual(parseWorkflowSource('cron:morning-briefing'), {});
  assert.deepEqual(parseWorkflowSource('warmup-1781833012346'), {});
});

test('uncachedTokensForAccrual handles BOTH metering dialects (2026-07-30: 8M guest tokens accrued zero)', () => {
  // Cached-INCLUSIVE (Codex-style): total covers cache reads — subtract them.
  assert.equal(uncachedTokensForAccrual({ inputTokens: 91_000, cachedInputTokens: 90_000, outputTokens: 650, totalTokens: 91_650 }), 1_650);
  // Cached-EXCLUSIVE (Anthropic-style, the live guest row): total < cached —
  // the old blanket subtraction clamped to ZERO; uncached work is in + out.
  assert.equal(uncachedTokensForAccrual({ inputTokens: 81, cachedInputTokens: 6_549_707, outputTokens: 75_286, totalTokens: 75_367 }), 75_367);
  // No cache at all: plain total.
  assert.equal(uncachedTokensForAccrual({ inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, totalTokens: 1100 }), 1100);
  // Degenerate/absent fields never go negative.
  assert.equal(uncachedTokensForAccrual({}), 0);
});

// ── Stage 0: lane attribution is trustworthy ────────────────────────────────
// Measured 2026-08-04 before the fix: 490 of 884 live events (55%) landed in
// `other`, and the top sources were ordinary CHAT sessions — `sess-desktop-…`
// minted by console-routes and `sess-…` ids the classifier had never heard of.
// The efficiency readout therefore showed "no chat row despite recent chat".
// These pins are the exact live shapes, so the readout can only lose its chat
// row again by someone deleting a line here.

test('the live incident shapes classify to their real lanes', () => {
  // The two dominant `other` sources from the 2026-08-04 live log.
  assert.equal(classifyUsageKind('sess-desktop-b435fdcfc4a14444191e526d'), 'chat');
  assert.equal(classifyUsageKind('sess-msdprfg7-d517142a'), 'chat');
  // The execution controller's sessions (54 live events).
  assert.equal(classifyUsageKind('execution:565f6c1a-b98c-407c-887c:controller'), 'controller');
  // Surfaces that existed in production but not in the classifier.
  assert.equal(classifyUsageKind('slack:C0123:thread'), 'chat');
  assert.equal(classifyUsageKind('mobile-4f2a'), 'chat');
  assert.equal(classifyUsageKind('webhook:ingress-1'), 'chat');
  assert.equal(classifyUsageKind('approval-resume-9'), 'chat');
  assert.equal(classifyUsageKind('x', 'slack'), 'chat');
  assert.equal(classifyUsageKind('x', 'mobile'), 'chat');
  // Guest-harness runs are detached project work, never interactive chat —
  // mapping them to chat would pollute the interactive cache-hit-rate.
  assert.equal(classifyUsageKind('x', 'guest-harness'), 'background');
});

test('the durable session row outranks id-shape guessing', () => {
  // A session id no prefix rule recognizes, but whose row says what it is.
  const fromRow = resolveUsageKind('f1a441dc-3435-4837-bd54', { sessionRowKind: 'chat' });
  assert.equal(fromRow.kind, 'chat');
  assert.equal(fromRow.reason, 'session_row:chat');
  assert.equal(resolveUsageKind('anything', { sessionRowKind: 'agent' }).kind, 'autonomy');
  assert.equal(resolveUsageKind('anything', { sessionRowKind: 'execution' }).kind, 'controller');
  // Channel (the ingress surface) still outranks the row when both exist.
  assert.equal(resolveUsageKind('anything', { channel: 'cron', sessionRowKind: 'chat' }).kind, 'cron');
  // Warmup outranks everything — boot traffic never pollutes a lane.
  assert.equal(resolveUsageKind('warmup-123', { sessionRowKind: 'chat' }).kind, 'warmup');
});

test('`other` always names what it could not classify', () => {
  const r = resolveUsageKind('f1a441dc-3435-4837-bd54-c0fae2442773');
  assert.equal(r.kind, 'other');
  assert.match(r.reason, /^unclassified:f1a441dc$/);
  // Every classified lane carries a reason too — the residue is diagnosable,
  // and so is the classification itself.
  assert.equal(resolveUsageKind('sess-abc').reason, 'prefix:sess-');
  assert.equal(resolveUsageKind('x', { channel: 'discord' }).reason, 'channel:discord');
});

test('every historical classification still holds', () => {
  // The pre-existing contract, so widening the classifier cannot have moved
  // any event that was already classified.
  assert.equal(classifyUsageKind('warmup-1781833012346'), 'warmup');
  assert.equal(classifyUsageKind('console:home'), 'chat');
  assert.equal(classifyUsageKind('cron:morning-briefing'), 'cron');
  assert.equal(classifyUsageKind('workflow:abc'), 'workflow');
  assert.equal(classifyUsageKind('background:job'), 'background');
  assert.equal(classifyUsageKind('bg-1'), 'background');
  assert.equal(classifyUsageKind('execution-controller:x'), 'controller');
  assert.equal(classifyUsageKind('agent:clementine'), 'autonomy');
  assert.equal(classifyUsageKind('discord:guild'), 'chat');
  assert.equal(classifyUsageKind('x', 'electron'), 'chat');
  assert.equal(classifyUsageKind('x', 'cli'), 'chat');
});


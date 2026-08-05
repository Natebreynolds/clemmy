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
  canonicalCacheAccounting,
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
    cacheDialect: 'inclusive',
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

test('uncachedTokensForAccrual reads the DECLARED dialect (2026-07-30: 8M guest tokens accrued zero)', () => {
  // Cached-INCLUSIVE (Codex-style): total covers cache reads — subtract them.
  assert.equal(uncachedTokensForAccrual({ cacheDialect: 'inclusive', inputTokens: 91_000, cachedInputTokens: 90_000, outputTokens: 650, totalTokens: 91_650 }), 1_650);
  // Cached-EXCLUSIVE (Anthropic-style, the live guest row): uncached work is
  // input + output, whatever the magnitudes look like.
  assert.equal(uncachedTokensForAccrual({ cacheDialect: 'exclusive', inputTokens: 81, cachedInputTokens: 6_549_707, outputTokens: 75_286, totalTokens: 75_367 }), 75_367);
  // No cache accounting at all: plain total.
  assert.equal(uncachedTokensForAccrual({ cacheDialect: 'none', inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }), 1100);
  // Degenerate/absent fields never go negative.
  assert.equal(uncachedTokensForAccrual({}), 0);
});

test('C1 MANDATORY: an explicitly exclusive sample with cached < uncached input is never treated as inclusive or under-debited', () => {
  // The audit's non-deterministic case: magnitude guessing classified this as
  // inclusive (cached 100 < input 900) and debited total - cached = 900. The
  // declared dialect says EXCLUSIVE: the model read 1000 prompt tokens and the
  // caller pays input + output = 1000.
  const sample = { cacheDialect: 'exclusive' as const, inputTokens: 900, cachedInputTokens: 100, outputTokens: 100, totalTokens: 1000 };
  const canonical = canonicalCacheAccounting(sample);
  assert.equal(canonical.dialect, 'exclusive');
  assert.equal(canonical.promptTokens, 1000);
  assert.equal(canonical.uncachedInputTokens, 900);
  assert.equal(canonical.uncachedWorkTokens, 1000, 'the exclusive sample was under-debited by a magnitude guess');
  assert.equal(uncachedTokensForAccrual(sample), 1000);
  // Mirrors: both dialects, cached smaller AND larger than uncached input.
  assert.equal(canonicalCacheAccounting({ cacheDialect: 'exclusive', inputTokens: 100, cachedInputTokens: 900, outputTokens: 50 }).promptTokens, 1000);
  assert.equal(canonicalCacheAccounting({ cacheDialect: 'inclusive', inputTokens: 1000, cachedInputTokens: 100, outputTokens: 50, totalTokens: 1050 }).uncachedWorkTokens, 950);
  assert.equal(canonicalCacheAccounting({ cacheDialect: 'inclusive', inputTokens: 1000, cachedInputTokens: 900, outputTokens: 50, totalTokens: 1050 }).uncachedWorkTokens, 150);
});

test('C1: unknown provenance is visible, uncertifiable, and debits conservatively — never a cache credit', () => {
  const legacy = { inputTokens: 91_000, cachedInputTokens: 90_000, outputTokens: 650, totalTokens: 91_650 };
  const canonical = canonicalCacheAccounting(legacy);
  assert.equal(canonical.dialect, 'unknown');
  assert.equal(canonical.certified, false);
  assert.equal(canonical.hitRate, 0, 'an unknown dialect certified a hit rate');
  assert.equal(canonical.uncachedWorkTokens, 91_650,
    'a legacy sample took a cache credit on a guess — it must never reduce a budget charge');
  // A declared dialect contradicted by its numbers quarantines.
  assert.equal(canonicalCacheAccounting({ cacheDialect: 'inclusive', inputTokens: 100, cachedInputTokens: 900 }).invalid, true);
  assert.equal(canonicalCacheAccounting({ cacheDialect: 'none', inputTokens: 100, cachedInputTokens: 5 }).invalid, true);
});

test('C1: every model adapter DECLARES its cache dialect at its recordModelUsage call', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  // EVERY production recorder, including the raw wrapper (usageRecorder) and
  // the guest lane (E2.1: the whitelist covers raw wrappers and guests).
  const producers = [
    ['../runtime/codex-native-runtime.ts', 'codex-native-runtime.ts'],
    ['../runtime/harness/codex-model.ts', 'harness/codex-model.ts'],
    ['../runtime/harness/claude-agent-sdk.ts', 'harness/claude-agent-sdk.ts'],
    ['../runtime/harness/claude-headless-model.ts', 'harness/claude-headless-model.ts'],
    ['../runtime/harness/claude-model.ts', 'harness/claude-model.ts'],
    ['../runtime/harness/byo-model.ts', 'harness/byo-model.ts'],
    ['../execution/guest-harness.ts', 'execution/guest-harness.ts'],
  ];
  for (const [rel] of producers) {
    const source = readFileSync(path.join(here, '..', rel.replace('../', '')), 'utf-8');
    const calls = [
      ...source.split('recordModelUsage({').slice(1),
      ...source.split('usageRecorder({').slice(1),
    ];
    assert.ok(calls.length > 0, `${rel}: expected at least one usage recording call`);
    for (const call of calls) {
      const head = call.slice(0, 1_000);
      // A literal or a ternary of LITERALS both count as declarations; what
      // never counts is absence or a computed value from magnitudes.
      assert.ok(/cacheDialect:\s*[^,\n]*'(inclusive|exclusive|none)'/.test(head),
        `${rel}: a usage recording call does not declare its cache dialect — no consumer may guess it`);
    }
  }
  // And the magnitude guess itself is gone: the old guessed-dialect type
  // cannot come back without failing this pin.
  const usageLog = readFileSync(path.join(here, 'usage-log.ts'), 'utf-8');
  assert.equal(usageLog.includes("'cache_exclusive'"), false,
    'the magnitude-guessed dialect type returned');
});

// ── Stage 0: lane attribution is trustworthy ────────────────────────────────
// Measured 2026-08-04 before the fix: 490 of 884 live events (55%) landed in
// `other`, and the top sources were ordinary CHAT sessions — `sess-desktop-…`
// minted by console-routes and `sess-…` ids the classifier had never heard of.
// The efficiency readout therefore showed "no chat row despite recent chat".
// These pins use synthetic ids with the exact live SHAPES (the hygiene gate
// rightly refuses real session identifiers in the public repo), so the readout
// can only lose its chat row again by someone deleting a line here.

test('the live incident shapes classify to their real lanes', () => {
  // The two dominant `other` shapes from the 2026-08-04 live log.
  assert.equal(classifyUsageKind('sess-desktop-0123456789abcdef01234567'), 'chat');
  assert.equal(classifyUsageKind('sess-abc0defg1-01234567'), 'chat');
  // The execution controller's sessions (54 live events).
  assert.equal(classifyUsageKind('execution:00000000-1111-2222-3333:controller'), 'controller');
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
  const fromRow = resolveUsageKind('01234567-89ab-cdef-0123', { sessionRowKind: 'chat' });
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
  const r = resolveUsageKind('01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(r.kind, 'other');
  assert.match(r.reason, /^unclassified:01234567$/);
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

// ── Stage 0: cache accounting cannot certify the impossible ─────────────────
// The audit found a model aggregate whose cached tokens dwarfed its input
// tokens: Anthropic-style reporting is cache-EXCLUSIVE (input counts only the
// uncached remainder) while OpenAI-style is cache-INCLUSIVE, and summing the
// two as one convention produced hit rates over 100%.

test('the two cache dialects normalize to one convention — by DECLARATION, not magnitude', () => {
  const inclusive = canonicalCacheAccounting({ cacheDialect: 'inclusive', inputTokens: 1000, cachedInputTokens: 800 });
  assert.equal(inclusive.promptTokens, 1000);
  assert.equal(inclusive.hitRate, 0.8);

  const exclusive = canonicalCacheAccounting({ cacheDialect: 'exclusive', inputTokens: 200, cachedInputTokens: 1800 });
  assert.equal(exclusive.promptTokens, 2000);
  assert.equal(exclusive.hitRate, 0.9);

  assert.equal(canonicalCacheAccounting({ cacheDialect: 'inclusive', inputTokens: 0, cachedInputTokens: 0 }).hitRate, 0);
});

test('a mixed-dialect window cannot certify a hit rate above 100%', () => {
  // Before normalization this window computed cached/input = 2600/1200 ≈ 217%.
  const r = rollupUsage([
    ev({ cacheDialect: 'inclusive', inputTokens: 1000, cachedInputTokens: 800 }),
    ev({ cacheDialect: 'exclusive', inputTokens: 200, cachedInputTokens: 1800 }),
  ]);
  assert.equal(r.totalPromptTokens, 3000);
  assert.equal(r.totalCachedInputTokens, 2600);
  assert.ok(r.cacheHitRate <= 1, `certified an impossible hit rate: ${r.cacheHitRate}`);
  assert.ok(Math.abs(r.cacheHitRate - 2600 / 3000) < 1e-9);
  // Per-kind and per-model rates are certified the same way.
  assert.ok(r.byKind.chat!.cachedInputTokens / r.byKind.chat!.promptTokens <= 1);
  assert.ok(r.byModel['gpt-5.5']!.cachedInputTokens / r.byModel['gpt-5.5']!.promptTokens <= 1);
});

test('an impossible sample is quarantined, counted, and excluded from sums', () => {
  const r = rollupUsage([
    ev({ inputTokens: 1000, cachedInputTokens: 500 }),
    ev({ inputTokens: -50, cachedInputTokens: 10, totalTokens: 999 }),
    ev({ inputTokens: Number.NaN as unknown as number, totalTokens: 777 }),
  ]);
  assert.equal(r.quarantinedCalls, 2, 'impossible samples entered the certified rollup');
  assert.equal(r.totalInputTokens, 1000, 'a quarantined sample leaked into token sums');
  assert.equal(r.totalTokens, 1100, 'a quarantined totalTokens leaked into the rollup');
  // They still happened: total calls includes them so nothing hides.
  assert.equal(r.totalCalls, 3);
});

test('legacy unknown-dialect rows stay visible in totals but never certify cache sums', () => {
  const r = rollupUsage([
    ev({ cacheDialect: 'inclusive', inputTokens: 1000, cachedInputTokens: 800 }),
    ev({ cacheDialect: undefined, inputTokens: 500, cachedInputTokens: 400, totalTokens: 600 }),
  ]);
  assert.equal(r.uncertifiedCalls, 1);
  assert.equal(r.totalInputTokens, 1500, 'an unknown row vanished from totals');
  assert.equal(r.totalCachedInputTokens, 800, 'an unknown row certified cached tokens');
  assert.equal(r.totalPromptTokens, 1000);
  assert.equal(r.cacheHitRate, 0.8);
});

test('latency PRESENCE is visible per lane, not assumed', () => {
  // The audit found lanes with no average latency at all. durationSamples <
  // calls is the signal that a lane's latency cannot yet be trusted.
  const r = rollupUsage([
    ev({ durationMs: 1200 }),
    ev({ durationMs: 800 }),
    ev({}), // no duration reported
  ]);
  assert.equal(r.byKind.chat!.calls, 3);
  assert.equal(r.byKind.chat!.durationSamples, 2);
  assert.equal(r.byKind.chat!.totalDurationMs, 2000);
});

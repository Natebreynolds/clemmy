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
  recordModelUsage,
  usageRoleFromChannel,
  withModelUsageAttribution,
} = await import('./usage-log.js');
const { listOperationalEvents } = await import('./operational-telemetry.js');

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

test('standalone captured accounting owns only its job namespace across a foreign caller and own-request scope', async () => {
  const api = await import('./usage-log.js');
  const job = api.createStandaloneModelAccountingJob({ operation: 'noticing_answer', operationId: 'controlled-check-in',
    revisionDigest: 'a'.repeat(64) });
  const binding = api.standaloneModelAccountingJobBinding(job)!;
  const ownObserved: import('./usage-log.js').ObservedModelUsage[] = [];
  const foreignObserved: import('./usage-log.js').ObservedModelUsage[] = [];
  const provenance = api.withModelUsageObserver(ownObserved, () => api.withStandaloneModelAccountingJob(job, () => api.withOwnModelRequestAttribution({
    channel: 'semantic:noticing_answer', role: 'reviewer', promptComponents: { instructions: 2, history: 3 },
  }, () => api.captureMemoryModelUsageProvenance())));
  assert.ok(provenance);
  withModelUsageAttribution({ sessionId: 'foreign-accounting-drainer', sourceUserSeq: 2701,
    attemptId: 'attempt:foreign-accounting-drainer', role: 'brain', channel: 'foreign-channel' }, () => api.withModelUsageObserver(foreignObserved, () => recordModelUsage({
    callerProvenance: provenance, sessionId: 'foreign-adapter-source', sourceUserSeq: 2702,
    attemptId: 'attempt:foreign-adapter', role: 'worker', channel: 'foreign-adapter-channel',
    model: 'controlled-accounting-model', responseId: 'standalone-original-response', inputTokens: 10, outputTokens: 3,
    cacheDialect: 'inclusive', framePromptComponents: { foreign: 999 },
    trace: { modelCallId: 'standalone-local-call', acceptedSource: 'foreign:2702', logicalTurnId: 'turn:2702',
      attemptId: 'attempt:foreign', activationId: 'foreign-activation', toolCallId: 'foreign-tool' },
  })));
  const row = api.readUsageEventsForDate().find(value => value.responseId === 'standalone-original-response')!;
  assert.equal(row.source, binding.usageJobId); assert.equal(row.channel, 'semantic:noticing_answer');
  assert.equal(row.role, 'reviewer'); assert.deepEqual(row.trace, { modelCallId: 'standalone-local-call' });
  assert.equal(row.responseId, 'standalone-original-response'); assert.equal(row.promptComponents?.foreign, undefined);
  assert.ok(Object.isFrozen(binding));
  assert.equal(ownObserved.length, 1); assert.equal(foreignObserved.length, 0);
});

test('invalid standalone accounting tokens cannot borrow explicit or ambient accepted ownership', async () => {
  const api = await import('./usage-log.js'); let hooks = 0;
  for (const variant of ['clone', 'getter', 'proxy'] as const) {
    const job = api.createStandaloneModelAccountingJob({ operation: 'noticing_proposal', operationId: 'controlled-tick',
      revisionDigest: 'b'.repeat(64) });
    const context: any = { sessionId: 'foreign-standalone', sourceUserSeq: 2801, attemptId: 'attempt:foreign',
      usageJobId: 'invented-job', standaloneAccountingJob: { ...job } };
    if (variant === 'getter') Object.defineProperty(context, 'standaloneAccountingJob', { enumerable: true,
      get() { hooks++; throw new Error('must not run'); } });
    const supplied = variant === 'proxy' ? new Proxy(context, { get() { hooks++; throw new Error('must not run'); } }) : context;
    const provenance = withModelUsageAttribution(supplied, () => api.captureMemoryModelUsageProvenance());
    assert.ok(provenance);
    withModelUsageAttribution({ sessionId: 'late-standalone', sourceUserSeq: 2802 }, () => recordModelUsage({
      callerProvenance: provenance, sessionId: 'explicit-standalone', sourceUserSeq: 2803, attemptId: 'attempt:explicit',
      trace: { acceptedSource: 'explicit:2803', logicalTurnId: 'turn:2803', modelCallId: `standalone-invalid-${variant}` },
      model: 'controlled-invalid-job', responseId: `standalone-invalid-response-${variant}`, inputTokens: 2, outputTokens: 1,
    }));
    const row = api.readUsageEventsForDate().find(value => value.responseId === `standalone-invalid-response-${variant}`)!;
    assert.equal(row.source, 'unknown'); assert.deepEqual(row.trace, { modelCallId: `standalone-invalid-${variant}` });
  }
  assert.equal(hooks, 0);
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
  // Run-level reviewers have no step and must still join the run's total.
  assert.deepEqual(parseWorkflowSource('workflow:run-123'), { runId: 'run-123' });
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


test('usageEfficiencyForEvents: frames, cache-hit share and the largest prompt, over the canonical cache dialects', async () => {
  const { usageEfficiencyForEvents } = await import('./usage-log.js');
  const base = { at: '2026-09-01T00:00:00Z', source: 'workflow:r1:main', kind: 'workflow', model: 'm', totalTokens: 0 } as const;
  const efficiency = usageEfficiencyForEvents([
    // inclusive dialect (OpenAI-compatible): input ⊇ cached
    { ...base, cacheDialect: 'inclusive', inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 200, totalTokens: 10_200 },
    { ...base, cacheDialect: 'inclusive', inputTokens: 30_000, cachedInputTokens: 24_000, outputTokens: 300, totalTokens: 30_300 },
  ] as never);
  assert.equal(efficiency.frames, 2);
  assert.equal(efficiency.inputTokens, 40_000);
  assert.equal(efficiency.cachedInputTokens, 32_000);
  assert.equal(efficiency.uncachedInputTokens, 8_000);
  assert.equal(efficiency.outputTokens, 500);
  assert.equal(efficiency.cacheHitShare, 0.8);
  assert.equal(efficiency.maxInputTokens, 30_000);
  assert.deepEqual(usageEfficiencyForEvents([]), {
    frames: 0, inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, cacheHitShare: 0, maxInputTokens: 0,
    brainFrames: 0, sideFrames: 0, sideInputTokens: 0, rebilledPrefixTokens: 0, appendedTokens: 0, prefixReuse: 0,
  });
});

test('usageEfficiencyForEvents: a brain frame that fails to reuse the previous prompt is re-billing; side calls count apart', async () => {
  const { usageEfficiencyForEvents } = await import('./usage-log.js');
  const row = (model: string, input: number, cached: number) => ({
    at: '2026-09-18T00:00:00Z', source: 'sess:1', kind: 'chat', model, cacheDialect: 'inclusive',
    inputTokens: input, cachedInputTokens: cached, outputTokens: 10, totalTokens: input + 10,
  });
  const efficiency = usageEfficiencyForEvents([
    row('brain', 20_000, 0), // first frame: cold
    row('brain', 25_000, 20_000), // extends it: 5k new, nothing re-billed
    row('judge', 9_000, 0), // a side call on another model
    row('brain', 30_000, 18_000), // prefix rewritten: 7k of the previous 25k billed again, 5k new
  ] as never);
  assert.equal(efficiency.brainFrames, 3);
  assert.equal(efficiency.sideFrames, 1);
  assert.equal(efficiency.sideInputTokens, 9_000);
  assert.equal(efficiency.rebilledPrefixTokens, 7_000);
  assert.equal(efficiency.appendedTokens, 10_000);
  assert.equal(efficiency.prefixReuse, Math.round(((20_000 + 18_000) / (20_000 + 25_000)) * 1000) / 1000);
});

test('a failed request without provider usage is counted as uncertified, never proven zero cost', () => {
  const failed = ev({ cacheDialect: 'none', ok: false, failReason: 'timeout', inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(canonicalCacheAccounting(failed).certified, false);
  assert.equal(canonicalCacheAccounting(failed).invalid, false, 'a missing usage receipt is not malformed token arithmetic');
  assert.equal(rollupUsage([failed]).uncertifiedCalls, 1);
  assert.equal(rollupUsage([failed]).totalCalls, 1, 'failed attempts remain visible');
  assert.equal(canonicalCacheAccounting({ ...failed, ok: true }).certified, true, 'a successful reported zero remains representable');
  assert.equal(canonicalCacheAccounting({ ...failed, inputTokens: 10, totalTokens: 10 }).uncachedWorkTokens, 10, 'known failed-call usage is still charged');
});

test('usageEfficiencyForEvents: the brain is the model that carried the prompt bytes, not the most-called one', async () => {
  const { usageEfficiencyForEvents } = await import('./usage-log.js');
  const row = (model: string, input: number, cached: number) => ({
    at: '2026-09-23T00:00:00Z', source: 'sess:1', kind: 'chat', model, cacheDialect: 'inclusive',
    inputTokens: input, cachedInputTokens: cached, outputTokens: 10, totalTokens: input + 10,
  });
  // Live shape: eight tiny routing calls beside eight brain frames. By count
  // the router "won" and the whole turn read as side traffic, prefixReuse 0.
  const events = [
    ...Array.from({ length: 8 }, () => row('router', 800, 0)),
    row('brain', 48_000, 0),
    row('brain', 49_500, 40_000),
    row('brain', 50_500, 40_000),
    row('brain', 51_500, 44_800),
  ];
  const efficiency = usageEfficiencyForEvents(events as never);
  assert.equal(efficiency.brainFrames, 4);
  assert.equal(efficiency.sideFrames, 8);
  assert.equal(efficiency.sideInputTokens, 6_400);
  assert.ok(efficiency.prefixReuse > 0.8, `brain frames reused the previous prompt: ${efficiency.prefixReuse}`);
});

test('a memory job channel names the role of the model the job registry gives it', () => {
  for (const job of ['learn', 'reconcile', 'patterns', 'skills', 'identity', 'import']) {
    assert.equal(usageRoleFromChannel(`memory:${job}`), 'memory', `${job} runs on the memory model`);
  }
  assert.equal(usageRoleFromChannel('Memory:Reconcile'), 'memory', 'case does not change the job');
  // The standing-preference check runs on the memory model; repairs stay review.
  assert.equal(usageRoleFromChannel('memory:standing'), 'memory');
  assert.equal(usageRoleFromChannel('memory:verify'), 'reviewer');
  // The local index and model-free upkeep are not memory model work.
  assert.equal(usageRoleFromChannel('memory:index'), undefined);
  assert.equal(usageRoleFromChannel('Memory:Tidy'), undefined);
  assert.equal(usageRoleFromChannel('memory:not-a-job'), undefined, 'an unknown job is not guessed');
  assert.equal(usageRoleFromChannel('memory_search'), undefined, 'the embedder lane is not memory model work');
  assert.equal(usageRoleFromChannel('memorable'), undefined);
});

test('a checker memory job books an unrouted call as review, never as the memory model', () => {
  const read = (sessionId: string) => listOperationalEvents({ source: 'model', type: 'model_call_completed', sessionId, limit: 5 })[0]?.payload;
  // The journal's scope shape: a governed job adds role memory, a checker job only its channel.
  for (const [job, role] of [['verify', 'reviewer'], ['standing', 'memory'], ['index', undefined], ['learn', 'memory']] as const) {
    const sessionId = `usage-memory-owner-${job}`;
    withModelUsageAttribution({ sessionId: 'memory', sourceUserSeq: 0, channel: `memory:${job}`,
      ...(job === 'learn' ? { role: 'memory' as const } : {}) }, () =>
      recordModelUsage({ sessionId, model: 'test-model', inputTokens: 5, outputTokens: 1 }));
    assert.equal(read(sessionId)?.channel, `memory:${job}`);
    assert.equal(read(sessionId)?.role, role, `${job} books as ${role ?? 'no role'}`);
  }
});

test('memory work is background usage, never the chat lane of the conversation it read', () => {
  const r = resolveUsageKind('0a1b2c3d-cli-session', { channel: 'memory:learn', sessionRowKind: 'chat' });
  assert.deepEqual(r, { kind: 'background', reason: 'channel:memory:learn' });
  assert.equal(resolveUsageKind('warmup-1', { channel: 'memory:learn' }).kind, 'warmup', 'warmup still outranks');
  assert.equal(resolveUsageKind('x', { channel: 'workflow' }).kind, 'workflow', 'exact channels are unchanged');
});

test('the model_call_completed event carries the resolved channel and role, in the same order the row uses', () => {
  const read = (sessionId: string) => listOperationalEvents({ source: 'model', type: 'model_call_completed', sessionId, limit: 5 })[0]?.payload;

  // An adapter passes no channel: the job scope's channel and the channel role land on the event.
  withModelUsageAttribution({ sessionId: 'memory', sourceUserSeq: 0, channel: 'memory:reconcile' }, () =>
    recordModelUsage({ sessionId: 'usage-memory-channel', model: 'memory-model', inputTokens: 10, outputTokens: 2 }));
  assert.deepEqual(
    { channel: read('usage-memory-channel')?.channel, role: read('usage-memory-channel')?.role, roleReason: read('usage-memory-channel')?.roleReason },
    { channel: 'memory:reconcile', role: 'memory', roleReason: 'channel' },
  );

  // A scope role outranks the channel convention (explicit > scope > channel is untouched).
  withModelUsageAttribution({ sessionId: 'memory', sourceUserSeq: 0, channel: 'memory:learn', role: 'reviewer' }, () =>
    recordModelUsage({ sessionId: 'usage-memory-scope', model: 'memory-model', inputTokens: 10, outputTokens: 2 }));
  assert.equal(read('usage-memory-scope')?.role, 'reviewer');
  assert.equal(read('usage-memory-scope')?.roleReason, 'scope');
  assert.equal(read('usage-memory-scope')?.channel, 'memory:learn');

  recordModelUsage({ sessionId: 'usage-memory-explicit', channel: 'memory:patterns', role: 'memory', model: 'm', inputTokens: 1, outputTokens: 1 });
  assert.equal(read('usage-memory-explicit')?.roleReason, 'explicit');
  assert.equal(read('usage-memory-explicit')?.usageKind, 'background');
});

test('a call that declares its own request never inherits the frame role or the frame prompt components', async () => {
  const { recordModelUsage, readUsageEventsForDate, withModelUsageAttribution, withOwnModelRequestAttribution } =
    await import('./usage-log.js');
  const source = `own-request-fixture-${Date.now()}`;
  const frame = { instructions: 5_000, toolSchemas: 40_000 };
  // What an adapter (BYO, Codex, Claude, headless CLI) passes: the ambient
  // harness measurement of the brain round in flight.
  const record = (responseId: string) => recordModelUsage({
    sessionId: source, model: 'fixture', cacheDialect: 'inclusive', inputTokens: 1_000, outputTokens: 5,
    responseId, framePromptComponents: frame,
  });
  withModelUsageAttribution({ sessionId: source, sourceUserSeq: 0, role: 'brain' }, () => {
    record('frame-round');
    withOwnModelRequestAttribution({}, () => record('nested-unlabelled'));
    withOwnModelRequestAttribution({ role: 'reviewer', channel: 'judge:fixture' }, () => record('nested-judge'));
  });
  const rows = new Map(readUsageEventsForDate().filter((row) => row.source === source).map((row) => [row.responseId, row]));
  assert.equal(rows.get('frame-round')?.role, 'brain');
  assert.equal(rows.get('frame-round')?.promptComponents?.toolSchemas, 40_000, 'the frame round keeps its measurement');
  assert.equal(rows.get('nested-unlabelled')?.role, undefined);
  assert.equal(rows.get('nested-unlabelled')?.roleReason, 'unset');
  assert.equal(rows.get('nested-unlabelled')?.promptComponents, undefined, 'no inherited measurement');
  assert.equal(rows.get('nested-judge')?.role, 'reviewer');
  assert.equal(rows.get('nested-judge')?.channel, 'judge:fixture');
  assert.equal(rows.get('nested-judge')?.promptComponents, undefined);
  for (const row of rows.values()) assert.equal(row.inputTokens, 1_000, 'provider totals are untouched');
});

test('a judge or interpretation made inside a memory job stays on the job lane with the job role', async () => {
  const { recordModelUsage, readUsageEventsForDate, withModelUsageAttribution, withOwnModelRequestAttribution } =
    await import('./usage-log.js');
  const source = `memory-job-own-request-${Date.now()}`;
  const record = (responseId: string) => recordModelUsage({
    sessionId: source, model: 'fixture', cacheDialect: 'inclusive', inputTokens: 700, outputTokens: 5, responseId,
  });
  // The checker's job (role reviewer) and the memory model's job (role memory).
  withModelUsageAttribution({ sessionId: source, sourceUserSeq: 0, channel: 'memory:verify', role: 'reviewer' }, () => {
    withOwnModelRequestAttribution({ role: 'reviewer', channel: 'judge:memory_fix' }, () => record('verify-judge'));
  });
  withModelUsageAttribution({ sessionId: source, sourceUserSeq: 0, channel: 'memory:learn', role: 'memory' }, () => {
    withOwnModelRequestAttribution({ role: 'reviewer', channel: 'judge:fixture' }, () => record('learn-judge'));
    withOwnModelRequestAttribution({ channel: 'semantic:fixture', promptComponents: { history: 40 } },
      () => record('learn-interpretation'));
  });
  // Outside any memory job, a declared lane still replaces an ordinary one.
  withModelUsageAttribution({ sessionId: source, sourceUserSeq: 0, channel: 'chat', role: 'brain' }, () => {
    withOwnModelRequestAttribution({ role: 'reviewer', channel: 'judge:fixture' }, () => record('chat-judge'));
  });
  const rows = new Map(readUsageEventsForDate().filter((row) => row.source === source).map((row) => [row.responseId, row]));
  assert.equal(rows.get('verify-judge')?.channel, 'memory:verify', 'the repair check is the verify job\'s work');
  assert.equal(rows.get('verify-judge')?.role, 'reviewer');
  assert.equal(rows.get('learn-judge')?.channel, 'memory:learn');
  assert.equal(rows.get('learn-judge')?.role, 'memory', 'the job scope names whose model does its thinking');
  assert.equal(rows.get('learn-interpretation')?.channel, 'memory:learn');
  assert.equal(rows.get('learn-interpretation')?.role, 'memory');
  assert.equal(rows.get('learn-interpretation')?.promptComponents?.history, 40, 'its own measurements still apply');
  assert.equal(rows.get('chat-judge')?.channel, 'judge:fixture');
  assert.equal(rows.get('chat-judge')?.role, 'reviewer');
});

test('a heartbeat scope is background usage, not unclassified', () => {
  assert.deepEqual(resolveUsageKind('watch:work-review'), { kind: 'background', reason: 'prefix:watch:' });
});

test('captured usage provenance keeps exact accounting A while a later B scope records it', async () => {
  const { captureModelUsageProvenance, readUsageEventsForDate } = await import('./usage-log.js');
  const { withWorkflowUsageAttribution } = await import('./workflow-usage-context.js');
  const a = { sessionId: 'sess-captured-usage-a', sourceUserSeq: 411, attemptId: 'attempt:usage-a',
    role: 'brain' as const, channel: 'chat', promptComponents: { instructions: 3 } };
  const captured = withModelUsageAttribution(a, captureModelUsageProvenance);
  a.sessionId = 'sess-mutated-usage-a'; a.promptComponents.instructions = 999;
  withWorkflowUsageAttribution('later-workflow', () => withModelUsageAttribution({ sessionId: 'sess-captured-usage-b',
    sourceUserSeq: 412, attemptId: 'attempt:usage-b', role: 'reviewer', channel: 'judge:later' }, () =>
    recordModelUsage({ callerProvenance: captured, sessionId: 'unknown', model: 'm', cacheDialect: 'inclusive',
      inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, responseId: 'captured-usage-a-response' })));
  const row = readUsageEventsForDate().find(r => r.responseId === 'captured-usage-a-response')!;
  assert.equal(row.source, 'sess-captured-usage-a');
  assert.equal(row.trace?.acceptedSource, 'sess-captured-usage-a:411');
  assert.equal(row.trace?.attemptId, 'attempt:usage-a');
  assert.equal(row.trace?.modelCallId, undefined, 'provider ID is never a local invocation ID on captured paths');
  assert.equal(row.role, 'brain'); assert.equal(row.channel, 'chat');
  assert.equal(row.promptComponents?.instructions, 3);
  assert.equal(row.cachedInputTokens, 4); assert.equal(row.totalTokens, 12);
});

test('captured-empty or forged provenance retains numeric rows without adopting later parent/workflow/model IDs', async () => {
  const { captureModelUsageProvenance, readUsageEventsForDate } = await import('./usage-log.js');
  const { withWorkflowUsageAttribution } = await import('./workflow-usage-context.js');
  const absent = captureModelUsageProvenance();
  for (const [label, token] of [['empty', absent], ['forged', { ...absent }]] as const) {
    withWorkflowUsageAttribution('late-owner', () => withModelUsageAttribution({ sessionId: 'unknown', sourceUserSeq: 0,
      usageJobId: 'memory:late-job', usageParentTurn: { sessionId: 'sess-late-parent', sourceUserSeq: 413 },
      role: 'reviewer', channel: 'judge:late', promptComponents: { history: 9 } }, () =>
      recordModelUsage({ callerProvenance: token, sessionId: 'unknown', model: 'm', cacheDialect: 'inclusive',
        inputTokens: 8, outputTokens: 2, responseId: `captured-${label}-response` })));
    const row = readUsageEventsForDate().find(r => r.responseId === `captured-${label}-response`)!;
    assert.equal(row.source, 'unknown'); assert.equal(row.trace?.acceptedSource, undefined);
    assert.equal(row.trace?.modelCallId, undefined); assert.equal(row.role, undefined);
    assert.equal(row.channel, undefined); assert.equal(row.promptComponents, undefined);
    assert.equal(row.inputTokens, 8); assert.equal(row.outputTokens, 2);
  }
  withWorkflowUsageAttribution('legacy-owner', () => recordModelUsage({ sessionId: 'unknown', model: 'm',
    inputTokens: 8, outputTokens: 2, responseId: 'legacy-still-aliases' }));
  const legacy = readUsageEventsForDate().find(r => r.responseId === 'legacy-still-aliases')!;
  assert.equal(legacy.source, 'workflow:legacy-owner'); assert.equal(legacy.trace?.modelCallId, 'legacy-still-aliases');
});

test('captured detached accounting parent/job and original workflow are whole immutable tuples', async () => {
  const { captureModelUsageProvenance, readUsageEventsForDate } = await import('./usage-log.js');
  const { withWorkflowUsageAttribution } = await import('./workflow-usage-context.js');
  const parent = { sessionId: 'sess-captured-parent', sourceUserSeq: 415, attemptId: 'attempt:captured-parent' };
  const captured = withModelUsageAttribution({ sessionId: 'memory', sourceUserSeq: 0, usageJobId: 'memory:owned-job',
    usageParentTurn: parent, role: 'memory' }, captureModelUsageProvenance);
  parent.sourceUserSeq = 416;
  recordModelUsage({ callerProvenance: captured, sessionId: 'unknown', model: 'm', inputTokens: 2, outputTokens: 1,
    responseId: 'captured-parent-response' });
  const row = readUsageEventsForDate().find(r => r.responseId === 'captured-parent-response')!;
  assert.equal(row.source, 'memory:owned-job'); assert.equal(row.trace?.acceptedSource, 'sess-captured-parent:415');
  assert.equal(row.trace?.attemptId, 'attempt:captured-parent');
  const workflow = withWorkflowUsageAttribution('original-workflow', captureModelUsageProvenance);
  withWorkflowUsageAttribution('later-workflow', () => recordModelUsage({ callerProvenance: workflow, sessionId: 'unknown',
    model: 'm', inputTokens: 2, outputTokens: 1, responseId: 'captured-workflow-response' }));
  assert.equal(readUsageEventsForDate().find(r => r.responseId === 'captured-workflow-response')?.source, 'workflow:original-workflow');
});

test('captured accounting rejects accessor/proxy nested state without reading or coercing it', async () => {
  const { captureModelUsageProvenance, readUsageEventsForDate } = await import('./usage-log.js');
  let hooks = 0;
  const accessor = { sessionId: 'sess-exotic-owner', sourceUserSeq: 419 };
  Object.defineProperty(accessor, 'promptComponents', { enumerable: true, get() { hooks++; throw new Error('private accessor'); } });
  const proxy = new Proxy({ sessionId: 'sess-exotic-owner', sourceUserSeq: 420 }, { ownKeys() { hooks++; throw new Error('private proxy'); } });
  for (const [label, value] of [['accessor', accessor], ['proxy', proxy]] as const) {
    const captured = withModelUsageAttribution(value, captureModelUsageProvenance);
    recordModelUsage({ callerProvenance: captured, sessionId: 'unknown', model: 'm', inputTokens: 2, outputTokens: 1,
      responseId: `captured-${label}-accounting` });
    assert.equal(readUsageEventsForDate().find(r => r.responseId === `captured-${label}-accounting`)?.source, 'unknown');
  }
  assert.equal(hooks, 0);
});


test('captured operational completion uses the sealed local call ID; provider ID and legacy behavior stay distinct', async () => {
  const { captureModelUsageProvenance, readUsageEventsForDate } = await import('./usage-log.js');
  const captured = captureModelUsageProvenance();
  const cases = [
    { source: 'usage-native-operational', responseId: 'provider-operational-id', trace: { modelCallId: 'local-operational-call' } },
    { source: 'usage-native-operational-empty', responseId: 'provider-operational-empty', trace: undefined },
    { source: 'usage-native-operational-forged', responseId: 'provider-operational-forged', trace: undefined, caller: { ...captured } },
    { source: 'usage-native-operational-invalid', responseId: 'provider-operational-invalid', trace: { modelCallId: 'invalid\nraw content' } },
  ];
  for (const fixture of cases) {
    recordModelUsage({ callerProvenance: 'caller' in fixture ? fixture.caller : captured, sessionId: fixture.source, responseId: fixture.responseId,
      trace: fixture.trace, model: 'm', inputTokens: 4, outputTokens: 1 });
    const row = readUsageEventsForDate().find(r => r.responseId === fixture.responseId)!;
    const operational = listOperationalEvents({ source: 'model', type: 'model_call_completed', sessionId: fixture.source, limit: 5 })[0]!;
    assert.equal(operational.modelCallId, row.trace?.modelCallId);
    assert.equal(operational.payload?.responseId, fixture.responseId);
    if (fixture.source !== 'usage-native-operational') assert.equal(operational.modelCallId, undefined);
  }
  recordModelUsage({ sessionId: 'usage-legacy-operational', responseId: 'legacy-provider-operational',
    model: 'm', inputTokens: 4, outputTokens: 1 });
  assert.equal(listOperationalEvents({ source: 'model', type: 'model_call_completed', sessionId: 'usage-legacy-operational', limit: 5 })[0]?.modelCallId,
    'legacy-provider-operational');
});

test('nominal memory origin overrides foreign adapter namespace without execution adoption', async () => {
  const api = await import('./usage-log.js');
  const origin = api.createMemoryAccountingOrigin({ sessionId: 'sess-original-memory', sourceUserSeq: 1701, attemptId: 'attempt:original-memory' });
  const context = { sessionId: 'sess-foreign-memory', sourceUserSeq: 1702, attemptId: 'attempt:foreign-memory',
    memoryAccountingOrigin: origin, usageJobId: 'memory:standing:owned-job', channel: 'memory:standing', role: 'reviewer' as const };
  await withModelUsageAttribution(context, async () => api.withOwnModelRequestAttribution({ role: 'brain' }, async () => {
    assert.equal(api.modelUsageAttributionStorage.getStore()!.sessionId, context.sessionId, 'selection scope remains actual B');
    const provenance = api.captureModelUsageProvenance();
    const observerScope = api.capturedModelUsageAttribution(provenance)!;
    assert.equal(observerScope.sessionId, ''); assert.deepEqual(observerScope.usageParentTurn, api.memoryAccountingParent(origin));
    withModelUsageAttribution({ sessionId: 'sess-drainer', sourceUserSeq: 1703 }, () => recordModelUsage({
      callerProvenance: provenance, sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq, attemptId: context.attemptId,
      model: 'memory-origin-model', inputTokens: 13, cachedInputTokens: 7, outputTokens: 3, cacheDialect: 'inclusive', responseId: 'memory-origin-response',
      trace: { acceptedSource: 'foreign:1702', logicalTurnId: 'turn:1702', attemptId: context.attemptId, activationId: 'foreign-activation', modelCallId: 'local-memory-call' },
    }));
  }));
  const row = api.readUsageEventsForDate().find(r => r.responseId === 'memory-origin-response')!;
  assert.equal(row.source, context.usageJobId); assert.equal(row.channel, 'memory:standing'); assert.equal(row.role, 'reviewer');
  assert.deepEqual(row.trace, { modelCallId: 'local-memory-call', acceptedSource: 'sess-original-memory:1701', logicalTurnId: 'turn:1701', attemptId: 'attempt:original-memory' });
  assert.equal(row.inputTokens, 13); assert.equal(row.cachedInputTokens, 7); assert.equal(row.outputTokens, 3);
  const operational = listOperationalEvents({ type: 'model_call_completed', limit: 100 }).find(r => r.modelCallId === 'local-memory-call')!;
  assert.equal(operational.sessionId, context.usageJobId);
});

test('unknown/serialized/accessor memory markers cannot acquire foreign trace or attempt', async () => {
  const api = await import('./usage-log.js'); let hooks = 0;
  for (const mode of ['empty', 'clone', 'getter', 'proxy', 'source-only'] as const) {
    const context: any = { sessionId: 'sess-foreign-marker', sourceUserSeq: 1800, attemptId: 'attempt:foreign-marker', usageJobId: `memory:standing:${mode}` };
    if (mode === 'getter') Object.defineProperty(context, 'memoryAccountingOrigin', { enumerable: true, get() { hooks++; throw new Error('must not read'); } });
    else context.memoryAccountingOrigin = mode === 'empty' ? api.createMemoryAccountingOrigin()
      : mode === 'source-only' ? api.createMemoryAccountingOrigin({ sessionId: 'sess-source-only', sourceUserSeq: 1801 }) : { kind: 'memory_accounting_origin' };
    const current = mode === 'proxy' ? new Proxy(context, { get() { hooks++; throw new Error('must not read'); } }) : context;
    const provenance = withModelUsageAttribution(current, () => api.captureMemoryModelUsageProvenance()); assert.ok(provenance);
    withModelUsageAttribution({ sessionId: 'later', sourceUserSeq: 1802 }, () => recordModelUsage({ callerProvenance: provenance,
      sessionId: 'sess-foreign-marker', sourceUserSeq: 1800, attemptId: 'attempt:foreign-marker',
      trace: { acceptedSource: 'sess-foreign-marker:1800', logicalTurnId: 'turn:1800', attemptId: 'attempt:foreign-marker', modelCallId: `local-${mode}` },
      model: 'memory-marker-test', responseId: `memory-marker-${mode}`, inputTokens: 2, outputTokens: 1 }));
    const row = api.readUsageEventsForDate().find(r => r.responseId === `memory-marker-${mode}`)!;
    assert.equal(row.trace?.modelCallId, `local-${mode}`);
    assert.equal(row.trace?.acceptedSource, mode === 'source-only' ? 'sess-source-only:1801' : undefined);
    assert.equal(row.trace?.attemptId, undefined); assert.equal(row.inputTokens, 2);
  }
  assert.equal(hooks, 0);
  assert.equal(withModelUsageAttribution({ sessionId: 'ordinary', sourceUserSeq: 2 }, () => api.captureMemoryModelUsageProvenance()), undefined);
});

test('direct memory bookkeeping rejects exotic marked contexts without unused session/job hooks', async () => {
  const api = await import('./usage-log.js'); let hooks = 0;
  for (const mode of ['session', 'job', 'channel', 'role', 'proxy'] as const) {
    const context: any = { sessionId: 'direct-foreign', sourceUserSeq: 2400, usageJobId: 'memory:standing:direct',
      channel: 'memory:standing', memoryAccountingOrigin: api.createMemoryAccountingOrigin({ sessionId: 'known-parent', sourceUserSeq: 2401, attemptId: 'attempt:known' }) };
    const key = { session: 'sessionId', job: 'usageJobId', channel: 'channel', role: 'role', proxy: 'sessionId' }[mode];
    if (mode !== 'proxy') Object.defineProperty(context, key, { enumerable: true, get() { hooks++; throw new Error('must not execute new hook'); } });
    const current = mode === 'proxy' ? new Proxy(context, { get() { hooks++; throw new Error('must not execute proxy'); }, ownKeys() { hooks++; throw new Error('must not inspect proxy'); } }) : context;
    assert.doesNotThrow(() => withModelUsageAttribution(current, () => recordModelUsage({
      sessionId: 'adapter-foreign', sourceUserSeq: 2402, attemptId: 'attempt:adapter-foreign',
      trace: { acceptedSource: 'adapter-foreign:2402', logicalTurnId: 'turn:2402', attemptId: 'attempt:adapter-foreign', modelCallId: `direct-local-${mode}` },
      model: 'direct-marker-test', responseId: `direct-marker-${mode}`, inputTokens: 6, outputTokens: 1, cacheDialect: 'inclusive',
    })));
    const row = api.readUsageEventsForDate().find(r => r.responseId === `direct-marker-${mode}`)!;
    assert.equal(row.source, 'unknown'); assert.equal(row.trace?.acceptedSource, undefined); assert.equal(row.trace?.attemptId, undefined);
    assert.equal(row.trace?.modelCallId, `direct-local-${mode}`); assert.equal(row.inputTokens, 6); assert.equal(row.outputTokens, 1);
  }
  assert.equal(hooks, 0);
});

/**
 * Run: npx tsx --test src/runtime/harness/boundary-judge.test.ts
 *
 * Cross-family BOUNDARY judge (Lane A Phase 1 — eval-as-harness).
 *
 * The per-turn completion / grounding / goal-fidelity checkers must not be
 * graded by the brain's OWN model family (the 2026 "coherence trap" — a Codex
 * brain checked by a Codex judge, or GLM by GLM under all_in, produces
 * correlated errors that inflate confidence without adding information). This
 * pins the PURE family decision (no provider/token dependency): given the brain
 * family + which families are logged in, the judge resolves to a CHEAP model
 * from a DIFFERENT family, or null (→ caller fails open same-family, tagged).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseBoundaryJudgeFamily } from './debate-model.js';
import {
  boundaryJudgeTimeoutMs,
  getJudgeMetricsSnapshot,
  judgeCrossFamilyEnabled,
  recordJudgeMetric,
  resetJudgeMetricsForTests,
  withJudgeTimeout,
} from './judge-family.js';

test('cross-family judging is DEFAULT ON (2026-07-12) with a =off kill-switch', () => {
  const prev = process.env.CLEMMY_JUDGE_CROSS_FAMILY;
  try {
    delete process.env.CLEMMY_JUDGE_CROSS_FAMILY;
    assert.equal(judgeCrossFamilyEnabled(), true, 'unset → default on (never self-grade)');
    process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
    assert.equal(judgeCrossFamilyEnabled(), false, '=off → kill-switch (single-provider domain)');
    process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'on';
    assert.equal(judgeCrossFamilyEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_JUDGE_CROSS_FAMILY;
    else process.env.CLEMMY_JUDGE_CROSS_FAMILY = prev;
  }
});

test('codex brain + both families → cheap CLAUDE judge (cross-family, the common-default fix)', () => {
  const t = chooseBoundaryJudgeFamily('codex', true, true);
  assert.equal(t?.provider, 'claude');
  assert.equal(t?.modelId, 'claude-haiku-4-5');
});

test('codex brain + only codex logged in → null (no different family → fail open, tagged self-judge)', () => {
  assert.equal(chooseBoundaryJudgeFamily('codex', false, true), null);
});

test('codex brain + only claude logged in → claude judge', () => {
  assert.equal(chooseBoundaryJudgeFamily('codex', true, false)?.provider, 'claude');
});

test('claude brain + both families → cheap CODEX (gpt-fast) judge (already cross-family today, now explicit)', () => {
  const t = chooseBoundaryJudgeFamily('claude', true, true);
  assert.equal(t?.provider, 'codex');
  assert.equal(t?.modelId, 'gpt-5.4-mini');
});

test('claude brain + only claude logged in → null (no different family → fail open)', () => {
  assert.equal(chooseBoundaryJudgeFamily('claude', true, false), null);
});

test('byo (GLM all_in) brain + both → prefers cheap CLAUDE (the all_in self-judge fix)', () => {
  assert.equal(chooseBoundaryJudgeFamily('byo', true, true)?.provider, 'claude');
});

test('byo brain + only codex → codex judge (any different family beats self-grading)', () => {
  const t = chooseBoundaryJudgeFamily('byo', false, true);
  assert.equal(t?.provider, 'codex');
  assert.equal(t?.modelId, 'gpt-5.4-mini');
});

test('byo brain + no flagship logged in → null (fail open same-family, tagged)', () => {
  assert.equal(chooseBoundaryJudgeFamily('byo', false, false), null);
});

test('boundaryJudgeTimeoutMs defaults to a bounded hot-path cap and rejects tiny overrides', () => {
  const prev = process.env.CLEMMY_BOUNDARY_JUDGE_TIMEOUT_MS;
  try {
    delete process.env.CLEMMY_BOUNDARY_JUDGE_TIMEOUT_MS;
    assert.equal(boundaryJudgeTimeoutMs(), 25000);
    process.env.CLEMMY_BOUNDARY_JUDGE_TIMEOUT_MS = '250';
    assert.equal(boundaryJudgeTimeoutMs(), 25000);
    process.env.CLEMMY_BOUNDARY_JUDGE_TIMEOUT_MS = '1500';
    assert.equal(boundaryJudgeTimeoutMs(), 1500);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_BOUNDARY_JUDGE_TIMEOUT_MS;
    else process.env.CLEMMY_BOUNDARY_JUDGE_TIMEOUT_MS = prev;
  }
});

test('withJudgeTimeout returns null instead of waiting for a hung judge', async () => {
  const never = new Promise<string>(() => {});
  const t0 = Date.now();
  const result = await withJudgeTimeout(never, 5);
  assert.equal(result, null);
  assert.ok(Date.now() - t0 < 1000, 'timeout returned promptly');
});

test('judge metrics snapshot aggregates outcomes and latency by lane', () => {
  resetJudgeMetricsForTests();
  try {
    recordJudgeMetric({
      lane: 'completion',
      outcome: 'passed',
      durationMs: 101.2,
      modelId: 'claude-haiku-4-5',
      judgeFamily: 'claude',
      brainFamily: 'codex',
      selfJudge: false,
    });
    recordJudgeMetric({
      lane: 'completion',
      outcome: 'blocked',
      durationMs: 299.8,
      modelId: 'claude-haiku-4-5',
      judgeFamily: 'claude',
      brainFamily: 'codex',
      selfJudge: false,
    });
    recordJudgeMetric({
      lane: 'output_grounding',
      outcome: 'advisory',
      durationMs: 50,
      modelId: 'gpt-5.4-mini',
      judgeFamily: 'codex',
      brainFamily: 'claude',
      selfJudge: false,
    });

    const snapshot = getJudgeMetricsSnapshot();
    assert.equal(snapshot.total.calls, 3);
    assert.equal(snapshot.total.passed, 1);
    assert.equal(snapshot.total.blocked, 1);
    assert.equal(snapshot.total.advisory, 1);
    assert.equal(snapshot.total.avgMs, 150);
    assert.equal(snapshot.total.maxMs, 300);

    const completion = snapshot.lanes.find((lane) => lane.lane === 'completion');
    assert.equal(completion?.calls, 2);
    assert.equal(completion?.avgMs, 201);
    assert.equal(completion?.lastOutcome, 'blocked');
    assert.equal(completion?.lastModelId, 'claude-haiku-4-5');
  } finally {
    resetJudgeMetricsForTests();
  }
  assert.equal(getJudgeMetricsSnapshot().total.calls, 0);
});

test('boundary downshift: a heavyweight judge PIN governs family only on the hot path (2026-07-07 opus-timeout regression)', async () => {
  const { downshiftForBoundary } = await import('./debate-model.js');
  const mk = (provider: 'claude' | 'codex' | 'byo', modelId: string) => ({ provider, modelId, source: 'settings' }) as never;
  // Heavyweights downshift to the family's cheap boundary id.
  assert.equal(downshiftForBoundary(mk('claude', 'claude-opus-4-8')).modelId, 'claude-haiku-4-5');
  assert.notEqual(downshiftForBoundary(mk('codex', 'gpt-5.5')).modelId, 'gpt-5.5');
  // Fast/cheap pins pass through untouched — the user's choice is honored.
  assert.equal(downshiftForBoundary(mk('claude', 'claude-sonnet-5')).modelId, 'claude-sonnet-5');
  assert.equal(downshiftForBoundary(mk('codex', 'gpt-5.4-mini')).modelId, 'gpt-5.4-mini');
  // BYO judges are never downshifted (their tiers are unknowable here).
  assert.equal(downshiftForBoundary(mk('byo', 'glm-5.2')).modelId, 'glm-5.2');
});

// ─── Hedged judge (tail-latency insurance, 2026-07-08 degraded-network fix) ───

test('withJudgeHedge: fast primary wins, hedge never fires (zero extra cost on the healthy path)', async () => {
  const { withJudgeHedge } = await import('./judge-family.js');
  let hedgeStarted = false;
  const r = await withJudgeHedge(
    async () => 'primary-verdict',
    async () => { hedgeStarted = true; return 'hedge-verdict'; },
    { hedgeDelayMs: 50, timeoutMs: 1000 },
  );
  assert.equal(r.value, 'primary-verdict');
  assert.equal(r.winner, 'primary');
  assert.equal(r.hedgeFired, false);
  assert.equal(hedgeStarted, false);
});

test('withJudgeHedge: slow primary → hedge fires at the delay and its verdict wins', async () => {
  const { withJudgeHedge } = await import('./judge-family.js');
  const slow = () => new Promise<string>((resolve) => { setTimeout(() => resolve('late'), 500); });
  const t0 = Date.now();
  const r = await withJudgeHedge(slow, async () => 'hedge-verdict', { hedgeDelayMs: 20, timeoutMs: 1000 });
  assert.equal(r.value, 'hedge-verdict');
  assert.equal(r.winner, 'hedge');
  assert.equal(r.hedgeFired, true);
  assert.ok(Date.now() - t0 < 400, 'did not wait out the slow primary');
});

test('withJudgeHedge: primary dies before the delay → hedge starts immediately (no dead air)', async () => {
  const { withJudgeHedge } = await import('./judge-family.js');
  const t0 = Date.now();
  const r = await withJudgeHedge(
    async () => { throw new Error('transport'); },
    async () => 'hedge-verdict',
    { hedgeDelayMs: 5000, timeoutMs: 8000 },
  );
  assert.equal(r.value, 'hedge-verdict');
  assert.equal(r.winner, 'hedge');
  assert.ok(Date.now() - t0 < 1000, 'hedge fired without waiting for the hedge delay');
  assert.equal(r.errors.length, 1);
});

test('withJudgeHedge: both attempts fail → null value with the errors surfaced for classification', async () => {
  const { withJudgeHedge } = await import('./judge-family.js');
  const r = await withJudgeHedge(
    async () => { throw new Error('a'); },
    async () => { throw new Error('b'); },
    { hedgeDelayMs: 10, timeoutMs: 500 },
  );
  assert.equal(r.value, null);
  assert.equal(r.winner, null);
  assert.equal(r.errors.length, 2);
});

test('withJudgeHedge: pure deadline miss (both hung) → null with NO errors (classified timeout)', async () => {
  const { withJudgeHedge } = await import('./judge-family.js');
  const hang = () => new Promise<string>(() => {});
  const t0 = Date.now();
  const r = await withJudgeHedge(hang, hang, { hedgeDelayMs: 5, timeoutMs: 60 });
  assert.equal(r.value, null);
  assert.equal(r.errors.length, 0);
  assert.equal(r.hedgeFired, true);
  assert.ok(Date.now() - t0 < 1000);
});

test('withJudgeHedge: no hedge available → primary-only, still bounded by the deadline', async () => {
  const { withJudgeHedge } = await import('./judge-family.js');
  const hang = () => new Promise<string>(() => {});
  const r = await withJudgeHedge(hang, null, { hedgeDelayMs: 5, timeoutMs: 40 });
  assert.equal(r.value, null);
  assert.equal(r.hedgeFired, false);
});

test('withJudgeHedge: kill-switch CLEMMY_JUDGE_HEDGE=off runs unhedged', async () => {
  const { withJudgeHedge } = await import('./judge-family.js');
  const prev = process.env.CLEMMY_JUDGE_HEDGE;
  try {
    process.env.CLEMMY_JUDGE_HEDGE = 'off';
    let hedgeStarted = false;
    const slow = () => new Promise<string>((resolve) => { setTimeout(() => resolve('late-primary'), 100); });
    const r = await withJudgeHedge(slow, async () => { hedgeStarted = true; return 'hedge'; }, { hedgeDelayMs: 5, timeoutMs: 2000 });
    assert.equal(r.value, 'late-primary');
    assert.equal(hedgeStarted, false);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_JUDGE_HEDGE;
    else process.env.CLEMMY_JUDGE_HEDGE = prev;
  }
});

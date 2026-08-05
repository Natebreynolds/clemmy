/**
 * Run: npx tsx --test src/runtime/usage-final-closeout.test.ts
 *
 * E0 red suite — usage/trace/budget findings 12-19 from the final North-Star
 * audit, pinned at REQUIRED behavior. Red at ac9ae24c; the permanent contract
 * once Stage E2 lands.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalCacheAccounting, uncachedTokensForAccrual } from './usage-log.js';
import {
  createBudgetMeter,
  sealBudgetContract,
  type RuntimeBudgetCeilings,
} from './budget-contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CEILINGS: RuntimeBudgetCeilings = {
  uncachedInputTokens: 10_000, outputTokens: 2_000, modelCalls: 5, toolCalls: 5,
  discoveryCalls: 1, validationRepairs: 1, retries: 2, artifactBytes: 1_000_000,
  artifactCount: 10, expansions: 0, effects: 0, elapsedMs: 60_000, concurrency: 2,
};

function meter(previous?: ReturnType<ReturnType<typeof meterOnly>['snapshot']>) {
  const sealed = sealBudgetContract(CEILINGS);
  assert.equal(sealed.ok, true);
  return createBudgetMeter((sealed as Extract<typeof sealed, { ok: true }>).contract, previous);
}
function meterOnly() { return meter(); }

// ─── Finding 12: invalid usage must never be free ────────────────────────────

test('F12: invalid or contradictory usage never becomes a zero debit — unknown charges a conservative finite floor or parks', () => {
  // A declared-inclusive sample whose numbers contradict the dialect is
  // INVALID. It must not accrue zero uncached work: zero is free budget for
  // exactly the samples least worth trusting.
  const contradictory = {
    cacheDialect: 'inclusive' as const,
    inputTokens: 100, cachedInputTokens: 900, outputTokens: 50, totalTokens: 950,
  };
  const canonical = canonicalCacheAccounting(contradictory);
  assert.equal(canonical.invalid, true);
  const debit = uncachedTokensForAccrual(contradictory);
  assert.ok(debit >= 950,
    `an invalid sample was debited ${debit} — a conservative finite floor from trustworthy fields is required, never zero`);

  const garbage = { cacheDialect: 'inclusive' as const, inputTokens: Number.NaN, outputTokens: 500, totalTokens: 500 };
  assert.ok(uncachedTokensForAccrual(garbage) >= 500,
    'a NaN input zeroed the whole sample although output was a trustworthy finite field');
});

// ─── Finding 13: durable idempotent charge identity ──────────────────────────

test('F13: chargeOnce identity survives a continuation snapshot — a logical retry is charged exactly once across activations', () => {
  const first = meter();
  assert.equal(first.chargeOnce('retries', 'attempt-7', 1).ok, true);
  const snapshot = first.snapshot();

  const continuation = meter(snapshot);
  continuation.chargeOnce('retries', 'attempt-7', 1); // the SAME logical retry
  assert.equal(continuation.lifetime('retries'), 1,
    'the continuation re-charged a retry the previous activation already charged — charge identity must be durable in the snapshot');
});

// ─── Finding 14: no NUL bytes in tracked source ──────────────────────────────

test('F14: no tracked TypeScript source contains a literal NUL byte', () => {
  // The concrete finding: budget-contract.ts used a raw NUL separator and Git
  // treats the file as binary. The E0 gate scans the runtime sources.
  const offenders: string[] = [];
  const scan = (file: string): void => {
    const bytes = readFileSync(file);
    if (bytes.includes(0)) offenders.push(path.relative(HERE, file));
  };
  scan(path.join(HERE, 'budget-contract.ts'));
  scan(path.join(HERE, 'usage-log.ts'));
  scan(path.join(HERE, 'trace-envelope.ts'));
  assert.deepEqual(offenders, [], `tracked source contains NUL bytes: ${offenders.join(', ')}`);
});

// ─── Finding 15: efficiency report cannot print impossible percentages ───────

test('F15: the efficiency report derives cache rates from canonical prompt tokens — an exclusive fixture reports 90%, never 900%', () => {
  const source = readFileSync(path.join(HERE, '..', '..', 'scripts', 'measure-efficiency.ts'), 'utf-8');
  // The audited defect: pct(cachedInputTokens, inputTokens) divides canonical
  // cached tokens by RAW input, which for exclusive dialects can exceed 100%.
  assert.equal(/pct\(\s*v\.cachedInputTokens\s*,\s*v\.inputTokens\s*\)/.test(source), false,
    'measure:efficiency still divides cached tokens by raw input — an exclusive sample displays 900% instead of canonical 90%');
  assert.match(source, /promptTokens/,
    'measure:efficiency does not consume canonical prompt tokens at all');
});

// ─── Finding 16: every recorder declares provenance ──────────────────────────

test('F16: the raw Claude recorder declares its cache dialect and guest Codex usage is parsed and metered', () => {
  const claudeModel = readFileSync(path.join(HERE, 'harness', 'claude-model.ts'), 'utf-8');
  assert.match(claudeModel, /cacheDialect:\s*'(inclusive|exclusive|none)'/,
    'claude-model.ts records usage with no declared cache dialect — its samples are permanently uncertifiable');

  const guest = readFileSync(path.join(HERE, '..', 'execution', 'guest-harness.ts'), 'utf-8');
  // The audited defect: only the Claude-shaped result event is parsed for
  // usage; a Codex guest run is silently unmetered.
  assert.match(guest, /codex[\s\S]{0,400}(token_usage|usage|input_tokens)/i,
    'guest-harness.ts parses no Codex usage — Codex guest runs accrue nothing');
});

// ─── Finding 17: trace envelopes reach production boundaries ─────────────────

test('F17: at least one production model boundary threads a trace envelope into recordModelUsage', () => {
  const producers = [
    path.join(HERE, 'codex-native-runtime.ts'),
    path.join(HERE, 'harness', 'codex-model.ts'),
    path.join(HERE, 'harness', 'claude-agent-sdk.ts'),
    path.join(HERE, 'harness', 'claude-headless-model.ts'),
    path.join(HERE, 'harness', 'byo-model.ts'),
  ];
  const threaded = producers.filter((file) => /trace\s*:/.test(readFileSync(file, 'utf-8')));
  assert.ok(threaded.length > 0,
    'no production model adapter threads a trace envelope — trace identity exists only in the dormant read lane');
});

// ─── Finding 18: concurrency is occupancy, not cumulative spend ──────────────

test('F18: concurrency is acquire/release occupancy with a high-water mark — sequential work cannot exhaust it', () => {
  const budget = meter();
  const meterWithOccupancy = budget as unknown as {
    acquireConcurrency?: (amount: number) => { ok: boolean };
    releaseConcurrency?: (amount: number) => void;
  };
  assert.equal(typeof meterWithOccupancy.acquireConcurrency, 'function',
    'the budget meter has no occupancy semantics — concurrency is modeled as cumulative forever-spend');
  // Three sequential units under a ceiling of 2: always one in flight, never
  // more than one occupied — must succeed forever.
  for (let i = 0; i < 3; i += 1) {
    const acquired = meterWithOccupancy.acquireConcurrency!(1);
    assert.equal(acquired.ok, true, `sequential occupancy exhausted at iteration ${i}`);
    meterWithOccupancy.releaseConcurrency!(1);
  }
});

// ─── Finding 19: the read lane debits every owned resource ───────────────────

test('F19: the read lane debits tokens, elapsed time, and artifacts — not only call counts', () => {
  const laneSource = readFileSync(path.join(HERE, 'read-path', 'read-lane.ts'), 'utf-8');
  for (const resource of ['uncachedInputTokens', 'elapsedMs']) {
    assert.match(laneSource, new RegExp(`debit\\(\\s*'${resource}'`),
      `the read lane never debits ${resource} — the budget contract exists but the lane spends outside it`);
  }
});

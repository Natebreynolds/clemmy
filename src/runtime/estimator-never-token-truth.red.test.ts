/**
 * GUARD PIN — prompt-estimator telemetry is never provider token truth.
 *
 * Invariant: assembly-time estimates (promptComponents, the hardcoded
 * per-tool-schema figure from prompt-composition) travel in the usage record
 * ONLY as observability. The canonical token block, the session accrual
 * debit, and every certified sum derive exclusively from PROVIDER-reported
 * fields normalized through canonicalCacheAccounting. This is compliant
 * today; these guards keep the telemetry-separation fix from ever promoting
 * an estimate into token truth.
 *
 * Run: npx tsx --test src/runtime/estimator-never-token-truth.red.test.ts
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-estimator-never-truth-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const usageLog = await import('./usage-log.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('guard: the canonical token block derives from provider fields even when estimator components are wildly inflated', () => {
  usageLog.recordModelUsage({
    sessionId: 'sess-estimator-guard',
    model: 'claude-sonnet-5',
    cacheDialect: 'inclusive',
    inputTokens: 100,
    cachedInputTokens: 60,
    outputTokens: 10,
    totalTokens: 110,
    // Assembly-time estimates, deliberately absurd: if any token-truth path
    // consulted them, the canonical block below would move.
    promptComponents: { toolSchemas: 1_000_000, systemPrompt: 500_000 },
  });

  const usageDir = path.join(TMP_HOME, 'state', 'token-usage');
  const files = readdirSync(usageDir).filter((name) => name.endsWith('.ndjson'));
  assert.equal(files.length, 1, 'fixture: exactly one usage file');
  const rows = readFileSync(path.join(usageDir, files[0]), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const row = rows.find((entry) => entry.source === 'sess-estimator-guard');
  assert.ok(row, 'fixture: the usage row was recorded');

  assert.deepEqual(
    row.canonical,
    {
      certified: true,
      promptTokens: 100,
      cachedReadTokens: 60,
      uncachedInputTokens: 40,
      uncachedWorkTokens: 50,
    },
    'the canonical block is the provider truth: inclusive dialect, input 100 / cached 60 / output 10 — untouched by the 1.5M-token estimate',
  );
  assert.equal(row.inputTokens, 100, 'raw provider fields persist unaltered');
  const components = row.promptComponents as Record<string, number>;
  assert.equal(components.toolSchemas, 1_000_000, 'estimates stay visible as observability, never deleted');
});

test('guard: canonicalCacheAccounting has no estimator input — identical provider fields yield identical truth', () => {
  const providerOnly = usageLog.canonicalCacheAccounting({
    cacheDialect: 'inclusive',
    inputTokens: 100,
    cachedInputTokens: 60,
    outputTokens: 10,
    totalTokens: 110,
  });
  assert.equal(providerOnly.promptTokens, 100);
  assert.equal(providerOnly.uncachedInputTokens, 40);
  assert.equal(providerOnly.certified, true);
});

test('guard: reconciling estimator components never rewrites the provider input figure', () => {
  const reconciled = usageLog.reconcilePromptComponents({ toolSchemas: 120, systemPrompt: 30 }, 1000);
  assert.ok(reconciled);
  assert.equal(reconciled.toolSchemas, 120);
  assert.equal(
    reconciled.providerAndToolOverhead,
    850,
    'the estimator gap to provider input is made explicit as a remainder, not hidden by adjusting either side',
  );
});

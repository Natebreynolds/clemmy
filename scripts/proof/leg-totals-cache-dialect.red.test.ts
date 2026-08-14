/**
 * RED PIN — leg token totals must be cache-dialect-aware.
 *
 * Invariant: provider-reported cached vs uncached tokens are separated in ONE
 * convention. Each usage NDJSON row declares its adapter's cacheDialect:
 * 'inclusive' (inputTokens already contain the cached reads) or 'exclusive'
 * (raw Anthropic lane: inputTokens are the UNCACHED input, cached reads ride
 * beside them). The canonical normalization exists (canonicalCacheAccounting,
 * src/runtime/usage-log.ts) and the per-session comparator already certifies
 * these exact numbers — but the cross-version cost basis (leg-totals) reads
 * the raw fields and silently assumes the inclusive convention, so a leg
 * mixing dialects under-reports gross prompt, over-reports nothing as
 * uncached, and can state an arithmetically impossible cache hit ratio > 1.
 *
 * Fixture: one inclusive row {input 100, cached 60} and one exclusive row
 * {input 20, cached 80}. Canonical answer: promptTokens 200, cachedRead 140,
 * uncached 60, hitRatio 0.7 — the same certified split the session comparator
 * pins for identical rows (scripts/session-comparison.test.ts).
 *
 * Run: npx tsx --test scripts/proof/leg-totals-cache-dialect.red.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { legTotalsForHome, type LegTokenTotals } from './leg-totals.js';

function mixedDialectHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'leg-totals-dialect-'));
  const usageDir = path.join(home, 'state', 'token-usage');
  mkdirSync(usageDir, { recursive: true });
  const rows = [
    {
      at: '2026-08-10T10:00:00.000Z',
      source: 'sess-leg',
      kind: 'chat',
      model: 'inclusive-model',
      cacheDialect: 'inclusive',
      inputTokens: 100,
      cachedInputTokens: 60,
      cacheCreationInputTokens: 0,
      outputTokens: 10,
      totalTokens: 110,
    },
    {
      at: '2026-08-10T10:00:01.000Z',
      source: 'sess-leg',
      kind: 'chat',
      model: 'exclusive-model',
      cacheDialect: 'exclusive',
      inputTokens: 20,
      cachedInputTokens: 80,
      cacheCreationInputTokens: 0,
      outputTokens: 5,
      totalTokens: 105,
    },
  ];
  writeFileSync(
    path.join(usageDir, '2026-08-10.ndjson'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
  return home;
}

function withMixedDialectTotals(run: (totals: LegTokenTotals) => void): void {
  const home = mixedDialectHome();
  try {
    run(legTotalsForHome({ home }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('a mixed-dialect leg never reports an arithmetically impossible cache hit ratio', () => {
  withMixedDialectTotals((totals) => {
    assert.ok(
      totals.cacheHitRatio <= 1,
      'cacheHitRatio must be cachedRead over the GROSS prompt in one convention; '
      + `dialect-blind arithmetic produced ${totals.cacheHitRatio} (cachedRead 140 / raw input 120), which is not a ratio of anything real`,
    );
  });
});

test('mixed inclusive+exclusive rows produce the canonical cache-accounting split', () => {
  withMixedDialectTotals((totals) => {
    assert.equal(
      totals.uncachedInputTokens,
      60,
      'uncached input must follow each row\'s DECLARED dialect (inclusive: input - cached = 40; exclusive: input IS uncached = 20); '
      + 'raw max(0, input - cached) collapses the whole leg to 0',
    );
    const grossPrompt = (totals as LegTokenTotals & { promptTokens?: number }).promptTokens
      ?? totals.inputTokens;
    assert.equal(
      grossPrompt,
      200,
      'gross prompt (cached + uncached, one convention) is 100 inclusive + (20 + 80) exclusive = 200',
    );
    assert.equal(totals.cachedReadTokens, 140, 'cached reads are 60 + 80 in either convention');
    assert.ok(
      Math.abs(totals.cacheHitRatio - 0.7) < 1e-9,
      `cacheHitRatio must be 140 / 200 = 0.7, got ${totals.cacheHitRatio}`,
    );
  });
});

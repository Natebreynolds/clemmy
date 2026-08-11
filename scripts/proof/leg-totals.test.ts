/**
 * Leg-total accounting self-tests over a synthetic ndjson home, pinning the
 * properties the cost basis depends on: every record counts (unknown-source
 * INCLUDED), the four billing classes split correctly, quiesce spend is in the
 * total but visible on its own line, and truncation marks a floor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { computeLegTotals, legTotalsForHome, parseUsageLine, readUsageRecords } from './leg-totals.js';

function record(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    at: '2026-08-10T10:00:00.000Z',
    source: 'sess-test',
    kind: 'chat',
    model: 'claude-sonnet-5',
    inputTokens: 1000,
    cachedInputTokens: 800,
    cacheCreationInputTokens: 50,
    outputTokens: 100,
    totalTokens: 1100,
    ...overrides,
  });
}

test('parseUsageLine tolerates junk and missing fields', () => {
  assert.equal(parseUsageLine(''), null);
  assert.equal(parseUsageLine('not json'), null);
  assert.equal(parseUsageLine('42'), null);
  assert.equal(parseUsageLine('{"noAt":true}'), null);
  const minimal = parseUsageLine('{"at":"2026-08-10T00:00:00Z","inputTokens":10,"outputTokens":5}');
  assert.ok(minimal);
  assert.equal(minimal.totalTokens, 15);
  assert.equal(minimal.source, 'unknown');
  assert.equal(minimal.model, '(unknown)');
});

test('totals: classes split, unknown-source included, quiesce visible', () => {
  const records = [
    parseUsageLine(record({ at: '2026-08-10T10:00:00Z' }))!,
    parseUsageLine(record({
      at: '2026-08-10T10:01:00Z',
      source: 'unknown',
      model: 'glm-5.2',
      inputTokens: 500,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 50,
      totalTokens: 550,
    }))!,
    // Post-terminal sidecar record.
    parseUsageLine(record({
      at: '2026-08-10T10:10:00Z',
      model: 'claude-haiku-4-5',
      inputTokens: 200,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 20,
      totalTokens: 220,
    }))!,
  ];
  const totals = computeLegTotals({ records, terminalAt: '2026-08-10T10:05:00Z' });
  assert.equal(totals.totalTokens, 1100 + 550 + 220);
  assert.equal(totals.recordCount, 3);
  assert.equal(totals.cachedReadTokens, 800);
  assert.equal(totals.cacheCreationTokens, 50);
  assert.equal(totals.uncachedInputTokens, 1000 + 500 + 200 - 800);
  assert.equal(totals.unattributedTokens, 550);
  assert.equal(totals.unattributedRecords, 1);
  assert.ok(Math.abs(totals.unattributedShare - 550 / 1870) < 1e-9);
  assert.equal(totals.preTerminalTokens, 1100 + 550);
  assert.equal(totals.quiesceTokens, 220, 'post-terminal spend is captured');
  assert.equal(totals.preTerminalTokens + totals.quiesceTokens, totals.totalTokens);
  assert.equal(totals.byModel['claude-haiku-4-5'], 220);
  assert.equal(totals.quiesceTruncated, false);
});

test('window bounds are since-inclusive, until-exclusive', () => {
  const records = [
    parseUsageLine(record({ at: '2026-08-09T23:59:59Z', totalTokens: 1 }))!,
    parseUsageLine(record({ at: '2026-08-10T00:00:00Z', totalTokens: 2 }))!,
    parseUsageLine(record({ at: '2026-08-11T00:00:00Z', totalTokens: 4 }))!,
  ];
  const totals = computeLegTotals({
    records,
    sinceIso: '2026-08-10T00:00:00Z',
    untilIso: '2026-08-11T00:00:00Z',
  });
  assert.equal(totals.totalTokens, 2);
  assert.equal(totals.recordCount, 1);
});

test('quiesceTruncated marks the total as a floor', () => {
  const totals = computeLegTotals({
    records: [parseUsageLine(record({}))!],
    quiesceTruncated: true,
  });
  assert.equal(totals.quiesceTruncated, true);
});

test('legTotalsForHome reads every ndjson in the home and counts invalid lines', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'leg-totals-test-'));
  try {
    const usageDir = path.join(home, 'state', 'token-usage');
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(
      path.join(usageDir, '2026-08-10.ndjson'),
      `${record({ totalTokens: 100, inputTokens: 90, outputTokens: 10, cachedInputTokens: 0, cacheCreationInputTokens: 0 })}\nnot-json\n`,
    );
    writeFileSync(
      path.join(usageDir, '2026-08-11.ndjson'),
      `${record({ at: '2026-08-11T00:00:01Z', totalTokens: 200, inputTokens: 150, outputTokens: 50, cachedInputTokens: 0, cacheCreationInputTokens: 0 })}\n`,
    );
    const totals = legTotalsForHome({ home });
    assert.equal(totals.totalTokens, 300);
    assert.equal(totals.recordCount, 2);
    assert.equal(totals.invalidLines, 1);
    assert.equal(totals.firstRecordAt, '2026-08-10T10:00:00.000Z');
    assert.equal(totals.lastRecordAt, '2026-08-11T00:00:01Z');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('missing usage dir yields zeroed totals, never a throw', () => {
  const totals = legTotalsForHome({ home: path.join(os.tmpdir(), 'nonexistent-home-xyz') });
  assert.equal(totals.totalTokens, 0);
  assert.equal(totals.recordCount, 0);
});

test('readUsageRecords sorts files so record order is stable', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'leg-totals-order-'));
  try {
    const usageDir = path.join(home, 'usage');
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(path.join(usageDir, 'b.ndjson'), `${record({ at: '2026-08-11T00:00:00Z' })}\n`);
    writeFileSync(path.join(usageDir, 'a.ndjson'), `${record({ at: '2026-08-10T00:00:00Z' })}\n`);
    const { records } = readUsageRecords(usageDir);
    assert.equal(records.length, 2);
    assert.equal(records[0].at, '2026-08-10T00:00:00Z');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

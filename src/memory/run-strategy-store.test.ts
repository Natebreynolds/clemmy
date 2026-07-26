import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolation: this store writes under BASE_DIR — pin a temp CLEMENTINE_HOME
// BEFORE importing anything that reads BASE_DIR (test-hygiene rule 2026-07-22).
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-strategy-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  getRunStrategyLearningStats,
  recordRunStrategy,
  renderRunStrategiesForContext,
  strategyKeywords,
} = await import('./run-strategy-store.js');
const { evaluateLearningCandidate } = await import('./learning-receipt.js');

function receipt(sourceId: string) {
  return evaluateLearningCandidate({
    target: 'strategy',
    authority: 'background_delivery_verifier',
    sessionId: `background:${sourceId}`,
    sourceId,
    terminalSuccess: true,
    controllerValidation: true,
  }).receipt!;
}

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('keywords: content words survive, stopwords and short tokens do not', () => {
  const kw = strategyKeywords('Research these 4 personal injury law firms and build a comparison table');
  assert.ok(kw.includes('research') && kw.includes('injury') && kw.includes('comparison'));
  assert.ok(!kw.includes('the') && !kw.includes('and') && !kw.includes('a'));
});

test('record + recall: a similar objective recalls the proven shape, unrelated does not', () => {
  const rec = recordRunStrategy({
    objective: 'Research 6 personal injury law firm websites and build a comparison table',
    toolsUsed: ['composio_execute_tool', 'run_worker', 'write_file'],
    workerCount: 6,
    durationMs: 11 * 60_000,
    learningReceipt: receipt('run-1'),
  });
  assert.ok(rec, 'record persists');
  const hit = renderRunStrategiesForContext('research personal injury law firms comparison');
  assert.match(hit, /run_worker/);
  assert.match(hit, /fan-out 6 workers/);
  assert.match(hit, /~11 min/);
  assert.equal(renderRunStrategiesForContext('compose a birthday song for grandma'), '', 'unrelated objective renders nothing');
  assert.equal(renderRunStrategiesForContext(''), '', 'empty objective renders nothing');
});

test('near-duplicate objectives accumulate evidence instead of new rows', () => {
  const again = recordRunStrategy({
    objective: 'Research 8 personal injury law firm websites and build a comparison table',
    toolsUsed: ['composio_execute_tool', 'run_worker'],
    workerCount: 8,
    durationMs: 9 * 60_000,
    learningReceipt: receipt('run-2'),
  });
  assert.ok(again);
  assert.equal(again.uses, 2, 'evidence accumulated on the existing record');
  assert.match(renderRunStrategiesForContext('personal injury firm research comparison'), /proven 2×/);
});

test('runs that used no real tools teach nothing', () => {
  assert.equal(recordRunStrategy({
    objective: 'idle chat about weather',
    toolsUsed: [],
    workerCount: 0,
    durationMs: 1000,
    learningReceipt: receipt('idle'),
  }), null);
});

test('deliverable memory: recall answers "where did we put it" (the 2026-07-23 mailbox-guess class)', async () => {
  const rec = recordRunStrategy({
    objective: 'Write 30 personalized AI-search emails for market leader accounts',
    toolsUsed: ['composio_execute_tool', 'write_file'],
    workerCount: 0,
    durationMs: 8 * 60_000,
    deliverable: '/Users/example/Desktop/ML-30-AI-Search-Drafts.md',
    learningReceipt: receipt('run-3'),
  });
  assert.ok(rec);
  const hit = renderRunStrategiesForContext('find those 30 emails we drafted for market leaders');
  assert.match(hit, /→ produced \/Users\/example\/Desktop\/ML-30-AI-Search-Drafts\.md/);
});

test('legacy strategy records stay on disk for audit but cannot steer a future run', () => {
  const storePath = path.join(TMP_HOME, 'state', 'run-strategies.json');
  const store = JSON.parse(readFileSync(storePath, 'utf-8')) as {
    version: 'v1';
    strategies: Array<Record<string, unknown>>;
  };
  store.strategies.push({
    id: 'legacy-false-green',
    objective: 'Compile an exotic orchid greenhouse inventory',
    keywords: ['compile', 'exotic', 'orchid', 'greenhouse', 'inventory'],
    toolsUsed: ['write_file'],
    workerCount: 120,
    durationMs: 373,
    createdAt: new Date().toISOString(),
    uses: 1,
  });
  writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');

  assert.equal(
    renderRunStrategiesForContext('compile the exotic orchid greenhouse inventory'),
    '',
    'unverified legacy success is excluded from prompt recall',
  );
  assert.equal(getRunStrategyLearningStats().legacyExcluded, 1);
});

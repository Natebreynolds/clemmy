import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolation: this store writes under BASE_DIR — pin a temp CLEMENTINE_HOME
// BEFORE importing anything that reads BASE_DIR (test-hygiene rule 2026-07-22).
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-strategy-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { recordRunStrategy, renderRunStrategiesForContext, strategyKeywords } = await import('./run-strategy-store.js');

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
  });
  assert.ok(again);
  assert.equal(again.uses, 2, 'evidence accumulated on the existing record');
  assert.match(renderRunStrategiesForContext('personal injury firm research comparison'), /proven 2×/);
});

test('runs that used no real tools teach nothing', () => {
  assert.equal(recordRunStrategy({ objective: 'idle chat about weather', toolsUsed: [], workerCount: 0, durationMs: 1000 }), null);
});

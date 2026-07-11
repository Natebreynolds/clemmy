import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCodeModeEfficiency, formatCodeModeEfficiency } from './code-mode-metrics.js';

test('summarizeCodeModeEfficiency: aggregates savings, calls, duration across programs', () => {
  const s = summarizeCodeModeEfficiency([
    { ok: true, rpcCalls: 5, durationMs: 1200, intermediateBytes: 2580, returnBytes: 12, savedBytes: 2568 },
    { ok: true, rpcCalls: 3, durationMs: 800, intermediateBytes: 900, returnBytes: 100, savedBytes: 800 },
    { ok: false, rpcCalls: 10, durationMs: 4000, intermediateBytes: 500, returnBytes: 0, savedBytes: 500 },
  ]);
  assert.equal(s.programs, 3);
  assert.equal(s.okPrograms, 2);
  assert.equal(s.totalRpcCalls, 18);
  assert.equal(s.totalSavedBytes, 3868);
  assert.equal(s.totalReturnBytes, 112);
  assert.equal(s.estTokensSaved, Math.round(3868 / 4)); // 967
  assert.equal(s.avgSavedBytesPerProgram, Math.round(3868 / 3)); // 1289
  assert.equal(s.avgRpcCallsPerProgram, 6); // 18/3
  assert.equal(s.avgDurationMs, 2000); // 6000/3
});

test('summarizeCodeModeEfficiency: derives savedBytes when an (older) event omits it', () => {
  const s = summarizeCodeModeEfficiency([
    { ok: true, rpcCalls: 2, intermediateBytes: 1000, returnBytes: 50 }, // no savedBytes
  ]);
  assert.equal(s.totalSavedBytes, 950, 'derived from intermediate − return');
});

test('summarizeCodeModeEfficiency: empty + all-zero degrade cleanly (no NaN)', () => {
  const empty = summarizeCodeModeEfficiency([]);
  assert.equal(empty.programs, 0);
  assert.equal(empty.avgSavedBytesPerProgram, 0);
  assert.equal(empty.estTokensSaved, 0);
  assert.equal(empty.avgRpcCallsPerProgram, 0);
  assert.equal(empty.avgDurationMs, 0);
  // a legacy event with no byte fields contributes zeros, not NaN
  const legacy = summarizeCodeModeEfficiency([{ ok: true, rpcCalls: 1, durationMs: 100 }]);
  assert.equal(legacy.totalSavedBytes, 0);
  assert.equal(Number.isNaN(legacy.avgSavedBytesPerProgram), false);
});

test('formatCodeModeEfficiency: readable line with token estimate; empty-window message', () => {
  assert.match(formatCodeModeEfficiency(summarizeCodeModeEfficiency([])), /no codemode_program_summary events/);
  const line = formatCodeModeEfficiency(summarizeCodeModeEfficiency([
    { ok: true, rpcCalls: 5, durationMs: 1200, intermediateBytes: 2580, returnBytes: 12, savedBytes: 2568 },
  ]));
  assert.match(line, /programs 1 \(100% ok\)/);
  assert.match(line, /~642 tokens/); // 2568/4
  assert.match(line, /upper bound/);
});

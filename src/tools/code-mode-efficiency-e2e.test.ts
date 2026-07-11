/**
 * End-to-end efficiency measurement (Move 1 / G2): a program that fetches large
 * intermediates through the REAL dispatcher and returns a small distilled value
 * must (a) accumulate intermediateBytes on the result, (b) EMIT them in the
 * codemode_program_summary event, and (c) aggregate into a real token-saving
 * readout. Proves the whole run → emit → aggregate chain, not just the pieces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodeModeSummaryEvent } from '../runtime/harness/code-mode-metrics.js';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-codemode-eff-'));
process.env.HARNESS_TOOL_BRACKETS = 'off'; // bypass gate context so the injected tool's invoke runs

const { runCodeModeForSession, _setCodeModeToolsForTests } = await import('./code-mode-tool.js');
const { openEventLog, createSession } = await import('../runtime/harness/eventlog.js');
const { summarizeCodeModeEfficiency } = await import('../runtime/harness/code-mode-metrics.js');

test('efficiency e2e: big intermediates stay in the sandbox, the event carries the byte accounting', async () => {
  // A read tool that returns ~1000 bytes per call.
  const bigRow = 'x'.repeat(1000);
  _setCodeModeToolsForTests(new Map([
    ['memory_search', { name: 'memory_search', invoke: async () => ({ row: bigRow }) }],
  ]));
  const sessionId = 'sess-codemode-efficiency';
  createSession({ id: sessionId, kind: 'chat' }); // events FK-require a session row (the harness creates it in prod)
  try {
    const result = await runCodeModeForSession(
      `let n = 0; for (let i = 0; i < 4; i++) { const r = await clem.memory_search({ q: i }); n += r.row.length; } return { totalChars: n };`,
      sessionId,
    );
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.value, { totalChars: 4000 });

    // (a) the result accumulated the intermediate payloads (≥ 4×1000 bytes).
    assert.ok(result.intermediateBytes >= 4000, `intermediateBytes should be ≥4000, got ${result.intermediateBytes}`);
    // the distilled return is tiny by comparison
    assert.ok(JSON.stringify(result.value).length < 40);

    // (b) the EMITTED event carries the byte accounting.
    const db = openEventLog();
    const rows = db.prepare(
      "SELECT data_json FROM events WHERE type='codemode_program_summary' AND session_id=?",
    ).all(sessionId) as Array<{ data_json: string }>;
    assert.equal(rows.length, 1, 'exactly one summary event emitted');
    const data = JSON.parse(rows[0].data_json) as CodeModeSummaryEvent;
    assert.ok((data.intermediateBytes ?? 0) >= 4000, 'event carries intermediateBytes');
    assert.ok((data.returnBytes ?? 0) > 0 && (data.returnBytes ?? 0) < 40, 'event carries the small returnBytes');
    assert.equal(data.savedBytes, Math.max(0, (data.intermediateBytes ?? 0) - (data.returnBytes ?? 0)), 'savedBytes = intermediate − return');

    // (c) the aggregator turns the event into a real saving.
    const summary = summarizeCodeModeEfficiency([data]);
    assert.equal(summary.programs, 1);
    assert.ok(summary.totalSavedBytes >= 3960, `saved bytes should reflect the win, got ${summary.totalSavedBytes}`);
    assert.ok(summary.estTokensSaved > 900, 'roughly intermediate/4 tokens saved');
  } finally {
    _setCodeModeToolsForTests(null);
  }
});

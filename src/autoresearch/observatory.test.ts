import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Point BASE_DIR at a temp home BEFORE importing the observatory (config
// reads the env at module load; TOOL_EVENTS_DIR derives from BASE_DIR).
const tmp = mkdtempSync(path.join(os.tmpdir(), 'observatory-test-'));
process.env.CLEMENTINE_HOME = tmp;

const { buildReport, renderReportMarkdown } = await import('./observatory.js');

const EVENTS_DIR = path.join(tmp, 'state', 'tool-events');

function writeToolChoiceEvents(actions: string[]): void {
  mkdirSync(EVENTS_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const lines = actions.map((action) =>
    JSON.stringify({
      at: now,
      toolName: 'tool_choice',
      kind: 'read',
      phase: 'end',
      outcome: action === 'recall_miss' ? 'cancelled' : 'success',
      argsSummary: `action=${action} intent=some.intent`,
    }),
  );
  writeFileSync(path.join(EVENTS_DIR, `${day}.ndjson`), lines.join('\n') + '\n', 'utf-8');
}

test('observatory computes tool-choice recall hit-rate from synthetic events', () => {
  // 3 exact hits + 1 fuzzy + 2 misses = 6 recalls, 4 found → 67%.
  writeToolChoiceEvents([
    'recall_hit', 'recall_hit', 'recall_hit',
    'recall_hit_fuzzy',
    'recall_miss', 'recall_miss',
    'remember', 'remember',
    'invalidate',
  ]);
  const report = buildReport({ hoursBack: 24 });
  const tc = report.toolChoiceHealth;
  assert.ok(tc, 'toolChoiceHealth present');
  assert.equal(tc.recalls, 6);
  assert.equal(tc.hits, 3);
  assert.equal(tc.fuzzyHits, 1);
  assert.equal(tc.misses, 2);
  assert.equal(tc.hitRatePct, 67); // round(4/6*100)
  assert.equal(tc.remembers, 2);
  assert.equal(tc.invalidations, 1);

  const md = renderReportMarkdown(report);
  assert.ok(md.includes('Tool-choice learning'), 'section rendered');
  assert.ok(md.includes('Recall hit-rate: 67%'), 'hit-rate rendered');
});

test('observatory omits tool-choice section when there is no tool-choice activity', () => {
  // Overwrite today's events with NON-tool_choice events only → the
  // tool-choice section must disappear (undefined), proving the guard.
  mkdirSync(EVENTS_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(
    path.join(EVENTS_DIR, `${day}.ndjson`),
    JSON.stringify({ at: new Date().toISOString(), toolName: 'sf', kind: 'read', phase: 'end', outcome: 'success' }) + '\n',
    'utf-8',
  );
  const report = buildReport({ hoursBack: 24 });
  assert.equal(report.toolChoiceHealth, undefined);
  assert.ok(!renderReportMarkdown(report).includes('Tool-choice learning'));
});

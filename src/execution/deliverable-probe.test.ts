/**
 * Run: npx tsx --test src/execution/deliverable-probe.test.ts
 *
 * Deliverable-grounded completion: the run's produced artifacts are read back
 * DETERMINISTICALLY before "done" is allowed. The 2026-07-08 failure — a run
 * claimed "created and populated 5 Google Sheets" while all five were BLANK.
 * Everything is injected (no fs / network / eventlog), so these are pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDeliverables,
  probeDeliverables,
  probeSessionDeliverables,
  objectiveImpliesPopulation,
  countSheetRows,
  type DeliverableProbeDeps,
} from './deliverable-probe.js';

const SHEET_ID = '1tMAbcdEFGhijklmnop1234567890QRSTUVWXYZ';

// A composio GOOGLESHEETS create result carrying the new spreadsheet id.
function sheetCreatedEvents() {
  return {
    listEventsFn: () => [
      { sessionId: 's', turn: 0, role: 'tool', type: 'tool_returned', data: { tool: 'composio_execute_tool', ok: true, callId: 'c-sheet' } },
    ] as never,
    getToolOutputFn: (_s: string, callId: string) =>
      callId === 'c-sheet'
        ? { output: JSON.stringify({ successful: true, data: { spreadsheetId: SHEET_ID, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, title: 'Q3 Legal' } }) }
        : null,
  };
}

test('extractDeliverables: pulls a created Google Sheet id from a composio result', () => {
  const dels = extractDeliverables('s', sheetCreatedEvents());
  assert.equal(dels.length, 1);
  assert.equal(dels[0].kind, 'google_sheet');
  assert.equal(dels[0].ref, SHEET_ID);
});

test('probe: a populated objective + a sheet with 0 data rows REFUSES completion with the specific gap', async () => {
  const deps: DeliverableProbeDeps = {
    ...sheetCreatedEvents(),
    readSheetRowCount: async () => 1, // title/header row only — not populated
  };
  const res = await probeSessionDeliverables('s', 'Create and populate 5 Google Sheets with the prospect data', deps);
  assert.equal(res.failures.length, 1);
  assert.match(res.failures[0].gap, new RegExp(SHEET_ID));
  assert.match(res.summary, /not done/i);
  assert.match(res.summary, /title\/header row|0 data rows/);
  assert.match(res.evidenceText, /DETERMINISTIC DELIVERABLE PROBE/);
  assert.match(res.evidenceText, /FAILED/);
});

test('probe: a populated sheet (rows > 1) PASSES', async () => {
  const deps: DeliverableProbeDeps = { ...sheetCreatedEvents(), readSheetRowCount: async () => 42 };
  const res = await probeSessionDeliverables('s', 'Create and populate the sheet with the data', deps);
  assert.equal(res.failures.length, 0);
  assert.match(res.evidenceText, /OK: sheet .* 42 rows/);
});

test('probe: an UNPROBEABLE sheet (reader returns -1) falls through — never blocks', async () => {
  const deps: DeliverableProbeDeps = { ...sheetCreatedEvents(), readSheetRowCount: async () => -1 };
  const res = await probeSessionDeliverables('s', 'Create and populate the sheet', deps);
  assert.equal(res.failures.length, 0, 'a probe we cannot run must not block');
  assert.match(res.evidenceText, /UNVERIFIED/);
});

test('probe: a CREATE-only objective (no population) does not fail an empty sheet', async () => {
  const deps: DeliverableProbeDeps = { ...sheetCreatedEvents(), readSheetRowCount: async () => 1 };
  const res = await probeSessionDeliverables('s', 'Create a new Google Sheet for the team', deps);
  assert.equal(res.failures.length, 0, 'existence-only objective does not require populated rows');
});

test('objectiveImpliesPopulation: distinguishes populate/fill from bare create', () => {
  assert.equal(objectiveImpliesPopulation('create and populate 5 sheets'), true);
  assert.equal(objectiveImpliesPopulation('fill the sheet with the rows'), true);
  assert.equal(objectiveImpliesPopulation('write the data into the tab'), true);
  assert.equal(objectiveImpliesPopulation('create a new blank spreadsheet'), false);
  assert.equal(objectiveImpliesPopulation('make a sheet'), false);
});

// ─── Local-file probe (both directions) ───────────────────────────────────────

test('probe: local file present + non-empty PASSES; missing/empty FAILS', async () => {
  const files: Record<string, number> = { '/tmp/report.html': 5000, '/tmp/empty.html': 0 };
  const listWrote = (path: string) => ({
    listEventsFn: () => [{ sessionId: 's', turn: 0, role: 'tool', type: 'tool_returned', data: { tool: 'write_file', ok: true, callId: 'c1', preview: `Wrote ${path} (100 chars).` } }] as never,
    getToolOutputFn: () => null,
    fileStat: (p: string) => (p in files ? { exists: true, size: files[p] } : { exists: false, size: 0 }),
  });

  const ok = await probeSessionDeliverables('s', 'Write the report', listWrote('/tmp/report.html'));
  assert.equal(ok.failures.length, 0);

  const empty = await probeSessionDeliverables('s', 'Write the report', listWrote('/tmp/empty.html'));
  assert.equal(empty.failures.length, 1);
  assert.match(empty.failures[0].gap, /EMPTY/);

  const missing = await probeSessionDeliverables('s', 'Write the report', listWrote('/tmp/gone.html'));
  assert.equal(missing.failures.length, 1);
  assert.match(missing.failures[0].gap, /MISSING/);
});

test('probe: nothing extractable → empty result, no block', async () => {
  const res = await probeSessionDeliverables('s', 'do a thing', { listEventsFn: () => [] as never });
  assert.equal(res.failures.length, 0);
  assert.equal(res.evidenceText, '');
});

test('countSheetRows: counts the largest values block; -1 when none', () => {
  assert.equal(countSheetRows(JSON.stringify({ valueRanges: [{ values: [['h1', 'h2'], ['a', 'b'], ['c', 'd']] }] })), 3);
  assert.equal(countSheetRows(JSON.stringify({ valueRanges: [{ range: 'A1:B1' }] })), -1);
  assert.equal(countSheetRows(''), -1);
});

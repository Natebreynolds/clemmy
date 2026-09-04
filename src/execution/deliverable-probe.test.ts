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
      { sessionId: 's', turn: 0, role: 'tool', type: 'tool_returned', data: { sourceUserSeq: 7, tool: 'composio_execute_tool', ok: true, callId: 'c-sheet' } },
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
  assert.equal(dels[0].sourceUserSeq, 7);
});

test('extractDeliverables: ignores spreadsheet examples returned by tool discovery', () => {
  const dels = extractDeliverables('s', {
    listEventsFn: () => [{
      sessionId: 's',
      turn: 0,
      role: 'tool',
      type: 'tool_returned',
      data: { sourceUserSeq: 7, tool: 'tool_search', ok: true, callId: 'c-search' },
    }] as never,
    getToolOutputFn: () => ({
      output: JSON.stringify({
        results: [{
          name: 'GOOGLESHEETS_BATCH_GET',
          example: { spreadsheetId: SHEET_ID },
        }],
      }),
    }),
  });

  assert.deepEqual(dels, [], 'catalog metadata is not request-bound artifact evidence');
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

test('live-shaped existing-resource cell update accepts its exact frozen readback instead of treating one row as a blank new sheet', async () => {
  const callIds = {
    initial: 'toolu-initial-values-get',
    update: 'toolu-update-values-batch',
    final: 'toolu-final-values-get',
  };
  const marker = 'CLEM-PRETAG-BATCH-VERIFIER-V17-20260904-V996';
  const outputByCall = new Map<string, string>([
    [callIds.initial, JSON.stringify({
      data: { display_url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, range: 'Sheet1!V996', values: [] },
      successful: true,
    })],
    [callIds.update, JSON.stringify({
      data: { spreadsheetId: SHEET_ID, updatedRange: 'Sheet1!V996', updatedCells: 1 },
      successful: true,
    })],
    [callIds.final, JSON.stringify({
      data: { display_url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, range: 'Sheet1!V996', values: [[marker]] },
      successful: true,
    })],
  ]);
  let rowCountReads = 0;
  const deps: DeliverableProbeDeps = {
    listEventsFn: () => [
      { sessionId: 's', turn: 1, role: 'tool', type: 'tool_returned', data: {
        sourceUserSeq: 127514, tool: 'work_call', effectiveTool: 'GOOGLESHEETS_VALUES_GET',
        effect: 'read', ok: true, callId: callIds.initial,
      } },
      { sessionId: 's', turn: 1, role: 'tool', type: 'tool_returned', data: {
        sourceUserSeq: 127514, tool: 'work_call', effectiveTool: 'GOOGLESHEETS_UPDATE_VALUES_BATCH',
        effect: 'external_write', ok: true, callId: callIds.update,
      } },
      { sessionId: 's', turn: 1, role: 'tool', type: 'tool_returned', data: {
        sourceUserSeq: 127514, tool: 'work_call', effectiveTool: 'GOOGLESHEETS_VALUES_GET',
        effect: 'read', ok: true, callId: callIds.final,
      } },
    ] as never,
    getToolOutputFn: (_sessionId, callId) => ({ output: outputByCall.get(callId) ?? '' }),
    resourcePostureForCall: (_sessionId, sourceUserSeq, callId) => {
      assert.equal(sourceUserSeq, 127514);
      assert.equal(callId, callIds.update, 'read results never enter deliverable posture resolution');
      return 'named_existing';
    },
    verifyNamedExistingMutation: async (deliverable) => {
      assert.equal(deliverable.callId, callIds.update);
      assert.equal(deliverable.ref, SHEET_ID);
      return true;
    },
    readSheetRowCount: async () => {
      rowCountReads += 1;
      return 1;
    },
  };

  const deliverables = extractDeliverables('s', deps);
  assert.deepEqual(deliverables.map((deliverable) => ({
    ref: deliverable.ref,
    callId: deliverable.callId,
    posture: deliverable.resourcePosture,
  })), [{ ref: SHEET_ID, callId: callIds.update, posture: 'named_existing' }]);
  const result = await probeDeliverables(
    deliverables,
    `Write the values ${marker} to the existing exact cell and read it back. Do not create a spreadsheet.`,
    's',
    deps,
  );
  assert.equal(result.failures.length, 0, result.summary);
  assert.match(result.evidenceText, /exact committed mutation and authoritative readback verified/i);
  assert.equal(rowCountReads, 0,
    'a verified exact existing-target mutation is not judged by the new-sheet row-count heuristic');

  const missingProof = await probeDeliverables(
    deliverables,
    'Write the values into the existing exact cell and verify them.',
    's',
    { ...deps, verifyNamedExistingMutation: async () => false },
  );
  assert.equal(missingProof.failures.length, 1,
    'named-existing posture alone cannot manufacture completion without its exact proof');
  assert.match(missingProof.evidenceText, /UNVERIFIED \(BLOCKING\)/);
});

test('a create/populate flow remains fail-closed even when an unrelated named-existing proof seam would pass', async () => {
  let namedExistingProofs = 0;
  const deps: DeliverableProbeDeps = {
    ...sheetCreatedEvents(),
    resourcePostureForCall: () => 'created',
    verifyNamedExistingMutation: async () => {
      namedExistingProofs += 1;
      return true;
    },
    readSheetRowCount: async () => 1,
  };
  const result = await probeSessionDeliverables(
    's',
    'Create and populate the new Google Sheet with the data rows.',
    deps,
  );
  assert.equal(result.failures.length, 1);
  assert.match(result.summary, /title\/header row|0 data rows/);
  assert.equal(namedExistingProofs, 0,
    'new artifacts still require their own population readback');
});

test('probe: required population with an UNPROBEABLE sheet blocks truthful completion', async () => {
  const deps: DeliverableProbeDeps = { ...sheetCreatedEvents(), readSheetRowCount: async () => -1 };
  const res = await probeSessionDeliverables('s', 'Create and populate the sheet', deps);
  assert.equal(res.failures.length, 1, 'creation alone cannot prove required contents');
  assert.match(res.failures[0].gap, /could not be verified/i);
  assert.match(res.summary, /not done/i);
  assert.match(res.evidenceText, /UNVERIFIED \(BLOCKING\)/);
});

test('probe: a thrown required-population readback also blocks instead of silently greening', async () => {
  const deps: DeliverableProbeDeps = {
    ...sheetCreatedEvents(),
    readSheetRowCount: async () => { throw new Error('connection unavailable'); },
  };
  const res = await probeSessionDeliverables('s', 'Fill the sheet with every prospect row', deps);
  assert.equal(res.failures.length, 1);
  assert.match(res.evidenceText, /UNVERIFIED \(BLOCKING\)/);
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
  assert.equal(countSheetRows({ grid: { header: ['h1', 'h2'], rows: [{ h1: 'a' }, { h1: 'b' }] } }), 3);
  assert.equal(countSheetRows(JSON.stringify({ valueRanges: [{ range: 'A1:B1' }] })), -1);
  assert.equal(countSheetRows(''), -1);
});

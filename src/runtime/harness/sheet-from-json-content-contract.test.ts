import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authorizeGoogleSheetsSheetFromJsonReadbackRequest,
  compileGoogleSheetsSheetFromJsonContract,
  extractGoogleSheetsSheetFromJsonTarget,
  googleSheetsSheetFromJsonMatchesSourceRecords,
  parseGoogleSheetsSheetFromJsonContract,
  verifyGoogleSheetsSheetFromJsonReadback,
  type GoogleSheetsSheetFromJsonContract,
  type GoogleSheetsSheetTarget,
} from './sheet-from-json-content-contract.js';

const rows = [
  { Name: 'Lure Fish House', Rating: 4.7, Address: '60 S California St, Ventura, CA 93001' },
  { Name: 'Brophy Bros. Ventura', Rating: 4.5, Address: '1559 Spinnaker Dr, Ventura, CA 93001' },
  { Name: 'Rumfish y Vino', Rating: 4.6, Address: '34 N Palm St, Ventura, CA 93001' },
  { Name: 'Aloha Steakhouse', Rating: 4.5, Address: '364 S California St, Ventura, CA 93001' },
  { Name: 'Social Tap Ventura', Rating: 4.4, Address: '1105 S Seaward Ave, Ventura, CA 93001' },
];

const createArguments = {
  title: 'Top 5 Restaurants in Ventura CA — August 2026',
  sheet_name: 'Top 5 Restaurants',
  sheet_json: rows,
};

const spreadsheetId = 'ventura_sheet_exact_123456789';

function contract(): GoogleSheetsSheetFromJsonContract {
  const compiled = compileGoogleSheetsSheetFromJsonContract(
    'composio_execute_tool',
    {
      tool_slug: 'GOOGLESHEETS_SHEET_FROM_JSON',
      arguments: JSON.stringify(createArguments),
      connected_account_id: 'ca_google_sheets_owner',
    },
  );
  assert.ok(compiled);
  return compiled;
}

function target(): GoogleSheetsSheetTarget {
  return {
    provider: 'googlesheets',
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

function exactValues(): Array<Array<string | number>> {
  return [
    ['Name', 'Rating', 'Address'],
    ...rows.map((row) => [row.Name, row.Rating, row.Address]),
  ];
}

test('compiles the exact provider-ready Sheet JSON into an ordered Ventura matrix', () => {
  const compiled = contract();
  assert.match(compiled.submittedContentDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...compiled, submittedContentDigest: undefined }, {
    kind: 'googlesheets_sheet_from_json_content_v1',
    createShape: 'GOOGLESHEETS_SHEET_FROM_JSON',
    sheetName: 'Top 5 Restaurants',
    headers: ['Name', 'Rating', 'Address'],
    expectedValues: exactValues(),
    expectedRange: "'Top 5 Restaurants'!A1:C6",
    submittedContentDigest: undefined,
  });
  assert.deepEqual(parseGoogleSheetsSheetFromJsonContract(compiled), compiled);
  assert.equal(googleSheetsSheetFromJsonMatchesSourceRecords(compiled, rows), true);
  assert.equal(googleSheetsSheetFromJsonMatchesSourceRecords(compiled, rows.slice(0, -1)), false);
  assert.equal(googleSheetsSheetFromJsonMatchesSourceRecords(compiled, [
    ...rows.slice(0, -1),
    { ...rows.at(-1)!, Rating: 1 },
  ]), false);

  const direct = compileGoogleSheetsSheetFromJsonContract(
    'mcp__googlesheets__sheet_from_json',
    { ...createArguments, sheet_json: JSON.stringify(rows) },
  );
  assert.deepEqual(direct, contract(), 'the reviewed direct provider carrier has the same contract');
  assert.deepEqual(
    compileGoogleSheetsSheetFromJsonContract(
      'mcp__clementine-local__cx_googlesheets_sheet_from_json',
      createArguments,
    ),
    contract(),
    'the trusted dynamic carrier has the same contract',
  );
  assert.deepEqual(
    compileGoogleSheetsSheetFromJsonContract(
      'mcp__googlesheets__GOOGLESHEETS_SHEET_FROM_JSON',
      createArguments,
    ),
    contract(),
    'a provider MCP tail that already carries the full slug is not double-prefixed',
  );
});

test('contract compilation fails closed outside the reviewed constructor/schema', () => {
  assert.equal(compileGoogleSheetsSheetFromJsonContract('ACME_SHEET_FROM_JSON', createArguments), null);
  assert.equal(compileGoogleSheetsSheetFromJsonContract('GOOGLESHEETS_SHEET_FROM_JSON', {
    ...createArguments,
    sheet_json: [],
  }), null);
  assert.equal(compileGoogleSheetsSheetFromJsonContract('GOOGLESHEETS_SHEET_FROM_JSON', {
    ...createArguments,
    sheet_json: [rows[0], { Name: 'No address', Rating: 4.2 }],
  }), null);
  assert.equal(compileGoogleSheetsSheetFromJsonContract('GOOGLESHEETS_SHEET_FROM_JSON', {
    ...createArguments,
    sheet_json: [{ Name: 'Bad cell', Rating: Number.NaN, Address: 'Ventura' }],
  }), null);
});

test('extracts the exact created spreadsheet and never borrows an ambient generic id', () => {
  assert.deepEqual(extractGoogleSheetsSheetFromJsonTarget({
    successful: true,
    data: {
      account: { id: 'ambient_google_account_987654321' },
      spreadsheet: {
        spreadsheetId,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      },
    },
  }), target());

  assert.equal(extractGoogleSheetsSheetFromJsonTarget({
    successful: true,
    data: { account: { id: 'ambient_google_account_987654321' } },
  }), null, 'a generic id is not a Sheet target');
  assert.equal(extractGoogleSheetsSheetFromJsonTarget({
    successful: true,
    request: { spreadsheetId },
    data: { account: { id: 'ambient_google_account_987654321' } },
  }), null, 'a request echo is not a provider-created target');
  assert.equal(extractGoogleSheetsSheetFromJsonTarget({
    successful: true,
    data: {
      spreadsheetId,
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/fixture-different-sheet/edit',
    },
  }), null, 'conflicting exact Sheet fields fail closed');
});

test('exact-id BATCH_GET proves the exact header order, row order, and cell values', () => {
  assert.deepEqual(authorizeGoogleSheetsSheetFromJsonReadbackRequest(
    contract(),
    target(),
    'GOOGLESHEETS_BATCH_GET',
    {
      spreadsheet_id: spreadsheetId,
      ranges: ["'Top 5 Restaurants'!A1:C6"],
      valueRenderOption: 'UNFORMATTED_VALUE',
    },
  ), {
    authorized: true,
    target: target(),
    readShape: 'GOOGLESHEETS_BATCH_GET',
    range: "'Top 5 Restaurants'!A1:C6",
  });
  const verdict = verifyGoogleSheetsSheetFromJsonReadback(
    contract(),
    target(),
    'composio_execute_tool',
    {
      tool_slug: 'GOOGLESHEETS_BATCH_GET',
      arguments: JSON.stringify({
        spreadsheet_id: spreadsheetId,
        ranges: ["'Top 5 Restaurants'!A1:C6"],
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
    },
    {
      successful: true,
      data: {
        spreadsheetId,
        valueRanges: [{ range: "'Top 5 Restaurants'!A1:C6", values: exactValues() }],
      },
    },
  );
  assert.deepEqual(verdict, {
    verified: true,
    target: target(),
    readShape: 'GOOGLESHEETS_BATCH_GET',
    range: "'Top 5 Restaurants'!A1:C6",
  });
});

test('exact-id GET_VALUES has the same provider-neutral proof verdict', () => {
  const verdict = verifyGoogleSheetsSheetFromJsonReadback(
    contract(),
    target(),
    'mcp__googlesheets__get_values',
    {
      spreadsheet_id: spreadsheetId,
      range: "'Top 5 Restaurants'!A1:C6",
      valueRenderOption: 'UNFORMATTED_VALUE',
    },
    {
      successful: true,
      data: {
        range: "'Top 5 Restaurants'!A1:C6",
        values: exactValues(),
      },
    },
  );
  assert.equal(verdict.verified, true);
  if (verdict.verified) assert.equal(verdict.readShape, 'GOOGLESHEETS_GET_VALUES');
});

test('full-slug direct provider MCP BATCH_GET has the same proof verdict', () => {
  const c = contract();
  const verdict = verifyGoogleSheetsSheetFromJsonReadback(
    c,
    target(),
    'mcp__googlesheets__GOOGLESHEETS_BATCH_GET',
    {
      spreadsheet_id: spreadsheetId,
      ranges: [c.expectedRange],
      valueRenderOption: 'UNFORMATTED_VALUE',
    },
    {
      successful: true,
      data: {
        display_url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        spreadsheetId,
        valueRanges: [{ majorDimension: 'ROWS', range: c.expectedRange, values: exactValues() }],
      },
    },
  );
  assert.equal(verdict.verified, true);
});

test('content mutations and non-exact reads cannot satisfy the contract', () => {
  const read = (
    values: unknown[][],
    overrides: {
      id?: string;
      requestRange?: string;
      returnedRange?: string;
      slug?: string;
      successful?: boolean;
    } = {},
  ) => verifyGoogleSheetsSheetFromJsonReadback(
    contract(),
    target(),
    'composio_execute_tool',
    {
      tool_slug: overrides.slug ?? 'GOOGLESHEETS_BATCH_GET',
      arguments: {
        spreadsheet_id: overrides.id ?? spreadsheetId,
        ranges: [overrides.requestRange ?? "'Top 5 Restaurants'!A1:C6"],
        valueRenderOption: 'UNFORMATTED_VALUE',
      },
    },
    {
      successful: overrides.successful ?? true,
      data: {
        spreadsheetId: overrides.id ?? spreadsheetId,
        valueRanges: [{
          range: overrides.returnedRange ?? "'Top 5 Restaurants'!A1:C6",
          values,
        }],
      },
    },
  );

  const headerReordered = exactValues();
  [headerReordered[0][0], headerReordered[0][1]] = [headerReordered[0][1], headerReordered[0][0]];
  assert.deepEqual(read(headerReordered), { verified: false, target: target(), reason: 'content_mismatch' });

  const rowsReordered = exactValues();
  [rowsReordered[1], rowsReordered[2]] = [rowsReordered[2], rowsReordered[1]];
  assert.deepEqual(read(rowsReordered), { verified: false, target: target(), reason: 'content_mismatch' });

  const valueChanged = exactValues();
  valueChanged[1][1] = 5;
  assert.deepEqual(read(valueChanged), { verified: false, target: target(), reason: 'content_mismatch' });
  assert.deepEqual(read(exactValues(), { id: 'different_sheet' }), {
    verified: false, target: target(), reason: 'target_mismatch',
  });
  assert.deepEqual(read(exactValues(), { requestRange: "'Other Tab'!A1:C6" }), {
    verified: false, target: target(), reason: 'unexpected_range',
  });
  assert.deepEqual(read(exactValues(), { slug: 'GOOGLESHEETS_LIST_SPREADSHEETS' }), {
    verified: false, target: target(), reason: 'unrecognized_read',
  });
  assert.deepEqual(read(exactValues(), { successful: false }), {
    verified: false, target: target(), reason: 'provider_contradiction',
  });
});

test('pre-dispatch readback admission requires the exact Sheet id and contract range', () => {
  const c = contract();
  assert.deepEqual(authorizeGoogleSheetsSheetFromJsonReadbackRequest(
    c,
    target(),
    'GOOGLESHEETS_BATCH_GET',
    { spreadsheet_id: 'different_sheet', ranges: [c.expectedRange] },
  ), { authorized: false, target: target(), reason: 'target_mismatch' });
  assert.deepEqual(authorizeGoogleSheetsSheetFromJsonReadbackRequest(
    c,
    target(),
    'GOOGLESHEETS_BATCH_GET',
    { spreadsheet_id: spreadsheetId, ranges: ["'Other'!A1:C6"] },
  ), { authorized: false, target: target(), reason: 'unexpected_range' });
  assert.deepEqual(authorizeGoogleSheetsSheetFromJsonReadbackRequest(
    c,
    target(),
    'GOOGLESHEETS_LIST_SPREADSHEETS',
    { spreadsheet_id: spreadsheetId },
  ), { authorized: false, target: target(), reason: 'unrecognized_read' });
  assert.deepEqual(authorizeGoogleSheetsSheetFromJsonReadbackRequest(
    c,
    target(),
    'GOOGLESHEETS_BATCH_GET',
    { spreadsheet_id: spreadsheetId, ranges: [c.expectedRange] },
  ), { authorized: false, target: target(), reason: 'unexpected_value_render_option' });
  assert.deepEqual(authorizeGoogleSheetsSheetFromJsonReadbackRequest(
    c,
    target(),
    'GOOGLESHEETS_BATCH_GET',
    {
      spreadsheet_id: spreadsheetId,
      ranges: [c.expectedRange],
      valueRenderOption: 'FORMATTED_VALUE',
    },
  ), { authorized: false, target: target(), reason: 'unexpected_value_render_option' });
});

test('multiple ranges, absent matrices, and formatted numeric drift fail closed', () => {
  const c = contract();
  assert.deepEqual(verifyGoogleSheetsSheetFromJsonReadback(
    c,
    target(),
    'GOOGLESHEETS_BATCH_GET',
    {
      spreadsheet_id: spreadsheetId,
      ranges: [c.expectedRange, "'Other'!A1"],
      valueRenderOption: 'UNFORMATTED_VALUE',
    },
    { successful: true, data: { valueRanges: [] } },
  ), { verified: false, target: target(), reason: 'invalid_read_arguments' });

  assert.deepEqual(verifyGoogleSheetsSheetFromJsonReadback(
    c,
    target(),
    'GOOGLESHEETS_BATCH_GET',
    {
      spreadsheet_id: spreadsheetId,
      ranges: [c.expectedRange],
      valueRenderOption: 'UNFORMATTED_VALUE',
    },
    { successful: true, data: { valueRanges: [] } },
  ), { verified: false, target: target(), reason: 'missing_values' });

  const formatted = exactValues();
  formatted[1][1] = '4.7';
  assert.deepEqual(verifyGoogleSheetsSheetFromJsonReadback(
    c,
    target(),
    'GOOGLESHEETS_BATCH_GET',
    {
      spreadsheet_id: spreadsheetId,
      ranges: [c.expectedRange],
      valueRenderOption: 'UNFORMATTED_VALUE',
    },
    { successful: true, data: { valueRanges: [{ range: c.expectedRange, values: formatted }] } },
  ), { verified: false, target: target(), reason: 'content_mismatch' });
});

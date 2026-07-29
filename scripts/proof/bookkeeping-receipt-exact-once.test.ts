/**
 * Pure/self-tests for the selectable bookkeeping receipt proof.
 *
 * These tests never boot a model and never touch a real Google account. The
 * provider boundary is the same proof-local Composio shim used by the live
 * scenario, rooted in a disposable HOME.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProofComposioShim } from './provision.js';
import {
  BOOKKEEPING_APPEND_TOOL,
  BOOKKEEPING_HEADERS,
  BOOKKEEPING_READ_TOOL,
  buildBookkeepingAppendPayload,
  buildBookkeepingRow,
  bookkeepingReadbackMatches,
  exactBookkeepingAppendPayload,
  fingerprintSyntheticReceipt,
  parseProofSheetsState,
  type SyntheticBookkeepingReceipt,
} from './scenarios/bookkeeping-receipt-exact-once.js';

const RECEIPT: SyntheticBookkeepingReceipt = {
  source: 'proof-camera-roll',
  sourceReceiptId: 'receipt-proof-0042',
  purchasedOn: '2026-07-27',
  merchant: '  Harbor   Lantern Café  ',
  amount: '84.20',
  currency: 'usd',
  tax: '7.20',
  sourceUri: 'proof://receipts/receipt-proof-0042',
  evidenceNote: 'Client dinner after airport pickup.',
  capturedAt: '2026-07-28T17:00:00.000Z',
};

test('receipt identity is stable across harmless formatting but changes with financial evidence', () => {
  const first = fingerprintSyntheticReceipt(RECEIPT);
  const reformatted = fingerprintSyntheticReceipt({
    ...RECEIPT,
    merchant: 'Harbor Lantern Cafe\u0301',
    amount: '84.2',
    currency: 'USD',
    tax: '7.2',
  });
  const changedAmount = fingerprintSyntheticReceipt({
    ...RECEIPT,
    amount: '84.21',
  });

  assert.match(first, /^receipt-sha256:[a-f0-9]{64}$/);
  assert.equal(reformatted, first);
  assert.notEqual(changedAmount, first);
});

test('append contract accepts only the exact camelCase Sheets schema and exact row', () => {
  const scope = 'bookkeeping-proof-m7';
  const row = buildBookkeepingRow(RECEIPT, 'Meals & Entertainment', scope);
  const payload = buildBookkeepingAppendPayload({
    spreadsheetId: 'proof-sheet-bookkeeping',
    range: 'Receipts!A:L',
    row,
  });

  assert.equal(row.length, BOOKKEEPING_HEADERS.length);
  assert.deepEqual(exactBookkeepingAppendPayload(payload, {
    spreadsheetId: 'proof-sheet-bookkeeping',
    range: 'Receipts!A:L',
    row,
  }), { pass: true, problems: [] });

  const snakeCase = {
    ...payload,
    spreadsheet_id: payload.spreadsheetId,
  } as Record<string, unknown>;
  delete snakeCase.spreadsheetId;
  const badCasing = exactBookkeepingAppendPayload(snakeCase, {
    spreadsheetId: 'proof-sheet-bookkeeping',
    range: 'Receipts!A:L',
    row,
  });
  assert.equal(badCasing.pass, false);
  assert.match(badCasing.problems.join(' '), /spreadsheetId|keys/i);

  const extraRow = {
    ...payload,
    values: [row, row],
  };
  assert.equal(exactBookkeepingAppendPayload(extraRow, {
    spreadsheetId: 'proof-sheet-bookkeeping',
    range: 'Receipts!A:L',
    row,
  }).pass, false);
});

test('readback requires the exact header and exactly one matching receipt row', () => {
  const row = buildBookkeepingRow(RECEIPT, 'Meals & Entertainment', 'bookkeeping-proof-m7');
  const clean = {
    successful: true,
    data: {
      range: 'Receipts!A:L',
      majorDimension: 'ROWS',
      values: [BOOKKEEPING_HEADERS, row],
    },
  };
  assert.equal(bookkeepingReadbackMatches(clean, row), true);
  assert.equal(bookkeepingReadbackMatches({
    ...clean,
    data: { ...clean.data, values: [BOOKKEEPING_HEADERS, row, row] },
  }, row), false, 'a duplicate fingerprint cannot pass readback');
  assert.equal(bookkeepingReadbackMatches({
    ...clean,
    data: { ...clean.data, values: [BOOKKEEPING_HEADERS, [...row.slice(0, 4), '999.00', ...row.slice(5)]] },
  }, row), false, 'a mismatched financial cell cannot pass readback');
});

test('proof-local Sheets shim validates append casing, persists one row, and reads it back', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-bookkeeping-shim-'));
  try {
    const shim = createProofComposioShim(home);
    writeFileSync(path.join(home, 'proof-composio-connected'), 'connected\n', 'utf8');
    const row = buildBookkeepingRow(RECEIPT, 'Meals & Entertainment', 'bookkeeping-proof-m7');
    const append = buildBookkeepingAppendPayload({
      spreadsheetId: 'proof-sheet-bookkeeping',
      range: 'Receipts!A:L',
      row,
    });
    const env = { ...process.env, HOME: home };

    const appendRaw = execFileSync(
      process.execPath,
      [shim, 'execute', BOOKKEEPING_APPEND_TOOL, '-d', JSON.stringify(append)],
      { env, encoding: 'utf8' },
    );
    const appendResult = JSON.parse(appendRaw) as {
      successful?: boolean;
      data?: { proofReceipt?: { id?: string }; updates?: { updatedRows?: number } };
    };
    assert.equal(appendResult.successful, true);
    assert.equal(appendResult.data?.updates?.updatedRows, 1);
    assert.match(appendResult.data?.proofReceipt?.id ?? '', /^proof-sheets-/);

    const readRaw = execFileSync(
      process.execPath,
      [
        shim,
        'execute',
        BOOKKEEPING_READ_TOOL,
        '-d',
        JSON.stringify({ spreadsheet_id: 'proof-sheet-bookkeeping', range: 'Receipts!A:L' }),
      ],
      { env, encoding: 'utf8' },
    );
    const readback = JSON.parse(readRaw) as unknown;
    assert.equal(bookkeepingReadbackMatches(readback, row), true);

    const state = parseProofSheetsState(
      readFileSync(path.join(home, 'proof-googlesheets-state.json'), 'utf8'),
    );
    assert.deepEqual(state?.sheets['proof-sheet-bookkeeping\nReceipts!A:L']?.rows, [
      BOOKKEEPING_HEADERS,
      row,
    ]);
    assert.equal(
      readFileSync(path.join(home, 'proof-googlesheets-receipts.log'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .length,
      1,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('proof-local Sheets shim rejects snake_case append keys before state mutation', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-bookkeeping-casing-'));
  try {
    const shim = createProofComposioShim(home);
    writeFileSync(path.join(home, 'proof-composio-connected'), 'connected\n', 'utf8');
    const row = buildBookkeepingRow(RECEIPT, 'Meals & Entertainment', 'bookkeeping-proof-m7');
    let message = '';
    try {
      execFileSync(
        process.execPath,
        [
          shim,
          'execute',
          BOOKKEEPING_APPEND_TOOL,
          '-d',
          JSON.stringify({
            spreadsheet_id: 'proof-sheet-bookkeeping',
            range: 'Receipts!A:L',
            value_input_option: 'RAW',
            major_dimension: 'ROWS',
            insert_data_option: 'INSERT_ROWS',
            include_values_in_response: true,
            values: [row],
          }),
        ],
        { env: { ...process.env, HOME: home }, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (error) {
      message = String((error as { stderr?: Buffer | string }).stderr ?? error);
    }
    assert.match(message, /camelCase|spreadsheetId|invalid Sheets append/i);
    assert.equal(parseProofSheetsState('')?.version ?? 1, 1, 'empty parser stays safe');
    assert.throws(
      () => readFileSync(path.join(home, 'proof-googlesheets-state.json'), 'utf8'),
      /ENOENT/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

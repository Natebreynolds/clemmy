import {
  inspectProviderEnvelope,
  pruneProviderRequestEchoes,
} from './provider-read-evidence.js';

/**
 * Pure, provider-reviewed content proof for GOOGLESHEETS_SHEET_FROM_JSON.
 *
 * This module deliberately does no provider I/O and accepts no model-authored
 * result pointers. It compiles the exact JSON handed to the constructor into a
 * matrix, then compares that matrix with one exact-id values read. Runtime
 * callers own dispatch and persistence; this helper only returns a verdict.
 */

export type GoogleSheetsCell = string | number | boolean | null;

export interface GoogleSheetsSheetFromJsonContract {
  kind: 'googlesheets_sheet_from_json_content_v1';
  createShape: 'GOOGLESHEETS_SHEET_FROM_JSON';
  sheetName: string;
  headers: string[];
  expectedValues: GoogleSheetsCell[][];
  /** Canonical exact range callers can use for BATCH_GET/GET_VALUES. */
  expectedRange: string;
}

export interface GoogleSheetsSheetTarget {
  provider: 'googlesheets';
  spreadsheetId: string;
  spreadsheetUrl: string | null;
}

export type GoogleSheetsSheetContentFailureReason =
  | 'unrecognized_read'
  | 'invalid_read_arguments'
  | 'unexpected_value_render_option'
  | 'target_mismatch'
  | 'provider_contradiction'
  | 'provider_uninspected'
  | 'missing_values'
  | 'unexpected_range'
  | 'content_mismatch';

export type GoogleSheetsSheetContentVerdict =
  | {
      verified: true;
      target: GoogleSheetsSheetTarget;
      readShape: 'GOOGLESHEETS_BATCH_GET' | 'GOOGLESHEETS_GET_VALUES';
      range: string;
    }
  | {
      verified: false;
      target: GoogleSheetsSheetTarget;
      reason: GoogleSheetsSheetContentFailureReason;
    };

export type GoogleSheetsSheetReadbackRequestVerdict =
  | {
      authorized: true;
      target: GoogleSheetsSheetTarget;
      readShape: 'GOOGLESHEETS_BATCH_GET' | 'GOOGLESHEETS_GET_VALUES';
      range: string;
    }
  | {
      authorized: false;
      target: GoogleSheetsSheetTarget;
      reason: Extract<GoogleSheetsSheetContentFailureReason,
        | 'unrecognized_read'
        | 'invalid_read_arguments'
        | 'unexpected_value_render_option'
        | 'target_mismatch'
        | 'unexpected_range'>;
    };

const MAX_ROWS = 2_048;
const MAX_COLUMNS = 256;
const MAX_VISITED_NODES = 512;
const MAX_SOURCE_DEPTH = 16;
const MAX_SOURCE_NODES_PER_RECORD = 4_096;
const MAX_SOURCE_LEAVES_PER_RECORD = 2_048;
const SPREADSHEET_URL_RE = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/[^\s]*)?$/i;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizedAction(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^CX_/, '');
}

function toolTail(toolName: string): string {
  return toolName.split('__').at(-1) ?? toolName;
}

function providerAction(
  toolName: string,
  rawArgs: unknown,
): { shape: string; args: Record<string, unknown> } {
  const outer = plainRecord(parsed(rawArgs)) ? parsed(rawArgs) as Record<string, unknown> : {};
  const tail = toolTail(toolName);
  if (normalizedAction(tail) === 'COMPOSIO_EXECUTE_TOOL') {
    return {
      shape: normalizedAction(String(outer.tool_slug ?? outer.slug ?? '')),
      args: plainRecord(parsed(outer.arguments))
        ? parsed(outer.arguments) as Record<string, unknown>
        : {},
    };
  }

  // Direct provider MCP tools carry the toolkit in the preceding namespace:
  // mcp__googlesheets__sheet_from_json -> GOOGLESHEETS_SHEET_FROM_JSON.
  const parts = toolName.split('__').filter(Boolean);
  const normalizedTail = normalizedAction(tail);
  const tailAlreadyNamesSheets = /^(?:GOOGLE_SHEETS|GOOGLESHEETS)_/.test(normalizedTail);
  const directShape = parts.length >= 3
    && /^mcp$/i.test(parts[0])
    && !/^cx_/i.test(tail)
    && !tailAlreadyNamesSheets
    ? `${parts.at(-2)}_${parts.at(-1)}`
    : tail;
  return { shape: normalizedAction(directShape), args: outer };
}

function canonicalCreateShape(shape: string): 'GOOGLESHEETS_SHEET_FROM_JSON' | null {
  return /^(?:GOOGLE_SHEETS|GOOGLESHEETS)_SHEET_FROM_JSON$/.test(shape)
    ? 'GOOGLESHEETS_SHEET_FROM_JSON'
    : null;
}

function canonicalReadShape(
  shape: string,
): 'GOOGLESHEETS_BATCH_GET' | 'GOOGLESHEETS_GET_VALUES' | null {
  if (/^(?:GOOGLE_SHEETS|GOOGLESHEETS)_BATCH_GET$/.test(shape)) {
    return 'GOOGLESHEETS_BATCH_GET';
  }
  if (/^(?:GOOGLE_SHEETS|GOOGLESHEETS)_(?:GET_VALUES|VALUES_GET)$/.test(shape)) {
    return 'GOOGLESHEETS_GET_VALUES';
  }
  return null;
}

function cell(value: unknown): value is GoogleSheetsCell {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function columnName(columnCount: number): string {
  let value = columnCount;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function quotedSheetName(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

/** Compile only a reviewed Sheet-from-JSON action and its provider-ready rows. */
export function compileGoogleSheetsSheetFromJsonContract(
  toolName: string,
  rawArgs: unknown,
): GoogleSheetsSheetFromJsonContract | null {
  const call = providerAction(toolName, rawArgs);
  const createShape = canonicalCreateShape(call.shape);
  if (!createShape) return null;
  const sheetName = typeof call.args.sheet_name === 'string'
    ? call.args.sheet_name.trim()
    : '';
  if (!sheetName || sheetName.length > 256) return null;
  const rowsValue = parsed(call.args.sheet_json);
  if (!Array.isArray(rowsValue) || rowsValue.length < 1 || rowsValue.length > MAX_ROWS) return null;
  if (!rowsValue.every(plainRecord)) return null;

  const headers = Object.keys(rowsValue[0]);
  if (headers.length < 1 || headers.length > MAX_COLUMNS) return null;
  if (headers.some((header) => !header || header.length > 256)) return null;
  const headerSet = new Set(headers);
  if (headerSet.size !== headers.length) return null;

  const expectedRows: GoogleSheetsCell[][] = [];
  for (const row of rowsValue) {
    const keys = Object.keys(row);
    if (keys.length !== headers.length || keys.some((key) => !headerSet.has(key))) return null;
    const values = headers.map((header) => row[header]);
    if (!values.every(cell)) return null;
    expectedRows.push(values as GoogleSheetsCell[]);
  }

  return {
    kind: 'googlesheets_sheet_from_json_content_v1',
    createShape,
    sheetName,
    headers,
    expectedValues: [headers, ...expectedRows],
    expectedRange: `${quotedSheetName(sheetName)}!A1:${columnName(headers.length)}${expectedRows.length + 1}`,
  };
}

interface ExactSheetFields {
  ids: Set<string>;
  urls: Map<string, string>;
}

function collectExactSheetFields(value: unknown): ExactSheetFields | null {
  const pruned = pruneProviderRequestEchoes(parsed(value));
  const result: ExactSheetFields = { ids: new Set(), urls: new Map() };
  const queue: unknown[] = [pruned];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    visited += 1;
    if (visited > MAX_VISITED_NODES) return null;
    if (Array.isArray(current)) {
      if (current.length > MAX_VISITED_NODES) return null;
      queue.push(...current);
      continue;
    }
    if (!plainRecord(current)) continue;
    for (const [rawKey, child] of Object.entries(current)) {
      const key = rawKey.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (key === 'spreadsheetid' && typeof child === 'string' && child.trim()) {
        result.ids.add(child.trim());
      } else if (
        new Set(['spreadsheeturl', 'displayurl']).has(key)
        && typeof child === 'string'
      ) {
        const match = child.trim().match(SPREADSHEET_URL_RE);
        if (match) result.urls.set(match[1], child.trim());
      }
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return result;
}

/** Extract a Sheets target only from exact spreadsheet fields/canonical URL. */
export function extractGoogleSheetsSheetFromJsonTarget(
  createResult: unknown,
): GoogleSheetsSheetTarget | null {
  if (inspectProviderEnvelope(parsed(createResult)).verdict !== 'clean') return null;
  const fields = collectExactSheetFields(createResult);
  if (!fields) return null;
  const ids = new Set([...fields.ids, ...fields.urls.keys()]);
  if (ids.size !== 1) return null;
  const spreadsheetId = [...ids][0];
  if (!/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) return null;
  return {
    provider: 'googlesheets',
    spreadsheetId,
    spreadsheetUrl: fields.urls.get(spreadsheetId) ?? null,
  };
}

function exactSpreadsheetId(args: Record<string, unknown>): string | null {
  const values = [args.spreadsheet_id, args.spreadsheetId]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  return values.length === 1 && /^[A-Za-z0-9_-]+$/.test(values[0]) ? values[0] : null;
}

function requestedRanges(
  shape: 'GOOGLESHEETS_BATCH_GET' | 'GOOGLESHEETS_GET_VALUES',
  args: Record<string, unknown>,
): string[] | null {
  if (shape === 'GOOGLESHEETS_BATCH_GET') {
    if (!Array.isArray(args.ranges) || args.ranges.length !== 1 || typeof args.ranges[0] !== 'string') return null;
    return [args.ranges[0]];
  }
  return typeof args.range === 'string' ? [args.range] : null;
}

interface ParsedA1Range {
  sheetName: string;
  startColumn: string;
  startRow: number;
  endColumn: string;
  endRow: number;
}

function parseA1Range(value: string): ParsedA1Range | null {
  const match = value.trim().match(/^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/i);
  if (!match) return null;
  const sheetName = (match[1] ?? match[2] ?? '').replace(/''/g, "'");
  return {
    sheetName,
    startColumn: match[3].toUpperCase(),
    startRow: Number(match[4]),
    endColumn: match[5].toUpperCase(),
    endRow: Number(match[6]),
  };
}

function rangeMatchesContract(value: string, contract: GoogleSheetsSheetFromJsonContract): boolean {
  const parsedRange = parseA1Range(value);
  const expected = parseA1Range(contract.expectedRange);
  return Boolean(parsedRange && expected
    && parsedRange.sheetName === expected.sheetName
    && parsedRange.startColumn === expected.startColumn
    && parsedRange.startRow === expected.startRow
    && parsedRange.endColumn === expected.endColumn
    && parsedRange.endRow === expected.endRow);
}

function providerData(value: unknown): Record<string, unknown> | null {
  const root = pruneProviderRequestEchoes(parsed(value));
  if (!plainRecord(root)) return null;
  for (const key of ['data', 'response', 'result', 'output']) {
    if (plainRecord(root[key])) return root[key] as Record<string, unknown>;
  }
  return root;
}

function observedReadback(
  shape: 'GOOGLESHEETS_BATCH_GET' | 'GOOGLESHEETS_GET_VALUES',
  result: unknown,
): { range: string | null; values: unknown[][] } | null {
  const data = providerData(result);
  if (!data) return null;
  if (shape === 'GOOGLESHEETS_BATCH_GET') {
    if (!Array.isArray(data.valueRanges) || data.valueRanges.length !== 1) return null;
    const valueRange = data.valueRanges[0];
    if (!plainRecord(valueRange) || !Array.isArray(valueRange.values)) return null;
    if (!valueRange.values.every(Array.isArray)) return null;
    return {
      range: typeof valueRange.range === 'string' ? valueRange.range : null,
      values: valueRange.values as unknown[][],
    };
  }
  if (!Array.isArray(data.values) || !data.values.every(Array.isArray)) return null;
  return {
    range: typeof data.range === 'string' ? data.range : null,
    values: data.values as unknown[][],
  };
}

function exactMatrix(actual: unknown[][], expected: GoogleSheetsCell[][]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((row, rowIndex) => row.length === expected[rowIndex].length
    && row.every((value, columnIndex) => Object.is(value, expected[rowIndex][columnIndex])));
}

/** Validate the exact-id/exact-range request before crossing the provider. */
export function authorizeGoogleSheetsSheetFromJsonReadbackRequest(
  contract: GoogleSheetsSheetFromJsonContract,
  target: GoogleSheetsSheetTarget,
  readToolName: string,
  readArgs: unknown,
): GoogleSheetsSheetReadbackRequestVerdict {
  const call = providerAction(readToolName, readArgs);
  const readShape = canonicalReadShape(call.shape);
  if (!readShape) return { authorized: false, target, reason: 'unrecognized_read' };
  const spreadsheetId = exactSpreadsheetId(call.args);
  const ranges = requestedRanges(readShape, call.args);
  if (!spreadsheetId || !ranges) {
    return { authorized: false, target, reason: 'invalid_read_arguments' };
  }
  if (spreadsheetId !== target.spreadsheetId) {
    return { authorized: false, target, reason: 'target_mismatch' };
  }
  if (!rangeMatchesContract(ranges[0], contract)) {
    return { authorized: false, target, reason: 'unexpected_range' };
  }
  // Sheets defaults this field to FORMATTED_VALUE. Requiring the retained
  // provider enum preserves number/boolean types for the exact matrix check.
  if (call.args.valueRenderOption !== 'UNFORMATTED_VALUE') {
    return { authorized: false, target, reason: 'unexpected_value_render_option' };
  }
  return { authorized: true, target, readShape, range: ranges[0] };
}

/**
 * Verify one provider result against the exact constructor matrix. The caller
 * must pass the original trusted call/result bytes; this helper never follows
 * a pointer supplied by a model and never performs a read itself.
 */
export function verifyGoogleSheetsSheetFromJsonReadback(
  contract: GoogleSheetsSheetFromJsonContract,
  target: GoogleSheetsSheetTarget,
  readToolName: string,
  readArgs: unknown,
  readResult: unknown,
): GoogleSheetsSheetContentVerdict {
  const request = authorizeGoogleSheetsSheetFromJsonReadbackRequest(
    contract,
    target,
    readToolName,
    readArgs,
  );
  if (!request.authorized) return { verified: false, target, reason: request.reason };

  const inspection = inspectProviderEnvelope(parsed(readResult));
  if (inspection.verdict === 'contradicted') {
    return { verified: false, target, reason: 'provider_contradiction' };
  }
  if (inspection.verdict === 'uninspected') {
    return { verified: false, target, reason: 'provider_uninspected' };
  }
  const returnedFields = collectExactSheetFields(readResult);
  if (!returnedFields) return { verified: false, target, reason: 'provider_uninspected' };
  const returnedIds = new Set([...returnedFields.ids, ...returnedFields.urls.keys()]);
  if (returnedIds.size > 0 && (returnedIds.size !== 1 || !returnedIds.has(target.spreadsheetId))) {
    return { verified: false, target, reason: 'target_mismatch' };
  }

  const observed = observedReadback(request.readShape, readResult);
  if (!observed) return { verified: false, target, reason: 'missing_values' };
  if (observed.range && !rangeMatchesContract(observed.range, contract)) {
    return { verified: false, target, reason: 'unexpected_range' };
  }
  if (!exactMatrix(observed.values, contract.expectedValues)) {
    return { verified: false, target, reason: 'content_mismatch' };
  }
  return { verified: true, target, readShape: request.readShape, range: request.range };
}

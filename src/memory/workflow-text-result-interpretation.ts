/** Explicit reviewed parsing rules, never inferred from provider or field names. */
export interface WorkflowTextResultInterpretationV1 {
  version: 1;
  kind: 'text_lines';
  field: string;
  prefix: string;
  whitespace: 'trim' | 'preserve';
  blankLines: 'skip' | 'reject';
  maxSourceBytes: number;
  maxSourceRecords: number;
  selection: { kind: 'first'; maxRecords: number };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function validWorkflowTextResultInterpretation(value: unknown): value is WorkflowTextResultInterpretationV1 {
  if (!object(value) || !keys(value, ['version', 'kind', 'field', 'prefix', 'whitespace', 'blankLines', 'maxSourceBytes', 'maxSourceRecords', 'selection'])) return false;
  return value.version === 1 && value.kind === 'text_lines'
    && typeof value.field === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value.field)
    && !['__proto__', 'prototype', 'constructor'].includes(value.field)
    && typeof value.prefix === 'string' && !/[\r\n]/.test(value.prefix)
    && (value.whitespace === 'trim' || value.whitespace === 'preserve')
    && (value.blankLines === 'skip' || value.blankLines === 'reject')
    && positive(value.maxSourceBytes) && positive(value.maxSourceRecords)
    && object(value.selection) && keys(value.selection, ['kind', 'maxRecords'])
    && value.selection.kind === 'first' && positive(value.selection.maxRecords)
    && value.selection.maxRecords <= value.maxSourceRecords;
}

export interface WorkflowTextSelectionEvidenceV1 {
  kind: 'reviewed_first_records';
  sourceRecords: number;
  selectedRecords: number;
  omittedRecords: number;
  /** Completion applies to the selected scope, never to all source records. */
  scope: 'reviewed_selection';
}

export type InterpretWorkflowTextResult =
  | { ok: true; payload: { records: Record<string, string>[]; selection: WorkflowTextSelectionEvidenceV1 } }
  | { ok: false; reason: 'invalid_interpretation' | 'source_not_text' | 'source_bounds_exceeded' | 'line_shape_mismatch' };

export function interpretWorkflowTextResult(value: unknown, rules: unknown): InterpretWorkflowTextResult {
  if (!validWorkflowTextResultInterpretation(rules)) return { ok: false, reason: 'invalid_interpretation' };
  if (typeof value !== 'string') return { ok: false, reason: 'source_not_text' };
  if (Buffer.byteLength(value, 'utf8') > rules.maxSourceBytes) return { ok: false, reason: 'source_bounds_exceeded' };
  // A terminal newline ends the final line; it does not create an extra record.
  const normalized = value.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) return { ok: false, reason: 'line_shape_mismatch' };
  const lines = normalized === '' ? [] : normalized.replace(/\n$/, '').split('\n');
  const records: Record<string, string>[] = [];
  let sourceRecords = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      if (rules.blankLines === 'skip') continue;
      return { ok: false, reason: 'line_shape_mismatch' };
    }
    if (!line.startsWith(rules.prefix)) return { ok: false, reason: 'line_shape_mismatch' };
    const stripped = line.slice(rules.prefix.length);
    const fieldValue = rules.whitespace === 'trim' ? stripped.trim() : stripped;
    if (fieldValue.length === 0) return { ok: false, reason: 'line_shape_mismatch' };
    sourceRecords += 1;
    if (sourceRecords > rules.maxSourceRecords) return { ok: false, reason: 'source_bounds_exceeded' };
    if (records.length < rules.selection.maxRecords) records.push({ [rules.field]: fieldValue });
  }
  return { ok: true, payload: { records, selection: {
    kind: 'reviewed_first_records', sourceRecords, selectedRecords: records.length,
    omittedRecords: sourceRecords - records.length, scope: 'reviewed_selection',
  } } };
}

/** Retained selection evidence binds counts to the reviewed projection and raw receipt. */
export interface WorkflowTextSelectionReceiptV1 extends WorkflowTextSelectionEvidenceV1 {
  version: 1;
  sourceReceiptId: string;
  sourceResultDigest: string;
  projectionDigest: string;
}
export function validWorkflowTextSelectionReceipt(value: unknown): value is WorkflowTextSelectionReceiptV1 {
  if (!object(value) || !keys(value, ['version', 'kind', 'sourceRecords', 'selectedRecords', 'omittedRecords', 'scope', 'sourceReceiptId', 'sourceResultDigest', 'projectionDigest'])) return false;
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return value.version === 1 && value.kind === 'reviewed_first_records' && value.scope === 'reviewed_selection'
    && count(value.sourceRecords) && count(value.selectedRecords) && count(value.omittedRecords)
    && value.selectedRecords <= value.sourceRecords && value.sourceRecords - value.selectedRecords === value.omittedRecords
    && typeof value.sourceReceiptId === 'string' && value.sourceReceiptId.length > 0 && value.sourceReceiptId === value.sourceReceiptId.trim()
    && typeof value.sourceResultDigest === 'string' && /^[a-f0-9]{64}$/.test(value.sourceResultDigest)
    && typeof value.projectionDigest === 'string' && /^[a-f0-9]{64}$/.test(value.projectionDigest);
}

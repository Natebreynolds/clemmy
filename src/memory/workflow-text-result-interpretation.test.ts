import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { interpretWorkflowTextResult, validWorkflowTextResultInterpretation, type WorkflowTextResultInterpretationV1 } from './workflow-text-result-interpretation.js';
import { projectProviderResultEvidenceView } from '../runtime/harness/result-facts.js';

const rules: WorkflowTextResultInterpretationV1 = {
  version: 1, kind: 'text_lines', field: 'section_name', prefix: '- ',
  whitespace: 'trim', blankLines: 'reject', maxSourceBytes: 10_000,
  maxSourceRecords: 100, selection: { kind: 'first', maxRecords: 5 },
};
const sample = JSON.parse(readFileSync(new URL('../execution/fixtures/documentation-inventory-mcp-result.json', import.meta.url), 'utf8'));

test('the actual text inventory needs explicit interpretation and retains selection scope', () => {
  const original = JSON.stringify(sample);
  assert.equal(projectProviderResultEvidenceView(sample).kind, 'no_evidence');
  const result = projectProviderResultEvidenceView(sample, rules);
  assert.equal(result.kind, 'provider_payload');
  if (result.kind !== 'provider_payload') return;
  assert.equal(result.owner, 'reviewed_text_lines');
  const payload = result.payload as { records: unknown[]; selection: unknown };
  assert.equal(payload.records.length, 5);
  assert.deepEqual(payload.selection, { kind: 'reviewed_first_records', sourceRecords: 13, selectedRecords: 5, omittedRecords: 8, scope: 'reviewed_selection' });
  assert.equal(JSON.stringify(sample), original, 'interpretation never mutates raw receipt bytes');
  assert.deepEqual(projectProviderResultEvidenceView({ complete: true, result: sample }, rules), result);
});

test('selection validates the entire source including omitted records', () => {
  for (const text of ['- A\n- B\nmalformed', '- A\n- B\n- C']) {
    const result = interpretWorkflowTextResult(text, { ...rules, maxSourceRecords: 2, selection: { kind: 'first', maxRecords: 1 } });
    assert.equal(result.ok, false, 'invalid suffix or source overflow cannot hide beyond the selection');
  }
  assert.equal(interpretWorkflowTextResult('- é', { ...rules, maxSourceBytes: 3 }).ok, false, 'bounds count UTF-8 bytes');
});

test('text parsing is deterministic and respects explicit whitespace/blank-line rules', () => {
  assert.deepEqual(interpretWorkflowTextResult('- A\r\n- B\r\n', rules), interpretWorkflowTextResult('- A\n- B', rules));
  assert.equal(interpretWorkflowTextResult('- A\n\n- B', rules).ok, false);
  const skipped = interpretWorkflowTextResult('- A\n\n- B', { ...rules, blankLines: 'skip' });
  assert.equal(skipped.ok, true);
  if (skipped.ok) assert.equal(skipped.payload.selection.sourceRecords, 2);
  const preserved = interpretWorkflowTextResult('-  A ', { ...rules, whitespace: 'preserve' });
  assert.equal(preserved.ok, true);
  if (preserved.ok) assert.equal(preserved.payload.records[0]!.section_name, ' A ');
  assert.equal(interpretWorkflowTextResult('- A\r- B', rules).ok, false);
});

test('text interpretation cannot override errors, structured ownership or ambiguous envelopes', () => {
  for (const raw of [
    { ...sample, isError: true },
    { ...sample, isError: 'false' },
    { ...sample, structuredContent: { records: [{ section_name: 'different' }] } },
    { content: [...sample.content, ...sample.content] },
    { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] },
    { ...sample, foreign: true },
    { complete: false, result: sample },
    { complete: true, result: sample, foreign: true },
  ]) assert.equal(projectProviderResultEvidenceView(raw, rules).kind, 'no_evidence');
});

test('closed interpretation rejects implicit, unbounded or unsafe rules', () => {
  for (const bad of [
    { ...rules, field: '__proto__' }, { ...rules, field: 'constructor' },
    { ...rules, prefix: '\n' }, { ...rules, maxSourceRecords: Infinity },
    { ...rules, maxSourceBytes: 0 }, { ...rules, extra: true },
    { ...rules, selection: { kind: 'all' } },
    { ...rules, selection: { kind: 'first', maxRecords: 101 } },
  ]) {
    assert.equal(validWorkflowTextResultInterpretation(bad), false);
    assert.equal(interpretWorkflowTextResult('- A', bad).ok, false);
  }
});

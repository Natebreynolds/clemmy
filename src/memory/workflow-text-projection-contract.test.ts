import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowCanonicalEntityResultProjection, parseWorkflowCanonicalEntityResultProjection } from './workflow-result-projection-contract.js';
import type { WorkflowCanonicalEntityResultProjectionV1 } from './workflow-result-projection-contract.js';

function contract(): Omit<WorkflowCanonicalEntityResultProjectionV1, 'projectionDigest'> {
  return {
    version: 1, recordsPath: 'records',
    textInterpretation: { version: 1, kind: 'text_lines', field: 'section_name', prefix: '- ', whitespace: 'trim', blankLines: 'reject', maxSourceBytes: 10_000, maxSourceRecords: 100, selection: { kind: 'first', maxRecords: 5 } },
    fields: [
      { field: 'section_name', recordPath: 'section_name', type: 'string', required: true, sensitivity: 'public', confidence: 1 },
      { field: 'run_ref', hostSource: 'workflow_run_id', type: 'string', required: true, sensitivity: 'internal', confidence: 1 },
      { field: 'observed_at', hostSource: 'page_settled_at', type: 'timestamp', required: true, sensitivity: 'public', confidence: 1 },
      { field: 'source_ref', hostSource: 'page_receipt_id', type: 'string', required: true, sensitivity: 'public', confidence: 1 },
    ],
    sourceRecord: { idPath: 'section_name', observedAt: { kind: 'page_settled_at' } },
    entityKind: 'documentation-section',
    identityRules: [{ ruleId: 'section-name', fields: ['section_name'], normalizers: ['case_fold', 'trim'], exactIdentifierNamespace: 'section-name' }],
    resolutionPolicy: { policyId: 'exact-section', mergeThreshold: 10, distinctThreshold: 2, ambiguityMargin: 1, weights: { defaultExactIdentifierMatch: 10, defaultCompoundSignalMatch: 0 }, preferNewerAfterExactIdentity: ['observed_at', 'run_ref', 'source_ref'] },
    fieldResolution: { kind: 'retain_all_evidence', selection: 'highest_confidence_then_newest', conflict: 'mark_conflicting_for_review' },
    provenance: { kind: 'workflow_page_record', retainSourceSnapshots: true },
    partition: { kind: 'workflow_run', coverageItems: 'source_record_occurrences', denominator: 'settled_record_count', completion: 'closed_authority_exhaustion' },
    bounds: { maxPages: 1, maxRecordsPerPage: 5, maxRecords: 5, maxPageBytes: 20_000, maxRecordBytes: 1000, maxTotalBytes: 20_000 },
  };
}

test('the original four-field inventory schema supports explicit text and verified host provenance', () => {
  const parsed = createWorkflowCanonicalEntityResultProjection(contract());
  assert.equal(parseWorkflowCanonicalEntityResultProjection(parsed).ok, true);
  const changed = contract();
  changed.textInterpretation!.prefix = '* ';
  assert.notEqual(createWorkflowCanonicalEntityResultProjection(changed).projectionDigest, parsed.projectionDigest);
  assert.equal(parseWorkflowCanonicalEntityResultProjection({ ...parsed, textInterpretation: changed.textInterpretation }).ok, false, 'reviewed digest cannot authorize different parsing');
});

test('inconsistent selection, source mapping and pagination cannot enter the approved projection', () => {
  for (const mutate of [
    (c: ReturnType<typeof contract>) => { c.textInterpretation!.selection.maxRecords = 4; },
    (c: ReturnType<typeof contract>) => { c.textInterpretation!.maxSourceBytes = 20_001; },
    (c: ReturnType<typeof contract>) => { c.bounds.maxPages = 2; },
    (c: ReturnType<typeof contract>) => { c.sourceRecord.idPath = 'invented'; },
    (c: ReturnType<typeof contract>) => { c.sourceRecord.revisionPath = 'invented'; },
    (c: ReturnType<typeof contract>) => { c.recordsPath = 'invented'; },
    (c: ReturnType<typeof contract>) => { c.fields[0]!.recordPath = 'invented'; },
    (c: ReturnType<typeof contract>) => { c.sourceRecord.observedAt = { kind: 'record_path', path: 'invented' }; },
  ]) {
    const candidate = contract(); mutate(candidate);
    assert.throws(() => createWorkflowCanonicalEntityResultProjection(candidate));
  }
});

test('text authoring reports every repairable mapping mismatch with the expected value', () => {
  const candidate = contract();
  candidate.recordsPath = 'content';
  candidate.sourceRecord.idPath = 'value';
  candidate.fields[0]!.recordPath = 'value';
  assert.throws(() => createWorkflowCanonicalEntityResultProjection(candidate), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /recordsPath must equal "records"/);
    assert.match(error.message, /sourceRecord.idPath must equal textInterpretation.field "section_name"/);
    assert.match(error.message, /fields\[0\].recordPath must equal textInterpretation.field "section_name"/);
    return true;
  });
});

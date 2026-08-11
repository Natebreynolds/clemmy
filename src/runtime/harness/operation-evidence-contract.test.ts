import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationEvidenceContract } from '../graph/operation-evidence-contract.js';

test('a point lookup does not inherit collection exhaustion', () => {
  assert.deepEqual(operationEvidenceContract({
    resolvedTool: 'crm__get_contact_by_id', effectKind: 'read', reversibility: 'read_only',
  }), {
    mode: 'point_read', requiresExhaustion: false, requiresStaleReconciliation: false,
  });
});

test('an unfamiliar read fails closed to collection semantics', () => {
  assert.equal(operationEvidenceContract({
    resolvedTool: 'provider__records', effectKind: 'read', reversibility: 'read_only',
  }).requiresExhaustion, true);
});

test('an append never inherits replacement reconciliation', () => {
  assert.deepEqual(operationEvidenceContract({
    resolvedTool: 'sheets__append_rows', effectKind: 'external_write', reversibility: 'reversible',
  }), {
    mode: 'append', requiresExhaustion: false, requiresStaleReconciliation: false,
  });
});

test('only replacement-shaped mutations owe stale destination reconciliation', () => {
  assert.equal(operationEvidenceContract({
    resolvedTool: 'sheets__replace_rows', effectKind: 'external_write', reversibility: 'reversible',
  }).requiresStaleReconciliation, true);
  assert.equal(operationEvidenceContract({
    resolvedTool: 'sheets__create_sheet', effectKind: 'external_write', reversibility: 'reversible',
  }).requiresStaleReconciliation, false);
  assert.equal(operationEvidenceContract({
    resolvedTool: 'sheets__update_cell', effectKind: 'external_write', reversibility: 'reversible',
  }).requiresStaleReconciliation, false);
});

test('irreversible evidence wins over a misleading create token', () => {
  assert.equal(operationEvidenceContract({
    resolvedTool: 'calendar__create_invite', effectKind: 'external_write', reversibility: 'irreversible',
  }).mode, 'send');
});

/**
 * Run: npx tsx --test src/runtime/harness/argument-correction-repair.test.ts
 *
 * A read carrying a value its tool rejected twice, always fixed by leaving it
 * out, goes without it; nothing else in the call changes, and nothing short
 * of that record (one pair, a conflict, a write, a different value, a
 * replacement fix) is applied.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { repairWithArgumentCorrections, argumentCorrectionRepairLine } from './argument-correction-repair.js';
import type { ArgumentCorrection } from '../../memory/argument-corrections-store.js';

const ORG = 'ORGID00FIXTURE0001';
const record = (patch: Partial<ArgumentCorrection> = {}): ArgumentCorrection => ({
  operation: 'records_query', effect: 'read', argument: 'target_org', rejectedValue: ORG, fix: { kind: 'omit' },
  error: 'No authorization information found for ORGID00FIXTURE0001', pairs: 2,
  firstSeen: '2026-10-24T00:00:00.000Z', lastSeen: '2026-10-24T00:00:00.000Z', ...patch,
});
const call = (inner: Record<string, unknown>) => JSON.stringify({
  requirement_id: 'cap:live:fixture', name: 'records_query', args_json: JSON.stringify(inner), universe_item_id: null,
});

test('the rejected value is left out of the nested carrier; everything else stays', () => {
  const repaired = repairWithArgumentCorrections({
    argumentsJson: call({ query: 'SELECT Id FROM Account', target_org: ORG }), operation: 'RECORDS_QUERY', corrections: [record()],
  });
  assert.ok(repaired);
  const outer = JSON.parse(repaired!.argumentsJson);
  assert.equal(outer.requirement_id, 'cap:live:fixture');
  assert.equal(outer.universe_item_id, null);
  assert.deepEqual(JSON.parse(outer.args_json), { query: 'SELECT Id FROM Account' });
  assert.equal(repaired!.applied.length, 1);
  assert.match(argumentCorrectionRepairLine('call-1', repaired!.applied[0]!),
    /^Host repair for call call-1: records_query rejected target_org="ORGID00FIXTURE0001" 2 times before .* so the call ran with target_org left out\. That call already ran in the repaired form/);
});

test('nothing short of a repairable record for this exact value is applied', () => {
  const args = call({ query: 'SELECT Id FROM Account', target_org: ORG });
  for (const [label, corrections, operation, argumentsJson] of [
    ['one pair', [record({ pairs: 1 })], 'records_query', args],
    ['conflicting', [record({ conflicting: true })], 'records_query', args],
    ['learned from a write', [record({ effect: 'local_write' })], 'records_query', args],
    ['a replacement fix', [record({ fix: { kind: 'replace', value: 'owner@example.com' } })], 'records_query', args],
    ['another operation', [record()], 'other_query', args],
    ['another value', [record()], 'records_query', call({ query: 'SELECT Id FROM Account', target_org: 'owner@example.com' })],
  ] as const) {
    assert.equal(repairWithArgumentCorrections({ argumentsJson, operation, corrections: [...corrections] }), null, label);
  }
});

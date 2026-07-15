import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryAssuranceView, memoryClaimTemporalStatus } from './memory-assurance.js';
import type { MemoryReadinessReport, MemoryReadinessStatus } from './memory.js';

function report(statuses: MemoryReadinessStatus[], ready: boolean): MemoryReadinessReport {
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  statuses.forEach((status) => { summary[status] += 1; });
  return {
    reportVersion: 1,
    generatedAt: '2026-07-15T12:00:00.000Z',
    mode: 'read-only',
    expectedSchemaVersion: 26,
    observedSchemaVersion: 25,
    ready,
    summary,
    checks: statuses.map((status, index) => ({
      id: `check-${index}`,
      label: `Check ${index}`,
      status,
      blocking: status === 'fail',
      summary: `${status} detail`,
    })),
  };
}

test('ready memory leads with assurance while preserving advisories', () => {
  const view = memoryAssuranceView(report(['pass', 'pass', 'warn'], true));
  assert.equal(view.tone, 'success');
  assert.equal(view.statusLabel, 'Ready');
  assert.equal(view.priorityChecks.length, 1);
  assert.match(view.detail, /2 checks pass/);
});

test('blocking failures always override passes and warnings', () => {
  const view = memoryAssuranceView(report(['pass', 'warn', 'fail', 'fail'], false));
  assert.equal(view.tone, 'danger');
  assert.equal(view.statusLabel, 'Withheld');
  assert.equal(view.priorityChecks.length, 2);
  assert.match(view.detail, /2 blocking safeguards failed/);
});

test('skipped checks never masquerade as ready', () => {
  const view = memoryAssuranceView(report(['pass', 'skip'], false));
  assert.equal(view.tone, 'warning');
  assert.equal(view.statusLabel, 'Review');
  assert.deepEqual(view.priorityChecks.map((item) => item.status), ['skip']);
});

test('claim temporal labels distinguish active rows from currently valid claims', () => {
  const asOf = '2026-07-15T17:00:00.000Z';
  assert.equal(memoryClaimTemporalStatus({ active: true, validFrom: null, validTo: null }, asOf), 'current');
  assert.equal(memoryClaimTemporalStatus({ active: true, validFrom: '2026-07-15T18:00:00.000Z', validTo: null }, asOf), 'scheduled');
  assert.equal(memoryClaimTemporalStatus({ active: true, validFrom: '2026-07-01T00:00:00.000Z', validTo: '2026-07-15T17:00:00.000Z' }, asOf), 'historical');
  assert.equal(memoryClaimTemporalStatus({ active: false, validFrom: null, validTo: null }, asOf), 'historical');
});

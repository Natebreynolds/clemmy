import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportOnlyCuratorReport } from './curator.js';

test('buildReportOnlyCuratorReport is report-only and structurally stable', () => {
  const report = buildReportOnlyCuratorReport(new Date('2026-07-01T12:00:00.000Z'));

  assert.equal(report.id, 'curator-2026-07-01');
  assert.equal(report.mode, 'report-only');
  assert.equal(report.mutationApplied, false);
  assert.equal(typeof report.counts.activeFacts, 'number');
  assert.ok(Array.isArray(report.findings));
  assert.ok(report.recommendations.length >= 1);
});

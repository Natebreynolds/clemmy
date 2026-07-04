import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-curator-test-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

let buildReportOnlyCuratorReport: typeof import('./curator.js').buildReportOnlyCuratorReport;
let resetMemoryDb: typeof import('./db.js').resetMemoryDb;
let rememberFact: typeof import('./facts.js').rememberFact;
let appendFactRecallTrace: typeof import('./recall-trace.js').appendFactRecallTrace;
let detectMemoryHealCandidates: typeof import('./self-heal.js').detectMemoryHealCandidates;
let listProposedMemoryFixes: typeof import('./self-heal.js').listProposedMemoryFixes;

test.before(async () => {
  ({ buildReportOnlyCuratorReport } = await import('./curator.js'));
  ({ resetMemoryDb } = await import('./db.js'));
  ({ rememberFact } = await import('./facts.js'));
  ({ appendFactRecallTrace } = await import('./recall-trace.js'));
  ({ detectMemoryHealCandidates } = await import('./self-heal.js'));
  ({ listProposedMemoryFixes } = await import('./self-heal.js'));
});

test.beforeEach(() => {
  resetMemoryDb();
  rmSync(path.join(TEST_HOME, 'state', 'memory-self-heal'), { recursive: true, force: true });
  rmSync(path.join(TEST_HOME, 'state', 'memory-recall-trace.jsonl'), { force: true });
});

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('buildReportOnlyCuratorReport is report-only and structurally stable', () => {
  const report = buildReportOnlyCuratorReport(new Date('2026-07-01T12:00:00.000Z'));

  assert.equal(report.id, 'curator-2026-07-01');
  assert.equal(report.mode, 'report-only');
  assert.equal(report.mutationApplied, false);
  assert.equal(typeof report.counts.activeFacts, 'number');
  assert.equal(typeof report.counts.memorySelfHealProposals, 'number');
  assert.equal(typeof report.counts.currentMemorySelfHealCandidates, 'number');
  assert.equal(typeof report.counts.recentFactRecallTraceEntries, 'number');
  assert.ok(Array.isArray(report.findings));
  assert.ok(report.recommendations.length >= 1);
});

test('buildReportOnlyCuratorReport surfaces pending self-heal proposals and concentrated recall trace', () => {
  const fact = rememberFact({
    kind: 'project',
    content: 'Temporary browser detail repeatedly leaked into global memory context.',
    importance: 5,
    trustLevel: 0.6,
    derivedFrom: { tool: 'browser_read', sessionId: 'sess-curator' },
  });
  for (let i = 0; i < 8; i += 1) {
    appendFactRecallTrace({
      surface: 'facts_for_instructions',
      facts: [{ fact, reason: 'scored-stanford-global' }],
      nowIso: `2026-07-01T12:00:0${i}.000Z`,
    });
  }
  detectMemoryHealCandidates({ nowIso: '2026-07-01T12:01:00.000Z' });

  const report = buildReportOnlyCuratorReport(new Date('2026-07-01T12:02:00.000Z'));

  assert.equal(report.counts.memorySelfHealProposals, 1);
  assert.equal(report.counts.pendingMemorySelfHealProposals, 1);
  assert.equal(report.counts.currentMemorySelfHealCandidates, 1);
  assert.equal(report.counts.recentFactRecallTraceEntries, 8);
  assert.equal(report.counts.recentFactRecallDistinctFacts, 1);
  assert.ok(report.findings.some((finding) => /pending reversible proposals/.test(finding.message)));
  assert.ok(report.findings.some((finding) => /concentrated/.test(finding.message)));
});

test('buildReportOnlyCuratorReport previews current self-heal candidates without persisting proposals', () => {
  const fact = rememberFact({
    kind: 'project',
    content: 'Preview-only browser detail repeatedly leaked into global memory context.',
    importance: 5,
    trustLevel: 0.6,
    derivedFrom: { tool: 'browser_read', sessionId: 'sess-curator-preview' },
  });
  for (let i = 0; i < 8; i += 1) {
    appendFactRecallTrace({
      surface: 'facts_for_instructions',
      facts: [{ fact, reason: 'scored-stanford-global' }],
      nowIso: `2026-07-01T13:00:0${i}.000Z`,
    });
  }

  const report = buildReportOnlyCuratorReport(new Date('2026-07-01T13:02:00.000Z'));

  assert.equal(report.counts.memorySelfHealProposals, 0);
  assert.equal(report.counts.pendingMemorySelfHealProposals, 0);
  assert.equal(report.counts.currentMemorySelfHealCandidates, 1);
  assert.equal(listProposedMemoryFixes().length, 0, 'curator current-candidate preview must not persist proposals');
  assert.ok(report.findings.some((finding) => /current reversible candidates/.test(finding.message)));
});

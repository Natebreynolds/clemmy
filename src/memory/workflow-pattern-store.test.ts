import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-workflow-patterns-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  listWorkflowPatterns,
  recallWorkflowPatterns,
  recordSuccessfulWorkflowPattern,
  renderWorkflowPatternHint,
} = await import('./workflow-pattern-store.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

const workflow = {
  name: 'Weekly SEO Audit',
  description: 'Audit law firm SEO visibility and draft a client-ready report',
  enabled: true,
  trigger: { manual: true },
  allowedTools: ['read_file', 'write_file'],
  steps: [
    { id: 'research', prompt: 'Research rankings', sideEffect: 'read' },
    { id: 'build', prompt: 'Write the report', dependsOn: ['research'], usesSkill: 'proposal-builder', sideEffect: 'write' },
    { id: 'export', prompt: 'Export JSON', deterministic: { runner: 'export-report.ts' }, sideEffect: 'write' },
  ],
};

test('records and recalls clean workflow patterns', () => {
  const first = recordSuccessfulWorkflowPattern({
    workflow: workflow as never,
    workflowSlug: 'weekly-seo-audit',
    runId: 'run-1',
    finalOutput: 'Saved report to /tmp/report.md with 8 opportunities.',
  });
  assert.ok(first);
  assert.equal(first!.successCount, 1);
  assert.ok(first!.tools.includes('read_file'));
  assert.ok(first!.tools.includes('skill:proposal-builder'));
  assert.ok(first!.tools.includes('script:export-report.ts'));

  const second = recordSuccessfulWorkflowPattern({
    workflow: workflow as never,
    workflowSlug: 'weekly-seo-audit',
    runId: 'run-2',
    finalOutput: 'Saved refreshed report to /tmp/report-2.md.',
  });
  assert.equal(second!.successCount, 2);

  const all = listWorkflowPatterns();
  assert.equal(all.length, 1);
  assert.equal(all[0].lastRunId, 'run-2');

  const matches = recallWorkflowPatterns('client SEO audit report for a law firm', 2);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.workflowName, 'Weekly SEO Audit');
  assert.ok(matches[0].score > 0);

  const hint = renderWorkflowPatternHint(matches);
  assert.ok(hint.includes('LEARNED WORKFLOW PATTERNS'));
  assert.ok(hint.includes('Weekly SEO Audit'));
  assert.ok(hint.includes('explicit workflow instructions'));
});

test('misses unrelated workflow intents conservatively', () => {
  const matches = recallWorkflowPatterns('book a restaurant reservation', 2);
  assert.equal(matches.length, 0);
});

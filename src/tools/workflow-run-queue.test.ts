/**
 * Run: npx tsx --test src/tools/workflow-run-queue.test.ts
 *
 * Deterministic core of ask-then-resume: queueWorkflowRun (queue + dedupe) and
 * resumeWorkflowRun (lookup + validate missing inputs + queue). No model calls.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-queue-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const { queueWorkflowRun, resumeWorkflowRun } = await import('./workflow-run-queue.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('./shared.js');

function writeAuditWorkflow(enabled = true): void {
  writeWorkflow('audit-brief', {
    name: 'audit-brief',
    description: 'Audit a site from a URL.',
    enabled,
    trigger: { manual: true },
    steps: [{ id: 'normalize', prompt: 'Normalize the prospect: {{input.url}}.' }],
  });
}

function runFiles(): string[] {
  try { return readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json')); }
  catch { return []; }
}

beforeEach(() => {
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
});

test('queueWorkflowRun: writes a queued run and dedupes identical inputs', () => {
  const first = queueWorkflowRun('audit-brief', { url: 'https://x.com' });
  assert.equal(first.status, 'queued');
  assert.match(first.message, /Queued workflow "audit-brief"/);
  assert.equal(runFiles().length, 1);

  const second = queueWorkflowRun('audit-brief', { url: 'https://x.com' });
  assert.equal(second.status, 'duplicate');
  assert.match(second.message, /No duplicate was queued/);
  assert.equal(runFiles().length, 1);
});

test('resumeWorkflowRun: missing required input → missing_inputs, no queue', () => {
  writeAuditWorkflow();
  const result = resumeWorkflowRun('audit-brief', {});
  assert.equal(result.status, 'missing_inputs');
  assert.deepEqual(result.missing, ['url']);
  assert.equal(runFiles().length, 0);
});

test('resumeWorkflowRun: all inputs supplied → queues the run', () => {
  writeAuditWorkflow();
  const result = resumeWorkflowRun('audit-brief', { url: 'https://revill.co.uk' });
  assert.equal(result.status, 'queued');
  assert.match(result.message, /Queued workflow "audit-brief"/);
  assert.equal(runFiles().length, 1);
});

test('resumeWorkflowRun: url alias (website) normalizes to satisfy url', () => {
  writeAuditWorkflow();
  const result = resumeWorkflowRun('audit-brief', { website: 'https://revill.co.uk' });
  assert.equal(result.status, 'queued');
  assert.equal(runFiles().length, 1);
});

test('resumeWorkflowRun: unknown workflow → not_found', () => {
  const result = resumeWorkflowRun('does-not-exist', { url: 'https://x.com' });
  assert.equal(result.status, 'not_found');
  assert.equal(runFiles().length, 0);
});

test('resumeWorkflowRun: disabled workflow → disabled', () => {
  writeAuditWorkflow(false);
  const result = resumeWorkflowRun('audit-brief', { url: 'https://x.com' });
  assert.equal(result.status, 'disabled');
  assert.equal(runFiles().length, 0);
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

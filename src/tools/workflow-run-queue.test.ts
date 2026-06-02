/**
 * Run: npx tsx --test src/tools/workflow-run-queue.test.ts
 *
 * Deterministic core of ask-then-resume: queueWorkflowRun (queue + dedupe) and
 * resumeWorkflowRun (lookup + validate missing inputs + queue). No model calls.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-queue-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const { queueWorkflowRun, resumeWorkflowRun, requeueWorkflowFromRun } = await import('./workflow-run-queue.js');
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
  // Fire-and-forget hand-off wording (A): names the workflow + says background + report-back.
  assert.match(first.message, /Queued "audit-brief"/);
  assert.match(first.message, /BACKGROUND/);
  assert.match(first.message, /report back/i);
  assert.match(first.message, /do NOT (wait|poll)/i);
  assert.equal(runFiles().length, 1);

  const second = queueWorkflowRun('audit-brief', { url: 'https://x.com' });
  assert.equal(second.status, 'duplicate');
  assert.match(second.message, /No duplicate was queued/);
  assert.match(second.message, /running in the background/i);
  assert.equal(runFiles().length, 1);
});

test('queueWorkflowRun: writes originSessionId when provided (Gap E)', () => {
  const r = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { originSessionId: 'sess-chat-1' });
  assert.equal(r.status, 'queued');
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.originSessionId, 'sess-chat-1');
});

test('queueWorkflowRun: omits originSessionId when absent → scheduled/dashboard records unchanged (Gap E)', () => {
  queueWorkflowRun('audit-brief', { url: 'https://y.com' });
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.ok(!('originSessionId' in rec), 'no origin → field is not written (notification-only run)');
});

test('resumeWorkflowRun: carries originSessionId through to the queued run (Gap E ask-then-resume)', () => {
  writeAuditWorkflow();
  const result = resumeWorkflowRun('audit-brief', { url: 'https://revill.co.uk' }, { originSessionId: 'sess-chat-2' });
  assert.equal(result.status, 'queued');
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.originSessionId, 'sess-chat-2');
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
  assert.match(result.message, /Queued "audit-brief"/);
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

test('requeueWorkflowFromRun re-queues a failed run with its original inputs (build→fix→re-run loop)', () => {
  writeAuditWorkflow();
  // Simulate a prior FAILED run record (terminal → not a dedupe target).
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-failed-run';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://revill.co.uk' }, status: 'error' }),
    'utf-8',
  );
  const rq = requeueWorkflowFromRun(origId);
  assert.equal(rq.status, 'queued');
  // A NEW queued run exists for the same workflow + inputs.
  const queued = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as { workflow: string; inputs: Record<string, string>; status: string });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].workflow, 'audit-brief');
  assert.equal(queued[0].inputs.url, 'https://revill.co.uk');
  assert.equal(queued[0].status, 'queued');
});

test('requeueWorkflowFromRun: missing original run → not_found (best-effort, no throw)', () => {
  assert.equal(requeueWorkflowFromRun('does-not-exist').status, 'not_found');
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

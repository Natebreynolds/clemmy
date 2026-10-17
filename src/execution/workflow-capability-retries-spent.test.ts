/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-capability-retries-spent.test.ts
 *
 * A run parked because the service could not be reached to check its
 * connection stops on its own once its automatic tries are spent, but only
 * when it did no work. Live 2026-10-16: a network blip parked a scheduled
 * review that then refused every later run as a duplicate until it was
 * cancelled by hand.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-retries-spent-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { reapCapabilityBlockedRuns } = await import('./workflow-runner.js');
const { createWorkflowRunDefinitionSnapshot } = await import('./workflow-run-definition.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');

const SLUG = 'unreachable-review';

function parkUnreachable(runId: string, over: { retryCount: number; stepOutputs?: Record<string, unknown> }): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const definition = {
    name: 'Unreachable Review',
    description: 'Read a sheet, then summarize it.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'gather', prompt: 'Read the rows.' },
      { id: 'main', prompt: 'Summarize the rows with GOOGLESHEETS_BATCH_GET.' },
    ],
  };
  const retryAt = new Date(Date.now() - 1_000).toISOString();
  writeFileSync(filePath, JSON.stringify({
    id: runId,
    workflow: 'Unreachable Review',
    workflowSlug: SLUG,
    workflowDefinitionSnapshot: createWorkflowRunDefinitionSnapshot(SLUG, definition, '2026-10-16T12:00:00.000Z'),
    status: 'blocked_capability',
    ...(over.stepOutputs ? { stepOutputs: over.stepOutputs } : {}),
    capabilityBlock: {
      stepId: 'main',
      tool: 'GOOGLESHEETS_BATCH_GET',
      toolkit: 'googlesheets',
      reason: 'connection-check-unavailable',
      message: 'the check could not complete (selected_definition_revalidation_refused: selected_connection_refresh_unavailable).',
      blockedAt: new Date(Date.parse(retryAt) - 60_000).toISOString(),
      retryAt,
      retryCount: over.retryCount,
      provenNoDispatch: true,
      state: 'blocked',
    },
  }, null, 2), 'utf-8');
  return filePath;
}

function readRecord(filePath: string): { status?: string; error?: string; capabilityBlock?: { state?: string } } {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

test('a run that could not reach the service on any try, and did no work, stops instead of holding its workflow', () => {
  const filePath = parkUnreachable('unreachable-spent-no-work', { retryCount: 5 });
  assert.equal(reapCapabilityBlockedRuns(Date.now()), 0, 'nothing is re-admitted');
  const after = readRecord(filePath);
  assert.equal(after.status, 'cancelled');
  assert.match(after.error ?? '', /couldn't reach Googlesheets on any of 5 tries/);
  assert.match(after.error ?? '', /Nothing was sent/);
  const events = readFileSync(path.join(WORKFLOWS_DIR, SLUG, 'runs', 'unreachable-spent-no-work', 'events.jsonl'), 'utf-8');
  assert.match(events, /"kind":"run_cancelled"/);
});

test('a run that already did work keeps waiting for the person when its tries are spent', () => {
  const filePath = parkUnreachable('unreachable-spent-worked', { retryCount: 5, stepOutputs: { gather: 'rows' } });
  assert.equal(reapCapabilityBlockedRuns(Date.now()), 0);
  assert.equal(readRecord(filePath).status, 'blocked_capability', 'stopping it would throw away the finished step');
});

test('a run that did work in its history keeps waiting even without a step output on the record', () => {
  const runId = 'unreachable-spent-history';
  const filePath = parkUnreachable(runId, { retryCount: 5 });
  const eventsDir = path.join(WORKFLOWS_DIR, SLUG, 'runs', runId);
  mkdirSync(eventsDir, { recursive: true });
  writeFileSync(path.join(eventsDir, 'events.jsonl'), `${JSON.stringify({ kind: 'step_completed', stepId: 'gather' })}\n`);
  assert.equal(reapCapabilityBlockedRuns(Date.now()), 0);
  assert.equal(readRecord(filePath).status, 'blocked_capability');
});

test('within its tries the same run is re-admitted, not stopped', () => {
  const filePath = parkUnreachable('unreachable-retrying', { retryCount: 2 });
  assert.equal(reapCapabilityBlockedRuns(Date.now()), 1);
  const after = readRecord(filePath);
  assert.equal(after.status, 'running');
  assert.equal(after.capabilityBlock?.state, 'retrying');
});

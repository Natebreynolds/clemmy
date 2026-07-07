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

const { queueWorkflowRun, queueWorkflowDryRun, resumeWorkflowRun, requeueWorkflowFromRun, requeueWorkflowFailedItemsFromRun, queueWorkflowCreationTest } = await import('./workflow-run-queue.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { appendWorkflowEvent } = await import('../execution/workflow-events.js');
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

test('queueWorkflowRun: duplicate attaches the current origin so report-back can still land here', () => {
  const first = queueWorkflowRun('audit-brief', { url: 'https://x.com' });
  assert.equal(first.status, 'queued');

  const second = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { originSessionId: 'sess-chat-dup' });
  assert.equal(second.status, 'duplicate');

  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.originSessionId, 'sess-chat-dup');
  assert.ok(!('originSessionIds' in rec), 'single origin stays on the legacy field only');
});

test('queueWorkflowRun: duplicate preserves primary origin and adds secondary origin observers', () => {
  const first = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { originSessionId: 'sess-chat-a' });
  assert.equal(first.status, 'queued');

  const second = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { originSessionId: 'sess-chat-b' });
  assert.equal(second.status, 'duplicate');

  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.originSessionId, 'sess-chat-a');
  assert.deepEqual(rec.originSessionIds, ['sess-chat-a', 'sess-chat-b']);

  queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { originSessionId: 'sess-chat-b' });
  const rec2 = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.deepEqual(rec2.originSessionIds, ['sess-chat-a', 'sess-chat-b'], 'duplicate observer is not repeated');
});

test('queueWorkflowRun: omits originSessionId when absent for notification-only runs (Gap E)', () => {
  queueWorkflowRun('audit-brief', { url: 'https://y.com' });
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.ok(!('originSessionId' in rec), 'no origin → field is not written (notification-only run)');
});

test('queueWorkflowRun: source and targetStepId metadata do not collide with full-run dedupe', () => {
  const full = queueWorkflowRun('audit-brief', { url: 'https://x.com' });
  assert.equal(full.status, 'queued');

  const stepTry = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, {
    source: 'console',
    targetStepId: 'normalize',
  });
  assert.equal(stepTry.status, 'queued');
  assert.equal(runFiles().length, 2, 'a TRY run is distinct from a full run with the same inputs');

  const duplicateTry = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, {
    source: 'console',
    targetStepId: 'normalize',
  });
  assert.equal(duplicateTry.status, 'duplicate');
  assert.equal(runFiles().length, 2);

  const records = runFiles().map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>);
  const tryRecord = records.find((record) => record.targetStepId === 'normalize');
  assert.equal(tryRecord?.source, 'console');
  assert.deepEqual(tryRecord?.recoveryIntent, {
    kind: 'step_try',
    createdAt: tryRecord?.createdAt,
    sourceStepId: 'normalize',
    requestedFrom: 'console',
    reason: 'single-step try run',
  });
});

test('queueWorkflowRun: dedupe false queues fresh scheduled-style records with a prefix', () => {
  const first = queueWorkflowRun('audit-brief', {}, { source: 'schedule', idPrefix: 'sched', dedupe: false });
  const second = queueWorkflowRun('audit-brief', {}, { source: 'schedule', idPrefix: 'sched', dedupe: false });
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  assert.equal(runFiles().length, 2);

  const records = runFiles().map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>);
  assert.ok(records.every((record) => typeof record.id === 'string' && record.id.startsWith('sched-')));
  assert.ok(records.every((record) => record.source === 'schedule'));
});

test('queueWorkflowRun: persists execution optimization recovery intent', () => {
  const result = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, {
    source: 'board',
    dedupe: false,
    recoveryIntent: {
      kind: 'execution_optimize',
      sourceRunId: 'source-run',
      sourceStepId: 'process_each',
      requestedFrom: 'graph_execution_drift',
      reason: 'graph execution optimization rerun: fanout_underused',
    },
  });
  assert.equal(result.status, 'queued');
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8')) as {
    createdAt?: string;
    recoveryIntent?: {
      kind?: string;
      createdAt?: string;
      sourceRunId?: string;
      sourceStepId?: string;
      requestedFrom?: string;
      reason?: string;
    };
  };
  assert.deepEqual(rec.recoveryIntent, {
    kind: 'execution_optimize',
    createdAt: rec.createdAt,
    sourceRunId: 'source-run',
    sourceStepId: 'process_each',
    requestedFrom: 'graph_execution_drift',
    reason: 'graph execution optimization rerun: fanout_underused',
  });
});

test('queueWorkflowRun: blocks production runs when required workflow capabilities are missing', () => {
  writeWorkflow('missing-script-flow', {
    name: 'missing-script-flow',
    description: 'Needs a deterministic helper.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'merge', prompt: 'Merge evidence.', deterministic: { runner: 'missing.py' } }],
  });

  const result = queueWorkflowRun('missing-script-flow', {});
  assert.equal(result.status, 'blocked_readiness');
  assert.match(result.message, /missing\.py/);
  assert.equal(runFiles().length, 0);
  assert.equal(result.readiness?.ok, false);
  assert.equal(result.readiness?.blockers[0]?.kind, 'script');
  assert.equal(result.readiness?.blockers[0]?.name, 'missing.py');
});

test('queueWorkflowRun: allows unknown Composio slugs as warnings when the broker exists', () => {
  writeWorkflow('unknown-composio-flow', {
    name: 'unknown-composio-flow',
    description: 'Uses a connected-app slug resolved at runtime.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'fetch', prompt: 'Fetch CRM records.', call: { tool: 'SALESFORCE_GET_RECORDS', args: {} } }],
  });

  const result = queueWorkflowRun('unknown-composio-flow', {});
  assert.equal(result.status, 'queued');
  assert.equal(result.readiness?.ok, true);
  assert.equal(result.readiness?.warnings[0]?.name, 'SALESFORCE_GET_RECORDS');
  assert.equal(runFiles().length, 1);
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8')) as {
    readiness?: {
      ok?: boolean;
      scope?: string;
      warnings?: Array<{ name?: string; sources?: string[]; evidence?: Array<{ kind?: string; name?: string; status?: string }> }>;
      toolReadiness?: { unknownCount?: number; items?: Array<{ name?: string; status?: string; evidence?: Array<{ kind?: string; name?: string; status?: string }> }> };
    };
  };
  assert.equal(rec.readiness?.ok, true);
  assert.equal(rec.readiness?.scope, 'run');
  assert.equal(rec.readiness?.warnings?.[0]?.name, 'SALESFORCE_GET_RECORDS');
  assert.deepEqual(rec.readiness?.warnings?.[0]?.sources, ['step_call']);
  assert.ok(rec.readiness?.warnings?.[0]?.evidence?.some((entry) => entry.kind === 'composio_broker' && entry.name === 'composio_execute_tool' && entry.status === 'ready'));
  assert.equal(rec.readiness?.toolReadiness?.unknownCount, 1);
});

test('queueWorkflowRun: step TRY readiness only checks the selected step', () => {
  writeWorkflow('try-readiness-flow', {
    name: 'try-readiness-flow',
    description: 'Has one safe step and one missing script.',
    enabled: false,
    trigger: { manual: true },
    steps: [
      { id: 'safe', prompt: 'Read local notes.', allowedTools: ['read_file'] },
      { id: 'broken', prompt: 'Merge evidence.', deterministic: { runner: 'missing.py' } },
    ],
  });

  const safe = queueWorkflowRun('try-readiness-flow', {}, { targetStepId: 'safe', dedupe: false });
  assert.equal(safe.status, 'queued');
  const safeRecord = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8')) as {
    readiness?: { ok?: boolean; scope?: string; targetStepId?: string; blockers?: unknown[]; toolReadiness?: { missingCount?: number } };
  };
  assert.equal(safeRecord.readiness?.ok, true);
  assert.equal(safeRecord.readiness?.scope, 'step');
  assert.equal(safeRecord.readiness?.targetStepId, 'safe');
  assert.deepEqual(safeRecord.readiness?.blockers, []);
  assert.equal(safeRecord.readiness?.toolReadiness?.missingCount, 1, 'full plan evidence is kept even when TRY readiness is scoped');
  const broken = queueWorkflowRun('try-readiness-flow', {}, { targetStepId: 'broken', dedupe: false });
  assert.equal(broken.status, 'blocked_readiness');
  assert.match(broken.message, /missing\.py/);
  assert.equal(runFiles().length, 1);
});

test('queueWorkflowDryRun: writes fresh dry_run records with console metadata', () => {
  const first = queueWorkflowDryRun('audit-brief', { url: 'https://x.com' }, { source: 'console' });
  const second = queueWorkflowDryRun('audit-brief', { url: 'https://x.com' }, { source: 'console' });
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  assert.equal(runFiles().length, 2);

  const records = runFiles().map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>);
  assert.ok(records.every((record) => record.status === 'dry_run'));
  assert.ok(records.every((record) => record.source === 'console'));
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
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as {
      workflow: string;
      inputs: Record<string, string>;
      status: string;
      createdAt?: string;
      requeuedFromRunId?: string;
      recoveryIntent?: { kind?: string; createdAt?: string; sourceRunId?: string; reason?: string };
    });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].workflow, 'audit-brief');
  assert.equal(queued[0].inputs.url, 'https://revill.co.uk');
  assert.equal(queued[0].status, 'queued');
  assert.equal(queued[0].requeuedFromRunId, origId);
  assert.deepEqual(queued[0].recoveryIntent, {
    kind: 'manual_requeue',
    createdAt: queued[0].createdAt,
    sourceRunId: origId,
    reason: 'whole-run requeue',
  });
});

test('requeueWorkflowFromRun: missing original run → not_found (best-effort, no throw)', () => {
  assert.equal(requeueWorkflowFromRun('does-not-exist').status, 'not_found');
});

test('requeueWorkflowFromRun carries originSessionId from the prior run (re-run re-enters the chat)', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-with-origin';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://x.co' }, status: 'completed', originSessionId: 'sess-abc' }),
    'utf-8',
  );
  requeueWorkflowFromRun(origId);
  const fresh = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as { originSessionId?: string });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].originSessionId, 'sess-abc');
});

test('requeueWorkflowFromRun preserves duplicate observer origins from the prior run', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-with-multi-origin';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://x.co' }, status: 'completed', originSessionId: 'sess-a', originSessionIds: ['sess-a', 'sess-b'] }),
    'utf-8',
  );

  requeueWorkflowFromRun(origId);
  const fresh = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as { originSessionId?: string; originSessionIds?: string[] });

  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].originSessionId, 'sess-a');
  assert.deepEqual(fresh[0].originSessionIds, ['sess-a', 'sess-b']);
});

test('requeueWorkflowFailedItemsFromRun queues lineage for only final failed forEach items', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-partial-failure';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://x.co' }, status: 'completed_with_errors', originSessionId: 'sess-failed-items' }),
    'utf-8',
  );
  appendWorkflowEvent('audit-brief', origId, { kind: 'step_completed', stepId: 'normalize', output: ['a', 'b', 'c'] });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_completed', stepId: 'blast', itemKey: 'a', output: 'done-a' });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast', itemKey: 'b', error: 'temporary b failure' });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast', itemKey: 'c', error: 'temporary c failure' });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_completed', stepId: 'blast', itemKey: 'c', output: 'recovered-c' });

  const rq = requeueWorkflowFailedItemsFromRun(origId);
  assert.equal(rq.status, 'queued');
  assert.deepEqual(rq.failedItems?.map((item) => item.itemKey), ['b']);
  const fresh = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as {
      createdAt?: string;
      retryFailedItemsFromRunId?: string;
      retryFailedItemsStepId?: string;
      retryFailedItemKeys?: string[];
      originSessionId?: string;
      recoveryIntent?: { kind?: string; createdAt?: string; sourceRunId?: string; sourceStepId?: string; reason?: string };
    });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].retryFailedItemsFromRunId, origId);
  assert.equal(fresh[0].retryFailedItemsStepId, 'blast');
  assert.deepEqual(fresh[0].retryFailedItemKeys, ['b']);
  assert.equal(fresh[0].originSessionId, 'sess-failed-items');
  assert.deepEqual(fresh[0].recoveryIntent, {
    kind: 'failed_items',
    createdAt: fresh[0].createdAt,
    sourceRunId: origId,
    sourceStepId: 'blast',
    reason: 'retry final failed forEach items',
  });
});

test('requeueWorkflowFailedItemsFromRun asks for a step when multiple fan-outs failed', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-multi-failure';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://x.co' }, status: 'completed_with_errors' }),
    'utf-8',
  );
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast_one', itemKey: 'a', error: 'a failed' });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast_two', itemKey: 'b', error: 'b failed' });

  const ambiguous = requeueWorkflowFailedItemsFromRun(origId);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.match(ambiguous.message, /more than one step/);

  const scoped = requeueWorkflowFailedItemsFromRun(origId, { stepId: 'blast_two' });
  assert.equal(scoped.status, 'queued');
  assert.deepEqual(scoped.failedItems?.map((item) => item.itemKey), ['b']);
});

test('self-heal lineage: requeue bumps + persists selfHealAttempt (bound counter survives run→run)', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-heal';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://x.co' }, status: 'completed' }),
    'utf-8',
  );
  requeueWorkflowFromRun(origId, { selfHealAttempt: 1 });
  const fresh = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as {
      createdAt?: string;
      requeuedFromRunId?: string;
      selfHealAttempt?: number;
      recoveryIntent?: { kind?: string; createdAt?: string; sourceRunId?: string; reason?: string };
    });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].requeuedFromRunId, origId);
  assert.equal(fresh[0].selfHealAttempt, 1);
  assert.deepEqual(fresh[0].recoveryIntent, {
    kind: 'self_heal',
    createdAt: fresh[0].createdAt,
    sourceRunId: origId,
    reason: 'self-heal verification requeue',
  });
});

test('queueWorkflowRun omits selfHealAttempt when 0/absent', () => {
  writeAuditWorkflow();
  queueWorkflowRun('audit-brief', { url: 'https://x.co' });
  const rec = runFiles().map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as Record<string, unknown>)[0];
  assert.equal('selfHealAttempt' in rec, false);
});

test('queueWorkflowCreationTest: writes a creation_test run record (Part B authoring test)', () => {
  const r = queueWorkflowCreationTest('audit-brief', { url: 'https://x.com' }, { originSessionId: 'sess-create' });
  assert.equal(r.status, 'queued');
  assert.match(r.message, /creation test/i);
  assert.match(r.message, /DISABLED/);
  assert.equal(runFiles().length, 1);
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.status, 'creation_test');
  assert.equal(rec.workflow, 'audit-brief');
  assert.equal(rec.inputs.url, 'https://x.com');
  assert.equal(rec.originSessionId, 'sess-create');
});

test('queueWorkflowCreationTest: does NOT dedupe (each authoring test is fresh)', () => {
  queueWorkflowCreationTest('audit-brief', { url: 'https://x.com' });
  queueWorkflowCreationTest('audit-brief', { url: 'https://x.com' });
  assert.equal(runFiles().length, 2);
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

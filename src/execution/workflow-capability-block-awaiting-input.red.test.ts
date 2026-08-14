/**
 * RED — a workflow capability block is an awaiting-INPUT state, not an approval.
 *
 * Run: npx tsx --test src/execution/workflow-capability-block-awaiting-input.red.test.ts
 *
 * Invariant under pin: when a run pauses because a toolkit is not usable
 * (unconnected/ambiguous account — a USER dependency, not an approval
 * decision), the durable run state must expose a typed awaiting-input record
 * preserving the exact blocked operation {stepId, tool, toolkit, reason} and
 * the safe next user action. Today the run FILE keeps that typed truth
 * (capabilityBlock — pinned as the fixture proof below), but the shared
 * RunRecord lane flattens it to finishRun status 'awaiting_approval' with only
 * message/outputPreview: the operation identity survives only in notification
 * metadata, and every run-record consumer sees a phantom approval.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-wf-capability-input-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-wf-capability-input\n', 'utf8');

const {
  processWorkflowRuns,
  _setWorkflowHarnessLoopImplsForTests,
  _setWorkflowCallNodeForTests,
  _setWorkflowWatcherForTests,
  WorkflowCapabilityBlockedError,
} = await import('./workflow-runner.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { getRun } = await import('../runtime/run-events.js');
const eventlog = await import('../runtime/harness/eventlog.js');

_setWorkflowWatcherForTests(async () => ({ onTrack: true, miss: '', steer: '' }));

test.after(() => {
  _setWorkflowHarnessLoopImplsForTests();
  _setWorkflowCallNodeForTests();
  _setWorkflowWatcherForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const WORKFLOW_NAME = 'Capability Blocked Digest';
const RUN_ID = 'capability-blocked-digest-run';

async function driveCapabilityBlockedRun(): Promise<Record<string, unknown>> {
  writeWorkflow('capability-blocked-digest', {
    name: WORKFLOW_NAME,
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'pull_digest',
      prompt: 'Pull the digest rows from the alpha tracker.',
      sideEffect: 'read',
      call: { tool: 'ALPHA_LIST_RECORDS', args: { view: 'digest' } },
    }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${RUN_ID}.json`);
  if (!getRun(RUN_ID)) {
    writeFileSync(runFile, JSON.stringify({
      id: RUN_ID,
      workflow: WORKFLOW_NAME,
      status: 'queued',
      inputs: {},
      createdAt: new Date().toISOString(),
    }), 'utf-8');
    _setWorkflowCallNodeForTests(async (step) => {
      throw new WorkflowCapabilityBlockedError({
        stepId: step.id,
        tool: 'ALPHA_LIST_RECORDS',
        toolkit: 'alpha',
        reason: 'not-connected',
        message: 'Reconnect the alpha toolkit, then resume this run.',
      });
    });
    _setWorkflowHarnessLoopImplsForTests({
      configureRuntime: (async () => ({ ok: true })) as never,
      runConversation: (async () => {
        throw new Error('the zero-LLM call node must not reach the model loop');
      }) as never,
    });
    try {
      await processWorkflowRuns({
        respond: async () => { throw new Error('legacy respond path must not run'); },
      } as never);
    } finally {
      _setWorkflowHarnessLoopImplsForTests();
      _setWorkflowCallNodeForTests();
    }
  }
  return JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, unknown>;
}

test('GUARD — the run FILE keeps the typed capability-block truth', async () => {
  const record = await driveCapabilityBlockedRun();
  assert.equal(record.status, 'blocked_capability', 'the run-file lane types the pause');
  const block = record.capabilityBlock as Record<string, unknown> | undefined;
  assert.ok(block, 'the run file preserves the typed block record');
  assert.equal(block?.stepId, 'pull_digest');
  assert.equal(block?.tool, 'ALPHA_LIST_RECORDS');
  assert.equal(block?.toolkit, 'alpha');
  assert.equal(block?.reason, 'not-connected');
  assert.equal(typeof block?.retryAt, 'string', 'the safe automatic retry time is typed');
  assert.equal(block?.provenNoDispatch, true, 'no dispatch crossed, so the resume is safe');
});

test('the durable run state is a typed awaiting_input record, not awaiting_approval', async () => {
  await driveCapabilityBlockedRun();
  const runRecord = getRun(RUN_ID);
  assert.ok(runRecord, 'fixture precondition: the workflow run has a RunRecord');

  // TARGET — a capability block is a user DEPENDENCY (connect the toolkit),
  // not an approval decision. The shared run state must say awaiting_input.
  assert.equal(
    String(runRecord.status),
    'awaiting_input',
    'a capability block (unconnected toolkit) is stored as awaiting_approval on the '
    + 'RunRecord — there is no approval to grant, and board consumers cannot tell a '
    + 'question/dependency pause from a real approval gate',
  );
});

/** Any object anywhere on the durable record that carries the blocked
 * operation as TYPED FIELDS (prose mentions in message/outputPreview do not
 * count — they cannot be consumed programmatically). */
function findTypedBlockedOperation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(findTypedBlockedOperation);
  const obj = value as Record<string, unknown>;
  if (
    obj.stepId === 'pull_digest'
    && obj.tool === 'ALPHA_LIST_RECORDS'
    && obj.toolkit === 'alpha'
    && obj.reason === 'not-connected'
  ) return true;
  return Object.values(obj).some(findTypedBlockedOperation);
}

test('the durable run state preserves the blocked operation identity as typed fields', async () => {
  await driveCapabilityBlockedRun();
  const runRecord = getRun(RUN_ID);
  assert.ok(runRecord, 'fixture precondition: the workflow run has a RunRecord');

  // TARGET — the blocked operation {stepId, tool, toolkit, reason} must ride
  // the durable run state itself as typed fields, not only notification
  // metadata or prose. Today finishRun keeps just message/outputPreview.
  assert.ok(
    findTypedBlockedOperation(runRecord),
    'the RunRecord carries no typed record of the blocked operation '
    + '{stepId: pull_digest, tool: ALPHA_LIST_RECORDS, toolkit: alpha, reason: not-connected} — '
    + 'it survives only in the run file + notification metadata, so run-record consumers '
    + 'cannot name what is blocked or what the user must do next',
  );
});

/**
 * Run: npx tsx --test src/runtime/harness/host-tool-invocation.plan-task-fail-return.red.test.ts
 *
 * Fail-RETURN over fail-closed for repairable in-turn plan_task conditions.
 *
 * Measured live (gauntlet 2026-08-26): 12 lvl50 "Host tool invocation
 * authority failed closed" lines map 1:1 to the day's 12 dead conversations,
 * terminated reason=blocked and non-resumable. The proximate killer at
 * 12:06:19Z (sess-desktop-5bcd…) was the exact_args_repeat guardrail's own
 * block STRING settling as the plan_task result and then failing
 * enforceSettledPlanTaskResult's typed check: the loop-saver escalated a
 * stuck loop into a dead conversation. Errors that name their own condition
 * got no retry (self-healing law violated).
 *
 * The law: once settlement itself records the typed failure, the payload is
 * ordinary model input for a bounded in-turn repair. Fail-closed remains only
 * for the true invariant breach — a payload that SETTLED SUCCESS yet is not
 * the exact typed plan_task union.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-task-fail-return-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-plan-fail-return\n', 'utf8');

const eventlog = await import('./eventlog.js');
const leases = await import('./dispatch-lease.js');
const identities = await import('./attempt-identity.js');
const brackets = await import('./brackets.js');
const invocation = await import('./host-tool-invocation.js');
const callAuthority = await import('./accepted-turn-call-authority.js');
const logicalContracts = await import('./logical-call-contract.js');
const hostBindings = await import('./host-call-capability-binding.js');
const settlements = await import('./logical-call-settlement-store.js');
const guardrail = await import('./tool-guardrail.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function fixture(text = 'Create the gauntlet sheet and add one row.') {
  const session = eventlog.createSession({ id: `plan-fail-return-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const armed = callAuthority.armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest: digest(`host-surface-catalog:${session.id}`),
    bindingRevisionDigest: digest(`host-surface-binding:${session.id}`),
    maxLogicalCalls: 20,
    maxParallelCalls: 20,
  });
  assert.equal(armed.status, 'armed');
  const parentLease = leases.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::host-parent`,
  });
  const context: brackets.HarnessRunContext = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(20),
    dispatchLease: parentLease,
  };
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    parentLease,
    context,
  };
}

function runPlanTask<T>(
  task: ReturnType<typeof fixture>,
  options: {
    callId: string;
    invoke: invocation.InvokeHostToolCallInput<T>['invoke'];
  },
) {
  const toolName = 'plan_task';
  const args = { preamble: 'I’ll prepare this now.', draft: { criteria: ['one row lands'] } };
  const root = callAuthority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = logicalContracts.durableLogicalCallContract(task.acceptedTaskId, toolName, args);
  assert.ok(contract);
  if (!contract) throw new Error('fixture call contract is unsafe');
  const attestationBase = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: options.callId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: 'host_only' as const,
    bindingKind: 'local_envelope' as const,
    capabilityId: `cap:${contract.toolName}`,
    schemaFingerprint: digest(`manifest-schema:${contract.toolName}`),
    accountId: '',
    invokePortId: 'fixture:invoke',
    operationId: contract.toolName,
    manifestId: '',
    manifestDigest: '',
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: digest(`host-surface-catalog:${task.sessionId}`),
    bindingRevisionDigest: digest(`host-surface-binding:${task.sessionId}`),
  };
  const attestation = {
    ...attestationBase,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(attestationBase),
  };
  return callAuthority.withHostCallAttestation(attestation, () =>
    brackets.withHarnessRunContext(task.context, () => invocation.invokeHostToolCall({
      identity: {
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        modelCallId: options.callId,
        toolName,
        args,
        turn: 1,
      },
      parentLease: task.parentLease,
      effect: 'host_only',
      businessCall: false,
      boundary: 'host_owned_local',
      deadlineMs: 200,
      invoke: options.invoke,
    }))) as Promise<invocation.HostToolInvocationResult<T>>;
}

const GUARDRAIL_BLOCK =
  'Tool call refused by harness: tool-call guardrail block: Loop detected: plan_task has been '
  + 'called 5× with IDENTICAL arguments and keeps failing/returning the same result.';

const LAUNDERED_VALIDATION =
  'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool';

test('the exact_args_repeat block string returns to the model; the conversation survives', async () => {
  const task = fixture();
  let bodies = 0;
  const settled = await runPlanTask<string>(task, {
    callId: 'model:plan-guardrail-block',
    invoke: async () => {
      bodies += 1;
      return GUARDRAIL_BLOCK;
    },
  });
  assert.equal(bodies, 1);
  assert.equal(settled.value, GUARDRAIL_BLOCK,
    'the loop-saver’s corrective text is the model’s repair input, not a conversation terminator');
  assert.notEqual(settled.settlement.outcome.kind, 'succeeded');
  leases.revokeDispatchLease(task.parentLease);
});

test('the SDK-laundered validation string returns to the model as a typed failure', async () => {
  const task = fixture();
  let bodies = 0;
  const settled = await runPlanTask<string>(task, {
    callId: 'model:plan-laundered-validation',
    invoke: async () => {
      bodies += 1;
      return LAUNDERED_VALIDATION;
    },
  });
  assert.equal(bodies, 1);
  assert.equal(settled.value, LAUNDERED_VALIDATION);
  assert.equal(settled.settlement.outcome.kind, 'invalid_arguments');
  leases.revokeDispatchLease(task.parentLease);
});

test('a settled typed refusal replays as a typed refusal without re-execution', async () => {
  const task = fixture();
  const refusal = JSON.stringify({
    ok: false,
    code: 'plan_not_admitted',
    detail: 'primary model proposal cites a capability that was not disclosed to this source',
    repair: 'Correct the semantic proposal against the exact host planning catalog, then call plan_task again.',
  });
  let bodies = 0;
  const execute = () => runPlanTask<string>(task, {
    callId: 'model:plan-typed-refusal-replay',
    invoke: async () => {
      bodies += 1;
      return refusal;
    },
  });
  const first = await execute();
  assert.equal(first.value, refusal);
  assert.notEqual(first.settlement.outcome.kind, 'succeeded',
    'the typed refusal settles as its typed failure');
  assert.equal(bodies, 1);

  const replay = await execute();
  assert.equal(bodies, 1, 'a settled control refusal never re-enters the tool body');
  assert.equal(replay.settlement.duplicate, true);
  const replayed = JSON.parse(String(replay.value)) as { ok?: unknown; code?: unknown };
  assert.equal(replayed.ok, false, 'the replay hands back a typed refusal, not a dead conversation');
  assert.equal(typeof replayed.code, 'string');
  leases.revokeDispatchLease(task.parentLease);
});

test('a payload that settled SUCCESS but is not the typed union still fails closed', async () => {
  const task = fixture();
  await assert.rejects(
    runPlanTask<string>(task, {
      callId: 'model:plan-prose-success',
      invoke: async () => 'All done — the plan is ready and everything worked.',
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError
      && /not an exact typed success or refusal/.test(error.message),
    'success-shaped prose masquerading as a plan_task result remains the invariant breach',
  );
  leases.revokeDispatchLease(task.parentLease);
});

test('post-result semantic loop control preserves the exact host-only refusal settlement', async () => {
  // Live 2026-08-29: GLM repaired the proposal wording four times while the
  // host returned this same local plan_not_admitted consequence. On the third
  // result, semantic loop control threw *after* the exact bytes were observed.
  // The host paired effect_unknown, checkpointed reconciliation_required, and
  // publicly asked the user to continue despite zero external crossings.
  guardrail._resetAllTrackersForTests();
  const task = fixture('Schedule the requested meeting using the connected Outlook account.');
  const refusal = JSON.stringify({
    ok: false,
    code: 'plan_not_admitted',
    detail: 'write_not_aligned:work.requestedEffect',
    repair: 'Correct the requested effect against the exact planning catalog.',
  });
  let bodies = 0;
  const configured = {
    name: 'plan_task',
    invoke: async () => {
      bodies += 1;
      return refusal;
    },
  } as unknown as brackets.WrappableTool & {
    invoke: (runContext: unknown, input: unknown, details?: unknown) => Promise<unknown>;
  };
  const wrapped = brackets.wrapToolForHarness(configured);
  const args = { preamble: 'I’ll prepare this now.', draft: { criteria: ['one row lands'] } };

  for (let index = 1; index <= 3; index += 1) {
    const callId = `model:plan-semantic-refusal-${index}`;
    const returned = await runPlanTask<string>(task, {
      callId,
      invoke: ({ signal }) => wrapped.invoke(
        null,
        JSON.stringify(args),
        { signal, toolCall: { callId } },
      ) as Promise<string>,
    });
    assert.equal(returned.value, refusal,
      'post-result control returns the same exact bytes to the host/model loop');
    const durable = settlements.redeemDurableLogicalCallSettlementForHost({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: callId,
    });
    assert.equal(durable.status, 'ok');
    if (durable.status !== 'ok') throw new Error(durable.reason);
    assert.equal(durable.settlement.executionKind, 'local_execution');
    assert.equal(durable.settlement.physicalCrossingCount, 0,
      'no result-preservation path invents traffic leaving the machine');
    assert.equal(durable.settlement.hostCrossingCount, 1,
      'the exact host-local execution remains recorded');
    assert.equal(durable.settlement.outcome.directive.requiresReconciliation, false,
      'the local typed refusal cannot become reconciliation_required');
  }

  assert.equal(bodies, 3, 'each distinct model call executes once; no hidden retry is introduced');
  leases.revokeDispatchLease(task.parentLease);
});

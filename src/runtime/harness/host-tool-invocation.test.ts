import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-tool-invocation-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-host-invocation\n', 'utf8');

const eventlog = await import('./eventlog.js');
const leases = await import('./dispatch-lease.js');
const dispatch = await import('./dispatch-ledger.js');
const identities = await import('./attempt-identity.js');
const attemptSettlements = await import('./attempt-settlement.js');
const brackets = await import('./brackets.js');
const invocation = await import('./host-tool-invocation.js');
const settlements = await import('./logical-call-settlement-store.js');
const discoveryBoundary = await import('./discovery-boundary.js');
const discoveryGovernorModule = await import('./discovery-governor.js');
const abortContext = await import('../tool-abort-context.js');
const reaper = await import('./reaper.js');
const callAuthority = await import('./accepted-turn-call-authority.js');
const logicalContracts = await import('./logical-call-contract.js');
const hostBindings = await import('./host-call-capability-binding.js');
const terminalDispatchOwners = await import('./terminal-physical-dispatch-owner.js');
const { removeV65StructuresFromHistoricalMigrationFixture } = await import('./historical-migration-fixture.testsupport.js');
const { tool: sdkTool } = await import('@openai/agents');
const { z } = await import('zod');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function fixture(text = 'Find the current alpha records.') {
  const session = eventlog.createSession({ id: `host-invoke-${++serial}`, kind: 'chat' });
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

function productionFixture(text = 'Find the current alpha records.') {
  const session = eventlog.createSession({ id: `host-invoke-production-${++serial}`, kind: 'chat' });
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
    catalogRevisionDigest: digest(`catalog:${session.id}`),
    bindingRevisionDigest: digest(`binding:${session.id}`),
    maxLogicalCalls: 8,
    maxParallelCalls: 4,
  });
  assert.equal(armed.status, 'armed');
  const parentLease = leases.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::host-parent`,
  });
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    parentLease,
    context: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      counter: new brackets.ToolCallsCounter(20),
      dispatchLease: parentLease,
    } satisfies brackets.HarnessRunContext,
  };
}

function productionCatalogAttestation(
  task: ReturnType<typeof productionFixture>,
  callId: string,
  toolName: string,
  args: unknown,
  overrides: Partial<callAuthority.HostCallAttestation> = {},
): callAuthority.HostCallAttestation {
  const root = callAuthority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = logicalContracts.durableLogicalCallContract(task.acceptedTaskId, toolName, args);
  assert.ok(contract);
  const base = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: callId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: 'read' as const,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: `cap:${contract.toolName}`,
    schemaFingerprint: digest(`manifest-schema:${contract.toolName}`),
    accountId: 'conn-provider',
    invokePortId: 'composio:execute',
    operationId: contract.toolName.toUpperCase(),
    manifestId: `cap:resolved:${contract.toolName}`,
    manifestDigest: digest(`manifest:${contract.toolName}`),
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest!,
    ...overrides,
  };
  const bindingDigest = hostBindings.hostCallAttestationBindingDigest(base);
  return { ...base, bindingDigest };
}

function runProductionCall<T>(
  task: ReturnType<typeof productionFixture>,
  options: {
    callId: string;
    toolName?: string;
    args?: unknown;
    attestationOverrides?: Partial<callAuthority.HostCallAttestation>;
    invoke: invocation.InvokeHostToolCallInput<T>['invoke'];
  },
) {
  const toolName = options.toolName ?? 'read_file';
  const args = options.args ?? { path: '/tmp/alpha-records.json' };
  const attestation = productionCatalogAttestation(
    task,
    options.callId,
    toolName,
    args,
    options.attestationOverrides,
  );
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
      effect: 'read',
      boundary: 'host_owned_external',
      deadlineMs: 200,
      invoke: options.invoke,
    }))) as Promise<invocation.HostToolInvocationResult<T>>;
}

function runCall<T>(
  task: ReturnType<typeof fixture>,
  options: {
    callId: string;
    toolName?: string;
    args?: unknown;
    effect?: 'read' | 'host_only' | 'external_write';
    businessCall?: boolean;
    boundary?: invocation.HostToolInvocationBoundary;
    deadlineMs?: number;
    callerSignal?: AbortSignal;
    isKillRequested?: () => boolean;
    beforePhysicalAdmission?: invocation.InvokeHostToolCallInput<T>['beforePhysicalAdmission'];
    invoke: invocation.InvokeHostToolCallInput<T>['invoke'];
  },
) {
  const effect = options.effect ?? 'read';
  const toolName = options.toolName ?? (effect === 'external_write' ? 'space_publish' : 'read_file');
  const args = options.args ?? { query: 'alpha' };
  const root = callAuthority.acceptedTurnCallAuthorityFor(task.sessionId, task.sourceUserSeq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = logicalContracts.durableLogicalCallContract(task.acceptedTaskId, toolName, args);
  assert.ok(contract);
  if (!contract) throw new Error('fixture call contract is unsafe');
  const localEnvelope = effect === 'host_only';
  const attestationBase = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: options.callId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect,
    bindingKind: localEnvelope ? 'local_envelope' as const : 'catalog_manifest' as const,
    capabilityId: `cap:${contract.toolName}`,
    schemaFingerprint: digest(`manifest-schema:${contract.toolName}`),
    accountId: localEnvelope ? '' : 'conn-provider',
    invokePortId: 'fixture:invoke',
    operationId: contract.toolName,
    manifestId: localEnvelope ? '' : `cap:${contract.toolName}`,
    manifestDigest: localEnvelope ? '' : digest(`manifest:${contract.toolName}`),
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
    effect,
    businessCall: options.businessCall,
    boundary: options.boundary ?? 'host_owned_local',
    deadlineMs: options.deadlineMs ?? 40,
    callerSignal: options.callerSignal,
    isKillRequested: options.isKillRequested,
    killPollMs: 5,
    beforePhysicalAdmission: options.beforePhysicalAdmission,
    invoke: options.invoke,
  }))) as Promise<invocation.HostToolInvocationResult<T>>;
}

function rows(task: ReturnType<typeof fixture>, callId?: string) {
  const db = eventlog.openEventLog();
  return db.prepare(`
    SELECT logical_tool_call_id, physical_dispatch_id, state, execution_site,
           lease_scope_id, lease_id
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
       AND (? IS NULL OR logical_tool_call_id = ?)
     ORDER BY logical_tool_call_id, ordinal
  `).all(task.sessionId, task.sourceUserSeq, callId ?? null, callId ?? null) as Array<{
    logical_tool_call_id: string;
    physical_dispatch_id: string;
    state: string;
    execution_site: string | null;
    lease_scope_id: string | null;
    lease_id: string | null;
  }>;
}

function exactCallLease(
  task: ReturnType<typeof fixture>,
  callId: string,
): ReturnType<typeof leases.activateDispatchLease> {
  const [crossing] = rows(task, callId);
  assert.ok(crossing?.lease_scope_id && crossing.lease_id);
  return {
    sessionId: task.sessionId,
    scopeId: crossing.lease_scope_id,
    leaseId: crossing.lease_id,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: callId,
  };
}

test('exact typed plan_task recoveries settle normally and replay without activation or redispatch', async (t) => {
  const cases = [
    {
      label: 'plan not admitted',
      callId: 'model:plan-refusal-not-admitted',
      value: JSON.stringify({
        ok: false,
        code: 'plan_not_admitted',
        detail: 'The proposed capability was not disclosed for this accepted source.',
        repair: 'Search the exact role, then submit a corrected plan.',
      }),
    },
    {
      label: 'plan not required',
      callId: 'model:plan-refusal-not-required',
      value: JSON.stringify({
        ok: false,
        code: 'plan_not_required',
        detail: 'This accepted source does not require an action graph.',
      }),
    },
    {
      label: 'unique named workflow',
      callId: 'model:plan-refusal-unique-workflow',
      value: JSON.stringify({
        ok: false,
        code: 'plan_not_required',
        detail: 'this accepted request uniquely names an existing workflow; call workflow_run with that exact name',
        workflowName: 'platform-49-slack-channel-review',
        repair: 'Call workflow_run with name "platform-49-slack-channel-review". Do not plan_task. Do not workflow_get unless the user asked to inspect the definition.',
      }),
    },
    {
      label: 'account selection required',
      callId: 'model:plan-account-selection',
      expectedOutcome: 'input_required',
      value: JSON.stringify({
        ok: false,
        code: 'account_selection_required',
        detail: 'Outlook Send Email is the matching write for this ask; ask which connected account to use.',
        question: 'Which connected account should I use?',
        accountChoices: ['work@corp.example', 'personal@example.net'],
        repair: 'Ask the user which exact connected account to use. Do not pick a substitute write.',
      }),
    },
    {
      label: 'missing required write',
      callId: 'model:plan-incomplete-missing-write',
      value: JSON.stringify({
        ok: false,
        code: 'plan_incomplete_missing_write',
        detail: 'The accepted request requires a write, but this draft contains no exactly bound host-attested write operation.',
        requestedEffectScope: 'mixed',
        repair: 'Use tool_search for the exact missing write capability, then call plan_task again.',
      }),
    },
    {
      label: 'missing artifact data lineage',
      callId: 'model:plan-incomplete-data-lineage',
      value: JSON.stringify({
        ok: false,
        code: 'plan_incomplete_data_lineage',
        detail: 'The artifact write names only ordering dependencies and has no exact dataFrom source.',
        writeOperationIds: ['write_sheet'],
        sourceOperationIds: ['read_accounts'],
        repair: 'Keep dependsOn for ordering and set dataFrom to the exact operation whose bytes construct the artifact.',
      }),
    },
  ] as const;

  for (const candidate of cases) {
    await t.test(candidate.label, async () => {
      const task = fixture('Prepare the current request.');
      let bodies = 0;
      const execute = () => runCall(task, {
        callId: candidate.callId,
        toolName: 'plan_task',
        effect: 'host_only',
        businessCall: false,
        args: { draft: { version: 1 }, preamble: 'I’ll prepare this now.' },
        deadlineMs: 200,
        invoke: async () => {
          bodies += 1;
          return candidate.value;
        },
      });

      const first = await execute();
      assert.equal(first.value, candidate.value);
      // Settlement carries semantic truth: a payload that says ok:false is a
      // typed failure, never 'succeeded'. (Before 2026-08-26 these settled
      // succeeded with success=1 handles — every evidence consumer overcounted.)
      assert.notEqual(first.settlement.outcome.kind, 'succeeded');
      if ('expectedOutcome' in candidate) {
        assert.equal(first.settlement.outcome.kind, candidate.expectedOutcome);
      }
      assert.equal(first.settlement.duplicate, false);
      assert.equal(bodies, 1);

      const durable = eventlog.openEventLog().prepare(`
        SELECT outcome_kind, recovery_action, physical_crossing_count, host_crossing_count
          FROM logical_call_settlements
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(task.sessionId, task.sourceUserSeq, candidate.callId) as {
        outcome_kind: string;
        recovery_action: string;
        physical_crossing_count: number;
        host_crossing_count: number;
      };
      assert.equal(durable.physical_crossing_count, 0);
      assert.equal(durable.host_crossing_count, 1);
      if ('expectedOutcome' in candidate) {
        assert.deepEqual({
          outcome_kind: durable.outcome_kind,
          recovery_action: durable.recovery_action,
        }, {
          outcome_kind: 'input_required',
          recovery_action: 'ask_user',
        });
      }

      const replay = await execute();
      assert.equal(replay.settlement.duplicate, true);
      assert.equal(bodies, 1, 'the typed refusal replay never re-enters the tool body');
      const replayed = JSON.parse(String(replay.value)) as { ok?: unknown; code?: unknown };
      assert.equal(replayed.ok, false, 'the replay hands back a typed refusal');
      assert.equal(typeof replayed.code, 'string');
      assert.equal(rows(task, candidate.callId).length, 1);
      leases.revokeDispatchLease(task.parentLease);
    });
  }
});

test('a malformed ok:false record settles as a typed failure and fail-RETURNS to the model', async () => {
  // Missing refusal fields keep it outside the closed union, but the payload
  // still SAYS ok:false, so settlement records the failure and the bytes go
  // back to the model for a bounded repair — fail-closed here escalated a
  // repair outcome into a dead conversation (live 2026-08-26, 12 terminals).
  const task = fixture('Prepare the current request.');
  let bodies = 0;
  const value = JSON.stringify({ ok: false, code: 'plan_not_admitted' });
  const settled = await runCall<string>(task, {
    callId: 'model:plan-malformed-refusal',
    toolName: 'plan_task',
    effect: 'host_only',
    businessCall: false,
    args: { draft: { version: 1 }, preamble: 'I’ll prepare this now.' },
    deadlineMs: 200,
    invoke: async () => {
      bodies += 1;
      return value;
    },
  });
  assert.equal(bodies, 1);
  assert.equal(settled.value, value);
  assert.notEqual(settled.settlement.outcome.kind, 'succeeded');
  assert.equal(rows(task, 'model:plan-malformed-refusal').length, 1);
  leases.revokeDispatchLease(task.parentLease);
});

test('a success-settled non-boolean discriminator still fails closed on first return and replay', async () => {
  // ok:'false' (a string) carries no structured verdict, so it settles as a
  // returned host execution — success-shaped. A payload that settled SUCCESS
  // yet is not the exact typed union remains the invariant breach.
  const task = fixture('Prepare the current request.');
  let bodies = 0;
  const execute = () => runCall(task, {
    callId: 'model:plan-non-boolean',
    toolName: 'plan_task',
    effect: 'host_only',
    businessCall: false,
    args: { draft: { version: 1 }, preamble: 'I’ll prepare this now.' },
    deadlineMs: 200,
    invoke: async () => {
      bodies += 1;
      return JSON.stringify({
        ok: 'false',
        code: 'plan_not_required',
        detail: 'This must not be accepted as a typed refusal.',
      });
    },
  });

  await assert.rejects(
    execute(),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError
      && /not an exact typed success or refusal/.test(error.message),
  );
  assert.equal(bodies, 1);
  assert.equal(rows(task, 'model:plan-non-boolean').length, 1);

  await assert.rejects(
    execute(),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError
      && /not an exact typed success or refusal/.test(error.message),
  );
  assert.equal(bodies, 1, 'replay cannot bypass the closed result discriminator');
  leases.revokeDispatchLease(task.parentLease);
});

test('an exact successful plan_task result still requires durable post-settlement activation', async () => {
  const task = fixture('Prepare and execute the current request.');
  const value = JSON.stringify({
    ok: true,
    acceptedTaskId: task.acceptedTaskId,
    graphId: `turn-graph:v1:${task.sourceUserSeq}`,
    graphHash: 'a'.repeat(64),
    contractId: `expected-work:v1:${'b'.repeat(64)}`,
    requirements: [{
      id: 'collect-source',
      effect: 'read',
      coverage: 'complete_set',
      dependsOn: [],
      cardinality: { kind: 'once' },
    }],
    next: 'Invoke the exact admitted work requirement.',
  });
  let bodies = 0;
  const execute = () => runCall(task, {
    callId: 'model:plan-success-without-activation',
    toolName: 'plan_task',
    effect: 'host_only',
    businessCall: false,
    args: { draft: { version: 1 }, preamble: 'I’ll prepare this now.' },
    deadlineMs: 200,
    invoke: async () => {
      bodies += 1;
      return value;
    },
  });

  await assert.rejects(
    execute(),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError
      && /lacks exact durable delivery\/activation authority/.test(error.message),
  );
  assert.equal(bodies, 1);
  await assert.rejects(
    execute(),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError
      && /lacks exact durable delivery\/activation authority/.test(error.message),
  );
  assert.equal(bodies, 1, 'the successful settled replay is rechecked without redispatch');
  leases.revokeDispatchLease(task.parentLease);
});

test('an already-aborted caller opens zero logical and zero physical authority', async () => {
  const task = fixture();
  const controller = new AbortController();
  controller.abort(new Error('cancel before admission'));
  let ran = false;
  await assert.rejects(
    runCall(task, {
      callId: 'model:pre-abort',
      callerSignal: controller.signal,
      invoke: async () => { ran = true; return 'impossible'; },
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationCancelledError,
  );
  assert.equal(ran, false);
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM logical_tool_calls WHERE session_id = ?`)
    .get(task.sessionId) as { n: number }).n, 0);
  assert.equal(rows(task).length, 0);
  leases.revokeDispatchLease(task.parentLease);
});

test('beforePhysicalAdmission runs in the current child lease after logical admission and before reservation/body', async () => {
  const task = fixture();
  const order: string[] = [];
  const completed = await runCall(task, {
    callId: 'model:before-physical-success',
    deadlineMs: 200,
    beforePhysicalAdmission: (context) => {
      order.push('policy');
      assert.equal(context.sessionId, task.sessionId);
      assert.equal(context.sourceUserSeq, task.sourceUserSeq);
      assert.equal(context.acceptedTaskId, task.acceptedTaskId);
      assert.equal(context.logicalToolCallId, 'model:before-physical-success');
      assert.equal(context.tool, 'read_file');
      assert.deepEqual(context.args, { query: 'alpha' });
      assert.equal(leases.currentDispatchLease(), context.lease);
      assert.equal(leases.isDispatchLeaseCurrent(context.lease), true);
      assert.equal(rows(task, 'model:before-physical-success').length, 0);
      const logical = eventlog.openEventLog().prepare(`
        SELECT state FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(
        task.sessionId,
        task.sourceUserSeq,
        'model:before-physical-success',
      ) as { state: string };
      assert.equal(logical.state, 'open');
    },
    invoke: async ({ lease }) => {
      order.push('body');
      assert.equal(leases.currentDispatchLease(), lease);
      assert.deepEqual(
        rows(task, 'model:before-physical-success').map((row) => row.state),
        ['started'],
      );
      return 'ok';
    },
  });
  assert.equal(completed.value, 'ok');
  assert.deepEqual(order, ['policy', 'body']);
  assert.deepEqual(
    rows(task, 'model:before-physical-success').map((row) => row.state),
    ['returned'],
  );
  leases.revokeDispatchLease(task.parentLease);
});

test('due parallel read bodies return before the first durable settlement continuation', async () => {
  const task = fixture('Read four independent local sources.');
  let enteredBodies = 0;
  let returnedBodies = 0;
  let releaseBodies!: () => void;
  const allBodiesEntered = new Promise<void>((resolve) => { releaseBodies = resolve; });
  let recordCheckpoint!: (value: { returnedBodies: number; settlements: number }) => void;
  const checkpoint = new Promise<{ returnedBodies: number; settlements: number }>(
    (resolve) => { recordCheckpoint = resolve; },
  );
  let checkpointScheduled = false;

  const executions = Array.from({ length: 4 }, (_, index) => runCall(task, {
    callId: `model:parallel-read-${index}`,
    args: { source: `independent-${index}` },
    deadlineMs: 1_000,
    invoke: async () => {
      enteredBodies += 1;
      if (enteredBodies === 4) releaseBodies();
      await allBodiesEntered;
      // These are four independent timers due in the same timers phase. The
      // first body schedules a check-phase observer before its host completion
      // continuation can schedule durable settlement.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      returnedBodies += 1;
      if (!checkpointScheduled) {
        checkpointScheduled = true;
        setImmediate(() => {
          const settlements = (eventlog.openEventLog().prepare(`
            SELECT COUNT(*) AS count
              FROM logical_call_settlements
             WHERE session_id = ? AND source_user_seq = ?
          `).get(task.sessionId, task.sourceUserSeq) as { count: number }).count;
          recordCheckpoint({ returnedBodies, settlements });
        });
      }
      return `result-${index}`;
    },
  }));

  try {
    const [observed, results] = await Promise.all([
      checkpoint,
      Promise.all(executions),
    ]);
    assert.deepEqual(observed, { returnedBodies: 4, settlements: 0 });
    assert.deepEqual(results.map((result) => result.value), [
      'result-0',
      'result-1',
      'result-2',
      'result-3',
    ]);
  } finally {
    leases.revokeDispatchLease(task.parentLease);
  }
});

test('beforePhysicalAdmission refusal settles a truthful zero-crossing call and never enters the body', async () => {
  const task = fixture();
  let policyCalls = 0;
  let bodies = 0;
  await assert.rejects(
    runCall(task, {
      callId: 'model:before-physical-refused',
      deadlineMs: 200,
      beforePhysicalAdmission: () => {
        policyCalls += 1;
        assert.equal(rows(task, 'model:before-physical-refused').length, 0);
        throw new Error('exact source argument authority did not match');
      },
      invoke: async () => {
        bodies += 1;
        return 'must not run';
      },
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError
      && /before-physical admission refused/i.test(error.message),
  );
  assert.equal(policyCalls, 1);
  assert.equal(bodies, 0);
  assert.equal(rows(task, 'model:before-physical-refused').length, 0);
  const db = eventlog.openEventLog();
  const logical = db.prepare(`
    SELECT state FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    'model:before-physical-refused',
  ) as { state: string };
  assert.equal(logical.state, 'settled');
  const settlement = db.prepare(`
    SELECT execution_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    'model:before-physical-refused',
  ) as { execution_kind: string; physical_crossing_count: number };
  assert.deepEqual(settlement, {
    execution_kind: 'refused_pre_dispatch',
    physical_crossing_count: 0,
  });
  const child = db.prepare(`
    SELECT revoked_at FROM run_dispatch_leases
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    'model:before-physical-refused',
  ) as { revoked_at: string | null };
  assert.ok(child.revoked_at);
  leases.revokeDispatchLease(task.parentLease);
});

test('a cooperative hanging read sees one exact signal and settles timed_out before abort', async () => {
  const task = fixture();
  let callbackSignal: AbortSignal | undefined;
  let alsSignal: AbortSignal | undefined;
  let sawAbort = false;
  const startedAt = Date.now();
  await assert.rejects(
    runCall(task, {
      callId: 'model:cooperative-timeout',
      deadlineMs: 25,
      invoke: ({ signal }) => {
        callbackSignal = signal;
        alsSignal = abortContext.currentToolAbortSignal();
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationDeadlineError,
  );
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(callbackSignal, alsSignal);
  assert.equal(sawAbort, true);
  assert.deepEqual(rows(task, 'model:cooperative-timeout').map((row) => row.state), ['timed_out']);
  const redeemed = settlements.redeemDurableLogicalCallSettlementForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: 'model:cooperative-timeout',
  });
  assert.equal(redeemed.status, 'ok');
  if (redeemed.status === 'ok') {
    assert.equal(redeemed.settlement.outcome.kind, 'transient');
    assert.equal(redeemed.settlement.outcome.directive.action, 'retry_with_backoff');
    assert.equal(redeemed.settlement.crossings[0]?.terminalState, 'timed_out');
  }
  leases.revokeDispatchLease(task.parentLease);
});

// Live 2026-08-26, sess-desktop-970d457a6554134620236989 source 85009: a
// discovery-classified call (tool_search) admitted a governor claim, then hit
// this exact host-owned deadline path. The attempt above settled `transient`
// as pinned, but nothing ever told discovery-governor.ts's claim it had
// concluded — that claim admitted deep inside the nested tool wrapper's own
// closure (brackets.ts) was never reachable from here, so it sat 'pending'
// forever and denied 55 later tool_search calls for the rest of the turn.
// THE PIN: stop() now settles by call id — the claim's durable physical
// identity — so no pending row can survive the call regardless of which
// nested wrapper opened it, and the live starvation shape stays fixed with
// the timer gone (a follow-up on the same subject lands as a continuation).
test('a discovery call that ends on a host-owned deadline settles its governor claim, not just its attempt', async () => {
  const task = fixture();
  assert.equal(
    discoveryGovernorModule.discoveryGovernor.initializeTask({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      knownCapability: false,
    }).status,
    'initialized',
  );

  await assert.rejects(
    runCall(task, {
      callId: 'model:hanging-search',
      toolName: 'tool_search',
      args: { query: 'alpha records' },
      deadlineMs: 25,
      invoke: () => {
        // Mirrors what wrapToolForHarness's nested body does deep inside its
        // own closure before the real provider search runs: admit the
        // governor claim, then hang forever — modeling the body that never
        // gets a chance to settle its own lease once the host wins the race.
        const lease = discoveryBoundary.admitDiscoveryBoundary({
          sessionId: task.sessionId,
          sourceUserSeq: task.sourceUserSeq,
          turn: 1,
          toolName: 'tool_search',
          input: { query: 'alpha records' },
          callId: 'model:hanging-search',
        });
        assert.ok(lease, 'the fixture must actually admit a discovery claim to exercise this pin');
        return new Promise<never>(() => {});
      },
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationDeadlineError,
  );

  const state = discoveryGovernorModule.discoveryGovernor.getTaskState({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  const claim = state?.allClaims.find((c) => c.callId === 'model:hanging-search');
  assert.ok(claim, 'the admitted claim must still be discoverable in the ledger');
  assert.notEqual(claim?.outcome, 'pending', 'no pending row may survive the call that opened it');
  assert.equal(claim?.outcome, 'timed_out');

  // THE STARVATION SHAPE, confirmed fixed: a follow-up search on the same
  // subject now lands as a bounded continuation instead of colliding with an
  // orphaned claim for the rest of the turn.
  const followUp = discoveryGovernorModule.discoveryGovernor.admit({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    category: 'broad_discovery',
    callId: 'model:hanging-search-2',
  });
  assert.equal(followUp.admitted, true, `follow-up must admit as a continuation — got ${followUp.reason}`);
  assert.equal(followUp.reason, 'settled_continuation_admitted');

  leases.revokeDispatchLease(task.parentLease);
});

test('an uncooperative late read is bounded and cannot upgrade its frozen timeout', async () => {
  const task = fixture();
  let resolveLate!: (value: string) => void;
  const late = new Promise<string>((resolve) => { resolveLate = resolve; });
  await assert.rejects(
    runCall(task, {
      callId: 'model:late-read',
      deadlineMs: 20,
      invoke: () => late,
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationDeadlineError,
  );
  const before = rows(task, 'model:late-read');
  assert.equal(before[0]?.state, 'timed_out');
  resolveLate('too late');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(rows(task, 'model:late-read'), before);
  const redeemed = settlements.redeemDurableLogicalCallSettlementForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: 'model:late-read',
  });
  assert.equal(redeemed.status, 'ok');
  assert.equal(redeemed.status === 'ok' && redeemed.settlement.resultHandleId, undefined);
  leases.revokeDispatchLease(task.parentLease);
});

test('a stopped write freezes unknown and requires reconciliation without replay authority', async () => {
  const task = fixture('Update the current alpha record.');
  await assert.rejects(
    runCall(task, {
      callId: 'model:uncertain-write',
      effect: 'external_write',
      deadlineMs: 20,
      invoke: () => new Promise<never>(() => {}),
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationUncertainError,
  );
  const [crossing] = rows(task, 'model:uncertain-write');
  assert.equal(crossing?.state, 'unknown');
  assert.equal(dispatch.retryDispositionFor('unknown', 'external_write', 'explicit_retry'), 'require_reconciliation');
  const redeemed = settlements.redeemDurableLogicalCallSettlementForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: 'model:uncertain-write',
  });
  assert.equal(redeemed.status, 'ok');
  if (redeemed.status === 'ok') {
    assert.equal(redeemed.settlement.outcome.kind, 'uncertain_write');
    assert.equal(redeemed.settlement.outcome.directive.requiresReconciliation, true);
    assert.equal(redeemed.settlement.outcome.directive.retrySameCandidate, false);
  }
  leases.revokeDispatchLease(task.parentLease);
});

test('a kill cancels a read without granting timeout retry authority', async () => {
  const task = fixture();
  let killed = false;
  setTimeout(() => { killed = true; }, 10);
  await assert.rejects(
    runCall(task, {
      callId: 'model:killed-read',
      deadlineMs: 500,
      isKillRequested: () => killed,
      invoke: () => new Promise<never>(() => {}),
    }),
    (error: unknown) => (
      error instanceof invocation.HostToolInvocationCancelledError
      && error.reason === 'kill'
    ),
  );
  assert.equal(rows(task, 'model:killed-read')[0]?.state, 'cancelled');
  const redeemed = settlements.redeemDurableLogicalCallSettlementForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: 'model:killed-read',
  });
  assert.equal(redeemed.status, 'ok');
  if (redeemed.status === 'ok') {
    assert.equal(redeemed.settlement.outcome.kind, 'unknown');
    assert.equal(redeemed.settlement.outcome.directive.retrySameCandidate, false);
  }
  leases.revokeDispatchLease(task.parentLease);
});

test('an unreadable kill authority terminalizes unknown instead of stranding an open call', async () => {
  const task = fixture();
  let checks = 0;
  await assert.rejects(
    runCall(task, {
      callId: 'model:kill-reader-fault',
      deadlineMs: 500,
      isKillRequested: () => {
        checks += 1;
        if (checks === 1) return false;
        throw new Error('kill storage unavailable');
      },
      invoke: () => new Promise<never>(() => {}),
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError,
  );
  const [crossing] = rows(task, 'model:kill-reader-fault');
  assert.equal(crossing?.state, 'unknown');
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
       AND logical_tool_call_id = ? AND state = 'open'
  `).get(task.sessionId, task.sourceUserSeq, 'model:kill-reader-fault') as { n: number }).n, 0);
  const lease = db.prepare(`
    SELECT revoked_at FROM run_dispatch_leases WHERE scope_id = ? AND lease_id = ?
  `).get(crossing!.lease_scope_id, crossing!.lease_id) as { revoked_at: string | null };
  assert.ok(lease.revoked_at);
  leases.revokeDispatchLease(task.parentLease);
});

test('host-owned external provenance is explicit and freezes a provider-site crossing', async () => {
  const task = fixture();
  const completed = await runCall(task, {
    callId: 'model:explicit-external',
    boundary: 'host_owned_external',
    deadlineMs: 200,
    invoke: async () => ({ successful: true, records: ['alpha'] }),
  });
  assert.deepEqual(completed.value, { successful: true, records: ['alpha'] });
  const [crossing] = rows(task, 'model:explicit-external');
  assert.equal(crossing?.execution_site, null);
  assert.equal(crossing?.state, 'returned');
  const redeemed = settlements.redeemDurableLogicalCallSettlementForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: 'model:explicit-external',
  });
  assert.equal(redeemed.status, 'ok');
  assert.equal(redeemed.status === 'ok' && redeemed.settlement.executionKind, 'provider_execution');
  leases.revokeDispatchLease(task.parentLease);
});

test('a settled success redeems its exact raw payload before another child lease, body, or crossing', async () => {
  const task = fixture();
  let bodies = 0;
  const execute = () => runCall(task, {
    callId: 'model:settled-success-replay',
    boundary: 'host_owned_external',
    deadlineMs: 200,
    invoke: async () => {
      bodies += 1;
      return { successful: true, data: { records: [{ id: 'alpha' }] } };
    },
  });
  const first = await execute();
  assert.equal(first.settlement.duplicate, false);
  assert.ok(first.settlement.resultHandleId);
  const db = eventlog.openEventLog();
  const before = {
    rows: rows(task, 'model:settled-success-replay'),
    leases: (db.prepare(`SELECT COUNT(*) AS n FROM run_dispatch_leases
      WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
      .get(task.sessionId, task.sourceUserSeq, 'model:settled-success-replay') as { n: number }).n,
  };
  eventlog.closeEventLog();
  const replay = await execute();
  assert.deepEqual(replay.value, first.value);
  assert.equal(replay.settlement.duplicate, true);
  assert.equal(replay.settlement.resultHandleId, first.settlement.resultHandleId);
  assert.equal(bodies, 1);
  assert.deepEqual(rows(task, 'model:settled-success-replay'), before.rows);
  assert.equal((eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM run_dispatch_leases
    WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
    .get(task.sessionId, task.sourceUserSeq, 'model:settled-success-replay') as { n: number }).n,
  before.leases);
  leases.revokeDispatchLease(task.parentLease);
});

test('host_v1 freezes one generic catalog binding before crossing and exact replay never re-enters the body', async () => {
  const task = productionFixture();
  let bodies = 0;
  const execute = () => runProductionCall(task, {
    callId: 'model:durable-host-capability',
    invoke: async () => {
      bodies += 1;
      return { successful: true, records: [{ id: 'restaurant-1' }] };
    },
  });
  const first = await execute();
  const db = eventlog.openEventLog();
  const frozen = db.prepare(`
    SELECT binding_kind, account_id, operation_id, provider_input_schema_digest,
           durable_binding_digest
      FROM host_call_capability_bindings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, 'model:durable-host-capability') as {
    binding_kind: string;
    account_id: string;
    operation_id: string;
    provider_input_schema_digest: string | null;
    durable_binding_digest: string;
  };
  assert.deepEqual({
    kind: frozen.binding_kind,
    account: frozen.account_id,
    operation: frozen.operation_id,
    schema: frozen.provider_input_schema_digest,
    digestLength: frozen.durable_binding_digest.length,
  }, {
    kind: 'catalog_manifest',
    account: 'conn-provider',
    operation: 'READ_FILE',
    schema: null,
    digestLength: 64,
  }, 'catalog calls without the newer full provider schema remain generically compatible');
  const crossingsBefore = rows(task, 'model:durable-host-capability');
  const leasesBefore = (db.prepare(`SELECT COUNT(*) AS n FROM run_dispatch_leases
    WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
    .get(task.sessionId, task.sourceUserSeq, 'model:durable-host-capability') as { n: number }).n;
  const replay = await execute();
  assert.deepEqual(replay.value, first.value);
  assert.equal(replay.settlement.duplicate, true);
  assert.equal(bodies, 1);
  assert.deepEqual(rows(task, 'model:durable-host-capability'), crossingsBefore);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM run_dispatch_leases
    WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
    .get(task.sessionId, task.sourceUserSeq, 'model:durable-host-capability') as { n: number }).n,
  leasesBefore);

  await assert.rejects(
    runProductionCall(task, {
      callId: 'model:durable-host-capability',
      attestationOverrides: { accountId: 'conn-lookalike' },
      invoke: async () => {
        bodies += 1;
        return { successful: true };
      },
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError
      && /durable host-call capability binding/.test(error.message),
  );
  assert.equal(bodies, 1);
  assert.deepEqual(rows(task, 'model:durable-host-capability'), crossingsBefore);
  leases.revokeDispatchLease(task.parentLease);
});

test('host capability persistence fault settles a zero-crossing refusal and never enters the body', async () => {
  const task = productionFixture();
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_host_capability_binding_failure
    BEFORE INSERT ON host_call_capability_bindings
    BEGIN
      SELECT RAISE(ABORT, 'forced host capability binding failure');
    END;
  `);
  let bodies = 0;
  try {
    await assert.rejects(
      runProductionCall(task, {
        callId: 'model:host-binding-storage-fault',
        invoke: async () => {
          bodies += 1;
          return { successful: true };
        },
      }),
      (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError
        && /host capability binding is storage_error/.test(error.message),
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS force_host_capability_binding_failure');
  }
  assert.equal(bodies, 0);
  assert.equal(rows(task, 'model:host-binding-storage-fault').length, 0);
  const logical = db.prepare(`
    SELECT state, outcome_kind FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, 'model:host-binding-storage-fault') as {
    state: string;
    outcome_kind: string;
  };
  assert.notEqual(logical.state, 'open');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM host_call_capability_bindings
    WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
    .get(task.sessionId, task.sourceUserSeq, 'model:host-binding-storage-fault') as { n: number }).n, 0);
  leases.revokeDispatchLease(task.parentLease);
});

test('durable host binding explicitly follows the one-shot raw-to-effective logical refinement on replay', () => {
  const task = productionFixture();
  const callId = 'model:host-binding-refined-replay';
  const rawArgs = { path: { $fromToolOutput: { call_id: 'source-call', path: '$.path' } } };
  const effectiveArgs = { path: '/tmp/resolved-alpha.json' };
  const attestation = productionCatalogAttestation(task, callId, 'read_file', rawArgs);
  const rawContract = logicalContracts.durableLogicalCallContract(
    task.acceptedTaskId,
    'read_file',
    rawArgs,
  );
  const effectiveContract = logicalContracts.durableLogicalCallContract(
    task.acceptedTaskId,
    'read_file',
    effectiveArgs,
  );
  assert.ok(rawContract && effectiveContract);
  callAuthority.withHostCallAttestation(attestation, () => identities.withLogicalToolCall({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: callId,
    tool: 'read_file',
    args: rawArgs,
  }, () => {
    const persisted = hostBindings.persistHostCallCapabilityBinding({
      db: eventlog.openEventLog(),
      attestation: callAuthority.currentHostCallAttestation(),
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: callId,
      acceptedTaskId: task.acceptedTaskId,
      toolName: rawContract.toolName,
      argumentDigest: rawContract.argumentDigest,
      effect: 'read',
    });
    assert.equal(persisted.status, 'bound');
    // Production retains the exact raw carrier attestation while the trusted
    // resolver materializes provider-ready bytes. The immutable host binding
    // plus the logical row's one-shot refinement jointly authorize this edge;
    // no caller-authored replacement attestation is required or trusted.
    const refined = identities.authorizeResolvedLogicalCallContract({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: 1,
      tool: 'read_file',
      effectiveArgs,
    });
    assert.equal(refined?.argumentDigest, effectiveContract.argumentDigest);
  }));

  const loaded = hostBindings.loadHostCallCapabilityBinding({
    db: eventlog.openEventLog(),
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: callId,
  });
  assert.equal(loaded.status, 'ok');
  if (loaded.status !== 'ok') return;
  assert.equal(loaded.binding.attestedArgumentDigest, rawContract.argumentDigest);
  assert.equal(loaded.binding.effectiveArgumentDigest, effectiveContract.argumentDigest);
  assert.equal(loaded.binding.boundEffectiveArgumentDigest, undefined);

  const replay = hostBindings.verifyHostCallCapabilityBindingForReplay({
    db: eventlog.openEventLog(),
    attestation,
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: callId,
    acceptedTaskId: task.acceptedTaskId,
    toolName: rawContract.toolName,
    argumentDigest: rawContract.argumentDigest,
    effect: 'read',
  });
  assert.equal(replay.status, 'replayed');
  leases.revokeDispatchLease(task.parentLease);
});

test('raw host attestation cannot refine a call when its immutable capability binding is absent', () => {
  const task = productionFixture();
  const callId = 'model:host-refinement-without-binding';
  const rawArgs = { path: { $fromToolOutput: { call_id: 'source-call', path: '$.path' } } };
  const effectiveArgs = { path: '/tmp/unbound-alpha.json' };
  const attestation = productionCatalogAttestation(task, callId, 'read_file', rawArgs);
  let bodies = 0;

  assert.throws(
    () => callAuthority.withHostCallAttestation(attestation, () =>
      identities.withLogicalToolCall({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        logicalToolCallId: callId,
        tool: 'read_file',
        args: rawArgs,
      }, () => {
        identities.authorizeResolvedLogicalCallContract({
          sessionId: task.sessionId,
          sourceUserSeq: task.sourceUserSeq,
          turn: 1,
          tool: 'read_file',
          effectiveArgs,
        });
        bodies += 1;
      })),
    (error: unknown) => error instanceof identities.LogicalCallPreDispatchAuthorityError
      && /live capability attestation/.test(error.message),
  );
  assert.equal(bodies, 0);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, callId) as { n: number }).n, 0);
  leases.revokeDispatchLease(task.parentLease);
});

test('v57 never invents authority for a historical settled host call and cannot redispatch it', async () => {
  const task = productionFixture();
  const callId = 'model:historical-v56-without-binding';
  let bodies = 0;
  await runProductionCall(task, {
    callId,
    invoke: async () => {
      bodies += 1;
      return { records: [{ id: 'historical' }] };
    },
  });
  const before = rows(task, callId);
  assert.equal(before.length, 1);

  // Rehearse the exact upgrade hazard: v56 could retain a successful logical
  // settlement and provider crossing but had no durable capability-binding
  // table. Remove the v57 extension and every later migration marker so the
  // reopen really starts from v56. Keeping a v58 marker would make the
  // migration runner (correctly) treat the store as current and would turn
  // this rehearsal into an impossible, manually-corrupted schema shape.
  // Reopening must add an empty table, never backfill one from results.
  const db = eventlog.openEventLog();
  // Rewinding to v56 replays v58..v65 as well, so the store must be honestly
  // pre-v57 for those replays too.
  removeV65StructuresFromHistoricalMigrationFixture(db);
  db.exec(`
    DROP TRIGGER IF EXISTS trg_host_call_capability_binding_root_exact;
    DROP TRIGGER IF EXISTS trg_host_call_capability_binding_logical_exact;
    DROP TRIGGER IF EXISTS trg_host_call_capability_binding_update_immutable;
    DROP TRIGGER IF EXISTS trg_host_call_capability_binding_delete_immutable;
    DROP TABLE host_call_capability_bindings;
    DELETE FROM schema_version WHERE version >= 57;
  `);
  eventlog.closeEventLog();
  const migrated = eventlog.openEventLog();
  assert.equal((migrated.prepare(`SELECT COUNT(*) AS count FROM host_call_capability_bindings`).get() as {
    count: number;
  }).count, 0, 'migration manufactures no binding from historical success bytes');

  await assert.rejects(
    runProductionCall(task, {
      callId,
      invoke: async () => {
        bodies += 1;
        return { records: [{ id: 'forbidden-redispatch' }] };
      },
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError
      && /settled replay capability binding is conflict: durable host-call capability binding is missing/.test(error.message),
  );
  assert.equal(bodies, 1, 'missing historical authority cannot re-enter the body');
  assert.deepEqual(rows(task, callId), before, 'missing historical authority cannot add a crossing');
  leases.revokeDispatchLease(task.parentLease);
});

test('settled-success adoption fails closed when the same model call id changes its args or effect', async () => {
  const task = fixture();
  let bodies = 0;
  await runCall(task, {
    callId: 'model:settled-contract-mismatch',
    boundary: 'host_owned_external',
    deadlineMs: 200,
    invoke: async () => {
      bodies += 1;
      return { successful: true, data: { records: [{ id: 'alpha' }] } };
    },
  });
  const beforeRows = rows(task, 'model:settled-contract-mismatch');
  await assert.rejects(
    runCall(task, {
      callId: 'model:settled-contract-mismatch',
      args: { query: 'beta' },
      boundary: 'host_owned_external',
      deadlineMs: 200,
      invoke: async () => {
        bodies += 1;
        return { successful: true, data: { records: [{ id: 'beta' }] } };
      },
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError
      && /(settled replay capability binding is conflict|conflicts with the current invocation contract)/.test(error.message),
  );
  await assert.rejects(
    runCall(task, {
      callId: 'model:settled-contract-mismatch',
      effect: 'external_write',
      boundary: 'host_owned_external',
      deadlineMs: 200,
      invoke: async () => {
        bodies += 1;
        return { successful: true, data: { updated: true } };
      },
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError
      && /(settled replay capability binding is conflict|conflicts with the current invocation contract)/.test(error.message),
  );
  assert.equal(bodies, 1);
  assert.deepEqual(rows(task, 'model:settled-contract-mismatch'), beforeRows);
  leases.revokeDispatchLease(task.parentLease);
});

test('a non-success settlement is never replayed into the body or reported as success', async () => {
  const task = fixture();
  let bodies = 0;
  await assert.rejects(runCall(task, {
    callId: 'model:failed-terminal-no-replay',
    boundary: 'host_owned_external',
    deadlineMs: 200,
    invoke: async () => {
      bodies += 1;
      throw new Error('provider unavailable');
    },
  }), /provider unavailable/);
  const before = rows(task, 'model:failed-terminal-no-replay');
  await assert.rejects(
    runCall(task, {
      callId: 'model:failed-terminal-no-replay',
      boundary: 'host_owned_external',
      deadlineMs: 200,
      invoke: async () => {
        bodies += 1;
        return { successful: true, data: { records: [{ id: 'unsafe-retry' }] } };
      },
    }),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError
      && /is not replayable/.test(error.message),
  );
  assert.equal(bodies, 1);
  assert.deepEqual(rows(task, 'model:failed-terminal-no-replay'), before);
  leases.revokeDispatchLease(task.parentLease);
});

test('the same model call id on a different accepted task executes independently', async () => {
  const firstTask = fixture();
  const secondTask = fixture();
  let firstBodies = 0;
  let secondBodies = 0;
  const first = await runCall(firstTask, {
    callId: 'model:task-scoped-call-id',
    boundary: 'host_owned_external',
    deadlineMs: 200,
    invoke: async () => {
      firstBodies += 1;
      return { successful: true, data: { records: [{ id: 'first-task' }] } };
    },
  });
  const second = await runCall(secondTask, {
    callId: 'model:task-scoped-call-id',
    boundary: 'host_owned_external',
    deadlineMs: 200,
    invoke: async () => {
      secondBodies += 1;
      return { successful: true, data: { records: [{ id: 'second-task' }] } };
    },
  });
  assert.equal(first.settlement.duplicate, false);
  assert.equal(second.settlement.duplicate, false);
  assert.equal(firstBodies, 1);
  assert.equal(secondBodies, 1);
  assert.notDeepEqual(first.value, second.value);
  assert.equal(rows(firstTask, 'model:task-scoped-call-id').length, 1);
  assert.equal(rows(secondTask, 'model:task-scoped-call-id').length, 1);
  leases.revokeDispatchLease(firstTask.parentLease);
  leases.revokeDispatchLease(secondTask.parentLease);
});

test('nested wrappers settle once inside and the host adopts that exact durable result', async () => {
  const task = fixture();
  const result = await runCall(task, {
    callId: 'model:nested',
    boundary: 'nested_owned',
    deadlineMs: 200,
    invoke: async () => identities.withLogicalToolCall({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: 'model:nested',
      tool: 'read_file',
      args: { query: 'alpha' },
    }, async () => {
      const value = await identities.withPhysicalDispatch({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        tool: 'read_file',
        args: { query: 'alpha' },
      }, async () => ({ successful: true, data: ['alpha'] }));
      attemptSettlements.settleToolAttempt({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        acceptedTaskId: task.acceptedTaskId,
        callId: 'model:nested',
        turn: 1,
        lane: 'byo',
        toolName: 'read_file',
        args: { query: 'alpha' },
        mutating: false,
        businessCall: true,
        result: value,
      });
      return value;
    }),
  });
  assert.deepEqual(result.value, { successful: true, data: ['alpha'] });
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, 'model:nested') as { n: number }).n, 1);
  assert.equal(rows(task, 'model:nested').length, 1);
  assert.equal(rows(task, 'model:nested')[0]?.execution_site, null);
  leases.revokeDispatchLease(task.parentLease);
});

test('a marked nested provider adapter owns the one threw crossing without a host duplicate', async () => {
  const task = fixture();
  const callId = 'model:nested-provider-threw';
  const args = { query: 'alpha' };
  let bodies = 0;
  const configured = terminalDispatchOwners.attestTerminalPhysicalDispatchOwner(sdkTool({
    name: 'read_file',
    description: 'Hermetic provider adapter.',
    parameters: z.object({ query: z.string() }),
    errorFunction: (_context, error) => { throw error; },
    execute: async (input) => {
      try {
        return await identities.withPhysicalDispatch({
          sessionId: task.sessionId,
          sourceUserSeq: task.sourceUserSeq,
          turn: 1,
          tool: 'read_file',
          args: input,
        }, async () => {
          bodies += 1;
          throw new Error('provider exploded after crossing');
        });
      } catch (error) {
        attemptSettlements.settleToolAttempt({
          sessionId: task.sessionId,
          sourceUserSeq: task.sourceUserSeq,
          acceptedTaskId: task.acceptedTaskId,
          callId,
          turn: 1,
          lane: 'composio',
          toolName: 'read_file',
          args: input,
          mutating: false,
          businessCall: true,
          thrown: error,
        });
        throw error;
      }
    },
  }));
  const wrapped = brackets.wrapToolForHarness(configured) as unknown as {
    invoke: (runContext: unknown, input: string, details: unknown) => Promise<unknown>;
  };

  await assert.rejects(runCall(task, {
    callId,
    boundary: 'nested_owned',
    deadlineMs: 200,
    invoke: ({ signal }) => wrapped.invoke(
      { context: { sessionId: task.sessionId } },
      JSON.stringify(args),
      { toolCall: { callId }, signal },
    ),
  }), /provider exploded/);
  assert.equal(bodies, 1);
  assert.deepEqual(rows(task, callId).map((row) => ({
    state: row.state,
    execution_site: row.execution_site,
  })), [{ state: 'threw', execution_site: null }]);
  leases.revokeDispatchLease(task.parentLease);
});

test('a marked nested provider adapter cannot settle as local when it omits its physical row', async () => {
  const task = fixture();
  const callId = 'model:nested-provider-omitted-row';
  const args = { query: 'alpha' };
  let adapterBodies = 0;
  const configured = terminalDispatchOwners.attestTerminalPhysicalDispatchOwner(sdkTool({
    name: 'read_file',
    description: 'Hermetic broken provider adapter.',
    parameters: z.object({ query: z.string() }),
    errorFunction: (_context, error) => { throw error; },
    execute: async (input) => {
      adapterBodies += 1;
      const value = { successful: true, data: ['unowned'] };
      attemptSettlements.settleToolAttempt({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        acceptedTaskId: task.acceptedTaskId,
        callId,
        turn: 1,
        lane: 'composio',
        toolName: 'read_file',
        args: input,
        mutating: false,
        businessCall: true,
        result: value,
      });
      return value;
    },
  }));
  const wrapped = brackets.wrapToolForHarness(configured) as unknown as {
    invoke: (runContext: unknown, input: string, details: unknown) => Promise<unknown>;
  };

  await assert.rejects(runCall(task, {
    callId,
    boundary: 'nested_owned',
    deadlineMs: 200,
    invoke: ({ signal }) => wrapped.invoke(
      { context: { sessionId: task.sessionId } },
      JSON.stringify(args),
      { toolCall: { callId }, signal },
    ),
  }), /terminal provider adapter attempted to settle without its provider-owned physical dispatch row|nested-owned logical settlement is missing/);
  assert.equal(adapterBodies, 1);
  assert.equal(rows(task, callId).length, 0, 'the omitted provider row is never replaced by a host-local row');
  const settlementCount = (eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, callId) as { count: number }).count;
  assert.equal(settlementCount, 0, 'the row-less adapter result cannot become a durable success');
  leases.revokeDispatchLease(task.parentLease);
});

test('a marked nested provider timeout freezes its provider row under the exact child lease', async () => {
  const task = fixture();
  const callId = 'model:nested-provider-timeout';
  const args = { query: 'alpha' };
  let bodies = 0;
  const configured = terminalDispatchOwners.attestTerminalPhysicalDispatchOwner(sdkTool({
    name: 'read_file',
    description: 'Hermetic hanging provider adapter.',
    parameters: z.object({ query: z.string() }),
    execute: async (input) => identities.withPhysicalDispatch({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: 1,
      tool: 'read_file',
      args: input,
    }, () => {
      bodies += 1;
      return new Promise<never>(() => {});
    }),
  }));
  const wrapped = brackets.wrapToolForHarness(configured) as unknown as {
    invoke: (runContext: unknown, input: string, details: unknown) => Promise<unknown>;
  };

  await assert.rejects(runCall(task, {
    callId,
    boundary: 'nested_owned',
    deadlineMs: 20,
    invoke: ({ signal }) => wrapped.invoke(
      { context: { sessionId: task.sessionId } },
      JSON.stringify(args),
      { toolCall: { callId }, signal },
    ),
  }), (error: unknown) => error instanceof invocation.HostToolInvocationDeadlineError);
  assert.equal(bodies, 1);
  const physical = rows(task, callId);
  assert.equal(physical.length, 1, 'the outer SDK bracket minted no host duplicate');
  assert.deepEqual({
    state: physical[0]?.state,
    execution_site: physical[0]?.execution_site,
  }, { state: 'timed_out', execution_site: null });
  assert.notEqual(physical[0]?.lease_scope_id, task.parentLease.scopeId);
  const childOwner = eventlog.openEventLog().prepare(`
    SELECT logical_tool_call_id
      FROM run_dispatch_leases
     WHERE session_id = ? AND scope_id = ? AND lease_id = ?
  `).get(
    task.sessionId,
    physical[0]?.lease_scope_id,
    physical[0]?.lease_id,
  ) as { logical_tool_call_id: string | null };
  assert.equal(childOwner.logical_tool_call_id, callId,
    'the provider row belongs to the exact logical-call child lease');
  leases.revokeDispatchLease(task.parentLease);
});

test('nested owner wins when its provider result and the outer rendered carrier disagree', async () => {
  const task = fixture();
  const providerValue = { successful: true, data: ['alpha'] };
  const renderedCarrierValue = JSON.stringify(providerValue);
  const result = await runCall(task, {
    callId: 'model:nested-rendered-conflict',
    boundary: 'nested_owned',
    deadlineMs: 200,
    invoke: async () => identities.withLogicalToolCall({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: 'model:nested-rendered-conflict',
      tool: 'read_file',
      args: { query: 'alpha' },
    }, async () => {
      const value = await identities.withPhysicalDispatch({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        tool: 'read_file',
        args: { query: 'alpha' },
      }, async () => providerValue);
      const inner = attemptSettlements.settleToolAttempt({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        acceptedTaskId: task.acceptedTaskId,
        callId: 'model:nested-rendered-conflict',
        turn: 1,
        lane: 'byo',
        toolName: 'read_file',
        args: { query: 'alpha' },
        mutating: false,
        businessCall: true,
        result: value,
      });
      assert.ok(inner.resultHandleId);
      return renderedCarrierValue;
    }),
  });
  assert.equal(result.value, renderedCarrierValue);
  const durable = settlements.redeemDurableLogicalCallSettlementForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: 'model:nested-rendered-conflict',
  });
  assert.equal(durable.status, 'ok');
  assert.equal(result.settlement.resultHandleId,
    durable.status === 'ok' ? durable.settlement.resultHandleId : undefined,
    'the outer rendered carrier cannot replace the provider-owned result handle');
  assert.equal(rows(task, 'model:nested-rendered-conflict').length, 1);
  leases.revokeDispatchLease(task.parentLease);
});

test('nested completion without an exact durable inner settlement fails closed and remains recoverable', async () => {
  const task = fixture();
  await assert.rejects(runCall(task, {
    callId: 'model:nested-settlement-absent',
    boundary: 'nested_owned',
    deadlineMs: 200,
    invoke: async () => identities.withLogicalToolCall({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: 'model:nested-settlement-absent',
      tool: 'read_file',
      args: { query: 'alpha' },
    }, () => identities.withPhysicalDispatch({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      tool: 'read_file',
      args: { query: 'alpha' },
    }, async () => ({ successful: true, data: ['alpha'] }))),
  }), (error: unknown) => (
    error instanceof invocation.HostToolInvocationAuthorityError
    && /nested-owned logical settlement is missing/.test(error.reason)
  ));
  assert.equal(rows(task, 'model:nested-settlement-absent').length, 1);
  const stranded = exactCallLease(task, 'model:nested-settlement-absent');
  const recovered = invocation.reconcileRevokedHostToolInvocation({ lease: stranded });
  assert.equal(recovered.outcome.directive.action, 'stop_and_explain');
  assert.equal(settlements.redeemDurableLogicalCallSettlementForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: 'model:nested-settlement-absent',
  }).status, 'ok');
  leases.revokeDispatchLease(task.parentLease);
});

test('one timed-out sibling cannot revoke an independent call generation', async () => {
  const task = fixture();
  let releaseSibling!: () => void;
  const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve; });
  const timedOut = runCall(task, {
    callId: 'model:sibling-timeout',
    deadlineMs: 20,
    invoke: () => new Promise<never>(() => {}),
  });
  const healthy = runCall(task, {
    callId: 'model:sibling-healthy',
    deadlineMs: 300,
    invoke: async () => { await siblingGate; return 'healthy'; },
  });
  await assert.rejects(timedOut, invocation.HostToolInvocationDeadlineError);
  releaseSibling();
  assert.equal((await healthy).value, 'healthy');
  assert.equal(rows(task, 'model:sibling-timeout')[0]?.state, 'timed_out');
  assert.equal(rows(task, 'model:sibling-healthy')[0]?.state, 'returned');
  assert.notEqual(
    rows(task, 'model:sibling-timeout')[0]?.lease_id,
    rows(task, 'model:sibling-healthy')[0]?.lease_id,
  );
  leases.revokeDispatchLease(task.parentLease);
});

test('terminal settlement storage failure revokes and aborts but never reports a timeout as durable', async () => {
  const task = fixture();
  dispatch.setSettlementStorageFault(true);
  try {
    await assert.rejects(
      runCall(task, {
        callId: 'model:storage-fault',
        deadlineMs: 20,
        invoke: () => new Promise<never>(() => {}),
      }),
      (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError,
    );
    const [crossing] = rows(task, 'model:storage-fault');
    assert.equal(crossing?.state, 'started');
    const lease = eventlog.openEventLog().prepare(`
      SELECT revoked_at FROM run_dispatch_leases WHERE scope_id = ? AND lease_id = ?
    `).get(crossing!.lease_scope_id, crossing!.lease_id) as { revoked_at: string | null };
    assert.ok(lease.revoked_at, 'storage failure still fences the detached body first');
    assert.equal(settlements.redeemDurableLogicalCallSettlementForHost({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: 'model:storage-fault',
    }).status, 'missing');

    const strandedLease = exactCallLease(task, 'model:storage-fault');
    dispatch.setSettlementStorageFault(false);
    eventlog.closeEventLog();
    assert.equal(rows(task, 'model:storage-fault')[0]?.state, 'started',
      'restart preserves the unresolved crossing rather than claiming a timeout');
    const recovered = invocation.reconcileRevokedHostToolInvocation({
      lease: strandedLease,
    });
    assert.equal(rows(task, 'model:storage-fault')[0]?.state, 'unknown');
    assert.equal(recovered.outcome.directive.action, 'stop_and_explain',
      'an unknown restart state grants no blind read retry');
    let retryBodies = 0;
    await assert.rejects(
      runCall(task, {
        callId: 'model:storage-fault',
        invoke: async () => { retryBodies += 1; return 'must not redispatch'; },
      }),
    );
    assert.equal(retryBodies, 0, 'restart recovery never re-enters the stranded call body');
    assert.equal(settlements.redeemDurableLogicalCallSettlementForHost({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: 'model:storage-fault',
    }).status, 'ok');
  } finally {
    dispatch.setSettlementStorageFault(false);
    leases.revokeDispatchLease(task.parentLease);
  }
});

test('a returned crossing with failed logical persistence survives restart and cannot redispatch', async () => {
  const task = fixture();
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER host_invocation_test_fail_logical_settlement
    BEFORE INSERT ON logical_call_settlements
    BEGIN
      SELECT RAISE(ABORT, 'forced logical settlement failure');
    END
  `);
  let bodies = 0;
  await assert.rejects(runCall(task, {
    callId: 'model:return-storage-fault',
    invoke: async () => { bodies += 1; return { successful: true, data: ['alpha'] }; },
  }));
  assert.equal(bodies, 1);
  assert.equal(rows(task, 'model:return-storage-fault')[0]?.state, 'returned');
  const strandedLease = exactCallLease(task, 'model:return-storage-fault');
  const persistedLease = db.prepare(`
    SELECT revoked_at FROM run_dispatch_leases WHERE scope_id = ? AND lease_id = ?
  `).get(strandedLease.scopeId, strandedLease.leaseId) as { revoked_at: string | null };
  assert.ok(persistedLease.revoked_at);

  eventlog.closeEventLog();
  eventlog.openEventLog().exec('DROP TRIGGER host_invocation_test_fail_logical_settlement');
  assert.equal(rows(task, 'model:return-storage-fault')[0]?.state, 'returned');
  invocation.reconcileRevokedHostToolInvocation({
    lease: strandedLease,
  });
  let retryBodies = 0;
  await assert.rejects(runCall(task, {
    callId: 'model:return-storage-fault',
    invoke: async () => { retryBodies += 1; return 'must not redispatch'; },
  }));
  assert.equal(retryBodies, 0);
  assert.equal(rows(task, 'model:return-storage-fault')[0]?.state, 'returned',
    'recovery preserves the already-terminal crossing bytes');
  const redeemed = settlements.redeemDurableLogicalCallSettlementForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: 'model:return-storage-fault',
  });
  assert.equal(redeemed.status, 'ok');
  if (redeemed.status === 'ok') {
    assert.equal(redeemed.settlement.executionKind, 'local_execution',
      'an existing returned crossing is never rewritten as a zero-crossing refusal');
    assert.equal(redeemed.settlement.crossings.length, 1);
    assert.equal(redeemed.settlement.crossings[0]?.terminalState, 'returned');
  }
  leases.revokeDispatchLease(task.parentLease);
});

test('daemon-start reaper reconciles one frozen revoked call once and a second sweep is inert', async () => {
  const task = fixture();
  dispatch.setSettlementStorageFault(true);
  try {
    await assert.rejects(
      runCall(task, {
        callId: 'model:boot-reaper-recovery',
        deadlineMs: 20,
        invoke: () => new Promise<never>(() => {}),
      }),
      invocation.HostToolInvocationAuthorityError,
    );
  } finally {
    dispatch.setSettlementStorageFault(false);
  }
  assert.equal(rows(task, 'model:boot-reaper-recovery')[0]?.state, 'started');
  const db = eventlog.openEventLog();
  const crossing = rows(task, 'model:boot-reaper-recovery')[0]!;
  assert.throws(() => db.prepare(`
    UPDATE run_dispatch_leases SET recovery_effect = 'external_write'
     WHERE scope_id = ? AND lease_id = ?
  `).run(crossing.lease_scope_id, crossing.lease_id), /immutable/i);

  eventlog.closeEventLog();
  const stop = reaper.startApprovalReaper({ immediate: true });
  stop();
  assert.equal(rows(task, 'model:boot-reaper-recovery')[0]?.state, 'unknown');
  assert.equal(settlements.redeemDurableLogicalCallSettlementForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: 'model:boot-reaper-recovery',
  }).status, 'ok');
  const settlementEventsBefore = (eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM events
     WHERE session_id = ? AND type = 'tool_attempt_settled'
  `).get(task.sessionId) as { n: number }).n;

  reaper.reapOnce();
  const settlementEventsAfter = (eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM events
     WHERE session_id = ? AND type = 'tool_attempt_settled'
  `).get(task.sessionId) as { n: number }).n;
  assert.equal(settlementEventsAfter, settlementEventsBefore);
  assert.deepEqual(invocation.reconcileRevokedHostToolInvocations(), {
    scanned: 0,
    settled: 0,
    held: 0,
    records: [],
  });

  let retryBodies = 0;
  await assert.rejects(runCall(task, {
    callId: 'model:boot-reaper-recovery',
    invoke: async () => { retryBodies += 1; return 'must not redispatch'; },
  }));
  assert.equal(retryBodies, 0);
  leases.revokeDispatchLease(task.parentLease);
});

test('post-admission ambient parent mismatch durably refuses setup with no open logical or physical row', async () => {
  const task = fixture();
  const foreignParent = leases.activateDispatchLease({
    sessionId: task.sessionId,
    scopeId: `${task.sessionId}::foreign-parent`,
  });
  const mismatchedContext: brackets.HarnessRunContext = {
    ...task.context,
    dispatchLease: foreignParent,
  };
  const attestation = productionCatalogAttestation(
    task,
    'model:setup-mismatch',
    'read_file',
    { query: 'alpha' },
  );
  await assert.rejects(
    callAuthority.withHostCallAttestation(attestation, () =>
      brackets.withHarnessRunContext(mismatchedContext, () => invocation.invokeHostToolCall({
        identity: {
          sessionId: task.sessionId,
          sourceUserSeq: task.sourceUserSeq,
          modelCallId: 'model:setup-mismatch',
          toolName: 'read_file',
          args: { query: 'alpha' },
          turn: 1,
        },
        parentLease: task.parentLease,
        effect: 'read',
        boundary: 'host_owned_local',
        deadlineMs: 100,
        invoke: async () => 'impossible',
      }))) as Promise<unknown>,
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError,
  );
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND state = 'open'
  `).get(task.sessionId, task.sourceUserSeq) as { n: number }).n, 0);
  assert.equal(rows(task).length, 0);
  leases.revokeDispatchLease(foreignParent);
  leases.revokeDispatchLease(task.parentLease);
});

test('physical reservation storage error durably refuses the admitted call without entering the body', async () => {
  const task = fixture();
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER host_invocation_test_fail_physical_reservation
    BEFORE INSERT ON physical_dispatches
    BEGIN
      SELECT RAISE(ABORT, 'forced physical reservation storage error');
    END
  `);
  let bodies = 0;
  try {
    await assert.rejects(
      runCall(task, {
        callId: 'model:physical-reservation-storage-error',
        invoke: async () => { bodies += 1; return 'must not run'; },
      }),
      (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError,
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS host_invocation_test_fail_physical_reservation');
  }
  assert.equal(bodies, 0);
  assert.equal(rows(task, 'model:physical-reservation-storage-error').length, 0);
  const logical = db.prepare(`
    SELECT state FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    'model:physical-reservation-storage-error',
  ) as { state: string };
  assert.equal(logical.state, 'settled');
  const settlement = db.prepare(`
    SELECT execution_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    'model:physical-reservation-storage-error',
  ) as { execution_kind: string; physical_crossing_count: number };
  assert.deepEqual(settlement, {
    execution_kind: 'refused_pre_dispatch',
    physical_crossing_count: 0,
  });
  const child = db.prepare(`
    SELECT revoked_at FROM run_dispatch_leases
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    'model:physical-reservation-storage-error',
  ) as { revoked_at: string | null };
  assert.ok(child.revoked_at);

  let replayBodies = 0;
  await assert.rejects(runCall(task, {
    callId: 'model:physical-reservation-storage-error',
    invoke: async () => { replayBodies += 1; return 'must not redispatch'; },
  }));
  assert.equal(replayBodies, 0);
  assert.equal(invocation.reconcileRevokedHostToolInvocations().scanned, 0);
  leases.revokeDispatchLease(task.parentLease);
});

test('restart recovery settles a revoked admitted call with provably zero physical rows', async () => {
  const task = fixture();
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER host_invocation_test_fail_zero_row_physical_reservation
    BEFORE INSERT ON physical_dispatches
    BEGIN
      SELECT RAISE(ABORT, 'forced zero-row physical reservation failure');
    END;
    CREATE TRIGGER host_invocation_test_interrupt_zero_row_refusal
    BEFORE INSERT ON logical_call_settlements
    BEGIN
      SELECT RAISE(ABORT, 'forced interruption before zero-row refusal');
    END
  `);
  let bodies = 0;
  try {
    await assert.rejects(
      runCall(task, {
        callId: 'model:restart-zero-row-refusal',
        invoke: async () => { bodies += 1; return 'must not run'; },
      }),
      (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError,
    );
  } finally {
    db.exec(`
      DROP TRIGGER IF EXISTS host_invocation_test_fail_zero_row_physical_reservation;
      DROP TRIGGER IF EXISTS host_invocation_test_interrupt_zero_row_refusal
    `);
  }
  assert.equal(bodies, 0);
  assert.equal(rows(task, 'model:restart-zero-row-refusal').length, 0);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ? AND state = 'open'
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    'model:restart-zero-row-refusal',
  ) as { n: number }).n, 1);
  const stranded = db.prepare(`
    SELECT scope_id, lease_id, revoked_at
      FROM run_dispatch_leases
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    'model:restart-zero-row-refusal',
  ) as { scope_id: string; lease_id: string; revoked_at: string | null };
  assert.ok(stranded.revoked_at);

  eventlog.closeEventLog();
  const recovered = invocation.reconcileRevokedHostToolInvocations();
  assert.equal(recovered.settled, 1);
  assert.equal(recovered.held, 0);
  assert.ok(recovered.records.some((record) => (
    record.sessionId === task.sessionId
    && record.sourceUserSeq === task.sourceUserSeq
    && record.logicalToolCallId === 'model:restart-zero-row-refusal'
    && record.leaseScopeId === stranded.scope_id
    && record.leaseId === stranded.lease_id
    && record.status === 'settled'
  )));
  const reopened = eventlog.openEventLog();
  const settlement = reopened.prepare(`
    SELECT execution_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    task.sessionId,
    task.sourceUserSeq,
    'model:restart-zero-row-refusal',
  ) as { execution_kind: string; physical_crossing_count: number };
  assert.deepEqual(settlement, {
    execution_kind: 'refused_pre_dispatch',
    physical_crossing_count: 0,
  });
  assert.deepEqual(invocation.reconcileRevokedHostToolInvocations(), {
    scanned: 0,
    settled: 0,
    held: 0,
    records: [],
  });
  leases.revokeDispatchLease(task.parentLease);
});

test('whitespace-normalized model ids are rejected instead of silently remapped', async () => {
  const task = fixture();
  await assert.rejects(
    brackets.withHarnessRunContext(task.context, () => invocation.invokeHostToolCall({
      identity: {
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        modelCallId: ' model:not-exact ',
        toolName: 'read_file',
        args: { query: 'alpha' },
        turn: 1,
      },
      parentLease: task.parentLease,
      effect: 'read',
      boundary: 'host_owned_local',
      deadlineMs: 100,
      invoke: async () => 'impossible',
    })),
    (error: unknown) => error instanceof invocation.HostToolInvocationAuthorityError,
  );
  assert.equal(rows(task).length, 0);
  leases.revokeDispatchLease(task.parentLease);
});

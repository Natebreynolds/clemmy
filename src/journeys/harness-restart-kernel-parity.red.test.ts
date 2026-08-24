/**
 * Run: node scripts/run-tests-isolated.mjs src/journeys/harness-restart-kernel-parity.red.test.ts
 *
 * Deliberate release REDs for the shared execution kernel. A settled logical
 * success is durable continuation state, not permission to call the provider
 * again. Chat and workflow must also bind every physical crossing to the same
 * exact call-owned run_dispatch_lease machinery; workflow activation rows are
 * not a substitute for that lease.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-restart-kernel-parity-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-restart-parity\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const shadow = await import('../runtime/graph/turn-graph-shadow.js');
const leases = await import('../runtime/harness/dispatch-lease.js');
const brackets = await import('../runtime/harness/brackets.js');
const invocation = await import('../runtime/harness/host-tool-invocation.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const workflowAuthority = await import('../runtime/harness/accepted-turn-call-authority.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const workflowPlans = await import('../memory/workflow-node-invocation-plan.js');
const workflowKernel = await import('../runtime/harness/workflow-read-only-call-kernel.js');

after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

type Task = {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
};

type RunOwner = {
  parentLease: leases.DispatchLeaseRef;
  context: brackets.HarnessRunContext;
};

function acceptedTask(label: string): Task {
  const session = eventlog.createSession({
    id: `restart-${label}-${randomUUID()}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Find 10 restaurants in Santa Clarita and put them in a new Google Sheet.',
    },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

function openRunOwner(task: Task, generation: string): RunOwner {
  const parentLease = leases.activateDispatchLease({
    sessionId: task.sessionId,
    scopeId: `${task.sessionId}::run:${generation}:${randomUUID()}`,
  });
  return {
    parentLease,
    context: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: 1,
      counter: new brackets.ToolCallsCounter(20),
      dispatchLease: parentLease,
    },
  };
}

function closeForRestart(owner: RunOwner): void {
  leases.revokeDispatchLease(owner.parentLease);
  eventlog.closeEventLog();
}

function runHostCall<T>(input: {
  task: Task;
  owner: RunOwner;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  effect: 'read' | 'external_write';
  body: invocation.InvokeHostToolCallInput<T>['invoke'];
}) {
  return brackets.withHarnessRunContext(input.owner.context, () =>
    invocation.invokeHostToolCall({
      identity: {
        sessionId: input.task.sessionId,
        sourceUserSeq: input.task.sourceUserSeq,
        modelCallId: input.callId,
        toolName: input.toolName,
        args: input.args,
        turn: 1,
      },
      parentLease: input.owner.parentLease,
      effect: input.effect,
      boundary: 'host_owned_external',
      deadlineMs: 500,
      invoke: input.body,
    })) as Promise<invocation.HostToolInvocationResult<T>>;
}

function durableCounts(task: Task, callId: string) {
  return eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS logical_n,
      (SELECT COUNT(*) FROM run_dispatch_leases
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS call_lease_n,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS physical_n,
      (SELECT COUNT(*) FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS settlement_n,
      (SELECT COUNT(*) FROM durable_result_handles
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS result_handle_n
  `).get(
    task.sessionId, task.sourceUserSeq, callId,
    task.sessionId, task.sourceUserSeq, callId,
    task.sessionId, task.sourceUserSeq, callId,
    task.sessionId, task.sourceUserSeq, callId,
    task.sessionId, task.sourceUserSeq, callId,
  ) as {
    logical_n: number;
    call_lease_n: number;
    physical_n: number;
    settlement_n: number;
    result_handle_n: number;
  };
}

const READ_CALL = Object.freeze({
  callId: 'restaurant-read',
  toolName: 'restaurant_records_search',
  args: { location: 'Santa Clarita, CA', limit: 10 },
});
const READ_RESULT = Object.freeze({
  successful: true,
  data: {
    records: Array.from({ length: 10 }, (_, index) => ({
      name: `Restaurant ${index + 1}`,
      address: `${100 + index} Main St`,
    })),
    complete: true,
  },
});
const CREATE_CALL = Object.freeze({
  callId: 'sheet-create',
  toolName: 'googlesheets_create_spreadsheet',
  args: { title: 'Santa Clarita Restaurants', rows: READ_RESULT.data.records },
});
const CREATE_RESULT = Object.freeze({
  successful: true,
  data: {
    spreadsheetId: 'sheet_restart_exact_once',
    url: 'https://docs.google.com/spreadsheets/d/sheet_restart_exact_once/edit',
    rowsWritten: 10,
  },
});

test('restart: crash after settled source read adopts its stored result, then continues create exactly once', async () => {
  const task = acceptedTask('after-read');
  let readBodies = 0;
  let createBodies = 0;
  let additionalModelCalls = 0;
  const initial = openRunOwner(task, 'initial');
  const firstRead = await runHostCall({
    task,
    owner: initial,
    ...READ_CALL,
    effect: 'read',
    body: async () => {
      readBodies += 1;
      return READ_RESULT;
    },
  });
  assert.deepEqual(firstRead.value, READ_RESULT);
  assert.equal(firstRead.settlement.duplicate, false);
  assert.deepEqual(durableCounts(task, READ_CALL.callId), {
    logical_n: 1,
    call_lease_n: 1,
    physical_n: 1,
    settlement_n: 1,
    result_handle_n: 1,
  });

  closeForRestart(initial);
  const resumed = openRunOwner(task, 'resume-after-read');
  const beforeReplay = durableCounts(task, READ_CALL.callId);
  // Continuation reads durable call state directly. It must not ask a model to
  // rediscover/reconstruct a call that already settled successfully.
  const replayedRead = await runHostCall({
    task,
    owner: resumed,
    ...READ_CALL,
    effect: 'read',
    body: async () => {
      readBodies += 1;
      return { successful: true, data: { records: [{ name: 'DUPLICATE PROVIDER CROSSING' }], complete: false } };
    },
  });
  assert.deepEqual(replayedRead.value, READ_RESULT, 'resume must adopt the exact stored raw payload');
  assert.equal(replayedRead.settlement.duplicate, true);
  assert.equal(readBodies, 1, 'settled read replay entered the provider body');
  assert.equal(additionalModelCalls, 0, 'settled read continuation opened another primary-model call');
  assert.deepEqual(
    durableCounts(task, READ_CALL.callId),
    beforeReplay,
    'settled replay created a new call lease, physical crossing, settlement, or result handle',
  );

  const created = await runHostCall({
    task,
    owner: resumed,
    ...CREATE_CALL,
    effect: 'external_write',
    body: async () => {
      createBodies += 1;
      return CREATE_RESULT;
    },
  });
  assert.deepEqual(created.value, CREATE_RESULT);
  assert.equal(createBodies, 1);
  assert.deepEqual(durableCounts(task, CREATE_CALL.callId), {
    logical_n: 1,
    call_lease_n: 1,
    physical_n: 1,
    settlement_n: 1,
    result_handle_n: 1,
  });
  leases.revokeDispatchLease(resumed.parentLease);
});

test('restart: crash after settled Sheet create adopts its stored receipt with zero new body, lease, physical, or model work', async () => {
  const task = acceptedTask('after-create');
  let readBodies = 0;
  let createBodies = 0;
  let additionalModelCalls = 0;
  const initial = openRunOwner(task, 'initial');
  await runHostCall({
    task,
    owner: initial,
    ...READ_CALL,
    effect: 'read',
    body: async () => {
      readBodies += 1;
      return READ_RESULT;
    },
  });
  const firstCreate = await runHostCall({
    task,
    owner: initial,
    ...CREATE_CALL,
    effect: 'external_write',
    body: async () => {
      createBodies += 1;
      return CREATE_RESULT;
    },
  });
  assert.deepEqual(firstCreate.value, CREATE_RESULT);
  const beforeCreateReplay = durableCounts(task, CREATE_CALL.callId);
  const beforeReadReplay = durableCounts(task, READ_CALL.callId);
  assert.deepEqual(beforeCreateReplay, {
    logical_n: 1,
    call_lease_n: 1,
    physical_n: 1,
    settlement_n: 1,
    result_handle_n: 1,
  });

  closeForRestart(initial);
  const resumed = openRunOwner(task, 'resume-after-create');
  // Replay the create first so this acceptance independently pins write
  // adoption even while read-replay support is also under construction.
  const replayedCreate = await runHostCall({
    task,
    owner: resumed,
    ...CREATE_CALL,
    effect: 'external_write',
    body: async () => {
      createBodies += 1;
      return { successful: true, data: { ...CREATE_RESULT.data, spreadsheetId: 'DUPLICATE' } };
    },
  });
  assert.deepEqual(replayedCreate.value, CREATE_RESULT, 'resume must adopt the stored Sheet receipt');
  assert.equal(replayedCreate.settlement.duplicate, true);
  assert.equal(createBodies, 1, 'settled create replay entered the provider body');
  assert.deepEqual(durableCounts(task, CREATE_CALL.callId), beforeCreateReplay,
    'settled create replay minted another call-bound durable row');

  const replayedRead = await runHostCall({
    task,
    owner: resumed,
    ...READ_CALL,
    effect: 'read',
    body: async () => {
      readBodies += 1;
      return { successful: true, data: { records: [], complete: false } };
    },
  });
  assert.deepEqual(replayedRead.value, READ_RESULT);
  assert.equal(replayedRead.settlement.duplicate, true);
  assert.equal(readBodies, 1);
  assert.deepEqual(durableCounts(task, READ_CALL.callId), beforeReadReplay);
  assert.equal(additionalModelCalls, 0);
  leases.revokeDispatchLease(resumed.parentLease);
});

const digest = (label: string): string => createHash('sha256').update(label, 'utf8').digest('hex');

function installWorkflowReadCapability(label: string) {
  catalogs.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  const definitionFingerprint = digest(`workflow-schema:${label}`);
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.workflow-parity.${label}`,
    providerKind: 'local_registry',
    operationId: `restaurant_workflow_read_${label}`,
    providerIdentity: 'runtime.workflow-parity',
    providerVersion: 'runtime.1',
    operationVersion: '1',
    definitionFingerprint,
    effect: 'read',
    accountId: `account.workflow-parity.${label}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'read_bounded_records',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host.test', issuedAt: '2026-08-23T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
  let providerBodies = 0;
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      invoke: async () => {
        providerBodies += 1;
        return { records: [{ id: 'restaurant.workflow.1' }], complete: true };
      },
    },
  ).ok, true);
  const entry: catalogs.RegisteredHostCapability = {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => {
      throw new Error('catalog callback is metadata, not the immutable provider port');
    },
  };
  catalogs.installHostCapabilityCatalogFactory(
    catalogs.createHostCapabilityCatalogFactory([entry]),
  );
  assert.equal(observations.registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
    observe: () => ({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now(),
    }),
  }).ok, true);
  const identity = catalogs.canonicalCatalogIdentityOf(entry);
  assert.ok(identity);
  const plan = workflowPlans.createWorkflowNodeInvocationPlan({
    requirementId: 'requirement.workflow.records',
    logicalCapabilityId: 'capability.workflow.records.read',
    binding: {
      capabilityId: identity.capabilityId,
      manifestId: identity.manifestId,
      manifestDigest: identity.manifestDigest,
      operationId: identity.operationId,
      operationVersion: identity.schemaVersion,
      schemaDigest: identity.schemaDigest,
      providerVersion: identity.providerVersion,
      liveFingerprint: identity.liveFingerprint,
      accountId: identity.account,
      effect: 'read',
      invokePortId: identity.invokePortId,
      argumentCompiler: { ...identity.argumentCompiler },
    },
    arguments: {
      scope: {
        source: { kind: 'workflow_input', key: 'scope' },
        required: true,
        type: 'string',
      },
    },
    evidence: {
      requiredPaths: ['records'],
      nonEmptyPaths: ['records'],
      minItems: { records: 1 },
    },
    completeness: { kind: 'terminal_result', evidencePaths: ['records'] },
    continuation: { kind: 'none' },
  });
  return { manifest, plan, providerBodies: () => providerBodies };
}

function callKernelSnapshot(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
}) {
  return eventlog.openEventLog().prepare(`
    SELECT l.state AS logical_state,
           p.state AS physical_state,
           s.outcome_kind,
           s.result_handle_id,
           p.lease_scope_id,
           p.lease_id,
           (SELECT COUNT(*) FROM run_dispatch_leases lease
             WHERE lease.session_id = l.session_id
               AND lease.source_user_seq = l.source_user_seq
               AND lease.logical_tool_call_id = l.logical_tool_call_id) AS call_lease_n,
           (SELECT COUNT(*) FROM run_dispatch_leases lease
             WHERE lease.session_id = l.session_id
               AND lease.source_user_seq = l.source_user_seq
               AND lease.logical_tool_call_id = l.logical_tool_call_id
               AND lease.scope_id = p.lease_scope_id
               AND lease.lease_id = p.lease_id
               AND lease.revoked_at IS NOT NULL) AS exact_revoked_lease_n,
           (SELECT COUNT(*) FROM durable_result_handles handle
             WHERE handle.handle_id = s.result_handle_id
               AND handle.session_id = l.session_id
               AND handle.source_user_seq = l.source_user_seq
               AND handle.logical_tool_call_id = l.logical_tool_call_id) AS evidence_handle_n
      FROM logical_tool_calls l
      JOIN physical_dispatches p
        ON p.session_id = l.session_id
       AND p.source_user_seq = l.source_user_seq
       AND p.logical_tool_call_id = l.logical_tool_call_id
      JOIN logical_call_settlements s
        ON s.session_id = l.session_id
       AND s.source_user_seq = l.source_user_seq
       AND s.logical_tool_call_id = l.logical_tool_call_id
     WHERE l.session_id = ? AND l.source_user_seq = ? AND l.logical_tool_call_id = ?
  `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as {
    logical_state: string;
    physical_state: string;
    outcome_kind: string;
    result_handle_id: string | null;
    lease_scope_id: string | null;
    lease_id: string | null;
    call_lease_n: number;
    exact_revoked_lease_n: number;
    evidence_handle_n: number;
  } | undefined;
}

test('chat and workflow reads use the same call-bound lease, physical dispatch, settlement, and evidence kernel', async () => {
  const chat = acceptedTask('chat-kernel-parity');
  const chatOwner = openRunOwner(chat, 'chat');
  let chatBodies = 0;
  const chatResult = await runHostCall({
    task: chat,
    owner: chatOwner,
    callId: 'logical.chat.parity',
    toolName: 'restaurant_records_search',
    args: { location: 'Santa Clarita, CA', limit: 1 },
    effect: 'read',
    body: async () => {
      chatBodies += 1;
      return { successful: true, data: { records: [{ id: 'restaurant.chat.1' }] } };
    },
  });
  assert.equal(chatBodies, 1);
  assert.ok(chatResult.settlement.resultHandleId);
  const chatSnapshot = callKernelSnapshot({
    sessionId: chat.sessionId,
    sourceUserSeq: chat.sourceUserSeq,
    logicalToolCallId: 'logical.chat.parity',
  });
  assert.ok(chatSnapshot);
  assert.deepEqual({
    logical_state: chatSnapshot.logical_state,
    physical_state: chatSnapshot.physical_state,
    outcome_kind: chatSnapshot.outcome_kind,
    call_lease_n: chatSnapshot.call_lease_n,
    exact_revoked_lease_n: chatSnapshot.exact_revoked_lease_n,
    evidence_handle_n: chatSnapshot.evidence_handle_n,
  }, {
    logical_state: 'settled',
    physical_state: 'returned',
    outcome_kind: 'succeeded',
    call_lease_n: 1,
    exact_revoked_lease_n: 1,
    evidence_handle_n: 1,
  });
  leases.revokeDispatchLease(chatOwner.parentLease);

  const workflow = installWorkflowReadCapability('shared-lease');
  const workflowSession = eventlog.createSession({
    id: `workflow-parity-${randomUUID()}`,
    kind: 'workflow',
  });
  const armed = workflowAuthority.armWorkflowReadOnlyCallAuthority({
    sessionId: workflowSession.id,
    workflowId: 'workflow.parity',
    workflowRevision: 1,
    workflowDigest: digest('workflow.parity'),
    runId: 'run.parity',
    runOccurrenceId: 'occurrence.parity',
    nodeId: 'node.parity',
    nodeAttempt: 1,
    invocationPlanDigest: workflow.plan.bindingDigest,
    bindingSnapshotDigest: digest('bindings.parity'),
    controlDigest: digest('control.parity'),
    logicalCallId: 'logical.workflow.parity',
  });
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;
  const workflowResult = await workflowKernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: workflow.plan,
    args: { scope: 'current' },
  });
  assert.equal(workflowResult.status, 'completed', JSON.stringify(workflowResult));
  assert.equal(workflow.providerBodies(), 1);
  const workflowSnapshot = callKernelSnapshot({
    sessionId: armed.ref.sessionId,
    sourceUserSeq: armed.ref.sourceEventSeq,
    logicalToolCallId: armed.ref.logicalCallId,
  });
  assert.ok(workflowSnapshot);
  assert.deepEqual({
    logical_state: workflowSnapshot.logical_state,
    physical_state: workflowSnapshot.physical_state,
    outcome_kind: workflowSnapshot.outcome_kind,
    call_lease_n: workflowSnapshot.call_lease_n,
    exact_revoked_lease_n: workflowSnapshot.exact_revoked_lease_n,
    evidence_handle_n: workflowSnapshot.evidence_handle_n,
  }, {
    logical_state: 'settled',
    physical_state: 'returned',
    outcome_kind: 'succeeded',
    call_lease_n: 1,
    exact_revoked_lease_n: 1,
    evidence_handle_n: 1,
  }, 'workflow activation is not a substitute: the physical crossing must name one exact revoked call lease');
});

// The five workflow crash boundaries are executable, provider-body-counted
// tests in workflow-read-only-call-kernel.test.ts. Keeping the matrix beside
// the kernel lets it use the guarded process-crash seam instead of forging
// rows in this cross-lane parity journey.

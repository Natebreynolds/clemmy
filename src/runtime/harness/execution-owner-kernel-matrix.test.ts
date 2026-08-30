/**
 * Provider-neutral execution-owner matrix.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/execution-owner-kernel-matrix.test.ts
 *
 * The same exact read is driven through the host-owned chat boundary, the
 * bracket-owned cron/background boundary, and the workflow exact-call boundary
 * (manual, scheduled, creation-test, and durable replay). Every real body must
 * have one logical call, one physical dispatch, and one logical settlement.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-execution-owner-matrix-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';

const eventlog = await import('./eventlog.js');
const graphShadow = await import('../graph/turn-graph-shadow.js');
const brackets = await import('./brackets.js');
const identities = await import('./attempt-identity.js');
const leases = await import('./dispatch-lease.js');
const callAuthority = await import('./accepted-turn-call-authority.js');
const logicalContracts = await import('./logical-call-contract.js');
const hostBindings = await import('./host-call-capability-binding.js');
const hostInvocation = await import('./host-tool-invocation.js');
const toolEffects = await import('./tool-effect.js');
const expectedWork = await import('./expected-work-contract.js');
const manifests = await import('./capability-manifest.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const observations = await import('./independent-capability-observation.js');
const ports = await import('./production-capability-ports.js');
const plans = await import('../../memory/workflow-node-invocation-plan.js');
const workflowRunner = await import('../../execution/workflow-runner.js');

import type { WorkflowDefinition, WorkflowStepInput } from '../../memory/workflow-store.js';

const OPERATION = 'workspace_artifact_query';
const ARGS = { scope: 'current' } as const;
const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

interface OwnedRows {
  logical_n: number;
  physical_n: number;
  settlement_n: number;
  logical_state: string | null;
  physical_state: string | null;
}

function ownedRows(sessionId: string): OwnedRows {
  return eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls WHERE session_id = ?) AS logical_n,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND relation != 'probe') AS physical_n,
      (SELECT COUNT(*) FROM logical_call_settlements WHERE session_id = ?) AS settlement_n,
      (SELECT state FROM logical_tool_calls WHERE session_id = ? LIMIT 1) AS logical_state,
      (SELECT state FROM physical_dispatches
        WHERE session_id = ? AND relation != 'probe' LIMIT 1) AS physical_state
  `).get(sessionId, sessionId, sessionId, sessionId, sessionId) as OwnedRows;
}

function assertOneOwnedCall(sessionId: string): void {
  assert.deepEqual(ownedRows(sessionId), {
    logical_n: 1,
    physical_n: 1,
    settlement_n: 1,
    logical_state: 'settled',
    physical_state: 'returned',
  }, sessionId);
}

function acceptedSource(
  sessionId: string,
  kind: 'execution' | 'workflow',
  label: 'cron' | 'background',
) {
  const session = eventlog.createSession({ id: sessionId, kind });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Read the current records for ${label}.` },
  });
  assert.ok(graphShadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
    surface: label,
  }));
  expectedWork.requireKnownExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
  });
  return { session, source };
}

async function runBracketOwnedRead(
  label: 'cron' | 'background',
  bodyCounter: { value: number },
): Promise<string> {
  const { session, source } = acceptedSource(`owner-matrix-${label}`, 'execution', label);
  const wrapped = brackets.wrapToolForHarness({
    name: OPERATION,
    execute: async (input: unknown) => identities.withPhysicalDispatch({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: source.turn,
      tool: OPERATION,
      args: input,
    }, async () => {
      bodyCounter.value += 1;
      return { successful: true, data: { records: [{ id: label }] } };
    }),
  });
  const output = await brackets.withHarnessRunContext({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    behaviorScopeId: `${session.id}::turn`,
    counter: new brackets.ToolCallsCounter(4),
  }, () => wrapped.execute!({ ...ARGS }));
  assert.deepEqual(output, { successful: true, data: { records: [{ id: label }] } });
  return session.id;
}

async function runHostOwnedRead(
  bodyCounter: { value: number },
  capability: ReturnType<typeof installWorkflowRead>,
): Promise<string> {
  const session = eventlog.createSession({ id: 'owner-matrix-chat-host', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read the current records in chat.' },
  });
  const armed = callAuthority.armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest: digest('owner-matrix-host-catalog'),
    bindingRevisionDigest: digest('owner-matrix-host-binding'),
    maxLogicalCalls: 4,
    maxParallelCalls: 2,
  });
  assert.equal(armed.status, 'armed');
  const parentLease = leases.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::host-parent`,
  });
  const acceptedTaskId = identities.acceptedTaskIdFor(session.id, source.seq);
  const root = callAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = logicalContracts.durableLogicalCallContract(acceptedTaskId, OPERATION, ARGS);
  assert.ok(contract);
  if (!contract) throw new Error('host fixture could not freeze the logical call');
  const callId = 'owner-matrix-host-call';
  const attestationBase = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: callId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: 'read' as const,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: capability.identity.capabilityId,
    schemaFingerprint: capability.identity.schemaDigest,
    accountId: capability.identity.account,
    invokePortId: capability.identity.invokePortId,
    operationId: capability.identity.operationId,
    manifestId: capability.identity.manifestId,
    manifestDigest: capability.identity.manifestDigest,
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest!,
  };
  const attestation = {
    ...attestationBase,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(attestationBase),
  };
  const context: brackets.HarnessRunContext = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    counter: new brackets.ToolCallsCounter(4),
    dispatchLease: parentLease,
  };
  const result = await callAuthority.withHostCallAttestation(attestation, () =>
    brackets.withHarnessRunContext(context, () => hostInvocation.invokeHostToolCall({
      identity: {
        sessionId: session.id,
        sourceUserSeq: source.seq,
        modelCallId: callId,
        toolName: OPERATION,
        args: ARGS,
        turn: source.turn,
      },
      parentLease,
      effect: 'read',
      boundary: 'host_owned_external',
      deadlineMs: 1_000,
      trustedEffectCarrier: toolEffects.trustedRuntimeEffectCarrier(OPERATION, ARGS),
      invoke: async () => {
        bodyCounter.value += 1;
        return { successful: true, data: { records: [{ id: 'chat-host' }] } };
      },
    })),
  );
  assert.deepEqual(result.value, { successful: true, data: { records: [{ id: 'chat-host' }] } });
  assert.equal(result.settlement.outcome.kind, 'succeeded');
  return session.id;
}

function installWorkflowRead() {
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: 'manifest.owner-matrix-read',
    providerKind: 'local_registry',
    operationId: OPERATION,
    providerIdentity: 'runtime.owner-matrix',
    providerVersion: 'runtime.1',
    operationVersion: '1',
    definitionFingerprint: digest('owner-matrix-workflow-schema'),
    effect: 'read',
    accountId: 'account.owner-matrix',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'read_bounded_records',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'owner-matrix.test', issuedAt: '2026-08-27T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
  let portBodies = 0;
  let directCatalogBodies = 0;
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      invoke: async () => {
        portBodies += 1;
        return { successful: true, data: { records: [{ id: 'workflow' }] } };
      },
    },
  ).ok, true);
  const entry: catalogs.RegisteredHostCapability = {
    capabilityId: manifest.manifestId,
    toolName: OPERATION,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => {
      directCatalogBodies += 1;
      throw new Error('catalog callback is not an execution owner');
    },
  };
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([entry]));
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
  if (!identity) throw new Error('workflow fixture has no canonical capability identity');
  const plan = plans.createWorkflowNodeInvocationPlan({
    requirementId: 'requirement.owner-matrix-read',
    logicalCapabilityId: 'logical.owner-matrix-read',
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
      scope: { source: { kind: 'workflow_input', key: 'scope' }, required: true, type: 'string' },
    },
    evidence: {
      requiredPaths: ['data.records'],
      nonEmptyPaths: ['data.records'],
      minItems: { 'data.records': 1 },
    },
    completeness: { kind: 'terminal_result', evidencePaths: ['data.records'] },
    continuation: { kind: 'none' },
  });
  const step: WorkflowStepInput = {
    id: 'read_records',
    prompt: '',
    sideEffect: 'read',
    call: { tool: OPERATION, args: { scope: '{{input.scope}}' } },
    invocationPlan: plan,
  };
  const workflow: WorkflowDefinition = {
    name: 'owner-matrix-workflow',
    description: 'Provider-neutral owner matrix.',
    enabled: true,
    trigger: { manual: true },
    inputs: { scope: { type: 'string', required: true } },
    steps: [step],
  };
  return {
    workflow,
    step,
    identity,
    portBodies: () => portBodies,
    directCatalogBodies: () => directCatalogBodies,
  };
}

function workflowContext(
  installed: ReturnType<typeof installWorkflowRead>,
  runId: string,
) {
  return {
    workflow: installed.workflow,
    workflowSlug: installed.workflow.name,
    runId,
    inputs: { scope: ARGS.scope },
    stepOutputs: {},
    assistant: new Proxy({}, { get: () => { throw new Error('model/raw fallback was consulted'); } }),
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof workflowRunner.executeStep>[1];
}

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('chat, workflow, cron, background, creation-test, and resume share one business-call settlement kernel', async () => {
  const hostBodies = { value: 0 };
  const bracketBodies = { value: 0 };
  const sessionIds: string[] = [];
  const installed = installWorkflowRead();

  sessionIds.push(await runHostOwnedRead(hostBodies, installed));
  sessionIds.push(await runBracketOwnedRead('cron', bracketBodies));
  sessionIds.push(await runBracketOwnedRead('background', bracketBodies));

  for (const runId of ['owner-matrix-manual', 'owner-matrix-scheduled']) {
    const output = await workflowRunner.executeStep(
      installed.step,
      workflowContext(installed, runId),
    );
    assert.deepEqual(output, { successful: true, data: { records: [{ id: 'workflow' }] } });
    sessionIds.push(`workflow:${runId}:${installed.step.id}`);
  }

  const creation = await workflowRunner.runCreationTest(
    installed.workflow,
    installed.workflow.name,
    'owner-matrix-creation-test',
    { scope: ARGS.scope },
    new Proxy({}, { get: () => { throw new Error('model/raw fallback was consulted'); } }) as never,
  );
  assert.equal(creation.pass, true, JSON.stringify(creation));
  sessionIds.push(`workflow:owner-matrix-creation-test:${installed.step.id}`);

  const resumeContext = workflowContext(installed, 'owner-matrix-resume');
  const beforeResume = await workflowRunner.executeStep(installed.step, resumeContext);
  assert.deepEqual(beforeResume, { successful: true, data: { records: [{ id: 'workflow' }] } });
  const bodiesBeforeReplay = installed.portBodies();
  eventlog.closeEventLog();
  const afterResume = await workflowRunner.executeStep(installed.step, resumeContext);
  assert.deepEqual(afterResume, beforeResume);
  assert.equal(installed.portBodies(), bodiesBeforeReplay, 'durable resume replays without a second provider body');
  sessionIds.push(`workflow:owner-matrix-resume:${installed.step.id}`);

  assert.equal(hostBodies.value, 1);
  assert.equal(bracketBodies.value, 2);
  assert.equal(installed.portBodies(), 4, 'manual, scheduled, creation-test, and the pre-resume occurrence cross once each');
  assert.equal(installed.directCatalogBodies(), 0, 'the advisory catalog callback never becomes a provider executor');
  for (const sessionId of sessionIds) assertOneOwnedCall(sessionId);

  const placeholders = sessionIds.map(() => '?').join(', ');
  const joined = eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n
      FROM logical_tool_calls logical
      JOIN physical_dispatches physical
        ON physical.session_id = logical.session_id
       AND physical.source_user_seq = logical.source_user_seq
       AND physical.logical_tool_call_id = logical.logical_tool_call_id
       AND physical.relation != 'probe'
      JOIN logical_call_settlements settlement
        ON settlement.session_id = logical.session_id
       AND settlement.source_user_seq = logical.source_user_seq
       AND settlement.logical_tool_call_id = logical.logical_tool_call_id
     WHERE logical.session_id IN (${placeholders})
  `).get(...sessionIds) as { n: number };
  assert.equal(joined.n, sessionIds.length, 'every business body is joined across all three canonical tables');
});

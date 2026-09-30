import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import type { AcceptedModelBatchRef } from './accepted-model-batch-checkpoint.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-accepted-model-batch-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-accepted-model-batch\n', 'utf8');

const eventlog = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const checkpoints = await import('./accepted-model-batch-checkpoint.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./logical-call-contract.js');
const hostBindings = await import('./host-call-capability-binding.js');
const leases = await import('./dispatch-lease.js');
const brackets = await import('./brackets.js');
const invocation = await import('./host-tool-invocation.js');
const observations = await import('./tool-invocation-observation-context.js');
const protocol = await import('./conversation-protocol.js');
const protocolSession = await import('./conversation-protocol-session.js');
const hostResults = await import('./host-model-result-receipt.js');
const logicalResults = await import('./logical-model-result-projection-receipt.js');
const connectionCheckpoints = await import('./source-connection-checkpoints.js');
const plans = await import('./plan-artifacts.js');
const sessionStore = await import('./session.js');
const agentEnvelopes = await import('../../agents/capability-envelope.js');
const agentRebuild = await import('../../agents/agent-rebuild-context.js');
const mcpAuthority = await import('../mcp-tool-authority.js');
const sessionContext = await import('./source-session-context.js');
const sessionContextScope = await import('./source-session-context-scope.js');
const { rebuildSourceConnectionAgent } = await import('./connection-agent-rebuild.js');
const hostProgress = await import('./host-connection-progress.js');
const { readSourceConnectionHostRecovery } = await import('./connection-host-recovery.js');
const noProgress = await import('./no-progress-governor.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
let serial = 0;

function fixture(text: string, mode: 'normal' | 'plan' | 'execute' = 'normal') {
  const session = eventlog.createSession({ id: `accepted-model-batch-${++serial}`, kind: 'chat', userId: 'checkpoint-owner' });
  let executeRef: import('./task-mode.js').PlanRevisionRef | undefined;
  if (mode === 'execute') {
    const planSource = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
      data: { text: 'Prepare the controlled task.', taskMode: { version: 1, kind: 'plan' } } });
    const artifact = plans.publishPlanRevision({ sessionId: session.id, principalId: 'checkpoint-owner',
      sourceUserSeq: planSource.seq, fullText: text, readiness: 'ready' });
    executeRef = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  }
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text, ...(mode !== 'normal' ? { taskMode: { version: 1, kind: mode, ...(executeRef ? { executeRef } : {}) } } : {}) },
  });
  if (executeRef) plans.claimPlanExecution({ sessionId: session.id, principalId: 'checkpoint-owner',
    sourceUserSeq: source.seq, executeRef });
  const armed = authority.armHostCallAuthority({
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
    text,
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

type Fixture = ReturnType<typeof fixture>;

function connectionAgent(task: Fixture, mcpToolScope: import('../mcp-tool-scope.js').McpToolScope | null = {
  reason: 'original controlled task scope', authority: 'catalog', deniedServerSlugs: ['fixture-private'], maxTools: 2,
}, acceptedRoute?: import('../../agents/agent-rebuild-context.js').AgentRebuildContext['acceptedRoute']) {
  const agent = { model: 'fixture-original-brain', privateProviderState: 'must-not-be-saved', instructions: 'private agent instructions' };
  const sealed = agentEnvelopes.sealAgentCapabilityUniverse({ sessionId: task.sessionId,
    universeTools: [{ name: 'tool_search', description: 'Search controlled capability metadata', parameters: { type: 'object' } }],
    activeToolNames: ['tool_search'], policyHash: 'fixture-policy',
    budget: { maxUncachedTokens: 1000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 30000 } });
  assert.ok(sealed.ok);
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  agentEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  agentEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  agentRebuild.bindAgentRebuildContext(agent, { excludeToolNames: ['run_shell_command'], allowToolJit: true, acceptedRoute });
  mcpAuthority.bindAgentMcpToolScope(agent, mcpToolScope);
  sessionContextScope.withSourceSessionContext(sessionContext.captureFreshSourceSessionContext(task)!, () =>
    sessionContextScope.bindAgentSourceSessionContext(agent, task.sessionId));
  return agent;
}

function preHistory(task: Fixture): AgentInputItem[] {
  return [{ role: 'user', content: task.text } as AgentInputItem];
}

function openFrame(input: {
  callId: string;
  toolName: string;
  args: unknown;
}): AgentInputItem[] {
  return [{
    type: 'function_call',
    callId: input.callId,
    name: input.toolName,
    arguments: JSON.stringify(input.args),
    status: 'completed',
  } as AgentInputItem];
}

function productionAttestation(input: {
  task: Fixture;
  callId: string;
  toolName: string;
  args: unknown;
  effect: authority.HostCallAttestation['effect'];
  localEnvelope?: boolean;
}): authority.HostCallAttestation {
  const root = authority.acceptedTurnCallAuthorityFor(
    input.task.sessionId,
    input.task.sourceUserSeq,
  );
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error(root.reason);
  const contract = contracts.durableLogicalCallContract(
    input.task.acceptedTaskId,
    input.toolName,
    input.args,
  );
  assert.ok(contract);
  if (!contract) throw new Error('fixture contract is unsafe');
  const base = {
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    acceptedTaskId: input.task.acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: input.callId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: input.effect,
    bindingKind: input.localEnvelope ? 'local_envelope' as const : 'catalog_manifest' as const,
    capabilityId: `cap:${contract.toolName}`,
    schemaFingerprint: digest(`schema:${contract.toolName}`),
    accountId: input.localEnvelope ? '' : 'conn-checkpoint-fixture',
    invokePortId: 'fixture:execute',
    operationId: contract.toolName.toUpperCase(),
    manifestId: input.localEnvelope ? '' : `manifest:${contract.toolName}`,
    manifestDigest: input.localEnvelope ? '' : digest(`manifest:${contract.toolName}`),
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest!,
  };
  return {
    ...base,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(base),
  };
}

function runCall<T>(input: {
  task: Fixture;
  callId: string;
  toolName: string;
  args: unknown;
  effect: authority.HostCallAttestation['effect'];
  localEnvelope?: boolean;
  businessCall?: boolean;
  boundary?: 'host_owned_local' | 'host_owned_external';
  deadlineMs?: number;
  invoke: () => Promise<T>;
}) {
  const attestation = productionAttestation(input);
  return authority.withHostCallAttestation(attestation, () =>
    brackets.withHarnessRunContext(input.task.context, () => invocation.invokeHostToolCall({
      identity: {
        sessionId: input.task.sessionId,
        sourceUserSeq: input.task.sourceUserSeq,
        modelCallId: input.callId,
        toolName: input.toolName,
        args: input.args,
        turn: 1,
      },
      parentLease: input.task.parentLease,
      effect: input.effect,
      ...(input.businessCall === undefined ? {} : { businessCall: input.businessCall }),
      boundary: input.boundary ?? 'host_owned_external',
      deadlineMs: input.deadlineMs ?? 200,
      invoke: input.invoke,
    }))) as Promise<invocation.HostToolInvocationResult<T>>;
}

function physicalRows(task: Fixture, callId: string): Array<{
  physical_dispatch_id: string;
  state: string;
}> {
  return eventlog.openEventLog().prepare(`
    SELECT physical_dispatch_id, state
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
     ORDER BY ordinal
  `).all(task.sessionId, task.sourceUserSeq, callId) as Array<{
    physical_dispatch_id: string;
    state: string;
  }>;
}

function resultText(history: readonly AgentInputItem[], callId: string): string | undefined {
  for (const item of history) {
    const record = item as unknown as Record<string, unknown>;
    if (record.type !== 'function_call_result' || record.callId !== callId) continue;
    const output = record.output as Record<string, unknown> | undefined;
    if (output?.type === 'text' && typeof output.text === 'string') return output.text;
  }
  return undefined;
}

function exactSettledResult(input: {
  task: Fixture;
  callId: string;
  history: readonly AgentInputItem[];
}): AgentInputItem {
  const evidence = protocolSession.durableConversationProtocolEvidenceForCall({
    sessionId: input.task.sessionId,
    history: input.history,
    callId: input.callId,
  });
  assert.equal(evidence?.kind, 'settled_result');
  if (!evidence || evidence.kind !== 'settled_result') {
    throw new Error('fixture has no exact settled model result');
  }
  return evidence.result;
}

function recordLogicalResult(
  admission: AcceptedModelBatchRef,
  resultItem: AgentInputItem,
): void {
  const recorded = logicalResults.recordLogicalModelResultProjectionReceipt({
    admission,
    resultItem,
  });
  assert.ok(
    recorded.status === 'recorded' || recorded.status === 'existing',
    `logical projection receipt was ${recorded.status}`,
  );
}

function projectedTextResult(input: {
  callId: string;
  toolName: string;
  value: unknown;
}): AgentInputItem {
  return {
    type: 'function_call_result',
    callId: input.callId,
    name: input.toolName,
    output: {
      type: 'text',
      text: typeof input.value === 'string'
        ? input.value
        : JSON.stringify(input.value),
    },
    status: 'completed',
  } as AgentInputItem;
}

function connectionSearchEvidence(task: Fixture, callId = 'call:connection-search') {
  const value = { query: 'controlled CRM read', role_key: 'source', results: [],
    brokerCoverage: 'authorized_external_v1', unavailable: [{ source: 'authorized_composio', code: 'no_connections',
      reason: 'The fixture account is disconnected.', dependencySubject: {
        version: 1, kind: 'exact_capability_connection', source: 'authorized_composio',
        query: 'controlled CRM read', roleKey: 'source', toolkit: 'fixturecrm',
        capability: 'FIXTURECRM_READ', capabilityRef: 'cap:resolved:fixturecrm_read',
      } }] };
  const output = JSON.stringify(value);
  eventlog.writeToolOutput({ sessionId: task.sessionId, callId, tool: 'tool_search', output });
  eventlog.appendEvent({ sessionId: task.sessionId, turn: 1, role: 'Clem', type: 'tool_returned',
    data: { sourceUserSeq: task.sourceUserSeq, tool: 'tool_search', callId, accounting: 'top_level', topologyRole: 'control', result: output } });
  return value;
}

async function settledConnectionBatch(task: Fixture) {
  const frame = { callId: 'call:connection-search', toolName: 'tool_search', args: { query: 'controlled CRM read' } };
  const prior = checkpoints.prepareAcceptedModelBatchRestart(task);
  const history = prior.status === 'ready' ? prior.checkpoint.history : preHistory(task);
  const admitted = checkpoints.admitAcceptedModelBatch({ sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
    preHistory: history, frameHistory: openFrame(frame),
    ...(prior.status === 'ready' ? { previousResponseId: prior.checkpoint.lastResponseId } : {}),
    providerResponseId: 'response:connection-search' });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);
  const value = connectionSearchEvidence(task, frame.callId);
  await runCall({ task, ...frame, effect: 'read', boundary: 'host_owned_local', localEnvelope: true, invoke: async () => value });
  const resultItem = exactSettledResult({ task, callId: frame.callId, history: [...history, ...openFrame(frame)] });
  recordLogicalResult(admitted.admission, resultItem);
  const final = checkpoints.finalizeAcceptedModelBatch(admitted.admission, { committedResultItems: [resultItem] });
  assert.ok(final.status === 'committed' || final.status === 'existing');
  return final.checkpoint;
}

for (const shape of ['ask', 'decision'] as const) test(`connection pause after fallback retains the actual executing agent (${shape})`, async () => {
  const task = fixture('Inspect the controlled CRM after connection.', 'execute');
  await settledConnectionBatch(task);
  const original = connectionAgent(task, undefined, 'act');
  const replacement = connectionAgent(task, null, 'retrieve');
  replacement.model = 'fixture-fallback-brain';
  const { runConversation } = await import('./loop.js');
  const { BoundaryError } = await import('../boundary-error.js');
  let runs = 0;
  let rebuilds = 0;
  const result = await runConversation({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, input: task.text,
    reuseRecordedUserInput: true, agent: original as never, judgeCompletion: false,
    suppressMemoryCapture: true, suppressAutomaticMemoryForRequest: true, maxSteps: 2,
    makeRunner: () => new EventEmitter() as never,
    runRunner: async (_runner, active, items) => {
      runs += 1;
      if (active === original) throw BoundaryError.from(new Error('Controlled transient model failure.'), {
        kind: 'model.overloaded', retryable: true, userMessage: 'Controlled transient failure.',
      });
      assert.equal(active, replacement);
      return { history: items, lastResponseId: undefined, finalOutput: shape === 'ask'
        ? 'ASK: Connect the fixture CRM to continue.'
        : { summary: 'Connect the fixture CRM to continue.', reply: 'Connect the fixture CRM to continue.',
          done: false, nextAction: 'awaiting_user_input', reason: null } } as never;
    },
    falloverModelIds: ['fixture-fallback-brain'],
    rebuildAgentForBrain: async () => { rebuilds += 1; return replacement as never; },
  });
  assert.equal(result.status, 'awaiting_user_input', JSON.stringify(result));
  assert.equal(runs, 2);
  assert.equal(rebuilds, 1);
  const { currentConnectionDependency } = await import('./dependency-request.js');
  const dependency = currentConnectionDependency(task.sessionId);
  assert.ok(dependency);
  const retained = connectionCheckpoints.readSourceConnectionCheckpoint({ sessionId: task.sessionId, requestId: dependency.requestId });
  assert.equal(retained?.agent?.modelId, replacement.model, 'original model must not replace the actual fallback at pause');
  assert.equal(retained.agent.mcpToolScope, null);
  assert.equal(retained.agent.rebuildContext.acceptedRoute, 'retrieve');
  leases.revokeDispatchLease(task.parentLease);
});

function recordedHostProgress(task: Fixture, batch: import('./accepted-model-batch-checkpoint.js').AcceptedModelBatchCheckpoint): import('./host-connection-progress.js').HostConnectionProgress {
  const initial = noProgress.initializeNoProgressGovernor({
    taskKey: batch.acceptedTaskId, authority: { operation: [], account: [], target: [], evidence: [], effect: [] },
  });
  const spent = noProgress.observeNoProgress(initial, {
    taskKey: initial.taskKey, attemptClass: 'dependency_lookup', authority: initial.authority,
  }).state;
  return {
    version: 1,
    batch: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, acceptedTaskId: batch.acceptedTaskId,
      authorityDigest: batch.authorityDigest, batchOrdinal: batch.batchOrdinal, batchId: batch.batchId },
    recovery: { turnEngine: 'host_v1', stepIndex: 3, objectiveJudgeContinuations: 1,
      noProgressCheckpoint: { state: spent, historyCursor: batch.history.length, recoveryOnly: true, recoveryDirectiveWritten: true },
      completionReviewFeedback: { version: 1, sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
        objective: 'Inspect the original account', objectiveDigest: digest('Inspect the original account'),
        reply: 'Draft before the connection pause', replyDigest: digest('Draft before the connection pause'), reason: 'Read the missing evidence.' } },
    activation: { maxTurns: 3, toolCalls: { used: 2, limit: 4 }, elapsedMs: 3210, judgeCompletion: true },
    continuations: { acceptedReadPlanUsed: true, acceptedUniqueWorkflowUsed: false, workflowStepResultUsed: 1,
      continueMarkerUsed: 1, planFinalPublishSpent: false, modelStallRetriesRemaining: 0, judgedBusinessCallsAtLastVerdict: 2 },
    watcher: { checksUsed: 2, injectionsUsed: 1, deliveredSteers: 1, unresolvedDrift: true,
      lastCheckedAt: 2, lastFailureSeq: 7, checkInFlight: true },
  };
}

test('connection progress survives reopen with spent judge, retry and step allowances and original evidence', async () => {
  const task = fixture('Inspect the controlled account after connection.', 'execute');
  const batch = await settledConnectionBatch(task);
  const agent = connectionAgent(task);
  const progress = recordedHostProgress(task, batch);
  hostProgress.bindHostConnectionProgress(agent, progress);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent })!;
  const identity = { sessionId: task.sessionId, requestId: pause.requestId };
  // Neither mutation of the caller-owned object nor reuse/clear of the agent
  // may replenish an already-persisted request's counters.
  progress.recovery.objectiveJudgeContinuations = 0;
  hostProgress.clearHostConnectionProgress(agent);
  eventlog.closeEventLog();
  const reopened = readSourceConnectionHostRecovery(identity);
  assert.equal(reopened.hostState.objectiveJudgeContinuations, 1);
  assert.equal(reopened.hostState.stepIndex, reopened.progress.activation.maxTurns, 'an exhausted budget must remain exhausted');
  assert.equal(reopened.hostState.noProgressCheckpoint?.state.retriesRemaining, noProgress.NO_PROGRESS_RETRY_BUDGET - 1);
  assert.equal(reopened.hostState.noProgressCheckpoint?.historyCursor, batch.history.length);
  assert.deepEqual(reopened.hostState.history, batch.history);
  assert.equal(reopened.progress.continuations.modelStallRetriesRemaining, 0);
  assert.equal(reopened.progress.watcher.checkInFlight, true, 'unfinished review must not become a passed review');
  assert.equal(reopened.progress.activation.elapsedMs, 3210);
  assert.equal(reopened.hostState.completionReviewFeedback?.sourceUserSeq, task.sourceUserSeq);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['approval_requested'] }).length, 0);
  assert.equal(physicalRows(task, 'call:connection-search').length, 1);
  leases.revokeDispatchLease(task.parentLease);
});

for (const corruption of ['cursor', 'feedback-source', 'missing-progress'] as const) {
  test(`connection restore refuses ${corruption} instead of inventing fresh progress`, async () => {
    const task = fixture('Inspect the controlled account after connection.', 'execute');
    const batch = await settledConnectionBatch(task);
    const agent = connectionAgent(task);
    const progress = recordedHostProgress(task, batch);
    if (corruption === 'cursor') progress.recovery.noProgressCheckpoint!.historyCursor = batch.history.length + 1;
    if (corruption === 'feedback-source') progress.recovery.completionReviewFeedback!.sourceUserSeq += 1;
    if (corruption !== 'missing-progress') hostProgress.bindHostConnectionProgress(agent, progress);
    const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent })!;
    assert.throws(() => readSourceConnectionHostRecovery({ sessionId: task.sessionId, requestId: pause.requestId }),
      corruption === 'cursor' ? /invalid no-progress checkpoint/ : corruption === 'feedback-source'
        ? /review belongs to another/ : /no retained host progress/);
    assert.equal(physicalRows(task, 'call:connection-search').length, 1);
    leases.revokeDispatchLease(task.parentLease);
  });
}

test('an advanced canonical chain cannot borrow an older connection budget snapshot', async () => {
  const task = fixture('Inspect the controlled account after connection.', 'execute');
  const batch = await settledConnectionBatch(task);
  const agent = connectionAgent(task);
  hostProgress.bindHostConnectionProgress(agent, recordedHostProgress(task, batch));
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent })!;
  const extra = { callId: 'call:after-pause-inspection', toolName: 'tool_search', args: { query: 'extra inspection' } };
  const admitted = checkpoints.admitAcceptedModelBatch({ ...task, preHistory: batch.history,
    previousResponseId: batch.lastResponseId, frameHistory: openFrame(extra), providerResponseId: 'response:after-pause' });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);
  await runCall({ task, ...extra, effect: 'read', boundary: 'host_owned_local', localEnvelope: true,
    invoke: async () => ({ ok: true, rows: [] }) });
  const result = exactSettledResult({ task, callId: extra.callId, history: [...batch.history, ...openFrame(extra)] });
  recordLogicalResult(admitted.admission, result);
  assert.ok(['committed', 'existing'].includes(checkpoints.finalizeAcceptedModelBatch(admitted.admission, { committedResultItems: [result] }).status));
  const retained = connectionCheckpoints.readSourceConnectionCheckpoint({ sessionId: task.sessionId, requestId: pause.requestId })!;
  assert.equal(checkpoints.recoverAcceptedModelBatchFromToken(retained.restartToken).status, 'ready', 'ordinary restart still accepts a proven descendant');
  assert.throws(() => readSourceConnectionHostRecovery({ sessionId: task.sessionId, requestId: pause.requestId }), /advanced beyond retained progress/);
  leases.revokeDispatchLease(task.parentLease);
});

test('reviewed connection pause retains the exact batch across ASK, reopen and newer chat without replaying a settled write', async () => {
  const task = fixture('Create the fixture artifact once, then inspect the controlled CRM.', 'execute');
  const write = { callId: 'call:connection-prior-write', toolName: 'space_publish', args: { title: 'Checkpoint fixture' } };
  const admitted = checkpoints.admitAcceptedModelBatch({ ...task, preHistory: preHistory(task),
    frameHistory: openFrame(write), providerResponseId: 'response:connection-prior-write' });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);
  let writes = 0;
  const payload = { ok: true, id: 'fixture-artifact' };
  await runCall({ task, ...write, effect: 'external_write', invoke: async () => { writes += 1; return payload; } });
  const written = exactSettledResult({ task, callId: write.callId, history: [...preHistory(task), ...openFrame(write)] });
  recordLogicalResult(admitted.admission, written);
  assert.ok(['committed', 'existing'].includes(checkpoints.finalizeAcceptedModelBatch(admitted.admission,
    { committedResultItems: [written] }).status));
  const canonical = await settledConnectionBatch(task);
  const withQuestion = [...canonical.history, { role: 'assistant', content: 'ASK: Please connect the fixture CRM.' } as AgentInputItem];
  sessionStore.HarnessSession.load(task.sessionId)!.recordTurnResult({ history: withQuestion, turn: 1 });

  // Both ordinary ASK projection and an explicit awaiting-input terminal park
  // through this production seam, after their public question is determined.
  const agent = connectionAgent(task);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent });
  assert.ok(pause);
  const identity = { sessionId: task.sessionId, requestId: pause.requestId };
  const retained = connectionCheckpoints.readSourceConnectionCheckpoint(identity)!;
  assert.ok(retained);
  assert.equal(retained.restartToken.resumeFromHistoryDigest, canonical.historyDigest);
  assert.equal(retained.restartToken.resumeFromBatchId, canonical.batchId);
  assert.equal(retained.sourceUserSeq, task.sourceUserSeq);
  assert.equal('history' in retained, false, 'retain a cursor, never a second full prompt');
  assert.equal(JSON.stringify(retained).includes('ASK:'), false);
  assert.equal(retained.agent?.modelId, 'fixture-original-brain');
  assert.deepEqual(retained.agent?.rebuildContext, { excludeToolNames: ['run_shell_command'], allowToolJit: true });
  assert.deepEqual(retained.agent?.mcpToolScope?.deniedServerSlugs, ['fixture-private']);
  assert.deepEqual(retained.agent?.bindingRevision?.bound, ['tool_search']);
  assert.equal(retained.agent?.envelope.envelopeDigest, agentEnvelopes.boundAgentCapabilityEnvelope(agent)?.envelopeDigest);
  assert.equal(JSON.stringify(retained).includes('must-not-be-saved'), false);
  assert.equal(JSON.stringify(retained).includes('private agent instructions'), false);
  agent.model = 'fixture-different-brain';
  mcpAuthority.bindAgentMcpToolScope(agent, { reason: 'later unrelated scope', authority: 'catalog', allowAll: true });
  agentRebuild.bindAgentRebuildContext(agent, { allowToolJit: false });
  assert.deepEqual(connectionCheckpoints.readSourceConnectionCheckpoint(identity), retained,
    'later mutations or builds cannot alter retained construction context');
  assert.deepEqual(connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 }), pause);
  assert.throws(() => eventlog.openEventLog().prepare('UPDATE source_connection_checkpoints_v1 SET checkpoint_json = ? WHERE request_id = ?')
    .run('{}', pause.requestId), /immutable/);
  assert.equal(connectionCheckpoints.readSourceConnectionCheckpoint({ ...identity, sessionId: 'wrong-session' }), null);

  eventlog.closeEventLog();
  sessionStore.HarnessSession.load(task.sessionId)!.recordTurnResult({ history: [{ role: 'user', content: 'A different conversation.' } as AgentInputItem], turn: 2 });
  eventlog.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Work on something else.' } });
  assert.deepEqual(connectionCheckpoints.readSourceConnectionCheckpoint(identity), retained);
  const reopened = checkpoints.recoverAcceptedModelBatchFromToken(retained.restartToken);
  assert.equal(reopened.status, 'ready');
  if (reopened.status !== 'ready') throw new Error(reopened.reason);
  assert.deepEqual(reopened.checkpoint.history, canonical.history);
  assert.equal((await import('./dependency-request.js')).currentConnectionDependency(task.sessionId, pause.requestId), null,
    'retained context does not make a superseded task eligible to resume');

  const replay = await runCall({ task, ...write, effect: 'external_write', invoke: async () => { writes += 1; return payload; } });
  assert.equal(replay.settlement.duplicate, true);
  assert.equal(writes, 1);
  assert.equal(physicalRows(task, write.callId).length, 1);
  const nextFrame = openFrame({ callId: 'call:after-connection', toolName: 'records_read', args: {} });
  const wrong = checkpoints.admitAcceptedModelBatch({ ...task, preHistory: withQuestion, frameHistory: nextFrame,
    previousResponseId: canonical.lastResponseId, providerResponseId: 'response:wrong-history' });
  assert.equal(wrong.status, 'unavailable', 'the database chain constraint rejects the appended ASK frame');
  if (wrong.status === 'unavailable') assert.match(wrong.reason, /chain|checkpoint/i);
  const next = checkpoints.admitAcceptedModelBatch({ ...task, preHistory: reopened.checkpoint.history, frameHistory: nextFrame,
    previousResponseId: reopened.checkpoint.lastResponseId, providerResponseId: 'response:valid-chain' });
  assert.equal(next.status, 'admitted');
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM reviewed_plan_execution_claims_v1 WHERE session_id = ?')
    .get(task.sessionId) as { n: number }).n, 1);
  eventlog.openEventLog().prepare('UPDATE dependency_requests SET subject_capability = ? WHERE request_id = ?')
    .run('FIXTURECRM_DIFFERENT', pause.requestId);
  assert.throws(() => connectionCheckpoints.readSourceConnectionCheckpoint(identity), /lost its reviewed execution owner/);
  assert.equal(connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 })?.requestId, pause.requestId,
    'invalid retained context cannot abort the public connection pause');
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['connection_execution_checkpoint_unavailable'] })[0]?.data.reason,
    'checkpoint_context_inconsistent');
  leases.revokeDispatchLease(task.parentLease);
});

test('a reviewed connection checkpoint preserves explicit MCP denial and never serializes an opaque model', async () => {
  const task = fixture('Inspect controlled connection metadata with no external MCP permission.', 'execute');
  await settledConnectionBatch(task);
  const agent = connectionAgent(task, null);
  Object.assign(agent, { model: { getResponse: () => { throw new Error('No model calls allowed.'); }, key: 'do-not-retain-provider-object' } });
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent });
  assert.ok(pause);
  const retained = connectionCheckpoints.readSourceConnectionCheckpoint({ sessionId: task.sessionId, requestId: pause.requestId });
  assert.ok(retained?.agent);
  assert.equal(retained.agent.mcpToolScope, null);
  assert.equal(Object.hasOwn(retained.agent, 'modelId'), false);
  assert.equal(JSON.stringify(retained).includes('do-not-retain-provider-object'), false);
  leases.revokeDispatchLease(task.parentLease);
});

test('agent-shaped public fields cannot manufacture private retained connection scope', async () => {
  const task = fixture('Read the controlled CRM once connected.', 'execute');
  await settledConnectionBatch(task);
  const agent = { model: 'pretend-model', mcpToolScope: { authority: 'catalog', allowAll: true },
    envelope: { envelopeDigest: 'pretend-envelope' }, rebuildContext: { allowToolJit: true } };
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent });
  assert.ok(pause);
  const retained = connectionCheckpoints.readSourceConnectionCheckpoint({ sessionId: task.sessionId, requestId: pause.requestId });
  assert.ok(retained);
  assert.equal(retained.agent, undefined, 'missing private bindings remain unknown, not unrestricted');
  await assert.rejects(rebuildSourceConnectionAgent({ sessionId: task.sessionId, requestId: pause.requestId,
    assertOwned: () => {} }, {
    prime: async () => { throw new Error('Missing context must stop before catalog construction.'); },
    revalidate: async () => { throw new Error('Missing context must stop before review.'); },
    build: async () => { throw new Error('Missing context must not build a default agent.'); },
  }), /no retained tool context and replayable model identity/);
  leases.revokeDispatchLease(task.parentLease);
});

for (const denyExternal of [false, true]) for (const route of [undefined, 'act'] as const)
  test(`connection rebuild restores original model and restrictions (external denial=${denyExternal}, route=${route})`, async () => {
  const task = fixture('Inspect the controlled CRM after restoring its exact reviewed connection.', 'execute');
  await settledConnectionBatch(task);
  const agent = connectionAgent(task, denyExternal ? null : undefined, route);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent });
  assert.ok(pause);
  const identity = { sessionId: task.sessionId, requestId: pause.requestId };
  const retained = connectionCheckpoints.readSourceConnectionCheckpoint(identity)!;
  assert.ok(retained.agent);
  eventlog.closeEventLog();
  const order: string[] = [];
  const planning = { fixture: 'fresh original-source planning' } as never;
  const rebuilt = await rebuildSourceConnectionAgent({ ...identity, assertOwned: () => { order.push('owner'); } }, {
    prime: async input => {
      assert.deepEqual(input, { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq });
      order.push('prime'); return { ok: true, planning } as never;
    },
    revalidate: async input => { assert.equal(input, planning); order.push('revalidate'); },
    build: async options => {
      order.push('build');
      assert.equal(options.sourceUserSeq, task.sourceUserSeq);
      assert.equal(options.model, 'fixture-original-brain');
      assert.equal(options.allowToolJit, true);
      assert.equal(options.acceptedRoute, route);
      assert.deepEqual(options.excludeToolNames, ['run_shell_command']);
      assert.match(options.userInput!, /Execute reviewed|explicitly selected Execute/);
      assert.equal(options.hostFreshPlanning, planning);
      if (denyExternal) assert.equal(options.mcpToolScope?.authority, 'none');
      else assert.deepEqual(options.mcpToolScope, retained.agent!.mcpToolScope);
      // The current builder must seal its own output. Copying the old envelope
      // in the production rebuild helper would make the drift test below pass.
      const result = connectionAgent(task, options.mcpToolScope, options.acceptedRoute);
      return result as never;
    },
  });
  assert.equal(rebuilt.model, 'fixture-original-brain');
  assert.deepEqual(order.filter(x => x !== 'owner'), ['prime', 'revalidate', 'build']);
  assert.ok(order.slice(order.indexOf('prime') + 1, order.indexOf('revalidate')).includes('owner'));
  assert.ok(order.slice(order.indexOf('revalidate') + 1, order.indexOf('build')).includes('owner'));
  assert.equal(order.at(-1), 'owner');
  assert.deepEqual(connectionCheckpoints.readSourceConnectionCheckpoint(identity), retained);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['approval_requested', 'run_resumed'] }).length, 0,
    'building context neither grants consent nor starts a continuation');
  leases.revokeDispatchLease(task.parentLease);
});

for (const drift of ['reviewed-account', 'schema', 'scope', 'model', 'route', 'missing-route', 'construction', 'owner-after-prime', 'owner-after-build'] as const) {
  test(`connection rebuild refuses ${drift} drift without substituting retained authority`, async () => {
    const task = fixture('Continue using the original reviewed account and tools.', 'execute');
    await settledConnectionBatch(task);
    const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, agent: connectionAgent(task, undefined, 'act') });
    assert.ok(pause);
    let lost = false;
    let builds = 0;
    let validations = 0;
    const attempt = rebuildSourceConnectionAgent({ sessionId: task.sessionId, requestId: pause.requestId,
      assertOwned: () => { if (lost) throw new Error('original activation lost'); } }, {
      prime: async () => {
        if (drift === 'owner-after-prime') lost = true;
        return { ok: true, planning: {} } as never;
      },
      revalidate: async () => { validations += 1; if (drift === 'reviewed-account') throw new Error('Reviewed account changed.'); },
      build: async options => {
        builds += 1;
        const result = connectionAgent(task, options.mcpToolScope, options.acceptedRoute);
        if (drift === 'schema') {
          const changed = agentEnvelopes.sealAgentCapabilityUniverse({ sessionId: task.sessionId,
            universeTools: [{ name: 'tool_search', description: 'Changed callable contract', parameters: { type: 'object' } }],
            activeToolNames: ['tool_search'], policyHash: 'fixture-policy',
            budget: { maxUncachedTokens: 1000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 30000 } });
          assert.ok(changed.ok);
          if (changed.ok) agentEnvelopes.bindAgentCapabilityEnvelope(result, changed.envelope);
        }
        if (drift === 'scope') mcpAuthority.bindAgentMcpToolScope(result, { reason: 'broader replacement', authority: 'catalog', allowAll: true });
        if (drift === 'model') result.model = 'unrequested-model';
        if (['route', 'missing-route', 'construction'].includes(drift)) agentRebuild.bindAgentRebuildContext(result, {
          excludeToolNames: ['run_shell_command'], allowToolJit: drift !== 'construction',
          acceptedRoute: drift === 'route' ? 'retrieve' : drift === 'missing-route' ? undefined : options.acceptedRoute,
        });
        if (drift === 'owner-after-build') lost = true;
        return result as never;
      },
    });
    const expected = drift === 'reviewed-account' ? /Reviewed account changed/
      : drift === 'schema' ? /definitions or policy changed/
      : drift === 'scope' ? /external tool scope/
      : drift === 'model' ? /selected model/
      : ['route', 'missing-route', 'construction'].includes(drift) ? /construction context or accepted route/ : /activation lost/;
    await assert.rejects(attempt, expected);
    assert.equal(builds, ['reviewed-account', 'owner-after-prime'].includes(drift) ? 0 : 1);
    assert.equal(validations, drift === 'owner-after-prime' ? 0 : 1);
    leases.revokeDispatchLease(task.parentLease);
  });
}

for (const synthetic of [false, true]) for (const stopped of ['execution', 'approval-delivery'] as const) {
  test(`approval-resumed Execute (synthetic=${synthetic}) retains its execution checkpoint and honors Stop on ${stopped}`, async () => {
    const task = fixture('Inspect the controlled CRM after the approved fixture action.', 'execute');
    const approvals = await import('./approval-registry.js');
    const dependencies = await import('./dependency-request.js');
    const setup = await import('./connection-setup.js');
    const card = approvals.register({ sessionId: task.sessionId, subject: 'Controlled fixture action', tool: 'fixture_send', args: { target: 'test' } });
    assert.equal(approvals.resolve(card.approvalId, 'approved', 'fixture-owner').ok, true);
    const control = eventlog.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'user', type: 'user_input_received',
      data: { text: 'Approved.', synthetic, approvalId: card.approvalId, decision: 'approve' } });
    eventlog.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'system', type: 'run_resumed',
      data: { approvalId: card.approvalId, decision: 'approve', reviewContinuationVersion: 1,
        executionSourceUserSeq: task.sourceUserSeq, deliverySourceUserSeq: control.seq } });
    await settledConnectionBatch(task);
    const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ sessionId: task.sessionId, sourceUserSeq: control.seq, turn: 2 });
    assert.ok(pause);
    assert.equal(pause.sourceUserSeq, task.sourceUserSeq);
    assert.equal(connectionCheckpoints.readSourceConnectionCheckpoint({ sessionId: task.sessionId, requestId: pause.requestId })?.sourceUserSeq, task.sourceUserSeq);
    assert.equal(dependencies.currentConnectionDependency(task.sessionId)?.requestId, pause.requestId,
      'the UI can find the pause under its validated approval delivery source');
    assert.equal(setup.connectionContinuationTaskMode({ sessionId: task.sessionId, connectionRequestId: pause.requestId })?.kind, 'execute');
    assert.ok(setup.readConnectionSetup(task.sessionId)?.continuationBlocker, 'retention still cannot enable Execute auto-resume');
    eventlog.appendEvent({ sessionId: task.sessionId, turn: 3, role: 'user', type: 'user_input_received',
      data: { text: 'An unrelated background report-back.', synthetic: true } });
    assert.equal(dependencies.currentConnectionDependency(task.sessionId)?.requestId, pause.requestId);
    const attempt = eventlog.beginRunAttempt(task.sessionId);
    const stoppedSource = stopped === 'execution' ? task.sourceUserSeq : control.seq;
    eventlog.recordRunAttemptUserInput(attempt, { turn: 2, role: 'user', data: { text: 'Fixture attempt' } }, { existingEventSeq: stoppedSource });
    eventlog.finishRunAttempt(attempt, 'cancelled');
    assert.equal(dependencies.currentConnectionDependency(task.sessionId), null);
    leases.revokeDispatchLease(task.parentLease);
  });
}

test('approval-looking user text without a host resume marker cannot select an older connection pause', async () => {
  const task = fixture('Inspect the controlled CRM.', 'execute');
  await settledConnectionBatch(task);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 });
  assert.ok(pause);
  const control = eventlog.appendEvent({ sessionId: task.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Approved.', approvalId: 'unproven-card', decision: 'approve' } });
  assert.equal(connectionCheckpoints.parkObservedConnectionWithCheckpoint({ sessionId: task.sessionId, sourceUserSeq: control.seq, turn: 2 }), null);
  assert.equal((await import('./dependency-request.js')).currentConnectionDependency(task.sessionId), null);
  leases.revokeDispatchLease(task.parentLease);
});

test('connection pause cannot manufacture execution history from prose or missing batch evidence', async () => {
  const task = fixture('Inspect the disconnected controlled CRM.', 'execute');
  assert.equal(connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1, text: 'Please connect the CRM.' }), null);
  connectionSearchEvidence(task);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 });
  assert.ok(pause);
  const identity = { sessionId: task.sessionId, requestId: pause.requestId };
  assert.equal(connectionCheckpoints.readSourceConnectionCheckpoint(identity), null);
  assert.deepEqual(connectionCheckpoints.captureSourceConnectionCheckpoint(identity), { status: 'unavailable', reason: 'missing' });
  connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 });
  const diagnostics = eventlog.listEvents(task.sessionId, { types: ['connection_execution_checkpoint_unavailable'] });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.data.reason, 'missing');
  const { projectHarnessEventForPublic } = await import('./public-presentation.js');
  assert.equal(projectHarnessEventForPublic(diagnostics[0]!), null, 'recovery diagnostics are not chat content');
  leases.revokeDispatchLease(task.parentLease);
});

for (const mode of ['normal', 'plan'] as const) {
  test(`${mode} setup does not create a reviewed execution checkpoint`, () => {
    const task = fixture('Inspect the disconnected controlled CRM.', mode);
    connectionSearchEvidence(task);
    const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 });
    assert.ok(pause);
    assert.equal(connectionCheckpoints.readSourceConnectionCheckpoint({ sessionId: task.sessionId, requestId: pause.requestId }), null);
    assert.equal(eventlog.listEvents(task.sessionId, { types: ['connection_execution_checkpoint_unavailable'] }).length, 0);
    leases.revokeDispatchLease(task.parentLease);
  });
}

test('an admitted batch with no logical start is balanced durably and chains only from its exact checkpoint', () => {
  const task = fixture('Inspect the available records and report what is present.');
  const firstFrame = openFrame({
    callId: 'call:read:1',
    toolName: 'records_read',
    args: { query: 'available' },
  });
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task),
    frameHistory: firstFrame,
    providerResponseId: 'response:1',
  });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);

  const exactReplay = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task),
    frameHistory: firstFrame,
    providerResponseId: 'response:1',
  });
  assert.equal(exactReplay.status, 'existing');

  const competing = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task),
    frameHistory: openFrame({
      callId: 'call:other',
      toolName: 'records_read',
      args: { query: 'different' },
    }),
    providerResponseId: 'response:different',
  });
  assert.equal(competing.status, 'conflict');

  const noStartResult = hostResults.buildHostToolDispositionResult({
    callId: 'call:read:1',
    toolName: 'records_read',
    disposition: 'not_started',
    frameDigest: digest('frame:call:read:1'),
    frameIndex: 0,
    frameSize: 1,
  });
  hostResults.recordHostModelResultReceipts({
    admission: admitted.admission,
    resultItems: [noStartResult],
  });
  const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
    committedResultItems: [noStartResult],
  });
  assert.ok(finalized.status === 'committed' || finalized.status === 'existing');

  const recovered = checkpoints.recoverAcceptedModelBatchForRestart({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(recovered.status, 'ready');
  if (recovered.status !== 'ready') throw new Error(recovered.reason);
  assert.equal(protocol.inspectConversationProtocol(recovered.checkpoint.history).status, 'valid');
  assert.match(resultText(recovered.checkpoint.history, 'call:read:1') ?? '', /"disposition":"not_started"/);
  assert.equal(physicalRows(task, 'call:read:1').length, 0);

  const second = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: recovered.checkpoint.history,
    frameHistory: openFrame({
      callId: 'call:read:2',
      toolName: 'records_read',
      args: { query: 'available', page: 2 },
    }),
    previousResponseId: recovered.checkpoint.lastResponseId,
    providerResponseId: 'response:2',
  });
  assert.equal(second.status, 'admitted');
  if (second.status === 'admitted') assert.equal(second.admission.batchOrdinal, 2);
  leases.revokeDispatchLease(task.parentLease);
});

for (const candidate of [
  { effect: 'read' as const, toolName: 'read_file', callId: 'call:settled-read' },
  { effect: 'external_write' as const, toolName: 'space_publish', callId: 'call:settled-write' },
]) {
  test(`restart adopts one settled ${candidate.effect} without repeating its crossing or body`, async () => {
    const task = fixture(`Perform the exact ${candidate.effect} operation.`);
    const args = candidate.effect === 'read'
      ? { query: 'current records' }
      : { title: 'Release Readiness', rows: [{ status: 'ready' }] };
    const admitted = checkpoints.admitAcceptedModelBatch({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      preHistory: preHistory(task),
      frameHistory: openFrame({ ...candidate, args }),
      previousResponseId: 'response:prior',
      providerResponseId: `response:${candidate.callId}`,
    });
    assert.equal(admitted.status, 'admitted');
    if (admitted.status !== 'admitted') throw new Error(admitted.reason);

    let bodies = 0;
    const payload = { ok: true, callId: candidate.callId, durable: true };
    const first = await runCall({
      task,
      ...candidate,
      args,
      invoke: async () => {
        bodies += 1;
        return payload;
      },
    });
    assert.deepEqual(first.value, payload);
    assert.equal(bodies, 1);
    const crossing = physicalRows(task, candidate.callId);
    assert.equal(crossing.length, 1);

    const resultItem = exactSettledResult({
      task,
      callId: candidate.callId,
      history: [...preHistory(task), ...openFrame({ ...candidate, args })],
    });
    recordLogicalResult(admitted.admission, resultItem);
    const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
      committedResultItems: [resultItem],
    });
    assert.ok(finalized.status === 'committed' || finalized.status === 'existing');

    const recovered = checkpoints.recoverAcceptedModelBatchForRestart({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
    });
    assert.equal(recovered.status, 'ready');
    if (recovered.status !== 'ready') throw new Error(recovered.reason);
    assert.equal(resultText(recovered.checkpoint.history, candidate.callId), JSON.stringify(payload));
    assert.equal(recovered.checkpoint.lastResponseId, `response:${candidate.callId}`);
    assert.equal(physicalRows(task, candidate.callId).length, 1);

    const replay = await runCall({
      task,
      ...candidate,
      args,
      invoke: async () => {
        bodies += 1;
        return { ok: false, mustNotRun: true };
      },
    });
    assert.deepEqual(replay.value, payload);
    assert.equal(replay.settlement.duplicate, true);
    assert.equal(bodies, 1);
    assert.equal(physicalRows(task, candidate.callId).length, 1);

    const recoveredAgain = checkpoints.recoverAcceptedModelBatchForRestart({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
    });
    assert.equal(recoveredAgain.status, 'ready');
    if (recoveredAgain.status === 'ready') {
      assert.equal(recoveredAgain.checkpoint.historyDigest, recovered.checkpoint.historyDigest);
    }
    leases.revokeDispatchLease(task.parentLease);
  });
}

for (const candidate of [
  { label: 'local', boundary: 'host_owned_local' as const },
  { label: 'external read', boundary: 'host_owned_external' as const },
]) {
  test(`an exact ${candidate.label} non-success projection remains ordinary restart-safe model data`, async () => {
    const task = fixture(`Inspect one ${candidate.label} source and report its typed corrective.`);
    const callId = `call:typed-failure:${candidate.label.replace(/\s+/g, '-')}`;
    const toolName = 'read_file';
    const args = { path: `/fixture/${candidate.label.replace(/\s+/g, '-')}.txt` };
    const admitted = checkpoints.admitAcceptedModelBatch({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      preHistory: preHistory(task),
      frameHistory: openFrame({ callId, toolName, args }),
      providerResponseId: `response:${callId}`,
    });
    assert.equal(admitted.status, 'admitted');
    if (admitted.status !== 'admitted') throw new Error(admitted.reason);

    let bodies = 0;
    const payload = {
      ok: false,
      code: 'fixture_typed_corrective',
      detail: 'Use the returned corrective in the next model step.',
    };
    const invoked = await runCall({
      task,
      callId,
      toolName,
      args,
      effect: 'read',
      boundary: candidate.boundary,
      invoke: async () => {
        bodies += 1;
        return payload;
      },
    });
    assert.equal(invoked.settlement.outcome.kind, 'unknown');
    assert.equal(bodies, 1);

    const resultItem = projectedTextResult({ callId, toolName, value: payload });
    recordLogicalResult(admitted.admission, resultItem);
    const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
      committedResultItems: [resultItem],
    });
    assert.ok(finalized.status === 'committed' || finalized.status === 'existing');

    const recovered = checkpoints.recoverAcceptedModelBatchForRestart({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
    });
    assert.equal(recovered.status, 'ready');
    if (recovered.status !== 'ready') throw new Error(recovered.reason);
    assert.equal(resultText(recovered.checkpoint.history, callId), JSON.stringify(payload));
    assert.equal(physicalRows(task, callId).length, 1);
    assert.equal(bodies, 1, 'checkpoint recovery cannot repeat the body');
    leases.revokeDispatchLease(task.parentLease);
  });
}

for (const variant of ['local_control', 'business_local', 'external', 'admin', 'wrong_parent', 'wrong_source', 'no_failure', 'catalog_binding'] as const) {
  test(`only the exact returned local coordinator failure may checkpoint model feedback (${variant})`, async () => {
    const task = fixture(`Retain the exact ${variant} result, without replay or success.`);
    const callId = `call:coordinator-failure:${variant}`;
    const toolName = 'fixture_coordinator';
    const args = { items: ['item-1'] };
    const admitted = checkpoints.admitAcceptedModelBatch({
      sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
      preHistory: preHistory(task), frameHistory: openFrame({ callId, toolName, args }),
    });
    assert.equal(admitted.status, 'admitted');
    if (admitted.status !== 'admitted') throw new Error(admitted.reason);
    const payload = 'The item failed; retain this exact failure for the next step.';
    let bodies = 0;
    const invoked = await runCall({
      task, callId, toolName, args,
      effect: variant === 'external' ? 'external_write' : variant === 'admin' ? 'admin' : 'local_write',
      localEnvelope: variant !== 'catalog_binding',
      businessCall: variant === 'business_local',
      boundary: 'host_owned_local',
      invoke: async () => {
        bodies += 1;
        eventlog.appendEvent({ sessionId: task.sessionId, turn: 1, role: 'system', type: 'worker_result', data: {
          item: 'item-1', packetKey: 'exact-packet', ok: variant === 'no_failure',
          parentLogicalCallId: variant === 'wrong_parent' ? 'another-call' : callId,
          sourceUserSeq: variant === 'wrong_source' ? task.sourceUserSeq + 1 : task.sourceUserSeq,
        } });
        observations.noteHostToolInvocationObservation({ signals: { executionFailed: true } });
        return payload;
      },
    });
    assert.equal(invoked.settlement.outcome.kind, 'unknown');
    const resultItem = projectedTextResult({ callId, toolName, value: payload });
    recordLogicalResult(admitted.admission, resultItem);
    const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, { committedResultItems: [resultItem] });
    if (variant === 'local_control') {
      assert.ok(finalized.status === 'committed' || finalized.status === 'existing');
      const recovered = checkpoints.recoverAcceptedModelBatchForRestart({ sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq });
      assert.equal(recovered.status, 'ready');
      if (recovered.status !== 'ready') throw new Error(recovered.reason);
      assert.equal(resultText(recovered.checkpoint.history, callId), payload);
    } else assert.equal(finalized.status, 'evidence_unavailable', 'unknown mutations and unrelated receipts cannot borrow coordinator feedback authority');
    assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM durable_result_handles WHERE session_id = ?').get(task.sessionId) as { n: number }).n, 0);
    assert.equal(bodies, 1, 'failure projection never re-enters the body');
    leases.revokeDispatchLease(task.parentLease);
  });
}

test('a returned unknown mutation cannot use a projection receipt to bypass reconciliation', async () => {
  const task = fixture('Attempt one external mutation whose acknowledgement is negative.');
  const callId = 'call:returned-unknown-write';
  const toolName = 'space_publish';
  const args = { title: 'Unknown acknowledgement' };
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task),
    frameHistory: openFrame({ callId, toolName, args }),
    providerResponseId: 'response:returned-unknown-write',
  });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);

  const payload = { ok: false, code: 'unknown_write_acknowledgement' };
  const invoked = await runCall({
    task,
    callId,
    toolName,
    args,
    effect: 'external_write',
    invoke: async () => payload,
  });
  assert.equal(invoked.settlement.outcome.kind, 'uncertain_write');
  const resultItem = projectedTextResult({ callId, toolName, value: payload });
  recordLogicalResult(admitted.admission, resultItem);
  const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
    committedResultItems: [resultItem],
  });
  assert.equal(finalized.status, 'evidence_unavailable');
  leases.revokeDispatchLease(task.parentLease);
});

test('an uncertain host-owned mutation with zero provider crossings checkpoints reconciliation', async () => {
  const task = fixture('Attempt one host-owned mutation whose effect is not acknowledged.', 'execute');
  const callId = 'call:host-owned-unknown-write';
  const toolName = 'space_publish';
  const args = { title: 'Host-owned unknown acknowledgement' };
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task),
    frameHistory: openFrame({ callId, toolName, args }),
    providerResponseId: 'response:host-owned-unknown-write',
  });
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') throw new Error(admitted.reason);

  await assert.rejects(runCall({
    task,
    callId,
    toolName,
    args,
    effect: 'external_write',
    boundary: 'host_owned_local',
    invoke: async () => { throw new Error('acknowledgement unavailable'); },
  }));
  const settlement = eventlog.openEventLog().prepare(`
    SELECT outcome_kind, physical_crossing_count, host_crossing_count,
           requires_reconciliation
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, callId);
  assert.deepEqual(settlement, {
    outcome_kind: 'uncertain_write',
    physical_crossing_count: 0,
    host_crossing_count: 1,
    requires_reconciliation: 1,
  });

  const effectUnknown = hostResults.buildHostToolDispositionResult({
    callId,
    toolName,
    disposition: 'effect_unknown',
    frameDigest: digest(`frame:${callId}`),
    frameIndex: 0,
    frameSize: 1,
  });
  recordLogicalResult(admitted.admission, effectUnknown);
  const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
    committedResultItems: [effectUnknown],
  });
  assert.ok(finalized.status === 'committed' || finalized.status === 'existing');
  assert.equal(finalized.checkpoint.disposition, 'reconciliation_required');

  const recovered = checkpoints.recoverAcceptedModelBatchForRestart({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(recovered.status, 'reconciliation_required');
  assert.equal(physicalRows(task, callId).length, 1);
  connectionSearchEvidence(task);
  const pause = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...task, turn: 1 });
  assert.ok(pause);
  const identity = { sessionId: task.sessionId, requestId: pause.requestId };
  assert.deepEqual(connectionCheckpoints.captureSourceConnectionCheckpoint(identity),
    { status: 'unavailable', reason: 'reconciliation_required' });
  assert.equal(connectionCheckpoints.readSourceConnectionCheckpoint(identity), null,
    'a connection cannot clear an uncertain write or make it restart-ready');
  leases.revokeDispatchLease(task.parentLease);
});

test('a timed-out external write remains reconciliation-only and is never blindly retried', async () => {
  const task = fixture('Create the exact external table once.');
  const callId = 'call:unknown-write';
  const toolName = 'space_publish';
  const args = { title: 'Restart Boundary', rows: [{ checkpoint: true }] };
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    preHistory: preHistory(task),
    frameHistory: openFrame({ callId, toolName, args }),
    providerResponseId: 'response:unknown-write',
  });
  assert.equal(admitted.status, 'admitted');

  let bodies = 0;
  await assert.rejects(runCall({
    task,
    callId,
    toolName,
    args,
    effect: 'external_write',
    deadlineMs: 15,
    invoke: async () => {
      bodies += 1;
      return await new Promise<string>(() => {});
    },
  }));
  assert.equal(bodies, 1);
  assert.equal(physicalRows(task, callId).length, 1);

  const effectUnknown = hostResults.buildHostToolDispositionResult({
    callId,
    toolName,
    disposition: 'effect_unknown',
    frameDigest: digest(`frame:${callId}`),
    frameIndex: 0,
    frameSize: 1,
  });
  if (admitted.status !== 'admitted') throw new Error('fixture admission failed');
  recordLogicalResult(admitted.admission, effectUnknown);
  const finalized = checkpoints.finalizeAcceptedModelBatch(admitted.admission, {
    committedResultItems: [effectUnknown],
  });
  assert.ok(finalized.status === 'committed' || finalized.status === 'existing');

  const recovered = checkpoints.recoverAcceptedModelBatchForRestart({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(recovered.status, 'reconciliation_required');
  if (recovered.status !== 'reconciliation_required') throw new Error(recovered.reason);
  assert.match(resultText(recovered.checkpoint.history, callId) ?? '', /"retry":"do_not_retry"/);
  assert.equal(physicalRows(task, callId).length, 1);

  await assert.rejects(runCall({
    task,
    callId,
    toolName,
    args,
    effect: 'external_write',
    invoke: async () => {
      bodies += 1;
      return 'must-not-run';
    },
  }));
  assert.equal(bodies, 1);
  assert.equal(physicalRows(task, callId).length, 1);
  leases.revokeDispatchLease(task.parentLease);
});

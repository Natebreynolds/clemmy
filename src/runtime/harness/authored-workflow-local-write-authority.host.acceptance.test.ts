/**
 * Authored-step coverage for reversible LOCAL writes, proven through the
 * production host (host_v1) — not through the evaluator alone.
 *
 * The class: a saved workflow's prose step is the accepted work. Its own
 * reversible registry-ledger writes (task/goal/space bookkeeping) must proceed
 * on the immutable step's receipt, exactly once per admitted occurrence, with
 * zero approval cards. A chat session wearing forged workflow metadata, a step
 * AUTHORED `requiresApproval`, and a declared irreversible local mode
 * (write_file overwrite) all stay refused before any body runs.
 *
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/authored-workflow-local-write-authority.host.acceptance.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-authored-local-write-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
delete process.env.OPENAI_API_KEY;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-authored-local-write\n');

const { hostRunRunner } = await import('./host-turn-runner.js');
const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const capabilityEnvelopes = await import('../../agents/capability-envelope.js');
const planScopes = await import('../../agents/plan-scope.js');
const authorityAdapter = await import('./authored-workflow-write-authority.js');
const hostConsent = await import('./host-interactive-consent.js');
const callAuthority = await import('./accepted-turn-call-authority.js');
const hostBindings = await import('./host-call-capability-binding.js');
const logicalContracts = await import('./logical-call-contract.js');
const identities = await import('./attempt-identity.js');
const checkpoints = await import('./accepted-model-batch-checkpoint.js');
const leases = await import('./dispatch-lease.js');
const hostInvocation = await import('./host-tool-invocation.js');
const workflowDefinitions = await import('../../execution/workflow-run-definition.js');
const sharedTools = await import('../../tools/shared.js');
const memoryDatabase = await import('../../memory/db.js');

test.after(() => {
  eventlog.closeEventLog();
  memoryDatabase.closeMemoryDb();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

// ─── production host scaffolding (mirrors host-turn-runner.test.ts) ─────────

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{ output?: unknown[]; responseId?: string }> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = response.output ?? [];
  const finishReason = output.some((item) => (item as { type?: string }).type === 'function_call')
    ? 'tool_calls'
    : 'stop';
  yield { type: 'response_started' } as never;
  yield { type: 'model', event: { type: 'finish', finishReason } } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId ?? 'test-response',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

function stubModel(responses: unknown[][]) {
  let call = 0;
  return {
    calls: () => call,
    async getResponse() {
      const output = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output,
        responseId: `resp-${call}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
}

const textMsg = (text: string) => ({
  type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text }],
});
const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call', callId, name, arguments: JSON.stringify(args),
});

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('Runner.run must not own the turn');
  };
  return runner;
}

function dispositionMarkers(history: readonly unknown[]): Array<{ disposition: string; retry: string }> {
  const markers: Array<{ disposition: string; retry: string }> = [];
  for (const item of history) {
    if ((item as { type?: string }).type !== 'function_call_result') continue;
    const output = (item as { output?: unknown }).output;
    const text = typeof output === 'string'
      ? output
      : output && typeof output === 'object' ? (output as { text?: unknown }).text : undefined;
    if (typeof text !== 'string') continue;
    try {
      const decoded = JSON.parse(text) as { protocol?: string; disposition?: string; retry?: string };
      if (decoded.protocol === 'host_tool_disposition_v1' && decoded.disposition && decoded.retry) {
        markers.push({ disposition: decoded.disposition, retry: decoded.retry });
      }
    } catch { /* ordinary tool result */ }
  }
  return markers;
}

interface FixtureTool {
  name: string;
  parameters: Record<string, unknown>;
}

const TOOLS: Record<'task_hygiene' | 'goal_upsert' | 'write_file', FixtureTool> = {
  task_hygiene: {
    name: 'task_hygiene',
    parameters: {
      type: 'object',
      properties: { apply: { type: 'boolean' } },
      required: ['apply'],
      additionalProperties: false,
    },
  },
  goal_upsert: {
    name: 'goal_upsert',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, status: { type: 'string' } },
      required: ['title', 'status'],
      additionalProperties: false,
    },
  },
  write_file: {
    name: 'write_file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        mode: { type: ['string', 'null'], enum: ['create', 'append', 'overwrite', null] },
        append: { type: ['boolean', 'null'] },
      },
      required: ['path', 'content', 'mode', 'append'],
      additionalProperties: false,
    },
  },
};

function fixtureTools(names: Array<keyof typeof TOOLS>) {
  const bodies: Record<string, number> = {};
  const tools = names.map((name) => {
    bodies[name] = 0;
    return brackets.wrapToolForHarness({
      type: 'function',
      name,
      description: `fixture ${name}`,
      parameters: TOOLS[name].parameters,
      needsApproval: async () => false,
      invoke: async () => {
        bodies[name] = (bodies[name] ?? 0) + 1;
        return JSON.stringify({ ok: true, tool: name });
      },
    });
  });
  return { bodies, tools };
}

let serial = 0;

function createStepFixture(input: {
  kind: 'workflow' | 'chat';
  sideEffect: 'read' | 'write' | 'send';
  requiresApproval?: boolean;
}) {
  const suffix = String(++serial);
  const workflowRunId = `run-local-write-${suffix}`;
  const workflowSlug = `local-write-${suffix}`;
  const workflowName = `Local Write ${suffix}`;
  const stepId = 'wrap_up';
  const attemptId = `attempt:workflow:${workflowRunId}:${stepId}`;
  const sessionId = `workflow:${workflowRunId}:${stepId}`;
  const planProposalId = `workflow:${workflowName}:${workflowRunId}:${stepId}`;
  const prompt = 'Compact the task ledger with task_hygiene, refresh the active goal with goal_upsert, then return a structured result.';
  const definition = {
    name: workflowName,
    description: 'Exercise authored coverage for reversible local ledger writes.',
    enabled: true,
    trigger: { manual: true as const },
    steps: [{
      id: stepId,
      prompt,
      sideEffect: input.sideEffect,
      ...(input.requiresApproval ? { requiresApproval: true } : { requiresApproval: false }),
    }],
  };
  const snapshot = workflowDefinitions.createWorkflowRunDefinitionSnapshot(
    workflowSlug,
    definition,
    `2026-08-31T00:00:${String(serial).padStart(2, '0')}.000Z`,
  );
  mkdirSync(sharedTools.WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(sharedTools.WORKFLOW_RUNS_DIR, `${workflowRunId}.json`), JSON.stringify({
    id: workflowRunId,
    workflow: workflowName,
    workflowDefinitionSnapshot: snapshot,
    status: 'running',
    inputs: {},
    createdAt: '2026-08-31T00:00:00.000Z',
    startedAt: '2026-08-31T00:00:01.000Z',
  }), 'utf8');
  const session = eventlog.createSession({
    id: sessionId,
    kind: input.kind,
    channel: 'workflow',
    title: `${workflowName}::${stepId}`,
    metadata: { source: 'workflow', workflowName, workflowRunId, stepId },
  });
  const attempt = eventlog.beginRunAttempt(session.id, {
    runId: `workflow-step:${workflowRunId}:${stepId}`,
    attemptId,
  });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: `Workflow: ${workflowName}\nStep: ${stepId}\n\n${prompt}`, workflowName, workflowRunId, stepId, attemptId },
  });
  planScopes.openPlanScope({
    sessionId: session.id,
    planProposalId,
    approvedPlanObjective: `Approved workflow "${workflowName}" step "${stepId}"`,
    allowedTools: ['*'],
    ttlMs: 10 * 60_000,
  });
  const recorded = authorityAdapter.recordAuthoredWorkflowWriteAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    attemptId,
    workflowRunId,
    workflowSlug,
    stepId,
    expectedPlanProposalId: planProposalId,
    catalogIdentities: [],
  });
  return {
    session,
    source,
    attempt,
    workflowRunId,
    workflowSlug,
    workflowName,
    stepId,
    planProposalId,
    recorded,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    parent: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      counter: new brackets.ToolCallsCounter(8),
      behaviorScopeId: `${session.id}::turn:1`,
    },
    context: { sessionId: session.id, sourceUserSeq: source.seq },
  };
}

type StepFixture = ReturnType<typeof createStepFixture>;

function bindSurface(fixture: StepFixture, agent: object, tools: ReturnType<typeof fixtureTools>['tools']) {
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: fixture.session.id,
    universeTools: tools,
    activeToolNames: tools.map((entry) => entry.name),
    policyHash: 'authored-local-write-policy-v1',
    budget: { maxUncachedTokens: 1_000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 60_000 },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  return sealed.envelope;
}

function runProductionHost(fixture: StepFixture, agent: Record<string, unknown>) {
  return brackets.withHarnessRunContext(fixture.parent, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: fixture.source.data.text }] as never,
    { maxTurns: 4, hostTurnEngine: 'host_v1', context: fixture.context } as never,
  ));
}

function db() {
  return eventlog.openEventLog();
}

function settledLogicalCalls(fixture: StepFixture): Array<{ logical_tool_call_id: string; tool_name: string; state: string }> {
  return db().prepare(`
    SELECT logical_tool_call_id, tool_name, state FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY opened_at, rowid
  `).all(fixture.session.id, fixture.source.seq) as Array<{ logical_tool_call_id: string; tool_name: string; state: string }>;
}

function pendingApprovalCount(fixture: StepFixture): number {
  return (db().prepare(`
    SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?
  `).get(fixture.session.id) as { n: number }).n;
}

function nonRefusedSettlements(fixture: StepFixture): Array<{ logical_tool_call_id: string; execution_kind: string; outcome_kind: string }> {
  return db().prepare(`
    SELECT logical_tool_call_id, execution_kind, outcome_kind FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND execution_kind != 'refused_pre_dispatch'
     ORDER BY settled_at, rowid
  `).all(fixture.session.id, fixture.source.seq) as Array<{ logical_tool_call_id: string; execution_kind: string; outcome_kind: string }>;
}

/** Local-envelope attestation exactly as the production host binds it. */
function localAttestation(
  fixture: StepFixture,
  envelope: { capabilities: readonly { name: string; schemaFingerprint: string }[] },
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
): callAuthority.HostCallAttestation {
  const root = callAuthority.acceptedTurnCallAuthorityFor(fixture.session.id, fixture.source.seq);
  assert.equal(root.status, 'ok', JSON.stringify(root));
  if (root.status !== 'ok') throw new Error(root.reason);
  const capability = envelope.capabilities.find((entry) => entry.name === toolName);
  assert.ok(capability, `${toolName} must be sealed in the envelope`);
  const contract = logicalContracts.durableLogicalCallContract(fixture.acceptedTaskId, toolName, args);
  assert.ok(contract);
  if (!contract || !capability) throw new Error('fixture identity is unavailable');
  const base = {
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    acceptedTaskId: fixture.acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: callId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: 'local_write' as const,
    bindingKind: 'local_envelope' as const,
    capabilityId: toolName,
    schemaFingerprint: capability.schemaFingerprint,
    accountId: '',
    invokePortId: `configured-wrapper:${capability.schemaFingerprint}`,
    operationId: toolName,
    manifestId: '',
    manifestDigest: '',
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: root.authority.catalogRevisionDigest!,
    bindingRevisionDigest: root.authority.bindingRevisionDigest!,
  };
  return { ...base, bindingDigest: hostBindings.hostCallAttestationBindingDigest(base) };
}

// ─── pins ───────────────────────────────────────────────────────────────────

test('a workflow step session covers its own reversible registry writes: each proceeds once, no approval card', async () => {
  const fixture = createStepFixture({ kind: 'workflow', sideEffect: 'send' });
  assert.equal(fixture.recorded.status, 'ready', JSON.stringify(fixture.recorded));
  const { bodies, tools } = fixtureTools(['task_hygiene', 'goal_upsert']);
  const model = stubModel([
    [
      toolCall('hyg-1', 'task_hygiene', { apply: true }),
      toolCall('goal-1', 'goal_upsert', { title: 'Ship the weekly review', status: 'active' }),
    ],
    [textMsg('ledger compacted and goal refreshed')],
  ]);
  const agent = { model, tools };
  bindSurface(fixture, agent, tools);

  const outcome = await runProductionHost(fixture, agent);
  assert.equal(outcome.finalOutput, 'ledger compacted and goal refreshed', JSON.stringify(outcome.history));
  assert.equal(outcome.hasInterruptions ?? false, false, 'a covered local write never pauses');
  assert.deepEqual(bodies, { task_hygiene: 1, goal_upsert: 1 }, 'one physical body per authored occurrence');
  assert.equal(model.calls(), 2);
  assert.deepEqual(dispositionMarkers(outcome.history), [], 'no refusal marker reached the model');
  assert.equal(pendingApprovalCount(fixture), 0, 'zero approval cards for covered reversible local writes');
  assert.deepEqual(
    settledLogicalCalls(fixture).map((row) => [row.logical_tool_call_id, row.tool_name, row.state]),
    [['hyg-1', 'task_hygiene', 'settled'], ['goal-1', 'goal_upsert', 'settled']],
  );
  assert.deepEqual(
    nonRefusedSettlements(fixture).map((row) => [row.logical_tool_call_id, row.outcome_kind]),
    [['hyg-1', 'succeeded'], ['goal-1', 'succeeded']],
    'both crossings settled as executed work, not refusals',
  );
  const receipt = eventlog.listEvents(fixture.session.id, { types: ['authored_workflow_write_authority'] });
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0]!.data.stepSideEffect, 'send');
  assert.deepEqual(receipt[0]!.data.catalogIdentities, [], 'an identity-free receipt covers local ledgers only');
});

test('the same admitted occurrence replays from its settlement: no second body, duplicate:true', async () => {
  const fixture = createStepFixture({ kind: 'workflow', sideEffect: 'write' });
  assert.equal(fixture.recorded.status, 'ready', JSON.stringify(fixture.recorded));
  const { bodies, tools } = fixtureTools(['task_hygiene']);
  const agent = { model: stubModel([[textMsg('unused')]]), tools };
  const envelope = bindSurface(fixture, agent, tools);
  const armed = callAuthority.armHostCallAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    catalogRevisionDigest: sha256(`catalog:${fixture.session.id}`),
    bindingRevisionDigest: sha256(`binding:${fixture.session.id}`),
    maxLogicalCalls: 8,
    maxParallelCalls: 2,
  });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  const callId = 'hyg-replay-1';
  const args = { apply: true };
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    preHistory: [{ role: 'user', content: fixture.source.data.text } as AgentInputItem],
    frameHistory: [toolCall(callId, 'task_hygiene', args) as unknown as AgentInputItem],
    providerResponseId: 'response:local-replay:1',
  });
  assert.equal(admitted.status, 'admitted', JSON.stringify(admitted));
  if (admitted.status !== 'admitted') return;
  const attestation = localAttestation(fixture, envelope, callId, 'task_hygiene', args);
  const evaluate = () => authorityAdapter.evaluateAuthoredWorkflowMutationConsent({
    attestation,
    args,
    acceptedBatch: admitted.admission,
    callIndex: 0,
  });
  const first = await evaluate();
  assert.equal(first?.status, 'decided', JSON.stringify(first));
  assert.equal(first?.decision.kind, 'proceed');
  if (first?.decision.kind === 'proceed') {
    assert.equal(first.decision.basis, 'exact_reversible_work', 'coverage, never a user grant, carries a reversible ledger write');
    assert.equal(first.decision.authorityDigest, fixture.recorded.status === 'ready' ? fixture.recorded.authorityDigest : '');
  }
  assert.equal(first?.call.effect, 'local_write');
  assert.equal(first?.call.risk.reversibility, 'reversible');
  assert.equal(first?.call.risk.destructive, false);
  assert.equal(first?.coverage?.contractId, `authored-workflow:${fixture.recorded.status === 'ready' ? fixture.recorded.authorityDigest : ''}`);
  assert.equal(await authorityAdapter.evaluateAuthoredWorkflowMutationConsent({
    attestation, args, acceptedBatch: admitted.admission, callIndex: 1,
  }), null, 'a different call ordinal in the same batch is not this occurrence');
  assert.equal(await authorityAdapter.evaluateAuthoredWorkflowMutationConsent({
    attestation: { ...attestation, effect: 'external_write' }, args, acceptedBatch: admitted.admission, callIndex: 0,
  }), null, 'a local envelope cannot claim external-write authority');

  const parentLease = leases.activateDispatchLease({
    sessionId: fixture.session.id,
    scopeId: `${fixture.session.id}::local-replay`,
  });
  const context = {
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(8),
    dispatchLease: parentLease,
  } satisfies brackets.HarnessRunContext;
  const invoke = () => callAuthority.withHostCallAttestation(attestation, () =>
    brackets.withHarnessRunContext(context, () => hostInvocation.invokeHostToolCall({
      identity: {
        sessionId: fixture.session.id,
        sourceUserSeq: fixture.source.seq,
        modelCallId: callId,
        toolName: 'task_hygiene',
        args,
        turn: 1,
      },
      parentLease,
      effect: 'local_write',
      boundary: 'host_owned_local',
      // The production host projects a registry control-role call as
      // non-business work (host-turn-runner: actionTopologyRoleForRuntimeCall).
      businessCall: false,
      deadlineMs: 500,
      invoke: async () => {
        bodies.task_hygiene += 1;
        return JSON.stringify({ ok: true });
      },
    })));
  const crossed = await invoke();
  assert.equal(crossed.settlement.duplicate, false);
  assert.equal(bodies.task_hygiene, 1);
  const replayConsent = await evaluate();
  assert.equal(replayConsent?.decision.kind, 'proceed', JSON.stringify(replayConsent));
  if (replayConsent?.decision.kind === 'proceed') {
    assert.equal(replayConsent.decision.basis, 'settled_replay');
  }
  const replay = await invoke();
  assert.equal(replay.settlement.duplicate, true);
  assert.equal(bodies.task_hygiene, 1, 'the same admitted occurrence never enters the body twice');
  leases.revokeDispatchLease(parentLease);
});

test('a chat session wearing forged workflow metadata gets no receipt and its local write stays coverage_missing', async () => {
  const fixture = createStepFixture({ kind: 'chat', sideEffect: 'send' });
  assert.deepEqual(fixture.recorded, { status: 'refused', reason: 'workflow_session_owner_mismatch' });
  const { bodies, tools } = fixtureTools(['task_hygiene']);
  const model = stubModel([
    [toolCall('forged-hyg-1', 'task_hygiene', { apply: true })],
    [textMsg('forged chat refused safely')],
  ]);
  const agent = { model, tools };
  const envelope = bindSurface(fixture, agent, tools);

  const outcome = await runProductionHost(fixture, agent);
  assert.equal(outcome.finalOutput, 'forged chat refused safely');
  assert.equal(bodies.task_hygiene, 0, 'a forged chat never executes the ledger write');
  assert.deepEqual(dispositionMarkers(outcome.history), [{ disposition: 'refused_pre_dispatch', retry: 'replan' }]);
  assert.equal(pendingApprovalCount(fixture), 0);
  assert.deepEqual(nonRefusedSettlements(fixture), []);

  const attestation = localAttestation(fixture, envelope, 'forged-hyg-1', 'task_hygiene', { apply: true });
  const uncovered = await callAuthority.withHostCallAttestation(attestation, () => (
    hostConsent.evaluateUncoveredHostMutationConsent({ attestation, args: { apply: true } })
  ));
  assert.equal(uncovered.status, 'decided');
  if (uncovered.status === 'decided') {
    assert.deepEqual(uncovered.decision, { kind: 'repair', reason: 'coverage_missing' });
  }
});

test('a step AUTHORED requiresApproval keeps its gate: no receipt, local write refused before any body', async () => {
  const fixture = createStepFixture({ kind: 'workflow', sideEffect: 'write', requiresApproval: true });
  assert.deepEqual(fixture.recorded, { status: 'none' }, 'an authored human gate never mints self-coverage');
  const { bodies, tools } = fixtureTools(['task_hygiene']);
  const model = stubModel([
    [toolCall('gated-hyg-1', 'task_hygiene', { apply: true })],
    [textMsg('gated step refused safely')],
  ]);
  const agent = { model, tools };
  bindSurface(fixture, agent, tools);

  const outcome = await runProductionHost(fixture, agent);
  assert.equal(outcome.finalOutput, 'gated step refused safely');
  assert.equal(bodies.task_hygiene, 0);
  assert.deepEqual(dispositionMarkers(outcome.history), [{ disposition: 'refused_pre_dispatch', retry: 'replan' }]);
  assert.equal(pendingApprovalCount(fixture), 0);
});

test('declared irreversible local modes stay outside the authored coverage: write_file overwrite refused, ledger write still proceeds', async () => {
  const fixture = createStepFixture({ kind: 'workflow', sideEffect: 'write' });
  assert.equal(fixture.recorded.status, 'ready');
  const { bodies, tools } = fixtureTools(['task_hygiene', 'write_file']);
  const overwrite = { path: 'notes/existing.md', content: 'replace everything', mode: 'overwrite', append: null };
  const model = stubModel([
    [toolCall('hyg-2', 'task_hygiene', { apply: true })],
    [toolCall('ow-1', 'write_file', overwrite)],
    [textMsg('overwrite refused, ledger compacted')],
  ]);
  const agent = { model, tools };
  const envelope = bindSurface(fixture, agent, tools);

  const outcome = await runProductionHost(fixture, agent);
  assert.equal(outcome.finalOutput, 'overwrite refused, ledger compacted', JSON.stringify(outcome.history));
  assert.deepEqual(bodies, { task_hygiene: 1, write_file: 0 });
  assert.deepEqual(dispositionMarkers(outcome.history), [{ disposition: 'refused_pre_dispatch', retry: 'replan' }]);
  assert.equal(pendingApprovalCount(fixture), 0);
  assert.deepEqual(
    nonRefusedSettlements(fixture).map((row) => row.logical_tool_call_id),
    ['hyg-2'],
  );
});

test('the declared-semantics path is the discriminator, not the tool name: write_file create is covered, overwrite is not', async () => {
  const fixture = createStepFixture({ kind: 'workflow', sideEffect: 'write' });
  assert.equal(fixture.recorded.status, 'ready');
  const { tools } = fixtureTools(['write_file']);
  const agent = { model: stubModel([[textMsg('unused')]]), tools };
  const envelope = bindSurface(fixture, agent, tools);
  const armed = callAuthority.armHostCallAuthority({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    catalogRevisionDigest: sha256(`catalog:${fixture.session.id}`),
    bindingRevisionDigest: sha256(`binding:${fixture.session.id}`),
    maxLogicalCalls: 8,
    maxParallelCalls: 2,
  });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  const overwrite = { path: 'notes/existing.md', content: 'replace everything', mode: 'overwrite', append: null };
  const create = { path: 'notes/new.md', content: 'fresh', mode: 'create', append: null };
  const admitted = checkpoints.admitAcceptedModelBatch({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    preHistory: [{ role: 'user', content: fixture.source.data.text } as AgentInputItem],
    frameHistory: [
      toolCall('wf-create', 'write_file', create) as unknown as AgentInputItem,
      toolCall('wf-overwrite', 'write_file', overwrite) as unknown as AgentInputItem,
    ],
    providerResponseId: 'response:write-file-modes:1',
  });
  assert.equal(admitted.status, 'admitted', JSON.stringify(admitted));
  if (admitted.status !== 'admitted') return;
  const created = await authorityAdapter.evaluateAuthoredWorkflowMutationConsent({
    attestation: localAttestation(fixture, envelope, 'wf-create', 'write_file', create),
    args: create,
    acceptedBatch: admitted.admission,
    callIndex: 0,
  });
  assert.equal(created?.decision.kind, 'proceed', JSON.stringify(created));
  if (created?.decision.kind === 'proceed') assert.equal(created.decision.basis, 'exact_reversible_work');
  assert.deepEqual(created?.call.risk, { reversibility: 'reversible', consequence: 'create', destructive: false });
  assert.equal(await authorityAdapter.evaluateAuthoredWorkflowMutationConsent({
    attestation: localAttestation(fixture, envelope, 'wf-overwrite', 'write_file', overwrite),
    args: overwrite,
    acceptedBatch: admitted.admission,
    callIndex: 1,
  }), null, 'an overwrite never inherits the authored step coverage');
});

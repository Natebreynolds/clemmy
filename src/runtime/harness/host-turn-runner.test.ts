/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-turn-runner.test.ts
 *
 * The Runner de-ownership pins. Production chat turns step through
 * hostRunRunner: N host steps = N model.getResponse, tools execute on the
 * HOST via the agent's own tool objects, lifecycle events still flow through
 * the runner emitter's hooks, approval pauses BEFORE execution and resumes
 * exactly once, and Runner.run is unreachable (a throwing stub proves it).
 * The model is stubbed — no Codex quota, no OPENAI_API_KEY.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool } from '@openai/agents';
import { z } from 'zod';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-turn-runner-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
delete process.env.OPENAI_API_KEY;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-host-turn\n', 'utf8');

const {
  hostRunRunner: productionHostRunRunner,
  HostInterruptState,
  HostRecoveryState,
  hostToolCallsLimitCheckpointFor,
  committedWriteVerificationHeldText,
  mapHostCallAttemptsWithBarriersInOrder,
  isReturnedPreDispatchHostRefusalSettlement,
  hostBlockedTerminalDetail,
  literalOperationNotFrozenReason,
  _setHostJitReadProvisionerForTests,
} = await import('./host-turn-runner.js');
const catalogScope = await import('./accepted-source-catalog-scope.js');
const hostRunRunner: typeof productionHostRunRunner = (
  runner,
  agent,
  itemsOrState,
  opts,
) => productionHostRunRunner(
  runner,
  agent,
  itemsOrState,
  { ...opts, allowUnownedToolInvocationForTests: true } as never,
);
const { runConversation, runTurn } = await import('./loop.js');
const { HarnessSession } = await import('./session.js');
const eventlog = await import('./eventlog.js');
const noProgressProjection = await import('./host-no-progress-projection.js');
const requestProvenance = await import('./model-request-provenance.js');
const logicalProjectionReceipts = await import('./logical-model-result-projection-receipt.js');
const memoryRecallUsage = await import('../../memory/recall-usage.js');
const memoryDatabase = await import('../../memory/db.js');
const { actionBus } = await import('../action-bus.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const logicalContracts = await import('./logical-call-contract.js');
const dispatch = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const brackets = await import('./brackets.js');
const dispatchLeases = await import('./dispatch-lease.js');
const guardrails = await import('./guardrails.js');
const callAuthorities = await import('./accepted-turn-call-authority.js');
const {
  buildAskUserQuestionTool,
  buildOrchestratorAgent,
  userChoiceToolUseBehavior,
} = await import('../../agents/orchestrator.js');
const capabilityEnvelopes = await import('../../agents/capability-envelope.js');
const capabilityCatalogs = await import('./host-capability-catalog-factory.js');
const capabilityManifests = await import('./capability-manifest.js');
const capabilityManifestStores = await import('./capability-manifest-store.js');
const productionPorts = await import('./production-capability-ports.js');
const shippedImplementations = await import('./shipped-implementation-identity.js');
const productionMcp = await import('./production-mcp-read-carrier.js');
const continuityRuntime = await import('./task-continuity-runtime.js');
const turnControl = await import('./turn-control.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');
const semanticCompile = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const expectedWorkContracts = await import('./expected-work-contract.js');
const expectedWorkAdmission = await import('./expected-work-admission.js');
const workCallTools = await import('../../tools/work-call.js');
const callToolTools = await import('../../tools/call-tool.js');
const workCallMode = await import('../../tools/work-call-mode.js');
const innerDispatch = await import('../../tools/inner-dispatch.js');
const mcpToolAuthority = await import('../mcp-tool-authority.js');
const capabilityResolution = await import('./capability-resolution.js');
const composioSchemas = await import('../../tools/composio-schema-cache.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');

test('returned nested-call repair requires exact zero-crossing invalid-arguments settlement truth', () => {
  const returnedAttempt = {
    outcome: { kind: 'invalid_arguments', directive: { action: 'repair_arguments' } },
  };
  const refused = {
    outcome: { kind: 'invalid_arguments', directive: { action: 'repair_arguments' } },
    executionKind: 'refused_pre_dispatch',
    physicalCrossingCount: 0,
    hostCrossingCount: 1,
  };
  assert.equal(isReturnedPreDispatchHostRefusalSettlement(returnedAttempt, refused), true);
  assert.equal(isReturnedPreDispatchHostRefusalSettlement({
    outcome: { kind: 'succeeded', directive: { action: 'settle' } },
  }, refused), false, 'the returned host attempt must independently carry argument-repair truth');
  assert.equal(isReturnedPreDispatchHostRefusalSettlement(returnedAttempt, {
    ...refused,
    outcome: { kind: 'succeeded', directive: { action: 'settle' } },
  }), false, 'successful returned calls are ordinary results, never repair refusals');
  assert.equal(isReturnedPreDispatchHostRefusalSettlement(returnedAttempt, {
    ...refused,
    physicalCrossingCount: 1,
  }), false, 'a provider crossing cannot be projected as a safe argument repair');
  assert.equal(isReturnedPreDispatchHostRefusalSettlement(returnedAttempt, {
    ...refused,
    hostCrossingCount: 2,
  }), false, 'multiple host crossings cannot be projected as one nested argument repair');
  assert.equal(isReturnedPreDispatchHostRefusalSettlement(returnedAttempt, {
    ...refused,
    outcome: { kind: 'invalid_arguments', directive: { action: 'settle' } },
  }), false, 'the immutable recovery directive must authorize argument repair');
});

test.after(() => {
  eventlog.closeEventLog();
  memoryDatabase.closeMemoryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{
    usage?: Record<string, unknown>;
    output?: unknown[];
    responseId?: string;
    providerData?: Record<string, unknown>;
  }> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = response.output ?? [];
  const finishReason = response.providerData?.status === 'incomplete'
    ? 'length'
    : output.some((item) => (item as { type?: string }).type === 'function_call')
      ? 'tool_calls'
      : 'stop';
  yield { type: 'response_started' } as never;
  yield { type: 'model', event: { type: 'finish', finishReason } } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId ?? 'test-response',
      usage: {
        inputTokens: Number(response.usage?.inputTokens ?? 0),
        outputTokens: Number(response.usage?.outputTokens ?? 0),
        totalTokens: Number(response.usage?.totalTokens ?? 0),
      },
      output,
      ...(response.providerData ? { providerData: response.providerData } : {}),
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

function capturingTextModel(text: string) {
  let call = 0;
  const requests: unknown[] = [];
  return {
    calls: () => call,
    requests,
    async getResponse(request: unknown) {
      requests.push(request);
      call += 1;
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output: [textMsg(text)],
        responseId: `captured-response-${call}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const textMsg = (text: string) => ({
  type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text }],
});
const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call', callId, name, arguments: JSON.stringify(args),
});

function dispositionMarkers(history: readonly unknown[]): Array<{
  disposition: string;
  effect: string;
  retry: string;
  requiresReconciliation: boolean;
}> {
  const markers: Array<{
    disposition: string;
    effect: string;
    retry: string;
    requiresReconciliation: boolean;
  }> = [];
  for (const item of history) {
    if ((item as { type?: string }).type !== 'function_call_result') continue;
    const output = (item as { output?: unknown }).output;
    const text = typeof output === 'string'
      ? output
      : output && typeof output === 'object'
        ? (output as { text?: unknown }).text
        : undefined;
    if (typeof text !== 'string') continue;
    try {
      const decoded = JSON.parse(text) as {
        protocol?: string;
        disposition?: string;
        effect?: string;
        retry?: string;
        requiresReconciliation?: boolean;
      };
      if (
        decoded.protocol === 'host_tool_disposition_v1'
        && typeof decoded.disposition === 'string'
        && typeof decoded.effect === 'string'
        && typeof decoded.retry === 'string'
        && typeof decoded.requiresReconciliation === 'boolean'
      ) {
        markers.push({
          disposition: decoded.disposition,
          effect: decoded.effect,
          retry: decoded.retry,
          requiresReconciliation: decoded.requiresReconciliation,
        });
      }
    } catch {
      // Ordinary tool results are not disposition markers.
    }
  }
  return markers;
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('Runner.run must not own the turn');
  };
  return runner;
}

let acceptedSerial = 0;
function acceptHostCanarySource(label: string) {
  const session = eventlog.createSession({
    id: `host-canary-${++acceptedSerial}-${label}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Exercise the ${label} host boundary.` },
  });
  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  };
  return {
    session,
    source,
    parent,
    context: { sessionId: session.id, sourceUserSeq: source.seq },
  };
}

type MaterialSourceBinding = NonNullable<ReturnType<
  typeof turnControl.validatedTurnSourceStrategyBinding
>>;

async function acceptMaterialSourceContinuation(input: {
  label: string;
  binding: MaterialSourceBinding;
  consumingDecision?: 'exact' | 'missing' | 'duplicate' | 'reforged' | 'mutated' | 'wrong_role' | 'mixed_role' | 'variant';
  reforgedBinding?: MaterialSourceBinding;
  omitParentDecision?: boolean;
  parentDecision?: 'exact' | 'wrong_turn' | 'mixed_turn';
}) {
  const session = eventlog.createSession({
    id: `host-material-source-${++acceptedSerial}-${input.label}`,
    kind: 'chat',
  });
  const objective = 'Collect the exact bound records and construct the requested artifact.';
  const question = 'Use the exact bound source for this collection?';
  const intentKey = `material-source-${input.label}`;
  const parentSource = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: objective },
  });
  if (!input.omitParentDecision) {
    const parentDecisionData = {
      phase: 'align',
      consequential: true,
      objective,
      intentKey,
      reason: 'collect_then_construct',
      confirmationDisposition: 'material_source_strategy',
      sourceStrategyPosture: 'materially_variant',
      sourceStrategyBinding: input.binding,
      sourceUserSeq: parentSource.seq,
    } as const;
    eventlog.appendEvent({
      sessionId: session.id,
      turn: input.parentDecision === 'wrong_turn' ? parentSource.turn : 0,
      role: 'system',
      type: 'turn_preflight_decision',
      data: parentDecisionData,
    });
    if (input.parentDecision === 'mixed_turn') {
      eventlog.appendEvent({
        sessionId: session.id,
        turn: parentSource.turn,
        role: 'system',
        type: 'turn_preflight_decision',
        data: parentDecisionData,
      });
    }
  }
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question,
      purpose: 'clarification',
      source: 'preflight_alignment',
      sourceUserSeq: parentSource.seq,
      intentKey,
      confirmationDisposition: 'material_source_strategy',
      sourceStrategyBinding: input.binding,
    },
  });
  const parentIdentity = { sessionId: session.id, turn: 1, sourceUserSeq: parentSource.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(parentIdentity),
    identity: parentIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: input.consumingDecision === 'variant' ? 'Use a different source instead.' : 'Yes' },
  });
  await continuityRuntime.enrichAcceptedRequestWithTaskContinuity({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    message: input.consumingDecision === 'variant' ? 'Use a different source instead.' : 'Yes',
  }, source.seq, {
    typedClassification: {
      disposition: input.consumingDecision === 'variant' ? 'provided' : 'affirmed',
    },
  });
  const inspection = continuityRuntime.inspectDurableMaterialSourceContinuation({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  if (input.consumingDecision === 'variant') {
    assert.equal(inspection.status, 'variant', JSON.stringify(inspection));
  } else if (input.omitParentDecision || input.parentDecision === 'wrong_turn' || input.parentDecision === 'mixed_turn') {
    assert.equal(inspection.status, 'refused');
  } else {
    assert.equal(inspection.status, 'verified', JSON.stringify(inspection));
    if (inspection.status === 'verified' && input.consumingDecision !== 'missing') {
      const decision = input.consumingDecision === 'reforged'
        ? { ...inspection.decision, sourceStrategyBinding: input.reforgedBinding }
        : input.consumingDecision === 'mutated'
          ? { ...inspection.decision, consequential: false }
          : inspection.decision;
      if (input.consumingDecision === 'wrong_role') {
        eventlog.appendEvent({
          sessionId: session.id,
          turn: 0,
          role: 'Clem',
          type: 'turn_preflight_decision',
          data: { ...decision, sourceUserSeq: source.seq },
        });
      } else {
        turnControl.recordTurnPreflightDecision(session.id, decision, source.seq);
      }
      if (input.consumingDecision === 'duplicate') {
        eventlog.appendEvent({
          sessionId: session.id,
          turn: 0,
          role: 'system',
          type: 'turn_preflight_decision',
          data: { ...decision, sourceUserSeq: source.seq },
        });
      }
      if (input.consumingDecision === 'mixed_role') {
        eventlog.appendEvent({
          sessionId: session.id,
          turn: 0,
          role: 'Clem',
          type: 'turn_preflight_decision',
          data: { ...decision, sourceUserSeq: source.seq },
        });
      }
    }
  }
  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:2`,
  };
  return {
    session,
    source,
    parent,
    context: { sessionId: session.id, sourceUserSeq: source.seq },
  };
}

function acceptFreshMaterialSource(input: {
  label: string;
  binding: MaterialSourceBinding;
  explicit: boolean;
}) {
  const session = eventlog.createSession({
    id: `host-fresh-material-source-${++acceptedSerial}-${input.label}`,
    kind: 'chat',
  });
  const text = input.explicit
    ? 'Pull the top 5 records from the Apify API and create one new spreadsheet.'
    : 'Find the top 5 records by rating and create one new spreadsheet.';
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const decision = turnControl.classifyTurnPreflight({
    message: text,
    sessionId: session.id,
    sessionKind: 'chat',
    sourceUserSeq: source.seq,
    sourceStrategyBinding: input.binding,
  });
  assert.equal(decision.reason, 'collect_then_construct');
  assert.equal(decision.sourceStrategyPosture,
    input.explicit ? 'confirmed_exact' : 'materially_variant');
  turnControl.recordTurnPreflightDecision(session.id, decision, source.seq);
  const inspection = continuityRuntime.inspectDurableMaterialSourceContinuation({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(inspection.status, 'refused', JSON.stringify(inspection));
  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  };
  return {
    session,
    source,
    parent,
    context: { sessionId: session.id, sourceUserSeq: source.seq },
  };
}

function runHostCanary(
  fixture: ReturnType<typeof acceptHostCanarySource>,
  agent: Record<string, unknown>,
) {
  return brackets.withHarnessRunContext(fixture.parent, () => productionHostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'exercise the boundary' }] as never,
    {
      maxTurns: 3,
      hostReadOnlyCanary: true,
      context: fixture.context,
    },
  ));
}

function runProductionHost(
  fixture: ReturnType<typeof acceptHostCanarySource>,
  agent: Record<string, unknown>,
  itemsOrState: unknown = [{
    type: 'message',
    role: 'user',
    content: fixture.source.data.text,
  }],
) {
  return brackets.withHarnessRunContext(fixture.parent, () => productionHostRunRunner(
    throwingRunner() as never,
    agent as never,
    itemsOrState as never,
    {
      maxTurns: 4,
      hostTurnEngine: 'host_v1',
      context: fixture.context,
    } as never,
  ));
}

test('production model provenance refuses input from outside the exact accepted source', async () => {
  const fixture = acceptHostCanarySource('foreign-model-input');
  const model = stubModel([[textMsg('must not dispatch')]]);
  const agent = { model, tools: [] };
  bindHostCanarySurface(fixture, agent, []);

  await assert.rejects(
    () => runProductionHost(fixture, agent, [{
      type: 'message',
      role: 'user',
      content: 'This text was never accepted for this source.',
    }]),
    (error: unknown) => error instanceof requestProvenance.ModelRequestProvenanceError
      && error.code === 'accepted_input_not_visible',
  );
  assert.equal(model.calls(), 0, 'foreign source text crossed the provider boundary');
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM model_request_provenance
     WHERE session_id = ? AND source_user_seq = ?
  `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0);
});

test('production model dispatch keeps sourceUserSeq-proven memory across event turn drift', async () => {
  const fixture = acceptHostCanarySource('proven-memory-dispatch');
  const primer = '[MEMORY PRIMER]\nThe durable preference for this request is teal.';
  const recallId = `host-proven-memory-${fixture.source.seq}`;
  memoryRecallUsage.recordRecallRun({
    id: recallId,
    objective: String(fixture.source.data.text),
    surface: 'turn_memory_primer',
    answerability: 'supported',
    candidateRefs: [],
    sessionId: fixture.session.id,
  });
  eventlog.appendEvent({
    sessionId: fixture.session.id,
    // The source sequence is the identity. A turn-number join would lose this
    // genuine primer before the provider boundary.
    turn: fixture.source.turn + 7,
    role: 'system',
    type: 'turn_memory_primer',
    data: {
      sourceUserSeq: fixture.source.seq,
      injected: true,
      injectedBytes: Buffer.byteLength(primer, 'utf8'),
      visibleTextSha256: sha256(primer),
      recallId,
    },
  });
  const model = capturingTextModel('I kept the verified memory and answered the request.');
  const agent = { model, tools: [] };
  bindHostCanarySurface(fixture, agent, []);

  await runProductionHost(fixture, agent, [
    { type: 'message', role: 'user', content: fixture.source.data.text },
    { role: 'system', content: primer },
  ]);

  assert.equal(model.calls(), 1);
  assert.equal(JSON.stringify(model.requests[0]).includes('The durable preference'), true,
    'the exact proven primer did not reach the model');
  const row = eventlog.openEventLog().prepare(`
    SELECT record_id FROM model_request_provenance
     WHERE session_id = ? AND source_user_seq = ?
  `).get(fixture.session.id, fixture.source.seq) as { record_id: string };
  const projected = requestProvenance.projectModelRequestProvenance(row.record_id);
  assert.equal(projected.status, 'ok', JSON.stringify(projected));
  if (projected.status === 'ok') {
    assert.equal(projected.manifest.verifiedMemory[0]?.recallId, recallId);
  }
});

test('production model dispatch removes one unproven whole primer and records sanitized bytes', async () => {
  const fixture = acceptHostCanarySource('unproven-memory-dispatch');
  const primer = '[MEMORY PRIMER]\nThese bytes have no durable recall source.';
  const model = capturingTextModel('I answered without the unproven optional context.');
  const agent = { model, tools: [] };
  bindHostCanarySurface(fixture, agent, []);

  await runProductionHost(fixture, agent, [
    { type: 'message', role: 'user', content: fixture.source.data.text },
    { role: 'system', content: primer },
  ]);

  assert.equal(model.calls(), 1);
  assert.equal(JSON.stringify(model.requests[0]).includes('[MEMORY PRIMER]'), false,
    'the unproven optional item crossed the provider boundary');
  const row = eventlog.openEventLog().prepare(`
    SELECT record_id, normalized_request_digest
      FROM model_request_provenance
     WHERE session_id = ? AND source_user_seq = ?
  `).get(fixture.session.id, fixture.source.seq) as {
    record_id: string;
    normalized_request_digest: string;
  };
  const projected = requestProvenance.projectModelRequestProvenance(row.record_id);
  assert.equal(projected.status, 'ok', JSON.stringify(projected));
  if (projected.status === 'ok') {
    assert.deepEqual(projected.manifest.verifiedMemory, []);
    assert.equal(projected.record.normalizedRequestDigest, row.normalized_request_digest);
  }
});

test('production model dispatch refuses an unsettled tool result before provider I/O', async () => {
  const fixture = acceptHostCanarySource('unsettled-result-dispatch');
  const model = capturingTextModel('must not dispatch');
  const agent = { model, tools: [] };
  bindHostCanarySurface(fixture, agent, []);
  const callId = `ambient-unsettled-${fixture.source.seq}`;

  await assert.rejects(
    () => runProductionHost(fixture, agent, [
      { type: 'message', role: 'user', content: fixture.source.data.text },
      { type: 'function_call', callId, name: 'unsettled_tool', arguments: '{}' },
      {
        type: 'function_call_result',
        callId,
        name: 'unsettled_tool',
        status: 'completed',
        output: { type: 'text', text: 'unsettled result bytes' },
      },
    ]),
    (error: unknown) => error instanceof requestProvenance.ModelRequestProvenanceError
      && error.code === 'ambient_unsettled_tool_result',
  );
  assert.equal(model.calls(), 0, 'an unsettled result reached the provider');
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM model_request_provenance
     WHERE session_id = ? AND source_user_seq = ?
  `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0);
});

function bindHostCanarySurface(
  fixture: ReturnType<typeof acceptHostCanarySource>,
  agent: object,
  tools: Array<{ name?: unknown; description?: unknown; parameters?: unknown }>,
): void {
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: fixture.session.id,
    universeTools: tools,
    activeToolNames: tools
      .map((entry) => typeof entry.name === 'string' ? entry.name : '')
      .filter(Boolean),
    policyHash: 'host-canary-test-policy-v1',
    budget: {
      maxUncachedTokens: 1_000,
      maxModelCalls: 8,
      maxToolCalls: 8,
      maxElapsedMs: 60_000,
    },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
}

function fusedPlanArgs(effect: 'read' | 'compute' | 'external_write' = 'read') {
  return {
    preamble: 'I’ll collect the exact records and then continue with the requested artifact.',
    draft: {
      criteria: ['Collect the exact requested records.'],
      construct: 'collect_then_construct',
      cardinality: null,
      destination: null,
      operations: [{
        id: 'root_operation',
        role: 'source',
        effect,
        capabilityRef: 'cap:fixture:root-operation',
        dependsOn: [],
        evidence: ['records'],
      }],
      deliverables: [],
      evidenceRequirements: ['records'],
    },
  };
}

function fusedWorkArgs(target = 'list_files') {
  return {
    requirement_id: 'root_operation',
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: target,
    args_json: '{}',
  };
}

function acceptHostTask(label: string) {
  const session = eventlog.createSession({ id: `host-settlement-${++acceptedSerial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Read the current ${label} records.` },
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

function commitHostSettlement(input: {
  task: ReturnType<typeof acceptHostTask>;
  callId: string;
  toolName: string;
  args: unknown;
  signals: Parameters<typeof outcomes.classifyAttemptOutcome>[0];
  executionKind?: 'refused_pre_dispatch' | 'local_execution';
  recovery?: { businessCall: boolean; mutating: boolean };
}) {
  const identity = {
    ...input.task,
    logicalToolCallId: input.callId,
  };
  assert.equal(dispatch.admitLogicalCall({
    identity,
    tool: input.toolName,
    args: input.args,
  }).status, 'inserted');
  const committed = settlements.commitLogicalCallSettlement({
    identity,
    contract: { toolName: input.toolName, args: input.args },
    execution: { kind: input.executionKind ?? 'refused_pre_dispatch' },
    outcome: outcomes.classifyAttemptOutcome(input.signals),
    recovery: input.recovery ?? { businessCall: true, mutating: false },
    observer: { lane: 'agents_runner', callId: input.callId, turn: 1 },
  });
  assert.equal(committed.status, 'committed');
  return committed.status === 'committed' ? committed.settlement : null;
}

test('host stepping: N host steps = N getResponse; tools run on host; hooks still fire', async () => {
  let toolRuns = 0;
  const model = stubModel([
    [toolCall('c1', 'ping', { q: 'x' })],
    [textMsg('all done')],
  ]);
  const agent = {
    model,
    instructions: 'base system',
    tools: [{
      type: 'function', name: 'ping', description: 'test', parameters: { type: 'object', properties: {} },
      invoke: async () => { toolRuns += 1; return 'pong'; },
      needsApproval: async () => false,
    }],
  };
  const runner = throwingRunner();
  const hookEvents: string[] = [];
  runner.on('agent_tool_start', () => hookEvents.push('tool_start'));
  runner.on('agent_tool_end', () => hookEvents.push('tool_end'));
  runner.on('agent_end', () => hookEvents.push('agent_end'));

  const outcome = await hostRunRunner(
    runner as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'go' }] as never,
    { maxTurns: 6, context: { sessionId: 'host-step-1' } },
  );

  assert.equal(model.calls(), 2, 'two host steps = two getResponse, nothing more');
  assert.equal(toolRuns, 1, 'the HOST executed the tool');
  assert.deepEqual(hookEvents, ['tool_start', 'tool_end', 'agent_end'], 'runner hooks fired without Runner.run');
  assert.equal(outcome.finalOutput, 'all done');
  assert.equal(outcome.hasInterruptions ?? false, false);
  const resultItem = outcome.history.find((item) => (item as { type?: string }).type === 'function_call_result');
  assert.ok(resultItem, 'the tool result rejoined the projection for the next step');
});

test('production host pairs a no-effect refusal when its durable ALS owner is absent', async () => {
  let bodies = 0;
  const model = stubModel([
    [toolCall('missing-owner-call', 'missing_owner_fixture', {})],
    [textMsg('continued after the paired no-effect refusal')],
  ]);
  const outcome = await productionHostRunRunner(
    throwingRunner() as never,
    {
      model,
      tools: [{
        type: 'function',
        name: 'missing_owner_fixture',
        description: 'ownership boundary fixture',
        parameters: { type: 'object', properties: {} },
        needsApproval: async () => false,
        invoke: async () => { bodies += 1; return 'must not run'; },
      }],
    } as never,
    [{ type: 'message', role: 'user', content: 'exercise ownership' }] as never,
    { maxTurns: 3 },
  );
  assert.equal(outcome.terminal, undefined);
  assert.equal(outcome.finalOutput, 'continued after the paired no-effect refusal');
  assert.equal(model.calls(), 2);
  assert.equal(bodies, 0);
  const calls = outcome.history.filter((item) => (
    (item as { type?: string }).type === 'function_call'
  )) as Array<{ callId?: string }>;
  const results = outcome.history.filter((item) => (
    (item as { type?: string }).type === 'function_call_result'
  )) as Array<{ callId?: string; output?: unknown }>;
  assert.deepEqual(calls.map((item) => item.callId), ['missing-owner-call']);
  assert.deepEqual(results.map((item) => item.callId), ['missing-owner-call']);
  assert.deepEqual(dispositionMarkers(outcome.history), [{
    disposition: 'refused_pre_dispatch',
    effect: 'none',
    retry: 'replan',
    requiresReconciliation: false,
  }]);
});

test('production host keeps the no-progress recovery directive out of the exact checkpoint chain', async () => {
  const fixture = acceptHostCanarySource('checkpoint-recovery-overlay');
  let bodies = 0;
  const recovery = {
    type: 'function' as const,
    name: 'plan_task',
    description: 'Exercise the permitted recovery control frame.',
    parameters: { type: 'object', properties: {} },
    needsApproval: async () => false,
    invoke: async () => { bodies += 1; return 'must not run'; },
  };
  const model = stubModel([
    [toolCall('checkpoint-before-recovery', recovery.name, {})],
    [toolCall('checkpoint-during-recovery', recovery.name, {})],
    // Exhaustion publishes retained state directly, before this unused prose.
    [textMsg('I could not find a way to run that step; here is what I have so far.')],
  ]);
  const agent = { model, tools: [recovery] };
  bindHostCanarySurface(fixture, agent, [recovery]);

  const outcome = await runProductionHost(fixture, agent);

  assert.equal(outcome.terminal?.reason, 'control_no_progress_exhausted');
  assert.notEqual(outcome.terminal?.resumable, false);
  assert.match(String(outcome.finalOutput), /Stopped at:.*\nNext:/,
    'the retained-state terminal names the current stage and a next edge');
  assert.doesNotMatch(String(outcome.finalOutput), /checkpoint|reconcil/i,
    'ordinary host bookkeeping is never rendered as a user-facing effect failure');
  assert.equal(model.calls(), 2, 'one repair attempt, then direct publication without a last-word call');
  assert.equal(bodies, 0, 'neither unowned fixture crosses its body boundary');
  assert.equal(
    eventlog.listEvents(fixture.session.id, { types: ['guardrail_tripped'] })
      .some((event) => event.data.kind === 'last_word_turn'),
    false,
    'exhaustion adds no last-word model turn',
  );
  const rows = eventlog.openEventLog().prepare(`
    SELECT admission.batch_ordinal, admission.call_ids_json,
           checkpoint.disposition, checkpoint.history_item_count
      FROM accepted_model_batch_admissions admission
      LEFT JOIN accepted_model_batch_checkpoints checkpoint
        ON checkpoint.session_id = admission.session_id
       AND checkpoint.source_user_seq = admission.source_user_seq
       AND checkpoint.batch_ordinal = admission.batch_ordinal
     WHERE admission.session_id = ? AND admission.source_user_seq = ?
     ORDER BY admission.batch_ordinal
  `).all(fixture.session.id, fixture.source.seq) as Array<{
    batch_ordinal: number;
    call_ids_json: string;
    disposition: string | null;
    history_item_count: number | null;
  }>;
  assert.deepEqual(rows.map((row) => ({
    ordinal: row.batch_ordinal,
    callIds: JSON.parse(row.call_ids_json),
    disposition: row.disposition,
  })), [
    { ordinal: 1, callIds: ['checkpoint-before-recovery'], disposition: 'ready' },
    { ordinal: 2, callIds: ['checkpoint-during-recovery'], disposition: 'ready' },
  ]);
  assert.ok(rows.every((row, index) => (
    index === 0 || row.history_item_count! > rows[index - 1]!.history_item_count!
  )), 'each checkpoint extends the exact prior balanced history');
});

test('production host turns an exact plan account choice into one question with no provider body', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const fixture = acceptHostCanarySource('plan-account-choice-recovery');
    let planBodies = 0;
    let providerBodies = 0;
    const accountChoices = ['work@corp.example', 'personal@example.net'];
    const planTool = brackets.wrapToolForHarness({
      type: 'function',
      name: 'plan_task',
      description: 'Admit the model-authored plan.',
      parameters: { type: 'object', additionalProperties: true },
      needsApproval: async () => false,
      invoke: async () => {
        planBodies += 1;
        return JSON.stringify({
          ok: false,
          code: 'account_selection_required',
          detail: 'Outlook Send Email is the matching write; ask which connected account to use.',
          question: 'Which connected account should I use?',
          accountChoices,
          repair: 'Ask the user which exact connected account to use. Do not pick a substitute write.',
        });
      },
    });
    const questionTool = brackets.wrapToolForHarness(buildAskUserQuestionTool() as never);
    const providerTool = {
      type: 'function' as const,
      name: 'provider_body_fixture',
      description: 'A business provider body that must stay behind the account choice.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      needsApproval: async () => false,
      invoke: async () => {
        providerBodies += 1;
        return 'must not run';
      },
    };
    const surfaces: string[][] = [];
    let modelCalls = 0;
    const model = {
      calls: () => modelCalls,
      async getResponse(request: { tools?: Array<{ name?: string }> }) {
        surfaces.push((request.tools ?? []).flatMap((entry) => (
          typeof entry.name === 'string' ? [entry.name] : []
        )));
        modelCalls += 1;
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: modelCalls === 1
            ? [toolCall('account-plan', 'plan_task', fusedPlanArgs('external_write'))]
            : [toolCall('account-question', 'ask_user_question', {
                question: 'Which connected account should I use?',
                options: accountChoices,
                purpose: 'clarification',
              })],
          responseId: `account-choice-response-${modelCalls}`,
        };
      },
      getStreamedResponse: testModelStream,
    };
    const tools = [planTool, questionTool, providerTool];
    const agent = { model, tools, toolUseBehavior: userChoiceToolUseBehavior };
    bindHostCanarySurface(fixture, agent, tools);

    const outcome = await runProductionHost(fixture, agent);

    assert.match(
      String(outcome.finalOutput),
      /^\[clementine:awaiting-user-input:final\]\nWhich connected account should I use\?/,
    );
    assert.equal(model.calls(), 2, 'one causal recovery step emits the question');
    assert.equal(planBodies, 1);
    assert.equal(providerBodies, 0, 'the unresolved account choice never enters a provider body');
    assert.ok(surfaces[0]?.includes('provider_body_fixture'));
    assert.deepEqual(surfaces[1], ['ask_user_question'],
      'the recovery surface contains only the exact user-input control');
    const questions = eventlog.listEvents(fixture.session.id, { types: ['awaiting_user_input'] });
    assert.equal(questions.length, 1);
    assert.deepEqual({
      question: questions[0]?.data.question,
      options: questions[0]?.data.options,
      purpose: questions[0]?.data.purpose,
    }, {
      question: 'Which connected account should I use?',
      options: accountChoices,
      purpose: 'clarification',
    });
    assert.deepEqual(eventlog.openEventLog().prepare(`
      SELECT outcome_kind, recovery_action, physical_crossing_count, host_crossing_count
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(fixture.session.id, fixture.source.seq, 'account-plan'), {
      outcome_kind: 'input_required',
      recovery_action: 'ask_user',
      physical_crossing_count: 0,
      host_crossing_count: 1,
    });
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('consequence-free dependency lookup and bounded authority retries retain available result readers', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const inertTool = (name: string) => ({
    type: 'function' as const,
    name,
    description: `${name} surface fixture`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    needsApproval: async () => false,
    invoke: async () => `${name} must not run`,
  });
  try {
    const lookupFixture = acceptHostCanarySource('dependency-lookup-reader-surface');
    let lookupBodies = 0;
    const lookup = brackets.wrapToolForHarness({
      type: 'function',
      name: 'file_query',
      description: 'Read one already-landed dependency result.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      needsApproval: async () => false,
      invoke: async () => {
        lookupBodies += 1;
        return { records: [{ id: 'landed-record', value: 42 }] };
      },
    });
    const lookupTools = [
      lookup,
      inertTool('tool_output_query'),
      inertTool('recall_tool_result'),
      inertTool('plan_task'),
    ];
    const lookupSurfaces: string[][] = [];
    let lookupModelCalls = 0;
    const lookupModel = {
      calls: () => lookupModelCalls,
      async getResponse(request: { tools?: Array<{ name?: string }> }) {
        lookupSurfaces.push((request.tools ?? []).flatMap((entry) => (
          typeof entry.name === 'string' ? [entry.name] : []
        )));
        lookupModelCalls += 1;
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: lookupModelCalls === 1
            ? [toolCall('landed-dependency-lookup', 'file_query', {})]
            : [textMsg('answered from the landed lookup')],
          responseId: `dependency-lookup-response-${lookupModelCalls}`,
        };
      },
      getStreamedResponse: testModelStream,
    };
    const lookupAgent = { model: lookupModel, tools: lookupTools };
    bindHostCanarySurface(lookupFixture, lookupAgent, lookupTools);

    const lookupOutcome = await runProductionHost(lookupFixture, lookupAgent);

    assert.equal(lookupOutcome.finalOutput, 'answered from the landed lookup');
    assert.equal(lookupBodies, 1);
    assert.equal(lookupModel.calls(), 2, 'the landed lookup receives exactly one bounded synthesis step');
    assert.ok(lookupSurfaces[1]?.includes('tool_output_query'),
      'the bounded synthesis step lost tool_output_query');
    assert.ok(lookupSurfaces[1]?.includes('recall_tool_result'),
      'the bounded synthesis step lost recall_tool_result');
    const lookupDelta = lookupOutcome.history.filter((item) => (
      (item as { callId?: unknown }).callId === 'landed-dependency-lookup'
    ));
    assert.deepEqual(noProgressProjection.projectHostNoProgressAttempt({
      sessionId: lookupFixture.session.id,
      sourceUserSeq: lookupFixture.source.seq,
      historyDelta: lookupDelta,
    }), { status: 'ok', attemptClass: 'dependency_lookup' });

    const authorityFixture = acceptHostCanarySource('authority-acquisition-control-surface');
    let authorityBodies = 0;
    const authorityLookup = brackets.wrapToolForHarness({
      type: 'function',
      name: 'tool_search',
      description: 'Acquire one bounded capability candidate.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      needsApproval: async () => false,
      invoke: async () => {
        authorityBodies += 1;
        // The production runner classifies attempts from this exact durable
        // admission fact, never from the model-authored discovery tool name.
        eventlog.appendEvent({
          sessionId: authorityFixture.session.id,
          turn: 1,
          role: 'system',
          type: 'discovery_governor_decision',
          data: {
            sourceUserSeq: authorityFixture.source.seq,
            callId: `authority-acquisition-${authorityBodies}`,
            decision: 'admitted',
          },
        });
        return { capabilities: [{ name: 'calendar_get', description: 'Read calendar data.' }] };
      },
    });
    const authorityTools = [
      authorityLookup,
      inertTool('tool_output_query'),
      inertTool('recall_tool_result'),
      inertTool('plan_task'),
    ];
    const authoritySurfaces: string[][] = [];
    let authorityModelCalls = 0;
    const authorityModel = {
      calls: () => authorityModelCalls,
      async getResponse(request: { tools?: Array<{ name?: string }> }) {
        authoritySurfaces.push((request.tools ?? []).flatMap((entry) => (
          typeof entry.name === 'string' ? [entry.name] : []
        )));
        authorityModelCalls += 1;
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: [toolCall(
            `authority-acquisition-${authorityModelCalls}`,
            'tool_search',
            { query: 'calendar operation' },
          )],
          responseId: `authority-acquisition-response-${authorityModelCalls}`,
        };
      },
      getStreamedResponse: testModelStream,
    };
    const authorityAgent = { model: authorityModel, tools: authorityTools };
    bindHostCanarySurface(authorityFixture, authorityAgent, authorityTools);

    const authorityOutcome = await runProductionHostSteps(authorityFixture, authorityAgent, 6);

    const authorityDelta = authorityOutcome.history.filter((item) => (
      (item as { callId?: unknown }).callId === 'authority-acquisition-1'
    ));
    assert.deepEqual(noProgressProjection.projectHostNoProgressAttempt({
      sessionId: authorityFixture.session.id,
      sourceUserSeq: authorityFixture.source.seq,
      historyDelta: authorityDelta,
    }), { status: 'ok', attemptClass: 'authority_acquisition' });
    assert.equal(authorityOutcome.terminal?.status, 'blocked');
    assert.equal(authorityOutcome.terminal?.reason, 'control_no_progress_exhausted');
    assert.notEqual(authorityOutcome.terminal?.resumable, false);
    assert.equal(authorityModel.calls(), 5, 'one binding gain plus the bounded no-progress retry sequence');
    assert.deepEqual(authoritySurfaces[1], authoritySurfaces[0],
      'a consequence-free retry retains the tools that can discover or consume evidence');
    assert.equal(authorityBodies, 5, 'unchanged discovery stops when its finite budget is exhausted');
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('a local checkpoint-store failure holds privately and exact recovery never reexecutes the frame', async () => {
  const fixture = acceptHostCanarySource('result-checkpoint-containment');
  let bodies = 0;
  const model = stubModel([
    [toolCall('uncheckpointable-result', 'missing_owner_fixture', {})],
    [textMsg('must not reach a later model request')],
  ]);
  const configured = {
    type: 'function',
    name: 'missing_owner_fixture',
    description: 'ownership boundary fixture',
    parameters: { type: 'object', properties: {} },
    needsApproval: async () => false,
    invoke: async () => { bodies += 1; return 'must not run'; },
  };
  const agent = { model, tools: [configured] };
  bindHostCanarySurface(fixture, agent, [configured]);

  const db = eventlog.openEventLog();
  const trigger = `reject_host_result_checkpoint_${acceptedSerial}`;
  const sessionId = fixture.session.id.replaceAll("'", "''");
  db.exec(`
    CREATE TEMP TRIGGER ${trigger}
    BEFORE INSERT ON accepted_model_batch_checkpoints
    WHEN NEW.session_id = '${sessionId}'
    BEGIN
      SELECT RAISE(ABORT, 'fixture checkpoint unavailable');
    END
  `);
  let outcome: Awaited<ReturnType<typeof runProductionHost>>;
  try {
    outcome = await runProductionHost(fixture, agent);
  } finally {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }

  assert.equal(outcome.terminal, undefined);
  assert.deepEqual(outcome.hold, {
    owner: 'host',
    wake: 'recovery',
    reason: 'recovery_pending',
  });
  assert.equal(outcome.finalOutput, undefined, 'local bookkeeping authors no public retry text');
  assert.ok(outcome.serializedRecoveryState);
  assert.equal(model.calls(), 1, 'unsettled result bytes cannot reach another model request');
  assert.equal(bodies, 0, 'the no-effect refusal never enters its tool body');
  assert.equal(outcome.lastResponseId, undefined, 'the uncheckpointed response id is not adopted');
  assert.equal(
    outcome.history.filter((item) => (
      (item as { type?: string }).type === 'function_call_result'
    )).length,
    0,
    'result bytes without a balanced checkpoint never enter model-visible history',
  );
  assert.deepEqual(db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM accepted_model_batch_admissions
        WHERE session_id = ? AND source_user_seq = ?) AS admissions,
      (SELECT COUNT(*) FROM host_model_result_receipts
        WHERE session_id = ? AND source_user_seq = ?) AS receipts,
      (SELECT COUNT(*) FROM accepted_model_batch_checkpoints
        WHERE session_id = ? AND source_user_seq = ?) AS checkpoints
  `).get(
    fixture.session.id,
    fixture.source.seq,
    fixture.session.id,
    fixture.source.seq,
    fixture.session.id,
    fixture.source.seq,
  ), {
    admissions: 1,
    receipts: 1,
    checkpoints: 0,
  }, 'accepted call/result accounting remains durable for host recovery');
  assert.equal(eventlog.listEvents(fixture.session.id, {
    types: ['conversation_completed', 'awaiting_user_input', 'approval_requested'],
  }).length, 0, 'the private hold emits no public terminal, question, or card');

  const recovery = HostRecoveryState.fromString(outcome.serializedRecoveryState!);
  const resumed = await runProductionHost(fixture, agent, recovery);
  assert.equal(resumed.finalOutput, undefined,
    'checkpoint recovery cannot smuggle a next model request past ordinary context assembly');
  assert.deepEqual(resumed.hold, {
    owner: 'host',
    wake: 'recovery',
    reason: 'recovery_pending',
  });
  assert.equal(resumed.terminal, undefined);
  assert.equal(bodies, 0, 'checkpoint recovery never re-enters the refused tool body');
  assert.equal(model.calls(), 1, 'recovery finalizes bytes without dispatching another model');
  const continuation = HostRecoveryState.fromString(resumed.serializedRecoveryState!);
  assert.equal(continuation.phase, 'continue');
  assert.deepEqual(continuation.frameHistory, []);
  assert.deepEqual(continuation.resultItems, []);
  assert.equal(continuation.acceptedModelBatchRef?.batchId, recovery.acceptedModelBatchRef?.batchId,
    'the private continuation keeps the exact accepted-batch identity');
  assert.deepEqual(db.prepare(`
    SELECT batch_ordinal, disposition FROM accepted_model_batch_checkpoints
     WHERE session_id = ? AND source_user_seq = ?
  `).all(fixture.session.id, fixture.source.seq), [{
    batch_ordinal: 1,
    disposition: 'ready',
  }]);
});

test('a successful logical result receipt failure recovers exact bytes without rerunning its body', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const fixture = acceptHostCanarySource('logical-result-receipt-containment');
    let bodies = 0;
    const readTool = brackets.wrapToolForHarness({
      type: 'function',
      name: 'task_list',
      description: 'Return one exact local task-list result.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      needsApproval: async () => false,
      invoke: async () => {
        bodies += 1;
        return { records: [{ id: 'task-1', title: 'Keep the exact settled bytes' }] };
      },
    });
    const model = stubModel([
      [toolCall('logical-result-receipt-call', 'task_list', {})],
      [textMsg('continued after exact receipt recovery')],
    ]);
    const agent = { model, tools: [readTool] };
    bindHostCanarySurface(fixture, agent, [readTool]);

    const db = eventlog.openEventLog();
    const trigger = `reject_logical_projection_receipt_${acceptedSerial}`;
    const sessionId = fixture.session.id.replaceAll("'", "''");
    db.exec(`
      CREATE TEMP TRIGGER ${trigger}
      BEFORE INSERT ON logical_model_result_projection_receipts
      WHEN NEW.session_id = '${sessionId}'
      BEGIN
        SELECT RAISE(ABORT, 'fixture projection receipt unavailable');
      END
    `);
    let held: Awaited<ReturnType<typeof runProductionHost>>;
    try {
      held = await runProductionHost(fixture, agent);
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }

    assert.deepEqual(held.hold, {
      owner: 'host',
      wake: 'recovery',
      reason: 'recovery_pending',
    });
    assert.equal(held.terminal, undefined);
    assert.equal(held.finalOutput, undefined);
    assert.equal(bodies, 1, 'the successful local body crossed exactly once');
    assert.equal(model.calls(), 1, 'uncheckpointed result bytes never reach another model');
    const recovery = HostRecoveryState.fromString(held.serializedRecoveryState!);
    assert.equal(recovery.phase, 'finalize');
    assert.deepEqual(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM logical_call_settlements
          WHERE session_id = ? AND source_user_seq = ?
            AND outcome_kind = 'succeeded') AS settlements,
        (SELECT COUNT(*) FROM logical_model_result_projection_receipts
          WHERE session_id = ? AND source_user_seq = ?) AS receipts,
        (SELECT COUNT(*) FROM accepted_model_batch_checkpoints
          WHERE session_id = ? AND source_user_seq = ?) AS checkpoints
    `).get(
      fixture.session.id,
      fixture.source.seq,
      fixture.session.id,
      fixture.source.seq,
      fixture.session.id,
      fixture.source.seq,
    ), { settlements: 1, receipts: 0, checkpoints: 0 });

    const recovered = await runProductionHost(fixture, agent, recovery);
    assert.deepEqual(recovered.hold, {
      owner: 'host',
      wake: 'recovery',
      reason: 'recovery_pending',
    });
    assert.equal(HostRecoveryState.fromString(recovered.serializedRecoveryState!).phase, 'continue');
    assert.equal(bodies, 1, 'receipt/checkpoint recovery never re-enters the settled body');
    assert.equal(model.calls(), 1, 'recovery performs no model replay');
    assert.deepEqual(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM logical_model_result_projection_receipts
          WHERE session_id = ? AND source_user_seq = ?) AS receipts,
        (SELECT COUNT(*) FROM accepted_model_batch_checkpoints
          WHERE session_id = ? AND source_user_seq = ?
            AND disposition = 'ready') AS checkpoints
    `).get(
      fixture.session.id,
      fixture.source.seq,
      fixture.session.id,
      fixture.source.seq,
    ), { receipts: 1, checkpoints: 1 });
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('runTurn persists, wakes, adopts, and continues one exact post-body recovery', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const fixture = acceptHostCanarySource('persisted-logical-result-recovery');
    let bodies = 0;
    const readTool = brackets.wrapToolForHarness({
      type: 'function',
      name: 'task_list',
      description: 'Return one local task list.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      needsApproval: async () => false,
      invoke: async () => {
        bodies += 1;
        return { records: [{ id: 'task-1', title: 'Persist exact recovery' }] };
      },
    });
    const model = stubModel([
      [toolCall('persisted-recovery-call', 'task_list', {})],
      [textMsg('continued after durable checkpoint adoption')],
    ]);
    const agent = { model, tools: [readTool] };
    bindHostCanarySurface(fixture, agent, [readTool]);
    const turnOptions = {
      sessionId: fixture.session.id,
      input: String(fixture.source.data.text),
      sourceUserSeq: fixture.source.seq,
      reuseRecordedUserInput: true as const,
      suppressMemoryCapture: true,
      turnEngine: 'host_v1' as const,
      agent: agent as never,
      makeRunner: () => throwingRunner() as never,
      maxTurns: 4,
    };

    const db = eventlog.openEventLog();
    const trigger = `reject_persisted_projection_receipt_${acceptedSerial}`;
    const sessionId = fixture.session.id.replaceAll("'", "''");
    db.exec(`
      CREATE TEMP TRIGGER ${trigger}
      BEFORE INSERT ON logical_model_result_projection_receipts
      WHEN NEW.session_id = '${sessionId}'
      BEGIN
        SELECT RAISE(ABORT, 'fixture persisted projection unavailable');
      END
    `);
    let first: Awaited<ReturnType<typeof runTurn>>;
    try {
      first = await runTurn(turnOptions);
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    assert.equal(first.status, 'held', JSON.stringify(first));
    assert.deepEqual(first.hold, { owner: 'host', wake: 'recovery', reason: 'recovery_pending' });
    assert.equal(HostRecoveryState.fromString(
      HarnessSession.load(fixture.session.id)!.loadRecoveryState()!,
    ).phase, 'finalize');
    assert.equal(bodies, 1);
    assert.equal(model.calls(), 1);
    assert.equal(eventlog.listEvents(fixture.session.id, {
      types: ['conversation_completed', 'awaiting_user_input', 'approval_requested'],
    }).length, 0, 'the durable bookkeeping owner produces no public terminal or card');

    const second = await runTurn(turnOptions);
    assert.equal(second.status, 'held', JSON.stringify(second));
    assert.equal(HostRecoveryState.fromString(
      HarnessSession.load(fixture.session.id)!.loadRecoveryState()!,
    ).phase, 'continue');
    assert.equal(bodies, 1, 'finalization wake never re-enters the body');
    assert.equal(model.calls(), 1, 'finalization wake never replays the model');

    const completed = await runTurn(turnOptions);
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.equal(bodies, 1);
    assert.equal(model.calls(), 2,
      'only the ordinary model continuation runs after atomic checkpoint adoption');
    assert.equal(HarnessSession.load(fixture.session.id)?.loadRecoveryState(), null);
    const providerHistory = HarnessSession.load(fixture.session.id)?.prepareProviderHistory();
    assert.equal(providerHistory?.status, 'ready');
    if (providerHistory?.status === 'ready') {
      assert.equal(providerHistory.providerHistory.filter((item) => {
        const row = item as unknown as { role?: unknown; content?: unknown };
        return row.role === 'user' && row.content === fixture.source.data.text;
      }).length, 1, 'same-source continuation does not duplicate the accepted user message');
    }
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('a tool-output guardrail projection is sealed before checkpoint and next-model provenance', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const fixture = acceptHostCanarySource('guardrail-result-projection');
    let bodies = 0;
    const guardedRead = brackets.wrapToolForHarness({
      type: 'function',
      name: 'task_list',
      description: 'Return a local result whose public projection is guarded.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      needsApproval: async () => false,
      outputGuardrails: [{
        name: 'redact-private-tool-output',
        run: async () => ({
          behavior: { type: 'rejectContent' as const, message: 'The private fields were redacted.' },
        }),
      }],
      invoke: async () => {
        bodies += 1;
        return { privateToken: 'never-project-this-value', records: [{ id: 'task-1' }] };
      },
    });
    const seenInputs: unknown[][] = [];
    let modelCall = 0;
    const model = {
      calls: () => modelCall,
      async getResponse(request: { input?: unknown }) {
        seenInputs.push(structuredClone(Array.isArray(request.input) ? request.input : []));
        modelCall += 1;
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: modelCall === 1
            ? [toolCall('guarded-result-call', 'task_list', {})]
            : [textMsg('continued from the redacted result')],
          responseId: `guarded-result-response-${modelCall}`,
        };
      },
      getStreamedResponse: testModelStream,
    };
    const agent = { model, tools: [guardedRead] };
    bindHostCanarySurface(fixture, agent, [guardedRead]);

    const outcome = await runProductionHost(fixture, agent);
    assert.equal(outcome.finalOutput, 'continued from the redacted result');
    assert.equal(bodies, 1);
    const visibleResult = (seenInputs[1] ?? []).find((item) => (
      (item as { type?: unknown }).type === 'function_call_result'
    ));
    assert.match(JSON.stringify(visibleResult), /private fields were redacted/);
    assert.doesNotMatch(JSON.stringify(visibleResult), /never-project-this-value/);

    const db = eventlog.openEventLog();
    const receipt = db.prepare(`
      SELECT receipt_id, result_class, result_item_sha256
        FROM logical_model_result_projection_receipts
       WHERE session_id = ? AND source_user_seq = ? AND call_id = ?
    `).get(
      fixture.session.id,
      fixture.source.seq,
      'guarded-result-call',
    ) as { receipt_id: string; result_class: string; result_item_sha256: string };
    assert.equal(receipt.result_class, 'text');
    assert.equal(receipt.result_item_sha256,
      logicalProjectionReceipts.logicalModelResultItemDigest(visibleResult as never),
      'the receipt seals the exact transformed whole result item');
    const provenanceRow = db.prepare(`
      SELECT record_id, provenance_json FROM model_request_provenance
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY request_ordinal DESC LIMIT 1
    `).get(fixture.session.id, fixture.source.seq) as {
      record_id: string;
      provenance_json: string;
    };
    assert.equal(JSON.parse(provenanceRow.provenance_json).settledResults[0]?.projectionReceiptId,
      receipt.receipt_id, 'the next request cites the same immutable result projection receipt');
    assert.equal(requestProvenance.projectModelRequestProvenance(provenanceRow.record_id).status, 'ok');
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('runTurn selects the production host_v1_read_only engine without an injected runRunner', async () => {
  const previous = process.env.CLEMMY_TURN_ENGINE;
  process.env.CLEMMY_TURN_ENGINE = 'host_v1_read_only';
  try {
    const session = eventlog.createSession({ id: 'host-production-selection', kind: 'chat' });
    const model = stubModel([[textMsg('selected host engine')]]);
    let runnerCalls = 0;
    const makeRunner = () => {
      const runner = new EventEmitter();
      (runner as unknown as { run: () => never }).run = () => {
        runnerCalls += 1;
        throw new Error('legacy Runner.run must be unreachable');
      };
      return runner as never;
    };
    const outcome = await runTurn({
      sessionId: session.id,
      input: 'hello',
      agent: { model, instructions: 'base system', tools: [] } as never,
      makeRunner,
      maxTurns: 3,
    });
    assert.equal(outcome.status, 'completed');
    assert.equal(runnerCalls, 0, 'the selector bypassed legacy Runner.run');
    const selected = eventlog.listEvents(session.id, { types: ['turn_engine_selected'] });
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.data.engine, 'host_v1_read_only');
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_TURN_ENGINE;
    else process.env.CLEMMY_TURN_ENGINE = previous;
  }
});

test('fresh chat selects production host_v1, bypasses the SDK loop, and closes one graphless root', async () => {
  const previous = process.env.CLEMMY_TURN_ENGINE;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const emptyCatalog = capabilityCatalogs.createHostCapabilityCatalogFactory();
  let catalogSnapshots = 0;
  capabilityCatalogs.installHostCapabilityCatalogFactory({
    ...emptyCatalog,
    snapshot() {
      catalogSnapshots += 1;
      return emptyCatalog.snapshot();
    },
  });
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  try {
    const session = eventlog.createSession({ id: `host-v1-production-selection-${++acceptedSerial}`, kind: 'chat' });
    const model = stubModel([[textMsg(JSON.stringify({
      summary: 'production host selected',
      reply: 'production host selected',
      done: true,
      nextAction: 'completed',
      reason: null,
    }))]]);
    let legacyRunnerCalls = 0;
    const outcome = await runConversation({
      sessionId: session.id,
      input: 'hello from a fresh chat',
      turnEngine: 'host_v1',
      maxSteps: 1,
      judgeCompletion: false,
      buildAgent: async () => ({ model, instructions: 'base system', tools: [] } as never),
      makeRunner: () => {
        const runner = new EventEmitter();
        (runner as unknown as { run: () => never }).run = () => {
          legacyRunnerCalls += 1;
          throw new Error('legacy Runner.run must be unreachable');
        };
        return runner as never;
      },
      maxTurns: 3,
    });
    assert.equal(
      outcome.status,
      'completed',
      JSON.stringify(eventlog.listEvents(session.id).map((event) => ({
        type: event.type,
        data: event.data,
      }))),
    );
    assert.equal(outcome.publicPresentation?.text, 'production host selected');
    assert.equal(legacyRunnerCalls, 0);
    assert.equal(model.calls(), 1);
    const selected = eventlog.listEvents(session.id, { types: ['turn_engine_selected'] });
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.data.engine, 'host_v1');
    const source = eventlog.listEvents(session.id, { types: ['user_input_received'] })
      .find((event) => event.data.synthetic !== true);
    assert.ok(source);
    const root = callAuthorities.acceptedTurnCallAuthorityFor(session.id, source.seq);
    assert.equal(root.status, 'ok');
    if (root.status === 'ok') {
      assert.equal(root.authority.authorityKind, 'host_v1');
      assert.equal(root.authority.state, 'closed');
      assert.equal(root.authority.closeReason, 'host_completed');
    }
    assert.equal(eventlog.listEvents(session.id, { types: ['turn_graph_shadow'] }).length, 0);
    assert.equal(eventlog.listEvents(session.id, { types: ['conversation_step'] }).length, 0);
    assert.equal(eventlog.listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
    assert.equal(catalogSnapshots, 0, 'an empty model surface never consults the mutable catalog');
    const catalogRows = eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM accepted_source_catalog_snapshots
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as { n: number };
    assert.equal(catalogRows.n, 0, 'plain chat never persists a capability-catalog snapshot');
  } finally {
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (previous === undefined) delete process.env.CLEMMY_TURN_ENGINE;
    else process.env.CLEMMY_TURN_ENGINE = previous;
  }
});

// ASK marker terminal misfiling (live 2026-08-23, session
// sess-mob-00dbfe2e9d6854e2753246a37bedc0ef): the host turn runner reports a
// plain reply as RunTurnStatus 'completed' no matter what the model wrote, so
// hostActivationConversationResult used to treat an "ASK: <question>" reply
// as a finished answer instead of parsing the model's own marker contract
// (ORCHESTRATOR_DECISION_CONTRACT, clem-rubric.ts). The three tests below pin
// the fix: an ASK: marker pauses for the user, a no-marker reply still
// completes, and a CONTINUE: marker still means continue, never ask.
test('a plain-text ASK: marker under the host engine pauses for the user instead of shipping as a finished answer', async () => {
  const previous = process.env.CLEMMY_TURN_ENGINE;
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  try {
    const session = eventlog.createSession({ id: `host-v1-ask-marker-${++acceptedSerial}`, kind: 'chat' });
    const askText = 'I found your "platform-49-slack-channel-review" workflow. Do you want me to kick it off now?';
    const model = stubModel([[textMsg(`ASK: ${askText}`)]]);
    const outcome = await runConversation({
      sessionId: session.id,
      input: 'hello from a fresh chat',
      turnEngine: 'host_v1',
      maxSteps: 1,
      judgeCompletion: false,
      buildAgent: async () => ({ model, instructions: 'base system', tools: [] } as never),
      makeRunner: () => {
        const runner = new EventEmitter();
        (runner as unknown as { run: () => never }).run = () => {
          throw new Error('legacy Runner.run must be unreachable');
        };
        return runner as never;
      },
      maxTurns: 3,
    });
    assert.equal(
      outcome.status,
      'awaiting_user_input',
      'an explicit ASK: marker must pause for the user, never ship as a finished answer',
    );
    assert.equal(outcome.publicPresentation?.status, 'needs_input');
    assert.equal(outcome.publicPresentation?.kind, 'question');
    assert.equal(
      outcome.publicPresentation?.text,
      askText,
      'the "ASK: " prefix must be stripped from the delivered question',
    );
    const terminals = eventlog.listEvents(session.id, { types: ['conversation_completed'] });
    assert.equal(terminals.length, 1);
    const data = terminals[0]!.data as {
      presentation?: { status?: string; kind?: string; text?: string; needs?: unknown };
      awaitingUser?: boolean;
    };
    assert.equal(data.presentation?.status, 'needs_input');
    assert.equal(data.presentation?.kind, 'question');
    assert.ok(!String(data.presentation?.text ?? '').startsWith('ASK'));
    assert.deepEqual(data.presentation?.needs, { kind: 'input' });
    assert.equal(data.awaitingUser, true);
    // The raw awaiting_user_input event must exist too — clarification
    // continuity (task-continuity-runtime.ts) and event-stream surfaces
    // (Discord, desktop SSE) read that event, not just the terminal text.
    const asks = eventlog.listEvents(session.id, { types: ['awaiting_user_input'] });
    assert.equal(asks.length, 1);
    assert.equal(asks[0]?.data.question, askText);
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_TURN_ENGINE;
    else process.env.CLEMMY_TURN_ENGINE = previous;
  }
});

test('a plain no-marker reply under the host engine still terminates as a completed answer', async () => {
  const previous = process.env.CLEMMY_TURN_ENGINE;
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  try {
    const session = eventlog.createSession({ id: `host-v1-no-marker-${++acceptedSerial}`, kind: 'chat' });
    const replyText = 'The meeting is scheduled for 3pm tomorrow in the downtown office.';
    const model = stubModel([[textMsg(replyText)]]);
    const outcome = await runConversation({
      sessionId: session.id,
      input: 'hello from a fresh chat',
      turnEngine: 'host_v1',
      maxSteps: 1,
      judgeCompletion: false,
      buildAgent: async () => ({ model, instructions: 'base system', tools: [] } as never),
      makeRunner: () => {
        const runner = new EventEmitter();
        (runner as unknown as { run: () => never }).run = () => {
          throw new Error('legacy Runner.run must be unreachable');
        };
        return runner as never;
      },
      maxTurns: 3,
    });
    assert.equal(outcome.status, 'completed', 'fail-open: a no-marker reply is still a completed answer');
    assert.equal(outcome.publicPresentation?.status, 'done');
    assert.equal(outcome.publicPresentation?.kind, 'answer');
    assert.equal(outcome.publicPresentation?.text, replyText);
    assert.equal(eventlog.listEvents(session.id, { types: ['awaiting_user_input'] }).length, 0);
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_TURN_ENGINE;
    else process.env.CLEMMY_TURN_ENGINE = previous;
  }
});

test('a CONTINUE: marker under the host engine still means continue, never ask', async () => {
  const previous = process.env.CLEMMY_TURN_ENGINE;
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  try {
    const session = eventlog.createSession({ id: `host-v1-continue-marker-${++acceptedSerial}`, kind: 'chat' });
    const model = stubModel([[textMsg('CONTINUE: still checking the calendar for conflicts')]]);
    const outcome = await runConversation({
      sessionId: session.id,
      input: 'hello from a fresh chat',
      turnEngine: 'host_v1',
      maxSteps: 1,
      judgeCompletion: false,
      buildAgent: async () => ({ model, instructions: 'base system', tools: [] } as never),
      makeRunner: () => {
        const runner = new EventEmitter();
        (runner as unknown as { run: () => never }).run = () => {
          throw new Error('legacy Runner.run must be unreachable');
        };
        return runner as never;
      },
      maxTurns: 3,
    });
    assert.notEqual(outcome.status, 'awaiting_user_input', 'CONTINUE: must never be treated as an ask');
    assert.equal(eventlog.listEvents(session.id, { types: ['awaiting_user_input'] }).length, 0);
    const text = outcome.publicPresentation?.text ?? '';
    assert.ok(!/^CONTINUE/i.test(text), `the "CONTINUE: " prefix must never leak verbatim: ${JSON.stringify(text)}`);
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_TURN_ENGINE;
    else process.env.CLEMMY_TURN_ENGINE = previous;
  }
});

test('fresh host chat enters the host loop before semantic graphs and commits one exact terminal', async () => {
  const previous = process.env.CLEMMY_TURN_ENGINE;
  process.env.CLEMMY_TURN_ENGINE = 'host_v1_read_only';
  try {
    const session = eventlog.createSession({ id: 'host-production-entry', kind: 'chat' });
    const model = stubModel([[textMsg(JSON.stringify({
      summary: 'HOST ENGINE READY',
      reply: 'HOST ENGINE READY',
      done: true,
      nextAction: 'completed',
      reason: null,
    }))]]);
    let builds = 0;
    let builtIdentity: { sessionId: string; sourceUserSeq: number; route?: string } | undefined;
    let legacyRunnerCalls = 0;
    const result = await runConversation({
      sessionId: session.id,
      input: 'Reply with exactly: HOST ENGINE READY',
      turnEngine: 'host_v1_read_only',
      maxSteps: 1,
      judgeCompletion: false,
      buildAgent: async (identity) => {
        builds += 1;
        builtIdentity = identity;
        return { model, instructions: 'base system', tools: [] } as never;
      },
      makeRunner: () => {
        const runner = new EventEmitter();
        (runner as unknown as { run: () => never }).run = () => {
          legacyRunnerCalls += 1;
          throw new Error('legacy Runner.run must be unreachable');
        };
        return runner as never;
      },
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.publicPresentation?.text, 'HOST ENGINE READY');
    assert.equal(builds, 1);
    assert.equal(legacyRunnerCalls, 0);
    assert.equal(builtIdentity?.sessionId, session.id);
    assert.ok(Number.isSafeInteger(builtIdentity?.sourceUserSeq));
    assert.equal(builtIdentity?.route, undefined, 'the host builder receives no fabricated semantic route');
    assert.equal(model.calls(), 1);

    const events = eventlog.listEvents(session.id);
    assert.equal(events.filter((event) => event.type === 'turn_engine_selected').length, 1);
    assert.equal(events.filter((event) => event.type === 'conversation_completed').length, 1);
    assert.equal(events.filter((event) => event.type === 'conversation_step').length, 0,
      'the host activation is not wrapped in the legacy auto-continuation loop');
    assert.equal(events.filter((event) => event.type === 'verdict_recorded').length, 0,
      'legacy completion judges cannot reopen a host-owned answer');
    assert.equal(events.filter((event) => event.type === 'turn_preflight_decision').length, 0);
    assert.equal(events.filter((event) => event.type === 'capability_resolution').length, 0);
    assert.equal(events.filter((event) => event.type === 'turn_semantics_interpreted').length, 0);
    assert.equal(events.filter((event) => event.type === 'turn_graph_shadow').length, 0);
    assert.equal(events.filter((event) => event.type === 'accepted_task_authority_armed').length, 0);
    assert.equal(events.filter((event) => event.type === 'logical_tool_call_admitted').length, 0);
    const source = events.find((event) => event.type === 'user_input_received' && event.data.synthetic !== true);
    assert.ok(source);
    for (const event of events.filter((entry) =>
      entry.type === 'turn_engine_selected' || entry.type === 'conversation_completed')) {
      assert.equal(event.data.sourceUserSeq, source.seq);
    }
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_TURN_ENGINE;
    else process.env.CLEMMY_TURN_ENGINE = previous;
  }
});

test('fresh chat, workflow, execution, and agent sessions all enter one graphless host owner by default', async () => {
  const previous = process.env.CLEMMY_TURN_ENGINE;
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  try {
    for (const kind of ['chat', 'workflow', 'execution', 'agent'] as const) {
      const session = eventlog.createSession({
        id: `host-v1-fresh-kind-${kind}-${++acceptedSerial}`,
        kind,
      });
      const model = stubModel([[textMsg(JSON.stringify({
        summary: `${kind} host selected`,
        reply: `${kind} host selected`,
        done: true,
        nextAction: 'completed',
        reason: null,
      }))]]);
      let legacyRunnerCalls = 0;
      const result = await runConversation({
        sessionId: session.id,
        input: `Return the ${kind} completion receipt.`,
        maxSteps: 1,
        maxTurns: 3,
        judgeCompletion: false,
        buildAgent: async (identity) => {
          assert.equal(identity.route, undefined, `${kind}: host construction receives no legacy semantic route`);
          return { model, instructions: 'base system', tools: [] } as never;
        },
        makeRunner: () => {
          const runner = new EventEmitter();
          (runner as unknown as { run: () => never }).run = () => {
            legacyRunnerCalls += 1;
            throw new Error('legacy Runner.run must be unreachable');
          };
          return runner as never;
        },
      });

      assert.equal(result.status, 'completed', `${kind}: ${result.error ?? ''}`);
      assert.equal(result.publicPresentation?.text, `${kind} host selected`);
      assert.equal(legacyRunnerCalls, 0, `${kind}: no legacy model owner`);
      assert.equal(model.calls(), 1, `${kind}: one host model activation`);
      const events = eventlog.listEvents(session.id);
      const selected = events.filter((event) => event.type === 'turn_engine_selected');
      assert.equal(selected.length, 1, `${kind}: one exact owner`);
      assert.equal(selected[0]?.data.engine, 'host_v1');
      assert.equal(selected[0]?.data.resumed, false);
      assert.equal(events.filter((event) => event.type === 'turn_graph_shadow').length, 0,
        `${kind}: fresh host ownership cannot enter the legacy semantic graph`);
      assert.equal(events.filter((event) => event.type === 'conversation_completed').length, 1,
        `${kind}: one terminal`);
    }
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_TURN_ENGINE;
    else process.env.CLEMMY_TURN_ENGINE = previous;
  }
});

test('fresh-plan model frames refuse unsafe siblings before any plan or sibling crossing', async (t) => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const cases: Array<{
      label: string;
      calls: unknown[];
    }> = [
      {
        label: 'write-sibling',
        calls: [
          toolCall('plan', 'plan_task', fusedPlanArgs('external_write')),
          toolCall('sibling', 'work_call', fusedWorkArgs('write_file')),
        ],
      },
      {
        label: 'plan-not-first',
        calls: [
          toolCall('sibling', 'work_call', fusedWorkArgs()),
          toolCall('plan', 'plan_task', fusedPlanArgs()),
        ],
      },
      {
        label: 'extra-sibling',
        calls: [
          toolCall('plan', 'plan_task', fusedPlanArgs()),
          toolCall('sibling-1', 'work_call', fusedWorkArgs()),
          toolCall('sibling-2', 'work_call', fusedWorkArgs()),
        ],
      },
    ];
    for (const fixtureCase of cases) {
      await t.test(fixtureCase.label, async () => {
        const fixture = acceptHostCanarySource(`fused-refusal-${fixtureCase.label}`);
        let planBodies = 0;
        let siblingBodies = 0;
        const planTool = brackets.wrapToolForHarness({
          type: 'function',
          name: 'plan_task',
          description: 'fixture plan barrier',
          parameters: { type: 'object', additionalProperties: true },
          needsApproval: async () => false,
          invoke: async () => { planBodies += 1; return JSON.stringify({ ok: false }); },
        });
        const markedWork = workCallMode.markHostPlanRequiredWorkCall({
          type: 'function',
          name: 'work_call',
          description: 'fixture proposal-free work carrier',
          parameters: { type: 'object', additionalProperties: true },
          needsApproval: async () => false,
          invoke: async () => { siblingBodies += 1; return 'must not run'; },
        });
        const workTool = brackets.wrapToolForHarness(markedWork);
        const model = stubModel([
          fixtureCase.calls as unknown[],
          [textMsg(`replanned ${fixtureCase.label}`)],
        ]);
        const agent = { model, tools: [planTool, workTool] };
        bindHostCanarySurface(fixture, agent, [planTool, workTool]);

        const outcome = await runProductionHost(fixture, agent);
        assert.equal(outcome.terminal, undefined);
        assert.equal(outcome.finalOutput, `replanned ${fixtureCase.label}`);
        assert.equal(planBodies, 0);
        assert.equal(siblingBodies, 0);
        assert.equal(model.calls(), 2);
        const expectedCallIds = fixtureCase.calls.map((item) => (
          item as { callId?: string }
        ).callId);
        const calls = outcome.history.filter((item) => (
          (item as { type?: string }).type === 'function_call'
        )) as Array<{ callId?: string }>;
        const results = outcome.history.filter((item) => (
          (item as { type?: string }).type === 'function_call_result'
        )) as Array<{ callId?: string }>;
        assert.deepEqual(calls.map((item) => item.callId), expectedCallIds);
        assert.deepEqual(results.map((item) => item.callId), expectedCallIds,
          'the refused frame is committed only with one ordered result per call');
        const db = eventlog.openEventLog();
        for (const table of ['logical_tool_calls', 'physical_dispatches']) {
          assert.equal((db.prepare(`
            SELECT COUNT(*) AS n FROM ${table}
             WHERE session_id = ? AND source_user_seq = ?
          `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0,
          `${fixtureCase.label}:${table}`);
        }
      });
    }
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('a refused or failed plan barrier never starts its fused read and leaves paired recovery history', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const fixture = acceptHostCanarySource('fused-plan-failure');
    let planBodies = 0;
    let siblingBodies = 0;
    const planTool = brackets.wrapToolForHarness({
      type: 'function',
      name: 'plan_task',
      description: 'fixture plan barrier',
      parameters: { type: 'object', additionalProperties: true },
      needsApproval: async () => false,
      invoke: async () => {
        planBodies += 1;
        return JSON.stringify({ ok: false, code: 'plan_not_admitted' });
      },
    });
    const markedWork = workCallMode.markHostPlanRequiredWorkCall({
      type: 'function',
      name: 'work_call',
      description: 'fixture proposal-free work carrier',
      parameters: { type: 'object', additionalProperties: true },
      needsApproval: async () => false,
      invoke: async () => { siblingBodies += 1; return 'must not run'; },
    });
    const workTool = brackets.wrapToolForHarness(markedWork);
    const model = stubModel([[
      toolCall('refused-plan', 'plan_task', fusedPlanArgs()),
      toolCall('never-started-read', 'work_call', fusedWorkArgs()),
    ]]);
    const agent = { model, tools: [planTool, workTool] };
    bindHostCanarySurface(fixture, agent, [planTool, workTool]);

    const outcome = await runProductionHost(fixture, agent);
    // The first settled plan failure still gets one model-led repair. This
    // fixture model repeats the already-closed ids, so the protocol boundary
    // stops it before another preparation or transcript commit.
    assert.deepEqual(outcome.terminal, {
      status: 'blocked',
      reason: 'model_reused_committed_call_id',
    }, JSON.stringify(outcome));
    assert.match(String(outcome.finalOutput ?? ''), /already-committed tool call identifier/i);
    assert.equal(planBodies, 1, 'the direct plan barrier is the only admitted body');
    assert.equal(siblingBodies, 0, 'the sibling body stays behind activation');
    const calls = outcome.history.filter((item) =>
      (item as { type?: string }).type === 'function_call') as Array<{ callId?: string }>;
    const results = outcome.history.filter((item) =>
      (item as { type?: string }).type === 'function_call_result') as Array<{ callId?: string }>;
    assert.ok(calls.length >= 2, 'the refused frame is committed');
    assert.deepEqual(results.map((item) => item.callId), calls.map((item) => item.callId),
      'every committed function call has exactly one paired recovery result');

    const db = eventlog.openEventLog();
    assert.deepEqual(db.prepare(`
      SELECT logical_tool_call_id, tool_name, state
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY logical_tool_call_id
    `).all(fixture.session.id, fixture.source.seq), [{
      logical_tool_call_id: 'refused-plan',
      tool_name: 'plan_task',
      state: 'settled',
    }]);
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
         AND logical_tool_call_id = 'never-started-read'
    `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0);
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('fresh material-source marker publishes the formal A/Q checkpoint before the host business model', async () => {
  const session = eventlog.createSession({ id: `host-fresh-source-alignment-${++acceptedSerial}`, kind: 'chat' });
  const text = 'Pull the top 5 records from the Apify API and create one new spreadsheet.';
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const binding = turnControl.validatedTurnSourceStrategyBinding({
    version: 1,
    primary: { capabilityId: 'capability:composio:APIFY_FORMAL_ALIGNMENT' },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'a'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  });
  assert.ok(binding);
  const decision = turnControl.classifyFreshMaterialSourcePreflight({
    message: text,
    sessionId: session.id,
    sessionKind: 'chat',
    sourceUserSeq: source.seq,
    sourceStrategyBinding: binding!,
  });
  assert.equal(decision.sourceStrategyPosture, 'materially_variant');
  assert.ok(decision.intentKey);
  turnControl.recordTurnPreflightDecision(session.id, decision, source.seq);
  const model = stubModel([[textMsg('business model must not run')]]);
  const result = await runConversation({
    sessionId: session.id,
    input: text,
    sourceUserSeq: source.seq,
    reuseRecordedUserInput: true,
    turnEngine: 'host_v1',
    agent: { model, tools: [] } as never,
    preflightConversationPort: {
      render: async () => 'I will use the exact resolved aggregate source, then create one spreadsheet. Should I proceed with that source?',
    },
  });
  assert.equal(result.status, 'awaiting_user_input');
  assert.equal(model.calls(), 0, 'the business model receives no byte before formal source confirmation');
  const awaiting = eventlog.listEvents(session.id, { types: ['awaiting_user_input'] });
  assert.equal(awaiting.length, 1);
  assert.equal(awaiting[0]!.data.source, 'preflight_alignment');
  assert.equal(awaiting[0]!.data.intentKey, decision.intentKey);
  assert.equal(JSON.stringify(awaiting[0]!.data.sourceStrategyBinding), JSON.stringify(binding));
  assert.equal(eventlog.listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
});

test('production builder executes one explicitly declared pure-local read and closes its graphless host root', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const prompt = 'Inspect the local workspace once, then report completion.';
  const session = eventlog.createSession({ id: `host-production-read-${++acceptedSerial}`, kind: 'chat' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `host-production-read-${acceptedSerial}` });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: prompt },
  }, { armRunInFlight: true });
  let modelCalls = 0;
  let builtTools: unknown[] = [];
  let rootSeenBeforeFirstModel = false;
  const seenInputs: unknown[][] = [];
  const model = {
    calls: () => modelCalls,
    async getResponse(request: { input?: unknown; tools?: Array<{ name?: string }> }) {
      seenInputs.push(structuredClone(Array.isArray(request.input) ? request.input : []));
      const root = callAuthorities.acceptedTurnCallAuthorityFor(session.id, source.seq);
      if (modelCalls === 0) {
        assert.equal(root.status, 'ok', 'the exact host root is armed before the first model byte');
        if (root.status === 'ok') {
          assert.equal(root.authority.state, 'open');
          assert.equal(root.authority.authorityKind, 'host_v1_read_only');
          assert.equal(root.authority.sourceEventId, source.id);
          assert.equal(root.authority.identity.acceptedTaskId, identities.acceptedTaskIdFor(session.id, source.seq));
        }
        assert.ok(request.tools?.some((entry) => entry.name === 'list_files'));
        assert.equal(eventlog.listEvents(session.id, { types: ['turn_graph_shadow'] }).length, 0);
        rootSeenBeforeFirstModel = true;
      }
      modelCalls += 1;
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output: modelCalls === 1
          ? [toolCall('production-read-call', 'list_files', { directory: null, limit: 1 })]
          : [textMsg(JSON.stringify({
              summary: 'Workspace inspected.',
              reply: 'Workspace inspected.',
              done: true,
              nextAction: 'completed',
              reason: null,
            }))],
        responseId: `production-read-response-${modelCalls}`,
      };
    },
    getStreamedResponse: testModelStream,
  };

  try {
    let builds = 0;
    const result = await runConversation({
      sessionId: session.id,
      input: prompt,
      sourceUserSeq: source.seq,
      reuseRecordedUserInput: true,
      runAttemptId: attempt.attemptId,
      turnEngine: 'host_v1_read_only',
      maxSteps: 1,
      maxTurns: 4,
      toolCallsPerTurn: 4,
      judgeCompletion: false,
      buildAgent: async (identity) => {
        builds += 1;
        assert.equal(identity.sessionId, session.id);
        assert.equal(identity.sourceUserSeq, source.seq);
        assert.equal(identity.route, undefined, 'the production host builder receives no fabricated graph route');
        const built = await buildOrchestratorAgent({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          userInput: prompt,
          allowToolJit: false,
          mcpToolScope: {
            authority: 'none',
            reason: 'isolated production-builder host-read regression',
            allowedServerSlugs: [],
            toolPatterns: [],
            maxTools: 0,
          },
          model: model as never,
        });
        builtTools = [...built.tools];
        const exactConfiguredRead = built.tools.find((entry) => entry.name === 'list_files');
        assert.ok(exactConfiguredRead, 'the production builder exposes the declared pure-local built-in read');
        assert.equal(brackets.isHarnessBoundFunctionTool(exactConfiguredRead), true,
          'the exact configured object is the harness-attested wrapper');
        const envelope = capabilityEnvelopes.boundAgentCapabilityEnvelope(built);
        const revision = capabilityEnvelopes.boundAgentCapabilityRevision(built);
        const capability = envelope?.capabilities.filter((entry) => entry.name === 'list_files') ?? [];
        assert.equal(capability.length, 1);
        assert.equal(capability[0]?.accountIdentity, '');
        assert.equal(capability[0]?.effectClass, 'read');
        assert.equal(capability[0]?.schemaFingerprint,
          capabilityEnvelopes.toolSchemaFingerprint(exactConfiguredRead));
        assert.ok(revision?.bound.includes('list_files'));
        return built;
      },
      makeRunner: () => throwingRunner() as never,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.publicPresentation?.text, 'Workspace inspected.');
    assert.equal(builds, 1);
    assert.equal(model.calls(), 2);
    assert.equal(rootSeenBeforeFirstModel, true);
    assert.ok(builtTools.length > 0);
    const secondProjection = seenInputs[1] as Array<Record<string, unknown>>;
    assert.deepEqual(
      secondProjection
        .filter((entry) => entry.type === 'function_call_result')
        .map((entry) => entry.callId),
      ['production-read-call'],
    );

    const db = eventlog.openEventLog();
    const logical = db.prepare(`
      SELECT logical_tool_call_id, tool_name, state
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
    `).all(session.id, source.seq) as Array<{
      logical_tool_call_id: string; tool_name: string; state: string;
    }>;
    assert.deepEqual(logical, [{
      logical_tool_call_id: 'production-read-call',
      tool_name: 'list_files',
      state: 'settled',
    }], 'the exact model call id is the one logical identity');
    const physical = db.prepare(`
      SELECT logical_tool_call_id, execution_site, state
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).all(session.id, source.seq) as Array<{
      logical_tool_call_id: string; execution_site: string; state: string;
    }>;
    assert.deepEqual(physical, [{
      logical_tool_call_id: 'production-read-call',
      execution_site: 'host',
      state: 'returned',
    }], 'one body crossing is settled through the shared physical ledger');
    const settlement = db.prepare(`
      SELECT execution_kind, physical_crossing_count, host_crossing_count
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as {
      execution_kind: string; physical_crossing_count: number; host_crossing_count: number;
    };
    assert.equal(settlement.execution_kind, 'local_execution');
    assert.equal(settlement.physical_crossing_count, 0);
    assert.equal(settlement.host_crossing_count, 1);
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM accepted_task_resolutions
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as { n: number }).n, 0);
    const events = eventlog.listEvents(session.id);
    assert.equal(events.filter((entry) => entry.type === 'turn_graph_shadow').length, 0);
    assert.equal(events.filter((entry) => entry.type === 'conversation_completed').length, 1,
      'one public terminal wins');
    const closed = callAuthorities.acceptedTurnCallAuthorityFor(session.id, source.seq);
    assert.equal(closed.status, 'ok');
    if (closed.status === 'ok') {
      assert.equal(closed.authority.state, 'closed');
      assert.equal(closed.authority.closeReason, 'host_completed');
      assert.equal(closed.authority.maxLogicalCalls, 4);
      assert.equal(closed.authority.maxParallelCalls, 4);
      assert.equal(closed.authority.graphEventId, undefined);
      assert.equal(closed.authority.graphHash, undefined);
    }
    const finishedAttempt = eventlog.getLatestRunAttempt(session.id);
    assert.equal(finishedAttempt?.attemptId, attempt.attemptId);
    assert.equal(finishedAttempt?.sourceUserSeq, source.seq);
    assert.equal(finishedAttempt?.status, 'completed');
    assert.ok(finishedAttempt?.finishedAt);
    const metadata = eventlog.getSession(session.id)?.metadata ?? {};
    assert.equal(Object.prototype.hasOwnProperty.call(metadata, '__run_in_flight'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(metadata, '__run_in_flight_owner'), false);
    const snapshot = metadata.__conversation as {
      items?: Array<Record<string, unknown>>;
      lastResponseId?: unknown;
    } | undefined;
    assert.ok(Array.isArray(snapshot?.items), 'one atomic conversation snapshot owns host replay');
    assert.equal(snapshot?.lastResponseId, 'production-read-response-2');
    assert.equal(events.filter((entry) => entry.type === 'user_input_received').length, 1,
      'one accepted inbox source owns every model step and call in this turn');
    assert.deepEqual(snapshot!.items!
      .filter((entry) => entry.type === 'function_call')
      .map((entry) => ({ callId: entry.callId, name: entry.name })), [{
      callId: 'production-read-call',
      name: 'list_files',
    }]);
    assert.deepEqual(snapshot!.items!
      .filter((entry) => entry.type === 'function_call_result')
      .map((entry) => ({ callId: entry.callId, name: entry.name })), [{
      callId: 'production-read-call',
      name: 'list_files',
    }]);
    assert.match(JSON.stringify(snapshot!.items), /Workspace inspected\./,
      'the accepted assistant frame is part of the same replay snapshot');
    const turnEnded = events.filter((entry) => entry.type === 'turn_ended');
    const snapshotBoundaries = turnEnded.filter((entry) => Number.isSafeInteger(entry.data.items));
    assert.equal(snapshotBoundaries.length, 1,
      'the lifecycle audit row is distinct from the one atomic replay-snapshot boundary');
    assert.equal(snapshotBoundaries[0]?.data.items, snapshot!.items!.length);

    const callsBeforeReplay = model.calls();
    const replay = await runConversation({
      sessionId: session.id,
      input: prompt,
      sourceUserSeq: source.seq,
      reuseRecordedUserInput: true,
      runAttemptId: attempt.attemptId,
      turnEngine: 'host_v1_read_only',
      maxSteps: 1,
      maxTurns: 4,
      toolCallsPerTurn: 4,
      judgeCompletion: false,
      buildAgent: async () => {
        throw new Error('terminal replay must not rebuild capability');
      },
      makeRunner: () => throwingRunner() as never,
    });
    assert.equal(replay.status, 'completed');
    assert.equal(replay.steps, 0);
    assert.equal(model.calls(), callsBeforeReplay);
    assert.equal(eventlog.listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as { n: number }).n, 1);
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('production host reaches the generic automation review and pilot controls through the sealed JIT surface', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const priorSearch = process.env.CLEMMY_CODEX_TOOL_SEARCH;
  const priorJit = process.env.CLEMMY_TOOL_JIT;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
  process.env.CLEMMY_TOOL_JIT = 'on';
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  const session = eventlog.createSession({
    id: `host-production-automation-controls-${++acceptedSerial}`,
    kind: 'chat',
  });
  const targetName = 'automation_read_pilot_acquisition_list';
  const targetArgs = {
    proposal_id: 'missing-fixture-proposal',
    expected_proposal_revision: 1,
    expected_proposal_digest: 'd'.repeat(64),
    phase_id: 'phase-fixture',
    requirement_id: 'requirement-fixture',
  };
  let modelCalls = 0;
  let firstSurface: string[] = [];
  const model = {
    async getResponse(request: { tools?: Array<{ name?: string }> }) {
      modelCalls += 1;
      firstSurface = modelCalls === 1
        ? (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean)
        : firstSurface;
      const direct = firstSurface.includes(targetName);
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output: modelCalls === 1
          ? [direct
              ? toolCall('automation-control-call', targetName, targetArgs)
              : toolCall('automation-control-call', 'call_tool', {
                  name: targetName,
                  args_json: JSON.stringify(targetArgs),
                })]
          : [textMsg(JSON.stringify({
              summary: 'automation controls reached',
              reply: 'automation controls reached',
              done: true,
              nextAction: 'completed',
              reason: null,
            }))],
        responseId: `automation-control-response-${modelCalls}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
  const requiredControls = [
    'automation_opportunity_propose',
    'automation_opportunity_review_request',
    'automation_read_pilot_acquisition_list',
    'automation_read_pilot_request',
    'automation_read_pilot_workspace_create_request',
    'automation_read_pilot_workspace_list',
  ];

  try {
    const result = await runConversation({
      sessionId: session.id,
      input: 'Inspect the generic durable automation control surface without running a workflow.',
      turnEngine: 'host_v1',
      maxSteps: 1,
      maxTurns: 4,
      toolCallsPerTurn: 4,
      judgeCompletion: false,
      buildAgent: async (identity) => {
        const built = await buildOrchestratorAgent({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          userInput: 'Inspect the generic durable automation control surface without running a workflow.',
          allowToolJit: true,
          mcpToolScope: {
            authority: 'none',
            reason: 'isolated production host automation-control regression',
            allowedServerSlugs: [],
            toolPatterns: [],
            maxTools: 0,
          },
          model: model as never,
        });
        const envelope = capabilityEnvelopes.boundAgentCapabilityEnvelope(built);
        const revision = capabilityEnvelopes.boundAgentCapabilityRevision(built);
        assert.ok(envelope);
        assert.ok(revision);
        const universe = new Set(envelope!.capabilities.map((entry) => entry.name));
        for (const name of requiredControls) {
          assert.equal(universe.has(name), true, `${name} is absent from the sealed chat universe`);
        }
        const active = new Set((built.tools ?? []).map((entry) => entry.name));
        assert.ok(active.has(targetName) || active.has('call_tool'),
          'the selected foreground surface has neither the exact control nor its generic carrier');
        assert.ok(revision!.bound.includes(targetName) || revision!.bound.includes('call_tool'));
        return built;
      },
      makeRunner: () => throwingRunner() as never,
    });

    assert.equal(result.status, 'completed', JSON.stringify({
      result,
      events: eventlog.listEvents(session.id).map((entry) => ({
        type: entry.type,
        reason: entry.data.reason,
        failure: entry.data.failure,
        disposition: entry.data.disposition,
      })),
    }));
    assert.equal(result.publicPresentation?.text, 'automation controls reached');
    assert.equal(modelCalls, 2);
    assert.ok(firstSurface.includes(targetName) || firstSurface.includes('call_tool'));
    const source = eventlog.listEvents(session.id, { types: ['user_input_received'] })[0];
    assert.ok(source);
    assert.deepEqual(eventlog.openEventLog().prepare(`
      SELECT logical_tool_call_id, tool_name, state
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
    `).all(session.id, source.seq), [{
      logical_tool_call_id: 'automation-control-call',
      tool_name: targetName,
      state: 'settled',
    }], 'the carrier refines to the exact generic control under one logical call');
  } finally {
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
    if (priorSearch === undefined) delete process.env.CLEMMY_CODEX_TOOL_SEARCH;
    else process.env.CLEMMY_CODEX_TOOL_SEARCH = priorSearch;
    if (priorJit === undefined) delete process.env.CLEMMY_TOOL_JIT;
    else process.env.CLEMMY_TOOL_JIT = priorJit;
  }
});

test('caller abort after invocation is paired and held for reconciliation without a second model step', async () => {
  const task = acceptHostCanarySource('caller-cancel');
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let observedLease: dispatchLeases.DispatchLeaseRef | undefined;
  const boundedRead = brackets.wrapToolForHarness({
    type: 'function',
    name: 'list_files',
    description: 'bounded local read',
    parameters: { type: 'object', properties: {} },
    needsApproval: async () => false,
    invoke: async (
      _context: unknown,
      _raw: string,
      details: { signal?: AbortSignal },
    ) => {
      observedLease = brackets.harnessRunContextStorage.getStore()?.dispatchLease;
      markStarted();
      return new Promise<never>((_resolve, reject) => {
        details.signal?.addEventListener('abort', () => {
          reject(details.signal?.reason ?? new Error('caller aborted'));
        }, { once: true });
      });
    },
  });
  const model = stubModel([
    [toolCall('caller-cancel-call', 'list_files', {})],
    [textMsg('must never be requested')],
  ]);
  const agent = { model, tools: [boundedRead] };
  bindHostCanarySurface(task, agent, [boundedRead]);

  const pending = runTurn({
    sessionId: task.session.id,
    input: 'Read the files until I cancel.',
    agent: agent as never,
    makeRunner: throwingRunner as never,
    turnEngine: 'host_v1_read_only',
    maxTurns: 3,
    signal: controller.signal,
    sourceUserSeq: task.source.seq,
    reuseRecordedUserInput: true,
  });
  await started;
  controller.abort(new Error('caller closed the request'));
  const result = await pending;

  assert.equal(result.status, 'blocked');
  assert.match(String(result.error), /reconcil|uncertain|may have begun/i);
  assert.equal(model.calls(), 1, 'caller cancellation never asks the model for a recovery step');
  assert.ok(observedLease);
  assert.equal(dispatchLeases.isDispatchLeaseCurrent(observedLease), false);
  const db = eventlog.openEventLog();
  const physicalRows = db.prepare(`
    SELECT logical_tool_call_id, state, lease_scope_id, lease_id
      FROM physical_dispatches WHERE session_id = ?
  `).all(task.session.id) as Array<{
    logical_tool_call_id: string; state: string; lease_scope_id: string; lease_id: string;
  }>;
  const physical = physicalRows.find((row) => row.logical_tool_call_id === 'caller-cancel-call');
  assert.ok(physical, JSON.stringify(physicalRows));
  assert.equal(physical.state, 'cancelled');
  const persistedLease = db.prepare(`
    SELECT revoked_at FROM run_dispatch_leases
     WHERE scope_id = ? AND lease_id = ?
  `).get(physical.lease_scope_id, physical.lease_id) as { revoked_at: string | null };
  assert.ok(persistedLease.revoked_at);
  const logical = db.prepare(`
    SELECT state FROM logical_tool_calls
     WHERE session_id = ? AND logical_tool_call_id = ?
  `).get(task.session.id, 'caller-cancel-call') as { state: string };
  assert.equal(logical.state, 'settled');
  const settlement = db.prepare(`
    SELECT outcome_kind, recovery_action, requires_reconciliation
      FROM logical_call_settlements
     WHERE session_id = ? AND logical_tool_call_id = ?
  `).get(task.session.id, 'caller-cancel-call') as {
    outcome_kind: string; recovery_action: string; requires_reconciliation: number;
  };
  assert.deepEqual(settlement, {
    outcome_kind: 'unknown',
    recovery_action: 'stop_and_explain',
    requires_reconciliation: 0,
  });
  assert.equal(
    eventlog.listEvents(task.session.id, { types: ['kill_requested'] }).length,
    0,
    'the paired reconciliation hold, rather than the generic kill reducer, owns this admitted frame',
  );
  assert.equal(eventlog.listEvents(task.session.id, { types: ['run_failed'] }).length, 0);
});

test('production host fans out two independent pure-local reads under one bounded graphless root', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const prompt = 'Inspect the workspace roots and one directory entry independently.';
  const session = eventlog.createSession({ id: `host-production-fanout-${++acceptedSerial}`, kind: 'chat' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `host-production-fanout-${acceptedSerial}` });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: prompt },
  }, { armRunInFlight: true });
  const frameCallIds = ['fanout-roots', 'fanout-list'];
  const projectedResultOrder: string[][] = [];
  let modelCalls = 0;
  let sawBoundedRootBeforeModel = false;
  const model = {
    async getResponse(request: { input?: unknown }) {
      const projection = Array.isArray(request.input)
        ? request.input as Array<Record<string, unknown>>
        : [];
      projectedResultOrder.push(
        projection
          .filter((entry) => entry.type === 'function_call_result')
          .map((entry) => String(entry.callId ?? '')),
      );
      if (modelCalls === 0) {
        const root = callAuthorities.acceptedTurnCallAuthorityFor(session.id, source.seq);
        assert.equal(root.status, 'ok');
        if (root.status === 'ok') {
          assert.equal(root.authority.state, 'open');
          assert.equal(root.authority.maxLogicalCalls, 2);
          assert.equal(root.authority.maxParallelCalls, 2);
        }
        sawBoundedRootBeforeModel = true;
      }
      modelCalls += 1;
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output: modelCalls === 1
          ? [
              toolCall(frameCallIds[0]!, 'workspace_roots', {}),
              toolCall(frameCallIds[1]!, 'list_files', { directory: null, limit: 1 }),
            ]
          : [textMsg(JSON.stringify({
              summary: 'Both independent reads completed.',
              reply: 'Both independent reads completed.',
              done: true,
              nextAction: 'completed',
              reason: null,
            }))],
        responseId: `production-fanout-response-${modelCalls}`,
      };
    },
    getStreamedResponse: testModelStream,
  };

  try {
    const result = await runConversation({
      sessionId: session.id,
      input: prompt,
      sourceUserSeq: source.seq,
      reuseRecordedUserInput: true,
      runAttemptId: attempt.attemptId,
      turnEngine: 'host_v1_read_only',
      maxSteps: 1,
      maxTurns: 4,
      toolCallsPerTurn: 2,
      judgeCompletion: false,
      buildAgent: async (identity) => {
        const built = await buildOrchestratorAgent({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          userInput: prompt,
          allowToolJit: false,
          mcpToolScope: {
            authority: 'none',
            reason: 'isolated production-builder host-fanout regression',
            allowedServerSlugs: [],
            toolPatterns: [],
            maxTools: 0,
          },
          model: model as never,
        });
        const exactReads = ['workspace_roots', 'list_files'].map((name) =>
          built.tools.find((entry) => entry.name === name));
        assert.ok(exactReads.every(Boolean),
          'the production builder exposes both declared pure-local reads without pretending they are external manifest bindings');
        assert.ok(exactReads.every((entry) => brackets.isHarnessBoundFunctionTool(entry)),
          'both exact configured objects are harness-attested wrappers');
        const revision = capabilityEnvelopes.boundAgentCapabilityRevision(built);
        assert.ok(frameCallIds.every((_callId, index) =>
          revision?.bound.includes(index === 0 ? 'workspace_roots' : 'list_files')));
        return built;
      },
      makeRunner: () => throwingRunner() as never,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.publicPresentation?.text, 'Both independent reads completed.');
    assert.equal(modelCalls, 2);
    assert.equal(sawBoundedRootBeforeModel, true);
    assert.deepEqual(projectedResultOrder[0], []);
    assert.deepEqual(projectedResultOrder[1], frameCallIds,
      'parallel completion rejoins the model projection in the admitted frame order');

    const db = eventlog.openEventLog();
    const logical = db.prepare(`
      SELECT logical_tool_call_id, tool_name, state
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY logical_tool_call_id
    `).all(session.id, source.seq) as Array<{
      logical_tool_call_id: string; tool_name: string; state: string;
    }>;
    assert.deepEqual(logical, [
      { logical_tool_call_id: 'fanout-list', tool_name: 'list_files', state: 'settled' },
      { logical_tool_call_id: 'fanout-roots', tool_name: 'workspace_roots', state: 'settled' },
    ]);
    const crossings = db.prepare(`
      SELECT logical_tool_call_id, execution_site, state
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY logical_tool_call_id
    `).all(session.id, source.seq) as Array<{
      logical_tool_call_id: string; execution_site: string; state: string;
    }>;
    assert.deepEqual(crossings, [
      { logical_tool_call_id: 'fanout-list', execution_site: 'host', state: 'returned' },
      { logical_tool_call_id: 'fanout-roots', execution_site: 'host', state: 'returned' },
    ]);
    const settlementRows = db.prepare(`
      SELECT logical_tool_call_id, physical_crossing_count, host_crossing_count
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY logical_tool_call_id
    `).all(session.id, source.seq) as Array<{
      logical_tool_call_id: string; physical_crossing_count: number; host_crossing_count: number;
    }>;
    assert.deepEqual(settlementRows, [
      { logical_tool_call_id: 'fanout-list', physical_crossing_count: 0, host_crossing_count: 1 },
      { logical_tool_call_id: 'fanout-roots', physical_crossing_count: 0, host_crossing_count: 1 },
    ]);
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM accepted_turn_call_authorities
       WHERE session_id = ? AND source_user_seq = ? AND authority_kind = 'host_v1_read_only'
    `).get(session.id, source.seq) as { n: number }).n, 1, 'both calls share one host root');
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM accepted_task_resolutions
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as { n: number }).n, 0);
    assert.equal(eventlog.listEvents(session.id, { types: ['turn_graph_shadow'] }).length, 0,
      'tool count never manufactures a graph');
    assert.equal(eventlog.listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
    const closed = callAuthorities.acceptedTurnCallAuthorityFor(session.id, source.seq);
    assert.equal(closed.status, 'ok');
    if (closed.status === 'ok') {
      assert.equal(closed.authority.state, 'closed');
      assert.equal(closed.authority.closeReason, 'host_completed');
    }
    const metadata = eventlog.getSession(session.id)?.metadata ?? {};
    assert.equal(Object.prototype.hasOwnProperty.call(metadata, '__run_in_flight'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(metadata, '__run_in_flight_owner'), false);
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('production runConversation surfaces the host tool ceiling and replays its paired checkpoint', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const prompt = 'Inspect the workspace roots and two bounded directory views.';
  const session = eventlog.createSession({ id: `host-production-tool-ceiling-${++acceptedSerial}`, kind: 'chat' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `host-production-tool-ceiling-${acceptedSerial}` });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: prompt },
  }, { armRunInFlight: true });
  const callIds = ['ceiling-roots', 'ceiling-list', 'ceiling-overflow'];
  const seenResultIds: string[][] = [];
  let modelCalls = 0;
  const model = {
    async getResponse(request: { input?: unknown }) {
      const input = Array.isArray(request.input)
        ? request.input as Array<Record<string, unknown>>
        : [];
      seenResultIds.push(input
        .filter((item) => item.type === 'function_call_result')
        .map((item) => String(item.callId ?? '')));
      const output = [
        [toolCall(callIds[0]!, 'workspace_roots', {})],
        [toolCall(callIds[1]!, 'list_files', { directory: null, limit: 1 })],
        [toolCall(callIds[2]!, 'list_files', { directory: null, limit: 2 })],
        [textMsg(JSON.stringify({
          summary: 'The paired checkpoint resumed.',
          reply: 'The paired checkpoint resumed.',
          done: true,
          nextAction: 'completed',
          reason: null,
        }))],
      ][Math.min(modelCalls, 3)]!;
      modelCalls += 1;
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output,
        responseId: `tool-ceiling-response-${modelCalls}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
  let builtAgent: Awaited<ReturnType<typeof buildOrchestratorAgent>> | undefined;
  const runtimeTerminals: string[] = [];
  const detachRuntime = actionBus.subscribe((event) => {
    if (
      event.sessionId === session.id
      && (event.kind === 'runtime.completed' || event.kind === 'runtime.failed')
    ) runtimeTerminals.push(event.kind);
  });

  try {
    const first = await runConversation({
      sessionId: session.id,
      input: prompt,
      sourceUserSeq: source.seq,
      reuseRecordedUserInput: true,
      runAttemptId: attempt.attemptId,
      deferToolCallsLimitTerminal: true,
      turnEngine: 'host_v1_read_only',
      maxSteps: 1,
      maxTurns: 6,
      toolCallsPerTurn: 2,
      judgeCompletion: false,
      buildAgent: async (identity) => {
        builtAgent = await buildOrchestratorAgent({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          userInput: prompt,
          allowToolJit: false,
          mcpToolScope: {
            authority: 'none',
            reason: 'isolated production-builder tool-ceiling regression',
            allowedServerSlugs: [],
            toolPatterns: [],
            maxTools: 0,
          },
          model: model as never,
        });
        return builtAgent;
      },
      makeRunner: () => throwingRunner() as never,
    });

    assert.equal(first.status, 'limit_exceeded');
    assert.equal(first.limitKind, 'tool_calls');
    assert.equal(first.publicPresentation, undefined,
      'the workflow-owned checkpoint is private until the original source reaches its eventual terminal');
    assert.equal(eventlog.getSession(session.id)?.status, 'active',
      'a private checkpoint cannot durably fail the child session between activations');
    assert.deepEqual(runtimeTerminals, [],
      'a private checkpoint cannot emit an externally visible runtime terminal');
    assert.equal(modelCalls, 3, 'the model cannot reason past the typed ceiling');
    assert.ok(builtAgent);

    const persisted = HarnessSession.load(session.id)?.toInputItems() ?? [];
    const persistedCallIds = persisted
      .filter((item) => (item as { type?: unknown }).type === 'function_call')
      .map((item) => String((item as { callId?: unknown }).callId ?? ''));
    const persistedResultIds = persisted
      .filter((item) => (item as { type?: unknown }).type === 'function_call_result')
      .map((item) => String((item as { callId?: unknown }).callId ?? ''));
    assert.deepEqual(persistedCallIds.slice(-3), callIds);
    assert.deepEqual(persistedResultIds.slice(-3), callIds,
      'settled outputs and the provably unstarted overflow remain exactly paired');

    const calledIds = eventlog.listEvents(session.id, { types: ['tool_called'] })
      .map((event) => String(event.data.callId ?? ''));
    assert.deepEqual(calledIds, callIds.slice(0, 2), 'the over-limit body never enters invocation');
    assert.equal(
      eventlog.listEvents(session.id, { types: ['conversation_completed'] }).length,
      0,
      'a workflow-owned ceiling checkpoint must not become the accepted source terminal',
    );

    const resumed = await runConversation({
      agent: builtAgent!,
      sessionId: session.id,
      input: 'Pick up where you left off from the paired tool checkpoint.',
      sourceUserSeq: source.seq,
      reuseRecordedUserInput: true,
      runAttemptId: attempt.attemptId,
      deferToolCallsLimitTerminal: true,
      turnEngine: 'host_v1_read_only',
      maxSteps: 1,
      maxTurns: 3,
      toolCallsPerTurn: 2,
      judgeCompletion: false,
      makeRunner: () => throwingRunner() as never,
    });
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.publicPresentation?.text, 'The paired checkpoint resumed.');
    assert.deepEqual(seenResultIds[3]?.slice(-3), callIds,
      'the real continuation receives the exact checkpoint rather than a stubbed result');
    assert.deepEqual(
      eventlog.listEvents(session.id, { types: ['user_input_received'] }).map((event) => event.seq),
      [source.seq],
      'continuation reuses the one accepted source instead of manufacturing a second user turn',
    );
    const terminals = eventlog.listEvents(session.id, { types: ['conversation_completed'] });
    assert.equal(terminals.length, 1, 'the accepted source publishes exactly one eventual terminal');
    assert.equal(terminals[0]?.data?.sourceUserSeq, source.seq);
    assert.deepEqual(runtimeTerminals, ['runtime.completed']);
  } finally {
    detachRuntime();
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('production host call_tool keeps exact v57 authority through strict nullable refinement', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const fixture = acceptHostCanarySource('production-call-tool-nullable-refinement');
  const carrier = brackets.wrapToolForHarness(callToolTools.buildCallTool({
    reachableBuiltinNames: new Set(['mcp_list_tools']),
    firstClassNames: new Set(['call_tool']),
    deniedNames: new Set(),
    mcpToolScope: null,
    controlOnlyBuiltins: true,
    admitBuiltinAcquisition: async (name) => name === 'mcp_list_tools'
      ? { ok: true }
      : {
          ok: false,
          kind: 'requires_readmission',
          outside: [name],
        },
  }));
  const model = stubModel([
    [toolCall('deferred-mcp-inventory', 'call_tool', {
      name: 'mcp_list_tools',
      // The strict inner schema materializes the omitted nullable compatibility
      // field as `server_name:null`. That trusted raw -> effective rewrite was
      // the exact live Discord failure: the raw carrier binding was valid, but
      // host admission rejected its own effective replay before any body ran.
      args_json: JSON.stringify({
        server: 'not-configured-fixture',
        query: 'calendar inventory',
        limit: 1,
      }),
    })],
    [textMsg('deferred inventory settled')],
  ]);
  const agent = { model, tools: [carrier] };
  bindHostCanarySurface(fixture, agent, [carrier]);

  try {
    const outcome = await runProductionHost(fixture, agent);
    assert.equal(outcome.finalOutput, 'deferred inventory settled', JSON.stringify(outcome.terminal));
    assert.equal(model.calls(), 2);
    const db = eventlog.openEventLog();
    const logical = db.prepare(`
      SELECT tool_name, raw_argument_digest, effective_argument_digest, state
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(fixture.session.id, fixture.source.seq, 'deferred-mcp-inventory') as {
      tool_name: string;
      raw_argument_digest: string;
      effective_argument_digest: string | null;
      state: string;
    };
    assert.equal(logical.tool_name, 'mcp_list_tools');
    assert.equal(logical.state, 'settled');
    assert.ok(logical.effective_argument_digest);
    assert.notEqual(logical.effective_argument_digest, logical.raw_argument_digest,
      'strict server_name:null materialization consumes the one durable refinement');
    assert.deepEqual(db.prepare(`
      SELECT binding_kind, operation_id, attested_argument_digest,
             logical_raw_argument_digest, bound_effective_argument_digest
        FROM host_call_capability_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(fixture.session.id, fixture.source.seq, 'deferred-mcp-inventory'), {
      binding_kind: 'local_envelope',
      operation_id: 'call_tool',
      attested_argument_digest: logical.raw_argument_digest,
      logical_raw_argument_digest: logical.raw_argument_digest,
      bound_effective_argument_digest: null,
    });
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0,
    'the missing-server corrective stays a local control result with zero provider crossing');
    const root = callAuthorities.acceptedTurnCallAuthorityFor(
      fixture.session.id,
      fixture.source.seq,
    );
    assert.equal(root.status, 'ok');
    if (root.status === 'ok') {
      assert.equal(root.authority.authorityKind, 'host_v1');
      assert.equal(root.authority.state, 'open',
        'the isolated runner leaves terminal root closure to its conversation owner');
      assert.equal(root.authority.closeReason, undefined);
    }
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('production host reroutes a provider-carried local read control through the sealed acquisition surface', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const fixture = acceptHostCanarySource('provider-carried-local-read-control');
  let providerBodies = 0;
  const providerCarrier = brackets.wrapToolForHarness(tool({
    name: 'composio_execute_tool',
    description: 'Fixture provider carrier whose body must remain unopened.',
    parameters: z.object({
      tool_slug: z.string().min(1),
      arguments: z.string(),
      connected_account_id: z.string().nullable(),
    }),
    execute: async () => {
      providerBodies += 1;
      return 'provider body must not run';
    },
  }) as never);
  const localAcquisition = brackets.wrapToolForHarness(callToolTools.buildCallTool({
    reachableBuiltinNames: new Set(['tool_search']),
    firstClassNames: new Set(['call_tool', 'composio_execute_tool']),
    deniedNames: new Set(),
    mcpToolScope: null,
    controlOnlyBuiltins: true,
    admitBuiltinAcquisition: async (name) => name === 'tool_search'
      ? { ok: true }
      : {
          ok: false,
          kind: 'requires_readmission',
          outside: [name],
        },
  }) as never);
  const model = stubModel([
    [toolCall('carried-local-schema-inspection', 'composio_execute_tool', {
      tool_slug: 'tool_search',
      arguments: JSON.stringify({ query: 'harness_status' }),
      connected_account_id: null,
    })],
    [textMsg('the local schema inspection settled')],
  ]);
  const tools = [providerCarrier, localAcquisition];
  const agent = { model, tools };
  bindHostCanarySurface(fixture, agent, tools);

  try {
    const outcome = await runProductionHost(fixture, agent);
    assert.equal(
      outcome.finalOutput,
      'the local schema inspection settled',
      JSON.stringify(outcome.terminal),
    );
    assert.equal(model.calls(), 2);
    assert.equal(providerBodies, 0, 'a local control name never enters the provider carrier body');
    const result = outcome.history.find((item) => (
      (item as { type?: unknown; callId?: unknown }).type === 'function_call_result'
      && (item as { callId?: unknown }).callId === 'carried-local-schema-inspection'
    )) as { name?: string; output?: unknown } | undefined;
    assert.ok(result, 'the original admitted model edge received one local result');
    assert.equal(result?.name, 'composio_execute_tool',
      'history retains the model-authored carrier name while execution routes locally');
    assert.match(JSON.stringify(result?.output), /tool_search|harness_status/);

    const db = eventlog.openEventLog();
    assert.deepEqual(db.prepare(`
      SELECT tool_name, state
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(fixture.session.id, fixture.source.seq, 'carried-local-schema-inspection'), {
      tool_name: 'tool_search',
      state: 'settled',
    });
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0,
    'schema inspection stays local with zero provider crossing');
    const root = callAuthorities.acceptedTurnCallAuthorityFor(
      fixture.session.id,
      fixture.source.seq,
    );
    assert.equal(root.status, 'ok');
    if (root.status === 'ok') assert.equal(root.authority.state, 'open');
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('production host refuses a spill-capable table read before its real body', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const prompt = 'Select every row from this local table.';
  const session = eventlog.createSession({ id: `host-production-table-spill-${++acceptedSerial}`, kind: 'chat' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: `host-production-table-spill-${acceptedSerial}` });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: prompt },
  }, { armRunInFlight: true });
  const spillDir = path.join(TMP_HOME, 'files', 'table-ops');
  assert.equal(existsSync(spillDir), false, 'the isolated home starts without a table spill directory');
  const rows = Array.from({ length: 101 }, (_, index) => ({ index }));
  const model = stubModel([
    [toolCall('production-table-spill-call', 'table_ops', {
      op: 'select',
      left_rows: JSON.stringify(rows),
      columns: 'index',
    })],
    [textMsg(JSON.stringify({
      summary: 'The spill-capable read stayed fenced.',
      reply: 'The spill-capable read stayed fenced.',
      done: true,
      nextAction: 'completed',
      reason: null,
    }))],
  ]);
  try {
    const result = await runConversation({
      sessionId: session.id,
      input: prompt,
      sourceUserSeq: source.seq,
      reuseRecordedUserInput: true,
      runAttemptId: attempt.attemptId,
      turnEngine: 'host_v1_read_only',
      maxSteps: 1,
      maxTurns: 3,
      toolCallsPerTurn: 2,
      judgeCompletion: false,
      buildAgent: async (identity) => {
        const built = await buildOrchestratorAgent({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          userInput: prompt,
          allowToolJit: false,
          mcpToolScope: {
            authority: 'none',
            reason: 'isolated production-builder spill refusal regression',
            allowedServerSlugs: [],
            toolPatterns: [],
            maxTools: 0,
          },
          model: model as never,
        });
        const configured = built.tools.find((entry) => entry.name === 'table_ops');
        assert.ok(configured, 'the production surface contains the real spill-capable tool');
        assert.equal(brackets.isHarnessBoundFunctionTool(configured), true);
        return built;
      },
      makeRunner: () => throwingRunner() as never,
    });
    assert.equal(result.status, 'completed');
    assert.equal(model.calls(), 2, 'the model sees the bounded refusal and may finish honestly');
    assert.equal(existsSync(spillDir), false, 'host_v1 never entered renderResult mkdir/write');
    const db = eventlog.openEventLog();
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as { n: number }).n, 0);
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as { n: number }).n, 0);
    assert.equal(eventlog.listEvents(session.id, { types: ['turn_graph_shadow'] }).length, 0);
    assert.equal(eventlog.listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('host lifecycle listener propagates an over-limit pre-invoke checkpoint', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'off';
  let firstRuns = 0;
  let secondRuns = 0;
  const model = stubModel([[
    toolCall('cap-first', 'cap_fixture', { slot: 1 }),
    toolCall('cap-second', 'cap_fixture', { slot: 2 }),
  ]]);
  const runner = throwingRunner();
  const counter = new brackets.ToolCallsCounter(1);
  runner.on('agent_tool_start', () => counter.increment());
  try {
    let caught: unknown;
    await assert.rejects(hostRunRunner(
        runner as never,
        {
        model,
        tools: [{
          type: 'function', name: 'cap_fixture', description: 'cap-only local fixture',
          parameters: { type: 'object', properties: { slot: { type: 'number' } } },
          needsApproval: async () => false,
          invoke: async (_context: unknown, raw: string) => {
            const slot = (JSON.parse(raw) as { slot: number }).slot;
            if (slot === 1) firstRuns += 1;
            else secondRuns += 1;
            return `slot-${slot}`;
          },
        }],
        } as never,
        [{ type: 'message', role: 'user', content: 'cap-only fixture' }] as never,
        { maxTurns: 3 },
      ), (error) => {
        caught = error;
        return error instanceof brackets.ToolCallsLimitExceeded;
      });
    const checkpoint = hostToolCallsLimitCheckpointFor(caught);
    assert.ok(checkpoint);
    assert.equal(model.calls(), 1, 'the model cannot reason past host budget control');
    const callIds = checkpoint.history
      .filter((item) => (item as { type?: string }).type === 'function_call')
      .map((item) => (item as { callId?: string }).callId);
    const resultIds = checkpoint.history
      .filter((item) => (item as { type?: string }).type === 'function_call_result')
      .map((item) => (item as { callId?: string }).callId);
    assert.deepEqual(resultIds, callIds, 'the admitted frame remains exactly paired');
    assert.deepEqual(dispositionMarkers(checkpoint.history), [{
      disposition: 'not_started',
      effect: 'none',
      retry: 'replan',
      requiresReconciliation: false,
    }]);
    assert.equal(firstRuns, 1, 'the one admitted call may execute');
    assert.equal(secondRuns, 0, 'the (limit + 1)th listener throw prevents its body');
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('host-owned accounting propagates an over-limit native MCP checkpoint', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  let firstRuns = 0;
  let secondRuns = 0;
  const model = stubModel([[
    toolCall('mcp-cap-first', 'native_cap_fixture', { slot: 1 }),
    toolCall('mcp-cap-second', 'native_cap_fixture', { slot: 2 }),
  ]]);
  const parent = {
    sessionId: 'cap-only-no-durable-source',
    counter: new brackets.ToolCallsCounter(1),
    behaviorScopeId: 'cap-only-no-durable-source::turn',
  };
  try {
    let caught: unknown;
    await assert.rejects(brackets.withHarnessRunContext(parent, () => hostRunRunner(
        throwingRunner() as never,
        {
          model,
          tools: [],
          getAllTools: async () => [{
            type: 'function', name: 'native_cap_fixture', description: 'cap-only external fixture',
            parameters: { type: 'object', properties: { slot: { type: 'number' } } },
            needsApproval: async () => false,
            invoke: async (_context: unknown, raw: string) => {
              const slot = (JSON.parse(raw) as { slot: number }).slot;
              if (slot === 1) firstRuns += 1;
              else secondRuns += 1;
              return `slot-${slot}`;
            },
          }],
        } as never,
        [{ type: 'message', role: 'user', content: 'cap-only fixture' }] as never,
        { maxTurns: 3 },
      )), (error) => {
        caught = error;
        return error instanceof brackets.ToolCallsLimitExceeded;
      });
    const checkpoint = hostToolCallsLimitCheckpointFor(caught);
    assert.ok(checkpoint);
    assert.equal(model.calls(), 1, 'the model cannot reason past host budget control');
    const callIds = checkpoint.history
      .filter((item) => (item as { type?: string }).type === 'function_call')
      .map((item) => (item as { callId?: string }).callId);
    const resultIds = checkpoint.history
      .filter((item) => (item as { type?: string }).type === 'function_call_result')
      .map((item) => (item as { callId?: string }).callId);
    assert.deepEqual(resultIds, callIds, 'the admitted frame remains exactly paired');
    assert.deepEqual(dispositionMarkers(checkpoint.history), [{
      disposition: 'not_started',
      effect: 'none',
      retry: 'replan',
      requiresReconciliation: false,
    }]);
    assert.equal(firstRuns, 1, 'the first native MCP call is admitted exactly once');
    assert.equal(secondRuns, 0, 'the over-limit native MCP body never starts');
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('a verified pre-dispatch refusal is paired after the whole tool frame and returned to the model', async () => {
  const task = acceptHostTask('terminal refusal');
  const secretTool = 'RAW_PROVIDER_SECRET_SLUG';
  const secretArgs = { actorId: 'raw-secret-actor', query: 'raw-secret-query' };
  let refusedRuns = 0;
  let siblingRuns = 0;
  const model = stubModel([
    [
      toolCall('call-stop', secretTool, secretArgs),
      toolCall('call-sibling', 'frame_sibling_read', { id: 'sibling-1' }),
    ],
    [textMsg('continued after the bounded refusal')],
  ]);
  const agent = {
    model,
    tools: [
      {
        type: 'function', name: secretTool, description: 'source read', parameters: { type: 'object', properties: {} },
        needsApproval: async () => false,
        invoke: async (_ctx: unknown, raw: string) => {
          refusedRuns += 1;
          const args = JSON.parse(raw);
          const settlement = commitHostSettlement({
            task,
            callId: 'call-stop',
            toolName: secretTool,
            args,
            signals: { preDispatch: true, policyRefused: true },
          });
          assert.equal(settlement?.outcome.directive.action, 'stop_and_explain');
          return `private refusal mentioning ${secretTool} ${JSON.stringify(args)}`;
        },
      },
      {
        type: 'function', name: 'frame_sibling_read', description: 'sibling read', parameters: { type: 'object', properties: {} },
        needsApproval: async () => false,
        invoke: async () => { siblingRuns += 1; return 'sibling-accounted'; },
      },
    ],
  };

  const outcome = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'go' }] as never,
    {
      maxTurns: 4,
      context: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq },
      toolExecution: { maxFunctionToolConcurrency: 2 },
    },
  );

  assert.equal(model.calls(), 2, 'a proven no-effect refusal returns to the model');
  assert.equal(refusedRuns, 1);
  assert.equal(siblingRuns, 1, 'all calls already emitted in the same frame are accounted');
  assert.equal(outcome.terminal, undefined);
  assert.equal(
    outcome.history.filter((item) => (item as { type?: string }).type === 'function_call_result').length,
    2,
    'both frame results are retained before the stop is consumed',
  );
  assert.equal(outcome.finalOutput, 'continued after the bounded refusal');
  const publicText = String(outcome.finalOutput);
  assert.doesNotMatch(publicText, new RegExp(secretTool, 'i'));
  assert.doesNotMatch(publicText, /raw-secret-actor|raw-secret-query|actorId/i);
  assert.doesNotMatch(publicText, /retry|resume|pick this back up/i);
});

test('repair, sibling, backoff, success, and missing durable settlements all continue to the next model step', async (t) => {
  const cases: Array<{
    name: string;
    signals?: Parameters<typeof outcomes.classifyAttemptOutcome>[0];
    executionKind?: 'refused_pre_dispatch' | 'local_execution';
    expectedAction?: string;
  }> = [
    {
      name: 'repair_arguments',
      signals: { preDispatch: true, argumentValidationFailed: true, schemaAvailable: true },
      expectedAction: 'repair_arguments',
    },
    {
      name: 'try_sibling_candidate',
      signals: { preDispatch: true, httpStatus: 404 },
      expectedAction: 'try_sibling_candidate',
    },
    {
      name: 'retry_with_backoff',
      signals: { preDispatch: true, httpStatus: 503 },
      expectedAction: 'retry_with_backoff',
    },
    {
      name: 'succeeded',
      signals: { hostExecuted: true },
      executionKind: 'local_execution',
      expectedAction: 'settle',
    },
    { name: 'missing_settlement' },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const task = acceptHostTask(fixture.name);
      const callId = `call-${fixture.name}`;
      const toolName = `tool_${fixture.name}`;
      const args = { query: fixture.name };
      const model = stubModel([
        [toolCall(callId, toolName, args)],
        [textMsg(`${fixture.name} continued`)],
      ]);
      const agent = {
        model,
        tools: [{
          type: 'function', name: toolName, description: fixture.name, parameters: { type: 'object', properties: {} },
          needsApproval: async () => false,
          invoke: async (_ctx: unknown, raw: string) => {
            if (fixture.signals) {
              const settlement = commitHostSettlement({
                task,
                callId,
                toolName,
                args: JSON.parse(raw),
                signals: fixture.signals,
                executionKind: fixture.executionKind,
              });
              assert.equal(settlement?.outcome.directive.action, fixture.expectedAction);
            }
            return fixture.name;
          },
        }],
      };
      const outcome = await hostRunRunner(
        throwingRunner() as never,
        agent as never,
        [] as never,
        { maxTurns: 4, context: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq } },
      );
      assert.equal(model.calls(), 2, `${fixture.name} must not consume terminal stop authority`);
      assert.equal(outcome.terminal, undefined);
      assert.equal(outcome.finalOutput, `${fixture.name} continued`);
    });
  }
});

test('a corrupt stop_and_explain settlement cannot manufacture a host terminal', async () => {
  const task = acceptHostTask('corrupt terminal refusal');
  const callId = 'call-corrupt-stop';
  const toolName = 'corrupt_source_read';
  const args = { query: 'private-corrupt-query' };
  const model = stubModel([
    [toolCall(callId, toolName, args)],
    [textMsg('continued after corrupt authority was rejected')],
  ]);
  const agent = {
    model,
    tools: [{
      type: 'function', name: toolName, description: 'read', parameters: { type: 'object', properties: {} },
      needsApproval: async () => false,
      invoke: async (_ctx: unknown, raw: string) => {
        commitHostSettlement({
          task,
          callId,
          toolName,
          args: JSON.parse(raw),
          signals: { preDispatch: true, policyRefused: true },
        });
        const db = eventlog.openEventLog();
        const immutable = db.prepare(`
          SELECT sql FROM sqlite_master
           WHERE type = 'trigger' AND name = 'trg_logical_call_settlement_row_immutable'
        `).get() as { sql: string } | undefined;
        assert.ok(immutable?.sql, 'the fixture must restore the production immutability trigger');
        db.exec('DROP TRIGGER trg_logical_call_settlement_row_immutable');
        try {
          db.prepare(`
            UPDATE logical_call_settlements
               SET semantic_digest = ?
             WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
          `).run('0'.repeat(64), task.sessionId, task.sourceUserSeq, callId);
        } finally {
          db.exec(immutable!.sql);
        }
        return 'private corrupt refusal';
      },
    }],
  };

  const outcome = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [] as never,
    { maxTurns: 4, context: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq } },
  );
  assert.equal(model.calls(), 2, 'corrupt authority is inert, not terminal authority');
  assert.equal(outcome.terminal, undefined);
  assert.equal(outcome.finalOutput, 'continued after corrupt authority was rejected');
});

test('host stepping materializes omitted strict-nullable fields before approval and invocation', async () => {
  const seenApprovalArgs: unknown[] = [];
  const seenInvokeArgs: unknown[] = [];
  const model = stubModel([
    [toolCall('c-workflow-get', 'workflow_get', {
      name: 'platform-49-slack-channel-review',
      section: 'metadata',
    })],
    [textMsg('read complete')],
  ]);
  const agent = {
    model,
    tools: [{
      type: 'function',
      name: 'workflow_get',
      description: 'read workflow metadata',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          section: { anyOf: [{ type: 'string', enum: ['metadata', 'full'] }, { type: 'null' }] },
          step: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['name', 'section', 'step'],
        additionalProperties: false,
      },
      needsApproval: async (_ctx: unknown, args: unknown) => {
        seenApprovalArgs.push(args);
        return false;
      },
      invoke: async (_ctx: unknown, raw: string) => {
        seenInvokeArgs.push(JSON.parse(raw));
        return 'metadata';
      },
    }],
  };

  const outcome = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'read metadata' }] as never,
    { maxTurns: 4 },
  );

  const expected = {
    name: 'platform-49-slack-channel-review',
    section: 'metadata',
    step: null,
  };
  assert.deepEqual(seenApprovalArgs, [expected]);
  assert.deepEqual(seenInvokeArgs, [expected]);
  assert.equal(outcome.finalOutput, 'read complete');
});

test('callModelInputFilter still shapes every model request', async () => {
  const seen: Array<{ instructions?: string }> = [];
  const model = {
    async getResponse(request: { systemInstructions?: string }) {
      seen.push({ ...(request.systemInstructions !== undefined ? { instructions: request.systemInstructions } : {}) });
      return { usage: {}, output: [textMsg('ok')], responseId: 'r1' };
    },
    getStreamedResponse: testModelStream,
  };
  await hostRunRunner(
    throwingRunner() as never,
    { model, instructions: 'base', tools: [] } as never,
    [] as never,
    {
      maxTurns: 3,
      callModelInputFilter: (args: { modelData: { input: unknown[]; instructions?: string } }) => ({
        input: args.modelData.input as never,
        instructions: `${args.modelData.instructions} + packet`,
      }),
    },
  );
  assert.deepEqual(seen, [{ instructions: 'base + packet' }]);
});

test('callModelInputFilter exceptions fail closed before any model dispatch', async () => {
  const model = stubModel([[textMsg('must never be reached')]]);
  await assert.rejects(
    hostRunRunner(
      throwingRunner() as never,
      { model, instructions: 'base', tools: [] } as never,
      [{ type: 'message', role: 'user', content: 'private request' }] as never,
      {
        maxTurns: 3,
        callModelInputFilter: () => {
          throw new Error('context projection failed');
        },
      },
    ),
    /context projection failed/,
  );
  assert.equal(model.calls(), 0, 'unfiltered history was never sent to the model');
});

test('async callModelInputFilter receives canonical arguments without mutating durable history', async () => {
  const original = { type: 'message', role: 'user', content: 'original request' } as const;
  const context = { sessionId: 'filter-context', sourceUserSeq: 42 };
  const agent = { instructions: 'base', tools: [] } as {
    model?: unknown;
    instructions: string;
    tools: unknown[];
  };
  let filterAgent: unknown;
  let filterContext: unknown;
  let modelInputText = '';
  agent.model = {
    async getResponse(request: { input: Array<{ content?: unknown }> }) {
      modelInputText = String(request.input[0]?.content ?? '');
      if (request.input[0]) request.input[0].content = 'provider mutation';
      return { usage: {}, output: [textMsg('ok')], responseId: 'async-filter' };
    },
    getStreamedResponse: testModelStream,
  };

  const outcome = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [original] as never,
    {
      maxTurns: 3,
      context,
      callModelInputFilter: async (args: {
        modelData: { input: Array<{ content?: unknown }>; instructions?: string };
        agent: unknown;
        context: unknown;
      }) => {
        filterAgent = args.agent;
        filterContext = args.context;
        args.modelData.input[0]!.content = 'filtered clone';
        await Promise.resolve();
        return args.modelData as never;
      },
    },
  );

  assert.equal(filterAgent, agent);
  assert.equal(filterContext, context);
  assert.equal(modelInputText, 'filtered clone');
  assert.equal(original.content, 'original request');
  assert.equal(
    (outcome.history[0] as { content?: unknown }).content,
    'original request',
    'filter/provider mutations cannot rewrite durable history',
  );
});

test('malformed callModelInputFilter output fails closed before model dispatch', async () => {
  const model = stubModel([[textMsg('must never be reached')]]);
  await assert.rejects(
    hostRunRunner(
      throwingRunner() as never,
      { model, instructions: 'base', tools: [] } as never,
      [{ type: 'message', role: 'user', content: 'private request' }] as never,
      {
        maxTurns: 3,
        callModelInputFilter: async () => ({ instructions: 'missing input' } as never),
      },
    ),
    /must return a model input object with an input array/i,
  );
  assert.equal(model.calls(), 0);
});

test('dynamic instructions are evaluated afresh before every host model step', async () => {
  let instructionReads = 0;
  const seen: string[] = [];
  let call = 0;
  const model = {
    async getResponse(request: { systemInstructions?: string }) {
      seen.push(request.systemInstructions ?? '');
      call += 1;
      return {
        usage: {},
        output: call === 1
          ? [toolCall('dynamic-call', 'dynamic_read', {})]
          : [textMsg('dynamic complete')],
        responseId: `dynamic-${call}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    {
      model,
      instructions: () => `memory-revision-${++instructionReads}`,
      tools: [{
        type: 'function', name: 'dynamic_read', description: 'read', parameters: { type: 'object', properties: {} },
        invoke: async () => 'fresh', needsApproval: async () => false,
      }],
    } as never,
    [] as never,
    { maxTurns: 4 },
  );
  assert.deepEqual(seen, ['memory-revision-1', 'memory-revision-2']);
  assert.equal(outcome.finalOutput, 'dynamic complete');
});

test('host tool resolution includes enabled MCP tools through agent.getAllTools', async () => {
  let toolRuns = 0;
  const schemas: string[][] = [];
  let call = 0;
  const mcpTool = {
    type: 'function', name: 'records__search', description: 'live MCP search',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    invoke: async () => { toolRuns += 1; return 'record'; },
    needsApproval: async () => false,
  };
  const model = {
    async getResponse(request: { tools?: Array<{ name?: string }> }) {
      schemas.push((request.tools ?? []).map((entry) => entry.name ?? ''));
      call += 1;
      return {
        usage: {},
        output: call === 1
          ? [toolCall('mcp-call', 'records__search', { query: 'current' })]
          : [textMsg('MCP complete')],
      };
    },
    getStreamedResponse: testModelStream,
  };
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    {
      model,
      tools: [],
      getAllTools: async () => [mcpTool],
    } as never,
    [] as never,
    { maxTurns: 4 },
  );
  assert.deepEqual(schemas, [['records__search'], ['records__search']]);
  assert.equal(toolRuns, 1);
  assert.equal(outcome.finalOutput, 'MCP complete');
});

test('production text, image, and file outputs remain structured in the next model projection', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const fixture = acceptHostCanarySource('mcp-structured-media-result');
    const projectedInputs: unknown[] = [];
    let call = 0;
    const model = {
      async getResponse(request: { input?: unknown }) {
        projectedInputs.push(structuredClone(request.input));
        call += 1;
        return {
          usage: {},
          output: call === 1
            ? [toolCall('mcp-media-call', 'task_list', {})]
            : [textMsg('media inspected')],
        };
      },
      getStreamedResponse: testModelStream,
    };
    const mediaTool = brackets.wrapToolForHarness({
        type: 'function', name: 'task_list', description: 'Host media result',
        parameters: { type: 'object', properties: {} },
        needsApproval: async () => false,
        invoke: async () => [
          { type: 'text', text: 'caption' },
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
          {
            type: 'file',
            fileData: 'cmVwb3J0',
            mediaType: 'text/plain',
            filename: 'report.txt',
          },
        ],
      });
    const agent = { model, tools: [mediaTool], getAllTools: async () => [mediaTool] };
    bindHostCanarySurface(fixture, agent, [mediaTool]);
    const outcome = await runProductionHost(fixture, agent);

    const result = outcome.history.find((item) =>
      (item as { type?: string }).type === 'function_call_result') as {
        output?: unknown;
      } | undefined;
    const expectedOutput = [
      { type: 'input_text', text: 'caption' },
      { type: 'input_image', image: 'data:image/png;base64,aW1hZ2U=' },
      {
        type: 'input_file',
        file: 'data:text/plain;base64,cmVwb3J0',
        filename: 'report.txt',
      },
    ];
    assert.deepEqual(result?.output, expectedOutput, 'history preserves the SDK protocol media shapes');
    assert.deepEqual(
      (projectedInputs[1] as unknown[]).find((item) =>
        (item as { type?: string }).type === 'function_call_result'),
      { type: 'function_call_result', callId: 'mcp-media-call', name: 'task_list', status: 'completed', output: expectedOutput },
      'the next model sees structured inputs rather than a JSON-stringified media array',
    );
    assert.equal(outcome.finalOutput, 'media inspected');
    assert.deepEqual(eventlog.openEventLog().prepare(`
      SELECT projection.result_class, checkpoint.disposition
        FROM logical_model_result_projection_receipts projection
        JOIN accepted_model_batch_checkpoints checkpoint
          ON checkpoint.session_id = projection.session_id
         AND checkpoint.source_user_seq = projection.source_user_seq
         AND checkpoint.batch_ordinal = projection.batch_ordinal
       WHERE projection.session_id = ? AND projection.source_user_seq = ?
    `).all(fixture.session.id, fixture.source.seq), [{
      result_class: 'media',
      disposition: 'ready',
    }], 'structured media bytes are sealed before their ready checkpoint');
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('unsupported tool, handoff, namespace, and output surfaces fail closed before a model call', async (t) => {
  const namespaceSymbol = Symbol('functionToolNamespace');
  const cases: Array<{ name: string; agent: Record<string | symbol, unknown>; reason: string }> = [
    {
      name: 'non-function tool',
      agent: { tools: [{ type: 'computer', name: 'computer' }] },
      reason: 'non_function_tool',
    },
    {
      name: 'handoff',
      agent: { tools: [], handoffs: [{}] },
      reason: 'handoff',
    },
    {
      name: 'structured output',
      agent: { tools: [], outputType: { type: 'object', properties: {} } },
      reason: 'structured_output',
    },
    {
      name: 'explicit function namespace',
      agent: {
        tools: [{
          type: 'function', name: 'search', parameters: { type: 'object', properties: {} },
          [namespaceSymbol]: 'records',
        }],
      },
      reason: 'function_namespace',
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let modelCalls = 0;
      const model = {
        async getResponse() { modelCalls += 1; return { usage: {}, output: [textMsg('must not run')] }; },
        async *getStreamedResponse() { modelCalls += 1; yield { type: 'response_started' } as never; },
      };
      const outcome = await hostRunRunner(
        throwingRunner() as never,
        { model, ...fixture.agent } as never,
        [] as never,
        { maxTurns: 2 },
      );
      assert.equal(modelCalls, 0);
      assert.equal(outcome.terminal?.status, 'blocked');
      assert.equal(outcome.terminal?.reason, `unsupported_capability:${fixture.reason}`);
      assert.doesNotMatch(String(outcome.finalOutput), /computer|handoff|records|schema/i);
    });
  }
});

test('toolUseBehavior remains the terminal control boundary without another model step', async () => {
  const model = stubModel([
    [toolCall('terminal-control', 'ask_once', {})],
    [textMsg('must not run')],
  ]);
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    {
      model,
      tools: [{
        type: 'function', name: 'ask_once', description: 'ask', parameters: { type: 'object', properties: {} },
        invoke: async () => 'Question posted: Which account?', needsApproval: async () => false,
      }],
      toolUseBehavior: async (_context: unknown, results: Array<{ output: unknown }>) => ({
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: String(results[0]?.output ?? ''),
      }),
    } as never,
    [] as never,
    { maxTurns: 4 },
  );
  assert.equal(model.calls(), 1);
  assert.equal(outcome.finalOutput, 'Question posted: Which account?');
});

test('mixed zero-crossing reads can terminally clarify without model continuation or a business write', async () => {
  const session = eventlog.createSession({
    id: `host-mixed-refusal-clarification-${++acceptedSerial}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send James Marshall a calendar invite.' },
  });
  let businessWrites = 0;
  const successfulBatches: string[][] = [];
  const model = stubModel([
    [
      toolCall('recipient-memory', 'memory_recall_all', { objective: 'James Marshall contact details' }),
      toolCall('calendar-capability', 'tool_search', { query: 'create calendar event' }),
      toolCall('refused-salesforce-escape', 'salesforce_contact_lookup', { name: 'James Marshall' }),
    ],
    [toolCall('business-write', 'memory_remember', { content: 'must not execute' })],
    [textMsg('must not reach another model step')],
  ]);
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    {
      model,
      tools: [
        {
          type: 'function', name: 'memory_recall_all', description: 'grounded recipient lookup',
          parameters: { type: 'object', properties: { objective: { type: 'string' } } },
          invoke: async () => 'No grounded email address found for James Marshall.',
          needsApproval: async () => false,
        },
        {
          type: 'function', name: 'tool_search', description: 'calendar capability lookup',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
          invoke: async () => JSON.stringify({
            capabilityRef: 'cap:resolved:calendar_create_event',
            connectedAccountId: 'connected-account-1',
          }),
          needsApproval: async () => false,
        },
        {
          type: 'function', name: 'memory_remember', description: 'business write sentinel',
          parameters: { type: 'object', properties: { content: { type: 'string' } } },
          invoke: async () => {
            businessWrites += 1;
            return 'must not execute';
          },
          needsApproval: async () => false,
        },
      ],
      toolUseBehavior: async (
        _context: unknown,
        results: Array<{ tool: { name: string }; output: unknown }>,
      ) => {
        const names = results.map((result) => result.tool.name);
        successfulBatches.push(names);
        if (names.join(',') !== 'memory_recall_all,tool_search') {
          return { isFinalOutput: false };
        }
        const question = 'What email address should I use for James Marshall?';
        eventlog.appendEvent({
          sessionId: session.id,
          turn: 1,
          role: 'Clem',
          type: 'awaiting_user_input',
          data: {
            question,
            purpose: 'recipient_identity',
            sourceUserSeq: source.seq,
          },
        });
        return { isFinalOutput: true, finalOutput: question };
      },
    } as never,
    [{ type: 'message', role: 'user', content: 'Send James Marshall a calendar invite.' }] as never,
    {
      maxTurns: 5,
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
    },
  );

  assert.equal(outcome.finalOutput, 'What email address should I use for James Marshall?');
  assert.equal(model.calls(), 1, 'the terminal clarification owns the turn');
  assert.equal(businessWrites, 0, 'a later model-authored business write never runs');
  assert.deepEqual(successfulBatches, [['memory_recall_all', 'tool_search']]);
  assert.equal(
    eventlog.listEvents(session.id, { types: ['awaiting_user_input'] }).length,
    1,
    'the host emits exactly one durable question',
  );
  assert.deepEqual(
    outcome.history
      .filter((item) => (item as { type?: string }).type === 'function_call_result')
      .map((item) => (item as { callId?: string }).callId),
    ['recipient-memory', 'calendar-capability', 'refused-salesforce-escape'],
    'successful and refused siblings remain paired in provider order',
  );
  assert.deepEqual(dispositionMarkers(outcome.history), [{
    disposition: 'refused_pre_dispatch',
    effect: 'none',
    retry: 'replan',
    requiresReconciliation: false,
  }]);
});

test('agent output guardrails still stop a secret-bearing final answer', async () => {
  const secret = `sk-${'a'.repeat(24)}`;
  const model = stubModel([[textMsg(`private ${secret}`)]]);
  await assert.rejects(
    hostRunRunner(
      throwingRunner() as never,
      { model, tools: [], outputGuardrails: guardrails.harnessOutputGuardrails } as never,
      [] as never,
      { maxTurns: 2 },
    ),
    (error: Error) => error.name === 'OutputGuardrailTripwireTriggered',
  );
});

test('FunctionTool errors remain model-visible and post-invocation control errors become effect-unknown', async (t) => {
  const handled = tool({
    name: 'handled_failure',
    description: 'test handled failure',
    parameters: z.object({}),
    execute: async () => { throw new Error('ordinary provider error'); },
    errorFunction: () => 'handled corrective',
  });
  const handledModel = stubModel([
    [toolCall('handled-call', 'handled_failure', {})],
    [textMsg('recovered')],
  ]);
  const handledOutcome = await hostRunRunner(
    throwingRunner() as never,
    { model: handledModel, tools: [handled] } as never,
    [] as never,
    { maxTurns: 4 },
  );
  assert.equal(handledOutcome.finalOutput, 'recovered');
  assert.match(JSON.stringify(handledOutcome.history), /handled corrective/);

  const fatalErrors = [
    new brackets.KillRequested('fatal-host-kill'),
    new brackets.ToolCallsLimitExceeded(1),
    new dispatchLeases.StaleDispatchLeaseError({
      sessionId: 'fatal-host-lease',
      scopeId: 'scope',
      leaseId: 'lease',
    }),
  ];
  for (const fatal of fatalErrors) {
    await t.test(fatal.name, async () => {
      const model = stubModel([[toolCall(`fatal-${fatal.name}`, 'fatal_tool', {})]]);
      const outcome = await hostRunRunner(
          throwingRunner() as never,
          {
            model,
            tools: [{
              type: 'function', name: 'fatal_tool', description: 'fatal', parameters: { type: 'object', properties: {} },
              invoke: async () => { throw fatal; }, needsApproval: async () => false,
            }],
          } as never,
          [] as never,
          { maxTurns: 2 },
        );
      assert.deepEqual(outcome.terminal, { status: 'blocked', reason: 'tool_effect_uncertain' });
      assert.equal(model.calls(), 1);
      assert.deepEqual(dispositionMarkers(outcome.history), [{
        disposition: 'effect_unknown',
        effect: 'may_have_started',
        retry: 'do_not_retry',
        requiresReconciliation: true,
      }]);
    });
  }
});

test('provider truncation becomes one typed blocked checkpoint and never auto-continues', async () => {
  let calls = 0;
  const model = {
    async getResponse() {
      calls += 1;
      return {
        usage: {},
        output: [textMsg('partial private draft')],
        providerData: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      };
    },
    getStreamedResponse: testModelStream,
  };
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    { model, tools: [] } as never,
    [] as never,
    { maxTurns: 8 },
  );
  assert.equal(calls, 1);
  assert.equal(outcome.terminal?.status, 'blocked');
  assert.equal(outcome.terminal?.reason, 'provider_limit_hit');
  assert.doesNotMatch(String(outcome.finalOutput), /partial private draft|say continue/i);
});

test('continuous private reasoning may exceed the first-content wall without exceeding inactivity', async (t) => {
  const priorFirst = process.env.CLEMMY_MODEL_FIRST_BYTE_STALL_MS;
  const priorStream = process.env.CLEMMY_MODEL_STREAM_STALL_MS;
  const firstContentWallMs = 25;
  const streamInactivityWallMs = 2_000;
  const reasoningPulseCount = 5;
  const reasoningPulseAdvanceMs = 10;
  const schedulerBarrierMs = 12;
  const reasoningDurationMs = (reasoningPulseCount - 1) * reasoningPulseAdvanceMs;
  assert.ok(
    reasoningDurationMs > firstContentWallMs,
    'the private-reasoning fixture must outlive the first-content wall',
  );
  assert.ok(
    reasoningPulseAdvanceMs < firstContentWallMs
      && reasoningPulseAdvanceMs < streamInactivityWallMs,
    'every private-reasoning pulse must remain inside both inactivity windows',
  );
  // The stall wall is clock-based, but scheduler delay is not model silence.
  // Advance the wall clock only at explicit pulse boundaries while retaining a
  // real timer barrier long enough for the production stall poll to run between
  // pulses. A loaded host can delay either timer without manufacturing logical
  // inactivity, and the cumulative reasoning span still exceeds the first-
  // content wall deterministically.
  let logicalNow = Date.now();
  t.mock.method(Date, 'now', () => logicalNow);
  process.env.CLEMMY_MODEL_FIRST_BYTE_STALL_MS = String(firstContentWallMs);
  process.env.CLEMMY_MODEL_STREAM_STALL_MS = String(streamInactivityWallMs);
  let streamCalls = 0;
  const model = {
    async getResponse(): Promise<never> { throw new Error('streaming path required'); },
    async *getStreamedResponse() {
      streamCalls += 1;
      for (let i = 0; i < reasoningPulseCount; i += 1) {
        yield { type: 'model', event: { type: 'reasoning-delta', delta: `thinking-${i}` } } as never;
        if (i + 1 < reasoningPulseCount) {
          await new Promise((resolve) => setTimeout(resolve, schedulerBarrierMs));
          logicalNow += reasoningPulseAdvanceMs;
        }
      }
      yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } } as never;
      yield {
        type: 'response_done',
        response: {
          id: 'active-reasoning',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [textMsg('reasoning completed')],
        },
      } as never;
    },
  };
  try {
    const outcome = await hostRunRunner(
      throwingRunner() as never,
      { model, tools: [] } as never,
      [] as never,
      { maxTurns: 2 },
    );
    assert.equal(streamCalls, 1);
    assert.equal(outcome.finalOutput, 'reasoning completed');
    assert.equal(outcome.terminal, undefined);
  } finally {
    if (priorFirst === undefined) delete process.env.CLEMMY_MODEL_FIRST_BYTE_STALL_MS;
    else process.env.CLEMMY_MODEL_FIRST_BYTE_STALL_MS = priorFirst;
    if (priorStream === undefined) delete process.env.CLEMMY_MODEL_STREAM_STALL_MS;
    else process.env.CLEMMY_MODEL_STREAM_STALL_MS = priorStream;
  }
});

test('an empty current step cannot complete with stale text from an earlier tool frame', async () => {
  let step = 0;
  let toolRuns = 0;
  const model = {
    async getResponse(): Promise<never> { throw new Error('streaming path required'); },
    async *getStreamedResponse() {
      step += 1;
      const output = step === 1
        ? [textMsg('stale earlier narration'), toolCall('stale-call', 'stale_read', {})]
        : [{ type: 'reasoning', content: [{ type: 'input_text', text: 'private only' }] }];
      yield {
        type: 'model',
        event: { type: 'finish', finishReason: step === 1 ? 'tool_calls' : 'stop' },
      } as never;
      yield {
        type: 'response_done',
        response: {
          id: `stale-${step}`,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output,
        },
      } as never;
    },
  };
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    {
      model,
      tools: [{
        type: 'function', name: 'stale_read', description: 'read',
        parameters: { type: 'object', properties: {} },
        needsApproval: async () => false,
        invoke: async () => { toolRuns += 1; return 'read'; },
      }],
    } as never,
    [] as never,
    { maxTurns: 3 },
  );
  assert.equal(toolRuns, 1);
  assert.equal(step, 2);
  assert.equal(outcome.terminal?.status, 'blocked');
  assert.equal(outcome.terminal?.reason, 'model_empty_completion');
  assert.doesNotMatch(String(outcome.finalOutput), /stale earlier narration/);
});

test('runTurn consumes a host terminal before run_completed or success hooks', async () => {
  const session = eventlog.createSession({ id: 'host-loop-terminal-consumption', kind: 'chat' });
  let calls = 0;
  const model = {
    async getResponse() {
      calls += 1;
      return {
        usage: {},
        output: [textMsg('private partial answer')],
        providerData: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      };
    },
    getStreamedResponse: testModelStream,
  };
  const result = await runTurn({
    sessionId: session.id,
    input: 'Hello Clem.',
    agent: { model, tools: [], instructions: 'reply' } as never,
    makeRunner: throwingRunner as never,
    runRunner: productionHostRunRunner,
    maxTurns: 3,
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'blocked');
  assert.doesNotMatch(result.error ?? '', /private partial answer|say continue/i);
  assert.equal(
    eventlog.listEvents(session.id, { types: ['run_completed'] }).length,
    0,
    'a typed host stop is never recorded as ordinary completion',
  );
});

test('a pre-content host model stall retries within its exact budget before becoming blocked', async () => {
  const prior = process.env.CLEMMY_MODEL_STREAM_STALL_MS;
  const priorRetries = process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES;
  process.env.CLEMMY_MODEL_STREAM_STALL_MS = '25';
  process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES = '3';
  let calls = 0;
  let observedAborts = 0;
  const model = {
    async getResponse(request: { signal?: AbortSignal }) {
      calls += 1;
      return await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          observedAborts += 1;
          reject(request.signal?.reason ?? new Error('aborted'));
        }, { once: true });
      });
    },
    getStreamedResponse: testModelStream,
  };
  try {
    const outcome = await hostRunRunner(
      throwingRunner() as never,
      { model, tools: [] } as never,
      [] as never,
      { maxTurns: 8 },
    );
    assert.equal(calls, 4, 'one initial attempt plus the exact three-attempt pre-content retry budget');
    assert.equal(observedAborts, 4, 'every retired stalled attempt is aborted before the next begins');
    assert.equal(outcome.terminal?.status, 'blocked');
    assert.equal(outcome.terminal?.reason, 'model_stalled');
    assert.doesNotMatch(String(outcome.finalOutput), /say continue|retry/i);
  } finally {
    if (prior === undefined) delete process.env.CLEMMY_MODEL_STREAM_STALL_MS;
    else process.env.CLEMMY_MODEL_STREAM_STALL_MS = prior;
    if (priorRetries === undefined) delete process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES;
    else process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES = priorRetries;
  }
});

test('a stalled host model step is rescued by the next brain instead of dying (fallover survives the watchdog)', async () => {
  // Live 2026-09-02: the watchdog aborted the same controller whose signal
  // rode the model request, the fallback boundary read that as the user
  // cancelling, and an 11-minute silent turn died with two healthy brains in
  // the chain. Now the watchdog RETIRES the attempt with a typed deadline
  // reason and keeps the step open while the next brain takes it.
  const prior = process.env.CLEMMY_MODEL_STREAM_STALL_MS;
  const priorRetries = process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES;
  const priorGrace = process.env.CLEMMY_MODEL_STALL_FALLOVER_GRACE_MS;
  process.env.CLEMMY_MODEL_STREAM_STALL_MS = '40';
  process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES = '0';
  process.env.CLEMMY_MODEL_STALL_FALLOVER_GRACE_MS = '5000';
  const { withModelFallback } = await import('./fallback-model.js');
  let stalledAborts = 0;
  let rescueCalls = 0;
  const stalled = {
    async getResponse(request: { signal?: AbortSignal }) {
      return await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          stalledAborts += 1;
          reject(request.signal?.reason ?? new Error('aborted'));
        }, { once: true });
      });
    },
    getStreamedResponse: testModelStream,
  };
  const rescue = {
    async getResponse() {
      rescueCalls += 1;
      return { usage: {}, output: [textMsg('rescued by the next brain')] };
    },
    getStreamedResponse: testModelStream,
  };
  const model = withModelFallback([
    { label: 'stalled', getModel: () => stalled as never },
    { label: 'rescue', getModel: () => rescue as never },
  ]);
  try {
    const outcome = await hostRunRunner(
      throwingRunner() as never,
      { model, tools: [] } as never,
      [] as never,
      { maxTurns: 8 },
    );
    assert.equal(stalledAborts, 1, 'the stalled attempt was retired exactly once');
    assert.equal(rescueCalls, 1, 'the next brain took the step');
    assert.notEqual(outcome.terminal?.status, 'blocked', 'the step completed on the rescue brain');
    assert.match(String(outcome.finalOutput), /rescued by the next brain/);
  } finally {
    if (prior === undefined) delete process.env.CLEMMY_MODEL_STREAM_STALL_MS;
    else process.env.CLEMMY_MODEL_STREAM_STALL_MS = prior;
    if (priorRetries === undefined) delete process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES;
    else process.env.CLEMMY_MODEL_STREAM_STALL_RETRIES = priorRetries;
    if (priorGrace === undefined) delete process.env.CLEMMY_MODEL_STALL_FALLOVER_GRACE_MS;
    else process.env.CLEMMY_MODEL_STALL_FALLOVER_GRACE_MS = priorGrace;
  }
});

test('a kill arriving during a host model step aborts and propagates to the shared reducer', async () => {
  const session = eventlog.createSession({ id: 'host-mid-model-kill', kind: 'chat' });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let observedAbort = false;
  const model = {
    async getResponse(request: { signal?: AbortSignal }) {
      markStarted();
      return await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          observedAbort = true;
          reject(request.signal?.reason ?? new Error('aborted'));
        }, { once: true });
      });
    },
    getStreamedResponse: testModelStream,
  };
  const parent = {
    sessionId: session.id,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  };
  const pending = brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    { model, tools: [] } as never,
    [] as never,
    { maxTurns: 4 },
  ));
  await started;
  eventlog.requestKill(session.id, 'host test kill');
  await assert.rejects(pending, (error: unknown) => error instanceof brackets.KillRequested);
  assert.equal(observedAbort, true);
  eventlog.clearKill(session.id);
});

test('one host invocation owns an exact dispatch lease and revokes it before returning', async () => {
  const session = eventlog.createSession({ id: 'host-exact-dispatch-lease', kind: 'chat' });
  let observedLease: dispatchLeases.DispatchLeaseRef | undefined;
  const model = stubModel([
    [toolCall('leased-call', 'leased_read', {})],
    [textMsg('leased complete')],
  ]);
  const parent = {
    sessionId: session.id,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  };
  const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    {
      model,
      tools: [{
        type: 'function', name: 'leased_read', description: 'read', parameters: { type: 'object', properties: {} },
        invoke: async () => {
          observedLease = brackets.harnessRunContextStorage.getStore()?.dispatchLease;
          assert.ok(observedLease, 'the tool must run under a physical lease');
          assert.equal(dispatchLeases.isDispatchLeaseCurrent(observedLease), true);
          return 'leased';
        },
        needsApproval: async () => false,
      }],
    } as never,
    [] as never,
    { maxTurns: 4 },
  ));
  assert.equal(outcome.finalOutput, 'leased complete');
  assert.ok(observedLease);
  assert.equal(dispatchLeases.isDispatchLeaseCurrent(observedLease), false, 'return waits for exact revocation');
});

test('independent nonapproval calls execute concurrently while result history stays in call order', async () => {
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  let firstObservedSecond = false;
  const model = stubModel([
    [
      toolCall('c-first', 'list_files', { slot: 1 }),
      toolCall('c-second', 'list_files', { slot: 2 }),
    ],
    [textMsg('both reads complete')],
  ]);
  const agent = {
    model,
    tools: [{
      type: 'function', name: 'list_files', description: 'read', parameters: { type: 'object', properties: {} },
      invoke: async (_ctx: unknown, raw: string) => {
        const slot = (JSON.parse(raw) as { slot: number }).slot;
        if (slot === 2) {
          markSecondStarted();
          return 'second-result';
        }
        firstObservedSecond = await Promise.race([
          secondStarted.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
        ]);
        return 'first-result';
      },
      needsApproval: async () => false,
    }],
  };

  const outcome = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'read both' }] as never,
    { maxTurns: 4, toolExecution: { maxFunctionToolConcurrency: 2 } },
  );

  assert.equal(firstObservedSecond, true, 'the second invocation began before the first completed');
  const resultIds = outcome.history
    .filter((item) => (item as { type?: string }).type === 'function_call_result')
    .map((item) => (item as { callId?: string }).callId);
  assert.deepEqual(resultIds, ['c-first', 'c-second'], 'completion timing cannot reorder model history');
  assert.equal(outcome.finalOutput, 'both reads complete');
});

test('an uncertain sibling drains started calls, pairs the whole frame, and starts no queued call', async () => {
  const session = eventlog.createSession({ id: 'host-fatal-frame-drain', kind: 'chat' });
  const fatal = new brackets.KillRequested('fatal sibling');
  let markSiblingStarted!: () => void;
  const siblingStarted = new Promise<void>((resolve) => { markSiblingStarted = resolve; });
  let releaseSibling!: () => void;
  const siblingRelease = new Promise<void>((resolve) => { releaseSibling = resolve; });
  let markFatalObserved!: () => void;
  const fatalObserved = new Promise<void>((resolve) => { markFatalObserved = resolve; });
  let siblingLease: dispatchLeases.DispatchLeaseRef | undefined;
  let queuedRuns = 0;
  const model = stubModel([[
    toolCall('fatal-call', 'list_files', { slot: 'fatal' }),
    toolCall('sibling-call', 'list_files', { slot: 'sibling' }),
    toolCall('queued-call', 'list_files', { slot: 'queued' }),
  ]]);
  const parent = {
    sessionId: session.id,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  };
  const pending = brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    {
      model,
      tools: [{
        type: 'function', name: 'list_files', description: 'frame drain',
        parameters: { type: 'object', properties: { slot: { type: 'string' } } },
        needsApproval: async () => false,
        invoke: async (_context: unknown, raw: string) => {
          const slot = (JSON.parse(raw) as { slot: string }).slot;
          if (slot === 'fatal') {
            await siblingStarted;
            markFatalObserved();
            throw fatal;
          }
          if (slot === 'sibling') {
            siblingLease = brackets.harnessRunContextStorage.getStore()?.dispatchLease;
            assert.ok(siblingLease);
            markSiblingStarted();
            await siblingRelease;
            assert.equal(
              dispatchLeases.isDispatchLeaseCurrent(siblingLease),
              true,
              'the sibling keeps its admitted lease until the whole started frame drains',
            );
            return 'sibling-complete';
          }
          queuedRuns += 1;
          return 'must-not-run';
        },
      }],
    } as never,
    [] as never,
    { maxTurns: 2, toolExecution: { maxFunctionToolConcurrency: 2 } },
  ));

  await fatalObserved;
  assert.equal(
    await Promise.race([
      pending.then(() => 'settled', () => 'settled'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]),
    'pending',
    'the fatal error cannot escape while a sibling still owns the lease',
  );
  assert.equal(queuedRuns, 0, 'the not-yet-started call is never assigned after the fatal error');
  releaseSibling();
  const outcome = await pending;
  assert.deepEqual(outcome.terminal, { status: 'blocked', reason: 'tool_effect_uncertain' });
  assert.deepEqual(
    outcome.history
      .filter((item) => (item as { type?: string }).type === 'function_call_result')
      .map((item) => (item as { callId?: string }).callId),
    ['fatal-call', 'sibling-call', 'queued-call'],
    'every emitted call is paired in original order after the started frame drains',
  );
  assert.deepEqual(dispositionMarkers(outcome.history), [
    {
      disposition: 'effect_unknown',
      effect: 'may_have_started',
      retry: 'do_not_retry',
      requiresReconciliation: true,
    },
    {
      disposition: 'not_started',
      effect: 'none',
      retry: 'replan',
      requiresReconciliation: false,
    },
  ]);
  assert.ok(siblingLease);
  assert.equal(dispatchLeases.isDispatchLeaseCurrent(siblingLease), false, 'revocation follows frame drain');
  assert.equal(queuedRuns, 0);
});

test('a tool ceiling drains its started sibling before propagating the exact paired checkpoint', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const session = eventlog.createSession({ id: 'host-tool-ceiling-frame-drain', kind: 'chat' });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let releaseStarted!: () => void;
  const startedRelease = new Promise<void>((resolve) => { releaseStarted = resolve; });
  let startedLease: dispatchLeases.DispatchLeaseRef | undefined;
  let overflowRuns = 0;
  let queuedRuns = 0;
  const callIds = ['ceiling-started', 'ceiling-overflow', 'ceiling-queued'];
  const model = stubModel([[
    toolCall(callIds[0]!, 'list_files', { slot: 'started' }),
    toolCall(callIds[1]!, 'list_files', { slot: 'overflow' }),
    toolCall(callIds[2]!, 'list_files', { slot: 'queued' }),
  ]]);
  const parent = {
    sessionId: session.id,
    counter: new brackets.ToolCallsCounter(1),
    behaviorScopeId: `${session.id}::turn:1`,
  };

  try {
    const pending = brackets.withHarnessRunContext(parent, () => hostRunRunner(
      throwingRunner() as never,
      {
        model,
        tools: [{
          type: 'function', name: 'list_files', description: 'ceiling frame drain',
          parameters: { type: 'object', properties: { slot: { type: 'string' } } },
          needsApproval: async () => false,
          invoke: async (_context: unknown, raw: string) => {
            const slot = (JSON.parse(raw) as { slot: string }).slot;
            if (slot === 'started') {
              startedLease = brackets.harnessRunContextStorage.getStore()?.dispatchLease;
              assert.ok(startedLease);
              markStarted();
              await startedRelease;
              assert.equal(dispatchLeases.isDispatchLeaseCurrent(startedLease), true,
                'the started call retains its lease until the whole frame drains');
              return 'started-result-preserved';
            }
            if (slot === 'overflow') overflowRuns += 1;
            else queuedRuns += 1;
            return 'must-not-run';
          },
        }],
      } as never,
      [] as never,
      { maxTurns: 2, toolExecution: { maxFunctionToolConcurrency: 2 } },
    )).then(
      (outcome) => ({ outcome, error: undefined as unknown }),
      (error: unknown) => ({ outcome: undefined, error }),
    );

    await started;
    assert.equal(await Promise.race([
      pending.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]), 'pending', 'the ceiling cannot escape while a started sibling is still running');
    assert.equal(overflowRuns, 0, 'the limit + 1 body never starts');
    assert.equal(queuedRuns, 0, 'no later call is assigned after the ceiling');

    releaseStarted();
    const settled = await pending;
    assert.equal(settled.outcome, undefined);
    assert.ok(settled.error instanceof brackets.ToolCallsLimitExceeded);
    const checkpoint = hostToolCallsLimitCheckpointFor(settled.error);
    assert.ok(checkpoint);
    const resultItems = checkpoint.history.filter(
      (item) => (item as { type?: unknown }).type === 'function_call_result',
    );
    assert.deepEqual(resultItems.map((item) => String((item as { callId?: unknown }).callId ?? '')), callIds,
      'started and unstarted calls remain paired in admitted order');
    assert.match(JSON.stringify(resultItems[0]), /started-result-preserved/,
      'the settled sibling output survives the control-flow checkpoint');
    assert.deepEqual(dispositionMarkers(checkpoint.history), [
      { disposition: 'not_started', effect: 'none', retry: 'replan', requiresReconciliation: false },
      { disposition: 'not_started', effect: 'none', retry: 'replan', requiresReconciliation: false },
    ]);
    assert.ok(!JSON.stringify(resultItems).includes('countsRefusal'),
      'a budget checkpoint never spends the capability no-progress brake');
    assert.ok(startedLease);
    assert.equal(dispatchLeases.isDispatchLeaseCurrent(startedLease), false,
      'the host revokes the frame lease only after drain and propagation');
    assert.equal(model.calls(), 1);
    assert.equal(overflowRuns, 0);
    assert.equal(queuedRuns, 0);
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('effect uncertainty wins when a sibling also reaches the tool ceiling', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const session = eventlog.createSession({ id: 'host-tool-ceiling-uncertain-precedence', kind: 'chat' });
  let markUncertainStarted!: () => void;
  const uncertainStarted = new Promise<void>((resolve) => { markUncertainStarted = resolve; });
  let releaseUncertain!: () => void;
  const uncertainRelease = new Promise<void>((resolve) => { releaseUncertain = resolve; });
  let overflowRuns = 0;
  let queuedRuns = 0;
  const callIds = ['uncertain-started', 'uncertain-overflow', 'uncertain-queued'];
  const parent = {
    sessionId: session.id,
    counter: new brackets.ToolCallsCounter(1),
    behaviorScopeId: `${session.id}::turn:1`,
  };

  try {
    const pending = brackets.withHarnessRunContext(parent, () => hostRunRunner(
      throwingRunner() as never,
      {
        model: stubModel([[
          toolCall(callIds[0]!, 'list_files', { slot: 'uncertain' }),
          toolCall(callIds[1]!, 'list_files', { slot: 'overflow' }),
          toolCall(callIds[2]!, 'list_files', { slot: 'queued' }),
        ]]),
        tools: [{
          type: 'function', name: 'list_files', description: 'uncertain ceiling precedence',
          parameters: { type: 'object', properties: { slot: { type: 'string' } } },
          needsApproval: async () => false,
          invoke: async (_context: unknown, raw: string) => {
            const slot = (JSON.parse(raw) as { slot: string }).slot;
            if (slot === 'uncertain') {
              markUncertainStarted();
              await uncertainRelease;
              throw new Error('invocation crossed before failure');
            }
            if (slot === 'overflow') overflowRuns += 1;
            else queuedRuns += 1;
            return 'must-not-run';
          },
        }],
      } as never,
      [] as never,
      { maxTurns: 2, toolExecution: { maxFunctionToolConcurrency: 2 } },
    ));

    await uncertainStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(overflowRuns, 0);
    assert.equal(queuedRuns, 0);
    releaseUncertain();
    const outcome = await pending;
    assert.deepEqual(outcome.terminal, { status: 'blocked', reason: 'tool_effect_uncertain' },
      'a soft budget checkpoint cannot override reconciliation ownership');
    assert.deepEqual(
      outcome.history
        .filter((item) => (item as { type?: string }).type === 'function_call_result')
        .map((item) => (item as { callId?: string }).callId),
      callIds,
    );
    assert.deepEqual(dispositionMarkers(outcome.history), [
      { disposition: 'effect_unknown', effect: 'may_have_started', retry: 'do_not_retry', requiresReconciliation: true },
      { disposition: 'not_started', effect: 'none', retry: 'replan', requiresReconciliation: false },
      { disposition: 'not_started', effect: 'none', retry: 'replan', requiresReconciliation: false },
    ]);
    assert.ok(!JSON.stringify(outcome.history).includes('countsRefusal'),
      'uncertainty + ceiling does not manufacture a capability-refusal brake');
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('malformed tool arguments become a correlated result without approval or execution', async () => {
  let approvalChecks = 0;
  let bodyRuns = 0;
  const model = stubModel([
    [{ type: 'function_call', callId: 'bad-json', name: 'guarded_write', arguments: '{not-json' }],
    [textMsg('corrected after parse error')],
  ]);
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    {
      model,
      tools: [{
        type: 'function', name: 'guarded_write', description: 'write',
        parameters: { type: 'object', properties: { value: { type: 'string' } } },
        needsApproval: async () => { approvalChecks += 1; return true; },
        invoke: async () => { bodyRuns += 1; return 'must-not-run'; },
      }],
    } as never,
    [] as never,
    { maxTurns: 3 },
  );
  assert.equal(approvalChecks, 0, 'approval policy never receives malformed/raw text');
  assert.equal(bodyRuns, 0, 'the tool body never receives malformed arguments');
  assert.match(JSON.stringify(outcome.history), /bad-json.*invalid arguments/i);
  assert.equal(outcome.finalOutput, 'corrected after parse error');
});

test('user-edited approval arguments traverse the same parse gate on resume', async () => {
  let approvalChecks = 0;
  let bodyRuns = 0;
  const model = stubModel([
    [toolCall('edited-approval', 'edited_write', { value: 'valid-before-pause' })],
    [textMsg('invalid edit was not executed')],
  ]);
  const agent = {
    model,
    tools: [{
      type: 'function', name: 'edited_write', description: 'write',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      needsApproval: async () => { approvalChecks += 1; return true; },
      invoke: async () => { bodyRuns += 1; return 'must-not-run'; },
    }],
  };
  const paused = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [] as never,
    { maxTurns: 3 },
  );
  assert.equal(paused.hasInterruptions, true);
  assert.equal(approvalChecks, 1);
  const state = HostInterruptState.fromString(paused.serializedState!);
  const interruption = state.getInterruptions()[0] as {
    rawItem: { arguments: string };
  };
  interruption.rawItem.arguments = '[]';
  state.approve(interruption);
  const resumed = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    state as never,
    { maxTurns: 3 },
  );
  assert.equal(approvalChecks, 1, 'resume does not re-authorize the edited payload implicitly');
  assert.equal(bodyRuns, 0);
  assert.match(JSON.stringify(resumed.history), /edited-approval.*invalid arguments/i);
  assert.equal(resumed.finalOutput, 'invalid edit was not executed');
});

test('approval pauses BEFORE execution; resume executes the approved tool exactly once', async () => {
  let sendRuns = 0;
  const model = stubModel([
    [toolCall('c-send', 'send_email', { to: 'x@y.com' })],
    [textMsg('sent and finished')],
  ]);
  const agent = {
    model,
    tools: [{
      type: 'function', name: 'send_email', description: 'send', parameters: { type: 'object', properties: {} },
      invoke: async () => { sendRuns += 1; return 'sent'; },
      needsApproval: async () => true,
    }],
  };
  const paused = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'email it' }] as never,
    { maxTurns: 6 },
  );
  assert.equal(paused.hasInterruptions, true);
  assert.equal(sendRuns, 0, 'the paused tool body never ran');
  assert.equal(paused.interruptions?.[0]?.toolName, 'send_email');
  assert.ok(paused.serializedState);

  // The resume owner's exact duck-typed flow: deserialize, list, approve.
  const state = HostInterruptState.fromString(paused.serializedState!);
  const pending = state.getInterruptions();
  assert.equal(pending.length, 1);
  state.approve(pending[0]);

  const resumed = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    state as never,
    { maxTurns: 6 },
  );
  assert.equal(sendRuns, 1, 'the approved tool executed exactly ONCE');
  assert.equal(resumed.finalOutput, 'sent and finished');
  assert.equal(resumed.hasInterruptions ?? false, false);
});

test('needsApproval exceptions fail closed as an explicit approval pause', async () => {
  let writeRuns = 0;
  const model = stubModel([
    [toolCall('c-guard-error', 'dangerous_write', { value: 1 })],
    [textMsg('write completed after confirmation')],
  ]);
  const agent = {
    model,
    tools: [{
      type: 'function', name: 'dangerous_write', description: 'write', parameters: { type: 'object', properties: {} },
      invoke: async () => { writeRuns += 1; return 'written'; },
      needsApproval: async () => { throw new Error('approval policy unavailable'); },
    }],
  };

  const paused = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'change it' }] as never,
    { maxTurns: 4 },
  );
  assert.equal(paused.hasInterruptions, true);
  assert.equal(paused.interruptions?.[0]?.toolName, 'dangerous_write');
  assert.equal(writeRuns, 0, 'a failed predicate cannot authorize the write');

  const state = HostInterruptState.fromString(paused.serializedState!);
  state.approve(state.getInterruptions()[0]);
  const resumed = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    state as never,
    { maxTurns: 4 },
  );
  assert.equal(writeRuns, 1, 'the write runs only after the explicit approval');
  assert.equal(resumed.finalOutput, 'write completed after confirmation');
});

test('mixed approval batches preserve and settle every sibling exactly once across resume', async () => {
  const runs = new Map<string, number>();
  const countRun = (name: string): string => {
    runs.set(name, (runs.get(name) ?? 0) + 1);
    return `${name}-result`;
  };
  const model = stubModel([
    [
      toolCall('c-read-before', 'read_before', {}),
      toolCall('c-write', 'confirmed_write', { value: 'x' }),
      toolCall('c-read-after', 'read_after', {}),
    ],
    [textMsg('entire batch complete')],
  ]);
  const agent = {
    model,
    tools: [
      {
        type: 'function', name: 'read_before', description: 'read', parameters: { type: 'object', properties: {} },
        invoke: async () => countRun('read_before'), needsApproval: async () => false,
      },
      {
        type: 'function', name: 'confirmed_write', description: 'write', parameters: { type: 'object', properties: {} },
        invoke: async () => countRun('confirmed_write'), needsApproval: async () => true,
      },
      {
        type: 'function', name: 'read_after', description: 'read', parameters: { type: 'object', properties: {} },
        invoke: async () => countRun('read_after'), needsApproval: async () => false,
      },
    ],
  };

  const paused = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'do the batch' }] as never,
    { maxTurns: 5, toolExecution: { maxFunctionToolConcurrency: 3 } },
  );
  assert.equal(paused.hasInterruptions, true);
  assert.equal(paused.interruptions?.length, 1, 'only the write asks for approval');
  assert.deepEqual(Object.fromEntries(runs), {}, 'nothing in the mixed batch executes before the pause');

  const state = HostInterruptState.fromString(paused.serializedState!);
  assert.deepEqual(
    state.pending.map((pending) => [pending.callId, pending.decision ?? 'awaiting']),
    [
      ['c-read-before', 'approved'],
      ['c-write', 'awaiting'],
      ['c-read-after', 'approved'],
    ],
    'the pause serialized both nonapproval siblings with the write',
  );
  state.approve(state.getInterruptions()[0]);

  const resumed = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    state as never,
    { maxTurns: 5, toolExecution: { maxFunctionToolConcurrency: 3 } },
  );
  assert.deepEqual(Object.fromEntries(runs), {
    read_before: 1,
    confirmed_write: 1,
    read_after: 1,
  });
  const resultIds = resumed.history
    .filter((item) => (item as { type?: string }).type === 'function_call_result')
    .map((item) => (item as { callId?: string }).callId);
  assert.deepEqual(resultIds, ['c-read-before', 'c-write', 'c-read-after']);
  assert.equal(resumed.finalOutput, 'entire batch complete');
});

test('a rejected approval becomes a visible tool result, never an execution', async () => {
  let sendRuns = 0;
  const model = stubModel([[textMsg('understood, skipping the send')]]);
  const agent = {
    model,
    tools: [{
      type: 'function', name: 'send_email', description: 'send', parameters: { type: 'object', properties: {} },
      invoke: async () => { sendRuns += 1; return 'sent'; },
      needsApproval: async () => true,
    }],
  };
  const state = new HostInterruptState(
    [{ type: 'message', role: 'user', content: 'email it' } as never],
    [{ callId: 'c1', name: 'send_email', rawItem: { name: 'send_email', arguments: '{}', callId: 'c1' } }],
  );
  state.reject(state.getInterruptions()[0]);
  const resumed = await hostRunRunner(throwingRunner() as never, agent as never, state as never, { maxTurns: 4 });
  assert.equal(sendRuns, 0);
  assert.equal(resumed.finalOutput, 'understood, skipping the send');
  const rejection = resumed.history.find((item) =>
    (item as { type?: string }).type === 'function_call_result'
    && JSON.stringify(item).includes('rejected'));
  assert.ok(rejection, 'the model sees the rejection as data');
});

test('maxTurns becomes one typed blocked checkpoint — never an ask or fake continue', async () => {
  const model = stubModel([
    [toolCall('loop-1', 'ping', {})],
    [toolCall('loop-2', 'ping', {})],
  ]);
  const agent = {
    model,
    tools: [{
      type: 'function', name: 'ping', description: 't', parameters: { type: 'object', properties: {} },
      invoke: async () => 'pong', needsApproval: async () => false,
    }],
  };
  const session = eventlog.createSession({ id: 'host-limit', kind: 'chat' });
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [] as never,
    { maxTurns: 2, context: { sessionId: session.id } },
  );
  assert.equal(outcome.terminal?.status, 'blocked');
  assert.equal(outcome.terminal?.reason, 'max_turns');
  assert.doesNotMatch(String(outcome.finalOutput), /say continue|retry/i);
  assert.equal(
    eventlog.listEvents(session.id, { types: ['awaiting_user_input'] }).length,
    0,
    'a limit is host data, never a user question',
  );
});

test('legacy SDK RunState blobs are not host states', () => {
  assert.equal(HostInterruptState.isHostState('{"$schemaVersion":"1.0","currentTurn":2}'), false);
  const roundTrip = new HostInterruptState([], []).toString();
  assert.equal(HostInterruptState.isHostState(roundTrip), true);
});

/* ── PHASE 1A — DURABLE-HISTORY BOUNDARY ────────────────────────────────────
 *
 * The response used to be appended to history — and its id adopted — BEFORE
 * anything decided the step was blocked. Because a blocked outcome returns
 * that same history, rejecting a response was the act that persisted it, and
 * the loop replayed filtered/truncated/cancelled/errored bytes into the next
 * model request. Rejected content became future context.
 *
 * These pins hold the commit boundary: nothing enters model-visible history
 * until the step is admitted.
 */

/** A stream stub that reports the provider's termination VERBATIM, rather than
 *  deriving it from output shape the way the shape-inference stub above does. */
function explicitStopModel(stops: Array<{ finishReason: string; output: unknown[] }>) {
  let call = 0;
  const seenInputs: unknown[][] = [];
  return {
    calls: () => call,
    seenInputs: () => seenInputs,
    async getResponse() { throw new Error('these pins drive the streamed path'); },
    async *getStreamedResponse(request: { input?: unknown }) {
      const frame = stops[Math.min(call, stops.length - 1)]!;
      seenInputs.push(Array.isArray(request?.input) ? request.input as unknown[] : []);
      call += 1;
      yield { type: 'response_started' } as never;
      yield { type: 'model', event: { type: 'finish', finishReason: frame.finishReason } } as never;
      yield {
        type: 'response_done',
        response: {
          id: `explicit-resp-${call}`,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: frame.output,
        },
      } as never;
    },
  };
}

const REJECTED_TEXT = 'PARTIAL-REJECTED-BYTES-DO-NOT-REPLAY';

test('explicit error with partial text blocks and its bytes never enter history', async () => {
  const model = explicitStopModel([{ finishReason: 'error', output: [textMsg(REJECTED_TEXT)] }]);
  const agent = { model, instructions: 'base system', tools: [] };
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'go' }] as never,
    { maxTurns: 4, context: { sessionId: 'host-admission-error' } },
  );

  assert.equal(outcome.terminal?.status, 'blocked', 'an explicit error is a blocked terminal');
  assert.equal(outcome.terminal?.reason, 'provider_unrecognized_stop');
  const serialized = JSON.stringify(outcome.history);
  assert.ok(!serialized.includes(REJECTED_TEXT), `rejected text leaked into history: ${serialized.slice(0, 200)}`);
  assert.equal(outcome.lastResponseId, undefined, 'a rejected response id is never adopted');
  assert.ok(
    !JSON.stringify(outcome.finalOutput).includes(REJECTED_TEXT),
    'and it is never presented to the user as an answer',
  );
});

test('explicit cancelled with a valid tool call executes nothing', async () => {
  let approvalChecks = 0;
  let toolBodies = 0;
  const model = explicitStopModel([
    { finishReason: 'cancelled', output: [toolCall('c-cancel', 'ping', { q: 'x' })] },
  ]);
  const agent = {
    model,
    instructions: 'base system',
    tools: [{
      type: 'function', name: 'ping', description: 'test', parameters: { type: 'object', properties: {} },
      invoke: async () => { toolBodies += 1; return 'pong'; },
      needsApproval: async () => { approvalChecks += 1; return false; },
    }],
  };
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'go' }] as never,
    { maxTurns: 4, context: { sessionId: 'host-admission-cancelled' } },
  );

  assert.equal(outcome.terminal?.status, 'blocked');
  assert.equal(approvalChecks, 0, 'the approval predicate is never consulted for a rejected step');
  assert.equal(toolBodies, 0, 'and no tool body runs');
  assert.ok(
    !JSON.stringify(outcome.history).includes('c-cancel'),
    'the rejected call never enters history either',
  );
});

test('a future stop spelling blocks rather than being inferred from shape', async () => {
  const model = explicitStopModel([
    { finishReason: 'provider_specific_future_state', output: [textMsg(REJECTED_TEXT)] },
  ]);
  const agent = { model, instructions: 'base system', tools: [] };
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'go' }] as never,
    { maxTurns: 4, context: { sessionId: 'host-admission-future' } },
  );
  assert.equal(outcome.terminal?.status, 'blocked');
  assert.equal(outcome.terminal?.reason, 'provider_unrecognized_stop');
  assert.ok(!JSON.stringify(outcome.history).includes(REJECTED_TEXT));
});

test('shape inference still admits a normal completion when metadata is absent', async () => {
  // Guards against over-correction: absent metadata must keep working exactly
  // as before, or this boundary would block every provider that says nothing.
  const model = stubModel([[textMsg('inferred fine')]]);
  const agent = { model, instructions: 'base system', tools: [] };
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'go' }] as never,
    { maxTurns: 4, context: { sessionId: 'host-admission-inferred' } },
  );
  assert.equal(outcome.terminal?.status, undefined, 'not blocked');
  assert.equal(outcome.finalOutput, 'inferred fine');
});

test('TWO TURNS through REAL session persistence: rejected bytes never replay', async () => {
  // Deliberately driven through `runTurn` and a real HarnessSession rather than
  // two hand-made hostRunRunner calls. The defect being pinned is that the
  // PERSISTED projection carried rejected content into the next request, so a
  // test that hand-passes `outcome.history` proves only that one return value
  // was clean — it never touches the seam that actually replays.
  const session = eventlog.createSession({ id: 'host-two-turn-persisted', kind: 'chat' });
  const model = explicitStopModel([
    { finishReason: 'error', output: [textMsg(REJECTED_TEXT)] },
    { finishReason: 'stop', output: [textMsg('recovered answer')] },
  ]);
  const agent = { model, instructions: 'base system', tools: [] };

  const first = await runTurn({
    sessionId: session.id,
    input: 'first ask',
    agent: agent as never,
    makeRunner: throwingRunner as never,
    runRunner: productionHostRunRunner,
    maxTurns: 3,
  });
  assert.notEqual(first.status, 'completed', 'a rejected model step does not complete the turn');

  const second = await runTurn({
    sessionId: session.id,
    input: 'second ask',
    agent: agent as never,
    makeRunner: throwingRunner as never,
    runRunner: productionHostRunRunner,
    maxTurns: 3,
  });

  // Without this the whole assertion is vacuous: an absent second request
  // "contains" no rejected bytes for the trivial reason that it never happened.
  assert.equal(model.seenInputs().length, 2, 'both turns actually reached the model');
  const secondRequest = JSON.stringify(model.seenInputs()[1]);
  assert.ok(
    !secondRequest.includes(REJECTED_TEXT),
    `the persisted projection replayed rejected bytes: ${secondRequest.slice(0, 240)}`,
  );
  assert.ok(!secondRequest.includes('explicit-resp-1'), 'nor the rejected response id');
  assert.equal(second.status, 'completed', 'and the next turn completes normally');
});

test('a rejected frame opens zero logical calls and zero physical crossings', async () => {
  const session = eventlog.createSession({ id: 'host-rejected-no-ledger', kind: 'chat' });
  const before = eventlog.listEvents(session.id, { types: ['tool_called', 'provider_dispatch_started'] }).length;
  let approvalChecks = 0;
  let toolBodies = 0;
  const model = explicitStopModel([
    { finishReason: 'cancelled', output: [toolCall('ledger-c1', 'ping', { q: 'x' })] },
  ]);
  await runTurn({
    sessionId: session.id,
    input: 'do the thing',
    agent: {
      model,
      tools: [{
        type: 'function', name: 'ping', description: 'test',
        parameters: { type: 'object', properties: {} },
        needsApproval: async () => { approvalChecks += 1; return false; },
        invoke: async () => { toolBodies += 1; return 'pong'; },
      }],
    } as never,
    makeRunner: throwingRunner as never,
    runRunner: productionHostRunRunner,
    maxTurns: 3,
  });
  assert.equal(approvalChecks, 0, 'no approval predicate ran');
  assert.equal(toolBodies, 0, 'no tool body ran');
  const after = eventlog.listEvents(session.id, { types: ['tool_called', 'provider_dispatch_started'] }).length;
  assert.equal(after, before, 'and no logical call or physical crossing was recorded');
});

test('a provider adapter mutating request input leaves durable history byte-identical', async () => {
  // The unfiltered path used to hand the model the canonical array itself.
  const mutating = {
    calls: () => 1,
    async getResponse() { throw new Error('streamed path only'); },
    async *getStreamedResponse(request: { input?: unknown }) {
      if (Array.isArray(request.input)) {
        (request.input as unknown[]).push({ type: 'message', role: 'user', content: 'ADAPTER-INJECTED' });
        (request.input as unknown[]).length = 0;
      }
      yield { type: 'response_started' } as never;
      yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } } as never;
      yield {
        type: 'response_done',
        response: { id: 'mutate-1', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output: [textMsg('fine')] },
      } as never;
    },
  };
  const canonical = [{ type: 'message', role: 'user', content: 'original ask' }];
  const snapshot = JSON.stringify(canonical);
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    { model: mutating, instructions: 'base system', tools: [] } as never,
    canonical as never,
    { maxTurns: 3, context: { sessionId: 'host-adapter-mutation' } },
  );
  assert.equal(JSON.stringify(canonical), snapshot, 'the caller-owned array is untouched');
  assert.ok(
    !JSON.stringify(outcome.history).includes('ADAPTER-INJECTED'),
    'and nothing the adapter injected reached durable history',
  );
  assert.equal(outcome.finalOutput, 'fine');
});

test('the accepted response id survives approval serialization and resume', async () => {
  const state = new HostInterruptState(
    [{ type: 'message', role: 'user', content: 'go' }] as never,
    [{ callId: 'p1', name: 'ping', rawItem: { name: 'ping', arguments: '{}', callId: 'p1' } }] as never,
    'accepted-resp-7',
    'host_v1',
  );
  const decoded = HostInterruptState.fromString(state.toString());
  assert.equal(decoded.lastResponseId, 'accepted-resp-7', 'the accepted identity round-trips');
  assert.equal(decoded.turnEngine, 'host_v1', 'V2 preserves the exact host owner');

  // A V1 blob predates production host ownership and must still decode into
  // the exact legacy host mode instead of following a changed runtime flag.
  const v1 = JSON.stringify({
    __clemHostInterrupt: 1,
    history: [{ type: 'message', role: 'user', content: 'go' }],
    pending: [],
  });
  const legacy = HostInterruptState.fromString(v1);
  assert.equal(legacy.lastResponseId, undefined, 'absent decodes to undefined, it does not throw');
  assert.equal(legacy.turnEngine, 'host_v1_read_only');
  assert.equal(legacy.history.length, 1, 'and the rest of the V1 state is intact');
});

test('historical V1/V2 approved mutations cannot acquire V3 consent authority or execute', async () => {
  for (const version of [1, 2] as const) {
    const session = eventlog.createSession({
      id: `host-historical-consent-v${version}`,
      kind: 'chat',
    });
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Write the exact historical fixture.' },
    });
    const callId = `historical-write-v${version}`;
    const args = { path: `/tmp/historical-v${version}.txt`, content: 'must-not-run' };
    const lookalikeSubject = {
      version: 1,
      sessionId: session.id,
      sourceUserSeq: source.seq,
      acceptedTaskId: `task:${session.id}#${source.seq}`,
      logicalToolCallId: callId,
      decisionSubjectDigest: 'a'.repeat(64),
      callDigest: 'b'.repeat(64),
      coverageDigest: 'c'.repeat(64),
      riskDigest: 'd'.repeat(64),
    };
    const decoded = HostInterruptState.fromString(JSON.stringify({
      __clemHostInterrupt: version,
      history: [],
      pending: [{
        callId,
        name: 'write_file',
        rawItem: { name: 'write_file', arguments: JSON.stringify(args), callId },
        decision: 'approved',
        consentSubject: lookalikeSubject,
      }],
      ...(version === 2 ? { turnEngine: 'host_v1' } : {}),
    }));
    assert.equal(decoded.pending[0]?.consentSubject, undefined, 'legacy bytes cannot smuggle a V3 subject');

    let bodies = 0;
    const outcome = await brackets.withHarnessRunContext({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 2,
      counter: new brackets.ToolCallsCounter(4),
      behaviorScopeId: `${session.id}::historical:v${version}`,
    }, () => hostRunRunner(
      throwingRunner() as never,
      {
        model: stubModel([[textMsg(`historical v${version} mutation was not executed`)]]),
        tools: [{
          type: 'function',
          name: 'write_file',
          description: 'recording-only historical mutation',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'content'],
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
          },
          needsApproval: async () => true,
          invoke: async () => {
            bodies += 1;
            return 'must-not-run';
          },
        }],
      } as never,
      decoded as never,
      {
        maxTurns: 3,
        context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 2 },
      },
    ));
    assert.equal(bodies, 0, `historical V${version} approval cannot execute a mutation`);
    assert.doesNotMatch(JSON.stringify(outcome.history), /must-not-run/);
    assert.equal(outcome.hasInterruptions ?? false, false, 'legacy approval is not replayed as a fresh public grant');
  }
});

test('a blocked turn retains the PRIOR accepted response id rather than losing it', async () => {
  // Resume carrying an already-accepted identity, then have the model fail.
  const model = explicitStopModel([{ finishReason: 'error', output: [textMsg(REJECTED_TEXT)] }]);
  const resumed = new HostInterruptState(
    [{ type: 'message', role: 'user', content: 'go' }] as never,
    [] as never,
    'accepted-before-block',
  );
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    { model, instructions: 'base system', tools: [] } as never,
    resumed as never,
    { maxTurns: 3, context: { sessionId: 'host-blocked-keeps-id' } },
  );
  assert.equal(outcome.terminal?.status, 'blocked');
  assert.equal(outcome.lastResponseId, 'accepted-before-block',
    'a rejected response may not replace the last accepted identity');
});

test('host consumes only the admitted canonical call projection', async () => {
  const exactArguments = '{"q":"literal"}';
  let invokedWith = '';
  const model = stubModel([
    [{
      type: 'function_call',
      callId: '  canonical-call  ',
      name: '  ping  ',
      arguments: exactArguments,
    }],
    [textMsg('canonical done')],
  ]);
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    {
      model,
      instructions: 'base system',
      tools: [{
        type: 'function', name: 'ping', description: 'test',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        invoke: async (_context: unknown, input: string) => {
          invokedWith = input;
          return 'pong';
        },
      }],
    } as never,
    [{ type: 'message', role: 'user', content: 'go' }] as never,
    { maxTurns: 3, context: { sessionId: 'host-canonical-call' } },
  );
  assert.equal(outcome.finalOutput, 'canonical done');
  assert.equal(invokedWith, exactArguments, 'execution received the canonical admitted argument bytes');
  const stored = outcome.history.find((item) => (item as { type?: string }).type === 'function_call') as {
    callId: string; name: string; arguments: string;
  };
  assert.equal(stored.callId, 'canonical-call');
  assert.equal(stored.name, 'ping');
  assert.equal(stored.arguments, invokedWith, 'history and execution came from the same canonical frame');
});

test('hostPreviousResponseId seeds fresh-run identity and a rejection cannot replace it', async () => {
  const model = explicitStopModel([{ finishReason: 'error', output: [textMsg(REJECTED_TEXT)] }]);
  const outcome = await hostRunRunner(
    throwingRunner() as never,
    { model, instructions: 'base system', tools: [] } as never,
    [{ type: 'message', role: 'user', content: 'go' }] as never,
    {
      maxTurns: 3,
      hostPreviousResponseId: 'accepted-before-fresh-step',
      context: { sessionId: 'host-fresh-seeded-id' },
    },
  );
  assert.equal(outcome.terminal?.status, 'blocked');
  assert.equal(outcome.lastResponseId, 'accepted-before-fresh-step');
});

test('production host carries generic user-question and worker envelopes through one durable call kernel', async (t) => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  try {
    await t.test('ask_user_question posts its typed envelope and halts without a second model step', async () => {
      const fixture = acceptHostCanarySource('production-typed-question');
      const questionTool = brackets.wrapToolForHarness(buildAskUserQuestionTool() as never);
      const model = stubModel([[
        toolCall('question-call', 'ask_user_question', {
          question: 'Which practice area should I start with?',
          options: ['Personal injury', 'Family law'],
          purpose: 'clarification',
        }),
      ]]);
      const agent = {
        model,
        tools: [questionTool],
        toolUseBehavior: userChoiceToolUseBehavior,
      };
      bindHostCanarySurface(fixture, agent, [questionTool]);
      const outcome = await runProductionHost(fixture, agent);
      assert.equal(model.calls(), 1, 'a typed question is a host control receipt, not another model loop');
      assert.match(
        String(outcome.finalOutput),
        /^\[clementine:awaiting-user-input:final\]\nWhich practice area should I start with\?/,
      );
      const questions = eventlog.listEvents(fixture.session.id, { types: ['awaiting_user_input'] });
      assert.equal(questions.length, 1);
      assert.deepEqual({
        question: questions[0]?.data.question,
        options: questions[0]?.data.options,
        purpose: questions[0]?.data.purpose,
        sourceUserSeq: questions[0]?.data.sourceUserSeq,
      }, {
        question: 'Which practice area should I start with?',
        options: ['Personal injury', 'Family law'],
        purpose: 'clarification',
        sourceUserSeq: fixture.source.seq,
      });
      const db = eventlog.openEventLog();
      assert.deepEqual(db.prepare(`
        SELECT logical_tool_call_id, tool_name, state
          FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ?
      `).all(fixture.session.id, fixture.source.seq), [{
        logical_tool_call_id: 'question-call',
        tool_name: 'ask_user_question',
        state: 'settled',
      }]);
      assert.deepEqual(db.prepare(`
        SELECT physical_crossing_count, host_crossing_count FROM logical_call_settlements
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(fixture.session.id, fixture.source.seq, 'question-call'), {
        physical_crossing_count: 0,
        host_crossing_count: 1,
      });
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS n FROM run_dispatch_leases
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
           AND revoked_at IS NOT NULL
      `).get(fixture.session.id, fixture.source.seq, 'question-call') as { n: number }).n, 1,
      'the graphless control still owns one exact v53 child generation');
    });

    await t.test('an unplanned run_worker call is paired back for repair without crossing either ledger', async () => {
      const fixture = acceptHostCanarySource('production-typed-worker');
      let bodies = 0;
      const exactWorkerResult = {
        kind: 'clementine.worker.result',
        version: 1,
        workerId: 'worker-fixture-1',
        status: 'completed',
        output: { records: [{ market: 'Seattle', count: 12 }] },
      };
      const worker = brackets.wrapToolForHarness({
        type: 'function',
        name: 'run_worker',
        description: 'Run one stateless worker job packet.',
        parameters: {
          type: 'object',
          properties: {
            item: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['item', 'prompt'],
        },
        needsApproval: async () => false,
        invoke: async (_context: unknown, input: string) => {
          bodies += 1;
          assert.equal(input, '{"item":"Seattle","prompt":"Find attorneys and return normalized records."}');
          return exactWorkerResult;
        },
      });
      const seenInputs: unknown[][] = [];
      let modelCall = 0;
      const model = {
        calls: () => modelCall,
        async getResponse(request: { input?: unknown }) {
          seenInputs.push(structuredClone(Array.isArray(request.input) ? request.input : []));
          modelCall += 1;
          return {
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
            output: modelCall === 1
              ? [toolCall('worker-call', 'run_worker', {
                  item: 'Seattle',
                  prompt: 'Find attorneys and return normalized records.',
                })]
              : [textMsg('worker result aggregated')],
            responseId: `worker-response-${modelCall}`,
          };
        },
        getStreamedResponse: testModelStream,
      };
      const agent = { model, tools: [worker] };
      bindHostCanarySurface(fixture, agent, [worker]);

      const outcome = await runProductionHost(fixture, agent);
      assert.equal(Boolean(outcome.hasInterruptions), false);
      assert.equal(outcome.terminal, undefined);
      assert.equal(outcome.finalOutput, 'worker result aggregated');
      assert.equal(bodies, 0, 'repair precedes the wrapper or worker body');
      assert.equal(model.calls(), 2, 'run_worker is a tool capability, not a nested host/model loop');
      const providerProjection = seenInputs[1] as Array<Record<string, unknown>>;
      const result = providerProjection.find((entry) => entry.type === 'function_call_result');
      assert.equal(result?.callId, 'worker-call');
      assert.match(JSON.stringify(result), /replan/);
      const db = eventlog.openEventLog();
      for (const table of ['logical_tool_calls', 'physical_dispatches']) {
        assert.equal((db.prepare(`
          SELECT COUNT(*) AS n FROM ${table}
           WHERE session_id = ? AND source_user_seq = ?
        `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0, table);
      }
      const root = callAuthorities.acceptedTurnCallAuthorityFor(
        fixture.session.id,
        fixture.source.seq,
      );
      assert.equal(root.status, 'ok');
      if (root.status === 'ok') assert.equal(root.authority.authorityKind, 'host_v1');
    });
  } finally {
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('production host external reads require one exact frozen manifest/account/schema/invoke-port binding', async (t) => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const priorPorts = productionPorts.listProductionCapabilityPorts();
  process.env.HARNESS_TOOL_BRACKETS = 'on';

  const runVariant = async (input: {
    label: string;
    accountMatches: boolean;
    schemaMatches: boolean;
    registerCatalog?: boolean;
    registerPort: boolean;
    shouldExecute: boolean;
    providerKind?: 'native_mcp' | 'composio';
    withPreparation?: boolean;
    completeCarrier?: boolean;
  }) => {
    const fixture = acceptHostCanarySource(`production-external-${input.label}`);
    const providerKind = input.providerKind ?? 'native_mcp';
    const operationId = providerKind === 'composio'
      ? 'GOOGLESHEETS_VALUES_GET'
      : `market_${input.label}__lookup_attorneys`;
    const manifest = capabilityManifests.attachSemanticContract({
      version: 1,
      manifestId: `cap:${input.label}:attorney-lookup`,
      providerKind,
      operationId,
      providerIdentity: providerKind === 'composio'
        ? 'composio'
        : `configured-market-directory:${input.label}`,
      providerVersion: '2026-08-22',
      operationVersion: '1',
      definitionFingerprint: 'a'.repeat(64),
      ...(providerKind === 'composio'
        ? {
            externalDefinition: {
              version: 1 as const,
              providerInputSchemaDigest: 'c'.repeat(64),
              providerOutputSchemaObserved: true,
              providerOutputSchemaDigest: 'd'.repeat(64),
              semanticName: operationId,
              behaviorHints: {
                readOnly: true,
                destructive: false,
                idempotent: true,
                openWorld: false,
              },
            },
          }
        : {}),
      effect: 'read',
      accountId: providerKind === 'composio'
        ? 'ca_direct_composio_preparation'
        : `account:${input.label}:primary`,
      idempotency: { required: false, policy: 'none' },
      reconciliation: { supported: false, policy: 'none' },
      outputContract: { kind: 'attorney_records' },
      evidenceContract: { kinds: ['receipt'], readbackRequired: false },
      provenance: {
        issuer: 'host-turn-runner:test',
        issuedAt: '2026-08-22T00:00:00.000Z',
        trusted: true,
      },
      lifecycle: { state: 'current' },
      advisoryRoles: ['lookup'],
    });
    let portBodies = 0;
    let outerBodies = 0;
    const portInvoke = async (request: {
      payload?: unknown;
      binding?: { account?: unknown; manifestDigest?: unknown; toolName?: unknown };
    }) => {
      portBodies += 1;
      assert.deepEqual(request.payload, { city: 'Seattle', practiceArea: 'personal injury' });
      assert.equal(request.binding?.account, manifest.accountId);
      assert.equal(request.binding?.manifestDigest,
        capabilityManifests.capabilityManifestDigest(manifest));
      assert.equal(request.binding?.toolName, operationId);
      return {
        kind: 'clementine.external-read.result',
        version: 1,
        records: [{ name: 'Fixture Attorney', city: 'Seattle' }],
      };
    };
    const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
    if (input.registerCatalog !== false) {
      factory.register({
        capabilityId: manifest.manifestId,
        toolName: manifest.operationId,
        schemaVersion: manifest.operationVersion,
        schemaDigest: input.schemaMatches ? manifest.definitionFingerprint : 'b'.repeat(64),
        effect: manifest.effect,
        account: input.accountMatches ? manifest.accountId : `account:${input.label}:foreign`,
        manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
        providerKind: manifest.providerKind,
        ...(manifest.externalDefinition
          ? { providerInputSchemaDigest: manifest.externalDefinition.providerInputSchemaDigest }
          : {}),
        liveFingerprint: manifest.definitionFingerprint,
        manifest,
        invoke: portInvoke as never,
      });
    }
    capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
    productionPorts.clearProductionCapabilityPorts();
    const preparationOrder: string[] = [];
    const preparationProofs = new WeakSet<object>();
    if (input.registerPort) {
      assert.deepEqual(productionPorts.registerFixtureCapabilityPort(
        productionPorts.productionPortIdentityFromManifest(manifest),
        {
          ...(input.withPreparation
            ? {
                admitPreparation() {
                  preparationOrder.push('admit');
                },
                async prepareInvocation() {
                  preparationOrder.push('prepare');
                  const proof = Object.freeze({});
                  preparationProofs.add(proof);
                  return proof;
                },
                async invokeWithPreparation(proof: unknown, work: () => Promise<unknown>) {
                  preparationOrder.push('consume');
                  assert.ok(
                    proof && typeof proof === 'object' && preparationProofs.has(proof as object),
                    'direct host dispatch consumes the exact one-shot preparation proof',
                  );
                  preparationProofs.delete(proof as object);
                  return work();
                },
              }
            : {}),
          invoke: async (request: Parameters<typeof portInvoke>[0]) => {
            preparationOrder.push('business');
            return portInvoke(request);
          },
        } as never,
      ), { ok: true });
    }
    const carrier = brackets.wrapToolForHarness({
      type: 'function',
      name: 'call_tool',
      description: 'Invoke one exact schema acquired from the frozen capability catalog.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          args_json: { type: 'string' },
        },
        required: ['name', 'args_json'],
      },
      needsApproval: async () => false,
      invoke: async () => {
        outerBodies += 1;
        throw new Error('the generic carrier body must not replace the exact production port');
      },
    });
    if (input.completeCarrier) {
      capabilityResolution.recordAdmissionCapabilityResolution({
        sessionId: fixture.session.id,
        sourceUserSeq: fixture.source.seq,
        acceptedInput: String(fixture.source.data.text),
        entries: [{
          intent: 'Read the accepted records', kind: 'composio', identifier: operationId,
          status: 'proven', connection: 'active', effectClass: 'read',
        }],
      });
    }
    const scriptedModel = stubModel([
      [toolCall(`${input.label}-external-call`, 'call_tool', {
        name: input.completeCarrier ? 'composio_execute_tool' : operationId,
        args_json: JSON.stringify({ city: 'Seattle', practiceArea: 'personal injury' }),
      })],
      ...(input.completeCarrier ? [[textMsg('CONTINUE: report the settled read now')]] : []),
      [textMsg(`${input.label} external read settled`)],
    ]);
    const requests: string[] = [];
    const model = {
      ...scriptedModel,
      async getResponse(request: unknown) {
        requests.push(JSON.stringify(request));
        return scriptedModel.getResponse();
      },
    };
    const agent = { model, tools: [carrier] };
    bindHostCanarySurface(fixture, agent, [carrier]);
    const outcome = await runProductionHost(fixture, agent);
    assert.equal(outcome.finalOutput, `${input.label} external read settled`, JSON.stringify({
      terminal: outcome.terminal,
      portBodies,
      outerBodies,
      logical: eventlog.openEventLog().prepare(`
        SELECT * FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ?
      `).all(fixture.session.id, fixture.source.seq),
      physical: eventlog.openEventLog().prepare(`
        SELECT * FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ?
      `).all(fixture.session.id, fixture.source.seq),
    }));
    assert.equal(outerBodies, 0);
    assert.equal(portBodies, input.shouldExecute ? 1 : 0);
    if (input.completeCarrier) {
      const repair = eventlog.listEvents(fixture.session.id, { types: ['guardrail_tripped'] })
        .filter((event) => event.data.kind === 'carrier_repaired');
      assert.equal(repair.length, 1);
      assert.equal(repair[0]?.data.callId, `${input.label}-external-call`);
      assert.equal(repair[0]?.data.operation, operationId);
      assert.deepEqual(repair[0]?.data.changes, ['carrier_arguments_completed']);
      assert.ok(requests[1]?.includes(`Host repair for call ${input.label}-external-call:`),
        'the next model request receives the bounded per-call correction');
      assert.ok(requests[1]?.includes('Use the corrected carrier shape on subsequent calls.'));
      assert.equal(requests[2]?.includes(`Host repair for call ${input.label}-external-call:`), false,
        'the correction is consumed once and does not leak into later model steps');
      const authority = noProgressProjection.projectHostNoProgressAuthority({
        sessionId: fixture.session.id, sourceUserSeq: fixture.source.seq,
      });
      assert.equal(authority.status, 'ok');
      if (authority.status === 'ok') {
        const repairToken = sha256(JSON.stringify({
          version: 1,
          kind: 'evidence',
          owner: 'host_carrier_repair',
          parts: ['call_tool', operationId, ['carrier_arguments_completed']],
        }));
        assert.ok(authority.authority.evidence.includes(repairToken),
          'the deterministic repair becomes a durable progress token');
      }
      assert.equal(model.calls(), 3, 'the repair adds no turn beyond the scripted call, continuation and answer');
    }
    if (input.withPreparation && input.shouldExecute) {
      assert.deepEqual(
        preparationOrder,
        ['admit', 'prepare', 'consume', 'business'],
        'direct host-owned Composio dispatch prepares exactly once before business',
      );
    }
    const db = eventlog.openEventLog();
    const logicalCount = (db.prepare(`
      SELECT COUNT(*) AS n FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
    `).get(fixture.session.id, fixture.source.seq) as { n: number }).n;
    assert.equal(logicalCount, input.shouldExecute ? 1 : 0);
    if (input.shouldExecute) {
      assert.deepEqual(db.prepare(`
        SELECT execution_site, state FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ?
      `).get(fixture.session.id, fixture.source.seq), {
        execution_site: null,
        state: 'returned',
      });
      assert.deepEqual(db.prepare(`
        SELECT physical_crossing_count, host_crossing_count
          FROM logical_call_settlements
         WHERE session_id = ? AND source_user_seq = ?
      `).get(fixture.session.id, fixture.source.seq), {
        physical_crossing_count: 1,
        host_crossing_count: 0,
      });
    } else {
      assert.match(JSON.stringify(outcome.history),
        /exact capability, effect, account, schema, or invoke binding is absent or changed/);
      assert.match(JSON.stringify(outcome.history), /Failed check:/);
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS n FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ?
      `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0);
    }
  };

  try {
    await t.test('exact arbitrary connected read', () => runVariant({
      label: 'exact',
      accountMatches: true,
      schemaMatches: true,
      registerPort: true,
      shouldExecute: true,
    }));
    await t.test('direct Composio call_tool prepares its exact port once', () => runVariant({
      label: 'direct-composio-preparation',
      accountMatches: true,
      schemaMatches: true,
      registerPort: true,
      shouldExecute: true,
      providerKind: 'composio',
      withPreparation: true,
    }));
    await t.test('a deterministic carrier repair dispatches once, records progress and teaches the next frame', () => runVariant({
      label: 'completed-carrier',
      accountMatches: true,
      schemaMatches: true,
      registerPort: true,
      shouldExecute: true,
      providerKind: 'composio',
      completeCarrier: true,
      withPreparation: true,
    }));
    await t.test('foreign account', () => runVariant({
      label: 'account',
      accountMatches: false,
      schemaMatches: true,
      registerPort: true,
      shouldExecute: false,
    }));
    await t.test('missing catalog binding cannot fall through to the configured wrapper', () => runVariant({
      label: 'catalog',
      accountMatches: true,
      schemaMatches: true,
      registerCatalog: false,
      registerPort: true,
      shouldExecute: false,
    }));
    await t.test('schema drift', () => runVariant({
      label: 'schema',
      accountMatches: true,
      schemaMatches: false,
      registerPort: true,
      shouldExecute: false,
    }));
    await t.test('missing invoke port', () => runVariant({
      label: 'port',
      accountMatches: true,
      schemaMatches: true,
      registerPort: false,
      shouldExecute: false,
    }));
  } finally {
    productionPorts.clearProductionCapabilityPorts();
    for (const prior of priorPorts) {
      productionPorts.registerFixtureCapabilityPort(prior.identity, prior.port);
    }
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('accepted native MCP call_tool uses one exact preparation row and one business row without the legacy shim', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const priorManifestStore = capabilityManifestStores.peekCapabilityManifestStore();
  const priorPorts = productionPorts.listProductionCapabilityPorts();
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const suffix = ++acceptedSerial;
  const serverName = `exact_host_${suffix}`;
  const operationId = `${serverName}__lookup_records`;
  const inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: { city: { type: 'string' } },
    required: ['city'],
  };
  const counts = { list: 0, call: 0, invalidate: 0 };
  let configuredCommand = '/fixture/exact-host-mcp';
  const fakeServer = {
    async invalidateToolsCache() { counts.invalidate += 1; },
    async listTools() {
      counts.list += 1;
      return [{
        name: operationId,
        description: 'Return exact records for one city.',
        inputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false },
      }];
    },
    async callTool(name: string, args: Record<string, unknown> | null) {
      counts.call += 1;
      assert.equal(name, operationId);
      assert.deepEqual(args, { city: 'Seattle' });
      return [{ type: 'text', text: JSON.stringify({ records: [{ city: 'Seattle' }] }) }];
    },
  };
  const runtime: productionMcp.ProductionMcpRuntime = {
    configuredServers: () => [{
      name: serverName,
      type: 'stdio',
      command: configuredCommand,
      args: ['--stdio'],
      enabled: true,
      source: 'user',
    }] as never,
    serverForEnumeration: () => fakeServer as never,
    serverForOperation: () => fakeServer as never,
  };

  try {
    capabilityCatalogs.installHostCapabilityCatalogFactory(
      capabilityCatalogs.createHostCapabilityCatalogFactory(),
    );
    capabilityManifestStores.installCapabilityManifestStore(
      capabilityManifestStores.createCapabilityManifestStore([], { durable: true }),
    );
    productionPorts.clearProductionCapabilityPorts();
    innerDispatch._setInnerDispatchMcpResolverForTests(null);
    assert.equal(innerDispatch._innerDispatchLegacyMcpTestResolverActive(), false);

    const materialized = await productionMcp.createProductionMcpReadCarrier({
      serverName,
      runtime,
    }).materializeExact({ operationId, inputSchema });
    assert.equal(materialized.status, 'installed', JSON.stringify(materialized));
    if (materialized.status !== 'installed') return;
    const providerCrossingsBeforeCall = counts.list + counts.call;
    const exactScope = {
      reason: 'exact accepted host MCP fixture',
      authority: 'exact' as const,
      allowedServerSlugs: [serverName],
      allowedToolNames: [operationId],
    };
    const callTool = brackets.wrapToolForHarness(callToolTools.buildCallTool({
      reachableBuiltinNames: new Set<string>(),
      firstClassNames: new Set<string>(),
      mcpToolScope: exactScope,
    }) as never);
    const fixture = acceptHostCanarySource(`exact-native-mcp-${suffix}`);
    const model = stubModel([
      [toolCall(`exact-native-mcp-call-${suffix}`, 'call_tool', {
        name: operationId,
        args_json: JSON.stringify({ city: 'Seattle' }),
      })],
      [textMsg('exact native MCP settled')],
    ]);
    const agent = { model, tools: [callTool] };
    mcpToolAuthority.bindAgentMcpToolScope(agent as never, exactScope);
    bindHostCanarySurface(fixture, agent, [callTool]);

    const outcome = await runProductionHost(fixture, agent);
    assert.equal(outcome.finalOutput, 'exact native MCP settled', JSON.stringify(outcome.terminal));
    assert.equal(counts.call, 1, 'one and only one callTool business body');
    const rows = eventlog.openEventLog().prepare(`
      SELECT ordinal, relation, state
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY ordinal
    `).all(fixture.session.id, fixture.source.seq);
    assert.deepEqual(rows, [
      { ordinal: 1, relation: 'probe', state: 'returned' },
      { ordinal: 2, relation: 'child', state: 'returned' },
    ]);
    assert.equal(
      counts.list + counts.call - providerCrossingsBeforeCall,
      rows.length,
      'one live list plus one callTool equals the two physical starts',
    );
    assert.deepEqual(eventlog.openEventLog().prepare(`
      SELECT physical_crossing_count, host_crossing_count
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ?
    `).get(fixture.session.id, fixture.source.seq), {
      physical_crossing_count: 2,
      host_crossing_count: 0,
    });
    assert.equal(innerDispatch._innerDispatchLegacyMcpTestResolverActive(), false);

    const crossingsBeforeConfigDrift = counts.list + counts.call;
    configuredCommand = '/fixture/wrong-exact-host-mcp';
    const driftFixture = acceptHostCanarySource(`exact-native-mcp-config-drift-${suffix}`);
    const driftAgent = {
      model: stubModel([
        [toolCall(`exact-native-mcp-drift-call-${suffix}`, 'call_tool', {
          name: operationId,
          args_json: JSON.stringify({ city: 'Seattle' }),
        })],
        [textMsg('config drift refused')],
      ]),
      tools: [callTool],
    };
    mcpToolAuthority.bindAgentMcpToolScope(driftAgent as never, exactScope);
    bindHostCanarySurface(driftFixture, driftAgent, [callTool]);
    const driftOutcome = await runProductionHost(driftFixture, driftAgent);
    assert.equal(driftOutcome.finalOutput, 'config drift refused');
    assert.equal(counts.list + counts.call, crossingsBeforeConfigDrift,
      'wrong config/account fails before listTools and callTool');
    assert.equal((eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(driftFixture.session.id, driftFixture.source.seq) as { n: number }).n, 0);

    const guessedFixture = acceptHostCanarySource(`exact-native-mcp-guessed-${suffix}`);
    const guessedAgent = {
      model: stubModel([
        [toolCall(`exact-native-mcp-guessed-call-${suffix}`, 'call_tool', {
          name: `${serverName}__guessed_lookup`,
          args_json: JSON.stringify({ city: 'Seattle' }),
        })],
        [textMsg('guessed name refused')],
      ]),
      tools: [callTool],
    };
    mcpToolAuthority.bindAgentMcpToolScope(guessedAgent as never, exactScope);
    bindHostCanarySurface(guessedFixture, guessedAgent, [callTool]);
    const guessedOutcome = await runProductionHost(guessedFixture, guessedAgent);
    assert.equal(guessedOutcome.finalOutput, 'guessed name refused');
    assert.equal(counts.list + counts.call, crossingsBeforeConfigDrift,
      'a guessed or sibling/cross-server name never reaches metadata or body');
    assert.equal((eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(guessedFixture.session.id, guessedFixture.source.seq) as { n: number }).n, 0);
  } finally {
    productionPorts.clearProductionCapabilityPorts();
    for (const prior of priorPorts) {
      productionPorts.registerFixtureCapabilityPort(prior.identity, prior.port);
    }
    capabilityManifestStores.installCapabilityManifestStore(priorManifestStore);
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('production host consumes exact material-source A/Q/B authority before any logical or physical crossing', async (t) => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const priorPorts = productionPorts.listProductionCapabilityPorts();
  process.env.HARNESS_TOOL_BRACKETS = 'on';

  const runVariant = async (input: {
    label: string;
    purpose: string;
    args?: Record<string, unknown>;
    effect?: 'read' | 'external_write';
    providerKind?: 'native_mcp' | 'composio';
    bindingMatches?: boolean;
    bindingAccount?: 'exact' | 'missing' | 'wrong';
    bindingSchema?: 'exact' | 'missing';
    consumingDecision?: 'exact' | 'missing' | 'duplicate' | 'reforged' | 'mutated' | 'wrong_role' | 'mixed_role' | 'variant';
    omitParentDecision?: boolean;
    parentDecision?: 'exact' | 'wrong_turn' | 'mixed_turn';
    noContinuation?: boolean;
    forgedDecisionWithoutLineage?: boolean;
    omitSourceSchemaFingerprint?: boolean;
    fresh?: 'explicit' | 'pending';
    expectRepair?: boolean;
    shouldExecute: boolean;
  }) => {
    const operationStem = input.label.replace(/[^a-z0-9]+/gi, '_');
    const operationId = input.effect === 'external_write'
      ? `records_${operationStem}__create_profile`
      : `records_${operationStem}__lookup_records`;
    const providerKind = input.providerKind ?? 'native_mcp';
    const selectorKind = providerKind === 'native_mcp' ? 'mcp' : 'composio';
    const capabilityId = `capability:${selectorKind}:${operationId}`;
    const accountId = `account:${input.label}:primary`;
    const sourceSchemaFingerprint = 'd'.repeat(32);
    const definitionFingerprint = 'f'.repeat(64);
    const boundCapabilityId = input.bindingMatches === false
      ? `capability:${selectorKind}:records_${operationStem}__lookup_records_other`
      : capabilityId;
    const binding = turnControl.validatedTurnSourceStrategyBinding({
      version: 1,
      primary: {
        capabilityId: boundCapabilityId,
        ...(input.bindingAccount !== 'missing'
          ? {
              accountIdentity: input.bindingAccount === 'wrong'
                ? `account:${input.label}:foreign`
                : accountId,
            }
          : {}),
        ...(input.bindingSchema !== 'missing'
          ? { schemaFingerprint: sourceSchemaFingerprint }
          : {}),
      },
      equivalentFallbacks: [],
      topology: 'single_aggregate_read_then_single_artifact_write',
      topologyDigest: 'e'.repeat(64),
      destination: { family: 'artifact', posture: 'create_new' },
      effect: 'external_write',
    });
    assert.ok(binding);
    const reforgedBinding = turnControl.validatedTurnSourceStrategyBinding({
      ...binding!,
      primary: {
        capabilityId,
        accountIdentity: accountId,
        schemaFingerprint: sourceSchemaFingerprint,
      },
    });
    assert.ok(reforgedBinding);
    const fixture = input.fresh
      ? acceptFreshMaterialSource({
          label: input.label,
          binding: binding!,
          explicit: input.fresh === 'explicit',
        })
      : input.noContinuation
        ? acceptHostCanarySource(`material-${input.label}-no-lineage`)
        : await acceptMaterialSourceContinuation({
          label: input.label,
          binding: binding!,
          consumingDecision: input.consumingDecision ?? 'exact',
          reforgedBinding: reforgedBinding!,
          omitParentDecision: input.omitParentDecision,
          parentDecision: input.parentDecision,
        });
    if (input.forgedDecisionWithoutLineage) {
      turnControl.recordTurnPreflightDecision(fixture.session.id, {
        phase: 'execute',
        consequential: true,
        confirmedIntentKey: `forged-${input.label}`,
        sourceStrategyPosture: 'confirmed_exact',
        sourceStrategyBinding: binding!,
        reason: 'continuation_approved',
      }, fixture.source.seq);
    }
    const manifest = capabilityManifests.attachSemanticContract({
      version: 1,
      // The production catalog treats a callable capability id and its
      // immutable manifest id as one exact identity.  This fixture used to
      // register two different ids and accidentally relied on the operation
      // name alone to bridge them; the current callable-manifest predicate
      // correctly refuses that stale shape.
      manifestId: capabilityId,
      providerKind,
      operationId,
      providerIdentity: `configured-records:${input.label}`,
      providerVersion: '2026-08-22',
      operationVersion: '1',
      definitionFingerprint,
      effect: input.effect ?? 'read',
      purpose: input.purpose,
      accountId,
      idempotency: input.effect === 'external_write'
        ? { required: true, policy: 'key_before_dispatch' }
        : { required: false, policy: 'none' },
      reconciliation: input.effect === 'external_write'
        ? { supported: true, policy: 'exact_artifact' }
        : { supported: false, policy: 'none' },
      outputContract: { kind: 'records' },
      evidenceContract: { kinds: ['receipt'], readbackRequired: input.effect === 'external_write' },
      provenance: {
        issuer: 'host-turn-runner:material-source-test',
        issuedAt: '2026-08-22T00:00:00.000Z',
        trusted: true,
      },
      lifecycle: { state: 'current' },
    });
    if (providerKind === 'composio') {
      shippedImplementations.loadShippedImplementations().registerIsolatedObservation({
        operationId: manifest.operationId,
        accountId: manifest.accountId,
        definitionFingerprint: manifest.definitionFingerprint,
        providerVersion: manifest.providerVersion,
        operationVersion: manifest.operationVersion,
        observedAt: Date.now(),
      });
    }
    let portBodies = 0;
    let outerBodies = 0;
    const portInvoke = async () => {
      portBodies += 1;
      return { kind: 'clementine.material-source.result', version: 1, records: [] };
    };
    const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
    factory.register({
      capabilityId,
      toolName: operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect,
      account: manifest.accountId,
      manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint,
      ...(!input.omitSourceSchemaFingerprint
        ? { sourceSchemaFingerprint }
        : {}),
      manifest,
      invoke: portInvoke as never,
    });
    capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
    productionPorts.clearProductionCapabilityPorts();
    assert.deepEqual(productionPorts.registerFixtureCapabilityPort(
      productionPorts.productionPortIdentityFromManifest(manifest),
      { invoke: portInvoke as never },
    ), { ok: true });
    const carrier = brackets.wrapToolForHarness({
      type: 'function',
      name: 'call_tool',
      description: 'Invoke one exact frozen catalog capability.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          args_json: { type: 'string' },
        },
        required: ['name', 'args_json'],
      },
      needsApproval: async () => false,
      invoke: async () => {
        outerBodies += 1;
        throw new Error('generic carrier body must remain unreachable');
      },
    });
    const model = stubModel([
      [toolCall(`${input.label}-call`, 'call_tool', {
        name: operationId,
        args_json: JSON.stringify(input.args ?? {}),
      })],
      [textMsg(`${input.label} settled`)],
    ]);
    const agent = { model, tools: [carrier] };
    bindHostCanarySurface(fixture, agent, [carrier]);
    let outcome = await runProductionHost(fixture, agent);
    const approvalCount = outcome.hasInterruptions
      ? HostInterruptState.fromString(outcome.serializedState!).getInterruptions().length
      : 0;
    assert.equal(approvalCount, 0, `${input.label}:approval count`);
    assert.equal(outerBodies, 0);
    assert.equal(portBodies, input.shouldExecute ? 1 : 0, JSON.stringify({
      terminal: outcome.terminal,
      finalOutput: outcome.finalOutput,
      history: outcome.history,
    }));
    if (input.expectRepair) {
      assert.equal(Boolean(outcome.hasInterruptions), false);
      assert.equal(outcome.terminal, undefined);
      assert.deepEqual(dispositionMarkers(outcome.history), [{
        disposition: 'refused_pre_dispatch',
        effect: 'none',
        retry: 'replan',
        requiresReconciliation: false,
      }]);
    }
    const db = eventlog.openEventLog();
    const logicalCount = (db.prepare(`
      SELECT COUNT(*) AS n FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
    `).get(fixture.session.id, fixture.source.seq) as { n: number }).n;
    const physicalCount = (db.prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(fixture.session.id, fixture.source.seq) as { n: number }).n;
    assert.equal(logicalCount, input.shouldExecute ? 1 : 0, input.label);
    assert.equal(physicalCount, input.shouldExecute ? 1 : 0, input.label);
  };

  try {
    await t.test('native-MCP exact primary with invoke_live_read and zero args admits once', () => runVariant({
      label: 'exact-live-read', purpose: 'invoke_live_read', shouldExecute: true,
    }));
    await t.test('Composio exact primary uses selector schema rather than definition digest', () => runVariant({
      label: 'exact-composio', purpose: 'invoke_live_read', providerKind: 'composio',
      shouldExecute: true,
    }));
    await t.test('missing selector-schema catalog authority cannot fall back to the workflow definition digest', () => runVariant({
      label: 'missing-source-schema', purpose: 'invoke_live_read', providerKind: 'composio',
      omitSourceSchemaFingerprint: true, shouldExecute: false,
    }));
    await t.test('fresh explicit source still requires formal A/Q/B confirmation', () => runVariant({
      label: 'fresh-explicit', purpose: 'invoke_live_read', providerKind: 'composio',
      fresh: 'explicit', shouldExecute: false,
    }));
    await t.test('fresh unspecified source remains pending and crosses neither ledger', () => runVariant({
      label: 'fresh-pending', purpose: 'invoke_live_read', providerKind: 'composio',
      fresh: 'pending', shouldExecute: false,
    }));
    await t.test('fresh explicit source refuses an unbound generic live read', () => runVariant({
      label: 'fresh-explicit-unbound', purpose: 'invoke_live_read', providerKind: 'composio',
      fresh: 'explicit', bindingMatches: false, shouldExecute: false,
    }));
    await t.test('exact selected capability mismatch refuses before logical admission', () => runVariant({
      label: 'mismatch', purpose: 'collect_records', bindingMatches: false, shouldExecute: false,
    }));
    await t.test('missing selected schema qualifier refuses before approval or logical admission', () => runVariant({
      label: 'missing-binding-schema', purpose: 'collect_records', bindingSchema: 'missing',
      shouldExecute: false,
    }));
    await t.test('missing selected account qualifier refuses an account-bound manifest before approval', () => runVariant({
      label: 'missing-binding-account', purpose: 'collect_records', bindingAccount: 'missing',
      shouldExecute: false,
    }));
    await t.test('same capability with the wrong selected account refuses before approval', () => runVariant({
      label: 'wrong-binding-account', purpose: 'collect_records', bindingAccount: 'wrong',
      shouldExecute: false,
    }));
    await t.test('missing consuming decision refuses before logical admission', () => runVariant({
      label: 'missing-decision', purpose: 'invoke_live_read', consumingDecision: 'missing', shouldExecute: false,
    }));
    await t.test('materially different B stays closed before Q2 confirmation', () => runVariant({
      label: 'variant-unconfirmed', purpose: 'invoke_live_read', consumingDecision: 'variant',
      shouldExecute: false,
    }));
    await t.test('duplicate consuming decision refuses before logical admission', () => runVariant({
      label: 'duplicate-decision', purpose: 'invoke_live_read', consumingDecision: 'duplicate', shouldExecute: false,
    }));
    await t.test('current-request nonempty args execute under the exact call-bound lease', () => runVariant({
      label: 'legacy-args', purpose: 'invoke_live_read', args: { query: 'Seattle' }, shouldExecute: true,
    }));
    await t.test('reforged consuming binding cannot replace exact A/Q/B bytes', () => runVariant({
      label: 'reforged', purpose: 'collect_records', bindingMatches: false,
      consumingDecision: 'reforged', shouldExecute: false,
    }));
    await t.test('same-binding mutated consuming decision cannot replace exact A/Q/B bytes', () => runVariant({
      label: 'mutated-decision', purpose: 'invoke_live_read', consumingDecision: 'mutated',
      shouldExecute: false,
    }));
    await t.test('wrong-role consuming decision has no dispatch authority', () => runVariant({
      label: 'wrong-role-decision', purpose: 'invoke_live_read', consumingDecision: 'wrong_role',
      shouldExecute: false,
    }));
    await t.test('mixed valid and wrong-role consuming rows are ambiguous', () => runVariant({
      label: 'mixed-role-decision', purpose: 'invoke_live_read', consumingDecision: 'mixed_role',
      shouldExecute: false,
    }));
    await t.test('bound awaiting with missing parent decision is not generic authority', () => runVariant({
      label: 'missing-parent-decision', purpose: 'collect_records', omitParentDecision: true,
      shouldExecute: false,
    }));
    await t.test('sole wrong-turn parent decision is not A/Q/B authority', () => runVariant({
      label: 'wrong-turn-parent-decision', purpose: 'collect_records', parentDecision: 'wrong_turn',
      shouldExecute: false,
    }));
    await t.test('mixed canonical and wrong-turn parent decisions are ambiguous', () => runVariant({
      label: 'mixed-turn-parent-decision', purpose: 'collect_records', parentDecision: 'mixed_turn',
      shouldExecute: false,
    }));
    await t.test('ordinary source-purpose manifest needs no historical continuation binding', () => runVariant({
      label: 'no-lineage', purpose: 'collect_records', noContinuation: true, shouldExecute: true,
    }));
    await t.test('forged B decision without consumed A/Q/B cannot authorize a generic live read', () => runVariant({
      label: 'forged-no-lineage', purpose: 'invoke_live_read', noContinuation: true,
      forgedDecisionWithoutLineage: true, shouldExecute: false,
    }));
    await t.test('write-shaped source mismatch still crosses neither ledger', () => runVariant({
      label: 'write-shaped', purpose: 'collect_records', effect: 'external_write',
      bindingMatches: false, shouldExecute: false,
    }));
    await t.test('exact source authority without work coverage is paired back for repair', () => runVariant({
      label: 'write-shaped-exact', purpose: 'collect_records', effect: 'external_write',
      expectRepair: true, shouldExecute: false,
    }));
    await t.test('verified B refuses a structurally unrelated source capability', () => runVariant({
      label: 'unrelated-lookup', purpose: 'lookup_records', bindingMatches: false, shouldExecute: false,
    }));
    await t.test('unbound generic live read during verified B fails closed', () => runVariant({
      label: 'unbound-live-read', purpose: 'invoke_live_read', bindingMatches: false, shouldExecute: false,
    }));
    await t.test('unknown provider purpose cannot bypass an actual material-source continuation', () => runVariant({
      label: 'unknown-purpose-bound-read', purpose: 'provider_future_read', bindingMatches: false,
      shouldExecute: false,
    }));
  } finally {
    productionPorts.clearProductionCapabilityPorts();
    for (const prior of priorPorts) {
      productionPorts.registerFixtureCapabilityPort(prior.identity, prior.port);
    }
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('production host refuses unpropagated source carriers before approval, child/network body, or either ledger', async (t) => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  const binding = turnControl.validatedTurnSourceStrategyBinding({
    version: 1,
    primary: {
      capabilityId: 'capability:composio:APIFY_DELEGATION_SOURCE',
      schemaFingerprint: 'a'.repeat(64),
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'b'.repeat(64),
    destination: { family: 'artifact', posture: 'create_new' },
    effect: 'external_write',
  });
  assert.ok(binding);
  const runVariant = async (input: {
    kind: 'pending' | 'verified';
    name: 'run_worker' | 'run_batch' | 'pending_action_execute' | 'run_shell_command'
      | 'space_save' | 'space_refresh' | 'space_edit_runner' | 'space_revert_runner'
      | 'space_action_prepare' | 'dispatch_background_task' | 'workflow_create'
      | 'workflow_schedule' | 'team_request' | 'hold_task_for_later' | 'update_agent'
      | 'local_cli_probe' | 'check_capability';
    args: Record<string, unknown>;
  }) => {
    const { kind } = input;
    const fixture = kind === 'pending'
      ? acceptFreshMaterialSource({ label: `${input.name}-${kind}`, binding: binding!, explicit: false })
      : await acceptMaterialSourceContinuation({ label: `${input.name}-${kind}`, binding: binding! });
    let carrierBodies = 0;
    const carrier = brackets.wrapToolForHarness({
      type: 'function',
      name: input.name,
      description: 'Exercise one structurally registered unpropagated source carrier.',
      parameters: {
        type: 'object',
        additionalProperties: true,
      },
      needsApproval: async () => false,
      invoke: async () => {
        carrierBodies += 1;
        throw new Error('material-source carrier must not start a child or network body');
      },
    });
    const callId = `${input.name}-${kind}-call`;
    const model = stubModel([
      [toolCall(callId, input.name, input.args)],
      [textMsg(`continued without ${input.name}`)],
    ]);
    const agent = { model, tools: [carrier] };
    bindHostCanarySurface(fixture, agent, [carrier]);
    const outcome = await runProductionHost(fixture, agent);
    assert.equal(Boolean(outcome.hasInterruptions), false, 'source authority blocks before approval UI');
    assert.equal(outcome.terminal, undefined);
    assert.equal(outcome.finalOutput, `continued without ${input.name}`);
    assert.equal(model.calls(), 2);
    assert.equal(carrierBodies, 0);
    assert.deepEqual(
      outcome.history
        .filter((item) => (item as { type?: string }).type === 'function_call_result')
        .map((item) => (item as { callId?: string }).callId),
      [callId],
    );
    assert.deepEqual(dispositionMarkers(outcome.history), [{
      disposition: 'refused_pre_dispatch',
      effect: 'none',
      retry: 'replan',
      requiresReconciliation: false,
    }]);
    const db = eventlog.openEventLog();
    for (const table of ['logical_tool_calls', 'physical_dispatches']) {
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS n FROM ${table}
         WHERE session_id = ? AND source_user_seq = ?
      `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0,
      `${input.name}:${kind}:${table}`);
    }
  };
  try {
    for (const kind of ['pending', 'verified'] as const) {
      await t.test(`${kind} source cannot spawn run_worker`, () => runVariant({
        kind, name: 'run_worker',
        args: { item: 'source batch', prompt: 'Use another provider to collect the records.' },
      }));
      await t.test(`${kind} source cannot release run_batch`, () => runVariant({
        kind, name: 'run_batch', args: { action: 'execute', plan_id: 'prior-plan' },
      }));
      await t.test(`${kind} source cannot release pending_action_execute`, () => runVariant({
        kind, name: 'pending_action_execute', args: { approval_id: 'prior-approval' },
      }));
      await t.test(`${kind} source cannot use shell network reads`, () => runVariant({
        kind, name: 'run_shell_command',
        args: { command: 'curl -s https://alternate-source.example.test/items' },
      }));
      await t.test(`${kind} source cannot spawn an arbitrary PATH-selected probe`, () => runVariant({
        kind, name: 'local_cli_probe', args: { command: 'alternate-source-client' },
      }));
      await t.test(`${kind} source cannot check an arbitrary PATH-selected capability`, () => runVariant({
        kind, name: 'check_capability', args: { name: 'alternate-source-client' },
      }));
      for (const name of [
        'space_save', 'space_refresh', 'space_edit_runner', 'space_revert_runner', 'space_action_prepare',
      ] as const) {
        await t.test(`${kind} source cannot release ${name} runner execution`, () => runVariant({
          kind,
          name,
          args: { slug: 'prior-source-backed-space' },
        }));
      }
      await t.test(`${kind} source cannot dispatch a background child`, () => runVariant({
        kind, name: 'dispatch_background_task', args: { task: 'collect from another source' },
      }));
      await t.test(`${kind} source cannot auto-test a newly authored workflow`, () => runVariant({
        kind,
        name: 'workflow_create',
        args: {
          name: 'future-source-workflow',
          description: 'Inspect the future source.',
          steps: [{ id: 'inspect', prompt: 'Inspect the future source and return a summary.', sideEffect: 'read' }],
        },
      }));
      await t.test(`${kind} source cannot schedule future unpropagated execution`, () => runVariant({
        kind, name: 'workflow_schedule', args: { name: 'future-source-workflow', cron: '0 * * * *' },
      }));
      await t.test(`${kind} source cannot wake a team child`, () => runVariant({
        kind, name: 'team_request', args: { agent_id: 'worker', request: 'collect elsewhere' },
      }));
      await t.test(`${kind} source cannot activate proactive agent work`, () => runVariant({
        kind, name: 'update_agent', args: { id: 'worker', enabled: true },
      }));
      await t.test(`${kind} source cannot park authority for an unbound later resume`, () => runVariant({
        kind, name: 'hold_task_for_later', args: { task: 'collect elsewhere later' },
      }));
    }
  } finally {
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('production host pairs an unplanned connected external write back for repair without crossing', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const priorPorts = productionPorts.listProductionCapabilityPorts();
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const fixture = acceptHostCanarySource('production-external-write');
  const operationId = 'records_fixture__create_profile';
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: 'cap:fixture:profile-create',
    providerKind: 'native_mcp',
    operationId,
    providerIdentity: 'configured-profile-directory',
    providerVersion: '2026-08-22',
    operationVersion: '1',
    definitionFingerprint: 'c'.repeat(64),
    effect: 'external_write',
    accountId: 'account:fixture:primary',
    idempotency: { required: true, policy: 'provider_key' },
    reconciliation: { supported: true, policy: 'provider_lookup' },
    outputContract: { kind: 'created_profile' },
    evidenceContract: { kinds: ['receipt'], readbackRequired: true },
    provenance: {
      issuer: 'host-turn-runner:test',
      issuedAt: '2026-08-22T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['create'],
  });
  let portBodies = 0;
  let outerBodies = 0;
  const portInvoke = async (request: {
    payload?: unknown;
    binding?: { account?: unknown; manifestDigest?: unknown; toolName?: unknown };
  }) => {
    portBodies += 1;
    assert.deepEqual(request.payload, { name: 'Fixture Attorney', city: 'Seattle' });
    assert.equal(request.binding?.account, manifest.accountId);
    assert.equal(request.binding?.manifestDigest,
      capabilityManifests.capabilityManifestDigest(manifest));
    assert.equal(request.binding?.toolName, operationId);
    return {
      kind: 'clementine.external-write.result',
      version: 1,
      successful: true,
      recordId: 'profile-fixture-1',
    };
  };
  const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
  factory.register({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: portInvoke as never,
  });
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
  productionPorts.clearProductionCapabilityPorts();
  assert.deepEqual(productionPorts.registerFixtureCapabilityPort(
    productionPorts.productionPortIdentityFromManifest(manifest),
    { invoke: portInvoke as never },
  ), { ok: true });
  const carrier = brackets.wrapToolForHarness({
    type: 'function',
    name: 'call_tool',
    description: 'Invoke one exact schema acquired from the frozen capability catalog.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        args_json: { type: 'string' },
      },
      required: ['name', 'args_json'],
    },
    needsApproval: async () => false,
    invoke: async () => {
      outerBodies += 1;
      throw new Error('the generic carrier body must not replace the exact production port');
    },
  });
  const model = stubModel([
    [toolCall('external-write-call', 'call_tool', {
      name: operationId,
      args_json: JSON.stringify({ name: 'Fixture Attorney', city: 'Seattle' }),
    })],
    [textMsg('external write settled')],
  ]);
  const agent = { model, tools: [carrier] };
  bindHostCanarySurface(fixture, agent, [carrier]);

  try {
    const outcome = await runProductionHost(fixture, agent);
    assert.equal(Boolean(outcome.hasInterruptions), false);
    assert.equal(outcome.terminal, undefined);
    assert.equal(outcome.finalOutput, 'external write settled');
    assert.equal(model.calls(), 2);
    assert.equal(portBodies, 0, 'repair precedes the exact external port');
    assert.equal(outerBodies, 0);
    const db = eventlog.openEventLog();
    for (const table of ['logical_tool_calls', 'physical_dispatches']) {
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS n FROM ${table}
         WHERE session_id = ? AND source_user_seq = ?
      `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0, table);
    }
    assert.deepEqual(dispositionMarkers(outcome.history), [{
      disposition: 'refused_pre_dispatch',
      effect: 'none',
      retry: 'replan',
      requiresReconciliation: false,
    }]);
  } finally {
    productionPorts.clearProductionCapabilityPorts();
    for (const prior of priorPorts) {
      productionPorts.registerFixtureCapabilityPort(prior.identity, prior.port);
    }
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('production host refuses a preaccepted turn-graph hybrid before model, logical, or physical execution', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const priorPorts = productionPorts.listProductionCapabilityPorts();
  const priorSemanticPort = semanticPorts.peekTurnSemanticModelPort();
  process.env.HARNESS_TOOL_BRACKETS = 'on';

  const acceptedText = 'Find two restaurants in Santa Clarita and create one new Google Sheet with the results.';
  const session = eventlog.createSession({
    id: `host-accepted-sheet-${++acceptedSerial}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: acceptedText },
  });
  const fixture = {
    session,
    source,
    parent: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      counter: new brackets.ToolCallsCounter(12),
      behaviorScopeId: `${session.id}::turn:1`,
    },
    context: { sessionId: session.id, sourceUserSeq: source.seq },
  } as ReturnType<typeof acceptHostCanarySource>;

  const readOperation = 'RESTAURANTS_SEARCH';
  const sheetOperation = 'GOOGLESHEETS_SHEET_FROM_JSON';
  const readManifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: 'cap:fixture:restaurants-search',
    providerKind: 'composio',
    operationId: readOperation,
    providerIdentity: 'composio:restaurants',
    providerVersion: '2026-08-23',
    operationVersion: '1',
    definitionFingerprint: '3'.repeat(64),
    effect: 'read',
    accountId: 'account:restaurants:owner',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'collect_records',
    acceptedInputKinds: ['query'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: {
      issuer: 'host-turn-runner:test',
      issuedAt: '2026-08-23T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source', 'collection'],
  });
  const sheetManifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: 'cap:fixture:googlesheets-sheet-from-json',
    providerKind: 'composio',
    operationId: sheetOperation,
    providerIdentity: 'composio:googlesheets',
    providerVersion: '2026-08-23',
    operationVersion: '1',
    definitionFingerprint: '4'.repeat(64),
    effect: 'external_write',
    destination: { family: 'workbook', posture: 'create_new' },
    accountId: 'account:googlesheets:owner',
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'created_spreadsheet' },
    purpose: 'persist_collection',
    acceptedInputKinds: ['records'],
    producedOutputKinds: ['created_spreadsheet'],
    applicableDeliverableKinds: ['workbook'],
    evidenceContract: { kinds: ['receipt'], readbackRequired: true },
    provenance: {
      issuer: 'host-turn-runner:test',
      issuedAt: '2026-08-23T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['destination', 'create'],
  });

  let directPortBodies = 0;
  const exactPort = async () => {
    directPortBodies += 1;
    throw new Error('work_call must retain its admission carrier instead of jumping to the direct port');
  };
  const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
  for (const manifest of [readManifest, sheetManifest]) {
    factory.register({
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect,
      ...(manifest.destination ? { destination: manifest.destination } : {}),
      account: manifest.accountId,
      advisoryRoles: manifest.advisoryRoles,
      manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: exactPort,
    });
  }
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
  productionPorts.clearProductionCapabilityPorts();
  for (const manifest of [readManifest, sheetManifest]) {
    assert.deepEqual(productionPorts.registerFixtureCapabilityPort(
      productionPorts.productionPortIdentityFromManifest(manifest),
      { invoke: exactPort },
    ), { ok: true });
  }
  capabilityResolution.recordAdmissionCapabilityResolution({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedInput: acceptedText,
    entries: [
      {
        intent: 'collect restaurants',
        kind: 'composio',
        identifier: readOperation,
        status: 'proven',
        connection: 'active',
        effectClass: 'read',
      },
      {
        intent: 'create the requested spreadsheet',
        kind: 'composio',
        identifier: sheetOperation,
        status: 'proven',
        connection: 'active',
        effectClass: 'write',
      },
    ],
  });

  semanticPorts.installTurnSemanticModelPort({
    async interpret() {
      return {
        raw: {
          version: 1,
          relation: 'new_goal',
          targetGoal: null,
          goal: {
            objective: acceptedText,
            criteria: [
              { id: 'restaurants-collected', statement: 'Two restaurant records are collected.' },
              { id: 'sheet-created', statement: 'One new Google Sheet contains the records.' },
            ],
            openSlots: [],
            candidates: [
              { kind: 'capability', id: readManifest.manifestId },
              { kind: 'capability', id: sheetManifest.manifestId },
            ],
          },
          work: {
            construct: 'collect_then_construct',
            cardinality: { count: 2, fields: ['name', 'rating'] },
            destination: { posture: 'create_new', family: 'workbook', handleRequired: true },
            requestedEffect: 'external_write',
            operations: [
              {
                id: 'collect-restaurants',
                role: 'source',
                requestedEffect: 'read',
                dependsOn: [],
                evidence: ['records'],
                capabilityRef: readManifest.manifestId,
              },
              {
                id: 'create-sheet',
                role: 'destination',
                requestedEffect: 'external_write',
                dependsOn: ['collect-restaurants'],
                evidence: ['receipt'],
                capabilityRef: sheetManifest.manifestId,
              },
            ],
            deliverables: [{ id: 'restaurant-sheet', kind: 'workbook' }],
            evidenceRequirements: ['receipt', 'readback'],
          },
          slotAnswers: [],
          rationale: 'The accepted request names one bounded collection and one new spreadsheet.',
        },
        modelIdentity: 'host-turn-runner-semantic-fixture',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgeSourceEffect(call) {
      return {
        verdict: 'entailed',
        effect: call.proposedEffect,
        destinationPosture: call.proposedDestinationPosture,
        proposalDigest: call.proposalDigest,
        modelIdentity: 'host-turn-runner-effect-judge',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgePlanGrounding(call) {
      return {
        verdict: 'entailed',
        operations: call.dag.operations.map((operation) => ({
          operationId: operation.id,
          verdict: 'entailed' as const,
          rationale: 'The exact frozen capability descriptor entails this operation.',
        })),
        modelIdentity: 'host-turn-runner-grounding-judge',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
  });

  try {
    // Establish the same durable authority a foreground loop may admit at any
    // point before this effect. This fixture intentionally does not prescribe
    // a hidden pre-model compile or a second planning pass.
    const admitted = await semanticCompile.admitAndCompileAcceptedSource({
      identity: { sessionId: session.id, turn: 1, sourceUserSeq: source.seq },
      surface: 'direct',
    });
    assert.equal(admitted.ok, true, admitted.ok ? '' : admitted.reason);
    if (!admitted.ok) return;
    const destination = admitted.compiled.graph.classification.goalConstraints?.destination;
    assert.equal(destination?.binding?.manifestId, sheetManifest.manifestId);
    assert.equal(destination?.binding?.manifestDigest,
      capabilityManifests.capabilityManifestDigest(sheetManifest));

    const frozen = expectedWorkContracts.freezeDeterministicExpectedWorkContract({
      sessionId: session.id,
      sourceUserSeq: source.seq,
    });
    assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
    if (frozen.status !== 'fixed' && frozen.status !== 'replayed') return;
    assert.equal(expectedWorkAdmission.activateActionExpectedWork({
      sessionId: session.id,
      sourceUserSeq: source.seq,
    }).status, 'activated');
    const readRequirement = frozen.contract.operations.find((operation) => operation.effect === 'read');
    const writeRequirement = frozen.contract.operations.find((operation) => operation.effect === 'external_write');
    assert.ok(readRequirement);
    assert.ok(writeRequirement);

    // Reassert the exact accepted-source proof after semantic catalog priming;
    // work_call consumes this durable selection when it maps the advertised
    // operation onto the trusted Composio gateway.
    capabilityResolution.recordAdmissionCapabilityResolution({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      acceptedInput: acceptedText,
      entries: [
        {
          intent: 'collect restaurants',
          kind: 'composio',
          identifier: readOperation,
          status: 'proven',
          connection: 'active',
          effectClass: 'read',
        },
        {
          intent: 'create the requested spreadsheet',
          kind: 'composio',
          identifier: sheetOperation,
          status: 'proven',
          connection: 'active',
          effectClass: 'write',
        },
      ],
    });

    const readArgs = { city: 'Santa Clarita', limit: 2 };
    const rows = [
      { name: 'A', rating: 4.8 },
      { name: 'B', rating: 4.7 },
    ];
    const sheetArgs = {
      title: 'Santa Clarita Restaurants',
      sheet_name: 'Restaurants',
      sheet_json: rows,
    };
    composioSchemas.rememberToolSchema(readOperation, {
      type: 'object',
      additionalProperties: false,
      required: ['city', 'limit'],
      properties: {
        city: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    });
    composioSchemas.rememberToolSchema(sheetOperation, {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'sheet_name', 'sheet_json'],
      properties: {
        title: { type: 'string' },
        sheet_name: { type: 'string' },
        sheet_json: { type: 'array', items: { type: 'object' } },
      },
    });

    let innerReadBodies = 0;
    let innerWriteBodies = 0;
    const composioGateway = tool({
      name: 'composio_execute_tool',
      description: 'Fixture trusted Composio gateway.',
      parameters: z.object({
        tool_slug: z.string(),
        arguments: z.string().nullable(),
        connected_account_id: z.string().nullable(),
      }),
      execute: async (input) => {
        const slug = input.tool_slug.toUpperCase();
        if (slug === readOperation) {
          innerReadBodies += 1;
          return { records: rows, total: rows.length, has_more: false };
        }
        assert.equal(slug, sheetOperation);
        const activeBinding = expectedWorkAdmission.currentExpectedWorkBinding();
        assert.equal(activeBinding?.requirementId, writeRequirement.id,
          'the immutable once-write requirement must exist before the provider body');
        const bindingRows = eventlog.openEventLog().prepare(`
          SELECT COUNT(*) AS n FROM expected_work_call_bindings
           WHERE session_id = ? AND source_user_seq = ? AND requirement_id = ?
        `).get(session.id, source.seq, writeRequirement.id) as { n: number };
        assert.equal(bindingRows.n, 1, 'work_call binds exactly one create before provider dispatch');
        innerWriteBodies += 1;
        return {
          successful: true,
          spreadsheetId: 'sheet-fixture-1',
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-fixture-1/edit',
        };
      },
    });
    innerDispatch._setInnerDispatchToolsForTests(new Map([
      ['composio_execute_tool', composioGateway as never],
    ]));

    const workCall = brackets.wrapToolForHarness(workCallTools.buildWorkCall({
      frozenContract: frozen.contract,
      reachableBuiltinNames: new Set(['composio_execute_tool']),
      firstClassNames: new Set<string>(),
      catalogIdentifiers: [readOperation, sheetOperation],
      settlementLane: 'byo',
    }) as never);
    const workArgs = (requirementId: string, name: string, args: Record<string, unknown>) => ({
      proposal: null,
      requirement_id: requirementId,
      universe_item_id: null,
      universe_selector: null,
      seal_amendment: null,
      name: 'composio_execute_tool',
      args_json: JSON.stringify({
        tool_slug: name,
        arguments: JSON.stringify(args),
        connected_account_id: null,
      }),
    });
    const model = stubModel([
      [toolCall('restaurants-read-call', 'work_call', workArgs(readRequirement.id, readOperation, readArgs))],
      [toolCall('sheet-create-call', 'work_call', workArgs(writeRequirement.id, sheetOperation, sheetArgs))],
      [textMsg('Created the restaurant Sheet.')],
    ]);
    const agent = { model, tools: [workCall] };
    bindHostCanarySurface(fixture, agent, [workCall]);

    const outcome = await runProductionHost(fixture, agent);
    const authorityDiagnostic = {
      outcome,
      logical: eventlog.openEventLog().prepare(`
        SELECT logical_tool_call_id, tool_name, state, effective_argument_digest
          FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?
      `).all(session.id, source.seq),
      leases: eventlog.openEventLog().prepare(`
        SELECT logical_tool_call_id, revoked_at, recovery_tool_name
          FROM run_dispatch_leases WHERE session_id = ? AND source_user_seq = ?
      `).all(session.id, source.seq),
      physical: eventlog.openEventLog().prepare(`
        SELECT logical_tool_call_id, tool_name, state, execution_site
          FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ?
      `).all(session.id, source.seq),
      settlements: eventlog.openEventLog().prepare(`
        SELECT logical_tool_call_id, business_call, mutating, execution_kind, outcome_kind
          FROM logical_call_settlements WHERE session_id = ? AND source_user_seq = ?
      `).all(session.id, source.seq),
      hostBindings: eventlog.openEventLog().prepare(`
        SELECT logical_tool_call_id, root_authority_kind, root_graph_event_id,
               root_graph_hash, operation_id, account_id,
               provider_input_schema_digest, effect
          FROM host_call_capability_bindings
         WHERE session_id = ? AND source_user_seq = ?
      `).all(session.id, source.seq),
    };
    assert.equal(outcome.terminal?.status, 'blocked', JSON.stringify(authorityDiagnostic));
    assert.equal(outcome.terminal?.reason, 'preaccepted_graph_execution_owner',
      JSON.stringify(authorityDiagnostic));
    assert.equal(model.calls(), 0, 'the ownership collision is refused before model I/O');
    assert.equal(innerReadBodies, 0);
    assert.equal(innerWriteBodies, 0);
    assert.equal(directPortBodies, 0);
    assert.deepEqual(authorityDiagnostic.logical, []);
    assert.deepEqual(authorityDiagnostic.leases, []);
    assert.deepEqual(authorityDiagnostic.physical, []);
    assert.deepEqual(authorityDiagnostic.settlements, []);
    assert.deepEqual(authorityDiagnostic.hostBindings, []);
  } finally {
    innerDispatch._setInnerDispatchToolsForTests(null);
    semanticPorts.installTurnSemanticModelPort(priorSemanticPort);
    productionPorts.clearProductionCapabilityPorts();
    for (const prior of priorPorts) {
      productionPorts.registerFixtureCapabilityPort(prior.identity, prior.port);
    }
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('read-only canary admits only attested read effects and refuses mutating/unknown calls', async (t) => {
  await t.test('exact bound accountless local read reaches the shared durable settlement kernel', async () => {
    let approvals = 0;
    let bodies = 0;
    const fixture = acceptHostCanarySource('attested-read');
    const boundedRead = brackets.wrapToolForHarness({
      type: 'function', name: 'list_files', description: 'read',
      parameters: { type: 'object', properties: { limit: { type: 'number' } } },
      needsApproval: async () => { approvals += 1; return false; },
      invoke: async () => { bodies += 1; return 'history'; },
    });
    const model = stubModel([
      [toolCall('read-1', 'list_files', { limit: 1 })],
      [textMsg('read done')],
    ]);
    const agent = { model, tools: [boundedRead] };
    bindHostCanarySurface(fixture, agent, [boundedRead]);
    const outcome = await runHostCanary(fixture, agent);
    assert.equal(outcome.finalOutput, 'read done');
    assert.equal(approvals, 1, 'the exact active binding reaches ordinary approval admission');
    assert.equal(bodies, 1, 'the admitted read executes exactly once');
    assert.equal(model.calls(), 2);

    const db = eventlog.openEventLog();
    const logical = db.prepare(`
      SELECT logical_tool_call_id, tool_name, state
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
    `).all(fixture.session.id, fixture.source.seq) as Array<{
      logical_tool_call_id: string; tool_name: string; state: string;
    }>;
    assert.deepEqual(logical, [{ logical_tool_call_id: 'read-1', tool_name: 'list_files', state: 'settled' }]);
    const crossings = db.prepare(`
      SELECT logical_tool_call_id, execution_site, state
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).all(fixture.session.id, fixture.source.seq) as Array<{
      logical_tool_call_id: string; execution_site: string; state: string;
    }>;
    assert.deepEqual(crossings, [{ logical_tool_call_id: 'read-1', execution_site: 'host', state: 'returned' }]);
    const settlement = db.prepare(`
      SELECT physical_crossing_count, host_crossing_count
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = 'read-1'
    `).get(fixture.session.id, fixture.source.seq) as {
      physical_crossing_count: number; host_crossing_count: number;
    };
    assert.equal(settlement.physical_crossing_count, 0);
    assert.equal(settlement.host_crossing_count, 1);
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM accepted_task_resolutions
       WHERE session_id = ? AND source_user_seq = ?
    `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0);
    assert.equal(eventlog.listEvents(fixture.session.id, { types: ['turn_graph_shadow'] }).length, 0);
    const authority = callAuthorities.acceptedTurnCallAuthorityFor(fixture.session.id, fixture.source.seq);
    assert.equal(authority.status, 'ok');
    if (authority.status === 'ok') assert.equal(authority.authority.state, 'open');
  });

  for (const fixture of [
    { label: 'mutating', name: 'write_file', args: { path: 'out.txt', content: 'x' } },
    { label: 'unknown', name: 'future_provider_action', args: { value: 'x' } },
    { label: 'shell-compute', name: 'run_shell_command', args: { command: 'pwd' } },
    { label: 'host-control', name: 'ask_user_question', args: { question: 'continue?' } },
    { label: 'undeclared-local-read', name: 'session_history', args: { limit: 1 } },
    { label: 'opaque-compute', name: 'extract_structured', args: { text: 'x', schema: {} } },
    { label: 'git-read-spawn', name: 'git_status', args: { directory: null } },
    { label: 'binary-read-conversion', name: 'read_file', args: { path: 'document.pdf', max_chars: 20000 } },
    { label: 'automation-lazy-read-get', name: 'automation_opportunity_get', args: { proposal_id: 'missing' } },
    { label: 'automation-lazy-read-list', name: 'automation_opportunity_list', args: { limit: 1 } },
    {
      label: 'table-ops-spill',
      name: 'table_ops',
      args: {
        op: 'select',
        left_rows: JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ index }))),
        columns: 'index',
      },
    },
    { label: 'automation-local-write', name: 'automation_opportunity_propose', args: { proposal_key: 'p', opportunity: {} } },
  ]) {
    await t.test(fixture.label, async () => {
      let approvals = 0;
      let bodies = 0;
      const sourceFixture = acceptHostCanarySource(fixture.label);
      const boundedTool = brackets.wrapToolForHarness({
        type: 'function', name: fixture.name, description: fixture.label,
        parameters: { type: 'object', properties: {} },
        needsApproval: async () => { approvals += 1; return false; },
        invoke: async () => { bodies += 1; return 'must not run'; },
      });
      const model = stubModel([
        [toolCall(`${fixture.label}-1`, fixture.name, fixture.args)],
        [textMsg(`${fixture.label} refused safely`)],
      ]);
      const agent = { model, tools: [boundedTool] };
      bindHostCanarySurface(sourceFixture, agent, [boundedTool]);
      const outcome = await runHostCanary(sourceFixture, agent);
      assert.equal(outcome.finalOutput, `${fixture.label} refused safely`);
      assert.equal(approvals, 0, 'canary refusal precedes the approval predicate');
      assert.equal(bodies, 0, 'canary refusal never invokes the tool body');
      assert.match(JSON.stringify(outcome.history), /exact attested pure-local read contract is absent/);
      const rows = eventlog.openEventLog().prepare(`
        SELECT COUNT(*) AS n FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ?
      `).get(sourceFixture.session.id, sourceFixture.source.seq) as { n: number };
      assert.equal(rows.n, 0, 'a refused effect creates no executable logical row');
    });
  }
});

test('host approval resume re-enters with an exact durable call lease before the body', async () => {
  const fixture = acceptHostCanarySource('approval-resume-owner');
  let bodies = 0;
  const boundedRead = brackets.wrapToolForHarness({
    type: 'function',
    name: 'workspace_roots',
    description: 'List directories Clementine is allowed to inspect or operate in.',
    parameters: { type: 'object', properties: {} },
    needsApproval: async () => true,
    invoke: async () => { bodies += 1; return 'roots'; },
  });
  const model = stubModel([
    [toolCall('resume-owned-call', 'workspace_roots', {})],
    [textMsg('resume completed')],
  ]);
  const agent = { model, tools: [boundedRead] };
  bindHostCanarySurface(fixture, agent, [boundedRead]);
  const paused = await runProductionHost(fixture, agent);
  assert.equal(paused.hasInterruptions, true);
  assert.equal(bodies, 0);
  const state = HostInterruptState.fromString(paused.serializedState!);
  assert.ok(state.acceptedModelBatchRef, 'V5 approval state owns the exact pre-admitted batch');
  const pausedRef = state.acceptedModelBatchRef!;
  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT admission.batch_id,
           (SELECT COUNT(*) FROM accepted_model_batch_checkpoints checkpoint
             WHERE checkpoint.session_id = admission.session_id
               AND checkpoint.source_user_seq = admission.source_user_seq
               AND checkpoint.batch_ordinal = admission.batch_ordinal) AS checkpoints
      FROM accepted_model_batch_admissions admission
     WHERE admission.session_id = ? AND admission.source_user_seq = ?
       AND admission.batch_ordinal = ?
  `).get(fixture.session.id, fixture.source.seq, pausedRef.batchOrdinal), {
    batch_id: pausedRef.batchId,
    checkpoints: 0,
  }, 'approval pause keeps one open admission and no result checkpoint');
  state.approve(state.getInterruptions()[0]);
  const resumed = await runProductionHost(fixture, agent, state);
  assert.equal(resumed.finalOutput, 'resume completed');
  assert.equal(bodies, 1);
  assert.equal(model.calls(), 2);

  assert.deepEqual(db.prepare(`
    SELECT logical_tool_call_id, state FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).all(fixture.session.id, fixture.source.seq), [{
    logical_tool_call_id: 'resume-owned-call',
    state: 'settled',
  }]);
  const crossing = db.prepare(`
    SELECT state, lease_scope_id, lease_id FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(fixture.session.id, fixture.source.seq, 'resume-owned-call') as {
    state: string; lease_scope_id: string; lease_id: string;
  };
  assert.equal(crossing.state, 'returned');
  const callLease = db.prepare(`
    SELECT source_user_seq, logical_tool_call_id, revoked_at
      FROM run_dispatch_leases
     WHERE scope_id = ? AND lease_id = ?
  `).get(crossing.lease_scope_id, crossing.lease_id) as {
    source_user_seq: number; logical_tool_call_id: string; revoked_at: string | null;
  };
  assert.equal(callLease.source_user_seq, fixture.source.seq);
  assert.equal(callLease.logical_tool_call_id, 'resume-owned-call');
  assert.ok(callLease.revoked_at, 'the exact resumed generation is fenced before return');
  assert.deepEqual(db.prepare(`
    SELECT checkpoint.batch_id, checkpoint.disposition,
           projection.call_id, projection.result_class
      FROM accepted_model_batch_checkpoints checkpoint
      JOIN logical_model_result_projection_receipts projection
        ON projection.session_id = checkpoint.session_id
       AND projection.source_user_seq = checkpoint.source_user_seq
       AND projection.batch_ordinal = checkpoint.batch_ordinal
     WHERE checkpoint.session_id = ? AND checkpoint.source_user_seq = ?
       AND checkpoint.batch_ordinal = ?
  `).get(fixture.session.id, fixture.source.seq, pausedRef.batchOrdinal), {
    batch_id: pausedRef.batchId,
    disposition: 'ready',
    call_id: 'resume-owned-call',
    result_class: 'text',
  }, 'approval resume finalizes the same V5 batch exactly once');
});

test('host approval rejection checkpoints the exact V5 batch without executing the body', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const fixture = acceptHostCanarySource('approval-rejection-checkpoint');
    let bodies = 0;
    const boundedRead = brackets.wrapToolForHarness({
      type: 'function',
      name: 'workspace_roots',
      description: 'List directories Clementine is allowed to inspect or operate in.',
      parameters: { type: 'object', properties: {} },
      needsApproval: async () => true,
      invoke: async () => { bodies += 1; return 'must not run'; },
    });
    const model = stubModel([
      [toolCall('rejected-owned-call', 'workspace_roots', {})],
      [textMsg('understood, I left it unchanged')],
    ]);
    const agent = { model, tools: [boundedRead] };
    bindHostCanarySurface(fixture, agent, [boundedRead]);

    const paused = await runProductionHost(fixture, agent);
    assert.equal(paused.hasInterruptions, true);
    const state = HostInterruptState.fromString(paused.serializedState!);
    const ref = state.acceptedModelBatchRef;
    assert.ok(ref);
    state.reject(state.getInterruptions()[0]);
    const resumed = await runProductionHost(fixture, agent, state);
    assert.equal(resumed.finalOutput, 'understood, I left it unchanged');
    assert.equal(bodies, 0);
    assert.equal(model.calls(), 2);
    assert.deepEqual(eventlog.openEventLog().prepare(`
      SELECT checkpoint.batch_id, checkpoint.disposition,
             receipt.call_id, receipt.disposition AS result_class
        FROM accepted_model_batch_checkpoints checkpoint
        JOIN host_model_result_receipts receipt
          ON receipt.session_id = checkpoint.session_id
         AND receipt.source_user_seq = checkpoint.source_user_seq
         AND receipt.batch_ordinal = checkpoint.batch_ordinal
       WHERE checkpoint.session_id = ? AND checkpoint.source_user_seq = ?
         AND checkpoint.batch_ordinal = ?
    `).get(fixture.session.id, fixture.source.seq, ref!.batchOrdinal), {
      batch_id: ref!.batchId,
      disposition: 'ready',
      call_id: 'rejected-owned-call',
      result_class: 'user_rejected',
    });
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('read-only canary requires exact harness-wrapper attestation', async (t) => {
  const runRefusal = async (
    label: string,
    configuredTool: Record<string, unknown>,
    bodyCalls: () => number,
  ) => {
    const fixture = acceptHostCanarySource(`attestation-${label}`);
    const model = stubModel([
      [toolCall(`${label}-1`, 'session_history', { limit: 1 })],
      [textMsg(`${label} remained fenced`)],
    ]);
    const agent = { model, tools: [configuredTool] };
    bindHostCanarySurface(fixture, agent, [configuredTool]);
    const outcome = await runHostCanary(fixture, agent);
    assert.equal(outcome.finalOutput, `${label} remained fenced`);
    assert.equal(bodyCalls(), 0, 'an unattested tool body never runs');
    assert.match(JSON.stringify(outcome.history), /only admits configured harness-bounded tools/);
  };

  await t.test('raw configured tool', async () => {
    let bodies = 0;
    await runRefusal('raw', {
      type: 'function', name: 'session_history', description: 'raw read',
      parameters: { type: 'object', properties: {} },
      invoke: async () => { bodies += 1; return 'must not run'; },
    }, () => bodies);
  });

  await t.test('spread copy of a wrapper', async () => {
    let bodies = 0;
    const bounded = brackets.wrapToolForHarness({
      type: 'function', name: 'session_history', description: 'bounded read',
      parameters: { type: 'object', properties: {} },
      invoke: async () => { bodies += 1; return 'must not run'; },
    });
    await runRefusal('copy', { ...bounded }, () => bodies);
  });

  await t.test('post-wrap invoke replacement', async () => {
    let originalBodies = 0;
    let replacementBodies = 0;
    const bounded = brackets.wrapToolForHarness({
      type: 'function', name: 'session_history', description: 'bounded read',
      parameters: { type: 'object', properties: {} },
      invoke: async () => { originalBodies += 1; return 'original'; },
    });
    bounded.invoke = async () => { replacementBodies += 1; return 'replacement'; };
    await runRefusal('mutated', bounded, () => originalBodies + replacementBodies);
  });
});

test('read-only canary refuses native getAllTools and brackets-off calls before their bodies', async (t) => {
  await t.test('native getAllTools read', async () => {
    let bodies = 0;
    const fixture = acceptHostCanarySource('native');
    const model = stubModel([
      [toolCall('native-read-1', 'native__calendar_read', { limit: 5 })],
      [textMsg('native read remained fenced')],
    ]);
    const agent = {
      model,
      tools: [],
      getAllTools: async () => [{
          type: 'function', name: 'native__calendar_read', description: 'native read',
          parameters: { type: 'object', properties: { limit: { type: 'number' } } },
          needsApproval: async () => false,
          invoke: async () => { bodies += 1; return 'must not run'; },
        }],
    };
    bindHostCanarySurface(fixture, agent, []);
    const outcome = await runHostCanary(fixture, agent);
    assert.equal(outcome.finalOutput, 'native read remained fenced');
    assert.equal(bodies, 0);
    assert.match(JSON.stringify(outcome.history), /only admits configured harness-bounded tools/);
  });

  await t.test('brackets off', async () => {
    const prior = process.env.HARNESS_TOOL_BRACKETS;
    process.env.HARNESS_TOOL_BRACKETS = 'off';
    let bodies = 0;
    try {
      const fixture = acceptHostCanarySource('brackets-off');
      const model = stubModel([
        [toolCall('unbounded-read-1', 'calendar_read', { limit: 5 })],
        [textMsg('unbounded read remained fenced')],
      ]);
      const configured = {
            type: 'function', name: 'calendar_read', description: 'configured read',
            parameters: { type: 'object', properties: { limit: { type: 'number' } } },
            needsApproval: async () => false,
            invoke: async () => { bodies += 1; return 'must not run'; },
      };
      const agent = { model, tools: [configured] };
      bindHostCanarySurface(fixture, agent, [configured]);
      const outcome = await runHostCanary(fixture, agent);
      assert.equal(outcome.finalOutput, 'unbounded read remained fenced');
      assert.equal(bodies, 0);
      assert.match(JSON.stringify(outcome.history), /only admits configured harness-bounded tools/);
    } finally {
      if (prior === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
      else process.env.HARNESS_TOOL_BRACKETS = prior;
    }
  });
});

test('host call authority rejects a foreign accepted source before model or tool body', async () => {
  const hostSession = eventlog.createSession({ id: `host-foreign-owner-${++acceptedSerial}`, kind: 'chat' });
  const foreignSession = eventlog.createSession({ id: `host-foreign-source-${acceptedSerial}`, kind: 'chat' });
  const foreignSource = eventlog.appendEvent({
    sessionId: foreignSession.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'This source belongs to another session.' },
  });
  let bodies = 0;
  const bounded = brackets.wrapToolForHarness({
    type: 'function', name: 'list_files', description: 'read',
    parameters: { type: 'object', properties: {} },
    invoke: async () => { bodies += 1; return 'must not run'; },
  });
  const model = stubModel([[toolCall('foreign-read', 'list_files', {})]]);
  const parent = {
    sessionId: hostSession.id,
    sourceUserSeq: foreignSource.seq,
    counter: new brackets.ToolCallsCounter(4),
    behaviorScopeId: `${hostSession.id}::foreign-source`,
  };
  const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    { model, tools: [bounded] } as never,
    [{ type: 'message', role: 'user', content: 'read' }] as never,
    {
      maxTurns: 3,
      hostReadOnlyCanary: true,
      context: { sessionId: hostSession.id, sourceUserSeq: foreignSource.seq },
    },
  ));
  assert.equal(outcome.terminal?.status, 'blocked');
  assert.equal(outcome.terminal?.reason, 'authority_missing');
  assert.equal(model.calls(), 0);
  assert.equal(bodies, 0);
  assert.equal(
    callAuthorities.acceptedTurnCallAuthorityFor(hostSession.id, foreignSource.seq).status,
    'missing',
  );
  assert.equal(
    callAuthorities.acceptedTurnCallAuthorityFor(foreignSession.id, foreignSource.seq).status,
    'missing',
  );
  assert.equal(eventlog.listEvents(hostSession.id, { types: ['turn_graph_shadow'] }).length, 0);
  assert.equal(eventlog.listEvents(foreignSession.id, { types: ['turn_graph_shadow'] }).length, 0);
});

test('schema drift during input guardrails is paired before the poisoned root closes', async () => {
  const fixture = acceptHostCanarySource('guardrail-surface-drift');
  let bodies = 0;
  let bounded: ReturnType<typeof brackets.wrapToolForHarness>;
  bounded = brackets.wrapToolForHarness({
    type: 'function', name: 'list_files', description: 'stable read schema',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    inputGuardrails: [{
      type: 'tool_input',
      name: 'mutate-configured-schema',
      run: async () => {
        bounded.description = 'schema changed after preliminary admission';
        return { behavior: { type: 'allow' as const } };
      },
    }],
    invoke: async () => { bodies += 1; return 'must not run'; },
  });
  const model = stubModel([
    [toolCall('guardrail-drift-read', 'list_files', { limit: 1 })],
    [textMsg('continued after the drifted capability was retired')],
  ]);
  const agent = { model, tools: [bounded] };
  bindHostCanarySurface(fixture, agent, [bounded]);

  const outcome = await runHostCanary(fixture, agent);
  assert.deepEqual(outcome.terminal, { status: 'blocked', reason: 'authority_conflict' });
  assert.equal(model.calls(), 1);
  assert.equal(bodies, 0);
  assert.deepEqual(
    outcome.history
      .filter((item) => (item as { type?: string }).type === 'function_call_result')
      .map((item) => (item as { callId?: string }).callId),
    ['guardrail-drift-read'],
  );
  assert.deepEqual(dispositionMarkers(outcome.history), [{
    disposition: 'refused_pre_dispatch',
    effect: 'none',
    retry: 'replan',
    requiresReconciliation: false,
  }]);
  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_calls,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?) AS physical_crossings
  `).get(
    fixture.session.id,
    fixture.source.seq,
    fixture.session.id,
    fixture.source.seq,
  ), { logical_calls: 0, physical_crossings: 0 });
  const poisoned = callAuthorities.acceptedTurnCallAuthorityFor(fixture.session.id, fixture.source.seq);
  assert.equal(poisoned.status, 'conflict');
  if (poisoned.status === 'conflict') {
    assert.equal(poisoned.reason, 'host read-only call binding changed before body');
  }
});

test('a post-admission surface drift poisons the exact host root before the next model step', async () => {
  const fixture = acceptHostCanarySource('surface-drift');
  let bodies = 0;
  let bounded: ReturnType<typeof brackets.wrapToolForHarness>;
  bounded = brackets.wrapToolForHarness({
    type: 'function', name: 'list_files', description: 'stable read schema',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    invoke: async () => {
      bodies += 1;
      bounded.description = 'schema changed after the admitted body';
      return 'read completed before drift';
    },
  });
  const model = stubModel([
    [toolCall('drift-read', 'list_files', { limit: 1 })],
    [textMsg('must not reach the second model step')],
  ]);
  const agent = { model, tools: [bounded] };
  bindHostCanarySurface(fixture, agent, [bounded]);
  const outcome = await runHostCanary(fixture, agent);
  assert.equal(outcome.terminal?.status, 'blocked');
  assert.equal(outcome.terminal?.reason, 'authority_conflict');
  assert.equal(model.calls(), 1, 'surface drift is detected before another model request');
  assert.equal(bodies, 1);
  const poisoned = callAuthorities.acceptedTurnCallAuthorityFor(fixture.session.id, fixture.source.seq);
  assert.equal(poisoned.status, 'conflict');
  if (poisoned.status === 'conflict') {
    assert.equal(poisoned.reason, 'host read-only surface changed after admission');
  }
  const poisonRow = eventlog.openEventLog().prepare(`
    SELECT state, close_reason FROM accepted_turn_call_authorities
     WHERE session_id = ? AND source_user_seq = ?
  `).get(fixture.session.id, fixture.source.seq) as { state: string; close_reason: string };
  assert.deepEqual(poisonRow, {
    state: 'conflict',
    close_reason: 'host read-only surface changed after admission',
  });
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['conversation_completed'] }).length, 0,
    'the runner cannot publish a competing terminal while its owner still holds lifecycle');
});

// ─── A remedy must always be retryable ───────────────────────────────────────
//
// Two no-effect refusals of the same frame retire it, and the retired set used
// to be rebuilt from the WHOLE conversation. Because history outlives a turn, a
// frame retired once stayed retired forever: the model was refused before it
// could act, and was told to "choose another available capability" with no path
// back. Observed live — Clem named the exact fix for a signed-out account, the
// user performed it and said so, and the next turn refused without probing.
//
// The guard itself is correct and stays. Only its scope changes: a new user
// message is new evidence, so refusals accumulate within the turn that earned
// them.
test('a retired frame is retryable after the user speaks again', async () => {
  const { HOST_CAPABILITY_UNAVAILABLE_TEXT } = await import('./host-turn-runner.js');
  const fixtureTool = () => ({
    type: 'function' as const,
    name: 'missing_owner_fixture',
    description: 'ownership boundary fixture',
    parameters: { type: 'object', properties: {} },
    needsApproval: async () => false,
    invoke: async () => 'must not run',
  });

  // Turn 1: the same frame refused twice, then proposed a third time — the
  // retirement path the guard exists for.
  const firstModel = stubModel([
    [toolCall('retire-1', 'missing_owner_fixture', {})],
    [toolCall('retire-2', 'missing_owner_fixture', {})],
    [toolCall('retire-3', 'missing_owner_fixture', {})],
    [textMsg('unreachable once retired')],
  ]);
  const first = await productionHostRunRunner(
    throwingRunner() as never,
    { model: firstModel, tools: [fixtureTool()] } as never,
    [{ type: 'message', role: 'user', content: 'run the update' }] as never,
    { maxTurns: 6 },
  );
  assert.equal(first.terminal?.reason, 'control_no_progress_exhausted');
  assert.notEqual(first.terminal?.resumable, false);
  assert.match(String(first.finalOutput), /Stopped at: repeated_refused_frame\.\nNext:/,
    'the anti-thrash guard retires the frame and preserves a resumable next edge');

  // Turn 2: the user acts on the advice and says so. The same frame must be
  // attempted again rather than refused from history.
  const secondModel = stubModel([
    [toolCall('after-remedy', 'missing_owner_fixture', {})],
    [textMsg('tried again after the user remediated')],
  ]);
  const second = await productionHostRunRunner(
    throwingRunner() as never,
    { model: secondModel, tools: [fixtureTool()] } as never,
    [
      ...first.history,
      { type: 'message', role: 'user', content: 'it should be reconnected' },
    ] as never,
    { maxTurns: 6 },
  );
  assert.notEqual(
    second.finalOutput,
    HOST_CAPABILITY_UNAVAILABLE_TEXT,
    'a refusal earned before the user spoke must not pre-refuse the turn after it',
  );
  assert.equal(second.finalOutput, 'tried again after the user remediated');
  assert.ok(secondModel.calls() >= 2, 'the model must be reached, not short-circuited from history');
});

// ─── A dead read is not an uncertain write (live 2026-08-25) ─────────────────
//
// tool_search — local execution, declared non-mutating, ZERO crossings that
// left the machine — hit a TimeoutError and the turn terminated with "its
// effect must be reconciled before continuing", killing two workflow
// dispatches in a row. The invocation kernel's own durable settlement proves
// there is nothing to reconcile (non-mutating, transient-retryable, no bytes
// crossed out); classification now honors it and the model replans. The
// blocked side of the boundary is pinned by "a refused or failed plan
// barrier never starts its fused read" above: a settled failure whose
// directive is NOT transient-retryable still blocks, and an unbound local
// write never reaches invoke at all (refused pre-dispatch by admission).
test('a dead registered read replans instead of poisoning the turn', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const fixture = acceptHostCanarySource('read-timeout-replan');
    let invocations = 0;
    const readTool = brackets.wrapToolForHarness({
      type: 'function', name: 'task_list', description: 'host task read',
      parameters: { type: 'object', additionalProperties: true },
      needsApproval: async () => false,
      invoke: async () => {
        invocations += 1;
        const err = new Error('deadline elapsed');
        err.name = 'TimeoutError';
        throw err;
      },
    });
    const model = stubModel([
      [toolCall('read-timeout-1', 'task_list', {})],
      [textMsg('recovered')],
    ]);
    const agent = { model, tools: [readTool] };
    bindHostCanarySurface(fixture, agent, [readTool]);
    const outcome = await runProductionHost(fixture, agent);
    assert.equal(invocations, 1, 'the read actually entered invoke — this exercises the settlement path, not a pre-dispatch refusal');
    assert.equal(outcome.finalOutput, 'recovered',
      `the model replans instead of the turn dying: ${JSON.stringify(outcome.terminal ?? {})}`);
    assert.equal(model.calls(), 2);
    assert.deepEqual(dispositionMarkers(outcome.history), [{
      disposition: 'refused_pre_dispatch',
      effect: 'none',
      retry: 'replan',
      requiresReconciliation: false,
    }]);
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

// ─── The retirement terminal names what the host can measure ─────────────────
//
// Live 2026-08-25 (Discord "top 5 opportunities → sheet"): four minutes of
// discovery, then the bare "that exact capability is unavailable" — while the
// CLI auth-health store already knew the needed CLI was not signed in. Only
// host-declared facts may be echoed: registry tool names and host-measured
// health entries; a model-invented tool name is never repeated back.
test('capabilityUnavailableTextFor carries host-measured causes and never echoes foreign names', async () => {
  const healthPath = path.join(TMP_HOME, 'state', 'cli-auth-health.json');
  mkdirSync(path.dirname(healthPath), { recursive: true });
  writeFileSync(healthPath, JSON.stringify({
    version: 'v1',
    entries: {
      salesforce: {
        id: 'salesforce', command: 'sf', installed: true,
        authStatus: 'signed_out', checkedAt: '2026-08-25T09:22:32.497Z',
      },
      railway: {
        id: 'railway', command: 'railway', installed: true,
        authStatus: 'ok', username: 'nate', checkedAt: '2026-08-25T09:22:32.497Z',
      },
    },
  }), 'utf-8');
  const { capabilityUnavailableTextFor, HOST_CAPABILITY_UNAVAILABLE_TEXT } =
    await import('../runtime/harness/host-turn-runner.js').catch(() => import('./host-turn-runner.js'));
  const text = capabilityUnavailableTextFor([
    { name: 'call_tool', argumentsJson: JSON.stringify({ name: 'run_shell_command', args_json: JSON.stringify({ command: 'sf data query --query "SELECT..."' }) }) },
    { name: 'TOTALLY_MADE_UP_PROVIDER_TOOL', argumentsJson: '{}' },
  ]);
  assert.ok(text.startsWith(HOST_CAPABILITY_UNAVAILABLE_TEXT), 'the base terminal copy is preserved');
  assert.ok(text.includes('call_tool'), 'registry-declared names are echoed');
  assert.ok(!text.includes('TOTALLY_MADE_UP_PROVIDER_TOOL'), 'a model-invented name is never repeated back');
  assert.ok(text.includes('the sf CLI is signed out'), `the host-measured cause is named: ${text}`);
  assert.ok(!text.includes('railway'), 'a healthy CLI is not blamed');
  assert.ok(text.includes('Signing that CLI back in'), 'the terminal names the unblocking action');
});

test('a committed-write verification hold tells the exact truth and never asks to repeat the write', () => {
  const automatic = committedWriteVerificationHeldText([{
    ownerLogicalToolCallId: 'write-a',
    requirementId: 'author_workspace',
    effect: 'local_write',
    resultHandleId: 'result:space-save:a',
    status: 'pending',
    reason: 'transient verifier timeout',
    resourceId: 'local-llm-calendar',
    verifierLogicalCallId: 'verify-retry:1:abc',
    recoveryKind: 'automatic',
    verifierOnlyRetryable: true,
  }]);
  assert.match(automatic, /write is committed and will not be repeated/i);
  assert.match(automatic, /result:space-save:a/);
  assert.match(automatic, /Resource: local-llm-calendar/);
  assert.match(automatic, /Verifier: verify-retry:1:abc/);
  assert.match(automatic, /no user approval is required/i);
  assert.doesNotMatch(automatic, /effect[_ -]?unknown/i);
  assert.doesNotMatch(automatic, /retry (?:the )?write/i);

  const userAction = committedWriteVerificationHeldText([{
    ownerLogicalToolCallId: 'write-b',
    requirementId: 'publish_sheet',
    effect: 'external_write',
    resultHandleId: 'result:sheet:b',
    status: 'pending',
    reason: 'verifier requires recover_connection',
    resourceId: 'sheet-123',
    verifierLogicalCallId: 'verify:sheet:b',
    recoveryKind: 'user_action',
    verifierOnlyRetryable: false,
  }]);
  assert.match(userAction, /Reconnect or refresh the exact readback capability/);
  assert.match(userAction, /the write will not repeat/i);
  assert.doesNotMatch(userAction, /ask.*approval/i);
});

test('a write whose verifier holds is a scheduling barrier: no later sibling write starts', async () => {
  const entered: string[] = [];
  const attempts = await mapHostCallAttemptsWithBarriersInOrder(
    ['write-a', 'write-b'],
    2,
    () => 'barrier',
    async (call) => {
      entered.push(call);
      return {
        status: 'returned' as const,
        value: call === 'write-a'
          ? { call, committedVerificationHolds: ['held'] }
          : { call, committedVerificationHolds: [] },
        invocationEntered: true,
      };
    },
    (result) => result.committedVerificationHolds.length > 0,
  );
  assert.deepEqual(entered, ['write-a']);
  assert.equal(attempts[0]?.status, 'returned');
  assert.equal(attempts[1], undefined,
    'write B has no invocation attempt after write A commits but its verifier holds');
});

/** One configured generic carrier whose body must never replace the exact
 * production port, plus an EMPTY frozen catalog: every provider call misses
 * at the catalog binding. */
function installEmptyProductionCatalogWithCarrier() {
  const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
  productionPorts.clearProductionCapabilityPorts();
  let outerBodies = 0;
  const carrier = brackets.wrapToolForHarness({
    type: 'function',
    name: 'call_tool',
    description: 'Invoke one exact schema acquired from the frozen capability catalog.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        args_json: { type: 'string' },
      },
      required: ['name', 'args_json'],
    },
    needsApproval: async () => false,
    invoke: async () => {
      outerBodies += 1;
      throw new Error('the generic carrier body must not replace the exact production port');
    },
  });
  return { carrier, outerBodies: () => outerBodies };
}

test('production host stops and names a literally scoped operation the catalog never froze as a host fault (G2)', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const priorPorts = productionPorts.listProductionCapabilityPorts();
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const fixture = acceptHostCanarySource('literal-operation-not-frozen');
    // Opaque: not a provider slug, only shaped like one. The accepted source
    // (a workflow step) names it; provisioning never froze it.
    const operationId = 'NIGHT_OPAQUE_FETCH_ROWS';
    const { carrier, outerBodies } = installEmptyProductionCatalogWithCarrier();
    const model = stubModel([
      [toolCall('literal-op-call', 'call_tool', {
        name: operationId,
        args_json: JSON.stringify({ limit: 1 }),
      })],
      [textMsg('must not be asked to repair a host provisioning fault')],
    ]);
    const agent = { model, tools: [carrier] };
    bindHostCanarySurface(fixture, agent, [carrier]);

    const outcome = await catalogScope.withAcceptedSourceCatalogManifestScope(
      { manifestIds: ['cap:night:opaque-fetch-rows'], operationIds: [operationId] },
      () => runProductionHost(fixture, agent),
    );

    assert.deepEqual(outcome.terminal, {
      status: 'blocked',
      reason: literalOperationNotFrozenReason(operationId),
      resumable: false,
    });
    assert.equal(outcome.terminal?.reason, `literal_workflow_operation_not_frozen:${operationId}`);
    assert.equal(model.calls(), 1, 'a host fault stops before the model is asked to repair it');
    assert.match(String(outcome.finalOutput), new RegExp(operationId),
      'the user is told which operation the host could not provision');
    assert.doesNotMatch(String(outcome.finalOutput), /internal host error|choose another capability/);
    const history = JSON.stringify(outcome.history);
    assert.match(history, /host provisioning fault/);
    assert.match(history, new RegExp(`Failed check: literal_workflow_operation_not_frozen:${operationId}`));
    assert.doesNotMatch(history, /capability, effect, account, schema, or invoke binding is absent or changed/,
      'the generic binding refusal (a model repair instruction) is not what the record carries');
    assert.equal(outerBodies(), 0);
    assert.equal((eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0);
  } finally {
    productionPorts.clearProductionCapabilityPorts();
    for (const prior of priorPorts) {
      productionPorts.registerFixtureCapabilityPort(prior.identity, prior.port);
    }
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('the last refusal check survives a text-only give-up frame after the refused tool frame (say why)', async () => {
  // Live 2026-09-01: two refused write frames, then the model answered in
  // text; the terminal persisted only the governor stage because the trailing
  // history item was not a tool result. The most recent TOOL frame is the
  // cause; a later frame that dispatched cleanly still hides older refusals.
  const { lastHostRefusalDetail } = await import('./host-turn-runner.js');
  const { buildHostToolDispositionResult } = await import('./host-model-result-receipt.js');
  const refused = buildHostToolDispositionResult({
    callId: 'call-write',
    toolName: 'composio_execute_tool',
    disposition: 'refused_pre_dispatch',
    frameDigest: 'c'.repeat(64),
    frameIndex: 0,
    frameSize: 1,
    countsRefusal: true,
    diagnostic: "Tool 'composio_execute_tool' was refused before dispatch because its exact capability, effect, account, schema, or invoke binding is absent or changed. Failed check: workflow_plan_scope_missing_or_changed. No local or external mutation was attempted.",
  });
  const call = { type: 'function_call' as const, callId: 'call-write', name: 'composio_execute_tool', arguments: '{}' };
  const giveUp = { type: 'message' as const, role: 'assistant' as const, status: 'completed' as const, content: [{ type: 'output_text' as const, text: 'I could not complete the write.' }] };
  assert.equal(
    lastHostRefusalDetail([call, refused, giveUp] as never),
    'workflow_plan_scope_missing_or_changed',
  );
  const clean = { type: 'function_call_result' as const, callId: 'call-read', name: 'file_query', status: 'completed' as const, output: { type: 'text' as const, text: 'ok' } };
  const readCall = { type: 'function_call' as const, callId: 'call-read', name: 'file_query', arguments: '{}' };
  assert.equal(lastHostRefusalDetail([call, refused, readCall, clean, giveUp] as never), undefined, 'a later clean frame hides the older refusal');
});

test('a no-progress terminal carries the current typed stage as bounded blockedDetail', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const priorPorts = productionPorts.listProductionCapabilityPorts();
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const fixture = acceptHostCanarySource('no-progress-blocked-detail');
    // Not scoped by any accepted source: an ordinary catalog miss the model
    // repeats verbatim until the governor terminalizes (live 2026-08-31 shape).
    const operationId = 'NIGHT_OPAQUE_LIST_ROWS';
    const { carrier, outerBodies } = installEmptyProductionCatalogWithCarrier();
    const sameCall = (callId: string) => toolCall(callId, 'call_tool', {
      name: operationId,
      args_json: JSON.stringify({ limit: 1 }),
    });
    const model = stubModel([
      [sameCall('catalog-miss-1')],
      [sameCall('catalog-miss-2')],
      [sameCall('catalog-miss-3')],
      [sameCall('catalog-miss-4')],
      [textMsg('must not outrun the no-progress governor')],
    ]);
    const agent = { model, tools: [carrier] };
    bindHostCanarySurface(fixture, agent, [carrier]);

    const outcome = await runProductionHostSteps(fixture, agent, 10);

    assert.equal(outcome.terminal?.status, 'blocked');
    assert.equal(outcome.terminal?.reason, 'control_no_progress_exhausted');
    assert.notEqual(outcome.terminal?.resumable, false);
    assert.equal(model.calls(), 2, 'a repeated typed refusal publishes without another model call');
    assert.equal(
      hostBlockedTerminalDetail(outcome),
      'host_disposition:refused_pre_dispatch',
    );
    assert.match(String(outcome.finalOutput), /Stopped at: host_disposition:refused_pre_dispatch\.\nNext:/);
    assert.ok((hostBlockedTerminalDetail(outcome) ?? '').length <= 160);
    assert.equal(outerBodies(), 0);
  } finally {
    productionPorts.clearProductionCapabilityPorts();
    for (const prior of priorPorts) {
      productionPorts.registerFixtureCapabilityPort(prior.identity, prior.port);
    }
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

test('a done claim after the host refused this source\'s only work before dispatch is held, never delivered (delivery truth)', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const priorPorts = productionPorts.listProductionCapabilityPorts();
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const fixture = acceptHostCanarySource('refused-work-done-claim');
    const { carrier, outerBodies } = installEmptyProductionCatalogWithCarrier();
    const model = stubModel([
      [toolCall('refused-work-call', 'call_tool', {
        name: 'NIGHT_OPAQUE_LIST_EVENTS',
        args_json: JSON.stringify({ limit: 1 }),
      })],
      [textMsg('Your calendar is ready.')],
    ]);
    const agent = { model, tools: [carrier] };
    bindHostCanarySurface(fixture, agent, [carrier]);
    await runProductionHost(fixture, agent);
    const db = eventlog.openEventLog();
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM host_model_result_receipts
       WHERE session_id = ? AND source_user_seq = ? AND disposition = 'refused_pre_dispatch'
    `).get(fixture.session.id, fixture.source.seq) as { n: number }).n >= 1, true,
    'the refusal is a durable host receipt for this source');
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ?
    `).get(fixture.session.id, fixture.source.seq) as { n: number }).n, 0);
    assert.equal(outerBodies(), 0);

    // The model's claim, reduced as a completed turn with no contract and no
    // manifest — the exact shape that was stamped delivered:true live.
    const identity = { sessionId: fixture.session.id, turn: 1, sourceUserSeq: fixture.source.seq } as const;
    const committed = commitTurnOutcome({
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'done',
      resumable: false,
      presentation: { kind: 'answer', text: 'Your calendar is ready.' },
    });
    assert.equal(committed.presentation.status, 'blocked', JSON.stringify(committed.event.data));
    assert.equal(committed.event.data.delivered, false);
    assert.equal(committed.event.data.reason, 'verification_required');
    assert.deepEqual(committed.event.data.verificationMissing, ['work_refused_without_business_evidence']);
    assert.equal(committed.presentation.text.startsWith('Your calendar is ready.'), true,
      'the model\'s own words are held, never rewritten by the committer');
  } finally {
    productionPorts.clearProductionCapabilityPorts();
    for (const prior of priorPorts) {
      productionPorts.registerFixtureCapabilityPort(prior.identity, prior.port);
    }
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

// ── JIT READ EDGE (gate 2/10 class) ───────────────────────────────────────────
// Live 2026-09-01: platform-49 needed the numeric sheet_id for a required
// nested write field and called the spreadsheet-info READ the workflow never
// names. The frozen snapshot had no candidate, nothing had proven it, and the
// host refused it twice → no-progress terminal. The host holds the exact
// provider definition: a carried READ absent from the snapshot is provisioned
// once and dispatched through the proven-live-read path; a carried WRITE is
// provisioned the same way but stays behind the frozen/authored bar.
test('a carried provider READ absent from the frozen snapshot is provisioned once and dispatched; a WRITE stays refused', async (t) => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const priorPorts = productionPorts.listProductionCapabilityPorts();
  process.env.HARNESS_TOOL_BRACKETS = 'on';

  const runVariant = async (input: { label: string; effect: 'read' | 'external_write'; shouldExecute: boolean }) => {
    const fixture = acceptHostCanarySource(`jit-read-${input.label}`);
    const operationId = `market_${input.label}__lookup_sheet_info`;
    const manifest = capabilityManifests.attachSemanticContract({
      version: 1,
      manifestId: `cap:${input.label}:sheet-info`,
      providerKind: 'native_mcp',
      operationId,
      providerIdentity: `configured-market-directory:${input.label}`,
      providerVersion: '2026-09-01',
      operationVersion: '1',
      definitionFingerprint: 'c'.repeat(64),
      effect: input.effect,
      accountId: `account:${input.label}:primary`,
      idempotency: { required: false, policy: 'none' },
      reconciliation: { supported: false, policy: 'none' },
      outputContract: { kind: input.effect === 'read' ? 'sheet_records' : 'created_resource' },
      evidenceContract: { kinds: ['receipt'], readbackRequired: false },
      provenance: { issuer: 'host-turn-runner:test', issuedAt: '2026-09-01T00:00:00.000Z', trusted: true },
      lifecycle: { state: 'current' },
      advisoryRoles: ['lookup'],
    });
    let portBodies = 0;
    const portInvoke = async () => {
      portBodies += 1;
      return { kind: 'clementine.external-read.result', version: 1, records: [{ sheetId: 7 }] };
    };
    // The frozen surface holds NOTHING for this operation: an empty factory.
    const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
    capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
    productionPorts.clearProductionCapabilityPorts();
    assert.deepEqual(productionPorts.registerFixtureCapabilityPort(
      productionPorts.productionPortIdentityFromManifest(manifest),
      { invoke: portInvoke as never },
    ), { ok: true });
    const provisionCalls: string[][] = [];
    _setHostJitReadProvisionerForTests(async (request) => {
      provisionCalls.push([...request.operationIds]);
      assert.equal(request.sessionId, fixture.session.id);
      assert.equal(request.sourceUserSeq, fixture.source.seq);
      assert.ok(request.deadlineAt > Date.now());
      // The real provisioner revalidates the provider definition and registers
      // the exact proof-provisioned capability; the fixture registers the same
      // direct shape into the installed factory.
      factory.register({
        capabilityId: manifest.manifestId,
        toolName: manifest.operationId,
        schemaVersion: manifest.operationVersion,
        schemaDigest: manifest.definitionFingerprint,
        effect: manifest.effect,
        account: manifest.accountId,
        manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
        providerKind: manifest.providerKind,
        liveFingerprint: manifest.definitionFingerprint,
        manifest,
        invoke: portInvoke as never,
      });
      return { ok: true } as const;
    });
    try {
      const carrier = brackets.wrapToolForHarness({
        type: 'function',
        name: 'call_tool',
        description: 'Invoke one exact schema acquired from the frozen capability catalog.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' }, args_json: { type: 'string' } },
          required: ['name', 'args_json'],
        },
        needsApproval: async () => false,
        invoke: async () => { throw new Error('the generic carrier body must not replace the exact production port'); },
      });
      const model = stubModel([
        [toolCall(`${input.label}-jit-call`, 'call_tool', { name: operationId, args_json: JSON.stringify({ spreadsheet: 'sheet-1' }) })],
        [toolCall(`${input.label}-jit-call-again`, 'call_tool', { name: operationId, args_json: JSON.stringify({ spreadsheet: 'sheet-1' }) })],
        [textMsg(`${input.label} settled`)],
      ]);
      const agent = { model, tools: [carrier] };
      bindHostCanarySurface(fixture, agent, [carrier]);
      const outcome = await runProductionHost(fixture, agent);
      const db = eventlog.openEventLog();
      const physical = (db.prepare(`
        SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ?
      `).get(fixture.session.id, fixture.source.seq) as { n: number }).n;
      assert.equal(provisionCalls.length, 1, `exactly one JIT provisioning attempt per operation per turn; history: ${
        JSON.stringify(outcome.history).match(/Failed check: [^."]*/)?.[0] ?? JSON.stringify(outcome.history).slice(0, 1200)
      }`);
      assert.deepEqual(provisionCalls[0], [operationId]);
      if (input.shouldExecute) {
        assert.equal(portBodies >= 1, true, JSON.stringify({ terminal: outcome.terminal, history: outcome.history }).slice(0, 2000));
        assert.equal(physical >= 1, true);
        assert.doesNotMatch(JSON.stringify(outcome.history), /catalog_entry_or_manifest_missing/);
      } else {
        assert.equal(portBodies, 0, 'a JIT-provisioned WRITE never crosses: the frozen/authored bar holds');
        assert.equal(physical, 0);
        assert.match(JSON.stringify(outcome.history), /catalog_entry_or_manifest_missing/);
      }
    } finally {
      _setHostJitReadProvisionerForTests(null);
    }
  };

  try {
    await t.test('carried READ: provisioned once, dispatched through the proven-live-read path', () => runVariant({
      label: 'read', effect: 'read', shouldExecute: true,
    }));
    await t.test('carried WRITE: provisioned once, still refused pre-dispatch', () => runVariant({
      label: 'write', effect: 'external_write', shouldExecute: false,
    }));
  } finally {
    productionPorts.clearProductionCapabilityPorts();
    for (const prior of priorPorts) {
      productionPorts.registerFixtureCapabilityPort(prior.identity, prior.port);
    }
    capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

// --- a bare CONTINUE: marker keeps the same host turn open (live 2026-09-01) ---
function runProductionHostSteps(
  fixture: ReturnType<typeof acceptHostCanarySource>,
  agent: Record<string, unknown>,
  maxTurns: number,
) {
  return brackets.withHarnessRunContext(fixture.parent, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: fixture.source.data.text }] as never,
    { maxTurns, hostTurnEngine: 'host_v1', context: fixture.context } as never,
  ));
}

test('production host keeps the turn open for a CONTINUE marker and runs the promised call', async () => {
  const fixture = acceptHostCanarySource('continue-marker');
  let toolRuns = 0;
  const ping = {
    type: 'function' as const, name: 'ping', description: 'test', parameters: { type: 'object', properties: {} },
    invoke: async () => { toolRuns += 1; return 'pong'; },
    needsApproval: async () => false,
  };
  const model = stubModel([
    [textMsg('CONTINUE: capability resolution complete, ready to call the tool next turn')],
    [toolCall('promised-call', 'ping', {})],
    [textMsg('wrote it')],
  ]);
  const agent = { model, tools: [ping] };
  bindHostCanarySurface(fixture, agent, [ping]);
  const outcome = await runProductionHostSteps(fixture, agent, 8);
  assert.equal(outcome.finalOutput, 'wrote it');
  const attempted = outcome.history.filter((item) => (item as { type?: string }).type === 'function_call') as Array<{ callId?: string }>;
  assert.deepEqual(attempted.map((item) => item.callId), ['promised-call'], 'the promised call was made in the SAME turn');
  assert.ok(toolRuns <= 1, 'the fixture tool has no durable owner here; the host may pair a no-effect refusal instead of running the body');
  assert.equal(model.calls(), 3);
  assert.equal(
    outcome.history.some((item) => JSON.stringify(item).includes('CONTINUE HONORED')),
    false,
    'the directive is a one-shot request layer, never canonical history',
  );
});

test('production host bounds CONTINUE markers and then stops typed, resumable, with the note as detail — never the note as the answer', async () => {
  const { MAX_HOST_CONTINUE_MARKER_CONTINUATIONS } = await import('./host-turn-runner.js');
  const fixture = acceptHostCanarySource('continue-marker-budget');
  // The first marker beyond the budget publishes retained state immediately.
  const frames = Array.from({ length: MAX_HOST_CONTINUE_MARKER_CONTINUATIONS + 2 }, (_, index) => (
    [textMsg(`CONTINUE: still going ${index}`)]
  ));
  const model = stubModel(frames);
  const agent = { model, tools: [] };
  bindHostCanarySurface(fixture, agent, []);
  const outcome = await runProductionHostSteps(fixture, agent, 10);
  assert.equal(model.calls(), MAX_HOST_CONTINUE_MARKER_CONTINUATIONS + 1, 'exhaustion publishes without a last-word model call');
  assert.equal(outcome.terminal?.status, 'blocked');
  assert.equal(outcome.terminal?.reason, 'continue_marker_exhausted');
  assert.notEqual(outcome.terminal?.resumable, false, 'resumable: "continue" re-enters');
  assert.match(String((outcome as { blockedDetail?: string }).blockedDetail ?? ''), /still going/);
  assert.match(String(outcome.finalOutput), /without making the call/);
  assert.doesNotMatch(String(outcome.finalOutput), /^CONTINUE:/);
});


test('JIT read edge: a reviewed-CLI identity is recognised by shape, never a provider slug', async () => {
  const { isReviewedLiveReadIdentity } = await import('./host-turn-runner.js');
  // 2026-09-01: the Composio materializer uppercased salesforce_sf_soql_query
  // into a slug that does not exist and the chat Salesforce read dead-ended.
  assert.equal(isReviewedLiveReadIdentity('salesforce_sf_soql_query'), true);
  assert.equal(isReviewedLiveReadIdentity('gh_pr_list'), true);
  assert.equal(isReviewedLiveReadIdentity('GOOGLESHEETS_BATCH_GET'), false);
  assert.equal(isReviewedLiveReadIdentity('SLACK_FETCH_CONVERSATION_HISTORY'), false);
  assert.equal(isReviewedLiveReadIdentity('call_tool'), true, 'bare snake_case names are the live-read shape; the catalog check decides');
  assert.equal(isReviewedLiveReadIdentity('tool_search'), true);
  assert.equal(isReviewedLiveReadIdentity('composio'), false, 'a single word is neither');
  assert.equal(isReviewedLiveReadIdentity('Mixed_Case'), false);
});


// --- completion judge on the host lane (2026-09-01) ---
function scriptedRecordingModel(responses: unknown[][]) {
  let call = 0;
  const requests: unknown[] = [];
  return {
    calls: () => call,
    requests,
    async getResponse(request: unknown) {
      requests.push(request);
      const output = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output,
        responseId: `judged-resp-${call}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
}

/** A real accepted source whose text is the request the judge measures against. */
function acceptJudgedSource(label: string, text: string) {
  const session = eventlog.createSession({ id: `host-judged-${++acceptedSerial}-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text },
  });
  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  };
  return { session, source, parent, context: { sessionId: session.id, sourceUserSeq: source.seq } };
}

function runJudgedHost(
  fixture: ReturnType<typeof acceptJudgedSource>,
  agent: Record<string, unknown>,
  judgeCompletion: boolean,
) {
  return brackets.withHarnessRunContext(fixture.parent, () => productionHostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: fixture.source.data.text }] as never,
    { maxTurns: 6, hostTurnEngine: 'host_v1', context: fixture.context, hostJudgeCompletion: judgeCompletion } as never,
  ));
}

test('production host runs the completion judge on a completion claim with no tool evidence and keeps working when it says NOT DONE (directive never in history)', async () => {
  const { _setHostObjectiveJudgeForTests } = await import('./host-turn-runner.js');
  const verdicts = [
    { done: false, reason: 'nothing was posted: no tool ran and no link is shown' },
    { done: true, reason: 'the reply names the concrete blocker and hands over the draft' },
  ];
  const judged: Array<{ objective: string; reply: string }> = [];
  _setHostObjectiveJudgeForTests(async (objective, reply) => {
    judged.push({ objective, reply });
    return verdicts.shift() ?? { done: true, reason: 'ok' };
  });
  try {
    const fixture = acceptJudgedSource('judge-continue', 'Post the summary to the channel');
    const model = scriptedRecordingModel([
      [textMsg('Done: posted the summary to the channel.')],   // a claim with zero evidence — the silent-success shape
      [textMsg('I could not post it: no channel tool is available in this session. Here is the summary text to paste.')],
    ]);
    const agent = { model, tools: [] };
    bindHostCanarySurface(fixture, agent, []);
    const outcome = await runJudgedHost(fixture, agent, true);
    assert.match(String(outcome.finalOutput), /could not post it/, 'the judged claim was replaced by an honest, evidenced reply');
    assert.equal(model.calls(), 2);
    assert.equal(judged.length, 2, 'both candidate replies were judged');
    assert.match(judged[0]!.objective, /Post the summary to the channel/);
    assert.match(judged[0]!.reply, /posted the summary/);
    const second = JSON.stringify(model.requests[1]);
    assert.match(second, /COMPLETION JUDGE/, 'the NOT DONE verdict reached the model as a directive');
    assert.match(second, /nothing was posted/);
    assert.equal(JSON.stringify(outcome.history).includes('COMPLETION JUDGE'), false, 'the directive is a one-shot request layer, never canonical history');
    assert.match(JSON.stringify(outcome.history), /Done: posted the summary/, 'the judged claim stays in history so the model sees what it said');
    const judgedEvents = eventlog.listEvents(fixture.session.id, { types: ['goal_alignment_judged'] });
    assert.equal(judgedEvents.length, 2, 'each verdict is durable');
    assert.equal(judgedEvents[0]!.data.fulfills, false);
    assert.equal(judgedEvents[0]!.data.continuation, true);
    assert.equal(judgedEvents[1]!.data.fulfills, true);
  } finally {
    _setHostObjectiveJudgeForTests(null);
  }
});

test('the completion judge is bounded: after MAX continuations the reply stands; it never runs without opt-in or on a non-action ask', async () => {
  const { _setHostObjectiveJudgeForTests, MAX_HOST_OBJECTIVE_JUDGE_CONTINUATIONS } = await import('./host-turn-runner.js');
  let judgeCalls = 0;
  _setHostObjectiveJudgeForTests(async () => { judgeCalls += 1; return { done: false, reason: 'still nothing posted' }; });
  try {
    const stubbornFixture = acceptJudgedSource('judge-bounded', 'Post the summary to the channel');
    const stubbornAgent = { model: stubModel([[textMsg('Done: posted the summary to the channel.')]]), tools: [] };
    bindHostCanarySurface(stubbornFixture, stubbornAgent, []);
    const stubborn = await runJudgedHost(stubbornFixture, stubbornAgent, true);
    assert.equal(stubborn.finalOutput, 'Done: posted the summary to the channel.');
    assert.equal(judgeCalls, MAX_HOST_OBJECTIVE_JUDGE_CONTINUATIONS, 'bounded continuations, then the reply stands');

    judgeCalls = 0;
    const noOptInFixture = acceptJudgedSource('judge-no-opt-in', 'Post the summary to the channel');
    const noOptInAgent = { model: stubModel([[textMsg('Done: posted the summary to the channel.')]]), tools: [] };
    bindHostCanarySurface(noOptInFixture, noOptInAgent, []);
    const noOptIn = await runJudgedHost(noOptInFixture, noOptInAgent, false);
    assert.equal(noOptIn.finalOutput, 'Done: posted the summary to the channel.');
    assert.equal(judgeCalls, 0, 'no opt-in (workflow/cron surfaces): never judged');

    const questionFixture = acceptJudgedSource('judge-question', 'What is the capital of France?');
    const questionAgent = { model: stubModel([[textMsg('Paris.')]]), tools: [] };
    bindHostCanarySurface(questionFixture, questionAgent, []);
    const question = await runJudgedHost(questionFixture, questionAgent, true);
    assert.equal(question.finalOutput, 'Paris.');
    assert.equal(judgeCalls, 0, 'a question is conversation, not an unverified work claim');
  } finally {
    _setHostObjectiveJudgeForTests(null);
  }
});


test('a refused call frame tells the model the real defect and the exact repair shape, keeping the stage token the governor keys on', async () => {
  const { hostFrameRefusalDirective } = await import('./host-turn-runner.js');
  const malformed = hostFrameRefusalDirective('host_work_call_inner_operation_unidentified');
  assert.match(malformed, /before dispatch \(host_work_call_inner_operation_unidentified\)/, 'the projection parses the stage from this token');
  // The exact carrier is shown as the model must emit it: args_json is a JSON
  // STRING, so its inner quotes are escaped in the example.
  assert.ok(malformed.includes('\\"tool_slug\\":\\"<slug>\\"'), malformed);
  assert.match(malformed, /ONE JSON string/);
  const planBound = hostFrameRefusalDirective('host_planned_work_call_requires_plan_sibling');
  assert.match(planBound, /not the configured proposal-free work_call carrier/);
  assert.match(planBound, /copy its literal carrier example/);
  assert.match(planBound, /cannot inherit the configured tool's host provenance/);
  // A refusal is a DOOR, not a category (2026-09-02): with the turn's proof in
  // hand it names the proven reads the model may call without a plan, the
  // exact carrier, and the operation it could not prove.
  const withProof = hostFrameRefusalDirective('host_planned_work_call_requires_plan_sibling', {
    provenReads: ['GOOGLESHEETS_BATCH_GET', 'SLACK_FETCH_CONVERSATION_HISTORY'],
    offendingOperation: 'googlesheets.batch_get',
  });
  assert.match(withProof, /before dispatch \(host_planned_work_call_requires_plan_sibling\)/, 'the stage token survives');
  assert.match(withProof, /could not prove "googlesheets\.batch_get" as a read/);
  assert.doesNotMatch(withProof, /PROVEN READS this turn/,
    'a known write refusal must not send the model sideways into unrelated reads');
  assert.match(withProof, /not the configured proposal-free work_call carrier/);
  assert.equal(
    hostFrameRefusalDirective('host_control_requires_sole_call_frame'),
    'The host refused this exact call frame before dispatch (host_control_requires_sole_call_frame). No tool body was entered.',
  );
});

// A held checkpoint is an INVITATION to come back for this exact frame, and
// three separate entry points accept it: the 15 s scanner, the runner's own
// immediate re-entry in loop.ts, and the legacy approval-resume path. When the
// admission can never succeed again the invitation never converges — live
// 2026-09-01/09-02: 1,054, 1,006 and 454 re-entries under a budget of 5,
// because the budget counted one caller's DISPATCH instead of the failure.
test('a permanently unadmittable frame spends one shared budget and stops with a typed terminal', async () => {
  const {
    EXACT_CHECKPOINT_REENTRY_BUDGET,
    exactCheckpointFrameCallIds,
    exactCheckpointReentryExhausted,
    exactCheckpointReentryKey,
    _resetExactCheckpointReentriesForTests,
  } = await import('./exact-checkpoint-reentry.js');
  _resetExactCheckpointReentriesForTests();

  const fixture = acceptHostCanarySource('checkpoint-admission-exhausted');
  let bodies = 0;
  const configured = {
    type: 'function',
    name: 'stuck_frame_fixture',
    description: 'admission boundary fixture',
    parameters: { type: 'object', properties: {} },
    needsApproval: async () => false,
    invoke: async () => { bodies += 1; return 'must not run'; },
  };
  // One clamped response: every attempt re-emits the byte-identical frame, so
  // every attempt derives the same re-entry key.
  const model = stubModel([[toolCall('stuck-frame-call', 'stuck_frame_fixture', {})]]);
  const agent = { model, tools: [configured] };
  bindHostCanarySurface(fixture, agent, [configured]);

  const db = eventlog.openEventLog();
  const trigger = `reject_batch_admission_${fixture.session.id.replace(/[^A-Za-z0-9]/gu, '_')}`;
  const sessionId = fixture.session.id.replaceAll("'", "''");
  db.exec(`
    CREATE TEMP TRIGGER ${trigger}
    BEFORE INSERT ON accepted_model_batch_admissions
    WHEN NEW.session_id = '${sessionId}'
    BEGIN
      SELECT RAISE(ABORT, 'fixture admission unavailable');
    END
  `);
  const outcomes: Array<Awaited<ReturnType<typeof runProductionHost>>> = [];
  try {
    for (let attempt = 0; attempt < EXACT_CHECKPOINT_REENTRY_BUDGET; attempt += 1) {
      outcomes.push(await runProductionHost(fixture, agent));
    }
  } finally {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }

  // Within budget the frame stays privately owned: a hold, a durable recovery
  // state, no public terminal. That behavior is deliberate and must not change.
  for (const [index, outcome] of outcomes.slice(0, -1).entries()) {
    assert.equal(outcome.terminal, undefined, `attempt ${index + 1} authored a terminal too early`);
    assert.deepEqual(outcome.hold, { owner: 'host', wake: 'recovery', reason: 'recovery_pending' });
    assert.ok(outcome.serializedRecoveryState, `attempt ${index + 1} dropped its recovery state`);
  }

  // The last attempt is the next edge: a typed terminal, and NO recovery state
  // — loop.ts re-enters only `outcome.hold && outcome.serializedRecoveryState`,
  // so the immediate re-entry and the scanner both stop here.
  const final = outcomes.at(-1)!;
  assert.equal(final.terminal?.status, 'blocked');
  assert.equal(final.terminal?.reason, 'exact_checkpoint_admission_exhausted');
  assert.equal(final.hold, undefined, 'an exhausted checkpoint must not invite another re-entry');
  assert.equal(final.serializedRecoveryState, undefined);
  assert.ok(
    typeof final.finalOutput === 'string' && final.finalOutput.length > 0,
    'the user is told the task stopped',
  );
  assert.equal(bodies, 0, 'no tool body ran while admission was failing');

  // Convergence: the budget the RUNNER spent is the exact budget the 15 s
  // scanner reads. It rebuilds the key from the serialized blob, so derive it
  // that way here — if the two derivations ever drift, the budget silently
  // stops binding and the storm returns.
  const blob = JSON.parse(outcomes[0]!.serializedRecoveryState!) as Record<string, unknown>;
  assert.equal(blob.__clemHostRecovery, 1);
  const scannerKey = exactCheckpointReentryKey(fixture.session.id, {
    sourceUserSeq: Number(blob.sourceUserSeq),
    phase: String(blob.phase),
    frameCallIds: exactCheckpointFrameCallIds(blob.frameHistory),
  });
  assert.deepEqual(exactCheckpointFrameCallIds(blob.frameHistory), ['stuck-frame-call']);
  assert.equal(
    exactCheckpointReentryExhausted(scannerKey),
    true,
    'the scanner must see the budget the runner spent, under its own key derivation',
  );
  _resetExactCheckpointReentriesForTests();
});

// Live 2026-09-03, platform-49 run 6 (Sonnet 5): the model finished its reads,
// answered in prose, and the host committed delivered:false with its own copy
// ("I got stuck: I hit the same wall twice in a row") — she was never told what
// the recovery contract actually required. Publishing her prose instead is NOT
// the fix: in this state the prose IS an ask, and publishing it manufactures an
// ungated question the user answers, restarting the loop (pinned by
// host-no-progress-governor.integration.test.ts). She gets told once instead.
test('ask_user recovery rejects noncanonical prose with a resumable typed stop and no extra model call', async () => {
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const fixture = acceptHostCanarySource('governor-terminal-offers-last-word');
    const accountChoices = ['work@corp.example', 'personal@example.net'];
    const planTool = brackets.wrapToolForHarness({
      type: 'function',
      name: 'plan_task',
      description: 'Admit the model-authored plan.',
      parameters: { type: 'object', additionalProperties: true },
      needsApproval: async () => false,
      invoke: async () => JSON.stringify({
        ok: false,
        code: 'account_selection_required',
        detail: 'Outlook Send Email is the matching write; ask which connected account to use.',
        question: 'Which connected account should I use?',
        accountChoices,
        repair: 'Ask the user which exact connected account to use. Do not pick a substitute write.',
      }),
    });
    const questionTool = brackets.wrapToolForHarness(buildAskUserQuestionTool() as never);

    const directives: string[] = [];
    let modelCalls = 0;
    const model = {
      calls: () => modelCalls,
      async getResponse(request: { input?: unknown; instructions?: unknown }) {
        modelCalls += 1;
        directives.push(JSON.stringify(request.input ?? '') + String(request.instructions ?? ''));
        if (modelCalls === 1) {
          return {
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
            output: [toolCall('account-plan', 'plan_task', fusedPlanArgs('external_write'))],
            responseId: `offers-last-word-${modelCalls}`,
          };
        }
        // Prose cannot replace the canonical ask; the host publishes its stop.
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: [textMsg('Tell me whatever account details you have and ask me to continue.')],
          responseId: `offers-last-word-${modelCalls}`,
        };
      },
      getStreamedResponse: testModelStream,
    };
    const tools = [planTool, questionTool];
    const agent = { model, tools, toolUseBehavior: userChoiceToolUseBehavior };
    bindHostCanarySurface(fixture, agent, tools);

    const outcome = await runProductionHostSteps(fixture, agent, 6);

    // The causal repair names the canonical ask; no extra last-word turn runs.
    const lastWord = eventlog.listEvents(fixture.session.id, { types: ['guardrail_tripped'] })
      .filter((event) => event.data.kind === 'last_word_turn');
    assert.equal(lastWord.length, 0, 'no extra last-word turn is offered');
    assert.equal(model.calls(), 2);
    assert.ok(
      directives.some((seen) => seen.includes('Use ask_user_question once')),
      'the directive must name the exact call the state requires',
    );

    // The invariant still holds: ask-shaped prose is never published, and no
    // user-input authority is minted from it.
    assert.equal(outcome.terminal?.reason, 'control_no_progress_exhausted');
    assert.notEqual(outcome.terminal?.resumable, false);
    assert.equal(
      eventlog.listEvents(fixture.session.id, { types: ['awaiting_user_input'] }).length,
      0,
      'prose must not mint user-input authority',
    );
    assert.notEqual(
      String(outcome.finalOutput),
      'Tell me whatever account details you have and ask me to continue.',
      'an ungated ask must never become the published reply',
    );
  } finally {
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
});

// A CARRIED CONTROL IS THAT CONTROL — it used to sit in the fused-refusal
// fixtures above, asserting the plan body must NOT run. The policy computed the
// effective identity and then refused the frame over its envelope, discarding a
// plan it had already understood; three live runs on 2026-09-03 died there
// carrying a correct plan body. It now runs.
//
// SEAM, recorded rather than hidden: the nested path does not emit its own
// durable settlement for a control, so the host settles the non-mutating result
// and warns ("nested-owned local control returned without its own durable
// settlement"). That is benign for a control — nothing mutates — but a direct
// call and a carried call do not settle identically, and that difference is
// worth closing rather than forgetting.
test('a carried control executes instead of being replanned', async (t) => {
  const { classifyHostModelFrame } = await import('./host-model-frame-policy.js');
  const result = classifyHostModelFrame({
    calls: [{
      callId: 'carried-plan',
      name: 'work_call',
      effectiveName: 'plan_task',
      effect: 'compute',
      proposalFreeWorkCarrier: false,
    } as never],
    planActivated: false,
    allowFreshPlanReadFusion: true,
  });
  t.diagnostic(`carried control disposition: ${result.kind}`);
  assert.notEqual(result.kind, 'refused');
});

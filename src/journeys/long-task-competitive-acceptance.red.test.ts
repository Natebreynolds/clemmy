/**
 * Run:
 *   node scripts/run-tests-isolated.mjs src/journeys/long-task-competitive-acceptance.red.test.ts
 *
 * Competitive long-task release gates.  These tests deliberately exercise
 * production exports with local model/provider boundaries; they do not patch
 * production behavior.  A RED names a missing runtime seam, not an acceptable
 * baseline to encode as a todo.
 */
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import type { AgentInputItem } from '@openai/agents';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-long-task-acceptance-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_AUTO_COMPACT = 'layer1_only';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
delete process.env.OPENAI_API_KEY;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-long-task-acceptance\n', 'utf8');

const { RunContext } = await import('@openai/agents');
const eventlog = await import('../runtime/harness/eventlog.js');
const graphShadow = await import('../runtime/graph/turn-graph-shadow.js');
const expectedWork = await import('../runtime/harness/expected-work-admission.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const resultHandles = await import('../runtime/harness/result-handle.js');
const compaction = await import('../runtime/harness/compaction.js');
const brackets = await import('../runtime/harness/brackets.js');
const capabilityEnvelopes = await import('../agents/capability-envelope.js');
const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const localPlanning = await import('../runtime/harness/local-planning-capability.js');
const localWriteCommits = await import('../runtime/harness/host-local-write-commit.js');
const innerDispatch = await import('../tools/inner-dispatch.js');
const { hostRunRunner } = await import('../runtime/harness/host-turn-runner.js');
const { runConversation } = await import('../runtime/harness/loop.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const { planWorkflowExecutionBatches } = await import('../execution/workflow-runner.js');

const priorCapabilityCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();

beforeEach(() => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  innerDispatch._setInnerDispatchToolsForTests(null);
});

after(() => {
  innerDispatch._setInnerDispatchToolsForTests(null);
  capabilityCatalogs.installHostCapabilityCatalogFactory(priorCapabilityCatalog);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
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
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => (item as { type?: string }).type === 'function_call')
        ? 'tool_calls'
        : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId ?? 'long-task-response',
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

function scriptedModel(responses: unknown[][]) {
  let call = 0;
  const requests: unknown[] = [];
  return {
    calls: () => call,
    requests: () => requests,
    async getResponse(request: unknown) {
      requests.push(structuredClone(request));
      const output = responses[Math.min(call, responses.length - 1)] ?? [];
      call += 1;
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output,
        responseId: `long-task-response-${call}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
}

function functionCall(callId: string, name: string, args: Record<string, unknown>) {
  return { type: 'function_call', callId, name, arguments: JSON.stringify(args) };
}

function textMessage(text: string) {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as EventEmitter & { run: () => never }).run = () => {
    throw new Error('Runner.run must not own the foreground loop');
  };
  return runner;
}

function userMessage(text: string): AgentInputItem {
  return { role: 'user', content: text } as unknown as AgentInputItem;
}

type RecordingTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  needsApproval: () => Promise<boolean>;
  invoke: (_context: unknown, raw: string) => Promise<unknown>;
};

let acceptedHostSourceSerial = 0;

async function runAcceptedHostSource(input: {
  label: string;
  prompt: string;
  model: ReturnType<typeof scriptedModel>;
  tools: RecordingTool[];
}) {
  acceptedHostSourceSerial += 1;
  const session = eventlog.createSession({
    id: `long-task-host-${acceptedHostSourceSerial}-${input.label}`,
    kind: 'chat',
  });
  const tools = input.tools.map((tool) => brackets.wrapToolForHarness(tool as never)) as RecordingTool[];
  const agent = { model: input.model, tools };
  const result = await runConversation({
    sessionId: session.id,
    input: input.prompt,
    turnEngine: 'host_v1',
    maxSteps: 1,
    maxTurns: 4,
    toolCallsPerTurn: 8,
    judgeCompletion: false,
    buildAgent: async (identity) => {
      const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
        sessionId: identity.sessionId,
        universeTools: tools,
        activeToolNames: tools.map((tool) => tool.name),
        policyHash: 'long-task-competitive-host-v1',
        budget: {
          maxUncachedTokens: 4_000,
          maxModelCalls: 4,
          maxToolCalls: 8,
          maxElapsedMs: 30_000,
        },
      });
      assert.equal(sealed.ok, true, JSON.stringify(sealed));
      if (!sealed.ok) throw new Error(sealed.errors.join('; '));
      capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
      capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
      return agent as never;
    },
    makeRunner: () => throwingRunner() as never,
  });
  const sources = eventlog.listEvents(session.id, { types: ['user_input_received'] });
  assert.equal(sources.length, 1);
  return { result, sessionId: session.id, sourceUserSeq: sources[0]!.seq };
}

type LocalPlanningDefinition = import(
  '../runtime/harness/local-planning-capability.js'
).AuthorizedLocalPlanningDefinitionV1;

function orderedLocalWritePlanDraft(input: {
  definition: LocalPlanningDefinition;
  firstOperationId: string;
  secondOperationId: string;
}) {
  const destinationPosture = input.definition.descriptor.destinationPosture;
  return {
    criteria: ['Apply exactly two ordered mutations to the one requested local resource.'],
    cardinality: { count: 2, fields: [] },
    destination: destinationPosture
      ? {
          posture: destinationPosture,
          family: input.definition.descriptor.deliverableKind,
          handleRequired: input.definition.descriptor.handleRequired,
        }
      : null,
    topology: {
      version: 1,
      operations: [{
        id: input.firstOperationId,
        effect: 'local_write',
        coverage: null,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }, {
        id: input.secondOperationId,
        effect: 'local_write',
        coverage: null,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
    bindings: [input.firstOperationId, input.secondOperationId].map((operationId) => ({
      operationId,
      role: 'destination',
      capabilityRef: input.definition.capabilityRef,
      evidence: ['local_commit_receipt'],
    })),
    deliverables: [{
      id: `${input.secondOperationId}-deliverable`,
      kind: input.definition.descriptor.deliverableKind,
    }],
    evidenceRequirements: ['local_commit_receipt'],
  };
}

function provenLocalWriteResult(input: { path: string; content: string }): string {
  const handle = input.path.replace(/^\/+/, '');
  return localWriteCommits._withHostLocalWriteCommitFactsForTest({
    createdId: `local-file:${handle}`,
    handle,
    contentDigest: createHash('sha256').update(input.content, 'utf8').digest('hex'),
    result: JSON.stringify({ ok: true, path: input.path, created: true }),
  });
}

async function runAcceptedPlannedWriteSource(input: {
  label: string;
  prompt: string;
  firstArgs: Record<string, unknown>;
  secondArgs: Record<string, unknown>;
  invoke: (_context: unknown, raw: string) => Promise<unknown>;
}) {
  acceptedHostSourceSerial += 1;
  const session = eventlog.createSession({
    id: `long-task-host-${acceptedHostSourceSerial}-${input.label}`,
    kind: 'chat',
    channel: 'desktop',
  });
  const observed = await localPlanning.observeCurrentLocalPlanningDefinition({
    name: 'write_file',
    carrier: 'work_call',
  });
  assert.equal(observed.ok, true, JSON.stringify(observed));
  if (!observed.ok) throw new Error(observed.reason);
  assert.equal(localPlanning.localPlanningArgumentsMatch(observed.definition, input.firstArgs), true);
  assert.equal(localPlanning.localPlanningArgumentsMatch(observed.definition, input.secondArgs), true);

  const firstOperationId = `${input.label}-write-first`;
  const secondOperationId = `${input.label}-write-second`;
  const firstCallId = `${input.label}-call-first`;
  const secondCallId = `${input.label}-call-second`;
  let modelCall = 0;
  const modelRequests: unknown[] = [];
  const model = {
    async getResponse(request: unknown) {
      modelRequests.push(structuredClone(request));
      modelCall += 1;
      const visibleTools = ((request as { tools?: Array<{ name?: string }> }).tools ?? [])
        .map((tool) => tool.name ?? '');
      let output: unknown[];
      if (modelCall === 1) {
        assert.ok(visibleTools.includes('tool_search'));
        assert.equal(visibleTools.includes('plan_task'), false);
        output = [functionCall(`${input.label}-search`, 'tool_search', {
          query: 'write_file',
          role_key: 'clause-0:write',
          limit: 1,
        })];
      } else if (modelCall === 2) {
        assert.ok(visibleTools.includes('plan_task'));
        output = [functionCall(`${input.label}-plan`, 'plan_task', {
          preamble: 'I’ll apply the two ordered local mutations now.',
          draft: orderedLocalWritePlanDraft({
            definition: observed.definition,
            firstOperationId,
            secondOperationId,
          }),
        })];
      } else if (modelCall === 3) {
        assert.equal(visibleTools.includes('plan_task'), false);
        assert.ok(visibleTools.includes('work_call'));
        output = [{
          ...functionCall(firstCallId, 'work_call', {
            requirement_id: firstOperationId,
            universe_item_id: null,
            universe_selector: null,
            seal_amendment: null,
            name: 'write_file',
            args_json: JSON.stringify(input.firstArgs),
          }),
        }, {
          ...functionCall(secondCallId, 'work_call', {
            requirement_id: secondOperationId,
            universe_item_id: null,
            universe_selector: null,
            seal_amendment: null,
            name: 'write_file',
            args_json: JSON.stringify(input.secondArgs),
          }),
        }];
      } else {
        output = [textMessage('both ordered mutations complete')];
      }
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output,
        responseId: `${input.label}-response-${modelCall}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
  const fakeInner: RecordingTool & { strict: true } = {
    type: 'function',
    name: 'write_file',
    description: 'Recording-only exact planned local write.',
    strict: true,
    parameters: observed.schema,
    needsApproval: async () => false,
    invoke: input.invoke,
  };
  innerDispatch._setInnerDispatchToolsForTests(new Map([['write_file', fakeInner as never]]));
  try {
    const result = await runConversation({
      sessionId: session.id,
      input: input.prompt,
      turnEngine: 'host_v1',
      maxSteps: 1,
      maxTurns: 6,
      toolCallsPerTurn: 8,
      judgeCompletion: false,
      buildAgent: async (identity) => {
        assert.ok(identity.hostFreshPlanning, 'ordinary host activation did not mint planning context');
        assert.equal(
          identity.hostFreshPlanning.capabilities.some(
            (entry) => entry.id === observed.definition.capabilityRef,
          ),
          false,
          'the write capability must be disclosed through the ordinary foreground search',
        );
        return buildOrchestratorAgent({
          userInput: input.prompt,
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          hostFreshPlanning: identity.hostFreshPlanning,
          allowedToolNames: ['write_file', 'tool_search'],
          allowToolJit: true,
          mcpToolScope: {
            authority: 'none',
            reason: 'provider-neutral long-task scheduling has no external authority',
            allowedServerSlugs: [],
            toolPatterns: [],
            maxTools: 0,
          },
          model: model as never,
        });
      },
      makeRunner: () => throwingRunner() as never,
      onConversationPreamble: async (request: {
        deliveryKey: string;
        eventId: string;
        eventDigest: string;
      }) => ({
        status: 'delivered' as const,
        receipt: {
          version: 1 as const,
          deliveryKey: request.deliveryKey,
          eventId: request.eventId,
          eventDigest: request.eventDigest,
          surface: 'channel_message' as const,
          target: `desktop:${input.label}`,
        },
      }),
    });
    const sources = eventlog.listEvents(session.id, { types: ['user_input_received'] });
    assert.equal(sources.length, 1);
    return {
      result,
      sessionId: session.id,
      sourceUserSeq: sources[0]!.seq,
      businessCallIds: [firstCallId, secondCallId],
      modelRequests,
    };
  } finally {
    innerDispatch._setInnerDispatchToolsForTests(null);
  }
}

function assertDurableLocalHostCalls(input: {
  sessionId: string;
  sourceUserSeq: number;
  callIds: string[];
  toolName: 'list_files' | 'write_file';
  effect: 'read' | 'local_write';
}): void {
  const db = eventlog.openEventLog();
  const root = db.prepare(`
    SELECT authority_kind, graph_event_id, graph_hash, state
      FROM accepted_turn_call_authorities
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as {
    authority_kind: string;
    graph_event_id: string | null;
    graph_hash: string | null;
    state: string;
  } | undefined;
  assert.deepEqual(root, {
    authority_kind: 'host_v1',
    graph_event_id: null,
    graph_hash: null,
    state: 'closed',
  });
  const expectedIds = new Set(input.callIds);
  const logical = (db.prepare(`
    SELECT logical_tool_call_id, tool_name, state
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).all(input.sessionId, input.sourceUserSeq) as Array<{
    logical_tool_call_id: string;
    tool_name: string;
    state: string;
  }>).filter((row) => expectedIds.has(row.logical_tool_call_id));
  assert.equal(logical.length, input.callIds.length, JSON.stringify(logical));
  assert.ok(logical.every((row) => row.tool_name === input.toolName && row.state === 'settled'),
    JSON.stringify(logical));
  const bindings = (db.prepare(`
    SELECT logical_tool_call_id, effect, binding_kind, account_id,
           manifest_id, manifest_digest
      FROM host_call_capability_bindings
     WHERE session_id = ? AND source_user_seq = ?
  `).all(input.sessionId, input.sourceUserSeq) as Array<{
    logical_tool_call_id: string;
    effect: string;
    binding_kind: string;
    account_id: string;
    manifest_id: string;
    manifest_digest: string;
  }>).filter((row) => expectedIds.has(row.logical_tool_call_id));
  assert.equal(bindings.length, input.callIds.length, JSON.stringify(bindings));
  assert.ok(bindings.every((row) => (
    row.effect === input.effect
    && row.binding_kind === 'local_envelope'
    && row.account_id === ''
    && row.manifest_id === ''
    && row.manifest_digest === ''
  )), JSON.stringify(bindings));
  const settlements = (db.prepare(`
    SELECT logical_tool_call_id, execution_kind, outcome_kind,
           physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `).all(input.sessionId, input.sourceUserSeq) as Array<{
    logical_tool_call_id: string;
    execution_kind: string;
    outcome_kind: string;
    physical_crossing_count: number;
  }>).filter((row) => expectedIds.has(row.logical_tool_call_id));
  assert.equal(settlements.length, input.callIds.length, JSON.stringify(settlements));
  assert.ok(settlements.every((row) => (
    row.execution_kind === 'local_execution'
    && row.outcome_kind === 'succeeded'
    && row.physical_crossing_count === 0
  )), JSON.stringify(settlements));
}

function toolCallItem(callId: string, name: string, args = '{}'): AgentInputItem {
  return {
    type: 'function_call',
    id: `fc-${callId}`,
    callId,
    name,
    arguments: args,
    status: 'completed',
  } as unknown as AgentInputItem;
}

function toolResultItem(callId: string, text: string): AgentInputItem {
  return {
    type: 'function_call_result',
    id: `fcr-${callId}`,
    callId,
    output: { type: 'text', text },
    status: 'completed',
  } as unknown as AgentInputItem;
}

test('GATE scheduling: independent reads overlap while model history stays in call order', async () => {
  const prompt = 'Read source A and source B independently.';
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  let firstObservedOverlap = false;
  let active = 0;
  let peakActive = 0;
  const model = scriptedModel([
    [
      functionCall('read-a', 'list_files', { source: 'a' }),
      functionCall('read-b', 'list_files', { source: 'b' }),
    ],
    [textMessage('both reads complete')],
  ]);

  const run = await runAcceptedHostSource({
    label: 'overlapping-reads',
    prompt,
    model,
    tools: [{
        type: 'function',
        name: 'list_files',
        description: 'Read one independent source.',
        parameters: { type: 'object', properties: { source: { type: 'string' } } },
        needsApproval: async () => false,
        invoke: async (_context: unknown, raw: string) => {
          active += 1;
          peakActive = Math.max(peakActive, active);
          try {
            const source = (JSON.parse(raw) as { source: string }).source;
            if (source === 'b') {
              markSecondStarted();
              return 'result-b';
            }
            firstObservedOverlap = await Promise.race([
              secondStarted.then(() => true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
            ]);
            return 'result-a';
          } finally {
            active -= 1;
          }
        },
      }],
  });
  const secondRequest = model.requests()[1] as { input?: unknown[] } | undefined;
  const resultOrder = (secondRequest?.input ?? [])
    .filter((item) => (item as { type?: string }).type === 'function_call_result')
    .map((item) => (item as { callId?: string }).callId);
  assert.deepEqual({ status: run.result.status, firstObservedOverlap, peakActive, resultOrder }, {
    status: 'completed',
    firstObservedOverlap: true,
    peakActive: 2,
    resultOrder: ['read-a', 'read-b'],
  });
  assertDurableLocalHostCalls({
    ...run,
    callIds: ['read-a', 'read-b'],
    toolName: 'list_files',
    effect: 'read',
  });
});

test('GATE scheduling: declared dependencies form ordered waves and independent branches share a wave', () => {
  const batches = planWorkflowExecutionBatches([
    { id: 'read-root', prompt: 'Read the root source.' },
    { id: 'read-left', prompt: 'Read the left source.', dependsOn: ['read-root'] },
    { id: 'read-right', prompt: 'Read the right source.', dependsOn: ['read-root'] },
    { id: 'reduce', prompt: 'Reduce both sources.', dependsOn: ['read-left', 'read-right'] },
    { id: 'write', prompt: 'Write the reduction.', dependsOn: ['reduce'] },
  ]);
  assert.deepEqual(batches.map((batch) => batch.map((step) => step.id)), [
    ['read-root'],
    ['read-left', 'read-right'],
    ['reduce'],
    ['write'],
  ]);
});

test('GATE scheduling: mutations to one local resource serialize even when emitted in one frame', async () => {
  const prompt = 'Apply these two ordered mutations to one generated local resource.';
  let active = 0;
  let peakActive = 0;
  let firstSettled = false;
  let secondObservedSettledPredecessor = false;
  const run = await runAcceptedPlannedWriteSource({
    label: 'ordered-local-mutations',
    prompt,
    firstArgs: {
      path: '/generated/shared-resource.json', content: 'first', mode: 'create', append: null,
    },
    secondArgs: {
      path: '/generated/shared-resource.json', content: 'second', mode: 'create', append: null,
    },
    invoke: async (_context: unknown, raw: string) => {
      const parsed = JSON.parse(raw) as { path: string; content: string };
      active += 1;
      peakActive = Math.max(peakActive, active);
      try {
        if (parsed.content === 'first') {
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
          firstSettled = true;
          return provenLocalWriteResult(parsed);
        }
        secondObservedSettledPredecessor = firstSettled;
        return provenLocalWriteResult(parsed);
      } finally {
        active -= 1;
      }
    },
  });
  const mutationDiagnostics = {
    result: run.result,
    authority: eventlog.openEventLog().prepare(`
      SELECT state, expected_work_required, work_contract_id
        FROM accepted_task_authority
       WHERE session_id = ? AND source_user_seq = ?
    `).get(run.sessionId, run.sourceUserSeq),
    calls: eventlog.openEventLog().prepare(`
      SELECT logical_tool_call_id, tool_name, state, outcome_kind
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY logical_tool_call_id
    `).all(run.sessionId, run.sourceUserSeq),
    settlements: eventlog.openEventLog().prepare(`
      SELECT logical_tool_call_id, execution_kind, outcome_kind, recovery_action
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY logical_tool_call_id
    `).all(run.sessionId, run.sourceUserSeq),
    events: eventlog.listEvents(run.sessionId).slice(-16).map((event) => ({
      type: event.type,
      data: event.data,
    })),
  };
  assert.deepEqual({ status: run.result.status, peakActive, secondObservedSettledPredecessor }, {
    status: 'completed',
    peakActive: 1,
    secondObservedSettledPredecessor: true,
  }, `effect + destination identity, not raw call count, must choose an exclusive barrier: ${JSON.stringify(mutationDiagnostics)}`);
  assertDurableLocalHostCalls({
    sessionId: run.sessionId,
    sourceUserSeq: run.sourceUserSeq,
    callIds: run.businessCallIds,
    toolName: 'write_file',
    effect: 'local_write',
  });
});

test('GATE scheduling latency: four 100ms reads finish within 180ms p95 while two 100ms mutations take at least 190ms p95', {
  timeout: 120_000,
}, async (t) => {
  const samples = 20;
  const readDurations: number[] = [];
  const readCompletionOffsets: number[][] = [];
  const mutationDurations: number[] = [];
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 100));

  for (let sample = 0; sample < samples; sample += 1) {
    let activeReads = 0;
    let peakReads = 0;
    const readModel = scriptedModel([
      Array.from({ length: 4 }, (_, index) => functionCall(
        `read-${sample}-${index}`,
        'list_files',
        { source: `generated-source-${sample}-${index}` },
      )),
      [textMessage('four reads complete')],
    ]);
    let firstReadStarted = Number.POSITIVE_INFINITY;
    let lastReadSettled = 0;
    const readSettledAt: number[] = [];
    const readRun = await runAcceptedHostSource({
      label: `latency-read-${sample}`,
      prompt: 'Read four independent generated sources.',
      model: readModel,
      tools: [{
          type: 'function',
          name: 'list_files',
          description: 'Read one generated independent source.',
          parameters: { type: 'object', properties: { source: { type: 'string' } } },
          needsApproval: async () => false,
          invoke: async () => {
            firstReadStarted = Math.min(firstReadStarted, performance.now());
            activeReads += 1;
            peakReads = Math.max(peakReads, activeReads);
            try {
              await delay();
              return 'read-complete';
            } finally {
              const settledAt = performance.now();
              readSettledAt.push(settledAt);
              lastReadSettled = Math.max(lastReadSettled, settledAt);
              activeReads -= 1;
            }
          },
        }],
    });
    readDurations.push(lastReadSettled - firstReadStarted);
    readCompletionOffsets.push(
      readSettledAt
        .map((settledAt) => settledAt - firstReadStarted)
        .sort((left, right) => left - right),
    );
    assert.equal(readRun.result.status, 'completed');
    assert.equal(peakReads, 4, `read sample ${sample} did not enter one parallel wave`);
    const readCallIds = Array.from({ length: 4 }, (_, index) => `read-${sample}-${index}`);
    const secondReadRequest = readModel.requests()[1] as { input?: unknown[] } | undefined;
    assert.deepEqual(
      (secondReadRequest?.input ?? [])
        .filter((item) => (item as { type?: string }).type === 'function_call_result')
        .map((item) => (item as { callId?: string }).callId),
      readCallIds,
    );
    assertDurableLocalHostCalls({
      sessionId: readRun.sessionId,
      sourceUserSeq: readRun.sourceUserSeq,
      callIds: readCallIds,
      toolName: 'list_files',
      effect: 'read',
    });

    let activeMutations = 0;
    let peakMutations = 0;
    const observedOrder: string[] = [];
    let firstMutationStarted = Number.POSITIVE_INFINITY;
    let lastMutationSettled = 0;
    const mutationRun = await runAcceptedPlannedWriteSource({
      label: `latency-write-${sample}`,
      prompt: 'Apply two ordered mutations to one generated local resource.',
      firstArgs: {
        path: `/generated/shared-${sample}.json`, content: 'first', mode: 'create', append: null,
      },
      secondArgs: {
        path: `/generated/shared-${sample}.json`, content: 'second', mode: 'create', append: null,
      },
      invoke: async (_context: unknown, raw: string) => {
        const parsed = JSON.parse(raw) as { path: string; content: string };
        firstMutationStarted = Math.min(firstMutationStarted, performance.now());
        activeMutations += 1;
        peakMutations = Math.max(peakMutations, activeMutations);
        try {
          observedOrder.push(parsed.content);
          await delay();
          return provenLocalWriteResult(parsed);
        } finally {
          lastMutationSettled = Math.max(lastMutationSettled, performance.now());
          activeMutations -= 1;
        }
      },
    });
    mutationDurations.push(lastMutationSettled - firstMutationStarted);
    assert.equal(mutationRun.result.status, 'completed');
    assert.equal(peakMutations, 1, `mutation sample ${sample} crossed the exclusive barrier`);
    assert.deepEqual(observedOrder, ['first', 'second']);
    const fourthMutationRequest = mutationRun.modelRequests[3] as { input?: unknown[] } | undefined;
    assert.deepEqual(
      (fourthMutationRequest?.input ?? [])
        .filter((item) => (item as { type?: string }).type === 'function_call_result')
        .map((item) => (item as { callId?: string }).callId)
        .filter((callId) => mutationRun.businessCallIds.includes(String(callId))),
      mutationRun.businessCallIds,
    );
    assertDurableLocalHostCalls({
      sessionId: mutationRun.sessionId,
      sourceUserSeq: mutationRun.sourceUserSeq,
      callIds: mutationRun.businessCallIds,
      toolName: 'write_file',
      effect: 'local_write',
    });
    if (sample + 1 < samples) {
      eventlog.resetEventLog();
      capabilityCatalogs.installHostCapabilityCatalogFactory(
        capabilityCatalogs.createHostCapabilityCatalogFactory(),
      );
    }
  }

  const p95 = (values: readonly number[]): number => {
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
  };
  const readP95 = p95(readDurations);
  const mutationP95 = p95(mutationDurations);
  const slowestReadIndex = readDurations.indexOf(Math.max(...readDurations));
  t.diagnostic(JSON.stringify({
    samples,
    readP95Ms: Number(readP95.toFixed(3)),
    mutationP95Ms: Number(mutationP95.toFixed(3)),
    readMaxMs: Number(Math.max(...readDurations).toFixed(3)),
    mutationMinMs: Number(Math.min(...mutationDurations).toFixed(3)),
    slowestReadCompletionOffsetsMs: readCompletionOffsets[slowestReadIndex]?.map(
      (duration) => Number(duration.toFixed(3)),
    ),
  }));
  assert.ok(readP95 <= 180, `four independent 100ms reads took ${readP95.toFixed(3)}ms p95`);
  assert.ok(mutationP95 >= 190, `two ordered 100ms mutations took only ${mutationP95.toFixed(3)}ms p95`);
});

async function visibleToolNames(
  agent: Awaited<ReturnType<typeof buildOrchestratorAgent>>,
  identity: { sessionId: string; sourceUserSeq: number; turn: number },
): Promise<string[]> {
  return brackets.withHarnessRunContext({
    ...identity,
    counter: new brackets.ToolCallsCounter(1_000),
    behaviorScopeId: `${identity.sessionId}::turn:${identity.turn}::surface-audit`,
  }, async () => {
    const tools = typeof agent.getAllTools === 'function'
      ? await agent.getAllTools(new RunContext({} as never))
      : agent.tools ?? [];
    return tools.map((entry) => entry.name).sort();
  });
}

test('GATE surface: workers are plan-optional and listing the fresh surface performs no worker/business I/O', async () => {
  const text = 'Find the top 5 widgets based on ratings and add them to a new workbook for me.';
  const session = eventlog.createSession({ id: 'long-task-surface', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const agent = await buildOrchestratorAgent({
    userInput: text,
    sessionId: session.id,
    sourceUserSeq: source.seq,
    allowedToolNames: ['tool_search', 'run_worker', 'write_file'],
    hostFreshPlanning: {
      authority: { scope: 'primary_model_planning_catalog_v1' },
      identity: { sessionId: session.id, sourceUserSeq: source.seq },
      capabilities: [],
      digest: '0'.repeat(64),
    } as never,
  });

  const turnIdentity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const before = await visibleToolNames(agent, turnIdentity);
  const prePlanWorkCall = (agent.tools ?? []).find((entry) => entry.name === 'work_call');
  assert.equal(before.includes('tool_search'), true);
  assert.equal(before.includes('plan_task'), false,
    'an empty planning catalog cannot expose plan_task before exact capability disclosure');
  assert.equal(before.includes('run_worker'), true, 'scoped delegation is callable without compiling a plan');
  assert.equal(before.includes('write_file'), false);
  assert.equal(before.includes('composio_execute_tool'), false);
  assert.equal(eventlog.listEvents(session.id, { types: ['worker_started', 'worker_result', 'external_write_succeeded'] }).length, 0,
    'advertising delegation is not execution');
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?')
    .get(session.id) as { n: number }).n, 0, 'surface discovery crosses no provider or worker tool edge');
  if (before.includes('work_call')) {
    assert.match(
      String(prePlanWorkCall?.description ?? ''),
      /plan_task|plan required|before any business/i,
      'a model-visible pre-plan carrier must be explicitly inert',
    );
  }

  assert.ok(graphShadow.recordTurnGraphShadow({
    identity: turnIdentity,
  }), 'fixture admits the same source after the initial foreground surface exists');
  const activated = expectedWork.activateActionExpectedWork(turnIdentity);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));

  const afterPlan = await visibleToolNames(agent, turnIdentity);
  assert.deepEqual({
    planControlRetired: !afterPlan.includes('plan_task'),
    workerAvailable: afterPlan.includes('run_worker'),
    businessCarrierAvailable: afterPlan.includes('work_call'),
  }, {
    planControlRetired: true,
    workerAvailable: true,
    businessCarrierAvailable: true,
  }, 'the one foreground loop must refresh its callable surface from durable plan state');
});

test('GATE surface: an advertised worker with a valid packet still requires exact accepted call authority', async (t) => {
  const { RouterModelProvider } = await import('../runtime/harness/router-model.js');
  const { WorkerToolCallSchema } = await import('../agents/worker-job-packet.js');
  let childModelCalls = 0;
  t.mock.method(RouterModelProvider.prototype, 'getModel', () => {
    childModelCalls += 1;
    throw new Error('an unowned call cannot reach a child model');
  });
  const session = eventlog.createSession({ id: 'long-task-worker-packet-refusal', kind: 'chat' });
  const text = 'Review one item locally.';
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text } });
  const agent = await buildOrchestratorAgent({ userInput: text,
    sessionId: session.id, sourceUserSeq: source.seq, allowedToolNames: ['run_worker'],
    hostFreshPlanning: { authority: { scope: 'primary_model_planning_catalog_v1' },
      identity: { sessionId: session.id, sourceUserSeq: source.seq }, capabilities: [], digest: '0'.repeat(64) } as never });
  assert.ok((await visibleToolNames(agent, { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 })).includes('run_worker'));
  const packet = WorkerToolCallSchema.parse({ objective: text, item: 'one', resolvedTools: 'none needed',
    externalMcpToolNames: null, context: 'The supplied item is local.',
    instructions: 'Return one short review.', expectedOutput: 'One review.', intent: 'research' });
  const worker = agent.tools.find((entry) => entry.name === 'run_worker') as {
    invoke: (context: unknown, input: string, details: unknown) => Promise<unknown>;
  };
  const packetJson = JSON.stringify(packet);
  // A caller cannot turn surface visibility into authority by borrowing the
  // session and inventing an accepted source sequence. Use the real wrapper.
  await assert.rejects(() => brackets.withHarnessRunContext({ sessionId: session.id,
    sourceUserSeq: source.seq + 1, counter: new brackets.ToolCallsCounter(8) }, () => worker.invoke(
      new RunContext({ sessionId: session.id, sourceUserSeq: source.seq + 1 }), packetJson,
      { toolCall: { name: 'run_worker', callId: 'unowned-worker-packet', arguments: packetJson } },
    )), (error: unknown) => {
      assert.ok(error instanceof identities.LogicalCallPreDispatchAuthorityError);
      assert.equal(error.status, 'missing');
      assert.match(error.reason, /accepted task|source|authority/i);
      t.diagnostic(error.message);
      return true;
    });
  const db = eventlog.openEventLog();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?')
    .get(session.id) as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM logical_tool_calls WHERE session_id = ?')
    .get(session.id) as { n: number }).n, 0, 'no forged accepted source opens a logical call');
  assert.equal(childModelCalls, 0);
  assert.equal(eventlog.listEvents(session.id, { types: ['worker_started', 'worker_result', 'turn_graph_compiled', 'approval_requested'] }).length, 0);
});

test('GATE context: repeated identical small results become one model-visible value plus recall references', () => {
  const session = eventlog.createSession({ id: 'long-task-identical-results', kind: 'chat' });
  const payload = `IDENTICAL_RESULT::${'r'.repeat(700)}`;
  const items: AgentInputItem[] = [userMessage('Inspect the same stable fact across twelve partitions.')];
  const callIds: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    const callId = `identical-${index + 1}`;
    callIds.push(callId);
    items.push(toolCallItem(callId, 'partition_read', JSON.stringify({ partition: index + 1 })));
    items.push(toolResultItem(callId, payload));
    eventlog.writeToolOutput({ sessionId: session.id, callId, tool: 'partition_read', output: payload });
  }

  const compacted = compaction.compactInFlightToolContext(items, session.id);
  const visible = JSON.stringify(compacted.nextItems);
  const rawCopies = visible.split(payload).length - 1;
  const recallReferences = visible.match(/recall_tool_result/g)?.length ?? 0;
  const allCallIdsAddressable = callIds.every((callId) => visible.includes(callId));
  const allRawResultsExact = callIds.every((callId) => eventlog.getToolOutput(session.id, callId)?.output === payload);
  const visibleBytes = Buffer.byteLength(visible, 'utf8');

  assert.deepEqual({
    compactionApplied: compacted.applied,
    oneVisibleRawCopy: rawCopies === 1,
    duplicateReferencesPresent: recallReferences >= 11,
    allCallIdsAddressable,
    allRawResultsExact,
    underSixKilobytes: visibleBytes <= 6_000,
  }, {
    compactionApplied: true,
    oneVisibleRawCopy: true,
    duplicateReferencesPresent: true,
    allCallIdsAddressable: true,
    allRawResultsExact: true,
    underSixKilobytes: true,
  }, JSON.stringify({ rawCopies, recallReferences, visibleBytes }));
});

function acceptResultTask(label: string) {
  const session = eventlog.createSession({ id: `long-task-result-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Read the complete ${label} dataset.` },
  });
  assert.ok(graphShadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

function returnedResultAuthority(
  task: ReturnType<typeof acceptResultTask>,
): resultHandles.ResultHandleAuthority {
  const toolName = 'competitive_large_source_read';
  const args = { query: 'all records', limit: 100_000 };
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId: 'large-logical-read',
      physicalDispatchId: 'large-physical-read',
      ordinal: 0,
    },
    tool: toolName,
    args,
  });
  assert.equal(started.status, 'inserted', JSON.stringify(started));
  if (started.status !== 'inserted') throw new Error('large-result fixture dispatch was not admitted');
  const settled = dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool: toolName,
    outcome: 'returned',
  });
  assert.equal(settled.status, 'inserted', JSON.stringify(settled));
  return {
    ...task,
    logicalToolCallId: 'large-logical-read',
    physicalDispatchId: 'large-physical-read',
    toolName,
    args,
  };
}

test('GATE evidence: authoritative output above 8MB spills and redeems byte-exactly after an OS-process restart', () => {
  const authority = returnedResultAuthority(acceptResultTask('oversized-authoritative'));
  const blob = `lossless-spill::${'x'.repeat(resultHandles.RESULT_RAW_MAX_BYTES + 1_024)}`;
  const payload = {
    successful: true,
    data: { records: [{ id: 'complete-large-record', blob }] },
    meta: { complete: true },
  };
  const handle = resultHandles.toResultHandle(payload, { authority });
  const row = eventlog.openEventLog().prepare(`
    SELECT raw_payload_json, raw_payload_sha256, raw_byte_count, rejection_reason
      FROM durable_result_handles
     WHERE handle_id = ?
  `).get(handle.handle) as {
    raw_payload_json: string | null;
    raw_payload_sha256: string | null;
    raw_byte_count: number;
    rejection_reason: string | null;
  };
  const rawJson = JSON.stringify(payload);
  const expectedSha256 = createHash('sha256').update(rawJson, 'utf8').digest('hex');
  const expectedBytes = Buffer.byteLength(rawJson, 'utf8');
  assert.ok(handle.rawLocation, 'an authoritative oversized result must retain a redeemable location');
  eventlog.closeEventLog();
  const childRequest = Buffer.from(JSON.stringify({
    rawLocation: handle.rawLocation,
    authority,
    expectedSha256,
    expectedBytes,
  }), 'utf8').toString('base64url');
  const child = spawnSync(process.execPath, [
    '--import',
    'tsx',
    path.join(import.meta.dirname, 'long-task-result-restart.fixture.ts'),
    childRequest,
  ], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { ...process.env, CLEMENTINE_HOME: HOME, CLEMMY_TEST_ISOLATED_HOME: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const restarted = JSON.parse(child.stdout.trim()) as {
    pid: number;
    status: string;
    rawPayloadSha256?: string;
    rawByteCount?: number;
  };

  assert.deepEqual({
    offRowSpill: row.raw_payload_json === '' && handle.rawLocation !== null,
    durableDigestExact: row.raw_payload_sha256 === expectedSha256,
    durableBytesExact: row.raw_byte_count === expectedBytes,
    notRejected: row.rejection_reason === null,
    complete: handle.completeness === 'complete',
    distinctProcess: restarted.pid !== process.pid,
    restartedStatus: restarted.status,
    restartedDigestExact: restarted.rawPayloadSha256 === expectedSha256,
    restartedBytesExact: restarted.rawByteCount === expectedBytes,
  }, {
    offRowSpill: true,
    durableDigestExact: true,
    durableBytesExact: true,
    notRejected: true,
    complete: true,
    distinctProcess: true,
    restartedStatus: 'ok',
    restartedDigestExact: true,
    restartedBytesExact: true,
  }, JSON.stringify({
    rawLocation: handle.rawLocation,
    rejectionReason: row.rejection_reason,
    completeness: handle.completeness,
    childStatus: child.status,
    childStdout: child.stdout,
    childStderr: child.stderr,
  }));
});

test('GATE context: 84 completed steps stay below a hard visible ceiling and every raw result remains recallable', () => {
  const session = eventlog.createSession({ id: 'long-task-84-step-context', kind: 'chat' });
  const items: AgentInputItem[] = [userMessage('Complete all 84 evidence steps and synthesize the result.')];
  const exact = new Map<string, string>();
  for (let index = 0; index < 84; index += 1) {
    const callId = `long-step-${String(index + 1).padStart(2, '0')}`;
    const output = `authoritative-evidence-${index + 1}::${String.fromCharCode(65 + (index % 26)).repeat(4_096)}`;
    exact.set(callId, output);
    items.push(toolCallItem(callId, 'long_task_read', JSON.stringify({ step: index + 1 })));
    items.push(toolResultItem(callId, output));
    eventlog.writeToolOutput({ sessionId: session.id, callId, tool: 'long_task_read', output });
  }

  const compacted = compaction.compactInFlightToolContext(items, session.id);
  const visible = JSON.stringify(compacted.nextItems);
  const visibleBytes = Buffer.byteLength(visible, 'utf8');
  const allRawResultsExact = [...exact].every(([callId, output]) =>
    eventlog.getToolOutput(session.id, callId)?.output === output);
  const everyCollapsedResultAddressable = compacted.callIds.every((callId) => visible.includes(callId));
  const metrics = {
    applied: compacted.applied,
    collapsed: compacted.collapsed,
    retainedPairs: compacted.retainedPairs,
    beforeTokens: compacted.beforeTokens,
    afterTokens: compacted.afterTokens,
    visibleBytes,
    allRawResultsExact,
    everyCollapsedResultAddressable,
  };

  assert.equal(metrics.applied, true, JSON.stringify(metrics));
  assert.ok(metrics.collapsed >= 76, JSON.stringify(metrics));
  assert.ok(metrics.retainedPairs <= 8, JSON.stringify(metrics));
  assert.ok(metrics.afterTokens <= 24_000, JSON.stringify(metrics));
  assert.ok(metrics.visibleBytes <= 96_000, JSON.stringify(metrics));
  assert.equal(metrics.allRawResultsExact, true, JSON.stringify(metrics));
  assert.equal(metrics.everyCollapsedResultAddressable, true, JSON.stringify(metrics));
});

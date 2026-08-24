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
const { hostRunRunner: productionHostRunRunner } = await import('../runtime/harness/host-turn-runner.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const { planWorkflowExecutionBatches } = await import('../execution/workflow-runner.js');

const hostRunRunner: typeof productionHostRunRunner = (runner, agent, itemsOrState, options) =>
  productionHostRunRunner(runner, agent, itemsOrState, {
    ...options,
    allowUnownedToolInvocationForTests: true,
  } as never);

beforeEach(() => {
  eventlog.resetEventLog();
});

after(() => {
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
  return {
    calls: () => call,
    async getResponse() {
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

  const outcome = await hostRunRunner(
    throwingRunner() as never,
    {
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
    } as never,
    [userMessage('Read source A and source B independently.')] as never,
    { maxTurns: 4, toolExecution: { maxFunctionToolConcurrency: 2 } },
  );

  const resultOrder = outcome.history
    .filter((item) => (item as { type?: string }).type === 'function_call_result')
    .map((item) => (item as { callId?: string }).callId);
  assert.deepEqual({ firstObservedOverlap, peakActive, resultOrder }, {
    firstObservedOverlap: true,
    peakActive: 2,
    resultOrder: ['read-a', 'read-b'],
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

test('GATE scheduling: mutations to one provider resource serialize even when emitted in one frame', async () => {
  let active = 0;
  let peakActive = 0;
  let firstSettled = false;
  let secondObservedSettledPredecessor = false;
  const model = scriptedModel([
    [
      functionCall('sheet-mutation-1', 'composio_execute_tool', {
        tool_slug: 'GOOGLESHEETS_VALUES_UPDATE',
        arguments: JSON.stringify({ spreadsheet_id: 'sheet-shared', range: 'A1', values: [['first']] }),
        connected_account_id: null,
      }),
      functionCall('sheet-mutation-2', 'composio_execute_tool', {
        tool_slug: 'GOOGLESHEETS_VALUES_UPDATE',
        arguments: JSON.stringify({ spreadsheet_id: 'sheet-shared', range: 'A2', values: [['second']] }),
        connected_account_id: null,
      }),
    ],
    [textMessage('both mutations complete')],
  ]);

  await hostRunRunner(
    throwingRunner() as never,
    {
      model,
      tools: [{
        type: 'function',
        name: 'composio_execute_tool',
        description: 'Execute one connected-provider operation.',
        parameters: { type: 'object', properties: {} },
        needsApproval: async () => false,
        invoke: async (_context: unknown, raw: string) => {
          const parsed = JSON.parse(raw) as { arguments: string };
          const inner = JSON.parse(parsed.arguments) as { range: string };
          active += 1;
          peakActive = Math.max(peakActive, active);
          try {
            if (inner.range === 'A1') {
              await new Promise<void>((resolve) => setTimeout(resolve, 40));
              firstSettled = true;
              return 'first-settled';
            }
            secondObservedSettledPredecessor = firstSettled;
            return 'second-settled';
          } finally {
            active -= 1;
          }
        },
      }],
    } as never,
    [userMessage('Apply these two ordered updates to the same Sheet.')] as never,
    { maxTurns: 4, toolExecution: { maxFunctionToolConcurrency: 8 } },
  );

  assert.deepEqual({ peakActive, secondObservedSettledPredecessor }, {
    peakActive: 1,
    secondObservedSettledPredecessor: true,
  }, 'effect + destination identity, not raw call count, must choose an exclusive barrier');
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

test('GATE surface: fresh plan has no worker/business I/O; admitted plan swaps plan_task for run_worker in the same agent', async () => {
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
  assert.equal(before.includes('plan_task'), true);
  assert.equal(before.includes('run_worker'), false);
  assert.equal(before.includes('write_file'), false);
  assert.equal(before.includes('composio_execute_tool'), false);
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

test('GATE evidence: authoritative output above 8MB spills and redeems losslessly', () => {
  const authority = returnedResultAuthority(acceptResultTask('oversized-authoritative'));
  const blob = `lossless-spill::${'x'.repeat(resultHandles.RESULT_RAW_MAX_BYTES + 1_024)}`;
  const payload = {
    successful: true,
    data: { records: [{ id: 'complete-large-record', blob }] },
    meta: { complete: true },
  };
  const handle = resultHandles.toResultHandle(payload, { authority });
  const row = eventlog.openEventLog().prepare(`
    SELECT raw_payload_json, rejection_reason
      FROM durable_result_handles
     WHERE handle_id = ?
  `).get(handle.handle) as { raw_payload_json: string | null; rejection_reason: string | null };
  const redeemed = handle.rawLocation
    ? resultHandles.redeemRawResult(handle.rawLocation, authority)
    : null;
  const lossless = redeemed?.status === 'ok'
    && (redeemed.value as typeof payload).data.records[0]?.blob === blob;

  assert.deepEqual({
    offRowSpill: row.raw_payload_json === '' && handle.rawLocation !== null,
    notRejected: row.rejection_reason === null,
    complete: handle.completeness === 'complete',
    lossless,
  }, {
    offRowSpill: true,
    notRejected: true,
    complete: true,
    lossless: true,
  }, JSON.stringify({
    rawLocation: handle.rawLocation,
    rejectionReason: row.rejection_reason,
    completeness: handle.completeness,
    redemptionStatus: redeemed?.status ?? null,
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

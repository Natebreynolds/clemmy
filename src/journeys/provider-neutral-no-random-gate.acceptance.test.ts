/**
 * Provider-neutral release acceptance matrix.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/journeys/provider-neutral-no-random-gate.acceptance.test.ts
 *
 * Every capability body is recording-only and every provider port is a local
 * fixture. The test deliberately uses one Discord-like session across many
 * unrelated accepted sources. Conversation, authorized reads, and authorized
 * reversible work must complete without an interactive gate; none may become
 * a generic authority/fail-closed terminal.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-provider-neutral-no-gate-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-provider-neutral-no-gate\n');
writeFileSync(
  path.join(HOME, 'state', 'proactivity-policy.json'),
  JSON.stringify({ autoApproveScope: 'strict' }, null, 2),
);

const eventlog = await import('../runtime/harness/eventlog.js');
const brackets = await import('../runtime/harness/brackets.js');
const envelopes = await import('../agents/capability-envelope.js');
const { hostRunRunner, HostInterruptState } = await import('../runtime/harness/host-turn-runner.js');
const hostInvocation = await import('../runtime/harness/host-tool-invocation.js');
const { runTurn, __defaultRunRunner } = await import('../runtime/harness/loop.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const sdk = await import('@openai/agents');
const { z } = await import('zod');
const callTools = await import('../tools/call-tool.js');
const toolRegistry = await import('../tools/tool-registry.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const taxonomy = await import('../agents/tool-taxonomy.js');
const attemptOutcomes = await import('../runtime/harness/attempt-outcome.js');
const planScopes = await import('../agents/plan-scope.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const innerDispatch = await import('../tools/inner-dispatch.js');
const localPlanning = await import('../runtime/harness/local-planning-capability.js');
const semanticPlanning = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const attemptIdentity = await import('../runtime/harness/attempt-identity.js');
const logicalContracts = await import('../runtime/harness/logical-call-contract.js');
const dispatchLeases = await import('../runtime/harness/dispatch-lease.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const productionAdapters = await import('../runtime/harness/production-capability-adapter.js');
const productionTransport = await import('../runtime/harness/production-capability-adapters.js');
const composioSchemas = await import('../tools/composio-schema-cache.js');
const composioClient = await import('../integrations/composio/client.js');
const capabilityResolution = await import('../runtime/harness/capability-resolution.js');
const independentObservations = await import('../runtime/harness/independent-capability-observation.js');
const externalRiskLoader = await import('../runtime/harness/external-capability-risk-loader.js');
const composioProviderIdentity = await import('../integrations/composio/provider-definition-identity.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const hostConsent = await import('../runtime/harness/host-interactive-consent.js');

after(() => {
  innerDispatch._setInnerDispatchToolsForTests(null);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

type FunctionTool = {
  type: 'function';
  name: string;
  description: string;
  strict?: boolean;
  parameters: Record<string, unknown>;
  needsApproval?: (...args: unknown[]) => boolean | Promise<boolean>;
  invoke: (...args: unknown[]) => unknown | Promise<unknown>;
};

type ScriptedResponse = Array<Record<string, unknown>>;

async function* modelStream(
  this: { getResponse: (request: unknown) => Promise<Record<string, unknown>> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = Array.isArray(response.output) ? response.output : [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => item.type === 'function_call') ? 'tool_calls' : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

function scriptedModel(responses: ScriptedResponse[]) {
  let calls = 0;
  const inputs: unknown[] = [];
  return {
    calls: () => calls,
    inputs: () => inputs,
    async getResponse(request: unknown) {
      inputs.push(structuredClone(request));
      const output = responses[Math.min(calls, responses.length - 1)] ?? [];
      calls += 1;
      return {
        responseId: `provider-neutral-response-${calls}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output,
      };
    },
    getStreamedResponse: modelStream,
  };
}

const assistantText = (text: string) => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

const functionCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call',
  callId,
  name,
  arguments: JSON.stringify(args),
});

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('legacy Runner.run must remain unreachable');
  };
  return runner;
}

function strictSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      ...properties,
      optional_context: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
      },
    },
    required: [...required, 'optional_context'],
    additionalProperties: false,
  };
}

function recordingTool(input: {
  name: string;
  properties?: Record<string, unknown>;
  required?: string[];
  result?: string;
  seen: Array<Record<string, unknown>>;
  needsApproval?: FunctionTool['needsApproval'];
}): FunctionTool {
  return brackets.wrapToolForHarness({
    type: 'function',
    name: input.name,
    description: `Recording-only ${input.name} acceptance fixture.`,
    strict: true,
    parameters: strictSchema(input.properties ?? {}, input.required ?? []),
    needsApproval: input.needsApproval ?? (async () => false),
    invoke: async (_context: unknown, raw: string) => {
      input.seen.push(JSON.parse(raw) as Record<string, unknown>);
      return input.result ?? JSON.stringify({ ok: true, fixture: input.name });
    },
  } as never) as FunctionTool;
}

function bindSurface(sessionId: string, agent: object, tools: FunctionTool[]): void {
  const sealed = envelopes.sealAgentCapabilityUniverse({
    sessionId,
    universeTools: tools,
    activeToolNames: tools.map((tool) => tool.name),
    policyHash: 'provider-neutral-no-random-gate-v1',
    budget: {
      maxUncachedTokens: 4_000,
      maxModelCalls: 8,
      maxToolCalls: 12,
      maxElapsedMs: 60_000,
    },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
}

function sdkScriptedModel(responses: ScriptedResponse[]) {
  let calls = 0;
  const inputs: unknown[] = [];
  return {
    calls: () => calls,
    inputs: () => inputs,
    async getResponse(request: unknown) {
      inputs.push(structuredClone(request));
      const selected = responses[Math.min(calls, responses.length - 1)] ?? [];
      calls += 1;
      const output = selected.map((item, index) => {
        if (item.type === 'function_call') {
          return {
            ...item,
            id: typeof item.id === 'string' ? item.id : `sdk-fc-${calls}-${index}`,
            status: 'completed',
          };
        }
        if (item.type === 'message') {
          const content = Array.isArray(item.content)
            ? item.content.map((part) => ({ ...part, providerData: {} }))
            : item.content;
          return {
            ...item,
            id: typeof item.id === 'string' ? item.id : `sdk-message-${calls}-${index}`,
            content,
          };
        }
        return item;
      });
      return {
        responseId: `legacy-sdk-matrix-response-${calls}`,
        usage: new sdk.Usage(),
        output,
      };
    },
    getStreamedResponse: modelStream,
  };
}

function sdkRecordingTool(input: {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  seen: Array<Record<string, unknown>>;
}): FunctionTool {
  const shape = Object.fromEntries(
    Object.keys(input.args).map((key) => [key, z.unknown()]),
  );
  return brackets.wrapToolForHarness(sdk.tool({
    name: input.name,
    description: `Recording-only legacy SDK ${input.name} acceptance fixture.`,
    parameters: z.object(shape),
    needsApproval: async () => false,
    execute: async (args) => {
      input.seen.push(structuredClone(args) as Record<string, unknown>);
      return input.result ?? JSON.stringify({ ok: true, fixture: input.name });
    },
  })) as unknown as FunctionTool;
}

const legacyMatrixSession = eventlog.createSession({
  id: 'discord-like-legacy-sdk-matrix',
  kind: 'chat',
  channel: 'discord',
});
let legacyMatrixTurn = 0;

async function runLegacySdkSource(input: {
  prompt: string;
  tools?: FunctionTool[];
  responses: ScriptedResponse[];
}) {
  legacyMatrixTurn += 1;
  const source = eventlog.appendEvent({
    sessionId: legacyMatrixSession.id,
    turn: legacyMatrixTurn,
    role: 'user',
    type: 'user_input_received',
    data: { text: input.prompt },
  });
  assert.ok(recordTurnGraphShadow({
    identity: {
      sessionId: legacyMatrixSession.id,
      sourceUserSeq: source.seq,
      turn: source.turn,
    },
  }), 'legacy SDK fixture persisted the accepted-source graph');
  const model = sdkScriptedModel(input.responses);
  const tools = input.tools ?? [];
  const agent = new sdk.Agent({
    name: `Legacy SDK matrix turn ${legacyMatrixTurn}`,
    instructions: 'Complete the accepted request.',
    model: model as never,
    tools: tools as never,
  });
  bindSurface(legacyMatrixSession.id, agent, tools);
  const parent = {
    sessionId: legacyMatrixSession.id,
    sourceUserSeq: source.seq,
    turn: legacyMatrixTurn,
    counter: new brackets.ToolCallsCounter(12),
    behaviorScopeId: `${legacyMatrixSession.id}::turn:${legacyMatrixTurn}`,
  };
  let outcome: Awaited<ReturnType<typeof __defaultRunRunner>> | undefined;
  let error: unknown;
  try {
    outcome = await brackets.withHarnessRunContext(parent, () => __defaultRunRunner(
      new sdk.Runner(),
      agent as never,
      [{ role: 'user', content: input.prompt }] as never,
      {
        maxTurns: 6,
        tracingDisabled: true,
        context: {
          sessionId: legacyMatrixSession.id,
          sourceUserSeq: source.seq,
          turn: legacyMatrixTurn,
        },
      } as never,
    ));
  } catch (caught) {
    error = caught;
  }
  const db = eventlog.openEventLog();
  const counts = Object.fromEntries([
    'accepted_task_resolutions',
    'accepted_task_authority',
    'accepted_turn_call_authorities',
    'logical_tool_calls',
    'physical_dispatches',
    'logical_call_settlements',
    'evidence_receipts',
  ].map((table) => [table, (db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ? AND source_user_seq = ?`,
  ).get(legacyMatrixSession.id, source.seq) as { n: number }).n]));
  return { source, model, outcome, error, counts };
}

const FORBIDDEN_PUBLIC_GATE =
  /tool_authority_failed|authority_conflict|lacks exact live capability attestation|fail[- ]closed/i;

const session = eventlog.createSession({
  id: 'discord-like-provider-neutral-matrix',
  kind: 'chat',
  channel: 'discord',
});
let turn = 0;

async function runAcceptedSource(input: {
  label: string;
  prompt: string;
  tools?: FunctionTool[];
  responses: ScriptedResponse[];
  expectedBodies?: number;
  bodyCount?: () => number;
}) {
  turn += 1;
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn,
    role: 'user',
    type: 'user_input_received',
    data: { text: input.prompt },
  });
  const tools = input.tools ?? [];
  const model = scriptedModel(input.responses);
  const agent = { model, tools, instructions: 'Complete the accepted request.' };
  bindSurface(session.id, agent, tools);
  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn,
    counter: new brackets.ToolCallsCounter(12),
    behaviorScopeId: `${session.id}::turn:${turn}`,
  };
  const options = {
    maxTurns: 6,
    hostTurnEngine: 'host_v1',
    context: { sessionId: session.id, sourceUserSeq: source.seq, turn },
  } as const;
  let outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ role: 'user', content: input.prompt }] as never,
    options as never,
  ));
  let approvals = 0;
  let approvalGateCrossings: number | null = null;
  if (outcome.hasInterruptions) {
    const beforeApproval = eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS crossings
      FROM physical_dispatches
      WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as { crossings: number };
    approvalGateCrossings = beforeApproval.crossings;
    const state = HostInterruptState.fromString(outcome.serializedState!);
    const pending = state.getInterruptions();
    approvals = pending.length;
    for (const interruption of pending) state.approve(interruption);
    outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
      throwingRunner() as never,
      agent as never,
      state as never,
      options as never,
    ));
  }

  assert.equal(outcome.terminal, undefined,
    `${input.label} reached a generic host terminal: ${JSON.stringify(outcome.terminal)}`);
  assert.ok(outcome.finalOutput, `${input.label} produced no final output`);
  assert.doesNotMatch(JSON.stringify(outcome), FORBIDDEN_PUBLIC_GATE, input.label);
  if (input.bodyCount && input.expectedBodies !== undefined) {
    assert.equal(input.bodyCount(), input.expectedBodies, `${input.label}: recording bodies`);
  }
  const db = eventlog.openEventLog();
  const ledger = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_calls,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?) AS crossings
  `).get(session.id, source.seq, session.id, source.seq) as {
    logical_calls: number;
    crossings: number;
  };
  return { outcome, approvals, approvalGateCrossings, ledger, source, model };
}

async function runGraphNeutralSurpriseWrite(input: {
  label: string;
  prompt: string;
  tool: FunctionTool;
  callId: string;
  name: string;
  args: Record<string, unknown>;
}) {
  turn += 1;
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn,
    role: 'user',
    type: 'user_input_received',
    data: { text: input.prompt },
  });
  const model = scriptedModel([
    [functionCall(input.callId, input.name, input.args)],
    [assistantText(`${input.label} was repaired without unplanned I/O.`)],
  ]);
  const agent = {
    model,
    tools: [input.tool],
    instructions: 'Repair any write that is outside the exact accepted source coverage.',
  };
  bindSurface(session.id, agent, [input.tool]);
  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn,
    counter: new brackets.ToolCallsCounter(12),
    behaviorScopeId: `${session.id}::turn:${turn}`,
  };
  const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ role: 'user', content: input.prompt }] as never,
    {
      maxTurns: 4,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn },
    } as never,
  ));
  const ledger = eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_calls,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?) AS crossings
  `).get(session.id, source.seq, session.id, source.seq) as {
    logical_calls: number;
    crossings: number;
  };
  return { source, model, outcome, ledger };
}

test('provider-neutral authorized requests cross unrelated capabilities without random gates', async (t) => {
  assert.equal(
    planScopes.getPlanScope(session.id),
    null,
    'the accepted-request matrix must not borrow a preseeded PlanScope',
  );
  await t.test('simple chat', async () => {
    const result = await runAcceptedSource({
      label: 'simple chat',
      prompt: 'Explain recursion in one sentence.',
      responses: [[assistantText('Recursion is a process defined in terms of smaller instances of itself.')]],
    });
    assert.deepEqual(result.ledger, { logical_calls: 0, crossings: 0 });
    assert.equal(result.approvals, 0);
  });

  const directCases: Array<{
    label: string;
    prompt: string;
    name: string;
    args: Record<string, unknown>;
    properties: Record<string, unknown>;
    required: string[];
    write: boolean;
    result?: string;
  }> = [
    {
      label: 'local pure read',
      prompt: 'List the local workspace roots.',
      name: 'workspace_roots',
      args: {},
      properties: {},
      required: [],
      write: false,
    },
    {
      label: 'reversible local file create',
      prompt: 'Create a small draft file in the selected workspace.',
      name: 'write_file',
      args: { path: '/fixture/draft.txt', content: 'draft', mode: 'create', append: null },
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        mode: { anyOf: [{ type: 'string', enum: ['create', 'append', 'overwrite'] }, { type: 'null' }] },
        append: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
      },
      required: ['path', 'content', 'mode', 'append'],
      write: true,
    },
    {
      label: 'Composio discovery read',
      prompt: 'Find the connected calendar search action.',
      name: 'composio_search_tools',
      args: { queries: [{ use_case: 'find calendar events' }] },
      properties: {
        queries: {
          type: 'array',
          items: {
            type: 'object',
            properties: { use_case: { type: 'string' } },
            required: ['use_case'],
            additionalProperties: false,
          },
        },
      },
      required: ['queries'],
      write: false,
    },
    {
      label: 'MCP inventory read',
      prompt: 'List matching tools from the configured calendar MCP.',
      name: 'mcp_list_tools',
      args: { server: 'fixture-calendar', query: 'events', limit: 5 },
      properties: {
        server: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' },
      },
      required: ['server', 'query', 'limit'],
      write: false,
    },
    {
      label: 'browser status read',
      prompt: 'Check whether browser work is available.',
      name: 'browser_harness_status',
      args: {},
      properties: {},
      required: [],
      write: false,
    },
    {
      label: 'Workspace create',
      prompt: 'Create a Workspace for the fixture project.',
      name: 'space_save',
      args: { slug: 'fixture-space', title: 'Fixture Space' },
      properties: {
        slug: { type: 'string' }, title: { type: 'string' },
      },
      required: ['slug', 'title'],
      write: true,
    },
    {
      label: 'Workspace work/read',
      prompt: 'Read the current Fixture Workspace.',
      name: 'space_get',
      args: { slug: 'fixture-space' },
      properties: { slug: { type: 'string' } },
      required: ['slug'],
      write: false,
    },
    {
      label: 'Workspace edit',
      prompt: 'Change the Fixture Workspace heading.',
      name: 'space_edit_view',
      args: { slug: 'fixture-space', edits: [{ find: 'Fixture', replace: 'Updated Fixture' }] },
      properties: {
        slug: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { find: { type: 'string' }, replace: { type: 'string' } },
            required: ['find', 'replace'],
            additionalProperties: false,
          },
        },
      },
      required: ['slug', 'edits'],
      write: true,
    },
    {
      label: 'workflow author',
      prompt: 'Author a disabled fixture workflow.',
      name: 'workflow_create',
      args: { name: 'fixture-workflow', description: 'Fixture workflow', steps: [] },
      properties: {
        name: { type: 'string' }, description: { type: 'string' }, steps: { type: 'array' },
      },
      required: ['name', 'description', 'steps'],
      write: true,
      result: toolRegistry.withTerminalAuthoringEvidenceReceipt(
        'workflow_create',
        'Created disabled workflow fixture-workflow.',
      ),
    },
    {
      label: 'workflow change',
      prompt: 'Change the fixture workflow description.',
      name: 'workflow_update',
      args: { name: 'fixture-workflow', description: 'Updated fixture workflow' },
      properties: { name: { type: 'string' }, description: { type: 'string' } },
      required: ['name', 'description'],
      write: true,
    },
    {
      label: 'workflow run',
      prompt: 'Run the fixture workflow now.',
      name: 'workflow_run',
      args: { name: 'fixture-workflow', inputs: '{}' },
      properties: { name: { type: 'string' }, inputs: { type: 'string' } },
      required: ['name', 'inputs'],
      write: false,
    },
  ];

  for (const [index, candidate] of directCases.entries()) {
    if (candidate.write) continue;
    await t.test(candidate.label, async () => {
      const seen: Array<Record<string, unknown>> = [];
      const tool = recordingTool({
        name: candidate.name,
        properties: candidate.properties,
        required: candidate.required,
        result: candidate.result,
        seen,
        needsApproval: candidate.name === 'write_file'
          ? taxonomy.needsApprovalFromTaxonomy(candidate.name, {
              // The fixture path is recording-only; this signal represents the
              // same allowed-root proof the real write_file adapter computes.
              computeInsideWorkspace: () => true,
            })
          : taxonomy.needsApprovalFromTaxonomy(candidate.name),
      });
      const callId = `matrix-direct-${index}`;
      const result = await runAcceptedSource({
        label: candidate.label,
        prompt: candidate.prompt,
        tools: [tool],
        responses: [
          [functionCall(callId, candidate.name, candidate.args)],
          [assistantText(`${candidate.label} completed`) ],
        ],
        bodyCount: () => seen.length,
        expectedBodies: 1,
      });
      assert.equal(seen[0]?.optional_context, null,
        `${candidate.label}: strict nullable omission was not materialized`);
      assert.equal(result.ledger.logical_calls, 1);
      assert.equal(result.ledger.crossings, 1);
      assert.equal(
        result.approvals,
        0,
        `${candidate.label}: authorized reversible work was interrupted for approval `
          + `before ${result.approvalGateCrossings ?? 'unknown'} physical crossings`,
      );
    });
  }

  for (const [index, candidate] of directCases.entries()) {
    if (!candidate.write) continue;
    await t.test(`${candidate.label} without accepted coverage repairs before I/O`, async (caseTest) => {
      const seen: Array<Record<string, unknown>> = [];
      const tool = recordingTool({
        name: candidate.name,
        properties: candidate.properties,
        required: candidate.required,
        result: candidate.result,
        seen,
        needsApproval: candidate.name === 'write_file'
          ? taxonomy.needsApprovalFromTaxonomy(candidate.name, {
              computeInsideWorkspace: () => true,
            })
          : taxonomy.needsApprovalFromTaxonomy(candidate.name),
      });
      const callId = `matrix-graph-neutral-surprise-${index}`;
      const result = await runGraphNeutralSurpriseWrite({
        label: candidate.label,
        prompt: candidate.prompt,
        tool,
        callId,
        name: candidate.name,
        args: candidate.args,
      });
      const db = eventlog.openEventLog();
      const workBindingCount = (db.prepare(`
        SELECT COUNT(*) AS n FROM expected_work_call_bindings
         WHERE session_id = ? AND source_user_seq = ?
      `).get(session.id, result.source.seq) as { n: number }).n;
      const hostBindings = db.prepare(`
        SELECT logical_tool_call_id, tool_name, effect, binding_kind
          FROM host_call_capability_bindings
         WHERE session_id = ? AND source_user_seq = ?
         ORDER BY logical_tool_call_id
      `).all(session.id, result.source.seq);
      caseTest.diagnostic(`graph-neutral surprise observation: ${JSON.stringify({
        label: candidate.label,
        hasInterruptions: result.outcome.hasInterruptions,
        interruptionCount: result.outcome.interruptions?.length ?? 0,
        terminal: result.outcome.terminal ?? null,
        modelCalls: result.model.calls(),
        bodies: seen.length,
        physicalCrossings: result.ledger.crossings,
        logicalCalls: result.ledger.logical_calls,
        workBindingCount,
        hostBindings,
      })}`);
      assert.equal(seen.length, 0, `${candidate.label}: graph-neutral surprise write crossed I/O`);
      assert.equal(result.ledger.crossings, 0, `${candidate.label}: surprise write crossed physically`);
      assert.equal(
        Boolean(result.outcome.hasInterruptions),
        false,
        `${candidate.label}: surprise write asked the user instead of returning a paired repair`,
      );
      assert.equal(result.outcome.terminal, undefined,
        `${candidate.label}: surprise write became a public terminal`);
      assert.equal(result.model.calls(), 2,
        `${candidate.label}: paired repair did not reach the next model step`);
      assert.deepEqual(functionCallIds(result.outcome.history), [callId]);
      assert.deepEqual(functionResultIds(result.outcome.history), [callId]);
      assert.deepEqual(unmatchedFunctionCallIds({ input: result.outcome.history }), []);
      assert.equal(
        result.outcome.finalOutput,
        `${candidate.label} was repaired without unplanned I/O.`,
      );
      assert.doesNotMatch(JSON.stringify(result.outcome), FORBIDDEN_PUBLIC_GATE, candidate.label);
    });
  }

  await t.test('call_tool strict nullable normalization', async () => {
    const carrier = brackets.wrapToolForHarness(callTools.buildCallTool({
      reachableBuiltinNames: new Set(['mcp_list_tools']),
      firstClassNames: new Set(['call_tool']),
      deniedNames: new Set(),
      mcpToolScope: null,
      controlOnlyBuiltins: true,
      admitBuiltinAcquisition: async (name) => name === 'mcp_list_tools'
        ? { ok: true }
        : { ok: false, kind: 'requires_readmission', outside: [name] },
    })) as FunctionTool;
    const result = await runAcceptedSource({
      label: 'call_tool strict nullable normalization',
      prompt: 'Use the deferred MCP inventory carrier for the calendar server.',
      tools: [carrier],
      responses: [
        [functionCall('matrix-call-tool-normalization', 'call_tool', {
          name: 'mcp_list_tools',
          args_json: JSON.stringify({
            server: 'fixture-not-configured', query: 'calendar inventory', limit: 1,
          }),
        })],
        [assistantText('Deferred MCP inventory completed without an authority conflict.')],
      ],
    });
    assert.equal(result.ledger.logical_calls, 1);
    assert.equal(result.ledger.crossings, 0,
      'missing fixture MCP stays a local corrective with no provider I/O');
  });

  await t.test('browser/web external read through a fake immutable provider port', async () => {
    const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
    const priorPorts = ports.listProductionCapabilityPorts();
    const manifest = manifests.attachSemanticContract({
      version: 1,
      manifestId: 'cap:fixture:web-search',
      providerKind: 'native_mcp',
      operationId: 'fixture_web__search',
      providerIdentity: 'fixture-browser-provider',
      providerVersion: '1',
      operationVersion: '1',
      definitionFingerprint: '8'.repeat(64),
      effect: 'read',
      accountId: 'fixture-browser-account',
      idempotency: { required: false, policy: 'none' },
      reconciliation: { supported: false, policy: 'none' },
      outputContract: { kind: 'web_results' },
      purpose: 'collect_records',
      evidenceContract: { kinds: ['records'], readbackRequired: false },
      provenance: {
        issuer: 'provider-neutral-acceptance',
        issuedAt: '2026-08-23T00:00:00.000Z',
        trusted: true,
      },
      lifecycle: { state: 'current' },
    });
    let providerBodies = 0;
    let carrierBodies = 0;
    const invoke = async () => {
      providerBodies += 1;
      return { records: [{ title: 'Fixture result' }] };
    };
    const factory = catalogs.createHostCapabilityCatalogFactory();
    factory.register({
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect,
      account: manifest.accountId,
      manifestDigest: manifests.capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint,
      sourceSchemaFingerprint: '7'.repeat(32),
      manifest,
      invoke,
    });
    catalogs.installHostCapabilityCatalogFactory(factory);
    ports.clearProductionCapabilityPorts();
    assert.deepEqual(ports.registerFixtureCapabilityPort(
      ports.productionPortIdentityFromManifest(manifest),
      { invoke },
    ), { ok: true });

    try {
      const carrier = brackets.wrapToolForHarness({
        type: 'function',
        name: 'call_tool',
        description: 'Fixture immutable provider carrier.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' }, args_json: { type: 'string' } },
          required: ['name', 'args_json'],
          additionalProperties: false,
        },
        needsApproval: async () => false,
        invoke: async () => {
          carrierBodies += 1;
          throw new Error('generic carrier body must not replace the exact provider port');
        },
      }) as FunctionTool;
      const result = await runAcceptedSource({
        label: 'browser/web external read',
        prompt: 'Search the current web for the fixture release note.',
        tools: [carrier],
        responses: [
          [functionCall('matrix-web-port', 'call_tool', {
            name: manifest.operationId,
            args_json: JSON.stringify({ query: 'fixture release note' }),
          })],
          [assistantText('The fixture web result was returned.')],
        ],
      });
      assert.equal(providerBodies, 1, JSON.stringify({
        terminal: result.outcome.terminal,
        history: result.outcome.history,
        ledger: result.ledger,
      }));
      assert.equal(carrierBodies, 0);
      assert.deepEqual(result.ledger, { logical_calls: 1, crossings: 1 });
      assert.equal(result.approvals, 0);
    } finally {
      ports.clearProductionCapabilityPorts();
      for (const prior of priorPorts) {
        ports.registerFixtureCapabilityPort(prior.identity, prior.port);
      }
      catalogs.installHostCapabilityCatalogFactory(priorCatalog);
    }
  });
});

test('generic consent under strict policy preserves real gates without granting workflow work globally', () => {
  const intrinsicallyLocal = [
    taxonomy.decideToolApproval({
      toolName: 'write_file',
      args: { path: '/fixture/draft.txt', content: 'draft', append: false },
      insideWorkspaceHint: true,
    }),
    taxonomy.decideToolApproval({ toolName: 'space_save' }),
    taxonomy.decideToolApproval({ toolName: 'space_edit_view' }),
  ];
  assert.deepEqual(
    intrinsicallyLocal.map((decision) => decision.needsApproval),
    [false, false, false],
    JSON.stringify(intrinsicallyLocal),
  );

  // These remain gated by the global strict policy when inspected in
  // isolation. The provider-neutral host matrix above is the RED that requires
  // the exact accepted source/task to cover the exact reversible call. This
  // prevents the acceptance from passing via YOLO or a preseeded PlanScope.
  const acceptedTaskDependent = [
    taxonomy.decideToolApproval({ toolName: 'workflow_create' }),
    taxonomy.decideToolApproval({ toolName: 'workflow_update' }),
    taxonomy.decideToolApproval({
      toolName: 'fixture_reversible_mutation',
      kindHint: 'write',
    }),
  ];
  assert.deepEqual(
    acceptedTaskDependent.map((decision) => decision.needsApproval),
    [true, true, true],
    JSON.stringify(acceptedTaskDependent),
  );

  const destructive = taxonomy.decideToolApproval({
    toolName: 'fixture_reversible_mutation',
    kindHint: 'write',
    isDestructiveHint: true,
  });
  assert.deepEqual(
    { gate: destructive.needsApproval, reason: destructive.reason },
    { gate: true, reason: 'destructive-hint' },
  );

  const admin = taxonomy.decideToolApproval({
    toolName: 'fixture_runtime_configuration_change',
    kindHint: 'admin',
  });
  assert.deepEqual(
    { gate: admin.needsApproval, reason: admin.reason },
    { gate: true, reason: 'admin' },
  );

  const irreversible = [
    'OUTLOOK_SEND_EMAIL',
    'GMAIL_REPLY_TO_THREAD',
    'SLACK_SEND_MESSAGE',
  ].map((toolName) => taxonomy.decideToolApproval({ toolName }));
  assert.deepEqual(
    irreversible.map((decision) => decision.needsApproval),
    [true, true, true],
    JSON.stringify(irreversible),
  );

  const missingCredential = attemptOutcomes.classifyAttemptOutcome({
    preDispatch: true,
    connectionMissing: true,
  });
  assert.deepEqual({
    kind: missingCredential.kind,
    action: missingCredential.directive.action,
    retry: missingCredential.directive.retrySameCandidate,
  }, {
    kind: 'auth_failure',
    action: 'recover_connection',
    retry: false,
  });

  const ambiguousAccount = attemptOutcomes.classifyAttemptOutcome({
    preDispatch: true,
    needsUserInput: true,
  });
  assert.deepEqual({
    kind: ambiguousAccount.kind,
    action: ambiguousAccount.directive.action,
    retry: ambiguousAccount.directive.retrySameCandidate,
  }, {
    kind: 'input_required',
    action: 'ask_user',
    retry: false,
  });
});

type LocalPlanningDefinition = import(
  '../runtime/harness/local-planning-capability.js'
).AuthorizedLocalPlanningDefinitionV1;

function exactLocalPlanDraft(input: {
  label: string;
  operationId: string;
  definition: LocalPlanningDefinition;
}) {
  const destinationPosture = input.definition.descriptor.destinationPosture;
  return {
    criteria: [`Complete exactly one accepted ${input.label} operation.`],
    cardinality: { count: 1, fields: [] },
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
        id: input.operationId,
        effect: 'local_write',
        coverage: null,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
    bindings: [{
      operationId: input.operationId,
      role: 'destination',
      capabilityRef: input.definition.capabilityRef,
      evidence: ['local_commit_receipt'],
    }],
    deliverables: [{
      id: `${input.operationId}-deliverable`,
      kind: input.definition.descriptor.deliverableKind,
    }],
    evidenceRequirements: ['local_commit_receipt'],
  };
}

test('exact accepted local plans bind reversible Workspace, workflow, and file work before execution', async (t) => {
  const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  t.after(() => catalogs.installHostCapabilityCatalogFactory(priorCatalog));
  const cases = [
    {
      label: 'reversible local file create',
      name: 'write_file',
      prompt: 'Create one new fixture draft file with the supplied content.',
      args: { path: '/fixture/planned-draft.txt', content: 'planned draft', mode: 'create', append: null },
      result: JSON.stringify({ ok: true, path: '/fixture/planned-draft.txt', created: true }),
    },
    {
      label: 'Workspace create',
      name: 'space_save',
      prompt: 'Create one Workspace named Planned Fixture Space.',
      args: { slug: 'planned-fixture-space', title: 'Planned Fixture Space' },
      result: JSON.stringify({ ok: true, slug: 'planned-fixture-space', revision: 1 }),
    },
    {
      label: 'Workspace edit',
      name: 'space_edit_view',
      prompt: 'Change the heading in the existing Planned Fixture Workspace.',
      args: {
        slug: 'planned-fixture-space',
        edits: [{ find: 'Fixture', replace: 'Updated Fixture' }],
      },
      result: JSON.stringify({ ok: true, slug: 'planned-fixture-space', revision: 2 }),
    },
    {
      label: 'workflow author',
      name: 'workflow_create',
      prompt: 'Author one disabled workflow named planned-fixture-workflow.',
      args: { name: 'planned-fixture-workflow', description: 'Planned fixture workflow', steps: [] },
      result: toolRegistry.withTerminalAuthoringEvidenceReceipt(
        'workflow_create',
        'Created disabled workflow planned-fixture-workflow.',
      ),
    },
    {
      label: 'workflow change',
      name: 'workflow_update',
      prompt: 'Change the description of the existing planned-fixture-workflow.',
      args: { name: 'planned-fixture-workflow', description: 'Updated planned fixture workflow' },
      result: JSON.stringify({ ok: true, name: 'planned-fixture-workflow', revision: 2 }),
    },
  ] as const;

  for (const [index, candidate] of cases.entries()) {
    await t.test(candidate.label, async (caseTest) => {
      const plannedSession = eventlog.createSession({
        id: `discord-like-exact-local-plan-${index}`,
        kind: 'chat',
        channel: 'discord',
      });
      const source = eventlog.appendEvent({
        sessionId: plannedSession.id,
        turn: 1,
        role: 'user',
        type: 'user_input_received',
        data: { text: candidate.prompt },
      });
      const observed = await localPlanning.observeCurrentLocalPlanningDefinition({
        name: candidate.name,
        carrier: 'work_call',
      });
      assert.equal(observed.ok, true, JSON.stringify(observed));
      if (!observed.ok) return;
      const definition = observed.definition;
      assert.equal(definition.provenance, 'authorized_local_registry');
      assert.equal(definition.carrier, 'work_call');
      assert.equal(definition.descriptor.effect, 'local_write');
      assert.equal(definition.accountIdentity, 'local_registry:host');
      if (candidate.name === 'write_file') {
        assert.equal(localPlanning.localPlanningArgumentsMatch(definition, candidate.args), true);
      }

      const primed = await semanticPlanning.primePrimaryModelPlanningCatalog({
        sessionId: plannedSession.id,
        sourceUserSeq: source.seq,
      });
      assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
      if (!primed.ok) return;
      assert.equal(
        primed.planning.capabilities.some((entry) => entry.id === definition.capabilityRef),
        false,
        'a local ref must be disclosed by foreground tool_search, not planted in the initial card',
      );

      let innerApprovalChecks = 0;
      let bodies = 0;
      const seen: Array<Record<string, unknown>> = [];
      const bodyAuthority: Array<Record<string, unknown>> = [];
      const fakeInner: FunctionTool = {
        type: 'function',
        name: candidate.name,
        description: `Recording-only planned ${candidate.label} fixture.`,
        strict: true,
        parameters: observed.schema,
        needsApproval: async () => {
          innerApprovalChecks += 1;
          return true;
        },
        invoke: async (_context: unknown, raw: string) => {
          const parsedBodyArgs = JSON.parse(raw) as Record<string, unknown>;
          const ambient = brackets.harnessRunContextStorage.getStore();
          const currentLogical = attemptIdentity.currentLogicalCall();
          const reconstructed = currentLogical
            ? logicalContracts.durableLogicalCallContract(
                currentLogical.acceptedTaskId,
                candidate.name,
                parsedBodyArgs,
              )
            : null;
          bodyAuthority.push({
            currentLogical: currentLogical
              ? {
                  acceptedTaskId: currentLogical.acceptedTaskId,
                  logicalToolCallId: currentLogical.logicalToolCallId,
                  toolName: currentLogical.toolName,
                  argumentDigest: currentLogical.argumentDigest,
                }
              : null,
            reconstructed: reconstructed
              ? { toolName: reconstructed.toolName, argumentDigest: reconstructed.argumentDigest }
              : null,
            lease: ambient?.dispatchLease
              ? {
                  sessionId: ambient.dispatchLease.sessionId,
                  sourceUserSeq: ambient.dispatchLease.sourceUserSeq,
                  acceptedTaskId: ambient.dispatchLease.acceptedTaskId,
                  logicalToolCallId: ambient.dispatchLease.logicalToolCallId,
                  scopeId: ambient.dispatchLease.scopeId,
                  leaseId: ambient.dispatchLease.leaseId,
                  current: dispatchLeases.isDispatchLeaseCurrent(ambient.dispatchLease),
                }
              : null,
          });
          const db = eventlog.openEventLog();
          const binding = db.prepare(`
            SELECT requirement_id, tool_name, argument_digest, effect_kind,
                   cardinality_kind, schema_fingerprint, schema_digest
              FROM expected_work_call_bindings
             WHERE session_id = ? AND source_user_seq = ?
               AND logical_tool_call_id = ?
          `).get(plannedSession.id, source.seq, `planned-local-work-${index}`) as {
            requirement_id: string;
            tool_name: string;
            argument_digest: string;
            effect_kind: string;
            cardinality_kind: string;
            schema_fingerprint: string | null;
            schema_digest: string | null;
          } | undefined;
          assert.ok(binding, 'exact work binding must exist before the inner body');
          assert.deepEqual({
            requirementId: binding.requirement_id,
            tool: binding.tool_name,
            effect: binding.effect_kind,
            cardinality: binding.cardinality_kind,
            schemaFingerprint: binding.schema_fingerprint,
            argumentDigestLength: binding.argument_digest.length,
          }, {
            requirementId: `local-write-${index}`,
            tool: candidate.name,
            effect: 'local_write',
            cardinality: 'once',
            // Write-call schema identity is frozen in the sealed local
            // definition and the consent projection. Expected-work stores
            // schema evidence only for read refinements today.
            schemaFingerprint: null,
            argumentDigestLength: 64,
          });
          assert.equal(binding.schema_digest, null);
          bodies += 1;
          seen.push(parsedBodyArgs);
          return candidate.result;
        },
      };
      innerDispatch._setInnerDispatchToolsForTests(new Map([[candidate.name, fakeInner as never]]));
      caseTest.after(() => innerDispatch._setInnerDispatchToolsForTests(null));

      const operationId = `local-write-${index}`;
      const workCallId = `planned-local-work-${index}`;
      let modelCalls = 0;
      const modelInputs: unknown[] = [];
      let frozenBeforeWorkCall: Record<string, unknown> | null = null;
      const model = {
        async getResponse(request: unknown) {
          modelInputs.push(structuredClone(request));
          modelCalls += 1;
          const serialized = JSON.stringify(request);
          const tools = ((request as { tools?: Array<{ name?: string }> }).tools ?? [])
            .map((tool) => tool.name ?? '');
          let output: unknown[];
          if (modelCalls === 1) {
            assert.ok(tools.includes('tool_search'));
            assert.equal(
              tools.includes('plan_task'),
              false,
              'plan_task stays absent until foreground search discloses one exact citable ref',
            );
            assert.equal(
              tools.includes('work_call'),
              false,
              'write work_call stays absent until plan_task freezes exact work',
            );
            assert.doesNotMatch(serialized, new RegExp(definition.capabilityRef));
            output = [functionCall(`planned-local-search-${index}`, 'tool_search', {
              query: candidate.name,
              role_key: 'clause-0:write',
              limit: 8,
            })];
          } else if (modelCalls === 2) {
            assert.ok(
              tools.includes('plan_task'),
              'the same opaque planning authority must expose plan_task after exact disclosure',
            );
            assert.match(serialized, new RegExp(definition.capabilityRef));
            output = [functionCall(`planned-local-plan-${index}`, 'plan_task', {
              preamble: `I’ll complete the requested ${candidate.label} now.`,
              draft: exactLocalPlanDraft({ label: candidate.label, operationId, definition }),
            })];
          } else if (modelCalls === 3) {
            assert.ok(tools.includes('work_call'), 'settled plan_task must expose exact planned work');
            assert.equal(tools.includes('plan_task'), false, 'settled plan_task is one-shot');
            const db = eventlog.openEventLog();
            const authority = db.prepare(`
              SELECT accepted_task_id, state, expected_work_required,
                     work_contract_id, graph_event_id, graph_id, graph_hash
                FROM accepted_task_authority
               WHERE session_id = ? AND source_user_seq = ?
            `).get(plannedSession.id, source.seq) as Record<string, unknown> | undefined;
            const root = db.prepare(`
              SELECT accepted_task_id, authority_kind, effect_ceiling,
                     effect_bounds_json, state
                FROM accepted_turn_call_authorities
               WHERE session_id = ? AND source_user_seq = ?
            `).get(plannedSession.id, source.seq) as {
              accepted_task_id: string;
              authority_kind: string;
              effect_ceiling: string;
              effect_bounds_json: string;
              state: string;
            } | undefined;
            const contractRow = db.prepare(`
              SELECT planner_source, operation_count, contract_json
                FROM accepted_task_work_contracts
               WHERE session_id = ? AND source_user_seq = ?
            `).get(plannedSession.id, source.seq) as {
              planner_source: string;
              operation_count: number;
              contract_json: string;
            } | undefined;
            const resolution = db.prepare(`
              SELECT accepted_task_id, graph_event_id, route, work_kind,
                     effect_ceiling, external_effect_requested,
                     external_effect_kinds_json, state
                FROM accepted_task_resolutions
               WHERE session_id = ? AND source_user_seq = ?
            `).get(plannedSession.id, source.seq) as {
              accepted_task_id: string;
              graph_event_id: string;
              route: string;
              work_kind: string;
              effect_ceiling: string;
              external_effect_requested: number;
              external_effect_kinds_json: string;
              state: string;
            } | undefined;
            const authorityGraphEventId = typeof authority?.graph_event_id === 'string'
              ? authority.graph_event_id
              : null;
            const graphEvent = authorityGraphEventId
              ? eventlog.listEvents(plannedSession.id, {
                  types: ['turn_graph_compiled'],
                }).find((event) => event.id === authorityGraphEventId)
              : undefined;
            const graph = graphEvent?.data.graph as {
              classification?: {
                route?: unknown;
                goalConstraints?: { destination?: unknown; destinations?: unknown };
              };
              effectCeiling?: unknown;
            } | undefined;
            const planResult = functionResultTextFor(
              (request as { input?: unknown }).input,
              `planned-local-plan-${index}`,
            );
            assert.ok(
              contractRow,
              `plan_task must freeze expected work before the work-emitting model step; result=${planResult}`,
            );
            const contract = JSON.parse(contractRow.contract_json) as {
              operations?: Array<Record<string, unknown>>;
            };
            const operation = contract.operations?.[0];
            frozenBeforeWorkCall = {
              authority: authority
                ? {
                    acceptedTaskId: authority.accepted_task_id,
                    state: authority.state,
                    expectedWorkRequired: authority.expected_work_required,
                    contractBound: typeof authority.work_contract_id === 'string',
                    graphBound: typeof authority.graph_event_id === 'string'
                      && typeof authority.graph_id === 'string'
                      && typeof authority.graph_hash === 'string',
                  }
                : null,
              root: root
                ? {
                    acceptedTaskId: root.accepted_task_id,
                    kind: root.authority_kind,
                    effectCeiling: root.effect_ceiling,
                    effectBounds: JSON.parse(root.effect_bounds_json),
                    state: root.state,
                  }
                : null,
              plannerSource: contractRow.planner_source,
              operationCount: contractRow.operation_count,
              operation,
              resolution: resolution
                ? {
                    acceptedTaskId: resolution.accepted_task_id,
                    route: resolution.route,
                    workKind: resolution.work_kind,
                    effectCeiling: resolution.effect_ceiling,
                    externalEffectRequested: resolution.external_effect_requested,
                    externalEffectKinds: JSON.parse(resolution.external_effect_kinds_json),
                    state: resolution.state,
                  }
                : null,
              graph: graph
                ? {
                    route: graph.classification?.route,
                    effectCeiling: graph.effectCeiling,
                    destination: graph.classification?.goalConstraints?.destination ?? null,
                    destinations: graph.classification?.goalConstraints?.destinations ?? [],
                  }
                : null,
              disclosed: eventlog.listEvents(plannedSession.id, {
                types: ['capability_discovered'],
              }).some((event) => JSON.stringify(event.data).includes(definition.capabilityRef)),
            };
            assert.deepEqual(frozenBeforeWorkCall, {
              authority: {
                acceptedTaskId: `task:${plannedSession.id}#${source.seq}`,
                state: 'armed',
                expectedWorkRequired: 1,
                contractBound: true,
                graphBound: true,
              },
              root: {
                acceptedTaskId: `task:${plannedSession.id}#${source.seq}`,
                kind: 'host_v1',
                effectCeiling: 'admin',
                effectBounds: ['admin', 'compute', 'external_write', 'host_only', 'local_write', 'read'],
                state: 'open',
              },
              plannerSource: 'structured_model',
              operationCount: 1,
              operation: {
                id: operationId,
                effect: 'local_write',
                dependsOn: [],
                dataFrom: [],
                cardinality: { kind: 'once' },
              },
              resolution: null,
              graph: {
                route: 'act',
                effectCeiling: 'local_write',
                destination: {
                  posture: definition.descriptor.destinationPosture,
                  family: definition.descriptor.deliverableKind,
                  handleRequired: definition.descriptor.handleRequired,
                },
                destinations: [{
                  posture: definition.descriptor.destinationPosture,
                  family: definition.descriptor.deliverableKind,
                  handleRequired: definition.descriptor.handleRequired,
                }],
              },
              disclosed: true,
            });
            output = [functionCall(workCallId, 'work_call', {
              requirement_id: operationId,
              universe_item_id: null,
              universe_selector: null,
              seal_amendment: null,
              name: candidate.name,
              args_json: JSON.stringify(candidate.args),
            })];
          } else {
            output = [assistantText(`${candidate.label} completed from its exact accepted plan.`)];
          }
          return {
            responseId: `planned-local-response-${index}-${modelCalls}`,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            output,
          };
        },
        getStreamedResponse: modelStream,
      };

      const agent = await buildOrchestratorAgent({
        userInput: candidate.prompt,
        sessionId: plannedSession.id,
        sourceUserSeq: source.seq,
        hostFreshPlanning: primed.planning,
        allowedToolNames: [candidate.name, 'tool_search'],
        allowToolJit: true,
        mcpToolScope: {
          authority: 'none',
          reason: 'provider-neutral local planning fixture has no external authority',
          allowedServerSlugs: [],
          toolPatterns: [],
          maxTools: 0,
        },
        model: model as never,
      });
      const parent = {
        sessionId: plannedSession.id,
        sourceUserSeq: source.seq,
        turn: 1,
        counter: new brackets.ToolCallsCounter(12),
        behaviorScopeId: `${plannedSession.id}::turn:1`,
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
            target: `provider-neutral-planned-local:${candidate.name}`,
          },
        }),
      };
      const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
        throwingRunner() as never,
        agent as never,
        [{ role: 'user', content: candidate.prompt }] as never,
        {
          maxTurns: 6,
          hostTurnEngine: 'host_v1',
          context: { sessionId: plannedSession.id, sourceUserSeq: source.seq, turn: 1 },
        } as never,
      ));

      const approvalEvents = eventlog.listEvents(plannedSession.id).filter((event) =>
        ['approval_requested', 'approval_required', 'request_approval'].includes(event.type));
      const physical = eventlog.openEventLog().prepare(`
        SELECT logical_tool_call_id, state FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? ORDER BY ordinal
      `).all(plannedSession.id, source.seq);
      const workBindings = eventlog.openEventLog().prepare(`
        SELECT logical_tool_call_id, requirement_id, tool_name, effect_kind,
               cardinality_kind, argument_digest, schema_fingerprint, schema_digest
          FROM expected_work_call_bindings
         WHERE session_id = ? AND source_user_seq = ?
         ORDER BY logical_tool_call_id
      `).all(plannedSession.id, source.seq);
      const hostBindings = eventlog.openEventLog().prepare(`
        SELECT logical_tool_call_id, tool_name, operation_id, effect,
               binding_kind, capability_id, account_id,
               provider_input_schema_digest, schema_fingerprint
          FROM host_call_capability_bindings
         WHERE session_id = ? AND source_user_seq = ?
         ORDER BY logical_tool_call_id
      `).all(plannedSession.id, source.seq);
      const latestToolReturned = eventlog.listEvents(plannedSession.id, {
        types: ['tool_returned'],
      }).filter((event) => event.data.sourceUserSeq === source.seq).at(-1);
      const logicalRows = eventlog.openEventLog().prepare(`
        SELECT logical_tool_call_id, tool_name, state, outcome_kind
          FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ?
         ORDER BY logical_tool_call_id
      `).all(plannedSession.id, source.seq);
      const settlements = eventlog.openEventLog().prepare(`
        SELECT logical_tool_call_id, execution_kind, outcome_kind,
               business_call, mutating, requirement_id,
               recovery_action, physical_crossing_count
          FROM logical_call_settlements
         WHERE session_id = ? AND source_user_seq = ?
         ORDER BY logical_tool_call_id
      `).all(plannedSession.id, source.seq);
      caseTest.diagnostic(`planned local observation: ${JSON.stringify({
        label: candidate.label,
        modelCalls,
        frozenBeforeWorkCall,
        hasInterruptions: outcome.hasInterruptions,
        interruptions: (outcome.interruptions ?? []).map((interruption) => ({
          toolName: interruption.toolName,
          args: interruption.args,
        })),
        terminal: outcome.terminal ?? null,
        bodies,
        bodyAuthority,
        innerApprovalChecks,
        approvals: approvalEvents.map((event) => event.type),
        physical,
        workBindings,
        hostBindings,
        logicalRows,
        settlements,
        latestToolReturned: latestToolReturned
          ? { seq: latestToolReturned.seq, data: latestToolReturned.data }
          : null,
      })}`);
      assert.ok(frozenBeforeWorkCall, 'the real plan_task path did not freeze accepted coverage');
      assert.equal(
        Boolean(outcome.hasInterruptions),
        false,
        `${candidate.label}: exact accepted reversible plan still requested approval`,
      );
      assert.deepEqual(approvalEvents, [], `${candidate.label}: an approval callback escaped`);
      assert.equal(outcome.terminal, undefined, `${candidate.label}: generic host terminal`);
      assert.equal(bodies, 1, `${candidate.label}: recording body must execute exactly once`);
      assert.deepEqual(
        physical.filter((row) => (
          (row as { logical_tool_call_id?: unknown }).logical_tool_call_id === workCallId
        )),
        [{ logical_tool_call_id: workCallId, state: 'returned' }],
        `${candidate.label}: exact local body needs one durable returned dispatch`,
      );
      assert.equal(workBindings.length, 1, `${candidate.label}: exact work binding cardinality`);
      assert.deepEqual(
        logicalRows.find((row) => (
          (row as { logical_tool_call_id?: unknown }).logical_tool_call_id === workCallId
        )),
        {
          logical_tool_call_id: workCallId,
          tool_name: candidate.name,
          state: 'settled',
          outcome_kind: 'succeeded',
        },
        `${candidate.label}: logical call settlement state`,
      );
      assert.deepEqual(
        settlements.find((row) => (
          (row as { logical_tool_call_id?: unknown }).logical_tool_call_id === workCallId
        )),
        {
          logical_tool_call_id: workCallId,
          execution_kind: 'local_execution',
          outcome_kind: 'succeeded',
          business_call: 1,
          mutating: 1,
          requirement_id: operationId,
          recovery_action: 'settle',
          physical_crossing_count: 0,
        },
        `${candidate.label}: exact local mutation settlement`,
      );
      assert.equal(
        hostBindings.filter((row) => (
          (row as { logical_tool_call_id?: unknown }).logical_tool_call_id === workCallId
        )).length,
        1,
        `${candidate.label}: exact work_call host binding cardinality`,
      );
      assert.equal(modelCalls, 4);
      assert.equal(outcome.finalOutput, `${candidate.label} completed from its exact accepted plan.`);
      assert.equal(seen.length, 1, `${candidate.label}: effective body argument cardinality`);
      const effectiveArgs = seen[0] ?? {};
      for (const [key, value] of Object.entries(candidate.args)) {
        assert.deepEqual(
          effectiveArgs[key],
          value,
          `${candidate.label}: prepared body changed requested argument ${key}`,
        );
      }
      assert.ok(
        Object.entries(effectiveArgs).every(([key, value]) => (
          Object.prototype.hasOwnProperty.call(candidate.args, key) || value === null
        )),
        `${candidate.label}: schema preparation added a non-null unrequested argument`,
      );
      assert.equal(
        (bodyAuthority[0]?.reconstructed as { argumentDigest?: unknown } | undefined)?.argumentDigest,
        (workBindings[0] as { argument_digest?: unknown } | undefined)?.argument_digest,
        `${candidate.label}: effective prepared arguments drifted from the frozen work binding`,
      );
      assert.deepEqual(unmatchedFunctionCallIds({ input: outcome.history }), []);
      assert.doesNotMatch(JSON.stringify(outcome), FORBIDDEN_PUBLIC_GATE, candidate.label);
      assert.ok(modelInputs.length >= 3);
    });
  }
});

function exactExternalCreatePlanDraft(input: {
  label: string;
  operationId: string;
  capabilityRef: string;
  destinationFamily: string;
  source?: { operationId: string; capabilityRef: string };
  includeDestination?: boolean;
  ordinarySiblingOperationId?: string;
  ordinarySiblingCapabilityRef?: string;
  ordinarySiblingEffect?: 'local_write' | 'external_write';
  ordinarySiblingDeliverableKind?: string;
  destinationPosture?: 'create_new' | 'named_existing';
}) {
  const sourceOperations = input.source
    ? [{
        id: input.source.operationId,
        effect: 'read',
        coverage: 'complete_set',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }]
    : [];
  const sourceBindings = input.source
    ? [{
        operationId: input.source.operationId,
        role: 'source',
        capabilityRef: input.source.capabilityRef,
        evidence: ['records'],
      }]
    : [];
  const ordinarySiblingOperations = input.ordinarySiblingOperationId
    ? [{
        id: input.ordinarySiblingOperationId,
        effect: input.ordinarySiblingEffect ?? 'external_write',
        coverage: null,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }]
    : [];
  const ordinarySiblingBindings = input.ordinarySiblingOperationId
    ? [{
        operationId: input.ordinarySiblingOperationId,
        role: input.ordinarySiblingEffect === 'local_write' ? 'update' : 'destination',
        capabilityRef: input.ordinarySiblingCapabilityRef ?? input.capabilityRef,
        evidence: [input.ordinarySiblingEffect === 'local_write' ? 'local_commit_receipt' : 'receipt'],
      }]
    : [];
  return {
    criteria: [`Create exactly one ${input.label} from the supplied content.`],
    cardinality: { count: input.ordinarySiblingOperationId ? 2 : 1, fields: [] },
    destination: input.includeDestination === false
      ? null
      : {
          posture: input.destinationPosture ?? 'create_new',
          family: input.destinationFamily,
          handleRequired: true,
        },
    topology: {
      version: 1,
      operations: [...sourceOperations, ...ordinarySiblingOperations, {
        id: input.operationId,
        effect: 'external_write',
        coverage: null,
        dependsOn: input.source ? [input.source.operationId] : [],
        dataFrom: input.source ? [input.source.operationId] : [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
    bindings: [...sourceBindings, ...ordinarySiblingBindings, {
      operationId: input.operationId,
      role: 'destination',
      capabilityRef: input.capabilityRef,
      evidence: ['receipt'],
    }],
    deliverables: [
      ...(input.ordinarySiblingOperationId ? [{
        id: `${input.ordinarySiblingOperationId}-deliverable`,
        kind: input.ordinarySiblingDeliverableKind ?? input.destinationFamily,
      }] : []),
      {
        id: `${input.operationId}-deliverable`,
        kind: input.destinationFamily,
      },
    ],
    evidenceRequirements: ['receipt'],
  };
}

test('exact accepted external plans execute ordinary Sheet and Google Doc creates without a random gate', async (t) => {
  const cases = [
    {
      label: 'ordinary Google Sheet create',
      expected: 'proceed',
      operation: 'GOOGLESHEETS_SHEET_FROM_JSON',
      destinationFamily: 'googlesheets',
      prompt: 'Create one new Google Sheet named Release Fixture from the supplied rows.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'sheet_name', 'sheet_json'],
        properties: {
          title: { type: 'string' },
          sheet_name: { type: 'string' },
          sheet_json: { type: 'string' },
        },
      },
      args: {
        title: 'Release Fixture',
        sheet_name: 'Sheet1',
        sheet_json: JSON.stringify([{ name: 'alpha', status: 'ready' }]),
      },
      result: {
        successful: true,
        spreadsheetId: 'release-fixture-sheet',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/release-fixture-sheet/edit',
      },
      source: {
        operation: 'GOOGLESHEETS_BATCH_GET',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['spreadsheet_id', 'ranges'],
          properties: {
            spreadsheet_id: { type: 'string' },
            ranges: { type: 'array', items: { type: 'string' } },
          },
        },
        args: { spreadsheet_id: 'release-fixture-source', ranges: ['Sheet1!A1:B2'] },
        result: {
          records: [{ name: 'alpha', status: 'ready' }],
          total: 1,
          has_more: false,
        },
      },
    },
    {
      label: 'ordinary Google Doc create',
      expected: 'proceed',
      operation: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
      destinationFamily: 'googledocs',
      prompt: 'Create one new Google Doc named Release Fixture from the supplied Markdown.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'markdown'],
        properties: {
          title: { type: 'string' },
          markdown: { type: 'string' },
        },
      },
      args: {
        title: 'Release Fixture',
        markdown: '# Release Fixture\n\nProvider-neutral acceptance content.',
      },
      result: {
        successful: true,
        documentId: 'release-fixture-doc',
        documentUrl: 'https://docs.google.com/document/d/release-fixture-doc/edit',
      },
      source: null,
    },
    {
      label: 'source-derived generic create without exact readback repairs before mutation I/O',
      expected: 'source_proof_repair',
      operation: 'FIXTURE_CREATE_REPORT_FROM_RECORDS',
      destinationFamily: 'fixture',
      prompt: 'Create one fixture report from the exact source records and verify its content.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'records'],
        properties: {
          title: { type: 'string' },
          records: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'status'],
              properties: {
                name: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
        },
      },
      args: {
        title: 'Release Source Report',
        records: [{ name: 'alpha', status: 'ready' }],
      },
      result: { successful: true, id: 'must-not-run-without-readback' },
      source: {
        operation: 'FIXTURE_LIST_REPORT_RECORDS',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: { query: { type: 'string' } },
        },
        args: { query: 'release source report records' },
        result: {
          records: [{ name: 'alpha', status: 'ready' }],
          total: 1,
          has_more: false,
        },
      },
    },
    {
      label: 'unknown external mutation repairs before I/O',
      expected: 'repair',
      operation: 'FIXTURE_SYNC_RESOURCE',
      destinationFamily: 'fixture',
      prompt: 'Synchronize one new fixture resource from this exact payload.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'body'],
        properties: {
          id: { type: 'string' },
          body: { type: 'string' },
        },
      },
      args: { id: 'release-unknown', body: 'unknown-risk-fixture' },
      result: { successful: true, id: 'must-not-run' },
      source: null,
    },
    {
      label: 'explicit outbound draft requests one user approval before I/O',
      expected: 'needs_user',
      resumeScenario: 'approve_restart',
      operation: 'FIXTURE_SEND_DRAFT',
      destinationFamily: 'fixture',
      destinationPosture: 'named_existing',
      prompt: 'Update one exact fixture draft and then send it.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'recipient', 'send'],
        properties: {
          title: { type: 'string' },
          recipient: { type: 'string' },
          send: { type: 'boolean' },
        },
      },
      args: {
        title: 'Release outbound fixture',
        recipient: 'release-recipient@example.test',
        send: true,
      },
      result: { successful: true, message_id: 'release-outbound-fixture' },
      source: null,
    },
    {
      label: 'approved exact outbound whose tool surface disappears replans before I/O',
      expected: 'needs_user',
      resumeScenario: 'approve_surface_loss',
      operation: 'FIXTURE_SEND_SURFACE_LOSS',
      destinationFamily: 'fixture',
      destinationPosture: 'named_existing',
      prompt: 'Send the exact approved fixture only if its admitted tool surface remains available.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'recipient', 'send'],
        properties: {
          title: { type: 'string' },
          recipient: { type: 'string' },
          send: { type: 'boolean' },
        },
      },
      args: {
        title: 'Release surface-loss fixture',
        recipient: 'surface-loss@example.test',
        send: true,
      },
      result: { successful: true, message_id: 'must-not-run-surface-loss' },
      source: null,
    },
    {
      label: 'approved exact outbound with an unknown crossing holds across restart',
      expected: 'needs_user',
      resumeScenario: 'approve_unknown_restart',
      operation: 'FIXTURE_SEND_UNKNOWN',
      destinationFamily: 'fixture',
      destinationPosture: 'named_existing',
      prompt: 'Send the exact approved fixture once and never replay an uncertain crossing.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'recipient', 'send'],
        properties: {
          title: { type: 'string' },
          recipient: { type: 'string' },
          send: { type: 'boolean' },
        },
      },
      args: {
        title: 'Release uncertain fixture',
        recipient: 'uncertain@example.test',
        send: true,
      },
      result: { successful: true, message_id: 'must-not-return-unknown' },
      source: null,
    },
    ...([
      ['rejected exact outbound approval executes nothing', 'reject'],
      ['edited outbound arguments cannot reuse exact approval', 'edit'],
      ['expired outbound approval executes nothing', 'expiry'],
      ['wrong outbound approval id executes nothing', 'wrong_id'],
    ] as const).map(([label, resumeScenario]) => ({
      label,
      expected: 'needs_user' as const,
      resumeScenario,
      operation: 'FIXTURE_SEND_DRAFT',
      destinationFamily: 'fixture',
      destinationPosture: 'named_existing' as const,
      prompt: `${label}.`,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'recipient', 'send'],
        properties: {
          title: { type: 'string' },
          recipient: { type: 'string' },
          send: { type: 'boolean' },
        },
      },
      args: {
        title: `Release ${resumeScenario} fixture`,
        recipient: `${resumeScenario}@example.test`,
        send: true,
      },
      result: { successful: true, message_id: `must-not-run-${resumeScenario}` },
      source: null,
    })),
    {
      label: 'ambiguous outbound signal repairs before I/O',
      expected: 'repair',
      operation: 'FIXTURE_CREATE_DRAFT_AMBIGUOUS',
      destinationFamily: 'fixture',
      prompt: 'Create one fixture draft named Release Ambiguous Fixture.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: { type: 'string' },
          send: { type: 'boolean' },
        },
      },
      args: { title: 'Release ambiguous fixture' },
      result: { successful: true, id: 'must-not-run' },
      source: null,
    },
    {
      label: 'missing destination repairs before I/O',
      expected: 'plan_repair',
      operation: 'FIXTURE_CREATE_RESOURCE',
      destinationFamily: 'fixture',
      prompt: 'Create a resource, but no destination has been selected.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['body'],
        properties: { body: { type: 'string' } },
      },
      args: { body: 'destination-required-fixture' },
      result: { successful: true, id: 'must-not-run' },
      source: null,
    },
  ] as const;

  for (const [index, candidate] of cases.entries()) {
    await t.test(candidate.label, async (caseTest) => {
      const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
      const priorManifestStore = manifestStores.peekCapabilityManifestStore();
      const priorAdapter = productionAdapters.peekProductionCapabilityAdapter();
      const priorPorts = ports.listProductionCapabilityPorts();
      const operationId = `external-create-${index}`;
      const workCallId = `planned-external-work-${index}`;
      const resumeScenario = 'resumeScenario' in candidate ? candidate.resumeScenario : null;
      const hasOrdinarySibling = resumeScenario === 'approve_restart';
      const ordinarySiblingOperationId = hasOrdinarySibling
        ? `${operationId}-ordinary-sibling`
        : null;
      const ordinarySiblingCallId = hasOrdinarySibling
        ? `${workCallId}-ordinary-sibling`
        : null;
      const ordinarySiblingLocalName = hasOrdinarySibling
        ? 'space_edit_view'
        : null;
      const ordinarySiblingObserved = ordinarySiblingLocalName
        ? await localPlanning.observeCurrentLocalPlanningDefinition({
            name: ordinarySiblingLocalName,
            carrier: 'work_call',
          })
        : null;
      if (ordinarySiblingObserved) {
        assert.equal(ordinarySiblingObserved.ok, true, JSON.stringify(ordinarySiblingObserved));
      }
      const ordinarySiblingDefinition = ordinarySiblingObserved?.ok
        ? ordinarySiblingObserved.definition
        : null;
      const ordinarySiblingCapabilityRef = ordinarySiblingDefinition?.capabilityRef ?? null;
      const ordinarySiblingArgs = ordinarySiblingLocalName
        ? {
            slug: 'release-outbound-fixture',
            edits: [{ find: 'Draft', replace: 'Updated Draft' }],
          }
        : null;
      const sourceCallId = `planned-external-source-${index}`;
      const capabilityRef = `cap:release:${candidate.operation.toLowerCase()}:${index}`;
      const accountId = `account:release:${index}`;
      const schemaDigest = externalRiskLoader.canonicalExternalInputSchemaDigestV1(candidate.schema);
      assert.ok(schemaDigest, 'provider schema must have one canonical full digest');
      const operationVersion = '1';
      const invokePortId = `journey:provider-neutral:${index}:invoke`;
      // `null` is an explicit provider-owned absence of an output schema;
      // `undefined` would mean the output surface was never observed and may
      // not mint execution authority.
      const providerOutputSchema = null;
      const definitionFingerprint = composioProviderIdentity.fingerprintComposioProviderDefinition({
        operationId: candidate.operation,
        operationVersion,
        accountId,
        invokePortId,
        inputSchema: candidate.schema as Record<string, unknown>,
        outputSchema: providerOutputSchema,
      });
      assert.ok(definitionFingerprint, 'provider definition must have one full canonical identity');
      const destinationPosture = 'destinationPosture' in candidate
        ? candidate.destinationPosture
        : 'create_new' as const;
      const manifest = manifests.attachSemanticContract({
        version: 1,
        manifestId: capabilityRef,
        providerKind: 'composio',
        operationId: candidate.operation,
        providerIdentity: 'composio',
        providerVersion: composioProviderIdentity.COMPOSIO_PROVIDER_SURFACE_VERSION,
        operationVersion,
        definitionFingerprint: definitionFingerprint!,
        externalDefinition: {
          version: 1,
          providerInputSchemaDigest: schemaDigest!,
          providerOutputSchemaObserved: true,
          semanticName: candidate.operation,
          behaviorHints: {
            readOnly: false,
            destructive: false,
            idempotent: null,
            openWorld: false,
          },
        },
        effect: 'external_write',
        destination: { family: candidate.destinationFamily, posture: destinationPosture },
        accountId,
        idempotency: { required: true, policy: 'key_before_dispatch' },
        reconciliation: { supported: true, policy: 'exact_artifact' },
        outputContract: {
          kind: candidate.expected === 'needs_user' ? 'mutation_receipt' : 'created_resource',
        },
        purpose: 'persist_collection',
        acceptedInputKinds: ['evidence', 'records'],
        producedOutputKinds: ['evidence', 'created_resource'],
        applicableDeliverableKinds: ['evidence', candidate.destinationFamily],
        evidenceContract: { kinds: ['receipt'], readbackRequired: false },
        provenance: {
          issuer: 'journey:provider-neutral-external-fixture',
          issuedAt: '2026-08-23T00:00:00.000Z',
          trusted: true,
        },
        lifecycle: { state: 'current' },
        advisoryRoles: candidate.expected === 'needs_user'
          ? ['destination', 'send']
          : ['destination', 'create'],
        argumentCompiler: { id: 'journey:exact-provider-args:v1', version: '1' },
        invokePortId,
        reconcilePortId: `journey:provider-neutral:${index}:reconcile`,
      });
      const sourceCapabilityRef = candidate.source
        ? `cap:release:${candidate.source.operation.toLowerCase()}:${index}`
        : null;
      const sourceSchemaDigest = candidate.source
        ? externalRiskLoader.canonicalExternalInputSchemaDigestV1(candidate.source.schema)
        : null;
      const sourceInvokePortId = `journey:provider-neutral:${index}:source-invoke`;
      const sourceDefinitionFingerprint = candidate.source
        ? composioProviderIdentity.fingerprintComposioProviderDefinition({
            operationId: candidate.source.operation,
            operationVersion,
            accountId,
            invokePortId: sourceInvokePortId,
            inputSchema: candidate.source.schema as Record<string, unknown>,
            outputSchema: providerOutputSchema,
          })
        : null;
      if (candidate.source) {
        assert.ok(sourceSchemaDigest, 'source schema must have one canonical input digest');
        assert.ok(sourceDefinitionFingerprint, 'source definition must have one full canonical identity');
      }
      const sourceManifest = candidate.source
        && sourceCapabilityRef
        && sourceSchemaDigest
        && sourceDefinitionFingerprint
        ? manifests.attachSemanticContract({
            version: 1,
            manifestId: sourceCapabilityRef,
            providerKind: 'composio',
            operationId: candidate.source.operation,
            providerIdentity: 'composio',
            providerVersion: composioProviderIdentity.COMPOSIO_PROVIDER_SURFACE_VERSION,
            operationVersion,
            definitionFingerprint: sourceDefinitionFingerprint,
            externalDefinition: {
              version: 1,
              providerInputSchemaDigest: sourceSchemaDigest,
              providerOutputSchemaObserved: true,
              semanticName: candidate.source.operation,
              behaviorHints: {
                readOnly: true,
                destructive: false,
                idempotent: true,
                openWorld: false,
              },
            },
            effect: 'read',
            accountId,
            idempotency: { required: false, policy: 'none' },
            reconciliation: { supported: false, policy: 'none' },
            outputContract: { kind: 'records' },
            purpose: 'collect_records',
            acceptedInputKinds: ['evidence'],
            producedOutputKinds: ['evidence', 'records'],
            applicableDeliverableKinds: ['evidence'],
            evidenceContract: { kinds: ['records'], readbackRequired: false },
            provenance: {
              issuer: 'journey:provider-neutral-external-fixture',
              issuedAt: '2026-08-23T00:00:00.000Z',
              trusted: true,
            },
            lifecycle: { state: 'current' },
            advisoryRoles: ['source', 'collection'],
            argumentCompiler: { id: 'journey:exact-provider-args:v1', version: '1' },
            invokePortId: sourceInvokePortId,
          })
        : null;
      const selectedManifests = [
        ...(sourceManifest ? [sourceManifest] : []),
        manifest,
      ];
      const store = manifestStores.createCapabilityManifestStore(selectedManifests);
      const factory = catalogs.createHostCapabilityCatalogFactory();
      let forbiddenDirectBodies = 0;
      const directInvoke = async () => {
        forbiddenDirectBodies += 1;
        throw new Error('work_call must retain the connected Composio gateway carrier');
      };
      const reconcile = async () => ({ exists: false });
      const observedAt = Date.now();
      const observe = (selectedManifest = manifest) => ({
        definitionFingerprint: selectedManifest.definitionFingerprint,
        providerVersion: selectedManifest.providerVersion,
        operationVersion: selectedManifest.operationVersion,
        accountId: selectedManifest.accountId,
        observedAt: Date.now(),
      });
      manifestStores.installCapabilityManifestStore(store);
      catalogs.installHostCapabilityCatalogFactory(factory);
      ports.clearProductionCapabilityPorts();
      productionTransport.installProductionTransport(async () => {
        forbiddenDirectBodies += 1;
        throw new Error('planning availability must not become a parallel provider dispatch');
      });
      composioClient.__test__.setConnectedAccountsLoader(async () => [{
        id: accountId,
        status: 'ACTIVE',
        user_id: 'provider-neutral-release-user',
        toolkit: { slug: candidate.operation.split('_')[0]!.toLowerCase() },
      }]);
      composioSchemas._setToolSchemaLoaderForTests(async (identifier) => (
        identifier === candidate.operation
          ? {
              inputParameters: candidate.schema,
              outputParameters: providerOutputSchema,
              providerObservedAt: Date.now(),
              providerOperationVersion: operationVersion,
            }
          : candidate.source && identifier === candidate.source.operation
            ? {
                inputParameters: candidate.source.schema,
                outputParameters: providerOutputSchema,
                providerObservedAt: Date.now(),
                providerOperationVersion: operationVersion,
              }
          : null
      ));
      const schemasByOperation = new Map<string, Readonly<Record<string, unknown>>>([
        [candidate.operation, candidate.schema],
        ...(candidate.source
          ? [[candidate.source.operation, candidate.source.schema] as const]
          : []),
      ]);
      for (const selectedManifest of selectedManifests) {
        const selectedSchema = schemasByOperation.get(selectedManifest.operationId);
        assert.ok(selectedSchema, `missing provider schema for ${selectedManifest.operationId}`);
        const selectedSchemaDigest = externalRiskLoader.canonicalExternalInputSchemaDigestV1(selectedSchema);
        assert.ok(selectedSchemaDigest, `invalid provider schema for ${selectedManifest.operationId}`);
        composioSchemas.rememberToolSchema(
          selectedManifest.operationId,
          selectedSchema,
          observedAt,
          selectedManifest.operationVersion,
          providerOutputSchema,
        );
        const liveSourceFingerprint = composioSchemas.liveComposioSchemaFingerprint(
          selectedManifest.operationId,
        );
        assert.ok(liveSourceFingerprint, 'provider observation must own the selected schema');
        const selectedReconcile = selectedManifest.effect === 'read' ? undefined : reconcile;
        assert.deepEqual(ports.registerFixtureCapabilityPort(
          ports.productionPortIdentityFromManifest(selectedManifest),
          {
            observe: () => observe(selectedManifest),
            invoke: directInvoke,
            ...(selectedReconcile ? { reconcile: selectedReconcile } : {}),
          },
        ), { ok: true });
        assert.deepEqual(independentObservations.registerIndependentCapabilityObservation({
          operationId: selectedManifest.operationId,
          accountId: selectedManifest.accountId,
          definitionFingerprint: selectedManifest.definitionFingerprint,
          providerVersion: selectedManifest.providerVersion,
          operationVersion: selectedManifest.operationVersion,
          observedAt,
          origin: 'independent',
          observe: () => ({
            operationId: selectedManifest.operationId,
            accountId: selectedManifest.accountId,
            definitionFingerprint: selectedManifest.definitionFingerprint,
            providerVersion: selectedManifest.providerVersion,
            operationVersion: selectedManifest.operationVersion,
            observedAt: Date.now(),
          }),
        }), { ok: true });
        factory.register({
          capabilityId: selectedManifest.manifestId,
          toolName: selectedManifest.operationId,
          schemaVersion: selectedManifest.operationVersion,
          schemaDigest: selectedManifest.definitionFingerprint,
          effect: selectedManifest.effect,
          ...(selectedManifest.destination ? { destination: selectedManifest.destination } : {}),
          account: selectedManifest.accountId,
          advisoryRoles: selectedManifest.advisoryRoles,
          manifestDigest: manifests.capabilityManifestDigest(selectedManifest),
          providerKind: selectedManifest.providerKind,
          sourceSchemaFingerprint: liveSourceFingerprint,
          providerInputSchemaDigest: selectedSchemaDigest!,
          liveFingerprint: selectedManifest.definitionFingerprint,
          manifest: selectedManifest,
          invoke: directInvoke,
          ...(selectedReconcile ? { reconcile: selectedReconcile } : {}),
        });
      }
      const adapter = productionAdapters.createProductionCapabilityAdapter({
        factory,
        store,
        observe: { composio: (selectedManifest) => observe(selectedManifest) },
        invokePorts: (selectedManifest) => ({
          invoke: directInvoke,
          ...(selectedManifest.effect === 'read' ? {} : { reconcile }),
        }),
      });
      productionAdapters.installProductionCapabilityAdapter(adapter);
      caseTest.after(() => {
        innerDispatch._setInnerDispatchToolsForTests(null);
        catalogs.installHostCapabilityCatalogFactory(priorCatalog);
        manifestStores.installCapabilityManifestStore(priorManifestStore);
        productionAdapters.installProductionCapabilityAdapter(priorAdapter);
        productionTransport.installProductionTransport(null);
        composioClient.__test__.setConnectedAccountsLoader(null);
        composioSchemas._setToolSchemaLoaderForTests(null);
        ports.clearProductionCapabilityPorts();
        for (const prior of priorPorts) {
          ports.registerFixtureCapabilityPort(prior.identity, prior.port);
        }
      });

      const plannedSession = eventlog.createSession({
        id: `discord-like-exact-external-plan-${index}`,
        kind: 'chat',
        channel: 'discord',
      });
      const source = eventlog.appendEvent({
        sessionId: plannedSession.id,
        turn: 1,
        role: 'user',
        type: 'user_input_received',
        data: { text: candidate.prompt },
      });
      capabilityResolution.recordAdmissionCapabilityResolution({
        sessionId: plannedSession.id,
        sourceUserSeq: source.seq,
        acceptedInput: candidate.prompt,
        entries: [
          ...(candidate.source
            ? [{
                intent: `read source rows for ${candidate.label}`,
                kind: 'composio' as const,
                identifier: candidate.source.operation,
                status: 'proven' as const,
                connection: 'active' as const,
                effectClass: 'read' as const,
                accountIdentity: accountId,
              }]
            : []),
          {
            intent: candidate.label,
            kind: 'composio',
            identifier: candidate.operation,
            status: 'proven',
            connection: 'active',
            effectClass: 'write',
            accountIdentity: accountId,
          },
        ],
      });
      const primed = await semanticPlanning.primePrimaryModelPlanningCatalog({
        sessionId: plannedSession.id,
        sourceUserSeq: source.seq,
      });
      assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
      if (!primed.ok) return;
      assert.ok(
        primed.planning.capabilities.some((entry) => entry.id === capabilityRef),
        'the exact current catalog capability must be citable before plan_task',
      );
      if (ordinarySiblingCapabilityRef) {
        assert.equal(
          primed.planning.capabilities.some((entry) => entry.id === ordinarySiblingCapabilityRef),
          false,
          'the local ordinary sibling must be disclosed by foreground tool_search',
        );
      }
      if (sourceCapabilityRef) {
        assert.ok(
          primed.planning.capabilities.some((entry) => entry.id === sourceCapabilityRef),
          'the exact source capability must be citable before plan_task',
        );
      }

      let bodies = 0;
      let sourceBodies = 0;
      let writeBodies = 0;
      let localBodies = 0;
      const seenProviderArgs: Array<Record<string, unknown>> = [];
      const seenLocalArgs: Array<Record<string, unknown>> = [];
      const mutationBodyOrder: string[] = [];
      const bindingCountsAtBody: Array<{ work: number; host: number }> = [];
      const executeGateway = async (input: {
        tool_slug: string;
        arguments: string | null;
        connected_account_id: string | null;
      }) => {
        assert.equal(input.connected_account_id, accountId);
        const args = JSON.parse(input.arguments ?? '{}') as Record<string, unknown>;
        bodies += 1;
        if (candidate.source && input.tool_slug === candidate.source.operation) {
          sourceBodies += 1;
          assert.deepEqual(args, candidate.source.args);
          return candidate.source.result;
        }
        assert.equal(input.tool_slug, candidate.operation);
        assert.deepEqual(args, candidate.args);
        const activeLogicalCallId = workCallId;
        const db = eventlog.openEventLog();
        const work = db.prepare(`
          SELECT COUNT(*) AS n FROM expected_work_call_bindings
           WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
        `).get(plannedSession.id, source.seq, activeLogicalCallId) as { n: number };
        const host = db.prepare(`
          SELECT COUNT(*) AS n FROM host_call_capability_bindings
           WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
        `).get(plannedSession.id, source.seq, activeLogicalCallId) as { n: number };
        bindingCountsAtBody.push({ work: work.n, host: host.n });
        writeBodies += 1;
        seenProviderArgs.push(args);
        mutationBodyOrder.push('send');
        if (resumeScenario === 'approve_unknown_restart') {
          return new Promise<never>((_resolve, reject) => {
            const watchdog = setTimeout(() => {
              reject(new Error('fixture watchdog: host deadline did not settle the unknown write'));
            }, 2_000);
            watchdog.unref();
          });
        }
        return candidate.result;
      };
      const gateway = sdk.tool({
        name: 'composio_execute_tool',
        description: 'Recording-only connected Composio gateway.',
        parameters: z.object({
          tool_slug: z.string(),
          arguments: z.string().nullable(),
          connected_account_id: z.string().nullable(),
        }),
        execute: executeGateway,
      });
      const ordinarySiblingTool: FunctionTool | null = (
        ordinarySiblingLocalName
        && ordinarySiblingObserved?.ok
        && ordinarySiblingArgs
        && ordinarySiblingCallId
      )
        ? {
            type: 'function',
            name: ordinarySiblingLocalName,
            description: 'Recording-only ordinary Workspace update sibling.',
            strict: true,
            parameters: ordinarySiblingObserved.schema,
            needsApproval: async () => true,
            invoke: async (_context: unknown, raw: string) => {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              assert.deepEqual(parsed, ordinarySiblingArgs);
              const db = eventlog.openEventLog();
              const work = db.prepare(`
                SELECT COUNT(*) AS n FROM expected_work_call_bindings
                 WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
              `).get(plannedSession.id, source.seq, ordinarySiblingCallId) as { n: number };
              const host = db.prepare(`
                SELECT COUNT(*) AS n FROM host_call_capability_bindings
                 WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
              `).get(plannedSession.id, source.seq, ordinarySiblingCallId) as { n: number };
              bindingCountsAtBody.push({ work: work.n, host: host.n });
              localBodies += 1;
              seenLocalArgs.push(parsed);
              mutationBodyOrder.push('local_update');
              return JSON.stringify({ ok: true, slug: 'release-outbound-fixture', updated: true });
            },
          }
        : null;
      innerDispatch._setInnerDispatchToolsForTests(new Map([
        ['composio_execute_tool', gateway as never],
        ...(ordinarySiblingTool && ordinarySiblingLocalName
          ? [[ordinarySiblingLocalName, ordinarySiblingTool as never] as const]
          : []),
      ]));

      let modelCalls = 0;
      const modelInputs: unknown[] = [];
      const model = {
        async getResponse(request: unknown) {
          modelCalls += 1;
          modelInputs.push(structuredClone(request));
          const serialized = JSON.stringify(request);
          let output: unknown[];
          const planModelCall = ordinarySiblingLocalName ? 2 : 1;
          const workModelCall = planModelCall + 1;
          if (ordinarySiblingLocalName && modelCalls === 1) {
            assert.doesNotMatch(serialized, new RegExp(ordinarySiblingCapabilityRef!));
            output = [functionCall(`planned-external-local-search-${index}`, 'tool_search', {
              query: ordinarySiblingLocalName,
              role_key: 'clause-0:write',
              limit: 8,
            })];
          } else if (modelCalls === planModelCall) {
            assert.match(serialized, new RegExp(capabilityRef));
            if (ordinarySiblingCapabilityRef) {
              assert.match(serialized, new RegExp(ordinarySiblingCapabilityRef));
            }
            output = [functionCall(`planned-external-plan-${index}`, 'plan_task', {
              preamble: `I’ll create the requested ${candidate.label} now.`,
              draft: exactExternalCreatePlanDraft({
                label: candidate.label,
                operationId,
                capabilityRef,
                destinationFamily: candidate.destinationFamily,
                includeDestination: candidate.expected !== 'plan_repair',
                destinationPosture,
                ...(ordinarySiblingOperationId && ordinarySiblingCapabilityRef
                  ? {
                      ordinarySiblingOperationId,
                      ordinarySiblingCapabilityRef,
                      ordinarySiblingEffect: 'local_write',
                      ordinarySiblingDeliverableKind:
                        ordinarySiblingDefinition?.descriptor.deliverableKind,
                    }
                  : {}),
                ...(candidate.source && sourceCapabilityRef
                  ? {
                      source: {
                        operationId: `external-source-${index}`,
                        capabilityRef: sourceCapabilityRef,
                      },
                    }
                  : {}),
              }),
            })];
          } else if (modelCalls === workModelCall) {
            const planResult = functionResultTextFor(
              (request as { input?: unknown }).input,
              `planned-external-plan-${index}`,
            );
            const frozen = eventlog.openEventLog().prepare(`
              SELECT contract_json FROM accepted_task_work_contracts
               WHERE session_id = ? AND source_user_seq = ?
            `).get(plannedSession.id, source.seq) as { contract_json: string } | undefined;
            if (candidate.expected === 'plan_repair') {
              assert.match(
                String(planResult ?? ''),
                /plan_not_admitted|write_not_aligned|error|refus|invalid|destination/i,
              );
              assert.equal(frozen, undefined, 'missing destination must not freeze executable work');
              output = [assistantText(`${candidate.label} completed from its exact accepted plan.`)];
            } else {
              assert.doesNotMatch(String(planResult ?? ''), /error|refus|invalid/i, String(planResult));
              assert.ok(frozen, `plan_task did not freeze external coverage: ${planResult}`);
              output = candidate.source
              ? [functionCall(sourceCallId, 'work_call', {
                  requirement_id: `external-source-${index}`,
                  universe_item_id: null,
                  universe_selector: null,
                  seal_amendment: null,
                  name: 'composio_execute_tool',
                  args_json: JSON.stringify({
                    tool_slug: candidate.source.operation,
                    arguments: JSON.stringify(candidate.source.args),
                    connected_account_id: accountId,
                  }),
                })]
              : [
                  ...(ordinarySiblingOperationId
                    && ordinarySiblingCallId
                    && ordinarySiblingLocalName
                    && ordinarySiblingArgs
                    ? [functionCall(ordinarySiblingCallId, 'work_call', {
                        requirement_id: ordinarySiblingOperationId,
                        universe_item_id: null,
                        universe_selector: null,
                        seal_amendment: null,
                        name: ordinarySiblingLocalName,
                        args_json: JSON.stringify(ordinarySiblingArgs),
                      })]
                    : []),
                  functionCall(workCallId, 'work_call', {
                    requirement_id: operationId,
                    universe_item_id: null,
                    universe_selector: null,
                    seal_amendment: null,
                    name: 'composio_execute_tool',
                    args_json: JSON.stringify({
                      tool_slug: candidate.operation,
                      arguments: JSON.stringify(candidate.args),
                      connected_account_id: accountId,
                    }),
                  }),
                ];
            }
          } else if (candidate.source && modelCalls === workModelCall + 1) {
            assert.equal(
              functionResultTextFor((request as { input?: unknown }).input, sourceCallId),
              JSON.stringify(candidate.source.result),
            );
            output = [functionCall(workCallId, 'work_call', {
              requirement_id: operationId,
              universe_item_id: null,
              universe_selector: null,
              seal_amendment: null,
              name: 'composio_execute_tool',
              args_json: JSON.stringify({
                tool_slug: candidate.operation,
                arguments: JSON.stringify(candidate.args),
                connected_account_id: accountId,
              }),
            })];
          } else {
            output = [assistantText(`${candidate.label} completed from its exact accepted plan.`)];
          }
          return {
            responseId: `planned-external-response-${index}-${modelCalls}`,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            output,
          };
        },
        getStreamedResponse: modelStream,
      };

      const agent = await buildOrchestratorAgent({
        userInput: candidate.prompt,
        sessionId: plannedSession.id,
        sourceUserSeq: source.seq,
        hostFreshPlanning: primed.planning,
        allowedToolNames: [
          candidate.operation,
          ...(ordinarySiblingLocalName ? [ordinarySiblingLocalName, 'tool_search'] : []),
          ...(candidate.source ? [candidate.source.operation] : []),
          'composio_execute_tool',
        ],
        allowToolJit: true,
        mcpToolScope: {
          authority: 'none',
          reason: 'provider-neutral external fixture owns one exact connected capability',
          allowedServerSlugs: [],
          toolPatterns: [],
          maxTools: 0,
        },
        model: model as never,
      });
      let exactSurfaceAvailable = true;
      let surfaceRefreshFailures = 0;
      if (resumeScenario === 'approve_surface_loss') {
        const surfacedAgent = agent as unknown as {
          getAllTools: (...args: unknown[]) => Promise<unknown[]>;
        };
        const getAllTools = surfacedAgent.getAllTools.bind(surfacedAgent);
        surfacedAgent.getAllTools = async (...args: unknown[]) => {
          if (!exactSurfaceAvailable) {
            surfaceRefreshFailures += 1;
            throw new Error('fixture exact planned tool surface unavailable after approval');
          }
          return getAllTools(...args);
        };
      }
      const parent = {
        sessionId: plannedSession.id,
        sourceUserSeq: source.seq,
        turn: 1,
        counter: new brackets.ToolCallsCounter(12),
        behaviorScopeId: `${plannedSession.id}::turn:1`,
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
            target: `provider-neutral-planned-external:${index}`,
          },
        }),
      };
      const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
        throwingRunner() as never,
        agent as never,
        [{ role: 'user', content: candidate.prompt }] as never,
        {
          maxTurns: 6,
          hostTurnEngine: 'host_v1',
          context: { sessionId: plannedSession.id, sourceUserSeq: source.seq, turn: 1 },
        } as never,
      ));

      const db = eventlog.openEventLog();
      const physical = db.prepare(`
        SELECT logical_tool_call_id, tool_name, state, execution_site
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? ORDER BY ordinal
      `).all(plannedSession.id, source.seq);
      const workBindings = db.prepare(`
        SELECT logical_tool_call_id, requirement_id, tool_name, effect_kind,
               cardinality_kind, argument_digest
          FROM expected_work_call_bindings
         WHERE session_id = ? AND source_user_seq = ?
      `).all(plannedSession.id, source.seq);
      const hostBindings = db.prepare(`
        SELECT logical_tool_call_id, binding_kind, capability_id, operation_id,
               account_id, provider_input_schema_digest, effect
          FROM host_call_capability_bindings
         WHERE session_id = ? AND source_user_seq = ?
      `).all(plannedSession.id, source.seq);
      const settlements = db.prepare(`
        SELECT logical_tool_call_id, execution_kind, outcome_kind, business_call,
               mutating, requirement_id, physical_crossing_count
          FROM logical_call_settlements
         WHERE session_id = ? AND source_user_seq = ?
      `).all(plannedSession.id, source.seq);
      const approvalEvents = eventlog.listEvents(plannedSession.id).filter((event) =>
        ['approval_requested', 'approval_required', 'request_approval'].includes(event.type));
      const latestReturned = eventlog.listEvents(plannedSession.id, {
        types: ['tool_returned'],
      }).filter((event) => event.data.sourceUserSeq === source.seq).at(-1);
      const workResult = functionResultTextFor(outcome.history, workCallId);
      const settledEvents = eventlog.listEvents(plannedSession.id, {
        types: ['tool_attempt_settled'],
      }).filter((event) => event.data.sourceUserSeq === source.seq);
      caseTest.diagnostic(`planned external observation: ${JSON.stringify({
        label: candidate.label,
        modelCalls,
        hasInterruptions: outcome.hasInterruptions,
        terminal: outcome.terminal ?? null,
        bodies,
        forbiddenDirectBodies,
        bindingCountsAtBody,
        approvalEvents: approvalEvents.map((event) => event.type),
        interruptions: (outcome.interruptions ?? []).map((interruption) => ({
          toolName: interruption.toolName,
          args: interruption.args,
        })),
        physical,
        workBindings,
        hostBindings,
        settlements,
        workResult,
        settledEvents: settledEvents.map((event) => event.data),
        latestReturned: latestReturned?.data ?? null,
      })}`);
      assert.equal(
        Boolean(outcome.hasInterruptions),
        candidate.expected === 'needs_user',
        candidate.label,
      );
      assert.equal(outcome.terminal, undefined, `${candidate.label}: generic host terminal`);
      if (candidate.expected === 'needs_user') {
        assert.equal((outcome.interruptions ?? []).length, 1, `${candidate.label}: approval cardinality`);
      } else {
        assert.deepEqual(approvalEvents, [], `${candidate.label}: unexpected approval event`);
      }
      const expectedBodies = candidate.expected === 'proceed'
        ? candidate.source ? 2 : 1
        : candidate.expected === 'source_proof_repair'
          ? 1
        : 0;
      assert.equal(bodies, expectedBodies, `${candidate.label}: provider body cardinality`);
      assert.equal(localBodies, 0, `${candidate.label}: local mutation must not cross before consent`);
      assert.equal(
        sourceBodies,
        candidate.source && (
          candidate.expected === 'proceed'
          || candidate.expected === 'source_proof_repair'
        ) ? 1 : 0,
        `${candidate.label}: source body cardinality`,
      );
      assert.equal(
        writeBodies,
        candidate.expected === 'proceed' ? 1 : 0,
        `${candidate.label}: write body cardinality`,
      );
      assert.equal(forbiddenDirectBodies, 0, `${candidate.label}: parallel direct port`);
      assert.deepEqual(
        bindingCountsAtBody,
        candidate.expected === 'proceed' ? [{ work: 1, host: 1 }] : [],
      );
      assert.deepEqual(
        seenProviderArgs,
        candidate.expected === 'proceed' ? [candidate.args] : [],
      );
      const workHostBindings = hostBindings.filter((row) => (
        (row as { logical_tool_call_id?: unknown }).logical_tool_call_id === workCallId
      ));
      const ordinaryHostBindings = hostBindings.filter((row) => (
        (row as { logical_tool_call_id?: unknown }).logical_tool_call_id === ordinarySiblingCallId
      ));
      if (candidate.expected === 'plan_repair') {
        assert.equal(workBindings.length, 0, `${candidate.label}: no work may bind`);
        assert.equal(workHostBindings.length, 0, `${candidate.label}: no call may bind`);
      } else {
        // Source-derived content proof is checked before the mutation claim is
        // minted, so only the already-settled source binding remains. Later
        // policy refusals retain the exact work claim for durable audit.
        const expectedWorkBindingCount = candidate.expected === 'source_proof_repair'
          ? 1
          : candidate.source ? 2 : ordinarySiblingOperationId ? 2 : 1;
        assert.equal(
          workBindings.length,
          expectedWorkBindingCount,
          `${candidate.label}: expected-work binding cardinality`,
        );
        assert.equal(workHostBindings.length, 1, `${candidate.label}: host binding cardinality`);
        assert.deepEqual(workHostBindings[0], {
          logical_tool_call_id: workCallId,
          binding_kind: 'catalog_manifest',
          capability_id: capabilityRef,
          operation_id: candidate.operation,
          account_id: accountId,
          provider_input_schema_digest: schemaDigest,
          effect: 'external_write',
        });
        if (ordinarySiblingCallId) {
          assert.deepEqual(ordinaryHostBindings, [{
            logical_tool_call_id: ordinarySiblingCallId,
            binding_kind: 'local_envelope',
            capability_id: 'work_call',
            operation_id: 'work_call',
            account_id: '',
            provider_input_schema_digest: null,
            effect: 'local_write',
          }]);
        }
      }
      assert.equal(
        physical.filter((row) => (
          (row as { logical_tool_call_id?: unknown }).logical_tool_call_id === workCallId
        )).length,
        candidate.expected === 'proceed' ? 1 : 0,
        `${candidate.label}: physical dispatch cardinality`,
      );
      assert.equal(
        settlements.filter((row) => (
          (row as { logical_tool_call_id?: unknown }).logical_tool_call_id === workCallId
        )).length,
        candidate.expected === 'plan_repair' || candidate.expected === 'needs_user' ? 0 : 1,
        `${candidate.label}: settlement cardinality`,
      );
      if (
        candidate.expected === 'repair'
        || candidate.expected === 'source_proof_repair'
      ) {
        assert.match(String(workResult ?? ''), /refused_pre_dispatch|replan/);
      }
      assert.equal(
        modelCalls,
        candidate.expected === 'plan_repair' || candidate.expected === 'needs_user'
          ? ordinarySiblingOperationId ? 3 : 2
          : candidate.source ? 4 : 3,
      );
      if (candidate.expected === 'needs_user') {
        assert.equal(outcome.finalOutput, undefined);
      } else {
        assert.equal(outcome.finalOutput, `${candidate.label} completed from its exact accepted plan.`);
        assert.deepEqual(unmatchedFunctionCallIds({ input: outcome.history }), []);
      }
      assert.doesNotMatch(JSON.stringify(outcome), FORBIDDEN_PUBLIC_GATE, candidate.label);
      assert.ok(modelInputs.length >= 2);
      if (candidate.expected === 'needs_user') {
        const paused = HostInterruptState.fromString(outcome.serializedState!);
        const interruption = paused.getInterruptions()[0]!;
        const consentSubject = paused.pending.find((pending) => (
          pending.rawItem.callId === workCallId
        ))?.consentSubject;
        assert.ok(consentSubject, 'paused high-consequence call persists its exact consent subject');
        assert.equal(
          paused.pending.filter((pending) => Boolean(pending.consentSubject)).length,
          1,
          'only the high-consequence sibling owns a user-consent subject',
        );
        const resumeKey = hostConsent.hostInteractiveConsentApprovalResumeKey(consentSubject);
        assert.ok(resumeKey, 'exact consent subject has one opaque approval resume key');
        const approvalSubject = resumeScenario === 'wrong_id'
          ? {
              ...consentSubject,
              logicalToolCallId: `${workCallId}-wrong`,
              decisionSubjectDigest: 'e'.repeat(64),
              callDigest: 'f'.repeat(64),
            }
          : consentSubject;
        const approvalResumeKey = hostConsent.hostInteractiveConsentApprovalResumeKey(approvalSubject);
        assert.ok(approvalResumeKey);
        const approval = approvalRegistry.registerResumable({
          sessionId: plannedSession.id,
          subject: 'Approve the exact high-consequence planned fixture call.',
          tool: interruption.rawItem.name,
          args: JSON.parse(interruption.rawItem.arguments) as Record<string, unknown>,
          resumeKey: approvalResumeKey!,
          ...(resumeScenario === 'expiry' ? { ttlMs: -1 } : {}),
        }).row;
        if (resumeScenario === 'reject') {
          assert.equal(
            approvalRegistry.resolve(approval.approvalId, 'rejected', 'acceptance-fixture').ok,
            true,
          );
          paused.reject(interruption);
        } else {
          assert.equal(
            approvalRegistry.resolve(approval.approvalId, 'approved', 'acceptance-fixture').ok,
            resumeScenario !== 'expiry',
          );
          if (resumeScenario === 'edit') {
            const editedOuter = JSON.parse(interruption.rawItem.arguments) as {
              args_json: string;
            };
            const editedCarrier = JSON.parse(editedOuter.args_json) as {
              arguments: string;
            };
            const editedProvider = JSON.parse(editedCarrier.arguments) as Record<string, unknown>;
            editedProvider.title = `${String(editedProvider.title)} edited`;
            editedCarrier.arguments = JSON.stringify(editedProvider);
            editedOuter.args_json = JSON.stringify(editedCarrier);
            interruption.rawItem.arguments = JSON.stringify(editedOuter);
          }
          paused.approve(interruption);
        }
        // Process restart: only durable state + approval row survive. The
        // process-local preparation and nested admission tokens are gone.
        const restartBytes = paused.toString();
        const restarted = HostInterruptState.fromString(restartBytes);
        const resumedParent = {
          ...parent,
          counter: new brackets.ToolCallsCounter(12),
          behaviorScopeId: `${plannedSession.id}::resume:1`,
        };
        if (resumeScenario === 'approve_surface_loss') exactSurfaceAvailable = false;
        const resumed = await brackets.withHarnessRunContext(resumedParent, () => hostRunRunner(
          throwingRunner() as never,
          agent as never,
          restarted as never,
          {
            maxTurns: 6,
            hostTurnEngine: 'host_v1',
            hostApprovalId: approval.approvalId,
            ...(resumeScenario === 'approve_unknown_restart'
              ? { hostToolDeadlineMs: 250 }
              : {}),
            context: { sessionId: plannedSession.id, sourceUserSeq: source.seq, turn: 2 },
          } as never,
        ));
        const exactApprovedLifecycleScenario = resumeScenario === 'approve_restart'
          || resumeScenario === 'approve_surface_loss'
          || resumeScenario === 'approve_unknown_restart';
        if (!exactApprovedLifecycleScenario) {
          const invalidPhysical = eventlog.openEventLog().prepare(`
            SELECT COUNT(*) AS n FROM physical_dispatches
             WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
          `).get(plannedSession.id, source.seq, workCallId) as { n: number };
          assert.equal(resumed.terminal, undefined, 'invalid grant becomes paired model repair, not a public block');
          assert.equal(resumed.finalOutput, `${candidate.label} completed from its exact accepted plan.`);
          assert.equal(bodies, 0, 'invalid grant cannot execute the provider body');
          assert.equal(writeBodies, 0, 'invalid grant cannot execute a send');
          assert.equal(localBodies, 0, 'invalid grant cannot execute a sibling mutation');
          assert.equal(invalidPhysical.n, 0, 'invalid grant stays before physical I/O');
          assert.deepEqual(mutationBodyOrder, []);
          assert.deepEqual(unmatchedFunctionCallIds({ input: resumed.history }), []);
          assert.doesNotMatch(JSON.stringify(resumed), FORBIDDEN_PUBLIC_GATE);
          return;
        }
        const resumedDb = eventlog.openEventLog();
        const resumedSettlements = resumedDb.prepare(`
          SELECT logical_tool_call_id, execution_kind, outcome_kind, business_call,
                 mutating, requirement_id, physical_crossing_count
            FROM logical_call_settlements
           WHERE session_id = ? AND source_user_seq = ?
             AND logical_tool_call_id IN (?, ?)
           ORDER BY logical_tool_call_id
        `).all(plannedSession.id, source.seq, ordinarySiblingCallId, workCallId);
        const resumedPhysical = resumedDb.prepare(`
          SELECT logical_tool_call_id, tool_name, state, execution_site
            FROM physical_dispatches
           WHERE session_id = ? AND source_user_seq = ?
             AND logical_tool_call_id IN (?, ?)
           ORDER BY logical_tool_call_id, ordinal
        `).all(plannedSession.id, source.seq, ordinarySiblingCallId, workCallId);
        const resumedAllPhysical = resumedDb.prepare(`
          SELECT logical_tool_call_id, tool_name, state, execution_site
            FROM physical_dispatches
           WHERE session_id = ? AND source_user_seq = ?
           ORDER BY logical_tool_call_id, ordinal
        `).all(plannedSession.id, source.seq);
        const resumedAllSettlements = resumedDb.prepare(`
          SELECT logical_tool_call_id, execution_kind, outcome_kind, business_call,
                 mutating, requirement_id, recovery_action, retry_same_candidate,
                 requires_reconciliation, physical_crossing_count
            FROM logical_call_settlements
           WHERE session_id = ? AND source_user_seq = ?
           ORDER BY logical_tool_call_id
        `).all(plannedSession.id, source.seq);
        const resumedOperations = resumedDb.prepare(`
          SELECT operation_id, logical_tool_call_id, graph_node_id, effect_kind,
                 outcome_kind, dispatch_state
            FROM accepted_task_operations
           WHERE session_id = ? AND source_user_seq = ?
             AND operation_id IN (?, ?)
           ORDER BY operation_id
        `).all(
          plannedSession.id,
          source.seq,
          operationId,
          ordinarySiblingOperationId,
        );
        if (resumeScenario === 'approve_surface_loss') {
          assert.equal(surfaceRefreshFailures >= 1, true, 'resume refresh observes the vanished surface');
          assert.equal(resumed.terminal, undefined, 'surface loss is paired for ordinary model replan');
          assert.equal(resumed.finalOutput, `${candidate.label} completed from its exact accepted plan.`);
          assert.equal(modelCalls, 3, 'the paired no-effect result reaches one ordinary replan step');
          assert.equal(bodies, 0, 'surface loss remains before provider I/O');
          assert.equal(writeBodies, 0);
          assert.equal(localBodies, 0);
          assert.deepEqual(resumedPhysical, [], 'surface loss creates no physical crossing');
          assert.ok(functionResultIds(resumed.history).includes(workCallId));
          assert.deepEqual(unmatchedFunctionCallIds({ input: resumed.history }), []);
          const replanRequest = modelInputs[2] as { input?: unknown; tools?: unknown } | undefined;
          assert.ok(functionResultIds(replanRequest?.input).includes(workCallId));
          assert.deepEqual(unmatchedFunctionCallIds(replanRequest), []);
          assert.deepEqual(replanRequest?.tools, [], 'the replan step exposes an empty callable surface');
          assert.doesNotMatch(JSON.stringify(resumed), FORBIDDEN_PUBLIC_GATE);
          return;
        }
        if (resumeScenario === 'approve_unknown_restart') {
          caseTest.diagnostic(`exact approved unknown observation: ${JSON.stringify({
            resumedAllPhysical,
            resumedAllSettlements,
            resumedOperations,
            terminal: resumed.terminal ?? null,
            resultIds: functionResultIds(resumed.history),
          })}`);
          assert.deepEqual(resumed.terminal, { status: 'blocked', reason: 'tool_effect_uncertain' });
          assert.equal(modelCalls, 2, 'an unknown crossing cannot advance to another model step');
          assert.equal(bodies, 1, 'the exact approved provider body starts once');
          assert.equal(writeBodies, 1);
          assert.equal(localBodies, 0);
          assert.deepEqual(bindingCountsAtBody, [{ work: 1, host: 1 }]);
          assert.deepEqual(seenProviderArgs, [candidate.args]);
          assert.deepEqual(mutationBodyOrder, ['send']);
          assert.deepEqual(resumedPhysical, [{
            logical_tool_call_id: workCallId,
            tool_name: candidate.operation.toLowerCase(),
            state: 'unknown',
            execution_site: 'host',
          }]);
          assert.deepEqual(resumedSettlements, [{
            logical_tool_call_id: workCallId,
            execution_kind: 'local_execution',
            outcome_kind: 'uncertain_write',
            business_call: 1,
            mutating: 1,
            requirement_id: operationId,
            physical_crossing_count: 0,
          }]);
          assert.ok(functionResultIds(resumed.history).includes(workCallId));
          assert.deepEqual(unmatchedFunctionCallIds({ input: resumed.history }), []);

          const replayed = await brackets.withHarnessRunContext({
            ...parent,
            counter: new brackets.ToolCallsCounter(12),
            behaviorScopeId: `${plannedSession.id}::resume:unknown-replay`,
          }, () => hostRunRunner(
            throwingRunner() as never,
            agent as never,
            HostInterruptState.fromString(restartBytes) as never,
            {
              maxTurns: 6,
              hostTurnEngine: 'host_v1',
              hostApprovalId: approval.approvalId,
              hostToolDeadlineMs: 250,
              context: { sessionId: plannedSession.id, sourceUserSeq: source.seq, turn: 3 },
            } as never,
          ));
          assert.deepEqual(replayed.terminal, { status: 'blocked', reason: 'tool_effect_uncertain' });
          assert.equal(bodies, 1, 'restart replay cannot redispatch an unknown write');
          assert.equal(writeBodies, 1);
          assert.equal(modelCalls, 2);
          assert.ok(functionResultIds(replayed.history).includes(workCallId));
          assert.deepEqual(unmatchedFunctionCallIds({ input: replayed.history }), []);

          // The source-local reconciliation fence must survive in history
          // without poisoning a later, unrelated accepted source.
          const durableSession = HarnessSession.load(plannedSession.id);
          assert.ok(durableSession, 'the exact planned session must survive restart');
          durableSession.recordTurnResult({
            history: resumed.history,
            lastResponseId: resumed.lastResponseId,
            turn: 1,
          });
          const reloadedSession = HarnessSession.load(plannedSession.id);
          assert.ok(reloadedSession, 'the paired uncertain result must survive restart');
          assert.ok(functionResultIds(reloadedSession.toInputItems()).includes(workCallId));
          assert.deepEqual(unmatchedFunctionCallIds({ input: reloadedSession.toInputItems() }), []);

          const nextPrompt = 'Now list the configured workspace roots for this unrelated request.';
          const nextSource = reloadedSession.recordUserInput(nextPrompt, 4);
          const readCallId = `post-crossing-unrelated-read-${index}`;
          const readBodies: Array<Record<string, unknown>> = [];
          const readTool = recordingTool({
            name: 'workspace_roots',
            seen: readBodies,
            result: JSON.stringify({ roots: ['/fixture'] }),
          });
          const readModel = scriptedModel([
            [functionCall(readCallId, 'workspace_roots', {})],
            [assistantText('The unrelated workspace read completed normally.')],
          ]);
          const readAgent = {
            model: readModel,
            tools: [readTool],
            instructions: 'Handle only the unrelated safe read; never retry an older mutation.',
          };
          bindSurface(plannedSession.id, readAgent, [readTool]);
          const nextOutcome = await brackets.withHarnessRunContext({
            sessionId: plannedSession.id,
            sourceUserSeq: nextSource.seq,
            turn: 4,
            counter: new brackets.ToolCallsCounter(6),
            behaviorScopeId: `${plannedSession.id}::turn:4`,
          }, () => hostRunRunner(
            throwingRunner() as never,
            readAgent as never,
            [
              ...reloadedSession.toInputItems(),
              { role: 'user', content: nextPrompt },
            ] as never,
            {
              maxTurns: 3,
              hostTurnEngine: 'host_v1',
              context: {
                sessionId: plannedSession.id,
                sourceUserSeq: nextSource.seq,
                turn: 4,
              },
            } as never,
          ));
          assert.equal(nextOutcome.terminal, undefined);
          assert.equal(nextOutcome.finalOutput, 'The unrelated workspace read completed normally.');
          assert.equal(readModel.calls(), 2);
          assert.equal(readBodies.length, 1, 'the unrelated read crosses exactly once');
          assert.equal(bodies, 1, 'the old uncertain provider mutation never redispatches');
          assert.deepEqual(unmatchedFunctionCallIds(readModel.inputs()[0]), []);
          assert.deepEqual(unmatchedFunctionCallIds(readModel.inputs()[1]), []);
          assert.deepEqual(functionResultIds(
            (readModel.inputs()[1] as { input?: unknown } | undefined)?.input,
          ).slice(-1), [readCallId]);
          assert.doesNotMatch(JSON.stringify(nextOutcome), FORBIDDEN_PUBLIC_GATE);

          const oldPhysicalAfterNextSource = resumedDb.prepare(`
            SELECT logical_tool_call_id, tool_name, state, execution_site
              FROM physical_dispatches
             WHERE session_id = ? AND source_user_seq = ?
               AND logical_tool_call_id = ?
             ORDER BY logical_tool_call_id, ordinal
          `).all(plannedSession.id, source.seq, workCallId);
          const oldSettlementAfterNextSource = resumedDb.prepare(`
            SELECT logical_tool_call_id, execution_kind, outcome_kind, business_call,
                   mutating, requirement_id, physical_crossing_count
              FROM logical_call_settlements
             WHERE session_id = ? AND source_user_seq = ?
               AND logical_tool_call_id = ?
             ORDER BY logical_tool_call_id
          `).all(plannedSession.id, source.seq, workCallId);
          assert.deepEqual(oldPhysicalAfterNextSource, resumedPhysical);
          assert.deepEqual(oldSettlementAfterNextSource, resumedSettlements);
          return;
        }
        assert.equal(resumed.terminal, undefined, 'approved exact grant must not become a generic block');
        assert.equal(resumed.finalOutput, `${candidate.label} completed from its exact accepted plan.`);
        assert.equal(writeBodies, 1, 'the approved high-consequence provider body executes once');
        assert.equal(localBodies, 1, 'the ordinary local sibling executes once after frame consent completes');
        assert.equal(bodies, 1, 'resume performs exactly one accepted provider body');
        assert.deepEqual(bindingCountsAtBody, [{ work: 1, host: 1 }, { work: 1, host: 1 }]);
        assert.deepEqual(seenLocalArgs, [ordinarySiblingArgs]);
        assert.deepEqual(seenProviderArgs, [candidate.args]);
        assert.deepEqual(mutationBodyOrder, ['local_update', 'send']);
        assert.deepEqual(resumedSettlements, [
          {
            logical_tool_call_id: workCallId,
            execution_kind: 'local_execution',
            outcome_kind: 'succeeded',
            business_call: 1,
            mutating: 1,
            requirement_id: operationId,
            physical_crossing_count: 0,
          },
          {
            logical_tool_call_id: ordinarySiblingCallId,
            execution_kind: 'local_execution',
            outcome_kind: 'succeeded',
            business_call: 1,
            mutating: 1,
            requirement_id: ordinarySiblingOperationId,
            physical_crossing_count: 0,
          },
        ]);
        assert.deepEqual(resumedPhysical, [
          {
            logical_tool_call_id: workCallId,
            tool_name: candidate.operation.toLowerCase(),
            state: 'returned',
            execution_site: 'host',
          },
          {
            logical_tool_call_id: ordinarySiblingCallId,
            tool_name: ordinarySiblingLocalName,
            state: 'returned',
            execution_site: 'host',
          },
        ]);
        assert.deepEqual(resumedOperations, [
          {
            operation_id: operationId,
            logical_tool_call_id: workCallId,
            graph_node_id: 'n7:verify',
            effect_kind: 'external_write',
            outcome_kind: 'succeeded',
            dispatch_state: 'dispatched',
          },
          {
            operation_id: ordinarySiblingOperationId,
            logical_tool_call_id: ordinarySiblingCallId,
            graph_node_id: 'n7:verify',
            effect_kind: 'local_write',
            outcome_kind: 'succeeded',
            dispatch_state: 'dispatched',
          },
        ]);
        assert.deepEqual(unmatchedFunctionCallIds({ input: resumed.history }), []);
        assert.doesNotMatch(JSON.stringify(resumed), FORBIDDEN_PUBLIC_GATE);

        const replayed = await brackets.withHarnessRunContext({
          ...parent,
          counter: new brackets.ToolCallsCounter(12),
          behaviorScopeId: `${plannedSession.id}::resume:replay`,
        }, () => hostRunRunner(
          throwingRunner() as never,
          agent as never,
          HostInterruptState.fromString(restartBytes) as never,
          {
            maxTurns: 6,
            hostTurnEngine: 'host_v1',
            hostApprovalId: approval.approvalId,
            context: { sessionId: plannedSession.id, sourceUserSeq: source.seq, turn: 3 },
          } as never,
        ));
        assert.equal(replayed.terminal, undefined);
        assert.equal(localBodies, 1, 'settled replay cannot repeat the ordinary sibling body');
        assert.equal(writeBodies, 1, 'settled replay cannot repeat the approved send body');
        assert.equal(bodies, 1, 'settled replay cannot cross the provider again');
      }
    });
  }
});

test('retired bare SDK adapter pairs unsupported discovery without becoming a public gate', async (t) => {
  const audit: Array<Record<string, unknown>> = [];
  await t.test('simple chat', async () => {
    const result = await runLegacySdkSource({
      prompt: 'Explain recursion in one sentence.',
      responses: [[assistantText('Recursion is a process defined in terms of smaller instances of itself.')]],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.outcome?.finalOutput,
      'Recursion is a process defined in terms of smaller instances of itself.');
    assert.equal(result.outcome?.hasInterruptions, false);
    assert.equal(result.model.calls(), 1);
    audit.push({ label: 'simple chat', bodies: 0, modelCalls: 1, ...result.counts });
  });

  const directCases = [
    { label: 'local pure read', name: 'workspace_roots', args: {} },
    {
      label: 'reversible local file create', name: 'write_file',
      args: { path: '/fixture/draft.txt', content: 'draft', append: false },
    },
    { label: 'browser status read', name: 'browser_harness_status', args: {} },
    {
      label: 'Workspace create', name: 'space_save',
      args: { slug: 'fixture-space', title: 'Fixture Space', view_html: '<h1>Fixture</h1>' },
    },
    { label: 'Workspace work/read', name: 'space_get', args: { slug: 'fixture-space' } },
    {
      label: 'Workspace edit', name: 'space_edit_view',
      args: { slug: 'fixture-space', find: 'Fixture', replace: 'Updated Fixture' },
    },
    {
      label: 'workflow author', name: 'workflow_create',
      args: { name: 'fixture-workflow', description: 'Fixture workflow', steps: [] },
      result: toolRegistry.withTerminalAuthoringEvidenceReceipt(
        'workflow_create',
        'Created disabled workflow fixture-workflow.',
      ),
    },
    {
      label: 'workflow change', name: 'workflow_update',
      args: { name: 'fixture-workflow', description: 'Updated fixture workflow' },
    },
    {
      label: 'workflow run', name: 'workflow_run',
      args: { name: 'fixture-workflow', inputs: '{}' },
    },
  ] as const;

  for (const [index, candidate] of directCases.entries()) {
    await t.test(candidate.label, async () => {
      const seen: Array<Record<string, unknown>> = [];
      const tool = sdkRecordingTool({
        name: candidate.name,
        args: candidate.args,
        result: 'result' in candidate ? candidate.result : undefined,
        seen,
      });
      const result = await runLegacySdkSource({
        prompt: `Legacy SDK: ${candidate.label}.`,
        tools: [tool],
        responses: [
          [functionCall(`legacy-matrix-${index}`, candidate.name, candidate.args)],
          [assistantText(`${candidate.label} completed`) ],
        ],
      });
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.outcome?.hasInterruptions, false, candidate.label);
      assert.equal(result.outcome?.finalOutput, `${candidate.label} completed`);
      assert.equal(result.model.calls(), 2);
      assert.equal(
        seen.length,
        1,
        `${candidate.label}: write/read body must run at most once; `
          + `second request=${JSON.stringify(result.model.inputs()[1] ?? null)}`,
      );
      assert.doesNotMatch(JSON.stringify(result.outcome), FORBIDDEN_PUBLIC_GATE, candidate.label);
      audit.push({ label: candidate.label, bodies: seen.length, modelCalls: 2, ...result.counts });
    });
  }

  const retiredDiscoveryCases = [
    {
      label: 'Composio discovery read', name: 'composio_search_tools',
      args: { queries: [{ use_case: 'find calendar events' }] },
    },
    {
      label: 'MCP inventory read', name: 'mcp_list_tools',
      args: { server: 'fixture-calendar', query: 'events', limit: 5 },
    },
  ] as const;

  for (const [index, candidate] of retiredDiscoveryCases.entries()) {
    await t.test(`retired bare SDK characterization: ${candidate.label}`, async () => {
      const seen: Array<Record<string, unknown>> = [];
      const callId = `legacy-discovery-${index}`;
      const tool = sdkRecordingTool({
        name: candidate.name,
        args: candidate.args,
        seen,
      });
      const result = await runLegacySdkSource({
        prompt: `Retired bare SDK: ${candidate.label}.`,
        tools: [tool],
        responses: [
          [functionCall(callId, candidate.name, candidate.args)],
          [assistantText(`${candidate.label} was safely replanned.`)],
        ],
      });

      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.outcome?.hasInterruptions, false);
      assert.equal(
        (result.outcome as { terminal?: unknown } | undefined)?.terminal,
        undefined,
        'a retired transport limitation is model-visible data, never a public terminal',
      );
      assert.equal(result.outcome?.finalOutput, `${candidate.label} was safely replanned.`);
      assert.equal(result.model.calls(), 2);
      assert.equal(seen.length, 0, 'bare SDK has no accepted task authority for discovery I/O');
      assert.equal(result.counts.physical_dispatches, 0, 'the characterization remains pre-dispatch');
      assert.equal(result.counts.logical_call_settlements, 1, 'the refused call is durably paired once');
      assert.deepEqual(functionCallIds(result.outcome?.history), [callId]);
      assert.deepEqual(functionResultIds(result.outcome?.history), [callId]);
      assert.deepEqual(unmatchedFunctionCallIds({ input: result.outcome?.history }), []);
      const secondRequest = result.model.inputs()[1] as { input?: unknown } | undefined;
      assert.match(
        String(functionResultTextFor(secondRequest?.input, callId)),
        /discovery budget denied \(task_not_initialized\)/,
      );
      assert.doesNotMatch(String(result.outcome?.finalOutput), FORBIDDEN_PUBLIC_GATE);
      audit.push({
        label: `retired bare SDK characterization: ${candidate.label}`,
        bodies: seen.length,
        modelCalls: 2,
        ...result.counts,
      });
    });
  }

  await t.test('call_tool strict nullable normalization', async () => {
    const carrier = brackets.wrapToolForHarness(callTools.buildCallTool({
      reachableBuiltinNames: new Set(['mcp_list_tools']),
      firstClassNames: new Set(['call_tool']),
      deniedNames: new Set(),
      mcpToolScope: null,
      controlOnlyBuiltins: true,
      admitBuiltinAcquisition: async (name) => name === 'mcp_list_tools'
        ? { ok: true }
        : { ok: false, kind: 'requires_readmission', outside: [name] },
    })) as FunctionTool;
    const result = await runLegacySdkSource({
      prompt: 'Use the deferred MCP inventory carrier for the calendar server.',
      tools: [carrier],
      responses: [
        [functionCall('legacy-call-tool-normalization', 'call_tool', {
          name: 'mcp_list_tools',
          args_json: JSON.stringify({
            server: 'fixture-not-configured', query: 'calendar inventory', limit: 1,
          }),
        })],
        [assistantText('Deferred MCP inventory completed without an authority conflict.')],
      ],
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.outcome?.hasInterruptions, false);
    assert.equal(result.outcome?.finalOutput,
      'Deferred MCP inventory completed without an authority conflict.');
    assert.equal(result.model.calls(), 2);
    assert.doesNotMatch(JSON.stringify(result.outcome), FORBIDDEN_PUBLIC_GATE);
    audit.push({ label: 'call_tool strict nullable normalization', modelCalls: 2, ...result.counts });
  });

  t.diagnostic(`legacy SDK ordinary matrix ledger: ${JSON.stringify(audit)}`);
});

function unmatchedFunctionCallIds(request: unknown): string[] {
  const input = request && typeof request === 'object'
    ? (request as { input?: unknown }).input
    : undefined;
  if (!Array.isArray(input)) return [];
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { type?: unknown; callId?: unknown; call_id?: unknown };
    const callId = typeof record.callId === 'string'
      ? record.callId
      : typeof record.call_id === 'string'
        ? record.call_id
        : '';
    if (!callId) continue;
    if (record.type === 'function_call') calls.add(callId);
    if (record.type === 'function_call_result' || record.type === 'function_call_output') {
      results.add(callId);
    }
  }
  return [...calls].filter((callId) => !results.has(callId));
}

function functionCallIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as { type?: unknown; callId?: unknown; call_id?: unknown };
    if (record.type !== 'function_call') return [];
    const callId = typeof record.callId === 'string'
      ? record.callId
      : typeof record.call_id === 'string'
        ? record.call_id
        : '';
    return callId ? [callId] : [];
  });
}

function functionResultIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as { type?: unknown; callId?: unknown; call_id?: unknown };
    if (record.type !== 'function_call_result' && record.type !== 'function_call_output') return [];
    const callId = typeof record.callId === 'string'
      ? record.callId
      : typeof record.call_id === 'string'
        ? record.call_id
        : '';
    return callId ? [callId] : [];
  });
}

function functionResultTextFor(items: unknown, callId: string): string | null {
  if (!Array.isArray(items)) return null;
  const match = items.find((item) => {
    if (!item || typeof item !== 'object') return false;
    const record = item as { type?: unknown; callId?: unknown; call_id?: unknown };
    const candidateId = typeof record.callId === 'string'
      ? record.callId
      : typeof record.call_id === 'string'
        ? record.call_id
        : '';
    return (record.type === 'function_call_result' || record.type === 'function_call_output')
      && candidateId === callId;
  }) as { output?: unknown } | undefined;
  const output = match?.output;
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const text = (output as { text?: unknown }).text;
    return typeof text === 'string' ? text : null;
  }
  if (Array.isArray(output)) {
    for (const part of output) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  return null;
}

function zeroCrossingRefusalTools(
  callSpecs: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
  onBody: () => void,
): FunctionTool[] {
  return callSpecs.map((spec) => {
    const properties = Object.fromEntries(Object.entries(spec.args).map(([key, value]) => [
      key,
      { type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string' },
    ]));
    return brackets.wrapToolForHarness({
      type: 'function',
      name: spec.name,
      description: `Stable configured ${spec.name} read for a zero-crossing frame.`,
      parameters: strictSchema(properties, Object.keys(spec.args)),
      inputGuardrails: [{
        type: 'tool_input',
        name: `fixture-${spec.name}-zero-crossing-authority-refusal`,
        run: async () => {
          // A typed host-owned authority refusal raised after model admission
          // but before invokeHostToolCall is the deterministic zero-crossing
          // analogue of the live call-binding conflict. Each sibling fails
          // independently, without mutating the model-visible tool surface.
          throw new hostInvocation.HostToolInvocationAuthorityError(
            `fixture zero-crossing refusal for ${spec.name}`,
          );
        },
      }],
      needsApproval: async () => false,
      invoke: async () => {
        onBody();
        return 'must not run';
      },
    } as never) as FunctionTool;
  });
}

test('host stepper pairs an ordered three-call zero-crossing refusal and replans in the same turn', async (t) => {
  const replanSession = HarnessSession.create({
    id: 'discord-like-three-call-zero-crossing-replan',
    kind: 'chat',
    channel: 'discord',
  });
  const callIds = ['zero-crossing-call-1', 'zero-crossing-call-2', 'zero-crossing-call-3'];
  let bodies = 0;
  const callSpecs = [
    { callId: callIds[0]!, name: 'workspace_roots', args: {} },
    { callId: callIds[1]!, name: 'space_get', args: { slug: 'fixture-space' } },
    { callId: callIds[2]!, name: 'browser_harness_status', args: {} },
  ];
  const driftingTools = zeroCrossingRefusalTools(callSpecs, () => { bodies += 1; });

  const model = scriptedModel([
    callSpecs.map((spec) => functionCall(spec.callId, spec.name, spec.args)),
    [assistantText('The refused reads were replanned without ending the conversation.')],
  ]);
  const agent = { model, tools: driftingTools, instructions: 'Repair zero-crossing refusals.' };
  bindSurface(replanSession.id, agent, driftingTools);
  const source = replanSession.recordUserInput('Check three workspace roots, then continue safely.', 1);
  const parent = {
    sessionId: replanSession.id,
    sourceUserSeq: source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${replanSession.id}::turn:1`,
  };
  const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ role: 'user', content: 'Check three workspace roots, then continue safely.' }] as never,
    {
      maxTurns: 4,
      hostTurnEngine: 'host_v1',
      context: { sessionId: replanSession.id, sourceUserSeq: source.seq, turn: 1 },
    } as never,
  ));
  const db = eventlog.openEventLog();
  const crossingCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(replanSession.id, source.seq) as { n: number }).n;
  const observed = {
    bodies,
    crossings: crossingCount,
    modelCalls: model.calls(),
    callIds: functionCallIds(outcome.history),
    resultIds: functionResultIds(outcome.history),
    unmatched: unmatchedFunctionCallIds({ input: outcome.history }),
    terminal: outcome.terminal?.status ?? null,
    terminalReason: outcome.terminal?.reason ?? null,
    finalOutput: outcome.finalOutput ?? null,
  };
  t.diagnostic(`zero-crossing staged-frame observation: ${JSON.stringify(observed)}`);
  assert.deepEqual(observed, {
    bodies: 0,
    crossings: 0,
    modelCalls: 2,
    callIds,
    resultIds: callIds,
    unmatched: [],
    terminal: null,
    terminalReason: null,
    finalOutput: 'The refused reads were replanned without ending the conversation.',
  });
});

test('an actual paired three-call pre-dispatch refusal survives restart and cannot poison the next source', async () => {
  const continuitySession = HarnessSession.create({
    id: 'discord-like-conflict-next-source',
    kind: 'chat',
    channel: 'discord',
  });
  const callIds = [
    'continuity-refused-call-1',
    'continuity-refused-call-2',
    'continuity-refused-call-3',
  ];
  const callSpecs = [
    { callId: callIds[0]!, name: 'workspace_roots', args: {} },
    { callId: callIds[1]!, name: 'space_get', args: { slug: 'fixture-space' } },
    { callId: callIds[2]!, name: 'browser_harness_status', args: {} },
  ];
  let bodies = 0;
  const refusalTools = zeroCrossingRefusalTools(callSpecs, () => { bodies += 1; });
  const refusalModel = scriptedModel([
    callSpecs.map((spec) => functionCall(spec.callId, spec.name, spec.args)),
    [assistantText('The refused reads were safely replanned before restart.')],
  ]);
  const refusalAgent = {
    model: refusalModel,
    tools: refusalTools,
    instructions: 'Repair zero-crossing refusals before completing.',
  };
  bindSurface(continuitySession.id, refusalAgent, refusalTools);
  const firstSource = continuitySession.recordUserInput('List three available workspace roots.', 1);
  const firstParent = {
    sessionId: continuitySession.id,
    sourceUserSeq: firstSource.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${continuitySession.id}::turn:1`,
  };
  const firstOutcome = await brackets.withHarnessRunContext(firstParent, () => hostRunRunner(
    throwingRunner() as never,
    refusalAgent as never,
    [{ role: 'user', content: 'List three available workspace roots.' }] as never,
    {
      maxTurns: 4,
      hostTurnEngine: 'host_v1',
      context: {
        sessionId: continuitySession.id,
        sourceUserSeq: firstSource.seq,
        turn: 1,
      },
    } as never,
  ));

  assert.equal(bodies, 0, 'pre-dispatch refusals must not enter a tool body');
  assert.equal(firstOutcome.terminal, undefined);
  assert.equal(firstOutcome.finalOutput, 'The refused reads were safely replanned before restart.');
  assert.deepEqual(functionCallIds(firstOutcome.history), callIds);
  assert.deepEqual(functionResultIds(firstOutcome.history), callIds);
  assert.deepEqual(unmatchedFunctionCallIds({ input: firstOutcome.history }), []);
  const firstCrossings = (eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(continuitySession.id, firstSource.seq) as { n: number }).n;
  assert.equal(firstCrossings, 0, 'the refused frame must have durable zero-crossing proof');

  // Persist the real balanced host outcome. Historical unmatched frames have
  // no such proof and belong to the evidence-driven migration/quarantine seam;
  // this restart contract must never fabricate results for them.
  continuitySession.recordTurnResult({
    history: firstOutcome.history,
    lastResponseId: firstOutcome.lastResponseId,
    turn: 1,
  });
  const restartedSession = HarnessSession.load(continuitySession.id);
  assert.ok(restartedSession, 'the conversation must rehydrate from durable session state');
  assert.deepEqual(functionCallIds(restartedSession.toInputItems()), callIds);
  assert.deepEqual(functionResultIds(restartedSession.toInputItems()), callIds);
  assert.deepEqual(unmatchedFunctionCallIds({ input: restartedSession.toInputItems() }), []);

  // The next source is unrelated and receives a fresh surface. Codex and
  // Claude both require function-call history to be structurally paired;
  // enforce that provider-neutral request invariant before returning a normal
  // response. This mirrors a real adapter rejecting an unmatched prior call.
  let secondRequests = 0;
  let secondUnmatched: string[] = [];
  const recoveryModel = {
    async getResponse(request: unknown) {
      secondRequests += 1;
      secondUnmatched = unmatchedFunctionCallIds(request);
      assert.deepEqual(
        secondUnmatched,
        [],
        'a blocked prior source leaked unmatched function calls into the next provider request',
      );
      return {
        responseId: 'continuity-recovery-response',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [assistantText('The unrelated next message completed normally.')],
      };
    },
    getStreamedResponse: modelStream,
  };
  const recoveryAgent = { model: recoveryModel, tools: [] as FunctionTool[] };
  bindSurface(continuitySession.id, recoveryAgent, []);
  const second = await runTurn({
    sessionId: continuitySession.id,
    input: 'Now answer this unrelated ordinary question.',
    agent: recoveryAgent as never,
    makeRunner: throwingRunner as never,
    runRunner: hostRunRunner as never,
    maxTurns: 3,
  });
  assert.equal(secondRequests, 1, 'the unrelated source reached the model exactly once');
  assert.equal(
    second.status,
    'completed',
    `unrelated next source failed with unmatched prior call ids: ${JSON.stringify(secondUnmatched)}`,
  );
  assert.equal(second.finalOutput, 'The unrelated next message completed normally.');
});

test('zero-crossing retirement is scoped to one accepted source and never suppresses an identical next-source call', async () => {
  const retirementSession = HarnessSession.create({
    id: 'discord-like-source-scoped-retirement',
    kind: 'chat',
    channel: 'discord',
  });
  const toolName = 'workspace_roots';
  const args = {};
  const sourceACallIds = ['retirement-source-a-1', 'retirement-source-a-2', 'retirement-source-a-3'];
  let bodies = 0;
  const sourceATools = zeroCrossingRefusalTools(
    [{ name: toolName, args }],
    () => { bodies += 1; },
  );
  const sourceAModel = scriptedModel(sourceACallIds.map((callId) => [
    functionCall(callId, toolName, args),
  ]));
  const sourceAAgent = {
    model: sourceAModel,
    tools: sourceATools,
    instructions: 'Try the exact safe read only while it remains available.',
  };
  bindSurface(retirementSession.id, sourceAAgent, sourceATools);
  const sourceA = retirementSession.recordUserInput('Try the configured workspace-roots read.', 1);
  const parentA = {
    sessionId: retirementSession.id,
    sourceUserSeq: sourceA.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${retirementSession.id}::turn:1`,
  };
  const outcomeA = await brackets.withHarnessRunContext(parentA, () => hostRunRunner(
    throwingRunner() as never,
    sourceAAgent as never,
    [{ role: 'user', content: 'Try the configured workspace-roots read.' }] as never,
    {
      maxTurns: 5,
      hostTurnEngine: 'host_v1',
      context: { sessionId: retirementSession.id, sourceUserSeq: sourceA.seq, turn: 1 },
    } as never,
  ));
  assert.equal(bodies, 0);
  assert.equal(sourceAModel.calls(), 3);
  assert.deepEqual(functionResultIds(outcomeA.history), sourceACallIds);
  assert.deepEqual(unmatchedFunctionCallIds({ input: outcomeA.history }), []);
  const sourceAFirst = JSON.parse(functionResultTextFor(outcomeA.history, sourceACallIds[0]!)!);
  const sourceASecond = JSON.parse(functionResultTextFor(outcomeA.history, sourceACallIds[1]!)!);
  const sourceARetired = JSON.parse(functionResultTextFor(outcomeA.history, sourceACallIds[2]!)!);
  assert.deepEqual(
    [sourceAFirst.retry, sourceASecond.retry, sourceARetired.retry],
    ['replan', 'replan', 'do_not_retry'],
  );
  retirementSession.recordTurnResult({
    history: outcomeA.history,
    lastResponseId: outcomeA.lastResponseId,
    turn: 1,
  });

  const sourceBCallId = 'retirement-source-b-identical';
  const sourceBTools = zeroCrossingRefusalTools(
    [{ name: toolName, args }],
    () => { bodies += 1; },
  );
  const sourceBModel = scriptedModel([
    [functionCall(sourceBCallId, toolName, args)],
    [assistantText('The identical next-source read was independently replanned.')],
  ]);
  const sourceBAgent = {
    model: sourceBModel,
    tools: sourceBTools,
    instructions: 'Treat this accepted source independently.',
  };
  bindSurface(retirementSession.id, sourceBAgent, sourceBTools);
  const outcomeB = await runTurn({
    sessionId: retirementSession.id,
    input: 'Try that same configured workspace-roots read for this new request.',
    agent: sourceBAgent as never,
    makeRunner: throwingRunner as never,
    runRunner: hostRunRunner as never,
    maxTurns: 3,
  });
  assert.equal(outcomeB.status, 'completed');
  assert.equal(outcomeB.finalOutput, 'The identical next-source read was independently replanned.');
  assert.equal(sourceBModel.calls(), 2, 'the new source must see a replan result, not inherited retirement');
  const sourceBSecondInput = (sourceBModel.inputs()[1] as { input?: unknown } | undefined)?.input;
  const sourceBResult = JSON.parse(functionResultTextFor(sourceBSecondInput, sourceBCallId)!);
  assert.equal(sourceBResult.retry, 'replan');
  assert.deepEqual(unmatchedFunctionCallIds({ input: sourceBSecondInput }), []);
  assert.equal(bodies, 0);
});

// The real accepted-work variants above own these two lifecycle gates:
// `approve_surface_loss` proves a vanished approved surface replans before
// I/O, and `approve_unknown_restart` proves an uncertain crossing cannot be
// redispatched after restart. Raw `write_file` calls have no accepted-task
// authority and must repair before approval, so duplicating those scenarios
// with an unplanned local carrier would test the opposite security contract.

test('legacy SDK owner pairs a multi-call turn but does not enforce the host capability seal', async (t) => {
  const legacySession = eventlog.createSession({
    id: 'discord-like-legacy-sdk-authority-probe',
    kind: 'chat',
    channel: 'discord',
  });
  const source = eventlog.appendEvent({
    sessionId: legacySession.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'List the fixture roots three times.' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: legacySession.id, sourceUserSeq: source.seq, turn: source.turn },
  }), 'legacy fixture persisted the accepted-source graph');
  let bodies = 0;
  const baseTool = sdk.tool({
    name: 'workspace_roots',
    description: 'Stable configured SDK read.',
    parameters: z.object({ slot: z.number() }),
    needsApproval: async () => false,
    execute: async ({ slot }) => {
      bodies += 1;
      return `fixture-root-${slot}`;
    },
  });
  const wrappedTool = brackets.wrapToolForHarness(baseTool);
  let modelCalls = 0;
  const requests: unknown[] = [];
  const model = {
    async getResponse(request: unknown) {
      requests.push(structuredClone(request));
      modelCalls += 1;
      if (modelCalls === 1) {
        // Drift after the model-visible surface was sealed. host_v1 refuses
        // this before a body crossing; the legacy SDK resolves by name alone.
        wrappedTool.description = 'Changed after model admission.';
        return {
          responseId: 'legacy-sdk-calls',
          usage: new sdk.Usage(),
          output: [1, 2, 3].map((slot) => ({
            type: 'function_call',
            id: `fc-legacy-${slot}`,
            callId: `legacy-call-${slot}`,
            name: 'workspace_roots',
            arguments: JSON.stringify({ slot }),
            status: 'completed',
          })),
        };
      }
      return {
        responseId: 'legacy-sdk-finished',
        usage: new sdk.Usage(),
        output: [{
          type: 'message',
          id: 'legacy-sdk-message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'All three fixture reads completed.', providerData: {} }],
        }],
      };
    },
    getStreamedResponse: modelStream,
  };
  const agent = new sdk.Agent({
    name: 'Legacy SDK authority probe',
    instructions: 'Complete the fixture request.',
    model: model as never,
    tools: [wrappedTool],
  });
  bindSurface(legacySession.id, agent, [wrappedTool as FunctionTool]);
  const parent = {
    sessionId: legacySession.id,
    sourceUserSeq: source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${legacySession.id}::turn:1`,
  };
  const result = await brackets.withHarnessRunContext(parent, () => __defaultRunRunner(
    new sdk.Runner(),
    agent as never,
    [{ role: 'user', content: 'List the fixture roots three times.' }] as never,
    {
      maxTurns: 4,
      tracingDisabled: true,
      context: { sessionId: legacySession.id, sourceUserSeq: source.seq, turn: 1 },
    } as never,
  ));

  assert.equal(result.finalOutput, 'All three fixture reads completed.');
  assert.equal(modelCalls, 2);
  assert.equal(bodies, 3, 'legacy SDK executed all drifted bodies');
  const secondInput = (requests[1] as { input?: unknown[] } | undefined)?.input ?? [];
  assert.deepEqual(unmatchedFunctionCallIds({ input: secondInput }), []);
  assert.equal(secondInput.filter((item) => (item as { type?: string }).type === 'function_call').length, 3);
  assert.equal(secondInput.filter((item) => (item as { type?: string }).type === 'function_call_result').length, 3);
  const db = eventlog.openEventLog();
  const sourceCounts = Object.fromEntries([
    'accepted_task_resolutions',
    'accepted_task_authority',
    'accepted_turn_call_authorities',
    'logical_tool_calls',
    'physical_dispatches',
    'logical_call_settlements',
    'evidence_receipts',
  ].map((table) => [table, (db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ? AND source_user_seq = ?`,
  ).get(legacySession.id, source.seq) as { n: number }).n]));
  const eventCounts = Object.fromEntries((db.prepare(`
    SELECT type, COUNT(*) AS n
    FROM events
    WHERE session_id = ? AND seq >= ?
    GROUP BY type
  `).all(legacySession.id, source.seq) as Array<{ type: string; n: number }>)
    .map((row) => [row.type, row.n]));
  t.diagnostic(`legacy SDK drift ledger: ${JSON.stringify({ sourceCounts, eventCounts })}`);
});

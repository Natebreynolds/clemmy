/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-read-fast-path.test.ts
 *
 * Regression pins for the 2026-08-26 gauntlet break (B1 feeder c, hole 12):
 * the production host engine refused READ-effect provider calls on carrier
 * provenance and frozen-catalog membership, never consulting the effect it
 * had already computed (live: GOOGLEDRIVE_FIND_FILE, effect 'read', refused
 * with "only admits configured harness-bounded tools"). Contract under pin:
 *   1. A read-effect composio call whose exact operation this turn PROVED
 *      (capability_resolution ledger) dispatches even when no frozen-catalog
 *      entry exists (the pre-plan surface is empty) — frozen membership is
 *      the WRITE bar.
 *   2. The same proven read dispatches even when the carrier tool object is
 *      not the wrapToolForHarness-attested configured object (the live
 *      claude-lane shape).
 *   3. A WRITE through the same unattested carrier keeps the full wall.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-read-fast-path-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
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
process.env.COMPOSIO_API_KEY = 'fixture-composio-key';
process.env.COMPOSIO_USER_ID = 'fixture-user';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-host-read-fast-path\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const composioClient = await import('../../integrations/composio/client.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { hostRunRunner } = await import('./host-turn-runner.js');

const DRIVE_OPERATION = 'GOOGLEDRIVE_FIND_FILE';
const WRITE_OPERATION = 'GOOGLESHEETS_VALUES_UPDATE';

let providerExecutions: string[] = [];
composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
composioClient.__test__.setConnectedAccountsLoader(async () => [
  { id: 'conn-googledrive', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'googledrive' } },
  { id: 'conn-googlesheets', status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'googlesheets' } },
]);
composioClient.__test__.setComposioClient({
  client: { baseURL: 'https://backend.composio.dev' },
  getClient: () => ({
    withOptions: () => ({
      tools: {
        execute: async (operation: string) => {
          providerExecutions.push(operation);
          return {
            data: operation === DRIVE_OPERATION
              ? { files: [{ id: 'gauntlet-sheet', name: 'Gauntlet Sheet' }] }
              : { updated: true },
            error: null,
            successful: true,
            log_id: `fixture-${providerExecutions.length}`,
          };
        },
      },
    }),
  }),
  tools: {
    async getRawComposioTools(input: { tools?: string[]; toolkits?: string[] }) {
      const exact = new Set((input.tools ?? []).map((value) => value.toUpperCase()));
      const rawTools = [
        {
          slug: DRIVE_OPERATION,
          name: 'Find file in Google Drive',
          description: 'Find files by name in the connected Google Drive.',
          toolkit: { slug: 'googledrive' },
          inputParameters: {
            type: 'object',
            additionalProperties: false,
            required: ['query'],
            properties: { query: { type: 'string' } },
          },
          outputParameters: { type: 'object', properties: { files: { type: 'array' } } },
          version: 'fixture-googledrive-v1',
        },
        {
          slug: WRITE_OPERATION,
          name: 'Update sheet values',
          description: 'Update values in an existing Google Sheet.',
          toolkit: { slug: 'googlesheets' },
          inputParameters: {
            type: 'object',
            required: ['spreadsheet_id', 'values'],
            properties: { spreadsheet_id: { type: 'string' }, values: { type: 'array' } },
          },
          outputParameters: { type: 'object', properties: { updated: { type: 'boolean' } } },
          version: 'fixture-googlesheets-v1',
        },
      ];
      return rawTools.filter((candidate) => exact.size === 0 || exact.has(candidate.slug));
    },
    async execute() {
      providerExecutions.push('legacy-execute');
      return { data: { files: [{ id: 'gauntlet-sheet', name: 'Gauntlet Sheet' }] }, error: null, successful: true };
    },
  },
});

after(() => {
  composioClient.__test__.setComposioClient(null);
  composioClient.__test__.setConnectedAccountsLoader(null);
  composioClient.__test__.setComposioApiKeyOverride(null);
  composioClient.resetComposioClient();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function functionCall(callId: string, name: string, args: Record<string, unknown>) {
  return { type: 'function_call', callId, name, arguments: JSON.stringify(args) };
}

function assistantText(text: string) {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

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
      finishReason: output.some((item) => (item as { type?: string }).type === 'function_call')
        ? 'tool_calls'
        : 'stop',
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

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('legacy Runner.run must remain unreachable');
  };
  return runner;
}

async function runOneProvenCallTurn(input: {
  label: string;
  call: { name: string; args: Record<string, unknown> };
  provenEntries: Array<{ identifier: string; effectClass: 'read' | 'write' }>;
  breakCarrierAttestation: boolean;
}): Promise<{ resultText: string }> {
  const prompt = 'Is there already a sheet called Gauntlet Sheet in my drive?';
  const session = eventlog.createSession({
    id: `host-read-fast-path-${input.label}`,
    kind: 'chat',
    channel: 'discord',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: prompt },
  });
  // The turn's own host-verified proof ledger (the exact rows the live
  // gauntlet turn carried at call time: seq 80853/80854 class).
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'capability_resolution',
    data: {
      sourceUserSeq: source.seq,
      authoritativeForTask: true,
      registryAvailable: true,
      entries: input.provenEntries.map((entry) => ({
        intent: 'proven for this accepted source',
        kind: 'composio',
        identifier: entry.identifier,
        status: 'proven',
        connection: 'active',
        accountIdentity: entry.identifier === DRIVE_OPERATION ? 'conn-googledrive' : 'conn-googlesheets',
        effectClass: entry.effectClass,
      })),
    },
  });

  // Publish the CURRENT connected-account observation the way the live
  // discovery/preparation phase does; execution deliberately consumes only
  // this prepared snapshot and never starts a hidden account refresh.
  await composioClient.listUsableConnectedToolkits();

  let modelCalls = 0;
  let observedResult = '';
  const model = {
    async getResponse(rawRequest: unknown) {
      modelCalls += 1;
      let output: unknown[];
      if (modelCalls === 1) {
        output = [functionCall(`proven-call-${input.label}`, input.call.name, input.call.args)];
      } else {
        const request = rawRequest as { input?: unknown[] };
        const result = request.input?.find((item) =>
          item && typeof item === 'object'
          && (item as { callId?: unknown }).callId === `proven-call-${input.label}`
          && (item as { type?: unknown }).type === 'function_call_result');
        observedResult = JSON.stringify(result ?? '');
        output = [assistantText('done')];
      }
      return {
        responseId: `read-fast-path-${input.label}-${modelCalls}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output,
      };
    },
    getStreamedResponse: modelStream,
  };

  const agent = await buildOrchestratorAgent({
    userInput: prompt,
    sessionId: session.id,
    sourceUserSeq: source.seq,
    allowedToolNames: ['composio_execute_tool', 'tool_search'],
    allowToolJit: false,
    mcpToolScope: {
      authority: 'catalog',
      reason: 'read fast path pin',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    },
    model: model as never,
  });
  if (input.breakCarrierAttestation) {
    // The live claude-lane shape: the carrier is ON the surface with the same
    // name/schema/invoke, but it is not the exact wrapToolForHarness-attested
    // object identity.
    const agentTools = (agent as { tools?: unknown[] }).tools;
    assert.ok(Array.isArray(agentTools));
    const index = agentTools.findIndex((tool) =>
      (tool as { name?: string }).name === 'composio_execute_tool');
    assert.ok(index >= 0, 'the composio carrier is on the assembled surface');
    agentTools[index] = { ...(agentTools[index] as object) };
  }

  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(6),
    behaviorScopeId: `${session.id}::turn:1`,
  };
  await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ role: 'user', content: prompt }] as never,
    {
      maxTurns: 4,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
    } as never,
  ));
  assert.equal(modelCalls, 2, JSON.stringify(eventlog.listEvents(session.id).map((event) => ({
    seq: event.seq, type: event.type, data: event.data,
  }))));
  return { resultText: observedResult };
}

test('a proven read dispatches with no frozen-catalog member (frozen membership is the write bar)', async () => {
  providerExecutions = [];
  const { resultText } = await runOneProvenCallTurn({
    label: 'attested-read',
    call: {
      name: 'composio_execute_tool',
      args: {
        tool_slug: DRIVE_OPERATION,
        arguments: JSON.stringify({ query: 'Gauntlet Sheet' }),
        connected_account_id: 'conn-googledrive',
      },
    },
    provenEntries: [{ identifier: DRIVE_OPERATION, effectClass: 'read' }],
    breakCarrierAttestation: false,
  });
  assert.doesNotMatch(resultText, /refused before dispatch/,
    `the read-effect call must pass the host wall: ${resultText}`);
  assert.match(resultText, /Gauntlet Sheet/, resultText);
  assert.deepEqual(providerExecutions, [DRIVE_OPERATION]);
});

test('the same proven read dispatches through a non-attested carrier object (the live claude-lane shape)', async () => {
  providerExecutions = [];
  const { resultText } = await runOneProvenCallTurn({
    label: 'unattested-read',
    call: {
      name: 'composio_execute_tool',
      args: {
        tool_slug: DRIVE_OPERATION,
        arguments: JSON.stringify({ query: 'Gauntlet Sheet' }),
        connected_account_id: 'conn-googledrive',
      },
    },
    provenEntries: [{ identifier: DRIVE_OPERATION, effectClass: 'read' }],
    breakCarrierAttestation: true,
  });
  assert.doesNotMatch(resultText, /refused before dispatch/,
    `a proven discovery read never dies at the provenance wall: ${resultText}`);
  assert.match(resultText, /Gauntlet Sheet/, resultText);
  assert.deepEqual(providerExecutions, [DRIVE_OPERATION]);
});

test('a write through the same non-attested carrier keeps the full wall', async () => {
  providerExecutions = [];
  const { resultText } = await runOneProvenCallTurn({
    label: 'unattested-write',
    call: {
      name: 'composio_execute_tool',
      args: {
        tool_slug: WRITE_OPERATION,
        arguments: JSON.stringify({ spreadsheet_id: 'gauntlet-sheet', values: [['x']] }),
        connected_account_id: 'conn-googlesheets',
      },
    },
    provenEntries: [{ identifier: WRITE_OPERATION, effectClass: 'write' }],
    breakCarrierAttestation: true,
  });
  assert.match(resultText, /refused before dispatch/,
    `writes keep the attested-carrier + frozen-manifest wall: ${resultText}`);
  assert.deepEqual(providerExecutions, [], 'no write bytes cross the wall');
});

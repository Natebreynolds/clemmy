/**
 * Governing NEXT-TAG provider-neutral matrix — foreground read cohort.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/journeys/provider-neutral-foreground-read.acceptance.test.ts
 *
 * Matrix rows 1 and 3 enter through the exported Discord conversation bridge.
 * The only injected boundaries are the model wire and one connected provider
 * wire. A cold search materializes one exact account-bound read capability;
 * the model consumes page one's settled cursor to form page two, and the host
 * publishes one terminal without ever compiling or promoting a graph.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-provider-neutral-foreground-read-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.5';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_COMPLETION_REVIEW = 'on';
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
process.env.CLEMMY_AUTH_FALLOVER = 'off';
process.env.CLEMMY_PROACTIVE_REPORT_DEFER = 'off';
process.env.CLEMMY_PLAN_FIRST = 'off';
process.env.CLEMMY_DYNAMIC_REASONING = 'off';
process.env.CLEMMY_EVAL_AUTO_PROMOTE = 'off';
process.env.COMPOSIO_API_KEY = '';
process.env.COMPOSIO_USER_ID = '';

mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-provider-neutral-foreground-read\n');
writeFileSync(path.join(HOME, 'state', 'auth.json'), JSON.stringify({
  source: 'native',
  codexOauth: {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    lastRefresh: new Date().toISOString(),
  },
}));

const discord = await import('../channels/discord-harness.js');
const bridge = await import('../runtime/harness/respond-bridge.js');
const { configureHarnessRuntime, resetHarnessRuntimeConfig } = await import('../runtime/harness/codex-client.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const capabilityIndex = await import('../memory/capability-index.js');
const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const capabilityStores = await import('../runtime/harness/capability-manifest-store.js');
const toolkitSlugs = await import('../integrations/composio/toolkit-slug.js');
const innerDispatch = await import('../tools/inner-dispatch.js');
const mcpConfig = await import('../runtime/mcp-config.js');
const mcpServers = await import('../runtime/mcp-servers.js');
const productionPorts = await import('../runtime/harness/production-capability-ports.js');
const semanticPorts = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const memoryDb = await import('../memory/db.js');
const requestObservation = await import('../runtime/harness/prompt-cache-observation.js');
const requestProvenance = await import('../runtime/harness/model-request-provenance.js');
const authorityPayloads = await import('../runtime/harness/authority-encrypted-payload-store.js');
const callAuthority = await import('../runtime/harness/accepted-turn-call-authority.js');
const modelWire = await import('../runtime/harness/model-wire-registry.js');

const originalFetch = globalThis.fetch;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function generated(seed: number, label: string): string {
  return `${label}_${sha256(`${seed}\0${label}`).slice(0, 14)}`.toLowerCase();
}

// A genuine stdio MCP peer, parameterized entirely by generated environment
// values. The test reaches it through configured-server discovery, the
// namespace shim, live-definition materialization, and the immutable native
// MCP invoke port. It is intentionally not installed through an in-process
// provider or inner-dispatch test seam.
const GENERATED_MCP_PEER = String.raw`
let pending = '';
const send = (id, result, error) => {
  const message = error
    ? { jsonrpc: '2.0', id, error }
    : { jsonrpc: '2.0', id, result };
  process.stdout.write(JSON.stringify(message) + '\n');
};
const schema = {
  type: 'object',
  additionalProperties: false,
  required: [process.env.PN_QUERY_FIELD],
  properties: {
    [process.env.PN_QUERY_FIELD]: { type: 'string' },
    [process.env.PN_CURSOR_FIELD]: { type: 'string' },
  },
};
const handle = (request) => {
  if (request.method === 'notifications/initialized') return;
  if (request.id === undefined || request.id === null) return;
  if (request.method === 'initialize') {
    send(request.id, {
      protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: process.env.PN_SERVER_NAME, version: '1' },
    });
    return;
  }
  if (request.method === 'ping') { send(request.id, {}); return; }
  if (request.method === 'tools/list') {
    send(request.id, { tools: [{
      name: process.env.PN_TOOL_NAME,
      description: 'Retrieve every page of ' + process.env.PN_OBJECTIVE,
      inputSchema: schema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    }] });
    return;
  }
  if (request.method === 'tools/call') {
    const args = request.params?.arguments ?? {};
    if (request.params?.name !== process.env.PN_TOOL_NAME) {
      send(request.id, undefined, { code: -32602, message: 'unknown generated operation' });
      return;
    }
    const second = args[process.env.PN_CURSOR_FIELD] === process.env.PN_CURSOR;
    const payload = second
      ? {
          records: [{ [process.env.PN_RECORD_FIELD]: process.env.PN_RECORD_TWO }],
          next_cursor: null,
          has_more: false,
          received: args,
        }
      : {
          records: [{ [process.env.PN_RECORD_FIELD]: process.env.PN_RECORD_ONE }],
          next_cursor: process.env.PN_CURSOR,
          has_more: true,
          received: args,
        };
    send(request.id, {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    });
    return;
  }
  send(request.id, undefined, { code: -32601, message: 'method not found' });
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf('\n');
    if (newline < 0) break;
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); }
    catch (error) {
      process.stderr.write(String(error?.stack ?? error) + '\n');
    }
  }
});
`;

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

async function* streamResponse(
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
      id: response.responseId ?? 'provider-neutral-read-response',
      usage: response.usage ?? { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

function resultText(request: unknown, callId: string): string | null {
  const input = (request as { input?: unknown[] } | null)?.input ?? [];
  for (const item of input) {
    const record = item as Record<string, unknown>;
    if (record.type !== 'function_call_result' || record.callId !== callId) continue;
    if (typeof record.output === 'string') return record.output;
    if (
      record.output
      && typeof record.output === 'object'
      && typeof (record.output as { text?: unknown }).text === 'string'
    ) return (record.output as { text: string }).text;
  }
  return null;
}

function decodeProviderResult(text: string): Record<string, unknown> {
  const encoded = text.split('\n\n[account-route]', 1)[0] ?? text;
  let value: unknown = JSON.parse(encoded) as unknown;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const carrierEnvelope = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(carrierEnvelope, 'result')) {
      assert.equal(carrierEnvelope.complete, true,
        'provider carrier result envelope was not complete');
      assert.ok(carrierEnvelope.result && typeof carrierEnvelope.result === 'object'
        && !Array.isArray(carrierEnvelope.result), text);
      assert.equal((carrierEnvelope.result as Record<string, unknown>).isError, false,
        'provider carrier reported an error result');
      value = carrierEnvelope.result;
    }
  }
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof value === 'string') {
      value = JSON.parse(value) as unknown;
      continue;
    }
    if (Array.isArray(value)) {
      const content = value.find((entry) => (
        entry && typeof entry === 'object' && typeof (entry as { text?: unknown }).text === 'string'
      )) as { text: string } | undefined;
      assert.ok(content, text);
      value = content.text;
      continue;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.records)) return record;
      if (record.structuredContent && typeof record.structuredContent === 'object') {
        value = record.structuredContent;
        continue;
      }
      if (Array.isArray(record.content)) {
        value = record.content;
        continue;
      }
      if (record.data && typeof record.data === 'object') {
        value = record.data;
        continue;
      }
    }
    break;
  }
  assert.fail(`provider result had no readable record envelope: ${text}`);
}

function stringsStartingWith(value: unknown, prefix: string, output: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.startsWith(prefix)) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsStartingWith(item, prefix, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      stringsStartingWith(item, prefix, output);
    }
  }
  return output;
}

function replaceFirstExactString(value: unknown, target: string, replacement: string): boolean {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === target) {
        value[index] = replacement;
        return true;
      }
      if (replaceFirstExactString(value[index], target, replacement)) return true;
    }
    return false;
  }
  if (!value || typeof value !== 'object') return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === target) {
      (value as Record<string, unknown>)[key] = replacement;
      return true;
    }
    if (replaceFirstExactString(item, target, replacement)) return true;
  }
  return false;
}

interface RestartProjectionSummary {
  status: 'ok' | 'invalid';
  recordId: string;
  reason?: string;
  requestOrdinal?: number;
  normalizedRequestDigest?: string;
  hostProjectionDigest?: string;
  provenanceDigest?: string;
  cacheEligibility?: {
    cacheEligible: boolean;
    policyRevision: string | null;
    issues: string[];
  };
  layerDigests?: Record<string, { bytes: number; sha256: string }>;
  sourceEventId?: string;
  preambles?: Array<{ eventId: string; eventDigest: string; deliveryKey: string }>;
  verifiedMemory?: Array<{ eventId: string; recallId: string; recallDigest: string }>;
  disclosedEventIds?: string[];
  settlements?: Array<{
    logicalToolCallId: string;
    settlementDigest: string;
    resultHandleId: string | null;
    resultHandleDigest: string | null;
  }>;
  toolSchemaCount?: number;
  toolAuthorityDigest?: string;
}

interface RestartProjectionEnvelope {
  pid: number;
  parentPid: number;
  projections: RestartProjectionSummary[];
}

function recordingTransport() {
  const initial: string[] = [];
  const edits: string[] = [];
  const errors: string[] = [];
  const followups: string[] = [];
  return {
    initial,
    edits,
    errors,
    followups,
    transport: {
      async sendInitial(content: string) {
        initial.push(content);
        return { async edit(next: string) { edits.push(next); } };
      },
      async sendError(content: string) { errors.push(content); },
      async sendFollowup(content: string) { followups.push(content); },
    },
  };
}

test.after(async () => {
  innerDispatch._setInnerDispatchToolsForTests(null);
  innerDispatch._setInnerDispatchMcpResolverForTests(null);
  semanticPorts.installTurnSemanticModelPort(null);
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  capabilityStores.installCapabilityManifestStore(null);
  productionPorts.clearProductionCapabilityPorts();
  await mcpServers.invalidateConfiguredMcpServers();
  mcpConfig.invalidateMcpServerDiscoveryCache();
  bridge._setBridgeImplsForTests({});
  resetHarnessRuntimeConfig();
  capabilityIndex._resetCapabilityIndexForTest();
  eventlog.closeEventLog();
  memoryDb.closeMemoryDb();
  globalThis.fetch = originalFetch;
  rmSync(HOME, { recursive: true, force: true });
});

test('matrix rows 1 and 3: a cold two-page read stays in one graphless foreground loop', {
  timeout: 120_000,
}, async () => {
  const seed = 43;
  const objective = generated(seed, 'ledger_snapshot');
  const serverName = generated(seed, 'unfamiliar_provider');
  const toolName = generated(seed, 'live_read_operation');
  const operationId = `${serverName}__${toolName}`;
  const queryField = generated(seed, 'query_field');
  const cursorField = generated(seed, 'cursor_field');
  const recordField = generated(seed, 'record_field');
  const cursor = generated(seed, 'opaque_cursor');
  const recordOne = generated(seed, 'record_one');
  const recordTwo = generated(seed, 'record_two');
  const prompt = `Retrieve the complete ${objective} from my connected account and report every record.`;
  const success = `Retrieved the complete ${objective} in two pages.`;
  const pageOneCallId = generated(seed, 'page_one_call');
  const pageTwoCallId = generated(seed, 'page_two_call');
  const sessionId = generated(seed, 'session');

  eventlog.resetEventLog();
  resetHarnessRuntimeConfig();
  capabilityIndex._resetCapabilityIndexForTest();
  const emptyStore = capabilityStores.createCapabilityManifestStore([], { durable: false });
  const emptyFactory = capabilityCatalogs.createHostCapabilityCatalogFactory();
  capabilityStores.installCapabilityManifestStore(emptyStore);
  capabilityCatalogs.installHostCapabilityCatalogFactory(emptyFactory);
  productionPorts.clearProductionCapabilityPorts();
  innerDispatch._setInnerDispatchToolsForTests(null);
  innerDispatch._setInnerDispatchMcpResolverForTests(null);
  const mcpDir = path.join(HOME, 'mcp');
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(path.join(mcpDir, 'servers.json'), JSON.stringify({
    [serverName]: {
      type: 'stdio',
      command: process.execPath,
      args: ['--input-type=module', '-e', GENERATED_MCP_PEER],
      env: {
        PN_SERVER_NAME: serverName,
        PN_TOOL_NAME: toolName,
        PN_OBJECTIVE: objective,
        PN_QUERY_FIELD: queryField,
        PN_CURSOR_FIELD: cursorField,
        PN_RECORD_FIELD: recordField,
        PN_CURSOR: cursor,
        PN_RECORD_ONE: recordOne,
        PN_RECORD_TWO: recordTwo,
      },
      description: `Generated unfamiliar source for ${objective}`,
      enabled: true,
    },
  }), 'utf8');
  mcpConfig.invalidateMcpServerDiscoveryCache();
  await mcpServers.invalidateConfiguredMcpServers();
  assert.deepEqual(capabilityIndex.searchCapabilityOperations(prompt), []);
  assert.equal(emptyStore.list().length, 0);
  assert.equal(emptyFactory.snapshot().length, 0);
  assert.equal(productionPorts.listProductionCapabilityPorts().length, 0);
  assert.equal(
    toolkitSlugs.isRegisteredToolkitSlug(serverName),
    false,
    'the generated MCP namespace accidentally depended on a registered provider toolkit',
  );
  assert.deepEqual(mcpServers.enabledExternalServerNames(), [serverName]);
  eventlog.createSession({
    id: sessionId,
    kind: 'chat',
    userId: generated(seed, 'user'),
  });

  const configured = await configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);
  const liveFactory = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  assert.ok(liveFactory);
  assert.deepEqual(liveFactory.snapshot(), [], 'cold bridge starts with no live catalog authority');
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    throw new Error(`journey forbids external network: ${String(request)}`);
  }) as typeof fetch;

  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('hidden semantic preflight is forbidden'); },
    async judgeSourceEffect() { throw new Error('hidden effect judge is forbidden'); },
    async judgePlanGrounding() { throw new Error('hidden plan judge is forbidden'); },
  });

  let acceptedSource: { seq: number; turn: number } | null = null;
  let modelStep = 0;
  let settledProviderPages = 0;
  const modelInputs: unknown[] = [];
  const model = {
    async getResponse(request: unknown) {
      modelStep += 1;
      modelInputs.push(structuredClone(request));
      const serialized = JSON.stringify(request);
      const tools = ((request as { tools?: Array<{ name?: string }> }).tools ?? [])
        .map((tool) => tool.name ?? '');
      let output: unknown[];
      if (modelStep === 1) {
        assert.match(serialized, new RegExp(objective));
        assert.ok(tools.includes('tool_search'));
        assert.equal(tools.includes('work_call'), false);
        output = [functionCall(generated(seed, 'search_call'), 'tool_search', {
          // Natural discovery adds useful context that need not occur verbatim
          // in a tools/list description. It must not hide a connected reader.
          query: `retrieve current ${objective} measurements from my connected service`,
          role_key: 'clause-0:read',
          limit: 4,
          cursor: null,
        })];
      } else if (modelStep === 2) {
        assert.match(serialized, new RegExp(operationId));
        assert.ok(tools.includes('work_call'));
        assert.equal(settledProviderPages, 0, 'discovery performed a business read');
        const nativeReads = capabilityCatalogs.peekHostCapabilityCatalogFactory()
          ?.snapshot().filter((entry) => entry.toolName === operationId) ?? [];
        assert.equal(nativeReads.length, 1, JSON.stringify(nativeReads.map((entry) => ({
          id: entry.capabilityId,
          operation: entry.toolName,
          effect: entry.effect,
          provider: entry.manifest?.providerKind,
        }))));
        assert.equal(nativeReads[0]!.effect, 'read');
        assert.equal(nativeReads[0]!.manifest?.providerKind, 'native_mcp');
        assert.match(nativeReads[0]!.capabilityId, /^cap:live:v1:/);
        assert.ok(serialized.includes(nativeReads[0]!.capabilityId));
        const liveReadNominations = eventlog.listEvents(sessionId, {
          types: ['capability_discovered'],
        }).flatMap((event) => (
          event.data.sourceUserSeq === acceptedSource?.seq
            && Array.isArray(event.data.capabilities)
            ? event.data.capabilities
            : []
        )).filter((raw): raw is Record<string, unknown> => Boolean(
          raw
          && typeof raw === 'object'
          && !Array.isArray(raw)
          && (raw as Record<string, unknown>).kind === 'authorized_live_read_registry'
          && (raw as Record<string, unknown>).identifier === operationId
        ));
        assert.equal(liveReadNominations.length, 1,
          'foreground descent lacked one same-source provider-neutral registry nomination');
        const liveReadNomination = liveReadNominations[0]!;
        assert.equal(liveReadNomination.capabilityRef, nativeReads[0]!.capabilityId);
        assert.equal(liveReadNomination.manifestDigest, nativeReads[0]!.manifestDigest);
        assert.equal(liveReadNomination.accountIdentity, nativeReads[0]!.manifest?.accountId);
        assert.equal(liveReadNomination.providerKind, nativeReads[0]!.manifest?.providerKind);
        output = [functionCall(pageOneCallId, 'work_call', {
          requirement_id: generated(seed, 'page_one_requirement'),
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: operationId,
          args_json: JSON.stringify({ [queryField]: objective }),
        })];
      } else if (modelStep === 3) {
        const firstText = resultText(request, pageOneCallId);
        assert.ok(firstText, 'page one did not settle back into primary-model history');
        const first = decodeProviderResult(firstText);
        settledProviderPages += 1;
        assert.equal(first.next_cursor, cursor);
        assert.equal(first.has_more, true);
        assert.deepEqual(first.records, [{ [recordField]: recordOne }]);
        assert.deepEqual(first.received, { [queryField]: objective });
        output = [functionCall(pageTwoCallId, 'work_call', {
          requirement_id: generated(seed, 'page_two_requirement'),
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: operationId,
          args_json: JSON.stringify({ [queryField]: objective, [cursorField]: first.next_cursor }),
        })];
      } else {
        const secondText = resultText(request, pageTwoCallId);
        assert.ok(secondText, 'page two did not settle back into primary-model history');
        const second = decodeProviderResult(secondText);
        settledProviderPages += 1;
        assert.equal(second.next_cursor, null);
        assert.equal(second.has_more, false);
        assert.deepEqual(second.records, [{ [recordField]: recordTwo }]);
        assert.deepEqual(second.received, { [queryField]: objective, [cursorField]: cursor });
        output = [textMessage(JSON.stringify({
          summary: success,
          reply: success,
          done: true,
          nextAction: 'completed',
          reason: null,
        }))];
      }
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output,
        responseId: `provider-neutral-read-response-${modelStep}`,
      };
    },
    getStreamedResponse: streamResponse,
  };
  bridge._setBridgeImplsForTests({
    buildAgent: async (options) => buildOrchestratorAgent({
      ...options,
      model: model as never,
    }),
  });

  const delivery = recordingTransport();
  await discord.runDiscordHarnessConversation({
    prompt,
    rawPrompt: prompt,
    channelId: generated(seed, 'channel'),
    userId: generated(seed, 'user'),
    guildId: generated(seed, 'guild'),
    transport: delivery.transport,
    durableRequest: {
      sessionId,
      runId: generated(seed, 'run'),
      onSourceAccepted(source: { seq: number; turn: number }) {
        acceptedSource = { seq: source.seq, turn: source.turn };
      },
    },
  });

  assert.ok(acceptedSource);
  const sourceUserSeq = acceptedSource!.seq;
  assert.equal(modelStep, 4, JSON.stringify({
    settledProviderPages,
    delivery,
    events: eventlog.listEvents(sessionId).map((event) => ({
      seq: event.seq,
      type: event.type,
      data: event.data,
    })),
  }));
  assert.equal(settledProviderPages, 2);
  assert.deepEqual(delivery.errors, []);
  assert.deepEqual(delivery.followups, []);
  const deliveredText = delivery.edits.at(-1) ?? delivery.initial.at(-1);
  assert.ok(deliveredText?.startsWith(`${success}\n\nVerification note:`),
    'preserve the completed provider read and the truthful unavailable-review note');

  const events = eventlog.listEvents(sessionId);
  const completion = events.find(event => event.type === 'conversation_completed'
    && event.data.sourceUserSeq === sourceUserSeq);
  assert.ok(completion);
  const reviewRef = completion.data.completionVerdictRef as Record<string, unknown>;
  assert.ok(reviewRef);
  const review = events.find(event => event.id === reviewRef.eventId);
  assert.equal(review?.type, 'goal_alignment_judged');
  assert.equal(review?.seq, reviewRef.seq);
  assert.equal(review?.data.sourceUserSeq, sourceUserSeq);
  assert.equal(review?.data.failedOpen, true, 'no completion provider wire is installed by this read-only fixture');
  assert.equal(review?.data.replyDigest, sha256(success));
  assert.equal(review?.data.objectiveDigest, sha256(prompt));
  assert.equal(typeof review?.data.reason, 'string');
  assert.ok(deliveredText?.includes(`Verification note: ${review!.data.reason}`));
  assert.match(deliveredText ?? '', /This result remains unreviewed\./);
  assert.doesNotMatch(deliveredText ?? '', /accepting completion/);
  assert.equal(reviewRef.verified, false);
  assert.equal(reviewRef.failedOpen, true);
  assert.equal(reviewRef.disposition, 'enabled_unavailable');
  assert.equal(reviewRef.policyEvidence, 'captured');
  assert.equal(reviewRef.deliveredTextIsJudgedText, false);
  assert.equal(completion.data.verificationDetail, 'completion_review_failed_open');
  assert.equal(completion.data.delivered, false, 'business success does not become reviewed terminal acceptance');
  assert.equal(completion.data.reason, 'blocked');
  assert.equal(events.filter((event) => event.type === 'conversation_completed'
    && event.data.sourceUserSeq === sourceUserSeq).length, 1);
  assert.equal(events.some((event) => event.type === 'turn_graph_compiled'
    && event.data.sourceUserSeq === sourceUserSeq), false, 'foreground reads promoted into a graph');
  assert.equal(events.some((event) => event.type === 'plan_task_activated'
    && event.data.sourceUserSeq === sourceUserSeq), false, 'foreground reads invoked plan_task');

  const db = eventlog.openEventLog();
  const logical = db.prepare(`
    SELECT logical_tool_call_id, state, outcome_kind
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
       AND logical_tool_call_id IN (?, ?)
     ORDER BY rowid
  `).all(sessionId, sourceUserSeq, pageOneCallId, pageTwoCallId);
  assert.deepEqual(logical, [
    { logical_tool_call_id: pageOneCallId, state: 'settled', outcome_kind: 'succeeded' },
    { logical_tool_call_id: pageTwoCallId, state: 'settled', outcome_kind: 'succeeded' },
  ]);
  const physical = db.prepare(`
    SELECT logical_tool_call_id, ordinal, relation, tool_name, state,
           argument_digest, physical_dispatch_id
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
       AND logical_tool_call_id IN (?, ?)
     ORDER BY logical_tool_call_id, ordinal
  `).all(sessionId, sourceUserSeq, pageOneCallId, pageTwoCallId) as Array<Record<string, unknown>>;
  assert.equal(physical.length, 4, 'two pages must each own one live probe and one business crossing');
  for (const logicalToolCallId of [pageOneCallId, pageTwoCallId]) {
    const page = physical.filter((row) => row.logical_tool_call_id === logicalToolCallId);
    assert.deepEqual(page.map(({ ordinal, relation, tool_name, state }) => ({
      ordinal, relation, tool_name, state,
    })), [
      { ordinal: 1, relation: 'probe', tool_name: operationId, state: 'returned' },
      { ordinal: 2, relation: 'child', tool_name: operationId, state: 'returned' },
    ]);
    assert.match(String(page[0]!.argument_digest), /^[a-f0-9]{64}$/);
    assert.equal(page[1]!.argument_digest, page[0]!.argument_digest);
    assert.notEqual(page[0]!.physical_dispatch_id, page[1]!.physical_dispatch_id);
  }
  const handles = db.prepare(`
    SELECT h.logical_tool_call_id, h.handle_id, h.physical_dispatch_id,
           h.tool_name, h.argument_digest, h.base_argument_digest,
           h.raw_payload_json, h.raw_payload_sha256, h.raw_byte_count, h.success,
           h.record_path, h.completeness, h.record_count, h.scope_kind,
           h.continuation_ref, h.cursor_sha256, h.cursor_repeated,
           s.result_handle_id, s.execution_kind, s.business_call, s.mutating,
           s.outcome_kind, s.outcome_evidence, s.physical_crossing_count,
           s.observer_lane
      FROM durable_result_handles h
      JOIN logical_call_settlements s ON s.result_handle_id = h.handle_id
     WHERE h.session_id = ? AND h.source_user_seq = ?
       AND h.logical_tool_call_id IN (?, ?)
     ORDER BY h.rowid
  `).all(sessionId, sourceUserSeq, pageOneCallId, pageTwoCallId);
  assert.equal(handles.length, 2);
  for (const [index, expected] of [
    {
      logicalToolCallId: pageOneCallId,
      completeness: 'partial',
      hasCursor: true,
      payload: {
        records: [{ [recordField]: recordOne }],
        next_cursor: cursor,
        has_more: true,
        received: { [queryField]: objective },
      },
    },
    {
      logicalToolCallId: pageTwoCallId,
      completeness: 'complete',
      hasCursor: false,
      payload: {
        records: [{ [recordField]: recordTwo }],
        next_cursor: null,
        has_more: false,
        received: { [queryField]: objective, [cursorField]: cursor },
      },
    },
  ].entries()) {
    const handle = handles[index]!;
    const businessCrossing = physical.find((row) => (
      row.logical_tool_call_id === expected.logicalToolCallId && row.relation === 'child'
    ));
    const expectedRawPayloadJson = JSON.stringify({
      result: {
        content: [{ type: 'text', text: JSON.stringify(expected.payload) }],
        structuredContent: expected.payload,
        isError: false,
      },
      complete: true,
    });
    assert.ok(businessCrossing);
    assert.equal(handle.logical_tool_call_id, expected.logicalToolCallId);
    assert.equal(handle.physical_dispatch_id, businessCrossing.physical_dispatch_id);
    assert.equal(handle.tool_name, operationId);
    assert.equal(handle.argument_digest, businessCrossing.argument_digest);
    assert.match(String(handle.base_argument_digest), /^[a-f0-9]{64}$/);
    assert.equal(handle.raw_payload_sha256, sha256(expectedRawPayloadJson));
    assert.equal(handle.raw_byte_count, Buffer.byteLength(expectedRawPayloadJson, 'utf8'));
    assert.equal(handle.success, 1);
    assert.equal(handle.record_path, 'result.structuredContent.records');
    assert.equal(handle.raw_payload_json, expectedRawPayloadJson,
      'durable handle changed the canonical provider-envelope bytes');
    assert.equal(handle.completeness, expected.completeness, JSON.stringify(handles));
    assert.equal(handle.record_count, 1);
    assert.equal(handle.scope_kind, 'authoritative');
    assert.equal(typeof handle.continuation_ref === 'string', expected.hasCursor);
    assert.equal(typeof handle.cursor_sha256 === 'string', expected.hasCursor);
    assert.equal(handle.cursor_repeated, 0);
    assert.equal(handle.result_handle_id, handle.handle_id);
    assert.equal(handle.execution_kind, 'provider_execution');
    assert.equal(handle.business_call, 1);
    assert.equal(handle.mutating, 0);
    assert.equal(handle.outcome_kind, 'succeeded');
    assert.equal(handle.outcome_evidence, 'structured');
    assert.equal(handle.physical_crossing_count, 2);
    assert.equal(handle.observer_lane, 'native_mcp');
  }
  const roots = db.prepare(`
    SELECT authority_kind, graph_event_id, graph_hash
      FROM accepted_turn_call_authorities
     WHERE session_id = ? AND source_user_seq = ?
  `).all(sessionId, sourceUserSeq);
  assert.deepEqual(roots, [{ authority_kind: 'host_v1', graph_event_id: null, graph_hash: null }]);
  const durableBindings = db.prepare(`
    SELECT logical_tool_call_id, root_authority_kind, root_graph_event_id,
           root_graph_hash, effect, binding_kind, capability_id,
           provider_input_schema_digest, schema_fingerprint, account_id,
           invoke_port_id, operation_id, manifest_id, manifest_digest,
           attested_argument_digest, bound_effective_argument_digest,
           durable_binding_digest
      FROM host_call_capability_bindings
     WHERE session_id = ? AND source_user_seq = ?
       AND logical_tool_call_id IN (?, ?)
  `).all(sessionId, sourceUserSeq, pageOneCallId, pageTwoCallId) as Array<Record<string, unknown>>;
  assert.equal(durableBindings.length, 2, 'each page lacked one exact source-bound call authority');
  const currentReads = capabilityCatalogs.peekHostCapabilityCatalogFactory()
    ?.snapshot().filter((entry) => entry.toolName === operationId) ?? [];
  assert.equal(currentReads.length, 1);
  const currentRead = currentReads[0];
  assert.ok(currentRead?.manifest);
  for (const logicalToolCallId of [pageOneCallId, pageTwoCallId]) {
    const binding = durableBindings.find((row) => row.logical_tool_call_id === logicalToolCallId);
    assert.ok(binding);
    assert.equal(binding.root_authority_kind, 'host_v1');
    assert.equal(binding.root_graph_event_id, null);
    assert.equal(binding.root_graph_hash, null);
    assert.equal(binding.effect, 'read');
    assert.equal(binding.binding_kind, 'catalog_manifest');
    assert.equal(binding.capability_id, currentRead.capabilityId);
    assert.equal(binding.provider_input_schema_digest, currentRead.providerInputSchemaDigest);
    assert.equal(binding.schema_fingerprint, currentRead.manifest.definitionFingerprint);
    assert.equal(binding.account_id, currentRead.manifest.accountId);
    assert.equal(binding.invoke_port_id, currentRead.manifest.invokePortId);
    assert.equal(binding.operation_id, operationId);
    assert.equal(binding.manifest_id, currentRead.manifest.manifestId);
    assert.equal(binding.manifest_digest, currentRead.manifestDigest);
    assert.match(String(binding.attested_argument_digest), /^[a-f0-9]{64}$/);
    if (binding.bound_effective_argument_digest !== null) {
      assert.match(String(binding.bound_effective_argument_digest), /^[a-f0-9]{64}$/);
    }
    assert.match(String(binding.durable_binding_digest), /^[a-f0-9]{64}$/);
  }
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as { n: number }).n, 0);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM graph_node_bindings
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as { n: number }).n, 0);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM pending_approvals
     WHERE session_id = ?
  `).get(sessionId) as { n: number }).n, 0);
  assert.equal(events.filter((event) => (
    event.type === 'evidence_receipt' && event.data.sourceUserSeq === sourceUserSeq
  )).length, 0, 'graphless read emitted an approval/write evidence receipt');
  assert.equal(modelInputs.length, 4);

  const finalWitness = requestObservation.canonicalPromptCacheRequest(modelInputs.at(-1) as never);
  const mutatedAfterHostProjection = structuredClone(modelInputs.at(-1)) as {
    input: unknown[];
  };
  mutatedAfterHostProjection.input.push({ role: 'system', content: 'ambient unlogged mutation' });
  assert.throws(
    () => requestProvenance.recordModelRequestProvenance({
      sessionId,
      sourceUserSeq,
      request: mutatedAfterHostProjection as never,
      hostProjection: finalWitness,
    }),
    (error: unknown) => error instanceof requestProvenance.ModelRequestProvenanceError
      && error.code === 'ambient_request_mutation',
    'a post-projection ambient mutation reached durable request admission',
  );
  const normalizedTask = JSON.parse(finalWitness.layers.task) as unknown;
  const memoryTexts = [
    ...(finalWitness.layers.memoryContext.startsWith('[MEMORY PRIMER]')
      ? [finalWitness.layers.memoryContext]
      : []),
    ...stringsStartingWith(normalizedTask, '[MEMORY PRIMER]'),
  ];
  assert.equal(memoryTexts.length, 1,
    'governing request did not exercise one exact verified memory primer');
  const memoryLayer = memoryTexts[0]!;
  const markerEnd = memoryLayer.indexOf('[MEMORY PRIMER]') + '[MEMORY PRIMER]'.length;
  const nextLetter = memoryLayer.slice(markerEnd).search(/[A-Za-z]/);
  assert.ok(nextLetter >= 0);
  const memoryCharacterAt = markerEnd + nextLetter;
  const tamperedMemoryLayer = `${memoryLayer.slice(0, memoryCharacterAt)}${memoryLayer[memoryCharacterAt] === 'x' ? 'y' : 'x'}${memoryLayer.slice(memoryCharacterAt + 1)}`;
  const tamperedMemory = structuredClone(modelInputs.at(-1));
  assert.equal(replaceFirstExactString(tamperedMemory, memoryLayer, tamperedMemoryLayer), true);
  let tamperedMemoryError: unknown;
  try {
    requestProvenance.recordModelRequestProvenance({
      sessionId,
      sourceUserSeq,
      request: tamperedMemory as never,
      hostProjection: requestObservation.canonicalPromptCacheRequest(tamperedMemory as never),
    });
  } catch (error) {
    tamperedMemoryError = error;
  }
  assert.ok(tamperedMemoryError instanceof requestProvenance.ModelRequestProvenanceError,
    'memory bytes differing from the durable exact render digest were admitted');
  assert.equal(tamperedMemoryError.code, 'memory_projection_digest_mismatch');
  const unsettledResult = structuredClone(modelInputs.at(-1)) as { input: unknown[] };
  unsettledResult.input.push({
    type: 'function_call_result',
    callId: generated(seed, 'ambient_unsettled_call'),
    name: 'ambient_unlogged_tool',
    status: 'completed',
    output: { type: 'text', text: 'ambient unlogged result' },
  });
  assert.throws(
    () => requestProvenance.recordModelRequestProvenance({
      sessionId,
      sourceUserSeq,
      request: unsettledResult as never,
      hostProjection: requestObservation.canonicalPromptCacheRequest(unsettledResult as never),
    }),
    (error: unknown) => error instanceof requestProvenance.ModelRequestProvenanceError
      && error.code === 'ambient_unsettled_tool_result',
    'a tool result without a durable settlement reached request admission',
  );

  const requestRows = db.prepare(`
    SELECT record_id, request_ordinal, normalized_request_digest,
           host_projection_digest, provenance_json,
           payload_reference_json
      FROM model_request_provenance
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY request_ordinal
  `).all(sessionId, sourceUserSeq) as Array<Record<string, unknown>>;
  assert.equal(requestRows.length, modelInputs.length,
    'every final provider dispatch boundary must own one durable request snapshot');
  const witnessed = modelInputs.map((request) => (
    requestObservation.canonicalPromptCacheRequest(request as never)
  ));
  assert.deepEqual(
    requestRows.map((row) => row.normalized_request_digest),
    witnessed.map((request) => request.observation.normalizedRequestDigest),
    'durable normalized digests must be byte-derived from the actual provider requests',
  );
  for (const [index, row] of requestRows.entries()) {
    assert.equal(row.request_ordinal, index + 1);
    assert.equal(row.host_projection_digest, row.normalized_request_digest);
    assert.equal(String(row.provenance_json).includes(prompt), false,
      'accepted input leaked out of the encrypted request payload');
    assert.equal(String(row.provenance_json).includes(recordOne), false,
      'settled provider content leaked out of the encrypted request payload');
    assert.equal(String(row.payload_reference_json).includes(prompt), false);
  }

  const noMemorySessionId = generated(seed, 'no_memory_session');
  const noMemoryPrompt = `Explain the local status of ${generated(seed, 'no_memory_subject')}.`;
  eventlog.createSession({ id: noMemorySessionId, kind: 'chat' });
  const noMemorySource = eventlog.appendEvent({
    sessionId: noMemorySessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: noMemoryPrompt },
  });
  const noMemoryPreamble = eventlog.appendConversationPreambleOnce({
    source: noMemorySource,
    text: 'I’ll answer from the exact accepted local context.',
    intentKey: 'no-memory-restart-control',
  });
  const noMemoryPreambleDelivery = eventlog.conversationPreambleDeliveryRequest(
    noMemoryPreamble.event,
  );
  const noMemoryAuthority = callAuthority.armHostCallAuthority({
    sessionId: noMemorySessionId,
    sourceUserSeq: noMemorySource.seq,
    catalogRevisionDigest: sha256('no-memory-catalog'),
    bindingRevisionDigest: sha256('no-memory-bindings'),
    maxLogicalCalls: 1,
    maxParallelCalls: 1,
  });
  assert.equal(noMemoryAuthority.status, 'armed', JSON.stringify(noMemoryAuthority));
  // An omitted optional system prompt is an exact request, but has no stable
  // policy prefix to cache. Provenance must reconstruct it without promoting
  // it to cache-eligible or accepting any neighboring malformed shape.
  const noMemoryRequest = {
    input: [
      { role: 'user', content: noMemoryPrompt },
      { role: 'system', content: noMemoryPreambleDelivery.text },
    ],
    modelSettings: {},
    tools: [],
    toolsExplicitlyProvided: true,
    outputType: 'text',
    handoffs: [],
    tracing: false,
  };
  const noInstructionsWitness = requestObservation.canonicalPromptCacheRequest(
    noMemoryRequest as never,
  );
  assert.equal(noInstructionsWitness.observation.boundary, 'whole_instructions');
  assert.equal(noInstructionsWitness.layers.stablePolicy, '');
  assert.equal(noInstructionsWitness.observation.cacheEligible, false);
  assert.equal(noInstructionsWitness.observation.policyRevision, null);
  assert.deepEqual(noInstructionsWitness.observation.issues, ['empty_stable_policy']);

  const forgedEligibleWitness = structuredClone(noInstructionsWitness);
  forgedEligibleWitness.observation.cacheEligible = true;
  forgedEligibleWitness.observation.policyRevision = sha256('');
  forgedEligibleWitness.observation.issues = [];
  assert.throws(
    () => requestProvenance.recordModelRequestProvenance({
      sessionId: noMemorySessionId,
      sourceUserSeq: noMemorySource.seq,
      request: noMemoryRequest as never,
      hostProjection: forgedEligibleWitness,
    }),
    (error: unknown) => error instanceof requestProvenance.ModelRequestProvenanceError
      && error.code === 'request_not_canonical',
    'forged cache eligibility promoted an empty policy request',
  );
  const forgedLayerDigestWitness = structuredClone(noInstructionsWitness);
  forgedLayerDigestWitness.observation.layers.task.sha256 = '0'.repeat(64);
  assert.throws(
    () => requestProvenance.recordModelRequestProvenance({
      sessionId: noMemorySessionId,
      sourceUserSeq: noMemorySource.seq,
      request: noMemoryRequest as never,
      hostProjection: forgedLayerDigestWitness,
    }),
    (error: unknown) => error instanceof requestProvenance.ModelRequestProvenanceError
      && error.code === 'request_not_canonical',
    'a forged host layer digest entered the empty-policy exception',
  );

  const malformedInstructions = [
    `policy ${modelWire.CACHE_BREAK_SENTINEL} dynamic`,
    `policy${modelWire.INSTRUCTION_CACHE_DELIM}one${modelWire.INSTRUCTION_CACHE_DELIM}two`,
    `policy ${modelWire.CACHE_MEMORY_CONTEXT_SENTINEL} unbounded memory`,
  ];
  for (const systemInstructions of malformedInstructions) {
    const request = { ...noMemoryRequest, systemInstructions };
    const witness = requestObservation.canonicalPromptCacheRequest(request as never);
    assert.notDeepEqual(witness.observation.issues, ['empty_stable_policy']);
    assert.throws(
      () => requestProvenance.recordModelRequestProvenance({
        sessionId: noMemorySessionId,
        sourceUserSeq: noMemorySource.seq,
        request: request as never,
        hostProjection: witness,
      }),
      (error: unknown) => error instanceof requestProvenance.ModelRequestProvenanceError
        && error.code === 'request_not_canonical',
      `malformed instruction boundary was admitted: ${JSON.stringify(witness.observation.issues)}`,
    );
  }
  const nonCanonicalRequest = {
    ...noMemoryRequest,
    systemInstructions: 'Policy remains present.',
    modelSettings: { nonJson: () => undefined },
  };
  const nonCanonicalWitness = requestObservation.canonicalPromptCacheRequest(
    nonCanonicalRequest as never,
  );
  assert.ok(nonCanonicalWitness.observation.issues.some((issue) => (
    issue.startsWith('request_not_canonical_json:')
  )));
  assert.throws(
    () => requestProvenance.recordModelRequestProvenance({
      sessionId: noMemorySessionId,
      sourceUserSeq: noMemorySource.seq,
      request: nonCanonicalRequest as never,
      hostProjection: nonCanonicalWitness,
    }),
    (error: unknown) => error instanceof requestProvenance.ModelRequestProvenanceError
      && error.code === 'request_not_canonical',
  );

  const noMemoryRecorded = requestProvenance.recordModelRequestProvenance({
    sessionId: noMemorySessionId,
    sourceUserSeq: noMemorySource.seq,
    request: noMemoryRequest as never,
    hostProjection: noInstructionsWitness,
  });
  const persistedNoInstructionsManifest = JSON.parse(String((db.prepare(`
    SELECT provenance_json FROM model_request_provenance WHERE record_id = ?
  `).get(noMemoryRecorded.recordId) as { provenance_json: string }).provenance_json)) as {
    cacheEligibility?: unknown;
  };
  assert.deepEqual(persistedNoInstructionsManifest.cacheEligibility, {
    cacheEligible: false,
    policyRevision: null,
    issues: ['empty_stable_policy'],
  });

  // This is an actual restart boundary: both handles are closed before the
  // projector independently reopens and authenticates durable truth.
  eventlog.closeEventLog();
  memoryDb.closeMemoryDb();
  const restartRecordIds = [
    ...requestRows.map((row) => String(row.record_id)),
    noMemoryRecorded.recordId,
  ];
  const restartFixture = fileURLToPath(new URL(
    './model-request-provenance-restart.fixture.ts',
    import.meta.url,
  ));
  const restarted = spawnSync(
    process.execPath,
    ['--import', 'tsx', restartFixture],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEMENTINE_HOME: HOME,
        CLEMMY_TEST_ISOLATED_HOME: '1',
        CLEM_MODEL_REQUEST_RESTART_RECORD_IDS: JSON.stringify(restartRecordIds),
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(restarted.error, undefined);
  assert.equal(restarted.status, 0, restarted.stderr);
  const restartLine = restarted.stdout.split('\n')
    .find((line) => line.startsWith('MODEL_REQUEST_RESTART_PROJECTION='));
  assert.ok(restartLine, restarted.stdout);
  const restartEnvelope = JSON.parse(
    restartLine.slice('MODEL_REQUEST_RESTART_PROJECTION='.length),
  ) as RestartProjectionEnvelope;
  assert.notEqual(restartEnvelope.pid, process.pid,
    'restart projection reused the test process instead of starting a new OS process');
  assert.equal(restartEnvelope.parentPid, process.pid);
  assert.deepEqual(
    restartEnvelope.projections.map((projection) => projection.recordId),
    restartRecordIds,
  );
  for (const [index, row] of requestRows.entries()) {
    const projection = restartEnvelope.projections[index]!;
    assert.equal(projection.status, 'ok', JSON.stringify(projection));
    assert.equal(projection.requestOrdinal, index + 1);
    assert.equal(projection.normalizedRequestDigest, row.normalized_request_digest);
    assert.equal(projection.hostProjectionDigest, row.host_projection_digest);
    assert.deepEqual(projection.layerDigests, witnessed[index]!.observation.layers,
      'fresh-process projection changed the exact normalized layer identities');
    assert.equal(projection.sourceEventId,
      events.find((event) => event.seq === sourceUserSeq)?.id);
    assert.ok((projection.toolSchemaCount ?? 0) > 0);
  }
  const restartedNoMemory = restartEnvelope.projections.at(-1)!;
  assert.equal(restartedNoMemory.status, 'ok', JSON.stringify(restartedNoMemory));
  assert.deepEqual(restartedNoMemory.cacheEligibility, {
    cacheEligible: false,
    policyRevision: null,
    issues: ['empty_stable_policy'],
  });
  assert.deepEqual(restartedNoMemory.verifiedMemory, []);
  assert.deepEqual(restartedNoMemory.preambles, [{
    eventId: noMemoryPreambleDelivery.eventId,
    eventDigest: noMemoryPreambleDelivery.eventDigest,
    deliveryKey: noMemoryPreambleDelivery.deliveryKey,
  }]);
  const restartedFinal = restartEnvelope.projections[requestRows.length - 1]!;
  assert.equal(restartedFinal.verifiedMemory?.length, 1);
  for (const callId of [pageOneCallId, pageTwoCallId]) {
    const settled = restartedFinal.settlements
      ?.find((ref) => ref.logicalToolCallId === callId);
    assert.ok(settled, `fresh-process projection missed settlement ${callId}`);
    assert.match(settled.resultHandleId ?? '', /^rh_/);
    assert.match(settled.resultHandleDigest ?? '', /^[a-f0-9]{64}$/);
  }
  for (const [index, row] of requestRows.entries()) {
    const projected = requestProvenance.projectModelRequestProvenance(String(row.record_id));
    assert.equal(projected.status, 'ok', JSON.stringify(projected));
    if (projected.status !== 'ok') continue;
    assert.deepEqual(projected.layers, witnessed[index]!.layers,
      'restart projection changed normalized provider-visible bytes');
    assert.equal(projected.record.normalizedRequestDigest,
      witnessed[index]!.observation.normalizedRequestDigest);
    assert.equal(projected.manifest.source.eventId,
      events.find((event) => event.seq === sourceUserSeq)?.id);
    assert.ok(projected.manifest.toolSchemas.schemaDigests.length > 0);
  }
  const noMemoryProjection = requestProvenance.projectModelRequestProvenance(
    noMemoryRecorded.recordId,
  );
  assert.equal(noMemoryProjection.status, 'ok', JSON.stringify(noMemoryProjection));
  if (noMemoryProjection.status === 'ok') {
    assert.deepEqual(noMemoryProjection.cacheEligibility, {
      cacheEligible: false,
      policyRevision: null,
      issues: ['empty_stable_policy'],
    });
    assert.deepEqual(noMemoryProjection.manifest.verifiedMemory, []);
    assert.deepEqual(noMemoryProjection.manifest.preambles.map((ref) => ({
      eventId: ref.eventId,
      eventDigest: ref.eventDigest,
      deliveryKey: ref.deliveryKey,
    })), [{
      eventId: noMemoryPreambleDelivery.eventId,
      eventDigest: noMemoryPreambleDelivery.eventDigest,
      deliveryKey: noMemoryPreambleDelivery.deliveryKey,
    }]);
    assert.deepEqual(noMemoryProjection.layers,
      requestObservation.canonicalPromptCacheRequest(noMemoryRequest as never).layers);
  }

  const noInstructionsPayloadPath = authorityPayloads.authorityEncryptedPayloadFilePath(
    noMemoryRecorded.payloadReference.payloadId,
  );
  const sealedNoInstructionsPayload = readFileSync(noInstructionsPayloadPath);
  const tamperedNoInstructionsPayload = Buffer.from(sealedNoInstructionsPayload);
  tamperedNoInstructionsPayload[tamperedNoInstructionsPayload.byteLength - 4] ^= 1;
  writeFileSync(noInstructionsPayloadPath, tamperedNoInstructionsPayload, { mode: 0o600 });
  assert.deepEqual(
    requestProvenance.projectModelRequestProvenance(noMemoryRecorded.recordId),
    { status: 'invalid', reason: 'payload_corrupt' },
    'encrypted empty-policy bytes were projected after tamper',
  );
  writeFileSync(noInstructionsPayloadPath, sealedNoInstructionsPayload, { mode: 0o600 });
  assert.equal(
    requestProvenance.projectModelRequestProvenance(noMemoryRecorded.recordId).status,
    'ok',
    'restoring exact sealed bytes did not restore the cache-ineligible projection',
  );
  const finalProjection = requestProvenance.projectModelRequestProvenance(
    String(requestRows.at(-1)!.record_id),
  );
  assert.equal(finalProjection.status, 'ok', JSON.stringify(finalProjection));
  if (finalProjection.status === 'ok') {
    assert.equal(finalProjection.manifest.verifiedMemory.length, 1);
    assert.match(finalProjection.manifest.verifiedMemory[0]!.recallId, /^mr-/);
    assert.match(finalProjection.manifest.verifiedMemory[0]!.recallDigest, /^[a-f0-9]{64}$/);
    assert.ok(finalProjection.manifest.disclosedRefs.some((ref) => (
      ref.type === 'capability_discovered' && ref.capabilityRefs.includes(currentRead.capabilityId)
    )));
    for (const callId of [pageOneCallId, pageTwoCallId]) {
      const settled = finalProjection.manifest.settledResults
        .find((ref) => ref.logicalToolCallId === callId);
      assert.ok(settled, `missing settled result provenance for ${callId}`);
      assert.match(settled.resultHandleId ?? '', /^rh_/);
      assert.match(settled.resultHandleDigest ?? '', /^[a-f0-9]{64}$/);
    }
  }

  // The modern foreground intentionally has no turn graph. Its real durable
  // business settlements still keep tools available for terse follow-ups,
  // including after event-log reopen; no keyword list supplies the lineage.
  const { freshHostConversationSurfaceOnly } = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
  const { sessionHasPriorRetrieveOrAct } = await import('../runtime/graph/turn-graph-shadow.js');
  assert.equal(sessionHasPriorRetrieveOrAct(sessionId, sourceUserSeq), false,
    'the current source cannot be its own prior work');
  eventlog.closeEventLog();
  const followup = eventlog.appendEvent({ sessionId, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'What about yesterday?' } });
  assert.equal(freshHostConversationSurfaceOnly({ sessionId, sourceUserSeq: followup.seq }), false,
    'a graphless read follow-up lost its tool surface after reopen');
  const unrelated = eventlog.createSession({ id: `${sessionId}-unrelated`, kind: 'chat' });
  const greeting = eventlog.appendEvent({ sessionId: unrelated.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'hey' } });
  assert.equal(freshHostConversationSurfaceOnly({ sessionId: unrelated.id, sourceUserSeq: greeting.seq }), true,
    "another session's business work disabled the greeting shortcut");

});

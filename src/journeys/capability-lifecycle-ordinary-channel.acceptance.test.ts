/**
 * Governing NEXT-TAG provider-neutral matrix — capability lifecycle cohort.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs --test-concurrency=1 \
 *     src/journeys/capability-lifecycle-ordinary-channel.acceptance.test.ts
 *
 * Matrix row 6 enters every case through the exported Discord bridge and the
 * real host_v1 turn owner. A generated stdio MCP definition is discovered
 * cold, reused warm, changed in place, renamed, and finally removed. Current
 * live identity may converge to one exact successor; unavailable identity must
 * stop with actionable typed truth before business I/O. Provider names and
 * operation vocabulary are generated data, never kernel control flow.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-capability-lifecycle-ordinary-'));
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
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
process.env.CLEMMY_AUTH_FALLOVER = 'off';
process.env.CLEMMY_PROACTIVE_REPORT_DEFER = 'off';
process.env.CLEMMY_PLAN_FIRST = 'off';
process.env.CLEMMY_DYNAMIC_REASONING = 'off';
process.env.CLEMMY_EVAL_AUTO_PROMOTE = 'off';
process.env.COMPOSIO_API_KEY = '';
process.env.COMPOSIO_USER_ID = '';

mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-capability-lifecycle-ordinary\n');
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
const innerDispatch = await import('../tools/inner-dispatch.js');
const mcpConfig = await import('../runtime/mcp-config.js');
const mcpServers = await import('../runtime/mcp-servers.js');
const productionPorts = await import('../runtime/harness/production-capability-ports.js');
const semanticPorts = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const memoryDb = await import('../memory/db.js');

const originalFetch = globalThis.fetch;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function generated(seed: number, label: string): string {
  return `${label}_${sha256(`${seed}\0${label}`).slice(0, 14)}`.toLowerCase();
}

interface ProviderState {
  enabled: boolean;
  toolName: string;
  fieldName: string;
  objective: string;
  record: string;
}

// The peer reads host-owned fixture state on every tools/list and tools/call.
// This is one real long-lived stdio carrier whose provider definition changes
// between accepted turns; no in-process catalog or invocation seam is planted.
const GENERATED_MUTABLE_MCP_PEER = String.raw`
const fs = await import('node:fs');
let pending = '';
const state = () => JSON.parse(fs.readFileSync(process.env.PN_STATE_FILE, 'utf8'));
const note = (value) => fs.appendFileSync(process.env.PN_LOG_FILE, value + '\n', 'utf8');
const send = (id, result, error) => {
  const message = error
    ? { jsonrpc: '2.0', id, error }
    : { jsonrpc: '2.0', id, result };
  process.stdout.write(JSON.stringify(message) + '\n');
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
    const current = state();
    note('list:' + (current.enabled ? current.toolName : 'absent'));
    const tools = current.enabled ? [{
      name: current.toolName,
      description: 'Retrieve the complete ' + current.objective + ' from the current connected source.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: [current.fieldName],
        properties: { [current.fieldName]: { type: 'string' } },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    }] : [];
    send(request.id, { tools });
    return;
  }
  if (request.method === 'tools/call') {
    const current = state();
    note('call:' + String(request.params?.name ?? ''));
    if (!current.enabled || request.params?.name !== current.toolName) {
      send(request.id, undefined, { code: -32602, message: 'current operation is unavailable' });
      return;
    }
    const args = request.params?.arguments ?? {};
    if (typeof args[current.fieldName] !== 'string') {
      send(request.id, undefined, { code: -32602, message: 'current argument shape is required' });
      return;
    }
    const payload = {
      records: [{ value: current.record }],
      exhausted: true,
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
    catch (error) { process.stderr.write(String(error?.stack ?? error) + '\n'); }
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
      id: response.responseId ?? 'capability-lifecycle-response',
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

function resultBody(request: unknown, callId: string): Record<string, unknown> | null {
  const raw = resultText(request, callId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function modelToolNames(request: unknown): string[] {
  return ((request as { tools?: Array<{ name?: string }> }).tools ?? [])
    .map((tool) => tool.name ?? '')
    .filter(Boolean);
}

function workCall(callId: string, operationId: string, fieldName: string, objective: string) {
  return functionCall(callId, 'work_call', {
    requirement_id: generated(Number.parseInt(sha256(callId).slice(0, 8), 16), 'requirement'),
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: operationId,
    args_json: JSON.stringify({ [fieldName]: objective }),
  });
}

function terminal(text: string, nextAction: 'completed' | 'abandoned', reason: string | null = null) {
  return textMessage(JSON.stringify({
    summary: text,
    reply: text,
    done: true,
    nextAction,
    reason,
  }));
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

type ScriptedModel = {
  getResponse(request: unknown): Promise<Record<string, unknown>>;
  getStreamedResponse: typeof streamResponse;
};

let activeModel: ScriptedModel | null = null;

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

test('matrix row 6: ordinary cold/warm/stale/renamed/removed capability lifecycle converges or stops actionably', {
  timeout: 180_000,
}, async (t) => {
  const seed = 6_061;
  const objective = generated(seed, 'complete_archive_snapshot');
  const serverName = generated(seed, 'unfamiliar_carrier');
  const firstTool = generated(seed, 'current_operation');
  const renamedTool = generated(seed, 'successor_operation');
  const firstField = generated(seed, 'selector_field');
  const changedField = generated(seed, 'revised_selector_field');
  const firstOperation = `${serverName}__${firstTool}`;
  const renamedOperation = `${serverName}__${renamedTool}`;
  const prompt = `Retrieve the complete ${objective} from my connected account and report every record.`;
  const searchQuery = `retrieve complete ${objective}`;
  const selectorFor = (label: string): string => `${objective}:${generated(seed, `selector_${label}`)}`;
  const providerStatePath = path.join(HOME, 'state', 'capability-lifecycle-provider.json');
  const providerLogPath = path.join(HOME, 'state', 'capability-lifecycle-provider.log');
  const setProviderState = (state: ProviderState): void => {
    writeFileSync(providerStatePath, JSON.stringify(state), 'utf8');
  };
  const providerLog = (): string[] => {
    try {
      return readFileSync(providerLogPath, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };

  eventlog.resetEventLog();
  resetHarnessRuntimeConfig();
  capabilityIndex._resetCapabilityIndexForTest();
  const store = capabilityStores.createCapabilityManifestStore([], { durable: true });
  const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
  capabilityStores.installCapabilityManifestStore(store);
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
  productionPorts.clearProductionCapabilityPorts();
  innerDispatch._setInnerDispatchToolsForTests(null);
  innerDispatch._setInnerDispatchMcpResolverForTests(null);
  setProviderState({
    enabled: true,
    toolName: firstTool,
    fieldName: firstField,
    objective,
    record: generated(seed, 'cold_record'),
  });
  writeFileSync(providerLogPath, '', 'utf8');
  const mcpDir = path.join(HOME, 'mcp');
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(path.join(mcpDir, 'servers.json'), JSON.stringify({
    [serverName]: {
      type: 'stdio',
      command: process.execPath,
      args: ['--input-type=module', '-e', GENERATED_MUTABLE_MCP_PEER],
      env: {
        PN_SERVER_NAME: serverName,
        PN_STATE_FILE: providerStatePath,
        PN_LOG_FILE: providerLogPath,
      },
      description: `Generated mutable source for ${objective}`,
      enabled: true,
    },
  }), 'utf8');
  mcpConfig.invalidateMcpServerDiscoveryCache();
  await mcpServers.invalidateConfiguredMcpServers();
  const configured = await configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);
  assert.deepEqual(factory.snapshot(), [], 'cohort must begin with no executable capability');
  assert.equal(store.list().length, 0, 'cohort must begin with no trusted manifest');

  globalThis.fetch = (async (request: RequestInfo | URL) => {
    throw new Error(`journey forbids external network: ${String(request)}`);
  }) as typeof fetch;
  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('hidden semantic preflight is forbidden'); },
    async judgeSourceEffect() { throw new Error('hidden effect judge is forbidden'); },
    async judgePlanGrounding() { throw new Error('hidden plan judge is forbidden'); },
  });
  bridge._setBridgeImplsForTests({
    buildAgent: async (options) => {
      assert.ok(activeModel, 'scenario installed no model wire');
      return buildOrchestratorAgent({ ...options, model: activeModel as never });
    },
  });

  interface RunResult {
    sessionId: string;
    sourceUserSeq: number;
    delivery: ReturnType<typeof recordingTransport>;
    modelSteps: number;
  }
  const runScenario = async (input: {
    label: string;
    model: (request: unknown, step: number) => unknown[];
  }): Promise<RunResult> => {
    const sessionId = generated(seed, `session_${input.label}`);
    eventlog.createSession({
      id: sessionId,
      kind: 'chat',
      userId: generated(seed, 'user'),
    });
    let sourceUserSeq = 0;
    let modelSteps = 0;
    activeModel = {
      async getResponse(request: unknown) {
        modelSteps += 1;
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: input.model(structuredClone(request), modelSteps),
          responseId: `capability-lifecycle-${input.label}-${modelSteps}`,
        };
      },
      getStreamedResponse: streamResponse,
    };
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
        runId: generated(seed, `run_${input.label}`),
        onSourceAccepted(source: { seq: number }) { sourceUserSeq = source.seq; },
      },
    });
    assert.ok(sourceUserSeq > 0, `${input.label} source was not accepted`);
    assert.deepEqual(delivery.errors, [], `${input.label} bridge error`);
    assert.deepEqual(delivery.followups, [], `${input.label} emitted an unrelated follow-up`);
    const roots = eventlog.openEventLog().prepare(`
      SELECT authority_kind, graph_event_id, graph_hash
        FROM accepted_turn_call_authorities
       WHERE session_id = ? AND source_user_seq = ?
    `).all(sessionId, sourceUserSeq);
    assert.deepEqual(roots, [{ authority_kind: 'host_v1', graph_event_id: null, graph_hash: null }],
      `${input.label} escaped host_v1 graphless authority`);
    return { sessionId, sourceUserSeq, delivery, modelSteps };
  };

  let coldSearchText = '';
  const coldSearchCall = generated(seed, 'cold_search_call');
  const coldReadCall = generated(seed, 'cold_read_call');
  const cold = await runScenario({
    label: 'cold',
    model(request, step) {
      const tools = modelToolNames(request);
      if (step === 1) {
        assert.ok(tools.includes('tool_search'));
        assert.equal(tools.includes('work_call'), false, 'blank state advertised business authority');
        return [functionCall(coldSearchCall, 'tool_search', {
          query: searchQuery,
          role_key: 'clause-0:read',
          limit: 4,
          cursor: null,
        })];
      }
      if (step === 2) {
        assert.ok(tools.includes('work_call'));
        coldSearchText = resultText(request, coldSearchCall) ?? '';
        assert.match(coldSearchText, new RegExp(firstOperation));
        return [workCall(coldReadCall, firstOperation, firstField, selectorFor('cold'))];
      }
      assert.ok(resultText(request, coldReadCall));
      return [terminal(`Cold ${objective} retrieval completed.`, 'completed')];
    },
  });
  assert.equal(cold.modelSteps, 3);
  assert.match(cold.delivery.edits.at(-1) ?? '', new RegExp(objective));
  const coldCurrent = store.list().filter((entry) => entry.manifest.lifecycle.state === 'current');
  assert.equal(coldCurrent.length, 1);
  assert.equal(coldCurrent[0]!.manifest.operationId, firstOperation);
  const coldManifestId = coldCurrent[0]!.manifest.manifestId;
  assert.ok(factory.get(coldManifestId));
  assert.equal(providerLog().filter((line) => line === `call:${firstTool}`).length, 1);

  const logBeforeWarm = providerLog().length;
  const warmReadCall = generated(seed, 'warm_read_call');
  let warmResultText = '';
  const warm = await runScenario({
    label: 'warm',
    model(request, step) {
      const tools = modelToolNames(request);
      if (step === 1) {
        assert.ok(tools.includes('work_call'), 'verified warm identity did not reach the first model card');
        assert.match(JSON.stringify(request), new RegExp(firstOperation));
        return [workCall(warmReadCall, firstOperation, firstField, selectorFor('warm'))];
      }
      warmResultText = resultText(request, warmReadCall) ?? '';
      assert.ok(warmResultText);
      assert.doesNotMatch(warmResultText, /REFUSED|not admitted|requires_readmission|not reachable/i);
      return [terminal(`Warm ${objective} retrieval completed.`, 'completed')];
    },
  });
  assert.equal(warm.modelSteps, 2, 'warm reuse paid a discovery/model round');
  assert.equal(store.list().filter((entry) => entry.manifest.lifecycle.state === 'current').length, 1);
  assert.equal(store.list().find((entry) => entry.manifest.manifestId === coldManifestId)?.manifest.lifecycle.state, 'current');
  assert.equal(
    providerLog().slice(logBeforeWarm).filter((line) => line.startsWith('call:')).length,
    1,
    JSON.stringify({
      logBeforeWarm,
      warmResultText,
      providerLog: providerLog(),
      warmLogical: eventlog.openEventLog().prepare(`
        SELECT logical_tool_call_id, state, outcome_kind
          FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ?
      `).all(warm.sessionId, warm.sourceUserSeq),
      warmPhysical: eventlog.openEventLog().prepare(`
        SELECT logical_tool_call_id, relation, tool_name, state
          FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ?
      `).all(warm.sessionId, warm.sourceUserSeq),
    }),
  );

  // Same operation, new required field: the stale warm binding must refuse at
  // its live preparation probe, then one cold re-discovery publishes exactly
  // one definition successor before a successful business crossing.
  setProviderState({
    enabled: true,
    toolName: firstTool,
    fieldName: changedField,
    objective,
    record: generated(seed, 'changed_record'),
  });
  const staleAttempt = generated(seed, 'stale_attempt');
  const staleSearch = generated(seed, 'stale_search');
  const changedRead = generated(seed, 'changed_read');
  const stale = await runScenario({
    label: 'stale',
    model(request, step) {
      if (step === 1) {
        assert.match(JSON.stringify(request), new RegExp(firstOperation));
        return [workCall(staleAttempt, firstOperation, firstField, selectorFor('stale_predecessor'))];
      }
      if (step === 2) {
        const refused = resultText(request, staleAttempt) ?? '';
        assert.match(refused, /drift|definition|preparation|refus/i,
          'stale call did not return an actionable correction signal');
        return [functionCall(staleSearch, 'tool_search', {
          query: searchQuery,
          role_key: 'clause-0:read',
          limit: 4,
          cursor: null,
        })];
      }
      if (step === 3) {
        const body = resultBody(request, staleSearch);
        assert.ok(body);
        assert.match(JSON.stringify(body), new RegExp(firstOperation));
        return [workCall(changedRead, firstOperation, changedField, selectorFor('stale_successor'))];
      }
      assert.ok(resultText(request, changedRead));
      return [terminal(`Changed ${objective} definition converged.`, 'completed')];
    },
  });
  assert.equal(stale.modelSteps, 4);
  const changedCurrent = store.list().filter((entry) => entry.manifest.lifecycle.state === 'current');
  assert.equal(changedCurrent.length, 1);
  assert.equal(changedCurrent[0]!.manifest.operationId, firstOperation);
  assert.notEqual(changedCurrent[0]!.manifest.manifestId, coldManifestId);
  assert.deepEqual(store.get(coldManifestId)?.manifest.lifecycle, {
    state: 'superseded',
    supersededBy: changedCurrent[0]!.manifest.manifestId,
  });
  assert.equal(factory.get(coldManifestId), undefined);
  const changedManifestId = changedCurrent[0]!.manifest.manifestId;

  // A provider rename is identity change, not an alias. The old exact call is
  // refused; discovery names the only current operation, whose materializer
  // records explicit successor lineage and removes the predecessor callable.
  setProviderState({
    enabled: true,
    toolName: renamedTool,
    fieldName: changedField,
    objective,
    record: generated(seed, 'renamed_record'),
  });
  const renamedStaleAttempt = generated(seed, 'renamed_stale_attempt');
  const renamedSearch = generated(seed, 'renamed_search');
  const renamedRead = generated(seed, 'renamed_read');
  const renamed = await runScenario({
    label: 'renamed',
    model(request, step) {
      if (step === 1) {
        assert.match(JSON.stringify(request), new RegExp(firstOperation));
        return [workCall(renamedStaleAttempt, firstOperation, changedField, selectorFor('rename_predecessor'))];
      }
      if (step === 2) {
        assert.match(resultText(request, renamedStaleAttempt) ?? '', /drift|definition|preparation|refus/i);
        return [functionCall(renamedSearch, 'tool_search', {
          query: searchQuery,
          role_key: 'clause-0:read',
          limit: 4,
          cursor: null,
        })];
      }
      if (step === 3) {
        const search = resultText(request, renamedSearch) ?? '';
        assert.match(search, new RegExp(renamedOperation));
        assert.doesNotMatch(search, new RegExp(`"name":"${firstOperation}"`));
        return [workCall(renamedRead, renamedOperation, changedField, selectorFor('rename_successor'))];
      }
      assert.ok(resultText(request, renamedRead));
      return [terminal(`Renamed ${objective} capability converged exactly.`, 'completed')];
    },
  });
  assert.equal(renamed.modelSteps, 4);
  const renamedCurrent = store.list().filter((entry) => entry.manifest.lifecycle.state === 'current');
  assert.equal(renamedCurrent.length, 1);
  assert.equal(renamedCurrent[0]!.manifest.operationId, renamedOperation);
  assert.deepEqual(store.get(changedManifestId)?.manifest.lifecycle, {
    state: 'superseded',
    supersededBy: renamedCurrent[0]!.manifest.manifestId,
  });
  assert.equal(factory.get(changedManifestId), undefined);
  assert.ok(factory.get(renamedCurrent[0]!.manifest.manifestId));
  const renamedManifestId = renamedCurrent[0]!.manifest.manifestId;

  // Removed means stop. A bounded failed verification plus one fresh empty
  // discovery retires the stale authority; it must not substitute a sibling or
  // cross tools/call after the provider stopped listing the operation.
  setProviderState({
    enabled: false,
    toolName: renamedTool,
    fieldName: changedField,
    objective,
    record: generated(seed, 'removed_record'),
  });
  const removedLogStart = providerLog().length;
  const removedAttempt = generated(seed, 'removed_attempt');
  const removedSearch = generated(seed, 'removed_search');
  const removedReply = `The connected capability for ${objective} is no longer available. Reconnect or install a current matching source, then retry.`;
  const removed = await runScenario({
    label: 'removed',
    model(request, step) {
      if (step === 1) {
        assert.match(JSON.stringify(request), new RegExp(renamedOperation));
        return [workCall(removedAttempt, renamedOperation, changedField, selectorFor('removed'))];
      }
      if (step === 2) {
        assert.match(resultText(request, removedAttempt) ?? '', /drift|definition|preparation|refus/i);
        return [functionCall(removedSearch, 'tool_search', {
          query: searchQuery,
          role_key: 'clause-0:read',
          limit: 4,
          cursor: null,
        })];
      }
      const search = resultBody(request, removedSearch);
      assert.ok(search);
      const returnedNames = Array.isArray(search.results)
        ? search.results.flatMap((result) => (
            result && typeof result === 'object' && typeof (result as { name?: unknown }).name === 'string'
              ? [(result as { name: string }).name]
              : []
          ))
        : [];
      assert.equal(returnedNames.includes(firstOperation), false);
      assert.equal(returnedNames.includes(renamedOperation), false);
      assert.doesNotMatch(JSON.stringify(search.schemas ?? {}), new RegExp(renamedOperation));
      assert.ok(String(search.hint ?? '').trim(), 'empty discovery supplied no actionable stop context');
      return [terminal(removedReply, 'abandoned', 'current_capability_unavailable')];
    },
  });
  assert.equal(removed.modelSteps, 3);
  assert.equal(
    removed.delivery.edits.at(-1),
    removedReply,
    JSON.stringify({
      modelSteps: removed.modelSteps,
      initial: removed.delivery.initial,
      edits: removed.delivery.edits,
    }),
  );
  assert.equal(store.get(renamedManifestId)?.manifest.lifecycle.state, 'revoked');
  assert.deepEqual(store.list().filter((entry) => entry.manifest.lifecycle.state === 'current'), []);
  assert.deepEqual(factory.snapshot(), []);
  assert.equal(providerLog().slice(removedLogStart).some((line) => line.startsWith('call:')), false,
    'removed capability crossed provider business I/O');

  const allSessions = [cold, warm, stale, renamed, removed];
  for (const run of allSessions) {
    const terminals = eventlog.listEvents(run.sessionId).filter((event) => (
      event.type === 'conversation_completed'
      && event.data.sourceUserSeq === run.sourceUserSeq
    ));
    assert.equal(terminals.length, 1, `${run.sessionId} did not publish exactly one terminal`);
    assert.equal(eventlog.listEvents(run.sessionId).some((event) => (
      event.type === 'turn_graph_compiled' && event.data.sourceUserSeq === run.sourceUserSeq
    )), false, `${run.sessionId} promoted a graphless read lifecycle turn`);
  }

  const db = eventlog.openEventLog();
  const removedSettlements = db.prepare(`
    SELECT logical_tool_call_id, outcome_kind, governor_outcome, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY rowid
  `).all(removed.sessionId, removed.sourceUserSeq) as Array<Record<string, unknown>>;
  assert.equal(removedSettlements.some((row) => (
    row.logical_tool_call_id === removedAttempt
    && row.outcome_kind !== 'succeeded'
    && row.physical_crossing_count === 1
  )), true, JSON.stringify(removedSettlements));
  assert.equal(removedSettlements.some((row) => row.logical_tool_call_id === removedSearch), true);

  t.diagnostic(`CAPABILITY_LIFECYCLE ${JSON.stringify({
    generatedCarrier: serverName,
    coldManifestId,
    changedManifestId,
    renamedManifestId,
    modelSteps: {
      cold: cold.modelSteps,
      warm: warm.modelSteps,
      stale: stale.modelSteps,
      renamed: renamed.modelSteps,
      removed: removed.modelSteps,
    },
    providerListReads: providerLog().filter((line) => line.startsWith('list:')).length,
    providerBusinessCalls: providerLog().filter((line) => line.startsWith('call:')).length,
  })}`);
});

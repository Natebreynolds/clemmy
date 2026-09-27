/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/prompt-composition.host.test.ts
 *
 * The prompt meter on a composed host turn: runConversation → host_v1 runner →
 * the loop's input filter → prompt_composition event.
 * The model is a scripted stub that captures the exact request it received.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-prompt-composition-host-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
delete process.env.OPENAI_API_KEY;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_JEV = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-prompt-composition\n', 'utf8');

const { runConversation } = await import('./loop.js');
const eventlog = await import('./eventlog.js');
const memoryDatabase = await import('../../memory/db.js');
const { _resetAdvertisedSurfaceMemoryForTests } = await import('./host-turn-runner.js');
const { estimateTokens } = await import('./budget.js');
const capabilityEnvelopes = await import('../../agents/capability-envelope.js');

function bindSurface(sessionId: string, agent: object, tools: Array<{ name?: unknown }>): void {
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId,
    universeTools: tools as never,
    activeToolNames: tools.map((entry) => String(entry.name ?? '')).filter(Boolean),
    policyHash: 'prompt-composition-test-policy-v1',
    budget: { maxUncachedTokens: 1_000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 60_000 },
  });
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
}

test.after(() => {
  eventlog.closeEventLog();
  memoryDatabase.closeMemoryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{ usage?: Record<string, unknown>; output?: unknown[]; responseId?: string }> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const finishReason = (response.output ?? []).some((item) => (item as { type?: string }).type === 'function_call')
    ? 'tool_calls'
    : 'stop';
  yield { type: 'response_started' } as never;
  yield { type: 'model', event: { type: 'finish', finishReason } } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId ?? 'test-response',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output: response.output ?? [],
    },
  } as never;
}

function textMsg(text: string) {
  return { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] };
}

function capturingModel(reply: string) {
  const requests: Array<{ tools?: unknown[] }> = [];
  return {
    requests,
    async getResponse(request: { tools?: unknown[] }) {
      requests.push(request);
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output: [textMsg(reply)],
        responseId: `composition-${requests.length}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
}

const LARGE_PROPERTIES = Object.fromEntries(
  Array.from({ length: 40 }, (_, index) => [`field_${index}`, { type: 'string', description: `Field ${index} of the deferred fixture.` }]),
);

function fixtureTool(name: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'function',
    name,
    description: `${name} fixture`,
    // zod-style converter artifacts the runner compacts away before the wire.
    parameters: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { query: { anyOf: [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, { type: 'null' }] } },
      additionalProperties: false,
    },
    strict: false,
    invoke: async () => `${name} ran`,
    needsApproval: async () => false,
    ...extra,
  };
}

async function composeHostTurn(label: string, tools: unknown[]) {
  const previous = process.env.CLEMMY_TURN_ENGINE;
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  _resetAdvertisedSurfaceMemoryForTests();
  try {
    const session = eventlog.createSession({ id: `prompt-composition-${label}`, kind: 'chat' });
    const model = capturingModel('composition measured');
    await runConversation({
      sessionId: session.id,
      input: 'hello',
      turnEngine: 'host_v1',
      maxSteps: 1,
      judgeCompletion: false,
      buildAgent: async () => {
        const agent = { model, instructions: 'base system', tools, getAllTools: async () => tools };
        bindSurface(session.id, agent, tools as Array<{ name?: unknown }>);
        return agent as never;
      },
      makeRunner: () => {
        const runner = new EventEmitter();
        (runner as unknown as { run: () => never }).run = () => { throw new Error('legacy Runner.run must be unreachable'); };
        return runner as never;
      },
      maxTurns: 3,
    });
    const compositions = eventlog.listEvents(session.id, { types: ['prompt_composition'] });
    return { session, model, compositions };
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_TURN_ENGINE;
    else process.env.CLEMMY_TURN_ENGINE = previous;
  }
}

function wireToolTokens(tools: unknown[]): { names: string[]; tokens: number; bytes: number } {
  let tokens = 0;
  let bytes = 0;
  const names: string[] = [];
  for (const raw of tools) {
    const tool = raw as Record<string, unknown>;
    const serialized = JSON.stringify({
      type: tool.type, name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict,
    });
    names.push(String(tool.name));
    tokens += estimateTokens(serialized);
    bytes += Buffer.byteLength(serialized);
  }
  return { names, tokens, bytes };
}

test('a composed host turn bills a deferLoading tool left off the wire zero schema bytes, and measures the compacted wire', async () => {
  const deferred = fixtureTool('memory_search', {
    deferLoading: true,
    parameters: { type: 'object', properties: LARGE_PROPERTIES, additionalProperties: false },
  });
  const tools = [fixtureTool('tool_search'), fixtureTool('call_tool'), fixtureTool('workspace_roots'), deferred];
  const { model, compositions } = await composeHostTurn('deferred-with-doors', tools);
  assert.ok(model.requests.length >= 1, 'the host made the model request');
  const wire = model.requests[0]!.tools ?? [];
  const sent = wireToolTokens(wire);
  assert.deepEqual(sent.names, ['tool_search', 'call_tool', 'workspace_roots'], 'fixture: the runner left the deferred schema off');
  assert.ok(compositions.length >= 1, 'the host filter recorded a composition');
  const data = compositions[0]!.data as {
    toolCount: number;
    toolSchemaCosts: Array<{ name: string; tokens: number; bytes?: number; deferred: boolean }>;
    buckets: Array<{ name: string; tokens: number }>;
  };
  const costs = new Map(data.toolSchemaCosts.map((cost) => [cost.name, cost]));
  assert.equal(costs.get('memory_search')?.tokens ?? 0, 0, 'a tool left off the wire costs no schema tokens');
  assert.equal(costs.get('memory_search')?.bytes ?? 0, 0, 'a tool left off the wire costs no schema bytes');
  assert.equal(data.toolCount, 3);
  const buckets = new Map(data.buckets.map((bucket) => [bucket.name, bucket.tokens]));
  assert.equal(buckets.get('toolSchemas'), sent.tokens, 'toolSchemas equals the schemas actually advertised');
  assert.equal(buckets.get('deferredToolIndex') ?? 0, 0, 'nothing about the deferred tool was sent, so no index is billed');
  const measuredBytes = data.toolSchemaCosts.reduce((sum, cost) => sum + (cost.bytes ?? 0), 0);
  assert.equal(measuredBytes, sent.bytes, 'schema bytes are the compacted projection the runner sent');
  const raw = wireToolTokens(tools.slice(0, 3).map((tool) => ({ ...tool, type: 'function' })));
  assert.ok(measuredBytes < raw.bytes, 'the compaction the runner applies is reflected, not the raw schema');

});

test('without the search and call doors the deferLoading tool is advertised and billed in full', async () => {
  const deferred = fixtureTool('memory_search', {
    deferLoading: true,
    parameters: { type: 'object', properties: LARGE_PROPERTIES, additionalProperties: false },
  });
  const { model, compositions } = await composeHostTurn('deferred-without-doors', [fixtureTool('workspace_roots'), deferred]);
  const sent = wireToolTokens(model.requests[0]!.tools ?? []);
  assert.deepEqual(sent.names, ['workspace_roots', 'memory_search']);
  const data = compositions[0]!.data as { buckets: Array<{ name: string; tokens: number }> };
  assert.equal(data.buckets.find((bucket) => bucket.name === 'toolSchemas')?.tokens, sent.tokens);
});

test('a composed host turn measures history before the per-round appends and its buckets add up to what was sent', async () => {
  const brackets = await import('./brackets.js');
  const { estimateInputTokens } = await import('./token-estimator.js');
  let reads = 0;
  const roots = brackets.wrapToolForHarness({
    ...fixtureTool('workspace_roots'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    invoke: async () => { reads += 1; return 'ROOTS: /fixture'; },
  } as never);
  const tools = [roots];
  const previous = process.env.CLEMMY_TURN_ENGINE;
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  _resetAdvertisedSurfaceMemoryForTests();
  const requests: Array<{ input?: unknown; systemInstructions?: string }> = [];
  const model = {
    async getResponse(request: { input?: unknown; systemInstructions?: string }) {
      requests.push(structuredClone(request));
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output: requests.length === 1
          ? [{ type: 'function_call', callId: 'roots-1', name: 'workspace_roots', arguments: '{}' }]
          : [textMsg('roots listed')],
        responseId: `bookkeeping-${requests.length}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
  const steer = 'CONTINUATION STEER FIXTURE: keep going with the roots.';
  let sessionId = '';
  try {
    const session = eventlog.createSession({ id: 'prompt-composition-bookkeeping', kind: 'chat' });
    sessionId = session.id;
    await runConversation({
      sessionId: session.id,
      input: 'Please list the workspace roots you can see for me.',
      turnEngine: 'host_v1',
      maxSteps: 3,
      judgeCompletion: false,
      continuationSteer: steer,
      buildAgent: async () => {
        const agent = { model, instructions: 'base system', tools, getAllTools: async () => tools };
        bindSurface(session.id, agent, tools as Array<{ name?: unknown }>);
        return agent as never;
      },
      makeRunner: () => {
        const runner = new EventEmitter();
        (runner as unknown as { run: () => never }).run = () => { throw new Error('legacy Runner.run must be unreachable'); };
        return runner as never;
      },
      maxTurns: 3,
    } as never);
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_TURN_ENGINE;
    else process.env.CLEMMY_TURN_ENGINE = previous;
  }
  assert.equal(reads, 1, 'fixture: the tool round ran');
  assert.equal(requests.length, 2, 'fixture: two model requests');
  const compositions = eventlog.listEvents(sessionId, { types: ['prompt_composition'] });
  assert.equal(compositions.length, 2);
  const source = eventlog.listEvents(sessionId, { types: ['user_input_received'] })
    .find((event) => event.data.synthetic !== true)!;
  const provenance = eventlog.openEventLog().prepare(`
    SELECT request_ordinal FROM model_request_provenance WHERE session_id = ? AND source_user_seq = ? ORDER BY request_ordinal
  `).all(sessionId, source.seq) as Array<{ request_ordinal: number }>;
  assert.deepEqual(provenance.map((row) => row.request_ordinal), [1, 2]);

  const inputBuckets = ['history', 'currentMessage', 'contextPacket', 'memoryPrimer', 'provenOperation', 'retryContext'];
  compositions.forEach((event, index) => {
    const data = event.data as {
      requestOrdinal?: number;
      sourceUserSeq?: number;
      totalTokens: number;
      buckets: Array<{ name: string; tokens: number }>;
    };
    assert.equal(data.requestOrdinal, provenance[index]!.request_ordinal, 'each reading joins its provenance row by ordinal');
    assert.equal(data.sourceUserSeq, source.seq);
    const names = data.buckets.map((bucket) => bucket.name);
    assert.equal(new Set(names).size, names.length, 'no bucket is recorded twice');
    const tokens = new Map(data.buckets.map((bucket) => [bucket.name, bucket.tokens]));
    assert.ok((tokens.get('contextPacket') ?? 0) > 0, 'the context packet is its own bucket');
    assert.ok((tokens.get('currentMessage') ?? 0) > 0, 'the opening message is its own bucket');
    // The input the model received, less any host guidance appended after the
    // filter, equals the input-side buckets exactly: nothing counted twice.
    const sent = (requests[index]!.input ?? []) as Array<{ role?: string; content?: unknown }>;
    const filterEnd = sent.findIndex((item) => item.role === 'system'
      && typeof item.content === 'string' && item.content.includes(steer));
    assert.ok(filterEnd >= 0, 'fixture: the context packet item reached the model');
    const composedInput = sent.slice(0, filterEnd + 1);
    const inputSum = inputBuckets.reduce((sum, name) => sum + (tokens.get(name) ?? 0), 0);
    assert.equal(inputSum, estimateInputTokens(composedInput as never),
      'history + message + appended items = the composed input, with nothing counted twice');
    assert.equal(data.totalTokens, data.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0));
  });
  const first = new Map((compositions[0]!.data as { buckets: Array<{ name: string; tokens: number }> }).buckets
    .map((bucket) => [bucket.name, bucket.tokens]));
  const second = new Map((compositions[1]!.data as { buckets: Array<{ name: string; tokens: number }> }).buckets
    .map((bucket) => [bucket.name, bucket.tokens]));
  assert.ok((second.get('history') ?? 0) > (first.get('history') ?? 0), 'the tool round grows history, not the appended buckets');
  assert.equal(second.get('contextPacket'), first.get('contextPacket'));
});

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
  yield { type: 'response_started' } as never;
  yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } } as never;
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

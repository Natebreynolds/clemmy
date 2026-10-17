import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRequest } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { buildCodexRequestBody, splitCodexInstructions, CodexResponsesModel, CodexModelProvider, transparentCodexRetryBudget, strictWireParameters } from './codex-model.js';
import { INSTRUCTION_CACHE_DELIM, resolveProvider } from './model-wire-registry.js';
import { harnessRunContextStorage } from './brackets.js';
import { BoundaryError } from '../boundary-error.js';
import { buildTransportTimeoutError, detectCodexTransportFailure } from '../codex-dispatcher.js';
import { HarnessSession } from './session.js';
import { listEvents } from './eventlog.js';

process.env.NODE_ENV = 'test';
process.env.CLEMMY_CODEX_TRANSPARENT_RETRY_DELAY_MS = '0';

test.after(() => {
  delete process.env.CLEMMY_CODEX_TRANSPARENT_RETRY_DELAY_MS;
});

async function withNativeCompactionEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const previousValue = process.env.CLEMMY_CODEX_NATIVE_COMPACTION;
  const previousThreshold = process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD;
  process.env.CLEMMY_CODEX_NATIVE_COMPACTION = '1';
  process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD = '4';
  try {
    return await fn();
  } finally {
    if (previousValue == null) delete process.env.CLEMMY_CODEX_NATIVE_COMPACTION;
    else process.env.CLEMMY_CODEX_NATIVE_COMPACTION = previousValue;
    if (previousThreshold == null) delete process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD;
    else process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD = previousThreshold;
  }
}

type ScriptedAttempt = (attempt: number) => AsyncGenerator<any>;

function modelRequest(input: ModelRequest['input'] = []): ModelRequest {
  return {
    input,
    tools: [],
    handoffs: [],
    modelSettings: {},
    outputType: 'text',
    tracing: false,
  } as unknown as ModelRequest;
}

test('buildCodexRequestBody keys EVERY call by its prompt role, and a conversation by its own id', () => {
  // An unkeyed call is never routed to a warm node, so every call carries a
  // key, inside a run context or not.
  const outside = buildCodexRequestBody('gpt-5.5', modelRequest([{ role: 'user', content: 'hi' }]));
  assert.match(String(outside.prompt_cache_key), /^clem:[0-9a-f]{12}$/);

  // Inside a conversation the key adds the conversation's own id, as the
  // service's own client does: a conversation's growing history caches only
  // on the node that keeps it.
  const inside = harnessRunContextStorage.run({ sessionId: 'sess-abc' } as never, () =>
    buildCodexRequestBody('gpt-5.5', modelRequest([{ role: 'user', content: 'hi' }])),
  );
  assert.match(String(inside.prompt_cache_key), /^clem:[0-9a-f]{12}:[0-9a-f]{16}$/);
  assert.ok(String(inside.prompt_cache_key).startsWith(`${outside.prompt_cache_key}:`),
    'the role part is the same; the conversation part is appended');
});

test('prompt roles shard apart; one role keeps its key as its tool list grows', () => {
  // Different roles (a main agent, a sub-agent, a judge) carry different
  // instructions and must not contend for one node's prefix.
  const run = (instructions: string, tools: unknown[] = [], sessionId = 'sess-shape') =>
    harnessRunContextStorage.run({ sessionId } as never, () =>
      buildCodexRequestBody('gpt-5.5', {
        ...modelRequest([{ role: 'user', content: 'hi' }]),
        systemInstructions: instructions,
        tools,
      } as unknown as ModelRequest),
    );
  const a = run('AGENT ONE RUBRIC');
  const b = run('A COMPLETELY DIFFERENT AGENT RUBRIC');
  assert.notEqual(a.prompt_cache_key, b.prompt_cache_key, 'different roles shard apart');
  assert.equal(run('AGENT ONE RUBRIC').prompt_cache_key, a.prompt_cache_key, 'same role, same key');

  // A tool enabled mid-turn is appended after the tools already shown, so the
  // earlier prefix is still byte-identical; the key must keep routing it to
  // the node that holds that prefix.
  const tool = (name: string) => ({
    type: 'function', name, description: `${name} tool`, strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  });
  const firstFrame = run('AGENT ONE RUBRIC', [tool('tool_search')]);
  const laterFrame = run('AGENT ONE RUBRIC', [tool('tool_search'), tool('work_call')]);
  assert.equal(laterFrame.prompt_cache_key, firstFrame.prompt_cache_key);
  const other = String(run('AGENT ONE RUBRIC', [], 'another-session').prompt_cache_key);
  assert.notEqual(other, a.prompt_cache_key, 'another conversation of the same role keeps its own key');
  assert.equal(other.split(':')[1], String(a.prompt_cache_key).split(':')[1], 'with the same role part');
});

test('the strict wire drops an unsupported format keyword and never touches literal data', () => {
  const schema = {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri' },
      when: { type: 'string', format: 'date-time' },
      // A property may be named like a keyword; its schema is still cleaned.
      format: { type: 'string', format: 'uri', default: 'csv' },
      default: { type: 'object', properties: { link: { type: 'string', format: 'uri' } }, default: { format: 'uri' } },
      mode: { type: 'string', enum: ['uri', 'csv'], const: 'uri' },
      shape: { type: 'object', default: { format: 'csv', nested: { format: 'uri' } }, examples: [{ format: 'uri' }] },
    },
    required: ['url', 'format'],
  };
  const wire = strictWireParameters(schema) as typeof schema;
  assert.equal('format' in wire.properties.url, false, 'unsupported format is dropped');
  assert.equal(wire.properties.when.format, 'date-time', 'supported format is kept');
  assert.deepEqual(wire.properties.format, { type: 'string', default: 'csv' }, 'a property named format keeps its default');
  assert.deepEqual(wire.properties.default.default, { format: 'uri' }, 'a default object is data');
  assert.equal('format' in wire.properties.default.properties.link, false, 'a property named default is still a schema');
  assert.deepEqual(wire.properties.mode, schema.properties.mode, 'enum and const keep every value');
  assert.deepEqual(wire.properties.shape, schema.properties.shape, 'nested defaults and examples keep every byte');
  assert.deepEqual(wire.required, ['url', 'format']);
});

function requestWithInstructions(systemInstructions: string, input: ModelRequest['input'] = [{ role: 'user', content: 'hi' }]): ModelRequest {
  return { ...modelRequest(input), systemInstructions } as unknown as ModelRequest;
}

test('splitCodexInstructions splits role (stable) from dynamic ctx on the sentinel; no sentinel → all instructions', () => {
  const raw = `ROLE_RUBRIC${INSTRUCTION_CACHE_DELIM}DYNAMIC_CTX`;
  assert.deepEqual(splitCodexInstructions(raw), { instructions: 'ROLE_RUBRIC', trailingContext: 'DYNAMIC_CTX', cacheKeySource: 'ROLE_RUBRIC' });
  assert.deepEqual(splitCodexInstructions('just role, no sentinel'), { instructions: 'just role, no sentinel', trailingContext: '', cacheKeySource: 'just role, no sentinel' });
});

test('Codex wire: the memory core stays in instructions while the routing key follows the rubric alone', async () => {
  const { CACHE_MEMORY_CORE_DELIM, CACHE_MEMORY_CORE_SENTINEL } = await import('./model-wire-registry.js');
  const withCore = (core: string) => buildCodexRequestBody('gpt-5.5',
    requestWithInstructions(`ROLE_RUBRIC${CACHE_MEMORY_CORE_DELIM}${core}${INSTRUCTION_CACHE_DELIM}DYNAMIC_CTX`));
  const a = withCore('CORE v1: prefers mornings');
  const b = withCore('CORE v2: prefers evenings');
  const bare = buildCodexRequestBody('gpt-5.5', requestWithInstructions(`ROLE_RUBRIC${INSTRUCTION_CACHE_DELIM}DYNAMIC_CTX`));
  assert.equal(a.instructions, 'ROLE_RUBRIC\n\nCORE v1: prefers mornings', 'the core is cacheable prefix, marker stripped');
  assert.ok(!String(a.instructions).includes(CACHE_MEMORY_CORE_SENTINEL));
  assert.equal(a.prompt_cache_key, b.prompt_cache_key, 'a memory edit keeps the role on its node');
  assert.equal(a.prompt_cache_key, bare.prompt_cache_key, 'the key names the prompt role, not a memory version');
  assert.deepEqual((a.input as Array<Record<string, unknown>>).at(-1), { role: 'system', content: 'DYNAMIC_CTX' });
});

test('splitCodexInstructions preserves turn then memory bytes but strips the internal memory marker', async () => {
  const { CACHE_MEMORY_CONTEXT_DELIM, CACHE_MEMORY_CONTEXT_SENTINEL } = await import('./model-wire-registry.js');
  const raw = `ROLE${INSTRUCTION_CACHE_DELIM}TURN${CACHE_MEMORY_CONTEXT_DELIM}MEMORY`;
  const split = splitCodexInstructions(raw);
  assert.equal(split.instructions, 'ROLE');
  assert.equal(split.trailingContext, 'TURN\n\nMEMORY');
  assert.equal(split.trailingContext.includes(CACHE_MEMORY_CONTEXT_SENTINEL), false);
});

test('Codex wire (default): instructions is the STABLE role only; dynamic ctx re-homed as a trailing input system message', () => {
  const body = buildCodexRequestBody('gpt-5.5', requestWithInstructions(`ROLE_RUBRIC${INSTRUCTION_CACHE_DELIM}DYNAMIC_CTX`));
  // instructions must NOT contain the per-turn ctx (so instructions+tools caches).
  assert.equal(body.instructions, 'ROLE_RUBRIC');
  assert.ok(!String(body.instructions).includes('DYNAMIC_CTX'), 'dynamic ctx must not sit in instructions');
  // the ctx is preserved — re-homed as the LAST input item (after tools), role=system.
  const last = (body.input as Array<Record<string, unknown>>).at(-1);
  assert.deepEqual(last, { role: 'system', content: 'DYNAMIC_CTX' });
});

test('Codex wire cache stability: two turns with the SAME role+tools but DIFFERENT ctx yield an IDENTICAL instructions prefix', () => {
  const a = buildCodexRequestBody('gpt-5.5', requestWithInstructions(`ROLE${INSTRUCTION_CACHE_DELIM}ctx turn A: focus=alpha`));
  const b = buildCodexRequestBody('gpt-5.5', requestWithInstructions(`ROLE${INSTRUCTION_CACHE_DELIM}ctx turn B: focus=bravo`));
  // The cacheable prefix (instructions) is byte-identical across turns even though
  // the per-turn ctx changed — this is what lets OpenAI's prefix cache hit the tool block.
  assert.equal(a.instructions, b.instructions);
  assert.equal(a.instructions, 'ROLE');
});

test('buildCodexRequestBody drops non-Codex function_call ids from mixed-provider history', () => {
  const body = buildCodexRequestBody('gpt-5.5', modelRequest([
    { role: 'user', content: 'edit this workspace' },
    {
      type: 'function_call',
      id: '20260624072838009e610297f64eac',
      callId: 'call_cross_provider',
      name: 'workspace_update',
      arguments: '{}',
      status: 'completed',
    },
    {
      type: 'function_call',
      id: 'fc_real123',
      callId: 'call_codex',
      name: 'workspace_read',
      arguments: '{}',
      status: 'completed',
    },
    {
      type: 'function_call',
      id: 'fc_base_p0',
      call_id: 'call_parallel',
      name: 'workspace_list',
      arguments: '{}',
      status: 'completed',
    },
    {
      type: 'function_call_result',
      id: 'fcr_cross_provider',
      callId: 'call_cross_provider',
      output: { type: 'text', text: 'ok' },
      status: 'completed',
    },
    {
      type: 'function_call_output',
      id: '20260624072838009e610297f64eac',
      call_id: 'call_direct_output',
      output: 'direct output replay',
      status: 'completed',
    },
  ] as unknown as ModelRequest['input']));

  const input = body.input as Array<Record<string, unknown>>;
  assert.equal(input[1].type, 'function_call');
  assert.equal(input[1].id, undefined, 'timestamp-style provider id must not be sent to Codex');
  assert.equal(input[1].call_id, 'call_cross_provider', 'call_id correlation is preserved');
  assert.equal(input[2].id, 'fc_real123', 'genuine Codex item id is preserved');
  assert.equal(input[3].id, undefined, 'synthetic parallel-expansion id must not be sent to Codex');
  assert.equal(input[3].call_id, 'call_parallel', 'snake_case call_id is accepted');
  assert.equal(input[4].type, 'function_call_output');
  assert.equal(input[4].id, undefined, 'function_call_output does not need a provider-specific item id');
  assert.equal(input[4].call_id, 'call_cross_provider');
  assert.equal(input[5].type, 'function_call_output');
  assert.equal(input[5].id, undefined, 'direct function_call_output replay ids must be stripped too');
  assert.equal(input[5].call_id, 'call_direct_output');
  assert.equal(input[5].output, 'direct output replay');
});

test('buildCodexRequestBody sends an image tool result as content items, not serialized bytes', () => {
  const body = buildCodexRequestBody('gpt-5.5', modelRequest([
    { role: 'user', content: 'check how the workspace looks' },
    { type: 'function_call', id: 'fc_preview', callId: 'call_preview', name: 'call_tool', arguments: '{}', status: 'completed' },
    {
      type: 'function_call_result',
      callId: 'call_preview',
      output: [
        { type: 'input_text', text: 'Preview of "Board"' },
        { type: 'input_image', image: 'data:image/png;base64,aW1hZ2U=' },
      ],
      status: 'completed',
    },
    {
      type: 'function_call_result',
      callId: 'call_structured',
      output: [{ type: 'input_text', text: 'no image here' }],
      status: 'completed',
    },
  ] as unknown as ModelRequest['input']));
  const input = body.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[2].output, [
    { type: 'input_text', text: 'Preview of "Board"' },
    { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' },
  ]);
  assert.equal(typeof input[3].output, 'string', 'a result without an image keeps its text projection');
});

test('buildCodexRequestBody attaches only the latest tool-result images', () => {
  const items: unknown[] = [{ role: 'user', content: 'iterate on the workspace' }];
  for (let index = 0; index < 6; index += 1) {
    items.push({ type: 'function_call', id: `fc_${index}`, callId: `call_${index}`, name: 'space_preview', arguments: '{}', status: 'completed' });
    items.push({ type: 'function_call_result', callId: `call_${index}`, status: 'completed', output: [
      { type: 'input_text', text: `render ${index}` },
      { type: 'input_image', image: `data:image/png;base64,cmVuZGVy${index}` },
    ] });
  }
  const body = buildCodexRequestBody('gpt-5.5', modelRequest(items as ModelRequest['input']));
  const outputs = (body.input as Array<Record<string, unknown>>).filter((item) => item.type === 'function_call_output');
  const imageUrls = outputs.flatMap((item) => (item.output as Array<Record<string, unknown>>)
    .filter((part) => part.type === 'input_image').map((part) => part.image_url));
  assert.deepEqual(imageUrls, [2, 3, 4, 5].map((index) => `data:image/png;base64,cmVuZGVy${index}`));
  assert.match(JSON.stringify(outputs[0]!.output), /no longer attached/);
});

class ScriptedCodexModel extends CodexResponsesModel {
  attempts = 0;

  constructor(private readonly script: ScriptedAttempt) {
    super('gpt-5.5');
  }

  protected async *streamCodex(_request: ModelRequest): AsyncGenerator<any> {
    this.attempts += 1;
    yield* this.script(this.attempts);
  }
}

async function* successfulTurn(responseId = 'resp_ok'): AsyncGenerator<any> {
  yield { type: 'response.created', response: { id: responseId } };
  yield { type: 'response.output_text.delta', delta: 'ok', sequence_number: 1 };
  yield {
    type: 'response.output_item.done',
    item: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok' }],
    },
  };
  yield {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: {},
        output_tokens_details: {},
      },
    },
  };
}

async function* compactionOnlyTruncation(responseId = 'resp_compact'): AsyncGenerator<any> {
  yield { type: 'response.created', response: { id: responseId } };
  yield {
    type: 'response.output_item.done',
    item: {
      id: 'cmp_1',
      type: 'compaction',
      encrypted_content: 'ciphertext',
      created_by: 'server',
    },
  };
}

async function* functionCallThenTruncation(responseId = 'resp_tool'): AsyncGenerator<any> {
  yield { type: 'response.created', response: { id: responseId } };
  yield {
    type: 'response.output_item.done',
    item: {
      id: 'fc_1',
      type: 'function_call',
      call_id: 'call_tool_1',
      name: 'write_file',
      arguments: '{}',
      status: 'completed',
    },
  };
}

/** response.completed arrives but the model yielded NO output (zero items,
 *  no text delta). The "empty completion" backend blip that dead-ended as
 *  the "couldn't be structured" sentinel before the boundary invariant. */
async function* emptyCompletion(responseId = 'resp_empty'): AsyncGenerator<any> {
  yield { type: 'response.created', response: { id: responseId } };
  yield {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: {
        input_tokens: 1,
        output_tokens: 0,
        total_tokens: 1,
        input_tokens_details: {},
        output_tokens_details: {},
      },
    },
  };
}

/** A completion whose only output item is a reasoning item (no message).
 *  This is NOT an empty completion — content escaped — so the model boundary
 *  must pass it through cleanly and leave the "not a parseable decision"
 *  concern to the loop layer. Guards the boundary between the two fixes. */
async function* reasoningOnlyCompletion(responseId = 'resp_reasoning'): AsyncGenerator<any> {
  yield { type: 'response.created', response: { id: responseId } };
  yield {
    type: 'response.output_item.done',
    item: {
      id: 'rsn_1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'thinking' }],
      encrypted_content: 'enc',
    },
  };
  yield {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: {},
        output_tokens_details: {},
      },
    },
  };
}

test('CodexResponsesModel retries an empty completion, then recovers (streamed)', async () => {
  const model = new ScriptedCodexModel(async function* (attempt) {
    if (attempt === 1) {
      yield* emptyCompletion();
      return;
    }
    yield* successfulTurn('resp_after_empty_retry');
  });

  const events: StreamEvent[] = [];
  for await (const event of model.getStreamedResponse(modelRequest())) {
    events.push(event);
  }

  assert.equal(model.attempts, 2);
  assert.deepEqual(events.map((event) => event.type), [
    'response_started',
    'output_text_delta',
    'response_done',
  ]);
  const done = events.at(-1) as Extract<StreamEvent, { type: 'response_done' }>;
  assert.equal(done.response.id, 'resp_after_empty_retry');
});

test('CodexResponsesModel throws a retryable boundary error when every completion is empty (streamed)', async () => {
  const model = new ScriptedCodexModel(async function* () {
    yield* emptyCompletion();
  });

  const events: StreamEvent[] = [];
  let caught: unknown;
  try {
    for await (const event of model.getStreamedResponse(modelRequest())) {
      events.push(event);
    }
  } catch (err) {
    caught = err;
  }

  assert.equal(model.attempts, 4); // 1 + CODEX_TRANSPARENT_MAX_RETRIES(3)
  assert.ok(caught instanceof BoundaryError);
  assert.equal(caught.kind, 'codex.sse_truncated');
  assert.equal(caught.context.emptyCompletion, true);
  // No fabricated clean response_done escaped to the SDK.
  assert.ok(!events.some((event) => event.type === 'response_done'));
});

test('CodexResponsesModel does NOT treat a reasoning-only completion as empty (boundary with the loop layer)', async () => {
  const model = new ScriptedCodexModel(async function* () {
    yield* reasoningOnlyCompletion('resp_reasoning_clean');
  });

  const events: StreamEvent[] = [];
  for await (const event of model.getStreamedResponse(modelRequest())) {
    events.push(event);
  }

  // Content escaped (a reasoning item) → clean pass-through, single attempt,
  // no retry. Parsing it into a decision is the loop's job, not the model's.
  assert.equal(model.attempts, 1);
  const done = events.at(-1) as Extract<StreamEvent, { type: 'response_done' }>;
  assert.equal(done.type, 'response_done');
  assert.equal(done.response.id, 'resp_reasoning_clean');
});

test('CodexResponsesModel retries an empty completion, then recovers (non-streamed getResponse)', async () => {
  const model = new ScriptedCodexModel(async function* (attempt) {
    if (attempt === 1) {
      yield* emptyCompletion();
      return;
    }
    yield* successfulTurn('resp_nonstream_after_empty');
  });

  const response = await model.getResponse(modelRequest());

  assert.equal(model.attempts, 2);
  assert.equal(response.responseId, 'resp_nonstream_after_empty');
  assert.equal(response.output.length, 1);
});

test('CodexResponsesModel retries first-call headers timeout before streaming content', async () => {
  const model = new ScriptedCodexModel(async function* (attempt) {
    if (attempt === 1) {
      throw buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', { phase: 'headers' });
    }
    yield* successfulTurn('resp_retry_ok');
  });

  const events: StreamEvent[] = [];
  for await (const event of model.getStreamedResponse(modelRequest())) {
    events.push(event);
  }

  assert.equal(model.attempts, 2);
  assert.deepEqual(events.map((event) => event.type), [
    'response_started',
    'output_text_delta',
    'response_done',
  ]);
  const done = events.at(-1) as Extract<StreamEvent, { type: 'response_done' }>;
  assert.equal(done.response.id, 'resp_retry_ok');
});

test('CodexResponsesModel retries fetch terminated before streaming content', async () => {
  const model = new ScriptedCodexModel(async function* (attempt) {
    if (attempt === 1) {
      throw buildTransportTimeoutError('FETCH_TERMINATED', { phase: 'body' }, new TypeError('terminated'));
    }
    yield* successfulTurn('resp_terminated_retry_ok');
  });

  const events: StreamEvent[] = [];
  for await (const event of model.getStreamedResponse(modelRequest())) {
    events.push(event);
  }

  assert.equal(model.attempts, 2);
  const done = events.at(-1) as Extract<StreamEvent, { type: 'response_done' }>;
  assert.equal(done.response.id, 'resp_terminated_retry_ok');
});

test('detectCodexTransportFailure recognizes bare fetch terminated errors', () => {
  assert.equal(detectCodexTransportFailure(new TypeError('terminated')), 'FETCH_TERMINATED');
  assert.equal(
    detectCodexTransportFailure(new TypeError('fetch failed', { cause: new TypeError('terminated') })),
    'FETCH_TERMINATED',
  );
});

test('CodexResponsesModel does not retry transport timeout after content was yielded', async () => {
  const model = new ScriptedCodexModel(async function* () {
    yield { type: 'response.created', response: { id: 'resp_partial' } };
    yield { type: 'response.output_text.delta', delta: 'partial', sequence_number: 1 };
    throw buildTransportTimeoutError('UND_ERR_BODY_TIMEOUT', { phase: 'body' });
  });

  const events: StreamEvent[] = [];
  let caught: unknown;
  try {
    for await (const event of model.getStreamedResponse(modelRequest())) {
      events.push(event);
    }
  } catch (err) {
    caught = err;
  }

  assert.equal(model.attempts, 1);
  assert.deepEqual(events.map((event) => event.type), ['response_started', 'output_text_delta']);
  assert.ok(caught instanceof BoundaryError);
  assert.equal(caught.kind, 'codex.transport_timeout');
  assert.equal(caught.context.undiciCode, 'UND_ERR_BODY_TIMEOUT');
});

test('transparent retry budget is per failure class: body timeout none, headers timeout one, terminated / no-content / rate limit the ceiling', () => {
  assert.equal(transparentCodexRetryBudget(buildTransportTimeoutError('UND_ERR_BODY_TIMEOUT', { phase: 'body' })), 0);
  assert.equal(transparentCodexRetryBudget(buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', { phase: 'headers' })), 1);
  assert.equal(transparentCodexRetryBudget(buildTransportTimeoutError('FETCH_TERMINATED', { phase: 'body' }, new TypeError('terminated'))), 3);
  assert.equal(transparentCodexRetryBudget(new BoundaryError({ kind: 'codex.sse_truncated', retryable: true, userMessage: '', operatorMessage: '' })), 3);
  assert.equal(transparentCodexRetryBudget(new Error('invalid model configuration')), 0);
});

test('CodexResponsesModel does NOT replay a body timeout before content: the attempt spent the dead-socket window, the chain owns recovery', async () => {
  const model = new ScriptedCodexModel(async function* () {
    yield { type: 'response.created', response: { id: 'resp_dead_socket' } };
    throw buildTransportTimeoutError('UND_ERR_BODY_TIMEOUT', { phase: 'body' });
  });

  const events: StreamEvent[] = [];
  let caught: unknown;
  try {
    for await (const event of model.getStreamedResponse(modelRequest())) events.push(event);
  } catch (err) {
    caught = err;
  }

  assert.equal(model.attempts, 1, 'a body timeout is never replayed inside the adapter');
  assert.deepEqual(events, [], 'the buffered response.created never reached the SDK');
  assert.ok(caught instanceof BoundaryError);
  assert.equal(caught.kind, 'codex.transport_timeout');
  assert.equal(caught.context.undiciCode, 'UND_ERR_BODY_TIMEOUT');
});

test('CodexResponsesModel replays a headers timeout once, then lets the second one escape', async () => {
  const model = new ScriptedCodexModel(async function* () {
    throw buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', { phase: 'headers' });
  });

  let caught: unknown;
  try {
    for await (const _event of model.getStreamedResponse(modelRequest())) { /* none */ }
  } catch (err) {
    caught = err;
  }

  assert.equal(model.attempts, 2);
  assert.ok(caught instanceof BoundaryError);
  assert.equal(caught.kind, 'codex.transport_timeout');
  assert.equal(caught.context.undiciCode, 'UND_ERR_HEADERS_TIMEOUT');
});

test('a transparent retry inside a harness run is journaled as one public stall_retry_attempted{model_transport_retry} row', async () => {
  const session = HarnessSession.create({ kind: 'chat', title: 'codex transparent retry ledger' });
  const model = new ScriptedCodexModel(async function* (attempt) {
    if (attempt === 1) throw buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', { phase: 'headers' });
    yield* successfulTurn('resp_journaled_retry');
  });

  const events = await harnessRunContextStorage.run(
    { sessionId: session.id, sourceUserSeq: 7, turn: 2 } as never,
    async () => {
      const out: StreamEvent[] = [];
      for await (const event of model.getStreamedResponse(modelRequest())) out.push(event);
      return out;
    },
  );

  assert.equal(model.attempts, 2);
  assert.equal((events.at(-1) as Extract<StreamEvent, { type: 'response_done' }>).response.id, 'resp_journaled_retry');
  const rows = listEvents(session.id, { types: ['stall_retry_attempted'] });
  assert.equal(rows.length, 1, 'exactly one retry, exactly one row');
  const data = rows[0].data as Record<string, unknown>;
  assert.equal(data.kind, 'model_transport_retry');
  assert.equal(data.layer, 'adapter');
  assert.equal(data.provider, 'codex');
  assert.equal(data.model, 'gpt-5.5');
  assert.equal(data.path, 'getStreamedResponse');
  assert.equal(data.attempt, 1);
  assert.equal(data.maxAttempts, 2, 'a headers timeout earns one replay: two attempts in all');
  assert.equal(data.failureKind, 'codex.transport_timeout');
  assert.equal(data.undiciCode, 'UND_ERR_HEADERS_TIMEOUT');
  assert.equal(data.phase, 'headers');
  assert.equal(data.sourceUserSeq, 7);
  assert.equal(rows[0].turn, 2);
  assert.equal(typeof data.backoffMs, 'number');
});

test('a transparent retry outside any harness run context journals nothing and still recovers', async () => {
  const session = HarnessSession.create({ kind: 'chat', title: 'codex retry without run context' });
  const model = new ScriptedCodexModel(async function* (attempt) {
    if (attempt === 1) throw buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', { phase: 'headers' });
    yield* successfulTurn('resp_unjournaled_retry');
  });

  const events: StreamEvent[] = [];
  for await (const event of model.getStreamedResponse(modelRequest())) events.push(event);

  assert.equal(model.attempts, 2);
  assert.equal((events.at(-1) as Extract<StreamEvent, { type: 'response_done' }>).response.id, 'resp_unjournaled_retry');
  assert.equal(listEvents(session.id, { types: ['stall_retry_attempted'] }).length, 0);
});

test('CodexResponsesModel retries first-call headers timeout in non-streaming path', async () => {
  const model = new ScriptedCodexModel(async function* (attempt) {
    if (attempt === 1) {
      throw buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', { phase: 'headers' });
    }
    yield* successfulTurn('resp_nonstream_ok');
  });

  const response = await model.getResponse(modelRequest());

  assert.equal(model.attempts, 2);
  assert.equal(response.responseId, 'resp_nonstream_ok');
  assert.equal(response.output.length, 1);
});

test('CodexResponsesModel emits compaction output items when native compaction is enabled', async () => {
  await withNativeCompactionEnv(async () => {
    const model = new ScriptedCodexModel(async function* () {
      yield { type: 'response.created', response: { id: 'resp_compact_done' } };
      yield {
        type: 'response.output_item.done',
        item: {
          id: 'cmp_1',
          type: 'compaction',
          encrypted_content: 'ciphertext',
          created_by: 'server',
          extra: 'kept',
        },
      };
      yield {
        type: 'response.completed',
        response: {
          id: 'resp_compact_done',
          usage: {
            input_tokens: 2,
            output_tokens: 1,
            total_tokens: 3,
            input_tokens_details: {},
            output_tokens_details: {},
          },
        },
      };
    });

    const response = await model.getResponse(modelRequest());
    const item = response.output[0] as unknown as Record<string, unknown>;
    assert.equal(item.type, 'compaction');
    assert.equal(item.id, 'cmp_1');
    assert.equal(item.encrypted_content, 'ciphertext');
    assert.equal(item.created_by, 'server');
    assert.deepEqual(item.providerData, { extra: 'kept' });
  });
});

test('CodexResponsesModel retries compaction-only truncation because nothing tool-visible escaped', async () => {
  await withNativeCompactionEnv(async () => {
    const model = new ScriptedCodexModel(async function* (attempt) {
      if (attempt === 1) {
        yield* compactionOnlyTruncation();
        return;
      }
      yield* successfulTurn('resp_after_compaction_retry');
    });

    const events: StreamEvent[] = [];
    for await (const event of model.getStreamedResponse(modelRequest())) {
      events.push(event);
    }

    assert.equal(model.attempts, 2);
    assert.deepEqual(events.map((event) => event.type), [
      'response_started',
      'output_text_delta',
      'response_done',
    ]);
    const done = events.at(-1) as Extract<StreamEvent, { type: 'response_done' }>;
    assert.equal(done.response.id, 'resp_after_compaction_retry');
  });
});

test('CodexResponsesModel does not retry after a tool call item has escaped retry safety', async () => {
  await withNativeCompactionEnv(async () => {
    const model = new ScriptedCodexModel(async function* () {
      yield* functionCallThenTruncation();
    });

    const events: StreamEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of model.getStreamedResponse(modelRequest())) {
        events.push(event);
      }
    } catch (err) {
      caught = err;
    }

    assert.equal(model.attempts, 1);
    assert.deepEqual(events.map((event) => event.type), ['response_started']);
    assert.ok(caught instanceof BoundaryError);
    assert.equal(caught.kind, 'codex.sse_truncated');
  });
});

// ── SDK protocol conformance for response items ────────────────────────────
// Regression guard for the @openai/agents 0.12 bump (live incident
// 2026-07-03): agents-core validates the response_done payload against its
// zod protocol, and ReasoningItem.content entries must be `input_text`. Our
// converter emitted the raw codex `summary_text` shape, so ANY codex turn
// whose reasoning produced a non-empty summary failed protocol validation
// and dead-ended as the "couldn't be structured" sentinel (trivial turns
// passed only because an empty summary array validates vacuously). These
// tests validate every converter branch against the INSTALLED protocol
// schema, so a future SDK bump that shifts the protocol fails here — in CI —
// instead of live on the user's first real question.
test('convertCodexItemToSdkOutputItem output validates against the installed SDK protocol', async (t) => {
  const { protocol } = await import('@openai/agents-core');
  const { convertCodexItemToSdkOutputItem } = await import('./codex-model.js');
  const check = (label: string, item: Record<string, unknown>) => {
    const converted = convertCodexItemToSdkOutputItem(item as never);
    const parsed = protocol.OutputModelItem.safeParse(converted);
    assert.ok(
      parsed.success,
      `${label} failed protocol validation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`,
    );
  };

  await t.test('reasoning item with a NON-EMPTY summary (the 0.12 killer case)', () => {
    check('reasoning', {
      id: 'rs_1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Considering how to query salesforce.' }],
      encrypted_content: 'gAAAA-opaque',
    });
  });

  await t.test('reasoning item with an empty summary', () => {
    check('reasoning-empty', { id: 'rs_2', type: 'reasoning', summary: [], encrypted_content: 'gAAAA' });
  });

  await t.test('assistant message with output_text + annotations', () => {
    check('message', {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '{"reply":"hi"}', annotations: [], logprobs: [] }],
    });
  });

  await t.test('function call', () => {
    check('function_call', {
      id: 'fc_1',
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup_accounts',
      arguments: '{"days":10}',
      status: 'completed',
    });
  });
});


test('Codex provider construction and production request serialization preserve registry-known selected IDs', () => {
  const request = modelRequest([{ role: 'user', content: 'Check the exact selected model.' }]);
  for (const id of ['gpt-5.6-terra', 'gpt-6', 'gpt-7-review-fixture', 'codex-review-fixture', 'o3']) {
    assert.equal(resolveProvider(id), 'codex', 'the production registry owns the wire classification');
    const model = new CodexModelProvider().getModel(id);
    assert.ok(model instanceof CodexResponsesModel);
    assert.equal(model.modelId, id, 'construction must not silently substitute a default');
    const wire = JSON.parse(JSON.stringify(buildCodexRequestBody(model.modelId, request)));
    assert.equal(wire.model, id, 'the same production serializer used by fetch must retain the selected ID');
    assert.equal(buildCodexRequestBody(id, request).model, id, 'direct serialization must not remap either');
    assert.equal(wire.store, false);
    assert.equal(wire.stream, true);
  }
});

test('Codex construction and serialization retain the documented fallback for unknown or other-provider IDs', () => {
  const request = modelRequest([{ role: 'user', content: 'No arbitrary model passthrough.' }]);
  for (const id of ['', 'not-a-registered-model', 'claude-sonnet-5', 'grok-4.6']) {
    assert.notEqual(resolveProvider(id), 'codex');
    const model = new CodexModelProvider().getModel(id);
    assert.ok(model instanceof CodexResponsesModel);
    assert.equal(model.modelId, 'gpt-5.4');
    assert.equal(buildCodexRequestBody(model.modelId, request).model, 'gpt-5.4');
    assert.equal(buildCodexRequestBody(id, request).model, 'gpt-5.4');
  }
});

async function* failedResponse(code: string, message: string): AsyncGenerator<any> {
  yield { type: 'response.created', response: { id: 'resp_failed' } };
  yield { type: 'response.in_progress', response: { id: 'resp_failed' } };
  yield { type: 'response.failed', response: { id: 'resp_failed', status: 'failed', error: { code, message } } };
}

test('a response the backend failed as too large is not replayed, and its stated reason survives', async () => {
  for (const path of ['getResponse', 'getStreamedResponse'] as const) {
    const model = new ScriptedCodexModel(async function* () {
      yield* failedResponse('context_length_exceeded', 'Your input exceeds the context window of this model.');
    });
    const run = async () => {
      if (path === 'getResponse') return model.getResponse(modelRequest());
      for await (const _event of model.getStreamedResponse(modelRequest())) { /* drain */ }
      return undefined;
    };
    await assert.rejects(run, (error: unknown) => {
      assert.equal((error as { kind?: string }).kind, 'codex.http_4xx', path);
      assert.equal((error as { retryable?: boolean }).retryable, false);
      assert.match(String((error as { operatorMessage?: string }).operatorMessage), /context_length_exceeded/);
      return true;
    });
    assert.equal(model.attempts, 1, `${path}: an identical oversized request is sent once`);
  }
});

test('a transient backend failure is still replayed and names what the backend said', async () => {
  const model = new ScriptedCodexModel(async function* (attempt) {
    if (attempt === 1) {
      yield* failedResponse('server_error', 'The server had an error while processing your request.');
      return;
    }
    yield* successfulTurn('resp_after_server_error');
  });
  const response = await model.getResponse(modelRequest());
  assert.equal(model.attempts, 2);
  assert.equal(response.responseId, 'resp_after_server_error');
});

const usageModule = await import('../usage-log.js');
const observationModule = await import('./resilient-model.js');
const responseBindingModule = await import('./model-response-binding.js');
const transportObservationModule = await import('./model-transport-observation.js');

function capturedCodexFixture<T>(sessionId: string, sourceUserSeq: number, sink: unknown[], work: () => T): T {
  return usageModule.withModelUsageAttribution({ sessionId, sourceUserSeq, attemptId: `attempt:${sessionId}`, role: 'brain', channel: 'chat' }, () =>
    harnessRunContextStorage.run({ sessionId, sourceUserSeq, runAttemptId: `attempt:${sessionId}`, turn: 1 } as never, () =>
      transportObservationModule.withModelTransportRecorder(e => sink.push(e), work)));
}
async function collectCodexStream(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []; for await (const event of iterable) events.push(event); return events;
}
function completedSdkStream(events: StreamEvent[]): object {
  return (events.find(e => e.type === 'response_done') as unknown as { response: object }).response;
}

test('Codex native lazy stream preserves public A owner/observer while B drains it without copied tool authority', async () => {
  const a: any[] = [], b: any[] = [], observerA: any[] = [], observerB: any[] = [];
  let providerContext: unknown;
  const model = new ScriptedCodexModel(async function* () {
    providerContext = harnessRunContextStorage.getStore()?.sessionId;
    yield* successfulTurn('resp_lazy_public_a');
  });
  const stream = capturedCodexFixture('sess-native-lazy-a', 711, a, () =>
    observationModule.withModelResilienceTelemetry(e => observerA.push(e), () => model.getStreamedResponse(modelRequest())));
  assert.equal(model.attempts, 0); assert.equal(a.length, 0); assert.equal(observerA.length, 0);
  const events = await capturedCodexFixture('sess-native-drainer-b', 712, b, () =>
    observationModule.withModelResilienceTelemetry(e => observerB.push(e), () => collectCodexStream(stream)));
  assert.equal(providerContext, 'sess-native-drainer-b', 'execution ALS is never recreated from accounting capture');
  assert.equal(observerB.length, 0); assert.equal(b.length, 0);
  const original = completedSdkStream(events);
  const binding = responseBindingModule.completedModelResponseBinding(original)!;
  assert.ok(binding); assert.equal(binding.physicalAttempt, 1);
  assert.notEqual(binding.modelCallId, 'resp_lazy_public_a');
  assert.equal(observerA.find(e => e.type === 'response_observed')?.callId, binding.modelCallId);
  assert.ok(a.every(e => e.sourceUserSeq === 711 && e.modelCallId === binding.modelCallId));
  assert.equal(a.at(-1).phase, 'adapter_attempt_finished'); assert.equal(a.at(-1).resultScope, 'original_sdk_response');
  const row = usageModule.readUsageEventsForDate().find(r => r.responseId === 'resp_lazy_public_a')!;
  assert.equal(row.source, 'sess-native-lazy-a'); assert.equal(row.trace?.acceptedSource, 'sess-native-lazy-a:711');
  assert.equal(row.trace?.modelCallId, binding.modelCallId); assert.equal(row.trace?.attemptId, 'attempt:sess-native-lazy-a');
  assert.equal(row.requestModel, undefined, 'scripted protected stream never observed an outgoing wire body');
  assert.equal(row.providerReportedModel, undefined, 'absence stays unknown');
  assert.equal(responseBindingModule.completedModelResponseBinding({ ...original }), undefined);
});

test('Codex initially unowned lazy response never adopts later source/workflow/parent or response-ID alias', async () => {
  const stream = new ScriptedCodexModel(async function* () { yield* successfulTurn('resp_native_initially_unowned'); })
    .getStreamedResponse(modelRequest());
  const late: any[] = [];
  await capturedCodexFixture('sess-native-too-late', 713, late, () => collectCodexStream(stream));
  assert.equal(late.length, 0);
  const row = usageModule.readUsageEventsForDate().find(r => r.responseId === 'resp_native_initially_unowned')!;
  assert.equal(row.source, 'unknown'); assert.equal(row.trace?.acceptedSource, undefined);
  assert.notEqual(row.trace?.modelCallId, row.responseId); assert.ok(row.trace?.modelCallId);
  assert.equal(row.inputTokens, 1); assert.equal(row.outputTokens, 1); assert.equal(row.role, undefined);
});

test('concurrent native invocations use two local UUIDs for the same provider response ID and retain token parity', async () => {
  const model = new ScriptedCodexModel(async function* () { await Promise.resolve(); yield* successfulTurn('resp_shared_provider_id'); });
  const journals: any[][] = [[], []];
  const responses = await Promise.all(journals.map((journal, i) => capturedCodexFixture(`sess-native-concurrent-${i}`, 720 + i, journal,
    () => i === 0 ? model.getResponse(modelRequest()) : collectCodexStream(model.getStreamedResponse(modelRequest()))
      .then(completedSdkStream))));
  const proofs = responses.map(responseBindingModule.completedModelResponseBinding);
  assert.ok(proofs.every(Boolean)); assert.notEqual(proofs[0]!.modelCallId, proofs[1]!.modelCallId);
  const rows = usageModule.readUsageEventsForDate().filter(r => r.responseId === 'resp_shared_provider_id');
  assert.equal(rows.length, 2); assert.deepEqual(rows.map(r => [r.inputTokens, r.outputTokens, r.totalTokens]), [[1, 1, 2], [1, 1, 2]]);
  assert.equal(new Set(rows.map(r => r.trace?.modelCallId)).size, 2);
});

test('multiple closing envelopes retain buffered first-usage/last-output and streaming last-usage but no original/model proof', async () => {
  const script = async function* () {
    for await (const event of successfulTurn('resp_multiple_closing')) {
      if (event.type === 'response.completed') {
        event.response.model = 'gpt-first'; event.response.usage.input_tokens = 9; event.response.usage.output_tokens = 3;
        yield event;
        yield { type: 'response.done', response: { id: 'resp_multiple_closing', model: 'gpt-last', usage: { input_tokens: 13, output_tokens: 5, total_tokens: 18 } } };
      } else yield event;
    }
  };
  const model = new ScriptedCodexModel(script);
  const buffered = await model.getResponse(modelRequest());
  const streamed = completedSdkStream(await collectCodexStream(model.getStreamedResponse(modelRequest())));
  assert.equal(buffered.usage.inputTokens, 13);
  assert.equal(responseBindingModule.completedModelResponseBinding(buffered), undefined);
  assert.equal(responseBindingModule.completedModelResponseBinding(streamed), undefined);
  const rows = usageModule.readUsageEventsForDate().filter(r => r.responseId === 'resp_multiple_closing');
  assert.deepEqual(rows.map(r => [r.inputTokens, r.outputTokens]), [[9, 3], [13, 5]]);
  assert.ok(rows.every(r => r.providerReportedModel === undefined));
});

test('completed envelope reported model is inert exact evidence; hostile getters and missing values remain unknown', async () => {
  let hooks = 0;
  for (const shape of ['reported', 'getter', 'missing'] as const) {
    const model = new ScriptedCodexModel(async function* () {
      for await (const event of successfulTurn(`resp_model_${shape}`)) {
        if (event.type === 'response.completed') {
          if (shape === 'reported') event.response.model = 'gpt-reported-exact';
          if (shape === 'getter') Object.defineProperty(event.response, 'model', { enumerable: true, get() { hooks++; throw new Error('model accessor'); } });
        }
        yield event;
      }
    });
    const response = await model.getResponse(modelRequest());
    if (shape === 'getter') assert.equal(responseBindingModule.completedModelResponseBinding(response), undefined);
    else assert.ok(responseBindingModule.completedModelResponseBinding(response));
    const row = usageModule.readUsageEventsForDate().find(r => r.responseId === `resp_model_${shape}`)!;
    assert.equal(row.providerReportedModel, shape === 'reported' ? 'gpt-reported-exact' : undefined);
  }
  assert.equal(hooks, 0);
});

test('native retries keep one public UUID, distinct adapter ordinals and original retry-journal owner', async () => {
  const a = HarnessSession.create({ kind: 'chat', title: 'native owner A' }), b = HarnessSession.create({ kind: 'chat', title: 'native owner B' }); const journal: any[] = [];
  const model = new ScriptedCodexModel(async function* (attempt) {
    if (attempt === 1) throw buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', { modelId: 'gpt-5.5', phase: 'headers' });
    yield* successfulTurn('resp_native_after_retry');
  });
  const stream = capturedCodexFixture(a.id, 730, journal, () => model.getStreamedResponse(modelRequest()));
  const response = completedSdkStream(await capturedCodexFixture(b.id, 731, [], () => collectCodexStream(stream)));
  const proof = responseBindingModule.completedModelResponseBinding(response)!;
  assert.equal(proof.physicalAttempt, 2); assert.equal(model.attempts, 2);
  assert.deepEqual(journal.filter(e => e.phase === 'adapter_attempt_created').map(e => e.physicalAttempt), [1, 2]);
  assert.equal(new Set(journal.map(e => e.modelCallId)).size, 1);
  assert.equal(listEvents(a.id, { types: ['stall_retry_attempted'] }).length, 1);
  assert.equal(listEvents(b.id, { types: ['stall_retry_attempted'] }).length, 0);
});

test('cancellation after numeric usage before response yield preserves usage/output but cannot mint an original proof', async () => {
  const controller = new AbortController(); const telemetry: any[] = [];
  const sink: import('../usage-log.js').ObservedModelUsage[] = [];
  sink.push = (...rows) => { controller.abort(); return Array.prototype.push.apply(sink, rows); };
  const model = new ScriptedCodexModel(async function* () { yield* successfulTurn('resp_cancel_after_usage'); });
  const events = await usageModule.withModelUsageObserver(sink, () => observationModule.withModelResilienceTelemetry(e => telemetry.push(e),
    () => collectCodexStream(model.getStreamedResponse({ ...modelRequest(), signal: controller.signal }))));
  assert.equal(events.at(-1)?.type, 'response_done', 'old yielded result remains unchanged');
  assert.equal(sink.length, 1); assert.equal(sink[0].inputTokens, 1);
  assert.equal(responseBindingModule.completedModelResponseBinding(completedSdkStream(events)), undefined);
  assert.equal(telemetry.find(e => e.type === 'response_observed'), undefined);
  assert.equal(telemetry.at(-1).outcome, 'cancelled');
});

test('native observer exceptions/rejections cannot alter provider events/results or retry counts', async () => {
  for (const kind of ['throw', 'reject'] as const) {
    const model = new ScriptedCodexModel(async function* () { yield* successfulTurn(`resp_hostile_observer_${kind}`); });
    const events = await observationModule.withModelResilienceTelemetry(() => {
      if (kind === 'throw') throw new Error('observer failure');
      return Promise.reject(new Error('async observer failure')) as never;
    }, () => collectCodexStream(model.getStreamedResponse(modelRequest())));
    assert.equal(events.at(-1)?.type, 'response_done'); assert.equal(model.attempts, 1);
    assert.ok(responseBindingModule.completedModelResponseBinding(completedSdkStream(events)));
  }
  await Promise.resolve();
});

interface CapturedCodexWire {
  body: Record<string, unknown>;
  headers: Headers;
  executionSessionId: string | undefined;
}

async function successfulCodexWireResponse(responseId: string): Promise<Response> {
  const events: any[] = [];
  for await (const event of successfulTurn(responseId)) events.push(event);
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
}

async function withMockedCodexWire(
  respond: (wire: CapturedCodexWire, ordinal: number) => Promise<Response> | Response,
  work: (calls: CapturedCodexWire[], refreshCount: () => number) => Promise<void>,
): Promise<void> {
  const { BASE_DIR } = await import('../../config.js');
  const { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } = await import('node:fs');
  const path = await import('node:path');
  const auth = await import('../auth-store.js');
  assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
  const authPath = path.join(BASE_DIR, 'state', 'auth.json');
  const prior = existsSync(authPath) ? readFileSync(authPath) : undefined;
  const priorFetch = globalThis.fetch;
  const priorDisabled = process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
  const token = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`;
  const grant = { accessToken: token, refreshToken: 'fixture-refresh', accountId: 'fixture-account', lastRefresh: new Date().toISOString() };
  mkdirSync(path.dirname(authPath), { recursive: true });
  writeFileSync(authPath, JSON.stringify({ source: 'native', codexOauth: grant }));
  const calls: CapturedCodexWire[] = [];
  let refreshes = 0;
  auth.__setRefreshTokenImplForTests(async () => { refreshes++; return { ...grant, idToken: 'fixture-id' }; });
  globalThis.fetch = async (_url, init) => {
    const wire = { body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers),
      executionSessionId: harnessRunContextStorage.getStore()?.sessionId };
    calls.push(wire);
    return respond(wire, calls.length);
  };
  // No network or developer credential is available: only this injected fetch
  // and the disposable home's fixture OAuth grant can serve the transport.
  delete process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
  try { await work(calls, () => refreshes); }
  finally {
    globalThis.fetch = priorFetch;
    auth.__setRefreshTokenImplForTests(null);
    if (priorDisabled === undefined) delete process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
    else process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = priorDisabled;
    if (prior) writeFileSync(authPath, prior); else rmSync(authPath, { force: true });
  }
}

for (const mode of ['success', 'adapter retry', 'OAuth retry'] as const) {
  test(`actual Codex wire keeps A cache body and headers when B drains its lazy stream (${mode})`, async () => {
    const responseId = `resp_cache_owner_${mode.replaceAll(' ', '_')}`;
    await withMockedCodexWire((_wire, ordinal) => {
      if (ordinal === 1 && mode === 'adapter retry') throw buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', { phase: 'headers' });
      if (ordinal === 1 && mode === 'OAuth retry') return new Response('', { status: 401 });
      return successfulCodexWireResponse(responseId);
    }, async (calls, refreshCount) => {
      const request = { ...modelRequest(), systemInstructions: `Cache role${INSTRUCTION_CACHE_DELIM}Current context` } as ModelRequest;
      const a: any[] = [], b: any[] = [];
      const keyA = capturedCodexFixture('sess-cache-wire-a', 761, [], () => buildCodexRequestBody('gpt-5.5', request).prompt_cache_key);
      const keyB = capturedCodexFixture('sess-cache-wire-b', 762, [], () => buildCodexRequestBody('gpt-5.5', request).prompt_cache_key);
      assert.notEqual(keyA, keyB);
      const stream = capturedCodexFixture('sess-cache-wire-a', 761, a, () => new CodexResponsesModel('gpt-5.5').getStreamedResponse(request));
      assert.equal(calls.length, 0, 'the public call does not eagerly dispatch a lazy stream');
      const events = await capturedCodexFixture('sess-cache-wire-b', 762, b, () => collectCodexStream(stream));
      assert.equal(calls.length, mode === 'success' ? 1 : 2);
      assert.equal(refreshCount(), mode === 'OAuth retry' ? 1 : 0);
      for (const call of calls) {
        assert.equal(call.executionSessionId, 'sess-cache-wire-b', 'routing ownership never restores A execution authority');
        assert.equal(call.body.prompt_cache_key, keyA);
        assert.equal(call.headers.get('session_id'), keyA);
        assert.equal(call.headers.get('conversation_id'), keyA);
      }
      assert.equal(b.length, 0, 'the drainer must not acquire source accounting');
      assert.ok(a.every(event => event.sourceUserSeq === 761));
      const binding = responseBindingModule.completedModelResponseBinding(completedSdkStream(events))!;
      assert.equal(binding.physicalAttempt, mode === 'adapter retry' ? 2 : 1);
      const usage = usageModule.readUsageEventsForDate().find(row => row.responseId === responseId)!;
      assert.equal(usage.source, 'sess-cache-wire-a');
      assert.equal(usage.trace?.acceptedSource, 'sess-cache-wire-a:761');
      assert.equal(usage.trace?.modelCallId, binding.modelCallId);
    });
  });
}

test('actual initially unowned Codex wire keeps its role-only cache key when B drains it', async () => {
  await withMockedCodexWire(() => successfulCodexWireResponse('resp_cache_wire_unowned'), async calls => {
    const request = modelRequest();
    const unownedKey = buildCodexRequestBody('gpt-5.5', request).prompt_cache_key;
    const laterKey = capturedCodexFixture('sess-cache-wire-late-b', 763, [], () => buildCodexRequestBody('gpt-5.5', request).prompt_cache_key);
    assert.notEqual(unownedKey, laterKey);
    const stream = new CodexResponsesModel('gpt-5.5').getStreamedResponse(request);
    const late: any[] = [];
    await capturedCodexFixture('sess-cache-wire-late-b', 763, late, () => collectCodexStream(stream));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executionSessionId, 'sess-cache-wire-late-b');
    assert.equal(calls[0].body.prompt_cache_key, unownedKey);
    assert.equal(calls[0].headers.get('session_id'), unownedKey);
    assert.equal(calls[0].headers.get('conversation_id'), unownedKey);
    assert.equal(late.length, 0);
    const usage = usageModule.readUsageEventsForDate().find(row => row.responseId === 'resp_cache_wire_unowned')!;
    assert.equal(usage.source, 'unknown');
    assert.equal(usage.trace?.acceptedSource, undefined);
  });
});

test('actual buffered Codex wire keeps its invocation key across a mutated caller and adapter retry', async () => {
  await withMockedCodexWire((_wire, ordinal) => {
    if (ordinal === 1) {
      harnessRunContextStorage.getStore()!.sessionId = 'sess-cache-buffered-mutated-b';
      throw buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', { phase: 'headers' });
    }
    return successfulCodexWireResponse('resp_cache_wire_buffered');
  }, async calls => {
    const request = modelRequest();
    const keyA = capturedCodexFixture('sess-cache-buffered-a', 764, [], () => buildCodexRequestBody('gpt-5.5', request).prompt_cache_key);
    const journal: any[] = [];
    await capturedCodexFixture('sess-cache-buffered-a', 764, journal, () => new CodexResponsesModel('gpt-5.5').getResponse(request));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.executionSessionId), ['sess-cache-buffered-a', 'sess-cache-buffered-mutated-b']);
    for (const call of calls) {
      assert.equal(call.body.prompt_cache_key, keyA);
      assert.equal(call.headers.get('session_id'), keyA);
      assert.equal(call.headers.get('conversation_id'), keyA);
    }
    assert.ok(journal.every(event => event.sourceUserSeq === 764));
    const usage = usageModule.readUsageEventsForDate().find(row => row.responseId === 'resp_cache_wire_buffered')!;
    assert.equal(usage.source, 'sess-cache-buffered-a');
    assert.equal(usage.trace?.acceptedSource, 'sess-cache-buffered-a:764');
  });
});

test('actual native stream records resolved outgoing body.model and one adapter ordinal across an inner 401 refresh', async () => {
  const { BASE_DIR } = await import('../../config.js');
  const { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } = await import('node:fs');
  const path = await import('node:path');
  const auth = await import('../auth-store.js');
  assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
  const authPath = path.join(BASE_DIR, 'state', 'auth.json');
  const prior = existsSync(authPath) ? readFileSync(authPath) : undefined;
  const priorFetch = globalThis.fetch; const priorDisabled = process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
  const token = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`;
  const grant = { accessToken: token, refreshToken: 'fixture-refresh', accountId: 'fixture-account', lastRefresh: new Date().toISOString() };
  mkdirSync(path.dirname(authPath), { recursive: true });
  writeFileSync(authPath, JSON.stringify({ source: 'native', codexOauth: grant }));
  let refreshes = 0; const bodies: any[] = []; const journal: any[] = [];
  auth.__setRefreshTokenImplForTests(async () => { refreshes++; return { ...grant, idToken: 'fixture-id' }; });
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return new Response('', { status: 401 });
    const events: any[] = [];
    for await (const event of successfulTurn('resp_actual_body_model')) {
      if (event.type === 'response.completed') event.response.model = 'gpt-provider-reported';
      events.push(event);
    }
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
  };
  // Only the injected fetch above can run while this existing edge is enabled;
  // no developer credential or network transport is available in this fixture.
  delete process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
  try {
    const model = new CodexResponsesModel('fixture-model-label');
    const response = await capturedCodexFixture('sess-native-real-body', 750, journal, () => model.getResponse(modelRequest()));
    const row = usageModule.readUsageEventsForDate().find(r => r.responseId === 'resp_actual_body_model')!;
    assert.equal(bodies.length, 2); assert.equal(refreshes, 1); assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(row.requestModel, bodies[0].model); assert.notEqual(row.requestModel, 'fixture-model-label');
    assert.equal(row.model, 'fixture-model-label'); assert.equal(row.providerReportedModel, 'gpt-provider-reported');
    assert.equal(journal.filter(e => e.phase === 'adapter_attempt_created').length, 1, 'inner fetch retries are not adapter ordinals');
    assert.equal(responseBindingModule.completedModelResponseBinding(response)?.physicalAttempt, 1);
  } finally {
    globalThis.fetch = priorFetch; auth.__setRefreshTokenImplForTests(null);
    if (priorDisabled === undefined) delete process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
    else process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = priorDisabled;
    if (prior) writeFileSync(authPath, prior); else rmSync(authPath, { force: true });
  }
});


test('optional closing ID/model provenance never invokes getters on old successful buffered or streamed replies', async () => {
  for (const path of ['buffered', 'streamed'] as const) {
    for (const field of ['id', 'model'] as const) {
      let hooks = 0; let closing: any;
      const responseId = `resp_inert_closing_${path}_${field}`;
      const model = new ScriptedCodexModel(async function* () {
        for await (const event of successfulTurn(responseId)) {
          if (event.type === 'response.completed') {
            closing = event.response;
            event.response.model = 'gpt-reported-unused';
            Object.defineProperty(event.response, field, { enumerable: true, get() { hooks++; throw new Error('unused metadata accessor'); } });
          }
          yield event;
        }
      });
      const response = path === 'buffered' ? await model.getResponse(modelRequest())
        : completedSdkStream(await collectCodexStream(model.getStreamedResponse(modelRequest())));
      assert.equal(hooks, 0, 'metadata observation must not add formerly short-circuited property reads');
      assert.equal((response as any).providerData, closing, 'raw original provider data remains unchanged');
      assert.equal((response as any).output.length, 1);
      assert.equal((response as any).usage.inputTokens, 1);
      const row = usageModule.readUsageEventsForDate().find(r => r.responseId === responseId)!;
      assert.equal(row.inputTokens, 1); assert.equal(row.outputTokens, 1);
      assert.equal(row.providerReportedModel, undefined);
      assert.equal(responseBindingModule.completedModelResponseBinding(response), undefined);
    }
  }
});


test('optional closing metadata declines proxy envelopes without newly invoking model or descriptor traps', async () => {
  for (const path of ['buffered', 'streamed'] as const) {
    let addedHooks = 0; let envelope: any;
    const responseId = `resp_proxy_closing_${path}`;
    const model = new ScriptedCodexModel(async function* () {
      for await (const event of successfulTurn(responseId)) {
        if (event.type === 'response.completed') {
          envelope = new Proxy(event.response, {
            get(target, key, receiver) { if (key === 'model') { addedHooks++; throw new Error('new model trap'); } return Reflect.get(target, key, receiver); },
            getOwnPropertyDescriptor() { addedHooks++; throw new Error('new metadata descriptor trap'); },
          });
          event.response = envelope;
        }
        yield event;
      }
    });
    const response = path === 'buffered' ? await model.getResponse(modelRequest())
      : completedSdkStream(await collectCodexStream(model.getStreamedResponse(modelRequest())));
    assert.equal(addedHooks, 0); assert.equal((response as any).providerData, envelope);
    assert.equal(responseBindingModule.completedModelResponseBinding(response), undefined);
    const row = usageModule.readUsageEventsForDate().find(r => r.responseId === responseId)!;
    assert.equal(row.inputTokens, 1); assert.equal(row.providerReportedModel, undefined);
  }
});


test('streamed no-created completion keeps old closing ID and envelope getter read counts and order', async () => {
  for (const shape of ['id_accessor', 'envelope_accessor'] as const) {
    let idReads = 0, envelopeReads = 0; const order: string[] = [];
    const responseId = `resp_no_created_${shape}`; let envelope: any;
    const model = new ScriptedCodexModel(async function* () {
      for await (const event of successfulTurn(responseId)) {
        if (event.type === 'response.created') continue;
        if (event.type === 'response.completed') {
          envelope = event.response;
          envelope.model = 'gpt-reported-otherwise';
          Object.defineProperty(envelope, 'id', { enumerable: true, get() {
            idReads++; order.push('id');
            if (idReads > 2) throw new Error('third closing ID read changes old success');
            return responseId;
          } });
          if (shape === 'envelope_accessor') Object.defineProperty(event, 'response', { enumerable: true, get() {
            envelopeReads++; order.push('envelope');
            if (envelopeReads > 4) throw new Error('fifth envelope read changes old success');
            return envelope;
          } });
        }
        yield event;
      }
    });
    const response = completedSdkStream(await collectCodexStream(model.getStreamedResponse(modelRequest()))) as any;
    assert.equal(response.id, responseId); assert.equal(response.providerData, envelope);
    assert.equal(response.output.length, 1); assert.equal(response.usage.inputTokens, 1);
    assert.equal(idReads, 2);
    assert.equal(envelopeReads, shape === 'envelope_accessor' ? 4 : 0);
    assert.deepEqual(order, shape === 'envelope_accessor' ? ['envelope', 'envelope', 'id', 'envelope', 'id', 'envelope'] : ['id', 'id']);
    assert.equal(responseBindingModule.completedModelResponseBinding(response), undefined);
    const row = usageModule.readUsageEventsForDate().find(r => r.responseId === responseId)!;
    assert.equal(row.inputTokens, 1); assert.equal(row.outputTokens, 1);
    assert.equal(row.providerReportedModel, undefined);
  }
});

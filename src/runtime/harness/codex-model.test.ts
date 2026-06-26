import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRequest } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { buildCodexRequestBody, CodexResponsesModel } from './codex-model.js';
import { BoundaryError } from '../boundary-error.js';
import { buildTransportTimeoutError, detectCodexTransportFailure } from '../codex-dispatcher.js';

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

test('CodexResponsesModel passes an empty completion through unchanged when the kill-switch is off', async () => {
  process.env.CLEMMY_CODEX_RETRY_EMPTY_COMPLETION = 'off';
  try {
    const model = new ScriptedCodexModel(async function* () {
      yield* emptyCompletion('resp_legacy_empty');
    });
    const events: StreamEvent[] = [];
    for await (const event of model.getStreamedResponse(modelRequest())) {
      events.push(event);
    }
    assert.equal(model.attempts, 1); // legacy: no retry
    const done = events.at(-1) as Extract<StreamEvent, { type: 'response_done' }>;
    assert.equal(done.type, 'response_done');
    assert.deepEqual(done.response.output, []); // empty, as before
  } finally {
    delete process.env.CLEMMY_CODEX_RETRY_EMPTY_COMPLETION;
  }
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

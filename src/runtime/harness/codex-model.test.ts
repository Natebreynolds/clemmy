import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRequest } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { CodexResponsesModel } from './codex-model.js';
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

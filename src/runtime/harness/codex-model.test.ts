import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRequest } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { CodexResponsesModel } from './codex-model.js';
import { BoundaryError } from '../boundary-error.js';
import { buildTransportTimeoutError } from '../codex-dispatcher.js';

process.env.NODE_ENV = 'test';
process.env.CLEMMY_CODEX_TRANSPARENT_RETRY_DELAY_MS = '0';

test.after(() => {
  delete process.env.CLEMMY_CODEX_TRANSPARENT_RETRY_DELAY_MS;
});

type ScriptedAttempt = (attempt: number) => AsyncGenerator<any>;

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

test('CodexResponsesModel retries first-call headers timeout before streaming content', async () => {
  const model = new ScriptedCodexModel(async function* (attempt) {
    if (attempt === 1) {
      throw buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', { phase: 'headers' });
    }
    yield* successfulTurn('resp_retry_ok');
  });

  const events: StreamEvent[] = [];
  for await (const event of model.getStreamedResponse({} as ModelRequest)) {
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

test('CodexResponsesModel does not retry transport timeout after content was yielded', async () => {
  const model = new ScriptedCodexModel(async function* () {
    yield { type: 'response.created', response: { id: 'resp_partial' } };
    yield { type: 'response.output_text.delta', delta: 'partial', sequence_number: 1 };
    throw buildTransportTimeoutError('UND_ERR_BODY_TIMEOUT', { phase: 'body' });
  });

  const events: StreamEvent[] = [];
  let caught: unknown;
  try {
    for await (const event of model.getStreamedResponse({} as ModelRequest)) {
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

  const response = await model.getResponse({} as ModelRequest);

  assert.equal(model.attempts, 2);
  assert.equal(response.responseId, 'resp_nonstream_ok');
  assert.equal(response.output.length, 1);
});

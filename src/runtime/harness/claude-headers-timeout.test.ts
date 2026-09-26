/**
 * A buffered Claude response sends its headers only when the whole answer is
 * written. A 30-second headers bound aborted every buffered answer that needed
 * longer, and the transparent retry began it again from nothing, until the
 * caller's own deadline expired with no answer at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { createAnthropic } from '@ai-sdk/anthropic';
import { claudeHeadersTimeoutMs } from './claude-model.js';

test('a streamed request keeps the short headers bound; a buffered one waits for its whole answer', () => {
  assert.equal(claudeHeadersTimeoutMs(JSON.stringify({ model: 'm', stream: true, messages: [] })), 30_000);
  assert.equal(claudeHeadersTimeoutMs(JSON.stringify({ model: 'm', messages: [] })), 300_000);
  assert.equal(claudeHeadersTimeoutMs(JSON.stringify({ model: 'm', stream: false, messages: [] })), 300_000);
  assert.equal(claudeHeadersTimeoutMs(undefined), 30_000, 'an unreadable body keeps the short bound');
  assert.equal(claudeHeadersTimeoutMs('not json'), 30_000);
});

test('the SDK marks a streamed request and leaves a buffered one unmarked', async () => {
  const bodies: string[] = [];
  const provider = createAnthropic({
    apiKey: 'test-key',
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body));
      const streamed = JSON.parse(String(init?.body)).stream === true;
      if (streamed) {
        const events = [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join('');
        return new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const model = provider('claude-sonnet-5');
  const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];
  await model.doGenerate({ prompt, maxOutputTokens: 16 } as never);
  const streamed = await model.doStream({ prompt, maxOutputTokens: 16 } as never);
  for await (const _part of streamed.stream as AsyncIterable<unknown>) { /* drain */ }
  assert.equal(claudeHeadersTimeoutMs(bodies[0]), 300_000, 'a buffered review is not cut off before it is written');
  assert.equal(claudeHeadersTimeoutMs(bodies[1]), 30_000, 'a streamed request still fails fast when nothing starts');
});

test('a headers bound shorter than the answer aborts it; a bound that covers it lets it land', async () => {
  const server = http.createServer((_req, res) => {
    // A buffered answer: nothing is sent until it is complete.
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, 3_000);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
  try {
    // undici checks these timers about once a second, so the gap is generous.
    const tooShort = new Agent({ headersTimeout: 1_000, bodyTimeout: 10_000 });
    await assert.rejects(undiciFetch(url, { method: 'POST', body: '{}', dispatcher: tooShort }),
      (error: unknown) => String((error as { cause?: { code?: string } })?.cause?.code) === 'UND_ERR_HEADERS_TIMEOUT');
    const covering = new Agent({ headersTimeout: 10_000, bodyTimeout: 10_000 });
    const res = await undiciFetch(url, { method: 'POST', body: '{}', dispatcher: covering });
    assert.deepEqual(await res.json(), { ok: true });
    await tooShort.close();
    await covering.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/traceless-byo-step.test.ts
 *
 * ADAPTER SEAM (live 2026-08-19 sess-desktop-3ec55…, grok-4.6, byo): the
 * FIRST host step of any turn died `run_failed "No existing trace found"`,
 * tokens_used=0. Root cause: the host turn loop calls `model.getResponse`
 * with no Agents Runner and therefore no ambient trace context, and the SDK's
 * `OpenAIChatCompletionsModel.getResponse` unconditionally enters
 * `withGenerationSpan → setCurrentSpan`, which throws outside a trace.
 *
 * These pins drive a REAL OpenAIChatCompletionsModel (fake SSE transport, no
 * network) exactly the way codexOneStep/hostRunRunner invoke it — bare, no
 * withTrace, no OPENAI_API_KEY — and prove:
 *   - the unwrapped SDK model still throws (the live shape; if the SDK ever
 *     fixes it this control tells us the adapter can retire);
 *   - the host traceless step adapter completes the same call: text, tool
 *     intents, usage, one provider request;
 *   - Runner.run stays unreachable: the host runner completes a step while a
 *     Runner whose .run throws sits in the seam.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-traceless-byo-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { OpenAIChatCompletionsModel } from '@openai/agents-openai';

const { _withTracelessStepForTest } = await import('./byo-model.js');
const { codexOneStep } = await import('./codex-one-step.js');

after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function sseBody(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

/** A grok-shaped chat-completions backend: one text delta + a tool call. */
function fakeFetch(recorder: { requests: number }, shape: 'tool_step' | 'text_only' = 'tool_step'): typeof fetch {
  return (async (_url: unknown, init?: { body?: string }) => {
    recorder.requests += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
    const chunks = [
      {
        id: 'cmpl-grok-1', object: 'chat.completion.chunk', created: 1, model: 'grok-4.6',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'On it — pulling the restaurants now.' }, finish_reason: null }],
      },
      ...(shape === 'tool_step'
        ? [{
            id: 'cmpl-grok-1', object: 'chat.completion.chunk', created: 1, model: 'grok-4.6',
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 'call-search-1', type: 'function', function: { name: 'work_call', arguments: '{"name":"FIRECRAWL_SEARCH"}' } }] },
              finish_reason: null,
            }],
          }]
        : []),
      {
        id: 'cmpl-grok-1', object: 'chat.completion.chunk', created: 1, model: 'grok-4.6',
        choices: [{ index: 0, delta: {}, finish_reason: shape === 'tool_step' ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      },
    ];
    if (!body.stream) {
      // The control (unwrapped getResponse) never reaches fetch — it throws in
      // the tracing layer first. Return a plain completion for completeness.
      return new Response(JSON.stringify({
        id: 'cmpl-grok-1', object: 'chat.completion', created: 1, model: 'grok-4.6',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(sseBody(chunks), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

function realByoModel(
  recorder: { requests: number },
  shape: 'tool_step' | 'text_only' = 'tool_step',
): OpenAIChatCompletionsModel {
  const client = new OpenAI({
    baseURL: 'https://api.x.ai/v1',
    apiKey: 'xai-oauth-bearer-not-an-openai-key',
    fetch: fakeFetch(recorder, shape),
  });
  return new OpenAIChatCompletionsModel(client as never, 'grok-4.6');
}

test('CONTROL — the live shape: bare SDK getResponse outside a trace still throws "No existing trace found"', async () => {
  const recorder = { requests: 0 };
  const model = realByoModel(recorder);
  await assert.rejects(
    model.getResponse({
      input: 'hey hows it going',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    } as never),
    /No existing trace found/,
  );
  assert.equal(recorder.requests, 0, 'the crash precedes the provider request — tokens_used=0, exactly the live ledger');
});

test('the host traceless step completes the same bare call: text, tool intents, usage, ONE provider request', async () => {
  const recorder = { requests: 0 };
  const model = _withTracelessStepForTest(realByoModel(recorder));
  const step = await codexOneStep({
    modelId: 'grok-4.6',
    input: 'Find me the top five Big Bear Lake restaurants and put them in a new Google sheet',
    resolveModel: () => model,
  });
  assert.equal(recorder.requests, 1, 'one getResponse = one provider request');
  assert.match(step.text, /pulling the restaurants/i);
  assert.equal(step.toolCalls.length, 1, 'tool calls stay HOST intents');
  assert.equal(step.toolCalls[0]!.name, 'work_call');
  assert.equal(step.usage?.totalTokens, 19, 'usage flows through the assembled response');
});

test('Runner.run stays unreachable: the host runner steps a turn while Runner.run is a tripwire', async () => {
  const { hostRunRunner } = await import('./host-turn-runner.js');
  const { Agent } = await import('@openai/agents');
  const recorder = { requests: 0 };
  const model = _withTracelessStepForTest(realByoModel(recorder, 'text_only'));
  const runnerTripwire = {
    run: () => { throw new Error('Runner.run must be unreachable on the chat turn'); },
  };
  const agent = new Agent({ name: 'GrokStep', instructions: 'test', model: model as never });
  const outcome = await hostRunRunner(
    runnerTripwire as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'hello there' }] as never,
    { maxTurns: 1 } as never,
  );
  assert.ok(outcome, 'the host runner produced an outcome without Runner.run');
  assert.ok(recorder.requests >= 1, 'the model step actually ran');
});

test('SECOND one-step request after a host-projected tool result completes without "No existing trace found"', async () => {
  const recorder = { requests: 0 };
  // Step 1 returns a tool call; step 2 (AFTER the tool result re-enters the
  // model) returns text. Live, step 2 was the crash: a judge/step model call
  // outside any Runner trace hit the SDK's unconditional span machinery.
  const stepFetch = (async (_url: unknown, _init?: unknown) => {
    recorder.requests += 1;
    const first = recorder.requests === 1;
    const chunks = first
      ? [
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'grok-4.6', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'note_progress', arguments: '{"note":"collected"}' } }] }, finish_reason: null }] },
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'grok-4.6', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ]
      : [
          { id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'grok-4.6', choices: [{ index: 0, delta: { role: 'assistant', content: 'sheet done' }, finish_reason: null }] },
          { id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'grok-4.6', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
    return new Response(sseBody(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const client = new OpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: 'xai-oauth-bearer', fetch: stepFetch });
  const model = _withTracelessStepForTest(new OpenAIChatCompletionsModel(client as never, 'grok-4.6'));
  const serializedTool = {
    type: 'function',
    name: 'note_progress',
    description: 'note',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: ['note'],
      additionalProperties: false,
    },
    strict: true,
  } as const;
  const first = await codexOneStep({
    modelId: 'grok-4.6',
    input: 'collect then finish',
    tools: [serializedTool as never],
    stream: true,
    resolveModel: () => model,
  });
  assert.equal(first.toolCalls.length, 1);
  const call = first.toolCalls[0]!;
  const second = await codexOneStep({
    modelId: 'grok-4.6',
    input: [
      { type: 'message', role: 'user', content: 'collect then finish' },
      ...first.output,
      {
        type: 'function_call_result',
        callId: call.callId,
        name: call.name,
        status: 'completed',
        output: { type: 'text', text: 'noted' },
      },
    ] as never,
    tools: [serializedTool as never],
    stream: true,
    resolveModel: () => model,
  });
  assert.equal(second.text, 'sheet done');
  assert.equal(recorder.requests, 2, 'the SECOND bare getResponse ran — the live crash shape is dead');
});

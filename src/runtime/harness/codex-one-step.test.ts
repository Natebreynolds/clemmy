/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/codex-one-step.test.ts
 *
 * The Codex brain as a NODE RUNNER: one host invocation is exactly one model
 * request; tool calls come back as intents for the HOST; a second step never
 * happens unless the host calls again; a provider limit is data (`limitHit`),
 * never an awaiting_user_input. The model is stubbed — no Codex quota, no
 * OPENAI_API_KEY, no network.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-codex-one-step-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
delete process.env.OPENAI_API_KEY;

const { codexOneStep, admitModelStep, validateOutputFrame } = await import('./codex-one-step.js');
const eventlog = await import('./eventlog.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function stubModel(outputs: unknown[], extra: { providerData?: Record<string, unknown> } = {}) {
  const calls: { requests: unknown[] } = { requests: [] };
  const model = {
    async getResponse(request: unknown) {
      calls.requests.push(request);
      return {
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output: outputs,
        responseId: `resp-${calls.requests.length}`,
        ...(extra.providerData ? { providerData: extra.providerData } : {}),
      };
    },
    async *getStreamedResponse(): AsyncIterable<never> {
      throw new Error('one-step never streams through the Runner');
    },
  };
  return { model, calls };
}

test('one host invocation is exactly one model request', async () => {
  const { model, calls } = stubModel([
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hey there' }] },
  ]);
  const result = await codexOneStep({
    input: 'hey hows it going',
    resolveModel: () => model as never,
  });
  assert.equal(calls.requests.length, 1);
  assert.equal(result.text, 'hey there');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.limitHit, false);
  // A greeting stays a single step — no Runner session, no second request.
  assert.equal(calls.requests.length, 1);
});

test('provider-neutral structured output reaches the configured adapter without widening tool authority', async () => {
  const { model, calls } = stubModel([
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"ok":true}' }] },
  ]);
  const outputType = {
    type: 'json_schema' as const,
    name: 'bounded_candidate',
    strict: true,
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
  };
  await codexOneStep({
    input: 'return the bounded candidate',
    tools: [],
    outputType,
    resolveModel: () => model as never,
  });
  assert.equal(calls.requests.length, 1);
  const request = calls.requests[0] as { outputType: unknown; tools: unknown[]; toolsExplicitlyProvided: boolean };
  assert.deepEqual(request.outputType, outputType);
  assert.deepEqual(request.tools, []);
  assert.equal(request.toolsExplicitlyProvided, true);
});

test('tool calls come back as HOST intents and are never executed here', async () => {
  let toolExecuted = false;
  const { model, calls } = stubModel([
    { type: 'function_call', callId: 'call-1', name: 'work_call', arguments: '{"name":"FIRECRAWL_SEARCH","args_json":"{\\"q\\":\\"x\\"}"}' },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'searching now' }] },
  ]);
  const result = await codexOneStep({
    input: [{ type: 'message', role: 'user', content: 'find firms' } as never],
    tools: [{
      type: 'function',
      name: 'work_call',
      description: 'carrier',
      parameters: { type: 'object', properties: {} },
      strict: false,
    } as never],
    resolveModel: () => model as never,
  });
  void toolExecuted;
  assert.equal(calls.requests.length, 1, 'the model saw ONE request');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, 'work_call');
  assert.match(result.toolCalls[0]?.argumentsJson ?? '', /FIRECRAWL_SEARCH/);
  assert.equal(toolExecuted, false, 'execution belongs to the host');
  // The request carried the host tool list as schemas only.
  const sent = calls.requests[0] as { tools: unknown[]; toolsExplicitlyProvided: boolean };
  assert.equal(sent.tools.length, 1);
  assert.equal(sent.toolsExplicitlyProvided, true);
  // No second model step happened: the host decides whether to call again.
  assert.equal(calls.requests.length, 1);
});

test('a provider limit is limitHit data — never an awaiting_user_input row', async () => {
  const { model } = stubModel(
    [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'partial…' }] }],
    { providerData: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
  );
  const session = eventlog.createSession({ id: 'one-step-limit', kind: 'chat' });
  const result = await codexOneStep({
    input: 'long job',
    resolveModel: () => model as never,
  });
  assert.equal(result.limitHit, true);
  assert.equal(result.text, 'partial…');
  const asks = eventlog.listEvents(session.id, { types: ['awaiting_user_input'] });
  assert.equal(asks.length, 0, 'the pipe never asks the user to continue');
});

test('host-owned continuation: a second step happens only when the host calls again', async () => {
  const { model, calls } = stubModel([
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'step' }] },
  ]);
  await codexOneStep({ input: 'first', resolveModel: () => model as never });
  assert.equal(calls.requests.length, 1);
  await codexOneStep({ input: 'second — the HOST chose this', resolveModel: () => model as never });
  assert.equal(calls.requests.length, 2, 'exactly one more request per host decision');
});

test('streaming normalizes Claude reasoning-only length stops without inventing completion', async () => {
  const activities: string[] = [];
  const model = {
    async getResponse(): Promise<never> { throw new Error('streaming path required'); },
    async *getStreamedResponse() {
      yield { type: 'response_started' } as never;
      yield {
        type: 'model',
        event: { type: 'reasoning-delta', delta: 'private work' },
      } as never;
      yield {
        type: 'model',
        event: { type: 'finish', finishReason: 'length' },
      } as never;
      yield {
        type: 'response_done',
        response: {
          id: 'claude-length',
          usage: { inputTokens: 1, outputTokens: 8, totalTokens: 9 },
          output: [{
            type: 'reasoning',
            content: [{ type: 'input_text', text: 'private work' }],
          }],
        },
      } as never;
    },
  };
  const result = await codexOneStep({
    input: 'analyze deeply',
    stream: true,
    onActivity: (activity) => activities.push(activity),
    resolveModel: () => model as never,
  });
  assert.equal(result.stopReason, 'max_output');
  assert.equal(result.limitHit, true);
  assert.equal(result.text, '');
  assert.deepEqual(result.toolCalls, []);
  assert.ok(activities.includes('private'));
});

test('AI SDK v3 structured finish truth is normalized without trusting provider raw vocabulary', async (t) => {
  async function oneStep(input: {
    unified: string;
    raw?: unknown;
    output: unknown[];
  }) {
    const model = {
      async getResponse(): Promise<never> { throw new Error('streaming path required'); },
      async *getStreamedResponse() {
        yield {
          type: 'model',
          event: {
            type: 'finish',
            finishReason: {
              unified: input.unified,
              ...(input.raw !== undefined ? { raw: input.raw } : {}),
            },
          },
        } as never;
        yield {
          type: 'response_done',
          response: {
            id: `ai-sdk-v3-${input.unified}`,
            output: input.output,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        } as never;
      },
    };
    return codexOneStep({ input: 'go', stream: true, resolveModel: () => model as never });
  }

  await t.test('completed assistant text', async () => {
    const result = await oneStep({
      unified: 'stop',
      raw: 'end_turn',
      output: [{
        type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'done' }],
      }],
    });
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.terminationEvidence, 'recognized');
    assert.equal(admitModelStep(result).admitted, true);
  });

  await t.test('tool-call intent', async () => {
    const result = await oneStep({
      unified: 'tool-calls',
      raw: 'tool_use',
      output: [{ type: 'function_call', callId: 'ai-sdk-call', name: 'read', arguments: '{}' }],
    });
    assert.equal(result.stopReason, 'tool_calls');
    const admission = admitModelStep(result);
    assert.ok(admission.admitted && admission.frame.kind === 'tool_calls');
  });

  await t.test('output limit', async () => {
    const result = await oneStep({
      unified: 'length',
      raw: 'max_tokens',
      output: [{
        type: 'message', role: 'assistant', status: 'incomplete',
        content: [{ type: 'output_text', text: 'partial' }],
      }],
    });
    assert.equal(result.stopReason, 'max_output');
    assert.equal(result.limitHit, true);
    assert.deepEqual(admitModelStep(result), { admitted: false, reason: 'provider_limit_hit' });
  });

  await t.test('explicit error cannot be shape-inferred into success', async () => {
    const result = await oneStep({
      unified: 'error',
      raw: 'provider_error',
      output: [{
        type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'partial but plausible' }],
      }],
    });
    assert.equal(result.terminationEvidence, 'unrecognized');
    assert.deepEqual(admitModelStep(result), { admitted: false, reason: 'provider_unrecognized_stop' });
  });

  await t.test('unknown canonical value and malformed raw data fail closed', async () => {
    const unknown = await oneStep({
      unified: 'other',
      raw: 'future_stop',
      output: [{
        type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'not authoritative' }],
      }],
    });
    assert.equal(admitModelStep(unknown).admitted, false);

    const malformed = await oneStep({
      unified: 'stop',
      raw: 42,
      output: [{
        type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'not authoritative either' }],
      }],
    });
    assert.equal(malformed.terminationEvidence, 'unrecognized');
    assert.equal(admitModelStep(malformed).admitted, false);
  });
});

test('the installed AI SDK adapter carries structured Claude-style finish truth through the host boundary', async () => {
  const { aisdk } = await import('@openai/agents-extensions/ai-sdk');
  const aiSdkV3Model = {
    specificationVersion: 'v3',
    provider: 'fixture.messages',
    modelId: 'fixture-model',
    supportedUrls: {},
    async doGenerate(): Promise<never> {
      throw new Error('streaming path required');
    },
    async doStream() {
      async function* stream() {
        yield { type: 'response-metadata', id: 'installed-adapter-response' };
        yield { type: 'text-delta', id: 'text-1', delta: 'adapter answer' };
        yield {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'end_turn' },
          usage: { inputTokens: 3, outputTokens: 2 },
        };
      }
      return { stream: stream() };
    },
  };
  const result = await codexOneStep({
    input: 'go',
    stream: true,
    resolveModel: () => aisdk(aiSdkV3Model as never),
  });
  assert.equal(result.responseId, 'installed-adapter-response');
  assert.equal(result.text, 'adapter answer');
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.terminationEvidence, 'recognized');
  const admission = admitModelStep(result);
  assert.ok(admission.admitted && admission.frame.kind === 'completed');
});

test('streaming normalizes BYO partial-text length and refusal-only completion', async (t) => {
  await t.test('partial text length', async () => {
    const model = {
      async getResponse(): Promise<never> { throw new Error('streaming path required'); },
      async *getStreamedResponse() {
        yield { type: 'output_text_delta', delta: 'partial' } as never;
        yield {
          type: 'model',
          event: { choices: [{ finish_reason: 'length' }] },
        } as never;
        yield {
          type: 'response_done',
          response: {
            id: 'byo-length',
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            output: [{
              type: 'message', role: 'assistant', status: 'incomplete',
              content: [{ type: 'output_text', text: 'partial' }],
            }],
          },
        } as never;
      },
    };
    const result = await codexOneStep({ input: 'go', stream: true, resolveModel: () => model as never });
    assert.equal(result.text, 'partial');
    assert.equal(result.stopReason, 'max_output');
    assert.equal(result.limitHit, true);
  });

  await t.test('refusal is a completed assistant presentation', async () => {
    const model = {
      async getResponse(): Promise<never> { throw new Error('streaming path required'); },
      async *getStreamedResponse() {
        yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } } as never;
        yield {
          type: 'response_done',
          response: {
            id: 'refusal-stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            output: [{
              type: 'message', role: 'assistant', status: 'completed',
              content: [{ type: 'refusal', refusal: 'I cannot provide that.' }],
            }],
          },
        } as never;
      },
    };
    const result = await codexOneStep({ input: 'go', stream: true, resolveModel: () => model as never });
    assert.equal(result.text, 'I cannot provide that.');
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.limitHit, false);
  });
});

test('reasoning-only response with no provider termination metadata remains unknown', async () => {
  const model = {
    async getResponse(): Promise<never> { throw new Error('streaming path required'); },
    async *getStreamedResponse() {
      yield {
        type: 'response_done',
        response: {
          id: 'unknown-stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [{ type: 'reasoning', content: [{ type: 'input_text', text: 'private' }] }],
        },
      } as never;
    },
  };
  const result = await codexOneStep({ input: 'go', stream: true, resolveModel: () => model as never });
  assert.equal(result.stopReason, 'unknown');
  assert.equal(result.limitHit, false);
  assert.equal(result.text, '');
});

/* ── PHASE 1A — MODEL-STEP TRUTH ────────────────────────────────────────────
 *
 * `absent` and `unrecognized` termination metadata are DIFFERENT facts, and
 * only the first licenses inferring a stop reason from output shape. Before
 * this boundary existed both collapsed to `unknown`, so a response that
 * explicitly said `error` fell through to shape inference and its partial text
 * became `completed` — an explicit failure laundered into authority to answer.
 */

const TEXT_ITEM = {
  type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'partial thought that never finished' }],
};
const CALL_ITEM = {
  type: 'function_call', callId: 'call-x', name: 'work_call',
  arguments: '{"name":"GENERIC_LIST_RECORDS","args_json":"{}"}',
};

test('explicit error metadata is unrecognized, never inferred from partial text', async () => {
  const { model } = stubModel([TEXT_ITEM], { providerData: { finish_reason: 'error' } });
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  assert.equal(result.stopReason, 'unrecognized', 'an explicit error is not `unknown`');
  assert.equal(result.rawStopReason, 'error', 'the exact spelling is kept for private diagnostics');
  const admission = admitModelStep(result);
  assert.equal(admission.admitted, false);
  assert.equal(admission.admitted === false && admission.reason, 'provider_unrecognized_stop');
});

test('explicit cancelled metadata blocks even with a syntactically valid tool call', async () => {
  const { model } = stubModel([CALL_ITEM], { providerData: { finish_reason: 'cancelled' } });
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  assert.equal(result.stopReason, 'unrecognized');
  assert.equal(result.toolCalls.length, 1, 'the call is parsed — and still not authority to execute');
  assert.equal(admitModelStep(result).admitted, false);
});

test('a future stop spelling is treated as present-but-unrecognized, not absent', async () => {
  // The forward-compatibility case: a provider adds a reason after this code
  // shipped. Guessing from shape would be exactly wrong.
  const { model } = stubModel([TEXT_ITEM], { providerData: { finish_reason: 'quota_exhausted_v2' } });
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  assert.equal(result.stopReason, 'unrecognized');
  assert.equal(result.rawStopReason, 'quota_exhausted_v2');
  assert.equal(admitModelStep(result).admitted, false);
});

test('absent metadata still infers from shape — text completes, calls call', async () => {
  const textOnly = stubModel([TEXT_ITEM]);
  const inferredText = await codexOneStep({ input: 'x', resolveModel: () => textOnly.model as never });
  assert.equal(inferredText.stopReason, 'completed', 'provider-neutral inference is preserved');
  assert.equal(inferredText.rawStopReason, undefined, 'nothing to diagnose when nothing was said');
  const textAdmission = admitModelStep(inferredText);
  assert.ok(textAdmission.admitted && textAdmission.frame.kind === 'completed');

  const callsOnly = stubModel([CALL_ITEM]);
  const inferredCalls = await codexOneStep({ input: 'x', resolveModel: () => callsOnly.model as never });
  assert.equal(inferredCalls.stopReason, 'tool_calls');
  const callAdmission = admitModelStep(inferredCalls);
  assert.ok(callAdmission.admitted && callAdmission.frame.kind === 'tool_calls');
});

test('a recognized stop reason contradicting the output shape blocks', async () => {
  // `completed` while carrying calls, and `tool_calls` while carrying none.
  // Either way the provider and its own payload disagree, and a host that
  // picks a winner is guessing.
  const withCalls = stubModel([CALL_ITEM], { providerData: { finish_reason: 'stop' } });
  const completedWithCalls = await codexOneStep({ input: 'x', resolveModel: () => withCalls.model as never });
  assert.equal(completedWithCalls.stopReason, 'completed');
  const a = admitModelStep(completedWithCalls);
  assert.equal(a.admitted === false && a.reason, 'provider_stop_contradiction');

  const withoutCalls = stubModel([TEXT_ITEM], { providerData: { finish_reason: 'tool_calls' } });
  const callsWithoutCalls = await codexOneStep({ input: 'x', resolveModel: () => withoutCalls.model as never });
  assert.equal(callsWithoutCalls.stopReason, 'tool_calls');
  const b = admitModelStep(callsWithoutCalls);
  assert.equal(b.admitted === false && b.reason, 'provider_stop_contradiction');
});

test('a refusal remains an accepted completed assistant presentation', async () => {
  const { model } = stubModel([
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] },
  ], { providerData: { finish_reason: 'stop' } });
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  assert.equal(result.stopReason, 'completed');
  assert.match(result.text, /cannot help/);
  const admission = admitModelStep(result);
  assert.ok(admission.admitted && admission.frame.kind === 'completed',
    'a refusal is a valid answer, not a blocked step');
});

test('recognized truncation and content filter block regardless of body', async () => {
  const truncated = stubModel([TEXT_ITEM], { providerData: { finish_reason: 'length' } });
  const t = await codexOneStep({ input: 'x', resolveModel: () => truncated.model as never });
  assert.equal(t.stopReason, 'max_output');
  assert.equal(admitModelStep(t).admitted === false && admitModelStep(t).reason, 'provider_limit_hit');

  const filtered = stubModel([TEXT_ITEM], { providerData: { finish_reason: 'content_filter' } });
  const f = await codexOneStep({ input: 'x', resolveModel: () => filtered.model as never });
  assert.equal(f.stopReason, 'content_filter');
  assert.equal(admitModelStep(f).admitted === false && admitModelStep(f).reason, 'provider_content_filter');
});

test('an empty or reasoning-only step is not a completion', async () => {
  const { model } = stubModel([{ type: 'reasoning', content: [] }]);
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  assert.equal(result.stopReason, 'unknown', 'absent metadata plus no actionable shape');
  const admission = admitModelStep(result);
  assert.equal(admission.admitted === false && admission.reason, 'model_empty_completion');
});

/* ── PHASE 1A COMPLETION — FRAME + LIFECYCLE ADMISSION ──────────────────────*/

const CALL = (over: Record<string, unknown> = {}) => ({
  type: 'function_call', callId: 'c1', name: 'work_call', arguments: '{}', ...over,
});

test('provider lifecycle failure blocks even with a well-formed frame', async () => {
  for (const [status, label] of [['cancelled', 'a valid call'], ['failed', 'partial text']] as const) {
    const output = status === 'cancelled' ? [CALL()] : [TEXT_ITEM];
    const { model } = stubModel(output, { providerData: { status } });
    const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
    assert.equal(result.terminationEvidence, 'failure', `${status} is an explicit failure`);
    assert.equal(result.rawStopReason, status, 'the exact lifecycle word is kept privately');
    const admission = admitModelStep(result);
    assert.equal(admission.admitted === false && admission.reason, 'provider_reported_failure',
      `${status} with ${label} must not be admitted`);
  }
});

test('non-final lifecycle states block — a response still in progress is not an answer', async () => {
  for (const status of ['incomplete', 'in_progress'] as const) {
    const { model } = stubModel([TEXT_ITEM], { providerData: { status } });
    const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
    assert.equal(admitModelStep(result).admitted, false, `${status} must block`);
  }
});

test('an incomplete assistant message blocks even with NO termination metadata', async () => {
  // Shape inference is licensed here — and the shape itself says unfinished.
  const { model } = stubModel([{ ...TEXT_ITEM, status: 'incomplete' }]);
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  assert.equal(result.terminationEvidence, 'absent');
  const admission = admitModelStep(result);
  assert.equal(admission.admitted === false && admission.reason, 'model_incomplete_output');
});

test('an incomplete function call blocks under a recognized tool-call stop', async () => {
  const { model } = stubModel([CALL({ status: 'in_progress' })], { providerData: { finish_reason: 'tool_calls' } });
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  const admission = admitModelStep(result);
  assert.equal(admission.admitted === false && admission.reason, 'model_incomplete_output');
});

test('tool-shaped failure spellings are never read as tool-call success', async () => {
  // Each of these CONTAINS a recognized token and means its opposite. Exact
  // allowlisting is the only thing that separates them.
  for (const spelling of ['tool_call_error', 'tool_use_cancelled', 'not_tool_calls']) {
    const { model } = stubModel([CALL()], { providerData: { finish_reason: spelling } });
    const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
    assert.equal(result.stopReason, 'unrecognized', `${spelling} must not normalize to tool_calls`);
    assert.equal(admitModelStep(result).admitted, false, `${spelling} must block`);
  }
});

test('an unsupported actionable output blocks even beside completed text', async () => {
  for (const kind of ['hosted_tool_call', 'tool_search_call', 'computer_call', 'shell_call', 'apply_patch_call']) {
    const { model } = stubModel([TEXT_ITEM, { type: kind, id: 'x1', status: 'completed' }],
      { providerData: { finish_reason: 'stop' } });
    const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
    const admission = admitModelStep(result);
    assert.equal(admission.admitted === false && admission.reason, 'model_unsupported_output',
      `${kind} alongside text must block, not answer while dropping the action`);
  }
});

test('blank and duplicate call ids block before any ledger opens', async () => {
  const blank = stubModel([CALL({ callId: '   ' })], { providerData: { finish_reason: 'tool_calls' } });
  const blankResult = await codexOneStep({ input: 'x', resolveModel: () => blank.model as never });
  assert.equal(
    (() => { const a = admitModelStep(blankResult); return a.admitted === false && a.reason; })(),
    'model_malformed_tool_call', 'a blank id cannot be settled against');

  const dupe = stubModel([CALL({ callId: 'same' }), CALL({ callId: 'same', name: 'other' })],
    { providerData: { finish_reason: 'tool_calls' } });
  const dupeResult = await codexOneStep({ input: 'x', resolveModel: () => dupe.model as never });
  assert.equal(
    (() => { const a = admitModelStep(dupeResult); return a.admitted === false && a.reason; })(),
    'model_malformed_tool_call', 'duplicate ids cannot be told apart');
});

test('a valid tool frame admits with a completed assistant preamble', async () => {
  const { model } = stubModel([TEXT_ITEM, CALL({ callId: 'c-ok' })],
    { providerData: { finish_reason: 'tool_calls' } });
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  const admission = admitModelStep(result);
  assert.ok(admission.admitted && admission.frame.kind === 'tool_calls',
    'preamble text is allowed to accompany valid calls');
  const frame = validateOutputFrame(result.output);
  assert.ok(frame.valid && frame.kind === 'tool_calls' && frame.preamble.length > 0,
    'and the preamble is carried, not discarded');
});

test('reasoning items accompany either valid frame without blocking', async () => {
  const { model } = stubModel([{ type: 'reasoning', content: [] }, TEXT_ITEM],
    { providerData: { finish_reason: 'stop' } });
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  const admission = admitModelStep(result);
  assert.ok(admission.admitted && admission.frame.kind === 'completed');
});

test('a present-but-malformed termination field is evidence, not absence', async () => {
  const { model } = stubModel([TEXT_ITEM], { providerData: { finish_reason: 42 as never } });
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  assert.equal(result.terminationEvidence, 'unrecognized',
    'a non-string termination field must not hand the turn back to shape inference');
  assert.equal(admitModelStep(result).admitted, false);
});

test('null, empty, and future lifecycle/termination evidence all fail closed', async (t) => {
  for (const [label, providerData] of [
    ['null finish', { finish_reason: null }],
    ['empty finish', { finish_reason: '   ' }],
    ['future finish', { finish_reason: 'provider_done_v9' }],
    ['null lifecycle', { status: null }],
    ['future lifecycle', { status: 'settled_v9' }],
  ] as const) {
    await t.test(label, async () => {
      const { model } = stubModel([TEXT_ITEM], { providerData: providerData as never });
      const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
      assert.equal(result.terminationEvidence, 'unrecognized');
      assert.equal(admitModelStep(result).admitted, false);
    });
  }
});

test('unrelated nested reason fields are not termination authority', async () => {
  const { model } = stubModel([TEXT_ITEM], {
    providerData: {
      metadata: { reason: 'cancelled' },
      incomplete_details: { reason: 'unrelated_bookkeeping' },
    },
  });
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  assert.equal(result.terminationEvidence, 'absent');
  const admission = admitModelStep(result);
  assert.ok(admission.admitted && admission.frame.kind === 'completed');
});

test('the admitted output protocol is closed over item, content, and status kinds', async (t) => {
  const cases: Array<{ label: string; output: unknown[]; reason: string }> = [
    { label: 'future passive item', output: [TEXT_ITEM, { type: 'future_observation', value: 1 }], reason: 'model_unsupported_output' },
    { label: 'future assistant content', output: [{ ...TEXT_ITEM, content: [{ type: 'future_text', text: 'x' }] }], reason: 'model_unsupported_output' },
    { label: 'missing assistant status', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x' }] }], reason: 'model_unsupported_output' },
    { label: 'future assistant status', output: [{ ...TEXT_ITEM, status: 'settled_v9' }], reason: 'model_unsupported_output' },
    { label: 'future call status', output: [CALL({ status: 'settled_v9' })], reason: 'model_unsupported_output' },
    { label: 'malformed reasoning content', output: [{ type: 'reasoning', content: [{ type: 'future_reasoning', text: 'x' }] }, TEXT_ITEM], reason: 'model_unsupported_output' },
  ];
  for (const fixture of cases) {
    await t.test(fixture.label, async () => {
      const { model } = stubModel(fixture.output, {
        providerData: { finish_reason: fixture.output.some((item) => (item as { type?: string }).type === 'function_call') ? 'tool_calls' : 'stop' },
      });
      const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
      const admission = admitModelStep(result);
      assert.equal(admission.admitted === false && admission.reason, fixture.reason);
    });
  }
});

test('a refusal plus tool intent is a contradiction, not an executable frame', async () => {
  const refusal = {
    type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'refusal', refusal: 'I cannot perform that action.' }],
  };
  const { model } = stubModel([refusal, CALL()], { providerData: { finish_reason: 'tool_calls' } });
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  const admission = admitModelStep(result);
  assert.equal(admission.admitted === false && admission.reason, 'model_unsupported_output');
});

test('admission seals one canonical call/history projection with exact argument bytes', async () => {
  const exactArguments = '{ "literal": "  keep spacing  ", "n": 1 }';
  const rawCall = CALL({ callId: '  call-canonical  ', name: '  work_call  ', arguments: exactArguments });
  const { model } = stubModel([rawCall], { providerData: { finish_reason: 'tool_calls' } });
  const result = await codexOneStep({ input: 'x', resolveModel: () => model as never });
  const admission = admitModelStep(result);
  assert.ok(admission.admitted && admission.frame.kind === 'tool_calls');
  if (!admission.admitted || admission.frame.kind !== 'tool_calls') return;
  assert.deepEqual(admission.frame.calls[0], {
    callId: 'call-canonical',
    name: 'work_call',
    argumentsJson: exactArguments,
  });
  const historyCall = admission.frame.history.find((item) => (item as { type?: string }).type === 'function_call') as {
    callId: string; name: string; arguments: string;
  };
  assert.equal(historyCall.callId, admission.frame.calls[0]?.callId);
  assert.equal(historyCall.name, admission.frame.calls[0]?.name);
  assert.equal(historyCall.arguments, admission.frame.calls[0]?.argumentsJson);
  (result.output[0] as { arguments: string }).arguments = '{"mutated":true}';
  assert.equal(historyCall.arguments, exactArguments, 'post-admission raw mutation cannot alter durable bytes');
});

test('streamed response_done id is normalized into responseId', async () => {
  const model = {
    async getResponse(): Promise<never> { throw new Error('streaming path required'); },
    async *getStreamedResponse() {
      yield { type: 'model', event: { finishReason: 'stop' } } as never;
      yield {
        type: 'response_done',
        response: {
          id: 'stream-response-id',
          output: [TEXT_ITEM],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      } as never;
    },
  };
  const result = await codexOneStep({ input: 'x', stream: true, resolveModel: () => model as never });
  assert.equal(result.responseId, 'stream-response-id');
  const admission = admitModelStep(result);
  assert.ok(admission.admitted && admission.frame.kind === 'completed');
});

test('provisional Chat Completions finish_reason:null does not poison a later terminal stop', async () => {
  const model = {
    async getResponse(): Promise<never> { throw new Error('streaming path required'); },
    async *getStreamedResponse() {
      yield { type: 'model', event: { choices: [{ finish_reason: null, delta: { content: 'done' } }] } } as never;
      yield { type: 'model', event: { choices: [{ finish_reason: 'stop', delta: {} }] } } as never;
      yield {
        type: 'response_done',
        response: {
          id: 'chat-null-then-stop',
          output: [TEXT_ITEM],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      } as never;
    },
  };
  const result = await codexOneStep({ input: 'x', stream: true, resolveModel: () => model as never });
  assert.equal(result.terminationEvidence, 'recognized');
  assert.equal(result.stopReason, 'completed');
  const admission = admitModelStep(result);
  assert.ok(admission.admitted && admission.frame.kind === 'completed');
});

test('null termination on the final streamed envelope remains malformed evidence', async () => {
  const model = {
    async getResponse(): Promise<never> { throw new Error('streaming path required'); },
    async *getStreamedResponse() {
      yield {
        type: 'response_done',
        response: {
          id: 'final-null-stop',
          finish_reason: null,
          output: [TEXT_ITEM],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      } as never;
    },
  };
  const result = await codexOneStep({ input: 'x', stream: true, resolveModel: () => model as never });
  assert.equal(result.terminationEvidence, 'unrecognized');
  assert.equal(admitModelStep(result).admitted, false);
});

test('later healthy stream metadata cannot overwrite earlier failure evidence', async () => {
  const model = {
    async getResponse(): Promise<never> { throw new Error('streaming path required'); },
    async *getStreamedResponse() {
      yield { type: 'model', event: { finishReason: 'error' } } as never;
      yield {
        type: 'response_done',
        response: {
          id: 'conflicting-stream-id',
          providerData: { finish_reason: 'stop' },
          output: [TEXT_ITEM],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      } as never;
    },
  };
  const result = await codexOneStep({ input: 'x', stream: true, resolveModel: () => model as never });
  assert.equal(result.terminationEvidence, 'unrecognized');
  assert.equal(admitModelStep(result).admitted, false);
});

test('malformed streamed response ids are never adopted', async () => {
  const model = {
    async getResponse(): Promise<never> { throw new Error('streaming path required'); },
    async *getStreamedResponse() {
      yield { type: 'model', event: { finishReason: 'stop' } } as never;
      yield {
        type: 'response_done',
        response: {
          id: 42,
          output: [TEXT_ITEM],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      } as never;
    },
  };
  const result = await codexOneStep({ input: 'x', stream: true, resolveModel: () => model as never });
  assert.equal(result.responseId, undefined);
  const admission = admitModelStep(result);
  assert.ok(admission.admitted && admission.frame.kind === 'completed');
});

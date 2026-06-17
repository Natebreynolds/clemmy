import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import { withModelFallback, isOverloadError, type FallbackTarget } from './fallback-model.js';
import { BoundaryError } from '../boundary-error.js';

function req(): ModelRequest { return { input: 'hi', modelSettings: {}, tools: [], handoffs: [] } as unknown as ModelRequest; }
function resp(text: string): ModelResponse { return { output: [{ type: 'message', content: text }], usage: {} } as unknown as ModelResponse; }
const overload = () => ({ statusCode: 529, message: 'overloaded_error' });

function model(impl: Partial<Model>): Model {
  return {
    getResponse: impl.getResponse ?? (async () => resp('ok')),
    getStreamedResponse: impl.getStreamedResponse ?? (async function* () { yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any; }),
  } as Model;
}
function target(label: string, m: Model): FallbackTarget { return { label, getModel: () => m }; }
async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> { const o: unknown[] = []; for await (const e of it) o.push(e); return o; }

test('isOverloadError: 529 yes, 429 no, BoundaryError(model.overloaded) yes', () => {
  assert.equal(isOverloadError({ statusCode: 529 }), true);
  assert.equal(isOverloadError({ statusCode: 429 }), false);
  assert.equal(isOverloadError({ statusCode: 400 }), false);
  assert.equal(isOverloadError(new BoundaryError({ kind: 'model.overloaded', retryable: true, userMessage: '', operatorMessage: '' })), true);
  assert.equal(isOverloadError(new BoundaryError({ kind: 'model.rate_limited', retryable: true, userMessage: '', operatorMessage: '' })), false);
});

test('single-element chain returns the model as-is (no wrapper)', () => {
  const m = model({});
  assert.equal(withModelFallback([target('only', m)]), m);
});

test('getResponse: overload on primary falls back to the next brain', async () => {
  let opusCalls = 0, sonnetCalls = 0;
  const opus = model({ getResponse: async () => { opusCalls++; throw overload(); } });
  const sonnet = model({ getResponse: async () => { sonnetCalls++; return resp('from sonnet'); } });
  const res = await withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getResponse(req());
  assert.equal(opusCalls, 1);
  assert.equal(sonnetCalls, 1);
  assert.equal((res.output[0] as any).content, 'from sonnet');
});

test('getResponse: a NON-overload error (400) does NOT fall back — it throws', async () => {
  let sonnetCalls = 0;
  const opus = model({ getResponse: async () => { throw { statusCode: 400, message: 'bad' }; } });
  const sonnet = model({ getResponse: async () => { sonnetCalls++; return resp('x'); } });
  await assert.rejects(() => withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getResponse(req()));
  assert.equal(sonnetCalls, 0, 'never tried the fallback for a non-overload error');
});

test('getResponse: chain Opus->Sonnet->Codex, all overloaded except the last', async () => {
  const opus = model({ getResponse: async () => { throw overload(); } });
  const sonnet = model({ getResponse: async () => { throw overload(); } });
  const codex = model({ getResponse: async () => resp('from codex') });
  const res = await withModelFallback([target('opus', opus), target('sonnet', sonnet), target('codex', codex)]).getResponse(req());
  assert.equal((res.output[0] as any).content, 'from codex');
});

test('getStreamedResponse: overload before any yield falls back and streams the next brain', async () => {
  const opus = model({ getStreamedResponse: async function* () { throw overload(); } });
  const sonnet = model({ getStreamedResponse: async function* () {
    yield { type: 'response_started' } as any;
    yield { type: 'output_text_delta', delta: 'sonnet says hi' } as any;
    yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as any;
  } });
  const events = await collect(withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getStreamedResponse(req()));
  assert.ok((events as any[]).some((e) => e.type === 'output_text_delta' && e.delta === 'sonnet says hi'));
});

test('force-overload knob (dev-gated) skips the primary so the next brain answers', async () => {
  const prevDev = process.env.CLEMMY_DEV_OVERRIDES;
  const prevForce = process.env.CLEMMY_FORCE_CLAUDE_OVERLOAD;
  process.env.CLEMMY_DEV_OVERRIDES = '1';
  process.env.CLEMMY_FORCE_CLAUDE_OVERLOAD = '1';
  try {
    let opusCalls = 0, sonnetCalls = 0;
    const opus = model({ getResponse: async () => { opusCalls++; return resp('opus'); } });
    const sonnet = model({ getResponse: async () => { sonnetCalls++; return resp('sonnet'); } });
    const res = await withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getResponse(req());
    assert.equal(opusCalls, 0, 'force knob skipped the primary');
    assert.equal(sonnetCalls, 1);
    assert.equal((res.output[0] as any).content, 'sonnet');
  } finally {
    if (prevDev === undefined) delete process.env.CLEMMY_DEV_OVERRIDES; else process.env.CLEMMY_DEV_OVERRIDES = prevDev;
    if (prevForce === undefined) delete process.env.CLEMMY_FORCE_CLAUDE_OVERLOAD; else process.env.CLEMMY_FORCE_CLAUDE_OVERLOAD = prevForce;
  }
});

test('getStreamedResponse: overload AFTER content yielded does NOT fall back (would duplicate)', async () => {
  let sonnetCalls = 0;
  const opus = model({ getStreamedResponse: async function* () {
    yield { type: 'output_text_delta', delta: 'partial' } as any;
    throw overload();
  } });
  const sonnet = model({ getStreamedResponse: async function* () { sonnetCalls++; yield { type: 'response_done', response: { output: [] } } as any; } });
  const got: any[] = [];
  await assert.rejects(async () => { for await (const e of withModelFallback([target('opus', opus), target('sonnet', sonnet)]).getStreamedResponse(req())) got.push(e); });
  assert.equal(sonnetCalls, 0, 'committed stream is not switched');
  assert.ok(got.some((e) => e.type === 'output_text_delta'));
});

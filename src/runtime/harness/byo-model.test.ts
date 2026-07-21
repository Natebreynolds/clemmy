import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protocol, withTrace } from '@openai/agents-core';
import { OpenAIChatCompletionsModel } from '@openai/agents-openai';
import { relaxRequestForCompatBackend, wrapCompletionsCreate, liftReasoning, applyGlmThinking, repairToolCallArguments } from './byo-model.js';

// --- test helpers for the wrapped-create repair layer ---------------------
type AnyObj = Record<string, unknown>;
function completionWith(content: string | null, tool_calls?: AnyObj[]): AnyObj {
  return {
    id: 'c1', created: 1, model: 'm',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    choices: [{ index: 0, finish_reason: tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content, tool_calls } }],
  };
}
function makeFake(responders: Array<(p: AnyObj) => unknown>) {
  const calls: AnyObj[] = [];
  let i = 0;
  const fn = async (params: AnyObj) => {
    calls.push(params);
    const r = responders[Math.min(i, responders.length - 1)];
    i += 1;
    return r(params);
  };
  return { fn: fn as unknown as (p: AnyObj, o?: unknown) => Promise<unknown>, calls };
}
const structuredParams = (overrides: AnyObj = {}): AnyObj => ({
  model: 'm',
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }],
  response_format: { type: 'json_schema', json_schema: { name: 'V', strict: true, schema: { type: 'object', properties: { done: { type: 'boolean' } } } } },
  ...overrides,
});
async function collect(stream: unknown): Promise<AnyObj[]> {
  const out: AnyObj[] = [];
  for await (const chunk of stream as AsyncIterable<AnyObj>) out.push(chunk);
  return out;
}

test('relax: strict json_schema is downgraded to json_object', () => {
  const out = relaxRequestForCompatBackend({
    messages: [{ role: 'system', content: 'sys' }],
    response_format: { type: 'json_schema', json_schema: { name: 'V', strict: true, schema: { type: 'object' } } },
  }) as { response_format?: { type?: string } };
  assert.equal(out.response_format?.type, 'json_object');
});

test('relax: schema is folded into the system message so the model still returns conforming JSON', () => {
  const out = relaxRequestForCompatBackend({
    messages: [{ role: 'system', content: 'You are Clem.' }, { role: 'user', content: 'hi' }],
    response_format: { type: 'json_schema', json_schema: { name: 'V', strict: true, schema: { type: 'object', properties: { done: { type: 'boolean' } } } } },
  }) as { messages: Array<{ role: string; content: string }> };
  const sys = out.messages.find((m) => m.role === 'system');
  assert.ok(sys);
  assert.match(sys!.content, /JSON Schema/);
  assert.match(sys!.content, /"done"/);
});

test('relax: json_schema + TOOLS drops response_format (strict backend can\'t do both) but keeps schema-in-prompt', () => {
  const prev = process.env.CLEMMY_BYO_TOOLS_DROP_RESPONSE_FORMAT;
  process.env.CLEMMY_BYO_TOOLS_DROP_RESPONSE_FORMAT = 'on';
  try {
    const out = relaxRequestForCompatBackend({
      messages: [{ role: 'system', content: 'You are Clem.' }],
      tools: [{ type: 'function', function: { name: 'get_x', parameters: { type: 'object' } } }],
      response_format: { type: 'json_schema', json_schema: { name: 'V', strict: true, schema: { type: 'object', properties: { done: { type: 'boolean' } } } } },
    }) as { response_format?: unknown; messages: Array<{ role: string; content: string }> };
    // The conflicting response_format is GONE so the model can emit real tool_calls…
    assert.equal('response_format' in out, false, 'response_format dropped when tools present');
    // …but the schema is still folded into the system prompt + tools survive.
    const sys = out.messages.find((m) => m.role === 'system');
    assert.match(sys!.content, /JSON Schema/);
    assert.match(sys!.content, /"done"/);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_BYO_TOOLS_DROP_RESPONSE_FORMAT; else process.env.CLEMMY_BYO_TOOLS_DROP_RESPONSE_FORMAT = prev;
  }
});

test('relax: json_schema + TOOLS with the kill-switch OFF keeps the legacy json_object downgrade', () => {
  const prev = process.env.CLEMMY_BYO_TOOLS_DROP_RESPONSE_FORMAT;
  process.env.CLEMMY_BYO_TOOLS_DROP_RESPONSE_FORMAT = 'off';
  try {
    const out = relaxRequestForCompatBackend({
      messages: [{ role: 'system', content: 'sys' }],
      tools: [{ type: 'function', function: { name: 'get_x', parameters: { type: 'object' } } }],
      response_format: { type: 'json_schema', json_schema: { name: 'V', strict: true, schema: { type: 'object' } } },
    }) as { response_format?: { type?: string } };
    assert.equal(out.response_format?.type, 'json_object', 'kill-switch off → legacy downgrade');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_BYO_TOOLS_DROP_RESPONSE_FORMAT; else process.env.CLEMMY_BYO_TOOLS_DROP_RESPONSE_FORMAT = prev;
  }
});

test('relax: empty assistant messages are normalized (Moonshot 400s on them)', () => {
  const out = relaxRequestForCompatBackend({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      // tool-call-only turn: strict backends reject content '' → must become null
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'result' },
      // dead/aborted turn: carries nothing → dropped entirely
      { role: 'assistant', content: '' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: [] },
      { role: 'user', content: 'next' },
      // non-empty assistant messages pass through untouched
      { role: 'assistant', content: 'a real reply' },
    ],
  }) as { messages: Array<Record<string, unknown>> };
  const toolTurn = out.messages.find((m) => Array.isArray(m.tool_calls));
  assert.ok(toolTurn, 'tool-call turn survives');
  assert.equal(toolTurn!.content, null, 'tool-call turn content coerced to null');
  const assistants = out.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 2, 'bare empty assistant messages dropped');
  assert.equal(assistants[1]!.content, 'a real reply');
  assert.equal(out.messages.filter((m) => m.role === 'user').length, 2, 'other roles untouched');
});

test('relax: json_schema WITHOUT tools still downgrades to json_object (no behavior change)', () => {
  const out = relaxRequestForCompatBackend({
    messages: [{ role: 'system', content: 'sys' }],
    response_format: { type: 'json_schema', json_schema: { name: 'V', strict: true, schema: { type: 'object' } } },
  }) as { response_format?: { type?: string } };
  assert.equal(out.response_format?.type, 'json_object');
});

test('relax: a system message is created when none exists', () => {
  const out = relaxRequestForCompatBackend({
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_schema', json_schema: { name: 'V', strict: true, schema: { type: 'object' } } },
  }) as { messages: Array<{ role: string }> };
  assert.equal(out.messages[0].role, 'system');
});

test('relax: OpenAI-only fields rejected by compatible backends are stripped', () => {
  const out = relaxRequestForCompatBackend({
    messages: [],
    store: false,
    prompt_cache_retention: 'in-memory',
    reasoning_effort: 'high',
    verbosity: 'low',
    temperature: 0.5,
  }) as Record<string, unknown>;
  assert.equal('store' in out, false);
  assert.equal('prompt_cache_retention' in out, false);
  assert.equal('reasoning_effort' in out, false);
  assert.equal('verbosity' in out, false);
  // non-OpenAI-only fields are preserved
  assert.equal(out.temperature, 0.5);
});

test('relax: strict is stripped from function tool definitions', () => {
  const out = relaxRequestForCompatBackend({
    messages: [],
    tools: [
      { type: 'function', function: { name: 'f', parameters: { type: 'object' }, strict: true } },
      { type: 'function', function: { name: 'g', parameters: { type: 'object' } } },
    ],
  }) as { tools: Array<{ function: Record<string, unknown> }> };
  assert.equal('strict' in out.tools[0].function, false);
  assert.equal(out.tools[0].function.name, 'f');
  assert.equal(out.tools[1].function.name, 'g');
});

test('relax: plain text requests (no response_format) pass through untouched', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 };
  const out = relaxRequestForCompatBackend(body) as Record<string, unknown>;
  assert.equal(out.response_format, undefined);
  assert.equal(out.temperature, 0.2);
});

test('relax: input is not mutated (returns a new object)', () => {
  const body = { messages: [{ role: 'system', content: 'sys' }], store: true };
  const out = relaxRequestForCompatBackend(body);
  assert.notEqual(out, body);
  assert.equal((body as Record<string, unknown>).store, true, 'original keeps its fields');
});

// --- wrapped-create repair layer ------------------------------------------

test('wrap(i): tool-call turn (non-stream) is returned untouched', async () => {
  const fake = makeFake([() => completionWith('', [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }])]);
  const create = wrapCompletionsCreate(fake.fn);
  const res = (await create(structuredParams())) as AnyObj;
  const msg = (res.choices as AnyObj[])[0].message as AnyObj;
  assert.equal(msg.content, '');
  assert.equal((msg.tool_calls as AnyObj[]).length, 1);
});

test('wrap(j): empty content (non-stream) is returned untouched', async () => {
  const fake = makeFake([() => completionWith('')]);
  const res = (await wrapCompletionsCreate(fake.fn)(structuredParams())) as AnyObj;
  assert.equal(((res.choices as AnyObj[])[0].message as AnyObj).content, '');
});

test('wrap(k): no marker (free-text + pre-existing json_object) is never repaired', async () => {
  // free-text: no response_format → no marker → passthrough
  const f1 = makeFake([() => completionWith('plain answer, not json')]);
  const r1 = (await wrapCompletionsCreate(f1.fn)({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) as AnyObj;
  assert.equal(((r1.choices as AnyObj[])[0].message as AnyObj).content, 'plain answer, not json');
  // pre-existing json_object (NOT our json_schema downgrade) → no marker → fenced content left as-is
  const f2 = makeFake([() => completionWith('```json\n{"a":1}\n```')]);
  const r2 = (await wrapCompletionsCreate(f2.fn)({ model: 'm', messages: [], response_format: { type: 'json_object' } })) as AnyObj;
  assert.equal(((r2.choices as AnyObj[])[0].message as AnyObj).content, '```json\n{"a":1}\n```');
});

test('wrap(l): marker + fenced content (non-stream) is rewritten to parseable JSON', async () => {
  const fake = makeFake([() => completionWith('```json\n{"done": true}\n```')]);
  const res = (await wrapCompletionsCreate(fake.fn)(structuredParams())) as AnyObj;
  const content = ((res.choices as AnyObj[])[0].message as AnyObj).content as string;
  assert.deepEqual(JSON.parse(content), { done: true });
});

test('wrap(m): marker + fenced content (stream) emits one converter-legal repaired chunk', async () => {
  const fake = makeFake([() => completionWith('```json\n{"done": false}\n```')]);
  const stream = await wrapCompletionsCreate(fake.fn)(structuredParams({ stream: true }));
  const chunks = await collect(stream);
  assert.equal(chunks.length, 1);
  const choice = (chunks[0].choices as AnyObj[])[0];
  assert.equal((choice as AnyObj).index, 0);
  assert.equal((choice as AnyObj).finish_reason, 'stop');
  assert.ok(chunks[0].usage, 'usage preserved so token budget is not zeroed');
  assert.deepEqual(JSON.parse(((choice as AnyObj).delta as AnyObj).content as string), { done: false });
});

test('wrap(n): stream + internal stream:false rejection falls back to a real stream (no throw)', async () => {
  async function* realStream() { yield completionWith('streamed'); }
  const fake = makeFake([(p) => { if (p.stream === false) throw new Error('backend rejects non-stream'); return realStream(); }]);
  const stream = await wrapCompletionsCreate(fake.fn)(structuredParams({ stream: true }));
  const chunks = await collect(stream);
  assert.equal(chunks.length, 1);
  assert.equal(((chunks[0].choices as AnyObj[])[0].message as AnyObj).content, 'streamed');
});

test('wrap(o): re-ask fires exactly once — junk then clean JSON succeeds', async () => {
  const fake = makeFake([() => completionWith('garbage, no json'), () => completionWith('{"ok": 1}')]);
  const create = wrapCompletionsCreate(fake.fn);
  const res = (await create(structuredParams())) as AnyObj;
  assert.equal(fake.calls.length, 2, 'one initial call + one re-ask');
  assert.deepEqual(JSON.parse(((res.choices as AnyObj[])[0].message as AnyObj).content as string), { ok: 1 });
});

test('wrap(o): junk then junk re-asks once (never 3x), leaves content best-effort', async () => {
  const fake = makeFake([() => completionWith('garbage one'), () => completionWith('garbage two')]);
  const res = (await wrapCompletionsCreate(fake.fn)(structuredParams())) as AnyObj;
  assert.equal(fake.calls.length, 2, 'initial + one re-ask only');
  assert.equal(((res.choices as AnyObj[])[0].message as AnyObj).content, 'garbage one');
});

// --- reasoning preservation (the M3 interleaved-thinking fix) --------------

function compl(message: AnyObj): AnyObj {
  return { id: 'c1', created: 1, model: 'm', usage: {}, choices: [{ index: 0, finish_reason: 'stop', message }] };
}

test('liftReasoning: reasoning_content is lifted into message.reasoning (SDK carry-forward field)', () => {
  const c = compl({ role: 'assistant', content: '{"ok":true}', reasoning_content: 'I considered X then Y.' });
  liftReasoning(c);
  assert.equal(((c.choices as AnyObj[])[0].message as AnyObj).reasoning, 'I considered X then Y.');
});

test('liftReasoning: a leading <think> block becomes reasoning and is stripped from content', () => {
  const c = compl({ role: 'assistant', content: '<think>\nplan: call tool A next\n</think>\n{"ok":true}' });
  liftReasoning(c);
  const msg = (c.choices as AnyObj[])[0].message as AnyObj;
  assert.match(msg.reasoning as string, /plan: call tool A/);
  assert.equal(msg.content, '{"ok":true}');
});

test('liftReasoning: no-op when reasoning already present (no double-lift)', () => {
  const c = compl({ role: 'assistant', content: 'hi', reasoning: 'already here', reasoning_content: 'ignored' });
  liftReasoning(c);
  assert.equal(((c.choices as AnyObj[])[0].message as AnyObj).reasoning, 'already here');
});

test('wrap: a TOOL-CALL streaming turn carries reasoning forward (the critical long-loop case)', async () => {
  // Tool turn: content empty, tool_calls present, reasoning in reasoning_content.
  const fake = makeFake([() => compl({
    role: 'assistant', content: '', reasoning_content: 'I should search the inbox first.',
    tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }],
  })]);
  const stream = await wrapCompletionsCreate(fake.fn)(structuredParams({ stream: true }));
  const chunks = await collect(stream);
  const delta = (chunks[0].choices as AnyObj[])[0].delta as AnyObj;
  assert.equal(delta.reasoning, 'I should search the inbox first.', 'reasoning preserved on the tool turn');
  assert.equal((delta.tool_calls as AnyObj[])[0].function && ((delta.tool_calls as AnyObj[])[0].function as AnyObj).name, 'search', 'tool call preserved');
});

test('wrap: a structured streaming turn carries reasoning + repaired JSON', async () => {
  const fake = makeFake([() => compl({ role: 'assistant', content: '<think>let me answer</think>\n```json\n{"done":true}\n```' })]);
  const stream = await wrapCompletionsCreate(fake.fn)(structuredParams({ stream: true }));
  const chunks = await collect(stream);
  const delta = (chunks[0].choices as AnyObj[])[0].delta as AnyObj;
  assert.match(delta.reasoning as string, /let me answer/);
  assert.deepEqual(JSON.parse(delta.content as string), { done: true });
});

// --- GLM (Z.ai) thinking control: effort -> `thinking` switch --------------

test('applyGlmThinking: GLM id + reasoning effort enables/disables thinking by tier', () => {
  const high: AnyObj = { model: 'glm-5.2' }; applyGlmThinking(high, 'high');
  assert.deepEqual(high.thinking, { type: 'enabled' });
  const low: AnyObj = { model: 'glm-5.2' }; applyGlmThinking(low, 'low');
  assert.deepEqual(low.thinking, { type: 'enabled' });
  const minimal: AnyObj = { model: 'glm-4.6' }; applyGlmThinking(minimal, 'minimal');
  assert.deepEqual(minimal.thinking, { type: 'disabled' });
  const none: AnyObj = { model: 'glm-5.2' }; applyGlmThinking(none, 'none');
  assert.deepEqual(none.thinking, { type: 'disabled' });
});

test('applyGlmThinking: non-GLM backend never gets a `thinking` field (would 400)', () => {
  const ds: AnyObj = { model: 'deepseek-chat' }; applyGlmThinking(ds, 'high');
  assert.equal('thinking' in ds, false);
  const mm: AnyObj = { model: 'MiniMax-M3' }; applyGlmThinking(mm, 'low');
  assert.equal('thinking' in mm, false);
});

test('applyGlmThinking: structured output (json_schema/json_object) forces thinking OFF regardless of effort', () => {
  // The orchestrator decision + judges are structured; GLM thinking corrupts
  // them ("reply: expected string") and adds latency — disable it there.
  const schemaHigh: AnyObj = { model: 'glm-5.2', response_format: { type: 'json_schema' } };
  applyGlmThinking(schemaHigh, 'high');
  assert.deepEqual(schemaHigh.thinking, { type: 'disabled' }, 'json_schema + high effort → disabled');
  const jsonObj: AnyObj = { model: 'glm-5.2', response_format: { type: 'json_object' } };
  applyGlmThinking(jsonObj, 'medium');
  assert.deepEqual(jsonObj.thinking, { type: 'disabled' }, 'json_object + medium effort → disabled');
  // free-form (no structured contract) keeps effort-driven thinking
  const freeform: AnyObj = { model: 'glm-5.2' };
  applyGlmThinking(freeform, 'high');
  assert.deepEqual(freeform.thinking, { type: 'enabled' }, 'free-form + high → enabled (unchanged)');
});

test('relax: a GLM structured (json_schema) request ends up with thinking disabled', () => {
  const out = relaxRequestForCompatBackend({
    model: 'glm-5.2', reasoning_effort: 'high',
    response_format: { type: 'json_schema', json_schema: { name: 'V', strict: true, schema: { type: 'object' } } },
    messages: [{ role: 'user', content: 'decide' }],
  }) as Record<string, unknown>;
  assert.deepEqual(out.thinking, { type: 'disabled' }, 'structured GLM call → no thinking');
  assert.equal((out.response_format as AnyObj).type, 'json_object', 'still downgraded for the wire');
});

test('applyGlmThinking: no effort, or pre-set thinking, is left alone', () => {
  const noEffort: AnyObj = { model: 'glm-5.2' }; applyGlmThinking(noEffort, undefined);
  assert.equal('thinking' in noEffort, false, 'no effort -> leave GLM default');
  const preset: AnyObj = { model: 'glm-5.2', thinking: { type: 'enabled', clear_thinking: false } };
  applyGlmThinking(preset, 'none');
  assert.deepEqual(preset.thinking, { type: 'enabled', clear_thinking: false }, 'caller-set thinking wins');
});

test('relax: GLM request translates stripped reasoning_effort into `thinking`', () => {
  const out = relaxRequestForCompatBackend({
    model: 'glm-5.2', reasoning_effort: 'high',
    messages: [{ role: 'user', content: 'hi' }],
  }) as Record<string, unknown>;
  assert.equal('reasoning_effort' in out, false, 'OpenAI-only field still stripped');
  assert.deepEqual(out.thinking, { type: 'enabled' }, 'effort survives as GLM thinking');
});

test('relax: non-GLM request strips reasoning_effort and adds no `thinking`', () => {
  const out = relaxRequestForCompatBackend({
    model: 'deepseek-chat', reasoning_effort: 'high',
    messages: [{ role: 'user', content: 'hi' }],
  }) as Record<string, unknown>;
  assert.equal('reasoning_effort' in out, false);
  assert.equal('thinking' in out, false);
});

// --- tool-call argument repair (reliability net) --------------------------

test('repairToolCallArguments: fenced/prose-wrapped args are recovered', () => {
  const c = completionWith('', [{ id: 't1', type: 'function', function: { name: 'f', arguments: '```json\n{"q":"acme"}\n```' } }]);
  assert.equal(repairToolCallArguments(c), true);
  const args = ((c.choices as AnyObj[])[0].message as AnyObj).tool_calls as AnyObj[];
  assert.deepEqual(JSON.parse((args[0].function as AnyObj).arguments as string), { q: 'acme' });
});

function firstToolArgs(c: AnyObj): unknown {
  const tc = ((c.choices as AnyObj[])[0].message as AnyObj).tool_calls as AnyObj[];
  return (tc[0].function as AnyObj).arguments;
}

test('repairToolCallArguments: valid or empty args are left byte-identical', () => {
  const valid = completionWith('', [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{"q":"x"}' } }]);
  assert.equal(repairToolCallArguments(valid), false);
  assert.equal(firstToolArgs(valid), '{"q":"x"}', 'healthy args untouched');
  const empty = completionWith('', [{ id: 't1', type: 'function', function: { name: 'f', arguments: '' } }]);
  assert.equal(repairToolCallArguments(empty), false, 'empty (no-arg call) untouched');
  assert.equal(firstToolArgs(empty), '');
});

test('wrap: a tool-call turn with malformed args is repaired (non-stream)', async () => {
  const fake = makeFake([() => completionWith('', [{ id: 't1', type: 'function', function: { name: 'f', arguments: 'here you go: {"q":"acme"}' } }])]);
  const res = (await wrapCompletionsCreate(fake.fn)(structuredParams())) as AnyObj;
  const tc = ((res.choices as AnyObj[])[0].message as AnyObj).tool_calls as AnyObj[];
  assert.deepEqual(JSON.parse((tc[0].function as AnyObj).arguments as string), { q: 'acme' });
});

// --- W2: brain-agnostic shape-aware structured re-ask -----------------------
// A schema with REQUIRED fields, so a parseable-but-wrong-shape reply (the
// failure a compat backend produces once json_schema is no longer wire-enforced)
// can be detected and re-asked. Applies to EVERY OpenAI-compatible backend.
const decisionParams = (overrides: AnyObj = {}): AnyObj => ({
  model: 'm',
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }],
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'Decision', strict: true,
      schema: {
        type: 'object',
        properties: { summary: { type: 'string' }, done: { type: 'boolean' }, nextAction: { type: 'string', enum: ['completed', 'abandoned'] } },
        required: ['summary', 'done', 'nextAction'],
      },
    },
  },
  ...overrides,
});

test('wrap(W2): parseable-but-wrong-shape JSON triggers ONE shape-aware re-ask, adopts the conforming result', async () => {
  const fake = makeFake([
    () => completionWith('{"answer":"Paris"}'), // parseable, wrong shape
    () => completionWith('{"summary":"answered the question","done":true,"nextAction":"completed"}'),
  ]);
  const res = (await wrapCompletionsCreate(fake.fn)(decisionParams())) as AnyObj;
  assert.equal(fake.calls.length, 2, 'one initial + exactly one shape-aware re-ask');
  // The re-ask instruction is SHAPE-aware (names the missing fields).
  const reAskMsgs = (fake.calls[1].messages as AnyObj[]);
  const lastSys = reAskMsgs[reAskMsgs.length - 1].content as string;
  assert.ok(/wrong shape/i.test(lastSys) && /summary|done|nextAction/.test(lastSys), 'shape-aware re-ask names the violation');
  assert.deepEqual(JSON.parse(((res.choices as AnyObj[])[0].message as AnyObj).content as string), {
    summary: 'answered the question', done: true, nextAction: 'completed',
  });
});

test('wrap(W2): wrong-shape then STILL wrong-shape keeps the original (monotonic, one re-ask only)', async () => {
  const fake = makeFake([
    () => completionWith('{"answer":"Paris"}'),
    () => completionWith('{"still":"wrong"}'),
  ]);
  const res = (await wrapCompletionsCreate(fake.fn)(decisionParams())) as AnyObj;
  assert.equal(fake.calls.length, 2, 'initial + one re-ask only (never replaces good-enough with worse)');
  assert.deepEqual(JSON.parse(((res.choices as AnyObj[])[0].message as AnyObj).content as string), { answer: 'Paris' });
});

test('wrap(W2): a fully-conforming reply is NEVER re-asked (no spurious cost on healthy output)', async () => {
  const fake = makeFake([() => completionWith('{"summary":"replied directly","done":true,"nextAction":"completed"}')]);
  const res = (await wrapCompletionsCreate(fake.fn)(decisionParams())) as AnyObj;
  assert.equal(fake.calls.length, 1, 'conforming JSON → zero re-asks');
  assert.deepEqual(JSON.parse(((res.choices as AnyObj[])[0].message as AnyObj).content as string), {
    summary: 'replied directly', done: true, nextAction: 'completed',
  });
});

test('wrap(W2): UNPARSEABLE still uses the generic JSON-only re-ask (shape path does not double-fire)', async () => {
  const fake = makeFake([() => completionWith('total garbage'), () => completionWith('{"summary":"x and y","done":true,"nextAction":"completed"}')]);
  const res = (await wrapCompletionsCreate(fake.fn)(decisionParams())) as AnyObj;
  assert.equal(fake.calls.length, 2, 'one parse re-ask only');
  const reAskMsgs = (fake.calls[1].messages as AnyObj[]);
  const lastSys = reAskMsgs[reAskMsgs.length - 1].content as string;
  assert.ok(/Return ONLY the JSON value/.test(lastSys), 'unparseable path uses the generic nudge');
  assert.equal(JSON.parse(((res.choices as AnyObj[])[0].message as AnyObj).content as string).done, true);
});

// ── SDK protocol conformance for response items ────────────────────────────
// Regression guard for the @openai/agents 0.12 bump (live incident 2026-07-03,
// first hit on the codex lane): agents-core validates the response_done payload
// against its zod protocol. Unlike codex/claude-headless, this BYO lane does NOT
// build SDK output items itself — it wraps the OpenAI-compatible
// `chat.completions.create` and hands chat-completion shapes to the SDK's own
// `OpenAIChatCompletionsModel`, which builds the protocol items. So the faithful
// conformance test drives that REAL model through `wrapCompletionsCreate` and
// validates every producible output item end to end. The BYO-specific risk that
// mirrors the codex `summary_text` incident is `liftReasoning`: it populates
// `message.reasoning`, which makes the SDK emit a `reasoning` output item — a
// shape a healthy content-only turn never carries. These tests cover every
// completion shape BYO produces (content, structured JSON, reasoning-lift,
// single/empty/multiple tool calls, refusal) across the streaming and
// non-streaming paths, so a future SDK bump that shifts the protocol fails here
// — in CI — instead of live on the user's first real GLM/MiniMax/DeepSeek turn.

function fakeClient(create: (p: AnyObj, o?: unknown) => Promise<unknown>) {
  return { baseURL: 'http://byo.test', chat: { completions: { create: wrapCompletionsCreate(create as never) } } };
}

function conformanceModel(message: AnyObj, finish?: string) {
  const backendCreate = async (): Promise<AnyObj> => ({
    id: 'c1', created: 1, model: 'glm-5.2', object: 'chat.completion',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    choices: [{ index: 0, finish_reason: finish ?? (message.tool_calls ? 'tool_calls' : 'stop'), message }],
  });
  return new OpenAIChatCompletionsModel(fakeClient(backendCreate) as never, 'glm-5.2');
}

function conformanceRequest(overrides: AnyObj = {}): AnyObj {
  return {
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    modelSettings: {},
    tools: [],
    handoffs: [],
    outputType: 'text',
    tracing: false,
    ...overrides,
  };
}

function assertItemsConform(label: string, items: unknown[]): void {
  items.forEach((item, i) => {
    const parsed = protocol.OutputModelItem.safeParse(item);
    assert.ok(
      parsed.success,
      `${label} item ${i} (type=${(item as AnyObj)?.type}) failed protocol validation: `
        + JSON.stringify(parsed.success ? null : parsed.error.issues),
    );
  });
}

// Structured request → BYO downgrades json_schema and marks the body for repair,
// exercising the structured content path (the reasoning-lift + JSON-repair lane).
const STRUCTURED_OUTPUT = { type: 'json_schema', name: 'V', strict: true, schema: { type: 'object' } };

async function nonStreamItems(message: AnyObj, reqOverrides: AnyObj = {}): Promise<unknown[]> {
  return withTrace('byo-conformance', async () => {
    const res = await conformanceModel(message).getResponse(conformanceRequest(reqOverrides) as never);
    return res.output as unknown[];
  });
}

async function streamItems(message: AnyObj, reqOverrides: AnyObj = {}): Promise<unknown[]> {
  return withTrace('byo-conformance', async () => {
    let output: unknown[] = [];
    for await (const ev of conformanceModel(message).getStreamedResponse(conformanceRequest(reqOverrides) as never) as AsyncIterable<AnyObj>) {
      if (ev.type === 'response_done') output = (ev.response as AnyObj).output as unknown[];
    }
    return output;
  });
}

test('conformance(non-stream): plain content reply is a protocol-legal message', async () => {
  assertItemsConform('plain content', await nonStreamItems({ role: 'assistant', content: 'Paris is the capital of France.' }));
});

test('conformance(non-stream): structured JSON reply is a protocol-legal message', async () => {
  assertItemsConform('structured content', await nonStreamItems({ role: 'assistant', content: '{"done":true}' }, { outputType: STRUCTURED_OUTPUT }));
});

test('conformance(non-stream): reasoning-lift emits protocol-legal reasoning + message (the M3 case)', async () => {
  // reasoning_content is what liftReasoning() promotes into message.reasoning →
  // the SDK then emits a `reasoning` item ahead of the message.
  const items = await nonStreamItems({ role: 'assistant', content: '{"done":true}', reasoning_content: 'I checked the schema first.' }, { outputType: STRUCTURED_OUTPUT });
  assert.deepEqual(items.map((i) => (i as AnyObj).type), ['reasoning', 'message'], 'reasoning precedes the message');
  assertItemsConform('reasoning + message', items);
});

test('conformance(non-stream): a single tool call is a protocol-legal function_call', async () => {
  assertItemsConform('single tool call', await nonStreamItems({
    role: 'assistant', content: '',
    tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
  }));
});

test('conformance(non-stream): a no-arg tool call (empty arguments) is protocol-legal', async () => {
  assertItemsConform('empty-arg tool call', await nonStreamItems({
    role: 'assistant', content: '',
    tool_calls: [{ id: 't1', type: 'function', function: { name: 'ping', arguments: '' } }],
  }));
});

test('conformance(non-stream): parallel tool calls are each protocol-legal', async () => {
  const items = await nonStreamItems({
    role: 'assistant', content: '',
    tool_calls: [
      { id: 't1', type: 'function', function: { name: 'a', arguments: '{}' } },
      { id: 't2', type: 'function', function: { name: 'b', arguments: '{"x":1}' } },
    ],
  });
  assert.deepEqual(items.map((i) => (i as AnyObj).type), ['function_call', 'function_call']);
  assertItemsConform('parallel tool calls', items);
});

test('conformance(non-stream): a tool call carrying reasoning is protocol-legal (long-loop case)', async () => {
  const items = await nonStreamItems({
    role: 'assistant', content: '', reasoning_content: 'search the inbox first',
    tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }],
  });
  assert.deepEqual(items.map((i) => (i as AnyObj).type), ['reasoning', 'function_call']);
  assertItemsConform('reasoning + tool call', items);
});

test('conformance(non-stream): a refusal message is protocol-legal', async () => {
  // A compat backend can return `refusal` on a passthrough completion; the SDK
  // turns it into a refusal content part.
  assertItemsConform('refusal', await nonStreamItems({ role: 'assistant', content: null, refusal: 'I cannot help with that request.' }));
});

test('conformance(stream): content reply is a protocol-legal message', async () => {
  assertItemsConform('stream content', await streamItems({ role: 'assistant', content: 'hello world' }));
});

test('conformance(stream): reasoning-lift emits protocol-legal reasoning + message', async () => {
  const items = await streamItems({ role: 'assistant', content: '{"done":false}', reasoning_content: 'thinking about it' }, { outputType: STRUCTURED_OUTPUT });
  assert.ok(items.some((i) => (i as AnyObj).type === 'reasoning'), 'a reasoning item is present');
  assertItemsConform('stream reasoning + message', items);
});

test('conformance(stream): a tool call carrying reasoning is protocol-legal', async () => {
  const items = await streamItems({
    role: 'assistant', content: '', reasoning_content: 'plan the call',
    tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }],
  });
  assert.ok(items.some((i) => (i as AnyObj).type === 'function_call'), 'a function_call item is present');
  assertItemsConform('stream reasoning + tool call', items);
});

test('conformance(stream): parallel tool calls are each protocol-legal', async () => {
  const items = await streamItems({
    role: 'assistant', content: '',
    tool_calls: [
      { id: 't1', type: 'function', function: { name: 'a', arguments: '{}' } },
      { id: 't2', type: 'function', function: { name: 'b', arguments: '{"x":1}' } },
    ],
  });
  assert.equal(items.filter((i) => (i as AnyObj).type === 'function_call').length, 2);
  assertItemsConform('stream parallel tool calls', items);
});

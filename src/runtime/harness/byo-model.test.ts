import { test } from 'node:test';
import assert from 'node:assert/strict';
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

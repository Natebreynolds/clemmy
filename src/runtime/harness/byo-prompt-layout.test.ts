import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  PROMPT_LAYOUT_FAILED_RETRY_MS,
  PROMPT_LAYOUT_PROBE_ROUNDS,
  PROMPT_LAYOUT_VERDICT_TTL_MS,
  _resetPromptLayoutForTest,
  decidePromptLayout,
  measurePromptLayout,
  placeTurnContextAtAnchor,
  promptLayoutFor,
  promptLayoutProbeDue,
  readPromptLayoutVerdict,
  recordPromptLayoutVerdict,
  schedulePromptLayoutProbe,
  turnAnchorDigest,
  type PromptLayoutRound,
} from './byo-prompt-layout.js';
import {
  CACHE_MEMORY_CONTEXT_DELIM,
  INSTRUCTION_CACHE_DELIM,
  stripPromptCacheLayerSentinels,
} from './model-wire-registry.js';
import { relaxRequestForCompatBackend, wrapCompletionsCreate } from './byo-model.js';
import { modelUsageAttributionStorage, withModelUsageAttribution } from '../usage-log.js';
import { ToolCallsCounter, harnessRunContextStorage, type HarnessRunContext } from './brackets.js';

type AnyObj = Record<string, unknown>;
const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const STABLE = 'You are Clem. Stable role policy.';
const TURN = 'Execute mode: finish the accepted request.';
const MEMORY = '# Persistent Context\nThe owner prefers short answers.';
const INSTRUCTIONS = `${STABLE}${INSTRUCTION_CACHE_DELIM}${TURN}${CACHE_MEMORY_CONTEXT_DELIM}${MEMORY}`;

function brainBody(overrides: AnyObj = {}): AnyObj {
  return {
    model: 'provider/model-a',
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'what changed this week?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'result' },
      { role: 'system', content: '[AGENT CONTEXT PACKET] hints' },
      { role: 'user', content: 'Host guidance for this request only.' },
    ],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
    ...overrides,
  };
}

const rolesAndText = (body: AnyObj): string[] =>
  (body.messages as AnyObj[]).map((m) => `${String(m.role)}:${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`);

test('the per-turn context moves, unchanged and still a system message, to just before the turn\'s opening message', () => {
  const placed = placeTurnContextAtAnchor(brainBody(), digest('what changed this week?'));
  assert.ok(placed);
  const messages = placed.messages as AnyObj[];
  assert.equal(messages[0].content, STABLE, 'the first system message keeps only the stable policy');
  assert.equal(messages[3].role, 'system');
  assert.equal(messages[3].content, `${TURN}${CACHE_MEMORY_CONTEXT_DELIM}${MEMORY}`);
  assert.equal(messages[4].content, 'what changed this week?');
  // Everything else is the same messages in the same order.
  const before = rolesAndText(brainBody());
  const after = rolesAndText(placed);
  assert.deepEqual([after[0], ...after.slice(1, 3), ...after.slice(4)], [`system:${STABLE}`, ...before.slice(1)]);
  assert.deepEqual(placed.tools, brainBody().tools);
});

test('after the wire strips its layer markers, the model reads the same words as before', () => {
  const legacy = relaxRequestForCompatBackend(brainBody()) as AnyObj;
  const placed = relaxRequestForCompatBackend(placeTurnContextAtAnchor(brainBody(), digest('what changed this week?'))!) as AnyObj;
  const legacySystem = String((legacy.messages as AnyObj[])[0].content);
  const placedMessages = placed.messages as AnyObj[];
  const placedText = `${String(placedMessages[0].content)}\n\n---\n\n${String(placedMessages[3].content)}`;
  assert.equal(placedText, legacySystem);
  assert.equal(stripPromptCacheLayerSentinels(String(placedMessages[3].content)), String(placedMessages[3].content));
  assert.doesNotMatch(JSON.stringify(placed), /<<<CLEM_/);
});

test('the request is left untouched without a boundary, an anchor, or both halves', () => {
  const anchor = digest('what changed this week?');
  assert.equal(placeTurnContextAtAnchor(brainBody(), undefined), undefined);
  assert.equal(placeTurnContextAtAnchor(brainBody(), digest('not in this request')), undefined);
  const judge = brainBody({ messages: [{ role: 'system', content: 'Judge policy' }, { role: 'user', content: 'what changed this week?' }] });
  assert.equal(placeTurnContextAtAnchor(judge, anchor), undefined);
  const noTurn = brainBody({ messages: [{ role: 'system', content: `${STABLE}${INSTRUCTION_CACHE_DELIM}` }, { role: 'user', content: 'what changed this week?' }] });
  assert.equal(placeTurnContextAtAnchor(noTurn, anchor), undefined);
  const userFirst = brainBody({ messages: [{ role: 'user', content: 'what changed this week?' }] });
  assert.equal(placeTurnContextAtAnchor(userFirst, anchor), undefined);
});

test('a repeated message anchors on the latest one, the turn being answered', () => {
  const body = brainBody({
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: 'yes' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'yes' },
    ],
  });
  const placed = placeTurnContextAtAnchor(body, digest('yes'))!;
  const roles = (placed.messages as AnyObj[]).map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'system', 'user']);
});

test('text parts match across the item shape and the chat shape', () => {
  const item = { role: 'user', content: [{ type: 'input_text', text: 'see the chart' }, { type: 'input_image', image: 'data:x' }] };
  const anchor = turnAnchorDigest([item]);
  assert.equal(anchor, digest('see the chart'));
  const body = brainBody({
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'see the chart' }, { type: 'image_url', image_url: { url: 'data:x' } }] },
    ],
  });
  const placed = placeTurnContextAtAnchor(body, anchor)!;
  assert.equal((placed.messages as AnyObj[])[1].role, 'system');
});

test('the anchor is the last user message; system items and tool traffic after it do not move it', () => {
  const input = [
    { role: 'user', content: 'first ask' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    { role: 'user', content: 'second ask' },
    { type: 'function_call', callId: 'c', name: 'read', arguments: '{}' },
    { type: 'function_call_result', callId: 'c', output: { type: 'text', text: 'r' } },
    { role: 'system', content: '[AGENT CONTEXT PACKET]' },
  ];
  assert.equal(turnAnchorDigest(input), digest('second ask'));
  assert.equal(turnAnchorDigest([{ role: 'user', content: '   ' }]), undefined);
  assert.equal(turnAnchorDigest([{ role: 'system', content: 'only system' }]), undefined);
});

const round = (systemReuse: number, anchorReuse: number): PromptLayoutRound => ({ prompt: 7_800, systemReuse, anchorReuse });

test('the anchor layout is adopted only when it reused clearly more in every round', () => {
  assert.deepEqual(decidePromptLayout([round(2_176, 7_168), round(2_176, 7_168), round(2_176, 7_040)]),
    { layout: 'turn_anchor', reason: 'anchor_reused_more' });
  assert.deepEqual(decidePromptLayout([round(4_800, 2_624), round(4_864, 2_688), round(4_864, 7_000)]),
    { layout: 'system', reason: 'anchor_not_better' }, 'one losing round keeps the system layout');
  assert.deepEqual(decidePromptLayout([round(4_096, 4_300), round(4_096, 6_144), round(4_096, 6_144)]),
    { layout: 'system', reason: 'anchor_not_better' }, 'a marginal win is not a win');
  assert.deepEqual(decidePromptLayout([round(0, 0), round(0, 0), round(0, 0)]),
    { layout: 'system', reason: 'no_prefix_cache' });
  assert.deepEqual(decidePromptLayout([round(2_176, 7_168)]), { layout: 'system', reason: 'probe_failed' });
});

test('a round where either layout reused nothing is a cache miss, not a verdict', () => {
  // Live 2026-10-10: one clear anchor win, then two rounds the provider served no cache to.
  assert.deepEqual(decidePromptLayout([round(2_432, 7_936), round(2_432, 0), round(0, 0)]),
    { layout: 'system', reason: 'probe_failed' }, 'one served round is inconclusive');
  assert.deepEqual(decidePromptLayout([round(2_176, 7_168), round(2_176, 0), round(2_176, 7_040)]),
    { layout: 'turn_anchor', reason: 'anchor_reused_more' }, 'two served wins decide; the miss does not');
  assert.deepEqual(decidePromptLayout([round(4_800, 2_624), round(0, 7_000), round(4_864, 2_688)]),
    { layout: 'system', reason: 'anchor_not_better' }, 'served losses still decide');
});

test('a verdict its own rounds no longer support is measured again', () => {
  _resetPromptLayoutForTest();
  const base = 'https://provider.example/v1/';
  const now = Date.parse('2026-10-10T08:03:31.228Z');
  recordPromptLayoutVerdict(base, 'noisy-model', { layout: 'system', reason: 'anchor_not_better', measuredAt: new Date(now).toISOString(),
    rounds: [round(2_432, 7_936), round(2_432, 0), round(0, 0)] });
  assert.equal(promptLayoutProbeDue(base, 'noisy-model', now + 60_000), true, 'decided under an older rule: due now');
  recordPromptLayoutVerdict(base, 'steady-model', { layout: 'turn_anchor', reason: 'anchor_reused_more', measuredAt: new Date(now).toISOString(),
    rounds: [round(2_176, 7_168), round(2_176, 7_168), round(2_176, 7_040)] });
  assert.equal(promptLayoutProbeDue(base, 'steady-model', now + 60_000), false, 'a verdict its rounds support stays');
});

test('a verdict applies only while fresh; a failed probe is retried after a day', () => {
  _resetPromptLayoutForTest();
  const base = 'https://provider.example/v1/';
  const now = Date.parse('2026-09-26T08:00:00.000Z');
  assert.equal(promptLayoutFor(base, 'fresh-model', now), 'system', 'unmeasured models keep the system layout');
  assert.equal(promptLayoutProbeDue(base, 'fresh-model', now), true);

  recordPromptLayoutVerdict(base, 'fresh-model', { layout: 'turn_anchor', reason: 'anchor_reused_more', measuredAt: new Date(now).toISOString(), rounds: [] });
  assert.equal(promptLayoutFor('https://provider.example/v1', 'fresh-model', now), 'turn_anchor', 'trailing slash is the same endpoint');
  assert.equal(promptLayoutProbeDue(base, 'fresh-model', now + 60_000), false);
  assert.equal(promptLayoutFor(base, 'fresh-model', now + PROMPT_LAYOUT_VERDICT_TTL_MS), 'system', 'a stale win is not used');
  assert.equal(promptLayoutProbeDue(base, 'fresh-model', now + PROMPT_LAYOUT_VERDICT_TTL_MS), true);
  assert.equal(promptLayoutFor('https://other.example/v1', 'fresh-model', now), 'system', 'verdicts are per endpoint');

  recordPromptLayoutVerdict(base, 'failing-model', { layout: 'system', reason: 'probe_failed', measuredAt: new Date(now).toISOString(), rounds: [] });
  assert.equal(promptLayoutProbeDue(base, 'failing-model', now + PROMPT_LAYOUT_FAILED_RETRY_MS - 1), false);
  assert.equal(promptLayoutProbeDue(base, 'failing-model', now + PROMPT_LAYOUT_FAILED_RETRY_MS), true);
});

/** A provider whose cache reuses the longest identical rendered prefix. */
function prefixCachingProvider(render: (body: AnyObj) => string) {
  const seen: string[] = [];
  const bodies: AnyObj[] = [];
  const create = async (body: AnyObj) => {
    bodies.push(body);
    const text = render(body);
    let best = 0;
    for (const prior of seen) {
      let i = 0;
      while (i < prior.length && i < text.length && prior[i] === text[i]) i += 1;
      best = Math.max(best, i);
    }
    seen.push(text);
    return { id: 'p', model: body.model, usage: { prompt_tokens: text.length, completion_tokens: 1, total_tokens: text.length + 1, prompt_tokens_details: { cached_tokens: best } }, choices: [] };
  };
  return { create, bodies };
}
const toolsText = (body: AnyObj): string => JSON.stringify(body.tools);
const messageText = (m: AnyObj): string => `<${String(m.role)}>${String(m.content)}`;
/** Tools after the first system message; later system messages in place. */
const inPlaceTemplate = (body: AnyObj): string => {
  const [first, ...rest] = body.messages as AnyObj[];
  return `${messageText(first)}${toolsText(body)}${rest.map(messageText).join('')}`;
};
/** Tools first; every system message gathered into one block ahead of the rest. */
const hoistingTemplate = (body: AnyObj): string => {
  const messages = body.messages as AnyObj[];
  const systems = messages.filter((m) => m.role === 'system').reverse().map((m) => String(m.content)).join('\n');
  return `${toolsText(body)}<system>${systems}${messages.filter((m) => m.role !== 'system').map(messageText).join('')}`;
};

test('measurement adopts the anchor layout where the template keeps a later system message in place', async () => {
  const provider = prefixCachingProvider(inPlaceTemplate);
  const usage: unknown[] = [];
  const verdict = await measurePromptLayout({
    baseURL: 'https://provider.example/v1',
    model: 'provider/model-a',
    create: provider.create,
    onUsage: (completion) => usage.push(completion),
    sleep: async () => {},
  });
  assert.equal(verdict.layout, 'turn_anchor');
  assert.equal(verdict.rounds.length, PROMPT_LAYOUT_PROBE_ROUNDS);
  assert.equal(provider.bodies.length, PROMPT_LAYOUT_PROBE_ROUNDS * 4 + 1);
  assert.equal(usage.length, provider.bodies.length, 'every probe call reports its spend');
  const opening = provider.bodies[provider.bodies.length - 1].messages as AnyObj[];
  assert.deepEqual(opening.map((m) => m.role), ['system', 'system', 'user'], 'the first-turn shape is checked too');
  for (const body of provider.bodies) {
    assert.equal(body.model, 'provider/model-a');
    assert.equal(body.stream, false);
    assert.equal('temperature' in body, false, 'some providers accept only their default temperature');
  }
});

test('measurement keeps the system layout where the template gathers system messages together', async () => {
  const provider = prefixCachingProvider(hoistingTemplate);
  const verdict = await measurePromptLayout({
    baseURL: 'https://provider.example/v1',
    model: 'provider/model-b',
    create: provider.create,
    sleep: async () => {},
  });
  assert.equal(verdict.layout, 'system');
  assert.equal(verdict.reason, 'anchor_not_better');
});

test('a provider that refuses the first-turn shape keeps the system layout', async () => {
  const provider = prefixCachingProvider(inPlaceTemplate);
  const verdict = await measurePromptLayout({
    baseURL: 'https://provider.example/v1',
    model: 'provider/model-g',
    create: async (body: AnyObj) => {
      const roles = (body.messages as AnyObj[]).map((m) => m.role);
      if (roles[0] === 'system' && roles[1] === 'system') throw Object.assign(new Error('bad order'), { status: 400 });
      return provider.create(body);
    },
    sleep: async () => {},
  });
  assert.equal(verdict.layout, 'system');
  assert.equal(verdict.reason, 'probe_failed');
  assert.equal(verdict.rounds.length, PROMPT_LAYOUT_PROBE_ROUNDS, 'the measured rounds are kept for inspection');
});

test('a provider error during measurement keeps the system layout and reports only the status', async () => {
  let calls = 0;
  const verdict = await measurePromptLayout({
    baseURL: 'https://provider.example/v1',
    model: 'provider/model-c',
    create: async () => {
      calls += 1;
      if (calls === 3) throw Object.assign(new Error('secret-bearing body'), { status: 403 });
      return { usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } } };
    },
    sleep: async () => {},
  });
  assert.equal(verdict.layout, 'system');
  assert.equal(verdict.reason, 'probe_failed');
  assert.equal(verdict.detail, 'provider status 403');
});

test('a scheduled measurement runs once per endpoint and model and records its verdict', async () => {
  _resetPromptLayoutForTest();
  const provider = prefixCachingProvider(inPlaceTemplate);
  const input = { baseURL: 'https://scheduled.example/v1', model: 'provider/model-d', create: provider.create, sleep: async () => {} };
  schedulePromptLayoutProbe(input);
  schedulePromptLayoutProbe(input);
  for (let i = 0; i < 50 && !readPromptLayoutVerdict(input.baseURL, input.model); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(readPromptLayoutVerdict(input.baseURL, input.model)?.layout, 'turn_anchor');
  assert.equal(provider.bodies.length, PROMPT_LAYOUT_PROBE_ROUNDS * 4 + 1, 'concurrent schedules share one measurement');
  schedulePromptLayoutProbe(input);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.bodies.length, PROMPT_LAYOUT_PROBE_ROUNDS * 4 + 1, 'a fresh verdict is not measured again');
});

test('a measurement started inside a turn runs outside it and is filed as measurement spend', async () => {
  _resetPromptLayoutForTest();
  const provider = prefixCachingProvider(inPlaceTemplate);
  const seen: Array<{ run: unknown; attribution: unknown }> = [];
  const input = {
    baseURL: 'https://detached.example/v1',
    model: 'provider/model-h',
    create: async (body: AnyObj) => {
      seen.push({ run: harnessRunContextStorage.getStore(), attribution: modelUsageAttributionStorage.getStore() });
      return provider.create(body);
    },
    sleep: async () => {},
  };
  const turn = { sessionId: 'sess-owner-turn', counter: new ToolCallsCounter() } as HarnessRunContext;
  harnessRunContextStorage.run(turn, () => withModelUsageAttribution(
    { sessionId: 'sess-owner-turn', sourceUserSeq: 42, role: 'brain' },
    () => schedulePromptLayoutProbe(input),
  ));
  for (let i = 0; i < 50 && !readPromptLayoutVerdict(input.baseURL, input.model); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(seen.length > 0);
  for (const observed of seen) {
    assert.equal(observed.run, undefined, 'the owner turn\'s run context is not inherited');
    assert.deepEqual(observed.attribution, { sessionId: 'prompt-layout-probe', sourceUserSeq: 0, channel: 'prompt-layout-probe' });
  }
});

function runContext(anchor?: string): HarnessRunContext {
  return { sessionId: 'sess-layout', counter: new ToolCallsCounter(), ...(anchor ? { modelTurnAnchor: anchor } : {}) } as HarnessRunContext;
}
function completion(): AnyObj {
  return { id: 'c', created: 1, model: 'provider/model-e', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] };
}

test('adapter: a measured win places the context at the anchor for the brain request only', async () => {
  _resetPromptLayoutForTest();
  const baseURL = 'https://wired.example/v1';
  recordPromptLayoutVerdict(baseURL, 'provider/model-e', { layout: 'turn_anchor', reason: 'anchor_reused_more', measuredAt: new Date().toISOString(), rounds: [] });
  const sent: AnyObj[] = [];
  const create = wrapCompletionsCreate(async (params) => { sent.push(params); return completion(); }, { promptLayout: { baseURL } });
  const anchor = digest('what changed this week?');

  await harnessRunContextStorage.run(runContext(anchor), () => create(brainBody({ model: 'provider/model-e' })));
  const expected = relaxRequestForCompatBackend(placeTurnContextAtAnchor(brainBody({ model: 'provider/model-e' }), anchor)!);
  assert.deepEqual(sent[0], expected);

  const judge = { model: 'provider/model-e', messages: [{ role: 'system', content: 'Judge policy' }, { role: 'user', content: 'what changed this week?' }] };
  await harnessRunContextStorage.run(runContext(anchor), () => create(judge));
  assert.deepEqual(sent[1], relaxRequestForCompatBackend(judge), 'a request without the boundary is sent as before');

  await harnessRunContextStorage.run(runContext(undefined), () => create(brainBody({ model: 'provider/model-e' })));
  assert.deepEqual(sent[2], relaxRequestForCompatBackend(brainBody({ model: 'provider/model-e' })), 'no anchor, no move');
});

test('adapter: without a measured win the request is byte-identical to the system layout', async () => {
  _resetPromptLayoutForTest();
  const baseURL = 'https://unmeasured.example/v1';
  recordPromptLayoutVerdict(baseURL, 'provider/model-f', { layout: 'system', reason: 'anchor_not_better', measuredAt: new Date().toISOString(), rounds: [] });
  const sent: AnyObj[] = [];
  const create = wrapCompletionsCreate(async (params) => { sent.push(params); return completion(); }, { promptLayout: { baseURL } });
  const body = brainBody({ model: 'provider/model-f' });
  await harnessRunContextStorage.run(runContext(digest('what changed this week?')), () => create(body));
  assert.deepEqual(sent, [relaxRequestForCompatBackend(brainBody({ model: 'provider/model-f' }))]);

  const plain = wrapCompletionsCreate(async (params) => { sent.push(params); return completion(); });
  await harnessRunContextStorage.run(runContext(digest('what changed this week?')), () => plain(brainBody({ model: 'provider/model-f' })));
  assert.deepEqual(sent[1], sent[0], 'a client without a layout endpoint behaves as before');
});

test('an inconclusive or failed re-measurement keeps the layout in use and retries after a day', async () => {
  _resetPromptLayoutForTest();
  const input = { baseURL: 'https://kept.example/v1', model: 'provider/model-k', sleep: async () => {},
    create: async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); } };
  const long = Date.now() - PROMPT_LAYOUT_VERDICT_TTL_MS - 60_000;
  recordPromptLayoutVerdict(input.baseURL, input.model, { layout: 'turn_anchor', reason: 'anchor_reused_more',
    measuredAt: new Date(long).toISOString(), rounds: [round(2_176, 7_168), round(2_176, 7_168), round(2_176, 7_040)] });
  assert.equal(promptLayoutProbeDue(input.baseURL, input.model), true, 'the old verdict expired');
  schedulePromptLayoutProbe(input);
  for (let i = 0; i < 50 && readPromptLayoutVerdict(input.baseURL, input.model)?.reason !== 'probe_failed'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const kept = readPromptLayoutVerdict(input.baseURL, input.model)!;
  assert.equal(kept.reason, 'probe_failed');
  assert.equal(kept.layout, 'turn_anchor', 'a failed measurement is no evidence against the layout in use');
  assert.equal(promptLayoutFor(input.baseURL, input.model), 'turn_anchor');
  assert.equal(promptLayoutProbeDue(input.baseURL, input.model, Date.now() + PROMPT_LAYOUT_FAILED_RETRY_MS), true);
});

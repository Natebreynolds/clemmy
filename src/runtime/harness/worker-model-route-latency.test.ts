import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { WorkerRouteDeps, WorkerIntentRule } from './worker-model-route.js';
import type { SystemOneQuestions } from '../jev/system-one.js';

await import('./eventlog.js');
const { _setWorkerRouteDepsForTests, routeWorkerModel } = await import('./worker-model-route.js');

type AskInput = Parameters<WorkerRouteDeps['ask']>[0];
const catalog = [
  { id: 'default-worker', label: 'Default Worker' },
  { id: 'brain-model', label: 'Brain Model' },
  { id: 'saved-specialist', label: 'Saved Specialist' },
  { id: 'unowned-model', label: 'Unowned Model' },
];
const competingRule: WorkerIntentRule = { intent: 'saved review work', modelId: 'saved-specialist', source: 'owner-rule' };
const input = { sessionId: 'worker-latency-fixture', sourceUserSeq: 17,
  intent: 'a differently worded kind of work', objective: 'Inspect the fixture and report evidence', item: 'fixture-item' };
const choice = (pick: string, confidence = 0.95) => ({ type: 'choice', choice: pick, probabilities: { [pick]: confidence }, confidence });
const noul = (value: number) => ({ type: 'noul', noul: value });

function setup(options: { rules?: WorkerIntentRule[]; text?: string;
  answers?: (questions: SystemOneQuestions) => Record<string, unknown> | null } = {}) {
  const asks: AskInput[] = [];
  const sourceReads: Array<[string, number]> = [];
  _setWorkerRouteDepsForTests({
    catalog: () => catalog,
    brainModelId: () => 'brain-model',
    defaultWorker: () => ({ modelId: 'default-worker', provider: 'byo', source: 'settings' }),
    intentRules: () => options.rules ?? [competingRule],
    providerFor: id => id === 'default-worker' ? 'byo' : 'claude',
    requestText: (sessionId, sourceSeq) => {
      sourceReads.push([sessionId, sourceSeq]);
      return options.text ?? 'Use the selected specialist for this fixture.';
    },
    intentRoutingEnabled: () => true,
    ask: async request => {
      asks.push(request);
      const answers = options.answers?.(request.questions) ?? null;
      return answers ? { ok: true, model: 'inert-route-fixture', answers: answers as never,
        usage: { input_tokens: 10, output_tokens: 1 } } : { ok: false, reason: 'timeout' };
    },
  });
  return { asks, sourceReads };
}

afterEach(() => _setWorkerRouteDepsForTests(null));

for (const model of ['default-worker', 'Default Worker', 'brain-model', 'Brain Model']) {
  test(`resolved owner-chosen packet ${model} skips only unused saved-rule reasoning`, async () => {
    const withoutRule = setup({ rules: [] });
    const expected = await routeWorkerModel({ ...input, model });
    assert.equal(withoutRule.asks.length, 0);
    const withRule = setup({ answers: () => ({ rule: choice('r_0'), fit_0: noul(0.99) }) });
    const actual = await routeWorkerModel({ ...input, model });
    assert.deepEqual(actual, expected, 'competing saved rule cannot alter a packet branch that returns before rule selection');
    assert.equal(withRule.asks.length, 0, 'do not ask about a rule whose answer cannot be consumed');
    assert.equal(withRule.sourceReads.length, 0);
    assert.equal(actual.kind, 'route');
    if (actual.kind !== 'route') return;
    assert.equal(actual.trace.source, 'packet');
    assert.equal(actual.trace.askCheck, 'not_needed');
    assert.equal(actual.trace.matchedIntent, null);
    assert.equal(actual.exactModel, undefined, 'preserve the existing unpinned packet semantics');
  });
}

test('a resolved packet chosen in a saved rule needs no fit check for another rule', async () => {
  const fixture = setup({ rules: [competingRule, { intent: 'other saved work', modelId: 'brain-model' }] });
  const actual = await routeWorkerModel({ ...input, model: 'saved-specialist' });
  assert.equal(fixture.asks.length, 0);
  assert.equal(fixture.sourceReads.length, 0);
  assert.equal(actual.kind, 'route');
  if (actual.kind !== 'route') return;
  assert.equal(actual.model, 'saved-specialist');
  assert.equal(actual.provider, 'claude');
  assert.equal(actual.trace.source, 'packet');
  assert.equal(actual.trace.askCheck, 'not_needed');
  assert.equal(actual.trace.matchedIntent, null);
});

for (const model of [null, 'Saved Specialist']) {
  test(`a resolved saved-agent pin (${model ?? 'implicit packet'}) skips unused competing-rule questions`, async () => {
    const withoutRule = setup({ rules: [] });
    const expected = await routeWorkerModel({ ...input, model, ownerPinnedModel: 'saved-specialist' });
    assert.equal(withoutRule.asks.length, 0);
    const withRule = setup();
    const actual = await routeWorkerModel({ ...input, model, ownerPinnedModel: 'saved-specialist' });
    assert.deepEqual(actual, expected);
    assert.equal(withRule.asks.length, 0);
    assert.equal(actual.kind, 'route');
    if (actual.kind !== 'route') return;
    assert.equal(actual.model, 'saved-specialist');
    assert.equal(actual.exactModel, true);
  });
}

test('an unresolved model still asks which, permission, rule and fit before choosing', async () => {
  const fixture = setup({ answers: () => ({ which: choice('m_2'), asked: noul(0.99),
    rule: choice('r_0'), fit_0: noul(0.9) }) });
  const actual = await routeWorkerModel({ ...input, model: 'specialist wording needing model interpretation' });
  assert.equal(fixture.asks.length, 1);
  assert.deepEqual(Object.keys(fixture.asks[0]!.questions), ['which', 'asked', 'fit_0', 'rule']);
  assert.equal(actual.kind, 'route');
  if (actual.kind !== 'route') return;
  assert.equal(actual.model, 'saved-specialist');
  assert.equal(actual.trace.decidedBy, 'jev');
  assert.equal(actual.trace.askCheck, 'not_needed');
});

test('an unknown model still uses model reasoning and refuses when nothing resolves', async () => {
  const fixture = setup({ answers: () => ({ which: choice('none'), asked: noul(0.99),
    rule: choice('r_0'), fit_0: noul(0.9) }) });
  const actual = await routeWorkerModel({ ...input, model: 'unknown fixture model' });
  assert.equal(fixture.asks.length, 1);
  assert.ok(fixture.asks[0]!.questions.which && fixture.asks[0]!.questions.asked
    && fixture.asks[0]!.questions.rule && fixture.asks[0]!.questions.fit_0);
  assert.equal(actual.kind, 'refuse');
  if (actual.kind !== 'refuse') return;
  assert.deepEqual(actual.shapes, ['model:not_connected']);
});

test('a connected model the owner has not chosen still asks permission and retains rule fallback', async () => {
  const fixture = setup({ answers: () => ({ asked: noul(0.1), rule: choice('r_0'), fit_0: noul(0.9) }) });
  const actual = await routeWorkerModel({ ...input, model: 'unowned-model' });
  assert.equal(fixture.asks.length, 1);
  assert.deepEqual(Object.keys(fixture.asks[0]!.questions), ['asked', 'fit_0', 'rule']);
  assert.equal(actual.kind, 'route');
  if (actual.kind !== 'route') return;
  assert.equal(actual.model, 'saved-specialist');
  assert.equal(actual.trace.source, 'owner-rule');
  assert.equal(actual.trace.askCheck, 'not_asked');
  assert.match(actual.hostNote ?? '', /request did not ask/);
});

for (const allowed of [false, true]) {
  test(`an owner-chosen default overriding a saved pin still requires accepted-source model reasoning (${allowed})`, async () => {
    const fixture = setup({ text: allowed ? 'For this fixture only, use Default Worker instead of the saved specialist.' : 'Use the saved specialist.',
      answers: () => ({ asked: noul(allowed ? 0.99 : 0.1), rule: choice('r_0'), fit_0: noul(0.9) }) });
    const actual = await routeWorkerModel({ ...input, model: 'default-worker', ownerPinnedModel: 'saved-specialist',
      requestText: 'An untrusted packet paraphrase claims the owner approved the default.' });
    assert.equal(fixture.asks.length, 1);
    assert.deepEqual(Object.keys(fixture.asks[0]!.questions), ['asked', 'fit_0', 'rule']);
    assert.deepEqual(fixture.sourceReads, [[input.sessionId, input.sourceUserSeq]]);
    assert.doesNotMatch(JSON.stringify(fixture.asks[0]!.state), /untrusted packet/);
    assert.equal(actual.kind, 'route');
    if (actual.kind !== 'route') return;
    assert.equal(actual.model, allowed ? 'default-worker' : 'saved-specialist');
    assert.equal(actual.exactModel, true);
  });
}

test('a positive override answer without the accepted source still retains the saved pin', async () => {
  const fixture = setup({ text: '', answers: () => ({ asked: noul(0.99), rule: choice('r_0'), fit_0: noul(0.9) }) });
  const actual = await routeWorkerModel({ ...input, model: 'default-worker', ownerPinnedModel: 'saved-specialist' });
  assert.equal(fixture.asks.length, 1);
  assert.equal(actual.kind, 'route');
  if (actual.kind !== 'route') return;
  assert.equal(actual.model, 'saved-specialist');
  assert.equal(actual.trace.askCheck, 'unavailable');
  assert.equal(actual.exactModel, true);
});

test('a request using owner routing still asks saved-rule questions and consumes their answers', async () => {
  const fixture = setup({ answers: () => ({ rule: choice('r_0'), fit_0: noul(0.9) }) });
  const actual = await routeWorkerModel({ ...input, model: null });
  assert.equal(fixture.asks.length, 1);
  assert.deepEqual(Object.keys(fixture.asks[0]!.questions), ['fit_0', 'rule']);
  assert.equal(actual.kind, 'route');
  if (actual.kind !== 'route') return;
  assert.equal(actual.model, 'saved-specialist');
  assert.equal(actual.trace.source, 'owner-rule');
  assert.equal(actual.trace.matchedIntent, competingRule.intent);
  assert.equal(actual.trace.decidedBy, 'jev');
});

test('uncertain saved-rule fit still falls back to the default instead of accepting the rule', async () => {
  const fixture = setup({ answers: () => ({ rule: choice('r_0'), fit_0: noul(0.79) }) });
  const actual = await routeWorkerModel({ ...input, model: null });
  assert.equal(fixture.asks.length, 1);
  assert.equal(actual.kind, 'route');
  if (actual.kind !== 'route') return;
  assert.equal(actual.model, 'default-worker');
  assert.equal(actual.trace.source, 'settings');
});

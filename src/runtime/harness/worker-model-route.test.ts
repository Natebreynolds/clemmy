/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/worker-model-route.test.ts
 *
 * The helper-model decision. Live 2026-09-25 (fixture turn opus-handoff-1):
 * the brain wrote a packet model name no connected model carries, the helper
 * was quietly re-routed to another provider's model, and five helpers ran on
 * a model nobody chose before the brain noticed and paid for the work again.
 * These pins hold the replacement contract: a name resolves to a connected
 * model or is refused before anything runs; a model the owner has not chosen
 * runs only when the request asked for it; saved rules route by kind of work.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { WorkerRouteDeps } from './worker-model-route.js';
import type { SystemOneQuestions } from '../jev/system-one.js';

// The event log first, as production loads it: the route module sits under
// the orchestrator and is never the first harness module to evaluate.
await import('./eventlog.js');
const { _setWorkerRouteDepsForTests, routeWorkerModel } = await import('./worker-model-route.js');

type AskInput = Parameters<WorkerRouteDeps['ask']>[0];

const CATALOG = [
  { id: 'fast-default', label: 'Fast Default' },
  { id: 'flagship-writer', label: 'Flagship Writer' },
  { id: 'mid-reviewer', label: 'Mid Reviewer' },
];

function setup(options: {
  rules?: Array<{ intent: string; modelId: string }>;
  answers?: (questions: SystemOneQuestions) => Record<string, unknown> | null;
  requestText?: string;
} = {}) {
  const asks: AskInput[] = [];
  _setWorkerRouteDepsForTests({
    catalog: () => CATALOG,
    brainModelId: () => 'fast-default',
    defaultWorker: () => ({ modelId: 'fast-default', provider: 'byo', source: 'settings' }),
    intentRules: () => options.rules ?? [],
    providerFor: (id) => (id === 'fast-default' ? 'byo' : 'claude'),
    requestText: () => options.requestText ?? 'Audit the site, then write five emails. Use the flagship writer for the emails.',
    intentRoutingEnabled: () => true,
    ask: async (input) => {
      asks.push(input);
      const answers = options.answers?.(input.questions) ?? null;
      return answers
        ? { ok: true, model: 'jev-test', answers: answers as never, usage: { input_tokens: 10, output_tokens: 1 } }
        : { ok: false, reason: 'timeout' };
    },
  });
  return asks;
}

const choice = (pick: string, confidence: number) => ({ type: 'choice', choice: pick, probabilities: { [pick]: confidence }, confidence });
const noul = (value: number) => ({ type: 'noul', noul: value });

afterEach(() => _setWorkerRouteDepsForTests(null));

test('an exact connected id the owner already uses runs with no Jev call', async () => {
  const asks = setup();
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: 'fast-default', intent: null, objective: 'Summarize one page', item: 'a' });
  assert.equal(decision.kind, 'route');
  assert.equal(decision.kind === 'route' && decision.model, 'fast-default');
  assert.equal(asks.length, 0);
});

test('a wording no connected id carries is mapped by Jev onto the connected model it names', async () => {
  const asks = setup({ answers: () => ({ which: choice('m_1', 0.93), asked: noul(0.96) }) });
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: 'writer-flagship', intent: 'outbound email writing', objective: 'Write one cold email per angle', item: 'speed' });
  assert.equal(decision.kind, 'route');
  if (decision.kind !== 'route') return;
  assert.equal(decision.model, 'flagship-writer');
  assert.equal(decision.trace.decidedBy, 'jev');
  assert.equal(decision.trace.askCheck, 'asked');
  assert.equal(decision.trace.requestedModel, 'writer-flagship');
  assert.match(decision.hostNote ?? '', /flagship-writer/);
  assert.deepEqual(decision.offer, { intent: 'outbound email writing', modelId: 'flagship-writer', modelName: 'Flagship Writer' });
  // One request carries every question; the request is Jev's state.
  assert.equal(asks.length, 1);
  assert.ok(asks[0]!.questions.which && asks[0]!.questions.asked);
  assert.match(JSON.stringify(asks[0]!.state), /Use the flagship writer/);
});

test('a name nothing resolves is refused with the connected ids, never swapped for another model', async () => {
  setup({ answers: () => ({ which: choice('none', 0.9), asked: noul(0.9) }) });
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: 'unknown-model-9', intent: null, objective: 'Write an email', item: 'a' });
  assert.equal(decision.kind, 'refuse');
  if (decision.kind !== 'refuse') return;
  assert.deepEqual(decision.shapes, ['model:not_connected']);
  for (const model of CATALOG) assert.match(decision.reason, new RegExp(model.id));
  assert.match(decision.reason, /no helper started/);
});

test('an unsure mapping is refused too: below the bar is not a match', async () => {
  setup({ answers: () => ({ which: choice('m_1', 0.55), asked: noul(0.99) }) });
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: 'writer-ish', intent: null, objective: 'Write an email', item: 'a' });
  assert.equal(decision.kind, 'refuse');
});

test('when Jev cannot answer, an unresolved name is still refused rather than guessed', async () => {
  setup({ answers: () => null });
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: 'writer-flagship', intent: null, objective: 'Write an email', item: 'a' });
  assert.equal(decision.kind, 'refuse');
});

test('a model the owner has not chosen and the request did not ask for runs on the owner routing, with a note', async () => {
  setup({
    requestText: 'What is on my calendar tomorrow?',
    answers: () => ({ asked: noul(0.04) }),
  });
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: 'flagship-writer', intent: null, objective: 'Read tomorrow calendar', item: 'cal' });
  assert.equal(decision.kind, 'route');
  if (decision.kind !== 'route') return;
  assert.equal(decision.model, 'fast-default');
  assert.equal(decision.trace.askCheck, 'not_asked');
  assert.match(decision.hostNote ?? '', /not Flagship Writer/);
  assert.equal(decision.offer, undefined);
});

test('an unavailable ask check does not block an exact connected model, and says so in the trace', async () => {
  setup({ answers: () => null });
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: 'flagship-writer', intent: 'emails', objective: 'Write an email', item: 'a' });
  assert.equal(decision.kind, 'route');
  if (decision.kind !== 'route') return;
  assert.equal(decision.model, 'flagship-writer');
  assert.equal(decision.trace.askCheck, 'unavailable');
  assert.equal(decision.offer, undefined, 'only a confirmed ask earns a save offer');
});

test('a saved rule matched by the exact word routes with no Jev call', async () => {
  const asks = setup({ rules: [{ intent: 'outbound-email-writing', modelId: 'flagship-writer', source: 'chat-rule' }] });
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: null, intent: 'Outbound email writing', objective: 'Write one cold email', item: 'a' });
  assert.equal(decision.kind, 'route');
  if (decision.kind !== 'route') return;
  assert.equal(decision.model, 'flagship-writer');
  assert.equal(decision.trace.source, 'chat-rule', 'the trace names where the owner saved the rule');
  assert.equal(decision.trace.matchedIntent, 'outbound-email-writing');
  assert.equal(asks.length, 0);
});

test('a saved rule in different words is picked by Jev only when the pick is sure and fits', async () => {
  const rules = [{ intent: 'design', modelId: 'mid-reviewer' }, { intent: 'outbound emails', modelId: 'flagship-writer' }];
  setup({ rules, answers: () => ({ rule: choice('r_1', 0.88), fit_0: noul(0.05), fit_1: noul(0.92) }) });
  const picked = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: null, intent: 'prospecting copy', objective: 'Write a cold email', item: 'a' });
  assert.equal(picked.kind === 'route' && picked.model, 'flagship-writer');
  assert.equal(picked.kind === 'route' && picked.trace.decidedBy, 'jev');

  setup({ rules, answers: () => ({ rule: choice('r_1', 0.88), fit_0: noul(0.05), fit_1: noul(0.4) }) });
  const lowFit = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: null, intent: 'prospecting copy', objective: 'Write a cold email', item: 'a' });
  assert.equal(lowFit.kind === 'route' && lowFit.model, 'fast-default');
});

test('no model named and no saved rules: the default helper model, and no Jev call', async () => {
  const asks = setup();
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: null, intent: 'research', objective: 'Read one page', item: 'a' });
  assert.equal(decision.kind === 'route' && decision.model, 'fast-default');
  assert.equal(asks.length, 0);
});

test('no offer when a saved rule already puts that model on that kind of work', async () => {
  setup({
    rules: [{ intent: 'emails', modelId: 'flagship-writer' }],
    answers: () => ({ asked: noul(0.97) }),
  });
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: 'flagship-writer', intent: 'emails', objective: 'Write an email', item: 'a' });
  assert.equal(decision.kind === 'route' && decision.model, 'flagship-writer');
  assert.equal(decision.kind === 'route' ? decision.offer : 'refused', undefined);
});

test("a model pinned on the saved agent the work runs as is the owner's choice: it runs, with no ask", async () => {
  const asks = setup({
    requestText: 'Hand Design Studio this brief and bring back its design.',
    answers: () => ({ asked: noul(0.03) }),
  });
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: 'flagship-writer', ownerPinnedModel: 'flagship-writer', intent: 'design', objective: 'Design the landing page', item: 'design' });
  assert.equal(decision.kind, 'route');
  if (decision.kind !== 'route') return;
  assert.equal(decision.model, 'flagship-writer', 'the agent runs on the model it is pinned to');
  assert.equal(decision.trace.askCheck, 'not_needed');
  assert.equal(decision.hostNote, undefined);
  assert.equal(asks.length, 0, 'an owner pin needs no check of the wording');
});

test('a pin on the agent does not cover a different model the call names', async () => {
  setup({
    requestText: 'Hand Design Studio this brief.',
    answers: () => ({ asked: noul(0.03) }),
  });
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: 'mid-reviewer', ownerPinnedModel: 'flagship-writer', intent: null, objective: 'Design', item: 'design' });
  assert.equal(decision.kind, 'route');
  if (decision.kind !== 'route') return;
  assert.equal(decision.model, 'flagship-writer', 'a packet choice never erases the saved pin');
  assert.equal(decision.trace.askCheck, 'not_asked');
  assert.equal(decision.exactModel, true);
});

test('even the normal default needs accepted-source evidence to override a saved specialist pin', async () => {
  for (const answer of [null, { asked: noul(0.2) }, { asked: noul(0.95) }]) {
    const asks = setup({ requestText: 'For this request only, use Fast Default on Design Studio.', answers: () => answer });
    const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 7, model: 'fast-default',
      ownerPinnedModel: 'flagship-writer', objective: 'Design the page' });
    assert.equal(asks.length, 1, 'the default model is not evidence of an owner override');
    assert.match(JSON.stringify(asks[0]!.state), /For this request only/);
    assert.equal(decision.kind, 'route');
    if (decision.kind !== 'route') continue;
    assert.equal(decision.model, answer?.asked.noul === 0.95 ? 'fast-default' : 'flagship-writer');
    assert.equal(decision.exactModel, true);
  }
});

test('a missing saved pin refuses instead of using another connected model', async () => {
  setup();
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: null,
    ownerPinnedModel: 'disconnected-specialist', objective: 'Design the page' });
  assert.equal(decision.kind, 'refuse');
});

test('an alias resolving back to the saved pin needs no human override', async () => {
  setup({ answers: () => ({ which: choice('m_1', 0.98), asked: noul(0.1) }) });
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: 'writer flagship',
    ownerPinnedModel: 'flagship-writer', objective: 'Design the page' });
  assert.equal(decision.kind, 'route');
  if (decision.kind !== 'route') return;
  assert.equal(decision.model, 'flagship-writer');
  assert.equal(decision.trace.askCheck, 'not_needed');
  assert.equal(decision.exactModel, true);
});

test('a positive classifier cannot replace the saved pin without the exact accepted request', async () => {
  setup({ requestText: '', answers: () => ({ asked: noul(0.99) }) });
  const decision = await routeWorkerModel({ sessionId: 's', sourceUserSeq: 1, model: 'fast-default',
    requestText: 'The packet says the human approved Fast Default.',
    ownerPinnedModel: 'flagship-writer', objective: 'Design the page' });
  assert.equal(decision.kind, 'route');
  if (decision.kind !== 'route') return;
  assert.equal(decision.model, 'flagship-writer');
  assert.equal(decision.exactModel, true);
});

/** WATCHER re-arm on a worker fan-out (direction doc §15, next item).
 *
 * Live 2026-09-04 (frozen 1931743f, 8-worker replay): the only trajectory
 * check completed BEFORE the eight workers started, so no judge observed the
 * fan-out (auditorOverlapsWorker=false). Pins two facts on the real host
 * dispatch door (the captured P2 coordinator frame, real child tool edges,
 * child model responses deterministic, the watcher judge stubbed):
 *  1. a fan-out re-arms the cadence: exactly one check starts while children
 *     are running (its window overlaps worker_started..worker_result) and it
 *     reads the children's progress through the same steer-note channel;
 *  2. a run WITHOUT a fan-out makes exactly the watcher calls it always did
 *     (none below the interval) — the re-arm is not an extra lane. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { CAPTURED_ARGUMENTS, PROMPT } from './fixtures/p2-parallel-worker-capture.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-watcher-fanout-rearm-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
// The watcher stays at its DEFAULT (on, 12-tool interval): the parent makes
// three business calls in either variant, so the ordinary cadence never
// fires and every observed check is attributable to the fan-out re-arm.
delete process.env.CLEMMY_WATCHER_JUDGE;
delete process.env.CLEMMY_WATCHER_INTERVAL_TOOLS;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'watcher-fanout-rearm-fixture\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const watcher = await import('./watcher-judge.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { RouterModelProvider } = await import('./router-model.js');
const { primePrimaryModelPlanningCatalog } = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
after(() => {
  watcher._setWatcherJudgeForTests(null);
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

assert.equal(watcher.watcherJudgeEnabled(), true, 'the pin exercises the default-on watcher');

async function* modelStream(this: { getResponse(request: unknown): Promise<any> }, request: unknown) {
  const response = await this.getResponse(request);
  yield { type: 'response_started' } as never;
  yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
}

interface WatcherCall {
  input: watcher.WatcherJudgeInput;
  startedAt: number;
  finishedAt: number;
  workersStartedAtEntry: number;
  workersReturnedAtEntry: number;
  workersReturnedAtExit: number;
}

for (const variant of ['fanout', 'no_fanout'] as const) test(`watcher cadence re-arms on a worker fan-out and only then (${variant})`, async (t) => {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const session = eventlog.createSession({ id: `watcher-fanout-rearm-${variant}`, kind: 'chat' });
  const args = JSON.parse(CAPTURED_ARGUMENTS);
  const noncePath = path.join(TEST_HOME, `worker-nonces-${variant}.json`);
  writeFileSync(noncePath, JSON.stringify({ items: Object.fromEntries(args.items.map((item: string) => [item, `fixture-${item}`])) }));
  const oldPath = '/private/tmp/clem-p2-audit.Suyi4z/home/probe/worker-sources.json';
  const oldFrozen = '/private/tmp/clem-p2-frozen.BgMA1B';
  const frozen = path.join(TEST_HOME, `frozen-${variant}`);
  mkdirSync(path.join(frozen, 'apps', 'desktop'), { recursive: true });
  writeFileSync(path.join(frozen, 'package.json'), JSON.stringify({ name: 'clemmy', version: '3.16.0' }));
  writeFileSync(path.join(frozen, 'apps', 'desktop', 'package.json'), JSON.stringify({ name: 'clemmy-desktop', version: '3.16.0' }));
  const argumentsJson = CAPTURED_ARGUMENTS.replace(oldPath, noncePath);
  const prompt = PROMPT.replaceAll(oldPath, noncePath).replaceAll(oldFrozen, frozen);
  // Produce actual prior-source settlements and balanced history. Fake old
  // tool results cannot stand in for the checkpoint-owned transcript.
  const oldSource = eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'Read all fourteen local fixture files.' } });
  const priorFiles = Array.from({ length: 14 }, (_, i) => {
    const file = path.join(frozen, `prior-${i}.json`);
    writeFileSync(file, JSON.stringify({ index: i }));
    return file;
  });
  watcher._setWatcherJudgeForTests(async () => ({ onTrack: true, miss: '', steer: '' }));
  let oldSteps = 0;
  const oldModel = {
    async getResponse() {
      return { responseId: `prior-${++oldSteps}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: oldSteps === 1 ? priorFiles.map((file, i) => ({ type: 'function_call', callId: `prior-read-${i}`, name: 'read_file', arguments: JSON.stringify({ path: file, max_chars: null }) }))
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fourteen prior reads retained.' }] }],
      };
    }, getStreamedResponse: modelStream,
  };
  const oldPrime = await primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: oldSource.seq });
  assert.ok(oldPrime.ok);
  if (!oldPrime.ok) return;
  const oldAgent = await buildOrchestratorAgent({ sessionId: session.id, sourceUserSeq: oldSource.seq,
    userInput: 'Read all fourteen local fixture files.', hostFreshPlanning: oldPrime.planning,
    allowedToolNames: ['read_file'], model: oldModel as never,
    mcpToolScope: { authority: 'none', reason: 'prior source fixture', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
  });
  const oldRunner = new EventEmitter();
  const oldOutcome = await brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: oldSource.seq,
    counter: new brackets.ToolCallsCounter(30), behaviorScopeId: `${session.id}::old`,
  }, () => hostRunRunner(oldRunner as never, oldAgent as never, [{ type: 'message', role: 'user', content: 'Read all fourteen local fixture files.' }] as never,
    { maxTurns: 3, hostTurnEngine: 'host_v1', hostJudgeCompletion: false, context: { sessionId: session.id, sourceUserSeq: oldSource.seq } } as never));
  assert.equal(oldOutcome.terminal, undefined);
  assert.equal(oldSteps, 2);
  const oldHistory = oldOutcome.history;
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: prompt } });

  // The stubbed watcher judge: records its observation window against the
  // children's progress in the PARENT eventlog, then holds until at least one
  // worker has returned (bounded) so the window provably extends into the
  // batch. It never steers: the run must be byte-identical to a silent judge.
  const watcherCalls: WatcherCall[] = [];
  const workerEvents = (type: 'worker_started' | 'worker_result') => eventlog.listEvents(session.id, { types: [type] }).length;
  watcher._setWatcherJudgeForTests(async (input) => {
    const startedAt = Date.now();
    const workersStartedAtEntry = workerEvents('worker_started');
    const workersReturnedAtEntry = workerEvents('worker_result');
    const deadline = Date.now() + 10_000;
    while (workerEvents('worker_result') === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    watcherCalls.push({
      input, startedAt, finishedAt: Date.now(), workersStartedAtEntry, workersReturnedAtEntry,
      workersReturnedAtExit: workerEvents('worker_result'),
    });
    return { onTrack: true, miss: '', steer: '' };
  });

  // Mock only the model provider for the children (same door as the dispatch pin).
  const childStates = new Map<string, { steps: number; packet?: { item: string } }>();
  const originalGetModel = RouterModelProvider.prototype.getModel;
  RouterModelProvider.prototype.getModel = function () {
    return {
      async getResponse(request: { input: unknown }) {
        const scope = brackets.harnessRunContextStorage.getStore();
        assert.equal(scope?.workerScope, true, 'children remain compose-only');
        const childState = childStates.get(scope!.sessionId) ?? { steps: 0 };
        childStates.set(scope!.sessionId, childState);
        let packet = childState.packet;
        if (!packet) {
          const strings: string[] = [];
          const collect = (value: unknown): void => {
            if (typeof value === 'string') strings.push(value);
            else if (Array.isArray(value)) value.forEach(collect);
            else if (value && typeof value === 'object') Object.values(value).forEach(collect);
          };
          collect(request.input);
          const content = strings.find((value) => value.includes('Packet JSON:\n'));
          assert.ok(content, 'the actual parent packet must reach the child model');
          packet = JSON.parse(content.split('Packet JSON:\n').at(-1)!);
          childState.packet = packet;
        }
        const childSteps = ++childState.steps;
        // A real child spends wall-clock; give the batch a window to overlap.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { responseId: `child-${packet!.item}-${childSteps}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: childSteps === 1
            ? [{ type: 'function_call', callId: `child-read-${packet!.item}`, name: 'read_file', arguments: JSON.stringify({ path: noncePath, max_chars: null }) }]
            : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `ITEM=${packet!.item} NONCE=fixture-${packet!.item}` }] }],
        };
      }, getStreamedResponse: modelStream,
    } as never;
  };
  t.after(() => { RouterModelProvider.prototype.getModel = originalGetModel; });

  // Parent brain, the captured P2 frame: one step of business calls — the
  // eight-item batch (fanout) or the two plain package reads (no_fanout) —
  // then the completion reply. Both sit far below the 12-call interval.
  let modelCalls = 0;
  const model = {
    async getResponse(request: { tools?: Array<{ name?: string }> }) {
      modelCalls += 1;
      if (modelCalls === 1) assert.ok(request.tools?.some((entry) => entry.name === 'run_worker'), 'the real model request advertises the worker');
      const read = (callId: string, file: string) => ({ type: 'function_call', callId, name: 'read_file', arguments: JSON.stringify({ path: file, max_chars: null }) });
      const output = modelCalls === 1
        ? variant === 'fanout'
          ? [{ type: 'function_call', callId: 'call_tBgF4tuqvCC6jxh3iTwnogOO', name: 'run_worker', arguments: argumentsJson }]
          : [read('parent-read-1', path.join(frozen, 'package.json')), read('parent-read-2', path.join(frozen, 'apps', 'desktop', 'package.json'))]
        : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: variant === 'fanout' ? 'The worker returned all eight fixture results.' : 'Both package reads are retained: clemmy 3.16.0 and clemmy-desktop 3.16.0 match.' }] }];
      return { responseId: `parent-response-${modelCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output };
    },
    getStreamedResponse: modelStream,
  };
  const primed = await primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.ok(primed.ok);
  if (!primed.ok) return;
  const agent = await buildOrchestratorAgent({
    sessionId: session.id, sourceUserSeq: source.seq, userInput: prompt,
    hostFreshPlanning: primed.planning,
    allowedToolNames: ['run_worker', 'read_file'],
    mcpToolScope: { authority: 'none', reason: 'watcher re-arm fixture', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
    model: model as never,
  });
  const runner = new EventEmitter();
  Object.assign(runner, { run() { throw new Error('The legacy model loop must never run'); } });
  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id, sourceUserSeq: source.seq, counter: new brackets.ToolCallsCounter(6), behaviorScopeId: `${session.id}::turn:1`,
  }, () => hostRunRunner(runner as never, agent as never, [...oldHistory, { type: 'message', role: 'user', content: prompt }] as never, {
    maxTurns: 4, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq },
  } as never));
  assert.equal(Boolean(outcome.hasInterruptions), false);
  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome.terminal));
  // Let a still-running (illegitimate) background check land before counting.
  await new Promise((resolve) => setTimeout(resolve, 50));

  if (variant === 'no_fanout') {
    assert.equal(workerEvents('worker_started'), 0);
    assert.equal(modelCalls, 2);
    assert.deepEqual(watcherCalls, [], 'no fan-out: the cadence alone decides, and two calls sit below the interval');
    return;
  }

  const started = eventlog.listEvents(session.id, { types: ['worker_started'] });
  const results = eventlog.listEvents(session.id, { types: ['worker_result'] });
  assert.equal(started.length, 8);
  assert.equal(results.length, 8);
  assert.equal(results.filter((event) => event.data.ok === true).length, 8);
  assert.equal(watcherCalls.length, 1, `one re-armed check per batch: ${JSON.stringify(watcherCalls.map((call) => call.input.toolCallSummary))}`);
  const [check] = watcherCalls;
  // The observation window overlaps worker_started..worker_result: it opened
  // after the first worker started and before the last worker returned, and
  // it closed after at least one worker had returned.
  assert.ok(check!.workersStartedAtEntry >= 1, 'the check starts after the batch is known to have started');
  assert.ok(check!.workersReturnedAtEntry < 8, `the check starts before the batch settles (${check!.workersReturnedAtEntry} returned at entry)`);
  assert.ok(check!.workersReturnedAtExit >= 1, 'the window extends into the batch');
  const firstStartedAt = Date.parse(started[0]!.createdAt);
  const lastResultAt = Math.max(...results.map((event) => Date.parse(event.createdAt)));
  assert.ok(check!.startedAt <= lastResultAt + 1 && check!.finishedAt >= firstStartedAt - 1,
    `window [${check!.startedAt}, ${check!.finishedAt}] must overlap workers [${firstStartedAt}, ${lastResultAt}]`);
  // Same channel, same inputs as the cadence check, plus the children's progress.
  assert.match(check!.input.objective, /parallel auditor acceptance/);
  assert.doesNotMatch(check!.input.toolCallSummary, /read_file×14|read_file×16/, 'prior-source calls never enter the current watcher evidence');
  assert.match(check!.input.toolCallSummary, /parallel workers: \d+ started \(audit-\d/);
  // The coordinator call is still OPEN while its children run, so the parent
  // trajectory count is the settled business-call count the cadence uses (0).
  assert.equal(check!.input.toolCallCount, 0);
  // The on-track verdict spent a check, never an injection or an authority.
  assert.equal(eventlog.listEvents(session.id, { types: ['goal_alignment_judged'] }).filter((event) => event.data.kind === 'watcher').length, 0);
  assert.equal(eventlog.listEvents(session.id, { types: ['awaiting_user_input', 'external_write_succeeded'] }).length, 0);
});

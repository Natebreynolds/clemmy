import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  HOST_MODEL_STALL_BLOCKED_TEXT,
  HOST_RESULT_CHECKPOINT_BLOCKED_TEXT,
  HOST_STOP_AND_EXPLAIN_BLOCKED_TEXT,
  HOST_TOOL_UNCERTAIN_BLOCKED_TEXT,
  hostStopNarrationDirective,
  isNarratableHostStop,
} from './host-turn-runner.js';

const blocked = (finalOutput: string) => ({ finalOutput, terminal: { status: 'blocked' as const, reason: 'x' } }) as never;

test('a host stop the model can explain is narrated by Clem, not shipped as the host sentence', () => {
  assert.equal(isNarratableHostStop(blocked(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT)), true);
  assert.equal(isNarratableHostStop(blocked(`${HOST_STOP_AND_EXPLAIN_BLOCKED_TEXT}\n\nRetained work (durable checkpoint):\n- x`)), true);
});

test('a stop about the model itself, or about bytes that must not reach a model, keeps the host sentence', () => {
  assert.equal(isNarratableHostStop(blocked(HOST_MODEL_STALL_BLOCKED_TEXT)), false);
  assert.equal(isNarratableHostStop(blocked(HOST_RESULT_CHECKPOINT_BLOCKED_TEXT)), false);
});

test('only blocked terminals are narrated', () => {
  assert.equal(isNarratableHostStop({ finalOutput: 'Done.', terminal: { status: 'completed' } } as never), false);
  assert.equal(isNarratableHostStop({ finalOutput: '', terminal: { status: 'blocked' } } as never), false);
});

test('the narration directive carries the host fact and asks for Clem\'s words with no tools and no machine terms', () => {
  const directive = hostStopNarrationDirective(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
  assert.ok(directive.startsWith('[turn-facts:v1]'));
  assert.ok(directive.includes(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT));
  assert.match(directive, /Machine detail: tool_effect_uncertain/);
  assert.match(directive, /as yourself/);
  assert.match(directive, /Do not call tools/);
  assert.match(directive, /Do not mention the harness, checkpoints, reconciliation, tool names, ids or handles/);
});

test('narration is on in production and opt-in under the test runner, so exact model-call counts keep their meaning', async () => {
  const runner = await import('./host-turn-runner.js');
  assert.equal(typeof runner._setHostStopNarrationForTests, 'function');
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this file runs under the test runner');
});

async function runNarratedHostFixture(stopInsideNarrator = false, foreignNarrationInput = false, tokenLimit?: number) {
  const { BASE_DIR } = await import('../../config.js');
  assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1', 'this fixture requires the isolated runner');
  mkdirSync(path.join(BASE_DIR, 'state'), { recursive: true });
  writeFileSync(path.join(BASE_DIR, 'state', 'machine-id'), 'host-stop-narration-fixture\n');
  const events = await import('./eventlog.js');
  const brackets = await import('./brackets.js');
  const catalogs = await import('./host-capability-catalog-factory.js');
  const envelope = await import('../../agents/capability-envelope.js');
  const scope = await import('./accepted-source-catalog-scope.js');
  const usage = await import('../usage-log.js');
  const host = await import('./host-turn-runner.js');
  const provenance = await import('./model-request-provenance.js');
  const sourceBudget = await import('./source-budget-policy.js');
  const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
  const priorBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  host._setHostStopNarrationForTests(true);
  try {
    catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
    const label = `${stopInsideNarrator}-${foreignNarrationInput}-${tokenLimit ?? 'default'}`;
    const session = events.createSession({ id: `narrated-host-${label}`, kind: 'chat' });
    const attempt = events.beginRunAttempt(session.id, { runId: `narrated-run-${label}` });
    const prompt = 'Read the exact named fixture operation and retain its real outcome.';
    const source = events.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: prompt } }, { armRunInFlight: true });
    const operationId = 'NARRATOR_FIXTURE_NOT_PROVISIONED';
    const carrier = brackets.wrapToolForHarness({
      type: 'function', name: 'call_tool', description: 'Call a frozen operation.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, args_json: { type: 'string' } }, required: ['name', 'args_json'] },
      needsApproval: async () => false,
      invoke: async () => { throw new Error('no fixture business dispatch is permitted'); },
    });
    const requests: Array<{ input: unknown; tools?: unknown[]; signal?: AbortSignal }> = [];
    const model = {
      async getResponse(request: { input: unknown; tools?: unknown[]; signal?: AbortSignal }) {
        requests.push(request);
        const narration = requests.length === 2;
        if (narration) assert.equal(brackets.harnessRunContextStorage.getStore()?.callerCancelSignal, request.signal,
          'the existing rescue lane sees the same current narrator cancellation authority');
        const responseId = `narration-fixture-${label}-${requests.length}`;
        // The fake adapter is the only accounting producer, just like the
        // production adapter; the narrator must never add a second row.
        usage.recordModelUsage({ sessionId: 'unknown', model: 'fixture-model', requestModel: 'fixture-model',
          providerReportedModel: 'fixture-served-model', cacheDialect: 'inclusive', inputTokens: 10,
          cachedInputTokens: 2, outputTokens: 1, durationMs: 1, responseId,
          framePromptComponents: { enclosingFrame: 999 }, ok: true });
        if (narration && stopInsideNarrator) events.requestKill(session.id, 'owner stop', { attemptId: attempt.attemptId });
        return { responseId, usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
          output: narration
            ? [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'I could not begin the named operation. Reconnect its account before trying again.' }] }]
            : [{ type: 'function_call', callId: 'narration-refused-call', name: 'call_tool', arguments: JSON.stringify({ name: operationId, args_json: '{}' }) }],
        };
      },
      async *getStreamedResponse(request: { input: unknown; tools?: unknown[]; signal?: AbortSignal }) {
        const response = await this.getResponse(request);
        yield { type: 'response_started' } as never;
        yield { type: 'model', event: { type: 'finish', finishReason: 'tool_calls' } } as never;
        yield { type: 'response_done', response } as never;
      },
    };
    const agent = { model, tools: [carrier] };
    const sealed = envelope.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: [carrier],
      activeToolNames: ['call_tool'], policyHash: 'host-narrator-fixture',
      budget: { maxUncachedTokens: 1_000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 60_000 } });
    assert.equal(sealed.ok, true);
    if (!sealed.ok) throw new Error('fixture envelope unavailable');
    envelope.bindAgentCapabilityEnvelope(agent, sealed.envelope);
    envelope.bindAgentCapabilityRevision(agent, sealed.revision);
    const runner = Object.assign(new EventEmitter(), { run() { throw new Error('legacy runner must not execute'); } });
    const outcome = await scope.withAcceptedSourceCatalogManifestScope({ manifestIds: ['cap:narration:missing'], operationIds: [operationId] },
      () => usage.withModelUsageAttribution({ sessionId: session.id, sourceUserSeq: source.seq, attemptId: attempt.attemptId, role: 'brain' },
      () => brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: source.seq, runAttemptId: attempt.attemptId,
        counter: new brackets.ToolCallsCounter(8), behaviorScopeId: `${session.id}::turn:1` },
      () => host.hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: prompt }] as never,
        { maxTurns: 4, hostTurnEngine: 'host_v1', hostJudgeCompletion: false, context: { sessionId: session.id, sourceUserSeq: source.seq },
          ...(tokenLimit !== undefined ? { maxRunTokens: tokenLimit, maxWallClockMs: 60_000 } : {}),
          callModelInputFilter: ({ modelData, advertisedTools }: { modelData: { input: unknown[] }; advertisedTools: unknown[] }) => (
            foreignNarrationInput && advertisedTools.length === 0
              ? { input: [{ role: 'user', content: 'This belongs to a different accepted source.' }] }
              : modelData
          ),
        } as never))));
    const rows = events.openEventLog().prepare('SELECT record_id, request_ordinal FROM model_request_provenance WHERE session_id = ? AND source_user_seq = ? ORDER BY request_ordinal')
      .all(session.id, source.seq) as Array<{ record_id: string; request_ordinal: number }>;
    const recorded = usage.readUsageEventsForDate().filter((row) => row.source === session.id);
    const narrated = events.listEvents(session.id, { types: ['guardrail_tripped'] }).filter((row) => row.data.kind === 'host_stop_narrated');
    const budget = sourceBudget.readSourceBudgetPolicy({ sessionId: session.id, sourceUserSeq: source.seq });
    return { outcome, rows, recorded, narrated, requests, source, attempt, prompt, provenance, budget };
  } finally {
    host._setHostStopNarrationForTests(false);
    catalogs.installHostCapabilityCatalogFactory(priorCatalog);
    if (priorBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = priorBrackets;
  }
}

test('the actual tool-less narrator request is sealed and its adapter usage is attributed once to the exact source and attempt', async () => {
  const fixture = await runNarratedHostFixture();
  assert.equal(fixture.outcome.terminal?.status, 'blocked');
  assert.match(String(fixture.outcome.finalOutput), /Reconnect its account/);
  assert.equal(fixture.requests.length, 2, 'one original request plus the existing single narration');
  assert.deepEqual(fixture.requests[1]!.tools, []);
  assert.match(JSON.stringify(fixture.requests[1]!.input), /retain its real outcome/);
  assert.match(JSON.stringify(fixture.requests[1]!.input), /Failed check: literal_workflow_operation_not_frozen/);
  assert.deepEqual(fixture.rows.map((row) => row.request_ordinal), [1, 2]);
  assert.equal(fixture.provenance.projectModelRequestProvenance(fixture.rows[1]!.record_id).status, 'ok');
  assert.equal(fixture.recorded.length, 2, 'only the two fake-adapter records exist');
  const narrator = fixture.recorded.filter((row) => row.channel === 'narrator:stop');
  assert.equal(narrator.length, 1);
  assert.equal(narrator[0]!.trace?.acceptedSource, `${fixture.source.sessionId}:${fixture.source.seq}`);
  assert.equal(narrator[0]!.trace?.attemptId, fixture.attempt.attemptId);
  assert.equal(narrator[0]!.role, 'brain');
  assert.equal(narrator[0]!.requestModel, 'fixture-model');
  assert.equal(narrator[0]!.providerReportedModel, 'fixture-served-model');
  assert.equal(narrator[0]!.account, undefined, 'an adapter that does not name an account leaves it unknown');
  assert.equal(narrator[0]!.promptComponents, undefined, 'the narrator does not inherit another request’s component estimates');
  assert.equal(fixture.narrated.length, 1);
  assert.equal(fixture.narrated[0]!.data.requestOrdinal, 2);
  assert.equal(fixture.narrated[0]!.data.runAttemptId, fixture.attempt.attemptId);
});

test('an exact Stop latched during the narrator rejects its returned words without forging a narration receipt', async () => {
  const fixture = await runNarratedHostFixture(true);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.outcome.terminal?.status, 'blocked');
  assert.doesNotMatch(String(fixture.outcome.finalOutput), /Reconnect its account/);
  assert.equal(fixture.narrated.length, 0);
  assert.equal(fixture.recorded.filter((row) => row.channel === 'narrator:stop').length, 1, 'spent adapter usage is retained after Stop');
});

test('unprovable narration input keeps the existing terminal without contacting the provider or inventing usage', async () => {
  const fixture = await runNarratedHostFixture(false, true);
  assert.equal(fixture.requests.length, 1, 'only the original model call crossed the dispatch boundary');
  assert.equal(fixture.rows.length, 1);
  assert.equal(fixture.recorded.length, 1);
  assert.equal(fixture.recorded.filter((row) => row.channel === 'narrator:stop').length, 0);
  assert.equal(fixture.narrated.length, 0);
  assert.equal(fixture.outcome.terminal?.status, 'blocked');
  assert.doesNotMatch(String(fixture.outcome.finalOutput), /Reconnect its account/);
});

test('narration uses the captured enforced outer allowance and refuses its extra request when earlier spend exhausts it', async () => {
  const allowed = await runNarratedHostFixture(false, false, 20);
  assert.equal(allowed.budget?.policy.tokenEnforcementEnabled, true);
  assert.equal(allowed.budget?.policy.maxUncachedTokens, 20);
  assert.equal(allowed.budget?.policy.maxActiveMs, 60_000);
  assert.equal(allowed.requests.length, 2, 'an admissible narration uses the captured policy');
  assert.equal(allowed.narrated.length, 1);
  const exhausted = await runNarratedHostFixture(false, false, 9);
  assert.equal(exhausted.budget?.policy.tokenEnforcementEnabled, true);
  assert.equal(exhausted.budget?.policy.maxUncachedTokens, 9);
  assert.equal(exhausted.requests.length, 1, 'the original request spent the allowance before narration');
  assert.equal(exhausted.rows.length, 1, 'a budget refusal happens before request sealing or dispatch');
  assert.equal(exhausted.recorded.length, 1);
  assert.equal(exhausted.narrated.length, 0);
  assert.equal(exhausted.outcome.terminal?.status, 'blocked');
  assert.doesNotMatch(String(exhausted.outcome.finalOutput), /Reconnect its account/);
  const { assertSourceBudgetBeforeModel, SourceBudgetBoundaryError } = await import('./source-budget-boundary.js');
  assert.throws(() => assertSourceBudgetBeforeModel(exhausted.budget!.policy, 0),
    (error: unknown) => error instanceof SourceBudgetBoundaryError && error.reason === 'token_budget');
});

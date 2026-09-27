import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-semantic-usage-'));
Object.assign(process.env, { CLEMENTINE_HOME: fixtureHome, CLEMMY_TEST_ISOLATED_HOME: '1',
  OPENAI_AGENTS_DISABLE_TRACING: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true' });
const { Usage, setDefaultModelProvider } = await import('@openai/agents');
const { completeViaConfiguredBrain, configuredBrainSemanticPort } = await import('./configured-brain-semantic-port.js');
const { withRawClaudeUsageRecording } = await import('../harness/claude-model.js');
const { createSession, appendEvent, getSessionTokensUsed, closeEventLog } = await import('../harness/eventlog.js');
const { modelUsageAttributionStorage, withModelUsageAttribution, readUsageEventsForDate,
  observeModelUsageRecording, recordModelUsage } = await import('../usage-log.js');
const { RouterModelProvider } = await import('../harness/router-model.js');

after(() => { setDefaultModelProvider(new RouterModelProvider()); closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

for (const adapterRecords of [false, true]) {
  test(`semantic completion records and debits once with adapter accounting=${adapterRecords}`, async () => {
    const session = createSession({ kind: 'chat' });
    const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
      data: { text: 'Use my work account.' } });
    let calls = 0;
    setDefaultModelProvider({ getModel: async modelId => {
      const model = {
        async getResponse() {
          calls++;
          const owner = modelUsageAttributionStorage.getStore();
          assert.equal(owner?.sessionId, session.id);
          return { responseId: `semantic-usage-${adapterRecords}`,
            usage: new Usage({ inputTokens: 100, outputTokens: 10, totalTokens: 110, requests: 1,
              inputTokensDetails: [{ cached_tokens: 40 }] }),
            output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
              text: JSON.stringify({ verdict: 'entailed', proposalDigest: 'a'.repeat(64) }), providerData: {} }] }] } as never;
        },
        async *getStreamedResponse() { throw new Error('semantic completion is not streaming'); },
      };
      return adapterRecords ? withRawClaudeUsageRecording(model, String(modelId)) : model;
    } });
    const port = configuredBrainSemanticPort(completeViaConfiguredBrain);
    const verdict = await withModelUsageAttribution({ sessionId: session.id, sourceUserSeq: source.seq },
      () => port.judgeAccountSelection!({ purpose: 'turn_semantics_account_selection', sessionId: session.id,
        sourceUserSeq: source.seq, mode: 'explicit_selection', acceptedText: 'Use my work account.',
        sourceQuote: 'my work account', toolkit: 'fixture', accountIdentity: 'work', accountLabel: 'Work',
        proposalDigest: 'a'.repeat(64) }));
    assert.equal(verdict.verdict, 'entailed');
    assert.equal(calls, 1);
    const usage = readUsageEventsForDate().filter(row => row.source === session.id);
    assert.equal(usage.length, 1, 'the semantic wrapper cannot append a second debit for the same adapter response');
    assert.equal(getSessionTokensUsed(session.id), 70, 'only actual uncached input plus output reaches the budget');
    assert.equal(usage[0]!.cachedInputTokens, 40, 'retain provider cache evidence rather than an anonymous aggregate');
    if (adapterRecords) {
      assert.equal(usage[0]!.responseId, 'semantic-usage-true');
    }
  });
}

test('usage observations do not leak between concurrent completions or from a failed route', async () => {
  const session = createSession({ kind: 'chat' });
  const record = () => recordModelUsage({ sessionId: session.id, model: 'fixture', cacheDialect: 'inclusive',
    inputTokens: 100, outputTokens: 10, responseId: 'observation-fixture' });
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  const [recorded, empty] = await Promise.all([
    observeModelUsageRecording(async () => { record(); release(); await Promise.resolve(); return 'recorded'; }),
    observeModelUsageRecording(async () => { await reached; return 'unrecorded'; }),
  ]);
  assert.equal(recorded.recorded, true);
  assert.equal(empty.recorded, false, 'an unrelated parallel adapter cannot suppress fallback accounting');
  await assert.rejects(observeModelUsageRecording(async () => { record(); throw new Error('failed route'); }), /failed route/);
  const fallback = await observeModelUsageRecording(async () => 'fallback response');
  assert.equal(fallback.recorded, false, 'a failed role cannot claim the fallback role already recorded its response');
});

// Live 2026-09-25: the account-routing verdict held a Slack write turn's tool
// search for 7.9 s, almost all of it hidden reasoning for a one-word verdict.
test('the account-routing verdict reaches its model with no extended thinking; effect judgment keeps the default', async () => {
  const session = createSession({ kind: 'chat' });
  const requests: Array<{ modelSettings?: { reasoning?: { effort?: unknown } } }> = [];
  const modelIds: string[] = [];
  setDefaultModelProvider({ getModel: async (modelId?: string) => ({
    async getResponse(request: never) {
      modelIds.push(String(modelId));
      requests.push(request);
      return { responseId: `reasoning-${requests.length}`,
        usage: new Usage({ inputTokens: 10, outputTokens: 2, totalTokens: 12, requests: 1 }),
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
          text: JSON.stringify({ verdict: 'uncertain', proposalDigest: 'b'.repeat(64) }), providerData: {} }] }] } as never;
    },
    async *getStreamedResponse() { throw new Error('semantic completion is not streaming'); },
  }) as never });
  const port = configuredBrainSemanticPort(completeViaConfiguredBrain);
  await withModelUsageAttribution({ sessionId: session.id }, () => port.judgeAccountSelection!({
    purpose: 'turn_semantics_account_selection', sessionId: session.id, sourceUserSeq: 1,
    mode: 'current_source_default', acceptedText: 'send it', sourceQuote: null, toolkit: 'fixture',
    accountIdentity: 'only', accountLabel: 'Only', proposalDigest: 'b'.repeat(64) }));
  assert.equal(requests[0]?.modelSettings?.reasoning?.effort, 'none');
  await completeViaConfiguredBrain({ purpose: 'turn_semantics_effect_judge', system: 'fixture', user: '{}',
    schemaName: 'SourceEffectJudgeV1' }).catch(() => undefined);
  // Same judge model, no tier asked. (The fixture's reply does not fit the
  // effect schema, so a brain fallback may follow with its SDK defaults.)
  assert.equal(modelIds[1], modelIds[0]);
  assert.equal(requests[1]?.modelSettings?.reasoning, undefined);
});

// Nested calls used to inherit the brain scope's role and the brain round's
// prompt components, so a small judge read as another brain round carrying
// the brain's whole prompt breakdown.
test('a semantic call inside a brain turn records its own role and request, not the brain round', async () => {
  const { withModelRouteMetrics } = await import('../model-route-metrics.js');
  const { harnessRunContextStorage } = await import('../harness/brackets.js');
  const session = createSession({ kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Use my work account.' } });
  const brainRound = { instructions: 5_000, toolSchemas: 40_000, history: 9_000 };
  let responses = 0;
  // The router labels every call in a turn with the frame's role; the claude
  // adapter's recorder reads the harness context's prompt components.
  setDefaultModelProvider({ getModel: async (modelId?: string) => withModelRouteMetrics(
    withRawClaudeUsageRecording({
      async getResponse() {
        responses += 1;
        return { responseId: `nested-${responses}`,
          usage: new Usage({ inputTokens: 900, outputTokens: 8, totalTokens: 908, requests: 1 }),
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
            text: JSON.stringify({ verdict: 'entailed', proposalDigest: 'c'.repeat(64) }), providerData: {} }] }] } as never;
      },
      async *getStreamedResponse() { throw new Error('semantic completion is not streaming'); },
    } as never, String(modelId)),
    { sessionId: session.id, role: 'brain', resolvedModel: String(modelId), provider: 'claude', source: 'explicit', reason: {} },
  ) as never });
  const port = configuredBrainSemanticPort(completeViaConfiguredBrain);
  await withModelUsageAttribution({ sessionId: session.id, sourceUserSeq: source.seq, role: 'brain' },
    () => harnessRunContextStorage.run({ sessionId: session.id, sourceUserSeq: source.seq, promptComponents: brainRound } as never,
      () => port.judgeAccountSelection!({ purpose: 'turn_semantics_account_selection', sessionId: session.id,
        sourceUserSeq: source.seq, mode: 'explicit_selection', acceptedText: 'Use my work account.',
        sourceQuote: 'my work account', toolkit: 'fixture', accountIdentity: 'work', accountLabel: 'Work',
        proposalDigest: 'c'.repeat(64) })));
  const rows = readUsageEventsForDate().filter(row => row.source === session.id);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!.role, 'brain', 'a nested judge is not a brain round');
  assert.equal(rows[0]!.role, 'reviewer');
  assert.equal(rows[0]!.channel, 'judge:turn_semantics_account_selection');
  assert.ok((rows[0]!.promptComponents?.toolSchemas ?? 0) < 100, 'the brain round\'s tool schemas are not billed to it');
  assert.ok((rows[0]!.promptComponents?.instructions ?? 0) < brainRound.instructions,
    'its components describe its own request');
  assert.equal(rows[0]!.inputTokens, 900, 'provider token totals are unchanged');
  assert.equal(rows[0]!.trace?.acceptedSource, `${session.id}:${source.seq}`, 'it still bills the accepted source');
});

test('interpretation inside a brain turn declares no role, and the brain round itself is still the brain', async () => {
  const { harnessRunContextStorage } = await import('../harness/brackets.js');
  const session = createSession({ kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'hello' } });
  const brainRound = { instructions: 5_000, toolSchemas: 40_000, history: 9_000 };
  const model = withRawClaudeUsageRecording({
    async getResponse() {
      return { responseId: 'frame-or-nested',
        usage: new Usage({ inputTokens: 60_000, outputTokens: 8, totalTokens: 60_008, requests: 1 }),
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
          text: '{}', providerData: {} }] }] } as never;
    },
    async *getStreamedResponse() { throw new Error('not streaming'); },
  } as never, 'fixture-brain');
  setDefaultModelProvider({ getModel: async () => model });
  await withModelUsageAttribution({ sessionId: session.id, sourceUserSeq: source.seq, role: 'brain' },
    () => harnessRunContextStorage.run({ sessionId: session.id, sourceUserSeq: source.seq, promptComponents: brainRound } as never,
      async () => {
        await model.getResponse({} as never);
        await completeViaConfiguredBrain({ purpose: 'turn_semantics', system: 'fixture', user: '{}',
          schemaName: 'TurnSemanticProposalV1' }).catch(() => undefined);
      }));
  const rows = readUsageEventsForDate().filter(row => row.source === session.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.role, 'brain', 'the brain round keeps its role');
  assert.equal(rows[0]!.promptComponents?.toolSchemas, 40_000, 'and its measured composition');
  assert.equal(rows[1]!.role, undefined, 'interpretation is not a brain round');
  assert.equal(rows[1]!.roleReason, 'unset');
  assert.equal(rows[1]!.channel, 'semantic:turn_semantics');
  assert.equal(rows[1]!.promptComponents?.toolSchemas, undefined);
});

// The port's own fallback row (the adapter did not record the response) used to
// be written outside the purpose's scope, so interpretation took the frame's role.
test('the fallback row for an unrecorded interpretation inside a brain turn declares no role', async () => {
  const session = createSession({ kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'hi' } });
  const brainRound = { instructions: 5_000, toolSchemas: 40_000, history: 9_000 };
  const port = configuredBrainSemanticPort(async () => ({ raw: {}, modelIdentity: 'fixture-model', inputTokens: 500,
    outputTokens: 5, latencyMs: 3, usageRecorded: false }) as never);
  await withModelUsageAttribution({ sessionId: session.id, sourceUserSeq: source.seq, role: 'brain', promptComponents: brainRound },
    () => port.interpret({
      acceptedText: 'hi', recentTurns: [],
      host: { source: { sessionId: session.id, sourceUserSeq: source.seq }, policyRevision: 'fixture', resumableGoals: [],
        openQuestions: [], catalog: { capabilities: [], capabilityIds: [], workflowIds: [] } },
    } as never));
  const rows = readUsageEventsForDate().filter(row => row.source === session.id);
  assert.equal(rows.length, 1, 'the port records the unrecorded response once');
  assert.equal(rows[0]!.role, undefined, 'interpretation is not a brain round');
  assert.equal(rows[0]!.roleReason, 'unset');
  assert.equal(rows[0]!.channel, 'semantic:turn_semantics');
  assert.equal(rows[0]!.promptComponents?.toolSchemas, undefined, 'the brain round\'s composition is not inherited');
  assert.equal(rows[0]!.inputTokens, 500);
  assert.equal(rows[0]!.trace?.acceptedSource, `${session.id}:${source.seq}`, 'it still bills the accepted source');
});

test('the fallback row for an unrecorded interpretation inside a memory job stays on the job lane', async () => {
  const marker = `memory-fallback-${Date.now()}`;
  const port = configuredBrainSemanticPort(async () => ({ raw: {}, modelIdentity: marker, inputTokens: 300,
    outputTokens: 4, latencyMs: 2, usageRecorded: false }) as never);
  await withModelUsageAttribution({ sessionId: '', sourceUserSeq: 0, channel: 'memory:reconcile', role: 'memory' },
    () => port.interpret({
      acceptedText: 'hi', recentTurns: [],
      host: { source: { sessionId: '', sourceUserSeq: 0 }, policyRevision: 'fixture', resumableGoals: [],
        openQuestions: [], catalog: { capabilities: [], capabilityIds: [], workflowIds: [] } },
    } as never));
  const rows = readUsageEventsForDate().filter(row => row.model === marker);
  assert.equal(rows.length, 1, 'the port records the unrecorded response once');
  assert.equal(rows[0]!.channel, 'memory:reconcile', 'memory work is booked on its job lane');
  assert.equal(rows[0]!.role, 'memory');
  assert.equal(rows[0]!.inputTokens, 300);
});

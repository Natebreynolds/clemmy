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
    assert.equal(getSessionTokensUsed(session.id), 110, 'only actual uncached input plus output reaches the budget');
    if (adapterRecords) {
      assert.equal(usage[0]!.cachedInputTokens, 40, 'retain provider cache evidence rather than an anonymous aggregate');
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

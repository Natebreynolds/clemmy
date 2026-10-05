import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-accepted-brain-routing-'));
Object.assign(process.env, {
  CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1', CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT: 'off',
  OPENAI_AGENTS_DISABLE_TRACING: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true',
  AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.5',
  OPENAI_MODEL_FAST: 'gpt-5.6-luna', CLEMMY_MODEL_ROLES: '', CLEMMY_ROUTE_POLICY: 'off',
  BYO_MODEL_BASE_URL: 'https://default.example.test/v1', BYO_MODEL_API_KEY: 'fixture-default',
  BYO_MODEL_ID: 'fixture-default-brain', BYO_MODEL_JUDGE_ID: 'fixture-default-quick',
  BYO_PROVIDERS: JSON.stringify([{ id: 'fixtureextra', label: 'Extra',
    baseURL: 'https://extra.example.test/v1', modelIds: ['fixture-extra-brain'] }]),
  BYO_PROVIDER_FIXTUREEXTRA_API_KEY: 'fixture-extra',
});

const roles = await import('./model-roles.js');
const usage = await import('../usage-log.js');
const { resolveByoProviderForModel } = await import('./byo-providers.js');
const { boundaryClaudeJudgeModel } = await import('./judge-family.js');
const eventlog = await import('./eventlog.js');
const bridge = await import('./respond-bridge.js');
const { createAgentRecord } = await import('../../agents/agent-record.js');
const { setSessionAgent } = await import('../../agents/session-agent.js');
const agentModel = await import('../../agents/session-agent-model.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { peekTaskContinuityPacket } = await import('../../memory/task-continuity.js');
const { installTurnSemanticModelPort } = await import('../semantic-boundary/turn-semantic-port-registry.js');
const { configuredBrainSemanticPort, completeViaConfiguredBrain } = await import('../semantic-boundary/configured-brain-semantic-port.js');
const { Usage, setDefaultModelProvider } = await import('@openai/agents');

beforeEach(() => {
  process.env.CLEMMY_MODEL_ROLES = '';
  roles.__sessionBrainPinTest__.reset();
});
after(() => {
  installTurnSemanticModelPort(null);
  agentModel._setSessionAgentModelDepsForTests({});
  eventlog.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

function asAcceptedBrain<T>(modelId: string, work: () => T): T {
  const source = { sessionId: 'routing-fixture', sourceUserSeq: 1 };
  return roles.withAcceptedTurnBrainModel({ ...source, modelId }, () => usage.withModelUsageAttribution(source, work));
}

test('automatic Quick uses the accepted extra backend without changing the global model or session pin', () => {
  assert.equal(roles.resolveRoleModel('quick').modelId, 'gpt-5.6-luna');
  asAcceptedBrain('fixture-extra-brain', () => {
    assert.equal(roles.resolveRoleModel('brain').modelId, 'fixture-extra-brain');
    const quick = roles.resolveRoleModel('quick');
    assert.equal(quick.modelId, 'fixture-extra-brain');
    assert.equal(resolveByoProviderForModel(quick.modelId)?.providerId, 'fixtureextra');
    assert.equal(roles.pinnedBrainForSession('routing-fixture'), null, 'an override must not become persistent affinity');
  });
  asAcceptedBrain('fixture-default-brain', () => {
    assert.equal(roles.resolveRoleModel('quick').modelId, 'fixture-default-quick');
  });
  assert.equal(roles.resolveRoleModel('brain').modelId, 'gpt-5.5');
  assert.equal(roles.resolveRoleModel('quick').modelId, 'gpt-5.6-luna');
});

test('an explicit Quick choice wins over the accepted brain backend', () => {
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
    { role: 'quick', modelId: 'fixture-default-quick', scope: 'durable', source: 'settings' },
  ]);
  asAcceptedBrain('fixture-extra-brain', () => {
    assert.equal(roles.resolveRoleModel('brain').modelId, 'fixture-extra-brain');
    assert.equal(roles.resolveRoleModel('quick').modelId, 'fixture-default-quick');
    assert.equal(roles.resolveRoleModel('quick').source, 'settings');
  });
});

test('accepted Codex and Claude models keep their automatic fast-family defaults', () => {
  asAcceptedBrain('gpt-5.5', () => assert.equal(roles.resolveRoleModel('quick').modelId, 'gpt-5.6-luna'));
  asAcceptedBrain('claude-opus-4-8', () => {
    assert.equal(roles.resolveRoleModel('quick').modelId, boundaryClaudeJudgeModel());
    assert.equal(roles.resolveRoleModel('quick').provider, 'claude');
  });
});

test('accepted routing neither creates attribution nor leaks into another source or asynchronous request', async () => {
  const source = { sessionId: 'concurrent-a', sourceUserSeq: 1 };
  await roles.withAcceptedTurnBrainModel({ ...source, modelId: 'fixture-extra-brain' }, async () => {
    assert.equal(usage.modelUsageAttributionStorage.getStore(), undefined);
    assert.equal(roles.resolveRoleModel('quick').modelId, 'gpt-5.6-luna', 'a source-less job has no accepted routing authority');
    const resolved = await Promise.all([
      usage.withModelUsageAttribution(source, async () => {
        await Promise.resolve();
        assert.deepEqual(usage.modelUsageAttributionStorage.getStore(), source, 'routing never invents role or attempt');
        return roles.resolveRoleModel('quick').modelId;
      }),
      usage.withModelUsageAttribution({ ...source, sourceUserSeq: 2 }, async () => {
        await Promise.resolve();
        return roles.resolveRoleModel('quick').modelId;
      }),
      usage.withModelUsageAttribution({ sessionId: 'concurrent-b', sourceUserSeq: 1 }, async () => {
        await Promise.resolve();
        return roles.resolveRoleModel('quick').modelId;
      }),
    ]);
    assert.deepEqual(resolved, ['fixture-extra-brain', 'gpt-5.6-luna', 'gpt-5.6-luna']);
  });
  assert.equal(usage.modelUsageAttributionStorage.getStore(), undefined);
  assert.equal(roles.resolveRoleModel('quick').modelId, 'gpt-5.6-luna');
});

for (const selection of ['saved_agent', 'request_override'] as const) {
  test(`bridge clarification's real semantic request follows its ${selection} before foreground construction`, async () => {
    const session = eventlog.createSession({ id: `quick-${selection}`, kind: 'chat', channel: 'desktop' });
    if (selection === 'saved_agent') {
      agentModel._setSessionAgentModelDepsForTests({ live: () => true });
      const saved = createAgentRecord({ name: 'Synthetic Extra Backend', handles: 'Synthetic reads', model: 'fixture-extra-brain' });
      assert.ok(saved.ok);
      if (!saved.ok) return;
      assert.equal(setSessionAgent(session.id, saved.agent.id, { by: 'owner' }).ok, true);
    }
    const parentAttempt = eventlog.beginRunAttempt(session.id, { runId: `quick-parent-${selection}` });
    const parent = eventlog.recordRunAttemptUserInput(parentAttempt, { turn: 1, role: 'user',
      data: { text: 'Compare one synthetic source.' } });
    eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'awaiting_user_input',
      data: { question: 'Which synthetic source should I read?', options: [], purpose: 'clarification', sourceUserSeq: parent.seq } });
    const identity = { sessionId: session.id, sourceUserSeq: parent.seq, turn: 1 };
    commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'needs_input', resumable: true,
      needs: { kind: 'input' }, presentation: { kind: 'question', text: 'Which synthetic source should I read?' } });
    eventlog.finishRunAttempt(parentAttempt, 'completed');
    assert.equal(peekTaskContinuityPacket({ sessionId: session.id }).status, 'available');

    let proposal: unknown;
    let foregroundStarted = false;
    const selectedModels: string[] = [];
    setDefaultModelProvider({ getModel: async modelId => ({
      async getResponse() {
        assert.equal(foregroundStarted, false, 'this request belongs to ingress clarification');
        const owner = usage.modelUsageAttributionStorage.getStore();
        assert.equal(owner?.sessionId, session.id);
        assert.ok(owner?.sourceUserSeq && owner.sourceUserSeq !== parent.seq);
        assert.equal(owner?.role, undefined, 'a semantic request is not a brain frame');
        assert.equal(owner?.attemptId, undefined, 'routing does not synthesize an attempt');
        selectedModels.push(String(modelId));
        return { responseId: `fixture-${selection}`, usage: new Usage({ inputTokens: 10, outputTokens: 2, totalTokens: 12, requests: 1 }),
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
            text: JSON.stringify(proposal), providerData: {} }] }] } as never;
      },
      async *getStreamedResponse() { throw new Error('fixture must not stream'); },
    }) as never });
    installTurnSemanticModelPort(configuredBrainSemanticPort(async input => {
      const question = JSON.parse(input.user).host.openQuestions[0];
      assert.ok(question);
      proposal = { version: 1, relation: 'answer_open_slot',
        targetGoal: { goalId: question.goalId, baseRevision: question.goalRevision }, goal: null, work: null,
        slotAnswers: [{ kind: 'value', questionId: question.questionId, slotKey: question.slotKey, value: 'fixture.txt' }],
        rationale: 'The user supplied the requested synthetic source.' };
      return completeViaConfiguredBrain(input);
    }));
    bridge._setBridgeImplsForTests({
      configure: (async () => ({ ok: true })) as never,
      buildAgent: (async (input: { model?: string }) => {
        assert.equal(input.model, 'fixture-extra-brain');
        return {};
      }) as never,
      runConversation: (async (options: { sessionId: string; sourceUserSeq: number; buildAgent: (identity: unknown) => Promise<unknown> }) => {
        foregroundStarted = true;
        usage.withModelUsageAttribution({ sessionId: options.sessionId, sourceUserSeq: options.sourceUserSeq }, () => {
          assert.equal(roles.resolveRoleModel('quick').modelId, 'gpt-5.6-luna',
            'the ingress override is gone before same-source worker/memory routing can occur');
        });
        await options.buildAgent({ sessionId: options.sessionId, sourceUserSeq: options.sourceUserSeq, route: 'direct_reply', hostPlainConversation: true });
        return { sessionId: options.sessionId, status: 'completed', steps: 1, lastTurn: 2,
          lastDecision: { reply: 'Synthetic result.', done: true, nextAction: 'completed' } };
      }) as never,
    });
    await bridge.respondViaHarness('home', { sessionId: session.id, message: 'fixture.txt' },
      { turnEngine: 'host_v1', ...(selection === 'request_override' ? { modelOverride: 'fixture-extra-brain' } : {}) });
    assert.deepEqual(selectedModels, ['fixture-extra-brain'], 'no global/default-backend semantic request was dispatched');
    assert.equal(foregroundStarted, true);
    const interpreted = eventlog.listEvents(session.id, { types: ['turn_semantics_interpreted'] });
    assert.equal(interpreted.at(-1)?.data.modelIdentity, 'fixture-extra-brain');
    const rows = usage.readUsageEventsForDate().filter(row => row.source === session.id && row.channel === 'semantic:turn_semantics');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.role, undefined);
    assert.equal(rows[0]?.trace?.attemptId, undefined);
    assert.equal(roles.resolveRoleModel('quick').modelId, 'gpt-5.6-luna');
  });
}

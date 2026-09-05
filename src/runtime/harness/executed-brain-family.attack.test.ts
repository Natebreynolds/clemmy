/** Adversarial pins for 680e45a5: executedBrainFamily / judge routing must read
 * the route THIS turn executes on — never another session's, never a stale
 * earlier turn's — and every judge lane must agree with the primary. */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelResponse } from '@openai/agents-core';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-executed-brain-family-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { Usage } = await import('@openai/agents');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { CodexModelProvider } = await import('./codex-model.js');
const { executedBrainFamily, resolveBoundaryJudge, resolveBoundaryJudgeChain, resolveBoundaryJudgeHedge } = await import('./debate-model.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');

function providerModel(provider: 'claude' | 'codex', modelId?: string): Model {
  return {
    async getResponse(): Promise<ModelResponse> {
      return { output: [], usage: new Usage(), responseId: `fixture-${provider}-${modelId ?? ''}` } as ModelResponse;
    },
    async *getStreamedResponse() { throw new Error('unused'); },
  };
}

function writeAuth(codex = true): void {
  writeFileSync(path.join(TEST_HOME, 'state', 'auth.json'), JSON.stringify(codex ? {
    codexOauth: { accessToken: 'fixture-codex-access', refreshToken: 'fixture-codex-refresh' },
  } : {}));
  writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-oat01-fixture', expiresAt: Date.now() + 3_600_000,
  }));
}

beforeEach(() => {
  mock.restoreAll();
  Object.assign(process.env, {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'on', CLEMMY_JUDGE_CHAIN: 'on',
    CLEMMY_MODEL_ROLES: '[]',
    CLEMMY_DEBATE_JUDGE: '', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', BYO_PROVIDERS: '',
  });
  writeAuth();
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string) => providerModel('claude', id));
  mock.method(CodexModelProvider.prototype, 'getModel', (id?: string) => providerModel('codex', id));
});

after(() => {
  mock.restoreAll();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

let n = 0;
function session(): string {
  return eventlog.createSession({ id: `executed-family-${Date.now()}-${n += 1}`, kind: 'chat' }).id;
}
function ctx(sessionId: string, sourceUserSeq = 1) {
  return { sessionId, sourceUserSeq, counter: new brackets.ToolCallsCounter(3), behaviorScopeId: `${sessionId}::turn:1` };
}
function fallover(sessionId: string, provider: string, model: string, extra: Record<string, unknown> = {}) {
  return eventlog.appendEvent({ sessionId, turn: 1, role: 'system', type: 'turn_model_routed', data: {
    model, provider, transport: 'host_harness', routeKind: 'harness_fallover', fallover: true,
    reason: 'preselected-rate-limited', fromModel: 'gpt-5.6-terra', fromProvider: 'codex', ...extra,
  } });
}
function preTurnRoute(sessionId: string, provider: string, model: string, sourceUserSeq: number) {
  return eventlog.appendEvent({ sessionId, turn: 0, role: 'system', type: 'turn_model_routed', data: {
    model, provider, transport: 'host_harness', mode: 'off', routeKind: 'primary', surface: 'chat', sourceUserSeq, attemptId: `att-${sourceUserSeq}`,
  } });
}
const inCtx = <T>(c: ReturnType<typeof ctx>, fn: () => T) => brackets.withHarnessRunContext(c, async () => fn());

test('a fallover recorded in a DIFFERENT session never leaks into this session', async () => {
  const other = session();
  const mine = session();
  fallover(other, 'claude', 'claude-sonnet-5');
  assert.equal(await inCtx(ctx(mine), () => executedBrainFamily('codex')), 'codex');
  assert.equal(await inCtx(ctx(other), () => executedBrainFamily('codex')), 'claude');
});

test('several fallovers: the LAST recorded fallover names the family', async () => {
  const s = session();
  fallover(s, 'claude', 'claude-sonnet-5');
  fallover(s, 'byo', 'glm-5.3', { fromModel: 'claude-sonnet-5', fromProvider: 'claude' });
  assert.equal(await inCtx(ctx(s), () => executedBrainFamily('codex')), 'byo');
});

test('a non-fallover turn_model_routed never changes the family', async () => {
  const s = session();
  preTurnRoute(s, 'claude', 'claude-sonnet-5', 1);
  eventlog.appendEvent({ sessionId: s, turn: 1, role: 'system', type: 'turn_model_routed', data: { model: 'claude-sonnet-5', provider: 'claude', routeKind: 'primary', fallover: false } });
  assert.equal(await inCtx(ctx(s), () => executedBrainFamily('codex')), 'codex');
});

test('ATTACK: a fallover from an EARLIER turn must not label a later turn that routed normally', async () => {
  // Turn 1: Codex quota exhausted, brain fell over to Claude. Turn 2 (days
  // later, quota reset): the pre-turn route is codex, no fallover. The judge
  // in turn 2 must see codex — otherwise a codex judge on a codex brain is
  // reported as cross-family (the exact inverse of the live defect).
  const s = session();
  preTurnRoute(s, 'codex', 'gpt-5.6-terra', 1);
  fallover(s, 'claude', 'claude-sonnet-5', { sourceUserSeq: 1 });
  const user2 = eventlog.appendEvent({ sessionId: s, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'next turn' } });
  preTurnRoute(s, 'codex', 'gpt-5.6-terra', user2.seq);
  assert.equal(await inCtx(ctx(s, user2.seq), () => executedBrainFamily('codex')), 'codex',
    'turn 2 routed on codex with no fallover; the turn-1 fallover is stale');
});

test('judge chain and hedge agree with resolveBoundaryJudge on brainFamily/selfJudge after a fallover', async () => {
  const s = session();
  fallover(s, 'claude', 'claude-sonnet-5');
  await inCtx(ctx(s), () => {
    const primary = resolveBoundaryJudge();
    assert.equal(primary.brainFamily, 'claude');
    assert.equal(primary.selfJudge, primary.judgeFamily === 'claude');
    const chain = resolveBoundaryJudgeChain();
    assert.ok(chain.length >= 1);
    for (const lane of chain) {
      assert.equal(lane.brainFamily, primary.brainFamily, `chain lane ${lane.judgeFamily}:${lane.modelId} disagrees on brainFamily`);
      assert.equal(lane.selfJudge, lane.judgeFamily === primary.brainFamily, `chain lane ${lane.judgeFamily}:${lane.modelId} disagrees on selfJudge`);
    }
    const hedge = resolveBoundaryJudgeHedge(primary);
    if (hedge) {
      assert.equal(hedge.brainFamily, primary.brainFamily);
      assert.equal(hedge.selfJudge, hedge.judgeFamily === primary.brainFamily);
      assert.notEqual(hedge.judgeFamily, primary.brainFamily, 'a hedge never lands on the executing brain family');
    }
  });
});

test('judge chain agrees with the primary when codex is NOT connected (last-resort lane)', async () => {
  writeAuth(false);
  const s = session();
  fallover(s, 'claude', 'claude-sonnet-5');
  await inCtx(ctx(s), () => {
    const primary = resolveBoundaryJudge();
    assert.equal(primary.brainFamily, 'claude');
    const chain = resolveBoundaryJudgeChain();
    for (const lane of chain) {
      assert.equal(lane.brainFamily, primary.brainFamily, `chain lane ${lane.judgeFamily}:${lane.modelId} disagrees on brainFamily`);
      assert.equal(lane.selfJudge, lane.judgeFamily === primary.brainFamily, `chain lane ${lane.judgeFamily}:${lane.modelId} disagrees on selfJudge`);
    }
  });
});

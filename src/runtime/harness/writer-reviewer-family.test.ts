/** Writer / reviewer split: a chosen writer is its own role, and review
 * independence is measured against the author of the reviewed reply. */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Model, ModelResponse } from '@openai/agents-core';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-writer-reviewer-family-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { Usage } = await import('@openai/agents');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { CodexModelProvider } = await import('./codex-model.js');
const { resolveBoundaryJudge, resolveBoundaryJudgeHedge, buildExactRoleModel } = await import('./debate-model.js');
const { boundWriterModel, resolveRoleModel } = await import('./model-roles.js');
const { _setDiscoveredModelsForTest } = await import('./model-discovery.js');
const eventlog = await import('./eventlog.js');

function providerModel(provider: 'claude' | 'codex', modelId?: string): Model {
  return {
    async getResponse(): Promise<ModelResponse> {
      return { output: [], usage: new Usage(), responseId: `fixture-${provider}-${modelId ?? ''}` } as ModelResponse;
    },
    async *getStreamedResponse() { throw new Error('unused'); },
  };
}

beforeEach(() => {
  mock.restoreAll();
  Object.assign(process.env, {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'on', CLEMMY_JUDGE_CHAIN: 'on',
    CLEMMY_MODEL_ROLES: '[]',
    CLEMMY_DEBATE_JUDGE: '', BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', BYO_MODEL_ID: '', BYO_PROVIDERS: '',
  });
  writeFileSync(path.join(TEST_HOME, 'state', 'auth.json'), JSON.stringify({
    codexOauth: { accessToken: 'fixture-codex-access', refreshToken: 'fixture-codex-refresh' },
  }));
  writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-oat01-fixture', expiresAt: Date.now() + 3_600_000,
  }));
  _setDiscoveredModelsForTest({ anthropic: [], openai: [] });
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string) => providerModel('claude', id));
  mock.method(CodexModelProvider.prototype, 'getModel', (id?: string) => providerModel('codex', id));
});

after(() => {
  mock.restoreAll();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function chooseWriter(modelId: string): void {
  process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'writer', modelId, scope: 'durable', source: 'settings' }]);
}

test('with no writer chosen the brain writes its own answers', () => {
  const writer = resolveRoleModel('writer');
  assert.equal(writer.source, 'default');
  assert.equal(writer.modelId, resolveRoleModel('brain').modelId);
  assert.equal(boundWriterModel(), null, 'no separate writer step without an explicit choice');
});

test('a chosen writer resolves exactly as chosen and builds without a fallback chain', () => {
  const claudeId = resolveRoleModel('judge').modelId;
  assert.equal(resolveRoleModel('judge').provider, 'claude', 'fixture: a Codex brain gets a Claude default judge');
  chooseWriter(claudeId);
  const writer = boundWriterModel();
  assert.ok(writer, 'an available explicit writer is bound');
  assert.equal(writer.modelId, claudeId);
  assert.equal(writer.provider, 'claude');
  assert.ok(buildExactRoleModel(writer, 'writer'), 'the exact writer model builds when its provider is available');
});

test('the default judge comes from a family other than the chosen writer', () => {
  const claudeId = resolveRoleModel('judge').modelId;
  chooseWriter(claudeId);
  const judge = resolveRoleModel('judge');
  assert.equal(judge.source, 'default');
  assert.notEqual(judge.provider, 'claude', 'a Claude writer is not reviewed by a Claude default judge');
});

test('review independence is measured against the author of the reviewed reply', () => {
  const routed = resolveBoundaryJudge();
  assert.equal(routed.judgeFamily, 'claude');
  assert.equal(routed.brainFamily, 'codex');
  assert.equal(routed.selfJudge, false, 'a Claude judge of a Codex-written reply is independent');
  const claudeAuthor = { modelId: 'fixture-claude-writer', provider: 'claude' as const, source: 'settings' as const };
  const authored = resolveBoundaryJudge(undefined, claudeAuthor);
  assert.equal(authored.authorFamily, 'claude');
  assert.equal(authored.selfJudge, true, 'the same judge grading a Claude-written reply is a self-judge');
  const hedge = resolveBoundaryJudgeHedge(authored);
  assert.ok(!hedge || (hedge.judgeFamily !== 'claude' && hedge.judgeFamily !== 'codex'),
    'a hedge never shares the author, brain or primary judge family');
});

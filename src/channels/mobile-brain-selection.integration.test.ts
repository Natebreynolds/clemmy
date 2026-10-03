import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-brain-selection-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.NODE_ENV = 'test';
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.OPENAI_MODEL_PRIMARY = 'gpt-6-luna';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
writeFileSync(path.join(fixtureHome, 'state', 'auth.json'), JSON.stringify({
  source: 'native', codexOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
    accountId: 'fixture-account', lastRefresh: new Date().toISOString() },
}));

const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('./mobile-routes.js');
const { registerConsoleRoutes } = await import('../dashboard/console-routes.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const { _setDiscoveredModelsForTest } = await import('../runtime/harness/model-discovery.js');
const { pinSessionBrain, pinnedBrainForSession, resolveRoleModel } = await import('../runtime/harness/model-roles.js');
const { createSession, getSession, listEvents } = await import('../runtime/harness/eventlog.js');
const { createAgentRecord } = await import('../agents/agent-record.js');
const { setSessionAgent } = await import('../agents/session-agent.js');
const { modelUsageAttributionStorage } = await import('../runtime/usage-log.js');

test.after(() => { _setDiscoveredModelsForTest(null); rmSync(fixtureHome, { recursive: true, force: true }); });

test('mobile selects a novel catalog model exactly; both carriers read the session pin after a global switch and reopen in the same daemon', async () => {
  const novel = 'gpt-99.7-sol';
  const subscriptionModels = [
    { id: novel, label: 'Novel Codex Sol', subscription: true as const },
    { id: 'gpt-6-luna', label: 'Codex Luna', subscription: true as const },
  ];
  _setDiscoveredModelsForTest({ openai: subscriptionModels, anthropic: [] });
  const stateDir = path.join(fixtureHome, 'phone');
  const app = express();
  app.use(express.json());
  app.use('/m', createMobileRouter({ stateDir, cookieSecure: false, isAdminAuthorized: () => false }));
  registerConsoleRoutes(app, () => true, {} as never, { serveLegacyAtRoot: false });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await setPin('FixturePin1!', { stateDir });
    const login = await fetch(`${url}/m/auth/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'FixturePin1!' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith(`${MOBILE_SESSION_COOKIE}=`));
    const headers = { 'content-type': 'application/json', cookie };
    for (const id of ['choice-a', 'choice-b', 'unserved', 'agent-owned']) createSession({ id, kind: 'chat', channel: 'mobile' });
    pinSessionBrain('choice-a'); pinSessionBrain('choice-b');
    const post = (value: string, sessionId?: string) => fetch(`${url}/m/api/settings/models/brain`, {
      method: 'POST', headers, body: JSON.stringify({ value, ...(sessionId ? { sessionId } : {}) }),
    });
    const chosen = await post(`codex_oauth:${novel}`, 'choice-a');
    assert.equal(chosen.status, 200, await chosen.clone().text());
    assert.equal(process.env.OPENAI_MODEL_PRIMARY, novel, 'a novel catalog choice actually replaces the old Codex primary');
    assert.match(readFileSync(path.join(fixtureHome, '.env'), 'utf8'), /^OPENAI_MODEL_PRIMARY=gpt-99\.7-sol$/m);
    const selected = await chosen.json();
    assert.deepEqual(selected.selection, { requestedValue: `codex_oauth:${novel}`, effectiveValue: `codex_oauth:${novel}`,
      modelId: novel, provider: 'codex', scope: 'conversation', sessionId: 'choice-a' });
    assert.ok(getSession('choice-a')?.metadata.brainChosenAt);
    assert.equal(pinnedBrainForSession('choice-b')?.modelId, 'gpt-6-luna');
    assert.equal(modelUsageAttributionStorage.run({ sessionId: 'choice-a', sourceUserSeq: 1 }, () => resolveRoleModel('brain').modelId), novel,
      'production turn resolution serves the same selected pin without a model request');

    const savedEnv = readFileSync(path.join(fixtureHome, '.env'), 'utf8');
    const chosenAt = getSession('choice-a')?.metadata.brainChosenAt;
    const invalid = await fetch(`${url}/api/console/settings/active-brain`, { method: 'PATCH',
      headers, body: JSON.stringify({ brain: 'codex_oauth', modelId: 'glm-worker', sessionId: 'choice-a' }) });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_BRAIN_MODEL');
    assert.equal(process.env.OPENAI_MODEL_PRIMARY, novel, 'invalid provider/model pairing never changes the brain');
    assert.equal(readFileSync(path.join(fixtureHome, '.env'), 'utf8'), savedEnv, 'validation happens before persisted routing changes');
    assert.equal(getSession('choice-a')?.metadata.brainChosenAt, chosenAt, 'a rejected request never declares a new owner choice');

    const fallback = await fetch(`${url}/api/console/settings/active-brain`, { method: 'PATCH',
      headers, body: JSON.stringify({ brain: 'codex_oauth' }) });
    assert.equal(fallback.status, 200, await fallback.clone().text());
    assert.equal((await fallback.json()).selection.requestedValue, 'codex_oauth', 'provider-only choice remains supported');
    await post('codex_oauth:gpt-6-luna');
    const eventsBefore = listEvents('choice-a').length;
    for (const endpoint of ['/m/api/chat/answering-model', '/api/console/answering-model']) {
      for (let reopened = 0; reopened < 2; reopened++) {
        const read = await fetch(`${url}${endpoint}?sessionId=choice-a&agentId=`, { headers });
        const state = await read.json();
        assert.equal(state.brain.modelId, novel, 'a reopened picker reads the session, not the newer global Luna default');
        assert.equal(state.brain.source, 'session');
        const bystander = await fetch(`${url}${endpoint}?sessionId=choice-b&agentId=`, { headers });
        assert.equal((await bystander.json()).brain.modelId, 'gpt-6-luna');
        await fetch(`${url}${endpoint}?sessionId=unserved&agentId=`, { headers });
        assert.equal(pinnedBrainForSession('unserved'), null, 'a picker read never stamps a new conversation pin');
      }
    }
    assert.equal(listEvents('choice-a').length, eventsBefore, 'picker readback adds no turn or route event');

    const agent = createAgentRecord({ name: 'Selection fixture agent', model: 'gpt-6-luna' });
    assert.equal(setSessionAgent('agent-owned', agent.agent.id, { by: 'owner' }).ok, true);
    const agentRead = await fetch(`${url}/m/api/chat/answering-model?sessionId=agent-owned&agentId=${agent.agent.id}`, { headers });
    assert.equal((await agentRead.json()).brain.source, 'agent');
    const override = await post(`codex_oauth:${novel}`, 'agent-owned');
    assert.equal(override.status, 200, await override.clone().text());
    const overrideRead = await fetch(`${url}/m/api/chat/answering-model?sessionId=agent-owned&agentId=${agent.agent.id}`, { headers });
    const overridden = await overrideRead.json();
    assert.equal(overridden.agent, null, 'a later owner choice wins over the agent model');
    assert.equal(overridden.brain.modelId, novel);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

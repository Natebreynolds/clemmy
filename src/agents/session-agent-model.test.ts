/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/session-agent-model.test.ts
 *
 * A conversation switched to an agent the owner pinned a model to answers on
 * that model, until the owner picks one for the conversation on the model
 * chip. Owner, 10-02: "I would like to be able to pin a model to an agent."
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-session-agent-model-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'session-agent-model\n');

const { createAgentRecord } = await import('./agent-record.js');
const { setSessionAgent } = await import('./session-agent.js');
const { createSession } = await import('../runtime/harness/eventlog.js');
const { sessionAgentAnsweringModel, sessionAgentExecutionModel, savedAgentModelExecutionLive, savedAgentModelExecutionCheck, recordBrainChosenForSession, nextAnsweringAgentModel } = await import('./session-agent-model.js');
const { recordCodexRateLimit, codexQuotaExhausted, getRateLimitSnapshot,
  CODEX_QUOTA_SAMPLE_FRESH_MS, __resetRateLimitStoreForTests } = await import('../runtime/harness/rate-limit-store.js');

after(() => { rmSync(HOME, { recursive: true, force: true }); });

const live = { live: () => true };

test('switching to an agent pinned to a model answers on that model; the owner\'s later chip choice wins; switching again restores it', async () => {
  const designer = createAgentRecord({ name: 'Model Test Designer', handles: 'Design', model: 'claude-opus-5-5' });
  assert.ok(designer.ok);
  if (!designer.ok) return;
  const session = createSession({ id: 'sess-agent-model-1', kind: 'chat', channel: 'desktop', title: 't' });
  assert.equal(sessionAgentAnsweringModel(session.id, live), null, 'no agent, no agent model');

  assert.equal(setSessionAgent(session.id, designer.agent.id, { by: 'owner' }).ok, true);
  assert.deepEqual(sessionAgentAnsweringModel(session.id, live),
    { modelId: 'claude-opus-5-5', agentId: designer.agent.id, agentName: 'Model Test Designer' });

  // The owner picks a model for this conversation afterwards: theirs answers.
  recordBrainChosenForSession(session.id, new Date(Date.now() + 1_000));
  assert.equal(sessionAgentAnsweringModel(session.id, live), null);

  // Switching away and back is a new switch: the agent's model answers again.
  await new Promise((r) => setTimeout(r, 5));
  setSessionAgent(session.id, null, { by: 'owner' });
  assert.equal(sessionAgentAnsweringModel(session.id, live), null, 'back with Clem, no agent model');
  await new Promise((r) => setTimeout(r, 1_100));
  setSessionAgent(session.id, designer.agent.id, { by: 'owner' });
  assert.equal(sessionAgentAnsweringModel(session.id, live)?.modelId, 'claude-opus-5-5');
});

test('a pinned model that is not signed in leaves a stable preview, while an unpinned agent has no model override', () => {
  const pinned = createAgentRecord({ name: 'Model Test Signed Out', handles: 'x', model: 'claude-opus-5-5' });
  const unpinned = createAgentRecord({ name: 'Model Test Unpinned', handles: 'x' });
  assert.ok(pinned.ok && unpinned.ok);
  if (!pinned.ok || !unpinned.ok) return;
  const a = createSession({ id: 'sess-agent-model-2', kind: 'chat', channel: 'desktop', title: 't' });
  setSessionAgent(a.id, pinned.agent.id, { by: 'owner' });
  assert.equal(sessionAgentAnsweringModel(a.id, { live: () => false }), null, 'never a model that cannot answer now');
  const b = createSession({ id: 'sess-agent-model-3', kind: 'chat', channel: 'desktop', title: 't' });
  setSessionAgent(b.id, unpinned.agent.id, { by: 'owner' });
  assert.equal(sessionAgentAnsweringModel(b.id, live), null);
});

test('session execution distinguishes an unavailable saved pin from an unpinned default', () => {
  const deps = { metadataOf: () => ({ agentId: 'saved-agent', agentName: 'Specialist' }),
    agentModel: () => ({ name: 'Specialist', model: ' claude-opus-5-5 ' }), live: () => false };
  assert.deepEqual(sessionAgentExecutionModel('selection', deps), { kind: 'unavailable',
    modelId: 'claude-opus-5-5', savedModel: 'claude-opus-5-5', agentId: 'saved-agent', agentName: 'Specialist', reason: 'not_connected' });
  assert.equal(sessionAgentAnsweringModel('selection', deps), null, 'picker remains nonthrowing');
  assert.equal(sessionAgentExecutionModel('selection', { ...deps,
    live: () => { throw new Error('Provider state is unavailable.'); } }).kind, 'unavailable');
  assert.deepEqual(sessionAgentExecutionModel('selection', { ...deps,
    agentModel: () => ({ name: 'Specialist', model: null }) }), { kind: 'default' });
  assert.deepEqual(sessionAgentExecutionModel('selection', { ...deps, metadataOf: () => null }), { kind: 'default' });
});

test('session execution preserves a later owner model-chip choice without checking the former pin', () => {
  const switchedAt = '2026-10-05T12:00:00.000Z';
  for (const brainChosenAt of [switchedAt, '2026-10-05T12:00:01.000Z']) {
    assert.deepEqual(sessionAgentExecutionModel('selection', {
      metadataOf: () => ({ agentId: 'saved-agent', agentSetAt: switchedAt, brainChosenAt }),
      agentModel: () => { throw new Error('The owner override should avoid the saved model lookup.'); },
    }), { kind: 'default' });
  }
});

test('session execution resolves a role pin exactly and refuses an inactive role binding without its default substitute', () => {
  const deps = { metadataOf: () => ({ agentId: 'role-agent' }),
    agentModel: () => ({ name: 'Role Specialist', model: ' Worker ' }), live: (modelId: string) => modelId === 'gpt-5.5',
    roleModel: (role: string) => { assert.equal(role, 'worker'); return { modelId: 'gpt-5.5' }; } };
  assert.deepEqual(sessionAgentExecutionModel('selection', deps), { kind: 'pinned',
    modelId: 'gpt-5.5', agentId: 'role-agent', agentName: 'Role Specialist' });
  const inactive = { ...deps, roleModel: () => ({ modelId: 'gpt-5.5', inactiveBinding: {
    modelId: 'claude-opus-5-5', provider: 'claude' as const, source: 'settings' as const, reason: 'Disconnected.' } }) };
  assert.deepEqual(sessionAgentExecutionModel('selection', { ...inactive,
    live: () => { throw new Error('An inactive pin must not try its default substitute.'); } }), {
    kind: 'unavailable', modelId: 'claude-opus-5-5', savedModel: 'Worker',
    agentId: 'role-agent', agentName: 'Role Specialist', reason: 'not_connected' });
  assert.equal(sessionAgentAnsweringModel('selection', inactive)?.modelId, 'gpt-5.5', 'the existing role preview stays stable');
});

test('saved agent model execution uses canonical ownership and refuses model collapse or unavailable credentials', () => {
  assert.equal(savedAgentModelExecutionLive('gpt-owned-by-byo', {
    route: () => ({ modelId: 'gpt-owned-by-byo', provider: 'byo' }),
    live: (modelId, provider) => { assert.equal(modelId, 'gpt-owned-by-byo'); assert.equal(provider, 'byo'); return true; },
  }), true, 'a declared GPT-shaped BYO model checks the owning backend');
  assert.equal(savedAgentModelExecutionLive('gpt-5.5', {
    route: () => ({ modelId: 'byo-default', provider: 'byo' }),
    live: () => { throw new Error('A model collapse must not check or dispatch the substitute.'); },
  }), false);
  assert.equal(savedAgentModelExecutionLive('gpt-5.5', {
    route: () => ({ modelId: 'gpt-5.5', provider: 'codex' }), live: () => false,
  }), false, 'a genuinely disconnected Codex choice remains unavailable');
  assert.equal(savedAgentModelExecutionLive('ambiguous-choice', {
    route: () => { throw new Error('Two connected backends claim this name.'); }, live: () => true,
  }), false);
});

test('the exact saved Codex pin is held by a fresh exhausted sample, while a stale sample does not invent a quota hold', () => {
  __resetRateLimitStoreForTests();
  let at = Date.now();
  const executionCheck = (modelId: string) => savedAgentModelExecutionCheck(modelId, {
    route: (name) => ({ modelId: name, provider: 'codex' }),
    live: () => !codexQuotaExhausted(at),
    codexConnected: () => true,
    codexQuotaExhausted: () => codexQuotaExhausted(at),
  });
  const deps = { metadataOf: () => ({ agentId: 'saved-codex' }),
    agentModel: () => ({ name: 'Codex fixture', model: 'gpt-6.1-sol' }), executionCheck };
  try {
    assert.deepEqual(sessionAgentExecutionModel('parent', deps), { kind: 'pinned',
      modelId: 'gpt-6.1-sol', agentId: 'saved-codex', agentName: 'Codex fixture' });
    recordCodexRateLimit({ 'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '10080', 'x-codex-primary-reset-at': String(at + 86_400_000),
      'x-codex-secondary-used-percent': '0', 'x-codex-secondary-window-minutes': '0' });
    at = getRateLimitSnapshot().codex!.capturedAt;
    assert.equal(codexQuotaExhausted(at), true, 'zero-duration headroom cannot waive the real exhausted weekly window');
    assert.deepEqual(sessionAgentExecutionModel('successor', deps), { kind: 'unavailable',
      modelId: 'gpt-6.1-sol', savedModel: 'gpt-6.1-sol', agentId: 'saved-codex',
      agentName: 'Codex fixture', reason: 'codex_quota_exhausted' });
    at += CODEX_QUOTA_SAMPLE_FRESH_MS + 1;
    assert.equal(codexQuotaExhausted(at), false, 'existing freshness bound is unchanged');
    assert.equal(sessionAgentExecutionModel('after-stale-sample', deps).kind, 'pinned');
  } finally { __resetRateLimitStoreForTests(); }
});

test('quota diagnostics cannot explain another provider, a substituted route, absent credentials or unknown quota state', () => {
  let quotaChecks = 0;
  const quota = () => { quotaChecks++; return true; };
  for (const provider of ['claude', 'byo'] as const) {
    assert.equal(savedAgentModelExecutionCheck('gpt-shaped-owned-id', {
      route: (modelId) => ({ modelId, provider }), live: () => false,
      codexConnected: () => { throw new Error('Other providers never inspect Codex credentials.'); }, codexQuotaExhausted: quota,
    }), 'not_connected');
  }
  assert.equal(savedAgentModelExecutionCheck('gpt-6.1-sol', {
    route: () => ({ modelId: 'claude-opus-5-5', provider: 'claude' }),
    live: () => { throw new Error('A substituted route is never tested for service.'); },
    codexConnected: () => true, codexQuotaExhausted: quota,
  }), 'not_connected');
  assert.equal(savedAgentModelExecutionCheck('gpt-6.1-sol', {
    route: (modelId) => ({ modelId, provider: 'codex' }), live: () => false,
    codexConnected: () => false, codexQuotaExhausted: quota,
  }), 'not_connected');
  assert.equal(quotaChecks, 0, 'unowned or disconnected routes cannot acquire Codex quota evidence');
  assert.equal(savedAgentModelExecutionCheck('gpt-6.1-sol', {
    route: (modelId) => ({ modelId, provider: 'codex' }), live: () => false,
    codexConnected: () => true, codexQuotaExhausted: () => false,
  }), 'not_connected');
  assert.equal(savedAgentModelExecutionCheck('gpt-6.1-sol', {
    route: () => { throw new Error('Unverified route'); }, live: () => true,
    codexConnected: () => true, codexQuotaExhausted: quota,
  }), 'not_connected');
  assert.equal(savedAgentModelExecutionCheck('gpt-6.1-sol', {
    route: (modelId) => ({ modelId, provider: 'codex' }), live: () => false,
    codexConnected: () => true, codexQuotaExhausted: () => { throw new Error('Unverified quota'); },
  }), 'not_connected');
  const deps = { metadataOf: () => ({ agentId: 'unverified-agent' }),
    agentModel: () => { throw new Error('Unverified saved agent'); }, executionCheck: () => 'codex_quota_exhausted' as const };
  assert.equal(sessionAgentExecutionModel('unknown-agent', deps).kind, 'unavailable');
  assert.equal((sessionAgentExecutionModel('unknown-agent', deps) as { reason: string }).reason, 'unverified');
});

test('the model chip reads what answers the next message, including an agent choice not yet sent', () => {
  const designer = createAgentRecord({ name: 'Model Test Chip Designer', handles: 'Design', model: 'claude-opus-5-5' });
  const other = createAgentRecord({ name: 'Model Test Chip Other', handles: 'x', model: 'gpt-5.5' });
  assert.ok(designer.ok && other.ok);
  if (!designer.ok || !other.ok) return;
  // A new conversation about to open inside the agent.
  assert.equal(nextAnsweringAgentModel(null, designer.agent.id, live)?.modelId, 'claude-opus-5-5');
  assert.equal(nextAnsweringAgentModel(null, null, live), null);
  assert.equal(nextAnsweringAgentModel(null, undefined, live), null);

  const session = createSession({ id: 'sess-agent-model-chip', kind: 'chat', channel: 'desktop', title: 't' });
  setSessionAgent(session.id, designer.agent.id, { by: 'owner' });
  recordBrainChosenForSession(session.id, new Date(Date.now() + 1_000));
  // The conversation's own agent: the owner's later pick answers.
  assert.equal(nextAnsweringAgentModel(session.id, undefined, live), null);
  assert.equal(nextAnsweringAgentModel(session.id, designer.agent.id, live), null);
  // A different agent chosen on the chip switches on send: its model answers.
  assert.equal(nextAnsweringAgentModel(session.id, other.agent.id, live)?.modelId, 'gpt-5.5');
  // Back to Clem on the chip: no agent model.
  assert.equal(nextAnsweringAgentModel(session.id, null, live), null);
});

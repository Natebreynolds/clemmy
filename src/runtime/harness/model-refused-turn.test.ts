/**
 * A brain the provider refuses for this sign-in stops in words.
 *
 * Regression (10-02): the owner's brain was set to a Codex model their
 * ChatGPT sign-in cannot run; every turn ended "Something went wrong on that
 * turn. Please try again" — retrying could not help, and the one thing that
 * could (pick another model) went unsaid. The picker had offered the model
 * because an API key's listing was merged into the sign-in's choices.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/model-refused-turn.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-model-refused-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = 'a'.repeat(64);
process.env.HARNESS_TOOL_BRACKETS = 'off';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runTurn, runConversation } = await import('./loop.js');
const envelopes = await import('../../agents/capability-envelope.js');
const memoryDatabase = await import('../../memory/db.js');
const { CodexModelError } = await import('./codex-model.js');
const refusal = await import('./model-refusal.js');
const { PUBLIC_RUN_FAILURE_TEXT } = await import('./public-presentation.js');
const discovery = await import('./model-discovery.js');
const roleOptions = await import('./model-role-options.js');

test.after(() => {
  discovery._setDiscoveredModelsForTest(null);
  eventlog.closeEventLog();
  memoryDatabase.closeMemoryDb();
  rmSync(fixtureHome, { recursive: true, force: true });
});

const REFUSED = 'gpt-9.9-fixture-codex';
const refusedError = () => new CodexModelError(
  `Codex /responses returned 400 Bad Request: {"detail":"The '${REFUSED}' model is not supported when using Codex with a ChatGPT account."}`,
  400,
  refusal.refusedModelFromProviderResponse(400, `{"detail":"The '${REFUSED}' model is not supported when using Codex with a ChatGPT account."}`, REFUSED),
);

test('a provider error is a model refusal only when it names the requested model on a 400 or 404', () => {
  assert.equal(refusal.refusedModelFromProviderResponse(400, `The '${REFUSED}' model is not supported`, REFUSED), REFUSED);
  assert.equal(refusal.refusedModelFromProviderResponse(404, `model: ${REFUSED.toUpperCase()}`, REFUSED), REFUSED);
  assert.equal(refusal.refusedModelFromProviderResponse(400, 'Unsupported parameter: temperature', REFUSED), undefined);
  assert.equal(refusal.refusedModelFromProviderResponse(401, `token rejected for ${REFUSED}`, REFUSED), undefined, 'a sign-in failure keeps its own path');
  assert.equal(refusal.refusedModelFromProviderResponse(500, `${REFUSED} overloaded`, REFUSED), undefined);
  assert.equal(refusal.refusedRequestedModel(new Error('wrapped', { cause: refusedError() })), REFUSED);
  assert.equal(refusal.refusedRequestedModel(new Error('anything else')), null);
  assert.match(refusal.refusedModelPublicText(REFUSED), /^GPT 9\.9 Fixture Codex isn't available on this sign-in/);
});

test('host engine: the refused brain stops as a resumable block that names the model', async () => {
  memoryDatabase.resetMemoryDb();
  const session = HarnessSession.create({ id: 'model-refused-host', kind: 'chat' });
  const input = 'Leave the fixture rep off the weekly roster.';
  const source = session.recordUserInput(input, 1);
  let requests = 0;
  const model = {
    async getResponse(): Promise<never> { requests += 1; throw refusedError(); },
    async *getStreamedResponse(): AsyncGenerator<never> { requests += 1; throw refusedError(); },
  };
  const agent = { model, tools: [], instructions: 'fixture' };
  const sealed = envelopes.sealAgentCapabilityUniverse({
    sessionId: session.id, universeTools: [], activeToolNames: [], policyHash: 'model-refused-v1',
    budget: { maxUncachedTokens: 30_000, maxModelCalls: 2, maxToolCalls: 1, maxElapsedMs: 10_000 },
  });
  assert.equal(sealed.ok, true);
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const result = await runTurn({
    sessionId: session.id, input, sourceUserSeq: source.seq, reuseRecordedUserInput: true,
    turnEngine: 'host_v1', agent: agent as never, judgeCompletion: false,
    suppressMemoryCapture: true, suppressAutomaticMemoryForRequest: true,
    makeRunner: () => new EventEmitter() as never,
    maxTurns: 1,
  });
  assert.equal(requests, 1, 'one request: a refused model is not retried');
  assert.equal(result.status, 'blocked');
  assert.equal(result.error, refusal.refusedModelPublicText(REFUSED));
  assert.equal(result.blockedReason, refusal.MODEL_REFUSED_BLOCKED_REASON);
  assert.notEqual(result.blockedResumable, false, 'the source can run again on another model');
});

test('legacy loop: the owner reads the model and what to do, never the generic failure', async () => {
  eventlog.resetEventLog();
  const session = HarnessSession.create({ kind: 'chat' });
  let calls = 0;
  const result = await runConversation({
    agent: {} as never,
    sessionId: session.id,
    input: 'Leave the fixture rep off the weekly roster.',
    makeRunner: () => new EventEmitter() as never,
    runRunner: async () => { calls += 1; throw refusedError(); },
  });
  assert.equal(calls, 1, 'no quiet retry of a refused model');
  assert.equal(result.publicPresentation?.kind, 'blocked');
  assert.equal(result.publicPresentation?.text, refusal.refusedModelPublicText(REFUSED));
  assert.notEqual(result.publicPresentation?.text, PUBLIC_RUN_FAILURE_TEXT);
});

test('the Codex brain choices are the sign-in\'s own catalog once it is known', () => {
  const merged = discovery.mergeOpenAiDiscovery(
    [{ id: REFUSED, label: 'Fixture API-key only' }, { id: 'gpt-9.9-fixture', label: 'Fixture both' }],
    [{ id: 'gpt-9.9-fixture', label: 'Fixture both', subscription: true }, { id: 'gpt-9.9-fixture-luna', label: 'Fixture sign-in', subscription: true }],
  );
  assert.deepEqual(merged.map((m) => [m.id, m.subscription === true]), [
    [REFUSED, false], ['gpt-9.9-fixture', true], ['gpt-9.9-fixture-luna', true],
  ]);
  writeFileSync(path.join(fixtureHome, 'state', 'auth.json'), JSON.stringify({
    // Shaped like a ChatGPT sign-in: the account id rides the access token.
    codexOauth: {
      accessToken: `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fixture' } })).toString('base64url')}.s`,
      refreshToken: 'codex-refresh',
    },
  }), 'utf-8');
  const codexChoices = () => roleOptions.connectedModelGroups().find((group) => group.provider === 'codex')?.models ?? [];
  discovery._setDiscoveredModelsForTest({ openai: merged });
  const offered = codexChoices().map((m) => m.id);
  assert.ok(offered.includes('gpt-9.9-fixture') && offered.includes('gpt-9.9-fixture-luna'));
  assert.equal(offered.includes(REFUSED), false, 'a model only an API key lists is not offered as a Codex brain');

  discovery._setDiscoveredModelsForTest({ openai: [{ id: REFUSED, label: 'Fixture API-key only' }] });
  assert.ok(codexChoices().some((m) => m.id === REFUSED), 'without the sign-in\'s catalog the list is unchanged');
});

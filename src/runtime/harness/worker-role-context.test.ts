import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-worker-role-context-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

// Import behind the disposable boundary, including the canonical eventlog
// owner before the route module (as the production orchestrator does).
const eventlog = await import('./eventlog.js');
const plans = await import('./plan-artifacts.js');
const { acceptedPlanExecution } = await import('./accepted-plan-execution.js');
const { buildAgentContextPacket } = await import('./context-packet.js');
const { resolveRoleModel } = await import('./model-roles.js');
const { createAgentRecord, deleteAgentRecord } = await import('../../agents/agent-record.js');
const { resolveWorkerAgentRequest } = await import('../../agents/agent-binding.js');
const { WorkerToolCallSchema } = await import('../../agents/worker-job-packet.js');
const { routeWorkerModel, _setWorkerRouteDepsForTests } = await import('./worker-model-route.js');

after(() => {
  _setWorkerRouteDepsForTests(null);
  rmSync(home, { recursive: true, force: true });
});

const controlledKeys = ['AUTH_MODE', 'MODEL_ROUTING_MODE', 'BYO_MODEL_BASE_URL', 'BYO_MODEL_API_KEY',
  'BYO_MODEL_ID', 'BYO_MODEL_JUDGE_ID', 'BYO_PROVIDERS', 'OPENAI_MODEL_WORKER',
  'CLEMMY_MODEL_ROLES', 'CLEMMY_MODEL_ROLES_REGISTRY', 'CLEMMY_ROUTE_POLICY'];

async function withRoleEnv(overrides: Record<string, string>, work: () => void | Promise<void>): Promise<void> {
  const previous = Object.fromEntries(controlledKeys.map((key) => [key, process.env[key]]));
  for (const key of controlledKeys) process.env[key] = '';
  Object.assign(process.env, {
    AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_ROUTE_POLICY: 'off', BYO_MODEL_BASE_URL: 'https://offline.example.test/v1',
    BYO_MODEL_API_KEY: 'offline-fixture-key', BYO_MODEL_ID: 'deepseek-chat',
    OPENAI_MODEL_WORKER: 'minimax-01',
  }, overrides);
  try { await work(); } finally {
    _setWorkerRouteDepsForTests(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const memory = { enabled: true, hitCount: 0, source: 'unified', injected: false };
const request = 'Have my configured Worker model role independently verify these synthetic records.';
const packet = {
  objective: 'Independently verify the supplied synthetic records.', item: 'verification',
  resolvedTools: 'none needed', externalMcpToolNames: null,
  context: 'Use only the supplied synthetic records.', instructions: 'Return findings without effects.',
  expectedOutput: 'Findings and calculation.', agent: null, model: null, intent: null,
};

test('current role facts expose a usable exact model selection without replacing a named specialist', async () => {
  await withRoleEnv({ CLEMMY_MODEL_ROLES: JSON.stringify([
    { role: 'worker', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' },
    { role: 'worker', modelId: 'minimax-01', whenIntent: 'research', scope: 'durable', source: 'chat-rule' },
  ]) }, async () => {
    const created = createAgentRecord({ name: 'Metric Desk', handles: 'Verify synthetic records',
      instructions: 'Check supplied values.', model: 'claude-opus-5-5' });
    assert.ok(created.ok); if (!created.ok) return;
    try {
      const context = buildAgentContextPacket(`${request} Metric Desk is a separate named specialist.`, memory,
        { sessionKind: 'chat', suppressConfirmBeat: true, skipCapabilityHunt: true });
      assert.match(context.text, /role-wide configuration, no intent\): model="deepseek-chat", provider=byo, source=settings/);
      assert.match(context.text, /agent:null, model:"deepseek-chat", intent:null/);
      assert.match(context.text, /Metric Desk: .*runs on claude-opus-5-5/);
      assert.match(context.text, /call run_worker with agent set to its name/);
      assert.match(context.text, /actual model\/provider from worker receipts/);
      assert.match(context.text, /exact account claims need account evidence/);

      const role = resolveRoleModel('worker');
      const selected = WorkerToolCallSchema.parse({ ...packet, model: role.modelId });
      assert.equal(resolveWorkerAgentRequest(selected).kind, 'none');
      _setWorkerRouteDepsForTests({
        catalog: () => [{ id: role.modelId, label: 'Configured Worker' },
          { id: 'minimax-01', label: 'Research Rule' }, { id: 'claude-opus-5-5', label: 'Metric Desk Model' }],
        defaultWorker: () => role, brainModelId: () => 'another-brain',
        intentRules: () => [{ intent: 'research', modelId: 'minimax-01' }],
        providerFor: (id) => id === 'claude-opus-5-5' ? 'claude' : 'byo',
        requestText: () => request,
        ask: async (input) => {
          assert.equal(input.questions.asked, undefined, 'neither the configured role nor a same-agent pin needs override authority');
          // Existing routing may classify saved rules even for an explicit
          // model. A confident competing rule still must not replace the pin.
          return { ok: true, model: 'inert-rule-check', answers: {
            rule: { type: 'choice', choice: 'r_0', probabilities: { r_0: 0.99 }, confidence: 0.99 },
            fit_0: { type: 'noul', noul: 0.99 },
          }, usage: { input_tokens: 0, output_tokens: 0 } };
        },
      });
      const routed = await routeWorkerModel({ ...selected, sessionId: 'role-fixture', sourceUserSeq: 1 });
      assert.equal(routed.kind, 'route'); if (routed.kind !== 'route') return;
      assert.equal(routed.model, 'deepseek-chat');
      assert.equal(routed.provider, 'byo');
      assert.equal(routed.trace.decidedBy, 'exact');
      assert.equal(routed.trace.askCheck, 'not_needed');
      assert.equal(routed.trace.matchedIntent, null, 'the explicit role model bypasses an unrelated saved intent rule');

      const named = resolveWorkerAgentRequest({ agent: created.agent.name, model: null });
      assert.equal(named.kind, 'bound'); if (named.kind !== 'bound') return;
      assert.equal(named.pinnedModel, 'claude-opus-5-5');
      const namedRoute = await routeWorkerModel({ model: named.model, ownerPinnedModel: named.pinnedModel,
        objective: packet.objective, sessionId: 'named-fixture', sourceUserSeq: 2 });
      assert.equal(namedRoute.kind, 'route'); if (namedRoute.kind !== 'route') return;
      assert.equal(namedRoute.model, 'claude-opus-5-5', 'the role affordance does not disable intentional specialists');
      assert.equal(namedRoute.exactModel, true);
    } finally { deleteAgentRecord(created.agent.id); }
  });
});

test('role configuration is refreshed for each packet and does not apply an intent rule as the role-wide choice', async () => {
  await withRoleEnv({ CLEMMY_MODEL_ROLES: JSON.stringify([
    { role: 'worker', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' },
    { role: 'worker', modelId: 'minimax-01', whenIntent: 'research', scope: 'durable', source: 'chat-rule' },
  ]) }, () => {
    const first = buildAgentContextPacket(request, memory, { suppressConfirmBeat: true, skipCapabilityHunt: true });
    assert.match(first.text, /role-wide configuration, no intent\): model="deepseek-chat"/);
    process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
      { role: 'worker', modelId: 'minimax-01', scope: 'durable', source: 'chat-rule' },
    ]);
    const second = buildAgentContextPacket(request, memory, { suppressConfirmBeat: true, skipCapabilityHunt: true });
    assert.match(second.text, /role-wide configuration, no intent\): model="minimax-01", provider=byo, source=chat-rule/);
    assert.doesNotMatch(second.text, /model="deepseek-chat"/);
  });
});

test('an unavailable saved choice is disclosed separately from its effective fallback', async () => {
  await withRoleEnv({ BYO_MODEL_BASE_URL: '', BYO_MODEL_API_KEY: '', OPENAI_MODEL_WORKER: '',
    CLEMMY_MODEL_ROLES: JSON.stringify([
      { role: 'worker', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' },
    ]) }, () => {
    const role = resolveRoleModel('worker');
    assert.equal(role.inactiveBinding?.modelId, 'deepseek-chat');
    const context = buildAgentContextPacket(request, memory, { suppressConfirmBeat: true, skipCapabilityHunt: true });
    assert.match(context.text, /saved model="deepseek-chat", provider=byo, source=settings is unavailable/);
    assert.ok(context.text.includes(`current fallback model=${JSON.stringify(role.modelId)}, provider=${role.provider}`));
    assert.match(context.text, /fallback is not that saved choice/);
    assert.doesNotMatch(context.text, /call run_worker with agent:null, model:/, 'do not offer the fallback as the exact saved choice');
  });
});

test('zero-tool conversation, typed-decline and runner-owned workflow packets omit delegation configuration', async () => {
  await withRoleEnv({}, () => {
    for (const opts of [{ plainConversationSurface: true }, { suppressSemanticEnrichment: true }, { sessionKind: 'workflow' }]) {
      const context = buildAgentContextPacket('No, please leave that alone.', memory,
        { ...opts, suppressConfirmBeat: true, skipCapabilityHunt: true });
      assert.doesNotMatch(context.text, /Worker model role/);
    }
  });
});

test('exact accepted read-only Execute retains Worker facts without changing its reviewed execution claim', async () => {
  await withRoleEnv({ CLEMMY_MODEL_ROLES: JSON.stringify([
    { role: 'worker', modelId: 'deepseek-chat', scope: 'durable', source: 'settings' },
  ]) }, () => {
    for (const readOnly of [true, false]) {
      const session = eventlog.createSession({ id: `worker-role-execute-${readOnly}`, kind: 'chat', userId: 'fixture-owner' });
      const scope = { sessionId: session.id, principalId: 'fixture-owner' };
      const preparation = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
        type: 'user_input_received', data: { text: 'Prepare the synthetic verification plan.',
          taskMode: { version: 1, kind: 'plan' } } });
      const artifact = plans.publishPlanRevision({ ...scope, sourceUserSeq: preparation.seq,
        fullText: 'Verify the supplied synthetic records using the configured Worker role; report the exact result.',
        readiness: 'ready', structuredPlan: {
          steps: [{ id: 'verify', effect: 'compute', dependencies: [] }],
          successCriteria: ['The supplied records have an independently verified calculation.'],
          executionDraft: readOnly ? null : { nodes: [] },
        } });
      const executeRef = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
      const source = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user',
        type: 'user_input_received', data: { text: request,
          taskMode: { version: 1, kind: 'execute', executeRef } } });
      const claimed = plans.claimPlanExecution({ ...scope, sourceUserSeq: source.seq, executeRef });
      const before = acceptedPlanExecution(session.id, source.seq);
      assert.equal(before?.claim.claimId, claimed.claim.claimId);
      const context = buildAgentContextPacket(request, memory, { sessionKind: 'chat', sessionId: session.id,
        sourceUserSeq: source.seq, suppressConfirmBeat: true, skipCapabilityHunt: true });
      if (readOnly) {
        assert.match(context.text, /role-wide configuration, no intent\): model="deepseek-chat", provider=byo, source=settings/);
        assert.match(context.text, /agent:null, model:"deepseek-chat", intent:null/);
      } else assert.doesNotMatch(context.text, /Worker model role/);
      assert.equal(context.agentSystem.policy, null, 'role facts cannot import global coordination policy into Execute');
      assert.doesNotMatch(context.text, /Fan-out directive|Fan-out constrained|AGENT SYSTEM GUIDANCE/);
      assert.deepEqual(acceptedPlanExecution(session.id, source.seq), before, 'context cannot change the exact execution reservation or reviewed bytes');

      const unclaimed = eventlog.appendEvent({ sessionId: session.id, turn: 3, role: 'user',
        type: 'user_input_received', data: { text: request,
          taskMode: { version: 1, kind: 'execute', executeRef } } });
      const unclaimedContext = buildAgentContextPacket(request, memory, { sessionKind: 'chat', sessionId: session.id,
        sourceUserSeq: unclaimed.seq, suppressConfirmBeat: true, skipCapabilityHunt: true });
      assert.doesNotMatch(unclaimedContext.text, /Worker model role/, 'a different source cannot borrow the claimed worker surface');
    }
  });
});

test('a default Worker with no pick, no intent rule and no saved agent adds no line to the turn', async () => {
  // model:null already is the role here; the line was ~590 bytes on every
  // round of every action turn (10-10 Lean Rounds).
  await withRoleEnv({ CLEMMY_MODEL_ROLES: '[]' }, () => {
    const context = buildAgentContextPacket(request, memory,
      { sessionKind: 'chat', suppressConfirmBeat: true, skipCapabilityHunt: true });
    assert.doesNotMatch(context.text, /Worker model role/);
  });
  // An intent rule alone brings it back: model:null then routes by the rule.
  await withRoleEnv({ CLEMMY_MODEL_ROLES: JSON.stringify([
    { role: 'worker', modelId: 'minimax-01', whenIntent: 'research', scope: 'durable', source: 'chat-rule' },
  ]) }, () => {
    const context = buildAgentContextPacket(request, memory,
      { sessionKind: 'chat', suppressConfirmBeat: true, skipCapabilityHunt: true });
    assert.match(context.text, /Worker model role \(role-wide configuration, no intent\)/);
  });
});

/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/cloud-browser-refusal-settlement.test.ts
 * Exercise the registered tool, local bridge, and durable settlement together.
 * Provider refusal proves no effect; it does not prove no request was made.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { BrowserbaseDependencies } from '../../integrations/browserbase.js';
import type { AttemptSignals } from './attempt-outcome.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cloud-browser-refusal-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'cloud-browser-refusal\n');
// Reviewed discovery selects the browser backend from the process home before
// the registered singleton is bound to each isolated service fixture below.
mkdirSync(path.join(home, 'state', 'browserbase'), { recursive: true });
writeFileSync(path.join(home, 'state', 'browserbase', 'resources.json'), JSON.stringify({
  version: 1, revision: 1, resources: [],
  policy: { projectId: '10000000-0000-4000-8000-000000000001', idleSeconds: 900, sessionTimeoutSeconds: 7200 },
}));

const events = await import('./eventlog.js');
const { getLocalDeferredDispatchTools } = await import('../../tools/local-runtime-tools.js');
const { HostLocalNonWriteResult, HostLocalExecutionFailureResult, InvalidArgumentsPreDispatchResult, settleToolAttempt } = await import('./attempt-settlement.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const { redeemDurableLogicalCallSettlementForHost } = await import('./logical-call-settlement-store.js');
const { BrowserbaseService, getBrowserbaseService } = await import('../../integrations/browserbase.js');
const { BrowserbaseClientError } = await import('../../integrations/browserbase-client.js');
const { BrowserbaseCdpError } = await import('../../integrations/browserbase-cdp.js');
const { LocalNonWriteError, LocalExecutionFailureError } = await import('../../tools/shared.js');
const reviewed = await import('./reviewed-local-tool-transport.js');
const { createReviewedCloudBrowserStorageAdapter } = await import('./reviewed-local-storage-carrier.js');
const { capabilityManifestDigest } = await import('./capability-manifest.js');
const { withToolOutputContext } = await import('./tool-output-context.js');
const singleton = getBrowserbaseService();
const adapter = getLocalDeferredDispatchTools().find(tool => tool.type === 'function' && tool.name === 'cloud_browser_start');
assert.ok(adapter, 'the real deferred adapter exposes the registered cloud_browser_start');

after(() => {
  singleton.dispose();
  events.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

const projectId = '10000000-0000-4000-8000-000000000001';
const providerSessionId = '20000000-0000-4000-8000-000000000002';
let serial = 0;

function accepted() {
  const session = events.createSession({ id: `cloud-browser-refusal-${++serial}`, kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'Start a cloud browser for this task.' } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1,
    acceptedTaskId: acceptedTaskIdFor(session.id, source.seq) };
  assert.ok(recordTurnGraphShadow({ identity }));
  return identity;
}

async function invokeAndSettle(identity: ReturnType<typeof accepted>, callId: string,
  args: Record<string, unknown> = {}, options: { preDispatch?: boolean; expectThrow?: boolean;
    signals?: AttemptSignals; produce?: () => Promise<unknown> } = {}) {
  const logicalIdentity = { ...identity, logicalToolCallId: callId };
  const opened = options.preDispatch
    ? dispatch.admitLogicalCall({ identity: logicalIdentity, tool: 'cloud_browser_start', args })
    : dispatch.beginPhysicalDispatch({ identity: { ...logicalIdentity, physicalDispatchId: `host:${callId}`, ordinal: 0 },
      tool: 'cloud_browser_start', args, executionSite: 'host' });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  let result: unknown, thrown: unknown, didThrow = false;
  try {
    result = await (options.produce ? options.produce() : adapter!.invoke(
      { context: identity } as never, JSON.stringify(args), { toolCall: { callId } } as never));
  } catch (error) {
    didThrow = true; thrown = error;
  }
  assert.equal(didThrow, options.expectThrow === true, `Unexpected adapter disposition: ${String(thrown ?? result)}`);
  if (!options.preDispatch) {
    assert.equal(dispatch.settlePhysicalDispatch({
      identity: { ...logicalIdentity, physicalDispatchId: `host:${callId}`, ordinal: 0 },
      tool: 'cloud_browser_start', outcome: didThrow ? 'threw' : 'returned',
    }).status, 'inserted');
  }
  const settlement = settleToolAttempt({ ...identity, callId, toolName: 'cloud_browser_start', args,
    lane: 'agents_runner', mutating: true, businessCall: true,
    ...(options.signals ? { signals: options.signals } : {}), ...(didThrow ? { thrown } : { result }) });
  const durable = redeemDurableLogicalCallSettlementForHost(logicalIdentity);
  assert.equal(durable.status, 'ok', JSON.stringify(durable));
  if (durable.status !== 'ok') throw new Error('The exact durable settlement must redeem');
  assert.deepEqual(durable.settlement.outcome, settlement.outcome);
  // This fixture records the real host adapter invocation. A provider status
  // must not manufacture a provider-owned dispatch row in that ledger.
  assert.equal(durable.settlement.physicalCrossingCount, 0);
  assert.equal(durable.settlement.hostCrossingCount, options.preDispatch ? 0 : 1);
  assert.equal(durable.settlement.executionKind, options.preDispatch ? 'refused_pre_dispatch' : 'local_execution');
  if (!options.preDispatch) assert.equal(durable.settlement.crossings[0]!.terminalState, didThrow ? 'threw' : 'returned');
  return { result, thrown, settlement, durable: durable.settlement };
}

function invokeReviewedAndSettle(identity: ReturnType<typeof accepted>, callId: string) {
  const observed = reviewed.observeReviewedLocalTool('cloud_browser_start');
  assert.ok(observed, 'the exact reviewed cloud start definition exists');
  const manifest = reviewed.reviewedLocalCapabilityManifest(observed);
  assert.ok(manifest);
  const call = { operationId: 'cloud_browser_start', accountId: reviewed.REVIEWED_LOCAL_ACCOUNT, args: {},
    expected: { manifestId: observed.manifestId, manifestDigest: capabilityManifestDigest(manifest),
      providerKind: 'local_registry' as const, providerIdentity: reviewed.REVIEWED_LOCAL_PROVIDER_IDENTITY,
      providerVersion: reviewed.REVIEWED_LOCAL_PROVIDER_VERSION, operationVersion: reviewed.REVIEWED_LOCAL_OPERATION_VERSION,
      definitionFingerprint: observed.definition.envelopeFingerprint, invokePortId: observed.invokePortId,
      argumentCompiler: { ...reviewed.REVIEWED_LOCAL_ARGUMENT_COMPILER } } };
  const storage = createReviewedCloudBrowserStorageAdapter();
  return invokeAndSettle(identity, callId, {}, { expectThrow: true, produce: async () =>
    withToolOutputContext({ ...identity, callId, toolName: 'cloud_browser_start' }, () => storage.execute(call)) });
}

async function withBrowserService<T>(options: { createFailure?: Error; tabsFailure?: Error },
  work: (fixture: { service: InstanceType<typeof BrowserbaseService>; counts: () => { creates: number; tabs: number };
    stored: () => Array<Record<string, unknown>>; restart: () => void }) => Promise<T>): Promise<T> {
  const baseDir = mkdtempSync(path.join(home, 'service-'));
  let creates = 0, tabs = 0;
  const observed = () => ({ sessionId: providerSessionId, projectId, status: 'RUNNING' as const,
    connectUrl: `wss://connect.browserbase.com/?sessionId=${providerSessionId}&apiKey=synthetic-key` });
  const api: NonNullable<BrowserbaseDependencies['api']> = {
    async create() { creates++; if (options.createFailure) throw options.createFailure; return observed(); },
    async retrieve() { return observed(); },
    async release() { throw new Error('Unexpected release in refusal fixture'); },
    async liveView() { throw new Error('Unexpected live view in refusal fixture'); },
  };
  const cdp: NonNullable<BrowserbaseDependencies['cdp']> = {
    async execute(_url, _session, operation) {
      assert.equal(operation, 'tabs'); tabs++;
      if (options.tabsFailure) throw options.tabsFailure;
      return { result: { ok: true }, effect: 'none', targetId: null,
        pages: [{ targetId: 'page-a', title: 'Fixture page', url: 'about:blank' }] };
    },
    async humanText() { throw new Error('Unexpected human operation in refusal fixture'); },
  };
  const dependencies = { baseDir, api, cdp, getApiKey: async () => 'synthetic-key', autoMaintenance: false };
  let service = new BrowserbaseService(dependencies);
  const original = { list: singleton.list, create: singleton.create, agentOperation: singleton.agentOperation };
  const bind = () => {
    singleton.list = service.list.bind(service);
    singleton.create = service.create.bind(service);
    singleton.agentOperation = service.agentOperation.bind(service);
  };
  try {
    await service.configure({ projectId });
    bind();
    return await work({ get service() { return service; }, counts: () => ({ creates, tabs }),
      restart: () => { service.dispose(); service = new BrowserbaseService(dependencies); bind(); },
      stored: () => JSON.parse(readFileSync(path.join(baseDir, 'state/browserbase/resources.json'), 'utf8')).resources });
  } finally {
    singleton.list = original.list;
    singleton.create = original.create;
    singleton.agentOperation = original.agentOperation;
    service.dispose();
    rmSync(baseDir, { recursive: true, force: true });
  }
}

for (const status of [402, 429]) {
  test(`provider limit ${status} survives the real bridge as input required, with no retry authority`, { concurrency: false }, async () => {
    await withBrowserService({ createFailure: new BrowserbaseClientError('provider_limit', false, status) }, async fixture => {
      const { result, settlement } = await invokeAndSettle(accepted(), `limit-${status}`);
      assert.ok(result instanceof HostLocalNonWriteResult);
      assert.equal(result.classification?.providerStatus, status);
      assert.equal(settlement.outcome.kind, 'input_required');
      assert.equal(settlement.outcome.providerStatus, String(status));
      assert.equal(settlement.outcome.directive.action, 'ask_user');
      assert.equal(settlement.outcome.directive.retrySameCandidate, false);
      assert.equal(settlement.outcome.directive.requiresReconciliation, false);
      assert.equal(settlement.outcome.directive.eliminatesCandidate, false);
      assert.deepEqual(fixture.counts(), { creates: 1, tabs: 0 });
      assert.equal(fixture.stored().length, 1);
      assert.equal(fixture.stored()[0]!.state, 'stopped');
      assert.equal(fixture.stored()[0]!.providerSessionId, null);
      assert.equal(fixture.stored()[0]!.errorHttpStatus, status);
      assert.equal(fixture.stored()[0]!.pending, undefined);
    });
  });
}

test('explicit refusal classifications never override prior lane policy or uncertainty', { concurrency: false }, async () => {
  for (const thrown of [false, true]) {
    for (const prior of [
      { signals: { policyRefused: true }, kind: 'policy_denial', action: 'stop_and_explain', reconcile: false },
      { signals: { acknowledged: false }, kind: 'uncertain_write', action: 'reconcile_then_decide', reconcile: true },
    ] as const) {
      const classification = { kind: 'input_required' as const, providerStatus: 402 };
      const { settlement } = await invokeAndSettle(accepted(), `priority-${thrown}-${prior.kind}`, {}, {
        expectThrow: thrown, signals: prior.signals, produce: async () => {
          if (thrown) throw new LocalNonWriteError('The provider refused.', 'provider_limit', classification);
          return new HostLocalNonWriteResult('The provider refused.', 'provider_limit', classification);
        },
      });
      assert.equal(settlement.outcome.kind, prior.kind);
      assert.equal(settlement.outcome.directive.action, prior.action);
      assert.equal(settlement.outcome.directive.retrySameCandidate, false);
      assert.equal(settlement.outcome.directive.requiresReconciliation, prior.reconcile);
      assert.equal(settlement.outcome.providerStatus, undefined, 'lower-priority metadata cannot relabel the verdict');
    }
  }
});

test('rejected credentials retain auth recovery and the original provider status', { concurrency: false }, async () => {
  await withBrowserService({ createFailure: new BrowserbaseClientError('credential_rejected', false, 401) }, async fixture => {
    const { result, settlement } = await invokeAndSettle(accepted(), 'credential-rejected');
    assert.ok(result instanceof HostLocalNonWriteResult);
    assert.equal(result.classification?.providerStatus, 401);
    assert.equal(settlement.outcome.kind, 'auth_failure');
    assert.equal(settlement.outcome.providerStatus, '401');
    assert.equal(settlement.outcome.directive.action, 'recover_connection');
    assert.equal(settlement.outcome.directive.retrySameCandidate, false);
    assert.equal(settlement.outcome.directive.requiresReconciliation, false);
    assert.equal(fixture.stored()[0]!.errorHttpStatus, 401);
    assert.deepEqual(fixture.counts(), { creates: 1, tabs: 0 });
  });
});

test('genuine malformed arguments remain repairable before the service is called', { concurrency: false }, async () => {
  await withBrowserService({}, async fixture => {
    const { result, settlement } = await invokeAndSettle(accepted(), 'malformed', { url: 123 }, { preDispatch: true });
    assert.ok(result instanceof InvalidArgumentsPreDispatchResult);
    assert.equal(settlement.outcome.kind, 'invalid_arguments');
    assert.equal(settlement.outcome.directive.action, 'repair_arguments');
    assert.equal(settlement.outcome.directive.retrySameCandidate, true);
    assert.equal(settlement.outcome.directive.requiresReconciliation, false);
    assert.deepEqual(fixture.counts(), { creates: 0, tabs: 0 });
    assert.deepEqual(fixture.stored(), []);
  });
});

test('an unacknowledged create timeout retains uncertainty and its pending reservation', { concurrency: false }, async () => {
  await withBrowserService({ createFailure: new BrowserbaseClientError('timeout', true) }, async fixture => {
    const identity = accepted();
    const first = await invokeAndSettle(identity, 'create-timeout');
    const repeated = await invokeAndSettle(identity, 'create-timeout-repeat');
    for (const { result, settlement } of [first, repeated]) {
      assert.equal(result instanceof HostLocalNonWriteResult, false);
      assert.ok(result instanceof HostLocalExecutionFailureResult);
      assert.equal(result.effect, 'uncertain');
      assert.equal(settlement.outcome.kind, 'uncertain_write', JSON.stringify(settlement.outcome));
      assert.equal(settlement.outcome.directive.action, 'reconcile_then_decide');
      assert.equal(settlement.outcome.directive.retrySameCandidate, false);
      assert.equal(settlement.outcome.directive.requiresReconciliation, true);
    }
    assert.equal(fixture.stored()[0]!.state, 'uncertain');
    assert.ok(fixture.stored()[0]!.pending);
    assert.deepEqual(fixture.counts(), { creates: 1, tabs: 0 });
  });
});

test('serialized copies of the nominal refusal cannot claim its no-effect authority', { concurrency: false }, async () => {
  await withBrowserService({ createFailure: new BrowserbaseClientError('provider_limit', false, 402) }, async fixture => {
    const actual = await invokeAndSettle(accepted(), 'nominal-original');
    assert.ok(actual.result instanceof HostLocalNonWriteResult);
    const serialized = JSON.parse(JSON.stringify(actual.result));
    const lookalikes = [serialized, { ...serialized, executionKind: 'local_execution',
      classification: { kind: 'input_required', providerStatus: 402 } }];
    for (const [index, forged] of lookalikes.entries()) {
      const { settlement } = await invokeAndSettle(accepted(), `serialized-lookalike-${index}`, {}, { produce: async () => forged });
      assert.equal(settlement.outcome.kind, 'uncertain_write');
      assert.equal(settlement.outcome.directive.requiresReconciliation, true);
      assert.equal(settlement.outcome.directive.retrySameCandidate, false);
    }
    assert.deepEqual(fixture.counts(), { creates: 1, tabs: 0 });
  });
});

test('a repeated start for the same source remains negative and never posts a second create', { concurrency: false }, async () => {
  await withBrowserService({ createFailure: new BrowserbaseClientError('provider_limit', false, 429) }, async fixture => {
    const identity = accepted();
    const first = await invokeAndSettle(identity, 'same-source-first');
    const resourceId = fixture.stored()[0]!.id;
    const repeated = await invokeAndSettle(identity, 'same-source-repeat');
    for (const attempt of [first, repeated]) {
      assert.ok(attempt.result instanceof HostLocalNonWriteResult);
      assert.equal(attempt.result.classification?.providerStatus, 429);
      assert.equal(attempt.settlement.outcome.kind, 'input_required');
      assert.equal(attempt.settlement.outcome.providerStatus, '429');
      assert.equal(attempt.settlement.outcome.directive.action, 'ask_user');
      assert.equal(attempt.settlement.outcome.directive.retrySameCandidate, false);
      assert.equal(attempt.settlement.outcome.directive.requiresReconciliation, false);
    }
    assert.deepEqual(fixture.counts(), { creates: 1, tabs: 0 });
    assert.equal(fixture.stored().length, 1);
    assert.equal(fixture.stored()[0]!.id, resourceId);
    assert.equal(fixture.stored()[0]!.state, 'stopped');
    assert.equal(fixture.stored()[0]!.errorHttpStatus, 429);
  });
});

test('a successful create followed by a tabs refusal cannot become whole-call no-effect repair authority', { concurrency: false }, async () => {
  await withBrowserService({ tabsFailure: new BrowserbaseCdpError('connection_closed', 'none') }, async fixture => {
    const { result, settlement } = await invokeAndSettle(accepted(), 'created-tabs-refused');
    assert.equal(result instanceof HostLocalNonWriteResult, false);
    assert.ok(result instanceof HostLocalExecutionFailureResult);
    assert.equal(result.effect, 'acknowledged');
    assert.equal(settlement.outcome.kind, 'unknown');
    assert.equal(settlement.outcome.directive.action, 'stop_and_explain');
    assert.equal(settlement.outcome.directive.retrySameCandidate, false);
    assert.equal(settlement.outcome.directive.requiresReconciliation, false);
    const retained = JSON.parse(String(result));
    assert.equal(retained.resource.providerSessionId, providerSessionId);
    assert.equal(retained.resource.state, 'active');
    assert.equal(retained.observation.ok, false);
    assert.equal(retained.observation.effect, 'none');
    assert.equal(fixture.stored()[0]!.providerSessionId, providerSessionId);
    assert.equal(fixture.stored()[0]!.state, 'active');
    assert.deepEqual(fixture.counts(), { creates: 1, tabs: 1 });
  });
});

for (const refusal of [
  { status: 402, code: 'provider_limit', kind: 'input_required', action: 'ask_user' },
  { status: 429, code: 'provider_limit', kind: 'input_required', action: 'ask_user' },
  { status: 401, code: 'credential_rejected', kind: 'auth_failure', action: 'recover_connection' },
] as const) {
  test(`reviewed storage retains thrown ${refusal.status} refusal through durable settlement`, { concurrency: false }, async () => {
    await withBrowserService({ createFailure: new BrowserbaseClientError(refusal.code, false, refusal.status) }, async fixture => {
      const { result, thrown, settlement } = await invokeReviewedAndSettle(accepted(), `reviewed-${refusal.status}`);
      assert.equal(result, undefined, 'the reviewed adapter must not return a successful value');
      assert.ok(thrown instanceof LocalNonWriteError);
      assert.equal(thrown.status, refusal.code);
      assert.deepEqual(thrown.classification, { kind: refusal.kind, providerStatus: refusal.status });
      assert.equal(settlement.outcome.kind, refusal.kind);
      assert.equal(settlement.outcome.providerStatus, String(refusal.status));
      assert.equal(settlement.outcome.directive.action, refusal.action);
      assert.equal(settlement.outcome.directive.retrySameCandidate, false);
      assert.equal(settlement.outcome.directive.requiresReconciliation, false);
      assert.equal(fixture.stored()[0]!.state, 'stopped');
      assert.equal(fixture.stored()[0]!.errorHttpStatus, refusal.status);
      assert.deepEqual(fixture.counts(), { creates: 1, tabs: 0 });
    });
  });
}

test('reviewed storage keeps first and repeated timeout failures uncertain', { concurrency: false }, async () => {
  await withBrowserService({ createFailure: new BrowserbaseClientError('timeout', true) }, async fixture => {
    const identity = accepted();
    for (const callId of ['reviewed-timeout-first', 'reviewed-timeout-repeat']) {
      const { result, thrown, settlement } = await invokeReviewedAndSettle(identity, callId);
      assert.equal(result, undefined);
      assert.ok(thrown instanceof LocalExecutionFailureError);
      assert.equal(thrown.effect, 'uncertain');
      assert.equal(settlement.outcome.kind, 'uncertain_write');
      assert.equal(settlement.outcome.directive.action, 'reconcile_then_decide');
      assert.equal(settlement.outcome.directive.retrySameCandidate, false);
      assert.equal(settlement.outcome.directive.requiresReconciliation, true);
    }
    assert.equal(fixture.stored()[0]!.state, 'uncertain');
    assert.ok(fixture.stored()[0]!.pending);
    assert.deepEqual(fixture.counts(), { creates: 1, tabs: 0 });
  });
});

test('reviewed storage reports failed page observation without denying an acknowledged create', { concurrency: false }, async () => {
  await withBrowserService({ tabsFailure: new BrowserbaseCdpError('connection_closed', 'none') }, async fixture => {
    const { result, thrown, settlement } = await invokeReviewedAndSettle(accepted(), 'reviewed-created-tabs-refused');
    assert.equal(result, undefined);
    assert.ok(thrown instanceof LocalExecutionFailureError);
    assert.equal(thrown.effect, 'acknowledged');
    assert.equal(settlement.outcome.kind, 'unknown');
    assert.equal(settlement.outcome.directive.action, 'stop_and_explain');
    assert.equal(settlement.outcome.directive.retrySameCandidate, false);
    assert.equal(settlement.outcome.directive.requiresReconciliation, false);
    const retained = JSON.parse(thrown.message);
    assert.equal(retained.resource.providerSessionId, providerSessionId);
    assert.equal(retained.resource.state, 'active');
    assert.equal(retained.observation.ok, false);
    assert.equal(retained.observation.effect, 'none');
    assert.equal(fixture.stored()[0]!.state, 'active');
    assert.deepEqual(fixture.counts(), { creates: 1, tabs: 1 });
  });
});

test('a serialized LocalNonWriteError lookalike cannot give a thrown failure no-effect authority', { concurrency: false }, async () => {
  await withBrowserService({ createFailure: new BrowserbaseClientError('provider_limit', false, 402) }, async fixture => {
    const actual = await invokeReviewedAndSettle(accepted(), 'reviewed-nominal-original');
    assert.ok(actual.thrown instanceof LocalNonWriteError);
    const forged = JSON.parse(JSON.stringify({ ...actual.thrown, message: actual.thrown.message }));
    assert.equal(forged.name, 'LocalNonWriteError');
    assert.deepEqual(forged.classification, { kind: 'input_required', providerStatus: 402 });
    const { settlement } = await invokeAndSettle(accepted(), 'reviewed-thrown-lookalike', {}, {
      expectThrow: true, produce: async () => { throw forged; },
    });
    assert.equal(settlement.outcome.kind, 'uncertain_write');
    assert.equal(settlement.outcome.directive.requiresReconciliation, true);
    assert.equal(settlement.outcome.directive.retrySameCandidate, false);
    assert.deepEqual(fixture.counts(), { creates: 1, tabs: 0 });
  });
});

for (const status of [402, 429]) {
  test(`stopped ${status} reservation retains its refusal after restart and across adapter lanes`, { concurrency: false }, async () => {
    await withBrowserService({ createFailure: new BrowserbaseClientError('provider_limit', false, status) }, async fixture => {
      const identity = accepted();
      const first = await invokeAndSettle(identity, `restart-${status}-first`);
      assert.equal(first.settlement.outcome.kind, 'input_required');
      const resourceId = fixture.stored()[0]!.id;
      fixture.restart();
      const repeated = await invokeReviewedAndSettle(identity, `restart-${status}-repeat`);
      assert.ok(repeated.thrown instanceof LocalNonWriteError);
      assert.equal(repeated.thrown.classification.providerStatus, status);
      assert.equal(repeated.settlement.outcome.kind, 'input_required');
      assert.equal(repeated.settlement.outcome.providerStatus, String(status));
      assert.equal(repeated.settlement.outcome.directive.action, 'ask_user');
      assert.equal(repeated.settlement.outcome.directive.retrySameCandidate, false);
      assert.equal(repeated.settlement.outcome.directive.requiresReconciliation, false);
      assert.equal(fixture.stored().length, 1);
      assert.equal(fixture.stored()[0]!.id, resourceId);
      assert.equal(fixture.stored()[0]!.state, 'stopped');
      assert.equal(fixture.stored()[0]!.errorHttpStatus, status);
      assert.deepEqual(fixture.counts(), { creates: 1, tabs: 0 });
    });
  });
}

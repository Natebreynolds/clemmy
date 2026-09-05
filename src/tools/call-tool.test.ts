/**
 * Run: npx tsx --test src/tools/call-tool.test.ts
 *
 * call_tool — the schema-on-demand generic dispatcher (Phase 1). Proves:
 *  - AUTHORITY: refuses a target that is not on the orchestrator surface (no escalation).
 *  - ARG VALIDATION: bad args return {error:'arg_validation', schema} with NO dispatch.
 *  - GATE PARITY: a mutating inner tool routed through call_tool trips the SAME
 *    write-boundary gate (keyed on the INNER name), via the _setInnerDispatchToolsForTests seam.
 *  - PROMOTION: a successful dispatch records the reached tool to the session hot-set.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRIOR_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-call-tool-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildCallTool,
  _resetCallToolSchemaCacheForTest,
  materializeStrictNullableFields,
} = await import('./call-tool.js');
const {
  _setInnerDispatchToolsForTests,
  _setInnerDispatchMcpResolverForTests,
} = await import('./inner-dispatch.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const {
  withHarnessRunContext,
  ToolCallsCounter,
  ToolCallsLimitExceeded,
  wrapToolForHarness,
} = await import('../runtime/harness/brackets.js');
const { getHotSet, _resetHotSetForTest } = await import('../agents/tool-hotset.js');
const {
  appendEvent,
  closeEventLog,
  createSession,
  getSession,
  listEvents,
  openEventLog,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const { acceptedTaskIdFor } = await import('../runtime/harness/attempt-identity.js');
const settlements = await import('../runtime/harness/logical-call-settlement-store.js');
const { closeOperationalTelemetryDb } = await import('../runtime/operational-telemetry.js');
const { getLocalToolSchemas } = await import('./local-runtime-tools.js');
const { deriveOrchestratorDiscoveryNames } = await import('./tool-registry.js');
const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const capabilityManifests = await import('../runtime/harness/capability-manifest.js');
const {
  appendAgentCapabilityBinding,
  bindAgentCapabilityEnvelope,
  bindAgentCapabilityRevision,
  boundAgentCapabilityRevision,
  sealAgentCapabilityUniverse,
} = await import('../agents/capability-envelope.js');

type ToolLike = { invoke?: (ctx: unknown, input: string, details: unknown) => Promise<unknown> };

type FixtureOperationContract = {
  operationId: string;
  effect: 'read' | 'external_write';
  reversibility?: 'reversible' | 'ordinary_non_destructive' | 'irreversible';
};

/**
 * Install the same positive authority production consumes at the effect
 * boundary: one exact, current, digest-valid manifest per fake provider
 * operation.  Provider/action spelling remains identity only.  Reads are
 * authorized by manifest.effect; writes additionally carry the sealed generic
 * reversibility fact used by execution/approval policy.
 */
function installFixtureOperationContracts(
  contracts: readonly FixtureOperationContract[],
): () => void {
  const previous = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
  for (const contract of contracts) {
    if (contract.effect === 'external_write') {
      assert.ok(contract.reversibility, `${contract.operationId} must declare reversibility`);
    }
    const manifest = capabilityManifests.attachSemanticContract({
      version: 1,
      manifestId: `cap:fixture:call-tool:${contract.operationId.toLowerCase()}`,
      providerKind: 'composio',
      operationId: contract.operationId,
      providerIdentity: 'fixture:call-tool:configured-provider',
      providerVersion: '2026-08-27',
      operationVersion: '1',
      definitionFingerprint: 'c'.repeat(64),
      effect: contract.effect,
      ...(contract.effect === 'external_write'
        ? {
            operationSemantics: {
              version: 1 as const,
              reversibility: contract.reversibility!,
            },
          }
        : {}),
      accountId: 'account:fixture:call-tool',
      idempotency: contract.effect === 'external_write'
        ? { required: true, policy: 'key_before_dispatch' }
        : { required: false, policy: 'none' },
      reconciliation: contract.effect === 'external_write'
        ? { supported: true, policy: 'exact_provider_readback' }
        : { supported: false, policy: 'none' },
      outputContract: { kind: contract.effect === 'read' ? 'records' : 'provider_acknowledgement' },
      evidenceContract: {
        kinds: ['receipt'],
        readbackRequired: contract.effect === 'external_write',
      },
      purpose: contract.effect === 'read' ? 'collect_records' : 'persist_collection',
      provenance: {
        issuer: 'call-tool:test-fixture',
        issuedAt: '2026-08-27T00:00:00.000Z',
        trusted: true,
      },
      lifecycle: { state: 'current' },
    });
    const entry = {
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect,
      account: manifest.accountId,
      manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: async () => {
        throw new Error('fixture catalog invoke must remain unreachable');
      },
    };
    factory.register(entry);
    assert.equal(
      capabilityCatalogs.isCurrentCallableCatalogEntry(factory.get(manifest.manifestId)!),
      true,
      `${contract.operationId} fixture manifest must be current and callable`,
    );
  }
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
  return () => capabilityCatalogs.installHostCapabilityCatalogFactory(previous);
}

/**
 * Production no longer lets a bracketed tool mint settlement authority from a
 * session id alone. Give each legacy component fixture the same exact accepted
 * source + persisted graph the real turn spine establishes before dispatch.
 * Reuse it for later calls in the same fixture session; after resetEventLog the
 * durable marker disappears and a fresh source is created automatically.
 */
function acceptedSourceForCallToolFixture(sessionId: string): { sourceUserSeq: number; turn: number } {
  if (!getSession(sessionId)) createSession({ id: sessionId, kind: 'chat' });
  const existing = listEvents(sessionId, { types: ['user_input_received'] })
    .find((event) => event.data.callToolAuthorityFixture === true);
  if (existing) return { sourceUserSeq: existing.seq, turn: existing.turn };
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Hello', callToolAuthorityFixture: true },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: source.turn },
  }));
  return { sourceUserSeq: source.seq, turn: source.turn };
}

function invokeCallToolFixture(
  callTool: ToolLike,
  sessionId: string,
  input: string,
  callId: string,
  counter = new ToolCallsCounter(1_000),
): Promise<unknown> {
  const accepted = acceptedSourceForCallToolFixture(sessionId);
  return withHarnessRunContext(
    { sessionId, ...accepted, counter },
    () => withToolOutputContext(
      { sessionId, sourceUserSeq: accepted.sourceUserSeq, callId, toolName: 'call_tool' },
      () => callTool.invoke!(
        { context: { sessionId, sourceUserSeq: accepted.sourceUserSeq, turn: accepted.turn } },
        input,
        { toolCall: { callId } },
      ) as Promise<unknown>,
    ),
  ) as Promise<unknown>;
}

test.after(() => {
  _setInnerDispatchToolsForTests(null);
  _setInnerDispatchMcpResolverForTests(null);
  _resetHotSetForTest();
  closeEventLog();
  closeOperationalTelemetryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (PRIOR_CLEMENTINE_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_CLEMENTINE_HOME;
});

function invokeCallTool(sessionId: string, name: string, argsJson: string): Promise<unknown> {
  const callTool = buildCallTool() as unknown as ToolLike;
  const callId = `call-${Math.random()}`;
  return invokeCallToolFixture(
    callTool,
    sessionId,
    JSON.stringify({ name, args_json: argsJson }),
    callId,
  );
}

test('refuses a target that is not on the orchestrator surface (no escalation)', async () => {
  // cron_list is a cli-only tool (never on the chat surface); nonexistent is unknown.
  for (const target of ['cron_list', 'nonexistent_tool_xyz']) {
    const out = JSON.parse(String(await invokeCallTool('sess-auth', target, '{}')));
    assert.equal(out.error, 'not_reachable', `${target} should be refused`);
    // The correction must be TRUE as well as exact. Live 2026-09-05: a
    // registry-declared built-in this turn could not reach was answered with
    // "it is a FIRST-CLASS tool on this turn ... call it directly"; the model
    // could not (it is not on the surface), retried the carrier three times,
    // and the turn died at the no-progress floor.
    assert.ok(!/FIRST-CLASS tool on this turn/.test(String(out.detail ?? '')),
      `${target} is not on this turn's surface, so the refusal must not claim it is`);
    assert.match(String(out.detail ?? ''), /tool_search/,
      `${target}'s refusal must name a door the model can actually take`);
  }
  // sanity: the guard is not refusing everything — an orchestrator tool is reachable.
  assert.ok(deriveOrchestratorDiscoveryNames().has('composio_execute_tool'));
});

test('an unreachable built-in is told it is off the surface, never to call it directly', async () => {
  // Live 2026-09-05, cold background turn: the model wrapped a built-in this
  // turn's policy does not reach in this carrier and was told "it is a
  // FIRST-CLASS tool on this turn ... call it DIRECTLY". It is not on the
  // surface, so a direct call was impossible; the model retried the carrier
  // three times and the turn died at the no-progress floor. A refusal must
  // name a door that exists.
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(['memory_recall']),
    firstClassNames: new Set(['tool_search']),
  }) as unknown as ToolLike;
  const out = await withToolOutputContext({ sessionId: 'sess-offsurface-builtin' }, () =>
    callTool.invoke!(
      { context: { sessionId: 'sess-offsurface-builtin' } },
      JSON.stringify({ name: 'background_task_status', args_json: '{"task_id":"bg-x"}' }),
      { toolCall: { callId: 'offsurface-builtin' } },
    ) as Promise<unknown>,
  );
  const refusal = JSON.parse(String(out));
  assert.equal(refusal.error, 'not_reachable');
  const detail = String(refusal.detail ?? '');
  assert.ok(!/FIRST-CLASS tool on this turn/.test(detail),
    'a tool the guard just proved unreachable must not be described as first-class');
  assert.ok(!/Call background_task_status DIRECTLY/.test(detail),
    'the refusal must not send the model at a door that is closed this turn');
  assert.match(detail, /tool_search/, 'the refusal names the door that exists');
});

test('turn-scoped reachability refuses a built-in that was not advertised as deferred', async () => {
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(['memory_recall']),
  }) as unknown as ToolLike;
  const out = await withToolOutputContext({ sessionId: 'sess-scoped-auth' }, () =>
    callTool.invoke!(
      { context: { sessionId: 'sess-scoped-auth' } },
      JSON.stringify({ name: 'composio_execute_tool', args_json: '{}' }),
      { toolCall: { callId: 'scoped-call' } },
    ) as Promise<unknown>,
  );
  assert.equal(JSON.parse(String(out)).error, 'not_reachable');
});

test('explicit turn denials cannot be bypassed with an external MCP name', async () => {
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(),
    deniedNames: new Set(['fakeserver__fake_tool']),
  }) as unknown as ToolLike;
  const out = await withToolOutputContext({ sessionId: 'sess-denied-mcp' }, () =>
    callTool.invoke!(
      { context: { sessionId: 'sess-denied-mcp' } },
      JSON.stringify({ name: 'fakeserver__fake_tool', args_json: '{}' }),
      { toolCall: { callId: 'denied-mcp-call' } },
    ) as Promise<unknown>,
  );
  assert.equal(JSON.parse(String(out)).error, 'not_reachable');
});

test('an explicit local-only MCP scope rejects a guessed name before provider resolution/list/dispatch', async () => {
  let resolverCalls = 0;
  let listCalls = 0;
  let dispatchCalls = 0;
  _setInnerDispatchMcpResolverForTests(() => {
    resolverCalls += 1;
    return {
      listTools: async () => {
        listCalls += 1;
        return [{ name: 'proof__read' }];
      },
      callTool: async () => {
        dispatchCalls += 1;
        return 'should-not-run';
      },
    };
  });
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(),
      mcpToolScope: {
        reason: 'explicit local-only regression',
        authority: 'none',
        allowedServerSlugs: [],
        maxTools: 0,
      },
    }) as unknown as ToolLike;
    const out = await callTool.invoke!(
      { context: { sessionId: 'sess-local-only-call-tool' } },
      JSON.stringify({ name: 'proof__read', args_json: '{}' }),
      { toolCall: { callId: 'local-only-guessed-mcp' } },
    );
    const refusal = JSON.parse(String(out));
    assert.equal(refusal.error, 'not_reachable');
    assert.equal(refusal.reason, 'mcp_scope_denied');
    assert.equal(resolverCalls, 0, 'authority must run before provider resolution/spawn');
    assert.equal(listCalls, 0, 'authority must run before listTools');
    assert.equal(dispatchCalls, 0, 'authority must run before callTool');
  } finally {
    _setInnerDispatchMcpResolverForTests(null);
  }
});

test('bad args return the schema with error=arg_validation and NO dispatch', async () => {
  _resetHotSetForTest();
  _resetCallToolSchemaCacheForTest();
  // Find a lane-orchestrator tool whose schema rejects {} (has a required field).
  const schemas = getLocalToolSchemas();
  const allowed = deriveOrchestratorDiscoveryNames();
  const target = [...allowed].find((n) => {
    const s = schemas.get(n);
    return s ? !s.safeParse({}).success : false;
  });
  assert.ok(target, 'expected at least one orchestrator tool with a required arg');

  const out = JSON.parse(String(await invokeCallTool('sess-argval', target!, '{}')));
  assert.equal(out.error, 'arg_validation');
  assert.ok(out.schema && typeof out.schema === 'object', 'returns the target JSON schema');
  assert.ok(typeof out.detail === 'string' && out.detail.length > 0, 'returns a detail message');
  // No dispatch happened → the tool was never promoted to the hot-set.
  assert.ok(!getHotSet('sess-argval').includes(target!), 'a validation miss must not dispatch');
});

test('unknown deferred arguments are rejected instead of silently stripped before dispatch', async () => {
  _resetHotSetForTest();
  _resetCallToolSchemaCacheForTest();
  const out = JSON.parse(String(await invokeCallTool(
    'sess-stale-workspace-schema',
    'space_save',
    JSON.stringify({
      slug: 'stale-workspace-shape',
      title: 'Stale Workspace Shape',
      view_path: '/tmp/never-dispatched.html',
      description: 'obsolete field',
      dataSources: [{ id: 'tasks', type: 'runner' }],
    }),
  )));
  assert.equal(out.error, 'arg_validation');
  assert.match(out.detail, /Unrecognized keys?:.*description.*dataSources|Unrecognized keys?:.*dataSources.*description/i);
  assert.ok(out.schema && typeof out.schema === 'object');
  assert.match(out.guidance, /clem\.data\(\)/, 'the correction includes the selected tool contract, not only its arguments');
  assert.match(
    out.guidance,
    /new arbitrary runner scripts are refused/i,
    'the direct stale-schema correction refuses unsafe new data-source runners',
  );
  assert.match(
    out.guidance,
    /Executable ACTION runners remain per-invocation approval-gated under the same pinned-entrypoint boundary/i,
    'the direct stale-schema correction carries the exact current action-runner contract',
  );
  assert.ok(!getHotSet('sess-stale-workspace-schema').includes('space_save'), 'unknown fields must prevent dispatch and promotion');
});

test('invalid JSON in args_json returns arg_validation with no dispatch', async () => {
  const out = JSON.parse(String(await invokeCallTool('sess-json', 'composio_execute_tool', '{not json')));
  assert.equal(out.error, 'arg_validation');
});

test('a wrapped write-shaped carrier rejection settles typed no-dispatch instead of an orphan', async () => {
  const previous = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  resetEventLog();
  const session = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(session.id);
  let providerDispatches = 0;
  _setInnerDispatchToolsForTests(new Map([['composio_execute_tool', {
    name: 'composio_execute_tool',
    invoke: async () => {
      providerDispatches += 1;
      return 'provider must remain untouched';
    },
  }]]));
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['composio_execute_tool']) }) as never,
  ) as unknown as ToolLike;

  try {
    const rawOutput = await withHarnessRunContext(
      { sessionId: session.id, ...accepted, counter: new ToolCallsCounter(10) },
      () => wrapped.invoke!(
        { context: { sessionId: session.id } },
        JSON.stringify({
          name: 'composio_execute_tool',
          // Exact live failure shape: these are provider-action fields, not
          // composio_execute_tool's carrier fields (tool_slug/arguments).
          args_json: JSON.stringify({
            slug: 'GOOGLESHEETS_BATCH_GET',
            args: { spreadsheet_id: 'sheet-fixture', ranges: ['Log!A1:I10'] },
          }),
        }),
        { toolCall: { callId: 'call-workspace-cadence-invalid-carrier' } },
      ) as Promise<unknown>,
    );
    assert.equal(typeof rawOutput, 'string', 'the local proof is unwrapped before crossing the tool ABI');
    const output = String(rawOutput);

    assert.match(output, /arg_validation/);
    assert.match(output, /slug.*not a field.*tool_slug/);
    assert.match(output, /repair/);
    assert.equal(providerDispatches, 0, 'validation stops before the provider boundary');
    assert.equal(listEvents(session.id, { types: ['external_write'] }).length, 0, 'the carrier creates no outer reservation');
    assert.equal(listEvents(session.id, { types: ['external_write_failed'] }).length, 0, 'no write attempt existed to fail');
    assert.equal(listEvents(session.id, { types: ['external_write_orphaned'] }).length, 0);
    const redeemed = settlements.redeemDurableLogicalCallSettlementForHost({
      sessionId: session.id,
      sourceUserSeq: accepted.sourceUserSeq,
      acceptedTaskId: acceptedTaskIdFor(session.id, accepted.sourceUserSeq),
      logicalToolCallId: 'call-workspace-cadence-invalid-carrier',
    });
    assert.equal(redeemed.status, 'ok');
    assert.equal(redeemed.settlement.toolName, 'call_tool');
    assert.equal(redeemed.settlement.executionKind, 'refused_pre_dispatch');
    assert.equal(redeemed.settlement.outcome.kind, 'invalid_arguments');
    assert.equal(redeemed.settlement.outcome.evidence, 'nominal');
    assert.equal(redeemed.settlement.outcome.directive.action, 'repair_arguments');
    assert.equal(redeemed.settlement.physicalCrossingCount, 0);
    assert.equal(redeemed.settlement.hostCrossingCount, 0);
    assert.equal(redeemed.settlement.resultHandleId, undefined);
    assert.equal(redeemed.settlement.recovery.creditedProgress, false);
  } finally {
    _setInnerDispatchToolsForTests(null);
    if (previous === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = previous;
  }
});

test('an exhausted write-shaped carrier hard-stops without manufacturing no-dispatch evidence', async () => {
  const previous = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  resetEventLog();
  const session = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(session.id);
  const counter = new ToolCallsCounter(1);
  counter.increment();
  let providerDispatches = 0;
  _setInnerDispatchToolsForTests(new Map([['composio_execute_tool', {
    name: 'composio_execute_tool',
    invoke: async () => {
      providerDispatches += 1;
      return 'provider must remain untouched';
    },
  }]]));
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['composio_execute_tool']) }) as never,
  ) as unknown as ToolLike;

  try {
    await assert.rejects(
      () => withHarnessRunContext(
        { sessionId: session.id, ...accepted, counter },
        () => wrapped.invoke!(
          { context: { sessionId: session.id } },
          JSON.stringify({
            name: 'composio_execute_tool',
            args_json: JSON.stringify({
              slug: 'GOOGLESHEETS_BATCH_GET',
              args: { spreadsheet_id: 'sheet-fixture', ranges: ['Log!A1:I10'] },
            }),
          }),
          { toolCall: { callId: 'call-workspace-cadence-counter-exhausted' } },
        ) as Promise<unknown>,
      ),
      ToolCallsLimitExceeded,
    );
    assert.equal(counter.calls, 1, 'a refused over-limit call cannot spend past the ceiling');
    assert.equal(providerDispatches, 0, 'the provider boundary is never reached');
    assert.equal(
      listEvents(session.id, { types: ['external_write_failed'] }).length,
      0,
      'a turn-level safety ceiling is not misreported as an ordinary carrier refusal',
    );
    assert.equal(listEvents(session.id, { types: ['external_write'] }).length, 0);
    assert.equal(listEvents(session.id, { types: ['external_write_orphaned'] }).length, 0);
  } finally {
    _setInnerDispatchToolsForTests(null);
    if (previous === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = previous;
  }
});

test('an ambiguous reached write produces one inner orphan and no outer carrier duplicate', async () => {
  const previous = {
    brackets: process.env.HARNESS_TOOL_BRACKETS,
    confirm: process.env.CLEMMY_CONFIRM_FIRST,
    execution: process.env.CLEMMY_EXECUTION_GATE,
  };
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  resetEventLog();
  const session = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(session.id);
  let providerDispatches = 0;
  _setInnerDispatchToolsForTests(new Map([['composio_execute_tool', {
    name: 'composio_execute_tool',
    invoke: async () => {
      providerDispatches += 1;
      return JSON.stringify({ error: 'provider response lost after dispatch' });
    },
  }]]));
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['composio_execute_tool']) }) as never,
  ) as unknown as ToolLike;
  const outerCallId = 'call-workspace-cadence-ambiguous-provider';

  try {
    const output = String(await withHarnessRunContext(
      { sessionId: session.id, ...accepted, counter: new ToolCallsCounter(10) },
      () => wrapped.invoke!(
        { context: { sessionId: session.id } },
        JSON.stringify({
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: 'GOOGLESHEETS_VALUES_UPDATE',
            arguments: JSON.stringify({
              spreadsheet_id: 'sheet-fixture',
              range: 'Summary!A1',
              values: [['August']],
            }),
          }),
        }),
        { toolCall: { callId: outerCallId } },
      ) as Promise<unknown>,
    ));

    assert.match(output, /provider response lost after dispatch/);
    assert.equal(providerDispatches, 1, 'the negative control must cross the provider boundary');
    const attempts = listEvents(session.id, { types: ['external_write'] });
    const orphans = listEvents(session.id, { types: ['external_write_orphaned'] });
    assert.equal(attempts.length, 1, 'only the validated inner write owns a reservation');
    assert.equal(orphans.length, 1, 'provider ambiguity remains fail-closed');
    assert.equal(attempts[0]?.data.toolName, 'composio_execute_tool');
    assert.equal(orphans[0]?.data.toolName, 'composio_execute_tool');
    assert.equal(orphans[0]?.data.callId, attempts[0]?.data.callId, 'the inner attempt settles by exact id');
    assert.equal(
      orphans[0]?.data.callId,
      outerCallId,
      'the transport mirror and resolved inner attempt share one logical lifecycle',
    );
    assert.equal(listEvents(session.id, { types: ['external_write_failed'] }).length, 0);
  } finally {
    _setInnerDispatchToolsForTests(null);
    if (previous.brackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = previous.brackets;
    if (previous.confirm === undefined) delete process.env.CLEMMY_CONFIRM_FIRST;
    else process.env.CLEMMY_CONFIRM_FIRST = previous.confirm;
    if (previous.execution === undefined) delete process.env.CLEMMY_EXECUTION_GATE;
    else process.env.CLEMMY_EXECUTION_GATE = previous.execution;
  }
});

test('deferred validation accepts omitted optional keys as well as strict-mode nulls', () => {
  _resetCallToolSchemaCacheForTest();
  const schemas = getLocalToolSchemas();
  const facts = schemas.get('memory_list_facts');
  const working = schemas.get('working_memory');
  const recall = schemas.get('memory_recall_all');
  const getRunner = schemas.get('space_get_runner');
  const refreshSpace = schemas.get('space_refresh');
  const spaceHistory = schemas.get('space_history');
  const spaceDiff = schemas.get('space_diff');
  assert.ok(facts && working && recall && getRunner && refreshSpace && spaceHistory && spaceDiff);
  assert.equal(facts!.safeParse({ query: 'Northstar live-proof team', limit: 50 }).success, true);
  assert.equal(facts!.safeParse({ kind: null, query: 'Northstar live-proof team', limit: 50, includeInactive: false }).success, true);
  assert.equal(working!.safeParse({ action: 'read' }).success, true);
  assert.equal(working!.safeParse({ action: 'read', content: null }).success, true);
  assert.equal(recall!.safeParse({}).success, false, 'genuinely required keys remain required');
  assert.equal(getRunner!.safeParse({ slug: 'proof-cockpit', runner_path: 'tasks.mjs' }).success, true);
  assert.equal(refreshSpace!.safeParse({ slug: 'proof-cockpit' }).success, true);
  assert.equal(spaceHistory!.safeParse({ slug: 'proof-cockpit' }).success, true);
  assert.equal(spaceDiff!.safeParse({ slug: 'proof-cockpit', source_id: 'tasks' }).success, true);
});

test('deferred workflow schemas accept lean nested steps and materialize strict nulls only at dispatch', async () => {
  _resetCallToolSchemaCacheForTest();
  const update = getLocalToolSchemas().get('workflow_update');
  assert.ok(update);
  const lean = {
    name: 'lean-workflow',
    steps: [{
      id: 'define',
      call: {
        tool: 'PROOF_READ',
      },
    }],
  };
  assert.equal(
    update!.safeParse(lean).success,
    true,
    'args_json should not need dozens of nested null placeholders',
  );

  const { getCoreTools } = await import('./registry.js');
  const strict = getCoreTools().find((tool) => tool.name === 'workflow_update')?.parameters;
  assert.ok(strict);
  const materialized = materializeStrictNullableFields(lean, strict) as {
    steps: Array<Record<string, unknown>>;
  };
  assert.equal(materialized.steps[0].id, 'define');
  assert.equal(materialized.steps[0].prompt, null);
  assert.equal(materialized.steps[0].transform, null);
  assert.deepEqual(materialized.steps[0].call, {
    tool: 'PROOF_READ',
    args: null,
  });
});

test('deferred workflow call arguments preserve provider-native JSON value types', () => {
  _resetCallToolSchemaCacheForTest();
  const create = getLocalToolSchemas().get('workflow_create');
  assert.ok(create);
  const liveShaped = {
    name: 'Read Canary',
    description: 'One exact structured read.',
    steps: [{
      id: 'read_latest',
      call: {
        tool: 'PROVIDER_QUERY_RECORDS',
        args: {
          user_id: 'operator@example.com',
          folder: 'inbox',
          top: 1,
          select: ['subject', 'receivedDateTime'],
          orderby: 'receivedDateTime desc',
        },
      },
      sideEffect: 'read',
      output: {
        type: 'object',
        required_keys: ['successful', 'data'],
        non_empty: ['data', 'data.value'],
        min_items: { 'data.value': 1 },
        description: 'One source-backed record.',
      },
    }],
    allowSends: false,
  };

  const parsed = create!.safeParse(liveShaped);
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
});

test('resolved local workflow authority keeps the canonical deferred schema', async () => {
  _resetCallToolSchemaCacheForTest();
  let targetInputSchema: unknown;
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(['workflow_create']),
    aroundResolvedDispatch: async (input) => {
      targetInputSchema = input.targetInputSchema;
      return { successful: true };
    },
  }) as unknown as ToolLike;
  const args = {
    name: 'Deferred Schema Proof',
    description: 'Preserve mixed structured-call arguments at every boundary.',
    steps: [{
      id: 'read_latest',
      call: {
        tool: 'PROVIDER_QUERY_RECORDS',
        args: { top: 1, select: ['subject', 'receivedDateTime'] },
      },
      sideEffect: 'read',
    }],
  };

  const output = await invokeCallToolFixture(
    callTool,
    'sess-local-deferred-authority',
    JSON.stringify({ name: 'workflow_create', args_json: JSON.stringify(args) }),
    'call-local-deferred-authority',
  );
  assert.deepEqual(JSON.parse(String(output)), { successful: true });
  const root = targetInputSchema as any;
  const callArgs = root.properties.steps.items.properties.call.anyOf[0].properties.args.anyOf[0];
  assert.equal(typeof callArgs.additionalProperties, 'object');
  assert.notEqual(callArgs.additionalProperties, false,
    'the resolved work contract must match the deferred parser, not the lossy first-class projection');
});

test('an exact host durable continuation escapes the nested call_tool SDK wrapper unchanged', async () => {
  const {
    HostDurableContinuationPendingError,
    isHostDurableContinuationPendingError,
  } = await import('../runtime/harness/host-durable-continuation.js');
  const pending = new HostDurableContinuationPendingError(
    'async_read_refinement',
    'logical-refinement-owner',
    'terminal getter has not settled',
  );
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(['workflow_create']),
    propagateInvocationError: isHostDurableContinuationPendingError,
    aroundResolvedDispatch: async () => {
      throw pending;
    },
  }) as unknown as ToolLike;
  const args = {
    name: 'Durable continuation escape proof',
    description: 'The private host scheduler signal must not become model-visible text.',
    steps: [{
      id: 'read_latest',
      call: { tool: 'PROVIDER_QUERY_RECORDS', args: { top: 1 } },
      sideEffect: 'read',
    }],
  };

  await assert.rejects(
    invokeCallToolFixture(
      callTool,
      'sess-durable-continuation-escape',
      JSON.stringify({ name: 'workflow_create', args_json: JSON.stringify(args) }),
      'call-durable-continuation-escape',
    ),
    (error: unknown) => error === pending,
  );
});

test('materialization survives a nullish (double-anyOf) wrapper around a nested array', async () => {
  _resetCallToolSchemaCacheForTest();
  // Live failure (proof workspace-build, 2026-07-27): space_save's
  // data_sources is nullish → JSON schema anyOf[anyOf[array,null],null].
  // The branch resolver did not recurse through the nested wrapper, so the
  // items schema was lost and nested required-nullable keys (composio_slug,
  // schedule, timezone, …) stayed omitted — the strict inner parser then
  // rejected the call three times and the model degraded to a static page.
  const { getCoreTools } = await import('./registry.js');
  const strict = getCoreTools().find((tool) => tool.name === 'space_save')?.parameters;
  assert.ok(strict);
  const materialized = materializeStrictNullableFields(
    { slug: 'proof-cockpit', title: 'Proof Cockpit', data_sources: [{ id: 'local_tasks', runner: 'tasks.mjs' }] },
    strict,
  ) as { data_sources: Array<Record<string, unknown>> };
  assert.equal(materialized.data_sources[0].id, 'local_tasks');
  assert.equal(materialized.data_sources[0].runner, 'tasks.mjs');
  assert.equal(materialized.data_sources[0].composio_slug, null);
  assert.equal(materialized.data_sources[0].schedule, null);
  assert.equal(materialized.data_sources[0].timezone, null);
});

test('call_tool materializes omitted optional keys before invoking the real strict inner tool', async () => {
  _resetCallToolSchemaCacheForTest();
  const out = String(await invokeCallTool(
    'sess-optional-inner-dispatch',
    'memory_list_facts',
    JSON.stringify({ query: 'Northstar live-proof team', limit: 10 }),
  ));
  assert.doesNotMatch(out, /InvalidToolInputError|arg_validation/);
  assert.ok(Array.isArray(JSON.parse(out)), 'the real inner memory tool completed with valid JSON');
});

test('call_tool freezes strict host materialization as the one effective logical contract', async () => {
  resetEventLog();
  _resetCallToolSchemaCacheForTest();
  const session = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'List the matching memory facts.' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  let received: unknown;
  _setInnerDispatchToolsForTests(new Map([[
    'memory_list_facts',
    { name: 'memory_list_facts', invoke: async (_context: unknown, input: unknown) => {
      received = typeof input === 'string' ? JSON.parse(input) : input;
      return '[]';
    } },
  ]]));
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['memory_list_facts']) }) as never,
  ) as unknown as ToolLike;
  try {
    const output = await withHarnessRunContext(
      {
        sessionId: session.id,
        sourceUserSeq: source.seq,
        turn: 1,
        counter: new ToolCallsCounter(10),
      },
      () => wrapped.invoke!(
        { context: { sessionId: session.id } },
        JSON.stringify({
          name: 'memory_list_facts',
          args_json: JSON.stringify({ query: 'Northstar team', limit: 10 }),
        }),
        { toolCall: { callId: 'call-tool-strict-refinement' } },
      ),
    );
    assert.equal(String(output), '[]');
    assert.ok(received && typeof received === 'object');
    const logical = openEventLog().prepare(`
      SELECT argument_digest, raw_argument_digest, effective_argument_digest
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as {
      argument_digest: string;
      raw_argument_digest: string;
      effective_argument_digest: string;
    };
    assert.notEqual(logical.raw_argument_digest, logical.effective_argument_digest);
    assert.equal(logical.argument_digest, logical.effective_argument_digest);
    assert.equal(
      listEvents(session.id, { types: ['logical_call_contract_refined'] }).length,
      1,
    );
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
});

test('call_tool materializes omitted nullable computer-tool defaults before strict dispatch', async () => {
  _resetCallToolSchemaCacheForTest();
  const out = String(await invokeCallTool(
    'sess-computer-null-defaults',
    'run_shell_command',
    JSON.stringify({ command: 'echo CALL_TOOL_NULL_DEFAULTS_OK' }),
  ));
  assert.doesNotMatch(out, /InvalidToolInputError|arg_validation/);
  assert.match(out, /CALL_TOOL_NULL_DEFAULTS_OK/);
});

test('gate parity: a mutating inner tool routed through call_tool trips the write boundary (keyed on inner name)', async () => {
  const prev = {
    brackets: process.env.HARNESS_TOOL_BRACKETS,
    confirm: process.env.CLEMMY_CONFIRM_FIRST,
    execGate: process.env.CLEMMY_EXECUTION_GATE,
  };
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'on';
  process.env.CLEMMY_EXECUTION_GATE = 'off'; // isolate the confirm-first batch gate
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  // Inject a fake inner composio_execute_tool. dispatchBatchItemTool wraps THIS via
  // wrapToolForHarness, so the write boundary keys on 'composio_execute_tool' (inner).
  _setInnerDispatchToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'sent' }]]),
  );
  const restoreCatalog = installFixtureOperationContracts([
    { operationId: 'GMAIL_SEND_EMAIL', effect: 'external_write', reversibility: 'irreversible' },
    { operationId: 'GOOGLESHEETS_VALUES_UPDATE', effect: 'external_write', reversibility: 'reversible' },
  ]);
  try {
    // NEW CONTRACT (2026-07-09 Lane 2): an IRREVERSIBLE SEND via call_tool is
    // REFUSED — call_tool bypasses the approval card, so sends must go through
    // run_batch or a first-class call. The refusal names the fix.
    const sendOut = String(await invokeCallTool(
      sess.id, 'composio_execute_tool',
      JSON.stringify({ tool_slug: 'GMAIL_SEND_EMAIL', arguments: JSON.stringify({ to: 'p@site.example' }) }),
    ));
    assert.match(
      sendOut,
      /PENDING_ACTION_APPROVAL_REQUIRED|pending_action_queue/i,
      'a send via call_tool is refused with the one typed pending-action recovery',
    );
    assert.equal(listEvents(sess.id, { types: ['external_write'] }).length, 0, 'no send dispatched');

    // A REVERSIBLE WRITE still routes through the gated boundary keyed on the
    // inner tool name (gate parity preserved for non-sends).
    _setInnerDispatchToolsForTests(
      new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'updated' }]]),
    );
    const writeOut = String(await invokeCallTool(
      sess.id, 'composio_execute_tool',
      JSON.stringify({ tool_slug: 'GOOGLESHEETS_VALUES_UPDATE', arguments: JSON.stringify({ range: 'A1' }) }),
    ));
    assert.ok(writeOut.startsWith('updated'), 'a reversible write routes through the gated inner tool');
  } finally {
    restoreCatalog();
    _setInnerDispatchToolsForTests(null);
    process.env.HARNESS_TOOL_BRACKETS = prev.brackets;
    process.env.CLEMMY_CONFIRM_FIRST = prev.confirm;
    process.env.CLEMMY_EXECUTION_GATE = prev.execGate;
  }
});

test('a wrapped nested irreversible send gives one pending-action recovery, never execution-wrap then send-floor advice', async () => {
  const prev = {
    brackets: process.env.HARNESS_TOOL_BRACKETS,
    execution: process.env.CLEMMY_EXECUTION_GATE,
  };
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_EXECUTION_GATE = 'on';
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(sess.id);
  let dispatched = 0;
  _setInnerDispatchToolsForTests(
    new Map([['composio_execute_tool', {
      name: 'composio_execute_tool',
      invoke: async () => {
        dispatched += 1;
        return 'must not send';
      },
    }]]),
  );
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['composio_execute_tool']) }) as never,
  ) as unknown as ToolLike;
  const counter = new ToolCallsCounter(10);
  const restoreCatalog = installFixtureOperationContracts([
    { operationId: 'GMAIL_SEND_EMAIL', effect: 'external_write', reversibility: 'irreversible' },
  ]);
  try {
    const output = String(await withHarnessRunContext(
      { sessionId: sess.id, ...accepted, counter },
      () => wrapped.invoke!(
        { context: { sessionId: sess.id } },
        JSON.stringify({
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: 'GMAIL_SEND_EMAIL',
            arguments: JSON.stringify({
              to: 'approval-route@example.com',
              subject: 'Approval route',
              body: 'Exact body',
            }),
          }),
        }),
        { toolCall: { callId: 'nested-send-one-recovery' } },
      ) as Promise<unknown>,
    ));
    assert.match(output, /PENDING_ACTION_APPROVAL_REQUIRED/);
    assert.match(output, /pending_action_queue/);
    assert.match(output, /approvalIntent[^a-z]+request_now/i);
    assert.doesNotMatch(output, /EXECUTION_WRAP_REQUIRED/);
    assert.doesNotMatch(output, /SEND_REQUIRES_APPROVAL/);
    assert.equal(dispatched, 0, 'the provider is untouched while the exact call waits for approval');
    assert.equal(counter.calls, 1, 'the pre-dispatch send floor still charges the refused attempt');
    assert.deepEqual(openEventLog().prepare(`
      SELECT l.tool_name, s.outcome_kind, s.execution_kind
        FROM logical_tool_calls l
        JOIN logical_call_settlements s USING (session_id, source_user_seq, logical_tool_call_id)
       WHERE l.session_id = ? AND l.source_user_seq = ? AND l.logical_tool_call_id = ?
    `).get(sess.id, accepted.sourceUserSeq, 'nested-send-one-recovery'), {
      tool_name: 'gmail_send_email',
      outcome_kind: 'policy_denial',
      execution_kind: 'refused_pre_dispatch',
    });
    assert.equal((openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(sess.id, accepted.sourceUserSeq, 'nested-send-one-recovery') as { n: number }).n, 0);
  } finally {
    restoreCatalog();
    _setInnerDispatchToolsForTests(null);
    if (prev.brackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = prev.brackets;
    if (prev.execution === undefined) delete process.env.CLEMMY_EXECUTION_GATE;
    else process.env.CLEMMY_EXECUTION_GATE = prev.execution;
  }
});

test('carrier target policy allows account-scoped social posts but blocks targetless directed sends', async () => {
  const prev = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const session = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(session.id);
  const counter = new ToolCallsCounter(10);
  let dispatched = 0;
  _setInnerDispatchToolsForTests(
    new Map([['composio_execute_tool', {
      name: 'composio_execute_tool',
      invoke: async () => {
        dispatched += 1;
        return 'must not publish or send before approval';
      },
    }]]),
  );
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['composio_execute_tool']) }) as never,
  ) as unknown as ToolLike;
  const restoreCatalog = installFixtureOperationContracts([
    { operationId: 'INSTAGRAM_CREATE_POST', effect: 'external_write', reversibility: 'irreversible' },
    { operationId: 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH', effect: 'external_write', reversibility: 'irreversible' },
    { operationId: 'INSTAGRAM_SEND_DM', effect: 'external_write', reversibility: 'irreversible' },
    { operationId: 'SLACK_CHAT_POST_MESSAGE', effect: 'external_write', reversibility: 'irreversible' },
    { operationId: 'GMAIL_SEND_EMAIL', effect: 'external_write', reversibility: 'irreversible' },
  ]);
  const invoke = (toolSlug: string, args: Record<string, unknown>, callId: string) =>
    withHarnessRunContext(
      { sessionId: session.id, ...accepted, counter },
      () => wrapped.invoke!(
        { context: { sessionId: session.id } },
        JSON.stringify({
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: toolSlug,
            arguments: JSON.stringify(args),
          }),
        }),
        { toolCall: { callId } },
      ) as Promise<unknown>,
    );
  try {
    const broadcast = String(await invoke(
      'INSTAGRAM_CREATE_POST',
      { caption: 'Launch day', image_url: 'https://assets.example.test/launch.png' },
      'account-scoped-instagram-post',
    ));
    assert.match(broadcast, /PENDING_ACTION_APPROVAL_REQUIRED|pending_action_queue/);
    assert.doesNotMatch(broadcast, /target_missing|resolvable recipient/i);

    const mediaPublish = String(await invoke(
      'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH',
      { creation_id: 'ig-container-123' },
      'account-scoped-instagram-media-publish',
    ));
    assert.match(mediaPublish, /PENDING_ACTION_APPROVAL_REQUIRED|pending_action_queue/);
    assert.doesNotMatch(mediaPublish, /arguments_missing|target_missing/i);

    const emptyBroadcast = JSON.parse(String(await invoke(
      'INSTAGRAM_CREATE_POST',
      {},
      'empty-account-scoped-instagram-post',
    ))) as { error?: string; reason?: string; detail?: string };
    assert.equal(emptyBroadcast.error, 'arg_validation');
    assert.equal(emptyBroadcast.reason, 'arguments_missing');
    assert.match(emptyBroadcast.detail ?? '', /non-empty/i);

    const blankBroadcast = JSON.parse(String(await invoke(
      'INSTAGRAM_CREATE_POST',
      { caption: '   ', image_url: '' },
      'blank-account-scoped-instagram-post',
    ))) as { error?: string; reason?: string; detail?: string };
    assert.equal(blankBroadcast.error, 'arg_validation');
    assert.equal(blankBroadcast.reason, 'arguments_missing');

    for (const candidate of [
      { slug: 'INSTAGRAM_SEND_DM', args: { message: 'Hello' } },
      { slug: 'SLACK_CHAT_POST_MESSAGE', args: { text: 'Hello channel' } },
      { slug: 'GMAIL_SEND_EMAIL', args: { subject: 'Hello', body: 'No recipient' } },
    ]) {
      const targetless = JSON.parse(String(await invoke(
        candidate.slug,
        candidate.args,
        `targetless-directed-${candidate.slug.toLowerCase()}`,
      ))) as { error?: string; reason?: string; detail?: string };
      assert.equal(targetless.error, 'arg_validation', candidate.slug);
      assert.equal(targetless.reason, 'target_missing', candidate.slug);
      assert.match(targetless.detail ?? '', /recipient|target/i, candidate.slug);
    }
    assert.equal(dispatched, 0);
    assert.equal(counter.calls, 7, 'two approval conversions plus five validation refusals charge once each');
    assert.deepEqual(openEventLog().prepare(`
      SELECT l.logical_tool_call_id, l.tool_name, s.outcome_kind, s.execution_kind
        FROM logical_tool_calls l
        JOIN logical_call_settlements s USING (session_id, source_user_seq, logical_tool_call_id)
       WHERE l.session_id = ? AND l.source_user_seq = ?
         AND l.logical_tool_call_id IN (?, ?)
       ORDER BY l.logical_tool_call_id
    `).all(
      session.id,
      accepted.sourceUserSeq,
      'account-scoped-instagram-post',
      'account-scoped-instagram-media-publish',
    ), [
      {
        logical_tool_call_id: 'account-scoped-instagram-media-publish',
        tool_name: 'instagram_post_ig_user_media_publish',
        outcome_kind: 'policy_denial',
        execution_kind: 'refused_pre_dispatch',
      },
      {
        logical_tool_call_id: 'account-scoped-instagram-post',
        tool_name: 'instagram_create_post',
        outcome_kind: 'policy_denial',
        execution_kind: 'refused_pre_dispatch',
      },
    ]);
  } finally {
    restoreCatalog();
    _setInnerDispatchToolsForTests(null);
    if (prev === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = prev;
  }
});

test('unknown, denied, and malformed nested sends validate before any pending-action conversion', async () => {
  const prev = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(sess.id);
  let dispatched = 0;
  _setInnerDispatchToolsForTests(
    new Map([['composio_execute_tool', {
      name: 'composio_execute_tool',
      invoke: async () => {
        dispatched += 1;
        return 'must not send';
      },
    }]]),
  );
  const invokeWrapped = (
    toolOptions: Parameters<typeof buildCallTool>[0],
    name: string,
    args: string,
    callId: string,
  ) => {
    const wrapped = wrapToolForHarness(buildCallTool(toolOptions) as never) as unknown as ToolLike;
    return withHarnessRunContext(
      { sessionId: sess.id, ...accepted, counter: new ToolCallsCounter(20) },
      () => wrapped.invoke!(
        { context: { sessionId: sess.id } },
        JSON.stringify({ name, args_json: args }),
        { toolCall: { callId } },
      ) as Promise<unknown>,
    );
  };
  try {
    const unknown = String(await invokeWrapped(
      { reachableBuiltinNames: new Set(['composio_execute_tool']) },
      'TOTALLY_UNKNOWN_SEND_EMAIL',
      JSON.stringify({ to: 'unknown@example.com' }),
      'unknown-nested-send',
    ));
    assert.match(unknown, /not_reachable/);
    assert.doesNotMatch(unknown, /PENDING_ACTION_APPROVAL_REQUIRED|pending_action_queue/);

    const denied = String(await invokeWrapped(
      {
        reachableBuiltinNames: new Set(['composio_execute_tool']),
        deniedNames: new Set(['composio_execute_tool']),
      },
      'composio_execute_tool',
      JSON.stringify({
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: JSON.stringify({ to: 'denied@example.com' }),
      }),
      'denied-nested-send',
    ));
    assert.match(denied, /not_reachable|excluded from this turn/i);
    assert.doesNotMatch(denied, /PENDING_ACTION_APPROVAL_REQUIRED|pending_action_queue/);

    const malformed = String(await invokeWrapped(
      { reachableBuiltinNames: new Set(['composio_execute_tool']) },
      'composio_execute_tool',
      JSON.stringify({
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: '{not-json',
      }),
      'malformed-nested-send',
    ));
    assert.match(malformed, /arg_validation/);
    assert.match(malformed, /arguments is not valid JSON/i);
    assert.doesNotMatch(malformed, /PENDING_ACTION_APPROVAL_REQUIRED|pending_action_queue/);

    const targetlessArguments: Array<{ label: string; argumentsValue?: string | null }> = [
      { label: 'omitted' },
      { label: 'null', argumentsValue: null },
      { label: 'blank', argumentsValue: '' },
      { label: 'empty-object', argumentsValue: '{}' },
      {
        label: 'content-without-target',
        argumentsValue: JSON.stringify({ subject: 'No destination', body: 'Must not be approved.' }),
      },
    ];
    for (const candidate of targetlessArguments) {
      const carrier: Record<string, unknown> = { tool_slug: 'GMAIL_SEND_EMAIL' };
      if ('argumentsValue' in candidate) carrier.arguments = candidate.argumentsValue;
      const targetless = JSON.parse(String(await invokeWrapped(
        { reachableBuiltinNames: new Set(['composio_execute_tool']) },
        'composio_execute_tool',
        JSON.stringify(carrier),
        `targetless-nested-send-${candidate.label}`,
      ))) as { error?: string; reason?: string; detail?: string };
      assert.equal(targetless.error, 'arg_validation', candidate.label);
      assert.equal(targetless.reason, 'target_missing', candidate.label);
      assert.match(targetless.detail ?? '', /recipient|target/i, candidate.label);
    }

    assert.equal(dispatched, 0);
    assert.equal(
      listEvents(sess.id, { types: ['guardrail_tripped'] })
        .filter((event) => event.data.kind === 'pending_action_approval_required').length,
      0,
      'unvalidated carrier JSON never reaches an approval-routing gate',
    );
  } finally {
    _setInnerDispatchToolsForTests(null);
    if (prev === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = prev;
  }
});

test('a successful dispatch records the reached tool to the session hot-set', async () => {
  _resetHotSetForTest();
  const restoreCatalog = installFixtureOperationContracts([
    { operationId: 'APIFY_GET_DATASET_ITEMS', effect: 'read' },
  ]);
  // Fake read inner tool (a read slug → no gate) so dispatch is deterministic.
  _setInnerDispatchToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'ok' }]]),
  );
  try {
    const out = await invokeCallTool(
      'sess-lru',
      'composio_execute_tool',
      JSON.stringify({ tool_slug: 'APIFY_GET_DATASET_ITEMS', arguments: '{}' }),
    );
    assert.equal(String(out), 'ok');
    assert.ok(getHotSet('sess-lru').includes('composio_execute_tool'), 'reached tool is promoted to the hot-set');
  } finally {
    restoreCatalog();
    _setInnerDispatchToolsForTests(null);
  }
});

test('call_tool canonicalizes object-form Composio arguments before one inner dispatch', async () => {
  const dispatched: Array<Record<string, unknown>> = [];
  _setInnerDispatchToolsForTests(
    new Map([['composio_execute_tool', {
      name: 'composio_execute_tool',
      invoke: async (_context: unknown, input: string) => {
        dispatched.push(JSON.parse(input) as Record<string, unknown>);
        return 'rows';
      },
    }]]),
  );
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(['composio_execute_tool']),
  }) as unknown as ToolLike;
  const restoreCatalog = installFixtureOperationContracts([
    { operationId: 'PROOF_LIST_TASKS', effect: 'read' },
  ]);
  const invoke = (sessionId: string, carrier: Record<string, unknown>, callId: string) =>
    invokeCallToolFixture(
      callTool,
      sessionId,
      JSON.stringify({
        name: 'composio_execute_tool',
        args_json: JSON.stringify(carrier),
      }),
      callId,
    );

  try {
    const empty = await invoke(
      'sess-object-carrier-empty',
      { tool_slug: 'PROOF_LIST_TASKS', arguments: {} },
      'object-carrier-empty',
    );
    assert.equal(String(empty), 'rows');
    assert.equal(dispatched.length, 1, 'valid representation drift must dispatch exactly once');
    assert.equal(dispatched[0].tool_slug, 'PROOF_LIST_TASKS');
    assert.equal(dispatched[0].arguments, null);

    const populated = await invoke(
      'sess-object-carrier-populated',
      {
        tool_slug: 'PROOF_LIST_TASKS',
        arguments: { z: 2, q: 'firm-a' },
        connected_account_id: 'ca_proof_primary',
      },
      'object-carrier-populated',
    );
    assert.equal(String(populated), 'rows');
    assert.equal(dispatched.length, 2, 'a second outer request still causes only one inner dispatch');
    // The wire retains the caller's field order (order is semantic for some
    // provider operations — Sheet-from-JSON column order); order-independent
    // identity is owned by the DIGEST, never by wire bytes (2026-08-20).
    assert.equal(dispatched[1].arguments, '{"z":2,"q":"firm-a"}');
    assert.equal(
      dispatched[1].connected_account_id,
      'ca_proof_primary',
      'canonicalizing the inner payload must preserve an explicit outer account selector',
    );
  } finally {
    restoreCatalog();
    _setInnerDispatchToolsForTests(null);
  }
});

test('a first-class built-in accidentally wrapped in call_tool dispatches instead of bouncing not_reachable', async () => {
  _setInnerDispatchToolsForTests(
    new Map([['memory_recall_all', { name: 'memory_recall_all', invoke: async () => 'all eight teammates' }]]),
  );
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(),
      firstClassNames: new Set(['memory_recall_all']),
    }) as unknown as ToolLike;
    const out = await invokeCallToolFixture(
      callTool,
      'sess-first-class-wrapper',
      JSON.stringify({ name: 'memory_recall_all', args_json: JSON.stringify({ objective: 'my team', limit: null }) }),
      'first-class-wrapper',
    );
    assert.equal(String(out), 'all eight teammates');
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
});

test('a common http_fetch guess repairs to the allowed bounded GET path without double-counting the inner mirror', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  let dispatched: Record<string, unknown> | null = null;
  _setInnerDispatchToolsForTests(
    new Map([['run_shell_command', {
      name: 'run_shell_command',
      invoke: async (_ctx: unknown, input: string) => {
        dispatched = JSON.parse(input) as Record<string, unknown>;
        return '{"id":1}';
      },
    }]]),
  );
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(),
      firstClassNames: new Set(['run_shell_command']),
    }) as unknown as ToolLike;
    const out = await invokeCallToolFixture(
      callTool,
      sess.id,
      JSON.stringify({
        name: 'http_fetch',
        args_json: JSON.stringify({ url: 'https://example.com/posts/1' }),
      }),
      'outer-http-fetch',
    );
    assert.deepEqual(JSON.parse(String(out)), { id: 1 });
    assert.ok(dispatched);
    const command = String(dispatched!.command ?? '');
    assert.match(command, /^curl /);
    assert.match(command, /--max-filesize 1048576/);
    assert.match(command, /--write-out/);
    assert.match(command, /CLEMENTINE_HTTP_META_V1/);
    assert.ok(
      command.includes('marker=b"\\n__CLEMENTINE_HTTP_META_V1__"'),
      'the parser must split on the real newline emitted by curl, not a literal backslash-n',
    );
    assert.match(command, /sha256/);
    assert.match(command, /http_code/);
    assert.match(command, /https:\/\/example\.com\/posts\/1/);

    const inner = listEvents(sess.id, { types: ['tool_called'] })
      .find((event) => (event.data as { tool?: string }).tool === 'run_shell_command');
    assert.ok(inner, 'the repaired real tool remains visible in raw telemetry');
    assert.equal(inner!.data.accounting, 'transport_mirror');
    assert.equal(inner!.data.canonicalCallId, 'outer-http-fetch');
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
});

test('the common mcp_tools guess repairs to the on-demand MCP inventory tool', async () => {
  let dispatched: Record<string, unknown> | null = null;
  _setInnerDispatchToolsForTests(
    new Map([['mcp_list_tools', {
      name: 'mcp_list_tools',
      invoke: async (_ctx: unknown, input: string) => {
        dispatched = JSON.parse(input) as Record<string, unknown>;
        return '{"results":[{"name":"dataforseo__keyword_suggestions"}]}';
      },
    }]]),
  );
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(['mcp_list_tools']),
    }) as unknown as ToolLike;
    const out = await invokeCallToolFixture(
      callTool,
      'sess-mcp-tools-alias',
      JSON.stringify({
        name: 'mcp_tools',
        args_json: JSON.stringify({ server_name: 'dataforseo', query: 'keyword suggestions' }),
      }),
      'mcp-tools-alias',
    );
    assert.match(String(out), /dataforseo__keyword_suggestions/);
    assert.equal(dispatched?.server_name, 'dataforseo');
    assert.equal(dispatched?.query, 'keyword suggestions');
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
});

test('the HTTP alias refuses mutation-shaped or credential-bearing inputs before dispatch', async () => {
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(),
    firstClassNames: new Set(['run_shell_command']),
  }) as unknown as ToolLike;
  for (const args of [
    { url: 'https://example.com/items', method: 'POST' },
    { url: 'https://user:secret@example.com/items' },
    { url: 'file:///etc/passwd' },
    { url: 'https://example.com/items', headers: { authorization: 'secret' } },
  ]) {
    const out = await callTool.invoke!(
      { context: { sessionId: 'sess-http-alias-refusal' } },
      JSON.stringify({ name: 'http_fetch', args_json: JSON.stringify(args) }),
      { toolCall: { callId: `http-refusal-${Math.random()}` } },
    );
    assert.equal(JSON.parse(String(out)).error, 'arg_validation');
  }
});

test('production run context attributes the inner dispatch without a tool-output ALS shim', async () => {
  _resetHotSetForTest();
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(sess.id);
  _setInnerDispatchToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'rows' }]]),
  );
  const restoreCatalog = installFixtureOperationContracts([
    { operationId: 'APIFY_GET_DATASET_ITEMS', effect: 'read' },
  ]);
  try {
    const callTool = buildCallTool() as unknown as ToolLike;
    const out = await withHarnessRunContext(
      { sessionId: sess.id, ...accepted, counter: new ToolCallsCounter(10) },
      () => callTool.invoke!(
        { context: { sessionId: sess.id } },
        JSON.stringify({
          name: 'composio_execute_tool',
          args_json: JSON.stringify({ tool_slug: 'APIFY_GET_DATASET_ITEMS', arguments: '{}' }),
        }),
        { toolCall: { callId: 'outer-call-tool' } },
      ) as Promise<unknown>,
    );

    assert.equal(String(out), 'rows');
    const innerCalls = listEvents(sess.id, { types: ['tool_called'] })
      .filter((event) => (event.data as { tool?: string }).tool === 'composio_execute_tool');
    assert.equal(innerCalls.length, 1, 'inner dispatch telemetry stays on the active session');
    assert.ok(getHotSet(sess.id).includes('composio_execute_tool'), 'promotion stays on the active session');
  } finally {
    restoreCatalog();
    _setInnerDispatchToolsForTests(null);
  }
});

test('nested call_tool dispatch reuses the ambient run counter', async () => {
  _setInnerDispatchToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'rows' }]]),
  );
  const counter = new ToolCallsCounter(1);
  const accepted = acceptedSourceForCallToolFixture('sess-shared-counter');
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(['composio_execute_tool']),
  }) as unknown as ToolLike;
  const restoreCatalog = installFixtureOperationContracts([
    { operationId: 'APIFY_GET_DATASET_ITEMS', effect: 'read' },
  ]);
  const invoke = () => callTool.invoke!(
    { context: { sessionId: 'sess-shared-counter' } },
    JSON.stringify({
      name: 'composio_execute_tool',
      args_json: JSON.stringify({ tool_slug: 'APIFY_GET_DATASET_ITEMS', arguments: '{}' }),
    }),
    { toolCall: { callId: `shared-counter-${counter.calls}` } },
  ) as Promise<unknown>;
  try {
    await withHarnessRunContext(
      { sessionId: 'sess-shared-counter', ...accepted, counter },
      async () => {
        assert.equal(String(await invoke()), 'rows');
        assert.equal(counter.calls, 1, 'the inner call consumes the ambient budget');
        await assert.rejects(invoke, ToolCallsLimitExceeded);
        await assert.rejects(invoke, ToolCallsLimitExceeded);
        assert.equal(counter.calls, 1, 'a refused nested call cannot reset or consume past the shared limit');
      },
    );
  } finally {
    restoreCatalog();
    _setInnerDispatchToolsForTests(null);
  }
});

test('a guessed external MCP name fails exact binding before any broad resolution', async () => {
  // A namespaced shape is not execution authority. Without a host-minted exact
  // manifest/account/schema/port binding, call_tool must refuse locally rather
  // than selecting a cached server or rebuilding a routing map from listTools.
  const out = String(await invokeCallTool('sess-mcp', 'fakeserver__fake_tool', '{"q":1}'));
  assert.match(out, /exact_mcp_binding_missing/);
  assert.match(out, /not_reachable/);
});

test('malformed outer call_tool envelopes consume budget and hit the loop ceiling before SDK validation', async () => {
  const session = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(session.id);
  const counter = new ToolCallsCounter(3);
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set() }) as never,
  ) as unknown as ToolLike;
  const malformedInputs = [
    '{',
    JSON.stringify({ name: 'composio_execute_tool' }),
    JSON.stringify({ args_json: '{}' }),
  ];
  await withHarnessRunContext(
    { sessionId: session.id, ...accepted, counter },
    async () => {
      for (let index = 0; index < malformedInputs.length; index += 1) {
        const output = String(await wrapped.invoke!(
          { context: { sessionId: session.id } },
          malformedInputs[index],
          { toolCall: { callId: `malformed-outer-${index}` } },
        ));
        assert.match(output, /invalid|error/i);
        assert.equal(counter.calls, index + 1, 'each SDK-rejected envelope consumes one attempt');
      }
      await assert.rejects(
        () => wrapped.invoke!(
          { context: { sessionId: session.id } },
          '{',
          { toolCall: { callId: 'malformed-outer-over-limit' } },
        ),
        ToolCallsLimitExceeded,
      );
      assert.equal(counter.calls, 3, 'the ceiling refuses without spending past its cap');
    },
  );
  assert.deepEqual(openEventLog().prepare(`
    SELECT l.logical_tool_call_id, l.tool_name, s.outcome_kind, s.execution_kind
      FROM logical_tool_calls l
      JOIN logical_call_settlements s USING (session_id, source_user_seq, logical_tool_call_id)
     WHERE l.session_id = ? AND l.source_user_seq = ?
       AND l.logical_tool_call_id IN (?, ?, ?)
     ORDER BY l.logical_tool_call_id
  `).all(
    session.id,
    accepted.sourceUserSeq,
    'malformed-outer-0',
    'malformed-outer-1',
    'malformed-outer-2',
  ), [0, 1, 2].map((index) => ({
    logical_tool_call_id: `malformed-outer-${index}`,
    tool_name: 'call_tool',
    outcome_kind: 'invalid_arguments',
    execution_kind: 'refused_pre_dispatch',
  })));
  assert.equal((openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, accepted.sourceUserSeq) as { n: number }).n, 0);
});

test('a harness-wrapped call_tool charges the ambient budget exactly ONCE per deferred action', async () => {
  // Live shape: the orchestrator wraps call_tool with wrapToolForHarness, and
  // the inner dispatch charges the SAME ambient counter. Without the wrapper
  // exemption every deferred action costs 2, halving the effective per-turn
  // budget on the schema-on-demand lane.
  _setInnerDispatchToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'rows' }]]),
  );
  const counter = new ToolCallsCounter(10);
  const accepted = acceptedSourceForCallToolFixture('sess-single-charge');
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['composio_execute_tool']) }) as never,
  ) as unknown as ToolLike;
  const restoreCatalog = installFixtureOperationContracts([
    { operationId: 'APIFY_GET_DATASET_ITEMS', effect: 'read' },
  ]);
  try {
    await withHarnessRunContext(
      { sessionId: 'sess-single-charge', ...accepted, counter },
      async () => {
        const out = await wrapped.invoke!(
          { context: { sessionId: 'sess-single-charge' } },
          JSON.stringify({
            name: 'composio_execute_tool',
            args_json: JSON.stringify({ tool_slug: 'APIFY_GET_DATASET_ITEMS', arguments: '{}' }),
          }),
          { toolCall: { callId: 'single-charge-1' } },
        );
        assert.equal(String(out), 'rows');
        assert.equal(counter.calls, 1, 'outer dispatcher wrapper must not double-charge the inner action');
      },
    );
  } finally {
    restoreCatalog();
    _setInnerDispatchToolsForTests(null);
  }
});

test('a FAILING call_tool dispatch still charges the budget — no zero-cost retry loop', async () => {
  // Round-2 regression: the wrapper exemption must not exempt the failure
  // paths (refusals return before the inner dispatch, which is what normally
  // charges). Each ordinary refusal costs exactly 1, then the hard ceiling
  // terminates every later attempt instead of returning zero-cost results.
  const counter = new ToolCallsCounter(2);
  const accepted = acceptedSourceForCallToolFixture('sess-fail-charge');
  let invocation = 0;
  const wrapped = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set() }) as never,
  ) as unknown as ToolLike;
  const invoke = () => {
    invocation += 1;
    return wrapped.invoke!(
      { context: { sessionId: 'sess-fail-charge' } },
      JSON.stringify({ name: 'not_a_real_tool', args_json: '{}' }),
      { toolCall: { callId: `fail-charge-${invocation}` } },
    ) as Promise<unknown>;
  };
  await withHarnessRunContext(
    { sessionId: 'sess-fail-charge', ...accepted, counter },
    async () => {
      assert.equal(JSON.parse(String(await invoke())).error, 'not_reachable');
      assert.equal(counter.calls, 1, 'a refused dispatch costs exactly one call');
      assert.equal(JSON.parse(String(await invoke())).error, 'not_reachable');
      assert.equal(counter.calls, 2);
      await assert.rejects(invoke, ToolCallsLimitExceeded);
      await assert.rejects(invoke, ToolCallsLimitExceeded);
      assert.equal(counter.calls, 2, 'the ceiling refuses without further spend');
    },
  );
});

test('a built-in dispatch is observed as an acquisition; refusals and MCP names are not', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const acquired: string[] = [];
  const previousExecutionGate = process.env.CLEMMY_EXECUTION_GATE;
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  _setInnerDispatchToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'updated' }]]),
  );
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(['composio_execute_tool']),
      onBuiltinAcquisition: (name: string) => acquired.push(name),
    }) as unknown as ToolLike;
    const invoke = (name: string, argsJson: string) =>
      invokeCallToolFixture(
        callTool,
        sess.id,
        JSON.stringify({ name, args_json: argsJson }),
        `acq-${name}`,
      );

    // A refused target is NEVER an acquisition — nothing dispatched.
    const refused = JSON.parse(String(await invoke('nonexistent_tool_xyz', '{}')));
    assert.equal(refused.error, 'not_reachable');
    assert.deepEqual(acquired, [], 'a refusal was recorded as an acquisition');

    // A successful built-in dispatch is observed exactly once, by inner name.
    const out = String(await invoke(
      'composio_execute_tool',
      JSON.stringify({ tool_slug: 'GOOGLESHEETS_VALUES_UPDATE', arguments: JSON.stringify({ range: 'A1' }) }),
    ));
    assert.ok(out.startsWith('updated'), out);
    assert.deepEqual(acquired, ['composio_execute_tool']);
  } finally {
    _setInnerDispatchToolsForTests(null);
    if (previousExecutionGate === undefined) delete process.env.CLEMMY_EXECUTION_GATE;
    else process.env.CLEMMY_EXECUTION_GATE = previousExecutionGate;
  }
});

test('a sealed built-in acquisition appends once, reuses its revision, and dispatches exactly once per call', async () => {
  const authority = {};
  const sealed = sealAgentCapabilityUniverse({
    sessionId: 'sess-capability-admitted',
    universeTools: [
      { name: 'call_tool', parameters: {} },
      { name: 'composio_execute_tool', parameters: {} },
    ],
    activeToolNames: ['call_tool'],
    policyHash: 'policy-capability-admitted',
    budget: { maxUncachedTokens: 100_000, maxModelCalls: 50, maxToolCalls: 200, maxElapsedMs: 600_000 },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) return;
  bindAgentCapabilityEnvelope(authority, sealed.envelope);
  bindAgentCapabilityRevision(authority, sealed.revision);

  let dispatches = 0;
  let admissions = 0;
  const restoreCatalog = installFixtureOperationContracts([
    { operationId: 'APIFY_GET_DATASET_ITEMS', effect: 'read' },
  ]);
  _setInnerDispatchToolsForTests(new Map([['composio_execute_tool', {
    name: 'composio_execute_tool',
    invoke: async () => {
      dispatches += 1;
      return 'rows';
    },
  }]]));
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(['composio_execute_tool']),
      admitBuiltinAcquisition: (targetName: string) => {
        admissions += 1;
        return appendAgentCapabilityBinding(authority, targetName);
      },
    }) as unknown as ToolLike;
    const invoke = () => invokeCallToolFixture(
      callTool,
      'sess-capability-admitted',
      JSON.stringify({
        name: 'composio_execute_tool',
        args_json: JSON.stringify({ tool_slug: 'APIFY_GET_DATASET_ITEMS', arguments: '{}' }),
      }),
      `capability-admitted-${admissions}`,
    );

    assert.equal(String(await invoke()), 'rows');
    const afterFirst = boundAgentCapabilityRevision(authority)!;
    assert.equal(afterFirst.revision, 2);
    assert.deepEqual([...afterFirst.bound], ['call_tool', 'composio_execute_tool']);
    assert.equal(String(await invoke()), 'rows');
    const afterDuplicate = boundAgentCapabilityRevision(authority)!;
    assert.equal(afterDuplicate.revision, 2, 'duplicate acquisition created revision churn');
    assert.equal(afterDuplicate.revisionDigest, afterFirst.revisionDigest);
    assert.equal(admissions, 2, 'each requested dispatch must cross admission exactly once');
    assert.equal(dispatches, 2, 'each admitted call must dispatch its inner tool exactly once');
  } finally {
    restoreCatalog();
    _setInnerDispatchToolsForTests(null);
  }
});

test('outside-universe and missing capability authority return requires_readmission with zero dispatch and one budget charge', async () => {
  const sealedAuthority = {};
  const missingAuthority = {};
  const sealed = sealAgentCapabilityUniverse({
    sessionId: 'sess-capability-refused',
    universeTools: [{ name: 'call_tool', parameters: {} }],
    activeToolNames: ['call_tool'],
    policyHash: 'policy-capability-refused',
    budget: { maxUncachedTokens: 100_000, maxModelCalls: 50, maxToolCalls: 200, maxElapsedMs: 600_000 },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) return;
  bindAgentCapabilityEnvelope(sealedAuthority, sealed.envelope);
  bindAgentCapabilityRevision(sealedAuthority, sealed.revision);
  const before = boundAgentCapabilityRevision(sealedAuthority)!;

  let dispatches = 0;
  _setInnerDispatchToolsForTests(new Map([['composio_execute_tool', {
    name: 'composio_execute_tool',
    invoke: async () => {
      dispatches += 1;
      return 'must-not-run';
    },
  }]]));
  try {
    for (const [label, authority] of [
      ['outside-universe', sealedAuthority],
      ['missing-authority', missingAuthority],
    ] as const) {
      const counter = new ToolCallsCounter(5);
      const wrapped = wrapToolForHarness(buildCallTool({
        reachableBuiltinNames: new Set(['composio_execute_tool']),
        admitBuiltinAcquisition: (targetName: string) => appendAgentCapabilityBinding(authority, targetName),
      }) as never) as unknown as ToolLike;
      const sessionId = `sess-${label}`;
      const accepted = acceptedSourceForCallToolFixture(sessionId);
      const output = await withHarnessRunContext(
        { sessionId, ...accepted, counter },
        () => wrapped.invoke!(
          { context: { sessionId } },
          JSON.stringify({
            name: 'composio_execute_tool',
            args_json: JSON.stringify({ tool_slug: 'APIFY_GET_DATASET_ITEMS', arguments: '{}' }),
          }),
          { toolCall: { callId: `capability-refused-${label}` } },
        ) as Promise<unknown>,
      );
      const refusal = JSON.parse(String(output));
      assert.equal(refusal.error, 'requires_readmission');
      assert.equal(refusal.kind, 'requires_readmission');
      assert.deepEqual(refusal.outside, ['composio_execute_tool']);
      assert.equal(counter.calls, 1, `${label} refusal must charge the wrapper budget exactly once`);
      assert.deepEqual(openEventLog().prepare(`
        SELECT l.tool_name, s.outcome_kind, s.execution_kind
          FROM logical_tool_calls l
          JOIN logical_call_settlements s USING (session_id, source_user_seq, logical_tool_call_id)
         WHERE l.session_id = ? AND l.source_user_seq = ? AND l.logical_tool_call_id = ?
      `).get(sessionId, accepted.sourceUserSeq, `capability-refused-${label}`), {
        tool_name: 'apify_get_dataset_items',
        outcome_kind: 'policy_denial',
        execution_kind: 'refused_pre_dispatch',
      });
      assert.equal((openEventLog().prepare(`
        SELECT COUNT(*) AS n FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(sessionId, accepted.sourceUserSeq, `capability-refused-${label}`) as { n: number }).n, 0);
    }
    assert.equal(dispatches, 0, 'capability refusals must happen before every inner dispatch');
    const after = boundAgentCapabilityRevision(sealedAuthority)!;
    assert.equal(after.revision, before.revision, 'outside-universe refusal mutated revision number');
    assert.equal(after.revisionDigest, before.revisionDigest, 'outside-universe refusal mutated revision content');
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
});

test('external MCP dispatch stays under MCP scope and bypasses built-in capability admission', async () => {
  let admissions = 0;
  let listCalls = 0;
  let dispatches = 0;
  _setInnerDispatchMcpResolverForTests(() => ({
    listTools: async () => {
      listCalls += 1;
      return [{ name: 'proof__read' }];
    },
    callTool: async () => {
      dispatches += 1;
      return 'mcp-result';
    },
  }));
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(),
      mcpToolScope: {
        reason: 'external MCP capability authority regression',
        allowedServerSlugs: ['proof'],
        maxTools: 8,
      },
      admitBuiltinAcquisition: (targetName: string) => {
        admissions += 1;
        return {
          ok: false,
          kind: 'requires_readmission',
          outside: [targetName],
        };
      },
    }) as unknown as ToolLike;
    const output = await callTool.invoke!(
      { context: { sessionId: 'sess-mcp-separate-authority' } },
      JSON.stringify({ name: 'proof__read', args_json: JSON.stringify({ id: 'row-1' }) }),
      { toolCall: { callId: 'mcp-separate-authority' } },
    );
    assert.equal(String(output), 'mcp-result');
    assert.equal(admissions, 0, 'external MCP tools must not cross built-in capability admission');
    assert.equal(listCalls, 1);
    assert.equal(dispatches, 1);
  } finally {
    _setInnerDispatchMcpResolverForTests(null);
  }
});

test('a throwing acquisition observer never breaks dispatch', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const previousExecutionGate = process.env.CLEMMY_EXECUTION_GATE;
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  _setInnerDispatchToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'updated' }]]),
  );
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(['composio_execute_tool']),
      onBuiltinAcquisition: () => { throw new Error('observer exploded'); },
    }) as unknown as ToolLike;
    const out = String(await invokeCallToolFixture(
      callTool,
      sess.id,
        JSON.stringify({
          name: 'composio_execute_tool',
          args_json: JSON.stringify({ tool_slug: 'GOOGLESHEETS_VALUES_UPDATE', arguments: JSON.stringify({ range: 'A1' }) }),
        }),
      'acq-throwing',
    ));
    assert.ok(out.startsWith('updated'), `instrumentation killed the dispatch: ${out}`);
  } finally {
    _setInnerDispatchToolsForTests(null);
    if (previousExecutionGate === undefined) delete process.env.CLEMMY_EXECUTION_GATE;
    else process.env.CLEMMY_EXECUTION_GATE = previousExecutionGate;
  }
});

// ————— consume the turn's proven resolution (2026-08-18 calendar shape) —————
// The host proves a capability + connection BEFORE the model speaks; the first
// model call naming that exact identifier must land on the carrier. Refusing it
// charged the model three calls of tuition to rediscover the harness's own
// knowledge. One ask, every carrier-surface shape: orchestrator
// (reachableBuiltinNames) and Claude lane (firstClassNames) — lane parity is
// the invariant, so both branches of the carrier-reachability precondition pin.

function seedProvenCalendarResolution(sessionId: string, sourceUserSeq: number, identifier = 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW'): void {
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'capability_resolution',
    data: {
      entries: [{
        intent: 'outlook.calendar.view_day',
        kind: 'composio',
        identifier,
        status: 'proven',
        connection: 'active',
      }],
      registryAvailable: true,
      authoritativeForTask: true,
      sourceUserSeq,
    },
  });
}

test('a proven, connected Composio identifier named as the tool lands on the carrier (orchestrator surface)', async () => {
  resetEventLog();
  const session = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(session.id);
  seedProvenCalendarResolution(session.id, accepted.sourceUserSeq);
  const carrierCalls: string[] = [];
  const restoreCatalog = installFixtureOperationContracts([
    { operationId: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW', effect: 'read' },
  ]);
  _setInnerDispatchToolsForTests(new Map([['composio_execute_tool', {
    name: 'composio_execute_tool',
    invoke: async (_ctx: unknown, raw: string) => {
      carrierCalls.push(raw);
      return JSON.stringify({ successful: true, data: { events: [] } });
    },
  }]]));
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(['composio_execute_tool']),
    }) as unknown as ToolLike;
    const out = await withHarnessRunContext(
      { sessionId: session.id, ...accepted, counter: new ToolCallsCounter(10) },
      () => withToolOutputContext(
        { sessionId: session.id, sourceUserSeq: accepted.sourceUserSeq, callId: 'call-proven-slug', toolName: 'call_tool' },
        () => callTool.invoke!(
          { context: { sessionId: session.id, sourceUserSeq: accepted.sourceUserSeq, turn: accepted.turn } },
          JSON.stringify({
            name: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
            args_json: JSON.stringify({
              start_date_time: '2026-08-19T00:00:00Z',
              end_date_time: '2026-08-20T00:00:00Z',
            }),
          }),
          { toolCall: { callId: 'call-proven-slug' } },
        ) as Promise<unknown>,
      ),
    );
    const text = String(out);
    assert.ok(!text.includes('not_reachable'), `the harness must not refuse its own proof: ${text}`);
    assert.equal(carrierCalls.length, 1, 'exactly one carrier dispatch, zero refusals of tuition');
    assert.match(carrierCalls[0], /OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW/);
    assert.match(carrierCalls[0], /start_date_time/, "the model's arguments ride the carrier envelope");
  } finally {
    restoreCatalog();
    _setInnerDispatchToolsForTests(null);
  }
});

test('the same proof consumes identically on the Claude-lane surface shape (firstClassNames)', async () => {
  resetEventLog();
  const session = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(session.id);
  seedProvenCalendarResolution(session.id, accepted.sourceUserSeq);
  let resolved: { targetName: string; targetArgs: unknown } | undefined;
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(),
    firstClassNames: new Set(['composio_execute_tool']),
    aroundResolvedDispatch: async (input) => {
      resolved = { targetName: input.targetName, targetArgs: input.targetArgs };
      return { successful: true };
    },
  }) as unknown as ToolLike;
  const out = await withHarnessRunContext(
    { sessionId: session.id, ...accepted, counter: new ToolCallsCounter(10) },
    () => withToolOutputContext(
      { sessionId: session.id, sourceUserSeq: accepted.sourceUserSeq, callId: 'call-proven-slug-fc', toolName: 'call_tool' },
      () => callTool.invoke!(
        { context: { sessionId: session.id, sourceUserSeq: accepted.sourceUserSeq, turn: accepted.turn } },
        JSON.stringify({
          name: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
          args_json: JSON.stringify({ start_date_time: '2026-08-19T00:00:00Z' }),
        }),
        { toolCall: { callId: 'call-proven-slug-fc' } },
      ) as Promise<unknown>,
    ),
  );
  assert.ok(!String(out).includes('not_reachable'), `lane parity: ${String(out)}`);
  assert.ok(resolved, 'the resolved dispatch must be reached');
  assert.equal(resolved!.targetName, 'composio_execute_tool');
  assert.match(JSON.stringify(resolved!.targetArgs), /OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW/);
});

test('a resolved carrier refusal settles the exact inner operation once with zero dispatch', async () => {
  const previous = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  resetEventLog();
  const session = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(session.id);
  const operationId = 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW';
  const operationArgs = { start_date_time: '2026-08-19T00:00:00Z' };
  const restoreCatalog = installFixtureOperationContracts([
    { operationId, effect: 'read' },
  ]);
  const { ExternalWritePreDispatchError } = await import('../runtime/harness/external-write-admission.js');
  _setInnerDispatchToolsForTests(new Map([['composio_execute_tool', {
    name: 'composio_execute_tool',
    invoke: async () => {
      throw new Error('the provider body must remain untouched');
    },
  }]]));
  const wrapped = wrapToolForHarness(buildCallTool({
    reachableBuiltinNames: new Set(['composio_execute_tool']),
    aroundResolvedDispatch: async () => {
      throw new ExternalWritePreDispatchError('fixture refusal before provider dispatch');
    },
  }) as never) as unknown as ToolLike;
  const callId = 'resolved-carrier-refusal-inner-identity';

  try {
    const refusal = await withHarnessRunContext(
      { sessionId: session.id, ...accepted, counter: new ToolCallsCounter(10) },
      () => wrapped.invoke!(
        { context: { sessionId: session.id } },
        JSON.stringify({
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: operationId,
            arguments: JSON.stringify(operationArgs),
          }),
        }),
        { toolCall: { callId } },
      ) as Promise<unknown>,
    );
    assert.match(String(refusal), /fixture refusal before provider dispatch/);

    const db = openEventLog();
    assert.deepEqual(db.prepare(`
      SELECT tool_name, state, outcome_kind
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(session.id, accepted.sourceUserSeq, callId), {
      tool_name: operationId.toLowerCase(),
      state: 'settled',
      outcome_kind: 'policy_denial',
    });
    assert.deepEqual(db.prepare(`
      SELECT execution_kind, outcome_kind, physical_crossing_count
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(session.id, accepted.sourceUserSeq, callId), {
      execution_kind: 'refused_pre_dispatch',
      outcome_kind: 'policy_denial',
      physical_crossing_count: 0,
    });
  } finally {
    restoreCatalog();
    _setInnerDispatchToolsForTests(null);
    if (previous === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = previous;
  }
});

test('an exact bound source slug reaches the shared Composio carrier without generic capability proof', async () => {
  resetEventLog();
  const session = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(session.id);
  const exactSlug = 'APIFY_ACT_RUN_SYNC_GET_DATASET_ITEMS_GET';
  const fallbackSlug = 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS';
  const carrierCalls: string[] = [];
  const restoreCatalog = installFixtureOperationContracts([
    { operationId: exactSlug, effect: 'read' },
  ]);
  _setInnerDispatchToolsForTests(new Map([['composio_execute_tool', {
    name: 'composio_execute_tool',
    invoke: async (_ctx: unknown, raw: string) => {
      carrierCalls.push(raw);
      return JSON.stringify({ successful: true, data: { items: [] } });
    },
  }]]));
  const callTool = buildCallTool({
    reachableBuiltinNames: new Set(['composio_execute_tool']),
    sourceStrategyBinding: {
      version: 1,
      primary: {
        capabilityId: `capability:composio:${exactSlug}`,
        schemaFingerprint: 'a'.repeat(64),
      },
      equivalentFallbacks: [{
        capabilityId: `capability:composio:${fallbackSlug}`,
        schemaFingerprint: 'b'.repeat(64),
      }],
      topology: 'single_aggregate_read_then_single_artifact_write',
      topologyDigest: 'c'.repeat(64),
      destination: { family: 'workbook', posture: 'create_new' },
      effect: 'external_write',
    },
  }) as unknown as ToolLike;
  const invoke = (name: string, callId: string) => withHarnessRunContext(
    { sessionId: session.id, ...accepted, counter: new ToolCallsCounter(10) },
    () => withToolOutputContext(
      { sessionId: session.id, sourceUserSeq: accepted.sourceUserSeq, callId, toolName: 'call_tool' },
      () => callTool.invoke!(
        { context: { sessionId: session.id, sourceUserSeq: accepted.sourceUserSeq, turn: accepted.turn } },
        JSON.stringify({ name, args_json: JSON.stringify({ actorId: 'compass~crawler-google-places' }) }),
        { toolCall: { callId } },
      ) as Promise<unknown>,
    ),
  );

  try {
    const exact = String(await invoke(exactSlug, 'call-bound-source-exact'));
    assert.doesNotMatch(exact, /not_reachable/);
    assert.equal(carrierCalls.length, 1, 'the exact bound source maps onto one existing carrier dispatch');
    assert.match(carrierCalls[0], new RegExp(exactSlug));
    assert.match(carrierCalls[0], /actorId/);

    const typo = JSON.parse(String(await invoke(
      'APIFY_ACTOR_TASK_RUN_SYNC_GET_DATASET_ITEMS_GET',
      'call-bound-source-typo',
    )));
    assert.equal(typo.error, 'not_reachable', 'near names never gain fuzzy source authority');
    assert.match(typo.detail, new RegExp(exactSlug));
    assert.match(typo.detail, new RegExp(fallbackSlug));
    assert.match(typo.detail, /do not rediscover or switch provider families/i);
    assert.equal(carrierCalls.length, 1, 'the typo has zero carrier dispatches');
  } finally {
    restoreCatalog();
    _setInnerDispatchToolsForTests(null);
  }
});

test('without proof — or with another turn\'s proof — the identifier stays not_reachable', async () => {
  resetEventLog();
  const session = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(session.id);
  let dispatches = 0;
  _setInnerDispatchToolsForTests(new Map([['composio_execute_tool', {
    name: 'composio_execute_tool',
    invoke: async () => { dispatches += 1; return 'never'; },
  }]]));
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(['composio_execute_tool']),
    }) as unknown as ToolLike;
    const invokeSlug = () => withHarnessRunContext(
      { sessionId: session.id, ...accepted, counter: new ToolCallsCounter(10) },
      () => withToolOutputContext(
        { sessionId: session.id, sourceUserSeq: accepted.sourceUserSeq, callId: `call-unproven-${dispatches}`, toolName: 'call_tool' },
        () => callTool.invoke!(
          { context: { sessionId: session.id, sourceUserSeq: accepted.sourceUserSeq, turn: accepted.turn } },
          JSON.stringify({ name: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW', args_json: '{}' }),
          { toolCall: { callId: `call-unproven-${dispatches}` } },
        ) as Promise<unknown>,
      ),
    );
    const unproven = JSON.parse(String(await invokeSlug()));
    assert.equal(unproven.error, 'not_reachable', 'no proof event → the regex widening grants nothing');
    // A prior turn's proof must not authorize this turn.
    seedProvenCalendarResolution(session.id, accepted.sourceUserSeq + 100);
    const crossTurn = JSON.parse(String(await invokeSlug()));
    assert.equal(crossTurn.error, 'not_reachable', 'proof is scoped to the accepted source');
    assert.equal(dispatches, 0, 'no carrier dispatch on either refusal');
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
});

test('control-only dispatcher admits registry-declared READS and still refuses business writes (live 2026-08-20 mobile dashboard)', async () => {
  // A read duplicates nothing, so the frozen action contract protects nothing
  // on it — deferred reads (workflow_get, space_history…) ride the control
  // dispatcher directly instead of paying work_call proposal grammar.
  const { isRegistryDeclaredRead } = await import('./tool-registry.js');
  assert.equal(isRegistryDeclaredRead('workflow_get'), true);
  assert.equal(isRegistryDeclaredRead('space_history'), true);
  assert.equal(isRegistryDeclaredRead('composio_execute_tool'), false, 'writes are never reads');
  assert.equal(isRegistryDeclaredRead('not_a_tool'), false);

  const dispatched: string[] = [];
  _setInnerDispatchToolsForTests(new Map([
    ['workflow_get', { name: 'workflow_get', invoke: async () => JSON.stringify({ ok: true, name: 'daily-pull' }) }],
    ['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => { dispatched.push('composio_execute_tool'); return '{}'; } }],
  ]) as never);
  const controlOnly = buildCallTool({
    controlOnlyBuiltins: true,
    reachableBuiltinNames: new Set(['workflow_get', 'composio_execute_tool']),
  }) as unknown as ToolLike;
  try {
    const read = await invokeCallToolFixture(
      controlOnly,
      'sess-control-read',
      JSON.stringify({ name: 'workflow_get', args_json: '{"name":"daily-pull"}' }),
      'control-read-1',
    );
    assert.match(String(read), /daily-pull/, 'the deferred read dispatches directly through the control door');
    const write = await invokeCallToolFixture(
      controlOnly,
      'sess-control-read',
      JSON.stringify({ name: 'composio_execute_tool', args_json: '{"tool_slug":"OUTLOOK_SEND_EMAIL","arguments":"{}"}' }),
      'control-write-1',
    );
    assert.match(String(write), /not_reachable|work_call/, 'a business write is refused toward work_call');
    assert.deepEqual(dispatched, [], 'the refused write never reaches its tool');
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
});

test('a unique current catalog live-read is reachable as an inner work_call target without being a builtin', async () => {
  resetEventLog();
  const session = createSession({ kind: 'chat' });
  const accepted = acceptedSourceForCallToolFixture(session.id);
  const operationId = 'reviewed_cli_live_read_fixture';
  const previousFactory = capabilityCatalogs.peekHostCapabilityCatalogFactory();
  const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:fixture:reviewed-cli:${operationId}`,
    providerKind: 'reviewed_cli',
    operationId,
    providerIdentity: '/usr/bin/fixture-cli',
    providerVersion: 'fixture-v1',
    operationVersion: '1',
    definitionFingerprint: 'd'.repeat(64),
    effect: 'read',
    accountId: 'reviewed_cli:host',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    purpose: 'collect_records',
    provenance: {
      issuer: 'call-tool:reviewed-cli-fixture',
      issuedAt: '2026-08-29T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
  });
  factory.register({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => {
      throw new Error('catalog entry invoke is not the production port');
    },
  });
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
  const ports = await import('../runtime/harness/production-capability-ports.js');
  const identity = ports.productionPortIdentityFromManifest(manifest);
  let invokedPayload: unknown;
  const registered = ports.registerFixtureCapabilityPort(identity, {
    invoke: async (input) => {
      invokedPayload = input.payload;
      return { status: 'exited', records: 2 };
    },
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  try {
    const callTool = buildCallTool({
      reachableBuiltinNames: new Set(['work_call']),
    }) as unknown as ToolLike;
    const out = await withHarnessRunContext(
      { sessionId: session.id, ...accepted, counter: new ToolCallsCounter(10) },
      () => withToolOutputContext(
        { sessionId: session.id, sourceUserSeq: accepted.sourceUserSeq, callId: 'call-catalog-read', toolName: 'work_call' },
        () => callTool.invoke!(
          { context: { sessionId: session.id, sourceUserSeq: accepted.sourceUserSeq, turn: accepted.turn } },
          JSON.stringify({
            name: operationId,
            args_json: JSON.stringify({ query: 'SELECT Id FROM Opportunity' }),
          }),
          { toolCall: { callId: 'call-catalog-read' } },
        ) as Promise<unknown>,
      ),
    );
    assert.doesNotMatch(String(out), /not_reachable/, String(out));
    assert.deepEqual(invokedPayload, { query: 'SELECT Id FROM Opportunity' });
    assert.deepEqual(JSON.parse(String(out)), { status: 'exited', records: 2 });
  } finally {
    ports.clearProductionCapabilityPorts();
    capabilityCatalogs.installHostCapabilityCatalogFactory(previousFactory);
  }
});

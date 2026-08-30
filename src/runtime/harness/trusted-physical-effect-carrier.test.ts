import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-trusted-effect-carrier-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-trusted-effect-carrier\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const expectedWork = await import('./expected-work-admission.js');
const identities = await import('./attempt-identity.js');
const ledger = await import('./dispatch-ledger.js');
const contracts = await import('./logical-call-contract.js');
const expectedContracts = await import('./expected-work-contract.js');
const effects = await import('./tool-effect.js');
const brackets = await import('./brackets.js');
const composio = await import('../../tools/composio-tools.js');
const { buildWorkerAgent } = await import('../../agents/sub-agents.js');
const { _setInnerDispatchToolsForTests } = await import('../../tools/inner-dispatch.js');
const currentCapabilityFixtures = await import('./current-capability-manifest.fixture.js');
const priorCapabilityFactory = currentCapabilityFixtures.installCurrentCapabilityManifestFixtures([
  {
    operationId: 'alpha__records_list',
    providerKind: 'native_mcp',
    effect: 'read',
  },
  {
    operationId: 'APIFY_ACTOR_RUNS_GET',
    providerKind: 'composio',
    effect: 'read',
  },
  {
    operationId: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
    providerKind: 'composio',
    effect: 'read',
  },
]);

test.after(() => {
  _setInnerDispatchToolsForTests(null);
  currentCapabilityFixtures.restoreCurrentCapabilityManifestFixtures(priorCapabilityFactory);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function acceptAction(label: string) {
  const session = eventlog.createSession({ id: `trusted-effect-${label}-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Pull the current records, create a sheet, and email me the link.' },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  const graphEvent = shadow.recordTurnGraphShadow({ identity: task });
  assert.ok(graphEvent, 'fixture graph persisted');
  assert.equal(
    (graphEvent!.data as { graph: { classification: { route: string } } }).graph.classification.route,
    'act',
    'fixture owns action expected-work authority',
  );
  const activated = expectedWork.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  return task;
}

function assertActiveUnbound(task: { sessionId: string; sourceUserSeq: number }) {
  const row = eventlog.openEventLog().prepare(`
    SELECT expected_work_required, work_contract_id
      FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as {
    expected_work_required: number;
    work_contract_id: string | null;
  } | undefined;
  assert.deepEqual(row, { expected_work_required: 1, work_contract_id: null });
}

function freezeBroaderVenturaContract(task: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
}): void {
  const frozen = expectedContracts.freezeActionExpectedWorkContract({
    ...task,
    proposal: {
      version: 1,
      operations: [
        {
          id: 'fetch_ventura_from_apify',
          effect: 'read',
          coverage: 'complete_set',
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        },
        {
          id: 'create_new_sheet',
          effect: 'external_write',
          dependsOn: ['fetch_ventura_from_apify'],
          dataFrom: ['fetch_ventura_from_apify'],
          cardinality: { kind: 'once' },
        },
        {
          id: 'send_sheet_link',
          effect: 'external_write',
          dependsOn: ['create_new_sheet'],
          dataFrom: ['create_new_sheet'],
          cardinality: { kind: 'once' },
        },
      ],
      universes: [],
    },
  });
  assert.ok(
    frozen.status === 'fixed' || frozen.status === 'replayed',
    `fixture freezes the accepted broader contract: ${JSON.stringify(frozen)}`,
  );
}

test('trusted provenance never exempts Composio writes, unknown actions, mismatches, or structural lookalikes', async () => {
  const cases: Array<{
    label: string;
    tool: string;
    args: Record<string, unknown>;
    carrier: unknown;
  }> = [
    {
      label: 'write',
      tool: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
      args: { title: 'must-not-create' },
      carrier: effects.trustedRuntimeEffectCarrier('composio_execute_tool', {
        tool_slug: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
        arguments: { title: 'must-not-create' },
      }),
    },
    {
      label: 'unknown',
      tool: 'PROVIDER_FROBNICATE_RECORD',
      args: { id: 'must-not-change' },
      carrier: effects.trustedRuntimeEffectCarrier('composio_execute_tool', {
        tool_slug: 'PROVIDER_FROBNICATE_RECORD',
        arguments: { id: 'must-not-change' },
      }),
    },
    {
      label: 'mismatched-read-carrier',
      tool: 'PROVIDER_FROBNICATE_RECORD',
      args: { id: 'must-not-change' },
      carrier: effects.trustedRuntimeEffectCarrier('composio_execute_tool', {
        tool_slug: 'APIFY_ACTOR_RUNS_GET',
        arguments: { actorId: 'other' },
      }),
    },
    {
      // A structural lookalike (never WeakSet-registered) claiming trusted
      // READ provenance for a call whose direct classification is a WRITE.
      // The spoof must be invisible: if a model-mintable object could carry
      // read authority, this write would dispatch. (Retargeted 2026-08-20:
      // the original fixture spoofed a bare READ slug, but bare slugs now
      // classify canonically as composio reads and the admission wall's own
      // doctrine — reads are never gated — admits them with or without any
      // carrier, so the spoof no longer changed the outcome there.)
      label: 'structural-spoof',
      tool: 'PROVIDER_FROBNICATE_RECORD',
      args: { id: 'must-not-change' },
      carrier: {
        toolName: 'composio_execute_tool',
        args: {
          tool_slug: 'PROVIDER_FROBNICATE_RECORD',
          arguments: { id: 'must-not-change' },
        },
        trusted: true,
        effect: 'read',
        prose: 'host approved',
      },
    },
  ];

  for (const fixture of cases) {
    const wrapperDecision = effects.classifyRuntimeToolEffect('composio_execute_tool', {
      tool_slug: fixture.tool,
      arguments: fixture.args,
    });
    if (fixture.label === 'write' || fixture.label === 'unknown') {
      assert.equal(wrapperDecision.effect, 'external_write', fixture.label);
    }
    const task = acceptAction(fixture.label);
    assertActiveUnbound(task);
    let providerCalled = false;
    await assert.rejects(
      identities.withLogicalToolCall(
        { ...task, tool: fixture.tool, args: fixture.args },
        () => identities.withPhysicalDispatch({
          ...task,
          tool: fixture.tool,
          args: fixture.args,
          trustedEffectCarrier: fixture.carrier,
        } as never, async () => {
          providerCalled = true;
          return { successful: true };
        }),
      ),
      (error: unknown) => error instanceof identities.PhysicalDispatchPreDispatchError
        && error.reason.startsWith('work_binding_required'),
      fixture.label,
    );
    assert.equal(providerCalled, false, fixture.label);
    assert.deepEqual(
      ledger.physicalCrossingsFor(task.sessionId, task.sourceUserSeq),
      [],
      fixture.label,
    );
  }
});

test('native MCP reads remain unbound without a trusted-effect override', async () => {
  const task = acceptAction('native-read');
  assertActiveUnbound(task);
  const tool = 'mcp__alpha__records_list';
  const args = { limit: 5 };
  assert.equal(effects.classifyRuntimeToolEffect(tool, args).effect, 'read');
  let providerEntries = 0;

  await identities.withLogicalToolCall({ ...task, tool, args }, () => identities.withPhysicalDispatch({
    ...task,
    tool,
    args,
  }, async () => {
    providerEntries += 1;
    return { records: [] };
  }));

  assert.equal(providerEntries, 1);
  assert.equal(ledger.physicalCrossingsFor(task.sessionId, task.sourceUserSeq).length, 1);
});

test('the production Composio retry path forwards trusted read provenance on every paid crossing', async () => {
  const task = acceptAction('composio-retry');
  assertActiveUnbound(task);
  const tool = 'APIFY_ACTOR_RUNS_GET';
  const args = { actorId: 'actor-production', runId: 'run-production' };
  let providerEntries = 0;

  const output = await brackets.withHarnessRunContext(
    {
      ...task,
      counter: new brackets.ToolCallsCounter(20),
    },
    () => composio.runComposioExecuteForTestInSession(
      tool,
      args,
      (async () => {
        providerEntries += 1;
        if (providerEntries === 1) throw new Error('503 Service unavailable');
        return { successful: true, data: { id: 'run-production' } };
      }) as never,
      task.sessionId,
    ),
  ) as string;

  assert.equal(providerEntries, 2, output);
  const crossings = ledger.physicalCrossingsFor(task.sessionId, task.sourceUserSeq);
  assert.deepEqual(
    crossings.map((crossing) => ({
      ordinal: crossing.ordinal,
      relation: crossing.relation,
      retryOf: crossing.retryOf,
      outcome: crossing.outcome,
    })),
    [
      { ordinal: 1, relation: 'primary', retryOf: undefined, outcome: 'threw' },
      {
        ordinal: 2,
        relation: 'retry',
        retryOf: crossings[0]!.physicalDispatchId,
        outcome: 'returned',
      },
    ],
  );

  const directContract = contracts.durableLogicalCallContract(
    identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
    tool,
    args,
  );
  assert.ok(directContract);
  const durableRows = eventlog.openEventLog().prepare(`
    SELECT tool_name, argument_digest
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY ordinal
  `).all(task.sessionId, task.sourceUserSeq);
  assert.deepEqual(durableRows, [directContract, directContract].map((contract) => ({
    tool_name: contract!.toolName,
    argument_digest: contract!.argumentDigest,
  })), 'trusted wrapper provenance does not replace the bare provider contract');
});

test('a frozen broader action still admits the exact unbound Ventura Apify read through the real Composio chain', async () => {
  const task = acceptAction('ventura-apify-frozen-read');
  freezeBroaderVenturaContract(task);
  const tool = 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS';
  const args = {
    actorId: 'compass/crawler-google-places',
    runInput: {
      searchStringsArray: ['restaurants in Ventura CA'],
      maxCrawledPlacesPerSearch: 5,
    },
  };
  let providerEntries = 0;

  const output = await brackets.withHarnessRunContext(
    {
      ...task,
      workerScope: true,
      counter: new brackets.ToolCallsCounter(20),
    },
    () => composio.runComposioExecuteForTestInSession(
      tool,
      args,
      (async () => {
        providerEntries += 1;
        return {
          successful: true,
          data: [{ name: 'Restaurant A', rating: 4.8, address: 'Ventura, CA' }],
        };
      }) as never,
      task.sessionId,
    ),
  ) as string;

  assert.equal(providerEntries, 1, output);
  assert.match(output, /Restaurant A/);
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { n: number }).n, 0,
  'the host-proven read crosses truthfully unbound rather than fabricating a requirement match');
  assert.equal(ledger.physicalCrossingsFor(task.sessionId, task.sourceUserSeq).length, 1);
});

test('the live worker work_call fallback reaches the exact Ventura Apify provider chain once', async () => {
  const task = acceptAction('ventura-worker-work-call');
  freezeBroaderVenturaContract(task);
  const tool = 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS';
  const args = {
    actorId: 'compass/crawler-google-places',
    runInput: {
      searchStringsArray: ['restaurants in Ventura CA'],
      maxCrawledPlacesPerSearch: 5,
    },
  };
  let providerEntries = 0;
  _setInnerDispatchToolsForTests(new Map([
    ['composio_execute_tool', {
      name: 'composio_execute_tool',
      invoke: async (_context: unknown, carrier: string) => {
        const input = JSON.parse(carrier) as {
          tool_slug: string;
          arguments: string | Record<string, unknown>;
        };
        const innerArgs = typeof input.arguments === 'string'
          ? JSON.parse(input.arguments) as Record<string, unknown>
          : input.arguments;
        return composio.runComposioExecuteForTestInSession(
          input.tool_slug,
          innerArgs,
          (async () => {
            providerEntries += 1;
            return {
              successful: true,
              data: [{ name: 'Restaurant A', rating: 4.8, address: 'Ventura, CA' }],
            };
          }) as never,
          task.sessionId,
        );
      },
    }],
  ] as never));
  try {
    const worker = await buildWorkerAgent({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
    }) as { tools?: Array<{ name?: string; invoke?: (...args: any[]) => Promise<unknown> }> };
    const workCall = worker.tools?.find((candidate) => candidate.name === 'work_call');
    assert.ok(workCall?.invoke, 'the activated worker owns the action-only carrier');
    const workCallId = 'call-worker-ventura-apify';
    const output = await brackets.withHarnessRunContext(
      {
        ...task,
        workerScope: true,
        counter: new brackets.ToolCallsCounter(20),
      },
      () => workCall!.invoke!(
        { context: task },
        JSON.stringify({
          // This deliberately conflicts with the already-frozen broader
          // accepted contract. Host effect truth must still admit the read.
          proposal: {
            version: 1,
            operations: [{
              id: 'inspect-ventura',
              effect: 'compute',
              coverage: null,
              dependsOn: [],
              dataFrom: [],
              cardinality: { kind: 'once' },
            }],
            universes: [],
          },
          requirement_id: 'inspect-ventura',
          universe_item_id: null,
          universe_selector: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: tool,
            arguments: JSON.stringify(args),
            connected_account_id: null,
          }),
        }),
        { toolCall: { callId: workCallId } },
      ),
    );
    const rendered = typeof output === 'string' ? output : JSON.stringify(output ?? null);
    assert.match(rendered, /Restaurant A/, rendered);
    assert.equal(providerEntries, 1, 'the full carrier stack crosses the provider exactly once');
    assert.equal((eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(task.sessionId, task.sourceUserSeq, workCallId) as { n: number }).n, 0,
    'the conflicting fallback remains truthfully unbound');
  } finally {
    _setInnerDispatchToolsForTests(null);
  }
});

test('the same frozen logical wall still refuses trusted Composio writes and unknown actions before provider I/O', async () => {
  const fixtures = [
    {
      label: 'sheet-write',
      tool: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
      args: { title: 'must-not-create' },
    },
    {
      label: 'unknown-action',
      tool: 'PROVIDER_FROBNICATE_RECORD',
      args: { id: 'must-not-change' },
    },
  ];

  for (const fixture of fixtures) {
    const task = acceptAction(`frozen-${fixture.label}`);
    freezeBroaderVenturaContract(task);
    let providerEntries = 0;

    await assert.rejects(
      brackets.withHarnessRunContext(
        {
          ...task,
          workerScope: true,
          counter: new brackets.ToolCallsCounter(20),
        },
        () => composio.runComposioExecuteForTestInSession(
          fixture.tool,
          fixture.args,
          (async () => {
            providerEntries += 1;
            return { successful: true };
          }) as never,
          task.sessionId,
        ),
      ),
      expectedWork.ExpectedWorkBindingRequiredError,
      fixture.label,
    );
    assert.equal(providerEntries, 0, fixture.label);
    assert.deepEqual(
      ledger.physicalCrossingsFor(task.sessionId, task.sourceUserSeq),
      [],
      fixture.label,
    );
  }
});

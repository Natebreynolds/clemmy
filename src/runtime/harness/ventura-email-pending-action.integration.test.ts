import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-ventura-email-card-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TOOL_GUARDRAIL = 'off';
process.env.CLEMMY_EXECUTION_GATE = 'off';
process.env.CLEMMY_GROUNDING_GATE = 'off';
process.env.CLEMMY_GOAL_FIDELITY_GATE = 'off';
process.env.CLEMMY_DESTINATION_GATE = 'off';
process.env.CLEMMY_CONFIRM_FIRST = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-ventura-email-card\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const expectedWork = await import('./expected-work-admission.js');
const expectedWorkContract = await import('./expected-work-contract.js');
const brackets = await import('./brackets.js');
const continuityRuntime = await import('./task-continuity-runtime.js');
const turnControl = await import('./turn-control.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { recordAcceptedSourceGraph } = await import('./record-accepted-source-graph.js');
const composio = await import('../../tools/composio-tools.js');
const composioSchema = await import('../../tools/composio-schema-cache.js');
const { buildWorkerAgent } = await import('../../agents/sub-agents.js');
const { _setInnerDispatchToolsForTests } = await import('../../tools/inner-dispatch.js');
const currentCapabilityFixtures = await import('./current-capability-manifest.fixture.js');
const capabilityCatalog = await import('./host-capability-catalog-factory.js');
const operationSemantics = await import('../../integrations/composio/operation-semantics.js');

const SOURCE_TOOL = 'APIFY_TEST_VENTURA_TOP_5_RESTAURANTS_GET';
const sheetFromJsonSemantics = operationSemantics
  .documentedComposioManifestOperationSemantics('GOOGLESHEETS_SHEET_FROM_JSON');
assert.ok(sheetFromJsonSemantics?.atomicInputContent, 'fixture requires reviewed atomic Sheet semantics');
const sheetReadbackVerification = operationSemantics
  .documentedComposioReadbackVerification('GOOGLESHEETS_BATCH_GET');
assert.ok(sheetReadbackVerification, 'fixture requires reviewed Sheet readback semantics');
const priorCapabilityFactory = currentCapabilityFixtures.installCurrentCapabilityManifestFixtures([
  {
    operationId: SOURCE_TOOL,
    providerKind: 'composio',
    effect: 'read',
  },
  {
    operationId: 'GOOGLESHEETS_SHEET_FROM_JSON',
    providerKind: 'composio',
    effect: 'external_write',
    destination: { family: 'googlesheets', posture: 'create_new' },
    operationSemantics: sheetFromJsonSemantics,
  },
  {
    operationId: 'GOOGLESHEETS_BATCH_GET',
    providerKind: 'composio',
    effect: 'read',
    verification: sheetReadbackVerification,
  },
  {
    operationId: 'GMAIL_SEND_EMAIL',
    providerKind: 'composio',
    effect: 'external_write',
    destination: { family: 'message', posture: 'named_existing' },
    operationSemantics: { version: 1, reversibility: 'irreversible' },
  },
]);
const sourceCatalogEntry = capabilityCatalog.peekHostCapabilityCatalogFactory()
  ?.snapshot()
  .find((entry) => entry.toolName === SOURCE_TOOL);
assert.ok(sourceCatalogEntry, 'fixture installed the exact current Ventura source capability');

test.after(() => {
  _setInnerDispatchToolsForTests(null);
  composioSchema.resetToolSchemaCache();
  currentCapabilityFixtures.restoreCurrentCapabilityManifestFixtures(priorCapabilityFactory);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const REQUEST = 'Pull the top 5 restaurants in Ventura CA from the Apify API, put them in a new Google Sheet with name, rating, and address, then email me the link.';
const SOURCE_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;
const SHEET_CREATE_SCHEMA = {
  type: 'object',
  required: ['title', 'sheet_name', 'sheet_json'],
  properties: {
    title: { type: 'string' },
    sheet_name: { type: 'string' },
    sheet_json: { type: 'array', items: { type: 'object' } },
  },
  additionalProperties: false,
} as const;
const ROWS = [
  { Name: 'Restaurant 1', Rating: 4.9, Address: '1 Main St, Ventura, CA' },
  { Name: 'Restaurant 2', Rating: 4.8, Address: '2 Main St, Ventura, CA' },
  { Name: 'Restaurant 3', Rating: 4.7, Address: '3 Main St, Ventura, CA' },
  { Name: 'Restaurant 4', Rating: 4.6, Address: '4 Main St, Ventura, CA' },
  { Name: 'Restaurant 5', Rating: 4.5, Address: '5 Main St, Ventura, CA' },
];
const SOURCE_ROWS = ROWS.map((row) => ({
  title: row.Name,
  totalScore: row.Rating,
  address: row.Address,
  rank: ROWS.indexOf(row) + 1,
}));

const proposal = {
  version: 1 as const,
  operations: [
    {
      id: 'fetch_restaurants', effect: 'read' as const, coverage: 'complete_set' as const,
      dependsOn: [], dataFrom: [], cardinality: { kind: 'once' as const },
    },
    {
      id: 'create_sheet', effect: 'external_write' as const, coverage: null,
      dependsOn: ['fetch_restaurants'], dataFrom: ['fetch_restaurants'],
      cardinality: { kind: 'once' as const },
    },
    {
      id: 'verify_sheet', effect: 'read' as const, coverage: 'complete_set' as const,
      dependsOn: ['create_sheet'], dataFrom: ['create_sheet'],
      cardinality: { kind: 'once' as const },
    },
    {
      id: 'send_link', effect: 'external_write' as const, coverage: null,
      dependsOn: ['verify_sheet'], dataFrom: ['verify_sheet'],
      cardinality: { kind: 'once' as const },
    },
  ],
  universes: [],
};

type Invokable = {
  name?: string;
  invoke?: (
    context: unknown,
    input: string,
    details?: { toolCall?: { callId?: string } },
  ) => Promise<unknown>;
};

test('a direct worker bypass cannot mint Ventura Sheet or email authority after a safe source read', async () => {
  // This integration owns the Sheet/readback/email lifecycle, not provider
  // argument-template selection. Model the already-selected Apify recipe as a
  // parameterless action so its V1 source binding is executable without
  // weakening the production rule that rejects unattested nonempty args.
  composioSchema.rememberToolSchema(SOURCE_TOOL, SOURCE_SCHEMA, Date.now());
  composioSchema.rememberToolSchema(
    'GOOGLESHEETS_SHEET_FROM_JSON',
    SHEET_CREATE_SCHEMA,
    Date.now(),
    'fixture-ventura-sheet-from-json-v1',
    {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        spreadsheetUrl: { type: 'string' },
      },
    },
  );
  const sourceSchemaFingerprint = composioSchema.liveComposioSchemaFingerprint(SOURCE_TOOL);
  assert.ok(sourceSchemaFingerprint, 'the fixture source owns a live selector-schema observation');
  sourceCatalogEntry!.sourceSchemaFingerprint = sourceSchemaFingerprint;
  const sourceStrategyBinding = {
    version: 1 as const,
    primary: {
      capabilityId: `capability:composio:${SOURCE_TOOL}`,
      accountIdentity: sourceCatalogEntry!.account!,
      schemaFingerprint: sourceSchemaFingerprint,
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write' as const,
    topologyDigest: createHash('sha256').update(JSON.stringify(proposal)).digest('hex'),
    destination: { family: 'workbook' as const, posture: 'create_new' as const },
    effect: 'external_write' as const,
  };
  const session = eventlog.createSession({ id: 'ventura-email-card-exact-once', kind: 'chat' });
  const parent = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: REQUEST },
  });
  const parentTask = { sessionId: session.id, sourceUserSeq: parent.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: parentTask }));
  const intentKey = 'ventura-email-material-source-v1';
  const question = 'Use the exact bound Apify collection before creating and emailing the Sheet?';
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'system',
    type: 'turn_preflight_decision',
    data: {
      phase: 'align',
      consequential: true,
      objective: REQUEST,
      intentKey,
      reason: 'collect_then_construct',
      confirmationDisposition: 'material_source_strategy',
      sourceStrategyPosture: 'materially_variant',
      sourceStrategyBinding,
      sourceUserSeq: parent.seq,
    },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question,
      purpose: 'clarification',
      source: 'preflight_alignment',
      sourceUserSeq: parent.seq,
      intentKey,
      confirmationDisposition: 'material_source_strategy',
      sourceStrategyBinding,
    },
  });
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(parentTask),
    identity: parentTask,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  });
  const acceptedText = 'Yes';
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: acceptedText },
  });
  const enriched = await continuityRuntime.enrichAcceptedRequestWithTaskContinuity({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    message: acceptedText,
  }, source.seq, { typedClassification: { disposition: 'affirmed' } });
  const inspection = continuityRuntime.inspectDurableMaterialSourceContinuation({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(inspection.status, 'verified', JSON.stringify(inspection));
  if (inspection.status !== 'verified') throw new Error('formal Ventura A/Q/B inspection failed');
  turnControl.recordTurnPreflightDecision(session.id, {
    phase: 'execute',
    consequential: true,
    reason: 'continuation_approved',
    sourceUserSeq: source.seq,
  }, source.seq);
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 2 };
  assert.ok(await recordAcceptedSourceGraph({
    identity: task,
    surface: 'direct',
    acceptedText,
    verifiedTaskContinuation: enriched.taskContinuation,
  }));
  const frozen = expectedWorkContract.freezeActionExpectedWorkContract({ ...task, proposal });
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  const activated = expectedWork.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  const providerCalls: string[] = [];
  _setInnerDispatchToolsForTests(new Map([[
    'composio_execute_tool',
    {
      name: 'composio_execute_tool',
      invoke: async (_context: unknown, carrier: string) => {
        const parsed = JSON.parse(carrier) as {
          tool_slug: string;
          arguments: string | Record<string, unknown>;
        };
        const args = typeof parsed.arguments === 'string'
          ? JSON.parse(parsed.arguments) as Record<string, unknown>
          : parsed.arguments;
        return composio.runComposioExecuteForTestInSession(
          parsed.tool_slug,
          args,
          (async () => {
            providerCalls.push(parsed.tool_slug);
            if (parsed.tool_slug === SOURCE_TOOL) {
              return { successful: true, data: { items: SOURCE_ROWS } };
            }
            throw new Error(`unauthorized provider tool crossed the fixture boundary: ${parsed.tool_slug}`);
          }) as never,
          task.sessionId,
          capabilityCatalog.peekHostCapabilityCatalogFactory()
            ?.snapshot()
            .find((entry) => entry.toolName === parsed.tool_slug)
            ?.account,
        );
      },
    },
  ]] as never));

  const worker = await buildWorkerAgent({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  }) as { tools?: Invokable[] };
  const workCall = worker.tools?.find((candidate) => candidate.name === 'work_call');
  assert.ok(workCall?.invoke, 'activated accepted work owns the production work_call carrier');
  const counter = new brackets.ToolCallsCounter(20);
  const invokeWork = (callId: string, input: Record<string, unknown>) => brackets.withHarnessRunContext(
      {
        ...task,
        directOrchestrator: true,
        behaviorScopeId: 'ventura-email-card-run',
        counter,
      },
      () => workCall!.invoke!(
        { context: task },
        JSON.stringify(input),
        { toolCall: { callId } },
      ),
    );

  const fetched = String(await invokeWork('ventura-fetch', {
    proposal,
    requirement_id: 'fetch_restaurants',
    universe_item_id: null,
    universe_selector: null,
    name: 'composio_execute_tool',
    args_json: JSON.stringify({
      tool_slug: SOURCE_TOOL,
      arguments: JSON.stringify({}),
      connected_account_id: null,
    }),
  }));
  assert.match(fetched, /Restaurant 1/);

  // A prior revision refused fabricated, column-swapped, wrong-field, and
  // reordered Sheet rows here. That check only ever fired for one enumerated
  // actor id, result count, and column layout, so it proved this fixture
  // rather than the property. Row-level source provenance has to be derived
  // from the settled read before it can be asserted again.

  const created = String(await invokeWork('ventura-create-sheet', {
    proposal: null,
    requirement_id: 'create_sheet',
    universe_item_id: null,
    universe_selector: null,
    name: 'composio_execute_tool',
    args_json: JSON.stringify({
      tool_slug: 'GOOGLESHEETS_SHEET_FROM_JSON',
      arguments: JSON.stringify({
        title: 'Top 5 Ventura Restaurants',
        sheet_name: 'Restaurants',
        sheet_json: ROWS,
      }),
      connected_account_id: null,
    }),
  }));
  assert.match(
    created,
    /host call attestation is missing/,
    'the obsolete direct-worker fixture cannot substitute for plan_task plus host-v1 invocation authority',
  );
  assert.deepEqual(providerCalls, [SOURCE_TOOL], 'only the safe source read crosses the replaced provider boundary');
  assert.equal(providerCalls.includes('GMAIL_SEND_EMAIL'), false);

  // Positive end-to-end plan/read/create coverage lives in
  // restaurant-sheet-natural-request.integration.test.ts; exact host-planned
  // email approval authority is pinned in host-consent-grant-admission.test.ts.
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-ventura-email-card-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
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
const artifactLedger = await import('./artifact-ledger.js');
const dispatchLedger = await import('./dispatch-ledger.js');
const brackets = await import('./brackets.js');
const pendingActions = await import('./pending-actions.js');
const pendingTransitions = await import('./pending-action-transition.js');
const approvals = await import('./approval-registry.js');
const composio = await import('../../tools/composio-tools.js');
const pendingTools = await import('../../tools/pending-action-tools.js');
const { buildWorkerAgent } = await import('../../agents/sub-agents.js');
const {
  _setCodeModeToolsForTests,
  dispatchBatchItemTool,
} = await import('../../tools/code-mode-tool.js');
const { withToolOutputContext } = await import('./tool-output-context.js');

test.after(() => {
  _setCodeModeToolsForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const REQUEST = 'Pull the top 5 restaurants in Ventura CA from the Apify API, put them in a new Google Sheet with name, rating, and address, then email me the link.';
const SHEET_ID = 'ventura-sheet-verified';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
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
      id: 'inspect_sheet', effect: 'read' as const, coverage: 'complete_set' as const,
      dependsOn: ['fetch_restaurants'], dataFrom: ['fetch_restaurants'],
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

function pendingHandler(name: string) {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }>>();
  pendingTools.registerPendingActionTools({
    tool(toolName: string, ...args: unknown[]) {
      handlers.set(toolName, args.at(-1) as (input: Record<string, unknown>) => Promise<{
        content: Array<{ type: 'text'; text: string }>;
      }>);
    },
  } as never);
  const handler = handlers.get(name);
  if (!handler) throw new Error(`missing ${name}`);
  return handler;
}

test('verified Ventura Sheet yields exactly one email approval card and zero sends across an identical retry', async () => {
  const session = eventlog.createSession({ id: 'ventura-email-card-exact-once', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: REQUEST },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const activated = expectedWork.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );

  let emailProviderSends = 0;
  const providerCalls: string[] = [];
  let providerReadySheetRows: unknown;
  let sheetReadCalls = 0;
  _setCodeModeToolsForTests(new Map([[
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
            if (parsed.tool_slug === 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS') {
              return { successful: true, data: { items: SOURCE_ROWS } };
            }
            if (parsed.tool_slug === 'GOOGLESHEETS_SHEET_FROM_JSON') {
              providerReadySheetRows = args.sheet_json;
              return {
                successful: true,
                data: {
                  spreadsheetId: SHEET_ID,
                  spreadsheetUrl: SHEET_URL,
                  account: { id: 'ambient-account-id-must-not-become-the-sheet' },
                },
              };
            }
            if (parsed.tool_slug === 'GOOGLESHEETS_BATCH_GET') {
              sheetReadCalls += 1;
              assert.equal(
                args.valueRenderOption,
                'UNFORMATTED_VALUE',
                'numeric ratings require unformatted provider values',
              );
              const correctContent = sheetReadCalls === 1 || args.majorDimension === 'ROWS';
              const providerRows = providerReadySheetRows as typeof ROWS;
              const headers = Object.keys(providerRows[0]!) as Array<keyof typeof ROWS[number]>;
              const readRows = correctContent
                ? providerRows
                : providerRows.map((row, index) => index === 2
                  ? { ...row, Address: 'WRONG CONTENT' }
                  : row);
              return {
                successful: true,
                data: {
                  spreadsheetId: SHEET_ID,
                  spreadsheetUrl: SHEET_URL,
                  valueRanges: [{
                    range: "'Restaurants'!A1:C6",
                    values: [
                      headers,
                      ...readRows.map((row) => headers.map((header) => row[header])),
                    ],
                  }],
                },
              };
            }
            if (parsed.tool_slug === 'GMAIL_SEND_EMAIL') {
              emailProviderSends += 1;
              return { successful: true, data: { message_id: 'must-not-send-before-approval' } };
            }
            throw new Error(`unexpected provider tool ${parsed.tool_slug}`);
          }) as never,
          task.sessionId,
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
      tool_slug: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
      arguments: JSON.stringify({
        actorId: 'compass/crawler-google-places',
        runInput: { searchStringsArray: ['restaurants in Ventura CA'] },
        limit: 5,
      }),
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
  assert.match(created, new RegExp(SHEET_ID));
  assert.deepEqual(
    providerReadySheetRows,
    ROWS,
    'the Sheet provider receives all five source records in the exact source order and requested column order',
  );
  assert.deepEqual(
    Object.keys((providerReadySheetRows as typeof ROWS)[0]!),
    ['Name', 'Rating', 'Address'],
    'provider-visible key iteration retains the user-requested column order',
  );
  const generatedArtifactRows = artifactLedger.listRunArtifacts(task.sessionId);
  assert.equal(generatedArtifactRows.length, 1);
  assert.deepEqual({
    sourceCallId: generatedArtifactRows[0]!.sourceCallId,
    resourceId: generatedArtifactRows[0]!.resourceId,
    uri: generatedArtifactRows[0]!.uri,
    status: generatedArtifactRows[0]!.status,
  }, {
    sourceCallId: 'ventura-create-sheet',
    resourceId: SHEET_ID,
    uri: SHEET_URL,
    status: 'bound',
  }, 'create binds one stable generated Sheet artifact, ignoring ambient account.id');
  assert.equal(artifactLedger.generatedArtifactContentVerificationForTests({
    ...task,
    createLogicalToolCallId: 'ventura-create-sheet',
  })?.contentVerifiedAt, null);

  const unrelatedInspection = String(await invokeWork('ventura-inspect-sheet-unrelated', {
    proposal: null,
    requirement_id: 'inspect_sheet',
    universe_item_id: null,
    universe_selector: null,
    name: 'composio_execute_tool',
    args_json: JSON.stringify({
      tool_slug: 'GOOGLESHEETS_BATCH_GET',
      arguments: JSON.stringify({
        spreadsheet_id: SHEET_ID,
        ranges: ["'Restaurants'!A1:C6"],
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
      connected_account_id: null,
    }),
  }));
  assert.doesNotMatch(unrelatedInspection, /WRONG CONTENT/);
  assert.equal(
    artifactLedger.generatedArtifactContentVerificationForTests({
      ...task,
      createLogicalToolCallId: 'ventura-create-sheet',
    })?.contentVerifiedAt,
    null,
    'an exact read bound to an unrelated operation cannot verify the create contract',
  );

  const wrongReadback = String(await invokeWork('ventura-verify-sheet-wrong-content', {
    proposal: null,
    requirement_id: 'verify_sheet',
    universe_item_id: null,
    universe_selector: null,
    name: 'composio_execute_tool',
    args_json: JSON.stringify({
      tool_slug: 'GOOGLESHEETS_BATCH_GET',
      arguments: JSON.stringify({
        spreadsheet_id: SHEET_ID,
        ranges: ["'Restaurants'!A1:C6"],
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
      connected_account_id: null,
    }),
  }));
  assert.match(wrongReadback, /WRONG CONTENT/);

  const emailPayload = {
    tool_slug: 'GMAIL_SEND_EMAIL',
    arguments: JSON.stringify({
      recipient_email: 'owner@example.com',
      subject: 'Top 5 Ventura restaurants',
      body: `Here is the verified Google Sheet: ${SHEET_URL}`,
    }),
    connected_account_id: 'ca_gmail_owner',
  };
  const sendBeforeContentProof = String(await invokeWork('ventura-send-before-content-proof', {
    proposal: null,
    requirement_id: 'send_link',
    universe_item_id: null,
    universe_selector: null,
    name: 'composio_execute_tool',
    args_json: JSON.stringify(emailPayload),
  }));
  assert.match(
    sendBeforeContentProof,
    /work_dependency_pending/,
    'a same-id readback with one wrong cell cannot authorize the irreversible email',
  );
  assert.equal(emailProviderSends, 0);
  assert.equal(pendingActions.listPendingActions({ sessionId: task.sessionId }).length, 0);

  const verified = String(await invokeWork('ventura-verify-sheet-correct-content', {
    proposal: null,
    requirement_id: 'verify_sheet',
    universe_item_id: null,
    universe_selector: null,
    name: 'composio_execute_tool',
    args_json: JSON.stringify({
      tool_slug: 'GOOGLESHEETS_BATCH_GET',
      arguments: JSON.stringify({
        spreadsheet_id: SHEET_ID,
        ranges: ["'Restaurants'!A1:C6"],
        majorDimension: 'ROWS',
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
      connected_account_id: null,
    }),
  }));
  assert.match(verified, /Restaurants.*A1:C6/);
  assert.doesNotMatch(verified, /WRONG CONTENT/);

  const contentVerification = artifactLedger.generatedArtifactContentVerificationForTests({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    createLogicalToolCallId: 'ventura-create-sheet',
  });
  assert.equal(
    contentVerification?.verificationLogicalToolCallId,
    'ventura-verify-sheet-correct-content',
    `corrected exact readback must persist the content proof: ${JSON.stringify(contentVerification)}`,
  );
  const sendAttempt = String(await invokeWork('ventura-send-link', {
    proposal: null,
    requirement_id: 'send_link',
    universe_item_id: null,
    universe_selector: null,
    name: 'composio_execute_tool',
    args_json: JSON.stringify(emailPayload),
  }));
  assert.match(
    sendAttempt,
    /PENDING_ACTION_APPROVAL_REQUIRED/,
    `the satisfied verify_sheet dependency must reach the irreversible-send floor: ${JSON.stringify({ sendAttempt, contentVerification })}`,
  );
  assert.doesNotMatch(sendAttempt, /work_dependency_pending/);
  assert.equal(emailProviderSends, 0, 'work_call cannot send while approval is pending');
  assert.equal(providerCalls.filter((name) => name === 'GMAIL_SEND_EMAIL').length, 0);

  const queue = pendingHandler('pending_action_queue');
  const queueInput = {
    title: 'Email the verified Ventura Sheet',
    summary: 'Send the verified Google Sheet link to the request owner.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payloadJson: JSON.stringify(emailPayload),
    approvalIntent: 'request_now',
    targetSummary: 'owner@example.com',
    preview: `Here is the verified Google Sheet: ${SHEET_URL}`,
    risk: 'Email delivery is irreversible.',
    rollback: 'A delivered email cannot be recalled reliably.',
  };
  const queueOnce = () => withToolOutputContext(
    {
      sessionId: task.sessionId,
      runScopeId: 'ventura-email-card-run',
      callId: 'ventura-queue-email',
    },
    () => brackets.withHarnessRunContext(
      {
        ...task,
        directOrchestrator: true,
        behaviorScopeId: 'ventura-email-card-run',
        counter,
      },
      () => queue(queueInput),
    ),
  );
  const firstQueue = await queueOnce();
  const retryQueue = await queueOnce();
  assert.match(firstQueue.content[0]!.text, /Pending action queued/);
  assert.match(retryQueue.content[0]!.text, /Pending action reused/);

  const pending = pendingActions.listPendingActions({ sessionId: task.sessionId });
  assert.equal(pending.length, 1, 'an identical queue retry reuses one byte-pinned action');
  const transitions = pendingTransitions.queuedApprovalTransitionsForRequest(
    task.sessionId,
    task.sourceUserSeq,
  );
  assert.equal(transitions.length, 1, 'same-request retry projects one queue→card edge');

  const firstMaterialization = pendingTransitions.materializeQueuedApprovals(
    task.sessionId,
    task.turn,
    task.sourceUserSeq,
    transitions,
  );
  const secondMaterialization = pendingTransitions.materializeQueuedApprovals(
    task.sessionId,
    task.turn,
    task.sourceUserSeq,
    transitions,
  );
  assert.equal(firstMaterialization.length, 1);
  assert.equal(secondMaterialization.length, 0, 'a consumed transition cannot mint a second card');
  const cards = approvals.listPending({ sessionId: task.sessionId, status: 'pending' });
  assert.equal(cards.length, 1, 'exactly one formal approval card owns the email');
  assert.equal(firstMaterialization[0]!.approval.approvalId, cards[0]!.approvalId);
  assert.equal(pendingActions.listPendingActions({ sessionId: task.sessionId }).length, 1);
  assert.equal(emailProviderSends, 0, 'card materialization and retry never dispatch the email');
  assert.deepEqual(providerCalls, [
    'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
    'GOOGLESHEETS_SHEET_FROM_JSON',
    'GOOGLESHEETS_BATCH_GET',
    'GOOGLESHEETS_BATCH_GET',
    'GOOGLESHEETS_BATCH_GET',
  ], 'one create crosses once; only the safe changed readback retries; email never crosses');
  const crossingCounts = new Map<string, number>();
  for (const crossing of dispatchLedger.physicalCrossingsFor(task.sessionId, task.sourceUserSeq)) {
    crossingCounts.set(crossing.tool, (crossingCounts.get(crossing.tool) ?? 0) + 1);
  }
  assert.deepEqual([...crossingCounts.entries()].sort(([left], [right]) => left.localeCompare(right)), [
    ['apify_run_actor_sync_get_dataset_items', 1],
    ['googlesheets_batch_get', 3],
    ['googlesheets_sheet_from_json', 1],
  ], 'durable crossings agree with the provider seam and contain no email');

  _setCodeModeToolsForTests(new Map([[
    'carrier_context_probe',
    {
      name: 'carrier_context_probe',
      invoke: async () => {
        const active = brackets.harnessRunContextStorage.getStore();
        return {
          batchItem: active?.batchItem === true,
          certifiedBatch: active?.certifiedBatch !== undefined,
        };
      },
    },
  ]] as never));
  const probeSession = eventlog.createSession({ id: 'carrier-batch-item-parity', kind: 'chat' });
  const probeSource = eventlog.appendEvent({
    sessionId: probeSession.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'hello' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: probeSession.id, sourceUserSeq: probeSource.seq, turn: 1 },
  }));
  const probeCounter = new brackets.ToolCallsCounter(10);
  const mirror = await brackets.withHarnessRunContext(
    { sessionId: probeSession.id, sourceUserSeq: probeSource.seq, turn: 1, counter: probeCounter },
    () => dispatchBatchItemTool(
      'carrier_context_probe',
      {},
      probeSession.id,
      probeCounter,
      undefined,
      { accounting: 'transport_mirror', canonicalCallId: 'probe-transport-mirror' },
    ),
  ) as { batchItem: boolean; certifiedBatch: boolean };
  const realBatch = await brackets.withHarnessRunContext(
    { sessionId: probeSession.id, sourceUserSeq: probeSource.seq, turn: 1, counter: probeCounter },
    () => dispatchBatchItemTool(
      'carrier_context_probe',
      {},
      probeSession.id,
      probeCounter,
      { batchId: 'batch-proof', payloadHash: 'payload-proof' },
    ),
  ) as { batchItem: boolean; certifiedBatch: boolean };
  assert.deepEqual(mirror, { batchItem: false, certifiedBatch: false },
    'work_call transport mirrors retain normal artifact ownership');
  assert.deepEqual(realBatch, { batchItem: true, certifiedBatch: true },
    'real certified batch items retain outer-owned artifact semantics');
  const probeEvents = eventlog.listEvents(probeSession.id, { types: ['tool_called'] })
    .filter((event) => event.data.tool === 'carrier_context_probe')
    .map((event) => ({
      callId: event.data.callId,
      batchMode: event.data.batchMode,
      accounting: event.data.accounting ?? null,
    }));
  assert.deepEqual(probeEvents, [
    { callId: 'probe-transport-mirror', batchMode: false, accounting: 'transport_mirror' },
    { callId: probeEvents[1]?.callId, batchMode: true, accounting: null },
  ]);
  assert.equal(emailProviderSends, 0, 'carrier parity probes add no provider crossing');
});

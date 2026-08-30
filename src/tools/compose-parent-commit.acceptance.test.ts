/**
 * Hermetic compose -> parent-commit acceptance.
 *
 * Five worker-scoped draft attempts must stop at the shared Composio gateway,
 * return exact payloads to the parent, and cross the provider boundary only as
 * one approved run_batch. The whole shape is repeated after the provider
 * rotates the mailbox's opaque ca_* connection id.
 *
 * Run: npx tsx --test src/tools/compose-parent-commit.acceptance.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

// Isolation must precede every Clementine import: eventlog, pending actions,
// tool contracts, aliases, and batch ledgers all bind to BASE_DIR at import.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-compose-parent-commit-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.COMPOSIO_BACKEND = 'sdk';
delete process.env.COMPOSIO_API_KEY;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'compose-parent-commit-test\n');

const {
  __test__: composioClientTest,
  listUsableConnectedToolkits,
  resetComposioClient,
} = await import('../integrations/composio/client.js');
const { createClementineMcpServer } = await import('./mcp-server.js');
const { registerBatchTools } = await import('./batch-tools.js');
const { getComposioRuntimeTools, dispatchComposioTool } = await import('./composio-tools.js');
const { _setInnerDispatchToolsForTests } = await import('./inner-dispatch.js');
const {
  _setCertifyJudgeForTests,
  readBatchLedger,
} = await import('../execution/batch-runner.js');
type BatchRunLedger = import('../execution/batch-runner.js').BatchRunLedger;
const { rememberToolSchema, resetToolSchemaCache } = await import('./composio-schema-cache.js');
const { rememberAccountAlias } = await import('../memory/account-alias-store.js');
const { ExecutionStore } = await import('../execution/store.js');
const {
  appendEvent,
  createSession,
  listEvents,
} = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const {
  getPendingAction,
  listPendingActions,
} = await import('../runtime/harness/pending-actions.js');
const { pendingActionApprovalView } = await import('../runtime/harness/pending-action-view.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const {
  harnessRunContextStorage,
  ToolCallsCounter,
  withHarnessRunContext,
} = await import('../runtime/harness/brackets.js');

const MAILBOX = 'review@corp.example';
const ACCOUNT_ALIAS = 'review-box';
const CREATE_DRAFT = 'OUTLOOK_CREATE_DRAFT';
const LIST_DRAFTS = 'OUTLOOK_LIST_DRAFTS';
const BEFORE_CONNECTION = 'ca_before_rotation_opaque';
const AFTER_CONNECTION = 'ca_after_rotation_opaque';

interface DraftArgs {
  to_email: string;
  subject: string;
  body: string;
}

interface DraftFixture {
  id: string;
  args: DraftArgs;
}

interface StoredDraft extends DraftArgs {
  id: string;
}

interface ProviderObservation {
  slug: string;
  connectedAccountId: string | null;
  args: Record<string, unknown>;
  certifiedBatch: boolean;
  batchItem: boolean;
}

type TextResult = { content: Array<{ type: 'text'; text: string }> };
type RawHandler = (input: Record<string, unknown>) => Promise<TextResult>;

function fixtures(phase: 'before' | 'after'): DraftFixture[] {
  return Array.from({ length: 5 }, (_, index) => {
    const ordinal = index + 1;
    return {
      id: `${phase}-draft-${ordinal}`,
      args: {
        to_email: `${phase}.recipient.${ordinal}@example.test`,
        subject: `${phase.toUpperCase()} rotation draft ${ordinal}`,
        body: `Exact ${phase} body ${ordinal}.`,
      },
    };
  });
}

function account(id: string): Record<string, unknown> {
  return {
    id,
    status: 'ACTIVE',
    toolkit: { slug: 'outlook' },
    user_id: 'hermetic-owner',
    data: { user_info: { email: MAILBOX } },
  };
}

function captureBatchHandler(): RawHandler {
  let handler: RawHandler | undefined;
  registerBatchTools({
    tool(name: string, ...args: unknown[]) {
      if (name === 'run_batch') handler = args.at(-1) as RawHandler;
    },
  } as never);
  assert.ok(handler, 'run_batch registered on the parent surface');
  return handler;
}

function registeredHandler(
  server: ReturnType<typeof createClementineMcpServer>,
  name: string,
): RawHandler {
  const tools = (server as unknown as {
    _registeredTools: Record<string, { handler: RawHandler }>;
  })._registeredTools;
  const handler = tools[name]?.handler;
  assert.ok(handler, `${name} registered on the MCP surface`);
  return handler;
}

function exactComposedPayload(fixture: DraftFixture): string {
  return JSON.stringify({
    id: fixture.id,
    composioSlug: CREATE_DRAFT,
    args: fixture.args,
    account_alias: ACCOUNT_ALIAS,
  });
}

function parseExactWorkerPayloads(
  raw: string[],
  expected: DraftFixture[],
): Array<{ id: string; args: DraftArgs; account_alias: string }> {
  assert.equal(raw.length, 5, 'the parent received exactly five worker payloads');
  return raw.map((text, index) => {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ['account_alias', 'args', 'composioSlug', 'id'],
      `worker ${index + 1} returned only the compose contract`,
    );
    assert.equal(parsed.id, expected[index].id);
    assert.equal(parsed.composioSlug, CREATE_DRAFT);
    assert.equal(parsed.account_alias, ACCOUNT_ALIAS);
    assert.deepEqual(parsed.args, expected[index].args);
    assert.doesNotMatch(text, /ca_[a-z0-9_]+/i, 'opaque provider identity never enters a worker payload');
    return {
      id: parsed.id as string,
      args: parsed.args as unknown as DraftArgs,
      account_alias: parsed.account_alias as string,
    };
  });
}

function approvePendingBatch(
  record: NonNullable<ReturnType<typeof getPendingAction>>,
): string {
  const row = approvalRegistry.register({
    sessionId: record.sessionId!,
    subject: `Approve ${record.id}`,
    tool: 'request_approval',
    args: {
      pendingActionId: record.id,
      pendingAction: pendingActionApprovalView(record),
    },
  });
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'test');
  assert.equal(resolved.ok, true, 'the one exact batch approval resolved');
  assert.equal(getPendingAction(record.id)?.status, 'approved');
  return row.approvalId;
}

function canonicalDrafts(value: StoredDraft[]): StoredDraft[] {
  return [...value].sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Accept one user turn the way the runtime does: the input event plus the
 * persisted turn graph for it. Dispatch admission refuses a logical call whose
 * accepted task has no graph, so an anchor missing either half turns the first
 * worker attempt into a pre-dispatch authority error.
 */
function acceptUserTurn(sessionId: string, turn: number, text: string): { seq: number; turn: number } {
  const source = appendEvent({
    sessionId,
    turn,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const shadow = recordTurnGraphShadow({
    identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
  });
  assert.ok(shadow, `fixture persisted the turn graph for turn ${turn}`);
  return { seq: source.seq, turn: source.turn };
}

after(() => {
  _setCertifyJudgeForTests(null);
  _setInnerDispatchToolsForTests(null);
  composioClientTest.setConnectedAccountsLoader(null);
  resetComposioClient();
  resetToolSchemaCache();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('five workers compose, one parent batch commits, and stable mailbox routing survives ca_* rotation', async () => {
  const session = createSession({ kind: 'chat', title: 'compose parent commit acceptance' });
  const executionSource = acceptUserTurn(
    session.id,
    1,
    'Prepare the reviewed Outlook drafts through the worker-compose parent-commit lane.',
  );
  new ExecutionStore().create({
    sessionId: session.id,
    sourceUserSeq: executionSource.seq,
    channel: 'cli',
    title: 'Prepare reviewed Outlook drafts',
    objective: 'Compose five exact draft payloads in workers and commit them once from the parent.',
    reason: 'Acceptance fixture for the production execution-wrap boundary.',
    startedFromMessage: 'Prepare the reviewed Outlook drafts.',
    confidence: 1,
    reasons: ['explicit acceptance fixture'],
  });
  let liveConnectionId = BEFORE_CONNECTION;
  const providerObservations: ProviderObservation[] = [];
  const sends: ProviderObservation[] = [];
  const mailboxDrafts = new Map<string, StoredDraft[]>();

  const loadAccounts = (): Promise<Array<Record<string, unknown>>> =>
    Promise.resolve([account(liveConnectionId)]);
  composioClientTest.setConnectedAccountsLoader(loadAccounts);
  const executeProvider = async (slug: string, body: Record<string, unknown>) => {
        const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
          ? body.arguments as Record<string, unknown>
          : {};
        const connectedAccountId = typeof body.connected_account_id === 'string'
          ? body.connected_account_id
          : typeof body.connectedAccountId === 'string'
            ? body.connectedAccountId
            : null;
        const run = harnessRunContextStorage.getStore();
        const observation: ProviderObservation = {
          slug,
          connectedAccountId,
          args: structuredClone(args),
          certifiedBatch: Boolean(run?.certifiedBatch),
          batchItem: run?.batchItem === true,
        };
        providerObservations.push(observation);
        if (/SEND|PUBLISH|DISPATCH|FORWARD/i.test(slug)) sends.push(observation);

        assert.equal(
          connectedAccountId,
          liveConnectionId,
          'provider dispatch used the currently live opaque connection id',
        );
        const mailbox = mailboxDrafts.get(MAILBOX) ?? [];
        if (slug === CREATE_DRAFT) {
          assert.equal(run?.certifiedBatch != null, true, 'draft write carried certified parent-batch authority');
          assert.equal(run?.batchItem, true, 'draft write was one real batch item');
          const draftArgs = args as unknown as DraftArgs;
          const fixtureId = [...fixtures('before'), ...fixtures('after')]
            .find((fixture) => fixture.args.subject === draftArgs.subject)?.id;
          assert.ok(fixtureId, `provider received a known exact subject: ${draftArgs.subject}`);
          assert.deepEqual(
            draftArgs,
            [...fixtures('before'), ...fixtures('after')]
              .find((fixture) => fixture.id === fixtureId)?.args,
          );
          const stored: StoredDraft = { id: `provider-${fixtureId}`, ...draftArgs };
          mailbox.push(stored);
          mailboxDrafts.set(MAILBOX, mailbox);
          return { successful: true, data: { id: stored.id } };
        }
        if (slug === LIST_DRAFTS) {
          return {
            successful: true,
            data: { drafts: canonicalDrafts(mailbox) },
          };
        }
        throw new Error(`Unexpected provider slug in hermetic acceptance: ${slug}`);
  };
  composioClientTest.setComposioClient({
    tools: {
      execute: executeProvider,
    },
    getClient: () => ({
      withOptions: (options: { maxRetries?: number }) => {
        assert.equal(options.maxRetries, 0, 'prepared batch uses the exact no-retry transport');
        return { tools: { execute: executeProvider } };
      },
    }),
  });

  rememberAccountAlias({
    toolkit: 'outlook',
    label: ACCOUNT_ALIAS,
    email: MAILBOX,
    connectionId: BEFORE_CONNECTION,
  });
  const draftSchema = {
    type: 'object',
    required: ['to_email', 'subject', 'body'],
    properties: {
      to_email: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
  };
  const definitionObservedAt = Date.now();
  rememberToolSchema(CREATE_DRAFT, draftSchema, definitionObservedAt, 'fixture-operation-v1', null);
  rememberToolSchema(
    LIST_DRAFTS,
    { type: 'object', properties: {} },
    definitionObservedAt,
    'fixture-operation-v1',
    null,
  );

  // The real batch runner resolves its local tool through this map. The tool is
  // production composio_execute_tool; only the surrounding provider is fake.
  const composioExecute = getComposioRuntimeTools().find((tool) => tool.name === 'composio_execute_tool');
  assert.ok(composioExecute?.invoke, 'production composio_execute_tool is invokable');
  _setInnerDispatchToolsForTests(new Map([['composio_execute_tool', composioExecute as never]]));
  _setCertifyJudgeForTests(async () => ({
    allow: true,
    reason: 'all five draft payloads match the exact reviewed fixtures',
    concerns: [],
    judged: true,
  }));

  const parentRunBatch = captureBatchHandler();
  const runBatchCalls: Array<'propose' | 'execute' | 'status'> = [];

  const runPhase = async (
    phase: 'before' | 'after',
    expectedConnectionId: string,
    expectedReadback: StoredDraft[],
  ): Promise<BatchRunLedger> => {
    // Prepared business execution consumes the current account observation
    // published by discovery/status. It deliberately does not hide a fresh
    // account-list crossing inside dispatch, so the acceptance fixture must
    // perform the same explicit preparation step as production.
    const preparedAccounts = await listUsableConnectedToolkits();
    assert.ok(
      preparedAccounts.some((entry) => entry.connectionId === expectedConnectionId),
      `${phase}: exact current mailbox observation was published before execution`,
    );
    const expected = fixtures(phase);
    const source = acceptUserTurn(
      session.id,
      phase === 'before' ? 2 : 3,
      `Create the five ${phase} reviewed Outlook drafts.`,
    );
    const workerServer = createClementineMcpServer({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      runScopeId: `${session.id}:worker:${phase}`,
      workerScope: true,
      gatedMutations: true,
      allowedTools: ['composio_execute_tool'],
    });
    const workerTools = (workerServer as unknown as {
      _registeredTools: Record<string, { handler: RawHandler }>;
    })._registeredTools;
    assert.equal(workerTools.run_batch, undefined, 'worker surface has no parent commit primitive');
    const workerComposio = registeredHandler(workerServer, 'composio_execute_tool');
    const providerCountBeforeCompose = providerObservations.length;
    const pendingActionCountBeforeCompose = listPendingActions({
      sessionId: session.id,
      status: 'all',
    }).length;
    const blockCountBefore = listEvents(session.id, { types: ['guardrail_tripped'] })
      .filter((event) => event.data.reason === 'worker-compose-only').length;

    const rawWorkerPayloads = await Promise.all(expected.map(async (fixture) => {
      const attempted = await workerComposio({
        tool_slug: CREATE_DRAFT,
        arguments: JSON.stringify(fixture.args),
        connected_account_id: null,
      });
      const text = attempted.content[0]?.text ?? '';
      assert.match(text, /WORKER_COMPOSE_ONLY/);
      assert.match(text, /No provider dispatch was started/);
      return exactComposedPayload(fixture);
    }));
    assert.equal(
      providerObservations.length,
      providerCountBeforeCompose,
      `${phase}: five worker mutations stopped before the provider`,
    );
    assert.equal(
      listPendingActions({ sessionId: session.id, status: 'all' }).length,
      pendingActionCountBeforeCompose,
      `${phase}: worker composition minted no approval or pending-action side effect`,
    );
    const blockCountAfter = listEvents(session.id, { types: ['guardrail_tripped'] })
      .filter((event) => event.data.reason === 'worker-compose-only').length;
    assert.equal(blockCountAfter - blockCountBefore, 5, `${phase}: every worker refusal is ledgered`);

    const composed = parseExactWorkerPayloads(rawWorkerPayloads, expected);
    const invokeParent = (input: Record<string, unknown>): Promise<TextResult> => {
      const action = input.action;
      assert.ok(action === 'propose' || action === 'execute' || action === 'status');
      runBatchCalls.push(action);
      return withToolOutputContext(
        {
          sessionId: session.id,
          runScopeId: `${session.id}:${phase}`,
          callId: `run-batch-${phase}-${action}`,
          toolName: 'run_batch',
        },
        () => withHarnessRunContext(
          {
            sessionId: session.id,
            behaviorScopeId: `${session.id}:${phase}`,
            sourceUserSeq: source.seq,
            counter: new ToolCallsCounter(100),
          },
          () => parentRunBatch(input),
        ),
      );
    };

    const pendingBefore = new Set(
      listPendingActions({ sessionId: session.id, status: 'all' }).map((record) => record.id),
    );
    const providerCountBeforeProposal = providerObservations.length;
    const proposed = await invokeParent({
      action: 'propose',
      plan: {
        tool: 'composio_execute_tool',
        composioSlug: CREATE_DRAFT,
        sideEffect: 'write',
        objective: `create the five exact reviewed ${phase} Outlook drafts in one stable mailbox`,
        items: composed.map((item) => ({
          id: item.id,
          account_alias: item.account_alias,
          args: JSON.stringify(item.args),
        })),
      },
    });
    assert.doesNotMatch(proposed.content[0]?.text ?? '', /REFUSED|Plan invalid|failed:/i);
    assert.equal(
      providerObservations.length,
      providerCountBeforeProposal,
      `${phase}: proposing the immutable parent batch dispatches nothing`,
    );
    const created = listPendingActions({ sessionId: session.id, status: 'all' })
      .filter((record) => !pendingBefore.has(record.id));
    assert.equal(created.length, 1, `${phase}: one logical parent proposal created one action`);
    const pending = created[0];
    assert.equal(pending.toolName, 'run_batch');
    const storedPlan = pending.payload as {
      items: Array<{ id: string; args: Record<string, unknown>; connectedAccountId?: string }>;
    };
    assert.equal(storedPlan.items.length, 5);
    assert.deepEqual(storedPlan.items.map((item) => item.id), expected.map((item) => item.id));
    assert.ok(storedPlan.items.every((item) => item.args.account_alias === MAILBOX));
    assert.ok(storedPlan.items.every((item) => item.connectedAccountId === undefined));
    assert.doesNotMatch(JSON.stringify(pending.payload), /ca_[a-z0-9_]+/i);

    approvePendingBatch(pending);
    const writesBeforeCommit = providerObservations.filter((row) => row.slug === CREATE_DRAFT).length;
    const completedBefore = listEvents(session.id, { types: ['batch_completed'] }).length;
    const executed = await invokeParent({ action: 'execute', pending_action_id: pending.id });
    assert.match(executed.content[0]?.text ?? '', /5\/5 succeeded, 0 failed/);
    const phaseWrites = providerObservations
      .filter((row) => row.slug === CREATE_DRAFT)
      .slice(writesBeforeCommit);
    assert.equal(phaseWrites.length, 5, `${phase}: parent commit made exactly five draft writes`);
    assert.ok(phaseWrites.every((row) => row.connectedAccountId === expectedConnectionId));
    assert.ok(phaseWrites.every((row) => row.certifiedBatch && row.batchItem));

    const completed = listEvents(session.id, { types: ['batch_completed'] }).slice(completedBefore);
    assert.equal(completed.length, 1, `${phase}: exactly one batch completed`);
    assert.equal(completed[0].data.total, 5);
    assert.equal(completed[0].data.succeeded, 5);
    assert.equal(completed[0].data.failed, 0);
    assert.equal(completed[0].data.halted, false);
    const ledger = readBatchLedger(String(completed[0].data.batchId));
    assert.ok(ledger, `${phase}: durable batch ledger exists`);
    assert.equal(ledger.total, 5);
    assert.equal(ledger.succeeded, 5);
    assert.equal(ledger.failed, 0);
    assert.equal(ledger.halted, false);
    assert.equal(ledger.outcomes.length, 5);
    assert.deepEqual(
      ledger.outcomes.map((outcome) => outcome.id),
      expected.map((fixture) => fixture.id),
      `${phase}: every composed item has one matching durable receipt`,
    );
    assert.ok(ledger.outcomes.every((outcome) => outcome.ok && outcome.attempts === 1 && !outcome.deduped));
    for (const outcome of ledger.outcomes) {
      assert.match(
        outcome.resultPreview ?? '',
        new RegExp(`provider-${outcome.id}`),
        `${phase}: ${outcome.id} receipt carries its provider draft id`,
      );
    }
    assert.equal(getPendingAction(pending.id)?.status, 'executed');

    const read = await withHarnessRunContext(
      {
        sessionId: session.id,
        behaviorScopeId: `${session.id}:${phase}:readback`,
        sourceUserSeq: source.seq,
        counter: new ToolCallsCounter(100),
      },
      () => dispatchComposioTool(
        LIST_DRAFTS,
        { account_alias: ACCOUNT_ALIAS },
        { sessionId: session.id },
      ),
    );
    assert.equal(read.ok, true, `${phase}: exact mailbox readback succeeded`);
    if (!read.ok) throw new Error(read.message);
    assert.equal(read.connectionId, expectedConnectionId);
    assert.equal(read.identity, MAILBOX);
    const returned = (read.result as { data?: { drafts?: StoredDraft[] } }).data?.drafts ?? [];
    assert.deepEqual(canonicalDrafts(returned), canonicalDrafts(expectedReadback));
    return ledger;
  };

  const beforeExpected = fixtures('before').map((fixture) => ({
    id: `provider-${fixture.id}`,
    ...fixture.args,
  }));
  await runPhase('before', BEFORE_CONNECTION, beforeExpected);
  assert.deepEqual(runBatchCalls, ['propose', 'execute'], 'first phase used one logical parent batch');

  // Re-auth rotates only the opaque provider identity. The remembered alias
  // remains bound to the stable mailbox and must follow it without rewriting.
  liveConnectionId = AFTER_CONNECTION;
  composioClientTest.setConnectedAccountsLoader(loadAccounts);
  const afterExpected = fixtures('after').map((fixture) => ({
    id: `provider-${fixture.id}`,
    ...fixture.args,
  }));
  await runPhase(
    'after',
    AFTER_CONNECTION,
    [...beforeExpected, ...afterExpected],
  );

  assert.deepEqual(
    runBatchCalls,
    ['propose', 'execute', 'propose', 'execute'],
    'each connection generation used exactly one proposal and one commit',
  );
  const writes = providerObservations.filter((row) => row.slug === CREATE_DRAFT);
  assert.equal(writes.length, 10);
  assert.equal(writes.filter((row) => row.connectedAccountId === BEFORE_CONNECTION).length, 5);
  assert.equal(writes.filter((row) => row.connectedAccountId === AFTER_CONNECTION).length, 5);
  assert.equal(
    writes.filter((row) => !row.certifiedBatch || !row.batchItem).length,
    0,
    'zero direct provider-write fallback occurred',
  );
  assert.equal(sends.length, 0, 'no send-class action crossed the provider boundary');
  assert.equal(
    listEvents(session.id, { types: ['guardrail_tripped'] })
      .filter((event) => event.data.reason === 'worker-compose-only').length,
    10,
    'five worker write refusals were repeated after connection rotation',
  );
  const unrelatedGuardrailFailures = listEvents(session.id, { types: ['guardrail_tripped'] })
    .filter((event) => event.data.reason !== 'worker-compose-only')
    // The third distinct compose attempt produces the existing non-blocking
    // fan-out/same-mut-tool advisory. It is telemetry, not a refusal or failed
    // action, so keep it visible while excluding it from the failure set.
    .filter((event) => event.data.kind !== 'fanout_nudge')
    .filter((event) => !(event.data.kind === 'tool_call_guardrail' && event.data.action === 'warn'));
  assert.deepEqual(
    unrelatedGuardrailFailures,
    [],
    'no guardrail other than the worker boundary refused or failed this acceptance',
  );
  assert.equal(
    listEvents(session.id, { types: ['batch_item_failed'] }).length,
    0,
    'no batch item emitted failure evidence',
  );
  assert.ok(
    listEvents(session.id, { types: ['batch_completed'] })
      .every((event) => event.data.failed === 0 && event.data.halted === false),
    'every completed batch is a non-halted 5/5 result',
  );
});

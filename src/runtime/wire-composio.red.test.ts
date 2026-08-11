/**
 * RED — the Composio dispatch lane's SETTLEMENT seam.
 *
 * Run: npx tsx --test src/runtime/wire-composio.red.test.ts
 *
 * Every test below enters real production dispatch code:
 *   - `runComposioExecute` (src/tools/composio-tools.ts:2586), through the
 *     public `runComposioExecuteWithGatewayForTest` twin (:2979) so the REAL
 *     gateway runs: `resolveComposioDispatch` → `ensureToolSchema` →
 *     `validateComposioArgs` → provider dispatch → settlement.
 *   - `dispatchComposioTool` (:2438), the one-shot gateway that workflow
 *     exact-call steps, Space sources/actions and batch helpers use.
 *
 * The invariant under test is one sentence: ONE physical attempt produces
 * exactly ONE durable settlement, and that settlement can be tied back to the
 * physical attempt it describes.
 *
 * Fixtures are the fictional alpha/beta toolkits. Nothing here names a real
 * vendor, because nothing in the fix may branch on one.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wire-composio-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
// SDK lane with a key present: the CLI-only branches are not what is under
// test, and a keyless install would divert to runtime-status probes.
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.COMPOSIO_API_KEY = 'wire-composio-red-test-key';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'm\n', 'utf-8');

const eventlog = await import('./harness/eventlog.js');
const { recordTurnGraphShadow } = await import('./graph/turn-graph-shadow.js');
const { harnessRunContextStorage, ToolCallsCounter } = await import('./harness/brackets.js');
const {
  settleToolAttempt,
  ToolAttemptSettlementAuthorityError,
  _resetAttemptSettlementStateForTests,
} = await import('./harness/attempt-settlement.js');
const {
  runComposioExecuteWithGatewayForTest,
  dispatchComposioTool,
} = await import('../tools/composio-tools.js');
const {
  ensureToolSchema,
  resetToolSchemaCache,
  _setToolSchemaLoaderForTests,
} = await import('../tools/composio-schema-cache.js');
const { __test__, resetComposioClient } = await import('../integrations/composio/client.js');

test.after(() => {
  __test__.setConnectedAccountsLoader(null);
  _setToolSchemaLoaderForTests(null);
  resetComposioClient();
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

interface AcceptedTask { sessionId: string; sourceUserSeq: number }

let taskCounter = 0;

function acceptedTask(label: string): AcceptedTask {
  taskCounter += 1;
  const session = eventlog.createSession({ id: `wire-composio-${label}-${taskCounter}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `${label}: do the alpha work` },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }), 'fixture precondition: the accepted task has its exact durable graph');
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

/** Durable settlements bound to THIS accepted task. */
function settlementsFor(task: AcceptedTask): Array<Record<string, unknown>> {
  return eventlog.listEvents(task.sessionId, { types: ['tool_attempt_settled'] })
    .map((event) => (event.data ?? {}) as Record<string, unknown>)
    .filter((data) => data.sourceUserSeq === task.sourceUserSeq);
}

function alphaAccount(id: string, email: string): Record<string, unknown> {
  return { id, toolkit: { slug: 'alpha' }, status: 'ACTIVE', data: { user_info: { email } } };
}

function setAccounts(items: Array<Record<string, unknown>>): void {
  __test__.setConnectedAccountsLoader(async () => items);
}

const ALPHA_READ = 'ALPHA_LIST_RECORDS';
const ALPHA_WRITE = 'ALPHA_CREATE_RECORD';
const ALPHA_SEND = 'ALPHA_SEND_EMAIL';

/** An open contract: nothing required, so validation passes and dispatch runs. */
const OPEN_CONTRACT = {
  inputParameters: {
    type: 'object',
    required: [] as string[],
    properties: { query: { type: 'string' }, title: { type: 'string' } },
  },
  providerObservedAt: Date.now(),
};

/** The provider's real contract for the write: `title` is REQUIRED. */
const REQUIRED_TITLE_CONTRACT = {
  inputParameters: {
    type: 'object',
    required: ['title'],
    properties: { title: { type: 'string' }, notes: { type: 'string' } },
  },
  providerObservedAt: Date.now(),
};

const REQUIRED_RECIPIENT_CONTRACT = {
  inputParameters: {
    type: 'object',
    required: ['to_email', 'subject', 'body'],
    properties: {
      to_email: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
  },
  providerObservedAt: Date.now(),
};

interface LaneRow {
  name: string;
  slug: string;
  args: Record<string, unknown>;
  contract: unknown;
  accounts: Array<Record<string, unknown>>;
  workerScope?: boolean;
  provider: (slug: string, args: Record<string, unknown>) => Promise<unknown>;
  /** How many times the provider boundary may be crossed. */
  expectDispatches: number;
  /** What the durable settlement must say about the boundary. */
  expectDispatchState: 'not_started' | 'dispatched';
  /** May this attempt read as a completed call? */
  expectSucceeded: boolean;
  /**
   * Proof the lane took the branch this row is about. Asserted FIRST, so a
   * fixture that accidentally refused for some other reason fails loudly here
   * instead of masquerading as the settlement defect under test.
   */
  expectOutput: RegExp;
  /** Why this row exists, in the failure message. */
  because: string;
}

const ROWS: LaneRow[] = [
  {
    name: 'success — a read that crossed the boundary and came back with data',
    slug: ALPHA_READ,
    args: { query: 'open records' },
    contract: OPEN_CONTRACT,
    accounts: [alphaAccount('ca_alpha_one', 'owner@alpha.example')],
    provider: async () => ({ successful: true, data: { records: [{ id: 'rec-1' }, { id: 'rec-2' }] } }),
    expectDispatches: 1,
    expectDispatchState: 'dispatched',
    expectSucceeded: true,
    expectOutput: /"successful": true[\s\S]*rec-1/,
    because: 'a completed read is one physical attempt with one settlement',
  },
  {
    name: 'invalid arguments — refused before dispatch by the action contract',
    slug: ALPHA_WRITE,
    args: { notes: 'no title supplied', connected_account_id: 'ca_alpha_one' },
    contract: REQUIRED_TITLE_CONTRACT,
    accounts: [alphaAccount('ca_alpha_one', 'owner@alpha.example')],
    provider: async () => {
      throw new Error('the provider must never be reached for an invalid-argument refusal');
    },
    expectDispatches: 0,
    expectDispatchState: 'not_started',
    expectSucceeded: false,
    expectOutput: /provider-dispatch:not-started:invalid-args[\s\S]*this attempt never dispatched/,
    because: 'a pre-dispatch refusal is an attempt outcome, not a silent absence',
  },
  {
    name: 'policy refusal — a compose-only worker may not commit an external write',
    slug: ALPHA_WRITE,
    args: { title: 'composed by a worker' },
    contract: OPEN_CONTRACT,
    accounts: [alphaAccount('ca_alpha_one', 'owner@alpha.example')],
    workerScope: true,
    provider: async () => {
      throw new Error('the provider must never be reached for a policy refusal');
    },
    expectDispatches: 0,
    expectDispatchState: 'not_started',
    expectSucceeded: false,
    expectOutput: /provider-dispatch:not-started:worker-compose-only/,
    because: 'a scope refusal that settles nothing leaves the task holding a spent budget and no reason',
  },
  {
    name: 'account refusal — two live alpha accounts, so the route is not decidable',
    slug: ALPHA_READ,
    args: { query: 'open records' },
    contract: OPEN_CONTRACT,
    accounts: [
      alphaAccount('ca_alpha_work', 'work@alpha.example'),
      alphaAccount('ca_alpha_home', 'home@alpha.example'),
    ],
    provider: async () => {
      throw new Error('the provider must never be reached for an ambiguous-account refusal');
    },
    expectDispatches: 0,
    expectDispatchState: 'not_started',
    expectSucceeded: false,
    expectOutput: /provider-dispatch:not-started:ambiguous-account/,
    because: 'an ambiguity block is a refusal with a typed reason; losing it makes the retry unaccountable',
  },
  {
    name: 'provider-returned failure — the envelope says it did not work',
    slug: ALPHA_READ,
    args: { query: 'open records' },
    contract: OPEN_CONTRACT,
    accounts: [alphaAccount('ca_alpha_one', 'owner@alpha.example')],
    provider: async () => ({ successful: false, data: { message: 'alpha rejected the request' } }),
    expectDispatches: 1,
    expectDispatchState: 'dispatched',
    expectSucceeded: false,
    expectOutput: /alpha rejected the request/,
    because: 'a returned failure must settle as a failure, never as a completed call',
  },
  {
    name: 'thrown error — the write threw after crossing the boundary',
    slug: ALPHA_WRITE,
    args: { title: 'a record that may or may not exist now' },
    contract: OPEN_CONTRACT,
    accounts: [alphaAccount('ca_alpha_one', 'owner@alpha.example')],
    provider: async () => {
      throw new Error('alpha upstream closed the connection mid-write');
    },
    expectDispatches: 1,
    expectDispatchState: 'dispatched',
    expectSucceeded: false,
    expectOutput: /provider-dispatch:uncertain[\s\S]*alpha upstream closed the connection mid-write/,
    because: 'a mutation that threw is uncertain, and uncertainty has to be recorded once',
  },
];

async function runRow(row: LaneRow): Promise<{ task: AcceptedTask; dispatches: number; output: string }> {
  _resetAttemptSettlementStateForTests();
  resetToolSchemaCache();
  _setToolSchemaLoaderForTests(async () => row.contract as never);
  setAccounts(row.accounts);
  const task = acceptedTask(row.name.split(' ')[0] ?? 'row');

  let dispatches = 0;
  const provider = (async (slug: string, args: Record<string, unknown>) => {
    dispatches += 1;
    return row.provider(slug, args);
  }) as never;

  const output = await harnessRunContextStorage.run(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: 1,
      counter: new ToolCallsCounter(50),
      ...(row.workerScope ? { workerScope: true } : {}),
    },
    () => runComposioExecuteWithGatewayForTest(row.slug, { ...row.args }, provider, task.sessionId),
  );
  // The lane settles from an unawaited learning call; give the microtask queue
  // one turn so a settlement that DOES happen is never missed by the read.
  await new Promise((resolve) => setTimeout(resolve, 25));
  return { task, dispatches, output: String((output as { output?: string })?.output ?? output) };
}

// ── the shared dispatch boundary, row by row ────────────────────────────────

for (const row of ROWS) {
  test(`composio dispatch lane — ${row.name}`, async () => {
    const { task, dispatches, output } = await runRow(row);
    const settled = settlementsFor(task);

    // FIXTURE PROOF — this row really took the branch it names.
    assert.match(
      output,
      row.expectOutput,
      `${row.slug}: the lane did not take the branch this row is about; it returned:\n${output.slice(0, 400)}`,
    );
    assert.equal(
      dispatches,
      row.expectDispatches,
      `${row.slug}: the provider boundary must be crossed exactly ${row.expectDispatches} time(s)`,
    );

    // 1. Exactly ONE durable settlement per logical call (including a refusal).
    assert.equal(
      settled.length,
      1,
      `${row.slug}: one logical call must produce exactly ONE durable settlement — ${row.because}; `
      + `observed ${settled.length}: ${JSON.stringify(settled.map((s) => ({ kind: s.kind, dispatchState: s.dispatchState })))}`,
    );

    // 2/3. The settlement says whether the boundary was crossed.
    assert.equal(
      settled[0]!.dispatchState,
      row.expectDispatchState,
      `${row.slug}: the settlement must record dispatchState '${row.expectDispatchState}' so a `
      + `${row.expectDispatchState === 'not_started' ? 'refusal can never read as a completed call' : 'boundary crossing is visible to recovery'}`,
    );

    // 4. A provider-returned failure never settles as success.
    if (!row.expectSucceeded) {
      assert.notEqual(
        settled[0]!.kind,
        'succeeded',
        `${row.slug}: ${row.because}`,
      );
    } else {
      assert.equal(settled[0]!.kind, 'succeeded', `${row.slug}: a completed read settles as succeeded`);
    }

    // 6. Every settlement has a logical owner. Only a call that actually
    // crossed the provider boundary may carry a physical dispatch id.
    assert.equal(
      typeof settled[0]!.logicalToolCallId,
      'string',
      `${row.slug}: the settlement carries no logicalToolCallId: ${JSON.stringify(settled[0])}`,
    );
    if (row.expectDispatches === 0) {
      assert.equal(settled[0]!.physicalDispatchId, undefined, 'a refusal cannot invent provider I/O');
      assert.equal(settled[0]!.physicalAttemptId, undefined, 'the compatibility alias cannot lie either');
    } else {
      assert.equal(typeof settled[0]!.physicalDispatchId, 'string', 'a crossing names its durable dispatch');
      assert.notEqual(settled[0]!.physicalDispatchId, settled[0]!.logicalToolCallId);
    }

    const logical = eventlog.openEventLog().prepare(`
      SELECT accepted_task_id, logical_tool_call_id, tool_name, argument_digest, state,
             (SELECT COUNT(*) FROM physical_dispatches p
               WHERE p.session_id = l.session_id
                 AND p.source_user_seq = l.source_user_seq
                 AND p.logical_tool_call_id = l.logical_tool_call_id) AS crossings
        FROM logical_tool_calls l
       WHERE session_id = ? AND source_user_seq = ?
    `).all(task.sessionId, task.sourceUserSeq) as Array<Record<string, unknown>>;
    assert.deepEqual(logical, [{
      accepted_task_id: `task:${task.sessionId}#${task.sourceUserSeq}`,
      logical_tool_call_id: settled[0]!.logicalToolCallId,
      tool_name: row.slug.toLowerCase(),
      argument_digest: logical[0]?.argument_digest,
      state: 'settled',
      crossings: row.expectDispatches,
    }], 'the carrier and inner provider call must conserve one accepted-source logical contract');
    assert.equal(String(logical[0]?.argument_digest).length, 64, 'only the canonical digest is durable');
  });
}

test('composio trusted resolver refines routing metadata once before the paid crossing', async () => {
  _resetAttemptSettlementStateForTests();
  resetToolSchemaCache();
  _setToolSchemaLoaderForTests(async () => OPEN_CONTRACT as never);
  setAccounts([alphaAccount('ca_alpha_one', 'owner@alpha.example')]);
  const task = acceptedTask('resolved-contract');
  let providerArgs: Record<string, unknown> | undefined;

  const output = await harnessRunContextStorage.run(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: 1,
      counter: new ToolCallsCounter(50),
    },
    () => runComposioExecuteWithGatewayForTest(
      ALPHA_READ,
      { query: 'routed records', connected_account_id: 'ca_alpha_one' },
      async (_slug, args) => {
        providerArgs = args;
        return { successful: true, data: { records: [] } };
      },
      task.sessionId,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(providerArgs, { query: 'routed records' }, 'routing-only metadata never reaches the provider');

  const logical = eventlog.openEventLog().prepare(`
    SELECT argument_digest, raw_argument_digest, effective_argument_digest
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as {
    argument_digest: string;
    raw_argument_digest: string;
    effective_argument_digest: string;
  };
  assert.notEqual(logical.raw_argument_digest, logical.effective_argument_digest);
  assert.equal(logical.argument_digest, logical.effective_argument_digest);
  assert.deepEqual(eventlog.openEventLog().prepare(`
    SELECT argument_digest FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq), {
    argument_digest: logical.effective_argument_digest,
  });
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['logical_call_contract_refined'] }).length,
    1,
  );
});

test('composio replacement repair settles against the effective object, not the stale raw object', async () => {
  _resetAttemptSettlementStateForTests();
  resetToolSchemaCache();
  _setToolSchemaLoaderForTests(async () => REQUIRED_RECIPIENT_CONTRACT as never);
  await ensureToolSchema(ALPHA_SEND);
  setAccounts([alphaAccount('ca_alpha_one', 'owner@alpha.example')]);
  const task = acceptedTask('replacement-repair');
  let providerArgs: Record<string, unknown> | undefined;

  const output = await harnessRunContextStorage.run(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: 1,
      counter: new ToolCallsCounter(50),
    },
    () => runComposioExecuteWithGatewayForTest(
      ALPHA_SEND,
      { to: 'recipient@alpha.example', subject: 'Grounded update', body: 'The exact result.' },
      async (_slug, args) => {
        providerArgs = args;
        return { successful: true, data: { id: 'message-1' } };
      },
      task.sessionId,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(providerArgs, {
    to_email: 'recipient@alpha.example',
    subject: 'Grounded update',
    body: 'The exact result.',
  }, `the trusted schema repair replaced, rather than mutated, the raw object; output=${String(output).slice(0, 500)}`);
  const [settled] = settlementsFor(task);
  assert.equal(settled?.kind, 'succeeded');
  const logical = eventlog.openEventLog().prepare(`
    SELECT argument_digest, raw_argument_digest, effective_argument_digest
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as {
    argument_digest: string;
    raw_argument_digest: string;
    effective_argument_digest: string;
  };
  assert.notEqual(logical.raw_argument_digest, logical.effective_argument_digest);
  assert.equal(logical.argument_digest, logical.effective_argument_digest);
  assert.deepEqual(eventlog.openEventLog().prepare(`
    SELECT argument_digest FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq), {
    argument_digest: logical.effective_argument_digest,
  });
});

// ── the one-shot gateway used by workflow / Space / batch ───────────────────

test('composio one-shot gateway — a successful dispatchComposioTool call settles once', async () => {
  _resetAttemptSettlementStateForTests();
  resetToolSchemaCache();
  _setToolSchemaLoaderForTests(async () => OPEN_CONTRACT as never);
  setAccounts([alphaAccount('ca_alpha_one', 'owner@alpha.example')]);
  const task = acceptedTask('oneshot-success');

  let dispatches = 0;
  __test__.setComposioClient({
    tools: {
      execute: async () => {
        dispatches += 1;
        return { successful: true, data: { records: [{ id: 'rec-1' }] } };
      },
    },
  });

  try {
    const result = await harnessRunContextStorage.run(
      {
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        turn: 1,
        counter: new ToolCallsCounter(50),
      },
      () => dispatchComposioTool(ALPHA_READ, { query: 'open records' }, { sessionId: task.sessionId }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(result.ok, true, 'the fixture must reach the provider so this is a real boundary crossing');
    assert.equal(dispatches, 1, 'the one-shot gateway dispatches exactly once');

    const settled = settlementsFor(task);
    assert.equal(
      settled.length,
      1,
      'dispatchComposioTool is the front door for workflow exact-call steps, Space actions and batch '
      + 'helpers, and it calls executeComposioTool directly — a completed external call on that lane '
      + `must still settle exactly once; observed ${settled.length}`,
    );
    assert.equal(settled[0]!.dispatchState, 'dispatched', 'a boundary-crossing attempt records dispatched');
    assert.equal(
      typeof settled[0]!.physicalAttemptId,
      'string',
      'and it carries the physical attempt it describes',
    );
  } finally {
    resetComposioClient();
  }
});

test('composio one-shot gateway — a provider-returned failure settles before rendering', async () => {
  _resetAttemptSettlementStateForTests();
  resetToolSchemaCache();
  _setToolSchemaLoaderForTests(async () => OPEN_CONTRACT as never);
  setAccounts([alphaAccount('ca_alpha_one', 'owner@alpha.example')]);
  const task = acceptedTask('oneshot-failure');

  let dispatches = 0;
  __test__.setComposioClient({
    tools: {
      execute: async () => {
        dispatches += 1;
        return { successful: false, data: { message: 'alpha rejected the request' } };
      },
    },
  });

  try {
    let thrown: unknown;
    await harnessRunContextStorage.run(
      {
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        turn: 1,
        counter: new ToolCallsCounter(50),
      },
      async () => {
        try {
          await dispatchComposioTool(ALPHA_WRITE, { title: 'a record' }, { sessionId: task.sessionId });
        } catch (err) {
          thrown = err;
        }
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(dispatches, 1, 'the write crossed the provider boundary exactly once');
    assert.ok(thrown instanceof Error, 'the one-shot gateway converts the failure envelope into a throw');

    const settled = settlementsFor(task);
    assert.equal(
      settled.length,
      1,
      'the failure of an external WRITE on the workflow/Space/batch lane must be settled exactly once — '
      + `it is thrown as an Error and nothing durable records it; observed ${settled.length}`,
    );
    assert.notEqual(settled[0]!.kind, 'succeeded', 'a returned failure never settles as success');
    assert.equal(settled[0]!.dispatchState, 'dispatched', 'the boundary was crossed, so say so');
  } finally {
    resetComposioClient();
  }
});

// ── transport mirrors must not inflate the ledger ───────────────────────────

test('composio dispatch lane — a transport mirror of one attempt adds ZERO extra settlements', async () => {
  const { withLogicalToolCall } = await import('./harness/attempt-identity.js');
  const row = ROWS[0]!;

  _resetAttemptSettlementStateForTests();
  resetToolSchemaCache();
  _setToolSchemaLoaderForTests(async () => row.contract as never);
  setAccounts(row.accounts);
  const task = acceptedTask('mirror');

  let dispatches = 0;
  const provider = (async (slug: string, args: Record<string, unknown>) => {
    dispatches += 1;
    return row.provider(slug, args);
  }) as never;

  // Production shape: the OUTER carrier holds one physical attempt open across
  // both the inner lane and its own post-return settlement. Two wrappers, one
  // identity — the only thing that can make the mirror a duplicate rather than
  // a second event. This must not pass because the mirror classifies as
  // `unknown`; unknown outcomes now settle honestly.
  let sharedAttempt = '';
  let beforeMirror = 0;
  let mirrorError: unknown;

  await harnessRunContextStorage.run(
    {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: 1,
      counter: new ToolCallsCounter(50),
    },
    () => withLogicalToolCall(
      {
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        tool: row.slug,
        args: row.args,
      },
      async (identity) => {
        sharedAttempt = identity.logicalToolCallId;
        await runComposioExecuteWithGatewayForTest(
          row.slug, { ...row.args }, provider, task.sessionId,
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
        beforeMirror = settlementsFor(task).length;

        try {
          settleToolAttempt({
            sessionId: task.sessionId,
            sourceUserSeq: task.sourceUserSeq,
            turn: 1,
            lane: 'agents_runner',
            toolName: 'composio_execute_tool',
            callId: 'carrier-call-1',
            args: { tool_slug: ALPHA_READ, arguments: { query: 'open records' } },
            mutating: false,
            businessCall: true,
            result: 'rendered by the inner lane',
          });
        } catch (error) {
          mirrorError = error;
        }
      },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(dispatches, 1, 'the read crossed the boundary once');
  assert.ok(
    mirrorError instanceof ToolAttemptSettlementAuthorityError
      && mirrorError.status === 'conflict',
    'a carrier that contradicts the already-settled provider outcome must fail closed',
  );
  const settled = settlementsFor(task);
  assert.equal(
    settled.length,
    beforeMirror,
    `a carrier re-settling the same physical attempt must add nothing: ${beforeMirror} -> ${settled.length}`,
  );
  assert.equal(
    settled[0]?.logicalToolCallId,
    sharedAttempt,
    'and the one settlement must carry the LOGICAL call both wrappers shared',
  );
});

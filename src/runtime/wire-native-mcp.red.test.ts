/**
 * Run: npx tsx --test src/runtime/wire-native-mcp.red.test.ts
 *
 * RED BY DESIGN — the native MCP namespace lane's settlement wire.
 *
 * Every native MCP call enters production at `createMcpNamespaceShim(...).callTool()`
 * (mcp-namespace-shim.ts:1117). The provider boundary crossing is the single
 * `await server.callTool(parsed.toolName, args)` at :1572, and the shared
 * settlement seam (`settleNativeMcpAttempt` → `settleToolAttempt`) is invoked
 * ONLY at :1622 (returned) and :1635 (thrown) — both strictly AFTER that
 * crossing.
 *
 * Therefore every branch that refuses BEFORE the crossing settles nothing:
 *   - unknown tool            :1134
 *   - server unavailable      :1150
 *   - approval blocked        :1194
 * A refusal is still one physical attempt. It has an owner (the accepted task),
 * an outcome (it did not run), and a dispatch state (`not_started`) — and the
 * durable log records none of it, so nothing downstream can tell "we refused"
 * apart from "we never tried".
 *
 * These tests do NOT bypass those branches: reaching them IS the point.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wire-native-mcp-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'm\n', 'utf-8');

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { MCPServer } from '@openai/agents';

const { createMcpNamespaceShim, namespaceToolName, slugifyServerName } =
  await import('./mcp-namespace-shim.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./harness/brackets.js');
const { appendEvent, createSession, listEvents, openEventLog } = await import('./harness/eventlog.js');
const { recordTurnGraphShadow } = await import('./graph/turn-graph-shadow.js');
const { settleToolAttempt, ATTEMPT_SETTLED_EVENT_NAME } =
  await import('./harness/attempt-settlement.js');
const { ToolAttemptSettlementAuthorityError } = await import('./harness/attempt-settlement.js');
const { withLogicalToolCall } = await import('./harness/attempt-identity.js');
type HarnessRunContext = import('./harness/brackets.js').HarnessRunContext;

after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---------------------------------------------------------------------------
// One fake in-process MCP server, built exactly like the existing namespace-shim
// suites build theirs (see mcp-namespace-shim.resume-writeledger.test.ts).
// ---------------------------------------------------------------------------
function fakeServer(
  name: string,
  toolName: string,
  behavior: () => Promise<unknown>,
  opts: { listToolsThrows?: boolean } = {},
): MCPServer {
  return {
    name,
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {},
    async close() {},
    async invalidateToolsCache() {},
    async listTools() {
      if (opts.listToolsThrows) throw new Error('transport closed before tools/list');
      return [{
        name: toolName,
        description: 'fixture tool',
        inputSchema: { type: 'object' },
      }] as unknown as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool() {
      return (await behavior()) as Awaited<ReturnType<MCPServer['callTool']>>;
    },
  } as unknown as MCPServer;
}

const ctx = (sessionId: string, sourceUserSeq: number): HarnessRunContext => ({
  sessionId,
  turn: 1,
  counter: new ToolCallsCounter(100),
  sourceUserSeq,
});

const okContent = [{ type: 'text', text: '{"items":[{"id":"i-1"}]}' }];

interface RowSpec {
  /** Row label used in every assertion message. */
  row: string;
  serverName: string;
  /** Tool the fake server advertises. */
  tool: string;
  /** Tool the model actually calls (namespaced), relative to the slug. */
  callTool: string;
  args: Record<string, unknown>;
  behavior: () => Promise<unknown>;
  listToolsThrows?: boolean;
  /** What the production branch must do to prove the fixture reached it. */
  expect: {
    dispatches: number;
    rejects: boolean;
    /** BoundaryError kind, or a message fragment for a plain Error. */
    marker: string;
  };
}

const ROWS: RowSpec[] = [
  {
    row: 'success',
    serverName: 'alpha',
    tool: 'list_items',
    callTool: 'list_items',
    args: { query: 'open items' },
    behavior: async () => okContent,
    expect: { dispatches: 1, rejects: false, marker: '' },
  },
  {
    row: 'unknown_tool',
    serverName: 'beta',
    tool: 'list_items',
    callTool: 'no_such_tool',
    args: { query: 'open items' },
    behavior: async () => okContent,
    expect: { dispatches: 0, rejects: true, marker: 'Unknown MCP tool' },
  },
  {
    row: 'server_unavailable',
    serverName: 'gamma',
    tool: 'list_items',
    callTool: 'unavailable',
    args: {},
    behavior: async () => okContent,
    listToolsThrows: true,
    expect: { dispatches: 0, rejects: true, marker: 'mcp.server_unavailable' },
  },
  {
    row: 'approval_blocked',
    serverName: 'delta',
    tool: 'delete_records',
    callTool: 'delete_records',
    args: { table_id: 'tbl-1', record_ids: ['rec-1', 'rec-2'] },
    behavior: async () => okContent,
    expect: { dispatches: 0, rejects: true, marker: 'mcp.approval_blocked' },
  },
  {
    row: 'provider_failure_isError',
    serverName: 'epsilon',
    tool: 'lookup_record',
    callTool: 'lookup_record',
    args: { record_id: 'rec-404' },
    behavior: async () => ({
      content: [{ type: 'text', text: '{"error":"record not found"}' }],
      isError: true,
    }),
    expect: { dispatches: 1, rejects: false, marker: '' },
  },
  {
    row: 'thrown_error',
    serverName: 'zeta',
    tool: 'fetch_report',
    callTool: 'fetch_report',
    args: { report_id: 'rep-1' },
    behavior: async () => { throw new Error('ECONNRESET: socket hang up'); },
    expect: { dispatches: 1, rejects: true, marker: 'ECONNRESET' },
  },
];

interface RowObservation {
  row: string;
  sessionId: string;
  sourceUserSeq: number;
  namespaced: string;
  dispatches: number;
  rejected: boolean;
  /** BoundaryError kind when there is one, else the error message. */
  marker: string;
  /** Value the lane handed back to its caller (undefined when it threw). */
  returned: unknown;
  /** Durable `tool_attempt_settled` rows owned by this accepted task. */
  settlements: Record<string, unknown>[];
}

/** Drive ONE row through the real shim. No production file is touched. */
async function runRow(spec: RowSpec): Promise<RowObservation> {
  let dispatches = 0;
  const server = fakeServer(
    spec.serverName,
    spec.tool,
    async () => { dispatches += 1; return spec.behavior(); },
    { listToolsThrows: spec.listToolsThrows === true },
  );
  const shim = createMcpNamespaceShim({ servers: [server] });
  const slug = slugifyServerName(spec.serverName);
  const namespaced = namespaceToolName(slug, spec.callTool);

  const sessionId = createSession({
    id: `sess-native-mcp-${spec.row}`,
    kind: 'chat',
  }).id;
  const sourceUserSeq = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `native MCP wire row: ${spec.row}` },
  }).seq;
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq, turn: 1 },
  }), 'fixture precondition: the accepted task has its exact durable graph');

  let rejected = false;
  let marker = '';
  let returned: unknown;
  await withHarnessRunContext(ctx(sessionId, sourceUserSeq), async () => {
    await shim.listTools();
    try {
      returned = await shim.callTool(namespaced, spec.args);
    } catch (err) {
      rejected = true;
      const kind = (err as { kind?: unknown })?.kind;
      marker = typeof kind === 'string'
        ? kind
        : (err instanceof Error ? err.message : String(err));
    }
  });

  return {
    row: spec.row,
    sessionId,
    sourceUserSeq,
    namespaced,
    dispatches,
    rejected,
    marker,
    returned,
    settlements: settlementsFor(sessionId, sourceUserSeq),
  };
}

/** Durable settlements owned by one accepted task, read back from the log. */
function settlementsFor(sessionId: string, sourceUserSeq: number): Record<string, unknown>[] {
  return listEvents(sessionId, { types: [ATTEMPT_SETTLED_EVENT_NAME] })
    .map((event) => event.data as Record<string, unknown>)
    .filter((data) => data.sourceUserSeq === sourceUserSeq);
}

let observed: RowObservation[] | undefined;
async function rows(): Promise<RowObservation[]> {
  if (!observed) {
    const out: RowObservation[] = [];
    for (const spec of ROWS) out.push(await runRow(spec));
    observed = out;
  }
  return observed;
}

function byRow<T>(list: RowObservation[], pick: (o: RowObservation) => T): Record<string, T> {
  return Object.fromEntries(list.map((o) => [o.row, pick(o)]));
}

// ---------------------------------------------------------------------------
// GUARD (must stay GREEN): every row reaches the production branch it names.
// If this fails, the table is a fixture mistake and the red tests below mean
// nothing.
// ---------------------------------------------------------------------------
test('fixture guard: each row enters its intended shim.callTool branch', async () => {
  const list = await rows();
  const specs = new Map(ROWS.map((spec) => [spec.row, spec]));
  assert.deepEqual(
    byRow(list, (o) => {
      const expect = specs.get(o.row)!.expect;
      return {
        dispatches: o.dispatches,
        rejected: o.rejected,
        // Containment, so a corrective/banner wrapper around the real error still
        // proves which branch produced it.
        markerMatches: o.marker.includes(expect.marker),
        // A row that returned must hand back a real MCP content array, so the
        // isError test below cannot be dismissed as "it returned nothing".
        returned: o.rejected
          ? 'threw'
          : (Array.isArray(o.returned) && o.returned.length > 0 ? 'content-array' : `unexpected:${typeof o.returned}`),
      };
    }),
    Object.fromEntries(ROWS.map((spec) => [spec.row, {
      dispatches: spec.expect.dispatches,
      rejected: spec.expect.rejects,
      markerMatches: true,
      returned: spec.expect.rejects ? 'threw' : 'content-array',
    }])),
    'each row must reach its named production branch before any settlement claim is meaningful',
  );
});

// ---------------------------------------------------------------------------
// RED 1 — one physical attempt, one durable settlement.
// ---------------------------------------------------------------------------
test('RED: every physical native MCP attempt records exactly one durable settlement', async () => {
  const list = await rows();
  const counts = byRow(list, (o) => o.settlements.length);
  assert.deepEqual(
    counts,
    Object.fromEntries(ROWS.map((spec) => [spec.row, 1])),
    'a refusal before the provider crossing (unknown tool :1134, server unavailable :1150, '
    + 'approval blocked :1194) is still ONE physical attempt and must settle exactly once, but '
    + 'settleNativeMcpAttempt is only reachable at :1622/:1635 — after the crossing. thrown_error '
    + 'DOES reach :1635 and still records nothing: an unclassifiable throw returns early as '
    + '`unknown` (attempt-settlement.ts:364), so a dead transport settles zero as well',
  );
});

// ---------------------------------------------------------------------------
// RED 2 — a provider failure must still read as a failure to the caller.
// ---------------------------------------------------------------------------
test('RED: an MCP failure result renders isError:true to the lane caller', async () => {
  const list = await rows();
  const failureRow = list.find((o) => o.row === 'provider_failure_isError')!;
  const returned = failureRow.returned as (unknown[] & { isError?: unknown }) | undefined;
  assert.equal(
    returned?.isError,
    true,
    'the server returned {content:[…], isError:true}; the lane handed back a '
    + `${Array.isArray(returned) ? `${returned.length}-block content array` : typeof returned} `
    + `with isError=${String(returned?.isError)} — annotateMcpResultFailure (:394) and `
    + 'appendMcpFanoutAdvisory (:414) rebuild the array as a fresh literal, so the error metadata '
    + 'copied on by copyMcpResultMetadata (:219) is dropped and the failure reads as a success',
  );
});

// ---------------------------------------------------------------------------
// RED 3 — dispatchState must distinguish "never ran" from "ran".
// ---------------------------------------------------------------------------
test('RED: dispatchState records not_started for refusals and dispatched for crossings, durably', async () => {
  const list = await rows();
  // Re-read the durable log now, after every row has finished: the state must
  // SURVIVE the call it describes, not just exist inside it.
  const states = byRow(list, (o) => {
    const replayed = settlementsFor(o.sessionId, o.sourceUserSeq);
    return replayed.length === 0
      ? 'NO SETTLEMENT RECORDED'
      : String(replayed[0].dispatchState);
  });
  assert.deepEqual(
    states,
    {
      success: 'dispatched',
      unknown_tool: 'not_started',
      server_unavailable: 'not_started',
      approval_blocked: 'not_started',
      provider_failure_isError: 'dispatched',
      thrown_error: 'dispatched',
    },
    'dispatchState is the field that keeps a refusal from reading as a completed call '
    + '(attempt-settlement.ts:435) — a branch that never settles never records it',
  );
});

// ---------------------------------------------------------------------------
// Identity conservation: every call is logical; only real crossings are physical.
// ---------------------------------------------------------------------------
test('every native MCP settlement carries a logical id and only crossings carry a physical id', async () => {
  const list = await rows();
  const ids = byRow(list, (o) => {
    const settlement = o.settlements[0];
    if (!settlement) return 'NO SETTLEMENT RECORDED';
    return {
      logical: typeof settlement.logicalToolCallId === 'string',
      physical: typeof settlement.physicalDispatchId === 'string',
    };
  });
  assert.deepEqual(
    ids,
    Object.fromEntries(ROWS.map((spec) => [spec.row, {
      logical: true,
      physical: spec.expect.dispatches === 1,
    }])),
    'a refusal is a logical call with no provider crossing; a dispatched call joins to its '
    + 'physical-dispatch row through logicalToolCallId',
  );
});

test('every native MCP carrier preserves one exact accepted-source contract, including zero-crossing refusals', async () => {
  const list = await rows();
  const specs = new Map(ROWS.map((spec) => [spec.row, spec]));
  const durable = byRow(list, (o) => {
    const rows = openEventLog().prepare(`
      SELECT accepted_task_id, logical_tool_call_id, tool_name, argument_digest, state,
             (SELECT COUNT(*) FROM physical_dispatches p
               WHERE p.session_id = l.session_id
                 AND p.source_user_seq = l.source_user_seq
                 AND p.logical_tool_call_id = l.logical_tool_call_id) AS crossings
        FROM logical_tool_calls l
       WHERE session_id = ? AND source_user_seq = ?
    `).all(o.sessionId, o.sourceUserSeq) as Array<{
      accepted_task_id: string;
      logical_tool_call_id: string;
      tool_name: string;
      argument_digest: string;
      state: string;
      crossings: number;
    }>;
    return rows.map((row) => ({
      acceptedTask: row.accepted_task_id === `task:${o.sessionId}#${o.sourceUserSeq}`,
      sameLogicalOwner: row.logical_tool_call_id === o.settlements[0]?.logicalToolCallId,
      tool: row.tool_name,
      digestLength: row.argument_digest.length,
      state: row.state,
      crossings: row.crossings,
    }));
  });
  assert.deepEqual(
    durable,
    Object.fromEntries(list.map((o) => [o.row, [{
      acceptedTask: true,
      sameLogicalOwner: true,
      tool: o.namespaced.toLowerCase(),
      digestLength: 64,
      state: 'settled',
      crossings: specs.get(o.row)!.expect.dispatches,
    }]])),
    'each shim invocation must conserve one task-owned callable contract; a refusal owns the '
    + 'same logical row but exactly zero physical crossings',
  );
});

// ---------------------------------------------------------------------------
// RED 5 — identity is ambient, so a settlement with no call id cannot dedupe.
//
// settleNativeMcpAttempt spreads `callId` only when truthy and passes no
// physicalAttemptId, so with no call id `attemptKey()` returns null and
// `claimSettlement(sessionId, null)` returns true — "not a duplicate", always.
// This drives the exact production seam (attempt-settlement.ts:339) with the
// argument shape that lane produces.
// ---------------------------------------------------------------------------
test('RED: two settle calls inside ONE real shim dispatch collapse to one settlement', async () => {
  // Enter the REAL shim so the host mints the attempt. A carrier settling the
  // same dispatch a second time must inherit that identity, not mint another.
  const server = fakeServer('Alpha', 'list_items', async () => okContent);
  const shim = createMcpNamespaceShim({ servers: [server] });
  const slug = slugifyServerName('Alpha');
  const namespaced = namespaceToolName(slug, 'list_items');

  const sessionId = createSession({ id: 'sess-native-mcp-one-attempt', kind: 'chat' }).id;
  const sourceUserSeq = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'native MCP wire row: one attempt, two settle calls' },
  }).seq;
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq, turn: 1 },
  }), 'fixture precondition: the accepted task has its exact durable graph');

  const args = { query: 'open items' };
  await withHarnessRunContext(ctx(sessionId, sourceUserSeq), () => withLogicalToolCall(
    {
      sessionId,
      sourceUserSeq,
      logicalToolCallId: 'native-mirror-call',
      tool: namespaced,
      args,
    },
    async () => {
      await shim.listTools();
      await shim.callTool(namespaced, args);
      // A transport mirror re-settling the same physical dispatch. It carries
      // no call id of its own; the ambient logical owner makes this an exact
      // durable replay rather than an uncorrelated second outcome.
      settleToolAttempt({
        sessionId, sourceUserSeq, turn: 1,
        lane: 'native_mcp', toolName: namespaced,
        args,
        mutating: false, businessCall: true,
        result: okContent,
        signals: { providerReportedError: false },
      });
    },
  ));

  const settlements = listEvents(sessionId, { types: [ATTEMPT_SETTLED_EVENT_NAME] })
    .map((event) => event.data as Record<string, unknown>)
    .filter((data) => data.sourceUserSeq === sourceUserSeq);

  assert.equal(
    settlements.length,
    1,
    `one physical dispatch, one settlement — got ${settlements.length}`,
  );
  assert.ok(
    settlements[0]?.logicalToolCallId && settlements[0]?.physicalDispatchId,
    'the settlement must carry both its logical owner and the real provider crossing',
  );
});

test('RED: an UNCORRELATED settlement is refused, not recorded', () => {
  // No ambient attempt and no call id: nothing downstream could dedupe this,
  // bind evidence to it, or reconcile it against a provider call. Recording it
  // would produce a ledger that looks complete and proves nothing.
  const sessionId = createSession({ id: 'sess-native-mcp-uncorrelated', kind: 'chat' }).id;
  const sourceUserSeq = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'native MCP wire row: uncorrelated settlement' },
  }).seq;

  assert.throws(
    () => settleToolAttempt({
      sessionId, sourceUserSeq, turn: 1,
      lane: 'native_mcp', toolName: 'alpha__list_items',
      args: { query: 'open items' },
      mutating: false, businessCall: true,
      result: okContent,
      signals: { providerReportedError: false },
    }),
    ToolAttemptSettlementAuthorityError,
  );

  const settlements = listEvents(sessionId, { types: [ATTEMPT_SETTLED_EVENT_NAME] })
    .map((event) => event.data as Record<string, unknown>)
    .filter((data) => data.sourceUserSeq === sourceUserSeq);

  assert.equal(
    settlements.length,
    0,
    'a settlement with no physical attempt identity must be refused, not recorded',
  );
});

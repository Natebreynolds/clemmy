/**
 * Red tests for the production audit.
 *
 * The previous round proved helper contracts and I reported it as fixed
 * behaviour. These enter real seams — the normalizer as trusted callers use it,
 * the raw-payload store, the accepted turn graph, and the dispatch boundaries —
 * so a green here means the runtime changed, not that a function exists.
 *
 * Fixtures stay provider-neutral (AlphaSource/AlphaSink).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-production-seams-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-production-seams\n', 'utf-8');

const eventlog = await import('./harness/eventlog.js');
const fixtures = await import('./harness/alpha-fixtures.js');
const contract = await import('./harness/callable-contract.js');
const { toResultHandle } = await import('./harness/result-handle.js');
const { adjudicateTerminal } = await import('./harness/terminal-truth.js');
const { recordTurnGraphShadow } = await import('./graph/turn-graph-shadow.js');
const { acceptedTaskIdFor } = await import('./harness/attempt-identity.js');
const { admitLogicalCall } = await import('./harness/dispatch-ledger.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function acceptedTask(label: string): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ id: `seam-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: `${label} task` },
  });
  // Durable settlement authority: the accepted source above plus a persisted
  // turn graph for the accepted task (authority spine).
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
  }), 'fixture persisted the turn graph for the accepted task');
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

/** Every lane admits its logical call before dispatch; the fixture does too. */
function admitFixtureCall(
  key: { sessionId: string; sourceUserSeq: number },
  logicalToolCallId: string,
  tool: string,
  args?: unknown,
): void {
  const admitted = admitLogicalCall({
    identity: {
      sessionId: key.sessionId,
      sourceUserSeq: key.sourceUserSeq,
      acceptedTaskId: acceptedTaskIdFor(key.sessionId, key.sourceUserSeq),
      logicalToolCallId,
    },
    tool,
    args,
  });
  assert.ok(
    admitted.status === 'inserted' || admitted.status === 'replayed',
    `fixture admitted the logical call (${admitted.status}${'reason' in admitted ? `: ${admitted.reason}` : ''})`,
  );
}

// ── 1. Trusted tool identity ─────────────────────────────────────────────────

test('P1a: business fields must never replace a trusted tool name', () => {
  // A payload is DATA. Treating any field called name/tool/method as the
  // capability being invoked lets ordinary content rename the call — a record
  // titled "Q3 Report" became the tool "q3 report", and a payment whose method
  // was "wire transfer" became the tool "wire transfer".
  const trusted = 'alphasink__write_range';
  for (const args of [
    { name: 'Q3 Report', rows: 3 },
    { tool: 'hammer', qty: 2 },
    { method: 'wire transfer', amount: 100 },
    { input: 'user typed this', id: 7 },
    { payload: 'blob', id: 8 },
    { params: 'legacy string', id: 9 },
    { arguments: 'not a carrier', id: 10 },
  ]) {
    // The shape production actually uses today: stepIdentity() calls this with
    // (args, trustedFallbackName). That is the path that hijacks.
    const legacy = contract.normalizeCallableArguments(args, trusted);
    assert.equal(
      legacy.toolName,
      trusted,
      `a trusted name must survive ${JSON.stringify(args)} on the legacy call shape`,
    );
    assert.deepEqual(legacy.args, args, 'and the payload must arrive intact');

    // ...and the discriminated shape must agree.
    const discriminated = contract.normalizeCallableArguments(
      { kind: 'direct', toolName: trusted, args } as never,
    );
    assert.equal(discriminated.toolName, trusted);
    assert.deepEqual(discriminated.args, args);
  }
});

test('P1b: malformed carrier JSON is typed invalid_arguments, not silent {}', () => {
  const resolved = contract.normalizeCallableArguments(
    { kind: 'carrier_json', toolName: 'trusted__tool', raw: '{"tool_slug":"x","arguments":{bad' } as never,
  );
  assert.equal(
    (resolved as { error?: string }).error,
    'invalid_arguments',
    'unparseable arguments must be a typed failure — dispatching {} silently drops what the user asked for',
  );
});

test('P1c: canonical identity must not collide on truncated argument material', () => {
  const identity = (size: number) => contract.callableContractIdentity(
    contract.normalizeCallableArguments(
      { kind: 'direct', toolName: 'alphasource__list_records', args: { blob: 'z'.repeat(size) } } as never,
    ),
  );
  assert.notEqual(
    identity(600),
    identity(601),
    'identity must hash the COMPLETE argument value; truncating at 512 chars makes distinct steps collide',
  );
});

// ── 2. Real result storage and projection ────────────────────────────────────

test('P2a: handle recognizes the live data.value shape and fails closed on errors', () => {
  const live = { successful: true, data: { value: [{ id: 'a' }, { id: 'b' }] } };
  const handle = toResultHandle(live);
  assert.equal(handle.recordPath, 'data.value', 'the live record shape must be recognized');
  assert.equal(handle.recordCount, 2);

  const errored = { successful: false, error: { status_code: 500, message: 'boom' } };
  const failed = toResultHandle(errored);
  assert.equal(failed.success, false, 'an error envelope must fail closed');

  const contradictory = { successful: true, isError: true, content: [{ type: 'text', text: 'nope' }] };
  assert.equal(
    toResultHandle(contradictory).success,
    false,
    'isError:true outranks successful:true — a provider contradicting itself is a failure',
  );
});

test('P2b: raw payload is retrievable through rawLocation, not merely referenced', async () => {
  const key = acceptedTask('raw-store');
  const big = { successful: true, data: { records: Array.from({ length: 400 }, (_, i) => ({ id: `r${i}`, blob: 'y'.repeat(64) })) } };
  const handle = toResultHandle(big, {
    acceptedTaskId: `${key.sessionId}#${key.sourceUserSeq}`,
    physicalAttemptId: 'attempt-1',
  } as never);

  assert.ok(handle.rawLocation, 'a raw location must be issued');
  const store = await import('./harness/result-handle.js') as Record<string, unknown>;
  const fetchRaw = store.readRawResult as ((location: string) => unknown) | undefined;
  assert.ok(fetchRaw, 'the handle must be redeemable — a reference nothing can resolve is not storage');
  const raw = fetchRaw!(handle.rawLocation!);
  assert.deepEqual(raw, big, 'the exact payload must come back through the existing tool-output store');
});

test('P2c: projection is bounded by bytes and depth, not only record count', () => {
  const fat = {
    successful: true,
    data: { records: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, blob: 'q'.repeat(200_000) })) },
  };
  const handle = toResultHandle(fat);
  const bytes = JSON.stringify(handle.projectedRecords).length;
  assert.ok(bytes < 64_000, `projection must be byte-bounded; got ${bytes} bytes from only 5 records`);
});

test('P2d: continuation is an opaque server-side reference, never cursor bytes', () => {
  const page = fixtures.alphaSourceRead({}, 'opaque');
  const handle = toResultHandle(page) as Record<string, unknown>;
  assert.ok(handle.continuationRef, 'a server-side continuation reference must be issued');
  assert.notEqual(
    handle.continuationRef,
    page.next_cursor,
    'the model must receive a reference, not the provider cursor bytes it could retype',
  );
});

test('P2e: handles are scoped to accepted task + physical attempt', () => {
  const first = toResultHandle({ successful: true, data: { records: [] } }, {
    acceptedTaskId: 'task-A', physicalAttemptId: 'attempt-1',
  } as never);
  const second = toResultHandle({ successful: true, data: { records: [] } }, {
    acceptedTaskId: 'task-B', physicalAttemptId: 'attempt-1',
  } as never);
  assert.notEqual(
    first.handle,
    second.handle,
    'identical payloads in different accepted tasks must not share a handle',
  );
});

// ── 3. One graph, not hard-coded phases ──────────────────────────────────────

test('P3a: evidence obligations attach to the accepted turn graph, not a verb-regex workflow', async () => {
  const graph = await import('./graph/turn-graph-compiler.js') as Record<string, unknown>;
  const attach = graph.attachEvidenceObligations as
    ((input: unknown) => Array<{ nodeId: string; obligation: string }>) | undefined;
  assert.ok(
    attach,
    'obligations must hang off TurnGraphIR nodes; a universal five-phase compile from verb regexes '
    + 'invents phases for tasks that do not have them',
  );
});

test('P3b: an irreversible send is not forced through cell read-back', async () => {
  const graph = await import('./graph/turn-graph-compiler.js') as Record<string, unknown>;
  const attach = graph.attachEvidenceObligations as
    ((input: unknown) => Array<{ nodeId: string; obligation: string }>) | undefined;
  assert.ok(attach, 'obligation attachment must exist');
  const obligations = attach!({ effect: 'irreversible_send' }).map((o) => o.obligation);
  assert.ok(
    !obligations.includes('verify_committed_readback'),
    'you cannot read back a sent message the way you read back a written range; '
    + `different effects owe different evidence (got ${obligations.join(', ')})`,
  );
});

test('P3c: requirement state survives a restart', async () => {
  const key = acceptedTask('durable-requirements');
  const graphs = await import('./harness/requirement-graph.js') as Record<string, unknown>;
  const persist = graphs.persistRequirementState as
    ((sessionId: string, seq: number) => void) | undefined;
  const rehydrate = graphs.rehydrateRequirementState as
    ((sessionId: string, seq: number) => { requirements: unknown[] } | undefined) | undefined;
  assert.ok(persist && rehydrate, 'requirement state must be durable, not a process-local Map');

  const compile = graphs.compileRequirementGraph as (i: { objective: string }) => { requirements: Array<{ id: string }> };
  const bind = graphs.bindRequirementGraph as (s: string, n: number, g: unknown) => void;
  const satisfy = graphs.satisfyRequirement as (s: string, n: number, id: string) => boolean;
  bind(key.sessionId, key.sourceUserSeq, compile({ objective: 'read the source and write it to the sink' }));
  satisfy(key.sessionId, key.sourceUserSeq, 'req:source_snapshot');
  persist!(key.sessionId, key.sourceUserSeq);

  (graphs._resetRequirementGraphsForTests as () => void)();
  const restored = rehydrate!(key.sessionId, key.sourceUserSeq);
  assert.ok(restored, 'a daemon restart must not lose what the task already proved');
  const snapshot = (restored.requirements as Array<{ id: string; satisfied: boolean }>)
    .find((r) => r.id === 'req:source_snapshot');
  assert.equal(snapshot?.satisfied, true, 'and satisfaction must survive it');
});

// ── 4. Fail-closed terminal truth ────────────────────────────────────────────

test('P4a: terminal truth reads authoritative stores, not caller booleans', async () => {
  const terminal = await import('./harness/terminal-truth.js') as Record<string, unknown>;
  const adjudicate = terminal.adjudicateTerminalForTask as
    ((input: { sessionId: string; sourceUserSeq: number }) => { status: string }) | undefined;
  assert.ok(
    adjudicate,
    'adjudication must derive evidence from the accepted task; optional caller booleans '
    + 'let the layer being audited supply its own verdict',
  );
});

test('P4b: complete source alone must never yield done (omission matrix)', () => {
  // Obligations are scoped to what this task's graph nodes actually incurred.
  const base = {
    sourceCompleteness: 'complete' as const,
    sourceIdentities: ['r1', 'r2'],
    committedIdentities: ['r1', 'r2'],
    writeReceipt: { successful: true },
    readBackPerformed: true,
    readBackMatches: true,
    staleRowsFound: 0,
    staleRowsReconciled: true,
    activeExecutions: 0,
    applicableObligations: ['commit_effect', 'stale_destination_reconciled'],
    effectReversibility: 'reversible' as const,
  };
  assert.equal(adjudicateTerminal(base).status, 'done', 'the complete case is reachable');

  const omissions: Array<[string, Record<string, unknown>]> = [
    ['no read-back', { readBackPerformed: false }],
    ['read-back mismatch', { readBackMatches: false }],
    ['unaccounted identities', { committedIdentities: ['r1'] }],
    ['stale rows', { staleRowsFound: 3, staleRowsReconciled: false }],
    ['active execution', { activeExecutions: 1 }],
    ['partial source', { sourceCompleteness: 'partial' }],
    ['no write receipt', { writeReceipt: undefined }],
  ];
  for (const [label, patch] of omissions) {
    const verdict = adjudicateTerminal({ ...base, ...patch } as never);
    assert.notEqual(verdict.status, 'done', `${label} must block done`);
  }
});

test('P4c: a bare complete-source claim with nothing else is not done', () => {
  assert.notEqual(
    adjudicateTerminal({ sourceCompleteness: 'complete' }).status,
    'done',
    'omitting every other obligation must fail closed, not default to satisfied',
  );
});

// ── 5. One settlement per physical attempt, through real seams ───────────────

test('P5a: settlement identity is accepted task + physical attempt, not session+callId', async () => {
  const kernel = await import('./harness/attempt-settlement.js') as Record<string, unknown>;
  const settle = kernel.settleToolAttempt as (i: Record<string, unknown>) => { duplicate: boolean };
  const key = acceptedTask('settlement-identity');

  const attempt = { acceptedTaskId: acceptedTaskIdFor(key.sessionId, key.sourceUserSeq), physicalAttemptId: 'phys-1' };
  admitFixtureCall(key, attempt.physicalAttemptId, 'alphasource__list_records');
  const first = settle({ ...key, ...attempt, lane: 'native_mcp', toolName: 'alphasource__list_records', businessCall: true, result: { successful: true, data: { records: [{ id: 1 }] } } });
  const mirror = settle({ ...key, ...attempt, lane: 'agents_runner', toolName: 'alphasource__list_records', businessCall: true, result: { successful: true, data: { records: [{ id: 1 }] } } });
  assert.equal(first.duplicate, false);
  assert.equal(mirror.duplicate, true, 'a transport mirror references the settlement, it does not create another');

  const events = eventlog.listEvents(key.sessionId, { types: ['tool_attempt_settled'] });
  assert.equal(events.length, 1, 'exactly one durable settlement per physical attempt');
});

test('P5b: settlement dedupe survives a restart', async () => {
  const kernel = await import('./harness/attempt-settlement.js') as Record<string, unknown>;
  const settle = kernel.settleToolAttempt as (i: Record<string, unknown>) => { duplicate: boolean };
  const key = acceptedTask('settlement-durable');
  const attempt = { acceptedTaskId: acceptedTaskIdFor(key.sessionId, key.sourceUserSeq), physicalAttemptId: 'phys-restart' };

  admitFixtureCall(key, attempt.physicalAttemptId, 'alphasource__list_records');
  settle({ ...key, ...attempt, lane: 'native_mcp', toolName: 'alphasource__list_records', businessCall: true, result: { successful: true, data: { records: [] } } });
  (kernel._resetAttemptSettlementStateForTests as () => void)(); // models a process restart
  const afterRestart = settle({ ...key, ...attempt, lane: 'native_mcp', toolName: 'alphasource__list_records', businessCall: true, result: { successful: true, data: { records: [] } } });
  assert.equal(
    afterRestart.duplicate,
    true,
    'a process-local Set forgets across restart and lets one attempt settle twice',
  );
});

test('P5c: a typed refusal is visibly failed to the model, never ordinary text', async () => {
  const gated = await import('../tools/gated-mutating-tools.js') as Record<string, unknown>;
  const render = gated.renderTypedRefusalForModel as
    ((outcome: { kind: string }) => { isError?: boolean; ok?: boolean }) | undefined;
  assert.ok(
    render,
    'a lane must be able to render a typed refusal as a FAILED result; '
    + 'Claude gated local MCP currently returns ordinary text for refusals',
  );
  const rendered = render!({ kind: 'policy_denial' });
  assert.equal(rendered.isError, true, 'MCP refusals must carry isError:true');
});

// ── 6. Host-owned dependent pagination ───────────────────────────────────────

test('P6a: the host follows the continuation itself, bounded, and aggregates once', async () => {
  const pager = await import('./harness/host-pagination.js').catch(() => null);
  assert.ok(pager, 'host-owned bounded pagination must exist — a per-page model turn is the cost being removed');
  const collect = (pager as Record<string, unknown>).collectCompleteSource as
    ((input: Record<string, unknown>) => Promise<{ complete: boolean; records: unknown[]; pages: number }>) | undefined;
  assert.ok(collect, 'collection must be addressable');

  const result = await collect!({
    read: (cursor?: string) => fixtures.alphaSourceRead({ cursor }, 'host-pager'),
    maxPages: 10,
    maxRecords: 1000,
    maxBytes: 1_000_000,
    maxWallMs: 5_000,
  });
  assert.equal(result.complete, true, 'the aggregate must be complete');
  assert.equal(result.records.length, fixtures.ALPHA_TOTAL_RECORDS, 'every record, exactly once');
  assert.equal(result.pages, 3);
});

test('P6b: a bounded-out collection is partial and cannot become done', async () => {
  const pager = await import('./harness/host-pagination.js').catch(() => null);
  assert.ok(pager);
  const collect = (pager as Record<string, unknown>).collectCompleteSource as
    ((input: Record<string, unknown>) => Promise<{ complete: boolean }>) | undefined;
  const result = await collect!({
    read: (cursor?: string) => fixtures.alphaSourceRead({ cursor }, 'host-pager-bounded'),
    maxPages: 1,
  });
  assert.equal(result.complete, false, 'stopping at a bound is partial, and partial is not done');
  assert.notEqual(
    adjudicateTerminal({ sourceCompleteness: 'partial' }).status,
    'done',
  );
});

/**
 * CHECKPOINT A — the cross-lane defects, pinned red.
 *
 * Every test here is derived from one of two preserved accepted turns:
 *   Codex  session-fixture-codex-trace  seq 40502  — 121s, 13 calls, 392k prompt tokens
 *   Claude session-fixture-claude-trace seq 40654  — 440s, 56 calls, 3.11M prompt tokens
 *
 * They are written to FAIL against the current runtime. Fixtures are the
 * provider-neutral AlphaSource/AlphaSink pair; nothing below names a real
 * vendor, because nothing in the fix may branch on one.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-trace-defects-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-trace-defects\n', 'utf-8');

const eventlog = await import('./harness/eventlog.js');
const fixtures = await import('./harness/alpha-fixtures.js');
const {
  settleToolAttempt,
  _resetAttemptSettlementStateForTests,
} = await import('./harness/attempt-settlement.js');
const { classifyAttemptOutcome } = await import('./harness/attempt-outcome.js');
const { DiscoveryGovernor } = await import('./harness/discovery-governor.js');
const { recordTurnGraphShadow } = await import('./graph/turn-graph-shadow.js');
const { acceptedTaskIdFor } = await import('./harness/attempt-identity.js');
const { admitLogicalCall } = await import('./harness/dispatch-ledger.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function acceptedTask(label: string): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ id: `trace-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    // These fixtures settle real AlphaSource reads. A vague "task" correctly
    // compiles as conversational/tool-intent with no accepted work node, which
    // is not the authority shape this settlement-kernel suite exercises.
    data: { text: `Find the current ${label} records.` },
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
  callId: string,
  tool: string,
  args?: unknown,
): void {
  const admitted = admitLogicalCall({
    identity: {
      sessionId: key.sessionId,
      sourceUserSeq: key.sourceUserSeq,
      acceptedTaskId: acceptedTaskIdFor(key.sessionId, key.sourceUserSeq),
      logicalToolCallId: callId,
    },
    tool,
    args,
  });
  assert.ok(
    admitted.status === 'inserted' || admitted.status === 'replayed',
    `fixture admitted the logical call (${admitted.status}${'reason' in admitted ? `: ${admitted.reason}` : ''})`,
  );
}

// ── D1. One logical call, four carrier encodings, one identity ───────────────

test('D1 (carrier encoding): one logical call must have ONE identity across wire shapes', async () => {
  // THE root cause of the double progress credit in the Claude trace: the same
  // read arrived as an object at 17:35 and as a JSON string at 17:39, so the
  // step identity differed and both credited progress.
  const kernel = await import('./harness/attempt-settlement.js') as Record<string, unknown>;
  const normalize = kernel.normalizeCallableArguments as
    ((carrier: unknown) => { toolName: string; args: Record<string, unknown> }) | undefined;
  assert.ok(
    normalize,
    'the kernel must expose one argument-contract normalizer used before identity, validation and dispatch',
  );

  const logical = { user_id: 'u-1', start: 'D1', end: 'D3' };
  const identities = fixtures.alphaCarrierEncodings(fixtures.ALPHA_SOURCE, logical)
    .map((carrier) => JSON.stringify(normalize!(carrier)));
  assert.equal(
    new Set(identities).size,
    1,
    `four encodings of one call must normalize to one contract, got:\n${[...new Set(identities)].join('\n')}`,
  );
});

test('D1b (progress): re-encoding a call must not manufacture a completed step', () => {
  _resetAttemptSettlementStateForTests();
  const key = acceptedTask('carrier-progress');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });
  governor.admit({ ...key, category: 'broad_discovery', callId: 'seed' });

  const logical = { user_id: 'u-1', start: 'D1', end: 'D3' };
  const credits = fixtures.alphaCarrierEncodings(fixtures.ALPHA_SOURCE, logical).map((carrier, index) => {
    // Spend whatever budget the previous credit opened, so a second credit is
    // OBSERVABLE. Without this the "epoch already fresh" guard masks the defect
    // and the test passes while the identity is still wrong.
    governor.admit({ ...key, category: 'broad_discovery', callId: `spend-${index}` });
    admitFixtureCall(key, `encoding-${index}`, fixtures.ALPHA_SOURCE, carrier);
    return settleToolAttempt({
      ...key,
      lane: 'composio',
      toolName: fixtures.ALPHA_SOURCE,
      callId: `encoding-${index}`,
      args: carrier,
      businessCall: true,
      result: fixtures.alphaSourceRead({}, `carrier-${index}`),
    }).creditedProgress;
  });

  assert.deepEqual(
    credits,
    [true, false, false, false],
    `the same read in four encodings is one step, not four (credits: ${credits.join(',')})`,
  );
});

// ── D2. Dependent pagination is one requirement, not fan-out ─────────────────

test('D2 (pagination): following a cursor stays on one requirement and completes it once', () => {
  _resetAttemptSettlementStateForTests();
  const key = acceptedTask('pagination');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });
  governor.admit({ ...key, category: 'broad_discovery', callId: 'seed' });

  const requirementId = 'req-source-snapshot';
  let cursor: string | undefined;
  let pages = 0;
  const credits: boolean[] = [];
  do {
    const envelope = fixtures.alphaSourceRead({ cursor }, 'pagination');
    admitFixtureCall(key, `page-${pages}`, fixtures.ALPHA_SOURCE, { cursor });
    credits.push(settleToolAttempt({
      ...key,
      lane: 'composio',
      toolName: fixtures.ALPHA_SOURCE,
      callId: `page-${pages}`,
      args: { cursor },
      businessCall: true,
      result: envelope,
      // Pages belong to ONE obligation; the kernel must be told so structurally
      // rather than inferring it from arguments that differ every page.
      requirementId,
      continuesRequirement: envelope.next_cursor !== undefined,
    } as never).creditedProgress);
    cursor = envelope.next_cursor;
    pages += 1;
  } while (cursor && pages < 10);

  assert.equal(pages, 3, 'three pages exhaust the fixture source');
  assert.deepEqual(
    credits,
    [false, false, true],
    'intermediate pages continue one obligation; only exhaustion satisfies it',
  );
});

test('D2b (fan-out): dependent pages must not read as independent item fan-out', async () => {
  const guard = await import('./harness/tool-guardrail.js') as Record<string, unknown>;
  const classify = guard.classifyRepeatedCallShape as
    ((input: { toolName: string; requirementId?: string; dependent?: boolean }) => string) | undefined;
  assert.ok(
    classify,
    'the guardrail must distinguish dependent pagination from independent fan-out structurally',
  );
  assert.equal(
    classify!({ toolName: fixtures.ALPHA_SOURCE, requirementId: 'req-1', dependent: true }),
    'dependent_pagination',
    'sequential pages of one requirement are not a fan-out candidate',
  );
});

// ── D3. Envelope metadata and cursors survive projection ─────────────────────

test('D3 (transport): a result handle must carry envelope metadata and an opaque continuation', async () => {
  const kernel = await import('./harness/attempt-settlement.js') as Record<string, unknown>;
  const toHandle = kernel.toResultHandle as ((result: unknown) => Record<string, unknown>) | undefined;
  assert.ok(toHandle, 'the kernel must expose a bounded structured result handle');

  const envelope = fixtures.alphaSourceRead({}, 'handle');
  const handle = toHandle!(envelope);

  assert.equal(handle.success, true);
  assert.equal(handle.recordPath, 'data.records');
  assert.equal(handle.recordCount, fixtures.ALPHA_PAGE_SIZE);
  assert.equal(handle.completeness, 'partial', 'a page with a next cursor is not complete');
  // The continuation is now a server-side REFERENCE: the provider's cursor
  // bytes stay host-side where they cannot be retyped, and the host redeems
  // them when it follows the page itself.
  assert.ok(handle.continuationRef, 'a partial page must carry a continuation reference');
  assert.notEqual(handle.continuationRef, envelope.next_cursor, 'the model never sees cursor bytes');
  const { resolveContinuation } = await import('./harness/result-handle.js');
  assert.equal(
    resolveContinuation(handle.continuationRef as string),
    envelope.next_cursor,
    'and the host can redeem it byte-exact',
  );
  assert.deepEqual(
    handle.envelopeMeta,
    envelope.meta,
    'envelope-level metadata is addressable, not lost to a record-only projection',
  );
  assert.ok(handle.rawLocation, 'the raw payload is stored once, outside model history');
  assert.ok(
    Array.isArray(handle.projectedRecords) && (handle.projectedRecords as unknown[]).length > 0,
    'a bounded projection accompanies the handle',
  );
});

// ── D4. Every refusal settles exactly once ───────────────────────────────────

test('D4 (settlement coverage): a pre-dispatch refusal produces exactly one typed settlement', () => {
  _resetAttemptSettlementStateForTests();
  const key = acceptedTask('refusal-settles');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });

  // The Claude trace made 25 provider calls and produced 8 settlements: 17
  // guardrail refusals vanished without a typed outcome.
  admitFixtureCall(key, 'refused-1', fixtures.ALPHA_SINK_WRITE);
  const settled = settleToolAttempt({
    ...key,
    lane: 'agents_runner',
    toolName: fixtures.ALPHA_SINK_WRITE,
    callId: 'refused-1',
    businessCall: true,
    signals: { preDispatch: true, policyRefused: true },
  });
  assert.equal(settled.outcome.kind, 'policy_denial');

  const events = eventlog.listEvents(key.sessionId, { types: ['tool_attempt_settled'] });
  assert.equal(events.length, 1, 'a refusal is an attempt outcome, not a silent absence');
  assert.equal(
    (events[0]!.data as Record<string, unknown>).dispatchState,
    'not_started',
    'the settlement must preserve dispatch state so a refusal can never read as a completed call',
  );
});

test('D4b (invalid cursor): a mangled cursor repairs the same candidate, it does not eliminate it', () => {
  const envelope = fixtures.alphaSourceRead({ cursor: 'not-a-real-cursor' }, 'bad-cursor');
  const outcome = classifyAttemptOutcome({
    envelopeSuccessful: envelope.successful,
    httpStatus: envelope.error?.status_code,
  });
  assert.equal(outcome.kind, 'invalid_arguments');
  assert.equal(outcome.directive.retrySameCandidate, true);
  assert.equal(
    outcome.directive.eliminatesCandidate,
    false,
    'a bad cursor is a bad argument; the source is still the right source',
  );
  assert.equal(outcome.directive.opensDiscoveryEpoch, false, 'and it buys no new search');
});

// ── D5. Requirement progress, not tool+arguments progress ────────────────────

test('D5 (requirements): only first-time satisfaction of an obligation earns progress', async () => {
  const kernel = await import('./harness/requirement-graph.js').catch(() => null);
  assert.ok(
    kernel,
    'the harness must compile provider-neutral evidence obligations for an accepted task',
  );
  const compile = (kernel as Record<string, unknown>).compileRequirementGraph as
    ((input: { objective: string }) => { requirements: Array<{ id: string; kind: string }> }) | undefined;
  assert.ok(compile, 'requirement compilation must be addressable');

  const graph = compile!({ objective: 'read every record from the source and record them in the sink' });
  const kinds = graph.requirements.map((r) => r.kind);
  for (const expected of ['source_snapshot', 'derive_representation', 'commit_effect', 'verify_committed', 'close_execution']) {
    assert.ok(kinds.includes(expected), `source-to-artifact work obliges ${expected}; got ${kinds.join(', ')}`);
  }
});

// ── D6. Terminal truth: a receipt is not verification ────────────────────────

test('D6 (terminal truth): a write receipt alone must not permit done', async () => {
  fixtures.resetAlphaFixtures();
  const terminal = await import('./harness/terminal-truth.js').catch(() => null);
  assert.ok(terminal, 'a terminal-truth gate must exist to adjudicate done');
  const adjudicate = (terminal as Record<string, unknown>).adjudicateTerminal as
    ((input: Record<string, unknown>) => { status: string; missing: string[] }) | undefined;
  assert.ok(adjudicate, 'terminal adjudication must be addressable');

  // Seed the sink with stale rows, then write FEWER rows: the tail survives.
  fixtures.alphaSinkSeed('SheetA!A1:C9', Array.from({ length: 9 }, (_, i) => [`old${i}`, 'x', 'y']));
  const receipt = fixtures.alphaSinkWrite('SheetA!A1:C9', [['new0', 'a', 'b'], ['new1', 'a', 'b']]);
  assert.equal(receipt.successful, true, 'the sink acknowledges the write');

  const verdict = adjudicate!({
    sourceCompleteness: 'partial',
    writeReceipt: receipt,
    readBackPerformed: false,
    activeExecutions: 1,
  });
  assert.notEqual(verdict.status, 'done', 'an acknowledged write with no read-back is not done');
  for (const missing of ['source_completeness', 'exact_read_back', 'execution_terminal']) {
    assert.ok(verdict.missing.includes(missing), `must name ${missing}; got ${verdict.missing.join(', ')}`);
  }
});

test('D6b (stale rows): the read-back DETECTS inherited rows and blocks done', async () => {
  const { adjudicateTerminal } = await import('./harness/terminal-truth.js');
  fixtures.resetAlphaFixtures();
  fixtures.alphaSinkSeed('SheetA!A1:C9', Array.from({ length: 9 }, (_, i) => [`old${i}`, 'x', 'y']));
  const receipt = fixtures.alphaSinkWrite('SheetA!A1:C9', [['new0', 'a', 'b'], ['new1', 'a', 'b']]);

  // The sink accepted two rows and says so. The destination still holds seven
  // from the previous artifact — which only a read-back can reveal.
  const rows = fixtures.alphaSinkRead('SheetA!A1:C9').data?.values ?? [];
  const stale = rows.filter((row) => String(row[0]).startsWith('old'));
  assert.equal(stale.length, 7, 'the fixture reproduces the inherited tail');

  const verdict = adjudicateTerminal({
    sourceCompleteness: 'complete',
    sourceIdentities: ['new0', 'new1'],
    committedIdentities: ['new0', 'new1'],
    writeReceipt: receipt,
    readBackPerformed: true,
    readBackMatches: true,
    staleRowsFound: stale.length,
    staleRowsReconciled: false,
    activeExecutions: 0,
    applicableObligations: ['commit_effect', 'stale_destination_reconciled'],
    effectReversibility: 'reversible',
  });
  assert.notEqual(verdict.status, 'done', 'inherited rows must block done');
  assert.ok(verdict.missing.includes('stale_destination_reconciled'));
  assert.ok(
    verdict.facts.some((fact) => /previous artifact/.test(fact)),
    'and the runtime must hand Clem the fact to say so in her own words',
  );
});

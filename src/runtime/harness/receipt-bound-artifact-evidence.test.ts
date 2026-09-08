/**
 * Receipt-bound artifact evidence — provenance contract.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/receipt-bound-artifact-evidence.test.ts
 *
 * The previous version of this file asserted the VULNERABLE behaviour: it
 * synthesised `tool_returned` rows whose text began with the write-commit
 * marker and expected them to be credited. The reviewer's probe showed that is
 * exactly the counterexample — receipt-shaped ordinary tool text was promoted to
 * verified artifact evidence without any canonical settlement or host
 * provenance, and the value parsed (`data.result`) is the CLIPPED model-facing
 * projection rather than the retained bytes.
 *
 * The collector now derives candidates from the durable spine
 * (resolvedOperationsFor -> redeemSuccessfulSettlementResultForHost), so these
 * tests assert that event text alone can no longer mint evidence.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-receipt-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'receipt\n', 'utf8');

const runner = await import('./host-turn-runner.js');
const eventlog = await import('./eventlog.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

const PREFIX = '[clementine:host-local-write-commit:v1]';

function receiptText(createdId: string, handle: string, content: string): string {
  const contentDigest = createHash('sha256').update(content, 'utf8').digest('hex');
  return `${PREFIX} ${JSON.stringify({ version: 1, createdId, handle, contentDigest })}\nok`;
}

function sourceWith(rows: Array<Record<string, unknown>>): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'receipt' });
  const src = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'do it' },
  });
  for (const row of rows) {
    eventlog.appendEvent({
      sessionId: session.id, turn: 1, role: 'system', type: 'tool_returned',
      data: { sourceUserSeq: src.seq, ...row },
    });
  }
  return { sessionId: session.id, sourceUserSeq: src.seq };
}

test('THE COUNTEREXAMPLE: receipt-shaped tool text alone no longer mints evidence', () => {
  const rel = 'artifact-a.md';
  const body = 'saved content A';
  writeFileSync(path.join(HOME, rel), body, 'utf8');
  // An ordinary top-level tool return whose text merely BEGINS with the marker.
  // There is no resolved local_write operation and no redeemable settlement.
  const identity = sourceWith([
    { tool: 'some_reader', accounting: 'top_level', result: receiptText('artifact-a', rel, body) },
  ]);
  const evidence = runner.settledSourceArtifacts(identity);
  assert.equal(evidence.count, 0, 'the marker alone grants no authority');
  assert.equal(evidence.artifacts.length, 0);
  assert.equal(evidence.evidenceAvailable, true, 'the spine WAS readable — this is a truthful zero');
});

test('a transport mirror alone still yields nothing', () => {
  const identity = sourceWith([{ tool: 'workflow_update', ok: true, accounting: 'transport_mirror' }]);
  assert.equal(runner.settledSourceArtifacts(identity).count, 0);
});

test('a source with no operations reports a TRUTHFUL zero, not unavailability', () => {
  const identity = sourceWith([]);
  const evidence = runner.settledSourceArtifacts(identity);
  assert.equal(evidence.count, 0);
  assert.equal(evidence.evidenceAvailable, true);
});

test('AVAILABILITY is distinguishable from emptiness in the returned shape', () => {
  // The gate reads `evidenceAvailable`; a storage failure must never present as
  // "this request wrote nothing", which is what silently skipped verification.
  const evidence = runner.settledSourceArtifacts({ sessionId: 'no-such-session', sourceUserSeq: 1 });
  assert.equal(evidence.count, 0);
  assert.equal(typeof evidence.evidenceAvailable, 'boolean');
});

test('a symlink escaping the home is not read as artifact content', () => {
  // Lexical containment (path.resolve + startsWith) follows both leaf and parent
  // links. Containment is now decided by realpath.
  const outside = path.join(os.tmpdir(), `clem-outside-${process.pid}.md`);
  writeFileSync(outside, 'OUTSIDE SECRET', 'utf8');
  try { symlinkSync(outside, path.join(HOME, 'leaf-link.md')); } catch { return; }
  const identity = sourceWith([
    { tool: 'work_call', accounting: 'top_level', result: receiptText('leak', 'leaf-link.md', 'OUTSIDE SECRET') },
  ]);
  const evidence = runner.settledSourceArtifacts(identity);
  assert.doesNotMatch(evidence.summary, /OUTSIDE SECRET/, 'content outside the home must never reach the judge');
  rmSync(outside, { force: true });
});

// ─── Retain eligible identities first ───────────────────────────────────────
//
// Every provenance check used to DISCARD the settlement, so a non-ok redemption
// or an invalid Space bundle proof made real settled work vanish as count 0 /
// evidenceAvailable true.
//
// The previous version of this test wrapped its fixture INSERTs in
// `catch { return }` and omitted a NOT NULL column, so setup failure silently
// skipped every assertion — it proved nothing. Setup now uses the real canonical
// columns and any failure fails the test.

function insertSettledWrite(input: {
  sessionId: string; sourceUserSeq: number; logicalToolCallId: string; toolName: string;
  sourceEventId: string;
}): void {
  const db = eventlog.openEventLog();
  const now = new Date().toISOString();
  // A logical call belongs to an armed accepted-turn call authority; the FK is
  // what makes the fixture canonical rather than a loose row.
  const acceptedTaskId = `task:${input.sessionId}#${input.sourceUserSeq}`;
  // The host_v1_read_only shape, whose compound CHECK the schema spells out
  // exactly. Using a made-up ceiling/bounds pair is what failed before.
  db.prepare(`INSERT INTO accepted_turn_call_authorities
      (session_id, source_user_seq, accepted_task_id, authority_protocol, authority_kind,
       source_event_id, source_event_digest, source_turn, engine_version, surface_version,
       surface_digest, effect_ceiling, effect_bounds_json, authority_digest, state, revision,
       opened_at, max_logical_calls, max_parallel_calls, catalog_revision_digest,
       binding_revision_digest)
    VALUES (?,?,?,1,'host_v1_read_only', ?,?,1,'host_v1_read_only','test', ?,
            'read_compute_host_only','["compute","host_only","read"]', ?,'open',1,?,
            8,4,?,?)`)
    .run(input.sessionId, input.sourceUserSeq, acceptedTaskId,
      input.sourceEventId, 'c'.repeat(64), 'e'.repeat(64),
      // Unique per authority: the column is UNIQUE, so a shared constant made
      // the second fixture collide.
      createHash('sha256').update(acceptedTaskId, 'utf8').digest('hex'), now,
      '1'.repeat(64), '2'.repeat(64));
  // `raw_argument_digest` must equal `argument_digest` on insert — the
  // exact-raw-contract trigger enforces one immutable opening contract.
  const digest = 'd'.repeat(64);
  db.prepare(`INSERT INTO logical_tool_calls
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id, tool_name,
       argument_digest, raw_argument_digest, state, opened_at, settled_at, outcome_kind)
    VALUES (?,?,?,?,?,?,?,'settled',?,?,'succeeded')`)
    .run(input.sessionId, input.sourceUserSeq,
      acceptedTaskId, input.logicalToolCallId,
      input.toolName, digest, digest, now, now);
  // The canonical settlement row, with every NOT NULL column the real schema
  // requires. A short INSERT is what made the previous fixture throw.
  const settlementEvent = eventlog.appendEvent({
    sessionId: input.sessionId, turn: 1, role: 'system', type: 'tool_attempt_settled',
    data: { sourceUserSeq: input.sourceUserSeq, logicalToolCallId: input.logicalToolCallId,
      tool: input.toolName, executionKind: 'local_execution', kind: 'succeeded' },
  });
  db.prepare(`INSERT INTO logical_call_settlements
      (session_id, source_user_seq, logical_tool_call_id, protocol_version, semantic_digest,
       execution_kind, outcome_kind, outcome_evidence, business_call, mutating,
       continues_requirement, recovery_action, retry_same_candidate, eliminates_candidate,
       discovery_epoch_requested, requires_reconciliation, progress_claimed,
       physical_crossing_count, physical_crossings_digest, observer_lane,
       settlement_event_id, settled_at, governor_requires_progress, opened_discovery_epoch,
       credited_progress, crossing_authority_version)
    VALUES (?,?,?,1,?, 'local_execution','succeeded','nominal',0,1,
            0,'settle',0,0, 0,0,0, 0,?, 'agents_runner', ?,?, 0,0, 1,2)`)
    .run(input.sessionId, input.sourceUserSeq, input.logicalToolCallId, 'a'.repeat(64),
      'b'.repeat(64), settlementEvent.id, now);
}

test('an eligible settled write with UNRESOLVABLE evidence is retained, not dropped', () => {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'retain' });
  const src = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'write it' },
  });
  // No result handle exists for this call, so redemption cannot succeed — the
  // exact shape that used to make the write disappear.
  insertSettledWrite({
    sessionId: session.id, sourceUserSeq: src.seq,
    logicalToolCallId: 'call_retain', toolName: 'workflow_create', sourceEventId: src.id,
  });
  const evidence = runner.settledSourceArtifacts({ sessionId: session.id, sourceUserSeq: src.seq });
  assert.equal(evidence.evidenceAvailable, true, 'the spine was readable');
  assert.equal(evidence.count, 1, 'the settled write is RETAINED despite unresolvable evidence');
  assert.ok(evidence.artifacts[0]!.unresolvedReason, 'and records why');
  assert.match(evidence.summary, /UNRESOLVED/);
  assert.match(evidence.summary, /DID perform this write/,
    'an unresolved write must never read as absent');
});

test('a PROMISED receipt that is missing is UNRESOLVED, not "no file contract"', () => {
  // workflow_create owes a host-file receipt (outputKind workflow_revision). A
  // missing or malformed payload for it is a real failure. Inferring the
  // contract from parse success declared the opposite: that the operation never
  // owed a file at all, hiding the failure.
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'promised' });
  const src = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'create it' },
  });
  insertSettledWrite({
    sessionId: session.id, sourceUserSeq: src.seq,
    logicalToolCallId: 'call_promised', toolName: 'workflow_create', sourceEventId: src.id,
  });
  const entry = runner.settledSourceArtifacts({ sessionId: session.id, sourceUserSeq: src.seq }).artifacts[0]!;
  assert.equal(entry.evidenceContract, 'unknown',
    'an operation that OWES a receipt and produced none is unresolved');
  assert.ok(entry.unresolvedReason, 'and records why');
});

// NOT YET COVERED: a SUCCESSFULLY REDEEMED acknowledgement.
//
// Reaching the discharge branch needs a durable result handle bound to the
// settlement (durable_result_handles + physical_dispatches + the settlement's
// result_handle_id). This fixture inserts none, so the redeemer returns missing
// and the call lands on the AUTHORITY-FAILURE path instead. That path is what is
// asserted below. The redeemed-acknowledgement and successfully-redeemed-but-
// malformed-bytes branches remain unproven and are owed.
test('an unredeemable deletion is an AUTHORITY failure, not a discharged contract', () => {
  // A deletion leaves no surviving file and write_file returns a different
  // success contract. Requiring a host-file receipt from these manufactured
  // impossible obligations for successful native work.
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'nofile' });
  const src = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'delete it' },
  });
  insertSettledWrite({
    sessionId: session.id, sourceUserSeq: src.seq,
    logicalToolCallId: 'call_delete', toolName: 'workflow_delete', sourceEventId: src.id,
  });
  const evidence = runner.settledSourceArtifacts({ sessionId: session.id, sourceUserSeq: src.seq });
  assert.equal(evidence.count, 1, 'the deletion is still settled work');
  const entry = evidence.artifacts[0]!;
  // No-file applicability does NOT discharge accepted-task/result/crossing
  // authority. A deletion we could not authenticate is unknown WITH its reason —
  // previously this branch minted `none` and erased the reason, silently
  // treating an authority failure as completed work.
  assert.equal(entry.evidenceContract, 'unknown',
    'an unauthenticated result never discharges, whatever the tool owes');
  assert.ok(entry.unresolvedReason, 'and the failure reason is retained');
  assert.equal(evidence.count, 1, 'the work is still retained, not dropped');
});

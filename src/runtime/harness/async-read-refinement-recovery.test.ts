/** SQL recovery-exclusion component controls. TEMP ledger relations describe
 * the already-eligible queue; they do not assert accepted-task authority or
 * execute an async child. Source/checkpoint/publication ownership uses the real
 * isolated event log. The production selection and guarded UPDATE run intact. */
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-async-publication-fence-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const log = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { HostRecoveryState } = await import('./host-turn-runner.js');
const publication = await import('./held-stop-publication.js');
const { claimPendingAsyncReadRefinementRecoveries } = await import('./async-read-refinement-recovery.js');
let serial = 0;
const names = ['async_read_refinement_intents', 'logical_tool_calls', 'expected_work_call_bindings', 'accepted_turn_call_authorities',
  'accepted_model_batch_admissions_readable_v1', 'accepted_model_batch_checkpoints_readable_v1', 'run_dispatch_leases'];
test.after(() => { mock.restoreAll(); log.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });
function fixture() {
  const db = log.openEventLog();
  for (const name of names) db.exec(`DROP TABLE IF EXISTS temp.${name}`);
  db.exec(`
    CREATE TEMP TABLE async_read_refinement_intents (recorded_at,session_id,source_user_seq,accepted_task_id,start_logical_tool_call_id,requirement_id,start_argument_digest);
    CREATE TEMP TABLE logical_tool_calls (session_id,source_user_seq,logical_tool_call_id,accepted_task_id,state);
    CREATE TEMP TABLE expected_work_call_bindings (session_id,source_user_seq,logical_tool_call_id,accepted_task_id,requirement_id,argument_digest,contract_id);
    CREATE TEMP TABLE accepted_turn_call_authorities (session_id,source_user_seq,accepted_task_id,authority_kind,state,authority_digest);
    CREATE TEMP TABLE accepted_model_batch_admissions_readable_v1 (session_id,source_user_seq,accepted_task_id,work_contract_id,authority_digest,call_count,call_ids_json,batch_ordinal,batch_id,previous_response_id,provider_response_id,pre_history_json,frame_history_json);
    CREATE TEMP TABLE accepted_model_batch_checkpoints_readable_v1 (session_id,source_user_seq,batch_ordinal);
    CREATE TEMP TABLE run_dispatch_leases (session_id,source_user_seq,accepted_task_id,logical_tool_call_id,revoked_at);
  `);
  const session = log.createSession({ id: `async-publication-fence-${++serial}`, kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Controlled incomplete async read.' } });
  const attempt = log.beginRunAttempt(session.id, { runId: `async-fence-${serial}` }); log.bindRunAttemptSourceUserEvent(attempt, source.seq);
  const store = HarnessSession.load(session.id)!;
  const blob = new HostRecoveryState(session.id, source.seq, 'admit', [{ role: 'user', content: source.data.text }] as never,
    [{ type: 'function_call', callId: 'async-start', name: 'session_history', arguments: '{}' }] as never,
    [], undefined, undefined, 'host_v1', undefined, 0).toString();
  HostRecoveryState.fromString(blob); store.saveRecoveryState(blob);
  const ticket = publication.observeHeldStopPublicationOwner({ sessionId: session.id, sourceUserSeq: source.seq, runAttemptId: attempt.attemptId })!;
  assert.ok(ticket); store.clearRecoveryState();
  return { db, session, source, ticket, store };
}
function queued(f: ReturnType<typeof fixture>, source = f.source) {
  const task = `task:${f.session.id}:${source.seq}`; const call = `start-${source.seq}`;
  const history = JSON.stringify([{ role: 'user', content: source.data.text }]);
  const frame = JSON.stringify([{ type: 'function_call', callId: call, name: 'session_history', arguments: '{}' }]);
  f.db.prepare('INSERT INTO temp.async_read_refinement_intents VALUES (?,?,?,?,?,?,?)').run('2026-10-05T00:00:00.000Z', f.session.id, source.seq, task, call, 'req', 'args');
  f.db.prepare('INSERT INTO temp.logical_tool_calls VALUES (?,?,?,?,?)').run(f.session.id, source.seq, call, task, 'open');
  f.db.prepare('INSERT INTO temp.expected_work_call_bindings VALUES (?,?,?,?,?,?,?)').run(f.session.id, source.seq, call, task, 'req', 'args', 'contract');
  f.db.prepare('INSERT INTO temp.accepted_turn_call_authorities VALUES (?,?,?,?,?,?)').run(f.session.id, source.seq, task, 'host_v1', 'open', 'a'.repeat(64));
  f.db.prepare('INSERT INTO temp.accepted_model_batch_admissions_readable_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(f.session.id, source.seq, task, 'contract', 'a'.repeat(64), 1, JSON.stringify([call]), 0, 'b'.repeat(64), null, null, history, frame);
  f.db.prepare('INSERT INTO temp.run_dispatch_leases VALUES (?,?,?,?,?)').run(f.session.id, source.seq, task, call, '2026-10-05T00:00:01.000Z');
}

test('held publication async recovery excludes its exact sealed source before checkpoint claim', () => {
  const f = fixture(); queued(f); publication.sealHeldStopPublication(f.ticket);
  const before = log.getSession(f.session.id)!.metadata;
  const sweep = claimPendingAsyncReadRefinementRecoveries();
  assert.equal(sweep.claimed, 0); assert.equal(sweep.scanned, 0);
  assert.equal(HarnessSession.load(f.session.id)!.loadRecoveryState(), null); assert.deepEqual(log.getSession(f.session.id)!.metadata, before);
});

test('held publication async recovery preserves a different source in the same chat', () => {
  const f = fixture(); publication.sealHeldStopPublication(f.ticket);
  const other = log.appendEvent({ sessionId: f.session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Independent controlled async read.' } });
  queued(f, other);
  const before = log.getSession(f.session.id)!.metadata[log.HELD_STOP_PUBLICATION_METADATA_KEY];
  const sweep = claimPendingAsyncReadRefinementRecoveries();
  assert.equal(sweep.claimed, 1); assert.equal(sweep.claims[0]!.sourceUserSeq, other.seq);
  assert.equal(HostRecoveryState.fromString(HarnessSession.load(f.session.id)!.loadRecoveryState()!).sourceUserSeq, other.seq);
  assert.deepEqual(log.getSession(f.session.id)!.metadata[log.HELD_STOP_PUBLICATION_METADATA_KEY], before);
});

test('held publication async recovery guarded update refuses a producer transfer after queue selection', () => {
  const f = fixture(); queued(f); const original = HostRecoveryState.fromString.bind(HostRecoveryState); let transfers = 0;
  const method = mock.method(HostRecoveryState, 'fromString', (blob: string) => {
    const state = original(blob);
    if (transfers++ === 0) publication.sealHeldStopPublication(f.ticket);
    return state;
  });
  try {
    const sweep = claimPendingAsyncReadRefinementRecoveries();
    assert.equal(sweep.scanned, 1); assert.equal(sweep.claimed, 0); assert.equal(sweep.replayed, 1);
    assert.equal(HarnessSession.load(f.session.id)!.loadRecoveryState(), null);
    assert.equal(publication.heldStopPublicationOwnsSource(f.session.id, f.source.seq), true);
  } finally { method.mock.restore(); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-held-publication-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const log = await import('./eventlog.js');
const publication = await import('./held-stop-publication.js');
const { HostRecoveryState } = await import('./host-turn-runner.js');
const { HarnessSession } = await import('./session.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId, presentationEventForOutcome } = await import('./turn-outcome.js');
const authority = await import('./accepted-turn-call-authority.js');
const dispatch = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./logical-call-contract.js');
const KEY = log.HELD_STOP_PUBLICATION_METADATA_KEY;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
let serial = 0;
test.after(() => { log.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

function fixture(id?: string) {
  const row = log.createSession({ id: id ?? `held-publication-${serial + 1}`, kind: 'chat', userId: 'fixture-owner',
    metadata: { source: 'desktop', channelId: `fixture-${++serial}`, unrelated: 'retained' } });
  const source = log.appendEvent({ sessionId: row.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Finish the local fixture and report what remains.' } });
  const attempt = log.beginRunAttempt(row.id, { runId: `fixture-held-${serial}` });
  log.bindRunAttemptSourceUserEvent(attempt, source.seq);
  const session = HarnessSession.load(row.id)!;
  const blob = new HostRecoveryState(row.id, source.seq, 'admit',
    [{ role: 'user', content: source.data.text }] as never,
    [{ type: 'function_call', callId: 'fixture-call', name: 'session_history', arguments: '{"limit":5}' }] as never,
    [], undefined, undefined, 'host_v1_read_only', undefined, 0).toString();
  HostRecoveryState.fromString(blob);
  session.saveRecoveryState(blob);
  const ticket = publication.observeHeldStopPublicationOwner({ sessionId: row.id, sourceUserSeq: source.seq,
    runAttemptId: attempt.attemptId });
  assert.ok(ticket);
  // Simulate the exact observed recovery activation dropping its checkpoint.
  session.clearRecoveryState();
  return { sessionId: row.id, sourceUserSeq: source.seq, turn: source.turn, attempt, source, ticket: ticket!, blob,
    acceptedTaskId: identities.acceptedTaskIdFor(row.id, source.seq) };
}
function debt(f: ReturnType<typeof fixture>) {
  return (log.getSession(f.sessionId)!.metadata[KEY] as Record<string, any> | undefined)?.[String(f.sourceUserSeq)];
}
function terminals(f: ReturnType<typeof fixture>) {
  return log.listEvents(f.sessionId, { types: ['conversation_completed'] }).filter(e => e.data.sourceUserSeq === f.sourceUserSeq);
}
function adapter(calls: { value: number }, before?: () => void): publication.HeldStopPublicationAdapter {
  return { isExecuting: () => false, commit(identity, text) {
    calls.value++; before?.();
    commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'blocked', resumable: true,
      presentation: { kind: 'blocked', text } }, { legacyReason: 'blocked', metadata: { blockedReason: 'held_turn_recovery_failed' } });
  } };
}
function openRead(f: ReturnType<typeof fixture>) {
  const armed = authority.armHostReadOnlyCallAuthority({ sessionId: f.sessionId, sourceUserSeq: f.sourceUserSeq,
    surfaceVersion: 'configured_harness_tools_v1', catalogRevisionDigest: hash('catalog'), bindingRevisionDigest: hash('binding'),
    maxLogicalCalls: 8, maxParallelCalls: 4 });
  assert.equal(armed.status, 'armed');
  const loaded = authority.acceptedTurnCallAuthorityFor(f.sessionId, f.sourceUserSeq);
  assert.equal(loaded.status, 'ok'); if (loaded.status !== 'ok') throw new Error(loaded.reason);
  const logicalToolCallId = `fixture-read-${serial}`; const tool = 'session_history'; const args = { limit: 5 };
  const contract = contracts.durableLogicalCallContract(f.acceptedTaskId, tool, args)!;
  const crossing = authority.withHostReadOnlyCallAttestation({ sessionId: f.sessionId, sourceUserSeq: f.sourceUserSeq,
    acceptedTaskId: f.acceptedTaskId, sourceEventId: loaded.authority.sourceEventId, sourceEventDigest: loaded.authority.sourceEventDigest,
    logicalToolCallId, toolName: contract.toolName, argumentDigest: contract.argumentDigest,
    engineVersion: loaded.authority.engineVersion, surfaceVersion: loaded.authority.surfaceVersion,
    authorityDigest: loaded.authority.authorityDigest, authorityRevision: loaded.authority.revision,
    surfaceDigest: loaded.authority.surfaceDigest, catalogRevisionDigest: loaded.authority.catalogRevisionDigest!,
    bindingRevisionDigest: loaded.authority.bindingRevisionDigest! }, () => {
    assert.equal(dispatch.admitLogicalCall({ identity: { ...f, logicalToolCallId }, tool, args }).status, 'inserted');
    return dispatch.beginPhysicalDispatch({ identity: { ...f, logicalToolCallId, physicalDispatchId: `physical-${serial}`, ordinal: 0 },
      tool, args, executionSite: 'host' });
  });
  assert.equal(crossing.status, 'inserted'); if (crossing.status !== 'inserted') throw new Error(crossing.status);
  return { logicalToolCallId, tool, args, crossing };
}
function settleRead(f: ReturnType<typeof fixture>, read: ReturnType<typeof openRead>) {
  assert.equal(dispatch.settlePhysicalDispatch({ identity: read.crossing.identity, tool: read.tool, outcome: 'returned' }).status, 'inserted');
  assert.equal(settlements.commitLogicalCallSettlement({ identity: { ...f, logicalToolCallId: read.logicalToolCallId },
    contract: { toolName: read.tool, args: read.args }, execution: { kind: 'local_execution' },
    result: { payload: { records: [{ id: 'retained-record' }] } }, outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false }, observer: { lane: 'agents_runner', callId: read.logicalToolCallId, turn: f.turn } }).status, 'committed');
}

test('held publication requires an observed exact checkpoint owner and never accepts a minted ticket', () => {
  const f = fixture();
  assert.throws(() => publication.sealHeldStopPublication({} as never), /forged/);
  assert.equal(publication.observeHeldStopPublicationOwner({ sessionId: f.sessionId, sourceUserSeq: f.sourceUserSeq }), null);
  assert.equal(debt(f), undefined);
  publication.sealHeldStopPublication(f.ticket, 1000);
  assert.equal(debt(f).attemptsUsed, 0);
  assert.equal(debt(f).origin.attemptId, f.attempt.attemptId);
  assert.equal(debt(f).origin.sourceEventId, f.source.id);
  assert.equal(publication.heldStopPublicationOwnsSource(f.sessionId, f.sourceUserSeq), true);
  assert.equal(publication.heldStopPublicationOwnsSource(f.sessionId, f.sourceUserSeq + 999), false);
});

test('held publication known open-call waits spend no allowance and do not sweep; canonical settlement preserves the receipt', () => {
  const f = fixture(); const read = openRead(f); publication.sealHeldStopPublication(f.ticket, 1000);
  const calls = { value: 0 }; const port = adapter(calls);
  for (let i = 0; i < 12; i++) assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, port, 1000 + i * 60_000), 'held');
  assert.equal(calls.value, 0); assert.equal(debt(f).attemptsUsed, 0);
  assert.equal(dispatch.logicalCallAuthorityState({ ...f, logicalToolCallId: read.logicalToolCallId }).status, 'open');
  assert.equal(log.openEventLog().prepare('SELECT state FROM physical_dispatches WHERE physical_dispatch_id=?').get(read.crossing.identity.physicalDispatchId)?.state, 'started');
  settleRead(f, read);
  const receiptsBefore = log.openEventLog().prepare('SELECT * FROM logical_call_settlements WHERE session_id=?').all(f.sessionId);
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, port, 800_000), 'published');
  assert.equal(calls.value, 1); assert.equal(terminals(f).length, 1); assert.equal(debt(f), undefined);
  assert.deepEqual(log.openEventLog().prepare('SELECT * FROM logical_call_settlements WHERE session_id=?').all(f.sessionId), receiptsBefore);
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, port, 900_000), 'absent');
  assert.equal(calls.value, 1); assert.equal(terminals(f)[0]!.data.presentation.identity.attemptId, f.attempt.attemptId);
});

test('held publication charges before callback, shares one finite allowance across restart, and never revives after exhaustion', () => {
  const f = fixture(); publication.sealHeldStopPublication(f.ticket, 1000); const calls = { value: 0 };
  const port: publication.HeldStopPublicationAdapter = { isExecuting: () => false, commit() { calls.value++; throw new Error('private storage failure'); } };
  for (let i = 0; i < 4; i++) {
    assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, port, 1000 + i * 60_000), 'held');
    assert.equal(debt(f).attemptsUsed, i + 1);
  }
  // Real new process: no WeakMap, cursor or callback-local counter survives.
  log.closeEventLog();
  const leaf = pathToFileURL(path.resolve('src/runtime/harness/held-stop-publication.ts')).href;
  const store = pathToFileURL(path.resolve('src/runtime/harness/eventlog.ts')).href;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const p=await import(${JSON.stringify(leaf)}); const e=await import(${JSON.stringify(store)});
    let calls=0; const port={isExecuting:()=>false,commit:()=>{calls++;throw new Error('refused')}};
    for(let i=4;i<10;i++) p.drainHeldStopPublication(${JSON.stringify(f.sessionId)},${f.sourceUserSeq},port,1000+i*60000);
    const debt=e.getSession(${JSON.stringify(f.sessionId)}).metadata[${JSON.stringify(KEY)}][${JSON.stringify(String(f.sourceUserSeq))}];
    console.log(JSON.stringify({calls,used:debt.attemptsUsed,state:debt.state}));e.closeEventLog();
  `], { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, CLEMENTINE_HOME: HOME, CLEMMY_TEST_ISOLATED_HOME: '1' } });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout.trim()), { calls: 4, used: 8, state: 'parked' });
  assert.equal(calls.value, 4); assert.equal(debt(f).attemptsUsed, 8);
  const ready = { value: 0 };
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(ready), 9_000_000), 'held');
  assert.equal(ready.value, 0); assert.equal(terminals(f).length, 0);
  publication.sealHeldStopPublication(f.ticket, 9_000_000);
  assert.equal(debt(f).attemptsUsed, 8, 'the same producer cannot reset its spent allowance');
  adapter({ value: 0 }).commit({ sessionId: f.sessionId, sourceUserSeq: f.sourceUserSeq, turn: f.turn,
    attemptId: f.attempt.attemptId, runId: f.attempt.runId! }, 'A separately committed exact stop. Check what remains.');
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(ready), 9_000_000), 'acknowledged');
  assert.equal(ready.value, 0); assert.equal(terminals(f).length, 1);
});

test('held publication charge failure invokes nothing; terminal and acknowledgement roll back atomically', () => {
  const f = fixture(); publication.sealHeldStopPublication(f.ticket, 1000); const calls = { value: 0 }; const db = log.openEventLog();
  db.exec(`CREATE TEMP TRIGGER refuse_charge BEFORE UPDATE OF metadata_json ON sessions
    WHEN NEW.id='${f.sessionId}' AND json_extract(NEW.metadata_json,'$.${KEY}."${f.sourceUserSeq}".attemptsUsed')>0
    BEGIN SELECT RAISE(ABORT,'fixture charge failure'); END`);
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(calls), 1000), 'held');
  assert.equal(calls.value, 0); assert.equal(debt(f).attemptsUsed, 0); db.exec('DROP TRIGGER refuse_charge');
  db.exec(`CREATE TEMP TRIGGER refuse_ack BEFORE UPDATE OF metadata_json ON sessions
    WHEN NEW.id='${f.sessionId}' AND json_type(OLD.metadata_json,'$.${KEY}."${f.sourceUserSeq}"') IS NOT NULL
      AND json_type(NEW.metadata_json,'$.${KEY}."${f.sourceUserSeq}"') IS NULL
    BEGIN SELECT RAISE(ABORT,'fixture ack failure'); END`);
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(calls), 1000), 'held');
  assert.equal(calls.value, 1); assert.equal(debt(f).attemptsUsed, 1); assert.equal(terminals(f).length, 0);
  assert.equal(log.getLatestRunAttempt(f.sessionId)!.finishedAt, null);
  db.exec('DROP TRIGGER refuse_ack');
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(calls), 2000), 'published');
  assert.equal(calls.value, 2); assert.equal(terminals(f).length, 1); assert.equal(debt(f), undefined);
});

test('held publication validates and acknowledges an independently committed exact winner without another callback', () => {
  const f = fixture(); publication.sealHeldStopPublication(f.ticket, 1000); const calls = { value: 0 };
  adapter({ value: 0 }).commit({ sessionId: f.sessionId, sourceUserSeq: f.sourceUserSeq, turn: f.turn,
    attemptId: f.attempt.attemptId, runId: f.attempt.runId! }, 'The exact request is blocked. Check what remains.');
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(calls), 1000), 'acknowledged');
  assert.equal(calls.value, 0); assert.equal(debt(f), undefined); assert.equal(terminals(f).length, 1);
});

test('held publication a callback race cannot consume another revision or keep a rolled-back terminal', () => {
  const f = fixture(); publication.sealHeldStopPublication(f.ticket, 1000); const calls = { value: 0 };
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(calls, () => {
    const value = log.getSession(f.sessionId)!.metadata;
    (value[KEY] as any)[String(f.sourceUserSeq)].revision++;
    log.openEventLog().prepare('UPDATE sessions SET metadata_json=? WHERE id=?').run(JSON.stringify(value), f.sessionId);
  }), 1000), 'held');
  assert.equal(debt(f).revision, 2); assert.equal(debt(f).attemptsUsed, 1); assert.equal(terminals(f).length, 0);
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(calls), 2000), 'published');
  assert.equal(terminals(f).length, 1);
});

test('held publication refuses changed same-source attempt or audience and leaves a different source independent', () => {
  const changed = fixture(); publication.sealHeldStopPublication(changed.ticket, 1000);
  const newer = log.beginRunAttempt(changed.sessionId, { runId: 'new-same-source' }); log.bindRunAttemptSourceUserEvent(newer, changed.sourceUserSeq);
  const calls = { value: 0 };
  assert.equal(publication.drainHeldStopPublication(changed.sessionId, changed.sourceUserSeq, adapter(calls), 1000), 'held');
  assert.equal(debt(changed).attemptsUsed, 0); assert.equal(calls.value, 0);
  const f = fixture(); publication.sealHeldStopPublication(f.ticket, 1000);
  const other = log.appendEvent({ sessionId: f.sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'An independent request.' } });
  const otherAttempt = log.beginRunAttempt(f.sessionId, { runId: 'different-source' }); log.bindRunAttemptSourceUserEvent(otherAttempt, other.seq);
  log.updateSession(f.sessionId, { metadata: { ...log.getSession(f.sessionId)!.metadata, runInFlight: otherAttempt.runId } });
  assert.equal(publication.heldStopPublicationOwnsSource(f.sessionId, other.seq), false);
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(calls), 1000), 'published');
  assert.equal(log.getLatestRunAttempt(f.sessionId)!.attemptId, otherAttempt.attemptId);
  assert.equal(log.getLatestRunAttempt(f.sessionId)!.finishedAt, null);
  assert.equal(log.getSession(f.sessionId)!.metadata.runInFlight, otherAttempt.runId);
  const wrongAudience = fixture(); publication.sealHeldStopPublication(wrongAudience.ticket, 1000);
  log.updateSession(wrongAudience.sessionId, { metadata: { ...log.getSession(wrongAudience.sessionId)!.metadata, channelId: 'foreign-audience' } });
  assert.equal(publication.drainHeldStopPublication(wrongAudience.sessionId, wrongAudience.sourceUserSeq, adapter(calls), 1000), 'held');
  assert.equal(debt(wrongAudience).attemptsUsed, 0);
});

test('held publication retained checkpoint, active owner and live lease wait without credit or dispatch', () => {
  const f = fixture(); publication.sealHeldStopPublication(f.ticket, 1000); const calls = { value: 0 };
  HarnessSession.load(f.sessionId)!.saveRecoveryState(f.blob);
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(calls), 1000), 'held');
  HarnessSession.load(f.sessionId)!.clearRecoveryState();
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, { ...adapter(calls), isExecuting: () => true }, 1000), 'held');
  log.openEventLog().prepare('UPDATE run_attempts SET lease_owner=?,lease_expires_at=? WHERE attempt_id=?')
    .run('fixture-lease', new Date(100_000).toISOString(), f.attempt.attemptId);
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(calls), 1000), 'held');
  assert.equal(calls.value, 0); assert.equal(debt(f).attemptsUsed, 0);
});

test('held publication corrupt and JSON-null metadata stay held, while absent storage never mints responsibility', () => {
  for (const variant of ['broken', 'null', 'array', 'namespace-null', 'debt-invalid']) {
    const f = fixture(); publication.sealHeldStopPublication(f.ticket, 1000);
    const invalid = variant === 'broken' ? '{' : variant === 'null' ? 'null' : variant === 'array' ? '[]'
      : variant === 'namespace-null' ? JSON.stringify({ [KEY]: null })
      : JSON.stringify({ [KEY]: { [String(f.sourceUserSeq)]: { attemptsUsed: 0 } } });
    log.openEventLog().prepare('UPDATE sessions SET metadata_json=? WHERE id=?').run(invalid, f.sessionId);
    const calls = { value: 0 };
    assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(calls), 1000), 'held');
    assert.equal(calls.value, 0);
    if (!invalid.includes('attemptsUsed')) assert.equal(publication.heldStopPublicationOwnsSource(f.sessionId, f.sourceUserSeq), true);
  }
  const f = fixture();
  assert.throws(() => log.openEventLog().prepare('UPDATE sessions SET metadata_json=NULL WHERE id=?').run(f.sessionId), /NOT NULL/);
  log.openEventLog().prepare("UPDATE sessions SET metadata_json='{}' WHERE id=?").run(f.sessionId);
  assert.equal(publication.heldStopPublicationOwnsSource(f.sessionId, f.sourceUserSeq), false);
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter({ value: 0 }), 1000), 'absent');
});

test('held publication a revision changed before the durable charge refuses the stale callback', () => {
  const f = fixture(); publication.sealHeldStopPublication(f.ticket, 1000); let calls = 0; let changed = false;
  const port: publication.HeldStopPublicationAdapter = { isExecuting() {
    if (!changed) {
      changed = true; const meta = log.getSession(f.sessionId)!.metadata;
      (meta[KEY] as any)[String(f.sourceUserSeq)].revision++;
      log.openEventLog().prepare('UPDATE sessions SET metadata_json=? WHERE id=?').run(JSON.stringify(meta), f.sessionId);
    }
    return false;
  }, commit() { calls++; } };
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, port, 1000), 'held');
  assert.equal(calls, 0); assert.equal(debt(f).attemptsUsed, 0); assert.equal(debt(f).revision, 2);
});

test('held publication will not acknowledge a typed-looking winner whose canonical call authority is still open', () => {
  const f = fixture(); const read = openRead(f); publication.sealHeldStopPublication(f.ticket, 1000);
  const identity = { sessionId: f.sessionId, sourceUserSeq: f.sourceUserSeq, turn: f.turn, attemptId: f.attempt.attemptId };
  const presentation = presentationEventForOutcome({ version: 2, id: turnOutcomeId(identity), identity,
    status: 'blocked', resumable: true, presentation: { kind: 'blocked', text: 'Forged retained terminal.' } });
  const db = log.openEventLog();
  db.prepare('INSERT INTO events (id,session_id,turn,role,type,data_json,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(`forged-${f.sessionId}`, f.sessionId, f.turn, 'system', 'conversation_completed',
      JSON.stringify({ sourceUserSeq: f.sourceUserSeq, reason: 'blocked', presentation, terminalKey: `turn:${f.sourceUserSeq}` }), new Date().toISOString());
  const calls = { value: 0 };
  assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(calls), 1000), 'held');
  assert.equal(calls.value, 0); assert.equal(debt(f).attemptsUsed, 0);
  assert.equal(dispatch.logicalCallAuthorityState({ ...f, logicalToolCallId: read.logicalToolCallId }).status, 'open');
});

test('held publication releases only a positively superseded ticket and leaves the newer owner and credit untouched', () => {
  const f = fixture(); const next = log.beginRunAttempt(f.sessionId, { runId: 'sealer-new-owner' });
  log.bindRunAttemptSourceUserEvent(next, f.sourceUserSeq);
  assert.throws(() => publication.sealHeldStopPublication(f.ticket, 1000), publication.HeldStopPublicationSupersededError);
  assert.equal(debt(f), undefined);
  assert.equal(publication.heldStopPublicationOwnsSource(f.sessionId, f.sourceUserSeq), false);
  assert.equal(publication.heldStopPublicationHoldsExecutionSource(f.sessionId, f.sourceUserSeq), false);
  assert.equal(log.getLatestRunAttempt(f.sessionId)!.attemptId, next.attemptId);
  assert.equal(log.getLatestRunAttempt(f.sessionId)!.finishedAt, null); assert.equal(terminals(f).length, 0);
});

test('held publication current-owner persistence failure retains its exact fence without claiming durable transfer', () => {
  const f = fixture(); const db = log.openEventLog();
  db.exec(`CREATE TEMP TRIGGER refuse_intent BEFORE UPDATE OF metadata_json ON sessions
    WHEN NEW.id='${f.sessionId}' AND json_type(NEW.metadata_json,'$.${KEY}') IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'fixture intent unavailable'); END`);
  assert.throws(() => publication.sealHeldStopPublication(f.ticket, 1000), /intent unavailable/);
  assert.equal(debt(f), undefined); assert.equal(publication.heldStopPublicationOwnsSource(f.sessionId, f.sourceUserSeq), true);
  assert.equal(publication.heldStopPublicationHoldsExecutionSource(f.sessionId, f.sourceUserSeq), true);
  assert.equal(log.getLatestRunAttempt(f.sessionId)!.attemptId, f.attempt.attemptId);
  db.exec('DROP TRIGGER refuse_intent'); publication.sealHeldStopPublication(f.ticket, 1000);
  assert.equal(debt(f).attemptsUsed, 0); assert.equal(terminals(f).length, 0);
});

test('held publication late older ticket cannot overwrite or clear a newer failed-persistence fence', () => {
  for (const failOlderFirst of [false, true]) {
    const f = fixture(); const db = log.openEventLog();
    db.exec(`CREATE TEMP TRIGGER refuse_two_ticket_intent BEFORE UPDATE OF metadata_json ON sessions
      WHEN NEW.id='${f.sessionId}' AND json_type(NEW.metadata_json,'$.${KEY}') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'fixture two-ticket intent unavailable'); END`);
    try {
      if (failOlderFirst) assert.throws(() => publication.sealHeldStopPublication(f.ticket, 1000), /intent unavailable/);
      const next = log.beginRunAttempt(f.sessionId, { runId: `newer-two-ticket-${serial}` }); log.bindRunAttemptSourceUserEvent(next, f.sourceUserSeq);
      HarnessSession.load(f.sessionId)!.saveRecoveryState(f.blob);
      const newerTicket = publication.observeHeldStopPublicationOwner({ sessionId: f.sessionId, sourceUserSeq: f.sourceUserSeq,
        runAttemptId: next.attemptId })!;
      assert.ok(newerTicket); HarnessSession.load(f.sessionId)!.clearRecoveryState();
      assert.throws(() => publication.sealHeldStopPublication(newerTicket, 1000), /intent unavailable/);
      assert.throws(() => publication.sealHeldStopPublication(f.ticket, 1000), publication.HeldStopPublicationSupersededError);
      assert.equal(publication.heldStopPublicationOwnsSource(f.sessionId, f.sourceUserSeq), true,
        'the newer owner still owes a persisted transfer despite the late older ticket');
      assert.equal(publication.heldStopPublicationHoldsExecutionSource(f.sessionId, f.sourceUserSeq), true);
      assert.equal(debt(f), undefined); assert.equal(log.getLatestRunAttempt(f.sessionId)!.attemptId, next.attemptId);
      db.exec('DROP TRIGGER refuse_two_ticket_intent'); publication.sealHeldStopPublication(newerTicket, 1000);
      assert.equal(debt(f).origin.attemptId, next.attemptId); assert.equal(debt(f).attemptsUsed, 0);
      const calls = { value: 0 };
      assert.equal(publication.drainHeldStopPublication(f.sessionId, f.sourceUserSeq, adapter(calls), 1000), 'published');
      assert.equal(calls.value, 1); assert.equal(publication.heldStopPublicationOwnsSource(f.sessionId, f.sourceUserSeq), false);
    } finally { db.exec('DROP TRIGGER IF EXISTS refuse_two_ticket_intent'); }
  }
});

test('held publication direct execution and generic restart recovery cannot reopen the owned source', async () => {
  const f = fixture();
  // Arm the genuine source/attempt marker before ownership transfer.
  log.recordRunAttemptUserInput(f.attempt, { turn: f.turn, role: 'user', data: f.source.data },
    { existingEventSeq: f.sourceUserSeq, armRunInFlight: true });
  publication.sealHeldStopPublication(f.ticket, Date.now());
  const { runConversation } = await import('./loop.js');
  let executions = 0;
  const result = await runConversation({ sessionId: f.sessionId, input: String(f.source.data.text), sourceUserSeq: f.sourceUserSeq,
    reuseRecordedUserInput: true, runAttemptId: f.attempt.attemptId, agent: {} as never,
    runRunner: (async () => { executions++; throw new Error('executor must not run'); }) as never });
  assert.equal(result.status, 'held'); assert.equal(result.steps, 0); assert.equal(executions, 0);
  const { recoverInterruptedChatRuns } = await import('./restart-recovery.js');
  let dispatches = 0;
  const summary = recoverInterruptedChatRuns(() => Date.now() + 120_000,
    (() => { dispatches++; }) as never, { bootCutoffMs: Date.now() + 120_000 });
  const record = summary.records.find(r => r.sessionId === f.sessionId);
  assert.ok(record?.errors.includes('publication_only_owner_pending'));
  assert.equal(dispatches, 0); assert.equal(terminals(f).length, 0); assert.equal(debt(f).attemptsUsed, 0);
});

test('held publication rotating drain advances past nine malformed sessions to a later valid owner', () => {
  for (let i = 0; i < 9; i++) {
    const row = log.createSession({ id: `a-held-malformed-${i}`, kind: 'chat' });
    log.openEventLog().prepare('UPDATE sessions SET metadata_json=? WHERE id=?').run('{', row.id);
  }
  const f = fixture('b-held-valid-owner'); publication.sealHeldStopPublication(f.ticket, 1000);
  const calls = { value: 0 }; const port = { ...adapter(calls), isExecuting: (id: string) => id !== f.sessionId };
  assert.equal(publication.drainHeldStopPublications(port, 1000), 0);
  assert.equal(publication.drainHeldStopPublications(port, 1000), 1, 'a full malformed page cannot reset the cursor ahead of valid responsibility');
  assert.equal(calls.value, 1); assert.equal(terminals(f).length, 1); assert.equal(debt(f), undefined);
});

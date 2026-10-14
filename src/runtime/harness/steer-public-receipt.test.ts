import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-steer-receipt-'));
process.env.CLEMENTINE_HOME = home; process.env.CLEMMY_HOME = home;
const log = await import('./eventlog.js');
const { projectHarnessEventForPublic } = await import('./public-presentation.js');
const { reconstructHarnessTranscript } = await import('./transcript.js');
after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const session = log.createSession({ kind: 'chat', channel: 'desktop', title: 'Synthetic receipt' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Synthetic task' } });
  const note = log.appendEvent({ sessionId: session.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: 'Synthetic addition', clientRequestId: 'synthetic-note-key' } });
  return { session, source, note };
}
function terminal(f: ReturnType<typeof fixture>) {
  const id = `turn:${f.source.seq}`;
  return log.appendEvent({ sessionId: f.session.id, turn: 1, role: 'Clem', type: 'conversation_completed', data: {
    sourceUserSeq: f.source.seq, logicalTerminalVersion: 1, terminalKey: id, reply: 'Synthetic unfinished work',
    presentation: { version: 1, id: `${id}:presentation`, outcomeId: id, audience: 'user', phase: 'final',
      identity: { sessionId: f.session.id, turn: 1, sourceUserSeq: f.source.seq }, status: 'blocked', kind: 'blocked',
      text: 'Synthetic unfinished work', resumable: true },
    turnOutcome: { version: 2, id, status: 'blocked', resumable: true },
  } });
}

test('public steer receipt: acceptance is not adoption and canonical adoption produces only a bounded presentation receipt', () => {
  const f = fixture();
  const accepted = projectHarnessEventForPublic(f.note)!;
  assert.equal((accepted.data.steerReceipt as any)?.state, 'accepted');
  assert.equal((accepted.data.steerReceipt as any)?.sourceUserSeq, f.source.seq);
  assert.equal((accepted.data.steerReceipt as any)?.noteSeq, f.note.seq);
  const delivery = log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'system', type: 'user_steer_note_delivered',
    data: { sourceUserSeq: f.source.seq, noteSeqs: [f.note.seq], privateToken: 'PRIVATE_DATA' } });
  const projected = projectHarnessEventForPublic(delivery)!;
  assert.equal(projected.type, 'user_steer_receipt');
  assert.equal((projected.data.receipts as any[])?.[0]?.state, 'adopted');
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_DATA|noteSeqs|user_steer_note_delivered/);
  const stopped = projectHarnessEventForPublic(terminal(f))!;
  assert.equal((stopped.data.steerReceipts as any[])?.[0]?.state, 'adopted', 'a stop does not erase host adoption or imply fulfillment');
  const reopened = reconstructHarnessTranscript(f.session.id).filter(row => row.role === 'user');
  assert.equal(reopened.length, 2, 'durable note survives reopen without becoming another accepted turn');
  assert.equal((reopened[1] as any)?.steerReceipt?.state, 'adopted');
});

test('public steer receipt: stopped-before-adoption retains the exact note as unhandled', () => {
  const f = fixture(); const stopped = projectHarnessEventForPublic(terminal(f))!;
  assert.equal((stopped.data.steerReceipts as any[])?.[0]?.state, 'unhandled');
  assert.equal((projectHarnessEventForPublic(f.note)!.data.steerReceipt as any)?.state, 'unhandled');
  const userRows = reconstructHarnessTranscript(f.session.id).filter(row => row.role === 'user');
  assert.equal((userRows[1] as any)?.steerReceipt?.noteSeq, f.note.seq);
  assert.equal(log.listEvents(f.session.id, { types: ['user_input_received'] }).length, 1);
});

test('public steer receipt: foreign, wrong-source, later-source and malformed delivery cannot claim adoption', () => {
  for (const kind of ['foreign', 'source', 'later', 'malformed']) {
    const f = fixture();
    if (kind === 'later') log.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Second synthetic task' } });
    const other = kind === 'foreign' ? fixture() : f;
    const delivery = log.appendEvent({ sessionId: other.session.id, turn: 0, role: 'system', type: 'user_steer_note_delivered',
      data: { sourceUserSeq: kind === 'source' ? f.note.seq : f.source.seq, noteSeqs: kind === 'malformed' ? [String(f.note.seq)] : [f.note.seq] } });
    const projection = projectHarnessEventForPublic(delivery);
    assert.equal(projection, null);
    assert.notEqual((projectHarnessEventForPublic(f.note)!.data.steerReceipt as any)?.state, 'adopted');
  }
});

test('public steer receipt: an unmanaged transaction and rollback never publish accepted or adopted acknowledgements', async () => {
  const f = fixture(); const { actionBus } = await import('../action-bus.js');
  const publicEvents: Array<any> = [];
  const detach = actionBus.subscribe(event => { if (event.kind === 'harness.public_event' && event.sessionId === f.session.id) publicEvents.push(event.event); });
  try {
    assert.throws(() => log.openEventLog().transaction(() => {
      const note = log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: 'Rolled-back synthetic addition', clientRequestId: 'rollback-key' } });
      assert.equal(projectHarnessEventForPublic(note)?.data.steerReceipt, undefined, 'same-connection visibility is not commit proof');
      throw new Error('synthetic rollback');
    })(), /synthetic rollback/);
    assert.throws(() => log.openEventLog().transaction(() => {
      const delivery = log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'system', type: 'user_steer_note_delivered',
        data: { sourceUserSeq: f.source.seq, noteSeqs: [f.note.seq] } });
      assert.equal(projectHarnessEventForPublic(delivery), null);
      throw new Error('synthetic rollback');
    })(), /synthetic rollback/);
    await Promise.resolve();
    assert.equal(publicEvents.filter(event => event.type === 'user_steer_receipt' || event.data.steerReceipt).length, 0);
    assert.equal((projectHarnessEventForPublic(f.note)!.data.steerReceipt as any)?.state, 'accepted');
  } finally { detach(); }
});

test('public steer receipt: adoption after a terminal or duplicate markers cannot rewrite historical handling', () => {
  const f = fixture(); const ended = terminal(f);
  const late = log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'system', type: 'user_steer_note_delivered',
    data: { sourceUserSeq: f.source.seq, noteSeqs: [f.note.seq] } });
  assert.equal(projectHarnessEventForPublic(late), null);
  const receipt = projectHarnessEventForPublic(f.note)!.data.steerReceipt as any;
  assert.equal(receipt.state, 'unhandled'); assert.equal(receipt.changedAtSeq, ended.seq);
  const g = fixture();
  const data = { sourceUserSeq: g.source.seq, noteSeqs: [g.note.seq] };
  const first = log.appendEvent({ sessionId: g.session.id, turn: 0, role: 'system', type: 'user_steer_note_delivered', data });
  const second = log.appendEvent({ sessionId: g.session.id, turn: 0, role: 'system', type: 'user_steer_note_delivered', data });
  assert.equal(projectHarnessEventForPublic(second), null);
  assert.equal((projectHarnessEventForPublic(g.note)!.data.steerReceipt as any)?.changedAtSeq, first.seq);
});

test('public steer receipt: committed unmanaged publication waits, rereads canonical bytes, and preserves nonsteer/raw ordering', async () => {
  const f = fixture(); const { actionBus } = await import('../action-bus.js');
  const observed: Array<{ kind: string; event: any }> = [];
  const detach = actionBus.subscribe(event => {
    if ((event.kind === 'harness.event' || event.kind === 'harness.public_event') && event.sessionId === f.session.id) {
      observed.push({ kind: event.kind, event: structuredClone(event.event) });
      if (event.kind === 'harness.event' && event.event.type === 'user_steer_note') event.event.data.text = 'Raw bus mutation';
    }
  });
  try {
    const note = log.openEventLog().transaction(() => {
      const note = log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: 'Canonical addition', clientRequestId: 'canonical-key' } });
      log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'system', type: 'user_steer_note_delivered', data: { sourceUserSeq: f.source.seq, noteSeqs: [note.seq] } });
      log.appendEvent({ sessionId: f.session.id, turn: 1, role: 'Clem', type: 'heartbeat', data: { kind: 'synthetic' } });
      assert.equal(observed.filter(row => row.kind === 'harness.public_event' && row.event.type === 'user_steer_note').length, 0);
      assert.ok(observed.some(row => row.kind === 'harness.event' && row.event.type === 'user_steer_note_delivered'));
      assert.ok(observed.some(row => row.kind === 'harness.public_event' && row.event.type === 'heartbeat'), 'nonsteer publication order is untouched');
      return note;
    })();
    await Promise.resolve();
    const published = observed.filter(row => row.kind === 'harness.public_event');
    assert.equal(published.find(row => row.event.type === 'user_steer_note')?.event.data.text, 'Canonical addition');
    const receipt = published.find(row => row.event.type === 'user_steer_receipt')?.event.data.receipts[0];
    assert.equal(receipt.noteSeq, note.seq); assert.equal(receipt.state, 'adopted');
    assert.equal(published.some(row => row.event.type === 'user_steer_note_delivered'), false);
  } finally { detach(); }
});

test('public steer receipt: rollback sequence reuse cannot publish the abandoned row', async () => {
  const f = fixture(); const { actionBus } = await import('../action-bus.js'); const rows: any[] = [];
  const detach = actionBus.subscribe(event => { if (event.kind === 'harness.public_event' && event.sessionId === f.session.id) rows.push(event.event); });
  let rolledBack: any;
  try {
    assert.throws(() => log.openEventLog().transaction(() => {
      rolledBack = log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: 'Abandoned addition' } });
      throw new Error('rollback');
    })(), /rollback/);
    const replacement = log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: 'Replacement addition' } });
    assert.equal(replacement.seq, rolledBack.seq); assert.notEqual(replacement.id, rolledBack.id);
    await Promise.resolve();
    assert.deepEqual(rows.filter(row => row.type === 'user_steer_note').map(row => row.data.text), ['Replacement addition']);
  } finally { detach(); }
});

test('public steer receipt: replacing or closing the captured DB skips its deferred live acknowledgement', async () => {
  const { actionBus } = await import('../action-bus.js');
  for (const reopen of [false, true]) {
    const f = fixture(); const rows: any[] = [];
    const detach = actionBus.subscribe(event => { if (event.kind === 'harness.public_event' && event.sessionId === f.session.id) rows.push(event.event); });
    try {
      log.openEventLog().transaction(() => log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: 'Closed connection addition' } }))();
      log.closeEventLog(); if (reopen) log.openEventLog();
      await Promise.resolve();
      assert.equal(rows.filter(row => row.type === 'user_steer_note' || row.type === 'user_steer_receipt').length, 0);
    } finally { detach(); }
  }
});

test('public steer receipt: more than64 adopted notes remain adopted, and an incomplete512row window stays unknown', () => {
  const f = fixture(); const notes = [f.note];
  for (let i = 1; i < 65; i++) notes.push(log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: `Synthetic addition ${i}` } }));
  const marker = log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'system', type: 'user_steer_note_delivered', data: { sourceUserSeq: f.source.seq, noteSeqs: notes.map(row => row.seq) } });
  assert.equal((projectHarnessEventForPublic(marker)?.data.receipts as any[])?.length, 64, 'live frame stays bounded');
  terminal(f);
  assert.equal((projectHarnessEventForPublic(notes[64]!)!.data.steerReceipt as any)?.state, 'adopted', 'slice64 is never negative evidence');
  const g = fixture();
  const insert = log.openEventLog().prepare(`INSERT INTO events(id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, 0, 'system', 'user_steer_note_delivered', NULL, ?, ?)`);
  log.openEventLog().transaction(() => { for (let i = 0; i < 513; i++) insert.run(`bounded-marker-${g.source.seq}-${i}`, g.session.id, JSON.stringify({ sourceUserSeq: g.source.seq, noteSeqs: [] }), new Date().toISOString()); })();
  log.appendEvent({ sessionId: g.session.id, turn: 0, role: 'system', type: 'user_steer_note_delivered', data: { sourceUserSeq: g.source.seq, noteSeqs: [g.note.seq] } });
  const ended = projectHarnessEventForPublic(terminal(g));
  assert.equal(ended?.data.steerReceipts, undefined, 'incomplete evidence never claims unhandled');
  assert.equal(projectHarnessEventForPublic(g.note)?.data.steerReceipt, undefined);
  const reopened = reconstructHarnessTranscript(g.session.id).find(row => row.text === 'Synthetic addition');
  assert.equal(reopened?.role, 'user'); assert.equal(reopened?.steerNote, true); assert.equal(reopened?.steerReceipt, undefined);
  assert.equal(reopened?.steerNoteSessionId, g.session.id); assert.equal(reopened?.steerNoteSeq, g.note.seq,
    'bounded handling evidence never removes canonical display identity');
});

test('public steer receipt: caller echo is bounded presentation metadata and cannot change canonical admission or retry identity', async () => {
  const f = fixture(); const { appendSteerNote } = await import('./steer-notes.js');
  const first = appendSteerNote(f.session.id, 'Synthetic echoed addition', { clientRequestId: 'mobile:canonical', clientEchoId: 'caller-key' });
  const retried = appendSteerNote(f.session.id, 'Changed retry text', { clientRequestId: 'mobile:canonical', clientEchoId: 'another-caller-key' });
  assert.equal(first.seq, retried.seq, 'echo does not participate in canonical idempotency');
  const saved = log.listEvents(f.session.id, { sinceSeq: first.seq - 1, throughSeq: first.seq })[0]!;
  assert.equal(saved.data.clientRequestId, 'mobile:canonical'); assert.equal(saved.data.clientEchoId, 'caller-key');
  assert.equal(saved.data.text, 'Synthetic echoed addition');
  assert.equal((projectHarnessEventForPublic(saved)!.data.steerReceipt as any)?.clientEchoId, 'caller-key');
  const invalid = appendSteerNote(f.session.id, 'Synthetic invalid echo', { clientRequestId: 'another-canonical', clientEchoId: 'https://private.invalid/capability' });
  const invalidSaved = log.listEvents(f.session.id, { sinceSeq: invalid.seq - 1, throughSeq: invalid.seq })[0]!;
  assert.equal(invalidSaved.data.clientEchoId, undefined);
  assert.equal(log.listEvents(f.session.id, { types: ['user_input_received'] }).length, 1);
});

test('public steer receipt: exact approval acknowledgement retains the original source, while malformed or new sources cannot inherit it', () => {
  for (const valid of [true, false]) {
    const f = fixture();
    log.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received',
      parentEventId: valid ? f.source.id : null, data: { synthetic: true, text: 'Synthetic approval acknowledgement',
        liveApprovalControl: { version: 1, ownerAttemptId: 'synthetic-owner', ownerSourceUserSeq: f.source.seq } } });
    const note = log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: 'Synthetic later addition' } });
    log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'system', type: 'user_steer_note_delivered',
      data: { sourceUserSeq: f.source.seq, noteSeqs: [note.seq] } });
    const receipt = projectHarnessEventForPublic(note)?.data.steerReceipt as any;
    if (valid) { assert.equal(receipt.sourceUserSeq, f.source.seq); assert.equal(receipt.state, 'adopted'); }
    else assert.equal(receipt, undefined, 'a malformed synthetic row cannot masquerade as approval control or another real source');
  }
  const f = fixture();
  const next = log.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Synthetic new accepted task' } });
  const note = log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: 'Synthetic new-source addition' } });
  log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'system', type: 'user_steer_note_delivered', data: { sourceUserSeq: f.source.seq, noteSeqs: [note.seq] } });
  const receipt = projectHarnessEventForPublic(note)?.data.steerReceipt as any;
  assert.equal(receipt.sourceUserSeq, next.seq); assert.equal(receipt.state, 'accepted');
});

test('public steer receipt: managed publication retains its existing synchronous postcommit ownership', () => {
  const f = fixture(); let observed = false;
  return import('../action-bus.js').then(({ actionBus }) => {
    const detach = actionBus.subscribe(event => {
      if (event.kind === 'harness.public_event' && event.sessionId === f.session.id && event.event.type === 'user_steer_note') {
        assert.equal(log.openEventLog().inTransaction, false); observed = true;
      }
    });
    try {
      log.withEventPublicationTransaction(() => {
        log.appendEvent({ sessionId: f.session.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: 'Managed committed addition' } });
        assert.equal(observed, false);
      });
      assert.equal(observed, true);
    } finally { detach(); }
  });
});

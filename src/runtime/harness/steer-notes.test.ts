/**
 * Run: npx tsx --test src/runtime/harness/steer-notes.test.ts
 *
 * Mid-run steering (2026-08-07): user messages reach a RUNNING turn without
 * stopping it. Pins: exactly-once delivery, chat-surface guard, the model-
 * facing block shape, and the context-not-authority framing.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-steer-notes-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { createSession, listEvents, beginRunAttempt, claimRunAttemptLease, recordRunAttemptUserInput, openEventLog, appendEvent, finishRunAttempt } = await import('./eventlog.js');
const { activateDispatchLease, revokeDispatchLease } = await import('./dispatch-lease.js');
const { armHostReadOnlyCallAuthority } = await import('./accepted-turn-call-authority.js');
const { acceptedTurnCallAuthorityFor } = await import('./accepted-turn-call-authority.js');
const approvalRegistry = await import('./approval-registry.js');
const { actionBus } = await import('../action-bus.js');
const {
  appendSteerNote,
  takeUndeliveredSteerNotes,
  formatSteerBlock,
  steerBlockForToolBoundary,
  hasUndeliveredSteerNotes,
  sessionSupportsSteering,
  closeTerminalSteering, reopenTerminalSteering, isSteerNoteAdmissionError, SteerNoteAdmissionError,
} = await import('./steer-notes.js');

after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('a steer note is delivered exactly once, in order, and durably marked', () => {
  const session = createSession({ id: 'sess-steer-once', kind: 'chat' });
  appendSteerNote(session.id, 'skip the two accounts with no email on file');
  appendSteerNote(session.id, 'and use the Q3 template');

  const first = takeUndeliveredSteerNotes(session.id);
  assert.equal(first.length, 2);
  assert.equal(first[0].text, 'skip the two accounts with no email on file');
  assert.equal(first[1].text, 'and use the Q3 template');

  // Marker is durable — a second boundary delivers nothing.
  assert.equal(takeUndeliveredSteerNotes(session.id).length, 0);
  const markers = listEvents(session.id, { types: ['user_steer_note_delivered'] });
  assert.equal(markers.length, 1);

  // A NEW note after delivery is picked up alone.
  appendSteerNote(session.id, 'actually cap it at 8 drafts');
  const second = takeUndeliveredSteerNotes(session.id);
  assert.equal(second.length, 1);
  assert.equal(second[0].text, 'actually cap it at 8 drafts');
});

test('steering is scoped to human chat surfaces — agent/cron sessions never inject', () => {
  assert.equal(sessionSupportsSteering('sess-desktop-abc'), true);
  assert.equal(sessionSupportsSteering('space-crm-dash'), true);
  assert.equal(sessionSupportsSteering('discord-123'), true);
  assert.equal(sessionSupportsSteering('agent:clementine'), false);
  assert.equal(sessionSupportsSteering('workflow:trigger-x:main'), false);
  assert.equal(sessionSupportsSteering(undefined), false);
  // The boundary composition returns '' for a non-steerable session without
  // touching the event log.
  assert.equal(steerBlockForToolBoundary('agent:clementine'), '');
});

test('the injected block carries the user words verbatim and the context-not-authority frame', () => {
  const block = formatSteerBlock([{ seq: 1, text: 'also pull the phone numbers' }]);
  assert.match(block, /MID-RUN MESSAGE FROM THE USER/);
  assert.match(block, /"also pull the phone numbers"/);
  assert.match(block, /does not replace it unless it clearly says so/i);
  assert.match(block, /normal approval path/i, 'a note never becomes a side-door around effect gates');
  assert.equal(formatSteerBlock([]), '');
});

test('boundary composition: one call takes, formats, and marks — empty when quiet', () => {
  const session = createSession({ id: 'sess-steer-boundary', kind: 'chat' });
  assert.equal(steerBlockForToolBoundary(session.id), '', 'quiet session adds zero bytes');
  appendSteerNote(session.id, 'prioritize Phoenix firms first');
  const block = steerBlockForToolBoundary(session.id);
  assert.match(block, /Phoenix firms first/);
  assert.equal(steerBlockForToolBoundary(session.id), '', 'delivered exactly once');
});

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let cutoverSerial = 0;
function acceptedCutoverOwner(nullableRun = false, beforeOwner?: (sessionId: string) => void) {
  const session = createSession({ id: `sess-terminal-cutover-${++cutoverSerial}`, kind: 'chat' });
  beforeOwner?.(session.id);
  const claimed = nullableRun ? undefined : claimRunAttemptLease({ sessionId: session.id, runId: `desktop:cutover-${cutoverSerial}`,
    ownerId: 'fixture-owner', leaseMs: 60_000 });
  if (claimed) assert.ok(claimed.attempt && claimed.claimed);
  const attempt = nullableRun ? beginRunAttempt(session.id) : claimed!.attempt!;
  const source = recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Report the retained result.' } }, { armRunInFlight: true });
  const authority = armHostReadOnlyCallAuthority({ sessionId: session.id, sourceUserSeq: source.seq,
    surfaceVersion: 'configured_harness_tools_v1', catalogRevisionDigest: hash('catalog'), bindingRevisionDigest: hash('binding'),
    maxLogicalCalls: 8, maxParallelCalls: 4 });
  assert.equal(authority.status, 'armed');
  const lease = activateDispatchLease({ sessionId: session.id, scopeId: `${session.id}:host`, runAttemptId: attempt.attemptId });
  return { session, source, attempt, owner: { sessionId: session.id, sourceUserSeq: source.seq, attemptId: attempt.attemptId, lease } };
}
function refused(work: () => unknown, code: string) {
  assert.throws(work, error => isSteerNoteAdmissionError(error) && error.code === code);
}

for (const [label, data] of [
  ['missing', {}], ['null', { text: null }], ['number', { text: 13 }],
  ['boolean', { text: true }], ['array', { text: ['private directive'] }],
  ['object', { text: { privateDirective: 'not an instruction' } }],
] as const) {
  test(`steering indexed scan: malformed ${label} input holds without coercion or partial delivery`, () => {
    const f = acceptedCutoverOwner();
    const malformed = appendEvent({ sessionId: f.session.id, turn: 1, role: 'user', type: 'user_steer_note', data });
    for (const check of [
      () => hasUndeliveredSteerNotes(f.session.id, f.source.seq),
      () => takeUndeliveredSteerNotes(f.session.id, f.source.seq, true),
      () => closeTerminalSteering(f.owner, hash('objective'), hash('obsolete draft')),
    ]) {
      assert.throws(check, error => isSteerNoteAdmissionError(error) && error.code === 'STEER_NOTE_UNAVAILABLE'
        && !error.message.includes('private directive') && !error.message.includes('privateDirective'));
    }
    assert.equal(listEvents(f.session.id, { types: ['user_steer_note_delivered'] }).length, 0);
    assert.equal(listEvents(f.session.id, { types: ['guardrail_tripped'] })
      .filter(row => row.data.kind === 'host_terminal_steering_cutover').length, 0);
    assert.equal(listEvents(f.session.id, { types: ['user_steer_note'] })[0]?.seq, malformed.seq);
    assert.equal(acceptedTurnCallAuthorityFor(f.session.id, f.source.seq).status, 'ok');
  });
}

test('steering indexed scan: a valid sibling cannot be partially delivered beside malformed input', () => {
  const f = acceptedCutoverOwner();
  const valid = appendSteerNote(f.session.id, 'Keep the settled result.');
  appendEvent({ sessionId: f.session.id, turn: 1, role: 'user', type: 'user_steer_note', data: { text: { unsupported: true } } });
  assert.equal(hasUndeliveredSteerNotes(f.session.id, f.source.seq), true);
  refused(() => takeUndeliveredSteerNotes(f.session.id, f.source.seq, true), 'STEER_NOTE_UNAVAILABLE');
  refused(() => closeTerminalSteering(f.owner, hash('objective'), hash('old draft')), 'STEER_NOTE_UNAVAILABLE');
  assert.equal(listEvents(f.session.id, { types: ['user_steer_note_delivered'] }).length, 0);
  assert.ok(listEvents(f.session.id, { types: ['user_steer_note'] }).some(row => row.seq === valid.seq));
});

test('steering indexed scan: malformed past, delivered, foreign and newer-source rows do not change this source', () => {
  const session = createSession({ id: `sess-scoped-steering-${++cutoverSerial}`, kind: 'chat' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_steer_note', data: { text: 1 } });
  const source = appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Current source.' } });
  const delivered = appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_steer_note', data: {} });
  appendEvent({ sessionId: session.id, turn: 2, role: 'system', type: 'user_steer_note_delivered', data: { noteSeqs: [delivered.seq], sourceUserSeq: source.seq } });
  appendSteerNote(session.id, '   ');
  appendEvent({ sessionId: session.id, turn: 3, role: 'user', type: 'user_input_received', data: { text: 'Newer source.' } });
  appendEvent({ sessionId: session.id, turn: 3, role: 'user', type: 'user_steer_note', data: { text: [] } });
  const foreign = createSession({ id: `${session.id}-foreign`, kind: 'chat' });
  appendEvent({ sessionId: foreign.id, turn: 1, role: 'user', type: 'user_steer_note', data: { text: null } });
  assert.equal(hasUndeliveredSteerNotes(session.id, source.seq), false);
  assert.deepEqual(takeUndeliveredSteerNotes(session.id, source.seq, true), []);
  assert.equal(listEvents(session.id, { types: ['user_steer_note_delivered'] }).length, 1);
});

test('steering indexed scan: an approval acknowledgement does not hide malformed parent-source input', () => {
  const f = acceptedCutoverOwner();
  const control = appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received',
    parentEventId: f.source.id, data: { text: 'Approve the held card.', synthetic: true,
      liveApprovalControl: { version: 1, mode: 'paused_card', approvalId: 'fixture-card',
        ownerAttemptId: f.attempt.attemptId, ownerSourceUserSeq: f.source.seq } } });
  appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_steer_note', data: { text: null } });
  refused(() => hasUndeliveredSteerNotes(f.session.id, f.source.seq), 'STEER_NOTE_UNAVAILABLE');
  refused(() => takeUndeliveredSteerNotes(f.session.id, f.source.seq, true), 'STEER_NOTE_UNAVAILABLE');
  assert.equal(acceptedTurnCallAuthorityFor(f.session.id, control.seq).status, 'missing');
  assert.equal(listEvents(f.session.id, { types: ['user_steer_note_delivered'] }).length, 0);
});

test('steering strict reader: legacy result composition keeps its original coercion and error fallback', () => {
  const number = createSession({ id: `sess-legacy-steering-${++cutoverSerial}`, kind: 'chat' });
  appendEvent({ sessionId: number.id, turn: 1, role: 'user', type: 'user_steer_note', data: { text: 13 } });
  assert.equal(takeUndeliveredSteerNotes(number.id)[0]?.text, '13', 'the default legacy reader keeps its historical coercion');
  const unavailable = createSession({ id: `sess-legacy-unavailable-${++cutoverSerial}`, kind: 'chat' });
  appendEvent({ sessionId: unavailable.id, turn: 1, role: 'user', type: 'user_steer_note', data: { text: { toString: null } } });
  const settledResult = 'Controlled operation succeeded.';
  assert.equal(settledResult + steerBlockForToolBoundary(unavailable.id), settledResult,
    'a default legacy projection error cannot replace an already-settled result');
  assert.equal(listEvents(unavailable.id, { types: ['user_steer_note_delivered'] }).length, 0);
  for (const [session, seq] of [[undefined, 1], ['workflow:unsupported:main', 1], [number.id, undefined], [number.id, 0]] as const) {
    refused(() => takeUndeliveredSteerNotes(session, seq, true), 'STEER_NOTE_UNAVAILABLE');
  }
});

for (const shape of ['accessor', 'proxy'] as const) {
  test(`steering strict reader: unsupported ${shape} text cannot run hooks or be delivered`, () => {
    const f = acceptedCutoverOwner();
    const data = { controlledSteeringShape: `${shape}-${cutoverSerial}` };
    const serialized = JSON.stringify(data);
    appendEvent({ sessionId: f.session.id, turn: 1, role: 'user', type: 'user_steer_note', data });
    let hooks = 0;
    const unsupported = shape === 'accessor'
      ? Object.defineProperty({}, 'text', { enumerable: true, get() { hooks++; return 'not a trusted directive'; } })
      : new Proxy({}, { get() { hooks++; throw new Error('must not run'); },
        getOwnPropertyDescriptor() { hooks++; throw new Error('must not run'); } });
    const originalParse = JSON.parse;
    // Event storage is real; only the selected decoder result is adversarial.
    // The reader must not treat unsupported in-memory shapes as owner words.
    JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => text === serialized
      ? unsupported : originalParse(text, reviver)) as typeof JSON.parse;
    try {
      refused(() => hasUndeliveredSteerNotes(f.session.id, f.source.seq), 'STEER_NOTE_UNAVAILABLE');
      refused(() => takeUndeliveredSteerNotes(f.session.id, f.source.seq, true), 'STEER_NOTE_UNAVAILABLE');
    } finally { JSON.parse = originalParse; }
    assert.equal(hooks, 0);
    assert.equal(listEvents(f.session.id, { types: ['user_steer_note_delivered'] }).length, 0);
  });
}

test('terminal steering: a supported null run ID closes, refuses late input, and reopens only its fresh physical generation', () => {
  const f = acceptedCutoverOwner(true);
  const actual = openEventLog().prepare('SELECT run_id FROM run_attempts WHERE attempt_id = ?')
    .get(f.attempt.attemptId) as { run_id: string | null };
  assert.equal(actual.run_id, null, 'the real caller omitted runId; none is invented');
  assert.equal(closeTerminalSteering(f.owner, hash('objective'), hash('reply')).status, 'closed');
  const closed = listEvents(f.session.id, { types: ['guardrail_tripped'] })
    .find(row => row.data.kind === 'host_terminal_steering_cutover')!.data.marker as { runId: string | null };
  assert.equal(closed.runId, null);
  refused(() => appendSteerNote(f.session.id, 'Too late.', { expectedAttemptId: f.attempt.attemptId }), 'STEER_NOTE_CUTOVER');
  refused(() => reopenTerminalSteering(f.owner), 'STEER_NOTE_CUTOVER');
  revokeDispatchLease(f.owner.lease);
  const lease = activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}:null-recovery`, runAttemptId: f.attempt.attemptId });
  const next = { ...f.owner, lease };
  reopenTerminalSteering(next);
  const note = appendSteerNote(f.session.id, 'Preserve the original objective.', { expectedAttemptId: f.attempt.attemptId });
  const pending = closeTerminalSteering(next, hash('amended objective'), hash('new reply'));
  assert.deepEqual(pending.status === 'pending' ? pending.notes.map(row => row.seq) : [], [note.seq]);
  assert.equal(closeTerminalSteering(next, hash('amended objective'), hash('new reply')).status, 'closed');
  const attempt = openEventLog().prepare('SELECT run_id, finished_at FROM run_attempts WHERE attempt_id = ?')
    .get(f.attempt.attemptId) as { run_id: null; finished_at: null };
  assert.deepEqual(attempt, { run_id: null, finished_at: null });
  assert.equal(acceptedTurnCallAuthorityFor(f.session.id, f.source.seq).status, 'ok');
});

for (const originalNull of [true, false]) {
  test(`terminal steering: changing durable run ID ${originalNull ? 'null to string' : 'string to null'} cannot hide its exact closed owner`, () => {
    const f = acceptedCutoverOwner(originalNull);
    closeTerminalSteering(f.owner, hash('objective'), hash('reply'));
    const count = listEvents(f.session.id).length;
    openEventLog().prepare('UPDATE run_attempts SET run_id = ? WHERE attempt_id = ?')
      .run(originalNull ? 'different-owned-run' : null, f.attempt.attemptId);
    refused(() => closeTerminalSteering(f.owner, hash('objective'), hash('reply')), 'STEER_NOTE_OWNER_CHANGED');
    refused(() => appendSteerNote(f.session.id, 'Not owned by this marker.', { expectedAttemptId: f.attempt.attemptId }), 'STEER_NOTE_OWNER_CHANGED');
    revokeDispatchLease(f.owner.lease);
    const lease = activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}:mismatched-run`, runAttemptId: f.attempt.attemptId });
    refused(() => reopenTerminalSteering({ ...f.owner, lease }), 'STEER_NOTE_OWNER_CHANGED');
    assert.equal(listEvents(f.session.id).length, count);
  });
}

test('terminal steering: missing run ID marker is unknown rather than explicit null', () => {
  const f = acceptedCutoverOwner(true);
  closeTerminalSteering(f.owner, hash('objective'), hash('reply'));
  openEventLog().prepare(`UPDATE sessions SET metadata_json = json_remove(metadata_json, '$.__host_terminal_steering_cutover.runId') WHERE id = ?`).run(f.session.id);
  refused(() => appendSteerNote(f.session.id, 'No implicit null.', { expectedAttemptId: f.attempt.attemptId }), 'STEER_NOTE_UNAVAILABLE');
  refused(() => closeTerminalSteering(f.owner, hash('objective'), hash('reply')), 'STEER_NOTE_UNAVAILABLE');
});

test('terminal steering: accepted-before-cutover is adopted, then new input is refused without retiring its owner', () => {
  const f = acceptedCutoverOwner();
  const before = appendSteerNote(f.session.id, 'Use French.', { clientRequestId: 'before-close', expectedAttemptId: f.attempt.attemptId });
  const first = closeTerminalSteering(f.owner, hash('objective'), hash('draft'));
  assert.equal(first.status, 'pending');
  assert.deepEqual(first.status === 'pending' ? first.notes.map(note => note.seq) : [], [before.seq]);
  assert.equal(closeTerminalSteering(f.owner, hash('objective with French'), hash('French reply')).status, 'closed');
  assert.deepEqual(appendSteerNote(f.session.id, 'same request replay', { clientRequestId: 'before-close', expectedAttemptId: f.attempt.attemptId }), before);
  const eventCount = listEvents(f.session.id).length;
  refused(() => appendSteerNote(f.session.id, 'New note.', { expectedAttemptId: f.attempt.attemptId }), 'STEER_NOTE_CUTOVER');
  assert.equal(listEvents(f.session.id).length, eventCount);
  const row = openEventLog().prepare('SELECT finished_at, status FROM run_attempts WHERE attempt_id = ?').get(f.attempt.attemptId) as { finished_at: null; status: string };
  assert.equal(row.finished_at, null);
  assert.equal(row.status, 'active', 'the negative fence is not a terminal or dispatch permission');
});

test('terminal steering: cutover-first rejects even synchronous event-observer enqueue', () => {
  const f = acceptedCutoverOwner();
  let observed = false;
  const detach = actionBus.subscribe(event => {
    if (event.kind === 'harness.event' && event.sessionId === f.session.id && event.event.type === 'guardrail_tripped'
      && event.event.data.kind === 'host_terminal_steering_cutover') {
      refused(() => appendSteerNote(f.session.id, 'Too late.', { expectedAttemptId: f.attempt.attemptId }), 'STEER_NOTE_CUTOVER');
      observed = true;
    }
  });
  try { assert.equal(closeTerminalSteering(f.owner, hash('objective'), hash('reply')).status, 'closed'); }
  finally { detach(); }
  assert.equal(observed, true);
  assert.equal(listEvents(f.session.id, { types: ['user_steer_note'] }).length, 0);
});

test('terminal steering: failed publication can reopen only the same owner under a fresh physical generation', () => {
  const f = acceptedCutoverOwner();
  closeTerminalSteering(f.owner, hash('objective'), hash('reply'));
  const nextLease = activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}:recovery`, runAttemptId: f.attempt.attemptId });
  const next = { ...f.owner, lease: nextLease };
  refused(() => reopenTerminalSteering(next), 'STEER_NOTE_CUTOVER');
  revokeDispatchLease(f.owner.lease);
  reopenTerminalSteering(next);
  reopenTerminalSteering(next);
  const note = appendSteerNote(f.session.id, 'Recover with this clarification.', { expectedAttemptId: f.attempt.attemptId });
  const result = closeTerminalSteering(next, hash('new objective'), hash('new reply'));
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.status === 'pending' ? result.notes.map(n => n.seq) : [], [note.seq]);
  assert.equal(closeTerminalSteering(next, hash('new objective'), hash('new reply')).status, 'closed');
  refused(() => appendSteerNote(f.session.id, 'After recovery cutover.'), 'STEER_NOTE_CUTOVER');
});

test('terminal steering: published, foreign-source, stale-generation and terminal owners cannot reopen', () => {
  for (const reason of ['published', 'source', 'stale', 'finished'] as const) {
    const f = acceptedCutoverOwner();
    closeTerminalSteering(f.owner, hash('objective'), hash('reply'));
    revokeDispatchLease(f.owner.lease);
    const nextLease = activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}:recovery`, runAttemptId: f.attempt.attemptId });
    const next = { ...f.owner, lease: nextLease };
    if (reason === 'published') appendEvent({ sessionId: f.session.id, turn: 1, role: 'system', type: 'conversation_completed',
      data: { attemptId: f.attempt.attemptId, sourceUserSeq: f.source.seq } });
    if (reason === 'source') next.sourceUserSeq = f.source.seq + 1;
    if (reason === 'stale') revokeDispatchLease(nextLease);
    if (reason === 'finished') finishRunAttempt(f.attempt, 'completed');
    refused(() => reopenTerminalSteering(next), reason === 'published' ? 'STEER_NOTE_CUTOVER' : 'STEER_NOTE_OWNER_CHANGED');
    assert.equal(listEvents(f.session.id, { types: ['guardrail_tripped'] }).filter(e => e.data.kind === 'host_terminal_steering_cutover').length, 1);
  }
});

test('terminal steering: stale captured caller cannot enqueue for a replacement attempt', () => {
  const f = acceptedCutoverOwner();
  const replacement = claimRunAttemptLease({ sessionId: f.session.id, runId: `${f.attempt.runId}:new`, ownerId: 'replacement', leaseMs: 60_000 });
  assert.ok(replacement.claimed);
  recordRunAttemptUserInput(replacement.attempt!, { turn: 2, role: 'user', data: { text: 'A new objective.' } });
  refused(() => appendSteerNote(f.session.id, 'Old captured message.', { expectedAttemptId: f.attempt.attemptId }), 'STEER_NOTE_OWNER_CHANGED');
  assert.equal(listEvents(f.session.id, { types: ['user_steer_note'] }).length, 0);
});

test('terminal steering: an unproven serialized reopen and a note behind a closed fence remain unavailable', () => {
  for (const reason of ['unproven_open', 'injected_note'] as const) {
    const f = acceptedCutoverOwner();
    closeTerminalSteering(f.owner, hash('objective'), hash('reply'));
    if (reason === 'injected_note') {
      appendEvent({ sessionId: f.session.id, turn: 0, role: 'user', type: 'user_steer_note', data: { text: 'Not admitted through CAS.' } });
      refused(() => closeTerminalSteering(f.owner, hash('objective'), hash('reply')), 'STEER_NOTE_UNAVAILABLE');
    } else {
      const metadata = JSON.parse((openEventLog().prepare('SELECT metadata_json FROM sessions WHERE id = ?').get(f.session.id) as { metadata_json: string }).metadata_json);
      const marker = { ...metadata.__host_terminal_steering_cutover, state: 'open', nonce: 'forged-open', previousNonce: 'missing-predecessor' };
      metadata.__host_terminal_steering_cutover = marker;
      openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), f.session.id);
      appendEvent({ sessionId: f.session.id, turn: 0, role: 'system', type: 'guardrail_tripped', data: { kind: 'host_terminal_steering_cutover', marker } });
      refused(() => appendSteerNote(f.session.id, 'Cannot erase the fence.'), 'STEER_NOTE_UNAVAILABLE');
    }
  }
});

test('terminal steering: hostile diagnostic shapes never run hooks or impersonate a typed refusal', () => {
  const f = acceptedCutoverOwner();
  let hooks = 0;
  const hostile = Object.defineProperty({ ...f.owner }, 'lease', { enumerable: true, get() { hooks++; throw new Error('private payload'); } });
  refused(() => closeTerminalSteering(hostile, hash('objective'), hash('reply')), 'STEER_NOTE_UNAVAILABLE');
  const proxy = new Proxy({}, { getPrototypeOf() { hooks++; throw new Error('private payload'); } });
  assert.equal(isSteerNoteAdmissionError(proxy), false);
  assert.equal(hooks, 0);
  assert.equal(isSteerNoteAdmissionError({ code: 'STEER_NOTE_CUTOVER' }), false);
  assert.equal(new SteerNoteAdmissionError('private payload' as never).code, 'STEER_NOTE_UNAVAILABLE');
  const proto = JSON.parse('{"__proto__":{"sessionId":"borrowed","sourceUserSeq":1,"attemptId":"borrowed"}}');
  refused(() => closeTerminalSteering(proto, hash('objective'), hash('reply')), 'STEER_NOTE_UNAVAILABLE');
  closeTerminalSteering(f.owner, hash('objective'), hash('reply'));
  const row = openEventLog().prepare('SELECT metadata_json FROM sessions WHERE id = ?').get(f.session.id) as { metadata_json: string };
  const metadata = JSON.parse(row.metadata_json);
  metadata.__host_terminal_steering_cutover = JSON.parse('{"__proto__":' + JSON.stringify(metadata.__host_terminal_steering_cutover) + '}');
  openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), f.session.id);
  refused(() => appendSteerNote(f.session.id, 'Cannot borrow marker fields through a prototype.'), 'STEER_NOTE_UNAVAILABLE');
});

test('terminal steering: metadata slot deletion cannot erase the immutable negative fence', () => {
  const f = acceptedCutoverOwner();
  closeTerminalSteering(f.owner, hash('objective'), hash('reply'));
  openEventLog().prepare("UPDATE sessions SET metadata_json = json_remove(metadata_json, '$.__host_terminal_steering_cutover') WHERE id = ?").run(f.session.id);
  refused(() => appendSteerNote(f.session.id, 'The missing slot is not permission.', { expectedAttemptId: f.attempt.attemptId }), 'STEER_NOTE_CUTOVER');
  assert.equal(listEvents(f.session.id, { types: ['user_steer_note'] }).length, 0);
});

test('terminal steering: copied attempt ID cannot relabel a different physical lease row', () => {
  const f = acceptedCutoverOwner();
  const unbound = activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}:unowned` });
  refused(() => closeTerminalSteering({ ...f.owner, lease: { ...unbound, runAttemptId: f.attempt.attemptId } }, hash('objective'), hash('reply')),
    'STEER_NOTE_OWNER_CHANGED');
  assert.equal(listEvents(f.session.id, { types: ['guardrail_tripped'] }).length, 0);
});

test('terminal steering: restoring an older valid open or closed pointer cannot hide the latest closed handoff', () => {
  for (const state of ['open', 'closed'] as const) {
    const f = acceptedCutoverOwner();
    closeTerminalSteering(f.owner, hash('objective'), hash('reply'));
    const metadataFor = () => JSON.parse((openEventLog().prepare('SELECT metadata_json FROM sessions WHERE id = ?').get(f.session.id) as { metadata_json: string }).metadata_json);
    const oldClosed = metadataFor().__host_terminal_steering_cutover;
    revokeDispatchLease(f.owner.lease);
    const lease = activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}:recovery`, runAttemptId: f.attempt.attemptId });
    const owner = { ...f.owner, lease };
    reopenTerminalSteering(owner);
    const oldOpen = metadataFor().__host_terminal_steering_cutover;
    closeTerminalSteering(owner, hash('new objective'), hash('new reply'));
    const metadata = metadataFor();
    metadata.__host_terminal_steering_cutover = state === 'open' ? oldOpen : oldClosed;
    openEventLog().prepare('UPDATE sessions SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), f.session.id);
    const count = listEvents(f.session.id).length;
    refused(() => appendSteerNote(f.session.id, 'Cannot resurrect the old pointer.', { expectedAttemptId: f.attempt.attemptId }), 'STEER_NOTE_UNAVAILABLE');
    assert.equal(listEvents(f.session.id).length, count);
  }
});

test('terminal steering: published terminal also refuses an already-open idempotent recovery', () => {
  const f = acceptedCutoverOwner();
  closeTerminalSteering(f.owner, hash('objective'), hash('reply'));
  revokeDispatchLease(f.owner.lease);
  const lease = activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}:recovery`, runAttemptId: f.attempt.attemptId });
  const owner = { ...f.owner, lease };
  reopenTerminalSteering(owner);
  appendEvent({ sessionId: f.session.id, turn: 1, role: 'system', type: 'conversation_completed', data: { sourceUserSeq: f.source.seq, attemptId: f.attempt.attemptId } });
  refused(() => reopenTerminalSteering(owner), 'STEER_NOTE_CUTOVER');
  refused(() => appendSteerNote(f.session.id, 'Cannot enqueue after publication.'), 'STEER_NOTE_OWNER_CHANGED');
});

test('terminal steering: exact approval delivery transfers to a new attempt while execution and pending notes stay with the parent source', () => {
  const f = acceptedCutoverOwner();
  const card = approvalRegistry.register({ sessionId: f.session.id, subject: 'Controlled pending work', tool: 'fixture_write', args: { value: 'held' } });
  closeTerminalSteering(f.owner, hash('objective'), hash('awaiting approval'));
  finishRunAttempt(f.attempt, 'interrupted');
  revokeDispatchLease(f.owner.lease);
  const resumed = claimRunAttemptLease({ sessionId: f.session.id, runId: `${f.attempt.runId}:approval`, ownerId: 'approval-owner', leaseMs: 60_000 }).attempt!;
  const control = recordRunAttemptUserInput(resumed, { turn: 2, role: 'user', parentEventId: f.source.id,
    data: { text: 'Approve the exact pending card.', approvalId: card.approvalId, decision: 'approve', synthetic: true,
      liveApprovalControl: { version: 1, mode: 'paused_card', approvalId: card.approvalId, ownerAttemptId: f.attempt.attemptId, ownerSourceUserSeq: f.source.seq } } });
  approvalRegistry.resolve(card.approvalId, 'approved', 'fixture-owner');
  // Use the existing host-recorded SQL identity proof, without making a tool
  // call or treating the approval acknowledgement as new execution authority.
  appendEvent({ sessionId: f.session.id, turn: 2, role: 'system', type: 'run_resumed', data: { reviewContinuationVersion: 1,
    executionSourceUserSeq: f.source.seq, deliverySourceUserSeq: control.seq, approvalId: card.approvalId, decision: 'approve' } });
  const lease = activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}:approval`, runAttemptId: resumed.attemptId });
  const owner = { sessionId: f.session.id, sourceUserSeq: f.source.seq, attemptId: resumed.attemptId, lease };
  reopenTerminalSteering(owner);
  const note = appendSteerNote(f.session.id, 'Keep the original scope.', { expectedAttemptId: resumed.attemptId });
  const pending = closeTerminalSteering(owner, hash('parent objective'), hash('resumed reply'));
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.status === 'pending' ? pending.notes.map(n => n.seq) : [], [note.seq]);
  assert.equal(closeTerminalSteering(owner, hash('parent objective'), hash('resumed reply')).status, 'closed');
  assert.equal(acceptedTurnCallAuthorityFor(f.session.id, f.source.seq).status, 'ok');
  assert.equal(acceptedTurnCallAuthorityFor(f.session.id, control.seq).status, 'missing', 'the fence cannot arm the delivery input');
  assert.equal(listEvents(f.session.id, { types: ['tool_called'] }).length, 0);
});

test('terminal steering: a fresh ordinary accepted source is not held by an older owner’s closed marker', () => {
  const f = acceptedCutoverOwner();
  closeTerminalSteering(f.owner, hash('old objective'), hash('old reply'));
  finishRunAttempt(f.attempt, 'completed');
  const attempt = claimRunAttemptLease({ sessionId: f.session.id, runId: `${f.attempt.runId}:fresh`, ownerId: 'fresh-owner', leaseMs: 60_000 }).attempt!;
  const source = recordRunAttemptUserInput(attempt, { turn: 2, role: 'user', data: { text: 'A genuinely new objective.' } });
  assert.equal(armHostReadOnlyCallAuthority({ sessionId: f.session.id, sourceUserSeq: source.seq,
    surfaceVersion: 'configured_harness_tools_v1', catalogRevisionDigest: hash('new catalog'), bindingRevisionDigest: hash('new binding'),
    maxLogicalCalls: 8, maxParallelCalls: 4 }).status, 'armed');
  const lease = activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}:fresh`, runAttemptId: attempt.attemptId });
  const owner = { sessionId: f.session.id, sourceUserSeq: source.seq, attemptId: attempt.attemptId, lease };
  reopenTerminalSteering(owner);
  const note = appendSteerNote(f.session.id, 'A new-source note.', { expectedAttemptId: attempt.attemptId });
  const pending = closeTerminalSteering(owner, hash('new objective'), hash('new reply'));
  assert.deepEqual(pending.status === 'pending' ? pending.notes.map(n => n.seq) : [], [note.seq]);
  assert.equal(closeTerminalSteering(owner, hash('new objective'), hash('new reply')).status, 'closed');
});

/** An earlier chat request Clem handed to a durable workflow. The retirement
 * fence keeps its attempt active beside the next foreground request. */
function preservedWorkflowHandoff(sessionId: string, serial: number) {
  const attempt = beginRunAttempt(sessionId, { runId: `desktop:handoff-${serial}` });
  const source = recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Run the controlled workflow.' } });
  const sourceGroupId = `workflow-origin-group-v1:${'a'.repeat(64)}`;
  const sourceGroupDigest = 'b'.repeat(64);
  appendEvent({ sessionId, turn: 1, role: 'system', type: 'async_work_dispatched', parentEventId: source.id,
    data: { version: 2, kind: 'workflow_run_group', status: 'dispatched', sourceUserSeq: source.seq, sourceGroupId, sourceGroupDigest,
      runIds: [`workflow-run-${serial}`], replyTargetDigest: 'c'.repeat(64),
      dispatchKey: `workflow_source_group:${sourceGroupId}:${sourceGroupDigest}` } });
  return { attempt, source };
}
const attemptRow = (attemptId: string) => openEventLog()
  .prepare('SELECT finished_at, status FROM run_attempts WHERE attempt_id = ?').get(attemptId) as { finished_at: string | null; status: string };

test('terminal steering: an attempt a workflow handoff keeps alive beside the owner is not a rival owner', () => {
  let handoff!: ReturnType<typeof preservedWorkflowHandoff>;
  const f = acceptedCutoverOwner(false, sessionId => { handoff = preservedWorkflowHandoff(sessionId, cutoverSerial); });
  assert.deepEqual(attemptRow(handoff.attempt.attemptId), { finished_at: null, status: 'active' }, 'the handed-off request kept its attempt');
  const note = appendSteerNote(f.session.id, 'Keep the workflow running; report in French.', { expectedAttemptId: f.attempt.attemptId });
  const pending = closeTerminalSteering(f.owner, hash('objective'), hash('draft'));
  assert.deepEqual(pending.status === 'pending' ? pending.notes.map(n => n.seq) : [], [note.seq]);
  assert.equal(closeTerminalSteering(f.owner, hash('amended objective'), hash('French reply')).status, 'closed');
  refused(() => appendSteerNote(f.session.id, 'Too late.', { expectedAttemptId: f.attempt.attemptId }), 'STEER_NOTE_CUTOVER');
  revokeDispatchLease(f.owner.lease);
  const lease = activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}:recovery`, runAttemptId: f.attempt.attemptId });
  const reopened = { ...f.owner, lease };
  reopenTerminalSteering(reopened);
  // Without a named attempt the note still reaches the foreground owner.
  const second = appendSteerNote(f.session.id, 'Also include the totals.');
  const adopted = closeTerminalSteering(reopened, hash('objective with totals'), hash('reply with totals'));
  assert.deepEqual(adopted.status === 'pending' ? adopted.notes.map(n => n.seq) : [], [second.seq]);
  assert.equal(closeTerminalSteering(reopened, hash('objective with totals'), hash('reply with totals')).status, 'closed');
  assert.deepEqual(attemptRow(handoff.attempt.attemptId), { finished_at: null, status: 'active' }, 'the fence neither adopts nor retires the handoff');
  assert.deepEqual(attemptRow(f.attempt.attemptId), { finished_at: null, status: 'active' });
});

test('terminal steering: a second foreground attempt without a handoff is still a rival owner', () => {
  const f = acceptedCutoverOwner();
  // A rival foreground row the retirement fence did not reach.
  openEventLog().prepare(`INSERT INTO run_attempts (attempt_id, session_id, run_id, started_at, finished_at, status)
    VALUES (?, ?, ?, ?, NULL, 'active')`).run(`attempt:rival-${cutoverSerial}`, f.session.id, `desktop:rival-${cutoverSerial}`, new Date().toISOString());
  const count = listEvents(f.session.id).length;
  refused(() => appendSteerNote(f.session.id, 'Which turn owns this?', { expectedAttemptId: f.attempt.attemptId }), 'STEER_NOTE_OWNER_CHANGED');
  refused(() => closeTerminalSteering(f.owner, hash('objective'), hash('reply')), 'STEER_NOTE_OWNER_CHANGED');
  assert.equal(listEvents(f.session.id).length, count);
});

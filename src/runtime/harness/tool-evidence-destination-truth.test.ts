/**
 * B3 pins: the fresh-external-write requirement derives from what the turn
 * TOUCHED, with request-text regexes as fallback only.
 *
 * The live lie (2026-08-09, sess-msmactpy): "Let's just find those slack ids
 * and save them in the workflow" — a LOCAL file edit — classified as an
 * external-write objective because the clause names slack and a save verb;
 * the finished turn's real report was replaced with "I cannot honestly
 * confirm the work went out". The 2026-08-05 point fix (one regex) recurred
 * in four days; this is the class fix.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'destination-truth-test-'));

import test from 'node:test';
import assert from 'node:assert/strict';

const { appendEvent, createSession } = await import('./eventlog.js');
const {
  freshExternalWriteRequirement,
  objectiveRequiresFreshExternalWrite,
} = await import('./tool-evidence.js');

const LIVE_TEXT = "Let's just find those slack ids and save them in the workflow which should make it easier to run in the future";

function sessionWith(effects: Array<string | { type: string }>): { sessionId: string; sourceUserSeq: number } {
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: LIVE_TEXT },
  });
  let call = 0;
  for (const entry of effects) {
    if (typeof entry !== 'string') {
      appendEvent({
        sessionId: sess.id, turn: 1, role: 'Clem', type: entry.type as never,
        data: { sourceUserSeq: source.seq, shapeKey: 'GMAIL_SEND_EMAIL', targets: [] },
      });
      continue;
    }
    call += 1;
    appendEvent({
      sessionId: sess.id, turn: 1, role: 'Clem', type: 'tool_called',
      data: {
        sourceUserSeq: source.seq,
        tool: 'run_shell_command',
        callId: `call-${call}`,
        canonicalCallId: `call-${call}`,
        accounting: 'top_level',
        effect: entry,
      },
    });
  }
  return { sessionId: sess.id, sourceUserSeq: source.seq };
}

test('FAILS-ON-OLD-CODE: the live text still classifies external by text alone', () => {
  assert.equal(
    objectiveRequiresFreshExternalWrite(LIVE_TEXT),
    true,
    'precondition: the regex classifier still gets this wrong — if this starts failing, the text path was fixed and this pin should be revisited',
  );
});

test('THE CLASS FIX: local-only observed activity → no external receipt required, any phrasing', () => {
  const { sessionId, sourceUserSeq } = sessionWith(['read', 'local_write', 'read', 'compute']);
  const requirement = freshExternalWriteRequirement({ objectiveText: LIVE_TEXT, sessionId, sourceUserSeq });
  assert.equal(requirement.required, false);
  assert.equal(requirement.basis, 'observed_local_only');
  assert.equal(requirement.touchedExternal, 0);
});

test('HOLE STAYS CLOSED: a turn that was supposed to send and did NOTHING falls to the text classifier', () => {
  const { sessionId, sourceUserSeq } = sessionWith([]);
  const requirement = freshExternalWriteRequirement({
    objectiveText: 'email these figures to the team now',
    sessionId,
    sourceUserSeq,
  });
  assert.equal(requirement.basis, 'objective_text');
  assert.equal(requirement.required, true, 'no observed activity must never waive a send objective');
});

test('an external touch keeps the requirement on the text/evidence path', () => {
  const { sessionId, sourceUserSeq } = sessionWith(['read', { type: 'external_write' }]);
  const requirement = freshExternalWriteRequirement({
    objectiveText: 'email these figures to the team now',
    sessionId,
    sourceUserSeq,
  });
  assert.equal(requirement.basis, 'objective_text');
  assert.equal(requirement.required, true);
  assert.equal(requirement.touchedExternal, 1);
});

test('unknown effects prove nothing: unclassified-only activity falls to text', () => {
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: LIVE_TEXT },
  });
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'Clem', type: 'tool_called',
    data: { sourceUserSeq: source.seq, tool: 'mystery', callId: 'c1', canonicalCallId: 'c1', accounting: 'top_level' },
  });
  const requirement = freshExternalWriteRequirement({
    objectiveText: LIVE_TEXT, sessionId: sess.id, sourceUserSeq: source.seq,
  });
  assert.equal(requirement.basis, 'objective_text');
});

test('mirror rows do not count as touched destinations', () => {
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: LIVE_TEXT },
  });
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'Clem', type: 'tool_called',
    data: { sourceUserSeq: source.seq, tool: 'x', callId: 'c1', canonicalCallId: 'c1', accounting: 'transport_mirror', effect: 'local_write' },
  });
  const requirement = freshExternalWriteRequirement({
    objectiveText: LIVE_TEXT, sessionId: sess.id, sourceUserSeq: source.seq,
  });
  assert.equal(requirement.touchedTotal, 0, 'canonical projection only — mirrors would double-count');
  assert.equal(requirement.basis, 'objective_text');
});

test('a missing session or ledger error falls to text, never throws, never waives', () => {
  const requirement = freshExternalWriteRequirement({
    objectiveText: 'email these figures to the team now',
    sessionId: 'sess-does-not-exist',
    sourceUserSeq: 1,
  });
  assert.equal(requirement.basis, 'objective_text');
  assert.equal(requirement.required, true);
});

test.after(() => {
  rmSync(process.env.CLEMENTINE_HOME!, { recursive: true, force: true });
});

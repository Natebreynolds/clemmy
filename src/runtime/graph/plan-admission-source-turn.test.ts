/**
 * A plan's admission identity must carry the ACCEPTED SOURCE's turn, never the
 * turn being executed.
 *
 * Live 2026-08-28 (sess-mob-5d3e…/source 92403, "Yes just my calendar"): every
 * plan_task on a follow-up message refused with `source_missing` and the model
 * retried the identical call until the run was killed by hand ~6 minutes in.
 * plan-tools.ts loaded the accepted source row successfully and then, three
 * lines later, handed the persist layer the run context's `turn` — the turn
 * being EXECUTED. Those coincide only on a session's first turn: a follow-up
 * runs as turn N while its source is still stamped with the turn that was open
 * when it arrived. So the persist layer compared 1 against 2 and declared the
 * very row plan-tools had just read to be missing.
 *
 * Measured on the live store at the time of the fix: all 20 plan admissions
 * ever recorded had source turn === executing turn, and 118 refusals had them
 * differ. No plan had ever been admitted on a follow-up turn.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-plan-admission-source-turn';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  appendEvent,
  createSession,
  resetEventLog,
} = await import('../harness/eventlog.js');
const { recordTurnGraphShadowChecked } = await import('./turn-graph-shadow.js');

beforeEach(() => { resetEventLog(); });
after(() => {
  resetEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function followUpSource(sessionId: string) {
  createSession({ id: sessionId, kind: 'chat' });
  // Turn 1 opened and closed; the follow-up arrives stamped with turn 1 and is
  // then executed as turn 2. This is the ordinary live shape, not a contrivance.
  appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Can you look at my calendar?' },
  });
  appendEvent({ sessionId, turn: 1, role: 'system', type: 'turn_ended', data: {} });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Yes just my calendar' },
  });
  appendEvent({ sessionId, turn: 2, role: 'system', type: 'turn_started', data: {} });
  return source;
}

test('the executing turn is NOT the accepted source turn on a follow-up', () => {
  const source = followUpSource('plan-turn-shape');
  assert.equal(source.turn, 1, 'the follow-up source is stamped with the turn that was open');
  // If these were equal the bug would be unobservable, and this pin would be
  // asserting nothing. The divergence is the whole premise.
  assert.notEqual(2, source.turn);
});

test('an identity carrying the EXECUTING turn still persists against the source turn', () => {
  const source = followUpSource('plan-turn-executing');
  const result = recordTurnGraphShadowChecked({
    identity: { sessionId: 'plan-turn-executing', turn: 2, sourceUserSeq: source.seq },
    surface: 'direct',
  });
  assert.equal(result.ok, true, 'G17: a present source is never source_missing because of executing-turn identity');
  if (result.ok) {
    assert.equal(result.event.turn, source.turn);
  }
});

test('an identity carrying the SOURCE turn is never refused for a missing source', () => {
  const source = followUpSource('plan-turn-source');
  const result = recordTurnGraphShadowChecked({
    identity: { sessionId: 'plan-turn-source', turn: source.turn, sourceUserSeq: source.seq },
    surface: 'direct',
  });
  // Compilation may still refuse for its own reasons; what may never happen is
  // the source going missing when the identity names it correctly.
  assert.notEqual(
    result.ok === false ? result.reason : null,
    'source_missing',
    'a correctly identified accepted source must never read as missing',
  );
});

test('the persist layer rebinds identity.turn onto the accepted source row', () => {
  const src = readFileSync(new URL('./turn-graph-shadow.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /turn: source\.turn/,
    'G17: persist must take turn from the loaded source, not the caller',
  );
  assert.doesNotMatch(
    src,
    /if \(!source \|\| source\.turn !== input\.identity\.turn\) return \{ ok: false, reason: 'source_missing' \}/,
    'a present source must not be declared missing because executing turn differs',
  );
});

test('plan_task derives its admission turn from the accepted source row', () => {
  // Guards the exact regression: reverting to the run context's turn here puts
  // every multi-turn plan back into the refusal loop above. The seam tests
  // prove the rule; this one proves plan_task still obeys it.
  const src = readFileSync(new URL('../../tools/plan-tools.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /const turn = source\.turn;/,
    'plan_task must take its admission identity turn from the loaded source event',
  );
  assert.doesNotMatch(
    src,
    /const turn = context\.turn as number;/,
    'plan_task must not admit against the turn being executed',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_COMPLETION_ERROR,
  GENERIC_TURN_ERROR,
  terminalCompletionPresentation,
} from './terminal-presentation.js';

/**
 * A stop is allowed to be a stop. It is not allowed to be a DEAD END.
 *
 * Owner rule (binding): the owner must never have to nudge the assistant to get
 * anywhere, and a turn must never end on a message that just reports its own
 * failure. So every non-`done` terminal this module renders has to name
 * something the reader can say or do next.
 *
 * "Try again" does not count and is banned outright: it hands the work back
 * without saying what would be different the second time. That exact phrasing
 * is what shipped before, and it is the shape the owner called out.
 */

/** Something the reader can act on: a named utterance, or a direct question. */
function namesANextEdge(text: string): boolean {
  const saysContinue = /say\s+[“"']?continue[”"']?/i.test(text);
  const asksSomething = /\?/.test(text);
  const tellsYouHow = /tell me |let me know |reply with |pick |choose |approve |review /i.test(text);
  return saysContinue || asksSomething || tellsYouHow;
}

const HANDS_IT_BACK = /\btry again\b|\bcheck the (?:logs?|activity)\b|\bdetails are in the logs?\b/i;

test('the exported terminal errors name a next edge and never hand the work back', () => {
  for (const [label, text] of [
    ['GENERIC_TURN_ERROR', GENERIC_TURN_ERROR],
    ['EMPTY_COMPLETION_ERROR', EMPTY_COMPLETION_ERROR],
  ] as const) {
    assert.ok(namesANextEdge(text), `${label} must name a next edge, got: ${text}`);
    assert.ok(!HANDS_IT_BACK.test(text), `${label} must not hand the work back, got: ${text}`);
  }
});

/**
 * Drive the real reducer across every non-done branch it can reach, rather than
 * asserting against a hand-copied list of strings — a new branch added later is
 * then covered for free instead of silently escaping the rule.
 */
const NON_DONE_TERMINALS: ReadonlyArray<{ name: string; data: Record<string, unknown> }> = [
  { name: 'needs_input with no question', data: { turnOutcome: { status: 'needs_input' } } },
  { name: 'legacy awaiting_user_input', data: { reason: 'awaiting_user_input' } },
  { name: 'no_structured_output', data: { reason: 'no_structured_output' } },
  { name: 'awaiting_continue', data: { reason: 'awaiting_continue' } },
  { name: 'limit_exceeded', data: { reason: 'limit_exceeded' } },
  { name: 'cancelled', data: { turnOutcome: { status: 'cancelled' } } },
  { name: 'transferred', data: { turnOutcome: { status: 'transferred' } } },
  { name: 'blocked', data: { turnOutcome: { status: 'blocked' } } },
  { name: 'failed', data: { turnOutcome: { status: 'failed' } } },
  { name: 'uncertain', data: { turnOutcome: { status: 'uncertain' } } },
  { name: 'bare failure reason', data: { reason: 'run_failed' } },
];

test('every non-done terminal the reducer can render offers a next edge', () => {
  for (const { name, data } of NON_DONE_TERMINALS) {
    // No streamed text: this is the empty case, where the module supplies the
    // whole message and therefore owns whether a dead end reaches the owner.
    const rendered = terminalCompletionPresentation(data, '');
    if (rendered.status === 'complete') continue;
    assert.ok(
      namesANextEdge(rendered.text),
      `${name} rendered a dead end (status=${rendered.status}): ${rendered.text}`,
    );
    assert.ok(
      !HANDS_IT_BACK.test(rendered.text),
      `${name} hands the work back: ${rendered.text}`,
    );
  }
});

test('a terminal that already carries the server’s own words is left alone', () => {
  // The rule is about what THIS module invents when the server said nothing.
  // A real answer must never be rewritten to bolt an edge onto it.
  const answered = terminalCompletionPresentation(
    { turnOutcome: { status: 'done' }, reply: 'Tim has 0 meetings tomorrow.' },
    '',
  );
  assert.equal(answered.text, 'Tim has 0 meetings tomorrow.');
  assert.equal(answered.status, 'complete');
});

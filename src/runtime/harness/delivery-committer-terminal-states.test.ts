/**
 * Run: npx tsx --test src/runtime/harness/delivery-committer-terminal-states.test.ts
 *
 * The committer's UNHAPPY terminals.
 *
 * `TurnOutcomeStatus` has five members. The committer's own suite exercises
 * done, needs_input and failed; `blocked` and `cancelled` had no coverage at
 * all. That is the worst place for a gap, because the failure mode of routing
 * every surface through one committer is SILENCE — and silence is
 * indistinguishable from "still working" until someone is standing in front of
 * a demo.
 *
 * These matter beyond the count. `blocked` is where a hollow completion now
 * routes (a settlement with nothing to report is not a success), and
 * `cancelled` is what the kill switch produces. Both are states the user
 * reaches on exactly the long-running work they have already stopped watching.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-committer-terminals-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { appendEvent, createSession, listEvents } = await import('./eventlog.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { publicCompletionText, projectHarnessEventsForPublic } = await import('./public-presentation.js');
type TurnOutcome = import('./turn-outcome.js').TurnOutcome;

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** An accepted source plus a terminal outcome of the given unhappy shape. */
function acceptedTerminal(
  sessionId: string,
  shape:
    | { status: 'blocked'; resumable: boolean; text: string }
    | { status: 'cancelled'; text: string },
): TurnOutcome {
  createSession({ id: sessionId, kind: 'chat', title: 'unhappy terminal' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Do the long thing.' },
  });
  const identity = { sessionId, turn: source.turn, sourceUserSeq: source.seq };
  const base = { version: 2 as const, id: turnOutcomeId(identity), identity };
  return shape.status === 'blocked'
    ? { ...base, status: 'blocked', resumable: shape.resumable, presentation: { kind: 'blocked', text: shape.text } }
    : { ...base, status: 'cancelled', resumable: false, presentation: { kind: 'stopped', text: shape.text } };
}

function terminalsFor(sessionId: string) {
  const all = listEvents(sessionId, { limit: 200 });
  return projectHarnessEventsForPublic(all)
    .filter((event) => event.type === 'conversation_completed' || event.type === 'run_failed');
}

test('a blocked outcome publishes exactly one terminal, and it says something', () => {
  const sessionId = 'sess-committer-blocked';
  const committed = commitTurnOutcome(
    acceptedTerminal(sessionId, { status: 'blocked', resumable: true, text: 'Salesforce needs reconnecting before I can finish.' }),
  );
  assert.ok(committed, 'a blocked terminal must commit, not vanish');

  const terminals = terminalsFor(sessionId);
  assert.equal(terminals.length, 1, 'exactly one settled presentation');
  const text = publicCompletionText(terminals[0]!.data as Record<string, unknown>, '');
  assert.ok(text.length > 0, 'a blocked terminal that renders as silence is the bug this boundary exists to prevent');
  assert.match(text, /reconnect/i, 'and it carries the blocker the user has to act on');
});

test('a cancelled outcome is reported, not silently dropped', () => {
  // The user pressed stop. That is still an outcome they are owed — a run that
  // simply stops making noise is indistinguishable from one still working.
  const sessionId = 'sess-committer-cancelled';
  const committed = commitTurnOutcome(
    acceptedTerminal(sessionId, { status: 'cancelled', text: 'Stopped at your request; nothing was sent.' }),
  );
  assert.ok(committed, 'a cancelled terminal must commit');

  const terminals = terminalsFor(sessionId);
  assert.equal(terminals.length, 1);
  const text = publicCompletionText(terminals[0]!.data as Record<string, unknown>, '');
  assert.ok(text.length > 0, 'a stop must be visible');
  assert.match(text, /nothing was sent/i, 'and must say what did NOT happen, which is the part that matters');
});

test('an unhappy terminal is idempotent — committing twice pages once', () => {
  // Same guarantee the happy path gets. A retried commit on a blocked turn must
  // not produce a second assistant bubble.
  const sessionId = 'sess-committer-blocked-twice';
  const outcome = acceptedTerminal(sessionId, { status: 'blocked', resumable: false, text: 'Blocked on a missing destination.' });
  commitTurnOutcome(outcome);
  commitTurnOutcome(outcome);
  assert.equal(terminalsFor(sessionId).length, 1, 'one accepted source owes exactly one settled presentation');
});

test('no unhappy terminal leaks control-plane payload', () => {
  const sessionId = 'sess-committer-unhappy-leak';
  commitTurnOutcome(
    acceptedTerminal(sessionId, { status: 'blocked', resumable: true, text: 'Blocked; the provider returned an auth error.' }),
  );
  for (const event of terminalsFor(sessionId)) {
    const blob = JSON.stringify(event.data ?? {});
    assert.doesNotMatch(blob, /"nextAction"\s*:|"done"\s*:\s*(?:true|false)|<\/?analysis\b/i);
  }
});

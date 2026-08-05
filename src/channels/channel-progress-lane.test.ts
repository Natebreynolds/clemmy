/**
 * Run: npx tsx --test src/channels/channel-progress-lane.test.ts
 *
 * The Slack/Discord message lane, driven the way the live-edit loop drives it.
 *
 * Both transports share one sender (`runDiscordHarnessConversation`; Slack
 * enters through it with its own transport), so this is the seam where channel
 * progress stops being private event handling and becomes the shared reducer
 * over the server activity projection. What these tests pin is the message UX
 * the reducer is responsible for: one kickoff, milestone edits at the reducer's
 * cadence rather than one per tool event, and exactly one final replacement
 * that nothing afterwards repaints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-progress-lane-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

type DisplayState = import('./discord-harness.js').DisplayState;
const { __test__ } = await import('./discord-harness.js');
const { MILESTONE_EDIT_INTERVAL_MS } = await import('./transport-progress.js');
const { beginRunAttempt, createSession, finishRunAttempt } = await import('../runtime/harness/eventlog.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function displayState(overrides: Partial<DisplayState> = {}): DisplayState {
  return { summary: '', status: 'starting', done: false, toolsCalled: [], toolCount: 0, ...overrides };
}

function laneForNewTurn(): {
  lane: ReturnType<typeof __test__.createChannelProgressLane>;
  sessionId: string;
  attempt: ReturnType<typeof beginRunAttempt>;
} {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const attempt = beginRunAttempt(session.id, { runId: `lane-${session.id}` });
  return {
    lane: __test__.createChannelProgressLane({
      sessionId: session.id,
      attemptId: attempt.attemptId,
      startedAt: attempt.startedAt,
    }),
    sessionId: session.id,
    attempt,
  };
}

test('one kickoff, then silence until the milestone interval — not one message per tool event', () => {
  const { lane } = laneForNewTurn();
  const state = displayState();
  const t0 = Date.parse('2026-08-04T12:00:00.000Z');

  const kickoff = lane.milestone(state, t0);
  assert.equal(kickoff.action, 'kickoff');
  assert.equal(kickoff.action === 'kickoff' && kickoff.text, 'Thinking it through',
    'the kickoff text came from somewhere other than the projection label');

  // Eight tool events inside the interval. A transport is not an event feed.
  for (let i = 1; i <= 8; i++) {
    state.toolCount = i;
    state.toolsCalled.push(`tool_${i}`);
    state.status = `using tool_${i}`;
    const during = lane.milestone(state, t0 + i * 1_500);
    assert.equal(during.action, 'none', `tool event ${i} produced its own message`);
  }

  const past = lane.milestone(state, t0 + MILESTONE_EDIT_INTERVAL_MS + 1_000);
  assert.equal(past.action, 'edit', 'the milestone never advanced past the rate limit');
  assert.equal(past.action === 'edit' && past.text, 'Working on the items');
  // Raw tool identity is not in the type the transport renders.
  assert.equal(past.action === 'edit' && past.text.includes('tool_8'), false,
    'a raw tool name reached the channel milestone');
});

test('an unchanged phase says nothing however long the run goes quiet', () => {
  const { lane } = laneForNewTurn();
  const state = displayState({ toolCount: 2 });
  const t0 = Date.parse('2026-08-04T12:00:00.000Z');
  assert.equal(lane.milestone(state, t0).action, 'kickoff');
  const muchLater = lane.milestone(state, t0 + 10 * MILESTONE_EDIT_INTERVAL_MS);
  assert.equal(muchLater.action, 'none', 'the same phase was re-sent as a new milestone');
});

test('exactly one final replacement, and nothing repaints it', () => {
  const { lane } = laneForNewTurn();
  const state = displayState();
  const t0 = Date.parse('2026-08-04T12:00:00.000Z');
  lane.milestone(state, t0);

  state.summary = 'Here is the verified answer.';
  state.status = 'complete';
  state.done = true;

  const final = lane.settle(state, t0 + 30_000);
  assert.equal(final.action, 'final');
  assert.equal(final.action === 'final' && final.text, 'Here is the verified answer.');
  assert.equal(lane.finalized, true);

  // A second settle — the safety timer racing the terminal event.
  assert.equal(lane.settle(state, t0 + 31_000).action, 'none', 'the final message was sent twice');
  // A straggling progress edit after the reply landed.
  assert.equal(lane.milestone(state, t0 + 32_000).action, 'none', 'a straggler repainted the final reply');
});

test('a pause on a person settles the message without claiming success', () => {
  const { lane } = laneForNewTurn();
  const state = displayState({
    done: true,
    pendingApprovalId: 'apr-lane',
    summary: 'I need your approval to send this.',
  });
  const terminal = __test__.channelTerminalForState(state)!;
  assert.equal(terminal.status, 'blocked', 'an approval pause was recorded as a completed run');
  assert.equal(terminal.resumable, true);
  assert.equal(lane.settle(state, Date.now()).action, 'final',
    'the paused message was never replaced in place');
});

test('a settled attempt takes the message away from the progress path', () => {
  const { lane, attempt } = laneForNewTurn();
  const state = displayState();
  const t0 = Date.parse('2026-08-04T12:00:00.000Z');
  assert.equal(lane.milestone(state, t0).action, 'kickoff');

  finishRunAttempt(attempt, 'completed');
  assert.equal(lane.milestone(state, t0 + 60_000).action, 'none',
    'a progress edit spoke for a run the durable store had already settled');
});

test('the phase vocabulary is the projection’s, not the transport’s', () => {
  assert.equal(__test__.channelActivityForState(displayState()).label.phase, 'thinking');
  assert.equal(__test__.channelActivityForState(displayState({ toolCount: 3 })).label.phase, 'working_items');
  assert.equal(
    __test__.channelActivityForState(displayState({ pendingApprovalId: 'apr-1' })).lifecycle,
    'awaiting_approval',
  );
  assert.equal(
    __test__.channelActivityForState(displayState({ status: 'awaiting reply' })).lifecycle,
    'awaiting_input',
  );
});

test('the rendered message body carries the milestone the lane decided on', () => {
  const state = displayState({
    status: 'using composio_execute_tool',
    activityLine: 'Working on the items',
    turnStartedAt: Date.now() - 30_000,
  });
  const body = __test__.renderBody(state);
  assert.match(body, /Working on the items/, 'the shared milestone never reached the message');
  assert.equal(body.includes('composio_execute_tool'), false,
    'the raw event status outranked the shared milestone');
});

test('the live sender path — both flush machines — decides through the lane', () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'discord-harness.ts'),
    'utf-8',
  );
  // The conversation runner and the approval-resume runner each own a flush /
  // finalFlush pair. Both must go through the lane, or one surface drifts back
  // to narrating from its own events.
  assert.equal((source.match(/progressLane\.milestone\(/g) ?? []).length, 2,
    'a flush path edits the message without asking the shared reducer');
  assert.equal((source.match(/progressLane\.settle\(/g) ?? []).length, 2,
    'a final replacement is sent without the reducer marking the run settled');
  assert.equal((source.match(/if \(progressLane\.finalized\) return;/g) ?? []).length, 4,
    'a flush path can still repaint a settled message');
  // The caller-less exported wrappers the reducer used to hide behind are gone.
  assert.equal(source.includes('nextDiscordProgressAction'), false);
});

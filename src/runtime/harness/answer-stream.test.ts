/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/answer-stream.test.ts
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventRow } from './eventlog.js';
import { actionBus } from '../action-bus.js';
import { projectHarnessEventForPublic } from './public-presentation.js';
import {
  attachAnswerStream,
  beginAnswerDraft,
  completedDraftReply,
  liveDraftView,
  markAnswerDraftChecking,
  presentAnswerDraft,
  resetAnswerStreamForTests,
  retractAnswerDraft,
} from './answer-stream.js';

const SESSION = 'answer-stream-test';
const SOURCE = 41;
const flushed = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

const LONG_ANSWER = 'Your calendar on Thursday has three meetings: the design review at 9:00, lunch with '
  + 'the vendor at 12:30, and the quarterly planning session at 3:00 in the large room.';

function viewer(sessionId = SESSION): { frames: EventRow[]; detach: () => void; text: () => string } {
  const frames: EventRow[] = [];
  const detach = attachAnswerStream(sessionId, (frame) => { frames.push(frame); });
  // What a client following the contract would show for the latest draft.
  const text = (): string => {
    let shown = '';
    let id = '';
    for (const frame of frames) {
      const data = frame.data as { streamId: string; offset?: number; delta?: string; reset?: boolean };
      if (data.reset) { if (data.streamId === id) { shown = ''; id = ''; } continue; }
      if (data.offset === 0) { shown = data.delta ?? ''; id = data.streamId; continue; }
      if (data.streamId === id && data.offset === shown.length) shown += data.delta ?? '';
    }
    return shown;
  };
  return { frames, detach, text };
}

afterEach(() => resetAnswerStreamForTests());

test('a viewer is told the finished draft is being checked, and why a draft is withdrawn', async () => {
  const view = viewer();
  const first = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  first.text(LONG_ANSWER);
  first.complete(LONG_ANSWER);
  markAnswerDraftChecking(SESSION, SOURCE);
  assert.deepEqual(view.frames.at(-1)?.data, { public: true, streamId: first.streamId, checking: true, sourceUserSeq: SOURCE });
  markAnswerDraftChecking(SESSION, SOURCE);
  assert.equal(view.frames.filter((f) => f.data.checking === true).length, 1, 'the marker is sent once');
  // A viewer opening the chat mid-review sees the draft and that it is being checked.
  const late = viewer();
  assert.equal(late.frames[0]?.data.checking, true);
  assert.equal(late.text(), LONG_ANSWER);
  late.detach();

  retractAnswerDraft(SESSION, SOURCE, 'review');
  assert.equal(view.frames.at(-1)?.data.reset, true);
  assert.equal(view.frames.at(-1)?.data.reason, 'review');

  const call = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  call.text(`${LONG_ANSWER} Next I will `);
  await flushed();
  call.toolCall();
  assert.equal(view.frames.at(-1)?.data.reason, 'tool_call');

  const writing = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  writing.text(LONG_ANSWER);
  await flushed();
  markAnswerDraftChecking(SESSION, SOURCE);
  assert.notEqual(view.frames.at(-1)?.data.checking, true, 'a draft still being written is not under review');
});

test('only the closed vocabulary of withdrawal reasons reaches a viewer', () => {
  const at = (data: Record<string, unknown>) => projectHarnessEventForPublic({
    seq: 0, id: 'f', sessionId: SESSION, turn: 0, role: 'Clem', type: 'stream_token',
    parentEventId: null, createdAt: new Date().toISOString(), data: { public: true, streamId: 's-1', ...data },
  })?.data;
  assert.deepEqual(at({ reset: true, reason: 'review' }), { public: true, streamId: 's-1', reset: true, reason: 'review' });
  assert.deepEqual(at({ reset: true, reason: 'the reviewer said the rep names were wrong' }), { public: true, streamId: 's-1', reset: true });
  assert.deepEqual(at({ checking: true }), { public: true, streamId: 's-1', checking: true });
  assert.deepEqual(at({ checking: 'yes' }), undefined);
});

test('live view reads the reply the turn contract would read, cut back to whole words', () => {
  assert.deepEqual(liveDraftView('Here are'), { status: 'pending' }, 'a short head could still be a marker');
  assert.deepEqual(liveDraftView('Here are the three options you wan'), { status: 'text', text: 'Here are the three options you' });
  assert.deepEqual(liveDraftView('Here are the three options you wan', true), { status: 'text', text: 'Here are the three options you wan' });
  assert.deepEqual(liveDraftView('ASK: Which of the two calendars should I use?'), { status: 'text', text: 'Which of the two calendars should I' });
  assert.deepEqual(liveDraftView('CONTINUE: still need the second sheet'), { status: 'private' });
  assert.deepEqual(liveDraftView('done=true\nnextAction=completed\nreply=hi'), { status: 'private' });
  assert.deepEqual(liveDraftView('{"summary":"internal","reply":"The report is saved to your des'), { status: 'text', text: 'The report is saved to your' });
  assert.deepEqual(liveDraftView('<think>checking the dates first'), { status: 'pending' });
  assert.deepEqual(liveDraftView('<think>checking</think>\nThe dates line up with the invoice.'), { status: 'text', text: 'The dates line up with the' });
});

test('live view refuses secrets and tool protocol, including an unfinished opening', () => {
  assert.deepEqual(liveDraftView('The key you asked about is sk-proj-abcdefghijklmnopqrstuvwxyz0123 and it'), { status: 'private' });
  // A secret still being written is held back as the unfinished last word.
  const partial = liveDraftView('The key you asked about is sk-proj-abcdef');
  assert.deepEqual(partial, { status: 'text', text: 'The key you asked about is' });
  assert.deepEqual(liveDraftView('Let me run it now.\n<invoke name="shell">'), { status: 'private' });
  assert.deepEqual(liveDraftView('I will call it:\n{"tool_call": {"name": "x"'), { status: 'private' });
});

test('a completed frame proposes exactly the reply the turn would read', () => {
  assert.equal(completedDraftReply('  The answer is 42.  '), 'The answer is 42.');
  assert.equal(completedDraftReply('ASK: Which account should I use?'), 'Which account should I use?');
  assert.equal(completedDraftReply('CONTINUE: two more sheets to read'), '');
  assert.equal(completedDraftReply('Continuing.'), '', 'a zero-work punt is not a reply');
  assert.equal(completedDraftReply('Your token is ghp_abcdefghijklmnopqrstuvwxyz0123456789'), '');
});

test('a live draft opens past a lead-in, extends by offset, and settles on the admitted text', async () => {
  const view = viewer();
  const draft = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  draft.text('Your calendar on Thursday ');
  await flushed();
  assert.equal(view.frames.length, 0, 'a lead-in length draft is not shown yet');
  draft.text(LONG_ANSWER.slice('Your calendar on Thursday '.length, 130));
  await flushed();
  assert.equal(view.frames.length, 1);
  const opened = view.frames[0]!;
  assert.equal(opened.type, 'stream_token');
  assert.equal(opened.seq, 0, 'frames are never durable events');
  assert.deepEqual(Object.keys(opened.data).sort(), ['delta', 'offset', 'public', 'sourceUserSeq', 'streamId']);
  assert.equal(opened.data.offset, 0);
  assert.equal(opened.data.sourceUserSeq, SOURCE);
  assert.ok(LONG_ANSWER.startsWith(view.text()) && !/\s$/.test(view.text()));
  draft.text(LONG_ANSWER.slice(130));
  await flushed();
  assert.equal(view.frames[1]?.data.offset, (opened.data.delta as string).length, 'later text extends at the held length');
  draft.complete(LONG_ANSWER);
  assert.equal(view.text(), LONG_ANSWER, 'the admitted text completes the unfinished last word');
  for (const frame of view.frames) assert.deepEqual(projectHarnessEventForPublic(frame), frame);
  view.detach();
});

test('a lead-in before a tool call is never shown; a visible draft that turns into a call is retracted', async () => {
  const view = viewer();
  const leadIn = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  leadIn.text('Let me check your calendar for Thursday.');
  await flushed();
  leadIn.toolCall();
  leadIn.complete('ignored after the call began');
  assert.equal(view.frames.length, 0);

  const long = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  long.text(`${LONG_ANSWER} Next I will `);
  await flushed();
  assert.ok(view.text().length > 0);
  long.toolCall();
  assert.equal(view.frames.at(-1)?.data.reset, true);
  assert.equal(view.frames.at(-1)?.data.streamId, long.streamId);
  assert.equal(view.text(), '');
});

test('the next step retracts the previous draft: a rejected review never stays on screen', async () => {
  const view = viewer();
  const first = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  first.text(LONG_ANSWER);
  first.complete(LONG_ANSWER);
  assert.equal(view.text(), LONG_ANSWER);
  // Review rejected the draft; the host's next step begins.
  retractAnswerDraft(SESSION, SOURCE);
  assert.equal(view.text(), '');
  const second = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  assert.notEqual(second.streamId, first.streamId);
  const corrected = LONG_ANSWER.replace('three meetings', 'four meetings');
  second.complete(corrected);
  assert.equal(view.text(), corrected);
  // Opening a new draft retracts one still shown, without an explicit retract.
  beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  assert.equal(view.text(), '');
  assert.equal(view.frames.at(-1)?.data.streamId, second.streamId);
});

test('a draft whose admitted text differs from what streamed is replaced at offset 0', async () => {
  const view = viewer();
  const draft = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  draft.text(`I checked the active context and this is a new topic.\n\n${LONG_ANSWER} and more`);
  await flushed();
  draft.complete(`I checked the active context and this is a new topic.\n\n${LONG_ANSWER}`);
  assert.equal(view.frames.at(-1)?.data.offset, 0);
  assert.equal(view.text(), LONG_ANSWER, 'the turn reads the reply without the context narration');
});

test('a held draft stays hidden until it goes to review as written', async () => {
  const view = viewer();
  const held = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'held' });
  held.text(LONG_ANSWER);
  await flushed();
  held.complete(LONG_ANSWER);
  assert.equal(view.frames.length, 0);
  presentAnswerDraft(SESSION, SOURCE + 1);
  assert.equal(view.frames.length, 0, 'another source cannot present it');
  presentAnswerDraft(SESSION, SOURCE);
  assert.equal(view.text(), LONG_ANSWER);

  // A held draft the writer rewrites is dropped without ever being shown.
  const view2 = viewer('answer-stream-writer');
  const brain = beginAnswerDraft({ sessionId: 'answer-stream-writer', sourceUserSeq: SOURCE, mode: 'held' });
  brain.text(LONG_ANSWER);
  brain.complete(LONG_ANSWER);
  retractAnswerDraft('answer-stream-writer', SOURCE);
  const writer = beginAnswerDraft({ sessionId: 'answer-stream-writer', sourceUserSeq: SOURCE, mode: 'live' });
  const written = LONG_ANSWER.replace('Thursday', 'Friday');
  writer.text(written);
  await flushed();
  writer.complete(written);
  assert.equal(view2.text(), written);
  assert.ok(view2.frames.every((frame) => frame.data.streamId === writer.streamId));
});

test('a viewer attaching mid-draft receives the text so far, then the rest', async () => {
  const draft = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  draft.text(LONG_ANSWER.slice(0, 140));
  const late = viewer();
  assert.equal(late.frames.length, 1);
  assert.equal(late.frames[0]?.data.offset, 0);
  assert.ok(LONG_ANSWER.startsWith(late.text()) && late.text().length > 100);
  draft.text(LONG_ANSWER.slice(140));
  draft.complete(LONG_ANSWER);
  assert.equal(late.text(), LONG_ANSWER);
  late.detach();
  draft.text('after detach');
  assert.equal(late.frames.length, 2);
});

test('the terminal ends the draft without a retraction frame; another source does not', () => {
  const view = viewer();
  const draft = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  draft.complete(LONG_ANSWER);
  const terminal = (sourceUserSeq: number): void => actionBus.emit({
    kind: 'harness.public_event',
    sessionId: SESSION,
    event: {
      seq: 90, id: `terminal-${sourceUserSeq}`, sessionId: SESSION, turn: 1, role: 'Clem',
      type: 'conversation_completed', parentEventId: null, createdAt: new Date().toISOString(),
      data: { sourceUserSeq, reply: LONG_ANSWER },
    },
  });
  terminal(SOURCE - 1);
  assert.equal(viewer().frames.length, 1, 'an older source terminal leaves the draft');
  terminal(SOURCE);
  const frames = view.frames.length;
  retractAnswerDraft(SESSION);
  assert.equal(view.frames.length, frames, 'nothing left to retract');
  assert.equal(viewer().frames.length, 0, 'a later viewer is offered nothing');
});

test('a secret that appears after the draft opened retracts it before any of it is shown', async () => {
  const view = viewer();
  const draft = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  draft.text(`${LONG_ANSWER} The value is `);
  await flushed();
  assert.ok(view.text().length > 0);
  draft.text('AKIAABCDEFGHIJKLMNOP and');
  await flushed();
  assert.equal(view.text(), '');
  assert.ok(view.frames.every((frame) => !String(frame.data.delta ?? '').includes('AKIA')));
  draft.complete(`${LONG_ANSWER} The value is AKIAABCDEFGHIJKLMNOP and that is all.`);
  assert.equal(view.text(), '', 'a closed draft stays closed');
});

test('one failing viewer never affects another', async () => {
  attachAnswerStream(SESSION, () => { throw new Error('socket gone'); });
  const view = viewer();
  const draft = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  draft.complete(LONG_ANSWER);
  assert.equal(view.text(), LONG_ANSWER);
});

test('the public projection admits only the closed stream frame shapes', () => {
  const frame = (data: Record<string, unknown>): EventRow => ({
    seq: 0, id: 'f', sessionId: SESSION, turn: 0, role: 'Clem', type: 'stream_token',
    parentEventId: 'private-parent', createdAt: new Date().toISOString(), data,
  });
  assert.equal(projectHarnessEventForPublic(frame({ delta: 'raw provider text' })), null);
  assert.equal(projectHarnessEventForPublic(frame({ public: true, delta: 'no stream identity' })), null);
  assert.equal(projectHarnessEventForPublic(frame({ public: true, streamId: 'a b', offset: 0, delta: 'x' })), null);
  assert.equal(projectHarnessEventForPublic(frame({ public: true, streamId: 's-1', offset: -1, delta: 'x' })), null);
  assert.deepEqual(
    projectHarnessEventForPublic(frame({ public: true, streamId: 's-1', offset: 3, delta: 'x', sourceUserSeq: 7, extra: 'private' }))?.data,
    { public: true, streamId: 's-1', offset: 3, delta: 'x', sourceUserSeq: 7 },
  );
  assert.deepEqual(
    projectHarnessEventForPublic(frame({ public: true, streamId: 's-1', reset: true, delta: 'ignored' }))?.data,
    { public: true, streamId: 's-1', reset: true },
  );
});

test('a draft completed while nobody watched is offered to a viewer that attaches later', () => {
  const live = beginAnswerDraft({ sessionId: SESSION, sourceUserSeq: SOURCE, mode: 'live' });
  live.text(LONG_ANSWER);
  live.complete(`  ${LONG_ANSWER}  `);
  const late = viewer();
  assert.equal(late.frames.length, 1);
  assert.equal(late.text(), LONG_ANSWER);

  const held = beginAnswerDraft({ sessionId: 'answer-stream-held-late', sourceUserSeq: SOURCE, mode: 'held' });
  held.complete(LONG_ANSWER);
  assert.equal(viewer('answer-stream-held-late').frames.length, 0, 'a held draft is not offered');
  presentAnswerDraft('answer-stream-held-late', SOURCE);
  assert.equal(viewer('answer-stream-held-late').text(), LONG_ANSWER);

  const punt = beginAnswerDraft({ sessionId: 'answer-stream-punt', sourceUserSeq: SOURCE, mode: 'live' });
  punt.complete('Continuing.');
  assert.equal(viewer('answer-stream-punt').frames.length, 0, 'a frame proposing no reply offers nothing');
});

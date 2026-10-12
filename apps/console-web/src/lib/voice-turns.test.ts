import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextSpokenPart, spokenWords, voiceBaseline, voiceReadableText, voiceTurnEnded, voiceTurnNoticeFacts, voiceTurnRunning, voiceUtterances, voiceUtteranceCurrent, type VoiceChatMessage } from './voice-turns.js';

const owner = (id: string, text: string): VoiceChatMessage => ({ id, role: 'user', text });
const clem = (id: string, text: string, status: string, extra: Partial<VoiceChatMessage> = {}): VoiceChatMessage =>
  ({ id, role: 'assistant', text, status, ...extra });

test('Clem\'s first words while she works, then her answer, are each heard once', () => {
  const heard = new Map<string, string>();
  const baseline = new Set<string>();
  const say = (messages: VoiceChatMessage[]) => voiceUtterances(messages, heard, baseline).map((u) => { heard.set(u.key, u.text); return u.text; });

  assert.deepEqual(say([owner('u1', 'move my 3pm'), clem('a1', '', 'thinking')]), []);
  assert.deepEqual(say([owner('u1', 'move my 3pm'), clem('a1', 'On it, checking your calendar.', 'thinking')]), ['On it, checking your calendar.']);
  assert.deepEqual(say([owner('u1', 'move my 3pm'), clem('a1', 'On it, checking your calendar.', 'thinking')]), [], 'not twice');
  assert.deepEqual(say([owner('u1', 'move my 3pm'), clem('a1', 'Moved it to 4.', 'complete')]), ['Moved it to 4.']);
  assert.deepEqual(say([owner('u1', 'move my 3pm'), clem('a1', 'Moved it to 4.', 'complete')]), []);
});

test('what was on screen before voice mode, drafts still being written or sent back, and stops are not read', () => {
  const heard = new Map<string, string>();
  const baseline = new Set(['old']);
  const messages = [
    clem('old', 'An earlier answer.', 'complete'),
    clem('draft', 'Half a sent', 'thinking', { answerDraft: { id: 's1', phase: 'writing' } }),
    clem('reviewed', 'A draft review sent back.', 'thinking', { answerDraft: { id: 's2', phase: 'withdrawn', withdrawn: 'review' } }),
    clem('stopped', 'Stopped as requested.', 'stopped'),
  ];
  assert.deepEqual(voiceUtterances(messages, heard, baseline), []);
});

test('what she says before her tools run and her progress notes are read while she works, once', () => {
  const heard = new Map<string, string>();
  const say = (messages: VoiceChatMessage[]) => voiceUtterances(messages, heard, new Set()).map((u) => { heard.set(u.key, u.text); return u.text; });
  const beforeTools = clem('a1', 'Let me check your calendar.', 'thinking', { answerDraft: { id: 's1', phase: 'withdrawn', withdrawn: 'tool_call' } });
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), beforeTools]), ['Let me check your calendar.']);
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), beforeTools]), []);
  const progress = clem('p1', 'Found three meetings, checking the fourth.', 'complete', { checkIn: true });
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), beforeTools, progress]), ['Found three meetings, checking the fourth.']);
  const answered = clem('a1', 'Four things tomorrow, starting at nine.', 'complete');
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), progress, answered]), ['Four things tomorrow, starting at nine.']);
});

test('an answer identical to her first words is not repeated; a card is read by its question', () => {
  const heard = new Map<string, string>([['a1:first', 'Done.']]);
  assert.deepEqual(voiceUtterances([clem('a1', 'Done.', 'complete')], heard, new Set()), []);
  const card = clem('c1', '', 'awaiting-approval', { approval: { preview: { ask: 'Can I send this email to Dana?' } } });
  assert.deepEqual(voiceUtterances([card], new Map(), new Set()).map((u) => u.text), ['Can I send this email to Dana?']);
});

test('the spoken turn ends only after Clem has answered it and stopped working', () => {
  const before = [owner('u0', 'hi'), clem('a0', 'Hello.', 'complete')];
  assert.equal(voiceTurnEnded(before, before.length), false, 'nothing after the spoken words yet');
  const running = [...before, owner('u1', 'what is next'), clem('a1', '', 'thinking')];
  assert.equal(voiceTurnRunning(running), true);
  assert.equal(voiceTurnEnded(running, before.length), false);
  const answered = [...before, owner('u1', 'what is next'), clem('a1', 'Your 4 o\'clock.', 'complete')];
  assert.equal(voiceTurnEnded(answered, before.length), true);
});

test('a conversation opened mid-turn reads the answer to the owner\'s last words, not its history', () => {
  const loaded = [owner('u0', 'earlier'), clem('a0', 'Earlier answer.', 'complete'), owner('u1', 'what is on today'), clem('a1', '', 'thinking')];
  const midTurn = voiceBaseline(loaded, true);
  assert.deepEqual([...midTurn.seen], ['u0', 'a0', 'u1']);
  assert.equal(midTurn.turnFrom, 3);
  const settled = voiceBaseline(loaded, false);
  assert.equal(settled.seen.size, 4, 'without a spoken turn in flight, everything on screen was already seen');
});

test('background sounds the transcriber labels never become a message; words around them stay', () => {
  for (const noise of ['*chuckles*', '(water splashing)', '(upbeat music)', '[SOUND]', ' [MUSIC] (applause) ', '...']) {
    assert.equal(spokenWords(noise), '', noise);
  }
  assert.equal(spokenWords('Put it now!'), 'Put it now!');
  assert.equal(spokenWords('[MUSIC] What is on my calendar tomorrow?'), 'What is on my calendar tomorrow?');
  assert.equal(spokenWords('Move it to 4 (the afternoon slot)'), 'Move it to 4');
});

test('finished sentences and checking drafts stay silent until reviewed terminal delivery', () => {
  const heard = new Map<string, string>();
  const say = (messages: VoiceChatMessage[]) => voiceUtterances(messages, heard, new Set()).map((u) => { heard.set(u.key, u.text); return u.text.trim(); });
  const writing = (text: string) => clem('a1', text, 'thinking', { answerDraft: { id: 's1', phase: 'writing' } });
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), writing('Tomorrow has four')]), [], 'no sentence is finished yet');
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), writing('Tomorrow has four things. The first is at')]), []);
  const checking = clem('a1', 'Tomorrow has four things. The first is at nine.', 'thinking', { answerDraft: { id: 's1', phase: 'checking' } });
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), checking]), []);
  const withdrawn = { ...checking, answerDraft: { id: 's1', phase: 'withdrawn', withdrawn: 'review' } };
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), withdrawn]), []);
  const delivered = [owner('u1', 'what is on tomorrow'), clem('a1', 'The reviewed answer has three things, starting at ten.', 'complete')];
  assert.deepEqual(say(delivered), ['The reviewed answer has three things, starting at ten.']);
  assert.deepEqual(say(delivered), [], 'accepted terminal delivery is spoken once');
});

test('queued speech loses eligibility when its source text, status, draft or message principal changes', () => {
  const first = clem('a1', 'I will inspect the fixture.', 'thinking');
  const utterance = voiceUtterances([first], new Map(), new Set())[0];
  assert.equal(voiceUtteranceCurrent(utterance, [first]), true);
  assert.equal(voiceUtteranceCurrent(utterance, [{ ...first, text: 'A revised explanation.' }]), false);
  assert.equal(voiceUtteranceCurrent(utterance, [{ ...first, status: 'complete' }]), false);
  assert.equal(voiceUtteranceCurrent(utterance, [{ ...first, answerDraft: { id: 's1', phase: 'checking' } }]), false);
  assert.equal(voiceUtteranceCurrent(utterance, [{ ...first, role: 'user' }]), false);
  assert.equal(voiceUtteranceCurrent(utterance, [{ ...first, id: 'a2' }]), false);
  assert.deepEqual(voiceUtterances([{ ...first, answerDraft: { id: 's1' } }], new Map(), new Set()), [], 'unknown draft phase stays unreviewed');
});

test('a sentence ends at its punctuation and a following space', () => {
  assert.equal(nextSpokenPart('One. Two', '', false), 'One. ');
  assert.equal(nextSpokenPart('One. Two', 'One. ', true), 'Two');
  assert.equal(nextSpokenPart('Half a', '', false), '');
  assert.equal(nextSpokenPart('Changed text', 'One. ', true), '', 'a replaced draft is not continued from the old one');
});

test('a notice terminal is never spoken, whatever text it carries, and queued speech for it is dropped', () => {
  const heard = new Map<string, string>();
  const stopped = clem('n1', 'Stopped. 1 result kept.', 'failed', { terminal: { notice: { code: 'stopped' } } });
  const noModel = clem('n2', '', 'failed', { terminal: { notice: { code: 'no_model_connected' } } });
  assert.deepEqual(voiceUtterances([owner('u1', 'read the files'), stopped, noModel], heard, new Set()), []);
  assert.equal(voiceReadableText(stopped), '');
  assert.equal(voiceReadableText(clem('a1', 'Your 4 o’clock.', 'complete', { terminal: {} })), 'Your 4 o’clock.');

  // Words queued while she was answering lose their place once the turn ends on a notice.
  const answering = clem('a2', 'Reading the first file.', 'complete');
  const [queued] = voiceUtterances([answering], new Map(), new Set());
  assert.ok(queued);
  assert.equal(voiceUtteranceCurrent(queued!, [answering]), true);
  assert.equal(voiceUtteranceCurrent(queued!, [{ ...answering, terminal: { notice: { code: 'run_failed' } } }]), false);
});

// A format notice sits beside Clem's own draft: the draft is hers and is read,
// where skipping every notice left the owner hearing nothing at all.
test('a draft held for its format is still read, and its queued speech keeps its place', () => {
  const draft = 'Here is the summary as one object, though one office may be missing.';
  for (const code of ['response_format_unmet', 'response_format_unqualified'] as const) {
    const held = clem('f1', draft, 'failed', { terminal: { status: 'blocked', notice: { code } } });
    assert.equal(voiceReadableText(held), draft, code);
    const [utterance] = voiceUtterances([owner('u1', 'one JSON object please'), held], new Map(), new Set());
    assert.equal(utterance?.text, draft);
    assert.equal(voiceUtteranceCurrent(utterance!, [held]), true);
  }
});

test('a spoken turn that ends on a notice hands the voice its typed fact; a chosen stop does not', () => {
  const messages = [
    owner('u1', 'summarize the fixtures'),
    clem('n1', '', 'failed', { terminal: { status: 'failed', notice: { code: 'provider_quota', model: 'Vendor V4' }, retained: { results: 1, outsideChange: 'none' } } }),
  ];
  const [fact, ...rest] = voiceTurnNoticeFacts(messages, 1);
  assert.equal(rest.length, 0);
  assert.match(fact!, /provider_quota \(model: Vendor V4\)/);
  assert.match(fact!, /1 result kept/);
  assert.deepEqual(voiceTurnNoticeFacts([owner('u1', 'go'), clem('n2', '', 'stopped', { terminal: { status: 'cancelled', notice: { code: 'stopped' } } })], 1), []);
  assert.deepEqual(voiceTurnNoticeFacts([owner('u1', 'go'), clem('a1', 'Done.', 'complete')], 1), []);
  assert.deepEqual(voiceTurnNoticeFacts(messages, 2), [], 'only the turn that just ended');
});

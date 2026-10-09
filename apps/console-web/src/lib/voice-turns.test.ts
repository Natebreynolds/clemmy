import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextSpokenPart, spokenWords, voiceBaseline, voiceTurnEnded, voiceTurnRunning, voiceUtterances, type VoiceChatMessage } from './voice-turns.js';

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

test('her answer is read as she writes it: each finished sentence, the rest when the draft is done, nothing twice', () => {
  const heard = new Map<string, string>();
  const say = (messages: VoiceChatMessage[]) => voiceUtterances(messages, heard, new Set()).map((u) => { heard.set(u.key, u.text); return u.text.trim(); });
  const writing = (text: string) => clem('a1', text, 'thinking', { answerDraft: { id: 's1', phase: 'writing' } });
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), writing('Tomorrow has four')]), [], 'no sentence is finished yet');
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), writing('Tomorrow has four things. The first is at')]), ['Tomorrow has four things.']);
  const checking = clem('a1', 'Tomorrow has four things. The first is at nine.', 'thinking', { answerDraft: { id: 's1', phase: 'checking' } });
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), checking]), ['The first is at nine.']);
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), clem('a1', 'Tomorrow has four things. The first is at nine.', 'complete')]), [],
    'the delivered answer adds nothing that was not already read');
  assert.deepEqual(say([owner('u1', 'what is on tomorrow'), clem('a1', 'Tomorrow has four things. The first is at nine. The last ends at three.', 'complete')]),
    ['The last ends at three.'], 'only what the delivered answer adds is read');
});

test('a sentence ends at its punctuation and a following space', () => {
  assert.equal(nextSpokenPart('One. Two', '', false), 'One. ');
  assert.equal(nextSpokenPart('One. Two', 'One. ', true), 'Two');
  assert.equal(nextSpokenPart('Half a', '', false), '');
  assert.equal(nextSpokenPart('Changed text', 'One. ', true), '', 'a replaced draft is not continued from the old one');
});

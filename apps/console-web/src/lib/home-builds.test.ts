import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestText, buildState, isSettled, NO_FACTS, readBuilds, reduceBuildEvents, samePrompt, type HomeBuild } from './home-builds.js';
import type { HarnessEvent } from './types.js';
import type { SpaceRecord } from './spaces.js';

const ev = (seq: number, type: string, data: Record<string, unknown> = {}) => ({ seq, type, data, sessionId: 's', ts: '' }) as unknown as HarnessEvent;
const build: HomeBuild = { id: 'b1', prompt: 'A board of my open deals', startedAt: new Date().toISOString(), sessionId: 'sess-1' };
const space = (id: string, origin: string, status = 'active') => ({ id, title: id, status, originSessionId: origin }) as unknown as SpaceRecord;

test('the turn that answers the request is the one whose terminal names its input', () => {
  const facts = reduceBuildEvents(NO_FACTS, [
    ev(10, 'user_input_received', { text: 'A board…' }),
    ev(11, 'turn_started'),
    ev(12, 'tool_called', { tool: 'tool_search' }),
    // A later passive report in the same session is not this build's ending.
    ev(20, 'user_input_received', { synthetic: true, source: 'outcome' }),
    ev(21, 'conversation_completed', { reason: 'failed', sourceUserSeq: 20, reply: 'unrelated' }),
  ]);
  assert.equal(facts.userSeq, 10);
  assert.equal(facts.progress, 'Finding the right tool…');
  assert.equal(facts.terminal, null);

  const ended = reduceBuildEvents(facts, [ev(30, 'conversation_completed', { reason: 'success', sourceUserSeq: 10, reply: 'Built your Deal Board.' })]);
  assert.deepEqual(ended.terminal, { reason: 'success', reply: 'Built your Deal Board.' });
  assert.equal(ended.lastSeq, 30);
});

test('an approval the build waits on is said as waiting, and clears when answered', () => {
  const waiting = reduceBuildEvents(NO_FACTS, [ev(1, 'user_input_received'), ev(2, 'approval_requested')]);
  assert.equal(buildState({ build, facts: waiting, lost: false, spaces: [], spacesFresh: false }).kind, 'waiting');
  const answered = reduceBuildEvents(waiting, [ev(3, 'approval_resolved')]);
  assert.equal(buildState({ build, facts: answered, lost: false, spaces: [], spacesFresh: false }).kind, 'working');
});

test('done means a Space exists for this session — not that the chat was sent', () => {
  const done = reduceBuildEvents(NO_FACTS, [ev(1, 'user_input_received'), ev(9, 'conversation_completed', { reason: 'success', sourceUserSeq: 1, reply: 'Which CRM?' })]);
  // Before the Spaces list was read again, it is still being checked.
  assert.equal(buildState({ build, facts: done, lost: false, spaces: [], spacesFresh: false }).kind, 'checking');
  const noSpace = buildState({ build, facts: done, lost: false, spaces: [space('other', 'sess-9')], spacesFresh: true });
  assert.equal(noSpace.kind, 'no_space');
  assert.equal(noSpace.kind === 'no_space' && noSpace.reply, 'Which CRM?');
  const ready = buildState({ build, facts: done, lost: false, spaces: [space('deal-board', 'sess-1')], spacesFresh: false });
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.kind === 'ready' && ready.space.id, 'deal-board');
  // An archived Space is not a result.
  assert.equal(buildState({ build, facts: done, lost: false, spaces: [space('deal-board', 'sess-1', 'archived')], spacesFresh: true }).kind, 'no_space');
});

test('failure, a stop, a lost conversation and an unsent request each say so and settle', () => {
  const failed = reduceBuildEvents(NO_FACTS, [ev(1, 'user_input_received'), ev(2, 'conversation_completed', { reason: 'error', sourceUserSeq: 1, reply: 'The CRM refused the read.' })]);
  assert.equal(buildState({ build, facts: failed, lost: false, spaces: [], spacesFresh: true }).kind, 'failed');
  const stopped = reduceBuildEvents(NO_FACTS, [ev(1, 'user_input_received'), ev(2, 'conversation_completed', { reason: 'cancelled', sourceUserSeq: 1 })]);
  assert.equal(buildState({ build, facts: stopped, lost: false, spaces: [], spacesFresh: true }).kind, 'stopped');
  assert.equal(buildState({ build, facts: undefined, lost: true, spaces: [], spacesFresh: true }).kind, 'lost');
  const unsent = buildState({ build: { ...build, sessionId: undefined, sendError: 'Clementine’s local service is restarting' }, facts: undefined, lost: false, spaces: [], spacesFresh: false });
  assert.equal(unsent.kind, 'unsent');
  for (const s of ['failed', 'stopped', 'lost', 'unsent', 'ready', 'no_space'] as const) {
    assert.equal(isSettled({ kind: s } as never), true, s);
  }
  for (const s of ['sending', 'working', 'waiting', 'checking'] as const) {
    assert.equal(isSettled({ kind: s } as never), false, s);
  }
});

test('the request asks for a Space and leaves Home placement to the layout contract', () => {
  const text = buildRequestText('  A board of my open deals ');
  assert.match(text, /^A board of my open deals\n\nBuild this as a Space/);
  assert.match(text, /leave my Home layout as it is/);
  assert.equal(samePrompt('A  board of my open deals', 'a board of my open deals '), true);
});

test('saved builds survive a relaunch and a corrupt or old store reads as none', () => {
  const store = (value: string | null) => ({ getItem: () => value });
  const old = { ...build, id: 'old', startedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() };
  assert.deepEqual(readBuilds(store(JSON.stringify([build, old, { nope: 1 }]))).map((b) => b.id), ['b1']);
  assert.deepEqual(readBuilds(store('{not json')), []);
  assert.deepEqual(readBuilds(null), []);
});

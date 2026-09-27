import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_JOB_ORDER,
  MEMORY_JOB_WORDS,
  MEMORY_ROLE_WORDS,
  MEMORY_WORK_LIVE_MS,
  memoryEventSentence,
  memoryModelUnavailableText,
  memoryPipeline,
  memoryRoleAutomaticText,
  memoryUndoResultText,
  memoryUndoText,
  memoryWorkHeadline,
  memoryWorkReadIsLive,
  type MemoryWorkEvent,
  type MemoryWorkSnapshot,
} from './memory-work.js';

const fmt = { age: () => '4 min ago', clock: () => '3:00 AM' };
const name = (id: string) => `Model(${id})`;
const base: Pick<MemoryWorkSnapshot, 'state' | 'running' | 'waiting' | 'lastWorkAt' | 'queue' | 'model'> = {
  state: 'resting',
  running: [],
  waiting: null,
  lastWorkAt: '2026-09-26T10:00:00.000Z',
  queue: { toLearn: 0, setAside: 0, failed: 0 },
  model: { source: 'automatic', modelId: 'm-1', follows: 'checker' },
};

test('every job has words and a place in the order', () => {
  assert.deepEqual([...MEMORY_JOB_ORDER].sort(), Object.keys(MEMORY_JOB_WORDS).sort());
});

test('working is named only from a running job, with its source and part', () => {
  const h = memoryWorkHeadline({
    ...base,
    state: 'working',
    running: [{ job: 'learn', startedAt: '2026-09-26T10:00:00.000Z', source: { kind: 'conversation', title: 'Prospect research' }, part: 2, parts: 4 }],
  }, fmt, name);
  assert.equal(h.tone, 'working');
  assert.match(h.text, /Reading a finished conversation · “Prospect research”/);
  assert.equal(h.detail, 'part 2 of 4');
});

test('a paused model is named by what it is, with when learning resumes', () => {
  const h = memoryWorkHeadline({ ...base, state: 'waiting', waiting: { reason: 'model_paused', problem: 'quota', until: '2026-09-26T11:00:00.000Z' } }, fmt, name);
  assert.equal(h.text, 'Model(m-1) is out of quota');
  assert.equal(h.detail, 'Learning resumes around 3:00 AM');
});

test('busy names what learning waits behind', () => {
  const h = memoryWorkHeadline({ ...base, state: 'waiting', waiting: { reason: 'busy', blocker: { kind: 'workflow', startedAt: 'x' } } }, fmt, name);
  assert.equal(h.text, 'Waiting for a workflow to finish before learning');
  assert.equal(h.detail, 'started 4 min ago');
});

test('resting with a queue says what is next; an unread queue is not zero', () => {
  assert.match(memoryWorkHeadline({ ...base, queue: { toLearn: 3, setAside: 0, failed: 0 } }, fmt, name).text, /^3 parts/);
  assert.equal(memoryWorkHeadline({ ...base, queue: { toLearn: null, setAside: null, failed: null } }, fmt, name).text, 'No memory work running right now');
  assert.equal(memoryWorkHeadline(base, fmt, name).text, 'Memory is up to date');
});

test('event sentences say what changed and where it came from', () => {
  const event: MemoryWorkEvent = {
    id: 'e1', job: 'learn', at: 'x', outcome: 'ok', produced: { learned: 2, setAside: 1 },
    source: { kind: 'conversation', title: 'Weekly numbers' }, expiresAt: 'y',
  };
  assert.equal(memoryEventSentence(event), 'Learned 2 memories, set 1 aside from “Weekly numbers”');
  assert.equal(memoryEventSentence({ ...event, produced: {} }), 'Read a conversation from “Weekly numbers”; nothing new to keep');
  assert.equal(memoryEventSentence({ ...event, outcome: 'failed', failure: { problem: 'credit' } }), 'Learning from conversations did not finish: the model is out of credit');
});

test('undo words exist only while undo would change something', () => {
  assert.equal(memoryUndoText({ undo: null }), null);
  assert.equal(memoryUndoText({ undo: { kind: 'forget', count: 0 } }), null);
  assert.equal(memoryUndoText({ undo: { kind: 'forget', count: 3 } }), 'Forget these 3');
  assert.equal(memoryUndoText({ undo: { kind: 'restore', count: 1 } }), 'Bring it back');
});

test('the pipeline keeps unknown as null', () => {
  assert.ok(memoryPipeline(null).every((s) => s.value === null));
  const stages = memoryPipeline({
    runs: 1, modelCalls: 1, inputTokens: 1, outputTokens: 1, learned: 2, updated: 1, faded: 4,
    conversationsRead: 3, claimsFound: 9, leftOut: 5, setAside: 1,
  });
  assert.deepEqual(stages.map((s) => s.value), [3, 9, 3, 6, 4]);
  assert.ok(memoryPipeline(stagesInput(), { unknown: true }).every((s) => s.value === null));
});

function stagesInput() {
  return { runs: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, learned: 0, updated: 0, faded: 0, conversationsRead: 0, claimsFound: 0, leftOut: 0, setAside: 0 };
}

test('checks say what they approved or stopped, not "nothing new"', () => {
  const at = { id: 'e', at: 'x', outcome: 'ok' as const, expiresAt: 'y' };
  assert.equal(memoryEventSentence({ ...at, job: 'standing', produced: { approved: 1 } }), 'Approved a standing instruction');
  assert.equal(memoryEventSentence({ ...at, job: 'verify', produced: { declined: 2 } }), 'Stopped 2 memory repairs');
});

test('tidy says memories faded apart from finished work it cleared', () => {
  const at = { id: 'e', at: 'x', outcome: 'ok' as const, expiresAt: 'y', job: 'tidy' as const };
  assert.equal(memoryEventSentence({ ...at, produced: { faded: 2 } }), 'Let 2 memories fade');
  assert.equal(memoryEventSentence({ ...at, produced: { agedOut: 3 } }), 'Cleared 3 records of finished work');
  assert.equal(memoryEventSentence({ ...at, produced: { faded: 1, agedOut: 1 } }), 'Let 1 memory fade, cleared 1 record of finished work');
});

test('automatic names whose model it borrows, Clem\'s own pick, or none', () => {
  assert.equal(memoryRoleAutomaticText('checker', 'm-1'), MEMORY_ROLE_WORDS.automaticChecker);
  assert.equal(memoryRoleAutomaticText('brain', 'm-1'), MEMORY_ROLE_WORDS.automaticBrain);
  assert.equal(memoryRoleAutomaticText(null, 'm-1'), MEMORY_ROLE_WORDS.automaticOwn, 'a named model never reads as "none available"');
  assert.equal(memoryRoleAutomaticText(null, null), MEMORY_ROLE_WORDS.automaticNone);
  assert.equal(memoryRoleAutomaticText('checker', null), MEMORY_ROLE_WORDS.automaticNone);
});

test('an unread queue says so, instead of "up to date"', () => {
  const h = memoryWorkHeadline({ ...base, queue: { toLearn: null, setAside: null, failed: null } }, fmt, name);
  assert.equal(h.detail, 'Couldn’t read what is left to learn · Last worked 4 min ago');
});

test('motion needs a read that says a job runs now, and is recent', () => {
  const working = { state: 'working' as const, running: [{ job: 'learn' as const, startedAt: 'x' }] };
  assert.equal(memoryWorkReadIsLive(working, 1_000, 1_000 + MEMORY_WORK_LIVE_MS), true);
  assert.equal(memoryWorkReadIsLive(working, 1_000, 1_001 + MEMORY_WORK_LIVE_MS), false, 'an old read stops the motion');
  assert.equal(memoryWorkReadIsLive({ ...working, running: [] }, 1_000, 1_000), false);
  assert.equal(memoryWorkReadIsLive({ ...working, state: 'resting' }, 1_000, 1_000), false);
  assert.equal(memoryWorkReadIsLive(working, null, 1_000), false);
});

test('undo results read the same on both apps', () => {
  assert.equal(memoryUndoResultText({ ok: true, changed: 2 }, 'forget'), 'Forgot 2 memories.');
  assert.equal(memoryUndoResultText({ ok: true, changed: 1 }, 'restore'), 'Brought back 1 memory.');
  assert.equal(memoryUndoResultText({ ok: false, reason: 'not_found' }, 'forget'), 'That run is no longer in the history.');
  assert.equal(memoryUndoResultText({ ok: false, reason: 'failed' }, 'forget'), 'Couldn’t undo just now. Nothing was changed.');
  assert.equal(memoryUndoResultText(null, 'restore'), 'Couldn’t undo just now. Nothing was changed.');
});

test('Settings says why the memory model cannot serve, and that learning waits', () => {
  assert.equal(memoryModelUnavailableText({ problem: 'not_connected' }, null, fmt),
    'The memory model is not connected. Learning waits; nothing is lost.');
  assert.equal(memoryModelUnavailableText({ problem: 'quota', until: '2026-09-26T11:00:00.000Z' }, 'Model(m-1)', fmt),
    'Model(m-1) is out of quota until about 3:00 AM. Learning waits; nothing is lost.');
});

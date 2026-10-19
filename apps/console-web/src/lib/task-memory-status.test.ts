import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTaskMemoryStatus, hasExactMemoryWork, memoryWorkLinks, memoryWorkPresentation, taskMemoryStatusPath,
  validMemoryWork, watchTaskMemoryStatus, type MemoryReadState, type TaskMemoryStatus } from './task-memory-status.js';

function status(state: 'pending' | 'saved' | 'needs_choice' | 'refused' | 'unavailable' = 'pending'): TaskMemoryStatus {
  return { version: 1, sessionId: 'source-a', sourceUserSeq: 41, observedAt: '2026-10-18T12:00:00Z', memory: {
    state, candidates: [{ candidateId: 7, state, ...(state === 'saved' ? { factId: 42 } : {}) }],
    counts: { pending: 0, saved: 0, refused: 0, needsChoice: 0, unavailable: 0, [state === 'needs_choice' ? 'needsChoice' : state]: 1 },
    nextStep: state === 'pending' ? 'wait' : state === 'needs_choice' ? 'clarify_destination' : 'none', pollAfterMs: state === 'pending' ? 2000 : null,
  } };
}
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
function clock() {
  type Timer = ReturnType<typeof setTimeout>;
  let now = 0; let sequence = 0;
  const timers = new Map<Timer, { at: number; fn: () => void }>();
  return { now: () => now,
    schedule(fn: () => void, ms: number): Timer { const key = ++sequence as unknown as Timer; timers.set(key, { at: now + ms, fn }); return key; },
    cancel(key: Timer) { timers.delete(key); },
    size: () => timers.size,
    async next() { const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; assert.ok(next); timers.delete(next[0]); now = next[1].at; next[1].fn(); await flush(); },
  };
}

test('memory status reads only the exact accepted source and carries an abort signal', async () => {
  const controller = new AbortController();
  await getTaskMemoryStatus('source-a', 41, controller.signal, async (path, options) => {
    assert.equal(path, '/api/console/sessions/source-a/memory-status?sourceUserSeq=41');
    assert.equal(options?.signal, controller.signal); assert.equal(options?.method, undefined); return status();
  });
  for (const seq of [0, -1, 2.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => taskMemoryStatusPath('a', seq));
  assert.throws(() => taskMemoryStatusPath('', 41));
});

test('wrong-source and malformed successes cannot render a saved status', async () => {
  const saved = status('saved');
  for (const value of [{ ...saved, sessionId: 'other' }, { ...saved, sourceUserSeq: 42 }, { ...saved, version: 2 },
    { ...saved, memory: {} }, { ...saved, memory: { ...saved.memory, candidates: [null] } },
    { ...saved, memory: { ...saved.memory, state: 'saved', counts: { pending: 1, saved: 0, refused: 0, needsChoice: 0, unavailable: 0 } } },
    { ...saved, memory: { ...saved.memory, candidates: [{ candidateId: 7, state: 'saved' }] } },
    { ...saved, memory: { ...saved.memory, candidates: [{ candidateId: 7, state: 'saved', factId: 42, reason: 'inactive' }] } },
    { ...saved, memory: { ...saved.memory, candidates: [saved.memory!.candidates[0], saved.memory!.candidates[0]], counts: { pending: 0, saved: 2, refused: 0, needsChoice: 0, unavailable: 0 } } },
    { ...saved, memory: { ...saved.memory, pollAfterMs: 2000 } }]) {
    await assert.rejects(getTaskMemoryStatus('source-a', 41, undefined, async () => value), /could not be read/);
  }
  assert.equal(validMemoryWork({ state: 'unavailable', candidates: [], counts: { pending: 0, saved: 0, refused: 0, needsChoice: 0, unavailable: 1 }, nextStep: 'check_again', pollAfterMs: null }), true);
  assert.equal(validMemoryWork(null), true);
});

test('the current hint must match the accepted source, never the reply wording or an adjacent source', () => {
  const terminal = { status: 'blocked' as const, memoryWork: { sourceUserSeq: 41, reason: 'memory_consolidation_pending' as const } };
  assert.equal(hasExactMemoryWork(terminal, { sourceUserSeq: 41 }), true);
  assert.equal(hasExactMemoryWork(terminal, { sourceUserSeq: 42 }), false);
  assert.equal(hasExactMemoryWork(terminal, null), false);
  assert.equal(hasExactMemoryWork({ status: 'blocked' }, { sourceUserSeq: 41 }), false);
});

test('mixed, inactive and superseded results never claim every memory was saved', () => {
  const work = status('saved').memory!;
  work.state = 'mixed'; work.candidates.push({ candidateId: 8, state: 'needs_choice', reason: 'destination_unresolved' }); work.counts.needsChoice = 1;
  assert.equal(validMemoryWork(work), true);
  assert.match(memoryWorkPresentation(work).detail, /1 saved.*1 need a destination.*Not every/);
  for (const reason of ['inactive', 'superseded'] as const) {
    const changed = status('unavailable').memory!; changed.candidates[0]!.reason = reason;
    const projected = memoryWorkPresentation(changed);
    assert.notEqual(projected.title, 'Memory saved'); assert.match(projected.detail, /no longer active|replaced/);
  }
  assert.match(memoryWorkPresentation(status('needs_choice').memory).detail, /existing project.*explicitly.*all your projects/);
});

test('saved-record links are exact, bounded, deduplicated and include inactive historical facts', () => {
  const work = status('unavailable').memory!;
  work.candidates = [{ candidateId: 1, state: 'unavailable', factId: 42, reason: 'superseded' }, { candidateId: 2, state: 'saved', factId: 42 },
    ...Array.from({ length: 15 }, (_, i) => ({ candidateId: i + 3, state: 'saved' as const, factId: i + 43 }))];
  const links = memoryWorkLinks(work); assert.equal(links.length, 8); assert.deepEqual(links[0], { id: 42, href: '/memory?fact=42' });
});

test('pending work polls lightly, adopts a later refusal and then stops without replay', async () => {
  const time = clock(); const states: MemoryReadState[] = []; let calls = 0;
  const reader = watchTaskMemoryStatus({ ...time, deadline: 60_000, onState: (value) => states.push(value),
    read: async () => status(++calls === 1 ? 'pending' : 'needs_choice') });
  await flush(); assert.equal(calls, 1); assert.equal(time.size(), 1);
  await time.next(); assert.equal(calls, 2); assert.equal(states.at(-1)?.value?.memory?.state, 'needs_choice'); assert.equal(time.size(), 0);
  reader.dispose();
});

test('pending reads stop at their budget and only a manual check performs another read', async () => {
  const time = clock(); const states: MemoryReadState[] = []; let calls = 0;
  const reader = watchTaskMemoryStatus({ ...time, deadline: 3000, onState: (value) => states.push(value), read: async () => { calls += 1; return status(); } });
  await flush(); await time.next(); assert.equal(calls, 2); assert.equal(states.at(-1)?.paused, true); assert.equal(time.size(), 0);
  reader.check(); await flush(); assert.equal(calls, 3); assert.equal(time.size(), 0); reader.dispose();
});

test('unmount, source switches and hidden views abort reads and ignore late saved responses', async () => {
  const time = clock(); const states: MemoryReadState[] = []; let settle!: (value: TaskMemoryStatus) => void; let signal!: AbortSignal;
  const reader = watchTaskMemoryStatus({ ...time, deadline: 60_000, onState: (value) => states.push(value), read: (value) => {
    signal = value; return new Promise((resolve) => { settle = resolve; });
  } });
  reader.dispose(); assert.equal(signal.aborted, true); assert.equal(time.size(), 0);
  settle(status('saved')); await flush(); assert.equal(states.length, 1); assert.equal(states[0]?.value, undefined);
});

test('read failures and deadline timeouts stop automatic retry without claiming an old saved result is current', async () => {
  const time = clock(); const states: MemoryReadState[] = []; let calls = 0;
  const reader = watchTaskMemoryStatus({ ...time, deadline: 60_000, onState: (value) => states.push(value),
    read: async () => { calls += 1; throw new Error('private server detail must not be shown'); } });
  await flush(); assert.equal(states.at(-1)?.phase, 'error'); assert.equal(time.size(), 0); assert.equal(calls, 1); reader.dispose();
  const timed: MemoryReadState[] = []; let signal!: AbortSignal;
  const slow = watchTaskMemoryStatus({ ...time, deadline: 60_000, onState: (value) => timed.push(value), read: (value) => { signal = value; return new Promise(() => {}); } });
  await time.next(); assert.equal(signal.aborted, true); assert.equal(timed.at(-1)?.phase, 'error'); assert.equal(time.size(), 0); slow.dispose();
});

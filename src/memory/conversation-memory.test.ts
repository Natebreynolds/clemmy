/** Run with scripts/run-tests-isolated.mjs. No provider or live-home access. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-conversation-memory-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const eventlog = await import('../runtime/harness/eventlog.js');
const lifecycle = await import('../runtime/harness/conversation-state-lifecycle.js');
const { inspectConversationProtocol } = await import('../runtime/harness/conversation-protocol.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const conversationMemory = await import('./conversation-memory.js');
const { openMemoryDb } = await import('./db.js');

after(() => { conversationMemory._setConversationMemorySummarizerForTests(null); eventlog.closeEventLog(); rmSync(TEST_HOME, { recursive: true, force: true }); });

const NOW = new Date('2026-10-15T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const BIG = 'row,'.repeat(2_000);

function history(tag: string) {
  return [
    { role: 'user', content: `Find the ${tag} report` },
    { type: 'reasoning', id: `rs_${tag}`, content: [{ type: 'input_text', text: 'thinking '.repeat(500) }] },
    { type: 'function_call', callId: `call_${tag}`, name: 'search_files', arguments: JSON.stringify({ q: tag, padding: 'x'.repeat(3_000) }) },
    { type: 'function_call_result', callId: `call_${tag}`, name: 'search_files', status: 'completed',
      output: { type: 'text', text: `found rh_${tag}abcdef ${BIG}` } },
    { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `The ${tag} report is in /reports/${tag}.pdf.` }] },
  ];
}

function chat(tag: string, idleDays: number, options: { kind?: 'chat' | 'workflow'; metadata?: Record<string, unknown>; transcript?: boolean } = {}) {
  const session = eventlog.createSession({ kind: options.kind ?? 'chat', title: tag, metadata: {
    ...(options.metadata ?? {}), __conversation: { items: history(tag), lastResponseId: `resp_${tag}`, updatedAt: daysAgo(idleDays) } } });
  if (options.transcript !== false) {
    eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: `Find the ${tag} report` } });
    eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'assistant', type: 'conversation_completed',
      data: { reply: `The ${tag} report is in /reports/${tag}.pdf.` } });
  }
  eventlog.openEventLog().prepare('UPDATE sessions SET updated_at = ?, created_at = ? WHERE id = ?').run(daysAgo(idleDays), daysAgo(idleDays + 1), session.id);
  return session.id;
}

const state = (sessionId: string) => eventlog.getSessionConversationState(sessionId)!;
const summaries: string[] = [];

beforeEach(() => {
  summaries.length = 0;
  conversationMemory._setConversationMemorySummarizerForTests(async (transcript) => {
    summaries.push(transcript);
    const tag = transcript.match(/Find the (\S+) report/)?.[1] ?? 'unknown';
    return { title: `${tag} report`, summary: `The owner asked for the ${tag} report; Clem found /reports/${tag}.pdf.`, openThreads: [], references: [`/reports/${tag}.pdf`] };
  }, 'fixture-memory-model');
});

test('compaction keeps every message and call pair, shortens results to an excerpt with their handle, and drops reasoning', () => {
  const items = history('alpha') as never[];
  const { items: compacted, changed } = lifecycle.compactConversationItems(items, 9);
  assert.equal(changed, true);
  assert.equal(inspectConversationProtocol(compacted).status, 'valid');
  assert.equal(compacted.some((item) => (item as { type?: string }).type === 'reasoning'), false);
  const result = compacted.find((item) => (item as { type?: string }).type === 'function_call_result') as { output: { text: string } };
  assert.ok(result.output.text.length < 700, 'the result is an excerpt');
  assert.match(result.output.text, /left out after this conversation sat idle 9 days; the full result is rh_alphaabcdef/);
  const call = compacted.find((item) => (item as { type?: string }).type === 'function_call') as { arguments: string };
  assert.ok(JSON.parse(call.arguments).compacted, 'oversized arguments stay valid JSON');
  assert.deepEqual(compacted.filter((item) => 'role' in (item as object)), items.filter((item) => 'role' in (item as object)), 'messages verbatim');
  const synthetic = [{ type: 'function_call', callId: 'c', name: 'x', arguments: '{}' },
    { type: 'function_call_result', callId: 'c', name: 'x', status: 'completed', output: { type: 'text', text: JSON.stringify({ protocol: 'p', disposition: 'effect_unknown', pad: BIG }) } }] as never[];
  assert.equal(lifecycle.compactConversationItems(synthetic).changed, false, 'protocol evidence is never shortened');
});

test('the memory form is what memory kept and the last few messages as text', () => {
  const items = lifecycle.memoryConversationItems(history('beta') as never[], { summary: 'Remembered.', since: daysAgo(40), until: daysAgo(31) });
  assert.match((items[0] as { content: string }).content, /as Clem's memory kept it\]\nRemembered\./);
  assert.deepEqual(items.slice(1).map((item) => (item as { role: string }).role), ['user', 'assistant']);
  assert.equal(inspectConversationProtocol(items).status, 'valid');
});

test('a pass remembers idle chats, compacts a week-idle state, retires a month-idle one to its memory, and resuming still works', async () => {
  const fresh = chat('fresh', 2);
  const weekIdle = chat('week', 9);
  const monthIdle = chat('month', 40);
  const workflowStep = chat('step', 40, { kind: 'workflow' });
  const silent = chat('silent', 40, { transcript: false });
  const first = await conversationMemory.consolidateIdleConversations({ now: NOW });
  assert.equal(first.waiting, false);
  assert.equal(first.remembered, 2, 'both idle chats with a transcript are remembered');
  assert.equal(state(fresh).fidelity, 'full', 'a recent conversation is untouched');
  assert.equal(state(weekIdle).fidelity, 'compacted');
  assert.equal(state(weekIdle).state.lastResponseId, undefined, 'a rewritten history never continues the provider chain');
  assert.equal(state(monthIdle).fidelity, 'memory');
  assert.match(JSON.stringify(state(monthIdle).state), /Clem found \/reports\/month\.pdf/);
  assert.equal(state(workflowStep).fidelity, 'memory', 'a workflow step retires without a memory of its own');
  assert.equal(state(silent).fidelity, 'memory', 'a chat with nothing visible has nothing to remember');
  const episode = openMemoryDb().prepare("SELECT title, evidence_excerpt, subtype FROM memory_episodes WHERE session_id = ?").get(monthIdle) as Record<string, string>;
  assert.equal(episode.subtype, 'conversation');
  assert.match(episode.evidence_excerpt, /References: \/reports\/month\.pdf/);
  assert.match(summaries.join('\n'), /Owner: Find the month report\nClem: The month report is in/);
  assert.deepEqual(HarnessSession.load(monthIdle)!.toInputItems().map((item) => (item as { role?: string }).role), ['user', 'user', 'assistant']);

  const second = await conversationMemory.consolidateIdleConversations({ now: NOW });
  assert.equal(second.remembered + second.compacted + second.retired, 0, 'a second pass has nothing left to do');

  HarnessSession.load(monthIdle)!.updateConversationSnapshot([...HarnessSession.load(monthIdle)!.toInputItems(), { role: 'user', content: 'and the next one?' }] as never);
  assert.equal(state(monthIdle).fidelity, 'full', 'a new turn makes the state current again');
  assert.equal(state(monthIdle).memoryEpisodeId, null, 'and it will be remembered again once idle');
});

test('nothing is lowered while the conversation can still be picked up where it stopped', async () => {
  const pinned = chat('pinned', 40, { metadata: { pinned: true } });
  const parked = chat('parked', 40, { metadata: { __interrupt_state: '{"pending":[]}' } });
  const awaiting = chat('awaiting', 40);
  eventlog.openEventLog().prepare(`INSERT INTO pending_approvals (approval_id, session_id, requested_at, expires_at, subject, status)
    VALUES ('apr-fixture', ?, ?, ?, 'fixture', 'pending')`).run(awaiting, daysAgo(40), daysAgo(-1));
  const running = chat('running', 40);
  eventlog.openEventLog().prepare(`INSERT INTO run_attempts (attempt_id, session_id, run_id, started_at, status)
    VALUES ('attempt-fixture', ?, 'run-fixture', ?, 'active')`).run(running, daysAgo(40));
  const result = await conversationMemory.consolidateIdleConversations({ now: NOW });
  for (const sessionId of [pinned, parked, awaiting, running]) assert.equal(state(sessionId).fidelity, 'full', sessionId);
  assert.ok(result.held >= 4);
  assert.equal(lifecycle.conversationLifecycleHold(pinned), 'pinned');
  assert.equal(lifecycle.conversationLifecycleHold(awaiting), 'pending_approval');
  assert.equal(lifecycle.conversationLifecycleHold(running), 'unfinished_run');
});

test('without a memory model the pass waits to remember and still compacts', async () => {
  conversationMemory._setConversationMemorySummarizerForTests(null, null);
  const idle = chat('nomodel', 40);
  const result = await conversationMemory.consolidateIdleConversations({ now: NOW });
  assert.equal(result.waiting, true);
  assert.equal(state(idle).fidelity, 'compacted', 'a chat is never retired without its memory');
});

test('a call whose result is provenance-bound keeps its call and result whole, and a shortened one is restored byte for byte', () => {
  const items = history('bound') as never[];
  const kept = lifecycle.compactConversationItems(items, 9, (callId) => callId === 'call_bound');
  assert.deepEqual(kept.items.filter((item) => (item as { callId?: string }).callId === 'call_bound'),
    items.filter((item) => (item as { callId?: string }).callId === 'call_bound'), 'the bound pair is untouched');

  const sessionId = eventlog.createSession({ kind: 'chat', title: 'restore' }).id;
  const original = `found rh_boundabcdef ${BIG}`;
  eventlog.writeToolOutput({ sessionId, callId: 'call_bound', tool: 'search_files', output: original });
  const shortened = lifecycle.compactConversationItems(items, 9).items;
  const restored = lifecycle.restoreProvenanceBoundResults(sessionId, shortened, new Set(['call_bound']));
  assert.equal(restored.restored, 1);
  const result = restored.items.find((item) => (item as { type?: string }).type === 'function_call_result') as { output: { type: string; text: string } };
  assert.deepEqual(result.output, { type: 'text', text: original }, 'the exact original bytes, in the shape they had');
  assert.equal(lifecycle.restoreProvenanceBoundResults(sessionId, shortened, new Set()).restored, 0, 'an unbound result stays compacted');
  const unretained = lifecycle.restoreProvenanceBoundResults('no-such-session', shortened, new Set(['call_bound']));
  assert.deepEqual([unretained.restored, unretained.missing], [0, 1], 'without a retained original nothing is guessed');
});

test('a chat the model gave nothing usable for is asked again a day later, not on every pass', async () => {
  const sessionId = chat('unusable', 10);
  let calls = 0;
  conversationMemory._setConversationMemorySummarizerForTests(async (transcript) => {
    if (transcript.includes('Find the unusable report')) calls += 1;
    return null;
  }, 'fixture-memory-model');
  await conversationMemory.consolidateIdleConversations({ now: NOW });
  await conversationMemory.consolidateIdleConversations({ now: NOW });
  assert.equal(calls, 1, 'not asked again the same day');
  assert.match(String(state(sessionId).memoryEpisodeId), /^none:unusable-summary:2026-10-15$/);
  await conversationMemory.consolidateIdleConversations({ now: new Date(NOW.getTime() + 86_400_000) });
  assert.equal(calls, 2, 'asked again the next day');
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const unusable of [false, true]) {
  test(`late ${unusable ? 'unusable' : 'usable'} conversation summary cannot mark a resumed turn remembered`, { timeout: 5_000 }, async () => {
    const tag = unusable ? 'race-unusable' : 'race-usable';
    const sessionId = chat(tag, 8);
    const started = deferred<void>(), release = deferred<void>();
    let targetCalls = 0;
    conversationMemory._setConversationMemorySummarizerForTests(async (transcript) => {
      const target = transcript.includes(`Find the ${tag} report`);
      if (target && ++targetCalls === 1) { started.resolve(); await release.promise; if (unusable) return null; }
      return { title: tag, summary: transcript.includes('NEW-WORK-4812')
        ? 'The resumed conversation added NEW-WORK-4812.' : 'Only the previous report was discussed.', openThreads: [], references: [] };
    }, 'fixture-memory-model');
    const pending = conversationMemory.consolidateIdleConversations({ now: NOW });
    try {
      await started.promise;
      eventlog.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Please also complete NEW-WORK-4812.' } });
      const resumed = HarnessSession.load(sessionId)!;
      resumed.updateConversationSnapshot([...resumed.toInputItems(), { role: 'user', content: 'Please also complete NEW-WORK-4812.' }] as never);
      const resumedState = state(sessionId).stateJson;
      release.resolve();
      await pending;
      assert.equal(state(sessionId).stateJson, resumedState, 'the resumed state is not rewritten by idle upkeep');
      assert.equal(state(sessionId).memoryEpisodeId, null, 'late completion cannot restore a memory/sentinel marker');
      assert.equal(conversationMemory.conversationMemoryFor(sessionId), null, 'a stale usable summary is not published either');

      eventlog.openEventLog().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(daysAgo(8), sessionId);
      await conversationMemory.consolidateIdleConversations({ now: NOW });
      assert.equal(targetCalls, 2, 'new work remains eligible at its next idle pass, including after an unusable old answer');
      const memory = conversationMemory.conversationMemoryFor(sessionId);
      assert.ok(memory); assert.match(memory.summary, /NEW-WORK-4812/);
      assert.equal(state(sessionId).memoryEpisodeId, memory.episodeId);
    } finally { release.resolve(); await pending; }
  });
}

test('memory publication compares the event frontier even when state bytes and timestamps match', () => {
  const sessionId = chat('race-frontier', 8);
  const snapshot = lifecycle.captureConversationMemorySnapshot(sessionId)!;
  assert.ok(snapshot);
  eventlog.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'NEW-EVENT-9117 arrives before its snapshot.' } });
  // A timestamp alone cannot serve as a revision, even if two updates share a
  // clock tick (or an older writer restores it). The sequence still advances.
  eventlog.openEventLog().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(snapshot.sessionUpdatedAt, sessionId);
  assert.equal(state(sessionId).stateJson, snapshot.stateJson);
  let writes = 0;
  assert.equal(lifecycle.noteConversationMemory(sessionId, () => { writes++; return 'should-not-publish'; }, snapshot), false);
  assert.equal(writes, 0, 'a stale summary cannot even overwrite the durable episode');
  assert.equal(lifecycle.noteConversationMemory(sessionId, 'none:empty-transcript', snapshot), false, 'empty markers use the same fence');
  assert.equal(state(sessionId).memoryEpisodeId, null);
});

test('a resumed chat with an unusable summary retains working state instead of retiring to its old episode', async () => {
  const tag = 'retire-current-marker';
  const sessionId = chat(tag, 8);
  await conversationMemory.consolidateIdleConversations({ now: NOW });
  const oldMemory = conversationMemory.conversationMemoryFor(sessionId)!;
  assert.ok(oldMemory);
  assert.equal(state(sessionId).memoryEpisodeId, oldMemory.episodeId);

  eventlog.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Please preserve NEW-RETIRE-WORK-9321.' } });
  const resumed = HarnessSession.load(sessionId)!;
  resumed.updateConversationSnapshot([...resumed.toInputItems(), { role: 'user', content: 'Please preserve NEW-RETIRE-WORK-9321.' }] as never);
  assert.equal(state(sessionId).memoryEpisodeId, null);
  assert.equal(lifecycle.retireConversationStateToMemory(sessionId, { memory: oldMemory, nowMs: NOW.getTime() }), 'raced',
    'a selected old episode cannot replace a state whose marker has since cleared');

  eventlog.openEventLog().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(daysAgo(40), sessionId);
  conversationMemory._setConversationMemorySummarizerForTests(async () => null, 'fixture-memory-model');
  await conversationMemory.consolidateIdleConversations({ now: NOW });
  assert.equal(state(sessionId).fidelity, 'compacted', 'new work is retained when no current usable summary exists');
  assert.match(String(state(sessionId).memoryEpisodeId), /^none:unusable-summary:/);
  assert.match(JSON.stringify(state(sessionId).state), /NEW-RETIRE-WORK-9321/);
  assert.deepEqual(conversationMemory.conversationMemoryFor(sessionId), oldMemory, 'the previous episode remains history');

  conversationMemory._setConversationMemorySummarizerForTests(async () => ({ title: tag,
    summary: 'The resumed chat included NEW-RETIRE-WORK-9321.', openThreads: [], references: [] }), 'fixture-memory-model');
  await conversationMemory.consolidateIdleConversations({ now: new Date(NOW.getTime() + 86_400_000) });
  const currentMemory = conversationMemory.conversationMemoryFor(sessionId)!;
  assert.equal(state(sessionId).fidelity, 'memory', 'a legitimate current summary still permits retirement');
  assert.equal(state(sessionId).memoryEpisodeId, currentMemory.episodeId);
  assert.match(currentMemory.summary, /NEW-RETIRE-WORK-9321/);
  assert.match(JSON.stringify(state(sessionId).state), /NEW-RETIRE-WORK-9321/);
});

test('a turn marked not to learn from never becomes memory, and memory already made from one is expired', async () => {
  const { recordMemoryEpisode } = await import('./temporal-memory.js');
  const work = await import('./work-episodes.js');
  const policy = { version: 1, mode: 'exclude', reason: 'controlled_test' };
  const turn = (sessionId: string, tag: string, excluded: boolean) => {
    const source = eventlog.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
      data: { text: `Find the ${tag} report`, ...(excluded ? { learningPolicy: policy } : {}) } });
    eventlog.appendEvent({ sessionId, turn: 1, role: 'assistant', type: 'conversation_completed',
      data: { reply: `The ${tag} report is in /reports/${tag}.pdf.`, sourceUserSeq: source.seq } });
    return source.seq;
  };
  const testOnly = chat('testonly', 9, { transcript: false });
  const testSeq = turn(testOnly, 'testonly', true);
  const mixed = chat('mixed', 9, { transcript: false });
  turn(mixed, 'probe', true);
  turn(mixed, 'quarterly', false);
  for (const id of [testOnly, mixed]) {
    eventlog.openEventLog().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(daysAgo(9), id);
  }

  assert.equal(conversationMemory.conversationTranscript(testOnly).turns, 0, 'a test-only chat has nothing to remember');
  const kept = conversationMemory.conversationTranscript(mixed).text;
  assert.match(kept, /Find the quarterly report/);
  assert.doesNotMatch(kept, /probe/, 'the excluded turn and its answer stay out');
  assert.equal(work.recordWorkEpisode({ kind: 'answer', sessionId: testOnly, sourceUserSeq: testSeq, objective: 'Find the testonly report', outcome: 'found' }), null,
    'an excluded turn leaves no work episode');

  // Memory an earlier version made from them anyway.
  const leakedWork = recordMemoryEpisode({ kind: 'user_turn', subtype: 'completed_work', title: 'Completed answer', content: 'Answered: testonly',
    sessionId: testOnly, callId: `work:answer:${testSeq}`, occurredAt: daysAgo(9), status: 'available' });
  const leakedConversation = recordMemoryEpisode({ kind: 'reflection', subtype: 'conversation', title: 'probe and quarterly', content: 'The owner asked for the probe report.',
    sessionId: mixed, callId: 'conversation-memory', occurredAt: daysAgo(9), status: 'available' });
  eventlog.openEventLog().prepare('UPDATE session_conversation_state SET memory_episode_id = ? WHERE session_id = ?').run(leakedConversation.id, mixed);

  assert.ok(conversationMemory.expireLearningExcludedMemories(NOW, true) >= 2);
  const status = (id: string) => (openMemoryDb().prepare('SELECT status FROM memory_episodes WHERE id = ?').get(id) as { status: string }).status;
  assert.equal(status(leakedWork.id), 'expired');
  assert.equal(status(leakedConversation.id), 'expired');
  assert.equal(state(mixed).memoryEpisodeId, null, 'the chat is remembered again from what may be learned');
  assert.equal(conversationMemory.expireLearningExcludedMemories(NOW), 0, 'once a day');

  await conversationMemory.consolidateIdleConversations({ now: NOW, rememberLimit: 500 });
  assert.match(summaries.join('\n'), /Find the quarterly report/, 'the mixed chat is remembered again');
  assert.doesNotMatch(summaries.join('\n'), /probe|testonly/, 'the model never sees an excluded turn');
});

test('a memory model that stops answering pauses learning, and the next pass waits instead of asking it again', async () => {
  const reflection = await import('./reflection.js');
  reflection.setReflectionExtractorPauseForTest(null);
  chat('outage-a', 12);
  chat('outage-b', 12);
  let asked = 0;
  conversationMemory._setConversationMemorySummarizerForTests(async () => {
    asked += 1;
    throw Object.assign(new Error('upstream 503'), { statusCode: 503 });
  }, 'fixture-memory-model');
  try {
    const first = await conversationMemory.consolidateIdleConversations({ now: NOW, rememberLimit: 500 });
    assert.equal(first.remembered, 0);
    assert.equal(asked, 1, 'the pass stops at the first failure');
    const pause = reflection.reflectionExtractorPause();
    assert.ok(pause, 'the failure starts the backoff the Memory tab names');
    const second = await conversationMemory.consolidateIdleConversations({ now: NOW, rememberLimit: 500 });
    assert.equal(second.waiting, true);
    assert.equal(asked, 1, 'a paused model is not asked again');
  } finally {
    reflection.setReflectionExtractorPauseForTest(null);
  }
});

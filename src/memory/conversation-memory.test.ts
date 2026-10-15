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

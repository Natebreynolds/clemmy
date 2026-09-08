import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { assistant, type AgentInputItem } from '@openai/agents';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-public-replay-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { mergeMissingPublicTurns } = await import('./session-public-replay.js');
const { closeEventLog } = await import('./eventlog.js');
after(() => { closeEventLog(); rmSync(home, { recursive: true, force: true }); });
const user = (content: string) => ({ role: 'user', content } as AgentInputItem);
const call = (id: string) => ({ type: 'function_call', name: 'call_tool', callId: id, arguments: '{}' } as AgentInputItem);
const result = (id: string, text: string) => ({ type: 'function_call_result', name: 'call_tool', callId: id, output: { type: 'text', text }, status: 'completed' } as AgentInputItem);
const prior = (source: number, text: string, who: 'user' | 'assistant', sessionId = 'session') => ({ who, text, at: '2026-09-07T00:00:00Z',
  identity: { sessionId, sourceUserSeq: source, eventSeq: who === 'user' ? source : source + 1 } });

test('a missing stopped terminal follows its exact source tool evidence before the next question', () => {
  const body = 'FRAMEWORK BODY\n'.repeat(2000);
  const history = [user('Inspect this framework.'), call('old-call'), result('old-call', body)];
  const merged = mergeMissingPublicTurns({ sessionId: 'session', sourceUserSeq: 30, history,
    prior: [prior(10, 'Inspect this framework.', 'user'), prior(10, 'I stopped this inspection.', 'assistant')],
    sourceByResultIndex: new Map([[2, 10]]) });
  assert.deepEqual(merged, [...history, assistant('I stopped this inspection.')]);
  assert.equal(JSON.stringify(merged.slice(0, 3)), JSON.stringify(history), 'full original reference bytes remain intact');
  assert.ok(!merged.some(item => (item as { role?: string }).role === 'system'));
  assert.deepEqual(merged.at(-1), { type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'I stopped this inspection.' }], providerData: undefined },
  'the SDK-supported assistant message preserves exact public text for provider serialization');
});

test('identical user wording on two sources does not substitute their different terminals', () => {
  const history = [user('Check it.'), call('a'), result('a', 'A'), user('Check it.'), call('b'), result('b', 'B')];
  const merged = mergeMissingPublicTurns({ sessionId: 'session', sourceUserSeq: 40, history,
    prior: [prior(10, 'Check it.', 'user'), prior(10, 'First source stopped.', 'assistant'), prior(20, 'Check it.', 'user'), prior(20, 'Second source completed.', 'assistant')],
    sourceByResultIndex: new Map([[2, 10], [5, 20]]) });
  assert.deepEqual(merged, [...history.slice(0, 3), assistant('First source stopped.'), ...history.slice(3), assistant('Second source completed.')]);
});

test('exact existing source terminal is not replayed twice', () => {
  const history = [user('Inspect.'), call('a'), result('a', 'Full source.'), assistant('Inspection stopped.')];
  assert.deepEqual(mergeMissingPublicTurns({ sessionId: 'session', sourceUserSeq: 30, history,
    prior: [prior(10, 'Inspect.', 'user'), prior(10, 'Inspection stopped.', 'assistant')], sourceByResultIndex: new Map([[2, 10]]) }), history);
});

test('an empty snapshot receives full canonical public roles and excludes another/current source', () => {
  const merged = mergeMissingPublicTurns({ sessionId: 'session', sourceUserSeq: 30, history: [],
    prior: [prior(10, 'Inspect.', 'user'), prior(10, 'Stopped.', 'assistant'), prior(30, 'Current ask.', 'user'), prior(20, 'Other principal.', 'assistant', 'other')],
    sourceByResultIndex: new Map() });
  assert.deepEqual(merged, [user('Inspect.'), assistant('Stopped.')]);
});

test('unanchored legacy material stays explicitly historical rather than gaining source placement', () => {
  const history = [user('Check it.'), assistant('Known old answer.')];
  const merged = mergeMissingPublicTurns({ sessionId: 'session', sourceUserSeq: 30, history,
    prior: [prior(20, 'Check it.', 'user'), prior(20, 'Different unanchored answer.', 'assistant')], sourceByResultIndex: new Map() });
  assert.deepEqual(merged.slice(0, history.length), history);
  assert.equal((merged.at(-1) as { role: string }).role, 'assistant');
  assert.match(JSON.stringify((merged.at(-1) as { content?: unknown }).content), /placement.*unavailable/);
  assert.match(JSON.stringify((merged.at(-1) as { content?: unknown }).content), /source=20/);
});

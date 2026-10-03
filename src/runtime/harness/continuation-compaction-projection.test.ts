/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/continuation-compaction-projection.test.ts
 *
 * Live 10-02 (sess-desktop-c2d014f976a7282e1ac7e1c6, source 345440): a judge
 * retry compacted the conversation 71.8k → 30.3k tokens, then sent ~83k on
 * every frame of the retry — a same-source continuation runs on the source's
 * exact accepted history, which begins with the conversation as it stood
 * before the compaction, and that history must stay byte-exact for the
 * accepted-batch chain. The model-facing frame is now projected: an input
 * that begins with exactly the pre-compaction conversation is sent with its
 * compacted form. A fresh turn is unchanged.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-continuation-projection-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.HARNESS_STALL_ASK_USER = 'off';
process.env.HARNESS_MAX_STALL_RETRIES = '1';
process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
process.env.HARNESS_TOOL_BRACKETS = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AgentInputItem, Runner } from '@openai/agents';

const { appendEvent, listEvents, resetEventLog, writeToolOutput } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runTurn } = await import('./loop.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;

const makeRunnerStub = (): Runner => new EventEmitter() as unknown as Runner;
// A known routed model sets the real compaction budgets (Layer 1 at 30% of a
// 200k-token window), as on the live wire.
const makeAgentStub = () => ({ model: 'claude-sonnet-5' }) as unknown as import('@openai/agents').Agent<any, any>;

/** A long conversation of tool reads: well past Layer 1's threshold, so the
 *  between-turn compaction clips and collapses its older pairs. */
function longConversation(sessionId: string): AgentInputItem[] {
  const items: AgentInputItem[] = [];
  for (let turn = 0; turn < 8; turn += 1) {
    items.push({ role: 'user', content: `Audit platform part ${turn}.` } as AgentInputItem);
    for (let i = 0; i < 5; i += 1) {
      const id = `call-${turn}-${i}`;
      items.push({ type: 'function_call', callId: id, name: 'read_file', arguments: JSON.stringify({ path: `notes/${turn}-${i}.md` }), status: 'completed' } as AgentInputItem);
      const text = `record ${turn}.${i}: ${'platform detail and transcript text. '.repeat(260)}`;
      // Every full result is durably parked, as the tool-end hook does, so
      // Layer 1 may clip it losslessly (recallable by call id).
      writeToolOutput({ sessionId, callId: id, invocationNonce: `nonce-${id}`, tool: 'read_file', output: text });
      items.push({ type: 'function_call_result', callId: id, name: 'read_file', status: 'completed',
        output: { type: 'text', text } } as AgentInputItem);
    }
    items.push({ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Part ${turn} drafted.` }] } as AgentInputItem);
  }
  return items;
}

async function turnWithFilter(options: { hostOwnedContinuation?: true }) {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat' });
  const prior = longConversation(session.id);
  session.recordTurnResult({ history: prior, lastResponseId: undefined, turn: 1 });
  const source = appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Is Vapi the better platform?' } });
  // What a host runner resuming this source sends: the exact accepted history
  // (the conversation before compaction) plus the source's own frame.
  const frame = { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Checking.' }] } as AgentInputItem;
  let sent: AgentInputItem[] = [];
  let compactedInput: AgentInputItem[] = [];
  const runRunner: RunRunnerFn = async (_runner, _agent, items, opts) => {
    compactedInput = items;
    const filter = opts.callModelInputFilter as (args: { modelData: { input: AgentInputItem[]; instructions?: string } }) => { input: AgentInputItem[] };
    sent = filter({ modelData: { input: [...prior, frame], instructions: 'base' } }).input;
    return { history: [...items, frame], lastResponseId: undefined, finalOutput: 'ok' };
  };
  await runTurn({
    agent: makeAgentStub(), sessionId: session.id, input: 'Is Vapi the better platform?',
    sourceUserSeq: source.seq, reuseRecordedUserInput: true, suppressMemoryCapture: true,
    ...(options.hostOwnedContinuation ? { hostOwnedContinuation: true as const } : {}),
    makeRunner: makeRunnerStub, runRunner,
  });
  return { session, prior, frame, sent, compactedInput };
}

test('a same-source continuation sends the compacted conversation, its accepted history untouched', async () => {
  const { session, prior, frame, sent, compactedInput } = await turnWithFilter({ hostOwnedContinuation: true });
  const compaction = listEvents(session.id, { types: ['condenser_applied'] });
  assert.ok(compaction.some((event) => (event.data.layer1 as { applied?: boolean } | undefined)?.applied === true),
    'the long conversation compacts at the continuation boundary');
  assert.ok(compactedInput.length < prior.length, 'the snapshot is compacted');
  assert.equal(JSON.stringify(sent.slice(0, compactedInput.length)), JSON.stringify(compactedInput),
    'the model sees the compacted conversation');
  assert.deepEqual(sent[compactedInput.length], frame, 'the source\'s own frame follows it unchanged');
  assert.ok(JSON.stringify(sent).length < JSON.stringify([...prior, frame]).length / 2, 'and it is much smaller');
  assert.ok(compaction.some((event) => event.data.kind === 'continuation_projection'), 'the projection is recorded');
});

test('a fresh turn\'s model input is not projected', async () => {
  const { prior, frame, sent } = await turnWithFilter({});
  assert.equal(JSON.stringify(sent.slice(0, prior.length)), JSON.stringify(prior),
    'an input the host did not resume is sent as given');
  assert.deepEqual(sent[prior.length], frame);
});

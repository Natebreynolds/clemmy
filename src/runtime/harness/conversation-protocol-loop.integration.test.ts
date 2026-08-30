import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Agent, AgentInputItem, Runner } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-conversation-protocol-loop-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HARNESS_TOOL_BRACKETS = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runTurn } = await import('./loop.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function runner(): Runner {
  return new EventEmitter() as unknown as Runner;
}

function agent(): Agent<any, any> {
  return {} as Agent<any, any>;
}

function user(text: string): AgentInputItem {
  return { role: 'user', content: text } as AgentInputItem;
}

function orphan(callId: string): AgentInputItem {
  return {
    type: 'function_call_result',
    callId,
    name: 'legacy_tool',
    output: { type: 'text', text: '{}' },
    status: 'completed',
  } as AgentInputItem;
}

test('legacy quarantine runs before compaction and the current fresh source reaches the runner', async () => {
  eventlog.resetEventLog();
  const session = HarnessSession.create({ id: 'protocol-loop-fresh', kind: 'workflow' });
  const prefix = user('Valid legacy prefix.');
  const poison = orphan('call-orphan-loop');
  session.recordTurnResult({
    history: [prefix, poison],
    lastResponseId: 'stale-chain',
    turn: 1,
  });
  let received: AgentInputItem[] | null = null;
  const runRunner: RunRunnerFn = async (_runner, _agent, items) => {
    received = items;
    return {
      history: [
        ...items,
        { role: 'assistant', content: 'done', status: 'completed' } as AgentInputItem,
      ],
      lastResponseId: 'response-after-repair',
      finalOutput: 'done',
    };
  };

  const result = await runTurn({
    sessionId: session.id,
    agent: agent(),
    input: 'Completely unrelated current source.',
    suppressMemoryCapture: true,
    makeRunner: runner,
    runRunner,
  });

  assert.equal(result.status, 'completed');
  assert.ok(received);
  const sent = received as AgentInputItem[];
  assert.equal(sent.some((item) => (item as { callId?: string }).callId === 'call-orphan-loop'), false);
  assert.equal((sent.at(-1) as { role?: string; content?: string }).role, 'user');
  assert.equal((sent.at(-1) as { content?: string }).content, 'Completely unrelated current source.');
  const quarantine = eventlog.getSession(session.id)?.metadata
    .__conversation_protocol_quarantine as Array<{ originalItems?: AgentInputItem[] }>;
  assert.equal(JSON.stringify(quarantine[0]?.originalItems), JSON.stringify([poison]));
});

test('pending approval returns a nonterminal hold before runner/provider dispatch', async () => {
  eventlog.resetEventLog();
  const session = HarnessSession.create({ id: 'protocol-loop-pending', kind: 'workflow' });
  session.recordTurnResult({
    history: [user('Approval-owned source.')],
    lastResponseId: 'response-before-pause',
    turn: 1,
  });
  session.saveInterruptState(JSON.stringify({
    __clemHostInterrupt: 2,
    history: [user('Approval-owned source.')],
    pending: [{
      callId: 'call-pending-loop',
      name: 'send_message',
      rawItem: { callId: 'call-pending-loop', name: 'send_message', arguments: '{}' },
    }],
    turnEngine: 'host_v1',
  }));
  let dispatches = 0;

  const result = await runTurn({
    sessionId: session.id,
    agent: agent(),
    input: 'This source must wait behind the approval owner.',
    suppressMemoryCapture: true,
    makeRunner: runner,
    runRunner: async () => {
      dispatches += 1;
      throw new Error('runner must remain unreachable');
    },
  });

  assert.equal(result.status, 'held');
  assert.deepEqual(result.hold, {
    owner: 'host',
    wake: 'recovery',
    reason: 'recovery_pending',
  });
  assert.equal(dispatches, 0);
  assert.equal(session.previousResponseId(), 'response-before-pause');
});

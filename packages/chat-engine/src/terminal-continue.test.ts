import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalContinueGate, canContinueTerminal, sameTerminalContinuation } from './terminal-continue.js';
import { terminalFactsFrom } from './terminal-presentation.js';
import type { ChatMessage } from './types.js';

function paused(patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'pause-1', role: 'assistant', text: 'The next part is ready.', status: 'awaiting-reply',
    terminal: { status: 'needs_input', kind: 'continue', needs: 'continue', resumable: true,
      retained: { results: 3, outsideChange: 'none' } }, ...patch };
}

test('an exact typed resumable continuation with no choices gets a next action', () => {
  assert.equal(canContinueTerminal(paused()), true);
  const terminal = terminalFactsFrom({
    presentation: { status: 'needs_input', kind: 'continue' },
    turnOutcome: { status: 'needs_input', needs: { kind: 'continue' }, resumable: true },
  });
  assert.equal(canContinueTerminal(paused({ terminal })), true);
  assert.equal(canContinueTerminal(paused({ options: [] })), true);
  assert.equal(canContinueTerminal(paused({ terminal: { status: 'needs_input', needs: 'continue', resumable: true } })), false);
  assert.equal(canContinueTerminal(paused({ terminal: { status: 'needs_input', kind: 'continue', resumable: true } })), false);
});

test('prose, stale/live status, contradictory facts and dedicated controls never become Continue', () => {
  for (const status of ['thinking', 'complete', 'failed', 'stopped'] as const) {
    assert.equal(canContinueTerminal(paused({ status })), false, status);
  }
  assert.equal(canContinueTerminal(paused({ role: 'user' })), false);
  assert.equal(canContinueTerminal(paused({ terminal: undefined, text: 'Say continue' })), false);
  assert.equal(canContinueTerminal(paused({ options: ['Continue', 'Change the plan'] })), false);
  assert.equal(canContinueTerminal(paused({ approval: { approvalId: 'approval-fixture' } as ChatMessage['approval'] })), false);
  assert.equal(canContinueTerminal(paused({ planProposalId: 'plan-fixture' })), false);
  assert.equal(canContinueTerminal(paused({ planArtifactRef: { revision: 1 } as ChatMessage['planArtifactRef'] })), false);
  const terminal = paused().terminal!;
  for (const value of [false, undefined]) {
    assert.equal(canContinueTerminal(paused({ terminal: { ...terminal, resumable: value } })), false);
  }
  for (const status of ['done', 'blocked', 'cancelled', 'failed', 'transferred', 'uncertain'] as const) {
    assert.equal(canContinueTerminal(paused({ terminal: { ...terminal, status } })), false, status);
  }
  for (const kind of ['answer', 'question', 'approval'] as const) {
    assert.equal(canContinueTerminal(paused({ terminal: { ...terminal, kind } })), false, kind);
  }
  for (const needs of ['input', 'approval'] as const) {
    assert.equal(canContinueTerminal(paused({ terminal: { ...terminal, needs } })), false, needs);
  }
  for (const outsideChange of ['uncertain', 'mixed', 'refused'] as const) {
    assert.equal(canContinueTerminal(paused({ terminal: { ...terminal, retained: { results: 3, outsideChange } } })), false, outsideChange);
  }
  assert.equal(canContinueTerminal(paused({ terminal: { ...terminal, notice: { code: 'run_failed' } } })), false);
});

test('one continuation send remains latched through rapid clicks and after acknowledgement', async () => {
  const gate = new TerminalContinueGate();
  let finish!: () => void;
  let sends = 0;
  const send = () => { sends++; return new Promise<void>(resolve => { finish = resolve; }); };
  const first = gate.run(send);
  assert.equal(gate.phase, 'sending');
  assert.equal(await gate.run(send), false);
  assert.equal(sends, 1);
  finish();
  assert.equal(await first, true);
  assert.equal(gate.phase, 'sent');
  assert.equal(await gate.run(send), false);
  assert.equal(sends, 1);
});

test('an old click cannot answer a replacement source, terminal or mode after preparation', () => {
  const expected = paused({ acceptedSource: { sessionId: 'fixture-session', sourceUserSeq: 10, turn: 1 } });
  assert.equal(sameTerminalContinuation(expected, structuredClone(expected)), true);
  assert.equal(sameTerminalContinuation(expected, undefined), false);
  assert.equal(sameTerminalContinuation(expected, { ...expected, id: 'new-pause' }), false);
  assert.equal(sameTerminalContinuation(expected, { ...expected, acceptedSource: { ...expected.acceptedSource!, sourceUserSeq: 12 } }), false);
  assert.equal(sameTerminalContinuation(expected, { ...expected, terminal: { ...expected.terminal!, retained: { results: 4, outsideChange: 'none' } } }), false);
  assert.equal(sameTerminalContinuation(expected, { ...expected, taskMode: { version: 1, kind: 'plan' } }), false);
  assert.equal(sameTerminalContinuation(expected, { ...expected, status: 'thinking' }), false);
});

test('a rejected or synchronously thrown send can be deliberately retried', async () => {
  for (const send of [() => Promise.reject(new Error('fixture offline')), () => { throw new Error('fixture offline'); }]) {
    const gate = new TerminalContinueGate();
    await assert.rejects(gate.run(send), /fixture offline/);
    assert.equal(gate.phase, 'idle');
    assert.equal(await gate.run(() => undefined), true);
    assert.equal(gate.phase, 'sent');
  }
});

test('each new terminal owns a separate gate and never replays the previous send', async () => {
  const previous = new TerminalContinueGate();
  let sends = 0;
  await previous.run(() => { sends++; });
  const next = new TerminalContinueGate();
  assert.equal(next.phase, 'idle');
  assert.equal(await previous.run(() => { sends++; }), false);
  assert.equal(await next.run(() => { sends++; }), true);
  assert.equal(sends, 2);
});

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(tmpdir(), 'clemmy-test-turn-facts-'));
const { appendEvent, createSession } = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const { turnFactsFor } = await import('./turn-facts.js');

function sessionWithTerminal(id: string, presentation: Record<string, unknown>): string {
  createSession({ id, kind: 'chat' });
  appendEvent({ sessionId: id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'do the thing' } });
  appendEvent({ sessionId: id, turn: 1, role: 'Clem', type: 'conversation_completed', data: { summary: 'x', presentation } });
  return id;
}

test('after a finished turn with nothing pending, the brain is told nothing is waiting on the owner', () => {
  const id = sessionWithTerminal('turn-facts-done', { status: 'done', kind: 'answer', text: 'Done — appended.' });
  const facts = turnFactsFor(id);
  assert.ok(facts?.startsWith('[turn-facts:v1]'), facts);
  assert.match(facts!, /Nothing is waiting on the owner/);
  assert.match(facts!, /do not repeat finished work/);
});

test('after the owner stopped a turn, the brain is told it was their decision, not a failure to reconcile', () => {
  const id = sessionWithTerminal('turn-facts-stopped', { status: 'cancelled', kind: 'stopped', text: 'Stopped as requested. Completed results are kept.' });
  const facts = turnFactsFor(id);
  assert.match(facts!, /The owner stopped your previous turn themselves/);
  assert.match(facts!, /not a failure to reconcile/);
  assert.match(facts!, /do not restart the stopped work unless they ask/);
});

test('a pending card means something IS waiting: no fact is written', () => {
  const id = sessionWithTerminal('turn-facts-pending', { status: 'needs_input', kind: 'approval', text: 'Can I run it?' });
  approvalRegistry.register({ sessionId: id, tool: 'run_shell_command', subject: 'Run a command', args: { command: 'echo x' } } as never);
  assert.equal(turnFactsFor(id), undefined);
});

test('a turn that asked a question leaves the question in charge: no fact is written', () => {
  const id = sessionWithTerminal('turn-facts-question', { status: 'needs_input', kind: 'question', text: 'Which title?' });
  assert.equal(turnFactsFor(id), undefined);
});

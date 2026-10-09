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

test('a turn spoken in voice mode tells the brain its reply will be heard, beside any other fact', () => {
  const id = 'turn-facts-voice';
  createSession({ id, kind: 'chat' });
  appendEvent({ sessionId: id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'what is on my calendar today', voice: true } });
  const facts = turnFactsFor(id);
  assert.ok(facts?.startsWith('[turn-facts:v1]\n'), facts);
  assert.match(facts!, /will hear your reply read aloud/);
  assert.match(facts!, /Use your tools and memory exactly as you would in text/);

  const later = sessionWithTerminal('turn-facts-voice-after-done', { status: 'done', kind: 'answer', text: 'Done.' });
  appendEvent({ sessionId: later, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'and tomorrow?', voice: true } });
  const both = turnFactsFor(later)!;
  assert.equal(both.split('[turn-facts:v1]').length, 2, 'one header for every fact');
  assert.match(both, /Nothing is waiting on the owner/);
  assert.match(both, /read aloud/);
});

test('a typed turn carries no voice fact', () => {
  const id = sessionWithTerminal('turn-facts-typed', { status: 'needs_input', kind: 'question', text: 'Which title?' });
  appendEvent({ sessionId: id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'the first one' } });
  assert.equal(turnFactsFor(id), undefined);
});

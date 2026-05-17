/**
 * Run: npx tsx --test src/runtime/harness/session.test.ts
 *
 * Contracts HarnessSession must keep:
 *   - create() emits session_started and round-trips via load()
 *   - recordUserInput() persists the prompt as a user_input_received event
 *   - recordTurnResult() snapshots history + lastResponseId so the next
 *     process can resume the conversation and pass previousResponseId
 *   - saveInterruptState() round-trips a RunState blob across reopen
 *     (this is the approvals-after-restart path)
 *   - markStatus('completed' | 'failed') emits the matching terminal
 *     event so monitors don't have to guess
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-session-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentInputItem } from '@openai/agents';

// Dynamic imports: BASE_DIR is read at module load (see config.ts:11),
// so anything that touches it must be imported AFTER the env is set.
const { closeEventLog, resetEventLog, listEvents } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('create + load round-trips and emits session_started', () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat', title: 'demo', channel: 'cli' });
  const loaded = HarnessSession.load(sess.id);
  assert.ok(loaded);
  assert.equal(loaded!.id, sess.id);
  assert.equal(loaded!.sessionRow.title, 'demo');

  const events = listEvents(sess.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'session_started');
  assert.equal(events[0].data.kind, 'chat');
  assert.equal(events[0].data.channel, 'cli');
});

test('records user input as a user_input_received event', () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  sess.recordUserInput('hello clementine', 1);
  const events = listEvents(sess.id, { types: ['user_input_received'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.text, 'hello clementine');
  assert.equal(events[0].turn, 1);
});

test('recordTurnResult persists history and lastResponseId across reopen', () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const items: AgentInputItem[] = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'hello back' }],
    },
  ];
  sess.recordTurnResult({ history: items, lastResponseId: 'resp_abc', turn: 1 });
  closeEventLog();

  const reloaded = HarnessSession.load(sess.id);
  assert.ok(reloaded);
  assert.equal(reloaded!.previousResponseId(), 'resp_abc');
  const replayed = reloaded!.toInputItems();
  assert.equal(replayed.length, 2);
  const first = replayed[0];
  const second = replayed[1];
  assert.ok('role' in first && first.role === 'user');
  assert.ok('role' in second && second.role === 'assistant');

  const ended = listEvents(sess.id, { types: ['turn_ended'] });
  assert.equal(ended.length, 1);
  assert.equal(ended[0].data.lastResponseId, 'resp_abc');
});

test('previousResponseId is undefined until first recordTurnResult', () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  assert.equal(sess.previousResponseId(), undefined);
  sess.recordTurnResult({ history: [], lastResponseId: 'r1', turn: 1 });
  assert.equal(sess.previousResponseId(), 'r1');
});

test('toInputItems returns empty list for a fresh session', () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  assert.deepEqual(sess.toInputItems(), []);
});

test('saveInterruptState round-trips across reopen (approval resume)', () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const blob = '{"$schemaVersion":1,"context":{},"items":[]}';
  sess.saveInterruptState(blob);
  closeEventLog();

  const reloaded = HarnessSession.load(sess.id);
  assert.ok(reloaded);
  assert.equal(reloaded!.loadInterruptState(), blob);

  const paused = listEvents(sess.id, { types: ['run_paused'] });
  assert.equal(paused.length, 1);
  assert.equal(paused[0].data.bytes, blob.length);

  reloaded!.clearInterruptState();
  assert.equal(reloaded!.loadInterruptState(), null);
  const resumed = listEvents(sess.id, { types: ['run_resumed'] });
  assert.equal(resumed.length, 1);
});

test('clearInterruptState is a no-op when nothing was saved', () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  sess.clearInterruptState();
  const resumed = listEvents(sess.id, { types: ['run_resumed'] });
  assert.equal(resumed.length, 0, 'no resume event when there was no pause');
});

test('markStatus updates the session row but does NOT emit a terminal event', () => {
  // The harness loop owns the terminal event (with rich payload —
  // toolCalls count, finalOutput preview); markStatus only flips
  // the row status so the two callers don't double-emit.
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'execution' });
  sess.markStatus('completed');
  sess.refresh();
  assert.equal(sess.sessionRow.status, 'completed');
  const completions = listEvents(sess.id, { types: ['run_completed'] });
  assert.equal(completions.length, 0, 'markStatus does not emit run_completed');
});

test('markStatus("failed") flips the row status without emitting', () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'execution' });
  sess.markStatus('failed');
  sess.refresh();
  assert.equal(sess.sessionRow.status, 'failed');
  const failures = listEvents(sess.id, { types: ['run_failed'] });
  assert.equal(failures.length, 0, 'markStatus does not emit run_failed');
});

test('two turns: second recordTurnResult overwrites the conversation snapshot', () => {
  resetEventLog();
  const sess = HarnessSession.create({ kind: 'chat' });
  const t1: AgentInputItem[] = [{ role: 'user', content: 'hi' }];
  sess.recordTurnResult({ history: t1, lastResponseId: 'r1', turn: 1 });

  const t2: AgentInputItem[] = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'hello' }],
    },
    { role: 'user', content: 'how are you?' },
  ];
  sess.recordTurnResult({ history: t2, lastResponseId: 'r2', turn: 2 });

  closeEventLog();
  const reloaded = HarnessSession.load(sess.id);
  assert.equal(reloaded!.toInputItems().length, 3);
  assert.equal(reloaded!.previousResponseId(), 'r2');

  const turnEnds = listEvents(sess.id, { types: ['turn_ended'] });
  assert.equal(turnEnds.length, 2, 'audit log records both boundaries');
});

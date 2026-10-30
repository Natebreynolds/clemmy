/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/computer-recipe-store.test.ts
 *
 * A request's own driver calls (direct or carried by work_call) and their
 * full stored results become a saved task under the owner's words; repeating
 * it drives the computer with no model; a task that only looked is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-computer-tasks-'));
process.env.CLEMENTINE_HOME = HOME;
test.after(() => rmSync(HOME, { recursive: true, force: true }));

const { appendEvent, closeEventLog, createSession, writeToolOutput } = await import('./harness/eventlog.js');
const store = await import('./computer-recipe-store.js');
test.after(() => closeEventLog());

const structured = (content: Record<string, unknown>) => JSON.stringify({ result: { content: [], structuredContent: content, isError: false } });

function request(sessionId: string, text: string, calls: Array<{ tool: string; args: Record<string, unknown>; output: string; carried?: boolean }>): number {
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text } }).seq;
  calls.forEach((call, index) => {
    const callId = `call-${sessionId}-${index}`;
    appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'tool_called', data: call.carried
      ? { tool: 'work_call', effectiveTool: call.tool, callId, sourceUserSeq: source, arguments: JSON.stringify({ name: call.tool, args_json: JSON.stringify(call.args) }) }
      : { tool: call.tool, callId, sourceUserSeq: source, args: JSON.stringify(call.args) } });
    writeToolOutput({ sessionId, callId, tool: call.tool, output: call.output });
  });
  return source;
}

test('a finished request is saved under the owner\'s words and repeats with no model', async () => {
  const sourceUserSeq = request('task-notes', 'Open Notes and start a TEST FIXTURE note', [
    { tool: 'cua-driver__launch_app', args: { bundle_id: 'com.apple.Notes' }, output: structured({ pid: 19529 }), carried: true },
    { tool: 'cua-driver__list_windows', args: { app: 'Notes', pid: 19529 }, output: structured({ windows: [{ app_name: 'Notes', title: 'Notes', window_id: 273 }] }) },
    { tool: 'cua-driver__hotkey', args: { pid: 19529, window_id: 273, keys: ['cmd', 'n'] }, output: structured({}), carried: true },
    { tool: 'cua-driver__type_text', args: { pid: 19529, window_id: 273, text: 'TEST FIXTURE' }, output: structured({}), carried: true },
  ]);
  const saved = store.saveComputerTask({ sessionId: 'task-notes', sourceUserSeq });
  assert.equal(saved.status, 'saved', JSON.stringify(saved));
  if (saved.status !== 'saved') return;
  assert.equal(saved.task.name, 'Open Notes and start a TEST FIXTURE note');
  assert.deepEqual(saved.task.recipe.steps.map((step) => step.kind), ['launch', 'window', 'hotkey', 'type']);
  assert.deepEqual(store.listComputerTasks().map((task) => task.id), [saved.task.id]);

  const asked: string[] = [];
  const outcome = await store.repeatComputerTask(saved.task.id, async (tool) => {
    asked.push(tool);
    if (tool === 'launch_app') return { result: { isError: false, structuredContent: { pid: 900 } } };
    if (tool === 'list_windows') return { result: { isError: false, structuredContent: { windows: [{ app_name: 'Notes', title: 'Notes', window_id: 31 }] } } };
    return { result: { isError: false, structuredContent: {} } };
  });
  assert.deepEqual(outcome, { status: 'done', steps: 4 });
  assert.deepEqual(asked, ['launch_app', 'list_windows', 'hotkey', 'type_text']);
  assert.equal(store.deleteComputerTask(saved.task.id), true);
  assert.equal(await store.repeatComputerTask(saved.task.id, async () => ({})), null);
});

test('a request that only looked is not saved, and another request\'s calls are never read', () => {
  const looked = request('task-looked', 'What windows does Notes have?', [
    { tool: 'cua-driver__list_windows', args: { app: 'Notes' }, output: structured({ windows: [] }) },
  ]);
  assert.deepEqual(store.saveComputerTask({ sessionId: 'task-looked', sourceUserSeq: looked }),
    { status: 'not_repeatable', reason: 'it only looked; there is nothing to repeat' });
  const later = appendEvent({ sessionId: 'task-looked', turn: 2, role: 'user', type: 'user_input_received', data: { text: 'next' } }).seq;
  assert.deepEqual(store.readComputerTrace({ sessionId: 'task-looked', sourceUserSeq: later }), []);
});

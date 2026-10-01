/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/transcript-clem-message.test.ts
 *
 * What Clem raises on her own reads, in her own conversation, as her
 * messages in the order she sent them — only hers, held to the public floor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-transcript-message-'));
process.env.CLEMENTINE_HOME = TMP;
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const { appendEvent, createSession } = await import('./eventlog.js');
const { reconstructHarnessTranscript, harnessPreview } = await import('./transcript.js');

test('her own messages show in order, attributed to her; anything else wearing the type does not', () => {
  createSession({ id: 'clem', kind: 'chat', channel: 'desktop', title: 'Clem' });
  appendEvent({ sessionId: 'clem', turn: 0, role: 'Clem', type: 'clem_message', data: { version: 1, key: 'a', heartbeat: 'calendar', text: 'Your 4:00 was cancelled.' } });
  appendEvent({ sessionId: 'clem', turn: 0, role: 'user', type: 'clem_message', data: { version: 1, key: 'b', heartbeat: 'calendar', text: 'Not hers.' } });
  appendEvent({ sessionId: 'clem', turn: 0, role: 'Clem', type: 'clem_message', data: { version: 1, key: 'c', heartbeat: 'work-review', text: 'The standup email is still waiting on you.' } });
  const turns = reconstructHarnessTranscript('clem');
  assert.deepEqual(turns.map((turn) => [turn.role, turn.text, turn.fromClem]), [
    ['assistant', 'Your 4:00 was cancelled.', true],
    ['assistant', 'The standup email is still waiting on you.', true],
  ]);
  assert.equal(harnessPreview('clem'), 'The standup email is still waiting on you.');
});

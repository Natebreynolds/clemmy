import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceActivity } from './reduce-activity.js';
import { settleTerminalActivity } from './activity-presentation.js';
import { foldTranscript } from './engine.js';
import type { HarnessEvent } from './types.js';

function event(seq: number, type: string, callId = 'call-a'): HarnessEvent {
  return { seq, type, data: { callId, toolName: 'OUTLOOK_CREATE_DRAFT',
    targets: ['person@example.test'], ...(type === 'external_write' ? { preDispatch: true } : {}) } };
}

test('chat completion cannot certify a reservation; its later exact terminal settles the same row', () => {
  const reserved = reduceActivity([], event(1, 'external_write'));
  assert.equal(reserved[0]?.status, 'running');
  assert.match(reserved[0]?.label ?? '', /^Creating a draft/);
  const completedChat = settleTerminalActivity(reserved, 'completed');
  assert.equal(completedChat[0]?.write?.disposition, 'unknown');
  assert.equal(completedChat[0]?.status, 'interrupted');
  assert.equal(completedChat[0]?.tone, 'warning');
  const settled = reduceActivity(completedChat, event(2, 'external_write_succeeded'));
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.write?.disposition, 'confirmed');
  assert.equal(settled[0]?.status, 'done');
});

test('refusal and unresolved sibling remain distinct from a real successful write', () => {
  let rows = reduceActivity([], event(1, 'external_write', 'failed'));
  rows = reduceActivity(rows, event(2, 'external_write_failed', 'failed'));
  rows = reduceActivity(rows, event(3, 'external_write', 'saved'));
  rows = reduceActivity(rows, event(4, 'external_write_succeeded', 'saved'));
  rows = reduceActivity(rows, event(5, 'external_write', 'unresolved'));
  rows = settleTerminalActivity(rows, 'failed');
  assert.deepEqual(rows.map(row => [row.write?.callId, row.write?.disposition, row.status]), [
    ['failed', 'failed', 'failed'], ['saved', 'confirmed', 'done'], ['unresolved', 'unknown', 'interrupted'],
  ]);
});

test('full transcript replay retains exact Execute identity and unconfirmed reservation state', () => {
  const ref = { planId: 'plan-reviewed', revision: 2, digest: 'a'.repeat(64) };
  const taskMode = { version: 1, kind: 'execute', executeRef: ref } as const;
  const events: HarnessEvent[] = [
    { seq: 1, type: 'user_input_received', data: { text: 'Execute the reviewed plan, revision 2.', taskMode } },
    event(2, 'external_write'),
    { seq: 3, type: 'conversation_completed', data: { reply: 'The write was not confirmed.', sourceUserSeq: 1, planArtifactRef: ref } },
  ];
  const transcript = foldTranscript(events);
  const reply = transcript.find(message => message.role === 'assistant');
  assert.deepEqual(transcript[0]?.taskMode, taskMode);
  assert.deepEqual(reply?.taskMode, taskMode);
  assert.deepEqual(reply?.planArtifactRef, ref);
  assert.equal(reply?.activity?.[0]?.write?.disposition, 'unknown');
  assert.notEqual(reply?.activity?.[0]?.status, 'done');
  assert.deepEqual(foldTranscript(events), transcript);
});

/**
 * Run: node scripts/run-tests-isolated.mjs src/projects/delegated-owner-words.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-delegated-owner-words-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const { delegatedJobOwnerWords } = await import('./delegated-owner-words.js');
const tasks = await import('../execution/background-tasks.js');
const { createSession, appendEvent, closeEventLog } = await import('../runtime/harness/eventlog.js');
after(() => { closeEventLog(); try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

test("a delegated job reads the owner's own message from the conversation that handed it over", async () => {
  const origin = createSession({ id: 'owner-words-origin', kind: 'chat' });
  const asked = appendEvent({ sessionId: origin.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Have the lead build the audit.' } });
  const task = tasks.createBackgroundTask({ title: 'Audit', prompt: 'Use X (not Y X).', originSessionId: origin.id, source: 'desktop',
    delegation: { agentId: 'lead', agentName: 'Lead', agentCreatedAt: null, projectId: null, projectName: null, assignedBy: 'owner', originSourceUserSeq: asked.seq } });
  // The task's own run session carries the job it is doing.
  const { getSession } = await import('../runtime/harness/eventlog.js');
  assert.equal((getSession(task.runSessionId)?.metadata as Record<string, unknown> | undefined)?.delegatedTaskId, task.id);
  assert.equal(await delegatedJobOwnerWords(task.runSessionId), 'Have the lead build the audit.');
  assert.equal(await delegatedJobOwnerWords(origin.id), undefined, 'an ordinary chat keeps its own input');
  const unknown = createSession({ id: 'background:unknown-job', kind: 'execution', metadata: { delegatedTaskId: 'no-such-task' } } as never);
  assert.equal(await delegatedJobOwnerWords(unknown.id), undefined, 'an unreadable origin keeps the ordinary reading');
});

test("a change the owner asked for later is the owner's words too: a system named there is named", async () => {
  const { correctDelegatedTask } = await import('./task-follow-up.js');
  const origin = createSession({ id: 'owner-words-later', kind: 'chat' });
  const asked = appendEvent({ sessionId: origin.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Have the lead build the audit, not with Fixturemail.' } });
  const task = tasks.createBackgroundTask({ title: 'Audit', prompt: 'Build the audit.', originSessionId: origin.id, source: 'desktop',
    delegation: { agentId: 'lead', agentName: 'Lead', agentCreatedAt: null, projectId: null, projectName: null, assignedBy: 'owner', originSourceUserSeq: asked.seq } });
  const later = appendEvent({ sessionId: origin.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Now host it to Fixturehost and send me the link.' } });
  // Clem relays the owner's message to the task it belongs to.
  const relayed = correctDelegatedTask(task.id, { instruction: 'Host the finished audit to Fixturehost.', by: 'clem', sourceUserSeq: later.seq });
  assert.equal(relayed.kind, 'revised');
  // The owner changes it again from the task's own card.
  const fromCard = correctDelegatedTask(task.id, { instruction: 'Make the site internal only.', by: 'owner' });
  assert.equal(fromCard.kind, 'revised');
  assert.equal(await delegatedJobOwnerWords(task.runSessionId),
    'Have the lead build the audit, not with Fixturemail.\n\nNow host it to Fixturehost and send me the link.\n\nMake the site internal only.',
    'the first message, then each later change in order: the refusal still stands and the later system is named');
});

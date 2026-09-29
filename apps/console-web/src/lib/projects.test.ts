/**
 * Run: node scripts/run-tests-isolated.mjs apps/console-web/src/lib/projects.test.ts
 *
 * A refusal from the projects API is an answer the screen acts on, and what
 * the owner reads about it is a sentence, never a code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountBindingFromRefusal, apiErrorCode, conversationPath, goalsFromText, goalsToText, localProjectLinkFromRefusal,
  projectKeys, refusalText,
  taskFromRefusal, taskRunPath,
} from './projects.js';

function refused(status: number, body: unknown): Error {
  const code = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return Object.assign(new Error(typeof code === 'string' ? code : `HTTP ${status}`), { status, body });
}

test('a refusal is read by its code, and said in words', () => {
  assert.equal(apiErrorCode(refused(409, { error: 'NAME_TAKEN' })), 'NAME_TAKEN');
  assert.equal(apiErrorCode(refused(500, { error: 'Something broke in the service' })), null, 'a sentence is not a code');
  assert.equal(apiErrorCode(refused(404, '<html>not found</html>')), null);
  assert.equal(apiErrorCode(new Error('offline')), null);

  assert.equal(refusalText(refused(409, { error: 'NAME_TAKEN' })), 'Another project already has that name.');
  assert.equal(refusalText(refused(409, { error: 'TASK_NOT_OPEN' })), 'This task has already ended, so it cannot be corrected.');
  assert.equal(refusalText(refused(400, { error: 'SOMETHING_NEW' }), 'Try again.'), 'Try again.', 'an unknown code is never shown');
  assert.equal(refusalText(refused(502, null), 'Try again.'), 'Try again.', 'nor is a bare status');
  assert.equal(
    refusalText(Object.assign(new Error('Clementine\'s local service is restarting.'), { status: 0 })),
    'Clementine\'s local service is restarting.',
    'a sentence the client already wrote is kept',
  );
});

test('binding an account: choose one, connect one, or confirm replacing the one bound', () => {
  assert.deepEqual(
    accountBindingFromRefusal(refused(409, { error: 'ACCOUNT_CHOICE_REQUIRED', accounts: [{ accountId: 'c1', label: 'Work' }, { accountId: 'c2', label: ' ' }, { label: 'no id' }] })),
    { kind: 'choose', accounts: [{ accountId: 'c1', label: 'Work' }, { accountId: 'c2', label: 'Unnamed account' }] },
  );
  assert.deepEqual(accountBindingFromRefusal(refused(409, { error: 'ACCOUNT_NOT_CONNECTED', toolkit: 'mail' })), { kind: 'not_connected' });
  assert.deepEqual(
    accountBindingFromRefusal(refused(409, { error: 'CONFLICTING_ACCOUNT', bound: { accountId: 'c1', label: 'Work' } })),
    { kind: 'conflict', bound: { accountId: 'c1', label: 'Work' } },
  );
  assert.deepEqual(
    accountBindingFromRefusal(refused(409, { error: 'CONFLICTING_ACCOUNT' })),
    { kind: 'conflict', bound: { accountId: '', label: 'another account' } },
    'a conflict that names nothing still asks before replacing',
  );
  assert.equal(accountBindingFromRefusal(refused(409, { error: 'PROJECT_ARCHIVED' })), null, 'any other refusal is a failure');
  assert.equal(accountBindingFromRefusal(new Error('offline')), null);
});

test('a refused control hands back the task as it stands', () => {
  const task = { taskId: 'bg-1', phase: 'finished', title: 'Draft' };
  assert.deepEqual(taskFromRefusal(refused(409, { error: 'TASK_NOT_OPEN', task })), task);
  assert.equal(taskFromRefusal(refused(409, { error: 'TASK_NOT_OPEN' })), null);
  assert.equal(taskFromRefusal(refused(409, { error: 'TASK_NOT_OPEN', task: { title: 'no id' } })), null);
});

test('goals are one to a line, without list marks, blanks or repeats', () => {
  assert.deepEqual(
    goalsFromText('- A briefing every Monday\n\n2. No lead without a follow-up\n  • a briefing every monday  \nplain line'),
    ['A briefing every Monday', 'No lead without a follow-up', 'plain line'],
  );
  assert.deepEqual(goalsFromText('   \n'), []);
  assert.equal(goalsToText(['One', 'Two']), 'One\nTwo');
  assert.deepEqual(goalsFromText(goalsToText(['One', 'Two'])), ['One', 'Two']);
});

test('a task opens on its run, a conversation in Chat, and the keys stay clear of Connect\'s', () => {
  assert.equal(taskRunPath('bg-1 a'), '/tasks?select=bg-1%20a');
  assert.equal(conversationPath('console:abc'), '/chat/harness%3Aconsole%3Aabc', 'a raw id with a colon is still a raw id');
  assert.equal(conversationPath('harness:abc'), '/chat/harness%3Aabc');
  for (const key of [projectKeys.all, projectKeys.list(false), projectKeys.list(true), projectKeys.overview('p1'), projectKeys.accountChoices('p1', 'mail')]) {
    assert.notEqual(key[0], 'projects', 'Connect\'s code folders own that key');
  }
  assert.notDeepEqual(projectKeys.list(false), projectKeys.list(true));
});

test('linking a local project: a refusal hands back the folders to choose from', () => {
  const roster = [
    { name: 'app', path: '/Users/o/code/app', type: 'node', description: '', git: true },
    { name: 'notes', path: '/Users/o/notes', git: false },
    { name: 'no path' },
  ];
  assert.deepEqual(
    localProjectLinkFromRefusal(refused(409, { error: 'LOCAL_PROJECT_CHOICE_REQUIRED', named: 'app', localProjects: roster })),
    {
      kind: 'choose', named: 'app',
      localProjects: [
        { name: 'app', path: '/Users/o/code/app', type: 'node', description: '', git: true },
        { name: 'notes', path: '/Users/o/notes', type: '', description: '', git: false },
      ],
    },
  );
  assert.deepEqual(
    localProjectLinkFromRefusal(refused(409, { error: 'LOCAL_PROJECT_NOT_FOUND', named: '/tmp/gone' })),
    { kind: 'not_found', named: '/tmp/gone', localProjects: [] },
  );
  assert.equal(localProjectLinkFromRefusal(refused(409, { error: 'PROJECT_ARCHIVED' })), null, 'any other refusal is a failure');
  assert.equal(refusalText(refused(409, { error: 'LOCAL_PROJECT_NOT_FOUND' })), 'That folder is not among the code folders on this Mac. Add it in Connect first.');
  assert.notEqual(projectKeys.localProjects[0], 'projects', 'Connect\'s code folders own that key');
});

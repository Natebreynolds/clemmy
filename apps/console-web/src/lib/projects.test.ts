/**
 * Run: node scripts/run-tests-isolated.mjs apps/console-web/src/lib/projects.test.ts
 *
 * A refusal from the projects API is an answer the screen acts on, and what
 * the owner reads about it is a sentence, never a code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectPageRefusal } from '@clem/chat-engine';
import {
  accountBindingFromRefusal, apiErrorCode, conversationPath, goalsFromText, goalsToText, localProjectLinkFromRefusal,
  checkPageDocument, findSessionPage, isPageName, pageDocumentUrl, pageRefusalText, pageViewerPath, projectKeys, refusalText,
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
    { name: 'app', path: '/srv/o/code/app', type: 'node', description: '', git: true },
    { name: 'notes', path: '/srv/o/notes', git: false },
    { name: 'no path' },
  ];
  assert.deepEqual(
    localProjectLinkFromRefusal(refused(409, { error: 'LOCAL_PROJECT_CHOICE_REQUIRED', named: 'app', localProjects: roster })),
    {
      kind: 'choose', named: 'app',
      localProjects: [
        { name: 'app', path: '/srv/o/code/app', type: 'node', description: '', git: true },
        { name: 'notes', path: '/srv/o/notes', type: '', description: '', git: false },
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

test('a page opens in its viewer, and its frame loads the document by both ids', () => {
  assert.equal(pageViewerPath('p1', 'pg1'), '/projects/p1/pages/pg1');
  assert.equal(pageViewerPath('p 1/x', 'a/b?c#d'), '/projects/p%201%2Fx/pages/a%2Fb%3Fc%23d');
  assert.equal(pageDocumentUrl('p1', 'pg1'), '/api/console/project-records/p1/pages/pg1/document');
  assert.equal(
    pageDocumentUrl('p 1/x', '../open?x=1&y#z'),
    '/api/console/project-records/p%201%2Fx/pages/..%2Fopen%3Fx%3D1%26y%23z/document',
    'an id never becomes a part of the path, a query or a fragment',
  );
  assert.equal(new URL(pageDocumentUrl('p1', '%2e%2e'), 'http://clem.test').pathname, '/api/console/project-records/p1/pages/%252e%252e/document');
});

test('reloading a page only makes its address new, and the address never carries the session', () => {
  assert.equal(pageDocumentUrl('p1', 'pg1', 0), pageDocumentUrl('p1', 'pg1'));
  assert.equal(pageDocumentUrl('p1', 'pg1', 3), '/api/console/project-records/p1/pages/pg1/document?reload=3');
  assert.notEqual(pageDocumentUrl('p1', 'pg1', 1), pageDocumentUrl('p1', 'pg1', 2));
  for (const odd of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(pageDocumentUrl('p1', 'pg1', odd), pageDocumentUrl('p1', 'pg1'), `${odd} is not a reload`);
  }
  for (const url of [pageDocumentUrl('p1', 'pg1'), pageDocumentUrl('p1', 'pg1', 2)]) {
    assert.doesNotMatch(url, /token/i, 'a page can read its own address');
  }
  assert.notEqual(projectKeys.pageDocument('p1', 'pg1', 0)[0], 'projects', 'Connect\'s code folders own that key');
  assert.notDeepEqual(projectKeys.pageDocument('p1', 'pg1', 0), projectKeys.pageDocument('p1', 'pg1', 1));
});

test('a refusal about a page is said in the shared words, and any other refusal as a project says it', () => {
  for (const code of ['PAGE_NOT_FOUND', 'PAGE_TOO_LARGE', 'THIS_MACHINE_ONLY', 'NOT_SUPPORTED_HERE']) {
    assert.equal(pageRefusalText(refused(400, { error: code }), 'Try again.'), projectPageRefusal(code), code);
    assert.notEqual(projectPageRefusal(code), projectPageRefusal(null), `${code} has words of its own`);
  }
  assert.equal(pageRefusalText(refused(404, { error: 'PROJECT_NOT_FOUND' }), 'Try again.'), 'This project no longer exists.');
  assert.equal(pageRefusalText(refused(400, { error: 'SOMETHING_NEW' }), 'Try again.'), 'Try again.', 'an unknown code is never shown');
  assert.equal(pageRefusalText(refused(502, null), 'Try again.'), 'Try again.', 'nor is a bare status');
  assert.equal(pageRefusalText(refused(413, '<html>too large</html>'), 'Try again.'), 'Try again.');
  assert.equal(
    pageRefusalText(Object.assign(new Error('Clementine\'s local service is restarting.'), { status: 0 }), 'Try again.'),
    'Clementine\'s local service is restarting.',
    'a sentence the client already wrote is kept',
  );
});

test('asking for a page before framing it answers with a value, and a refusal keeps its code', async () => {
  const asked: string[] = [];
  const real = globalThis.fetch;
  const scope = globalThis as unknown as { window?: unknown };
  const hadWindow = 'window' in scope;
  const realWindow = scope.window;
  // The app reads its token from what the daemon plants in the page.
  scope.window = { __CLEM_BOOTSTRAP__: { token: 'fixture-token' } };
  try {
    globalThis.fetch = (async (input: unknown) => {
      asked.push(String(input));
      return new Response('<!doctype html><title>x</title>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    // A read that answers with nothing is taken for a failed one, and the frame is never drawn.
    assert.equal(await checkPageDocument('prj_1', 'pg_1'), true);
    assert.match(asked[0]!, /\/api\/console\/project-records\/prj_1\/pages\/pg_1\/document/);
    assert.ok(!pageDocumentUrl('prj_1', 'pg_1').includes('token'), 'the address a page can read of itself never carries the token');

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'PAGE_TOO_LARGE' }), { status: 413, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const refused = await checkPageDocument('prj_1', 'pg_1').then(() => null, (error: unknown) => error);
    assert.equal(apiErrorCode(refused), 'PAGE_TOO_LARGE');
    assert.equal(pageRefusalText(refused, 'fallback'), projectPageRefusal('PAGE_TOO_LARGE'));

    globalThis.fetch = (async () => { throw new TypeError('network'); }) as typeof fetch;
    const unreachable = await checkPageDocument('prj_1', 'pg_1').then(() => null, (error: unknown) => error) as { status?: number; message?: string } | null;
    assert.equal(unreachable?.status, 0);
    assert.match(unreachable?.message ?? '', /restarting or unavailable/);
  } finally {
    globalThis.fetch = real;
    if (hadWindow) scope.window = realWindow; else delete scope.window;
  }
});

test('a saved-file card looks for its page only when the file is a page, and keeps quiet when there is none', async () => {
  assert.deepEqual(['index.html', 'Report.HTM', ' page.html '].map(isPageName), [true, true, true]);
  assert.deepEqual(['data.json', 'notes.html.bak', '', null, undefined].map(isPageName), [false, false, false, false, false]);
  const asked: string[] = [];
  const real = globalThis.fetch;
  const scope = globalThis as unknown as { window?: unknown };
  const hadWindow = 'window' in scope;
  const realWindow = scope.window;
  scope.window = { __CLEM_BOOTSTRAP__: { token: 'fixture-token' } };
  try {
    globalThis.fetch = (async (input: unknown) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ projectId: 'prj_1', page: {
        id: 'pg_1', name: 'index.html', folder: 'harbor brief', relativePath: 'harbor brief/index.html',
        localProject: { name: 'audits', path: '/srv/o/audits' }, madeAt: '2026-09-29T10:00:00.000Z', sessionId: 'sess-1',
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const found = await findSessionPage('sess-1', 'index.html', 'harbor brief');
    assert.deepEqual([found?.projectId, found?.page.id, found?.page.folder], ['prj_1', 'pg_1', 'harbor brief']);
    assert.match(asked[0]!, /\/api\/console\/sessions\/sess-1\/page\?name=index\.html&folder=harbor%20brief/);
    assert.equal(await findSessionPage('sess-1', 'data.json', 'x'), null, 'a file that is not a page asks nothing');
    assert.equal(await findSessionPage('', 'index.html', 'x'), null);
    assert.equal(asked.length, 1);

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'PAGE_NOT_FOUND' }), { status: 404, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    assert.equal(await findSessionPage('sess-1', 'index.html', 'gone'), null);
    globalThis.fetch = (async () => new Response(JSON.stringify({ projectId: 'prj_1', page: { name: 'no id' } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    assert.equal(await findSessionPage('sess-1', 'index.html', 'odd'), null, 'an answer this build cannot read is no page');
  } finally {
    globalThis.fetch = real;
    if (hadWindow) scope.window = realWindow; else delete scope.window;
  }
});

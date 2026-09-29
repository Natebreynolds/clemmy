/**
 * Run: npx tsx --test src/lib/local-projects.test.ts   (from apps/mobile-web)
 *
 * Pins for linking a project to local projects on the phone: the picker reads
 * the Mac's own roster and never offers a linked one twice, a refused link is
 * said in plain words with what can be chosen, and a coding run is words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupProjectResources,
  middleTruncatePath,
  projectCodingRunPhase,
  projectCodingRunPlace,
  projectLinkedLocalProject,
  projectLocalProjectChoices,
  projectLocalProjectGitLine,
  projectLocalProjectMissingLine,
} from '@clem/chat-engine';
import { PHONE_PATH_CHARS, localProjectLinkStep, readCodingRuns, readLocalProjects } from './local-projects';

const roster = [
  { name: 'fixture-site', path: '/srv/fixture/code/fixture-site', type: 'node', description: 'The marketing site', git: true },
  { name: 'fixture-api', path: '/srv/fixture/code/fixture-api', type: 'node', description: '', git: false },
];

test('the roster is read once per folder, and only an explicit yes allows coding work', () => {
  const read = readLocalProjects([...roster, roster[0], { name: 'no path' }, null, { path: '/srv/fixture/code/unnamed', git: 'yes' }]);
  assert.deepEqual(read.map((row) => row.name), ['fixture-site', 'fixture-api', 'unnamed']);
  assert.equal(read[2]!.git, false);
  assert.deepEqual(readLocalProjects(undefined), []);
  assert.deepEqual(readLocalProjects({ localProjects: [] }), []);
});

test('a linked local project is marked in the picker, so it is not offered again', () => {
  const choices = projectLocalProjectChoices(readLocalProjects(roster), [
    { kind: 'folder', ref: '/srv/fixture/code/fixture-site' },
    { kind: 'link', ref: '/srv/fixture/code/fixture-api' },
  ]);
  assert.deepEqual(choices.map((row) => [row.localProject.name, row.linked]), [['fixture-api', false], ['fixture-site', true]]);
});

test('local projects are the first group of what a project uses, with their one line of help', () => {
  const groups = groupProjectResources([
    { kind: 'account' as const }, { kind: 'folder' as const }, { kind: 'space' as const },
  ]);
  assert.deepEqual(groups.map((group) => group.label), ['Local projects', 'Accounts', 'Spaces']);
  assert.equal(groups[0]!.hint, 'Where Clem works on files and code for this project.');
});

test('a folder that is gone says so, and one that cannot take coding work says that quietly', () => {
  const resource = (localProject: { name: string; path: string; present: boolean; git: boolean }) => ({
    kind: 'folder' as const, label: localProject.name, ref: localProject.path, localProject,
  });
  const here = projectLinkedLocalProject(resource({ name: 'fixture-site', path: '/a/fixture-site', present: true, git: true }))!;
  assert.equal(projectLocalProjectMissingLine(here), null);
  assert.equal(projectLocalProjectGitLine(here), null);
  const gone = projectLinkedLocalProject(resource({ name: 'fixture-site', path: '/a/fixture-site', present: false, git: false }))!;
  assert.match(projectLocalProjectMissingLine(gone) ?? '', /no longer on this Mac/);
  assert.equal(projectLocalProjectGitLine(gone), null, 'a folder that is gone says only that');
  const plain = projectLinkedLocalProject(resource({ name: 'notes', path: '/a/notes', present: true, git: false }))!;
  assert.match(projectLocalProjectGitLine(plain) ?? '', /Coding work cannot run here yet/);
  assert.equal(projectLinkedLocalProject({ kind: 'account', label: 'x', ref: null, localProject: null }), null);
});

test('a path fits a phone row and keeps both its start and the folder it ends in', () => {
  const path = '/srv/fixture/Documents/clients/northwind/2026/websites/fixture-marketing-site';
  const short = middleTruncatePath(path, PHONE_PATH_CHARS);
  assert.ok(short.length <= PHONE_PATH_CHARS, short);
  assert.match(short, /^\/srv\/fix/);
  assert.match(short, /marketing-site$/);
  assert.equal(middleTruncatePath('/opt/work/site', PHONE_PATH_CHARS), '/opt/work/site');
});

test('a refused link is said in plain words, with what can be chosen', () => {
  const refused = (error: string, extra: Record<string, unknown> = {}) => ({ status: 409, message: error, body: { error, ...extra } });
  const choose = localProjectLinkStep(refused('LOCAL_PROJECT_CHOICE_REQUIRED', { named: 'site', localProjects: roster }));
  assert.equal(choose.step, 'choose');
  assert.deepEqual(choose.step === 'choose' ? choose.localProjects.map((row) => row.name) : [], ['fixture-site', 'fixture-api']);
  const gone = localProjectLinkStep(refused('LOCAL_PROJECT_NOT_FOUND', { named: '/srv/fixture/code/old', localProjects: [] }));
  assert.equal(gone.step, 'not_found');
  const words = [choose, gone].map((step) => ('text' in step ? step.text : ''));
  for (const said of words) {
    assert.ok(said.length > 0);
    assert.doesNotMatch(said, /[A-Z]{3,}_[A-Z]/, 'no code reaches the screen');
    assert.doesNotMatch(said, /\/Users\//, 'a path is not quoted back as if it were a name');
  }
  assert.match(words[0]!, /“site”/);
  assert.deepEqual(localProjectLinkStep(refused('TOO_MANY_RESOURCES')), { step: 'failed' });
  assert.deepEqual(localProjectLinkStep(new Error('HTTP 500')), { step: 'failed' });
});

test('a coding run is its objective, where it works and where it stands', () => {
  const runs = readCodingRuns({ codingRuns: [
    { runId: 'code-1', objective: 'Add a pricing page', localProject: { name: 'fixture-site', path: '/srv/fixture/code/fixture-site', linked: true }, branch: 'clem/pricing', phase: 'handed_to_you', originSessionId: 'sess-1', createdAt: '2026-09-29T09:00:00Z', updatedAt: '2026-09-29T10:00:00Z' },
    { runId: 'code-1', objective: 'Repeated' },
    { runId: 'code-2', objective: '', localProject: { path: '/srv/fixture/code/fixture-api', linked: false }, phase: 'some_new_phase', originSessionId: null },
    { objective: 'no id' },
  ] });
  assert.deepEqual(runs.map((run) => run.runId), ['code-1', 'code-2']);
  assert.equal(projectCodingRunPhase(runs[0]!.phase).label, 'Handed to you');
  assert.equal(projectCodingRunPlace(runs[0]!), 'In fixture-site');
  assert.equal(runs[1]!.objective, 'Coding work');
  assert.equal(projectCodingRunPlace(runs[1]!), 'In fixture-api, which is not linked to this project');
  assert.notEqual(projectCodingRunPhase(runs[1]!.phase).label, 'Finished', 'a phase this build does not know is never called finished');
  assert.equal(runs[1]!.originSessionId, null);
  assert.deepEqual(readCodingRuns({}), []);
  assert.deepEqual(readCodingRuns(null), []);
});

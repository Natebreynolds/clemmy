/**
 * Run: node scripts/run-tests-isolated.mjs packages/chat-engine/src/project-presentation.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrangeProjects, groupProjectResources, memoryScopeHint, memoryScopeIsNarrow, memoryScopeLabel,
  projectAgentsLine, projectDecisionConsequence, projectDecisionSource, projectNeedsYouLabel,
  middleTruncatePath, projectCodingRunPhase, projectCodingRunPlace, projectLinkedLocalProject, projectLocalProjectChoices,
  projectLocalProjectGitLine, projectLocalProjectMissingLine, projectLocalProjectRefusal, PROJECT_LOCAL_PROJECTS_HINT,
  projectDecisionIsFormal, projectDecisionOptions, projectLabelsBySession, projectResourceApp,
  projectResourceKindLabel, projectResourceName, projectResourceVerification, projectWorkLine, sessionProjectLabelText,
  type MemoryScope, type ProjectSummary,
} from './project-presentation.js';

const scope = (patch: Partial<MemoryScope>): MemoryScope => ({
  kind: 'user', projectId: null, projectName: null, agentId: null, agentName: null, ...patch,
});

const summary = (patch: Partial<ProjectSummary>): ProjectSummary => ({
  id: 'prj_1', name: 'Weekly Sales', purpose: '', status: 'active', updatedAt: '2026-09-29T09:00:00.000Z',
  agents: [], activeTasks: 0, needsYou: 0, ...patch,
});

test('a fact says where it applies, in the owner\'s words', () => {
  assert.equal(memoryScopeLabel(scope({})), 'Everywhere');
  assert.equal(memoryScopeLabel(undefined), 'Everywhere', 'a fact from before scopes existed applies everywhere');
  assert.equal(memoryScopeLabel(scope({ kind: 'project', projectId: 'p', projectName: 'Weekly Sales' })), 'Weekly Sales');
  assert.equal(memoryScopeLabel(scope({ kind: 'agent', agentId: 'a', agentName: 'Sales Assistant' })), 'Sales Assistant');
  assert.equal(
    memoryScopeLabel(scope({ kind: 'project_agent', projectId: 'p', projectName: 'Weekly Sales', agentId: 'a', agentName: 'Sales Assistant' })),
    'Sales Assistant in Weekly Sales',
  );
  // A name the server could not resolve never shows an id in its place.
  assert.equal(memoryScopeLabel(scope({ kind: 'project', projectId: 'prj_9' })), 'One project');
  assert.equal(memoryScopeLabel(scope({ kind: 'project_agent', projectId: 'prj_9', agentId: 'a' })), 'an agent in a project');
  assert.equal(memoryScopeHint(scope({})), 'Used in every conversation');
  assert.equal(memoryScopeHint(scope({ kind: 'project', projectName: 'Weekly Sales' })), 'Used only in Weekly Sales');
  assert.equal(memoryScopeIsNarrow(scope({})), false);
  assert.equal(memoryScopeIsNarrow(scope({ kind: 'agent', agentName: 'Sales Assistant' })), true);
});

test('a project row says who is assigned, how much is moving and whether it needs the owner', () => {
  assert.equal(projectAgentsLine(summary({})), 'No agents assigned');
  assert.equal(projectAgentsLine(summary({ agents: [{ agentId: 'a', agentName: 'Sales Assistant' }, { agentId: 'b', agentName: 'Research' }] })), 'Sales Assistant, Research');
  assert.equal(projectAgentsLine(summary({
    agents: ['One', 'Two', 'Three', 'Four', 'Five'].map((agentName) => ({ agentId: agentName.toLowerCase(), agentName })),
  })), 'One, Two, Three and 2 more');
  assert.equal(projectWorkLine(summary({})), 'Nothing running');
  assert.equal(projectWorkLine(summary({ activeTasks: 1 })), '1 task active');
  assert.equal(projectWorkLine(summary({ activeTasks: 4 })), '4 tasks active');
  assert.equal(projectNeedsYouLabel(summary({})), null);
  assert.equal(projectNeedsYouLabel(summary({ needsYou: 1 })), 'Needs you');
  assert.equal(projectNeedsYouLabel(summary({ needsYou: 3 })), '3 need you');
});

test('what waits on the owner leads the list; archived projects are kept apart', () => {
  const arranged = arrangeProjects([
    summary({ id: 'quiet-new', updatedAt: '2026-09-29T12:00:00.000Z' }),
    summary({ id: 'archived', status: 'archived', updatedAt: '2026-09-29T13:00:00.000Z', needsYou: 0 }),
    summary({ id: 'waiting-old', updatedAt: '2026-09-01T12:00:00.000Z', needsYou: 2 }),
    summary({ id: 'quiet-old', updatedAt: '2026-09-02T12:00:00.000Z' }),
  ]);
  assert.deepEqual(arranged.active.map((p) => p.id), ['waiting-old', 'quiet-new', 'quiet-old']);
  assert.deepEqual(arranged.archived.map((p) => p.id), ['archived']);
});

test('resources group by kind, and only an account is ever verified', () => {
  const resources = [
    { id: 'r1', kind: 'link' as const, label: '', ref: 'https://example.test/plan', toolkit: null, verifiedAt: null },
    { id: 'r2', kind: 'account' as const, label: 'Work mail', ref: null, toolkit: 'mail', verifiedAt: '2026-09-29T09:00:00.000Z' },
    { id: 'r3', kind: 'space' as const, label: 'Pipeline', ref: 'pipeline', toolkit: null, verifiedAt: null },
    { id: 'r4', kind: 'account' as const, label: '', ref: null, toolkit: 'sheets', verifiedAt: null },
  ];
  assert.deepEqual(groupProjectResources(resources).map((group) => [group.label, group.items.map((item) => item.id)]), [
    ['Accounts', ['r2', 'r4']],
    ['Spaces', ['r3']],
    ['Links', ['r1']],
  ]);
  assert.deepEqual(projectResourceVerification(resources[1]), { verified: true, label: 'Verified' });
  assert.deepEqual(projectResourceVerification(resources[3]), { verified: false, label: 'Not verified' });
  assert.equal(projectResourceVerification(resources[2]), null, 'a Space is a pointer; it claims nothing');
  assert.equal(projectResourceName(resources[0]), 'https://example.test/plan');
  assert.equal(projectResourceName(resources[3]), 'sheets');
  assert.equal(projectResourceKindLabel('workflow'), 'Workflow');
  assert.equal(projectResourceKindLabel('something-new', true), 'Other');
});

test('a decision says who asks, about what, and what answering does', () => {
  const question = { kind: 'question' as const, taskId: 'bg-1', owner: 'Sales Assistant', title: 'Draft the weekly briefing' };
  assert.equal(projectDecisionSource(question), 'Sales Assistant · Draft the weekly briefing');
  assert.equal(projectDecisionConsequence(question), 'Sales Assistant is waiting on your answer and continues once you give it.');
  assert.match(projectDecisionConsequence({ kind: 'approval', taskId: 'bg-1', owner: 'Sales Assistant' }), /lets the task continue/);
  assert.match(projectDecisionConsequence({ kind: 'approval', taskId: null, owner: '' }), /^Clem is paused on this\. Approving lets the reply continue/);
});

test('something asked in the conversation is answered there, never from a card', () => {
  const asked = { kind: 'approval' as const, formal: false, taskId: null, owner: 'Sales Assistant' };
  assert.equal(projectDecisionIsFormal(asked), false);
  assert.equal(projectDecisionConsequence(asked), 'Sales Assistant asked this in the conversation and continues once you reply there.');
  assert.equal(projectDecisionIsFormal({ formal: true }), true);
  assert.equal(projectDecisionIsFormal({}), true, 'a service from before the field had only formal decisions');
});

test('a question offers its answers; an approval offers none', () => {
  assert.deepEqual(projectDecisionOptions({ kind: 'question', options: ['West', ' ', 'East'] }), ['West', 'East']);
  assert.deepEqual(projectDecisionOptions({ kind: 'question' }), [], 'a service from before the field offers none');
  assert.deepEqual(projectDecisionOptions({ kind: 'approval', options: ['Yes'] }), []);
});

test('an account names its app the way a person writes it', () => {
  assert.equal(projectResourceApp({ kind: 'account', appName: 'Google Sheets', toolkit: 'googlesheets' }), 'Google Sheets');
  assert.equal(projectResourceApp({ kind: 'account', appName: null, toolkit: 'googlesheets' }), 'googlesheets');
  assert.equal(projectResourceApp({ kind: 'link', appName: null, toolkit: null }), '');
});

test('what waits on the owner is labelled by the session it came from', () => {
  const labels = projectLabelsBySession([
    { sessionId: 'background:bg-1', projectId: 'p1', projectName: 'Weekly Sales', agentName: 'Sales Assistant', taskId: 'bg-1' },
    { sessionId: 'chat-1', projectId: 'p1', projectName: 'Weekly Sales', agentName: null, taskId: null },
    { sessionId: 'chat-2', projectId: 'p2', projectName: '  ', agentName: null, taskId: null },
  ]);
  assert.equal(sessionProjectLabelText(labels.get('background:bg-1')!), 'Weekly Sales · Sales Assistant');
  assert.equal(sessionProjectLabelText(labels.get('chat-1')!), 'Weekly Sales');
  assert.equal(labels.has('chat-2'), false, 'a project with no name labels nothing');
  assert.equal(labels.has('chat-9'), false, 'a session in no project has no label');
});

test('local projects are their own group, first, and say what they are for', () => {
  const groups = groupProjectResources([
    { id: 'a', kind: 'account' as const },
    { id: 'f1', kind: 'folder' as const },
    { id: 'l', kind: 'link' as const },
    { id: 'f2', kind: 'folder' as const },
  ]);
  assert.deepEqual(groups.map((group) => [group.label, group.items.map((item) => item.id)]), [
    ['Local projects', ['f1', 'f2']],
    ['Accounts', ['a']],
    ['Links', ['l']],
  ]);
  assert.equal(groups[0].hint, PROJECT_LOCAL_PROJECTS_HINT);
  assert.equal(PROJECT_LOCAL_PROJECTS_HINT, 'Where Clem works on files and code for this project.');
  assert.equal(groups[1].hint, undefined);
  assert.equal(projectResourceKindLabel('folder'), 'Local project', 'never a bare "project"');
  assert.equal(projectResourceKindLabel('folder', true), 'Local projects');
});

test('a linked local project says when its folder is gone, and when coding work cannot run in it', () => {
  const here = projectLinkedLocalProject({ kind: 'folder', label: 'clem', ref: '/Users/o/code/clem', localProject: { name: 'clem', path: '/Users/o/code/clem', present: true, git: true } });
  assert.deepEqual(here, { name: 'clem', path: '/Users/o/code/clem', present: true, git: true, known: true });
  assert.equal(projectLocalProjectMissingLine(here!), null);
  assert.equal(projectLocalProjectGitLine(here!), null);

  const gone = { name: 'old', path: '/Users/o/code/old', present: false, git: false };
  assert.match(projectLocalProjectMissingLine(gone)!, /no longer on this Mac/);
  assert.equal(projectLocalProjectGitLine(gone), null, 'a folder that is gone gets one line, not two');

  const plain = { name: 'notes', path: '/Users/o/notes', present: true, git: false };
  assert.equal(projectLocalProjectMissingLine(plain), null);
  assert.equal(projectLocalProjectGitLine(plain), 'Coding work cannot run here yet: this folder is not a git repository.');

  const older = projectLinkedLocalProject({ kind: 'folder', label: '', ref: '/Users/o/code/app', localProject: null });
  assert.deepEqual([older?.name, older?.known], ['app', false], 'nothing is claimed about a folder the server did not describe');
  assert.equal(projectLinkedLocalProject({ kind: 'link', label: 'x', ref: 'https://example.test' }), null);
});

test('a path is cut in the middle, keeping where it starts and the folder it ends in', () => {
  assert.equal(middleTruncatePath('/Users/o/code/app'), '/Users/o/code/app');
  const cut = middleTruncatePath('/Users/owner/Documents/clients/acme/projects/2026/spring-launch-site', 40);
  assert.equal(cut.length, 40);
  assert.ok(cut.startsWith('/Users/owner/'));
  assert.ok(cut.endsWith('spring-launch-site'));
  assert.ok(cut.includes('…'));
});

test('the picker marks what is already linked and lists each folder once', () => {
  const roster = [
    { name: 'site', path: '/c/site' }, { name: 'app', path: '/c/app' }, { name: 'app', path: '/c/app' }, { name: 'api', path: '/c/api' },
  ];
  const choices = projectLocalProjectChoices(roster, [{ kind: 'folder', ref: '/c/app' }, { kind: 'link', ref: '/c/site' }]);
  assert.deepEqual(choices.map((choice) => [choice.localProject.name, choice.linked]), [['api', false], ['app', true], ['site', false]]);
});

test('a refused link is said in plain words', () => {
  assert.equal(projectLocalProjectRefusal('LOCAL_PROJECT_CHOICE_REQUIRED', 'app'), 'More than one local project is called “app”. Choose the one you mean.');
  assert.equal(projectLocalProjectRefusal('LOCAL_PROJECT_CHOICE_REQUIRED', ''), 'Choose which local project to link.');
  assert.match(projectLocalProjectRefusal('LOCAL_PROJECT_NOT_FOUND', '/tmp/x')!, /^“\/tmp\/x” is not among the code folders on this Mac/);
  assert.equal(projectLocalProjectRefusal('NAME_TAKEN'), null);
});

test('coding work says its phase and where it runs', () => {
  assert.deepEqual(
    (['waiting_to_start', 'working', 'handed_to_you', 'finished'] as const).map((phase) => projectCodingRunPhase(phase).label),
    ['Waiting to start', 'Working', 'Handed to you', 'Finished'],
  );
  assert.deepEqual(projectCodingRunPhase('something-new'), { label: 'Working', tone: 'live', settled: false });
  assert.equal(projectCodingRunPlace({ localProject: { name: 'clem', path: '/c/clem', linked: true } }), 'In clem');
  assert.equal(projectCodingRunPlace({ localProject: { name: '', path: '/c/clem', linked: false } }), 'In clem, which is not linked to this project');
});

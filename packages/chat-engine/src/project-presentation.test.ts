/**
 * Run: node scripts/run-tests-isolated.mjs packages/chat-engine/src/project-presentation.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrangeProjects, groupProjectResources, memoryScopeHint, memoryScopeIsNarrow, memoryScopeLabel,
  projectAgentsLine, projectDecisionConsequence, projectDecisionSource, projectNeedsYouLabel,
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

test('resources group by kind with accounts first, and only an account is ever verified', () => {
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
